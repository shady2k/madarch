/**
 * The `madarch` command's `new` subcommand (docs/changes/draft-product/
 * capabilities/product-repository.md, requirement draft): the library
 * `createDraft` does the work; the command parses, prints and decides the
 * exit code — 0 created, 2 an argument or the products home cannot be
 * used, 1 a step of the repository's creation failed. Every test runs the
 * command as a child process, the way a person runs it, with the products
 * home at a scratch folder; no test writes into a real home, and no test
 * starts a server.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'bun:test';
import { readProduct } from '../src/product/manifest.js';

const CLI = fileURLToPath(new URL('../scripts/madarch.ts', import.meta.url));

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
};

afterEach(removeMadeFolders);
process.on('exit', removeMadeFolders);

/** Runs the command the way a person does, as a child process that ends by itself. */
function runCommand(args: string[], overrides: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync('bun', [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...SEALED_GIT, ...overrides } });
  return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
}

/** Today's date, the way the draft's name is folded from it. */
function todayName(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** The two facts the command prints on a created draft, from its stdout. */
function printedFacts(stdout: string): { folder: string; id: string } {
  const lines = stdout.split('\n').filter((line) => line !== '');
  expect(lines).toHaveLength(2);
  return { folder: lines[0]!.slice('folder: '.length), id: lines[1]!.slice('id: '.length) };
}

describe('madarch new', () => {
  test('creates the draft under MADARCH_HOME and prints its folder and its id, one fact per line', () => {
    const home = scratchFolder();
    const { status, stdout, stderr } = runCommand(['new'], { MADARCH_HOME: home });
    expect(stderr).toBe('');
    expect(status).toBe(0);
    const { folder, id } = printedFacts(stdout);
    expect(folder).toBe(join(home, 'products', `idea-${todayName()}`));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(statSync(folder).isDirectory()).toBe(true);
    expect(statSync(join(folder, '.git')).isDirectory()).toBe(true);
    // The id the manifest holds is the one the command printed.
    const read = readProduct(folder);
    expect(read).toMatchObject({ ok: true, product: { id, name: `idea-${todayName()}`, schemaVersion: 1 } });
  });

  test("--home moves this one command's products home, over MADARCH_HOME", () => {
    const madarchHome = scratchFolder();
    const home = scratchFolder('madarch-cli-elsewhere-');
    const { status, stdout } = runCommand(['new', '--home', home], { MADARCH_HOME: madarchHome });
    expect(status).toBe(0);
    const { folder } = printedFacts(stdout);
    expect(folder).toBe(join(home, `idea-${todayName()}`));
    expect(statSync(folder).isDirectory()).toBe(true);
    // And MADARCH_HOME holds nothing: nothing was written there.
    expect(readdirSync(madarchHome)).toEqual([]);
  });

  test('--home=FOLDER names the home in one word, the way the other commands parse it', () => {
    const home = scratchFolder();
    const { status, stdout } = runCommand(['new', `--home=${home}`], {});
    expect(status).toBe(0);
    const { folder } = printedFacts(stdout);
    expect(folder).toBe(join(home, `idea-${todayName()}`));
  });

  test('a second new the same day makes -2, with its own id', () => {
    const home = scratchFolder();
    const first = printedFacts(runCommand(['new'], { MADARCH_HOME: home }).stdout);
    const second = printedFacts(runCommand(['new'], { MADARCH_HOME: home }).stdout);
    expect(second.folder).toBe(`${first.folder}-2`);
    expect(second.id).not.toBe(first.id);
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
    const script = ['#!/bin/sh', 'if [ "$1" = "commit" ]; then', "  echo 'stub: refusing to commit' >&2; exit 1; fi", 'exec /run/current-system/sw/bin/git "$@"', ''].join('\n');
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
