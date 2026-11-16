import { withSpan } from '../obs/trace.js';
/**
 * The graph reads a plugin's turn plans by (decision 0035, item 15: plugins work
 * from the graph): the file vertices a kind's documents are, and the entities a
 * producer already holds — its claims and where each was read. The reads stand in
 * this module because only the storage layer runs a query; the turn that drives a
 * plugin asks for them by name and never builds a statement itself.
 */
import type { DatabaseOwner } from '../adapters/database-owner.js';
import type { GraphContract, VertexContract } from './contract.js';
import { generatedTableName } from './contract.js';
import { journalFor, writeJournal, type JournalRead } from './write.js';

/** One file vertex of the graph: the repository it stands in and its path from that repository's root. */
export interface GraphFileRow {
  readonly repository: string;
  readonly path: string;
}

/**
 * Every file vertex of the graph, in code point order of its repository and path: a file that is in a repository's
 * current tree (its `contains` edge stands) and not removed. A product that declares no code kind holds no file
 * table, and the answer is empty — never an error.
 */
export async function graphFiles(owner: DatabaseOwner, contract: GraphContract): Promise<GraphFileRow[]> {
  if (!contract.vertex.some((kind) => kind.name === 'code.file')) return [];
  return await owner.transaction('snapshot', async (tx) => {
    const found = await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
      const sql = `SELECT (f.key->>'repository') AS repository, (f.key->>'path') AS path
       FROM node f
       JOIN entity fe ON fe.id = f.entity_id AND fe.name = $1
       JOIN edge e ON e.to_node = f.id AND e.entity_id = (SELECT id FROM entity WHERE name = $2)
       WHERE NOT f.removed
       ORDER BY repository, path`;
      span.setAttribute('db.sql.bytes', Buffer.byteLength(sql));
      const result = await tx.query<{ repository: string; path: string }>(
      sql,
      ['code.file', 'code.contains'],
    );
      span.setAttribute('db.rows', result.rows.length);
      return result;
    });
    return found.rows.map((row) => ({ repository: row.repository, path: row.path }));
  });
}

/** One entity a producer holds: its natural key values, and the file its open opinion was read in. */
export interface ProducerEntity {
  readonly key: import('../plugin/protocol.js').PluginKeyValues;
  readonly path: string | null;
}

/**
 * The entities of one kind a producer already holds, with the path of their evidence: what a unit's answer is compared
 * with, so an entity the unit no longer holds is a removal. A kind with no table answers nothing.
 */
export async function producerEntities(owner: DatabaseOwner, contract: GraphContract, kind: string, producer: string): Promise<ProducerEntity[]> {
  const vertex: VertexContract | undefined = contract.vertex.find((held) => held.name === kind);
  if (vertex === undefined) return [];
  const table = generatedTableName(kind, 'vertex');
  return await owner.transaction('snapshot', async (tx) => {
    const found = await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
      const sql = `SELECT n.key AS key, o.evidence FROM ${table} o
       JOIN node n ON n.id = o.node_id
       WHERE o.state = 'open' AND split_part(o.said_by, '@', 1) = $1 AND NOT n.removed`;
      span.setAttribute('db.sql.bytes', Buffer.byteLength(sql));
      const result = await tx.query<{ key: Record<string, unknown>; evidence: readonly Record<string, unknown>[] }>(
      sql,
      [producer],
    );
      span.setAttribute('db.rows', result.rows.length);
      return result;
    });
    const rows = found.rows.map((row) => ({
      key: Object.fromEntries(vertex.key.map((column) => [column, row.key[column] ?? ''])) as import('../plugin/protocol.js').PluginKeyValues,
      path: row.evidence.map((one) => one['path']).find((one): one is string => typeof one === 'string') ?? null,
    }));
    // One vertex one opinion: a producer may hold the same key once, so a repeated key stands once.
    const seen = new Set<string>();
    return rows.filter((row) => {
      const rendered = JSON.stringify(Object.keys(row.key).sort().map((field) => [field, row.key[field]]));
      if (seen.has(rendered)) return false;
      seen.add(rendered);
      return true;
    }).sort((left, right) => (JSON.stringify(left.key) < JSON.stringify(right.key) ? -1 : 1));
  });
}


/** One edge a producer published before: its identity as the edge row holds it, ends named by kind and key. */
export interface ProducerEdge {
  readonly kind: string;
  readonly from: { readonly kind: string; readonly key: Readonly<Record<string, string | number>> };
  readonly to: { readonly kind: string; readonly key: Readonly<Record<string, string | number>> };
  readonly discriminator: string;
}

/**
 * Every edge of one kind whose open opinion names one producer, with both ends by the kind and key the product names
 * them: what a complete unit's answer is compared with, so an edge the unit no longer states is removed rather than
 * kept. The ends' keys are the ones `node.key` holds, which is the same object a draft declares.
 */
export async function producerEdges(owner: DatabaseOwner, contract: GraphContract, kind: string, producer: string): Promise<ProducerEdge[]> {
  const declared = contract.edge.find((held) => held.name === kind);
  if (declared === undefined || declared.table === undefined) return [];
  return await owner.transaction('snapshot', async (tx) => {
    const found = await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
      const sql = `SELECT fk.name AS from_kind, tk.name AS to_kind, nf.key AS from_key, nt.key AS to_key, e.discriminator
       FROM ${declared.table} o
       JOIN edge e ON e.id = o.edge_id
       JOIN node nf ON nf.id = e.from_node
       JOIN entity fk ON fk.id = nf.entity_id
       JOIN node nt ON nt.id = e.to_node
       JOIN entity tk ON tk.id = nt.entity_id
       WHERE o.state = 'open' AND o.context_id = 1 AND split_part(o.said_by, '@', 1) = $1
         AND NOT nf.removed AND NOT nt.removed
       ORDER BY e.id`;
      span.setAttribute('db.sql.bytes', Buffer.byteLength(sql));
      const result = await tx.query<{ from_kind: string; to_kind: string; from_key: Record<string, unknown>; to_key: Record<string, unknown>; discriminator: string }>(
      sql,
      [producer],
    );
      span.setAttribute('db.rows', result.rows.length);
      return result;
    });
    const keyOf = (value: Record<string, unknown>): Record<string, string | number> => value as Record<string, string | number>;
    return found.rows.map((row) => ({
      kind,
      from: { kind: row.from_kind, key: keyOf(row.from_key) },
      to: { kind: row.to_kind, key: keyOf(row.to_key) },
      discriminator: row.discriminator,
    }));
  });
}

/**
 * The debug entry of a unit that published nothing — a plugin that read the graph and then crashed or timed out: its
 * requests stand even where its answer does not, as one journal row in a transaction of its own. This module is the
 * graph's own, so the write stands where the architecture says a publication may: a caller outside `src/graph` asks
 * for it by name. A store that cannot take the row does not hide the unit's failure.
 */
export async function writeRequestEntry(owner: DatabaseOwner, author: string, records: readonly JournalRead[]): Promise<void> {
  if (records.length === 0) return;
  await owner.transaction('write', async (tx) => {
    const journal = journalFor(author);
    for (const record of records) journal.read(record);
    await writeJournal(tx, journal);
  });
}

/**
 * What one sealed child generation of a partition answered: complete when it
 * published with a producer outcome that succeeded (decision 0039, item 11), and
 * how many facts its publication applied. The answer is the child's own record —
 * there is no draft set to read (item 13) — so a barrier states what its children
 * answered without a second copy of their writes.
 */
export async function pluginPartitionOutcome(owner: DatabaseOwner, refs: readonly PartitionReference[]): Promise<{ complete: boolean; produced: number }> {
  return await owner.transaction('snapshot', async (tx) => {
    let produced = 0;
    for (const ref of refs) {
      const found = await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
        const sql = `SELECT g.state, p.facts, g.context
           FROM fill_unit_generation g JOIN fill_publication p ON p.unit_id = g.unit_id AND p.generation = g.generation
          WHERE g.unit_id = $1 AND g.generation = $2`;
        span.setAttribute('db.sql.bytes', Buffer.byteLength(sql));
        const result = await tx.query<{ state: string; facts: unknown; context: unknown }>(sql, [ref.unitId, ref.generation]);
        span.setAttribute('db.rows', result.rows.length);
        return result;
      });
      const row = found.rows[0];
      if (row === undefined || row.state !== 'published') return { complete: false, produced };
      const context = typeof row.context === 'string' ? JSON.parse(row.context) as { unitOutcome?: { outcome?: string } | null } : row.context as { unitOutcome?: { outcome?: string } | null };
      const outcome = context?.unitOutcome?.outcome;
      if (outcome === undefined || !['completed', 'unchanged', 'empty'].includes(outcome)) return { complete: false, produced };
      produced += Number(row.facts);
    }
    return { complete: true, produced };
  });
}

/** One generation a partition barrier waits for: the run, the unit and the generation the split sealed. */
export interface PartitionReference {
  readonly runId: string;
  readonly unitId: string;
  readonly generation: number;
}

/** Generic declared field transport. Conflicting opinions remain explicit rather than using arrival order. */
export async function pluginGraphValue(owner: DatabaseOwner, contract: GraphContract, kind: string, key: import('../plugin/protocol.js').PluginKeyValues, field: string): Promise<unknown> {
  const vertex = contract.vertex.find((held) => held.name === kind);
  if (vertex === undefined || !vertex.fields.some((held) => held.name === field)) throw new Error(`undeclared catalogue field ${kind}.${field}`);
  if (vertex.key.includes(field)) return key[field] ?? null;
  const column = `"${field.replaceAll('"', '""')}"`;
  return await owner.transaction('snapshot', async (tx) => {
    const found = await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
      const sql = `SELECT o.${column} AS value FROM ${vertex.table} o JOIN node n ON n.id = o.node_id
       WHERE n.key = $1::jsonb AND NOT n.removed AND o.state = 'open' AND o.context_id = 1 AND o.lang IS NULL
         AND o.${column} IS NOT NULL ORDER BY o.said_by COLLATE "C"`;
      span.setAttribute('db.sql.bytes', Buffer.byteLength(sql));
      const result = await tx.query<{ value: unknown }>(
      sql, [JSON.stringify(key)]);
      span.setAttribute('db.rows', result.rows.length);
      return result;
    });
    const values = [...new Map(found.rows.map((row) => [JSON.stringify(row.value), row.value])).values()];
    return values.length <= 1 ? values[0] ?? null : values;
  });
}
