import { expect, test } from 'bun:test';
import { createTestDatabaseOwner } from './test-database.js';
import { generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { withAssertionContract } from '../src/graph/system-contract.js';
import { registerSystemSource } from '../src/graph/system-installation.js';
import { activateGraphProducer, bindGraphProducer, type ProducerBinding } from '../src/graph/producer-binding.js';
import { ensureVertex, publishGraphDrafts, writeAssertion } from '../src/graph/write.js';
import { readKindAssertions } from '../src/graph/records.js';

const contract: GraphContract = withAssertionContract({ vertex: [{ name: 'sample', table: generatedTableName('sample', 'vertex'), capability: 'fixture', key: ['id'], fields: [{ name: 'id', type: 'text' }, { name: 'value', type: 'text', nullable: true }, { name: 'other', type: 'text', nullable: true }] }], edge: [], dictionary: [] });
const draft = { kind: 'sample', key: { id: 'x' }, values: { value: 'ok' }, producer: 'forged', producerVersion: 'forged' };

test('low-level writer refuses absent authority before SQL', async () => {
  let queries = 0;
  const fake = { query: async () => { queries++; return { rows: [] }; } };
  await expect(publishGraphDrafts(fake, contract, { vertices: [draft], removals: [] })).rejects.toThrow('AUTH_REQUIRED');
  await expect(ensureVertex(fake, contract, draft)).rejects.toThrow('AUTH_REQUIRED');
  await expect(writeAssertion(fake, contract, { sort: 'vertex', kind: 'sample', subjectId: '1', property: 'value', operation: 'assert', value: 'x' })).rejects.toThrow('AUTH_REQUIRED');
  expect(queries).toBe(0);
});

test('opaque grants bind product, context, contract and fields; draft labels cannot impersonate another source', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    const installed = await registerSystemSource(owner, contract, { type: 'plugin', installationKey: 'fixture', version: '1', scope: 'sample' });
    const binding = bindGraphProducer(owner, contract, { principal: installed.principal, vertices: { sample: ['value'] }, edges: {} });
    expect(binding.scope).not.toBe('sample');
    expect(() => bindGraphProducer(owner, contract, { principal: installed.principal, scopeUid: 'sample', vertices: { sample: ['value'] }, edges: {} })).toThrow('permission scope must be a graph uid');
    const missingScope = bindGraphProducer(owner, contract, { principal: installed.principal, scopeUid: '00000000-0000-7000-8000-000000000000', vertices: { sample: ['value'] }, edges: {} });
    await expect(owner.transaction('write', tx => activateGraphProducer(tx, contract, missingScope))).rejects.toThrow('permission scope');
    await expect(owner.transaction('write', async tx => await activateGraphProducer(tx, contract, { ...binding } as ProducerBinding))).rejects.toThrow('host-issued');
    await expect(owner.transaction('write', async tx => await activateGraphProducer(tx, contract, binding, 2))).rejects.toThrow('context');
    const fake = { query: async () => ({ rows: [] }) };
    await expect(activateGraphProducer(fake, contract, binding)).rejects.toThrow('another product');
    await expect(owner.transaction('write', async tx => await activateGraphProducer(tx, { ...contract, dictionary: [{ name: 'different', fields: [], key: [] }] }, binding))).rejects.toThrow('contract');
    await expect(owner.transaction('write', async tx => {
      await activateGraphProducer(tx, contract, binding);
      await publishGraphDrafts(tx, contract, { vertices: [{ ...draft, values: { other: 'not granted' } }], removals: [] });
    })).rejects.toThrow('FORBIDDEN_SOURCE');
    const aliases = async () => await owner.transaction('snapshot', tx => tx.query<{ uid: string }>("SELECT n.uid::text AS uid FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name IN ('system.source','system.person','system.plugin') ORDER BY n.uid"));
    const before = await aliases();
    await owner.transaction('write', async tx => {
      await activateGraphProducer(tx, contract, binding);
      await publishGraphDrafts(tx, contract, { vertices: [draft], removals: [] });
    });
    expect((await aliases()).rows).toEqual(before.rows);
    const records = await owner.transaction('snapshot', async tx => await readKindAssertions(tx, 'vertex', 'sample', ['value'], { contract }));
    expect(records).toHaveLength(1);
    expect(records[0]!.values.value).toBe('ok');
    expect(records[0]!.activeSources).toEqual([installed.uid]);
    const readOnly = bindGraphProducer(owner, contract, { principal: installed.principal, vertices: { sample: ['value'] }, edges: {}, actions: [] });
    await expect(owner.transaction('write', async tx => {
      await activateGraphProducer(tx, contract, readOnly);
      await publishGraphDrafts(tx, contract, { vertices: [draft], removals: [] });
    })).rejects.toThrow('FORBIDDEN_SOURCE');
  } finally { await owner.close(); }
}, 30000);
