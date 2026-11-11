/**
 * The one fill (madarch-8bdc.2.5, item 6): every caller runs a fill through this
 * function — the wiki's button, `madarch fill`, the daemon, `madarch mcp`, scripts and
 * tests alike.
 *
 * What a caller may choose is a parameter here: the steps of the one list
 * (`steps`, `FILL_STEP_IDS`) and the repository paths the fill covers (`paths`).
 * There is no other code path for a subset — a later "update by commit" or "the files
 * the working tree changed" is this function with other arguments.
 */
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { closeTrace, openTrace, runInTrace, withSpan } from '../obs/trace.js';
import { traceKeepOf } from '../knowledge/settings.js';
import { log } from '../obs/log.js';
import { here } from './fsm-core.js';
import { createFillOrchestratorService, type FillRunResult, type RefusedFillRun } from './orchestrator-host.js';
import type { FillStageConfigurationRead } from './config.js';
import { fillSteps, type RecordPassWiring } from './steps.js';
import { assertFillGitVersion } from './git-version.js';

;
import type { StageRegistry } from './registry.js';
import { createStagesFill, type StagesFillOptions, type UnreadRepository } from '../product/fill-stages.js';
import { publishHistory, publishTree } from '../graph/index.js';

/** What one fill is asked for. */
export interface RunFillOptions {
  /** The owning process prepares the exact pinned contract before any fill client attaches. */
  readonly prepareContract?: (contract: import('../graph/contract.js').GraphContract) => Promise<void>;
  /** The product's folder: its manifest and the repositories it pins. */
  readonly product: string;
  /** The process's one database owner. */
  readonly database: StagesFillOptions['database'];
  /** The steps of the one list to run; the whole list when it is left out. */
  readonly steps?: readonly string[];
  /** The repository paths this fill covers, as prefixes; the whole tree when it is left out. */
  readonly paths?: readonly string[];
  /**
   * The kinds this fill was asked for (madarch-stm0.6, decision 0035 items 11 and 31), in the dependency order to run
   * them in, and with a vertex the one entity it rewrites. Left out, the fill takes every kind as a whole fill does.
   */
  readonly targets?: { readonly kinds: readonly string[]; readonly vertex?: string };
  /** The plugin closures this run trusts beside the release's: a test's fixture, or a person's approval. */
  readonly releaseHashes?: readonly string[];
  /** The run's id; a second press of one moment is one run. */
  readonly runId?: string;
  /** The content language the press named, when it named one: recorded on the run's root span, never a statement. */
  readonly language?: string;
  /**
   * The store the run's trace is kept under (`<store>/traces/<run>.jsonl`); the home
   * folder when it is left out. A fill run always leaves its trace, whether it
   * succeeds or fails.
   */
  readonly store?: string;
  /** The home folder the host keeps its own files under; a temporary folder when it is left out. */
  readonly home?: string;
  readonly clock?: () => number;
  readonly limits?: Parameters<typeof createFillOrchestratorService>[0]['limits'];
  readonly log?: (line: string) => void;
  readonly sink?: Parameters<typeof createFillOrchestratorService>[0]['sink'];
  readonly workers?: number;
  readonly maxPasses?: number;
  /**
   * The service the run is driven by, handed over once it stands: a caller that keeps a
   * person's pause and stop (the wiki's button) needs the handle while the run lasts. The
   * runner stops the service when the run answers, whether it succeeded or not.
   */
  readonly onService?: (service: ReturnType<typeof createFillOrchestratorService>) => void;
  /**
   * Keeps the service open after the run answers, for a caller that reads the run's store
   * through it afterwards (the daemon's progress, control and unit tools). The caller stops
   * it; left out, the runner stops the service when the run answers.
   */
  readonly keepService?: boolean;
}

/** What one fill answered: the host's result, and the repositories it named as unread (a checkout with no commit). */
export type FillRunAnswer =
  | (FillRunResult & {
    /**
     * The declared repositories this run could not read, each with its path and the state it is
     * in. Absent for a run that pinned everything.
     */
    readonly unread?: readonly UnreadRepository[];
  })
  | RefusedFillRun;

/** The record wiring one fill publishes through: the process's one owner, and the paths it covers. */
function recordsOf(options: RunFillOptions): RecordPassWiring {
  return {
    publishTree: (input) => publishTree(options.database, input),
    publishHistory: (input) => publishHistory(options.database, input),
    ...(options.paths === undefined ? {} : { paths: options.paths }),
  };
}

/**
 * One list with the steps a caller did not name disabled: the derived graph plans only
 * the requested steps and what they declare they depend on, and never a step outside
 * the list (a stage that is out of `FILL_STEP_IDS` is not in the registry at all).
 */
function narrowed(wiring: Awaited<ReturnType<typeof createStagesFill>>['wiring'], wanted: ReadonlySet<string>, registry: StageRegistry): Awaited<ReturnType<typeof createStagesFill>>['wiring'] {
  return {
    ...wiring,
    configuration: async (): Promise<FillStageConfigurationRead | undefined> => {
      const held = await wiring.configuration();
      const stages: Record<string, unknown> = Object.create(null);
      if (held !== undefined && !held.ok) return held;
      for (const stage of registry.all()) {
        const own = held?.stages[stage.id];
        const object = own !== null && typeof own === 'object' && !Array.isArray(own) ? own as Record<string, unknown> : undefined;
        stages[stage.id] = object === undefined ? { enabled: wanted.has(stage.id) } : { ...object, enabled: wanted.has(stage.id) && object['enabled'] !== false };
      }
      return held === undefined
        ? { ok: true, file: registry.all()[0]?.id ?? '', stages, lines: {} }
        : { ...held, stages };
    },
  };
}

/**
 * Runs one fill and answers what the host answered. A refused, failed or blocked run is
 * the caller's to report: this function never turns a failure into a smaller success.
 */
export async function runFill(options: RunFillOptions): Promise<FillRunAnswer> {
  // The fill reads git, and the passes use options older versions do not have: a machine's git is named here, before
  // the run stands up, so an older one is refused with the version found and the one needed (item 6).
  assertFillGitVersion();
  const product = resolve(options.product);
  const runId = options.runId ?? `fill-${String(Date.now())}`;
  const store = options.store ?? options.home ?? join(tmpdir(), 'madarch-fill-home');
  const traced = openTrace({ store, runId, keep: traceKeepOf(process.env as Record<string, string | undefined>) });
  const steps = [...(options.steps ?? fillSteps())];
  try {
    return await runInTrace(traced, async () => await withSpan('fill.run', {
      'madarch.run': runId,
      'madarch.product': product,
      'madarch.steps': steps,
      'madarch.workers': options.workers ?? 1,
      ...(options.language === undefined ? {} : { 'madarch.language': options.language }),
    }, async () => {
      log.info('fill started', { runId, product, steps, store });
      const answer = await runFillTraced(options, runId);
      if (answer.ok) log.info('fill ended', { runId, state: answer.state, settled: answer.settled, units: answer.units.length, passes: answer.passes });
      else log.error('fill was refused', { runId, code: answer.code, path: product }, new Error(answer.reason));
      return answer;
    }));
  } catch (error) {
    log.error('fill failed', { file: here(), path: product, runId }, error);
    throw error;
  } finally {
    closeTrace(traced);
  }
}

/** One fill with its run id settled by `runFill`: the work the trace surrounds. */
async function runFillTraced(options: RunFillOptions, runId: string): Promise<FillRunAnswer> {
  const product = resolve(options.product);
  const wanted = new Set(options.steps ?? fillSteps());
  const held = new Set(fillSteps());
  const unknown = [...wanted].filter((step) => !held.has(step));
  if (unknown.length > 0) throw new Error(`runFill: ${unknown.map((step) => JSON.stringify(step)).join(', ')} is not a step of this fill; its steps are ${[...held].sort().join(', ')} (src/fill/run.ts)`);
  const fill = await createStagesFill({ product, database: options.database, ...(options.prepareContract === undefined ? {} : { prepareContract: options.prepareContract }), records: recordsOf(options), ...(options.targets === undefined ? {} : { targets: options.targets }), ...(options.releaseHashes === undefined ? {} : { releaseHashes: options.releaseHashes }) });
  const wiring = fill.registry.all().every((stage) => wanted.has(stage.id)) ? fill.wiring : narrowed(fill.wiring, wanted, fill.registry);
  // Reading the pins is what names a checkout with no commit: the answer says what the run did for
  // it once the run has settled, and a run of this product still reads every other repository.
  await fill.wiring.snapshot();
  const service = createFillOrchestratorService({
    owner: options.database as never,
    registry: fill.registry,
    wiring: () => wiring,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.sink === undefined ? {} : { sink: options.sink }),
    ...(options.workers === undefined ? {} : { workers: options.workers }),
    ...(options.maxPasses === undefined ? {} : { maxPasses: options.maxPasses }),
  });
  options.onService?.(service);
  try {
    const result = await service.run({ product: fill.product, runId });
    const unread = fill.unread();
    // The kinds this run's contract declared, so the store's finish reads only the tables the manifest made.
    const kinds = fill.kinds;
    const declaredKinds = kinds === undefined ? undefined : kinds === false ? [] : [...kinds.vertex, ...kinds.edge];
    const withKind = declaredKinds === undefined ? result : { ...result, declaredKinds };
    if (unread.length === 0) return withKind;
    return withKind.ok ? { ...withKind, unread: [...unread] } : withKind;
  } finally {
    if (options.keepService !== true) await service.stop();
  }
}
