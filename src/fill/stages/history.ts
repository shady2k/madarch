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
 * The plan reads the run's own pins and no graph
 * (`SnapshotSource.pins()`, `planUnits`): a plan that read the graph's `snapshot`
 * facts would name the commit of a previous run, because the orchestrator asks
 * every stage to plan before any unit of the run executes. The reads one *unit*
 * makes are `commitsHeldQuery` and `coverageHeldQuery`, and they are SQL against
 * the fact store's rows, in the fill's own vocabulary of fact kinds: the commit
 * and the value a commit fact holds, and the value of one scope's coverage fact.
 * The repository and the scope a read interpolates are checked against their own
 * forms before they reach a query, so no read is built from a name a product did
 * not write.
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
import type { SnapshotSource } from '../snapshot.js';
import { checkStaticGraphDraft, graphWritesOf } from './static-graph.js';
import { STATIC_READ_ROW_LIMIT, type StaticGraphReader } from './static-context.js';
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
export const HISTORY_STAGE_VERSION = 3;

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
export const HISTORY_FACT_KINDS = ['author', 'authored', 'commit', 'coverage', 'parent', 'task-key', 'touched'] as const;

/**
 * The schema version each produced kind is written in. The four this stage writes as raw graph
 * items — the author node and the three history relations — carry the graph's own shape and no
 * fact-schema kind, so they are declared here at version 1.
 */
const HISTORY_PRODUCED_VERSIONS: Readonly<Record<(typeof HISTORY_FACT_KINDS)[number], number>> = {
  author: 1,
  authored: 1,
  commit: FACT_KINDS.commit.version,
  coverage: FACT_KINDS.coverage.version,
  parent: 1,
  'task-key': FACT_KINDS['task-key'].version,
  touched: 1,
};

/** The stage's own configuration: how deep into one repository's ancestry a unit reads, and which trailer of a commit message names task keys. */
const HISTORY_CONFIG_SCHEMA = Type.Object({
  depth: Type.Integer({ minimum: 1 }),
  /** The trailer the product declares as its task-key source; no name is assumed where it declares none. */
  trailer: Type.Optional(Type.String({ minLength: 1 })),
  /** The literal separators the product declares between the keys of one trailer value; required with `trailer`. */
  separators: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
});

// ---- the graph reads ------------------------------------------------------

/** The read names an execute makes: the commits the graph already holds for a repository, and this stage's coverage of one scope. */
export const COMMITS_HELD_READ = 'stage-7-held-commits';
export const HISTORY_COVERAGE_READ = 'stage-7-held-coverage';

/**
 * The reader every fact of this stage cites: its own reading of Git at one
 * commit. The coverage's identity carries the reader, so this stage's coverage
 * of one scope is its own and no other stage's.
 */
export const HISTORY_SOURCE_SYSTEM_NAME = 'madarch-history';

/** The reader this stage's facts cite, at the stage's own version. */
const HISTORY_SOURCE: FactSource = { system: HISTORY_SOURCE_SYSTEM_NAME, version: '2' };

/** The read an execute makes of the commit facts this repository's history already holds, with the value each holds. */
export function commitsHeldRead(repository: string): string {
  return JSON.stringify({ read: COMMITS_HELD_READ, repository: repositoryName(repository) });
}

/** The read an execute makes of the coverage fact it wrote for one scope, so a coverage that still holds is not written again. */
export function historyCoverageRead(repository: string, scope: string): string {
  return JSON.stringify({ read: HISTORY_COVERAGE_READ, repository: repositoryName(repository), scope: scopeText(scope) });
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
  /** The email the commit was authored under: the identity an author node is named by. */
  readonly authorEmail?: string;
  /** The paths the commit changed, from the repository's root, in code point order, each once. */
  readonly files: readonly RepositoryPath[];
  /** Every trailer git's own parser read from the commit's message, in the order the parser returns them. */
  readonly trailers: readonly HistoryTrailer[];
}

/** One trailer git's parser read: the key and the value, exactly as the parser returned them. */
export interface HistoryTrailer {
  readonly key: string;
  readonly value: string;
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
 * The log format: `%x1e` opens a commit's record and `%x1f` joins its fields.
 * The commit's trailers are one field of git's own trailer parser, each trailer
 * as the parser writes it (`key: value`), the items separated by NUL: a commit
 * message holds no NUL, so the parser's own text stays whole — and what a
 * trailer means is the product's declaration, never this reader's guess. A
 * message holding the record separator is refused by the parser rather than
 * read as two records.
 */
const HISTORY_LOG_FORMAT = '%x1e%H%x1f%P%x1f%ct%x1f%at%x1f%an%x1f%ae%x1f%s%x1f%(trailers:only,unfold,separator=%x00)';

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
 * parents, its two times, its author, its subject, the trailers git's own parser
 * read and the paths it changed. Everything a record holds that the format does not promise is
 * refused by name rather than read past: a record whose first field is no
 * commit, a parent that is no commit, a time that is no whole number of
 * seconds, a record with no path list, a trailer git's parser did not write as
 * `key: value`, and a path list that does not end with its separator. A message
 * holding the record separator reaches the reader as a record of its own, which
 * is why these refusals name the repository, the commit and the bytes rather
 * than dropping the record.
 */
function parseLog(text: string, at: { readonly repository: string; readonly commit: string; readonly folder: string }): HistoryCommit[] {
  const where = `history: the log of ${at.repository} at ${at.commit} in ${at.folder}`;
  const commits: HistoryCommit[] = [];
  for (const record of text.split(HISTORY_LOG_RECORD)) {
    if (record === '') continue;
    // The path list is the section that opens with a NUL: a newline and the paths where the
    // commit changed files, and the NUL alone where it changed none. Everything before it is
    // the record's fields; a commit message holds no NUL, so the parser's trailer text stays whole.
    const listed = record.indexOf('\x00\n');
    const pathAt = listed >= 0 ? listed : record.endsWith('\x00') ? record.length - 1 : -1;
    if (pathAt < 0) throw new Error(`${where} holds a record with no path list: ${JSON.stringify(record.slice(0, 120))}`);
    const fields = record.slice(0, pathAt).split(HISTORY_LOG_FIELD);
    const [commit, parents, committed, authored, author, authorEmail, subject, trailerText] = fields;
    if (commit === undefined || parents === undefined || committed === undefined || authored === undefined || author === undefined || authorEmail === undefined || subject === undefined || trailerText === undefined || fields.length !== 8) {
      throw new Error(`${where} holds a record with ${fields.length} fields: a record is the commit, its parents, its two times, its author's name and email, its subject, the trailers git's parser read and its paths`);
    }
    if (!COMMIT_PATTERN.test(commit)) {
      throw new Error(`${where} holds a record whose first field is ${JSON.stringify(commit)}: a commit is 40 lower-case hexadecimal digits, so this record is a message git wrote as one`);
    }
    const trailers = parseTrailers(trailerText, commit, where);
    const parentsRead = parents === '' ? [] : parents.split(' ').map((parent) => {
      if (!COMMIT_PATTERN.test(parent)) throw new Error(`${where} names the parent ${JSON.stringify(parent)} of ${commit}: a parent is 40 lower-case hexadecimal digits`);
      return parent;
    });
    const committedAt = isoTimestamp(committed, `the committer time of ${commit}`, where);
    const authoredAt = isoTimestamp(authored, `the author time of ${commit}`, where);
    const section = record.slice(pathAt);
    commits.push({
      commit,
      parents: parentsRead,
      committedAt,
      authoredAt,
      subject,
      ...(author === '' ? {} : { author }),
      ...(authorEmail === '' ? {} : { authorEmail }),
      files: parseFiles(section, commit, where),
      trailers,
    });
  }
  return commits;
}

/**
 * The trailers git's parser returned for one commit, in the parser's order:
 * each item is the parser's own `key: value` text, the items separated by NUL.
 * The first `": "` is git's separator; a value may hold another. An item the
 * parser did not write in that form is refused by the commit it belongs to.
 */
function parseTrailers(text: string, commit: string, where: string): HistoryTrailer[] {
  if (text === '') return [];
  return text.split('\x00').map((item) => {
    const at = item.indexOf(': ');
    if (at < 0) throw new Error(`${where} reads the trailer ${JSON.stringify(item)} of ${commit}: git's trailer parser writes each as "key: value"`);
    return { key: item.slice(0, at), value: item.slice(at + 2) };
  });
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

/**
 * The scope of the unit that reads one repository's ancestry: the repository itself. The unit's
 * own key is its range (`<repository>@<commit>`, `historyUnitId`), but the scope it publishes under
 * is the repository's: two runs at two commits write the same producer and scope, so a later range
 * replaces the earlier reading instead of colliding with it on the commits both ancestries hold
 * (decision 0033's fenced publication, and decision 0030's commit range as what a unit reads).
 */
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

/** The repository and the commit one unit's **id** names (`<repository>@<commit>`), refused by name where it is not that form. */
export function parseHistoryScope(unitId: string): PinnedSnapshot {
  const at = typeof unitId === 'string' ? unitId.lastIndexOf('@') : -1;
  const repository = at < 0 ? '' : unitId.slice(0, at);
  const commit = at < 0 ? '' : unitId.slice(at + 1);
  if (repository === '' || !ID_PATTERN.test(repository) || !COMMIT_PATTERN.test(commit)) {
    throw new Error(`history: the unit ${JSON.stringify(unitId)} names no repository at a commit: a history unit is "<repository>@<commit>", naming the product's own name for the repository and the 40 lower-case hexadecimal digits of the commit the run pinned`);
  }
  return { repository, commit };
}

/**
 * The units a plan names: one per repository the run pins, at the commit it pins
 * it at, in code point order of what they read, each occurring once.
 *
 * **The run's pins, not the graph's snapshot facts.** Stage 0 writes a `snapshot`
 * fact for what a run pins, and the orchestrator asks every stage to plan
 * *before* any unit of the run executes (decision 0027's one planning epoch), so
 * a plan that read the graph's snapshot facts would name the previous run's
 * commit — or, on a product's first run, nothing at all, which is `nothing-found`
 * for a stage whose input the run itself holds. madarch-tzte.21.8's walk found
 * exactly that: the eighth stage published one commit behind. The pins come from
 * the run's own source (`SnapshotSource.pins()`, `src/fill/snapshot.ts`), which
 * is what the run stands on, and the graph's snapshot facts are that same reading
 * once stage 0 has published them.
 */
async function planUnits(sources: SnapshotSource): Promise<StagePlan> {
  const pins = await sources.pins();
  if (pins.length === 0) return { units: [], coverage: 'nothing-found' };
  const units = pins.map((pin) => ({ id: historyUnitId(pin.id, pin.commit), scope: historyScope(pin.id, pin.commit) }));
  // In code point order of what each unit reads, whatever order the source pins
  // them in: two runs of one commit plan the same units in the same order.
  units.sort((left, right) => byCodePoint(left.id, right.id));
  return { units, coverage: 'planned' };
}

// ---- the facts one unit writes --------------------------------------------

/**
 * The task keys one commit's trailers name: the values of the trailer the
 * product declares, split on the literal separators the product declares, each
 * piece once, in code point order. No trailer name and no separator stands in
 * this module: a product that declares none yields no keys, and one that
 * declares both says how its own messages read.
 */
export function taskKeysOf(trailers: readonly HistoryTrailer[], trailer: string, separators: readonly string[]): string[] {
  const keys = new Set<string>();
  for (const one of trailers) {
    if (one.key !== trailer) continue;
    let pieces = [one.value];
    for (const separator of separators) {
      const split: string[] = [];
      for (const piece of pieces) split.push(...piece.split(separator));
      pieces = split;
    }
    for (const piece of pieces) if (piece !== '') keys.add(piece);
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
      ...(commit.trailers.length === 0 ? {} : { trailers: commit.trailers }),
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

/**
 * What the history stage's reader read, in the coverage's own words: the two
 * questions a read answers, one of which says the product declared no trailer
 * rather than leaving the absence unspoken.
 */
function historyRead(trailer: string | undefined): readonly string[] {
  return ['the pinned commit and its ancestry', trailer === undefined ? 'the task keys (none: the product declares no trailer)' : 'the task keys the declared trailer names'];
}

/** The `coverage` fact of one unit: what its read reached, and every gap it could not. */
function coverageFact(repository: string, scope: string, ancestry: HistoryAncestry, trailer: string | undefined) {
  const unread = coverageGaps(ancestry.unread, repository, scope);
  const value: CoverageValue = { repository, scope, complete: unread.length === 0, read: historyRead(trailer), unread };
  return makeNodeFact({
    kind: 'coverage',
    value,
    provenance: { source: HISTORY_SOURCE, repository: { id: repository, commit: ancestry.commit } },
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
async function readCommitsHeld(graph: StaticGraphReader, repository: string, range: string): Promise<Map<string, unknown>> {
  const query = commitsHeldRead(repository);
  const rows: unknown[] = [];
  let after: string | undefined;
  for (;;) {
    // The read asks for this range's nodes and no wider answer: a read whose answer is every
    // commit of the repository moves whenever any other unit publishes, and this unit's own
    // generation would never stand still (madarch-8bdc.2.3).
    const page = await graph.byProperty('code.commit', 'range', range, { limit: STATIC_READ_ROW_LIMIT, ...(after === undefined ? {} : { after }) });
    // The graph holds the snapshot stage's `code.commit` node of the same commit as well: a
    // commit the history stage read is one that cites this stage's reader, and that is the one
    // this read compares against.
    rows.push(...page.rows
      .filter((node) => {
        const provenance = node.properties['provenance'];
        const source = provenance !== null && typeof provenance === 'object' ? (provenance as Record<string, unknown>)['source'] : undefined;
        const system = source !== null && typeof source === 'object' ? (source as Record<string, unknown>)['system'] : undefined;
        // What this unit's earlier generation published for its own range, and nothing another range
        // read: a read over every range's copies would move whenever any range's unit published or
        // was retracted, and the range's own reading would never stand still (madarch-8bdc.2.3).
        return system === HISTORY_SOURCE_SYSTEM_NAME && node.properties['range'] === range;
      })
      .map((node) => ({ commit: String(node.properties['commit']), value: valueFieldsOf(node.properties) })));
    if (page.next === null) break;
    after = page.next;
  }
  const held = new Map<string, unknown>();
  rows.forEach((row, index) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new Error(`history: row ${index} of "${query}" is ${JSON.stringify(row)}, not a record with the commit and the value a fact holds`);
    }
    const { commit, value } = row as { commit?: unknown; value?: unknown };
    if (typeof commit !== 'string' || !COMMIT_PATTERN.test(commit)) {
      throw new Error(`history: row ${index} of "${query}" names the commit ${JSON.stringify(commit)}: a commit is 40 lower-case hexadecimal digits`);
    }
    // The graph holds one copy of a commit per range that read it (each range's unit publishes
    // under its own scope): what this unit compares against is the commit, and the first copy's
    // value is the one it already read.
    if (!held.has(commit)) held.set(commit, value);
  });
  return held;
}

/** The coverage fact this unit already wrote for its scope, as the graph holds it, or `undefined` where it holds none. */
async function readCoverageHeld(graph: StaticGraphReader, repository: string, scope: string): Promise<unknown | undefined> {
  const query = historyCoverageRead(repository, scope);
  const rows: unknown[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await graph.byProperty('code.coverage', 'scope', scope, { limit: STATIC_READ_ROW_LIMIT, ...(after === undefined ? {} : { after }) });
    for (const node of page.rows) {
      if (node.properties['scope'] !== scope) continue;
      const provenance = node.properties['provenance'];
      const source = provenance !== null && typeof provenance === 'object' ? (provenance as Record<string, unknown>)['source'] : undefined;
      const system = source !== null && typeof source === 'object' ? (source as Record<string, unknown>)['system'] : undefined;
      if (system !== HISTORY_SOURCE_SYSTEM_NAME) continue;
      rows.push({ value: coverageValueOf(node.properties) });
    }
    if (page.next === null) break;
    after = page.next;
  }
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

/** The coverage value a node carries: its own fields and none of the graph's bookkeeping. */
function coverageValueOf(properties: Record<string, unknown>): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  for (const key of ['repository', 'scope', 'complete', 'read', 'unread']) if (properties[key] !== undefined) value[key] = properties[key];
  return value;
}

/** The unit's bounded graph reads, refused by name where the run handed none. */
/**
 * The files the repository's tree holds, as the snapshot stage published them: a path and the
 * recordKey of its node. A commit's changed path is a `code.touched` edge to that node, and a path
 * the pinned tree does not hold has no node to name — a later tree that holds it moves this read,
 * and the generation is replaced rather than left with a smaller answer.
 */
async function readRepositoryFiles(graph: StaticGraphReader, repository: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  let after: string | undefined;
  for (;;) {
    const page = await graph.byProperty('code.file', 'repository', repository, { limit: STATIC_READ_ROW_LIMIT, ...(after === undefined ? {} : { after }) });
    for (const node of page.rows) {
      const path = node.properties['path'];
      const key = node.properties['recordKey'];
      if (typeof path === 'string' && typeof key === 'string' && key !== '') files.set(path, key);
    }
    if (page.next === null) break;
    after = page.next;
  }
  return files;
}

function staticGraphOf(unit: StageUnit, context: StageContext): StaticGraphReader {
  const held = context.static;
  if (held === undefined) {
    throw new Error(`the unit "${unit.id}" runs the history stage's static reading, and its context holds no bounded graph reads: a run hands a static stage its repository's path-scoped answers (src/fill/stages/history.ts, decision 0033)`);
  }
  return held;
}

/**
 * The key one commit node carries: the repository, the range the unit read and the commit. Two
 * runs at two commits write two ranges, and the ancestors both ancestries hold stand once under
 * each: a node's version belongs to the producer and scope that published it (decision 0033's
 * fenced publication), and a range's unit replaces its own copy.
 */
function commitNodeKeyOf(repository: string, range: string, commit: string): string {
  return `commit:${canonicalJsonDigest({ repository, range, commit })}`;
}

/**
 * The key one author node carries: the repository, the range the unit read and the email git
 * records. An author stands in as many ranges as read a commit of theirs, and each range's unit
 * owns its copy for the same reason a commit's key names its range: a node's version belongs to
 * the producer and scope that published it (decision 0033's fenced publication), and a second
 * run at another commit publishes under another scope.
 */
function authorNodeKeyOf(repository: string, range: string, email: string): string {
  return `code.author:${canonicalJsonDigest({ repository, range, email })}`;
}

/**
 * The value a fact holds, as the graph's node carries it: the fact's own fields and none of what
 * this stage's node carries beside them — the graph's bookkeeping and the `range` the node names.
 */
function valueFieldsOf(value: object): Record<string, unknown> {
  const held = { ...(value as Record<string, unknown>) };
  for (const key of ['recordKey', 'factKind', 'layer', 'status', 'provenance', 'range']) delete held[key];
  return held;
}

/**
 * The key one task key's node carries: the repository and the key. A task is one node however
 * many commits name it, so every commit's `code.tasks` edge joins that one node; the commit
 * belongs to the edge, never to the node's identity.
 */
function taskNodeKeyOf(repository: string, key: string): string {
  return `task:${canonicalJsonDigest({ repository, key })}`;
}

/**
 * The graph items one task key of a commit makes: a `code.task` node for the key
 * (the extractors' own kind, `src/extract/history/commits.ts`) and one
 * `code.tasks` edge from the commit's node to it.
 */
function taskNodeDrafts(repository: string, key: string, commitKey: string, evidence: string, nodeWritten: boolean): readonly StageDraftWrite[] {
  const to = taskNodeKeyOf(repository, key);
  const writes: StageDraftWrite[] = [];
  if (!nodeWritten) {
    writes.push({ kind: 'node', evidence, value: { key: to, kind: 'code.task', label: key, properties: { factKind: 'task-key', repository, key } } });
  }
  writes.push({
    kind: 'edge',
    evidence,
    value: { relation: 'code.tasks', from: { key: commitKey }, to: { key: to }, properties: { factKind: 'task-key', repository, key, line: 1 } },
  });
  return writes;
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
 * The trailer the product declares as its task-key source, with the separators
 * it declares between the keys of one value. Both are data: a product that
 * declares neither names no task key, and one that declares one without the
 * other is refused here rather than guessed at.
 */
function historyTrailer(config: unknown): { readonly trailer?: string; readonly separators?: readonly string[] } {
  const held = typeof config === 'object' && config !== null && !Array.isArray(config) ? (config as { trailer?: unknown; separators?: unknown }) : {};
  if (held.trailer === undefined && held.separators === undefined) return {};
  if (typeof held.trailer !== 'string' || held.trailer === '') {
    throw new Error(`history: config.trailer is ${JSON.stringify(held.trailer)}: a product that reads task keys declares the trailer's name, a non-empty text`);
  }
  if (!Array.isArray(held.separators) || held.separators.length === 0 || held.separators.some((one) => typeof one !== 'string' || one === '')) {
    throw new Error(`history: config.separators is ${JSON.stringify(held.separators)}: a product that reads task keys declares the literal separators between them, at least one non-empty text`);
  }
  return { trailer: held.trailer, separators: held.separators as readonly string[] };
}

/**
 * One unit's work: read what this repository's history already holds, read Git
 * at the pinned commit, and draft the facts of every commit of that ancestry,
 * each commit's task keys after it — oldest first, so a parent's fact always
 * stands before its children's — and then the unit's coverage.
 *
 * **A unit writes its whole set every time.** Decision 0027's publication
 * replaces the facts of the unit that publishes, and of no other: a fact the unit
 * held and does not write again loses its holding and, with no other holder, its
 * row. So a unit that wrote only what had changed would retract what it read and
 * agreed with, and the read that follows it would answer something else — which
 * the orchestrator's recheck reads as a read that moved, so the unit would go
 * stale and be worked again for ever (madarch-tzte.21.8's walk found exactly that
 * loop). What the unit already holds is *read* here, so the unit says how much of
 * its set the graph already agreed with; every fact of the set is written.
 */
async function executeUnit(reader: HistoryReader, unit: StageUnit, context: StageContext): Promise<StageExecutionResult> {
  const { repository, commit } = parseHistoryScope(unit.id);
  const depth = historyDepth(context.config.config);
  const { trailer, separators } = historyTrailer(context.config.config);
  const what = `history: unit ${unit.id}`;
  if (context.signal.aborted) throw new Error(`${what} was cancelled before it read ${repository} at ${commit}`);
  const graph = staticGraphOf(unit, context);
  const held = await readCommitsHeld(graph, repository, commit);
  const heldCoverage = await readCoverageHeld(graph, repository, unit.scope);
  const ancestry = await reader.read({ repository, commit, depth, signal: context.signal });
  context.progress(`read the ancestry of ${repository} at ${commit}: ${ancestry.commits.length} ${ancestry.commits.length === 1 ? 'commit' : 'commits'}`, 0.5);

  const writes: StageDraftWrite[] = [];
  // The task keys whose node this draft already writes: one node per key, one edge per commit.
  const writtenTaskNodes = new Set<string>();
  let commitsWritten = 0;
  let keysWritten = 0;
  let commitsAgreed = 0;
  for (const one of ancestry.commits) {
    const fact = commitFact(repository, one, HISTORY_SOURCE);
    // What the graph already holds is reported and not skipped: the unit's own
    // publication replaces its own facts, so the whole set is written every time
    // (see this function's own doc).
    const known = held.get(one.commit);
    if (known !== undefined && canonicalJsonDigest(known) === canonicalJsonDigest(valueFieldsOf(fact.value))) commitsAgreed += 1;
    const evidence = `${repository}@${one.commit}`;
    const commitKey = commitNodeKeyOf(repository, ancestry.commit, one.commit);
    for (const write of graphWritesOf(fact, evidence)) {
      // The node carries the range its unit read: this stage's held-commits read answers its own range
      // and no other (see `readCommitsHeld`).
      writes.push(write.kind === 'node' ? { ...write, value: { ...write.value, key: commitKey, properties: { ...write.value.properties, range: ancestry.commit } } } : write);
    }
    commitsWritten += 1;
    if (trailer !== undefined && separators !== undefined) {
      for (const key of taskKeysOf(one.trailers, trailer, separators)) {
        // One `code.task` node per key in the unit's draft, whatever commits name it: a node's
        // key stands once in one publication, and each commit's own `code.tasks` edge names it.
        const node = taskNodeDrafts(repository, key, commitKey, evidence, writtenTaskNodes.has(key));
        if (!writtenTaskNodes.has(key)) writtenTaskNodes.add(key);
        writes.push(...node);
        keysWritten += 1;
      }
    }
  }

  // The author of every commit, its first parent and the files it changed: the three relations the
  // history extractor states beside the commit, and this stage wrote none of them. A file edge names
  // the file node the snapshot stage published, so only a path the tree read answers is written;
  // an answer that grows replaces this generation (the read is tracked).
  const files = await readRepositoryFiles(graph, repository);
  const authors = new Map<string, { readonly key: string; readonly name: string; readonly email: string }>();
  for (const one of ancestry.commits) {
    if (one.authorEmail === undefined || one.authorEmail === '') continue;
    const key = authorNodeKeyOf(repository, ancestry.commit, one.authorEmail);
    authors.set(key, { key, name: one.author ?? one.authorEmail, email: one.authorEmail });
  }
  for (const author of [...authors.values()].sort((left, right) => byCodePoint(left.key, right.key))) {
    writes.push({
      kind: 'node',
      evidence: `${repository}@${ancestry.commit}`,
      value: { key: author.key, kind: 'code.author', label: author.name, properties: { factKind: 'author', repository, range: ancestry.commit, email: author.email, name: author.name, recordKey: author.key } },
    });
  }
  const readCommits = new Set(ancestry.commits.map((one) => one.commit));
  for (const one of ancestry.commits) {
    const commitKey = commitNodeKeyOf(repository, ancestry.commit, one.commit);
    const evidence = `${repository}@${one.commit}`;
    if (one.authorEmail !== undefined && one.authorEmail !== '') {
      writes.push({ kind: 'edge', evidence, value: { relation: 'code.authored', from: { key: commitKey }, to: { key: authorNodeKeyOf(repository, ancestry.commit, one.authorEmail) }, properties: { factKind: 'authored', repository } } });
    }
    const parent = one.parents[0];
    if (parent !== undefined && readCommits.has(parent)) {
      writes.push({ kind: 'edge', evidence, value: { relation: 'code.parent', from: { key: commitKey }, to: { key: commitNodeKeyOf(repository, ancestry.commit, parent) }, properties: { factKind: 'parent', repository } } });
    }
    for (const path of one.files) {
      const fileKey = files.get(path);
      if (fileKey === undefined) continue;
      writes.push({ kind: 'edge', evidence, value: { relation: 'code.touched', from: { key: commitKey }, to: { key: fileKey }, properties: { factKind: 'touched', repository } } });
    }
  }

  const coverage = coverageFact(repository, unit.scope, ancestry, trailer);
  const coverageAgreed = heldCoverage !== undefined && canonicalJsonDigest(heldCoverage) === canonicalJsonDigest(valueFieldsOf(coverage.value));
  for (const write of graphWritesOf(coverage, `${repository}@${ancestry.commit}`)) writes.push(write);

  for (const write of writes) context.draft.write(write);
  context.progress(`wrote ${commitsWritten} ${commitsWritten === 1 ? 'commit' : 'commits'} (${commitsAgreed} the graph already held) and ${keysWritten} task ${keysWritten === 1 ? 'key' : 'keys'} of ${repository} at ${commit}, with the coverage ${coverageAgreed ? 'the graph already held' : 'this read wrote'}`, 1);
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
  const checked = checkStaticGraphDraft(HISTORY_STAGE_ID, HISTORY_FACT_KINDS, draft);
  const errors: string[] = checked.ok ? [] : [...checked.errors];
  // The graph's validator reads each item's key, kind, ends and position; this is the
  // stage's own rule over the same draft: a task key's edge starts at a commit node this
  // draft writes.
  const commitKeys = new Set<string>();
  draft.writes.forEach((write: StageDraftWrite) => {
    if (write.kind === 'node' && write.value.kind === 'code.commit') commitKeys.add(write.value.key);
  });
  draft.writes.forEach((write: StageDraftWrite, index: number) => {
    if (write.kind !== 'edge' || write.value.relation !== 'code.tasks') return;
    const from = 'key' in write.value.from ? write.value.from.key : undefined;
    if (from === undefined || !commitKeys.has(from)) {
      errors.push(`write[${index}] is a task-key edge of ${JSON.stringify(from)}: an edge names a node that exists, and this draft writes no commit node of that key`);
    }
  });
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
export function createHistoryStage(reader: HistoryReader, sources: SnapshotSource): FillStage {
  return {
    id: HISTORY_STAGE_ID,
    version: HISTORY_STAGE_VERSION,
    // Its unit reads Git (decision 0030's commit range) and the graph, never a tree (decision 0033, item 5).
    staticReading: true,
    consumes: {
      required: [
        { capability: HISTORY_INPUT_CAPABILITY, scope: 'product', freshness: 'current' },
        { capability: HISTORY_SELF_CAPABILITY, scope: 'repository', freshness: 'current' },
      ],
      optional: [],
    },
    produces: HISTORY_FACT_KINDS.map((kind) => ({ kind, schemaVersion: HISTORY_PRODUCED_VERSIONS[kind], scope: 'repository' as const })),
    configSchema: HISTORY_CONFIG_SCHEMA,
    defaults: { enabled: true, concurrency: 1, limits: DEFAULT_STAGE_LIMITS, config: { depth: DEFAULT_HISTORY_DEPTH } },
    plan: () => planUnits(sources),
    execute: (unit, context) => executeUnit(reader, unit, context),
    validate: (draft) => validateDraft(draft),
  };
}
