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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../adapters/database-owner.js';
import { fillGraph } from '../extract/driver/index.js';
import { TREE_EXTRACTORS } from '../extract/driver/extractors.js';
import { createGraphStore, type GraphStore } from '../graph/index.js';
import { sha256Hex } from '../graph/digest.js';
import { GraphView, ingestContent } from '../writer/view.js';
import { headCommit } from './git.js';

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

/** A refusal to serve a folder another live process holds: two writers of one PGlite folder corrupt it. */
function takeLock(folder: string): void {
  const lock = join(folder, 'server.lock');
  try {
    const held = JSON.parse(readFileSync(lock, 'utf8')) as { pid?: unknown };
    if (typeof held.pid === 'number' && held.pid !== process.pid) {
      let alive = true;
      try { process.kill(held.pid, 0); } catch { alive = false; }
      if (alive) throw new Error(`${lock}:1: the graph folder ${folder} is already served by process ${held.pid}; one folder serves one process at a time (src/mcp/graph.ts)`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  writeFileSync(lock, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), 'utf8');
}

/** Drops the lock this process took, and only this process's. */
function dropLock(folder: string): void {
  try {
    const held = JSON.parse(readFileSync(join(folder, 'server.lock'), 'utf8')) as { pid?: unknown };
    if (held.pid === process.pid) rmSync(join(folder, 'server.lock'), { force: true });
  } catch { /* a lock that is already gone needs no dropping */ }
}

const MARKER = 'CREATE TABLE IF NOT EXISTS mcp_base (repository TEXT PRIMARY KEY, head TEXT NOT NULL, filled_at TEXT NOT NULL)';

/** The commit the kept graph was built at, or null when it holds none. */
async function markerOf(owner: DatabaseOwner, repository: string): Promise<string | null> {
  const rows = (await owner.run((tx) => tx.query<{ head: string }>('SELECT head FROM mcp_base WHERE repository = $1', [repository]))).rows;
  return rows[0]?.head ?? null;
}

/**
 * Opens the graph of one repository at HEAD, building or moving it when the
 * folder holds no graph of this commit. `store` names the folder a caller keeps
 * the graph in; without one it is under the state root, per repository.
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
  takeLock(folder);
  const commit = headCommit(repository);
  const log = options.log ?? (() => {});
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
      log(`madarch mcp: building the graph of ${repository} at ${commit.slice(0, 12)} in ${folder}`);
      const before = performance.now();
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
      close: async () => { dropLock(folder); await owner.close(); },
    };
  } catch (error) {
    dropLock(folder);
    await owner.close().catch(() => undefined);
    throw error;
  }
}
