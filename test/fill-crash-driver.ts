/**
 * The crash-injection suite's driver (madarch-tzte.19.6, decision 0027): one
 * small program, built with `bun build --compile`, that runs the fill's
 * orchestrator over the suite's fixture registry on one database — a persistent
 * PGlite folder or a PostgreSQL server — and stops at a named point of a unit's
 * life: it dies there, or it pauses there and waits for a byte on its standard
 * input.
 *
 * `test/fill-crash-suite.test.ts` builds it and drives the phases in sequence on
 * one PGlite folder; `test/fill-crash-postgres.test.ts` runs several of them at
 * once against one PostgreSQL server. It is not a test file itself and it asserts
 * nothing: each phase prints one JSON object on a line of its own and exits 0, or
 * exits with the failure on standard error and a code that is not 0. A phase that
 * hits its interruption point prints its own line first — `{"event":"crash",…}`
 * before it kills itself with `SIGKILL` (exit code 137), `{"event":"pause",…}`
 * before it blocks — and the test holds what it expects.
 *
 *   fill-crash <spec file>
 *
 * The spec file is JSON. Every path in it is the test's:
 *
 * - `storage`: `{"kind":"pglite","folder":"…"}` for a persistent PGlite data
 *   folder, or `{"kind":"postgres","connectionString":"…","schema":"…"}` for a
 *   server, where `schema` is the schema the fill's own tables live in (the
 *   connection is opened with that schema first on its search path).
 * - `queueSchema`: the schema pg-boss's tables live in, so two tests sharing one
 *   server never share a queue.
 * - `clockFile`, `graphFile`, `inputsFile`: the three seams the fixture moves by
 *   hand. The clock file holds the epoch milliseconds every clock reads, so one
 *   process moves time for all of them and nothing ever sleeps; the graph file is
 *   the pinned snapshot's rows by query; the inputs file is what each unit's facts
 *   stand on, and a test that changes it moves a unit's named inputs.
 * - `product`, `productFolder`: the product the run fills and the folder its
 *   manifest (`workspace.yaml`, the product's own fill configuration) is read
 *   from.
 * - `runId`, `limits`, `workers`: the run and the orchestrator's own bounds.
 * - `interrupt`: `{"point":…,"mode":"crash"|"pause","unitId":…}` — the point of a
 *   unit's life the phase stops at. `claim` is the moment the queue handed the job
 *   over and nothing was leased yet; `execute` is inside the stage, after its
 *   tracked read; `validation` is inside the stage's own `validate`; `split` is
 *   after the split's transaction sealed its children and revoked the parent's
 *   lease, and before the parent's job was acknowledged; `publication` is inside
 *   the publication's transaction, after the machine's `publish` step and before
 *   the facts are applied; `acknowledgement` is after the publication's
 *   transaction committed, at the progress event that reports it. A crash kills
 *   the process where it stands; a pause holds it until the test writes a byte on
 *   its standard input, which is how one process acts while another one is frozen
 *   in the middle of a unit.
 * - `phase`: what this process does — `plan`, `run`, `sweep`, `report`, `cancel`,
 *   `recover`, `resubmit` or `service`.
 *
 * The fixture's stages are the chain the task names: `extract` (the extractor,
 * one unit per file its plan reads) → `modules` (the splitting unit: its first
 * attempt seals `left` and `right`, and the attempt after its join drafts the
 * parent's facts) → `overview` (the consumer of what `modules` publishes). Every
 * read a unit makes goes through `context.graph`, so the orchestrator records it
 * as the generation's dependency; every write lands in the suite's own
 * `crash_fact` table inside the publication's transaction, so a publication is
 * observable as exactly one row per unit generation.
 */
import { readFileSync, readSync, writeSync } from 'node:fs';
import { Type } from 'typebox';
import { createPGliteDatabaseOwner, createPostgresDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import type { ClaimRequest, QueueService as QueueContract } from '../src/fill/queue.js';
import { readFillStageConfiguration } from '../src/fill/config.js';
import {
  DEFAULT_ORCHESTRATOR_LIMITS,
  cancelRun,
  createOrchestrator,
  driveRun,
  planRun,
  schedulerPass,
  startRun,
  unitIdFor,
  type FillOrchestrator,
  type OrchestratorLimits,
  type UnitRef,
} from '../src/fill/orchestrator.js';
import {
  createOrchestratorSchema,
  publishUnit,
  readMembership,
  readProgress,
  readPublications,
  readRunConfiguration,
  readSealedChildren,
  readUnitDraft,
  type RunSnapshot,
} from '../src/fill/orchestrator-store.js';
import { createFillOrchestratorService } from '../src/fill/orchestrator-host.js';
import { StageRegistry } from '../src/fill/registry.js';
import { DEFAULT_STAGE_DEFAULTS, type FillStage, type StageDraftSet, type StageExecutionResult, type StageUnitScope } from '../src/fill/stage.js';
import {
  createFillStateSchema,
  readChain,
  readRun,
  readRunUnits,
  readTransitions,
  readUnit,
  readUnitGenerations,
} from '../src/fill/state-store.js';
import { byCodePoint } from '../src/model/order.js';

// ---- the spec the test writes ----------------------------------------------

export type InterruptPoint = 'claim' | 'execute' | 'validation' | 'split' | 'publication' | 'acknowledgement';

export interface Interrupt {
  readonly point: InterruptPoint;
  readonly mode: 'crash' | 'pause';
  /** The unit this interruption is about; left out, the first unit of any. */
  readonly unitId?: string;
}

export interface ClaimIdentity {
  readonly id: string;
  readonly queue: string;
  readonly attempt: number;
  readonly retries: number;
  readonly data: { readonly unitId: string; readonly generation: number };
}

export type DriverPhase =
  | { readonly kind: 'plan' }
  | { readonly kind: 'run'; readonly workers?: number; readonly maxPasses?: number }
  | { readonly kind: 'sweep' }
  | { readonly kind: 'report' }
  | { readonly kind: 'cancel'; readonly cause: string }
  | { readonly kind: 'recover'; readonly job: ClaimIdentity }
  | { readonly kind: 'resubmit'; readonly unitId: string; readonly generation: number; readonly fence: number; readonly identity: 'same' | 'different' }
  | { readonly kind: 'service'; readonly workers?: number };

export interface DriverSpec {
  readonly storage: { readonly kind: 'pglite'; readonly folder: string }
    | { readonly kind: 'postgres'; readonly connectionString: string; readonly schema: string };
  readonly queueSchema: string;
  readonly clockFile: string;
  readonly graphFile: string;
  readonly inputsFile: string;
  readonly product: string;
  readonly productFolder: string;
  readonly runId: string;
  readonly limits?: Partial<OrchestratorLimits>;
  readonly interrupt?: Interrupt;
  readonly phase: DriverPhase;
}

/**
 * This driver's own source path: run from source that is the file's own absolute
 * path; bundled — the suite's `bun build --compile` binary, where `import.meta.url`
 * is `/$bunfs/root/<binary>` — it is this source path, and the line and column are
 * the bundle's, because a bundle carries no source map.
 */
const SOURCE_PATH = 'test/fill-crash-driver.ts';

/** The file, line and column of the statement that calls this helper, as the project's own errors carry them. */
function site(): string {
  const frames = (new Error().stack ?? '').split('\n').slice(1);
  for (const frame of frames) {
    const located = /\(?([^\s()]+):(\d+):(\d+)\)?\s*$/.exec(frame.trim());
    if (located === null) continue;
    if (/at\s+(site|fail)\b/.test(frame)) continue;
    return `${located[1]}:${located[2]}:${located[3]}`;
  }
  return SOURCE_PATH;
}

/** Raises a failure that names this driver, its line and what went wrong; nothing here fails quietly. */
function fail(what: string, detail: string): never {
  console.error(`${site()}: ${what}: ${detail}`);
  process.exit(2);
}

/** Prints one JSON object on its own line, flushed before anything else happens. */
function say(value: unknown): void {
  writeSync(1, `${JSON.stringify(value)}\n`);
}

// ---- the seams the test moves by hand --------------------------------------

/** The epoch milliseconds of the suite's one clock, read fresh so any process's move is seen at once. */
function readClock(file: string): number {
  const text = readFileSync(file, 'utf8').trim();
  const value = Number(text);
  if (!Number.isInteger(value)) fail('the clock file holds no epoch milliseconds', `${file} holds ${JSON.stringify(text)}`);
  return value;
}

/** The pinned graph: rows by query, for the whole suite, read fresh by every read. */
function readGraph(file: string): Record<string, readonly unknown[]> {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) fail('the graph file is no mapping of queries to rows', file);
  return parsed as Record<string, readonly unknown[]>;
}

/** The named inputs a unit's facts stand on: a digest held for the unit, or the file's `*` default. */
function readInputs(file: string, ref: UnitRef): Record<string, string> {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) fail('the inputs file is no mapping of units to their inputs', file);
  const table = parsed as Record<string, Record<string, string> | undefined>;
  const chosen = table[ref.unitId] ?? table['*'];
  if (chosen === undefined) fail(`the inputs file names no inputs for "${ref.unitId}" and holds no default`, file);
  return chosen;
}

// ---- the interruption: crash or pause where the phase says ------------------

/** What one interruption says about where it happened. */
interface InterruptDetail {
  readonly unitId: string;
  readonly generation?: number;
  readonly job?: ClaimIdentity;
}

interface Interruption {
  readonly point: InterruptPoint;
  readonly mode: 'crash' | 'pause';
  readonly unitId?: string;
}

/** Builds the interruption the spec asks for, refusing the ones that cannot work. */
function interruptionOf(spec: DriverSpec): Interruption | undefined {
  const asked = spec.interrupt;
  if (asked === undefined) return undefined;
  if (asked.mode === 'pause' && (asked.point === 'publication' || asked.point === 'acknowledgement')) {
    // A pause at either point holds the publication's own transaction open, and
    // every other process of the suite would wait on its row: the suite pauses
    // where a unit holds its lease and crashes where it holds a transaction.
    fail(`a pause at "${asked.point}" would hold a transaction open`,
      'pause at "claim", "execute", "validation" or "split" instead, or crash at this point');
  }
  return { point: asked.point, mode: asked.mode, ...(asked.unitId === undefined ? {} : { unitId: asked.unitId }) };
}

/**
 * One interruption, taken at most once in a process. Every line it prints names
 * the claim the process held at that moment — a later phase settles that claim,
 * and which job it was is exactly what the line has to carry.
 */
function interrupter(
  interruption: Interruption | undefined,
  held: () => ClaimIdentity | undefined,
): (point: InterruptPoint, detail: InterruptDetail) => Promise<void> {
  let taken = false;
  return async (point, detail) => {
    if (interruption === undefined || taken || interruption.point !== point) return;
    if (interruption.unitId !== undefined && interruption.unitId !== detail.unitId) return;
    taken = true;
    const claim = detail.job ?? held();
    const said = { point, ...detail, ...(claim === undefined ? {} : { job: claim }) };
    if (interruption.mode === 'crash') {
      say({ event: 'crash', ...said });
      process.kill(process.pid, 'SIGKILL');
      // A SIGKILL cannot be caught; this keeps the type checker and a process
      // whose signal was somehow ignored from carrying on into the next step.
      process.exit(137);
    }
    say({ event: 'pause', ...said });
    await waitForOneByte();
  };
}

/** Blocks until the test writes one byte on this process's standard input. */
async function waitForOneByte(): Promise<void> {
  const buffer = new Uint8Array(1);
  for (;;) {
    const read = readSync(0, buffer, 0, 1, null);
    if (read > 0) return;
  }
}

// ---- the fixture's stages ---------------------------------------------------

/** The suite's own table: one row per fact the fixture published, so a publication is countable. */
const FACTS_TABLE = 'crash_fact';

/** The fixture's stages, by the chain the task names. */
const EXTRACT = 'extract';
const MODULES = 'modules';
const OVERVIEW = 'overview';

/** How many attempts the unit has spent, as the store holds it: 1 while its first attempt runs. */
async function spentAttempts(database: DatabaseOwner, stageId: string, stageUnitId: string): Promise<number> {
  const record = await readUnit(database, unitIdFor(stageId, stageUnitId));
  return record?.context.attempt ?? 0;
}

/**
 * The fixture's registry: the extractor, the splitting unit and the consumer,
 * with the fake behaviour the suite drives them through. Every read goes through
 * the context's graph, so the orchestrator records it; every write is a fact of
 * the stage's own kind.
 */
function fixtureRegistry(options: {
  readonly graph: (query: string) => readonly unknown[];
  readonly interrupt: (point: InterruptPoint, detail: InterruptDetail) => Promise<void>;
  readonly attempts: (stageId: string, stageUnitId: string) => Promise<number>;
}): StageRegistry {
  /** The unit the stage in this process is running: the orchestrator awaits one attempt at a time. */
  let running: string | null = null;
  /**
   * What every stage of the fixture judges its draft with: a stage's `validate`
   * is handed the draft set and the graph, never the unit, so the unit `execute`
   * last ran is the unit being validated here — the orchestrator awaits one
   * attempt at a time in this process.
   */
  const validate = async (): Promise<{ ok: true }> => {
    if (running !== null) await options.interrupt('validation', { unitId: running });
    return { ok: true };
  };
  const draftOf = (scope: string, kind: string) => (write: (entry: { kind: 'fact'; evidence: string; value: unknown }) => void, rows: readonly unknown[]): void => {
    rows.forEach((row, index) => write({ kind: 'fact', evidence: `${scope}:${index}`, value: { kind, row } }));
  };

  /** The extractor: one unit per file the pinned graph names, one fact per symbol it reads. */
  const extract: FillStage = {
    id: EXTRACT,
    version: 1,
    consumes: { required: [], optional: [] },
    produces: [{ kind: 'file-facts', schemaVersion: 1, scope: 'repository' }],
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, concurrency: 2 },
    plan: (graph) => {
      const files = options.graph('files');
      if (files.length === 0) return { units: [], coverage: 'nothing-found' };
      const units: StageUnitScope[] = files.map((row) => {
        const file = row as { id?: unknown; scope?: unknown };
        if (typeof file.id !== 'string' || typeof file.scope !== 'string') fail('the graph file\'s "files" rows are not {id, scope}', JSON.stringify(row));
        return { id: file.id, scope: file.scope };
      });
      return { units, coverage: 'planned' };
    },
    execute: async (unit, context): Promise<StageExecutionResult> => {
      const symbols = await context.graph.query(`symbols:${unit.scope}`);
      running = unitIdFor(EXTRACT, unit.id);
      await options.interrupt('execute', { unitId: running });
      draftOf(unit.scope, 'file-facts')((entry) => context.draft.write(entry), symbols);
      return { outcome: 'draft' };
    },
    validate,
  };

  /** The splitting unit: its first attempt seals two children, the attempt after its join drafts. */
  const modules: FillStage = {
    id: MODULES,
    version: 1,
    consumes: { required: [{ capability: 'file-facts', scope: 'repository' }], optional: [] },
    produces: [{ kind: 'module-facts', schemaVersion: 1, scope: 'cluster' }],
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, concurrency: 1 },
    plan: () => ({ units: [{ id: 'root', scope: 'the repository' }], coverage: 'planned' }),
    execute: async (unit, context): Promise<StageExecutionResult> => {
      const first = (await options.attempts(MODULES, unit.id)) === 1;
      if (unit.id === 'root' && first) {
        return { outcome: 'split', children: [{ id: 'left', scope: 'the left half' }, { id: 'right', scope: 'the right half' }] };
      }
      const summaries = await context.graph.query(`summaries:${unit.scope}`);
      running = unitIdFor(MODULES, unit.id);
      await options.interrupt('execute', { unitId: running });
      draftOf(unit.scope, 'module-facts')((entry) => context.draft.write(entry), summaries);
      return { outcome: 'draft' };
    },
    validate,
  };

  /** The consumer: it reads what the splitting unit published and drafts the overview. */
  const overview: FillStage = {
    id: OVERVIEW,
    version: 1,
    consumes: { required: [{ capability: 'module-facts', scope: 'cluster' }], optional: [] },
    produces: [{ kind: 'product-overview', schemaVersion: 1, scope: 'product' }],
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, concurrency: 1 },
    plan: () => ({ units: [{ id: 'product', scope: 'the product' }], coverage: 'planned' }),
    execute: async (unit, context): Promise<StageExecutionResult> => {
      const facts = await context.graph.query('product-facts');
      running = unitIdFor(OVERVIEW, unit.id);
      await options.interrupt('execute', { unitId: running });
      draftOf(unit.scope, 'product-overview')((entry) => context.draft.write(entry), facts);
      return { outcome: 'draft' };
    },
    validate,
  };

  return new StageRegistry().register(extract).register(modules).register(overview);
}

// ---- the world one phase runs in -------------------------------------------

/** One phase's world: the process's owner, the queue, the registry and the orchestrator over them. */
interface World {
  readonly owner: DatabaseOwner;
  readonly queue: QueueService;
  readonly registry: StageRegistry;
  readonly orchestrator: FillOrchestrator;
  readonly spec: DriverSpec;
  close(): Promise<void>;
}

/** The queue service the driver builds, named so the phase's own world can hold it. */
type QueueService = Awaited<ReturnType<typeof createPgBossQueue>>;

/** The pinned snapshot the run stands on: the fixture's own repository, at one commit. */
function snapshotOf(spec: DriverSpec): RunSnapshot {
  return { repository: `example.com/fixture/${spec.product}`, defaultBranch: 'main', commit: 'c1', registryHash: 'sha256:crash-fixture' };
}

/** A claimed job's identity, as a phase prints it and a later phase settles it. */
function identityOf(job: { readonly id: string; readonly queue: string; readonly attempt: number; readonly retries: number; readonly data: { readonly unitId: string; readonly generation: number } }): ClaimIdentity {
  return { id: job.id, queue: job.queue, attempt: job.attempt, retries: job.retries, data: { unitId: job.data.unitId, generation: job.data.generation } };
}

/** What a wrapped queue hears at the two moments a kill stands at. */
interface QueueHooks {
  readonly claim: (job: ClaimIdentity) => Promise<void>;
  readonly complete: (job: ClaimIdentity, output: object | undefined, insideTransaction: boolean) => Promise<void>;
}

/** The queue, with the moments the suite interrupts it made visible and everything else passed through. */
function wrapQueue(queue: QueueService, hooks: QueueHooks): QueueContract {
  return {
    declare: (declaration) => queue.declare(declaration),
    enqueue: (request) => queue.enqueue(request),
    claim: async <Data>(request: ClaimRequest) => {
      const jobs = await queue.claim<Data>(request);
      for (const job of jobs) {
        await hooks.claim(identityOf(job as unknown as { id: string; queue: string; attempt: number; retries: number; data: { unitId: string; generation: number } }));
      }
      return jobs;
    },
    heartbeat: (name, job) => queue.heartbeat(name, job),
    complete: async (name, job, output, transaction) => {
      await hooks.complete(identityOf(job as unknown as { id: string; queue: string; attempt: number; retries: number; data: { unitId: string; generation: number } }), output, transaction !== undefined);
      return await queue.complete(name, job, output, transaction);
    },
    fail: (name, job, reason, transaction) => queue.fail(name, job, reason, transaction),
    recover: (name) => queue.recover(name),
    deadLetters: (name, options) => queue.deadLetters(name, options),
    stop: () => queue.stop(),
  };
}

/** Opens the process's one database, the fill's tables, the queue and the orchestrator over them. */
async function openWorld(spec: DriverSpec, interruption: Interruption | undefined): Promise<World> {
  const limits: OrchestratorLimits = { ...DEFAULT_ORCHESTRATOR_LIMITS, leaseMs: 1_000, retryDelayMs: 1_000, maxInFlight: 2, ageingStepMs: 60_000, ...spec.limits };
  const owner: DatabaseOwner = spec.storage.kind === 'pglite'
    ? createPGliteDatabaseOwner({ path: spec.storage.folder })
    : await createPostgresDatabaseOwner({ connectionString: spec.storage.connectionString });
  if (spec.storage.kind === 'postgres') {
    // The fill's own tables live in the schema the test named, and the connection
    // carries that schema first on its search path, so two tests of one server
    // never share a run's rows.
    await owner.exec(`CREATE SCHEMA IF NOT EXISTS "${spec.storage.schema}"`).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already exists/i.test(message)) throw error;
    });
  }
  await owner.exec(`CREATE TABLE IF NOT EXISTS ${FACTS_TABLE} (seq bigserial PRIMARY KEY, unit_id text NOT NULL, generation integer NOT NULL, digest text NOT NULL, facts integer NOT NULL, applied_at bigint NOT NULL)`);
  await createFillStateSchema(owner);
  await createOrchestratorSchema(owner);
  const queue = await createPgBossQueue({ owner, schema: spec.queueSchema, supervise: false });
  // The unit's own accounting carries its retries, so the queue retries nothing
  // itself: a settlement says an attempt is over, and the orchestrator enqueues
  // the retry at the moment its own machine recorded. The queue's own lease is
  // the real-time bound of one claim, which the suite never waits out: what the
  // tests expire by hand is the orchestrator's lease, on the suite's own clock.
  await queue.declare({ name: spec.runId, leaseSeconds: 60, retries: 0, retryDelaySeconds: 0, retryBackoff: false, singletons: true });

  /** The claim this process holds: every claim the queue hands it, the latest one. */
  let lastClaim: ClaimIdentity | undefined;
  const interrupt = interrupter(interruption, () => lastClaim);
  const registry = fixtureRegistry({
    graph: (query) => readGraph(spec.graphFile)[query] ?? [],
    interrupt,
    attempts: async (stageId, stageUnitId) => await spentAttempts(owner, stageId, stageUnitId),
  });
  const graph = () => ({ query: async (text: string) => readGraph(spec.graphFile)[text] ?? [] });
  const applyFacts = async ({ executor, unit, digest, writes }: Parameters<FillOrchestrator['facts']['apply']>[0]): Promise<number> => {
    // The publication's own transaction: the facts land with the state and the
    // queue's settlement, or not at all. That is what "one publication per
    // generation" is read from here — one row per unit generation, ever.
    await interrupt('publication', { unitId: unit.unitId, generation: unit.generation });
    await executor.query(
      `INSERT INTO ${FACTS_TABLE} (unit_id, generation, digest, facts, applied_at) VALUES ($1, $2, $3, $4, $5)`,
      [unit.unitId, unit.generation, digest, writes.length, readClock(spec.clockFile)],
    );
    return writes.length;
  };
  const sink = spec.interrupt === undefined ? undefined : (event: { readonly kind: string; readonly unitId: string; readonly generation: number | null }): Promise<void> | void => {
    if (event.kind === 'unit-published') return interrupt('acknowledgement', { unitId: event.unitId, generation: event.generation ?? 0 });
  };
  const wrapped = wrapQueue(queue, {
    claim: async (job) => { lastClaim = job; await interrupt('claim', { unitId: job.data.unitId, generation: job.data.generation, job }); },
    complete: async (job, output, insideTransaction) => {
      // The acknowledgement of a split is the queue's own call, outside every
      // transaction, and it follows the seal by one step: a kill here leaves the
      // children sealed, the parent's lease revoked and its job unsettled. A
      // publication settles inside the publication's own transaction, where a
      // kill is the publication's crash point instead.
      const reason = (output as { reason?: unknown } | undefined)?.reason;
      if (!insideTransaction && typeof reason === 'string' && reason.startsWith('suspended for')) {
        await interrupt('split', { unitId: job.data.unitId, generation: job.data.generation, job });
      }
    },
  });
  const orchestrator = createOrchestrator({
    database: owner,
    registry,
    queue: wrapped,
    queueName: spec.runId,
    product: spec.product,
    configuration: () => readFillStageConfiguration(spec.productFolder),
    snapshot: () => snapshotOf(spec),
    graph,
    inputs: (ref) => readInputs(spec.inputsFile, ref),
    facts: { apply: applyFacts },
    clock: () => readClock(spec.clockFile),
    ...(sink === undefined ? {} : { sink }),
    limits,
  });
  return {
    owner, queue, registry, orchestrator, spec,
    close: async () => { await queue.stop(); await owner.close(); },
  };
}

// ---- the phases -------------------------------------------------------------

/** One run's own record, as a report prints it. */
async function runFacts(world: World, runId: string): Promise<Record<string, unknown>> {
  const run = await readRun(world.owner, runId);
  const units = await readRunUnits(world.owner, runId);
  const generations: Record<string, unknown>[] = [];
  for (const unit of units) {
    for (const generation of await readUnitGenerations(world.owner, unit.unitId)) {
      generations.push({
        unitId: generation.unitId, generation: generation.generation, state: generation.state,
        attempt: generation.context.attempt, fence: generation.context.fence,
        // The lease the generation holds, as it stands: what the run's own sweep
        // judges an abandoned attempt by.
        lease: generation.lease === null ? null : {
          attempt: generation.lease.attempt, fence: generation.lease.fence,
          issuedAt: generation.lease.issuedAt, expiresAt: generation.lease.expiresAt, revokedAt: generation.lease.revokedAt,
        },
      });
    }
  }
  const publications = [];
  for (const unit of units) {
    for (const record of await readPublications(world.owner, unit.unitId)) {
      publications.push({ unitId: record.unitId, generation: record.generation, digest: record.digest, facts: record.facts, publishedAt: record.publishedAt });
    }
  }
  const sealed = [];
  const childStates = [];
  for (const unit of units) {
    for (const child of await readSealedChildren(world.owner, unit.unitId, unit.generation)) {
      sealed.push({ parentUnitId: unit.unitId, parentGeneration: unit.generation, childUnitId: child.unitId, childGeneration: child.generation, sealedAt: child.sealedAt });
      const state = await readUnit(world.owner, child.unitId);
      childStates.push({ unitId: child.unitId, generation: child.generation, state: state?.state ?? null });
    }
  }
  const transitions = [];
  for (const subject of [{ kind: 'run' as const, id: runId }, ...units.map((unit) => ({ kind: 'unit' as const, id: unit.unitId }))]) {
    for (const step of await readTransitions(world.owner, subject)) {
      transitions.push({ subject: step.subjectId, generation: step.generation, transition: step.transitionId, from: step.from, to: step.to, event: step.event, fence: step.fence, at: step.at });
    }
  }
  return {
    run: run === null ? null : { runId: run.runId, state: run.state, context: run.context },
    units: units.map((unit) => ({
      unitId: unit.unitId, stageId: unit.stageId, state: unit.state, generation: unit.generation,
      attempt: unit.context.attempt, fence: unit.context.fence, inputsDigest: unit.inputsDigest,
      publishedAt: unit.publishedAt, staleAt: unit.staleAt,
    })),
    generations,
    publications: publications.sort((left, right) => byCodePoint(left.unitId, right.unitId) || left.generation - right.generation),
    sealed: sealed.sort((left, right) => byCodePoint(left.childUnitId, right.childUnitId)),
    childStates: childStates.sort((left, right) => byCodePoint(left.unitId, right.unitId)),
    transitions: transitions.sort((left, right) => left.at - right.at),
  };
}

/** What the suite's own tables hold, plus what the queue still owes. */
async function storageFacts(world: World): Promise<Record<string, unknown>> {
  const facts = await world.owner.run(async (executor) => (await executor.query<{ unit_id: string; generation: number; digest: string; facts: number; applied_at: unknown }>(`SELECT unit_id, generation, digest, facts, applied_at FROM ${FACTS_TABLE} ORDER BY seq`)).rows);
  const unfinished = await world.owner.run(async (executor) => (await executor.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM ${queueTable(world.spec.queueSchema)} WHERE name = $1 AND state IN ('created', 'retry', 'active')`,
    [world.spec.runId],
  )).rows);
  const progress = await readProgressOf(world);
  const deadLetters = await world.queue.deadLetters(world.spec.runId);
  return {
    facts: facts.map((row) => ({ unitId: row.unit_id, generation: row.generation, digest: row.digest, facts: row.facts })),
    progress,
    queue: { unfinished: unfinished[0]?.count ?? 0, deadLetters: deadLetters.length },
  };
}

/** The run's durable progress events, oldest first. */
async function readProgressOf(world: World): Promise<Record<string, unknown>[]> {
  const events = await readProgress(world.owner, world.spec.runId);
  return events.map((event) => ({ seq: event.seq, at: event.at, stage: event.stage, unitId: event.unitId, generation: event.generation, kind: event.kind, summary: event.summary }));
}

/** The queue's tables, in the schema the queue was given. */
function queueTable(schema: string): string {
  return `"${schema}".job`;
}

/** Plans the run this phase's product holds, or starts it. */
async function phasePlan(world: World): Promise<void> {
  const started = await startRun(world.orchestrator, { runId: world.spec.runId });
  if (!started.ok) {
    say({ event: 'plan', outcome: 'refused', code: started.code, reason: started.reason });
    return;
  }
  const plan = await planRun(world.orchestrator, { runId: world.spec.runId });
  if (plan.outcome === 'planned') {
    say({
      event: 'plan', outcome: 'planned', run: plan.run.state,
      units: plan.units.map((unit) => ({ unitId: unit.unitId, stageId: unit.stageId, state: unit.state, generation: unit.generation, created: unit.created })),
      reused: plan.reused, foundNothing: plan.foundNothing, configurationDigest: plan.configurationDigest,
    });
    return;
  }
  if (plan.outcome === 'blocked') {
    say({ event: 'plan', outcome: 'blocked', run: plan.run.state, path: plan.path, starvation: plan.starvation.map((path) => ({ consumer: path.consumer, capability: path.capability, producer: path.producer ?? null, reason: path.reason, path: path.path })) });
    return;
  }
  say({ event: 'plan', outcome: 'refused', code: plan.code, reason: plan.reason, run: plan.run.state });
}

/** Drives the run: the scheduler's pass and the workers' claims, until it settles or nothing moves. */
async function phaseRun(world: World, phase: Extract<DriverPhase, { kind: 'run' }>): Promise<void> {
  const driven = await driveRun(world.orchestrator, {
    runId: world.spec.runId,
    workers: phase.workers ?? 1,
    ...(phase.maxPasses === undefined ? {} : { maxPasses: phase.maxPasses }),
  });
  say({ event: 'run', run: driven.run.state, settled: driven.settled, passes: driven.passes, work: driven.work, ...(driven.stoppedBecause === undefined ? {} : { stoppedBecause: driven.stoppedBecause }) });
}

/** One scheduler pass, by hand. */
async function phaseSweep(world: World): Promise<void> {
  const pass = await schedulerPass(world.orchestrator, { runId: world.spec.runId });
  say({
    event: 'sweep', run: pass.run.state, admitted: pass.admitted, swept: pass.swept, stale: pass.stale,
    moved: pass.moved, guarded: pass.guarded,
    settlement: { outcome: pass.settlement.outcome, evidence: pass.settlement.evidence },
    refused: pass.refused,
  });
}

/** Everything the run left, for the test to judge. */
async function phaseReport(world: World): Promise<void> {
  const chain = await readChain(world.owner, world.spec.product);
  const configuration = await readRunConfiguration(world.owner, world.spec.runId);
  say({
    event: 'report',
    chain: chain === null ? null : { product: chain.product, state: chain.state, context: chain.context },
    configuration: configuration === null ? null : { digest: configuration.digest, snapshot: configuration.snapshot },
    ...(await runFacts(world, world.spec.runId)),
    ...(await storageFacts(world)),
  });
}

/** Cancels the run, as a person's stop does. */
async function phaseCancel(world: World, phase: Extract<DriverPhase, { kind: 'cancel' }>): Promise<void> {
  const cancelled = await cancelRun(world.orchestrator, { runId: world.spec.runId, cause: phase.cause });
  say({ event: 'cancel', run: cancelled.run.state, cancelledUnits: cancelled.cancelledUnits, refused: cancelled.refused, settlement: cancelled.settlement.outcome });
}

/**
 * Recovers what a killed worker left: the queue's own maintenance pass, and then
 * the claim that worker held, settled for good by this process — a claim whose
 * worker died is recovered by the queue's own sweep, which waits for its lease,
 * so the suite settles it by hand and never waits on a timer.
 */
async function phaseRecover(world: World, phase: Extract<DriverPhase, { kind: 'recover' }>): Promise<void> {
  const job = phase.job;
  if (job === undefined) fail('the recovery phase was given no claim to settle', 'the crash or pause line of the killed phase names the job under "job"');
  await world.queue.recover(world.spec.runId);
  const state = await world.owner.run(async (executor) => (await executor.query<{ state: string }>(
    `SELECT state FROM ${queueTable(world.spec.queueSchema)} WHERE id = $1`,
    [job.id],
  )).rows[0]?.state);
  if (state !== 'active') {
    // A claim a publication's own transaction settled is not this phase's to
    // settle: it says which state the claim stands in, and the suite reads that
    // as the settlement landing with the publication it belongs to.
    say({ event: 'recover', settled: state ?? 'unknown' });
    return;
  }
  const outcome = await world.queue.fail(world.spec.runId, {
    id: job.id, queue: job.queue, attempt: job.attempt, retries: job.retries,
    data: job.data, leaseSeconds: 60,
  }, 'the worker that held this claim was killed and never settled it');
  say({ event: 'recover', settled: outcome });
}

/**
 * Submits one generation's result again, as a second worker of the same attempt
 * or a late one would: the publication the machine holds is asked for with the
 * fence the caller names, and with the stage's own identity or one a newer stage
 * module would carry. The same identity answers the existing record; a different
 * one is refused.
 */
async function phaseResubmit(world: World, phase: Extract<DriverPhase, { kind: 'resubmit' }>): Promise<void> {
  const unit = await readUnit(world.owner, phase.unitId);
  if (unit === null) fail(`no unit "${phase.unitId}" is recorded`, 'the report of the phase that published it names the unit');
  const draft = await readUnitDraft(world.owner, unit.unitId, phase.generation);
  if (draft === null) fail(`unit "${unit.unitId}" generation ${phase.generation} holds no draft to publish`, 'a draft is recorded before validation and retracted on a retry');
  const stage = world.registry.get(unit.stageId);
  if (stage === undefined) fail(`the registry holds no stage "${unit.stageId}"`, 'the unit names a stage this driver does not declare');
  const outcome = await publishUnit(world.owner, {
    unitId: unit.unitId,
    generation: phase.generation,
    fence: phase.fence,
    identity: { inputsDigest: unit.inputsDigest, stageId: stage.id, stageVersion: stage.version + (phase.identity === 'different' ? 1 : 0) },
    at: readClock(world.spec.clockFile),
    revalidate: async (read) => {
      const rows = readGraph(world.spec.graphFile)[read.query] ?? [];
      return { membership: readMembership(rows), members: rows.length };
    },
    apply: async (executor, writes, digest) => {
      await executor.query(
        `INSERT INTO ${FACTS_TABLE} (unit_id, generation, digest, facts, applied_at) VALUES ($1, $2, $3, $4, $5)`,
        [unit.unitId, phase.generation, digest, writes.length, readClock(world.spec.clockFile)],
      );
      return writes.length;
    },
  });
  say({
    event: 'resubmit', outcome: outcome.outcome,
    ...(outcome.outcome === 'refused' ? { code: outcome.code, reason: outcome.reason } : { digest: outcome.record.digest, facts: outcome.record.facts }),
  });
}

/**
 * Runs one fill through the service the background server owns (madarch-tzte.19.5's
 * `orchestrator-host.ts`), over the same fixture and the same database: the
 * packaged binary drives a run the way the daemon does, not only the
 * orchestrator's own steps.
 */
async function phaseService(world: World, phase: Extract<DriverPhase, { kind: 'service' }>): Promise<void> {
  const service = createFillOrchestratorService({
    home: world.spec.productFolder,
    registry: world.registry,
    owner: world.owner,
    queueName: world.spec.runId,
    limits: world.orchestrator.limits,
    clock: () => readClock(world.spec.clockFile),
    queueFactory: async () => world.queue,
    wiring: () => ({
      snapshot: () => snapshotOf(world.spec),
      configuration: () => readFillStageConfiguration(world.spec.productFolder),
      graph: () => ({ query: async (text: string) => readGraph(world.spec.graphFile)[text] ?? [] }),
      inputs: (ref: UnitRef) => readInputs(world.spec.inputsFile, ref),
      facts: { apply: async ({ executor, unit, digest, writes }) => {
        await executor.query(
          `INSERT INTO ${FACTS_TABLE} (unit_id, generation, digest, facts, applied_at) VALUES ($1, $2, $3, $4, $5)`,
          [unit.unitId, unit.generation, digest, writes.length, readClock(world.spec.clockFile)],
        );
        return writes.length;
      } },
    }),
  });
  const result = await service.run({ product: { name: world.spec.product, folder: world.spec.productFolder }, runId: world.spec.runId, workers: phase.workers ?? 1 });
  say({ event: 'service', result });
  await service.stop();
}

// ---- the process ------------------------------------------------------------

/** Runs the phase the spec names, whatever it is. */
async function runPhase(world: World, spec: DriverSpec): Promise<void> {
  const phase = spec.phase;
  switch (phase.kind) {
    case 'plan': return await phasePlan(world);
    case 'run': return await phaseRun(world, phase);
    case 'sweep': return await phaseSweep(world);
    case 'report': return await phaseReport(world);
    case 'cancel': return await phaseCancel(world, phase);
    case 'recover': return await phaseRecover(world, phase);
    case 'resubmit': return await phaseResubmit(world, phase);
    case 'service': return await phaseService(world, phase);
  }
}

const specFile = process.argv[2];
if (specFile === undefined) fail('no spec file was given', 'usage: fill-crash <spec file>');
let spec: DriverSpec;
try {
  spec = JSON.parse(readFileSync(specFile, 'utf8')) as DriverSpec;
} catch (error) {
  fail('the spec file does not read as JSON', `${specFile}: ${(error as Error).message}`);
}

const interruption = interruptionOf(spec);
const world = await openWorld(spec, interruption);
try {
  await runPhase(world, spec);
} catch (error) {
  console.error(`${site()}: the phase "${spec.phase.kind}" failed: ${error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)}`);
  process.exitCode = 1;
}
await world.close();
