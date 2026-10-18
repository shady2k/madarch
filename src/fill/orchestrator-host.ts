/**
 * The orchestrator a host owns (decision 0027, "the background server owns the
 * orchestrator"): one service per process that opens the process's one database
 * when a fill is first asked for, creates the fill's tables in it, declares the
 * units' queue, builds the orchestrator over the wiring of the product being
 * filled and drives a run to its end.
 *
 * Nothing is opened before a run is asked for, so a server that serves wikis
 * pays nothing for a fill nobody started. The service is the server's: the
 * server holds it and stops it, and stopping it stops the queue and closes the
 * database the service opened. A second `run` for the same product reuses what
 * the first one opened.
 *
 * The wiring of one product is the caller's: how its pinned snapshot is read,
 * how its configuration resolves, which graph a unit's tracked reads answer
 * from, which named inputs a unit's facts stand on and where a published fact
 * set lands. A caller that has no wiring yet is refused with exactly what is
 * missing, never served a run that would publish nothing silently.
 */
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../adapters/database-owner.js';
import { createPgBossQueue } from '../adapters/pg-boss-queue.js';
import { consumeFillControl } from '../product/fill-runtime.js';
import type { FillStageConfigurationRead } from './config.js';
import {
  DEFAULT_ORCHESTRATOR_LIMITS,
  createOrchestrator,
  driveRun,
  planRun,
  resumeRun,
  runStatus,
  startRun,
  type FactApplication,
  type FillOrchestrator,
  type HumanEditGuard,
  type OrchestratorLimits,
  type ProgressSink,
  type RunControlReader,
  type RunStatus,
  type UnitGraphReader,
  type UnitRef,
} from './orchestrator.js';
import { createOrchestratorSchema, type RunSnapshot } from './orchestrator-store.js';
import type { QueueService } from './queue.js';
import { createFillStateSchema } from './state-store.js';
import type { StageRegistry } from './registry.js';

/** One product a fill runs for. */
export interface FillProduct {
  /** The product's name, as the manifest and the chain know it. */
  readonly name: string;
  /** The product's folder, where its state and its documents stand. */
  readonly folder: string;
}

/** How one product's fill reads and writes. Every field is the caller's; nothing here guesses. */
export interface ProductFillWiring {
  /** The pinned product snapshot the run stands on (fill-runtime's own shape, kept). */
  snapshot(): Promise<RunSnapshot> | RunSnapshot;
  /** The product's resolved fill configuration, read fresh when a run plans and when it admits. */
  configuration(): Promise<FillStageConfigurationRead | undefined> | FillStageConfigurationRead | undefined;
  /** The pinned graph one unit's tracked reads answer from. */
  graph(ref: UnitRef): Promise<UnitGraphReader> | UnitGraphReader;
  /** The named inputs a unit's facts stand on, hashed with fill-runtime's own hashing. */
  inputs(ref: UnitRef): Promise<Readonly<Record<string, string | Uint8Array>>> | Readonly<Record<string, string | Uint8Array>>;
  /** Where a published fact set lands. */
  facts: FactApplication;
  /** The human-edit guard, where the host has one. */
  guard?: HumanEditGuard;
}

/** What one fill run is asked for. */
export interface FillRunRequest {
  readonly product: FillProduct;
  /** The run's id; the caller names it, so a resume finds the run it means. */
  readonly runId: string;
  /** True to resume a paused run instead of planning a new one. */
  readonly resume?: boolean;
  readonly workers?: number;
  readonly maxPasses?: number;
}

/** What one fill run ended as. */
export interface FillRunResult {
  readonly ok: true;
  readonly runId: string;
  readonly state: string;
  readonly settled: boolean;
  readonly passes: number;
  readonly work: number;
  readonly stoppedBecause?: string;
  readonly units: readonly { readonly unitId: string; readonly stageId: string; readonly state: string; readonly generation: number; readonly attempts: number }[];
  /** The units the run inherited already published with their inputs unchanged: it planned nothing for them. */
  readonly reused: readonly string[];
  /** The enabled stages whose plan found a producer's inputs and nothing in them, so nobody reads it as a capability nothing produces. */
  readonly foundNothing: readonly string[];
}

/** A run the service refused before it started, with what is missing. */
export interface RefusedFillRun {
  readonly ok: false;
  readonly code: string;
  readonly reason: string;
}

/** The orchestrator the background server owns. */
export interface FillOrchestratorService {
  /** Drives one product's fill run to its end, opening the process's database on the first call. */
  run(request: FillRunRequest): Promise<FillRunResult | RefusedFillRun>;
  /** One run's status, or null when no such run is recorded. */
  status(request: { readonly product: FillProduct; readonly runId: string }): Promise<RunStatus | null>;
  /**
   * Stops the queue and closes the database this service opened; safe to call
   * twice and safe to call before anything was opened.
   */
  stop(): Promise<void>;
}

export interface FillOrchestratorServiceOptions {
  /** The products home the process's fill database lives under. */
  readonly home: string;
  /** The declared stages (madarch-tzte.19.3). */
  readonly registry: StageRegistry;
  /** One product's wiring; a service without it refuses every run, naming what is missing. */
  readonly wiring?: (product: FillProduct) => Promise<ProductFillWiring> | ProductFillWiring;
  /**
   * The process's own database owner, when the host already holds one (decision
   * 0027's one owner per process, which is what lets a publication's facts and
   * the orchestrator's record share a transaction): the service borrows it for
   * the fill's tables and the queue and never closes it. Left out, the service
   * opens its own PGlite under the home on the first run asked for and closes it
   * with everything else it opened.
   */
  readonly owner?: DatabaseOwner;
  /** The process's database's data directory; `<home>/.madarch/fill/state.db` when it is left out. */
  readonly databasePath?: string;
  /** The units' queue's name; `fill-units` when it is left out. */
  readonly queueName?: string;
  readonly clock?: () => number;
  readonly limits?: Partial<OrchestratorLimits>;
  readonly sink?: ProgressSink;
  readonly log?: (line: string) => void;
  /** The workers one run drives at once; 1 when it is left out. */
  readonly workers?: number;
  readonly maxPasses?: number;
  /** How the queue is built over the owner; pg-boss when it is left out. */
  readonly queueFactory?: (owner: DatabaseOwner) => Promise<QueueService>;
  /** How the person's pause and stop reach a run; fill-runtime's control file under the product's own state folder when it is left out. */
  readonly control?: (product: FillProduct) => RunControlReader;
}

/** The units' queue's name in the process's database. */
export const DEFAULT_FILL_QUEUE = 'fill-units';

/** Where the process's fill database lives under a products home. */
export function fillDatabasePath(home: string): string {
  return join(home, '.madarch', 'fill', 'state.db');
}

/**
 * Builds the service the background server owns. Nothing is opened here: the
 * owner, the tables and the queue are created when a run is first asked for.
 */
export function createFillOrchestratorService(options: FillOrchestratorServiceOptions): FillOrchestratorService {
  const databasePath = options.databasePath ?? fillDatabasePath(options.home);
  const queueName = options.queueName ?? DEFAULT_FILL_QUEUE;
  const limits = { ...DEFAULT_ORCHESTRATOR_LIMITS, ...options.limits };
  let opening: Promise<{ owner: DatabaseOwner; queue: QueueService; opened: boolean }> | undefined;
  let stopped = false;

  async function open(): Promise<{ owner: DatabaseOwner; queue: QueueService; opened: boolean }> {
    if (opening !== undefined) return await opening;
    opening = (async () => {
      // PGlite opens a data directory, and the state folder it stands in may not be there yet: the
      // process's own folder under the products home is made on the first run asked for.
      const lent = options.owner;
      if (lent === undefined) await mkdir(dirname(databasePath), { recursive: true });
      const database = lent ?? createPGliteDatabaseOwner({ path: databasePath });
      await createFillStateSchema(database);
      await createOrchestratorSchema(database);
      const queue = options.queueFactory !== undefined
        ? await options.queueFactory(database)
        : await createPgBossQueue({ owner: database });
      // The unit's own accounting carries its retries, so the queue retries nothing itself: a settlement
      // here says the attempt is over, and a retry is the orchestrator's own enqueue at its own moment.
      await queue.declare({
        name: queueName,
        leaseSeconds: Math.max(1, Math.ceil(limits.leaseMs / 1000)),
        retries: 0,
        retryDelaySeconds: 0,
        retryBackoff: false,
        singletons: true,
      });
      return { owner: database, queue, opened: lent === undefined };
    })();
    return await opening;
  }

  async function orchestratorFor(product: FillProduct): Promise<FillOrchestrator | RefusedFillRun> {
    if (stopped) return { ok: false, code: 'fill-orchestrator/stopped', reason: 'fill-orchestrator: this service was stopped and opens nothing further' };
    if (options.wiring === undefined) {
      return {
        ok: false,
        code: 'fill-orchestrator/no-wiring',
        reason: `fill-orchestrator: nothing wires the fill of "${product.name}": give the service a wiring that reads the product's pinned snapshot, its configuration, the graph its units read, the inputs their facts stand on and the store a published fact set lands in`,
      };
    }
    const wiring = await options.wiring(product);
    const { owner, queue } = await open();
    return createOrchestrator({
      database: owner,
      registry: options.registry,
      queue,
      queueName,
      product: product.name,
      configuration: () => wiring.configuration(),
      snapshot: () => wiring.snapshot(),
      graph: (ref) => wiring.graph(ref),
      inputs: (ref) => wiring.inputs(ref),
      facts: wiring.facts,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      control: options.control !== undefined ? options.control(product) : async (runId: string) => await consumeFillControl(product.folder, runId),
      ...(wiring.guard === undefined ? {} : { guard: wiring.guard }),
      ...(options.sink === undefined ? {} : { sink: options.sink }),
      limits,
      ...(options.log === undefined ? {} : { log: options.log }),
    });
  }

  return {
    async run(request: FillRunRequest): Promise<FillRunResult | RefusedFillRun> {
      const built = await orchestratorFor(request.product);
      if ('ok' in built) return built;
      const orchestrator = built;
      if (request.resume === true) await resumeRun(orchestrator, { runId: request.runId });
      const started = await startRun(orchestrator, { runId: request.runId });
      if (!started.ok) return { ok: false, code: started.code, reason: started.reason };
      const planned = await planRun(orchestrator, { runId: request.runId });
      if (planned.outcome === 'refused') return { ok: false, code: planned.code, reason: planned.reason };
      const reused = planned.outcome === 'planned' ? planned.reused : [];
      const foundNothing = planned.outcome === 'planned' ? planned.foundNothing : [];
      const driven = await driveRun(orchestrator, {
        runId: request.runId,
        workers: request.workers ?? options.workers ?? 1,
        ...(request.maxPasses === undefined && options.maxPasses === undefined ? {} : { maxPasses: request.maxPasses ?? options.maxPasses }),
      });
      const status = await runStatus(orchestrator, request.runId);
      return {
        ok: true,
        runId: driven.run.runId,
        state: driven.run.state,
        settled: driven.settled,
        passes: driven.passes,
        work: driven.work,
        ...(driven.stoppedBecause === undefined ? {} : { stoppedBecause: driven.stoppedBecause }),
        units: (status?.units ?? []).map((unit) => ({ unitId: unit.unitId, stageId: unit.stageId, state: unit.state, generation: unit.generation, attempts: unit.attempts })),
        reused,
        foundNothing,
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
      if (opening === undefined) return;
      const opened = await opening;
      let failure: unknown;
      try { await opened.queue.stop(); } catch (error) { failure ??= error; }
      // A lent owner is the host's: only an owner this service opened is closed here.
      if (opened.opened) {
        try { await opened.owner.close(); } catch (error) { failure ??= error; }
      }
      if (failure !== undefined) throw failure;
    },
  };
}
