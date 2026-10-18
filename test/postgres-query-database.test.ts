import { expect, test } from 'bun:test';
import { createPostgresDatabaseOwner } from '../src/adapters/database-owner.js';
import { createPostgresQueryDatabase } from '../src/adapters/postgres-query-database.js';
import type { AssertionRecord } from '../src/history/types.js';
import type { ChildrenResult } from '../src/query/types.js';

const DAY = (day: number) => Date.UTC(2026, 8, day);
const AT = { valid: DAY(20), known: DAY(20), state: 'as-is' };
const connectionString = process.env['MADARCH_TEST_POSTGRES_URL'];

function element(source: string, id: string, kind: string, ancestors: string[], parent?: string): AssertionRecord {
  const content = JSON.stringify({ id, kind, ancestors, states: ['as-is'], ...(parent === undefined ? {} : { parent }) });
  return { source, kind: 'element', id, content, validFrom: DAY(1), validTo: null, recordedFrom: DAY(1), recordedTo: null };
}

function relation(source: string, id: string, from: string, to: string): AssertionRecord {
  const content = JSON.stringify({ id, from, to, states: ['as-is'] });
  return { source, kind: 'relation', id, content, validFrom: DAY(1), validTo: null, recordedFrom: DAY(1), recordedTo: null };
}

test.skipIf(connectionString === undefined)(
  'the pg adapter uses repeatable-read snapshots, source-scoped rows and the shared writer-fair gate',
  async () => {
    const database = await createPostgresQueryDatabase({ connectionString: connectionString!, max: 4 });
    let ownerClosed = false;
    const nonce = crypto.randomUUID();
    const sourceAName = `pg-${nonce}-a`;
    const sourceBName = `pg-${nonce}-b`;
    const orders = `orders-${nonce}`;
    const bus = `event-bus-${nonce}`;
    const worker = `worker-${nonce}`;
    const publish = `orders-publishes-${nonce}`;
    const consumes = `bus-uses-worker-${nonce}`;
    const sourceA = database.forSources([sourceAName]);
    const sourceB = database.forSources([sourceBName]);
    const union = database.forSources([sourceAName, sourceBName]);
    try {
      await sourceA.rebuild([
        element(sourceAName, orders, 'service', []),
        relation(sourceAName, publish, orders, bus),
      ]);
      await sourceB.rebuild([
        element(sourceBName, bus, 'broker', []),
        element(sourceBName, worker, 'service', [bus], bus),
        relation(sourceBName, consumes, bus, worker),
      ]);

      expect((await sourceA.children(bus, AT)).error).toMatchObject({ id: bus, time: DAY(20) });
      expect((await sourceB.children(orders, AT)).error).toMatchObject({ id: orders, time: DAY(20) });
      const traversal = await union.dependencies(orders, { transitive: true }, AT);
      expect(traversal.elements).toEqual([
        { id: bus, chain: [publish] },
        { id: worker, chain: [publish, consumes] },
      ]);

      await expect(sourceA.rebuild([
        element(sourceAName, orders, 'service', []),
        element(sourceAName, orders, 'service', []),
      ])).rejects.toThrow();
      expect((await union.dependencies(orders, { transitive: true }, AT)).elements?.map(({ id }) => id)).toEqual([bus, worker]);

      let signalEntered!: () => void;
      let releaseSnapshot!: () => void;
      const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
      const release = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
      const firstSnapshot = union.withSnapshot(async (snapshot) => {
        try {
          await expect(sourceB.children(bus, AT)).rejects.toThrow(/inside withSnapshot/i);
        } finally {
          signalEntered();
        }
        await release;
        return snapshot.dependencies(orders, { transitive: true }, AT);
      });
      void firstSnapshot.catch(() => signalEntered());

      let updateSettled = false;
      let update: Promise<void> | undefined;
      let laterSnapshot: Promise<ChildrenResult> | undefined;
      try {
        await entered;
        update = sourceB.update([element(sourceBName, `new-${worker}`, 'service', [bus], bus)], [])
          .finally(() => { updateSettled = true; });
        laterSnapshot = sourceB.withSnapshot((snapshot) => snapshot.children(bus, AT));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(updateSettled).toBe(false);
      } finally {
        releaseSnapshot();
        const pending: Promise<unknown>[] = [firstSnapshot];
        if (update !== undefined) pending.push(update);
        if (laterSnapshot !== undefined) pending.push(laterSnapshot);
        await Promise.allSettled(pending);
      }

      expect((await firstSnapshot).elements?.map(({ id }) => id)).toEqual([bus, worker]);
      await update!;
      expect((await laterSnapshot!).elements?.map(({ id }) => id)).toEqual([`new-${worker}`, worker]);

      const currentWorker = element(sourceBName, worker, 'service', [bus], bus);
      const closedWorker = { ...currentWorker, recordedTo: DAY(10) };
      await expect(sourceB.update([currentWorker], [closedWorker])).rejects.toThrow();
      expect((await sourceB.children(bus, AT)).elements?.map(({ id }) => id)).toEqual([`new-${worker}`, worker]);

      await sourceA.close();
      expect((await sourceB.children(bus, AT)).elements).toHaveLength(2);
      await union.rebuild([]);
      await database.close();
      ownerClosed = true;
      await expect(sourceB.children(bus, AT)).rejects.toThrow(/closed/i);
    } finally {
      if (!ownerClosed) {
        await union.rebuild([]).catch(() => {});
        await database.close();
      }
    }
  },
  30_000,
);

test.skipIf(connectionString === undefined)(
  'PostgreSQL 17 pgvector is pinned and answers caller-supplied vector searches',
  async () => {
    const database = await createPostgresQueryDatabase({ connectionString: connectionString!, max: 4 });
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: connectionString!, max: 1 });
    const source = `vector-${crypto.randomUUID()}`;
    const space = `vector-space-${crypto.randomUUID()}`;
    const index = database.vectorIndexForSources([source]);
    try {
      const extension = await pool.query<{ extversion: string }>(
        `SELECT extversion FROM pg_extension WHERE extname = 'vector'`,
      );
      expect(extension.rows).toEqual([{ extversion: '0.8.7' }]);
      await index.rebuild([source], [
        { source, space, itemId: 'nearest', vector: [1, 0] },
        { source, space, itemId: 'other', vector: [0, 1] },
      ]);
      expect(await index.search({ space, vector: [0, 0], metric: 'l2', limit: 2 })).toEqual([
        { source, itemId: 'nearest', distance: 1 },
        { source, itemId: 'other', distance: 1 },
      ]);
      expect(await index.search({ space, vector: [1, 0], metric: 'cosine', limit: 2 })).toEqual([
        { source, itemId: 'nearest', distance: 0 },
        { source, itemId: 'other', distance: 1 },
      ]);
      expect(await index.search({ space, vector: [1, 2], metric: 'innerProduct', limit: 2 })).toEqual([
        { source, itemId: 'other', distance: -2 },
        { source, itemId: 'nearest', distance: -1 },
      ]);

      await index.rebuild([source], [{ source, space, itemId: 'kept', vector: [0, 1] }]);
      const suffix = crypto.randomUUID().replaceAll('-', '_');
      const functionName = `madarch_vector_fail_${suffix}`;
      const triggerName = `madarch_vector_fail_${suffix}`;
      let functionCreated = false;
      let triggerCreated = false;
      try {
        await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $body$
          BEGIN
            IF NEW.item_id = 'force_failure' THEN RAISE EXCEPTION 'forced vector insert failure'; END IF;
            RETURN NEW;
          END
        $body$`);
        functionCreated = true;
        await pool.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON vector_items FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
        triggerCreated = true;
        await expect(index.rebuild([source], [{ source, space, itemId: 'force_failure', vector: [1, 0] }]))
          .rejects.toThrow(/forced vector insert failure/);
        expect(await index.search({ space, vector: [0, 1], metric: 'l2', limit: 1 })).toEqual([
          { source, itemId: 'kept', distance: 0 },
        ]);
      } finally {
        try {
          if (triggerCreated) await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON vector_items`);
        } finally {
          if (functionCreated) await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
        }
      }
    } finally {
      await index.rebuild([source], []).catch(() => {});
      await index.close();
      await database.close();
      await pool.end();
    }
  },
  30_000,
);

test.skipIf(connectionString === undefined)(
  'one PostgreSQL owner carries a projection write and a read in one transaction, and neither after a rollback',
  async () => {
    const owner = await createPostgresDatabaseOwner({ connectionString: connectionString!, max: 4 });
    const database = await createPostgresQueryDatabase({ owner });
    const nonce = crypto.randomUUID();
    const source = `pg-owner-${nonce}`;
    const orders = `orders-${nonce}`;
    const worker = `worker-${nonce}`;
    const rejected = `rejected-${nonce}`;
    const engine = database.forSources([source]);
    try {
      // One transaction of the shared owner holds the write and the read that
      // follows it, and the write is there once it commits.
      const rows = [
        element(source, orders, 'service', []),
        element(source, worker, 'service', [orders], orders),
      ];
      await owner.transaction('write', async (transaction) => {
        await engine.rebuild(rows, transaction);
        const inside = await engine.withSnapshot(async (snapshot) => await snapshot.children(orders, AT), transaction);
        expect(inside.elements?.map(({ id }) => id)).toEqual([worker]);
      });
      expect((await engine.children(orders, AT)).elements?.map(({ id }) => id)).toEqual([worker]);

      // The same write in a transaction that rolls back leaves no trace.
      await expect(owner.transaction('write', async (transaction) => {
        await engine.update([element(source, rejected, 'service', [orders], orders)], [], transaction);
        const inside = await engine.withSnapshot(async (snapshot) => await snapshot.children(orders, AT), transaction);
        expect(inside.elements?.map(({ id }) => id)).toEqual([rejected, worker]);
        throw new Error('rolled back on purpose');
      })).rejects.toThrow('rolled back on purpose');
      expect((await engine.children(orders, AT)).elements?.map(({ id }) => id)).toEqual([worker]);

      await engine.rebuild([]);
      // The query database borrowed the owner: closing it leaves the pool open.
      await database.close();
      await owner.run(async (transaction) => await transaction.query('SELECT 1'));
      await owner.close();
      await expect(owner.run(async (transaction) => await transaction.query('SELECT 1'))).rejects.toThrow(/is closed/);
    } finally {
      await database.close().catch(() => {});
      await owner.close().catch(() => {});
    }
  },
  30_000,
);
