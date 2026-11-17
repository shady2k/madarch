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

async function fixture(): Promise<Fixture> {
  const manifest = parseKinds({ root: { kinds: {
    'Item': { source: 'graph', key: ['id'], fields: [{ name: 'id', type: 'text', producers: ['fixture'] }, { name: 'text', type: 'text', producers: ['fixture'] }] },
  } }, at: () => 1 }, '/fixture/catalog.yaml', '/fixture');
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
  await publishAs(CHILD, [{ kind: 'Item', key: { id: 'item-1' }, values: { text: 'from the child' }, producer: 'fixture', producerVersion: '1' }]);
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
