import {expect, test} from 'bun:test';
import {extractCodeWithFacts} from '../src/extract/code/index.js';
import {extractContracts} from '../src/extract/contracts/index.js';
import type {SourceSpan, TreeReader} from '../src/extract/records.js';

/** Keep receiver resolution, proto joining and callback ownership separately observable. */
test('an injected client reaches a gRPC site inside its Promise executor without losing the raw span', async () => {
  const clientPath = 'services/gateway/client.ts';
  const callerPath = 'services/gateway/dispatch.ts';
  const protoPath = 'contracts/proto/rates.proto';
  const clientKey = `code.symbol:${clientPath}#RateClient.estimate`;
  const callerKey = `code.symbol:${callerPath}#Dispatcher.run`;
  const operationKey = `code.operation:${protoPath}#rates.v1.Rates/Estimate`;
  const rawSite = 'this.stub.estimate({units}, {}, (error, reply) => { if (error) reject(error); else resolve(reply); })';
  const files: Readonly<Record<string, string>> = {
    'services/gateway/package.json': JSON.stringify({name: 'gateway', dependencies: {'@grpc/grpc-js': '1.12.0', '@grpc/proto-loader': '0.7.0'}}),
    [protoPath]: 'syntax = "proto3";\npackage rates.v1;\nservice Rates {\n  rpc Estimate(EstimateRequest) returns (EstimateReply);\n}\nmessage EstimateRequest { int32 units = 1; }\nmessage EstimateReply { int32 value = 1; }\n',
    [clientPath]: [
      'import path from "node:path";',
      'import * as grpc from "@grpc/grpc-js";',
      'import * as loader from "@grpc/proto-loader";',
      'const schema = path.resolve(__dirname, "../../contracts/proto/rates.proto");',
      'interface RateStub extends grpc.Client { estimate(request: {units: number}, options: grpc.CallOptions, callback: (error: grpc.ServiceError | null, reply: number) => void): void; }',
      'export class RateClient {',
      '  private readonly stub: RateStub;',
      '  constructor(address: string) {',
      '    const definition = loader.loadSync(schema);',
      '    const loaded = grpc.loadPackageDefinition(definition) as unknown as {rates: {v1: {Rates: new (address: string, credentials: grpc.ChannelCredentials) => RateStub}}};',
      '    this.stub = new loaded.rates.v1.Rates(address, grpc.credentials.createInsecure());',
      '  }',
      '  estimate(units: number): Promise<number> {',
      '    return new Promise((resolve, reject) => {',
      `      ${rawSite};`,
      '    });',
      '  }',
      '}',
    ].join('\n'),
    [callerPath]: [
      'import {RateClient} from "./client";',
      'export class Dispatcher {',
      '  constructor(private readonly remote: RateClient) {}',
      '  async run(units: number) { return await this.remote.estimate(units); }',
      '}',
    ].join('\n'),
  };
  const input: TreeReader = {paths: Object.keys(files).sort(), read(path) {
    const value = files[path];
    if (value === undefined) throw new Error(`${import.meta.path}:51: missing fixture path ${path}`);
    return new TextEncoder().encode(value);
  }};
  const raw = (span: SourceSpan): string => new TextDecoder().decode(input.read(span.path).subarray(span.byteStart, span.byteEnd));
  const shared = await extractCodeWithFacts(input);
  const contracts = await extractContracts(input, shared.extraction, shared.facts);
  try {
    // This assertion fails before the proto join if the injected field no longer resolves.
    expect(shared.extraction.edges.filter(edge => edge.type === 'code.calls' && edge.from === callerKey && edge.to === clientKey)).toHaveLength(1);
    expect(shared.facts.sites.filter(site => site.holder === callerKey && site.to === clientKey && site.use === 'call')).toHaveLength(1);
    const invocation = shared.facts.calls.filter(call => call.path === clientPath && raw(call.span) === rawSite);
    expect(invocation).toHaveLength(1);
    const callback = shared.facts.symbols.find(symbol => symbol.key === invocation[0]!.holder);
    expect(callback?.callable).toBe(true);
    expect(callback?.bodySpan).toBeDefined();
    expect(callback?.key).not.toBe(clientKey);
    expect(callback!.bodySpan!.byteStart).toBeLessThanOrEqual(invocation[0]!.span.byteStart);
    expect(callback!.bodySpan!.byteEnd).toBeGreaterThanOrEqual(invocation[0]!.span.byteEnd);
    expect(shared.extraction.edges.some(edge => edge.type === 'code.references' && edge.from === clientKey && edge.to === callback!.key && edge.properties.role === 'callback-value')).toBe(true);
    // File summary presence isolates proto/path/RPC joining from callable ownership.
    const summary = contracts.edges.filter(edge => edge.type === 'code.calls-remote' && edge.from === `code.file:${clientPath}` && edge.to === operationKey);
    expect(summary).toHaveLength(1);
    expect(summary[0]!.properties).toMatchObject({summary: true, client: 'RateClient.estimate', via: 'grpc'});
    expect(summary[0]!.span).toBeDefined();
    expect(raw(summary[0]!.span!)).toBe(rawSite);
    const canonical = contracts.edges.filter(edge => edge.type === 'code.calls-remote' && edge.from === callback!.key && edge.to === operationKey);
    expect(canonical).toHaveLength(1);
    expect(canonical[0]!.span).toEqual(invocation[0]!.span);
    expect(contracts.edges.some(edge => edge.type === 'code.calls-remote' && edge.from === clientKey && edge.to === operationKey)).toBe(false);
  } catch (error) {
    throw new Error(`${import.meta.path}:57: gRPC boundary diagnostic; fixture paths ${callerPath}, ${clientPath}, ${protoPath}\n${JSON.stringify({
      failure: error instanceof Error ? error.stack ?? error.message : String(error),
      files,
      codeEdges: shared.extraction.edges,
      symbols: shared.facts.symbols,
      sites: shared.facts.sites,
      calls: shared.facts.calls,
      bindings: shared.facts.bindings,
      expressions: shared.facts.expressions,
      codeGaps: shared.facts.gaps,
      contractEdges: contracts.edges,
      contractGaps: contracts.gaps,
    }, null, 2)}`);
  }
});
