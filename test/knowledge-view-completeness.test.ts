import { expect, test } from 'bun:test';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import { GraphReader, type GraphEntity, type RelationEdge } from '../src/knowledge/graph-read.js';
import type { RenderContext } from '../src/knowledge/blocks.js';
import { Resolver } from '../src/knowledge/resolve.js';
import { buildViews } from '../src/knowledge/views.js';

// Only the graph-read boundary is doubled. Every projection comes from the real view builders.
const unusedOwner: DatabaseOwner = {
  location: 'unused view fixture', ready: Promise.resolve(), allowConcurrentSnapshots: false,
  backend: 'pglite', hasVector: false,
  transaction: async () => { throw new Error('the fixture must not query SQL'); },
  run: async () => { throw new Error('the fixture must not query SQL'); },
  exec: async () => { throw new Error('the fixture must not query SQL'); }, close: async () => {},
};
class FixtureReader extends GraphReader {
  constructor(readonly entities: GraphEntity[], readonly facts: (RelationEdge & { relation: string })[] = []) { super(unusedOwner, () => '2026-01-01T00:00:00Z'); }
  override async find(key: string) { return this.entities.filter(entity => entity.key === key); }
  override async list(kind: string, options: { limit: number }) {
    const rows = this.entities.filter(entity => entity.kind === kind);
    return { rows: rows.slice(0, options.limit), total: rows.length, next: null };
  }
  override async byPrefix(kind: string, prefix: string, limit: number) {
    const rows = this.entities.filter(entity => entity.kind === kind && entity.key.startsWith(prefix));
    return { rows: rows.slice(0, limit), total: rows.length };
  }
  override async relationEdges(relation: string, limit = 2000) {
    const rows = this.facts.filter(edge => edge.relation === relation);
    return { rows: rows.slice(0, limit), total: rows.length };
  }
  override async neighbors(entity: GraphEntity, options: { direction?: 'out' | 'in' | 'both'; limit: number }) {
    return (['out', 'in'] as const).filter(direction => options.direction === undefined || options.direction === 'both' || direction === options.direction).map(direction => {
      const keys = new Set(this.facts.filter(edge => edge.relation === 'code.foreign-key' && (direction === 'out' ? edge.from.key : edge.to.key) === entity.key).map(edge => direction === 'out' ? edge.to.key : edge.from.key));
      const rows = this.entities.filter(other => keys.has(other.key));
      return { relation: 'code.foreign-key', direction, rows: rows.slice(0, options.limit).map(entity => ({ entity, edges: 1 })), total: rows.length, edges: rows.length };
    });
  }
}
function context(graph: GraphReader): RenderContext {
  return { graph, productFolder: '', manifest: { file: '', roles: new Map(), kinds: new Map(), groups: new Map(), excludeDocuments: [], findings: [] },
    markdown: new Map(), docEntities: new Map(), localizedSources: new Map(), language: 'en', documents: [], repositories: [],
    commitOf: () => null, repoOfScope: () => undefined, readSource: async () => undefined,
    resolver: new Resolver({ graph, markdown: new Map(), declared: () => false, readDocument: async () => undefined, repositories: () => [], locate: () => undefined }),
  };
}
const entity = (kind: string, name: string, path?: string): GraphEntity => ({ key: `${kind}:${name}`, kind, label: name, properties: {}, nodeIds: [], scope: 'repo',
  ...(path === undefined ? {} : { span: { path, lineStart: 1, lineEnd: 1, byteStart: 0, byteEnd: 1 } }),
});
const id = (index: number): string => String(index).padStart(2, '0');

test('database thirteen retains every table, column and native relationship outside its twelve-table overview', async () => {
  const database = entity('code.database', 'fixture');
  const tables = Array.from({ length: 13 }, (_, index) => entity('code.table', `fixture/public.table_${id(index)}`));
  const columns = tables.map(table => ({ ...entity('code.column', ''), key: `${table.key}/target_id`, label: 'target_id', properties: { type: 'uuid', primaryKey: true } }));
  const facts = tables.slice(1).map(from => ({ relation: 'code.foreign-key', from, to: tables[0]!, discriminator: from.key, properties: { column: 'target_id' } }));
  const [view] = await buildViews({ ctx: context(new FixtureReader([database, ...tables, ...columns], facts)), lang: 'en', productTitle: 'Fixture' }, { type: 'er', subject: database.key });
  expect(view!.elements).toHaveLength(12);
  expect(view!.marker).toBe('Showing 12 of 13.');
  expect(view!.fullElements!.map(element => element.id)).toEqual(tables.map(table => table.key));
  expect(view!.fullElements![12]!.columns).toEqual([{ name: 'target_id', type: 'uuid', key: true, fk: true }]);
  expect(view!.fullEdges!.map(edge => [edge.from, edge.to, edge.label, edge.discriminator])).toEqual(facts.map(edge => [edge.from.key, edge.to.key, 'target_id', edge.discriminator]));
  expect(view!.edges).toHaveLength(11);
});

for (const shape of ['distinct', 'single', 'scoped'] as const) test(`container ${shape} bounds every projection and retains all raw service facts`, async () => {
  const services = Array.from({ length: 41 }, (_, index) => entity('code.service', `api_${id(index)}`, shape === 'distinct' ? `services/${id(index)}/main.ts` : 'services/shared/main.ts'));
  const ctx = context(new FixtureReader(services));
  const [view] = await buildViews({ ctx, lang: 'en', productTitle: 'Fixture' }, { type: 'c4-container', subject: '', ...(shape === 'scoped' ? { scope: 'services/shared' } : {}) });
  expect(view!.elements).toHaveLength(40);
  expect(view!.fullElements!.map(element => element.id)).toEqual(services.map(service => service.key));
  expect(view!.marker).toContain('Showing 40 of 41.');
  expect(view!.fullEdges).toEqual([]);
});

for (const shape of ['distinct', 'single', 'scoped', 'folded'] as const) test(`component ${shape} preserves all dependencies including internal cycles`, async () => {
  const service = entity('code.service', 'api', 'services/api/main.ts');
  const modules = Array.from({ length: 42 }, (_, index) => entity('code.module', `services/api/${shape === 'distinct' ? `group_${id(index)}` : shape === 'folded' && index >= 21 ? 'z' : 'a'}/module_${id(index)}`));
  const cycle = entity('code.cycle', 'cycle');
  const dependencies = modules.slice(1).map((to, index) => ({ relation: 'code.depends-on', from: modules[index]!, to, properties: {} }));
  const cycles = modules.slice(0, 2).map(to => ({ relation: 'code.cycle-member', from: cycle, to, properties: {} }));
  const [view] = await buildViews({ ctx: context(new FixtureReader([service, ...modules, cycle], [...dependencies, ...cycles])), lang: 'en', productTitle: 'Fixture' }, { type: 'c4-component', subject: service.key, ...(shape === 'scoped' ? { scope: 'a' } : {}) });
  expect(view!.elements).toHaveLength(shape === 'folded' ? 2 : 40);
  expect(view!.fullElements!.map(element => element.id)).toEqual(modules.map(module => module.key));
  expect(view!.fullEdges!.map(edge => [edge.from, edge.to, edge.label])).toEqual(dependencies.map((edge, index) => [edge.from.key, edge.to.key, index === 0 ? 'cycle' : 'depends on']));
  expect(view!.fullElements!.slice(0, 2).every(element => element.detail?.includes('cycle'))).toBe(true);
  if (shape !== 'folded') expect(view!.marker).toContain('Showing 40 of 42.');
});

test('folded containers retain late unique cross-folder labels and all internal raw relationships', async () => {
  const services = Array.from({ length: 42 }, (_, index) => entity('code.service', `api_${id(index)}`, `services/${index < 21 ? 'a' : 'z'}/${id(index)}/main.ts`));
  // Each service is declared in one of two real source folders, with unique keys within the folder.
  for (const [index, service] of services.entries()) service.span!.path = `services/${index < 21 ? 'a' : 'z'}/main.ts`;
  const targets = services.slice(21).map((service, index) => ({ ...entity('code.route', `services/z/route_${id(index)}.ts#GET:/target_${id(index)}`), label: `unique-remote-target-${id(index)}` }));
  const facts = targets.map((to, index) => ({ relation: 'code.calls-remote', from: entity('code.symbol', `services/a/caller_${id(index)}.ts#call`), to, properties: { via: index === 20 ? 'grpc' : 'http' } }));
  const internal = { relation: 'code.calls-remote', from: entity('code.symbol', 'services/a/internal.ts#call'), to: entity('code.route', 'services/a/internal.ts#GET:/internal'), properties: { via: 'http' } };
  const [view] = await buildViews({ ctx: context(new FixtureReader([...services, ...targets], [...facts, internal])), lang: 'en', productTitle: 'Fixture' }, { type: 'c4-container', subject: '' });
  expect(view!.elements).toHaveLength(2);
  expect(view!.fullElements!.map(element => element.id)).toEqual(services.map(service => service.key));
  expect(view!.fullEdges!.map(edge => edge.label)).toContain('gRPC unique-remote-target-20');
  expect(view!.fullEdges!.some(edge => edge.label.includes('unique-remote-target-19'))).toBe(true);
  expect(view!.fullEdges!.some(edge => edge.from === edge.to)).toBe(false);
  expect(view!.fullEdges!.some(edge => edge.from === services[0]!.key && edge.to === services[21]!.key && edge.label === 'gRPC unique-remote-target-20')).toBe(true);
});
