/**
 * Pages for people (madarch-m38l.21): details are labelled from the manifest,
 * member kinds have no catalogue page of their own, and a section with nothing
 * in it is either left out or says what was looked for.
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
import { Resolver } from '../src/knowledge/resolve.js';

const K = (kind: string, rest: string): string => `${kind}:${rest}`;
const FILE = K('code.file', 'src/a.ts');
const CHARGE = K('code.symbol', 'src/a.ts#charge');
const SILENT = K('code.symbol', 'src/a.ts#silent');
const READER = K('code.symbol', 'src/b.ts#read');
const FACET = K('code.facet', 'code.extract.code#code.file:src/a.ts');
const FIELD = K('code.field', 'code.symbol:src/a.ts#charge#amount');
const SERVICE = K('code.service', 'shop/orders');

let owner: DatabaseOwner;
let store: GraphStore;
let ctx: RenderContext;
let product: string;

const span = (path: string, lineStart: number, lineEnd: number) => ({ path, lineStart, lineEnd, byteStart: 0, byteEnd: 10 });

beforeAll(async () => {
  product = mkdtempSync(join(tmpdir(), 'madarch-m38l21-'));
  owner = createPGliteDatabaseOwner({ btreeGist: true });
  await owner.ready;
  store = createGraphStore(owner, { now: () => new Date('2026-06-01T00:00:00Z') });
  await store.createSchema();
  await store.registerCodeSchema({ kinds: ['code.file', 'code.symbol', 'code.facet', 'code.field', 'code.service'], relations: [{ key: 'code.facet-of' }, { key: 'code.contains' }, { key: 'code.reads-field' }, { key: 'code.calls' }] });
  const scope = await store.newNode();
  await store.openNode({ nodeId: scope, kind: 'code.repository', label: 'shop', properties: { path: '/work/shop' }, validFrom: '2026-01-01T00:00:00Z', owner: { producer: 'code.extract.driver', scope } });
  const ids = new Map<string, GraphId>();
  const add = async (key: string, kind: string, label: string, properties: Record<string, unknown> = {}): Promise<void> => {
    const opened = await store.openNode({ kind, label, properties: { ...properties, recordKey: key }, validFrom: '2026-01-01T00:00:00Z', owner: { producer: 'code.extract.code', scope } });
    ids.set(key, opened.nodeId);
  };
  const link = async (relation: string, from: string, to: string): Promise<void> => {
    await store.openEdge({ relation, src: ids.get(from)!, dst: ids.get(to)!, properties: {}, validFrom: '2026-01-01T00:00:00Z', owner: { producer: 'code.extract.code', scope } });
  };
  await add(FILE, 'code.file', 'a.ts', { path: 'src/a.ts', span: span('src/a.ts', 1, 20) });
  await add(CHARGE, 'code.symbol', 'charge', { path: 'src/a.ts', symbolKind: 'function', internalOnly: true, span: span('src/a.ts', 1, 9) });
  await add(SILENT, 'code.symbol', 'silent', { path: 'src/a.ts', symbolKind: 'function', span: span('src/a.ts', 11, 12) });
  await add(READER, 'code.symbol', 'read', { path: 'src/b.ts', symbolKind: 'function', span: span('src/b.ts', 1, 2) });
  await add(FACET, 'code.facet', 'a.ts · src/a.ts', { ownerKey: FILE, language: 'typescript', role: 'code', authors: ['Avery Quinn', 'Rin Tanaka'], commitCount: 3, parsed: true });
  await add(FIELD, 'code.field', 'amount', { name: 'amount', type: 'number', value: '0' });
  await add(SERVICE, 'code.service', 'orders', { language: 'typescript', build: { context: '.', dockerfile: 'Dockerfile', args: ['--prod'] } });
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
  const markdown = new Map(readMarkdownEntities(product, read).entities.map((entity) => [entity.id, entity]));
  const graph = new GraphReader(owner, () => '2026-06-01T00:00:00Z');
  const docs = readDocEntities([], read);
  const readSource = async (_repo: string | null, path: string): Promise<string | undefined> => path === 'src/a.ts' ? 'export function charge() {}\n' : undefined;
  ctx = {
    productFolder: product,
    manifest: read,
    graph,
    markdown,
    docEntities: new Map(docs.entities.map((entity) => [entity.id, entity])),
    localizedSources: new Map(),
    language: 'en',
    documents: [],
    repositories: ['shop'],
    commitOf: () => null,
    resolver: new Resolver({ graph, markdown, declared: (kind) => read.kinds.has(kind), readDocument: readSource, repositories: () => ['shop'], locate: () => undefined }),
    repoOfScope: () => 'shop',
    readSource,
  };
}, 60_000);

afterAll(async () => {
  await owner.close();
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
  test('a member kind has no catalogue entry, and its old address opens the parent at the member anchor', async () => {
    const facets = (await kindSummaries(ctx)).find((summary) => summary.kind === 'code.facet');
    expect(facets).toBeUndefined();
    expect(await listEntities(ctx, 'code.facet', { limit: 10 })).toBeUndefined();
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
