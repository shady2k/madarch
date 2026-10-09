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
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'bun:test';
import { readProduct } from '../src/product/manifest.js';

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
};

afterEach(removeMadeFolders);
process.on('exit', removeMadeFolders);


/** Runs a command that ends by itself, the way a person does. */
function runCommand(args: string[], overrides: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync('bun', [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...SEALED_GIT, ...overrides } });
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
  const proc = Bun.spawn([...program, ...args], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, ...SEALED_GIT, ...overrides },
  });
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

/** Today's date, the way the draft's name is folded from it. */
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
