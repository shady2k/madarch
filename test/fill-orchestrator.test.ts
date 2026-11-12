/**
 * The fill's orchestrator with fake stages (madarch-tzte.19.5, decision 0027):
 * planning from the registry, admission within the concurrency slots by priority
 * with ageing, leases under fencing tokens, a split with a sealed child set and
 * its limits, a parent's join once its children are published and fresh,
 * staleness from tracked reads including empty results, a cancellation that
 * revokes authority, and one publication per generation with the same digest
 * answering the existing record and a different one refused.
 *
 * Every expectation here is taken from decision 0027 and from the task, never
 * from the module: the states, the effects, the limits and the digest rules are
 * the decision's words. Time is a seam the test moves by hand — no test sleeps —
 * and the only things real are the ones the orchestrator is meant to run on: the
 * process's database owner (PGlite), the state machines' store and the pg-boss
 * queue on that same owner.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Type } from 'typebox';
import { requestStorePreparation, withStorePreparationOwner } from '../src/product/store-preparation.js';
import { type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { DEFAULT_STAGE_DEFAULTS, type FillStage, type StageDraftSet, type StageExecutionResult, type StageUnitScope } from '../src/fill/stage.js';
import { StageRegistry } from '../src/fill/registry.js';
import type { QueueService } from '../src/fill/queue.js';
import { DEFAULT_QUEUE_SCHEMA } from '../src/adapters/pg-boss-queue.js';
import { DEFAULT_ORCHESTRATOR_LIMITS, admissionOrder, admitUnits, createOrchestrator, driveRun, invalidateStaleUnits, planRun, resumeRun, runEvidence, runStatus, schedulerPass, startRun, sweepUnits, workOnce, type FillOrchestrator, type HumanEditGuard, type OrchestratorLimits, type PlanOutcome, type RunControlReader, type UnitGraphReader, type UnitRef } from '../src/fill/orchestrator.js';
import { createOrchestratorSchema, PUBLICATION_SNAPSHOT, readMembership, readProgress, appendProgress, appendProgresses, readUnitReads, readSealedChildren, recordUnitDraft, retractUnitDraft, recordUnitRead, recordUnitReads, type RunSnapshot } from '../src/fill/orchestrator-store.js';
import { GraphReadRefusal, readText, recordedReadText } from '../src/fill/read-record.js';
import { createFillOrchestratorService } from '../src/fill/orchestrator-host.js';
import { daemonFills } from '../src/product/daemon-fills.js';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { advanceRun, advanceUnit, createFillStateSchema, leaseUnit, readChain, readRun, readRunUnits, readUnit } from '../src/fill/state-store.js';
import { createTestDatabaseOwner } from './test-database.js';

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
  readonly owner: DatabaseOwner;
  readonly queue: QueueService;
  readonly registry: StageRegistry;
  readonly orchestrator: FillOrchestrator;
  readonly graph: FakeGraph;
  readonly applied: { unitId: string; generation: number; digest: string; writes: readonly unknown[] }[];
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
  apply?: (input: { unitId: string; generation: number; digest: string; writes: readonly unknown[] }) => Promise<number>;
  /** An owner the test lends, wrapped to count the transactions a pass opens; the test closes it. */
  owner?: DatabaseOwner;
  /** The clock the run reads; a test that reopens a world over one owner moves one clock across both. */
  clock?: ReturnType<typeof testClock>;
}): Promise<World> {
  const lent = options.owner !== undefined;
  const owner = options.owner ?? await createTestDatabaseOwner();
  await createFillStateSchema(owner);
  await createOrchestratorSchema(owner);
  const queue = await createPgBossQueue({ owner, supervise: false });
  const limits = { ...DEFAULT_ORCHESTRATOR_LIMITS, ...options.limits };
  await queue.declare({
    name: QUEUE,
    leaseSeconds: Math.max(1, Math.ceil(limits.leaseMs / 1000)),
    retries: 0,
    retryDelaySeconds: 0,
    retryBackoff: false,
    singletons: true,
  });
  const graph = options.graph ?? fakeGraph();
  const applied: World['applied'] = [];
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
    facts: {
      apply: async ({ unit, digest, writes }) => {
        if (options.apply !== undefined) return await options.apply({ unitId: unit.unitId, generation: unit.generation, digest, writes });
        applied.push({ unitId: unit.unitId, generation: unit.generation, digest, writes: [...writes] });
        return writes.length;
      },
    },
    clock: clock.now,
    limits,
    ...(options.guard === undefined ? {} : { guard: options.guard }),
    ...(options.control === undefined ? {} : { control: options.control }),
  });
  return {
    owner, queue, registry: options.registry, orchestrator, graph, applied, clock, commits,
    close: async () => { await queue.stop(); if (!lent) await owner.close(); },
  };
}

const worlds: World[] = [];
afterEach(async () => {
  while (worlds.length > 0) await worlds.pop()!.close();
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
    validate: () => ({ ok: true }),
    ...declaration,
  };
}

/** A stage that plans named units and drafts one write each time it runs. */
function draftingStage(id: string, options: {
  units: readonly string[];
  consumes?: readonly string[];
  produces?: readonly string[];
  concurrency?: number;
  coverage?: 'planned' | 'nothing-found';
  validate?: (draft: StageDraftSet) => { ok: true } | { ok: false; errors: readonly string[] };
}): FillStage {
  return fakeStage(id, {
    produces: (options.produces ?? []).map((kind) => ({ kind, schemaVersion: 1, scope: 'repository' })),
    consumes: { required: (options.consumes ?? []).map((capability) => ({ capability, scope: 'repository' as const })), optional: [] },
    defaults: { ...DEFAULT_STAGE_DEFAULTS, concurrency: options.concurrency ?? 1 },
    plan: (): { units: readonly StageUnitScope[]; coverage: 'planned' | 'nothing-found' } => ({
      units: options.units.map((scope) => ({ id: scope, scope })),
      coverage: options.coverage ?? 'planned',
    }),
    execute: (unit, context): StageExecutionResult => {
      context.draft.write({ kind: 'fact', evidence: `${unit.scope}:1`, value: { kind: 'module-facts', scope: unit.scope } });
      return { outcome: 'draft' };
    },
    validate: (draft) => (options.validate === undefined ? { ok: true } : options.validate(draft)),
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
    execute: (unit, context): StageExecutionResult => {
      attempts.push(unit.id);
      const first = attempts.filter((id) => id === unit.id).length === 1;
      if ((options.splitEveryUnit === true || unit.id === 'root') && first) return { outcome: 'split', children: childrenFor(unit.id) };
      context.draft.write({ kind: 'fact', evidence: `${unit.scope}:1`, value: { kind: 'module-facts' } });
      return { outcome: 'draft' };
    },
  });
  return { stage, attempts };
}

/** The registry decision 0027's own example needs: a producer and two consumers of its facts. */
function basicRegistry(): StageRegistry {
  return new StageRegistry()
    .register(draftingStage('snapshot', { units: ['src', 'docs'], produces: ['file-facts'], concurrency: 2 }))
    .register(draftingStage('modules', { units: ['core'], consumes: ['file-facts'], produces: ['module-facts'], concurrency: 1 }))
    .register(draftingStage('overview', { units: ['product'], consumes: ['module-facts'], produces: ['product-overview'], concurrency: 1 }));
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
  const { world: opened, runId } = await plannedWorld({ registry: new StageRegistry().register(draftingStage('source', { units: ['one'] })) });
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
  expect((await readProgress(opened.owner, runId)).slice(-3)).toEqual(eventBatch);
});

test('a failed progress batch rolls back its events without rolling back committed tracked reads', async () => {
  const { world: opened, runId } = await plannedWorld({ registry: new StageRegistry().register(draftingStage('source', { units: ['one'] })) });
  const unit = (await readRunUnits(opened.owner, runId))[0]!;
  const before = await readProgress(opened.owner, runId);
  const reads = ['a', 'b'].map((query) => ({ unitId: unit.unitId, generation: unit.generation, query, rows: [query], at: NOW }));
  await recordUnitReads(opened.owner, reads);
  let inserts = 0;
  const failing: DatabaseOwner = {
    ...opened.owner,
    transaction: async (kind, work) => await opened.owner.transaction(kind, async (transaction) => await work({
      query: async (sql, values) => {
        if (sql.includes('INSERT INTO fill_event') && ++inserts === 2) throw new Error('injected progress batch failure');
        return await transaction.query(sql, values);
      },
    })),
  };
  await expect(appendProgresses(failing, reads.map((read) => ({
    runId, at: NOW, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-read' as const, summary: read.query,
  })))).rejects.toThrow('injected progress batch failure');
  expect(inserts).toBe(2);
  expect((await readUnitReads(opened.owner, unit.unitId, unit.generation)).map((read) => ({ query: read.query, membership: read.membership, seq: read.seq }))).toEqual([
    { query: 'a', membership: readMembership(['a']), seq: 1 },
    { query: 'b', membership: readMembership(['b']), seq: 2 },
  ]);
  expect(await readProgress(opened.owner, runId)).toEqual(before);
  const next = await appendProgress(opened.owner, { runId, at: NOW + 1, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-read', summary: 'after rollback' });
  expect(next.seq).toBe((before.at(-1)?.seq ?? 0) + 1);
});

describe('the snapshot a publication reads', () => {
  // madarch-tzte.21.11 rechecks a unit's tracked reads inside the publication's own transaction, and a read
  // is asked a page at a time: at READ COMMITTED a fact another unit committed between two pages of one
  // read would stand outside the recheck's answer while the recorded membership still matched. The
  // publication's transaction is one snapshot from its first statement.
  test('is one snapshot: the publication transaction opens with the repeatable-read statement', async () => {
    const owner = await createTestDatabaseOwner();
    const writes: string[][] = [];
    const watching: DatabaseOwner = {
      location: owner.location,
      ready: owner.ready,
      allowConcurrentSnapshots: owner.allowConcurrentSnapshots,
      hasVector: owner.hasVector,
      transaction: async (kind, work) => await owner.transaction(kind, async (transaction) => {
        const seen: string[] = [];
        if (kind === 'write') writes.push(seen);
        const value = await work({
          query: async (sql, values) => {
            seen.push(sql);
            return await transaction.query(sql, values);
          },
        });
        return value;
      }),
      run: async (work) => await owner.run(work),
      exec: async (text) => await owner.exec(text),
      close: async () => await owner.close(),
    };
    try {
      const registry = new StageRegistry().register(draftingStage('snapshot', { units: ['src'], produces: ['file-facts'] }));
      const { world: opened, runId } = await plannedWorld({ registry, owner: watching });
      await admitUnits(opened.orchestrator, { runId });
      expect((await workOnce(opened.orchestrator, { worker: 'worker-1' })).result).toBe('published');
      const publications = writes.filter((statements) => statements.some((sql) => sql.includes('INSERT INTO fill_publication')));
      expect(publications).toHaveLength(1);
      expect(publications[0]![0]).toBe(PUBLICATION_SNAPSHOT);
    } finally {
      await owner.close();
    }
  }, 60_000);

  test('is repeatable read once the publication opens it, and the level is refused after the first statement', async () => {
    const owner = await createTestDatabaseOwner();
    try {
      const level = await owner.transaction('write', async (transaction) => {
        await transaction.query(PUBLICATION_SNAPSHOT);
        return (await transaction.query<{ transaction_isolation: string }>('SHOW transaction_isolation')).rows[0]?.transaction_isolation;
      });
      expect(level).toBe('repeatable read');
      // Which is why it is set first: PostgreSQL answers a level set after a statement with an error.
      await expect(owner.transaction('write', async (transaction) => {
        await transaction.query('SELECT 1');
        await transaction.query(PUBLICATION_SNAPSHOT);
      })).rejects.toThrow(/must be called before any query/);
    } finally {
      await owner.close();
    }
  }, 30_000);
});

describe('a publication that loses its snapshot', () => {
  test('is retried against the store as it now stands, rather than thrown out of the run', async () => {
    // The publication is one snapshot (see `publishUnitIn`), so a writer that got to one of its rows first
    // fails to serialize instead of waiting. That is the same event as a read that moved: the attempt is
    // retried, and the worker does not die on the owner's error.
    const owner = await createTestDatabaseOwner();
    let fail = true;
    const losing: DatabaseOwner = {
      location: owner.location,
      ready: owner.ready,
      allowConcurrentSnapshots: owner.allowConcurrentSnapshots,
      hasVector: owner.hasVector,
      transaction: async (kind, work) => await owner.transaction(kind, async (transaction) => {
        const seen: string[] = [];
        const value = await work({
          query: async (sql, values) => {
            seen.push(sql);
            return await transaction.query(sql, values);
          },
        });
        // A serialization failure is raised at COMMIT, after the work has run: the snapshot was taken and
        // a row it read or wrote moved under it.
        if (kind === 'write' && fail && seen[0] === PUBLICATION_SNAPSHOT) {
          fail = false;
          throw Object.assign(new Error('could not serialize access due to concurrent update'), { code: '40001' });
        }
        return value;
      }),
      run: async (work) => await owner.run(work),
      exec: async (text) => await owner.exec(text),
      close: async () => await owner.close(),
    };
    try {
      const registry = new StageRegistry().register(draftingStage('snapshot', { units: ['src'], produces: ['file-facts'] }));
      const { world: opened, runId } = await plannedWorld({ registry, owner: losing, limits: { retryDelayMs: 0 } });
      await admitUnits(opened.orchestrator, { runId });
      const lost = await workOnce(opened.orchestrator, { worker: 'worker-1' });
      expect(lost.result).toBe('retried');
      expect(lost.summary).toContain('lost its snapshot to a concurrent writer');
      expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('retry_wait');
      // The retry publishes: the second publication's snapshot is the one that stands.
      opened.clock.advance(1_000);
      const driven = await driveRun(opened.orchestrator, { runId, workers: 1 });
      expect(driven.settled).toBe(true);
      expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('published');
    } finally {
      await owner.close();
    }
  }, 60_000);
});

describe('a retraction of a draft set', () => {
  test('answers the set\'s head and reads none of its writes back', async () => {
    // A repository-wide unit's set is tens of megabytes of JSON, and every caller of a retraction discards
    // what the set held: reading it back parsed the whole set at the run's memory peak.
    const owner = await createTestDatabaseOwner();
    try {
      await createFillStateSchema(owner);
      await createOrchestratorSchema(owner);
      // The draft's foreign keys name the run and the generation it belongs to.
      await owner.transaction('write', async (transaction) => {
        await transaction.query(`INSERT INTO fill_run (run_id, product, state, context, created_at, updated_at) VALUES ('run-retract', 'p', 'running', '{}'::jsonb, $1, $1)`, [NOW]);
        await transaction.query(`INSERT INTO fill_unit (unit_id, product, stage_id, scope_key, generation, created_at) VALUES ('modules:retracted', 'p', 'modules', 'modules', 1, $1)`, [NOW]);
        await transaction.query(`INSERT INTO fill_unit_generation (unit_id, generation, run_id, state, inputs_digest, fence, context, updated_at) VALUES ('modules:retracted', 1, 'run-retract', 'planned', 'd', 0, '{}'::jsonb, $1)`, [NOW]);
      });
      const writes = Array.from({ length: 1_001 }, (_value, at) => ({ kind: 'fact' as const, evidence: `src/a.ts:${String(at + 1)}`, value: { at } }));
      const recorded = await recordUnitDraft(owner, { unitId: 'modules:retracted', generation: 1, writes, at: NOW });
      const statements: string[] = [];
      const watching: DatabaseOwner = {
        location: owner.location,
        ready: owner.ready,
        allowConcurrentSnapshots: owner.allowConcurrentSnapshots,
        hasVector: owner.hasVector,
        transaction: async (kind, work) => await owner.transaction(kind, async (transaction) => await work({
          query: async (sql, values) => {
            statements.push(sql);
            return await transaction.query(sql, values);
          },
        })),
        run: async (work) => await owner.run(work),
        exec: async (text) => await owner.exec(text),
        close: async () => await owner.close(),
      };
      const head = await retractUnitDraft(watching, { unitId: 'modules:retracted', generation: 1, at: NOW + 1 });
      expect(head?.digest).toBe(recorded.digest);
      expect(head?.retractedAt).toBe(NOW + 1);
      expect(head === null ? [] : Object.keys(head).sort()).toEqual(['digest', 'generation', 'recordedAt', 'retractedAt', 'unitId']);
      expect(statements.filter((sql) => sql.includes('fill_unit_draft_part'))).toEqual([]);
    } finally {
      await owner.close();
    }
  }, 60_000);
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
    const registry = new StageRegistry().register(draftingStage('modules', { units: ['core'], consumes: ['file-facts'] }));
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
      .register(draftingStage('snapshot', { units: ['src'], produces: ['file-facts'] }))
      .register(draftingStage('modules', { units: ['core'], consumes: ['file-facts'] }));
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
      .register(draftingStage('snapshot', { units: ['src'], produces: ['file-facts'] }))
      .register(draftingStage('modules', { units: [], consumes: ['file-facts'], produces: ['module-facts'], coverage: 'nothing-found' }));
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
  test('a pass admits up to the run\'s slots and walks no further, whatever the plan holds', async () => {
    // Sixty units, one slot: the pass admits the first and stops, instead of opening a transaction for
    // every candidate that finds no slot. A run of a few thousand units measured 27 s of a 27.6 s unit
    // in exactly those transactions (madarch-tzte.21.8's walk over a madarch checkout).
    const units = Array.from({ length: 60 }, (_unused, index) => `unit-${String(index).padStart(2, '0')}`);
    const lent = await createTestDatabaseOwner();
    let transactions = 0;
    const counting = Object.create(lent) as DatabaseOwner;
    counting.transaction = async (kind, work) => { transactions += 1; return await lent.transaction(kind, work); };
    try {
      const { world: opened, runId } = await plannedWorld({ registry: new StageRegistry().register(draftingStage('graph', { units })), limits: { maxInFlight: 1 }, owner: counting });
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
  }, 120_000);

  test('takes the run\'s slots and each stage\'s concurrency, in the order the plan named the units', async () => {
    const registry = new StageRegistry().register(draftingStage('snapshot', { units: ['a', 'b', 'c'], produces: ['file-facts'], concurrency: 2 }));
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
    const registry = new StageRegistry().register(draftingStage('snapshot', { units: ['src'], produces: ['file-facts'] }));
    const { world: opened, runId } = await plannedWorld({ registry });
    await admitUnits(opened.orchestrator, { runId });
    const claimed = await opened.queue.claim<{ unitId: string; generation: number }>({ queue: QUEUE, limit: 1 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.data).toEqual({ unitId: 'snapshot/src', generation: 1 });
  });
});

describe('one attempt: lease, run, draft, validate, publish', () => {
  
  
  
  test('a run whose unit cannot be covered completes partially, with the reason on the record', async () => {
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
    expect(evidence).toEqual({ runnable: 0, inFlight: 0, waiting: 0, coverageMet: false, pendingPublications: 0 });
    const settlement = await schedulerPass(opened.orchestrator, { runId });
    expect(settlement.run.state).toBe('completed_partial');
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
        context.draft.write({ kind: 'fact', evidence: `${unit.scope}:1`, value: { kind: 'module-facts' } });
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
    const registry = new StageRegistry().register(draftingStage('snapshot', { units: ['src'], produces: ['file-facts'] }));
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
  
  
  test('a publication that fails every attempt names the unit failed and leaves the run partial', async () => {
    const registry = new StageRegistry().register(draftingStage('snapshot', { units: ['src'], produces: ['file-facts'] }));
    const { world: opened, runId } = await plannedWorld({
      registry,
      limits: { retryDelayMs: 0, retries: 1 },
      apply: async () => { throw new Error('the graph refused the write'); },
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
    expect(settlement.run.state).toBe('completed_partial');
  });

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
    expect((await leaseUnit(opened.owner, { unitId: 'snapshot/src', holder: 'worker-1', ttlMs: 60_000, at: NOW })).ok).toBe(true);
    expect((await advanceUnit(opened.owner, { unitId: 'snapshot/src', event: { type: 'start', at: NOW, generation: 1, fence: 1 } })).ok).toBe(true);
    expect((await advanceRun(opened.owner, { runId, event: { type: 'cancel', at: NOW, cause: 'the person stopped the run' } })).ok).toBe(true);
    const blocked = await advanceUnit(opened.owner, { unitId: 'snapshot/src', event: { type: 'block', at: NOW, generation: 1, fence: 1, reason: 'the attempt was cancelled' } });
    expect(blocked.ok).toBe(false);
    expect(blocked.ok === false ? blocked.refusal.code : '').toBe('fill-unit/no-transition');
    expect(blocked.ok === false ? blocked.refusal.reason : '').toContain('cancelling');
    // Nothing of the step stands: the unit is where the step found it, for the drain's own cancel.
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('running');
  });

  test('a pause admits nothing new and drains to paused, and a resume replans and finishes', async () => {
    // A stage that reports it is running and waits for the test to let it finish: the drain is what a pause
    // does with work already in flight, and nothing sleeps while it happens.
    let running!: () => void;
    const reached = new Promise<void>((resolve) => { running = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const stage = fakeStage('snapshot', {
      produces: [{ kind: 'file-facts', schemaVersion: 1, scope: 'repository' }],
      defaults: { ...DEFAULT_STAGE_DEFAULTS, concurrency: 1 },
      plan: () => ({ units: [{ id: 'src', scope: 'src' }, { id: 'docs', scope: 'docs' }], coverage: 'planned' }),
      execute: async (unit, context): Promise<StageExecutionResult> => {
        running();
        await gate;
        context.draft.write({ kind: 'fact', evidence: `${unit.scope}:1`, value: { kind: 'file-facts' } });
        return { outcome: 'draft' };
      },
    });
    const registry = new StageRegistry().register(stage);
    let control: 'running' | 'paused' | 'stopped' = 'running';
    const { world: opened, runId } = await plannedWorld({ registry, control: async () => control });
    await admitUnits(opened.orchestrator, { runId });
    const working = workOnce(opened.orchestrator, { worker: 'worker-1' });
    await reached;

    // Decision 0027's pause drains: the run admits nothing new and pauses once what is in flight is done.
    control = 'paused';
    const pausedPass = await schedulerPass(opened.orchestrator, { runId });
    expect(pausedPass.run.state).toBe('pausing');
    release();
    expect((await working).result).toBe('published');
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
    const registry = new StageRegistry().register(draftingStage('snapshot', { units: ['src'], produces: ['file-facts'] }));
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
    expect(opened.applied).toHaveLength(4);
    expect((await readChain(opened.owner, 'fixture-product'))?.state).toBe('quiescent');
    const status = await runStatus(opened.orchestrator, runId);
    expect(status?.evidence).toEqual({ runnable: 0, inFlight: 0, waiting: 0, coverageMet: true, pendingPublications: 0 });
    expect(status?.units.map((unit) => `${unit.unitId}:${unit.attempts}`)).toEqual([
      'modules/core:1', 'overview/product:1', 'snapshot/docs:1', 'snapshot/src:1',
    ]);
  });

  
});

describe('the service the background server owns', () => {
  test('a service with nothing wired refuses a run and names what is missing, and opens nothing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'madarch-fill-host-'));
    try {
      const service = createFillOrchestratorService({ registry: basicRegistry() });
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
      const service = createFillOrchestratorService({
        databasePath,
        registry: basicRegistry(),
        wiring: () => ({
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
      const service = createFillOrchestratorService({
        registry: basicRegistry(),
        wiring: () => ({ snapshot: () => SNAPSHOT, configuration: () => undefined, graph: () => fakeGraph().reader, inputs: () => ({ commit: 'a1b2c3d4' }) }),
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
  test('a run with a unit waiting for its retry has not finished: it settles only once that attempts ends', async () => {
    let attempts = 0;
    const registry = new StageRegistry().register(draftingStage('snapshot', {
      units: ['src'], produces: ['file-facts'],
      validate: () => { attempts += 1; return attempts === 1 ? { ok: false, errors: ['the first draft stands on nothing'] } : { ok: true }; },
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
    const registry = new StageRegistry().register(draftingStage('snapshot', { units: ['src'], produces: ['file-facts'] }));
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
    expect((await driveRun(opened.orchestrator, { runId: 'run-a', workers: 1 })).run.state).toBe('completed_partial');
    expect((await readUnit(opened.owner, 'blocked-stage/src'))?.state).toBe('blocked');

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
    expect(generations.rows).toEqual([{ generation: 1, state: 'blocked' }, { generation: 2, state: 'published' }]);
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
    expect(first.run.state).toBe('completed_partial');
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
    const registry = new StageRegistry().register(draftingStage('modules', { units: ['core'], consumes: ['file-facts'] }));
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
    const registry = new StageRegistry().register(draftingStage('snapshot', { units: ['src'], produces: ['file-facts'] }));
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

  test('the publication rechecks its reads inside the publication\'s own transaction', async () => {
    const query = 'SELECT module FROM clusters';
    const registry = new StageRegistry().register(fakeStage('snapshot', {
      produces: [{ kind: 'file-facts', schemaVersion: 1, scope: 'repository' }],
      plan: () => ({ units: [{ id: 'src', scope: 'src' }], coverage: 'planned' }),
      execute: (unit, context) => {
        void context.graph.query(query).then(() => undefined);
        context.draft.write({ kind: 'fact', evidence: `${unit.scope}:1`, value: { kind: 'file-facts' } });
        return { outcome: 'draft' };
      },
    }));
    const graph = fakeGraph({ [query]: [{ module: 'core' }] });
    const seen: (boolean)[] = [];
    const { world: opened, runId } = await plannedWorld({
      registry,
      graph,
      onGraph: (withTransaction) => { seen.push(withTransaction); },
    });
    await admitUnits(opened.orchestrator, { runId });
    await workOnce(opened.orchestrator, { worker: 'worker-1' });
    // The attempt's own read is made with no transaction of its own; the publication's recheck is made
    // inside the publication's transaction, which is the only way the process's one owner answers it.
    // The planning read, the attempt's own read (neither with a transaction), and the publication's
    // recheck, which is the one made inside the transaction.
    expect(seen).toEqual([false, false, true]);
  });
});

/** The schema pg-boss's own tables live in, as the adapter declares it. */
const QUEUE_SCHEMA = DEFAULT_QUEUE_SCHEMA;

describe('a job the queue no longer holds', () => {
  /** One stage with one unit, so the queue holds exactly one job of the run. */
  const oneUnit = (): StageRegistry => new StageRegistry().register(draftingStage('snapshot', { units: ['src'], produces: ['file-facts'], concurrency: 1 }));

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

  test('a unit under a lease of its own is left to that lease', async () => {
    const { world: opened, runId } = await plannedWorld({ registry: oneUnit() });
    await admitUnits(opened.orchestrator, { runId });
    const leased = await leaseUnit(opened.owner, { unitId: 'snapshot/src', holder: 'worker-1', ttlMs: 60_000, at: NOW });
    expect(leased.ok).toBe(true);
    const swept = await sweepUnits(opened.orchestrator, { runId });
    // The unit is `leased` and its job is the attempt's own: nothing is offered and
    // nothing is retried before the lease lapses.
    expect(swept).toMatchObject({ swept: [], refused: [] });
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('leased');
  }, 30_000);
});

describe('an attempt that died between its draft and its publication', () => {
  });


describe('the window between a machine step and its enqueue', () => {
  });

describe('a worker whose lease lapsed while it was still inside its stage', () => {
  /** The run's unfinished jobs, by the unit each carries: a key no new job can take while it stands. */
  async function unfinished(opened: World): Promise<string[]> {
    const rows = await opened.owner.run(async (transaction) => (await transaction.query<{ singleton_key: string }>(
      `SELECT singleton_key FROM ${QUEUE_SCHEMA}.job WHERE name = $1 AND state IN ('created', 'retry', 'active') ORDER BY singleton_key`,
      [QUEUE],
    )).rows);
    return rows.map((row) => row.singleton_key);
  }


  /** What the run said about the attempt it stopped: the refusal's step and what became of its claim. */
  async function refusals(opened: World, runId: string): Promise<string[]> {
    return (await readProgress(opened.owner, runId)).filter((event) => event.kind === 'unit-refused').map((event) => event.summary);
  }

  /**
   * One stage with one unit whose `execute` opens the window the tests need: the run's
   * own sweep, of another executor, retrying a lease that lapsed under this worker while
   * it was still inside its stage. `lapse` is what the attempt does before it returns,
   * so the steps it comes back to are the ones the machine has moved under it.
   */
  function lapsedStage(outcome: 'draft' | 'blocked'): { registry: StageRegistry; lapse: { now?: () => Promise<void> } } {
    const lapse: { now?: () => Promise<void> } = {};
    const registry = new StageRegistry().register(fakeStage('snapshot', {
      produces: [{ kind: 'file-facts', schemaVersion: 1, scope: 'repository' }],
      plan: () => ({ units: [{ id: 'src', scope: 'src' }], coverage: 'planned' }),
      execute: async (_unit, context): Promise<StageExecutionResult> => {
        const lapseNow = lapse.now;
        lapse.now = undefined;
        await lapseNow?.();
        if (outcome === 'blocked') return { outcome: 'blocked', reason: 'the stage cannot continue with what it read' };
        context.draft.write({ kind: 'fact', evidence: 'src:1', value: { kind: 'file-facts' } });
        return { outcome: 'draft' };
      },
    }));
    return { registry, lapse };
  }

  
  test('a block the machine refuses ends the attempt\'s claim just the same', async () => {
    const { registry, lapse } = lapsedStage('blocked');
    const { world: opened, runId } = await plannedWorld({ registry, limits: { leaseMs: 1_000, retryDelayMs: 500, retries: 2 } });
    await admitUnits(opened.orchestrator, { runId });
    // The lapse lands before the retry's own moment, so the unit stands `retry_wait`
    // when the stage asks to block: the table allows no block from there.
    lapse.now = async () => {
      opened.clock.advance(1_000);
      expect((await sweepUnits(opened.orchestrator, { runId })).swept.map((unit) => unit.outcome)).toEqual(['retried']);
    };
    const worked = await workOnce(opened.orchestrator, { worker: 'worker-1' });
    expect(worked).toMatchObject({ unitId: 'snapshot/src', result: 'refused', job: 'completed' });
    expect(worked.refusal?.reason).toContain('"retry_wait"');
    expect(await unfinished(opened)).toEqual([]);
    expect(await refusals(opened, runId)).toEqual([expect.stringContaining('refused block')]);
  }, 30_000);

  
  });

describe('a draft set a store recorded before the parts existed', () => {
  // madarch-tzte.21.11 stores a draft set in parts, and a store recorded by the code before it holds the
  // whole set in the row's own `writes` column. That row is a set like any other: a reader answers it
  // whole, and a store that answered it empty would publish nothing for it.
  });

describe('a draft set larger than one part', () => {
  // madarch-tzte.21.11: one jsonb value of a repository-wide unit's whole draft set — 34 MB for the
  // modules stage over the madarch tree — took the embedded store's memory up by about 490 MB for good.
  // A set is recorded in parts of a few hundred writes, and read back whole and in order.
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
        context.draft.write({ kind: 'fact', evidence: `${unit.scope}:1`, value: { kind: `${id}-facts` } });
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
        context.draft.write({ kind: 'fact', evidence: `${unit.scope}:1`, value: { kind: 'file-facts' } });
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
        context.draft.write({ kind: 'fact', evidence: `${unit.scope}:1`, value: { kind: `${id}-facts` } });
        return { outcome: 'draft' };
      },
    });
  }

  /** The reading stage the cache-key tests use, named here so the describe holds its own helpers. */
  function readingStageOf(id: string, options: { units: { names: string[] }; produces?: readonly string[] }): FillStage {
    return fakeStage(id, {
      produces: (options.produces ?? []).map((kind) => ({ kind, schemaVersion: 1, scope: 'repository' as const })),
      plan: () => ({ units: options.units.names.map((scope) => ({ id: scope, scope })), coverage: 'planned' as const }),
      execute: (unit, context) => {
        context.draft.write({ kind: 'fact', evidence: `${unit.scope}:1`, value: { kind: `${id}-facts` } });
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
      await createFillStateSchema(owner);
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
        'fill_unit_draft_generation_fk',
        'fill_unit_draft_part_generation_fk',
        'fill_unit_generation_unit_fk',
        'fill_unit_lease_generation_fk',
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
