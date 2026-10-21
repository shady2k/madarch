/**
 * The protobuf reader: contracts/proto/*.proto into one `code.contract` node
 * and one `code.operation` node per rpc of every service. The grammar of a
 * service block is small and line-shaped, so the reader is a bounded scan of
 * the text: a `package` line, `service <Name> {` blocks, and inside each the
 * `rpc <Name>(<In>) returns (<Out>)` lines -- each with the span it was read
 * at. Anything else in the file (messages, options, comments) is not a
 * contract operation and is not claimed.
 */
import {contractKey, KIND_CONTRACT, KIND_OPERATION, operationKey} from './schema.js';
import {SpanMeasure} from './spans.js';
import type {ExtractedNode, SourceSpan, ExtractionGap} from '../../extract/records.js';

/** One rpc of one service of a proto file. */
export interface ProtoRpc {
  readonly service: string;
  readonly rpc: string;
  readonly input: string;
  readonly output: string;
  readonly span: SourceSpan;
}

export interface ProtoContract {
  readonly path: string;
  readonly package?: string;
  readonly services: readonly {name: string; rpcs: readonly ProtoRpc[]}[];
}

const PACKAGE = /^\s*package\s+([A-Za-z0-9_.]+)\s*;/;
const SERVICE = /^\s*service\s+([A-Za-z0-9_.]+)\s*\{/;
const RPC = /^\s*rpc\s+([A-Za-z0-9_.]+)\s*\(\s*(stream\s+)?([A-Za-z0-9_.]+)\s*\)\s*returns\s*\(\s*(stream\s+)?([A-Za-z0-9_.]+)\s*\)/;

/** Reads one proto file's services; a file with no service still yields its contract node. */
export function readProto(path: string, text: string): {contract: ProtoContract; gaps: readonly ExtractionGap[]} {
  const gaps: ExtractionGap[] = [];
  const measure = new SpanMeasure(text);
  let protoPackage: string | undefined;
  const services: {name: string; rpcs: ProtoRpc[]}[] = [];
  let service: {name: string; rpcs: ProtoRpc[]} | undefined;
  const lines = text.split('\n');
  let offset = 0;
  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1;
    if (service === undefined) {
      const packageMatch = PACKAGE.exec(line);
      if (packageMatch) {
        protoPackage = packageMatch[1]!;
        continue;
      }
      const serviceMatch = SERVICE.exec(line);
      if (serviceMatch) service = {name: serviceMatch[1]!, rpcs: []};
      continue;
    }
    if (/^\s*\}/.test(line)) {
      services.push(service);
      service = undefined;
      continue;
    }
    const rpcMatch = RPC.exec(line);
    if (rpcMatch) {
      const span = measure.span(path, lineStart, lineStart + line.length);
      service.rpcs.push({
        service: service.name,
        rpc: rpcMatch[1]!,
        input: rpcMatch[3]!,
        output: rpcMatch[5]!,
        span,
      });
    }
  }
  if (service !== undefined) {
    // A service block the file never closes: said, not silent.
    gaps.push({path, reason: 'proto: the last service block is never closed'});
    services.push(service);
  }
  services.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {contract: {path, ...(protoPackage !== undefined ? {package: protoPackage} : {}), services}, gaps};
}

/** The contract and operation nodes of one proto file. */
export function protoNodes(contract: ProtoContract): ExtractedNode[] {
  const contractNode: ExtractedNode = {
    key: contractKey(contract.path),
    kind: KIND_CONTRACT,
    label: contract.package ?? contract.path,
    properties: {format: 'proto'},
  };
  const operations: ExtractedNode[] = contract.services.flatMap((service) =>
    service.rpcs.map((rpc) => ({
      key: operationKey(contract.path, `${contract.package ?? ''}.${service.name}/${rpc.rpc}`),
      kind: KIND_OPERATION,
      label: `${service.name}.${rpc.rpc}`,
      properties: {
        rpc: rpc.rpc,
        service: service.name,
        ...(contract.package !== undefined ? {package: contract.package} : {}),
        input: rpc.input,
        output: rpc.output,
      },
      span: rpc.span,
    })),
  );
  return [contractNode, ...operations];
}
