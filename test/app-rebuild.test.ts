import { chmodSync, existsSync, mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { ensureBuilt, sourcesHash } from '../src/product-wiki/app.js';

/**
 * The wiki app's rebuild decision (the capability product-wiki's
 * requirement `app`, the stale-dist finding madarch-iuc.7.1.1): the dist
 * built by the command records the hash of the app's sources and lockfile,
 * a later start with unchanged sources builds nothing, a changed source is
 * built again with a one-line notice, and a dist with no record (built by
 * hand) is served as it stands. The app folder and the build step are
 * injected, so no test runs bun's real build or a registry.
 */

const scratches: string[] = [];

afterEach(() => {
  while (scratches.length > 0) rmSync(scratches.pop() as string, { recursive: true, force: true });
});

function scratch(prefix = 'app-rebuild-'): string {
  const folder = mkdtempSync(join(tmpdir(), prefix));
  scratches.push(folder);
  return folder;
}

function injectableApp(base: string): string {
  const app = join(base, 'wiki-app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', private: true }, null, 2));
  writeFileSync(join(app, 'bun.lock'), 'lock');
  return app;
}

/** The builder the tests inject: it records that it was called and lays a tiny dist. */
async function injectableBuilder(app: string): Promise<{ command: string; callsFile: string }> {
  const folder = scratch('app-rebuild-builder-');
  const callsFile = join(folder, 'calls.log');
  const command = join(folder, 'build');
  writeFileSync(
    command,
    [
      '#!/bin/sh',
      'echo called >> ' + JSON.stringify(callsFile),
      'mkdir -p ' + JSON.stringify(join(app, 'dist')),
      "echo '<!doctype html><title>built</title>' > " + JSON.stringify(join(app, 'dist', 'index.html')),
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(command, 0o755);
  return { command, callsFile };
}

function sayRecorder(): { lines: string[]; say: (line: string) => void } {
  const lines: string[] = [];
  return { lines, say: (line: string): void => { lines.push(line); } };
}

describe('ensureBuilt: the dist built by the command is compared against its sources', () => {
  test('a fresh app builds once and a second start with the same sources builds nothing', async () => {
    const base = scratch();
    const app = injectableApp(base);
    const builder = await injectableBuilder(app);
    const first = ensureBuilt({ appFolder: app, buildCommand: builder.command });
    expect(first).toEqual({ ok: true, dist: join(app, 'dist'), appFolder: app, built: true });
    const second = ensureBuilt({ appFolder: app, buildCommand: builder.command });
    expect(second).toEqual({ ok: true, dist: join(app, 'dist'), appFolder: app, built: false });
    const calls = await Bun.file(builder.callsFile).text();
    expect(calls.split('\n').filter((line) => line !== '')).toHaveLength(1);
  });

  test('a source changed since the build is built again, with a one-line notice first', async () => {
    const base = scratch();
    const app = injectableApp(base);
    const builder = await injectableBuilder(app);
    expect(ensureBuilt({ appFolder: app, buildCommand: builder.command })).toEqual({ ok: true, dist: join(app, 'dist'), appFolder: app, built: true });
    writeFileSync(join(app, 'src.ts'), 'export const version = 2;\n');
    const recorder = sayRecorder();
    const again = ensureBuilt({ appFolder: app, buildCommand: builder.command }, recorder.say);
    expect(again).toEqual({ ok: true, dist: join(app, 'dist'), appFolder: app, built: true });
    expect(recorder.lines[0]).toContain('rebuilding the wiki app');
    expect(recorder.lines[0]).toContain(app);
    const calls = await Bun.file(builder.callsFile).text();
    expect(calls.split('\n').filter((line) => line !== '')).toHaveLength(2);
    // The stamp the rebuild lays names the current sources, so the next start stands.
    expect(await Bun.file(join(app, 'dist', '.sources-hash')).text()).toBe(sourcesHash(app));
  });

  test('a lockfile change counts as a source change', async () => {
    const base = scratch();
    const app = injectableApp(base);
    const builder = await injectableBuilder(app);
    expect(ensureBuilt({ appFolder: app, buildCommand: builder.command })).toEqual({ ok: true, dist: join(app, 'dist'), appFolder: app, built: true });
    writeFileSync(join(app, 'bun.lock'), 'lock v2\n');
    const again = ensureBuilt({ appFolder: app, buildCommand: builder.command });
    expect(again.ok === true && again.built).toBe(true);
  });

  test('a dist with no hash record (built by hand) is served as it stands', async () => {
    const base = scratch();
    const app = injectableApp(base);
    mkdirSync(join(app, 'dist'), { recursive: true });
    writeFileSync(join(app, 'dist', 'index.html'), '<!doctype html><title>hand-built</title>');
    const builder = await injectableBuilder(app);
    const run = ensureBuilt({ appFolder: app, buildCommand: builder.command });
    expect(run).toEqual({ ok: true, dist: join(app, 'dist'), appFolder: app, built: false });
    expect(existsSync(builder.callsFile)).toBe(false);
  });
});

describe('ensureBuilt: the sources hash and its scope', () => {
  test("the hash takes the sources' paths and a change in one subfolder into account the same way", () => {
    const base = scratch();
    const app = injectableApp(base);
    mkdirSync(join(app, 'src'), { recursive: true });
    writeFileSync(join(app, 'src', 'page.ts'), 'export const x = 1;\n');
    const withPage = sourcesHash(app);
    writeFileSync(join(app, 'src', 'other.ts'), 'export const x = 1;\n');
    const withTwo = sourcesHash(app);
    expect(withTwo).not.toBe(withPage);
    // The relative paths differ, the contents do not: a hash that left paths out would equal.
    writeFileSync(join(app, 'src', 'page.ts'), 'export const x = 2;\n');
    expect(sourcesHash(app)).not.toBe(withPage);
    expect(sourcesHash(app)).not.toBe(withTwo);
  });

  test('what the build lays is not sources: dist, node_modules and .git stay out of the hash', async () => {
    const base = scratch();
    const app = injectableApp(base);
    mkdirSync(join(app, 'src'), { recursive: true });
    writeFileSync(join(app, 'src', 'page.ts'), 'export const x = 1;\n');
    mkdirSync(join(app, 'dist'), { recursive: true });
    mkdirSync(join(app, 'node_modules', 'left-pad'), { recursive: true });
    mkdirSync(join(app, '.git'), { recursive: true });
    const before = sourcesHash(app);
    writeFileSync(join(app, 'node_modules', 'left-pad', 'index.js'), 'noise\n');
    writeFileSync(join(app, '.git', 'config'), 'noise\n');
    expect(sourcesHash(app)).toBe(before);
    const builder = await injectableBuilder(app);
    const built = ensureBuilt({ appFolder: app, buildCommand: builder.command });
    expect(built).toEqual({ ok: true, dist: join(app, 'dist'), appFolder: app, built: true });
    // Rebuilding again with the same sources stands: the laid dist does not count as a change.
    expect(ensureBuilt({ appFolder: app, buildCommand: builder.command })).toEqual({ ok: true, dist: join(app, 'dist'), appFolder: app, built: false });
    const calls = await Bun.file(builder.callsFile).text();
    expect(calls.split('\n').filter((line) => line !== '')).toHaveLength(1);
  });

  // Sample note (Stryker 9.6.1, config stryker.conf.json, src/product-wiki/app.ts:59-81
  // against this file): one survivor, the `entry.isFile()` conditional in the walker's else-if (line 62),
  // is equivalent — that branch runs only after `entry.isDirectory()` is false, so `true` and `isFile()`
  // decide the same way for every entry the branch can see.
  test('the hash is stable when the app folder moves: only the relative paths are hashed', () => {
    const base = scratch();
    const app = injectableApp(base);
    mkdirSync(join(app, 'src'), { recursive: true });
    writeFileSync(join(app, 'src', 'page.ts'), 'export const x = 1;\n');
    const before = sourcesHash(app);
    // The same sources under a different absolute path hash the same: the
    // hash is of the paths within the app, so a stamp recorded by one
    // checkout still matches after the folder is moved or renamed.
    const moved = join(dirname(app), 'wiki-app-moved');
    renameSync(app, moved);
    expect(sourcesHash(moved)).toBe(before);
    // And two files swapping their contents still change it: the path is
    // hashed beside the content, not instead of it.
    writeFileSync(join(moved, 'src', 'page.ts'), 'export const x = 2;\n');
    expect(sourcesHash(moved)).not.toBe(before);
  });
});

describe('ensureBuilt: the app folder it decides from', () => {
  function prebuilt(app: string): string {
    mkdirSync(join(app, 'dist'), { recursive: true });
    writeFileSync(join(app, 'dist', 'index.html'), '<!doctype html>');
    return app;
  }

  test('MADARCH_APP in the environment decides over the checkout default, in place of a named folder', () => {
    const base = scratch();
    const app = prebuilt(injectableApp(base));
    mkdirSync(join(app, 'dist'), { recursive: true });
    const run = ensureBuilt({ env: { MADARCH_APP: app } });
    expect(run).toEqual({ ok: true, dist: join(app, 'dist'), appFolder: app, built: false });
  });

  test('a named app folder of only spaces counts as unset, the next answer decides', () => {
    const base = scratch();
    const app = prebuilt(injectableApp(base));
    const runFromEnv = ensureBuilt({ appFolder: '   ', env: { MADARCH_APP: app } });
    if (!runFromEnv.ok) throw new Error(runFromEnv.message);
    expect(runFromEnv.appFolder).toBe(app);
    // the process env carries no MADARCH_APP here: a chain-less read of it would throw, and the flow answers
    const unsetEnv = ensureBuilt({ appFolder: app, env: {} });
    if (!unsetEnv.ok) throw new Error(unsetEnv.message);
    expect(unsetEnv.appFolder).toBe(app);
  });

  test('an environment with no MADARCH_APP leaves the chain whole: the option decides', () => {
    const base = scratch();
    const app = prebuilt(injectableApp(base));
    const run = ensureBuilt({ appFolder: app, env: {} });
    if (!run.ok) throw new Error(run.message);
    expect(run.appFolder).toBe(app);
  });

  test('an env value that is only spaces counts as unset too, and never builds the checkout', () => {
    const base = scratch();
    const app = prebuilt(injectableApp(base));
    const run = ensureBuilt({ appFolder: app, env: { MADARCH_APP: '   ' } });
    if (!run.ok) throw new Error(run.message);
    expect(run.appFolder).toBe(app);
    // only spaces in the env with no folder above: the trim decides the folder — a mutant that keeps the
    // spaces names it in the answer's folder, never the checkout's own app folder.
    const built = ensureBuilt({ env: { MADARCH_APP: '   ' } });
    if (!built.ok) throw new Error(built.message);
    expect(built.appFolder).not.toBe('   ');
  });
});
