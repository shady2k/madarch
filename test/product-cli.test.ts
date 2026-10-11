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
import { existsSync, cpSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'bun:test';
import { readProduct } from '../src/product/manifest.js';
import { addCodeRepository, bootstrapProduct } from '../src/product/program.js';
import { createDraft } from '../src/product/draft.js';
import { listProducts } from '../src/product/list.js';
import { gitEnv } from './git-env.js';
import { GIT_IDENTITY, GIT_ENV } from './model-check-repo.js';
import { homeOfCommand, noStrayDrafts, ISOLATED_HOME, sealedHome } from './scratch-home.js';

// The library paths here create drafts in-process as well: MADARCH_HOME at
// the guard's scratch from this module's load, so a mutated home resolution
// that ignores an explicit home lands beside the scratch, never in the
// account's real home (the command tests seal their children besides this).
process.env.MADARCH_HOME = ISOLATED_HOME;

const CLI = fileURLToPath(new URL('../scripts/madarch.ts', import.meta.url));

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

function scratchFolder(prefix = 'madarch-cli-'): string {
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
  if (args[0] === 'new' || args[0] === 'list') homeOfCommand(args, env);
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
  finish(): Promise<{ stdout: string }>;
}
function serveNew(args: string[], overrides: Record<string, string> = {}, program: readonly string[] = ['bun', CLI]): LiveNew {
  const env = { ...process.env, ...SEALED_GIT, ...SEALED_CLOCK, ...sealedHome(overrides), ...overrides };
  if (args[0] === 'new') homeOfCommand(args, env);
  const proc = Bun.spawn([...program, ...args], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env,
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
      return { stdout };
    },
  };
}

/** An app folder with its dist already there: the serving builds nothing. */
function builtApp(base: string): string {
  const app = join(base, 'wiki-app');
  mkdirSync(join(app, 'dist', 'assets'), { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', private: true, scripts: { build: 'true' } }, null, 2));
  writeFileSync(join(app, 'dist', 'index.html'), '<!doctype html><title>built</title>');
  writeFileSync(join(app, 'dist', 'assets', 'app.js'), 'export const x = 1;');
  return app;
}

/** The draft's two printed facts, once both lines have arrived. */
async function printedLiveFacts(serve: LiveNew): Promise<{ folder: string; id: string }> {
  const start = Date.now();
  for (;;) {
    const lines = serve.stdout.split('\n').filter((line) => line !== '');
    if (lines.length >= 2 && lines[0]!.startsWith('folder: ') && lines[1]!.startsWith('id: ')) {
      return { folder: lines[0]!.slice('folder: '.length), id: lines[1]!.slice('id: '.length) };
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
  test('creates the draft under MADARCH_HOME and prints its folder and its id, one fact per line, then serves its wiki', async () => {
    const base = scratchFolder('madarch-cli-app-');
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    const serve = serveNew(['new', '--port', '0', '--no-open'], { MADARCH_HOME: home, MADARCH_APP: builtApp(base) });
    const { folder, id } = await printedLiveFacts(serve);
    expect(folder).toBe(join(home, 'products', `idea-${todayName()}`));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(statSync(folder).isDirectory()).toBe(true);
    expect(statSync(join(folder, '.git')).isDirectory()).toBe(true);
    // The id the manifest holds is the one the command printed.
    const read = readProduct(folder);
    expect(read).toMatchObject({ ok: true, product: { id, name: `idea-${todayName()}`, schemaVersion: 1 } });
    // Serving keeps the process alive until the test stops it.
    expect(serve.exitCode).toBe(null);
    await serve.finish();
  });

  test("--home moves this one command's products home, over MADARCH_HOME", async () => {
    const madarchHome = scratchFolder();
    const home = scratchFolder('madarch-cli-elsewhere-');
    const serve = serveNew(['new', '--home', home, '--port', '0', '--no-open'],
      { MADARCH_HOME: madarchHome, MADARCH_APP: builtApp(home) });
    const { folder } = await printedLiveFacts(serve);
    expect(folder).toBe(join(home, `idea-${todayName()}`));
    expect(statSync(folder).isDirectory()).toBe(true);
    await serve.finish();
    // And MADARCH_HOME holds nothing: nothing was written there.
    expect(readdirSync(madarchHome)).toEqual([]);
  });

  test('--home=FOLDER names the home in one word, the way the other commands parse it', async () => {
    const base = scratchFolder('madarch-cli-app-');
    const home = scratchFolder();
    const serve = serveNew(['new', `--home=${home}`, '--port', '0', '--no-open'], { MADARCH_APP: builtApp(base) });
    const { folder } = await printedLiveFacts(serve);
    expect(folder).toBe(join(home, `idea-${todayName()}`));
    await serve.finish();
  });

  test('a second new the same day makes -2, with its own id', async () => {
    const base = scratchFolder('madarch-cli-app-');
    const home = scratchFolder();
    const app = builtApp(base);
    const first = serveNew(['new', '--port', '0', '--no-open'], { MADARCH_HOME: home, MADARCH_APP: app });
    const firstFacts = await printedLiveFacts(first);
    const second = serveNew(['new', '--port', '0', '--no-open'], { MADARCH_HOME: home, MADARCH_APP: app });
    const secondFacts = await printedLiveFacts(second);
    expect(secondFacts.folder).toBe(`${firstFacts.folder}-2`);
    expect(secondFacts.id).not.toBe(firstFacts.id);
    await first.finish();
    await second.finish();
  });

  test('--help prints the subcommands and the options and exits 0', () => {
    const { status, stdout, stderr } = runCommand(['--help']);
    expect(status).toBe(0);
    expect(stderr).toBe('');
    const lines = stdout.split('\n');
    // The lines each subcommand's surface promises, whole: a help that was
    // edited away would be a promise the command no longer keeps.
    for (const line of [
      '   or: bun scripts/madarch.ts list [--home <folder>]',
      '  list       name the products the products home holds',
      '  --home <folder>       new, list and clone: the products home of this one command, over MADARCH_HOME',
      '                        (without either, ~/madarch/products)',
      '  --product <folder>    serve, rename, remote, repo add and bootstrap: the product folder to work on;',
    ]) {
      expect(lines).toContain(line);
    }
    expect(stdout).toContain('new');
    expect(stdout).toContain('--home');
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

  test('no arguments at all exits 2 naming what is accepted', () => {
    const { status, stderr } = runCommand([], {});
    expect(status).toBe(2);
    expect(stderr).toContain('new');
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
    const serve = serveNew(['new', '--home', ` ${home} `, '--port', '0', '--no-open'],
      { MADARCH_HOME: scratchFolder(), MADARCH_APP: builtApp(base) });
    const { folder } = await printedLiveFacts(serve);
    expect(folder).toBe(join(home, `idea-${todayName()}`));
    await serve.finish();
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

describe('the madarch command as an executable', () => {
  test('spawning the committed script itself answers --help: it carries an interpreter directive and the exec bit', () => {
    // Not through `bun <file>`: the way `bun link`'s shim runs it — the
    // file itself, executed, which needs its own directive and mode.
    const run = spawnSync(CLI, ['--help'], { encoding: 'utf8', timeout: 120_000 });
    expect(run.status).toBe(0);
    expect(run.stderr ?? '').toBe('');
    expect((run.stdout ?? '').length).toBeGreaterThan(0);
  });

  test('spawning the script itself creates a draft with MADARCH_HOME at a scratch folder, then serves it', async () => {
    const base = scratchFolder('madarch-cli-app-');
    const home = scratchFolder();
    const app = builtApp(base);
    // Not through `bun <file>`: the way `bun link`'s shim runs it — the
    // executed script itself.
    const serve = serveNew(['new', '--port', '0', '--no-open'], { MADARCH_HOME: home, MADARCH_APP: app }, [CLI]);
    const printed = await printedLiveFacts(serve);
    expect(statSync(printed.folder).isDirectory()).toBe(true);
    expect(printed.id).toMatch(/^[0-9a-f-]+$/);
    await serve.finish();
  });
});

describe('madarch list', () => {
  /** The set's example product folder, vendored with the pinned program. */
  const SET_MADE = fileURLToPath(new URL('../vendor/shady2k-skills/0.94.0/fixtures/product/good', import.meta.url));

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
    const blocks = stdout.split('\n\n').filter((block) => block !== '');
    expect(blocks.length).toBe(3);
    const names = blocks.map((block) => (block.split('\n').find((line) => line.startsWith('name: ')) ?? '').slice('name: '.length));
    expect(names).toEqual(['hand-written', `idea-${todayName()}`, 'leftover-listings']);
    for (const block of blocks) {
      expect(block).toMatch(/^folder: .+\n(id|name): /);
    }
    expect(at('hand-written')).toBeGreaterThan(-1);
    expect(at('leftover-listings')).toBeGreaterThan(at(`idea-${todayName()}`));
    expect(at(`idea-${todayName()}`)).toBeGreaterThan(at('hand-written'));
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
    expect(stdout).toContain(`id: ${made.outcome === 'created' ? made.id : ''}`);
  });

  test('an absent home and an empty home are each an empty list: exit 0, no output', () => {
    const absent = join(scratchFolder('madarch-cli-list-absent-'), 'nothing-here');
    const absentRun = runCommand(['list', '--home', absent]);
    expect(absentRun.status).toBe(0);
    expect(absentRun.stdout).toBe('');
    expect(absentRun.stderr).toBe('');

    const empty = scratchFolder('madarch-cli-list-empty-');
    const emptyRun = runCommand(['list', '--home', empty]);
    expect(emptyRun.status).toBe(0);
    expect(emptyRun.stdout).toBe('');
    expect(emptyRun.stderr).toBe('');
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
  test('enters the repository in the manifest and clones it into repos/<name>', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const home = join(base, 'home'); mkdirSync(home, { recursive: true });
    const draft = madeDraft(home);
    const url = sourceRepo(base, 'library-source');
    const run = runCommand(['repo', 'add', 'library', url, '--product', draft.folder], {});
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`repo: library`);
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
    const run = runCommand(['repo', 'add', 'library', url, '--branch', 'main', '--product', draft.folder], {});
    expect(run.status).toBe(0);
    const read = readProduct(draft.folder);
    expect(read).toMatchObject({ ok: true, product: { repos: [{ name: 'library', branch: 'main' }] } });
  });

  test('a name the manifest already declares is refused, exit 2', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const home = join(base, 'home'); mkdirSync(home, { recursive: true });
    const draft = madeDraft(home);
    const url = sourceRepo(base, 'library-source');
    runCommand(['repo', 'add', 'library', url, '--product', draft.folder], {});
    const run = runCommand(['repo', 'add', 'library', url, '--product', draft.folder], {});
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('already declares the code repository');
  });

  test('a checkout already there is left alone and reported, and the manifest closes the case: exit 2', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const home = join(base, 'home'); mkdirSync(home, { recursive: true });
    const draft = madeDraft(home);
    const url = sourceRepo(base, 'library-source');
    runCommand(['repo', 'add', 'library', url, '--product', draft.folder], {});
    // The second command is refused for the manifest, before any clone: the
    // checkout standing there keeps whatever a person did with it.
    const changed = writeFileSync(join(draft.folder, 'repos', 'library', 'note.txt'), 'someone worked here\n');
    const run = runCommand(['repo', 'add', 'library', url, '--product', draft.folder], {});
    expect(run.status).toBe(2);
    expect(readFileSync(join(draft.folder, 'repos', 'library', 'note.txt'), 'utf8')).toContain('someone worked here');
  });

  test('a product holding uncommitted changes is refused, exit 2', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const home = join(base, 'home'); mkdirSync(home, { recursive: true });
    const draft = madeDraft(home);
    const url = sourceRepo(base, 'library-source');
    writeFileSync(join(draft.folder, 'docs', 'vision.md'), 'uncommitted work\n');
    const run = runCommand(['repo', 'add', 'library', url, '--product', draft.folder], {});
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('not committed');
  });

  test('bootstrap runs after the manifest entry, so a second repository is cloned in the same command', () => {
    const base = scratchFolder('madarch-cli-lc-');
    const home = join(base, 'home'); mkdirSync(home, { recursive: true });
    const draft = madeDraft(home);
    const first = sourceRepo(base, 'alpha-source');
    const second = sourceRepo(base, 'beta-source');
    const run = runCommand(['repo', 'add', 'beta', second, '--product', draft.folder], {});
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
