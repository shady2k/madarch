/**
 * The `madarch` command's `new` subcommand (docs/changes/draft-product/
 * capabilities/product-repository.md, requirement draft): the library
 * `createDraft` does the work; the command parses, prints and decides the
 * exit code. Every test runs the command as a child process, the way a
 * person runs it, with the products home at a scratch folder; no test
 * writes into a real home. A run that creates a draft keeps serving its
 * wiki until the test stops it, through the same app seam the serve tests
 * use (MADARCH_APP at a ready dist), so no test runs bun's real build.
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, cpSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'bun:test';
import { readProduct } from '../src/product/manifest.js';
import { addCodeRepository, bootstrapProduct, createDirectoryLink } from '../src/product/lifecycle.js';
import { main, repoModeFromAnswer, COMMANDS } from '../src/product/cli.js';
import { createDraft } from '../src/product/draft.js';
import { listProducts } from '../src/product/list.js';
import { stopDaemon } from '../src/product/daemon.js';
import { gitEnv } from './git-env.js';
import { GIT_IDENTITY, GIT_ENV } from './model-check-repo.js';
import { homeOfCommand, noStrayDrafts, ISOLATED_HOME, sealedHome } from './scratch-home.js';

// The library paths here create drafts in-process as well: MADARCH_HOME at
// the guard's scratch from this module's load, so a mutated home resolution
// that ignores an explicit home lands beside the scratch, never in the
// account's real home (the command tests seal their children besides this).
process.env.MADARCH_HOME = ISOLATED_HOME;

export const CLI = fileURLToPath(new URL('../scripts/madarch.ts', import.meta.url));

/**
 * The machine's real git, resolved once: a stub placed on PATH in a test
 * passes every command it does not itself answer to this file, so the test
 * depends only on git being installed, never on where it is.
 */
function realGit(): string {
  const path = Bun.which('git');
  if (!path) throw new Error('git is not on PATH; these tests need it');
  return path;
}

/** A port the machine holds free right now, for a daemon the test stops again. */
export async function freePort(): Promise<number> {
  return await new Promise<number>((resolvePort) => { const listener = createServer(); listener.listen(0, '127.0.0.1', () => { const address = listener.address(); const port = typeof address === 'object' && address ? address.port : 0; listener.close(() => resolvePort(port)); }); });
}

/** Children a test started live, killed again so none outlives its test. */
const runningChildren: { kill(): void }[] = [];

/** A word quoted shell-safely: even a path holding a dollar, a backtick or a quote stands as itself. */
const shQuote = (word: string): string => "'" + word.split("'").join("'\\''") + "'";

/** Git's own identity for the command's child process, so a test never depends on the machine's git config. */
const SEALED_GIT = {
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

/** Every temporary folder this file makes, removed after each test and on exit. */
const made: string[] = [];

export function scratchFolder(prefix = 'madarch-cli-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

const removeMadeFolders = (): void => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const proc of runningChildren.splice(0)) try { proc.kill(); } catch { /* already gone */ }
  const strays = noStrayDrafts();
  if (strays.newEntries.length) throw new Error(`the real products home gained entries while the tests ran (named, left in place): ${strays.newEntries.join(', ')}`);
};

afterEach(removeMadeFolders);
process.on('exit', removeMadeFolders);


/**
 * Runs a command that ends by itself, the way a person does. `cwd` is the
 * folder the command runs in: the lifecycle commands resolve the product
 * from it (the program's where), so a test names the folder a person
 * stands in.
 */
function runCommand(args: string[], overrides: Record<string, string> = {}, cwd?: string): { status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env, ...SEALED_GIT, ...SEALED_CLOCK, ...sealedHome(overrides), ...overrides };
  // A creator must aim at a scratch home before anything is spawned: the
  // arguments, then MADARCH_HOME — the resolved home is refused otherwise.
  if (args[0] === 'new' || args[0] === 'init' || args[0] === 'list') homeOfCommand(args, env);
  if (args[0] === 'clone') homeOfCommand(args, env);
  const run = spawnSync('bun', [CLI, ...args], { encoding: 'utf8', env, timeout: 120_000, cwd });
  return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
}

/**
 * One live child whose stdout is read as it arrives: the command serves
 * until it is stopped, so a run that creates a draft is started, seen
 * through its own fact lines, and stopped the way a reader stops a
 * server — killed, then waited for (the exit is the signal's code).
 */
interface LiveNew {
  readonly stdout: string;
  readonly exitCode: number | null;
  finish(): Promise<{ stdout: string; exitCode: number | null }>;
}
export function serveNew(args: string[], overrides: Record<string, string> = {}, program: readonly string[] = ['bun', CLI], cwd?: string): LiveNew {
  const env = { ...process.env, ...SEALED_GIT, ...SEALED_CLOCK, ...sealedHome(overrides), ...overrides };
  if (args[0] === 'new' || args[0] === 'init') homeOfCommand(args, env);
  const proc = Bun.spawn([...program, ...args], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env,
    ...(cwd === undefined ? {} : { cwd }),
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
    if (stderrText !== '') throw new Error(`the command printed error output: ${stderrText}`);
  })();
  return {
    get stdout() { return stdoutText; },
    get exitCode() { return proc.exitCode; },
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

/**
 * Today's date, the way the draft's name is folded from it: the day this
 * file's own process reads (UTC when `bun test` runs it with TZ unset), and
 * the day the command's child reads, which `SEALED_CLOCK` holds to the same
 * zone.
 */
function todayName(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

describe('madarch new', () => {
  test('creates the draft under MADARCH_HOME, prints its folder and its id, and returns at once with the wiki served in the background', async () => {
    const base = scratchFolder('madarch-cli-app-');
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    const port = await freePort();
    const serve = serveNew(['new', '--port', String(port), '--no-open'], { MADARCH_HOME: home, MADARCH_APP: builtApp(base) });
    const { folder, id } = await printedLiveFacts(serve);
    expect(folder).toBe(join(home, 'products', `idea-${todayName()}`));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(statSync(folder).isDirectory()).toBe(true);
    expect(statSync(join(folder, '.git')).isDirectory()).toBe(true);
    // The id the manifest holds is the one the command printed.
    const read = readProduct(folder);
    expect(read).toMatchObject({ ok: true, product: { id, name: `idea-${todayName()}`, schemaVersion: 1 } });
    // The command returns at once; the wiki is the background server's.
    const { stdout, exitCode } = await serve.finish();
    expect(exitCode).toBe(0);
    const url = stdout.match(/The wiki is running at (http:\/\/\S+)/)?.[1];
    expect(url).toBe(`http://127.0.0.1:${port}/products/idea-${todayName()}/`);
    expect((await fetch(url!)).ok).toBeTrue();
    expect(stopDaemon({ home: join(home, 'products') })).toBe(0);
  });

  test("--home moves this one command's products home, over MADARCH_HOME", async () => {
    const madarchHome = scratchFolder();
    const home = scratchFolder('madarch-cli-elsewhere-');
    const port = await freePort();
    const serve = serveNew(['new', '--home', home, '--port', String(port), '--no-open'],
      { MADARCH_HOME: madarchHome, MADARCH_APP: builtApp(home) });
    const { folder } = await printedLiveFacts(serve);
    expect(folder).toBe(join(home, `idea-${todayName()}`));
    expect(statSync(folder).isDirectory()).toBe(true);
    await serve.finish();
    // And MADARCH_HOME holds nothing: nothing was written there.
    expect(readdirSync(madarchHome)).toEqual([]);
    expect(stopDaemon({ home })).toBe(0);
  });

  test('--home=FOLDER names the home in one word, the way the other commands parse it', async () => {
    const base = scratchFolder('madarch-cli-app-');
    const home = scratchFolder();
    const port = await freePort();
    const serve = serveNew(['new', `--home=${home}`, '--port', String(port), '--no-open'], { MADARCH_APP: builtApp(base) });
    const { folder } = await printedLiveFacts(serve);
    expect(folder).toBe(join(home, `idea-${todayName()}`));
    await serve.finish();
    expect(stopDaemon({ home })).toBe(0);
  });

  test('a second new the same day makes -2, with its own id, and reuses the running server', async () => {
    const base = scratchFolder('madarch-cli-app-');
    const home = scratchFolder();
    const app = builtApp(base);
    const port = await freePort();
    const first = serveNew(['new', '--port', String(port), '--no-open'], { MADARCH_HOME: home, MADARCH_APP: app });
    const firstFacts = await printedLiveFacts(first);
    const second = serveNew(['new', '--port', String(port), '--no-open'], { MADARCH_HOME: home, MADARCH_APP: app });
    const secondFacts = await printedLiveFacts(second);
    expect(secondFacts.folder).toBe(`${firstFacts.folder}-2`);
    expect(secondFacts.id).not.toBe(firstFacts.id);
    await first.finish();
    const { stdout } = await second.finish();
    expect(stdout).toContain('The wiki is already running at');
    expect(stopDaemon({ home: join(home, 'products') })).toBe(0);
  });

  test('--help prints the short command list and exits 0', () => {
    const { status, stdout, stderr } = runCommand(['--help']);
    expect(status).toBe(0); expect(stderr).toBe('');
    expect(stdout).toContain('Start:'); expect(stdout).toContain('Work with a product:'); expect(stdout).toContain('Server:'); expect(stdout).toContain('Other:');
    expect(stdout).toContain('madarch <command> --help'); expect(stdout).not.toContain('--home'); expect(stdout).not.toContain('bun link');
  });

  test('every command has focused help with usage, flags and example', () => {
    for (const command of Object.keys(COMMANDS)) {
      const result = runCommand([command, '--help']);
      expect(result.status).toBe(0); expect(result.stdout).toContain(`madarch ${command}`); expect(result.stdout).toContain('Example:');
    }
  });

  test("--port 0 serves on a free port, and --json keeps the daemon's facts on one line", async () => {
    const base = scratchFolder('madarch-cli-json-');
    const home = scratchFolder();
    try {
      const run = runCommand(['new', '--port', '0', '--json', '--no-open'], { MADARCH_HOME: home, MADARCH_APP: builtApp(base) });
      expect(run.status).toBe(0);
      expect(run.stderr).toBe('');
      // One JSON line, no human summary beside it.
      const facts = JSON.parse(run.stdout) as { folder: string; id: string; name: string; url: string; pid: number; port: number; reused: boolean; requestedPort?: number; portNote?: string };
      expect(facts.folder).toBe(join(home, 'products', `idea-${todayName()}`));
      expect(typeof facts.id).toBe('string'); expect(facts.id !== '').toBe(true);
      expect(typeof facts.name).toBe('string');
      // --port 0 names a free port: the recorded and printed port is the
      // real one, never 0, and the wiki answers on the printed address.
      expect(facts.port).toBeGreaterThan(0);
      expect(facts.reused).toBe(false);
      // The 0 the caller named is in the facts as what it asked for — a free
      // port of the server's own choosing — and no note stands beside it,
      // since no particular port was named that the server could not keep.
      expect(facts.requestedPort).toBe(0);
      expect('portNote' in facts).toBe(false);
      expect(facts.url).toBe(`http://127.0.0.1:${facts.port}/products/idea-${todayName()}/`);
      expect(facts.pid).toBeGreaterThan(0);
      const answer = await fetch(`${facts.url}api/product`);
      expect((await answer.json() as { id: string }).id).toBe(facts.id);
    } finally { stopDaemon({ home: join(home, 'products') }); }
  });

  test('a new on the running server with another --port gets the server\'s address and is told plainly that its port does not apply', async () => {
    const base = scratchFolder('madarch-cli-app-');
    const home = scratchFolder();
    const app = builtApp(base);
    const firstPort = await freePort();
    let otherPort = await freePort();
    while (otherPort === firstPort) otherPort = await freePort();
    const products = join(home, 'products');
    const first = serveNew(['new', '--port', String(firstPort), '--no-open'], { MADARCH_HOME: home, MADARCH_APP: app });
    await printedLiveFacts(first);
    await first.finish();
    try {
      // The home has one server, and its port is the server's: a second new
      // is served at once at the running address, and its own --port is
      // reported as not applying — with both ports named in words and the
      // two commands that move the server.
      const second = runCommand(['new', '--port', String(otherPort), '--no-open'], { MADARCH_HOME: home, MADARCH_APP: app });
      expect(second.status).toBe(0);
      expect(second.stderr).toBe('');
      expect(second.stdout).toContain(`The wiki is already running at http://127.0.0.1:${firstPort}/products/idea-${todayName()}-2/`);
      expect(second.stdout).toContain(`the running server keeps port ${firstPort}`);
      expect(second.stdout).toContain(`--port ${otherPort} does not apply`);
      expect(second.stdout).toContain(`madarch stop --home ${products}`);
      expect(second.stdout).toContain(`madarch start --home ${products} --port ${otherPort}`);
      expect(second.stdout).not.toContain('was ignored');
      const served = await fetch(`http://127.0.0.1:${firstPort}/products/idea-${todayName()}-2/api/product`);
      expect(served.ok).toBeTrue();
    } finally { expect(stopDaemon({ home: products })).toBe(0); }
  });

  test('a new on the running server that names no port, or the server\'s own, says nothing about ports', async () => {
    const base = scratchFolder('madarch-cli-app-');
    const home = scratchFolder();
    const app = builtApp(base);
    const port = await freePort();
    const products = join(home, 'products');
    const first = serveNew(['new', '--port', String(port), '--no-open'], { MADARCH_HOME: home, MADARCH_APP: app });
    await printedLiveFacts(first);
    await first.finish();
    try {
      const same = runCommand(['new', '--port', String(port), '--no-open'], { MADARCH_HOME: home, MADARCH_APP: app });
      expect(same.status).toBe(0);
      expect(same.stdout).toContain(`The wiki is already running at http://127.0.0.1:${port}/products/idea-${todayName()}-2/`);
      expect(same.stdout).not.toContain('does not apply');
      const none = runCommand(['new', '--no-open'], { MADARCH_HOME: home, MADARCH_APP: app });
      expect(none.status).toBe(0);
      expect(none.stdout).not.toContain('does not apply');
    } finally { expect(stopDaemon({ home: products })).toBe(0); }
  });

  test('--json carries the port the server keeps and the note that the asked port does not apply', async () => {
    const base = scratchFolder('madarch-cli-json-');
    const home = scratchFolder();
    const app = builtApp(base);
    const firstPort = await freePort();
    let otherPort = await freePort();
    while (otherPort === firstPort) otherPort = await freePort();
    const products = join(home, 'products');
    try {
      const first = runCommand(['new', '--port', String(firstPort), '--json', '--no-open'], { MADARCH_HOME: home, MADARCH_APP: app });
      expect(first.status).toBe(0);
      const firstFacts = JSON.parse(first.stdout) as { port: number; reused: boolean; requestedPort?: number; portNote?: string };
      expect(firstFacts.port).toBe(firstPort);
      expect(firstFacts.reused).toBe(false);
      expect(firstFacts.requestedPort).toBe(firstPort);
      // The server keeps its port: the machine consumer is told the same
      // thing the human lines say, never a silently smaller answer.
      const second = runCommand(['new', '--port', String(otherPort), '--json', '--no-open'], { MADARCH_HOME: home, MADARCH_APP: app });
      expect(second.status).toBe(0);
      const facts = JSON.parse(second.stdout) as { port: number; reused: boolean; requestedPort?: number; portNote?: string; url: string };
      expect(facts.reused).toBe(true);
      expect(facts.port).toBe(firstPort);
      expect(facts.requestedPort).toBe(otherPort);
      expect(facts.portNote).toContain(`the running server keeps port ${firstPort}`);
      expect(facts.portNote).toContain(`--port ${otherPort} does not apply`);
      expect(facts.url).toBe(`http://127.0.0.1:${firstPort}/products/idea-${todayName()}-2/`);
      // A run that names no port asked for none: no note, and no requestedPort.
      const third = runCommand(['new', '--json', '--no-open'], { MADARCH_HOME: home, MADARCH_APP: app });
      expect(third.status).toBe(0);
      const thirdFacts = JSON.parse(third.stdout) as Record<string, unknown>;
      expect('requestedPort' in thirdFacts).toBe(false);
      expect('portNote' in thirdFacts).toBe(false);
    } finally { expect(stopDaemon({ home: products })).toBe(0); }
  });

  test('start with another --port reports the running server and how to move it, and starts no second one', async () => {
    const base = scratchFolder('madarch-cli-app-');
    const home = scratchFolder();
    const app = builtApp(base);
    const port = await freePort();
    let otherPort = await freePort();
    while (otherPort === port) otherPort = await freePort();
    const products = join(home, 'products');
    try {
      expect(runCommand(['start', '--port', String(port)], { MADARCH_HOME: home, MADARCH_APP: app }).status).toBe(0);
      const again = runCommand(['start', '--port', String(otherPort)], { MADARCH_HOME: home, MADARCH_APP: app });
      expect(again.status).toBe(0);
      expect(again.stdout).toContain(`already running: http://127.0.0.1:${port} (pid `);
      expect(again.stdout).toContain(`the running server keeps port ${port}, so --port ${otherPort} does not apply`);
    } finally { expect(stopDaemon({ home: products })).toBe(0); }
  });

  test("new's own help names the home's server as the port's owner, and says a port it cannot keep is reported", () => {
    const help = runCommand(['new', '--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--port <n>');
    expect(help.stdout).toContain("the products home's server names the port it starts on; one it does not keep is reported, not ignored");
    expect(runCommand(['start', '--help']).stdout).toContain('one it does not keep is reported, not ignored');
    // serve is the single-product foreground command: its port is its own.
    expect(runCommand(['serve', '--help']).stdout).not.toContain('not ignored');
  });

  test('the focused help names only what the parser accepts, start for example', () => {
    const startHelp = runCommand(['start', '--help'], {});
    expect(startHelp.status).toBe(0);
    expect(startHelp.stdout).toContain('--home'); expect(startHelp.stdout).toContain('--port');
    expect(startHelp.stdout).not.toContain('--no-open'); expect(startHelp.stdout).not.toContain('--host');
    const home = scratchFolder();
    const refuse = runCommand(['start', '--no-open'], { MADARCH_HOME: home });
    expect(refuse.status).toBe(2);
    expect(refuse.stderr).toContain('--no-open'); expect(refuse.stderr).toContain('unknown option');
    const serveHelp = runCommand(['serve', '--help'], {});
    expect(serveHelp.stdout).toContain('--no-open'); expect(serveHelp.stdout).toContain('--host');
    const demoHelp = runCommand(['demo', '--help'], {});
    expect(demoHelp.stdout).toContain('--no-open');
  });

  test("a per-command --host is refused on the shared daemon's loopback path", () => {
    const home = scratchFolder();
    const newRun = runCommand(['new', '--host', '10.0.0.5'], { MADARCH_HOME: home });
    expect(newRun.status).toBe(2);
    expect(newRun.stderr).toContain('--host');
    expect(newRun.stderr).toContain('unknown option');
    const startRun = runCommand(['start', '--host', '10.0.0.5'], { MADARCH_HOME: home });
    expect(startRun.status).toBe(2);
    expect(startRun.stderr).toContain('--host');
    expect(startRun.stderr).toContain('unknown option');
    // The foreground serve keeps its own bind address, as it always has.
    expect(runCommand(['serve', '--help'], {}).stdout).toContain('--host');
  });

  test('a missing option value exits 2 naming the flag', () => {
    const { status, stdout, stderr } = runCommand(['new', '--home'], { MADARCH_HOME: scratchFolder() });
    expect(stdout).toBe('');
    expect(status).toBe(2);
    expect(stderr).toContain('--home');
    expect(stderr).toContain('needs a value');
  });

  test('an unknown option exits 2 naming it and what is accepted', () => {
    const { status, stdout, stderr } = runCommand(['new', '--nope'], { MADARCH_HOME: scratchFolder() });
    expect(status).toBe(2);
    expect(stderr).toContain('--nope');
    expect(stderr).toContain('--home');
    expect(stderr).toContain('unknown option');
  });

  test('an option before the subcommand is refused as an unknown option, naming what is accepted', () => {
    const { status, stderr } = runCommand(['--nope'], {});
    expect(status).toBe(2);
    expect(stderr).toContain('--nope');
    expect(stderr).toContain('unknown option');
    expect(stderr).toContain('new');
  });

  test('an unknown subcommand exits 2 naming it and the subcommands', () => {
    const { status, stderr } = runCommand(['star'], {});
    expect(status).toBe(2);
    expect(stderr).toContain('star');
    expect(stderr).toContain('new');
  });

  test('no arguments at all gives location-aware help and exits 0', () => {
    const elsewhere = scratchFolder('madarch-help-elsewhere-');
    const { status, stdout, stderr } = runCommand([], {}, elsewhere);
    expect(status).toBe(0); expect(stderr).toBe(''); expect(stdout).toContain('Start a new product: madarch new');
    expect(stdout).toContain('Products live in'); expect(stdout).toContain('Start:');
  });

  test('no-argument help describes a product folder and a temporary Git checkout', () => {
    const base = scratchFolder('madarch-context-');
    const home = join(base, 'home');
    const draft = madeDraft(home);
    const productHelp = runCommand([], {}, draft.folder);
    expect(productHelp.status).toBe(0); expect(productHelp.stdout).toContain(`This is the product ${draft.name}.`);
    expect(productHelp.stdout).toContain('Open its wiki: madarch serve');
    expect(productHelp.stdout).toContain('Markdown files'); expect(productHelp.stdout).toContain('any agent');

    const checkout = join(base, 'checkout'); mkdirSync(checkout);
    const init = spawnSync(realGit(), ['init', '--initial-branch=main'], { cwd: checkout, encoding: 'utf8', env: gitEnv(GIT_ENV) });
    if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
    const gitHelp = runCommand([], {}, checkout);
    expect(gitHelp.status).toBe(0); expect(gitHelp.stdout).toContain('This folder is a git repository. To start a product around it: madarch init');
  });

  test('a stray argument to new exits 2 naming it', () => {
    const { status, stderr } = runCommand(['new', 'somewhere'], { MADARCH_HOME: scratchFolder() });
    expect(status).toBe(2);
    expect(stderr).toContain('somewhere');
    expect(stderr).toContain('unexpected argument');
  });

  test('an option another subcommand owns is refused, never silently ignored', () => {
    // `new` takes no --product and serve takes no --home: a silently accepted
    // option would tell a person their words were used when nothing was.
    const home = scratchFolder();
    const run = runCommand(['new', '--product', home], { MADARCH_HOME: home });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('--product');
    expect(run.stderr).toContain('unknown option');
    expect(readdirSync(home).filter((name) => name.startsWith('idea-'))).toEqual([]);

    const serveRun = runCommand(['serve', '--home', home], { MADARCH_HOME: home });
    expect(serveRun.status).toBe(2);
    expect(serveRun.stderr).toContain('--home');
    expect(serveRun.stderr).toContain('unknown option');
  });

  test('a products home that is a file exits 2 naming the path, and no product folder is created anywhere', () => {
    const base = scratchFolder('madarch-cli-file-');
    const home = join(base, 'home');
    writeFileSync(home, 'not a folder\n');
    const { status, stdout, stderr } = runCommand(['new'], { MADARCH_HOME: home });
    expect(stdout).toBe('');
    expect(status).toBe(2);
    // The products home is `products` under the madarch home; the refusal names the path it could not use.
    expect(stderr).toContain(join(home, 'products'));
    expect(stderr).toContain('cannot be');
    expect(readdirSync(base)).toEqual(['home']);
  });

  test('a git that refuses to commit exits 1 with git\'s own words and leaves no folder behind', () => {
    const stubs = scratchFolder('madarch-cli-gitstub-');
    const script = ['#!/bin/sh', 'if [ "$1" = "commit" ]; then', "  echo 'stub: refusing to commit' >&2; exit 1; fi", `exec ${shQuote(realGit())} "$@"`, ''].join('\n');
    writeFileSync(join(stubs, 'git'), script);
    chmodSync(join(stubs, 'git'), 0o700);
    const home = scratchFolder();
    const { status, stdout, stderr } = runCommand(['new'], { MADARCH_HOME: home, PATH: `${stubs}:${process.env.PATH ?? ''}` });
    expect(stdout).toBe('');
    expect(status).toBe(1);
    expect(stderr).toContain('refusing to commit');
    expect(readdirSync(home).filter((name) => name.startsWith('idea-'))).toEqual([]);
  });
});

describe('madarch init', () => {
  test('links the current checkout, keeps it in place and serves the committed product wiki', async () => {
    const base = scratchFolder('madarch-init-');
    const home = join(base, 'home');
    const checkout = join(base, 'sample-app');
    mkdirSync(checkout);
    const origin = sourceRepo(base, 'sample-origin.git');
    const git = (args: string[]): void => {
      const run = spawnSync(realGit(), args, { cwd: checkout, encoding: 'utf8', env: gitEnv(GIT_ENV) });
      if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`);
    };
    git(['init', '--initial-branch=main']);
    writeFileSync(join(checkout, 'README.md'), '# Sample application\n');
    git(['add', 'README.md']); git(['commit', '--quiet', '-m', 'Initial']); git(['remote', 'add', 'origin', origin]);
    const port = await freePort();
    const serve = serveNew(['init', '--port', String(port), '--no-open'], { MADARCH_HOME: home, MADARCH_APP: builtApp(base) }, ['bun', CLI], checkout);
    const { folder } = await printedLiveFacts(serve);
    expect(folder).toBe(join(home, 'products', 'sample-app'));
    const outputLines = serve.stdout.split('\n').filter((line) => line !== '');
    expect(serve.stdout).toContain('✓ Created the product'); expect(serve.stdout).toContain('✓ Connected your repository');
    expect(serve.stdout).toContain(`The wiki is running at http://127.0.0.1:${port}/products/sample-app/`);
    expect(statSync(checkout).isDirectory()).toBe(true);
    expect(realpathSync(join(folder, 'repos', 'sample-app'))).toBe(realpathSync(checkout));
    expect(readProduct(folder)).toMatchObject({ ok: true, product: { repos: [{ name: 'sample-app', url: origin }] } });
    expect(bootstrapProduct({ folder, gitEnv: gitEnv(GIT_ENV) })).toMatchObject({ outcome: 'bootstrapped', repos: [{ state: 'present' }] });
    expect(spawnSync(realGit(), ['status', '--porcelain'], { cwd: checkout, encoding: 'utf8' }).stdout).toBe('');
    const { exitCode } = await serve.finish();
    expect(exitCode).toBe(0);
    expect(stopDaemon({ home: join(home, 'products') })).toBe(0);
  });

  test('links without an origin, refuses product-name collision, and is idempotent after linking', async () => {
    const base = scratchFolder('madarch-init-no-origin-');
    const home = join(base, 'home'); const checkout = join(base, 'local-app'); mkdirSync(checkout);
    const git = (args: string[]): void => { const result = spawnSync(realGit(), args, { cwd: checkout, encoding: 'utf8', env: gitEnv(GIT_ENV) }); if (result.status !== 0) throw new Error(result.stderr); };
    git(['init', '--initial-branch=main']); writeFileSync(join(checkout, 'README.md'), '# Local\n'); git(['add', 'README.md']); git(['commit', '--quiet', '-m', 'Initial']);
    const port = await freePort();
    const serve = serveNew(['init', '--port', String(port), '--no-open'], { MADARCH_HOME: home, MADARCH_APP: builtApp(base) }, ['bun', CLI], checkout);
    const { folder } = await printedLiveFacts(serve);
    expect(readProduct(folder)).toMatchObject({ ok: true, product: { repos: [{ name: 'local-app', linked: true }] } });
    expect((readProduct(folder) as {ok:true;product:{repos:{url?:string}[]}}).product.repos[0]?.url).toBeUndefined();
    await serve.finish();
    const second = serveNew(['init', '--home', join(home, 'products'), '--port', String(port), '--no-open'], { MADARCH_APP: builtApp(base) }, ['bun', CLI], checkout);
    const secondFacts = await printedLiveFacts(second);
    expect(secondFacts.folder).toBe(folder); expect(second.stdout).toContain('✓ Created the product'); expect(existsSync(join(home, 'products', 'local-app'))).toBe(true);
    expect((await second.finish()).stdout).toContain('The wiki is already running at');
    expect(folder).toContain('local-app');
    expect(stopDaemon({ home: join(home, 'products') })).toBe(0);
  }, 15000);

  test('refuses outside Git with madarch new guidance and leaves the products home alone', () => {
    const base = scratchFolder('madarch-init-outside-');
    const work = join(base, 'plain'); mkdirSync(work);
    const run = runCommand(['init', '--home', join(base, 'products'), '--no-open'], {}, work);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('madarch new');
    expect(existsSync(join(base, 'products'))).toBe(false);
  });

  test('refuses a product-folder name collision and does not create a second product', () => {
    const base = scratchFolder('madarch-init-collision-'); const home = join(base, 'home'); const checkout = join(base, 'clash'); mkdirSync(checkout);
    const git = (args: string[], cwd = checkout): void => { const result = spawnSync(realGit(), args, { cwd, encoding: 'utf8', env: gitEnv(GIT_ENV) }); if (result.status !== 0) throw new Error(result.stderr); };
    git(['init', '--initial-branch=main']); writeFileSync(join(checkout, 'README.md'), '# Clash'); git(['add', 'README.md']); git(['commit', '--quiet', '-m', 'Initial']);
    const target = join(home, 'clash'); mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'keep.txt'), 'keep'); git(['init', '--initial-branch=main'], target);
    const run = runCommand(['init', '--home', home, '--no-open'], {}, checkout);
    expect(run.status).toBe(2); expect(run.stderr).toContain(target); expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('keep');
  }, 12000);

  test('reports --version and -v as madarch version', () => {
    for (const flag of ['--version', '-v']) {
      const run = runCommand([flag], {});
      expect(run.status).toBe(0); expect(run.stdout).toBe('version: dev\n'); expect(run.stderr).toBe('');
    }
  });
});

describe('madarch new: --home values a person cannot mean', () => {
  test("`--home --no-open` refuses: another option is not the home, and no draft is created", () => {
    const home = scratchFolder();
    const { status, stdout, stderr } = runCommand(['new', '--home', '--no-open'], { MADARCH_HOME: home });
    expect(stdout).toBe('');
    expect(status).toBe(2);
    expect(stderr).toContain('--home');
    expect(stderr).toContain('--no-open');
    expect(readdirSync(home)).toEqual([]);
  });

  test('`--home=` refuses: an empty value is no home, and no draft is created', () => {
    const home = scratchFolder();
    const { status, stdout, stderr } = runCommand(['new', '--home='], { MADARCH_HOME: home });
    expect(stdout).toBe('');
    expect(status).toBe(2);
    expect(stderr).toContain('--home');
    expect(readdirSync(home)).toEqual([]);
  });

  test("`--home` of only spaces is refused, not silently using a fallback home, and nothing is created", () => {
    const home = scratchFolder();
    const { status, stdout, stderr } = runCommand(['new', '--home', '   '], { MADARCH_HOME: home });
    expect(stdout).toBe('');
    expect(status).toBe(2);
    expect(stderr).toContain('--home');
    // No fallback draft anywhere: neither under the madarch home's products nor beside it.
    expect(readdirSync(home)).toEqual([]);
  });

  test("`--home ' --no-open '` is refused once the value is trimmed: the spaces must not hide another option", () => {
    const home = scratchFolder();
    const { status, stdout, stderr } = runCommand(['new', '--home', ' --no-open '], { MADARCH_HOME: home });
    expect(stdout).toBe('');
    expect(status).toBe(2);
    expect(stderr).toContain('--home');
    expect(stderr).toContain('--no-open');
    expect(readdirSync(home)).toEqual([]);
  });

  test("`--home` whose trimmed value is another option, by the = form, is refused the same way", () => {
    const home = scratchFolder();
    const { status, stderr } = runCommand(['new', '--home= --no-open '], { MADARCH_HOME: home });
    expect(status).toBe(2);
    expect(stderr).toContain('--no-open');
    expect(readdirSync(home)).toEqual([]);
  });

  test("`--home` with spaces around a real folder still creates the draft in that folder", async () => {
    const base = scratchFolder('madarch-cli-app-');
    const home = scratchFolder();
    const port = await freePort();
    const serve = serveNew(['new', '--home', ` ${home} `, '--port', String(port), '--no-open'],
      { MADARCH_HOME: scratchFolder(), MADARCH_APP: builtApp(base) });
    const { folder } = await printedLiveFacts(serve);
    expect(folder).toBe(join(home, `idea-${todayName()}`));
    await serve.finish();
    expect(stopDaemon({ home })).toBe(0);
  });
  test('`--home=--no-open` refuses the same way', () => {
    const home = scratchFolder();
    const { status, stderr } = runCommand(['new', '--home=--no-open'], { MADARCH_HOME: home });
    expect(status).toBe(2);
    expect(stderr).toContain('--home');
    expect(stderr).toContain('--no-open');
    expect(readdirSync(home)).toEqual([]);
  });
});

describe('madarch list', () => {
  /** The contract's set-made example product folder (examples/contract). */
  const SET_MADE = fileURLToPath(new URL('../examples/contract/set-made-product', import.meta.url));

  test('names every product the home holds, one fact per line, in code point order, and serves nothing', () => {
    const home = scratchFolder('madarch-cli-list-');
    // A madarch-made draft (through the library its command wraps), the
    // set's own example, and a folder written by hand — the three kinds.
    const made = createDraft({ home, gitEnv: gitEnv(GIT_IDENTITY ? { ...GIT_ENV } : {}) });
    if (made.outcome !== 'created') throw new Error(`the draft was not created: ${JSON.stringify(made)}`);
    const setMade = join(home, 'set-made');
    cpSync(SET_MADE, setMade, { recursive: true });
    const hand = join(home, 'hand-written');
    mkdirSync(hand);
    writeFileSync(join(hand, 'workspace.yaml'), ['schemaVersion: 1', 'id: 3f6d2dc8-b16e-4bf0-9d3a-2c9c00b5287d'].join('\n'));

    const { status, stdout, stderr } = runCommand(['list', '--home', home]);
    expect(stderr).toBe('');
    expect(status).toBe(0);
    // Code point order of the folders: hand-written < idea-… < set-made.
    const at = (needle: string) => stdout.indexOf(needle);
    expect(stdout).toContain('hand-written');
    expect(stdout).toContain(`idea-${todayName()}`);
    expect(stdout).toContain('leftover-listings');
    expect(stdout).toContain('open with: cd ');
    expect(at('hand-written')).toBeGreaterThan(-1);
    expect(at('leftover-listings')).toBeGreaterThan(at(`idea-${todayName()}`));
    expect(at(`idea-${todayName()}`)).toBeGreaterThan(at('hand-written'));
  });

  test('the folders order by code point: a name above the basic plane falls after U+E000, not before', () => {
    const home = scratchFolder('madarch-cli-list-plane-');
    // U+E000, a private-use code point, against U+10000 written as its
    // surrogate pair: UTF-16 order puts the pair's high half first and the
    // list would answer that; the code point order the capability names is
    // the reverse.
    const planeE = '\uE000';
    const plane15 = '\u{10000}';
    for (const folder of [join(home, planeE), join(home, plane15)]) {
      mkdirSync(folder);
      writeFileSync(join(folder, 'workspace.yaml'), ['schemaVersion: 1', 'id: 3f6d2dc8-b16e-4bf0-9d3a-2c9c00b5287d'].join('\n'));
    }
    const { stdout, stderr, status } = runCommand(['list', '--home', home]);
    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(stdout.indexOf(planeE)).toBeGreaterThan(-1);
    expect(stdout.indexOf(plane15)).toBeGreaterThan(-1);
    expect(stdout.indexOf(plane15)).toBeGreaterThan(stdout.indexOf(planeE));
  });

  test('the order compares code points pairwise from the first difference, and a prefix falls first', () => {
    const home = scratchFolder('madarch-cli-list-ord2-');
    // Two names that differ only past their shared prefix, at a character
    // whose code points order opposite their UTF-16 halves, and one name a
    // prefix of the other: a comparator that stops early, reads a wrong
    // character, or lets a prefix compare as longer, answers in another
    // order than the capability names.
    const names = ['a\uE000b', 'a\u{10000}b', 'a', 'ab', 'a\uE000c'];
    for (const name of names) {
      mkdirSync(join(home, name));
      writeFileSync(join(home, name, 'workspace.yaml'), ['schemaVersion: 1', 'id: 3f6d2dc8-b16e-4bf0-9d3a-2c9c00b5287d'].join('\n'));
    }
    const { stdout, stderr, status } = runCommand(['list', '--home', home]);
    expect(stderr).toBe('');
    expect(status).toBe(0);
    // a (shortest) < ab < a\uE000b < a\uE000c < a\u{10000}b — the plane-15
    // character after the private-use one, and equal prefixes settled at
    // the first difference or the length.
    const at = (name: string) => stdout.indexOf(name);
    const ordered = ['a', 'ab', 'a\uE000b', 'a\uE000c', 'a\u{10000}b'].map(at);
    expect(ordered.every((v) => v > -1)).toBe(true);
    expect([...ordered].sort((x, y) => x - y)).toEqual(ordered);
  });

  test('the products home MADARCH_HOME names is listed with no --home, as a draft\'s home is', () => {
    const madarchHome = scratchFolder('madarch-cli-list-home-');
    const products = join(madarchHome, 'products');
    mkdirSync(products, { recursive: true });
    const made = createDraft({ home: products, gitEnv: gitEnv(GIT_ENV) });
    expect(made.outcome).toBe('created');
    const { status, stdout, stderr } = runCommand(['list'], { MADARCH_HOME: madarchHome });
    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(stdout).toContain(made.outcome === 'created' ? made.folder : 'never');
    expect(stdout).toContain(made.outcome === 'created' ? made.id : 'never');
  });

  test('an absent home and an empty home tell the user to start a product', () => {
    const absent = join(scratchFolder('madarch-cli-list-absent-'), 'nothing-here');
    const absentRun = runCommand(['list', '--home', absent]);
    expect(absentRun.status).toBe(0);
    expect(absentRun.stdout).toContain('madarch new');
    expect(absentRun.stderr).toBe('');

    const empty = scratchFolder('madarch-cli-list-empty-');
    const emptyRun = runCommand(['list', '--home', empty]);
    expect(emptyRun.status).toBe(0);
    expect(emptyRun.stdout).toContain('madarch new');
    expect(emptyRun.stderr).toBe('');
  });

  test('--json keeps product facts machine-readable while the default list is human-readable', () => {
    const home = scratchFolder('madarch-cli-list-json-');
    const draft = createDraft({ home, gitEnv: gitEnv(GIT_ENV) });
    expect(draft.outcome).toBe('created');
    const human = runCommand(['list', '--home', home]);
    expect(human.stdout).toContain('Products:');
    expect(human.stdout).toContain('open with:');
    expect(human.stdout).not.toContain('folder:');
    const machine = runCommand(['list', '--home', home, '--json']);
    expect(JSON.parse(machine.stdout)).toEqual({ products: [{ folder: draft.outcome === 'created' ? draft.folder : '', id: draft.outcome === 'created' ? draft.id : '', name: draft.outcome === 'created' ? draft.name : '' }] });
  });

  test('a subfolder that holds no manifest is not a product and is not listed', () => {
    const home = scratchFolder('madarch-cli-list-stray-');
    const stray = join(home, 'old-notes');
    mkdirSync(stray);
    cpSync(SET_MADE, join(home, 'set-made'), { recursive: true });
    // A plain file stands beside the products: a folder is what the list
    // walks, and saying so in code is what a sorted walk over Dirents is
    // for; a home that took the file as a folder would name it a product.
    writeFileSync(join(home, 'notepad.txt'), 'a plain file this home also holds\n');
    const { status, stdout, stderr } = runCommand(['list', '--home', home]);
    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(stdout).toContain('set-made');
    expect(stdout).not.toContain('old-notes');
  });

  test('a product whose manifest cannot be read is named on standard error, and the list still shows what it read', () => {
    const home = scratchFolder('madarch-cli-list-broken-');
    const broken = join(home, 'broken-draft');
    mkdirSync(broken);
    writeFileSync(join(broken, 'workspace.yaml'), ['schemaVersion: 1', 'id: 3f6d2dc8-b16e-4bf0-9d3a-2c9c00b5287d', 'name: 5', ''].join('\n'));
    cpSync(SET_MADE, join(home, 'set-made'), { recursive: true });
    const { status, stdout, stderr } = runCommand(['list', '--home', home]);
    expect(status).toBe(0);
    expect(stdout).toContain('set-made');
    expect(stdout).not.toContain('broken-draft');
    expect(stderr).toContain(join(broken, 'workspace.yaml'));
    expect(stderr).toContain('"name"');
  });

  test('a home that is a file exits 2 naming the path', () => {
    const base = scratchFolder('madarch-cli-list-file-');
    const home = join(base, 'home');
    writeFileSync(home, 'not a folder\n');
    const { status, stdout, stderr } = runCommand(['list', '--home', home]);
    expect(status).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain(home);
    expect(stderr).toContain('cannot be');
  });

  test('a home whose path cannot be looked at is refused exit 2, not an empty list', () => {
    // The home's parent is a file: the stat of the home itself fails with
    // ENOTDIR, and an empty list would say there is nothing where the
    // command could not even look.
    const base = scratchFolder('madarch-cli-list-notdir-');
    const home = join(base, 'blocker', 'deeper', 'products');
    writeFileSync(join(base, 'blocker'), 'a file where a folder is needed\n');
    const { status, stdout, stderr } = runCommand(['list', '--home', home]);
    expect(status).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain(home);
    expect(stderr).toContain('cannot be');
  });

  test('a home that cannot be listed is refused, naming the path and the cause', () => {
    if (process.getuid?.() === 0) return; // root lists anything; the case is meaningless there.
    const base = scratchFolder('madarch-cli-list-noacc-');
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true, mode: 0o000 }); // no read: listing it is refused by the system, not by madarch.
    try {
      const { status, stdout, stderr } = runCommand(['list', '--home', home]);
      expect(status).toBe(2);
      expect(stdout).toBe('');
      expect(stderr).toContain(home);
    } finally {
      chmodSync(home, 0o700);
    }
  });

  test("the library's own outcomes are the words the command maps: listed, products and unreadable in place", () => {
    const home = scratchFolder('madarch-cli-list-lib-');
    const made = createDraft({ home, gitEnv: gitEnv(GIT_ENV) });
    expect(made.outcome).toBe('created');
    const broken = join(home, 'broken');
    mkdirSync(broken);
    writeFileSync(join(broken, 'workspace.yaml'), 'schemaVersion: 1\nid: x\nname: 5\n');
    const listed = listProducts({ home });
    expect(listed.outcome).toBe('listed');
    if (listed.outcome !== 'listed') return;
    expect(listed.products.map((p) => p.folder)).toEqual([made.outcome === 'created' ? made.folder : 'never']);
    expect(listed.unreadable.map((u) => u.folder)).toEqual([broken]);
    const absent = listProducts({ home: join(home, 'nothing-here') });
    expect(absent.outcome).toBe('listed');
    if (absent.outcome !== 'listed') return;
    expect(absent.products).toEqual([]);
    expect(absent.unreadable).toEqual([]);
    const base = scratchFolder('madarch-cli-list-libfile-');
    const fileHome = join(base, 'home');
    writeFileSync(fileHome, 'not a folder\n');
    expect(listProducts({ home: fileHome })).toMatchObject({ outcome: 'refused', message: expect.stringContaining('cannot be listed') });
  });

  test('list takes no --port and opens no browser: a serving option is refused, naming what list accepts', () => {
    const home = scratchFolder('madarch-cli-list-flags-');
    const run = runCommand(['list', '--home', home, '--port', '0']);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('--port');
    expect(run.stderr).toContain('unknown option');
    const openRun = runCommand(['list', '--home', home, '--no-open']);
    expect(openRun.status).toBe(2);
    expect(openRun.stderr).toContain('--no-open');
    const productRun = runCommand(['list', '--home', home, '--product', home]);
    expect(productRun.status).toBe(2);
    expect(productRun.stderr).toContain('--product');
    expect(productRun.stderr).toContain('unknown option');
  });

  test('a folder whose manifest cannot even be reached is named, not skipped', () => {
    // The manifest is there but the folder cannot be looked into: the
    // reader is asked anyway, so its refusal — never a quiet skip — is
    // what the list shows. The 3-kinds kind of skip is for folders with
    // no manifest at all.
    if (process.getuid?.() === 0) return; // root opens anything; the case is meaningless there.
    const home = scratchFolder('madarch-cli-list-dark-');
    const dark = join(home, 'dark-draft');
    mkdirSync(dark);
    writeFileSync(join(dark, 'workspace.yaml'), 'schemaVersion: 1\nid: x\nname: dark\n');
    const good = join(home, 'set-made');
    cpSync(SET_MADE, good, { recursive: true });
    chmodSync(dark, 0o000);
    try {
      const { status, stdout, stderr } = runCommand(['list', '--home', home]);
      expect(status).toBe(0);
      expect(stdout).toContain('set-made');
      expect(stderr).toContain(dark);
      expect(stderr).toContain('could not be read');
    } finally {
      chmodSync(dark, 0o700);
    }
  });
});

  /** A product draft made through the library its command wraps, with this file's own git identity. */
function madeDraft(home: string): { folder: string; id: string; name: string } {
  const made = createDraft({ home, gitEnv: gitEnv(GIT_ENV) });
  if (made.outcome !== 'created') throw new Error(`the fixture draft was not created: ${JSON.stringify(made)}`);
  return { folder: made.folder, id: made.id, name: made.name };
}

/**
 * A bare git repository holding one commit, as a path a clone comes from:
 * reachable only inside the test's own scratch folder.
 */
function sourceRepo(base: string, name: string): string {
  const directory = join(base, name);
  const work = join(base, `${name}-work`);
  const git = (args: string[], cwd?: string): void => {
    const step = spawnSync(realGit(), args, { cwd: cwd ?? directory, encoding: 'utf8', env: gitEnv(GIT_ENV) });
    if (step.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${step.status} ${step.stdout} ${step.stderr} ${step.error ? String(step.error) : ''}`);
  };
  git(['init', '--bare', '--initial-branch=main', directory], base);
  git(['init', '--initial-branch=main', work], base);
  writeFileSync(join(work, 'README.md'), 'a repository the tests clone from\n');
  git(['add', '--', 'README.md'], work);
  git(['commit', '--quiet', '-m', 'One commit'], work);
  git(['push', '--quiet', directory, 'main'], work);
  rmSync(work, { recursive: true, force: true });
  return directory;
}

/** A draft pushed to its own bare origin, optionally with one declared and bootstrapped code repository. */
function productOnOrigin(base: string, home: string, options: { withRepo?: boolean } = {}): { folder: string; id: string } {
  const draft = madeDraft(home);
  if (options.withRepo === true) {
    const url = sourceRepo(base, 'library-source');
    const entered = addCodeRepository({ folder: draft.folder, name: 'library', url, gitEnv: gitEnv(GIT_ENV) });
    if (entered.outcome !== 'entered') throw new Error(`the fixture repository was not entered: ${JSON.stringify(entered)}`);
    const bootstrapped = bootstrapProduct({ folder: draft.folder, gitEnv: gitEnv(GIT_ENV) });
    if (bootstrapped.outcome !== 'bootstrapped') throw new Error(`the fixture was not bootstrapped: ${JSON.stringify(bootstrapped)}`);
  }
  const origin = join(base, 'fixture-origin.git');
  const bare = spawnSync('git', ['init', '--bare', '--initial-branch=main', origin], { encoding: 'utf8', env: gitEnv(GIT_ENV) });
  if (bare.status !== 0) throw new Error(`the fixture origin was not created: ${bare.stderr}`);
  const pushed = spawnSync('git', ['push', '--quiet', '--all', origin], { cwd: draft.folder, encoding: 'utf8', env: gitEnv(GIT_ENV) });
  if (pushed.status !== 0) throw new Error(`the fixture was not pushed: ${pushed.stdout} ${pushed.stderr}`);
  return { folder: draft.folder, id: draft.id };
}

describe('madarch rename', () => {

  test("renames the draft in place and keeps the id: the folder, the manifest's name and nothing else", () => {
    const base = scratchFolder('madarch-cli-lc-');
    const home = join(base, 'home'); mkdirSync(home, { recursive: true });
    const draft = madeDraft(home);
    const run = runCommand(['rename', 'gadgets', '--product', draft.folder], {});
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout).toContain(`folder: ${join(home, 'gadgets')}`);
    expect(run.stdout).toContain('name: gadgets');
    const renamed = join(home, 'gadgets');
    const read = readProduct(renamed);
    expect(read).toMatchObject({ ok: true, product: { id: draft.id, name: 'gadgets' } });
    expect(draft.folder).not.toBe(renamed);
  });

  test('also answers from a checkout of the product repos: the checkout parent product is renamed', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const home = join(base, 'home'); mkdirSync(home, { recursive: true });
    const product = productOnOrigin(base, home, { withRepo: true });
    const run = runCommand(['rename', 'gadgets'], {}, join(product.folder, 'repos', 'library'));
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`folder: ${join(home, 'gadgets')}`);
  });

  test('from a folder that carries no product is refused, exit 2, naming the folder', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const run = runCommand(['rename', 'gadgets'], {}, base);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(base);
    expect(run.stdout).toBe('');
  });

  test('to a name the home already holds is refused, exit 2, naming the folder in the way', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const home = join(base, 'home'); mkdirSync(home, { recursive: true });
    const first = madeDraft(home);
    const second = madeDraft(home);
    // The name the home already holds is the other draft's: what the folder the
    // rename would take stands in (the program's own refusal words).
    const run = runCommand(['rename', second.name, '--product', first.folder], {});
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('is in the way');
  });

  test('with no word naming the product is refused, exit 2', () => {
    const run = runCommand(['rename'], {}, scratchFolder('madarch-cli-lc-'));
    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
  });

  test('a manifest the rename cannot read is refused at its file and line: exit 2 with workspace.yaml:3: and the words', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const home = join(base, 'home'); mkdirSync(home, { recursive: true });
    const draft = madeDraft(home);
    writeFileSync(join(draft.folder, 'workspace.yaml'), ['schemaVersion: 1', 'id: 3f6d2dc8-b16e-4bf0-9d3a-2c9c00b5287d', 'name: 5', ''].join('\n'));
    const run = runCommand(['rename', 'gadgets', '--product', draft.folder], {});
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(`${join(draft.folder, 'workspace.yaml')}:3:`);
    expect(run.stderr).toContain('not a name, which is a word');
    expect(readProduct(draft.folder).ok).toBe(false);
  });

  test("a git that refuses to commit: exit 1 with git's own words, and the folder is not renamed", () => {
    const base = scratchFolder('madarch-cli-lc-');
    const stubs = scratchFolder('madarch-cli-gitstub-');
    const script = ['#!/bin/sh', 'if [ "$1" = "commit" ]; then', "  echo 'stub: refusing to commit' >&2; exit 1; fi", `exec ${shQuote(realGit())} "$@"`, ''].join('\n');
    writeFileSync(join(stubs, 'git'), script);
    chmodSync(join(stubs, 'git'), 0o700);
    const home = join(base, 'home'); mkdirSync(home, { recursive: true });
    const draft = madeDraft(home);
    const run = runCommand(['rename', 'gadgets', '--product', draft.folder], { PATH: `${stubs}:${process.env.PATH ?? ''}` });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('refusing to commit');
    expect(readProduct(draft.folder).ok).toBe(true);
    expect(readProduct(join(home, 'gadgets')).ok).toBe(false);
  });
});

describe('madarch remote', () => {
  test('adds origin and prints where the remote points', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const home = join(base, 'home'); mkdirSync(home, { recursive: true });
    const draft = madeDraft(home);
    const url = join(base, 'somewhere.git');
    const run = runCommand(['remote', url, '--product', draft.folder], {});
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`folder: ${draft.folder}`);
    expect(run.stdout).toContain('remote: origin');
    expect(run.stdout).toContain(`url: ${url}`);
    const got = spawnSync(realGit(), ['remote', 'get-url', 'origin'], { cwd: draft.folder, encoding: 'utf8', env: gitEnv(GIT_ENV) });
    expect(got.stdout.trim()).toBe(url);
  });

  test('an origin already there is refused, never silently repointed', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const home = join(base, 'home'); mkdirSync(home, { recursive: true });
    const draft = madeDraft(home);
    runCommand(['remote', join(base, 'one.git'), '--product', draft.folder], {});
    const run = runCommand(['remote', join(base, 'two.git'), '--product', draft.folder], {});
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('already has the remote "origin"');
  });

  test('a folder that carries no product is refused, exit 2', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const run = runCommand(['remote', join(base, 'one.git')], {}, base);
    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
  });

  test('with no url is refused, exit 2', () => {
    const run = runCommand(['remote'], {}, scratchFolder('madarch-cli-lc-'));
    expect(run.status).toBe(2);
  });
});

describe('madarch repo add', () => {
  test('uses a Windows directory junction for a directory link', () => {
    let received: string | null | undefined;
    createDirectoryLink('source', 'target', 'win32', (_source, _target, type) => { received = type; });
    expect(received).toBe('junction');
  });

  test('defaults a blank interactive choice to link', () => {
    expect(repoModeFromAnswer('')).toBe('link');
    expect(repoModeFromAnswer('  ')).toBe('link');
    expect(repoModeFromAnswer('move')).toBe('move');
    expect(repoModeFromAnswer('clone')).toBe('clone');
    expect(repoModeFromAnswer('other')).toBeUndefined();
  });

  test('links an explicit local checkout without changing its branch, work or stash', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const home = join(base, 'home'); mkdirSync(home, { recursive: true });
    const draft = madeDraft(home);
    const url = sourceRepo(base, 'library-source');
    const source = join(base, 'existing-checkout');
    const clone = spawnSync(realGit(), ['clone', '--quiet', url, source], { encoding: 'utf8', env: gitEnv(GIT_ENV) });
    if (clone.status !== 0) throw new Error(`fixture clone failed: ${clone.stderr}`);
    writeFileSync(join(source, 'stash-me.txt'), 'stashed fixture work\n');
    const stashed = spawnSync(realGit(), ['-C', source, 'stash', 'push', '--include-untracked', '-m', 'fixture stash'], { encoding: 'utf8', env: gitEnv(GIT_ENV) });
    if (stashed.status !== 0) throw new Error(`fixture stash failed: ${stashed.stderr}`);
    writeFileSync(join(source, 'uncommitted.txt'), 'working fixture file\n');
    const branch = spawnSync(realGit(), ['-C', source, 'branch', '--show-current'], { encoding: 'utf8', env: gitEnv(GIT_ENV) }).stdout.trim();
    const stash = spawnSync(realGit(), ['-C', source, 'stash', 'list', '--format=%H'], { encoding: 'utf8', env: gitEnv(GIT_ENV) }).stdout.trim();

    const missingMode = runCommand(['repo', 'add', 'library', url, '--source', source, '--product', draft.folder], {});
    expect(missingMode.status).toBe(2);
    expect(missingMode.stderr).toContain('--mode');
    expect(existsSync(join(draft.folder, 'repos', 'library'))).toBe(false);
    const run = runCommand(['repo', 'add', 'library', url, '--source', source, '--mode', 'link', '--product', draft.folder], {});
    expect(run.status).toBe(0);
    const target = join(draft.folder, 'repos', 'library');
    expect(realpathSync(target)).toBe(realpathSync(source));
    expect(spawnSync(realGit(), ['-C', source, 'branch', '--show-current'], { encoding: 'utf8', env: gitEnv(GIT_ENV) }).stdout.trim()).toBe(branch);
    expect(readFileSync(join(source, 'uncommitted.txt'), 'utf8')).toBe('working fixture file\n');
    expect(spawnSync(realGit(), ['-C', source, 'stash', 'list', '--format=%H'], { encoding: 'utf8', env: gitEnv(GIT_ENV) }).stdout.trim()).toBe(stash);
    const read = readProduct(draft.folder);
    expect(read).toMatchObject({ ok: true, product: { repos: [{ name: 'library', url }] } });
    expect(readFileSync(join(draft.folder, 'workspace.yaml'), 'utf8')).not.toContain(source);
    expect(existsSync(join(source, 'workspace.yaml'))).toBe(false);
  });

  test('asks for the local connection mode and uses the interactive choice', async () => {
    const base = scratchFolder('madarch-cli-lc-');
    const home = join(base, 'home'); mkdirSync(home, { recursive: true });
    const draft = madeDraft(home);
    const url = sourceRepo(base, 'library-source');
    const source = join(base, 'selected-checkout');
    const cloned = spawnSync(realGit(), ['clone', '--quiet', url, source], { encoding: 'utf8', env: gitEnv(GIT_ENV) });
    if (cloned.status !== 0) throw new Error(`fixture clone failed: ${cloned.stderr}`);
    // main runs in-process here, so set identity on the product repository instead of relying on the runner's global git config.
    const name = spawnSync(realGit(), ['-C', draft.folder, 'config', '--local', 'user.name', GIT_ENV.GIT_AUTHOR_NAME], { encoding: 'utf8', env: gitEnv(GIT_ENV) });
    if (name.status !== 0) throw new Error(`fixture user.name config failed: ${name.stderr}`);
    const email = spawnSync(realGit(), ['-C', draft.folder, 'config', '--local', 'user.email', GIT_ENV.GIT_AUTHOR_EMAIL], { encoding: 'utf8', env: gitEnv(GIT_ENV) });
    if (email.status !== 0) throw new Error(`fixture user.email config failed: ${email.stderr}`);
    let asked: string | undefined;
    const exit = await main(['repo', 'add', 'library', url, '--source', source, '--product', draft.folder], {
      chooseRepoMode: async (selected) => { asked = selected; return 'link'; },
    });
    expect(exit).toBe(0);
    expect(asked).toBe(source);
    expect(realpathSync(join(draft.folder, 'repos', 'library'))).toBe(realpathSync(source));
  });

  test('uses the checkout the command runs from when a product is selected', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const home = join(base, 'home'); mkdirSync(home, { recursive: true });
    const draft = madeDraft(home);
    const url = sourceRepo(base, 'library-source');
    const source = join(base, 'current-checkout');
    const cloned = spawnSync(realGit(), ['clone', '--quiet', url, source], { encoding: 'utf8', env: gitEnv(GIT_ENV) });
    if (cloned.status !== 0) throw new Error(`fixture clone failed: ${cloned.stderr}`);
    const missingMode = runCommand(['repo', 'add', 'library', url, '--product', draft.folder], {}, source);
    expect(missingMode.status).toBe(2);
    expect(missingMode.stderr).toContain('--mode');
    const run = runCommand(['repo', 'add', 'library', url, '--mode', 'link', '--product', draft.folder], {}, source);
    expect(run.status).toBe(0);
    expect(realpathSync(join(draft.folder, 'repos', 'library'))).toBe(realpathSync(source));
    expect(readProduct(draft.folder)).toMatchObject({ ok: true, product: { repos: [{ name: 'library', url }] } });
  });

  test('does not treat a symlink alias of the product as its own local source', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const home = join(base, 'home'); mkdirSync(home, { recursive: true });
    const draft = madeDraft(home);
    const url = sourceRepo(base, 'library-source');
    const alias = join(base, 'product-link');
    symlinkSync(draft.folder, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const manifest = readFileSync(join(draft.folder, 'workspace.yaml'), 'utf8');

    const implicit = runCommand(['repo', 'add', 'library', url, '--mode', 'move'], {}, alias);
    expect(implicit.status).toBe(2);
    expect(implicit.stderr).toContain('needs a local source');
    expect(readFileSync(join(draft.folder, 'workspace.yaml'), 'utf8')).toBe(manifest);
    expect(existsSync(join(draft.folder, 'repos', 'library'))).toBe(false);

    const explicit = runCommand(['repo', 'add', 'library', url, '--source', alias, '--mode', 'move', '--product', alias], {}, base);
    expect(explicit.status).toBe(2);
    expect(explicit.stderr).toContain('cannot also be the local code checkout');
    expect(existsSync(alias)).toBe(true);
    expect(readFileSync(join(draft.folder, 'workspace.yaml'), 'utf8')).toBe(manifest);
  });

  test('moves the selected checkout and preserves its branch, uncommitted work and stash', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const home = join(base, 'home'); mkdirSync(home, { recursive: true });
    const draft = madeDraft(home);
    const url = sourceRepo(base, 'library-source');
    const source = join(base, 'existing-checkout');
    const clone = spawnSync(realGit(), ['clone', '--quiet', url, source], { encoding: 'utf8', env: gitEnv(GIT_ENV) });
    if (clone.status !== 0) throw new Error(`fixture clone failed: ${clone.stderr}`);
    writeFileSync(join(source, 'stash-me.txt'), 'stashed fixture work\n');
    const stashed = spawnSync(realGit(), ['-C', source, 'stash', 'push', '--include-untracked', '-m', 'fixture stash'], { encoding: 'utf8', env: gitEnv(GIT_ENV) });
    if (stashed.status !== 0) throw new Error(`fixture stash failed: ${stashed.stderr}`);
    writeFileSync(join(source, 'uncommitted.txt'), 'working fixture file\n');
    const branch = spawnSync(realGit(), ['-C', source, 'branch', '--show-current'], { encoding: 'utf8', env: gitEnv(GIT_ENV) }).stdout.trim();
    const stash = spawnSync(realGit(), ['-C', source, 'stash', 'list', '--format=%H'], { encoding: 'utf8', env: gitEnv(GIT_ENV) }).stdout.trim();

    const run = runCommand(['repo', 'add', 'library', url, '--source', source, '--mode', 'move', '--product', draft.folder], {});
    expect(run.status).toBe(0);
    const target = join(draft.folder, 'repos', 'library');
    expect(existsSync(source)).toBe(false);
    expect(spawnSync(realGit(), ['-C', target, 'branch', '--show-current'], { encoding: 'utf8', env: gitEnv(GIT_ENV) }).stdout.trim()).toBe(branch);
    expect(readFileSync(join(target, 'uncommitted.txt'), 'utf8')).toBe('working fixture file\n');
    expect(spawnSync(realGit(), ['-C', target, 'stash', 'list', '--format=%H'], { encoding: 'utf8', env: gitEnv(GIT_ENV) }).stdout.trim()).toBe(stash);
    expect(readProduct(draft.folder)).toMatchObject({ ok: true, product: { repos: [{ name: 'library', url }] } });
  });

  test('restores a moved checkout and leaves the manifest unchanged when its commit fails', () => {
    if (process.platform === 'win32') return; // the fixture hook is a POSIX script.
    const base = scratchFolder('madarch-cli-lc-');
    const home = join(base, 'home'); mkdirSync(home, { recursive: true });
    const draft = madeDraft(home);
    const url = sourceRepo(base, 'library-source');
    const source = join(base, 'existing-checkout');
    const clone = spawnSync(realGit(), ['clone', '--quiet', url, source], { encoding: 'utf8', env: gitEnv(GIT_ENV) });
    if (clone.status !== 0) throw new Error(`fixture clone failed: ${clone.stderr}`);
    writeFileSync(join(source, 'uncommitted.txt'), 'keep after refusal\n');
    const hooks = join(base, 'hooks'); mkdirSync(hooks);
    const hook = join(hooks, 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    chmodSync(hook, 0o755);
    const configured = spawnSync(realGit(), ['-C', draft.folder, 'config', 'core.hooksPath', hooks], { encoding: 'utf8', env: gitEnv(GIT_ENV) });
    if (configured.status !== 0) throw new Error(`fixture hook config failed: ${configured.stderr}`);
    const manifest = readFileSync(join(draft.folder, 'workspace.yaml'), 'utf8');

    const run = runCommand(['repo', 'add', 'library', url, '--source', source, '--mode', 'move', '--product', draft.folder], {}, base);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(source);
    expect(existsSync(source)).toBe(true);
    expect(existsSync(join(draft.folder, 'repos', 'library'))).toBe(false);
    expect(readFileSync(join(source, 'uncommitted.txt'), 'utf8')).toBe('keep after refusal\n');
    expect(readFileSync(join(draft.folder, 'workspace.yaml'), 'utf8')).toBe(manifest);
    expect(spawnSync(realGit(), ['-C', draft.folder, 'status', '--porcelain'], { encoding: 'utf8', env: gitEnv(GIT_ENV) }).stdout.trim()).toBe('');
  });

  test('keeps a moved checkout and reports a manifest restore failure when its commit fails', () => {
    if (process.platform === 'win32') return; // the fixture hook is a POSIX script.
    const base = scratchFolder('madarch-cli-lc-');
    const home = join(base, 'home'); mkdirSync(home, { recursive: true });
    const draft = madeDraft(home);
    const url = sourceRepo(base, 'library-source');
    const source = join(base, 'existing-checkout');
    const clone = spawnSync(realGit(), ['clone', '--quiet', url, source], { encoding: 'utf8', env: gitEnv(GIT_ENV) });
    if (clone.status !== 0) throw new Error(`fixture clone failed: ${clone.stderr}`);
    writeFileSync(join(source, 'uncommitted.txt'), 'keep at the connection path\n');
    const hooks = join(base, 'hooks'); mkdirSync(hooks);
    const hook = join(hooks, 'pre-commit');
    writeFileSync(hook, "#!/bin/sh\nset -eu\nrm workspace.yaml\nmkdir workspace.yaml\nprintf 'injected commit failure\\n' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const configured = spawnSync(realGit(), ['-C', draft.folder, 'config', 'core.hooksPath', hooks], { encoding: 'utf8', env: gitEnv(GIT_ENV) });
    if (configured.status !== 0) throw new Error(`fixture hook config failed: ${configured.stderr}`);
    const manifestPath = join(draft.folder, 'workspace.yaml');
    const target = join(draft.folder, 'repos', 'library');

    const run = runCommand(['repo', 'add', 'library', url, '--source', source, '--mode', 'move', '--product', draft.folder], {}, base);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('injected commit failure');
    const restoreErrorLabel = `the manifest at ${manifestPath} could not be restored:`;
    expect(run.stderr).toContain(restoreErrorLabel);
    const restoreError = run.stderr.split(restoreErrorLabel, 2)[1]?.split(';', 1)[0]?.trim();
    expect(restoreError).toBeTruthy();
    expect(run.stdout).toContain(`connection: ${target}`);
    expect(existsSync(source)).toBe(false);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(join(target, 'uncommitted.txt'), 'utf8')).toBe('keep at the connection path\n');
    expect(statSync(manifestPath).isDirectory()).toBe(true);
  });

  test('keeps a moved checkout in place when the manifest index cannot be reset', () => {
    if (process.platform === 'win32') return; // The Git wrapper and commit hook are POSIX scripts.
    const base = scratchFolder('madarch-cli-lc-');
    const home = join(base, 'home'); mkdirSync(home, { recursive: true });
    const draft = madeDraft(home);
    const url = sourceRepo(base, 'library-source');
    const source = join(base, 'existing-checkout');
    const clone = spawnSync(realGit(), ['clone', '--quiet', url, source], { encoding: 'utf8', env: gitEnv(GIT_ENV) });
    if (clone.status !== 0) throw new Error(`fixture clone failed: ${clone.stderr}`);
    writeFileSync(join(source, 'uncommitted.txt'), 'keep at the connection path\n');
    const hooks = join(base, 'hooks'); mkdirSync(hooks);
    const hook = join(hooks, 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    chmodSync(hook, 0o755);
    const configured = spawnSync(realGit(), ['-C', draft.folder, 'config', 'core.hooksPath', hooks], { encoding: 'utf8', env: gitEnv(GIT_ENV) });
    if (configured.status !== 0) throw new Error(`fixture hook config failed: ${configured.stderr}`);
    const gitWrapper = join(base, 'git-wrapper'); mkdirSync(gitWrapper);
    const gitShim = join(gitWrapper, 'git');
    writeFileSync(gitShim, `#!/bin/sh\nif [ "$1" = "reset" ]; then\n  printf 'injected reset failure\n' >&2\n  exit 1\nfi\nexec "${realGit()}" "$@"\n`);
    chmodSync(gitShim, 0o755);
    const manifest = readFileSync(join(draft.folder, 'workspace.yaml'), 'utf8');
    const target = join(draft.folder, 'repos', 'library');

    const run = runCommand(['repo', 'add', 'library', url, '--source', source, '--mode', 'move', '--product', draft.folder], {
      PATH: `${gitWrapper}:${process.env.PATH ?? ''}`,
    }, base);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`the index in ${draft.folder} could not be restored`);
    expect(run.stdout).toContain(`connection: ${target}`);
    expect(existsSync(source)).toBe(false);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(join(target, 'uncommitted.txt'), 'utf8')).toBe('keep at the connection path\n');
    expect(readFileSync(join(draft.folder, 'workspace.yaml'), 'utf8')).toBe(manifest);
    expect(spawnSync(realGit(), ['-C', draft.folder, 'status', '--porcelain'], { encoding: 'utf8', env: gitEnv(GIT_ENV) }).stdout.trim()).toContain('MM workspace.yaml');
  });

  test('removes a failed clone without recording a manifest entry', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const home = join(base, 'home'); mkdirSync(home, { recursive: true });
    const draft = madeDraft(home);
    const missingUrl = join(base, 'missing-origin.git');
    const manifest = readFileSync(join(draft.folder, 'workspace.yaml'), 'utf8');
    const run = runCommand(['repo', 'add', 'library', missingUrl, '--product', draft.folder], {}, base);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(missingUrl);
    expect(existsSync(join(draft.folder, 'repos', 'library'))).toBe(false);
    expect(readFileSync(join(draft.folder, 'workspace.yaml'), 'utf8')).toBe(manifest);
  });

  test('clones the remote for clone mode and leaves the selected dirty checkout unchanged', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const home = join(base, 'home'); mkdirSync(home, { recursive: true });
    const draft = madeDraft(home);
    const url = sourceRepo(base, 'library-source');
    const source = join(base, 'existing-checkout');
    const clone = spawnSync(realGit(), ['clone', '--quiet', url, source], { encoding: 'utf8', env: gitEnv(GIT_ENV) });
    if (clone.status !== 0) throw new Error(`fixture clone failed: ${clone.stderr}`);
    writeFileSync(join(source, 'stash-me.txt'), 'stashed fixture work\n');
    const stashed = spawnSync(realGit(), ['-C', source, 'stash', 'push', '--include-untracked', '-m', 'fixture stash'], { encoding: 'utf8', env: gitEnv(GIT_ENV) });
    if (stashed.status !== 0) throw new Error(`fixture stash failed: ${stashed.stderr}`);
    writeFileSync(join(source, 'uncommitted.txt'), 'working fixture file\n');
    const stash = spawnSync(realGit(), ['-C', source, 'stash', 'list', '--format=%H'], { encoding: 'utf8', env: gitEnv(GIT_ENV) }).stdout.trim();

    const run = runCommand(['repo', 'add', 'library', url, '--source', source, '--mode', 'clone', '--product', draft.folder], {});
    expect(run.status).toBe(0);
    const target = join(draft.folder, 'repos', 'library');
    expect(readFileSync(join(target, 'README.md'), 'utf8')).toContain('a repository the tests clone from');
    expect(existsSync(join(target, 'uncommitted.txt'))).toBe(false);
    expect(readFileSync(join(source, 'uncommitted.txt'), 'utf8')).toBe('working fixture file\n');
    expect(spawnSync(realGit(), ['-C', source, 'stash', 'list', '--format=%H'], { encoding: 'utf8', env: gitEnv(GIT_ENV) }).stdout.trim()).toBe(stash);
    expect(readProduct(draft.folder)).toMatchObject({ ok: true, product: { repos: [{ name: 'library', url }] } });
  });

  test('enters the repository in the manifest and clones it into repos/<name>', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const home = join(base, 'home'); mkdirSync(home, { recursive: true });
    const draft = madeDraft(home);
    const url = sourceRepo(base, 'library-source');
    const run = runCommand(['repo', 'add', 'library', url, '--product', draft.folder], {}, base);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('repo: library');
    expect(run.stdout).toContain('cloned:');
    const read = readProduct(draft.folder);
    expect(read).toMatchObject({ ok: true, product: { repos: [{ name: 'library', url }] } });
    expect(readFileSync(join(draft.folder, 'repos', 'library', 'README.md'), 'utf8')).toContain('a repository the tests clone from');
  });

  test('the branch given is declared in the manifest', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const home = join(base, 'home'); mkdirSync(home, { recursive: true });
    const draft = madeDraft(home);
    const url = sourceRepo(base, 'library-source');
    const run = runCommand(['repo', 'add', 'library', url, '--branch', 'main', '--product', draft.folder], {}, base);
    expect(run.status).toBe(0);
    const read = readProduct(draft.folder);
    expect(read).toMatchObject({ ok: true, product: { repos: [{ name: 'library', branch: 'main' }] } });
  });

  test('a name the manifest already declares is refused, exit 2', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const home = join(base, 'home'); mkdirSync(home, { recursive: true });
    const draft = madeDraft(home);
    const url = sourceRepo(base, 'library-source');
    runCommand(['repo', 'add', 'library', url, '--product', draft.folder], {}, base);
    const run = runCommand(['repo', 'add', 'library', url, '--product', draft.folder], {}, base);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('already declares the code repository');
  });

  test('a checkout already there is left alone and reported, and the manifest closes the case: exit 2', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const home = join(base, 'home'); mkdirSync(home, { recursive: true });
    const draft = madeDraft(home);
    const url = sourceRepo(base, 'library-source');
    runCommand(['repo', 'add', 'library', url, '--product', draft.folder], {}, base);
    // The second command is refused for the manifest, before any clone: the
    // checkout standing there keeps whatever a person did with it.
    const changed = writeFileSync(join(draft.folder, 'repos', 'library', 'note.txt'), 'someone worked here\n');
    const run = runCommand(['repo', 'add', 'library', url, '--product', draft.folder], {}, base);
    expect(run.status).toBe(2);
    expect(readFileSync(join(draft.folder, 'repos', 'library', 'note.txt'), 'utf8')).toContain('someone worked here');
  });

  test('a product holding uncommitted changes is refused, exit 2', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const home = join(base, 'home'); mkdirSync(home, { recursive: true });
    const draft = madeDraft(home);
    const url = sourceRepo(base, 'library-source');
    writeFileSync(join(draft.folder, 'docs', 'vision.md'), 'uncommitted work\n');
    const run = runCommand(['repo', 'add', 'library', url, '--product', draft.folder], {}, base);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('not committed');
  });

  test('bootstrap runs after the manifest entry, so a second repository is cloned in the same command', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const home = join(base, 'home'); mkdirSync(home, { recursive: true });
    const draft = madeDraft(home);
    const first = sourceRepo(base, 'alpha-source');
    const second = sourceRepo(base, 'beta-source');
    const run = runCommand(['repo', 'add', 'beta', second, '--product', draft.folder], {}, base);
    expect(run.status).toBe(0);
    expect(statSync(join(draft.folder, 'repos', 'beta')).isDirectory()).toBe(true);
    expect(first).toContain('alpha-source'); // the unrelated one is untouched
  });
});

describe('madarch bootstrap', () => {
  test('clones what the manifest declares, works with no --product from inside the product', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const home = join(base, 'home'); mkdirSync(home, { recursive: true });
    const draft = madeDraft(home);
    const url = sourceRepo(base, 'library-source');
    const entered = addCodeRepository({ folder: draft.folder, name: 'library', url, gitEnv: gitEnv(GIT_ENV) });
    if (entered.outcome !== 'entered') throw new Error(`fixture: ${JSON.stringify(entered)}`);
    const run = runCommand(['bootstrap'], {}, draft.folder);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('cloned:');
    expect(readFileSync(join(draft.folder, 'repos', 'library', 'README.md'), 'utf8')).toContain('a repository the tests clone from');
  });

  test('a checkout already there is left alone and reported as present', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const home = join(base, 'home'); mkdirSync(home, { recursive: true });
    const draft = madeDraft(home);
    const url = sourceRepo(base, 'library-source');
    const entered = addCodeRepository({ folder: draft.folder, name: 'library', url, gitEnv: gitEnv(GIT_ENV) });
    if (entered.outcome !== 'entered') throw new Error(`fixture: ${JSON.stringify(entered)}`);
    const bootstrapped = bootstrapProduct({ folder: draft.folder, gitEnv: gitEnv(GIT_ENV) });
    if (bootstrapped.outcome !== 'bootstrapped') throw new Error(`fixture: ${JSON.stringify(bootstrapped)}`);
    const run = runCommand(['bootstrap', '--product', draft.folder], {});
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('library');
    expect(run.stdout).toContain('present:');
  });

  test('a manifest with nothing declared: exit 0, no repositories named', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const home = join(base, 'home'); mkdirSync(home, { recursive: true });
    const draft = madeDraft(home);
    const run = runCommand(['bootstrap', '--product', draft.folder], {});
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
  });

  test('a declared name standing in the way of the clone is a failure of the step: exit 1', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const home = join(base, 'home'); mkdirSync(home, { recursive: true });
    const draft = madeDraft(home);
    const url = sourceRepo(base, 'library-source');
    const entered = addCodeRepository({ folder: draft.folder, name: 'library', url, gitEnv: gitEnv(GIT_ENV) });
    if (entered.outcome !== 'entered') throw new Error(`fixture: ${JSON.stringify(entered)}`);
    writeFileSync(join(draft.folder, 'repos', 'library'), 'not a folder\n');
    const run = runCommand(['bootstrap', '--product', draft.folder], {});
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('library');
  });
});

describe('madarch clone', () => {
  test('clones a pushed product into a scratch home, bootstraps it and names the way to its wiki', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const home = join(base, 'home'); mkdirSync(home, { recursive: true });
    const product = productOnOrigin(base, home, { withRepo: true });
    const other = join(base, 'other'); mkdirSync(other, { recursive: true });
    const run = runCommand(['clone', join(base, 'fixture-origin.git'), '--home', other], {});
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('folder: ');
    expect(run.stdout).toContain('id: ');
    expect(run.stdout).toContain('wiki: madarch serve --product');
    expect(statSync(join(other, 'fixture-origin', 'repos', 'library')).isDirectory()).toBe(true);
  });

  test('a name the home holds is refused, exit 2, and the clone is not started', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const home = join(base, 'home'); mkdirSync(home, { recursive: true });
    const product = productOnOrigin(base, home);
    const other = join(base, 'other'); mkdirSync(other, { recursive: true });
    mkdirSync(join(other, 'fixture-origin'));
    const run = runCommand(['clone', join(base, 'fixture-origin.git'), '--home', other], {});
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('is in the way');
  });

  test('a url that is no product repository is refused: the folder goes with it', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const bare = join(base, 'plain.git');
    const work = join(base, 'plain-work');
    const git = (args: string[], cwd?: string): void => {
      const step = spawnSync(realGit(), args, { cwd, encoding: 'utf8', env: gitEnv(GIT_ENV) });
      if (step.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${step.stderr}`);
    };
    git(['init', '--bare', '--initial-branch=main', bare], base);
    git(['init', '--initial-branch=main', work], base);
    writeFileSync(join(work, 'README.md'), 'no product here\n');
    git(['-C', work, 'add', '--', 'README.md']);
    git(['-C', work, 'commit', '--quiet', '-m', 'One commit']);
    git(['-C', work, 'push', '--quiet', bare, 'main']);
    const other = join(base, 'other'); mkdirSync(other, { recursive: true });
    const run = runCommand(['clone', bare, '--home', other], {});
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('workspace.yaml');
    expect(existsSync(join(other, 'plain'))).toBe(false);
  });

  test('a git that cannot clone is a failed step: exit 1 with git', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const stubs = scratchFolder('madarch-cli-gitstub-');
    const script = ['#!/bin/sh', 'if [ "$1" = "clone" ]; then', "  echo 'stub: refusing to clone' >&2; exit 1; fi", `exec ${shQuote(realGit())} "$@"`, ''].join('\n');
    writeFileSync(join(stubs, 'git'), script);
    chmodSync(join(stubs, 'git'), 0o700);
    const other = join(base, 'other'); mkdirSync(other, { recursive: true });
    const run = runCommand(['clone', join(base, 'missing.git'), '--home', other], { PATH: `${stubs}:${process.env.PATH ?? ''}` });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('refusing to clone');
  });
});

describe('the lifecycle surface: repeated options', () => {
  test('a repeated value flag is refused, never silently taking the last', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const home = join(base, 'home'); mkdirSync(home, { recursive: true });
    const first = madeDraft(home);
    const run = runCommand(['rename', 'gadgets', '--product', first.folder, '--product', first.folder], {});
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('repeated option');
    const run2 = runCommand(['clone', join(base, 'x.git'), '--home', home, '--home', home], {});
    expect(run2.status).toBe(2);
    expect(run2.stderr).toContain('repeated option');
  });

  test('a repeated --branch on repo add is refused the same way', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const home = join(base, 'home'); mkdirSync(home, { recursive: true });
    const draft = madeDraft(home);
    const run = runCommand(['repo', 'add', 'lib', join(base, 'x.git'), '--branch', 'main', '--branch', 'dev', '--product', draft.folder], {});
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('repeated option');
  });
});

describe('the lifecycle surface', () => {
  test('--help lists the lifecycle subcommands with their options', () => {
    const { status, stdout } = runCommand(['--help'], {});
    expect(status).toBe(0);
    for (const word of ['rename', 'remote', 'repo add', 'bootstrap', 'clone']) expect(stdout).toContain(word);
  });

  test('an option the subcommand does not take is refused, never silently ignored', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const run = runCommand(['rename', 'gadgets', '--home', join(base, 'home')], {});
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('unknown option');
  });

  test('a word the subcommand does not expect is refused, naming what it takes', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const run = runCommand(['rename', 'gadgets', 'extra'], {}, base);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('extra');
    expect(run.stderr).toContain('name');
  });

  test('repo without the verb add is refused', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const run = runCommand(['repo', 'clone', 'name', join(base, 'x.git')], {}, base);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('add');
  });
});


describe('the release surface (madarch-lfhu)', () => {
  test('version names the version and exits 0 with no other facts', () => {
    const { status, stdout, stderr } = runCommand(['version'], {});
    expect(status).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toBe('version: dev\n');
  });

  test('upgrade in a checkout refuses naming why, before any network', () => {
    const { status, stderr, stdout } = runCommand(['upgrade'], {});
    expect(status).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('source checkout');
  });

  test('version and upgrade take none of the lifecycle options (an unknown option is named)', () => {
    for (const [sub, flag] of [['version', '--home'], ['upgrade', '--product'], ['version', '--port'], ['upgrade', '--no-open'], ['version', '--branch']] as const) {
      const { status, stderr } = runCommand([sub, flag, 'x' + String(Math.random()).slice(2)], {});
      expect(status).toBe(2);
      expect(stderr).toContain('unknown option');
      expect(stderr).toContain(flag);
    }
  });

  test('the --yes flag is the upgrade own answer flag, with no value and no other command', () => {
    const { status, stdout, stderr } = runCommand(['upgrade', '--yes'], {});
    expect(status).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('source checkout');
    const run = runCommand(['version', '--yes'], {});
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('unknown option');
    const run2 = runCommand(['upgrade', '--yes=true'], {});
    expect(run2.status).toBe(2);
    expect(run2.stderr).toContain('takes no value');
  });

  test('a stray word to version or upgrade is refused like any other subcommand word', () => {
    const run = runCommand(['version', 'extra'], {});
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('unexpected argument');
    expect(run.stderr).toContain('takes no words');
    const run2 = runCommand(['upgrade', 'now'], {});
    expect(run2.status).toBe(2);
    expect(run2.stderr).toContain('unexpected argument');
  });
});
