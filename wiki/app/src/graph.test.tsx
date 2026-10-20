/**
 * The graph's pages in the app (madarch-tzte.23.3; decision 0026, "Pages"), tested
 * without a server: every request is answered by a stub giving the server's own
 * shapes (the same way `app.test.ts` works), the DOM is happy-dom, and the graph's
 * live channel is a `ReadableStream` the test writes frames into.
 *
 * The bar is the task's DONE WHEN: the navigation lists the graph's page-worthy
 * nodes and a node's page renders the server's page model — facts with links into
 * code, relations as links to other pages, coverage, questions, assumptions apart
 * from the facts, drafts marked — and a page appears and updates as facts arrive,
 * without a reload, when the stream carries the publication that touched it. The
 * document pages keep working beside them.
 */
import { afterEach, afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import { App } from './app.js';
import { GRAPH_EVENTS_PATH, codeHref, graphKindGroups, originOf, shortGraphLabel } from './graph.js';
import { GraphIndexPage, INDEX_ROWS_SHOWN } from './graph-pages.js';
import { addressOfGraphPage, routeOf, GRAPH_INDEX_ADDRESS } from './routes.js';
import { setWikiLanguage } from './i18n.js';
import type { GraphPageModel, GraphPageSet, Page, PageList, Product, RepoEntry, ReposList } from './api.js';

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  await setWikiLanguage('en');
});

afterAll(async () => {
  await new Promise((rest) => setTimeout(rest, 50));
  GlobalRegistrator.unregister();
});

let rendered: { root: Root } | undefined;

function intoApp(element: ReturnType<typeof createElement>): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(element);
  rendered = { root };
}

async function until(holds: () => boolean | undefined, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (holds()) return;
    await new Promise((step) => setTimeout(step, 10));
  }
  throw new Error('the app never came to ' + what + '; the tree holds: ' + document.body.innerHTML);
}

const text = (): string => document.body.textContent ?? '';
const html = (): string => document.body.innerHTML;

function unmount(): void {
  rendered?.root.unmount();
  rendered = undefined;
}

afterEach(() => {
  unmount();
  delete (globalThis as { fetch?: unknown }).fetch;
  window.history.pushState({}, '', '/');
});

const product: Product = { id: 'b7f1', name: 'Draft Idea', folder: 'idea-2026-10-10' };

const documentList: PageList = {
  // A revision of this file's own: `useArchitecture` caches one bundle per revision for
  // the whole test process, and another file's `r1` must not be read as this one's.
  revision: 'graph-r1',
  pages: [
    { path: 'README.md', title: 'README', url: '/p/README.md' },
    { path: 'docs/vision.md', title: 'Vision', url: '/p/docs/vision.md' },
  ],
};

const documents: Record<string, Page> = {
  'docs/vision.md': { path: 'docs/vision.md', title: 'Vision', markdown: '# Vision\n\nThe product’s own words.' },
};

const MODULE = `module:${'a'.repeat(64)}`;
const QUESTION = `question:${'6'.repeat(64)}`;
const OTHER_QUESTION = `question:${'7'.repeat(64)}`;
const SYMBOL = `symbol:${'b'.repeat(64)}`;
const ENDPOINT = `api-endpoint:${'c'.repeat(64)}`;
const FILE = `file:${'d'.repeat(64)}`;
const COMMIT = 'a'.repeat(40);

const repos: ReposList = {
  repos: [
    { name: 'acme-shop', url: 'https://github.com/acme/shop.git', path: 'repos/acme-shop', state: 'cloned' } satisfies RepoEntry,
  ],
};

/** The page set of the fixture: a module, a symbol and an endpoint, in the server's own order, in the four fields a list shows. */
function pageSet(overrides: Partial<GraphPageSet> = {}): GraphPageSet {
  return {
    product: 'Draft Idea',
    pages: [
      { id: MODULE, kind: 'module', label: 'checkout', layer: 'extracted' },
      { id: SYMBOL, kind: 'symbol', label: 'acme-shop:src/checkout.ts#checkout.place', layer: 'extracted' },
      { id: ENDPOINT, kind: 'api-endpoint', label: 'http::POST::/orders/{}', layer: 'extracted' },
    ],
    counts: [
      { kind: 'api-endpoint', count: 1 },
      { kind: 'module', count: 1 },
      { kind: 'symbol', count: 1 },
    ],
    total: 3,
    changeSeq: 41,
    readAt: 1_700_000_000_000,
    message: null,
    questions: {
      groups: [
        {
          type: 'assumption-check',
          questions: [
            {
              id: QUESTION,
              type: 'assumption-check',
              about: MODULE,
              prompt: 'is the total used anywhere?',
              layer: 'inferred',
              status: 'proposed',
              dependsOn: [
                { id: MODULE, kind: 'module', label: 'checkout', page: addressOfGraphPage(MODULE) },
                { id: SYMBOL, kind: 'symbol', label: 'acme-shop:src/checkout.ts#checkout.place', page: addressOfGraphPage(SYMBOL) },
              ],
              rank: 2,
              answer: null,
              open: true,
            },
          ],
        },
        {
          type: 'term',
          questions: [
            {
              id: OTHER_QUESTION,
              type: 'term',
              about: SYMBOL,
              prompt: 'does “placed” mean authorized or captured?',
              layer: 'inferred',
              status: 'proposed',
              dependsOn: [{ id: SYMBOL, kind: 'symbol', label: 'acme-shop:src/checkout.ts#checkout.place', page: addressOfGraphPage(SYMBOL) }],
              rank: 1,
              answer: null,
              open: true,
            },
          ],
        },
      ],
      open: 2,
      answered: 0,
      total: 2,
      truncated: false,
      marker: null,
    },
    nextStep: {
      rule: 'answer-question',
      question: { id: QUESTION, type: 'assumption-check', prompt: 'is the total used anywhere?', rank: 2, page: addressOfGraphPage(QUESTION) },
      target: addressOfGraphPage(QUESTION),
      node: { id: QUESTION, kind: 'question', label: 'is the total used anywhere?' },
      reason: 'the answer changes 2 pages depend on it (assumption-check): answer it, and only those pages are read again',
    },
    ...overrides,
  };
}

/** One node's page model, as the server answers it: facts, assumptions apart, relations both ways, coverage, questions and drafts. */
function modulePage(): GraphPageModel {
  return {
    product: 'Draft Idea',
    node: {
      ...pageSet().pages[0]!,
      page: addressOfGraphPage(MODULE),
      status: 'proposed',
      code: { repository: 'acme-shop', commit: COMMIT, file: 'src/checkout.ts', startLine: 1, endLine: 40 },
      importance: 7,
    },
    page: addressOfGraphPage(MODULE),
    value: { repository: 'acme-shop', name: 'checkout', seed: 'package', importance: 7 },
    facts: [
      {
        id: MODULE,
        kind: 'module',
        label: 'checkout',
        layer: 'extracted',
        status: 'proposed',
        code: { repository: 'acme-shop', commit: COMMIT, file: 'src/checkout.ts', startLine: 1, endLine: 40 },
      },
      {
        id: `claim:${'e'.repeat(64)}`,
        kind: 'claim',
        label: 'the checkout module places an order',
        layer: 'declared',
        status: 'accepted',
        code: { repository: 'acme-shop', commit: COMMIT, file: 'src/checkout.ts', startLine: 12, endLine: 12 },
        ends: {
          subject: { id: MODULE, kind: 'module', label: 'checkout', page: addressOfGraphPage(MODULE) },
          object: { id: SYMBOL, kind: 'symbol', label: 'checkout.place', page: addressOfGraphPage(SYMBOL) },
        },
      },
    ],
    assumptions: [
      {
        id: `rule:${'f'.repeat(64)}`,
        kind: 'rule',
        label: 'an order is placed once',
        layer: 'inferred',
        status: 'proposed',
        code: { repository: 'acme-shop', commit: COMMIT, file: 'src/checkout.ts', startLine: 20, endLine: 20 },
      },
    ],
    relations: {
      out: [
        {
          direction: 'out',
          edge: { id: `contains:${'1'.repeat(64)}`, kind: 'contains', label: 'contains', layer: 'extracted', status: 'proposed', code: { repository: 'acme-shop', commit: COMMIT, file: 'src/checkout.ts', startLine: 1, endLine: 40 } },
          node: { id: SYMBOL, kind: 'symbol', label: 'checkout.place', page: addressOfGraphPage(SYMBOL) },
        },
        {
          direction: 'out',
          edge: { id: `provides:${'2'.repeat(64)}`, kind: 'provides', label: 'provides', layer: 'extracted', status: 'proposed' },
          node: { id: ENDPOINT, kind: 'api-endpoint', label: 'http::POST::/orders/{}', page: addressOfGraphPage(ENDPOINT) },
        },
        {
          direction: 'out',
          edge: { id: `task-key:${'3'.repeat(64)}`, kind: 'task-key', label: 'task-key', layer: 'extracted', status: 'proposed' },
          end: 'MADARCH-12',
        },
      ],
      in: [
        {
          direction: 'in',
          edge: { id: `document-link:${'4'.repeat(64)}`, kind: 'document-link', label: 'document-link', layer: 'extracted', status: 'proposed' },
          node: { id: FILE, kind: 'file', label: 'acme-shop:docs/vision.md' },
        },
      ],
    },
    coverage: [
      {
        id: `coverage:${'5'.repeat(64)}`,
        repository: 'acme-shop',
        scope: MODULE,
        complete: false,
        readCount: 1,
        read: ['src/checkout.ts'],
        readCut: 0,
        unread: [{ what: 'src/refunds.ts', reason: 'budget' }],
        unreadCut: 0,
      },
    ],
    coverageScopes: [MODULE],
    questions: [
      {
        id: QUESTION,
        type: 'assumption-check',
        about: MODULE,
        prompt: 'is the total used anywhere?',
        layer: 'inferred',
        status: 'proposed',
        dependsOn: [
          { id: MODULE, kind: 'module', label: 'checkout', page: addressOfGraphPage(MODULE) },
          { id: SYMBOL, kind: 'symbol', label: 'acme-shop:src/checkout.ts#checkout.place', page: addressOfGraphPage(SYMBOL) },
        ],
        rank: 2,
        answer: null,
        open: true,
      },
    ],
    decision: null,
    answer: null,
    nextStep: {
      rule: 'answer-question',
      question: { id: QUESTION, type: 'assumption-check', prompt: 'is the total used anywhere?', rank: 2, page: addressOfGraphPage(QUESTION) },
      target: addressOfGraphPage(MODULE),
      node: { id: MODULE, kind: 'module', label: 'checkout' },
      reason: 'the answer changes 2 pages depend on it (assumption-check): answer it, and only those pages are read again',
    },
    drafts: [
      {
        asDraft: true,
        unit: 'graph-fixture/src',
        generation: 2,
        scope: 'src',
        write: 'fact',
        evidence: 'acme-shop@' + COMMIT + ':src/checkout.ts',
        fact: { kind: 'module', value: { name: 'checkout' } },
      },
    ],
    counts: { facts: 2, assumptions: 1, out: 3, in: 1, coverage: 1, questions: 1, drafts: 1 },
    truncated: false,
    marker: null,
    tokens: 512,
    readAt: 1_700_000_000_000,
  };
}

type Blade = { body: unknown; status?: number };

/** The answers a stub gives: the wiki's own shapes, the graph's, and the scripted stream. */
type World = {
  set: GraphPageSet;
  pages: Record<string, GraphPageModel>;
  /** Whether the server answers graph pages at all (an older server, or one that holds no fill's graph). */
  graph: boolean;
  documents: Record<string, Page>;
  /** The repositories the manifest declares, as `/api/repos` answers them. */
  repos?: ReposList;
  /** How many page-set reads fail with a 500 before the server answers: a transient failure at load. */
  failures?: number;
};

function answer(world: World, target: string): Blade | 'stream' {
  if (target === '/api/product') return { body: product };
  if (target === '/api/pages') return { body: documentList };
  if (target === '/api/questions') return { body: { questions: [], openCount: 0 } };
  if (target === '/api/registry') return { body: { present: false } };
  if (target === '/api/repos') return { body: world.repos ?? repos };
  if (target === '/api/architecture') return { body: { notes: [], errors: [], warnings: [], sources: [] } };
  if (target.startsWith(GRAPH_EVENTS_PATH)) return 'stream';
  if (target.startsWith('/api/graph/pages')) {
    if (!world.graph) return { body: { message: 'no such path "/api/graph/pages"' }, status: 404 };
    if ((world.failures ?? 0) > 0) {
      world.failures = (world.failures ?? 0) - 1;
      return { body: { message: 'the store is busy' }, status: 500 };
    }
    return { body: world.set };
  }
  if (target.startsWith('/api/graph/page?')) {
    const id = new URL('http://x' + target).searchParams.get('id') ?? '';
    const page = world.pages[id];
    if (page === undefined) {
      return { body: { message: `the graph holds no page of the id ${id}`, error: { field: 'id', code: 'graph-pages/no-such-node' } }, status: 404 };
    }
    return { body: page };
  }
  if (target.startsWith('/api/page?')) {
    const path = new URL('http://x' + target).searchParams.get('path') ?? '';
    const page = world.documents[path];
    if (page === undefined) return { body: { message: 'the wiki does not hold ' + path }, status: 404 };
    return { body: page };
  }
  if (target === '/api/graph/answer') return { body: { file: `answers/${'6'.repeat(64)}.md`, pages: [MODULE, QUESTION] } };
  if (target === '/api/graph/decide') return { body: { file: `acceptances/${'8'.repeat(64)}.md`, pages: [MODULE] } };
  if (target.startsWith('/api/discussions')) return { body: { discussions: [] } };
  return { body: { message: 'the server does not answer ' + target }, status: 404 };
}

/** Installs the stub; `push` writes one frame into the graph's live channel. */
function install(world: World): { calls: string[]; push: (frame: string) => void; world: World } {
  const calls: string[] = [];
  let pushInside: ((frame: string) => void) | undefined;
  const stub = async (input: RequestInfo | URL): Promise<Response> => {
    const target = input instanceof URL ? input.pathname + input.search : String(input);
    calls.push(target);
    const blade = answer(world, target);
    if (blade === 'stream') {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('retry: 3000\n\n'));
          pushInside = (frame: string): void => controller.enqueue(encoder.encode(frame));
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
    }
    return new Response(JSON.stringify(blade.body), { status: blade.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  (globalThis as { fetch: typeof fetch }).fetch = stub as unknown as typeof fetch;
  return { calls, push: (frame) => pushInside?.(frame), world };
}

/** One `pages` event frame, as the server writes it. */
function pagesFrame(change: { seq: number; nodes: string[]; unit: string; generation: number }): string {
  return `id: ${change.seq}\nevent: pages\ndata: ${JSON.stringify({ ...change, publication: 'p-' + change.seq })}\n\n`;
}

function world(overrides: Partial<World> = {}): World {
  return { set: pageSet(), pages: { [MODULE]: modulePage() }, graph: true, documents, ...overrides };
}

describe('the graph in the navigation', () => {
  test('lists every page-worthy node by kind, each a link to its page', async () => {
    install(world());
    window.history.pushState({}, '', '/');
    intoApp(createElement(App, { reconnectMs: 5 }));
    await until(() => document.querySelector('[data-testid="graph-nav"]') !== null, 'the graph section of the navigation');
    const nav = document.querySelector('[data-testid="graph-nav"]');
    const kinds = [...(nav?.querySelectorAll('[data-graph-nav-kind]') ?? [])].map((group) => group.getAttribute('data-graph-nav-kind'));
    expect(kinds).toEqual(['api-endpoint', 'module', 'symbol']);
    // The addresses the server hands out, written out: `pageAddress` is `/p/graph/` plus
    // the node's fact id, so a reader who copies a link gets the address the page set named.
    const links = [...(nav?.querySelectorAll('a[data-graph-node]') ?? [])].map((link) => link.getAttribute('href'));
    expect(links).toEqual([`/p/graph/${ENDPOINT}`, `/p/graph/${MODULE}`, `/p/graph/${SYMBOL}`]);
    expect(nav?.textContent).toContain('Modules');
    expect(nav?.textContent).toContain('checkout');
  });

  test('an empty graph shows the server’s what-to-do message on its index page, never an error and never an empty sidebar section', async () => {
    const empty = world();
    empty.set = pageSet({ pages: [], counts: [], total: 0, message: 'the fill has published no page-worthy node for the product "Draft Idea" yet' });
    install(empty);
    window.history.pushState({}, '', '/');
    intoApp(createElement(App, { reconnectMs: 5 }));
    await until(() => document.querySelector('[data-testid="home-graph"]') !== null, 'the home page’s graph entry');
    // No node has a page, so the navigation holds no graph section: an empty section
    // in every product's sidebar would be noise.
    expect(document.querySelector('[data-testid="graph-nav"]')).toBeNull();
    // The entry to the index carries the zero, and the index names what to do.
    expect(document.querySelector('[data-testid="graph-count"]')?.textContent).toBe('0');
    unmount();
    window.history.pushState({}, '', GRAPH_INDEX_ADDRESS);
    intoApp(createElement(App, { reconnectMs: 5 }));
    await until(() => document.querySelector('[data-testid="graph-empty"]') !== null, 'the empty graph message');
    expect(document.querySelector('[data-testid="graph-empty"]')?.textContent).toContain('the fill has published no page-worthy node');
    expect(document.querySelector('p.error')).toBeNull();
  });

  test('a server that answers no graph shows no graph section, and the document pages keep working', async () => {
    const bare = world();
    bare.graph = false;
    install(bare);
    window.history.pushState({}, '', '/p/docs/vision.md');
    intoApp(createElement(App, { reconnectMs: 5 }));
    await until(() => document.querySelector('main .reading > h1')?.textContent === 'Vision', 'the document page');
    expect(document.querySelector('[data-testid="graph-nav"]')).toBeNull();
    expect(document.querySelector('[data-testid="home-graph"]')).toBeNull();
    expect(text()).toContain('The product’s own words.');
  });

  test('the document pages stand beside the graph pages: a document opens while the graph section holds nodes', async () => {
    install(world());
    window.history.pushState({}, '', '/p/docs/vision.md');
    intoApp(createElement(App, { reconnectMs: 5 }));
    await until(() => document.querySelector('main .reading > h1')?.textContent === 'Vision', 'the document page');
    expect(document.querySelector('[data-testid="graph-nav"]')).not.toBeNull();
    expect(document.querySelector('main#page')).not.toBeNull();
    expect(text()).toContain('The product’s own words.');
  });

  test('the graph’s index lists every node by kind with its count', async () => {
    install(world());
    window.history.pushState({}, '', GRAPH_INDEX_ADDRESS);
    intoApp(createElement(App, { reconnectMs: 5 }));
    await until(() => document.querySelector('[data-testid="graph-index"]') !== null, 'the graph index');
    const kinds = [...document.querySelectorAll('[data-graph-kind]')].map((group) => group.getAttribute('data-graph-kind'));
    expect(kinds).toEqual(['api-endpoint', 'module', 'symbol']);
    const counts = [...document.querySelectorAll('[data-testid="graph-kind-count"]')].map((entry) => entry.textContent);
    expect(counts).toEqual(['1', '1', '1']);
    expect(document.querySelector(`a[href="/p/graph/${MODULE}"]`)).not.toBeNull();
  });

  test('a kind of more nodes than the page draws is listed up to the page\'s bound, and the group says how many the kind holds', async () => {
    // The current madarch tree holds 29 605 symbols: the index draws the first of a kind's rows and names the rest by
    // their count, because drawing tens of thousands of rows is seconds of the browser's time (madarch-tzte.23.8).
    const many = 9;
    const symbols = Array.from({ length: many }, (_unused, index) => {
      const id = `symbol:${index.toString(16).padStart(64, '0')}`;
      return { id, kind: 'symbol', label: `acme-shop:src/checkout.ts#checkout.place${String(index).padStart(3, '0')}`, layer: 'extracted' as const };
    });
    const set = pageSet({ pages: [pageSet().pages[0]!, ...symbols], counts: [{ kind: 'module', count: 1 }, { kind: 'symbol', count: many }], total: many + 1 });
    intoApp(createElement(GraphIndexPage, { set, repos: [], rowsShown: 4 }));
    await until(() => document.querySelector('[data-testid="graph-index"]') !== null, 'the graph index');
    const symbolGroup = (): Element | null => document.querySelector('[data-graph-kind="symbol"]');
    // The first four of the kind stand, the group counts all nine, and its own line says how many stand.
    expect(symbolGroup()?.querySelectorAll('.home-row').length).toBe(4);
    expect(symbolGroup()?.querySelector('[data-testid="graph-kind-count"]')?.textContent).toBe(String(many));
    const listing = symbolGroup()?.querySelector('[data-testid="graph-kind-listing"]');
    expect(listing?.getAttribute('data-shown')).toBe('4');
    expect(listing?.textContent).toBe(`4 of ${many} listed: this index draws the first 4 of this kind, and the graph holds ${many}.`);
    // The rows it draws are the server's own order, from the first.
    const labels = [...(symbolGroup()?.querySelectorAll('.home-row-title') ?? [])].map((row) => row.textContent);
    expect(labels).toEqual(symbols.slice(0, 4).map((entry) => entry.label));
    // A kind the bound draws whole says nothing, and the page's own bound is a slice of a graph this size.
    expect(document.querySelector('[data-graph-kind="module"] [data-testid="graph-kind-listing"]')).toBeNull();
    expect(INDEX_ROWS_SHOWN).toBeLessThan(35_114);
  });
});

describe('one node’s page', () => {
  test('renders the server’s page model: facts with code links, assumptions apart, relations as links, coverage, questions and drafts marked', async () => {
    install(world());
    window.history.pushState({}, '', addressOfGraphPage(MODULE));
    intoApp(createElement(App, { reconnectMs: 5 }));
    await until(() => document.querySelector('[data-testid="graph-node"]') !== null, 'the node page');

    // The node's own name and kind head the page.
    expect(document.querySelector('main#graph-node h1')?.textContent).toBe('checkout');
    expect(text()).toContain('Modules');

    // A fact's code link opens the repository's own page at the pinned commit and the lines it spans.
    // Each of the facts' own links opens its repository's page at the pinned commit and
    // the lines it spans: the address the wiki's document links keep (`hostFileUrl`).
    const factLinks = [...document.querySelectorAll('[data-testid="graph-facts"] [data-fact] [data-testid="graph-place"]')]
      .map((place) => place.getAttribute('href'));
    expect(factLinks).toEqual([
      `https://github.com/acme/shop/blob/${COMMIT}/src/checkout.ts#L1-L40`,
      `https://github.com/acme/shop/blob/${COMMIT}/src/checkout.ts#L12`,
    ]);
    // Every place the facts name is a link here: the manifest declares this repository's
    // origin. A repository it does not declare links nothing — held by the test below.

    // The facts section holds the asserted facts; the assumption stands in its own section.
    const facts = [...document.querySelectorAll('[data-testid="graph-facts"] [data-fact]')];
    expect(facts.map((row) => row.getAttribute('data-layer'))).toEqual(['extracted', 'declared']);
    const assumptions = [...document.querySelectorAll('[data-testid="graph-assumptions"] [data-fact]')];
    expect(assumptions.map((row) => row.getAttribute('data-layer'))).toEqual(['inferred']);
    // Nothing inferred leaks into the facts list, and nothing asserted into the assumptions.
    expect(document.querySelector('[data-testid="graph-facts"] [data-layer="inferred"]')).toBeNull();

    // A relation to another node is a link to that node's page.
    const out = [...document.querySelectorAll('[data-testid="graph-relations-out"] [data-edge]')];
    expect(out.length).toBe(3);
    expect(out[0]?.querySelector('a')?.getAttribute('href')).toBe(`/p/graph/${SYMBOL}`);
    expect(out[1]?.querySelector('a')?.getAttribute('href')).toBe(`/p/graph/${ENDPOINT}`);
    // An end that is no node is text: it links nothing.
    expect(out[2]?.querySelector('[data-testid="graph-relation-end"]')?.textContent).toBe('MADARCH-12');
    expect(out[2]?.querySelector('a')).toBeNull();
    // A node of a kind with no page is named and links nothing.
    const into = [...document.querySelectorAll('[data-testid="graph-relations-in"] [data-edge]')];
    expect(into[0]?.querySelector('[data-testid="graph-relation-unpaged"]')?.textContent).toBe('acme-shop:docs/vision.md');

    // The claim's own ends open the pages of the nodes they name.
    expect(document.querySelector('[data-testid="graph-claim-object"] a')?.getAttribute('href')).toBe(`/p/graph/${SYMBOL}`);

    // The coverage names the scope, its gap and that it is not whole.
    const coverage = document.querySelector('[data-testid="graph-coverage"] [data-scope]');
    expect(coverage?.getAttribute('data-scope')).toBe(MODULE);
    expect(coverage?.getAttribute('data-complete')).toBe('false');
    expect(text()).toContain('src/refunds.ts');

    // The question, in the reader's words.
    expect(document.querySelector('[data-testid="graph-questions"]')?.textContent).toContain('is the total used anywhere?');

    // The draft is marked as a draft and names the unit that holds it.
    const draft = document.querySelector('[data-testid="graph-drafts"] [data-unit]');
    expect(draft?.getAttribute('data-unit')).toBe('graph-fixture/src');
    expect(draft?.querySelector('[data-testid="graph-draft-mark"]')?.textContent).toBe('draft');
    expect(draft?.textContent).toContain('generation 2');

    // The diagrams' slot stands on the page, named and not drawn.
    expect(document.querySelector('[data-testid="graph-diagrams"]')).not.toBeNull();
  });

  test('a place in a repository the manifest does not declare is text and links nothing', async () => {
    const live = world();
    live.repos = { repos: [] };
    install(live);
    window.history.pushState({}, '', addressOfGraphPage(MODULE));
    intoApp(createElement(App, { reconnectMs: 5 }));
    await until(() => document.querySelector('[data-testid="graph-node"]') !== null, 'the node page');
    const places = [...document.querySelectorAll('[data-testid="graph-place"]')];
    expect(places.length).toBeGreaterThan(0);
    for (const place of places) expect(place.getAttribute('href')).toBeNull();
    expect(places[0]?.textContent).toContain('acme-shop · src/checkout.ts:1-40');
  });

  test('a page the graph no longer holds is its refusal’s own words, never an empty page', async () => {
    install(world());
    window.history.pushState({}, '', addressOfGraphPage(SYMBOL));
    intoApp(createElement(App, { reconnectMs: 5 }));
    await until(() => document.querySelector('[data-testid="graph-node-missing"]') !== null, 'the refusal');
    expect(text()).toContain(`the graph holds no page of the id ${SYMBOL}`);
    expect(document.querySelector('[data-testid="graph-node"]')).toBeNull();
  });

  test('the Russian chrome names the page in Russian, and the facts keep their own words', async () => {
    install(world());
    window.history.pushState({}, '', addressOfGraphPage(MODULE));
    intoApp(createElement(App, { reconnectMs: 5 }));
    await until(() => document.querySelector('[data-testid="graph-node"]') !== null, 'the node page');
    try {
      await setWikiLanguage('ru');
      await until(() => document.querySelector('[data-testid="graph-facts"] h2')?.textContent?.includes('факт'), 'the Russian facts heading');
      expect(document.querySelector('[data-testid="graph-assumptions"] h2')?.textContent).toContain('предположен');
      // The assumption's own layer word, inside the assumptions list.
      expect(document.querySelector('[data-testid="graph-assumptions"] [data-fact] [data-testid="graph-fact-layer"]')?.textContent).toBe('выведено');
    } finally {
      await setWikiLanguage('en');
    }
  });
});

describe('a page set read that fails first', () => {
  test('a transient failure at load is retried, and the graph opens and stays live once the set answers', async () => {
    // A store that is busy for two reads and answers the third: the app must not treat a
    // transient failure as a server without a graph, and must open the channel when the
    // retried read succeeds — a section that appears and never updates would be worse than
    // no section at all.
    const live = world();
    live.failures = 2;
    const installed = install(live);
    window.history.pushState({}, '', '/');
    intoApp(createElement(App, { reconnectMs: 5 }));
    await until(() => document.querySelector('[data-testid="graph-nav"]') !== null, 'the graph after the retries');
    // Two failures and the third read answers: two retries, three reads in all.
    expect(installed.calls.filter((call) => call.startsWith('/api/graph/pages')).length).toBe(3);
    // The channel is opened from the change number of the set that finally answered.
    await until(() => installed.calls.some((call) => call === `${GRAPH_EVENTS_PATH}?after=41`), 'the channel opened after the retry');

    // And it is live: a publication moves the navigation.
    live.set = pageSet({ changeSeq: 42, pages: [live.set.pages[1]!, live.set.pages[2]!], counts: [{ kind: 'api-endpoint', count: 1 }, { kind: 'symbol', count: 1 }], total: 2 });
    installed.push(pagesFrame({ seq: 42, nodes: [SYMBOL], unit: 'graph-fixture/src', generation: 2 }));
    await until(() => document.querySelector('[data-testid="graph-nav"] [data-graph-nav-kind="module"]') === null, 'the navigation after the publication');
  }, 20_000);

  test('a server that answers no page set (404) shows no graph and opens no channel', async () => {
    const bare = world();
    bare.graph = false;
    const installed = install(bare);
    window.history.pushState({}, '', '/');
    intoApp(createElement(App, { reconnectMs: 5 }));
    await until(() => document.querySelector('main#home') !== null, 'the home page');
    await new Promise((step) => setTimeout(step, 120));
    expect(document.querySelector('[data-testid="graph-nav"]')).toBeNull();
    expect(installed.calls.filter((call) => call.startsWith(GRAPH_EVENTS_PATH)).length).toBe(0);
    expect(installed.calls.filter((call) => call.startsWith('/api/graph/pages')).length).toBe(1);
  });
});

describe('the page set the app asks for', () => {
  test('the navigation and the index ask for the list\'s fields: one request, and the whole set\'s code places and ranks are not carried', async () => {
    const installed = install(world());
    window.history.pushState({}, '', GRAPH_INDEX_ADDRESS);
    intoApp(createElement(App, { reconnectMs: 5 }));
    await until(() => document.querySelector('[data-testid="graph-index"]') !== null, 'the graph index');
    // One read for the tab's load, and it names the fields a list shows (madarch-tzte.23.8).
    expect(installed.calls.filter((call) => call.startsWith('/api/graph/pages'))).toEqual(['/api/graph/pages?fields=nav']);
    // The list drops two fields, never a node: every page of the set still stands on the index,
    // and each row opens the node's own address, which the app builds from the id.
    const rows = [...document.querySelectorAll('[data-testid="graph-index"] .home-row')].map((row) => row.getAttribute('href'));
    expect(rows).toEqual([addressOfGraphPage(ENDPOINT), addressOfGraphPage(MODULE), addressOfGraphPage(SYMBOL)]);
  });
});

describe('the live channel', () => {
  test('a publication makes a node’s page appear in the navigation and on the graph’s index without a reload', async () => {
    const live = world();
    live.set = pageSet({ pages: [live.set.pages[2]!], counts: [{ kind: 'api-endpoint', count: 1 }], total: 1 });
    const installed = install(live);
    window.history.pushState({}, '', GRAPH_INDEX_ADDRESS);
    intoApp(createElement(App, { reconnectMs: 5 }));
    await until(() => document.querySelector('[data-testid="graph-index"]') !== null, 'the graph index');
    expect(document.querySelectorAll('[data-graph-kind]').length).toBe(1);
    // The stream is asked from the set's own change number: nothing between the read and the subscription is lost.
    expect(installed.calls).toContain(`${GRAPH_EVENTS_PATH}?after=41`);

    // A publication adds the module: the server's answers move, and the channel says which pages it touched.
    live.set = pageSet({ changeSeq: 42 });
    live.pages[MODULE] = modulePage();
    const started = Date.now();
    installed.push(pagesFrame({ seq: 42, nodes: [MODULE, SYMBOL], unit: 'graph-fixture/src', generation: 2 }));
    await until(() => document.querySelectorAll('[data-graph-kind]').length === 3, 'the module’s kind in the index');
    expect(Date.now() - started).toBeLessThanOrEqual(2000);
    expect(document.querySelector(`a[href="/p/graph/${MODULE}"]`)).not.toBeNull();
    // The navigation holds the new node too.
    expect(document.querySelector(`[data-testid="graph-nav"] a[data-graph-node="${MODULE}"]`)).not.toBeNull();
    // The update was no reload: the same document still holds the page, and one stream served it.
    expect(document.querySelector('[data-testid="graph-index"]')).not.toBeNull();
    expect(installed.calls.filter((call) => call.startsWith(GRAPH_EVENTS_PATH)).length).toBe(1);
  }, 20_000);

  test('an open node page updates as facts arrive, without a reload, and only when the publication names it', async () => {
    const live = world();
    const installed = install(live);
    window.history.pushState({}, '', addressOfGraphPage(MODULE));
    intoApp(createElement(App, { reconnectMs: 5 }));
    await until(() => document.querySelector('[data-testid="graph-node"]') !== null, 'the node page');
    expect(document.querySelectorAll('[data-testid="graph-facts"] [data-fact]').length).toBe(2);
    const readsBefore = installed.calls.filter((call) => call.startsWith('/api/graph/page?')).length;

    // A publication that touches another page only: this page is not asked for again.
    live.set = pageSet({ changeSeq: 42 });
    installed.push(pagesFrame({ seq: 42, nodes: [SYMBOL], unit: 'graph-fixture/src', generation: 2 }));
    await until(() => installed.calls.filter((call) => call.startsWith('/api/graph/pages')).length === 2, 'the set read for the publication');
    await new Promise((step) => setTimeout(step, 120));
    expect(installed.calls.filter((call) => call.startsWith('/api/graph/page?')).length).toBe(readsBefore);

    // A publication that names this page: the page is read again and the new fact shows.
    const grown = modulePage();
    grown.facts = [
      ...grown.facts,
      {
        id: `claim:${'9'.repeat(64)}`,
        kind: 'claim',
        label: 'the checkout module reads the environment',
        layer: 'declared',
        status: 'accepted',
      },
    ];
    grown.counts = { ...grown.counts, facts: 3 };
    live.pages[MODULE] = grown;
    live.set = pageSet({ changeSeq: 43 });
    const started = Date.now();
    installed.push(pagesFrame({ seq: 43, nodes: [MODULE], unit: 'graph-fixture/src', generation: 2 }));
    await until(() => text().includes('the checkout module reads the environment'), 'the new fact');
    expect(Date.now() - started).toBeLessThanOrEqual(2000);
    // The page was read again, and the address in the browser never changed: no reload.
    expect(installed.calls.filter((call) => call.startsWith('/api/graph/page?')).length).toBe(readsBefore + 1);
    expect(window.location.pathname).toBe(`/p/graph/${MODULE}`);
    expect(installed.calls.filter((call) => call.startsWith(GRAPH_EVENTS_PATH)).length).toBe(1);
  }, 20_000);

  test('a burst of publications in one read leaves the open page at its own latest one', async () => {
    // A read of the channel answers every change since the last one in one flush, so two
    // publications reach the app as two events in one task. A page must see the one that
    // named it, whichever of them the render kept.
    const live = world();
    const installed = install(live);
    window.history.pushState({}, '', addressOfGraphPage(MODULE));
    intoApp(createElement(App, { reconnectMs: 5 }));
    await until(() => document.querySelector('[data-testid="graph-node"]') !== null, 'the node page');
    const readsBefore = installed.calls.filter((call) => call.startsWith('/api/graph/page?')).length;

    // The first publication of the burst names this page; the second names another.
    const grown = modulePage();
    grown.facts = [...grown.facts, { id: `claim:${'8'.repeat(64)}`, kind: 'claim', label: 'a fact the burst brought', layer: 'declared', status: 'accepted' }];
    grown.counts = { ...grown.counts, facts: 3 };
    live.pages[MODULE] = grown;
    live.set = pageSet({ changeSeq: 45 });
    installed.push(pagesFrame({ seq: 44, nodes: [MODULE], unit: 'graph-fixture/src', generation: 4 }) + pagesFrame({ seq: 45, nodes: [SYMBOL], unit: 'graph-fixture/src', generation: 4 }));
    await until(() => text().includes('a fact the burst brought'), 'the fact of the burst’s first event');
    expect(installed.calls.filter((call) => call.startsWith('/api/graph/page?')).length).toBeGreaterThan(readsBefore);
  }, 20_000);

  test('a publication that drops a node’s page shows the refusal on the open page', async () => {
    const live = world();
    const installed = install(live);
    window.history.pushState({}, '', addressOfGraphPage(MODULE));
    intoApp(createElement(App, { reconnectMs: 5 }));
    await until(() => document.querySelector('[data-testid="graph-node"]') !== null, 'the node page');
    delete live.pages[MODULE];
    live.set = pageSet({ changeSeq: 44, pages: [live.set.pages[1]!, live.set.pages[2]!], counts: [{ kind: 'api-endpoint', count: 1 }, { kind: 'symbol', count: 1 }], total: 2 });
    installed.push(pagesFrame({ seq: 44, nodes: [MODULE], unit: 'graph-fixture/src', generation: 3 }));
    await until(() => document.querySelector('[data-testid="graph-node-missing"]') !== null, 'the refusal after the drop');
    expect(document.querySelector('[data-testid="graph-node"]')).toBeNull();
  }, 20_000);
});

describe('the graph’s rules', () => {
  test('a node’s page is the address the server hands out, and only a fact id is read as one', () => {
    expect(addressOfGraphPage(MODULE)).toBe(`/p/graph/${MODULE}`);
    expect(routeOf(`/p/graph/${MODULE}`)).toEqual({ name: 'graph', id: MODULE });
    // The graph's index is the address madarch-tzte.23.2's diagram links already use
    // (`/p/graph?diagram=…`): a drill-down opens the graph, not a document named `graph`.
    expect(GRAPH_INDEX_ADDRESS).toBe('/p/graph');
    expect(routeOf('/p/graph')).toEqual({ name: 'graphIndex' });
    // A document whose path begins with `graph/` stays a document.
    expect(routeOf('/p/graph/notes.md')).toEqual({ name: 'page', path: 'graph/notes.md' });
  });

  test('a repository origin is read the way the wiki reads it, and anything else links nothing', () => {
    expect(originOf('https://github.com/acme/shop.git')).toEqual({ kind: 'github', owner: 'acme', repo: 'shop' });
    expect(originOf('git@gitlab.com:acme/sub/project.git')).toEqual({ kind: 'gitlab', owner: 'acme/sub', repo: 'project' });
    expect(originOf('https://example.com/acme/shop.git')).toBeUndefined();
    expect(originOf('file:///tmp/shop')).toBeUndefined();
    expect(originOf(undefined)).toBeUndefined();
    const link = { repository: 'acme-shop', commit: COMMIT, file: 'src/a b.ts', startLine: 3, endLine: 9 };
    expect(codeHref(link, repos.repos)).toBe(`https://github.com/acme/shop/blob/${COMMIT}/src/a%20b.ts#L3-L9`);
    // GitLab keeps its objects under `/-/blob/`, as the wiki's own document links do.
    const gitlab: RepoEntry[] = [{ name: 'acme-shop', url: 'git@gitlab.com:acme/shop.git', path: 'repos/acme-shop', state: 'cloned' }];
    expect(codeHref(link, gitlab)).toBe(`https://gitlab.com/acme/shop/-/blob/${COMMIT}/src/a%20b.ts#L3-L9`);
    expect(codeHref(link, [])).toBeUndefined();
  });

  test('the page set is grouped by kind in code point order, keeping the server’s order inside a kind', () => {
    const set = pageSet();
    // Two symbols, in the order the server answered them (code point of the label, then of
    // the id): the grouping never reorders a kind's own list.
    const second = `symbol:${'0'.repeat(64)}`;
    set.pages = [...set.pages, { id: second, kind: 'symbol', label: 'acme-shop:src/checkout.ts#checkout.total', layer: 'extracted' }];
    const groups = graphKindGroups(set);
    expect(groups.map((group) => group.kind)).toEqual(['api-endpoint', 'module', 'symbol']);
    expect(groups[2]?.entries.map((entry) => entry.id)).toEqual([SYMBOL, second]);
    expect(groups[1]?.entries.map((entry) => entry.id)).toEqual([MODULE]);
    expect(graphKindGroups(null)).toEqual([]);
  });
});

describe('the graph’s navigation labels (madarch-tzte.23.4)', () => {
  test('a symbol reads by its own name, and a package, a deploy unit, a table and a column by the name after their repository', () => {
    expect(shortGraphLabel({ kind: 'symbol', label: 'acme-shop:src/checkout.ts#checkout.place' })).toBe('checkout.place');
    expect(shortGraphLabel({ kind: 'symbol', label: 'acme-shop:src/checkout.ts#CheckoutController.place' })).toBe('CheckoutController.place');
    expect(shortGraphLabel({ kind: 'package', label: 'acme-shop:@acme/checkout' })).toBe('@acme/checkout');
    expect(shortGraphLabel({ kind: 'table', label: 'acme-shop:public.orders' })).toBe('public.orders');
    expect(shortGraphLabel({ kind: 'column', label: 'acme-shop:public.orders.id' })).toBe('public.orders.id');
    // A name that carries no repository prefix keeps itself whole: an endpoint's contract, a module's name.
    expect(shortGraphLabel({ kind: 'module', label: 'checkout' })).toBe('checkout');
    expect(shortGraphLabel({ kind: 'api-endpoint', label: 'http::POST::/orders/{}' })).toBe('http::POST::/orders/{}');
  });

  test('the sidebar shows the short name and keeps the whole label as its tooltip', async () => {
    install(world());
    window.history.pushState({}, '', '/');
    intoApp(createElement(App, { reconnectMs: 5 }));
    await until(() => document.querySelector(`[data-testid="graph-nav"] a[data-graph-node="${SYMBOL}"]`) !== null, 'the symbol’s navigation row');
    const row = document.querySelector(`[data-testid="graph-nav"] a[data-graph-node="${SYMBOL}"]`)!;
    expect(row.getAttribute('title')).toBe('acme-shop:src/checkout.ts#checkout.place');
    expect(row.querySelector('[data-testid="graph-nav-label"]')?.textContent).toBe('checkout.place');
  });
});

describe('open questions, answers and the next step on the graph pages', () => {
  test('every page shows the step the server decided, and the index groups the product\'s questions by the charter\'s types', async () => {
    install(world());
    window.history.pushState({}, '', GRAPH_INDEX_ADDRESS);
    intoApp(createElement(App, { reconnectMs: 5 }));
    await until(() => document.querySelector('[data-testid="graph-index"]') !== null, 'the graph index');
    await until(() => document.querySelector('[data-testid="graph-next-step"]') !== null, 'the index\'s next step');
    // The product\'s own step: its most asked open question, and the page the step opens is the question\'s own page.
    const step = document.querySelector('[data-testid="graph-next-step"]')!;
    expect(step.getAttribute('data-rule')).toBe('answer-question');
    expect(step.querySelector('[data-testid="graph-next-step-action"]')?.textContent).toContain('is the total used anywhere?');
    const opened = step.querySelector('a')?.getAttribute('href');
    expect(opened).toBe(`/p/graph/${QUESTION}`);
    // The questions come grouped by the charter\'s types, in the charter\'s order, each naming what depends on it.
    const groups = [...document.querySelectorAll('[data-testid="graph-question-group"]')].map((group) => group.getAttribute('data-question-type'));
    expect(groups).toEqual(['assumption-check', 'term']);
    const first = document.querySelector('[data-testid="graph-question-group"]')!;
    expect(first.textContent).toContain('is the total used anywhere?');
    expect(first.querySelector('[data-testid="graph-question-rank"]')?.textContent).toContain('2');
    const depends = first.querySelector('[data-testid="graph-question-depends"]');
    expect(depends?.textContent).toContain('checkout');
    expect([...(depends?.querySelectorAll('a') ?? [])].map((link) => link.getAttribute('href'))).toEqual([`/p/graph/${MODULE}`, `/p/graph/${SYMBOL}`]);
  });

  test('a node\'s page shows its own step, its question\'s rank, and the form that answers it', async () => {
    install(world());
    window.history.pushState({}, '', addressOfGraphPage(MODULE));
    intoApp(createElement(App, { reconnectMs: 5 }));
    await until(() => document.querySelector('[data-testid="graph-node"]') !== null, 'the module\'s page');
    await until(() => document.querySelector('[data-testid="graph-next-step"]') !== null, 'the page\'s next step');
    expect(document.querySelector('[data-testid="graph-next-step"]')?.getAttribute('data-rule')).toBe('answer-question');
    // The question stands under the page with what depends on the answer, and the person answers it where it stands.
    expect(document.querySelector('[data-testid="graph-question-rank"]')?.textContent).toContain('2');
    expect(document.querySelector('[data-testid="graph-answer-form"]')).not.toBeNull();
    // The page proposes facts no person accepted, so it also asks for that decision.
    expect(document.querySelector('[data-testid="graph-decision"]')).not.toBeNull();
  });

  test('an answer typed on a page is posted to the graph, which files it in the product\'s git', async () => {
    const installed = install(world());
    window.history.pushState({}, '', addressOfGraphPage(MODULE));
    intoApp(createElement(App, { reconnectMs: 5 }));
    await until(() => document.querySelector('[data-testid="graph-answer-form"]') !== null, 'the answer form');
    const form = document.querySelector('[data-testid="graph-answer-form"]') as HTMLFormElement;
    const [answerField, byField] = [...form.querySelectorAll('textarea, input')] as (HTMLTextAreaElement | HTMLInputElement)[];
    answerField!.value = 'The total is used by the receipt.';
    answerField!.dispatchEvent(new Event('input', { bubbles: true }));
    byField!.value = 'the owner';
    byField!.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await until(() => document.querySelector('[data-testid="graph-question-filed"]') !== null, 'the answer filed');
    expect(document.querySelector('[data-testid="graph-question-filed"]')?.textContent).toContain(`answers/${'6'.repeat(64)}.md`);
    expect(installed.calls).toContain('/api/graph/answer');
  });

  test('a page\'s proposed content is accepted or rejected from the page, and the decision is posted to the graph', async () => {
    const installed = install(world());
    window.history.pushState({}, '', addressOfGraphPage(MODULE));
    intoApp(createElement(App, { reconnectMs: 5 }));
    await until(() => document.querySelector('[data-testid="graph-decision-form"]') !== null, 'the acceptance form');
    const form = document.querySelector('[data-testid="graph-decision-form"]') as HTMLFormElement;
    const note = form.querySelector('textarea') as HTMLTextAreaElement;
    note.value = 'the boundary is right';
    note.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await until(() => document.querySelector('[data-testid="graph-decision-record"]') !== null, 'the decision record');
    expect(document.querySelector('[data-testid="graph-decision-record"]')?.textContent).toContain('Accepted by a person');
    expect(installed.calls).toContain('/api/graph/decide');
  });
});
