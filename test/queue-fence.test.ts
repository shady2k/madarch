import { expect, test } from 'bun:test';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { prepareQueueSchema } from '../src/adapters/schemas/queue.js';
import { createTestDatabaseOwner } from './test-database.js';

const declaration = { name: 'fenced', leaseSeconds: 60, retries: 1, retryDelaySeconds: 0, retryBackoff: false };

test('operation fence checks active attempt and database expiry without supervisor recovery', async () => {
  const owner = await createTestDatabaseOwner({ authenticated: false });
  await prepareQueueSchema(owner, { declarations: [declaration] });
  const queue = await createPgBossQueue({ owner, supervise: false });
  try {
    await queue.declare(declaration);
    await queue.enqueue({ queue: declaration.name, data: {} });
    const [job] = await queue.claim({ queue: declaration.name });
    expect(job).toBeDefined();
    await owner.transaction('write', async (tx) => {
      expect(await queue.fence(job!, tx)).toBe(true);
      expect(await queue.fence({ ...job!, attempt: job!.attempt + 1 }, tx)).toBe(false);
      await tx.query("UPDATE pgboss.job SET started_on = clock_timestamp() - interval '61 seconds' WHERE id = $1", [job!.id]);
      expect(await queue.fence(job!, tx)).toBe(false);
    });
    await owner.run((tx) => tx.query('UPDATE pgboss.job SET started_on = clock_timestamp() WHERE id = $1', [job!.id]));
    await queue.fail(declaration.name, job!, 'retry');
    await owner.transaction('write', async (tx) => { expect(await queue.fence(job!, tx)).toBe(false); });
    const [retried] = await queue.claim({ queue: declaration.name });
    await owner.transaction('write', async (tx) => {
      expect(await queue.fence(job!, tx)).toBe(false);
      expect(await queue.fence(retried!, tx)).toBe(true);
      expect(await queue.complete(declaration.name, retried!, {}, tx)).toBe(true);
      expect(await queue.fence(retried!, tx)).toBe(false);
    });
  } finally {
    await queue.stop();
    await owner.close();
  }
}, 60_000);

test('job lock serializes concurrent completion and rollback preserves the active attempt', async () => {
  const owner = await createTestDatabaseOwner({ authenticated: false });
  await prepareQueueSchema(owner, { declarations: [declaration] });
  const queue = await createPgBossQueue({ owner, supervise: false });
  try {
    await queue.declare(declaration);
    await queue.enqueue({ queue: declaration.name, data: {} });
    const [job] = await queue.claim({ queue: declaration.name });
    let locked!: () => void;
    const lockReady = new Promise<void>((resolve) => { locked = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const writing = owner.transaction('write', async (tx) => {
      expect(await queue.fence(job!, tx)).toBe(true);
      locked();
      await released;
      throw new Error('rollback');
    });
    const rejected = writing.catch(error => error as Error);
    await lockReady;
    const lock = await owner.run((other) => other.query("SELECT id FROM pgboss.job WHERE id = $1 FOR UPDATE SKIP LOCKED", [job!.id]));
    expect(lock.rows).toEqual([]);
    release();
    expect((await rejected).message).toBe('rollback');
    expect(await queue.complete(declaration.name, job!)).toBe(true);
    await owner.transaction('write', async (tx) => { expect(await queue.fence(job!, tx)).toBe(false); });
  } finally {
    await queue.stop();
    await owner.close();
  }
}, 60_000);
