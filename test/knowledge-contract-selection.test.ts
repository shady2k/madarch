import { expect, test } from 'bun:test';
import { definitionBlock } from '../src/knowledge/definition.js';
import { buildViews } from '../src/knowledge/views.js';
import type { RenderContext } from '../src/knowledge/blocks.js';
import type { GraphEntity } from '../src/knowledge/graph-read.js';
import { fixtureManifest } from './knowledge-manifest-fixture.js';
const contract: GraphEntity = {key: 'code.contract:contracts/api.yaml', kind: 'code.contract', label: 'Catalogue', properties: {path: 'contracts/api.yaml', format: 'openapi'}, scope: 'scope', nodeIds: ['1']};
const operation: GraphEntity = {key: 'code.operation:items', kind: 'code.operation', label: 'GET /items', properties: {method: 'GET', path: '/items'}, scope: 'scope', nodeIds: ['2']};
function context(entity: GraphEntity, owners = 1): RenderContext {
  const manifest = fixtureManifest({'code.contract': {definitionBlock: 'contract'}, 'code.operation': {definitionBlock: 'operation'}, 'code.file': {views: ['state']}});
  return {productFolder: '/fixture', manifest, repoOfScope: () => 'catalog', graph: {
    find: async () => [entity],
    neighbors: async (held: GraphEntity) => held.kind === 'code.operation' ? [{relation: 'code.declares', direction: 'in', total: owners, rows: owners === 0 ? [] : [{entity: contract}]}] : [],
  }} as unknown as RenderContext;
}
test('a definition presents the published operation selection and complete document without reading source', async () => {
  const definition = {spec: {text: 'complete published text', lines: 1}, document: {paths: {'/items': {get: {}}}}, selection: {method: 'get', path: '/items', operationId: 'items'}};
  const entity = {...operation, properties: {...operation.properties, definition}};
  const block = await definitionBlock(context(entity), {source: 'graph', entity}, {}, 'templates/operation.md', 2);
  expect(block).toMatchObject({type: 'definition', ...definition});
});
test('missing definition opinions are explicit diagnostics, never re-read or synthesized definitions', async () => {
  const block = await definitionBlock(context(contract), {source: 'graph', entity: contract}, {}, 'templates/detail.md', 7);
  expect(block).toMatchObject({type: 'definition', diagnostics: [{path: 'contracts/api.yaml', line: 1, fullPath: '/fixture/repos/catalog/contracts/api.yaml', reason: {code: 'definitionMissing'}}]});
});
test('ambiguous and absent owners do not select a contract', async () => {
  for (const owners of [0, 2]) {
    const block = await definitionBlock(context(operation, owners), {source: 'graph', entity: operation}, {}, 'templates/detail.md', 7);
    expect(block).toMatchObject({type: 'problem', diagnostic: {path: 'templates/detail.md', line: 7, fullPath: '/fixture/templates/detail.md', reason: {code: 'declaringContractCount', params: {count: owners}}}});
  }
});
test('malformed definition opinions are refused and published diagnostics are preserved', async () => {
  const malformed = {...contract, properties: {...contract.properties, definition: {spec: {text: 'incomplete'}}}};
  expect(await definitionBlock(context(malformed), {source: 'graph', entity: malformed}, {}, 'template.md', 1)).toMatchObject({diagnostics: [{code: 'shape'}]});
  const definition = {spec: {text: '', lines: 0}, diagnostics: [{path: 'import.proto', line: 12, fullPath: '/fixture/import.proto', code: 'parse', detail: 'producer evidence'}]};
  const entity = {...contract, properties: {...contract.properties, definition}};
  expect(await definitionBlock(context(entity), {source: 'graph', entity}, {}, 'template.md', 1)).toMatchObject(definition);
});
test('state diagrams present graph transitions and source locations without parsing files', async () => {
  const entity = {...contract, key: 'code.file:order.ts', kind: 'code.file', properties: {state_machines: [{name: 'lifecycle', type: null, path: 'order.ts', lineStart: 3, lineEnd: 8, states: [{name: 'pending', label: 'Pending', line: 4}, {name: 'done', label: 'Done', line: 5}], transitions: [{from: 'pending', to: 'done', event: 'complete', line: 6}]}]}};
  const views = await buildViews({ctx: context(entity), lang: 'en', productTitle: 'Catalogue'}, {type: 'state', subject: entity.key});
  expect(views[0]?.elements.map((held) => held.label)).toEqual(['Pending', 'Done']);
  expect(views[0]?.edges[0]).toMatchObject({label: 'complete', location: {path: 'order.ts', lineStart: 6}});
});

test('malformed state opinions are explicit refusals, never smaller diagrams', async () => {
  for (const stateMachines of [null, [null], [{name: 'bad', path: 'order.ts', states: [], transitions: [{from: 'missing', to: 'other', event: null, line: 3}], type: null, lineStart: 1, lineEnd: 4}]]) {
    const entity = {...contract, key: 'code.file:order.ts', kind: 'code.file', properties: {state_machines: stateMachines}};
    await expect(buildViews({ctx: context(entity), lang: 'en', productTitle: 'Catalogue'}, {type: 'state', subject: entity.key})).rejects.toThrow(/:[0-9]+ \(/);
  }
});

test('definition opinions validate nested display fields before presenting them', async () => {
  for (const field of [{document: []}, {selection: {method: 'get'}}, {descriptions: [{text: 'x', path: 'api.yaml', fullPath: '/api.yaml', line: 0}]}, {protobuf: {services: [{name: 'Api', methods: [{}]}], messages: []}}, {diagnostics: [{path: 'api.yaml', fullPath: '/api.yaml', line: 1, code: 'parse', detail: 'bad', reason: {code: 'notAReason'}}]}]) {
    const entity = {...contract, properties: {...contract.properties, definition: {spec: {text: 'full text', lines: 1}, ...field}}};
    expect(await definitionBlock(context(entity), {source: 'graph', entity}, {}, 'template.md', 1)).toMatchObject({diagnostics: [{path: 'contracts/api.yaml', line: 1, fullPath: '/fixture/repos/catalog/contracts/api.yaml', code: 'shape'}]});
  }
  const definition = {spec: {text: 'proto', lines: 1}, protobuf: {services: [{name: 'Api', methods: [{name: 'Get', request: 'Request', response: 'Reply', requestStream: false, responseStream: false}]}], messages: [{name: 'Request', fields: [{name: 'id', type: 'string', id: 1, rule: 'optional'}]}]}};
  const entity = {...contract, properties: {...contract.properties, definition}};
  expect(await definitionBlock(context(entity), {source: 'graph', entity}, {}, 'template.md', 1)).toMatchObject(definition);
});
