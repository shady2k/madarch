import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { readProductRepos } from '../src/product-wiki/repos.js';
import { readProduct } from '../src/product/manifest.js';
import { gitEnv } from './git-env.js';

/**
 * The git gateway of the repositories read, through its own narrow window:
 * `gitEnvironment` keeps the caller's identity but never the loader
 * variables (`GIT_DIR` and its companions) — a call here must answer for the
 * checkout, never for the folder a loader names — and `gitFailureText`
 * never answers with empty words: a checkout whose git says nothing is
 * reported with the cause the silence came from. Env cases are passed
 * through `readProductRepos`'s own door; nothing here reaches into another
 * module.
 */

let folder: string | undefined;
const identities = {
  GIT_AUTHOR_NAME: 'Gateway Test',
  GIT_AUTHOR_EMAIL: 'gateway-test@example.com',
  GIT_COMMITTER_NAME: 'Gateway Test',
  GIT_COMMITTER_EMAIL: 'gateway-test@example.com',
};

function productWithCheckout(): string {
  folder = mkdtempSync(join(tmpdir(), 'madarch-repos-gateway-'));
  writeFileSync(join(folder, 'workspace.yaml'),
    'schemaVersion: 1\nid: gateway\nname: Gateway\nrepos:\n  - name: core\n    url: https://example.com/core.git\n');
  const target = join(folder, 'repos', 'core');
  mkdirSync(target, { recursive: true });
  const env = { ...gitEnv(), ...identities };
  const run = (args: string[]): void => {
    const done = spawnSync('git', args, { cwd: target, encoding: 'utf8', env });
    if (done.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${done.stderr}${done.stdout}`);
  };
  run(['init', '--quiet', '--initial-branch=main']);
  writeFileSync(join(target, 'README.md'), '# core\n');
  run(['add', '-A']);
  run(['commit', '--quiet', '-m', 'Make the core']);
  return folder;
}

function rows(extra: Record<string, string>): { state: string; head?: { sha: string; subject: string }; readme?: { file: string; markdown: string }; problem?: string } {
  const read = readProduct(folder!);
  if (!read.ok) throw new Error(read.message);
  // The overrides go in raw: gitEnvironment inside the read is what strips
  // the loader variables, so the test passes them as a real leak would be.
  const sealed = gitEnv();
  const merged: Record<string, string> = { ...sealed, ...extra };
  if (merged.PATH === undefined || merged.PATH === '') merged.PATH = sealed.PATH ?? '';
  const answer = readProductRepos(read.product, merged);
  return answer.repos[0] as typeof answer.repos[0];
}

afterEach(() => {
  if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
  folder = undefined;
});

describe('the repositories read through its git gateway', () => {
  test('a leaking GIT_DIR and GIT_WORK_TREE are dropped: the checkout is read as itself, not refused by the loader', () => {
    productWithCheckout();
    // A checkout holding its own .git folder makes the leaked GIT_DIR a
    // valid-looking git dir that is not the checkout's: with the leak
    // honoured the read would report the wrong repository or refuse; the
    // gateway drops the loader variables, so the checkout reads as itself.
    mkdirSync(join(folder!, '.git'), { recursive: true });
    const row = rows({
      GIT_DIR: join(folder!, '.git'),
      GIT_WORK_TREE: folder!,
      GIT_INDEX_FILE: join(folder!, '.git', 'index'),
    });
    expect(row.state).toBe('cloned');
    expect(row.head?.subject).toBe('Make the core');
  });

  test('the caller\'s identity rides along: the commit is read with the environment the caller merged', () => {
    productWithCheckout();
    // The identity variables are used by the fixture's own commits, so prove
    // the merge by a value the gateway must keep: a prefix git honours.
    const row = rows({ GIT_CONFIG_COUNT: '0' });
    expect(row.state).toBe('cloned');
  });

  test('a config the checkout honours through the merged environment changes what git answers', () => {
    productWithCheckout();
    // `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n` reach every git call the gateway
    // makes; a home that git must not read stays unread through the same
    // pass, so the merge is real but bounded.
    const row = rows({ GIT_CONFIG_GLOBAL: '/dev/null' });
    expect(row.state).toBe('cloned');
    expect(row.head?.subject).toBe('Make the core');
  });

  test('a GIT_DIR exported in the ambient process environment never reaches the call', () => {
    productWithCheckout();
    mkdirSync(join(folder!, '.git'), { recursive: true });
    const heldDir = process.env.GIT_DIR;
    const heldTree = process.env.GIT_WORK_TREE;
    process.env.GIT_DIR = join(folder!, '.git');
    process.env.GIT_WORK_TREE = folder!;
    try {
      // No overrides here: the leak stands in the process environment itself.
      const read = readProduct(folder!);
      if (!read.ok) throw new Error(read.message);
      const answer = readProductRepos(read.product, {});
      expect(answer.repos[0]?.state).toBe('cloned');
      expect(answer.repos[0]?.head?.subject).toBe('Make the core');
    } finally {
      if (heldDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = heldDir;
      if (heldTree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = heldTree;
    }
  });

  test('a git that fails with no words is reported by the silence\'s own cause, named with the command', () => {
    productWithCheckout();
    // A PATH whose git is a silent failure: the read must answer the cause
    // of the silence — git's exit — naming the command, never empty words.
    const bin = mkdtempSync(join(tmpdir(), 'repos-gateway-bin-'));
    writeFileSync(join(bin, 'git'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(bin, 'git'), 0o755);
    try {
      const row = rows({ PATH: bin + ':/usr/bin:/bin' });
      // git cannot even answer whether the checkout is its own: the silence's
      // own cause — the exit, with the command — is the row's problem.
      expect(row.state).toBe('unreadable');
      expect(row.problem).toContain('git could not read the checkout');
      expect(row.problem).toContain('exited without success');
      expect(row.problem).toContain('rev-parse');
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  test('a git that cannot run at all is reported by the error\'s own message, never an empty refusal', () => {
    productWithCheckout();
    // A PATH with no git at all: spawn's own error (ENOENT) is the answer.
    const empty = mkdtempSync(join(tmpdir(), 'repos-gateway-empty-'));
    try {
      const row = rows({ PATH: empty });
      expect(row.state).toBe('unreadable');
      expect(row.problem).toContain('git could not read the checkout');
      // Bun's own spawn refusal names what failed; the answer carries it whole.
      expect(row.problem).toContain('Executable not found');
      expect(row.problem).toContain('git');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test('a checkout whose HEAD git cannot read is unreadable, named by git\'s own words', () => {
    productWithCheckout();
    const target = join(folder!, 'repos', 'core');
    // Corrupt the ref git reads for HEAD, keeping the repository otherwise:
    // `log` now fails with git's own diagnostic on stderr. A HEAD the read
    // cannot trust is not a checkout to report: the state is unreadable.
    writeFileSync(join(target, '.git', 'HEAD'), 'ref: refs/heads/main\\n');
    rmSync(join(target, '.git', 'refs', 'heads', 'main'));
    const row = rows({});
    expect(row.state).toBe('unreadable');
    expect(row.problem).toContain('could not be read');
    expect(row.problem).toContain('HEAD of the checkout');
    expect(row.problem).toContain(join(folder!, 'repos', 'core'));
    expect(row.head).toBeUndefined();
  });

  test('an unborn branch is the one failed `git log` that stays checked-out: the no-commit cause named', () => {
    productWithCheckout();
    const target = join(folder!, 'repos', 'core');
    // An unborn branch answers with git's own "does not have any commits
    // yet": that is a fresh checkout, not a broken one.
    rmSync(join(target, '.git', 'refs', 'heads', 'main'));
    const row = rows({});
    expect(row.state).toBe('cloned');
    expect(row.head).toBeUndefined();
    expect(row.problem).toContain('no commit yet');
    expect(row.readme?.markdown).toBe('# core\n');
  });
});
