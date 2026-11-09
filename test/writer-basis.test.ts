/** The basis a page records (madarch-m38l.8): what a ground read from git holds at a commit. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { gitReader } from '../src/knowledge/index/grounds.js';
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
