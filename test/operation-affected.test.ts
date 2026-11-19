import { expect, test } from 'bun:test';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import type { OuterTransaction } from '../src/history-types.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { prepareQueueSchema } from '../src/adapters/schemas/queue.js';
import { EMPTY_CONTRACT } from '../src/graph/contract.js';
import { createOperationHost, initializeOperationScope } from '../src/graph/operation-host.js';
import { startupBinding } from '../src/graph/manifest-publication.js';
import { newUid } from '../src/graph/uid.js';
import { acquireGraphWriteLock, publishGraphDrafts } from '../src/graph/write.js';
import { createTestDatabaseOwner } from './test-database.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test('affected assertions publish in one batch and keep the graph lock until commit', async () => {
  const owner = await createTestDatabaseOwner({ authenticated: false });
  const declaration = { name: 'affected-batch', leaseSeconds: 60, retries: 0, retryDelaySeconds: 0, retryBackoff: false };
  const queue = await createPgBossQueue({ owner, supervise: false });
  const inserted = gate(), resume = gate(), writerReady = gate();
  let execution: Promise<unknown> | undefined;
  let writer: Promise<void> | undefined;
  try {
    await prepareQueueSchema(owner, { declarations: [declaration] });
    await queue.declare(declaration);
    await queue.enqueue({ queue: declaration.name, data: {} });
    const [job] = await queue.claim({ queue: declaration.name });
    const { binding } = await owner.transaction('write', tx => startupBinding(tx, EMPTY_CONTRACT, 'fixture.affected'));
    const runUid = newUid(), unitUid = newUid();
    await owner.transaction('write', tx => initializeOperationScope(tx, EMPTY_CONTRACT, binding, runUid, unitUid));
    let batches = 0;
    let expected: string[] = [];
    let operationUid = '';
    const observed: DatabaseOwner = {
      location: owner.location, ready: owner.ready, hasVector: owner.hasVector,
      allowConcurrentSnapshots: owner.allowConcurrentSnapshots,
      run: work => owner.run(work), exec: text => owner.exec(text), onClose: work => owner.onClose(work), close: () => owner.close(),
      transaction: (kind, work, options) => owner.transaction(kind, tx => {
        const decorated: OuterTransaction = {
          afterCommit: callback => tx.afterCommit?.(callback),
          query: async <Row extends object>(sql: string, values?: readonly unknown[]) => {
            const result = await tx.query<Row>(sql, values);
            if (sql.startsWith('SELECT n.uid::text FROM assertion a') && sql.includes('ORDER BY n.uid::text')) {
              expected = result.rows.map(row => String((row as { uid: string }).uid));
            }
            if (sql.trimStart().startsWith('INSERT INTO edge(') && typeof values?.[0] === 'string') {
              const records = JSON.parse(values[0]) as { kind?: string }[];
              if (records.some(record => record.kind === 'system.operation-affected')) {
                batches++;
                if (batches === 1) { inserted.release(); await resume.promise; }
              }
            }
            return result;
          },
        };
        return work(decorated);
      }, options),
    };
    const host = createOperationHost({ owner: observed, queue, job: job!, contract: EMPTY_CONTRACT, capability: binding, runUid, unitUid });
    let calls = 0;
    const request = { key: 'batch', request: {} };
    execution = host.execute(request, async (tx, context) => {
      calls++;
      operationUid = context.binding.operationUid;
      await publishGraphDrafts(tx, EMPTY_CONTRACT, {
        vertices: [{ kind: 'system.unit', uid: unitUid, key: {}, values: { last_progress: 'fixture', reason: 'batch fixture' }, producer: binding.sourceUid, producerVersion: '1' }],
        edges: [], removals: [],
      });
      return { accepted: true };
    });
    await Promise.race([inserted.promise, execution.then(() => { throw new Error('operation ended before affected publication'); })]);
    expect(expected.length).toBeGreaterThan(1);
    const visibleTargets = async () => (await owner.run(tx => tx.query<{ uid: string }>(
      `SELECT target.uid::text FROM edge e JOIN entity k ON k.id=e.entity_id
       JOIN node origin ON origin.id=e.from_node JOIN node target ON target.id=e.to_node
       WHERE k.name='system.operation-affected' AND origin.uid=$1::uuid ORDER BY target.uid::text COLLATE "C"`, [operationUid],
    ))).rows.map(row => row.uid);
    expect(await visibleTargets()).toEqual([]);
    const receiptKeys = async () => (await owner.run(tx => tx.query<{ count: string }>(
      `SELECT count(*)::text FROM assertion a
       JOIN assertion_vertex_subject s ON s.assertion_id=a.assertion_id
       JOIN edge attachment ON attachment.id=s.subject_edge_id JOIN node n ON n.id=attachment.to_node
       WHERE n.uid=$1::uuid AND a.property='key'`, [operationUid],
    ))).rows[0]!.count;
    expect(await receiptKeys()).toBe('0');
    let acquiredWhileHeld: boolean | undefined;
    let writerFinished = false;
    writer = owner.transaction('write', async tx => {
      acquiredWhileHeld = (await tx.query<{ acquired: boolean }>('SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired', [739251902])).rows[0]!.acquired;
      writerReady.release();
      await acquireGraphWriteLock(tx);
      writerFinished = true;
    });
    await Promise.race([writerReady.promise, writer.then(() => { throw new Error('writer ended before lock probe'); })]);
    expect(acquiredWhileHeld).toBe(false);
    expect(writerFinished).toBe(false);
    resume.release();
    expect(await execution).toEqual({ accepted: true });
    await writer;
    expect(writerFinished).toBe(true);
    expect(batches).toBe(1);
    expect(await visibleTargets()).toEqual(expected);
    expect(await receiptKeys()).toBe('1');
    expect(await host.execute(request, async () => { calls++; return { accepted: false }; })).toEqual({ accepted: true });
    expect(calls).toBe(1);
    expect(batches).toBe(1);
    expect(await visibleTargets()).toEqual(expected);
  } finally {
    resume.release();
    await Promise.allSettled([execution, writer]);
    await queue.stop();
    await owner.close();
  }
}, 30000);
