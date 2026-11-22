import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PluginHost } from '../src/plugin/host.js';
import { closureOf } from '../src/plugin/closure.js';
import { generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { applyPluginFacts } from '../src/graph/graph-writes.js';
import { producerFacts } from '../src/graph/producer-facts.js';
import { createTestDatabaseOwner } from './test-database.js';
import { bindTestWriteCapability, TEST_SOURCE_UID } from './write-capability-fixture.js';
import { reconciliationBatches, type ContractDeclaration, type EntityRef, type ReconciliationWrite, type FactsOperation } from '../src/plugin-sdk.js';

const ref = (id: string): EntityRef => ({ kind: 'Fixture.node', key: { id } });
const link = (from: string, to: string) => ({ kind: 'Fixture.link', from: ref(from), to: ref(to) });
const labels = { en: { out: 'links', in: 'linked' }, ru: { out: 'links', in: 'linked' } };
const outputs: ContractDeclaration = {
  vertices: [{ kind: 'Fixture.node', key: ['id'], fields: [{ name: 'id', type: 'text', meaning: 'identity', example: '000', required: true }, { name: 'text', type: 'text', meaning: 'payload', example: '', required: false }] }],
  edges: [{ kind: 'Fixture.link', from: 'Fixture.node', to: 'Fixture.node', cardinality: { from: 'many', to: 'many' }, labels, fields: [] }],
};
const contract: GraphContract = {
  vertex: [{ name: 'Fixture.node', table: generatedTableName('Fixture.node', 'vertex'), key: ['id'], capability: 'reader', fields: [{ name: 'id', type: 'text' }, { name: 'text', type: 'text', nullable: true }] }],
  edge: [{ name: 'Fixture.link', table: generatedTableName('Fixture.link', 'edge'), from: ['Fixture.node'], to: ['Fixture.node'], capability: 'reader', repeats: false, cardinality: { from: 'many', to: 'many' }, labels, fields: [] }], dictionary: [],
};
const add = (id: string): ReconciliationWrite => ({ operation: 'add', vertex: ref(id) });
const count = (operation: FactsOperation) => Object.values(operation).reduce((sum, facts) => sum + facts.length, 0);

for (const bytes of [false, true]) test(`ALX1114 automatic reconciliation persists late selected endpoint before support witness (${bytes ? 'bytes' : 'count'})`, async () => {
  const folder = mkdtempSync(join(tmpdir(), 'alx1114-'));
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  const keys = Array.from({ length: bytes ? 4 : 500 }, (_, i) => ({ id: String(i).padStart(3, '0') }));
  const last = keys.at(-1)!.id;
  const unit = { unitId: 'alx1114-late-endpoint', kind: 'Fixture.node', key: {}, inputs: { keys } };
  const source = { vertices: [...keys.map(key => ({ kind: 'Fixture.node', key, ...(bytes ? { values: { text: '界'.repeat(60_000) } } : {}) })), ref('!support')], edges: [link(last, '!support')], end: { state: 'complete' } };
  const logs: { identities: unknown; count: number; serializedBytes: number; outcome: string }[] = [];
  try {
    writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ name: 'reader', version: '1.0.0', entry: 'main.ts', runtime: { name: 'bun', version: Bun.version }, produces: [{ kind: 'Fixture.node', fields: '*', partition: 'key', support: { vertices: ['Fixture.node'], edges: ['Fixture.link'] } }] }));
    writeFileSync(join(folder, 'contract.json'), JSON.stringify({ id: 'reader', version: '1.0.0', outputs, rights: { network: 'none', graph: true, graphReads: ['ownFacts'] } }));
    writeFileSync(join(folder, 'main.ts'), `import { definePlugin } from 'madarch-plugin-sdk'; await definePlugin({name:'reader',version:'1.0.0',graphReads:['ownFacts'],contract:${JSON.stringify(outputs)},extract(){return ${JSON.stringify(source)};}});`);
    const closure = closureOf(folder);
    const host = new PluginHost({ pluginFolder: folder, closure, repository: folder, workRoot: join(folder, 'work'), trust: 'production', releaseHashes: [closure.hash], env: process.env,
      graph: { files: async () => [], value: async () => null, ownFacts: async () => await producerFacts(owner, contract, TEST_SOURCE_UID, ['Fixture.node'], ['Fixture.link']) },
      operations: { async apply(_unit, _key, operation) {
        const log = { identities: { vertices: operation.vertices?.map(v => v.key), edges: operation.edges?.map(e => [e.from, e.to]) }, count: count(operation), serializedBytes: Buffer.byteLength(JSON.stringify(operation)), outcome: 'pending' };
        logs.push(log);
        try {
          await owner.transaction('write', async tx => {
            await bindTestWriteCapability(tx, contract);
            await applyPluginFacts(tx, contract, { vertices: (operation.vertices ?? []).map(vertex => ({ ...vertex, producer: 'reader', producerVersion: '1.0.0' })), edges: (operation.edges ?? []).map(edge => ({ ...edge, producer: 'reader', producerVersion: '1.0.0' })), removals: [] }, 1);
          });
          log.outcome = 'accepted';
          return { accepted: true };
        } catch (error) { log.outcome = String(error); throw error; }
      } },
    });
    const session = await host.open();
    try {
      const outcome = await session.runUnit(unit);
      console.log(JSON.stringify({ case: bytes ? 'bytes' : 'count', operations: logs, outcome }));
      expect(outcome.state).toBe('extracted');
      const persisted = await producerFacts(owner, contract, TEST_SOURCE_UID, ['Fixture.node'], ['Fixture.link']);
      expect(persisted.vertices).toHaveLength(keys.length + 1);
      expect(persisted.edges).toEqual([{ ...link(last, '!support'), values: {} }]);
      expect(logs.every(log => log.outcome === 'accepted' && log.serializedBytes <= 512 * 1024)).toBe(true);
      expect(logs).toHaveLength(2);
      if (!bytes) expect(logs.map(log => log.count)).toEqual([500, 2]);
      else expect(logs.every(log => log.count < 500)).toBe(true);
    } finally { await session.close(); }
  } finally { await owner.close(); rmSync(folder, { recursive: true, force: true }); }
}, 60_000);

const unit = { unitId: 'alx1114-groups', kind: 'Fixture.node', key: {} };
const batches = (writes: ReconciliationWrite[], selected?: string[]) => [...reconciliationBatches(writes, outputs, selected === undefined ? unit : { ...unit, inputs: { keys: selected.map(id => ({ id })) } })];

test('ALX1114 dependency uses either full endpoint identity and leaves optional fan-out split', () => {
  const parent = ref('parent');
  const child = { ...ref('same'), keyEdges: { parent } };
  const unrelated = { ...ref('same'), keyEdges: { parent: ref('other') } };
  const writes: ReconciliationWrite[] = [add('!support'), { operation: 'add', vertex: child }, { operation: 'add', vertex: parent }, { operation: 'add', edge: { kind: 'Fixture.link', from: child, to: ref('!support') } }];
  const result = batches(writes, ['same', 'parent']);
  expect(result[0]!.vertices!.indexOf(parent)).toBeLessThan(result[0]!.vertices!.indexOf(child));
  expect(result[0]!.edges).toHaveLength(1);
  expect(batches([...writes].reverse(), ['same', 'parent'])).toEqual(result);
  expect(() => batches([{ ...writes[0]! }, { operation: 'add', vertex: unrelated }, writes[3]!], ['same'])).not.toThrow();
  const fanout: ReconciliationWrite[] = [...Array.from({ length: 600 }, (_, i) => add(String(i))), ...Array.from({ length: 599 }, (_, i): ReconciliationWrite => ({ operation: 'add', edge: link('0', String(i + 1)) }))];
  expect(batches(fanout).map(count)).toEqual([500, 500, 199]);
});

function cycle(extra = 0, payload = ''): ReconciliationWrite[] {
  const a = ref('a'), b = ref('b');
  const sa = { ...ref('!a'), keyEdges: { parent: b } };
  const sb = { ...ref('!b'), keyEdges: { parent: a } };
  return [{ operation: 'add', vertex: a }, { operation: 'add', vertex: b },
    { operation: 'add', vertex: { ...sa, values: { text: payload } } }, { operation: 'add', vertex: sb },
    { operation: 'add', edge: { kind: 'Fixture.link', from: a, to: sa } },
    { operation: 'add', edge: { kind: 'Fixture.link', from: b, to: sb } },
    ...Array.from({ length: extra }, (_, i): ReconciliationWrite => ({ operation: 'add', vertex: { ...ref(`extra-${i}`), keyEdges: { parent: a } } }))];
}

test('ALX1114 a dependency cycle stays atomic and deterministic when it fits', () => {
  const writes = cycle();
  const result = batches(writes, ['a', 'b']);
  expect(result).toHaveLength(1);
  expect(count(result[0]!)).toBe(6);
  expect(batches([...writes].reverse(), ['a', 'b'])).toEqual(result);
});

for (const dimension of ['count', 'bytes'] as const) test(`ALX1114 oversized ${dimension} cycle is refused before the first operation`, () => {
  const writes = [...Array.from({ length: 501 }, (_, i) => add(`0-${i}`)), ...cycle(dimension === 'count' ? 495 : 0, dimension === 'bytes' ? '界'.repeat(180_000) : '')];
  const iterator = reconciliationBatches(writes, outputs, { ...unit, inputs: { keys: writes.filter(write => write.vertex !== undefined && !String(write.vertex.key['id']).startsWith('!')).map(write => write.vertex!.key) } });
  let message = '';
  try { iterator.next(); } catch (error) { message = String(error); }
  expect(message).toContain('/src/plugin-sdk.ts:');
  expect(message).toContain(unit.unitId);
  expect(message).toContain('Fixture.node');
  expect(message).toContain('facts and');
  expect(message).toContain('serialized bytes');
  expect(message).toContain(dimension === 'count' ? '501 facts' : '512 KB');
});

test('ALX1114 ordering waits for both added endpoints at count and UTF-8 byte boundaries', () => {
  for (const size of [0, 180_000]) {
    const keys = Array.from({ length: size === 0 ? 500 : 4 }, (_, i) => String(i).padStart(3, '0'));
    const last = keys.at(-1)!;
    const writes: ReconciliationWrite[] = [...keys.map(id => ({ operation: 'add' as const, vertex: { ...ref(id), ...(size === 0 ? {} : { values: { text: '界'.repeat(size / 3) } }) } })), add('!support'), { operation: 'add', edge: link(last, '!support') }];
    const result = batches(writes, keys);
    expect(result).toHaveLength(2);
    expect(result[0]!.edges).toBeUndefined();
    expect(result[1]!.edges).toEqual([link(last, '!support')]);
    const seen = new Set<string>();
    for (const operation of result) {
      for (const vertex of operation.vertices ?? []) seen.add(String(vertex.key['id']));
      for (const edge of operation.edges ?? []) for (const end of [edge.from, edge.to]) expect(seen.has(String(end.key['id']))).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(operation))).toBeLessThanOrEqual(512 * 1024);
    }
    expect(batches([...writes].reverse(), keys)).toEqual(result);
    if (size === 0) expect(result.map(count)).toEqual([500, 2]);
  }
});
