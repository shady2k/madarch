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
import { withSpanSync } from '../obs/trace.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** What the working tree changed about one path, as a reader needs to know it. */
type DirtyStatus = 'untracked' | 'added' | 'modified' | 'deleted' | 'renamed' | 'conflicted';

/** One path the working tree changes, and how. */
interface DirtyFile {
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
    return withSpanSync('process.git', { 'process.command': 'git', 'process.args': [...args], 'process.cwd': repository }, (span) => {
      const answer = execFileSync('git', [...args], { cwd: repository, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' } });
      span.setAttribute('process.outputBytes', answer.length);
      span.setAttribute('process.exitCode', 0);
      return answer;
    });
  } catch (error) {
    const failure = error as { stderr?: Buffer | string; status?: number };
    const said = (failure.stderr === undefined ? '' : failure.stderr.toString()).trim();
    throw new Error(`${repository}:1: "git ${args.join(' ')}" failed${failure.status === undefined ? '' : ` with status ${failure.status}`}: ${said === '' ? 'no diagnosis' : said} (src/mcp/git.ts)`);
  }
}



/** The commit HEAD names. */
export function headCommit(repository: string): string {
  return gitBytes(repository, ['rev-parse', 'HEAD']).toString('utf8').trim();
}

/** The branch HEAD names, or `HEAD` when it names no branch. */
function headBranch(repository: string): string {
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
function dirtyFiles(repository: string): DirtyFile[] {
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
