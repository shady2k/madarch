import { expect, test } from 'bun:test';
import { generatedTableName, type GraphContract, type EntityRefDraft } from '../src/graph/contract.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { createTestDatabaseOwner } from './test-database.js';

const contract: GraphContract = {
  vertex: ['parent', 'child', 'other'].map(name => ({ name, table: generatedTableName(name, 'vertex'), fields: [{ name: 'name', type: 'text' }], key: ['name'], capability: 'fixture' })),
  edge: [{ name: 'owns', table: generatedTableName('owns', 'edge'), from: ['parent'], to: ['child'], repeats: false, fields: [], capability: 'fixture' }],
  dictionary: [],
};
const ref = (kind: string, name: string): EntityRefDraft => ({ kind, key: { name } });
const vertex = (kind: string, name: string) => ({ ...ref(kind, name), producer: 'fixture', producerVersion: '1' });

test('0039.1: endpoint kinds and uid bindings are checked atomically in the writer', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    await owner.transaction('write', tx => publishGraphDrafts(tx, contract, {
      vertices: [vertex('parent', 'p'), vertex('child', 'c'), vertex('other', 'o')], removals: [],
    }));
    const identities = await owner.transaction('snapshot', tx => tx.query<{ uid: string; kind: string }>(
      'SELECT n.uid::text AS uid, k.name AS kind FROM node n JOIN entity k ON k.id = n.entity_id',
    ));
    const uid = (kind: string) => identities.rows.find(row => row.kind === kind)!.uid;
    const snapshot = () => owner.transaction('snapshot', async tx => ({
      nodes: (await tx.query('SELECT * FROM node ORDER BY id')).rows,
      edges: (await tx.query('SELECT * FROM edge ORDER BY id')).rows,
      journal: (await tx.query('SELECT * FROM operation ORDER BY seq')).rows,
    }));
    const before = await snapshot();
    const publish = (from: EntityRefDraft, to: EntityRefDraft) => owner.transaction('write', tx => publishGraphDrafts(tx, contract, {
      vertices: [vertex('child', 'rolled-back')], removals: [],
      edges: [{ kind: 'owns', from, to, producer: 'fixture', producerVersion: '1' }],
    }));
    await expect(publish(ref('other', 'o'), ref('child', 'c'))).rejects.toThrow('expected "parent"');
    expect(await snapshot()).toEqual(before);
    await expect(publish(ref('parent', 'p'), ref('other', 'o'))).rejects.toThrow('expected "child"');
    expect(await snapshot()).toEqual(before);
    await expect(publish({ ...ref('parent', 'p'), uid: uid('other') }, ref('child', 'c'))).rejects.toThrow('but it belongs to "other"');
    expect(await snapshot()).toEqual(before);
    await expect(publish(ref('parent', 'p'), { ...ref('child', 'c'), uid: uid('other') })).rejects.toThrow('but it belongs to "other"');
    expect(await snapshot()).toEqual(before);
    await owner.transaction('write', tx => publishGraphDrafts(tx, contract, {
      vertices: [], removals: [], edges: [{ kind: 'owns', from: ref('parent', 'p'), to: ref('child', 'c'), producer: 'fixture', producerVersion: '1' }],
    }));
    expect((await snapshot()).edges).toHaveLength(1);
  } finally { await owner.close(); }
}, 30_000);

test.each(['from', 'to'] as const)('0039.1: a removed %s endpoint is refused', async side => {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    await owner.transaction('write', tx => publishGraphDrafts(tx, contract, { vertices: [vertex('parent', 'p'), vertex('child', 'c')], removals: [] }));
    const removed = side === 'from' ? ref('parent', 'p') : ref('child', 'c');
    await owner.transaction('write', tx => publishGraphDrafts(tx, contract, { vertices: [], removals: [{ ...removed, producer: 'fixture' }] }));
    await expect(owner.transaction('write', tx => publishGraphDrafts(tx, contract, {
      vertices: [], removals: [], edges: [{ kind: 'owns', from: ref('parent', 'p'), to: ref('child', 'c'), producer: 'fixture', producerVersion: '1' }],
    }))).rejects.toThrow('names removed uid');
    expect((await owner.transaction('snapshot', tx => tx.query('SELECT * FROM edge'))).rows).toEqual([]);
  } finally { await owner.close(); }
}, 30_000);

test('0039.1: an endpoint from another context is refused', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    await owner.transaction('write', tx => publishGraphDrafts(tx, contract, { vertices: [vertex('parent', 'p'), vertex('child', 'c')], removals: [] }));
    await owner.transaction('write', tx => tx.query("INSERT INTO context (ref) VALUES ('other-context')"));
    await expect(owner.transaction('write', tx => publishGraphDrafts(tx, contract, {
      vertices: [], removals: [], edges: [{ kind: 'owns', from: ref('parent', 'p'), to: ref('child', 'c'), producer: 'fixture', producerVersion: '1' }],
    }, 2))).rejects.toThrow('not 2');
    expect((await owner.transaction('snapshot', tx => tx.query('SELECT * FROM edge'))).rows).toEqual([]);
  } finally { await owner.close(); }
}, 30_000);
