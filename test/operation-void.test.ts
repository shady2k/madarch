import { expect, test } from 'bun:test';
import { createTestDatabaseOwner } from './test-database.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { prepareQueueSchema } from '../src/adapters/schemas/queue.js';
import { EMPTY_CONTRACT } from '../src/graph/contract.js';
import { createOperationHost, initializeOperationScope, operationReceipt } from '../src/graph/operation-host.js';
import { startupBinding } from '../src/graph/manifest-publication.js';
import { newUid } from '../src/graph/uid.js';

test('a void operation commits no result and replays without applying again', async () => {
  const owner = await createTestDatabaseOwner({ authenticated: false });
  const queue = await createPgBossQueue({ owner, supervise: false });
  const declaration = { name: 'void-operation', leaseSeconds: 60, retries: 0, retryDelaySeconds: 0, retryBackoff: false };
  try {
    await prepareQueueSchema(owner, { declarations: [declaration] });
    await queue.declare(declaration);
    await queue.enqueue({ queue: declaration.name, data: {} });
    const [job] = await queue.claim({ queue: declaration.name });
    const { binding } = await owner.transaction('write', tx => startupBinding(tx, EMPTY_CONTRACT, 'fixture.void'));
    const runUid = newUid(), unitUid = newUid();
    await owner.transaction('write', tx => initializeOperationScope(tx, EMPTY_CONTRACT, binding, runUid, unitUid));
    const host = createOperationHost({ owner, queue, job: job!, contract: EMPTY_CONTRACT, capability: binding, runUid, unitUid });
    let calls = 0;
    const apply = async (): Promise<void> => { calls++; };
    const request = { key: 'void', request: {} };
    expect(await host.execute(request, apply)).toBeUndefined();
    const receipt = await owner.transaction('snapshot', tx => operationReceipt(tx, EMPTY_CONTRACT, unitUid, request.key));
    expect(receipt).toBeDefined();
    expect(receipt!.result).toBeUndefined();
    expect(await host.execute(request, apply)).toBeUndefined();
    expect(calls).toBe(1);
    expect(await host.execute({ key: 'null', request: {} }, async () => null)).toBeNull();
    expect(await host.execute({ key: 'null', request: {} }, async () => 'not replayed')).toBeNull();
    await expect(host.execute({ key: 'nested', request: {} }, async () => ({ invalid: undefined }))).rejects.toThrow('an assertion value cannot contain undefined');
  } finally {
    await queue.stop();
    await owner.close();
  }
}, 30000);
