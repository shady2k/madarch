import { expect, test } from 'bun:test';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { beginRunHeartbeat, stopHeartbeat, type RunClaim } from '../src/fill/orchestrator.js';
import { askFillRun, claimFillRun, openFillRunQueue } from '../src/fill/run-jobs.js';
import { createTestDatabaseOwner } from './test-database.js';

test('the run heartbeats through the queue client that owns its claim, not the units client', async () => {
  const owner = await createTestDatabaseOwner({ authenticated: false });
  const runs = await openFillRunQueue(owner);
  const units = await createPgBossQueue({ owner, supervise: false });
  const orchestrator = { queue: units, heartbeat: { runId: null, timer: undefined, ownerToken: null } } as unknown as Parameters<typeof beginRunHeartbeat>[0];
  try {
    await askFillRun(runs, { product: 'shop', store: 'store', runId: 'claimed-run' });
    const job = await claimFillRun(runs);
    expect(job).not.toBeNull();
    const heartbeat = async () => (await owner.run(tx => tx.query<{ heartbeat_on: Date }>('SELECT heartbeat_on FROM pgboss.job WHERE id = $1', [job!.id]))).rows[0]!.heartbeat_on.getTime();
    const before = await heartbeat();
    const claim: RunClaim = { queue: 'fill-runs', job: job!, queueService: runs };
    beginRunHeartbeat(orchestrator, 'claimed-run', claim);
    await Bun.sleep(5_500);
    expect(await heartbeat()).toBeGreaterThan(before);
  } finally {
    stopHeartbeat(orchestrator);
    await units.stop();
    await runs.stop();
    await owner.close();
  }
}, 15_000);
