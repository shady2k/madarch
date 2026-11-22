/**
 * The writer's own consistency records, as a plugin reads them through its host (madarch-stm0.7.1, pieces 2 and 4):
 * the references that name a key no vertex holds (`typed assertions`, which `src/graph/write.ts` records), the edges
 * one of whose ends is removed, and the open assertions of a field whose contract requires evidence that state none. The
 * store is read here, in the storage layer, and a plugin never opens it: the fill's host answerer asks these functions by
 * name, one bounded page at a time.
 *
 * A reference is answered only while its target still does not resolve and its referring assertion is still open: a row
 * whose target a later publication declared, or whose producer withdrew the assertion that named it, is no longer a
 * problem. The reads page by their own key (the row id, or the recorded sequence and field), so a caller with a cursor walks the
 * store without loading a whole kind.
 */
import type { DatabaseOwner } from '../adapters/database-owner.js';
import { byCodePoint } from '../model/order.js';
import { activeExistenceSql, loadAssertions } from './assertion-read.js';
import { selectAssertions } from './assertion-selection.js';
import { withSpan } from '../obs/trace.js';
import type { PluginGraphAddress, PluginGraphRemovedEnd } from '../plugin/protocol.js';

/** How many rows one page holds unless the caller asks for fewer; a read past this asks again with a cursor. */
export const CONSISTENCY_PAGE = 200;

/** One page asked of a read: where to continue, and how many rows it may hold. */
export interface ConsistencyQuery {
  readonly after?: string;
  readonly limit?: number;
}

/** One page answered by a read: its rows, and the cursor of the next page when one stands. */
export interface ConsistencyPage<T> {
  readonly rows: readonly T[];
  readonly next?: string;
}

/** The page size a query asks for, bounded to a positive whole number. */
function pageSize(query: ConsistencyQuery): number {
  return Number.isSafeInteger(query.limit) && query.limit! > 0 ? Math.min(query.limit!, 1_000) : CONSISTENCY_PAGE;
}

/** One evidence-required field of one kind's assertions: the table, the producer and the fields a row states. */
export interface EvidenceDeclaration {
  readonly kind: string;
  readonly table: string;
  readonly producer: string;
  /** The fields whose assertions must carry evidence, key fields and columns alike. The key fields are not columns. */
  readonly fields: readonly string[];
  readonly key: readonly string[];
}

/** One key value as the protocol names it: strings and numbers, with a reference counted as a value its inner key names. */
function flatValue(value: unknown): string | number {
  return typeof value === 'number' ? value : String(value ?? '');
}

/** One key object flattened, so a reference is the referenced entity's own key values. */
function flatKey(key: unknown): Record<string, string | number> {
  if (key === null || typeof key !== 'object' || Array.isArray(key)) return {};
  return Object.fromEntries(Object.entries(key as Record<string, unknown>).map(([field, value]) => [field, flatValue(value)]));
}

/** The label a person reads for one entity: its path, its name, its hash, or its whole key when it has no such field. */
function labelOf(kind: string, key: Record<string, string | number>): string {
  const preferred = key['path'] ?? key['name'] ?? key['hash'] ?? key['email'];
  if (preferred !== undefined) return String(preferred);
  const values = Object.values(key).map(String).filter((one) => one !== '');
  return values.length === 0 ? kind : values.join(', ');
}

/** One address of the graph, by kind and key, with its label. */
function addressOf(kind: string, key: unknown): PluginGraphAddress {
  const flat = flatKey(key);
  return { kind, key: flat, label: labelOf(kind, flat) };
}

/** Every edge one of whose ends is removed, one page in code point order of the edge id. */
export async function removedEdgeEnds(owner: DatabaseOwner, query: ConsistencyQuery = {}): Promise<ConsistencyPage<PluginGraphRemovedEnd>> {
  const limit = pageSize(query);
  return await withSpan('graph.consistency.removedEnds', {}, async () => await owner.transaction('snapshot', async (tx) => {
    const kinds = (await tx.query<{ name: string; sort: 'node' | 'edge' }>('SELECT name,sort FROM entity ORDER BY name')).rows;
    const now = new Date().toISOString();
    const options = { validAt: now, recordedAt: now, contexts: [1] };
    const vertices = kinds.filter((kind) => kind.sort === 'node').map((kind) => kind.name);
    const edges = kinds.filter((kind) => kind.sort === 'edge').map((kind) => kind.name);
    const structural = edges.filter((kind) => kind.startsWith('system.assertion-'));
    const fromActive = activeExistenceSql('vertex', 'fn', vertices, options);
    const toActive = activeExistenceSql('vertex', 'tn', vertices, options);
    const edgeActive = activeExistenceSql('edge', 'e', edges, options, structural);
    const found = await tx.query<{
      row_id: string;
      edge_kind: string; discriminator: string;
      from_kind: string; from_key: unknown; from_removed: boolean;
      to_kind: string; to_key: unknown; to_removed: boolean;
    }>(
      `SELECT e.id::text AS row_id, en.name AS edge_kind, e.discriminator AS discriminator,
              fe.name AS from_kind, fn.key AS from_key, NOT ${fromActive} AS from_removed,
              te.name AS to_kind, tn.key AS to_key, NOT ${toActive} AS to_removed
       FROM edge e
       JOIN entity en ON en.id = e.entity_id
       JOIN node fn ON fn.id = e.from_node
       JOIN entity fe ON fe.id = fn.entity_id
       JOIN node tn ON tn.id = e.to_node
       JOIN entity te ON te.id = tn.entity_id
       WHERE e.context_id = 1
         AND ($1::text IS NULL OR e.id::text > $1)
         AND ${edgeActive} AND (NOT ${fromActive} OR NOT ${toActive})
       ORDER BY e.id::text
       LIMIT $2`,
      [query.after ?? null, limit + 1],
    );
    const page = found.rows.slice(0, limit);
    const rows = page.map((row) => {
      const from = addressOf(row.from_kind, row.from_key);
      const to = addressOf(row.to_kind, row.to_key);
      const removed = [...(row.from_removed ? ['from' as const] : []), ...(row.to_removed ? ['to' as const] : [])];
      return {
        edge: { kind: row.edge_kind, from, to, ...(row.discriminator === '' ? {} : { discriminator: row.discriminator }) },
        from,
        to,
        removed,
      };
    });
    return { rows, ...(found.rows.length > limit ? { next: page[page.length - 1]!.row_id } : {}) };
  }));
}

/** One unevidenced assertion and field, with the cursor components that tell it from the next. */
interface UnevidencedRow {
  readonly entity: PluginGraphAddress;
  readonly field: string;
  readonly producer: string;
  readonly assertion: string;
}

/**
 * Every open assertion of a field whose contract requires evidence that rests on none: one row per assertion and field, one
 * page in recorded write order and then by code point order of the field name. The cursor is `(recorded sequence, field)`, so an assertion that
 * states two evidence-required fields is two rows across two pages. The declarations are the manifest's own — one per
 * kind and producer whose contract marks a field `evidence: true` — and every evidence-required key field is emitted,
 * several alike.
 */
export async function unevidencedAssertions(owner: DatabaseOwner, declarations: readonly EvidenceDeclaration[], query: ConsistencyQuery = {}): Promise<ConsistencyPage<UnevidencedRow>> {
  if (declarations.length === 0) return { rows: [] };
  const limit = pageSize(query);
  const cursor = query.after === undefined ? undefined : (() => {
    const colon = query.after.indexOf(':');
    return colon < 0 ? { sequence: BigInt(query.after), field: '' } : { sequence: BigInt(query.after.slice(0, colon)), field: query.after.slice(colon + 1) };
  })();
  return await withSpan('graph.consistency.unevidenced', {}, async () => await owner.transaction('snapshot', async (tx) => {
    const out: { entity: PluginGraphAddress; field: string; producer: string; assertion: string; sequence: bigint }[] = [];
    const now = new Date().toISOString();
    for (const declaration of declarations) {
      const identities = await tx.query<{ id: string; key: unknown }>(
        `SELECT n.id::text AS id,n.key FROM node n JOIN entity e ON e.id=n.entity_id WHERE e.name=$1 AND ${activeExistenceSql('vertex', 'n', [declaration.kind], { validAt: now, recordedAt: now, contexts: [1] })}`, [declaration.kind]);
      const assertions = await loadAssertions(tx, 'vertex', declaration.kind, declaration.fields.filter((field) => !declaration.key.includes(field)), identities.rows.map((node) => Number(node.id)));
      for (const node of identities.rows) for (const field of declaration.fields.filter((field) => !declaration.key.includes(field))) {
        const slot = assertions.filter((row) => row.subjectId === Number(node.id) && row.property === field);
        const selection = selectAssertions(slot, { validAt: now, recordedAt: now, contexts: [1] });
        for (const assertion of selection.candidates) {
          const held = slot.find((row) => row.id === assertion.id)!;
          if (held.evidence.length > 0) continue;
          const sequence = held.recordedSequence;
          if (cursor !== undefined && (sequence < cursor.sequence || (sequence === cursor.sequence && byCodePoint(field, cursor.field) <= 0))) continue;
          out.push({ entity: addressOf(declaration.kind, node.key), field, producer: held.source, assertion: held.id, sequence });
        }
      }
    }
    out.sort((left, right) => (left.sequence < right.sequence ? -1 : left.sequence > right.sequence ? 1 : 0) || byCodePoint(left.field, right.field));
    const page = out.slice(0, limit);
    const last = page.at(-1);
    return { rows: page.map(({ sequence: _sequence, ...row }) => row), ...(out.length > limit && last !== undefined ? { next: `${last.sequence}:${last.field}` } : {}) };
  }));
}
