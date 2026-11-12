/**
 * The graph reads a plugin's turn plans by (decision 0035, item 15: plugins work
 * from the graph): the file vertices a kind's documents are, and the entities a
 * producer already holds — its claims and where each was read. The reads stand in
 * this module because only the storage layer runs a query; the turn that drives a
 * plugin asks for them by name and never builds a statement itself.
 */
import type { SqlExecutor } from '../sql-driver.js';
import { withDraftParts } from '../fill/orchestrator-store.js';
import type { DraftWriteLike } from './claims.js';
import type { DatabaseOwner } from '../adapters/database-owner.js';
import type { GraphContract, VertexContract } from './contract.js';
import { generatedTableName } from './contract.js';
import { journalFor, writeJournal, type JournalRead } from './write.js';
import { canonicalKey } from '../plugin/results.js';

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
    const found = await tx.query<{ repository: string; path: string }>(
      `SELECT (f.key->>'repository') AS repository, (f.key->>'path') AS path
       FROM node f
       JOIN entity fe ON fe.id = f.entity_id AND fe.name = $1
       JOIN edge e ON e.to_node = f.id AND e.entity_id = (SELECT id FROM entity WHERE name = $2)
       WHERE NOT f.removed
       ORDER BY repository, path`,
      ['code.file', 'code.contains'],
    );
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
    const found = await tx.query<{ key: Record<string, unknown>; evidence: readonly Record<string, unknown>[] }>(
      `SELECT n.key AS key, o.evidence FROM ${table} o
       JOIN node n ON n.id = o.node_id
       WHERE o.state = 'open' AND split_part(o.said_by, '@', 1) = $1 AND NOT n.removed`,
      [producer],
    );
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
    const found = await tx.query<{ from_kind: string; to_kind: string; from_key: Record<string, unknown>; to_key: Record<string, unknown>; discriminator: string }>(
      `SELECT fk.name AS from_kind, tk.name AS to_kind, nf.key AS from_key, nt.key AS to_key, e.discriminator
       FROM ${declared.table} o
       JOIN edge e ON e.id = o.edge_id
       JOIN node nf ON nf.id = e.from_node
       JOIN entity fk ON fk.id = nf.entity_id
       JOIN node nt ON nt.id = e.to_node
       JOIN entity tk ON tk.id = nt.entity_id
       WHERE o.state = 'open' AND o.context_id = 1 AND split_part(o.said_by, '@', 1) = $1
         AND NOT nf.removed AND NOT nt.removed
       ORDER BY e.id`,
      [producer],
    );
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

/** An immutable successful producer generation, retained with its publication. */
export interface PluginSnapshot {
  readonly runId: string;
  readonly unitId: string;
  readonly generation: number;
  readonly partitions?: readonly PluginSnapshot[];
}

export async function successfulPluginSnapshot(owner: DatabaseOwner, runId: string, scope: string): Promise<PluginSnapshot> {
  return await owner.transaction('snapshot', async (tx) => {
    const found = await tx.query<{ run_id: string; unit_id: string; generation: number; writes: unknown }>(
      `SELECT g.run_id, g.unit_id, g.generation, d.writes FROM fill_unit_generation g
       JOIN fill_unit u ON u.unit_id = g.unit_id
       JOIN fill_publication p ON p.unit_id = g.unit_id AND p.generation = g.generation
       JOIN fill_unit_draft d ON d.unit_id = g.unit_id AND d.generation = g.generation
       WHERE (g.run_id = $1 OR EXISTS (
         SELECT 1 FROM fill_event e WHERE e.run_id = $1 AND e.unit_id = g.unit_id
           AND e.generation = g.generation AND e.kind = 'unit-inherited'))
         AND u.stage_id = 'plugin-turns' AND u.scope_key = $2 AND g.generation = u.generation AND g.state = 'published'
       ORDER BY g.generation DESC LIMIT 1`, [runId, scope]);
    const row = (await withDraftParts(tx, found.rows))[0];
    if (row === undefined) throw new Error(`no successful current-run snapshot for ${scope}`);
    const writes = snapshotWrites(row.writes);
    const outcome = writes.find((write) => write.kind === 'producer-outcome')?.value as { outcome?: string } | undefined;
    if (!['completed', 'unchanged', 'empty'].includes(outcome?.outcome ?? '')) throw new Error(`producer ${scope} did not complete successfully in run ${runId}`);
    const partitions = await partitionSnapshots(tx, writes);
    return { runId: row.run_id, unitId: row.unit_id, generation: Number(row.generation), ...(partitions.length === 0 ? {} : { partitions }) };
  });
}

function snapshotWrites(writes: unknown): { kind: string; value: unknown }[] {
  return (typeof writes === 'string' ? JSON.parse(writes) : writes) as { kind: string; value: unknown }[] ?? [];
}

/** Declared vertices from one captured producer generation, never the current graph. */
export async function pluginSnapshotVertices(owner: DatabaseOwner, snapshot: PluginSnapshot, kind: string): Promise<readonly { readonly key: import('../plugin/protocol.js').PluginKeyValues; readonly values: Readonly<Record<string, unknown>> }[]> {
  return await owner.transaction('snapshot', async tx => {
    const writes = await snapshotDrafts(tx, snapshot);
    for (const partition of snapshot.partitions ?? []) writes.push(...await snapshotDrafts(tx, partition, true));
    const vertices = new Map<string, { key: import('../plugin/protocol.js').PluginKeyValues; values: Readonly<Record<string, unknown>> }>();
    for (const write of writes) {
      if (write.kind !== 'vertex' && write.kind !== 'vertex-removal') continue;
      const vertex = write.value as { kind: string; key: import('../plugin/protocol.js').PluginKeyValues; values?: Readonly<Record<string, unknown>> };
      if (vertex.kind !== kind) continue;
      const identity = canonicalKey(vertex.key);
      if (write.kind === 'vertex-removal') vertices.delete(identity);
      else vertices.set(identity, { key: vertex.key, values: vertex.values ?? {} });
    }
    return [...vertices.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, vertex]) => vertex);
  });
}

export interface PartitionReference {
  readonly runId: string;
  readonly unitId: string;
  readonly generation: number;
}

async function snapshotDrafts(executor: SqlExecutor, snapshot: PluginSnapshot, partition = false): Promise<DraftWriteLike[]> {
  const found = await executor.query<{ unit_id: string; generation: number; writes: unknown }>(
    `SELECT d.unit_id, d.generation, d.writes FROM fill_unit_draft d
     JOIN fill_unit_generation g ON g.unit_id = d.unit_id AND g.generation = d.generation
     JOIN fill_publication p ON p.unit_id = d.unit_id AND p.generation = d.generation
     WHERE g.run_id = $1 AND d.unit_id = $2 AND d.generation = $3`,
    [snapshot.runId, snapshot.unitId, snapshot.generation]);
  const row = (await withDraftParts(executor, found.rows))[0];
  if (row === undefined) throw new Error(`immutable producer snapshot ${snapshot.unitId}/${snapshot.generation} is unavailable`);
  const writes = snapshotWrites(row.writes);
  if (partition && writes.filter(write => write.kind === 'plugin-partition').length !== 1) throw new Error(`partition ${snapshot.unitId}/${snapshot.generation} has no unique partition draft`);
  const expanded: DraftWriteLike[] = [];
  for (const write of writes) {
    if (write.kind !== 'plugin-partition') {
      expanded.push(write);
      continue;
    }
    const partition = write.value as { partitions?: PartitionReference[]; writes?: DraftWriteLike[] };
    if (partition.partitions !== undefined) {
      const children = await partitionSnapshots(executor, [{ kind: 'plugin-aggregate', value: { partitions: partition.partitions } }]);
      for (const child of children) expanded.push(...await snapshotDrafts(executor, child, true));
      continue;
    }
    const inner = partition.writes ?? [];
    const outcomes = inner.filter(write => write.kind === 'producer-outcome').map(write => write.value as { outcome?: string });
    if (outcomes.length !== 1 || !['completed', 'empty', 'unchanged'].includes(outcomes[0]?.outcome ?? '')) throw new Error(`partition ${snapshot.unitId}/${snapshot.generation} did not complete successfully`);
    expanded.push(...inner);
  }
  return expanded;
}

async function partitionSnapshots(executor: SqlExecutor, writes: readonly DraftWriteLike[], runId?: string): Promise<PluginSnapshot[]> {
  const barrier = writes.find(write => write.kind === 'plugin-aggregate')?.value as { partitions: PartitionReference[] } | undefined;
  if (barrier === undefined) return [];
  const snapshots: PluginSnapshot[] = [];
  for (const child of barrier.partitions) {
    const found = await executor.query<{ run_id: string }>(
      `SELECT g.run_id FROM fill_unit_generation g
       JOIN fill_publication p ON p.unit_id = g.unit_id AND p.generation = g.generation
       WHERE g.unit_id = $1 AND g.generation = $2 AND g.state = 'published'
       AND ($3::text IS NULL OR g.run_id = $3 OR EXISTS (
         SELECT 1 FROM fill_event e WHERE e.run_id = $3 AND e.unit_id = g.unit_id AND e.generation = g.generation AND e.kind = 'unit-inherited'))`,
      [child.unitId, child.generation, runId ?? child.runId]);
    const row = found.rows[0];
    if (row === undefined) throw new Error(`partition ${child.unitId}/${child.generation} has no successful publication`);
    snapshots.push({ ...child, runId: row.run_id });
  }
  return snapshots;
}

/** Expand only sealed successful immutable partition drafts inside the barrier's publication transaction. */
export async function expandPartitionWrites(executor: SqlExecutor, writes: readonly DraftWriteLike[]): Promise<DraftWriteLike[]> {
  const expanded = [...writes];
  for (const snapshot of await partitionSnapshots(executor, writes)) expanded.push(...await snapshotDrafts(executor, snapshot, true));
  return expanded;
}

/** Validate every sealed child before the aggregate can state a successful outcome. */
export async function pluginPartitionOutcome(owner: DatabaseOwner, refs: readonly PartitionReference[]): Promise<{ complete: boolean; produced: number }> {
  return await owner.transaction('snapshot', async tx => {
    const snapshots = await partitionSnapshots(tx, [{ kind: 'plugin-aggregate', value: { partitions: refs } }]);
    let produced = 0;
    for (const snapshot of snapshots) {
      const writes = await snapshotDrafts(tx, snapshot, true);
      produced += writes.filter(write => write.kind === 'vertex' || write.kind === 'edge').length;
    }
    return { complete: true, produced };
  });
}

export function valueFromPluginSnapshot(writes: readonly { readonly kind: string; readonly value: unknown }[], kind: string, key: import('../plugin/protocol.js').PluginKeyValues, field: string): unknown {
  const vertex = writes.filter((write) => write.kind === 'vertex').map((write) => write.value as { kind: string; key: import('../plugin/protocol.js').PluginKeyValues; values?: Record<string, unknown> })
    .find((vertex) => vertex.kind === kind && canonicalKey(vertex.key) === canonicalKey(key));
  if (vertex === undefined) return null;
  return vertex.key[field] ?? vertex.values?.[field] ?? null;
}

/** Generic declared field transport. Conflicting opinions remain explicit rather than using arrival order. */
export async function pluginGraphValue(owner: DatabaseOwner, contract: GraphContract, kind: string, key: import('../plugin/protocol.js').PluginKeyValues, field: string): Promise<unknown> {
  const vertex = contract.vertex.find((held) => held.name === kind);
  if (vertex === undefined || !vertex.fields.some((held) => held.name === field)) throw new Error(`undeclared catalogue field ${kind}.${field}`);
  if (vertex.key.includes(field)) return key[field] ?? null;
  const column = `"${field.replaceAll('"', '""')}"`;
  return await owner.transaction('snapshot', async (tx) => {
    const found = await tx.query<{ value: unknown }>(
      `SELECT o.${column} AS value FROM ${vertex.table} o JOIN node n ON n.id = o.node_id
       WHERE n.key = $1::jsonb AND NOT n.removed AND o.state = 'open' AND o.context_id = 1 AND o.lang IS NULL
         AND o.${column} IS NOT NULL ORDER BY o.said_by COLLATE "C"`, [JSON.stringify(key)]);
    const values = [...new Map(found.rows.map((row) => [JSON.stringify(row.value), row.value])).values()];
    return values.length <= 1 ? values[0] ?? null : values;
  });
}
