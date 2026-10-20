/**
 * The answers a fill service keeps between publications (madarch-tzte.23.8): the page
 * set, a page model and a diagram answer per product and node, dropped by the
 * publication that changes them.
 *
 * The values here are the task's and decision 0026's: "Every graph node of a
 * page-worthy kind has a live page at once … and updated in the browser as facts
 * arrive" — so a kept answer is the answer the store held when it was read, and no
 * answer outlives the publication that moved a page. The bounds are the cache's own
 * promise: a browsing session costs a bounded amount of memory, never the whole graph.
 */
import { describe, expect, test } from 'bun:test';
import { createPageReadCache, DIAGRAM_CACHE_ENTRIES, PAGE_CACHE_ENTRIES } from '../src/fill/page-cache.js';
import type { GraphPageModelAnswer, GraphPageSetAnswer } from '../src/fill/graph-pages.js';

const PRODUCT = 'Fixture Product';
const OTHER = 'Another Product';
const MODULE = `module:${'1'.repeat(64)}`;
const SYMBOL = `symbol:${'2'.repeat(64)}`;

/** A page set as a read of the store answers it: nothing here is published, so only its identity and moment matter. */
function pageSet(product: string, readAt: number): GraphPageSetAnswer {
  return { product, pages: [], counts: [], total: 0, changeSeq: 7, readAt, message: null };
}

/** One page model, named by its node and the moment it was read at. */
function pageModel(id: string, readAt: number): GraphPageModelAnswer {
  return {
    product: PRODUCT,
    node: { id, kind: 'module', label: 'checkout', page: `/p/graph/${id}`, layer: 'extracted', status: 'proposed' },
    page: `/p/graph/${id}`,
    value: {},
    facts: [],
    assumptions: [],
    relations: { out: [], in: [] },
    coverage: [],
    coverageScopes: [],
    questions: [],
    drafts: [],
    counts: { facts: 0, assumptions: 0, out: 0, in: 0, coverage: 0, questions: 0, drafts: 0 },
    truncated: false,
    marker: null,
    tokens: 0,
    readAt,
  };
}

describe('the answers kept between publications', () => {
  test('a page set and a page model kept are answered as they were read, until a publication drops them', () => {
    const cache = createPageReadCache();
    expect(cache.pageSet(PRODUCT)).toBeUndefined();
    const set = pageSet(PRODUCT, 1_700_000_000_000);
    expect(cache.keepPageSet(PRODUCT, set, cache.generation)).toBe(set);
    expect(cache.pageSet(PRODUCT)).toBe(set);
    const page = pageModel(MODULE, 1_700_000_000_100);
    expect(cache.keepPage(PRODUCT, MODULE, page, cache.generation)).toBe(page);
    expect(cache.page(PRODUCT, MODULE)).toBe(page);
    // A publication landed: nothing kept stands for the store it read.
    cache.drop();
    expect(cache.pageSet(PRODUCT)).toBeUndefined();
    expect(cache.page(PRODUCT, MODULE)).toBeUndefined();
    expect(cache.diagrams(PRODUCT, MODULE)).toBeUndefined();
    expect(cache.kept).toEqual({ products: 0, pages: 0, diagrams: 0 });
  });

  test('one product\'s answers are never another\'s, and the same node id in two products is two entries', () => {
    const cache = createPageReadCache();
    const one = pageModel(MODULE, 1_700_000_000_000);
    cache.keepPage(PRODUCT, MODULE, one, cache.generation);
    expect(cache.page(OTHER, MODULE)).toBeUndefined();
    const two = pageModel(MODULE, 1_700_000_000_001);
    cache.keepPage(OTHER, MODULE, two, cache.generation);
    expect(cache.page(PRODUCT, MODULE)).toBe(one);
    expect(cache.page(OTHER, MODULE)).toBe(two);
    cache.keepPageSet(PRODUCT, pageSet(PRODUCT, 1), cache.generation);
    expect(cache.pageSet(OTHER)).toBeUndefined();
  });

  test('a graph nobody publishes into keeps a bounded number of pages, dropping the oldest first', () => {
    const cache = createPageReadCache({ pages: 2, diagrams: 1 });
    const first = pageModel(MODULE, 1);
    const second = pageModel(SYMBOL, 2);
    const third = pageModel(`symbol:${'3'.repeat(64)}`, 3);
    cache.keepPage(PRODUCT, MODULE, first, cache.generation);
    cache.keepPage(PRODUCT, SYMBOL, second, cache.generation);
    cache.keepPage(PRODUCT, third.node.id, third, cache.generation);
    expect(cache.page(PRODUCT, MODULE)).toBeUndefined();
    expect(cache.page(PRODUCT, SYMBOL)).toBe(second);
    expect(cache.page(PRODUCT, third.node.id)).toBe(third);
    expect(cache.kept.pages).toBe(2);
    // Keeping a key again moves it to the end, so the next eviction takes the other one.
    cache.keepPage(PRODUCT, SYMBOL, second, cache.generation);
    const fourth = pageModel(`symbol:${'4'.repeat(64)}`, 4);
    cache.keepPage(PRODUCT, fourth.node.id, fourth, cache.generation);
    expect(cache.page(PRODUCT, third.node.id)).toBeUndefined();
    expect(cache.page(PRODUCT, SYMBOL)).toBe(second);
    expect(cache.kept.pages).toBe(2);
    // The default bounds are a reading session's window, not the graph: the current madarch tree holds 35 114 pages.
    expect(PAGE_CACHE_ENTRIES).toBeLessThan(35_114);
    expect(DIAGRAM_CACHE_ENTRIES).toBeLessThan(35_114);
  });

  test('a read that started before a publication is never kept after it', () => {
    const cache = createPageReadCache();
    const before = cache.generation;
    const page = pageModel(MODULE, 1_700_000_000_000);
    // The publication lands while the read is in flight: the answer it read is not the store's any more.
    cache.drop();
    cache.keepPage(PRODUCT, MODULE, page, before);
    expect(cache.page(PRODUCT, MODULE)).toBeUndefined();
    // A read that started after the publication is kept as usual.
    cache.keepPage(PRODUCT, MODULE, page, cache.generation);
    expect(cache.page(PRODUCT, MODULE)).toBe(page);
    expect(cache.generation).toBe(before + 1);
  });

  test('a bound that is no whole number is refused by name, never silently un-bounded', () => {
    expect(() => createPageReadCache({ pages: 0 })).toThrow(/pages cache is bounded by 0: a bound is a whole number, one or more/);
    expect(() => createPageReadCache({ diagrams: -1 })).toThrow(/diagrams cache is bounded by -1/);
  });
});
