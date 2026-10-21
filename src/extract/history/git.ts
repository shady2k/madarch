/**
 * What the history extractor reads from a repository's own Git: the plain log
 * walks (`git log` with `--name-status -M`, once over the whole default branch
 * and once over its first-parent line), the trees of the snapshots the caller
 * pins and the bytes of one blob. Every call runs with `TZ=UTC` and `LC_ALL=C`
 * through `child_process.execFileSync`, and nothing here computes: the records
 * and their dates are computed from these raw facts by the other modules.
 */
import {execFileSync} from 'node:child_process';

/** The record separator of the log format (`%x1e`) and the field separator (`%x1f`). */
export const LOG_RECORD = '\x1e';
export const LOG_FIELD = '\x1f';

/**
 * The log format: `%x1e` opens each record, the fields are joined by `%x1f`
 * (hash, parents, committer time, author time, author name, subject, whole
 * message), the message is last and one more `%x1f` follows it, so git's
 * `--name-status -z` list hangs behind the last field separator instead of
 * being read as a field.
 */
const LOG_FORMAT = '%x1e%H%x1f%P%x1f%ct%x1f%at%x1f%an%x1f%s%x1f%B%x1f';

/** The most one git call may answer: a whole history with its paths. */
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

/** The environment every git call runs under: fixed times, fixed collation, no loader variables of a caller. */
const GIT_ENV: NodeJS.ProcessEnv = {PATH: process.env.PATH ?? '', TZ: 'UTC', LC_ALL: 'C', LANG: 'C'};

const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

/** One changed path of one commit, as `--name-status -M` writes it. */
export interface LogChange {
  /** The status letter pair git writes: `A`, `M`, `D`, `T`, `U`, `X`, `B`, or `R`/`C` with a similarity percent. */
  readonly status: string;
  /** The path (an added, modified or deleted path) or the two paths of a rename or copy. */
  readonly paths: readonly string[];
  /** The similarity of an `R`/`C` entry as a fraction: `R100` is `1`, content kept. */
  readonly similarity?: number;
}

/** One commit of one walk, exactly as git reported it. */
export interface LogEntry {
  /** The commit: 40 lower-case hexadecimal digits. */
  readonly commit: string;
  /** The parents in git's own order, the first parent first; empty at a root. */
  readonly parents: readonly string[];
  /** The committer time, whole seconds since the epoch. */
  readonly committedAt: number;
  /** The author time, whole seconds since the epoch. */
  readonly authoredAt: number;
  /** The name the commit was authored under. */
  readonly author: string;
  /** The subject line. */
  readonly subject: string;
  /** The whole message, the subject's bytes included. */
  readonly message: string;
  /** The paths the commit changed; merge commits list none, as `git log` shows them no diff of their own. */
  readonly changes: readonly LogChange[];
}

/** One file of one tree: its repository path and the blob that holds its bytes. */
export interface TreeEntry {
  readonly path: string;
  readonly blob: string;
}

/** One failed git call says where it ran, what was asked and what git answered. */
function gitFailure(what: string, repository: string, args: readonly string[], error: unknown): Error {
  const failed = error as {status?: unknown; code?: unknown; message?: unknown};
  const status = typeof failed.status === 'number' ? `exited ${failed.status}` : `could not be run: ${String(failed.message ?? failed.code)}`;
  const words = execFileSyncStderr(error).replace(/\s+/gu, ' ').trim();
  return new Error(`${what}: git ${['-C', repository, ...args].join(' ')} ${status}${words === '' ? '' : `: ${words}`}`);
}

/** git's own words of a failed `execFileSync` call, empty where it never ran far enough to say any. */
function execFileSyncStderr(error: unknown): string {
  const stderr = (error as {stderr?: unknown}).stderr;
  return typeof stderr === 'string' ? stderr : '';
}

/** Runs git in the repository and returns its standard output as text. */
export function runGit(what: string, repository: string, args: readonly string[]): string {
  try {
    return execFileSync('git', ['-C', repository, ...args], {encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, env: GIT_ENV});
  } catch (error) {
    throw gitFailure(what, repository, args, error);
  }
}

/** Runs git in the repository and returns its standard output as bytes (a blob's content). */
export function runGitBytes(what: string, repository: string, args: readonly string[]): Buffer {
  try {
    return execFileSync('git', ['-C', repository, ...args], {maxBuffer: GIT_MAX_BUFFER, env: GIT_ENV});
  } catch (error) {
    throw gitFailure(what, repository, args, error);
  }
}

/** The default branch's own name, as the repository's `HEAD` stands on it. */
export function defaultBranch(repository: string): string {
  const what = 'the history extractor reads the default branch';
  const branch = runGit(what, repository, ['symbolic-ref', '--short', 'HEAD']).trim();
  if (branch === '' || branch === 'HEAD') {
    throw new Error(`${what}: ${repository} has no branch under HEAD (detached at ${runGit(what, repository, ['rev-parse', 'HEAD']).trim()}), and the extractor reads a default branch by name`);
  }
  return branch;
}

/** Resolves what the caller pinned (a commit, a branch, anything git resolves) to the commit it names. */
export function resolveCommit(what: string, repository: string, revision: string): string {
  const commit = runGit(what, repository, ['rev-parse', '--verify', `${revision}^{commit}`]).trim();
  if (!COMMIT_PATTERN.test(commit)) {
    throw new Error(`${what}: ${JSON.stringify(revision)} resolved to ${JSON.stringify(commit)}, which is no commit`);
  }
  return commit;
}

/** One whole-number git time in seconds, refused where it is not one. */
function epochSeconds(text: string, what: string): number {
  if (!/^-?\d+$/u.test(text)) {
    throw new Error(`${what}: git writes a time as whole seconds since the epoch, and this reads ${JSON.stringify(text)}`);
  }
  const seconds = Number(text);
  if (!Number.isSafeInteger(seconds)) {
    throw new Error(`${what}: the epoch seconds ${JSON.stringify(text)} are no whole number`);
  }
  return seconds;
}

/** One commit id, refused where it is not forty lower-case hexadecimal digits. */
function commitId(text: string, what: string): string {
  if (!COMMIT_PATTERN.test(text)) {
    throw new Error(`${what}: ${JSON.stringify(text)} is no commit id (40 lower-case hexadecimal digits)`);
  }
  return text;
}

/**
 * One walk of the branch's history: every commit reachable from `revision`,
 * or only the first-parent line of it. Each record is the commit, its parents,
 * its two times, its author, its subject, its message and the paths it changed
 * (merge commits change none: `git log` shows a merge no diff of its own, which
 * is the counting rule every planted number follows). Nothing that does not
 * hold the shape git promises is read past: the refusal names the walk, the
 * repository and the bytes.
 */
export function readLog(what: string, repository: string, revision: string, firstParentOnly: boolean): LogEntry[] {
  const where = `${what}: the log of ${revision} in ${repository}${firstParentOnly ? ' on the first-parent line' : ''}`;
  const args = [
    '--no-pager', 'log', '--no-color', '--no-show-signature', ...(firstParentOnly ? ['--first-parent'] : []),
    `--format=${LOG_FORMAT}`, '--name-status', '-M', '-z', revision,
  ];
  const text = runGit(where, repository, args);
  const entries: LogEntry[] = [];
  for (const record of text.split(LOG_RECORD)) {
    if (record === '') continue;
    const last = record.lastIndexOf(LOG_FIELD);
    if (last < 0) {
      throw new Error(`${where} holds a record with no field separator: ${JSON.stringify(record.slice(0, 120))}`);
    }
    const fields = record.slice(0, last).split(LOG_FIELD);
    const [commit, parents, committed, authored, author, subject] = fields;
    if (commit === undefined || parents === undefined || committed === undefined || authored === undefined || author === undefined || subject === undefined) {
      throw new Error(`${where} holds a record with ${fields.length} fields: a record is the commit, its parents, its two times, its author, its subject and its message`);
    }
    const id = commitId(commit, where);
    const message = fields.slice(6).join(LOG_FIELD);
    const parentList = parents === '' ? [] : parents.split(' ').map((parent) => commitId(parent, `${where} names a parent of ${id}`));
    entries.push({
      commit: id,
      parents: parentList,
      committedAt: epochSeconds(committed, `${where} reads the committer time of ${id}`),
      authoredAt: epochSeconds(authored, `${where} reads the author time of ${id}`),
      author,
      subject,
      message,
      changes: parseChanges(record.slice(last + 1), id, where),
    });
  }
  return entries;
}

/**
 * The `--name-status -z` list of one record: a NUL where the fields end, a
 * newline where the list opens, then `<status>NUL<path>[NUL<path>]NUL` per
 * entry, renames and copies holding two paths. A record that changed no path
 * (a merge) holds nothing after the NUL. Anything else is refused, naming the
 * commit and the bytes.
 */
function parseChanges(section: string, commit: string, where: string): LogChange[] {
  const rest = section.startsWith('\x00') ? section.slice(1) : undefined;
  if (rest === undefined) {
    if (section === '' || section === '\n') return [];
    throw new Error(`${where} holds the path list of ${commit} as ${JSON.stringify(section.slice(0, 120))}: a list opens with a NUL, and a commit that changed no path holds none`);
  }
  const tokens = (rest.startsWith('\n') ? rest.slice(1) : rest).split('\x00');
  const lastToken = tokens[tokens.length - 1];
  if (lastToken !== '') throw new Error(`${where} holds the path list of ${commit} without its closing NUL: ${JSON.stringify(section.slice(0, 120))}`);
  tokens.length -= 1;
  const changes: LogChange[] = [];
  for (let at = 0; at < tokens.length;) {
    const status = tokens[at];
    if (status === undefined) throw new Error(`${where} holds the path list of ${commit} cut short at its ${at + 1} field: ${JSON.stringify(section.slice(0, 120))}`);
    if (/^[RC][0-9]*$/u.test(status)) {
      const from = tokens[at + 1];
      const to = tokens[at + 2];
      if (from === undefined || to === undefined) {
        throw new Error(`${where} holds the rename ${status} of ${commit} without its two paths: ${JSON.stringify(section.slice(0, 120))}`);
      }
      const percent = status.slice(1);
      changes.push({status, paths: [from, to], ...(percent === '' ? {} : {similarity: Number(percent) / 100})});
      at += 3;
      continue;
    }
    const path = tokens[at + 1];
    if (path === undefined) {
      throw new Error(`${where} holds the status ${status} of ${commit} without its path: ${JSON.stringify(section.slice(0, 120))}`);
    }
    changes.push({status, paths: [path]});
    at += 2;
  }
  return changes;
}

/** Every blob of one commit's tree with its repository path, in code point order of the paths. */
export function listTree(what: string, repository: string, commit: string): readonly TreeEntry[] {
  const where = `${what}: the tree of ${commit} in ${repository}`;
  const text = runGit(where, repository, ['ls-tree', '-r', '-z', commit]);
  const entries: TreeEntry[] = [];
  for (const token of text.split('\x00')) {
    if (token === '') continue;
    const tab = token.indexOf('\t');
    if (tab < 0) throw new Error(`${where} holds the entry ${JSON.stringify(token.slice(0, 120))}: an entry is its mode, its type, its blob id and its path behind a tab`);
    const meta = token.slice(0, tab).split(' ');
    const [mode, type, blob] = meta;
    if (mode === undefined || type === undefined || blob === undefined) {
      throw new Error(`${where} holds the entry ${JSON.stringify(token.slice(0, 120))}: an entry is its mode, its type, its blob id and its path`);
    }
    if (!COMMIT_PATTERN.test(blob)) {
      throw new Error(`${where} holds the object id ${JSON.stringify(blob)}, which is not forty lower-case hexadecimal digits`);
    }
    if (type !== 'blob') continue;
    const path = token.slice(tab + 1);
    if (path === '') throw new Error(`${where} holds an entry of ${type} with no path`);
    entries.push({path, blob});
  }
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return entries;
}

/** The bytes of one blob. */
export function readBlob(what: string, repository: string, blob: string): Buffer {
  return runGitBytes(what, repository, ['cat-file', 'blob', blob]);
}
