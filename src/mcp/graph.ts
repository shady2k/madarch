/**
 * The store `madarch mcp` serves (madarch-ztyq.10; madarch-8bdc.2.5, items 2 and 3): the
 * one store the wiki's button fills — `<products home>/.madarch/knowledge/<product id>`,
 * its graph at `<store>/graph` — read at the commit its records name as-is.
 *
 * The store is filled through the one fill: `runFill` over the checkout, the same runner
 * the button, `madarch fill` and `madarch fill-stages` use. A start that finds the store
 * holding no graph of the checkout's HEAD fills it at that commit; a start that finds the
 * commit already filled reads it. There is no second graph folder, no second extraction
 * and no runner of this module's own.
 *
 * The graph is derived data (decision 0023): a store that is missing, holds no graph of
 * this commit or cannot be read is filled again, never trusted.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../adapters/database-owner.js';
import { readProgress } from '../fill/orchestrator-store.js';
import { runFill } from '../fill/run.js';
import type { FillProgress } from '../obs/progress.js';
import { createGraphStore, repositoryFacts, type GraphStore } from '../graph/index.js';
import { defaultKnowledgeRoot, storeFolderOf } from '../knowledge/product.js';
import { fillFolderIdentity } from '../product/fill-stages.js';
import { productsHome, type DraftEnv } from '../product/home.js';
import { MANIFEST_FILE } from '../product/manifest.js';
import { GraphView } from '../writer/view.js';
import { headCommit } from './git.js';

/** What one start's fill left: the state it settled in, and every unit that did not publish, with its reason. */
interface FillOutcome {
  readonly state: string;
  readonly failed: readonly { readonly unitId: string; readonly state: string; readonly reason: string }[];
}

/** The file a store keeps its last fill's outcome in, read again by a start that reads the store. */
const FILL_OUTCOME_FILE = 'fill.json';

/** The outcome a store records, or undefined where it records none this start can trust. */
function readFillOutcome(folder: string): FillOutcome | undefined {
  try {
    const held = JSON.parse(readFileSync(join(folder, FILL_OUTCOME_FILE), 'utf8')) as Partial<FillOutcome>;
    if (typeof held.state !== 'string' || !Array.isArray(held.failed)) return undefined;
    const failed = held.failed.filter((one): one is FillOutcome['failed'][number] => typeof one === 'object' && one !== null && typeof (one as { unitId?: unknown }).unitId === 'string' && typeof (one as { state?: unknown }).state === 'string' && typeof (one as { reason?: unknown }).reason === 'string');
    return { state: held.state, failed };
  } catch {
    return undefined;
  }
}

/** Records the outcome this start's fill left, so a start that reads the store reports it too. */
function writeFillOutcome(folder: string, outcome: FillOutcome): void {
  writeFileSync(join(folder, FILL_OUTCOME_FILE), JSON.stringify(outcome), 'utf8');
}

/** One opened store: what the session answers from, and where it lives. */
export interface RepositoryGraph {
  readonly owner: DatabaseOwner;
  readonly store: GraphStore;
  readonly view: GraphView;
  /** The store folder the graph is kept in (`<store>/graph` is the database). */
  readonly folder: string;
  /** The commit the graph is the graph of: the one its records name as-is. */
  readonly commit: string;
  /** Whether this start filled or moved the graph, and how long that took. */
  readonly filled: boolean;
  readonly fillMs: number;
  /** What the fill that built this graph left: the state, and the units that did not publish. */
  readonly fill: FillOutcome | undefined;
  close(): Promise<void>;
}

/**
 * The store one checkout is served from: the store the wiki's button fills, named by the
 * checkout's product id — or, for a checkout that is no product, by its folder's name,
 * which is the name the fill reads its facts under too.
 */
export function mcpStoreFolder(repository: string, env: Readonly<Record<string, string | undefined>> = process.env): string {
  const identity = fillFolderIdentity(resolve(repository));
  return storeFolderOf(defaultKnowledgeRoot(productsHome(env as DraftEnv)), identity.identity.id, join(resolve(repository), MANIFEST_FILE));
}

/** A lock a live process holds on a store: the PGlite directory serves one writer at a time. */
export interface FolderLock {
  readonly folder: string;
  readonly pid: number;
}

/**
 * Takes the store's lock atomically (madarch-ztyq.10 review): the file is created with `O_EXCL`, so two processes
 * that start together against one store cannot both believe they hold it, and the write that names the holder is a
 * write to the file only this process may have created. A file whose holder is a live process — this one included —
 * is a refusal; a file whose holder is dead, or was never written, is left by a crash and is taken over.
 *
 * The lock is held until the database is closed: `releaseFolderLock` drops it, and only its own.
 */
export function acquireFolderLock(folder: string): FolderLock {
  const absolute = resolve(folder);
  mkdirSync(absolute, { recursive: true });
  const lock = join(absolute, 'server.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lock, 'wx');
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), 'utf8'); } finally { closeSync(fd); }
      return { folder: absolute, pid: process.pid };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let held: { pid?: unknown } | undefined;
      try {
        held = JSON.parse(readFileSync(lock, 'utf8')) as { pid?: unknown };
      } catch {
        // The holder created the file and has not written its pid yet, or a crash left it empty: either way the file
        // is someone's until it names a pid that is gone (madarch-ztyq.10 review).
        held = undefined;
      }
      const pid = typeof held?.pid === 'number' ? held.pid : null;
      let alive = pid === null;
      if (pid !== null) {
        try { process.kill(pid, 0); alive = true; } catch { alive = false; }
      }
      if (alive) {
        throw new Error(`${lock}:1: the store ${absolute} is already served by process ${pid ?? 'a process that is starting'}; one store serves one process at a time (src/mcp/graph.ts)`);
      }
      rmSync(lock, { force: true });
    }
  }
  throw new Error(`${join(absolute, 'server.lock')}:1: the lock of ${absolute} could not be taken after a stale holder was removed (src/mcp/graph.ts)`);
}

/** Drops the lock this process took, and only this process's. */
export function releaseFolderLock(folder: string, held: FolderLock): void {
  const lock = join(resolve(folder), 'server.lock');
  try {
    const one = JSON.parse(readFileSync(lock, 'utf8')) as { pid?: unknown };
    if (one.pid === held.pid) rmSync(lock, { force: true });
  } catch { /* a lock that is already gone needs no dropping */ }
}

/** The commit the store's records name as-is for one repository, or null where the store holds none. */
async function asIsCommitOf(owner: DatabaseOwner, repository: string): Promise<string | null> {
  try {
    return (await repositoryFacts(owner, repository))?.asIsCommit ?? null;
  } catch {
    // A store with no record tables yet is a store no fill wrote: it holds no commit, and the start fills it.
    return null;
  }
}

/**
 * Fills one checkout's store through the one fill (`runFill`) and answers what the run left.
 * The run's own words are the caller's: a refused or unsettled run is an error naming the
 * refusal, never a smaller success.
 */
async function fillRepositoryGraph(owner: DatabaseOwner, repository: string, folder: string, log: (line: string) => void): Promise<FillOutcome> {
  log(`madarch mcp: filling ${repository} through the one fill`);
  const result = await runFill({
    product: repository,
    database: owner,
    home: folder,
    store: folder,
    log,
  });
  if (!result.ok) throw new Error(`${folder}:1: the fill of ${repository} was refused: ${result.code}: ${result.reason} (src/mcp/graph.ts)`);
  if (!result.settled) {
    const named = result.units.filter((unit) => unit.state !== 'published' && unit.state !== 'superseded').map((unit) => `${unit.unitId} (${unit.state})`);
    throw new Error(`${folder}:1: the fill of ${repository} ended without settling${result.stoppedBecause === undefined ? '' : ` (${result.stoppedBecause})`}: ${named.length === 0 ? 'no unit names a failure' : named.join(', ')} (src/mcp/graph.ts)`);
  }
  // A run that settled short of success is served with what it published: decision 0033 (items 18 and 19)
  // reports partial coverage, and a unit's failure is its own while the other units' work stands. The
  // reason a unit did not publish is read from the run's own durable events, never guessed from its state.
  const failed = result.units.filter((unit) => unit.state !== 'published' && unit.state !== 'superseded');
  const reasons = new Map<string, string>();
  for (const event of await readProgress(owner, result.runId)) {
    if (event.unitId !== '' && (event.kind === 'unit-failed' || event.kind === 'unit-blocked')) reasons.set(event.unitId, event.summary);
  }
  return {
    state: result.state,
    failed: failed.map((unit) => ({ unitId: unit.unitId, state: unit.state, reason: reasons.get(unit.unitId) ?? `the unit ended ${unit.state}` })),
  };
}

/**
 * Opens the store of one checkout at HEAD, filling it through the one fill when the store
 * holds no graph of that commit. The store is the one the wiki's button fills; a store that
 * already holds the commit is read, not filled again.
 */
export async function openRepositoryGraph(options: {
  readonly repository: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly log?: (line: string) => void;
  /** The fill's own progress, read from its trace by the caller that reports it. */
  readonly progress?: (() => FillProgress) | undefined;
}): Promise<RepositoryGraph> {
  void options.progress;
  const repository = resolve(options.repository);
  const env = options.env ?? process.env;
  const identity = fillFolderIdentity(repository);
  const folder = mcpStoreFolder(repository, env);
  mkdirSync(folder, { recursive: true });
  const log = options.log ?? (() => {});
  const held = acquireFolderLock(folder);
  const databasePath = join(folder, 'graph');
  const commit = headCommit(repository);
  let owner: DatabaseOwner | undefined;
  try {
    owner = createPGliteDatabaseOwner({ path: databasePath, btreeGist: true, relaxedDurability: true });
    const started = performance.now();
    let fill = readFillOutcome(folder);
    let filled = false;
    let view: GraphView | null = null;
    if ((await asIsCommitOf(owner, identity.identity.name)) === commit) {
      try { view = await GraphView.open(owner, createGraphStore(owner)); } catch { view = null; }
    }
    if (view === null) {
      const before = performance.now();
      fill = await fillRepositoryGraph(owner, repository, folder, log);
      writeFillOutcome(folder, fill);
      const store = createGraphStore(owner);
      view = await GraphView.open(owner, store);
      filled = true;
      const after = performance.now();
      log(`madarch mcp: graph filled in ${((after - before) / 1000).toFixed(1)} s${fill.failed.length === 0 ? '' : `; ${fill.failed.length} ${fill.failed.length === 1 ? 'unit' : 'units'} did not publish (${fill.state})`}`);
    }
    const asIs = await asIsCommitOf(owner, identity.identity.name);
    if (asIs !== commit) {
      throw new Error(`${databasePath}:1: the fill of ${repository} left the store at ${asIs === null ? 'no commit' : asIs}, and the checkout stands at ${commit}: a graph of another commit is not served (src/mcp/graph.ts)`);
    }
    const opened = filled ? 0 : performance.now() - started;
    const openedOwner = owner;
    return {
      owner: openedOwner,
      store: createGraphStore(openedOwner),
      view,
      folder,
      commit,
      filled,
      fill,
      fillMs: filled ? performance.now() - started : opened,
      // The lock is dropped after the database is closed, never before: a second process that took the store while
      // this one was mid-close would open a database another is still shutting down (madarch-ztyq.10 recheck).
      close: async () => { await openedOwner.close(); releaseFolderLock(folder, held); },
    };
  } catch (error) {
    await owner?.close().catch(() => undefined);
    releaseFolderLock(folder, held);
    throw error;
  }
}
