
/**
 * The static stage context (decision 0033, "Capability boundaries" and "The
 * file is the unit of static work"): what a deterministic stage is handed
 * instead of a tree reader — one repository pinned at one commit, one file's
 * bytes below a size cap, path-scoped lookups for the file's own imports, and
 * bounded reads of the graph.
 *
 * A static stage never holds a `SnapshotSource`, a `SnapshotReader` or an
 * extractor's repository-wide object: the wiring reads the pinned tree, and the
 * stage receives the answers its unit needs. The whole-tree reading exists for
 * one stage only, the snapshot stage, which names its unit after a repository
 * and whose work is the reading itself; it asks for `repositoryTree()`. Every
 * other static stage reads `file`, `entry` and `holdsDirectory`, each answer
 * scoped to one path, and bounded graph reads.
 *
 * The cap is a fact of the context and not a stage's courtesy: a file above
 * `STATIC_FILE_BYTE_LIMIT` answers its metadata and no bytes, and a stage
 * publishes that file as a `too-large` coverage gap. A stage never sees the
 * bytes it did not read, so a truncated file cannot be parsed as if it were
 * whole.
 */
import type { FactSource, RepositoryForm } from '../facts.js';
import type { SnapshotEntry, SnapshotReader, SnapshotSource } from '../snapshot.js';

/** The most bytes one file's reading holds: 1 MiB, the cap a static unit reads under. */
export const STATIC_FILE_BYTE_LIMIT = 1_048_576;

/** The most rows one bounded graph read answers. */
export const STATIC_READ_ROW_LIMIT = 256;

/** One entry of a pinned tree, as a static stage sees it: no mode, no machine path. */
export interface StaticTreeEntry {
  readonly path: string;
  readonly form: 'blob' | 'link' | 'commit';
  /** The object git holds: a blob id or a submodule's commit. */
  readonly id: string;
  /** The object's size, as the tree states it; absent for a submodule's commit. */
  readonly bytes?: number;
}

/** One file at the pinned commit, its bytes read only below the cap. */
export interface StaticFile extends StaticTreeEntry {
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

/** One repository's whole reading: what the snapshot stage publishes. */
export interface StaticRepositoryTree {
  readonly repository: string;
  readonly form: RepositoryForm;
  readonly commit: string;
  readonly defaultBranch?: string;
  readonly source: FactSource;
  /** The git tree id the reading stands on. */
  readonly tree: string;
  readonly fileCount: number;
  readonly byteCount: number;
  /** Every entry, in code point order of the paths; a submodule's commit among them. */
  readonly entries: readonly StaticTreeEntry[];
  /** The entries the tree holds whose path no fact can name, with the reader's own reason. */
  readonly unfiled: readonly { readonly path: string; readonly why: string }[];
}

/** One pinned repository as a stage's context reads it: every answer scoped to a path. */
export interface StaticStageSource {
  readonly repository: string;
  readonly commit: string;
  readonly form: RepositoryForm;
  readonly defaultBranch?: string;
  readonly source: FactSource;
  /** One path's entry, or none: no tree listing is handed out. */
  entry(path: string): Promise<StaticTreeEntry | undefined>;
  /** One file's metadata and, below the cap, its bytes. */
  file(path: string): Promise<StaticFile | undefined>;
  /** Whether the pinned tree holds a file under the folder: a path-scoped answer. */
  holdsDirectory(path: string): Promise<boolean>;
  /** The snapshot stage's reading of the whole repository; no other stage is handed it. */
  repositoryTree(): Promise<StaticRepositoryTree>;
}

/** What a stage reads the graph through: the rows one bounded read answered, never a whole table. */
export interface StaticGraphReader {
  /**
   * One read of the pinned graph, at most `limit` rows (the context's own cap
   * when none is named). A read that would answer more is refused by name: an
   * answer cut in silence would let a stage write from a window it could not
   * see the end of.
   */
  read(text: string, options?: { readonly limit?: number }): Promise<readonly unknown[]>;
  /**
   * The symbols whose global name is `name`, in code point order of their
   * facts, at most `limit`: cross-file links are resolved per file through this
   * query and never from an in-memory table of the repository.
   */
  byGlobalName(name: string, options?: { readonly limit?: number }): Promise<readonly unknown[]>;
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
 * holds it. `repositoryTree()` is the one whole-repository answer, and the
 * stage declares it for the snapshot stage alone.
 */
export async function staticStageSourceOf(sources: SnapshotSource, repository: string): Promise<StaticStageSource> {
  const reader = await sources.open(repository);
  return {
    repository: reader.repository,
    commit: reader.commit,
    form: reader.form,
    ...(reader.defaultBranch === undefined ? {} : { defaultBranch: reader.defaultBranch }),
    source: sourceOf(reader),
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
    async repositoryTree(): Promise<StaticRepositoryTree> {
      return {
        repository: reader.repository,
        form: reader.form,
        commit: reader.commit,
        ...(reader.defaultBranch === undefined ? {} : { defaultBranch: reader.defaultBranch }),
        source: sourceOf(reader),
        tree: reader.tree,
        fileCount: reader.fileCount,
        byteCount: reader.byteCount,
        entries: reader.entries().map(treeEntryOf),
        unfiled: reader.unfiled().map((entry) => ({ path: entry.path, why: entry.why })),
      };
    },
  };
}

/** One read's cap: a positive whole number no larger than the context's own. */
export function staticReadLimit(limit: number | undefined): number {
  const held = limit ?? STATIC_READ_ROW_LIMIT;
  if (!Number.isInteger(held) || held < 1 || held > STATIC_READ_ROW_LIMIT) {
    throw new Error(`a static stage's graph read asked for ${String(held)} rows, and a static read answers 1 to ${String(STATIC_READ_ROW_LIMIT)} rows: a wider answer is no bounded read (decision 0033; src/fill/stages/static-context.ts)`);
  }
  return held;
}

/**
 * The context a static unit runs in: the host's pinned repository, and the
 * graph reads this attempt records as its dependencies. Both reads are capped
 * here, after the graph answered and before the stage sees the rows, so a read
 * that would answer more fails rather than handing the stage a window whose
 * edge it cannot see.
 */
export function staticStageContext(repository: StaticStageSource, graph: { query(text: string): Promise<readonly unknown[]> }): StaticStageContext {
  const read = async (text: string, options?: { readonly limit?: number }): Promise<readonly unknown[]> => {
    const limit = staticReadLimit(options?.limit);
    const rows = await graph.query(text);
    if (rows.length > limit) {
      throw new Error(`the bounded read of the static stage answered ${String(rows.length)} rows where the cap is ${String(limit)}: a static stage reads a bounded answer, never a repository-wide one (decision 0033; src/fill/stages/static-context.ts; the read was ${JSON.stringify(text.length > 160 ? `${text.slice(0, 159)}…` : text)})`);
    }
    return rows;
  };
  return {
    repository,
    read,
    async byGlobalName(name: string, options?: { readonly limit?: number }): Promise<readonly unknown[]> {
      if (name.trim() === '') throw new Error('a global name is a non-empty name: the symbol a static stage resolves by an empty name names nothing (src/fill/stages/static-context.ts)');
      const limit = staticReadLimit(options?.limit);
      const rows = await read(JSON.stringify({ read: 'facts-with', kind: 'symbol', field: 'globalName', value: name }), { limit });
      const mine = rows.filter((row) => row !== null && typeof row === 'object' && (row as { value?: { repository?: unknown } }).value?.repository === repository.repository);
      if (mine.length > limit) throw new Error(`the global name ${JSON.stringify(name)} names ${String(mine.length)} symbols of ${JSON.stringify(repository.repository)} where the cap is ${String(limit)} (src/fill/stages/static-context.ts)`);
      return mine;
    },
  };
}
