import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { prepareDemo } from '../src/product/demo.js';

let root: string | undefined;
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Demo fixture',
  GIT_AUTHOR_EMAIL: 'demo-fixture@example.com',
  GIT_COMMITTER_NAME: 'Demo fixture',
  GIT_COMMITTER_EMAIL: 'demo-fixture@example.com',
};
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}${result.stdout}`);
  return result.stdout.trim();
}
function fixture(): { home: string; origin: string; source: string } {
  root = mkdtempSync(join(tmpdir(), 'madarch-demo-test-'));
  const source = join(root, 'source');
  const origin = join(root, 'origin.git');
  mkdirSync(source);
  git(root, 'init', '--bare', '--initial-branch=main', origin);
  git(source, 'init', '--initial-branch=main');
  writeFileSync(join(source, 'workspace.yaml'), 'schemaVersion: 1\nid: demo-product\nname: Demo Product\n');
  writeFileSync(join(source, 'README.md'), 'first version\n');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'first');
  git(source, 'remote', 'add', 'origin', origin);
  git(source, 'push', '-u', 'origin', 'main');
  return { home: join(root, 'home'), origin, source };
}
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

describe('madarch demo repository lifecycle', () => {
  test('clones once and fast-forwards the existing clone on the next run', () => {
    const f = fixture();
    const first = prepareDemo({ url: f.origin, home: f.home, env: {} });
    expect(first).toEqual({ ok: true, folder: join(f.home, 'madarch-product'), updated: false });
    appendFileSync(join(f.source, 'README.md'), 'second version\n');
    git(f.source, 'add', 'README.md');
    git(f.source, 'commit', '-m', 'second');
    git(f.source, 'push');
    const second = prepareDemo({ url: f.origin, home: f.home, env: {} });
    expect(second).toEqual({ ok: true, folder: join(f.home, 'madarch-product'), updated: true });
    expect(git(join(f.home, 'madarch-product'), 'log', '-1', '--format=%s')).toBe('second');
  });

  test('explains that an update failure leaves a divergent clone unchanged', () => {
    const f = fixture();
    const cloned = prepareDemo({ url: f.origin, home: f.home, env: {} });
    if (cloned.ok !== true) throw new Error('the fixture repository must clone');
    appendFileSync(join(cloned.folder, 'README.md'), 'local change\n');
    git(cloned.folder, 'add', 'README.md');
    git(cloned.folder, 'commit', '-m', 'local change');
    appendFileSync(join(f.source, 'README.md'), 'upstream change\n');
    git(f.source, 'add', 'README.md');
    git(f.source, 'commit', '-m', 'upstream change');
    git(f.source, 'push');
    const result = prepareDemo({ url: f.origin, home: f.home, env: {} });
    if (result.ok === true) throw new Error('a divergent clone must not be updated');
    expect(result.message).toContain('update');
    expect(result.message).toContain('product working tree remains unchanged');
    expect(result.message).toContain('network');
    expect(git(cloned.folder, 'log', '-1', '--format=%s')).toBe('local change');
  });

  test('reports Git clone failure and offers the offline next step', () => {
    const f = fixture();
    const result = prepareDemo({ url: join(root!, 'missing.git'), home: f.home, env: {} });
    expect(result.ok).toBe(false);
    if (result.ok === true) throw new Error('an unreachable repository must be refused');
    expect(result.message).toContain('git clone failed');
    expect(result.message).toContain('network');
    expect(result.message).toContain('madarch new');
    expect(result.message).not.toContain('could not reach the network');
    expect(readdirSync(f.home)).toEqual([]);
  });

  test('does not overwrite an unrelated folder with the demo name', () => {
    const f = fixture();
    mkdirSync(join(f.home, 'madarch-product'), { recursive: true });
    writeFileSync(join(f.home, 'madarch-product', 'keep.txt'), 'keep');
    const result = prepareDemo({ url: f.origin, home: f.home, env: {} });
    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error('an unrelated folder must be refused');
    expect(result.message).toContain('left unchanged');
  });
});
