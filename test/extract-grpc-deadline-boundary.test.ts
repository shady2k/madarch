import {expect, test} from 'bun:test';
import {extractCodeWithFacts} from '../src/extract/code/index.js';
import {extractContracts} from '../src/extract/contracts/index.js';
import {readTsFile, structuralGrpcDeadline, type TsFileFacts} from '../src/extract/contracts/ts-code.js';
import {readSyntaxTree} from '../src/fill/stages/syntax-extract.js';
import {TreeText} from '../src/extract/operations/source.js';
import type {TreeReader} from '../src/extract/records.js';
import type {CodeCallFact} from '../src/extract/code/facts.js';
import {grpcDeadlineModel, validateGrpcDeadlineModel} from '../src/extract/library-models/grpc-deadline-models.js';

const clientPath = 'services/relay/client.ts';
const bootstrapPath = 'services/relay/start.ts';
const configPath = 'services/relay/settings.ts';
const invocation = 'this.stub.estimate({units: 1}, {deadline}, () => {})';

async function proof(overrides: Readonly<Record<string, string>> = {}, rawInvocation = invocation) {
  const files: Readonly<Record<string, string>> = {
    [clientPath]: [
      'interface Stub { estimate(request: unknown, options: unknown, callback: () => void): void; }',
      'export class RateClient {',
      '  private readonly stub: Stub;',
      // Duration deliberately occupies ordinal zero, not the legacy second argument.
      '  constructor(private readonly waitMs: number, address: string) {}',
      '  estimate() {',
      '    const deadline = new Date(Date.now() + this.waitMs);',
      `    ${invocation};`,
      '  }',
      '}',
    ].join('\n'),
    [bootstrapPath]: [
      'import {RateClient} from "./client";',
      'import {readSettings} from "./settings";',
      'const settings = readSettings();',
      'const remote = new RateClient(settings.delay, "localhost:50051");',
    ].join('\n'),
    [configPath]: [
      'export function readSettings(env: Record<string, string> = {}) {',
      '  return {delay: Number(env.RATE_WAIT ?? 7300)};',
      '}',
    ].join('\n'),
    ...overrides,
  };
  const tree: TreeReader = {paths: Object.keys(files).sort(), read(path) {
    const text = files[path];
    if (text === undefined) throw new Error(`${import.meta.path}:43: missing fixture path ${path}`);
    return new TextEncoder().encode(text);
  }};
  const shared = await extractCodeWithFacts(tree);
  const site = shared.facts.calls.find(call => call.path === clientPath && new TextDecoder().decode(tree.read(call.path).subarray(call.span.byteStart, call.span.byteEnd)) === rawInvocation);
  if (site === undefined) throw new Error(`${import.meta.path}:49: missing parsed invocation in ${clientPath}`);
  const result = structuralGrpcDeadline(new TreeText(tree, shared.extraction, shared.facts), site.span);
  return {result, shared, files, site, tree};
}

test('gRPC deadline follows the exact constructor ordinal and config return binding', async () => {
  const answer = await proof();
  try {
    expect(answer.result?.deadlineMs).toBe(7300);
    expect(answer.result?.evidence.some(span => span.path === bootstrapPath)).toBe(true);
    expect(answer.result?.evidence.some(span => span.path === configPath)).toBe(true);
  } catch (error) {
    throw new Error(`${import.meta.path}:55: deadline proof failed; fixture paths ${clientPath}, ${bootstrapPath}, ${configPath}\n${JSON.stringify({error: String(error), ...answer}, null, 2)}`);
  }
});

test('a constructor property write preserves the receiver used by a Promise deadline', async () => {
  const answer = await proof({
    [clientPath]: [
      'interface Stub { estimate(request: unknown, options: unknown, callback: () => void): void; }',
      'declare function connect(address: string): Stub;',
      'export class RateClient {',
      '  private readonly stub: Stub;',
      '  constructor(address: string, private readonly waitMs: number) { this.stub = connect(address); }',
      '  estimate() {',
      '    const deadline = new Date(Date.now() + this.waitMs);',
      `    return new Promise<void>((resolve) => { ${invocation}; resolve(); });`,
      '  }',
      '}',
    ].join('\n'),
    [bootstrapPath]: [
      'import {RateClient} from "./client";',
      'import {readSettings} from "./settings";',
      'const settings = readSettings();',
      'const remote = new RateClient("localhost:50051", settings.delay);',
    ].join('\n'),
  });
  expect(answer.result?.deadlineMs).toBe(7300);
  expect(answer.result?.evidence.some(span => span.path === bootstrapPath)).toBe(true);
  expect(answer.result?.evidence.some(span => span.path === configPath)).toBe(true);
});

test('typed settings and a nested construction carry a deadline through the full gRPC contract join', async () => {
  const protoPath = 'contracts/proto/rates.proto';
  const rawInvocation = 'this.stub.estimate({units}, {deadline}, (error, reply) => { if (error) reject(error); else resolve(reply); })';
  const answer = await proof({
    'services/relay/package.json': JSON.stringify({name: 'relay', dependencies: {'@grpc/grpc-js': '1.12.0', '@grpc/proto-loader': '0.7.0'}}),
    [protoPath]: 'syntax = "proto3";\npackage rates.v1;\nservice Rates {\n  rpc Estimate(EstimateRequest) returns (EstimateReply);\n}\nmessage EstimateRequest { int32 units = 1; }\nmessage EstimateReply { int32 value = 1; }\n',
    [clientPath]: [
      'import path from "node:path";',
      'import * as grpc from "@grpc/grpc-js";',
      'import * as loader from "@grpc/proto-loader";',
      'const schema = path.resolve(__dirname, "../../contracts/proto/rates.proto");',
      'export interface EstimateResult { value: number; }',
      'interface RateStub extends grpc.Client { estimate(request: {units: number}, options: grpc.CallOptions, callback: (error: grpc.ServiceError | null, reply: EstimateResult) => void): void; }',
      '/** The client owns its loaded transport. */',
      'export class RateClient {',
      '  private readonly stub: RateStub;',
      '  constructor(',
      '    address: string,',
      '    private readonly waitMs: number,',
      '  ) {',
      '    const definition = loader.loadSync(schema, {keepCase: false, longs: Number, defaults: true});',
      '    const loaded = grpc.loadPackageDefinition(definition) as unknown as {rates: {v1: {Rates: new (address: string, credentials: grpc.ChannelCredentials) => RateStub}}};',
      '    this.stub = new loaded.rates.v1.Rates(address, grpc.credentials.createInsecure());',
      '  }',
      '  /** Calls the transport from a Promise executor. */',
      '  estimate(units: number): Promise<EstimateResult> {',
      '    const deadline = new Date(Date.now() + this.waitMs);',
      `    return new Promise((resolve, reject) => { ${rawInvocation}; });`,
      '  }',
      '  close(): void { this.stub.close(); }',
      '}',
    ].join('\n'),
    [bootstrapPath]: [
      'import {RateClient} from "./client";',
      'import {readSettings} from "./settings";',
      'class LocalClient { constructor(address: string) {} }',
      'class Dispatcher { constructor(local: LocalClient, remote: RateClient, other: LocalClient) {} }',
      'const settings = readSettings();',
      'const dispatcher = new Dispatcher(',
      '  new LocalClient(settings.localUrl),',
      '  new RateClient(settings.remoteAddress, settings.delay),',
      '  new LocalClient(settings.otherUrl),',
      ');',
    ].join('\n'),
    [configPath]: [
      'export interface Settings { localUrl: string; otherUrl: string; remoteAddress: string; delay: number; }',
      '/** Read each value from the environment or its own default. */',
      'export function readSettings(env: NodeJS.ProcessEnv = process.env): Settings {',
      '  return {',
      '    localUrl: env.LOCAL_URL ?? "http://localhost:8080",',
      '    otherUrl: env.OTHER_URL ?? "http://localhost:8082",',
      '    remoteAddress: env.REMOTE_ADDRESS ?? "localhost:50051",',
      '    delay: Number(env.RATE_WAIT ?? 7300),',
      '  };',
      '}',
    ].join('\n'),
  }, rawInvocation);
  const contracts = await extractContracts(answer.tree, answer.shared.extraction, answer.shared.facts);
  const remote = contracts.edges.filter(edge => edge.type === 'code.calls-remote' && edge.from === `code.file:${clientPath}` && edge.to === `code.operation:${protoPath}#rates.v1.Rates/Estimate`);
  try {
    // Separate the structural proof from the legacy site/proto integration.
    expect(answer.result?.deadlineMs).toBe(7300);
    expect(remote).toHaveLength(1);
    expect(remote[0]!.span).toEqual(answer.site.span);
    expect(remote[0]!.properties.deadlineMs).toBe(7300);
    expect(remote[0]!.properties.deadlineEvidence).toEqual(answer.result!.evidence.map(span => ({...span})));
  } catch (error) {
    throw new Error(`${import.meta.path}:157: full-shape deadline proof or contract join failed; fixture paths ${clientPath}, ${bootstrapPath}, ${configPath}, ${protoPath}\n${JSON.stringify({error: String(error), result: answer.result, files: answer.files, site: answer.site, shared: answer.shared, remote, contractGaps: contracts.gaps}, null, 2)}`);
  }
});

test('writing the duration property still invalidates the deadline proof', async () => {
  for (const write of ['this.waitMs = 1', 'this.waitMs += 1', 'this.waitMs++']) {
    const answer = await proof({[clientPath]: [
      'export class RateClient {',
      '  private readonly stub: any;',
      '  constructor(private waitMs: number, address: string) {}',
      `  estimate() { ${write}; const deadline = new Date(Date.now() + this.waitMs); ${invocation}; }`,
      '}',
    ].join('\n')});
    expect(answer.result).toBeUndefined();
  }
});

test('reassigning the config binding still invalidates the deadline proof', async () => {
  const answer = await proof({[bootstrapPath]: [
    'import {RateClient} from "./client";',
    'import {readSettings} from "./settings";',
    'let settings = readSettings();',
    'settings = {delay: 1};',
    'const remote = new RateClient(settings.delay, "localhost:50051");',
  ].join('\n')});
  expect(answer.result).toBeUndefined();
});

test('comments and prose cannot supply a config fallback', async () => {
  for (const value of ['"Number(env.RATE_WAIT ?? 7300)"', 'unknown /* ?? 7300 */']) {
    const answer = await proof({[configPath]: `export function readSettings() { return {delay: ${value}}; }`});
    expect(answer.result).toBeUndefined();
  }
});

test('identifier lookalikes and unrelated property defaults do not prove a deadline', async () => {
  const answer = await proof({
    [bootstrapPath]: 'import {RateClient} from "./client"; const settingsLookalike = {delay: 7300}; const remote = new RateClient(settingsLookalike.delay, "localhost:50051");',
    'services/elsewhere/settings.ts': 'export const settings = {delay: Number(env.WAIT ?? 7300)};',
  });
  expect(answer.result).toBeUndefined();
});

test('multiple canonical constructions do not select an arbitrary config', async () => {
  const answer = await proof({[bootstrapPath]: [
    'import {RateClient} from "./client";',
    'import {readSettings} from "./settings";',
    'const settings = readSettings();',
    'const first = new RateClient(settings.delay, "localhost:50051");',
    'const second = new RateClient(settings.delay, "localhost:50052");',
  ].join('\n')});
  expect(answer.result).toBeUndefined();
});

test('a construction in a test file does not set the deployed deadline', async () => {
  const testPath = 'services/relay/test/client.test.ts';
  const answer = await proof({
    [testPath]: [
      'import {RateClient} from "../client";',
      'export const probe = new RateClient(2000, "127.0.0.1:5001");',
    ].join('\n'),
  });
  const callSites = (call: CodeCallFact): readonly string[] => {
    const callee = answer.shared.facts.expressions.find(expression => expression.id === call.callee);
    if (callee === undefined) throw new Error(`${import.meta.path}: the construction has no canonical callee`);
    return answer.shared.facts.sites.filter(site => site.use === 'call' && site.holder === call.holder
      && site.span.path === callee.span.path && callee.span.byteStart <= site.span.byteStart && site.span.byteEnd <= callee.span.byteEnd).map(site => site.to);
  };
  const deployed = answer.shared.facts.calls.filter(call => call.path === bootstrapPath && call.construct);
  const probed = answer.shared.facts.calls.filter(call => call.path === testPath && call.construct);
  // The fixture must really hold two canonical constructions of one constructor,
  // or the deployed preference it checks is not the one that decided.
  expect(deployed).toHaveLength(1);
  expect(probed).toHaveLength(1);
  expect(callSites(probed[0]!)).toEqual(callSites(deployed[0]!));
  expect(callSites(probed[0]!).length).toBeGreaterThan(0);
  expect(answer.result?.deadlineMs).toBe(7300);
  expect(answer.result!.evidence.some(span => span.path === bootstrapPath && span.byteStart === deployed[0]!.span.byteStart && span.byteEnd === deployed[0]!.span.byteEnd)).toBe(true);
  expect(answer.result!.evidence.some(span => span.path === testPath)).toBe(false);
});

test('two deployed constructions with different values prove nothing', async () => {
  const answer = await proof({
    [configPath]: [
      'export function readSettings(env: Record<string, string> = {}) {',
      '  return {delay: Number(env.RATE_WAIT ?? 7300), retry: Number(env.RETRY_WAIT ?? 1200)};',
      '}',
    ].join('\n'),
    [bootstrapPath]: [
      'import {RateClient} from "./client";',
      'import {readSettings} from "./settings";',
      'const settings = readSettings();',
      'const first = new RateClient(settings.delay, "localhost:50051");',
      'const second = new RateClient(settings.retry, "localhost:50052");',
    ].join('\n'),
  });
  expect(answer.result).toBeUndefined();
});

test('a tree whose only construction is a test file keeps the single-construction fallback', async () => {
  const testPath = 'services/relay/client.test.ts';
  const answer = await proof({
    [bootstrapPath]: 'import {readSettings} from "./settings"; export const settings = readSettings();',
    [testPath]: [
      'import {RateClient} from "./client";',
      'import {readSettings} from "./settings";',
      'const settings = readSettings();',
      'export const client = new RateClient(settings.delay, "localhost:50051");',
    ].join('\n'),
  });
  expect(answer.result?.deadlineMs).toBe(7300);
  expect(answer.result?.evidence.some(span => span.path === testPath)).toBe(true);
  expect(answer.result?.evidence.some(span => span.path === configPath)).toBe(true);
});

test('one deployed construction recorded twice is still one canonical call', async () => {
  const answer = await proof();
  const deployed = answer.shared.facts.calls.filter(call => call.path === bootstrapPath && call.construct);
  expect(deployed).toHaveLength(1);
  const call = deployed[0]!;
  const node = answer.shared.facts.expressions.filter(expression => expression.id === call.expression);
  expect(node).toHaveLength(1);
  const id = `${call.expression}#recorded-twice`;
  const facts = {
    ...answer.shared.facts,
    expressions: [...answer.shared.facts.expressions, {...node[0]!, id}],
    calls: [...answer.shared.facts.calls, {...call, expression: id}],
  };
  const result = structuralGrpcDeadline(new TreeText(answer.tree, answer.shared.extraction, facts), answer.site.span);
  expect(result?.deadlineMs).toBe(7300);
  expect(result?.evidence.some(span => span.path === bootstrapPath)).toBe(true);
});

test('same-name classes in another module cannot supply the construction', async () => {
  const answer = await proof({
    [bootstrapPath]: 'import {RateClient} from "./unrelated"; const settings = {delay: Number(env.WAIT ?? 7300)}; const remote = new RateClient(settings.delay, "localhost:50051");',
    'services/relay/unrelated.ts': 'export class RateClient { constructor(private readonly waitMs: number, address: string) {} }',
  });
  expect(answer.result).toBeUndefined();
});

test('shadowed Number is not the builtin numeric conversion', async () => {
  for (const shadow of ['const Number = (value: unknown) => 1;', 'function Number(value: unknown) { return 1; }']) {
    const answer = await proof({[configPath]: `${shadow} export function readSettings(env = {}) { return {delay: Number(env.WAIT ?? 7300)}; }`});
    expect(answer.result).toBeUndefined();
  }
});

test('shadowed Date is not the builtin clock constructor', async () => {
  const answer = await proof({[clientPath]: [
    'class Date { static now() { return 1; } constructor(value: number) {} }',
    'export class RateClient {',
    '  constructor(private readonly waitMs: number, address: string) {}',
    `  estimate() { const deadline = new Date(Date.now() + this.waitMs); ${invocation}; }`,
    '}',
  ].join('\n')});
  expect(answer.result).toBeUndefined();
});

test('an arbitrary function cannot pass a numeric fallback through its arguments', async () => {
  const answer = await proof({[configPath]: 'function wrap(value: unknown) { return value; } export function readSettings(env = {}) { return {delay: wrap(Number(env.WAIT ?? 7300))}; }'});
  expect(answer.result).toBeUndefined();
});

test('deadline selector data is closed and frozen', () => {
  expect(Object.isFrozen(grpcDeadlineModel)).toBe(true);
  expect(() => validateGrpcDeadlineModel({...grpcDeadlineModel, optionsArgument: 2})).toThrow();
  expect(() => validateGrpcDeadlineModel({...grpcDeadlineModel, passthrough: true})).toThrow();
});

const tsFactsPath = 'services/relay/payments.ts';

/** The contract facts one TypeScript fixture states, read through the same parse the extractor uses. */
async function tsFactsOf(source: string): Promise<TsFileFacts> {
  const read = await readSyntaxTree(tsFactsPath, new TextEncoder().encode(source), (parsed) => readTsFile(tsFactsPath, parsed.root));
  if (!read.read) throw new Error(`${import.meta.path}: ${tsFactsPath} was not read: ${JSON.stringify(read.unread)}`);
  if (!read.complete) throw new Error(`${import.meta.path}: ${tsFactsPath} was not read whole; the fixture must parse`);
  return read.value;
}

test('the signing algorithm is the string literal the tree holds, and a mention of it is no algorithm', async () => {
  // The grammar answers with a `string` node whose decoded value is the name, under either quote
  // kind. The two readers of the decoy function write the name inside a longer string and inside
  // a comment, which the tree holds as other things: the function that only names it stays unnamed.
  const facts = await tsFactsOf([
    "import jwt from 'jsonwebtoken';",
    'export function authenticate(secret: string) {',
    "  return (header: string) => jwt.verify(header, secret, {algorithms: ['HS256']});",
    '}',
    'export function sign(payload: unknown) {',
    '  return jwt.sign(payload, "secret", {algorithm: "HS256"});',
    '}',
    'export function documentsOnly() {',
    "  // the group verifies 'HS256' tokens before it reaches a handler",
    '  const note = \'the middleware uses "HS256" elsewhere\';',
    '  return note;',
    '}',
  ].join('\n'));
  expect(facts.hs256Functions).toEqual(['authenticate', 'sign']);
});

test('a listener port is the number literal or its const, and a call or a string names no port', async () => {
  const facts = await tsFactsOf([
    'import express from "express";',
    'const PORT = 8080;',
    'export function start() {',
    '  const app = express();',
    '  app.listen(PORT);',
    '  app.listen(9091);',
    '  app.listen(Number(process.env.OTHER_PORT));',
    '  const decoy = "app.listen(9092)";',
    '  return decoy;',
    '}',
  ].join('\n'));
  // The literal const and the literal argument are ports the file states; the call's result is
  // not, and the string that only writes a listener is no listener.
  expect(facts.listenerPorts).toEqual(['8080', '9091']);
});

test('a returned query parameter is the member read the tree holds, and a string that names it is no read', async () => {
  const facts = await tsFactsOf([
    'export function readFilters(query: Record<string, string>) {',
    '  // page: query.page is read by the pagination helper, not here',
    "  return {limit: query.limit, status: query.status, page: 'query.page'};",
    '}',
  ].join('\n'));
  expect(facts.returnedQueryProps.get('readFilters')).toEqual(['limit', 'status']);
});
