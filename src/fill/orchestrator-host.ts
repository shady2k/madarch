/**
 * The orchestrator a host owns (decision 0027): one service per process that
 * opens the process's one database when a fill is first asked for, creates the
 * fill's tables in it, declares the units' queue, builds the orchestrator over
 * the wiring of the product being filled and drives a run to its end.
 *
 * The one graph (decision 0034) is the fill's only graph. A unit's publication
 * lands what the stage wrote; this step's two record passes publish directly
 * through `src/graph/records.ts` and hand the orchestrator an empty draft set, so
 * the fact application below applies nothing and keeps no second store. pg-boss
 * alone hands out work; the orchestrator keeps generation and fence authority and
 * never dispatches a unit itself.
 */
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createDatabaseOwner, type DatabaseOwner } from '../adapters/database-owner.js';
import { byCodePoint } from '../model/order.js';
import { withSpan } from '../obs/trace.js';
import { readProduct } from '../product/manifest.js';
import { createPgBossQueue } from '../adapters/pg-boss-queue.js';
import { consumeFillControl } from '../product/fill-runtime.js';
import type { FillStageConfigurationRead } from './config.js';
import type { SqlExecutor } from '../sql-driver.js';
import type { FactApplication } from './orchestrator.js';
import {
  DEFAULT_ORCHESTRATOR_LIMITS,
  cancelRun,
  createOrchestrator,
  driveRun,
  pauseRun,
  planRun,
  resumeRun,
  runStatus,
  startRun,
  type FillOrchestrator,
  type HumanEditGuard,
  type OrchestratorLimits,
  type ProgressSink,
  type RunControlReader,
  type RunStatus,
  type UnitGraphReader,
  type UnitRef,
} from './orchestrator.js';
import { createOrchestratorSchema, readProgress, type RunSnapshot } from './orchestrator-store.js';
import type { QueueService } from './queue.js';
import { createFillStateSchema, readChain, readLatestRun, readRun, readRunUnits } from './state-store.js';
import type { StageRegistry } from './registry.js';
import type { SnapshotSource } from './snapshot.js';

/** One product a fill runs for. */
export interface FillProduct {
  readonly name: string;
  readonly folder: string;
}

/** How one product's fill reads and writes. Every field is the caller's; nothing here guesses. */
export interface ProductFillWiring {
  snapshot(): Promise<RunSnapshot> | RunSnapshot;
  configuration(): Promise<FillStageConfigurationRead | undefined> | FillStageConfigurationRead | undefined;
  graph(ref: UnitRef, transaction?: SqlExecutor): Promise<UnitGraphReader> | UnitGraphReader;
  source?(): Promise<SnapshotSource> | SnapshotSource;
  inputs(ref: UnitRef): Promise<Readonly<Record<string, string | Uint8Array>>> | Readonly<Record<string, string | Uint8Array>>;
  guard?: HumanEditGuard;
  /**
   * Where a unit's graph drafts go when its generation publishes (decision 0035, item 6): a stage's vertices and
   * claims are applied inside the publication's own transaction, so a unit publishes with its claims or not at all.
   * A wiring that leaves it out publishes no graph row.
   */
  facts?: FactApplication;
}

interface ProductFill {
  readonly registry: StageRegistry;
  readonly wiring: ProductFillWiring;
}

export interface FillRunRequest {
  readonly product: FillProduct;
  readonly runId: string;
  readonly resume?: boolean;
  readonly workers?: number;
  readonly maxPasses?: number;
}

export interface FillRunResult {
  readonly ok: true;
  readonly runId: string;
  readonly state: string;
  readonly settled: boolean;
  readonly passes: number;
  readonly work: number;
  readonly stoppedBecause?: string;
  readonly units: readonly { readonly unitId: string; readonly stageId: string; readonly state: string; readonly generation: number; readonly attempts: number }[];
  readonly reused: readonly string[];
  readonly retryWaitMs: number;
  readonly foundNothing: readonly string[];
  /** The graph kinds the run's contract declared; absent when the run held no manifest (the whole git contract). */
  readonly declaredKinds?: readonly string[];
}

export interface FillProgressAnswer {
  readonly run: { readonly id: string; readonly status: string; readonly createdAt: string; readonly updatedAt: string; readonly product: string };
  readonly units: readonly { readonly unitId: string; readonly stage: string; readonly status: string; readonly generation: number; readonly attempts: number }[];
  readonly events: readonly { readonly seq: number; readonly at: string; readonly stage: string; readonly unitId: string; readonly type: string; readonly summary: string }[];
}

export interface FillActivity {
  readonly state: 'idle' | 'active' | 'quiescent';
  readonly activeRunId: string | null;
  readonly activeRunState: string | null;
}

export type FillRunControl = 'pause' | 'stop';

export type FillRunControlAnswer =
  | { readonly ok: true; readonly runId: string; readonly state: string }
  | { readonly ok: false; readonly code: string; readonly reason: string };

export interface RefusedFillRun {
  readonly ok: false;
  readonly code: string;
  readonly reason: string;
}

export interface FillOrchestratorService {
  run(request: FillRunRequest): Promise<FillRunResult | RefusedFillRun>;
  status(request: { readonly product: FillProduct; readonly runId: string }): Promise<RunStatus | null>;
  progress(folder: string): Promise<FillProgressAnswer | null>;
  activity(request: { readonly product: FillProduct }): Promise<FillActivity>;
  control(request: { readonly productFolder: string; readonly runId: string; readonly action: FillRunControl; readonly product?: string }): Promise<FillRunControlAnswer | null>;
  stop(): Promise<void>;
}

export interface FillOrchestratorServiceOptions {
  readonly registry: StageRegistry;
  readonly wiring?: (product: FillProduct, context: { readonly owner: DatabaseOwner }) => Promise<ProductFillWiring | ProductFill> | ProductFillWiring | ProductFill;
  readonly owner?: DatabaseOwner;
  readonly databasePath?: string;
  readonly queueName?: string;
  readonly clock?: () => number;
  readonly limits?: Partial<OrchestratorLimits>;
  readonly sink?: ProgressSink;
  readonly log?: (line: string) => void;
  readonly workers?: number;
  readonly maxPasses?: number;
  readonly queueFactory?: (owner: DatabaseOwner) => Promise<QueueService>;
  readonly control?: (product: FillProduct) => RunControlReader;
}

/** The units' queue's name in the process's database. */
const DEFAULT_FILL_QUEUE = 'fill-units';

/** The unit states a run is finished with: nothing waits on them any longer. */
const TERMINAL_UNIT_STATES: readonly string[] = ['published', 'superseded', 'failed', 'cancelled', 'stale'];

/** The most wall-clock time a host spends waiting for a run's own retry moments before it reports the run as it stands. */
const RETRY_WAIT_BUDGET_MS = 60_000;

/** The shortest pause between two drives of a run whose units wait for the queue's own sweep, never a spin. */
const RETRY_POLL_MS = 50;

/** Applies an empty draft set: this step's stages publish through the record store, not a fact store. */
const NO_FACTS: FactApplication = { apply: async () => 0 };

async function driveFor(orchestrator: FillOrchestrator, request: { readonly runId: string; readonly workers?: number; readonly maxPasses?: number }): Promise<Awaited<ReturnType<typeof driveRun>> & { readonly retryWaitMs: number }> {
  let driven = await driveRun(orchestrator, request);
  const startedWaiting = Date.now();
  let waited = 0;
  while (!driven.settled && driven.stoppedBecause === 'a pass and its claims together changed nothing' && Date.now() - startedWaiting < RETRY_WAIT_BUDGET_MS) {
    const status = await runStatus(orchestrator, request.runId);
    const live = status === null ? [] : status.units.filter((unit) => !TERMINAL_UNIT_STATES.includes(unit.state));
    if (live.length === 0) break;
    const due = live.flatMap((unit) => (unit.retryAt === null ? [] : [unit.retryAt]));
    const now = orchestrator.clock();
    const pause = due.length === 0 ? RETRY_POLL_MS : Math.min(orchestrator.limits.retryDelayMs, Math.max(RETRY_POLL_MS, Math.min(...due) - now));
    const before = Date.now();
    await new Promise<void>((resolve) => setTimeout(resolve, pause));
    waited += Math.max(0, Date.now() - before);
    const again = await driveRun(orchestrator, request);
    driven = { ...again, passes: driven.passes + again.passes, work: driven.work + again.work, reused: [...driven.reused, ...again.reused], foundNothing: [...driven.foundNothing, ...again.foundNothing], refused: [...driven.refused, ...again.refused] };
  }
  return { ...driven, retryWaitMs: waited };
}

export async function openFillDatabase(store: string): Promise<DatabaseOwner> {
  return await createDatabaseOwner({ store, btreeGist: true });
}

export async function fillProgressOf(database: DatabaseOwner, product: string): Promise<FillProgressAnswer | null> {
  const latest = await readLatestRun(database, product);
  if (latest === null) return null;
  const units = await readRunUnits(database, latest.runId);
  const events = await readProgress(database, latest.runId);
  return {
    run: { id: latest.runId, status: latest.state, createdAt: new Date(latest.createdAt).toISOString(), updatedAt: new Date(latest.updatedAt).toISOString(), product },
    units: units.map((unit) => ({ unitId: unit.unitId, stage: unit.stageId, status: unit.state, generation: unit.generation, attempts: unit.context.attempt })),
    events: events.map((event) => ({ seq: event.seq, at: new Date(event.at).toISOString(), stage: event.stage, unitId: event.unitId, type: event.kind, summary: event.summary })),
  };
}

export function createFillOrchestratorService(options: FillOrchestratorServiceOptions): FillOrchestratorService {
  const databasePath = options.databasePath;
  const queueName = options.queueName ?? DEFAULT_FILL_QUEUE;
  const limits = { ...DEFAULT_ORCHESTRATOR_LIMITS, ...options.limits };
  let opening: Promise<{ owner: DatabaseOwner; queue: QueueService; opened: boolean }> | undefined;
  let stopped = false;

  async function open(): Promise<{ owner: DatabaseOwner; queue: QueueService; opened: boolean }> {
    if (opening !== undefined) return await opening;
    opening = (async () => {
      const lent = options.owner;
      if (lent === undefined) {
        if (databasePath === undefined) throw new Error("fill-orchestrator: this service was given no store: name the product's owner or its database path (src/fill/orchestrator-host.ts)");
        await mkdir(dirname(databasePath), { recursive: true });
      }
      const database = lent ?? await createDatabaseOwner({ store: databasePath!, btreeGist: true });
      await createFillStateSchema(database);
      await createOrchestratorSchema(database);
      const queue = await withSpan('fill.queue', { 'madarch.queue': queueName }, async () => {
        const opened = options.queueFactory !== undefined ? await options.queueFactory(database) : await createPgBossQueue({ owner: database });
        await opened.declare({ name: queueName, leaseSeconds: Math.max(1, Math.ceil(limits.leaseMs / 1000)), retries: 0, retryDelaySeconds: 0, retryBackoff: false, singletons: true });
        return opened;
      });
      return { owner: database, queue, opened: lent === undefined };
    })();
    return await opening;
  }

  async function wiringOf(product: FillProduct): Promise<ProductFill | RefusedFillRun> {
    if (stopped) return { ok: false, code: 'fill-orchestrator/stopped', reason: 'fill-orchestrator: this service was stopped and opens nothing further' };
    if (options.wiring === undefined) return { ok: false, code: 'fill-orchestrator/no-wiring', reason: `fill-orchestrator: nothing wires the fill of "${product.name}": give the service a wiring that reads the product's pinned snapshot, its configuration, the graph its units read, and the inputs their facts stand on` };
    const { owner } = await open();
    const wired = await options.wiring(product, { owner });
    return 'registry' in wired ? wired : { registry: options.registry, wiring: wired };
  }

  const orchestrators = new Map<string, FillOrchestrator>();

  async function orchestratorFor(product: FillProduct): Promise<FillOrchestrator | RefusedFillRun> {
    const held = orchestrators.get(product.name);
    if (held !== undefined) return held;
    const wired = await wiringOf(product);
    if ('ok' in wired) return wired;
    const { wiring, registry } = wired;
    const { owner, queue } = await open();
    const built = createOrchestrator({
      database: owner,
      registry,
      queue,
      queueName,
      product: product.name,
      configuration: () => wiring.configuration(),
      snapshot: () => wiring.snapshot(),
      graph: (ref, transaction) => wiring.graph(ref, transaction),
      inputs: (ref) => wiring.inputs(ref),
      facts: wiring.facts ?? NO_FACTS,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      control: options.control !== undefined ? options.control(product) : async (runId: string) => await consumeFillControl(product.folder, runId),
      ...(wiring.guard === undefined ? {} : { guard: wiring.guard }),
      limits,
      ...(options.log === undefined ? {} : { log: options.log }),
    });
    orchestrators.set(product.name, built);
    return built;
  }

  function productNameOf(folder: string): string {
    const read = readProduct(folder);
    if (!read.ok) throw new Error(`fill-orchestrator: the fill of ${folder} cannot name its product: ${read.message} (${read.file}, line ${read.line})`);
    return read.product.name;
  }

  async function databaseForReads(): Promise<DatabaseOwner | undefined> {
    if (stopped) return undefined;
    if (options.owner === undefined && (databasePath === undefined || existsSync(databasePath) === false)) return undefined;
    return (await open()).owner;
  }

  return {
    async activity(request: { readonly product: FillProduct }): Promise<FillActivity> {
      const database = await databaseForReads();
      if (database === undefined) return { state: 'idle', activeRunId: null, activeRunState: null };
      const chain = await readChain(database, request.product.name);
      if (chain === null) return { state: 'idle', activeRunId: null, activeRunState: null };
      const activeRunId = chain.context.activeRunId ?? null;
      const active = activeRunId === null ? null : await readRun(database, activeRunId);
      return { state: chain.state, activeRunId, activeRunState: active?.state ?? null };
    },
    async control(request: { readonly productFolder: string; readonly runId: string; readonly action: FillRunControl; readonly product?: string }): Promise<FillRunControlAnswer | null> {
      const product: FillProduct = { name: request.product ?? productNameOf(request.productFolder), folder: request.productFolder };
      const built = await orchestratorFor(product);
      if ('ok' in built) return { ok: false, code: built.code, reason: built.reason };
      const status = await runStatus(built, request.runId);
      if (status === null) return null;
      if (request.action === 'pause' && status.run.state !== 'running') return { ok: false, code: 'fill-orchestrator/control-refused', reason: `fill-orchestrator: run "${request.runId}" stands ${status.run.state}, and only a running run takes a pause: nothing was paused` };
      try {
        const settled = request.action === 'pause' ? await pauseRun(built, { runId: request.runId }) : await cancelRun(built, { runId: request.runId, cause: 'stopped from the fill progress panel' });
        return { ok: true, runId: settled.run.runId, state: settled.run.state };
      } catch (error) {
        return { ok: false, code: 'fill-orchestrator/control-refused', reason: (error as Error).message };
      }
    },
    async progress(folder: string): Promise<FillProgressAnswer | null> {
      const database = await databaseForReads();
      if (database === undefined) return null;
      return await fillProgressOf(database, productNameOf(folder));
    },
    async run(request: FillRunRequest): Promise<FillRunResult | RefusedFillRun> {
      if (options.wiring !== undefined && options.owner === undefined && databasePath === undefined) {
        return { ok: false, code: 'fill-orchestrator/no-store', reason: `fill-orchestrator: this service was given no store for ${JSON.stringify(request.product.name)}: name the product's owner or its database path (src/fill/orchestrator-host.ts)` };
      }
      const built = await withSpan('fill.ready', { 'madarch.product': request.product.name }, async () => await orchestratorFor(request.product));
      if ('ok' in built) return built;
      const orchestrator = built;
      if (request.resume === true) await resumeRun(orchestrator, { runId: request.runId });
      const started = await withSpan('fill.start', { 'madarch.run': request.runId }, async () => await startRun(orchestrator, { runId: request.runId }));
      if (!started.ok) return { ok: false, code: started.code, reason: started.reason };
      const planned = await withSpan('fill.plan', { 'madarch.run': request.runId }, async (span) => {
        const held = await planRun(orchestrator, { runId: request.runId });
        span.setAttribute('madarch.outcome', held.outcome);
        return held;
      });
      if (planned.outcome === 'refused') return { ok: false, code: planned.code, reason: planned.reason };
      const driven = await withSpan('fill.drive', { 'madarch.run': request.runId, 'madarch.workers': request.workers ?? options.workers ?? 1 }, async () => await driveFor(orchestrator, {
        runId: request.runId,
        workers: request.workers ?? options.workers ?? 1,
        ...(request.maxPasses === undefined && options.maxPasses === undefined ? {} : { maxPasses: request.maxPasses ?? options.maxPasses }),
      }));
      const status = await runStatus(orchestrator, request.runId);
      if (!driven.settled && driven.refused.length > 0) return { ok: false, code: driven.refused[0]!.code, reason: driven.refused[0]!.reason };
      const reused = [...new Set([...(planned.outcome === 'planned' ? planned.reused : []), ...driven.reused])].sort(byCodePoint);
      const foundNothing = [...new Set([...(planned.outcome === 'planned' ? planned.foundNothing : []), ...driven.foundNothing])].sort(byCodePoint);
      return {
        ok: true, runId: driven.run.runId, state: driven.run.state, settled: driven.settled, passes: driven.passes, work: driven.work,
        retryWaitMs: driven.retryWaitMs,
        ...(driven.stoppedBecause === undefined ? {} : { stoppedBecause: driven.stoppedBecause }),
        units: (status?.units ?? []).map((unit) => ({ unitId: unit.unitId, stageId: unit.stageId, state: unit.state, generation: unit.generation, attempts: unit.attempts })),
        reused, foundNothing,
      };
    },
    async status(request: { readonly product: FillProduct; readonly runId: string }): Promise<RunStatus | null> {
      const built = await orchestratorFor(request.product);
      if ('ok' in built) return null;
      return await runStatus(built, request.runId);
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      orchestrators.clear();
      if (opening === undefined) return;
      const opened = await opening;
      let failure: unknown;
      try { await opened.queue.stop(); } catch (error) { failure ??= error; }
      if (opened.opened) { try { await opened.owner.close(); } catch (error) { failure ??= error; } }
      if (failure !== undefined) throw failure;
    },
  };
}
