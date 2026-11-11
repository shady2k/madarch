/**
 * The writer's own consistency records, as a plugin reads them through its host (madarch-stm0.7.1, pieces 2 and 4):
 * the references that name a key no vertex holds (`unresolved_reference`, which `src/graph/write.ts` records), the edges
 * one of whose ends is removed, and the open opinions of a field whose contract requires evidence that state none. The
 * store is read here, in the storage layer, and a plugin never opens it: the fill's host answerer asks these functions by
 * name, one bounded page at a time.
 *
 * A reference is answered only while its target still does not resolve: a row the writer has not deleted yet, whose
 * target a later publication declared, is no longer a problem. The reads page by their own key (the row id, or the
 * opinion's id), so a caller with a cursor walks the store without loading a whole kind.
 */
import type { DatabaseOwner } from '../adapters/database-owner.js';
import type { PluginGraphAddress, PluginGraphRemovedEnd, PluginGraphUnresolvedReference } from '../plugin/protocol.js';

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

/** One evidence-required field of one kind's opinions: the table, the producer and the fields a row states. */
export interface EvidenceDeclaration {
  readonly kind: string;
  readonly table: string;
  readonly producer: string;
  /** The fields whose opinions must carry evidence, key fields and columns alike. The key fields are not columns. */
  readonly fields: readonly string[];
  readonly key: readonly string[];
}

/** One key value as the protocol names it: strings and numbers, with a reference counted as a value its inner key names. */
function flatValue(value: unknown): string | number {
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (value !== null && typeof value === 'object') {
    const held = value as { key?: Record<string, unknown> };
    if (held.key !== undefined && typeof held.key === 'object') {
      const inner = Object.values(held.key).map(flatValue).filter((one) => one !== '');
      if (inner.length === 1) return inner[0]!;
      return inner.join('/');
    }
    return JSON.stringify(value);
  }
  return String(value ?? '');
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

/**
 * Every reference the writer recorded, while its target still does not resolve, one page in code point order of the row
 * id. A key reference names the vertex whose key field does not resolve; an edge end names the edge kind and the other
 * end, when that one stands.
 */
export async function unresolvedReferences(owner: DatabaseOwner, query: ConsistencyQuery = {}): Promise<ConsistencyPage<PluginGraphUnresolvedReference>> {
  const limit = pageSize(query);
  return await owner.transaction('snapshot', async (tx) => {
    const found = await tx.query<{
      row_id: string;
      referrer_kind: string | null; referrer_key: unknown;
      edge_entity: string | null; field: string;
      target_kind: string; target_key: unknown;
      producer: string;
      against_kind: string | null; against_key: unknown;
    }>(
      `SELECT u.id::text AS row_id,
              re.name AS referrer_kind, rn.key AS referrer_key,
              u.edge_entity AS edge_entity, u.field AS field,
              u.target_entity AS target_kind, u.target_key AS target_key,
              u.producer AS producer,
              ae.name AS against_kind, an.key AS against_key
       FROM unresolved_reference u
       LEFT JOIN node rn ON rn.id = u.referrer_node
       LEFT JOIN entity re ON re.id = rn.entity_id
       LEFT JOIN node an ON an.id = u.against_node
       LEFT JOIN entity ae ON ae.id = an.entity_id
       WHERE u.context_id = 1
         AND ($1::text IS NULL OR u.id::text > $1)
         AND NOT EXISTS (
           SELECT 1 FROM node tn JOIN entity te ON te.id = tn.entity_id
           WHERE te.name = u.target_entity AND tn.key = u.target_key AND tn.context_id = u.context_id AND NOT tn.removed
         )
       ORDER BY u.id::text
       LIMIT $2`,
      [query.after ?? null, limit + 1],
    );
    const page = found.rows.slice(0, limit);
    const rows = page.map((row) => {
      const referrer = row.referrer_kind === null ? undefined : addressOf(row.referrer_kind, row.referrer_key);
      const against = row.against_kind === null ? undefined : addressOf(row.against_kind, row.against_key);
      const target = addressOf(row.target_kind, row.target_key);
      if (row.edge_entity === null) {
        return {
          ...(referrer === undefined ? {} : { referrer }),
          field: row.field,
          target,
          producer: row.producer,
          ...(against === undefined ? {} : { against }),
        };
      }
      const edge = {
        kind: row.edge_entity,
        ...(row.field === 'from' ? (referrer === undefined ? {} : { to: referrer }) : {}),
        ...(row.field === 'to' ? (referrer === undefined ? {} : { from: referrer }) : {}),
      };
      return {
        ...(referrer === undefined ? {} : { referrer }),
        edge,
        field: row.field,
        target,
        producer: row.producer,
        ...(against === undefined ? {} : { against }),
      };
    });
    return { rows, ...(found.rows.length > limit ? { next: page[page.length - 1]!.row_id } : {}) };
  });
}

/** Every edge one of whose ends is removed, one page in code point order of the edge id. */
export async function removedEdgeEnds(owner: DatabaseOwner, query: ConsistencyQuery = {}): Promise<ConsistencyPage<PluginGraphRemovedEnd>> {
  const limit = pageSize(query);
  return await owner.transaction('snapshot', async (tx) => {
    const found = await tx.query<{
      row_id: string;
      edge_kind: string; discriminator: string;
      from_kind: string; from_key: unknown; from_removed: boolean;
      to_kind: string; to_key: unknown; to_removed: boolean;
    }>(
      `SELECT e.id::text AS row_id, en.name AS edge_kind, e.discriminator AS discriminator,
              fe.name AS from_kind, fn.key AS from_key, fn.removed AS from_removed,
              te.name AS to_kind, tn.key AS to_key, tn.removed AS to_removed
       FROM edge e
       JOIN entity en ON en.id = e.entity_id
       JOIN node fn ON fn.id = e.from_node
       JOIN entity fe ON fe.id = fn.entity_id
       JOIN node tn ON tn.id = e.to_node
       JOIN entity te ON te.id = tn.entity_id
       WHERE e.context_id = 1
         AND ($1::text IS NULL OR e.id::text > $1)
         AND (fn.removed OR tn.removed)
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
  });
}

/**
 * Every open opinion of a field whose contract requires evidence that rests on none: one row per opinion and field, one
 * page in numeric order of the opinion id. The declarations are the manifest's own — one per kind and producer whose
 * contract marks a field `evidence: true` — so a field that declared nothing is never reported.
 */
export async function unevidencedOpinions(owner: DatabaseOwner, declarations: readonly EvidenceDeclaration[], query: ConsistencyQuery = {}): Promise<ConsistencyPage<{
  readonly entity: PluginGraphAddress;
  readonly field: string;
  readonly producer: string;
  readonly opinion: string;
}>> {
  if (declarations.length === 0) return { rows: [] };
  const limit = pageSize(query);
  return await owner.transaction('snapshot', async (tx) => {
    const out: { entity: PluginGraphAddress; field: string; producer: string; opinion: string; id: string }[] = [];
    for (const declaration of declarations) {
      const columns = declaration.fields.filter((field) => !declaration.key.includes(field));
      const keyFields = declaration.fields.filter((field) => declaration.key.includes(field));
      if (columns.length === 0 && keyFields.length === 0) continue;
      const selected = columns.map((field, at) => `o."${field.replace(/"/gu, '""')}" AS field_${String(at)}`).join(', ');
      const condition = columns.length === 0 ? 'true' : `(${columns.map((field) => `o."${field.replace(/"/gu, '""')}" IS NOT NULL`).join(' OR ')})`;
      const found = await tx.query<Record<string, unknown>>(
        `SELECT o.id::text AS opinion_id, o.said_by AS said_by, n.key AS node_key, ${selected === '' ? 'NULL AS field_0' : selected}
         FROM ${declaration.table} o
         JOIN node n ON n.id = o.node_id
         WHERE o.state = 'open' AND o.context_id = 1
           AND jsonb_array_length(o.evidence) = 0
           AND split_part(o.said_by, '@', 1) = $1
           AND NOT n.removed
           AND ($2::bigint IS NULL OR o.id > $2::bigint)
           AND ${condition}
         ORDER BY o.id
         LIMIT $3`,
        [declaration.producer, query.after ?? null, limit + 1],
      );
      for (const row of found.rows) {
        const entity = addressOf(declaration.kind, row['node_key']);
        const stated = columns.filter((_field, at) => row[`field_${String(at)}`] !== null && row[`field_${String(at)}`] !== undefined);
        for (const field of stated.length > 0 ? stated : keyFields.slice(0, 1)) {
          out.push({ entity, field, producer: String(row['said_by'] ?? ''), opinion: String(row['opinion_id'] ?? ''), id: String(row['opinion_id'] ?? '') });
        }
      }
    }
    out.sort((left, right) => (BigInt(left.id) < BigInt(right.id) ? -1 : BigInt(left.id) > BigInt(right.id) ? 1 : 0));
    const page = out.slice(0, limit);
    return {
      rows: page.map(({ id: _id, ...row }) => row),
      ...(out.length > limit ? { next: page[page.length - 1]!.id } : {}),
    };
  });
}
