import { expect, test } from 'bun:test';
import { generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { producerFacts } from '../src/graph/producer-facts.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { createTestDatabaseOwner } from './test-database.js';
import { bindTestWriteCapability, TEST_SOURCE_UID } from './write-capability-fixture.js';
import { runPluginTurn, type PluginTurnWiring } from '../src/fill/plugin-turns.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closureOf } from '../src/plugin/closure.js';

const contract: GraphContract = {
  vertex: [{ name: 'Fixture.node', table: generatedTableName('Fixture.node', 'vertex'), key: ['id'], capability: 'reader', evidence: { immutable: true }, fields: [{ name: 'id', type: 'text' }] }],
  edge: [{ name: 'Fixture.link', table: generatedTableName('Fixture.link', 'edge'), from: ['Fixture.node'], to: ['Fixture.node'], capability: 'reader', repeats: false, cardinality: { from: 'many', to: 'many' }, labels: { en: { out: 'links', in: 'linked by' }, ru: { out: 'links', in: 'linked by' } }, fields: [] }], dictionary: [],
};
const ref = (id: string) => ({ kind: 'Fixture.node', key: { id } });
const ownedEdges = [{ kind: 'Fixture.link', from: 'Fixture.node', to: 'Fixture.node' }];
const otherSource = '019a0000-0000-7000-8000-000000000099';

test('N7 declared same-source evidence pins expand only in-scope facts, without extra reads', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, contract, otherSource);
      await publishGraphDrafts(tx, contract, { vertices: [{ ...ref('foreign'), producer: 'other', producerVersion: '1' }], removals: [] }, 1);
      await bindTestWriteCapability(tx, contract);
      await publishGraphDrafts(tx, contract, { vertices: ['pin', 'edge-pin', 'unrelated', 'other', 'forward'].map(id => ({ ...ref(id), producer: 'reader', producerVersion: '1' })), removals: [] }, 1);
      await publishGraphDrafts(tx, contract, { vertices: [
        { ...ref('selected'), evidence: [{ target: ref('pin'), locator: { path: 'src/a' } }], producer: 'reader', producerVersion: '1' },
        { ...ref('other'), evidence: [{ target: ref('unrelated'), locator: { path: 'src/b' } }], producer: 'reader', producerVersion: '1' },
      ], edges: [
        { kind: 'Fixture.link', from: ref('selected'), to: ref('forward'), evidence: [{ target: ref('edge-pin'), locator: { path: 'src/a' } }], producer: 'reader', producerVersion: '1' },
        { kind: 'Fixture.link', from: ref('selected'), to: ref('other'), evidence: [{ target: ref('foreign'), locator: { path: 'src/a' } }], producer: 'reader', producerVersion: '1' },
      ], removals: [] }, 1);
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
    const scope = { kind: 'Fixture.node', ownedEdges, keys: [{ id: 'selected' }] };
    const read = (options: NonNullable<Parameters<typeof producerFacts>[5]>) => producerFacts(counted, contract, TEST_SOURCE_UID, ['Fixture.node'], ['Fixture.link'], options);
    const previous = await read(scope);
    expect(await read({ ...scope, supportKeys: false })).toEqual(previous);
    queries = 0; await read(scope); const baseline = queries; queries = 0;
    const expanded = await read({ ...scope, supportKeys: true });
    expect(expanded.vertices.map(v => v.key.id).sort()).toEqual(['edge-pin', 'forward', 'other', 'pin', 'selected']);
    expect(queries - baseline).toBeLessThanOrEqual(1);
    expect(await read({ ...scope, supportKeys: true, paths: ['outside'] })).toEqual({ vertices: [], edges: [] });
    expect((await read({ ...scope, supportKeys: true, keys: [] })).vertices).toEqual([]);
  } finally { await owner.close(); }
}, 30_000);

for (const mode of ['enabled', 'edge-evidence', 'no-declaration', 'no-immutable', 'parent', 'only', 'path', 'foreign-source'] as const) {
  test(`host ownFacts keeps own-kind support gating and scope: ${mode}`, async () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-ownfacts-scope-'));
    const owner = await createTestDatabaseOwner({ graphContract: contract });
    try {
      await owner.transaction('write', async tx => {
        if (mode === 'foreign-source') {
          await bindTestWriteCapability(tx, contract, otherSource);
          await publishGraphDrafts(tx, contract, { vertices: [{ ...ref('support'), producer: 'other', producerVersion: '1' }], removals: [] }, 1);
        }
        await bindTestWriteCapability(tx, contract);
        await publishGraphDrafts(tx, contract, { vertices: [
          ...(mode === 'foreign-source' ? [] : [{ ...ref('support'), producer: 'reader', producerVersion: '1' }]),
          { ...ref('selected'), ...(mode === 'edge-evidence' ? {} : { evidence: [{ target: ref('support'), locator: { path: 'src/a' } }] }), producer: 'reader', producerVersion: '1' },
        ], edges: mode === 'edge-evidence' ? [{ kind: 'Fixture.link', from: ref('selected'), to: ref('selected'), evidence: [{ target: ref('support'), locator: { path: 'src/a' } }], producer: 'reader', producerVersion: '1' }] : [], removals: [] }, 1);
      });
      const declaration = { name: 'reader', version: '1.0.0', entry: 'main.ts', runtime: { name: 'bun', version: Bun.version }, produces: [{ kind: 'Fixture.node', fields: '*', partition: 'key', ...(mode === 'no-declaration' ? {} : { support: { vertices: ['Fixture.node'], edges: mode === 'no-immutable' ? [] : ['Fixture.link'] } }) }] };
      const outputs = { vertices: [{ kind: 'Fixture.node', key: ['id'], fields: [{ name: 'id', type: 'text', meaning: 'identity', example: 'selected', required: true }], ...(mode === 'no-immutable' ? {} : { evidence: { immutable: true } }) }], edges: [{ kind: 'Fixture.link', from: 'Fixture.node', to: 'Fixture.node', cardinality: { from: 'many', to: 'many' }, labels: contract.edge[0]!.labels, fields: [] }] };
      const rights = { network: 'none', graph: true, graphReads: ['files', 'value', 'ownFacts'] };
      writeFileSync(join(folder, 'plugin.json'), JSON.stringify(declaration));
      writeFileSync(join(folder, 'contract.json'), JSON.stringify({ id: 'reader', version: '1.0.0', outputs, rights }));
      const expected = mode === 'enabled' || mode === 'edge-evidence' ? ['selected', 'support'] : mode === 'parent' ? [] : ['selected'];
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

