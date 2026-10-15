import { expect, test } from 'bun:test';
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
