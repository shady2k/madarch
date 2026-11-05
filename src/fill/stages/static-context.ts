/**
 * The static stage context (decision 0033, "Capability boundaries" and "The
 * file is the unit of static work"): what a deterministic stage is handed
 * instead of a tree reader — one repository pinned at one commit, one file's
 * bytes below a size cap, path-scoped lookups for the file's own imports, and
 * bounded reads of the 0028 graph.
 *
 * A static stage never holds a `SnapshotSource`, a `SnapshotReader`, a
 * `GraphStore` or an extractor's repository-wide object. The wiring opens the
 * pinned tree and the graph store; the stage receives one file's bytes, a
 * path-scoped entry, a path-scoped folder answer, and three bounded graph
 * queries: by key, by global name, and one bounded neighbourhood. No answer is
 * a whole repository, and no query can widen its own row cap.
 *
 * The cap is a fact of the context and not a stage's courtesy: a file above
 * `STATIC_FILE_BYTE_LIMIT` answers its metadata and no bytes, and a stage
 * publishes that file as a `too-large` coverage gap. A stage never sees the
 * bytes it did not read, so a truncated file cannot be parsed as if it were
 * whole.
 */
import type { GraphStore, NodeVersionRow, PageOptions } from '../../graph/index.js';
import type { FactSource, RepositoryForm } from '../facts.js';
import type { SnapshotEntry, SnapshotReader, SnapshotSource } from '../snapshot.js';

/** The most bytes one file's reading holds: 1 MiB, the cap a static unit reads under. */
export const STATIC_FILE_BYTE_LIMIT = 1_048_576;

/** The most rows one bounded graph read answers. */
export const STATIC_READ_ROW_LIMIT = 256;

/** One entry of a pinned tree, as a static stage sees it: no mode, no machine path. */
interface StaticTreeEntry {
  readonly path: string;
  readonly form: 'blob' | 'link' | 'commit';
  /** The object git holds: a blob id or a submodule's commit. */
  readonly id: string;
  /** The object's size, as the tree states it; absent for a submodule's commit. */
  readonly bytes?: number;
}

/** One file at the pinned commit, its bytes read only below the cap. */
interface StaticFile extends StaticTreeEntry {
  readonly repository: string;
  readonly commit: string;
  /**
   * The file's bytes, absent when `unread` says why: a submodule stands in
   * another repository, and a file above `STATIC_FILE_BYTE_LIMIT` is not read
   * as a whole. A symbolic link's blob is the path it points at, and it is read
   * like any other small blob; the stage that parses source text refuses it by
   * its form, not this source.
   */
  readonly content?: Uint8Array;
  readonly unread?: 'too-large' | 'unsupported';
}

/**
 * One pinned repository as a stage's context reads it: every answer scoped to a
 * path. The tree's scalars — its id, how many files and bytes it holds — are
 * metadata, not a reader: they let the snapshot stage publish the commit it read
 * without listing the tree.
 */
export interface StaticStageSource {
  readonly repository: string;
  readonly commit: string;
  readonly form: RepositoryForm;
  readonly defaultBranch?: string;
  readonly source: FactSource;
  /** The git tree id the pinned commit stands on. */
  readonly tree: string;
  readonly fileCount: number;
  readonly byteCount: number;
  /** One path's entry, or none: no tree listing is handed out. */
  entry(path: string): Promise<StaticTreeEntry | undefined>;
  /** One file's metadata and, below the cap, its bytes. */
  file(path: string): Promise<StaticFile | undefined>;
  /** Whether the pinned tree holds a file under the folder: a path-scoped answer. */
  holdsDirectory(path: string): Promise<boolean>;
}

/** One node a bounded graph read answered: its identity, kind, label and properties, never a whole table. */
export interface StaticGraphNode {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly producer: string;
  readonly scope: string;
}

/**
 * One page of a graph read: the rows it answered, in node id order, and the
 * cursor that asks for the next page — `null` where this page is the last.
 */
interface StaticGraphPage {
  readonly rows: readonly StaticGraphNode[];
  readonly next: string | null;
}

/** How a static stage reads the graph: three bounded questions, each answered as one page or refused. */
export interface StaticGraphReader {
  /** The nodes whose current version carries this `recordKey`. */
  byKey(key: string, options?: { readonly limit?: number }): Promise<readonly StaticGraphNode[]>;
  /** The symbols whose global name is this name. */
  byGlobalName(name: string, options?: { readonly limit?: number }): Promise<readonly StaticGraphNode[]>;
  /**
   * One bounded page of the nodes reachable from `nodeId` through `relations`,
   * from `after` on, with the cursor of the page after it. A list longer than
   * one page is read page by page, each page its own bounded query: a file
   * mentions as many names as its bytes hold, the cap bounds one answer, and
   * no page is wider than the cap whatever it points at.
   */
  neighbourhood(nodeId: string, options: { readonly relations: readonly string[]; readonly direction: 'out' | 'in'; readonly limit?: number; readonly after?: string }): Promise<StaticGraphPage>;
}

/** What one static unit's context holds: its repository, its graph reads, and nothing wider. */
export interface StaticStageContext extends StaticGraphReader {
  readonly repository: StaticStageSource;
}

/** One snapshot entry as the static context hands it out: the path, the form, the object and its size. */
function treeEntryOf(entry: SnapshotEntry): StaticTreeEntry {
  return { path: entry.path, form: entry.form, id: entry.id, ...(entry.bytes === undefined ? {} : { bytes: entry.bytes }) };
}

/** The reader's source, as a fact's provenance names it: git and the version it runs. */
function sourceOf(reader: SnapshotReader): FactSource {
  return { system: reader.source.system, version: reader.source.version };
}

/**
 * Opens one pinned repository as a static stage's source. The reader is opened
 * here and only its path-scoped answers leave this module; the stage never
 * holds it, and no whole-tree reading exists to be asked for.
 */
export async function staticStageSourceOf(sources: SnapshotSource, repository: string): Promise<StaticStageSource> {
  const reader = await sources.open(repository);
  return {
    repository: reader.repository,
    commit: reader.commit,
    form: reader.form,
    ...(reader.defaultBranch === undefined ? {} : { defaultBranch: reader.defaultBranch }),
    source: sourceOf(reader),
    tree: reader.tree,
    fileCount: reader.fileCount,
    byteCount: reader.byteCount,
    async entry(path: string): Promise<StaticTreeEntry | undefined> {
      const entry = reader.entry(path);
      return entry === undefined ? undefined : treeEntryOf(entry);
    },
    async file(path: string): Promise<StaticFile | undefined> {
      const entry = reader.entry(path);
      if (entry === undefined) return undefined;
      const held = { repository: reader.repository, commit: reader.commit, ...treeEntryOf(entry) };
      if (entry.form === 'commit') return { ...held, unread: 'unsupported' };
      if (entry.bytes !== undefined && entry.bytes > STATIC_FILE_BYTE_LIMIT) return { ...held, unread: 'too-large' };
      const bytes = await reader.read(entry.path);
      if (bytes.byteLength > STATIC_FILE_BYTE_LIMIT) return { ...held, unread: 'too-large' };
      return { ...held, content: bytes };
    },
    async holdsDirectory(path: string): Promise<boolean> {
      const prefix = `${path}/`;
      return reader.files().some((entry) => String(entry.path).startsWith(prefix));
    },
  };
}

/** One read's cap: a positive whole number no larger than the context's own. */
function staticReadLimit(limit: number | undefined): number {
  const held = limit ?? STATIC_READ_ROW_LIMIT;
  if (!Number.isInteger(held) || held < 1 || held > STATIC_READ_ROW_LIMIT) {
    throw new Error(`a static stage's graph read asked for ${String(held)} rows, and a static read answers 1 to ${String(STATIC_READ_ROW_LIMIT)} rows: a wider answer is no bounded read (decision 0033; src/fill/stages/static-context.ts)`);
  }
  return held;
}

/** The name of the tracked read a static stage's bounded graph query is recorded as. */
export const STATIC_GRAPH_READ = 'stage-static-graph';

/** The text one bounded static graph read is recorded and rechecked under. */
export function staticGraphRead(input: { readonly kind: 'key' | 'globalName' | 'neighbourhood'; readonly value: string; readonly limit: number; readonly relations?: readonly string[]; readonly direction?: 'out' | 'in'; readonly after?: string }): string {
  return JSON.stringify({ read: STATIC_GRAPH_READ, ...input });
}

/** One node row as a static stage sees it. */
export function staticNodeOf(row: NodeVersionRow): StaticGraphNode {
  return {
    id: row.nodeId,
    kind: row.kind,
    label: row.label,
    properties: (row.properties !== null && typeof row.properties === 'object' ? row.properties : {}) as Readonly<Record<string, unknown>>,
    producer: row.producer,
    scope: row.scope,
  };
}

/** The graph store's own reads, bounded, as a static stage asks them. */
export function staticGraphReaderOf(store: Pick<GraphStore, 'byKey' | 'byGlobalName' | 'neighbourhood'>): StaticGraphReader {
  const page = async (read: Promise<{ rows: readonly NodeVersionRow[]; next: string | null }>, limit: number, what: string): Promise<readonly StaticGraphNode[]> => {
    const answered = await read;
    if (answered.next !== null || answered.rows.length > limit) {
      throw new Error(`the static stage's ${what} answered more than ${String(limit)} nodes: a static stage reads a bounded answer, never a repository-wide one (decision 0033; src/fill/stages/static-context.ts)`);
    }
    return answered.rows.map(staticNodeOf);
  };
  return {
    async byKey(key: string, options?: { readonly limit?: number }): Promise<readonly StaticGraphNode[]> {
      const limit = staticReadLimit(options?.limit);
      if (key.trim() === '') throw new Error('a graph key is a non-empty key: a node asked for by no key names nothing (src/fill/stages/static-context.ts)');
      return await page(store.byKey(key, { limit }), limit, `read by key ${JSON.stringify(key)}`);
    },
    async byGlobalName(name: string, options?: { readonly limit?: number }): Promise<readonly StaticGraphNode[]> {
      const limit = staticReadLimit(options?.limit);
      if (name.trim() === '') throw new Error('a global name is a non-empty name: the symbol a static stage resolves by an empty name names nothing (src/fill/stages/static-context.ts)');
      return await page(store.byGlobalName(name, { limit }), limit, `read by global name ${JSON.stringify(name)}`);
    },
    async neighbourhood(nodeId: string, options: { readonly relations: readonly string[]; readonly direction: 'out' | 'in'; readonly limit?: number; readonly after?: string }): Promise<StaticGraphPage> {
      const limit = staticReadLimit(options.limit);
      if (options.relations.length === 0) throw new Error('a neighbourhood names the relations it follows: a traversal of no relation reaches nothing (src/fill/stages/static-context.ts)');
      const asked = options.after === undefined ? { limit } : { limit, after: options.after };
      const answered = await store.neighbourhood(nodeId, options.relations, options.direction, asked);
      if (answered.rows.length > limit) {
        throw new Error(`the static stage's neighbourhood of ${JSON.stringify(nodeId)} answered more than ${String(limit)} nodes: a static stage reads a bounded answer, never a repository-wide one (decision 0033; src/fill/stages/static-context.ts)`);
      }
      return { rows: answered.rows.map(staticNodeOf), next: answered.next };
    },
  };
}

/**
 * The context a static unit runs in: the host's pinned repository, and the
 * bounded graph reads this attempt records as its dependencies. Every read is
 * capped here, after the graph answered and before the stage sees the rows, so
 * a read that would answer more fails rather than handing the stage a window
 * whose edge it cannot see.
 */
export function staticStageContext(repository: StaticStageSource, graph: StaticGraphReader): StaticStageContext {
  const bounded = async (rows: readonly StaticGraphNode[], limit: number, what: string): Promise<readonly StaticGraphNode[]> => {
    if (rows.length > limit) {
      throw new Error(`the bounded read of the static stage answered ${String(rows.length)} rows where the cap is ${String(limit)} (${what}): a static stage reads a bounded answer, never a repository-wide one (decision 0033; src/fill/stages/static-context.ts)`);
    }
    return rows;
  };
  return {
    repository,
    async byKey(key: string, options?: { readonly limit?: number }): Promise<readonly StaticGraphNode[]> {
      const limit = staticReadLimit(options?.limit);
      if (key.trim() === '') throw new Error('a graph key is a non-empty key: a node asked for by no key names nothing (src/fill/stages/static-context.ts)');
      return await bounded(await graph.byKey(key, { limit }), limit, `by key ${JSON.stringify(key)}`);
    },
    async byGlobalName(name: string, options?: { readonly limit?: number }): Promise<readonly StaticGraphNode[]> {
      const limit = staticReadLimit(options?.limit);
      if (name.trim() === '') throw new Error('a global name is a non-empty name: the symbol a static stage resolves by an empty name names nothing (src/fill/stages/static-context.ts)');
      return await bounded(await graph.byGlobalName(name, { limit }), limit, `by global name ${JSON.stringify(name)}`);
    },
    async neighbourhood(nodeId: string, options: { readonly relations: readonly string[]; readonly direction: 'out' | 'in'; readonly limit?: number; readonly after?: string }): Promise<StaticGraphPage> {
      const limit = staticReadLimit(options.limit);
      if (options.relations.length === 0) throw new Error('a neighbourhood names the relations it follows: a traversal of no relation reaches nothing (src/fill/stages/static-context.ts)');
      const answered = await graph.neighbourhood(nodeId, { ...options, limit });
      return await bounded(answered.rows, limit, `neighbourhood of ${JSON.stringify(nodeId)}`).then((rows) => ({ rows, next: answered.next }));
    },
  };
}
