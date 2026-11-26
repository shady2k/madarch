import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { readKindAssertions } from '../src/graph/records.js';
import { loadAssertions } from '../src/graph/assertion-read.js';
import { PluginHost } from '../src/plugin/host.js';
import { closureOf } from '../src/plugin/closure.js';
import { createTestDatabaseOwner } from './test-database.js';

const ref = (id: string) => ({ kind: 'item', key: { id } });
const fact = (id: string, value: string) => ({ ...ref(id), values: { value } });
const graph: GraphContract = {
  vertex: [{ name: 'item', table: generatedTableName('item', 'vertex'), key: ['id'], capability: 'fixture', fields: [{ name: 'id', type: 'text' }, { name: 'value', type: 'text' }] }],
  edge: [], dictionary: [],
};

for (const operation of ['update', 'remove'] as const) test(`ALX1114 mutable owner can ${operation} its selected vertex`, async () => {
  const owner = await createTestDatabaseOwner({ graphContract: graph });
  const draft = { ...fact('selected', 'original'), producer: 'fixture', producerVersion: '1' };
  try {
    await owner.transaction('write', tx => publishGraphDrafts(tx, graph, { vertices: [draft], removals: [] }));
    await owner.transaction('write', tx => publishGraphDrafts(tx, graph, operation === 'update'
      ? { vertices: [{ ...draft, values: { value: 'changed' } }], removals: [] }
      : { vertices: [], removals: [{ ...ref('selected'), producer: 'fixture' }] }));
    const remaining = await owner.run(tx => readKindAssertions(tx, 'vertex', 'item', ['value'], { contract: graph }));
    expect(remaining.map(row => row.values.value)).toEqual(operation === 'update' ? ['changed'] : []);
    const history = await owner.run(tx => loadAssertions(tx, 'vertex', 'item', ['$exists', 'value']));
    expect(history.some(row => row.property === 'value' && row.value === 'original')).toBe(true);
    if (operation === 'remove') expect(history.some(row => row.operation === 'retract' && row.property === '$exists')).toBe(true);
    else expect(history.some(row => row.operation === 'assert' && row.property === 'value' && row.value === 'changed' && row.validTo === null)).toBe(true);
  } finally { await owner.close(); }
}, 30_000);

for (const desired of ['different', 'absent'] as const) test(`ALX1114 automatic keyed SDK leaves nonowner support ${desired} desired state untouched`, async () => {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-owner-sdk-'));
  try {
    const outputs = { vertices: [{ kind: 'item', key: ['id'], fields: [{ name: 'value', type: 'text', meaning: 'value', example: 'original', required: false }] }], edges: [] };
    writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ name: 'owner-probe', version: '1.0.0', entry: 'main.ts', runtime: { name: 'bun', version: Bun.version }, produces: [{ kind: 'item', fields: '*', partition: 'key' }] }));
    writeFileSync(join(folder, 'contract.json'), JSON.stringify({ id: 'owner-probe', version: '1.0.0', outputs, rights: { network: 'none', graph: true, graphReads: ['ownFacts'] } }));
    const result = { vertices: [fact('selected', 'changed'), ...(desired === 'different' ? [fact('support', 'changed support')] : [])], end: { state: 'complete' } };
    writeFileSync(join(folder, 'main.ts'), `import { definePlugin } from 'madarch-plugin-sdk'; await definePlugin({name:'owner-probe',version:'1.0.0',graph:true,graphReads:['ownFacts'],contract:${JSON.stringify(outputs)},async extract(){return ${JSON.stringify(result)};}});`);
    const closure = closureOf(folder);
    const operations: unknown[] = [];
    const host = new PluginHost({ pluginFolder: folder, closure, repository: folder, workRoot: join(folder, 'work'), trust: 'production', releaseHashes: [closure.hash], operations: { async apply(_unit, _key, operation) { operations.push(operation); return { accepted: true }; } }, graph: { files: async () => [], value: async () => null, ownFacts: async () => ({ vertices: [fact('selected', 'original'), fact('support', 'original support')], edges: [] }) } });
    const session = await host.open();
    try {
      const outcome = await session.runUnit({ unitId: 'owner-probe', kind: 'item', key: {}, inputs: { keys: [{ id: 'selected' }] } });
      expect(outcome.state).toBe('extracted');
      expect(operations).toEqual([{ vertices: [fact('selected', 'changed')] }]);
    } finally { await session.close(); }
  } finally { rmSync(folder, { recursive: true, force: true }); }
}, 30_000);


test('ALX1114 immutable endpoint owner may remove an ordinary edge without retiring vertices', async () => {
  const contract: GraphContract = {
    ...graph,
    vertex: graph.vertex.map(kind => ({ ...kind, evidence: { immutable: true } })),
    edge: [{ name: 'link', table: generatedTableName('link', 'edge'), capability: 'fixture', from: ['item'], to: ['item'], repeats: false, fields: [], cardinality: { from: 'many', to: 'many' }, labels: { en: { out: 'links', in: 'linked by' }, ru: { out: 'links', in: 'linked by' } } }],
  };
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  const edge = { kind: 'link', from: ref('selected'), to: ref('support'), producer: 'fixture', producerVersion: '1' };
  try {
    await owner.transaction('write', tx => publishGraphDrafts(tx, contract, { vertices: ['selected', 'support'].map(id => ({ ...fact(id, 'original'), producer: 'fixture', producerVersion: '1' })), edges: [edge], removals: [] }));
    const before = await owner.run(tx => loadAssertions(tx, 'vertex', 'item', ['$exists', 'value']));
    await owner.transaction('write', tx => publishGraphDrafts(tx, contract, { vertices: [], removals: [], edgeRemovals: [edge] }));
    expect(await owner.run(tx => readKindAssertions(tx, 'edge', 'link', [], { contract }))).toEqual([]);
    expect(await owner.run(tx => loadAssertions(tx, 'vertex', 'item', ['$exists', 'value']))).toEqual(before);
    expect(await owner.run(tx => readKindAssertions(tx, 'vertex', 'item', ['value'], { contract }))).toHaveLength(2);
  } finally { await owner.close(); }
}, 30_000);
