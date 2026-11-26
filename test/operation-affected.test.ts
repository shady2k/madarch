import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import type { OuterTransaction } from '../src/history-types.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { prepareQueueSchema } from '../src/adapters/schemas/queue.js';
import { EMPTY_CONTRACT } from '../src/graph/contract.js';
import { createOperationHost, initializeOperationScope, operationReceipt } from '../src/graph/operation-host.js';
import { startupBinding } from '../src/graph/manifest-publication.js';
import { newUid } from '../src/graph/uid.js';
import { acquireGraphWriteLock, bindWriteCapability, publishGraphDrafts, writeAssertions } from '../src/graph/write.js';
import { withFillStateIn } from '../src/graph/fill-state.js';
import { withAssertionContract } from '../src/graph/system-contract.js';
import { byCodePoint } from '../src/model/order.js';
import { openTrace, runInTrace, closeTrace } from '../src/obs/trace.js';
import { createTestDatabaseOwner } from './test-database.js';

const reverseLookup = `SELECT n.uid::text FROM edge lineage
 JOIN node n ON n.id=lineage.from_node JOIN assertion a ON a.assertion_id=n.id
 WHERE lineage.to_node=(SELECT id FROM node WHERE uid=$1::uuid)
 AND lineage.entity_id=(SELECT id FROM entity WHERE name='system.assertion-operation')
 ORDER BY n.uid::text COLLATE "C"`;

test('operation relations need only unit and author; assertions supply the reverse receipt', () => {
  expect(withAssertionContract(EMPTY_CONTRACT).edge.filter(kind => kind.name.startsWith('system.operation-')).map(kind => kind.name).sort(byCodePoint))
    .toEqual(['system.operation-author', 'system.operation-unit']);
});

for (const action of ['execute', 'fail'] as const) test(`${action} receipt reads new, seen and machine facts through inbound lineage`, async () => {
 const owner = await createTestDatabaseOwner({ authenticated: false });
 const queue = await createPgBossQueue({ owner, supervise: false });
 const folder = mkdtempSync(join(tmpdir(), 'operation-lineage-'));
 try {
  const declaration = { name: 'lineage', leaseSeconds: 600, retries: 0, retryDelaySeconds: 0, retryBackoff: false };
  await prepareQueueSchema(owner, { declarations: [declaration] });
  await queue.declare(declaration);
  const { binding } = await owner.transaction('write', tx => startupBinding(tx, EMPTY_CONTRACT, 'fixture.lineage'));
  const measurements: number[] = [];
  for (const count of [10, 200]) {
   await queue.enqueue({ queue: declaration.name, data: {} });
   const [job] = await queue.claim({ queue: declaration.name });
   const runUid = newUid(), unitUid = newUid();
   await owner.transaction('write', tx => initializeOperationScope(tx, EMPTY_CONTRACT, binding, runUid, unitUid));
   const draft = { vertices: [{ kind: 'system.unit', uid: unitUid, key: {}, values: { scope: 'repeat observation' }, producer: binding.sourceUid, producerVersion: '1' }], removals: [] };
   await owner.transaction('write', async tx => {
    bindWriteCapability(tx, binding);
    await publishGraphDrafts(tx, EMPTY_CONTRACT, draft);
   });
   const seen = (await owner.run(tx => tx.query<{uid:string}>(`SELECT n.uid::text FROM assertion a JOIN node n ON n.id=a.assertion_id JOIN assertion_vertex_subject av ON av.assertion_id=a.assertion_id JOIN edge subject ON subject.id=av.subject_edge_id JOIN node unit ON unit.id=subject.to_node WHERE unit.uid=$1::uuid AND a.property='scope'`, [unitUid]))).rows.map(row=>row.uid);
   expect(seen).toHaveLength(1);
   let statements = 0, operationUid = '';
   let written: string[] = [];
   const observed: DatabaseOwner = {
    location: owner.location, ready: owner.ready, hasVector: owner.hasVector, allowConcurrentSnapshots: owner.allowConcurrentSnapshots,
    run: work => owner.run(work), exec: text => owner.exec(text), onClose: work => owner.onClose(work), close: () => owner.close(),
    transaction: (kind, work, options) => owner.transaction(kind, tx => {
     const decorated: OuterTransaction = { afterCommit: callback => tx.afterCommit?.(callback), query: async (sql, values) => {
      statements++; return await tx.query(sql, values);
     } };
     return work(decorated);
    }, options),
   };
   const host = createOperationHost({ owner: observed, queue, job: job!, contract: EMPTY_CONTRACT, capability: binding, runUid, unitUid });
   const apply = async (tx: OuterTransaction, context: { operationUid: string }) => {
    operationUid = context.operationUid;
    const subjectId = (await tx.query<{id:string}>('SELECT id::text FROM node WHERE uid=$1::uuid', [unitUid])).rows[0]!.id;
    written = await writeAssertions(tx, EMPTY_CONTRACT, Array.from({length: count}, (_, i) => ({sort:'vertex' as const, kind:'system.unit', subjectId, property:'reason', operation:'assert' as const, value:`fact ${i}`})));
    await publishGraphDrafts(tx, EMPTY_CONTRACT, draft);
    await withFillStateIn(tx, EMPTY_CONTRACT, {operationUid, unitUid}, async () => {
     written.push(...await writeAssertions(tx, EMPTY_CONTRACT, [{sort:'vertex', kind:'system.unit', subjectId, property:'state', operation:'assert', value: action === 'fail' ? 'failed' : 'published'}]));
    });
    return { accepted: true };
   };
   const trace = openTrace({store:folder, runId:`${action}-${count}`});
   try {
    await runInTrace(trace, async () => {
     if (action === 'execute') expect(await host.execute({key:'receipt', request:{value:1}}, apply)).toEqual({accepted:true});
     else expect(await host.fail('fixture failure', async (tx, context) => { await apply(tx, context); })).toBe(true);
    });
   } finally { closeTrace(trace); }
   measurements.push(statements);
   const affected = (await owner.run(tx => tx.query<{uid:string}>(reverseLookup, [operationUid]))).rows.map(row => row.uid);
   expect(affected).toEqual([...affected].sort(byCodePoint));
   expect(new Set(affected).size).toBe(affected.length);
   for (const uid of [...written, ...seen]) expect(affected).toContain(uid);
   expect(affected).toHaveLength(count + (action === 'execute' ? 12 : 8));
   const kinds = (await owner.run(tx => tx.query<{property:string}>(`SELECT a.property FROM assertion a JOIN node n ON n.id=a.assertion_id
    JOIN edge lineage ON lineage.from_node=a.assertion_id JOIN entity lk ON lk.id=lineage.entity_id AND lk.name='system.assertion-operation'
    JOIN node op ON op.id=lineage.to_node WHERE op.uid=$1::uuid`, [operationUid]))).rows;
   console.log(JSON.stringify({action,count,statements,affected:affected.length,properties:kinds.map(row=>row.property)}));
   if (action === 'execute') {
    const receipt = await owner.transaction('snapshot', tx => operationReceipt(tx, EMPTY_CONTRACT, unitUid, 'receipt'));
    expect(receipt?.canonicalRequest).toBe('{"completion":null,"preconditions":[],"request":{"value":1}}');
    expect(receipt?.result).toBe('{"accepted":true}');
    expect(receipt?.digest).toHaveLength(64);
    expect(await host.execute<{accepted:boolean}>({key:'receipt',request:{value:1}}, async () => { throw new Error('retry applied'); })).toEqual({accepted:true});
    await expect(host.execute({key:'receipt',request:{value:2}}, async () => null)).rejects.toThrow('IDEMPOTENCY_CONFLICT');
   }
   if (count === 10) {
    const plan = (await owner.run(tx => tx.query<Record<string,string>>(`EXPLAIN ${reverseLookup}`, [operationUid]))).rows.map(row => row['QUERY PLAN']).join('\n');
    console.log(`REVERSE EXPLAIN ${action}\n${plan}`);
    expect(plan).toMatch(/Index Scan using edge_to/);
    expect(plan).not.toMatch(/Seq Scan on edge/);
   }
   expect(readFileSync(trace.file,'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line).name)).not.toContain(['graph','operation','affected'].join('.'));
  }
  console.log(JSON.stringify({action,statements:measurements}));
  expect(measurements[1]).toBe(measurements[0]);
 } finally { await queue.stop(); await owner.close(); rmSync(folder,{recursive:true,force:true}); }
}, 180000);

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test('inbound receipt stays invisible and keeps the graph lock until commit', async () => {
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
    let commits = 0;
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
            if (sql === 'SET CONSTRAINTS ALL IMMEDIATE') {
              commits++;
              expected = (await tx.query<{uid:string}>(reverseLookup, [operationUid])).rows.map(row=>row.uid);
              inserted.release(); await resume.promise;
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
    await Promise.race([inserted.promise, execution.then(() => { throw new Error('operation ended before the commit barrier'); })]);
    expect(expected.length).toBeGreaterThan(1);
    const visibleTargets = async () => (await owner.run(tx => tx.query<{uid:string}>(reverseLookup, [operationUid]))).rows.map(row=>row.uid);
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
    expect(commits).toBe(1);
    expect(await visibleTargets()).toEqual(expected);
    expect(await receiptKeys()).toBe('1');
    expect(await host.execute(request, async () => { calls++; return { accepted: false }; })).toEqual({ accepted: true });
    expect(calls).toBe(1);
    expect(commits).toBe(1);
    expect(await visibleTargets()).toEqual(expected);
  } finally {
    resume.release();
    await Promise.allSettled([execution, writer]);
    await queue.stop();
    await owner.close();
  }
}, 30000);
