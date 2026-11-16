/**
 * The trace is evidence, not an archive (review of 3ad53fa0): a fill writes spans per unit, per batch and per pass,
 * with statement counts as attributes, and keeps only the newest N runs.
 */
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeTrace, openTrace, runInTrace } from '../src/obs/trace.js';
import { sweepRawTelemetry } from '../src/obs/retention.js';
import { rawRetentionOf } from '../src/knowledge/settings.js';
import { createTestDatabaseOwner } from './test-database.js';

test('a transaction states its statement counts on one span, not one span per statement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-trace-spans-'));
  const store = join(root, 'store');
  const owner = await createTestDatabaseOwner({});
  try {
    const trace = openTrace({ store, runId: 'policy', retention: { runs: 20 } });
    await runInTrace(trace, async () => await owner.transaction('snapshot', async (tx) => {
      await tx.query('SELECT 1');
      await tx.query('SELECT 2');
      await tx.query('SELECT 3');
    }));
    closeTrace(trace);
    const lines = readFileSync(join(store, 'traces', 'policy.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { name: string; attributes: { key: string; value: Record<string, unknown> }[] });
    expect(lines.some((line) => line.name === 'db.SELECT')).toBe(false);
    const transaction = lines.find((line) => line.name === 'db.transaction');
    expect(transaction).toBeDefined();
    const selects = transaction!.attributes.find((one) => one.key === 'db.selects')?.value;
    expect(selects).toEqual({ intValue: '3' });
    expect(lines.length).toBeLessThan(20);
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test('only the newest N run traces stand', () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-trace-keep-'));
  const store = join(root, 'store');
  const folder = join(store, 'traces');
  mkdirSync(folder, { recursive: true });
  for (let at = 0; at < 25; at += 1) {
    writeFileSync(join(folder, `fill-${String(at).padStart(2, '0')}.jsonl`), '{}\n');
    writeFileSync(join(folder, `fill-${String(at).padStart(2, '0')}.log.jsonl`), '{}\n');
  }
  const trace = openTrace({ store, runId: 'newest', retention: { runs: 20 } });
  closeTrace(trace);
  const names = readdirSync(folder).filter((name) => name.endsWith('.jsonl') && !name.endsWith('.log.jsonl'));
  expect(names).toHaveLength(20);
  expect(names).toContain('newest.jsonl');
  expect(names).not.toContain('fill-00.jsonl');
  rmSync(root, { recursive: true, force: true });
});

test('the oldest raw records go first: by age, then by the byte budget, and the logs with their traces', () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-trace-retention-'));
  const store = join(root, 'store');
  const folder = join(store, 'traces');
  const journal = join(store, 'journal');
  mkdirSync(folder, { recursive: true });
  mkdirSync(journal, { recursive: true });
  const day = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 10, 15, 12);
  const write = (dir: string, name: string, bytes: number, at: number): void => {
    writeFileSync(join(dir, name), 'x'.repeat(bytes));
    utimesSync(join(dir, name), new Date(at), new Date(at));
  };
  // Three runs, oldest first: two days, four days and five days old, each with its log.
  write(folder, 'recent.jsonl', 100, now - 2 * day);
  write(folder, 'recent.log.jsonl', 50, now - 2 * day);
  write(folder, 'old.jsonl', 100, now - 4 * day);
  write(folder, 'old.log.jsonl', 50, now - 4 * day);
  write(folder, 'older.jsonl', 100, now - 5 * day);
  write(folder, 'older.log.jsonl', 50, now - 5 * day);
  write(journal, 'run-old.jsonl', 100, now - 4 * day);

  // By age: three days keep the newest run and nothing of the others, their logs included.
  const aged = sweepRawTelemetry(store, { days: 3, bytes: null, runs: 20 }, now);
  expect(aged.removed.map((file) => file.slice(store.length + 1)).sort()).toEqual(['journal/run-old.jsonl', 'traces/old.jsonl', 'traces/old.log.jsonl', 'traces/older.jsonl', 'traces/older.log.jsonl']);
  expect(readdirSync(folder).sort()).toEqual(['recent.jsonl', 'recent.log.jsonl']);

  // By size: the budget is reached and the oldest record goes first, a trace with its log.
  write(folder, 'old.jsonl', 100, now - 1 * day);
  write(folder, 'old.log.jsonl', 50, now - 1 * day);
  const sized = sweepRawTelemetry(store, { days: 30, bytes: 200, runs: 20 }, now);
  expect(sized.removed.map((file) => file.slice(store.length + 1))).toEqual(['traces/recent.jsonl', 'traces/recent.log.jsonl']);
  expect(readdirSync(folder).sort()).toEqual(['old.jsonl', 'old.log.jsonl']);
  expect(sized.keptBytes).toBe(150);

  // A budget nothing exceeds removes nothing, and the count bound stands beside the two others.
  expect(sweepRawTelemetry(store, { days: 30, bytes: 10_000, runs: 20 }, now).removed).toEqual([]);
  expect(sweepRawTelemetry(store, { days: 30, bytes: null, runs: 0 }, now).removed.length).toBe(2);
  rmSync(root, { recursive: true, force: true });
});

test('the machine settings name the bounds, and the detailed logs default to three days', () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-retention-settings-'));
  try {
    const home = join(root, 'madarch');
    mkdirSync(home, { recursive: true });
    const env = { MADARCH_HOME: home } as unknown as Parameters<typeof rawRetentionOf>[0];
    expect(rawRetentionOf(env)).toEqual({ days: 3, bytes: null, runs: 20 });
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ traceRetentionDays: 7, traceRetentionBytes: 5_000_000, traceRuns: 5 }));
    expect(rawRetentionOf(env)).toEqual({ days: 7, bytes: 5_000_000, runs: 5 });
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ traceRetentionDays: -1, traceRetentionBytes: 0 }));
    expect(rawRetentionOf(env)).toEqual({ days: 3, bytes: null, runs: 20 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
