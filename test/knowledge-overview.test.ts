/**
 * The product overview's six blocks (madarch-47vw.5): what the product is, how it works, its data, its key terms, where
 * it stands and where to start reading. Each reads the product's manifest, Markdown, graph and the store's run state;
 * a section without data says which entity's fill brings it and links to the fill, never stands empty.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import type { RenderContext } from '../src/knowledge/blocks.js';
import { parseKinds } from '../src/knowledge/kinds.js';
import { STARTER_FILES } from '../src/knowledge/seed.js';
import type { MarkdownEntity } from '../src/knowledge/markdown.js';
import type { GraphEntity } from '../src/knowledge/graph-read.js';
import { overviewAbout, overviewData, overviewHow, overviewReading, overviewStatus, overviewTerms } from '../src/knowledge/overview.js';

const made: string[] = [];
afterAll(() => { for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true }); });

const TEMPLATES = ((): string => {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-overview-'));
  made.push(folder);
  for (const file of STARTER_FILES) {
    const path = join(folder, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content);
  }
  return folder;
})();

const MANIFEST = [
  'groups:',
  '  area: { en: Area, ru: Область }',
  'kinds:',
  '  product:',
  '    template: templates/product.liquid',
  '    source: markdown',
  '    file: docs/product.md',
  '    group: area',
  '    labels: { en: { one: Product, many: Products }, ru: { one: Продукт, many: Продукты } }',
  '  doc.term:',
  '    template: templates/term.liquid',
  '    source: markdown',
  '    file: docs/glossary.md',
  '    listing: glossary',
  '    group: area',
  '    labels: { en: { one: Term, many: Terms }, ru: { one: Термин, many: Термины } }',
  '  code.service:',
  '    template: templates/entity.liquid',
  '    source: graph',
  '    system: container',
  '    group: area',
  '    labels: { en: { one: Service, many: Services }, ru: { one: Сервис, many: Сервисы } }',
  '  milestone:',
  '    template: templates/entity.liquid',
  '    source: graph',
  '    group: area',
  '    labels: { en: { one: Milestone, many: Milestones }, ru: { one: Веха, many: Вехи } }',
  '  db.table:',
  '    template: templates/entity.liquid',
  '    source: graph',
  '    er: tables',
  '    group: area',
  '    labels: { en: { one: Table, many: Tables }, ru: { one: Таблица, many: Таблицы } }',
  '',
].join('\n');

function page(id: string, kind: string, title: string, body: string): MarkdownEntity {
  return { id, kind, title, relates: [], producer: 'agent', sources: [], body, bodyLine: 1, file: kind === 'product' ? 'docs/product.md' : 'docs/glossary.md', front: {} };
}

const milestone: GraphEntity = {
  key: 'milestone:one', kind: 'milestone', label: 'First release', properties: {}, nodeIds: [], scope: 'shop',
  evidence: [{ field: 'label', repository: 'shop', path: 'docs/roadmap.md', lineStart: 4, lineEnd: 4, commit: 'abc' }],
};

function context(): RenderContext {
  const manifest = parseKinds(MANIFEST, 'madarch/kinds.yaml', TEMPLATES);
  const markdown = new Map([
    ['product:shop', page('product:shop', 'product', 'The shop', 'The shop bills customers through the billing service.')],
    ['doc.term:Fill', page('doc.term:Fill', 'doc.term', 'Fill', '**Fill** — the one run that reads a repository.')],
  ]);
  const graph = {
    kindCounts: async () => [{ kind: 'milestone', count: 1 }, { kind: 'db.table', count: 0 }],
    list: async (kind: string) => kind === 'milestone'
      ? { rows: [milestone], next: null, total: 1 }
      : { rows: [], next: null, total: 0 },
    relationEdges: async () => ({ total: 0, rows: [] }),
    find: async () => [],
  };
  return {
    productFolder: TEMPLATES,
    manifest,
    graph,
    markdown,
    language: 'en',
    repositories: ['shop'],
    ownRepository: 'shop',
    readSource: async (_repo: string | null, path: string) => path === 'README.md' ? '# Shop\n\nA small shop that bills customers.' : undefined,
    commitOf: () => 'abcdef0123456789',
    fillRun: { finishedAt: '2026-11-10T12:00:00.000Z', wallMs: 1000 },
    problemCount: () => 2,
  } as unknown as RenderContext;
}

const product = (ctx: RenderContext) => ({ source: 'markdown' as const, entity: ctx.markdown.get('product:shop')! });

describe('the overview blocks (madarch-47vw.5)', () => {
  test('about reads the vision and README with the source each stands on', async () => {
    const ctx = context();
    const block = await overviewAbout(ctx, product(ctx), { readme: 'README.md' }, 'en');
    expect(block.type).toBe('overview');
    if (block.type !== 'overview') return;
    expect(block.section).toBe('about');
    expect(block.paragraphs).toHaveLength(2);
    expect(block.paragraphs![0]!.text).toContain('bills customers');
    expect(block.paragraphs![0]!.source!.href).toContain('/src?');
    expect(block.paragraphs![1]!.text).toContain('small shop');
  });

  test('how says which fill brings the system view when there is none', async () => {
    const ctx = context();
    const block = await overviewHow(ctx, product(ctx), {}, 'templates/product.liquid', 1, 'en');
    if (block.type !== 'overview') throw new Error('not an overview');
    expect(block.section).toBe('how');
    expect(block.absent).toBeDefined();
    expect(block.absent!.href).toBe('/fill');
    // The entity is named by its catalogue name, never by its id; the Russian says «сущность»/«схема», not «вид».
    expect(block.absent!.message).toContain('Services');
    expect(block.absent!.message).not.toContain('code.service');
    const ru = await overviewHow(ctx, product(ctx), {}, 'templates/product.liquid', 1, 'ru');
    if (ru.type !== 'overview') throw new Error('not an overview');
    expect(ru.absent!.message).toContain('Сервисы');
    expect(ru.absent!.message).toContain('схема системы');
    expect(ru.absent!.message).not.toContain('code.service');
    expect(ru.absent!.message).not.toContain('системный вид');
  });

  test('data says which entity’s fill brings the tables when no ER entity stands', async () => {
    const ctx = context();
    const block = await overviewData(ctx, {}, 'templates/product.liquid', 1, 'en');
    if (block.type !== 'overview') throw new Error('not an overview');
    expect(block.section).toBe('data');
    expect(block.absent).toBeDefined();
    expect(block.absent!.message).toContain('Tables');
    expect(block.absent!.href).toBe('/fill');
  });

  test('terms lists the glossary with each definition and its source', async () => {
    const ctx = context();
    const block = await overviewTerms(ctx, {}, 'en');
    if (block.type !== 'overview') throw new Error('not an overview');
    expect(block.section).toBe('terms');
    expect(block.rows!.map((row) => row.label)).toEqual(['Fill']);
    expect(block.rows![0]!.value).toContain('one run');
    expect(block.rows![0]!.source!.href).toContain('/src?');
  });

  test('status shows the milestone, the open problems, the last fill and its commit', async () => {
    const ctx = context();
    const block = await overviewStatus(ctx, { 'milestone-kind': 'milestone', 'outcome-kind': 'outcome' }, 'en');
    if (block.type !== 'overview') throw new Error('not an overview');
    expect(block.section).toBe('status');
    expect(block.rows!.map((row) => row.label)).toEqual(['First release', 'Open problems', 'Last fill', 'Commit']);
    expect(block.rows![1]!.value).toBe('2');
    expect(block.rows![2]!.value).toBe('2026-11-10');
    expect(block.rows![3]!.value).toBe('abcdef0');
    expect(block.absent).toBeUndefined();
  });

  test('reading links to the surfaces a newcomer starts from, in both languages', () => {
    const en = overviewReading(context(), {}, 'en');
    if (en.type !== 'overview') throw new Error('not an overview');
    expect(en.links!.map((link) => link.href)).toEqual(['/docs', '/catalogue', '/glossary', '/problems', '/fill']);
    const ru = overviewReading(context(), {}, 'ru');
    if (ru.type !== 'overview') throw new Error('not an overview');
    expect(ru.title).toBe('С чего начать читать');
  });
});
