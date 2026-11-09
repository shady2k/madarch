/**
 * The digest of a ground (madarch-m38l.8): what a statement stood on at a
 * commit, recomputed from git and never stored in the page file.
 *
 * - a document section: the SHA-256 of its text at the commit;
 * - a symbol (or any node with a declaration span): the SHA-256 of the lines
 *   of its span at the commit, when the span is known for that commit;
 * - otherwise a file or folder: git's object id of the path at the commit (a
 *   blob id for a file, a tree id for a folder), so an edit elsewhere in the
 *   repository changes nothing and an edit inside changes it.
 *
 * A ground whose digest cannot be told (no path, no repository) has the
 * method `none` and no digest; the changed-grounds query reports it as
 * unknown and never as unchanged.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type DigestMethod = 'section' | 'span' | 'object' | 'none';

/** Reads a repository at a commit. */
export interface GitReader {
  /** The text of a file at the commit, or `null` when the path is not a file there. */
  text(commit: string, path: string): Promise<string | null>;
  /** Git's object id of a path at the commit, or `null` when it does not exist there. */
  objectId(commit: string, path: string): Promise<string | null>;
}

export function gitReader(repository: string): GitReader {
  const git = async (args: string[]): Promise<string | null> => {
    try {
      return (await run('git', args, { cwd: repository, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })).stdout;
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? '');
      // `rev-parse --verify --quiet` exits 1 with nothing on stderr for a path that is not there.
      if (stderr.trim() === '' && (error as { code?: unknown }).code === 1) return null;
      if (/exists on disk, but not in|does not exist|bad object|unknown revision|invalid object name|not a valid object name|Needed a single revision|not a tree object/i.test(stderr)) return null;
      throw new Error(`src/knowledge/index/grounds.ts: git ${args.join(' ')} failed in ${repository}: ${stderr.split('\n')[0] || (error as Error).message}`, { cause: error });
    }
  };
  return {
    text: async (commit, path) => {
      const type = await git(['cat-file', '-t', `${commit}:${path}`]);
      if (type === null || type.trim() !== 'blob') return null;
      return await git(['show', `${commit}:${path}`]);
    },
    objectId: async (commit, path) => {
      const id = await git(['rev-parse', '--verify', '--quiet', `${commit}:${path}`]);
      return id === null || id.trim() === '' ? null : id.trim();
    },
  };
}
