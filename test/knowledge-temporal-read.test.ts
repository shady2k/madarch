/** Small in-repository graph fixtures prove complete publication and scope isolation. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createGraphStore, type GraphStore } from '../src/graph/index.js';
import { treeReadProducer } from '../src/extract/driver/index.js';
import { GraphReader } from '../src/knowledge/graph-read.js';

// Independent byte-for-byte oracle: the baseline driver's inline expression, not the helper under test.
const baseline = (names: readonly string[], history?: string): string => `code.extract.driver/${createHash('sha256').update(`${names.join('\n')}\n${history ?? ''}`).digest('hex').slice(0, 12)}`;
for (const [names, history] of [[[], undefined], [[], 'history'], [['files'], undefined], [['files'], 'history'], [['files', 'code'], 'history'], [['code', 'files'], 'history'], [['résumé', '日本語'], 'история']] as const) {
  test(`tree marker identity preserves baseline bytes: ${JSON.stringify({ names, history })}`, () => {
    expect(treeReadProducer(names.map((name) => ({ name })), history === undefined ? undefined : { name: history })).toBe(baseline(names, history));
  });
}

let owner: DatabaseOwner;
let store: GraphStore;
let scope: string;
let other: string;
const marker = baseline(['files'], 'history');
const lease = { leaseToken: 'fixture', leaseUntil: '2099-01-01T00:00:00Z' };
beforeAll(async () => {
  owner = createPGliteDatabaseOwner({ btreeGist: true });
  await owner.ready;
  store = createGraphStore(owner);
  await store.createSchema();
  scope = await store.newNode(); other = await store.newNode();
  for (const [id, label] of [[scope, 'one'], [other, 'two']] as const) {
    await store.openNode({ nodeId: id, kind: 'code.repository', label, properties: { path: `fixtures/${label}` }, validFrom: '2026-01-01T00:00:00Z', owner: { producer: 'code.extract.driver', scope: id } });
  }
  await store.openNode({ kind: 'code.file', label: 'old.ts', properties: { recordKey: 'code.file:old.ts', path: 'old.ts' }, validFrom: '2026-01-01T00:00:00Z', validTo: '2026-01-02T00:00:00Z', owner: { producer: 'code.extract.files', scope } });
  await store.openNode({ kind: 'code.file', label: 'today.ts', properties: { recordKey: 'code.file:today.ts', path: 'today.ts' }, validFrom: '2026-01-03T00:00:00Z', owner: { producer: 'code.extract.files', scope } });
  await store.openNode({ kind: 'code.file', label: 'other.ts', properties: { recordKey: 'code.file:other.ts', path: 'other.ts' }, validFrom: '2026-01-01T00:00:00Z', owner: { producer: 'code.extract.files', scope: other } });
  // Only the complete final driver marker certifies the first tree.
  await store.openWorkItem({ producer: marker, scope, generation: 2, inputDigest: 'first-tree', ...lease });
  await store.publish({ producer: marker, scope, generation: 2, inputDigest: 'first-tree', leaseToken: lease.leaseToken });
  // A leased but unfinished final marker is not complete.
  await store.openWorkItem({ producer: marker, scope, generation: 4, inputDigest: 'unfinished', ...lease });
  // A completed extractor alone is not the final marker.
  await store.openWorkItem({ producer: 'code.extract.files', scope, generation: 4, inputDigest: 'partial-files', ...lease });
  await store.publish({ producer: 'code.extract.files', scope, generation: 4, inputDigest: 'partial-files', leaseToken: lease.leaseToken });
  // Published odd history/closing records and another extractor set do not certify a tree.
  for (const [producer, generation] of [[marker, 7], [baseline(['different'], 'history'), 6]] as const) {
    await store.openWorkItem({ producer, scope, generation, inputDigest: 'not-a-tree', ...lease });
    await store.publish({ producer, scope, generation, inputDigest: 'not-a-tree', leaseToken: lease.leaseToken });
  }
  await store.openWorkItem({ producer: marker, scope: other, generation: 4, inputDigest: 'other-tree', ...lease });
  await store.publish({ producer: marker, scope: other, generation: 4, inputDigest: 'other-tree', leaseToken: lease.leaseToken });
}, 60_000);
afterAll(async () => { await owner?.close(); }, 60_000);

test('only exact-set complete final publications certify tree coverage, isolated by repository', async () => {
  const graph = new GraphReader(owner, () => '2026-01-04T00:00:00Z');
  expect([...await graph.completedTrees(scope, marker)]).toEqual([1]);
  expect([...await graph.completedTrees(other, marker)]).toEqual([2]);
  expect([...await graph.completedTrees(scope, baseline(['missing'], 'history'))]).toEqual([]);
});

test('a historical graph read cannot show today or another repository at the same date, and an unread interval stays empty', async () => {
  const graph = new GraphReader(owner, () => '2026-01-04T00:00:00Z');
  const first = graph.at('2026-01-01T12:00:00Z', scope);
  expect((await first.list('code.file', { limit: 20 })).rows.map((row) => row.label)).toEqual(['old.ts']);
  expect(await first.find('code.file:today.ts')).toEqual([]);
  expect(await first.find('code.file:other.ts')).toEqual([]);
  expect((await graph.at('2026-01-02T12:00:00Z', scope).list('code.file', { limit: 20 })).total).toBe(0);
  expect((await graph.at('2026-01-01T12:00:00Z', other).list('code.file', { limit: 20 })).rows.map((row) => row.label)).toEqual(['other.ts']);
});
