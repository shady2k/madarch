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
import { jsonArrayLocations, jsonValueLine } from '../../scripts/json-lines.js';

const RUNNER = join(import.meta.dir, '..', '..', 'scripts', 'run-tests.ts');

const fixture = mkdtempSync(join(tmpdir(), 'madarch-run-tests-'));
const bin = join(fixture, 'bin');
const argsLog = join(fixture, 'bun-args.log');
mkdirSync(join(fixture, 'test'), { recursive: true });
mkdirSync(bin, { recursive: true });
mkdirSync(join(fixture, 'test', 'nested', 'test'), { recursive: true });
for (const name of ['a', 'b', 'c']) {
  writeFileSync(join(fixture, 'test', `${name}.test.ts`), `import { test } from 'bun:test';\ntest('${name}', () => {});\n`);
}
writeFileSync(join(fixture, 'test', 'nested', 'test', 'a.test.ts'), "import { test } from 'bun:test'; test('nested-a', () => { throw new Error('wrong substring selection'); });\n");
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

test('JSON locations ignore decoy keys, escaped strings and nested punctuation', () => {
  const source = `{
 "nested": {"files": [17]}, "note":"files [,] \\"x\\"",
 "files": [
 {"label":"test/a.test.ts", "nested":{"path":"wrong"},
 "pa\\u0074h": "test/a.test.ts", "array":[{}, [1,2]]},
 null,
 17,
 [true],
 "escaped\\\\end"
 ]}`;
  JSON.parse(source);
  expect(jsonArrayLocations(source)).toEqual([
    {entryLine:4,propertyLines:{label:4,nested:4,path:5,array:5}},
    {entryLine:6,propertyLines:{}}, {entryLine:7,propertyLines:{}},
    {entryLine:8,propertyLines:{}}, {entryLine:9,propertyLines:{}}
  ]);
  expect(jsonArrayLocations('{"files":[]}')).toEqual([]);
  expect(jsonArrayLocations('{"other":[{}]}')).toEqual([]);
});


test('serialized value locations have a fallback', () => {
  expect(jsonValueLine('{\n \"key\": \"value\"}', 'value')).toBe(2);
  expect(jsonValueLine('{}', 'missing')).toBe(1);
});

describe('the test runner', () => {
  test('refuses duplicate paths at the second entry line', () => {
    const manifest = join(fixture, 'test', 'slow-files.json');
    const original = readFileSync(manifest, 'utf8');
    try {
      writeFileSync(manifest, '{"files":[\n {"path":"test/c.test.ts","reason":"green-slow"},\n {"path":"test/c.test.ts","reason":"green-slow"}]}');
      const result = run();
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`${manifest}:3: duplicate slow path test/c.test.ts`);
      expect(result.called).toEqual([]);
    } finally { writeFileSync(manifest, original); }
  });

  test('only refusal names the absolute test path and manifest location', () => {
    const result = run('--only', 'test/c.test.ts');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`${join(fixture, 'test/c.test.ts')}:1:`);
  });

  test('single-file timing updates refuse zero or multiple only flags with the right command', () => {
    const target = '.github/workflows/single-file-timings.json';
    for (const args of [[], ['--only', 'test/a.test.ts', '--only', 'test/b.test.ts'], ['--only', 'test/a.test.ts', '--only', 'test/a.test.ts']]) {
      const result = run(...args, '--timings='+target, '--update-timings');
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`scripts/plugin-sandbox-cgroup.sh bun run test --only <path> --timings=${target} --update-timings`);
      expect(result.called).toEqual([]);
    }
  });

  test('real Bun single-file timing refresh merges one measurement and preserves other rows', () => {
    const target = join(fixture, '.github/workflows/single-file-timings.json');
    mkdirSync(join(fixture, '.github/workflows'), { recursive: true });
    const original = { version: 1, files: { 'test/a.test.ts': 99999, 'test/b.test.ts': 1234, 'test/c.test.ts': 5678 } };
    writeFileSync(target, JSON.stringify(original));
    const result = Bun.spawnSync([process.execPath, RUNNER, '--only', 'test/a.test.ts', '--timings='+target, '--update-timings'], { cwd: fixture, env: { ...process.env, PATH: process.env.PATH }, stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode).toBe(0);
    const updated = JSON.parse(readFileSync(target, 'utf8'));
    expect(Object.keys(updated.files).sort()).toEqual(Object.keys(original.files).sort());
    expect(updated.files['test/b.test.ts']).toBe(1234);
    expect(updated.files['test/c.test.ts']).toBe(5678);
    expect(updated.files['test/a.test.ts']).not.toBe(99999);
    expect(updated.files['test/a.test.ts']).toBeGreaterThanOrEqual(0);
  });

  test('runs every test file except the slow list by default', () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.called[0]).toBe('test');
    expect(result.called).toContain('./test/a.test.ts');
    expect(result.called).toContain('./test/b.test.ts');
    expect(result.called).not.toContain('./test/c.test.ts');
  });

  test('real Bun exact paths and shard manifests select the file, not an overlapping basename', () => {
    const result = Bun.spawnSync([process.execPath, RUNNER, '--only', 'test/a.test.ts', '--shard=1/1', '--timings='+join(fixture,'timings.json'), '--update-timings'], {cwd:fixture,env:{...process.env,PATH:process.env.PATH},stdout:'pipe',stderr:'pipe'});
    expect(result.exitCode).toBe(0);
    const manifest = JSON.parse(readFileSync(join(fixture, 'timings.json'), 'utf8'));
    expect(Object.keys(manifest.files)).toEqual(['test/a.test.ts']);
    expect(manifest.files).not.toHaveProperty('test/nested/test/a.test.ts');
  });


  test('reports the absolute manifest path and the actual entry line for invalid entries', () => {
    const manifest = join(fixture, 'test', 'slow-files.json');
    const original = readFileSync(manifest, 'utf8');
    const cases = [
      { entry: '17', message: 'every slow entry names a "path"' },
      { entry: '{}', message: 'every slow entry names a "path"' },
      { entry: 'null', message: 'every slow entry names a "path"' },
      { entry: '{"path":"test/gone.test.ts","reason":"green-slow"}', message: 'test/gone.test.ts is in the slow list' },
      { entry: '{"path":"test/a.test.ts","reason":"bad"}', message: 'test/a.test.ts names no reason: green-slow, waits-timeout or red-defect' },
    ];
    try {
      for (const { entry, message } of cases) {
        writeFileSync(manifest, '{\n  "note": "punctuation [,]", "other": [],\n  "files": [\n    {"path":"test/c.test.ts","reason":"green-slow","nested":[{}],"label":"a, { [, b"},\n\n    ' + entry + '\n  ], "tail": {}\n}');
        const result = run();
        expect(result.status).toBe(2);
        expect(result.stderr).toContain(`${manifest}:6: ${message}`);
      }
    } finally {
      writeFileSync(manifest, original);
    }
  });

  test('accepts red-defect as a slow-list reason', () => {
    const manifest = join(fixture, 'test', 'slow-files.json');
    const original = readFileSync(manifest, 'utf8');
    try {
      for (const reason of ['red-defect', 'waits-timeout']) {
        writeFileSync(manifest, JSON.stringify({ files: [{ path: 'test/c.test.ts', reason }] }));
        const result = run('--slow');
        expect(result.status).toBe(0);
        expect(result.called).toEqual(['test', './test/c.test.ts']);
      }
    } finally {
      writeFileSync(manifest, original);
    }
  });

  test('refuses unreadable or malformed manifests with an absolute source location', () => {
    const manifest = join(fixture, 'test', 'slow-files.json');
    const original = readFileSync(manifest, 'utf8');
    try {
      for (const source of ['{', 'null', '3', '{}', '{"files":{}}']) {
        writeFileSync(manifest, source);
        const result = run();
        expect(result.status).toBe(2);
        expect(result.stderr).toContain(`${manifest}:1: `);
        expect(result.stderr).toContain(source === '{' ? 'cannot read the slow list:' : 'the slow list must be an object with a "files" array');
      }
    } finally {
      writeFileSync(manifest, original);
    }
  });

  test('runs only the slow list with --slow', () => {
    const result = run('--slow');
    expect(result.status).toBe(0);
    expect(result.called).toEqual(['test', './test/c.test.ts']);
  });

  test('forwards --shard=i/n and the timing flags to bun', () => {
    const result = run('--shard=2/3', '--timings=/tmp/timings.json', '--update-timings');
    expect(result.status).toBe(0);
    expect(result.called).toContain('--shard=2/3');
    expect(result.called).toContain('--timings=/tmp/timings.json');
    expect(result.called).toContain('--update-timings');
    expect(result.called).toContain('./test/a.test.ts');
    expect(result.called).not.toContain('./test/c.test.ts');
  });

  test('--only runs just the named file', () => {
    const result = run('--only', 'test/a.test.ts');
    expect(result.status).toBe(0);
    expect(result.called).toEqual(['test', './test/a.test.ts']);
  });

  test('--only refuses a file the selected mode leaves out', () => {
    const result = run('--only', 'test/c.test.ts');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('test/c.test.ts');
  });

  test('--dry-run lists the selected files and runs none', () => {
    const result = run('--dry-run');
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(['test/a.test.ts', 'test/b.test.ts', 'test/nested/test/a.test.ts']);
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
