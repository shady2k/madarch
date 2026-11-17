/**
 * The focused cases of the ALX-118 review (madarch-64o5.74): the split walk's two directions, a name
 * looked up through an index serving only its current subject, and one subject stated many times
 * answering once. Each case was red on 280259423 and green after the fixes beside it.
 */
import { afterAll, expect, test } from 'bun:test';
import { EMPTY_CONTRACT } from '../src/graph/contract.js';
import { ensureVertex, publishGraphDrafts, writeAssertion } from '../src/graph/write.js';
import { newUid } from '../src/graph/uid.js';
import type { SqlExecutor } from '../src/sql-driver.js';
import { readChain, readRun, readUnit } from '../src/graph/fill-state.js';
import { readSealedChildren, readSplitParents } from '../src/graph/fill-orchestration.js';
import { createTestDatabaseOwner, type TestDatabaseOwner } from './test-database.js';
import { bindTestWriteCapability } from './write-capability-fixture.js';

const NOW = 1_760_000_000_000;
const owners: TestDatabaseOwner[] = [];
afterAll(async () => { for (const owner of owners) await owner.close(); });

interface Written { readonly uid: string; readonly nodeId: string }

async function writeVertex(tx: SqlExecutor, kind: string, values: Readonly<Record<string, unknown>>): Promise<Written> {
  const made = await ensureVertex(tx, EMPTY_CONTRACT, { kind, key: {}, uid: newUid() });
  for (const [property, value] of Object.entries({ $exists: true, ...values })) {
    await writeAssertion(tx, EMPTY_CONTRACT, { sort: 'vertex', kind, subjectId: made.nodeId, property, operation: 'assert', value });
  }
  return made;
}

/** A unit as `unitRecord` reads it: the fields of a planned generation and the run that owns it. */
async function writeUnit(tx: SqlExecutor, run: Written, unitId: string, stage: string, scope: string): Promise<Written> {
  const unit = await writeVertex(tx, 'system.unit', {
    unit_name: unitId, product_name: 'fixture', stage_name: stage, scope, generation: 1, state: 'planned',
    inputs_digest: `digest-${unitId}`, fence: 0, attempt: 0, retries_left: 3, updated_at: NOW + 1,
  });
  await publishGraphDrafts(tx, EMPTY_CONTRACT, {
    vertices: [], removals: [],
    edges: [{ kind: 'system.unit-run', from: { kind: 'system.unit', key: {}, uid: unit.uid }, to: { kind: 'system.run', key: {}, uid: run.uid }, producer: 'fixture', producerVersion: '1' }],
  });
  return unit;
}

async function writeRun(tx: SqlExecutor, runId: string, product = 'fixture'): Promise<Written> {
  return await writeVertex(tx, 'system.run', {
    run_name: runId, product_name: product, state: 'succeeded', planning_epoch: 1, planning_closed: true,
    has_selection: false, created_at: NOW, updated_at: NOW,
  });
}

/** One more statement of `property` on a subject: the stream keeps both, the later one standing. */
async function restate(tx: SqlExecutor, kind: string, subject: string, property: string, value: unknown): Promise<void> {
  await writeAssertion(tx, EMPTY_CONTRACT, { sort: 'vertex', kind, subjectId: subject, property, operation: 'assert', value });
}

async function store(build: (tx: SqlExecutor) => Promise<void>): Promise<TestDatabaseOwner> {
  const owner = await createTestDatabaseOwner();
  owners.push(owner);
  await owner.transaction('write', async (tx) => { await bindTestWriteCapability(tx, EMPTY_CONTRACT); await build(tx); });
  return owner;
}

async function restateAs(owner: TestDatabaseOwner, kind: string, subject: string, property: string, value: unknown): Promise<void> {
  await owner.transaction('write', async (tx) => {
    await bindTestWriteCapability(tx, EMPTY_CONTRACT);
    await restate(tx, kind, subject, property, value);
  });
}

test('a sealed split is read from the child to its parent and from the parent to its children', async () => {
  let left = { uid: '', nodeId: '' }, leaf = { uid: '', nodeId: '' };
  const owner = await store(async (tx) => {
    const run = await writeRun(tx, 'split-run');
    const root = await writeUnit(tx, run, 'modules/root', 'modules', 'the repository');
    left = await writeUnit(tx, run, 'modules/left', 'modules', 'left');
    const right = await writeUnit(tx, run, 'modules/right', 'modules', 'right');
    leaf = await writeUnit(tx, run, 'modules/leaf', 'modules', 'leaf');
    await publishGraphDrafts(tx, EMPTY_CONTRACT, {
      vertices: [], removals: [],
      edges: [
        // `system.unit-parent` is written child -> parent.
        ...[left, right].map((child) => ({ kind: 'system.unit-parent', from: { kind: 'system.unit', key: {}, uid: child.uid }, to: { kind: 'system.unit', key: {}, uid: root.uid }, discriminator: child.uid, values: { sealed_at: NOW + 20 }, producer: 'fixture', producerVersion: '1' })),
        { kind: 'system.unit-parent', from: { kind: 'system.unit', key: {}, uid: leaf.uid }, to: { kind: 'system.unit', key: {}, uid: left.uid }, discriminator: leaf.uid, values: { sealed_at: NOW + 20 }, producer: 'fixture', producerVersion: '1' },
      ],
    });
  });
  const children = async (unitId: string) => (await readSealedChildren(owner, unitId, 1)).map((child) => child.unitId);
  const parents = async (unitId: string) => (await readSplitParents(owner, unitId, 1)).map((parent) => parent.unitId);
  // A parent answers its sealed children; a child answers the split that sealed it. Both directions of one edge.
  expect(await children('modules/root')).toEqual(['modules/left', 'modules/right']);
  expect(await parents('modules/left')).toEqual(['modules/root']);
  expect(await parents('modules/right')).toEqual(['modules/root']);
  expect(await children('modules/left')).toEqual(['modules/leaf']);
  expect(await parents('modules/leaf')).toEqual(['modules/left']);
  // The other direction of each edge is not an answer: a parent has no parent, a child no sealed children.
  expect(await parents('modules/root')).toEqual([]);
  expect(await children('modules/leaf')).toEqual([]);
}, 60_000);

test('a unit name finds only the generation that currently holds it, never a superseded statement', async () => {
  let first = { uid: '', nodeId: '' };
  const owner = await store(async (tx) => {
    const run = await writeRun(tx, 'rename-unit-run');
    first = await writeUnit(tx, run, 'old-unit', 'inventory', 'src');
  });
  await restateAs(owner, 'system.unit', first.nodeId, 'unit_name', 'new-unit');
  // The index still holds the `old-unit` assertion: the read must keep only the current name.
  expect(await readUnit(owner, 'old-unit')).toBeNull();
  expect((await readUnit(owner, 'new-unit'))?.unitId).toBe('new-unit');

  await owner.transaction('write', async (tx) => {
    await bindTestWriteCapability(tx, EMPTY_CONTRACT);
    const run = await writeRun(tx, 'reuse-unit-run');
    await writeUnit(tx, run, 'old-unit', 'other-inventory', 'other-src');
  });
  const reused = await readUnit(owner, 'old-unit');
  expect(reused?.unitId).toBe('old-unit');
  expect(reused?.stageId).toBe('other-inventory');
}, 60_000);

test('a run name finds only the run that currently holds it, never a superseded statement', async () => {
  let first = { uid: '', nodeId: '' };
  const owner = await store(async (tx) => { first = await writeRun(tx, 'old-run'); });
  await restateAs(owner, 'system.run', first.nodeId, 'run_name', 'new-run');
  expect(await readRun(owner, 'old-run')).toBeNull();
  expect((await readRun(owner, 'new-run'))?.runId).toBe('new-run');
  await owner.transaction('write', async (tx) => {
    await bindTestWriteCapability(tx, EMPTY_CONTRACT);
    await writeRun(tx, 'old-run', 'other-product');
  });
  expect((await readRun(owner, 'old-run'))?.product).toBe('other-product');
}, 60_000);

test('a chain name finds only the chain that currently holds it, never a superseded statement', async () => {
  let first = { uid: '', nodeId: '' };
  const owner = await store(async (tx) => {
    first = await writeVertex(tx, 'system.chain', { product_name: 'old-product', state: 'idle', updated_at: NOW });
  });
  await restateAs(owner, 'system.chain', first.nodeId, 'product_name', 'new-product');
  expect(await readChain(owner, 'old-product')).toBeNull();
  expect((await readChain(owner, 'new-product'))?.product).toBe('new-product');
  await owner.transaction('write', async (tx) => {
    await bindTestWriteCapability(tx, EMPTY_CONTRACT);
    await writeVertex(tx, 'system.chain', { product_name: 'old-product', state: 'idle', updated_at: NOW + 1 });
  });
  expect((await readChain(owner, 'old-product'))?.updatedAt).toBe(NOW + 1);
}, 60_000);

test('a subject stated under one name twice answers once, not as two generations', async () => {
  let unit = { uid: '', nodeId: '' };
  const owner = await store(async (tx) => {
    const run = await writeRun(tx, 'repeat-run');
    unit = await writeUnit(tx, run, 'A', 'inventory', 'src');
  });
  // A, then B, then A again: two `unit_name = A` assertions name one subject.
  for (const value of ['B', 'A']) await restateAs(owner, 'system.unit', unit.nodeId, 'unit_name', value);
  const record = await readUnit(owner, 'A');
  expect(record?.unitId).toBe('A');
  expect(record?.scopeKey).toBe('src');
}, 60_000);
