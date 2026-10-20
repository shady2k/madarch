import { afterAll, describe, expect, test } from 'bun:test';
import { createTestQueryEngine } from './query-test-engine.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MERMAID_FOLDER, REFERENCE_SYSTEM, REFERENCE_TIME } from '../scripts/render-views.js';
import { checkLikeC4Workspaces, LIKEC4_BIN, type LikeC4CheckResult } from '../scripts/likec4-check.js';
import { checkMermaidPages } from '../scripts/mermaid-check.js';
import {
  compileModel,
  createPGliteHistory,
  loadAndCompileModel,
  loadModel,
  renderMermaidPages,
  renderAsyncOneViewLikeC4,
  renderAsyncOneViewMermaid,
  buildAsyncViewSet,
  type CompiledModel,
  type HistoryStore,
  type AsyncQueryEngine,
} from '../src/index.js';

/**
 * The views capability's one-view requirement (docs/changes/server-views/
 * capabilities/views.md): one view of an element, or the landscape, at a
 * depth, as the view set's Mermaid page without its links or as a LikeC4
 * workspace holding only that view. Expected texts below are written by
 * hand from the fixture and the requirement; the reference system's
 * committed pages are an independent example the answers are held to.
 */
const DAY = (day: number) => Date.UTC(2026, 8, day);
const AT = { valid: DAY(2), known: DAY(2) };

interface Built {
  engine: AsyncQueryEngine;
  history: HistoryStore;
  model: CompiledModel;
}

/**
 * The bound of the case that renders the whole view set and then asks for four
 * of its views one at a time: five renders over one engine, 6.9 s on the 2-CPU
 * pod (measured 2026-10-20, madarch-cznn), over the five seconds an unnamed test
 * really runs under.
 */
const WHOLE_SET_MS = 20_000;

/**
 * One history per fixture, opened the first time a case builds it and kept for
 * the file: a case still stores its own fixture and rebuilds the query engine
 * from that history alone, so the cases stay independent, and what goes away is
 * a PGlite boot per case (1.66 s on the 2-CPU pod the tests run on, measured
 * 2026-10-20, madarch-cznn). Two fixtures cannot share one history: the store
 * refuses two sources declaring the same element id.
 */
const fileHistories = new Map<string, HistoryStore>();

afterAll(async () => {
  for (const history of fileHistories.values()) await history.close();
  fileHistories.clear();
});

function historyFor(name: string): HistoryStore {
  let history = fileHistories.get(name);
  if (history === undefined) {
    history = createPGliteHistory({ clock: { now: () => DAY(1) } });
    fileHistories.set(name, history);
  }
  return history;
}

/** Loads and compiles one fixture, stores it as one version, and builds a query engine from that history. */
async function build(name: string): Promise<Built> {
  const { model, errors } = loadModel(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
  expect(errors).toEqual([]);
  const compiled = compileModel(model!);
  const history = historyFor(name);
  expect((await history.store({ source: 's', commit: name, committedAt: DAY(1), model: compiled })).errors).toEqual([]);
  const engine = await createTestQueryEngine();
  await engine.rebuild(await history.assertions());
  return { engine, history, model: compiled };
}

async function close(built: Built): Promise<void> {
  await await built.engine.close();
}

/** The view set's page without its links to other pages: the "Up:" and "Open:" lines and the blank line each leaves. */
function withoutLinks(page: string): string {
  return page.replace(/\nUp: [^\n]*\n/g, '').replace(/\nOpen: [^\n]*\n/g, '');
}

/** The views a workspace's `views` block holds, as written on their `view` lines. */
function viewsIn(workspace: string): string[] {
  const start = workspace.indexOf('views {');
  const block = workspace.slice(start, workspace.indexOf('\n}', start));
  return [...block.matchAll(/^  view (.+) \{$/gm)].map((match) => match[1]!);
}

/** Writes one workspace into a folder of its own and validates it with the real `likec4`. */
function validate(workspace: string): LikeC4CheckResult {
  const dir = mkdtempSync(join(tmpdir(), 'madarch-one-view-'));
  try {
    writeFileSync(join(dir, 'model.c4'), workspace);
    return checkLikeC4Workspaces([dir]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const HEADER = '// Rendered by madarch from the architecture model; edit the model, not this file.';

/** The one-view workspace of the drill-down fixture, its `views` block holding only `view`. */
function drillDownWorkspace(view: string[]): string {
  return [
    HEADER,
    '',
    'specification {',
    '  element domain',
    '  element module',
    '  element service',
    '}',
    '',
    'model {',
    '  payments = domain "Payments" {',
    '    payments-api = service "Payments API"',
    '  }',
    '  shop = domain "Shop" {',
    '    catalog-api = service "Catalog API"',
    '    checkout-web = service "Checkout web" {',
    '      checkout-cart = module "Cart"',
    '      checkout-ui = module "Checkout UI"',
    '    }',
    '  }',
    '',
    '  shop.checkout-web.checkout-cart -> payments.payments-api "charges the card"',
    '  shop.checkout-web.checkout-cart -> shop.catalog-api "reads prices"',
    '  shop.checkout-web.checkout-ui -> shop.checkout-web.checkout-cart "renders the cart"',
    '}',
    '',
    'views {',
    ...view,
    '}',
    '',
  ].join('\n');
}

const SHOP_PAGE = [
  '# Shop (domain)',
  '',
  '```mermaid',
  '%%{init: {"flowchart": {"curve": "linear"}}}%%',
  'flowchart LR',
  '  subgraph shop ["Shop"]',
  '    catalog_api["Catalog API"]',
  '    checkout_web["Checkout web"]',
  '  end',
  '  payments["Payments"]',
  '  checkout_web -->|"1"| catalog_api',
  '  checkout_web -->|"2"| payments',
  '```',
  '',
  '| # | From | To | Relations |',
  '| --- | --- | --- | --- |',
  '| 1 | Checkout web | Catalog API | reads prices |',
  '| 2 | Checkout web | Payments | charges the card |',
  '',
].join('\n');

/** The view of `catalog-api`, which has no children: the element as a frame with nothing inside, its neighbour outside. */
const CATALOG_PAGE = [
  '# Catalog API (service)',
  '',
  '```mermaid',
  '%%{init: {"flowchart": {"curve": "linear"}}}%%',
  'flowchart LR',
  '  subgraph catalog_api ["Catalog API"]',
  '  end',
  '  checkout_web["Checkout web"]',
  '  checkout_web -->|"1"| catalog_api',
  '```',
  '',
  '| # | From | To | Relations |',
  '| --- | --- | --- | --- |',
  '| 1 | Checkout web | Catalog API | reads prices |',
  '',
].join('\n');

/** The view of `shop` at depth 2: the modules framed inside `checkout-web` inside `shop`, `payments` outside, arrows to the deepest shown elements. */
const SHOP_DEPTH2_PAGE = [
  '# Shop (domain)',
  '',
  '```mermaid',
  '%%{init: {"flowchart": {"curve": "linear"}}}%%',
  'flowchart LR',
  '  subgraph shop ["Shop"]',
  '    catalog_api["Catalog API"]',
  '    subgraph checkout_web ["Checkout web"]',
  '      checkout_cart["Cart"]',
  '      checkout_ui["Checkout UI"]',
  '    end',
  '  end',
  '  payments["Payments"]',
  '  checkout_cart -->|"1"| catalog_api',
  '  checkout_cart -->|"2"| payments',
  '  checkout_ui -->|"3"| checkout_cart',
  '```',
  '',
  '| # | From | To | Relations |',
  '| --- | --- | --- | --- |',
  '| 1 | Cart | Catalog API | reads prices |',
  '| 2 | Cart | Payments | charges the card |',
  '| 3 | Checkout UI | Cart | renders the cart |',
  '',
].join('\n');

/** The landscape at depth 2: every root a frame around its children, relations collapsed to the children. */
const LANDSCAPE_DEPTH2_PAGE = [
  '# Landscape',
  '',
  '```mermaid',
  '%%{init: {"flowchart": {"curve": "linear"}}}%%',
  'flowchart LR',
  '  subgraph payments ["Payments"]',
  '    payments_api["Payments API"]',
  '  end',
  '  subgraph shop ["Shop"]',
  '    catalog_api["Catalog API"]',
  '    checkout_web["Checkout web"]',
  '  end',
  '  checkout_web -->|"1"| catalog_api',
  '  checkout_web -->|"2"| payments_api',
  '```',
  '',
  '| # | From | To | Relations |',
  '| --- | --- | --- | --- |',
  '| 1 | Checkout web | Catalog API | reads prices |',
  '| 2 | Checkout web | Payments API | charges the card |',
  '',
].join('\n');

describe('views/one-view mermaid', async () => {
  test('depth-one-equals-page: the asked view is the view set page of it without its Up and Open lines', async () => {
    const built = await build('views-drill-down');
    try {
      const { views, errors } = await built.engine.withSnapshot((snapshot) => buildAsyncViewSet(snapshot, built.model, AT));
      expect(errors).toEqual([]);
      const pages = renderMermaidPages(views!);
      expect(pages.errors).toEqual([]);
      const byFile = new Map(pages.pages!.map((page) => [page.file, page.content]));
      for (const [file, element] of [['_landscape.md', undefined], ['shop.md', 'shop'], ['payments.md', 'payments'], ['checkout-web.md', 'checkout-web']] as const) {
        const asked = await renderAsyncOneViewMermaid(built.engine, built.model, element === undefined ? {} : { element }, AT);
        expect(asked.errors).toEqual([]);
        expect(asked.page).toBe(withoutLinks(byFile.get(file)!));
      }
    } finally {
      await close(built);
    }
  }, WHOLE_SET_MS);

  test('the page of shop, written by hand from the fixture: the frame, its neighbour, numbered arrows and the table, no links', async () => {
    const built = await build('views-drill-down');
    try {
      const asked = await renderAsyncOneViewMermaid(built.engine, built.model, { element: 'shop' }, AT);

      expect(asked).toStrictEqual({ page: SHOP_PAGE, errors: [] });
    } finally {
      await close(built);
    }
  });

  test('the view of an element without children shows it as a frame with nothing inside, its neighbours outside, and it parses', async () => {
    const built = await build('views-drill-down');
    let page: string;
    try {
      const asked = await renderAsyncOneViewMermaid(built.engine, built.model, { element: 'catalog-api' }, AT);
      expect(asked.errors).toEqual([]);
      page = asked.page!;
    } finally {
      await close(built);
    }

    expect(page).toBe(CATALOG_PAGE);
    const dir = mkdtempSync(join(tmpdir(), 'madarch-one-view-'));
    try {
      writeFileSync(join(dir, 'catalog-api.md'), page);
      expect(await checkMermaidPages([dir])).toEqual({ pages: 1, blocks: 1, errors: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a depth below 1 is an error naming the depth and the element, and no page comes back', async () => {
    const built = await build('views-drill-down');
    try {
      expect(await renderAsyncOneViewMermaid(built.engine, built.model, { element: 'shop', depth: 0 }, AT)).toStrictEqual({
        errors: [{ message: 'the depth 0 is below 1: the smallest depth rendered is 1', depth: 0, element: 'shop' }],
      });
    } finally {
      await close(built);
    }
  });

  test('depth-two-frames: the view of shop at depth 2 frames the modules inside checkout-web inside shop, draws payments outside, and parses', async () => {
    const built = await build('views-drill-down');
    let page: string;
    try {
      const asked = await renderAsyncOneViewMermaid(built.engine, built.model, { element: 'shop', depth: 2 }, AT);
      expect(asked.errors).toEqual([]);
      page = asked.page!;
    } finally {
      await close(built);
    }

    expect(page).toBe(SHOP_DEPTH2_PAGE);
    const dir = mkdtempSync(join(tmpdir(), 'madarch-one-view-'));
    try {
      writeFileSync(join(dir, 'shop-depth2.md'), page);
      expect(await checkMermaidPages([dir])).toEqual({ pages: 1, blocks: 1, errors: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the landscape at depth 2 frames every root around its children, and parses', async () => {
    const built = await build('views-drill-down');
    let page: string;
    try {
      const asked = await renderAsyncOneViewMermaid(built.engine, built.model, { depth: 2 }, AT);
      expect(asked.errors).toEqual([]);
      page = asked.page!;
    } finally {
      await close(built);
    }

    expect(page).toBe(LANDSCAPE_DEPTH2_PAGE);
    const dir = mkdtempSync(join(tmpdir(), 'madarch-one-view-'));
    try {
      writeFileSync(join(dir, 'landscape-depth2.md'), page);
      expect(await checkMermaidPages([dir])).toEqual({ pages: 1, blocks: 1, errors: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a depth that is not a whole number is an error naming it, in both formats', async () => {
    const built = await build('views-drill-down');
    try {
      expect(await renderAsyncOneViewMermaid(built.engine, built.model, { element: 'shop', depth: 1.5 }, AT)).toStrictEqual({
        errors: [{ message: 'the depth 1.5 is not a whole number: the depth is how many levels to draw', depth: 1.5, element: 'shop' }],
      });
      expect(await renderAsyncOneViewLikeC4(built.engine, built.model, { element: 'shop', depth: 1.5 }, AT)).toStrictEqual({
        errors: [{ message: 'the depth 1.5 is not a whole number: the depth is how many levels to draw', depth: 1.5, element: 'shop' }],
      });
    } finally {
      await close(built);
    }
  });

  test('without a depth the view is asked at depth 1', async () => {
    const built = await build('views-drill-down');
    try {
      const defaulted = await renderAsyncOneViewMermaid(built.engine, built.model, { element: 'shop' }, AT);
      const asked = await renderAsyncOneViewMermaid(built.engine, built.model, { element: 'shop', depth: 1 }, AT);

      expect(defaulted).toStrictEqual(asked);
      expect(defaulted.errors).toEqual([]);
    } finally {
      await close(built);
    }
  });

  test('an element that does not exist at the asked time is an error naming it and the time', async () => {
    const built = await build('views-drill-down');
    try {
      expect(await renderAsyncOneViewMermaid(built.engine, built.model, { element: 'ghost' }, AT)).toStrictEqual({
        errors: [
          {
            message: 'the view of "ghost": "ghost" does not exist at this time',
            element: 'ghost',
            query: { message: '"ghost" does not exist at this time', id: 'ghost', time: AT.valid },
          },
        ],
      });
      const before = await renderAsyncOneViewMermaid(built.engine, built.model, { element: 'shop' }, { valid: DAY(0), known: AT.known });
      expect(before.errors[0]!.message).toBe('the view of "shop": "shop" does not exist at this time');
      expect(before.errors[0]!.query).toStrictEqual({ message: '"shop" does not exist at this time', id: 'shop', time: DAY(0) });
    } finally {
      await close(built);
    }
  });
});

describe('views/one-view likec4', async () => {
  test('one-view-likec4: the workspace of checkout-web validates alone and holds exactly that one view', async () => {
    const built = await build('views-drill-down');
    let workspace: string;
    try {
      const asked = await renderAsyncOneViewLikeC4(built.engine, built.model, { element: 'checkout-web' }, AT);
      expect(asked.errors).toEqual([]);
      workspace = asked.workspace!;
    } finally {
      await close(built);
    }

    expect(workspace).toBe(drillDownWorkspace(['  view checkout-web of shop.checkout-web {', '    title "Checkout web"', '    include *', '  }']));
    expect(viewsIn(workspace)).toEqual(['checkout-web of shop.checkout-web']);
    expect(validate(workspace)).toEqual({ files: 1, errors: [] });
  });

  test('the landscape asked with no element is the workspace whose views block holds only index', async () => {
    const built = await build('views-drill-down');
    let workspace: string;
    try {
      const asked = await renderAsyncOneViewLikeC4(built.engine, built.model, {}, AT);
      expect(asked.errors).toEqual([]);
      workspace = asked.workspace!;
    } finally {
      await close(built);
    }

    expect(workspace).toBe(drillDownWorkspace(['  view index {', '    title "Landscape"', '    include *', '  }']));
    expect(validate(workspace)).toEqual({ files: 1, errors: [] });
  });

  test('the view of an element without children is `view x of <fqn> { include * }` and validates', async () => {
    const built = await build('views-drill-down');
    let workspace: string;
    try {
      const asked = await renderAsyncOneViewLikeC4(built.engine, built.model, { element: 'payments-api' }, AT);
      expect(asked.errors).toEqual([]);
      workspace = asked.workspace!;
    } finally {
      await close(built);
    }

    expect(workspace).toBe(drillDownWorkspace(['  view payments-api of payments.payments-api {', '    title "Payments API"', '    include *', '  }']));
    expect(validate(workspace)).toEqual({ files: 1, errors: [] });
  });

  test('a depth below 1 is an error, and no workspace comes back', async () => {
    const built = await build('views-drill-down');
    try {
      expect(await renderAsyncOneViewLikeC4(built.engine, built.model, { depth: -1 }, AT)).toStrictEqual({
        errors: [{ message: 'the depth -1 is below 1: the smallest depth rendered is 1', depth: -1 }],
      });
    } finally {
      await close(built);
    }
  });

  test('depth-two-frames: the view of shop at depth 2 includes the grandchildren, validates, and LikeC4 draws the frames and the collapsed arrows', async () => {
    const built = await build('views-drill-down');
    let workspace: string;
    try {
      const asked = await renderAsyncOneViewLikeC4(built.engine, built.model, { element: 'shop', depth: 2 }, AT);
      expect(asked.errors).toEqual([]);
      workspace = asked.workspace!;
    } finally {
      await close(built);
    }

    expect(workspace).toBe(drillDownWorkspace(['  view shop of shop {', '    title "Shop"', '    include *, shop.checkout-web.*', '  }']));
    expect(viewsIn(workspace)).toEqual(['shop of shop']);

    // What LikeC4 draws, not only that it validates: the modules inside the
    // checkout-web frame, payments outside, the arrows collapsed to the
    // deepest shown elements.
    const dir = mkdtempSync(join(tmpdir(), 'madarch-one-view-'));
    try {
      writeFileSync(join(dir, 'model.c4'), workspace);
      const run = spawnSync(LIKEC4_BIN, ['export', 'json', '-o', join(dir, 'drawn.json'), dir], { encoding: 'utf8', timeout: 120_000 });
      expect(run.error).toBeUndefined();
      const drawn = JSON.parse(readFileSync(join(dir, 'drawn.json'), 'utf8')) as {
        views: Record<string, { nodes: { id: string }[]; edges: { source: string; target: string; label: string | null }[] }>;
      };
      const drawnShop = drawn.views.shop!;
      expect(drawnShop.nodes.map((node) => node.id).sort()).toEqual([
        'payments',
        'shop',
        'shop.catalog-api',
        'shop.checkout-web',
        'shop.checkout-web.checkout-cart',
        'shop.checkout-web.checkout-ui',
      ]);
      expect(drawnShop.edges.map((edge) => `${edge.source} -> ${edge.target} ${edge.label}`).sort()).toEqual([
        'shop.checkout-web.checkout-cart -> payments charges the card',
        'shop.checkout-web.checkout-cart -> shop.catalog-api reads prices',
        'shop.checkout-web.checkout-ui -> shop.checkout-web.checkout-cart renders the cart',
      ]);
      expect(validate(workspace)).toEqual({ files: 1, errors: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the landscape at depth 2 includes the children of every root and validates', async () => {
    const built = await build('views-drill-down');
    let workspace: string;
    try {
      const asked = await renderAsyncOneViewLikeC4(built.engine, built.model, { depth: 2 }, AT);
      expect(asked.errors).toEqual([]);
      workspace = asked.workspace!;
    } finally {
      await close(built);
    }

    expect(workspace).toBe(drillDownWorkspace(['  view index {', '    title "Landscape"', '    include *, payments.*, shop.*', '  }']));
    expect(validate(workspace)).toEqual({ files: 1, errors: [] });
  });

  test('an element that does not exist at the asked time is an error naming it and the time', async () => {
    const built = await build('views-drill-down');
    try {
      expect(await renderAsyncOneViewLikeC4(built.engine, built.model, { element: 'ghost' }, AT)).toStrictEqual({
        errors: [
          {
            message: 'the view of "ghost": "ghost" does not exist at this time',
            element: 'ghost',
            query: { message: '"ghost" does not exist at this time', id: 'ghost', time: AT.valid },
          },
        ],
      });
    } finally {
      await close(built);
    }
  });
});

describe('views/one-view from any query engine', async () => {
  type Answer = { elements?: object[]; neighbours?: object[]; relations?: object[]; error?: object };

  /** A query engine answering from lists given by hand: the landscape at depth 0, every element at any deeper unscoped depth, a scope by its name. */
  function handEngine(answers: { landscape?: Answer; every?: Answer; scoped?: (scope: string) => Answer }): AsyncQueryEngine {
    const engine = {
      view: async (input: { scope?: string; depth: number }) =>
        input.scope !== undefined
          ? (answers.scoped?.(input.scope) ?? { elements: [], neighbours: [], relations: [] })
          : input.depth === 0
            ? (answers.landscape ?? { elements: [], relations: [] })
            : (answers.every ?? { elements: [], relations: [] }),
    } as unknown as AsyncQueryEngine;
    engine.withSnapshot = async (work) => work(engine);
    return engine;
  }

  function element(id: string, kind: string, parent?: string): { id: string; kind: string; parent?: string } {
    return parent === undefined ? { id, kind } : { id, kind, parent };
  }

  function modelOf(elements: object[]): CompiledModel {
    return { schemaVersion: 1, elements, relations: [], interfaces: [], categories: [], zones: [], environments: [], states: [] } as unknown as CompiledModel;
  }

  test('the question for the landscape refusing is named, and no element is named where none was asked', async () => {
    const refusing = { message: 'refused' };
    const engine = handEngine({ landscape: { error: refusing } });
    const model = modelOf([]);

    expect(await renderAsyncOneViewMermaid(engine, model, {})).toStrictEqual({ errors: [{ message: 'the landscape: refused', query: refusing }] });
    expect(await renderAsyncOneViewLikeC4(engine, model, {})).toStrictEqual({ errors: [{ message: 'the landscape: refused', query: refusing }] });
  });

  test('a view whose arrows name a relation the compiled model does not hold is an error naming it, in both formats', async () => {
    const engine = handEngine({
      scoped: () => ({ elements: [element('top', 'domain'), element('low', 'service', 'top')], neighbours: [], relations: [{ from: 'low', to: 'top', relationIds: ['ghost'] }] }),
    });
    const model = modelOf([element('top', 'domain'), element('low', 'service', 'top')]);

    const expected = {
      message: 'the view of "top": the arrow from "low" to "top" stands for the relation "ghost", which the compiled model does not hold',
      element: 'top',
      relationId: 'ghost',
    };
    expect(await renderAsyncOneViewMermaid(engine, model, { element: 'top' })).toStrictEqual({ errors: [expected] });
    expect(await renderAsyncOneViewLikeC4(engine, model, { element: 'top' })).toStrictEqual({ errors: [expected] });
  });

  test('a view with no arrows carries no table, and ends with the blank line a page leaves before its links', async () => {
    const engine = handEngine({ landscape: { elements: [element('top', 'domain')], relations: [] } });
    const model = modelOf([element('top', 'domain')]);

    expect(await renderAsyncOneViewMermaid(engine, model, {})).toStrictEqual({
      page: ['# Landscape', '', '```mermaid', '%%{init: {"flowchart": {"curve": "linear"}}}%%', 'flowchart LR', '  top["top"]', '```', ''].join('\n'),
      errors: [],
    });
  });

  test('a view that does not show its own element as its scope is refused as Mermaid, and no page comes back', async () => {
    const engine = handEngine({ scoped: () => ({ elements: [], neighbours: [], relations: [] }) });
    const model = modelOf([element('top', 'domain')]);

    expect(await renderAsyncOneViewMermaid(engine, model, { element: 'top' })).toStrictEqual({
      errors: [{ message: 'the view of "top" does not show "top" itself as its scope', element: 'top' }],
    });
  });

  test('an element whose parent does not exist at this time is an error in the workspace, which would not hold it', async () => {
    const engine = handEngine({
      landscape: { elements: [element('top', 'domain')], relations: [] },
      every: { elements: [element('top', 'domain'), element('lost', 'service', 'nope')], relations: [] },
    });
    const model = modelOf([element('top', 'domain'), element('lost', 'service', 'nope')]);

    expect(await renderAsyncOneViewLikeC4(engine, model, {})).toStrictEqual({
      errors: [{ message: 'the workspace: the element "lost" cannot be written under its parent "nope", which does not exist at this time', element: 'lost' }],
    });
  });
});

describe("the reference system's one view", async () => {
  async function reference(): Promise<{ engine: AsyncQueryEngine; model: CompiledModel; at: { valid: number; known: number }; close(): Promise<void> }> {
    const { model, errors } = loadAndCompileModel(REFERENCE_SYSTEM);
    expect(errors).toEqual([]);
    const history = createPGliteHistory({ clock: { now: () => REFERENCE_TIME } });
    expect((await history.store({ source: 'reference-system', commit: 'working-tree', committedAt: REFERENCE_TIME, model: model! })).errors).toEqual([]);
    const engine = await createTestQueryEngine();
    await engine.rebuild(await history.assertions());
    return { engine, model: model!, at: { valid: REFERENCE_TIME, known: REFERENCE_TIME }, close: async () => { await engine.close(); await history.close(); } };
  }

  test('at depth 1 the answer for the landscape and for every element with children is its committed page without its links', async () => {
    const ref = await reference();
    try {
      const committed = readdirSync(MERMAID_FOLDER).filter((file) => file.endsWith('.md'));
      expect(committed.length).toBeGreaterThan(1);
      for (const file of committed) {
        const element = file === '_landscape.md' ? undefined : file.replace(/\.md$/, '');
        const asked = await renderAsyncOneViewMermaid(ref.engine, ref.model, element === undefined ? {} : { element }, ref.at);
        expect(asked.errors).toEqual([]);
        expect(asked.page).toBe(withoutLinks(readFileSync(join(MERMAID_FOLDER, file), 'utf8')));
      }
    } finally {
      await ref.close();
    }
  });

  test('the LikeC4 answer for the landscape and for every element with children validates alone, holding exactly one view', async () => {
    const ref = await reference();
    try {
      const parents = new Set(ref.model.elements.map((element) => element.parent).filter((parent) => parent !== undefined));
      const askedOf = [undefined, ...parents].map((element) => (element === undefined ? {} : { element }));
      expect(askedOf.length).toBe(8);
      for (const request of askedOf) {
        const answer = await renderAsyncOneViewLikeC4(ref.engine, ref.model, request, ref.at);
        expect(answer.errors).toEqual([]);

        const views = viewsIn(answer.workspace!);
        expect(views).toHaveLength(1);
        const element = 'element' in request ? (request.element as string) : undefined;
        if (element === undefined) expect(views[0]).toBe('index');
        else expect(views[0]!.startsWith(`${element} of `)).toBe(true);
        expect(validate(answer.workspace!)).toEqual({ files: 1, errors: [] });
      }
    } finally {
      await ref.close();
    }
  }, 120_000);

  test('the landscape and ordering asked at depth 2 and 3 parse as Mermaid and validate as LikeC4', async () => {
    const ref = await reference();
    const pages: { name: string; text: string }[] = [];
    const workspaces: string[] = [];
    try {
      for (const [name, request] of [['landscape', {}], ['ordering', { element: 'ordering' }]] as const) {
        for (const depth of [2, 3]) {
          const mermaid = await renderAsyncOneViewMermaid(ref.engine, ref.model, { ...request, depth }, ref.at);
          expect(mermaid.errors).toEqual([]);
          pages.push({ name: `${name}-depth${depth}.md`, text: mermaid.page! });
          const likec4 = await renderAsyncOneViewLikeC4(ref.engine, ref.model, { ...request, depth }, ref.at);
          expect(likec4.errors).toEqual([]);
          workspaces.push(likec4.workspace!);
        }
      }
    } finally {
      await ref.close();
    }

    const dir = mkdtempSync(join(tmpdir(), 'madarch-one-view-'));
    try {
      for (const page of pages) writeFileSync(join(dir, page.name), page.text);
      expect(await checkMermaidPages([dir])).toEqual({ pages: 4, blocks: 4, errors: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    for (const workspace of workspaces) expect(validate(workspace)).toEqual({ files: 1, errors: [] });
  }, 120_000);
});
