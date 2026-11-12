/**
 * The catalogue's own view (madarch-8bdc.2.5): every kind the manifest declares, filled or not, with its area and subgroup,
 * its words in both languages, the entities that stand of it and what produces it today. The counts are read from the
 * graph and the pools the declarations name; a kind nothing fills is listed with zero and no producer.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import type { RenderContext } from '../src/knowledge/blocks.js';
import { catalogKinds } from '../src/knowledge/catalog-view.js';
import { parseKinds } from '../src/product/manifest/kinds.js';
import { kindSummaries, listEntities } from '../src/knowledge/render.js';
import { STARTER_FILES } from '../src/knowledge/seed.js';
import type { MarkdownEntity } from '../src/knowledge/markdown.js';

const made: string[] = [];
afterAll(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** The starter set's templates, written once: the page kinds below name them. */
const TEMPLATES = ((): string => {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-catalog-view-'));
  made.push(folder);
  for (const file of STARTER_FILES) {
    const path = join(folder, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content);
  }
  return folder;
})();

const MANIFEST = [
  'catalog:',
  '  subgroup-kind-bound: 12',
  '  attributes: [version]',
  '  origin-marks: [document, conversation, not-implemented]',
  '  extractor-mark: extractor',
  '  statuses: [implemented, not-implemented]',
  '  template-policies: [page, member, none]',
  '  relations:',
  '    contains:',
  'groups:',
  '  area: { en: Area, ru: Область, short: { en: Area, ru: Область }, open: true }',
  '  area.one: { en: One, ru: Один, short: { en: One, ru: Один }, parent: area }',
  'kinds:',
  '  filled:',
  '    id: "x.filled"',
  '    group: area.one',
  '    definition: "Something the extractor reads."',
  '    sources: ["https://example.test/filled"]',
  '    acquisition: ["extractor code"]',
  '    status: implemented',
  '    relation-constraints: { out: [], in: [] }',
  '    template-policy: none',
  '    labels:',
  '      en: { one: Filled, many: Filleds }',
  '      ru: { one: Заполненный, many: Заполненные }',
  '    description:',
  '      en: Something the extractor reads.',
  '      ru: То, что читает извлекатель.',
  '  empty:',
  '    id: "x.empty"',
  '    group: area.one',
  '    definition: "Something no stage makes yet."',
  '    sources: ["https://example.test/empty"]',
  '    acquisition: ["conversation", "not-implemented"]',
  '    status: not-implemented',
  '    relation-constraints: { out: [], in: [] }',
  '    template-policy: none',
  '    labels:',
  '      en: { one: Empty, many: Empties }',
  '      ru: { one: Пустой, many: Пустые }',
  '    description:',
  '      en: Something no stage makes yet.',
  '      ru: То, чего пока не делает ни один этап.',
  '  written:',
  '    id: "x.written"',
  '    group: area.one',
  '    definition: "A page the agent keeps."',
  '    sources: ["https://example.test/written"]',
  '    acquisition: ["document"]',
  '    status: implemented',
  '    relation-constraints: { out: [], in: [] }',
  '    template-policy: page',
  '    template: templates/item.liquid',
  '    source: markdown',
  '    file: docs/written.md',
  '    labels:',
  '      en: { one: Written, many: Written pages }',
  '      ru: { one: Написанный, many: Написанные }',
  '    description:',
  '      en: A page the agent keeps.',
  '      ru: Страница, которую ведёт агент.',
  '  by-person:',
  '    id: "x.by-person"',
  '    group: area.one',
  '    definition: "A page a person writes."',
  '    sources: ["https://example.test/by-person"]',
  '    acquisition: ["conversation"]',
  '    status: implemented',
  '    relation-constraints: { out: [], in: [] }',
  '    template-policy: page',
  '    template: templates/item.liquid',
  '    source: markdown',
  '    origin: person',
  '    file: docs/by-person.md',
  '    labels:',
  '      en: { one: Person page, many: Person pages }',
  '      ru: { one: Страница человека, many: Страницы человека }',
  '    description:',
  '      en: A page a person writes.',
  '      ru: Страница, которую пишет человек.',
  '',
].join('\n');

/** The context the view reads: a graph with three filled entities and two Markdown pages. */
function context(): RenderContext {
  const manifest = parseKinds(MANIFEST, 'madarch/kinds.yaml', TEMPLATES);
  const page = (id: string, kind: string): MarkdownEntity => ({ id, kind, title: id, relates: [], producer: 'agent', sources: [], body: '', bodyLine: 1, file: `docs/${id}.md`, front: {}, reading: { links: [], findings: [], ungrounded: [], statements: 0 }, statementReading: { statements: [], definitions: new Map() }, indexedStatements: [], mentions: [], digest: '' });
  return {
    productFolder: TEMPLATES,
    manifest,
    graph: { kindCounts: async () => [{ kind: 'filled', count: 3 }] },
    markdown: new Map([['written:a', page('written:a', 'written')], ['by-person:a', page('by-person:a', 'by-person')], ['by-person:b', page('by-person:b', 'by-person')]]),
    docEntities: new Map(),
    localizedSources: new Map(),
    language: 'en',
    documents: [],
    repositories: [],
    commitOf: () => null,
    repoOfScope: () => undefined,
    readSource: async () => undefined,
  } as unknown as RenderContext;
}

describe('the catalogue view lists every declared kind', () => {
  test('kind details preserve typed fields and project both relation directions without inventing endpoints', async () => {
    const ctx = context();
    const written = ctx.manifest.kinds.get('written')!;
    const person = ctx.manifest.kinds.get('by-person')!;
    const fields = [{ name: 'owner', type: 'text' as const, nullable: true, reference: 'by-person', producers: ['agent'] }];
    const kinds = new Map(ctx.manifest.kinds);
    kinds.set('written', { ...written, fields, relations: [{ type: 'contains', to: 'by-person:{owner}', line: 1 }] });
    kinds.set('by-person', person);
    const catalog = ctx.manifest.catalog!;
    const entries = new Map(catalog.kinds);
    entries.set('empty', { ...entries.get('empty')!, relationsOut: ['contains'], relationsIn: ['contains'] });
    const manifest = { ...ctx.manifest, kinds, catalog: { ...catalog, kinds: entries }, edges: new Map([
      ['owns', { name: 'owns', from: ['written'], to: ['filled'], repeats: false, fields: [], line: 1 }],
    ]) };
    const rows = await catalogKinds({ ...ctx, manifest });
    expect(rows.find((row) => row.kind === 'written')!.fields).toEqual(fields.map((field) => ({ ...field, declaration: { file: ctx.manifest.file, line: written.line } })));
    expect(rows.find((row) => row.kind === 'written')!.relations).toEqual([
      { direction: 'out', name: 'owns', kind: 'filled' },
      { direction: 'out', name: 'contains', kind: 'by-person' },
    ]);
    expect(rows.find((row) => row.kind === 'by-person')!.relations).toContainEqual({ direction: 'in', name: 'contains', kind: 'written' });
    expect(rows.find((row) => row.kind === 'filled')!.relations).toContainEqual({ direction: 'in', name: 'owns', kind: 'written' });
    expect(rows.find((row) => row.kind === 'empty')!.fields).toBeUndefined();
    expect(rows.find((row) => row.kind === 'empty')!.relations).toEqual([
      { direction: 'out', name: 'contains' }, { direction: 'in', name: 'contains' },
    ]);
  });

  test('catalogue-only and member kinds list real graph records, while unknown kinds remain absent', async () => {
    const ctx = context();
    const entity = (kind: string) => ({ key: `${kind}:a`, kind, label: 'A', scope: '', nodeIds: [], properties: {} });
    const graph = { ...ctx.graph, list: async (kind: string) => ({ total: kind === 'empty' ? 0 : 1, rows: kind === 'empty' ? [] : [entity(kind)], next: null }) };
    const kinds = new Map(ctx.manifest.kinds);
    kinds.set('written', { ...kinds.get('written')!, source: 'graph', member: { relation: 'contains', direction: 'in', line: 1 } });
    const contextWithRecords = { ...ctx, graph, manifest: { ...ctx.manifest, kinds } } as unknown as RenderContext;
    expect(await listEntities(contextWithRecords, 'filled', { limit: 20 })).toMatchObject({ total: 1, rows: [{ id: 'filled:a', href: null }] });
    expect(await listEntities(contextWithRecords, 'empty', { limit: 20 })).toEqual({ kind: 'empty', total: 0, rows: [], next: null });
    expect(await listEntities(contextWithRecords, 'written', { limit: 20 })).toMatchObject({ total: 1, rows: [{ id: 'written:a', href: '/e/written%3Aa' }] });
    expect(await listEntities(contextWithRecords, 'unknown', { limit: 20 })).toBeUndefined();
  });

  test('each kind carries exactly the standards and practices its manifest cites', async () => {
    const ctx = context();
    const kinds = await catalogKinds(ctx);
    for (const kind of kinds) {
      expect(kind.sources).toEqual([`https://example.test/${kind.kind}`]);
      expect(kind.declaration).toEqual({ file: ctx.manifest.file, line: ctx.manifest.catalog!.kinds.get(kind.kind)!.line });
      expect(kind).not.toHaveProperty('template');
    }
  });

  test('plugin folders come only from configured field-bound plugins, not from their names', async () => {
    const ctx = context();
    const decl = ctx.manifest.kinds.get('written')!;
    const kinds = new Map(ctx.manifest.kinds);
    kinds.set('written', {
      ...decl,
      fields: ['zebra', 'unknown', 'alpha', 'alias', 'zebra'].map((plugin, index) => ({
        name: `field${index}`, type: 'text' as const,
        binding: { kind: 'plugin' as const, plugin, major: '1', field: 'value' },
      })),
    });
    const plugin = (id: string, path?: string) => ({ id, version: '1', inputs: [], outputs: ['written'], closure: [], line: 1, ...(path === undefined ? {} : { path }) });
    const plugins = new Map([
      ['zebra', plugin('zebra', 'custom/z-reader')],
      ['alpha', plugin('alpha', 'custom/a-reader')],
      ['alias', plugin('alias', 'custom/a-reader')],
      ['unbound', plugin('unbound', 'custom/not-used')],
    ]);
    const manifest = { ...ctx.manifest, kinds, plugins };
    const written = (await catalogKinds({ ...ctx, manifest })).find((kind) => kind.kind === 'written')!;
    expect(written.plugins).toEqual(['alias', 'alpha', 'unknown', 'zebra']);
    expect(written.pluginFolders).toEqual(['custom/a-reader', 'custom/z-reader']);
    const unresolved = (await catalogKinds({ ...ctx, manifest: { ...manifest, plugins: new Map() } })).find((kind) => kind.kind === 'written')!;
    expect(unresolved.plugins).toEqual(written.plugins);
    expect(unresolved.pluginFolders).toBeUndefined();
    expect((await catalogKinds(ctx)).every((kind) => kind.pluginFolders === undefined)).toBe(true);
  });

  test('status includes catalogue-only kinds and preserves the catalogue counts and page markers', async () => {
    const ctx = context();
    const catalogue = await catalogKinds(ctx);
    const status = await kindSummaries(ctx);
    expect(status.map(({ kind, count, page }) => ({ kind, count, page }))).toEqual(catalogue.map(({ kind, count, page }) => ({ kind, count, page })));
    expect(status.find((kind) => kind.kind === 'empty')).toMatchObject({ count: 0, page: false });
  });

  test('a kind the graph holds is listed with its count and its stage, and a kind no stage fills with zero and no producer', async () => {
    const kinds = await catalogKinds(context());
    expect(kinds.map((kind) => kind.kind)).toEqual(['filled', 'empty', 'written', 'by-person']);
    expect(kinds.find((kind) => kind.kind === 'filled')).toMatchObject({ subgroup: 'area.one', count: 3, page: false, producer: 'extract', filled: true });
    expect(kinds.find((kind) => kind.kind === 'empty')).toMatchObject({ count: 0, page: false, filled: false });
    expect(kinds.find((kind) => kind.kind === 'empty')!.producer).toBeUndefined();
  });

  test('a Markdown page counts its entities and names the writer; a page a person writes is not a stage', async () => {
    const kinds = await catalogKinds(context());
    expect(kinds.find((kind) => kind.kind === 'written')).toMatchObject({ count: 1, page: true, producer: 'writer', filled: true });
    expect(kinds.find((kind) => kind.kind === 'by-person')).toMatchObject({ count: 2, page: true, producer: 'person', filled: false });
  });

  test('the words travel in both languages, so the page never falls back to an English name in Russian', async () => {
    const empty = (await catalogKinds(context())).find((kind) => kind.kind === 'empty')!;
    expect(empty.labels).toEqual({ en: { one: 'Empty', many: 'Empties' }, ru: { one: 'Пустой', many: 'Пустые' } });
    expect(empty.descriptions).toEqual({ en: 'Something no stage makes yet.', ru: 'То, чего пока не делает ни один этап.' });
  });

  test('a manifest written before the catalog lists the kinds it shows, in the group the manifest gives them', async () => {
    const bare = [
      'groups:',
      '  area: { en: Area, ru: Область, short: { en: Area, ru: Область } }',
      '  area.one: { en: One, ru: Один, short: { en: One, ru: Один }, parent: area }',
      'kinds:',
      '  written:',
      '    template: templates/item.liquid',
      '    source: markdown',
      '    file: docs/written.md',
      '    group: area.one',
      '    labels:',
      '      en: { one: Written, many: Written pages }',
      '      ru: { one: Написанный, many: Написанные }',
      '    description:',
      '      en: A page the agent keeps.',
      '      ru: Страница, которую ведёт агент.',
      '',
    ].join('\n');
    const manifest = parseKinds(bare, 'madarch/kinds.yaml', TEMPLATES);
    const kinds = await catalogKinds({ ...context(), manifest } as unknown as RenderContext);
    expect(kinds.map((kind) => kind.kind)).toEqual(['written']);
    expect(kinds[0]).toMatchObject({ subgroup: 'area.one', count: 1, page: true, producer: 'writer', filled: true });
    expect(kinds[0]!.sources).toBeUndefined();

  });
});
