import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteQueryDatabase } from '../src/adapters/pglite-query-database.js';
import { createSqlQueryDatabase } from '../src/adapters/sql-query-database.js';
import type { SqlExecutor, SqlQueryDriver, SqlTransactionKind } from '../src/query/sql-driver.js';
import type { VectorRecord } from '../src/vector/types.js';

function record(source: string, space: string, itemId: string, vector: readonly number[]): VectorRecord {
  return { source, space, itemId, vector };
}

function testDriver(
  rowsFor: (sql: string) => readonly Record<string, unknown>[],
  onClose: () => void,
): SqlQueryDriver {
  return {
    allowConcurrentSnapshots: false,
    transaction<T>(_kind: SqlTransactionKind, work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
      const executor: SqlExecutor = {
        query: async <Row extends Record<string, unknown>>(sql: string) => ({ rows: rowsFor(sql) as unknown as Row[] }),
      };
      return work(executor);
    },
    async close() { onClose(); },
  };
}

test('SQL owner fails closed when pgvector is missing or has the wrong version', async () => {
  let missingClosed = false;
  const missingDriver = testDriver((sql) => {
    if (sql === 'CREATE EXTENSION IF NOT EXISTS vector') throw new Error('extension "vector" is not available');
    return [];
  }, () => { missingClosed = true; });
  await expect(createSqlQueryDatabase(missingDriver)).rejects.toThrow(/extension "vector" is not available/);
  expect(missingClosed).toBe(true);

  let mismatchedClosed = false;
  const mismatchedDriver = testDriver(
    (sql) => sql.includes('SELECT extversion') ? [{ extversion: '0.8.6' }] : [],
    () => { mismatchedClosed = true; },
  );
  await expect(createSqlQueryDatabase(mismatchedDriver)).rejects.toThrow(/requires pgvector 0.8.7; found 0.8.6/);
  expect(mismatchedClosed).toBe(true);
});

test('PGlite vector search is exact, deterministic, and source scoped', async () => {
  const database = await createPGliteQueryDatabase();
  const space = `vectors-${crypto.randomUUID()}`;
  const sourceA = `source-a-${crypto.randomUUID()}`;
  const sourceB = `source-b-${crypto.randomUUID()}`;
  const onlyA = database.vectorIndexForSources([sourceA]);
  const onlyB = database.vectorIndexForSources([sourceB]);
  const union = database.vectorIndexForSources([sourceB, sourceA]);
  try {
    expect(() => database.vectorIndexForSources(['bad\u0000source'])).toThrow(/zero byte/);
    await onlyA.rebuild([sourceA], [
      record(sourceA, space, 'a', [1, 0]),
      record(sourceA, space, 'same', [0, 1]),
    ]);
    await onlyB.rebuild([sourceB], [record(sourceB, space, 'same', [1, 0])]);

    expect(await union.search({ space, vector: [0, 0], metric: 'l2', limit: 10 })).toEqual([
      { source: sourceA, itemId: 'a', distance: 1 },
      { source: sourceA, itemId: 'same', distance: 1 },
      { source: sourceB, itemId: 'same', distance: 1 },
    ]);
    expect(await onlyA.search({ space, vector: [1, 0], metric: 'cosine', limit: 10 })).toEqual([
      { source: sourceA, itemId: 'a', distance: 0 },
      { source: sourceA, itemId: 'same', distance: 1 },
    ]);
    expect(await union.search({ space, vector: [1, 2], metric: 'innerProduct', limit: 1 })).toEqual([
      { source: sourceA, itemId: 'same', distance: -2 },
    ]);

    await expect(onlyA.rebuild([], [record(sourceA, space, 'must-not-be-dropped', [1, 0])]))
      .rejects.toThrow(/without selected sources/);
    await expect(onlyA.rebuild([sourceB], [])).rejects.toThrow(/outside this index scope/);
    await expect(onlyA.rebuild(['bad\u0000source'], [])).rejects.toThrow(/zero byte/);
    await expect(onlyA.rebuild([sourceA], [record(sourceA, space, 'bad-dimension', [1, 0, 0])])).rejects.toThrow(/different dimension/);
    await expect(onlyA.rebuild([sourceA], [record(sourceA, space, 'too-many-dimensions', Array(2_001).fill(1))]))
      .rejects.toThrow(/between 1 and 2000 dimensions/);
    await expect(onlyA.rebuild([sourceA], [
      record(sourceA, space, 'duplicate', [1, 0]),
      record(sourceA, space, 'duplicate', [0, 1]),
    ])).rejects.toThrow(/duplicate vector identity/);
    expect(await onlyA.search({ space, vector: [0, 0], metric: 'l2', limit: 10 })).toHaveLength(2);
    expect((await onlyB.search({ space, vector: [0, 0], metric: 'l2', limit: 10 })).map(({ itemId }) => itemId)).toEqual(['same']);

    await expect(onlyA.search({ space, vector: [0, 0], metric: 'cosine', limit: 10 })).rejects.toThrow(/zero vector/);
    await expect(onlyA.search({ space, vector: [1, 0, 0], metric: 'l2', limit: 10 })).rejects.toThrow(/does not match/);
    await expect(onlyA.search({ space, vector: [1, 0], metric: 'l2', limit: 0 })).rejects.toThrow(/positive safe integer/);
    await expect(onlyA.search({ space, vector: [Number.NaN, 0], metric: 'l2', limit: 1 })).rejects.toThrow(/finite numbers/);
    await expect(onlyA.search({ space, vector: [1e300, 0], metric: 'l2', limit: 1 })).rejects.toThrow(/float32 range/);
    await expect(onlyA.rebuild([sourceA], [record(sourceA, space, 'zero-stored', [0, 0])])).rejects.toThrow(/zero vector/);
    await expect(onlyA.rebuild([sourceA], [record(sourceA, space, 'underflow-zero', [1e-100, 0])])).rejects.toThrow(/zero vector/);
    await expect(onlyA.rebuild([sourceA], [record(sourceA, space, 'bad\u0000id', [1, 0])])).rejects.toThrow(/zero byte/);
    expect(await onlyA.search({ space, vector: [0, 0], metric: 'l2', limit: 10 })).toHaveLength(2);

    await onlyA.rebuild([sourceA], []);
    expect(await onlyA.search({ space, vector: [0, 0], metric: 'l2', limit: 10 })).toEqual([]);
    expect((await onlyB.search({ space, vector: [0, 0], metric: 'l2', limit: 10 })).map(({ itemId }) => itemId)).toEqual(['same']);

    const graph = database.forSources([sourceA]);
    await expect(graph.withSnapshot(async () => onlyB.search({ space, vector: [0, 0], metric: 'l2', limit: 1 })))
      .rejects.toThrow('do not call the query engine from inside withSnapshot; use the supplied snapshot reader');
    await onlyA.close();
    await expect(onlyA.search({ space, vector: [0, 0], metric: 'l2', limit: 1 })).rejects.toThrow(/closed/);
    expect(await onlyB.search({ space, vector: [0, 0], metric: 'l2', limit: 1 })).toHaveLength(1);
    await database.close();
    await expect(onlyB.search({ space, vector: [0, 0], metric: 'l2', limit: 1 })).rejects.toThrow(/closed/);
  } finally {
    await database.close();
  }
});

test('file-backed PGlite preserves vector results across close and reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'madarch-vector-index-'));
  const path = join(directory, 'vector-db');
  const source = `persist-${crypto.randomUUID()}`;
  const space = `persist-space-${crypto.randomUUID()}`;
  try {
    const first = await createPGliteQueryDatabase({ path });
    const firstIndex = first.vectorIndexForSources([source]);
    await firstIndex.rebuild([source], [record(source, space, 'kept', [0.25, 0.75])]);
    const before = await firstIndex.search({ space, vector: [0, 0], metric: 'l2', limit: 1 });
    await first.close();

    const reopened = await createPGliteQueryDatabase({ path });
    try {
      expect(await reopened.vectorIndexForSources([source]).search({ space, vector: [0, 0], metric: 'l2', limit: 1 })).toEqual(before);
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
