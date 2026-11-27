/**
 * What an operation states, and when (madarch-64o5.176, F4).
 *
 * A producer's `apply` runs between the operation's own statement and its receipt. Two reads of the
 * order matter there: the operation must already stand when the producer writes (its write may name
 * the operation it writes under), and the counter and scope the receipt completes must be read after
 * the producer has written, because the producer may state them itself.
 */
import { expect, test } from 'bun:test';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { prepareQueueSchema } from '../src/adapters/schemas/queue.js';
import { EMPTY_CONTRACT } from '../src/graph/contract.js';
import { createOperationHost, initializeOperationScope } from '../src/graph/operation-host.js';
import { startupBinding } from '../src/graph/manifest-publication.js';
import { publicationReadSelector } from '../src/graph/publication-contract.js';
import { readKindAssertions } from '../src/graph/records.js';
import { newUid } from '../src/graph/uid.js';
import { publishGraphDrafts, writeAssertions } from '../src/graph/write.js';
import { createTestDatabaseOwner } from './test-database.js';

async function operationFixture() {
  const owner = await createTestDatabaseOwner({ authenticated: false });
  const queue = await createPgBossQueue({ owner, supervise: false });
  const declaration = { name: 'host-order', leaseSeconds: 60, retries: 0, retryDelaySeconds: 0, retryBackoff: false };
  await prepareQueueSchema(owner, { declarations: [declaration] });
  await queue.declare(declaration);
  await queue.enqueue({ queue: declaration.name, data: {} });
  const [job] = await queue.claim({ queue: declaration.name });
  const { binding, contract } = await owner.transaction('write', tx => startupBinding(tx, EMPTY_CONTRACT, 'fixture.host-order'));
  const runUid = newUid(), unitUid = newUid();
  await owner.transaction('write', tx => initializeOperationScope(tx, contract, binding, runUid, unitUid));
  const host = createOperationHost({ owner, queue, job: job!, contract, capability: binding, runUid, unitUid });
  return { owner, queue, binding, contract, host, unitUid, close: async () => { await queue.stop(); await owner.close(); } };
}

test('a producer may name the operation it writes under', async () => {
  const fixture = await operationFixture();
  try {
    let operationUid = '';
    const result = await fixture.host.execute({ key: 'self-mention', request: {} }, async (tx, context) => {
      operationUid = context.operationUid;
      // The operation states where its own record is written, and the record names the operation:
      // the mention's target must be an active vertex by the time this write is validated.
      await publishGraphDrafts(tx, fixture.contract, { vertices: [{
        kind: 'system.operation', uid: context.operationUid, key: {}, values: { words: `stated under [[uid:${context.operationUid}]]` },
        producer: fixture.binding.sourceUid, producerVersion: '1',
      }], removals: [] });
      return { accepted: true };
    });
    expect(result).toEqual({ accepted: true });
    const words = await fixture.owner.transaction('snapshot', async tx =>
      (await readKindAssertions(tx, 'vertex', 'system.operation', ['words'], await publicationReadSelector(tx, fixture.contract)))
        .filter(row => row.uid === operationUid).map(row => row.values['words']));
    expect(words).toEqual([`stated under [[uid:${operationUid}]]`]);
  } finally { await fixture.close(); }
}, 60_000);

test('the receipt raises the counter a producer stated inside the operation', async () => {
  const fixture = await operationFixture();
  try {
    await fixture.host.execute({ key: 'counted', request: {} }, async tx => {
      const subjectId = (await tx.query<{ id: string }>('SELECT id::text AS id FROM node WHERE uid=$1::uuid', [fixture.unitUid])).rows[0]!.id;
      await writeAssertions(tx, fixture.contract, [{ sort: 'vertex', kind: 'system.unit', subjectId, property: 'committed_operations', operation: 'assert', value: 7 }]);
      return { accepted: true };
    });
    const held = await fixture.owner.transaction('snapshot', async tx =>
      (await readKindAssertions(tx, 'vertex', 'system.unit', ['committed_operations', 'last_progress'], await publicationReadSelector(tx, fixture.contract)))
        .find(row => row.uid === fixture.unitUid)?.values);
    // The producer raised the counter to seven inside its own operation; the receipt is the eighth.
    expect(held).toMatchObject({ committed_operations: 8, last_progress: 'counted' });
  } finally { await fixture.close(); }
}, 60_000);
