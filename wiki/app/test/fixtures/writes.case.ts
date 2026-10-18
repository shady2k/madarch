/**
 * What a test file of the wiki app gets from the run's preload (madarch-1xq):
 * a test that redirects nothing writes into the run's scratch folder and
 * leaves a folder unwritable, and the run still removes it.
 * `test/run-scratch.test.ts` runs this file as a child `bun test`; nothing
 * collects it, the name carrying no test pattern.
 */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from 'bun:test';

test('a test that redirects nothing writes inside the run scratch folder', () => {
  const folder = process.env.MADARCH_TEST_SCRATCH;
  if (folder === undefined || folder === '') throw new Error(`MADARCH_TEST_SCRATCH is not set: the app's preload did not run (HOME is ${process.env.HOME}, TMPDIR is ${process.env.TMPDIR})`);
  const inside = (name: string, path: string): string => {
    if (path !== folder && !path.startsWith(`${folder}/`)) throw new Error(`${name} is ${path}, not inside the run's scratch folder ${folder}`);
    return path;
  };
  for (const name of ['HOME', 'MADARCH_HOME', 'TMPDIR', 'MADARCH_WIKI_CACHE']) inside(name, process.env[name] ?? '');
  console.log(`path: scratch ${folder}`);
  const homeFile = join(process.env.HOME ?? '', '.cache', 'madarch-app', 'fixture.json');
  mkdirSync(dirname(homeFile), { recursive: true });
  writeFileSync(homeFile, '{"wrote":"the home"}\n');
  console.log(`path: home ${homeFile}`);
  const temporary = mkdtempSync(join(tmpdir(), 'madarch-app-fixture-'));
  console.log(`path: temporary ${temporary}`);
  // The folder the madarch-1xq evidence found in leftovers: the run must still
  // remove it when it ends.
  const locked = join(temporary, 'locked');
  mkdirSync(join(locked, 'deep', 'deeper'), { recursive: true });
  writeFileSync(join(locked, 'deep', 'deeper', 'leaf.md'), '# Leaf\n');
  chmodSync(join(locked, 'deep'), 0o000);
  chmodSync(locked, 0o500);
  console.log(`path: locked ${locked}`);
  expect(folder).toBeString();
});
