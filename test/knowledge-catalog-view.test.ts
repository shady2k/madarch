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
import { parseKinds } from '../src/knowledge/kinds.js';
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
  const page = (id: string, kind: string): MarkdownEntity => ({ id, kind, title: id, relates: [], producer: 'agent', sources: [], body: '', bodyLine: 1, file: `docs/${id}.md`, front: {} });
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
  test('a kind the graph holds is listed with its count and its stage, and a kind no stage fills with zero and no producer', async () => {
    const kinds = await catalogKinds(context());
    expect(kinds.map((kind) => kind.kind)).toEqual(['filled', 'empty', 'written', 'by-person']);
    expect(kinds.find((kind) => kind.kind === 'filled')).toMatchObject({ area: 'area', subgroup: 'area.one', count: 3, page: false, producer: 'extract', filled: true });
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
    expect(kinds[0]).toMatchObject({ area: 'area', subgroup: 'area.one', count: 1, page: true, producer: 'writer', filled: true });
  });
});
