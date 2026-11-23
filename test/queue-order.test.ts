import { expect, test } from 'bun:test';
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { prepareQueueSchema } from '../src/adapters/schemas/queue.js';
import type { OuterTransaction } from '../src/history-types.js';
import { createTestDatabaseOwner, testStoreServer } from './test-database.js';

const declaration = { name: 'ordered', leaseSeconds: 60, retries: 2, retryDelaySeconds: 0, retryBackoff: false };
const ids = [5, 4, 3, 2, 1].map(n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const tick = '2026-01-01T00:00:00.000Z';

/** Hold the producer's clock and pg-boss's generated IDs against enqueue order. */
function producer(tx: OuterTransaction): OuterTransaction {
  let sent = 0;
  return {
    async query<Row extends object>(sql: string, values?: readonly unknown[]): Promise<{ rows: Row[] }> {
      if (sql.includes('INSERT INTO pgboss.job')) {
        const jobs = JSON.parse(values![0] as string) as Array<{ id: string }>;
        jobs[0]!.id = ids[sent++]!;
        values = [JSON.stringify(jobs)];
      }
      return await tx.query<Row>(sql.replaceAll('clock_timestamp()', `'${tick}'::timestamptz`), values);
    },
  };
}

test('a frozen-clock transaction selects exactly the five enqueues, not UUID order, across the limit', async () => {
  const owner = await createTestDatabaseOwner({ authenticated: false });
  const queue = await createPgBossQueue({ owner, supervise: false });
  try {
    await prepareQueueSchema(owner, { declarations: [declaration] });
    await queue.declare(declaration);
    await owner.exec(`CREATE OR REPLACE FUNCTION pgboss.job_now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT '${tick}'::timestamptz $$`);
    await owner.transaction('write', async tx => {
      const transaction = producer(tx);
      for (let n = 1; n <= 5; n++) await queue.enqueue({ queue: declaration.name, data: { n }, transaction });
    });
    const first = await queue.claim<{ n: number }>({ queue: declaration.name, limit: 2 });
    const rest = await queue.claim<{ n: number }>({ queue: declaration.name, limit: 3 });
    expect(first.map(job => job.data.n)).toEqual([1, 2]);
    expect(rest.map(job => job.data.n)).toEqual([3, 4, 5]);
    expect(new Set([...first, ...rest].map(job => job.id)).size).toBe(5);
    expect([...first, ...rest].map(job => job.id)).toEqual(ids);
    expect(await queue.claim({ queue: declaration.name, limit: 5 })).toEqual([]);
    const times = await owner.run(tx => tx.query<{ time: string }>("SELECT created_on::text AS time FROM pgboss.job ORDER BY created_on"));
    expect(times.rows.map(row => Date.parse(row.time))).toEqual(ids.map((_, i) => Date.parse(tick) + i));
  } finally { await queue.stop(); await owner.close(); }
}, 60_000);

test('overlapping producers serialize retained active and retry jobs; rollback loses its job and place', async () => {
  const database = `queue_producers_${process.pid}`;
  const owner = await createTestDatabaseOwner({ database, authenticated: false });
  const server = await testStoreServer();
  const other = await createDatabaseOwner({ cluster: { socketDir: server.socketDir }, database, connectOnly: true });
  await prepareQueueSchema(owner, { declarations: [declaration] });
  const queue = await createPgBossQueue({ owner, supervise: false });
  const second = await createPgBossQueue({ owner: other, supervise: false });
  try {
    await queue.declare(declaration);
    await second.declare(declaration);
    // A retained active/retry row may be ahead of the current clock.
    const original = await queue.enqueue({ queue: declaration.name, data: { n: 0 } });
    const [active] = await queue.claim({ queue: declaration.name });
    await owner.run(tx => tx.query("UPDATE pgboss.job SET created_on = clock_timestamp() + interval '1 day' WHERE id = $1", [original.id]));
    for (const rollback of [false, true]) {
      let unlock!: () => void;
      const held = new Promise<void>(resolve => { unlock = resolve; });
      let entered!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const first = owner.transaction('write', async transaction => {
        await queue.enqueue({ queue: declaration.name, data: { n: rollback ? 99 : 1 }, transaction });
        entered();
        await held;
        if (rollback) throw new Error('rollback producer');
      }).catch(error => error as Error);
      await ready;
      let otherPid = 0;
      const next = other.transaction('write', async transaction => {
        otherPid = (await transaction.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        return await second.enqueue({ queue: declaration.name, data: { n: rollback ? 3 : 2 }, transaction });
      });
      try {
        // Wait for the second connection to reach its lock wait, not a sleep-based race.
        let waiting = false;
        for (let attempt = 0; attempt < 200; attempt++) {
          const state = await owner.run(tx => tx.query<{ waiting: boolean }>("SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1", [otherPid]));
          if (state.rows[0]?.waiting === true) { waiting = true; break; }
        }
        expect(waiting).toBe(true);
      } finally { unlock(); }
      const result = await first;
      await next;
      if (rollback) expect((result as Error).message).toBe('rollback producer');
      // The retry horizon must survive as well as the active horizon.
      if (!rollback) await queue.fail(declaration.name, active!, 'retry original');
    }
    const rows = await owner.run(tx => tx.query<{ n: number; time: string }>("SELECT (data->>'n')::int AS n, created_on::text AS time FROM pgboss.job ORDER BY created_on"));
    expect(rows.rows.map(row => row.n)).toEqual([0, 1, 2, 3]);
    expect(new Set(rows.rows.map(row => row.time)).size).toBe(4);
    const times = rows.rows.map(row => Date.parse(row.time));
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(1);
    expect(times[3]! - times[2]!).toBe(1);
    expect((await queue.claim<{ n: number }>({ queue: declaration.name, limit: 2 })).map(job => job.data.n)).toEqual([0, 1]);
    expect((await queue.claim<{ n: number }>({ queue: declaration.name, limit: 2 })).map(job => job.data.n)).toEqual([2, 3]);
    expect(await queue.claim({ queue: declaration.name })).toEqual([]);
  } finally { await second.stop(); await queue.stop(); await other.close(); await owner.close(); }
}, 60_000);

test('priority decides limited membership, distinct creation times decide age, and external ties sort selected IDs', async () => {
  const owner = await createTestDatabaseOwner({ authenticated: false });
  await prepareQueueSchema(owner, { declarations: [declaration] });
  const queue = await createPgBossQueue({ owner, supervise: false });
  try {
    await queue.declare(declaration);
    for (const [n, priority] of [[1, 0], [2, 0], [3, 9]] as const) {
      await owner.transaction('write', async tx => {
        const transaction: OuterTransaction = {
          query: (sql, values) => tx.query(sql.replaceAll('clock_timestamp()', `'2026-01-0${n}T00:00:00Z'::timestamptz`), values),
        };
        await queue.enqueue({ queue: declaration.name, data: { n }, priority, transaction });
      });
    }
    expect((await queue.claim<{ n: number }>({ queue: declaration.name, limit: 2 })).map(job => job.data.n)).toEqual([3, 1]);
    expect((await queue.claim<{ n: number }>({ queue: declaration.name })).map(job => job.data.n)).toEqual([2]);
    await owner.run(tx => tx.query(`INSERT INTO pgboss.job (id, name, data, created_on)
      SELECT id::uuid, $1, '{}'::jsonb, '${tick}'::timestamptz FROM unnest($2::text[]) AS id`, [declaration.name, ids]));
    const selected = await queue.claim({ queue: declaration.name, limit: 2 });
    expect(selected).toHaveLength(2);
    expect(selected.map(job => job.id)).toEqual(selected.map(job => job.id).sort());
    expect(selected.every(job => ids.includes(job.id))).toBe(true);
    const rest = await queue.claim({ queue: declaration.name, limit: 3 });
    expect(rest).toHaveLength(3);
    expect(rest.map(job => job.id)).toEqual(rest.map(job => job.id).sort());
    expect(new Set([...selected, ...rest].map(job => job.id)).size).toBe(5);
    expect(await queue.claim({ queue: declaration.name })).toEqual([]);
  } finally { await queue.stop(); await owner.close(); }
}, 60_000);
