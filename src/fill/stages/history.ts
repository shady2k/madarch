/**
 * The history stage of the fill (decision 0026's stage 7): the pinned commit's
 * ancestry written as `commit` facts, the task keys the commit messages name
 * written as `task-key` edges, and a coverage fact saying what the read could
 * not reach.
 *
 * The stage reads Git directly, at the pinned commit the run's snapshot names,
 * and never the snapshot reader: a repository's history is Git's own, and the
 * reader that would serve the pinned tree and its file bytes serves no ancestry.
 * Its units come from the graph — one unit per pinned snapshot, named by the
 * repository the product knows and the commit that snapshot pinned — and a unit
 * writes the ancestry of that commit, bounded by the stage's configured depth
 * (`fill.stages.history.config.depth`, 1000 commits where the product says
 * nothing).
 *
 * Incrementality is the graph's own record of what was already written. Before
 * writing, a unit reads back the commit facts its repository's history already
 * holds and writes only the commits whose facts are missing or whose value
 * changed, so a second run after one new commit writes that commit's facts
 * alone, a rerun that changes nothing writes nothing at all, and a commit whose
 * facts were read under a shallow boundary is corrected once its parents are
 * there to read. What a read could not reach is no exception to that rule: the
 * last published read of a commit is what the graph holds, with the coverage
 * that read wrote beside it. The coverage fact is written on the same rule: a
 * unit whose coverage still holds writes none.
 *
 * Nothing of a machine reaches a fact. Every path the reader reports is put
 * through `repositoryPath`, the repository is the product's own name for it,
 * and every fact is built by the schema's own constructors, whose ids digest
 * the fact's identity and never the commit it was read at, the reader's
 * version or the run.
 *
 * What the read could not reach is always named. The configured depth cutting
 * the ancestry is a `budget` gap, a shallow clone's boundary and a parent Git
 * cannot read are `inaccessible` gaps, and the coverage fact carrying them is
 * written beside the commits, so a shorter history is never silent. One thing
 * a gap does not name is a boundary commit's own file list: git has no parent
 * in the checkout to diff it against, so it answers the whole tree as the paths
 * that commit added. A later read that can reach the parents writes that
 * commit's paths again, since what the graph holds is what the last read
 * found. A read that
 * fails for any other reason is thrown, naming the repository, the checkout
 * folder, the git command, its exit status and git's own words.
 *
 * The reads this stage makes of the graph are the three below —
 * `PINNED_SNAPSHOTS_QUERY`, `commitsHeldQuery`, `coverageHeldQuery` — and they
 * are SQL against the fact store's rows, in the fill's own vocabulary of fact
 * kinds. What they select is what they need and no more: the repository and
 * the commit a pinned snapshot names, the commit and the value a commit fact
 * holds, and the value of one scope's coverage fact; the kind, the repository
 * and the scope they stand on are what each read filters by. That row shape is
 * this stage's proposal for the fact storage of madarch-tzte.20 to meet or to
 * change, since that storage is not landed yet, and it is written once, here,
 * so a test can pin it and a storage can answer it. The repository and the scope a read interpolates are checked against
 * their own forms before they reach a query, so no read is built from a name a
 * product did not write.
 */
import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { Type } from 'typebox';
import { canonicalJsonDigest } from '../../model/canonical.js';
import { byCodePoint } from '../../model/order.js';
import { ID_PATTERN } from '../../model/schema.js';
import { GIT_LEAKS } from '../../product/git.js';
import {
  FACT_KINDS,
  checkFact,
  makeEdgeFact,
  makeNodeFact,
  repositoryPath,
  type CoverageGap,
  type CoverageValue,
  type FactSource,
  type RepositoryPath,
} from '../facts.js';
import {
  DEFAULT_STAGE_LIMITS,
  type FillStage,
  type StageContext,
  type StageDraftSet,
  type StageDraftWrite,
  type StageExecutionResult,
  type StageGraphReader,
  type StagePlan,
  type StageUnit,
  type StageValidation,
} from '../stage.js';

const execFile = promisify(execFileCallback);

// ---- what the stage is ----------------------------------------------------

/** The stage's id in the registry: stage 7 of decision 0026, named by what it reads. */
export const HISTORY_STAGE_ID = 'history';

/** The stage module's own version (decision 0027): bumped when the behaviour it declares changes. */
export const HISTORY_STAGE_VERSION = 1;

/** How many commits of the ancestry one unit reads where the product configures no depth. */
export const DEFAULT_HISTORY_DEPTH = 1000;

/** The system every fact this stage writes cites as its source: Git, read at the pinned commit. */
export const HISTORY_SOURCE_SYSTEM = 'git';

/** The capability the stage reads its own earlier publication through: what makes one run incremental. */
export const HISTORY_SELF_CAPABILITY = 'commit';

/** The capability the stage's units come from: the pinned snapshots stage 0 writes. */
export const HISTORY_INPUT_CAPABILITY = 'snapshot';

/**
 * The fact kinds the stage writes, in code point order: the commits, the task
 * keys their messages name, and what the read could not reach. `coverage` is
 * the kind every stage of the fill reports in (decision 0026), and the other
 * two are stage 7's own.
 */
export const HISTORY_FACT_KINDS = ['commit', 'coverage', 'task-key'] as const;

/** The stage's own configuration: how deep into one repository's ancestry a unit reads. */
const HISTORY_CONFIG_SCHEMA = Type.Object({ depth: Type.Integer({ minimum: 1 }) });

// ---- the graph reads ------------------------------------------------------

/**
 * The read a plan names its units from: the pinned snapshot of every repository
 * the product holds (stage 0's facts). A repository pinned twice answers twice,
 * and each pin is a unit of its own, since a pin is what an ancestry is read at.
 */
export const PINNED_SNAPSHOTS_QUERY = "SELECT repository, commit FROM fact WHERE kind = 'snapshot'";

/** The read an execute makes of the commit facts this repository's history already holds, with the value each holds. */
export function commitsHeldQuery(repository: string): string {
  return `SELECT commit, value FROM fact WHERE kind = 'commit' AND repository = '${repositoryName(repository)}'`;
}

/** The read an execute makes of the coverage fact it wrote for one scope, so a coverage that still holds is not written again. */
export function coverageHeldQuery(repository: string, scope: string): string {
  return `SELECT value FROM fact WHERE kind = 'coverage' AND repository = '${repositoryName(repository)}' AND scope = '${scopeText(scope)}'`;
}

/** The repository a fact may name: the product's own name for it, which is also what a read may hold between quotes. */
function repositoryName(repository: string): string {
  if (typeof repository !== 'string' || !ID_PATTERN.test(repository)) {
    throw new Error(`history: ${JSON.stringify(repository)} is no repository name: the product's own name for a repository, like "orders-api", never a path, a URL or a branch`);
  }
  return repository;
}

/** A scope this stage reads or writes by: the one form its units and their coverage carry. */
function scopeText(scope: string): string {
  if (typeof scope !== 'string' || SCOPE_PATTERN.test(scope) === false) {
    throw new Error(`history: ${JSON.stringify(scope)} is no history scope: ${SCOPE_FORM}`);
  }
  return scope;
}

// ---- the readers ----------------------------------------------------------

/** Where a repository's Git stands: the folder of its checkout, by the product's own name for the repository. */
export type CheckoutFolderOf = (repository: string) => string;

/** What one commit of an ancestry is, as the reader read it from the repository's own Git. */
export interface HistoryCommit {
  /** The commit: 40 lower-case hexadecimal digits. */
  readonly commit: string;
  /**
   * The commit's parents, in git's own order (the first parent first); empty
   * at a root, and empty too where git could not reach them, which the read
   * reports as a coverage gap.
   */
  readonly parents: readonly string[];
  /** The committer time, ISO 8601 with `Z`. */
  readonly committedAt: string;
  /** The author time, ISO 8601 with `Z`. */
  readonly authoredAt: string;
  /** The commit's subject line. */
  readonly subject: string;
  /** The name the commit was authored under, as git records it. */
  readonly author?: string;
  /** The paths the commit changed, from the repository's root, in code point order, each once. */
  readonly files: readonly RepositoryPath[];
  /** The commit's whole message, the bytes the task keys are read from. */
  readonly message: string;
}

/** One read of a repository's ancestry at one commit. */
export interface HistoryAncestry {
  /** The pinned commit the read started at, as Git resolved it. */
  readonly commit: string;
  /** The ancestry Git listed, oldest first: every parent before its children. */
  readonly commits: readonly HistoryCommit[];
  /** True when more ancestry stands behind the oldest commit read: the depth read cut it. */
  readonly cut: boolean;
  /** What the read could not reach, each with its reason: the bound's cut and every parent Git could not read. */
  readonly unread: readonly CoverageGap[];
  /** The system and version the facts of this read cite as their source. */
  readonly source: FactSource;
}

/** What the history stage reads Git through: the run's wiring, never a guess of this module's. */
export interface HistoryReader {
  /** Reads one repository's ancestry at one commit, bounded by `depth` commits. */
  read(request: { readonly repository: string; readonly commit: string; readonly depth: number; readonly signal?: AbortSignal }): Promise<HistoryAncestry>;
}

// ---- the Git reader -------------------------------------------------------

/**
 * The separator the log format writes between commit records, and the one it
 * writes between fields. They are exported because a test that wants to hand
 * the reader the bytes git would write has to write them: the format below is
 * the reader's own contract with git, and a test builds its answer from these
 * two and nothing else.
 */
export const HISTORY_LOG_RECORD = '\x1e';
export const HISTORY_LOG_FIELD = '\x1f';

/**
 * The log format: `%x1e` opens a commit's record, the fields are joined by
 * `%x1f`, and the message is last so that a message holding the field
 * separator itself still reads (a message holding the record separator is
 * refused by the reader rather than read as two records).
 */
const HISTORY_LOG_FORMAT = '%x1e%H%x1f%P%x1f%ct%x1f%at%x1f%an%x1f%s%x1f%B%x1f';

/** The most a git call may answer: the whole ancestry of a very large repository, names included. */
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

/** The commits the reader asks git for: one more than the bound, so the bound's cut is known rather than guessed. */
const CUT_LOOKAHEAD = 1;

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

/** How one git call ended: git's exit status, its standard output and its standard error. */
interface GitRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * Why a call that never ran could not be run: the runtime's own error with
   * its code named (`ENOENT` for a git that is not on PATH, the child-process
   * error for an answer past the read's buffer). Nothing else reaches it.
   */
  readonly failure?: string;
}

/** One git call in a folder: git's own loader variables never reach it, and an abort kills the call. */
async function gitIn(folder: string, args: readonly string[], signal?: AbortSignal): Promise<GitRun> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !GIT_LEAKS.includes(name)) env[name] = value;
  }
  try {
    const { stdout, stderr } = await execFile('git', ['-C', folder, ...args], { encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, env, signal });
    return { status: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown };
    const status = typeof failed.code === 'number' ? failed.code : null;
    const stdout = typeof failed.stdout === 'string' ? failed.stdout : '';
    const stderr = typeof failed.stderr === 'string' ? failed.stderr : '';
    // A call that never started — no git on PATH, an answer past the read's
    // buffer — has no status: the runtime's own error is then the whole of what
    // can be said, with the runtime's own code in front of it, and it is said
    // rather than read as a git that answered nothing.
    const code = typeof failed.code === 'string' ? failed.code : undefined;
    const said = typeof failed.message === 'string' ? failed.message : undefined;
    const failure = [code, said].filter((one) => one !== undefined && one !== '').join(': ');
    return { status, stdout, stderr, ...(status === null && failure !== '' ? { failure } : {}) };
  }
}

/** What one failed git call says: the folder, the command, git's exit status and git's own words. */
function gitFailure(what: string, folder: string, args: readonly string[], run: GitRun): Error {
  const status = run.status === null ? `could not be run${run.failure === undefined ? '' : `: ${run.failure}`}` : `exited ${run.status}`;
  const words = run.stderr.replace(/\s+/gu, ' ').trim();
  const tail = words.length > 600 ? `…${words.slice(-600)}` : words;
  return new Error(`${what}: git ${['-C', folder, ...args].join(' ')} ${status}${tail === '' ? '' : `: ${tail}`}`);
}

/**
 * The Git a repository's history is read from. The folder of a repository's
 * checkout is the caller's (`CheckoutFolderOf`), since only the run's wiring
 * knows where the product's repositories stand: a checkout's folder is a
 * machine's path, and no fact of the fill may carry one.
 *
 * The reader makes four git calls at a repository's Git: the pinned commit is
 * resolved, the ancestry is listed (`git log`, newest first, topologically
 * ordered, no renames detected — a rename is the path it left and the path it
 * took), the shallow state is asked about (a fifth call asks where the shallow
 * file is, and only where the repository is shallow), and the version that
 * answered is read for the facts' source. A
 * parent Git cannot read is found in the call that failed, not guessed from a
 * shorter list: git names the object it could not read and the commit whose
 * parents it was traversing, and both are said in the coverage gap.
 */
export function createGitHistoryReader(folderOf: CheckoutFolderOf): HistoryReader {
  return {
    read: async (request) => {
      const { repository, commit, depth, signal } = request;
      const what = `history: the read of ${repository} at ${commit}`;
      if (!Number.isInteger(depth) || depth < 1) {
        throw new Error(`${what} names the depth ${JSON.stringify(depth)}: a read is one whole number of commits, 1 or more`);
      }
      const folder = folderOf(repository);
      if (typeof folder !== 'string' || folder.trim() === '') {
        throw new Error(`${what} has no checkout folder: the run's wiring names the folder the repository is checked out at`);
      }
      try {
        if (signal?.aborted === true) throw new Error(`${what} was cancelled before it ran`);
        const resolved = await gitIn(folder, ['rev-parse', '--verify', `${commit}^{commit}`], signal);
        if (resolved.status !== 0) throw gitFailure(what, folder, ['rev-parse', '--verify', `${commit}^{commit}`], resolved);
        const pin = resolved.stdout.trim();
        if (pin !== commit) throw new Error(`${what} resolved to ${pin}: a fact of the pinned commit is read at the commit the run pinned`);

        const args = [
          '--no-pager', 'log', '--no-color', '--no-show-signature', '--no-renames', '--diff-merges=first-parent', '--topo-order',
          `--format=${HISTORY_LOG_FORMAT}`, '--name-only', '-z', `--max-count=${depth + CUT_LOOKAHEAD}`, commit,
        ];
        const listed = await gitIn(folder, args, signal);
        const commits = parseLog(listed.stdout, { repository, commit, folder });
        const unread: CoverageGap[] = [];
        if (listed.status !== 0) {
          const missing = missingParent(listed.stderr);
          if (missing === undefined) throw gitFailure(what, folder, args, listed);
          unread.push(missing);
        }
        // The bound's own cut: the lookahead commit the read stops before.
        const cut = commits.length > depth;
        const kept = [...(cut ? commits.slice(0, depth) : commits)].reverse();
        const oldest = kept[0];
        // A call that read nothing of a history it could read is a read that did
        // not happen. A call that failed over an object git named is the gap it
        // named: the commits it had already listed are written beside it — a
        // topologically ordered walk that fails lists none, because git orders
        // the walk before it prints — and what it did not reach is the gap,
        // never a shorter history published as the whole one.
        if (oldest === undefined && listed.status === 0) {
          throw new Error(`${what} listed no commit at all: an ancestry holds the pinned commit, so a read that lists nothing is a read that did not happen`);
        }
        if (cut && oldest !== undefined) unread.push({ what: `the ancestry before ${oldest.commit}`, reason: 'budget' });
        unread.push(...await shallowGaps(folder, repository, kept, signal));
        const version = await sourceVersion(folder, signal, what);
        return { commit: pin, commits: kept, cut, unread: sortGaps(unread), source: { system: HISTORY_SOURCE_SYSTEM, version } };
      } catch (error) {
        if (signal?.aborted === true) throw new Error(`${what} was cancelled`);
        throw error;
      }
    },
  };
}

/** The version of the git that answered: the facts of this read cite it as their source's version. */
async function sourceVersion(folder: string, signal: AbortSignal | undefined, what: string): Promise<string> {
  const run = await gitIn(folder, ['--version'], signal);
  if (run.status !== 0) throw gitFailure(`${what} asked git its version`, folder, ['--version'], run);
  const match = run.stdout.trim().match(/^git version (\S+)$/u);
  if (match?.[1] === undefined) {
    throw new Error(`${what} read git's version as ${JSON.stringify(run.stdout.trim())}: a source's version is the one its facts' precision stands on`);
  }
  return match[1];
}

/**
 * The commits Git listed, newest first as `git log` writes them, each with its
 * parents, its two times, its author, its subject, the message and the paths it
 * changed. Everything a record holds that the format does not promise is
 * refused by name rather than read past: a record whose first field is no
 * commit, a parent that is no commit, a time that is no whole number of
 * seconds, a record whose fields are followed by something that is no path
 * list, and a path list that does not end with its separator. A message
 * holding the record separator reaches the reader as a record of its own, which
 * is why these refusals name the repository, the commit and the bytes rather
 * than dropping the record.
 */
function parseLog(text: string, at: { readonly repository: string; readonly commit: string; readonly folder: string }): HistoryCommit[] {
  const where = `history: the log of ${at.repository} at ${at.commit} in ${at.folder}`;
  const commits: HistoryCommit[] = [];
  for (const record of text.split(HISTORY_LOG_RECORD)) {
    if (record === '') continue;
    const last = record.lastIndexOf(HISTORY_LOG_FIELD);
    if (last < 0) throw new Error(`${where} holds a record with no field separator: ${JSON.stringify(record.slice(0, 120))}`);
    const fields = record.slice(0, last).split(HISTORY_LOG_FIELD);
    const [commit, parents, committed, authored, author, subject] = fields;
    if (commit === undefined || parents === undefined || committed === undefined || authored === undefined || author === undefined || subject === undefined) {
      throw new Error(`${where} holds a record with ${fields.length} fields: a record is the commit, its parents, its two times, its author, its subject and its message`);
    }
    if (!COMMIT_PATTERN.test(commit)) {
      throw new Error(`${where} holds a record whose first field is ${JSON.stringify(commit)}: a commit is 40 lower-case hexadecimal digits, so this record is a message git wrote as one`);
    }
    const message = fields.slice(6).join(HISTORY_LOG_FIELD);
    const parentsRead = parents === '' ? [] : parents.split(' ').map((parent) => {
      if (!COMMIT_PATTERN.test(parent)) throw new Error(`${where} names the parent ${JSON.stringify(parent)} of ${commit}: a parent is 40 lower-case hexadecimal digits`);
      return parent;
    });
    const committedAt = isoTimestamp(committed, `the committer time of ${commit}`, where);
    const authoredAt = isoTimestamp(authored, `the author time of ${commit}`, where);
    // Everything after the record's last field separator is git's path list,
    // and git opens one with a NUL. Anything else there means the record the
    // reader is holding was cut in two — a message holding the record separator
    // — and that is refused here, where the commit it pretended to be is known.
    const section = record.slice(last + 1);
    if (section !== '' && !section.startsWith('\x00')) {
      throw new Error(`${where} holds a record for ${commit} whose fields are followed by ${JSON.stringify(section.slice(0, 120))}, which is no path list: a message holding the record separator reaches the reader as a record of its own`);
    }
    commits.push({
      commit,
      parents: parentsRead,
      committedAt,
      authoredAt,
      subject,
      ...(author === '' ? {} : { author }),
      files: parseFiles(section, commit, where),
      message,
    });
  }
  return commits;
}

/**
 * The paths one record's diff section lists: git writes a NUL where the commit
 * header ends, then a newline and the paths, each NUL-terminated — `--name-only
 * -z`'s own separators — and nothing at all where the commit changed no file
 * (an empty commit, an empty message's merge with no first-parent diff). The
 * section is read exactly as git writes it: one NUL, one newline, then paths.
 */
function parseFiles(section: string, commit: string, where: string): RepositoryPath[] {
  if (section === '' || section === '\x00') return [];
  const rest = section.slice(1);
  if (rest === '') return [];
  if (!rest.startsWith('\n') || !rest.endsWith('\x00')) {
    throw new Error(`${where} lists the paths of ${commit} as ${JSON.stringify(rest.slice(0, 120))}: a path list opens with a newline and every path ends with its separator`);
  }
  const listed = rest.slice(1, -1);
  const paths = listed === '' ? [] : listed.split('\x00');
  const files: RepositoryPath[] = [];
  for (const path of paths) {
    try {
      files.push(repositoryPath(path));
    } catch (error) {
      throw new Error(`${where} lists the path ${JSON.stringify(path)} of ${commit}, which is no repository path: ${(error as Error).message}`);
    }
  }
  return [...new Set(files)].sort(byCodePoint);
}

/** One git time as an ISO 8601 instant with `Z`, from the epoch seconds git prints. */
function isoTimestamp(epoch: string, what: string, where: string): string {
  // Git counts whole seconds from the epoch and its own count may be negative:
  // a commit dated before 1970 is a commit, not a defect.
  if (!/^-?\d+$/u.test(epoch)) {
    throw new Error(`${where} reads ${what} as ${JSON.stringify(epoch)}: git writes a time as whole seconds since the epoch, negative where it stands before it`);
  }
  const at = Number(epoch);
  if (!Number.isSafeInteger(at)) {
    throw new Error(`${where} reads ${what} as ${JSON.stringify(epoch)}, which is no whole number of seconds`);
  }
  try {
    return new Date(at * 1000).toISOString().replace(/\.\d{3}Z$/u, 'Z');
  } catch (error) {
    throw new Error(`${where} reads ${what} as ${JSON.stringify(epoch)}, which is no instant an ISO 8601 time holds: ${(error as Error).message}`);
  }
}

/**
 * The gap a failed log left, read from git's own lines: the object it could not
 * read (`error: Could not read <sha>`) and, where git says so, the commit whose
 * parents it was traversing (`fatal: Failed to traverse parents of commit
 * <sha>`). Git 2.55, asked for a topologically ordered walk, prints the object
 * line and `fatal: revision walk setup failed` — it orders the whole walk before
 * it prints — so both shapes are read here rather than the wording of one
 * version, and a failure naming no object at all is no gap but a failure, which
 * the caller throws.
 */
function missingParent(stderr: string): CoverageGap | undefined {
  const object = stderr.match(/Could not read ([0-9a-f]{40})/u)?.[1];
  const child = stderr.match(/Failed to traverse parents of commit ([0-9a-f]{40})/u)?.[1];
  if (object !== undefined && child !== undefined) return { what: `the parent ${object} of ${child}`, reason: 'inaccessible' };
  if (child !== undefined) return { what: `the ancestry of ${child}`, reason: 'inaccessible' };
  if (object !== undefined) return { what: `the commit ${object}`, reason: 'inaccessible' };
  return undefined;
}

/**
 * The gaps a shallow clone leaves. `git log` at a shallow boundary lists the
 * boundary commit with no parents at all — the commit object still records
 * them, but their objects are not in this checkout — so a read that stopped
 * there is a shorter history, and the coverage says which commit's ancestry it
 * could not follow rather than reading the empty parent list as a root.
 */
async function shallowGaps(folder: string, repository: string, commits: readonly HistoryCommit[], signal?: AbortSignal): Promise<CoverageGap[]> {
  const shallow = await gitIn(folder, ['rev-parse', '--is-shallow-repository'], signal);
  if (shallow.status !== 0) throw gitFailure(`history: the shallow state of ${repository} in ${folder}`, folder, ['rev-parse', '--is-shallow-repository'], shallow);
  if (shallow.stdout.trim() !== 'true') return [];
  // Git clamps the shallow file itself when `GIT_SHALLOW_FILE` is set, and it
  // strips that variable; the file's path is therefore asked for, never spelled.
  const path = await gitIn(folder, ['rev-parse', '--git-path', 'shallow'], signal);
  if (path.status !== 0) throw gitFailure(`history: the shallow file of ${repository} in ${folder}`, folder, ['rev-parse', '--git-path', 'shallow'], path);
  const location = path.stdout.trim();
  const file = isAbsolute(location) ? location : join(folder, location);
  let listed: string;
  try {
    listed = await readFile(file, 'utf8');
  } catch (error) {
    return [{ what: `the shallow boundary file of ${repository}`, reason: 'error' }];
  }
  const boundaries = new Set(listed.split('\n').map((line) => line.trim()).filter((line) => line !== ''));
  const gaps: CoverageGap[] = [];
  for (const commit of commits) {
    // A boundary commit is one whose own parents are not in this checkout: its
    // recorded parent list is empty, so the ancestry behind it was not read.
    if (boundaries.has(commit.commit) && commit.parents.length === 0) {
      // The gap names the boundary itself, not the ancestry behind it: a bound
      // cutting the read at the same commit names that ancestry too, and a
      // coverage names each `what` once, so the two causes say two things.
      gaps.push({ what: `the shallow boundary ${commit.commit}`, reason: 'inaccessible' });
    }
  }
  return gaps;
}

/**
 * The gaps in code point order of what they name, each pair of a `what` and a
 * reason once: the schema's order for a coverage's list. Only an exact repeat is
 * dropped, so a future cause naming a `what` another cause already named is
 * refused where the coverage is built rather than lost from the list here.
 */
function sortGaps(gaps: readonly CoverageGap[]): CoverageGap[] {
  const seen = new Set<string>();
  const unique: CoverageGap[] = [];
  for (const gap of [...gaps].sort((left, right) => byCodePoint(left.what, right.what) || byCodePoint(left.reason, right.reason))) {
    const key = `${gap.what}\u0000${gap.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(gap);
  }
  return unique;
}

/**
 * The gaps one coverage carries: in the schema's order, each of them once, and
 * each `what` named by exactly one of them. The schema refuses a coverage that
 * names one `what` twice, and a reader that handed it one would lose the whole
 * unit — its facts and its gaps — to a refusal about the list; so a second cause
 * naming a `what` an earlier one named is refused here, at the repository and
 * the scope it is about, saying both reasons.
 */
function coverageGaps(gaps: readonly CoverageGap[], repository: string, scope: string): CoverageGap[] {
  const ordered = sortGaps(gaps);
  const named = new Map<string, string>();
  for (const gap of ordered) {
    const first = named.get(gap.what);
    if (first !== undefined) {
      throw new Error(`history: the coverage of ${repository} at ${scope} would name ${JSON.stringify(gap.what)} twice, as ${first} and as ${gap.reason}: a coverage names each thing it could not read once`);
    }
    named.set(gap.what, gap.reason);
  }
  return ordered;
}

// ---- the stage's units ----------------------------------------------------

/** The one form a history unit's scope and its coverage take: the repository and the commit it is read at. */
const SCOPE_PATTERN = /^repository:([A-Za-z0-9][A-Za-z0-9._-]*)@([0-9a-f]{40})$/u;
const SCOPE_FORM = 'a history scope is "repository:<name>@<commit>", naming the product\'s own name for the repository and the 40 lower-case hexadecimal digits of the commit the run pinned';

/** The scope of the unit that reads one repository at one commit. */
export function historyScope(repository: string, commit: string): string {
  return `repository:${repositoryName(repository)}@${pinnedCommit(commit, `the repository ${repository}`)}`;
}

/** The unit id of one repository's ancestry at one commit: stable across runs, and never a run's own id. */
export function historyUnitId(repository: string, commit: string): string {
  return `${repositoryName(repository)}@${pinnedCommit(commit, `the repository ${repository}`)}`;
}

/** One pinned snapshot as the plan read it. */
export interface PinnedSnapshot {
  readonly repository: string;
  readonly commit: string;
}

/** A commit as a fact may name it: 40 lower-case hexadecimal digits. */
function pinnedCommit(commit: string, what: string): string {
  if (typeof commit !== 'string' || !COMMIT_PATTERN.test(commit)) {
    throw new Error(`history: ${what} is pinned at ${JSON.stringify(commit)}: a pinned commit is 40 lower-case hexadecimal digits`);
  }
  return commit;
}

/** The repository and the commit one unit's scope names, refused by name where it is not that form. */
export function parseHistoryScope(scope: string): PinnedSnapshot {
  const match = typeof scope === 'string' ? SCOPE_PATTERN.exec(scope) : null;
  const repository = match?.[1];
  const commit = match?.[2];
  if (repository === undefined || commit === undefined) {
    throw new Error(`history: the scope ${JSON.stringify(scope)} names no repository at a commit: ${SCOPE_FORM}`);
  }
  return { repository, commit };
}

/**
 * The units a plan names from the graph: one per pinned snapshot, in code point
 * order of what they read, each occurring once. A plan whose graph holds no
 * pinned snapshot answers `nothing-found` rather than an empty plan of a kind
 * that would read as "no producer": stage 0 writes those facts, and a plan that
 * found none of them is a plan whose input is not there yet.
 */
async function planUnits(graph: StageGraphReader): Promise<StagePlan> {
  const rows = await graph.query(PINNED_SNAPSHOTS_QUERY);
  const pins = readPinnedSnapshots(rows);
  if (pins.length === 0) return { units: [], coverage: 'nothing-found' };
  return {
    units: pins.map((pin) => ({ id: historyUnitId(pin.repository, pin.commit), scope: historyScope(pin.repository, pin.commit) })),
    coverage: 'planned',
  };
}

/** The pinned snapshots a graph answered, every row read: a row this stage cannot read is refused with the query that answered it. */
function readPinnedSnapshots(rows: readonly unknown[]): PinnedSnapshot[] {
  const seen = new Set<string>();
  const pins: PinnedSnapshot[] = [];
  rows.forEach((row, index) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new Error(`history: row ${index} of "${PINNED_SNAPSHOTS_QUERY}" is ${JSON.stringify(row)}, not a record with a repository and a commit`);
    }
    const { repository, commit } = row as { repository?: unknown; commit?: unknown };
    if (typeof repository !== 'string' || !ID_PATTERN.test(repository)) {
      throw new Error(`history: row ${index} of "${PINNED_SNAPSHOTS_QUERY}" names the repository ${JSON.stringify(repository)}: the product's own name for a repository, like "orders-api"`);
    }
    if (typeof commit !== 'string' || !COMMIT_PATTERN.test(commit)) {
      throw new Error(`history: row ${index} of "${PINNED_SNAPSHOTS_QUERY}" pins ${repository} at ${JSON.stringify(commit)}: a pinned commit is 40 lower-case hexadecimal digits`);
    }
    const key = `${repository}@${commit}`;
    if (seen.has(key)) return;
    seen.add(key);
    pins.push({ repository, commit });
  });
  return pins.sort((left, right) => byCodePoint(left.repository, right.repository) || byCodePoint(left.commit, right.commit));
}

// ---- the facts one unit writes --------------------------------------------

/**
 * The task keys a commit message names: the tracker's own rule (the backlog
 * integration's `taskIds`), one or more lines `Task: <id>[, <id> ...]`, read
 * case-insensitively, keys split on commas and whitespace, the case of each key
 * kept as the commit wrote it, each occurring once, in code point order.
 */
export function taskKeys(message: string): string[] {
  const keys = new Set<string>();
  for (const match of message.matchAll(/^Task:\s*(.+)$/gim)) {
    for (const key of (match[1] ?? '').split(/[\s,]+/u)) if (key !== '') keys.add(key);
  }
  return [...keys].sort(byCodePoint);
}

/** The `commit` fact of one commit of one repository, built by the schema's own constructor. */
function commitFact(repository: string, commit: HistoryCommit, source: FactSource) {
  return makeNodeFact({
    kind: 'commit',
    value: {
      repository,
      commit: commit.commit,
      committedAt: commit.committedAt,
      authoredAt: commit.authoredAt,
      subject: commit.subject,
      ...(commit.author === undefined ? {} : { author: commit.author }),
      parents: commit.parents,
      files: commit.files,
    },
    // The commit a commit fact is read at is the commit itself: the schema
    // refuses a fact whose value and provenance name two commits.
    provenance: { source, repository: { id: repository, commit: commit.commit } },
    layer: 'extracted',
  });
}

/** The `task-key` edge of one key one commit's message names. */
function taskKeyFact(repository: string, commit: string, from: string, key: string, source: FactSource) {
  return makeEdgeFact({
    kind: 'task-key',
    value: { from, key },
    provenance: { source, repository: { id: repository, commit } },
    layer: 'extracted',
  });
}

/** What the history stage's reader read, in the coverage's own words: the two questions a read answers. */
const HISTORY_READ: readonly string[] = ['the pinned commit and its ancestry', 'the task keys the commit messages name'];

/** The `coverage` fact of one unit: what its read reached, and every gap it could not. */
function coverageFact(repository: string, scope: string, ancestry: HistoryAncestry) {
  const unread = coverageGaps(ancestry.unread, repository, scope);
  const value: CoverageValue = { repository, scope, complete: unread.length === 0, read: HISTORY_READ, unread };
  return makeNodeFact({
    kind: 'coverage',
    value,
    provenance: { source: ancestry.source, repository: { id: repository, commit: ancestry.commit } },
    layer: 'extracted',
  });
}

// ---- one unit's work ------------------------------------------------------

/**
 * The commit facts this repository's history already holds, by the commit each
 * names, with the value each holds. A row this stage cannot read is refused
 * with the query that answered it; two rows for one commit are refused too,
 * since a fact's identity names one commit of one repository once.
 */
async function readCommitsHeld(graph: StageGraphReader, repository: string): Promise<Map<string, unknown>> {
  const query = commitsHeldQuery(repository);
  const rows = await graph.query(query);
  const held = new Map<string, unknown>();
  rows.forEach((row, index) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new Error(`history: row ${index} of "${query}" is ${JSON.stringify(row)}, not a record with the commit and the value a fact holds`);
    }
    const { commit, value } = row as { commit?: unknown; value?: unknown };
    if (typeof commit !== 'string' || !COMMIT_PATTERN.test(commit)) {
      throw new Error(`history: row ${index} of "${query}" names the commit ${JSON.stringify(commit)}: a commit is 40 lower-case hexadecimal digits`);
    }
    if (value === undefined) {
      throw new Error(`history: row ${index} of "${query}" names ${commit} with no value: the read compares what the graph holds, so a row that holds nothing is refused`);
    }
    if (held.has(commit)) {
      throw new Error(`history: "${query}" answered ${commit} twice: one fact names one commit of one repository once`);
    }
    held.set(commit, value);
  });
  return held;
}

/** The coverage fact this unit already wrote for its scope, as the graph holds it, or `undefined` where it holds none. */
async function readCoverageHeld(graph: StageGraphReader, repository: string, scope: string): Promise<unknown | undefined> {
  const query = coverageHeldQuery(repository, scope);
  const rows = await graph.query(query);
  if (rows.length > 1) {
    throw new Error(`history: "${query}" answered ${rows.length} coverage facts: one stage's coverage of one scope is one fact`);
  }
  const row = rows[0];
  if (row === undefined) return undefined;
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw new Error(`history: row 0 of "${query}" is ${JSON.stringify(row)}, not a record with the value a fact holds`);
  }
  const value = (row as { value?: unknown }).value;
  if (value === undefined) {
    throw new Error(`history: row 0 of "${query}" holds no value: the read compares what the graph holds, so a coverage held with nothing in it is refused`);
  }
  return value;
}

/** The depth one unit reads to, from the stage's resolved configuration, refused by its own field where it is no depth. */
export function historyDepth(config: unknown): number {
  const depth = typeof config === 'object' && config !== null && !Array.isArray(config) ? (config as { depth?: unknown }).depth : undefined;
  if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 1) {
    throw new Error(`history: config.depth is ${JSON.stringify(depth)}: the stage reads a whole number of commits, 1 or more`);
  }
  return depth;
}

/**
 * One unit's work: read what this repository's history already holds, read Git
 * at the pinned commit, and draft the facts of every commit whose facts are not
 * held as they would be written, each commit's task keys after it — oldest
 * first, so a parent's fact always stands before its children's — and then the
 * unit's coverage where it changed.
 */
async function executeUnit(reader: HistoryReader, unit: StageUnit, context: StageContext): Promise<StageExecutionResult> {
  const { repository, commit } = parseHistoryScope(unit.scope);
  const depth = historyDepth(context.config.config);
  const what = `history: unit ${unit.id}`;
  if (context.signal.aborted) throw new Error(`${what} was cancelled before it read ${repository} at ${commit}`);
  const held = await readCommitsHeld(context.graph, repository);
  const heldCoverage = await readCoverageHeld(context.graph, repository, unit.scope);
  const ancestry = await reader.read({ repository, commit, depth, signal: context.signal });
  context.progress(`read the ancestry of ${repository} at ${commit}: ${ancestry.commits.length} ${ancestry.commits.length === 1 ? 'commit' : 'commits'}`, 0.5);

  const writes: StageDraftWrite[] = [];
  let commitsWritten = 0;
  let keysWritten = 0;
  for (const one of ancestry.commits) {
    const fact = commitFact(repository, one, ancestry.source);
    // The value the graph holds is compared as it is held: a commit whose facts
    // were read under a boundary that has since been fetched is written again,
    // and one whose value is what this read would write is left alone.
    const known = held.get(one.commit);
    if (known !== undefined && canonicalJsonDigest(known) === canonicalJsonDigest(fact.value)) continue;
    const evidence = `${repository}@${one.commit}`;
    writes.push({ kind: 'fact', evidence, value: fact });
    commitsWritten += 1;
    for (const key of taskKeys(one.message)) {
      writes.push({ kind: 'fact', evidence, value: taskKeyFact(repository, one.commit, fact.id, key, ancestry.source) });
      keysWritten += 1;
    }
  }

  const coverage = coverageFact(repository, unit.scope, ancestry);
  if (heldCoverage === undefined || canonicalJsonDigest(heldCoverage) !== canonicalJsonDigest(coverage.value)) {
    writes.push({ kind: 'fact', evidence: `${repository}@${ancestry.commit}`, value: coverage });
  }

  for (const write of writes) context.draft.write(write);
  context.progress(`wrote ${commitsWritten} ${commitsWritten === 1 ? 'commit' : 'commits'} and ${keysWritten} task ${keysWritten === 1 ? 'key' : 'keys'} of ${repository} at ${commit}`, 1);
  return { outcome: 'draft' };
}

// ---- what a draft is judged by --------------------------------------------

/** One refusal's own words: a schema problem's path and message, with the file and line the fact cites where it cites one. */
function refusalOf(write: StageDraftWrite, index: number, problem: { readonly path: string; readonly message: string; readonly file?: string; readonly line?: number }): string {
  const where = problem.path === '' ? problem.message : `${problem.path}: ${problem.message}`;
  const cited = problem.file === undefined ? '' : ` (${problem.file}${problem.line === undefined ? '' : `:${problem.line}`})`;
  return `write[${index}] (${write.kind} write of ${JSON.stringify(write.evidence)}): ${where}${cited}`;
}

/**
 * Judges one unit's draft before publication: every write is a fact write, every
 * fact is one the schema reads (through `checkFact`, so a refusal names the
 * path it stands at), every fact is of a kind this stage produces, and every
 * `task-key` edge names a commit fact this draft itself writes. An empty draft
 * is a draft whole: a rerun that changed nothing writes nothing.
 */
export function validateDraft(draft: StageDraftSet): StageValidation {
  const errors: string[] = [];
  const commitIds = new Set<string>();
  const edges: { readonly index: number; readonly value: unknown }[] = [];
  draft.writes.forEach((write, index) => {
    if (write.kind !== 'fact') {
      errors.push(`write[${index}] is a ${write.kind} write: the history stage writes facts and nothing else`);
      return;
    }
    for (const problem of checkFact(write.value)) errors.push(refusalOf(write, index, problem));
    const fact = write.value;
    if (typeof fact !== 'object' || fact === null || Array.isArray(fact)) return;
    const { kind, id } = fact as { kind?: unknown; id?: unknown };
    if (typeof kind !== 'string' || !(HISTORY_FACT_KINDS as readonly string[]).includes(kind)) {
      errors.push(`write[${index}] is a ${JSON.stringify(kind)} fact: the history stage writes ${HISTORY_FACT_KINDS.join(', ')}`);
      return;
    }
    if (kind === 'commit' && typeof id === 'string') commitIds.add(id);
    if (kind === 'task-key') edges.push({ index, value: (fact as { value?: unknown }).value });
  });
  for (const { index, value } of edges) {
    const from = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as { from?: unknown }).from : undefined;
    if (typeof from !== 'string' || !commitIds.has(from)) {
      errors.push(`write[${index}] is a task-key edge of ${JSON.stringify(from)}: an edge names a node that exists, and this draft writes no commit fact of that id`);
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// ---- the stage ------------------------------------------------------------

/**
 * The history stage, over the reader a run gives it: the stage's declaration
 * (0027), its plan (one unit per pinned snapshot), its execute (one repository's
 * ancestry at one commit) and its validate. The stage consumes the pinned
 * snapshot, since an ancestry is read at the commit a snapshot pinned, and its
 * own `commit` capability: a unit reads what its earlier run published, which is
 * what makes it incremental and is why no other producer of `commit` starves it.
 */
export function createHistoryStage(reader: HistoryReader): FillStage {
  return {
    id: HISTORY_STAGE_ID,
    version: HISTORY_STAGE_VERSION,
    consumes: {
      required: [
        { capability: HISTORY_INPUT_CAPABILITY, scope: 'product', freshness: 'current' },
        { capability: HISTORY_SELF_CAPABILITY, scope: 'repository', freshness: 'current' },
      ],
      optional: [],
    },
    produces: HISTORY_FACT_KINDS.map((kind) => ({ kind, schemaVersion: FACT_KINDS[kind].version, scope: 'repository' as const })),
    configSchema: HISTORY_CONFIG_SCHEMA,
    defaults: { enabled: true, concurrency: 1, limits: DEFAULT_STAGE_LIMITS, config: { depth: DEFAULT_HISTORY_DEPTH } },
    plan: (graph) => planUnits(graph),
    execute: (unit, context) => executeUnit(reader, unit, context),
    validate: (draft) => validateDraft(draft),
  };
}
