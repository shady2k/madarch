import {expect, test} from 'bun:test';
import {definitionBlock} from '../src/knowledge/definition.js';
import type {RenderContext} from '../src/knowledge/blocks.js';
import type {GraphEntity} from '../src/knowledge/graph-read.js';
const contract: GraphEntity = {key: 'code.contract:contracts/api.yaml', kind: 'code.contract', label: 'Catalogue', properties: {format: 'openapi'}, scope: 'scope', nodeIds: ['1']};
const operation: GraphEntity = {key: 'code.operation:contracts/api.yaml#GET:/items', kind: 'code.operation', label: 'GET /items', properties: {method: 'GET', path: '/items'}, scope: 'scope', nodeIds: ['2']};
function context(text: string, owners = 1): RenderContext {
  return {productFolder: '/fixture', manifest: {kinds: new Map([['code.contract', {}], ['code.operation', {}]])}, repoOfScope: () => 'catalog', readSource: async () => text, graph: {neighbors: async (entity: GraphEntity) => entity.kind === 'code.operation' ? [{relation: 'code.declares', direction: 'in', total: owners, rows: owners === 0 ? [] : [{entity: contract}]}] : []}} as unknown as RenderContext;
}
test('an operation selects its method and path, not the first operation', async () => {
  const ctx = context('openapi: 3.0.3\ninfo: {title: Catalogue, version: 1.0.0}\npaths:\n  /other: {post: {operationId: other, responses: {}}}\n  /items: {get: {responses: {}}}');
  const block = await definitionBlock(ctx, {source: 'graph', entity: operation}, {}, 'templates/operation.md', 2);
  expect(block.type).toBe('definition');
  if (block.type !== 'definition') return;
  expect(block.selection).toMatchObject({method: 'get', path: '/items'});
  expect(block.selection?.operationId).not.toBe('other');
  expect(block.document).toHaveProperty('paths');
  expect(block.diagnostics).toBeUndefined();
});
test('missing selection is an explicit source-located error, never another operation', async () => {
  const block = await definitionBlock(context('openapi: 3.0.3\npaths: {}'), {source: 'graph', entity: operation}, {}, 'templates/operation.md', 2);
  expect(block.type).toBe('definition');
  if (block.type === 'definition') expect(block.diagnostics?.[0]).toMatchObject({path: 'contracts/api.yaml', line: 1, fullPath: '/fixture/repos/catalog/contracts/api.yaml', code: 'selection'});
});
test('ambiguous and absent contract owners do not choose a fallback', async () => {
  for (const owners of [0, 2]) {
    const block = await definitionBlock(context('', owners), {source: 'graph', entity: operation}, {}, 'templates/operation.md', 2);
    expect(block).toMatchObject({type: 'problem', file: 'templates/operation.md', line: 2});
  }
});

test('a valid local referenced Path Item selects the declared method', async () => {
  const ctx = context('openapi: 3.0.3\npaths:\n  /items: {$ref: "#/components/pathItems/Items"}\ncomponents:\n  pathItems:\n    Items:\n      get: {operationId: listItems, responses: {}}');
  const block = await definitionBlock(ctx, {source: 'graph', entity: operation}, {}, 'templates/operation.md', 2);
  expect(block.type).toBe('definition');
  if (block.type === 'definition') { expect(block.selection).toEqual({method: 'get', path: '/items', operationId: 'listItems'}); expect(block.diagnostics).toBeUndefined(); }
});
test('cyclic path items are visible refusal diagnostics, not unbounded resolution', async () => {
  const ctx = context('openapi: 3.0.3\npaths:\n  /items: {$ref: "#/paths/~1items"}');
  const block = await definitionBlock(ctx, {source: 'graph', entity: operation}, {}, 'templates/operation.md', 2);
  expect(block.type).toBe('definition');
  if (block.type === 'definition') expect(block.diagnostics?.[0]?.detail).toContain('cyclic');
});


test('selection and early problem diagnostics preserve legacy block shapes and messages', async () => {
  const missing = await definitionBlock(context('openapi: 3.0.3\npaths: {}'), {source: 'graph', entity: operation}, {}, 'templates/detail.md', 7);
  if (missing.type !== 'definition') throw new Error('expected definition');
  expect(missing.diagnostics?.[0]?.reason).toEqual({code: 'operationSelectionMissing', params: {method: 'get', path: '/items'}});
  for (const count of [0, 2]) {
    const block = await definitionBlock(context('', count), {source: 'graph', entity: operation}, {}, 'templates/detail.md', 7);
    expect(block).toMatchObject({type: 'problem', block: 'definition', file: 'templates/detail.md', line: 7});
    if (block.type !== 'problem') throw new Error('expected problem');
    expect(block.message).toBe(`templates/detail.md:7 (/fixture/templates/detail.md): operation must have exactly one declaring contract; found ${count}`);
    expect(block.diagnostic).toMatchObject({path: 'templates/detail.md', line: 7, fullPath: '/fixture/templates/detail.md', reason: {code: 'declaringContractCount', params: {count}}});
  }
});

test('unexpected read failures keep original evidence without parsing English', async () => {
  const ctx = context('');
  ctx.readSource = async () => {throw new Error('Original vendor evidence «не переводить»');};
  const block = await definitionBlock(ctx, {source: 'graph', entity: contract}, {}, 'templates/detail.md', 7);
  if (block.type !== 'definition') throw new Error('expected definition');
  expect(block.diagnostics?.[0]).toMatchObject({code: 'parse', reason: {code: 'unknownDefinitionFailure'}, detail: 'Error: Original vendor evidence «не переводить»', technicalDetail: 'Error: Original vendor evidence «не переводить»'});
});


test('an unsupported graph subject keeps its legacy problem and gains a structured reason', async () => {
  const subject = {...contract, kind: 'code.file'};
  const block = await definitionBlock(context(''), {source: 'graph', entity: subject}, {}, 'templates/detail.md', 7);
  expect(block).toMatchObject({type: 'problem', block: 'definition', file: 'templates/detail.md', line: 7, message: 'templates/detail.md:7 (/fixture/templates/detail.md): definition requires a contract or operation'});
  if (block.type !== 'problem') throw new Error('expected problem');
  expect(block.diagnostic).toMatchObject({path: 'templates/detail.md', line: 7, fullPath: '/fixture/templates/detail.md', reason: {code: 'definitionSubjectUnsupported'}});
});
