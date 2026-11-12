/**
 * The definition block (madarch-m38l.16): an API contract in the shape its own format gives it — the operations of an
 * OpenAPI document, the channels and their messages of an AsyncAPI document, the services and their rpcs of a protobuf
 * file — beside the contract's published definition opinion. It reads the graph's `code.declares` edges
 * and structured documentation, and it is a deferred block: the app asks for it only when a reader opens Definition.
 *
 * Every member carries an anchor, so an operation page can open the definition at its own operation, and the raw text
 * says how many lines it holds when the page shows only the first of them.
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { byCodePoint } from '../model/order.js';
import type { GraphEntity } from './graph-read.js';
import type { Block, DefinitionMember } from './model.js';
import { refOfGraph, type RenderContext, type Subject } from './blocks.js';
import { declarationMissing, definitionBlockFormOf, definitionBlockMemberOf } from '../product/manifest/kinds.js';

type DefinitionOpinion = Pick<Extract<Block, {type: 'definition'}>, 'spec' | 'document' | 'protobuf' | 'descriptions' | 'selection' | 'diagnostics'>;

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const positiveLine = (value: unknown): boolean => Number.isInteger(value) && Number(value) > 0;
const rowsOf = (value: unknown, check: (row: Record<string, unknown>) => boolean): boolean => Array.isArray(value) && value.every((row) => record(row) && check(row));
const strings = (row: Record<string, unknown>, keys: readonly string[]): boolean => keys.every((key) => typeof row[key] === 'string');

/** Validate the published display model, not the source language it describes. */
function definitionOpinion(value: unknown): value is DefinitionOpinion {
  if (!record(value) || !record(value['spec']) || typeof value['spec']['text'] !== 'string' || !Number.isInteger(value['spec']['lines']) || Number(value['spec']['lines']) < 0) return false;
  if (value['document'] !== undefined && !record(value['document'])) return false;
  if (value['selection'] !== undefined && (!record(value['selection']) || !strings(value['selection'], ['method', 'path', 'operationId']))) return false;
  if (value['descriptions'] !== undefined && !rowsOf(value['descriptions'], (row) => strings(row, ['text', 'path', 'fullPath']) && positiveLine(row['line']))) return false;
  if (value['diagnostics'] !== undefined && !rowsOf(value['diagnostics'], (row) => strings(row, ['path', 'fullPath', 'code', 'detail']) && positiveLine(row['line']) && (row['technicalDetail'] === undefined || typeof row['technicalDetail'] === 'string') && (row['reason'] === undefined || validReason(row['reason'])))) return false;
  if (value['protobuf'] !== undefined) {
    const proto = value['protobuf'];
    if (!record(proto) || !rowsOf(proto['services'], (service) => typeof service['name'] === 'string' && rowsOf(service['methods'], (method) => strings(method, ['name', 'request', 'response']) && typeof method['requestStream'] === 'boolean' && typeof method['responseStream'] === 'boolean')) || !rowsOf(proto['messages'], (message) => typeof message['name'] === 'string' && rowsOf(message['fields'], (field) => strings(field, ['name', 'type', 'rule']) && Number.isInteger(field['id']) && Number(field['id']) > 0 && (field['oneof'] === undefined || typeof field['oneof'] === 'string')) && (message['values'] === undefined || rowsOf(message['values'], (entry) => typeof entry['name'] === 'string' && Number.isInteger(entry['id']))))) return false;
  }
  return true;
}

const REASON_FIELDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'definitionMissing': {},
  'contractReadBudget': {maxFiles: 'number', maxBytes: 'number'},
  'yamlParse': {},
  'yamlConversion': {},
  'definitionObjectRequired': {},
  'yamlAliasCycle': {},
  'definitionNesting': {maxLevels: 'number'},
  'definitionRepresentationBudget': {maxBytes: 'number'},
  'referenceAnchorUnsupported': {ref: 'string'},
  'referenceRemoteOrAbsolute': {ref: 'string'},
  'referenceEncodingInvalid': {ref: 'string'},
  'referenceEscapesRepository': {ref: 'string'},
  'pointerEncodingInvalid': {ref: 'string'},
  'referenceUnresolved': {ref: 'string'},
  'externalExample': {ref: 'string'},
  'externalLogo': {ref: 'string'},
  'descriptionImage': {},
  'descriptionMarkupBudget': {maxNodes: 'number'},
  'reservedBundleField': {field: 'string'},
  'operationReferenceBudgetOrCycle': {maxReferences: 'number'},
  'operationReferenceUnresolved': {ref: 'string'},
  'protoImportBudget': {maxFiles: 'number', maxDepth: 'number'},
  'protoImportMissing': {},
  'protoByteBudget': {maxBytes: 'number'},
  'protoParse': {},
  'protoImportInvalid': {ref: 'string'},
  'protoImportEscapesRepository': {ref: 'string'},
  'protoResolve': {},
  'definitionSubjectUnsupported': {},
  'declaringContractCount': {count: 'number'},
  'contractFormatUnsupported': {format: 'string'},
  'contractVersionMissing': {format: 'string'},
  'operationSelectionMissing': {method: 'string', path: 'string'},
  'operationIdAmbiguous': {operationId: 'string', count: 'number'},
  'unknownDefinitionFailure': {},
  'rendererFailure': {},
  'rendererValidationFailure': {},
  'selectionNotRendered': {}
};
function validReason(value: unknown): boolean {
  if (!record(value) || typeof value['code'] !== 'string' || !Object.hasOwn(REASON_FIELDS, value['code'])) return false;
  const fields = REASON_FIELDS[value['code']]!;
  const params = value['params'];
  return Object.keys(fields).length === 0 ? params === undefined : record(params) && Object.entries(fields).every(([key, type]) => typeof params[key] === type);
}

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
  const renderable = declared.map((group) => ({...group, rows: group.rows.filter((row) => definitionBlockMemberOf(ctx.manifest, row.entity.kind))}));
  const members: DefinitionMember[] = [];
  const omitted = declared.reduce((sum, group) => sum + Math.max(0, group.total - group.rows.length), 0);
  const shown = renderable.reduce((sum, group) => sum + group.rows.length, 0);
  const total = shown + omitted;
  const cuts: {channel: string; total: number; shown: number}[] = [];
  if (total > shown) cuts.push({channel: '', total, shown});
  for (const group of renderable) for (const row of group.rows) {
    const entity = row.entity;
    const ref = refOfGraph(ctx, entity);
    if (definitionBlockFormOf(ctx.manifest, entity.kind) === 'operation') {
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
    if (definitionBlockFormOf(ctx.manifest, entity.kind) === 'channel') {
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
  // The block reads what the manifest says it finds in a kind's entities (decision 0033: `definition-block:` of the
  // declaration), never a kind name of the engine: a contract file, a row of an operation, a row of a channel.
  const entity = subject.source === 'graph' ? subject.entity : undefined;
  const form = definitionBlockFormOf(ctx.manifest, entity?.kind ?? '');
  if (entity === undefined || form === undefined) {
    const detail = declarationMissing(ctx.manifest, entity?.kind ?? '', '"definition-block: contract", "definition-block: operation" or "definition-block: channel"', 'the definition block reads a contract, a row of one operation or a row of one channel');
    const fullPath = resolve(ctx.productFolder, file);
    return {type: 'problem', block: 'definition', file, line, message: `${file}:${line} (${fullPath}): ${detail}`, diagnostic: {path: file, line, fullPath, code: 'shape', detail, reason: {code: 'definitionSubjectUnsupported'}}};
  }
  let contract = entity;
  const operation = form === 'operation' ? contract : undefined;
  if (operation !== undefined) {
    const groups = await ctx.graph.neighbors(operation, {relations: ['code.declares'], direction: 'in', limit: 2});
    const group = groups.find((held) => held.relation === 'code.declares');
    const owners = group?.rows.filter((held) => definitionBlockFormOf(ctx.manifest, held.entity.kind) === 'contract') ?? [];
    if (owners.length !== 1 || group?.total !== 1) {
      const count = group?.total ?? 0;
      const detail = `operation must have exactly one declaring contract; found ${count}`;
      const fullPath = resolve(ctx.productFolder, file);
      return {type: 'problem', block: 'definition', file, line, message: `${file}:${line} (${fullPath}): ${detail}`, diagnostic: {path: file, line, fullPath, code: 'shape', detail, reason: {code: 'declaringContractCount', params: {count}}}};
    }
    contract = owners[0]!.entity;
  }
  const path = textOf(contract.properties['path']) ?? contract.span?.path ?? contract.key;
  const repo = ctx.repoOfScope(contract.scope) ?? null;
  const fullPath = repo === null ? resolve(ctx.productFolder, path) : resolve(ctx.productFolder, 'repos', repo, path);
  const location = refOfGraph(ctx, contract).location;
  const format = textOf(contract.properties['format']) ?? 'other';
  const {members, total, shown, cuts} = await membersOf(ctx, contract);
  const base = {type: 'definition' as const, title, format, contract: path, fullPath, ...(location === undefined ? {} : {location}), members, membersTotal: total, membersShown: shown, memberCuts: cuts, spec: {text: '', lines: 0}};
  // The producer owns format parsing, reference resolution and operation selection. A page only presents its opinion.
  const opinion = entity.properties['definition'];
  if (opinion === null || typeof opinion !== 'object' || Array.isArray(opinion)) {
    return {...base, diagnostics: [{path, line: entity.span?.lineStart ?? 1, fullPath, code: 'missing', detail: 'the graph holds no definition opinion for this entity', reason: {code: 'definitionMissing'}}]};
  }
  if (!definitionOpinion(opinion)) {
    return {...base, diagnostics: [{path, line: entity.span?.lineStart ?? 1, fullPath, code: 'shape', detail: 'the definition opinion has a malformed spec, document, protobuf, selection, descriptions or diagnostics field', reason: {code: 'definitionObjectRequired'}}]};
  }
  const definition = opinion;
  return {...base, spec: definition.spec, ...(definition.document === undefined ? {} : {document: definition.document}), ...(definition.protobuf === undefined ? {} : {protobuf: definition.protobuf}), ...(definition.descriptions === undefined ? {} : {descriptions: definition.descriptions}), ...(definition.selection === undefined ? {} : {selection: definition.selection}), ...(definition.diagnostics === undefined ? {} : {diagnostics: definition.diagnostics})};
}
