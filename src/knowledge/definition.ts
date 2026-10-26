/**
 * The definition block (madarch-m38l.16): an API contract in the shape its own format gives it — the operations of an
 * OpenAPI document, the channels and their messages of an AsyncAPI document, the services and their rpcs of a protobuf
 * file — beside the contract's own text. It reads the graph the fill published (the contract's `code.declares` edges)
 * and the contract file's bytes, and it is a deferred block: the app asks for it only when a reader opens Definition.
 *
 * Every member carries an anchor, so an operation page can open the definition at its own operation, and the raw text
 * says how many lines it holds when the page shows only the first of them.
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { contractDocument, contractFullPath, ContractReadError, object, contractObjectAt, contractReasonOf } from './contract-document.js';
import { protoDocument } from './proto-document.js';
import { byCodePoint } from '../model/order.js';
import type { GraphEntity } from './graph-read.js';
import type { Block, DefinitionMember } from './model.js';
import { refOfGraph, type RenderContext, type Subject } from './blocks.js';

/** The kinds the definition block reads. */
export const DEFINITION_KINDS: ReadonlySet<string> = new Set(['code.contract', 'code.operation']);

const textOf = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** The anchor of one member: its identity made safe for a fragment, with a short digest so two members never share one. */
function anchorOf(prefix: string, rest: string): string {
  const safe = rest.replace(/[^A-Za-z0-9_.:/-]+/gu, '-');
  const digest = createHash('sha256').update(rest).digest('hex').slice(0, 8);
  return `${prefix}-${safe}-${digest}`;
}

/** The members one contract declares, in the order its format reads best: operations by path, channels by name. */
async function membersOf(ctx: RenderContext, contract: GraphEntity): Promise<{ members: DefinitionMember[]; total: number; shown: number; cuts: { channel: string; total: number; shown: number }[] }> {
  // Only the members the table draws are read: a message is a channel's own row, and it would count against the cut
  // without ever being shown (codex review, madarch-m38l.16).
  const declared = await ctx.graph.neighbors(contract, { relations: ['code.declares'], direction: 'out', limit: 500 });
  const renderable = declared.map((group) => ({...group, rows: group.rows.filter((row) => row.entity.kind === 'code.operation' || row.entity.kind === 'code.channel')}));
  const members: DefinitionMember[] = [];
  const omitted = declared.reduce((sum, group) => sum + Math.max(0, group.total - group.rows.length), 0);
  const shown = renderable.reduce((sum, group) => sum + group.rows.length, 0);
  const total = shown + omitted;
  const cuts: {channel: string; total: number; shown: number}[] = [];
  if (total > shown) cuts.push({channel: '', total, shown});
  for (const group of renderable) for (const row of group.rows) {
    const entity = row.entity;
    const ref = refOfGraph(ctx, entity);
    if (entity.kind === 'code.operation') {
      const method = textOf(entity.properties['method']);
      const rpc = textOf(entity.properties['rpc']);
      const service = textOf(entity.properties['service']);
      if (rpc !== undefined) {
        const input = textOf(entity.properties['input']) ?? '?';
        const output = textOf(entity.properties['output']) ?? '?';
        const name = service === undefined ? rpc : `${service}.${rpc}`;
        members.push({anchor: anchorOf('rpc', name), label: name, detail: `${input} → ${output}`, href: ref.href, badge: 'gRPC'});
        continue;
      }
      const path = textOf(entity.properties['path']) ?? entity.label;
      const summary = textOf(entity.properties['summary']);
      const operationId = textOf(entity.properties['operationId']);
      members.push({
        anchor: anchorOf('op', operationId ?? `${method ?? 'any'}:${path}`),
        label: `${(method ?? 'any').toUpperCase()} ${path}`,
        ...(summary === undefined ? {} : {detail: summary}),
        href: ref.href,
        badge: (method ?? 'any').toUpperCase(),
      });
      continue;
    }
    if (entity.kind === 'code.channel') {
      const messages = await ctx.graph.neighbors(entity, {relations: ['code.carries'], direction: 'out', limit: 100});
      const messageGroup = messages.find((held) => held.relation === 'code.carries');
      const carried = messageGroup?.rows.map((message) => message.entity.label).sort(byCodePoint) ?? [];
      if (messageGroup !== undefined && messageGroup.total > messageGroup.rows.length) cuts.push({channel: entity.label, total: messageGroup.total, shown: messageGroup.rows.length});
      members.push({
        anchor: anchorOf('channel', entity.label),
        label: entity.label,
        ...(carried.length === 0 ? {} : {detail: carried.join(', ')}),
        ...(messageGroup === undefined ? {} : {detailTotal: messageGroup.total}),
        href: ref.href,
        badge: 'async',
      });
    }
  }
  return {members: members.sort((left, right) => byCodePoint(`${left.badge ?? ''}|${left.label}`, `${right.badge ?? ''}|${right.label}`)), total, shown, cuts};
}

/** The deferred definition supplies complete source bytes, never a truncated substitute for a standard renderer. */
export async function definitionBlock(ctx: RenderContext, subject: Subject, params: Readonly<Record<string, string>>, file: string, line: number): Promise<Block> {
  const title = params['title'] ?? 'Definition';
  if (subject.source !== 'graph' || !DEFINITION_KINDS.has(subject.entity.kind)) {
    const detail = 'definition requires a contract or operation';
    const fullPath = resolve(ctx.productFolder, file);
    return {type: 'problem', block: 'definition', file, line, message: `${file}:${line} (${fullPath}): ${detail}`, diagnostic: {path: file, line, fullPath, code: 'shape', detail, reason: {code: 'definitionSubjectUnsupported'}}};
  }
  let contract = subject.entity;
  const operation = contract.kind === 'code.operation' ? contract : undefined;
  if (operation !== undefined) {
    const groups = await ctx.graph.neighbors(operation, {relations: ['code.declares'], direction: 'in', limit: 2});
    const group = groups.find((held) => held.relation === 'code.declares');
    const owners = group?.rows.filter((held) => held.entity.kind === 'code.contract') ?? [];
    if (owners.length !== 1 || group?.total !== 1) {
      const count = group?.total ?? 0;
      const detail = `operation must have exactly one declaring contract; found ${count}`;
      const fullPath = resolve(ctx.productFolder, file);
      return {type: 'problem', block: 'definition', file, line, message: `${file}:${line} (${fullPath}): ${detail}`, diagnostic: {path: file, line, fullPath, code: 'shape', detail, reason: {code: 'declaringContractCount', params: {count}}}};
    }
    contract = owners[0]!.entity;
  }
  const path = textOf(contract.properties['path']) ?? contract.key.slice('code.contract:'.length);
  const repo = ctx.repoOfScope(contract.scope) ?? null;
  const format = textOf(contract.properties['format']) ?? 'other';
  const fullPath = (path: string): string => contractFullPath(ctx.productFolder, repo, path);
  const location = refOfGraph(ctx, contract).location;
  const base = {type: 'definition' as const, title, format, contract: path, fullPath: fullPath(path), ...(location === undefined ? {} : {location}), members: [], membersTotal: 0, membersShown: 0, memberCuts: [], spec: {text: '', lines: 0}};
  try {
    const read = (path: string): Promise<string | undefined> => ctx.readSource(repo, path);
    const content = format === 'proto' ? await protoDocument(path, read, fullPath) : await contractDocument(path, read, fullPath);
    const {members, total, shown, cuts} = await membersOf(ctx, contract);
    const result = {...base, members, membersTotal: total, membersShown: shown, memberCuts: cuts, spec: {text: content.text, lines: content.text.split('\n').length}};
    if ('protobuf' in content) return {...result, protobuf: content.protobuf};
    const document = content.document;
    if (format !== 'openapi' && format !== 'asyncapi') throw new ContractReadError({path, line: 1, fullPath: fullPath(path), code: 'format', detail: `unsupported contract format: ${format}`, reason: {code: 'contractFormatUnsupported', params: {format}}});
    if (format === 'openapi' && !(typeof document['openapi'] === 'string' || document['swagger'] === '2.0')) throw new ContractReadError({path, line: 1, fullPath: fullPath(path), code: 'shape', detail: 'the OpenAPI version is missing', reason: {code: 'contractVersionMissing', params: {format: 'OpenAPI'}}});
    if (format === 'asyncapi' && typeof document['asyncapi'] !== 'string') throw new ContractReadError({path, line: 1, fullPath: fullPath(path), code: 'shape', detail: 'the AsyncAPI version is missing', reason: {code: 'contractVersionMissing', params: {format: 'AsyncAPI'}}});
    if (operation === undefined || format !== 'openapi') return {...result, document, descriptions: content.descriptions};
    const method = textOf(operation.properties['method'])?.toLowerCase();
    const route = textOf(operation.properties['path']);
    const paths = document['paths'];
    const item = contractObjectAt(document, object(paths) && route !== undefined ? paths[route] : undefined);
    const selected = contractObjectAt(document, item !== undefined && method !== undefined ? item[method] : undefined);
    if (!object(selected) || method === undefined || route === undefined) throw new ContractReadError({path, line: operation.span?.lineStart ?? 1, fullPath: fullPath(path), code: 'selection', detail: `operation selection is missing or ambiguous: ${method ?? '?'} ${route ?? '?'}`, reason: {code: 'operationSelectionMissing', params: {method: method ?? '?', path: route ?? '?'}}});
    // Give anonymous operations a stable renderer anchor; duplicate ids must never select another operation.
    const declaredId = selected['operationId'];
    const operationId = typeof declaredId === 'string' && declaredId !== '' ? declaredId : anchorOf('operation', `${method}:${route}`);
    let matches = 0;
    if (object(paths)) for (const held of Object.values(paths)) {
      const item = contractObjectAt(document, held);
      if (item !== undefined) for (const [verb, value] of Object.entries(item)) if (['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'].includes(verb) && contractObjectAt(document, value)?.['operationId'] === operationId) matches++;
    }
    if (matches > 1) throw new ContractReadError({path, line: operation.span?.lineStart ?? 1, fullPath: fullPath(path), code: 'selection', detail: `ambiguous operationId: ${operationId}`, reason: {code: 'operationIdAmbiguous', params: {operationId, count: matches}}});
    selected['operationId'] = operationId;
    return {...result, document, descriptions: content.descriptions, selection: {method, path: route, operationId}};
  } catch (error) {
    const diagnostic = error instanceof ContractReadError ? error.diagnostic : {path, line: 1, fullPath: fullPath(path), code: 'parse', detail: String(error), technicalDetail: String(error), reason: contractReasonOf(error) ?? {code: 'unknownDefinitionFailure' as const}};
    return {...base, diagnostics: [diagnostic]};
  }
}
