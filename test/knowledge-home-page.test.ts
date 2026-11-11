/**
 * The home page is the product overview (madarch-47vw.5): six engine blocks the product's own template places — what
 * the product is, how it works, its data, its key terms, where it stands and where to start reading. No folder or file
 * list, no repository address and no run trace stands on it. A section with no data says which entity's fill brings it.
 */
import { afterAll, beforeAll, describe as bunDescribe, expect, test as bunTest } from 'bun:test';
import { skippedBecauseOutOfWorkflow } from './fill-skip-list.js';

// The cases read a stage out of this step's list: they come back with that stage's step (test/fill-skip-list.ts).
const skippedSuite = skippedBecauseOutOfWorkflow(import.meta.path);
const describe = bunDescribe.skipIf(skippedSuite !== undefined);
const test = bunTest.skipIf(skippedSuite !== undefined);
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import type { OverviewBlockShape, PageModel } from '../src/knowledge/model.js';
import { generateTrainingRepository, makeProduct, writeSamplePages } from './knowledge-fixture.js';

let work: string;
let product: KnowledgeProduct;

beforeAll(async () => {
  // The store the cases read is filled by stages out of this step's list: no fixture is made or closed.
  if (skippedSuite !== undefined) return;
  work = mkdtempSync(join(tmpdir(), 'madarch-home-overview-'));
  const repository = generateTrainingRepository(join(work, 'repo'));
  mkdirSync(join(work, 'home'));
  const folder = makeProduct(join(work, 'home'), 'training-shop', repository);
  writeSamplePages(folder);
  product = new KnowledgeProduct({ productFolder: folder, storeRoot: join(work, 'store') });
  expect(await product.startFill()).toMatchObject({ started: true });
  await product.settled();
  expect(product.fillState()).toMatchObject({ state: 'done' });
}, 900_000);

afterAll(async () => {
  if (skippedSuite !== undefined) return;
  await product.close();
  rmSync(work, { recursive: true, force: true });
});

async function page(id: string, lang?: string): Promise<PageModel> {
  const result = await product.page(id, lang);
  if (!result.ok) throw new Error(`no page for ${id}: ${result.message}`);
  return result.page;
}

const overviews = (model: PageModel): OverviewBlockShape[] => model.blocks.filter((block): block is OverviewBlockShape => block.type === 'overview');
const hasContent = (block: OverviewBlockShape): boolean => (block.paragraphs?.length ?? 0) > 0 || (block.rows?.length ?? 0) > 0 || (block.links?.length ?? 0) > 0 || block.diagrams !== undefined;

describe('the home page is the product overview (madarch-47vw.5)', () => {
  test('the six sections stand in the template order, and no file list, repository address or history is on it', async () => {
    const model = await page('product:shop');
    const sections = overviews(model);
    expect(sections.map((block) => block.section)).toEqual(['about', 'how', 'data', 'terms', 'status', 'reading']);
    const types = new Set(model.blocks.map((block) => block.type));
    for (const gone of ['body', 'history', 'treemap', 'related', 'repository', 'folder', 'file'] as const) expect(types.has(gone)).toBe(false);
    // The product body is read by the about block, never drawn again as a page body.
    expect(model.blocks.some((block) => block.type === 'markdown' && block.markdown.includes('The shop bills customers'))).toBe(false);
  });

  test('every section has content with its source, or says which entity’s fill brings it and links to the fill', async () => {
    const model = await page('product:shop');
    const sections = overviews(model);
    for (const block of sections) {
      expect(block.title.trim()).not.toBe('');
      expect(hasContent(block) || block.absent !== undefined).toBe(true);
      if (!hasContent(block)) {
        expect(block.absent!.message.trim()).not.toBe('');
        expect(block.absent!.href).toBe('/fill');
        expect(block.absent!.label.trim()).not.toBe('');
      }
    }
    // The fixture has a product body and a README, but no vision kind, no ER kind, no glossary and no system kind:
    // the sections say what their fill brings rather than standing empty.
    const about = sections.find((block) => block.section === 'about')!;
    expect(about.paragraphs!.length).toBeGreaterThan(0);
    expect(about.paragraphs![0]!.source!.href).toContain('/src?');
    const data = sections.find((block) => block.section === 'data')!;
    expect(data.absent).toBeDefined();
    const reading = sections.find((block) => block.section === 'reading')!;
    expect(reading.links!.map((link) => link.href)).toEqual(expect.arrayContaining(['/', '/docs', '/catalogue', '/problems', '/fill']));
  });

  test('the section titles are in the reader’s language: Russian for a Russian reader', async () => {
    const model = await page('product:shop', 'ru');
    expect(overviews(model).map((block) => block.title)).toEqual([
      'Что это за продукт', 'Как он работает', 'Данные', 'Ключевые термины', 'Где он сейчас', 'С чего начать читать',
    ]);
  });
});
