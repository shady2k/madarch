import { expect, test } from 'bun:test';
import { catalogueRequests, parseRequest } from '../src/graph/door-contract.js';
import { productTools, callProductTool } from '../src/mcp/authored.js';
import type { GraphContract } from '../src/graph/contract.js';
import type { KnowledgeProduct } from '../src/knowledge/product.js';

const contract: GraphContract = {
  vertex: [
    { name: 'sample', table: 'k_sample', capability: 'test', key: ['name'], fields: [{ name: 'name', type: 'text' }, { name: 'count', type: 'integer' }, { name: 'optional', type: 'boolean', nullable: true }] },
    { name: 'link', table: 'k_link', capability: 'test', key: ['target'], fields: [{ name: 'target', type: 'json', reference: 'sample' }] },
  ], edge: [{ name: 'relates', from: ['sample'], to: ['link'], repeats: false, capability: 'test', fields: [{ name: 'weight', type: 'integer' }] }], dictionary: [],
};
const evidence = [{ type: 'conversation', id: 'c1', words: 'observed' }];
const requests = catalogueRequests(contract);
const valid = { kind: 'sample', key: { name: 'n' }, values: { count: 2 }, evidence };

test('advertised tool schemas contain closed per-kind values and typed recursive keys', () => {
  const tools = productTools(contract);
  const json = JSON.stringify(tools.find(tool => tool.name === 'put_entity')!.inputSchema);
  expect(json).toContain('additionalProperties');
  expect(json).toContain('count');
  expect(json).toContain('target');
  expect(json).toContain('integer');
  expect(json).toContain('minProperties');
  expect(json).toContain('required');
  expect(json).toContain('anyOf');
  expect(tools.map(tool => tool.name)).toEqual(['graph_schema', 'graph_query', 'render_diagram', 'put_entity', 'put_edge', 'retract']);
});

test('catalogue types, ranges, keys and closed values are refused before product writes', async () => {
  let calls = 0;
  const product = { requestContract: async () => contract, putEntity: async () => { calls++; return {}; } } as unknown as KnowledgeProduct;
  for (const input of [
    { ...valid, values: { count: '2' } },
    { ...valid, values: { count: 2147483648 } },
    { ...valid, values: { count: null } },
    { ...valid, values: { typo: 1 } },
    { ...valid, key: { name: 1 } },
    { ...valid, key: { name: 'n', typo: true } },
    { ...valid, kind: 'unknown' },
    { ...valid, words: false },
  ]) {
    const answer = await callProductTool(product, { producer: 'test', version: '1' }, 'put_entity', input);
    expect(answer.isError).toBe(true);
    expect((answer.answer as { error: { code: string } }).error.code).toBe('SCHEMA_INVALID');
  }
  expect(calls).toBe(0);
  expect(parseRequest(requests.put_entity, { ...valid, values: { optional: null } })).toMatchObject({ values: { optional: null } });
});

test('reference keys and edge attributes follow their own catalogue contracts', () => {
  expect(() => parseRequest(requests.put_entity, { kind: 'link', key: { target: { kind: 'sample', key: { name: 8 } } }, values: {}, evidence })).toThrow();
  expect(() => parseRequest(requests.put_edge, { kind: 'relates', from: { kind: 'sample', key: { name: 'n' } }, to: { kind: 'link', key: { target: { kind: 'sample', key: { name: 'n' } } } }, values: { weight: 'bad' }, evidence })).toThrow('/values/weight');
});

test('read tools refuse malformed envelopes rather than dropping properties', async () => {
  const product = {} as KnowledgeProduct;
  for (const [name, args] of [['graph_schema', { kind: 'unknown' }], ['graph_query', { query: '{}', variables: [] }], ['graph_query', { query: '{}', typo: true }], ['render_diagram', { entity: 'n', depth: 2 }]] as const) {
    const answer = await callProductTool(product, { producer: 'test', version: '1' }, name, args);
    expect(answer.isError).toBe(true);
    expect((answer.answer as { error: { code: string } }).error.code).toBe('SCHEMA_INVALID');
  }
});

 test('authored values include natural key fields on create and edit', () => {
  expect(parseRequest(requests.authored('sample', 'create'), { values: { name: 'n', count: 1 } })).toMatchObject({ values: { name: 'n' } });
  expect(parseRequest(requests.authored('sample', 'edit'), { uid: 'n', values: { name: 'n' } })).toMatchObject({ values: { name: 'n' } });
});
