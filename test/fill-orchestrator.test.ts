import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import {readKindAssertions} from '../src/graph/records.js';
/**
 * The fill's orchestrator with fake stages (madarch-tzte.19.5, decision 0027):
 * planning from the registry, admission within the concurrency slots by priority
 * with ageing, queue-authorized attempts, a split with a sealed child set and
 * its limits, a parent's join once its children are published and fresh,
 * staleness from tracked reads including empty results, a cancellation that
 * revokes authority, and one publication per generation with the same digest
 * answering the existing record and a different one refused.
 *
 * Every expectation here is taken from decision 0027 and from the task, never
 * from the module: the states, the effects, the limits and the digest rules are
 * the decision's words. Time is a seam the test moves by hand — no test sleeps —
 * and the only things real are the ones the orchestrator is meant to run on: the
 * process's database owner, the state machines' store and the pg-boss
 * queue on that same owner.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Type } from 'typebox';
import { requestStorePreparation, withStorePreparationOwner } from '../src/product/store-preparation.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { DEFAULT_STAGE_DEFAULTS, type FillStage, type StageExecutionResult, type StageUnitScope } from '../src/fill/stage.js';
import { StageRegistry } from '../src/fill/registry.js';
import type { QueueService } from '../src/fill/queue.js';
import { DEFAULT_QUEUE_SCHEMA } from '../src/adapters/pg-boss-queue.js';
import { DEFAULT_ORCHESTRATOR_LIMITS, admissionOrder, admitUnits, cancelRun, createOrchestrator, driveRun, invalidateStaleUnits, planRun, recoverOrphanedRun, resumeRun, runEvidence, runStatus, schedulerPass, startRun, stopHeartbeat, sweepUnits, workOnce, type FillOrchestrator, type HumanEditGuard, type OrchestratorLimits, type PlanOutcome, type RunControlReader, type UnitGraphReader, type UnitRef } from '../src/fill/orchestrator.js';
import { writeOrchestration, createOrchestratorSchema, readMembership, readProgress, appendProgress, appendProgresses, readUnitReads, readSealedChildren, recordUnitReads, type RunSnapshot } from '../src/graph/fill-orchestration.js';
import { GraphReadRefusal, readText, recordedReadText } from '../src/fill/read-record.js';
import { createFillOrchestratorService } from '../src/fill/orchestrator-host.js';
import { daemonFills } from '../src/product/daemon-fills.js';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { UnitBoundStop } from '../src/fill/unit-bound.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { advanceRun, advanceUnitIn, readChain, readRun, readRunUnits, readUnit, readUnitGraphUidIn, putFillVertexIn, replaceStaleGenerationIn } from '../src/graph/fill-state.js';
import { isFinalRunState, isFinalUnitState } from '../src/fill/fsm.js';
import { createTestDatabaseOwner, type TestDatabaseOwner } from './test-database.js';
import { withAssertionContract } from '../src/graph/system-contract.js';
import { fixtureOperations, writeFixtureFact } from './fill-operation-fixture.js';
import { startupBinding } from '../src/graph/manifest-publication.js';
import { AttemptStaleError, createOperationHost, resolveOperationScope, operationReceipt } from '../src/graph/operation-host.js';
import { EMPTY_CONTRACT } from '../src/graph/contract.js';
import { execFileSync } from 'node:child_process';
import { createStagesFill } from '../src/product/fill-stages.js';
import { prepareTestStore } from './test-database.js';
import { unitJobAttemptSeconds } from '../src/fill/queue-limits.js';

async function pinnedBoundWiring(folder: string, owner: TestDatabaseOwner, bound: string) {
  await mkdir(join(folder, 'madarch'), { recursive: true });
  await writeFile(join(folder, 'madarch/catalog.yaml'), `groups:
  fixture: { en: Fixture, ru: Пример }
  fixture.fixture: { en: Fixture, ru: Пример, parent: fixture }
plugins:
  - id: slow
    version: 1
    path: plugins/slow
    inputs: []
    outputs: []
    closure: [plugin.json]
    bounds:
      ${bound}
${bound.startsWith('minutes:') ? `  - id: quick
    version: 1
    path: plugins/quick
    inputs: []
    outputs: []
    closure: [plugin.json]
    bounds:
      minutes: 10
` : ''}`);
  await mkdir(join(folder, 'plugins/slow'), { recursive: true });
  await writeFile(join(folder, 'plugins/slow/plugin.json'), JSON.stringify({ name: 'slow', version: '1.0.0', entry: 'main.js', runtime: { name: 'bun', version: Bun.version }, produces: [{ kind: 'Unused', fields: '*' }] }));
  await mkdir(join(folder, 'plugins/quick'), { recursive: true });
  await writeFile(join(folder, 'plugins/quick/plugin.json'), JSON.stringify({ name: 'quick', version: '1.0.0', entry: 'main.js', runtime: { name: 'bun', version: Bun.version }, produces: [{ kind: 'Unused', fields: '*', refines: ['slow'] }] }));
  await mkdir(join(folder, 'madarch/kinds/fixture/fixture'), { recursive: true });
  await writeFile(join(folder, 'madarch/kinds/fixture/fixture/Unused.yaml'), 'source: graph\nkey: [id]\nfields:\n  - name: id\n    type: text\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', folder, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'Pinned plugin bound');
  await writeFile(join(folder, 'madarch/catalog.yaml'), 'plugins: broken-working-tree\n');
  return await createStagesFill({ product: folder, database: owner, prepareContract: async contract => { await prepareTestStore(owner, { contract }); } });
}

async function recordUnitRead(database:Parameters<typeof recordUnitReads>[0], input:Parameters<typeof recordUnitReads>[1][number]) {
  return (await recordUnitReads(database,[input]))[0]!;
}

const NOW = 1_700_000_000_000;
const QUEUE = 'fill-units';
const SNAPSHOT: RunSnapshot = { repository: 'example.com/acme/shop', defaultBranch: 'main', commit: 'a1b2c3d4', registryHash: 'sha256:registry' };

/** A clock the test moves by hand: nothing in the orchestrator reads the real one. */
function testClock(start = NOW): { now(): number; advance(ms: number): void; set(at: number): void } {
  let current = start;
  return { now: () => current, advance: (ms: number) => { current += ms; }, set: (at: number) => { current = at; } };
}

/** The fake graph the units read: each query answers the rows the test put there, and nothing else. */
interface FakeGraph {
  rows: Map<string, readonly unknown[]>;
  reader: UnitGraphReader;
}

function fakeGraph(entries: Readonly<Record<string, readonly unknown[]>> = {}): FakeGraph {
  const rows = new Map<string, readonly unknown[]>(Object.entries(entries));
  return { rows, reader: { query: async (text: string) => rows.get(text) ?? [] } };
}

/** One world: the process's owner, the queue, the registry and the orchestrator over them. */
interface World {
  readonly owner: TestDatabaseOwner;
  readonly queue: QueueService;
  readonly registry: StageRegistry;
  readonly orchestrator: FillOrchestrator;
  readonly graph: FakeGraph;
  readonly clock: ReturnType<typeof testClock>;
  readonly commits: { value: string };
  close(): Promise<void>;
}

async function openWorld(options: {
  registry: StageRegistry;
  graph?: FakeGraph;
  limits?: Partial<OrchestratorLimits>;
  guard?: HumanEditGuard;
  product?: string;
  commit?: string;
  configuration?: () => { ok: true; file: string; stages: Record<string, unknown>; lines: Record<string, number> } | undefined;
  control?: RunControlReader;
  /** Told whether each graph read was made with a transaction of the owner. */
  onGraph?: (withTransaction: boolean) => void;
  /** The named inputs a unit's facts stand on; the run's commit unless the test names its own. */
  inputs?: (ref: UnitRef) => Readonly<Record<string, string | Uint8Array>>;
  /** An owner the test lends, wrapped to count the transactions a pass opens; the test closes it. */
  owner?: TestDatabaseOwner;
  /** The clock the run reads; a test that reopens a world over one owner moves one clock across both. */
  clock?: ReturnType<typeof testClock>;
  sink?: import('../src/fill/orchestrator.js').ProgressSink;
  /** Where the orchestrator's own lines go, as the host would hear them. */
  readonly log?: (line: string) => void;
  queueFactory?: (queue: QueueService) => QueueService;
}): Promise<World> {
  const lent = options.owner !== undefined;
  const owner = options.owner ?? await createTestDatabaseOwner();

  await createOrchestratorSchema(owner);
  const baseQueue = await createPgBossQueue({ owner, supervise: false });
  const queue = options.queueFactory?.(baseQueue) ?? baseQueue;
  const limits = { ...DEFAULT_ORCHESTRATOR_LIMITS, ...options.limits };
  await queue.declare({
    name: QUEUE,
    leaseSeconds: limits.attemptSeconds,
    heartbeatSeconds: Math.max(10, limits.heartbeatSeconds),
    retries: 0,
    retryDelaySeconds: 0,
    retryBackoff: false,
    singletons: true,
  });
  const graph = options.graph ?? fakeGraph();
  const clock = options.clock ?? testClock();
  const commits = { value: options.commit ?? 'a1b2c3d4' };
  const orchestrator = createOrchestrator({
    database: owner,
    registry: options.registry,
    queue,
    queueName: QUEUE,
    product: options.product ?? 'fixture-product',
    configuration: options.configuration ?? (() => undefined),
    snapshot: () => ({ ...SNAPSHOT, commit: commits.value }),
    graph: (_ref, transaction) => {
      options.onGraph?.(transaction !== undefined);
      return graph.reader;
    },
    inputs: options.inputs ?? (() => ({ commit: commits.value })),
    operations: fixtureOperations(owner),
    clock: clock.now,
    ...(options.sink === undefined ? {} : { sink: options.sink }),
    ...(options.log === undefined ? {} : { log: options.log }),
    limits,
    ...(options.guard === undefined ? {} : { guard: options.guard }),
    ...(options.control === undefined ? {} : { control: options.control }),
  });
  return {
    owner, queue, registry: options.registry, orchestrator, graph, clock, commits,
    close: async () => { stopHeartbeat(orchestrator); await queue.stop(); if (!lent) await owner.close(); },
  };
}

/** The services the cases opened: one stopped at its deadline leaves no client or store of its own behind. */
const services: ReturnType<typeof createFillOrchestratorService>[] = [];
/** The owners a case lent to a service: teardown closes them when the case never returns (madarch-64o5.74). */
const lentOwners: TestDatabaseOwner[] = [];
/** The service a case opens, tracked so the file's teardown stops it even when the case never returns (madarch-64o5.74). */
function trackedService(options: Parameters<typeof createFillOrchestratorService>[0]): ReturnType<typeof createFillOrchestratorService> {
  const opened = createFillOrchestratorService(options);
  services.push(opened);
  return opened;
}

const worlds: World[] = [];
afterEach(async () => {
  while (worlds.length > 0) await worlds.pop()!.close();
  // The queue and the owner a service opened stop with it; a case stopped at its
  // deadline runs no `finally`, so the file's teardown is the only stop it gets.
  while (services.length > 0) await services.pop()!.stop().catch(() => undefined);
  while (lentOwners.length > 0) await lentOwners.pop()!.close().catch(() => undefined);
});

async function world(options: Parameters<typeof openWorld>[0]): Promise<World> {
  const opened = await openWorld(options);
  worlds.push(opened);
  return opened;
}

/** A fake stage: the declaration under test, everything else a placeholder. */
function fakeStage(id: string, declaration: Partial<FillStage> = {}): FillStage {
  return {
    id,
    version: 1,
    consumes: { required: [], optional: [] },
    produces: [],
    configSchema: Type.Object({}),
    defaults: DEFAULT_STAGE_DEFAULTS,
    plan: () => ({ units: [], coverage: 'planned' }),
    execute: () => ({ outcome: 'draft' }),
    ...declaration,
  };
}

/** A stage that plans named units and commits one graph operation each time it runs. */
function writingStage(id: string, options: {
  units: readonly string[];
  consumes?: readonly string[];
  produces?: readonly string[];
  concurrency?: number;
  coverage?: 'planned' | 'nothing-found';
  beforeWrite?: () => void;
}): FillStage {
  return fakeStage(id, {
    produces: (options.produces ?? []).map((kind) => ({ kind, schemaVersion: 1, scope: 'repository' })),
    consumes: { required: (options.consumes ?? []).map((capability) => ({ capability, scope: 'repository' as const })), optional: [] },
    defaults: { ...DEFAULT_STAGE_DEFAULTS, concurrency: options.concurrency ?? 1 },
    plan: (): { units: readonly StageUnitScope[]; coverage: 'planned' | 'nothing-found' } => ({
      units: options.units.map((scope) => ({ id: scope, scope })),
      coverage: options.coverage ?? 'planned',
    }),
    execute: async (unit, context): Promise<StageExecutionResult> => {
      options.beforeWrite?.();
      await writeFixtureFact(context, `${unit.scope}:1`, { kind: 'module-facts', scope: unit.scope });
      return { outcome: 'draft' };
    },
  });
}

/**
 * A stage that splits the unit it was planned for on its first attempt and
 * drafts on the attempt after its join; a child of that split never splits
 * again, unless the test asks it to (`splitEveryUnit`).
 */
function splittingStage(options: { children?: readonly StageUnitScope[]; splitEveryUnit?: boolean } = {}): { stage: FillStage; attempts: string[] } {
  const attempts: string[] = [];
  const children = options.children ?? [{ id: 'left', scope: 'left' }, { id: 'right', scope: 'right' }];
  // A stage that splits every unit names children of its own for each of them, so a nested split never
  // names a unit that already stands on the split's own path.
  const childrenFor = (unitId: string): readonly StageUnitScope[] => (options.splitEveryUnit === true
    ? [{ id: `${unitId}-a`, scope: `${unitId} half a` }, { id: `${unitId}-b`, scope: `${unitId} half b` }]
    : children);
  const stage = fakeStage('modules', {
    produces: [{ kind: 'module-facts', schemaVersion: 1, scope: 'cluster' }],
    defaults: { ...DEFAULT_STAGE_DEFAULTS, concurrency: 2 },
    plan: () => ({ units: [{ id: 'root', scope: 'the repository' }], coverage: 'planned' }),
    execute: async (unit, context): Promise<StageExecutionResult> => {
      attempts.push(unit.id);
      const first = attempts.filter((id) => id === unit.id).length === 1;
      if ((options.splitEveryUnit === true || unit.id === 'root') && first) return { outcome: 'split', children: childrenFor(unit.id) };
      await writeFixtureFact(context, `${unit.scope}:1`, { kind: 'module-facts' });
      return { outcome: 'draft' };
    },
  });
  return { stage, attempts };
}

/** The registry decision 0027's own example needs: a producer and two consumers of its facts. */
function basicRegistry(): StageRegistry {
  return new StageRegistry()
    .register(writingStage('snapshot', { units: ['src', 'docs'], produces: ['file-facts'], concurrency: 2 }))
    .register(writingStage('modules', { units: ['core'], consumes: ['file-facts'], produces: ['module-facts'], concurrency: 1 }))
    .register(writingStage('overview', { units: ['product'], consumes: ['module-facts'], produces: ['product-overview'], concurrency: 1 }));
}

/** Starts and plans one run in the world, answering what the plan gave. */
async function planWorld(options: Parameters<typeof openWorld>[0], runId = 'run-1'): Promise<{ world: World; runId: string; plan: PlanOutcome }> {
  const opened = await world(options);
  const started = await startRun(opened.orchestrator, { runId });
  expect(started.ok).toBe(true);
  const plan = await planRun(opened.orchestrator, { runId });
  return { world: opened, runId, plan };
}

/** The same, expecting the plan to have held. */
async function plannedWorld(options: Parameters<typeof openWorld>[0], runId = 'run-1'): Promise<{ world: World; runId: string; plan: Extract<PlanOutcome, { outcome: 'planned' }> }> {
  const { world: opened, plan } = await planWorld(options, runId);
  expect(plan.outcome === 'refused' ? plan.reason : plan.outcome).toBe('planned');
  if (plan.outcome !== 'planned') throw new Error('the plan was expected to hold');
  return { world: opened, runId, plan };
}

test('concurrent tracked reads and progress keep their durable sequence allocation', async () => {
  const { world: opened, runId } = await plannedWorld({ registry: new StageRegistry().register(writingStage('source', { units: ['one'] })) });
  const unit = (await readRunUnits(opened.owner, runId))[0]!;
  const before = await readProgress(opened.owner, runId);
  const reads = await Promise.all(['a', 'b', 'c'].map(async (query) => await recordUnitRead(opened.owner, {
    unitId: unit.unitId, generation: unit.generation, query, rows: [query], at: NOW,
  })));
  expect(reads.map((read) => read.seq).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  const repeated = await recordUnitRead(opened.owner, { unitId: unit.unitId, generation: unit.generation, query: 'a', rows: ['changed'], at: NOW + 1 });
  expect(repeated.seq).toBe(4);
  const held = await readUnitReads(opened.owner, unit.unitId, unit.generation);
  expect(held).toHaveLength(3);
  expect(held.find((read) => read.query === 'a')?.membership).toBe(readMembership(['changed']));
  const batched = await recordUnitReads(opened.owner, ['a', 'b', 'a'].map((query, index) => ({
    unitId: unit.unitId, generation: unit.generation, query, rows: [index], at: NOW + 2,
  })));
  expect(batched.map((read) => read.seq)).toEqual([5, 6, 7]);
  const afterBatch = await readUnitReads(opened.owner, unit.unitId, unit.generation);
  expect(afterBatch).toHaveLength(3);
  expect(afterBatch.find((read) => read.query === 'a')?.membership).toBe(readMembership([2]));
  expect(afterBatch.find((read) => read.query === 'a')?.seq).toBe(7);
  const duplicates = await recordUnitReads(opened.owner, [3, 4, 5].map((value) => ({
    unitId: unit.unitId, generation: unit.generation, query: 'a', rows: [value], at: NOW + 3,
  })));
  expect(duplicates.map((read) => read.seq)).toEqual([8, 9, 10]);
  const afterDuplicates = await readUnitReads(opened.owner, unit.unitId, unit.generation);
  expect(afterDuplicates).toHaveLength(3);
  expect(afterDuplicates.find((read) => read.query === 'a')?.membership).toBe(readMembership([5]));
  expect(afterDuplicates.find((read) => read.query === 'a')?.seq).toBe(10);
  const nextRead = await recordUnitRead(opened.owner, { unitId: unit.unitId, generation: unit.generation, query: 'd', rows: ['d'], at: NOW + 4 });
  expect(nextRead.seq).toBe(11);
  const readBatches = await Promise.all([['e', 'f'], ['g', 'h', 'i']].map(async (queries) => await recordUnitReads(opened.owner, queries.map((query) => ({
    unitId: unit.unitId, generation: unit.generation, query, rows: [query], at: NOW + 5,
  })))));
  for (const batch of readBatches) expect(batch.map((read) => read.seq)).toEqual(batch.map((_read, index) => batch[0]!.seq + index));
  expect(readBatches.flat().map((read) => read.seq).sort((a, b) => a - b)).toEqual([12, 13, 14, 15, 16]);
  const persistedReads = await readUnitReads(opened.owner, unit.unitId, unit.generation);
  for (const read of readBatches.flat()) expect(persistedReads.find((held) => held.query === read.query)).toEqual(read);
  const events = await Promise.all(['a', 'b', 'c'].map(async (summary) => await appendProgress(opened.owner, {
    runId, at: NOW, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-read', summary,
  })));
  const last = before.at(-1)?.seq ?? 0;
  expect(events.map((event) => event.seq).sort((a, b) => a - b)).toEqual([last + 1, last + 2, last + 3]);
  expect((await readProgress(opened.owner, runId)).slice(-3).map((event) => event.seq)).toEqual([last + 1, last + 2, last + 3]);
  const eventBatch = await appendProgresses(opened.owner, ['batch-a', 'batch-b', 'batch-a'].map((summary) => ({
    runId, at: NOW + 2, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-read' as const, summary,
  })));
  expect(eventBatch.map((event) => event.seq)).toEqual([last + 4, last + 5, last + 6]);
  expect((await readProgress(opened.owner, runId)).slice(-3)).toEqual([...eventBatch]);
  const eventBatches = await Promise.all([['left-a', 'left-b'], ['right-a', 'right-b', 'right-c']].map(async (summaries) => await appendProgresses(opened.owner, summaries.map((summary) => ({
    runId, at: NOW + 3, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-read' as const, summary,
  })))));
  for (const batch of eventBatches) expect(batch.map((event) => event.seq)).toEqual(batch.map((_event, index) => batch[0]!.seq + index));
  const allocatedEvents = eventBatches.flat().sort((a, b) => a.seq - b.seq);
  expect(allocatedEvents.map((event) => event.seq)).toEqual([last + 7, last + 8, last + 9, last + 10, last + 11]);
  expect((await readProgress(opened.owner, runId)).slice(-5)).toEqual(allocatedEvents);
  const freshDuplicates = await recordUnitReads(opened.owner, [1, 2].map((value) => ({
    unitId: unit.unitId, generation: unit.generation, query: 'new-in-batch', rows: [value], at: NOW + 6,
  })));
  expect(freshDuplicates.map((read) => read.seq)).toEqual([17, 18]);
  const freshRetained = (await readUnitReads(opened.owner, unit.unitId, unit.generation)).filter((read) => read.query === 'new-in-batch');
  expect(freshRetained).toEqual([freshDuplicates[1]!]);
  expect(freshRetained[0]!.membership).toBe(readMembership([2]));
});

test('a failed progress batch rolls back its events without rolling back committed tracked reads', async () => {
  const { world: opened, runId } = await plannedWorld({ registry: new StageRegistry().register(writingStage('source', { units: ['one'] })) });
  const unit = (await readRunUnits(opened.owner, runId))[0]!;
  const before = await readProgress(opened.owner, runId);
  const reads = ['a', 'b'].map((query) => ({ unitId: unit.unitId, generation: unit.generation, query, rows: [query], at: NOW }));
  await recordUnitReads(opened.owner, reads);
  let inserts = 0;
  const failing: TestDatabaseOwner = {
    ...opened.owner,
    transaction: async (kind, work) => await opened.owner.transaction(kind, async (transaction) => await work({
      query: async <Row extends object = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
        const result = await transaction.query<Row>(sql, values);
        if (sql.startsWith('INSERT INTO assertion(') && values?.[1] === 'summary' && ++inserts === 1) throw new Error('injected progress batch failure');
        return result;
      },
    })),
  };
  await expect(appendProgresses(failing, reads.map((read) => ({
    runId, at: NOW, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-read' as const, summary: read.query,
  })))).rejects.toThrow('injected progress batch failure');
  expect(inserts).toBe(1);
  expect((await readUnitReads(opened.owner, unit.unitId, unit.generation)).map((read) => ({ query: read.query, membership: read.membership, seq: read.seq }))).toEqual([
    { query: 'a', membership: readMembership(['a']), seq: 1 },
    { query: 'b', membership: readMembership(['b']), seq: 2 },
  ]);
  expect(await readProgress(opened.owner, runId)).toEqual(before);
  const next = await appendProgress(opened.owner, { runId, at: NOW + 1, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-read', summary: 'after rollback' });
  expect(next.seq).toBe((before.at(-1)?.seq ?? 0) + 1);
});

describe('the membership digest a tracked read stands on', () => {
  test('holds what a read can answer, and is the same for the same rows in another order', () => {
    // A timestamp is the case that matters: the owner hands these back as `Date` objects, and a digest
    // that reads one as `{}` would call two different instants one membership.
    const early = readMembership([{ path: 'src/index.ts', seen: new Date(NOW) }]);
    const late = readMembership([{ path: 'src/index.ts', seen: new Date(NOW + 1) }]);
    expect(early).not.toBe(late);
    expect(readMembership([{ seen: new Date(NOW), path: 'src/index.ts' }])).toBe(early);
    // The membership is the set of rows: a graph answering the same rows in another order has not moved.
    expect(readMembership([{ a: 1 }, { a: 2 }])).toBe(readMembership([{ a: 2 }, { a: 1 }]));
    // An empty answer is a value of its own, and a row added moves it.
    expect(readMembership([])).not.toBe(readMembership([{ a: 1 }]));
    // A value no digest can hold is refused by name rather than collapsed into another value's digest.
    expect(() => readMembership([{ handler: () => undefined }])).toThrow(/a read answered function at row\.handler/);
  });

  test('is the membership an earlier build recorded, so this change stales no unit that already published', () => {
    // madarch-tzte.21.11 changed how often a row is serialized into its digest, not what the digest says:
    // the value below is the one the implementation that serialized both sides of every comparison
    // answered for these rows (taken from it, before the change), and a store that recorded a membership
    // under it still agrees with the one this computes — otherwise every unit of every product that ran
    // before the change would be rechecked as a read that moved.
    const rows = [
      { id: 'symbol:a', value: { repository: 'madarch', path: 'src/a.ts', name: 'a', kind: 'function' } },
      { id: 'file:a', value: { repository: 'madarch', path: 'src/a.ts', roles: ['source'] } },
      { id: 'occurrence:1', value: { repository: 'madarch', path: 'src/a.ts', symbol: 'symbol:a', range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 3 } } },
    ];
    expect(readMembership(rows)).toBe('91692da8cc2cfbbc9f106d51552182e8747de6e7b261a98ee741432de760e0c4');
    expect(readMembership([...rows].reverse())).toBe('91692da8cc2cfbbc9f106d51552182e8747de6e7b261a98ee741432de760e0c4');
  });

  test('leaves out the fields a stage measures rather than observes, so a re-ranking makes no reader stale', () => {
    // Stage 5 measures a file's, a symbol's and a module's importance over the whole graph and writes it
    // onto the fact stages 1, 3 and 4 published (madarch-tzte.21.7, FACT_MEASURED_FIELDS). A read that
    // answered that fact was about the node and not about the number a later run gave it, so the rank
    // moving is not the read moving — otherwise every re-ranking would make every unit that read a file
    // out of date, stage 5's own units included.
    const ranked = readMembership([{ id: 'file:a', value: { repository: 'p', path: 'src/a.ts', roles: ['source'], importance: 0.5 } }]);
    const unranked = readMembership([{ id: 'file:a', value: { repository: 'p', path: 'src/a.ts', roles: ['source'] } }]);
    const reranked = readMembership([{ id: 'file:a', value: { repository: 'p', path: 'src/a.ts', roles: ['source'], importance: 0.25 } }]);
    expect(ranked).toBe(unranked);
    expect(reranked).toBe(unranked);
    // Everything the read is about still moves it: another path, another role, another id.
    expect(readMembership([{ id: 'file:a', value: { repository: 'p', path: 'src/b.ts', roles: ['source'] } }])).not.toBe(unranked);
    expect(readMembership([{ id: 'file:b', value: { repository: 'p', path: 'src/a.ts', roles: ['source'] } }])).not.toBe(unranked);
    // A module's member count is not a rank: it moves when the tree moves, which is what a read of that
    // module is about, so a module that grew still makes its readers stale.
    const module3 = readMembership([{ id: 'module:m', value: { repository: 'p', name: 'cart', seed: 'package', members: 3, importance: 0.4 } }]);
    const module5 = readMembership([{ id: 'module:m', value: { repository: 'p', name: 'cart', seed: 'package', members: 5, importance: 0.4 } }]);
    const moduleReranked = readMembership([{ id: 'module:m', value: { repository: 'p', name: 'cart', seed: 'package', members: 3, importance: 0.1 } }]);
    expect(module5).not.toBe(module3);
    expect(moduleReranked).toBe(module3);
  });
});

describe('planning from the registry', () => {
  
  test('a required capability no enabled stage produces blocks the run with its starvation path', async () => {
    const registry = new StageRegistry().register(writingStage('modules', { units: ['core'], consumes: ['file-facts'] }));
    const { world: opened, runId, plan } = await planWorld({ registry });
    expect(plan.outcome).toBe('blocked');
    const run = await readRun(opened.owner, runId);
    expect(run?.state).toBe('blocked');
    const events = await readProgress(opened.owner, runId);
    expect(events.at(-1)?.kind).toBe('run-blocked');
    expect(events.at(-1)?.summary).toContain('modules → file-facts → no producer');
    expect(await readRunUnits(opened.owner, runId)).toEqual([]);
  });

  test('a producer the product disabled is named as the path, and nothing is planned', async () => {
    const registry = new StageRegistry()
      .register(writingStage('snapshot', { units: ['src'], produces: ['file-facts'] }))
      .register(writingStage('modules', { units: ['core'], consumes: ['file-facts'] }));
    const { world: opened, runId } = await planWorld({
      registry,
      configuration: () => ({ ok: true, file: '/product/workspace.yaml', stages: { snapshot: { enabled: false } }, lines: { snapshot: 4 } }),
    });
    const run = await readRun(opened.owner, runId);
    expect(run?.state).toBe('blocked');
    const events = await readProgress(opened.owner, runId);
    expect(events.at(-1)?.summary).toContain('modules → file-facts → snapshot (disabled)');
  });

  test('a stage that found a producer\'s inputs but nothing in them is reported, and the run still plans', async () => {
    const registry = new StageRegistry()
      .register(writingStage('snapshot', { units: ['src'], produces: ['file-facts'] }))
      .register(writingStage('modules', { units: [], consumes: ['file-facts'], produces: ['module-facts'], coverage: 'nothing-found' }));
    const opened = await world({ registry });
    await startRun(opened.orchestrator, { runId: 'run-1' });
    const planned = await planRun(opened.orchestrator, { runId: 'run-1' });
    expect(planned.outcome).toBe('planned');
    if (planned.outcome !== 'planned') return;
    // Decision 0027 distinguishes "no producer" from "producer found nothing": the second is a plan of no
    // units, reported, never a starvation.
    expect(planned.foundNothing).toEqual(['modules']);
    expect((await readProgress(opened.owner, 'run-1')).map((event) => event.kind)).toContain('stage-found-nothing');
    expect(planned.graph.order).toEqual(['snapshot', 'modules']);
    expect(planned.units.map((unit) => unit.unitId)).toEqual(['snapshot/src']);
  });
});

describe('admission within the slots, by priority', () => {
  test('waiting dependencies and full producer groups do not open one admission transaction per candidate', async () => {
    const producers = ['root', ...Array.from({ length: 20 }, (_, index) => `producer-${index}`)];
    const consumers = Array.from({ length: 20 }, (_, index) => `consumer-${index}`);
    const stage = writingStage('graph', { units: [...producers, ...consumers], concurrency: 100 });
    stage.unitScheduling = (id) => ({
      after: consumers.includes(id) ? ['root'] : [],
      group: consumers.includes(id) ? 'consumers' : 'producers', concurrency: 1,
    });
    const lent = await createTestDatabaseOwner();
    let transactions = 0;
    const counting = Object.create(lent) as TestDatabaseOwner;
    counting.transaction = async (kind, work) => { transactions += 1; return await lent.transaction(kind, work); };
    try {
      const { world: opened, runId } = await plannedWorld({ registry: new StageRegistry().register(stage), limits: { maxInFlight: 100 }, owner: counting });
      let before = transactions;
      const first = await admitUnits(opened.orchestrator, { runId });
      expect(first.admitted.map((unit) => unit.unitId)).toEqual(['graph/root']);
      expect(first.waitingForSlot).toHaveLength(40);
      expect(transactions - before).toBeLessThanOrEqual(12);
      before = transactions;
      expect((await admitUnits(opened.orchestrator, { runId })).admittedNow).toBe(0);
      expect(transactions - before).toBeLessThanOrEqual(12);
      expect((await workOnce(opened.orchestrator, { worker: 'worker-1' })).result).toBe('published');
      const next = await admitUnits(opened.orchestrator, { runId });
      expect(next.admitted.map((unit) => unit.unitId)).toEqual(['graph/producer-0', 'graph/consumer-0']);
    } finally {
      await lent.close();
    }
  });

  test('a pass admits up to the run\'s slots and walks no further, whatever the plan holds', async () => {
    // Sixty units, one slot: the pass admits the first and stops, instead of opening a transaction for
    // every candidate that finds no slot. A run of a few thousand units measured 27 s of a 27.6 s unit
    // in exactly those transactions (madarch-tzte.21.8's walk over a madarch checkout).
    const units = Array.from({ length: 60 }, (_unused, index) => `unit-${String(index).padStart(2, '0')}`);
    const lent = await createTestDatabaseOwner();
    let transactions = 0;
    const counting = Object.create(lent) as TestDatabaseOwner;
    counting.transaction = async (kind, work) => { transactions += 1; return await lent.transaction(kind, work); };
    try {
      const { world: opened, runId } = await plannedWorld({ registry: new StageRegistry().register(writingStage('graph', { units })), limits: { maxInFlight: 1 }, owner: counting });
      const before = transactions;
      const admission = await admitUnits(opened.orchestrator, { runId });
      const spent = transactions - before;
      expect(admission.admittedNow).toBe(1);
      expect(admission.admitted[0]?.unitId).toBe(`graph/${units[0]}`);
      expect(admission.waitingForSlot).toHaveLength(units.length - 1);
      // One admission, the run's own row read, and the graph it resolves: a few, never one per unit.
      expect(spent).toBeLessThanOrEqual(12);
    } finally {
      await lent.close();
    }
  });

  test('takes the run\'s slots and each stage\'s concurrency, in the order the plan named the units', async () => {
    const registry = new StageRegistry().register(writingStage('snapshot', { units: ['a', 'b', 'c'], produces: ['file-facts'], concurrency: 2 }));
    const { world: opened, runId } = await plannedWorld({ registry, limits: { maxInFlight: 2 } });
    const first = await admitUnits(opened.orchestrator, { runId });
    expect(first.admitted.map((unit) => unit.unitId)).toEqual(['snapshot/a', 'snapshot/b']);
    // The queue's priority follows the admission order: the first candidate carries the highest.
    expect(first.admitted.map((unit) => unit.priority)).toEqual([3, 2]);
    expect(first.waitingForSlot).toEqual(['snapshot/c']);
    expect((await readRunUnits(opened.owner, runId)).map((unit) => unit.state)).toEqual(['ready', 'ready', 'planned']);

    // One unit finishes and its slot is taken by the one that waited.
    const worked = await workOnce(opened.orchestrator, { worker: 'worker-1' });
    expect(worked.result).toBe('published');
    const second = await admitUnits(opened.orchestrator, { runId });
    expect(second.admitted.map((unit) => unit.unitId)).toEqual(['snapshot/c']);
  });

  test('a unit that waited climbs one place per ageing step, never past its stage\'s own order', () => {
    const units = [
      { unitId: 'first', stagePosition: 0, planPosition: 0, plannedAt: NOW },
      { unitId: 'second', stagePosition: 0, planPosition: 1, plannedAt: NOW },
      { unitId: 'late-stage', stagePosition: 1, planPosition: 0, plannedAt: NOW - 100 * 60_000 },
    ];
    // The plan's own order decides while the units have waited the same time.
    expect(admissionOrder(units, { at: NOW, ageingStepMs: 60_000 }).map((unit) => unit.unitId)).toEqual(['first', 'second', 'late-stage']);
    // One ageing step lifts the second one place: to the first's own place, where the unit id in code
    // point order decides; the second step lifts it past.
    const oneStep = units.map((unit) => (unit.unitId === 'second' ? { ...unit, plannedAt: NOW - 60_000 } : unit));
    expect(admissionOrder(oneStep, { at: NOW, ageingStepMs: 60_000 }).map((unit) => unit.unitId)).toEqual(['first', 'second', 'late-stage']);
    const twoSteps = units.map((unit) => (unit.unitId === 'second' ? { ...unit, plannedAt: NOW - 120_000 } : unit));
    expect(admissionOrder(twoSteps, { at: NOW, ageingStepMs: 60_000 }).map((unit) => unit.unitId)).toEqual(['second', 'first', 'late-stage']);
    // A later stage never overtakes an earlier one, however long its own unit has waited: the stage
    // graph is the fill's own order, from the general to the particular.
    expect(admissionOrder(units, { at: NOW + 100 * 60_000, ageingStepMs: 60_000 }).map((unit) => unit.unitId)).toEqual(['first', 'second', 'late-stage']);
    expect(admissionOrder([units[0]!, units[2]!], { at: NOW, ageingStepMs: 60_000 }).map((unit) => unit.unitId)).toEqual(['first', 'late-stage']);
  });

  test('an admission and its enqueue are one transaction: the job carries the unit and its generation', async () => {
    const registry = new StageRegistry().register(writingStage('snapshot', { units: ['src'], produces: ['file-facts'] }));
    const { world: opened, runId } = await plannedWorld({ registry });
    await admitUnits(opened.orchestrator, { runId });
    const claimed = await opened.queue.claim<{ unitId: string; generation: number }>({ queue: QUEUE, limit: 1 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.data).toEqual({ unitId: 'snapshot/src', generation: 1 });
  });
});

describe('one attempt: lease, run, immediate operation, completion', () => {
  
  
  
  test('a run whose unit cannot be covered and publishes nothing fails, with the reason on the record', async () => {
    const registry = new StageRegistry().register(fakeStage('snapshot', {
      produces: [{ kind: 'file-facts', schemaVersion: 1, scope: 'repository' }],
      defaults: { ...DEFAULT_STAGE_DEFAULTS, concurrency: 1 },
      plan: () => ({ units: [{ id: 'src', scope: 'src' }], coverage: 'planned' }),
      execute: () => ({ outcome: 'blocked', reason: 'the repository has no readable manifest' }),
    }));
    const { world: opened, runId } = await plannedWorld({ registry });
    await admitUnits(opened.orchestrator, { runId });
    const blocked = await workOnce(opened.orchestrator, { worker: 'worker-1' });
    expect(blocked.result).toBe('blocked');
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('blocked');
    // A blocked unit is not runnable, in flight or waiting, so the run may settle: its coverage is unmet.
    const evidence = await runEvidence(opened.orchestrator, runId);
    expect(evidence).toEqual({ runnable: 0, inFlight: 0, waiting: 0, coverageMet: false });
    const settlement = await schedulerPass(opened.orchestrator, { runId });
    expect(settlement.run.state).toBe('failed');
    expect((await readChain(opened.owner, 'fixture-product'))?.state).toBe('quiescent');
  });

  });

describe('a split and its join', () => {
  
  test('a parent joins only while every child it sealed is still fresh', async () => {
    const query = 'SELECT module FROM modules';
    const attempts: string[] = [];
    const stage = fakeStage('modules', {
      produces: [{ kind: 'module-facts', schemaVersion: 1, scope: 'cluster' }],
      defaults: { ...DEFAULT_STAGE_DEFAULTS, concurrency: 2 },
      plan: () => ({ units: [{ id: 'root', scope: 'the repository' }], coverage: 'planned' }),
      execute: async (unit, context): Promise<StageExecutionResult> => {
        attempts.push(unit.id);
        // Every unit reads the graph, so a child that published stands on a read the run can recheck.
        await context.graph.query(query);
        if (unit.id === 'root' && attempts.filter((id) => id === 'root').length === 1) {
          return { outcome: 'split', children: [{ id: 'left', scope: 'left' }, { id: 'right', scope: 'right' }] };
        }
        await writeFixtureFact(context, `${unit.scope}:1`, { kind: 'module-facts' });
        return { outcome: 'draft' };
      },
    });
    const graph = fakeGraph({ [query]: [{ module: 'core' }] });
    const registry = new StageRegistry().register(stage);
    const { world: opened, runId } = await plannedWorld({ registry, graph });
    await admitUnits(opened.orchestrator, { runId });
    expect((await workOnce(opened.orchestrator, { worker: 'worker-1' })).result).toBe('split');
    for (const worker of ['worker-2', 'worker-3']) {
      await admitUnits(opened.orchestrator, { runId });
      expect((await workOnce(opened.orchestrator, { worker })).result).toBe('published');
    }
    const sealedStates: string[] = [];
    for (const child of await readSealedChildren(opened.owner, 'modules/root', 1)) {
      sealedStates.push(`${child.unitId}:${(await readUnit(opened.owner, child.unitId))?.state}`);
    }
    expect(sealedStates).toEqual(['modules/left:published', 'modules/right:published']);

    // One child's read moved after it published: the parent does not join on work that is no longer fresh.
    graph.rows.set(query, [{ module: 'core' }, { module: 'wiki' }]);
    const withheld = await sweepUnits(opened.orchestrator, { runId });
    expect(withheld.swept).toEqual([]);
    expect((await readUnit(opened.owner, 'modules/root'))?.state).toBe('waiting_children');

    // The graph answers what the children recorded again: the join happens, and the parent publishes.
    graph.rows.set(query, [{ module: 'core' }]);
    const joined = await sweepUnits(opened.orchestrator, { runId });
    expect(joined.swept.map((unit) => `${unit.unitId}:${unit.outcome}`)).toEqual(['modules/root:join-enqueued']);
    expect((await workOnce(opened.orchestrator, { worker: 'worker-4' })).result).toBe('published');
    expect((await readUnit(opened.owner, 'modules/root'))?.state).toBe('published');
  });

  test('a split past the limits blocks the parent with the reason rather than decomposing without a bound', async () => {
    const many = Array.from({ length: 3 }, (_value, index) => ({ id: `child-${index}`, scope: `child-${index}` }));
    const { stage } = splittingStage({ children: many });
    const registry = new StageRegistry().register(stage);
    const { world: opened, runId } = await plannedWorld({ registry, limits: { maxSplitChildren: 2 } });
    await admitUnits(opened.orchestrator, { runId });
    const blocked = await workOnce(opened.orchestrator, { worker: 'worker-1' });
    expect(blocked.result).toBe('blocked');
    expect(blocked.summary).toBe('the split names 3 children, more than the 2 one split may seal');
    const parent = await readUnit(opened.owner, 'modules/root');
    expect(parent?.state).toBe('blocked');
    expect(await readSealedChildren(opened.owner, 'modules/root', 1)).toEqual([]);
    expect((await readRunUnits(opened.owner, runId)).map((unit) => unit.unitId)).toEqual(['modules/root']);
  });

  test('a split whose children estimate more work than the bound blocks the parent, and one that nests too deep does too', async () => {
    const { stage } = splittingStage({ children: [{ id: 'left', scope: 'left', estimatedTokens: 5_000 }, { id: 'right', scope: 'right', estimatedTokens: 5_000 }] });
    const registry = new StageRegistry().register(stage);
    const { world: opened, runId } = await plannedWorld({ registry, limits: { maxSplitWork: 9_000 } });
    await admitUnits(opened.orchestrator, { runId });
    const blocked = await workOnce(opened.orchestrator, { worker: 'worker-1' });
    expect(blocked.summary).toBe('the split\'s children estimate 10000 tokens of work together, past the 9000 one split may seal');
  });

  test('a split deeper than the bound blocks the child that would nest it', async () => {
    const { stage } = splittingStage({ splitEveryUnit: true });
    const registry = new StageRegistry().register(stage);
    const { world: opened, runId } = await plannedWorld({ registry, limits: { maxSplitDepth: 1 } });
    await admitUnits(opened.orchestrator, { runId });
    await workOnce(opened.orchestrator, { worker: 'worker-1' });
    expect((await readSealedChildren(opened.owner, 'modules/root', 1)).map((child) => child.unitId)).toEqual(['modules/root-a', 'modules/root-b']);
    await admitUnits(opened.orchestrator, { runId });
    const nested = await workOnce(opened.orchestrator, { worker: 'worker-2' });
    expect(nested.result).toBe('blocked');
    expect(nested.summary).toBe('the split would nest 2 deep, past the 1 splits may nest');
    expect((await readUnit(opened.owner, 'modules/root-a'))?.state).toBe('blocked');
  });

  });

describe('staleness from tracked reads, empty results included', () => {

  
  
  test('named inputs that moved make a planned generation stale before it ever runs', async () => {
    const registry = new StageRegistry().register(writingStage('snapshot', { units: ['src'], produces: ['file-facts'] }));
    const { world: opened, runId } = await plannedWorld({ registry });
    await admitUnits(opened.orchestrator, { runId });
    opened.commits.value = 'f9e8d7c6';
    const sweep = await invalidateStaleUnits(opened.orchestrator, { runId });
    expect(sweep.invalidated.map((unit) => `${unit.unitId}:${unit.generation}->${unit.replacement}`)).toEqual(['snapshot/src:1->2']);
    expect(sweep.invalidated[0]!.cause).toContain('the unit\'s named inputs moved');
    const unit = await readUnit(opened.owner, 'snapshot/src');
    expect(unit?.generation).toBe(2);
    expect(unit?.state).toBe('planned');
    expect(unit?.context.fence).toBe(0);
  });
});

describe('publication: exactly once per generation', () => {
  
  
  test('a publication that fails every attempt names the unit failed and fails the run when nothing published', async () => {
    const registry = new StageRegistry().register(writingStage('snapshot', { units: ['src'], produces: ['file-facts'], beforeWrite: () => { throw new Error('the graph refused the write'); } }));
    const { world: opened, runId } = await plannedWorld({
      registry,
      limits: { retryDelayMs: 0, retries: 1 },

    });
    await admitUnits(opened.orchestrator, { runId });
    expect((await workOnce(opened.orchestrator, { worker: 'worker-1' })).result).toBe('retried');
    await sweepUnits(opened.orchestrator, { runId });
    const failed = await workOnce(opened.orchestrator, { worker: 'worker-2' });
    expect(failed.result).toBe('failed');
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('failed');
    const events = await readProgress(opened.owner, runId);
    const named = events.filter((event) => event.kind === 'unit-failed');
    expect(named).toHaveLength(1);
    expect(named[0]?.summary).toContain('the graph refused the write');
    const settlement = await schedulerPass(opened.orchestrator, { runId });
    expect(settlement.run.state).toBe('failed');
  });

  });

describe('the words of what a stage raised', () => {
  /** A stage that plans one unit and throws exactly the value the test gives it: a stage is code madarch runs but does not write, so its throw may be any value. */
  function throwingStage(thrown: unknown): FillStage {
    return fakeStage('snapshot', {
      plan: () => ({ units: [{ id: 'src', scope: 'src' }], coverage: 'planned' }),
      execute: () => { throw thrown; },
    });
  }

  /** The `unit-failed` summary the sink heard and the one the run's journal keeps, for a stage that threw `thrown`. */
  async function failedSummaries(thrown: unknown): Promise<{ readonly event: string; readonly journal: string }> {
    const heard: string[] = [];
    const { world: opened, runId } = await plannedWorld({
      registry: new StageRegistry().register(throwingStage(thrown)),
      limits: { retries: 0, retryDelayMs: 0 },
      sink: (event) => { if (event.kind === 'unit-failed') heard.push(event.summary); },
    });
    await admitUnits(opened.orchestrator, { runId });
    expect((await workOnce(opened.orchestrator, { worker: 'worker-1' })).result).toBe('failed');
    const journal = (await readProgress(opened.owner, runId)).filter((event) => event.kind === 'unit-failed');
    expect(journal).toHaveLength(1);
    expect(heard).toHaveLength(1);
    return { event: heard[0]!, journal: journal[0]!.summary };
  }

  test('a thrown object is named by its code and its message, never by `[object Object]`', async () => {
    const words = 'the plugin refused git:code.commit: its contract names no producer';
    const { event, journal } = await failedSummaries({ code: 'plugin-refused', message: words });
    for (const summary of [event, journal]) {
      expect(summary).toContain('plugin-refused');
      expect(summary).toContain(words);
      expect(summary).not.toContain('[object Object]');
    }
  }, 30_000);

  test('formatting failures preserve the original stage failure and journal unit-failed', async () => {
    const thrown = Object.defineProperty({}, 'message', { enumerable: true, get() { throw new Error('getter failed'); } });
    const result = await failedSummaries(thrown);
    expect(result.event).toContain('message: [Getter]');
    expect(result.journal).toContain('message: [Getter]');
  }, 30_000);

  test('a throwing Proxy still records unit-failed in the sink and journal', async () => {
    const thrown = new Proxy({}, new Proxy({}, { get() { return () => { throw new Error('trap failed'); }; } }));
    const result = await failedSummaries(thrown);
    expect(result.event).toContain('Proxy [');
    expect(result.journal).toContain('Proxy [');
  }, 30_000);

  test('an Error with a throwing message getter still records unit-failed', async () => {
    const thrown = Object.defineProperty(new Error(), 'message', { get() { throw new Error('getter failed'); } });
    await failedSummaries(thrown);
  }, 30_000);

  test('a thrown string stands as its own words, and the run never says the stage answered nothing', async () => {
    const words = 'the plugin refused git:code.commit: its contract names no producer';
    const { event, journal } = await failedSummaries(words);
    for (const summary of [event, journal]) {
      expect(summary).toContain(words);
      expect(summary).not.toContain('it answered nothing');
    }
  }, 30_000);
});

describe('cancellation, pause and stop', () => {
  /** A stage that reports it is running and then waits for the attempt's own cancellation. */
  function waitingStage(): { stage: FillStage; reached: Promise<void> } {
    let signalReached!: () => void;
    const reached = new Promise<void>((resolve) => { signalReached = resolve; });
    const stage = fakeStage('snapshot', {
      produces: [{ kind: 'file-facts', schemaVersion: 1, scope: 'repository' }],
      plan: () => ({ units: [{ id: 'src', scope: 'src' }], coverage: 'planned' }),
      execute: async (_unit, context): Promise<StageExecutionResult> => {
        signalReached();
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) resolve();
          else context.signal.addEventListener('abort', () => resolve());
        });
        return { outcome: 'blocked', reason: 'the attempt was cancelled' };
      },
    });
    return { stage, reached };
  }

  
  test('a unit step that lands while the run is cancelling is refused, whichever of the two writes lands first', async () => {
    // The losing interleaving of a cancel and a step, forced without timing: the run's cancel intent stands and the drain has
    // not reached the unit, so the unit is still running when its attempt reports blocked. The step answers with the
    // machine's own refusal — the one it answers when the cancel's write came first — instead of recording the unit as
    // blocked under a run that revoked its authority.
    const { stage } = waitingStage();
    const { world: opened, runId } = await plannedWorld({ registry: new StageRegistry().register(stage) });
    await admitUnits(opened.orchestrator, { runId });
    const [job] = await opened.queue.claim({ queue: QUEUE });
    expect(job).toBeDefined();
    expect((await writeOrchestration(opened.owner, tx => advanceUnitIn(tx, { unitId: 'snapshot/src', event: { type: 'start', at: NOW, generation: 1, fence: job!.attempt, attempt: job!.attempt } }))).ok).toBe(true);
    expect((await advanceRun(opened.owner, { runId, event: { type: 'cancel', at: NOW, cause: 'the person stopped the run' } })).ok).toBe(true);
    const blocked = await writeOrchestration(opened.owner, tx => advanceUnitIn(tx, { unitId: 'snapshot/src', event: { type: 'block', at: NOW, generation: 1, fence: job!.attempt, reason: 'the attempt was cancelled' } }));
    expect(blocked.ok).toBe(false);
    expect(blocked.ok === false ? blocked.refusal.code : '').toBe('fill-unit/no-transition');
    expect(blocked.ok === false ? blocked.refusal.reason : '').toContain('cancelling');
    // Nothing of the step stands: the unit is where the step found it, for the drain's own cancel.
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('running');
  });

  test('a pause closes the operation gate, preserves committed work, and a resume finishes', async () => {
    // The first operation commits before pause; the next must be refused after the gate closes.
    let operationUnitUid: string | undefined;
    let running!: () => void;
    const reached = new Promise<void>((resolve) => { running = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const stage = fakeStage('snapshot', {
      produces: [{ kind: 'file-facts', schemaVersion: 1, scope: 'repository' }],
      defaults: { ...DEFAULT_STAGE_DEFAULTS, concurrency: 1 },
      plan: () => ({ units: [{ id: 'src', scope: 'src' }, { id: 'docs', scope: 'docs' }], coverage: 'planned' }),
      execute: async (unit, context): Promise<StageExecutionResult> => {
        operationUnitUid = context.operationUnitUid;
        await writeFixtureFact(context, `${unit.scope}:prefix`, { kind: 'file-facts', prefix: true }, 'fixture-prefix');
        running();
        await gate;
        await writeFixtureFact(context, `${unit.scope}:1`, { kind: 'file-facts' });
        return { outcome: 'draft' };
      },
    });
    const registry = new StageRegistry().register(stage);
    let control: 'running' | 'paused' | 'stopped' = 'running';
    const { world: opened, runId } = await plannedWorld({ registry, control: async () => control, limits: { retryDelayMs: 0 } });
    await admitUnits(opened.orchestrator, { runId });
    const working = workOnce(opened.orchestrator, { worker: 'worker-1' });
    await Promise.race([reached, working.then((result) => { throw new Error(`attempt ended before prefix committed: ${JSON.stringify(result)}`); })]);

    // Decision 0039 closes the write gate immediately, without withdrawing accepted operations.
    control = 'paused';
    const pausedPass = await schedulerPass(opened.orchestrator, { runId });
    expect(pausedPass.run.state).toBe('paused');
    release();
    expect((await working).result).toBe('retried');
    expect(operationUnitUid).toBeDefined();
    const receipts = await opened.owner.transaction('snapshot', async (tx) => ({
      prefix: await operationReceipt(tx, EMPTY_CONTRACT, operationUnitUid!, 'fixture-prefix'),
      afterPause: await operationReceipt(tx, EMPTY_CONTRACT, operationUnitUid!, 'fixture-fact'),
    }));
    expect(receipts.prefix).toBeDefined();
    expect(receipts.afterPause).toBeUndefined();
    const drained = await schedulerPass(opened.orchestrator, { runId });
    expect(drained.run.state).toBe('paused');
    expect((await readUnit(opened.owner, 'snapshot/docs'))?.state).toBe('planned');

    // The next planning epoch carries the run to its end.
    control = 'running';
    await resumeRun(opened.orchestrator, { runId });
    expect((await readRun(opened.owner, runId))?.context).toEqual({ planningEpoch: 1, planningClosed: false });
    const replanned = await planRun(opened.orchestrator, { runId });
    expect(replanned.outcome).toBe('planned');
    expect((await readRun(opened.owner, runId))?.context).toEqual({ planningEpoch: 2, planningClosed: true });
    const driven = await driveRun(opened.orchestrator, { runId, workers: 4 });
    expect(driven.settled).toBe(true);
    expect(driven.run.state).toBe('succeeded');
    expect((await readRunUnits(opened.owner, runId)).every((unit) => unit.state === 'published')).toBe(true);
  });

  test('a stop through the control file cancels the run and its units', async () => {
    const registry = new StageRegistry().register(writingStage('snapshot', { units: ['src'], produces: ['file-facts'] }));
    let control: 'running' | 'paused' | 'stopped' = 'stopped';
    const { world: opened, runId } = await plannedWorld({ registry, control: async () => control });
    const pass = await schedulerPass(opened.orchestrator, { runId });
    expect(pass.run.state).toBe('cancelled');
    expect((await readRunUnits(opened.owner, runId)).map((unit) => unit.state)).toEqual(['cancelled']);
    expect((await readProgress(opened.owner, runId)).some((event) => event.kind === 'run-cancelling')).toBe(true);
    control = 'running';
  });
});

describe('the human-edit guard', () => {
  });

describe('driving a whole run', () => {
  test('planning, admission, three stages and one publication per generation, with no sleeps', async () => {
    const { world: opened, runId } = await plannedWorld({ registry: basicRegistry() });
    const driven = await driveRun(opened.orchestrator, { runId, workers: 2 });
    expect(driven.settled).toBe(true);
    expect(driven.run.state).toBe('succeeded');
    const units = await readRunUnits(opened.owner, runId);
    expect(units.map((unit) => `${unit.unitId}:${unit.state}`)).toEqual([
      'modules/core:published', 'overview/product:published', 'snapshot/docs:published', 'snapshot/src:published',
    ]);
    const completed = await opened.owner.run((tx) => tx.query(`SELECT n.uid FROM node n JOIN entity k ON k.id = n.entity_id WHERE k.name = 'system.unit'`));
    expect(completed.rows).toHaveLength(4);
    expect((await readChain(opened.owner, 'fixture-product'))?.state).toBe('quiescent');
    const status = await runStatus(opened.orchestrator, runId);
    expect(status?.evidence).toEqual({ runnable: 0, inFlight: 0, waiting: 0, coverageMet: true });
    expect(status?.units.map((unit) => `${unit.unitId}:${unit.attempts}`)).toEqual([
      'modules/core:1', 'overview/product:1', 'snapshot/docs:1', 'snapshot/src:1',
    ]);
  });

  
});

describe('the service the background server owns', () => {
  test('a service with nothing wired refuses a run and names what is missing, and opens nothing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'madarch-fill-host-'));
    try {
      const service = trackedService({ registry: basicRegistry() });
      const refused = await service.run({ product: { name: 'fixture-product', folder: home }, runId: 'run-1' });
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.code).toBe('fill-orchestrator/no-wiring');
      expect(refused.reason).toContain('nothing wires the fill');
      expect(existsSync(join(home, '.madarch', 'fill', 'state.db'))).toBe(false);
      await service.stop();
      await service.stop();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('the daemon\'s own fills open no database before a run, and stop cleanly', async () => {
    const home = await mkdtemp(join(tmpdir(), 'madarch-fill-daemon-'));
    try {
      const fills = daemonFills(home);
      await fills.stop();
      expect(existsSync(join(home, '.madarch'))).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('a wired service opens the store it is given, runs a fill to its end and closes what it opened', async () => await withStorePreparationOwner(async () => {
    const home = await mkdtemp(join(tmpdir(), 'madarch-fill-host-'));
    // The store is the caller's: a service is given the product's store, never a home to guess one from.
    const databasePath = join(home, 'store', 'graph');
    try {
      const graph = fakeGraph();
      const applied: string[] = [];
      const service = trackedService({
        databasePath,
        registry: basicRegistry(),
        wiring: (_product, { owner }) => ({
          graphContract: withAssertionContract(EMPTY_CONTRACT),
          operations: fixtureOperations(owner),
          snapshot: () => SNAPSHOT,
          configuration: () => undefined,
          graph: () => graph.reader,
          inputs: () => ({ commit: 'a1b2c3d4' }),
        }),
      });
      expect(existsSync(databasePath)).toBe(false);
      await requestStorePreparation(databasePath);
      const result = await service.run({ product: { name: 'fixture-product', folder: home }, runId: 'run-host-1', workers: 2 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.settled).toBe(true);
      expect(result.state).toBe('succeeded');
      expect(result.units.every((unit) => unit.state === 'published')).toBe(true);
      expect(applied).toHaveLength(0);
      expect(existsSync(databasePath)).toBe(true);

      // The status of the run is readable while the service is open, and the second run of the same
      // product reuses what the first one opened.
      const status = await service.status({ product: { name: 'fixture-product', folder: home }, runId: 'run-host-1' });
      expect(status?.run.state).toBe('succeeded');
      const again = await service.run({ product: { name: 'fixture-product', folder: home }, runId: 'run-host-2', workers: 2 });
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.state).toBe('succeeded');
      await service.stop();
      // Closed with the service: another owner can take the store.
      const reopened = await createTestDatabaseOwner({ store: databasePath, btreeGist: true });
      await reopened.ready;
      await reopened.close();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }));

  test('a service given no store refuses a run by name and opens nothing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'madarch-fill-nostore-'));
    try {
      const service = trackedService({
        registry: basicRegistry(),
        wiring: (_product, { owner }) => ({
          graphContract: withAssertionContract(EMPTY_CONTRACT),
          operations: fixtureOperations(owner), snapshot: () => SNAPSHOT, configuration: () => undefined, graph: () => fakeGraph().reader, inputs: () => ({ commit: 'a1b2c3d4' }) }),
      });
      const refused = await service.run({ product: { name: 'fixture-product', folder: home }, runId: 'run-nostore' });
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.code).toBe('fill-orchestrator/no-store');
      expect(refused.reason).toContain('was given no store');
      expect(refused.reason).toContain('src/fill/orchestrator-host.ts');
      expect(existsSync(home)).toBe(true);
      expect(readdirSync(home)).toEqual([]);
      await service.stop();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('what the review found, kept as tests', () => {
  test('retry and completion machine assertions have only fill-state as their source', async () => {
    let attempts = 0;
    const stage = fakeStage('snapshot', {
      plan: () => ({ units: [{ id: 'src', scope: 'src' }], coverage: 'planned' }),
      execute: () => { if (++attempts <= 2) throw new Error('transient producer failure'); return { outcome: 'draft' }; },
    });
    const { world: opened, runId } = await plannedWorld({
      registry: new StageRegistry().register(stage), limits: { retries: 2, retryDelayMs: 0 },
    });
    await admitUnits(opened.orchestrator, { runId });
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      expect((await workOnce(opened.orchestrator, { worker: 'worker-1' })).result).toBe('retried');
      await sweepUnits(opened.orchestrator, { runId });
      await admitUnits(opened.orchestrator, { runId });
    }
    expect((await workOnce(opened.orchestrator, { worker: 'worker-1' })).result).toBe('published');
    await schedulerPass(opened.orchestrator, { runId });
    const sources = await opened.owner.run(tx => tx.query<{kind:string;property:string;source:string}>(`
      SELECT k.name AS kind,a.property,source.uid::text AS source
      FROM assertion a JOIN assertion_vertex_subject av ON av.assertion_id=a.assertion_id
      JOIN edge subject ON subject.id=av.subject_edge_id JOIN node n ON n.id=subject.to_node
      JOIN entity k ON k.id=n.entity_id
      JOIN edge lineage ON lineage.from_node=a.assertion_id JOIN entity lk ON lk.id=lineage.entity_id AND lk.name='system.assertion-source'
      JOIN node source ON source.id=lineage.to_node
      WHERE k.name IN ('system.chain','system.run','system.unit','system.fill-transition')
      AND (k.name='system.fill-transition' OR a.property IN ('product_name','run_name','unit_name','stage_name','generation','scope','state','planning_epoch','planning_closed','has_selection','created_at','inputs_digest','fence','attempt','retries_left','retry_at','replacement_generation','skipped_because','published_at','stale_at','updated_at'))`));
    const installed = await opened.owner.transaction('snapshot', tx => readKindAssertions(tx,'vertex','plugin',['label']));
    const sourceUid = installed.find(row => row.values.label === 'fill-state')!.uid;
    for (const kind of ['system.unit','system.run','system.fill-transition']) expect(sources.rows.some(row => row.kind === kind)).toBe(true);
    expect(sources.rows.filter(row => row.source !== sourceUid)).toEqual([]);
    const operationPrincipal = installed.find(row => row.values.label === 'scheduler-fixture')!.uid;
    const operationAuthors = await opened.owner.run(tx => tx.query<{operation:string;author:string|null;author_count:number;existence_author:string|null}>(`
      SELECT DISTINCT op.uid::text AS operation,author.uid::text AS author,
        (SELECT count(*)::int FROM edge e JOIN entity ek ON ek.id=e.entity_id
          WHERE e.from_node=op.id AND ek.name='system.operation-author') AS author_count,
        existence_author.uid::text AS existence_author
      FROM assertion a JOIN assertion_vertex_subject av ON av.assertion_id=a.assertion_id
      JOIN edge subject ON subject.id=av.subject_edge_id JOIN node n ON n.id=subject.to_node
      JOIN entity k ON k.id=n.entity_id
      JOIN edge lineage ON lineage.from_node=a.assertion_id
      JOIN entity lk ON lk.id=lineage.entity_id AND lk.name='system.assertion-operation'
      JOIN node op ON op.id=lineage.to_node
      LEFT JOIN (edge authors JOIN entity ak ON ak.id=authors.entity_id AND ak.name='system.operation-author') ON authors.from_node=op.id
      LEFT JOIN node author ON author.id=authors.to_node
      LEFT JOIN (edge existence_subject JOIN assertion_vertex_subject ov ON ov.subject_edge_id=existence_subject.id
        JOIN assertion existence ON existence.assertion_id=ov.assertion_id AND existence.property='$exists'
        JOIN edge existence_lineage ON existence_lineage.from_node=existence.assertion_id
        JOIN entity eak ON eak.id=existence_lineage.entity_id AND eak.name='system.assertion-author'
        JOIN node existence_author ON existence_author.id=existence_lineage.to_node) ON existence_subject.to_node=op.id
      WHERE k.name IN ('system.chain','system.run','system.unit','system.fill-transition')`));
    expect(operationAuthors.rows.length).toBeGreaterThan(0);
    for (const row of operationAuthors.rows) {
      expect(row.author_count).toBe(1);
      expect(row.author).not.toBeNull();
      expect(row.existence_author).not.toBeNull();
      expect(row.author).toBe(row.existence_author);
    }
    const authors = new Set(operationAuthors.rows.map(row => row.author));
    expect(authors.has(sourceUid)).toBe(true);
    expect(authors.has(operationPrincipal)).toBe(true);
    const disputes = await opened.owner.run(tx => tx.query(`
      SELECT n.id FROM node n JOIN entity k ON k.id=n.entity_id
      WHERE k.name='system.dispute-question'`));
    expect(disputes.rows).toEqual([]);
  }, 60_000);


  test('repeated operation retries stay retry_wait until the third failure exhausts the unit', async () => {
    let attempts = 0;
    const stage = fakeStage('snapshot', {
      plan: () => ({ units: [{ id: 'src', scope: 'src' }], coverage: 'planned' }),
      execute: () => { attempts += 1; throw new Error('transient producer failure'); },
    });
    const { world: opened, runId } = await plannedWorld({
      registry: new StageRegistry().register(stage), limits: { retries: 2, retryDelayMs: 0 },
    });
    await admitUnits(opened.orchestrator, { runId });
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      expect((await workOnce(opened.orchestrator, { worker: 'worker-1' })).result).toBe('retried');
      expect(attempts).toBe(attempt);
      expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('retry_wait');
      await sweepUnits(opened.orchestrator, { runId });
      await admitUnits(opened.orchestrator, { runId });
    }
    expect((await workOnce(opened.orchestrator, { worker: 'worker-1' })).result).toBe('failed');
    expect(attempts).toBe(3);
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('failed');
    const settled = await schedulerPass(opened.orchestrator, { runId });
    expect(settled.run.state).toBe('failed');
  }, 30_000);

  test('a run with a unit waiting for its retry has not finished: it settles only once that attempts ends', async () => {
    let attempts = 0;
    const registry = new StageRegistry().register(writingStage('snapshot', {
      units: ['src'], produces: ['file-facts'],
      beforeWrite: () => { attempts += 1; if (attempts === 1) throw new Error('the first operation is refused'); },
    }));
    const { world: opened, runId } = await plannedWorld({ registry, limits: { retryDelayMs: 10_000 } });
    await admitUnits(opened.orchestrator, { runId });
    expect((await workOnce(opened.orchestrator, { worker: 'worker-1' })).result).toBe('retried');
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('retry_wait');

    // The run still owes that attempt, so a pass that finds nothing runnable right now must not finish it.
    const waiting = await schedulerPass(opened.orchestrator, { runId });
    expect(waiting.run.state).toBe('running');
    expect(waiting.settlement.outcome).toBe('waiting');
    expect((await runEvidence(opened.orchestrator, runId)).runnable).toBe(1);
    const driven = await driveRun(opened.orchestrator, { runId, workers: 1 });
    expect(driven.settled).toBe(false);
    expect(driven.stoppedBecause).toBe('a pass and its claims together changed nothing');

    // Its moment comes and the same attempt carries the run to its end.
    opened.clock.advance(10_000);
    const finished = await driveRun(opened.orchestrator, { runId, workers: 1 });
    expect(finished.settled).toBe(true);
    expect(finished.run.state).toBe('succeeded');
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('published');
    expect(attempts).toBe(2);
  });

  
  test('a product configuration that moved under a run refuses a second planning of it', async () => {
    let enabled = true;
    const registry = new StageRegistry().register(writingStage('snapshot', { units: ['src'], produces: ['file-facts'] }));
    const configuration = () => (enabled ? undefined : { ok: true as const, file: '/product/workspace.yaml', stages: { snapshot: { concurrency: 2 } }, lines: { snapshot: 4 } });
    const { world: opened, runId } = await planWorld({ registry, configuration });
    expect((await readRun(opened.owner, runId))?.state).toBe('running');
    enabled = false;
    const again = await planRun(opened.orchestrator, { runId });
    expect(again.outcome).toBe('refused');
    expect(again.outcome === 'refused' ? again.code : '').toBe('fill-orchestrator/configuration-moved');
    expect(again.outcome === 'refused' ? again.reason : '').toContain('a changed product configuration is a new run');
  });

  
  test('a join whose children are still running settles its job and leaves the parent waiting', async () => {
    const { stage } = splittingStage();
    const registry = new StageRegistry().register(stage);
    const { world: opened, runId } = await plannedWorld({ registry, limits: { retryDelayMs: 0 } });
    await admitUnits(opened.orchestrator, { runId });
    await workOnce(opened.orchestrator, { worker: 'worker-1' });
    expect((await readUnit(opened.owner, 'modules/root'))?.state).toBe('waiting_children');

    // A job for the parent while its children are still planned: the worker settles it and changes nothing.
    await opened.queue.enqueue({ queue: QUEUE, data: { unitId: 'modules/root', generation: 1 }, singletonKey: 'modules/root' });
    const joined = await workOnce(opened.orchestrator, { worker: 'worker-2' });
    expect(joined.result).toBe('nothing-to-do');
    expect(joined.summary).toBe('the children are still running');
    expect((await readUnit(opened.owner, 'modules/root'))?.state).toBe('waiting_children');
  });

  
  test('a unit a finished run left blocked is retried by the next run, never inherited and never trapping the product', async () => {
    // The work blocks on its first attempt and drafts on the next: the first run ends completed_partial, and a
    // second fill of the same product must be able to work the unit again. The refusal for a unit another run
    // holds names a unit *worked by one run at a time*, and a completed_partial run has ended.
    let attempts = 0;
    const retrying = new StageRegistry().register(fakeStage('blocked-stage', {
      produces: [{ kind: 'other-facts', schemaVersion: 1, scope: 'repository' }],
      plan: () => ({ units: [{ id: 'src', scope: 'src' }], coverage: 'planned' }),
      execute: () => {
        attempts += 1;
        return attempts === 1 ? { outcome: 'blocked', reason: 'a person must look at this' } : { outcome: 'draft' };
      },
    }));
    const opened = await world({ registry: retrying, product: 'other-product' });
    await startRun(opened.orchestrator, { runId: 'run-a' });
    expect((await planRun(opened.orchestrator, { runId: 'run-a' })).outcome).toBe('planned');
    await admitUnits(opened.orchestrator, { runId: 'run-a' });
    expect((await workOnce(opened.orchestrator, { worker: 'worker-1' })).result).toBe('blocked');
    expect((await driveRun(opened.orchestrator, { runId: 'run-a', workers: 1 })).run.state).toBe('failed');
    expect((await readUnit(opened.owner, 'blocked-stage/src'))?.state).toBe('skipped');

    // The next fill of the product plans the unit again, as generation 2 under its own run, and publishes it.
    expect((await startRun(opened.orchestrator, { runId: 'run-b' })).ok).toBe(true);
    const planned = await planRun(opened.orchestrator, { runId: 'run-b' });
    expect(planned.outcome).toBe('planned');
    if (planned.outcome !== 'planned') return;
    expect(planned.units.map((unit) => `${unit.unitId}:${unit.generation}`)).toEqual(['blocked-stage/src:2']);
    const driven = await driveRun(opened.orchestrator, { runId: 'run-b', workers: 1 });
    expect(driven.run.state).toBe('succeeded');
    const unit = await readUnit(opened.owner, 'blocked-stage/src');
    expect(unit).toMatchObject({ state: 'published', generation: 2, runId: 'run-b' });
    // The blocked generation stays as its own record, and the retry is its own transition.
    const generations = await opened.owner.run((tx) => tx.query<{ generation: number; state: string }>('SELECT generation, state FROM fill_unit_generation WHERE unit_id = $1 ORDER BY generation', ['blocked-stage/src']));
    expect(generations.rows).toEqual([{ generation: 1, state: 'skipped' }, { generation: 2, state: 'published' }]);
  });

  test('a run with one published unit and one failed unit stays partial', async () => {
    const stage = writingStage('snapshot', { units: ['ok', 'bad'], concurrency: 2 });
    stage.execute = async (unit, context) => {
      if (unit.id === 'bad') throw new Error('the second unit failed');
      await writeFixtureFact(context, `${unit.scope}:1`, { kind: 'file-facts' });
      return { outcome: 'draft' };
    };
    const { world: opened, runId } = await plannedWorld({ registry: new StageRegistry().register(stage), limits: { retries: 0 } });
    const driven = await driveRun(opened.orchestrator, { runId, workers: 1 });
    expect(driven.run.state).toBe('completed_partial');
    expect((await readRunUnits(opened.owner, runId)).filter((unit) => unit.state === 'published')).toHaveLength(1);
  });

  test('a run whose producer fails leaves its dependant skipped-because, and the run failed', async () => {
    const stage = writingStage('plugin-turns', { units: ['producer', 'consumer'], concurrency: 1 });
    stage.unitScheduling = (id) => ({ after: id === 'consumer' ? ['producer'] : [], group: id, concurrency: 1 });
    stage.execute = async (unit, context) => {
      if (unit.id === 'producer') throw new Error('the producer refused its input');
      await writeFixtureFact(context, `${unit.scope}:1`, { kind: 'file-facts' });
      return { outcome: 'draft' };
    };
    const { world: opened, runId } = await plannedWorld({ registry: new StageRegistry().register(stage), limits: { retries: 0 } });
    const driven = await driveRun(opened.orchestrator, { runId, workers: 1 });
    expect(driven.run.state).toBe('failed');
    expect((await readUnit(opened.owner, 'plugin-turns/producer'))?.state).toBe('failed');
    const consumer = await readUnit(opened.owner, 'plugin-turns/consumer');
    expect(consumer?.state).toBe('skipped');
    expect(consumer?.context.skippedBecause).toContain('plugin-turns/producer failed');
    expect(await isFinalRunState(driven.run.state)).toBe(true);
    expect(await isFinalUnitState(consumer?.state ?? '')).toBe(true);
  });

  test('a recovered run refuses the late planner\'s next unit and stays final', async () => {
    let entered: (() => void) | undefined;
    let release: (() => void) | undefined;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const stage = writingStage('snapshot', { units: ['src'] });
    stage.plan = async () => { entered!(); await gate; return { units: [{ id: 'src', scope: 'src' }], coverage: 'planned' }; };
    const opened = await world({ registry: new StageRegistry().register(stage) });
    await startRun(opened.orchestrator, { runId: 'run-recovered' });
    const planning = planRun(opened.orchestrator, { runId: 'run-recovered' });
    await reached;
    stopHeartbeat(opened.orchestrator);
    opened.clock.advance(60_000);
    await recoverOrphanedRun(opened.orchestrator, { runId: 'run-recovered', at: opened.clock.now(), afterMs: 0 });
    release!();
    const plan = await planning;
    expect(plan.outcome).not.toBe('planned');
    expect((await readRun(opened.owner, 'run-recovered'))?.state).toBe('failed');
    expect((await readRunUnits(opened.owner, 'run-recovered')).every((unit) => isFinalUnitState(unit.state))).toBe(true);
  });

  test('an active run keeps a second start from ending its run', async () => {
    const { world: opened, runId } = await plannedWorld({ registry: new StageRegistry().register(writingStage('snapshot', { units: ['src'] })) });
    await admitUnits(opened.orchestrator, { runId });
    const next = await startRun(opened.orchestrator, { runId: 'run-while-live' });
    expect(next.ok).toBe(false);
    expect((await readRun(opened.owner, runId))?.state).toBe('running');
    expect((await readRunUnits(opened.owner, runId)).some((unit) => !isFinalUnitState(unit.state))).toBe(true);
  });

  test('a run whose process died is ended by the next start, and none of its units stays waiting', async () => {
    const { world: opened, runId } = await plannedWorld({ registry: new StageRegistry().register(writingStage('snapshot', { units: ['src'] })) });
    await admitUnits(opened.orchestrator, { runId });
    await opened.owner.run((tx) => tx.query(`UPDATE fill_run SET updated_at = $1 WHERE run_id = $2`, [NOW, runId]));
    opened.clock.advance(10 * 60_000);
    const next = await startRun(opened.orchestrator, { runId: 'run-after-death' });
    expect(next.ok).toBe(true);
    expect((await readRun(opened.owner, runId))?.state).toBe('failed');
    const units = await readRunUnits(opened.owner, runId);
    expect(units.every((unit) => isFinalUnitState(unit.state))).toBe(true);
    expect(units.map((unit) => unit.state)).toContain('skipped');
  });

  test('a unit a finished run left failed is retried too: a failed fill does not trap the product', async () => {
    // The first attempt raises, and the run's retry budget is one more: the unit ends failed and the run failed.
    let attempts = 0;
    let failing = true;
    const flaky = new StageRegistry().register(fakeStage('flaky-stage', {
      produces: [{ kind: 'other-facts', schemaVersion: 1, scope: 'repository' }],
      plan: () => ({ units: [{ id: 'src', scope: 'src' }], coverage: 'planned' }),
      execute: () => {
        attempts += 1;
        if (failing) throw new Error('the reader failed');
        return { outcome: 'draft' };
      },
    }));
    const opened = await world({ registry: flaky, product: 'other-product', limits: { retries: 1, retryDelayMs: 0 } });
    await startRun(opened.orchestrator, { runId: 'run-failed' });
    expect((await planRun(opened.orchestrator, { runId: 'run-failed' })).outcome).toBe('planned');
    // A run whose unit failed settles short of its coverage: `completed_partial`, and the unit stands failed.
    const first = await driveRun(opened.orchestrator, { runId: 'run-failed', workers: 1 });
    expect(first.run.state).toBe('failed');
    expect((await readUnit(opened.owner, 'flaky-stage/src'))?.state).toBe('failed');

    failing = false;
    expect((await startRun(opened.orchestrator, { runId: 'run-after-failure' })).ok).toBe(true);
    const planned = await planRun(opened.orchestrator, { runId: 'run-after-failure' });
    expect(planned.outcome).toBe('planned');
    if (planned.outcome !== 'planned') return;
    expect(planned.units.map((unit) => `${unit.unitId}:${unit.generation}`)).toEqual(['flaky-stage/src:2']);
    const driven = await driveRun(opened.orchestrator, { runId: 'run-after-failure', workers: 1 });
    expect(driven.run.state).toBe('succeeded');
    expect(await readUnit(opened.owner, 'flaky-stage/src')).toMatchObject({ state: 'published', generation: 2 });
    expect(attempts).toBe(3);
  });

  
  });

describe('the background server that owns the orchestrator', () => {
  });

describe('what the second review found, kept as tests', () => {
  test('a starved plan blocks the run and leaves the product able to start the next one', async () => {
    const registry = new StageRegistry().register(writingStage('modules', { units: ['core'], consumes: ['file-facts'] }));
    const { world: opened, runId } = await planWorld({ registry });
    expect((await readRun(opened.owner, runId))?.state).toBe('blocked');
    // The blocked run is terminal, so the chain settles with it rather than holding the product forever.
    expect((await readChain(opened.owner, 'fixture-product'))?.state).toBe('quiescent');
    const second = await startRun(opened.orchestrator, { runId: 'run-2' });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.chain.state).toBe('active');
    expect(second.chain.context.activeRunId).toBe('run-2');
  });

  
  test('a planned unit with no plan row is reported, never dropped in silence', async () => {
    const registry = new StageRegistry().register(writingStage('snapshot', { units: ['src'], produces: ['file-facts'] }));
    const { world: opened, runId } = await plannedWorld({ registry });
    // The state a crash between creating a unit and recording its plan leaves behind.
    await opened.owner.transaction('write', async (transaction) => {
      await transaction.query('DELETE FROM fill_unit_plan WHERE unit_id = $1', ['snapshot/src']);
    });
    const admission = await admitUnits(opened.orchestrator, { runId });
    expect(admission.admitted).toEqual([]);
    expect(admission.refused).toEqual([{
      unitId: 'snapshot/src',
      code: 'fill-orchestrator/no-plan-row',
      reason: 'fill-orchestrator: unit "snapshot/src" generation 1 stands planned with no plan row, so nothing says where it stands in the plan: replan the run, which records it again',
    }]);
  });

  test('a split that names its own unit as a child is refused, and seals nothing', async () => {
    const selfSplit = splittingStage({ children: [{ id: 'root', scope: 'itself' }] });
    const registry = new StageRegistry().register(selfSplit.stage);
    const { world: opened, runId } = await plannedWorld({ registry });
    await admitUnits(opened.orchestrator, { runId });
    const blocked = await workOnce(opened.orchestrator, { worker: 'worker-1' });
    expect(blocked.result).toBe('blocked');
    expect(blocked.summary).toBe('the split names "modules/root" as a child, and it stands on this split\'s own path: a unit cannot be its own descendant');
    expect(await readSealedChildren(opened.owner, 'modules/root', 1)).toEqual([]);
  });


});

/** The schema pg-boss's own tables live in, as the adapter declares it. */
const QUEUE_SCHEMA = DEFAULT_QUEUE_SCHEMA;

describe('a job the queue no longer holds', () => {
  /** One stage with one unit, so the queue holds exactly one job of the run. */
  const oneUnit = (): StageRegistry => new StageRegistry().register(writingStage('snapshot', { units: ['src'], produces: ['file-facts'], concurrency: 1 }));

  /** The queue's own row count for the run's unfinished jobs, by the unit each carries. */
  async function unfinishedJobs(opened: World): Promise<string[]> {
    const rows = await opened.owner.run(async (transaction) => (await transaction.query<{ singleton_key: string }>(
      `SELECT singleton_key FROM ${QUEUE_SCHEMA}.job WHERE name = $1 AND state IN ('created', 'retry', 'active') ORDER BY singleton_key`,
      [QUEUE],
    )).rows);
    return rows.map((row) => row.singleton_key);
  }

  test('a unit standing ready with no job is offered the queue again, and the offer is idempotent', async () => {
    const { world: opened, runId } = await plannedWorld({ registry: oneUnit() });
    await admitUnits(opened.orchestrator, { runId });
    expect(await unfinishedJobs(opened)).toEqual(['snapshot/src']);

    // The worker that claimed the unit's job died before it took the lease: the
    // queue's own maintenance settles that claim, and with the queue declared with
    // no retries of its own the job is gone while the unit stands `ready`.
    const claimed = (await opened.queue.claim<{ unitId: string }>({ queue: QUEUE }))[0]!;
    expect(claimed.data.unitId).toBe('snapshot/src');
    expect(await opened.queue.fail(QUEUE, claimed, 'the worker died before it leased the unit')).toBe('failed');
    expect(await unfinishedJobs(opened)).toEqual([]);

    const swept = await sweepUnits(opened.orchestrator, { runId });
    expect(swept).toMatchObject({ swept: [{ unitId: 'snapshot/src', outcome: 'requeued' }], refused: [] });
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('ready');
    expect(await unfinishedJobs(opened)).toEqual(['snapshot/src']);

    // The work the dead worker claimed is not lost: the unit runs and publishes.
    const worked = await workOnce(opened.orchestrator, { worker: 'worker-2' });
    expect(worked).toMatchObject({ unitId: 'snapshot/src', result: 'published' });

    // A generation that is already published is not offered again, and neither is a
    // unit whose unfinished job the queue still holds — which the next sweep of a
    // fresh unit shows: the queue creates nothing and the pass changes nothing.
    const quiet = await sweepUnits(opened.orchestrator, { runId });
    expect(quiet).toMatchObject({ swept: [], refused: [] });
  }, 30_000);

  test('a unit whose unfinished job the queue still holds is not offered a second one', async () => {
    const { world: opened, runId } = await plannedWorld({ registry: oneUnit() });
    await admitUnits(opened.orchestrator, { runId });
    // The admission's own job is still the queue's: the offer the sweep makes is
    // answered with "nothing created", so exactly one unfinished job stands.
    const swept = await sweepUnits(opened.orchestrator, { runId });
    expect(swept).toMatchObject({ swept: [], refused: [] });
    expect(await unfinishedJobs(opened)).toEqual(['snapshot/src']);
    expect((await opened.queue.claim<{ unitId: string }>({ queue: QUEUE })).map((job) => job.data.unitId)).toEqual(['snapshot/src']);
  }, 30_000);

  test('a running unit with an active queue claim is left to that attempt', async () => {
    const { world: opened, runId } = await plannedWorld({ registry: oneUnit() });
    await admitUnits(opened.orchestrator, { runId });
    const [job] = await opened.queue.claim({ queue: QUEUE });
    expect(job).toBeDefined();
    expect((await writeOrchestration(opened.owner, tx => advanceUnitIn(tx, { unitId: 'snapshot/src', event: { type: 'start', at: NOW, generation: 1, fence: job!.attempt, attempt: job!.attempt } }))).ok).toBe(true);
    const swept = await sweepUnits(opened.orchestrator, { runId });
    // Queue authority is active: the running unit is neither offered nor retried.
    expect(swept).toMatchObject({ swept: [], refused: [] });
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('running');
  }, 30_000);
});

describe('an attempt that died between its draft and its publication', () => {
  });


describe('the window between a machine step and its enqueue', () => {
  });

describe('a generation’s cache key, and what a run reaches over the declared capabilities', () => {
  /**
   * A stage that reads one query when it runs and drafts one write: `plan` names the units the test puts in
   * the holder, so a run can plan a unit one time and not the next.
   */
  function readingStage(id: string, options: {
    query?: string;
    units: { names: string[] };
    consumes?: readonly string[];
    optionalConsumes?: readonly string[];
    produces?: readonly string[];
    cacheVersions?: () => Readonly<Record<string, string>>;
  }): FillStage {
    return fakeStage(id, {
      consumes: {
        required: (options.consumes ?? []).map((capability) => ({ capability, scope: 'repository' as const })),
        optional: (options.optionalConsumes ?? []).map((capability) => ({ capability, scope: 'repository' as const, freshness: 'any' as const })),
      },
      produces: (options.produces ?? []).map((kind) => ({ kind, schemaVersion: 1, scope: 'repository' as const })),
      ...(options.cacheVersions === undefined ? {} : { cacheVersions: options.cacheVersions }),
      plan: () => ({ units: options.units.names.map((scope) => ({ id: scope, scope })), coverage: 'planned' }),
      execute: async (unit, context) => {
        if (options.query !== undefined) await context.graph.query(options.query);
        await writeFixtureFact(context, `${unit.scope}:1`, { kind: `${id}-facts` });
        return { outcome: 'draft' };
      },
    });
  }

  /** Plans and drives one run to its end, answering what it planned. */
  async function driveOne(opened: World, runId: string): Promise<Extract<PlanOutcome, { outcome: 'planned' }>> {
    const started = await startRun(opened.orchestrator, { runId });
    expect(started.ok).toBe(true);
    const plan = await planRun(opened.orchestrator, { runId });
    if (plan.outcome !== 'planned') throw new Error(`the run ${runId} was not planned: ${JSON.stringify(plan)}`);
    const driven = await driveRun(opened.orchestrator, { runId });
    expect({ state: driven.run.state, settled: driven.settled }).toEqual({ state: 'succeeded', settled: true });
    return plan;
  }

  
  test('a version a stage declares as part of the key replaces every unit the last one planned', async () => {
    const prompt = { value: 'packet@1' };
    const units = { names: ['src'] };
    const registry = new StageRegistry().register(readingStage('overview', { units, produces: ['product-overview'], cacheVersions: () => ({ prompt: prompt.value }) }));
    const opened = await world({ registry });
    await driveOne(opened, 'run-1');
    // The same graph, the same inputs, another prompt: 0026's "the prompt, schema and model versions" is a part
    // of the cache key, so the unit the last run planned is not inherited.
    prompt.value = 'packet@2';
    const second = await driveOne(opened, 'run-2');
    expect(second.reused).toEqual([]);
    expect(second.units.map((unit) => `${unit.unitId}:${unit.generation}`)).toEqual(['overview/src:2']);
    const stale = (await readProgress(opened.owner, 'run-2')).filter((event) => event.kind === 'unit-stale');
    // The reason names the version that moved, in the versions' own words (madarch-tzte.26.1's review, SHOULD-FIX 6).
    expect(stale[0]!.summary).toContain('the versions that decide what it reads and answers moved: prompt packet@1 → packet@2');
  });

  test('a change a run publishes reaches the published units of the stages that consume it, and no others', async () => {
    const query = 'SELECT module FROM clusters';
    const producers = { names: ['src'] };
    const consumers = { names: ['core'] };
    const untouched = { names: ['repo'] };
    const registry = new StageRegistry()
      .register(readingStage('snapshot', { units: producers, produces: ['file-facts'] }))
      // A consumer whose published generation the next run's plan does not name: only the sweep can reach it.
      .register(readingStage('modules', { query, units: consumers, consumes: ['file-facts'], produces: ['module-facts'] }))
      // A stage that consumes nothing this run's publications produce: its generation stands whatever moves.
      .register(readingStage('history', { query, units: untouched, optionalConsumes: ['commit-facts'], produces: ['commit'] }));
    const graph = fakeGraph({ [query]: [{ module: 'core' }] });
    // The consumer's named inputs never move: the change this test propagates is its read, and nothing else.
    const opened = await world({ registry, graph, inputs: (ref) => ({ commit: ref.stageId === 'modules' ? 'steady' : opened.commits.value }) });
    await driveOne(opened, 'run-1');
    for (const unitId of ['snapshot/src', 'modules/core', 'history/repo']) {
      expect((await readUnit(opened.owner, unitId))?.state).toBe('published');
    }

    // The next run's plan names the producer only, and the producer's inputs moved: what it publishes is the
    // change this run propagates, in the dependency order the declared capabilities give.
    consumers.names = [];
    untouched.names = [];
    // The producer publishes again for a reason of its own (the test moves its inputs), and the consumer's read is
    // what moved under the change: the propagation's own path is the read, so the assertion below names it.
    graph.rows.set(query, [{ module: 'core' }, { module: 'wiki' }]);
    opened.commits.value = 'ffeeddcc';
    const second = await driveOne(opened, 'run-2');
    expect(second.reused).toEqual([]);
    // The producer ran as the plan named it, the consumer was replaced into this run by the sweep and ran after
    // it, and the stage this run's facts feed nothing of stands as its record.
    const ran = (await readRunUnits(opened.owner, 'run-2')).map((unit) => `${unit.unitId}:${unit.generation}:${unit.state}`);
    expect(ran).toEqual(['modules/core:2:published', 'snapshot/src:2:published']);
    const propagated = (await readProgress(opened.owner, 'run-2'))
      .filter((event) => event.kind === 'unit-stale' && event.summary.includes('the change this run published reached it'));
    expect(propagated.map((event) => event.unitId)).toEqual(['modules/core']);
    // The scenario `reached-over-the-edges` names a moved read, and this one moved: the consumer's inputs stand
    // still (its stage names no commit), and its query answers one row more.
    expect(propagated[0]!.summary).toContain('a read the generation recorded answers something else now: SELECT module FROM clusters');
    // The stage nothing of this run's publications feeds was not rechecked and stands as its record.
    expect((await readUnit(opened.owner, 'history/repo'))?.generation).toBe(1);
    expect((await readUnit(opened.owner, 'history/repo'))?.runId).toBe('run-1');
  });

  test('a read the graph can no longer answer makes the generation stale instead of failing the planning or the sweep', async () => {
    // A commit that deletes a file an evidence span cited, or shortens it past the span's first line, leaves a
    // recorded read the reader refuses (`spanRow`). The update it is part of must read that as the read having
    // moved — the unit is replaced — and never as a failure of the run.
    const query = 'SELECT module FROM clusters';
    const units = { names: ['src'] };
    const registry = new StageRegistry().register(readingStage('snapshot', { query, units, produces: ['file-facts'] }));
    const graph = fakeGraph({ [query]: [{ module: 'core' }] });
    const opened = await world({ registry, graph });
    await driveOne(opened, 'run-1');
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('published');

    graph.reader = { query: async () => { throw new GraphReadRefusal(`src/fill/graph-reads.ts:1:1: the read of src/one.ts asks for line 3, and the file was deleted at this pin`); } };
    const started = await startRun(opened.orchestrator, { runId: 'run-2' });
    expect(started.ok).toBe(true);
    const plan = await planRun(opened.orchestrator, { runId: 'run-2' });
    expect(plan.outcome).toBe('planned');
    if (plan.outcome !== 'planned') return;
    expect(plan.reused).toEqual([]);
    expect(plan.units.map((unit) => `${unit.unitId}:${unit.generation}`)).toEqual(['snapshot/src:2']);
    const stale = (await readProgress(opened.owner, 'run-2')).filter((event) => event.kind === 'unit-stale');
    expect(stale.map((event) => event.unitId)).toEqual(['snapshot/src']);
    expect(stale[0]!.summary).toContain('can no longer be answered: SELECT module FROM clusters (src/fill/graph-reads.ts:1:1: the read of src/one.ts asks for line 3, and the file was deleted at this pin)');
  });

  test('a span record a previous build wrote, with its commit inside, replays normalized instead of raising', async () => {
    // The only form of a recorded span read there was before madarch-tzte.26.1 named the commit it was
    // read at; replayed at a run's own pin the reader refuses it, and the run must read that as the read
    // having moved — the generation is replaced — rather than fail. The reader here refuses any text that
    // still carries a commit, and answers the normalized form from the row the test put there.
    const normalized = recordedReadText(readText({ read: 'span', repository: 'acme-shop', commit: 'a'.repeat(40), file: 'src/one.ts', startLine: 1, endLine: 2 }));
    const spanRow = { repository: 'acme-shop', commit: 'b'.repeat(40), file: 'src/one.ts', startLine: 1, endLine: 2, totalLines: 2, lines: [{ line: 1, text: 'export const one = 1;' }, { line: 2, text: 'export const two = 2;' }] };
    const units = { names: ['src'] };
    const stage = fakeStage('snapshot', {
      produces: [{ kind: 'file-facts', schemaVersion: 1, scope: 'repository' }],
      plan: () => ({ units: units.names.map((scope) => ({ id: scope, scope })), coverage: 'planned' }),
      execute: () => ({ outcome: 'draft' }),
    });
    const registry = new StageRegistry().register(stage);
    const graph = fakeGraph({ [normalized]: [spanRow] });
    const opened = await world({ registry, graph });
    // The generation is published, and its read is recorded the old way: the text names the commit.
    await driveOne(opened, 'run-1');
    const oldText = readText({ read: 'span', repository: 'acme-shop', commit: 'a'.repeat(40), file: 'src/one.ts', startLine: 1, endLine: 2 });
    await recordUnitRead(opened.owner, { unitId: 'snapshot/src', generation: 1, query: oldText, rows: [spanRow], at: NOW });
    graph.reader = {
      query: async (text: string) => {
        if (text.includes('"commit"')) throw new GraphReadRefusal("the read pins src/one.ts at a commit, and the repository is pinned at another: an evidence span is read at the commit of the run\u0027s pin");
        return await graph.rows.get(text) ?? [];
      },
    };
    const sweep = await invalidateStaleUnits(opened.orchestrator, { runId: 'run-1' });
    expect(sweep.refused).toEqual([]);
    expect(sweep.invalidated.map((unit) => [unit.unitId, unit.generation, unit.replacement])).toEqual([['snapshot/src', 1, 2]]);
    expect(sweep.invalidated[0]!.cause).toContain('a read the generation recorded answers something else now:');
  });

  
  
  test('a span read whose bytes did not move at the new pin leaves its generation standing, and one whose bytes moved replaces it', async () => {
    // 0026, "Updates": a unit's cache key holds "the spans it read", and a span's key is the bytes — never the
    // commit they were read at. The span row a read answers is the reader's, so this walks the rule with a
    // reader whose answer the test writes.
    const spanText = recordedReadText(readText({ read: 'span', repository: 'acme-shop', commit: 'a'.repeat(40), file: 'src/one.ts', startLine: 1, endLine: 2 }));
    const spanRow = { repository: 'acme-shop', commit: 'b'.repeat(40), file: 'src/one.ts', startLine: 1, endLine: 2, totalLines: 3, lines: [{ line: 1, text: 'export const one = 1;' }, { line: 2, text: 'export const two = 2;' }] };
    const units = { names: ['src'] };
    const stage = fakeStage('snapshot', {
      produces: [{ kind: 'file-facts', schemaVersion: 1, scope: 'repository' }],
      plan: () => ({ units: units.names.map((scope) => ({ id: scope, scope })), coverage: 'planned' }),
      execute: async (unit, context) => {
        await context.graph.query(spanText);
        await writeFixtureFact(context, `${unit.scope}:1`, { kind: 'file-facts' });
        return { outcome: 'draft' };
      },
    });
    const registry = new StageRegistry().register(stage);
    const graph = fakeGraph({ [spanText]: [spanRow] });
    // The unit's named inputs stand still whatever commit the run pins: what this test moves is the pin, and the
    // only part of the cache key a pin can move is the span's bytes.
    const opened = await world({ registry, graph, inputs: () => ({ scope: 'src' }) });
    await driveOne(opened, 'run-1');
    // The commit moves, the bytes answer as they answered: nothing of the key moved, so the generation is inherited
    // rather than replaced — and the recorded span read still names the commit it was read at, which is the point.
    opened.commits.value = 'c'.repeat(40);
    const second = await driveOne(opened, 'run-2');
    expect(second.reused).toEqual(['snapshot/src']);
    // The bytes answer something else: the same read, another membership, and the generation is replaced.
    graph.rows.set(spanText, [{ ...spanRow, lines: [{ line: 1, text: 'export const one = 10;' }, { line: 2, text: 'export const two = 2;' }] }]);
    const third = await driveOne(opened, 'run-3');
    expect(third.reused).toEqual([]);
    const stale = (await readProgress(opened.owner, 'run-3')).filter((event) => event.kind === 'unit-stale');
    expect(stale.map((event) => event.unitId)).toEqual(['snapshot/src']);
    expect(stale[0]!.summary).toContain('a read the generation recorded answers something else now: ');
  });

  test('a stage the product disabled is no work of the update: its published generation stands, whatever moved', async () => {
    const query = 'SELECT module FROM clusters';
    const units = { names: ['src'] };
    const consumers = { names: ['core'] };
    const registry = new StageRegistry()
      .register(readingStage('snapshot', { units, produces: ['file-facts'] }))
      .register(readingStage('modules', { query, units: consumers, consumes: ['file-facts'], produces: ['module-facts'] }));
    const graph = fakeGraph({ [query]: [{ module: 'core' }] });
    // The product's configuration, as the manifest would state it: nothing switched off at first, the consumer's
    // stage disabled afterwards.
    const configuration: { value: { ok: true; file: string; stages: Record<string, unknown>; lines: Record<string, number> } | undefined } = { value: undefined };
    const opened = await world({ registry, graph, configuration: () => configuration.value });
    await driveOne(opened, 'run-1');
    expect((await readUnit(opened.owner, 'modules/core'))?.state).toBe('published');

    // The consumer's read moves and the producer publishes, but the product disabled the consumer's stage: the
    // generation of a stage this run does not run is left as its record (0026's "only affected units rerun" is
    // about the work the run owes, and a disabled stage owes none).
    consumers.names = [];
    graph.rows.set(query, [{ module: 'core' }, { module: 'wiki' }]);
    opened.commits.value = 'ffeeddcc';
    configuration.value = { ok: true, file: '/product/workspace.yaml', stages: { modules: { enabled: false } }, lines: { modules: 3 } };
    await driveOne(opened, 'run-2');
    expect((await readUnit(opened.owner, 'modules/core'))?.generation).toBe(1);
    expect((await readUnit(opened.owner, 'modules/core'))?.runId).toBe('run-1');
  });
});

describe('the second planning epoch of a first fill (madarch-tzte.26.3)', () => {
  /** A stage whose plan names its units from the graph, the way the agent stages of 0026 plan. */
  function graphPlanningStage(id: string, options: { query: string; consumes: readonly string[]; produces: readonly string[] }): FillStage {
    return fakeStage(id, {
      consumes: { required: options.consumes.map((capability) => ({ capability, scope: 'repository' as const })), optional: [] },
      produces: options.produces.map((kind) => ({ kind, schemaVersion: 1, scope: 'repository' as const })),
      plan: async (graph) => {
        const rows = await graph.query(options.query);
        return {
          units: rows.map((row) => {
            const scope = String((row as { scope?: unknown }).scope ?? '');
            return { id: scope, scope };
          }),
          ...(rows.length > 0 ? {} : { coverage: 'nothing-found' as const }),
        };
      },
      execute: async (unit, context) => {
        await context.graph.query(options.query);
        await writeFixtureFact(context, `${unit.scope}:1`, { kind: `${id}-facts` });
        return { outcome: 'draft' };
      },
    });
  }

  /** The reading stage the cache-key tests use, named here so the describe holds its own helpers. */
  function readingStageOf(id: string, options: { units: { names: string[] }; produces?: readonly string[] }): FillStage {
    return fakeStage(id, {
      produces: (options.produces ?? []).map((kind) => ({ kind, schemaVersion: 1, scope: 'repository' as const })),
      plan: () => ({ units: options.units.names.map((scope) => ({ id: scope, scope })), coverage: 'planned' as const }),
      execute: async (unit, context) => {
        await writeFixtureFact(context, `${unit.scope}:1`, { kind: `${id}-facts` });
        return { outcome: 'draft' };
      },
    });
  }

  /** Plans and drives one run to its end, answering what it planned. */
  async function plannedAndDriven(opened: World, runId: string): Promise<Extract<PlanOutcome, { outcome: 'planned' }>> {
    const started = await startRun(opened.orchestrator, { runId });
    expect(started.ok).toBe(true);
    const plan = await planRun(opened.orchestrator, { runId });
    if (plan.outcome !== 'planned') throw new Error(`the run ${runId} was not planned: ${JSON.stringify(plan)}`);
    const driven = await driveRun(opened.orchestrator, { runId });
    expect({ state: driven.run.state, settled: driven.settled }).toEqual({ state: 'succeeded', settled: true });
    return plan;
  }

  
  test('a second run of a filled product re-plans nothing: its publications are its plan\'s answer already', async () => {
    const query = 'SELECT scope FROM consumers';
    const registry = new StageRegistry()
      .register(readingStageOf('snapshot', { units: { names: ['src'] }, produces: ['file-facts'] }))
      .register(graphPlanningStage('overview', { query, consumes: ['file-facts'], produces: ['product-overview'] }));
    const graph = fakeGraph({ [query]: [{ scope: 'product' }] });
    const opened = await world({ registry, graph });
    await plannedAndDriven(opened, 'run-1');
    // The second run plans against the graph the first filled: every stage names its units, every unit
    // stands under a key that did not move, and nothing is planned again — no publication of its own
    // re-opens the planning epoch, for there is nothing its stages have not answered.
    const plan = await plannedAndDriven(opened, 'run-2');
    expect(plan.units).toEqual([]);
    expect(plan.reused).toEqual(['snapshot/src', 'overview/product']);
    const run = await readRun(opened.owner, 'run-2');
    expect(run?.context).toEqual({ planningEpoch: 1, planningClosed: true });
    const events = await readProgress(opened.owner, 'run-2');
    expect(events.map((event) => event.kind)).not.toContain('run-replanned');
  });
});

describe('the fill tables reference each other', () => {
  test('every run-scoped row names its run, and every unit row its unit and generation, by a foreign key', async () => {
    const owner = await createTestDatabaseOwner();
    try {

      await createOrchestratorSchema(owner);
      const found = await owner.run((transaction) => transaction.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint WHERE contype = 'f' AND conrelid::regclass::text LIKE 'fill\_%' ORDER BY conname`,
      ));
      expect(found.rows.map((row) => row.conname)).toEqual([
        'fill_control_run_fk',
        'fill_end_run_fk',
        'fill_event_generation_fk',
        'fill_event_run_fk',
        'fill_publication_generation_fk',
        'fill_run_configuration_run_fk',
        'fill_run_stage_run_fk',
        'fill_unit_generation_unit_fk',
        'fill_unit_plan_generation_fk',
        'fill_unit_plan_run_fk',
        'fill_unit_read_generation_fk',
        'fill_unit_split_child_fk',
        'fill_unit_split_parent_fk',
      ]);
    } finally {
      await owner.close();
    }
  }, 60_000);
});


test('declaration scheduling admits unrelated producers but waits for publication and producer slots', async () => {
  const stage = fakeStage('declared', {
    defaults: { ...DEFAULT_STAGE_DEFAULTS, concurrency: 4 },
    plan: () => ({ units: [
      { id: 'writer:a', scope: 'a' }, { id: 'writer:b', scope: 'b' },
      { id: 'reader:c', scope: 'c' }, { id: 'unrelated:d', scope: 'd' },
    ] }),
    unitScheduling(id) { return { group: id.split(':')[0]!, concurrency: 1, after: id.startsWith('reader:') ? ['writer:a', 'writer:b'] : [] }; },
  });
  const opened = await world({ registry: new StageRegistry().register(stage) });
  const started = await startRun(opened.orchestrator, { runId: 'declaration-scheduling' });
  if (!started.ok) throw new Error(started.reason);
  await planRun(opened.orchestrator, { runId: started.run.runId });
  const admitted = await admitUnits(opened.orchestrator, { runId: started.run.runId });
  expect(admitted.admitted.map((unit) => unit.unitId)).toEqual(['declared/writer:a', 'declared/unrelated:d']);
  await workOnce(opened.orchestrator, { worker: 'scripted' });
  const second = await admitUnits(opened.orchestrator, { runId: started.run.runId });
  expect(second.admitted.map((unit) => unit.unitId)).toEqual(['declared/writer:b']);
  await workOnce(opened.orchestrator, { worker: 'scripted' });
  await workOnce(opened.orchestrator, { worker: 'scripted' });
  const third = await admitUnits(opened.orchestrator, { runId: started.run.runId });
  expect(third.admitted.map((unit) => unit.unitId)).toEqual(['declared/reader:c']);
});


describe('immediate operation transactions (decision 0039)', () => {
  async function publicationFixture() {
    const opened = await world({ registry: new StageRegistry() });
    const queued = await opened.queue.enqueue({ queue: QUEUE, data: {}, singletonKey: 'publication' });
    const [job] = await opened.queue.claim({ queue: QUEUE });
    expect(queued.created).toBe(true);
    const scope = await opened.owner.transaction('write', async tx => {
      const { binding, contract } = await startupBinding(tx, EMPTY_CONTRACT, 'publication-fixture');
      return { binding, contract, ...await resolveOperationScope(tx, contract, binding, { runId: 'publication', unitId: 'publication/unit', generation: 1 }) };
    });
    let completions = 0;
    const queue = new Proxy(opened.queue, { get(target, key) {
      if (key === 'complete') return async (...args: Parameters<QueueService['complete']>) => {
        const settled = await target.complete(...args);
        if (settled) completions++;
        return settled;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const host = createOperationHost({ owner: opened.owner, queue, job: job!, capability: scope.binding, ...scope });
    const database = (await opened.owner.run(tx => tx.query<{name:string}>('SELECT current_database() AS name'))).rows[0]!.name;
    const other = await createDatabaseOwner({ cluster: { socketDir: process.env.MADARCH_TEST_PG_SOCKET! }, database, connectOnly: true });
    opened.owner.onClose(async () => await other.close());
    const heartbeatOwner = Object.create(other) as typeof other;
    heartbeatOwner.run = async work => await other.transaction('write', async tx => {
      await tx.query("SET LOCAL lock_timeout = '500ms'");
      return await work(tx);
    });
    const heartbeatQueue = await createPgBossQueue({ owner: heartbeatOwner, supervise: false });
    await heartbeatQueue.declare({ name: QUEUE, leaseSeconds: DEFAULT_ORCHESTRATOR_LIMITS.attemptSeconds, heartbeatSeconds: 30, retries: 0, retryDelaySeconds: 0, retryBackoff: false, singletons: true });
    const heartbeat = async () => { await heartbeatQueue.heartbeat(QUEUE, job!); };
    const snapshot = async () => {
      const counts = (await opened.owner.run(tx => tx.query(`SELECT (SELECT count(*) FROM node) AS nodes, (SELECT count(*) FROM edge) AS edges, (SELECT count(*) FROM assertion) AS assertions`))).rows;
      return { counts, unit: await readUnit(opened.owner, 'publication/unit') };
    };
    // A separate connection must finish while the graph transaction is open.
    // lock_timeout makes the old early fence fail promptly, not hang the test.
    const concurrent = async (work: (tx: import('../src/history-types.js').OuterTransaction) => Promise<void>) =>
      await other.transaction('write', async tx => {
        await tx.query("SET LOCAL lock_timeout = '500ms'");
        await work(tx);
      });
    const lapse = async () => await concurrent(async tx => {
      await tx.query(`UPDATE ${QUEUE_SCHEMA}.job SET retry_count = retry_count + 1 WHERE id = $1`, [job!.id]);
    });
    return { opened, job: job!, host, scope, snapshot, concurrent, lapse, heartbeat, completions: () => completions };
  }

  test('completion fence: a live body outlasts heartbeatSeconds and publishes without deadlock', async () => {
    const f = await publicationFixture();
    await f.opened.owner.run(tx => tx.query(`UPDATE ${QUEUE_SCHEMA}.job SET heartbeat_seconds = 3, heartbeat_on = clock_timestamp() WHERE id = $1`, [f.job.id]));
    const deadlocks = async () => (await f.opened.owner.run(tx => tx.query<{deadlocks:number}>(`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`))).rows[0]!.deadlocks;
    const before = await deadlocks();
    let heartbeatError: unknown;
    let touching = Promise.resolve();
    const heartbeat = f.heartbeat;
    const timer = setInterval(() => { touching = touching.then(heartbeat).catch(error => { heartbeatError = error; }); }, 250);
    try {
    await f.host.execute({ key: 'live', request: {}, completion: { output: { ok: true }, enqueue: [] } }, async tx => {
      const start = (await tx.query<{at:number}>('SELECT extract(epoch FROM clock_timestamp())::float8 AS at')).rows[0]!.at;
      for (let i = 0; i < 4; i++) {
        await tx.query('SELECT pg_sleep(1)');
        await heartbeat();
      }
      const end = (await tx.query<{at:number}>('SELECT extract(epoch FROM clock_timestamp())::float8 AS at')).rows[0]!.at;
      expect(end - start).toBeGreaterThan(3);
      return { accepted: true };
    });
    } finally {
      clearInterval(timer);
      await touching;
    }
    expect(heartbeatError).toBeUndefined();
    expect(await f.opened.queue.job(QUEUE, f.job.id)).toMatchObject({ state: 'completed', output: { ok: true } });
    expect(await f.opened.owner.transaction('snapshot', tx => operationReceipt(tx, EMPTY_CONTRACT, f.scope.unitUid, 'live'))).toBeDefined();
    expect((await readUnit(f.opened.owner, 'publication/unit'))?.state).toBe('published');
    expect(await deadlocks()).toBe(before);
    console.log(`completion fence deadlocks: ${before} -> ${await deadlocks()}`);
  }, 30_000);

  test.each(['execute', 'fail'] as const)('completion fence: ownership lost during %s rolls back every graph write', async path => {
    const f = await publicationFixture();
    const before = await f.snapshot();
    const apply = async (tx: import('../src/history-types.js').OuterTransaction) => {
      await putFillVertexIn(tx, 'system.unit', f.scope.unitUid, { state: 'failed', reason: 'uncommitted body' });
      await f.lapse();
    };
    const result = path === 'execute'
      ? f.host.execute({ key: 'lost', request: {}, completion: { output: {}, enqueue: [] } }, apply)
      : f.host.fail('lost ownership', apply);
    await expect(result).rejects.toBeInstanceOf(AttemptStaleError);
    expect(await f.snapshot()).toEqual(before);
    expect(await f.opened.owner.transaction('snapshot', tx => operationReceipt(tx, EMPTY_CONTRACT, f.scope.unitUid, 'lost'))).toBeUndefined();
    expect(await f.opened.queue.job(QUEUE, f.job.id)).toEqual({ state: 'active' });
    expect((await f.opened.owner.run(tx => tx.query<{retry_count:number}>(`SELECT retry_count FROM ${QUEUE_SCHEMA}.job WHERE id=$1`, [f.job.id]))).rows[0]!.retry_count).toBe(f.job.attempt + 1);
  }, 30_000);

  test('completion fence: an idempotent receipt completes its job only once', async () => {
    const f = await publicationFixture();
    const request = { key: 'repeat', request: {}, completion: { output: { ok: true }, enqueue: [] } };
    expect(await f.host.execute(request, async () => 42)).toBe(42);
    const before = await f.snapshot();
    expect(await f.host.execute<number>(request, async () => { throw new Error('receipt must not reapply'); })).toBe(42);
    expect(await f.snapshot()).toEqual(before);
    expect(f.completions()).toBe(1);
    expect(await f.opened.queue.job(QUEUE, f.job.id)).toMatchObject({ state: 'completed', output: { ok: true } });
  }, 30_000);

  test('a serialization failure rolls back the operation and a later attempt commits it', async () => {
    const owner = await createTestDatabaseOwner();
    let inject = false;
    const lending = Object.create(owner) as TestDatabaseOwner;
    lending.transaction = async (kind, work) => await owner.transaction(kind, async tx => {
      const value = await work(tx);
      if (kind === 'write' && inject) {
        inject = false;
        throw Object.assign(new Error('could not serialize access due to concurrent update'), { code: '40001' });
      }
      return value;
    });
    let unitUid: string | undefined;
    const stage = fakeStage('snapshot', {
      produces: [{ kind: 'file-facts', schemaVersion: 1, scope: 'repository' }],
      plan: () => ({ units: [{ id: 'src', scope: 'src' }], coverage: 'planned' }),
      execute: async (_unit, context) => {
        unitUid = context.operationUnitUid;
        inject = true;
        await writeFixtureFact(context, 'src:1', { kind: 'file-facts' });
        return { outcome: 'draft' };
      },
    });
    try {
      const { world: opened, runId } = await plannedWorld({ registry: new StageRegistry().register(stage), owner: lending, limits: { retryDelayMs: 0 } });
      await admitUnits(opened.orchestrator, { runId });
      expect((await workOnce(opened.orchestrator, { worker: 'worker-1' })).result).toBe('retried');
      expect(unitUid).toBeDefined();
      expect(await owner.transaction('snapshot', async tx => await operationReceipt(tx, EMPTY_CONTRACT, unitUid!, 'fixture-fact'))).toBeUndefined();
      stage.execute = async (_unit, context) => {
        await writeFixtureFact(context, 'src:1', { kind: 'file-facts' });
        return { outcome: 'draft' };
      };
      opened.clock.advance(1_000);
      expect((await driveRun(opened.orchestrator, { runId, workers: 1 })).settled).toBe(true);
      expect((await readUnit(owner, 'snapshot/src'))?.state).toBe('published');
      expect(await owner.transaction('snapshot', async tx => await operationReceipt(tx, EMPTY_CONTRACT, unitUid!, 'fixture-fact'))).toBeDefined();
    } finally {
      const opened = worlds.pop();
      if (opened !== undefined) await opened.close();
      await owner.close();
    }
  }, 60_000);

  test('a cached success cannot authorize a different current generation', async () => {
    const stage = writingStage('plugin-turns', { units: ['producer', 'consumer'], concurrency: 2 });
    stage.unitScheduling = id => ({ after: id === 'consumer' ? ['producer'] : [], group: id, concurrency: 1 });
    const { world: opened, runId } = await plannedWorld({ registry: new StageRegistry().register(stage) });
    expect((await admitUnits(opened.orchestrator, { runId })).admittedNow).toBe(1);
    expect((await workOnce(opened.orchestrator, { worker: 'worker-1' })).result).toBe('published');
    await writeOrchestration(opened.owner, tx => advanceUnitIn(tx, { unitId: 'plugin-turns/producer', event: { type: 'invalidate', at: NOW + 1, replacement: 2, cause: 'producer now abstains' } }));
    expect((await writeOrchestration(opened.owner, tx => replaceStaleGenerationIn(tx, { unitId: 'plugin-turns/producer', runId, inputsDigest: 'abstained', retries: 0, at: NOW + 2 }))).ok).toBe(true);
    await opened.owner.transaction('write', async tx => {
      const uid = await readUnitGraphUidIn(tx, 'plugin-turns/producer', 2);
      if (uid === undefined) throw new Error('replacement fixture unit is absent');
      await putFillVertexIn(tx, 'system.unit', uid, { state: 'published', producer: 'fixture', produced_kind: 'Document', outcome: 'abstained', produced: 0 });
    });
    expect((await admitUnits(opened.orchestrator, { runId })).admittedNow).toBe(0);
    expect((await readUnit(opened.owner, 'plugin-turns/consumer'))?.state).toBe('blocked');
  }, 60_000);

  test('a stop written through the run state machine cancels its units', async () => {
    const { world: opened, runId } = await plannedWorld({ registry: new StageRegistry().register(writingStage('snapshot', { units: ['src'] })) });
    expect((await cancelRun(opened.orchestrator, { runId, cause: 'the person stopped the run' })).run.state).toBe('cancelled');
    expect((await readRunUnits(opened.owner, runId)).every(unit => isFinalUnitState(unit.state))).toBe(true);
  });

  test('the same live run may be started again without ending its units', async () => {
    const { world: opened, runId } = await plannedWorld({ registry: new StageRegistry().register(writingStage('snapshot', { units: ['src'] })) });
    await admitUnits(opened.orchestrator, { runId });
    expect((await startRun(opened.orchestrator, { runId })).ok).toBe(true);
    expect((await readRun(opened.owner, runId))?.state).toBe('running');
    expect((await readRunUnits(opened.owner, runId)).some(unit => !isFinalUnitState(unit.state))).toBe(true);
  });

  test.each([undefined, 45, 10])('unit attempt ceiling includes exact host margins for %s minutes', minutes => {
    expect(unitJobAttemptSeconds(minutes)).toBe(minutes === 45 ? 3070 : 2170);
  });

  test('a product declaring 45 minutes keeps a 40-minute unit claim', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'madarch-long-unit-'));
    const owner = await createTestDatabaseOwner();
    lentOwners.push(owner);
    const clock = testClock();
    const pinned = await pinnedBoundWiring(folder, owner, 'minutes: 45');
    const stage = fakeStage('snapshot', {
      plan: () => ({ units: [{ id: 'src', scope: 'src' }], coverage: 'planned' }),
      execute: async () => {
        clock.advance(40 * 60_000);
        await owner.run(tx => tx.query(`UPDATE ${QUEUE_SCHEMA}.job SET started_on = clock_timestamp() - interval '40 minutes' WHERE name = $1 AND state = 'active'`, [QUEUE]));
        return { outcome: 'draft' };
      },
    });
    let attemptSeconds = DEFAULT_ORCHESTRATOR_LIMITS.attemptSeconds;
    const registry = new StageRegistry().register(stage);
    const service = trackedService({
      owner, registry, clock: clock.now,
      queueFactory: async owner => {
        const queue = await createPgBossQueue({ owner, supervise: false });
        return new Proxy(queue, { get: (target, key) => {
          if (key === 'declare') return async (declaration: Parameters<QueueService['declare']>[0]) => { attemptSeconds = declaration.leaseSeconds; await target.declare(declaration); };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      },
      wiring: () => ({ ...pinned.wiring, graphContract: EMPTY_CONTRACT, operations: fixtureOperations(owner), snapshot: () => SNAPSHOT, configuration: () => undefined, graph: () => fakeGraph().reader, inputs: () => ({}) }),
    });
    try {
      await service.status({ product: { name: 'long-unit', folder }, runId: 'long-unit' });
      const { world: opened, runId } = await plannedWorld({ registry, owner, clock, limits: { attemptSeconds } });
      await admitUnits(opened.orchestrator, { runId });
      expect((await workOnce(opened.orchestrator, { worker: 'worker-1' })).result).toBe('published');
      await opened.close();
      worlds.pop();
      expect((await readUnit(owner, 'snapshot/src'))?.state).toBe('published');
      expect(attemptSeconds).toBe(3070);
    } finally {
      await service.stop();
      await owner.close();
      await rm(folder, { recursive: true, force: true });
    }
  }, 15_000);

  test('a plugin without minutes preserves a caller-lowered attempt ceiling', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'madarch-short-unit-'));
    const owner = await createTestDatabaseOwner();
    lentOwners.push(owner);
    const pinned = await pinnedBoundWiring(folder, owner, 'tokens: 100');
    let attemptSeconds = 0;
    const service = trackedService({
      owner, registry: new StageRegistry(), limits: { attemptSeconds: 12 },
      queueFactory: async owner => {
        const queue = await createPgBossQueue({ owner, supervise: false });
        return new Proxy(queue, { get: (target, key) => {
          if (key === 'declare') return async (declaration: Parameters<QueueService['declare']>[0]) => { attemptSeconds = declaration.leaseSeconds; await target.declare(declaration); };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      },
      wiring: () => ({ ...pinned.wiring, graphContract: EMPTY_CONTRACT, operations: fixtureOperations(owner), snapshot: () => SNAPSHOT, configuration: () => undefined, graph: () => fakeGraph().reader, inputs: () => ({}) }),
    });
    try {
      await service.status({ product: { name: 'short-unit', folder }, runId: 'short-unit' });
      expect(attemptSeconds).toBe(12);
    } finally {
      await service.stop();
      await owner.close();
      await rm(folder, { recursive: true, force: true });
    }
  });

  test('a stage longer than the old claim still publishes', async () => {
    let expire: () => Promise<void>;
    const stage = writingStage('snapshot', { units: ['src'] });
    const execute = stage.execute;
    stage.execute = async (...args) => { await expire(); return await execute(...args); };
    const { world: opened, runId } = await plannedWorld({ registry: new StageRegistry().register(stage) });
    expire = async () => { await opened.owner.run(tx => tx.query(`UPDATE ${QUEUE_SCHEMA}.job SET started_on = clock_timestamp() - interval '61 seconds' WHERE name = $1 AND state = 'active'`, [QUEUE])); };
    await admitUnits(opened.orchestrator, { runId });
    expect((await workOnce(opened.orchestrator, { worker: 'worker-1' })).result).toBe('published');
  });

  test.each(['retry', 'exhausted', 'bound', 'complete'] as const)('a lapsed claim is refused on %s without an operation', async path => {
    let expire: () => Promise<void>;
    let unitUid: string | undefined;
    const stage = fakeStage('snapshot', {
      plan: () => ({ units: [{ id: 'src', scope: 'src' }], coverage: 'planned' }),
      execute: async (_unit, context) => {
        unitUid = context.operationUnitUid;
        await expire();
        if (path === 'bound') throw new UnitBoundStop('agent-time', 'stage bound after expiry');
        if (path !== 'complete') throw new Error('stage failed after expiry');
        return { outcome: 'draft' };
      },
    });
    const { world: opened, runId } = await plannedWorld({ registry: new StageRegistry().register(stage), limits: { retries: path === 'exhausted' ? 0 : 1 } });
    expire = async () => { await opened.owner.run(tx => tx.query(`UPDATE ${QUEUE_SCHEMA}.job SET started_on = clock_timestamp() - (expire_seconds + 1) * interval '1 second' WHERE name = $1 AND state = 'active'`, [QUEUE])); };
    await admitUnits(opened.orchestrator, { runId });
    expect(await workOnce(opened.orchestrator, { worker: 'worker-1' })).toMatchObject({ result: 'refused', refusal: { code: 'fill-orchestrator/claim-lapsed' }, job: 'none' });
    expect(await opened.owner.transaction('snapshot', tx => operationReceipt(tx, EMPTY_CONTRACT, unitUid!, path === 'retry' ? 'retry:0' : 'complete'))).toBeUndefined();
    const refused = (await readProgress(opened.owner, runId)).filter(event => event.kind === 'unit-refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]!.summary).toContain('fill-orchestrator/claim-lapsed');
    expect(refused[0]!.summary).toContain('The queue no longer held its claim');
    if (path !== 'complete') expect(refused[0]!.summary).toContain(path === 'bound' ? 'stage bound after expiry' : 'stage failed after expiry');
  });

  test('heartbeat runs through the whole attempt and stops afterwards', async () => {
    let heartbeats = 0;
    const stage = fakeStage('snapshot', {
      plan: () => ({ units: [{ id: 'src', scope: 'src' }], coverage: 'planned' }),
      execute: async () => { heartbeats = 0; await Bun.sleep(600); expect(heartbeats).toBeGreaterThanOrEqual(2); return { outcome: 'draft' }; },
    });
    const { world: opened, runId } = await plannedWorld({
      registry: new StageRegistry().register(stage),
      limits: { heartbeatSeconds: 0.6 },
      queueFactory: queue => new Proxy(queue, {
        get: (target, key) => {
          if (key === 'heartbeat') return async (...args: Parameters<QueueService['heartbeat']>) => { heartbeats++; return await target.heartbeat(...args); };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    });
    await admitUnits(opened.orchestrator, { runId });
    expect((await workOnce(opened.orchestrator, { worker: 'worker-1' })).result).toBe('published');
    const finished = heartbeats;
    await Bun.sleep(400);
    expect(heartbeats).toBe(finished);
  }, 15_000);

  test('heartbeat false aborts the attempt and stops touching', async () => {
    let heartbeats = 0;
    let aborted = false;
    const stage = fakeStage('snapshot', {
      plan: () => ({ units: [{ id: 'src', scope: 'src' }], coverage: 'planned' }),
      execute: async (_unit, context) => {
        await new Promise<void>(resolve => {
          if (context.signal.aborted) { aborted = true; resolve(); }
          else context.signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true });
        });
        return { outcome: 'draft' };
      },
    });
    const { world: opened, runId } = await plannedWorld({
      registry: new StageRegistry().register(stage), limits: { heartbeatSeconds: 0.6 },
      queueFactory: queue => new Proxy(queue, {
        get: (target, key) => {
          if (key === 'heartbeat') return async (...args: Parameters<QueueService['heartbeat']>) => {
            heartbeats++;
            if (heartbeats === 1) return await target.heartbeat(...args);
            await opened.owner.run(tx => tx.query(`UPDATE ${QUEUE_SCHEMA}.job SET started_on = NULL WHERE id = $1`, [args[1].id]));
            return false;
          };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    });
    await admitUnits(opened.orchestrator, { runId });
    expect(await workOnce(opened.orchestrator, { worker: 'worker-1' })).toMatchObject({ result: 'refused', refusal: { code: 'fill-orchestrator/claim-lapsed' }, job: 'none' });
    expect(aborted).toBe(true);
    const finished = heartbeats;
    await Bun.sleep(400);
    expect(heartbeats).toBe(finished);
  }, 15_000);

  /**
   * The queue a transient touch failure is made from: the first touch is answered for real, the second rejects
   * with `failure`, and the third marks `touched` — so a stage that waits for the mark continues only after the
   * rejection has been handled, whatever order the runtime runs the microtasks in.
   */
  function touchingQueue(failure: Error, touched: () => void, fenceLapsed?: () => boolean): (queue: QueueService) => QueueService {
    let heartbeats = 0;
    return queue => new Proxy(queue, {
      get: (target, key) => {
        if (key === 'heartbeat') return async (...args: Parameters<QueueService['heartbeat']>) => {
          if (++heartbeats === 2) throw failure;
          if (heartbeats === 3) touched();
          return await target.heartbeat(...args);
        };
        if (key === 'fence' && fenceLapsed !== undefined) return async (...args: Parameters<QueueService['fence']>) => fenceLapsed() ? false : await target.fence(...args);
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  test('a transient heartbeat rejection keeps the finished stage result and is recorded', async () => {
    const failure = new Error('heartbeat storage failure');
    const logged: string[] = [];
    let aborted = false;
    let touched!: () => void;
    const touches = new Promise<void>(resolve => { touched = resolve; });
    const stage = fakeStage('snapshot', {
      plan: () => ({ units: [{ id: 'src', scope: 'src' }], coverage: 'planned' }),
      execute: async (_unit, context) => {
        context.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
        await touches;
        return { outcome: 'draft' };
      },
    });
    const { world: opened, runId } = await plannedWorld({
      registry: new StageRegistry().register(stage), limits: { heartbeatSeconds: 0.6 },
      log: line => logged.push(line),
      queueFactory: touchingQueue(failure, () => touched()),
    });
    await admitUnits(opened.orchestrator, { runId });
    expect(await workOnce(opened.orchestrator, { worker: 'worker-1' })).toMatchObject({ result: 'published', job: 'completed' });
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('published');
    expect(aborted).toBe(false);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('snapshot/src');
    expect(logged[0]).toContain('heartbeat storage failure');
  }, 15_000);

  test('a lapsed claim after a heartbeat rejection is refused, not published', async () => {
    const failure = new Error('heartbeat storage failure');
    const logged: string[] = [];
    let lapsed = false;
    let touched!: () => void;
    const touches = new Promise<void>(resolve => { touched = resolve; });
    const stage = fakeStage('snapshot', {
      plan: () => ({ units: [{ id: 'src', scope: 'src' }], coverage: 'planned' }),
      execute: async () => { await touches; lapsed = true; return { outcome: 'draft' }; },
    });
    const { world: opened, runId } = await plannedWorld({
      registry: new StageRegistry().register(stage), limits: { heartbeatSeconds: 0.6 },
      log: line => logged.push(line),
      queueFactory: touchingQueue(failure, () => touched(), () => lapsed),
    });
    await admitUnits(opened.orchestrator, { runId });
    expect(await workOnce(opened.orchestrator, { worker: 'worker-1' })).toMatchObject({ result: 'refused', refusal: { code: 'fill-orchestrator/claim-lapsed' }, job: 'none' });
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).not.toBe('published');
    const events = await readProgress(opened.owner, runId);
    expect(events.filter(event => event.kind === 'unit-published')).toHaveLength(0);
    expect(logged.some(line => line.includes('heartbeat storage failure'))).toBe(true);
  }, 15_000);

  test('a stage raise keeps its own reason when a touch failed', async () => {
    const failure = new Error('heartbeat storage failure');
    const stageFailure = new Error('stage failed while heartbeat failed');
    const logged: string[] = [];
    let touched!: () => void;
    const touches = new Promise<void>(resolve => { touched = resolve; });
    const stage = fakeStage('snapshot', {
      plan: () => ({ units: [{ id: 'src', scope: 'src' }], coverage: 'planned' }),
      execute: async () => { await touches; throw stageFailure; },
    });
    const { world: opened, runId } = await plannedWorld({
      registry: new StageRegistry().register(stage), limits: { heartbeatSeconds: 0.6, retries: 0 },
      log: line => logged.push(line),
      queueFactory: touchingQueue(failure, () => touched()),
    });
    await admitUnits(opened.orchestrator, { runId });
    expect(await workOnce(opened.orchestrator, { worker: 'worker-1' })).toMatchObject({ result: 'failed', summary: 'the stage raised: stage failed while heartbeat failed' });
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('failed');
    expect(logged.some(line => line.includes('heartbeat storage failure'))).toBe(true);
  }, 15_000);

  test.each(['complete', 'bound', 'blocked', 'split'] as const)('attempt cleanup traces a deferred heartbeat rejection after %s commits', async path => {
    const failure = new Error('deferred heartbeat failure');
    let terminalCommitted!: () => void;
    const committed = new Promise<void>(resolve => { terminalCommitted = resolve; });
    let heartbeatStarted!: () => void;
    const touched = new Promise<void>(resolve => { heartbeatStarted = resolve; });
    let rejectTouch!: (error: Error) => void;
    let calls = 0;
    const deferred = new Promise<boolean>((_resolve, reject) => { rejectTouch = reject; });
    const stage = fakeStage('snapshot', {
      plan: () => ({ units: [{ id: 'src', scope: 'src' }], coverage: 'planned' }),
      execute: async () => {
        await touched;
        if (path === 'bound') throw new UnitBoundStop('agent-time', 'stage time bound');
        if (path === 'blocked') return { outcome: 'blocked', reason: 'needs input' };
        if (path === 'split') return { outcome: 'split', children: [{ id: 'child', scope: 'child' }] };
        return { outcome: 'draft' };
      },
    });
    const { world: opened, runId } = await plannedWorld({
      registry: new StageRegistry().register(stage), limits: { heartbeatSeconds: 0.6 },
      sink: event => { if (['unit-published', 'unit-failed', 'unit-blocked', 'unit-split'].includes(event.kind)) terminalCommitted(); },
      queueFactory: queue => new Proxy(queue, {
        get: (target, key) => {
          if (key === 'heartbeat') return async (...args: Parameters<QueueService['heartbeat']>) => {
            if (++calls === 1) return await target.heartbeat(...args);
            heartbeatStarted();
            return await deferred;
          };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    });
    await admitUnits(opened.orchestrator, { runId });
    let finished = false;
    const work = workOnce(opened.orchestrator, { worker: 'worker-1' }).finally(() => { finished = true; });
    await committed;
    const returnedBeforeHeartbeat = finished;
    rejectTouch(failure);
    expect(await work).toMatchObject({ result: path === 'complete' ? 'published' : path === 'bound' ? 'failed' : path });
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe(path === 'complete' ? 'published' : path === 'bound' ? 'failed' : path === 'split' ? 'waiting_children' : 'blocked');
    expect(returnedBeforeHeartbeat).toBe(false);
  }, 15_000);

  test('a claim lost at the start fence is refused and recorded', async () => {
    const { world: opened, runId } = await plannedWorld({
      registry: new StageRegistry().register(writingStage('snapshot', { units: ['src'] })),
      queueFactory: queue => new Proxy(queue, {
        get: (target, key) => {
          if (key === 'fence') return async () => false;
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    });
    await admitUnits(opened.orchestrator, { runId });
    expect(await workOnce(opened.orchestrator, { worker: 'worker-1' })).toMatchObject({ result: 'refused', refusal: { code: 'fill-orchestrator/claim-lapsed' } });
    expect((await readUnit(opened.owner, 'snapshot/src'))?.context.attempt).toBe(0);
    expect((await readProgress(opened.owner, runId)).some(event => event.kind === 'unit-refused' && event.summary.includes('ATTEMPT_STALE start'))).toBe(true);
  });

  test('a typed stale stage operation is refused without retrying', async () => {
    let unitUid: string | undefined;
    const stage = fakeStage('snapshot', {
      plan: () => ({ units: [{ id: 'src', scope: 'src' }], coverage: 'planned' }),
      execute: async (_unit, context) => { unitUid = context.operationUnitUid; throw new AttemptStaleError('stage operation lost its claim'); },
    });
    const { world: opened, runId } = await plannedWorld({ registry: new StageRegistry().register(stage) });
    await admitUnits(opened.orchestrator, { runId });
    expect(await workOnce(opened.orchestrator, { worker: 'worker-1' })).toMatchObject({ result: 'refused', refusal: { code: 'fill-orchestrator/claim-lapsed' }, job: 'none' });
    expect(await opened.owner.transaction('snapshot', tx => operationReceipt(tx, EMPTY_CONTRACT, unitUid!, 'retry:0'))).toBeUndefined();
  });

  test('a worker killed inside its attempt is retried after the queue expires its claim', async () => {
    const { world: opened, runId } = await plannedWorld({ registry: new StageRegistry().register(writingStage('snapshot', { units: ['src'] })), limits: { retries: 1, retryDelayMs: 0 } });
    await admitUnits(opened.orchestrator, { runId });
    const claimed = (await opened.queue.claim<{ unitId: string }>({ queue: QUEUE }))[0]!;
    expect(claimed.data.unitId).toBe('snapshot/src');
    expect((await writeOrchestration(opened.owner, tx => advanceUnitIn(tx, { unitId: 'snapshot/src', event: { type: 'start', at: NOW, generation: 1, fence: claimed.attempt, attempt: claimed.attempt } }))).ok).toBe(true);
    await opened.owner.run(tx => tx.query(`UPDATE ${QUEUE_SCHEMA}.job SET started_on = now() - interval '1 hour', expire_seconds = 1 WHERE id = $1`, [claimed.id]));
    await opened.queue.recover(QUEUE);
    await sweepUnits(opened.orchestrator, { runId });
    opened.clock.advance(1_000);
    await sweepUnits(opened.orchestrator, { runId });
    expect((await workOnce(opened.orchestrator, { worker: 'worker-2' })).result).toBe('published');
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('published');
  }, 60_000);

  test('a block refused after cancellation settles the attempt claim', async () => {
    let cancel: (() => Promise<void>) | undefined;
    const stage = fakeStage('snapshot', {
      produces: [{ kind: 'file-facts', schemaVersion: 1, scope: 'repository' }],
      plan: () => ({ units: [{ id: 'src', scope: 'src' }], coverage: 'planned' }),
      execute: async () => {
        await cancel!();
        return { outcome: 'blocked', reason: 'the stage cannot continue' };
      },
    });
    const { world: opened, runId } = await plannedWorld({ registry: new StageRegistry().register(stage) });
    await admitUnits(opened.orchestrator, { runId });
    cancel = async () => {
      expect((await writeOrchestration(opened.owner, tx => advanceUnitIn(tx, { unitId: 'snapshot/src', event: { type: 'cancel', at: NOW + 1, cause: 'the run is stopping' } }))).ok).toBe(true);
    };
    expect((await workOnce(opened.orchestrator, { worker: 'worker-1' })).result).toBe('refused');
    const rows = await opened.owner.run(async tx => (await tx.query<{ state: string }>(`SELECT state FROM ${QUEUE_SCHEMA}.job WHERE name = $1 AND state IN ('created', 'retry', 'active')`, [QUEUE])).rows);
    expect(rows).toEqual([]);
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('cancelled');
  }, 30_000);
});
