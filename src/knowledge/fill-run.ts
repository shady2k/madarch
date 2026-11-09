/**
 * One product's knowledge store, filled by the one orchestrator (decision 0033,
 * item 1): the wiki's fill button and `madarch fill` start the static fill here,
 * over the store the wiki reads, and the pages read the graph this path
 * published.
 *
 * What this module owns is the store's mechanics: the process's one owner of
 * `<store>/graph`, the `madarch/workflows.yaml`-declared stage set the run
 * enables (`createStagesFill`), the run through `createFillOrchestratorService`,
 * the numbered snapshot the reader opens (`<store>/read/<n>`, made after a
 * checkpoint, whole or not at all), the pins of the repositories the run filled,
 * and the person's pause and stop through the run's own state machine.
 *
 * It runs no model and writes no page: a page is an agent's work and a later
 * stage's (decision 0033, items 1 and 2, and the owner's separation of roles: a
 * strong model writes and analyses, a weak model or jev classifies).
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runFill } from '../fill/run.js';
import { readProgress } from '../fill/orchestrator-store.js';
import type { FillOrchestratorService } from '../fill/orchestrator-host.js';
import { listRepositories, repositoryFacts } from '../graph/index.js';
import { storeDatabasePath, storeSnapshotsFolder } from '../product/store.js';

const execFileAsync = promisify(execFile);

/**
 * The store's owner, as the orchestrator host names it: the type is derived from the host's own options, so this module
 * never imports a connection (decision 0033, item 3).
 */
type StoreOwner = NonNullable<Parameters<typeof import('../fill/orchestrator-host.js').createFillOrchestratorService>[0]['owner']>;

/** The least time between two snapshots a reader is given while a run is under way: a snapshot costs a reader process's start. */
const DEFAULT_SNAPSHOT_MS = 8_000;

/** The numbers of the snapshots already in `readRoot`, so a new one never reuses one. */
export function snapshotNumbers(readRoot: string): number[] {
  try {
    return readdirSync(readRoot).filter((name) => /^\d+$/.test(name)).map(Number).sort((left, right) => left - right);
  } catch {
    return [];
  }
}

/**
 * Records one numbered snapshot of a store for its reader. With one PostgreSQL
 * server a snapshot is no copy: the reader's own repeatable-read transaction is
 * the snapshot, begun when the reader opened, and what a reader needs from the
 * fill is the *number* of the generation it stands at and the moment the fill
 * published it — a line in `<read>/<n>`, written whole by a rename.
 */
export async function takeSnapshot(owner: StoreOwner, graphPath: string, readRoot: string): Promise<number> {
  void owner;
  mkdirSync(readRoot, { recursive: true });
  const seq = (snapshotNumbers(readRoot).pop() ?? 0) + 1;
  const temporary = join(readRoot, `${seq}.tmp`);
  writeFileSync(temporary, `${JSON.stringify({ store: graphPath, at: new Date().toISOString() })}\n`);
  renameSync(temporary, join(readRoot, String(seq)));
  return seq;
}

/** What one fill of a knowledge store was asked for. */
export interface KnowledgeFillOptions {
  /** The product's folder: its manifest and the repositories it pins. */
  readonly productFolder: string;
  /** The product's knowledge store folder: `<graph>` and `<read>/<n>` live in it. */
  readonly storeFolder: string;
  /** The run's id; the caller names it, so a second press of one moment is one run. */
  readonly runId: string;
  /** The units the run holds in hand at once; 16 when it is left out. */
  readonly workers?: number;
  /**
   * The store's owner, opened by the caller: the process's own connection to `<store>/graph`. The caller hands it
   * over — this module closes it when the run ends — so the module that starts a fill never imports a connection
   * (decision 0033, item 3).
   */
  readonly database: StoreOwner;
  /**
   * Called with each numbered snapshot the run publishes for a reader — the first publication, then one at most every
   * `snapshotMs`, and the run's own end — once the store's pins carry what it published: a server that serves the wiki's
   * pages while the fill runs moves its reader to that snapshot here, so a page shows what the run has published so far.
   */
  readonly onPublish?: (snapshot: number) => void | Promise<void>;
  /** The least time between two snapshots a reader is given while the run is under way, in milliseconds (default 8 000). */
  readonly snapshotMs?: number;
}

/** What one fill of a knowledge store ended as. */
export interface KnowledgeFillResult {
  readonly ok: boolean;
  readonly state: string;
  /** Why a run that did not end was refused or failed, in the run's own words. */
  readonly message?: string;
  /** The units the run planned. */
  readonly units: number;
  /** The snapshot the reader opens for this fill, when the run ended and one was made. */
  readonly snapshot?: number;
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
async function pinsOf(owner: StoreOwner): Promise<StorePin[]> {
  const now = new Date().toISOString();
  const pins: StorePin[] = [];
  for (const repository of await listRepositories(owner)) {
    // The counts are the store's own: the history pass wrote the commits, and the history pass is
    // the one that says whether a repository is complete. A repository with a tree and no commit
    // row is a run that read the tree and not the history, and the page says so.
    const facts = await repositoryFacts(owner, repository.name);
    const commits = facts?.commitCount ?? 0;
    pins.push({
      name: repository.name, scope: null, head: repository.asIsCommit ?? '', commit: repository.asIsCommit ?? '',
      effectiveTime: now, commits, filledCommits: commits, files: facts?.fileCount ?? 0, folders: facts?.directoryCount ?? 0,
    });
  }
  return pins;
}

/** What finishing one store wrote: how many pins of the run's repositories, and the snapshot a reader opens. */
export interface FinishedKnowledgeStore {
  readonly pins: number;
  readonly snapshot: number;
}

/**
 * Writes the store's pins: the `knowledge_fill` rows that name the repositories it holds and what each was read to.
 * A snapshot carries the pins, so a reader that opens one reads the commit its graph was filled from beside the graph
 * itself — a run that publishes a snapshot before it ends writes its pins first for the same reason.
 */
async function writePins(owner: StoreOwner): Promise<number> {
  await owner.run((tx: { query: (text: string, params?: readonly unknown[]) => Promise<unknown> }) => tx.query(`CREATE TABLE IF NOT EXISTS knowledge_fill (
    repo text PRIMARY KEY, scope text, head text NOT NULL, commit_hash text NOT NULL, effective_time text NOT NULL,
    commits int NOT NULL, filled_commits int NOT NULL)`));
  const pins = await pinsOf(owner);
  for (const pin of pins) {
    await owner.run((tx: { query: (text: string, params?: readonly unknown[]) => Promise<unknown> }) => tx.query(
      `INSERT INTO knowledge_fill (repo, scope, head, commit_hash, effective_time, commits, filled_commits) VALUES ($1, $2, $3, $4, $5, $6::int, $7::int)
       ON CONFLICT (repo) DO UPDATE SET scope = $2, head = $3, commit_hash = $4, effective_time = $5, commits = $6::int, filled_commits = $7::int`,
      [pin.name, pin.scope, pin.head, pin.commit, pin.effectiveTime, String(pin.commits), String(pin.filledCommits)],
    ));
  }
  return pins.length;
}

/**
 * Finishes one store after a run that settled: the `knowledge_fill` rows that name the repositories the
 * run published, and the numbered snapshot a reader opens. Every caller that fills the store — the
 * button, `madarch fill`, `madarch fill-stages`, the daemon's updates and `madarch mcp` — finishes it
 * here, so a run of any of them is read by the same reader, in the same snapshot layout.
 */
export async function finishKnowledgeStore(owner: StoreOwner, storeFolder: string): Promise<FinishedKnowledgeStore> {
  const pins = await writePins(owner);
  const snapshot = await takeSnapshot(owner, storeDatabasePath(storeFolder), storeSnapshotsFolder(storeFolder));
  return { pins, snapshot };
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
  /** When the reader was last given a snapshot, and the least time between two of them. */
  let lastSnapshot: number | undefined;
  const snapshotEveryMs = options.snapshotMs ?? DEFAULT_SNAPSHOT_MS;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try { await service?.stop(); } catch { /* the service's queue or database was already shut: the run's own answer said so */ }
    await owner.close().catch(() => undefined);
  };
  try {
    const done = (async (): Promise<KnowledgeFillResult> => {
      try {
        // One fill, through the one runner: the button, `madarch fill`, the daemon and `madarch mcp`
        // all start it here (madarch-8bdc.2.5, item 6).
        const result = await runFill({
          product: options.productFolder,
          database: owner,
          runId: options.runId,
          home: options.storeFolder,
          workers: options.workers ?? 16,
          maxPasses: 100_000,
          onService: (started) => { service = started; },
          // A reader that is showing the wiki while this run reads it is given the store at a pace proportional to the
          // run's length, not to its units: the first publication at once (so a first fill's files stand early), then
          // at most one every `snapshotMs` (8 s by default), and one when the run ends. A snapshot costs a copy of the
          // store plus a reader process that boots the copy — about half a second of a two-core machine each — and one
          // per published unit took the fill from 6 s to 15 s there. A snapshot the reader cannot be given is not the
          // run's failure: the run's own end takes another one, so the step is read and never thrown on.
          ...(options.onPublish === undefined ? {} : {
            sink: async (event: { readonly kind: string }): Promise<void> => {
              if (event.kind !== 'unit-published') return;
              const at = Date.now();
              if (lastSnapshot !== undefined && at - lastSnapshot < snapshotEveryMs) return;
              lastSnapshot = at;
              try {
                await writePins(owner);
                await options.onPublish!(await takeSnapshot(owner, storeDatabasePath(options.storeFolder), storeSnapshotsFolder(options.storeFolder)));
              } catch {
                // the next publication tries again; the run's end finishes the store whether or not this one did
              }
            },
          }),
        });
        if (!result.ok) return { ok: false, state: 'failed', message: `${result.code}: ${result.reason}`, units: 0 };
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
        const finished = await finishKnowledgeStore(owner, options.storeFolder);
        return {
          ok: true, state: result.state, units: result.units.length, snapshot: finished.snapshot,
          ...(result.unread === undefined || result.unread.length === 0 ? {} : { unread: [...result.unread] }),
        };
      } catch (error) {
        return { ok: false, state: 'failed', message: error instanceof Error ? error.message : String(error), units: 0 };
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
