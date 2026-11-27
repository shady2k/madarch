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
import { PluginHost } from '../src/plugin/host.js';
import { closureOf } from '../src/plugin/closure.js';
import { reconcileFacts, reconciliationBatches, type ContractDeclaration, type EntityRef, type ReconciliationWrite, type VertexResult } from '../src/plugin-sdk.js';

const ref = (id: string): EntityRef => ({ kind: 'item', key: { id } });
const fact = (id: string, value = 1): VertexResult => ({ ...ref(id), values: { value } });
const link = (from: EntityRef, to: EntityRef, discriminator?: string) => ({ kind: 'link', from, to, ...(discriminator === undefined ? {} : { discriminator }) });
const contract: ContractDeclaration = {
  vertices: [{ kind: 'item', key: ['id'] }],
  edges: [{ kind: 'link', from: 'item', to: 'item', cardinality: { from: 'many', to: 'many' }, labels: { en: { out: 'links', in: 'linked' }, ru: { out: 'links', in: 'linked' } } }],
};
const unit = { unitId: 'alx1098-partition', kind: 'item', key: {}, inputs: { keys: [{ id: 'selected' }] } };
const ownership = { kind: unit.kind, keys: unit.inputs.keys };
const add = (id: string): ReconciliationWrite => ({ operation: 'add', vertex: fact(id) });


for (const explicit of [false, true]) test(`ALX1098 SDK ${explicit ? 'explicit' : 'terminal'} reconciliation passes partition ownership`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'alx1098-sdk-'));
  try {
    writeFileSync(join(root, 'plugin.json'), JSON.stringify({ name: 'ownership-probe', version: '1.0.0', entry: 'main.ts', runtime: { name: 'bun', version: Bun.version }, produces: [{ kind: 'item', fields: '*' }] }));
    writeFileSync(join(root, 'contract.json'), JSON.stringify({ id: 'ownership-probe', version: '1.0.0', outputs: { vertices: [{ kind: 'item', key: ['id'], fields: [{ name: 'value', type: 'integer', meaning: 'value', example: 1, required: false }] }], edges: [] }, rights: { network: 'none', graph: true, graphReads: ['ownFacts'] } }));
    const source = { vertices: [fact('existing-support', 2)], end: { state: 'complete' } };
    writeFileSync(join(root, 'main.ts'), `import { definePlugin } from 'madarch-plugin-sdk'; await definePlugin({name:'ownership-probe',version:'1.0.0',graph:true,graphReads:['ownFacts'],contract:{vertices:[{kind:'item',key:['id'],fields:[{name:'value',type:'integer',meaning:'value',example:1,required:false}]}],edges:[]},async extract(unit,context){${explicit ? `await context.reconcile(${JSON.stringify(source)},{}); return {end:{state:'complete'}};` : `return ${JSON.stringify(source)};`}}});`);
    const closure = closureOf(root);
    const operations: unknown[] = [];
    const host = new PluginHost({ pluginFolder: root, closure, repository: root, workRoot: join(root, 'work'), trust: 'production', releaseHashes: [closure.hash], env: { ...process.env, MADARCH_PLUGIN_SANDBOX: 'off' }, operations: { async apply(_unit, _key, operation) { operations.push(operation); return { accepted: true }; } }, graph: { files: async () => [], value: async () => null, ownFacts: async () => ({ vertices: [fact('existing-support'), fact('unseen-support')], edges: [] }) } });
    const session = await host.open();
    try {
      const outcome = await session.runUnit(unit);
      expect(outcome.state).toBe('extracted');
      expect(operations).toEqual([]);
    } finally { await session.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// N6: partition ownership changes neither already stored support nor unseen support.
test('ALX1098 keyed reconciliation adds missing support but preserves existing and unseen support', () => {
  const source = { vertices: [fact('selected', 2), fact('existing-support', 2), fact('missing-support')], end: { state: 'complete' as const } };
  const current = { vertices: [fact('selected'), fact('existing-support'), fact('unseen-support')], edges: [] };
  expect(reconcileFacts(source, current, {}, ownership)).toEqual([
    { operation: 'add', vertex: fact('missing-support') },
    { operation: 'update', vertex: fact('selected', 2) },
  ]);
  expect(reconcileFacts({ end: { state: 'complete' } }, current, {}, ownership)).toEqual([{ operation: 'remove', vertex: fact('selected') }]);
  expect(reconcileFacts(source, current, {}).map(write => [write.operation, write.vertex?.key['id']])).toEqual([
    ['update', 'existing-support'], ['add', 'missing-support'], ['update', 'selected'], ['remove', 'unseen-support'],
  ]);
});

test('ALX1098 no-keys reconciliation retains exact add/update/remove behavior', () => {
  const source = { vertices: [fact('added'), fact('changed', 2), fact('same')], end: { state: 'complete' as const } };
  const current = { vertices: [fact('changed'), fact('removed'), fact('same')], edges: [] };
  expect(reconcileFacts(source, current, {}).map(write => [write.operation, write.vertex?.key['id']])).toEqual([
    ['add', 'added'], ['update', 'changed'], ['remove', 'removed'],
  ]);
});

// A2: optional/many links still hold newly introduced same-kind support with its witness.
test('ALX1098 a support add cannot cross a 500-fact boundary from its selected witness', () => {
  const keys = Array.from({ length: 500 }, (_, i) => ({ id: String(i).padStart(3, '0') }));
  const selectedUnit = { ...unit, inputs: { keys } };
  const witness = link(ref('000'), ref('!support'));
  const writes: ReconciliationWrite[] = [...keys.map(key => add(key.id)), add('!support'), { operation: 'add', edge: witness }];
  const batches = [...reconciliationBatches(writes, contract, selectedUnit)];
  expect(batches.map(batch => (batch.vertices?.length ?? 0) + (batch.edges?.length ?? 0))).toEqual([500, 2]);
  const supportBatch = batches.find(batch => batch.vertices?.some(vertex => vertex.key['id'] === '!support'));
  expect(supportBatch?.edges).toEqual([witness]);
  expect(batches.flatMap(batch => batch.edges ?? [])).toEqual([witness]);
  expect([...reconciliationBatches([...writes].reverse(), contract, selectedUnit)]).toEqual(batches);
});

test('ALX1098 support selects the first full edge identity by code point, not input order', () => {
  const edges = ['𐀀', ''].map(discriminator => ({ ...link(ref('selected'), ref('support'), discriminator), values: { text: 'x'.repeat(300_000) } }));
  const writes: ReconciliationWrite[] = [add('support'), ...edges.map(edge => ({ operation: 'add' as const, edge }))];
  const batches = [...reconciliationBatches(writes, contract, unit)];
  expect(batches).toHaveLength(2);
  expect(batches[0]).toEqual({ vertices: [fact('support')], edges: [edges[1]!] });
  expect(batches[1]).toEqual({ edges: [edges[0]!] });
  expect([...reconciliationBatches([...writes].reverse(), contract, unit)]).toEqual(batches);
});

// N8: refusing the whole stream must precede even an otherwise ready first batch.
for (const invalid of ['missing', 'reverse', 'foreign-kind', 'unrelated', 'update'] as const) test(`ALX1098 ${invalid} witness is refused before yielding operations`, () => {
  const keys = Array.from({ length: 501 }, (_, i) => ({ id: String(i).padStart(3, '0') }));
  const selectedUnit = { ...unit, inputs: { keys: [...keys, { id: 'selected' }] } };
  const invalidEdge = invalid === 'reverse' ? link(ref('support'), ref('selected'))
    : invalid === 'foreign-kind' ? link({ kind: 'foreign', key: { id: 'selected' } }, ref('support'))
    : invalid === 'unrelated' ? link(ref('not-selected'), ref('support'))
    : link(ref('selected'), ref('support'));
  const writes: ReconciliationWrite[] = [...keys.map(key => add(key.id)), add('support'), ...(invalid === 'missing' ? [] : [{ operation: invalid === 'update' ? 'update' as const : 'add' as const, edge: invalidEdge }])];
  const stream = reconciliationBatches(writes, contract, selectedUnit);
  let message = '';
  try { stream.next(); } catch (error) { message = (error as Error).message; }
  expect(message).toContain(unit.unitId);
  expect(message).toContain('support');
  expect(message).toContain('item');
  expect(message).toContain('/src/plugin-sdk.ts:');
});

{

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
}
