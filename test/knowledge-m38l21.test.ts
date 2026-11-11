/**
 * Pages for people (madarch-m38l.21): details are labelled from the manifest,
 * member kinds have no catalogue page of their own, and a section with nothing
 * in it is either left out or says what was looked for.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeGraph } from './fake-graph.js';
import { membersBlock, type RenderContext } from '../src/knowledge/blocks.js';
import { parseKinds } from '../src/product/manifest/kinds.js';
import { graphMarkdownEntities } from '../src/knowledge/markdown.js';
import type { Block, PageModel } from '../src/knowledge/model.js';
import { kindSummaries, listEntities, renderPage } from '../src/knowledge/render.js';
import { catalogKinds } from '../src/knowledge/catalog-view.js';
import { Resolver } from '../src/knowledge/resolve.js';

const K = (kind: string, rest: string): string => `${kind}:${rest}`;
const FILE = K('code.file', 'src/a.ts');
const CHARGE = K('code.symbol', 'src/a.ts#charge');
const SILENT = K('code.symbol', 'src/a.ts#silent');
const READER = K('code.symbol', 'src/b.ts#read');
const FACET = K('code.facet', 'code.extract.code#code.file:src/a.ts');
const FIELD = K('code.field', 'code.symbol:src/a.ts#charge#amount');
const SERVICE = K('code.service', 'shop/orders');
const LEDGER = K('code.symbol', 'src/ledger.ts#Ledger');
const LEDGER_FIELDS = Array.from({ length: 201 }, (_, at) => K('code.field', `code.symbol:src/ledger.ts#Ledger#f${String(at + 1).padStart(3, '0')}`));
const HOT = K('code.symbol', 'src/hot.ts#Hot');
const HOT_FIELD = K('code.field', 'code.symbol:src/hot.ts#Hot#hot');
const HOT_READERS = Array.from({ length: 101 }, (_, at) => K('code.symbol', `src/readers/r${String(at + 1).padStart(3, '0')}.ts#read`));
const ORPHAN = K('code.field', 'code.symbol:src/gone.ts#Gone#lost');

let ctx: RenderContext;
let product: string;

const span = (path: string, lineStart: number, lineEnd: number) => ({ path, lineStart, lineEnd, byteStart: 0, byteEnd: 10 });

beforeAll(async () => {
  product = mkdtempSync(join(tmpdir(), 'madarch-m38l21-'));
  const fake = new FakeGraph();
  fake.add('code.repository:shop', 'code.repository', 'shop', { path: '/work/shop' });
  const add = (key: string, kind: string, label: string, properties: Record<string, unknown> = {}): void => { fake.add(key, kind, label, properties); };
  const link = (relation: string, from: string, to: string): void => { fake.link(relation, from, to); };
  await add(FILE, 'code.file', 'a.ts', { path: 'src/a.ts', span: span('src/a.ts', 1, 20) });
  await add(CHARGE, 'code.symbol', 'charge', { path: 'src/a.ts', symbolKind: 'function', internalOnly: true, span: span('src/a.ts', 1, 9) });
  await add(SILENT, 'code.symbol', 'silent', { path: 'src/a.ts', symbolKind: 'function', span: span('src/a.ts', 11, 12) });
  await add(READER, 'code.symbol', 'read', { path: 'src/b.ts', symbolKind: 'function', span: span('src/b.ts', 1, 2) });
  await add(FACET, 'code.facet', 'a.ts · src/a.ts', { ownerKey: FILE, language: 'typescript', role: 'code', authors: ['Avery Quinn', 'Rin Tanaka'], commitCount: 3, parsed: true });
  await add(FIELD, 'code.field', 'amount', { name: 'amount', type: 'number', value: '0' });
  await add(ORPHAN, 'code.field', 'lost', { name: 'lost', type: 'number' });
  await add(SERVICE, 'code.service', 'orders', { language: 'typescript', build: { context: '.', dockerfile: 'Dockerfile', args: ['--prod'] } });
  await add(LEDGER, 'code.symbol', 'Ledger', { path: 'src/ledger.ts', symbolKind: 'class', span: span('src/ledger.ts', 1, 400) });
  for (const [at, key] of LEDGER_FIELDS.entries()) {
    await add(key, 'code.field', `f${String(at + 1).padStart(3, '0')}`, { name: `f${String(at + 1).padStart(3, '0')}`, type: 'number', value: String(at) });
    await link('code.contains', LEDGER, key);
  }
  await add(HOT, 'code.symbol', 'Hot', { path: 'src/hot.ts', symbolKind: 'class', span: span('src/hot.ts', 1, 4) });
  await add(HOT_FIELD, 'code.field', 'hot', { name: 'hot', type: 'number', value: '1' });
  await link('code.contains', HOT, HOT_FIELD);
  for (const [at, key] of HOT_READERS.entries()) {
    await add(key, 'code.symbol', `read${String(at + 1).padStart(3, '0')}`, { path: `src/readers/r${String(at + 1).padStart(3, '0')}.ts`, symbolKind: 'function' });
    await link('code.reads-field', key, HOT_FIELD);
  }
  await link('code.facet-of', FACET, FILE);
  await link('code.contains', CHARGE, FIELD);
  await link('code.reads-field', READER, FIELD);
  await link('code.calls', READER, CHARGE);

  const write = (path: string, text: string): void => { mkdirSync(join(product, path, '..'), { recursive: true }); writeFileSync(join(product, path), text); };
  write('madarch/kinds.yaml', [
    'properties:',
    '  language: { en: Language, ru: Язык }',
    '  role: { en: Role, ru: Роль }',
    '  authors: { en: Authors, ru: Авторы }',
    '  commitCount: { en: Commits, ru: Коммитов }',
    '  parsed: { en: Parsed, ru: Разобран }',
    '  name: { en: Name, ru: Имя }',
    '  type: { en: Type, ru: Тип }',
    '  value: { en: Value, ru: Значение }',
    '  symbolKind: { en: Symbol kind, ru: Вид символа }',
    '  path: { en: Path, ru: Путь }',
    '  steps: { en: Steps, ru: Шаги }',
    '  uses: { en: Actions, ru: Действия }',
    '  build: { en: Build, ru: Сборка, format: build, fields: { context: { en: Build context, ru: Контекст сборки }, dockerfile: { en: Dockerfile, ru: Dockerfile } } }',
    '  workingDirectory: { en: Working directory, ru: Рабочая папка }',
    'kinds:',
    '  code.file:',
    '    template: templates/file.liquid',
    '    source: graph',
    '  code.symbol:',
    '    template: templates/symbol.liquid',
    '    source: graph',
    '    details: [symbolKind, path]',
    '  code.facet:',
    '    template: templates/item.liquid',
    '    source: graph',
    '    member: { relation: code.facet-of, direction: out, parentKind: code.file }',
    '    details: [language, role, authors, commitCount]',
    '  code.service:',
    '    template: templates/item.liquid',
    '    source: graph',
    '    details: [language, build]',
    '  code.field:',
    '    template: templates/item.liquid',
    '    source: graph',
    '    member: { relation: code.contains, direction: in, parentKind: code.symbol }',
    '    details: [name, type, value]',
    '',
  ].join('\n'));
  write('templates/entity.liquid', '{% block lead %}{% endblock %}\n{% block details %}{% endblock %}\n{% block calls %}{% endblock %}\n{% block parts %}{% endblock %}\n');
  write('templates/file.liquid', '{% layout "./entity.liquid" %}\n{% block lead %}{{ page.path }}{% endblock %}\n{% block parts %}{% members title="Code facts" title-ru="Сведения о коде" kind="code.facet" relation="code.facet-of" direction="in" %}{% endblock %}\n');
  write('templates/symbol.liquid', '{% layout "./entity.liquid" %}\n{% block lead %}{{ page.symbolKind }} in {{ page.path }}{% endblock %}\n{% block details %}{% properties title="Details" title-ru="Сведения" %}{% endblock %}\n{% block calls %}{% callers title="Callers" title-ru="Кто вызывает" %}{% endblock %}\n{% block parts %}{% members title="Fields" title-ru="Поля" kind="code.field" relation="code.contains" direction="out" readers="code.reads-field" %}{% endblock %}\n');
  write('templates/item.liquid', '{% layout "./entity.liquid" %}\n{% block details %}{% properties title="Details" title-ru="Сведения" %}{% endblock %}\n');
  const read = parseKinds(await Bun.file(join(product, 'madarch/kinds.yaml')).text(), join(product, 'madarch/kinds.yaml'), product);
  expect(read.findings).toEqual([]);
  const block = (name: string, params: Record<string, string> = {}) => ({ type: 'block', name, params, line: 1 });
  const attribute = (name: string) => ({ type: 'attribute', name, line: 1 });
  add('template:templates/file.liquid', 'template', 'File', { template_parts: [attribute('path'), block('members', { title: 'Code facts', 'title-ru': 'Сведения о коде', kind: 'code.facet', relation: 'code.facet-of', direction: 'in' })] });
  add('template:templates/symbol.liquid', 'template', 'Symbol', { template_parts: [attribute('symbolKind'), { type: 'text', text: ' in ', line: 1 }, attribute('path'), block('properties', { title: 'Details', 'title-ru': 'Сведения' }), block('callers', { title: 'Callers', 'title-ru': 'Кто вызывает' }), block('members', { title: 'Fields', 'title-ru': 'Поля', kind: 'code.field', relation: 'code.contains', direction: 'out', readers: 'code.reads-field' })] });
  add('template:templates/item.liquid', 'template', 'Item', { template_parts: [block('properties', { title: 'Details', 'title-ru': 'Сведения' })] });
  const graph = fake.reader();
  const markdown = new Map((await graphMarkdownEntities(graph, read)).entities.map((entity) => [entity.id, entity]));
  const readSource = async (_repo: string | null, path: string): Promise<string | undefined> => path === 'src/a.ts' ? 'export function charge() {}\n' : undefined;
  ctx = {
    productFolder: product,
    manifest: read,
    graph,
    markdown,
    language: 'en',
    repositories: ['shop'],
    commitOf: () => null,
    resolver: new Resolver({ graph, markdown, declared: (kind) => read.kinds.has(kind), documentKinds: [], repositories: () => ['shop'], locate: () => undefined }),
    repoOfScope: () => 'shop',
    readSource,
  };
}, 60_000);

afterAll(() => {
  rmSync(product, { recursive: true, force: true });
});

async function page(id: string, lang?: string): Promise<PageModel> {
  const result = await renderPage(ctx, id, lang);
  if (!result.ok) throw new Error(`no page for ${id}: ${result.message}`);
  return result.page;
}

const block = <T extends Block['type']>(model: PageModel, type: T, at = 0): Extract<Block, { type: T }> => {
  const found = model.blocks.filter((entry) => entry.type === type)[at];
  if (found === undefined) throw new Error(`the page of ${model.id} has no ${type} block number ${at}: ${model.blocks.map((entry) => entry.type).join(', ')}`);
  return found as Extract<Block, { type: T }>;
};

describe('details, members and empty sections', () => {
  test('status counts a member without a page, and its old address opens the parent at the member anchor', async () => {
    const facets = (await kindSummaries(ctx)).find((summary) => summary.kind === 'code.facet');
    expect(facets).toMatchObject({ count: 1, page: false });
    const summary = await kindSummaries(ctx);
    const catalogue = await catalogKinds(ctx);
    expect(summary.map(({ kind, count, page }) => ({ kind, count, page }))).toEqual(catalogue.map(({ kind, count, page }) => ({ kind, count, page })));
    expect(await listEntities(ctx, 'code.facet', { limit: 10 })).toEqual({
      kind: 'code.facet', total: 1, rows: [{ id: FACET, kind: 'code.facet', label: 'a.ts · src/a.ts', href: `/e/${encodeURIComponent(FACET)}` }], next: null,
    });
    const model = await page(FACET, 'ru');
    expect(model.id).toBe(FILE);
    expect(model.redirect).toEqual({ id: FILE, anchor: expect.stringMatching(/^member-/) });
    const members = block(model, 'members');
    const row = members.rows.find((entry) => entry.entity.id === FACET);
    expect(row?.anchor).toBe(model.redirect?.anchor);
    expect(row?.values).toEqual([
      { name: 'language', label: 'Язык', value: 'typescript' },
      { name: 'role', label: 'Роль', value: 'code' },
      { name: 'authors', label: 'Авторы', value: 'Avery Quinn, Rin Tanaka' },
      { name: 'commitCount', label: 'Коммитов', value: '3' },
    ]);
  });

  test('only the details the manifest names are drawn, with both labels and formatted values; internal keys and JSON never reach the reader', async () => {
    const model = await page(CHARGE, 'ru');
    const details = block(model, 'properties');
    expect(details.rows).toEqual([
      { name: 'symbolKind', label: 'Вид символа', value: 'function' },
      { name: 'path', label: 'Путь', value: 'src/a.ts' },
    ]);
    expect(JSON.stringify(details.rows)).not.toContain('internalOnly');
  });

  test('a class member lists its name, type, value and who reads it', async () => {
    const fields = block(await page(CHARGE), 'members');
    expect(fields.rows).toHaveLength(1);
    expect(fields.rows[0]!.values).toEqual([
      { name: 'name', label: 'Name', value: 'amount' },
      { name: 'type', label: 'Type', value: 'number' },
      { name: 'value', label: 'Value', value: '0' },
    ]);
    expect(fields.rows[0]!.readers.map((entity) => entity.id)).toEqual([READER]);
  });

  test('a nested value is labelled from the manifest: a build shows its context and its Dockerfile, not JSON keys', async () => {
    const [en, ru] = [await page(SERVICE, 'en'), await page(SERVICE, 'ru')];
    const row = (model: PageModel) => {
      const found = block(model, 'properties').rows.find((entry) => entry.name === 'build');
      if (found === undefined) throw new Error(`the page of ${model.id} has no build row: ${JSON.stringify(block(model, 'properties').rows)}`);
      return found;
    };
    expect(row(en).label).toBe('Build');
    expect(row(ru).label).toBe('Сборка');
    // The keys the manifest declares are words a reader knows, in the language the page is read in.
    expect(row(en).value).toContain('Build context: .');
    expect(row(en).value).toContain('Dockerfile: Dockerfile');
    expect(row(ru).value).toContain('Контекст сборки: .');
    expect(row(ru).value).toContain('Dockerfile: Dockerfile');
    expect(row(ru).value).not.toContain('context');
    expect(row(ru).value).not.toContain('dockerfile');
    // A key the manifest does not declare is shown under its own name: no value is dropped from the page.
    expect(row(en).value).toContain('args: --prod');
  });

  test('a nested value the manifest misdeclares is a finding with its file, line and path', () => {
    const file = join(product, 'madarch', 'nested.yaml');
    const read = parseKinds([
      'properties:', '  build:', '    en: Build', '    ru: Сборка', '    fields:', '      context:', '        en: Build context', 'kinds:', '',
    ].join('\n'), file, product);
    expect(read.findings.length).toBeGreaterThan(0);
    expect(read.findings[0]!.file).toBe(file);
    expect(read.findings[0]!.line).toBe(6);
    expect(read.findings[0]!.message).toContain('build');
    expect(read.findings[0]!.message).toContain('context');
    expect(read.findings[0]!.message).toContain('ru');
  });

  test('a class with more fields than one read returns draws every field, and the total is the number of rows', async () => {
    const [ledger] = await ctx.graph.find(LEDGER);
    expect(ledger).toBeDefined();
    const members = await membersBlock(ctx, { source: 'graph', entity: ledger! }, { title: 'Fields', kind: 'code.field', relation: 'code.contains', direction: 'out', limit: '200' }, 'templates/symbol.liquid', 1, 'en');
    if (members.type !== 'members') throw new Error(`the members block is a problem: ${JSON.stringify(members)}`);
    // The template's limit is where a read starts, not what a reader may reach: the 201st field is on the page like the first.
    expect(members.total).toBe(201);
    expect(members.rows).toHaveLength(201);
    expect(members.rows.map((row) => row.name)).toContain('f201');
    expect(new Set(members.rows.map((row) => row.anchor)).size).toBe(201);
  }, 60_000);

  test('a member read by more callers than one read returns draws every caller', async () => {
    const model = await page(HOT);
    const fields = block(model, 'members');
    expect(fields.rows).toHaveLength(1);
    expect(fields.total).toBe(1);
    expect(fields.rows[0]!.readers).toHaveLength(101);
    expect(fields.rows[0]!.readers.map((entity) => entity.id)).toContain(HOT_READERS[100]!);
  }, 30_000);

  test('a member no parent holds is refused with the manifest line that declares it, not drawn as a page of its own', async () => {
    const result = await renderPage(ctx, ORPHAN);
    if (result.ok) throw new Error(`the orphan member was drawn as the page ${result.page.id}`);
    expect(result.status).toBe(404);
    const file = join(product, 'madarch', 'kinds.yaml');
    const lines = (await Bun.file(file).text()).split('\n');
    // The address, the kind, the relation and its direction, the parent kind, and where the manifest declared it.
    expect(result.message).toContain(ORPHAN);
    expect(result.message).toContain('code.field');
    expect(result.message).toContain('code.contains (in)');
    expect(result.message).toContain('no code.symbol holds it');
    expect(result.message).toContain(`${file}:${lines.indexOf('  code.field:') + 1} declares`);
  });

  test('an empty call list says what was looked for, in the reader\'s language; an empty related list is not drawn at all', async () => {
    const model = await page(SILENT, 'ru');
    const callers = block(model, 'callers');
    expect(callers.rows).toEqual([]);
    expect(callers.emptyNote).toBe('В графе не записано ни одного вызова.');
    expect(model.blocks.some((entry) => entry.type === 'related')).toBe(false);
    const chained = await page(CHARGE, 'ru');
    expect(block(chained, 'callers').emptyNote).toBeUndefined();
  });
});
