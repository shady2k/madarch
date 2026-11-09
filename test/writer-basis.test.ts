/** The basis a page records (madarch-m38l.8): commit, branch and origin read from git, and no credentials in a committed file. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { gitReader } from '../src/knowledge/index/grounds.js';
import { withoutCredentials, writtenAtOf } from '../src/writer/basis.js';
import { gitEnv } from './git-env.js';

let scratch: string;
let repository: string;
const git = (...args: string[]): string => execFileSync('git', args, { cwd: repository, encoding: 'utf8', env: gitEnv({ GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'f@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'f@example.test' }) }).trim();

beforeAll(() => {
  scratch = mkdtempSync(path.join(tmpdir(), 'madarch-basis-'));
  repository = path.join(scratch, 'shop');
  mkdirSync(repository);
  git('init', '-q', '-b', 'trunk');
  writeFileSync(path.join(repository, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('withoutCredentials', () => {
  test('drops the user and the password of a web or ssh URL, even a password that holds an @', () => {
    expect(withoutCredentials('https://user:secret@github.com/acme/shop.git')).toBe('https://github.com/acme/shop.git');
    expect(withoutCredentials('https://user:p@ss@github.com/acme/shop.git')).toBe('https://github.com/acme/shop.git');
    expect(withoutCredentials('ssh://git@github.com:22/acme/shop.git')).toBe('ssh://github.com:22/acme/shop.git');
    expect(withoutCredentials('git@github.com:acme/shop.git')).toBe('git@github.com:acme/shop.git');
    expect(withoutCredentials('https://github.com/acme/shop')).toBe('https://github.com/acme/shop');
  });
});

describe('writtenAtOf', () => {
  test('a repository with no origin records its commit and branch only', async () => {
    expect(await writtenAtOf(repository, 'HEAD')).toEqual({ repository: 'shop', commit: git('rev-parse', 'HEAD'), branch: 'trunk' });
  });

  test('the origin is recorded without its credentials, and the name the product gave', async () => {
    git('remote', 'add', 'origin', 'https://user:p@ss@github.com/acme/shop.git');
    const basis = await writtenAtOf(repository, 'HEAD', 'services');
    expect(basis).toEqual({ repository: 'services', commit: git('rev-parse', 'HEAD'), branch: 'trunk', origin: 'https://github.com/acme/shop.git' });
    expect(JSON.stringify(basis)).not.toContain('ss@');
  });

  test('a detached head records no branch, and a commit that is not there is an error naming the repository', async () => {
    const head = git('rev-parse', 'HEAD');
    expect((await writtenAtOf(repository, head)).commit).toBe(head);
    git('checkout', '-q', '--detach');
    expect('branch' in (await writtenAtOf(repository, 'HEAD'))).toBe(false);
    let message = '';
    try { await writtenAtOf(repository, 'no-such-ref'); } catch (error) { message = (error as Error).message; }
    expect(message).toContain(repository);
    expect(message).toContain('no-such-ref');
  });
});

describe('gitReader', () => {
  test('a path that is not there is absent (null), not an error, for text and for object ids', async () => {
    const reader = gitReader(repository);
    const head = git('rev-parse', 'HEAD');
    expect(await reader.objectId(head, 'a.txt')).toMatch(/^[0-9a-f]{40}$/);
    expect(await reader.objectId(head, 'missing/path.ts')).toBeNull();
    expect(await reader.text(head, 'missing/path.ts')).toBeNull();
    expect(await reader.text(head, 'a.txt')).toBe('a\n');
    expect(await reader.objectId('0000000000000000000000000000000000000000', 'a.txt')).toBeNull();
  });
});
