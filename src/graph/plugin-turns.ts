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

/** One producer generation as it published: the run, the unit and the generation the reader asks about. */
export interface PluginSnapshot {
  readonly runId: string;
  readonly unitId: string;
  readonly generation: number;
}

/** The journal row's session, as the writer states it: the run, the unit and the generation it serves. */
export function snapshotSession(snapshot: PluginSnapshot): string {
  return `${snapshot.runId}:${snapshot.unitId}/${String(snapshot.generation)}`;
}

/**
 * The generation one producer published for a kind, as the current run knows it: this run's generation for the
 * scope, or the one it inherited from an earlier run. A producer that did not complete successfully has no
 * snapshot — later work reads nothing of a half answer.
 */
export async function successfulPluginSnapshot(owner: DatabaseOwner, runId: string, scope: string): Promise<PluginSnapshot> {
  return await owner.transaction('snapshot', async (tx) => {
    const found = await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
      const sql = `SELECT g.run_id, g.unit_id, g.generation, g.context FROM fill_unit_generation g
       JOIN fill_unit u ON u.unit_id = g.unit_id
       JOIN fill_publication p ON p.unit_id = g.unit_id AND p.generation = g.generation
       WHERE (g.run_id = $1 OR EXISTS (
         SELECT 1 FROM fill_event e WHERE e.run_id = $1 AND e.unit_id = g.unit_id
           AND e.generation = g.generation AND e.kind = 'unit-inherited'))
         AND u.stage_id = 'plugin-turns' AND u.scope_key = $2 AND g.generation = u.generation AND g.state = 'published'
       ORDER BY g.generation DESC LIMIT 1`;
      span.setAttribute('db.sql.bytes', Buffer.byteLength(sql));
      const result = await tx.query<{ run_id: string; unit_id: string; generation: unknown; context: unknown }>(sql, [runId, scope]);
      span.setAttribute('db.rows', result.rows.length);
      return result;
    });
    const row = found.rows[0];
    if (row === undefined) throw new Error(`no successful current-run snapshot for ${scope}`);
    const context = typeof row.context === 'string' ? JSON.parse(row.context) as { unitOutcome?: { outcome?: string } | null } : row.context as { unitOutcome?: { outcome?: string } | null };
    if (!['completed', 'unchanged', 'empty'].includes(context?.unitOutcome?.outcome ?? '')) throw new Error(`producer ${scope} did not complete successfully in run ${runId}`);
    return { runId: row.run_id, unitId: row.unit_id, generation: Number(row.generation) };
  });
}

/**
 * Declared vertices of one producer generation, as it answered them — never today's graph (decision 0039, item 11):
 * the journal keeps every publication's change, and replaying one producer's rows up to the row that served the
 * generation gives its answer as it stood then, unchanged fields included (a field restated unchanged is no new row,
 * so its earlier opinion is the one that stands). A partitioned producer's answer is the answer of the partitions
 * it sealed, so the generation's sealed children are replayed too.
 */
export async function pluginSnapshotVertices(owner: DatabaseOwner, snapshot: PluginSnapshot, kind: string): Promise<readonly { readonly key: import('../plugin/protocol.js').PluginKeyValues; readonly values: Readonly<Record<string, unknown>> }[]> {
  const replay = await journalAsOf(owner, snapshot);
  const vertices = new Map<string, { key: import('../plugin/protocol.js').PluginKeyValues; values: Readonly<Record<string, unknown>> }>();
  for (const [uid, held] of replay) {
    if (held.kind !== kind || held.removed || held.key === undefined) continue;
    vertices.set(uid, { key: held.key, values: held.values });
  }
  return [...vertices.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, vertex]) => vertex);
}

/** One vertex as a replay of the journal holds it: its kind, its key once seen, its values, and whether it stands. */
interface ReplayedVertex {
  readonly kind: string;
  readonly key?: import('../plugin/protocol.js').PluginKeyValues;
  readonly values: Readonly<Record<string, unknown>>;
  readonly removed: boolean;
}

/**
 * The producer's vertices as of one generation's publication: the journal rows up to the row that served the
 * generation, in order, folded — an opened opinion states its fields, a closed one withdraws them, a removed
 * vertex leaves. The generation's sealed children are folded in after it, in the order they answered.
 */
async function journalAsOf(owner: DatabaseOwner, snapshot: PluginSnapshot): Promise<Map<string, ReplayedVertex>> {
  const producer = snapshot.unitId.startsWith('plugin-turns/') ? snapshot.unitId.slice('plugin-turns/'.length).split(':')[0]! : snapshot.unitId;
  const rows = await owner.transaction('snapshot', async (tx) => await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
    const sql = `SELECT o.seq, o.change FROM operation o
      WHERE split_part(o.author, '@', 1) = $2 AND o.seq <= COALESCE((
        SELECT max(served.seq) FROM operation served WHERE served.session = $1), 9223372036854775807)
      ORDER BY o.seq`;
    span.setAttribute('db.sql.bytes', Buffer.byteLength(sql));
    const result = await tx.query<{ seq: unknown; change: unknown }>(sql, [snapshotSession(snapshot), producer]);
    span.setAttribute('db.rows', result.rows.length);
    return result;
  }));
  const held = new Map<string, ReplayedVertex>();
  for (const row of rows.rows) {
    const change = (typeof row.change === 'string' ? JSON.parse(row.change) : row.change) as {
      vertices?: readonly { entity: string; uid: string; key?: Readonly<Record<string, unknown>>; state: string }[];
      opinions?: readonly { node?: string; entity?: string; state: string; values?: Readonly<Record<string, unknown>> }[];
    } | null;
    if (change === null || typeof change !== 'object') continue;
    const keys = new Map((change.vertices ?? []).map((vertex) => [vertex.uid, vertex]));
    for (const vertex of change.vertices ?? []) {
      if (vertex.state === 'removed') { held.set(vertex.uid, { kind: vertex.entity, key: (vertex.key ?? {}) as import('../plugin/protocol.js').PluginKeyValues, values: {}, removed: true }); continue; }
      held.set(vertex.uid, { kind: vertex.entity, key: vertex.key as import('../plugin/protocol.js').PluginKeyValues, values: held.get(vertex.uid)?.values ?? {}, removed: false });
    }
    for (const opinion of change.opinions ?? []) {
      if (opinion.node === undefined || opinion.entity === undefined) continue;
      if (opinion.state === 'closed') { held.set(opinion.node, { kind: opinion.entity, key: held.get(opinion.node)?.key ?? keys.get(opinion.node)?.key as import('../plugin/protocol.js').PluginKeyValues | undefined, values: {}, removed: true }); continue; }
      if (opinion.state !== 'opened') continue;
      const previous = held.get(opinion.node);
      held.set(opinion.node, { kind: opinion.entity, key: previous?.key ?? keys.get(opinion.node)?.key as import('../plugin/protocol.js').PluginKeyValues | undefined, values: opinion.values ?? {}, removed: false });
    }
  }
  for (const child of await sealedChildren(owner, snapshot)) {
    for (const [uid, vertex] of await journalAsOf(owner, child)) held.set(uid, vertex);
  }
  return held;
}

/** The generations one split sealed under one generation, with the run that published each. */
async function sealedChildren(owner: DatabaseOwner, snapshot: PluginSnapshot): Promise<PluginSnapshot[]> {
  const children = await owner.transaction('snapshot', async (tx) => await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
    const sql = `SELECT s.child_unit_id, s.child_generation, g.run_id
       FROM fill_unit_split s
       JOIN fill_unit_generation g ON g.unit_id = s.child_unit_id AND g.generation = s.child_generation
       JOIN fill_publication p ON p.unit_id = g.unit_id AND p.generation = g.generation
      WHERE s.parent_unit_id = $1 AND s.parent_generation = $2 ORDER BY s.child_unit_id`;
    span.setAttribute('db.sql.bytes', Buffer.byteLength(sql));
    const result = await tx.query<{ child_unit_id: string; child_generation: unknown; run_id: string }>(sql, [snapshot.unitId, snapshot.generation]);
    span.setAttribute('db.rows', result.rows.length);
    return result;
  }));
  return children.rows.map((child) => ({ runId: child.run_id, unitId: child.child_unit_id, generation: Number(child.child_generation) }));
}

/**
 * What one sealed child generation of a partition answered: complete when it
 * published with a producer outcome that succeeded (decision 0039, item 11), and
 * how many facts it answered — the outcome's own `produced`, so a group of
 * partitions answers for the partitions under it and the barrier above reads one
 * number. The answer is the child's own record — there is no draft set to read
 * (item 13) — so a barrier states what its children answered without a second copy
 * of their writes.
 */
export async function pluginPartitionOutcome(owner: DatabaseOwner, refs: readonly PartitionReference[]): Promise<{ complete: boolean; produced: number }> {
  return await owner.transaction('snapshot', async (tx) => {
    let produced = 0;
    for (const ref of refs) {
      const found = await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
        const sql = `SELECT g.state, g.context
           FROM fill_unit_generation g JOIN fill_publication p ON p.unit_id = g.unit_id AND p.generation = g.generation
          WHERE g.unit_id = $1 AND g.generation = $2`;
        span.setAttribute('db.sql.bytes', Buffer.byteLength(sql));
        const result = await tx.query<{ state: string; context: unknown }>(sql, [ref.unitId, ref.generation]);
        span.setAttribute('db.rows', result.rows.length);
        return result;
      });
      const row = found.rows[0];
      if (row === undefined || row.state !== 'published') return { complete: false, produced };
      const context = typeof row.context === 'string' ? JSON.parse(row.context) as { unitOutcome?: { outcome?: string; produced?: number } | null } : row.context as { unitOutcome?: { outcome?: string; produced?: number } | null };
      const outcome = context?.unitOutcome;
      if (outcome?.outcome === undefined || !['completed', 'unchanged', 'empty'].includes(outcome.outcome)) return { complete: false, produced };
      produced += Number(outcome.produced ?? 0);
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
