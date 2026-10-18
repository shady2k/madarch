/**
 * The run's scratch home and temporary folder (madarch-1xq): what the preload
 * `test/run-scratch.ts` promises every test file and every child it spawns —
 * `HOME`, `MADARCH_HOME`, `TMPDIR` and `MADARCH_WIKI_CACHE` point inside one
 * folder under the system temporary folder, that folder is gone when a run
 * ends, pass or fail, and a folder a run left unwritable does not stop the
 * removal. The child runs are real `bun test` runs of
 * `test/fixtures/run-scratch/writes.case.ts`, which writes to every one of
 * those paths the way a test that knows nothing about isolation would, and
 * then makes its own folders unwritable.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';
import { forceRemove, runScratch, REAL_TEMP_VARIABLE, RUN_SCRATCH_PREFIX, RUN_SCRATCH_VARIABLE } from './run-scratch.js';
import { productsHome } from '../src/product/draft.js';
import { wikiCacheRoot } from '../src/wiki/cache.js';

const SCRATCH = runScratch();
const REPO = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = './test/fixtures/run-scratch/writes.case.ts';

/** The value of a variable that must point inside the run's scratch, named in the error when it does not. */
function insideScratch(name: string, value: string | undefined, folder: string): string {
  if (value === undefined || value === '') throw new Error(`${name} is not set: the run's preload did not point it into the scratch folder ${folder}`);
  if (value !== folder && !value.startsWith(folder + sep)) throw new Error(`${name} is ${value}, not inside the run's scratch folder ${folder}`);
  return value;
}

describe('the run scratch the preload makes', () => {
  test('HOME, MADARCH_HOME, TMPDIR and MADARCH_WIKI_CACHE point inside it', () => {
    const folder = SCRATCH.folder;
    for (const name of ['HOME', 'MADARCH_HOME', 'TMPDIR', 'MADARCH_WIKI_CACHE']) insideScratch(name, process.env[name], folder);
    expect(process.env[RUN_SCRATCH_VARIABLE]).toBe(folder);
    expect(process.env[REAL_TEMP_VARIABLE]).toBe(SCRATCH.realTemporaryFolder);
    // The home itself, the madarch home and the temporary folder are the three
    // folders the preload makes; the cache is made private on first use.
    for (const made of ['home', 'madarch', 'tmp']) expect(statSync(join(folder, made)).isDirectory()).toBe(true);
  });

  test('the folder stands in the system temporary folder, named as a run', () => {
    expect(tmpdir()).toBe(join(SCRATCH.folder, 'tmp'));
    expect(SCRATCH.folder.startsWith(join(SCRATCH.realTemporaryFolder, RUN_SCRATCH_PREFIX))).toBe(true);
    expect(statSync(SCRATCH.realTemporaryFolder).isDirectory()).toBe(true);
    expect(statSync(SCRATCH.folder).isDirectory()).toBe(true);
  });

  test('the products home and the wiki cache resolve into it with no variable of their own to redirect', () => {
    // The two paths madarch derives from the account's home: both follow the
    // run's variables, so a run that writes through them writes in the scratch.
    insideScratch('the products home', productsHome(process.env), SCRATCH.folder);
    insideScratch('the wiki cache root', wikiCacheRoot(process.env), SCRATCH.folder);
  });
});

/** One child `bun test` run of the fixture, and the paths it printed. */
interface ChildRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function childRun(failing: boolean): ChildRun {
  const bun = Bun.which('bun');
  if (bun === null) throw new Error('bun is not on PATH: the child run of the scratch fixture cannot start');
  const child = Bun.spawnSync([bun, 'test', FIXTURE], {
    cwd: REPO,
    env: failing ? { ...process.env, MADARCH_SCRATCH_FIXTURE_FAIL: '1' } : { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { status: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}

/** The paths the fixture printed, by the kind it wrote them as. */
function printedPaths(run: ChildRun): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of run.stdout.split('\n')) {
    const match = /^path: ([a-z]+) (.+)$/.exec(line);
    if (match !== null) found.set(match[1]!, match[2]!);
  }
  return found;
}

/** The child's own scratch folder, as it printed it, or a refusal naming what the child said instead. */
function childScratch(run: ChildRun): string {
  const folder = printedPaths(run).get('scratch');
  if (folder === undefined) {
    throw new Error(`the child run printed no scratch folder: exit ${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  }
  return folder;
}

describe('a child run of the suite', () => {
  test('a test that redirects nothing writes inside the run scratch, which is gone when the run ends', () => {
    const run = childRun(false);
    if (run.status !== 0) throw new Error(`the child run failed (exit ${run.status}):\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
    const scratch = childScratch(run);
    // The child's temporary folder is this run's, so its scratch stands inside
    // this run's scratch: nothing it writes can reach the machine's own.
    expect(scratch.startsWith(join(tmpdir(), RUN_SCRATCH_PREFIX))).toBe(true);
    const written = printedPaths(run);
    for (const kind of ['home', 'temporary', 'products', 'cache', 'locked']) {
      const path = written.get(kind);
      if (path === undefined) throw new Error(`the child run printed no ${kind} path: ${[...written.keys()].join(', ')}`);
      insideScratch(`the ${kind} path the child wrote`, path, scratch);
    }
    // A run started by a test inherits the home of the run that started it,
    // never the account's own: `homedir()` is fixed when a process starts.
    const inherited = /^note: homedir (.+)$/m.exec(run.stdout)?.[1];
    if (inherited === undefined) throw new Error(`the child run printed no homedir: ${run.stdout}`);
    insideScratch('the home the child inherited', inherited, SCRATCH.folder);
    // The run removed its scratch, permission removals and all.
    expect(existsSync(scratch)).toBe(false);
  }, 60_000);

  test('the scratch is gone when the run fails too', () => {
    const run = childRun(true);
    expect(run.status).not.toBe(0);
    const scratch = childScratch(run);
    expect(run.stderr).toContain('this fixture failed after writing');
    expect(existsSync(scratch)).toBe(false);
  }, 60_000);

  test('an old folder whose own process still runs is kept; an old one with no identity is swept', async () => {
    const real = tmpdir();
    const live = mkdtempSync(join(real, `${RUN_SCRATCH_PREFIX}old-live-`));
    writeFileSync(join(live, 'owner.json'), `${JSON.stringify({ pid: process.pid, startedAt: new Date(0).toISOString() })}\n`);
    const anonymous = mkdtempSync(join(real, `${RUN_SCRATCH_PREFIX}old-anonymous-`));
    // A file naming a pid no run can have is no identity either: 0 and 1 are
    // never a test process, so such a folder falls to the age rule.
    const nonsense = mkdtempSync(join(real, `${RUN_SCRATCH_PREFIX}old-nonsense-`));
    writeFileSync(join(nonsense, 'owner.json'), `${JSON.stringify({ pid: 1, startedAt: new Date(0).toISOString() })}\n`);
    // All three are older than any run may be, and only the one that names its
    // live process must survive: age alone never takes a run in flight.
    const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    for (const folder of [live, anonymous, nonsense]) utimesSync(folder, longAgo, longAgo);
    try {
      const run = childRun(false);
      if (run.status !== 0) throw new Error(`the child run failed (exit ${run.status}):\n${run.stderr}`);
      expect(existsSync(anonymous)).toBe(false);
      expect(existsSync(nonsense)).toBe(false);
      expect(existsSync(live)).toBe(true);
    } finally {
      forceRemove(live);
    }
  }, 60_000);

  test('the sweep removes the folder of a run that is over and keeps a live run\'s', async () => {
    // The folder a child run sees as the system's: this run's own temporary
    // folder, which is where a run started by a test stands its scratch.
    const real = tmpdir();
    const gone = await finishedPid();
    const dead = mkdtempSync(join(real, `${RUN_SCRATCH_PREFIX}dead-`));
    writeFileSync(join(dead, 'owner.json'), `${JSON.stringify({ pid: gone, startedAt: new Date(0).toISOString() })}\n`);
    const live = mkdtempSync(join(real, `${RUN_SCRATCH_PREFIX}live-`));
    writeFileSync(join(live, 'owner.json'), `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    try {
      const run = childRun(false);
      if (run.status !== 0) throw new Error(`the child run failed (exit ${run.status}):\n${run.stderr}`);
      expect(existsSync(dead)).toBe(false);
      expect(existsSync(live)).toBe(true);
    } finally {
      forceRemove(live);
    }
  }, 60_000);
});

/** The pid of a process that has already ended: what a crashed run's owner file names. */
async function finishedPid(): Promise<number> {
  const bun = Bun.which('bun');
  if (bun === null) throw new Error('bun is not on PATH: no ended process can be started to name');
  const ended = Bun.spawn([bun, '-e', ''], { stdout: 'ignore', stderr: 'ignore' });
  await ended.exited;
  return ended.pid;
}

describe('removing a tree a test left unwritable', () => {
  test('every folder is made writable again on the way down, and a link is removed without following it', () => {
    const base = join(SCRATCH.folder, 'force-remove');
    mkdirSync(join(base, 'locked', 'deep', 'deeper'), { recursive: true });
    writeFileSync(join(base, 'locked', 'deep', 'deeper', 'leaf.md'), '# Leaf\n');
    writeFileSync(join(base, 'locked', 'secret.md'), '# Secret\n');
    chmodSync(join(base, 'locked', 'deep', 'deeper'), 0o500);
    chmodSync(join(base, 'locked', 'deep'), 0o000);
    chmodSync(join(base, 'locked', 'secret.md'), 0o000);
    chmodSync(join(base, 'locked'), 0o500);
    forceRemove(join(base, 'locked'));
    expect(existsSync(join(base, 'locked'))).toBe(false);
    // A link the tests may leave behind points at the run's own home: removing
    // it must take the link, never what it names.
    const link = join(base, 'home-link');
    symlinkSync(join(SCRATCH.folder, 'home'), link);
    forceRemove(link);
    expect(existsSync(link)).toBe(false);
    expect(existsSync(join(SCRATCH.folder, 'home'))).toBe(true);
  });

  test('a path already gone is not an error', () => {
    forceRemove(join(SCRATCH.folder, 'never-made'));
  });
});
