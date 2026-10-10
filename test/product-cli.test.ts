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
import { cpSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'bun:test';
import { readProduct } from '../src/product/manifest.js';
import { createDraft } from '../src/product/draft.js';
import { listProducts } from '../src/product/list.js';
import { gitEnv } from './git-env.js';
import { GIT_IDENTITY, GIT_ENV } from './model-check-repo.js';
import { homeOfCommand, noStrayDrafts, sealedHome } from './scratch-home.js';

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
  if (strays.leftAlone.length) throw new Error(`the tests left what they cannot own in the real products home, untouched: ${strays.leftAlone.join(', ')}`);
  if (strays.removed.length) throw new Error(`the tests left stray drafts in the real products home (removed): ${strays.removed.join(', ')}`);
};

afterEach(removeMadeFolders);
process.on('exit', removeMadeFolders);


/** Runs a command that ends by itself, the way a person does. */
function runCommand(args: string[], overrides: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env, ...SEALED_GIT, ...SEALED_CLOCK, ...sealedHome(overrides), ...overrides };
  // A creator must aim at a scratch home before anything is spawned: the
  // arguments, then MADARCH_HOME — the resolved home is refused otherwise.
  if (args[0] === 'new' || args[0] === 'list') homeOfCommand(args, env);
  const run = spawnSync('bun', [CLI, ...args], { encoding: 'utf8', env });
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
      '  list    name the products the products home holds',
      '  --home <folder>       new and list: the products home of this one command, over MADARCH_HOME',
      '                        (without either, ~/madarch/products)',
      '  --product <folder>    serve only: the product folder to serve; the current folder when absent',
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
    const run = spawnSync(CLI, ['--help'], { encoding: 'utf8' });
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
  });
});
