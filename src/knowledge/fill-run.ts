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
import type { PluginAgentOptions } from '../plugin/agent.js';
import { configuredPluginAgent } from './agents.js';
import type { DraftEnv } from '../product/home.js';
import { readProgress, writeFillEnd } from '../fill/orchestrator-store.js';
import type { FillOrchestratorService, RefusedFillRun } from '../fill/orchestrator-host.js';
import { readChain, readRun } from '../fill/state-store.js';
import { listRepositories, repositoryFacts } from '../graph/index.js';
import { readProduct } from '../product/manifest.js';


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
  /** The units the run holds in hand at once; 16 when it is left out. */
  readonly workers?: number;
  /**
   * The kinds this fill was asked for (madarch-stm0.6, decision 0035 items 11 and 31): their plugin turns only, in this
   * dependency order, and with a vertex the one entity it rewrites. Left out, the fill takes every kind.
   */
  readonly targets?: { readonly kinds: readonly string[]; readonly vertex?: string };
  /** The ACP adapter chosen for this pressed fill; no adapter is started while reading pages. */
  readonly pluginAgent?: PluginAgentOptions;
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
  if (analyze) await owner.run((tx: { query: (text: string, params?: readonly unknown[]) => Promise<unknown> }) => tx.query('ANALYZE')).catch(() => undefined);
  return { pins };

}

/**
 * Starts one product's fill of its knowledge store: the store's owner, the
 * workflow's stages, the run — returned at once, with `done` carrying the end.
 * A run that ends takes a snapshot for the reader and records the pins of the
 * repositories it filled (`finishKnowledgeStore`), which is what a reader's
 * pins are read from.
 */
export async function startKnowledgeFill(options: KnowledgeFillOptions): Promise<KnowledgeFillRun> {
  mkdirSync(options.storeFolder, { recursive: true });
  const owner = options.database;
  await owner.ready;
  let service: FillOrchestratorService | undefined;
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
    const fillTheStore = async (): Promise<KnowledgeFillResult> => {
      try {
        // One fill, through the one runner: the button, `madarch fill`, the daemon and `madarch mcp`
        // all start it here (madarch-8bdc.2.5, item 6).
        const pluginAgent = options.pluginAgent ?? configuredPluginAgent(options.storeFolder, options.env ?? process.env);
        const result = await runFill({
          product: options.productFolder,
          database: owner,
          ...(options.prepareContract === undefined ? {} : { prepareContract: options.prepareContract }),
          runId: options.runId,
          home: options.storeFolder,
          workers: options.workers ?? 16,
          ...(options.language === undefined ? {} : { language: options.language }),
          ...(options.targets === undefined ? {} : { targets: options.targets }),
          ...(pluginAgent === undefined ? {} : { pluginAgent }),
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
        if (!result.ok) return { ok: false, state: 'failed', refused: true, message: await refusalWords(owner, options.productFolder, result), units: 0 };
        if (!result.settled || result.state !== 'succeeded') {
          // The run's own durable events name why a unit did not publish: the stage's error, with the
          // file and line it was raised from, is what an engineer reads first (madarch-8bdc.2.5, item 2).
          const named: string[] = [];
          for (const event of await readProgress(owner, result.runId)) {
            if (event.unitId !== '' && (event.kind === 'unit-failed' || event.kind === 'unit-blocked')) named.push(`${event.unitId}: ${event.summary}`);
          }
          const failed = result.units.filter((unit) => unit.state !== 'published' && unit.state !== 'superseded');
          const why = named.length > 0 ? named.join('; ') : failed.map((unit) => `${unit.unitId} (${unit.stageId}, ${unit.state})`).join(', ');
          return {
            ok: false,
            state: result.state,
            message: `the fill ended ${result.settled ? result.state : 'without settling'}${result.stoppedBecause === undefined ? '' : `: ${result.stoppedBecause}`}${why === '' ? '' : `; ${why}`}`,
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
        return { ok: false, state: 'failed', message: error instanceof Error ? error.message : String(error), units: 0 };
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
      const answer = await fillTheStore();
      try {
        await writeFillEnd(owner, {
          runId: options.runId, state: answer.state,
          ...(answer.message === undefined ? {} : { message: answer.message }),
          ...(answer.unread === undefined ? {} : { unread: answer.unread }),
        });
      } catch {
        // The run's answer stands whatever happened to the record of its end: a store that cannot take this row is one
        // whose pages already answer what the run wrote.
      }
      await close();
      return answer;
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
