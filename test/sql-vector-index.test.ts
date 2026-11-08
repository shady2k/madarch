import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqlQueryDatabase } from '../src/adapters/sql-query-database.js';
import type { SqlExecutor, SqlQueryDriver, SqlTransactionKind } from '../src/query/sql-driver.js';
import type { VectorRecord } from '../src/vector/types.js';
import { createTestQueryDatabase, serverPgVectorVersion } from './test-database.js';
import { skippedBecauseOutOfWorkflow } from './fill-skip-list.js';

/**
 * Why the two search cases below are not run here: the pinned server build
 * carries no pgvector, and the fill-skip list names what brings them back —
 * the vector index's step. A case that the current steps' paths reach is never
 * skipped, and the projection itself opens and answers every graph query.
 */
const VECTOR_STEP = skippedBecauseOutOfWorkflow('test/sql-vector-index.test.ts');
if (VECTOR_STEP === undefined) throw new Error('test/sql-vector-index.test.ts: its search cases must be named in test/fill-skip-list.ts');
const vectorVersion = await serverPgVectorVersion();
const searchable = vectorVersion === '0.8.7';

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

test('a database without pgvector opens for every graph query, and its vector index refuses by name', async () => {
  // The extension is a property of the database, not of the projection's own
  // tables: the graph queries answer on a server that carries no pgvector (the
  // pinned build), and only a vector rebuild or search says what it needs.
  const opened = await createSqlQueryDatabase(testDriver((sql) => {
    if (sql.includes('SELECT extversion')) return [];
    return [];
  }, () => undefined), { location: 'a server without pgvector' });
  try {
    const index = opened.vectorIndexForSources(['s']);
    await expect(index.rebuild(['s'], [])).rejects.toThrow(/the vector index needs pgvector 0\.8\.7, and "a server without pgvector" carries none/);
    await expect(index.search({ space: 'x', vector: [1], metric: 'l2', limit: 1 })).rejects.toThrow(/every graph query answers/);
    await index.close();
  } finally {
    await opened.close();
  }
});

test('a database whose pgvector is another version is refused at open, naming both versions', async () => {
  let mismatchedClosed = false;
  const mismatchedDriver = testDriver(
    (sql) => sql.includes('SELECT extversion') ? [{ extversion: '0.8.6' }] : [],
    () => { mismatchedClosed = true; },
  );
  await expect(createSqlQueryDatabase(mismatchedDriver)).rejects.toThrow(/has pgvector 0\.8\.6, and this build needs exactly 0\.8\.7/);
  expect(mismatchedClosed).toBe(true);
});

test.skipIf(!searchable)(`Vector search on a server is exact, deterministic, and source scoped (${VECTOR_STEP?.brings}: ${VECTOR_STEP?.because})`, async () => {
  const database = await createTestQueryDatabase();
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

test.skipIf(!searchable)(`a store's server preserves vector results across close and reopen (${VECTOR_STEP?.brings})`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'madarch-vector-index-'));
  const path = join(directory, 'vector-db');
  const source = `persist-${crypto.randomUUID()}`;
  const space = `persist-space-${crypto.randomUUID()}`;
  try {
    const first = await createTestQueryDatabase({ store: path });
    const firstIndex = first.vectorIndexForSources([source]);
    await firstIndex.rebuild([source], [record(source, space, 'kept', [0.25, 0.75])]);
    const before = await firstIndex.search({ space, vector: [0, 0], metric: 'l2', limit: 1 });
    await first.close();

    const reopened = await createTestQueryDatabase({ store: path });
    try {
      expect(await reopened.vectorIndexForSources([source]).search({ space, vector: [0, 0], metric: 'l2', limit: 1 })).toEqual(before);
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
