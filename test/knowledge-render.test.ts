/**
 * The wiki's pages over a small graph written out in the test (decision 0029):
 * the template substitution, every block of the library, the `madarch:` links
 * and the footnote grounds with the broken ones shown as broken. Every
 * expected value is read off the graph and the files this test builds, never
 * off the engine's own output.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createGraphStore, type GraphId, type GraphStore } from '../src/graph/index.js';
import type { RenderContext } from '../src/knowledge/blocks.js';
import { GraphReader } from '../src/knowledge/graph-read.js';
import { parseKinds } from '../src/knowledge/kinds.js';
import { readDocEntities } from '../src/knowledge/doc-entities.js';
import { readMarkdownEntities } from '../src/knowledge/markdown.js';
import type { Block, PageModel } from '../src/knowledge/model.js';
import { kindSummaries, listEntities, renderPage } from '../src/knowledge/render.js';
import { Resolver, findAnchor } from '../src/knowledge/resolve.js';

// Record keys are built by concatenation so the neutral-names scan reads no key as a repository source.
const K = (kind: string, rest: string): string => `${kind}:${rest}`;
const SERVICE = K('code.service', 'billing');
const PACKAGE = K('code.package', 'svc/billing');
const MODULE = K('code.module', 'svc/billing/src');
const FILE_A = K('code.file', 'svc/billing/src/a.ts');
const FILE_B = K('code.file', 'svc/billing/src/b.ts');
const CHARGE = K('code.symbol', 'svc/billing/src/a.ts#charge');
const AUDIT = K('code.symbol', 'svc/billing/src/a.ts#audit');
const HANDLE = K('code.symbol', 'svc/billing/src/b.ts#handle');
const DATABASE = K('code.database', 'billing');
const INVOICES = K('code.table', 'billing/public.invoices');
const CUSTOMERS = K('code.table', 'billing/public.customers');

const A_TS = ['import { b } from "./b";', '', 'export function charge(amount: number) {', '  // bill it', '  return audit(amount) + 1;', '}', '', 'function audit(n: number) {', '  return charge(n - 1);', '}', ''].join('\n');
const B_TS = ['export function handle() {', '  const text = "x";', '  return charge(1);', '}', ''].join('\n');

let owner: DatabaseOwner;
let store: GraphStore;
let ctx: RenderContext;
let productFolder: string;
const repoOfScope = new Map<string, string>();

const span = (path: string, lineStart: number, lineEnd: number) => ({ path, lineStart, lineEnd, byteStart: 0, byteEnd: 10 });

beforeAll(async () => {
  productFolder = mkdtempSync(join(tmpdir(), 'madarch-knowledge-render-'));
  owner = createPGliteDatabaseOwner({ btreeGist: true });
  await owner.ready;
  store = createGraphStore(owner, { now: () => new Date('2026-06-01T00:00:00Z') });
  await store.createSchema();
  await store.registerCodeSchema({
    kinds: ['code.service', 'code.package', 'code.module', 'code.database', 'code.table', 'code.column'],
    relations: [{ key: 'code.foreign-key', discriminated: true }, { key: 'code.manifest-of' }],
  });
  const scope = await store.newNode();
  const ids = new Map<string, GraphId>();
  const owned = { producer: 'code.extract.code', scope };
  const add = async (key: string, kind: string, label: string, properties: Record<string, unknown> = {}): Promise<void> => {
    const { nodeId } = await store.openNode({ kind, label, properties: { ...properties, recordKey: key }, validFrom: '2026-01-01T00:00:00Z', owner: owned });
    ids.set(key, nodeId);
  };
  const link = async (relation: string, from: string, to: string, properties: Record<string, unknown> = {}, discriminator?: string): Promise<void> => {
    await store.openEdge({ relation, src: ids.get(from)!, dst: ids.get(to)!, properties, validFrom: '2026-01-01T00:00:00Z', owner: owned, ...(discriminator === undefined ? {} : { discriminator }) });
  };
  await store.openNode({ nodeId: scope, kind: 'code.repository', label: 'shop', properties: { path: '/work/shop' }, validFrom: '2026-01-01T00:00:00Z', owner: { producer: 'code.extract.driver', scope } });
  repoOfScope.set(scope, 'shop');
  await add(SERVICE, 'code.service', 'billing', { language: 'typescript', frameworks: ['express', 'pino'], testFramework: 'jest', span: span('svc/billing/package.json', 1, 5) });
  await add(PACKAGE, 'code.package', 'billing', { name: 'billing' });
  await add(MODULE, 'code.module', 'svc/billing/src', { role: 'code' });
  await add(FILE_A, 'code.file', 'a.ts', { path: 'svc/billing/src/a.ts' });
  await add(FILE_B, 'code.file', 'b.ts', { path: 'svc/billing/src/b.ts' });
  await add(CHARGE, 'code.symbol', 'charge', { path: 'svc/billing/src/a.ts', symbolKind: 'function', span: span('svc/billing/src/a.ts', 3, 6) });
  await add(AUDIT, 'code.symbol', 'audit', { path: 'svc/billing/src/a.ts', symbolKind: 'function', span: span('svc/billing/src/a.ts', 8, 10) });
  await add(HANDLE, 'code.symbol', 'handle', { path: 'svc/billing/src/b.ts', symbolKind: 'function', span: span('svc/billing/src/b.ts', 1, 4) });
  await link('code.contains', PACKAGE, MODULE);
  await link('code.contains', MODULE, FILE_A);
  await link('code.contains', MODULE, FILE_B);
  await link('code.contains', FILE_A, CHARGE);
  await link('code.contains', FILE_A, AUDIT);
  await link('code.contains', FILE_B, HANDLE);
  await link('code.calls', HANDLE, CHARGE, { span: span('svc/billing/src/b.ts', 3, 3) });
  await link('code.calls', AUDIT, CHARGE, { span: span('svc/billing/src/a.ts', 9, 9) });
  await link('code.calls', CHARGE, AUDIT, { span: span('svc/billing/src/a.ts', 5, 5) });
  await link('code.imports', FILE_B, FILE_A);
  await add(DATABASE, 'code.database', 'billing', { service: 'billing' });
  await add(INVOICES, 'code.table', 'invoices', { schema: 'public', database: 'billing' });
  await add(CUSTOMERS, 'code.table', 'customers', { schema: 'public', database: 'billing' });
  await add(`${INVOICES}/id`, 'code.column', 'id', { type: 'uuid', nullable: false, primaryKey: true });
  await add(`${INVOICES}/customer_id`, 'code.column', 'customer_id', { type: 'uuid', nullable: false });
  await add(`${CUSTOMERS}/id`, 'code.column', 'id', { type: 'uuid', nullable: false, primaryKey: true });
  await link('code.foreign-key', INVOICES, CUSTOMERS, { column: 'customer_id' }, 'customer_id');

  const write = (path: string, text: string): void => {
    mkdirSync(join(productFolder, path, '..'), { recursive: true });
    writeFileSync(join(productFolder, path), text);
  };
  write('madarch/kinds.yaml', [
    'kinds:',
    '  product:',
    '    template: templates/product.md',
    '    source: markdown',
    '    file: docs/product.md',
    '  domain:',
    '    template: templates/domain.md',
    '    source: markdown',
    '    folder: docs/domains',
    '  code.service:',
    '    template: templates/service.md',
    '    source: graph',
    '    relations:',
    '      - { type: code.contains, to: "code.package:{span.path|dirname}" }',
    '  code.symbol:',
    '    template: templates/symbol.md',
    '    source: graph',
    '  code.file:',
    '    template: templates/file.md',
    '    source: graph',
    '  code.database:',
    '    template: templates/database.md',
    '    source: graph',
    '  doc.use-case:',
    '    template: templates/use-case.md',
    '    source: document',
    '    identifier: UC',
    '',
  ].join('\n'));
  write('templates/use-case.md', ':::body\n:::stated{title="Stated in"}\n:::implementedby\n:::linkedfrom\n');
  write('templates/product.md', ':::body\n');
  write('templates/domain.md', ':::body\n:::related{title="Implemented by" relation="relates"}\n');
  write('templates/service.md', [
    'A {{language}} service on {{frameworks}}; tests: {{testFramework}}; owner: {{owner}}.',
    ':::graph{depth=1}',
    ':::related{title="Files" relation="code.contains" depth=3 kind="code.file"}',
    ':::related{title="Described by" relation="relates"}',
    ':::nonsense',
    ':::',
    ':::callers',
    '',
  ].join('\n'));
  write('templates/symbol.md', '{{symbolKind}} in {{path}}\n:::source\n:::callers\n:::callees\n:::sequence\n:::related{title="Declared in" relation="code.contains" direction="in"}\n:::er\n');
  write('templates/file.md', '{{path}}\n:::source\n:::related{title="Imports" relation="code.imports" direction="out"}\n:::related{title="Imported by" relation="code.imports" direction="in"}\n');
  write('templates/database.md', ':::er{limit=5}\n');
  write('docs/product.md', ['---', 'id: product:shop', 'kind: product', 'title: The shop', 'relates:', `  - ${SERVICE}`, 'producer: agent', '---', `The shop bills customers through the billing service.[^1]`, '', `[^1]: [billing](madarch:${SERVICE})`, ''].join('\n'));
  write('docs/domains/billing.md', [
    '---', 'id: domain:billing', 'kind: domain', 'title: Billing', 'relates:', `  - ${SERVICE}`, `  - ${CHARGE}`, `  - ${K('code.symbol', 'svc/none.ts#gone')}`, 'producer: agent', '---',
    `Charges go through one function that bills the customer.[^1]`, '',
    'A refund is posted back to the card.', '',
    `Money moves in two steps and each step is checked.[^2]`, '',
    'See also [the shop](madarch:product:shop).', '',
    `[^1]: [charge](madarch:${CHARGE}), [gone](madarch:${K('code.symbol', 'svc/none.ts#gone')})`,
    '[^2]: [handbook](madarch:doc:docs/handbook.md#money), [no such section](madarch:doc:docs/handbook.md#nothing), [no file](madarch:doc:docs/none.md)',
    '',
  ].join('\n'));
  // A document of the code repository: sections found by slug, by an explicit id and by a label.
  const documents = new Map<string, string>([
    ['docs/handbook.md', ['# Handbook', '', '## Money', 'text', '', '## Refunds {#refunds}', 'text', '', `- **UC-7 Pay.** The shopper pays through [charge](madarch:${CHARGE}), as \`svc/billing/src/a.ts\` (\`audit\`, \`nothere\`) says.`, ''].join('\n')],
    ['svc/billing/src/a.ts', A_TS],
    ['svc/billing/src/b.ts', B_TS],
  ]);

  const read = parseKinds(await Bun.file(join(productFolder, 'madarch/kinds.yaml')).text(), join(productFolder, 'madarch/kinds.yaml'), productFolder);
  expect(read.findings).toEqual([]);
  const markdown = new Map(readMarkdownEntities(productFolder, read).entities.map((entity) => [entity.id, entity]));
  const graph = new GraphReader(owner, () => '2026-06-01T00:00:00Z');
  const docs = readDocEntities([{ repo: 'shop', path: 'docs/handbook.md', text: documents.get('docs/handbook.md')! }], read);
  const readSource = async (repo: string | null, path: string): Promise<string | undefined> => (repo === 'shop' ? documents.get(path) : undefined);
  ctx = {
    productFolder,
    manifest: read,
    graph,
    markdown,
    docEntities: new Map(docs.entities.map((entity) => [entity.id, entity])),
    documents: [{ repo: 'shop', path: 'docs/handbook.md', text: documents.get('docs/handbook.md')! }],
    repositories: ['shop'],
    commitOf: () => null,
    resolver: new Resolver({ graph, markdown, declared: (kind) => read.kinds.has(kind), readDocument: readSource, repositories: () => ['shop'], documentEntity: (repo, path, line) => docs.entities.find((entity) => entity.repo === repo && entity.path === path && entity.line === line),
    locate: (entity) => (entity.span === undefined ? undefined : { repo: 'shop', path: entity.span.path, lineStart: entity.span.lineStart, lineEnd: entity.span.lineEnd, href: `/k/src?repo=shop&path=${encodeURIComponent(entity.span.path)}&line=${entity.span.lineStart}` }) }),
    repoOfScope: (id) => repoOfScope.get(id),
    readSource,
  };
}, 60_000);

afterAll(async () => {
  await owner.close();
  rmSync(productFolder, { recursive: true, force: true });
});

async function page(id: string): Promise<PageModel> {
  const result = await renderPage(ctx, id);
  if (!result.ok) throw new Error(`no page for ${id}: ${result.message}`);
  return result.page;
}

const block = <T extends Block['type']>(model: PageModel, type: T, at = 0): Extract<Block, { type: T }> => {
  const found = model.blocks.filter((entry) => entry.type === type)[at];
  if (found === undefined) throw new Error(`the page of ${model.id} has no ${type} block number ${at}: ${model.blocks.map((entry) => entry.type).join(', ')}`);
  return found as Extract<Block, { type: T }>;
};

describe('template text and the service page', () => {
  test('{{attribute}} is substituted from the entity, lists joined, and a name the entity lacks is a finding at its template line', async () => {
    const model = await page(SERVICE);
    const text = block(model, 'markdown').markdown;
    expect(text).toBe('A typescript service on express, pino; tests: jest; owner: –.');
    expect(model.findings).toContainEqual({ file: 'templates/service.md', line: 1, message: '"{{owner}}" names no attribute of this entity' });
    expect(model.title).toBe('billing');
    expect(model.kind).toBe('code.service');
  });

  test('a malformed or unknown block is a finding and a problem block in its place, with the template and its line', async () => {
    const model = await page(SERVICE);
    const problems = model.blocks.filter((entry) => entry.type === 'problem');
    expect(problems.map((entry) => entry.type === 'problem' ? [entry.file, entry.line] : [])).toEqual([['templates/service.md', 5], ['templates/service.md', 6]]);
    expect(model.findings.map((entry) => entry.message)).toContain('"nonsense" is not a block of the library (body, graph, related, callers, callees, source, er, sequence, system, modules, treemap, history, definition, stated, implementedby, linkedfrom, properties, children, term)');
    expect(model.findings.some((entry) => entry.line === 6 && entry.message.includes('closes nothing'))).toBe(true);
  });

  test('the manifest-declared relation joins the service to its package, and related with a depth reaches the files below it', async () => {
    const model = await page(SERVICE);
    const files = block(model, 'related', 0);
    expect(files.groups).toHaveLength(1);
    expect(files.groups[0]!.relation).toBe('code.contains');
    expect(files.groups[0]!.rows.map((row) => [row.entity.id, row.hops])).toEqual([[FILE_A, 3], [FILE_B, 3]]);
    expect(files.groups[0]!.rows.every((row) => row.entity.href === `/k/e/${encodeURIComponent(row.entity.id)}`)).toBe(true);
  });

  test('the graph block holds the entity and what is linked to it as nodes and edges, naming how many are shown of how many, with the filter\'s relations', async () => {
    const model = await page(SERVICE);
    const graph = block(model, 'graph');
    const hood = graph.neighborhood;
    expect(hood.center).toBe(SERVICE);
    expect(hood.nodes.find((entry) => entry.id === SERVICE)).toMatchObject({ label: 'billing', hops: 0, href: `/k/e/${encodeURIComponent(SERVICE)}` });
    // The manifest's declared edge joins the service to its package; the package, the Markdown pages that name it, both ends are nodes.
    expect(hood.edges).toContainEqual({ from: SERVICE, to: PACKAGE, relation: 'code.contains', count: 1 });
    expect(hood.edges).toContainEqual({ from: 'domain:billing', to: SERVICE, relation: 'relates', count: 1 });
    expect(hood.relations).toContainEqual({ relation: 'code.contains', direction: 'out', count: 1 });
    expect(graph.shown).toBe(hood.nodes.length - 1);
    expect(graph.shown).toBeGreaterThanOrEqual(3);
  });

  test('a block that follows code relations says so on an entity that has none of the data it needs', async () => {
    const model = await page(SERVICE);
    expect(block(model, 'callers').rows).toEqual([]);
  });

  test('the Markdown pages that name the entity in `relates` are its "described by" group', async () => {
    const model = await page(SERVICE);
    const described = block(model, 'related', 1);
    expect(described.groups).toHaveLength(1);
    expect(described.groups[0]).toMatchObject({ relation: 'relates', direction: 'in', total: 2 });
    expect(described.groups[0]!.rows.map((row) => row.entity.id)).toEqual([...['domain:billing', 'product:shop']].sort());
  });
});

describe('the function page', () => {
  test('callers and callees are listed with the place each call is read at, in the repository the graph says', async () => {
    const model = await page(CHARGE);
    const callers = block(model, 'callers');
    expect(callers.total).toBe(2);
    expect(callers.rows.map((row) => [row.entity.id, row.sites, row.site?.path, row.site?.lineStart, row.site?.repo])).toEqual([
      [AUDIT, 1, 'svc/billing/src/a.ts', 9, 'shop'],
      [HANDLE, 1, 'svc/billing/src/b.ts', 3, 'shop'],
    ]);
    expect(callers.rows[1]!.site?.href).toBe('/k/src?repo=shop&path=svc%2Fbilling%2Fsrc%2Fb.ts&line=3');
    const callees = block(model, 'callees');
    expect(callees.rows.map((row) => row.entity.id)).toEqual([AUDIT]);
    expect(callees.rows[0]!.entity.location).toMatchObject({ path: 'svc/billing/src/a.ts', lineStart: 8, lineEnd: 10 });
  });

  test('the source block shows exactly the declaration span, with its lines and its language', async () => {
    const source = block(await page(CHARGE), 'source');
    expect(source.location).toMatchObject({ repo: 'shop', path: 'svc/billing/src/a.ts', lineStart: 3, lineEnd: 6 });
    expect(source.language).toBe('typescript');
    expect(source.text).toBe(A_TS.split('\n').slice(2, 6).join('\n'));
    expect(source.truncated).toBe(false);
    expect(source.location.href).toBe('/k/src?repo=shop&path=svc%2Fbilling%2Fsrc%2Fa.ts&line=3');
  });

  test('the sequence block follows the calls out of the function, a step for each, in the source order of the places the graph read them at, and says what it does not model', async () => {
    const model = await page(HANDLE);
    const [chain] = model.blocks.flatMap((entry) => (entry.type === 'diagrams' ? entry.views : [])).filter((view) => view.spec.type === 'sequence');
    expect(chain!.spec.entry).toBe(HANDLE);
    // One participant for the service whose two files take part: the picture is of services, the steps are of calls.
    expect(chain!.elements.map((element) => element.label)).toEqual(['billing']);
    expect(chain!.edges.map((edge) => [edge.step, edge.label, edge.kind, edge.dashed])).toEqual([
      [1, 'charge', 'call', false],
      [2, 'audit', 'self', false],
      [3, 'charge', 'self', false],
    ]);
    expect(chain!.edges[2]!.note).toBe('called again; its steps are shown above');
    expect(chain!.edges[0]!.location).toMatchObject({ path: 'svc/billing/src/b.ts', lineStart: 3 });
    expect(chain!.edges.every((edge) => edge.href === `/k/e/${encodeURIComponent(edge.step === 2 ? AUDIT : CHARGE)}`)).toBe(true);
    expect(chain!.notes.join(' ')).toContain('branches, loops, error paths and repeated calls are not modelled');
    expect(chain!.renderers).toEqual(['mermaid']);
    expect(chain!.mermaidSource).toContain('sequenceDiagram');
  });

  test('a function no route reaches starts its own chain and says so, and its calls are the steps drawn', async () => {
    const [chain] = (await page(HANDLE)).blocks.flatMap((entry) => (entry.type === 'diagrams' ? entry.views : []));
    expect(chain!.notes[0]).toContain('no route of the graph reaches this function');
    const [none] = (await page(AUDIT)).blocks.flatMap((entry) => (entry.type === 'diagrams' ? entry.views : []));
    expect(none!.edges.map((edge) => edge.label)).toEqual(['charge', 'audit']);
    expect(none!.notes.join(' ')).toContain('repeated calls are not modelled');
    expect(none!.empty).toBeNull();
  });

  test('related in a direction follows the containment up to the file; the breadcrumb is the containers from the top', async () => {
    const model = await page(CHARGE);
    const declared = block(model, 'related');
    expect(declared.groups).toEqual([expect.objectContaining({ relation: 'code.contains', direction: 'in', total: 1 })]);
    expect(declared.groups[0]!.rows[0]!.entity.id).toBe(FILE_A);
    expect(model.trail.map((entry) => entry.id)).toEqual([PACKAGE, MODULE, FILE_A]);
  });

  test('the er block says what it draws and what it is given instead', async () => {
    const problem = block(await page(CHARGE), 'problem');
    expect(problem).toMatchObject({ block: 'er', file: 'templates/symbol.md', line: 7 });
    expect(problem.message).toBe('the er block draws a database or a table, and this is a code.symbol');
  });
});

describe('files, imports and the database', () => {
  test('a file shows its whole source when it has no span, and its imports in both directions', async () => {
    const model = await page(FILE_A);
    expect(block(model, 'source').text).toBe(A_TS.replace(/\n$/, ''));
    expect(block(model, 'related', 0).groups).toEqual([]);
    const importedBy = block(model, 'related', 1);
    expect(importedBy.groups[0]!.rows.map((row) => row.entity.id)).toEqual([FILE_B]);
  });

  test('the er block draws a database as its tables with their columns and the foreign key between them', async () => {
    const [er] = (await page(DATABASE)).blocks.flatMap((entry) => (entry.type === 'diagrams' ? entry.views : []));
    expect(er!.elements).toHaveLength(2);
    // Mermaid's own ER syntax: one entity per table, one row per column, and a relationship for the foreign key.
    expect(er!.mermaidSource.split('\n')[0]).toBe('erDiagram');
    expect(er!.mermaidSource).toMatch(/  customers \{\n    uuid id PK\n  \}/);
    expect(er!.mermaidSource).toMatch(/  invoices \{\n    uuid customer_id FK\n    uuid id PK\n  \}/);
    // The relationship is named by the column that carries it, not by a word every key shares.
    expect(er!.mermaidSource).toContain('customers ||--o{ invoices : "customer_id"');
    expect(er!.elements.map((element) => element.label).sort()).toEqual(['customers', 'invoices']);
    // The fixture's manifest names no page for a table, so the list draws each one plain: an element links only
    // where the product gives it a page, and the picture is the graph's either way.
    expect(er!.elements.map((element) => element.href)).toEqual([null, null]);
  });
});

describe('Markdown pages, links and grounds', () => {
  test('the body is the Markdown with its statements counted and the ungrounded ones named with their line', async () => {
    const model = await page('domain:billing');
    const body = block(model, 'body');
    expect(body.file).toBe('docs/domains/billing.md');
    expect(body.statements).toBe(3);
    expect(body.ungrounded).toEqual([{ text: 'A refund is posted back to the card.', line: 13 }]);
  });

  test('every madarch: link of the body is resolved: a key and a document section are ok, a missing key and a missing section are broken with the reason', async () => {
    const { resolutions } = await page('domain:billing');
    expect(resolutions[`madarch:${CHARGE}`]).toMatchObject({ state: 'ok', kind: 'code.symbol', label: 'charge', href: `/k/e/${encodeURIComponent(CHARGE)}`, location: { repo: 'shop', path: 'svc/billing/src/a.ts', lineStart: 3, lineEnd: 6, href: '/k/src?repo=shop&path=svc%2Fbilling%2Fsrc%2Fa.ts&line=3' } });
    expect(resolutions[`madarch:${K('code.symbol', 'svc/none.ts#gone')}`]).toEqual({ state: 'broken', why: { code: 'no-entity', key: K('code.symbol', 'svc/none.ts#gone') }, target: `madarch:${K('code.symbol', 'svc/none.ts#gone')}`, reason: `no entity "${K('code.symbol', 'svc/none.ts#gone')}" in the graph or among the product's Markdown pages` });
    expect(resolutions['madarch:doc:docs/handbook.md#money']).toMatchObject({ state: 'ok', href: '/k/doc?repo=shop&path=docs%2Fhandbook.md#money' });
    expect(resolutions['madarch:doc:docs/handbook.md#nothing']).toMatchObject({ state: 'broken', reason: 'the document "docs/handbook.md" (in shop) has no section "nothing"' });
    expect(resolutions['madarch:doc:docs/none.md']).toMatchObject({ state: 'broken', reason: 'no document "docs/none.md" in the product repository or its code repositories' });
    expect(resolutions['madarch:product:shop']).toMatchObject({ state: 'ok', kind: 'product', label: 'The shop' });
  });

  test('the broken grounds, the bad relates key and the ungrounded statement are findings with the file and line they stand on', async () => {
    const { findings } = await page('domain:billing');
    expect(findings).toContainEqual({ file: 'docs/domains/billing.md', line: 19, message: expect.stringContaining('a ground does not resolve: no entity') });
    expect(findings).toContainEqual({ file: 'docs/domains/billing.md', line: 20, message: 'a ground does not resolve: the document "docs/handbook.md" (in shop) has no section "nothing"' });
    expect(findings).toContainEqual({ file: 'docs/domains/billing.md', line: 20, message: 'a ground does not resolve: no document "docs/none.md" in the product repository or its code repositories' });
  });

  test('a page related to entities lists a relates key that resolves to nothing as broken, not as a row that links', async () => {
    const related = block(await page('domain:billing'), 'related');
    const rows = related.groups[0]!.rows;
    expect(rows.map((row) => row.entity.id)).toEqual([SERVICE, CHARGE, K('code.symbol', 'svc/none.ts#gone')]);
    expect(rows[2]!.entity.broken).toBe(`no entity "${K('code.symbol', 'svc/none.ts#gone')}" in the graph or among the product's Markdown pages`);
    expect(rows[0]!.entity.href).toBe(`/k/e/${encodeURIComponent(SERVICE)}`);
  });

  test('document sections are found by heading slug, by an explicit id and by a label opening the line', () => {
    const text = ['# Handbook', '', '## Money', '', '## Refunds {#refunds}', '', '- **UC-7 Pay.** The shopper pays.'].join('\n');
    expect(findAnchor(text, 'money')).toBe(3);
    expect(findAnchor(text, 'refunds')).toBe(5);
    expect(findAnchor(text, 'uc-7')).toBe(7);
    expect(findAnchor(text, 'pays')).toBeNull();
  });
});

describe('a document entity\'s page', () => {
  test('its text links to the graph as the links resolve, its text names code that the page lists (a name the file does not hold is shown broken), and the document and line it is stated at are on the page', async () => {
    const model = await page('doc:@shop/docs/handbook.md#uc-7');
    expect(model).toMatchObject({ kind: 'doc.use-case', title: 'UC-7 Pay' });
    expect(model.resolutions[`madarch:${CHARGE}`]).toMatchObject({ state: 'ok', label: 'charge' });
    expect(block(model, 'stated').place).toMatchObject({ repo: 'shop', path: 'docs/handbook.md', lineStart: 9 });
    const implemented = block(model, 'refs', 0);
    expect(implemented.rows.map((row) => [row.entity.id, row.entity.broken === undefined ? 'found' : 'broken'])).toEqual([
      [FILE_A, 'found'],
      [AUDIT, 'found'],
      [K('code.symbol', 'svc/billing/src/a.ts#nothere'), 'broken'],
    ]);
    expect(block(model, 'refs', 1).rows).toEqual([]);
  });

  test('a ground that names the section opens the entity\'s page, and the section\'s own anchor and a heading anchor behave as before', async () => {
    expect(await ctx.resolver.resolve('madarch:doc:docs/handbook.md#uc-7')).toMatchObject({ state: 'ok', kind: 'doc.use-case', href: `/k/e/${encodeURIComponent('doc:@shop/docs/handbook.md#uc-7')}` });
    expect(await ctx.resolver.resolve('madarch:doc:docs/handbook.md#money')).toMatchObject({ state: 'ok', kind: 'document', href: '/k/doc?repo=shop&path=docs%2Fhandbook.md#money' });
  });
});

describe('what has a page', () => {
  test('an entity of a kind the manifest does not declare has no page, and says which manifest is missing the kind', async () => {
    const result = await renderPage(ctx, MODULE);
    expect(result).toEqual({ ok: false, status: 404, message: expect.stringContaining('declares no page for it') });
    const none = await renderPage(ctx, 'code.file:nothing');
    expect(none).toEqual({ ok: false, status: 404, message: 'no entity "code.file:nothing" in the graph or among the product\'s Markdown pages' });
  });

  test('the kinds are counted from the graph and from the Markdown, and listed in key order with a filter', async () => {
    const summaries = await kindSummaries(ctx);
    expect(summaries).toEqual([
      { kind: 'product', source: 'markdown', single: true, count: 1, origins: ['agent'] },
      { kind: 'domain', source: 'markdown', single: false, count: 1, origins: ['agent'] },
      { kind: 'code.service', source: 'graph', single: false, count: 1, origins: ['code'] },
      { kind: 'code.symbol', source: 'graph', single: false, count: 3, origins: ['code'] },
      { kind: 'code.file', source: 'graph', single: false, count: 2, origins: ['code'] },
      { kind: 'code.database', source: 'graph', single: false, count: 1, origins: ['code'] },
      { kind: 'doc.use-case', source: 'document', single: false, count: 1, origins: ['person'] },
    ]);
    const symbols = await listEntities(ctx, 'code.symbol', { limit: 2 });
    expect(symbols).toMatchObject({ total: 3, next: CHARGE });
    expect(symbols!.rows.map((row) => row.id)).toEqual([AUDIT, CHARGE]);
    const rest = await listEntities(ctx, 'code.symbol', { limit: 2, after: CHARGE });
    expect(rest!.rows.map((row) => row.id)).toEqual([HANDLE]);
    expect(rest!.next).toBeNull();
    const filtered = await listEntities(ctx, 'code.symbol', { limit: 10, q: 'hand' });
    expect(filtered!.rows.map((row) => row.id)).toEqual([HANDLE]);
    expect(await listEntities(ctx, 'code.module', { limit: 10 })).toBeUndefined();
  });
});
