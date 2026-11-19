/**
 * The helpers the `madarch` command's tests share: the command as a child
 * process, live children whose facts arrive over time, scratch folders, and the
 * cleanup that stops their daemons.
 *
 * This module is not named `*.test.ts` on purpose: bun registers every case a
 * test file's imports reach, so a helper a second test file imported from a test
 * file would register that file's cases again (architecture rule
 * no-test-file-imports).
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProduct } from '../src/product/manifest.js';
import { stopDaemon } from '../src/product/daemon.js';
import { homeOfCommand, noStrayDrafts, ISOLATED_HOME, sealedHome } from './scratch-home.js';

// The library paths here create drafts in-process as well: MADARCH_HOME at the
// guard's scratch from this module's load, so a mutated home resolution that
// ignores an explicit home lands beside the scratch, never in the account's real
// home (the command tests seal their children besides this).
process.env.MADARCH_HOME = ISOLATED_HOME;

export const CLI = fileURLToPath(new URL('../scripts/madarch.ts', import.meta.url));

/**
 * The machine's real git, resolved once: a stub placed on PATH in a test
 * passes every command it does not itself answer to this file, so the test
 * depends only on git being installed, never on where it is.
 */
export function realGit(): string {
  const path = Bun.which('git');
  if (!path) throw new Error('git is not on PATH; these tests need it');
  return path;
}

/** A port the machine holds free right now, for a daemon the test stops again. */
export async function freePort(): Promise<number> {
  return await new Promise<number>((resolvePort) => { const listener = createServer(); listener.listen(0, '127.0.0.1', () => { const address = listener.address(); const port = typeof address === 'object' && address ? address.port : 0; listener.close(() => resolvePort(port)); }); });
}

/** Startup progress is diagnostic output; every other stderr line remains an error. */
export function withoutStartProgress(stderr: string): string {
  return stderr.split('\n').filter((line) => !line.startsWith('starting (pid ')).join('\n');
}

/** Children a test started live, killed again so none outlives its test. */
export const runningChildren: { kill(): void }[] = [];

/** A word quoted shell-safely: even a path holding a dollar, a backtick or a quote stands as itself. */
export const shQuote = (word: string): string => "'" + word.split("'").join("'\\''") + "'";

/** Git's own identity for the command's child process, so a test never depends on the machine's git config. */
export const SEALED_GIT = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Product CLI',
  GIT_AUTHOR_EMAIL: 'product-cli@example.com',
  GIT_COMMITTER_NAME: 'Product CLI',
  GIT_COMMITTER_EMAIL: 'product-cli@example.com',
};

/**
 * The zone the command's child process is given, so the day it reads is the
 * day this file reads. `bun test` runs this file's own process in UTC when TZ
 * is unset, whatever the machine's zone is (bun 1.4.2: `new Date().toString()`
 * is `GMT+0000` inside `bun test` with TZ unset, and the machine's zone
 * outside it or with an explicit TZ), while a child left on the machine's
 * zone reads the local day. The two disagree whenever the local date differs
 * from UTC's — between 21:00 and 24:00 UTC here — so the draft's name, and
 * every assertion made from `todayName()`, would fail for three hours a day.
 * The product's rule is the local day, and it is left untouched: the child is
 * pinned to UTC only when TZ is unset and this process itself reads UTC,
 * which is that run's own zone; a run started with an explicit TZ keeps the
 * child on it (both sides then read that zone and agree), so the pin never
 * moves the child off the zone the file reads (madarch-rtr.1.8).
 */
const SEALED_CLOCK: Record<string, string> = process.env.TZ === undefined && new Date().getTimezoneOffset() === 0 ? { TZ: 'UTC' } : {};

/** Every temporary folder a test makes, removed after each test and on exit. */
const made: string[] = [];

export function scratchFolder(prefix = 'madarch-cli-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** The daemons a command a test started runs in the background: `init` returns with one serving, and it is stopped here, pass or fail. */
export const startedHomes: string[] = [];

export const cleanTestScratch = (): void => {
  for (const home of startedHomes.splice(0)) try { stopDaemon({ home }); } catch { /* no daemon of this home */ }
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const proc of runningChildren.splice(0)) try { proc.kill(); } catch { /* already gone */ }
  const strays = noStrayDrafts();
  if (strays.newEntries.length) throw new Error(`the real products home gained entries while the tests ran (named, left in place): ${strays.newEntries.join(', ')}`);
};

// Each test file registers cleanTestScratch as its afterEach: bun caches one module
// graph across a run's files, so a hook registered here would belong to one file only.
process.on('exit', cleanTestScratch);


/**
 * Runs a command that ends by itself, the way a person does. `cwd` is the
 * folder the command runs in: the lifecycle commands resolve the product
 * from it (the program's where), so a test names the folder a person
 * stands in.
 */
export function runCommand(args: string[], overrides: Record<string, string> = {}, cwd?: string): { status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env, ...SEALED_GIT, ...SEALED_CLOCK, ...sealedHome(overrides), ...overrides };
  // A creator must aim at a scratch home before anything is spawned: the
  // arguments, then MADARCH_HOME — the resolved home is refused otherwise.
  if (args[0] === 'init' || args[0] === 'list') homeOfCommand(args, env);
  if (args[0] === 'clone') homeOfCommand(args, env);
  const run = spawnSync('bun', [CLI, ...args], { encoding: 'utf8', env, timeout: 120_000, cwd: cwd ?? (args[0] === 'init' ? scratchFolder('madarch-cli-work-') : undefined) });
  return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
}

/**
 * One live child whose stdout is read as it arrives: the command serves
 * until it is stopped, so a run that creates a draft is started, seen
 * through its own fact lines, and stopped the way a reader stops a
 * server — killed, then waited for (the exit is the signal's code).
 */
export interface LiveNew {
  readonly stdout: string;
  readonly exitCode: number | null;
  /** Whether the command ended by itself within the bound, without the test stopping it. */
  exited(timeoutMs: number): Promise<boolean>;
  finish(): Promise<{ stdout: string; exitCode: number | null }>;
}
export function serveNew(args: string[], overrides: Record<string, string> = {}, program: readonly string[] = ['bun', CLI], cwd?: string): LiveNew {
  const env = { ...process.env, ...SEALED_GIT, ...SEALED_CLOCK, ...sealedHome(overrides), ...overrides };
  if (args[0] === 'init') {
    homeOfCommand(args, env);
    // `init` starts a daemon in the background and returns: the test's cleanup stops it.
    const home = homeOfCommand(args, env);
    if (home !== '') startedHomes.push(home);
  }
  const proc = Bun.spawn([...program, ...args], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env,
    cwd: cwd ?? (args[0] === 'init' ? scratchFolder('madarch-cli-work-') : process.cwd()),
  },);
  runningChildren.push(proc);
  let stdoutText = '';
  const whenStdout = (async () => {
    const reader = (proc.stdout as ReadableStream).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stdoutText += new TextDecoder().decode(value);
    }
    return stdoutText;
  })();
  let stderrText = '';
  (async () => {
    const reader = (proc.stderr as ReadableStream).getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; stderrText += new TextDecoder().decode(value); }
    if (withoutStartProgress(stderrText) !== '') throw new Error(`the command printed error output: ${stderrText}`);
  })();
  return {
    get stdout() { return stdoutText; },
    get exitCode() { return proc.exitCode; },
    exited: async (timeoutMs: number) => await Promise.race([proc.exited.then(() => true, () => true), Bun.sleep(timeoutMs).then(() => false)]),
    finish: async () => {
      proc.kill();
      const [, stdout] = await Promise.all([proc.exited, whenStdout]);
      return { stdout, exitCode: proc.exitCode };
    },
  };
}

/** An app folder with its dist already there: the serving builds nothing. */
export function builtApp(base: string): string {
  const app = join(base, 'wiki-app');
  mkdirSync(join(app, 'dist', 'assets'), { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', private: true, scripts: { build: 'true' } }, null, 2));
  writeFileSync(join(app, 'dist', 'index.html'), '<!doctype html><title>built</title>');
  writeFileSync(join(app, 'dist', 'assets', 'app.js'), 'export const x = 1;');
  return app;
}

/** The draft's two printed facts, once both lines have arrived. */
export async function printedLiveFacts(serve: LiveNew): Promise<{ folder: string; id: string }> {
  const start = Date.now();
  for (;;) {
    const lines = serve.stdout.split('\n').filter((line) => line !== '');
    const created = lines.find((line) => line.startsWith('✓ Created the product '));
    const folder = created?.match(/ in (.+)$/)?.[1];
    if (folder !== undefined && lines.some((line) => line.startsWith('The wiki is running at ') || line.startsWith('The wiki is already running at ') || line.startsWith('Wiki: '))) {
      const product = readProduct(folder);
      if (product.ok) return { folder, id: product.product.id };
    }
    if (serve.exitCode !== null || Date.now() - start > 15_000) {
      throw new Error(`the command stopped before it served; stdout was: ${serve.stdout}`);
    }
    await Bun.sleep(50);
  }
}
