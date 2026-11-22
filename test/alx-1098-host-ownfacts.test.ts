import { expect, test } from 'bun:test';
import { generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { producerFacts } from '../src/graph/producer-facts.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { createTestDatabaseOwner } from './test-database.js';
import { bindTestWriteCapability, TEST_SOURCE_UID } from './write-capability-fixture.js';

const contract: GraphContract = {
  vertex: [{ name: 'Fixture.node', table: generatedTableName('Fixture.node', 'vertex'), key: ['id'], capability: 'reader', fields: [{ name: 'id', type: 'text' }] }],
  edge: [{ name: 'Fixture.link', table: generatedTableName('Fixture.link', 'edge'), from: ['Fixture.node'], to: ['Fixture.node'], capability: 'reader', repeats: false, cardinality: { from: 'many', to: 'many' }, labels: { en: { out: 'links', in: 'linked by' }, ru: { out: 'links', in: 'linked by' } }, fields: [] }], dictionary: [],
};
const ref = (id: string) => ({ kind: 'Fixture.node', key: { id } });
const ownedEdges = [{ kind: 'Fixture.link', from: 'Fixture.node', to: 'Fixture.node' }];
const otherSource = '019a0000-0000-7000-8000-000000000099';

test('own-kind key scope includes only same-source direct forward support and keeps path and inactive scopes', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, contract);
      await publishGraphDrafts(tx, contract, { vertices: ['selected', 'support', 'reverse', 'unrelated', 'second-hop'].map(id => ({ ...ref(id), producer: 'reader', producerVersion: '1' })), edges: [
        ['selected', 'support'], ['reverse', 'selected'], ['unrelated', 'reverse'], ['support', 'second-hop'],
      ].map(([from, to]) => ({ kind: 'Fixture.link', from: ref(from!), to: ref(to!), producer: 'reader', producerVersion: '1' })), removals: [] }, 1);
    });
    await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, contract, otherSource);
      await publishGraphDrafts(tx, contract, { vertices: [{ ...ref('foreign-source'), producer: 'other', producerVersion: '1' }], edges: [], removals: [] }, 1);
    });
    await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, contract);
      await publishGraphDrafts(tx, contract, { vertices: [], edges: [{ kind: 'Fixture.link', from: ref('selected'), to: ref('foreign-source'), producer: 'reader', producerVersion: '1' }], removals: [] }, 1);
    });
    const scope = { kind: 'Fixture.node', ownedEdges, keys: [{ id: 'selected' }], supportKeys: true };
    const read = (scope: NonNullable<Parameters<typeof producerFacts>[5]>) => producerFacts(owner, contract, TEST_SOURCE_UID, ['Fixture.node'], ['Fixture.link'], scope);
    const facts = await read(scope);
    expect(facts.vertices.map(vertex => vertex.key.id).sort()).toEqual(['selected', 'support']);
    expect(facts.edges.map(edge => edge.to.key.id).sort()).toEqual(['foreign-source', 'support']);
    expect((await read({ ...scope, supportKeys: false })).vertices.map(vertex => vertex.key.id)).toEqual(['selected']);
    expect(await read({ ...scope, paths: ['src'] })).toEqual({ vertices: [], edges: [] });
    expect((await read({ ...scope, ownedEdges: [] })).vertices.map(vertex => vertex.key.id)).toEqual(['selected']);
    expect((await read({ ...scope, keys: [] })).vertices).toEqual([]);
    expect((await read({ kind: 'Fixture.node', ownedEdges, supportKeys: true })).vertices).toHaveLength(5);
  } finally { await owner.close(); }
}, 30_000);

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closureOf } from '../src/plugin/closure.js';
import { runPluginTurn, type PluginTurnWiring } from '../src/fill/plugin-turns.js';

for (const mode of ['enabled', 'no-declaration', 'no-immutable', 'parent', 'only', 'path'] as const) {
  test(`host ownFacts keeps own-kind support gating and scope: ${mode}`, async () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-ownfacts-scope-'));
    const owner = await createTestDatabaseOwner({ graphContract: contract });
    try {
      await owner.transaction('write', async tx => {
        await bindTestWriteCapability(tx, contract);
        await publishGraphDrafts(tx, contract, { vertices: ['selected', 'support'].map(id => ({ ...ref(id), producer: 'reader', producerVersion: '1' })), edges: [{ kind: 'Fixture.link', from: ref('selected'), to: ref('support'), producer: 'reader', producerVersion: '1' }], removals: [] }, 1);
      });
      const declaration = { name: 'reader', version: '1.0.0', entry: 'main.ts', runtime: { name: 'bun', version: Bun.version }, produces: [{ kind: 'Fixture.node', fields: '*', partition: 'key', ...(mode === 'no-declaration' ? {} : { support: { vertices: ['Fixture.node'], edges: mode === 'no-immutable' ? [] : ['Fixture.link'] } }) }] };
      const outputs = { vertices: [{ kind: 'Fixture.node', key: ['id'], fields: [{ name: 'id', type: 'text', meaning: 'identity', example: 'selected', required: true }], ...(mode === 'no-immutable' ? {} : { evidence: { immutable: true } }) }], edges: [{ kind: 'Fixture.link', from: 'Fixture.node', to: 'Fixture.node', cardinality: { from: 'many', to: 'many' }, labels: contract.edge[0]!.labels, fields: [] }] };
      const rights = { network: 'none', graph: true, graphReads: ['files', 'value', 'ownFacts'] };
      writeFileSync(join(folder, 'plugin.json'), JSON.stringify(declaration));
      writeFileSync(join(folder, 'contract.json'), JSON.stringify({ id: 'reader', version: '1.0.0', outputs, rights }));
      const expected = mode === 'enabled' ? ['selected', 'support'] : mode === 'parent' || mode === 'path' ? [] : ['selected'];
      const scope = mode === 'parent' ? { parent: ref('support') } : {};
      writeFileSync(join(folder, 'main.ts'), `import { definePlugin } from 'madarch-plugin-sdk';
await definePlugin({ name:'reader', version:'1.0.0', contract:${JSON.stringify(outputs)}, graph:true, graphReads:['files','value','ownFacts'], async planOutput(unit, context) {
const facts = await context.graph.ownFacts(${JSON.stringify(scope)});
const actual = facts.vertices.map(vertex => vertex.key.id).sort();
if (JSON.stringify(actual) !== ${JSON.stringify(JSON.stringify(expected))}) throw new Error('wrong ownFacts '+JSON.stringify(facts));
return {partitions:[]};
}, extract(){throw new Error('planning only');} });`);
      const closure = closureOf(folder);
      const kind = { name: 'Fixture.node', key: ['id'], fields: [] };
      const plugin = { id: 'reader', path: '.', declaration, contract: outputs };
      const wiring = { productFolder: folder, sourceUid: TEST_SOURCE_UID, snapshots: { pins: async () => [] }, manifest: { file: join(folder, 'kinds.yaml'), kinds: new Map([[kind.name, kind]]), plugins: new Map([['reader', plugin]]) }, locks: new Map([['reader', { id: 'reader', version: '1.0.0', closure: closure.hash }]]), owner, contract, releaseHashes: [closure.hash],
        ...(mode === 'only' ? { targets: { kinds: ['Fixture.node'], vertex: 'Fixture.node:selected' } } : {}), ...(mode === 'path' ? { paths: ['src'] } : {}),
      } as unknown as PluginTurnWiring;
      let planned = false;
      await runPluginTurn(wiring, 'reader:Fixture.node', () => {}, undefined, undefined, undefined, undefined, { keys: [{ id: 'selected' }], plan() { planned = true; } });
      expect(planned).toBe(true);
    } finally { await owner.close(); rmSync(folder, { recursive: true, force: true }); }
  }, 30_000);
}

test('support expansion retains path filtering and adds no read queries', async () => {
  const pathContract: GraphContract = { ...contract, vertex: [{ ...contract.vertex[0]!, key: ['path'], fields: [{ name: 'path', type: 'text' }] }] };
  const pathRef = (path: string) => ({ kind: 'Fixture.node', key: { path } });
  const owner = await createTestDatabaseOwner({ graphContract: pathContract });
  try {
    await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, pathContract);
      await publishGraphDrafts(tx, pathContract, { vertices: ['src/a', 'src/b', 'outside/c'].map(path => ({ ...pathRef(path), producer: 'reader', producerVersion: '1' })), edges: ['src/b', 'outside/c'].map(path => ({ kind: 'Fixture.link', from: pathRef('src/a'), to: pathRef(path), producer: 'reader', producerVersion: '1' })), removals: [] }, 1);
    });
    let queries = 0;
    const counted = new Proxy(owner, { get(target, property, receiver) {
      if (property !== 'transaction') return Reflect.get(target, property, receiver);
      const transaction: typeof owner.transaction = (kind, work) => owner.transaction(kind, tx => work(new Proxy(tx, { get(target, property, receiver) {
        if (property !== 'query') return Reflect.get(target, property, receiver);
        const query: typeof tx.query = (sql, values) => { queries += 1; return tx.query(sql, values); };
        return query;
      } })));
      return transaction;
    } });
    const scope = { kind: 'Fixture.node', ownedEdges, keys: [{ path: 'src/a' }], paths: ['src'] };
    const read = (supportKeys: boolean) => producerFacts(counted, pathContract, TEST_SOURCE_UID, ['Fixture.node'], ['Fixture.link'], { ...scope, supportKeys });
    expect((await read(false)).vertices.map(vertex => vertex.key.path)).toEqual(['src/a']);
    const baseline = queries; queries = 0;
    const expanded = await read(true);
    expect(expanded.vertices.map(vertex => vertex.key.path).sort()).toEqual(['src/a', 'src/b']);
    expect(expanded.edges.map(edge => edge.to.key.path).sort()).toEqual(['outside/c', 'src/b']);
    expect(queries).toBe(baseline);
  } finally { await owner.close(); }
}, 30_000);
