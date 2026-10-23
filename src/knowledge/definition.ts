/**
 * The definition block (madarch-m38l.16): an API contract in the shape its own format gives it — the operations of an
 * OpenAPI document, the channels and their messages of an AsyncAPI document, the services and their rpcs of a protobuf
 * file — beside the contract's own text. It reads the graph the fill published (the contract's `code.declares` edges)
 * and the contract file's bytes, and it is a deferred block: the app asks for it only when a reader opens Definition.
 *
 * Every member carries an anchor, so an operation page can open the definition at its own operation, and the raw text
 * says how many lines it holds when the page shows only the first of them.
 */
import { byCodePoint } from '../model/order.js';
import type { GraphEntity } from './graph-read.js';
import type { Block, DefinitionMember } from './model.js';
import { refOfGraph, type RenderContext, type Subject } from './blocks.js';

/** The kinds the definition block reads. */
export const DEFINITION_KINDS: ReadonlySet<string> = new Set(['code.contract']);

/** The longest contract text the block carries; the block says the whole length beside it. */
const SPEC_LIMIT = 400;

const textOf = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** The anchor of one member: what identifies it inside its contract, made safe for a fragment. */
function anchorOf(prefix: string, rest: string): string {
  return `${prefix}-${rest.replace(/[^A-Za-z0-9_.:/-]+/gu, '-')}`;
}

/** The members one contract declares, in the order its format reads best: operations by path, channels by name. */
async function membersOf(ctx: RenderContext, contract: GraphEntity): Promise<{ members: DefinitionMember[]; total: number; shown: number; cuts: { channel: string; total: number; shown: number }[] }> {
  const declared = await ctx.graph.neighbors(contract, { relations: ['code.declares'], direction: 'out', limit: 500 });
  const members: DefinitionMember[] = [];
  const total = declared.reduce((sum, group) => sum + group.total, 0);
  const shown = declared.reduce((sum, group) => sum + group.rows.length, 0);
  const cuts: {channel: string; total: number; shown: number}[] = [];
  if (total > shown) cuts.push({channel: '', total, shown});
  for (const group of declared) for (const row of group.rows) {
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

/** The definition block: a contract's members and its own text, read from the graph and the repository. */
export async function definitionBlock(ctx: RenderContext, subject: Subject, params: Readonly<Record<string, string>>, file: string, line: number): Promise<Block> {
  const title = params['title'] ?? 'Definition';
  if (subject.source !== 'graph') {
    return { type: 'problem', block: 'definition', file, line, message: 'the definition block reads a contract of the graph, and this page is not one' };
  }
  const contract = subject.entity;
  if (!DEFINITION_KINDS.has(contract.kind)) {
    return { type: 'problem', block: 'definition', file, line, message: `the definition block shows an API contract, and this page is a ${contract.kind}: add it to a code.contract template` };
  }
  const path = textOf(contract.properties['path']) ?? contract.key.slice('code.contract:'.length);
  const repo = ctx.repoOfScope(contract.scope) ?? null;
  const text = await ctx.readSource(repo, path);
  if (text === undefined) {
    return { type: 'problem', block: 'definition', file, line, message: `the bytes of ${path} are not readable at the commit the graph was filled from, so the definition cannot be shown` };
  }
  const lines = text.split('\n');
  const shown = lines.slice(0, SPEC_LIMIT).join('\n');
  const {members, total, shown: membersShown, cuts: memberCuts} = await membersOf(ctx, contract);
  const location = refOfGraph(ctx, contract).location;
  return {
    type: 'definition',
    title,
    format: textOf(contract.properties['format']) ?? 'other',
    contract: path,
    ...(location === undefined ? {} : { location }),
    members,
    membersTotal: total,
    membersShown,
    memberCuts,
    spec: { text: shown, lines: lines.length },
  };
}
