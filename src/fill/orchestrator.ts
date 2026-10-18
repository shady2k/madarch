/**
 * The fill's orchestrator (decision 0027): it plans the work of a run from the
 * stage registry, admits it within the run's resource limits by priority, hands
 * it to workers through the durable queue, follows a unit through its lease, its
 * draft, its split and its join, marks what went stale, revokes what was
 * cancelled, and publishes each generation exactly once.
 *
 * What it is made of, all of it landed:
 *
 * - **The registry** (`registry.ts`, madarch-tzte.19.3) declares the stages and
 *   derives the stage graph from their capabilities; a run plans against that
 *   graph and snapshots the configurations it resolved.
 * - **The state machines and their store** (`fsm.ts`, `state-store.ts`,
 *   madarch-tzte.19.4) persist every step. The orchestrator never invents a
 *   state: it takes a named step and performs the effects the step returned,
 *   after the new state is committed. A refused step is a value, writes nothing
 *   and is reported as it stands.
 * - **The queue** (`queue.ts` + its pg-boss adapter, madarch-tzte.19.2) carries
 *   the admitted work: an admission enqueues the unit's job inside the same
 *   transaction as the step, and a publication settles it inside the publication
 *   transaction, so one publication is one short transaction of the owner.
 * - **The database owner** (`adapters/database-owner.ts`, madarch-tzte.19.1) is
 *   the process's one database; everything here borrows it and nothing opens a
 *   second one.
 * - **`orchestrator-store.ts`** holds the orchestrator's own tables: the run's
 *   snapshot and resolved configuration, each unit's place in the plan, its
 *   tracked reads, its draft set, the child set a split sealed, the unique
 *   publication record and the durable progress events.
 *
 * Everything outside the database is a seam the caller passes: the clock (tests
 * move it by hand; nothing here reads `Date.now()` unless the caller left the
 * clock out), the pinned graph the units read, the inputs a unit's facts stand
 * on, the application of a published fact set, the pause/stop control, the
 * human-edit guard and the progress sink. The host in
 * `orchestrator-host.ts` wires the real ones; a test wires fakes.
 *
 * Two entry points do the work, and both are safe to call at any time:
 * `schedulerPass` sweeps what time and leases ended, enqueues the joins whose
 * children settled, admits planned units within the slots and settles the run;
 * `workOnce` claims one job and follows its unit as far as that attempt goes.
 * `driveRun` alternates them until nothing moves, which is what the host runs.
 */
import type { DatabaseOwner } from '../adapters/database-owner.js';
import { canonicalJsonDigest } from '../model/canonical.js';
import type { SqlExecutor } from '../query/sql-driver.js';
import { byCodePoint } from '../model/order.js';
import type { FillControl } from '../product/fill-runtime.js';
import { hashFillInputs } from '../product/fill-runtime.js';
import { here, raise, withLocation } from './fsm-core.js';
import type { UnitChildOutcome, UnitFailedChildPolicy, UnitRetryCause, UnitState } from './fsm.js';
import type { ResolvedStageConfiguration, StageContext, StageDraftSet, StageDraftWrite, StageExecutionResult } from './stage.js';
import {
  ORCHESTRATOR_TABLES,
  appendProgress,
  publicationDigest,
  publishUnitIn,
  readMembership,
  readRunConfiguration,
  readRunPlans,
  readSealedChildren,
  readSplitParents,
  readUnitDraft,
  readUnitPlan,
  readUnitReads,
  recordUnitRead,
  recordRunConfiguration,
  recordUnitDraft,
  recordUnitPlan,
  recordUnitPlanIn,
  retractUnitDraft,
  sealSplitIn,
  type ProgressKind,
  type PublicationOutcome,
  type RunSnapshot,
  type TrackedRead,
  type UnitPlanRecord,
} from './orchestrator-store.js';
import {
  deriveStageGraph,
  snapshotStageConfigurations,
  type DerivedStageGraph,
  type StageGraphRead,
  type StarvationPath,
} from './registry.js';
import type { StageRegistry } from './registry.js';
import {
  advanceChain,
  advanceRun,
  advanceUnit,
  advanceUnitIn,
  createRun,
  createUnit,
  createUnitIn,
  leaseUnit,
  openChain,
  readChain,
  readRun,
  readRunUnits,
  readUnit,
  readUnitGeneration,
  replaceStaleGeneration,
  revokeUnitLease,
  type ChainRecord,
  type RunRecord,
  type UnitRecord,
} from './state-store.js';
import type { ChainEvidence, RunEvidence } from './fsm.js';
import type { QueueService, ClaimedJob } from './queue.js';
import type { FillStageConfigurationRead } from './config.js';
import type { FillStage, StagePlan } from './stage.js';

// ---------------------------------------------------------------------------------------------
// The seams a caller passes
// ---------------------------------------------------------------------------------------------

/** One unit, as everything outside the database names it. */
export interface UnitRef {
  /** The stage's own unit id, the vocabulary the stage's plan and its `execute` use. */
  readonly stageUnitId: string;
  readonly stageId: string;
  /** The unit's id in the store: the stage's id and its own, so two stages never share one. */
  readonly unitId: string;
  /** What the unit covers, in the graph's own terms. */
  readonly scope: string;
  readonly generation: number;
}

/** The pinned graph one unit reads through: never a file, never an agent, always the snapshot. */
export interface UnitGraphReader {
  query(text: string): Promise<readonly unknown[]>;
}

/** Where a unit's facts go when they are published: inside the publication's own transaction. */
export interface FactApplication {
  /**
   * Applies one unit's published draft set within the stage's ownership scope,
   * inside the transaction that is publishing it, and answers how many facts it
   * applied. A failure here rolls the whole publication back: a generation is
   * published with its facts or not at all.
   */
  apply(input: {
    readonly executor: SqlExecutor;
    readonly unit: UnitRecord;
    readonly plan: UnitPlanRecord;
    readonly digest: string;
    readonly writes: readonly StageDraftWrite[];
  }): Promise<number>;
}

/** The human-edit guard decision 0027 keeps from the landed runtime: a stage's output that a person edited is never overwritten. */
export interface HumanEditGuard {
  /** Whether a stage's published units may be committed: `conflict` means a person's edit stands and the work waits. */
  check(input: { readonly stageId: string; readonly units: readonly UnitRecord[]; readonly at: number }): Promise<'clean' | 'conflict'> | 'clean' | 'conflict';
}

/** What a stage's progress sink hears: the durable event, once it is committed. */
export interface ProgressSink {
  (event: { readonly runId: string; readonly seq: number; readonly at: number; readonly stage: string; readonly unitId: string; readonly generation: number | null; readonly kind: string; readonly summary: string }): void | Promise<void>;
}

/** How the orchestrator asks whether the person paused or stopped the run (fill-runtime's control file, kept). */
export interface RunControlReader {
  (runId: string): Promise<FillControl | undefined>;
}

/** The most work one run may hold admitted, and what a retry, a lease, a split and a failed child may take. */
export interface OrchestratorLimits {
  /** The most units of one run that may stand admitted at once, every stage together. */
  readonly maxInFlight: number;
  /** How long one attempt's lease holds its unit before the sweep treats it as abandoned. */
  readonly leaseMs: number;
  /** How many attempts one generation may spend before it fails. */
  readonly retries: number;
  /** How long a retry waits before it may run again. */
  readonly retryDelayMs: number;
  /**
   * How long a unit waits for one point of ageing: a unit that has waited this
   * many milliseconds stands one place higher in the admission order, so no unit
   * is starved by a stream of more important ones.
   */
  readonly ageingStepMs: number;
  /** How deep splits may nest: a child of a split at this depth is refused. */
  readonly maxSplitDepth: number;
  /** How many children one split may seal. */
  readonly maxSplitChildren: number;
  /** The most estimated work (tokens) the children of one split may add up to. */
  readonly maxSplitWork: number;
  /** What a waiting parent does with a child that ended failed (decision 0027's three policies). */
  readonly failedChildPolicy: UnitFailedChildPolicy;
}

/** The limits a run holds when its caller names none: small, explicit and reproducible. */
export const DEFAULT_ORCHESTRATOR_LIMITS: OrchestratorLimits = {
  maxInFlight: 4,
  leaseMs: 60_000,
  retries: 2,
  retryDelayMs: 5_000,
  ageingStepMs: 60_000,
  maxSplitDepth: 3,
  maxSplitChildren: 8,
  maxSplitWork: 200_000,
  failedChildPolicy: 'propagate',
};

/** Everything the orchestrator is given once, when it is created. */
export interface OrchestratorOptions {
  /** The process's one database owner (madarch-tzte.19.1). Never opened, never closed here. */
  readonly database: DatabaseOwner;
  /** The declared stages (madarch-tzte.19.3). */
  readonly registry: StageRegistry;
  /** The durable queue (madarch-tzte.19.2). Declared by the host before the first enqueue. */
  readonly queue: QueueService;
  /** The queue's name, from the host: one queue carries one run's units. */
  readonly queueName: string;
  /** The product this orchestrator fills: the chain's key and the units' product. */
  readonly product: string;
  /** The product's resolved fill configuration, read fresh when a run plans and when it admits. */
  readonly configuration: () => Promise<FillStageConfigurationRead | undefined> | FillStageConfigurationRead | undefined;
  /** The pinned product snapshot the run stands on (fill-runtime's own shape). */
  readonly snapshot: () => Promise<RunSnapshot> | RunSnapshot;
  /**
   * A unit's tracked reads, as the pinned graph answers them. Given a transaction
   * of the owner, the reads go through it: the process's owner refuses a second
   * transaction on the same connection, so a read the publication rechecks inside
   * its own transaction is made there.
   */
  readonly graph: (ref: UnitRef, transaction?: SqlExecutor) => Promise<UnitGraphReader> | UnitGraphReader;
  /**
   * The named inputs a unit's facts stand on, hashed with fill-runtime's own
   * hashing: the graph's files, the registry, the upstream outputs. The digest
   * of the hashes is the generation's inputs digest, and a unit whose inputs
   * moved goes stale against it.
   */
  readonly inputs: (ref: UnitRef) => Promise<Readonly<Record<string, string | Uint8Array>>> | Readonly<Record<string, string | Uint8Array>>;
  /** Where a published fact set lands. */
  readonly facts: FactApplication;
  /** Supplies recorded time; the real clock unless a test passes its own. */
  readonly clock?: () => number;
  /** Whether the person paused or stopped the run (fill-runtime's control file, kept). */
  readonly control?: RunControlReader;
  /** The human-edit guard a stage's completion passes through, when the host has one. */
  readonly guard?: HumanEditGuard;
  /** Every durable progress event, once it is committed. */
  readonly sink?: ProgressSink;
  /** Where the orchestrator's own lines go; nothing by default. */
  readonly log?: (line: string) => void;
  readonly limits?: Partial<OrchestratorLimits>;
}

/** The orchestrator, with every seam resolved. */
export interface FillOrchestrator {
  readonly database: DatabaseOwner;
  readonly registry: StageRegistry;
  readonly queue: QueueService;
  readonly queueName: string;
  readonly product: string;
  readonly limits: OrchestratorLimits;
  readonly clock: () => number;
  readonly configuration: () => Promise<FillStageConfigurationRead | undefined>;
  readonly snapshot: () => Promise<RunSnapshot>;
  readonly graph: (ref: UnitRef, transaction?: SqlExecutor) => Promise<UnitGraphReader>;
  readonly inputs: (ref: UnitRef) => Promise<Readonly<Record<string, string | Uint8Array>>>;
  readonly facts: FactApplication;
  readonly control: RunControlReader;
  readonly guard: HumanEditGuard | undefined;
  readonly sink: ProgressSink | undefined;
  readonly log: (line: string) => void;
  /**
   * The sessions an in-flight unit is running, by unit id and generation: a
   * cancellation revokes their authority (the run machine's `revoke-run-authority`
   * effect) by aborting them here. The orchestrator registers one per attempt and
   * removes it when the attempt ends.
   */
  readonly authority: Map<string, AbortController>;
}

/** Builds the orchestrator, resolving every seam and the limits. */
export function createOrchestrator(options: OrchestratorOptions): FillOrchestrator {
  if (options.product.trim() === '') raise('the orchestrator needs the product it fills');
  if (options.queueName.trim() === '') raise('the orchestrator needs the name of the queue its units wait in');
  const limits = { ...DEFAULT_ORCHESTRATOR_LIMITS, ...options.limits };
  if (limits.maxInFlight < 1) raise(`the orchestrator's maxInFlight is ${limits.maxInFlight}: a run admits at least one unit at a time`);
  if (limits.leaseMs < 1) raise(`the orchestrator's leaseMs is ${limits.leaseMs}: a lease holds its unit for at least a millisecond`);
  if (limits.maxSplitDepth < 0) raise('the orchestrator\'s maxSplitDepth is negative');
  if (limits.maxSplitChildren < 1) raise('the orchestrator\'s maxSplitChildren is below one: a split seals at least one child');
  return {
    database: options.database,
    registry: options.registry,
    queue: options.queue,
    queueName: options.queueName,
    product: options.product,
    limits,
    clock: options.clock ?? (() => Date.now()),
    configuration: async () => await options.configuration(),
    snapshot: async () => await options.snapshot(),
    graph: async (ref, transaction) => await options.graph(ref, transaction),
    inputs: async (ref) => await options.inputs(ref),
    facts: options.facts,
    control: options.control ?? (async () => undefined),
    guard: options.guard,
    sink: options.sink,
    log: options.log ?? (() => undefined),
    authority: new Map(),
  };
}

/** The key one attempt's authority is registered under. */
const authorityKey = (unitId: string, generation: number): string => `${unitId}/${generation}`;

/** The store's unit id for one stage's own unit id: no run id is ever part of it (decision 0026). */
export function unitIdFor(stageId: string, stageUnitId: string): string {
  return `${stageId}/${stageUnitId}`;
}

/** The digest of a unit's named inputs: fill-runtime's own hashing, taken canonically. */
export function inputsDigest(inputs: Readonly<Record<string, string | Uint8Array>>): string {
  return canonicalJsonDigest(hashFillInputs(inputs));
}

/**
 * A unit's place in the admission order, as decision 0027 fixes it: the earlier
 * stage first (the fill goes from the general to the particular, and the stage
 * graph is that order), then the stage's own plan order with the unit's ageing
 * subtracted — the plan names its units most important first, which is the
 * PageRank-like importance — and the unit id in code point order to break every
 * tie. `.5 A unit that waits climbs one place per `ageingStepMs` it waited.
 */
export function admissionOrder(
  units: readonly { readonly unitId: string; readonly stagePosition: number; readonly planPosition: number; readonly plannedAt: number }[],
  options: { readonly at: number; readonly ageingStepMs: number },
): readonly { readonly unitId: string; readonly order: number }[] {
  const aged = units.map((unit) => {
    const waited = Math.max(0, options.at - unit.plannedAt);
    const steps = options.ageingStepMs <= 0 ? 0 : Math.floor(waited / options.ageingStepMs);
    return { unitId: unit.unitId, stagePosition: unit.stagePosition, order: unit.planPosition - steps };
  });
  return aged
    .sort((left, right) => left.stagePosition - right.stagePosition || left.order - right.order || byCodePoint(left.unitId, right.unitId))
    .map((unit) => ({ unitId: unit.unitId, order: unit.order }));
}


// ---------------------------------------------------------------------------------------------
// Shared pieces: events, the derived graph, one unit's reference
// ---------------------------------------------------------------------------------------------

/** Appends one durable progress event and hands it to the sink, in that order. */
async function emit(
  orchestrator: FillOrchestrator,
  event: { readonly runId: string; readonly at: number; readonly stage: string; readonly unitId: string; readonly generation: number | null; readonly kind: ProgressKind; readonly summary: string },
): Promise<void> {
  const stored = await appendProgress(orchestrator.database, {
    runId: event.runId,
    at: event.at,
    stage: event.stage,
    unitId: event.unitId,
    generation: event.generation,
    kind: event.kind,
    summary: event.summary,
  });
  if (orchestrator.sink !== undefined) await orchestrator.sink(stored);
}

/** One transaction of the process's owner, as the owner hands it to its work. */
type OwnerTransaction = Parameters<Parameters<DatabaseOwner['transaction']>[1]>[0];

/**
 * Runs one transaction of the database owner that the orchestrator opens itself —
 * an admission, a publication, a split — naming the operation and the tables it
 * touched when the database failed. The store wraps its own operations this way;
 * a step these three take must name its file, its line and what it was doing
 * too. The site is taken by the caller (`here()`), so the message names the
 * operation's own line and not this helper's.
 */
async function ownTransaction<R>(
  site: string,
  orchestrator: FillOrchestrator,
  operation: string,
  tables: readonly string[],
  work: (transaction: OwnerTransaction) => Promise<R>,
): Promise<R> {
  return await withLocation(site, operation, tables, async () => await orchestrator.database.transaction('write', work));
}

/**
 * The graph the run plans and admits against, with the check that the run's own
 * recorded configuration still stands: a product whose `fill.stages` changed
 * mid-run is refused rather than served a configuration it never agreed to.
 */
async function currentGraph(orchestrator: FillOrchestrator, runId: string): Promise<DerivedStageGraph> {
  const read: StageGraphRead = deriveStageGraph(orchestrator.registry, await orchestrator.configuration());
  if (!read.ok) {
    const faults = [
      ...read.config.map((error) => `${error.file}:${error.line}: ${error.path}: ${error.message}`),
      ...read.problems.map((problem) => `${problem.stage}${problem.file === undefined ? '' : ` (${problem.file}:${problem.line ?? 1})`} ${problem.path}: ${problem.message}`),
      ...read.cycles.map((cycle) => `stage cycle ${cycle.join(' → ')}`),
      ...read.starvation.map((path) => `starved ${path.path}`),
    ];
    raise(`the fill's stage graph does not read for run ${runId}: ${faults.join('; ')}`);
  }
  const recorded = await readRunConfiguration(orchestrator.database, runId);
  const digest = snapshotStageConfigurations(read.graph.stages);
  if (recorded !== null && recorded.digest !== digest) {
    raise(`the product's fill configuration changed during run ${runId}: it planned with ${recorded.digest} and now resolves ${digest}`);
  }
  return read.graph;
}

/** The resolved configuration of one stage of the graph. */
function stageConfiguration(graph: DerivedStageGraph, stageId: string): ResolvedStageConfiguration {
  const resolved = graph.stages.find((stage) => stage.id === stageId);
  if (resolved === undefined) raise(`the derived stage graph holds no configuration for stage "${stageId}"`);
  return resolved;
}

/** The registered stage module, raised where the graph names one the registry does not hold. */
function stageOf(orchestrator: FillOrchestrator, stageId: string): FillStage {
  const stage = orchestrator.registry.get(stageId);
  if (stage === undefined) raise(`the stage graph names stage "${stageId}", which the registry does not hold`);
  return stage;
}

/** One unit's reference, as the seams outside the database name it. */
function unitRef(unit: UnitRecord, plan: UnitPlanRecord): UnitRef {
  return { stageId: unit.stageId, stageUnitId: plan.stageUnitId, unitId: unit.unitId, scope: plan.scope, generation: unit.generation };
}

/** A unit's inputs digest, recomputed from the caller's own inputs seam. */
async function currentInputsDigest(orchestrator: FillOrchestrator, unit: UnitRecord, plan: UnitPlanRecord): Promise<string> {
  return inputsDigest(await orchestrator.inputs(unitRef(unit, plan)));
}

/** Whether every read a generation recorded still answers what it answered (empty answers included). */
async function readsFresh(orchestrator: FillOrchestrator, unit: UnitRecord, plan: UnitPlanRecord): Promise<boolean> {
  const reads = await readUnitReads(orchestrator.database, unit.unitId, unit.generation);
  if (reads.length === 0) return true;
  const reader = await orchestrator.graph(unitRef(unit, plan));
  for (const read of reads) {
    const rows = await reader.query(read.query);
    if (readMembership(rows) !== read.membership) return false;
  }
  return true;
}

/** The plan rows of one run, by unit id. */
async function runPlans(orchestrator: FillOrchestrator, runId: string): Promise<Map<string, UnitPlanRecord>> {
  return new Map((await readRunPlans(orchestrator.database, runId)).map((plan) => [plan.unitId, plan]));
}

/** The plan row of one unit, raised when the run holds none for it. */
async function planOf(orchestrator: FillOrchestrator, unit: UnitRecord): Promise<UnitPlanRecord> {
  const plan = await readUnitPlan(orchestrator.database, unit.unitId, unit.generation);
  if (plan === null) raise(`no plan is recorded for unit "${unit.unitId}" generation ${unit.generation}: every unit is planned before it runs`);
  return plan;
}

/** How many of a run's units stand in one of the states named. */
const countIn = (units: readonly UnitRecord[], states: readonly UnitState[]): number =>
  units.filter((unit) => states.includes(unit.state)).length;

/** The states an admitted unit holds a slot of the run in. */
const ADMITTED_STATES: readonly UnitState[] = ['ready', 'leased', 'running', 'draft', 'validating'];

/** The states a generation is live in: those a cancellation revokes and a staleness replaces. */
const LIVE_STATES: readonly UnitState[] = ['planned', 'ready', 'leased', 'running', 'draft', 'validating', 'waiting_children', 'retry_wait', 'blocked'];

// ---------------------------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------------------------

/** One unit the run planned, as the orchestrator created or found it. */
export interface PlannedUnit {
  readonly unitId: string;
  readonly stageId: string;
  readonly stageUnitId: string;
  readonly scope: string;
  readonly generation: number;
  readonly stagePosition: number;
  readonly planPosition: number;
  readonly state: UnitState;
  /** True when this planning created the unit; false when the identity already had one. */
  readonly created: boolean;
}

/** What one planning attempt gave. */
export type PlanOutcome =
  | {
    readonly outcome: 'planned';
    readonly run: RunRecord;
    readonly graph: DerivedStageGraph;
    readonly snapshot: RunSnapshot;
    readonly configurationDigest: string;
    readonly units: readonly PlannedUnit[];
    /** The units this run found already theirs, with their inputs unchanged: nothing to do for them. */
    readonly reused: readonly string[];
    /** The enabled stages whose plan found a producer's inputs but nothing in them (decision 0027's distinction). */
    readonly foundNothing: readonly string[];
  }
  | { readonly outcome: 'blocked'; readonly run: RunRecord; readonly starvation: readonly StarvationPath[]; readonly path: string }
  | { readonly outcome: 'refused'; readonly run: RunRecord; readonly code: string; readonly reason: string };

/**
 * Plans one run: derives the stage graph from the registry, refuses a run whose
 * recorded configuration no longer stands, snapshots what it resolved, asks
 * every enabled stage for its units, records each unit's place in the plan and
 * starts the run. A required capability no enabled stage produces blocks the run
 * with the starvation path the registry derived, rather than starting work that
 * can never run.
 */
export async function planRun(orchestrator: FillOrchestrator, options: { readonly runId: string }): Promise<PlanOutcome> {
  const database = orchestrator.database;
  const at = orchestrator.clock();
  const run = await readRun(database, options.runId);
  if (run === null) {
    raise(`no run ${options.runId} is recorded: a run is created before it is planned`);
  }
  if (run.state !== 'created' && run.state !== 'planning' && run.state !== 'running') {
    return { outcome: 'refused', run, code: 'fill-orchestrator/run-not-plannable', reason: `fill-orchestrator: run "${run.runId}" is ${run.state}; only a created, planning or running run is planned` };
  }
  const read = deriveStageGraph(orchestrator.registry, await orchestrator.configuration());
  if (!read.ok) {
    // A graph that does not read at all is refused where it stands; a graph that reads but starves a
    // consumer is a run that planned and is then blocked, which is what the machine's own path is.
    const onlyStarved = read.config.length === 0 && read.problems.length === 0 && read.cycles.length === 0 && read.starvation.length > 0;
    if (!onlyStarved) {
      const faults = [
        ...read.config.map((error) => `${error.file}:${error.line}: ${error.path}: ${error.message}`),
        ...read.problems.map((problem) => `${problem.stage}${problem.file === undefined ? '' : ` (${problem.file}:${problem.line ?? 1})`} ${problem.path}: ${problem.message}`),
        ...read.cycles.map((cycle) => `stage cycle ${cycle.join(' → ')}`),
      ];
      return { outcome: 'refused', run, code: 'fill-orchestrator/stage-graph-does-not-read', reason: `fill-orchestrator: the fill's stage graph does not read for run "${run.runId}": ${faults.join('; ')}` };
    }
  }
  const snapshot = await orchestrator.snapshot();
  // A graph that does not read resolved no configuration at all, and the digest says so in the
  // starvation's own words rather than claiming the digest of the empty set of stages.
  const configurationDigest = read.ok
    ? snapshotStageConfigurations(read.graph.stages)
    : canonicalJsonDigest({ starved: read.starvation.map((path) => path.path).sort(byCodePoint) });
  const recorded = await recordRunConfiguration(database, { runId: run.runId, digest: configurationDigest, snapshot, at });
  if (recorded.digest !== configurationDigest) {
    return {
      outcome: 'refused',
      run,
      code: 'fill-orchestrator/configuration-moved',
      reason: `fill-orchestrator: run "${run.runId}" planned with the configuration ${recorded.digest} and now resolves ${configurationDigest}: a run is planned once against what it resolved, and a changed product configuration is a new run`,
    };
  }
  if (run.state === 'created') {
    // The run records what it resolved before anything else: a planning run is one that read its
    // configuration, whether it then starts its stages or is blocked for want of a producer.
    const planned = await advanceRun(database, { runId: run.runId, event: { type: 'plan', at, configuration: configurationDigest } });
    if (!planned.ok) return { outcome: 'refused', run, code: planned.refusal.code, reason: planned.refusal.reason };
    await emit(orchestrator, { runId: run.runId, at, stage: '', unitId: '', generation: null, kind: 'run-planned', summary: `the run planned against ${snapshot.repository} at ${snapshot.commit}` });
  }
  if (!read.ok || read.graph.order.length === 0) {
    // A starved consumer, or a graph with no enabled stage at all: the run planned and is blocked with
    // the path the derivation named, and nothing is planned for it.
    const starvation = read.ok ? [] : [...read.starvation].sort((left, right) => byCodePoint(left.path, right.path));
    const path = starvation.length > 0 ? starvation[0]!.path : 'the stage graph → enabled stages → none (every registered stage is disabled)';
    const blocked = await advanceRun(database, { runId: run.runId, event: { type: 'block', at, starvationPath: path } });
    const record = blocked.ok ? blocked.record : run;
    if (blocked.ok) {
      await emit(orchestrator, { runId: run.runId, at, stage: '', unitId: '', generation: null, kind: 'run-blocked', summary: `the run is blocked: ${path}` });
      // A blocked run is terminal: the product's chain is settled to quiescent with it, so the next run
      // for that product is not refused by a chain whose run can never finish.
      await settleChain(orchestrator, run.runId, await runEvidence(orchestrator, run.runId));
    }
    return { outcome: 'blocked', run: record, starvation, path };
  }
  const graph = read.graph;

  const units: PlannedUnit[] = [];
  const reused: string[] = [];
  const foundNothing: string[] = [];
  for (const [stagePosition, stageId] of graph.order.entries()) {
    const stage = stageOf(orchestrator, stageId);
    const plan: StagePlan = await stage.plan(await orchestrator.graph({ stageId, stageUnitId: '', unitId: '', scope: '', generation: 0 }));
    if (plan.coverage === 'nothing-found') {
      foundNothing.push(stageId);
      // Decision 0027's distinction, made durable: a producer that found nothing is reported, so nobody
      // reads a plan of no units as a capability nothing produces.
      await emit(orchestrator, { runId: run.runId, at, stage: stageId, unitId: '', generation: null, kind: 'stage-found-nothing', summary: `stage ${stageId} read its producer's inputs and found nothing to plan in them` });
    }
    for (const [planPosition, scope] of plan.units.entries()) {
      const unitId = unitIdFor(stageId, scope.id);
      const ref: UnitRef = { stageId, stageUnitId: scope.id, unitId, scope: scope.scope, generation: 1 };
      const digest = inputsDigest(await orchestrator.inputs(ref));
      const before = await readUnit(database, unitId);
      const answer = await createUnit(database, {
        unitId, product: orchestrator.product, runId: run.runId, stageId,
        scopeKey: scope.id, inputsDigest: digest, retries: orchestrator.limits.retries, at,
      });
      if (answer.runId !== run.runId) {
        // The identity already has a generation another run owns. Decision 0027's reuse is exact: a
        // published generation whose inputs did not move is inherited and planned for nothing, a
        // published or stale one whose inputs moved is replaced under this run, and anything else — a
        // generation another run is working on, or one that ended blocked, failed or cancelled — is
        // refused, because two runs may not work one unit and a lost generation is not silently reused.
        if (answer.state === 'published' || answer.state === 'stale') {
          if (answer.state === 'published' && answer.inputsDigest === digest) {
            reused.push(unitId);
            continue;
          }
          if (answer.state === 'published') {
            const invalidated = await advanceUnit(database, { unitId, event: { type: 'invalidate', at, replacement: answer.generation + 1, cause: `the run ${run.runId} plans this unit against inputs that moved: ${answer.inputsDigest} is now ${digest}` } });
            if (!invalidated.ok) {
              return { outcome: 'refused', run, code: invalidated.refusal.code, reason: `fill-orchestrator: unit "${unitId}" could not be invalidated for run "${run.runId}": ${invalidated.refusal.reason}` };
            }
          }
          const replaced = await replaceStaleGeneration(database, { unitId, runId: run.runId, inputsDigest: digest, retries: orchestrator.limits.retries, at });
          if (!replaced.ok) {
            return { outcome: 'refused', run, code: replaced.refusal.code, reason: `fill-orchestrator: unit "${unitId}" could not be replaced for run "${run.runId}": ${replaced.refusal.reason}` };
          }
          await recordUnitPlan(database, {
            unitId, generation: replaced.record.generation, runId: run.runId, stageId, stageUnitId: scope.id,
            scope: scope.scope, stagePosition, planPosition, at,
          });
          units.push({ unitId, stageId, stageUnitId: scope.id, scope: scope.scope, generation: replaced.record.generation, stagePosition, planPosition, state: replaced.record.state, created: true });
          await emit(orchestrator, { runId: run.runId, at, stage: stageId, unitId, generation: replaced.record.generation, kind: 'unit-planned', summary: `planned ${unitId} (${scope.scope}) as generation ${replaced.record.generation}, replacing the stale generation ${answer.generation} this unit stood on` });
          continue;
        }
        return {
          outcome: 'refused',
          run,
          code: 'fill-orchestrator/unit-in-another-run',
          reason: `fill-orchestrator: unit "${unitId}" stands ${answer.state} in run "${answer.runId}", and run "${run.runId}" plans it: a unit is worked by one run at a time, so finish or cancel that run before this one plans the unit`,
        };
      }
      await recordUnitPlan(database, {
        unitId, generation: answer.generation, runId: run.runId, stageId, stageUnitId: scope.id,
        scope: scope.scope, stagePosition, planPosition, at,
      });
      const created = before === null;
      units.push({ unitId, stageId, stageUnitId: scope.id, scope: scope.scope, generation: answer.generation, stagePosition, planPosition, state: answer.state, created });
      if (created) await emit(orchestrator, { runId: run.runId, at, stage: stageId, unitId, generation: answer.generation, kind: 'unit-planned', summary: `planned ${unitId} (${scope.scope})` });
    }
  }

  if (run.state !== 'running') {
    const started = await advanceRun(database, { runId: run.runId, event: { type: 'start', at, stages: graph.order.length } });
    if (!started.ok) return { outcome: 'refused', run, code: started.refusal.code, reason: started.refusal.reason };
    await emit(orchestrator, { runId: run.runId, at, stage: '', unitId: '', generation: null, kind: 'run-started', summary: `the run started ${graph.order.length} stages: ${graph.order.join(', ')}` });
    return { outcome: 'planned', run: started.record, graph, snapshot, configurationDigest, units, reused, foundNothing };
  }
  return { outcome: 'planned', run, graph, snapshot, configurationDigest, units, reused, foundNothing };
}

// ---------------------------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------------------------

/** One unit this pass admitted, with the job its admission created. */
export interface AdmittedUnit {
  readonly unitId: string;
  readonly generation: number;
  readonly stageId: string;
  /** The queue priority its admission gave it: the earlier it stands, the higher. */
  readonly priority: number;
  /** The job's id, or null when the queue's singleton key already held an unfinished job for the unit. */
  readonly jobId: string | null;
}

/** What one admission pass did. */
export interface AdmissionOutcome {
  readonly run: RunRecord;
  readonly admitted: readonly AdmittedUnit[];
  /** The units a slot refused this pass, in the order they were considered: they wait for one to free. */
  readonly waitingForSlot: readonly string[];
  readonly refused: readonly { readonly unitId: string; readonly code: string; readonly reason: string }[];
  readonly admittedNow: number;
}

/**
 * Admits the run's planned units within its resource limits: the run's own
 * `maxInFlight` slots and each stage's concurrency, taken in the admission order
 * — earlier stage first, then the plan's own importance with the unit's ageing
 * subtracted, then the unit id in code point order. The step, the slot's count
 * and the enqueue are one transaction of the database owner, so a slot is taken
 * under the run's own row lock and two admissions can never overfill it.
 */
export async function admitUnits(orchestrator: FillOrchestrator, options: { readonly runId: string }): Promise<AdmissionOutcome> {
  const database = orchestrator.database;
  const at = orchestrator.clock();
  const run = await readRun(database, options.runId);
  if (run === null) raise(`no run ${options.runId} is recorded: a run is created before it admits anything`);
  if (run.state !== 'running') return { run, admitted: [], waitingForSlot: [], refused: [], admittedNow: 0 };
  const graph = await currentGraph(orchestrator, run.runId);
  const units = await readRunUnits(database, run.runId);
  const plans = await runPlans(orchestrator, run.runId);
  const withoutPlan = units.filter((unit) => unit.state === 'planned' && !plans.has(unit.unitId));
  const candidates = units.filter((unit) => unit.state === 'planned' && plans.has(unit.unitId));
  const ordered = admissionOrder(
    candidates.map((unit) => ({ unitId: unit.unitId, stagePosition: plans.get(unit.unitId)!.stagePosition, planPosition: plans.get(unit.unitId)!.planPosition, plannedAt: plans.get(unit.unitId)!.plannedAt })),
    { at, ageingStepMs: orchestrator.limits.ageingStepMs },
  );
  const admitted: AdmittedUnit[] = [];
  const waitingForSlot: string[] = [];
  const refused: { unitId: string; code: string; reason: string }[] = withoutPlan.map((unit) => ({
    unitId: unit.unitId,
    code: 'fill-orchestrator/no-plan-row',
    reason: `fill-orchestrator: unit "${unit.unitId}" generation ${unit.generation} stands planned with no plan row, so nothing says where it stands in the plan: replan the run, which records it again`,
  }));
  for (const [index, candidate] of ordered.entries()) {
    const unit = candidates.find((one) => one.unitId === candidate.unitId)!;
    const resolved = stageConfiguration(graph, unit.stageId);
    const priority = ordered.length - index;
    const outcome = await ownTransaction(here(), orchestrator, `admitUnit(${unit.unitId}/${unit.generation})`, ['fill_run', 'fill_unit', 'fill_unit_generation', 'fill_unit_lease', 'fill_transition'], async (executor) => {
      // The run's own row is taken first: two admission passes of one run are serialized here, so the
      // limits are counted and the step taken under one lock and a slot can never be given twice.
      const locked = await executor.query<{ run_id: string }>('SELECT run_id FROM fill_run WHERE run_id = $1 FOR UPDATE', [run.runId]);
      if (locked.rows.length === 0) raise(`table fill_run: no run ${run.runId}`);
      const counted = await executor.query<{ stage_id: string; state: string }>(
        `SELECT u.stage_id AS stage_id, g.state AS state
           FROM fill_unit u JOIN fill_unit_generation g ON g.unit_id = u.unit_id AND g.generation = u.generation
          WHERE g.run_id = $1`,
        [run.runId],
      );
      const states = counted.rows.map((row) => ({ stageId: row.stage_id, state: row.state as UnitState }));
      const inFlight = states.filter((row) => ADMITTED_STATES.includes(row.state)).length;
      const stageInFlight = states.filter((row) => row.stageId === unit.stageId && ADMITTED_STATES.includes(row.state)).length;
      if (inFlight >= orchestrator.limits.maxInFlight) return { admitted: false as const, why: 'run-slots' as const };
      if (stageInFlight >= resolved.concurrency) return { admitted: false as const, why: 'stage-slots' as const };
      const step = await advanceUnitIn(executor, { unitId: unit.unitId, event: { type: 'admit', at, generation: unit.generation } });
      if (!step.ok) return { admitted: false as const, why: 'refused' as const, refusal: step.refusal };
      const enqueued = await orchestrator.queue.enqueue({
        queue: orchestrator.queueName,
        data: { unitId: unit.unitId, generation: unit.generation },
        priority,
        singletonKey: unit.unitId,
        transaction: executor,
      });
      return { admitted: true as const, jobId: enqueued.created ? enqueued.id : null };
    });
    if (!outcome.admitted) {
      if (outcome.why === 'refused') refused.push({ unitId: unit.unitId, code: outcome.refusal.code, reason: outcome.refusal.reason });
      else waitingForSlot.push(unit.unitId);
      continue;
    }
    admitted.push({ unitId: unit.unitId, generation: unit.generation, stageId: unit.stageId, priority, jobId: outcome.jobId });
    await emit(orchestrator, { runId: run.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-admitted', summary: `admitted ${unit.unitId} at priority ${priority}${outcome.jobId === null ? ' (its job was already queued)' : ''}` });
  }
  return { run, admitted, waitingForSlot, refused, admittedNow: admitted.length };
}


// ---------------------------------------------------------------------------------------------
// The sweeps: what time, an expired lease and a settled join ask for
// ---------------------------------------------------------------------------------------------

/** Why a unit was sent away from an attempt and what the sweep did with it. */
export interface SweptUnit {
  readonly unitId: string;
  readonly outcome: 'woken' | 'wake-refused' | 'retried' | 'failed' | 'join-enqueued' | 'join-failed' | 'requeued';
  readonly reason: string;
}

/** What one sweep did. */
export interface SweepOutcome {
  readonly swept: readonly SweptUnit[];
}

/** The cause a waking retry names: the transition that wakes a wait does not read it, and the journal keeps what it says. */
function wakingCause(unit: UnitRecord): UnitRetryCause {
  return unit.lease !== null && unit.lease.revokedAt !== null ? 'lease-expired' : 'transient-failure';
}

/**
 * Sweeps the run's units for what only time can tell: a retry whose wait is
 * over becomes runnable again, an attempt whose lease lapsed is retried or
 * fails for good, and a waiting parent whose children settled gets its join
 * enqueued. Nothing here sleeps and nothing reads a clock of its own: every
 * moment comes from `orchestrator.clock()`.
 */
export async function sweepUnits(orchestrator: FillOrchestrator, options: { readonly runId: string }): Promise<SweepOutcome> {
  const database = orchestrator.database;
  const at = orchestrator.clock();
  const swept: SweptUnit[] = [];
  const run = await readRun(database, options.runId);
  if (run === null) raise(`no run ${options.runId} is recorded`);
  if (run.state !== 'running' && run.state !== 'pausing') return { swept };
  const units = await readRunUnits(database, run.runId);

  for (const unit of units) {
    if (unit.state === 'retry_wait' && unit.context.retryAt !== null && unit.context.retryAt <= at) {
      const step = await advanceUnit(database, {
        unitId: unit.unitId,
        event: { type: 'retry', at, generation: unit.generation, cause: wakingCause(unit), retryAt: unit.context.retryAt },
      });
      if (!step.ok) {
        // The machine refused to wake it: the pass changed nothing here, and saying so keeps a host from
        // spending its passes on a state it cannot move.
        swept.push({ unitId: unit.unitId, outcome: 'wake-refused', reason: step.refusal.reason });
        continue;
      }
      await orchestrator.queue.enqueue({ queue: orchestrator.queueName, data: { unitId: unit.unitId, generation: unit.generation }, singletonKey: unit.unitId });
      await emit(orchestrator, { runId: run.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-retried', summary: `${unit.unitId} waits no longer; its retry is runnable again` });
      swept.push({ unitId: unit.unitId, outcome: 'woken', reason: `its wait ended at ${unit.context.retryAt}` });
      continue;
    }
    if (unit.state === 'ready' && unit.lease === null) {
      // A unit standing `ready` with no lease at all is one whose job the queue no
      // longer holds: the worker that claimed it died before it took the lease, and
      // the queue's own maintenance settles such a claim as failed — which frees
      // the unit's singleton key and leaves nothing for a worker to claim, so the
      // unit would wait for ever while the run's evidence still counted it
      // runnable. The run offers the job again, and the offer is idempotent: while
      // an unfinished job carries the unit's key the queue creates nothing, so a
      // job that is still queued or still claimed is left exactly as it stands.
      const offered = await orchestrator.queue.enqueue({
        queue: orchestrator.queueName,
        data: { unitId: unit.unitId, generation: unit.generation },
        singletonKey: unit.unitId,
      });
      if (offered.created) {
        await emit(orchestrator, { runId: run.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-requeued', summary: `${unit.unitId} stands ready with no job and nothing stands leased for it; the run offers it to the queue again` });
        swept.push({ unitId: unit.unitId, outcome: 'requeued', reason: 'the unit stands ready, holds no lease and the queue held no unfinished job for it' });
      }
      continue;
    }
    if (ADMITTED_STATES.includes(unit.state) && unit.lease !== null && unit.lease.revokedAt === null && unit.lease.expiresAt <= at) {
      const authority = orchestrator.authority.get(authorityKey(unit.unitId, unit.generation));
      authority?.abort();
      const retryAt = at + orchestrator.limits.retryDelayMs;
      if (unit.context.retriesLeft > 0) {
        const step = await advanceUnit(database, {
          unitId: unit.unitId,
          event: { type: 'retry', at, generation: unit.generation, cause: 'lease-expired', retryAt },
        });
        if (step.ok) {
          await retractUnitDraft(database, { unitId: unit.unitId, generation: unit.generation, at });
          await orchestrator.queue.enqueue({ queue: orchestrator.queueName, data: { unitId: unit.unitId, generation: unit.generation }, singletonKey: unit.unitId, startAfter: new Date(retryAt) });
          await emit(orchestrator, { runId: run.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-retried', summary: `the lease of ${unit.unitId} lapsed at ${unit.lease.expiresAt}; attempt ${unit.context.attempt} is retried at ${retryAt}` });
          swept.push({ unitId: unit.unitId, outcome: 'retried', reason: `lease expired at ${unit.lease.expiresAt}` });
          continue;
        }
      }
      const failed = await advanceUnit(database, {
        unitId: unit.unitId,
        event: { type: 'fail', at, generation: unit.generation, fence: unit.context.fence, cause: 'retries-exhausted' },
      });
      if (failed.ok) {
        await retractUnitDraft(database, { unitId: unit.unitId, generation: unit.generation, at });
        await emit(orchestrator, { runId: run.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-failed', summary: `${unit.unitId} failed: its lease lapsed with no retry left` });
        swept.push({ unitId: unit.unitId, outcome: 'failed', reason: `lease expired at ${unit.lease.expiresAt} with no retry left` });
      }
      continue;
    }
    if (unit.state === 'waiting_children') {
      const plan = await planOf(orchestrator, unit);
      const joined = await settleJoin(orchestrator, { unit, plan, runId: run.runId, at });
      if (joined !== null) swept.push(joined);
    }
  }
  return { swept };
}

/**
 * What one waiting parent's children say: every child of the sealed set, as its
 * own generation stands. A child that opened a replacement is read as its sealed
 * generation, never as the one in force — the split sealed a generation, and a
 * replacement is not that generation's answer.
 */
async function childOutcomes(orchestrator: FillOrchestrator, unit: UnitRecord): Promise<readonly UnitChildOutcome[]> {
  const sealed = await readSealedChildren(orchestrator.database, unit.unitId, unit.generation);
  const outcomes: UnitChildOutcome[] = [];
  for (const child of sealed) {
    const record = await readUnitGeneration(orchestrator.database, child.unitId, child.generation);
    if (record === null) {
      outcomes.push({ unitId: child.unitId, generation: child.generation, published: false, fresh: false, failed: true });
      continue;
    }
    const published = record.state === 'published';
    const failed = record.state === 'failed' || record.state === 'cancelled' || record.state === 'stale';
    const plan = await readUnitPlan(orchestrator.database, child.unitId, child.generation);
    const fresh = published && plan !== null ? await readsFresh(orchestrator, record, plan) : false;
    outcomes.push({ unitId: child.unitId, generation: child.generation, published, fresh, failed });
  }
  return outcomes;
}

/**
 * Settles one waiting parent: with the run's policy for a failed child, a
 * propagated failure fails the parent with it, an accepted partial or a fully
 * published and fresh child set joins and enqueues the parent's next attempt,
 * and anything else leaves the parent waiting. Answers what it did, or null when
 * the children are still running.
 */
async function settleJoin(
  orchestrator: FillOrchestrator,
  request: { readonly unit: UnitRecord; readonly plan: UnitPlanRecord; readonly runId: string; readonly at: number },
): Promise<SweptUnit | null> {
  const database = orchestrator.database;
  const { unit, plan, at } = request;
  const children = await childOutcomes(orchestrator, unit);
  if (children.length === 0) return null;
  const failedChild = children.some((child) => child.failed);
  const allSettled = children.every((child) => child.failed || (child.published && child.fresh));
  if (failedChild && orchestrator.limits.failedChildPolicy === 'propagate') {
    const failed = await advanceUnit(database, {
      unitId: unit.unitId,
      event: { type: 'fail', at, generation: unit.generation, fence: unit.context.fence, cause: 'child-failed' },
    });
    if (!failed.ok) return null;
    await retractUnitDraft(database, { unitId: unit.unitId, generation: unit.generation, at });
    await emit(orchestrator, { runId: request.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-failed', summary: `${unit.unitId} failed: a child it waits for failed and the run propagates it` });
    return { unitId: unit.unitId, outcome: 'join-failed', reason: 'a child failed and the policy propagates it' };
  }
  if (!allSettled) return null;
  const joined = await advanceUnit(database, {
    unitId: unit.unitId,
    event: { type: 'join', at, generation: unit.generation, children, failedChildPolicy: orchestrator.limits.failedChildPolicy },
  });
  if (!joined.ok) {
    if (failedChild && orchestrator.limits.failedChildPolicy === 'block') {
      // The run resolves a failed child as a block: the parent waits for a person's resolution, and
      // the wait is the unit's own `blocked` state, taken with the reason that says what it waits on.
      const blocked = await advanceUnit(database, {
        unitId: unit.unitId,
        event: { type: 'block', at, generation: unit.generation, fence: unit.context.fence, reason: `child-failed: ${children.filter((child) => child.failed).map((child) => child.unitId).join(', ')}` },
      });
      if (blocked.ok) {
        await emit(orchestrator, { runId: request.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-blocked', summary: `${unit.unitId} waits for a resolution: a child failed` });
        return { unitId: unit.unitId, outcome: 'join-failed', reason: 'a child failed and the policy blocks' };
      }
    }
    return null;
  }
  await orchestrator.queue.enqueue({ queue: orchestrator.queueName, data: { unitId: unit.unitId, generation: unit.generation }, singletonKey: unit.unitId });
  await emit(orchestrator, { runId: request.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-joined', summary: `${unit.unitId} joins ${children.length} children and resumes` });
  return { unitId: unit.unitId, outcome: 'join-enqueued', reason: `${children.length} children settled` };
}

// ---------------------------------------------------------------------------------------------
// One attempt: lease, run, draft, validate, publish, or split and wait
// ---------------------------------------------------------------------------------------------

/** What one worker's attempt ended with. */
export type WorkResult =
  | 'published' | 'replayed' | 'split' | 'blocked' | 'retried' | 'failed' | 'cancelled'
  | 'nothing-to-do' | 'refused';

/** What `workOnce` answered. */
export interface WorkOutcome {
  /** True when a job was claimed and looked at; false when the queue had none. */
  readonly claimed: boolean;
  readonly unitId?: string;
  readonly generation?: number;
  readonly result?: WorkResult;
  readonly summary?: string;
  readonly refusal?: { readonly code: string; readonly reason: string };
  /** What the worker did with its job. */
  readonly job?: 'completed' | 'failed' | 'kept' | 'none';
}

/**
 * Claims one job and follows its unit as far as this attempt goes: lease, run
 * the stage, record the draft, validate it and publish it; or seal the children
 * of a split and wait; or block. Every step is a named transition of the unit
 * machine, taken under the generation and the fencing token this attempt holds,
 * and the effects it returned are performed after the state is committed. The
 * queue's settlement lands in the publication's own transaction where there is
 * one, so one publication is one short transaction of the owner.
 */
export async function workOnce(orchestrator: FillOrchestrator, options: { readonly worker: string }): Promise<WorkOutcome> {
  const database = orchestrator.database;
  const claimed = await orchestrator.queue.claim<{ unitId: string; generation: number }>({ queue: orchestrator.queueName, limit: 1 });
  const job = claimed[0];
  if (job === undefined) return { claimed: false, job: 'none' };
  const data = job.data;
  if (data === null || typeof data !== 'object' || typeof data.unitId !== 'string' || !Number.isInteger(data.generation)) {
    await orchestrator.queue.complete(orchestrator.queueName, job, { reason: 'the job carries no unit identity' });
    return { claimed: true, result: 'refused', refusal: { code: 'fill-orchestrator/job-malformed', reason: `fill-orchestrator: the claimed job ${job.id} carries ${JSON.stringify(data)}, which names no unit generation` }, job: 'completed' };
  }
  const unit = await readUnit(database, data.unitId);
  if (unit === null) {
    await orchestrator.queue.complete(orchestrator.queueName, job, { reason: 'no such unit' });
    return { claimed: true, unitId: data.unitId, generation: data.generation, result: 'nothing-to-do', summary: 'the unit is not recorded', job: 'completed' };
  }
  if (unit.generation !== data.generation) {
    await orchestrator.queue.complete(orchestrator.queueName, job, { reason: 'the generation was replaced' });
    await emit(orchestrator, { runId: unit.runId, at: orchestrator.clock(), stage: unit.stageId, unitId: unit.unitId, generation: data.generation, kind: 'unit-stale', summary: `job for generation ${data.generation} of ${unit.unitId} found generation ${unit.generation} in force` });
    return { claimed: true, unitId: unit.unitId, generation: data.generation, result: 'nothing-to-do', summary: `generation ${data.generation} was replaced by ${unit.generation}`, job: 'completed' };
  }
  const at = orchestrator.clock();
  if (unit.state === 'retry_wait') {
    // The job's own start time is the wait's end; the machine's guard judges the moment, so a claim that
    // arrives early waits for the next one rather than running.
    const step = await advanceUnit(database, { unitId: unit.unitId, event: { type: 'retry', at, generation: unit.generation, cause: wakingCause(unit), retryAt: unit.context.retryAt } });
    if (!step.ok) {
      // The machine refuses to wake a wait that has not ended, and the job is settled here rather than
      // handed back: the scheduler's own sweep enqueues it again the moment the wait is over, and saying
      // the same thing once is what keeps a claim that arrives early from spinning the run.
      const retryAt = unit.context.retryAt ?? at;
      await orchestrator.queue.complete(orchestrator.queueName, job, { reason: 'the retry wait has not elapsed' });
      return { claimed: true, unitId: unit.unitId, generation: unit.generation, result: 'retried', summary: `the wait ends at ${retryAt}; the run's own sweep enqueues it then`, refusal: { code: step.refusal.code, reason: step.refusal.reason }, job: 'completed' };
    }
    await emit(orchestrator, { runId: unit.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-retried', summary: `${unit.unitId} is runnable again` });
    return await attemptUnit(orchestrator, { worker: options.worker, job, unit: step.record });
  }
  if (unit.state === 'ready') return await attemptUnit(orchestrator, { worker: options.worker, job, unit });
  if (unit.state === 'waiting_children') {
    const plan = await planOf(orchestrator, unit);
    const settled = await settleJoin(orchestrator, { unit, plan, runId: unit.runId, at });
    await orchestrator.queue.complete(orchestrator.queueName, job, { reason: settled?.reason ?? 'the children are still running' });
    return {
      claimed: true, unitId: unit.unitId, generation: unit.generation,
      result: settled === null ? 'nothing-to-do' : settled.outcome === 'join-enqueued' ? 'retried' : 'failed',
      summary: settled?.reason ?? 'the children are still running', job: 'completed',
    };
  }
  // Every other state means the job is late: the unit is not waiting for a worker.
  await orchestrator.queue.complete(orchestrator.queueName, job, { reason: `the unit is ${unit.state}` });
  return { claimed: true, unitId: unit.unitId, generation: unit.generation, result: 'nothing-to-do', summary: `the unit is ${unit.state}`, job: 'completed' };
}

/** Runs one attempt of a ready unit: lease it, start it, run its stage and follow the outcome. */
async function attemptUnit(
  orchestrator: FillOrchestrator,
  request: { readonly worker: string; readonly job: ClaimedJob<{ unitId: string; generation: number }>; readonly unit: UnitRecord },
): Promise<WorkOutcome> {
  const database = orchestrator.database;
  const unit = request.unit;
  const stage = stageOf(orchestrator, unit.stageId);
  const plan = await planOf(orchestrator, unit);
  const at = orchestrator.clock();
  // The queue's own answer first, before this attempt takes anything: a claim the queue already handed to
  // another worker must not leave a lease, a start or a spent retry behind it.
  if (!(await orchestrator.queue.heartbeat(orchestrator.queueName, request.job))) {
    return { claimed: true, unitId: unit.unitId, generation: unit.generation, result: 'refused', refusal: { code: 'fill-orchestrator/claim-lapsed', reason: `fill-orchestrator: the claim of job ${request.job.id} is no longer this worker's before ${unit.unitId} attempt ${unit.context.attempt + 1} ran, so the attempt spends nothing` }, job: 'none' };
  }
  const leased = await leaseUnit(database, { unitId: unit.unitId, holder: request.worker, ttlMs: orchestrator.limits.leaseMs, at });
  if (!leased.ok) {
    await orchestrator.queue.complete(orchestrator.queueName, request.job, { reason: `the lease was refused: ${leased.refusal.reason}` });
    return { claimed: true, unitId: unit.unitId, generation: unit.generation, result: 'refused', refusal: { code: leased.refusal.code, reason: leased.refusal.reason }, job: 'completed' };
  }
  const fence = leased.record.context.fence;
  const started = await advanceUnit(database, { unitId: unit.unitId, event: { type: 'start', at, generation: unit.generation, fence } });
  if (!started.ok) {
    await orchestrator.queue.complete(orchestrator.queueName, request.job, { reason: `the start was refused: ${started.refusal.reason}` });
    return { claimed: true, unitId: unit.unitId, generation: unit.generation, result: 'refused', refusal: { code: started.refusal.code, reason: started.refusal.reason }, job: 'completed' };
  }
  await emit(orchestrator, { runId: unit.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-leased', summary: `${unit.unitId} is leased to ${request.worker} under fence ${fence}, attempt ${leased.record.context.attempt}` });
  await emit(orchestrator, { runId: unit.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-started', summary: `${unit.unitId} attempt ${leased.record.context.attempt} runs under fence ${fence}` });

  // The attempt's authority: a cancellation aborts it here.
  const controller = new AbortController();
  orchestrator.authority.set(authorityKey(unit.unitId, unit.generation), controller);
  const writes: StageDraftWrite[] = [];
  const notes: { note: string; fraction: number | null; at: number }[] = [];
  const reader = await orchestrator.graph(unitRef(unit, plan));
  const context: StageContext = {
    unit: { id: plan.stageUnitId, scope: plan.scope },
    config: stageConfiguration(await currentGraph(orchestrator, unit.runId), unit.stageId),
    graph: {
      query: async (text: string) => {
        const rows = await reader.query(text);
        await recordUnitRead(orchestrator.database, { unitId: unit.unitId, generation: unit.generation, query: text, rows, at: orchestrator.clock() });
        await emit(orchestrator, { runId: unit.runId, at: orchestrator.clock(), stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-read', summary: `${unit.unitId} read "${text}" and answered ${rows.length} ${rows.length === 1 ? 'row' : 'rows'}` });
        return rows;
      },
    },
    draft: {
      write: (entry: StageDraftWrite) => { writes.push(entry); },
      writes: (): StageDraftSet => ({ writes }),
    },
    // A stage reports its progress synchronously; the notes are kept in order and written as the run's
    // own durable events the moment the attempt ends, so a lost write is an error rather than a silence.
    progress: (note: string, fraction?: number) => {
      notes.push({ note, fraction: fraction ?? null, at: orchestrator.clock() });
    },
    signal: controller.signal,
  };

  let result: StageExecutionResult | undefined;
  let raised: Error | undefined;
  try {
    result = await stage.execute({ id: plan.stageUnitId, scope: plan.scope }, context);
  } catch (error) {
    raised = error as Error;
  } finally {
    orchestrator.authority.delete(authorityKey(unit.unitId, unit.generation));
    // What the stage reported is the run's own durable progress, written whether the unit finished or
    // raised: a lost write is an error here, never a silence.
    for (const note of notes) {
      await emit(orchestrator, { runId: unit.runId, at: note.at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-progress', summary: note.fraction === null ? note.note : `${note.note} (${Math.round(note.fraction * 100)}%)` });
    }
  }
  if (raised !== undefined || result === undefined) {
    return await retryAttempt(orchestrator, { unit: started.record, fence, job: request.job, cause: 'transient-failure', reason: `the stage raised: ${raised?.message ?? 'it answered nothing'}`, summary: `${unit.unitId} raised: ${raised?.message ?? 'it answered nothing'}` });
  }

  if (result.outcome === 'blocked') {
    const blocked = await advanceUnit(database, { unitId: unit.unitId, event: { type: 'block', at: orchestrator.clock(), generation: unit.generation, fence, reason: result.reason } });
    if (!blocked.ok) return { claimed: true, unitId: unit.unitId, generation: unit.generation, result: 'refused', refusal: { code: blocked.refusal.code, reason: blocked.refusal.reason }, job: 'kept' };
    await orchestrator.queue.complete(orchestrator.queueName, request.job, { reason: result.reason });
    await emit(orchestrator, { runId: unit.runId, at: orchestrator.clock(), stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-blocked', summary: `${unit.unitId} is blocked: ${result.reason}` });
    return { claimed: true, unitId: unit.unitId, generation: unit.generation, result: 'blocked', summary: result.reason, job: 'completed' };
  }
  if (result.outcome === 'split') {
    return await splitAttempt(orchestrator, { unit: started.record, plan, fence, job: request.job, children: result.children });
  }

  // The draft: the machine's own `submit-draft` step, then the effect that records what was written.
  const drafted = await advanceUnit(database, { unitId: unit.unitId, event: { type: 'submit-draft', at: orchestrator.clock(), generation: unit.generation, fence } });
  if (!drafted.ok) return { claimed: true, unitId: unit.unitId, generation: unit.generation, result: 'refused', refusal: { code: drafted.refusal.code, reason: drafted.refusal.reason }, job: 'kept' };
  await recordUnitDraft(database, { unitId: unit.unitId, generation: unit.generation, writes, at: orchestrator.clock() });
  await emit(orchestrator, { runId: unit.runId, at: orchestrator.clock(), stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-drafted', summary: `${unit.unitId} drafted ${writes.length} ${writes.length === 1 ? 'write' : 'writes'}` });

  const validating = await advanceUnit(database, { unitId: unit.unitId, event: { type: 'validate-draft', at: orchestrator.clock(), generation: unit.generation, fence } });
  if (!validating.ok) return { claimed: true, unitId: unit.unitId, generation: unit.generation, result: 'refused', refusal: { code: validating.refusal.code, reason: validating.refusal.reason }, job: 'kept' };
  await emit(orchestrator, { runId: unit.runId, at: orchestrator.clock(), stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-validating', summary: `${unit.unitId} validates its draft` });

  const validation = await stage.validate({ writes }, context.graph);
  if (!validation.ok) {
    return await retryAttempt(orchestrator, {
      unit: validating.record, fence, job: request.job, cause: 'validation-problem',
      reason: `validation refused the draft: ${validation.errors.join('; ')}`,
      summary: `${unit.unitId} was refused by validation: ${validation.errors.join('; ')}`,
    });
  }
  return await publishAttempt(orchestrator, { unit: validating.record, plan, fence, job: request.job, reader, stage });
}

/**
 * Publishes one validated generation: one transaction of the owner that
 * rechecks the run's control, rechecks every read its facts stand on, applies
 * the fact set, takes the machine's `publish` step and writes the unique
 * publication record, with the queue's settlement inside it.
 */
async function publishAttempt(
  orchestrator: FillOrchestrator,
  request: {
    readonly unit: UnitRecord;
    readonly plan: UnitPlanRecord;
    readonly fence: number;
    readonly job: ClaimedJob<{ unitId: string; generation: number }>;
    readonly reader: UnitGraphReader;
    readonly stage: FillStage;
  },
): Promise<WorkOutcome> {
  const database = orchestrator.database;
  const unit = request.unit;
  const at = orchestrator.clock();
  const draft = await readUnitDraft(database, unit.unitId, unit.generation);
  if (draft === null) raise(`unit "${unit.unitId}" generation ${unit.generation} reached validation with no recorded draft set to publish`);
  const digest = publicationDigest({ inputsDigest: unit.inputsDigest, draft: draft.digest, stageId: request.stage.id, stageVersion: request.stage.version });
  const outcome = await ownTransaction(here(), orchestrator, `publishUnit(${unit.unitId}/${unit.generation})`, ['fill_publication', 'fill_unit_read', 'fill_unit_draft', 'fill_unit_lease', 'fill_unit_generation'], async (transaction) => {
    const publication: PublicationOutcome = await publishUnitIn(transaction, {
      unitId: unit.unitId,
      generation: unit.generation,
      fence: request.fence,
      identity: { inputsDigest: unit.inputsDigest, stageId: request.stage.id, stageVersion: request.stage.version },
      at,
      // The reads are rechecked through the publication's own transaction: the process's owner refuses a
      // second transaction on its connection, so the pinned graph answers from inside this one.
      revalidate: async (read: TrackedRead, executor) => {
        const reader = await orchestrator.graph(unitRef(unit, request.plan), executor);
        const rows = await reader.query(read.query);
        return { membership: readMembership(rows), members: rows.length };
      },
      apply: async (executor, writes, digest) => await orchestrator.facts.apply({ executor, unit, plan: request.plan, digest, writes }),
    });
    if (publication.outcome === 'published' || publication.outcome === 'replayed') {
      const settled = await orchestrator.queue.complete(orchestrator.queueName, request.job, { publication: { unitId: unit.unitId, generation: unit.generation, digest } }, transaction);
      return { publication, settled };
    }
    return { publication, settled: false };
  });

  if (outcome.publication.outcome === 'published') {
    // The record's own digest, not the one this attempt computed before the transaction: they are the
    // same publication, and everything the run says about it afterwards names what it really wrote.
    const recorded = outcome.publication.record.digest;
    await emit(orchestrator, { runId: unit.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-published', summary: `${unit.unitId} published ${outcome.publication.record.facts} ${outcome.publication.record.facts === 1 ? 'fact' : 'facts'} under ${recorded}` });
    return { claimed: true, unitId: unit.unitId, generation: unit.generation, result: 'published', summary: `published ${recorded}`, job: outcome.settled ? 'completed' : 'none' };
  }
  if (outcome.publication.outcome === 'replayed') {
    const recorded = outcome.publication.record.digest;
    await emit(orchestrator, { runId: unit.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-published', summary: `${unit.unitId} was already published as ${recorded}; this request answered the existing publication` });
    return { claimed: true, unitId: unit.unitId, generation: unit.generation, result: 'replayed', summary: `already published ${recorded}`, job: outcome.settled ? 'completed' : 'none' };
  }
  const refusal = outcome.publication;
  if (refusal.code === 'fill-publication/reads-stale') {
    // The facts this generation would write stand on a graph that moved: the retry re-reads it, and
    // the draft is retracted so the next attempt starts clean.
    return await retryAttempt(orchestrator, { unit, fence: request.fence, job: request.job, cause: 'validation-problem', reason: refusal.reason, summary: refusal.reason });
  }
  await orchestrator.queue.complete(orchestrator.queueName, request.job, { reason: refusal.reason });
  await emit(orchestrator, { runId: unit.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-blocked', summary: refusal.reason });
  return { claimed: true, unitId: unit.unitId, generation: unit.generation, result: 'refused', refusal: { code: refusal.code, reason: refusal.reason }, job: 'completed' };
}

/** Sends one attempt into a retry wait, or fails the generation when no retry is left. */
async function retryAttempt(
  orchestrator: FillOrchestrator,
  request: { readonly unit: UnitRecord; readonly fence: number; readonly job: ClaimedJob<{ unitId: string; generation: number }>; readonly cause: UnitRetryCause; readonly reason: string; readonly summary: string },
): Promise<WorkOutcome> {
  const database = orchestrator.database;
  const unit = request.unit;
  const at = orchestrator.clock();
  const retryAt = at + orchestrator.limits.retryDelayMs;
  const retried = await advanceUnit(database, { unitId: unit.unitId, event: { type: 'retry', at, generation: unit.generation, cause: request.cause, retryAt } });
  if (!retried.ok) {
    const failed = await advanceUnit(database, { unitId: unit.unitId, event: { type: 'fail', at, generation: unit.generation, fence: request.fence, cause: 'retries-exhausted' } });
    if (!failed.ok) {
      await orchestrator.queue.complete(orchestrator.queueName, request.job, { reason: request.reason });
      return { claimed: true, unitId: unit.unitId, generation: unit.generation, result: 'refused', refusal: { code: failed.refusal.code, reason: failed.refusal.reason }, job: 'completed' };
    }
    await retractUnitDraft(database, { unitId: unit.unitId, generation: unit.generation, at });
    await orchestrator.queue.complete(orchestrator.queueName, request.job, { reason: request.reason });
    await emit(orchestrator, { runId: unit.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-failed', summary: `${unit.unitId} failed with no retry left: ${request.reason}` });
    return { claimed: true, unitId: unit.unitId, generation: unit.generation, result: 'failed', summary: request.reason, job: 'completed' };
  }
  await retractUnitDraft(database, { unitId: unit.unitId, generation: unit.generation, at });
  await orchestrator.queue.complete(orchestrator.queueName, request.job, { reason: request.reason });
  await orchestrator.queue.enqueue({ queue: orchestrator.queueName, data: { unitId: unit.unitId, generation: unit.generation }, singletonKey: unit.unitId, startAfter: new Date(retryAt) });
  await emit(orchestrator, { runId: unit.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-retried', summary: `${request.summary}; the attempt is retried at ${retryAt}` });
  return { claimed: true, unitId: unit.unitId, generation: unit.generation, result: 'retried', summary: request.summary, job: 'completed' };
}

/**
 * Seals the child set of a split: the children are created, each with its own
 * place in the plan and its own inputs digest, and the parent's checkpoint lands
 * in the same transaction, so a parent is waiting for exactly the children that
 * were sealed with it or for none of them. A split the limits refuse blocks the
 * parent with the reason instead, rather than decomposing without a bound.
 */
async function splitAttempt(
  orchestrator: FillOrchestrator,
  request: {
    readonly unit: UnitRecord;
    readonly plan: UnitPlanRecord;
    readonly fence: number;
    readonly job: ClaimedJob<{ unitId: string; generation: number }>;
    readonly children: readonly { readonly id: string; readonly scope: string; readonly estimatedTokens?: number }[];
  },
): Promise<WorkOutcome> {
  const database = orchestrator.database;
  const unit = request.unit;
  const at = orchestrator.clock();
  const refuse = async (reason: string): Promise<WorkOutcome> => {
    const blocked = await advanceUnit(database, { unitId: unit.unitId, event: { type: 'block', at, generation: unit.generation, fence: request.fence, reason } });
    if (!blocked.ok) return { claimed: true, unitId: unit.unitId, generation: unit.generation, result: 'refused', refusal: { code: blocked.refusal.code, reason: blocked.refusal.reason }, job: 'kept' };
    await orchestrator.queue.complete(orchestrator.queueName, request.job, { reason });
    await emit(orchestrator, { runId: unit.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-blocked', summary: `${unit.unitId} cannot split: ${reason}` });
    return { claimed: true, unitId: unit.unitId, generation: unit.generation, result: 'blocked', summary: reason, job: 'completed' };
  };
  if (request.children.length === 0) return await refuse('the split sealed no child: a split names the children its parent waits for');
  // A child names work that does not stand yet: a child that is the parent itself, one of its ancestors, a
  // unit another run works, or one whose generation already stands under other inputs is refused here,
  // before anything is sealed, rather than sealed into a set the parent can never join.
  const ancestors = await splitAncestors(orchestrator, unit.unitId, unit.generation);
  for (const child of request.children) {
    if (child.id.trim() === '') return await refuse('the split names a child with no id: a child is named by the unit id its plan gives it');
    const childUnitId = unitIdFor(unit.stageId, child.id);
    if (ancestors.has(childUnitId)) {
      return await refuse(`the split names "${childUnitId}" as a child, and it stands on this split's own path: a unit cannot be its own descendant`);
    }
    const existing = await readUnit(database, childUnitId);
    if (existing === null) continue;
    if (existing.runId !== unit.runId) {
      return await refuse(`the split names "${childUnitId}" as a child, and it stands in run "${existing.runId}": a child of this split is this run's to seal`);
    }
    const childRef: UnitRef = { stageId: unit.stageId, stageUnitId: child.id, unitId: childUnitId, scope: child.scope, generation: existing.generation };
    const childDigest = inputsDigest(await orchestrator.inputs(childRef));
    if (existing.inputsDigest !== childDigest) {
      return await refuse(`the split names "${childUnitId}" as a child, and its generation ${existing.generation} stands on inputs ${existing.inputsDigest}, which are not this split's ${childDigest}`);
    }
  }
  if (request.children.length > orchestrator.limits.maxSplitChildren) {
    return await refuse(`the split names ${request.children.length} children, more than the ${orchestrator.limits.maxSplitChildren} one split may seal`);
  }
  const depth = await splitDepth(orchestrator, unit.unitId, unit.generation);
  if (depth + 1 > orchestrator.limits.maxSplitDepth) {
    return await refuse(`the split would nest ${depth + 1} deep, past the ${orchestrator.limits.maxSplitDepth} splits may nest`);
  }
  const work = request.children.reduce((total, child) => total + (child.estimatedTokens ?? 0), 0);
  if (work > orchestrator.limits.maxSplitWork) {
    return await refuse(`the split's children estimate ${work} tokens of work together, past the ${orchestrator.limits.maxSplitWork} one split may seal`);
  }
  const sealed = await ownTransaction(here(), orchestrator, `sealSplit(${unit.unitId}/${unit.generation})`, ['fill_unit_split', 'fill_unit_plan', 'fill_unit', 'fill_unit_generation', 'fill_unit_lease', 'fill_transition'], async (executor) => {
    const children: { unitId: string; generation: number }[] = [];
    for (const [index, child] of request.children.entries()) {
      const childUnitId = unitIdFor(unit.stageId, child.id);
      const ref: UnitRef = { stageId: unit.stageId, stageUnitId: child.id, unitId: childUnitId, scope: child.scope, generation: 1 };
      const digest = inputsDigest(await orchestrator.inputs(ref));
      const created = await createUnitIn(executor, {
        unitId: childUnitId, product: orchestrator.product, runId: unit.runId, stageId: unit.stageId,
        scopeKey: child.id, inputsDigest: digest, retries: orchestrator.limits.retries, at,
      });
      await recordUnitPlanIn(executor, {
        unitId: childUnitId, generation: created.generation, runId: unit.runId, stageId: unit.stageId,
        stageUnitId: child.id, scope: child.scope, stagePosition: request.plan.stagePosition,
        planPosition: request.plan.planPosition + index, at,
      });
      children.push({ unitId: childUnitId, generation: created.generation });
    }
    await sealSplitIn(executor, { parentUnitId: unit.unitId, parentGeneration: unit.generation, children, at });
    const outcomes: UnitChildOutcome[] = children.map((child) => ({ unitId: child.unitId, generation: child.generation, published: false, fresh: false, failed: false }));
    const step = await advanceUnitIn(executor, {
      unitId: unit.unitId,
      event: { type: 'wait-for-children', at, generation: unit.generation, fence: request.fence, children: outcomes },
    });
    return { children, step };
  });
  if (!sealed.step.ok) {
    return { claimed: true, unitId: unit.unitId, generation: unit.generation, result: 'refused', refusal: { code: sealed.step.refusal.code, reason: sealed.step.refusal.reason }, job: 'kept' };
  }
  // The parent's own attempt is over: its lease is released (the machine's `suspend-parent` effect) and its
  // job is settled, so no worker holds it while its children run.
  // The machine's `suspend-parent` effect: the storage half revokes the lease this attempt holds. A
  // generation's token in force always has a lease row, so no row here is a state the store cannot hold.
  const released = await revokeUnitLease(database, { unitId: unit.unitId, generation: unit.generation, fence: request.fence, at });
  if (released === null) {
    raise(`the machine suspended unit "${unit.unitId}" generation ${unit.generation} under fence ${request.fence}, and the store holds no lease row under it: the token in force is issued with its lease, so one of the two is wrong`);
  }
  await orchestrator.queue.complete(orchestrator.queueName, request.job, { reason: `suspended for ${sealed.children.length} children` });
  for (const child of sealed.children) {
    await emit(orchestrator, { runId: unit.runId, at, stage: unit.stageId, unitId: child.unitId, generation: child.generation, kind: 'unit-planned', summary: `sealed ${child.unitId} as a child of ${unit.unitId}` });
  }
  await emit(orchestrator, { runId: unit.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-split', summary: `${unit.unitId} split into ${sealed.children.length} children and waits for them` });
  return { claimed: true, unitId: unit.unitId, generation: unit.generation, result: 'split', summary: `sealed ${sealed.children.length} children`, job: 'completed' };
}

/**
 * Every generation standing above one, by the splits that sealed it: the unit
 * itself, its parent, its grandparent and so on. A split's own children are
 * checked against this set, so a unit can never be sealed as its own descendant.
 */
async function splitAncestors(orchestrator: FillOrchestrator, unitId: string, generation: number): Promise<Set<string>> {
  const seen = new Set<string>([unitId]);
  let frontier: readonly { unitId: string; generation: number }[] = [{ unitId, generation }];
  while (frontier.length > 0) {
    const parents: { unitId: string; generation: number }[] = [];
    for (const child of frontier) {
      for (const parent of await readSplitParents(orchestrator.database, child.unitId, child.generation)) {
        if (seen.has(parent.unitId)) continue;
        seen.add(parent.unitId);
        parents.push({ unitId: parent.unitId, generation: parent.generation });
      }
    }
    frontier = parents;
  }
  return seen;
}

/** How many splits already stand above one generation: 0 for a unit no split produced. */
async function splitDepth(orchestrator: FillOrchestrator, unitId: string, generation: number): Promise<number> {
  const seen = new Set<string>([authorityKey(unitId, generation)]);
  let frontier: readonly { unitId: string; generation: number }[] = [{ unitId, generation }];
  let depth = 0;
  while (frontier.length > 0) {
    const parents: { unitId: string; generation: number }[] = [];
    for (const child of frontier) {
      for (const parent of await readSplitParents(orchestrator.database, child.unitId, child.generation)) {
        if (seen.has(parent.unitId)) continue;
        seen.add(parent.unitId);
        parents.push({ unitId: parent.unitId, generation: parent.generation });
      }
    }
    if (parents.length === 0) break;
    depth += 1;
    frontier = parents;
  }
  return depth;
}


// ---------------------------------------------------------------------------------------------
// The run: its evidence, its settlement, its pause, its cancellation and its staleness
// ---------------------------------------------------------------------------------------------

/** One run's own answer to finish with. */
export interface StartedRun {
  readonly ok: true;
  readonly run: RunRecord;
  readonly chain: ChainRecord;
}
export interface RefusedRunStart {
  readonly ok: false;
  readonly code: string;
  readonly reason: string;
}

/**
 * Opens the product's chain of runs and creates one run in it. A chain that
 * never ran starts this run; a quiescent one wakes for it; a chain already
 * following another run is refused, because one product fills one run at a time.
 */
export async function startRun(orchestrator: FillOrchestrator, options: { readonly runId: string }): Promise<StartedRun | RefusedRunStart> {
  const database = orchestrator.database;
  const at = orchestrator.clock();
  const chain = await openChain(database, { product: orchestrator.product, at });
  const existing = await readRun(database, options.runId);
  const run = existing ?? await createRun(database, { runId: options.runId, product: orchestrator.product, at });
  if (chain.state === 'active' && chain.context.activeRunId !== run.runId) {
    // A chain whose run ended is free: a run that is terminal cannot finish or be cancelled any further,
    // so the next run wakes it rather than being refused by a chain nothing can release.
    const held = await readRun(database, chain.context.activeRunId ?? '');
    const heldState = held?.state ?? null;
    if (heldState !== null && !(TERMINAL_RUN_STATES as readonly string[]).includes(heldState)) {
      return {
        ok: false,
        code: 'fill-orchestrator/chain-active',
        reason: `fill-orchestrator: the product "${orchestrator.product}" already runs ${String(chain.context.activeRunId)}, which stands ${heldState}; finish or cancel it before starting ${run.runId}`,
      };
    }
    const freed = await advanceChain(database, { product: orchestrator.product, event: { type: 'settle', at, evidence: { runnable: 0, inFlight: 0, waiting: 0, pendingPublications: 0 } } });
    const settled = freed.ok ? freed.record : chain;
    if (settled.state === 'quiescent') {
      const woken = await advanceChain(database, { product: orchestrator.product, event: { type: 'wake', at, runId: run.runId } });
      if (!woken.ok) return { ok: false, code: woken.refusal.code, reason: woken.refusal.reason };
      return { ok: true, run, chain: woken.record };
    }
    return {
      ok: false,
      code: 'fill-orchestrator/chain-held',
      reason: `fill-orchestrator: the product "${orchestrator.product}" holds the chain for ${String(chain.context.activeRunId)}, which stands ${heldState ?? 'in no run this database holds'}: finish or cancel it before starting ${run.runId}`,
    };
  }
  if (chain.state === 'idle') {
    const started = await advanceChain(database, { product: orchestrator.product, event: { type: 'start', at, runId: run.runId } });
    if (!started.ok) return { ok: false, code: started.refusal.code, reason: started.refusal.reason };
    return { ok: true, run, chain: started.record };
  }
  if (chain.state === 'quiescent') {
    const woken = await advanceChain(database, { product: orchestrator.product, event: { type: 'wake', at, runId: run.runId } });
    if (!woken.ok) return { ok: false, code: woken.refusal.code, reason: woken.refusal.reason };
    return { ok: true, run, chain: woken.record };
  }
  return { ok: true, run, chain };
}

/**
 * What one run's units say about it, as the run machine's guards read it. A unit
 * that waits for a retry whose moment has come counts as runnable: the next
 * sweep makes it so, and a run is not finished while it waits.
 */
export async function runEvidence(orchestrator: FillOrchestrator, runId: string): Promise<RunEvidence> {
  const units = await readRunUnits(orchestrator.database, runId);
  // "Runnable" is everything the run still owes work for and the scheduler will put to a worker: the
  // units it may admit now (`planned`), the ones waiting for a worker (`ready`), and the ones waiting for
  // a retry whose moment the clock will bring (`retry_wait`, the moment passed or not) — a run that still
  // has a retry coming has not finished, and one whose retry is not due yet only waits.
  const runnable = units.filter((unit) => unit.state === 'ready' || unit.state === 'planned' || unit.state === 'retry_wait').length;
  const inFlight = countIn(units, ['leased', 'running', 'draft', 'validating']);
  const waiting = countIn(units, ['waiting_children']);
  const pendingPublications = countIn(units, ['validating']);
  // Required coverage is what the run planned being covered: no generation of it ended blocked, failed,
  // cancelled or stale. A run that planned nothing because every unit it would plan already stands
  // published has lost nothing, and a stage whose plan found nothing is reported as such separately —
  // the registry's own distinction between "no producer" and "producer found nothing".
  const lost = units.filter((unit) => ['blocked', 'failed', 'cancelled', 'stale'].includes(unit.state));
  return { runnable, inFlight, waiting, coverageMet: lost.length === 0, pendingPublications };
}

/** What one settlement of a run did. */
export interface RunSettleOutcome {
  readonly run: RunRecord;
  readonly outcome: 'succeeded' | 'completed-partial' | 'paused' | 'cancelled' | 'blocked' | 'failed' | 'waiting' | 'unchanged';
  readonly evidence: RunEvidence;
  readonly refusal?: { readonly code: string; readonly reason: string };
}

/**
 * Settles one run: a run with nothing runnable, in flight or waiting finishes,
 * with its required coverage met or not; a pausing run whose work drained is
 * paused; a cancelling run whose work drained is cancelled. The chain of runs is
 * settled to quiescent when its run reached a terminal state and nothing is
 * outstanding. Nothing is settled while work stands, which is the whole point of
 * the guards behind them.
 */
export async function settleRun(orchestrator: FillOrchestrator, options: { readonly runId: string }): Promise<RunSettleOutcome> {
  const database = orchestrator.database;
  const at = orchestrator.clock();
  const run = await readRun(database, options.runId);
  if (run === null) raise(`no run ${options.runId} is recorded`);
  const evidence = await runEvidence(orchestrator, run.runId);
  const nothingOutstanding = evidence.runnable === 0 && evidence.inFlight === 0 && evidence.waiting === 0 && evidence.pendingPublications === 0;
  if (run.state === 'running') {
    if (!nothingOutstanding) return { run, outcome: 'waiting', evidence };
    const step = evidence.coverageMet
      ? await advanceRun(database, { runId: run.runId, event: { type: 'complete', at, evidence } })
      : await advanceRun(database, { runId: run.runId, event: { type: 'complete-partial', at, evidence } });
    if (!step.ok) return { run, outcome: 'waiting', evidence, refusal: { code: step.refusal.code, reason: step.refusal.reason } };
    await emit(orchestrator, {
      runId: run.runId, at, stage: '', unitId: '', generation: null,
      kind: evidence.coverageMet ? 'run-completed' : 'run-completed-partial',
      summary: evidence.coverageMet ? 'the run succeeded with its required coverage met' : 'the run completed partially: some planned work is not covered',
    });
    await settleChain(orchestrator, run.runId, evidence);
    return { run: step.record, outcome: evidence.coverageMet ? 'succeeded' : 'completed-partial', evidence };
  }
  if (run.state === 'pausing') {
    if (evidence.inFlight + evidence.waiting > 0) return { run, outcome: 'waiting', evidence };
    const step = await advanceRun(database, { runId: run.runId, event: { type: 'drain', at, evidence } });
    if (!step.ok) return { run, outcome: 'waiting', evidence, refusal: { code: step.refusal.code, reason: step.refusal.reason } };
    await emit(orchestrator, { runId: run.runId, at, stage: '', unitId: '', generation: null, kind: 'run-paused', summary: 'the run paused after its active work drained' });
    return { run: step.record, outcome: 'paused', evidence };
  }
  if (run.state === 'cancelling') {
    if (!nothingOutstanding) return { run, outcome: 'waiting', evidence };
    const step = await advanceRun(database, { runId: run.runId, event: { type: 'drained', at, evidence } });
    if (!step.ok) return { run, outcome: 'waiting', evidence, refusal: { code: step.refusal.code, reason: step.refusal.reason } };
    await emit(orchestrator, { runId: run.runId, at, stage: '', unitId: '', generation: null, kind: 'run-cancelled', summary: 'the run is cancelled and nothing it planned stands in flight' });
    await settleChain(orchestrator, run.runId, evidence);
    return { run: step.record, outcome: 'cancelled', evidence };
  }
  return { run, outcome: 'unchanged', evidence };
}

/** Settles the product's chain to quiescent once its run finished and nothing is outstanding. */
async function settleChain(orchestrator: FillOrchestrator, runId: string, evidence: RunEvidence): Promise<void> {
  const database = orchestrator.database;
  const chain = await readChain(database, orchestrator.product);
  if (chain === null || chain.state !== 'active') return;
  const chainEvidence: ChainEvidence = {
    runnable: evidence.runnable, inFlight: evidence.inFlight, waiting: evidence.waiting, pendingPublications: evidence.pendingPublications,
  };
  await advanceChain(database, { product: orchestrator.product, event: { type: 'settle', at: orchestrator.clock(), evidence: chainEvidence } });
}

/** What one cancellation did. */
export interface CancelOutcome {
  readonly run: RunRecord;
  readonly cancelledUnits: readonly string[];
  /** The generations the machine refused to cancel, each with its own words. */
  readonly refused: readonly UnitRefusal[];
  readonly settlement: RunSettleOutcome;
}

/**
 * Cancels one run: the persisted intent first (the run enters `cancelling` and
 * its authority is revoked), then every live generation of the run is cancelled
 * — its agent session aborted, its lease revoked and its unpublished draft
 * retracted — and the run is settled to `cancelled` when nothing is left. A
 * cancelled generation is a record: only its own run's cancellation reaches it,
 * and a publication that raced it is refused by the publication's own check.
 */
export async function cancelRun(orchestrator: FillOrchestrator, options: { readonly runId: string; readonly cause: string }): Promise<CancelOutcome> {
  const database = orchestrator.database;
  const at = orchestrator.clock();
  const run = await readRun(database, options.runId);
  if (run === null) raise(`no run ${options.runId} is recorded`);
  const intent = await advanceRun(database, { runId: run.runId, event: { type: 'cancel', at, cause: options.cause } });
  if (!intent.ok) raise(`run "${run.runId}" cannot be cancelled from ${run.state}: ${intent.refusal.reason}`);
  await emit(orchestrator, { runId: run.runId, at, stage: '', unitId: '', generation: null, kind: 'run-cancelling', summary: `the run is cancelling: ${options.cause}` });

  const cancelledUnits: string[] = [];
  const refused: UnitRefusal[] = [];
  for (const unit of await readRunUnits(database, run.runId)) {
    if (!LIVE_STATES.includes(unit.state)) continue;
    orchestrator.authority.get(authorityKey(unit.unitId, unit.generation))?.abort();
    const step = await advanceUnit(database, { unitId: unit.unitId, event: { type: 'cancel', at: orchestrator.clock(), cause: options.cause } });
    if (!step.ok) {
      refused.push({ unitId: unit.unitId, code: step.refusal.code, reason: step.refusal.reason });
      continue;
    }
    await retractUnitDraft(database, { unitId: unit.unitId, generation: unit.generation, at: orchestrator.clock() });
    await emit(orchestrator, { runId: run.runId, at: orchestrator.clock(), stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-cancelled', summary: `${unit.unitId} is cancelled: ${options.cause}` });
    cancelledUnits.push(unit.unitId);
  }
  const settlement = await settleRun(orchestrator, { runId: run.runId });
  return { run: settlement.run, cancelledUnits, refused, settlement };
}

/** Asks one run to pause: it admits nothing new and is paused once its work drains. */
export async function pauseRun(orchestrator: FillOrchestrator, options: { readonly runId: string }): Promise<RunSettleOutcome> {
  const database = orchestrator.database;
  const at = orchestrator.clock();
  const run = await readRun(database, options.runId);
  if (run === null) raise(`no run ${options.runId} is recorded`);
  if (run.state === 'running') {
    const intent = await advanceRun(database, { runId: run.runId, event: { type: 'pause', at } });
    if (!intent.ok) raise(`run "${run.runId}" cannot pause from ${run.state}: ${intent.refusal.reason}`);
    await emit(orchestrator, { runId: run.runId, at, stage: '', unitId: '', generation: null, kind: 'run-paused', summary: 'the run admits no new work and waits for what runs to drain' });
  }
  return await settleRun(orchestrator, { runId: run.runId });
}

/** Resumes a paused run: it opens the next planning epoch, and the caller plans it again. */
export async function resumeRun(orchestrator: FillOrchestrator, options: { readonly runId: string }): Promise<RunRecord> {
  const database = orchestrator.database;
  const at = orchestrator.clock();
  const run = await readRun(database, options.runId);
  if (run === null) raise(`no run ${options.runId} is recorded`);
  const resumed = await advanceRun(database, { runId: run.runId, event: { type: 'resume', at } });
  if (!resumed.ok) raise(`run "${run.runId}" cannot resume from ${run.state}: ${resumed.refusal.reason}`);
  await emit(orchestrator, { runId: run.runId, at, stage: '', unitId: '', generation: null, kind: 'run-resumed', summary: 'the run resumes and replans' });
  return resumed.record;
}

/** Fails one run for its spent budget, naming what was spent. */
export async function failRun(orchestrator: FillOrchestrator, options: { readonly runId: string; readonly detail: string }): Promise<RunSettleOutcome> {
  const database = orchestrator.database;
  const at = orchestrator.clock();
  const run = await readRun(database, options.runId);
  if (run === null) raise(`no run ${options.runId} is recorded`);
  const evidence = await runEvidence(orchestrator, run.runId);
  const step = await advanceRun(database, { runId: run.runId, event: { type: 'fail', at, cause: 'budget-exhausted', detail: options.detail } });
  if (!step.ok) return { run, outcome: 'unchanged', evidence, refusal: { code: step.refusal.code, reason: step.refusal.reason } };
  await emit(orchestrator, { runId: run.runId, at, stage: '', unitId: '', generation: null, kind: 'run-failed', summary: `the run failed: ${options.detail}` });
  await settleChain(orchestrator, run.runId, evidence);
  return { run: step.record, outcome: 'failed', evidence };
}

/** Blocks one run with the starvation path that stopped it. */
export async function blockRun(orchestrator: FillOrchestrator, options: { readonly runId: string; readonly reason: string }): Promise<RunSettleOutcome> {
  const database = orchestrator.database;
  const at = orchestrator.clock();
  const run = await readRun(database, options.runId);
  if (run === null) raise(`no run ${options.runId} is recorded`);
  const evidence = await runEvidence(orchestrator, run.runId);
  const step = await advanceRun(database, { runId: run.runId, event: { type: 'block', at, starvationPath: options.reason } });
  if (!step.ok) return { run, outcome: 'unchanged', evidence, refusal: { code: step.refusal.code, reason: step.refusal.reason } };
  await emit(orchestrator, { runId: run.runId, at, stage: '', unitId: '', generation: null, kind: 'run-blocked', summary: `the run is blocked: ${options.reason}` });
  await settleChain(orchestrator, run.runId, evidence);
  return { run: step.record, outcome: 'blocked', evidence };
}

/** Unblocks one generation after an explicit resolution, and makes it runnable again. */
export async function unblockUnit(orchestrator: FillOrchestrator, options: { readonly unitId: string; readonly resolution: string }): Promise<WorkOutcome> {
  const database = orchestrator.database;
  const unit = await readUnit(database, options.unitId);
  if (unit === null) raise(`no unit ${options.unitId} is recorded`);
  const at = orchestrator.clock();
  // The machine's own `record-resolution` effect: what the person resolved is kept as this run's durable
  // progress event, in their words, so the record of why the generation runs again is the same record a
  // watching person reads. `enqueue-ready` makes it runnable again and `emit-progress` is the event.
  const step = await advanceUnit(database, { unitId: unit.unitId, event: { type: 'unblock', at, generation: unit.generation, resolution: options.resolution } });
  if (!step.ok) return { claimed: false, unitId: unit.unitId, generation: unit.generation, result: 'refused', refusal: { code: step.refusal.code, reason: step.refusal.reason } };
  await orchestrator.queue.enqueue({ queue: orchestrator.queueName, data: { unitId: unit.unitId, generation: unit.generation }, singletonKey: unit.unitId });
  await emit(orchestrator, { runId: unit.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-unblocked', summary: `${unit.unitId} is unblocked: ${options.resolution}` });
  return { claimed: false, unitId: unit.unitId, generation: unit.generation, result: 'retried', summary: options.resolution };
}

/** One named step the machine refused on one unit generation, with the machine's own words. */
export interface UnitRefusal {
  readonly unitId: string;
  readonly code: string;
  readonly reason: string;
}

/** One generation the sweep found stale, with what moved. */
export interface StaleUnit {
  readonly unitId: string;
  readonly generation: number;
  readonly replacement: number;
  readonly cause: string;
}

/**
 * Marks what the run's own inputs and reads moved: a generation whose named
 * inputs no longer hash the same, or a published generation whose recorded reads
 * no longer answer the same — an empty read that became non-empty included — is
 * invalidated and its replacement generation opened. A published generation
 * stays an immutable record, marked stale and linked to its replacement.
 */
/** What one staleness sweep did: the generations it replaced, and the steps the machine refused. */
export interface StaleSweep {
  readonly invalidated: readonly StaleUnit[];
  readonly refused: readonly UnitRefusal[];
}

export async function invalidateStaleUnits(orchestrator: FillOrchestrator, options: { readonly runId: string }): Promise<StaleSweep> {
  const database = orchestrator.database;
  const at = orchestrator.clock();
  const run = await readRun(database, options.runId);
  if (run === null) raise(`no run ${options.runId} is recorded`);
  const plans = await runPlans(orchestrator, run.runId);
  const stale: StaleUnit[] = [];
  const refused: UnitRefusal[] = [];
  for (const unit of await readRunUnits(database, run.runId)) {
    if (!LIVE_STATES.includes(unit.state) && unit.state !== 'published') continue;
    const plan = plans.get(unit.unitId);
    if (plan === undefined) continue;
    const digest = await currentInputsDigest(orchestrator, unit, plan);
    let cause: string | null = null;
    if (digest !== unit.inputsDigest) cause = `the unit's named inputs moved: ${unit.inputsDigest} is now ${digest}`;
    else if (unit.state === 'published' && !(await readsFresh(orchestrator, unit, plan))) cause = 'a read the generation recorded answers something else now';
    if (cause === null) continue;
    const invalidated = await advanceUnit(database, { unitId: unit.unitId, event: { type: 'invalidate', at, replacement: unit.generation + 1, cause } });
    if (!invalidated.ok) {
      refused.push({ unitId: unit.unitId, code: invalidated.refusal.code, reason: invalidated.refusal.reason });
      continue;
    }
    await retractUnitDraft(database, { unitId: unit.unitId, generation: unit.generation, at });
    const replaced = await replaceStaleGeneration(database, { unitId: unit.unitId, runId: run.runId, inputsDigest: digest, retries: orchestrator.limits.retries, at });
    if (!replaced.ok) raise(`generation ${unit.generation} of "${unit.unitId}" went stale yet its replacement ${unit.generation + 1} was refused: ${replaced.refusal.reason}`);
    await recordUnitPlan(database, {
      unitId: unit.unitId, generation: replaced.record.generation, runId: run.runId, stageId: unit.stageId,
      stageUnitId: plan.stageUnitId, scope: plan.scope, stagePosition: plan.stagePosition, planPosition: plan.planPosition, at,
    });
    await emit(orchestrator, { runId: run.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-stale', summary: `${unit.unitId} went stale (${cause}); generation ${replaced.record.generation} replaces it` });
    stale.push({ unitId: unit.unitId, generation: unit.generation, replacement: replaced.record.generation, cause });
  }
  return { invalidated: stale, refused };
}

/** What the human-edit guard answered for one stage. */
export type StageGuardVerdict = 'clean' | 'conflict' | 'nothing-to-guard';

export interface StageGuardOutcome {
  readonly outcome: StageGuardVerdict;
  /** The generations the guard could not mark stale, each with the machine's own words. */
  readonly refused: readonly UnitRefusal[];
}

/**
 * Passes one stage's published units through the human-edit guard the landed
 * runtime keeps: a stage a person edited is never overwritten, so its published
 * generations go stale and the run waits for that person's review rather than
 * publishing over them.
 */
export async function guardStage(orchestrator: FillOrchestrator, options: { readonly runId: string; readonly stageId: string }): Promise<StageGuardOutcome> {
  const guard = orchestrator.guard;
  if (guard === undefined) return { outcome: 'nothing-to-guard', refused: [] };
  const database = orchestrator.database;
  const at = orchestrator.clock();
  const units = (await readRunUnits(database, options.runId)).filter((unit) => unit.stageId === options.stageId && unit.state === 'published');
  if (units.length === 0) return { outcome: 'nothing-to-guard', refused: [] };
  if ((await guard.check({ stageId: options.stageId, units, at })) === 'clean') return { outcome: 'clean', refused: [] };
  const refused: UnitRefusal[] = [];
  for (const unit of units) {
    const invalidated = await advanceUnit(database, {
      unitId: unit.unitId,
      event: { type: 'invalidate', at, replacement: unit.generation + 1, cause: 'human-edit-wins: the stage was edited by a person' },
    });
    if (!invalidated.ok) {
      refused.push({ unitId: unit.unitId, code: invalidated.refusal.code, reason: invalidated.refusal.reason });
      continue;
    }
    await emit(orchestrator, { runId: options.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-stale', summary: `${unit.unitId} is stale: a person edited the stage, so the published generation is not overwritten` });
  }
  return { outcome: 'conflict', refused };
}

// ---------------------------------------------------------------------------------------------
// One scheduler pass, and the loop a host runs
// ---------------------------------------------------------------------------------------------

/** What one scheduler pass did. */
export interface SchedulerOutcome {
  /** The run as it stands after the pass. */
  readonly run: RunRecord;
  readonly admitted: number;
  readonly swept: number;
  /** The generations the pass found stale and replaced. */
  readonly stale: number;
  readonly settlement: RunSettleOutcome;
  /** Every named step the machine refused in this pass, so nothing is dropped in silence. */
  readonly refused: readonly UnitRefusal[];
  /** True when the pass changed something: a unit was admitted, swept or the run settled. */
  readonly moved: boolean;
  /** The stages the human-edit guard found edited in this pass. */
  readonly guarded: readonly string[];
}

/**
 * The stage outputs a guard already passed, by the published generations it saw:
 * one set of published generations is guarded once, and a stage that published
 * again — a replacement generation, a second run — is guarded again, so a person's
 * later edit is seen rather than remembered away.
 */
const guardedOutputs = new WeakMap<FillOrchestrator, Set<string>>();

/** What one stage's guard is remembered by: the stage and the published generations it passed on. */
function guardKey(stageId: string, units: readonly UnitRecord[]): string {
  return `${stageId}:${units.map((unit) => `${unit.unitId}/${unit.generation}`).sort(byCodePoint).join(',')}`;
}

/**
 * One pass of the scheduler: it reads the person's pause or stop, sweeps what
 * time ended, admits what the slots take, passes a finished stage through the
 * human-edit guard and settles the run. It never sleeps and never blocks on an
 * agent: a host runs it beside its workers, and a test runs it by hand.
 */
export async function schedulerPass(orchestrator: FillOrchestrator, options: { readonly runId: string }): Promise<SchedulerOutcome> {
  const database = orchestrator.database;
  let run = await readRun(database, options.runId);
  if (run === null) raise(`no run ${options.runId} is recorded`);
  if (['succeeded', 'completed_partial', 'blocked', 'failed', 'cancelled', 'paused'].includes(run.state)) {
    const settlement = await settleRun(orchestrator, { runId: run.runId });
    return { run: settlement.run, admitted: 0, swept: 0, stale: 0, settlement, refused: [], moved: false, guarded: [] };
  }
  const control = await orchestrator.control(run.runId);
  if (control === 'stopped') {
    const cancelled = await cancelRun(orchestrator, { runId: run.runId, cause: 'the person stopped the run' });
    return { run: cancelled.run, admitted: 0, swept: cancelled.cancelledUnits.length, stale: 0, settlement: cancelled.settlement, refused: cancelled.refused, moved: true, guarded: [] };
  }
  if (control === 'paused' && run.state === 'running') {
    const settlement = await pauseRun(orchestrator, { runId: run.runId });
    return { run: settlement.run, admitted: 0, swept: 0, stale: 0, settlement, refused: [], moved: true, guarded: [] };
  }

  const swept = await sweepUnits(orchestrator, { runId: run.runId });
  const admission = await admitUnits(orchestrator, { runId: run.runId });
  const refused: UnitRefusal[] = [...admission.refused];
  run = admission.run;

  // A stage whose units are all published passes through the human-edit guard once per process.
  const guarded: string[] = [];
  if (orchestrator.guard !== undefined) {
    const graph = await currentGraph(orchestrator, run.runId);
    const units = await readRunUnits(database, run.runId);
    for (const stageId of graph.order) {
      const stageUnits = units.filter((unit) => unit.stageId === stageId);
      if (stageUnits.length === 0 || !stageUnits.every((unit) => unit.state === 'published')) continue;
      const key = guardKey(stageId, stageUnits);
      const seen = guardedOutputs.get(orchestrator) ?? new Set<string>();
      guardedOutputs.set(orchestrator, seen);
      if (seen.has(key)) continue;
      seen.add(key);
      const verdict = await guardStage(orchestrator, { runId: run.runId, stageId });
      refused.push(...verdict.refused);
      if (verdict.outcome === 'conflict') {
        guarded.push(stageId);
        const blocked = await blockRun(orchestrator, { runId: run.runId, reason: `human-edit-wins: the published output of stage ${stageId} was edited by a person, and the run waits for that review` });
        return { run: blocked.run, admitted: admission.admittedNow, swept: swept.swept.length, stale: 0, settlement: blocked, refused, moved: true, guarded };
      }
    }
  }

  // A run that would settle first asks whether what it published still stands: the staleness recheck
  // (a recorded read that moved, an input that moved) runs when nothing else is outstanding, which is
  // the moment its own work is meant to be complete, and its cost is bounded by that.
  const beforeStale = await runEvidence(orchestrator, run.runId);
  let stale: StaleSweep = { invalidated: [], refused: [] };
  if (beforeStale.runnable === 0 && beforeStale.inFlight === 0 && beforeStale.waiting === 0) {
    stale = await invalidateStaleUnits(orchestrator, { runId: run.runId });
    refused.push(...stale.refused);
  }
  const settlement = await settleRun(orchestrator, { runId: run.runId });
  return {
    run: settlement.run,
    admitted: admission.admittedNow,
    swept: swept.swept.length,
    stale: stale.invalidated.length,
    settlement,
    refused,
    moved: admission.admittedNow > 0 || swept.swept.length > 0 || stale.invalidated.length > 0 || (settlement.outcome !== 'waiting' && settlement.outcome !== 'unchanged'),
    guarded,
  };
}

/** The states a run ended in: nothing further happens to it. */
const TERMINAL_RUN_STATES = ['succeeded', 'completed_partial', 'blocked', 'failed', 'cancelled', 'paused'] as const;

/** What one driven run ended as. */
export interface DriveOutcome {
  readonly run: RunRecord;
  readonly passes: number;
  readonly work: number;
  /** True when the run reached a terminal state; false when the loop ran out of passes or of progress. */
  readonly settled: boolean;
  /** Why the loop stopped, when it stopped without settling the run. */
  readonly stoppedBecause?: string;
}

/**
 * Drives one run: alternates a scheduler pass with up to `workers` claims until
 * the run reaches a terminal state, the passes run out, or a pass and its claims
 * together change nothing. Nothing sleeps here: a retry that is not due yet waits
 * for the caller's clock, and a host polls with its own interval.
 */
export async function driveRun(
  orchestrator: FillOrchestrator,
  options: { readonly runId: string; readonly workers?: number; readonly maxPasses?: number },
): Promise<DriveOutcome> {
  const workers = options.workers ?? 1;
  const maxPasses = options.maxPasses ?? 1_000;
  let work = 0;
  let passes = 0;
  let run = await readRun(orchestrator.database, options.runId);
  if (run === null) raise(`no run ${options.runId} is recorded`);
  while (passes < maxPasses) {
    passes += 1;
    const pass = await schedulerPass(orchestrator, { runId: run.runId });
    run = pass.run;
    let claimedThisPass = 0;
    for (let worker = 0; worker < workers; worker += 1) {
      const outcome = await workOnce(orchestrator, { worker: `worker-${worker + 1}` });
      if (!outcome.claimed) break;
      claimedThisPass += 1;
      work += 1;
    }
    if ((TERMINAL_RUN_STATES as readonly string[]).includes(run.state)) return { run, passes, work, settled: true };
    if (claimedThisPass === 0 && !pass.moved) {
      return { run, passes, work, settled: false, stoppedBecause: 'a pass and its claims together changed nothing' };
    }
  }
  return { run, passes, work, settled: false, stoppedBecause: `the run did not finish within ${maxPasses} passes` };
}

/** One run's own status, for a host that reports it: the state, the counts and the events so far. */
export interface RunStatus {
  readonly run: RunRecord;
  readonly evidence: RunEvidence;
  readonly units: readonly { readonly unitId: string; readonly stageId: string; readonly state: UnitState; readonly generation: number; readonly attempts: number }[];
  readonly chain: ChainRecord | null;
}

/** Answers one run's status without changing anything. */
export async function runStatus(orchestrator: FillOrchestrator, runId: string): Promise<RunStatus | null> {
  const run = await readRun(orchestrator.database, runId);
  if (run === null) return null;
  const units = await readRunUnits(orchestrator.database, runId);
  const evidence = await runEvidence(orchestrator, runId);
  return {
    run,
    evidence,
    units: units.map((unit) => ({ unitId: unit.unitId, stageId: unit.stageId, state: unit.state, generation: unit.generation, attempts: unit.context.attempt })),
    chain: await readChain(orchestrator.database, orchestrator.product),
  };
}

/** The orchestrator's own tables, so a host can create them beside the state machines'. */
export { ORCHESTRATOR_TABLES };
