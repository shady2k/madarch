import { expect, test } from 'bun:test';
import './alx-1098-host-ownfacts.test.js';
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
