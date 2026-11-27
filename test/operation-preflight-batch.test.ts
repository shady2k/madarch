import { expect, test } from 'bun:test';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import type { OuterTransaction } from '../src/history-types.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { prepareQueueSchema } from '../src/adapters/schemas/queue.js';
import { EMPTY_CONTRACT } from '../src/graph/contract.js';
import { createOperationHost, initializeOperationScope } from '../src/graph/operation-host.js';
import { startupBinding } from '../src/graph/manifest-publication.js';
import { newUid } from '../src/graph/uid.js';
import { createTestDatabaseOwner } from './test-database.js';

test('operation preflight batches selected state and replay precedes attempt authority', async () => {
  const owner = await createTestDatabaseOwner({ authenticated: false });
  const declaration = { name: 'preflight-batch', leaseSeconds: 60, retries: 0, retryDelaySeconds: 0, retryBackoff: false };
  const queue = await createPgBossQueue({ owner, supervise: false });
  try {
    await prepareQueueSchema(owner, { declarations: [declaration] });
    await queue.declare(declaration);
    await queue.enqueue({ queue: declaration.name, data: {} });
    const [job] = await queue.claim({ queue: declaration.name });
    const { binding, contract } = await owner.transaction('write', tx => startupBinding(tx, EMPTY_CONTRACT, 'fixture.preflight'));
    const runUid = newUid(), unitUid = newUid();
    await owner.transaction('write', tx => initializeOperationScope(tx, contract, binding, runUid, unitUid));
    let beforeApply = true;
    const statements: string[] = [];
    const measured: DatabaseOwner = { ...owner, transaction: (kind, work, options) => owner.transaction(kind, tx => {
      const wrapped: OuterTransaction = { ...tx, query: async (sql, values) => {
        if (beforeApply) statements.push(sql);
        return await tx.query(sql, values);
      } };
      return work(wrapped);
    }, options) };
    const authorityQueue = Object.assign(Object.create(queue) as typeof queue, {
      isActive: async (...args: Parameters<typeof queue.isActive>) => {
        if (beforeApply) expect(statements.some(sql => sql.includes('FOR UPDATE'))).toBe(false);
        return await queue.isActive(...args);
      },
    });
    const host = createOperationHost({ owner: measured, queue: authorityQueue, job: job!, contract, capability: binding, runUid, unitUid });
    let calls = 0;
    const request = { key: 'done', request: {}, completion: { output: {}, enqueue: [] } };
    expect(await host.execute(request, async () => { beforeApply = false; return { calls: ++calls }; })).toEqual({ calls: 1 });
    const replay = createOperationHost({ owner, queue: Object.assign(Object.create(queue) as typeof queue, { fence: queue.fence.bind(queue), isActive: async () => { throw new Error('replay checked authority'); } }), job: job!, contract, capability: { ...binding, principalUid: newUid() }, runUid: newUid(), unitUid });
    expect(await replay.execute(request, async () => { calls++; return { calls }; })).toEqual({ calls: 1 });
    await expect(replay.execute({ ...request, request: { changed: true } }, async () => null)).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    expect(calls).toBe(1);
    // The batch read is one statement whose selection is materialized as `batches` and whose rows are ordered by
    // their request; the values, lineage and repository targets ride along as laterals and change nothing here.
    const assertionReads = statements.filter(sql => sql.includes('WITH batches AS MATERIALIZED') && sql.includes('ORDER BY request_index,property_rank,recorded_sequence::bigint'));
    expect(assertionReads).toHaveLength(1);
    expect(assertionReads[0]).toContain('selection_pick');
    expect(statements.filter(sql => sql.includes('SELECT clock_timestamp()::text AS now'))).toHaveLength(0);
  } finally { await queue.stop(); await owner.close(); }
}, 30000);
