/**
 * The lock one graph folder takes (madarch-ztyq.10 review): taken atomically, so
 * two processes that start together against an empty cache cannot both open the
 * same PGlite directory, and held until the database is closed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { acquireFolderLock, openRepositoryGraph, releaseFolderLock } from '../src/mcp/graph.js';

const FOLDER = mkdtempSync(path.join(tmpdir(), 'madarch-mcp-lock-'));
const REPOSITORY = mkdtempSync(path.join(tmpdir(), 'madarch-mcp-lock-repo-'));
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Ada Example', GIT_AUTHOR_EMAIL: 'ada@example.test', GIT_COMMITTER_NAME: 'Ada Example', GIT_COMMITTER_EMAIL: 'ada@example.test', TZ: 'UTC', LC_ALL: 'C' };

mkdirSync(path.join(REPOSITORY, 'src'), { recursive: true });
writeFileSync(path.join(REPOSITORY, 'package.json'), `${JSON.stringify({ name: 'lock-kit', version: '1.0.0', type: 'module' }, null, 2)}\n`, 'utf8');
writeFileSync(path.join(REPOSITORY, 'src/a.ts'), '/** One. */\nexport function one(): number {\n  return 1;\n}\n', 'utf8');
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: REPOSITORY, env: GIT_ENV });
execFileSync('git', ['add', '-A'], { cwd: REPOSITORY, env: GIT_ENV });
execFileSync('git', ['commit', '-q', '-m', 'lock-kit: one function'], { cwd: REPOSITORY, env: GIT_ENV });

afterAll(() => {
  rmSync(FOLDER, { recursive: true, force: true });
  rmSync(REPOSITORY, { recursive: true, force: true });
});

describe('the folder lock', () => {
  test('two acquisitions of one folder: the first holds it, the second is refused by name', () => {
    const held = acquireFolderLock(FOLDER);
    expect(held.pid).toBe(process.pid);
    expect(() => acquireFolderLock(FOLDER)).toThrow(/server\.lock/);
    expect(() => acquireFolderLock(FOLDER)).toThrow(/already served/);
    releaseFolderLock(FOLDER, held);
    const again = acquireFolderLock(FOLDER);
    releaseFolderLock(FOLDER, again);
  });

  test('the lock outlives the database it guards: it is dropped only once the database is closed', async () => {
    const folder = path.join(FOLDER, 'served');
    const graph = await openRepositoryGraph({ repository: REPOSITORY, folder, log: () => undefined });
    expect(existsSync(path.join(folder, 'server.lock'))).toBe(true);
    const closing = graph.close();
    // Closing begins with the database: the lock is still the server's while that runs, so no second server can enter
    // a folder whose database is mid-close.
    expect(existsSync(path.join(folder, 'server.lock'))).toBe(true);
    await closing;
    expect(existsSync(path.join(folder, 'server.lock'))).toBe(false);
    const taken = acquireFolderLock(folder);
    releaseFolderLock(folder, taken);
  }, 120_000);
});
