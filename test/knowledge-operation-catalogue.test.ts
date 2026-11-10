import { expect, test } from 'bun:test';
import { operationMetadata } from '../src/knowledge/operation-catalogue.js';
import type { RenderContext } from '../src/knowledge/blocks.js';
import type { GraphEntity } from '../src/knowledge/graph-read.js';
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


test('every current catalogue relation retains its exact cut metadata', async () => {
  const relations = ['code.declares', 'code.serves', 'code.calls-remote', 'code.calls', 'code.implements'];
  const operation = entity('code.operation:neutral.yaml#GET:/records', 'code.operation');
  const ctx = {manifest: {kinds: new Map()}, repoOfScope: () => 'neutral', graph: {neighbors: async () => relations.map((relation) => ({relation, total: 501, rows: []}))}} as unknown as RenderContext;
  expect((await operationMetadata(ctx, operation)).cuts).toEqual(relations.map((relation) => ({relation, shown: 0, total: 501})));
});


test('declared AsyncAPI channels keep ownership, real links and application flow', async () => {
  const channel = {...entity('code.channel:inventory.adjusted', 'code.channel'), label: 'inventory.adjusted'};
  const owner = entity('code.contract:descriptions/events.yaml', 'code.contract', {format: 'asyncapi'});
  const producer = entity('code.file:emit.ts', 'code.file'); const consumer = entity('code.file:read.ts', 'code.file');
  const ctx = {productFolder: '/fixture', manifest: {kinds: new Map([['code.contract', {}], ['code.channel', {}], ['code.file', {}]])}, repoOfScope: () => 'neutral', readSource: async () => 'asyncapi: 2.6.0\nchannels:\n  inventory.adjusted:\n    subscribe: {message: {name: Record}}\n    publish: {message: {name: Record}}', graph: {neighbors: async () => [{relation: 'code.declares', total: 1, rows: [{entity: owner}]}, {relation: 'code.publishes', total: 1, rows: [{entity: producer}]}, {relation: 'code.consumes', total: 501, rows: [{entity: consumer}]}]}} as unknown as RenderContext;
  const metadata = await operationMetadata(ctx, channel);
  expect(metadata.contracts[0]).toMatchObject({entity: {id: owner.key, href: '/k/e/code.contract%3Adescriptions%2Fevents.yaml'}, protocol: 'AsyncAPI', directionStatus: 'known', directions: ['publish', 'subscribe']});
  expect(metadata.contracts[0]?.producedBy?.map((row) => row.id)).toEqual([producer.key]);
  expect(metadata.contracts[0]?.consumedBy?.map((row) => row.id)).toEqual([consumer.key]);
  expect(metadata.cuts).toContainEqual({relation: 'code.consumes', shown: 1, total: 501});
  ctx.readSource = async () => 'asyncapi: 3.0.0\nchannels: {}\noperations: {sendRecord: {action: send}}';
  expect((await operationMetadata(ctx, channel)).contracts[0]).toMatchObject({directionStatus: 'unavailable'});
  expect((await operationMetadata(ctx, channel)).contracts[0]?.directions).toBeUndefined();
});
