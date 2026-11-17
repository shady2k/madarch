import { expect, test } from 'bun:test';
import { createTestDatabaseOwner } from './test-database.js';
import { generatedTableName, graphContractVersion, type GraphContract } from '../src/graph/contract.js';
import { withAssertionContract } from '../src/graph/system-contract.js';
import { bindWriteCapability, bootstrapWriteIdentity, publishGraphDrafts, writeAssertion } from '../src/graph/write.js';
import { newUid } from '../src/graph/uid.js';
import { loadAssertions } from '../src/graph/assertion-read.js';
import { reconcileDisputes } from '../src/graph/disputes.js';
import { listDisputeSlots } from '../src/graph/dispute-read.js';
import { SQL_TRANSACTION_KINDS } from '../src/sql-driver.js';

const contract: GraphContract = withAssertionContract({
  vertex: [{ name: 'sample', table: generatedTableName('sample', 'vertex'), key: ['name'], capability: 'fixture', fields: [{ name: 'name', type: 'text' }] }],
  edge: [{ name: 'sample.link', table: generatedTableName('sample.link', 'edge'), from: ['sample'], to: ['sample'], fields: [{ name: 'amount', type: 'integer' }], capability: 'fixture', repeats: false, cardinality: { from: 'many', to: 'many' }, labels: { en: { out: 'links', in: 'linked by' }, ru: { out: 'links', in: 'linked by' } } }], dictionary: [],
});

test('edge dispute anchors retain edge identity without node canonicalization', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  const productUid = newUid(), principalUid = newUid(), operationUid = newUid(), a = newUid(), b = newUid();
  const bind = (tx: Parameters<typeof bindWriteCapability>[0], sourceUid: string) => bindWriteCapability(tx, {
    productUid, principalUid, operationUid, sourceUid, context: 1, scope: productUid, contractVersion: graphContractVersion(contract),
    permissions: [{ kind: 'sample', properties: ['*'], assert: true, retractOwn: true }, { kind: 'sample.link', properties: ['*'], assert: true, retractOwn: true }],
  });
  try {
    const from = { kind: 'sample', key: { name: 'from' } }, to = { kind: 'sample', key: { name: 'to' } };
    await owner.transaction(SQL_TRANSACTION_KINDS.write, async tx => {
      for (const [kind, uid] of [['source', a], ['source', b], ['person', principalUid], ['system.operation', operationUid]]) await bootstrapWriteIdentity(tx, kind!, uid!, productUid);
      bind(tx, a);
      await publishGraphDrafts(tx, contract, {
        vertices: [from, to].map(ref => ({ ...ref, values: {}, producer: 'fixture', producerVersion: '1' })),
        edges: [{ kind: 'sample.link', from, to, values: { amount: 1 }, producer: 'fixture', producerVersion: '1' }], removals: [],
      });
      const [assertion] = await loadAssertions(tx, 'edge', 'sample.link', ['amount']);
      bind(tx, b);
      await writeAssertion(tx, contract, { sort: 'edge', kind: 'sample.link', subjectId: String(assertion!.subjectId), property: 'amount', operation: 'assert', value: 2 });
      await reconcileDisputes(tx, contract);
    });
    await owner.transaction(SQL_TRANSACTION_KINDS.snapshot, async tx => {
      const [assertion] = await loadAssertions(tx, 'edge', 'sample.link', ['amount']);
      // Node and edge ID spaces overlap. A node-only projection must never receive an edge anchor.
      const guarded = new Proxy(tx, { get(target, key) {
        if (key === 'query') return async (sql: string, values?: readonly unknown[]) => {
          if (sql.startsWith('SELECT graph_merge_target(')) throw new Error('edge anchor entered node canonicalization');
          return await target.query(sql, values);
        };
        return Reflect.get(target, key);
      } });
      const now = new Date().toISOString();
      const slots = await listDisputeSlots(guarded, contract, { contexts: [1], validAt: now, recordedAt: now });
      const slot = slots.find(slot => slot.kind === 'sample.link' && slot.property === 'amount');
      expect(slot?.sort).toBe('edge');
      expect(slot?.subjectId).toBe(assertion!.subjectId);
      expect(slot?.dispute.state).toBe('OPEN');
      expect(slot?.dispute.candidates).toHaveLength(2);
    });
  } finally { await owner.close(); }
}, 60_000);
