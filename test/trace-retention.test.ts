/**
 * The trace is evidence, not an archive (review of 3ad53fa0): a fill writes spans per unit, per batch and per pass,
 * with statement counts as attributes, and keeps only the newest N runs.
 */
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeTrace, openTrace, runInTrace } from '../src/obs/trace.js';
import { createTestDatabaseOwner } from './test-database.js';

test('a transaction states its statement counts on one span, not one span per statement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-trace-spans-'));
  const store = join(root, 'store');
  const owner = await createTestDatabaseOwner({});
  try {
    const trace = openTrace({ store, runId: 'policy', keep: 20 });
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
  const trace = openTrace({ store, runId: 'newest', keep: 20 });
  closeTrace(trace);
  const names = readdirSync(folder).filter((name) => name.endsWith('.jsonl') && !name.endsWith('.log.jsonl'));
  expect(names).toHaveLength(20);
  expect(names).toContain('newest.jsonl');
  expect(names).not.toContain('fill-00.jsonl');
  rmSync(root, { recursive: true, force: true });
});
