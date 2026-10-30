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
import { fillGraph } from '../extract/driver/index.js';
import { TREE_EXTRACTORS } from '../extract/driver/extractors.js';
import { codeLanguageOf } from '../extract/code/source.js';
import { createGraphStore, type GraphStore } from '../graph/index.js';
import { sha256Hex } from '../graph/digest.js';
import { defaultKnowledgeRoot } from '../knowledge/product.js';
import { productsHome, type DraftEnv } from '../product/home.js';
import { GraphView, ingestContent } from '../writer/view.js';
import { headCommit, workingTree } from './git.js';

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
 * The code files a cold build may have. A cold build runs **every** producer the fill runs — the code, the files,
 * the operations, the contracts and the data model — because a graph missing a contract's operations or a
 * migration's tables answers refusals for entities that exist, and that is worse than no graph at all
 * (madarch-ztyq.10 recheck). The contract and data-model extractors read the tree's expression facts, which are what
 * a cold build cannot bound: measured on this 6 GB machine, 300 code files with the facts peak at 2 145 MB, the fact
 * view of 898 files took the process past 3 GB, and the full checkout's 1 041 files were killed at 3 164 MB anon-rss.
 * So a tree above this bound is refused, with the count, the bound, those measurements and what to serve instead.
 * The number is the measurement, not a guess: a tree up to this size fits the facts in about 2 GB.
 */
export const COLD_BUILD_CODE_FILES = 400;

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

/**
 * Opens the graph of one repository at HEAD, building or moving it when the
 * folder holds no graph of this commit. `store` names the folder a caller keeps
 * the graph in; without one it is under the state root, per repository.
 *
 * A cold build runs every producer and is bounded (madarch-ztyq.10 recheck): the
 * graph of a tree whose code files exceed `COLD_BUILD_CODE_FILES` is refused with
 * the count, the bound and what to serve instead, never built without the contract
 * and data-model producers the tree's facts pay for. A product fill's own graph for
 * the same commit is copied instead of built whenever the madarch home holds one,
 * which is the cheap path for a checkout someone has already filled.
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
        const content = await ingestContent(again, copied, built, repository);
        if (content.skipped.length > 0) log(`madarch mcp: ${content.skipped.length} file(s) have no stored text: ${content.skipped.slice(0, 5).map((one) => `${one.path} (${one.reason})`).join('; ')}${content.skipped.length > 5 ? ' …' : ''}`);
        await again.run((tx) => tx.query('INSERT INTO mcp_base (repository, head, filled_at) VALUES ($1, $2, $3) ON CONFLICT (repository) DO UPDATE SET head = $2, filled_at = $3', [repository, commit, new Date().toISOString()]));
        filled = true;
        log(`madarch mcp: graph reused in ${((performance.now() - started) / 1000).toFixed(1)} s`);
        return {
          owner: again, store: copied, view: built, folder, commit, filled, fillMs: performance.now() - started,
          close: async () => { await again.close(); releaseFolderLock(folder, held); },
        };
      }
      const tree = workingTree(repository);
      const codeFiles = tree.paths.filter((path) => codeLanguageOf(path) !== undefined).length;
      if (codeFiles > COLD_BUILD_CODE_FILES) {
        throw new Error(`${folder}:1: the graph of ${repository} would read ${codeFiles} code files, and a cold build here is bounded to ${COLD_BUILD_CODE_FILES} because a cold build runs every producer and their facts do not fit this machine's memory (measured: 300 files with the facts peak at 2 145 MB, 898 files took the process past 3 GB, and the full checkout's 1 041 files were killed at 3 164 MB on this 6 GB machine); serve a graph that exists instead — name the folder a fill built with --store, or fill this repository with \`madarch fill\` so its product store is reused (src/mcp/graph.ts)`);
      }
      log(`madarch mcp: building the graph of ${repository} at ${commit.slice(0, 12)} in ${folder} (${codeFiles} code files)`);
      const before = performance.now();
      // Every producer, not a subset: a graph without the contract's operations or the migration's tables is not a
      // smaller answer, it is a wrong one (madarch-ztyq.10 recheck).
      await fillGraph({ owner, store, repository, extractors: TREE_EXTRACTORS });
      // The answers quote code and documents, and both are read from the graph's content nodes rather than from the
      // repository (decision 0026); the fill lists the files, so the text is stored once, here, right after it.
      const built = await GraphView.open(owner, store);
      const content = await ingestContent(owner, store, built, repository);
      if (content.skipped.length > 0) log(`madarch mcp: ${content.skipped.length} file(s) have no stored text: ${content.skipped.slice(0, 5).map((one) => `${one.path} (${one.reason})`).join('; ')}${content.skipped.length > 5 ? ' …' : ''}`);
      const after = performance.now();
      await owner.run((tx) => tx.query('INSERT INTO mcp_base (repository, head, filled_at) VALUES ($1, $2, $3) ON CONFLICT (repository) DO UPDATE SET head = $2, filled_at = $3', [repository, commit, new Date().toISOString()]));
      view = built;
      filled = true;
      log(`madarch mcp: graph built in ${((after - before) / 1000).toFixed(1)} s`);
    }
    const opened = filled ? 0 : performance.now() - started;
    return {
      owner, store, view, folder, commit, filled,
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
