import { expect, test } from 'bun:test';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import type { OuterTransaction } from '../src/history-types.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { prepareQueueSchema } from '../src/adapters/schemas/queue.js';
import { EMPTY_CONTRACT } from '../src/graph/contract.js';
import { createOperationHost, initializeOperationScope, operationReceipt } from '../src/graph/operation-host.js';
import { startupBinding } from '../src/graph/manifest-publication.js';
import { newUid } from '../src/graph/uid.js';
import { readKindAssertions } from '../src/graph/records.js';
import { publicationReadSelector } from '../src/graph/publication-contract.js';
import { createTestDatabaseOwner } from './test-database.js';

test('operation linkage and receipt counters share one PostgreSQL admission round', async () => {
  const owner = await createTestDatabaseOwner({ authenticated: false });
  const queue = await createPgBossQueue({ owner, supervise: false });
  const declaration = { name: 'publication-batch', leaseSeconds: 60, retries: 0, retryDelaySeconds: 0, retryBackoff: false };
  try {
    await prepareQueueSchema(owner, { declarations: [declaration] });
    await queue.declare(declaration);
    await queue.enqueue({ queue: declaration.name, data: {} });
    const [job] = await queue.claim({ queue: declaration.name });
    const { binding, contract } = await owner.transaction('write', tx => startupBinding(tx, EMPTY_CONTRACT, 'fixture.publication'));
    const runUid = newUid(), unitUid = newUid();
    await owner.transaction('write', tx => initializeOperationScope(tx, contract, binding, runUid, unitUid));
    const rounds: { kind: string; property: string }[][] = [];
    const observed: DatabaseOwner = {
      location: owner.location, ready: owner.ready, hasVector: owner.hasVector,
      allowConcurrentSnapshots: owner.allowConcurrentSnapshots,
      run: work => owner.run(work), exec: text => owner.exec(text), onClose: work => owner.onClose(work), close: () => owner.close(),
      transaction: (kind, work, options) => owner.transaction(kind, tx => {
        const measured: OuterTransaction = {
          afterCommit: callback => tx.afterCommit?.(callback),
          query: async <Row extends object>(sql: string, values?: readonly unknown[]) => {
            // The stream read's input is the complete assertion plan of one admission.
            if (sql.includes('AS sort,wanted.subject::text AS subject') && typeof values?.[0] === 'string') {
              const inputs = JSON.parse(values[0]) as { kind: string; property: string }[];
              if (inputs.some(input => input.kind === 'system.operation-unit' || input.kind === 'system.operation' && input.property === 'key')) rounds.push(inputs);
            }
            return await tx.query<Row>(sql, values);
          },
        };
        return work(measured);
      }, options),
    };
    const host = createOperationHost({ owner: observed, queue, job: job!, contract, capability: binding, runUid, unitUid });
    const request = { key: 'receipt', request: { input: 1 } };
    let calls = 0;
    expect(await host.execute(request, async () => { calls++; return { accepted: true }; })).toEqual({ accepted: true });
    expect(await host.execute<{ accepted: boolean }>(request, async () => { calls++; throw new Error('replay applied'); })).toEqual({ accepted: true });
    expect(calls).toBe(1);
    await owner.transaction('snapshot', async tx => {
      expect((await operationReceipt(tx, contract, unitUid, request.key))?.result).toBe('{"accepted":true}');
      const units = await readKindAssertions(tx, 'vertex', 'system.unit', ['committed_operations', 'last_progress'], await publicationReadSelector(tx, contract));
      expect(units.find(unit => unit.uid === unitUid)?.values).toMatchObject({ committed_operations: 1, last_progress: 'receipt' });
    });
    console.log(JSON.stringify({ metadataAdmissionRounds: rounds.length }));
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'system.operation-unit', property: '$exists' }),
      expect.objectContaining({ kind: 'system.operation-author', property: '$exists' }),
      expect.objectContaining({ kind: 'system.operation', property: 'key' }),
      expect.objectContaining({ kind: 'system.unit', property: 'committed_operations' }),
    ]));
  } finally { await queue.stop(); await owner.close(); }
}, 30000);
