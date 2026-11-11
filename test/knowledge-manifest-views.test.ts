/**
 * The views, the listing and the places a kind gets follow the kinds manifest, not kind names in the engine (decision
 * 0033, the owner's rule that the engine holds no product data). A kind whose declaration says `views: [c4-component]`
 * draws its modules; one whose declaration says `listing: operations` lists its entities as the operations table; one
 * whose declaration says `nav: own-page` stands at a place of its own. Removing the line from the manifest takes the
 * view, the listing or the place away, and restoring it brings it back.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import type { RenderContext, Subject } from '../src/knowledge/blocks.js';
import { collectNeighbors, treemapBlock } from '../src/knowledge/diagrams.js';
import { definitionBlock } from '../src/knowledge/definition.js';
import { GraphReader, type FileFactRow, type GraphEntity, type NeighborGroup } from '../src/knowledge/graph-read.js';
import { byCodePoint } from '../src/model/order.js';
import { readKinds, type KindsManifest } from '../src/knowledge/kinds.js';
import { kindSummaries, listEntities } from '../src/knowledge/render.js';
import { Resolver } from '../src/knowledge/resolve.js';
import { starterKinds } from './knowledge-fixture.js';
import { buildViews, diagramsBlock, type GraphView } from '../src/knowledge/views.js';

const work = mkdtempSync(join(tmpdir(), 'madarch-manifest-views-'));
afterAll(() => { rmSync(work, { recursive: true, force: true }); });

/** The kinds the fixture product declares, each with a template file of its own. */
const KINDS = ['code.service', 'code.file', 'code.module', 'code.database', 'code.table', 'code.column', 'code.route', 'code.contract', 'code.operation'] as const;
type FixtureKind = (typeof KINDS)[number];

/** The fixture's declarations: each kind's own lines, the template and the graph as the source every page shares. */
function manifestLines(extra: Partial<Record<FixtureKind, readonly string[]>> = {}): string[] {
  const lines = ['kinds:'];
  for (const kind of KINDS) lines.push(`  ${kind}:`, `    template: templates/${kind}.liquid`, '    source: graph', ...(extra[kind] ?? []));
  return lines;
}

/** Writes the fixture manifest into a product folder of its own and reads it the way the wiki does. */
function readFixture(name: string, extra: Partial<Record<FixtureKind, readonly string[]>> = {}): { manifest: KindsManifest; folder: string } {
  const folder = join(work, name);
  mkdirSync(join(folder, 'madarch'), { recursive: true });
  mkdirSync(join(folder, 'templates'), { recursive: true });
  for (const kind of KINDS) writeFileSync(join(folder, 'templates', `${kind}.liquid`), '{% layout "./entity.liquid" %}\n');
  writeFileSync(join(folder, 'madarch', 'kinds.yaml'), `${manifestLines(extra).join('\n')}\n`);
  const read = readKinds(folder);
  if (!read.present) throw new Error(`the fixture manifest of ${folder} was not read`);
  if (read.manifest.findings.length > 0) throw new Error(`the fixture manifest of ${folder} has findings: ${read.manifest.findings.map((one) => `${one.file}:${one.line}: ${one.message}`).join('; ')}`);
  return { manifest: read.manifest, folder };
}

const span = (path: string) => ({ path, lineStart: 1, lineEnd: 10, byteStart: 0, byteEnd: 10 });
const entity = (kind: string, name: string, properties: Record<string, unknown> = {}, path?: string): GraphEntity =>
  ({ key: `${kind}:${name}`, kind, label: name, properties, nodeIds: [], scope: 'repo', ...(path === undefined ? {} : { span: span(path) }) });

const SERVICE = entity('code.service', 'payments', { language: 'TypeScript' }, 'services/payments/main.ts');
const FILE = entity('code.file', 'services/payments/main.ts', { path: 'services/payments/main.ts' }, 'services/payments/main.ts');
const MODULE = entity('code.module', 'services/payments', { files: 2 });
const DATABASE = entity('code.database', 'shop');
const ORDERS = entity('code.table', 'shop/orders', { path: 'db/schema.sql' }, 'db/schema.sql');
const USERS = entity('code.table', 'shop/users');
const COLUMN: GraphEntity = { ...entity('code.column', 'user_id', { type: 'uuid', primaryKey: true }), key: 'code.table:shop/orders/user_id' };
const ROUTE = entity('code.route', 'api.ts#GET:/items', { method: 'GET', path: '/items', middleware: [] }, 'api.ts');
const CONTRACT = entity('code.contract', 'contracts/api.yaml', { path: 'contracts/api.yaml', format: 'openapi' }, 'contracts/api.yaml');
const OPERATION = entity('code.operation', 'contracts/api.yaml#GET:/items', { method: 'GET', path: '/items' }, 'contracts/api.yaml');
const ENTITIES = [SERVICE, FILE, MODULE, DATABASE, ORDERS, USERS, COLUMN, ROUTE, CONTRACT, OPERATION];

/** A fact of the fixture graph: an edge between two of its entities, of the relation the extractors file it under. */
interface FixtureEdge { relation: string; from: GraphEntity; to: GraphEntity; discriminator?: string; properties: Record<string, unknown> }

const FACTS: FixtureEdge[] = [
  { relation: 'code.foreign-key', from: ORDERS, to: USERS, discriminator: 'orders.user_id', properties: { column: 'user_id' } },
  { relation: 'code.declares', from: CONTRACT, to: OPERATION, discriminator: '', properties: {} },
  { relation: 'code.reads-table', from: FILE, to: ORDERS, discriminator: '', properties: {} },
];

/** Whether an entity a listing asks for matches the text filter and stands after the cursor, as the graph read answers it. */
function matches(one: GraphEntity, options: { q?: string; after?: string }): boolean {
  const text = options.q?.trim().toLowerCase() ?? '';
  if (text !== '' && !one.key.toLowerCase().includes(text) && !one.label.toLowerCase().includes(text)) return false;
  return options.after === undefined || byCodePoint(one.key, options.after) > 0;
}

const unusedOwner: DatabaseOwner = {
  location: 'unused view fixture', ready: Promise.resolve(), allowConcurrentSnapshots: false,
  hasVector: false,
  transaction: async () => { throw new Error('the fixture must not query SQL'); },
  run: async () => { throw new Error('the fixture must not query SQL'); },
  exec: async () => { throw new Error('the fixture must not query SQL'); }, close: async () => {},
};

/** Only the graph-read boundary is doubled; every projection comes from the real view builders. */
class FixtureReader extends GraphReader {
  constructor(readonly entities: GraphEntity[], readonly facts: FixtureEdge[] = FACTS) { super(unusedOwner, () => '2026-01-01T00:00:00Z'); }
  override async find(key: string) { return this.entities.filter((one) => one.key === key); }
  override async kindCounts() { return [...new Set(this.entities.map((one) => one.kind))].map((kind) => ({ kind, count: this.entities.filter((one) => one.kind === kind).length })); }
  override async list(kind: string, options: { q?: string; after?: string; limit: number }) {
    const matching = this.entities.filter((one) => one.kind === kind && matches(one, options));
    return this.page(matching, options.limit);
  }
  /** The page of rows a listing read answers, as the graph read pages them: by key after the cursor. */
  private page(rows: GraphEntity[], limit: number): { rows: GraphEntity[]; total: number; next: string | null } {
    const page = rows.slice(0, limit);
    return { rows: page, total: rows.length, next: page.length < rows.length ? page[page.length - 1]!.key : null };
  }
  override async listOperations(options: { q?: string; after?: string; limit: number }) {
    return this.page(this.entities.filter((one) => (one.kind === 'code.operation' || one.kind === 'code.channel') && matches(one, options)), options.limit);
  }
  override async byPrefix(kind: string, prefix: string, limit: number) {
    const rows = this.entities.filter((one) => one.kind === kind && one.key.startsWith(prefix));
    return { rows: rows.slice(0, limit), total: rows.length };
  }
  override async fileFacts(prefix: string, limit: number): Promise<{ total: number; rows: readonly FileFactRow[] }> {
    const rows = this.entities.filter((one) => one.kind === 'code.file' && one.key.startsWith(`code.file:${prefix}`)).sort((a, b) => byCodePoint(a.key, b.key));
    return {
      total: rows.length,
      rows: rows.slice(0, limit).map((one) => ({
        key: one.key, node: one.nodeIds[0] ?? '', path: String(one.properties['path'] ?? ''), repository: 'repo', scope: one.scope,
        lines: typeof one.properties['lines'] === 'number' ? one.properties['lines'] : null,
      })),
    };
  }
  override async relationEdges(relation: string, limit = 2000) {
    const rows = this.facts.filter((edge) => edge.relation === relation);
    return { rows: rows.slice(0, limit), total: rows.length };
  }
  override async neighbors(entity: GraphEntity, options: { relations?: readonly string[]; direction?: 'out' | 'in' | 'both'; limit: number }) {
    const relations = options.relations ?? [...new Set(this.facts.map((edge) => edge.relation))];
    const directions = (['out', 'in'] as const).filter((direction) => options.direction === undefined || options.direction === 'both' || direction === options.direction);
    const groups: NeighborGroup[] = [];
    for (const direction of directions) for (const relation of relations) {
      const rows = this.facts.filter((edge) => edge.relation === relation && (direction === 'out' ? edge.from.key : edge.to.key) === entity.key)
        .map((edge) => ({ entity: direction === 'out' ? edge.to : edge.from, edges: 1 }));
      if (rows.length > 0) groups.push({ relation, direction, rows: rows.slice(0, options.limit), total: rows.length, edges: rows.length });
    }
    return groups;
  }
  override async inDegrees(relation: string, keys: readonly string[]) {
    const counts = new Map<string, number>();
    for (const edge of this.facts.filter((one) => one.relation === relation)) if (keys.includes(edge.to.key)) counts.set(edge.to.key, (counts.get(edge.to.key) ?? 0) + 1);
    return counts;
  }
  override async inDegreesOf(relation: string, entities: readonly GraphEntity[]) {
    return await this.inDegrees(relation, entities.map((entity) => entity.key));
  }
  override async inDegreesOfNodes(relation: string, nodes: readonly { readonly id: string; readonly key: string }[]) {
    return await this.inDegrees(relation, nodes.map((one) => one.key));
  }
  override async edgesOf(entity: GraphEntity, relation: string, direction: 'out' | 'in', limit: number) {
    const rows = this.facts.filter((edge) => edge.relation === relation && (direction === 'out' ? edge.from.key : edge.to.key) === entity.key)
      .map((edge) => ({ relation, direction, other: direction === 'out' ? edge.to : edge.from, properties: edge.properties, position: null }));
    return { rows: rows.slice(0, limit), total: rows.length };
  }
}

/** The context a page is drawn in: the fixture manifest and the doubled graph, with the contract's bytes to read. */
function context(manifest: KindsManifest, folder: string, entities: readonly GraphEntity[] = ENTITIES): RenderContext {
  const graph = new FixtureReader([...entities]);
  return {
    productFolder: folder, manifest, language: 'en', markdown: new Map(), docEntities: new Map(), localizedSources: new Map(),
    documents: [], repositories: [], commitOf: () => null, repoOfScope: () => 'repo', graph,
    readSource: async (_repo: string | null, path: string) => (path === 'contracts/api.yaml'
      ? 'openapi: 3.0.3\ninfo: {title: Catalogue, version: 1.0.0}\npaths:\n  /items: {get: {operationId: listItems, responses: {}}}\n'
      : path === 'services/payments/main.ts' ? 'export const pay = (): void => {};\n' : undefined),
    resolver: new Resolver({ graph, markdown: new Map(), declared: () => false, readDocument: async () => undefined, repositories: () => [], locate: () => undefined }),
  } as unknown as RenderContext;
}

/** The one view a specification asks for, or the refusal's sentence; `subject` is the page the view is drawn on. */
async function viewOrRefusal(manifest: KindsManifest, folder: string, spec: { type: string; subject: string }, subject?: Subject, entities?: readonly GraphEntity[]): Promise<GraphView | string> {
  try {
    const views = await buildViews({ ctx: context(manifest, folder, entities), lang: 'en', productTitle: 'Fixture' }, spec as never, subject);
    return views[0]!;
  } catch (error) {
    return (error as Error).message;
  }
}

describe('a view follows the kind declaration', () => {
  test('removing views: [c4-component] takes the component view away, and restoring it brings the view back', async () => {
    for (const [name, lines, drawn] of [
      ['component-without', [], false],
      ['component-with', ['    views: [c4-component]'], true],
      ['component-restored', ['    views: [c4-component]'], true],
    ] as const) {
      const { manifest, folder } = readFixture(name, { 'code.service': lines });
      const answer = await viewOrRefusal(manifest, folder, { type: 'c4-component', subject: SERVICE.key });
      if (drawn) {
        if (typeof answer === 'string') throw new Error(answer);
        expect(answer.elements.map((element) => element.id)).toEqual([MODULE.key]);
      } else {
        expect(answer).toContain('gives the kind code.service no "views: [c4-component]"');
        expect(answer).toContain(`${join(folder, 'madarch', 'kinds.yaml')}:2 `);
      }
    }
  });

  test('a refusal names the manifest\'s file and the kind\'s line, and a declaration with no line is named by its file alone', async () => {
    const { manifest, folder } = readFixture('refusal-named');
    const answer = await viewOrRefusal(manifest, folder, { type: 'c4-component', subject: SERVICE.key });
    expect(answer).toContain(`${join(folder, 'madarch', 'kinds.yaml')}:2 gives the kind code.service no "views: [c4-component]"`);
    // A fixture may hand in a declaration without the line the reader always sets: the sentence names the file, and
    // never says ":undefined".
    const unlined = { ...manifest, kinds: new Map([...manifest.kinds].map(([name, decl]) => [name, { ...decl, line: undefined }])) } as unknown as KindsManifest;
    const unnamed = await viewOrRefusal(unlined, folder, { type: 'c4-component', subject: SERVICE.key });
    expect(unnamed).toBe(`a component view is the modules of a container of this product: the manifest ${join(folder, 'madarch', 'kinds.yaml')} gives the kind code.service no "views: [c4-component]"`);
  });

  test('an entity whose kind the manifest does not declare at all is refused by name, never by a kind the engine knew', async () => {
    const { manifest, folder } = readFixture('component-undeclared');
    const answer = await viewOrRefusal(manifest, folder, { type: 'c4-component', subject: 'code.workflow:nightly' });
    expect(answer).toContain('"code.workflow:nightly" is no entity of the graph');
  });

  test('removing er: tables takes the tables of a database away, and restoring it brings them back', async () => {
    const drawn = readFixture('er-with', { 'code.database': ['    er: tables'], 'code.table': ['    er: links'] });
    const answer = await viewOrRefusal(drawn.manifest, drawn.folder, { type: 'er', subject: DATABASE.key });
    if (typeof answer === 'string') throw new Error(answer);
    expect(answer.elements.map((element) => element.id)).toEqual([ORDERS.key, USERS.key]);
    expect(answer.elements[0]!.columns).toEqual([{ name: 'user_id', type: 'uuid', key: true, fk: true }]);
    expect(answer.edges.map((edge) => [edge.from, edge.to, edge.label])).toEqual([[ORDERS.key, USERS.key, 'user_id']]);

    const refused = readFixture('er-without');
    const nothing = await viewOrRefusal(refused.manifest, refused.folder, { type: 'er', subject: DATABASE.key });
    expect(nothing).toContain('gives the kind code.database no "er: tables" or "er: links"');

    const restored = readFixture('er-restored', { 'code.database': ['    er: tables'], 'code.table': ['    er: links'] });
    const again = await viewOrRefusal(restored.manifest, restored.folder, { type: 'er', subject: DATABASE.key });
    if (typeof again === 'string') throw new Error(again);
    expect(again.elements).toHaveLength(2);
  });

  test('a database the extractor found no tables for says so with the words and the block it always had', async () => {
    const { manifest, folder } = readFixture('er-empty', { 'code.database': ['    er: tables'], 'code.table': ['    er: links'] });
    const archive = entity('code.database', 'archive');
    const answer = await viewOrRefusal(manifest, folder, { type: 'er', subject: archive.key }, undefined, [...ENTITIES, archive]);
    if (typeof answer === 'string') throw new Error(answer);
    // The same view at 02d3b00e: no element, no edge, no marker, the ER block's own sentence, and the way up to the
    // containers — the block and the words, not only the emptiness.
    expect(answer).toEqual({
      spec: { type: 'er', subject: 'code.database:archive' },
      title: 'Tables: archive',
      label: 'Tables',
      elements: [],
      edges: [],
      notes: [],
      empty: 'The graph holds no table here.',
      up: { spec: { type: 'c4-container', subject: '' }, title: 'Containers' },
      marker: null,
    });
  });

  test('a table draws the tables it points to by foreign key under the same declaration, and no entity that holds tables is read as one', async () => {
    const { manifest, folder } = readFixture('er-table', { 'code.database': ['    er: tables'], 'code.table': ['    er: links'] });
    const answer = await viewOrRefusal(manifest, folder, { type: 'er', subject: ORDERS.key });
    if (typeof answer === 'string') throw new Error(answer);
    expect(answer.elements.map((element) => element.id)).toEqual([ORDERS.key, USERS.key]);
  });

  test('removing views: [state] takes the state view away, and restoring it brings it back', async () => {
    const withView = readFixture('state-with', { 'code.file': ['    views: [state]'] });
    const answer = await viewOrRefusal(withView.manifest, withView.folder, { type: 'state', subject: FILE.key });
    if (typeof answer === 'string') throw new Error(answer);
    // The fixture's bytes hold no transition table: the view says so instead of drawing nothing.
    expect(answer.empty).toBe('No transition table was found in the code of this page.');

    const withoutView = readFixture('state-without');
    const refused = await viewOrRefusal(withoutView.manifest, withoutView.folder, { type: 'state', subject: FILE.key });
    expect(refused).toContain('gives the kind code.file no "views: [state]"');
  });

  test('removing sequence: route takes the chain away, and restoring it brings the chain back', async () => {
    const withChain = readFixture('chain-with', { 'code.route': ['    sequence: route'] });
    const answer = await viewOrRefusal(withChain.manifest, withChain.folder, { type: 'sequence', subject: ROUTE.key }, { source: 'graph', entity: ROUTE });
    if (typeof answer === 'string') throw new Error(answer);
    expect(answer.empty).toBeNull();
    expect(answer.elements).toHaveLength(2);

    const withoutChain = readFixture('chain-without');
    const refused = await viewOrRefusal(withoutChain.manifest, withoutChain.folder, { type: 'sequence', subject: ROUTE.key }, { source: 'graph', entity: ROUTE });
    if (typeof refused === 'string') throw new Error(refused);
    expect(refused.empty).toBe('No route or function of the graph starts a chain here.');
  });
});

describe('the system view draws the kinds the manifest gives its parts', () => {
  test('removing system: container takes the container out of the system view, and restoring it brings the container back', async () => {
    const drawn = readFixture('system-with', { 'code.service': ['    system: container'] });
    const view = await viewOrRefusal(drawn.manifest, drawn.folder, { type: 'c4-container', subject: '' });
    if (typeof view === 'string') throw new Error(view);
    expect(view.elements.map((element) => element.id)).toEqual([SERVICE.key, 'code.database:shop']);

    const refused = readFixture('system-without');
    const none = await viewOrRefusal(refused.manifest, refused.folder, { type: 'c4-container', subject: '' });
    if (typeof none === 'string') throw new Error(none);
    expect(none.empty).toBe('The graph holds no service yet.');

    const restored = readFixture('system-restored', { 'code.service': ['    system: container'] });
    const again = await viewOrRefusal(restored.manifest, restored.folder, { type: 'c4-container', subject: '' });
    if (typeof again === 'string') throw new Error(again);
    expect(again.elements).toHaveLength(2);
  });

  test('the neighbourhood of a container carries the system view rows only under system: container', async () => {
    const subject: Subject = { source: 'graph', entity: SERVICE };
    const drawn = readFixture('rows-with', { 'code.service': ['    system: container'] });
    const rows = await collectNeighbors(context(drawn.manifest, drawn.folder), subject, { limit: 20 });
    expect(rows.rows.map((row) => row.relation)).toContain('uses-database');
    expect(rows.rows.find((row) => row.relation === 'uses-database')?.ref.id).toBe(DATABASE.key);

    const without = readFixture('rows-without');
    const none = await collectNeighbors(context(without.manifest, without.folder), subject, { limit: 20 });
    expect(none.rows.map((row) => row.relation)).not.toContain('uses-database');
  });

  test('a treemap covers the folder of a container only under system: container', async () => {
    const subject: Subject = { source: 'graph', entity: SERVICE };
    const drawn = readFixture('treemap-with', { 'code.service': ['    system: container'] });
    const block = await treemapBlock(context(drawn.manifest, drawn.folder), subject, {}, 'en');
    expect(block).toMatchObject({ type: 'treemap', scope: 'services/payments' });

    const without = readFixture('treemap-without');
    const whole = await treemapBlock(context(without.manifest, without.folder), subject, {}, 'en');
    expect(whole).toMatchObject({ type: 'treemap', scope: '' });
  });
});

describe('the definition block reads the kinds the manifest gives it', () => {
  const contract: Subject = { source: 'graph', entity: CONTRACT };
  test('removing definition-block: contract takes the definition away, and restoring it brings it back', async () => {
    const drawn = readFixture('definition-with', { 'code.contract': ['    definition-block: contract'], 'code.operation': ['    definition-block: operation'] });
    const block = await definitionBlock(context(drawn.manifest, drawn.folder), contract, {}, 'templates/contract.liquid', 3);
    expect(block.type).toBe('definition');
    if (block.type === 'definition') expect(block.members.map((member) => member.label)).toEqual(['GET /items']);

    const refused = readFixture('definition-without');
    const problem = await definitionBlock(context(refused.manifest, refused.folder), contract, {}, 'templates/contract.liquid', 3);
    expect(problem).toMatchObject({ type: 'problem', file: 'templates/contract.liquid', line: 3 });
    if (problem.type === 'problem') expect(problem.message).toContain(`${join(refused.folder, 'madarch', 'kinds.yaml')}:23 gives the kind code.contract no "definition-block: contract"`);

    const restored = readFixture('definition-restored', { 'code.contract': ['    definition-block: contract'], 'code.operation': ['    definition-block: operation'] });
    const again = await definitionBlock(context(restored.manifest, restored.folder), contract, {}, 'templates/contract.liquid', 3);
    expect(again.type).toBe('definition');
  });

  test('a contract member is a row only when its own kind declares definition-block', async () => {
    const member = readFixture('definition-member', { 'code.contract': ['    definition-block: contract'] });
    const block = await definitionBlock(context(member.manifest, member.folder), contract, {}, 'templates/contract.liquid', 3);
    expect(block.type).toBe('definition');
    if (block.type === 'definition') expect(block.members).toEqual([]);
  });
});

describe('a listing follows the kind declaration', () => {
  test('removing listing: operations takes the operations table away, and restoring it brings the table back', async () => {
    const operations = readFixture('listing-with', { 'code.operation': ['    listing: operations'] });
    const listed = await listEntities(context(operations.manifest, operations.folder), 'code.operation', { limit: 10 });
    expect(listed?.operations).toBeDefined();
    expect(Object.keys(listed?.operations ?? {})).toEqual([OPERATION.key]);

    const plain = readFixture('listing-without');
    const rows = await listEntities(context(plain.manifest, plain.folder), 'code.operation', { limit: 10 });
    expect(rows?.operations).toBeUndefined();
    expect(rows?.rows.map((row) => row.id)).toEqual([OPERATION.key]);
    // The text filter and the cursor reach the graph either way, and the operations form still answers them.
    const filtered = await listEntities(context(operations.manifest, operations.folder), 'code.operation', { limit: 10, q: 'items' });
    expect(filtered?.rows.map((row) => row.id)).toEqual([OPERATION.key]);
    const none = await listEntities(context(operations.manifest, operations.folder), 'code.operation', { limit: 10, q: 'nothing-matches' });
    expect(none?.rows).toEqual([]);
    const after = await listEntities(context(operations.manifest, operations.folder), 'code.operation', { limit: 1, after: OPERATION.key });
    expect(after?.rows).toEqual([]);
    expect(after?.next).toBeNull();
  });
});

describe('the navigation a kind gets travels in its summary', () => {
  test('nav names the kinds with a place of their own and the loop kinds, and no app screen names a kind', async () => {
    const { manifest, folder } = readFixture('nav', {
      'code.file': ['    nav: own-page'],
      'code.route': ['    nav: loop'],
    });
    const summaries = await kindSummaries(context(manifest, folder));
    const nav = summaries.filter((summary) => summary.nav !== undefined).map((summary) => `${summary.kind}: ${summary.nav}`);
    expect(nav).toEqual(['code.file: own-page', 'code.route: loop']);
    // The traits the app draws by travel with the kind, not as a kind of the app's own.
    expect(summaries.find((summary) => summary.kind === 'code.service')).toEqual(expect.objectContaining({ kind: 'code.service' }));
  });

  test('the starter set gives the same kinds the views, the chain, the parts, the definition, the listing and the places they had before', () => {
    const shown = starterKinds();
    const of = (pick: (kind: (typeof shown)[number]) => string | undefined) => shown.map(pick).filter((value) => value !== undefined);
    expect(of((kind) => (kind.views === undefined ? undefined : `${kind.name}: ${kind.views.join(', ')}`))).toEqual([
      'code.service: c4-component, state',
      'code.package: state',
      'code.module: state',
      'code.file: state',
      'code.symbol: state',
    ]);
    expect(of((kind) => (kind.er === undefined ? undefined : `${kind.name}: ${kind.er}`))).toEqual(['code.database: tables', 'code.table: links']);
    expect(of((kind) => (kind.sequence === undefined ? undefined : `${kind.name}: ${kind.sequence}`))).toEqual(['code.symbol: symbol', 'code.route: route']);
    expect(of((kind) => (kind.system === undefined ? undefined : `${kind.name}: ${kind.system}`))).toEqual(['code.service: container', 'code.channel: channel', 'code.database: data-store']);
    expect(of((kind) => (kind.definitionBlock === undefined ? undefined : `${kind.name}: ${kind.definitionBlock}`))).toEqual(['code.operation: operation', 'code.contract: contract', 'code.channel: channel']);
    expect(of((kind) => (kind.listing === undefined ? undefined : `${kind.name}: ${kind.listing}`))).toEqual(['doc.term: glossary', 'code.operation: operations']);
    expect(of((kind) => (kind.nav === undefined ? undefined : `${kind.name}: ${kind.nav}`))).toEqual(['question: loop', 'correction: loop', 'task: own-page', 'doc.term: own-page']);
  });
});

describe('the manifest reader refuses a trait it cannot read', () => {
  test('a view, a part, a definition, a listing and a place the engine does not know are findings at their lines', () => {
    const folder = join(work, 'broken-traits');
    mkdirSync(join(folder, 'madarch'), { recursive: true });
    mkdirSync(join(folder, 'templates'), { recursive: true });
    for (const kind of KINDS) writeFileSync(join(folder, 'templates', `${kind}.liquid`), '{% layout "./entity.liquid" %}\n');
    const lines = manifestLines({ 'code.service': ['    views: [c4-component, c4-context]', '    system: service'], 'code.route': ['    sequence: call'], 'code.contract': ['    definition-block: file'], 'code.operation': ['    listing: table'], 'code.file': ['    nav: sidebar'] });
    writeFileSync(join(folder, 'madarch', 'kinds.yaml'), `${lines.join('\n')}\n`);
    const read = readKinds(folder);
    if (!read.present) throw new Error(`the fixture manifest of ${folder} was not read`);
    const messages = read.manifest.findings.map((one) => `${one.file}:${one.line}: ${one.message}`);
    expect(messages).toEqual([
      `${join(folder, 'madarch', 'kinds.yaml')}:5: kind "code.service": "views" lists the views a page of the kind may draw of its entities: c4-component, state, got ["c4-component","c4-context"]`,
      `${join(folder, 'madarch', 'kinds.yaml')}:6: kind "code.service": "system" is one of container, data-store, channel, got "service"`,
      `${join(folder, 'madarch', 'kinds.yaml')}:10: kind "code.file": "nav" is one of own-page, loop, got "sidebar"`,
      `${join(folder, 'madarch', 'kinds.yaml')}:26: kind "code.route": "sequence" is one of route, symbol, got "call"`,
      `${join(folder, 'madarch', 'kinds.yaml')}:30: kind "code.contract": "definition-block" is one of contract, operation, channel, got "file"`,
      `${join(folder, 'madarch', 'kinds.yaml')}:34: kind "code.operation": "listing" is one of operations, glossary, got "table"`,
    ]);
  });
});

describe('the neighbourhood and the chain follow the declaration too', () => {
  test('a route\'s neighbourhood carries its handler under sequence: route, and no other kind gets that row', async () => {
    const handler = entity('code.symbol', 'api.ts#serve', { symbolKind: 'function', test: false }, 'api.ts');
    const facts: FixtureEdge[] = [{ relation: 'code.handled-by', from: ROUTE, to: handler, discriminator: '', properties: {} }];
    const neighbourly = (name: string, extra: Partial<Record<FixtureKind, readonly string[]>> = {}) => {
      const read = readFixture(name, extra);
      const graph = new FixtureReader([...ENTITIES, handler], facts);
      return {
        manifest: read.manifest,
        ask: async (subject: Subject) => (await collectNeighbors({
          productFolder: read.folder, manifest: read.manifest, language: 'en', markdown: new Map(), docEntities: new Map(), localizedSources: new Map(),
          documents: [], repositories: [], commitOf: () => null, repoOfScope: () => 'repo', graph,
          readSource: async () => undefined,
          resolver: new Resolver({ graph, markdown: new Map(), declared: () => false, readDocument: async () => undefined, repositories: () => [], locate: () => undefined }),
        } as unknown as RenderContext, subject, { limit: 20 })).rows.map((row) => row.relation),
      };
    };
    const drawn = neighbourly('handler-with', { 'code.route': ['    sequence: route'] });
    expect(await drawn.ask({ source: 'graph', entity: ROUTE })).toContain('handled-by');
    // A kind the manifest gives no chain draws no handler row, though the graph holds the edge.
    const without = neighbourly('handler-without');
    expect(await without.ask({ source: 'graph', entity: ROUTE })).not.toContain('handled-by');
  });

  test('a chain groups its lanes by the kind the manifest gives the part of a container', async () => {
    // The route stands in the container's folder: its lane is that container when the manifest gives the kind the part.
    const inside = entity('code.route', 'services/payments/api.ts#GET:/items', { method: 'GET', path: '/items', middleware: [] }, 'services/payments/api.ts');
    const lanes = async (name: string, extra: Partial<Record<FixtureKind, readonly string[]>> = {}) => {
      const read = readFixture(name, extra);
      const graph = new FixtureReader([...ENTITIES, inside]);
      const views = await buildViews({
        ctx: {
          productFolder: read.folder, manifest: read.manifest, language: 'en', markdown: new Map(), docEntities: new Map(), localizedSources: new Map(),
          documents: [], repositories: [], commitOf: () => null, repoOfScope: () => 'repo', graph, readSource: async () => undefined,
          resolver: new Resolver({ graph, markdown: new Map(), declared: () => false, readDocument: async () => undefined, repositories: () => [], locate: () => undefined }),
        } as unknown as RenderContext, lang: 'en', productTitle: 'Fixture',
      }, { type: 'sequence', subject: inside.key }, { source: 'graph', entity: inside });
      return views[0]!.elements.map((element) => element.label);
    };
    expect(await lanes('chain-lanes', { 'code.route': ['    sequence: route'], 'code.service': ['    system: container'] })).toEqual(['client', 'payments']);
    expect(await lanes('chain-lanes-plain', { 'code.route': ['    sequence: route'] })).toEqual(['client', 'repository']);
  });

  test('a system element the graph holds no entity for is named by the kind the manifest gives its part', async () => {
    const gone: FixtureEdge[] = [{ relation: 'code.reads-table', from: FILE, to: { key: 'code.table:archive/events', kind: 'code.table', label: 'events', properties: {}, nodeIds: [], scope: 'repo' }, discriminator: '', properties: {} }];
    const read = readFixture('system-fallback', { 'code.service': ['    system: container'], 'code.database': ['    system: data-store'] });
    const graph = new FixtureReader(ENTITIES, gone);
    const rows = await collectNeighbors({
      productFolder: read.folder, manifest: read.manifest, language: 'en', markdown: new Map(), docEntities: new Map(), localizedSources: new Map(),
      documents: [], repositories: [], commitOf: () => null, repoOfScope: () => 'repo', graph, readSource: async () => undefined,
      resolver: new Resolver({ graph, markdown: new Map(), declared: () => false, readDocument: async () => undefined, repositories: () => [], locate: () => undefined }),
    } as unknown as RenderContext, { source: 'graph', entity: SERVICE }, { limit: 20 });
    expect(rows.rows.find((row) => row.relation === 'uses-database')?.ref).toMatchObject({ id: 'code.database:archive', kind: 'code.database', href: null });
  });

  test('the manifest keeps exactly the fields a kind declares, and no key it does not', () => {
    const read = readFixture('declaration-shape', { 'code.service': ['    views: [c4-component]', '    system: container', '    sequence: route'] });
    const service = read.manifest.kinds.get('code.service')!;
    expect(service.views).toEqual(['c4-component']);
    expect(service.system).toBe('container');
    expect(service.sequence).toBe('route');
    const bare = read.manifest.kinds.get('code.file')!;
    expect(Object.keys(bare).sort()).toEqual(['line', 'name', 'relations', 'source', 'template', 'title']);
  });
});

describe('the blocks and the domain map follow the declarations too', () => {
  test('the modules block draws the components and the state machines a kind declares, and nothing else', async () => {
    const blocks = async (name: string, extra: Partial<Record<FixtureKind, readonly string[]>> = {}) => {
      const read = readFixture(name, extra);
      const ctx = context(read.manifest, read.folder);
      return diagramsBlock({ ctx, lang: 'en', productTitle: 'Fixture' }, { source: 'graph', entity: SERVICE }, 'modules', {}, { product: undefined, env: {} }, { file: 'templates/service.liquid', line: 2 });
    };
    const both = await blocks('modules-with', { 'code.service': ['    views: [c4-component, state]'] });
    if (both.type !== 'diagrams') throw new Error(`no diagrams block: ${both.type}`);
    // The fixture's service has no transition table in its bytes, so its state view draws nothing: the components are
    // what the block holds, and a kind without them draws none.
    expect(both.views.map((view) => view.spec.type)).toEqual(['c4-component']);
    const stateOnly = await blocks('modules-state-only', { 'code.service': ['    views: [state]'] });
    if (stateOnly.type !== 'diagrams') throw new Error(`no diagrams block: ${stateOnly.type}`);
    expect(stateOnly.views).toEqual([]);
    const neither = await blocks('modules-without');
    if (neither.type !== 'diagrams') throw new Error(`no diagrams block: ${neither.type}`);
    expect(neither.views).toEqual([]);
    // A Markdown page has no graph entity to draw: the block says so rather than drawing nothing.
    const read = readFixture('modules-markdown');
    const page = { source: 'markdown' as const, entity: { kind: 'domain', id: 'domain:payment', title: 'Payment', relates: [], file: 'docs/domains/payment.md' } } as unknown as Subject;
    const refused = await diagramsBlock({ ctx: context(read.manifest, read.folder), lang: 'en', productTitle: 'Fixture' }, page, 'modules', {}, { product: undefined, env: {} }, { file: 'templates/domain.liquid', line: 2 });
    expect(refused).toMatchObject({ type: 'problem', block: 'modules', file: 'templates/domain.liquid', line: 2 });
  });

  test('a domain names the containers its pages relate, and a kind without the part is no implementation', async () => {
    const PAGE = {
      id: 'domain:payment', kind: 'domain', title: 'Payment', relates: [SERVICE.key], producer: 'agent' as const, sources: [], bodyLine: 1,
      file: 'docs/domains/payment.md', front: {}, body: '',
    };
    const maps = async (name: string, extra: Partial<Record<FixtureKind, readonly string[]>> = {}) => {
      const read = readFixture(name, extra);
      const ctx = { ...context(read.manifest, read.folder), markdown: new Map([[PAGE.id, PAGE]]) } as unknown as RenderContext;
      const views = await buildViews({ ctx, lang: 'en', productTitle: 'Fixture' }, { type: 'domain-map', subject: 'domain' });
      return views[0]!;
    };
    const drawn = await maps('domain-with', { 'code.service': ['    system: container'] });
    expect(drawn.elements.map((element) => element.id)).toContain(`${PAGE.id}|${SERVICE.key}`);
    const none = await maps('domain-without');
    expect(none.elements).toEqual([]);
    expect(none.empty).toBe('No page relates to a service of the graph, so there is no map of domains to draw.');
  });
});

describe('the manifest reader refuses a views list it cannot read', () => {
  const messagesOf = (name: string, lines: readonly string[]): string[] => {
    const folder = join(work, `broken-views-${name}`);
    mkdirSync(join(folder, 'madarch'), { recursive: true });
    mkdirSync(join(folder, 'templates'), { recursive: true });
    for (const kind of KINDS) writeFileSync(join(folder, 'templates', `${kind}.liquid`), '{% layout "./entity.liquid" %}\n');
    writeFileSync(join(folder, 'madarch', 'kinds.yaml'), `${manifestLines({ 'code.service': lines }).join('\n')}\n`);
    const read = readKinds(folder);
    if (!read.present) throw new Error(`the fixture manifest of ${folder} was not read`);
    return read.manifest.findings.map((one) => `${one.file}:${one.line}: ${one.message}`);
  };

  test('a view named twice, an empty list and a value that is no list are findings at the field\'s line', () => {
    expect(messagesOf('twice', ['    views: [state, state]'])).toEqual([
      `${join(work, 'broken-views-twice', 'madarch', 'kinds.yaml')}:5: kind "code.service": "views" names each view once, and ["state","state"] names one twice`,
    ]);
    expect(messagesOf('empty', ['    views: []'])).toEqual([
      `${join(work, 'broken-views-empty', 'madarch', 'kinds.yaml')}:5: kind "code.service": "views" lists the views a page of the kind may draw of its entities: c4-component, state, got []`,
    ]);
    expect(messagesOf('scalar', ['    views: er'])).toEqual([
      `${join(work, 'broken-views-scalar', 'madarch', 'kinds.yaml')}:5: kind "code.service": "views" lists the views a page of the kind may draw of its entities: c4-component, state, got "er"`,
    ]);
  });
});
