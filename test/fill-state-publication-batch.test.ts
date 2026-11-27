import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabaseOwner } from './test-database.js';
import { createRun, createUnitIn, advanceUnitIn, bindFillStateIn, putFillVertexIn, readChain, readUnit, readRecordsIn, edgeRowsIn, readUnitGraphUidIn, readNodeIdIn, withFillStateIn } from '../src/graph/fill-state.js';
import type { SqlExecutor } from '../src/sql-driver.js';
import { EMPTY_CONTRACT } from '../src/graph/contract.js';
import { startupBinding } from '../src/graph/manifest-publication.js';
import { withAssertionContract } from '../src/graph/system-contract.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { acquireGraphWriteLock, boundWriteCapability, publishGraphDrafts, unbindWriteCapability, writeAssertions } from '../src/graph/write.js';
import { newUid } from '../src/graph/uid.js';
import { openTrace, runInTrace, closeTrace } from '../src/obs/trace.js';
import { createUnit } from './fill-unit-fixture.js';
import { readTraceSpans } from '../src/obs/trace-report.js';

test('a unit creation and step each publish state and journal in one graph batch', async () => {
  const owner = await createTestDatabaseOwner();
  const store = mkdtempSync(join(tmpdir(), 'madarch-state-batch-'));
  try {
    await createRun(owner, { runId: 'batch', product: 'batch', at: 1 });
    const counts: number[] = [];
    for (const phase of ['create', 'admit'] as const) {
      await owner.transaction('write', async tx => {
        await bindFillStateIn(tx);
        const prior = boundWriteCapability(tx);
        if (phase === 'create') unbindWriteCapability(tx);
        const before = boundWriteCapability(tx);
        const trace = openTrace({ store, runId: phase, console: false });
        try {
          await runInTrace(trace, async () => {
            if (phase === 'create') await createUnitIn(tx, { unitId: 'unit', product: 'batch', runId: 'batch', stageId: 'stage', scopeKey: 'scope', inputsDigest: 'digest', retries: 2, at: 2 });
            else expect((await advanceUnitIn(tx, { unitId: 'unit', event: { type: 'admit', at: 3, generation: 1 } })).ok).toBe(true);
          });
        } finally { closeTrace(trace); }
        counts.push(readTraceSpans(trace.file).filter(span => span.name === 'graph.publish').length);
        expect(boundWriteCapability(tx)).toEqual(before);
        if (phase === 'admit') expect(before).toBe(prior);
      });
    }
    expect(counts).toEqual([1, 1]);
    expect((await readUnit(owner, 'unit'))?.state).toBe('ready');
    const journals = await owner.transaction('snapshot', async tx => {
      const uid = await readUnitGraphUidIn(tx, 'unit');
      const id = await readNodeIdIn(tx, uid!);
      const links = await edgeRowsIn(tx, 'system.fill-transition-subject', 'to', [id!]);
      return await readRecordsIn(tx, 'vertex', 'system.fill-transition', ['step', 'from_state', 'to_state', 'event', 'at', 'fence'], links.map(link => link.from));
    });
    expect(journals.map(row => row.values.event).sort()).toEqual(['admit', 'create']);
    expect(journals.find(row => row.values.event === 'create')?.values).toMatchObject({ from_state: '(none)', to_state: 'planned', at: 2, fence: 0 });
    expect(journals.find(row => row.values.event === 'admit')?.values).toMatchObject({ from_state: 'planned', to_state: 'ready', at: 3, fence: 0 });
  } finally { await owner.close(); rmSync(store, { recursive: true, force: true }); }
}, 30_000);

test('a machine operation lineage is stated under the operation that opened it', async () => {
  const owner = await createTestDatabaseOwner();
  try {
    await createRun(owner, { runId: 'drafts', product: 'drafts', at: 1 });
    await createUnit(owner, { unitId: 'drafts/unit', product: 'drafts', runId: 'drafts', stageId: 'stage', scopeKey: 'scope', inputsDigest: 'digest', retries: 0, at: 2 });
    const contract = withAssertionContract(withManifestContract(EMPTY_CONTRACT));
    const operations = await owner.transaction('write', async tx => {
      await acquireGraphWriteLock(tx);
      // The machine opens its own operation before binding under a second operation.
      const machine = await bindFillStateIn(tx);
      // The same fill-state rebinds under another operation of its own source, as a rerun under other rights does.
      const other = await startupBinding(tx, contract, 'fill-state');
      const unitUid = (await readUnitGraphUidIn(tx, 'drafts/unit'))!;
      await putFillVertexIn(tx, 'system.unit', unitUid, { scope: 'written-under-other' }, [], { contract, operationUid: other.binding.operationUid, unitUid });
      return { machine: machine.operationUid, other: other.binding.operationUid };
    });
    expect(operations.machine).not.toBe(operations.other);
    const attribution = async (uid: string): Promise<string[]> => await owner.transaction('snapshot', async tx =>
      (await tx.query<{ operation: string }>(`SELECT op.uid::text AS operation FROM assertion a
        JOIN assertion_vertex_subject s ON s.assertion_id=a.assertion_id
        JOIN edge subject ON subject.id=s.subject_edge_id
        JOIN node subjectNode ON subjectNode.id=subject.to_node
        JOIN edge lineage ON lineage.from_node=a.assertion_id AND lineage.entity_id=(SELECT id FROM entity WHERE name='system.assertion-operation')
        JOIN node op ON op.id=lineage.to_node
        WHERE subjectNode.uid=$1::uuid AND a.property='$exists'`, [uid])).rows.map(row => row.operation));
    // The machine's operation was stated under its own lineage.
    expect(await attribution(operations.machine)).toEqual([operations.machine]);
    const authors = await owner.transaction('snapshot', async tx =>
      (await tx.query<{ uid: string }>(`SELECT n.uid::text AS uid FROM edge e JOIN entity k ON k.id=e.entity_id JOIN node n ON n.id=e.from_node
        WHERE k.name='system.operation-author' AND n.uid=$1::uuid`, [operations.machine])).rows.map(row => row.uid));
    expect(authors).toEqual([operations.machine]);
  } finally { await owner.close(); }
}, 30_000);

type TestOwner = Awaited<ReturnType<typeof createTestDatabaseOwner>>;
/** Whether the operation stands and is authored: what a machine operation owes is both, or it is not stated at all. */
async function operationStanding(owner: TestOwner, operationUid: string): Promise<{ stated: boolean; authored: number }> {
  return await owner.transaction('snapshot', async tx => {
    const stated = (await tx.query<{ active: boolean }>(`SELECT graph_vertex_active(n.id,k.name,1) AS active
      FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='system.operation' AND n.uid=$1::uuid`, [operationUid])).rows[0]?.active === true;
    const authored = (await tx.query<{ authored: number }>(`SELECT count(*)::int AS authored FROM edge e JOIN entity k ON k.id=e.entity_id JOIN node f ON f.id=e.from_node
      WHERE k.name='system.operation-author' AND f.uid=$1::uuid AND graph_edge_active(e.id,k.name,1)`, [operationUid])).rows[0]?.authored ?? 0;
    return { stated, authored };
  });
}

async function checkRefusedFirstWrite(remembered: boolean): Promise<void> {
  const owner = await createTestDatabaseOwner();
  try {
    if (remembered) await createRun(owner, { runId: 'warm', product: 'warm', at: 1 });
    const uid = newUid();
    await owner.transaction('write', async tx => {
      const previous = boundWriteCapability(tx);
      await expect(putFillVertexIn(tx, 'system.chain', uid, { product_name: 'retried', state: 42, updated_at: 1 })).rejects.toThrow(/TYPE_MISMATCH/);
      expect(boundWriteCapability(tx)).toEqual(previous);
      await putFillVertexIn(tx, 'system.chain', uid, { product_name: 'retried', state: 'idle', updated_at: 1 });
      expect(boundWriteCapability(tx)).toEqual(previous);
    });
    expect((await readChain(owner, 'retried'))?.state).toBe('idle');
    const lineage = await owner.transaction('snapshot', async tx =>
      (await tx.query<{ property: string; operation: string }>(`SELECT a.property, op.uid::text AS operation
        FROM assertion a
        JOIN assertion_vertex_subject s ON s.assertion_id=a.assertion_id
        JOIN edge subject ON subject.id=s.subject_edge_id
        JOIN node chain ON chain.id=subject.to_node
        JOIN edge lineage ON lineage.from_node=a.assertion_id AND lineage.entity_id=(SELECT id FROM entity WHERE name='system.assertion-operation')
        JOIN node op ON op.id=lineage.to_node
        WHERE chain.uid=$1::uuid ORDER BY a.property`, [uid])).rows);
    expect(lineage.map(row => row.property)).toEqual(['$exists', 'product_name', 'state', 'updated_at']);
    const operations = [...new Set(lineage.map(row => row.operation))];
    expect(operations).toHaveLength(1);
    expect(await operationStanding(owner, operations[0]!)).toEqual({ stated: true, authored: 1 });
  } finally { await owner.close(); }
}

test('a corrected first admission can open a remembered fill-state binding', async () => {
  await checkRefusedFirstWrite(true);
}, 30_000);

test('a corrected first write can commit after a fresh fill-state installation', async () => {
  await checkRefusedFirstWrite(false);
}, 30_000);

test('a transaction that admits a write itself states its operation before the write', async () => {
  const owner = await createTestDatabaseOwner();
  try {
    await createRun(owner, { runId: 'direct', product: 'direct', at: 1 });
    await createUnit(owner, { unitId: 'direct/unit', product: 'direct', runId: 'direct', stageId: 'stage', scopeKey: 'scope', inputsDigest: 'digest', retries: 0, at: 2 });
    const contract = withAssertionContract(withManifestContract(EMPTY_CONTRACT));
    // Every assertion the callback writes names the operation opened by `withFillStateIn`.
    const machine = await owner.transaction('write', async tx => {
      const subjectId = String((await readNodeIdIn(tx, (await readUnitGraphUidIn(tx, 'direct/unit'))!))!);
      return await withFillStateIn(tx, contract, undefined, async () => {
        const held = boundWriteCapability(tx)!;
        await writeAssertions(tx, contract, [{ sort: 'vertex', kind: 'system.unit', subjectId, property: 'scope', operation: 'assert', value: 'stated-directly' }]);
        return held.operationUid;
      });
    });
    expect((await readUnit(owner, 'direct/unit'))?.scopeKey).toBe('stated-directly');
    expect(await operationStanding(owner, machine)).toEqual({ stated: true, authored: 1 });
  } finally { await owner.close(); }
}, 30_000);

const unitContract = withAssertionContract(withManifestContract(EMPTY_CONTRACT));

async function checkUnitCallback(
  work: (tx: SqlExecutor, unitUid: string, subjectId: string) => Promise<void>,
): Promise<void> {
  const owner = await createTestDatabaseOwner();
  try {
    await createRun(owner, { runId: 'callback', product: 'callback', at: 1 });
    await createUnit(owner, { unitId: 'callback/unit', product: 'callback', runId: 'callback', stageId: 'stage', scopeKey: 'original', inputsDigest: 'digest', retries: 0, at: 2 });
    const operation = await owner.transaction('write', async tx => {
      const unitUid = (await readUnitGraphUidIn(tx, 'callback/unit'))!;
      const subjectId = String((await readNodeIdIn(tx, unitUid))!);
      return await withFillStateIn(tx, unitContract, undefined, async () => {
        const { operationUid } = boundWriteCapability(tx)!;
        await work(tx, unitUid, subjectId);
        return operationUid;
      });
    });
    expect((await readUnit(owner, 'callback/unit'))?.scopeKey).toBe('updated');
    expect(await operationStanding(owner, operation)).toEqual({ stated: true, authored: 1 });
  } finally { await owner.close(); }
}

function writeUnitField(tx: SqlExecutor, subjectId: string, property: string, value: string) {
  return writeAssertions(tx, unitContract, [{ sort: 'vertex', kind: 'system.unit', subjectId, property, operation: 'assert', value }]);
}

test('a fill-state callback can write two fields concurrently', async () => {
  await checkUnitCallback(async (tx, _unitUid, subjectId) => {
    const writes = await Promise.allSettled([
      writeUnitField(tx, subjectId, 'scope', 'updated'),
      writeUnitField(tx, subjectId, 'last_progress', 'started'),
    ]);
    for (const write of writes) {
      if (write.status === 'rejected') throw write.reason;
    }
  });
}, 30_000);

test('a fill-state callback can publish graph drafts directly', async () => {
  await checkUnitCallback(async (tx, unitUid) => {
    await publishGraphDrafts(tx, unitContract, {
      vertices: [{ kind: 'system.unit', uid: unitUid, key: {}, values: { scope: 'updated' }, producer: 'fill-state', producerVersion: '1' }],
      removals: [],
    });
  });
}, 30_000);

test('a fill-state callback can repeat a write after rolling back to a savepoint', async () => {
  await checkUnitCallback(async (tx, _unitUid, subjectId) => {
    await tx.query('SAVEPOINT repeat_write');
    await writeUnitField(tx, subjectId, 'scope', 'rolled back');
    await tx.query('ROLLBACK TO SAVEPOINT repeat_write');
    await writeUnitField(tx, subjectId, 'scope', 'updated');
  });
}, 30_000);
