import { expect, test } from 'bun:test';
import { sha256Hex } from '../src/graph/digest.js';
import { generatedTableName, type GraphContract, type VertexDraft } from '../src/graph/contract.js';
import { producerFacts } from '../src/graph/producer-facts.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { reconcileFacts } from '../src/plugin-sdk.js';
import { createTestDatabaseOwner } from './test-database.js';
import { bindTestWriteCapability, TEST_SOURCE_UID } from './write-capability-fixture.js';

const retained = 'first\nsecond\nthird\nfourth';
const digest = sha256Hex(Buffer.from(retained));
const contract: GraphContract = {
  vertex: [{ name: 'fixture.snapshot', table: generatedTableName('fixture.snapshot', 'vertex'), key: ['digest'], capability: 'reader', fields: [{ name: 'digest', type: 'text' }, { name: 'content', type: 'text' }], evidence: { immutable: true, digestField: 'digest', contentField: 'content', digestAlgorithm: 'sha256' } }, { name: 'fixture.item', table: generatedTableName('fixture.item', 'vertex'), key: ['name'], capability: 'reader', fields: [{ name: 'name', type: 'text' }, { name: 'text', type: 'text', nullable: true }] }],
  edge: [{ name: 'fixture.link', table: generatedTableName('fixture.link', 'edge'), from: ['fixture.item'], to: ['fixture.item'], cardinality: { from: 'many', to: 'many' }, labels: { en: { out: 'links', in: 'linked by' }, ru: { out: 'связан', in: 'связан' } }, repeats: true, discriminator: 'place', capability: 'reader', fields: [{ name: 'text', type: 'text', nullable: true }] }],
  dictionary: [],
};
const evidence = [{ target: { kind: 'fixture.snapshot', key: { digest } }, locator: { path: 'src/items.ts', lineStart: 2, lineEnd: 4 } }];
const otherSource = '019a0000-0000-7000-8000-000000000099';
const item = (name: string, text: string, producer = 'reader'): VertexDraft => ({ kind: 'fixture.item', key: { name }, values: { text }, producer, producerVersion: '1', evidence });
const ref = (name: string) => ({ kind: 'fixture.item', key: { name } });

test('own-fact storage reads only current producer opinions, retaining values and evidence for no-op reconciliation', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    const publish = async (vertices: readonly VertexDraft[], source = TEST_SOURCE_UID) => await owner.transaction('write', async tx => { await bindTestWriteCapability(tx, contract, source); return await publishGraphDrafts(tx, contract, { vertices, removals: [] }, 1); });
    await publish([{ kind: 'fixture.snapshot', key: { digest }, values: { content: retained }, producer: 'reader', producerVersion: '1' }]);
    await publish([item('changed', 'old'), item('removed', 'gone')]);
    await publish([item('other-source', 'not ours', 'other')], otherSource);
    await publish([item('changed', 'current'), item('target', 'target')]);
    await owner.transaction('write', async tx => await publishGraphDrafts(tx, contract, { vertices: [], removals: [{ kind: 'fixture.item', key: { name: 'removed' }, producer: 'reader', evidence }], edges: [
      { kind: 'fixture.link', from: ref('changed'), to: ref('target'), discriminator: 'line:2', values: { text: 'linked' }, producer: 'reader', producerVersion: '1', evidence },
    ] }, 1));
    const facts = await producerFacts(owner, contract, TEST_SOURCE_UID, ['fixture.item'], ['fixture.link']);
    expect(facts.vertices.map(v => v.key['name']).sort()).toEqual(['changed', 'target']);
    expect(facts.vertices.find(v => v.key['name'] === 'changed')?.values).toEqual({ text: 'current' });
    const expectedEvidence = { target: { kind: 'fixture.snapshot', key: { digest } }, path: 'src/items.ts', lineStart: 2, lineEnd: 4 };
    for (const vertex of facts.vertices) expect(vertex.evidence).toMatchObject(expectedEvidence);
    expect(facts.edges).toMatchObject([{ kind: 'fixture.link', from: ref('changed'), to: ref('target'), discriminator: 'line:2', values: { text: 'linked' }, evidence: expectedEvidence }]);
    expect(reconcileFacts({ ...facts, end: { state: 'complete' } }, facts, {})).toEqual([]);
    const other = await producerFacts(owner, contract, otherSource, ['fixture.item'], ['fixture.link']);
    expect(other.vertices.map(v => v.key['name'])).toEqual(['other-source']);
    expect(other.edges).toEqual([]);
  } finally { await owner.close(); }
}, 30_000);
