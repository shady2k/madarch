#!/usr/bin/env bun
/**
 * `scripts/run-tests.ts` reads `test/slow-files.json` and runs everything else by
 * default (`bun run test`), or only the listed files (`bun run test:slow`). The
 * shard flag is bun's own, so the runner passes the selected files through and
 * forwards `--shard=i/n` unchanged.
 *
 * This test runs the runner on a fixture tree with a stand-in `bun` on PATH, so
 * it proves which files the runner chooses and what it forwards without running
 * any of them.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';

const RUNNER = join(import.meta.dir, '..', 'scripts', 'run-tests.ts');

const fixture = mkdtempSync(join(tmpdir(), 'madarch-run-tests-'));
const bin = join(fixture, 'bin');
const argsLog = join(fixture, 'bun-args.log');
mkdirSync(join(fixture, 'test'), { recursive: true });
mkdirSync(bin, { recursive: true });
for (const name of ['a', 'b', 'c']) {
  writeFileSync(join(fixture, 'test', `${name}.test.ts`), `import { test } from 'bun:test';\ntest('${name}', () => {});\n`);
}
writeFileSync(join(fixture, 'test', 'slow-files.json'), JSON.stringify({
  version: 1,
  measuredOn: '2026-11-18',
  files: [{ path: 'test/c.test.ts', seconds: 31, reason: 'green-slow', result: 'green' }],
}, null, 2));
const fakeBun = join(bin, 'bun');
writeFileSync(fakeBun, `#!/bin/sh\nprintf '%s\\n' "$@" > "$BUN_ARGS_LOG"\nexit 0\n`);
chmodSync(fakeBun, 0o755);

afterAll(() => rmSync(fixture, { recursive: true, force: true }));

function run(...args: string[]) {
  rmSync(argsLog, { force: true });
  const result = Bun.spawnSync([process.execPath, RUNNER, ...args], {
    cwd: fixture,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
      BUN_ARGS_LOG: argsLog,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const called = existsSync(argsLog) ? readFileSync(argsLog, 'utf8').split('\n').filter(Boolean) : [];
  return { status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString(), called };
}

describe('the test runner', () => {
  test('runs every test file except the slow list by default', () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.called[0]).toBe('test');
    expect(result.called).toContain('test/a.test.ts');
    expect(result.called).toContain('test/b.test.ts');
    expect(result.called).not.toContain('test/c.test.ts');
  });

  test('runs only the slow list with --slow', () => {
    const result = run('--slow');
    expect(result.status).toBe(0);
    expect(result.called).toEqual(['test', 'test/c.test.ts']);
  });

  test('forwards --shard=i/n and the timing flags to bun', () => {
    const result = run('--shard=2/3', '--timings=/tmp/timings.json', '--update-timings');
    expect(result.status).toBe(0);
    expect(result.called).toContain('--shard=2/3');
    expect(result.called).toContain('--timings=/tmp/timings.json');
    expect(result.called).toContain('--update-timings');
    expect(result.called).toContain('test/a.test.ts');
    expect(result.called).not.toContain('test/c.test.ts');
  });

  test('--only runs just the named file', () => {
    const result = run('--only', 'test/a.test.ts');
    expect(result.status).toBe(0);
    expect(result.called).toEqual(['test', 'test/a.test.ts']);
  });

  test('--only refuses a file the selected mode leaves out', () => {
    const result = run('--only', 'test/c.test.ts');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('test/c.test.ts');
  });

  test('--dry-run lists the selected files and runs none', () => {
    const result = run('--dry-run');
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(['test/a.test.ts', 'test/b.test.ts']);
    expect(result.called).toEqual([]);
  });

  test('a slow list naming a file that is not there is refused', () => {
    writeFileSync(join(fixture, 'test', 'slow-files.json'), JSON.stringify({
      version: 1,
      measuredOn: '2026-11-18',
      files: [{ path: 'test/gone.test.ts', seconds: 31, reason: 'green-slow' }],
    }));
    try {
      const result = run();
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('test/gone.test.ts');
    } finally {
      writeFileSync(join(fixture, 'test', 'slow-files.json'), JSON.stringify({
        version: 1,
        measuredOn: '2026-11-18',
        files: [{ path: 'test/c.test.ts', seconds: 31, reason: 'green-slow', result: 'green' }],
      }));
    }
  });
});
