import { expect, test } from 'bun:test';
import { generatedTableName, graphContractVersion, type GraphContract } from '../src/graph/contract.js';
import { reconcileDisputes } from '../src/graph/disputes.js';
import { withAssertionContract } from '../src/graph/system-contract.js';
import { newUid } from '../src/graph/uid.js';
import { bindWriteCapability, bootstrapWriteIdentity, publishGraphDrafts, writeAssertion } from '../src/graph/write.js';
import { loadAssertions } from '../src/graph/assertion-read.js';
import { createTestDatabaseOwner } from './test-database.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

const contract: GraphContract = withAssertionContract({
  vertex: [{ name: 'sample', table: generatedTableName('sample', 'vertex'), key: ['name'], capability: 'fixture', fields: [{ name: 'name', type: 'text' }, { name: 'amount', type: 'integer' }] }],
  edge: [], dictionary: [],
});

test('unanchored single-source slots skip per-slot dispute queries while holding the graph lock', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract, authenticated: false });
  const paused = gate(), resume = gate();
  const productUid = newUid(), principalUid = newUid(), operationUid = newUid(), sourceUid = newUid();
  let execution: Promise<void> | undefined;
  let producerQueries = 0;
  let pausedDuringProducerQuery = false;
  try {
    execution = owner.transaction('write', async tx => {
      for (const [kind, uid] of [['source', sourceUid], ['person', principalUid], ['system.operation', operationUid]]) {
        await bootstrapWriteIdentity(tx, kind!, uid!, productUid);
      }
      bindWriteCapability(tx, { productUid, principalUid, operationUid, sourceUid, context: 1, scope: productUid, contractVersion: graphContractVersion(contract), permissions: [{ kind: 'sample', properties: ['*'], assert: true, retractOwn: true }] });
      await publishGraphDrafts(tx, contract, {
        vertices: [{ kind: 'sample', key: { name: 'one' }, values: { amount: 1 }, validFrom: '2020-01-01T00:00:00Z', producer: 'fixture', producerVersion: '1' }],
        removals: [],
      });
      const row = (await loadAssertions(tx, 'vertex', 'sample', ['amount']))[0]!;
      await writeAssertion(tx, contract, { sort: 'vertex', kind: 'sample', subjectId: String(row.subjectId), property: 'amount', operation: 'assert', value: 2, validFrom: '2035-01-01T00:00:00Z' });
      await writeAssertion(tx, contract, { sort: 'vertex', kind: 'sample', subjectId: String(row.subjectId), property: 'amount', operation: 'retract', validFrom: '2040-01-01T00:00:00Z' });
      const query = tx.query;
      tx.query = async <Row extends object>(sql: string, values?: readonly unknown[]) => {
        if (sql.startsWith('SELECT n.uid::text AS uid FROM edge e') && sql.includes("k.name='system.resolution-assertion'")) {
          producerQueries++;
          if (producerQueries === 1) {
            pausedDuringProducerQuery = true;
            paused.release();
            await resume.promise;
          }
        }
        return query<Row>(sql, values);
      };
      try {
        await reconcileDisputes(tx, contract);
      } finally {
        tx.query = query;
      }
      if (!pausedDuringProducerQuery) {
        paused.release();
        await resume.promise;
      }
    });
    await Promise.race([paused.promise, execution.then(() => { throw new Error('transaction ended before the lock probe'); })]);
    // A JavaScript gate, not a slow SQL statement, keeps the operation open here.
    const acquired = await owner.transaction('write', async tx => (await tx.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired', [739251902],
    )).rows[0]!.acquired);
    expect(acquired).toBe(false);
    resume.release();
    await execution;
    expect(producerQueries).toBe(0);
    await owner.transaction('snapshot', async tx => {
      expect((await tx.query(`SELECT n.id FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='system.dispute-question'`)).rows).toHaveLength(0);
    });
  } finally {
    resume.release();
    await Promise.allSettled([execution]);
    await owner.close();
  }
}, 30000);

test('parent reconciliation still visits an unpinned child with its own source', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract, authenticated: false });
  const productUid = newUid(), principalUid = newUid(), operationUid = newUid(), parentSource = newUid(), childSource = newUid();
  const bind = (tx: Parameters<typeof bindWriteCapability>[0], sourceUid: string, context = 1) => bindWriteCapability(tx, {
    productUid, principalUid, operationUid, sourceUid, context, scope: productUid, contractVersion: graphContractVersion(contract),
    permissions: [{ kind: 'sample', properties: ['*'], assert: true, retractOwn: true }],
  });
  try {
    const { subjectId, child } = await owner.transaction('write', async tx => {
      for (const [kind, uid] of [['source', parentSource], ['source', childSource], ['person', principalUid], ['system.operation', operationUid]]) {
        await bootstrapWriteIdentity(tx, kind!, uid!, productUid);
      }
      bind(tx, parentSource);
      await publishGraphDrafts(tx, contract, {
        vertices: [{ kind: 'sample', key: { name: 'one' }, values: { amount: 1 }, validFrom: '2020-01-01T00:00:00Z', producer: 'fixture', producerVersion: '1' }], removals: [],
      });
      const subjectId = (await loadAssertions(tx, 'vertex', 'sample', ['amount']))[0]!.subjectId;
      const child = Number((await tx.query<{ id: string }>("INSERT INTO context(parent,ref) VALUES(1,'live-child') RETURNING id::text AS id")).rows[0]!.id);
      bind(tx, childSource, child);
      await writeAssertion(tx, contract, { sort: 'vertex', kind: 'sample', subjectId: String(subjectId), property: 'amount', operation: 'assert', value: 2, validFrom: '2020-01-01T00:00:00Z' }, child);
      return { subjectId, child };
    });
    await owner.transaction('write', async tx => {
      bind(tx, parentSource);
      await writeAssertion(tx, contract, { sort: 'vertex', kind: 'sample', subjectId: String(subjectId), property: 'amount', operation: 'assert', value: 3, validFrom: '2020-01-01T00:00:00Z' });
      await reconcileDisputes(tx, contract);
    });
    await owner.transaction('snapshot', async tx => {
      const { readDispute } = await import('../src/graph/dispute-read.js');
      const rows = await loadAssertions(tx, 'vertex', 'sample', ['amount'], [subjectId]);
      expect(await readDispute(tx, contract, rows, { contexts: [1] })).toBeNull();
      const dispute = await readDispute(tx, contract, rows, { contexts: [child, 1] });
      expect(dispute?.state).toBe('OPEN');
      expect(dispute?.candidates).toHaveLength(2);
    });
  } finally {
    await owner.close();
  }
}, 30000);

test('an anchor on a merged-away member still visits a single-source slot', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract, authenticated: false });
  const productUid = newUid(), principalUid = newUid(), operationUid = newUid(), sourceUid = newUid();
  try {
    await owner.transaction('write', async tx => {
      for (const [kind, uid] of [['source', sourceUid], ['person', principalUid], ['system.operation', operationUid]]) {
        await bootstrapWriteIdentity(tx, kind!, uid!, productUid);
      }
      bindWriteCapability(tx, { productUid, principalUid, operationUid, sourceUid, context: 1, scope: productUid, contractVersion: graphContractVersion(contract), permissions: [...contract.vertex, ...contract.edge].map(kind => ({ kind: kind.name, properties: ['*'], assert: true, retractOwn: true })) });
      const members = ['survivor', 'loser'].map(name => ({ kind: 'sample', key: { name }, producer: 'fixture', producerVersion: '1' }));
      await publishGraphDrafts(tx, contract, { vertices: members.map(member => ({ ...member, values: { amount: 1 } })), removals: [] });
      const rows = await loadAssertions(tx, 'vertex', 'sample', ['amount']);
      const loserUid = (await tx.query<{ uid: string }>("SELECT n.uid::text AS uid FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='sample' AND n.key=$1::jsonb", [JSON.stringify({ name: 'loser' })])).rows[0]!.uid;
      const loser = rows.find(row => row.originalSubjectUid === loserUid)!;
      const question = { kind: 'system.dispute-question', uid: newUid(), key: {} };
      const merge = { kind: 'system.merge', uid: newUid(), key: {} };
      const producer = { producer: 'fixture', producerVersion: '1' };
      await publishGraphDrafts(tx, contract, {
        vertices: [
          { ...question, values: { property: 'amount', language: null, segment_from: '2020-01-01T00:00:00Z', segment_to: null, state: 'OPEN' }, ...producer },
          { ...merge, values: { state: 'ACTIVE', reason: 'Same entity' }, ...producer },
        ],
        edges: [
          { kind: 'system.dispute-anchor', from: question, to: { kind: 'system.assertion', key: {}, uid: loser.id }, ...producer },
          ...members.map(to => ({ kind: 'system.merge-member', from: merge, to, ...producer })),
          { kind: 'system.merge-survivor', from: merge, to: members[0]!, ...producer },
        ], removals: [],
      });
      const now = (await tx.query<{ at: string }>('SELECT clock_timestamp()::text AS at')).rows[0]!.at;
      const projected = await loadAssertions(tx, 'vertex', 'sample', ['amount'], undefined, { projectMergedSubjects: true, validAt: now, recordedAt: now });
      expect(projected.find(row => row.id === loser.id)!.subjectId).not.toBe(loser.subjectId);
      await reconcileDisputes(tx, contract, [{sort:'vertex',kind:'sample',subjectId:loser.subjectId,property:'amount',language:null}]);
      const { selectAssertions } = await import('../src/graph/assertion-selection.js');
      const at = (await tx.query<{ at: string }>('SELECT clock_timestamp()::text AS at')).rows[0]!.at;
      const state = (await loadAssertions(tx, 'vertex', question.kind, ['state'])).filter(row => row.subject.type === 'vertex' && row.subject.uid === question.uid);
      expect(selectAssertions(state, { validAt: at, recordedAt: at, contexts: [1] }).selected?.value).toBe('DISMISSED');
      const existence = (await loadAssertions(tx, 'vertex', question.kind, ['$exists'])).filter(row => row.subject.type === 'vertex' && row.subject.uid === question.uid);
      expect(existence).toHaveLength(1);
    });
  } finally { await owner.close(); }
}, 30000);
