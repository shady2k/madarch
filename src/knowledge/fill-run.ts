import { withSpan, withSpanSync } from '../obs/trace.js';
/**
 * One product's knowledge store, filled by the one orchestrator (decision 0033,
 * item 1): the wiki's fill button and `madarch fill` start the static fill here,
 * over the store the wiki reads, and the pages read the graph this path
 * published.
 *
 * What this module owns is the store's mechanics: the process's one owner of
 * `<store>/graph`, the `madarch/workflows.yaml`-declared stage set the run
 * enables (`createStagesFill`), the run through `createFillOrchestratorService`,
 * the pins of the repositories the run filled, and the person's pause and stop
 * through the run's own state machine. The wiki reads the store this module fills
 * (`--role api`, madarch-8bdc.9): no reader copy and no numbered snapshot stands
 * between the two, and a page's consistency is its own read's transaction.
 *
 * It runs no model and writes no page: a page is an agent's work and a later
 * stage's (decision 0033, items 1 and 2, and the owner's separation of roles: a
 * strong model writes and analyses, a weak model or jev classifies).
 */
import { mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { runFill } from '../fill/run.js';
import { fillIsolation } from '../plugin/sandbox-probe.js';
import type { PluginAgentOptions } from '../plugin/agent.js';
import { configuredPluginAgent } from './agents.js';
import type { DraftEnv } from '../product/home.js';
import { failRequestedFill, readProgress, writeFillEndIfAbsent } from '../graph/fill-orchestration.js';
import type { FillOrchestratorService, RefusedFillRun } from '../fill/orchestrator-host.js';
import { advanceRun, createRun, readChain, readRun } from '../graph/fill-state.js';
import { failAndSettleRun, lastRunActivityAt, RUN_ORPHAN_AFTER_MS, TERMINAL_RUN_STATES, type RunCleanupContext, type RunClaim } from '../fill/orchestrator.js';
import { FILL_RUN_QUEUE, openFillRunQueue } from '../fill/run-jobs.js';
import { listRepositories, repositoryFacts } from '../graph/index.js';
import { readPinnedGraphContract } from '../product/preparation-contract.js';
import { withAssertionContract } from '../graph/system-contract.js';
import type { FillStateDatabase } from '../graph/fill-state.js';
import { readProduct } from '../product/manifest.js';

/** A run that failed before its host began is ended where the run's end lives (`graph/fill-orchestration.ts`). */
export { failRequestedFill };


/**
 * The refusals that mean a fill of this product already runs, and nothing is wrong with the product (madarch-8bdc.2.18):
 * the chain of runs follows a live run (`fill-orchestrator/chain-active`, `chain-held`), or the step the new run asked of
 * the chain has no transition from what the chain stands in — the same thing read one step later, which is how the
 * reader used to meet `fill-chain/no-transition`. A fill of this product runs one at a time (decision 0027).
 */
const ALREADY_RUNNING = ['fill-orchestrator/chain-active', 'fill-orchestrator/chain-held'];

/** Whether one refusal means a fill of this product is already running. */
export function fillAlreadyRunning(code: string): boolean {
  return ALREADY_RUNNING.includes(code) || code.startsWith('fill-chain/');
}

/**
 * What a refusal to start a fill says to the reader who asked for it. One that means the product's fill already runs says
 * so in the reader's own terms — since when, which run — and how to follow it, never with an internal code: nothing in the
 * product needs fixing. Any other refusal keeps its code, because there the code names what to fix in the product's own
 * files or what the machine lacks.
 */
async function refusalWords(owner: StoreOwner, productFolder: string, refusal: RefusedFillRun): Promise<string> {
  if (!fillAlreadyRunning(refusal.code)) return `${refusal.code}: ${refusal.reason}`;
  const identity = readProduct(productFolder);
  const name = identity.ok ? identity.product.name : basename(productFolder);
  const held = identity.ok ? await readChain(owner, name) : null;
  const live = held?.context.activeRunId == null ? null : await readRun(owner, held.context.activeRunId);
  const follow = 'Follow it in the wiki — `madarch serve`, then the fill page (/fill) — or read the run\'s steps with `madarch trace --run <the run\'s id>`.';
  if (live === null) return `a fill of ${name} is already running: another run holds the product, and it names no run this store holds. This fill started nothing. ${follow}`;
  return `a fill of ${name} is already running: run ${live.runId}, which stands ${live.state}, started ${new Date(live.createdAt).toISOString()}. This fill started nothing. ${follow.replace("<the run's id>", live.runId)}`;
}

/**
 * The store's owner, as the orchestrator host names it: the type is derived from the host's own options, so this module
 * never imports a connection (decision 0033, item 3).
 */
type StoreOwner = NonNullable<Parameters<typeof import('../fill/orchestrator-host.js').createFillOrchestratorService>[0]['owner']>;

/** The least time between two notices a reader gets while a run is under way, in milliseconds. */
const DEFAULT_PUBLISH_MS = 8_000;

/** What one fill of a knowledge store was asked for. */
export interface KnowledgeFillOptions {
  /** The owning process prepares the exact pinned contract before any fill client attaches. */
  readonly prepareContract?: (contract: import('../graph/contract.js').GraphContract) => Promise<void>;
  /** The product's folder: its manifest and the repositories it pins. */
  readonly productFolder: string;
  /** The product's knowledge store folder: `<graph>` and `<read>/<n>` live in it. */
  readonly storeFolder: string;
  /** The run's id; the caller names it, so a second press of one moment is one run. */
  readonly runId: string;
  /**
   * The run's own job, when the caller claimed one: the fill-run job whose claim is the run's lock (decision 0039,
   * item 12). `madarch --role fill` claims it before starting the run and settles it after; a run a person's own
   * process drives claims none.
   */
  readonly claim?: import('../fill/orchestrator.js').RunClaim;
  /** The units the run holds in hand at once; 16 when it is left out. */
  readonly workers?: number;
  /**
   * The kinds this fill was asked for (madarch-stm0.6, decision 0035 items 11 and 31): their plugin turns only, in this
   * dependency order, and with a vertex the one entity it rewrites. Left out, the fill takes every kind.
   */
  readonly targets?: { readonly kinds: readonly string[]; readonly vertex?: string; readonly requested?: readonly string[]; readonly pluginsOnly?: boolean };
  /** The ACP adapter chosen for this pressed fill; no adapter is started while reading pages. */
  readonly pluginAgent?: PluginAgentOptions | null;
  /** Maximum reported tokens shared by every plugin agent in this run. */
  readonly tokenCap?: number;
  /** This machine and its person chose to run plugins without isolation; read from the machine when left out. */
  readonly unconfined?: boolean;
  /** Adapter discovery and credential environment; the process environment when omitted. */
  readonly env?: DraftEnv;
  /**
   * The content language the press named, when it named one: the run states it in its own record (its trace's root span,
   * `madarch.language`), so a run another process pressed is read with the language it was asked for (madarch-8bdc.12 —
   * the fill role dropped it, and a press's language reached nothing).
   */
  readonly language?: string;
  /**
   * The store's owner, opened by the caller: the process's own connection to `<store>/graph`. The caller hands it
   * over — this module closes it when the run ends — so the module that starts a fill never imports a connection
   * (decision 0033, item 3).
   */
  readonly database: StoreOwner;
  /**
   * Called when the run publishes — the first publication, then one at most every `snapshotMs`, and the run's own end —
   * once the store's pins carry what it published: a server that serves the wiki's pages while the fill runs reads the
   * store again here, so a page shows what the run has published so far.
   */
  readonly onPublish?: () => void | Promise<void>;
  /** The least time between two notices a reader gets while the run is under way, in milliseconds (default 8 000). */
  readonly snapshotMs?: number;
}

/** What one fill of a knowledge store ended as. */
export interface KnowledgeFillResult {
  readonly ok: boolean;
  readonly state: string;
  /** Why a run that did not end was refused or failed, in the run's own words. */
  readonly message?: string;
  /**
   * True when the run never started, which is what a product whose fill already runs answers: the words say why and how
   * to follow the running fill, and no unit of this press was ever planned (madarch-8bdc.2.18).
   */
  readonly refused?: boolean;
  /** The units the run planned. */
  readonly units: number;
  /** The declared repositories the run could not read, each with its path and the state it is in. */
  readonly unread?: readonly { readonly repository: string; readonly path: string; readonly reason: string }[];
  /**
   * True when the queue may hand the run to another attempt and this attempt published nothing about it: the run keeps
   * standing, its claim is retried, and its end is the next attempt's or the one that gives up (ALX-2024).
   */
  readonly retryable?: boolean;
}

/** One fill of a knowledge store, as the host drives it and a person controls it. */
export interface KnowledgeFillRun {
  readonly runId: string;
  /** The fill to its end: the run's result and the snapshot its pages are read from. */
  readonly done: Promise<KnowledgeFillResult>;
  /** A person's pause or stop, taken by the run's own state machine. */
  control(action: 'pause' | 'stop'): Promise<{ readonly ok: boolean; readonly state?: string; readonly message?: string }>;
  /** Stops the run's service and closes the store it opened; safe to call twice. */
  close(): Promise<void>;
}

/** One repository the store holds, as the pins a reader opens state it. */
interface StorePin {
  readonly name: string;
  /**
   * The repository's node in the *temporal* graph (decision 0028), which is the scope its reads are keyed by, or
   * `null`: this fill publishes the as-is record tables and no versioned node, so it opens no temporal scope for a
   * repository. Never the repository's name: the reader compares a scope as a `bigint` id, and a name there failed a
   * page with `invalid input syntax for type bigint: "shop"`.
   */
  readonly scope: string | null;
  readonly head: string;
  readonly commit: string;
  readonly effectiveTime: string;
  readonly commits: number;
  readonly filledCommits: number;
  readonly files: number;
  readonly folders: number;
}

/**
 * The repositories the run filled, as the store it wrote says: the record tables carry the
 * as-is commit and the commit count of every repository, so the pins a reader opens are the
 * facts the fill published and not a second reading of the checkout.
 */
async function pinsOf(owner: StoreOwner, declared?: ReadonlySet<string>): Promise<StorePin[]> {
  const now = new Date().toISOString();
  const pins: StorePin[] = [];
  for (const repository of await listRepositories(owner, declared)) {
    // The counts are the store's own: the history pass wrote the commits, and the history pass is
    // the one that says whether a repository is complete. A repository with a tree and no commit
    // row is a run that read the tree and not the history, and the page says so.
    const facts = await repositoryFacts(owner, repository.name, declared);
    const commits = facts?.commitCount ?? 0;
    pins.push({
      name: repository.name, scope: facts?.nodeId ?? null, head: repository.asIsCommit ?? '', commit: repository.asIsCommit ?? '',
      effectiveTime: now, commits, filledCommits: commits, files: facts?.fileCount ?? 0, folders: facts?.directoryCount ?? 0,
    });
  }
  return pins;
}

/** What finishing one store wrote: how many pins of the run's repositories. */
export interface FinishedKnowledgeStore {
  readonly pins: number;
}

/**
 * Finishes one store after a run that settled: the repositories the graph now holds and what each was filled to, read
 * from the graph — the repository entity, its as-is edge and the counts of its rows. Nothing is written: a pin is not a
 * table of the fill's (stage 3: `knowledge_fill` is gone). The statistics a page plans from are left after it.
 */
export async function finishKnowledgeStore(owner: StoreOwner, declared?: ReadonlySet<string>, analyze = true): Promise<FinishedKnowledgeStore> {
  const pins = (await pinsOf(owner, declared)).length;
  // The tables a run wrote have no statistics until something reads enough of them or autovacuum arrives. A repository
  // page of a few thousand commits planned its history aggregate from estimates off by two orders of magnitude (measured:
  // 1 078 ms against 3.7 ms after ANALYZE, madarch-64o5.3). A store that cannot analyze still answers from its estimates.
  if (analyze) await withSpan('db.query', { 'db.system': 'postgres', 'db.sql.bytes': Buffer.byteLength('ANALYZE') }, async () => await owner.run((tx: { query: (text: string, params?: readonly unknown[]) => Promise<unknown> }) => tx.query('ANALYZE'))).catch(() => undefined);
  return { pins };

}

/**
 * Whether another process still holds this product's fill: its `fill-runs` job is unfinished, which is the queue's own
 * proof that a process was asked for the run and holds it — so the run it drives is alive even when nothing moved for the
 * recovery window (ALX-2024, ALX-2026 finding 1). A press that holds its own claim has that proof already: the queue's
 * singleton key forbids a second unfinished job for the product.
 */
async function claimedElsewhere(owner: StoreOwner, productFolder: string, claim: RunClaim | undefined): Promise<boolean> {
  if (claim !== undefined) return false;
  const queue = await openFillRunQueue(owner).catch(() => undefined);
  if (queue === undefined) return false;
  try {
    return await queue.holdsUnfinished(FILL_RUN_QUEUE, productFolder);
  } catch {
    return false; // a store whose queue cannot be read says nothing it cannot say: the recovery window decides
  } finally {
    await queue.stop().catch(() => undefined);
  }
}

/**
 * Starts one product's fill of its knowledge store: the store's owner, the
 * workflow's stages, the run — returned at once, with `done` carrying the end.
 * A run that ends takes a snapshot for the reader and records the pins of the
 * repositories it filled (`finishKnowledgeStore`), which is what a reader's
 * pins are read from.
 */
export async function startKnowledgeFill(options: KnowledgeFillOptions): Promise<KnowledgeFillRun> {
  withSpanSync('fs.mkdir', { 'file.path': options.storeFolder }, () => mkdirSync(options.storeFolder, { recursive: true }));
  const owner = options.database;
  await owner.ready;
  const database:FillStateDatabase={transaction:owner.transaction.bind(owner),graphContract:withAssertionContract(await readPinnedGraphContract(options.productFolder))};
  let service: FillOrchestratorService | undefined;
  let recordEnd = true;
  /** When a reader was last told the run published, and the least time between two notices. */
  let lastNotice: number | undefined;
  const noticeEveryMs = options.snapshotMs ?? DEFAULT_PUBLISH_MS;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try { await service?.stop(); } catch { /* the service's queue or database was already shut: the run's own answer said so */ }
    await owner.close().catch(() => undefined);
  };
  try {
    const identity = readProduct(options.productFolder);
    /** Ending the run this fill lost touches its own rows and its product's chain, and nothing of a service (ALX-2024). */
    const cleanup: RunCleanupContext = { database, product: identity.ok ? identity.product.name : basename(options.productFolder), clock: Date.now };
    const fillTheStore = async (): Promise<KnowledgeFillResult> => {
      try {
        // A live fill takes precedence over admission of another request. The orchestrator still owns the atomic
        // admission below; this read only avoids asking an already busy product for this request's agent and plan.
        const chain = identity.ok ? await readChain(owner, identity.product.name) : null;
        if (chain?.state === 'active' && chain.context.activeRunId !== options.runId) {
          const held = chain.context.activeRunId === null ? null : await readRun(owner, chain.context.activeRunId);
          // A run nothing moved for the recovery window is not a live fill: this request takes the chain the way the
          // orchestrator's own recovery does, which ends that run before this one plans (ALX-2024).
          const still = held !== null && (await lastRunActivityAt({ database }, held.runId) ?? 0) <= Date.now() - RUN_ORPHAN_AFTER_MS;
          const abandoned = still && !(await claimedElsewhere(owner, options.productFolder, options.claim));
          if (held !== null && !(TERMINAL_RUN_STATES as readonly string[]).includes(held.state) && !abandoned) {
            const message = await refusalWords(owner, options.productFolder, { ok: false, code: 'fill-orchestrator/chain-active', reason: '' });
            recordEnd = false;
            // The request this fill was asked for ends here: its end is the answer the pressing page waits on, and
            // without it every later press waits behind a run that never started (ALX-2024).
            await failRequestedFill(database, options.runId, message);
            return { ok: false, state: 'failed', refused: true, message, units: 0 };
          }
        }
        // One fill, through the one runner: the button, `madarch fill`, the daemon and `madarch mcp`
        // all start it here (madarch-8bdc.2.5, item 6).
        const pluginAgent = options.pluginAgent === undefined ? configuredPluginAgent(options.storeFolder, options.env ?? process.env) : options.pluginAgent ?? undefined;
        const isolation = options.unconfined === undefined ? await fillIsolation(options.env ?? process.env) : { unconfined: options.unconfined };
        const result = await runFill({
          product: options.productFolder,
          database: owner,
          ...(options.prepareContract === undefined ? {} : { prepareContract: options.prepareContract }),
          runId: options.runId,
          ...(options.claim === undefined ? {} : { claim: options.claim }),
          home: options.storeFolder,
          workers: options.workers ?? 16,
          ...(options.language === undefined ? {} : { language: options.language }),
          ...(options.targets === undefined ? {} : { targets: options.targets }),
          ...(pluginAgent === undefined ? {} : { pluginAgent }),
          ...(options.tokenCap === undefined ? {} : { tokenCap: options.tokenCap }),
          ...(isolation.unconfined ? { unconfined: true } : {}),
          maxPasses: 100_000,
          onService: (started) => { service = started; },
          // A page that is showing the wiki while this run fills it follows at a pace proportional to the run, not to
          // its units: the first publication at once (so a first fill's files stand early), then at most one every
          // `snapshotMs` (8 s by default). Each notice costs the server one pins read, and the run's own end sends one
          // too, so the step is read and never thrown on.
          ...(options.onPublish === undefined ? {} : {
            sink: async (event: { readonly kind: string }): Promise<void> => {
              if (event.kind !== 'unit-published') return;
              const at = Date.now();
              if (lastNotice !== undefined && at - lastNotice < noticeEveryMs) return;
              lastNotice = at;
              try {
                // The notice follows the store's own rows: the pins are the graph's (stage 3: `knowledge_fill` is gone),
                // so there is nothing to write before a reader is told to read again.
                await options.onPublish!();
              } catch {
                // the next publication tries again; the run's end finishes the store whether or not this one did
              }
            },
          }),
        });
        if (!result.ok) {
          const message = await refusalWords(owner, options.productFolder, result);
          // A claim that lapsed is another attempt's job now: this one writes nothing about the run, its chain or its end.
          if (result.code !== 'fill-orchestrator/claim-lapsed' && !(await failRequestedFill(database, options.runId, message))) {
            // The run had begun and its plan or its start refused it: it releases its units and its chain, and only the
            // attempt that moved it writes its end (ALX-2024, ALX-2026 findings 3 and 4). The cause is the one the run
            // machine accepts from `planning` and `running` — a started attempt that will not carry the run any further —
            // never `initialization-failed`, which only a run still `created` may take (`src/fill/fsm.ts` line 549).
            await failAndSettleRun(cleanup, { runId: options.runId, detail: message });
          }
          recordEnd = false;
          return { ok: false, state: 'failed', refused: true, message, units: 0 };
        }
        // The run's own durable events name why a unit did not publish: the stage's error, with the
        // file and line it was raised from, is what an engineer reads first (madarch-8bdc.2.5, item 2).
        const named: string[] = [];
        for (const event of await readProgress(owner, result.runId)) {
          if (event.unitId !== '' && (event.kind === 'unit-failed' || event.kind === 'unit-blocked')) named.push(`${event.unitId}: ${event.summary}`);
        }
        const failedUnits = result.units.filter((unit) => unit.state !== 'published' && unit.state !== 'superseded');
        const why = named.length > 0 ? named.join('; ') : failedUnits.map((unit) => `${unit.unitId} (${unit.stageId}, ${unit.state})`).join(', ');
        if (!result.settled) {
          const message = `the fill ended without settling${result.stoppedBecause === undefined ? '' : `: ${result.stoppedBecause}`}${why === '' ? '' : `; ${why}`}`;
          // The queue still has an attempt after this one: the run stands where it is, and this attempt publishes nothing
          // about it — its end is written by the attempt that finishes it, not by one that only gave up (ALX-2024).
          if (options.claim !== undefined && options.claim.job.attempt < options.claim.job.retries) {
            recordEnd = false;
            return { ok: false, state: result.state, message, units: result.units.length, retryable: true };
          }
          // Its attempts are spent: nothing will move the run again, so it releases its units and its chain and records
          // its end here, or the press that asked for it waits for an end no process writes (ALX-2024).
          await failAndSettleRun(cleanup, { runId: options.runId, detail: message });
          recordEnd = false;
          return { ok: false, state: result.state, message, units: result.units.length };
        }
        if (result.state !== 'succeeded') {
          return {
            ok: false,
            state: result.state,
            message: `the fill ended ${result.state}${result.stoppedBecause === undefined ? '' : `: ${result.stoppedBecause}`}${why === '' ? '' : `; ${why}`}`,
            units: result.units.length,
          };
        }
        // The run is finished after the store's last publication is committed: a page asked after the fill reads the
        // graph's own rows, and the statistics of those rows are left for the next page's plan.
        await finishKnowledgeStore(owner, result.declaredKinds === undefined ? undefined : new Set(result.declaredKinds));

        return {
          ok: true, state: result.state, units: result.units.length,
          ...(result.unread === undefined || result.unread.length === 0 ? {} : { unread: [...result.unread] }),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (await readRun(owner, options.runId) === null) {
          const identity = readProduct(options.productFolder);
          await createRun(database, { runId: options.runId, product: identity.ok ? identity.product.name : basename(options.productFolder), at: Date.now() });
          const failed = await advanceRun(database, { runId: options.runId, event: { type: 'fail', at: Date.now(), cause: 'initialization-failed', detail: message } });
          if (!failed.ok) throw new Error(failed.refusal.reason);
        } else if (service === undefined) {
          // A request is persisted before dispatch; an initialization failure must end that created row too.
          // Repeated requests for a run already begun must not replace its existing end.
          await failRequestedFill(database, options.runId, message);
          recordEnd = false;
        } else {
          // A run the fill began and then lost ends here, in the process that ran it: a stage's plan that refuses, a
          // stage's own error. The row left standing `planning` or `running` answers every reader `queued` or `running`
          // for ever, and the press's page waits for an end no killed process writes (measured 2026-11-26: the
          // clean-install walk polled 180 000 ms for a run whose plan had refused after 2 s). The run releases the
          // units it left and the chain it held before its end is written (ALX-2024).
          await failAndSettleRun(cleanup, { runId: options.runId, detail: message });
        }
        return { ok: false, state: 'failed', message, units: 0 };
      }
    };

    /**
     * The run to its end (madarch-8bdc.9). The end is the `fill_end` row, written here after the store is finished —
     * pins and all — and before the owner closes: the process that pressed the fill, and any other api instance of the
     * same store, read it as the moment the store is published. Without it the pressing side could see the run row's
     * terminal state while the pins were still uncommitted, read an empty store as the run's result, and keep answering
     * "nothing has been read from the code yet" until its reader next closed and reopened (measured 2026-11-08: the run
     * row said `succeeded` while `knowledge_fill` held no row, and the pins landed 10 ms later).
     */
    const done = (async (): Promise<KnowledgeFillResult> => {
      try {
        const answer = await fillTheStore();
        if (recordEnd) await writeFillEndIfAbsent(database, {
          runId: options.runId, state: answer.state,
          ...(answer.message === undefined ? {} : { message: answer.message }),
          ...(answer.unread === undefined ? {} : { unread: answer.unread }),
        });
        return answer;
      } finally {
        await close();
      }
    })();
    return {
      runId: options.runId,
      done,
      async control(action) {
        if (service === undefined) return { ok: false, message: `the run ${JSON.stringify(options.runId)} has not started yet: nothing was ${action === 'pause' ? 'paused' : 'stopped'}` };
        const answer = await service.control({ productFolder: options.productFolder, runId: options.runId, action });
        if (answer === null) return { ok: false, message: `the run ${JSON.stringify(options.runId)} is not one this store drives: nothing was ${action === 'pause' ? 'paused' : 'stopped'}` };
        if (!answer.ok) return { ok: false, message: answer.reason };
        return { ok: true, state: answer.state };
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
