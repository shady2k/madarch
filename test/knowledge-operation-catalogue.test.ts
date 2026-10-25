import {expect, test} from 'bun:test';
import {operationMetadata} from '../src/knowledge/operation-catalogue.js';
import type {RenderContext} from '../src/knowledge/blocks.js';
import type {GraphEntity} from '../src/knowledge/graph-read.js';
const entity = (key: string, kind: string, properties = {}): GraphEntity => ({key, kind, label: key, properties, scope: 'scope', nodeIds: ['1']});
test('catalogue uses declared contract identity and preserves implementation/caller counts', async () => {
  const contract = entity('code.contract:api.yaml', 'code.contract', {format: 'openapi'});
  const route = entity('code.route:router.ts#GET:/items', 'code.route');
  const caller = entity('code.symbol:client.ts#list', 'code.symbol');
  const operation = entity('code.operation:api.yaml#GET:/items', 'code.operation');
  const ctx = {manifest: {kinds: new Map([['code.contract', {}], ['code.route', {}], ['code.symbol', {}]])}, repoOfScope: () => 'catalog', graph: {neighbors: async () => [
    {relation: 'code.declares', total: 1, rows: [{entity: contract}]},
    {relation: 'code.serves', total: 1, rows: [{entity: route}]},
    {relation: 'code.calls-remote', total: 501, rows: [{entity: caller}]},
  ]}} as unknown as RenderContext;
  const result = await operationMetadata(ctx, operation);
  expect(result.contracts).toEqual([{entity: {id: contract.key, kind: 'code.contract', label: contract.key, href: '/k/e/code.contract%3Aapi.yaml'}, protocol: 'OpenAPI'}]);
  expect(result.implementedBy.map((held) => held.id)).toEqual([route.key]);
  expect(result.calledBy.map((held) => held.id)).toEqual([caller.key]);
  expect(result.cuts).toEqual([{relation: 'code.calls-remote', shown: 1, total: 501}]);
});
test('an unowned operation remains visible as unassigned metadata', async () => {
  const ctx = {graph: {neighbors: async () => []}} as unknown as RenderContext;
  expect(await operationMetadata(ctx, entity('code.operation:unknown', 'code.operation'))).toEqual({contracts: [], implementedBy: [], calledBy: [], cuts: []});
});
