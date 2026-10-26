import { expect, test } from 'bun:test';
import type { DatabaseOwner, OuterTransaction } from '../src/adapters/database-owner.js';
import { createSnapshotHistoryReader } from '../src/knowledge/product.js';

const pin = { name: 'sample', scope: '1', head: 'c' };
const instant = (day: number) => `2026-02-${String(day).padStart(2, '0')}T00:00:00.000Z`;
const plan = { head: 'c', snapshots: { first: 'a', unread: 'b', last: 'c' }, points: ['a', 'b', 'c'], limit: 64, omitted: 1,
  diagnostics: [{ ref: 'refs/tags/side', object: 'side', reason: 'outside first-parent ancestry' }] };
function fixture(boundary: string | null = null, edgeBoundary: string | null = null, missingBoundary = false) {
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  let failures: 'boundary' | 'nodes' | undefined;
  let gate: Promise<void> | undefined;
  let future = false;
  const tx = { query: async (sql: string, values: readonly unknown[] = []) => {
    calls.push({ sql, values });
    if (sql.includes('boundary_epoch_millis')) {
      if (failures === 'boundary') { failures = undefined; throw new Error('boundary unavailable'); }
      if (gate !== undefined) await gate;
      const includesEdges = sql.includes('FROM edge_version WHERE');
      const latest = includesEdges && edgeBoundary !== null && (boundary === null || Number(edgeBoundary) > Number(boundary)) ? edgeBoundary : boundary;
      return { rows: [missingBoundary ? {} : { boundary_epoch_millis: latest }] };
    }
    if (sql.includes('FROM node_version v')) {
      if (failures === 'nodes') { failures = undefined; throw new Error('nodes unavailable'); }
      const keys = future && String(values[0]) < instant(10) ? ['a', 'b'] : ['a', 'b', 'c'];
      return { rows: keys.map((key, index) => ({ node_id: String(index + 1), scope_id: '1', kind: 'code.commit', label: key, producer: 'history',
        properties: { recordKey: `code.commit:${key}`, onFirstParent: true, effectiveAt: instant(index + 1) } })) };
    }
    if (sql.includes('FROM edge_version e')) {
      const keys = future && String(values[0]) < instant(10) ? ['b'] : ['b', 'c'];
      return { rows: keys.map((key, index) => ({ from_key: `code.commit:${key}`, to_key: `code.commit:${['a', 'b'][index]}`, relation: 'code.parent', properties: { position: 1 } })) };
    }
    if (sql.includes('FROM work_item')) return { rows: [{ generation: '2' }, { generation: '6' }] };
    if (sql.includes('to_regclass')) return { rows: [{ present: true }] };
    if (sql.includes('SELECT plan')) return { rows: [{ plan }] };
    throw new Error('unexpected test statement');
  } } as unknown as OuterTransaction;
  const owner = { transaction: async (_kind: unknown, work: (value: OuterTransaction) => Promise<unknown>) => await work(tx) } as unknown as DatabaseOwner;
  return { owner, calls, fail: (kind: typeof failures) => { failures = kind; }, pause: (value: Promise<void>) => { gate = value; }, future: () => { future = true; },
    n: (part: string) => calls.filter((call) => call.sql.includes(part)).length };
}

test('one immutable owner shares terminal evidence across times and concurrent selections without losing navigation', async () => {
  const read = createSnapshotHistoryReader();
  const f = fixture(String(Date.parse(instant(3))));
  let release!: () => void;
  f.pause(new Promise<void>((resolve) => { release = resolve; }));
  const first = read(f.owner, pin, instant(4), { repo: 'sample', at: 'first' });
  const unread = read(f.owner, pin, instant(5), { repo: 'sample', at: 'unread' });
  release();
  const [a, b] = await Promise.all([first, unread]);
  expect(a).toMatchObject({ coverage: 'covered', commit: 'a', until: instant(2) });
  expect(b).toMatchObject({ coverage: 'unfilled', commit: 'b', until: instant(3) });
  const last = await read(f.owner, pin, instant(6), { repo: 'sample', at: 'last' });
  expect(last).toMatchObject({ coverage: 'covered', commit: 'c', until: null,
    landmarks: { offered: 3, covered: 2, limit: 64, overflow: true, omitted: 1, first: instant(1), last: instant(3), diagnostics: plan.diagnostics } });
  expect(last.points).toEqual([{ name: 'first', commit: 'a', covered: true }, { name: 'last', commit: 'c', covered: true }, { name: 'unread', commit: 'b', covered: false }]);
  expect((await read(f.owner, pin, instant(7), { repo: 'sample', at: instant(2) })).coverage).toBe('unfilled');
  expect((await read(f.owner, pin, instant(7), { repo: 'sample', at: '2025-01-01' })).coverage).toBe('before');
  expect((await read(f.owner, pin, instant(7), { repo: 'sample', at: '?' })).coverage).toBe('unknown');
  expect(f.n('boundary_epoch_millis')).toBe(1);
  expect(f.n('FROM node_version v')).toBe(1);
  expect(f.n('FROM edge_version e')).toBe(1);
  expect(f.n('FROM work_item')).toBe(1);
  expect(f.n('SELECT plan')).toBe(1);
  expect(f.calls.filter((call) => call.sql.includes('FROM node_version v') || call.sql.includes('FROM edge_version e')).map((call) => call.values[0])).toEqual([instant(4), instant(4)]);
  a.points.length = 0;
  a.landmarks!.diagnostics.length = 0;
  expect((await read(f.owner, pin, instant(8), { repo: 'sample', at: 'last' })).landmarks!.diagnostics).toEqual(plan.diagnostics);
});

test('future boundaries forbid reuse until the rounded-up terminal millisecond, then share exact captured reads', async () => {
  const read = createSnapshotHistoryReader();
  // The SQL result is ceil(epoch * 1000), including for a submillisecond boundary.
  const f = fixture(String(Date.parse(instant(10)) + 1)); f.future();
  await read(f.owner, pin, instant(9), { repo: 'sample', at: 'last' });
  await read(f.owner, pin, instant(9), { repo: 'sample', at: 'last' });
  expect(f.n('FROM node_version v')).toBe(2);
  await read(f.owner, pin, instant(10), { repo: 'sample', at: 'last' });
  expect(f.n('FROM node_version v')).toBe(3);
  const crossed = new Date(Date.parse(instant(10)) + 1).toISOString();
  expect(await read(f.owner, pin, crossed, { repo: 'sample', at: 'last' })).toMatchObject({ coverage: 'covered', commit: 'c' });
  await read(f.owner, pin, instant(11), { repo: 'sample', at: 'last' });
  expect(f.n('FROM node_version v')).toBe(4);
  expect(f.n('boundary_epoch_millis')).toBe(1);
});

test('reader-owner replacement, scope, repository and head each isolate cached evidence', async () => {
  const read = createSnapshotHistoryReader(); const f = fixture(); const next = fixture();
  await read(f.owner, pin, instant(4), { repo: 'sample', at: 'first' });
  await read(next.owner, pin, instant(4), { repo: 'sample', at: 'first' });
  for (const changed of [{ ...pin, scope: '2' }, { ...pin, head: 'next' }, { ...pin, name: 'other' }]) {
    await read(f.owner, changed, instant(4), { repo: changed.name, at: 'first' });
  }
  expect(f.n('FROM node_version v')).toBe(4);
  expect(next.n('FROM node_version v')).toBe(1);
  const sql = f.calls.find((call) => call.sql.includes('boundary_epoch_millis'))!.sql;
  expect(sql).toContain('ceil(extract(epoch FROM max(boundary)) * 1000)');
  expect(sql).toContain("FROM node_version WHERE scope_id = $1::bigint AND recorded_to = 'infinity'");
  expect(sql).toContain("FROM edge_version WHERE scope_id = $1::bigint AND recorded_to = 'infinity'");
  expect(sql).toContain('(VALUES (valid_from), (valid_to))');
  expect(sql).toContain('WHERE isfinite(boundary)');
});

for (const failure of ['boundary', 'nodes'] as const) test(`a rejected ${failure} read is not cached`, async () => {
  const read = createSnapshotHistoryReader(); const f = fixture(); f.fail(failure);
  await expect(read(f.owner, pin, instant(4), { repo: 'sample', at: 'first' })).rejects.toThrow(`${failure} unavailable`);
  expect(await read(f.owner, pin, instant(5), { repo: 'sample', at: 'first' })).toMatchObject({ coverage: 'covered', commit: 'a' });
  await read(f.owner, pin, instant(6), { repo: 'sample', at: 'last' });
  expect(f.n('boundary_epoch_millis')).toBe(failure === 'boundary' ? 2 : 1);
  expect(f.n('FROM node_version v')).toBe(failure === 'nodes' ? 2 : 1);
});

test('no finite boundary permits sharing, but malformed boundary or instant never permits sharing', async () => {
  for (const boundary of [null, '', 'not-an-integer']) {
    const read = createSnapshotHistoryReader(); const f = fixture(boundary);
    await read(f.owner, pin, instant(4), { repo: 'sample', at: 'first' });
    await read(f.owner, pin, instant(5), { repo: 'sample', at: 'first' });
    expect(f.n('FROM node_version v')).toBe(boundary === null ? 1 : 2);
  }
  const missingRead = createSnapshotHistoryReader(); const missing = fixture(null, null, true);
  await missingRead(missing.owner, pin, instant(4), { repo: 'sample', at: 'first' });
  await missingRead(missing.owner, pin, instant(5), { repo: 'sample', at: 'first' });
  expect(missing.n('FROM node_version v')).toBe(2);
  const read = createSnapshotHistoryReader(); const f = fixture();
  await read(f.owner, pin, 'invalid', { repo: 'sample', at: 'first' });
  await read(f.owner, pin, 'invalid', { repo: 'sample', at: 'first' });
  expect(f.n('FROM node_version v')).toBe(2);
});

test('a future edge boundary alone prevents early reuse and pin fields are captured before awaits', async () => {
  const read = createSnapshotHistoryReader();
  const f = fixture(String(Date.parse(instant(3))), String(Date.parse(instant(10)) + 1));
  await read(f.owner, pin, instant(4), { repo: 'sample', at: 'first' });
  await read(f.owner, pin, instant(5), { repo: 'sample', at: 'first' });
  expect(f.n('FROM node_version v')).toBe(2);
  const mutablePin = { ...pin };
  const held = fixture(); let release!: () => void;
  held.pause(new Promise<void>((resolve) => { release = resolve; }));
  const pending = read(held.owner, mutablePin, instant(4), { repo: 'sample', at: 'first' });
  mutablePin.scope = '99'; mutablePin.head = 'changed'; mutablePin.name = 'changed';
  release(); await pending;
  expect(held.calls.find((call) => call.sql.includes('FROM node_version v'))!.values[1]).toBe('1');
  expect(held.calls.find((call) => call.sql.includes('SELECT plan'))!.values).toEqual(['sample', '1', 'c']);
});
