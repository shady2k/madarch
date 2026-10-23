/**
 * The wiki's reads of the temporal graph (decision 0028), at one valid time
 * and as recorded now. An entity is a logical key, `properties.recordKey`, and
 * the nodes that carry it: when the same key stands under several producers
 * (a producer that names another's node opens a stub of its own, the file
 * lister owns the file), they are one entity, read together, and the nodes of
 * one entity never differ in kind.
 *
 * Nothing here truncates silently: a result that can be large is counted, and
 * the caller shows both the part and the count.
 */
import type { DatabaseOwner, OuterTransaction } from '../adapters/database-owner.js';
import { byCodePoint } from '../model/order.js';

/** Where a node was declared in a file: 1-based lines, half-open bytes. */
export interface SourceSpan {
  path: string;
  lineStart: number;
  lineEnd: number;
  byteStart: number;
  byteEnd: number;
}

export interface GraphEntity {
  /** The logical key. */
  key: string;
  kind: string;
  label: string;
  /** Properties of the nodes, a node that holds more first. */
  properties: Record<string, unknown>;
  nodeIds: string[];
  /** The scope (repository node) of the richest node. */
  scope: string;
  span?: SourceSpan;
}

/** One edge as seen from an entity. */
export interface NeighborEdge {
  relation: string;
  direction: 'out' | 'in';
  other: GraphEntity;
  /** The edge's properties, and its byte position when it is an occurrence. */
  properties: Record<string, unknown>;
  position: { start: number; end: number } | null;
  /** The line of the site the edge was read at, when its properties carry one. */
  span?: SourceSpan;
}

export interface NeighborGroup {
  relation: string;
  direction: 'out' | 'in';
  /** Distinct entities at the other end. */
  total: number;
  /** Edges behind the entities. */
  edges: number;
  rows: { entity: GraphEntity; edges: number; span?: SourceSpan }[];
}

/** One edge with the lightweight view of both ends. */
export interface RelationEdge {
  from: { key: string; kind: string; label: string };
  to: { key: string; kind: string; label: string };
  properties: Record<string, unknown>;
}

type Raw = Record<string, unknown>;

const NODE_SELECT = `v.node_id::text AS node_id, k.key AS kind, v.label, v.properties, v.scope_id::text AS scope_id, v.producer`;
const VISIBLE = (alias: string): string => `${alias}.valid_from <= $1::timestamptz AND $1::timestamptz < ${alias}.valid_to AND ${alias}.recorded_to = 'infinity'`;

export function spanOf(value: unknown): SourceSpan | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const span = value as Record<string, unknown>;
  const { path, lineStart, lineEnd, byteStart, byteEnd } = span;
  if (typeof path !== 'string' || typeof lineStart !== 'number' || typeof lineEnd !== 'number' || typeof byteStart !== 'number' || typeof byteEnd !== 'number') return undefined;
  return { path, lineStart, lineEnd, byteStart, byteEnd };
}

/** Merges the nodes of one key into an entity; the node with most properties leads. */
function entityOf(rows: Raw[]): GraphEntity {
  const sorted = [...rows].sort((a, b) => Object.keys(b['properties'] as object).length - Object.keys(a['properties'] as object).length || byCodePoint(String(a['producer']), String(b['producer'])));
  const lead = sorted[0]!;
  const properties: Record<string, unknown> = {};
  for (const row of sorted) for (const [name, value] of Object.entries(row['properties'] as Record<string, unknown>)) if (!(name in properties)) properties[name] = value;
  const span = spanOf(properties['span']);
  return {
    key: String(properties['recordKey']),
    kind: String(lead['kind']),
    label: String(lead['label']),
    properties,
    nodeIds: sorted.map((row) => String(row['node_id'])),
    scope: String(lead['scope_id']),
    ...(span === undefined ? {} : { span }),
  };
}

export class GraphReader {
  constructor(
    private readonly owner: DatabaseOwner,
    /** The valid time reads are made at: the later of now and the last commit the fill read. */
    private readonly validAt: () => Promise<string> | string,
  ) {}

  private async run<T>(work: (tx: OuterTransaction, at: string) => Promise<T>): Promise<T> {
    const at = await this.validAt();
    return await this.owner.transaction('snapshot', (tx) => work(tx, at));
  }

  /** The entities carrying the key: one per scope. */
  async find(key: string): Promise<GraphEntity[]> {
    return await this.run(async (tx, at) => {
      const found = await tx.query<Raw>(
        `SELECT ${NODE_SELECT} FROM node_version v JOIN node_kind k ON k.id = v.kind_id
         WHERE v.properties->>'recordKey' = $2 AND ${VISIBLE('v')} ORDER BY v.node_id`,
        [at, key],
      );
      return groupByScope(found.rows);
    });
  }

  /** Entities per kind of the graph, in code point order. */
  async kindCounts(): Promise<{ kind: string; count: number }[]> {
    return await this.run(async (tx, at) => {
      const found = await tx.query<Raw>(
        `SELECT k.key AS kind, count(DISTINCT v.properties->>'recordKey')::int AS n
         FROM node_version v JOIN node_kind k ON k.id = v.kind_id
         WHERE v.properties ? 'recordKey' AND ${VISIBLE('v')} GROUP BY k.key ORDER BY k.key`,
        [at],
      );
      return found.rows.map((row) => ({ kind: String(row['kind']), count: Number(row['n']) })).sort((a, b) => byCodePoint(a.kind, b.kind));
    });
  }

  /** One page of a kind's entities, by key, filtered by a text in the key or label. */
  async list(kind: string, options: { q?: string; after?: string; limit: number }): Promise<{ rows: GraphEntity[]; next: string | null; total: number }> {
    return await this.run(async (tx, at) => {
      const text = options.q === undefined || options.q.trim() === '' ? null : `%${options.q.trim().replace(/[\\%_]/g, '\\$&')}%`;
      const filter = `k.key = $2 AND v.properties ? 'recordKey' AND ${VISIBLE('v')} AND ($3::text IS NULL OR v.label ILIKE $3 OR v.properties->>'recordKey' ILIKE $3)`;
      const total = await tx.query<Raw>(`SELECT count(DISTINCT v.properties->>'recordKey')::int AS n FROM node_version v JOIN node_kind k ON k.id = v.kind_id WHERE ${filter}`, [at, kind, text]);
      const keys = await tx.query<Raw>(
        `SELECT key FROM (SELECT DISTINCT v.properties->>'recordKey' AS key FROM node_version v JOIN node_kind k ON k.id = v.kind_id WHERE ${filter}) t
         WHERE ($4::text IS NULL OR key COLLATE "C" > $4::text) ORDER BY key COLLATE "C" LIMIT $5::int`,
        [at, kind, text, options.after ?? null, String(options.limit + 1)],
      );
      const more = keys.rows.length > options.limit;
      const shown = keys.rows.slice(0, options.limit).map((row) => String(row['key']));
      const entities = await this.entitiesByKeys(tx, at, shown);
      return { rows: entities, next: more ? shown[shown.length - 1] ?? null : null, total: Number(total.rows[0]?.['n'] ?? 0) };
    });
  }

  private async entitiesByKeys(tx: OuterTransaction, at: string, keys: readonly string[]): Promise<GraphEntity[]> {
    if (keys.length === 0) return [];
    const found = await tx.query<Raw>(
      `SELECT ${NODE_SELECT} FROM node_version v JOIN node_kind k ON k.id = v.kind_id
       WHERE v.properties->>'recordKey' = ANY($2::text[]) AND ${VISIBLE('v')} ORDER BY v.node_id`,
      [at, `{${keys.map((key) => `"${key.replace(/(["\\])/g, '\\$1')}"`).join(',')}}`],
    );
    const byKey = new Map<string, Raw[]>();
    for (const row of found.rows) {
      const key = String((row['properties'] as Record<string, unknown>)['recordKey']);
      byKey.set(key, [...(byKey.get(key) ?? []), row]);
    }
    return keys.flatMap((key) => (byKey.has(key) ? [entityOf(byKey.get(key)!.filter((row) => row['scope_id'] === byKey.get(key)![0]!['scope_id']))] : []));
  }

  /**
   * The relations of an entity, grouped by relation and direction; each group
   * holds the distinct entities at the other end (counted by the edges that
   * reach them), at most `limit` of them, and says how many there are.
   */
  async neighbors(entity: GraphEntity, options: { relations?: readonly string[]; direction?: 'out' | 'in' | 'both'; limit: number }): Promise<NeighborGroup[]> {
    return await this.run(async (tx, at) => {
      const ids = `{${entity.nodeIds.join(',')}}`;
      const relationFilter = options.relations === undefined ? null : `{${options.relations.map((key) => `"${key.replace(/(["\\])/g, '\\$1')}"`).join(',')}}`;
      const directions: ('out' | 'in')[] = options.direction === 'out' ? ['out'] : options.direction === 'in' ? ['in'] : ['out', 'in'];
      const groups: NeighborGroup[] = [];
      for (const direction of directions) {
        const [self, far] = direction === 'out' ? ['src_id', 'dst_id'] : ['dst_id', 'src_id'];
        const edges = await tx.query<Raw>(
          `SELECT relation, other_key, n FROM (
             SELECT r.key AS relation, o.properties->>'recordKey' AS other_key, count(*)::int AS n
             FROM edge_version e JOIN relation_type r ON r.id = e.relation_type_id
             JOIN node_version o ON o.node_id = e.${far} AND ${VISIBLE('o')} AND o.properties ? 'recordKey'
             WHERE e.${self} = ANY($2::bigint[]) AND ${VISIBLE('e')} AND ($3::text[] IS NULL OR r.key = ANY($3::text[]))
             GROUP BY 1, 2) t ORDER BY relation, other_key COLLATE "C"`,
          [at, ids, relationFilter],
        );
        const byRelation = new Map<string, Raw[]>();
        for (const row of edges.rows) byRelation.set(String(row['relation']), [...(byRelation.get(String(row['relation'])) ?? []), row]);
        for (const [relation, rows] of [...byRelation].sort((a, b) => byCodePoint(a[0], b[0]))) {
          const shown = rows.slice(0, options.limit);
          const entities = await this.entitiesByKeys(tx, at, shown.map((row) => String(row['other_key'])));
          const byKey = new Map(entities.map((one) => [one.key, one]));
          groups.push({
            relation,
            direction,
            total: rows.length,
            edges: rows.reduce((sum, row) => sum + Number(row['n']), 0),
            rows: shown.flatMap((row) => {
              const one = byKey.get(String(row['other_key']));
              return one === undefined ? [] : [{ entity: one, edges: Number(row['n']) }];
            }),
          });
        }
      }
      return groups;
    });
  }

  /**
   * The edges of one relation that end at (`in`) or start at (`out`) the
   * entity, each with the site of its first reading when it carries one. A
   * caller appears once, with the number of its call sites.
   */
  async edgesOf(entity: GraphEntity, relation: string, direction: 'out' | 'in', limit: number): Promise<{ total: number; rows: NeighborEdge[] }> {
    return await this.run(async (tx, at) => {
      const ids = `{${entity.nodeIds.join(',')}}`;
      const [self, far] = direction === 'out' ? ['src_id', 'dst_id'] : ['dst_id', 'src_id'];
      const found = await tx.query<Raw>(
        `SELECT o.properties->>'recordKey' AS other_key, e.properties AS properties, e.byte_start::int AS byte_start, e.byte_end::int AS byte_end
         FROM edge_version e JOIN relation_type r ON r.id = e.relation_type_id
         JOIN node_version o ON o.node_id = e.${far} AND ${VISIBLE('o')} AND o.properties ? 'recordKey'
         WHERE e.${self} = ANY($2::bigint[]) AND r.key = $3 AND ${VISIBLE('e')}
         ORDER BY o.properties->>'recordKey' COLLATE "C", e.byte_start NULLS FIRST, e.id`,
        [at, ids, relation],
      );
      const keys = [...new Set(found.rows.map((row) => String(row['other_key'])))];
      const shownKeys = keys.slice(0, limit);
      const entities = await this.entitiesByKeys(tx, at, shownKeys);
      const byKey = new Map(entities.map((one) => [one.key, one]));
      const rows: NeighborEdge[] = [];
      for (const key of shownKeys) {
        const edges = found.rows.filter((row) => String(row['other_key']) === key);
        const first = edges[0]!;
        const other = byKey.get(key);
        if (other === undefined) continue;
        const properties = (first['properties'] ?? {}) as Record<string, unknown>;
        const span = spanOf(properties['span']);
        rows.push({
          relation,
          direction,
          other,
          // The code extractor folds every call site of a pair into one edge and counts them in `count`.
          properties: { ...properties, sites: edges.reduce((sum, edge) => sum + Number(((edge['properties'] ?? {}) as Record<string, unknown>)['count'] ?? 1), 0) },
          position: first['byte_start'] === null || first['byte_start'] === undefined ? null : { start: Number(first['byte_start']), end: Number(first['byte_end']) },
          ...(span === undefined ? {} : { span }),
        });
      }
      return { total: keys.length, rows };
    });
  }

  /** The entities that contain the entity through `relation`, nearest first, to the root. */
  async containers(entity: GraphEntity, relation: string, limit = 8): Promise<GraphEntity[]> {
    return await this.run(async (tx, at) => {
      const chain: GraphEntity[] = [];
      let current = entity;
      const seen = new Set<string>([entity.key]);
      for (let step = 0; step < limit; step += 1) {
        const parent = await tx.query<Raw>(
          `SELECT DISTINCT o.properties->>'recordKey' AS other_key FROM edge_version e JOIN relation_type r ON r.id = e.relation_type_id
           JOIN node_version o ON o.node_id = e.src_id AND ${VISIBLE('o')} AND o.properties ? 'recordKey'
           WHERE e.dst_id = ANY($2::bigint[]) AND r.key = $3 AND ${VISIBLE('e')} ORDER BY 1 LIMIT 1`,
          [at, `{${current.nodeIds.join(',')}}`, relation],
        );
        const key = parent.rows[0]?.['other_key'];
        if (typeof key !== 'string' || seen.has(key)) break;
        seen.add(key);
        const [next] = await this.entitiesByKeys(tx, at, [key]);
        if (next === undefined) break;
        chain.push(next);
        current = next;
      }
      return chain;
    });
  }

  /**
   * Entities reached from the entity in up to `depth` hops over `relation`,
   * outward, each with the hop it was first reached at; at most `limit`.
   */
  async reach(entity: GraphEntity, relation: string, depth: number, limit: number): Promise<{ total: number; rows: { entity: GraphEntity; hops: number }[] }> {
    return await this.run(async (tx, at) => {
      const found = await tx.query<Raw>(
        `WITH RECURSIVE reach(node_id, hops) AS (
           SELECT e.dst_id, 1 FROM edge_version e JOIN relation_type r ON r.id = e.relation_type_id
           WHERE e.src_id = ANY($2::bigint[]) AND r.key = $3 AND ${VISIBLE('e')}
           UNION
           SELECT e.dst_id, p.hops + 1 FROM reach p JOIN edge_version e ON e.src_id = p.node_id JOIN relation_type r ON r.id = e.relation_type_id
           WHERE r.key = $3 AND ${VISIBLE('e')} AND p.hops < $4::int
         )
         SELECT key, hops FROM (
           SELECT o.properties->>'recordKey' AS key, min(p.hops)::int AS hops FROM reach p
           JOIN node_version o ON o.node_id = p.node_id AND ${VISIBLE('o')} AND o.properties ? 'recordKey'
           GROUP BY 1) t ORDER BY hops, key COLLATE "C"`,
        [at, `{${entity.nodeIds.join(',')}}`, relation, String(depth)],
      );
      const wanted = found.rows.filter((row) => row['key'] !== entity.key);
      const shown = wanted.slice(0, limit);
      const entities = await this.entitiesByKeys(tx, at, shown.map((row) => String(row['key'])));
      const byKey = new Map(entities.map((one) => [one.key, one]));
      return {
        total: wanted.length,
        rows: shown.flatMap((row) => {
          const one = byKey.get(String(row['key']));
          return one === undefined ? [] : [{ entity: one, hops: Number(row['hops']) }];
        }),
      };
    });
  }

  /** The entities of a kind whose key starts with the prefix, in key order; the count is the whole. */
  async byPrefix(kind: string, prefix: string, limit: number): Promise<{ total: number; rows: GraphEntity[] }> {
    return await this.run(async (tx, at) => {
      const like = `${prefix.replace(/[\\%_]/g, '\\$&')}%`;
      const keys = await tx.query<Raw>(
        `SELECT key FROM (SELECT DISTINCT v.properties->>'recordKey' AS key FROM node_version v JOIN node_kind k ON k.id = v.kind_id
           WHERE k.key = $2 AND v.properties->>'recordKey' LIKE $3 AND ${VISIBLE('v')}) t ORDER BY key COLLATE "C"`,
        [at, kind, like],
      );
      const all = keys.rows.map((row) => String(row['key']));
      return { total: all.length, rows: await this.entitiesByKeys(tx, at, all.slice(0, limit)) };
    });
  }

  /**
   * Every edge of one relation type whose two ends both carry a key, with the ends' kinds, labels and the edge's own
   * properties; the diagram views (system, modules) read whole relations. At most `limit` edges come back, and `total`
   * says how many there are, so a caller shows both and never presents a cut as the whole.
   */
  async relationEdges(relation: string, limit: number): Promise<{ total: number; rows: RelationEdge[] }> {
    return await this.run(async (tx, at) => {
      const found = await tx.query<Raw>(
        `SELECT s.properties->>'recordKey' AS from_key, ks.key AS from_kind, s.label AS from_label,
                d.properties->>'recordKey' AS to_key, kd.key AS to_kind, d.label AS to_label, e.properties AS properties
         FROM edge_version e JOIN relation_type r ON r.id = e.relation_type_id
         JOIN node_version s ON s.node_id = e.src_id AND ${VISIBLE('s')} AND s.properties ? 'recordKey'
         JOIN node_kind ks ON ks.id = s.kind_id
         JOIN node_version d ON d.node_id = e.dst_id AND ${VISIBLE('d')} AND d.properties ? 'recordKey'
         JOIN node_kind kd ON kd.id = d.kind_id
         WHERE r.key = $2 AND ${VISIBLE('e')}
         ORDER BY s.properties->>'recordKey' COLLATE "C", d.properties->>'recordKey' COLLATE "C", e.id`,
        [at, relation],
      );
      const rows = found.rows.slice(0, limit).map((row) => ({
        from: { key: String(row['from_key']), kind: String(row['from_kind']), label: String(row['from_label']) },
        to: { key: String(row['to_key']), kind: String(row['to_kind']), label: String(row['to_label']) },
        properties: (row['properties'] ?? {}) as Record<string, unknown>,
      }));
      return { total: found.rows.length, rows };
    });
  }

  /** How many edges of one relation end at each of the keys (the commits that touched a file, say); a key with none is 0. */
  async inDegrees(relation: string, keys: readonly string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>(keys.map((key) => [key, 0]));
    if (keys.length === 0) return counts;
    return await this.run(async (tx, at) => {
      const found = await tx.query<Raw>(
        `SELECT d.properties->>'recordKey' AS key, count(DISTINCT e.id)::int AS n
         FROM edge_version e JOIN relation_type r ON r.id = e.relation_type_id
         JOIN node_version d ON d.node_id = e.dst_id AND ${VISIBLE('d')} AND d.properties ? 'recordKey'
         WHERE r.key = $2 AND ${VISIBLE('e')} AND d.properties->>'recordKey' = ANY($3::text[])
         GROUP BY 1`,
        [at, relation, `{${keys.map((key) => `"${key.replace(/(["\\])/g, '\\$1')}"`).join(',')}}`],
      );
      for (const row of found.rows) counts.set(String(row['key']), Number(row['n']));
      return counts;
    });
  }

  /** The repository nodes of the graph: id and the path the driver recorded. */
  async repositories(): Promise<{ nodeId: string; path: string }[]> {
    return await this.run(async (tx, at) => {
      const found = await tx.query<Raw>(
        `SELECT v.node_id::text AS node_id, v.properties->>'path' AS path FROM node_version v JOIN node_kind k ON k.id = v.kind_id
         WHERE k.key = 'code.repository' AND ${VISIBLE('v')} ORDER BY 1`,
        [at],
      );
      return found.rows.map((row) => ({ nodeId: String(row['node_id']), path: String(row['path']) }));
    });
  }
}

/** One entity per scope; entities of the first scope (by id) lead. */
function groupByScope(rows: Raw[]): GraphEntity[] {
  const byScope = new Map<string, Raw[]>();
  for (const row of rows) byScope.set(String(row['scope_id']), [...(byScope.get(String(row['scope_id'])) ?? []), row]);
  return [...byScope.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([, scoped]) => entityOf(scoped));
}
