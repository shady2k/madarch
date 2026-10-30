/**
 * The home page is the one-minute page (madarch-ztyq.7): what the product is, its system map, and the history as one
 * line of totals and the five files that change most, with the whole list of files a click away. The treemap and the
 * relation table are not on it: they live on the pages of what they describe.
 *
 * The bound counts the rows of every block the page holds after its overview, whatever the block is, so a block that
 * comes back to the home page without a bound is caught here rather than in a screenshot.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import type { Block, PageModel } from '../src/knowledge/model.js';
import { generateTrainingRepository, makeProduct, writeSamplePages } from './knowledge-fixture.js';

/** The rows the home page may hold outside the overview: one line of totals and the five files that change most. */
const BOUND_OUTSIDE_THE_OVERVIEW = 6;

/** The files the fixture's own history says change most: the answer key's hotspot. */
const HOTSPOT = 'services/orders/internal/application/order_service.go';

let work: string;
let product: KnowledgeProduct;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'madarch-home-page-'));
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
  await product.close();
  rmSync(work, { recursive: true, force: true });
});

async function page(id: string, lang?: string): Promise<PageModel> {
  const result = await product.page(id, lang);
  if (!result.ok) throw new Error(`no page for ${id}: ${result.message}`);
  return result.page;
}

/** The rows a block puts in front of a reader; a block that draws no rows counts none. */
function rowsOf(block: Block): number {
  if (block.type === 'history') return block.sections.reduce((count, section) => count + section.rows.length, 0);
  if (block.type === 'related') return block.groups.reduce((count, group) => count + group.rows.length, 0);
  if (block.type === 'treemap') return block.files.length;
  return 0;
}

describe('the home page holds the overview and a compact rest (madarch-ztyq.7)', () => {
  test(`at most ${BOUND_OUTSIDE_THE_OVERVIEW} rows stand outside the overview: one line of totals and the five files that change most`, async () => {
    const model = await page('product:shop');
    const overview = model.blocks.findIndex((block) => block.type === 'body');
    expect(overview).toBeGreaterThanOrEqual(0);
    const rest = model.blocks.slice(overview + 1);
    expect(rest.reduce((count, block) => count + rowsOf(block), 0)).toBeLessThanOrEqual(BOUND_OUTSIDE_THE_OVERVIEW);
    const histories = rest.filter((block) => block.type === 'history');
    expect(histories).toHaveLength(1);
    const history = histories[0]!;
    expect(history.sections.map((section) => section.role)).toEqual(['summary', 'hotspots']);
    expect(history.sections[0]!.rows).toHaveLength(1);
    expect(history.sections[1]!.rows).toHaveLength(5);
    expect(history.sections[1]!.rows[0]!.text).toBe(HOTSPOT);
    expect(history.sections[1]!.rows[0]!.figures).toEqual([{ kind: 'commits', value: '28' }]);
    expect(rest.filter((block) => block.type === 'treemap')).toHaveLength(0);
    expect(rest.filter((block) => block.type === 'related')).toHaveLength(0);
  });

  test("the compact history links to the whole list of files, in the reader's language", async () => {
    const en = (await page('product:shop')).blocks.find((block) => block.type === 'history');
    expect(en?.type === 'history' ? en.more : undefined).toEqual({ href: '/k/kind/code.file', label: 'All files' });
    const ru = (await page('product:shop', 'ru')).blocks.find((block) => block.type === 'history');
    expect(ru?.type === 'history' ? ru.more : undefined).toEqual({ href: '/k/kind/code.file', label: 'Все файлы' });
  });
});
