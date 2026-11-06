/**
 * The base graph one served repository stands on (madarch-ztyq.10): the graph of
 * the commit at HEAD, built by the same extraction the wiki and the writer use
 * (`fillGraph` over `TREE_EXTRACTORS`), kept in a PGlite folder of the
 * repository's own state so the next start reads it instead of rebuilding it.
 *
 * The graph is derived data (decision 0023): a folder that is missing, empty,
 * built at another commit or unreadable is refilled, never trusted. A refill of
 * a graph that already holds a walk reads only the commits since its tip, so a
 * started server that finds a new commit pays for that commit and no more.
 *
 * History is not extracted: none of the seven tools of decision 0032 reads it,
 * and the walk is read anyway, which is what names the repository node.
 */
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../adapters/database-owner.js';
import { createFillOrchestratorService } from '../fill/orchestrator-host.js';
import { createOrchestratorSchema, readProgress } from '../fill/orchestrator-store.js';
import { createFillStateSchema, readChain, readRun } from '../fill/state-store.js';
import { canonicalJsonDigest } from '../model/canonical.js';
import { declaredStagesDigest } from '../product/fill-stages.js';
import { createGraphStore, type GraphStore } from '../graph/index.js';
import { sha256Hex } from '../graph/digest.js';
import { defaultKnowledgeRoot } from '../knowledge/product.js';
import { createRepositoryFill } from '../product/fill-stages.js';
import { productsHome, type DraftEnv } from '../product/home.js';
import { GraphView } from '../writer/view.js';
import { headCommit } from './git.js';

/** What one start's fill left: the state it settled in, and every unit that did not publish, with its reason. */
interface FillOutcome {
  readonly state: string;
  readonly failed: readonly { readonly unitId: string; readonly state: string; readonly reason: string }[];
}

/** The file a graph folder keeps its last fill's outcome in, read again by a start that reuses the graph. */
const FILL_OUTCOME_FILE = 'fill.json';

/** The outcome a graph folder records, or undefined where it records none this start can trust. */
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

/** Records the outcome this start's fill left, so a start that reuses the graph reports it too. */
function writeFillOutcome(folder: string, outcome: FillOutcome): void {
  writeFileSync(join(folder, FILL_OUTCOME_FILE), JSON.stringify(outcome), 'utf8');
}

/** One opened base graph: what the session answers from, and where it lives. */
export interface RepositoryGraph {
  readonly owner: DatabaseOwner;
  readonly store: GraphStore;
  readonly view: GraphView;
  /** The state folder the graph is kept in. */
  readonly folder: string;
  /** The commit the graph is the graph of. */
  readonly commit: string;
  /** Whether this start built or moved the graph, and how long that took. */
  readonly filled: boolean;
  readonly fillMs: number;
  /** What the fill that built this graph left: the state, and the units that did not publish. */
  readonly fill: FillOutcome | undefined;
  close(): Promise<void>;
}

/** The state root a repository's served graph lives under, overridable for tests. */
export function mcpStateRoot(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const base = env['XDG_STATE_HOME'];
  const root = typeof base === 'string' && base.trim() !== '' ? base : join(homedir(), '.local', 'state');
  return join(root, 'madarch', 'mcp');
}

/**
 * The folder one repository's graph is kept in: the repository's own name and a
 * digest of its absolute path, so two checkouts of one name never share a graph.
 */
export function graphFolder(repository: string, stateRoot: string = mcpStateRoot()): string {
  const absolute = resolve(repository);
  return join(stateRoot, `${basename(absolute).replace(/[^A-Za-z0-9._-]/g, '-')}-${sha256Hex(Buffer.from(absolute, 'utf8')).slice(0, 12)}`);
}

/** A lock a live process holds on a graph folder: the PGlite directory serves one writer at a time. */
export interface FolderLock {
  readonly folder: string;
  readonly pid: number;
}

/**
 * Takes the folder's lock atomically (madarch-ztyq.10 review): the file is created with `O_EXCL`, so two processes
 * that start together against one cache cannot both believe they hold it, and the write that names the holder is a
 * write to the file only this process may have created. A file whose holder is a live process — this one included —
 * is a refusal; a file whose holder is dead, or was never written, is left by a crash and is taken over.
 *
 * The lock is held until the database is closed: `releaseFolderLock` drops it, and only its own.
 */
export function acquireFolderLock(folder: string): FolderLock {
  const absolute = resolve(folder);
  mkdirSync(absolute, { recursive: true });
  const lock = join(absolute, 'server.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
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
        throw new Error(`${lock}:1: the graph folder ${absolute} is already served by process ${pid ?? 'a process that is starting'}; one folder serves one process at a time (src/mcp/graph.ts)`);
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

const MARKER = 'CREATE TABLE IF NOT EXISTS mcp_base (repository TEXT PRIMARY KEY, head TEXT NOT NULL, filled_at TEXT NOT NULL)';

/** The commit the kept graph was built at, or null when it holds none. */
async function markerOf(owner: DatabaseOwner, repository: string): Promise<string | null> {
  const rows = (await owner.run((tx) => tx.query<{ head: string }>('SELECT head FROM mcp_base WHERE repository = $1', [repository]))).rows;
  return rows[0]?.head ?? null;
}

/**
 * The graph a product fill already holds for this repository and commit, when the madarch home has one. A product's
 * knowledge store is filled from the same extraction (decision 0026), so copying it costs a file copy where a cold
 * build costs the whole extraction — which is the difference the review asked for (madarch-ztyq.10 review).
 */
async function reusableStore(repository: string, commit: string, env: DraftEnv): Promise<{ folder: string; product: string } | undefined> {
  const root = defaultKnowledgeRoot(productsHome(env));
  if (!existsSync(root)) return undefined;
  const name = basename(repository);
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    const graph = join(root, entry.name, 'graph');
    if (!existsSync(graph)) continue;
    let owner: DatabaseOwner | undefined;
    try {
      owner = createPGliteDatabaseOwner({ path: graph, btreeGist: true, relaxedDurability: true });
      const rows = (await owner.run((tx) => tx.query<{ repo: string; head: string; commit_hash: string }>('SELECT repo, head, commit_hash FROM knowledge_fill'))).rows;
      const held = rows.find((row) => (row.head === commit || row.commit_hash === commit) && (row.repo === name || resolve(row.repo) === repository));
      if (held !== undefined) return { folder: graph, product: entry.name };
    } catch {
      // A store that cannot be read (another process, or no fill table in it) is not a store this start can reuse.
    } finally {
      if (owner !== undefined) await owner.close().catch(() => undefined);
    }
  }
  return undefined;
}


/** The states a run ends in: nothing further happens to it (decision 0027's run machine). */
const TERMINAL_RUN_STATES: readonly string[] = ['succeeded', 'completed_partial', 'blocked', 'failed', 'cancelled'];

/**
 * The run id a start asks for: the base while no run of that id reached a terminal state, and a numbered
 * successor where one did. A terminal run is never replanned (decision 0027: the next attempt is a new run on
 * the same chain), and a new run inherits the published generations whose cache keys stand.
 */
async function nextRunId(owner: DatabaseOwner, base: string): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    const id = attempt === 1 ? base : `${base}-${attempt}`;
    const held = await readRun(owner, id);
    if (held === null) return id;
    if (!TERMINAL_RUN_STATES.includes(held.state)) return id;
  }
}

/**
 * Fills one repository's graph through the one fill entry (decision 0033, item 1): the wiring of the repository's
 * static stages (`createRepositoryFill`) driven by the orchestrator host over the owner this server holds. The stages
 * are the declared workflow's, the engine's `first-fill`; the contracts stages are not among the ones this build holds
 * (madarch-8bdc.2.4), so the contract tools answer nothing for a served checkout until they land — the answers say
 * they found nothing rather than reporting an empty graph as a graph without contracts.
 *
 * The service is stopped before it is dropped: it owns the queue it declared in this database, and the graph's own
 * reader is opened after it, on the same owner.
 */
async function fillRepositoryGraph(owner: DatabaseOwner, repository: string, folder: string, log: (line: string) => void): Promise<FillOutcome> {
  const fill = await createRepositoryFill({ repository, database: owner });
  const service = createFillOrchestratorService({ home: folder, owner, registry: fill.registry, wiring: () => fill.wiring, workers: 16, maxPasses: 100_000, log });
  // The run's identity names what the run was planned against: the commit, the stages' own versions and the
  // repository's resolved stage settings. A start with another engine or another manifest is a new run on the
  // same chain — decision 0027 plans a run once — and it inherits every published generation whose cache key
  // stands, so a code change costs the changed stages and never the published work of the others.
  // The store's own tables stand before the chain is read: a fresh folder holds no fill_chain yet, and the
  // service creates them on its first run, after this start must know which run it is starting.
  await createFillStateSchema(owner);
  await createOrchestratorSchema(owner);
  const configuration = await fill.wiring.configuration();
  const planned = `${headCommit(repository).slice(0, 12)}-${declaredStagesDigest(fill.registry).slice(0, 12)}-${canonicalJsonDigest(configuration).slice(0, 12)}`;
  const base = `mcp-${planned}`;
  // The folder lock says no other process serves this graph, so a non-terminal run that another configuration
  // planned is a start whose process ended. It is stopped — decision 0027's next attempt is a new run on the
  // same chain — and its published generations are inherited by the new run where their cache keys stand.
  const chain = await readChain(owner, fill.product.name);
  const activeId = chain?.state === 'active' ? chain.context.activeRunId : null;
  if (activeId !== null && activeId !== undefined && activeId !== base) {
    const active = await readRun(owner, activeId);
    if (active !== null && !TERMINAL_RUN_STATES.includes(active.state)) {
      const stopped = await service.control({ productFolder: repository, runId: activeId, action: 'stop', product: fill.product.name });
      if (stopped === null || !stopped.ok) {
        throw new Error(`${folder}:1: the fill of ${repository} holds the dead start's run ${activeId} (${active.state}) and could not stop it: ${stopped === null ? 'the store does not hold it' : `${stopped.code}: ${stopped.reason}`} (src/mcp/graph.ts)`);
      }
      log(`madarch mcp: stopped the dead start's run ${activeId} (${active.state}); its published work is inherited`);
    }
  }
  const runId = await nextRunId(owner, base);
  log(`madarch mcp: filling ${repository} as run ${runId}`);
  try {
    const result = await service.run({ product: fill.product, runId });
    if (!result.ok) throw new Error(`${folder}:1: the fill of ${repository} was refused: ${result.code}: ${result.reason} (src/mcp/graph.ts)`);
    const failed = result.units.filter((unit) => unit.state !== 'published' && unit.state !== 'superseded');
    if (!result.settled) {
      const named = failed.map((unit) => `${unit.unitId} (${unit.state})`);
      throw new Error(`${folder}:1: the fill of ${repository} ended without settling${result.stoppedBecause === undefined ? '' : ` (${result.stoppedBecause})`}: ${named.length === 0 ? 'no unit names a failure' : named.join(', ')} (src/mcp/graph.ts)`);
    }
    // A run that settled short of success is served with what it published: decision 0033 (items 18 and 19)
    // reports partial coverage, and a unit's failure is its own while the other units' work stands. The
    // reason a unit did not publish is read from the run's own durable events, never guessed from its state.
    const reasons = new Map<string, string>();
    for (const event of await readProgress(owner, result.runId)) {
      if (event.unitId !== '' && (event.kind === 'unit-failed' || event.kind === 'unit-blocked')) reasons.set(event.unitId, event.summary);
    }
    return {
      state: result.state,
      failed: failed.map((unit) => ({ unitId: unit.unitId, state: unit.state, reason: reasons.get(unit.unitId) ?? `the unit ended ${unit.state}` })),
    };
  } finally {
    await service.stop();
  }
}

/**
 * Opens the graph of one repository at HEAD, building or moving it when the
 * folder holds no graph of this commit. `store` names the folder a caller keeps
 * the graph in; without one it is under the state root, per repository.
 *
 * A cold build runs every producer the fill runs — the code, the files, the
 * operations, the contracts and the data model — so a graph it answers holds what
 * the tree does, never a silently smaller reading. There is no file count above
 * which it refuses: the fill is the path that must hold any repository, and a
 * machine that runs out of memory is a fill defect to fix, not a reason to leave
 * a repository unserved. A product fill's own graph for the same commit is copied
 * instead of built whenever the madarch home holds one, which is the cheap path
 * for a checkout someone has already filled.
 */
export async function openRepositoryGraph(options: {
  readonly repository: string;
  readonly folder?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly log?: (line: string) => void;
}): Promise<RepositoryGraph> {
  const repository = resolve(options.repository);
  const folder = resolve(options.folder ?? graphFolder(repository, mcpStateRoot(options.env)));
  mkdirSync(folder, { recursive: true });
  const log = options.log ?? (() => {});
  const held = acquireFolderLock(folder);
  const commit = headCommit(repository);
  const owner = createPGliteDatabaseOwner({ path: join(folder, 'graph'), btreeGist: true, relaxedDurability: true });
  const store = createGraphStore(owner);
  try {
    await store.createSchema();
    await owner.exec(MARKER);
    const started = performance.now();
    let filled = false;
    // The outcome the folder's last fill recorded, read before this start decides whether to build: a start that
    // reuses the graph still answers what it is missing.
    let fill = readFillOutcome(folder);
    const marked = await markerOf(owner, repository);
    let view: GraphView | null = null;
    if (marked === commit) {
      try { view = await GraphView.open(owner, store); } catch { view = null; }
    }
    if (view === null) {
      const reused = marked === null ? await reusableStore(repository, commit, options.env ?? process.env) : undefined;
      if (reused !== undefined) {
        log(`madarch mcp: reusing the graph of product ${reused.product} at ${commit.slice(0, 12)}`);
        await owner.close();
        rmSync(join(folder, 'graph'), { recursive: true, force: true });
        cpSync(reused.folder, join(folder, 'graph'), { recursive: true });
        const again = createPGliteDatabaseOwner({ path: join(folder, 'graph'), btreeGist: true, relaxedDurability: true });
        const copied = createGraphStore(again);
        await copied.createSchema();
        await again.exec(MARKER);
        const built = await GraphView.open(again, copied);
        await again.run((tx) => tx.query('INSERT INTO mcp_base (repository, head, filled_at) VALUES ($1, $2, $3) ON CONFLICT (repository) DO UPDATE SET head = $2, filled_at = $3', [repository, commit, new Date().toISOString()]));
        filled = true;
        // A copied product store is a fill's own graph, and its coverage is the fill's: the copy is served as a
        // complete graph only when the product's own run said it succeeded. A store that recorded no such run says
        // nothing, and a start that cannot read it does not claim more than it knows.
        fill = { state: 'succeeded', failed: [] };
        writeFillOutcome(folder, fill);
        log(`madarch mcp: graph reused in ${((performance.now() - started) / 1000).toFixed(1)} s`);
        return {
          owner: again, store: copied, view: built, folder, commit, filled, fillMs: performance.now() - started, fill,
          close: async () => { await again.close(); releaseFolderLock(folder, held); },
        };
      }
      log(`madarch mcp: building the graph of ${repository} at ${commit.slice(0, 12)} in ${folder}`);
      const before = performance.now();
      fill = await fillRepositoryGraph(owner, repository, folder, log);
      writeFillOutcome(folder, fill);
      const built = await GraphView.open(owner, store);
      const after = performance.now();
      await owner.run((tx) => tx.query('INSERT INTO mcp_base (repository, head, filled_at) VALUES ($1, $2, $3) ON CONFLICT (repository) DO UPDATE SET head = $2, filled_at = $3', [repository, commit, new Date().toISOString()]));
      view = built;
      filled = true;
      log(`madarch mcp: graph built in ${((after - before) / 1000).toFixed(1)} s${fill.failed.length === 0 ? '' : `; ${fill.failed.length} ${fill.failed.length === 1 ? 'unit' : 'units'} did not publish (${fill.state})`}`);
    }
    const opened = filled ? 0 : performance.now() - started;
    return {
      owner, store, view, folder, commit, filled, fill,
      fillMs: filled ? performance.now() - started : opened,
      // The lock is dropped after the database is closed, never before: a second process that took the folder while
      // this one was mid-close would open a database another is still shutting down (madarch-ztyq.10 recheck).
      close: async () => { await owner.close(); releaseFolderLock(folder, held); },
    };
  } catch (error) {
    await owner.close().catch(() => undefined);
    releaseFolderLock(folder, held);
    throw error;
  }
}
