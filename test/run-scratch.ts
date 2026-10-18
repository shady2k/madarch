/**
 * One scratch home and one temporary folder per `bun test` run (madarch-1xq).
 *
 * The owner's choice: a preload declared in `bunfig.toml` creates one fresh
 * scratch folder before any test file loads and removes it when the run ends,
 * pass or fail, so cleanliness never depends on each test remembering to
 * redirect its own paths. `HOME`, `MADARCH_HOME`, `TMPDIR` and
 * `MADARCH_WIKI_CACHE` — every path madarch derives from the account's home or
 * from the system temporary folder — point inside that one folder, and the
 * children tests spawn inherit them:
 *
 * Inside that one folder stand, by the variable that points there:
 *
 *     home        HOME
 *     madarch     MADARCH_HOME, whose products home is `products/`
 *     tmp         TMPDIR, where `tmpdir()` and `mkdtemp` land
 *     wiki-cache  MADARCH_WIKI_CACHE, created private on first use
 *
 * The folder stands in the system temporary folder under
 * `madarch-test-run-<6 random letters>`, so a file the run leaves behind is
 * inside it and dies with it, and a run that crashed can be told from a live
 * one by the `owner.json` it writes: the next run sweeps the folders of dead
 * runs away.
 *
 * `bun test --watch` is not covered: Bun offers no way to tell a watch run
 * from a finished one (measured on 1.4.2: no flag in `process.argv`, no
 * variable in the environment), so the first pass removes the scratch and a
 * later pass writes into a folder that is gone — the error names it.
 *
 * Removal is by this file, not by the tests: it removes the tree even when a
 * test made a folder it created unwritable and never restored it (the
 * madarch-1xq evidence: a plain `rm -rf` could not remove several hundred
 * leftovers because of exactly that). Every folder is made writable again on
 * the way down, so the end of a run never fails on a permission it met.
 *
 * What a preload cannot do, measured on Bun 1.4.2: `os.homedir()` is resolved
 * once when the process starts, so setting `HOME` afterwards leaves it at the
 * account's real home inside this process (a child process started with the
 * scratch `HOME` resolves it there). Every path madarch derives from a home
 * reads `MADARCH_HOME`, `MADARCH_WIKI_CACHE` or `TMPDIR` first and so lands in
 * the scratch anyway and no home-derived default is left in `src/` (the fill
 * wizard's settings file reads `HOME` for this reason). Bun also reads a
 * `bunfig.toml` only from the folder the run starts in, so this covers a run
 * started in this package (`bun test`, `bun run test`, CI's `bun test test/`),
 * not one started inside `test/`.
 */
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** How a run's scratch folder is named in the system temporary folder. */
export const RUN_SCRATCH_PREFIX = 'madarch-test-run-';
/** The variable naming the run's scratch folder, for a test that checks where it stands. */
export const RUN_SCRATCH_VARIABLE = 'MADARCH_TEST_SCRATCH';
/** The variable naming the system temporary folder the run started in, outside the scratch. */
export const REAL_TEMP_VARIABLE = 'MADARCH_TEST_REAL_TMPDIR';

/** A run's own scratch: the one folder it may leave files in, and the folder it stands in. */
export interface RunScratch {
  readonly folder: string;
  readonly realTemporaryFolder: string;
}

/** The identity a run leaves in its scratch, so a later run can tell a dead one from a live one. */
interface Owner {
  readonly pid: number;
  /** Written for a person reading the folder; the sweep judges a folder by its pid alone. */
  readonly startedAt: string;
}

interface RunScratchState {
  readonly scratch: RunScratch;
  removed: boolean;
}

/** One run folder's owner file: absent or unreadable means the folder has no identity to trust. */
const OWNER_FILE = 'owner.json';
/**
 * How old a run folder without a readable identity must be before it is taken
 * as abandoned. A folder that does name its process is judged by that process
 * alone: a run may last hours (paused in a debugger, a long real-browser walk),
 * and its folder's own modification time does not move while it writes below
 * it, so age alone must never take a live run's folder.
 */
const ABANDONED_AFTER_MS = 6 * 60 * 60 * 1000;

const STATE_KEY = Symbol.for('madarch.test.run-scratch');

/**
 * The run's scratch, created on first use and the same for every importer: a
 * test file that imports this module after the preload loaded it takes the
 * run's own scratch, never a second one.
 */
export function runScratch(): RunScratch {
  const existing = (globalThis as Record<symbol, unknown>)[STATE_KEY] as RunScratchState | undefined;
  if (existing !== undefined) return existing.scratch;
  const scratch = createRunScratch();
  (globalThis as Record<symbol, unknown>)[STATE_KEY] = { scratch, removed: false } satisfies RunScratchState;
  removeDeadRuns(scratch);
  return scratch;
}

/** The run's state: created already, since `runScratch()` is the only way in. */
function stateOf(): RunScratchState {
  const state = (globalThis as Record<symbol, unknown>)[STATE_KEY] as RunScratchState | undefined;
  if (state === undefined) throw new Error('the run scratch was never created: runScratch() must be called before the hooks');
  return state;
}

/** Makes the run's folder and points every derived path into it, before any test file loads. */
function createRunScratch(): RunScratch {
  // The system temporary folder as the run started: the scratch folder itself
  // stands here, so a person can see with `ls` whether a run left anything.
  const realTemporaryFolder = tmpdir();
  const folder = mkdtempSync(join(realTemporaryFolder, RUN_SCRATCH_PREFIX));
  const home = join(folder, 'home');
  const madarchHome = join(folder, 'madarch');
  const temporary = join(folder, 'tmp');
  const cache = join(folder, 'wiki-cache');
  for (const made of [home, madarchHome, temporary]) mkdirSync(made, { mode: 0o700 });
  // The cache folder itself is not made here: `ensureWikiCacheRoot` creates it
  // private to the user, and refuses one already writable by group or others.
  const account = process.env.HOME;
  process.env.HOME = home;
  process.env.MADARCH_HOME = madarchHome;
  process.env.TMPDIR = temporary;
  process.env.MADARCH_WIKI_CACHE = cache;
  process.env[RUN_SCRATCH_VARIABLE] = folder;
  process.env[REAL_TEMP_VARIABLE] = realTemporaryFolder;
  // Puppeteer's downloaded browser lives in the account's cache and is only
  // read: keeping that path readable keeps the real-browser checks runnable
  // without a download, and a browser that is not there is looked for on PATH.
  if (process.env.PUPPETEER_CACHE_DIR === undefined && account !== undefined && account !== '') {
    process.env.PUPPETEER_CACHE_DIR = join(account, '.cache', 'puppeteer');
  }
  // Bun's own download cache for the packages a test installs (the wiki
  // engine's template): the person's, shared read and write the way their own
  // `bun install` shares it. It is the package manager's cache, not a path
  // madarch derives, and without it every run downloads the same packages from
  // the network again — measured: a file of the suite that installs the
  // template took 1.6 s with it and 10.4 s without.
  const installRoot = process.env.BUN_INSTALL?.trim();
  const bunHome = installRoot !== undefined && installRoot !== '' ? installRoot : account === undefined || account === '' ? undefined : join(account, '.bun');
  if (process.env.BUN_INSTALL_CACHE_DIR === undefined && bunHome !== undefined) {
    process.env.BUN_INSTALL_CACHE_DIR = join(bunHome, 'install', 'cache');
  }
  const owner: Owner = { pid: process.pid, startedAt: new Date().toISOString() };
  writeFileSync(join(folder, OWNER_FILE), `${JSON.stringify(owner)}\n`);
  return { folder, realTemporaryFolder };
}

/**
 * Removes the run's scratch at every way a run can end. Bun's test runner has
 * no end-of-run hook of its own and `process.on('exit')` alone never fires at
 * the end of a `bun test` (measured on 1.4.2), so the preload's own `afterAll`
 * is the end of the run; the others cover a run stopped by a signal or by a
 * test that exits the process itself.
 */
async function installEndOfRun(): Promise<void> {
  const remove = (): void => removeRunScratchOnce(stateOf());
  try {
    const { afterAll } = await import('bun:test');
    afterAll(remove);
  } catch {
    // Not a test run: the process hooks below are the only end there is.
  }
  process.on('beforeExit', remove);
  process.on('exit', remove);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => { remove(); process.exit(signal === 'SIGINT' ? 130 : 143); });
  }
}

/** Removes the scratch once, saying plainly when it could not be removed. */
function removeRunScratchOnce(state: RunScratchState): void {
  if (state.removed) return;
  state.removed = true;
  try {
    forceRemove(state.scratch.folder);
  } catch (error) {
    process.stderr.write(`madarch test run: the scratch folder ${state.scratch.folder} could not be removed: ${(error as Error).message}\n`);
  }
}

/**
 * Removes a tree whatever permissions its folders carry: each folder is made
 * writable again on the way down, a link is removed without being followed,
 * and a path already gone is not an error. This is what makes the end of a run
 * succeed when a test left a folder it created unwritable.
 */
export function forceRemove(path: string): void {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!stats.isDirectory()) {
    unlinkSync(path);
    return;
  }
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) forceRemove(join(path, name));
  rmdirSync(path);
}

/** Removes the scratch folders of runs that are over: a crashed run never removes its own. */
function removeDeadRuns(scratch: RunScratch): void {
  let names: string[];
  try {
    names = readdirSync(scratch.realTemporaryFolder);
  } catch {
    return; // a temporary folder that cannot be listed leaves the sweep to the next run
  }
  for (const name of names) {
    if (!name.startsWith(RUN_SCRATCH_PREFIX)) continue;
    const folder = join(scratch.realTemporaryFolder, name);
    if (folder === scratch.folder) continue;
    if (!abandoned(folder)) continue;
    try {
      forceRemove(folder);
    } catch {
      // A folder another process still holds is left for a later run, never a failed run.
    }
  }
}

/**
 * Whether a run folder belongs to a run that is over. A folder that names its
 * process is judged by that process and nothing else; only a folder without a
 * readable identity falls to age, and only when it is far too old to belong to
 * anything still running.
 */
function abandoned(folder: string): boolean {
  const owner = readOwner(folder);
  let stats;
  try {
    stats = statSync(folder);
  } catch {
    return false; // gone between the listing and here: nothing to sweep
  }
  if (owner !== undefined) return !running(owner.pid);
  return Date.now() - stats.mtimeMs > ABANDONED_AFTER_MS;
}

/**
 * The owner file of a run folder, or undefined when it is missing, unreadable
 * or names no process id a run could have: `0` and `1` are never a test run, and
 * a folder naming one of them falls to the age rule like one with no file.
 */
function readOwner(folder: string): { pid: number } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(folder, OWNER_FILE), 'utf8')) as Partial<Owner>;
    return typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 1 ? { pid: parsed.pid } : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a process is still there: one this process may not signal counts as there. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// The preload's work, at load: create the scratch, point the variables into
// it, and leave the removal to the hooks above.
runScratch();
await installEndOfRun();
