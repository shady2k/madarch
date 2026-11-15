import { afterAll, expect, test } from 'bun:test';
import { createTestDatabaseOwner } from './test-database.js';
import { generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { withSystemContract } from '../src/graph/system-contract.js';
import { registerSystemSource } from '../src/graph/system-installation.js';
import { bindGraphProducer, type ProducerBinding } from '../src/graph/producer-binding.js';
import { ensureVertex, publishOpinion, removeEntity, publishGraphDrafts, withdrawEdge } from '../src/graph/write.js';

const contract: GraphContract = withSystemContract({ vertex: [{ name: 'sample', table: generatedTableName('sample', 'vertex'), capability: 'fixture', key: ['id'], fields: [{ name: 'id', type: 'text' }, { name: 'value', type: 'text', nullable: true }, { name: 'other', type: 'text', nullable: true }] }], edge: [], dictionary: [] });
const owner = await createTestDatabaseOwner({ graphContract: contract });
afterAll(async () => await owner.close());
const principal = (await registerSystemSource(owner, contract, { type: 'plugin', installationKey: 'fixture', version: '1', scope: 'sample' })).principal;
const binding = bindGraphProducer(owner, contract, { principal, vertices: { sample: ['value'] }, edges: {} });
const draft = { kind: 'sample', key: { id: 'x' }, values: { value: 'ok' }, selectedFields: ['value'], producer: 'fixture', producerVersion: '1' };

test('every low-level writer refuses absent and forged authority before SQL', async () => {
  let queries = 0;
  const fake = { query: async () => { queries++; return { rows: [] }; } };
  await expect(publishGraphDrafts(fake, contract, { vertices: [draft], removals: [] })).rejects.toThrow('host-issued');
  await expect(ensureVertex(fake, contract, draft)).rejects.toThrow('host-issued');
  await expect(publishOpinion(fake, contract, { ...draft, nodeId: '1' })).rejects.toThrow('host-issued');
  await expect(removeEntity(fake, contract, draft)).rejects.toThrow('host-issued');
  await expect(withdrawEdge(fake, contract, 'missing', '1', 'fixture')).rejects.toThrow('host-issued');
  await expect(publishGraphDrafts(fake, contract, { vertices: [draft], removals: [] }, 1, { binding: { ...binding } as ProducerBinding })).rejects.toThrow('host-issued');
  await expect(publishGraphDrafts(fake, contract, { vertices: [], removals: [] }, 1, { binding: { ...binding } as ProducerBinding, author: 'forged' })).rejects.toThrow('host-issued');
  expect(queries).toBe(0);
});

test('binding checks product, context, contract, producer, version and properties', async () => {
  const publish = async (changed = draft, context = 1, held = contract) => await owner.transaction('write', async tx => await publishGraphDrafts(tx, held, { vertices: [changed], removals: [] }, context, { binding }));
  await expect(publish({ ...draft, producer: 'other' })).rejects.toThrow('caller producer');
  await expect(publish({ ...draft, producerVersion: '2' })).rejects.toThrow('caller producer');
  await expect(publish(draft, 2)).rejects.toThrow('context');
  await expect(publish(draft, 1, { ...contract, dictionary: [{ name: 'different', fields: [], key: [] }] })).rejects.toThrow('contract');
  await expect(publish({ ...draft, selectedFields: ['other'] })).rejects.toThrow('property');
  await expect(publish({ ...draft, selectedFields: undefined } as unknown as typeof draft)).rejects.toThrow('property');
  const fake = { query: async () => ({ rows: [] }) };
  await expect(publishGraphDrafts(fake, contract, { vertices: [draft], removals: [] }, 1, { binding })).rejects.toThrow('another product');
  await expect(publish()).resolves.toBeGreaterThan(0);
  await expect(owner.transaction('write', async tx => await publishGraphDrafts(tx, contract, { vertices: [], removals: [] }, 1, { binding, author: 'forged' }))).rejects.toThrow('journal author');
  await expect(owner.transaction('write', async tx => await removeEntity(tx, contract, { ...draft, withdrawAll: true }, 1, undefined, binding))).rejects.toThrow('permit merge');
});

test('retained scope identities and permission verbs do not come from caller labels', async () => {
  const other = await registerSystemSource(owner, contract, { type: 'plugin', installationKey: 'fixture', version: '1', scope: 'different-scope' });
  expect(other.uid).not.toBe(principal.uid);
  const readOnly = bindGraphProducer(owner, contract, { principal, vertices: { sample: ['value'] }, edges: {}, actions: [] });
  await expect(owner.transaction('write', async tx => await publishGraphDrafts(tx, contract, { vertices: [draft], removals: [] }, 1, { binding: readOnly }))).rejects.toThrow('permit assert');
  const before = await owner.run(async tx => await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM operation'));
  await expect(owner.transaction('write', async tx => await publishGraphDrafts(tx, contract, { vertices: [], removals: [] }, 1, { binding: readOnly, reads: [{ method: 'fixture', size: 1, outcome: 'answered' }] }))).rejects.toThrow('permit assert');
  const after = await owner.run(async tx => await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM operation'));
  expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  const assertOnly = bindGraphProducer(owner, contract, { principal, vertices: { sample: ['value'] }, edges: {}, actions: ['assert'] });
  await expect(owner.transaction('write', async tx => await removeEntity(tx, contract, draft, 1, undefined, assertOnly))).rejects.toThrow('retract-own');
  const copy = JSON.parse(JSON.stringify(contract)) as GraphContract;
  await expect(owner.transaction('write', async tx => await publishGraphDrafts(tx, copy, { vertices: [draft], removals: [] }, 1, { binding }))).resolves.toBe(0);
});
