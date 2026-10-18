/**
 * What a test file gets from the run's preload (madarch-1xq), written the way
 * a test that knows nothing about isolation writes: to the home it resolves,
 * to the system temporary folder, to the products home and to the wiki cache,
 * making none of its own folders removable. `test/run-scratch.test.ts` runs it
 * as a child `bun test` and checks the paths it printed and that its scratch
 * folder is gone afterwards, pass or fail. Nothing here is collected by a
 * suite run: the name carries no test pattern, so only the explicit path runs it.
 */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from 'bun:test';
import { productsHome } from '../../../src/product/draft.js';
import { wikiCacheRoot } from '../../../src/wiki/cache.js';

/** The paths this fixture wrote, printed one per line for the test that runs it. */
function report(kind: string, path: string): void {
  console.log(`path: ${kind} ${path}`);
}

test('a test that redirects nothing writes inside the run scratch folder', () => {
  const scratch = process.env.MADARCH_TEST_SCRATCH;
  expect(typeof scratch).toBe('string');
  const folder = scratch!;
  report('scratch', folder);
  const inside = (name: string, path: string): string => {
    if (path !== folder && !path.startsWith(`${folder}/`)) throw new Error(`${name} is ${path}, not inside the run's scratch folder ${folder}`);
    return path;
  };
  inside('HOME', process.env.HOME ?? '');
  inside('MADARCH_HOME', process.env.MADARCH_HOME ?? '');
  inside('TMPDIR', process.env.TMPDIR ?? '');
  inside('MADARCH_WIKI_CACHE', process.env.MADARCH_WIKI_CACHE ?? '');
  // The home as this process resolves it. Bun fixes `homedir()` when the
  // process starts, so it is the HOME this run was given — this run's own for
  // a run a person starts, the parent run's for a run a test starts — and never
  // something a preload can move afterwards. The write below goes through the
  // environment's home, which is the run's own in both cases.
  console.log(`note: homedir ${homedir()}`);

  const homeFile = join(process.env.HOME ?? homedir(), '.config', 'madarch', 'fixture.json');
  mkdirSync(dirname(homeFile), { recursive: true });
  writeFileSync(homeFile, '{"wrote":"the home"}\n');
  report('home', homeFile);

  const temporary = mkdtempSync(join(tmpdir(), 'madarch-run-scratch-fixture-'));
  writeFileSync(join(temporary, 'wrote.md'), '# A test that redirected nothing\n');
  report('temporary', temporary);

  const products = productsHome(process.env);
  mkdirSync(products, { recursive: true });
  writeFileSync(join(products, 'draft.txt'), 'a draft no test meant to keep\n');
  report('products', products);

  const cache = wikiCacheRoot(process.env);
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  writeFileSync(join(cache, 'page.html'), '<!doctype html>\n');
  report('cache', cache);

  // The folders the madarch-1xq evidence found unwritable in leftovers: the
  // run must still remove them when it ends.
  const locked = join(temporary, 'locked');
  mkdirSync(join(locked, 'deep', 'deeper'), { recursive: true });
  writeFileSync(join(locked, 'deep', 'deeper', 'leaf.md'), '# Leaf\n');
  writeFileSync(join(locked, 'secret.md'), '# Secret\n');
  chmodSync(join(locked, 'deep', 'deeper'), 0o500);
  chmodSync(join(locked, 'deep'), 0o000);
  chmodSync(join(locked, 'secret.md'), 0o000);
  chmodSync(locked, 0o500);
  report('locked', locked);

  if (process.env.MADARCH_SCRATCH_FIXTURE_FAIL === '1') throw new Error('this fixture failed after writing, as the failing run is meant to');
});
