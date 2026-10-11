/**
 * The code repositories a product's manifest declares, as the wiki reads them
 * (docs/changes/wiki-repos, requirement `repositories` of product-wiki): each
 * with its name, url and optional branch as the manifest holds them, and the
 * state of its checkout under the product's `repos/` folder.
 *
 * The manifest's own reading is the pinned program's (`./manifest.ts`): a
 * `repos` item the program refuses was refused before anything here ran, and
 * this module reads the list that reading gave back.
 *
 * A checkout is a folder `repos/<name>` holding a git repository of its own.
 * Asking about it runs real git at the checkout — read-only git (`rev-parse`
 * and `log`), never a command that writes — and the environment the runs get
 * drops the same loader variables the pinned program's own runs drop, so a
 * call here can never reach into another repository's worktree.
 *
 * Every ask reads from disk now, like the pages do: a commit made inside a
 * checkout after the last ask is what the next ask reports. A checkout that
 * cannot be read — a name taken by something that is no folder, no git
 * repository of its own, a symlink, a HEAD git cannot show, bytes that
 * cannot be read — is reported as `unreadable` with the cause named, never
 * thrown, and never left as a silently smaller section.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join as joinPath, resolve as resolvePath } from 'node:path';
import type { ProgramGitEnv } from '../product/program.js';
import type { ProductIdentity, ProductRepo } from '../product/manifest.js';
import { byCodePoint } from '../model/order.js';

/** The folder under the product where a checkout stands, by its declared name. */
export const REPOS_FOLDER = 'repos';

/** The checkout's last commit, as git itself reports its HEAD. */
export interface RepoHead {
  /** The short sha HEAD answers, the way the row shows it. */
  sha: string;
  /** The commit's subject line, its first line whole. */
  subject: string;
  /** The commit's time as git reported it, ISO 8601 with an offset. */
  committedAt: string;
}

/** A README found at a checkout's root, read whole for the section's rendering. */
export interface RepoReadme {
  /** The file's name at the checkout's root, as the folder holds it. */
  file: string;
  /** The file's bytes, read for the wiki's Markdown renderer. */
  markdown: string;
}

/** How a declared repository's checkout stands. */
export type RepoState = 'checked-out' | 'not-checked-out' | 'unreadable';

/** The code repositories the wiki answers for, as one ask found them. */
export type ProductRefsAnswer = {
  ok: true;
  /** Code point order of the repositories' names. */
  repos: ProductRepoEntry[];
};

/** One declared repository as the wiki's answer names it. */
export interface ProductRepoEntry {
  /** The repository's name in the manifest; the checkout folder's name under `repos/`. */
  name: string;
  /** The url the manifest declares. */
  url: string;
  /** The branch the manifest declares, when it declares one. */
  branch?: string;
  /** The checkout's state under `repos/`. */
  state: RepoState;
  /** The checkout's HEAD, when a checkout is there and git could read a commit of it. */
  head?: RepoHead;
  /** The README at the checkout's root, when the checkout is there and its bytes could be read. */
  readme?: RepoReadme;
  /** Why the row is not the ordinary one, naming the path — carried for `unreadable` and a commitless checkout. */
  problem?: string;
}

/** The loader variables a git call here strips, exactly the pinned program's own list. */
const GIT_LEAKS = ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'] as const;

/** How long one read-only git call may run before the checkout is reported unreadable. */
export const GIT_TIMEOUT_MS = 10_000;

/** The git call's result: its combined output, and whether git said yes. */
type GitRead = { ok: true; output: string } | { ok: false; output: string };

/**
 * The environment one git call runs in: the caller's environment with the
 * loader variables stripped, then the caller's overrides merged over it —
 * and the loader variables stripped again, so no override can re-add the
 * one leak the strip exists for.
 */
function gitEnvironment(extra: ProgramGitEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !(GIT_LEAKS as readonly string[]).includes(name)) env[name] = value;
  }
  Object.assign(env, extra);
  for (const name of GIT_LEAKS) delete env[name];
  return env;
}

/**
 * One read-only git call at a folder, with everything around it stripped the
 * way the pinned program's own runs are: no loader variable reaches the
 * call, and an identity a test passes is merged over what is left. The
 * failure carries git's own output when git said anything, else the cause of
 * the silence — never an empty refusal.
 */
function gitRead(folder: string, args: readonly string[], extra: ProgramGitEnv): GitRead {
  const run = spawnSync('git', ['--no-pager', ...args], { cwd: folder, encoding: 'utf8', env: gitEnvironment(extra), timeout: GIT_TIMEOUT_MS });
  const said = `${run.stderr ?? ''}${run.stdout ?? ''}`.trim();
  if (run.status === 0 && said !== '') return { ok: true, output: said };
  // A failure is named by git's own words when git said anything; the cause
  // of the silence is the answer when it said nothing.
  if (said !== '') return { ok: false, output: said };
  if (run.error !== undefined) return { ok: false, output: run.error.message };
  if (run.signal === 'SIGTERM') return { ok: false, output: `the git call ran past its ${GIT_TIMEOUT_MS} ms bound` };
  return { ok: false, output: `git ${args.join(' ')} exited without success (status ${run.status})` };
}

/**
 * How the question "is this checkout a git repository of its own" was
 * answered: yes; no, with git naming another repository (the ordinary
 * not-a-checkout); or no, with git unable to answer at all (the cause of
 * that silence is the answer).
 */
type OwnRepository =
  | { kind: 'own' }
  | { kind: 'another'; top: string }
  | { kind: 'unknown'; cause: string };

/**
 * Whether a checkout holds a git repository of its own: the same question
 * the pinned program's `ownRepository` answers, by `rev-parse
 * --show-toplevel` against the folder's real path — a folder with no
 * repository of its own would answer for the repository above it, and a
 * report about that repository's HEAD would be someone else's.
 */
function ownRepository(checkout: string, gitEnv: ProgramGitEnv): OwnRepository {
  const top = gitRead(checkout, ['rev-parse', '--show-toplevel'], gitEnv);
  if (!top.ok) return { kind: 'unknown', cause: top.output };
  // git answers with the real path, so the checkout is its own only when the
  // answer resolves back to the folder asked about.
  if (realpathSync(top.output) === realpathSync(checkout)) return { kind: 'own' };
  return { kind: 'another', top: top.output };
}

/** The README names the section renders, by priority: lower-case spellings, most specific first. */
const README_NAMES = ['readme.md', 'readme.markdown', 'readme.mkd', 'readme.txt', 'readme'] as const;

/**
 * The README a checkout's root holds, any case: the first candidate in the
 * fixed priority order that the root actually holds as a regular file, by
 * its lower-case name — the folder's own spelling is what the answer
 * carries. Nothing found is `undefined`, the row's quiet case.
 */
function readmeAt(checkout: string): RepoReadme | undefined {
  const held = readdirSync(checkout);
  for (const wanted of README_NAMES) {
    // A case-insensitive match is the README, a folder of that name is not;
    // several spellings of one name break the tie in code point order, so
    // the same folder always answers with the same README. The folder's own
    // spelling is what the answer carries.
    const matches = held
      .filter((name) => name.toLowerCase() === wanted && lstatSync(joinPath(checkout, name)).isFile())
      .sort(byCodePoint);
    if (matches[0] !== undefined) return { file: matches[0], markdown: readFileSync(joinPath(checkout, matches[0]), 'utf8') };
  }
  return undefined;
}

/** One declared repository, asked whole: its checkout state, HEAD and README. */
function readOne(productFolder: string, declared: ProductRepo, gitEnv: ProgramGitEnv): ProductRepoEntry {
  const entry: Omit<ProductRepoEntry, 'state'> = { name: declared.name, url: declared.url };
  if (declared.branch !== undefined) entry.branch = declared.branch;
  const target = joinPath(productFolder, REPOS_FOLDER, declared.name);
  try {
    const found = lstatSync(target);
    if (found.isSymbolicLink()) {
      return {
        ...entry,
        state: 'unreadable',
        problem: `${target} is a symlink: a checkout is a folder of its own, and this wiki reports on the folder named ` +
          `${JSON.stringify(target)} only`,
      };
    }
    if (!found.isDirectory()) {
      return {
        ...entry,
        state: 'unreadable',
        problem: `${JSON.stringify(target)} is not a folder: a checkout is a folder, and that name is taken by something else`,
      };
    }
  } catch (error) {
    // A missing folder is the ordinary "not checked out"; a folder that gave
    // its listing only to fail another way is unreadable, cause named.
    if (!existsSync(target)) return { ...entry, state: 'not-checked-out' };
    return {
      ...entry,
      state: 'unreadable',
      problem: `the checkout ${JSON.stringify(target)} could not be read: ${(error as Error).message}`,
    };
  }
  const own = ownRepository(target, gitEnv);
  if (own.kind === 'unknown') {
    return {
      ...entry,
      state: 'unreadable',
      problem: `git could not read the checkout ${JSON.stringify(target)}: ${own.cause}`,
    };
  }
  if (own.kind === 'another') {
    return {
      ...entry,
      state: 'unreadable',
      problem: `${JSON.stringify(target)} is not a git checkout of its own: git answers for the repository at ` +
        `${JSON.stringify(own.top)} above it, and a report about that repository's HEAD would be someone else's`,
    };
  }
  // The HEAD: one commit, read-only, its short sha, subject and time.
  const head = gitRead(target, ['log', '-1', '--pretty=format:%h%x00%s%x00%cI'], gitEnv);
  const next: ProductRepoEntry = { ...entry, state: 'checked-out' };
  if (!head.ok) {
    // A repository with no commit yet is still a checkout: the row names the
    // cause git itself gave, and the README below it can still show.
    next.problem = `the checkout ${JSON.stringify(target)} shows no commit yet: git answers: ${head.output}`;
    return withReadme(next, target, productFolder, declared.name);
  }
  const [sha, subject, committedAt] = head.output.split('\u0000');
  return withReadme({
    ...next,
    head: { sha: sha ?? '', subject: subject ?? '', committedAt: committedAt ?? '' },
  }, target, productFolder, declared.name);
}

/** Adds the root README, when the bytes could be read; a failed read is a problem named, never a crash. */
function withReadme(entry: ProductRepoEntry, target: string, productFolder: string, name: string): ProductRepoEntry {
  try {
    const readme = readmeAt(target);
    if (readme !== undefined) entry.readme = readme;
    return entry;
  } catch (error) {
    entry.problem = entry.problem === undefined
      ? `the README under ${JSON.stringify(joinPath(productFolder, REPOS_FOLDER, name))} could not be read: ${(error as Error).message}`
      : entry.problem;
    return entry;
  }
}

/**
 * The wiki's answer over the manifest's declared repositories: every one, in
 * code point order of its name, its checkout state, HEAD and README read
 * from disk now. Nothing here refuses: the manifest's own reading is
 * finished before this runs, and a checkout that answers wrong is reported,
 * with the cause named, in its own row.
 */
export function readProductRepos(product: ProductIdentity, gitEnv: ProgramGitEnv = {}): ProductRefsAnswer {
  const repos = product.repos
    .map((declared) => readOne(product.folder, declared, gitEnv))
    .sort((one, other) => byCodePoint(one.name, other.name));
  return { ok: true, repos };
}
