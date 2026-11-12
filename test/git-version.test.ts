/**
 * The git a fill reads (madarch-8bdc.2.5, item 6): 2.40 is the floor — `git check-attr --source` is the newest option
 * the passes use — and a fill on an older git refuses by name before it publishes, stating the version found and the
 * one needed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FILL_GIT_MIN_TEXT, gitVersionRefusal } from '../src/fill/git-version.js';

const PROJECT = join(import.meta.dir, '..');
const ROOT = mkdtempSync(join(tmpdir(), 'madarch-git-version-'));
const HOME = join(ROOT, 'products');
const PRODUCT = join(HOME, 'shop');
const FAKE = join(ROOT, 'fake-git');
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Ada Example', GIT_AUTHOR_EMAIL: 'ada@example.test', GIT_COMMITTER_NAME: 'Ada Example', GIT_COMMITTER_EMAIL: 'ada@example.test', TZ: 'UTC', LC_ALL: 'C' };

beforeAll(() => {
  mkdirSync(join(PRODUCT, 'src'), { recursive: true });
  writeFileSync(join(PRODUCT, 'workspace.yaml'), 'schemaVersion: 1\nid: 8a1c6f2e-4f2b-4b8a-9f7e-1a2b3c4d5e6f\nname: shop\n');
  writeFileSync(join(PRODUCT, 'src', 'order.ts'), 'export function checkout(): number {\n  return 42;\n}\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: PRODUCT, env: GIT_ENV });
  execFileSync('git', ['add', '-A'], { cwd: PRODUCT, env: GIT_ENV });
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'one'], { cwd: PRODUCT, env: GIT_ENV });
  // Contract pinning still reads real commits; only the version probe reports the unsupported git.
  mkdirSync(FAKE, { recursive: true });
  writeFileSync(join(FAKE, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$GIT_CALLS"\necho "git version 2.39.5"\nexit 0\n`);
  chmodSync(join(FAKE, 'git'), 0o755);
}, 120_000);

afterAll(() => { rmSync(ROOT, { recursive: true, force: true }); });

describe('the git version a fill reads', () => {
  test('2.40 is the floor: an older git is refused by name with the version found and the one needed', () => {
    expect(FILL_GIT_MIN_TEXT).toBe('2.40');
    expect(gitVersionRefusal('git version 2.40.0')).toBeUndefined();
    expect(gitVersionRefusal('git version 2.43.0')).toBeUndefined();
    expect(gitVersionRefusal('git version 3.0.0')).toBeUndefined();
    const older = gitVersionRefusal('git version 2.39.5');
    expect(older).toContain('this machine\'s git is 2.39');
    expect(older).toContain('git 2.40');
    expect(older).toContain('check-attr --source');
    expect(gitVersionRefusal('not git at all')).toContain('is no git this fill can read');
  }, 60_000);

  test.each(['fill-stages', 'fill'])('%s on an older git refuses before it publishes, and names both versions', (command) => {
    const calls = join(ROOT, `git-calls-${command}`);
    const home = join(ROOT, `home-${command}`);
    const run = spawnSync(process.execPath, [join(PROJECT, 'scripts', 'madarch.ts'), command, '--product', PRODUCT, '--home', home], {
      cwd: PROJECT,
      env: { ...process.env, PATH: FAKE, GIT_CALLS: calls },
      encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('git 2.40 or newer');
    expect(run.stderr).toContain('2.39.5');
    // Refuse before schema preparation reads a pinned manifest or any repository tree.
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['--version']);
    expect(existsSync(join(home, '.madarch'))).toBe(false);
  }, 300_000);
});
