import { expect, test } from 'bun:test';
import { createPostgresDatabaseOwner } from '../src/adapters/database-owner.js';
import { CLUSTER_PORT } from '../src/adapters/postgres-cluster.js';

async function fixture() {
  const options = { host: process.env['MADARCH_TEST_PG_SOCKET']!, port: CLUSTER_PORT, user: 'postgres', database: 'postgres', max: 1 };
  const owner = await createPostgresDatabaseOwner(options);
  const observer = await createPostgresDatabaseOwner(options);
  await owner.run(async tx => {
    await tx.query('CREATE TEMP TABLE cancellation_probe (value integer)');
    await tx.query('CREATE TEMP SEQUENCE cancellation_queued');
  });
  return { owner, observer };
}

test('abort cancels active SQL, skips queued SQL, rolls back and safely reuses the connection', async () => {
  const { owner, observer } = await fixture();
  const abort = new AbortController();
  const reason = new Error('publication cancelled');
  let pid = 0;
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  try {
    const transaction = owner.transaction('write', async tx => {
      pid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      await tx.query('INSERT INTO cancellation_probe VALUES (1)');
      const active = tx.query('SELECT pg_sleep(60)');
      const queued = tx.query("SELECT nextval('cancellation_queued')");
      began();
      const results = await Promise.allSettled([active, queued]);
      expect(results.every(result => result.status === 'rejected')).toBe(true);
      // Swallowing the statement refusals must not let the transaction commit.
    }, { signal: abort.signal });
    const refused = transaction.then(() => undefined, error => error);
    await started;
    let sleeping = false;
    const deadline = Date.now() + 2000;
    while (!sleeping && Date.now() < deadline) {
      sleeping = await observer.run(async tx => (await tx.query<{ sleeping: boolean }>("SELECT wait_event = 'PgSleep' AS sleeping FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.sleeping === true);
      if (!sleeping) await Bun.sleep(5);
    }
    expect(sleeping).toBe(true);
    abort.abort(reason);
    expect(await refused).toBe(reason);
    const read = await owner.run(async tx => ({
      rows: (await tx.query('SELECT * FROM cancellation_probe')).rows,
      sequence: (await tx.query<{ is_called: boolean }>('SELECT is_called FROM cancellation_queued')).rows[0]!.is_called,
      pid: (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid,
    }));
    expect(read).toEqual({ rows: [], sequence: false, pid });
    await owner.transaction('write', async tx => { await tx.query('INSERT INTO cancellation_probe VALUES (2)'); });
    expect(await owner.run(async tx => (await tx.query('SELECT value FROM cancellation_probe')).rows)).toEqual([{ value: 2 }]);
  } finally { abort.abort(reason); await owner.close(); await observer.close(); }
}, 10000);

test('abort while waiting for a pool connection never runs the callback', async () => {
  const { owner, observer } = await fixture();
  let release!: () => void;
  let began!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { began = resolve; });
  const abort = new AbortController();
  let called = false;
  try {
    const first = owner.transaction('snapshot', async () => { began(); await held; });
    await started;
    const second = owner.transaction('write', async () => { called = true; }, { signal: abort.signal });
    const refused = second.then(() => undefined, error => error);
    abort.abort();
    release();
    await first;
    expect(await refused).toBe(abort.signal.reason);
    expect(called).toBe(false);
  } finally { release(); await owner.close(); await observer.close(); }
});

test('abort after successful statements fences COMMIT and rolls back', async () => {
  const { owner, observer } = await fixture();
  const abort = new AbortController();
  const reason = new Error('cancel before commit');
  try {
    await expect(owner.transaction('write', async tx => {
      await tx.query('INSERT INTO cancellation_probe VALUES (1)');
      abort.abort(reason);
    }, { signal: abort.signal })).rejects.toBe(reason);
    expect(await owner.run(async tx => (await tx.query('SELECT * FROM cancellation_probe')).rows)).toEqual([]);
  } finally { await owner.close(); await observer.close(); }
});
