// Tests for the whole-run leftovers check (.shady2k/run-scratch-check.mjs), run
// against throwaway home and temporary folders: what a snapshot holds, what a
// comparison names, and the line a leak is reported on.
//   node --test .shady2k/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { compare, refusals, snapshot, watchedFolders } from './run-scratch-check.mjs';

/** A home and a temporary folder of their own, removed after the test. */
function machine() {
  const base = mkdtempSync(join(tmpdir(), 'madarch-run-scratch-check-'));
  const home = join(base, 'home');
  const temporary = join(base, 'tmp');
  mkdirSync(home);
  mkdirSync(temporary);
  return { base, home, temporary };
}

test('a snapshot holds madarch entries of the temporary folder and the home folders madarch writes', () => {
  const { base, home, temporary } = machine();
  try {
    writeFileSync(join(temporary, 'madarch-test-run-abc123'), ''); // a folder left by a run
    writeFileSync(join(temporary, 'something-else'), ''); // another program's, not watched
    mkdirSync(join(home, 'madarch', 'products'), { recursive: true });
    writeFileSync(join(home, 'madarch', 'products', 'idea-2026-10-18'), '');
    mkdirSync(join(home, '.config', 'madarch'), { recursive: true });
    writeFileSync(join(home, '.config', 'madarch', 'fill-agent.json'), '{}');
    mkdirSync(join(home, '.bun', 'install', 'cache'), { recursive: true });
    writeFileSync(join(home, 'idea-2026-10-18'), ''); // a draft at the top of the home: a leak
    const lines = snapshot(home, temporary);
    assert.deepEqual(lines, [
      `home ${join(home, 'idea-2026-10-18')}`,
      `home-config ${join(home, '.config', 'madarch', 'fill-agent.json')}`,
      `products ${join(home, 'madarch', 'products', 'idea-2026-10-18')}`,
      `temporary ${join(temporary, 'madarch-test-run-abc123')}`,
    ]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('the package manager caches and another program\'s temporary entries are not watched', () => {
  const { base, home, temporary } = machine();
  try {
    mkdirSync(join(home, '.bun'), { recursive: true });
    mkdirSync(join(home, '.cache', 'puppeteer'), { recursive: true });
    mkdirSync(join(home, '.npm'), { recursive: true });
    writeFileSync(join(temporary, 'tmux-1000-default'), '');
    assert.deepEqual(snapshot(home, temporary), []);
    const labels = watchedFolders(home, temporary).map((folder) => folder.label);
    assert.deepEqual(labels, ['temporary', 'home', 'products', 'home-config', 'home-state']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a comparison names every entry that appeared or disappeared, with its full path', () => {
  const before = ['temporary /tmp/madarch-test-run-one'];
  const after = ['temporary /tmp/madarch-test-run-one', 'products /home/you/madarch/products/idea-2026-10-18'];
  const found = compare(before, after);
  assert.deepEqual(found.appeared, ['products /home/you/madarch/products/idea-2026-10-18']);
  assert.deepEqual(found.disappeared, []);
  assert.deepEqual(refusals(found), ['a test run left /home/you/madarch/products/idea-2026-10-18 behind']);
  const gone = compare(after, before);
  assert.deepEqual(refusals(gone), ['a test run removed /home/you/madarch/products/idea-2026-10-18']);
});

test('the command writes a snapshot, and refuses a run that left an entry', () => {
  const { base, home, temporary } = machine();
  const before = join(base, 'before.txt');
  const after = join(base, 'after.txt');
  const cli = new URL('./run-scratch-check.mjs', import.meta.url).pathname;
  try {
    execFileSync(process.execPath, [cli, 'snapshot', before, '--home', home, '--tmp', temporary], { encoding: 'utf8' });
    assert.equal(readFileSync(before, 'utf8'), '');
    writeFileSync(join(temporary, 'madarch-home-guard-left'), '');
    execFileSync(process.execPath, [cli, 'snapshot', after, '--home', home, '--tmp', temporary], { encoding: 'utf8' });
    let failed;
    try {
      execFileSync(process.execPath, [cli, 'compare', before, after, '--home', home, '--tmp', temporary], { encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      failed = error;
    }
    assert.notEqual(failed, undefined);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /a test run left .*madarch-home-guard-left behind/);
    execFileSync(process.execPath, [cli, 'compare', before, before, '--home', home, '--tmp', temporary], { encoding: 'utf8' });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
