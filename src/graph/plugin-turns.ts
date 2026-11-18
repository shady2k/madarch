/**
 * The graph reads a plugin's turn plans by (decision 0035, item 15: plugins work
 * from the graph): the file vertices a kind's documents are, and the entities a
 * producer already holds — its claims and where each was read. The reads stand in
 * this module because only the storage layer runs a query; the turn that drives a
 * plugin asks for them by name and never builds a statement itself.
 */
import type { SqlExecutor } from '../sql-driver.js';
import { semanticBinding } from '../knowledge/semantic-bindings.js';
import { activeExistenceSql, loadAssertions } from './assertion-read.js';
import type { DatabaseOwner } from '../adapters/database-owner.js';
import type { GraphContract, VertexContract } from './contract.js';
import { readKindAssertions, readKindsAssertions } from './records.js';
import { edgeRowsIn, readRunNodeIn } from './fill-state.js';
import { withSpan } from '../obs/trace.js';

/** Reconstruct parent-key references from active graph edges, never scalar names. */
export async function referenceOf(tx: SqlExecutor, contract: GraphContract, kind: string, id: number, seen: ReadonlySet<number> = new Set(), selector: { readonly validAt?: string; readonly recordedAt?: string } = {}): Promise<import('./contract.js').EntityRefDraft> {
  if (seen.has(id)) throw new Error(`${import.meta.path}:21: key-edge instance cycle at node ${id}`);
  const found = await withSpan('graph.plugin-turns.referenceOf', { 'db.system': 'postgres' }, async () => await tx.query<{ uid: string; key: Record<string, import('./contract.js').KeyValueDraft> }>('SELECT uid::text,key FROM node WHERE id=$1', [id]));
  const row = found.rows[0];
  if (row === undefined) throw new Error(`${import.meta.path}:24: missing reference endpoint ${id}`);
  const vertex = contract.vertex.find(v => v.name === kind);
  if (vertex === undefined) throw new Error(`${import.meta.path}:26: undeclared endpoint kind ${kind}`);
  const keyEdges: Record<string, import('./contract.js').EntityRefDraft> = {};
  for (const role of vertex.keyEdges ?? []) {
    const edges = (await readKindAssertions(tx, 'edge', role.edge, [], { ...selector, contract })).filter(e => (role.direction === 'from' ? e.from : e.to) === id);
    if (edges.length !== 1) throw new Error(`${import.meta.path}:30: ${kind} ${row.uid} requires exactly one key edge ${role.role}, found ${edges.length}`);
    const parentId = (role.direction === 'from' ? edges[0]!.to : edges[0]!.from)!;
    const parent = await withSpan('graph.plugin-turns.referenceOf', { 'db.system': 'postgres' }, async () => await tx.query<{ kind: string }>('SELECT k.name AS kind FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.id=$1', [parentId]));
    if (parent.rows[0] === undefined) throw new Error(`${import.meta.path}:33: missing key endpoint ${parentId}`);
    keyEdges[role.role] = await referenceOf(tx, contract, parent.rows[0].kind, parentId, new Set([...seen, id]), selector);
  }
  return { kind, key: row.key, uid: row.uid, ...(Object.keys(keyEdges).length === 0 ? {} : { keyEdges }) };
}

/** Batch the same effective key-edge reads as referenceOf, once per reachable kind. */
async function referencesOf(tx: SqlExecutor, contract: GraphContract, kind: string, ids: readonly number[]): Promise<Map<number, import('./contract.js').EntityRefDraft>> {
  return await withSpan('graph.plugin-turns.referencesOf', {}, async () => {
    const kinds = new Set<string>();
    const edgeKinds = new Set<string>();
    const visit = (name: string): void => {
      if (kinds.has(name)) return;
      kinds.add(name);
      for (const role of contract.vertex.find(vertex => vertex.name === name)?.keyEdges ?? []) {
        edgeKinds.add(role.edge);
        const edge = contract.edge.find(edge => edge.name === role.edge)!;
        for (const parent of role.direction === 'from' ? edge.to : edge.from) visit(parent);
      }
    };
    visit(kind);
    const names = [...edgeKinds];
    const batches = names.length === 0 ? [] : await readKindsAssertions(tx, names.map(name => ({ sort: 'edge', kind: name, fields: [] })), { contract });
    const edges = new Map(names.map((name, index) => [name, batches[index]!]));
    const nodeIds = [...new Set([...ids, ...batches.flatMap(rows => rows.flatMap(row => [row.from!, row.to!]))])];
    const nodes = (await tx.query<{ id: number; uid: string; kind: string; key: Record<string, import('./contract.js').KeyValueDraft> }>(`SELECT n.id,n.uid::text,n.key,k.name AS kind FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.id=ANY($1::bigint[])`, [nodeIds])).rows;
    const byId = new Map(nodes.map(node => [Number(node.id), node]));
    const byEndpoint = new Map<string, import('./records.js').AssertionRecord[]>();
    for (const [name, rows] of edges) for (const row of rows) for (const side of ['from', 'to'] as const) {
      const key = `${name}:${side}:${row[side]}`;
      const held = byEndpoint.get(key);
      if (held === undefined) byEndpoint.set(key, [row]); else held.push(row);
    }
    const build = (name: string, id: number, seen: ReadonlySet<number>): import('./contract.js').EntityRefDraft => {
      if (seen.has(id)) throw new Error(`${import.meta.path}: key-edge instance cycle at node ${id}`);
      const node = byId.get(id);
      if (node === undefined) throw new Error(`${import.meta.path}: missing reference endpoint ${id}`);
      const vertex = contract.vertex.find(vertex => vertex.name === name);
      if (vertex === undefined) throw new Error(`${import.meta.path}: undeclared endpoint kind ${name}`);
      const keyEdges: Record<string, import('./contract.js').EntityRefDraft> = {};
      for (const role of vertex.keyEdges ?? []) {
        const links = byEndpoint.get(`${role.edge}:${role.direction}:${id}`) ?? [];
        if (links.length !== 1) throw new Error(`${import.meta.path}: ${name} ${node.uid} requires exactly one key edge ${role.role}, found ${links.length}`);
        const parentId = (role.direction === 'from' ? links[0]!.to : links[0]!.from)!;
        const parent = byId.get(parentId);
        if (parent === undefined) throw new Error(`${import.meta.path}: missing key endpoint ${parentId}`);
        keyEdges[role.role] = build(parent.kind, parentId, new Set([...seen, id]));
      }
      return { kind: name, key: node.key, uid: node.uid, ...(Object.keys(keyEdges).length === 0 ? {} : { keyEdges }) };
    };
    return new Map(ids.map(id => [id, build(kind, id, new Set())]));
  });
}

/** One file vertex of the graph: the repository it stands in and its path from that repository's root. */
export interface GraphFileRow {
  readonly repository: string;
  readonly path: string;
  readonly keyEdges: Readonly<Record<string, import('./contract.js').EntityRefDraft>>;
}

/**
 * Every file vertex of the graph, in code point order of its repository and path: a file that is in a repository's
 * current tree (its `contains` edge stands) and not removed. A product that declares no code kind holds no file
 * table, and the answer is empty — never an error.
 */
export async function graphFiles(owner: DatabaseOwner, contract: GraphContract): Promise<GraphFileRow[]> {
  return await withSpan('graph.pluginFiles', {}, async () => await owner.transaction('snapshot', async tx => {
    const { readPublishedManifest } = await import('./manifest-publication.js');
    const manifest = await readPublishedManifest(tx);
    if (manifest === undefined) throw new Error(`${import.meta.path}:53: file listing requires the published contract`);
    const fileRole = semanticBinding(manifest, 'file');
    const repositoryRole = semanticBinding(manifest, 'repository');
    const pathField = fileRole.fields['path'];
    const nameField = repositoryRole.fields['name'];
    const parent = fileRole.edges?.['repository'];
    if (pathField === undefined || nameField === undefined || parent === undefined) throw new Error(`${manifest.file}:${fileRole.line}: file listing requires file.path, file.repository edge and repository.name semantic bindings`);
    const fieldsOf = (kind: string, field: string): string[] => {
      const vertex = contract.vertex.find(declaration => declaration.name === kind);
      if (vertex === undefined) throw new Error(`${manifest.file}:${fileRole.line}: semantic role names undeclared kind ${kind}`);
      if (!vertex.fields.some(declaration => declaration.name === field)) throw new Error(`${manifest.file}:${fileRole.line}: semantic role names undeclared field ${kind}.${field}`);
      return vertex.key.includes(field) ? [] : [field];
    };
    const files = await readKindAssertions(tx, 'vertex', fileRole.kind, fieldsOf(fileRole.kind, pathField), { contract });
    const repositories = await readKindAssertions(tx, 'vertex', repositoryRole.kind, fieldsOf(repositoryRole.kind, nameField), { contract });
    const links = await readKindAssertions(tx, 'edge', parent.kind, [], { contract });
    const rows: GraphFileRow[] = [];
    for (const file of files) {
      const linksOfFile = links.filter(edge => (parent.direction === 'from' ? edge.from : edge.to) === file.id);
      if (linksOfFile.length === 0) continue;
      if (linksOfFile.length !== 1) throw new Error(`${manifest.file}:${parent.line}: file ${file.uid} has ambiguous repository membership`);
      const repositoryId = parent.direction === 'from' ? linksOfFile[0]!.to : linksOfFile[0]!.from;
      const repository = repositories.find(row => row.id === repositoryId);
      if (repository === undefined) throw new Error(`${manifest.file}:${parent.line}: file ${file.uid} repository endpoint is not an active ${repositoryRole.kind}`);
      const reference = await referenceOf(tx, contract, fileRole.kind, file.id);
      const scalar = (row: import('./records.js').AssertionRecord, field: string): unknown => Object.hasOwn(row.key, field) ? row.key[field] : row.values[field];
      const path = scalar(file, pathField), name = scalar(repository, nameField);
      if (typeof path !== 'string' || typeof name !== 'string') throw new Error(`${manifest.file}:${fileRole.line}: file path and repository name bindings require text values`);
      rows.push({ repository: name, path, keyEdges: reference.keyEdges ?? {} });
    }
    return rows.sort((a,b)=>a.repository<b.repository?-1:a.repository>b.repository?1:a.path<b.path?-1:a.path>b.path?1:0);
  }));
}

/** One entity a producer holds: its natural key values, and the file its open opinion was read in. */
export interface ProducerEntity {
  readonly key: import('../plugin/protocol.js').PluginKeyValues;
  readonly path: string | null;
  readonly uid: string;
  readonly keyEdges: Readonly<Record<string, import('./contract.js').EntityRefDraft>>;
}

/**
 * The entities of one kind a producer already holds, with the path of their evidence: what a unit's answer is compared
 * with, so an entity the unit no longer holds is a removal. A kind with no table answers nothing.
 */
export async function producerEntities(owner: DatabaseOwner, contract: GraphContract, kind: string, sourceUid: string): Promise<ProducerEntity[]> {
  const vertex: VertexContract | undefined = contract.vertex.find((held) => held.name === kind);
  if (vertex === undefined) return [];
  return await withSpan('graph.producerEntities', {}, async () => await owner.transaction('snapshot', async tx => {
    const hasMerges = (await tx.query<{ present: boolean }>(`SELECT EXISTS(SELECT 1 FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='system.merge') AS present`)).rows[0]!.present;
    // Restrict identities, not the final read's opinions or dispute selection.
    const existence = await loadAssertions(tx, 'vertex', kind, ['$exists'], undefined, { sourceUids: [sourceUid], projectMergedSubjects: hasMerges });
    const subjectIds = [...new Set(existence.filter(assertion => assertion.active && assertion.value === true).map(assertion => assertion.subjectId))];
    const rows = await readKindAssertions(tx, 'vertex', kind, [], { contract, subjectIds });
    const refs = await referencesOf(tx, contract, kind, rows.map(row => row.id));
    const evidence = [...new Set(rows.flatMap(row => row.assertions.filter(assertion => assertion.source === sourceUid).flatMap(assertion => assertion.evidence)))];
    const locations = evidence.length === 0 ? [] : (await tx.query<{ uid: string; path: string }>(`SELECT n.uid::text,n.key->>'path' AS path FROM node n WHERE n.uid=ANY($1::uuid[]) AND n.key ? 'path' ORDER BY n.uid`, [evidence])).rows;
    const paths = new Map(locations.map(location => [location.uid, location.path]));
    return rows.filter(row => row.activeSources.includes(sourceUid)).map(row => {
      const ownEvidence = [...new Set(row.assertions.filter(assertion => assertion.source === sourceUid).flatMap(assertion => assertion.evidence))].sort();
      return { key: row.key as import('../plugin/protocol.js').PluginKeyValues, uid: row.uid, keyEdges: refs.get(row.id)!.keyEdges ?? {}, path: ownEvidence.map(uid => paths.get(uid)).find(path => path !== undefined) ?? null };
    });
  }));
}


/** A completed graph unit pinned to the recorded boundary captured after completion. */
export interface PluginSnapshot {
  readonly unitUid: string;
  readonly recordedAt: string;
  readonly validAt: string;
}
export interface PartitionReference {
  readonly runId: string;
  readonly unitId: string;
  readonly generation: number;
}

async function completedSnapshot(tx: SqlExecutor, runId: string, unitId: string, generation?: number, stageScope?: string): Promise<PluginSnapshot> {
  // From the run: its own name, its own units and the units it inherited (0039.25).
  const run = await readRunNodeIn(tx, runId);
  if (run === undefined) throw new Error(`${import.meta.path}:136: expected one graph run ${runId}, found 0`);
  const relations = await edgeRowsIn(tx, 'system.unit-run', 'to', [run.id]);
  const inherited = await edgeRowsIn(tx, 'system.run-inherited-unit', 'from', [run.id]);
  const ids = new Set([...relations.map(edge => edge.from), ...inherited.map(edge => edge.to)]);
  const members = await readKindAssertions(tx, 'vertex', 'system.unit', ['unit_name', 'state', 'scope', 'generation'], { subjectIds: [...ids] });
  const matches = members.filter(unit =>
    (stageScope === undefined ? unit.values['unit_name'] === unitId : unit.values['scope'] === stageScope)
    && (generation === undefined || unit.values['generation'] === generation)
    && unit.values['state'] === 'published');
  if (matches.length !== 1) throw new Error(`${import.meta.path}:141: expected one completed graph unit ${runId}/${unitId}, found ${matches.length}`);
  const clock = await withSpan('graph.plugin-turns.completedSnapshot', { 'db.system': 'postgres' }, async () => await tx.query<{ now: string }>('SELECT transaction_timestamp()::text AS now'));
  return { unitUid: matches[0]!.uid, recordedAt: clock.rows[0]!.now, validAt: clock.rows[0]!.now };
}

export async function successfulPluginSnapshot(owner: DatabaseOwner, runId: string, scope: string): Promise<PluginSnapshot> {
  return await withSpan('graph.successfulPluginSnapshot', {}, () => owner.transaction('snapshot', tx => completedSnapshot(tx, runId, '', undefined, scope)));
}

/** Replay only assertions authored by the captured unit at its immutable boundary. */
export async function pluginSnapshotVertices(owner: DatabaseOwner, snapshot: PluginSnapshot, kind: string): Promise<readonly { readonly key: import('../plugin/protocol.js').PluginKeyValues; readonly keyEdges?: Readonly<Record<string, import('./contract.js').EntityRefDraft>>; readonly values: Readonly<Record<string, unknown>> }[]> {
  return await withSpan('graph.pluginSnapshotVertices', {}, () => owner.transaction('snapshot', async tx => {
    const { readPublishedManifest } = await import('./manifest-publication.js');
    const { graphContractOf } = await import('../fill/stages/plugin-contract.js');
    const manifest = await readPublishedManifest(tx);
    if (manifest === undefined) throw new Error(`${import.meta.path}:160: snapshot requires the published contract`);
    const contract = graphContractOf(manifest);
    const declaration = contract.vertex.find(vertex => vertex.name === kind);
    if (declaration === undefined) throw new Error(`${import.meta.path}:163: snapshot kind ${kind} is undeclared`);
    // One recursive walk of the sealed children from the snapshot's unit, never a read of every unit. An edge
    // counts as the snapshot's own did: standing at `snapshot.validAt`, recorded by `snapshot.recordedAt`, and
    // not retracted as of it. A child sealed after the snapshot is not in it, and a withdrawal after it is ignored.
    const standing = activeExistenceSql('edge', 'e', ['system.unit-parent'], { validAt: snapshot.validAt, recordedAt: snapshot.recordedAt, contexts: [1] });
    const root = (await tx.query<{ id: string }>('SELECT id::text AS id FROM node WHERE uid=$1::uuid', [snapshot.unitUid])).rows[0];
    const units = new Set<string>(root === undefined ? [] : (await tx.query<{ uid: string }>(`WITH RECURSIVE tree(id) AS (
      SELECT $1::bigint
      UNION
      SELECT e.from_node FROM tree parent JOIN edge e ON e.to_node=parent.id
        JOIN entity k ON k.id=e.entity_id AND k.name='system.unit-parent'
        JOIN node child ON child.id=e.from_node
        JOIN entity ck ON ck.id=child.entity_id AND ck.name='system.unit'
      WHERE ${standing}
    ) SELECT n.uid::text AS uid FROM tree JOIN node n ON n.id=tree.id`, [root.id])).rows.map(row => row.uid));
    const assertions = await loadAssertions(tx, 'vertex', kind, ['$exists', ...declaration.fields.filter(field => !declaration.key.includes(field.name)).map(field => field.name)], undefined, { validAt: snapshot.validAt, recordedAt: snapshot.recordedAt, contexts: [1], unitUids: [...units] });
    const selected = assertions.filter(assertion => assertion.selected === true);
    const ids = [...new Set(selected.filter(assertion => assertion.property === '$exists' && assertion.value === true).map(assertion => assertion.subject.type === 'vertex' ? assertion.subject.uid : ''))];
    const nodes = await tx.query<{ id: number; uid: string; key: import('../plugin/protocol.js').PluginKeyValues }>('SELECT id,uid::text,key FROM node WHERE uid=ANY($1::uuid[]) ORDER BY uid', [ids]);
    return await Promise.all(nodes.rows.map(async node => {
      const ref = await referenceOf(tx, contract, kind, Number(node.id), new Set(), snapshot);
      const values = Object.fromEntries(selected.filter(assertion => assertion.subject.type === 'vertex' && assertion.subject.uid === node.uid && assertion.property !== '$exists').map(assertion => [assertion.property, assertion.value]));
      return { key: node.key, ...(ref.keyEdges === undefined ? {} : { keyEdges: ref.keyEdges }), values };
    }));
  }));
}

export async function pluginPartitionOutcome(owner: DatabaseOwner, refs: readonly PartitionReference[]): Promise<{ complete: boolean; produced: number }> {
  return await withSpan('graph.pluginPartitionOutcome', {}, () => owner.transaction('snapshot', async tx => {
    const snapshots = await Promise.all(refs.map(ref => completedSnapshot(tx, ref.runId, ref.unitId, ref.generation)));
    const rows = await tx.query<{ produced: string }>(`SELECT count(*)::text AS produced FROM (
      SELECT DISTINCT 'vertex' AS sort,subject.to_node AS id FROM assertion a JOIN edge lineage ON lineage.from_node=a.assertion_id JOIN entity k ON k.id=lineage.entity_id JOIN node u ON u.id=lineage.to_node JOIN assertion_vertex_subject attachment ON attachment.assertion_id=a.assertion_id JOIN edge subject ON subject.id=attachment.subject_edge_id JOIN node target ON target.id=subject.to_node JOIN entity target_kind ON target_kind.id=target.entity_id WHERE k.name='system.assertion-unit' AND u.uid=ANY($1::uuid[]) AND a.property='$exists' AND a.operation='assert' AND target_kind.name NOT LIKE 'system.%'
      UNION SELECT DISTINCT 'edge',attachment.edge_id FROM assertion a JOIN edge lineage ON lineage.from_node=a.assertion_id JOIN entity k ON k.id=lineage.entity_id JOIN node u ON u.id=lineage.to_node JOIN assertion_edge_subject attachment ON attachment.assertion_id=a.assertion_id JOIN edge target ON target.id=attachment.edge_id JOIN entity target_kind ON target_kind.id=target.entity_id WHERE k.name='system.assertion-unit' AND u.uid=ANY($1::uuid[]) AND a.property='$exists' AND a.operation='assert' AND target_kind.name NOT LIKE 'system.%'
    ) subjects`, [snapshots.map(snapshot => snapshot.unitUid)]);
    return { complete: true, produced: Number(rows.rows[0]!.produced) };
  }));
}

/** Generic declared field transport. Conflicting opinions remain explicit rather than using arrival order. */
export async function pluginGraphValue(owner: DatabaseOwner, contract: GraphContract, kind: string, key: import('../plugin/protocol.js').PluginKeyValues, field: string, keyEdges: Readonly<Record<string, import('./contract.js').EntityRefDraft>> = {}): Promise<unknown> {
  const vertex = contract.vertex.find(v => v.name === kind);
  if (vertex === undefined || !vertex.fields.some(f => f.name === field)) throw new Error(`${import.meta.path}:307: undeclared catalogue field ${kind}.${field}`);
  const roles = (vertex.keyEdges ?? []).map(role => role.role);
  if (Object.keys(keyEdges).length !== roles.length || Object.keys(keyEdges).some(role => !roles.includes(role))) throw new Error(`${import.meta.path}:309: lookup of ${kind} requires every declared key edge`);
  return await withSpan('graph.pluginValue', {}, async () => await owner.transaction('snapshot', async tx => {
    const matches: import('./records.js').AssertionRecord[] = [];
    for (const row of await readKindAssertions(tx, 'vertex', kind, vertex.key.includes(field) ? [] : [field], { contract })) {
      if (!Object.keys(key).every(k => row.key[k] === key[k])) continue;
      const ref = await referenceOf(tx, contract, kind, row.id);
      const same = (actual: import('./contract.js').EntityRefDraft, wanted: import('./contract.js').EntityRefDraft): boolean => actual.kind === wanted.kind && (wanted.uid === undefined || actual.uid === wanted.uid) && Object.keys(wanted.key).every(k => wanted.key[k] === actual.key[k]) && Object.entries(wanted.keyEdges ?? {}).every(([role, parent]) => actual.keyEdges?.[role] !== undefined && same(actual.keyEdges[role]!, parent));
      if (Object.entries(keyEdges).every(([role, parent]) => ref.keyEdges?.[role] !== undefined && same(ref.keyEdges[role]!, parent))) matches.push(row);
    }
    if (matches.length > 1) throw new Error(`${import.meta.path}:318: ambiguous key lookup for ${kind}`);
    return (vertex.key.includes(field) ? matches[0]?.key[field] : matches[0]?.values[field]) ?? null;
  }));
}
