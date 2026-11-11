/** Manifest-driven authoring of graph entities; all mutations go through the graph writer. */
import type { OuterTransaction } from '../adapters/database-owner.js';
import type { FieldContract, KeyValueDraft } from '../graph/contract.js';
import { ensureVertex, journalFor, publishOpinion, removeEntity, writeJournal } from '../graph/write.js';
import { graphContractOf } from '../fill/stages/plugin-contract.js';
import type { KindsManifest } from '../knowledge/kinds.js';
import { withSpan } from '../obs/trace.js';
import { byCodePoint } from '../model/order.js';

export type AuthoredAction = 'list' | 'read' | 'create' | 'edit' | 'delete' | 'schema';
export interface AuthoredArguments {
  readonly uid?: string;
  readonly values?: Readonly<Record<string, unknown>>;
  readonly words?: string;
  readonly ifRevision?: string;
  readonly recordUnchanged?: boolean;
}
export interface AuthoredEntity {
  readonly uid: string;
  readonly revision: string;
  readonly id: string;
  readonly values: Readonly<Record<string, unknown>>;
  readonly opinions: readonly Record<string, unknown>[];
}
export interface AuthoredResult {
  readonly kind: string;
  readonly fields: readonly FieldContract[];
  readonly entities?: readonly AuthoredEntity[];
  readonly entity?: AuthoredEntity;
}
export class AuthoredRefusal extends Error {
  readonly field: string | undefined;
  constructor(readonly status: number, message: string, readonly conflict?: { readonly field: string; readonly current: unknown; readonly author: string }) {
    super(`${import.meta.path}:1: ${message}`);
    this.field = /^field "([^"]+)"/u.exec(message)?.[1];
  }
}

function validate(fields: readonly FieldContract[], values: Readonly<Record<string, unknown>>, required: boolean): void {
  for (const name of Object.keys(values)) if (!fields.some((field) => field.name === name)) throw new AuthoredRefusal(400, `field ${JSON.stringify(name)}: not declared by this kind`);
  for (const field of fields) {
    const value = values[field.name];
    if (value === undefined && !required) continue;
    if (value === null || value === undefined) {
      if (field.nullable === true) continue;
      throw new AuthoredRefusal(400, `field ${JSON.stringify(field.name)}: a value is required`);
    }
    const valid = field.reference !== undefined ? typeof value === 'object' && !Array.isArray(value) && 'kind' in value && value.kind === field.reference && 'key' in value && value.key !== null && typeof value.key === 'object' && !Array.isArray(value.key)
      : field.type === 'text' ? typeof value === 'string'
      : field.type === 'boolean' ? typeof value === 'boolean'
      : field.type === 'integer' ? typeof value === 'number' && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647
      : field.type === 'bigint' ? (typeof value === 'number' && Number.isSafeInteger(value)) || (typeof value === 'string' && /^-?\d+$/u.test(value) && BigInt(value) >= -9223372036854775808n && BigInt(value) <= 9223372036854775807n)
      : field.type === 'timestamp' ? typeof value === 'string' && Number.isFinite(Date.parse(value))
      : (() => { try { return JSON.stringify(value) !== undefined; } catch { return false; } })();
    if (!valid) throw new AuthoredRefusal(400, `field ${JSON.stringify(field.name)}: expected ${field.reference === undefined ? field.type : `a reference to ${field.reference}`}`);
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
    if (Array.isArray(left) !== Array.isArray(right)) return false;
    const a = Object.entries(left).sort(([a], [b]) => byCodePoint(a, b));
    const b = Object.entries(right).sort(([a], [b]) => byCodePoint(a, b));
    return a.length === b.length && a.every(([key, value], i) => key === b[i]![0] && sameValue(value, b[i]![1]));
  }
  return left === right;
}

/** The shortest prefix is computed against every uid, including withdrawn entities whose identity persists. */
export function shortestUid(uid: string, all: readonly string[]): string {
  const hex = uid.replaceAll('-', '');
  let length = 1;
  while (length < hex.length && all.some((other) => other !== uid && other.replaceAll('-', '').startsWith(hex.slice(0, length)))) length++;
  return hex.slice(0, length);
}

export async function authoredEntity(tx: OuterTransaction, manifest: KindsManifest, prefix: string, person: string, action: AuthoredAction, kind: string, args: AuthoredArguments = {}): Promise<AuthoredResult> {
  return await withSpan('graph.authored', { 'authored.action': action, 'authored.kind': kind }, async () => {
  const declaration = manifest.kinds.get(kind);
  if (declaration?.origin !== 'person') throw new AuthoredRefusal(400, `kind ${JSON.stringify(kind)}: this product does not let a person author it`);
  const contract = graphContractOf(manifest);
  const vertex = contract.vertex.find((held) => held.name === kind);
  if (vertex === undefined) throw new AuthoredRefusal(400, `kind ${JSON.stringify(kind)}: no field contract is declared`);
  const result = { kind, fields: vertex.fields };
  if (action === 'schema') return result;
  const producer = encodeURIComponent(person);
  const identities = (await tx.query<{ node_id: string; uid: string; key: Record<string, KeyValueDraft>; removed: boolean }>(
    `SELECT n.id::text AS node_id, n.uid::text AS uid, n.key, n.removed FROM node n JOIN entity e ON e.id = n.entity_id WHERE e.name = $1 AND n.context_id = 1 ORDER BY n.uid${action === 'edit' || action === 'delete' ? ' FOR UPDATE OF n' : ''}`, [kind],
  )).rows;
  const all = identities.map((node) => node.uid);
  const nodes = identities.filter((node) => !node.removed);
  async function history(node: typeof nodes[number]): Promise<Record<string, unknown>[]> {
    return (await tx.query<Record<string, unknown>>(`SELECT *, id::text AS id FROM ${vertex!.table} WHERE node_id = $1::bigint AND context_id = 1 ORDER BY id::bigint`, [node.node_id])).rows;
  }
  async function view(node: typeof nodes[number]): Promise<AuthoredEntity> {
    const opinions = (await tx.query<Record<string, unknown>>(`SELECT * FROM ${vertex!.table} WHERE node_id = $1::bigint AND state IN ('open', 'confirmed') AND context_id = 1 ORDER BY id`, [node.node_id])).rows;
    const values: Record<string, unknown> = { ...node.key };
    for (const opinion of opinions) for (const field of vertex!.fields) if (!vertex!.key.includes(field.name) && opinion[field.name] !== undefined) values[field.name] = opinion[field.name];
    const rows = await history(node);
    return { uid: node.uid, revision: String(rows.at(-1)?.['id'] ?? '0'), id: `${prefix}-${shortestUid(node.uid, all)}`, values, opinions };
  }
  if (action === 'list') return { ...result, entities: await Promise.all(nodes.map(view)) };
  let node: typeof nodes[number] | undefined;
  if (action !== 'create') {
    const input = args.uid?.startsWith(`${prefix}-`) === true ? args.uid.slice(prefix.length + 1) : args.uid;
    const wanted = input?.replaceAll('-', '').toLowerCase();
    if (wanted === undefined || !/^[0-9a-f]+$/u.test(wanted)) throw new AuthoredRefusal(400, 'uid: expected an entity id or its unambiguous prefix');
    const matches = identities.filter((held) => held.uid.replaceAll('-', '').startsWith(wanted));
    if (matches.length !== 1) throw new AuthoredRefusal(matches.length === 0 ? 404 : 409, `uid ${JSON.stringify(args.uid)}: ${matches.length === 0 ? 'entity not found' : `ambiguous prefix: ${matches.map((held) => `${prefix}-${held.uid.replaceAll('-', '')}`).sort(byCodePoint).join(', ')}`}`);
    node = matches[0]!;
    if (node.removed) throw new AuthoredRefusal(404, `uid ${JSON.stringify(args.uid)}: entity was deleted (entity not found)`);
    if (action === 'read') return { ...result, entity: await view(node) };
  }
  const journal = journalFor(person, args.words === undefined ? {} : { words: args.words });
  if (action === 'delete') {
    const entity = await view(node!);
    await removeEntity(tx, contract, { kind, key: node!.key, uid: node!.uid, producer, withdrawAll: true }, 1, journal);
    await writeJournal(tx, journal);
    return { ...result, entity };
  }
  const values = args.values ?? {};
  validate(vertex.fields, values, action === 'create');
  let opinionValues: Record<string, unknown> = {};
  if (node === undefined) {
    const key = Object.fromEntries(vertex.key.map((name) => [name, values[name]])) as Record<string, KeyValueDraft>;
    const made = await ensureVertex(tx, contract, { kind, key }, 1, journal);
    if (!made.created && !made.revived) throw new AuthoredRefusal(409, 'key: an entity with these key values already exists');
    node = { node_id: made.nodeId, uid: made.uid, key, removed: false };
    all.push(node.uid);
  } else {
    for (const name of vertex.key) if (name in values && JSON.stringify(values[name]) !== JSON.stringify(node.key[name])) throw new AuthoredRefusal(400, `field ${JSON.stringify(name)}: an identity key cannot be edited`);
    const current = await view(node);
    if (args.ifRevision !== undefined) {
      const rows = await history(node);
      const baseline = /^[1-9][0-9]*$/u.test(args.ifRevision) ? rows.find((row) => row['id'] === args.ifRevision) : undefined;
      if (baseline === undefined) throw new AuthoredRefusal(412, `revision ${JSON.stringify(args.ifRevision)}: no such revision for this entity`);
      for (const field of Object.keys(values).sort(byCodePoint)) {
        if (vertex.key.includes(field)) continue;
        let previous = baseline[field];
        let author: string | undefined;
        for (const row of rows) {
          if (BigInt(String(row['id'])) <= BigInt(args.ifRevision)) continue;
          if (!sameValue(previous, row[field])) author = decodeURIComponent(String(row['said_by']).replace(/@[^@]*$/u, ''));
          previous = row[field];
        }
        if (author !== undefined) throw new AuthoredRefusal(412, `field ${JSON.stringify(field)}: changed since revision ${args.ifRevision}; current value ${JSON.stringify(current.values[field])}; changed by ${JSON.stringify(author)}`, { field, current: current.values[field], author });
      }
    }
    opinionValues = { ...current.values };
  }
  opinionValues = { ...opinionValues, ...Object.fromEntries(Object.entries(values).filter(([name]) => !vertex.key.includes(name))) };
  const changed = await publishOpinion(tx, contract, { kind, nodeId: node.node_id, uid: node.uid, values: opinionValues, producer, producerVersion: '1' }, 1, journal);
  if (!changed && args.recordUnchanged === true) journal.declaredVertex(kind, node.uid, node.node_id, node.key);
  await writeJournal(tx, journal);
  return { ...result, entity: await view(node) };
  });
}
