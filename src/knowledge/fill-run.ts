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
import { cpSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runFill } from '../fill/run.js';
import type { FillOrchestratorService } from '../fill/orchestrator-host.js';
import { listRepositories } from '../graph/index.js';

const execFileAsync = promisify(execFile);

/**
 * The store's owner, as the orchestrator host names it: the type is derived from the host's own options, so this module
 * never imports a connection (decision 0033, item 3).
 */
type StoreOwner = NonNullable<Parameters<typeof import('../fill/orchestrator-host.js').createFillOrchestratorService>[0]['owner']>;

/** The numbers of the snapshots already in `readRoot`, so a new one never reuses one. */
export function snapshotNumbers(readRoot: string): number[] {
  try {
    return readdirSync(readRoot).filter((name) => /^\d+$/.test(name)).map(Number).sort((left, right) => left - right);
  } catch {
    return [];
  }
}

/** Makes the folder of a snapshot of a store the owner holds: a checkpoint, then a copy that lands whole or not at all. */
export async function takeSnapshot(owner: StoreOwner, graphPath: string, readRoot: string): Promise<number> {
  await owner.exec('CHECKPOINT');
  mkdirSync(readRoot, { recursive: true });
  const seq = (snapshotNumbers(readRoot).pop() ?? 0) + 1;
  const temporary = join(readRoot, `${seq}.tmp`);
  rmSync(temporary, { recursive: true, force: true });
  cpSync(graphPath, temporary, { recursive: true });
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
}

/** What one fill of a knowledge store ended as. */
interface KnowledgeFillResult {
  readonly ok: boolean;
  readonly state: string;
  /** Why a run that did not end was refused or failed, in the run's own words. */
  readonly message?: string;
  /** The units the run planned. */
  readonly units: number;
  /** The snapshot the reader opens for this fill, when the run ended and one was made. */
  readonly snapshot?: number;
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

/**
 * The repositories the run filled, as the store it wrote says: the record tables carry the
 * as-is commit and the commit count of every repository, so the pins a reader opens are the
 * facts the fill published and not a second reading of the checkout.
 */
async function pinsOf(owner: StoreOwner): Promise<{ name: string; scope: string; head: string; commit: string; effectiveTime: string; commits: number; filledCommits: number }[]> {
  const now = new Date().toISOString();
  const pins = [];
  for (const repository of await listRepositories(owner)) {
    pins.push({ name: repository.name, scope: repository.name, head: repository.asIsCommit ?? '', commit: repository.asIsCommit ?? '', effectiveTime: now, commits: 0, filledCommits: 0 });
  }
  return pins;
}

/**
 * Starts one product's fill of its knowledge store: the store's owner, the
 * workflow's stages, the run — returned at once, with `done` carrying the end.
 * A run that ends takes a snapshot for the reader and records the pins of the
 * repositories it filled in the store's own `knowledge_fill` table, which is
 * what a reader's pins are read from.
 */
export async function startKnowledgeFill(options: KnowledgeFillOptions): Promise<KnowledgeFillRun> {
  const graphPath = join(options.storeFolder, 'graph');
  const readRoot = join(options.storeFolder, 'read');
  mkdirSync(options.storeFolder, { recursive: true });
  const owner = options.database;
  await owner.ready;
  let service: FillOrchestratorService | undefined;
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
        });
        if (!result.ok) return { ok: false, state: 'failed', message: `${result.code}: ${result.reason}`, units: 0 };
        if (!result.settled || result.state !== 'succeeded') {
          return { ok: false, state: result.state, message: `the fill ended ${result.settled ? result.state : 'without settling'}${result.stoppedBecause === undefined ? '' : `: ${result.stoppedBecause}`}`, units: result.units.length };
        }
        await owner.run((tx: { query: (text: string, params?: readonly unknown[]) => Promise<unknown> }) => tx.query(`CREATE TABLE IF NOT EXISTS knowledge_fill (
          repo text PRIMARY KEY, scope text NOT NULL, head text NOT NULL, commit_hash text NOT NULL, effective_time text NOT NULL,
          commits int NOT NULL, filled_commits int NOT NULL)`));
        for (const pin of await pinsOf(owner)) {
          await owner.run((tx: { query: (text: string, params?: readonly unknown[]) => Promise<unknown> }) => tx.query(
            `INSERT INTO knowledge_fill (repo, scope, head, commit_hash, effective_time, commits, filled_commits) VALUES ($1, $2, $3, $4, $5, $6::int, $7::int)
             ON CONFLICT (repo) DO UPDATE SET scope = $2, head = $3, commit_hash = $4, effective_time = $5, commits = $6::int, filled_commits = $7::int`,
            [pin.name, pin.scope, pin.head, pin.commit, pin.effectiveTime, String(pin.commits), String(pin.filledCommits)],
          ));
        }
        const snapshot = await takeSnapshot(owner, graphPath, readRoot);
        return { ok: true, state: result.state, units: result.units.length, snapshot };
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
