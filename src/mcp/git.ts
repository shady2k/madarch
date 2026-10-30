/**
 * A repository as the MCP server reads it: the commit the graph is built at, the
 * files the working tree changes, and the working tree itself as one extractor
 * tree (madarch-ztyq.10). Nothing here decides what a change means; it only
 * names what has changed since the graph's commit, so the layer above can
 * re-extract exactly those files and hide the graph's facts about them.
 *
 * `git status --porcelain -z` is read as the driver reads a commit: paths are
 * `/`-separated and relative to the repository root.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** What the working tree changed about one path, as a reader needs to know it. */
export type DirtyStatus = 'untracked' | 'added' | 'modified' | 'deleted' | 'renamed' | 'conflicted';

/** One path the working tree changes, and how. */
export interface DirtyFile {
  /** The path in the working tree, `/`-separated. */
  readonly path: string;
  readonly status: DirtyStatus;
  /** A rename's source, when git reported one (git is read with `--no-renames`, so it does not). */
  readonly from?: string;
}

/** The repository at the moment one call is answered. */
export interface Revision {
  /** The repository's own absolute path. */
  readonly repository: string;
  /** The commit at HEAD: the commit the base graph is the graph of. */
  readonly commit: string;
  /** The branch HEAD names, or `HEAD` when the checkout is detached. */
  readonly branch: string;
  /** Every path the working tree changes since HEAD, in code point order. */
  readonly dirty: readonly DirtyFile[];
  /** Every path whose content at HEAD is not the working tree's: a dirty file and a rename's source. */
  readonly touched: readonly string[];
}

/** Runs one git command in a repository and answers its bytes. */
function gitBytes(repository: string, args: readonly string[]): Buffer {
  try {
    return execFileSync('git', [...args], { cwd: repository, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' } });
  } catch (error) {
    const failure = error as { stderr?: Buffer | string; status?: number };
    const said = (failure.stderr === undefined ? '' : failure.stderr.toString()).trim();
    throw new Error(`${repository}:1: "git ${args.join(' ')}" failed${failure.status === undefined ? '' : ` with status ${failure.status}`}: ${said === '' ? 'no diagnosis' : said} (src/mcp/git.ts)`);
  }
}

/** The bytes of a path in the working tree, or null when the file is not there. */
export function readWorkingFile(repository: string, path: string): Uint8Array | null {
  const full = resolve(repository, path);
  return existsSync(full) ? readFileSync(full) : null;
}

/** Whether the checkout names a commit at all: an empty repository cannot be served. */
export function hasCommit(repository: string): boolean {
  try {
    gitBytes(repository, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

/** The commit HEAD names. */
export function headCommit(repository: string): string {
  return gitBytes(repository, ['rev-parse', 'HEAD']).toString('utf8').trim();
}

/** The branch HEAD names, or `HEAD` when it names no branch. */
export function headBranch(repository: string): string {
  try {
    return gitBytes(repository, ['symbolic-ref', '--short', '-q', 'HEAD']).toString('utf8').trim();
  } catch {
    return 'HEAD';
  }
}

/** The status a porcelain entry names, by its two columns and whether the file is on disk. */
function statusOf(index: string, worktree: string, present: boolean): DirtyStatus {
  if (index === '?' && worktree === '?') return 'untracked';
  if (index === 'U' || worktree === 'U' || (index === 'A' && worktree === 'A') || (index === 'D' && worktree === 'D')) return 'conflicted';
  if (index === 'R' || worktree === 'R' || index === 'C' || worktree === 'C') return 'renamed';
  if (index === 'D' || worktree === 'D') return present ? 'modified' : 'deleted';
  if (index === 'A') return 'added';
  return 'modified';
}

/**
 * The paths the working tree changed since HEAD, read from git's own porcelain
 * format: one `XY path` field per change, NUL-terminated.
 */
export function dirtyFiles(repository: string): DirtyFile[] {
  const text = gitBytes(repository, ['status', '--porcelain', '-z', '--untracked-files=all', '--no-renames']).toString('utf8');
  const fields = text.split('\0');
  const dirty: DirtyFile[] = [];
  for (const entry of fields) {
    if (entry === '') continue;
    if (entry.length < 4) throw new Error(`${repository}:1: "git status --porcelain -z" answered ${JSON.stringify(entry)}, which is no status entry (src/mcp/git.ts)`);
    const path = entry.slice(3);
    // --no-renames keeps a rename as a deletion and an addition, so every field is one path.
    dirty.push({ path, status: statusOf(entry[0]!, entry[1]!, existsSync(resolve(repository, path))) });
  }
  return dirty.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

const ordered = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/** The repository as one call reads it: HEAD, its branch, and what the working tree changed. */
export function readRevision(repository: string): Revision {
  const commit = headCommit(repository);
  const dirty = dirtyFiles(repository);
  const touched = [...new Set(dirty.flatMap((one) => (one.from === undefined ? [one.path] : [one.path, one.from])))].sort(ordered);
  return { repository, commit, branch: headBranch(repository), dirty, touched };
}

/** One repository tree as an extractor reads it: the working tree's paths and bytes. */
export interface WorkingTree {
  readonly paths: readonly string[];
  read(path: string): Uint8Array;
}

/**
 * The working tree as one tree: the index's paths and the untracked ones git
 * does not ignore, in code point order, as the driver hands a commit's tree to
 * an extractor. A path that is not on disk is not in the tree — a deleted file
 * is a file the working tree no longer has.
 */
export function workingTree(repository: string): WorkingTree {
  const listed = gitBytes(repository, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).toString('utf8').split('\0');
  const paths = [...new Set(listed.filter((path) => path !== ''))].filter((path) => existsSync(resolve(repository, path))).sort(ordered);
  return {
    paths,
    read: (path: string): Uint8Array => {
      const bytes = readWorkingFile(repository, path);
      if (bytes === null) throw new Error(`${resolve(repository, path)}:1: the working tree holds no such file (src/mcp/git.ts)`);
      return bytes;
    },
  };
}
