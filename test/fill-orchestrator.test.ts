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
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { DEFAULT_STAGE_DEFAULTS, type FillStage, type StageDraftSet, type StageExecutionResult, type StageUnitScope } from '../src/fill/stage.js';
import { StageRegistry } from '../src/fill/registry.js';
import type { QueueService } from '../src/fill/queue.js';
import { DEFAULT_QUEUE_SCHEMA } from '../src/adapters/pg-boss-queue.js';
import {
  DEFAULT_ORCHESTRATOR_LIMITS,
  admissionOrder,
  admitUnits,
  cancelRun,
  createOrchestrator,
  driveRun,
  invalidateStaleUnits,
  planRun,
  resumeRun,
  runEvidence,
  runStatus,
  schedulerPass,
  startRun,
  sweepUnits,
  unblockUnit,
  workOnce,
  type FillOrchestrator,
  type HumanEditGuard,
  type OrchestratorLimits,
  type PlanOutcome,
  type RunControlReader,
  type UnitGraphReader,
} from '../src/fill/orchestrator.js';
import {
  createOrchestratorSchema,
  PUBLICATION_SNAPSHOT,
  publishUnit,
  readMembership,
  readProgress,
  readPublication,
  readPublications,
  readRunConfiguration,
  readSealedChildren,
  readUnitDraft,
  readUnitReads,
  recordUnitDraft,
  retractUnitDraft,
  recordUnitRead,
  type RunSnapshot,
} from '../src/fill/orchestrator-store.js';
import { createFillOrchestratorService } from '../src/fill/orchestrator-host.js';
import { createPGliteQueryDatabase } from '../src/adapters/pglite-query-database.js';
import { startServer } from '../src/server/http.js';
import { daemonFillOrchestrator } from '../src/product/daemon.js';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { advanceUnit, createFillStateSchema, leaseUnit, readChain, readRun, readRunUnits, readTransitions, readUnit } from '../src/fill/state-store.js';

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
  apply?: (input: { unitId: string; generation: number; digest: string; writes: readonly unknown[] }) => Promise<number>;
  /** An owner the test lends, wrapped to count the transactions a pass opens; the test closes it. */
  owner?: DatabaseOwner;
}): Promise<World> {
  const lent = options.owner !== undefined;
  const owner = options.owner ?? createPGliteDatabaseOwner();
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
  const clock = testClock();
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
    inputs: () => ({ commit: commits.value }),
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

describe('the snapshot a publication reads', () => {
  // madarch-tzte.21.11 rechecks a unit's tracked reads inside the publication's own transaction, and a read
  // is asked a page at a time: at READ COMMITTED a fact another unit committed between two pages of one
  // read would stand outside the recheck's answer while the recorded membership still matched. The
  // publication's transaction is one snapshot from its first statement.
  test('is one snapshot: the publication transaction opens with the repeatable-read statement', async () => {
    const owner = createPGliteDatabaseOwner();
    const writes: string[][] = [];
    const watching: DatabaseOwner = {
      location: owner.location,
      ready: owner.ready,
      allowConcurrentSnapshots: owner.allowConcurrentSnapshots,
      backend: owner.backend,
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
    const owner = createPGliteDatabaseOwner();
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
    const owner = createPGliteDatabaseOwner();
    let fail = true;
    const losing: DatabaseOwner = {
      location: owner.location,
      ready: owner.ready,
      allowConcurrentSnapshots: owner.allowConcurrentSnapshots,
      backend: owner.backend,
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
    const owner = createPGliteDatabaseOwner();
    try {
      await createOrchestratorSchema(owner);
      const writes = Array.from({ length: 1_001 }, (_value, at) => ({ kind: 'fact' as const, evidence: `src/a.ts:${String(at + 1)}`, value: { at } }));
      const recorded = await recordUnitDraft(owner, { unitId: 'modules:retracted', generation: 1, writes, at: NOW });
      const statements: string[] = [];
      const watching: DatabaseOwner = {
        location: owner.location,
        ready: owner.ready,
        allowConcurrentSnapshots: owner.allowConcurrentSnapshots,
        backend: owner.backend,
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
  test('plans every enabled stage in the derived order, snapshots what it resolved and starts the run', async () => {
    const { world: opened, runId, plan } = await plannedWorld({ registry: basicRegistry() });
    const run = await readRun(opened.owner, runId);
    // Decision 0027: a run walks created → planning → running, and planning closes its epoch.
    expect(run?.state).toBe('running');
    expect(run?.context).toEqual({ planningEpoch: 1, planningClosed: true });

    // The plan named the units in the derived stage order, most important first inside each stage.
    expect(plan.units.map((unit) => unit.unitId)).toEqual([
      'snapshot/src', 'snapshot/docs', 'modules/core', 'overview/product',
    ]);
    const units = await readRunUnits(opened.owner, runId);
    // The store answers a run's units in code point order of their ids, whatever order they were planned in.
    expect(units.map((unit) => unit.unitId)).toEqual([
      'modules/core', 'overview/product', 'snapshot/docs', 'snapshot/src',
    ]);
    expect(units.map((unit) => unit.state)).toEqual(['planned', 'planned', 'planned', 'planned']);
    expect(units.every((unit) => unit.generation === 1)).toBe(true);

    // The unit identity carries no run id (decision 0026), and each unit's inputs digest is the digest of
    // the named inputs the run hashed: the commit it stands on.
    expect(units.every((unit) => !unit.unitId.includes(runId))).toBe(true);
    expect(new Set(units.map((unit) => unit.inputsDigest)).size).toBe(1);

    const configuration = await readRunConfiguration(opened.owner, runId);
    expect(configuration?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(configuration?.snapshot).toEqual(SNAPSHOT);

    const journal = await readTransitions(opened.owner, { kind: 'run', id: runId });
    expect(journal.map((entry) => entry.transitionId)).toEqual(['run/created--plan-->planning', 'run/planning--start-->running']);
    const events = await readProgress(opened.owner, runId);
    expect(events.map((event) => event.kind)).toEqual([
      'run-planned', 'unit-planned', 'unit-planned', 'unit-planned', 'unit-planned', 'run-started',
    ]);
    expect(events.every((event, index) => event.seq === index + 1)).toBe(true);
  });

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
    const lent = createPGliteDatabaseOwner();
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
  test('runs a unit to its publication, applies its facts once and settles its job', async () => {
    const registry = new StageRegistry().register(draftingStage('snapshot', { units: ['src'], produces: ['file-facts'] }));
    const { world: opened, runId } = await plannedWorld({ registry });
    await admitUnits(opened.orchestrator, { runId });
    const outcome = await workOnce(opened.orchestrator, { worker: 'worker-1' });
    expect(outcome.result).toBe('published');
    const unit = await readUnit(opened.owner, 'snapshot/src');
    expect(unit?.state).toBe('published');
    expect(unit?.publishedAt).toBe(NOW);

    // One publication per generation, with the draft it published and the facts it applied.
    const publications = await readPublications(opened.owner, 'snapshot/src');
    expect(publications).toHaveLength(1);
    expect(publications[0]!.generation).toBe(1);
    expect(publications[0]!.facts).toBe(1);
    expect(opened.applied).toHaveLength(1);
    expect(opened.applied[0]!.unitId).toBe('snapshot/src');

    // The lease that attempt took is the generation's first token, and the journal shows every step.
    const journal = await readTransitions(opened.owner, { kind: 'unit', id: 'snapshot/src' });
    expect(journal.map((entry) => entry.transitionId)).toEqual([
      'fill-store/unit--create-->planned',
      'unit/planned--admit-->ready',
      'unit/ready--lease-->leased',
      'unit/leased--start-->running',
      'unit/running--submit-draft-->draft',
      'unit/draft--validate-draft-->validating',
      'unit/validating--publish-->published',
    ]);
    expect(journal.slice(2).map((entry) => entry.fence)).toEqual([1, 1, 1, 1, 1]);
    // The queue holds nothing unfinished for it: the settlement landed with the publication.
    expect(await opened.queue.claim({ queue: QUEUE, limit: 1 })).toEqual([]);
    const events = await readProgress(opened.owner, runId);
    expect(events.map((event) => event.kind)).toEqual([
      'run-planned', 'unit-planned', 'run-started', 'unit-admitted', 'unit-leased', 'unit-started', 'unit-drafted', 'unit-validating', 'unit-published',
    ]);
  });

  test('a published generation is an immutable record: a later job for it changes nothing', async () => {
    const registry = new StageRegistry().register(draftingStage('snapshot', { units: ['src'], produces: ['file-facts'] }));
    const { world: opened, runId } = await plannedWorld({ registry });
    await admitUnits(opened.orchestrator, { runId });
    await workOnce(opened.orchestrator, { worker: 'worker-1' });
    const published = await readUnit(opened.owner, 'snapshot/src');
    const journalLength = (await readTransitions(opened.owner, { kind: 'unit', id: 'snapshot/src' })).length;

    // A job left over for the same unit, as a provider that handed it out twice would leave it.
    await opened.queue.enqueue({ queue: QUEUE, data: { unitId: 'snapshot/src', generation: 1 }, singletonKey: 'snapshot/src' });
    const late = await workOnce(opened.orchestrator, { worker: 'worker-2' });
    expect(late.result).toBe('nothing-to-do');
    expect(late.summary).toBe('the unit is published');
    expect(await readUnit(opened.owner, 'snapshot/src')).toEqual(published);
    expect((await readTransitions(opened.owner, { kind: 'unit', id: 'snapshot/src' })).length).toBe(journalLength);
    expect(await readPublications(opened.owner, 'snapshot/src')).toHaveLength(1);
  });

  test('a validation that refuses the draft spends a retry and retracts the draft', async () => {
    let attempts = 0;
    const registry = new StageRegistry().register(draftingStage('snapshot', {
      units: ['src'], produces: ['file-facts'],
      validate: () => { attempts += 1; return attempts === 1 ? { ok: false, errors: ['the evidence does not name a file'] } : { ok: true }; },
    }));
    const { world: opened, runId } = await plannedWorld({ registry, limits: { retryDelayMs: 1_000 } });
    await admitUnits(opened.orchestrator, { runId });
    const refused = await workOnce(opened.orchestrator, { worker: 'worker-1' });
    expect(refused.result).toBe('retried');
    const waiting = await readUnit(opened.owner, 'snapshot/src');
    expect(waiting?.state).toBe('retry_wait');
    expect(waiting?.context.retriesLeft).toBe(DEFAULT_ORCHESTRATOR_LIMITS.retries - 1);
    expect(waiting?.context.retryAt).toBe(NOW + 1_000);
    // Nothing is published and the draft is retracted, so the next attempt starts clean.
    expect(await readPublications(opened.owner, 'snapshot/src')).toEqual([]);
    const draft = await opened.owner.run(async (transaction) => transaction.query<{ retracted_at: unknown }>('SELECT retracted_at FROM fill_unit_draft WHERE unit_id = $1', ['snapshot/src']));
    expect(draft.rows[0]?.retracted_at).toBe(NOW);

    // The sweep wakes it once the wait is over, and the next attempt publishes.
    opened.clock.advance(1_000);
    const swept = await sweepUnits(opened.orchestrator, { runId });
    expect(swept.swept.map((unit) => unit.outcome)).toEqual(['woken']);
    const published = await workOnce(opened.orchestrator, { worker: 'worker-2' });
    expect(published.result).toBe('published');
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('published');
  });

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

  test('a unit a person unblocked is runnable again', async () => {
    const stageState = { refuse: true };
    const registry = new StageRegistry().register(fakeStage('snapshot', {
      produces: [{ kind: 'file-facts', schemaVersion: 1, scope: 'repository' }],
      plan: () => ({ units: [{ id: 'src', scope: 'src' }], coverage: 'planned' }),
      execute: () => (stageState.refuse ? { outcome: 'blocked', reason: 'the snapshot could not be read' } : { outcome: 'draft' }),
    }));
    const { world: opened, runId } = await plannedWorld({ registry, limits: { retryDelayMs: 0 } });
    await admitUnits(opened.orchestrator, { runId });
    await workOnce(opened.orchestrator, { worker: 'worker-1' });
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('blocked');

    stageState.refuse = false;
    const unblocked = await unblockUnit(opened.orchestrator, { unitId: 'snapshot/src', resolution: 'the person fixed the snapshot and resumed the unit' });
    expect(unblocked.result).toBe('retried');
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('ready');
    const published = await workOnce(opened.orchestrator, { worker: 'worker-2' });
    expect(published.result).toBe('published');
  });
});

describe('a split and its join', () => {
  test('seals the children and the parent in one transaction, then joins the parent once they are published and fresh', async () => {
    const { stage, attempts } = splittingStage();
    const registry = new StageRegistry().register(stage);
    const { world: opened, runId } = await plannedWorld({ registry, limits: { retryDelayMs: 0 } });
    await admitUnits(opened.orchestrator, { runId });
    const split = await workOnce(opened.orchestrator, { worker: 'worker-1' });
    expect(split.result).toBe('split');
    const parent = await readUnit(opened.owner, 'modules/root');
    expect(parent?.state).toBe('waiting_children');
    // The parent's attempt ended: its lease is revoked, and its children are sealed with it.
    expect(parent?.lease?.revokedAt).toBe(NOW);
    const sealed = await readSealedChildren(opened.owner, 'modules/root', 1);
    expect(sealed.map((child) => child.unitId)).toEqual(['modules/left', 'modules/right']);
    sample: {
      const children = await readRunUnits(opened.owner, runId);
      expect(children.map((unit) => `${unit.unitId}:${unit.state}`)).toEqual([
        'modules/left:planned', 'modules/right:planned', 'modules/root:waiting_children',
      ]);
    }

    // The children are admitted and published; the sweep then joins the parent.
    for (let pass = 0; pass < 4; pass += 1) {
      await admitUnits(opened.orchestrator, { runId });
      await workOnce(opened.orchestrator, { worker: 'worker-2' });
      await schedulerPass(opened.orchestrator, { runId });
    }
    expect((await readUnit(opened.owner, 'modules/left'))?.state).toBe('published');
    expect((await readUnit(opened.owner, 'modules/right'))?.state).toBe('published');
    // The parent ran twice — the attempt that split, and the attempt after its join — and each child once.
    expect(attempts.filter((id) => id === 'root')).toHaveLength(2);
    expect([...attempts].filter((id) => id !== 'root').sort()).toEqual(['left', 'right']);
    const joined = await readUnit(opened.owner, 'modules/root');
    expect(joined?.state).toBe('published');
    expect(joined?.generation).toBe(1);
    const journal = await readTransitions(opened.owner, { kind: 'unit', id: 'modules/root' });
    expect(journal.map((entry) => entry.transitionId)).toEqual([
      'fill-store/unit--create-->planned',
      'unit/planned--admit-->ready',
      'unit/ready--lease-->leased',
      'unit/leased--start-->running',
      'unit/running--wait-for-children-->waiting_children',
      'unit/waiting_children--join-all-published-->ready',
      'unit/ready--lease-->leased',
      'unit/leased--start-->running',
      'unit/running--submit-draft-->draft',
      'unit/draft--validate-draft-->validating',
      'unit/validating--publish-->published',
    ]);
    // The second attempt holds a greater fencing token than the first.
    expect(journal.map((entry) => entry.fence)).toEqual([0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2]);
  });

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

  test('a child that failed fails the waiting parent under the run\'s own policy', async () => {
    const { stage } = splittingStage();
    const registry = new StageRegistry().register(stage);
    const { world: opened, runId } = await plannedWorld({ registry, limits: { retryDelayMs: 0, failedChildPolicy: 'propagate' } });
    await admitUnits(opened.orchestrator, { runId });
    await workOnce(opened.orchestrator, { worker: 'worker-1' });
    expect((await readUnit(opened.owner, 'modules/left'))?.state).toBe('planned');

    // A child generation that will never publish — cancelled, as the run's own cancellation of one child
    // would leave it — is a failed child for its parent's join, and the policy propagates it.
    const cancelled = await advanceUnit(opened.owner, { unitId: 'modules/left', event: { type: 'cancel', at: NOW, cause: 'the child was cancelled' } });
    expect(cancelled.ok).toBe(true);
    // The other child is cancelled too, so nothing of the run is left runnable or in flight.
    expect((await advanceUnit(opened.owner, { unitId: 'modules/right', event: { type: 'cancel', at: NOW, cause: 'the child was cancelled' } })).ok).toBe(true);
    const swept = await sweepUnits(opened.orchestrator, { runId });
    expect(swept.swept.map((unit) => `${unit.unitId}:${unit.outcome}`)).toEqual(['modules/root:join-failed']);
    expect((await readUnit(opened.owner, 'modules/root'))?.state).toBe('failed');
    expect((await readTransitions(opened.owner, { kind: 'unit', id: 'modules/root' })).at(-1)?.transitionId)
      .toBe('unit/waiting_children--fail-child-failed-->failed');

    // The run's own coverage is unmet, so it completes partially.
    const settlement = await schedulerPass(opened.orchestrator, { runId });
    expect(settlement.run.state).toBe('completed_partial');
  });
});

describe('staleness from tracked reads, empty results included', () => {
  /** A stage that reads one query and drafts what it read. */
  function readingStage(query: string): FillStage {
    return fakeStage('snapshot', {
      produces: [{ kind: 'file-facts', schemaVersion: 1, scope: 'repository' }],
      plan: () => ({ units: [{ id: 'src', scope: 'src' }], coverage: 'planned' }),
      execute: (unit, context) => {
        void context.graph.query(query).then(() => undefined);
        context.draft.write({ kind: 'fact', evidence: `${unit.scope}:1`, value: { kind: 'file-facts' } });
        return { outcome: 'draft' };
      },
    });
  }

  test('a read that answered nothing and answers a row now refuses the publication, and the attempt retries', async () => {
    const query = 'SELECT path FROM files WHERE repository = $1';
    const registry = new StageRegistry().register(readingStage(query));
    const graph = fakeGraph();
    const { world: opened, runId } = await plannedWorld({ registry, graph, limits: { retryDelayMs: 0 } });
    await admitUnits(opened.orchestrator, { runId });

    // The read is recorded with the membership of an empty answer: decision 0027 rechecks it like any other.
    graph.rows.set(query, []);
    // The graph gains a row between the read and the publication of the same attempt: the publication's
    // own recheck is what refuses it, before any fact lands.
    const graphReader = graph.reader;
    let firstRead = true;
    graph.reader = {
      query: async (text: string) => {
        if (firstRead) { firstRead = false; return []; }
        return await graphReader.query(text);
      },
    };
    graph.rows.set(query, [{ path: 'src/index.ts' }]);
    const outcome = await workOnce(opened.orchestrator, { worker: 'worker-1' });
    expect(outcome.result).toBe('retried');
    expect(outcome.summary).toContain('which is now 1');
    expect(await readPublications(opened.owner, 'snapshot/src')).toEqual([]);
    expect(opened.applied).toEqual([]);
    const unit = await readUnit(opened.owner, 'snapshot/src');
    expect(unit?.state).toBe('retry_wait');
    const reads = await readUnitReads(opened.owner, 'snapshot/src', 1);
    expect(reads.map((read) => [read.query, read.members, read.membership])).toEqual([[query, 0, reads[0]!.membership]]);
  });

  test('a published generation whose read moved goes stale and opens its replacement', async () => {
    const query = 'SELECT module FROM clusters';
    const registry = new StageRegistry().register(readingStage(query));
    const graph = fakeGraph({ [query]: [{ module: 'core' }] });
    const { world: opened, runId } = await plannedWorld({ registry, graph });
    await admitUnits(opened.orchestrator, { runId });
    const published = await workOnce(opened.orchestrator, { worker: 'worker-1' });
    expect(published.result).toBe('published');
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('published');

    // The graph moves under the published generation: its recorded read no longer answers the same.
    graph.rows.set(query, [{ module: 'core' }, { module: 'wiki' }]);
    const sweep = await invalidateStaleUnits(opened.orchestrator, { runId });
    expect(sweep.refused).toEqual([]);
    expect(sweep.invalidated).toEqual([
      { unitId: 'snapshot/src', generation: 1, replacement: 2, cause: 'a read the generation recorded answers something else now' },
    ]);
    const generations = await (await import('../src/fill/state-store.js')).readUnitGenerations(opened.owner, 'snapshot/src');
    expect(generations.map((generation) => `${generation.generation}:${generation.state}`)).toEqual(['1:stale', '2:planned']);
    // The publication stays an immutable record of what was published, and the replacement is a new
    // generation of the same unit, planned against the inputs as they stand.
    expect(await readPublications(opened.owner, 'snapshot/src')).toHaveLength(1);
    expect(generations[0]!.publishedAt).toBe(NOW);
    expect(generations[1]!.inputsDigest).toBe(generations[0]!.inputsDigest);
    expect((await readTransitions(opened.owner, { kind: 'unit', id: 'snapshot/src' })).at(-1)?.transitionId).toBe('fill-store/generation--open-->planned');
  });

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
  test('the same digest answers the existing record, and a different digest is refused', async () => {
    const registry = new StageRegistry().register(draftingStage('snapshot', { units: ['src'], produces: ['file-facts'] }));
    const { world: opened, runId } = await plannedWorld({ registry });
    await admitUnits(opened.orchestrator, { runId });
    await workOnce(opened.orchestrator, { worker: 'worker-1' });
    const record = (await readPublication(opened.owner, 'snapshot/src', 1))!;
    const unit = (await readUnit(opened.owner, 'snapshot/src'))!;
    expect(opened.applied).toHaveLength(1);

    // The same request again: decision 0027's "a repeated request with the same identity and digest
    // returns the existing result", and nothing is applied twice.
    const replay = await publishUnit(opened.owner, {
      unitId: 'snapshot/src', generation: 1, fence: 1, identity: { inputsDigest: unit.inputsDigest, stageId: 'snapshot', stageVersion: 1 }, at: NOW + 1,
      revalidate: async () => ({ membership: 'x', members: 0 }),
      apply: async () => { throw new Error('a replay must not apply facts again'); },
    });
    expect(replay.outcome).toBe('replayed');
    expect(replay.outcome === 'replayed' ? replay.record : null).toEqual(record);
    expect(opened.applied).toHaveLength(1);

    const different = await publishUnit(opened.owner, {
      // The same generation under another stage version is another publication: its digest differs.
      unitId: 'snapshot/src', generation: 1, fence: 1, identity: { inputsDigest: unit.inputsDigest, stageId: 'snapshot', stageVersion: 2 }, at: NOW + 2,
      revalidate: async () => ({ membership: 'x', members: 0 }),
      apply: async () => 0,
    });
    expect(different.outcome).toBe('refused');
    expect(different.outcome === 'refused' ? different.code : '').toBe('fill-publication/digest-mismatch');
    expect(await readPublication(opened.owner, 'snapshot/src', 1)).toEqual(record);
    expect(different.outcome === 'refused' ? different.reason : '').toContain('one generation has one publication');
    expect(await readPublications(opened.owner, 'snapshot/src')).toHaveLength(1);
  });

  test('the facts, the state and the queue\'s settlement are one transaction: a failure rolls back all of them', async () => {
    const registry = new StageRegistry().register(draftingStage('snapshot', { units: ['src'], produces: ['file-facts'] }));
    let applied = 0;
    const { world: opened, runId } = await plannedWorld({
      registry,
      apply: async ({ writes }) => {
        applied += 1;
        if (applied === 1) throw new Error('the fact store refused the write');
        return writes.length;
      },
    });
    await admitUnits(opened.orchestrator, { runId });
    const caught = await workOnce(opened.orchestrator, { worker: 'worker-1' }).catch((error: Error) => error);
    expect((caught as Error).message).toContain('the fact store refused the write');
    // Nothing of the failed publication stands: no record, no fact, and the generation is still validating.
    expect(await readPublications(opened.owner, 'snapshot/src')).toEqual([]);
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('validating');
    // The job was not settled by the rolled-back transaction: the attempt that held it never settled it,
    // so nothing of the failed publication is left behind in the queue either.
    expect(await readPublications(opened.owner, 'snapshot/src')).toEqual([]);
    expect((await runEvidence(opened.orchestrator, runId)).pendingPublications).toBe(1);
  });

  test('a cancellation intent that lands while a publication is under way is refused by the publication itself', async () => {
    const registry = new StageRegistry().register(draftingStage('snapshot', { units: ['src'], produces: ['file-facts'] }));
    const { world: opened, runId } = await plannedWorld({ registry });
    await admitUnits(opened.orchestrator, { runId });
    // The unit as its attempt leaves it at the last step before publication: leased, running, drafted and
    // validating, with the reads the draft stands on recorded.
    expect((await leaseUnit(opened.owner, { unitId: 'snapshot/src', holder: 'worker-1', ttlMs: 60_000, at: NOW })).ok).toBe(true);
    for (const event of [
      { type: 'start', at: NOW, generation: 1, fence: 1 },
      { type: 'submit-draft', at: NOW, generation: 1, fence: 1 },
    ] as const) {
      expect((await advanceUnit(opened.owner, { unitId: 'snapshot/src', event })).ok).toBe(true);
    }
    await recordUnitDraft(opened.owner, {
      unitId: 'snapshot/src', generation: 1, at: NOW,
      writes: [{ kind: 'fact', evidence: 'src:1', value: { kind: 'file-facts' } }],
    });
    expect((await advanceUnit(opened.owner, { unitId: 'snapshot/src', event: { type: 'validate-draft', at: NOW, generation: 1, fence: 1 } })).ok).toBe(true);
    const membership = readMembership([]);
    await recordUnitRead(opened.owner, { unitId: 'snapshot/src', generation: 1, query: 'select 1', rows: [], at: NOW });

    // The order the race turns on: the publication read the run's control and is walking the reads its
    // draft stands on, and the person's cancellation intent reaches the run's row in between. The
    // recheck before the machine's step is what has to refuse it, whatever the control read saw.
    let applied = 0;
    const raced = await publishUnit(opened.owner, {
      unitId: 'snapshot/src', generation: 1, fence: 1, at: NOW,
      identity: { inputsDigest: (await readUnit(opened.owner, 'snapshot/src'))!.inputsDigest, stageId: 'snapshot', stageVersion: 1 },
      revalidate: async (_read, executor) => {
        await executor.query("UPDATE fill_run SET state = 'cancelling' WHERE run_id = $1", [runId]);
        return { membership, members: 0 };
      },
      apply: async () => { applied += 1; return 1; },
    });
    expect(raced.outcome).toBe('refused');
    expect(raced.outcome === 'refused' ? raced.code : '').toBe('fill-publication/authority-revoked');
    expect(raced.outcome === 'refused' ? raced.reason : '').toContain('cancelling');
    // Nothing of the refused publication stands: no record, no fact, and the generation is not published.
    expect(await readPublications(opened.owner, 'snapshot/src')).toEqual([]);
    expect(applied).toBe(0);
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('validating');
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

  test('cancelling revokes the attempt\'s authority, cancels its generation and refuses a publication that raced it', async () => {
    const { stage, reached } = waitingStage();
    const registry = new StageRegistry().register(stage);
    const { world: opened, runId } = await plannedWorld({ registry });
    await admitUnits(opened.orchestrator, { runId });
    const working = workOnce(opened.orchestrator, { worker: 'worker-1' });
    await reached;
    const cancelled = await cancelRun(opened.orchestrator, { runId, cause: 'the person stopped the run' });
    expect(cancelled.run.state).toBe('cancelled');
    expect(cancelled.cancelledUnits).toEqual(['snapshot/src']);
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('cancelled');
    // The attempt's own signal was aborted, which is how its agent session ends.
    const attempt = await working;
    expect(attempt.result).toBe('refused');
    expect(attempt.refusal?.code).toBe('fill-unit/no-transition');
    expect((await readTransitions(opened.owner, { kind: 'run', id: runId })).map((entry) => entry.transitionId)).toEqual([
      'run/created--plan-->planning', 'run/planning--start-->running',
      'run/running--cancel-->cancelling', 'run/cancelling--drained-->cancelled',
    ]);

    // A publication that raced the cancellation is refused by the publication's own check.
    await recordUnitDraft(opened.owner, { unitId: 'snapshot/src', generation: 1, writes: [{ kind: 'fact', evidence: 'src:1', value: {} }], at: NOW });
    const raced = await publishUnit(opened.owner, {
      unitId: 'snapshot/src', generation: 1, fence: 1, identity: { inputsDigest: 'digest-of-the-unit-inputs', stageId: 'snapshot', stageVersion: 1 }, at: NOW,
      revalidate: async () => ({ membership: 'x', members: 0 }),
      apply: async () => 0,
    });
    expect(raced.outcome).toBe('refused');
    expect(raced.outcome === 'refused' ? raced.code : '').toBe('fill-publication/authority-revoked');
    expect(await readPublications(opened.owner, 'snapshot/src')).toEqual([]);
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
  test('stales a stage a person edited and blocks the run for that review', async () => {
    const registry = new StageRegistry().register(draftingStage('snapshot', { units: ['src'], produces: ['file-facts'] }));
    const guard: HumanEditGuard = { check: () => 'conflict' };
    const { world: opened, runId } = await plannedWorld({ registry, guard });
    await admitUnits(opened.orchestrator, { runId });
    await workOnce(opened.orchestrator, { worker: 'worker-1' });
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('published');

    const pass = await schedulerPass(opened.orchestrator, { runId });
    expect(pass.guarded).toEqual(['snapshot']);
    expect(pass.run.state).toBe('blocked');
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('stale');
    const events = await readProgress(opened.owner, runId);
    expect(events.at(-1)?.summary).toContain('human-edit-wins');
    // The publication stays the record of what was published, and no replacement generation is opened:
    // the work waits for the person's review.
    expect(await readPublications(opened.owner, 'snapshot/src')).toHaveLength(1);
    expect((await readUnit(opened.owner, 'snapshot/src'))?.generation).toBe(1);
  });
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

  test('a unit whose lease lapsed is retried by the sweep, and one with no retry left fails', async () => {
    const registry = new StageRegistry().register(draftingStage('snapshot', { units: ['src'], produces: ['file-facts'] }));
    const { world: opened, runId } = await plannedWorld({ registry, limits: { leaseMs: 1_000, retryDelayMs: 500, retries: 1 } });
    await admitUnits(opened.orchestrator, { runId });

    // A worker that takes the unit and dies without settling it: the lease is in force and nothing runs.
    const leased = await leaseUnit(opened.owner, { unitId: 'snapshot/src', holder: 'worker-that-dies', ttlMs: 1_000, at: NOW });
    expect(leased.ok).toBe(true);
    opened.clock.advance(1_000);
    const swept = await sweepUnits(opened.orchestrator, { runId });
    expect(swept.swept.map((unit) => `${unit.unitId}:${unit.outcome}`)).toEqual(['snapshot/src:retried']);
    const waiting = await readUnit(opened.owner, 'snapshot/src');
    expect(waiting?.state).toBe('retry_wait');
    expect(waiting?.context.retriesLeft).toBe(0);
    expect(waiting?.context.retryAt).toBe(NOW + 1_500);
    expect(waiting?.lease?.revokedAt).toBe(NOW + 1_000);

    // The wait ends, the unit is runnable again, and its last attempt lapses with no retry left.
    opened.clock.advance(500);
    const woken = await sweepUnits(opened.orchestrator, { runId });
    expect(woken.swept.map((unit) => `${unit.unitId}:${unit.outcome}`)).toEqual(['snapshot/src:woken']);
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('ready');
    const again = await leaseUnit(opened.owner, { unitId: 'snapshot/src', holder: 'worker-that-dies-again', ttlMs: 1_000, at: opened.clock.now() });
    expect(again.ok).toBe(true);
    // The token grew with the attempt: the second lease is not the first one again.
    expect(again.ok ? again.record.context.fence : 0).toBe(2);
    opened.clock.advance(1_000);
    const failed = await sweepUnits(opened.orchestrator, { runId });
    expect(failed.swept.map((unit) => `${unit.unitId}:${unit.outcome}`)).toEqual(['snapshot/src:failed']);
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('failed');
    expect(await readPublications(opened.owner, 'snapshot/src')).toEqual([]);
  });

});

describe('the service the background server owns', () => {
  test('a service with nothing wired refuses a run and names what is missing, and opens nothing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'madarch-fill-host-'));
    try {
      const service = createFillOrchestratorService({ home, registry: basicRegistry() });
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

  test('daemon wiring opens no database before a run, and stops cleanly', async () => {
    const home = await mkdtemp(join(tmpdir(), 'madarch-fill-daemon-'));
    try {
      const service = daemonFillOrchestrator(home);
      await service.stop();
      expect(existsSync(join(home, '.madarch'))).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('a wired service opens the process\'s database once, runs a fill to its end and closes what it opened', async () => {
    const home = await mkdtemp(join(tmpdir(), 'madarch-fill-host-'));
    try {
      const graph = fakeGraph();
      const applied: string[] = [];
      const service = createFillOrchestratorService({
        home,
        registry: basicRegistry(),
        wiring: () => ({
          snapshot: () => SNAPSHOT,
          configuration: () => undefined,
          graph: () => graph.reader,
          inputs: () => ({ commit: 'a1b2c3d4' }),
          facts: { apply: async ({ unit, writes }) => { applied.push(unit.unitId); return writes.length; } },
        }),
      });
      const result = await service.run({ product: { name: 'fixture-product', folder: home }, runId: 'run-host-1', workers: 2 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.settled).toBe(true);
      expect(result.state).toBe('succeeded');
      expect(result.units.every((unit) => unit.state === 'published')).toBe(true);
      expect(applied).toHaveLength(4);
      expect(existsSync(join(home, '.madarch', 'fill', 'state.db'))).toBe(true);

      // The status of the run is readable while the service is open, and the second run of the same
      // product reuses what the first one opened.
      const status = await service.status({ product: { name: 'fixture-product', folder: home }, runId: 'run-host-1' });
      expect(status?.run.state).toBe('succeeded');
      const again = await service.run({ product: { name: 'fixture-product', folder: home }, runId: 'run-host-2', workers: 2 });
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.state).toBe('succeeded');
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

  test('a stage that raised spends a retry, and the progress it reported before raising is kept', async () => {
    const raise = { value: true };
    const registry = new StageRegistry().register(fakeStage('snapshot', {
      produces: [{ kind: 'file-facts', schemaVersion: 1, scope: 'repository' }],
      plan: () => ({ units: [{ id: 'src', scope: 'src' }], coverage: 'planned' }),
      execute: (_unit, context) => {
        context.progress('read half the repository', 0.5);
        if (raise.value) throw new Error('the snapshot tool answered nothing');
        return { outcome: 'draft' };
      },
    }));
    const { world: opened, runId } = await plannedWorld({ registry, limits: { retryDelayMs: 1_000, retries: 1 } });
    await admitUnits(opened.orchestrator, { runId });
    const retried = await workOnce(opened.orchestrator, { worker: 'worker-1' });
    expect(retried.result).toBe('retried');
    expect(retried.summary).toContain('the snapshot tool answered nothing');
    const unit = await readUnit(opened.owner, 'snapshot/src');
    expect(unit?.state).toBe('retry_wait');
    expect(unit?.context.retriesLeft).toBe(0);
    expect(await readPublications(opened.owner, 'snapshot/src')).toEqual([]);
    // What the stage reported before it raised is the run's own durable progress, not a silence.
    const reported = (await readProgress(opened.owner, runId)).filter((event) => event.kind === 'unit-progress');
    expect(reported.map((event) => event.summary)).toEqual(['read half the repository (50%)']);

    // The retry raises too, and with no retry left the generation fails for good.
    opened.clock.advance(1_000);
    await sweepUnits(opened.orchestrator, { runId });
    const failed = await workOnce(opened.orchestrator, { worker: 'worker-2' });
    expect(failed.result).toBe('failed');
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('failed');
    expect((await readProgress(opened.owner, runId)).at(-1)?.kind).toBe('unit-failed');
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

  test('a failed child the run accepts as partial lets the parent join and publish', async () => {
    const { stage } = splittingStage();
    const registry = new StageRegistry().register(stage);
    const { world: opened, runId } = await plannedWorld({ registry, limits: { retryDelayMs: 0, failedChildPolicy: 'accept-partial' } });
    await admitUnits(opened.orchestrator, { runId });
    await workOnce(opened.orchestrator, { worker: 'worker-1' });
    expect((await advanceUnit(opened.owner, { unitId: 'modules/left', event: { type: 'cancel', at: NOW, cause: 'the child was cancelled' } })).ok).toBe(true);
    await admitUnits(opened.orchestrator, { runId });
    expect((await workOnce(opened.orchestrator, { worker: 'worker-2' })).result).toBe('published');

    const swept = await sweepUnits(opened.orchestrator, { runId });
    expect(swept.swept.map((unit) => `${unit.unitId}:${unit.outcome}`)).toEqual(['modules/root:join-enqueued']);
    const joined = await workOnce(opened.orchestrator, { worker: 'worker-3' });
    expect(joined.result).toBe('published');
    expect((await readUnit(opened.owner, 'modules/root'))?.state).toBe('published');
    expect((await readTransitions(opened.owner, { kind: 'unit', id: 'modules/root' })).map((entry) => entry.transitionId))
      .toContain('unit/waiting_children--join-accepted-partial-->ready');
    // The policy lets the parent carry on; it does not claim the run covered a child that never
    // published, so the run finishes with the hole it has.
    const settlement = await schedulerPass(opened.orchestrator, { runId });
    expect(settlement.run.state).toBe('completed_partial');
    expect(settlement.settlement.evidence.coverageMet).toBe(false);
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

  test('a run inherits the published units it would plan', async () => {
    const registry = new StageRegistry().register(draftingStage('snapshot', { units: ['src'], produces: ['file-facts'] }));
    const { world: opened, runId } = await plannedWorld({ registry });
    expect((await driveRun(opened.orchestrator, { runId, workers: 2 })).run.state).toBe('succeeded');

    const second = 'run-2';
    expect((await startRun(opened.orchestrator, { runId: second })).ok).toBe(true);
    const planned = await planRun(opened.orchestrator, { runId: second });
    expect(planned.outcome).toBe('planned');
    if (planned.outcome !== 'planned') return;
    expect(planned.reused).toEqual(['snapshot/src']);
    expect(planned.units).toEqual([]);
    // Nothing to work: the new run covers what it inherited and finishes.
    const driven = await driveRun(opened.orchestrator, { runId: second, workers: 1 });
    expect(driven.run.state).toBe('succeeded');
    expect(await readPublications(opened.owner, 'snapshot/src')).toHaveLength(1);
  });

  test('a unit another run left behind is refused by name, never reused in silence', async () => {
    const blocking = new StageRegistry().register(fakeStage('blocked-stage', {
      produces: [{ kind: 'other-facts', schemaVersion: 1, scope: 'repository' }],
      plan: () => ({ units: [{ id: 'src', scope: 'src' }], coverage: 'planned' }),
      execute: () => ({ outcome: 'blocked', reason: 'a person must look at this' }),
    }));
    const opened = await world({ registry: blocking, product: 'other-product' });
    await startRun(opened.orchestrator, { runId: 'run-a' });
    expect((await planRun(opened.orchestrator, { runId: 'run-a' })).outcome).toBe('planned');
    await admitUnits(opened.orchestrator, { runId: 'run-a' });
    expect((await workOnce(opened.orchestrator, { worker: 'worker-1' })).result).toBe('blocked');
    expect((await driveRun(opened.orchestrator, { runId: 'run-a', workers: 1 })).run.state).toBe('completed_partial');

    expect((await startRun(opened.orchestrator, { runId: 'run-b' })).ok).toBe(true);
    const refused = await planRun(opened.orchestrator, { runId: 'run-b' });
    expect(refused.outcome).toBe('refused');
    expect(refused.outcome === 'refused' ? refused.code : '').toBe('fill-orchestrator/unit-in-another-run');
    expect(refused.outcome === 'refused' ? refused.reason : '').toContain('stands blocked in run "run-a"');
  });

  test('the scheduler rechecks what went stale before it lets a run finish', async () => {
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
    const { world: opened, runId } = await plannedWorld({ registry, graph });
    await admitUnits(opened.orchestrator, { runId });
    expect((await workOnce(opened.orchestrator, { worker: 'worker-1' })).result).toBe('published');
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('published');

    // The graph moves under the published generation, and the run's own pass finds it before finishing:
    // the generation goes stale, its replacement is planned, and the run does not settle as it stands.
    graph.rows.set(query, [{ module: 'core' }, { module: 'wiki' }]);
    const pass = await schedulerPass(opened.orchestrator, { runId });
    expect(pass.stale).toBe(1);
    expect(pass.run.state).toBe('running');
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('planned');
    expect((await readUnit(opened.owner, 'snapshot/src'))?.generation).toBe(2);
    // The replacement runs, and this time the run finishes over a graph nothing moved under.
    const driven = await driveRun(opened.orchestrator, { runId, workers: 1 });
    expect(driven.run.state).toBe('succeeded');
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('published');
    expect(await readPublications(opened.owner, 'snapshot/src')).toHaveLength(2);
  });

  test('a publication the machine refuses writes no fact, and a moved read refuses it before anything runs', async () => {
    const registry = new StageRegistry().register(draftingStage('snapshot', { units: ['src'], produces: ['file-facts'] }));
    let applications = 0;
    const { world: opened, runId } = await plannedWorld({
      registry,
      apply: async ({ writes }) => { applications += 1; return writes.length; },
    });
    await admitUnits(opened.orchestrator, { runId });
    await workOnce(opened.orchestrator, { worker: 'worker-1' });
    expect(applications).toBe(1);

    // The same generation, then a request whose digest differs: the facts are never applied twice, and a
    // generation that is refused publishes nothing.
    const unit = (await readUnit(opened.owner, 'snapshot/src'))!;
    const replay = await publishUnit(opened.owner, {
      unitId: 'snapshot/src', generation: 1, fence: 1,
      identity: { inputsDigest: unit.inputsDigest, stageId: 'snapshot', stageVersion: 1 }, at: NOW + 1,
      revalidate: async () => ({ membership: 'x', members: 0 }),
      apply: async () => { throw new Error('a replay applies nothing'); },
    });
    expect(replay.outcome).toBe('replayed');
    expect(applications).toBe(1);

    const otherVersion = await publishUnit(opened.owner, {
      unitId: 'snapshot/src', generation: 1, fence: 1,
      identity: { inputsDigest: unit.inputsDigest, stageId: 'snapshot', stageVersion: 2 }, at: NOW + 2,
      revalidate: async () => ({ membership: 'x', members: 0 }),
      apply: async () => { throw new Error('a refused publication applies nothing'); },
    });
    expect(otherVersion.outcome).toBe('refused');
    expect(otherVersion.outcome === 'refused' ? otherVersion.code : '').toBe('fill-publication/digest-mismatch');
    expect(applications).toBe(1);
  });
});

describe('the background server that owns the orchestrator', () => {
  test('holds the orchestrator it was given and stops it with everything else it opened', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'madarch-server-orchestrator-'));
    try {
      let stopped = 0;
      const clock = { now: () => NOW };
      const server = await startServer({
        dataFolder: folder,
        queryDatabase: await createPGliteQueryDatabase({ clock }),
        port: 0,
        clock,
        orchestrator: { stop: async () => { stopped += 1; } },
      });
      // The server holds it while it serves: nothing stops the fill's orchestrator behind the server's back.
      expect(stopped).toBe(0);
      await server.stop();
      expect(stopped).toBe(1);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
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

  test('a generation a person\'s edit left stale is replaced by the next run, never reused', async () => {
    const guard = { verdict: 'conflict' as 'clean' | 'conflict' };
    const registry = new StageRegistry().register(draftingStage('snapshot', { units: ['src'], produces: ['file-facts'] }));
    const { world: opened, runId } = await plannedWorld({ registry, guard: { check: () => guard.verdict } });
    await admitUnits(opened.orchestrator, { runId });
    await workOnce(opened.orchestrator, { worker: 'worker-1' });
    const edited = await schedulerPass(opened.orchestrator, { runId });
    expect(edited.run.state).toBe('blocked');
    const stale = await readUnit(opened.owner, 'snapshot/src');
    expect(stale?.state).toBe('stale');
    expect(stale?.generation).toBe(1);
    expect(await readPublications(opened.owner, 'snapshot/src')).toHaveLength(1);

    // The next run does not inherit it: a stale generation is work to redo, not work already done.
    const second = 'run-2';
    expect((await startRun(opened.orchestrator, { runId: second })).ok).toBe(true);
    guard.verdict = 'clean';
    const planned = await planRun(opened.orchestrator, { runId: second });
    expect(planned.outcome).toBe('planned');
    if (planned.outcome !== 'planned') return;
    expect(planned.reused).toEqual([]);
    expect(planned.units.map((unit) => `${unit.unitId}:${unit.generation}`)).toEqual(['snapshot/src:2']);
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('planned');
    const driven = await driveRun(opened.orchestrator, { runId: second, workers: 1 });
    expect(driven.run.state).toBe('succeeded');
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('published');
    expect(await readPublications(opened.owner, 'snapshot/src')).toHaveLength(2);
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
  test('a lease that lapsed while the unit stood validating is retried, its draft retracted and nothing published', async () => {
    const registry = new StageRegistry().register(draftingStage('snapshot', { units: ['src'], produces: ['file-facts'] }));
    const { world: opened, runId } = await plannedWorld({ registry, limits: { leaseMs: 1_000, retryDelayMs: 500, retries: 2 } });
    await admitUnits(opened.orchestrator, { runId });
    // The unit's own job is left where the admission put it — queued, not claimed:
    // the attempt below is the store's own, which is what a worker's steps are.
    expect((await leaseUnit(opened.owner, { unitId: 'snapshot/src', holder: 'worker-that-dies', ttlMs: 1_000, at: NOW })).ok).toBe(true);
    for (const event of [
      { type: 'start', at: NOW, generation: 1, fence: 1 },
      { type: 'submit-draft', at: NOW, generation: 1, fence: 1 },
    ] as const) {
      expect((await advanceUnit(opened.owner, { unitId: 'snapshot/src', event })).ok).toBe(true);
    }
    // The effect the machine's own step asks for: what the attempt wrote.
    await recordUnitDraft(opened.owner, {
      unitId: 'snapshot/src', generation: 1, at: NOW,
      writes: [{ kind: 'fact', evidence: 'src:1', value: { kind: 'file-facts' } }],
    });
    expect((await advanceUnit(opened.owner, { unitId: 'snapshot/src', event: { type: 'validate-draft', at: NOW, generation: 1, fence: 1 } })).ok).toBe(true);
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('validating');

    // The worker is killed here. Its lease lapses, and the sweep retries the
    // generation: the machine allows the lapse from `validating`, the retry is
    // spent, and the draft the dead attempt recorded is retracted.
    opened.clock.advance(1_000);
    const swept = await sweepUnits(opened.orchestrator, { runId });
    expect(swept).toMatchObject({ swept: [{ unitId: 'snapshot/src', outcome: 'retried' }], refused: [] });
    const retried = await readUnit(opened.owner, 'snapshot/src');
    expect(retried).toMatchObject({ state: 'retry_wait', generation: 1 });
    expect(retried?.context.retriesLeft).toBe(1);
    expect(retried?.context.retryAt).toBe(NOW + 1_500);
    expect((await readUnitDraft(opened.owner, 'snapshot/src', 1))?.retractedAt).toBe(NOW + 1_000);
    expect(await readPublications(opened.owner, 'snapshot/src')).toEqual([]);

    // The retry runs at its own moment and publishes exactly once.
    opened.clock.advance(500);
    expect((await sweepUnits(opened.orchestrator, { runId })).swept.map((unit) => unit.outcome)).toEqual(['woken']);
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('ready');
    const worked = await workOnce(opened.orchestrator, { worker: 'worker-2' });
    expect(worked).toMatchObject({ unitId: 'snapshot/src', result: 'published' });
    expect(await readPublications(opened.owner, 'snapshot/src')).toHaveLength(1);
  }, 30_000);
});


describe('the window between a machine step and its enqueue', () => {
  test('a unit left ready by a retry whose job was lost is offered the queue again, revoked lease and all', async () => {
    const registry = new StageRegistry().register(draftingStage('snapshot', { units: ['src'], produces: ['file-facts'] }));
    const { world: opened, runId } = await plannedWorld({ registry, limits: { leaseMs: 1_000, retryDelayMs: 500, retries: 2 } });
    await admitUnits(opened.orchestrator, { runId });
    // An attempt takes the lease and dies within it: the lapse revokes the lease,
    // which leaves the generation holding a revoked lease row.
    expect((await leaseUnit(opened.owner, { unitId: 'snapshot/src', holder: 'worker-that-dies', ttlMs: 1_000, at: NOW })).ok).toBe(true);
    opened.clock.advance(1_000);
    expect((await sweepUnits(opened.orchestrator, { runId })).swept.map((unit) => unit.outcome)).toEqual(['retried']);

    // The retry's own moment comes and the wake moves the unit to `ready`, and its
    // enqueue is the step after that: here the enqueue's job is settled away, which
    // is what a crash between the two leaves behind.
    opened.clock.advance(500);
    expect((await sweepUnits(opened.orchestrator, { runId })).swept.map((unit) => unit.outcome)).toEqual(['woken']);
    const woken = await readUnit(opened.owner, 'snapshot/src');
    expect(woken).toMatchObject({ state: 'ready', lease: { revokedAt: NOW + 1_000 } });
    const claimed = (await opened.queue.claim<{ unitId: string }>({ queue: QUEUE }))[0]!;
    expect(await opened.queue.fail(QUEUE, claimed, 'the worker that claimed the woken unit died before its lease')).toBe('failed');

    // The unit stands `ready` holding a revoked lease and the queue holds nothing
    // for it: it is offered again, which a guard on "no lease at all" would miss.
    const swept = await sweepUnits(opened.orchestrator, { runId });
    expect(swept).toMatchObject({ swept: [{ unitId: 'snapshot/src', outcome: 'requeued' }], refused: [] });
    const worked = await workOnce(opened.orchestrator, { worker: 'worker-2' });
    expect(worked).toMatchObject({ unitId: 'snapshot/src', result: 'published' });
    expect(await readPublications(opened.owner, 'snapshot/src')).toHaveLength(1);
  }, 30_000);
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

  /** Settles a unit's claim as the queue's own maintenance does: without the machine, and without the worker. */
  async function settleClaimInQueue(opened: World, unitId: string): Promise<void> {
    await opened.owner.run(async (transaction) => {
      await transaction.query(
        `UPDATE ${QUEUE_SCHEMA}.job SET state = 'completed', completed_on = now() WHERE name = $1 AND singleton_key = $2 AND state IN ('created', 'retry', 'active')`,
        [QUEUE, unitId],
      );
    });
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

  test('a step the machine refuses ends the attempt\'s claim, so the run reaches the unit again', async () => {
    const { registry, lapse } = lapsedStage('draft');
    const { world: opened, runId } = await plannedWorld({ registry, limits: { leaseMs: 1_000, retryDelayMs: 500, retries: 2 } });
    await admitUnits(opened.orchestrator, { runId });
    expect(await unfinished(opened)).toEqual(['snapshot/src']);
    lapse.now = async () => {
      opened.clock.advance(1_000);
      expect((await sweepUnits(opened.orchestrator, { runId })).swept.map((unit) => unit.outcome)).toEqual(['retried']);
      // The retry's own moment comes while the attempt still runs: the run wakes the
      // generation to `ready`, and both jobs it asks for are answered "nothing created"
      // — the state the failed CI run reported, where the unit stood ready with its
      // retry spent and one unfinished job holding its key.
      opened.clock.advance(500);
      expect((await sweepUnits(opened.orchestrator, { runId })).swept.map((unit) => unit.outcome)).toEqual(['woken']);
      expect(await unfinished(opened)).toEqual(['snapshot/src']);
    };

    const worked = await workOnce(opened.orchestrator, { worker: 'worker-1' });
    // The unit stands `ready`, so the machine refuses `submit-draft`. The claim that
    // attempt held is settled with the machine's own words, not kept: kept, it would
    // hold the unit's key until the queue's real-time lease let go of it.
    expect(worked).toMatchObject({ unitId: 'snapshot/src', result: 'refused', job: 'completed' });
    expect(worked.refusal?.reason).toContain('"ready"');
    expect((await readUnit(opened.owner, 'snapshot/src'))?.state).toBe('ready');
    expect(await unfinished(opened)).toEqual([]);
    expect(await refusals(opened, runId)).toEqual([expect.stringContaining('refused submit-draft')]);

    // The run's next offer of the unit reaches the queue, and the generation publishes
    // exactly once.
    expect((await sweepUnits(opened.orchestrator, { runId })).swept.map((unit) => unit.outcome)).toEqual(['requeued']);
    expect(await unfinished(opened)).toEqual(['snapshot/src']);
    expect(await workOnce(opened.orchestrator, { worker: 'worker-2' })).toMatchObject({ unitId: 'snapshot/src', result: 'published' });
    expect(await readPublications(opened.owner, 'snapshot/src')).toHaveLength(1);
  }, 30_000);

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

  test('a claim the queue no longer holds is reported as its own to settle, not settled twice', async () => {
    const { registry, lapse } = lapsedStage('draft');
    const { world: opened, runId } = await plannedWorld({ registry, limits: { leaseMs: 1_000, retryDelayMs: 500, retries: 2 } });
    await admitUnits(opened.orchestrator, { runId });
    lapse.now = async () => {
      opened.clock.advance(1_000);
      expect((await sweepUnits(opened.orchestrator, { runId })).swept.map((unit) => unit.outcome)).toEqual(['retried']);
      // The queue's own maintenance gets to the claim first — what its real-time lease
      // does to a worker that went quiet — and the attempt's settlement finds nothing.
      await settleClaimInQueue(opened, 'snapshot/src');
      expect(await unfinished(opened)).toEqual([]);
    };
    const worked = await workOnce(opened.orchestrator, { worker: 'worker-1' });
    expect(worked).toMatchObject({ unitId: 'snapshot/src', result: 'refused', job: 'none' });
    expect(await refusals(opened, runId)).toEqual([expect.stringContaining('The queue no longer held its claim')]);
    // The unit is still the run's: the wake offers it, and it publishes once.
    opened.clock.advance(500);
    expect((await sweepUnits(opened.orchestrator, { runId })).swept.map((unit) => unit.outcome)).toEqual(['woken']);
    expect(await unfinished(opened)).toEqual(['snapshot/src']);
    expect(await workOnce(opened.orchestrator, { worker: 'worker-2' })).toMatchObject({ unitId: 'snapshot/src', result: 'published' });
    expect(await readPublications(opened.owner, 'snapshot/src')).toHaveLength(1);
  }, 30_000);

  test('a split whose suspension the machine refuses ends its claim, and the run still finishes', async () => {
    // The same lapse, one step further: the stage splits, so the seal and the step that
    // suspends the parent — `wait-for-children` — are one transaction, and the step is
    // the one refused. The children that transaction wrote stand (a window of its own,
    // madarch-tzte.19.7's finding: the step should be judged before anything is sealed);
    // what this test holds is the claim: settled, so the run can reach the parent again.
    const lapse: { now?: () => Promise<void> } = {};
    const attempts: string[] = [];
    const registry = new StageRegistry().register(fakeStage('modules', {
      produces: [{ kind: 'module-facts', schemaVersion: 1, scope: 'cluster' }],
      plan: () => ({ units: [{ id: 'root', scope: 'the repository' }], coverage: 'planned' }),
      execute: async (unit, context): Promise<StageExecutionResult> => {
        attempts.push(unit.id);
        if (unit.id === 'root' && attempts.filter((id) => id === unit.id).length === 1) {
          const lapseNow = lapse.now;
          lapse.now = undefined;
          await lapseNow?.();
          return { outcome: 'split', children: [{ id: 'left', scope: 'the left half' }, { id: 'right', scope: 'the right half' }] };
        }
        context.draft.write({ kind: 'fact', evidence: `${unit.scope}:1`, value: { kind: 'module-facts' } });
        return { outcome: 'draft' };
      },
    }));
    const { world: opened, runId } = await plannedWorld({ registry, limits: { leaseMs: 1_000, retryDelayMs: 500, retries: 2 } });
    await admitUnits(opened.orchestrator, { runId });
    lapse.now = async () => {
      opened.clock.advance(1_000);
      expect((await sweepUnits(opened.orchestrator, { runId })).swept.map((unit) => unit.outcome)).toEqual(['retried']);
    };

    const worked = await workOnce(opened.orchestrator, { worker: 'worker-1' });
    expect(worked).toMatchObject({ unitId: 'modules/root', result: 'refused', job: 'completed' });
    expect(worked.refusal?.reason).toContain('wait-for-children');
    expect((await readUnit(opened.owner, 'modules/root'))?.state).toBe('retry_wait');
    expect(await unfinished(opened)).toEqual([]);

    // The parent's retry comes due, and the run drives every generation it holds — the
    // parent and the two children — to one publication each.
    opened.clock.advance(2_000);
    const driven = await driveRun(opened.orchestrator, { runId, workers: 1 });
    if (!driven.settled) {
      const status = await runStatus(opened.orchestrator, runId);
      throw new Error(`the run did not settle (${driven.stoppedBecause ?? 'no reason'}): ${JSON.stringify(status?.units)}; queue ${JSON.stringify(await unfinished(opened))}; progress ${JSON.stringify(await refusals(opened, runId))}`);
    }
    expect(driven.run.state).toBe('succeeded');
    for (const unitId of ['modules/root', 'modules/left', 'modules/right']) {
      expect(await readPublications(opened.owner, unitId)).toHaveLength(1);
    }
  }, 30_000);
});

describe('a draft set a store recorded before the parts existed', () => {
  // madarch-tzte.21.11 stores a draft set in parts, and a store recorded by the code before it holds the
  // whole set in the row's own `writes` column. That row is a set like any other: a reader answers it
  // whole, and a store that answered it empty would publish nothing for it.
  test('is read back whole from its row, and a set recorded again is its parts alone', async () => {
    const owner = createPGliteDatabaseOwner();
    try {
      await createOrchestratorSchema(owner);
      const legacy = [
        { kind: 'fact' as const, evidence: 'src/a.ts:1', value: { at: 1 } },
        { kind: 'fact' as const, evidence: 'src/b.ts:2', value: { at: 2 } },
      ];
      await owner.transaction('write', async (transaction) => {
        await transaction.query(
          `INSERT INTO fill_unit_draft (unit_id, generation, digest, writes, recorded_at, retracted_at)
           VALUES ($1, $2, $3, $4::jsonb, $5, NULL)`,
          ['modules:legacy', 1, 'legacy-digest', JSON.stringify(legacy), NOW],
        );
      });
      const read = await readUnitDraft(owner, 'modules:legacy', 1);
      expect(read?.writes).toEqual(legacy as never);
      expect(read?.digest).toBe('legacy-digest');

      // Recorded again: the row keeps the digest and the times, its own column is emptied, and the set is
      // the parts alone — nothing of the column the store before the parts wrote is read as a write.
      const fewer = [legacy[0]!];
      await recordUnitDraft(owner, { unitId: 'modules:legacy', generation: 1, writes: fewer, at: NOW + 1 });
      const recorded = await readUnitDraft(owner, 'modules:legacy', 1);
      expect(recorded?.writes).toEqual(fewer as never);
      const own = await owner.transaction('snapshot', async (executor) => (await executor.query<{ writes: unknown }>(
        'SELECT writes FROM fill_unit_draft WHERE unit_id = $1 AND generation = $2',
        ['modules:legacy', 1],
      )).rows[0]?.writes);
      expect(own).toEqual([]);
    } finally {
      await owner.close();
    }
  }, 30_000);
});

describe('a draft set larger than one part', () => {
  // madarch-tzte.21.11: one jsonb value of a repository-wide unit's whole draft set — 34 MB for the
  // modules stage over the madarch tree — took the embedded store's memory up by about 490 MB for good.
  // A set is recorded in parts of a few hundred writes, and read back whole and in order.
  test('is recorded in parts no larger than a part, read back whole and in order, and replaced whole', async () => {
    const owner = createPGliteDatabaseOwner();
    try {
      await createOrchestratorSchema(owner);
      // The part is 500 writes (the requirement's own number, not the constant's): 1 001 writes are three
      // parts, and a store that put them in one takes this test down.
      const count = 1_001;
      const writes = Array.from({ length: count }, (_, at) => ({ kind: 'fact' as const, evidence: `src/a.ts:${String(at + 1)}`, value: { at } }));
      const recorded = await recordUnitDraft(owner, { unitId: 'modules:big', generation: 1, writes, at: NOW });
      const parts = await owner.transaction('snapshot', async (executor) => (await executor.query<{ part: unknown; size: unknown }>(
        'SELECT part, jsonb_array_length(writes) AS size FROM fill_unit_draft_part WHERE unit_id = $1 AND generation = $2 ORDER BY part',
        ['modules:big', 1],
      )).rows.map((row) => [Number(row.part), Number(row.size)]));
      expect(parts).toEqual([[0, 500], [1, 500], [2, 1]]);
      const read = await readUnitDraft(owner, 'modules:big', 1);
      expect(read?.writes).toEqual(writes);
      expect(read?.digest).toBe(recorded.digest);

      // Recorded again with fewer writes: the set is the new one, and no part of the one before it stands.
      const fewer = writes.slice(0, 3);
      await recordUnitDraft(owner, { unitId: 'modules:big', generation: 1, writes: fewer, at: NOW + 1 });
      expect((await readUnitDraft(owner, 'modules:big', 1))?.writes).toEqual(fewer);
      // Another generation of the same unit is its own set.
      expect(await readUnitDraft(owner, 'modules:big', 2)).toBeNull();
    } finally {
      await owner.close();
    }
  }, 60_000);
});
