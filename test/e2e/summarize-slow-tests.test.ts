import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from 'bun:test';

const script = resolve(import.meta.dir, '../../scripts/summarize-slow-tests.ts');
const a = 'test/a.test.ts';
const b = 'test/b.test.ts';
type Row = { path: string; result: 'red' | 'green'; seconds?: number };
function summarize(rows: Row[], log: string, timings: Record<string, number>, independent: Record<string, number> = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'slow-summary-'));
  try {
    mkdirSync(join(folder, 'test'), { recursive: true });
    mkdirSync(join(folder, '.github/workflows'), { recursive: true });
    for (const row of rows) writeFileSync(join(folder, row.path), '');
    writeFileSync(join(folder, 'test/slow-files.json'), JSON.stringify({ version: 1, measuredOn: 'today', files: rows.map(row => ({ seconds: 45, reason: row.result === 'green' ? 'green-slow' : 'red-defect', ...row })) }));
    writeFileSync(join(folder, '.github/workflows/single-file-timings.json'), JSON.stringify({ files: independent }));
    writeFileSync(join(folder, 'timings.json'), JSON.stringify({ files: timings }));
    writeFileSync(join(folder, 'run.log'), log);
    const summary = join(folder, 'summary.md');
    const result = spawnSync(process.execPath, [script, 'timings.json', 'run.log'], { cwd: folder, env: { ...process.env, GITHUB_STEP_SUMMARY: summary, SLOW_OUTCOME: 'success' }, encoding: 'utf8' });
    return { status: result.status, summary: readFileSync(summary, 'utf8'), stderr: result.stderr };
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

test('red claim running green at first log heading is a contradiction', () => {
  const result = summarize([{ path: a, result: 'red' }], `${a}:
(pass) example
`, { [a]: 40000 });
  expect(result.summary).toContain('| test/a.test.ts | 40.000 | 45 | GREEN | claimed red, ran green |');
  expect(result.status).toBe(1);
});

test('green claim running red is a contradiction and cannot confirm removal', () => {
  const result = summarize([{ path: a, result: 'green' }], `bun test
${a}:
(fail) example
`, { [a]: 20000 }, { [a]: 20000 });
  expect(result.summary).toContain('| test/a.test.ts | 20.000 | 45 | RED | claimed green, ran red |');
  expect(result.summary).not.toContain('confirmed: green single-file');
  expect(result.status).toBe(1);
});

test('adjacent headings keep red and green observations separate', () => {
  const result = summarize([{ path: a, result: 'green' }, { path: b, result: 'red' }], `${a}:
(pass) first
${b}:
(fail) second
`, { [a]: 40000, [b]: 50000 });
  expect(result.summary).toContain('| test/a.test.ts | 40.000 | 45 | GREEN | claimed, measurement matches |');
  expect(result.summary).toContain('| test/b.test.ts | 50.000 | 45 | RED | claimed, measurement matches |');
  expect(result.status).toBe(0);
});

test('green single-file at threshold confirms removal in the claim column', () => {
  const result = summarize([{ path: a, result: 'green' }], `${a}:
(pass) example
`, { [a]: 45000 }, { [a]: 30000 });
  expect(result.summary).toContain('| test/a.test.ts | 45.000 | 45 | GREEN | confirmed: green single-file ≤ 30 s — remove entry |');
  expect(result.status).toBe(0);
});

test('batch green at threshold is only an exit candidate without fast single-file evidence', () => {
  const evidenceRows: Record<string, number>[] = [{}, { [a]: 30001 }];
  for (const independent of evidenceRows) {
    const result = summarize([{ path: a, result: 'green' }], `${a}:
(pass) example
`, { [a]: 30000 }, independent);
    expect(result.summary).toContain('exit candidate');
    expect(result.summary).toContain('claimed, measurement matches');
    expect(result.summary).not.toContain('confirmed: green single-file');
    expect(result.status).toBe(0);
  }
});

test('missing observation is unconfirmed even with timings and single-file evidence', () => {
  const result = summarize([{ path: a, result: 'green' }], `${a}:
`, { [a]: 20000 }, { [a]: 20000 });
  expect(result.summary).toContain('| test/a.test.ts | 20.000 | 45 | UNCONFIRMED | unconfirmed: no observed result |');
  expect(result.summary).not.toContain('confirmed: green single-file');
  expect(result.status).toBe(0);
});

test('missing measurement does not hide an observed contradiction', () => {
  const result = summarize([{ path: a, result: 'green' }], `${a}:
(fail) example
`, {});
  expect(result.summary).toContain('| test/a.test.ts | missing | 45 | RED | claimed green, ran red |');
  expect(result.status).toBe(1);
});

test('unhandled errors are red even when a test passed', () => {
  const result = summarize([{ path: a, result: 'green' }], `${a}:
(pass) example
# Unhandled error between tests
`, { [a]: 45000 });
  expect(result.summary).toContain('| RED | claimed green, ran red |');
  expect(result.status).toBe(1);
});

test('historical red single-file timing cannot confirm a newly green red claim', () => {
  const result = summarize([{ path: a, result: 'red' }], `${a}:\n(pass) example\n`, { [a]: 20000 }, { [a]: 20000 });
  expect(result.summary).toContain('| GREEN — exit candidate | claimed red, ran green |');
  expect(result.summary).not.toContain('confirmed: green single-file');
  expect(result.status).toBe(1);
});
