/**
 * A plugin snapshot's input follows the edges as they stood at the snapshot, not as they stand when it is read
 * (madarch-64o5.74, the ALX-118 review's fourth finding). A child sealed after the snapshot is not in that
 * snapshot's input, and an edge withdrawn after a snapshot leaves that snapshot's input unchanged. The read is
 * the one the plugin turn makes, `pluginSnapshotVertices`, from a snapshot `successfulPluginSnapshot` captured.
 */
import { afterAll, expect, test } from 'bun:test';
import { parseKinds } from '../src/product/manifest/kinds.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { publishGraphDrafts, bindWriteCapability } from '../src/graph/write.js';
import { successfulPluginSnapshot, pluginSnapshotVertices } from '../src/graph/plugin-turns.js';
import { activeExistenceSql, loadAssertions } from '../src/graph/assertion-read.js';
import { referenceOf, sdkReference, type PluginSnapshot } from '../src/graph/plugin-turns.js';
import { withSpan } from '../src/obs/trace.js';
import type { SqlExecutor } from '../src/sql-driver.js';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import type { GraphContract } from '../src/graph/contract.js';
import { bindTestWriteCapability } from './write-capability-fixture.js';
import { createTestDatabaseOwner, type TestDatabaseOwner } from './test-database.js';

const RUN = '019a0000-0000-7000-8000-0000000000a1';
const PARENT = '019a0000-0000-7000-8000-0000000000a2';
const CHILD = '019a0000-0000-7000-8000-0000000000a3';
const owners: TestDatabaseOwner[] = [];
afterAll(async () => { for (const owner of owners) await owner.close(); });

const pause = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 5)); };

/** The manifest's own encoding: a Map is a list of pairs, so the declaration survives JSON. */
const encode = (value: unknown): unknown => value instanceof Map
  ? { $map: [...value].map(([key, held]) => [key, encode(held)]) }
  : Array.isArray(value) ? value.map(encode)
  : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, held]) => [key, encode(held)]))
  : value;

interface Fixture {
  readonly owner: TestDatabaseOwner;
  readonly contract: GraphContract;
  readonly publish: (vertices: Parameters<typeof publishGraphDrafts>[2]['vertices']) => Promise<number>;
  readonly publishAs: (unitUid: string, vertices: Parameters<typeof publishGraphDrafts>[2]['vertices']) => Promise<number>;
  readonly edges: (draft: Parameters<typeof publishGraphDrafts>[2]) => Promise<number>;
}

async function fixture(nested = false): Promise<Fixture> {
  const manifest = parseKinds({ root: { kinds: {
    ...(nested ? {
      Organisation: { source: 'graph', key: ['name'], fields: [{ name: 'name', type: 'text', producers: ['fixture'] }] },
      Repository: { source: 'graph', key: ['name'], 'key-edges': [{ role: 'organisation', edge: 'repository-organisation', side: 'from' }], fields: [{ name: 'name', type: 'text', producers: ['fixture'] }] },
    } : {}),
    'Item': { source: 'graph', key: ['id'], ...(nested ? { 'key-edges': [{ role: 'repository', edge: 'item-repository', side: 'from' }] } : {}), fields: [{ name: 'id', type: 'text', producers: ['fixture'] }, { name: 'text', type: 'text', producers: ['fixture'] }] },
  }, ...(nested ? { edges: [
    { name: 'repository-organisation', from: ['Repository'], to: ['Organisation'], 'on-parent-delete': 'restrict', cardinality: { from: { min: 1, max: 1 }, to: { min: 0, max: null } }, labels: { en: { out: 'belongs to', in: 'contains' }, ru: { out: 'принадлежит', in: 'содержит' } } },
    { name: 'item-repository', from: ['Item'], to: ['Repository'], 'on-parent-delete': 'restrict', cardinality: { from: { min: 1, max: 1 }, to: { min: 0, max: null } }, labels: { en: { out: 'belongs to', in: 'contains' }, ru: { out: 'принадлежит', in: 'содержит' } } },
  ] } : {}) }, at: () => 1 }, '/fixture/catalog.yaml', '/fixture');
  expect(manifest.findings).toEqual([]);
  const contract = withManifestContract(graphContractOf(manifest));
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  owners.push(owner);
  const write = async (work: (tx: Parameters<Parameters<TestDatabaseOwner['transaction']>[1]>[0]) => Promise<number>): Promise<number> => await owner.transaction('write', async (tx) => {
    await bindTestWriteCapability(tx, contract);
    return await work(tx);
  });
  const publish = async (vertices: Parameters<typeof publishGraphDrafts>[2]['vertices']): Promise<number> =>
    await write(async (tx) => await publishGraphDrafts(tx, contract, { vertices, removals: [] }));
  const publishAs = async (unitUid: string, vertices: Parameters<typeof publishGraphDrafts>[2]['vertices']): Promise<number> => await owner.transaction('write', async (tx) => {
    const binding = await bindTestWriteCapability(tx, contract);
    bindWriteCapability(tx, { ...binding, unitUid });
    return await publishGraphDrafts(tx, contract, { vertices, removals: [] });
  });
  const edges = async (draft: Parameters<typeof publishGraphDrafts>[2]): Promise<number> =>
    await write(async (tx) => await publishGraphDrafts(tx, contract, draft));
  await publish([
    { kind: 'manifest.catalogue', key: { name: 'product' }, values: { declaration: JSON.stringify(encode(manifest)) }, producer: 'fixture', producerVersion: '1' },
    { kind: 'system.run', uid: RUN, key: {}, values: { run_name: 'snapshot-run', product_name: 'fixture', state: 'succeeded', planning_epoch: 1, planning_closed: true, has_selection: false, created_at: 1, updated_at: 1 }, producer: 'fixture', producerVersion: '1' },
    { kind: 'system.unit', uid: PARENT, key: {}, values: { unit_name: 'plugin-turns/base:Source:1', generation: 1, state: 'published', scope: 'base:Source' }, producer: 'fixture', producerVersion: '1' },
    { kind: 'system.unit', uid: CHILD, key: {}, values: { unit_name: 'plugin-turns/base:Source:1#child', generation: 1, state: 'published', scope: 'base:Source#child' }, producer: 'fixture', producerVersion: '1' },
  ]);
  await edges({ vertices: [], removals: [], edges: [PARENT, CHILD].map((unit) => ({ kind: 'system.unit-run', from: { kind: 'system.unit', key: {}, uid: unit }, to: { kind: 'system.run', key: {}, uid: RUN }, producer: 'fixture', producerVersion: '1' })) });
  // The child's own opinion, recorded before any snapshot: only the split edge decides whether it is in one.
  if (!nested) await publishAs(CHILD, [{ kind: 'Item', key: { id: 'item-1' }, values: { text: 'from the child' }, producer: 'fixture', producerVersion: '1' }]);
  return { owner, contract, publish, publishAs, edges };
}

const parentEdge = { kind: 'system.unit-parent', from: { kind: 'system.unit', key: {}, uid: CHILD }, to: { kind: 'system.unit', key: {}, uid: PARENT }, discriminator: CHILD, producer: 'fixture', producerVersion: '1' };

test('a child sealed after a snapshot is not in that snapshot\'s plugin input', async () => {
  const { owner, edges } = await fixture();
  const snapshot = await successfulPluginSnapshot(owner, 'snapshot-run', 'base:Source');
  await pause();
  await edges({ vertices: [], removals: [], edges: [{ ...parentEdge, values: { sealed_at: 1_760_000_000_000 } }] });
  // The same read the plugin turn makes: the edge stands now, and did not when the snapshot was captured.
  expect(await pluginSnapshotVertices(owner, snapshot, 'Item')).toEqual([]);
}, 60_000);

test('an edge withdrawn after a snapshot leaves that snapshot\'s plugin input unchanged', async () => {
  const { owner, edges } = await fixture();
  await edges({ vertices: [], removals: [], edges: [{ ...parentEdge, values: { sealed_at: 1_760_000_000_000 } }] });
  const snapshot = await successfulPluginSnapshot(owner, 'snapshot-run', 'base:Source');
  expect((await pluginSnapshotVertices(owner, snapshot, 'Item')).map((vertex) => vertex.key['id'])).toEqual(['item-1']);
  await pause();
  await edges({ vertices: [], removals: [], edgeRemovals: [{ kind: 'system.unit-parent', from: parentEdge.from, to: parentEdge.to, discriminator: CHILD, producer: 'fixture' }] });
  expect((await pluginSnapshotVertices(owner, snapshot, 'Item')).map((vertex) => vertex.key['id'])).toEqual(['item-1']);
}, 60_000);

// Pre-batch reader retained as an independent regression oracle; only its name and import paths differ.
async function oldPluginSnapshotVertices(owner: DatabaseOwner, snapshot: PluginSnapshot, kind: string): Promise<readonly { readonly key: import('../src/plugin/protocol.js').PluginKeyValues; readonly keyEdges?: Readonly<Record<string, import('../src/plugin/protocol.js').PluginEntityRef>>; readonly values: Readonly<Record<string, unknown>> }[]> {
  return await withSpan('graph.pluginSnapshotVertices', {}, () => owner.transaction('snapshot', async tx => {
    const { readPublishedManifest } = await import('../src/graph/manifest-publication.js');
    const { graphContractOf } = await import('../src/fill/stages/plugin-contract.js');
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
    const nodes = await tx.query<{ id: number; uid: string; key: import('../src/plugin/protocol.js').PluginKeyValues }>('SELECT id,uid::text,key FROM node WHERE uid=ANY($1::uuid[]) ORDER BY uid', [ids]);
    return await Promise.all(nodes.rows.map(async node => {
      const ref = sdkReference(await referenceOf(tx, contract, kind, Number(node.id), new Set(), snapshot));
      const values = Object.fromEntries(selected.filter(assertion => assertion.subject.type === 'vertex' && assertion.subject.uid === node.uid && assertion.property !== '$exists').map(assertion => [assertion.property, assertion.value]));
      return { key: node.key, ...(ref.keyEdges === undefined ? {} : { keyEdges: ref.keyEdges }), values };
    }));
  }));
}


/** Count SqlExecutor calls. The old oracle caches identical SQL+parameters only inside its
 * immutable transaction: its repeated full-kind edge reads need not make 200 backend trips.
 * The production reader has no cache, so its count is also the number of backend statements.
 */
function recordingOwner(owner: DatabaseOwner, cacheRepeated = false): { owner: DatabaseOwner; queries: string[] } {
  const queries: string[] = [];
  return { queries, owner: new Proxy(owner, { get(target, property) {
    if (property !== 'transaction') return Reflect.get(target, property);
    const transaction: DatabaseOwner['transaction'] = (kind, work, options) => target.transaction(kind, tx => {
      const cache = new Map<string, Promise<{ rows: Record<string, unknown>[] }>>();
      const query: SqlExecutor['query'] = async <Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
        queries.push(sql);
        const key = JSON.stringify([sql, values]);
        let answer = cacheRepeated ? cache.get(key) : undefined;
        if (answer === undefined) { answer = tx.query(sql, values); if (cacheRepeated) cache.set(key, answer); }
        return await answer as { rows: Row[] };
      };
      return work(new Proxy(tx, { get(held, key) { return key === 'query' ? query : Reflect.get(held, key); } }));
    }, options);
    return transaction;
  } }) };
}

const snapshotCounts: { size: number; old: number; batch: number }[] = [];
for (const size of [10, 200]) test(`snapshot nested keys preserve golden rows and bounded queries for ${size} vertices`, async () => {
  const { owner, publish, publishAs, edges } = await fixture(true);
  const organisation = { kind: 'Organisation', key: { name: 'org' } };
  const repository = { kind: 'Repository', key: { name: 'repo' }, keyEdges: { organisation } };
  const keyEdges = { repository };
  const item = (id: string, text: string) => ({ kind: 'Item', key: { id }, keyEdges, values: { text }, producer: 'fixture', producerVersion: '1' });
  await publish([{ ...organisation, producer: 'fixture', producerVersion: '1' }, { ...repository, producer: 'fixture', producerVersion: '1' }]);
  // Reverse insertion makes the golden order depend on uids, never fixture or key order.
  await publishAs(CHILD, Array.from({ length: size }, (_, index) => item(`item-${size-index}`, `saved-${size-index}`)));
  await publish([item('other-unit', 'excluded')]);
  await edges({ vertices: [], removals: [], edges: [{ ...parentEdge, values: { sealed_at: 1_760_000_000_000 } }] });
  const snapshot = await successfulPluginSnapshot(owner, 'snapshot-run', 'base:Source');
  await pause();
  await publishAs(CHILD, [item('later', 'excluded'), item('item-1', 'changed after snapshot')]);
  await edges({ vertices: [], removals: [], edgeRemovals: [{ kind: 'system.unit-parent', from: parentEdge.from, to: parentEdge.to, discriminator: CHILD, producer: 'fixture' }] });
  const order = await owner.transaction('snapshot', tx => tx.query<{ id: string }>("SELECT key->>'id' AS id FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='Item' ORDER BY uid"));
  const expected = order.rows.filter(row => row.id !== 'later' && row.id !== 'other-unit').map(row => ({ key: { id: row.id }, keyEdges, values: { text: `saved-${row.id.slice(5)}` } }));
  const old = recordingOwner(owner, true), batch = recordingOwner(owner);
  const oldAnswer = await oldPluginSnapshotVertices(old.owner, snapshot, 'Item');
  const answer = await pluginSnapshotVertices(batch.owner, snapshot, 'Item');
  expect(oldAnswer).toEqual(expected);
  expect(JSON.stringify(answer)).toBe(JSON.stringify(oldAnswer));
  snapshotCounts.push({ size, old: old.queries.length, batch: batch.queries.length });
  console.log('snapshot query counts', JSON.stringify(snapshotCounts.at(-1)));
  expect(batch.queries.length).toBeLessThan(old.queries.length);
  const small = snapshotCounts.find(count => count.size === 10);
  if (size === 200 && small !== undefined) expect(batch.queries.length).toBe(small.batch);
}, 60_000);
