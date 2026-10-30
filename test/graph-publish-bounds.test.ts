
/**
 * A publication's big reads and writes are paged, not one statement over every
 * row: PGlite runs a statement on the thread that owns it, so a reader waits
 * for the whole row set (madarch-alzf, PR #197 latency).
 */
import { describe, expect, test } from 'bun:test';
import {
  currentEdgeVersions,
  edgeIdentities,
  lockNodes,
  newNodeIdentities,
  prefetchNodeSlices,
  prefetchNodes,
  writeMemo,
  type WriteContext,
} from '../src/graph/versions.js';

function rowsIn(values: readonly unknown[] | undefined): number {
  const text = String(values?.[0] ?? '{}');
  const body = text.replace(/^\{|\}$/g, '');
  return body === '' ? 0 : body.split(',').length;
}

function context(query: WriteContext['tx']['query']): WriteContext {
  return { tx: { query }, at: '2026-01-02T00:00:00Z', now: () => '2026-01-02T00:00:00Z', memo: writeMemo() };
}

describe('a publication pages its multi-row work', () => {
  test('node lookups, locks and slices never ask for more than a bounded row set', async () => {
    const ids = Array.from({ length: 450 }, (_, index) => String(index + 1));
    const lookups: number[] = [];
    const locks: number[] = [];
    const slices: number[] = [];
    const query = async <Row extends object>(sql: string, values?: readonly unknown[]) => {
      if (sql.startsWith('SELECT id::text AS id FROM node_identity WHERE id = ANY')) {
        lookups.push(rowsIn(values));
        return { rows: [] as Row[] };
      }
      if (sql.startsWith('SELECT id FROM node_identity WHERE id = ANY')) {
        locks.push(rowsIn(values));
        return { rows: [] as Row[] };
      }
      if (sql.startsWith('SELECT node_id::text AS node_id')) {
        slices.push(rowsIn(values));
        return { rows: [] as Row[] };
      }
      throw new Error(`unexpected statement: ${sql}`);
    };
    const ctx = context(query);
    await prefetchNodes(ctx, ids);
    await lockNodes(ctx, ids, 'SHARE');
    await prefetchNodeSlices(ctx, ids);
    expect(lookups.length).toBeGreaterThan(1);
    expect(locks.length).toBeGreaterThan(1);
    expect(slices.length).toBeGreaterThan(1);
    expect(Math.max(...lookups, ...locks, ...slices)).toBeLessThanOrEqual(100);
  });

  test('identity lookups, inserts and rereads never ask for more than a bounded row set', async () => {
    const keys = Array.from({ length: 450 }, (_, index) => `key-${index}`);
    const sizes: number[] = [];
    let inserted = false;
    const query = async <Row extends object>(sql: string, values?: readonly unknown[]) => {
      if (sql.startsWith('SELECT id::text AS id, key_hash FROM edge_identity')) {
        sizes.push(rowsIn(values));
        return { rows: (inserted ? keys.map((key_hash, index) => ({ id: String(1000 + index), key_hash })) : []) as unknown as Row[] };
      }
      if (sql.startsWith('SELECT nextval')) return { rows: keys.map((_, index) => ({ id: String(1000 + index) })) as unknown as Row[] };
      if (sql.startsWith('INSERT INTO edge_identity')) {
        sizes.push(rowsIn(values));
        inserted = true;
        return { rows: [] as Row[] };
      }
      throw new Error(`unexpected statement: ${sql}`);
    };
    const ctx = context(query);
    await edgeIdentities(ctx, keys);
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(100);
    for (const [index, key] of keys.entries()) expect(ctx.memo.edges.get(key)).toBe(String(1000 + index));
  });

  test('current edge versions and new identity rows are paged too', async () => {
    const ids = Array.from({ length: 450 }, (_, index) => String(index + 1));
    const reads: number[] = [];
    const inserts: number[] = [];
    const query = async <Row extends object>(sql: string, values?: readonly unknown[]) => {
      if (sql.startsWith('SELECT nextval')) return { rows: ids.slice(0, Number(values?.[2])).map((id) => ({ id })) as unknown as Row[] };
      if (sql.startsWith('INSERT INTO node_identity')) {
        inserts.push(rowsIn(values));
        return { rows: [] as Row[] };
      }
      if (sql.includes('WHERE e.edge_id = ANY')) {
        reads.push(rowsIn(values));
        return { rows: [] as Row[] };
      }
      throw new Error(`unexpected statement: ${sql}`);
    };
    const ctx = context(query);
    await newNodeIdentities(ctx, ids.length);
    await currentEdgeVersions(ctx, ids);
    expect(inserts.length).toBeGreaterThan(1);
    expect(reads.length).toBeGreaterThan(1);
    expect(Math.max(...inserts, ...reads)).toBeLessThanOrEqual(100);
  });
});
