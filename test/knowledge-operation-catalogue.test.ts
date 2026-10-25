import {expect, test} from 'bun:test';
import {operationMetadata} from '../src/knowledge/operation-catalogue.js';
import {createPGliteDatabaseOwner} from '../src/adapters/database-owner.js';
import {createGraphStore} from '../src/graph/index.js';
import {GraphReader} from '../src/knowledge/graph-read.js';
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


test('production catalogue SQL pages declared channels and operations without changing kind lists', async () => {
  const owner = createPGliteDatabaseOwner({btreeGist: true});
  try {
    await owner.ready; const store = createGraphStore(owner); await store.createSchema();
    const scope = await store.newNode(); const owned = {producer: 'neutral.contracts', scope};
    await store.openNode({nodeId: scope, kind: 'code.repository', label: 'neutral', properties: {}, validFrom: '2026-01-01T00:00:00Z', owner: owned});
    const contract = await store.newNode();
    await store.openNode({nodeId: contract, kind: 'code.contract', label: 'Events', properties: {recordKey: 'code.contract:events.yaml', format: 'asyncapi'}, validFrom: '2026-01-01T00:00:00Z', owner: owned});
    for (const [name, declared] of [['first', true], ['second', true], ['unowned', false]] as const) {
      const channel = await store.newNode();
      await store.openNode({nodeId: channel, kind: 'code.channel', label: name, properties: {recordKey: `code.channel:${name}`}, validFrom: '2026-01-01T00:00:00Z', owner: owned});
      if (declared) await store.openEdge({relation: 'code.declares', src: contract, dst: channel, properties: {}, validFrom: '2026-01-01T00:00:00Z', owner: owned});
    }
    await store.openNode({kind: 'code.operation', label: 'GET /records', properties: {recordKey: 'code.operation:api.yaml#GET:/records'}, validFrom: '2026-01-01T00:00:00Z', owner: owned});
    const reader = new GraphReader(owner, () => '2026-01-02T00:00:00Z');
    const first = await reader.listOperations({limit: 1});
    expect(first.total).toBe(3); expect(first.rows.map((row) => row.key)).toEqual(['code.channel:first']); expect(first.next).toBe('code.channel:first');
    const second = await reader.listOperations({limit: 2, after: first.next!});
    expect(second.total).toBe(3); expect(second.rows.map((row) => row.key)).toEqual(['code.channel:second', 'code.operation:api.yaml#GET:/records']); expect(second.next).toBeNull();
    expect((await reader.listOperations({limit: 20, q: 'second'})).rows.map((row) => row.key)).toEqual(['code.channel:second']);
    expect((await reader.list('code.channel', {limit: 20})).total).toBe(3);
    expect((await reader.list('code.operation', {limit: 20})).total).toBe(1);
    expect((await reader.at('2025-12-31T00:00:00Z', scope).listOperations({limit: 20})).total).toBe(0);
  } finally {await owner.close();}
}, 20_000);
