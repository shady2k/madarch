import { expect, test } from 'bun:test';
import { generatedTableName, type GraphContract, type VertexDraft } from '../src/graph/contract.js';
import { producerFacts } from '../src/graph/producer-facts.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { reconcileFacts } from '../src/plugin-sdk.js';
import { createTestDatabaseOwner } from './test-database.js';

const contract: GraphContract = {
  vertex: [{ name: 'fixture.item', table: generatedTableName('fixture.item', 'vertex'), key: ['name'], capability: 'reader', fields: [{ name: 'name', type: 'text' }, { name: 'text', type: 'text', nullable: true }] }],
  edge: [{ name: 'fixture.link', table: generatedTableName('fixture.link', 'edge'), from: ['fixture.item'], to: ['fixture.item'], repeats: true, discriminator: 'place', capability: 'reader', fields: [{ name: 'text', type: 'text', nullable: true }] }],
  dictionary: [],
};
const evidence = [{ type: 'file' as const, repository: 'fixture', commit_or_digest: 'current', path: 'src/items.ts', line_start: 2, line_end: 4 }];
const item = (name: string, text: string, producer = 'reader'): VertexDraft => ({ kind: 'fixture.item', key: { name }, values: { text }, producer, producerVersion: '1', evidence });
const ref = (name: string) => ({ kind: 'fixture.item', key: { name } });

test('own-fact storage reads only current producer opinions, retaining values and evidence for no-op reconciliation', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    const publish = async (vertices: readonly VertexDraft[]) => await owner.transaction('write', async tx => await publishGraphDrafts(tx, contract, { vertices, removals: [] }, 1));
    await publish([item('changed', 'old'), item('removed', 'gone'), item('other-source', 'not ours', 'other')]);
    await publish([item('changed', 'current'), item('target', 'target')]);
    await owner.transaction('write', async tx => await publishGraphDrafts(tx, contract, { vertices: [], removals: [{ kind: 'fixture.item', key: { name: 'removed' }, producer: 'reader', evidence }], edges: [
      { kind: 'fixture.link', from: ref('changed'), to: ref('target'), discriminator: 'line:2', values: { text: 'linked' }, producer: 'reader', producerVersion: '1', evidence },
    ] }, 1));
    const facts = await producerFacts(owner, contract, 'reader', ['fixture.item'], ['fixture.link']);
    expect(facts.vertices.map(v => v.key['name']).sort()).toEqual(['changed', 'target']);
    expect(facts.vertices.find(v => v.key['name'] === 'changed')?.values).toEqual({ text: 'current' });
    const expectedEvidence = { repository: 'fixture', commitOrDigest: 'current', path: 'src/items.ts', lineStart: 2, lineEnd: 4 };
    expect(facts.vertices.every(v => JSON.stringify(v.evidence) === JSON.stringify(expectedEvidence))).toBe(true);
    expect(facts.edges).toEqual([{ kind: 'fixture.link', from: ref('changed'), to: ref('target'), discriminator: 'line:2', values: { text: 'linked' }, evidence: expectedEvidence }]);
    expect(reconcileFacts({ ...facts, end: { state: 'complete' } }, facts, { repository: 'fixture', commit: 'next' })).toEqual([]);
    const other = await producerFacts(owner, contract, 'other', ['fixture.item'], ['fixture.link']);
    expect(other.vertices.map(v => v.key['name'])).toEqual(['other-source']);
    expect(other.edges).toEqual([]);
  } finally { await owner.close(); }
});
