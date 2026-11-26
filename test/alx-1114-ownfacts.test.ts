import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { runPluginTurn, type PluginTurnWiring } from '../src/fill/plugin-turns.js';
import { closureOf } from '../src/plugin/closure.js';
import { createTestDatabaseOwner } from './test-database.js';
import { bindTestWriteCapability, TEST_SOURCE_UID } from './write-capability-fixture.js';

const own = 'Fixture.node';
const foreign = 'Fixture.foreign';
const labels = { en: { out: 'links', in: 'linked by' }, ru: { out: 'links', in: 'linked by' } };
const pairs = [
  { kind: 'Fixture.link', from: own, to: own },
  { kind: 'Fixture.incoming', from: foreign, to: own },
  { kind: 'Fixture.outgoing', from: own, to: foreign },
];
const contract: GraphContract = {
  vertex: [own, foreign].map(name => ({ name, table: generatedTableName(name, 'vertex'), key: ['id'], capability: 'reader', evidence: { immutable: true }, fields: [{ name: 'id', type: 'text' }] })),
  edge: pairs.map(edge => ({ name: edge.kind, table: generatedTableName(edge.kind, 'edge'), from: [edge.from], to: [edge.to], capability: 'reader', repeats: false, cardinality: { from: 'many', to: 'many' }, labels, fields: [] })), dictionary: [],
};
const ref = (id: string, kind = own) => ({ kind, key: { id } });

for (const enabled of [true, false]) {
  test(`actual keyed SDK ownFacts expands only same-source forward support: own-kind support ${enabled}`, async () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-alx1114-'));
    const owner = await createTestDatabaseOwner({ graphContract: contract });
    try {
      await owner.transaction('write', async tx => {
        await bindTestWriteCapability(tx, contract, '019a0000-0000-7000-8000-000000000099');
        await publishGraphDrafts(tx, contract, { vertices: [{ ...ref('second-producer'), producer: 'other', producerVersion: '1' }], removals: [] }, 1);
        await bindTestWriteCapability(tx, contract);
        await publishGraphDrafts(tx, contract, { vertices: [
          ...['K', 'A', 'D', 'reverse', 'outside', 'foreign-anchor'].map(id => ({ ...ref(id), producer: 'reader', producerVersion: '1' })),
          ...['K', 'A'].map(id => ({ ...ref(id, foreign), producer: 'reader', producerVersion: '1' })),
        ], edges: [
          { kind: 'Fixture.link', from: ref('K'), to: ref('A') },
          { kind: 'Fixture.link', from: ref('reverse'), to: ref('K') },
          { kind: 'Fixture.link', from: ref('outside'), to: ref('D') },
          { kind: 'Fixture.link', from: ref('K'), to: ref('second-producer') },
          { kind: 'Fixture.incoming', from: ref('K', foreign), to: ref('foreign-anchor') },
          { kind: 'Fixture.outgoing', from: ref('K'), to: ref('A', foreign) },
        ].map(edge => ({ ...edge, producer: 'reader', producerVersion: '1' })), removals: [] }, 1);
      });
      const declaration = { name: 'reader', version: '1.0.0', entry: 'main.ts', runtime: { name: 'bun', version: Bun.version }, produces: [{ kind: own, fields: '*', partition: 'key', ...(enabled ? { support: { vertices: [own], edges: pairs.map(edge => edge.kind) } } : {}) }] };
      const outputs = { vertices: [{ kind: own, key: ['id'], fields: [{ name: 'id', type: 'text', meaning: 'identity', example: 'K', required: true }], evidence: { immutable: true } }], edges: pairs.map(edge => ({ ...edge, cardinality: { from: 'many', to: 'many' }, labels, fields: [] })) };
      writeFileSync(join(folder, 'plugin.json'), JSON.stringify(declaration));
      writeFileSync(join(folder, 'contract.json'), JSON.stringify({ id: 'reader', version: '1.0.0', outputs, rights: { network: 'none', graph: true, graphReads: ['ownFacts'] } }));
      const expectedVertices = (enabled ? ['A', 'K'] : ['K']).map(id => ({ ...ref(id), values: {} }));
      const expectedEdges = [
        { kind: 'Fixture.link', from: ref('K'), to: ref('A'), values: {} },
        { kind: 'Fixture.link', from: ref('K'), to: ref('second-producer'), values: {} },
        { kind: 'Fixture.outgoing', from: ref('K'), to: ref('A', foreign), values: {} },
      ];
      writeFileSync(join(folder, 'main.ts'), `import { definePlugin } from 'madarch-plugin-sdk';
await definePlugin({name:'reader',version:'1.0.0',contract:${JSON.stringify(outputs)},graph:true,graphReads:['ownFacts'],async planOutput(unit,context){
const facts=await context.graph.ownFacts({});
const order=(a,b)=>JSON.stringify(a)<JSON.stringify(b)?-1:JSON.stringify(a)>JSON.stringify(b)?1:0;
const normalize=facts=>({vertices:facts.vertices.sort(order),edges:facts.edges.sort(order)});
const expected=${JSON.stringify({vertices:expectedVertices,edges:expectedEdges})};
if(JSON.stringify(normalize(facts))!==JSON.stringify(normalize(expected))) throw new Error('wrong exact ownFacts '+JSON.stringify(facts)+' expected '+JSON.stringify(expected));
return {partitions:[]};},extract(){throw new Error('planning only');}});`);
      const closure = closureOf(folder);
      const kind = { name: own, key: ['id'], fields: [] };
      const wiring = { productFolder: folder, sourceUid: TEST_SOURCE_UID, snapshots: { pins: async () => [] }, manifest: { file: join(folder, 'kinds.yaml'), kinds: new Map([[own, kind], [foreign, { name: foreign, key: ['id'], fields: [] }]]), plugins: new Map([['reader', { id: 'reader', path: '.', declaration, contract: outputs }]]) }, locks: new Map([['reader', { id: 'reader', version: '1.0.0', closure: closure.hash }]]), owner, contract, releaseHashes: [closure.hash] } as unknown as PluginTurnWiring;
      let planned = false;
      await runPluginTurn(wiring, 'reader:Fixture.node', () => {}, undefined, undefined, undefined, undefined, { keys: [{ id: 'K' }], plan() { planned = true; } });
      expect(planned).toBe(true);
    } finally { await owner.close(); rmSync(folder, { recursive: true, force: true }); }
  }, 30_000);
}
