/**
 * What a product's page reads keep between publications (madarch-tzte.23.8).
 *
 * Decision 0026, "Pages", makes a page something a person watches; this change is the
 * measurement that showed a page of the current madarch tree standing in seconds —
 * the store's own reads of one page's facts, relations and coverage, the page set's
 * scan of every page-worthy fact, and the diagram models built on top of them — and
 * this is the part of the fix that keeps an answer already read.
 *
 * **What makes it correct.** A page, a page set and a diagram answer are functions
 * of the facts the product's units hold, so they change exactly when a publication
 * lands. Decision 0027 makes this process the home's only writer and the live
 * channel's own wake-up is the `unit-published` event, so the cache is dropped by
 * the same publication that wakes the channel: an answer kept here can never be
 * older than the change a client was told about. A publication this process does not
 * make is not announced (0026's own limitation of the channel), and it does not drop
 * this cache either.
 *
 * **Why it is bounded.** A page is read by a person and a fill publishes constantly,
 * so in the steady state the cache is dropped far more often than it is filled; a
 * graph nobody publishes into can still be browsed for hours, though, and a page
 * model of every one of 35 114 pages would be hundreds of megabytes. Each map keeps
 * the most recently kept entries and drops the oldest, so a browsing session costs a
 * bounded amount of memory and a re-read after an eviction is a read of the store,
 * never a wrong answer.
 */
import type { GraphDiagramsRead } from './graph-diagrams.js';
import type { GraphPageModelAnswer, GraphPageSetAnswer } from './graph-pages.js';

/** The most page models one product keeps, and the most diagram answers: a reading session's window, not the graph. */
export const PAGE_CACHE_ENTRIES = 256;
export const DIAGRAM_CACHE_ENTRIES = 32;

// The bounds are small on purpose, and a diagram answer is the reason: building a repository page's five models cost
// 28 708 ms on the current madarch tree (madarch-tzte.23.8), and the process ran out of memory (exit 137) holding a
// few of them beside the store and a browser on a 4 GB pod. A page read again after an eviction is a read of the
// store, never a wrong answer.


/** One product's answers, kept until a publication drops them. */
interface ProductCache {
  pageSet?: GraphPageSetAnswer;
  readonly pages: BoundedMap<GraphPageModelAnswer>;
  readonly diagrams: BoundedMap<GraphDiagramsRead>;
}

/** The cache one fill service keeps: a page set, a page model and a diagram answer per product and node. */
export interface PageReadCache {
  /** The page set kept for a product, when one is kept. */
  pageSet(product: string): GraphPageSetAnswer | undefined;
  keepPageSet(product: string, answer: GraphPageSetAnswer): GraphPageSetAnswer;
  /** The page model kept for one node of a product, when one is kept. */
  page(product: string, id: string): GraphPageModelAnswer | undefined;
  keepPage(product: string, id: string, answer: GraphPageModelAnswer): GraphPageModelAnswer;
  /** The diagrams kept for one node of a product, when they are kept. */
  diagrams(product: string, id: string): GraphDiagramsRead | undefined;
  keepDiagrams(product: string, id: string, answer: GraphDiagramsRead): GraphDiagramsRead;
  /** Drops every answer kept: a publication landed, and nothing kept here stands for the store it read. */
  drop(): void;
  /** What stands kept now, for a test and for a bounded-memory check. */
  readonly kept: { readonly products: number; readonly pages: number; readonly diagrams: number };
}

/**
 * One map keeping at most `bound` entries and dropping the oldest: a Map keeps insertion
 * order, so the first key is the oldest, and re-keeping a key moves it to the end.
 */
class BoundedMap<T> {
  private readonly held = new Map<string, T>();

  constructor(private readonly bound: number) {}

  get(key: string): T | undefined {
    return this.held.get(key);
  }

  set(key: string, value: T): void {
    this.held.delete(key);
    this.held.set(key, value);
    while (this.held.size > this.bound) {
      const oldest = this.held.keys().next();
      if (oldest.done === true) break;
      this.held.delete(oldest.value);
    }
  }

  get size(): number {
    return this.held.size;
  }
}

/** The key one product's node is kept under: a product's name and the node's fact id, which no two products can share. */
function nodeKey(product: string, id: string): string {
  return `${product}\u0000${id}`;
}

/** Builds the cache one fill service keeps, with the bounds a reading session is served within. */
export function createPageReadCache(options: { readonly pages?: number; readonly diagrams?: number } = {}): PageReadCache {
  const pageBound = options.pages ?? PAGE_CACHE_ENTRIES;
  const diagramBound = options.diagrams ?? DIAGRAM_CACHE_ENTRIES;
  for (const [name, bound] of [['pages', pageBound], ['diagrams', diagramBound]] as const) {
    if (!Number.isInteger(bound) || bound < 1) throw new Error(`src/fill/page-cache.ts: the ${name} cache is bounded by ${JSON.stringify(bound)}: a bound is a whole number, one or more`);
  }
  const products = new Map<string, ProductCache>();
  const of = (product: string): ProductCache => {
    const held = products.get(product) ?? { pages: new BoundedMap<GraphPageModelAnswer>(pageBound), diagrams: new BoundedMap<GraphDiagramsRead>(diagramBound) };
    if (products.get(product) === undefined) products.set(product, held);
    return held;
  };
  return {
    pageSet(product: string): GraphPageSetAnswer | undefined {
      return products.get(product)?.pageSet;
    },
    keepPageSet(product: string, answer: GraphPageSetAnswer): GraphPageSetAnswer {
      of(product).pageSet = answer;
      return answer;
    },
    page(product: string, id: string): GraphPageModelAnswer | undefined {
      return products.get(product)?.pages.get(nodeKey(product, id));
    },
    keepPage(product: string, id: string, answer: GraphPageModelAnswer): GraphPageModelAnswer {
      of(product).pages.set(nodeKey(product, id), answer);
      return answer;
    },
    diagrams(product: string, id: string): GraphDiagramsRead | undefined {
      return products.get(product)?.diagrams.get(nodeKey(product, id));
    },
    keepDiagrams(product: string, id: string, answer: GraphDiagramsRead): GraphDiagramsRead {
      of(product).diagrams.set(nodeKey(product, id), answer);
      return answer;
    },
    drop(): void {
      products.clear();
    },
    get kept(): { readonly products: number; readonly pages: number; readonly diagrams: number } {
      let pages = 0;
      let diagrams = 0;
      for (const held of products.values()) {
        pages += held.pages.size;
        diagrams += held.diagrams.size;
      }
      return { products: products.size, pages, diagrams };
    },
  };
}
