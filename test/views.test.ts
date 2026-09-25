import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MERMAID_FOLDER, REFERENCE_SYSTEM, renderReferenceSystem } from '../scripts/render-views.js';
import {
  buildViewSet,
  compileModel,
  createLadybugEngine,
  createSqliteHistory,
  loadAndCompileModel,
  loadModel,
  renderMermaidPages,
  type Clock,
  type CompiledModel,
  type HistoryStore,
  type QueryEngine,
  type View,
} from '../src/index.js';

/**
 * The views capability's view-set, labels, mermaid and deterministic
 * requirements (docs/changes/readable-views/capabilities/views.md). Every
 * expected view and page below is written by hand from the fixture and the
 * requirement, never produced by the renderer and pasted back.
 */
function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

function fakeClock(initial: number): Clock {
  return { now: () => initial };
}

const DAY = (day: number) => Date.UTC(2026, 8, day);
const AT = { valid: DAY(2), known: DAY(2) };

interface Built {
  engine: QueryEngine;
  history: HistoryStore;
  model: CompiledModel;
}

/** Loads and compiles one fixture, stores it as one version, and builds a query engine from that history. */
function build(name: string): Built {
  const { model, errors } = loadModel(fixture(name));
  expect(errors).toEqual([]);
  const compiled = compileModel(model!);
  const history = createSqliteHistory({ clock: fakeClock(DAY(1)) });
  expect(history.store({ source: 's', commit: name, committedAt: DAY(1), model: compiled }).errors).toEqual([]);
  const engine = createLadybugEngine();
  engine.rebuild(history.assertions());
  return { engine, history, model: compiled };
}

function close(built: Built): void {
  built.engine.close();
  built.history.close();
}

function viewsOf(name: string): View[] {
  const built = build(name);
  const { views, errors } = buildViewSet(built.engine, built.model, AT);
  close(built);
  expect(errors).toEqual([]);
  return views!;
}

function viewOf(views: readonly View[], scope: string | undefined): View {
  const found = views.find((view) => view.scope === scope);
  expect(found).toBeDefined();
  return found!;
}

function pagesOf(name: string): Map<string, string> {
  const { pages, errors } = renderMermaidPages(viewsOf(name));
  expect(errors).toEqual([]);
  return new Map(pages!.map((page) => [page.file, page.content]));
}

describe('views/view-set', () => {
  test('drill-down: a landscape, a view of shop, of payments and of checkout-web, and none of payments-api', () => {
    const views = viewsOf('views-drill-down');

    expect(views.map((view) => view.scope)).toEqual([undefined, 'checkout-web', 'payments', 'shop']);
  });

  test('the landscape shows exactly the elements with no parent, with the relations between them lifted', () => {
    expect(viewOf(viewsOf('views-drill-down'), undefined)).toStrictEqual({
      elements: [
        { id: 'payments', kind: 'domain', name: 'Payments', place: 'inside', hasView: true },
        { id: 'shop', kind: 'domain', name: 'Shop', place: 'inside', hasView: true },
      ],
      arrows: [{ from: 'shop', to: 'payments', relationIds: ['cart-charges-card'], label: 'charges the card' }],
    });
  });

  test('a domain view shows its children inside it and its neighbours outside, each marked with whether it has a view', () => {
    expect(viewOf(viewsOf('views-drill-down'), 'shop')).toEqual({
      scope: 'shop',
      elements: [
        { id: 'catalog-api', kind: 'service', name: 'Catalog API', parent: 'shop', place: 'inside', hasView: false },
        { id: 'checkout-web', kind: 'service', name: 'Checkout web', parent: 'shop', place: 'inside', hasView: true },
        { id: 'payments', kind: 'domain', name: 'Payments', place: 'neighbour', hasView: true },
        { id: 'shop', kind: 'domain', name: 'Shop', place: 'scope', hasView: true },
      ],
      arrows: [
        { from: 'checkout-web', to: 'catalog-api', relationIds: ['cart-reads-catalog'], label: 'reads prices' },
        { from: 'checkout-web', to: 'payments', relationIds: ['cart-charges-card'], label: 'charges the card' },
      ],
    });
  });

  test('a service view shows its modules, a sibling service and another domain as neighbours', () => {
    expect(viewOf(viewsOf('views-drill-down'), 'checkout-web')).toEqual({
      scope: 'checkout-web',
      up: { id: 'shop', name: 'Shop' },
      elements: [
        { id: 'catalog-api', kind: 'service', name: 'Catalog API', parent: 'shop', place: 'neighbour', hasView: false },
        { id: 'checkout-cart', kind: 'module', name: 'Cart', parent: 'checkout-web', place: 'inside', hasView: false },
        { id: 'checkout-ui', kind: 'module', name: 'Checkout UI', parent: 'checkout-web', place: 'inside', hasView: false },
        { id: 'checkout-web', kind: 'service', name: 'Checkout web', parent: 'shop', place: 'scope', hasView: true },
        { id: 'payments', kind: 'domain', name: 'Payments', place: 'neighbour', hasView: true },
      ],
      arrows: [
        { from: 'checkout-cart', to: 'catalog-api', relationIds: ['cart-reads-catalog'], label: 'reads prices' },
        { from: 'checkout-cart', to: 'payments', relationIds: ['cart-charges-card'], label: 'charges the card' },
        { from: 'checkout-ui', to: 'checkout-cart', relationIds: ['ui-renders-cart'], label: 'renders the cart' },
      ],
    });
  });

  test('the views are computed at the asked time: before the model existed there is an empty landscape and nothing else', () => {
    const built = build('views-drill-down');
    const { views, errors } = buildViewSet(built.engine, built.model, { valid: DAY(1) - 1, known: DAY(2) });
    close(built);

    expect(errors).toEqual([]);
    expect(views).toStrictEqual([{ elements: [], arrows: [] }]);
  });

  test('a query error is surfaced, naming the view it stopped, never swallowed', () => {
    const built = build('views-drill-down');
    const result = buildViewSet(built.engine, built.model, { ...AT, state: 'not a state' });
    close(built);

    expect(result.views).toBeUndefined();
    expect(result.errors).toStrictEqual([
      {
        message: 'the landscape: "not a state" is not a state id this model could ever declare',
        query: { message: '"not a state" is not a state id this model could ever declare', id: 'not a state' },
      },
    ]);
  });

  test('a relation the engine draws but the compiled model does not hold is an error naming the view, the arrow and the relation', () => {
    const built = build('views-drill-down');
    const other = compileModel(loadModel(fixture('views-labels')).model!);
    const result = buildViewSet(built.engine, other, AT);
    close(built);

    expect(result.views).toBeUndefined();
    expect(result.errors).toStrictEqual([
      { message: 'the landscape: the arrow from "shop" to "payments" stands for the relation "cart-charges-card", which the compiled model does not hold', relationId: 'cart-charges-card' },
      {
        message: 'the view of "checkout-web": the arrow from "checkout-cart" to "catalog-api" stands for the relation "cart-reads-catalog", which the compiled model does not hold',
        scope: 'checkout-web',
        relationId: 'cart-reads-catalog',
      },
      {
        message: 'the view of "checkout-web": the arrow from "checkout-cart" to "payments" stands for the relation "cart-charges-card", which the compiled model does not hold',
        scope: 'checkout-web',
        relationId: 'cart-charges-card',
      },
      {
        message: 'the view of "checkout-web": the arrow from "checkout-ui" to "checkout-cart" stands for the relation "ui-renders-cart", which the compiled model does not hold',
        scope: 'checkout-web',
        relationId: 'ui-renders-cart',
      },
      {
        message: 'the view of "payments": the arrow from "shop" to "payments-api" stands for the relation "cart-charges-card", which the compiled model does not hold',
        scope: 'payments',
        relationId: 'cart-charges-card',
      },
      {
        message: 'the view of "shop": the arrow from "checkout-web" to "catalog-api" stands for the relation "cart-reads-catalog", which the compiled model does not hold',
        scope: 'shop',
        relationId: 'cart-reads-catalog',
      },
      {
        message: 'the view of "shop": the arrow from "checkout-web" to "payments" stands for the relation "cart-charges-card", which the compiled model does not hold',
        scope: 'shop',
        relationId: 'cart-charges-card',
      },
    ]);
  });
});

describe('views/labels', () => {
  test('merged-label: the one arrow from checkout-web to stock-api in the view of shop is labelled "reserves stock; shows stock"', () => {
    const shop = viewOf(viewsOf('views-labels'), 'shop');

    expect(shop.arrows.find((arrow) => arrow.to === 'stock-api')).toEqual({
      from: 'checkout-web',
      to: 'stock-api',
      relationIds: ['cart-reserves-stock', 'ui-shows-stock'],
      label: 'reserves stock; shows stock',
    });
  });

  test('more than three names: the first three in relation-id order (code point) and a count of the rest; a name repeated among them is shown once', () => {
    const shop = viewOf(viewsOf('views-labels'), 'shop');

    expect(shop.arrows.find((arrow) => arrow.to === 'audit-log')).toEqual({
      from: 'checkout-web',
      to: 'audit-log',
      relationIds: ['W-writes-first', 'cart-reads', 'cart-writes-again', 'ui-audits', 'ui-counts', 'ui-locks'],
      label: 'writes carts; reads carts; audits views (+2 more)',
    });
  });

  test('exactly three names carry no count; three relations sharing a name among them show two', () => {
    const checkout = viewOf(viewsOf('views-labels'), 'checkout-web');

    expect(checkout.arrows.filter((arrow) => arrow.to === 'audit-log').map((arrow) => [arrow.from, arrow.label])).toEqual([
      ['checkout-cart', 'writes carts; reads carts'],
      ['checkout-ui', 'audits views; counts views; locks rows'],
    ]);
  });

  test("unnamed-fallback: an unnamed relation is labelled with its interface's contract, or its id where it names no interface", () => {
    const { model, errors, warnings } = loadModel(fixture('views-unnamed'));
    expect(errors).toEqual([]);
    expect(warnings.map((warning) => warning.path)).toEqual(['relations[0]', 'relations[1]']);
    expect(model).toBeDefined();

    expect(viewOf(viewsOf('views-unnamed'), undefined).arrows).toEqual([
      { from: 'checkout-web', to: 'orders-api', relationIds: ['checkout-to-orders'], label: 'http::POST::/api/orders' },
      { from: 'checkout-web', to: 'stock-api', relationIds: ['checkout-to-stock'], label: 'checkout-to-stock' },
    ]);
  });

  test("an unnamed relation whose interface the compiled model does not hold is an error naming the relation and the interface", () => {
    const built = build('views-unnamed');
    const model: CompiledModel = { ...built.model, interfaces: [] };
    const result = buildViewSet(built.engine, model, AT);
    close(built);

    expect(result.views).toBeUndefined();
    expect(result.errors).toStrictEqual([
      {
        message:
          'the landscape: the arrow from "checkout-web" to "orders-api" stands for the relation "checkout-to-orders", whose interface "orders-http" the compiled model does not hold',
        relationId: 'checkout-to-orders',
      },
    ]);
  });
});

describe('views/mermaid', () => {
  test('mermaid-page: the page of shop frames checkout-web and catalog-api inside shop, draws payments outside, and links to checkout-web and the landscape', () => {
    expect(pagesOf('views-drill-down').get('shop.md')).toBe(
      [
        '# Shop (domain)',
        '',
        '```mermaid',
        'flowchart LR',
        '  subgraph shop ["Shop"]',
        '    catalog_api["Catalog API"]',
        '    checkout_web["Checkout web"]',
        '  end',
        '  payments["Payments"]',
        '  checkout_web -->|"reads prices"| catalog_api',
        '  checkout_web -->|"charges the card"| payments',
        '```',
        '',
        'Up: [Landscape](_landscape.md)',
        '',
        'Open: [Checkout web](checkout-web.md) · [Payments](payments.md)',
        '',
      ].join('\n'),
    );
  });

  test('one page per view: the landscape is _landscape.md, every other page is named by its element id', () => {
    expect([...pagesOf('views-drill-down').keys()]).toEqual(['_landscape.md', 'checkout-web.md', 'payments.md', 'shop.md']);
  });

  test('a service page goes up to its domain; the landscape has no way up', () => {
    const pages = pagesOf('views-drill-down');

    expect(pages.get('checkout-web.md')).toContain('\nUp: [Shop](shop.md)\n');
    expect(pages.get('checkout-web.md')).toContain('\nOpen: [Payments](payments.md)\n');
    expect(pages.get('_landscape.md')).toBe(
      [
        '# Landscape',
        '',
        '```mermaid',
        'flowchart LR',
        '  payments["Payments"]',
        '  shop["Shop"]',
        '  shop -->|"charges the card"| payments',
        '```',
        '',
        'Open: [Payments](payments.md) · [Shop](shop.md)',
        '',
      ].join('\n'),
    );
  });

  test("shapes per kind, externals in their own class, entity codes for Mermaid's special characters, and node ids made safe and unique", () => {
    expect(pagesOf('views-shapes').get('_landscape.md')).toBe(
      [
        '# Landscape',
        '',
        '```mermaid',
        'flowchart LR',
        '  a_b_2["A dot B"]',
        '  a_b["A underscore B"]',
        '  customer(["The #quot;best#quot; customer"])',
        '  end_["end"]',
        '  mail_gateway["Mail #35;1 #lt;smtp#gt; #amp; co"]',
        '  order_events[["Order events"]]',
        '  orders_db[("Orders DB")]',
        '  web["Web [*beta*]"]',
        '  a_b_2 -->|"writes orders"| orders_db',
        '  a_b -->|"publishes #96;placed#96;"| order_events',
        '  customer -->|"sends #quot;receipts#quot; #124; copies"| mail_gateway',
        '  end_ -->|"calls"| a_b_2',
        '  web -->|"calls"| end_',
        '  classDef external fill:#f4f4f4,stroke:#888888,stroke-dasharray:5 5',
        '  class mail_gateway external',
        '```',
        '',
        'Open: [Web \\[\\*beta\\*\\]](web.md)',
        '',
      ].join('\n'),
    );
  });

  test('an element without a name is drawn by its id; a page with no element to open has no Open line', () => {
    expect(pagesOf('views-shapes').get('web.md')).toBe(
      [
        '# Web \\[\\*beta\\*\\] (system)',
        '',
        '```mermaid',
        'flowchart LR',
        '  subgraph web ["Web [*beta*]"]',
        '    web_ui["web-ui"]',
        '  end',
        '  end_["end"]',
        '  web_ui -->|"calls"| end_',
        '```',
        '',
        'Up: [Landscape](_landscape.md)',
        '',
      ].join('\n'),
    );
  });

  test('an element with children whose id is "index" gets index.md like any other; no element page can take the landscape\'s name', () => {
    const pages = pagesOf('views-index');

    expect([...pages.keys()]).toEqual(['_landscape.md', 'index.md']);
    expect(pages.get('index.md')).toBe(
      [
        '# Search index (domain)',
        '',
        '```mermaid',
        'flowchart LR',
        '  subgraph index ["Search index"]',
        '    index_api["Index API"]',
        '  end',
        '```',
        '',
        'Up: [Landscape](_landscape.md)',
        '',
      ].join('\n'),
    );
    expect(pages.get('_landscape.md')).toContain('\nOpen: [Search index](index.md)\n');
  });

  test('two views whose element ids differ only by letter case would overwrite each other on a case-insensitive file system: an error naming both, and no pages', () => {
    expect(renderMermaidPages(viewsOf('views-case-clash'))).toStrictEqual({
      errors: [
        {
          message: 'the views of "Shop" and "shop" would be written to Shop.md and shop.md, which are one file on a case-insensitive file system',
          scope: 'shop',
        },
      ],
    });
  });
});

describe('views/mermaid on hand-built views', () => {
  test('a control character is a numeric entity code in the diagram and a space in the Markdown; an unnamed parent goes up by its id', () => {
    const view: View = {
      scope: 'svc',
      up: { id: 'dom' },
      elements: [
        { id: 'mod', kind: 'module', name: 'tab\there', parent: 'svc', place: 'inside', hasView: false },
        { id: 'svc', kind: 'service', name: 'two\nlines\u007f', parent: 'dom', place: 'scope', hasView: true },
      ],
      arrows: [{ from: 'mod', to: 'svc', relationIds: ['r'], label: 'a\u0000b' }],
    };

    const { pages, errors } = renderMermaidPages([{ elements: [], arrows: [] }, view]);
    expect(errors).toEqual([]);
    expect(pages).toEqual([
      { file: '_landscape.md', content: ['# Landscape', '', '```mermaid', 'flowchart LR', '```', ''].join('\n') },
      {
        file: 'svc.md',
        content: [
          '# two lines  (service)',
          '',
          '```mermaid',
          'flowchart LR',
          '  subgraph svc ["two#10;lines#127;"]',
          '    mod["tab#9;here"]',
          '  end',
          '  mod -->|"a#0;b"| svc',
          '```',
          '',
          'Up: [dom](dom.md)',
          '',
        ].join('\n'),
      },
    ]);
  });

  test('an external frame and several externals share the class; every keyword id, in any case, gets a trailing underscore', () => {
    const view: View = {
      scope: 'Style',
      elements: [
        { id: 'Style', kind: 'external', place: 'scope', hasView: true },
        { id: 'class', kind: 'external', parent: 'Style', place: 'inside', hasView: false },
        { id: 'subgraph', kind: 'person', place: 'neighbour', hasView: false },
      ],
      arrows: [],
    };

    expect(renderMermaidPages([view]).pages![0]!.content).toBe(
      [
        '# Style (external)',
        '',
        '```mermaid',
        'flowchart LR',
        '  subgraph Style_ ["Style"]',
        '    class_["class"]',
        '  end',
        '  subgraph_(["subgraph"])',
        '  classDef external fill:#f4f4f4,stroke:#888888,stroke-dasharray:5 5',
        '  class Style_,class_ external',
        '```',
        '',
        'Up: [Landscape](_landscape.md)',
        '',
      ].join('\n'),
    );
  });
});

describe('views/mermaid refuses a view without its own scope', () => {
  test('a view whose scope is missing, shown only as a neighbour, or another element in its place, is an error naming it, and no pages', () => {
    const missing: View = { scope: 'shop', elements: [{ id: 'cart', kind: 'service', parent: 'shop', place: 'inside', hasView: false }], arrows: [] };
    const asNeighbour: View = { scope: 'pay', elements: [{ id: 'pay', kind: 'domain', place: 'neighbour', hasView: true }], arrows: [] };
    const anotherScope: View = { scope: 'odd', elements: [{ id: 'other', kind: 'domain', place: 'scope', hasView: true }], arrows: [] };

    expect(renderMermaidPages([{ elements: [], arrows: [] }, missing, asNeighbour, anotherScope])).toStrictEqual({
      errors: [
        { message: 'the view of "shop" does not show "shop" itself as its scope', scope: 'shop' },
        { message: 'the view of "pay" does not show "pay" itself as its scope', scope: 'pay' },
        { message: 'the view of "odd" does not show "odd" itself as its scope', scope: 'odd' },
      ],
    });
  });
});

describe('views/mermaid node ids', () => {
  function nodeLines(ids: readonly string[]): string[] {
    const view: View = { elements: ids.map((id) => ({ id, kind: 'service', place: 'inside', hasView: false })), arrows: [] };
    return renderMermaidPages([view])
      .pages![0]!.content.split('\n')
      .filter((line) => line.startsWith('  '));
  }

  test("every word Mermaid's flowchart grammar reads as a keyword gets a trailing underscore", () => {
    const keywords = [
      'accDescr',
      'accTitle',
      'call',
      'callback',
      'class',
      'classDef',
      'click',
      'default',
      'direction',
      'end',
      'flowchart',
      'graph',
      'href',
      'interpolate',
      'linkStyle',
      'style',
      'subgraph',
    ];

    expect(nodeLines(keywords)).toEqual(keywords.map((id) => `  ${id}_["${id}"]`));
  });

  test('clashing ids take _2, _3, ... in code point order of the element ids, whatever order the view lists them in', () => {
    // Drawn in the view's own order; "a-b" (0x2D) sorts before "a.b" (0x2E).
    expect(nodeLines(['a.b', 'a_b', 'a-b'])).toEqual(['  a_b_3["a.b"]', '  a_b["a_b"]', '  a_b_2["a-b"]']);
  });
});

/**
 * A query engine answering from lists given by hand: the landscape at depth
 * 0, every element for an unscoped view any deeper, and `scoped` (or an
 * empty view) for a scope. It has no `children`, so a view set that asked
 * for children element by element would fail here.
 */
function handEngine(answers: { landscape: object; every: object; scoped?: (scope: string) => object }): QueryEngine {
  return {
    view: (input: { scope?: string; depth: number }) =>
      input.scope !== undefined ? (answers.scoped?.(input.scope) ?? { elements: [], neighbours: [], relations: [] }) : input.depth === 0 ? answers.landscape : answers.every,
  } as unknown as QueryEngine;
}

describe('views/view-set from any query engine', () => {
  test('arrows by from then to and relation ids in code point order, whatever order the engine answers in; an unnamed parent goes up by its id alone', () => {
    const model = compileModel(loadModel(fixture('views-labels')).model!);
    const top = { id: 'top', kind: 'domain' };
    const engine = handEngine({
      landscape: {
        elements: [top],
        relations: [
          { from: 'top', to: 'b', relationIds: ['ui-shows-stock'] },
          { from: 'top', to: 'a', relationIds: ['ui-shows-stock'] },
          { from: 'a', to: 'top', relationIds: ['ui-shows-stock', 'cart-reserves-stock'] },
        ],
      },
      every: { elements: [{ id: 'low', kind: 'module', parent: 'mid' }, { id: 'mid', kind: 'service', parent: 'top' }, top], relations: [] },
    });

    expect(buildViewSet(engine, model)).toStrictEqual({
      views: [
        {
          elements: [{ id: 'top', kind: 'domain', place: 'inside', hasView: true }],
          arrows: [
            { from: 'a', to: 'top', relationIds: ['cart-reserves-stock', 'ui-shows-stock'], label: 'reserves stock; shows stock' },
            { from: 'top', to: 'a', relationIds: ['ui-shows-stock'], label: 'shows stock' },
            { from: 'top', to: 'b', relationIds: ['ui-shows-stock'], label: 'shows stock' },
          ],
        },
        { scope: 'mid', up: { id: 'top' }, elements: [], arrows: [] },
        { scope: 'top', elements: [], arrows: [] },
      ],
      errors: [],
    });
  });

  test('an element whose parent does not exist at the asked time is an error naming both, never an element left out of every view', () => {
    const engine = handEngine({
      landscape: { elements: [{ id: 'top', kind: 'domain' }], relations: [] },
      every: { elements: [{ id: 'lost', kind: 'service', parent: 'gone' }, { id: 'top', kind: 'domain' }], relations: [] },
    });

    expect(buildViewSet(engine, compileModel(loadModel(fixture('views-labels')).model!))).toStrictEqual({
      errors: [{ message: 'the element "lost" is shown in no view: its parent "gone" does not exist at this time', scope: 'gone' }],
    });
  });
});

describe('views/view-set with a query engine that refuses', () => {
  test('the query for every element refusing is named, and no view set comes back', () => {
    const refusing = { message: 'refused' };
    const engine = handEngine({ landscape: { elements: [], relations: [] }, every: { error: refusing } });

    expect(buildViewSet(engine, compileModel(loadModel(fixture('views-drill-down')).model!))).toStrictEqual({
      errors: [{ message: 'every element: refused', query: refusing }],
    });
  });

  test('every view query that refuses is named, and no view set comes back', () => {
    const refusing = { message: 'refused' };
    const engine = handEngine({
      landscape: { elements: [{ id: 'a', kind: 'domain' }, { id: 'b', kind: 'domain' }], relations: [] },
      every: {
        elements: [{ id: 'a', kind: 'domain' }, { id: 'a1', kind: 'service', parent: 'a' }, { id: 'b', kind: 'domain' }, { id: 'b1', kind: 'service', parent: 'b' }],
        relations: [],
      },
      scoped: () => ({ error: refusing }),
    });

    expect(buildViewSet(engine, compileModel(loadModel(fixture('views-drill-down')).model!))).toStrictEqual({
      errors: [
        { message: 'the view of "a": refused', scope: 'a', query: refusing },
        { message: 'the view of "b": refused', scope: 'b', query: refusing },
      ],
    });
  });
});

describe('views/deterministic', () => {
  test('twice: the same model rendered twice, from two engines built apart, gives byte-identical pages', () => {
    const first = pagesOf('views-shapes');
    const second = pagesOf('views-shapes');

    expect([...second.entries()]).toEqual([...first.entries()]);
  });
});

describe("the reference system's committed views", () => {
  test('rendering examples/reference-system again gives exactly the committed pages under views/mermaid/, byte for byte, no more and no fewer', () => {
    const { pages, errors, warnings } = renderReferenceSystem();
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);

    // Written by hand from the model: the landscape, the six domains and
    // checkout-api, the one service with modules. Default sort compares
    // UTF-16 code units, the same as code points for these ASCII names.
    const expected = ['_landscape.md', 'catalog.md', 'checkout-api.md', 'fulfilment.md', 'ordering.md', 'payments.md', 'platform.md', 'storefront.md'];
    expect(pages!.map((page) => page.file).sort()).toEqual(expected);
    expect(readdirSync(MERMAID_FOLDER).sort()).toEqual(expected);
    const { model } = loadAndCompileModel(REFERENCE_SYSTEM);
    const parents = new Set(model!.elements.map((element) => element.parent).filter((parent) => parent !== undefined));
    for (const parent of parents) expect(expected).toContain(`${parent}.md`);
    for (const page of pages!) {
      expect({ file: page.file, content: readFileSync(join(MERMAID_FOLDER, page.file), 'utf8') }).toEqual({ file: page.file, content: page.content });
    }
  });
});
