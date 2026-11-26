import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from 'bun:test';
import { evidenceCommand, growthMeasurementPaths, growthPaths, growthFindings, readShardTimings, slowFindings, type Timings } from '../../scripts/check-slow-tests.js';
import type { SlowFile, SlowList } from '../../scripts/run-tests.js';
const path = 'test/a.test.ts';
const entry: SlowFile = { path, seconds: 31, reason: 'red-defect', result: 'red', owner: 'madarch-x9a7', defect: 'A claim is answered as published.', replacement: 'Assert the restored claim remains pending.', exit: 'Rewrite the file, pass blocking tests, remove this entry.' };
function list(files: SlowList['files']): SlowList { return { version: 1, measuredOn: 'today', files }; }
const evidence: Timings = { source: '/evidence.json', kind: 'single-file', files: { [path]: 31000 }, text: "{\n  \"files\": {\n    \"test/a.test.ts\": 31000\n  }\n}" };
const findings = (row: SlowFile) => slowFindings([path], list([row]), evidence);
test('accepts a measured red defect with repair evidence', () => expect(findings(entry)).toEqual([]));
for (const field of ['owner', 'defect', 'replacement', 'exit'] as const) {
  test(`requires explicit ${field}`, () => expect(findings({ ...entry, [field]: undefined }).some(value => value.includes(field))).toBe(true));
}
test('rejects unassigned owner', () => expect(findings({ ...entry, owner: 'unassigned' }).join()).toContain('owner'));
test('red cannot be green-slow', () => expect(findings({ ...entry, reason: 'green-slow' }).join()).toContain('red and cannot use reason green-slow'));
test('green cannot be red-defect or waits-timeout', () => {
  for (const reason of ['red-defect', 'waits-timeout'] as const) expect(findings({ ...entry, result: 'green', reason }).join()).toContain('green and must use reason green-slow');
});
test('accepts green-slow and waiting reds', () => {
  expect(findings({ ...entry, result: 'green', reason: 'green-slow' })).toEqual([]);
  expect(findings({ ...entry, reason: 'waits-timeout' })).toEqual([]);
});
test('rejects 6.2 seconds disguised as 31 with actual evidence line', () => {
  const result = slowFindings([path], list([{ ...entry, result: 'green', reason: 'green-slow' }]), { ...evidence, files: { [path]: 6200 } });
  expect(result).toContain('/evidence.json:3: test/a.test.ts listed time 31s disagrees with the committed measurement 6200ms');
});
test('merge-base guard requires independent evidence for changed files', () => {
  const result = slowFindings([path], list([]), { ...evidence, text: '{}', files: {} }, { revision: 'abc', changedFiles: [path] });
  expect(result).toContain('/evidence.json:1: test/a.test.ts changed since abc has no single-file evidence');
});
test('new measured 35 second file must be listed', () => {
  expect(slowFindings([path], list([]), { ...evidence, files: { [path]: 35000 } }, { revision: 'abc', changedFiles: [path] })).toEqual(['/evidence.json:3: test/a.test.ts took 35000 ms, more than 30 s, and is not in test/slow-files.json']);
});
test('kind not filename chooses comparison rules', () => {
  expect(slowFindings([path], list([entry]), { ...evidence, kind: 'shard', files: { [path]: 6200 } })).toEqual([]);
  expect(slowFindings([path], list([entry]), { ...evidence, source: '/anything.json', files: { [path]: 6200 } }).join()).toContain('disagrees');
});
test('invalid and subthreshold listed seconds fail', () => {
  for (const seconds of [NaN, 30]) expect(findings({ ...entry, seconds }).join()).toContain('slow criterion');
});
test('invalid measurement is not evidence', () => {
  expect(slowFindings([path], list([]), { ...evidence, files: { [path]: NaN } }, { revision: 'abc', changedFiles: [path] }).join()).toContain('no single-file evidence');
});

test('owner task syntax is anchored and allows multi-digit child tasks', () => {
  for (const owner of ['madarch-x9a7!', '!madarch-x9a7', 'madarch-x9a7.foo']) expect(findings({ ...entry, owner }).join()).toContain('owner');
  expect(findings({ ...entry, owner: 'madarch-x9a7.12' })).toEqual([]);
});
test('blank repair evidence fails', () => {
  for (const field of ['defect', 'replacement', 'exit'] as const) expect(findings({ ...entry, [field]: '  ' }).join()).toContain(field);
});
test('measurement rounding tolerance is 100 milliseconds inclusive', () => {
  expect(slowFindings([path], list([entry]), { ...evidence, files: { [path]: 31100 } })).toEqual([]);
  expect(slowFindings([path], list([entry]), { ...evidence, files: { [path]: 31101 } }).join()).toContain('disagrees');
});
test('unknown, nonfinite, fast and exactly threshold measures are not slow', () => {
  expect(slowFindings([path], list([]), { ...evidence, files: { [path]: 30000, 'test/gone.test.ts': 35000 } })).toEqual([]);
  expect(slowFindings([path], list([]), { ...evidence, files: { [path]: Infinity } })).toEqual([]);
});
test('shards do not serve as merge-base evidence and preserve manifest location', () => {
  expect(slowFindings([path], list([]), { ...evidence, kind: 'shard', files: {} }, { revision: 'abc', changedFiles: [path] })).toEqual([]);
  expect(slowFindings([path], list([]), { ...evidence, kind: 'shard', locations: { [path]: '/shards/shard-1.json:7' } }, undefined, '', evidence)).toEqual(['/shards/shard-1.json:7: test/a.test.ts took 31000 ms in shard and 31000 ms alone, both more than 30 s, and is not in test/slow-files.json']);
});
test('missing path after multiple lines points at manifest root', () => {
  expect(slowFindings([path], list([]), { ...evidence, text: '{\n\n}', files: {} }, { revision: 'abc', changedFiles: [path] })).toEqual(['/evidence.json:1: test/a.test.ts changed since abc has no single-file evidence']);
});

test('shard schema is independent of manifest basename and reports actual source line', () => {
  const folder = mkdtempSync(join(tmpdir(), 'slow-evidence-'));
  try {
    const manifest = join(folder, 'observed.json');
    writeFileSync(manifest, JSON.stringify({ version: 1, files: { [path]: 35000 } }, null, 2));
    writeFileSync(join(folder, 'notes.txt'), 'not a manifest');
    const measured = readShardTimings(folder);
    expect(measured.kind).toBe('shard');
    expect(slowFindings([path], list([]), measured, undefined, '', evidence)).toEqual([`${manifest}:4: test/a.test.ts took 35000 ms in shard and 31000 ms alone, both more than 30 s, and is not in test/slow-files.json`]);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('shard union retains maximum observation and its source', () => {
  const folder = mkdtempSync(join(tmpdir(), 'slow-union-'));
  try {
    writeFileSync(join(folder, 'a.json'), JSON.stringify({ version: 1, files: { [path]: 35000 } }));
    writeFileSync(join(folder, 'b.json'), JSON.stringify({ version: 1, files: { [path]: 32000 } }));
    const measured = readShardTimings(folder);
    expect(measured.files[path]).toBe(35000);
    expect(measured.locations?.[path]).toBe(`${join(folder, 'a.json')}:1`);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

const baseState = { revision: 'abc', changedFiles: [], slowPaths: [path], evidence: { [path]: 31000 } };
test('added slow entry without added evidence fails and is growth', () => {
  const base = { ...baseState, slowPaths: [], evidence: {} };
  expect(growthPaths(list([entry]), evidence, base)).toEqual([path]);
  expect(slowFindings([path], list([entry]), { ...evidence, files: {} }, base).join()).toContain('no single-file evidence');
});
test('changed evidence alone is growth and alone measurement rejects the listed lie', () => {
  const changed = { ...evidence, files: { [path]: 32000 } };
  expect(growthPaths(list([entry]), changed, baseState)).toEqual([path]);
  expect(growthFindings(list([entry]), { ...evidence, files: { [path]: 6200 } }, [path], { ...evidence, files: { [path]: 6200 } }).join()).toContain('6200ms');
});
test('entry plus evidence changed together cannot disguise an under-threshold alone run', () => {
  const base = { ...baseState, slowPaths: [], evidence: { [path]: 6200 } };
  const growth = growthPaths(list([entry]), evidence, base);
  expect(growth).toEqual([path]);
  expect(growthFindings(list([entry]), { ...evidence, files: { [path]: 6200 } }, growth, { ...evidence, files: { [path]: 6200 } }).join()).toContain('31s');
});
test('untouched base entry and evidence are not growth', () => {
  expect(growthPaths(list([entry]), evidence, baseState)).toEqual([]);
});
test('growth measurement requires every requested row and checks unlisted slow files', () => {
  expect(growthFindings(list([entry]), { ...evidence, files: {} }, [path]).join()).toContain('no alone-run measurement');
  expect(growthFindings(list([]), evidence, [path]).join()).toContain('not in test/slow-files.json');
  expect(growthFindings(list([entry]), evidence, [path])).toEqual([]);
  expect(growthFindings(list([entry]), { ...evidence, files: { [path]: 31100 } }, [path])).toEqual([]);
  expect(growthFindings(list([entry]), { ...evidence, files: { [path]: 31101 } }, [path])).toEqual([]);
});

test('growth set is deduplicated, sorted and includes added entries without a base list', () => {
  const other = 'test/z.test.ts';
  expect(growthPaths(list([entry]), { ...evidence, files: { [other]: 4, [path]: 31000 } }, { revision: 'abc', changedFiles: [] })).toEqual([path, other]);
  expect(growthPaths(list([{ ...entry, path: other }, entry]), evidence, { revision: 'abc', changedFiles: [], evidence: evidence.files })).toEqual([path, other]);
});
test('growth checks the matching path, threshold and evidence source location', () => {
  expect(growthFindings(list([entry]), { ...evidence, files: { 'test/fast.test.ts': 30000 } }, ['test/fast.test.ts'])).toEqual([]);
  expect(growthFindings(list([]), { ...evidence, files: { [path]: 30000 } }, [path])).toEqual([]);
  expect(growthFindings(list([]), { ...evidence, files: { [path]: 1 } }, [path])).toEqual([]);
  expect(growthFindings(list([entry]), { ...evidence, files: { [path]: 6200 } }, [path], { ...evidence, files: { [path]: 6200 } })[0]).toStartWith('/evidence.json:3:');
});

test('missing-row producer command names the path and slow mode', () => {
  expect(evidenceCommand(path)).toBe('scripts/plugin-sandbox-cgroup.sh bun run test --only test/a.test.ts --timings=.github/workflows/single-file-timings.json --update-timings');
  expect(evidenceCommand(path, true)).toBe('scripts/plugin-sandbox-cgroup.sh bun run test --slow --only test/a.test.ts --timings=.github/workflows/single-file-timings.json --update-timings');
});

test('blocking growth measures only green speed claims from the full growth set', () => {
  const green = { ...entry, result: 'green' as const, reason: 'green-slow' as const };
  const red = { ...entry, path: 'test/red.test.ts' };
  const manifest = list([green, red]);
  const rows = { ...evidence, files: { [path]: 31000, [red.path]: 50000, 'test/fast.test.ts': 1000 } };
  const base = { revision: 'abc', changedFiles: [], slowPaths: [], evidence: {} };
  expect(growthPaths(manifest, rows, base)).toEqual([path, 'test/fast.test.ts', red.path]);
  expect(growthMeasurementPaths(manifest, rows, base)).toEqual([path]);
  expect(growthMeasurementPaths(manifest, rows, { ...base, slowPaths: [path], evidence: rows.files })).toEqual([]);
  expect(growthMeasurementPaths(manifest, rows, { ...base, slowPaths: [path], evidence: { [path]: 32000 } })).toEqual([path]);
});
test('alone speed comparison ignores listed-time noise and confirms the threshold', () => {
  expect(growthFindings(list([entry]), { ...evidence, files: { [path]: 31101 } }, [path])).toEqual([]);
  expect(growthFindings(list([entry]), { ...evidence, files: { [path]: 30900 } }, [path])).toEqual([]);
  expect(growthFindings(list([entry]), { ...evidence, files: { [path]: 30899 } }, [path])).toEqual([]);
  expect(growthFindings(list([{ ...entry, seconds: 30.05 }]), { ...evidence, files: { [path]: 30000 } }, [path], { ...evidence, files: { [path]: 30000 } })).toEqual([]);
  expect(growthFindings(list([{ ...entry, seconds: 30.05 }]), { ...evidence, files: { [path]: 15000 } }, [path], { ...evidence, files: { [path]: 15000 } }).join()).toContain('not slow');
});

test('two fast alone runs confirm the speed finding with both values', () => {
  const first = { ...evidence, files: { [path]: 6200 } };
  const second = { ...evidence, files: { [path]: 15000 } };
  const result = growthFindings(list([entry]), first, [path], second).join();
  expect(result).toContain('31s');
  expect(result).toContain('6200ms');
  expect(result).toContain('15000ms');
});
test('a confirmation above the exit bound never refutes a speed claim', () => {
  expect(growthFindings(list([entry]), { ...evidence, files: { [path]: 15000 } }, [path], { ...evidence, files: { [path]: 15001 } })).toEqual([]);
});
test('a listed file measured between the exit and entry bounds on a slow runner keeps its place', () => {
  expect(growthFindings(list([{ ...entry, seconds: 34.296 }]), { ...evidence, files: { [path]: 20077 } }, [path], { ...evidence, files: { [path]: 19998 } })).toEqual([]);
});
test('one fast alone run and one slow alone run is not a speed finding', () => {
  expect(growthFindings(list([entry]), { ...evidence, files: { [path]: 6200 } }, [path], { ...evidence, files: { [path]: 43000 } })).toEqual([]);
});
test('one fast run requires confirmation; a 43 second run never contradicts listed 31 seconds', () => {
  expect(growthFindings(list([entry]), { ...evidence, files: { [path]: 6200 } }, [path])).toEqual([]);
  expect(growthFindings(list([entry]), { ...evidence, files: { [path]: 43000 } }, [path])).toEqual([]);
});

test('shard outlier needs an independent above-threshold confirmation', () => {
  const shard = { ...evidence, kind: 'shard' as const, files: { [path]: 35000 } };
  expect(slowFindings([path], list([]), shard)).toEqual([]);
  for (const ms of [6200, 30000]) {
    expect(slowFindings([path], list([]), shard, undefined, '', { ...evidence, files: { [path]: ms } })).toEqual([]);
  }
  const result = slowFindings([path], list([]), shard, undefined, '', { ...evidence, files: { [path]: 30001 } }).join();
  expect(result).toContain('35000');
  expect(result).toContain('30001');
  expect(result).toContain('not in test/slow-files.json');
  expect(slowFindings([path], list([entry]), shard, undefined, '', evidence)).toEqual([]);
});

test('measured command confirms a shard outlier with real Bun before failing', () => {
  const folder = mkdtempSync(join(tmpdir(), 'slow-shard-command-'));
  try {
    for (const dir of ['test', 'scripts', 'shards']) mkdirSync(join(folder, dir));
    writeFileSync(join(folder, path), "import { test } from 'bun:test'; test('fast', () => {});");
    writeFileSync(join(folder, 'test/slow-files.json'), JSON.stringify(list([])));
    writeFileSync(join(folder, 'shards/one.json'), JSON.stringify({ version: 1, files: { [path]: 35000 } }));
    writeFileSync(join(folder, 'package.json'), JSON.stringify({ scripts: { test: `bun ${resolve(import.meta.dir, '../../scripts/run-tests.ts')}` } }));
    const wrapper = join(folder, 'scripts/plugin-sandbox-cgroup.sh');
    writeFileSync(wrapper, '#!/bin/sh\nexec "$@"\n');
    chmodSync(wrapper, 0o755);
    const result = spawnSync(process.execPath, [resolve(import.meta.dir, '../../scripts/check-slow-tests.ts'), '--measured', 'shards'], { cwd: folder, env: process.env, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`shard confirmation: ${path} milliseconds=`);
    expect(result.stdout).toContain('no finding');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
