/** Manifest-driven authoring of graph entities; all mutations go through the graph writer. */
import type { OuterTransaction } from '../adapters/database-owner.js';
import type { FieldContract, KeyValueDraft } from '../graph/contract.js';
import { ensureVertex, journalFor, publishOpinion, removeEntity, writeJournal } from '../graph/write.js';
import { graphContractOf } from '../fill/stages/plugin-contract.js';
import type { KindsManifest } from '../knowledge/kinds.js';
import { withSpan } from '../obs/trace.js';

export type AuthoredAction = 'list' | 'read' | 'create' | 'edit' | 'delete' | 'schema';
export interface AuthoredArguments {
  readonly uid?: string;
  readonly values?: Readonly<Record<string, unknown>>;
  readonly words?: string;
}
export interface AuthoredEntity {
  readonly uid: string;
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
  constructor(readonly status: number, message: string) {
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
    const valid = field.reference !== undefined ? typeof value === 'object' && !Array.isArray(value) && 'kind' in value && 'key' in value
      : field.type === 'text' ? typeof value === 'string'
      : field.type === 'boolean' ? typeof value === 'boolean'
      : field.type === 'integer' ? typeof value === 'number' && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647
      : field.type === 'bigint' ? (typeof value === 'number' && Number.isSafeInteger(value)) || (typeof value === 'string' && /^-?\d+$/u.test(value) && BigInt(value) >= -9223372036854775808n && BigInt(value) <= 9223372036854775807n)
      : field.type === 'timestamp' ? typeof value === 'string' && Number.isFinite(Date.parse(value))
      : (() => { try { return JSON.stringify(value) !== undefined; } catch { return false; } })();
    if (!valid) throw new AuthoredRefusal(400, `field ${JSON.stringify(field.name)}: expected ${field.reference === undefined ? field.type : `a reference to ${field.reference}`}`);
  }
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
  const all = (await tx.query<{ uid: string }>('SELECT uid::text AS uid FROM node ORDER BY uid')).rows.map((row) => row.uid);
  const nodes = (await tx.query<{ node_id: string; uid: string; key: Record<string, KeyValueDraft> }>(
    `SELECT n.id::text AS node_id, n.uid::text AS uid, n.key FROM node n JOIN entity e ON e.id = n.entity_id WHERE e.name = $1 AND n.context_id = 1 AND NOT n.removed ORDER BY n.uid${action === 'edit' || action === 'delete' ? ' FOR UPDATE OF n' : ''}`, [kind],
  )).rows;
  async function view(node: typeof nodes[number]): Promise<AuthoredEntity> {
    const opinions = (await tx.query<Record<string, unknown>>(`SELECT * FROM ${vertex!.table} WHERE node_id = $1::bigint AND state IN ('open', 'confirmed') AND context_id = 1 ORDER BY id`, [node.node_id])).rows;
    const values: Record<string, unknown> = { ...node.key };
    for (const opinion of opinions) for (const field of vertex!.fields) if (!vertex!.key.includes(field.name) && opinion[field.name] !== undefined) values[field.name] = opinion[field.name];
    return { uid: node.uid, id: `${prefix}-${shortestUid(node.uid, all)}`,  values, opinions };
  }
  if (action === 'list') return { ...result, entities: await Promise.all(nodes.map(view)) };
  let node: typeof nodes[number] | undefined;
  if (action !== 'create') {
    const input = args.uid?.startsWith(`${prefix}-`) === true ? args.uid.slice(prefix.length + 1) : args.uid;
    const wanted = input?.replaceAll('-', '').toLowerCase();
    if (wanted === undefined || !/^[0-9a-f]+$/u.test(wanted)) throw new AuthoredRefusal(400, 'uid: expected an entity id or its unambiguous prefix');
    const matches = nodes.filter((held) => held.uid.replaceAll('-', '').startsWith(wanted));
    if (matches.length !== 1) throw new AuthoredRefusal(matches.length === 0 ? 404 : 409, `uid ${JSON.stringify(args.uid)}: ${matches.length === 0 ? 'entity not found' : 'ambiguous prefix'}`);
    node = matches[0]!;
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
    node = { node_id: made.nodeId, uid: made.uid, key };
    all.push(node.uid);
  } else {
    for (const name of vertex.key) if (name in values && JSON.stringify(values[name]) !== JSON.stringify(node.key[name])) throw new AuthoredRefusal(400, `field ${JSON.stringify(name)}: an identity key cannot be edited`);
    opinionValues = { ...(await view(node)).values };
  }
  opinionValues = { ...opinionValues, ...Object.fromEntries(Object.entries(values).filter(([name]) => !vertex.key.includes(name))) };
  await publishOpinion(tx, contract, { kind, nodeId: node.node_id, uid: node.uid, values: opinionValues, producer, producerVersion: '1' }, 1, journal);
  await writeJournal(tx, journal);
  return { ...result, entity: await view(node) };
  });
}
