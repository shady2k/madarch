import { AttemptStaleError, fencedAttemptStart } from '../graph/operation-host.js';
import { RUN_JOB_HEARTBEAT_SECONDS, UNIT_JOB_ATTEMPT_SECONDS } from './queue-limits.js';
/** Queue-driven fill scheduling. Accepted graph operations commit immediately; terminal receipts settle claims. */
import type {StageContext,StageExecutionResult,StageGraphReader,StageUnitTools,ResolvedStageConfiguration} from './stage.js';
import { canonicalJsonDigest } from '../model/canonical.js';
import { errorText } from '../model/error-text.js';
import { producerSucceeded } from './producer-outcomes.js';
import { ClosureRefusal } from '../plugin/closure-refusal.js';
import { readProducerOutcomes, readProducerOutcomesIn } from '../graph/producer-outcomes.js';
import type { SqlExecutor } from '../sql-driver.js';
import { byCodePoint } from '../model/order.js';
import { annotateSpan, withSpan } from '../obs/trace.js';
import type { FillControl } from '../product/fill-runtime.js';
import { hashFillInputs } from '../product/fill-runtime.js';
import { here, raise, withLocation } from './fsm-core.js';
import { GraphReadRefusal, answerMembership, recordedReadText } from './read-record.js';
import { SnapshotError } from '../plugin/repository-snapshot.js';
import { FINAL_RUN_STATES, isFinalRunState, isFinalUnitState, runPhaseOf, type UnitAdvanceEvent, type UnitChildOutcome, type UnitFailedChildPolicy, type UnitRetryCause, type UnitState } from './fsm.js';
import { UnitBoundStop } from './unit-bound.js';
import {
  writeOrchestration,
  type OrchestratorDatabase,
  appendProgress, recordInheritedUnitIn, readSealedChildrenIn,
  appendProgressIn, appendProgressBatchIn, recordUnitReadBatchIn, unitPlanIn, type FillProgressEvent,
  appendProgresses,
  readRunConfiguration,
  readRunPlans,
  readRunPublicationCount,
  readRunPlanningSnapshot,
  readSealedChildren,
  readSplitParents,
  readUnitPlan,
  readUnitReads,
  recordUnitReads,
  recordRunConfigurationIn, recordRunStagePlannedIn,
  recordUnitPlanIn,
  sealSplitIn,
  type ProgressKind,
  type RunSnapshot,
  type UnitPlanRecord,
} from '../graph/fill-orchestration.js';
import {
  deriveStageGraph,
  snapshotStageConfigurations,
  type DerivedStageGraph,
  type StageGraphRead,
  type StarvationPath,
} from './registry.js';
import type { StageRegistry } from './registry.js';
import {
  advanceChainIn, openChainIn, createRunIn, readChainRecordIn,
  advanceRun, advanceRunIn, readRunIn, replaceStaleGenerationIn, retryGenerationIn,
  advanceUnitIn,
  createUnitIn,
  readRun,
  readRunStateSnapshot, readRunStatusSnapshot,
  type RunStateSnapshot,
  readRunUnits,
  readRunUnitsIn,
  lockFillScope,
  readUnit,
  readUnitIn,
  readUnitGeneration, readUnitGenerationIn,
  readProductUnits,
  RETRYABLE_UNIT_STATES,
  type ChainRecord,
  type RunRecord,
  type UnitRecord,
} from '../graph/fill-state.js';
import type { RunEvidence } from './fsm.js';
import type { QueueService, ClaimedJob } from './queue.js';
import type { FillStageConfigurationRead } from '../product/manifest/fill-config.js';
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

/**
 * Where one unit's own MCP server comes from (0026, "Agents and tools"): the host
 * opens it for the generation this attempt runs, bound to the attempt's own draft
 * set, and the orchestrator closes it when the attempt ends. A stage that declares
 * `usesTools` is handed the server; a run whose host opens none hands the stage
 * nothing, and the stage refuses by name rather than starting an agent that cannot
 * read.
 */
export interface UnitToolsOpening {
  /** The unit generation this attempt runs. */
  readonly unit: UnitRecord;
  /** The unit's place in the run's plan: the scope it covers and the run its drafts belong to. */
  readonly plan: UnitPlanRecord;
  /** The attempt's own draft set: where the unit's tools land an accepted write. */
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
  /** Active queue claim lifetime; pg-boss owns expiry and retry authority. */
  readonly attemptSeconds:number;
  /** Liveness bound; the attempt touches its claim every third of this interval. */
  readonly heartbeatSeconds: number;
  /** The most units of one run that may stand admitted at once, every stage together. */
  readonly maxInFlight: number;
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
  attemptSeconds: UNIT_JOB_ATTEMPT_SECONDS,
  heartbeatSeconds: RUN_JOB_HEARTBEAT_SECONDS,
  maxInFlight: 4,
  retries: 2,
  retryDelayMs: 5_000,
  ageingStepMs: 60_000,
  maxSplitDepth: 3,
  maxSplitChildren: 8,
  maxSplitWork: 200_000,
  failedChildPolicy: 'propagate',
};

/** Everything the orchestrator is given once, when it is created. */
export interface UnitOperationOpening { readonly unit:UnitRecord; readonly plan:UnitPlanRecord; readonly job:ClaimedJob; readonly queue:QueueService; }
export interface UnitOperations { setRunState?(runId:string,state:'running'|'paused'|'cancelled',transaction?:OwnerTransaction):Promise<void>; open(request:UnitOperationOpening):Promise<{host:import('../graph/operation-host.js').OperationHost;sourceUid:string;unitUid:string}>; }
export interface OrchestratorOptions {
  readonly operations:UnitOperations;
  /** The process's one database owner (madarch-tzte.19.1). Never opened, never closed here. */
  readonly database: OrchestratorDatabase;
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
  /** Supplies recorded time; the real clock unless a test passes its own. */
  readonly clock?: () => number;
  /** Whether the person paused or stopped the run (fill-runtime's control file, kept). */
  readonly control?: RunControlReader;
  /** The human-edit guard a stage's completion passes through, when the host has one. */
  readonly guard?: HumanEditGuard;
  /** Where a unit's own MCP server is opened, for the stages that declare `usesTools`. */
  readonly unitTools?: (request: UnitToolsOpening) => Promise<StageUnitTools | undefined> | StageUnitTools | undefined;
  /**
   * One pinned repository for a static unit, as its path-scoped answers
   * (decision 0033, "Capability boundaries"). A stage that declares no static
   * reading is handed none; a static stage is handed the repository the unit's
   * scope names. The source is the host's, so the run never reaches a checkout
   * itself and a stage never receives a tree reader.
   */
  /**
   * The graph a static unit reads through (decision 0033): bounded by key, by
   * global name and by one neighbourhood, never a whole table. The host owns
   * the store; a stage is handed the reader and nothing wider.
   */
  /** Every durable progress event, once it is committed. */
  readonly sink?: ProgressSink;
  /** Where the orchestrator's own lines go; nothing by default. */
  readonly log?: (line: string) => void;
  readonly limits?: Partial<OrchestratorLimits>;
}

/** The orchestrator, with every seam resolved. */
export interface FillOrchestrator {
  readonly operations:UnitOperations;
  readonly database: OrchestratorDatabase;
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
  readonly control: RunControlReader;
  readonly guard: HumanEditGuard | undefined;
  readonly unitTools: ((request: UnitToolsOpening) => Promise<StageUnitTools | undefined>) | undefined;
  readonly sink: ProgressSink | undefined;
  readonly log: (line: string) => void;
  /**
   * The sessions an in-flight unit is running, by unit id and generation: a
   * cancellation revokes their authority (the run machine's `revoke-run-authority`
   * effect) by aborting them here. The orchestrator registers one per attempt and
   * removes it when the attempt ends.
   */
  readonly authority: Map<string, AbortController>;
  /** The production heartbeat of the run this orchestrator drives. */
  readonly heartbeat: { timer: ReturnType<typeof setInterval> | undefined; runId: string | null; ownerToken: string | null };
}

/** Builds the orchestrator, resolving every seam and the limits. */
export function createOrchestrator(options: OrchestratorOptions): FillOrchestrator {
  if (options.product.trim() === '') raise('the orchestrator needs the product it fills');
  if (options.queueName.trim() === '') raise('the orchestrator needs the name of the queue its units wait in');
  const limits = { ...DEFAULT_ORCHESTRATOR_LIMITS, ...options.limits };
  if (limits.maxInFlight < 1) raise(`the orchestrator's maxInFlight is ${limits.maxInFlight}: a run admits at least one unit at a time`);
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
    control: options.control ?? (async () => undefined),
    guard: options.guard,
    operations: options.operations,
    unitTools: options.unitTools === undefined ? undefined : async (request) => await options.unitTools!(request),
    sink: options.sink,
    log: options.log ?? (() => undefined),
    authority: new Map(),
    heartbeat: { timer: undefined, runId: null, ownerToken: null },
  };
}

/** The key one attempt's authority is registered under. */
const authorityKey = (unitId: string, generation: number): string => `${unitId}/${generation}`;

/** The store's unit id for one stage's own unit id: no run id is ever part of it (decision 0026). */
export function unitIdFor(stageId: string, stageUnitId: string): string {
  return `${stageId}/${stageUnitId}`;
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
  orchestrator: Pick<FillOrchestrator, 'database' | 'sink'>,
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

type ProgressDraft = Omit<FillProgressEvent, 'seq'>;

/** Commit the transition and its event before notifying the observer. */
async function advanceUnitWithProgress(
  orchestrator: Pick<FillOrchestrator, 'database' | 'sink'>,
  options: Parameters<typeof advanceUnitIn>[1],
  event: ProgressDraft,
  effect?: (tx: OwnerTransaction) => Promise<unknown>,
) {
  let stored: FillProgressEvent | undefined;
  const step = await writeOrchestration(orchestrator.database, async tx => {
    const step = await advanceUnitIn(tx, options);
    if (step.ok) {
      await effect?.(tx);
      stored = await appendProgressIn(tx, event);
    }
    return step;
  });
  if (stored !== undefined) await orchestrator.sink?.(stored);
  return step;
}

async function advanceRunWithProgress(
  orchestrator: Pick<FillOrchestrator, 'database' | 'sink'>,
  options: Parameters<typeof advanceRunIn>[1],
  event: ProgressDraft,
) {
  let stored: FillProgressEvent | undefined;
  const step = await writeOrchestration(orchestrator.database, async tx => {
    await lockFillScope(tx, options.runId);
    const step = await advanceRunIn(tx, options);
    if (step.ok) stored = await appendProgressIn(tx, event);
    return step;
  });
  if (stored !== undefined) await orchestrator.sink?.(stored);
  return step;
}

/** One transaction of the process's owner, as the owner hands it to its work. */
type OwnerTransaction = Parameters<Parameters<OrchestratorDatabase['transaction']>[1]>[0];

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
  return await withLocation(site, operation, tables, async () => await writeOrchestration(orchestrator.database, work));
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

/**
 * The versions that decide what one stage's units read and answer, beside the versions of the stage
 * module's own code: the stage's `id@version` and whatever it names through `cacheVersions` — the prompt
 * it sends, the answer schema it asks for, the model it drives (decision 0026, "Updates"). They are part
 * of a unit's cache key (0027's `inputsDigest` holds their digest), so a run that resolves another of
 * them replaces the units the last one planned rather than inheriting them.
 */
function stageCacheVersions(stage: FillStage): Readonly<Record<string, string>> {
  return { stage: `${stage.id}@${String(stage.version)}`, ...(stage.cacheVersions?.() ?? {}) };
}

/**
 * The part of a unit's cache key that is known before it runs, and its two halves: the digest of its named
 * inputs and of the versions that decide what it reads and answers. The digest is what the store keeps as the
 * generation's `inputs_digest`, so a run compares what it would plan with what the standing generation was
 * planned under; the halves are kept apart so a run that finds it moved can say which of them moved. The other
 * two parts of 0026's key — its reads with their membership and its spans — are rechecked against the graph and
 * the pins (`generationFresh`).
 */
async function cacheKeyOf(orchestrator: FillOrchestrator, unit: UnitRecord, plan: UnitPlanRecord): Promise<CacheKeyParts> {
  return await cacheKeyFor(orchestrator, unitRef(unit, plan));
}

/** One unit's cache key's known part, from the reference the run's seams name it by. */
async function cacheKeyFor(orchestrator: FillOrchestrator, ref: UnitRef): Promise<CacheKeyParts> {
  const inputs = hashFillInputs(await orchestrator.inputs(ref));
  const versions = stageCacheVersions(stageOf(orchestrator, ref.stageId));
  return { digest: canonicalJsonDigest({ inputs, versions }), versions };
}

/** The digest of a unit's named inputs and of the versions that decide what it reads and answers. */
interface CacheKeyParts {
  readonly digest: string;
  readonly versions: Readonly<Record<string, string>>;
}


/**
 * What moved between the versions a generation was planned under and the ones a run resolves now, in the
 * versions' own words: `<key> <was> → <now>` for each that differs, and a key the plan row does not hold named as
 * one the run cannot compare. Empty where they stand as they stood.
 */
function movedVersions(recorded: Readonly<Record<string, string>> | undefined, now: Readonly<Record<string, string>>): readonly string[] {
  if (recorded === undefined) return [];
  const keys = [...new Set([...Object.keys(recorded), ...Object.keys(now)])].sort(byCodePoint);
  return keys.filter((key) => recorded[key] !== now[key]).map((key) => `${key} ${recorded[key] ?? 'none'} → ${now[key] ?? 'none'}`);
}

/** Why a generation's cache key moved, or that it did not: decision 0026's four parts, as a run reads them. */
type CacheKeyVerdict =
  | { readonly fresh: true }
  | { readonly fresh: false; readonly cause: string; /** The digest the generation's known part resolves to now. */ readonly digest: string };

/**
 * Whether one generation still stands for what a run would plan of it (decision 0026, "Updates"): its
 * named inputs and the versions that decide what it reads and answers hash what they hashed, and every
 * read it recorded answers what it answered — an empty answer that became a non-empty one, and a span
 * whose bytes at the run's own pin changed, included. A generation whose key moved is replaced, never
 * inherited and never overwritten (0027): a published one keeps its publication as its record.
 */
async function generationFresh(orchestrator: FillOrchestrator, unit: UnitRecord, known?: { readonly digest: string; readonly versions: Readonly<Record<string, string>> }): Promise<CacheKeyVerdict> {
  const plan = await readUnitPlan(orchestrator.database, unit.unitId, unit.generation);
  if (plan === null) {
    // Nothing says what the generation's scope was, so its key cannot be read: it is reported as stale with the
    // digest the run resolves for it, never with the one it stands on — a replacement under an old digest would
    // move again on the next run.
    const resolved = known ?? await cacheKeyFor(orchestrator, { stageId: unit.stageId, stageUnitId: unit.scopeKey, unitId: unit.unitId, scope: unit.scopeKey, generation: unit.generation });
    return { fresh: false, cause: `the generation ${unit.generation} of "${unit.unitId}" holds no plan row, so nothing says what its scope was`, digest: resolved.digest };
  }
  // A caller that has just computed this unit's key hands it over: planning compares the generation it would plan
  // with the one standing, and the two are one key.
  const key = known ?? await cacheKeyOf(orchestrator, unit, plan);
  if (key.digest !== unit.inputsDigest) {
    const versions = movedVersions(plan.cacheVersions, key.versions);
    if (versions.length > 0) return { fresh: false, cause: `the versions that decide what it reads and answers moved: ${versions.join(', ')}`, digest: key.digest };
    if (plan.cacheVersions === undefined) {
      return { fresh: false, cause: `its named inputs moved, or the versions it was planned under are not recorded: ${unit.inputsDigest} is now ${key.digest}`, digest: key.digest };
    }
    return { fresh: false, cause: `its named inputs moved: ${unit.inputsDigest} is now ${key.digest}`, digest: key.digest };
  }
  const moved = await movedRead(orchestrator, unit, plan);
  if (moved !== null) {
    return { fresh: false, cause: movedReadReason(moved), digest: key.digest };
  }
  return { fresh: true };
}

/**
 * The first read a generation recorded that answers something else now, or null when every read still
 * answers what it answered (empty answers included, and a span's bytes at the run's own pin, `answerMembership`).
 * The read is named, so the generation the sweep replaces says which part of its cache key moved.
 */
async function movedRead(orchestrator: FillOrchestrator, unit: UnitRecord, plan: UnitPlanRecord): Promise<MovedRead | null> {
  const reads = await readUnitReads(orchestrator.database, unit.unitId, unit.generation);
  if (reads.length === 0) return null;
  const reader = await orchestrator.graph(unitRef(unit, plan));
  for (const read of reads) {
    // A read is replayed as a recheck replays it (`recordedReadText`): a span a build before this
    // recorded under its commit — the only form there was — is normalized here, so a recheck at the run's
    // own pin answers it instead of refusing the commit it names (madarch-tzte.26.1's round-3 review).
    const answered = await answerNow(reader, recordedReadText(read.query));
    // A read that cannot be answered at all answers nothing that could match: the file a span cited is gone, or
    // shorter than the span's first line, and the generation that read it is stale by that fact alone.
    if (answered.kind === 'unanswered') return { query: read.query, unanswerable: answered.reason };
    if (answerMembership(read.query, answered.rows) !== read.membership) return { query: read.query };
  }
  return null;
}

/** One read a generation recorded that no longer stands: the read, and why it cannot be answered where it cannot. */
interface MovedRead {
  readonly query: string;
  /** The reader's own words, where the read cannot be answered at all rather than answered differently. */
  readonly unanswerable?: string;
}

/** The sentence a moved read is reported by, in the read's own terms. */
function movedReadReason(moved: MovedRead): string {
  return moved.unanswerable === undefined
    ? `a read the generation recorded answers something else now: ${readNamed(moved.query)}`
    : `a read the generation recorded can no longer be answered: ${readNamed(moved.query)} (${moved.unanswerable})`;
}

/**
 * What one recorded read answers now, or why nothing stands there to read any more. A graph that moved under a
 * unit is no defect of the store: a commit that deletes a file an evidence span cited, or shortens it past the
 * span's first line, makes the read unanswerable — `SnapshotError` for a repository, a commit or a file the pin
 * no longer holds, `GraphReadRefusal` for a span the file is too short for — and the run reads that as the read
 * having moved rather than as a failure of the update it is running (`movedRead`, and the publication's own
 * recheck). Every other failure of a reader — a store error, a statement a stage wrote wrong — is rethrown: it is
 * no movement of the graph, and a generation is never replaced for it.
 */
async function answerNow(
  reader: UnitGraphReader,
  query: string,
): Promise<{ readonly kind: 'read'; readonly rows: readonly unknown[] } | { readonly kind: 'unanswered'; readonly reason: string }> {
  try {
    return { kind: 'read', rows: await withSpan('graph.orchestrator.answerNow', {}, async () => await reader.query(query)) };
  } catch (error) {
    if (error instanceof SnapshotError || error instanceof GraphReadRefusal) return { kind: 'unanswered', reason: error.message };
    throw error;
  }
}

/** Whether every read a generation recorded still answers what it answered (empty answers included). */
async function readsFresh(orchestrator: FillOrchestrator, unit: UnitRecord, plan: UnitPlanRecord): Promise<boolean> {
  return (await movedRead(orchestrator, unit, plan)) === null;
}

/** One read's text as a sentence names it: its first 160 code points, cut with an ellipsis. */
function readNamed(query: string): string {
  const points = [...query];
  return points.length <= 160 ? query : `${points.slice(0, 159).join('')}…`;
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

type RunStateReader = () => Promise<RunStateSnapshot>;

/** How many of a run's units stand in one of the states named. */
const countIn = (units: readonly UnitRecord[], states: readonly UnitState[]): number =>
  units.filter((unit) => states.includes(unit.state)).length;

/** The states an admitted unit holds a slot of the run in. */
const ADMITTED_STATES: readonly UnitState[] = ['ready', 'running'];

/** The states an attempt holds a lease in: a lapse in any of them is the same lapse, whatever step the attempt had reached. */

/** The states a generation is live in: those a cancellation revokes and a staleness replaces. */
const LIVE_STATES: readonly UnitState[] = ['planned', 'ready', 'running', 'waiting_children', 'retry_wait', 'blocked'];

// ---------------------------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------------------------

/** One unit the run planned, as the orchestrator created or found it. */
interface PlannedUnit {
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
  let planningEvent: FillProgressEvent | undefined;
  const preparation = await writeOrchestration(database, async tx => {
    await lockFillScope(tx, run.runId);
    const current = await readRunIn(tx, run.runId);
    const recorded = await recordRunConfigurationIn(tx, { runId: run.runId, digest: configurationDigest, snapshot, at });
    if (recorded.digest !== configurationDigest || current?.state !== 'created') return { recorded };
    const planned = await advanceRunIn(tx, { runId: run.runId, event: { type: 'plan', at, configuration: configurationDigest } });
    if (planned.ok) planningEvent = await appendProgressIn(tx, { runId: run.runId, at, stage: '', unitId: '', generation: null, kind: 'run-planned', summary: `the run planned against ${snapshot.repository} at ${snapshot.commit}` });
    return { recorded, planned };
  });
  if (planningEvent !== undefined) await orchestrator.sink?.(planningEvent);
  if (preparation.recorded.digest !== configurationDigest) return {
    outcome: 'refused', run, code: 'fill-orchestrator/configuration-moved',
    reason: `fill-orchestrator: run "${run.runId}" planned with the configuration ${preparation.recorded.digest} and now resolves ${configurationDigest}: a run is planned once against what it resolved, and a changed product configuration is a new run`,
  };
  if (preparation.planned !== undefined && !preparation.planned.ok) return { outcome: 'refused', run, code: preparation.planned.refusal.code, reason: preparation.planned.refusal.reason };
  if (!read.ok || read.graph.order.length === 0) {
    // A starved consumer, or a graph with no enabled stage at all: the run planned and is blocked with
    // the path the derivation named, and nothing is planned for it.
    const starvation = read.ok ? [] : [...read.starvation].sort((left, right) => byCodePoint(left.path, right.path));
    const path = starvation.length > 0 ? starvation[0]!.path : 'the stage graph → enabled stages → none (every registered stage is disabled)';
    const blocked = await advanceRunWithProgress(orchestrator, { runId: run.runId, event: { type: 'block', at, starvationPath: path } }, { runId: run.runId, at, stage: '', unitId: '', generation: null, kind: 'run-blocked', summary: `the run is blocked: ${path}` });
    const record = blocked.ok ? blocked.record : run;
    if (blocked.ok) {

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
  // The watermark every attempt of this planning records (madarch-tzte.26.3):
  // what the run has published by now — nothing at a first planning, the
  // publications of its earlier attempts at a resumed one.
  const publishedByNow = await readRunPublicationCount(database, run.runId);
  for (const [stagePosition, stageId] of graph.order.entries()) {
    let stage: StagePlanOutcome & { readonly refusal?: PlanRefusal };
    try {
      stage = await planStageUnits(orchestrator, { run, graph, stageId, stagePosition, at });
    } catch (error) {
      throw error;
    }
    if (stage.refusal !== undefined) return { outcome: 'refused', run, code: stage.refusal.code, reason: stage.refusal.reason };
    units.push(...stage.units);
    reused.push(...stage.reused);
    if (stage.foundNothing) foundNothing.push(stageId);
    // The stage's attempt is what a re-planning of the run reads (madarch-tzte.26.3):
    // a stage that planned no unit may be planned again once the run has published
    // past its attempt what a producer of its inputs makes, and never twice
    // without one.
    const stageEvent = await writeOrchestration(database, async tx => {
      await lockFillScope(tx, run.runId);
      await recordRunStagePlannedIn(tx, { runId: run.runId, stageId, units: stage.units.length, publications: publishedByNow, at });
      return await appendProgressIn(tx, {
      runId: run.runId, at, stage: stageId, unitId: '', generation: null, kind: 'stage-planned',
      summary: `stage ${stageId} planned ${stage.units.length} ${stage.units.length === 1 ? 'unit' : 'units'}${stage.reused.length > 0 ? ` and inherited ${stage.reused.length}` : ''}`,
    });
    });
    await orchestrator.sink?.(stageEvent);
  }

  if (run.state !== 'running') {
    const started = await advanceRunWithProgress(orchestrator, { runId: run.runId, event: { type: 'start', at, stages: graph.order.length } }, { runId: run.runId, at, stage: '', unitId: '', generation: null, kind: 'run-started', summary: `the run started ${graph.order.length} stages: ${graph.order.join(', ')}` });
    if (!started.ok) return { outcome: 'refused', run, code: started.refusal.code, reason: started.refusal.reason };

    return { outcome: 'planned', run: started.record, graph, snapshot, configurationDigest, units, reused, foundNothing };
  }
  return { outcome: 'planned', run, graph, snapshot, configurationDigest, units, reused, foundNothing };
}


/** What planning one stage of a run gave. */
interface StagePlanOutcome {
  readonly stageId: string;
  readonly units: readonly PlannedUnit[];
  readonly reused: readonly string[];
  readonly foundNothing: boolean;
}

/** The refusal planning one unit ended on, with the machine's own code and words. */
interface PlanRefusal {
  readonly code: string;
  readonly reason: string;
}

/**
 * Asks one stage for its units and records each unit's place in the plan: the
 * body of a planning wave. A unit whose identity holds a published generation
 * of another run is inherited when 0026's whole cache key stands and replaced
 * when it moved; anything else another run holds is refused, because two runs
 * may not work one unit.
 */
async function planStageUnits(
  orchestrator: FillOrchestrator,
  options: { readonly run: RunRecord; readonly graph: DerivedStageGraph; readonly stageId: string; readonly stagePosition: number; readonly at: number },
): Promise<StagePlanOutcome & { readonly refusal?: PlanRefusal }> {
  // One step of the fill is one span: the stage's plan and every unit it recorded, under the step's name.
  return await withSpan('fill.step', { 'madarch.step': options.stageId, 'madarch.run': options.run.runId }, async (span) => {
    const answer = await planStageUnitsSpanned(orchestrator, options);
    span.setAttribute('madarch.units', answer.units.length);
    span.setAttribute('madarch.reused', answer.reused.length);
    if (answer.foundNothing) span.setAttribute('madarch.found', 'nothing');
    if (answer.refusal !== undefined) span.setAttribute('madarch.refusal', answer.refusal.code);
    return answer;
  });
}

/** One stage's planning wave, with the step's span already around it. */
async function planStageUnitsSpanned(
  orchestrator: FillOrchestrator,
  options: { readonly run: RunRecord; readonly graph: DerivedStageGraph; readonly stageId: string; readonly stagePosition: number; readonly at: number },
): Promise<StagePlanOutcome & { readonly refusal?: PlanRefusal }> {
  const database = orchestrator.database;
  const { run, stageId, stagePosition, at } = options;
  const units: PlannedUnit[] = [];
  const reused: string[] = [];
  const stage = stageOf(orchestrator, stageId);
  const plan: StagePlan = await stage.plan(await orchestrator.graph({ stageId, stageUnitId: '', unitId: '', scope: '', generation: 0 }));
  const foundNothing = plan.coverage === 'nothing-found';
  if (foundNothing) {
    // Decision 0027's distinction, made durable: a producer that found nothing is reported, so nobody
    // reads a plan of no units as a capability nothing produces.
    await emit(orchestrator, { runId: run.runId, at, stage: stageId, unitId: '', generation: null, kind: 'stage-found-nothing', summary: `stage ${stageId} read its producer's inputs and found nothing to plan in them` });
  }
  for (const [planPosition, scope] of plan.units.entries()) {

    const unitId = unitIdFor(stageId, scope.id);
    const ref: UnitRef = { stageId, stageUnitId: scope.id, unitId, scope: scope.scope, generation: 1 };
    const digest = canonicalJsonDigest({ inputs: hashFillInputs(await orchestrator.inputs(ref)), versions: stageCacheVersions(stage) });
    let plannedEvent: FillProgressEvent | undefined;
    const { before, answer } = await ownTransaction(here(), orchestrator, `planUnit(${unitId})`, ['node','edge','assertion'], async executor => {
      await lockFillScope(executor, run.runId);
      const before = await readUnitIn(executor, unitId);
      const answer = await createUnitIn(executor, {
        unitId, product: orchestrator.product, runId: run.runId, stageId,
        scopeKey: scope.id, inputsDigest: digest, retries: orchestrator.limits.retries, at,
      });
      if (answer.runId === run.runId) await recordUnitPlanIn(executor, {
        unitId, generation: answer.generation, runId: run.runId, stageId, stageUnitId: scope.id,
        scope: scope.scope, stagePosition, planPosition, at, cacheVersions: stageCacheVersions(stage),
      });
      if (before === null && answer.runId === run.runId) plannedEvent = await appendProgressIn(executor, { runId: run.runId, at, stage: stageId, unitId, generation: answer.generation, kind: 'unit-planned', summary: `planned ${unitId} (${scope.scope})` });
      return { before, answer };
    });
    if (answer.runId !== run.runId) {
        // The identity already has a generation another run owns. Decision 0027's reuse is exact, and decision
        // 0026's cache key decides it whole: a published generation whose key did not move — its named inputs and
        // versions, every read it recorded, the spans it read — is inherited and planned for nothing, a published
        // or stale one whose key moved is replaced under this run, and anything else — a generation another run is
        // working on, or one that ended blocked, failed or cancelled — is refused, because two runs may not work
        // one unit and a lost generation is not silently reused.
        if (answer.state === 'published' || answer.state === 'stale') {
          if (answer.state === 'published') {
            // The digest this planning computed is the key the standing generation is compared with: one
            // computation of the unit's inputs per unit, not two.
            const verdict = await generationFresh(orchestrator, answer, { digest, versions: stageCacheVersions(stage) });
            if (verdict.fresh) {
              const inheritedEvent = await writeOrchestration(database, async tx => {
                await lockFillScope(tx, run.runId);
                const current = await readUnitIn(tx, unitId);
                if (current?.generation !== answer.generation || current.state !== 'published' || current.inputsDigest !== answer.inputsDigest) raise(`unit "${unitId}" changed while inheritance was prepared`);
                await recordInheritedUnitIn(tx,{runId:run.runId,unitId,generation:answer.generation});
                return await appendProgressIn(tx, { runId: run.runId, at, stage: stageId, unitId, generation: answer.generation, kind: 'unit-inherited', summary: `${unitId} generation ${answer.generation} verified unchanged for this run` });
              });
              await orchestrator.sink?.(inheritedEvent);
              reused.push(unitId);
              continue;
            }
            const invalidated = await advanceUnitWithProgress(orchestrator, { unitId, event: { type: 'invalidate', at, replacement: answer.generation + 1, cause: `the run ${run.runId} plans this unit against a cache key that moved: ${verdict.cause}` } }, { runId: run.runId, at, stage: stageId, unitId, generation: answer.generation, kind: 'unit-stale', summary: `${unitId} went stale (${verdict.cause}); generation ${answer.generation + 1} replaces it` });
            if (!invalidated.ok) {
              return { stageId, units, reused, foundNothing, refusal: { code: invalidated.refusal.code, reason: `fill-orchestrator: unit "${unitId}" could not be invalidated for run "${run.runId}": ${invalidated.refusal.reason}` } };
            }
          }
          let generationEvent: FillProgressEvent | undefined;
          const replaced = await writeOrchestration(database, async tx => {
            await lockFillScope(tx, run.runId);
            const replaced = await replaceStaleGenerationIn(tx, { unitId, runId: run.runId, inputsDigest: digest, retries: orchestrator.limits.retries, at });
            if (replaced.ok) {
          await recordUnitPlanIn(tx, {
            unitId, generation: replaced.record.generation, runId: run.runId, stageId, stageUnitId: scope.id,
            scope: scope.scope, stagePosition, planPosition, at, cacheVersions: stageCacheVersions(stage),
          });
              generationEvent = await appendProgressIn(tx, { runId: run.runId, at, stage: stageId, unitId, generation: replaced.record.generation, kind: 'unit-planned', summary: `planned ${unitId} (${scope.scope}) as generation ${replaced.record.generation}, replacing the stale generation ${answer.generation} this unit stood on` });
            }
            return replaced;
          });
          if (!replaced.ok) {
            return { stageId, units, reused, foundNothing, refusal: { code: replaced.refusal.code, reason: `fill-orchestrator: unit "${unitId}" could not be replaced for run "${run.runId}": ${replaced.refusal.reason}` } };
          }
          units.push({ unitId, stageId, stageUnitId: scope.id, scope: scope.scope, generation: replaced.record.generation, stagePosition, planPosition, state: replaced.record.state, created: true });
          if (generationEvent !== undefined) await orchestrator.sink?.(generationEvent);
          continue;
        }
        // A generation that published nothing, of a run that has ended, is the unit's last attempt: a new fill retries
        // it with a fresh budget rather than refusing forever. Only a generation of a run that has not ended — a unit
        // another run is working — is refused, which is what "a unit is worked by one run at a time" says.
        const owner = await readRun(database, answer.runId);
        const ended = owner === null || ENDED_RUN_STATES.includes(owner.state);
        if (ended && RETRYABLE_UNIT_STATES.includes(answer.state)) {
          let generationEvent: FillProgressEvent | undefined;
          const retried = await writeOrchestration(database, async tx => {
            await lockFillScope(tx, run.runId);
            const current = await readUnitIn(tx, unitId);
            const owner = current === null ? null : await readRunIn(tx, current.runId);
            if (current?.generation !== answer.generation || (owner !== null && !ENDED_RUN_STATES.includes(owner.state))) raise(`unit "${unitId}" changed ownership while a retry was prepared`);
            const retried = await retryGenerationIn(tx, { unitId, runId: run.runId, inputsDigest: digest, retries: orchestrator.limits.retries, at });
            if (retried.ok) {
          await recordUnitPlanIn(tx, {
            unitId, generation: retried.record.generation, runId: run.runId, stageId, stageUnitId: scope.id,
            scope: scope.scope, stagePosition, planPosition, at, cacheVersions: stageCacheVersions(stage),
          });
              generationEvent = await appendProgressIn(tx, { runId: run.runId, at, stage: stageId, unitId, generation: retried.record.generation, kind: 'unit-planned', summary: `planned ${unitId} (${scope.scope}) as generation ${retried.record.generation}, retrying the ${answer.state} generation ${answer.generation} run "${answer.runId}" left` });
            }
            return retried;
          });
          if (!retried.ok) {
            return { stageId, units, reused, foundNothing, refusal: { code: retried.refusal.code, reason: `fill-orchestrator: unit "${unitId}" could not be retried for run "${run.runId}": ${retried.refusal.reason}` } };
          }
          units.push({ unitId, stageId, stageUnitId: scope.id, scope: scope.scope, generation: retried.record.generation, stagePosition, planPosition, state: retried.record.state, created: true });
          if (generationEvent !== undefined) await orchestrator.sink?.(generationEvent);
          continue;
        }
        return {
          stageId, units, reused, foundNothing,
          refusal: {
            code: 'fill-orchestrator/unit-in-another-run',
            reason: `fill-orchestrator: unit "${unitId}" stands ${answer.state} in run "${answer.runId}"${owner === null ? '' : `, which stands ${owner.state}`}, and run "${run.runId}" plans it: a unit is worked by one run at a time, so finish or cancel that run before this one plans the unit`,
          },
        };
      }
      const created = before === null;
      units.push({ unitId, stageId, stageUnitId: scope.id, scope: scope.scope, generation: answer.generation, stagePosition, planPosition, state: answer.state, created });
      if (plannedEvent !== undefined) await orchestrator.sink?.(plannedEvent);
    }
  return { stageId, units, reused, foundNothing };
}

/**
 * The stages of one run that are due to be planned again (madarch-tzte.26.3):
 * the enabled stages that planned no unit, and that the run has published for
 * at any time of the run — the parent test is a publication of the run,
 * whenever it stood, because a publication after the attempt always moves the
 * count past the watermark, so nothing due is missed; a parent that published
 * earlier in the run costs an empty stage one plan call per publication batch,
 * each naming no unit when the plan is answered. A stage whose plan reads the
 * graph its producers write planned against the graph as it stood at the run's
 * planning, and a producer's publication can be exactly what its plan was
 * waiting to read. The watermark is the publication count the attempt
 * recorded, and a stage whose re-planning answered nothing is not asked again
 * until the run publishes past it. A stage whose last attempt named units is
 * not due: its plan is answered, and 0026's cache key decides what a later run
 * reuses.
 */
function stagesToReplan(
  graph: DerivedStageGraph,
  attempts: ReadonlyMap<string, { readonly publications: number; readonly units: number }>,
  publishedBy: ReadonlyMap<string, number>,
  publications: number,
): readonly { readonly stageId: string; readonly stagePosition: number }[] {
  const parentsOf = new Map<string, string[]>();
  for (const edge of graph.edges) parentsOf.set(edge.to, [...(parentsOf.get(edge.to) ?? []), edge.from]);
  const due: { stageId: string; stagePosition: number }[] = [];
  for (const [stagePosition, stageId] of graph.order.entries()) {
    const attempt = attempts.get(stageId);
    if (attempt === undefined || attempt.units > 0 || attempt.publications >= publications) continue;
    const parents = parentsOf.get(stageId) ?? [];
    if (!parents.some((parent) => (publishedBy.get(parent) ?? 0) > 0)) continue;
    due.push({ stageId, stagePosition });
  }
  return due;
}

/** What one re-planning of a run's empty stages gave. */
type ReplanOutcome =
  | {
    readonly outcome: 'planned';
    /** True when the re-planning planned at least one stage; false when none was due. */
    readonly planned: boolean;
    readonly run: RunRecord;
    readonly units: readonly PlannedUnit[];
    readonly reused: readonly string[];
    readonly foundNothing: readonly string[];
  }
  | { readonly outcome: 'refused'; readonly run: RunRecord; readonly code: string; readonly reason: string };

/**
 * Plans the run's stages that planned no unit and whose producers have
 * published since (madarch-tzte.26.3), as one planning epoch of the run: a
 * running run reopens its planning epoch for them and closes it again when
 * they are planned, so a completion is still guarded by a closed planning
 * epoch. This is the second planning epoch of the first fill: a run plans
 * before anything publishes, and a stage whose plan reads what its producers
 * write — the agent stages of 0026, whose plans name their units from the
 * graph — plans no unit there; planned again at the moment nothing else is
 * outstanding, it names them, and the first fill does its agent work in the
 * run that started it, without a second run, a person or a watcher. A run that
 * stands planning — one that crashed between the re-planning step and its
 * planning, or one a pause resumed — closes its epoch with whatever it plans
 * here, so the resume lands on the same result.
 */
async function replanAfterPublications(orchestrator: FillOrchestrator, options: { readonly runId: string }, state?: RunStateReader): Promise<ReplanOutcome> {
  const database = orchestrator.database;
  const run = (state === undefined ? await readRun(database, options.runId) : (await state()).run);
  if (run === null) raise(`no run ${options.runId} is recorded: a run is created before it plans`);
  if (run.state !== 'planning' && run.state !== 'running') return { outcome: 'planned', planned: false, run, units: [], reused: [], foundNothing: [] };
  const graph = await currentGraph(orchestrator, run.runId);
  const at = orchestrator.clock();
  const planning = await readRunPlanningSnapshot(database, run.runId);
  const attempts = new Map(planning.attempts.map((record) => [record.stageId, { publications: record.publications, units: record.units }]));
  const publishedBy = new Map(planning.stages.map((record) => [record.stageId, record.publications]));
  const publications = planning.publications;
  const due = stagesToReplan(graph, attempts, publishedBy, publications);
  if (due.length === 0) {
    if (run.state !== 'planning') return { outcome: 'planned', planned: false, run, units: [], reused: [], foundNothing: [] };
    // A run that stands planning with nothing due is one that crashed between
    // the re-planning step and its planning, or one a pause resumed: the epoch
    // closes with nothing left to plan.
    const started = await advanceRunWithProgress(orchestrator, { runId: run.runId, event: { type: 'start', at, stages: graph.order.length } }, { runId: run.runId, at, stage: '', unitId: '', generation: null, kind: 'run-started', summary: `the run started ${graph.order.length} stages: ${graph.order.join(', ')}` });
    if (!started.ok) return { outcome: 'refused', run, code: started.refusal.code, reason: started.refusal.reason };

    return { outcome: 'planned', planned: false, run: started.record, units: [], reused: [], foundNothing: [] };
  }
  const reopened = run.state === 'running'
    ? await advanceRun(database, { runId: run.runId, event: { type: 'replan', at, stages: due.length } })
    : { ok: true as const, record: run, transition: '', effects: [] as readonly string[] };
  if (!reopened.ok) {
    await emit(orchestrator, { runId: run.runId, at, stage: '', unitId: '', generation: null, kind: 'run-refused', summary: `the run's re-planning was refused: ${reopened.refusal.reason}` });
    return { outcome: 'refused', run, code: reopened.refusal.code, reason: reopened.refusal.reason };
  }
  const units: PlannedUnit[] = [];
  const reused: string[] = [];
  const foundNothing: string[] = [];
  for (const { stageId, stagePosition } of due) {
    const stage = await planStageUnits(orchestrator, { run: reopened.record, graph, stageId, stagePosition, at });
    if (stage.refusal !== undefined) {
      await emit(orchestrator, { runId: run.runId, at, stage: stageId, unitId: '', generation: null, kind: 'run-refused', summary: `the run's re-planning was refused: ${stage.refusal.reason}` });
      return { outcome: 'refused', run: reopened.record, code: stage.refusal.code, reason: stage.refusal.reason };
    }
    units.push(...stage.units);
    reused.push(...stage.reused);
    if (stage.foundNothing) foundNothing.push(stageId);
    const stageEvent = await writeOrchestration(database, async tx => {
      await lockFillScope(tx, run.runId);
      await recordRunStagePlannedIn(tx, { runId: run.runId, stageId, units: stage.units.length, publications, at });
      return await appendProgressIn(tx, {
      runId: run.runId, at, stage: stageId, unitId: '', generation: null, kind: 'stage-planned',
      summary: `stage ${stageId} planned ${stage.units.length} ${stage.units.length === 1 ? 'unit' : 'units'}${stage.reused.length > 0 ? ` and inherited ${stage.reused.length}` : ''} once its producers published`,
    });
    });
    await orchestrator.sink?.(stageEvent);
  }
  const started = await advanceRunWithProgress(orchestrator, { runId: run.runId, event: { type: 'start', at, stages: graph.order.length } }, {
    runId: run.runId, at, stage: '', unitId: '', generation: null,
    kind: run.state === 'running' ? 'run-replanned' : 'run-started',
    summary: run.state === 'running'
      ? `the run reopened planning and planned ${due.length} ${due.length === 1 ? 'stage' : 'stages'}: ${due.map(stage => stage.stageId).join(', ')}`
      : `the run started ${graph.order.length} stages: ${graph.order.join(', ')}`,
  });
  if (!started.ok) return { outcome: 'refused', run: reopened.record, code: started.refusal.code, reason: started.refusal.reason };
  return { outcome: 'planned', planned: true, run: started.record, units, reused, foundNothing };
}

// ---------------------------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------------------------

/** One unit this pass admitted, with the job its admission created. */
interface AdmittedUnit {
  readonly unitId: string;
  readonly generation: number;
  readonly stageId: string;
  /** The queue priority its admission gave it: the earlier it stands, the higher. */
  readonly priority: number;
  /** The job's id, or null when the queue's singleton key already held an unfinished job for the unit. */
  readonly jobId: string | null;
}

/** What one admission pass did. */
interface AdmissionOutcome {
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
export async function admitUnits(orchestrator: FillOrchestrator, options: { readonly runId: string }, state?: RunStateReader): Promise<AdmissionOutcome> {
  const database = orchestrator.database;
  const at = orchestrator.clock();
  const run = (state === undefined ? await readRun(database, options.runId) : (await state()).run);
  if (run === null) raise(`no run ${options.runId} is recorded: a run is created before it admits anything`);
  if (run.state !== 'running') return { run, admitted: [], waitingForSlot: [], refused: [], admittedNow: 0 };
  const graph = await currentGraph(orchestrator, run.runId);
  const snapshot = state === undefined ? undefined : await state();
  const units = snapshot === undefined ? await readRunUnits(database, run.runId) : snapshot.units;
  const plans = snapshot === undefined ? await runPlans(orchestrator, run.runId) : new Map(snapshot.plans.map(plan => [plan.unitId, plan]));
  const withoutPlan = units.filter((unit) => unit.state === 'planned' && !plans.has(unit.unitId));
  const candidates = units.filter((unit) => unit.state === 'planned' && plans.has(unit.unitId));
  const outcomeKey = (unitId: string, generation: number): string => JSON.stringify([unitId, generation]);
  // A sealed publication's completion record is immutable. Mutable state and generation are still read under the lock.
  const publishedOutcomes = new Map((snapshot?.producerOutcomes ?? await readProducerOutcomes(database, { runId: run.runId }))
    .map((outcome) => [outcomeKey(outcome.unitId, outcome.generation), outcome]));
  for (const [key, outcome] of publishedOutcomes) if (!producerSucceeded(outcome.outcome)) publishedOutcomes.delete(key);
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
  // The slots the run already holds, counted once: a pass that opens a transaction per planned unit
  // costs what the plan holds, however few slots are free, and a run of a few thousand units spends
  // minutes per pass doing nothing (madarch-tzte.21.8's walk measured 27 s of a 27.6 s unit on the
  // candidates that found no slot). The count is re-read under the run's own lock inside every
  // admission, so this is an early answer and never the decision.
  let held = 0;
  const heldByStage = new Map<string, number>();
  const unitsById = new Map(units.map((unit) => [unit.unitId, unit]));
  const statesByUnit = new Map(units.map((unit) => [unit.unitId, unit.state]));
  const heldByGroup = new Map<string, number>();
  const groupKey = (stageId: string, group: string): string => JSON.stringify([stageId, group]);
  for (const unit of units) {
    if (ADMITTED_STATES.includes(unit.state) || unit.state === 'retry_wait') {
      const scheduling = stageOf(orchestrator, unit.stageId).unitScheduling?.(unit.unitId.slice(`${unit.stageId}/`.length));
      if (scheduling !== undefined) {
        const key = groupKey(unit.stageId, scheduling.group);
        heldByGroup.set(key, (heldByGroup.get(key) ?? 0) + 1);
      }
    }
    if (!(ADMITTED_STATES as readonly string[]).includes(unit.state)) continue;
    held += 1;
    heldByStage.set(unit.stageId, (heldByStage.get(unit.stageId) ?? 0) + 1);
  }
  for (const [index, candidate] of ordered.entries()) {
    if (held >= orchestrator.limits.maxInFlight) {
      // Every slot is taken and the candidates stand in the order the run admits by: the rest of the
      // plan waits for the next pass, and the walk stops here rather than opening their transactions.
      for (const waiting of ordered.slice(index)) waitingForSlot.push(waiting.unitId);
      break;
    }
    const unit = candidates.find((one) => one.unitId === candidate.unitId)!;
    const resolved = stageConfiguration(graph, unit.stageId);
    if ((heldByStage.get(unit.stageId) ?? 0) >= resolved.concurrency) {
      // This stage holds what it may: another stage's candidate may still fit, so the walk goes on.
      waitingForSlot.push(unit.unitId);
      continue;
    }
    const scheduling = stageOf(orchestrator, unit.stageId).unitScheduling?.(plans.get(unit.unitId)!.stageUnitId);
    if (scheduling !== undefined) {
      // Reject known waits in dependency order; unknown states and plugin outcomes need the locked failure check.
      let dependenciesKnown = true;
      let waiting = false;
      for (const dependency of scheduling.after) {
        const dependencyId = unitIdFor(unit.stageId, dependency);
        const state = statesByUnit.get(dependencyId);
        const previous = unitsById.get(dependencyId);
        if (state === undefined || ['failed', 'blocked', 'cancelled'].includes(state)
          || (state === 'published' && unit.stageId === 'plugin-turns'
            && (previous === undefined || !publishedOutcomes.has(outcomeKey(dependencyId, previous.generation))))) {
          dependenciesKnown = false;
          break;
        }
        if (state !== 'published') { waiting = true; break; }
      }
      if (waiting || (dependenciesKnown && (heldByGroup.get(groupKey(unit.stageId, scheduling.group)) ?? 0) >= scheduling.concurrency)) {
        waitingForSlot.push(unit.unitId);
        continue;
      }
    }
    const priority = ordered.length - index;
    let admissionEvent: FillProgressEvent | undefined;
    const outcome = await ownTransaction(here(), orchestrator, `admitUnit(${unit.unitId}/${unit.generation})`, ['node','edge','assertion'], async (executor) => {
      // The run's own row is taken first: two admission passes of one run are serialized here, so the
      // limits are counted and the step taken under one lock and a slot can never be given twice.
      await lockFillScope(executor,run.runId);
      if ((await readRunIn(executor, run.runId))?.state !== 'running') return { admitted: false as const, why: 'run-state' as const };
      const scheduling = stageOf(orchestrator, unit.stageId).unitScheduling?.(plans.get(unit.unitId)!.stageUnitId);
      if (scheduling !== undefined) {
        for (const dependency of scheduling.after) {
          const dependencyId = unitIdFor(unit.stageId, dependency);
          const previous=await readUnitIn(executor,dependencyId);
          const state=previous?.state;
          const generation=previous?.generation??0;
          const cached = state === 'published' ? publishedOutcomes.get(outcomeKey(dependencyId, generation)) : undefined;
          const latest = cached ?? (state === 'published'
            ? (await readProducerOutcomesIn(executor, { unitId: dependencyId, generation })).at(-1) : undefined);
          if (['failed', 'blocked', 'cancelled'].includes(state ?? '') || (state === 'published' && unit.stageId === 'plugin-turns' && (latest === undefined || !producerSucceeded(latest.outcome)))) {
            // Planned units cannot block directly: admit without enqueueing, then take the ordinary block step.
            const admitted = await advanceUnitIn(executor, { unitId: unit.unitId, event: { type: 'admit', at, generation: unit.generation } });
            if (!admitted.ok) return { admitted: false as const, why: 'refused' as const, refusal: admitted.refusal };
            const reason = `required producer ${dependencyId} did not complete successfully (${latest?.outcome ?? state})`;
            const blocked = await advanceUnitIn(executor, { unitId: unit.unitId, event: { type: 'block', at, generation: unit.generation, fence: unit.context.fence, reason } });
            if (!blocked.ok) return { admitted: false as const, why: 'refused' as const, refusal: blocked.refusal };
            admissionEvent = await appendProgressIn(executor, { runId: run.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-blocked', summary: reason });
            return { admitted: false as const, why: 'dependency-failed' as const, reason };
          }
          if (state !== 'published') return { admitted: false as const, why: 'dependencies' as const };
        }
      }
      const states=await readRunUnitsIn(executor,run.runId);
      if (scheduling !== undefined) {
        const stage = stageOf(orchestrator, unit.stageId);
        const groupInFlight = states.filter((row) => row.stageId === unit.stageId && (ADMITTED_STATES.includes(row.state) || row.state === 'retry_wait')
          && stage.unitScheduling?.(row.unitId.slice(`${unit.stageId}/`.length)).group === scheduling.group).length;
        if (groupInFlight >= scheduling.concurrency) return { admitted: false as const, why: 'producer-slots' as const };
      }
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
      const jobId = enqueued.created ? enqueued.id : null;
      admissionEvent = await appendProgressIn(executor, { runId: run.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-admitted', summary: `admitted ${unit.unitId} at priority ${priority}${jobId === null ? ' (its job was already queued)' : ''}` });
      return { admitted: true as const, jobId };
    });
    if (admissionEvent !== undefined) await orchestrator.sink?.(admissionEvent);
    if (!outcome.admitted) {
      if (outcome.why === 'refused') refused.push({ unitId: unit.unitId, code: outcome.refusal.code, reason: outcome.refusal.reason });
      else if (outcome.why === 'dependency-failed') { /* The block and its event committed together. */ }
      else waitingForSlot.push(unit.unitId);
      continue;
    }
    held += 1;
    heldByStage.set(unit.stageId, (heldByStage.get(unit.stageId) ?? 0) + 1);
    statesByUnit.set(unit.unitId, 'ready');
    if (scheduling !== undefined) {
      const key = groupKey(unit.stageId, scheduling.group);
      heldByGroup.set(key, (heldByGroup.get(key) ?? 0) + 1);
    }
    admitted.push({ unitId: unit.unitId, generation: unit.generation, stageId: unit.stageId, priority, jobId: outcome.jobId });

  }
  return { run, admitted, waitingForSlot, refused, admittedNow: admitted.length };
}


// ---------------------------------------------------------------------------------------------
// The sweeps: what time, an expired lease and a settled join ask for
// ---------------------------------------------------------------------------------------------

/** Why a unit was sent away from an attempt and what the sweep did with it. */
interface SweptUnit {
  readonly unitId: string;
  readonly outcome: 'woken' | 'wake-refused' | 'retried' | 'failed' | 'join-enqueued' | 'join-failed' | 'requeued';
  readonly reason: string;
}

/** What one sweep did. */
interface SweepOutcome {
  readonly swept: readonly SweptUnit[];
  /** Every named step the sweep asked the machine for and the machine refused, so nothing here is dropped in silence. */
  readonly refused: readonly UnitRefusal[];
}

/** The cause a waking retry names: the transition that wakes a wait does not read it, and the journal keeps what it says. */
function wakingCause(_unit: UnitRecord): UnitRetryCause {
  return 'transient-failure';
}

/**
 * Sweeps the run's units for what only time can tell: a retry whose wait is
 * over becomes runnable again, an attempt whose lease lapsed is retried or
 * fails for good, and a waiting parent whose children settled gets its join
 * enqueued. Nothing here sleeps and nothing reads a clock of its own: every
 * moment comes from `orchestrator.clock()`.
 */
export async function sweepUnits(orchestrator: FillOrchestrator, options: { readonly runId: string }, state?: RunStateReader): Promise<SweepOutcome> {
  const database = orchestrator.database;
  const at = orchestrator.clock();
  const swept: SweptUnit[] = [];
  const refused: UnitRefusal[] = [];
  const run = (state === undefined ? await readRun(database, options.runId) : (await state()).run);
  if (run === null) raise(`no run ${options.runId} is recorded`);
  if (run.state !== 'running' && run.state !== 'pausing') return { swept, refused };
  const units = (state === undefined ? await readRunUnits(database, run.runId) : (await state()).units);

  for (const unit of units) {
    if (unit.state === 'retry_wait' && unit.context.retryAt !== null && unit.context.retryAt <= at) {
      const step = await advanceUnitWithProgress(orchestrator, {
        unitId: unit.unitId,
        event: { type: 'retry', at, generation: unit.generation, cause: wakingCause(unit), retryAt: unit.context.retryAt, fence: null },
      }, { runId: run.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-retried', summary: `${unit.unitId} waits no longer; its retry is runnable again` }, tx => orchestrator.queue.enqueue({ queue: orchestrator.queueName, data: { unitId: unit.unitId, generation: unit.generation }, singletonKey: unit.unitId, transaction: tx }));
      if (!step.ok) {
        // The machine refused to wake it: the pass changed nothing here, and saying so keeps a host from
        // spending its passes on a state it cannot move.
        swept.push({ unitId: unit.unitId, outcome: 'wake-refused', reason: step.refusal.reason });
        continue;
      }
      swept.push({ unitId: unit.unitId, outcome: 'woken', reason: `its wait ended at ${unit.context.retryAt}` });
      continue;
    }
    if (unit.state === 'ready') {
      // A unit standing `ready` is one a worker is waiting to be handed, and every
      // way its job can be lost leaves it there: a worker killed between the claim
      // and the lease, whose abandoned claim the queue's own maintenance settles —
      // which frees the unit's singleton key and leaves nothing for a worker to
      // claim — and an enqueue that never happened because the step that asked for
      // it was taken and the effect was not (a retry wake, a join, an unblock). The
      // run offers the job again, and the offer is idempotent: while an unfinished
      // job carries the unit's key the queue creates nothing, so a job that is
      // still queued or still claimed is left exactly as it stands. That is what
      // makes the offer safe to make on every pass, without a record of what was
      // lost.
      let offeredEvent: FillProgressEvent | undefined;
      const offered = await writeOrchestration(database, async tx => {
        await lockFillScope(tx, run.runId);
        const current = await readUnitIn(tx, unit.unitId);
        if (current?.state !== 'ready' || current.generation !== unit.generation) return { created: false };
        const offered = await orchestrator.queue.enqueue({ queue: orchestrator.queueName, data: { unitId: unit.unitId, generation: unit.generation }, singletonKey: unit.unitId, transaction: tx });
        if (offered.created) offeredEvent = await appendProgressIn(tx, { runId: run.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-requeued', summary: `${unit.unitId} stands ready and the queue held no unfinished job for it; the run offers it again` });
        return offered;
      });
      if (offeredEvent !== undefined) await orchestrator.sink?.(offeredEvent);
      if (offered.created) swept.push({ unitId: unit.unitId, outcome: 'requeued', reason: 'the unit stands ready and the queue held no unfinished job for it' });
      continue;
    }
    if (unit.state === 'waiting_children') {
      const plan = await planOf(orchestrator, unit);
      const joined = await settleJoin(orchestrator, { unit, plan, runId: run.runId, at });
      if (joined !== null) swept.push(joined);
    }
  }
  return { swept, refused };
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
  const { unit, at } = request;
  const prepared = await childOutcomes(orchestrator, unit);
  let stored: FillProgressEvent | undefined;
  const result = await writeOrchestration(database, async tx => {
    await lockFillScope(tx, request.runId);
    const current = await readUnitIn(tx, unit.unitId);
    if (current?.state !== 'waiting_children' || current.generation !== unit.generation) return null;
    const sealed = await readSealedChildrenIn(tx, unit.unitId, unit.generation);
    const children: UnitChildOutcome[] = [];
    for (const child of sealed) {
      const record = await readUnitGenerationIn(tx, child.unitId, child.generation);
      const checked = prepared.find(answer => answer.unitId === child.unitId && answer.generation === child.generation);
      const published = record?.state === 'published';
      const failed = record === null || record.state === 'failed' || record.state === 'cancelled' || record.state === 'stale';
      children.push({ unitId: child.unitId, generation: child.generation, published, failed, fresh: published && checked?.published === true && checked.fresh });
    }
    if (children.length === 0) return null;
    const failedChild = children.some(child => child.failed);
    const allSettled = children.every(child => child.failed || (child.published && child.fresh));
    let event: UnitAdvanceEvent;
    let progress: ProgressDraft;
    let outcome: SweptUnit;
    if (failedChild && orchestrator.limits.failedChildPolicy === 'propagate') {
      event = { type: 'fail', at, generation: unit.generation, fence: current.context.fence, cause: 'child-failed' };
      progress = { runId: request.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-failed', summary: `${unit.unitId} failed: a child it waits for failed and the run propagates it` };
      outcome = { unitId: unit.unitId, outcome: 'join-failed', reason: 'a child failed and the policy propagates it' };
    } else if (!allSettled) return null;
    else if (failedChild && orchestrator.limits.failedChildPolicy === 'block') {
      event = { type: 'block', at, generation: unit.generation, fence: current.context.fence, reason: `child-failed: ${children.filter(child => child.failed).map(child => child.unitId).join(', ')}` };
      progress = { runId: request.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-blocked', summary: `${unit.unitId} waits for a resolution: a child failed` };
      outcome = { unitId: unit.unitId, outcome: 'join-failed', reason: 'a child failed and the policy blocks' };
    } else {
      event = { type: 'join', at, generation: unit.generation, children, failedChildPolicy: orchestrator.limits.failedChildPolicy };
      progress = { runId: request.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-joined', summary: `${unit.unitId} joins ${children.length} children and resumes` };
      outcome = { unitId: unit.unitId, outcome: 'join-enqueued', reason: `${children.length} children settled` };
    }
    const step = await advanceUnitIn(tx, { unitId: unit.unitId, event });
    if (!step.ok) return null;
    if (outcome.outcome === 'join-enqueued') await orchestrator.queue.enqueue({ queue: orchestrator.queueName, data: { unitId: unit.unitId, generation: unit.generation }, singletonKey: unit.unitId, transaction: tx });
    stored = await appendProgressIn(tx, progress);
    return outcome;
  });
  if (stored !== undefined) await orchestrator.sink?.(stored);
  return result;
}

// ---------------------------------------------------------------------------------------------
// One attempt: lease, run, draft, validate, publish, or split and wait
// ---------------------------------------------------------------------------------------------

/** What one worker's attempt ended with. */
type WorkResult =
  | 'published' | 'replayed' | 'split' | 'blocked' | 'retried' | 'failed' | 'cancelled'
  | 'nothing-to-do' | 'refused';

/** What `workOnce` answered. */
interface WorkOutcome {
  /** True when a job was claimed and looked at; false when the queue had none. */
  readonly claimed: boolean;
  readonly unitId?: string;
  readonly generation?: number;
  readonly result?: WorkResult;
  readonly summary?: string;
  readonly refusal?: { readonly code: string; readonly reason: string };
  /** What the worker did with its job. */
  readonly job?: 'completed' | 'failed' | 'none';
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
  const claimed = await withSpan('attempt.read', { 'madarch.phase': 'claim' }, async () => await orchestrator.queue.claim<{ unitId: string; generation: number }>({ queue: orchestrator.queueName, limit: 1 }));
  const job = claimed[0];
  if (job === undefined) return { claimed: false, job: 'none' };
  const data = job.data;
  if (data === null || typeof data !== 'object' || typeof data.unitId !== 'string' || !Number.isInteger(data.generation)) {
    await orchestrator.queue.complete(orchestrator.queueName, job, { reason: 'the job carries no unit identity' });
    return { claimed: true, result: 'refused', refusal: { code: 'fill-orchestrator/job-malformed', reason: `fill-orchestrator: the claimed job ${job.id} carries ${JSON.stringify(data)}, which names no unit generation` }, job: 'completed' };
  }
  const unit = await withSpan('attempt.read', { 'madarch.unit': data.unitId, 'madarch.generation': data.generation }, async () => await readUnit(database, data.unitId));
  if (unit === null) {
    await orchestrator.queue.complete(orchestrator.queueName, job, { reason: 'no such unit' });
    return { claimed: true, unitId: data.unitId, generation: data.generation, result: 'nothing-to-do', summary: 'the unit is not recorded', job: 'completed' };
  }
  if (unit.generation !== data.generation) {
    const stored = await writeOrchestration(database, async tx => {
      await lockFillScope(tx, unit.runId);
      const current = await readUnitIn(tx, unit.unitId);
      if (current?.generation === data.generation) return undefined;
      await orchestrator.queue.complete(orchestrator.queueName, job, { reason: 'the generation was replaced' }, tx);
      return await appendProgressIn(tx, { runId: unit.runId, at: orchestrator.clock(), stage: unit.stageId, unitId: unit.unitId, generation: data.generation, kind: 'unit-stale', summary: `job for generation ${data.generation} of ${unit.unitId} found generation ${current?.generation ?? unit.generation} in force` });
    });
    if (stored !== undefined) await orchestrator.sink?.(stored);
    return { claimed: true, unitId: unit.unitId, generation: data.generation, result: 'nothing-to-do', summary: `generation ${data.generation} was replaced by ${unit.generation}`, job: 'completed' };
  }
  const at = orchestrator.clock();
  if (unit.state === 'retry_wait') {
    // The job's own start time is the wait's end; the machine's guard judges the moment, so a claim that
    // arrives early waits for the next one rather than running.
    const step = await advanceUnitWithProgress(orchestrator, { unitId: unit.unitId, event: { type: 'retry', at, generation: unit.generation, cause: wakingCause(unit), retryAt: unit.context.retryAt, fence: null } }, { runId: unit.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-retried', summary: `${unit.unitId} is runnable again` });
    if (!step.ok) {
      // The machine refuses to wake a wait that has not ended, and the job is settled here rather than
      // handed back: the scheduler's own sweep enqueues it again the moment the wait is over, and saying
      // the same thing once is what keeps a claim that arrives early from spinning the run.
      const retryAt = unit.context.retryAt ?? at;
      await orchestrator.queue.complete(orchestrator.queueName, job, { reason: 'the retry wait has not elapsed' });
      return { claimed: true, unitId: unit.unitId, generation: unit.generation, result: 'retried', summary: `the wait ends at ${retryAt}; the run's own sweep enqueues it then`, refusal: { code: step.refusal.code, reason: step.refusal.reason }, job: 'completed' };
    }

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

/**
 * Ends one attempt the unit machine refused a step of: the unit stands where another
 * actor put it — in practice the run's own sweep, which retried a lease that lapsed
 * under this worker while it was still running — and the claim this worker holds is
 * the unit's singleton key in the queue. Leaving that claim unsettled is a run that
 * cannot settle: the sweep's retry enqueue and every later offer the run makes for
 * the unit are answered "nothing created" while the claim stands, so the unit rests
 * with no job a worker can claim and the only thing that frees the key is the
 * queue's own real-time lease. The claim is completed with the machine's own words,
 * which is what the publication's refusal already did, and the run keeps the refusal
 * as its own durable event: a reader sees the step, the reason and what became of
 * the claim. A claim the queue no longer holds is the queue's own maintenance's, and
 * the event says so rather than settling it twice.
 */
async function refusedStep(
  orchestrator: FillOrchestrator,
  request: {
    readonly unit: UnitRecord;
    readonly step: AttemptStep;
    readonly job: ClaimedJob<{ readonly unitId: string; readonly generation: number }>;
    readonly refusal: { readonly code: string; readonly reason: string };
  },
): Promise<WorkOutcome> {
  const unit = request.unit;
  let stored: FillProgressEvent | undefined;
  const settled = await writeOrchestration(orchestrator.database, async tx => {
    await lockFillScope(tx, unit.runId);
    const settled = await orchestrator.queue.complete(orchestrator.queueName, request.job, { reason: request.refusal.reason }, tx);
  stored = await appendProgressIn(tx, {
    runId: unit.runId,
    at: orchestrator.clock(),
    stage: unit.stageId,
    unitId: unit.unitId,
    generation: unit.generation,
    kind: 'unit-refused',
    summary: settled
      ? `${unit.unitId} stopped after the machine refused ${request.step}: ${request.refusal.reason}. Its claim is settled, so the unit's place in the queue is the run's to offer again`
      : `${unit.unitId} stopped after the machine refused ${request.step}: ${request.refusal.reason}. The queue no longer held its claim, so the queue's own maintenance owns it`,
  });
    return settled;
  });
  if (stored !== undefined) await orchestrator.sink?.(stored);
  return { claimed: true, unitId: unit.unitId, generation: unit.generation, result: 'refused', refusal: request.refusal, job: settled ? 'completed' : 'none' };
}

/** The named steps one attempt takes, as the events the machine knows them by. */
type AttemptStep = 'block' | 'wait-for-children';

/** One named step of an attempt: the record the machine answered with, or the settled attempt its refusal ended in. */
type AttemptResult = { readonly ok: true; readonly record: UnitRecord } | { readonly ok: false; readonly outcome: WorkOutcome };

/**
 * Takes one named step of an attempt. A refusal is not an attempt that ends by itself:
 * it settles the claim (see `refusedStep`), which is why every step of an attempt goes
 * through here rather than through the store's `advanceUnit` — a step that is refused
 * and left unsettled holds the unit's singleton key, and no test can tell one such site
 * from another.
 */
async function takeAttemptStep(
  orchestrator: FillOrchestrator,
  request: { readonly unit: UnitRecord; readonly step: AttemptStep; readonly job: ClaimedJob<{ readonly unitId: string; readonly generation: number }>; readonly event: UnitAdvanceEvent; readonly progress: ProgressDraft },
): Promise<AttemptResult> {
  const step = await advanceUnitWithProgress(orchestrator, { unitId: request.unit.unitId, event: request.event }, request.progress, tx => orchestrator.queue.complete(orchestrator.queueName, request.job, { reason: request.progress.summary }, tx));
  if (step.ok) return { ok: true, record: step.record };
  return { ok: false, outcome: await refusedStep(orchestrator, { unit: request.unit, step: request.step, job: request.job, refusal: step.refusal }) };
}

/**
 * Runs one attempt of a ready unit inside the unit's span: the phases below it
 * (execute and complete) are its children, and the result the
 * attempt ended with is the span's own attribute, so the trace says what the
 * unit did without a second record.
 */
async function attemptUnit(
  orchestrator: FillOrchestrator,
  request: { readonly worker: string; readonly job: ClaimedJob<{ unitId: string; generation: number }>; readonly unit: UnitRecord },
): Promise<WorkOutcome> {
  return await withSpan('fill.unit', {
    'madarch.unit': request.unit.unitId,
    'madarch.stage': request.unit.stageId,
    'madarch.generation': request.unit.generation,
    'madarch.attempt': request.unit.context.attempt,
  }, async (span) => {
    const outcome = await attemptUnitPhases(orchestrator, request);
    span.setAttribute('madarch.outcome', outcome.result ?? 'none');
    span.setAttribute('madarch.retriesLeft', request.unit.context.retriesLeft);
    if (outcome.summary !== undefined) span.setAttribute('madarch.reason', outcome.summary);
    if (outcome.refusal !== undefined) span.setAttribute('madarch.refusal', outcome.refusal.reason);
    return outcome;
  });
}

type StageThrow =
  | { readonly kind: 'blocked'; readonly reason: string }
  | { readonly kind: 'bound'; readonly bound: string; readonly message: string }
  | { readonly kind: 'stale'; readonly message: string }
  | { readonly kind: 'raised'; readonly thrown: unknown; readonly text: string };

/** Only this boundary reads a stage's thrown value; its callers use the classified strings. */
function classifyStageThrow(thrown: unknown): StageThrow {
  try {
    if (thrown instanceof ClosureRefusal) {
      const code: unknown = thrown.code;
      const message: unknown = thrown.message;
      if (code === 'plugin-tool' && typeof message === 'string') return { kind: 'blocked', reason: message };
    } else if (thrown instanceof UnitBoundStop) {
      const bound: unknown = thrown.bound;
      const message: unknown = thrown.message;
      if (typeof bound === 'string' && typeof message === 'string') return { kind: 'bound', bound, message };
    } else if (thrown instanceof AttemptStaleError) {
      const message: unknown = thrown.message;
      if (typeof message === 'string') return { kind: 'stale', message };
    }
  } catch {
    // A hostile prototype or getter is an ordinary stage failure, not a replacement error.
  }
  return { kind: 'raised', thrown, text: errorText(thrown) };
}

/** One attempt's phases, each its own span, under the unit's span. */
async function attemptUnitPhases(
  orchestrator: FillOrchestrator,
  request: { readonly worker: string; readonly job: ClaimedJob<{ unitId: string; generation: number }>; readonly unit: UnitRecord },
): Promise<WorkOutcome> {
  const database = orchestrator.database;
  const unit = request.unit;
  const stage = stageOf(orchestrator, unit.stageId);
  let plan!: UnitPlanRecord;
  const at = orchestrator.clock();
  // The queue's own answer first, before this attempt takes anything: a claim the queue already handed to
  // another worker must not leave a lease, a start or a spent retry behind it.
  if (!(await orchestrator.queue.heartbeat(orchestrator.queueName, request.job))) {
    return await claimLapsed(orchestrator, unit, request.job, `before attempt ${unit.context.attempt + 1} ran, so the attempt spends nothing`);
  }
  const fence=request.job.attempt;
  let startEvents: readonly FillProgressEvent[] = [];
  const started = await writeOrchestration(database, async tx => {
    try {
      return await fencedAttemptStart(orchestrator.queue, request.job, tx, async () => {
        await lockFillScope(tx, unit.runId);
        const step = await advanceUnitIn(tx, { unitId: unit.unitId, event: { type: 'start', at, generation: unit.generation, fence } });
        if (step.ok) {
          const recorded = await unitPlanIn(tx, unit.unitId, unit.generation);
          if (recorded === null) raise(`no plan for ${unit.unitId}/${unit.generation}`);
          plan = recorded;
          startEvents = await appendProgressBatchIn(tx, [
            { runId: unit.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-started', summary: `${unit.unitId} runs queue attempt ${request.job.attempt} for ${request.worker}` },
            { runId: unit.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-started', summary: `${unit.unitId} attempt ${request.job.attempt} runs under fence ${fence}` },
          ]);
        }
        return step;
      });
    } catch (error) {
      if (error instanceof AttemptStaleError) return error;
      throw error;
    }
  });
  if (started instanceof AttemptStaleError) return await claimLapsed(orchestrator, unit, request.job, started.message);
  if (!started.ok) {
    await orchestrator.queue.complete(orchestrator.queueName, request.job, { reason: `the start was refused: ${started.refusal.reason}` });
    return { claimed: true, unitId: unit.unitId, generation: unit.generation, result: 'refused', refusal: { code: started.refusal.code, reason: started.refusal.reason }, job: 'completed' };
  }
  const controller = new AbortController();
  let terminalWritten = false;
  let attemptRaised = false;
  let heartbeatFailure: { error: unknown } | undefined;
  let touching: Promise<void> | undefined;
  const touch = setInterval(() => {
    if (touching !== undefined) return;
    touching = orchestrator.queue.heartbeat(orchestrator.queueName, request.job).then(alive => {
      if (!alive) controller.abort();
    }).catch(error => { heartbeatFailure ??= { error }; controller.abort(); }).finally(() => { touching = undefined; });
  }, orchestrator.limits.heartbeatSeconds * 1000 / 3);
  touch.unref?.();
  try {
    for (const event of startEvents) await orchestrator.sink?.(event);

    let producerOutcome:import('./producer-outcomes.js').ProducerOutcomeDraft|undefined;
    const notes: { note: string; fraction: number | null; at: number }[] = [];
    const reader = await orchestrator.graph(unitRef(unit, plan));
    // 0026's per-unit MCP server: the stage's units that declare they read and write through one are handed the
    // server a host opened for this generation, bound to this queue attempt, and the attempt closes it
    // whatever it ends with.
    // The graph this attempt's stage reads through: every read is recorded as the generation's dependency, and the
    // same reader serves the stage's own reads and its `validate`, so nothing reads the graph unrecorded.
    type PendingRead = {
      read: Parameters<typeof recordUnitReads>[1][number];
      event: Parameters<typeof appendProgresses>[1][number];
      resolve: () => void;
      reject: (error: unknown) => void;
    };
    let pendingReads: PendingRead[] = [];
    let flushingReads = false;
    let scheduledReads = false;
    let activeFlush: Promise<void> | undefined;
    const flushReads = (): Promise<void> => {
      if (activeFlush !== undefined) return activeFlush;
      activeFlush = flushReadBatch().finally(() => { activeFlush = undefined; });
      return activeFlush;
    };
    const flushReadBatch = async (): Promise<void> => {
      scheduledReads = false;
      flushingReads = true;
      try {
        while (pendingReads.length > 0) {
          const batch = pendingReads;
          pendingReads = [];
          let stored: Awaited<ReturnType<typeof appendProgresses>>;
          try {
            stored = await writeOrchestration(database, async tx => {
              await lockFillScope(tx, unit.runId);
              const current = await readUnitIn(tx, unit.unitId);
              if (current?.generation !== unit.generation || current.context.fence !== fence || current.state !== 'running') throw new AttemptStaleError('tracked read belongs to an obsolete attempt');
              await recordUnitReadBatchIn(tx, batch.map(entry => entry.read));
              return await appendProgressBatchIn(tx, batch.map(entry => entry.event));
            });
          } catch (error) {
            for (const entry of batch) entry.reject(error);
            continue;
          }
          for (const [index, entry] of batch.entries()) {
            try {
              if (orchestrator.sink !== undefined) await orchestrator.sink(stored[index]!);
              entry.resolve();
            } catch (error) {
              entry.reject(error);
            }
          }
        }
      } finally {
        flushingReads = false;
      }
    };
    const trackedReader = (): { graph: StageGraphReader; close: () => Promise<void> } => {
      let closed = false;
      const active = new Set<Promise<readonly unknown[]>>();
      const query = async (text: string): Promise<readonly unknown[]> => {
        if (closed) throw new Error('the attempt graph reader is closed');
        const rows = await withSpan('graph.orchestrator.trackedReader', {}, async () => await reader.query(text));
        if (closed) throw new Error('the attempt graph reader is closed');
        const read = { unitId: unit.unitId, generation: unit.generation, query: recordedReadText(text), rows, membership: answerMembership(text, rows), at: orchestrator.clock() };
        const event = { runId: unit.runId, at: orchestrator.clock(), stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-read' as const, summary: `${unit.unitId} read "${text}" and answered ${rows.length} ${rows.length === 1 ? 'row' : 'rows'}` };
        await new Promise<void>((resolve, reject) => {
          pendingReads.push({ read, event, resolve, reject });
          if (!flushingReads && !scheduledReads) {
            scheduledReads = true;
            setImmediate(() => { void flushReads(); });
          }
        });
        return rows;
      };
      return {
        graph: { query: (text: string) => {
          const pending = withSpan('graph.orchestrator.trackedReader', {}, async () => await query(text));
          active.add(pending);
          void pending.then(() => active.delete(pending), () => active.delete(pending));
          return pending;
        } },
        close: async () => {
          closed = true;
          await flushReads();
          await Promise.allSettled([...active]);
        },
      };
    };
    const executionReader = trackedReader();
    const attemptReader = executionReader.graph;
    // Everything the attempt opens — its authority, the unit's tools, its progress notes — is opened inside one try:
    // resolving the stage's configuration can refuse (a configuration that moved mid-run, a stage the graph does not
    // hold), and a refusal there must leave neither an authority entry behind it nor a unit's tool session open.
    let tools: StageUnitTools | undefined;
    let context: StageContext | undefined;
    let result: StageExecutionResult | undefined;
    let failure: StageThrow | undefined;
    try {
      const config = stageConfiguration(await currentGraph(orchestrator, unit.runId), unit.stageId);
      orchestrator.authority.set(authorityKey(unit.unitId, unit.generation), controller);
      tools = stage.usesTools === true && orchestrator.unitTools !== undefined
        ? await orchestrator.unitTools({ unit, plan })
        : undefined;
      // The sealed set this generation holds, when it holds one: a unit that split and
      // was joined finds its sealed children here (decision 0027), which is how the
      // attempt that follows its join knows to build on them rather than seal them
      // again — the store's own answer, read once per attempt, and no graph read that
      // a child's publication could move.
      const sealedChildren = await readSealedChildren(database, unit.unitId, unit.generation);
      const immediate = await orchestrator.operations.open({unit,plan,job:request.job,queue:orchestrator.queue});
      context = {
        ...{operationSourceUid:immediate.sourceUid,operationUnitUid:immediate.unitUid,executeOperation:<Result>(key:string,request:unknown,apply:(tx:import('../history-types.js').OuterTransaction)=>Promise<Result>,preconditions?:readonly {uid:string;recordedSequence:string}[])=>immediate.host.execute({key,request,...(preconditions===undefined?{}:{preconditions})},apply)},
        completeOutcome:outcome=>{producerOutcome=outcome;},
        runId: unit.runId,
        unit: { id: plan.stageUnitId, scope: plan.scope },
        ...(tools === undefined ? {} : { tools }),
        config,
        graph: attemptReader,
        ...(sealedChildren.length === 0 ? {} : { sealedChildren }),
        // A stage reports its progress synchronously; the notes are kept in order and written as the run's
        // own durable events the moment the attempt ends, so a lost write is an error rather than a silence.
        progress: (note: string, fraction?: number) => {
          notes.push({ note, fraction: fraction ?? null, at: orchestrator.clock() });
        },
        signal: controller.signal,
      };
      result = await withSpan('attempt.execute', { 'madarch.unit': unit.unitId, 'madarch.stage': unit.stageId }, async (executeSpan) => {
        const answered = await stage.execute({ id: plan.stageUnitId, scope: plan.scope }, context as StageContext);
        executeSpan.setAttribute('madarch.outcome', answered.outcome);
        return answered;
      });
    } catch (error) {
      failure = classifyStageThrow(error);
      if (failure.kind === 'blocked') result = { outcome: 'blocked', reason: failure.reason };
    } finally {
      await executionReader.close();
      tools?.close();
      orchestrator.authority.delete(authorityKey(unit.unitId, unit.generation));
      // What the stage reported is the run's own durable progress, written whether the unit finished or
      // raised: a lost write is an error here, never a silence.
      for (const note of notes) {
        await emit(orchestrator, { runId: unit.runId, at: note.at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-progress', summary: note.fraction === null ? note.note : `${note.note} (${Math.round(note.fraction * 100)}%)` });
      }
    }
    if (heartbeatFailure !== undefined) {
      if (failure?.kind === 'raised') throw new AggregateError([failure.thrown, heartbeatFailure.error], `the stage raised: ${failure.text}; heartbeat failed`);
      throw heartbeatFailure.error;
    }
    // A unit a bound of its own run stopped fails here, with that reason: another attempt meets the same bound, and a retry
    // loop that only waits out the wall is no work at all (owner's decision, 2026-11-15).
    if (failure?.kind === 'bound') {
      const bound = failure;
      const at=orchestrator.clock();
      const operation=await orchestrator.operations.open({unit,plan,job:request.job,queue:orchestrator.queue});
      let failedEvent: FillProgressEvent | undefined;
      const failed=await operation.host.fail(bound.message,async(tx,writeContext)=>{
        const step=await advanceUnitIn(tx,{unitId:unit.unitId,event:{type:'fail',at,generation:unit.generation,fence,cause:'bound-exhausted'}},writeContext);
        if(!step.ok)throw new Error(`${new URL(import.meta.url).pathname}:1660: FAILURE_CONFLICT ${step.refusal.reason}`);
        failedEvent=await appendProgressIn(tx,{runId:unit.runId,at,stage:unit.stageId,unitId:unit.unitId,generation:unit.generation,kind:'unit-failed',summary:`${unit.unitId} was stopped by its ${bound.bound} bound and is not retried: ${bound.message}`});
      });
      if (!failed) return await claimLapsed(orchestrator, unit, request.job, bound.message);
      terminalWritten = true;
      if(failedEvent!==undefined)await orchestrator.sink?.(failedEvent);
      return {claimed:true,unitId:unit.unitId,generation:unit.generation,result:'failed',summary:bound.message,job:'failed'};
    }
    if (failure?.kind === 'stale') return await claimLapsed(orchestrator, unit, request.job, failure.message);
    if (failure?.kind === 'raised' || result === undefined) {
      const text = failure?.kind === 'raised' ? failure.text : 'it answered nothing';
      const retried = await retryAttempt(orchestrator, { unit: started.record, fence, job: request.job, cause: 'transient-failure', reason: `the stage raised: ${text}`, summary: `${unit.unitId} raised: ${text}` });
      terminalWritten = retried.job !== 'none';
      return retried;
    }

    if (result.outcome === 'blocked') {
      const blocked = await takeAttemptStep(orchestrator, { unit, step: 'block', job: request.job, event: { type: 'block', at: orchestrator.clock(), generation: unit.generation, fence, reason: result.reason }, progress: { runId: unit.runId, at: orchestrator.clock(), stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-blocked', summary: `${unit.unitId} is blocked: ${result.reason}` } });
      if (!blocked.ok) {
        terminalWritten = blocked.outcome.job !== 'none';
        return blocked.outcome;
      }
      terminalWritten = true;

      return { claimed: true, unitId: unit.unitId, generation: unit.generation, result: 'blocked', summary: result.reason, job: 'completed' };
    }
    if (result.outcome === 'split') {
      const split = await splitAttempt(orchestrator, { unit: started.record, plan, fence, job: request.job, children: result.children });
      terminalWritten = split.job !== 'none';
      return split;
    }

    {
      const immediate=await orchestrator.operations.open({unit,plan,job:request.job,queue:orchestrator.queue});
      const terminal={unitId:unit.unitId,generation:unit.generation};
      let published: FillProgressEvent | undefined;
      try {
        await immediate.host.execute({key:'complete',request:terminal,completion:{output:terminal,enqueue:[],...(producerOutcome===undefined?{}:{outcome:producerOutcome})}},async (tx,writeContext)=>{
          const step=await advanceUnitIn(tx,{unitId:unit.unitId,event:{type:'complete',at:orchestrator.clock(),generation:unit.generation,fence}},writeContext);
          if(!step.ok)throw new Error(`${new URL(import.meta.url).pathname}:1850: TERMINAL_CONFLICT ${step.refusal.reason}`);
          published=await appendProgressIn(tx,{runId:unit.runId,at:orchestrator.clock(),stage:unit.stageId,unitId:unit.unitId,generation:unit.generation,kind:'unit-published',summary:`${unit.unitId} completed; accepted operations remain visible`});
          return {completed:true};
        });
      } catch (error) {
        if (error instanceof AttemptStaleError) return await claimLapsed(orchestrator, unit, request.job, error.message);
        throw error;
      }
      terminalWritten = true;
      if(published!==undefined)await orchestrator.sink?.(published);
      return {claimed:true,unitId:unit.unitId,generation:unit.generation,result:'published',job:'completed'};
    }
  } catch (error) {
    attemptRaised = true;
    throw error;
  } finally {
    clearInterval(touch);
    await touching;
    if (heartbeatFailure !== undefined) {
      if (!terminalWritten && !attemptRaised) throw heartbeatFailure.error;
      annotateSpan({ 'madarch.heartbeatFailure': String(heartbeatFailure.error) });
    }
  }
}

async function claimLapsed(orchestrator: FillOrchestrator, unit: UnitRecord, job: ClaimedJob, stageReason?: string): Promise<WorkOutcome> {
  const refusal = { code: 'fill-orchestrator/claim-lapsed', reason: `fill-orchestrator: the claim of job ${job.id} lapsed during ${unit.unitId}${stageReason === undefined ? '' : `: ${stageReason}`}` };
  await emit(orchestrator, { runId: unit.runId, at: orchestrator.clock(), stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-refused', summary: `${refusal.code}: ${refusal.reason}. The queue no longer held its claim, so the queue's own maintenance owns it` });
  return { claimed: true, unitId: unit.unitId, generation: unit.generation, result: 'refused', refusal, job: 'none' };
}

/** Sends one attempt into a retry wait, or fails the generation when no retry is left. */
async function retryAttempt(
  orchestrator: FillOrchestrator,
  request: { readonly unit: UnitRecord; readonly fence: number; readonly job: ClaimedJob<{ unitId: string; generation: number }>; readonly cause: UnitRetryCause; readonly reason: string; readonly summary: string },
): Promise<WorkOutcome> {
  const unit = request.unit;
  const at = orchestrator.clock();
  const retryAt = at + orchestrator.limits.retryDelayMs;
  const plan=await planOf(orchestrator,unit);
  const operation=await orchestrator.operations.open({unit,plan,job:request.job,queue:orchestrator.queue});
  let stored: FillProgressEvent | undefined;
  if(unit.context.retriesLeft===0){
    const failed=await operation.host.fail(request.reason,async (tx,writeContext)=>{
      const step=await advanceUnitIn(tx,{unitId:unit.unitId,event:{type:'fail',at,generation:unit.generation,fence:request.fence,cause:'retries-exhausted'}},writeContext);
      if(!step.ok)throw new Error(`${new URL(import.meta.url).pathname}:1800: FAILURE_CONFLICT ${step.refusal.reason}`);
      stored=await appendProgressIn(tx,{runId:unit.runId,at,stage:unit.stageId,unitId:unit.unitId,generation:unit.generation,kind:'unit-failed',summary:request.reason});
    });
    if (!failed) return await claimLapsed(orchestrator, unit, request.job, request.reason);
    if(stored!==undefined)await orchestrator.sink?.(stored);
    return {claimed:true,unitId:unit.unitId,generation:unit.generation,result:failed?'failed':'refused',summary:request.reason,job:failed?'failed':'none'};
  }

  try {
    await operation.host.execute({key:`retry:${unit.context.attempt}`,request:{cause:request.cause,reason:request.reason}},async(tx,writeContext)=>{
      const step=await advanceUnitIn(tx,{unitId:unit.unitId,event:{type:'retry',at,generation:unit.generation,cause:request.cause,retryAt,fence:request.fence}},writeContext);
      if(!step.ok)throw new Error(`${new URL(import.meta.url).pathname}:1750: RETRY_CONFLICT ${step.refusal.reason}`);
      stored=await appendProgressIn(tx,{ runId: unit.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-retried', summary: `${request.summary}; the attempt is retried at ${retryAt}` });
      await orchestrator.queue.complete(orchestrator.queueName,request.job,{reason:request.reason},tx);
      await orchestrator.queue.enqueue({queue:orchestrator.queueName,data:{unitId:unit.unitId,generation:unit.generation},singletonKey:unit.unitId,startAfter:new Date(retryAt),transaction:tx});
      return true;
    });
  } catch (error) {
    if (error instanceof AttemptStaleError) return await claimLapsed(orchestrator, unit, request.job, request.reason);
    throw error;
  }
  if(stored!==undefined)await orchestrator.sink?.(stored);
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
    /**
     * The writes the stopping attempt made before it split (0026: "a unit at a limit
     * returns what it has with its coverage"): the parent's checkpoint, recorded in
     * the same transaction that seals the children, so the graph holds what the
     * parent established even though the parent publishes nothing yet.
     */
  },
): Promise<WorkOutcome> {
  const database = orchestrator.database;
  const unit = request.unit;
  const at = orchestrator.clock();
  const refuse = async (reason: string): Promise<WorkOutcome> => {
    // A split that cannot be sealed still records what the stopping attempt wrote — 0026's "a unit at a limit
    // returns what it has with its coverage" — so the graph keeps what the unit established and the block's reason
    // is the only thing left to resolve. It is a draft row of its own generation, replaced by the next attempt's.
    // A blocked step is taken through `takeAttemptStep`: a step the machine refuses settles this worker's claim
    // (madarch's 19.7), so a parent the sweep moved under this attempt leaves no unsettled job behind it.
    const blocked = await takeAttemptStep(orchestrator, { unit, step: 'block', job: request.job, event: { type: 'block', at, generation: unit.generation, fence: request.fence, reason }, progress: { runId: unit.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-blocked', summary: `${unit.unitId} cannot split: ${reason}` } });
    if (!blocked.ok) return blocked.outcome;

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
    const childDigest = canonicalJsonDigest({ inputs: hashFillInputs(await orchestrator.inputs(childRef)), versions: stageCacheVersions(stageOf(orchestrator, unit.stageId)) });
    if (existing.inputsDigest !== childDigest) {
      return await refuse(`the split names "${childUnitId}" as a child, and its generation ${existing.generation} stands on inputs ${existing.inputsDigest}, which are not this split's ${childDigest}`);
    }
  }
  if (request.children.length > orchestrator.limits.maxSplitChildren) {
    return await refuse(`the split names ${request.children.length} children, more than the ${orchestrator.limits.maxSplitChildren} one split may seal`);
  }
  // A parent that already split has settled its children — published, or failed under the run's own policy — and is
  // running again because it joined them: sealing that same set again would re-run settled work and, for a unit that
  // stops at its limit every time, never end. The comparison is against the child ids this generation sealed, never
  // their state, so the failed child of an `accept-partial` run is covered too. A genuinely different split is
  // allowed, because it names children this generation did not seal.
  const sealedBefore = await readSealedChildren(database, unit.unitId, unit.generation);
  if (sealedBefore.length > 0) {
    const sealed = new Set(sealedBefore.map((child) => child.unitId));
    const named = request.children.map((child) => unitIdFor(unit.stageId, child.id));
    if (named.length > 0 && named.every((childUnitId) => sealed.has(childUnitId))) {
      return await refuse(`the split names ${String(named.length)} ${named.length === 1 ? 'child' : 'children'} this generation already sealed (${named.sort(byCodePoint).join(', ')}): a parent whose children settled builds on them rather than sealing them again`);
    }
  }
  const depth = await splitDepth(orchestrator, unit.unitId, unit.generation);
  if (depth + 1 > orchestrator.limits.maxSplitDepth) {
    return await refuse(`the split would nest ${depth + 1} deep, past the ${orchestrator.limits.maxSplitDepth} splits may nest`);
  }
  const work = request.children.reduce((total, child) => total + (child.estimatedTokens ?? 0), 0);
  if (work > orchestrator.limits.maxSplitWork) {
    return await refuse(`the split's children estimate ${work} tokens of work together, past the ${orchestrator.limits.maxSplitWork} one split may seal`);
  }
  const childDigests = await Promise.all(request.children.map(async child => {
    const ref: UnitRef = { stageId: unit.stageId, stageUnitId: child.id, unitId: unitIdFor(unit.stageId, child.id), scope: child.scope, generation: 1 };
    return canonicalJsonDigest({ inputs: hashFillInputs(await orchestrator.inputs(ref)), versions: stageCacheVersions(stageOf(orchestrator, unit.stageId)) });
  }));
  class SplitRefused extends Error {
    constructor(readonly refusal: { readonly code: string; readonly reason: string }) { super(refusal.reason); }
  }
  let splitEvents: readonly FillProgressEvent[] = [];
  const sealed = await ownTransaction(here(), orchestrator, `sealSplit(${unit.unitId}/${unit.generation})`, ['node','edge','assertion'], async (executor) => {
    await lockFillScope(executor, unit.runId);
    const children: { unitId: string; generation: number }[] = [];
    for (const [index, child] of request.children.entries()) {
      const childUnitId = unitIdFor(unit.stageId, child.id);
      const digest = childDigests[index]!;
      const created = await createUnitIn(executor, {
        unitId: childUnitId, product: orchestrator.product, runId: unit.runId, stageId: unit.stageId,
        scopeKey: child.id, inputsDigest: digest, retries: orchestrator.limits.retries, at,
      });
      await recordUnitPlanIn(executor, {
        unitId: childUnitId, generation: created.generation, runId: unit.runId, stageId: unit.stageId,
        stageUnitId: child.id, scope: child.scope, stagePosition: request.plan.stagePosition,
        planPosition: request.plan.planPosition + index, at,
        cacheVersions: stageCacheVersions(stageOf(orchestrator, unit.stageId)),
      });
      children.push({ unitId: childUnitId, generation: created.generation });
    }
    // 0027's split "atomically persist[s] the parent's checkpoint and a sealed child set": the checkpoint is the
    // parent's own step to `waiting_children` and the draft set its attempt wrote before it split. The set is
    // recorded here rather than at a draft step the parent never takes, so a unit that stopped at a limit keeps
    // what it has in the graph — visible as its draft — instead of handing over an empty set.
    await sealSplitIn(executor, { parentUnitId: unit.unitId, parentGeneration: unit.generation, children, at });
    const outcomes: UnitChildOutcome[] = children.map((child) => ({ unitId: child.unitId, generation: child.generation, published: false, fresh: false, failed: false }));
    const step = await advanceUnitIn(executor, {
      unitId: unit.unitId,
      event: { type: 'wait-for-children', at, generation: unit.generation, fence: request.fence, children: outcomes },
    });
    if (!step.ok) throw new SplitRefused(step.refusal);
    if (step.ok) {
      await orchestrator.queue.complete(orchestrator.queueName, request.job, { reason: `suspended for ${children.length} children` }, executor);
      splitEvents = await appendProgressBatchIn(executor, [
        ...children.map(child => ({ runId: unit.runId, at, stage: unit.stageId, unitId: child.unitId, generation: child.generation, kind: 'unit-planned' as const, summary: `sealed ${child.unitId} as a child of ${unit.unitId}` })),
        { runId: unit.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-split', summary: `${unit.unitId} split into ${children.length} children and waits for them` },
      ]);
    }
    return { children, step };
  }).catch(error => {
    if (error instanceof SplitRefused) return error;
    throw error;
  });
  if (sealed instanceof SplitRefused) return await refusedStep(orchestrator, { unit, step: 'wait-for-children', job: request.job, refusal: sealed.refusal });
  for (const event of splitEvents) await orchestrator.sink?.(event);
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

/** How long a live run with no lease at all may stand unchanged before the next start treats its process as gone. */
export const RUN_ORPHAN_AFTER_MS = 5 * 60_000;

/** The pg-boss claim the caller holds while driving a pressed fill. No separate run lease is stored. */
export interface RunClaim {
  readonly queue: string;
  readonly job: ClaimedJob<unknown>;
}

/** Heartbeats only the queue's own claim; stopping the service leaves recovery to pg-boss. */
export function beginRunHeartbeat(orchestrator: FillOrchestrator, runId: string, claim: RunClaim | undefined): void {
  stopHeartbeat(orchestrator);
  if (claim === undefined) return;
  orchestrator.heartbeat.runId = runId;
  const timer = setInterval(() => {
    void orchestrator.queue.heartbeat(claim.queue, claim.job).catch(() => undefined);
  }, 5_000);
  timer.unref?.();
  orchestrator.heartbeat.timer = timer;
}

/** Stops the heartbeat when no run of this orchestrator is live. */
export function stopHeartbeat(orchestrator: { readonly heartbeat?: FillOrchestrator['heartbeat'] }): void {
  const heartbeat = orchestrator.heartbeat;
  if (heartbeat === undefined) return;
  if (heartbeat.timer !== undefined) clearInterval(heartbeat.timer);
  heartbeat.timer = undefined;
  heartbeat.runId = null;
  heartbeat.ownerToken = null;
}

/** Ends the prior attempt only on pg-boss retry proof; direct runs retain the unchanged-state recovery window. */
export async function recoverOrphanedRun(
  orchestrator: FillOrchestrator,
  options: { readonly runId: string; readonly at: number; readonly afterMs?: number; readonly claim?: RunClaim },
): Promise<RunRecord | null> {
  const eligible = (run: RunRecord): boolean => {
    if (isFinalRunState(run.state) || !['created','planning','running','pausing','cancelling'].includes(run.state)) return false;
    const queuedRun = options.claim?.job.data as { readonly runId?: unknown } | undefined;
    return options.claim !== undefined ? queuedRun?.runId === run.runId && options.claim.job.attempt >= 1 : options.at - run.updatedAt >= (options.afterMs ?? RUN_ORPHAN_AFTER_MS);
  };
  const prior = await controlWrite(orchestrator, options.runId, async tx => await readRunIn(tx, options.runId));
  if (!prior || isFinalRunState(prior.state) || !['created','planning','running','pausing','cancelling'].includes(prior.state)) return prior;
  if (!eligible(prior)) return null;
  for (const candidate of await readRunUnits(orchestrator.database, options.runId)) {
    await controlWrite(orchestrator, options.runId, async (tx, events) => {
      const run = await readRunIn(tx, options.runId);
      if (!run || !eligible(run)) return;
      const unit = (await readRunUnitsIn(tx, options.runId)).find(unit => unit.unitId === candidate.unitId && unit.generation === candidate.generation);
      if (!unit || isFinalUnitState(unit.state)) return;
      const at = orchestrator.clock(), cause = 'the process that ran it ended';
      const step = await advanceUnitIn(tx, { unitId: unit.unitId, event: { type: 'skip', at, cause } });
      if (step.ok) events.push(await appendProgressIn(tx, { runId: options.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-skipped', summary: `${unit.unitId} is skipped: ${cause}` }));
    });
  }
  const result = await controlWrite(orchestrator, options.runId, async (tx, events) => {
    const run = await readRunIn(tx, options.runId);
    if (!run || !eligible(run)) return run;
    const failed = await advanceRunIn(tx, { runId: run.runId, event: { type: 'fail', at: options.at, cause: 'process-ended', detail: 'the process that ran it ended' } });
    if (!failed.ok) return run;
    events.push(await appendProgressIn(tx, { runId: run.runId, at: options.at, stage: '', unitId: '', generation: null, kind: 'run-failed', summary: 'the run failed: the process that ran it ended' }));
    return failed.record;
  });
  if (result && isFinalRunState(result.state)) await settleChain(orchestrator, result.runId, await runEvidence(orchestrator, result.runId));
  return result;
}

/**
 * Opens the product's chain of runs and creates one run in it. A chain that
 * never ran starts this run; a quiescent one wakes for it; a chain already
 * following another run is refused, because one product fills one run at a time.
 */
export async function startRun(orchestrator: FillOrchestrator, options: { readonly runId: string; readonly claim?: RunClaim }): Promise<StartedRun | RefusedRunStart> {
  const at = orchestrator.clock();
  // Recovery is made of short locked steps; the final start rereads the chain below.
  const known = await writeOrchestration(orchestrator.database, async tx => await openChainIn(tx, { product: orchestrator.product, at }));
  if (known.context.activeRunId !== null && (known.context.activeRunId !== options.runId || (options.claim?.job.attempt ?? 0) > 0)) {
    await recoverOrphanedRun(orchestrator, { runId: known.context.activeRunId, at, ...(options.claim === undefined ? {} : { claim: options.claim }) });
  }
  return await writeOrchestration(orchestrator.database, async tx => {
    let chain = await openChainIn(tx, { product: orchestrator.product, at });
    const run = await readRunIn(tx, options.runId) ?? await createRunIn(tx, { runId: options.runId, product: orchestrator.product, at });
    await lockFillScope(tx, run.runId);
    if (chain.state === 'active' && chain.context.activeRunId !== run.runId) {
      const held = await readRunIn(tx, chain.context.activeRunId ?? '');
      const heldState = held?.state ?? null;
      if (heldState !== null && !(TERMINAL_RUN_STATES as readonly string[]).includes(heldState)) return { ok: false, code: 'fill-orchestrator/chain-active', reason: `fill-orchestrator: the product "${orchestrator.product}" already runs ${String(chain.context.activeRunId)}, which stands ${heldState}; finish or cancel it before starting ${run.runId}` };
      const freed = await advanceChainIn(tx, { product: orchestrator.product, event: { type: 'settle', at, evidence: { runnable: 0, inFlight: 0, waiting: 0 } } });
      chain = freed.ok ? freed.record : chain;
      if (chain.state !== 'quiescent') return { ok: false, code: 'fill-orchestrator/chain-held', reason: `fill-orchestrator: the product "${orchestrator.product}" holds the chain for ${String(chain.context.activeRunId)}, which stands ${heldState ?? 'in no run this database holds'}: finish or cancel it before starting ${run.runId}` };
    }
    if (chain.state === 'idle' || chain.state === 'quiescent') {
      const step = await advanceChainIn(tx, { product: orchestrator.product, event: { type: chain.state === 'idle' ? 'start' : 'wake', at, runId: run.runId } });
      if (!step.ok) return { ok: false, code: step.refusal.code, reason: step.refusal.reason };
      chain = step.record;
    }
    return { ok: true, run, chain };
  });
}

/**
 * What one run's units say about it, as the run machine's guards read it. A unit
 * that waits for a retry whose moment has come counts as runnable: the next
 * sweep makes it so, and a run is not finished while it waits.
 */
export async function runEvidence(orchestrator: RunControlContext, runId: string, state?: () => Promise<Pick<RunStateSnapshot, 'units' | 'producerOutcomes'>>): Promise<RunEvidence> {
  const snapshot = state === undefined ? undefined : await state();
  const units = snapshot === undefined ? await readRunUnits(orchestrator.database, runId) : snapshot.units;
  // "Runnable" is everything the run still owes work for and the scheduler will put to a worker: the
  // units it may admit now (`planned`), the ones waiting for a worker (`ready`), and the ones waiting for
  // a retry whose moment the clock will bring (`retry_wait`, the moment passed or not) — a run that still
  // has a retry coming has not finished, and one whose retry is not due yet only waits.
  const runnable = units.filter((unit) => unit.state === 'ready' || unit.state === 'planned' || unit.state === 'retry_wait').length;
  const inFlight = countIn(units, ['running']);
  const waiting = countIn(units, ['waiting_children']);
  // Required coverage is what the run planned being covered: no generation of it ended blocked, failed,
  // cancelled or stale. A run that planned nothing because every unit it would plan already stands
  // published has lost nothing, and a stage whose plan found nothing is reported as such separately —
  // the registry's own distinction between "no producer" and "producer found nothing".
  const lostStates: readonly UnitState[] = ['blocked', 'failed', 'cancelled', 'stale', 'skipped'];
  const lost = units.filter((unit) => lostStates.includes(unit.state));
  const outcomes = snapshot?.producerOutcomes ?? await readProducerOutcomes(orchestrator.database, { runId });
  return { runnable, inFlight, waiting, coverageMet: lost.length === 0 && outcomes.every((one) => producerSucceeded(one.outcome)) };
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
/**
 * A run that ended leaves no generation waiting. Every unit the run did not
 * finish becomes skipped, with the failed unit it waited on in its reason; the
 * publication of every unit that did finish stays done.
 */
async function controlWrite<T>(orchestrator: RunControlContext, runId: string, apply: (tx: OwnerTransaction, events: FillProgressEvent[]) => Promise<T>, afterCommit?: (result: T) => void): Promise<T> {
  const events: FillProgressEvent[] = [];
  const result = await writeOrchestration(orchestrator.database, async tx => {
    if (await readRunIn(tx, runId)) await lockFillScope(tx, runId);
    return await apply(tx, events);
  });
  afterCommit?.(result);
  for (const event of events) await orchestrator.sink?.(event);
  return result;
}

async function controlEvidenceIn(tx: SqlExecutor, orchestrator: RunControlContext, runId: string): Promise<RunEvidence> {
  const units = await readRunUnitsIn(tx, runId);
  const producerOutcomes = await readProducerOutcomesIn(tx, { runId });
  return await runEvidence(orchestrator, runId, async () => ({ units, producerOutcomes }));
}

async function skipOutstandingUnits(orchestrator: RunControlContext, run: RunRecord, reason: string, _state?: RunStateReader): Promise<readonly string[]> {
  const units = await readRunUnits(orchestrator.database, run.runId);
  const skipped: string[] = [];
  for (const candidate of units) {
    const changed = await controlWrite(orchestrator, run.runId, async (tx, events) => {
      const currentRun = await readRunIn(tx, run.runId);
      if (!currentRun) return false;
      if (currentRun.state === 'running') {
        const evidence = await controlEvidenceIn(tx, orchestrator, run.runId);
        if (evidence.runnable + evidence.inFlight + evidence.waiting > 0) return false;
      }
      const units = await readRunUnitsIn(tx, run.runId);
      const unit = units.find(unit => unit.unitId === candidate.unitId && unit.generation === candidate.generation);
      if (!unit || isFinalUnitState(unit.state)) return false;
      const failed = units.find(unit => unit.state === 'failed');
      const cause = failed ? `unit ${failed.unitId} failed` : reason;
      const at = orchestrator.clock();
      const step = await advanceUnitIn(tx, { unitId: unit.unitId, event: { type: 'skip', at, cause } });
      if (!step.ok) return false;
      events.push(await appendProgressIn(tx, { runId: run.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-skipped', summary: `${unit.unitId} is skipped: ${cause}` }));
      return true;
    });
    if (changed) skipped.push(candidate.unitId);
  }
  return skipped;
}

async function settleRun(orchestrator: RunControlContext, options: { readonly runId: string }, _state?: RunStateReader): Promise<RunSettleOutcome> {
  const snapshot = _state === undefined ? await readRunStateSnapshot(orchestrator.database, options.runId) : await _state();
  if (!snapshot.run) raise(`no run ${options.runId} is recorded`);
  const pending = { run: snapshot.run, evidence: await runEvidence(orchestrator, options.runId, async () => snapshot) };
  if (pending.run.state === 'running' && pending.evidence.runnable + pending.evidence.inFlight + pending.evidence.waiting === 0) {
    await skipOutstandingUnits(orchestrator, pending.run, pending.evidence.coverageMet ? 'the run succeeded' : 'the run ended partially');
  }
  const result = await controlWrite<RunSettleOutcome>(orchestrator, options.runId, async (tx, events) => {
    const run = await readRunIn(tx, options.runId);
    if (!run) raise(`no run ${options.runId} is recorded`);
    const evidence = await controlEvidenceIn(tx, orchestrator, run.runId);
    if (isFinalRunState(run.state)) return { run, outcome: 'unchanged', evidence };
    const at = orchestrator.clock();
    const nothingOutstanding = evidence.runnable + evidence.inFlight + evidence.waiting === 0;
    let event: Parameters<typeof advanceRunIn>[1]['event'];
    let kind: ProgressKind;
    let summary: string;
    let outcome: 'succeeded' | 'completed-partial' | 'paused' | 'cancelled' | 'blocked' | 'failed' | 'waiting' | 'unchanged';
    if (run.state === 'running' && nothingOutstanding) {
      const published = (await readRunUnitsIn(tx, run.runId)).some(unit => unit.state === 'published');
      const noPublished = !evidence.coverageMet && !published;
      event = evidence.coverageMet ? { type: 'complete', at, evidence } : noPublished ? { type: 'fail', at, cause: 'no-units-published', detail: 'the run published no unit' } : { type: 'complete-partial', at, evidence };
      kind = evidence.coverageMet ? 'run-completed' : noPublished ? 'run-failed' : 'run-completed-partial';
      summary = evidence.coverageMet ? 'the run succeeded with its required coverage met' : noPublished ? 'the run failed: no unit published' : 'the run completed partially: some planned work is not covered';
      outcome = evidence.coverageMet ? 'succeeded' : noPublished ? 'failed' : 'completed-partial';
    } else if (run.state === 'pausing' && evidence.inFlight + evidence.waiting === 0) {
      event = { type: 'drain', at, evidence }; kind = 'run-paused'; summary = 'the run paused after its active work drained'; outcome = 'paused';
    } else if (run.state === 'cancelling' && nothingOutstanding) {
      event = { type: 'drained', at, evidence }; kind = 'run-cancelled'; summary = 'the run is cancelled and nothing it planned stands in flight'; outcome = 'cancelled';
    } else return { run, outcome: ['running','pausing','cancelling'].includes(run.state) ? 'waiting' : 'unchanged', evidence };
    const step = await advanceRunIn(tx, { runId: run.runId, event });
    if (!step.ok) return { run, outcome: 'waiting', evidence, refusal: { code: step.refusal.code, reason: step.refusal.reason } };
    if (outcome === 'paused') await orchestrator.operations?.setRunState?.(run.runId, 'paused', tx);
    events.push(await appendProgressIn(tx, { runId: run.runId, at, stage: '', unitId: '', generation: null, kind, summary }));
    return { run: step.record, outcome, evidence };
  });
  if (isFinalRunState(result.run.state)) {
    stopHeartbeat(orchestrator);
    await skipOutstandingUnits(orchestrator, result.run, `the run ended ${runPhaseOf(result.run.state)}`);
    await settleChain(orchestrator, result.run.runId, result.evidence);
  }
  return result;
}

/** Settles the product's chain to quiescent once its run finished and nothing is outstanding. */
async function settleChain(orchestrator: RunControlContext, runId: string, _evidence: RunEvidence): Promise<void> {
  await controlWrite(orchestrator, runId, async tx => {
    const chain = await readChainRecordIn(tx, orchestrator.product);
    const run = await readRunIn(tx, runId);
    if (!chain || chain.state !== 'active' || chain.context.activeRunId !== runId || !run || !isFinalRunState(run.state)) return;
    const evidence = await controlEvidenceIn(tx, orchestrator, runId);
    await advanceChainIn(tx, { product: orchestrator.product, event: { type: 'settle', at: orchestrator.clock(), evidence } });
  });
}

/** Durable cancellation and settlement need no registry, source, queue or executor. */
export type RunControlContext = Pick<FillOrchestrator, 'database' | 'product' | 'clock' | 'authority' | 'sink'> & {readonly operations:Pick<UnitOperations,'setRunState'>} & { readonly heartbeat?: FillOrchestrator['heartbeat'] };

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
export async function cancelRun(orchestrator: RunControlContext, options: { readonly runId: string; readonly cause: string }): Promise<CancelOutcome> {
  await controlWrite(orchestrator, options.runId, async (tx, events) => {
    const run = await readRunIn(tx, options.runId);
    if (!run) raise(`no run ${options.runId} is recorded`);
    const at = orchestrator.clock();
    const intent = await advanceRunIn(tx, { runId: run.runId, event: { type: 'cancel', at, cause: options.cause } });
    if (!intent.ok) raise(`run "${run.runId}" cannot be cancelled from ${run.state}: ${intent.refusal.reason}`);
    await orchestrator.operations?.setRunState?.(run.runId, 'cancelled', tx);
    events.push(await appendProgressIn(tx, { runId: run.runId, at, stage: '', unitId: '', generation: null, kind: 'run-cancelling', summary: `the run is cancelling: ${options.cause}` }));
  });
  const cancelledUnits: string[] = [];
  const refused: UnitRefusal[] = [];
  for (const candidate of await readRunUnits(orchestrator.database, options.runId)) {
    const result = await controlWrite(orchestrator, options.runId, async (tx, events) => {
      const unit = (await readRunUnitsIn(tx, options.runId)).find(unit => unit.unitId === candidate.unitId && unit.generation === candidate.generation);
      if (!unit || !LIVE_STATES.includes(unit.state)) return null;
      const at = orchestrator.clock();
      const step = await advanceUnitIn(tx, { unitId: unit.unitId, event: { type: 'cancel', at, cause: options.cause } });
      if (step.ok) events.push(await appendProgressIn(tx, { runId: options.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-cancelled', summary: `${unit.unitId} is cancelled: ${options.cause}` }));
      return step;
    }, step => {
      if (step?.ok) orchestrator.authority.get(authorityKey(candidate.unitId, candidate.generation))?.abort();
    });
    if (!result) continue;
    if (!result.ok) { refused.push({ unitId: candidate.unitId, code: result.refusal.code, reason: result.refusal.reason }); continue; }
    cancelledUnits.push(candidate.unitId);
  }
  const settlement = await settleRun(orchestrator, { runId: options.runId });
  return { run: settlement.run, cancelledUnits, refused, settlement };
}

/** Asks one run to pause: it admits nothing new and is paused once its work drains. */
export async function pauseRun(orchestrator: FillOrchestrator, options: { readonly runId: string }): Promise<RunSettleOutcome> {
  await controlWrite(orchestrator, options.runId, async (tx, events) => {
    const run = await readRunIn(tx, options.runId);
    if (!run) raise(`no run ${options.runId} is recorded`);
    if (run.state !== 'running') return;
    const at = orchestrator.clock();
    const intent = await advanceRunIn(tx, { runId: run.runId, event: { type: 'pause', at } });
    if (!intent.ok) raise(`run "${run.runId}" cannot pause from ${run.state}: ${intent.refusal.reason}`);
    await orchestrator.operations?.setRunState?.(run.runId, 'paused', tx);
    events.push(await appendProgressIn(tx, { runId: run.runId, at, stage: '', unitId: '', generation: null, kind: 'run-paused', summary: 'the run admits no new work and waits for what runs to drain' }));
  });
  return await settleRun(orchestrator, options);
}

/** Resumes a paused run: it opens the next planning epoch, and the caller plans it again. */
export async function resumeRun(orchestrator: FillOrchestrator, options: { readonly runId: string }): Promise<RunRecord> {
  return await controlWrite(orchestrator, options.runId, async (tx, events) => {
    const run = await readRunIn(tx, options.runId);
    if (!run) raise(`no run ${options.runId} is recorded`);
    const at = orchestrator.clock();
    const resumed = await advanceRunIn(tx, { runId: run.runId, event: { type: 'resume', at } });
    if (!resumed.ok) raise(`run "${run.runId}" cannot resume from ${run.state}: ${resumed.refusal.reason}`);
    await orchestrator.operations?.setRunState?.(run.runId, 'running', tx);
    events.push(await appendProgressIn(tx, { runId: run.runId, at, stage: '', unitId: '', generation: null, kind: 'run-resumed', summary: 'the run resumes and replans' }));
    return resumed.record;
  });
}


/** Blocks one run with the starvation path that stopped it. */
async function blockRun(orchestrator: FillOrchestrator, options: { readonly runId: string; readonly reason: string }): Promise<RunSettleOutcome> {
  const result = await controlWrite<RunSettleOutcome>(orchestrator, options.runId, async (tx, events) => {
    const run = await readRunIn(tx, options.runId);
    if (!run) raise(`no run ${options.runId} is recorded`);
    const evidence = await controlEvidenceIn(tx, orchestrator, run.runId);
    const at = orchestrator.clock();
    const step = await advanceRunIn(tx, { runId: run.runId, event: { type: 'block', at, starvationPath: options.reason } });
    if (!step.ok) return { run, outcome: 'unchanged', evidence, refusal: { code: step.refusal.code, reason: step.refusal.reason } };
    events.push(await appendProgressIn(tx, { runId: run.runId, at, stage: '', unitId: '', generation: null, kind: 'run-blocked', summary: `the run is blocked: ${options.reason}` }));
    return { run: step.record, outcome: 'blocked', evidence };
  });
  if (result.outcome === 'blocked') {
    await skipOutstandingUnits(orchestrator, result.run, `the run is blocked: ${options.reason}`);
    await settleChain(orchestrator, result.run.runId, result.evidence);
  }
  return result;
}


/** One named step the machine refused on one unit generation, with the machine's own words. */
interface UnitRefusal {
  readonly unitId: string;
  readonly code: string;
  readonly reason: string;
}

/** One generation the sweep found stale, with what moved. */
interface StaleUnit {
  readonly unitId: string;
  readonly generation: number;
  readonly replacement: number;
  readonly cause: string;
}

/**
 * Marks what moved, and opens the generation that replaces it — the run's own units, and the product's
 * published generations this run did not plan (decision 0026, "Updates").
 *
 * The run's own units are swept as they were: a generation whose named inputs and versions no longer
 * hash the same, or a published generation whose recorded reads no longer answer the same — an empty
 * read that became non-empty included, a span's bytes at the run's own pin included — is invalidated
 * and its replacement generation opened.
 *
 * **A commit propagates over the graph's edges.** The stages that published in this run moved the facts
 * they produce; a published generation of another run whose stage consumes one of those kinds stands for
 * facts that may have moved under it, so it is rechecked by the same cache key and, where the key moved,
 * replaced into this run — which is what makes an update rerun exactly the units a change reaches. A
 * generation whose stage this run does not run is left as its record: a stage a product disabled is not
 * work this run owes. A published generation stays an immutable record, marked stale and linked to its
 * replacement.
 */
/** What one staleness sweep did: the generations it replaced, and the steps the machine refused. */
interface StaleSweep {
  readonly invalidated: readonly StaleUnit[];
  readonly refused: readonly UnitRefusal[];
}

export async function invalidateStaleUnits(orchestrator: FillOrchestrator, options: { readonly runId: string }, state?: RunStateReader): Promise<StaleSweep> {
  const database = orchestrator.database;
  const at = orchestrator.clock();
  const run = (state === undefined ? await readRun(database, options.runId) : (await state()).run);
  if (run === null) raise(`no run ${options.runId} is recorded`);
  const plans = await runPlans(orchestrator, run.runId);
  const stale: StaleUnit[] = [];
  const refused: UnitRefusal[] = [];
  /** Opens the replacement of one generation the sweep found stale, and records what it replaced. */
  const replace = async (unit: UnitRecord, plan: UnitPlanRecord, digest: string, cause: string): Promise<void> => {
    let stored: FillProgressEvent | undefined;
    const result = await writeOrchestration(database, async tx => {
      await lockFillScope(tx, run.runId);
      const current = await readUnitIn(tx, unit.unitId);
      if (current?.generation !== unit.generation || current.state !== unit.state || current.inputsDigest !== unit.inputsDigest) return null;
      const invalidated = await advanceUnitIn(tx, { unitId: unit.unitId, event: { type: 'invalidate', at, replacement: unit.generation + 1, cause } });
      if (!invalidated.ok) return invalidated;
      const replaced = await replaceStaleGenerationIn(tx, { unitId: unit.unitId, runId: run.runId, inputsDigest: digest, retries: orchestrator.limits.retries, at });
      if (!replaced.ok) raise(`generation ${unit.generation} of "${unit.unitId}" went stale yet its replacement ${unit.generation + 1} was refused: ${replaced.refusal.reason}`);
      await recordUnitPlanIn(tx, {
        unitId: unit.unitId, generation: replaced.record.generation, runId: run.runId, stageId: unit.stageId,
        stageUnitId: plan.stageUnitId, scope: plan.scope, stagePosition: plan.stagePosition, planPosition: plan.planPosition, at,
        cacheVersions: stageCacheVersions(stageOf(orchestrator, unit.stageId)),
      });
      stored = await appendProgressIn(tx, { runId: run.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-stale', summary: `${unit.unitId} went stale (${cause}); generation ${replaced.record.generation} replaces it` });
      return replaced;
    });
    if (stored !== undefined) await orchestrator.sink?.(stored);
    if (result === null) return;
    if (!result.ok) {
      refused.push({ unitId: unit.unitId, code: result.refusal.code, reason: result.refusal.reason });
      return;
    }
    stale.push({ unitId: unit.unitId, generation: unit.generation, replacement: result.record.generation, cause });
  };

  const own = (state === undefined ? await readRunUnits(database, run.runId) : (await state()).units);
  for (const unit of own) {
    if (!LIVE_STATES.includes(unit.state) && unit.state !== 'published') continue;
    const plan = plans.get(unit.unitId);
    if (plan === undefined) continue;
    if (unit.state === 'published') {
      // Every part of the key: the inputs and versions, and every read the publication recorded.
      const verdict = await generationFresh(orchestrator, unit);
      if (verdict.fresh) continue;
      await replace(unit, plan, verdict.digest, verdict.cause);
      continue;
    }
    // A generation an attempt still holds, or one waiting for a retry: its named inputs and the versions decide,
    // because its reads are a previous attempt's and the attempt that runs next reads again.
    const key = await cacheKeyOf(orchestrator, unit, plan);
    if (key.digest === unit.inputsDigest) continue;
    const versions = movedVersions(plan.cacheVersions, key.versions);
    const cause = versions.length > 0
      ? `the versions that decide what it reads and answers moved: ${versions.join(', ')}`
      : `the unit's named inputs moved: ${unit.inputsDigest} is now ${key.digest}`;
    await replace(unit, plan, key.digest, cause);
  }

  // What a commit reaches over the graph's edges: the product's published generations this run did not
  // plan, whose stage consumes a kind the stages that published here produce (`propagatedUnits`).
  for (const { unit, plan } of await propagatedUnits(orchestrator, { runId: run.runId, own })) {
    const verdict = await generationFresh(orchestrator, unit);
    if (verdict.fresh) continue;
    // A generation whose plan row is gone is replaced too, under the plan its unit's own record names:
    // nothing the change reached is skipped in silence, whatever its store holds.
    const resolved = plan ?? {
      unitId: unit.unitId, generation: unit.generation, runId: unit.runId, stageId: unit.stageId,
      stageUnitId: unit.scopeKey, scope: unit.scopeKey, stagePosition: 0, planPosition: 0, plannedAt: unit.updatedAt,
    };
    await replace(unit, resolved, verdict.digest, `the change this run published reached it: ${verdict.cause}`);
  }
  return { invalidated: stale, refused };
}

/**
 * The published generations of the product that this run did not plan and that the change it publishes
 * can reach (decision 0026, "Updates"): each one's stage consumes one of the fact kinds a stage that
 * published a unit in this run produces.
 *
 * That is what "propagates over graph edges" is made of — the declared capabilities are the edges, so a
 * commit reruns the units whose producer moved and no unit of a stage nothing touched. A generation whose
 * stage is not one this run enabled is left out: a stage a product switched off is not work this run owes,
 * and its published facts stay what they are.
 */
async function propagatedUnits(
  orchestrator: FillOrchestrator,
  options: { readonly runId: string; readonly own: readonly UnitRecord[] },
): Promise<readonly { readonly unit: UnitRecord; readonly plan: UnitPlanRecord | null }[]> {
  const graph = await currentGraph(orchestrator, options.runId);
  const enabled = new Set(graph.order);
  const published = await readProductUnits(orchestrator.database, { product: orchestrator.product, state: 'published' });
  const ownIds = new Set(options.own.map((unit) => unit.unitId));
  const candidates = published.filter((unit) => !ownIds.has(unit.unitId) && enabled.has(unit.stageId));
  if (candidates.length === 0) return [];
  // The kinds this run published: the `produces` of every stage whose units stand published in it.
  const movedKinds = new Set<string>();
  for (const stageId of new Set(options.own.filter((unit) => unit.state === 'published').map((unit) => unit.stageId))) {
    for (const produced of stageOf(orchestrator, stageId).produces) movedKinds.add(produced.kind);
  }
  if (movedKinds.size === 0) return [];
  const reached: { unit: UnitRecord; plan: UnitPlanRecord | null }[] = [];
  for (const unit of candidates) {
    const stage = orchestrator.registry.get(unit.stageId);
    if (stage === undefined) continue;
    const consumed = [...stage.consumes.required, ...stage.consumes.optional].map((entry) => entry.capability);
    if (!consumed.some((kind) => movedKinds.has(kind))) continue;
    reached.push({ unit, plan: await readUnitPlan(orchestrator.database, unit.unitId, unit.generation) });
  }
  return reached;
}

/** What the human-edit guard answered for one stage. */
type StageGuardVerdict = 'clean' | 'conflict' | 'nothing-to-guard';

interface StageGuardOutcome {
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
async function guardStage(orchestrator: FillOrchestrator, options: { readonly runId: string; readonly stageId: string }, state?: RunStateReader): Promise<StageGuardOutcome> {
  const guard = orchestrator.guard;
  if (guard === undefined) return { outcome: 'nothing-to-guard', refused: [] };
  const database = orchestrator.database;
  const at = orchestrator.clock();
  const units = ((state === undefined ? await readRunUnits(database, options.runId) : (await state()).units)).filter((unit) => unit.stageId === options.stageId && unit.state === 'published');
  if (units.length === 0) return { outcome: 'nothing-to-guard', refused: [] };
  if ((await guard.check({ stageId: options.stageId, units, at })) === 'clean') return { outcome: 'clean', refused: [] };
  const refused: UnitRefusal[] = [];
  for (const unit of units) {
    const invalidated = await advanceUnitWithProgress(orchestrator, {
      unitId: unit.unitId,
      event: { type: 'invalidate', at, replacement: unit.generation + 1, cause: 'human-edit-wins: the stage was edited by a person' },
    }, { runId: options.runId, at, stage: unit.stageId, unitId: unit.unitId, generation: unit.generation, kind: 'unit-stale', summary: `${unit.unitId} is stale: a person edited the stage, so the published generation is not overwritten` });
    if (!invalidated.ok) {
      refused.push({ unitId: unit.unitId, code: invalidated.refusal.code, reason: invalidated.refusal.reason });
      continue;
    }

  }
  return { outcome: 'conflict', refused };
}

// ---------------------------------------------------------------------------------------------
// One scheduler pass, and the loop a host runs
// ---------------------------------------------------------------------------------------------

/** One part of a scheduler pass whose wall time is measured, and the times of every part. */
type SchedulerPhase = 'read' | 'sweep' | 'evidence' | 'replan' | 'admit' | 'guard' | 'stale' | 'settle';
type SchedulerPhases = Readonly<Record<SchedulerPhase, number>>;

/** What one scheduler pass did. */
interface SchedulerOutcome {
  /** The run as it stands after the pass. */
  readonly run: RunRecord;
  readonly admitted: number;
  readonly swept: number;
  /** The generations the pass found stale and replaced. */
  readonly stale: number;
  readonly settlement: RunSettleOutcome;
  /** Every named step the machine refused in this pass, so nothing is dropped in silence. */
  readonly refused: readonly UnitRefusal[];
  /** True when the pass changed something: a unit was admitted, swept, planned or the run settled. */
  readonly moved: boolean;
  /** The stages the human-edit guard found edited in this pass. */
  readonly guarded: readonly string[];
  /** The units the pass's planning wave inherited (madarch-tzte.26.3), beside `planRun`'s own. */
  readonly reused: readonly string[];
  /** The stages whose plan found a producer's inputs but nothing in them, in this pass's wave. */
  readonly foundNothing: readonly string[];
  /** How many units the run held when the pass began. */
  readonly units: number;
  /** The wall time of the whole pass. */
  readonly ms: number;
  /** The wall time of each part of the pass. */
  readonly phases: SchedulerPhases;
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
  const startedAt = performance.now();
  let marked = startedAt;
  const phases: Record<SchedulerPhase, number> = { read: 0, sweep: 0, evidence: 0, replan: 0, admit: 0, guard: 0, stale: 0, settle: 0 };
  const tick = (phase: SchedulerPhase): void => { const now = performance.now(); phases[phase] += now - marked; marked = now; };
  const elapsed = (): number => performance.now() - startedAt;
  // Reuse decoded records only while the committed graph stamp still stands.
  let cached: RunStateSnapshot | undefined;
  const state: RunStateReader = async () => {
    cached = await readRunStateSnapshot(database, options.runId, cached);
    return cached;
  };
  let run = (await state()).run;
  if (run === null) raise(`no run ${options.runId} is recorded`);

  if (['succeeded', 'completed_partial', 'blocked', 'failed', 'cancelled', 'paused'].includes(run.state)) {
    stopHeartbeat(orchestrator);
    const settlement = await settleRun(orchestrator, { runId: run.runId }, state);
    tick('settle');
    return { run: settlement.run, admitted: 0, swept: 0, stale: 0, settlement, refused: [], moved: false, guarded: [], reused: [], foundNothing: [], units: 0, ms: elapsed(), phases: { ...phases } };
  }
  const control = await orchestrator.control(run.runId);
  if (control === 'stopped') {
    const cancelled = await cancelRun(orchestrator, { runId: run.runId, cause: 'the person stopped the run' });
    tick('read');
    return { run: cancelled.run, admitted: 0, swept: cancelled.cancelledUnits.length, stale: 0, settlement: cancelled.settlement, refused: cancelled.refused, moved: true, guarded: [], reused: [], foundNothing: [], units: 0, ms: elapsed(), phases: { ...phases } };
  }
  if (control === 'paused' && run.state === 'running') {
    const settlement = await pauseRun(orchestrator, { runId: run.runId });
    tick('read');
    return { run: settlement.run, admitted: 0, swept: 0, stale: 0, settlement, refused: [], moved: true, guarded: [], reused: [], foundNothing: [], units: 0, ms: elapsed(), phases: { ...phases } };
  }
  // The run's size, for the pass timing: a count is what tells a pass that costs what it does from one
  // that costs what the run holds. The ordinary graph supplies the run-unit membership.
  const unitsInRun = (await state()).units.length;
  tick('read');

  const swept = await sweepUnits(orchestrator, { runId: run.runId }, state);
  tick('sweep');
  // A stage that planned no unit and whose producers have published since plans
  // here (madarch-tzte.26.3), before the pass admits anything: the units the
  // re-planning names stand in this pass's admission, in the stage order the
  // plan rows record. The run is quiet when the re-planning is due — a plan is
  // answered from the publications of the whole run, not from whichever stage
  // published last — and a run that stands planning is answered whatever it
  // holds, for its epoch is the one a crash between the re-planning step and
  // its planning left open. A run-level refusal stands in the pass's refusals,
  // so nothing is dropped in silence.
  const quiet = (await runEvidence(orchestrator, run.runId, state));
  tick('evidence');
  const wave = quiet.runnable === 0 && quiet.inFlight === 0 && quiet.waiting === 0 || run.state === 'planning'
    ? await replanAfterPublications(orchestrator, { runId: run.runId }, state)
    : { outcome: 'planned' as const, planned: false, run, units: [], reused: [], foundNothing: [] };
  tick('replan');
  const admission = await admitUnits(orchestrator, { runId: run.runId }, state);
  tick('admit');
  const refused: UnitRefusal[] = [
    ...swept.refused,
    ...wave.outcome === 'refused' ? [{ unitId: '', code: wave.code, reason: wave.reason }] : [],
    ...admission.refused,
  ];
  run = admission.run;
  const waveReused = wave.outcome === 'planned' ? wave.reused : [];
  const waveFoundNothing = wave.outcome === 'planned' ? wave.foundNothing : [];

  // A stage whose units are all published passes through the human-edit guard once per process.
  const guarded: string[] = [];
  if (orchestrator.guard !== undefined) {
    const graph = await currentGraph(orchestrator, run.runId);
    const units = (await state()).units;
    for (const stageId of graph.order) {
      const stageUnits = units.filter((unit) => unit.stageId === stageId);
      if (stageUnits.length === 0 || !stageUnits.every((unit) => unit.state === 'published')) continue;
      const key = guardKey(stageId, stageUnits);
      const seen = guardedOutputs.get(orchestrator) ?? new Set<string>();
      guardedOutputs.set(orchestrator, seen);
      if (seen.has(key)) continue;
      seen.add(key);
      const verdict = await guardStage(orchestrator, { runId: run.runId, stageId }, state);
      refused.push(...verdict.refused);
      if (verdict.outcome === 'conflict') {
        guarded.push(stageId);
        const blocked = await blockRun(orchestrator, { runId: run.runId, reason: `human-edit-wins: the published output of stage ${stageId} was edited by a person, and the run waits for that review` });
        tick('guard');
        return { run: blocked.run, admitted: admission.admittedNow, swept: swept.swept.length, stale: 0, settlement: blocked, refused, moved: true, guarded, reused: waveReused, foundNothing: waveFoundNothing, units: unitsInRun, ms: elapsed(), phases: { ...phases } };
      }
    }
  }
  tick('guard');

  // A run that would settle first asks whether what it published still stands: the staleness recheck
  // (a recorded read that moved, an input that moved) runs when nothing else is outstanding, which is
  // the moment its own work is meant to be complete, and its cost is bounded by that.
  const beforeStale = await runEvidence(orchestrator, run.runId, state);
  tick('evidence');
  let stale: StaleSweep = { invalidated: [], refused: [] };
  if (beforeStale.runnable === 0 && beforeStale.inFlight === 0 && beforeStale.waiting === 0) {
    stale = await invalidateStaleUnits(orchestrator, { runId: run.runId }, state);
    refused.push(...stale.refused);
  }
  tick('stale');
  const settlement = await settleRun(orchestrator, { runId: run.runId }, state);
  tick('settle');
  return {
    run: settlement.run,
    admitted: admission.admittedNow,
    swept: swept.swept.length,
    stale: stale.invalidated.length,
    settlement,
    refused,
    moved: admission.admittedNow > 0 || swept.swept.length > 0 || stale.invalidated.length > 0 || (wave.outcome === 'planned' && wave.planned) || (settlement.outcome !== 'waiting' && settlement.outcome !== 'unchanged'),
    guarded,
    reused: waveReused,
    foundNothing: waveFoundNothing,
    units: unitsInRun,
    ms: elapsed(),
    phases: { ...phases },
  };
}

/** The states a run ended in: nothing further happens to it. */
export const TERMINAL_RUN_STATES = FINAL_RUN_STATES;

/**
 * The run states a unit of which a later run may take up again: the run ended and nothing of it is in flight. A
 * `paused` run is not one of them — it is resumed as it was, so its units stay its own.
 */
const ENDED_RUN_STATES: readonly string[] = FINAL_RUN_STATES;

/** What one driven run ended as. */
export interface DriveOutcome {
  readonly run: RunRecord;
  readonly passes: number;
  readonly work: number;
  /** True when the run reached a terminal state; false when the loop ran out of passes or of progress. */
  readonly settled: boolean;
  /** Why the loop stopped, when it stopped without settling the run. */
  readonly stoppedBecause?: string;
  /** The units the run's planning waves inherited (madarch-tzte.26.3), beside `planRun`'s own. */
  readonly reused: readonly string[];
  /** The stages whose plan found a producer's inputs but nothing in them, across the run's waves. */
  readonly foundNothing: readonly string[];
  /** The run-level refusals the passes' re-planning ended on (madarch-tzte.26.3), oldest first. */
  readonly refused: readonly { readonly code: string; readonly reason: string }[];
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
  const reused: string[] = [];
  const foundNothing: string[] = [];
  const refused: { code: string; reason: string }[] = [];
  let run = await readRun(orchestrator.database, options.runId);
  if (run === null) raise(`no run ${options.runId} is recorded`);
  while (passes < maxPasses) {
    passes += 1;
    // One span per pass of the scheduler: what the pass held, what it admitted and swept, and what its claims cost.
    const pass = await withSpan('scheduler.pass', { 'madarch.pass': passes }, async (span) => {
      const held = await schedulerPass(orchestrator, { runId: options.runId });
      span.setAttribute('madarch.units', held.units);
      span.setAttribute('madarch.admitted', held.admitted);
      span.setAttribute('madarch.swept', held.swept);
      span.setAttribute('madarch.state', held.run.state);
      for (const [phase, value] of Object.entries(held.phases)) span.setAttribute(`madarch.phase.${phase}`, Math.round(value));
      return held;
    });
    run = pass.run;
    reused.push(...pass.reused);
    foundNothing.push(...pass.foundNothing);
    // The re-planning's run-level refusals ride out to the caller (madarch-tzte.26.3):
    // a pass records them, the loop collects them, and a run they stopped is the
    // caller's to hear about, not a `planning` state nothing names.
    for (const refusal of pass.refused) {
      if (refusal.unitId === '' && !refused.some((held) => held.code === refusal.code && held.reason === refusal.reason)) refused.push({ code: refusal.code, reason: refusal.reason });
    }
    const workStarted = performance.now();
    let claimedThisPass = 0;
    for (let worker = 0; worker < workers; worker += 1) {
      const outcome = await workOnce(orchestrator, { worker: `worker-${worker + 1}` });
      if (!outcome.claimed) break;
      claimedThisPass += 1;
      work += 1;
    }
    const workMs = performance.now() - workStarted;
    annotateSpan({ 'madarch.claimed': claimedThisPass, 'madarch.workMs': Math.round(workMs) });
    if ((TERMINAL_RUN_STATES as readonly string[]).includes(run.state)) return { run, passes, work, settled: true, reused, foundNothing, refused };
    if (claimedThisPass === 0 && !pass.moved) {
      // A pass that moved nothing while the run still owes work is a run held by a state its own claims cannot
      // reach: name the counts the loop waited on, so the 5 s wait that follows is not a silence.
      await emit(orchestrator, { runId: run.runId, at: orchestrator.clock(), stage: '', unitId: '', generation: null, kind: 'run-waiting', summary: JSON.stringify({ pass: passes, units: pass.units, admitted: pass.admitted, swept: pass.swept, stale: pass.stale, settlement: pass.settlement.outcome, evidence: pass.settlement.evidence }) });
      return { run, passes, work, settled: false, stoppedBecause: 'a pass and its claims together changed nothing', reused, foundNothing, refused };
    }
  }
  return { run, passes, work, settled: false, stoppedBecause: `the run did not finish within ${maxPasses} passes`, reused, foundNothing, refused };
}

/** One run's own status, for a host that reports it: the state, the counts and the events so far. */
export interface RunStatus {
  readonly run: RunRecord;
  readonly evidence: RunEvidence;
  readonly units: readonly {
    readonly unitId: string;
    readonly stageId: string;
    readonly state: UnitState;
    readonly generation: number;
    readonly attempts: number;
    /** The moment a unit standing `retry_wait` is runnable again, in the run's own milliseconds; null for any other state. */
    readonly retryAt: number | null;
  }[];
  readonly chain: ChainRecord | null;
}

/** Answers one run's status without changing anything. */
export async function runStatus(orchestrator: FillOrchestrator, runId: string): Promise<RunStatus | null> {
  const snapshot = await readRunStatusSnapshot(orchestrator.database, runId, orchestrator.product);
  if (snapshot === null) return null;
  const evidence = await runEvidence(orchestrator, runId, async () => snapshot);
  return {
    run: snapshot.run,
    evidence,
    units: snapshot.units.map((unit) => ({ unitId: unit.unitId, stageId: unit.stageId, state: unit.state, generation: unit.generation, attempts: unit.context.attempt, retryAt: unit.state === 'retry_wait' ? unit.context.retryAt : null })),
    chain: snapshot.chain,
  };
}

/** The orchestrator's own tables, so a host can create them beside the state machines'. */
;
