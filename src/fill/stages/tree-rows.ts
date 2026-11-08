/**
 * The one read a static stage's plan makes of the tree the inventory and the
 * snapshot published, and the one reader of its rows (decision 0026's
 * incrementality; decision 0033's "the file is the unit"). The snapshot stage
 * plans from the pinned tree's own listing and the inventory's published rows,
 * the inventory plans from the same rows, and the syntax stage plans from them
 * too: one reader is what keeps the three from accepting different rows.
 *
 * The read is a JSON document, so a wiring answers it as data and not as prose.
 * A row is a `file` or a `directory` of one repository, with the blob a file
 * stood under at the commit: no origin, no run, no unit.
 */
import { byCodePoint } from '../../model/order.js';
import { isRepositoryPath, repositoryPath } from '../facts.js';

/** The read the plan makes; the wiring answers it from the 0028 graph. */
export const PUBLISHED_TREE_READ = 'stage-1-published-tree';

/**
 * One tracked read of what the graph already holds for a repository's tree: the
 * `code.file` and `code.directory` nodes of the pinned commit.
 */
export function publishedTreeRead(repository: string): string {
  return JSON.stringify({ read: PUBLISHED_TREE_READ, repository });
}

/** One row of that read: a file or directory, as the graph holds it. */
export interface PublishedTreeRow {
  readonly kind: 'directory' | 'file';
  readonly repository: string;
  readonly path: string;
  /** The blob a file's bytes stood under; absent where the node was written before the field existed. */
  readonly blob?: string;
}

/** The keys a row of the read holds, and no others. */
const ROW_FIELDS: readonly string[] = ['blob', 'kind', 'path', 'repository'];

/** What the read answered, as a plan compares against it. */
export interface PublishedTree {
  /** Each published file's path, and the blob it stood under (`undefined` where the row named none). */
  readonly files: ReadonlyMap<string, string | undefined>;
  readonly directories: ReadonlySet<string>;
}

/**
 * The read's rows, read: each row names the repository it was read for, a
 * kind, a repository path and (for a file) the blob it stood under. A row that
 * names another repository, a kind this read does not hold, a path that is no
 * repository path or a blob that is no blob id is refused, naming the read, the
 * row and what was wrong with it — a row read past would plan a wrong unit in
 * silence, and a row dropped would leave a stale node behind.
 */
export function publishedTreeRows(rows: readonly unknown[], repository: string, read: string): PublishedTree {
  const files = new Map<string, string | undefined>();
  const directories = new Set<string>();
  rows.forEach((row, index) => {
    const refuse = (detail: string): Error => new Error(`the read ${read} answered row ${index + 1} for the repository ${JSON.stringify(repository)}, and ${detail}`);
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw refuse(`${JSON.stringify(row)} is no row: a row is an object naming its kind, its repository and its path`);
    }
    const held = row as Record<string, unknown>;
    const kind = held['kind'];
    if (kind !== 'file' && kind !== 'directory') {
      throw refuse(`its kind is ${JSON.stringify(kind)}, and this read holds "file" and "directory"`);
    }
    const named = held['repository'];
    if (named !== repository) {
      throw refuse(`its repository is ${JSON.stringify(named)}, and the read was for ${JSON.stringify(repository)}: one read is one repository`);
    }
    const unknown = Object.keys(held).filter((key) => !ROW_FIELDS.includes(key)).sort(byCodePoint);
    if (unknown.length > 0) {
      throw refuse(`it holds ${unknown.map((key) => JSON.stringify(key)).join(', ')}, and a row holds ${ROW_FIELDS.join(', ')}: a run, a unit, an attempt or a session is none of them`);
    }
    const rawPath = held['path'];
    if (typeof rawPath !== 'string' || !isRepositoryPath(rawPath)) {
      throw refuse(`its path ${JSON.stringify(rawPath)} is no repository path: a path from the repository's root, "/"-separated, with no "." or ".." leg`);
    }
    const path = repositoryPath(rawPath as string);
    // Two rows for one path in one answer are refused rather than resolved by order.
    const twice = files.has(path) || directories.has(path);
    if (twice) throw refuse(`its path ${JSON.stringify(path)} stands in an earlier row of this answer: one read answers one row per path`);
    if (kind === 'directory') {
      if (held['blob'] !== undefined) {
        throw refuse(`it is a folder and carries a blob: a row's blob is the file's bytes, and a folder holds no bytes of its own`);
      }
      directories.add(path);
      return;
    }
    const blob = held['blob'];
    if (blob !== undefined && (typeof blob !== 'string' || !/^[0-9a-f]{40}$/.test(blob))) {
      throw refuse(`its blob ${JSON.stringify(blob)} is no blob id: 40 lower-case hexadecimal digits, or no blob at all`);
    }
    files.set(path, typeof blob === 'string' ? blob : undefined);
  });
  return { files, directories };
}
