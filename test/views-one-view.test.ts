import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MERMAID_FOLDER, REFERENCE_SYSTEM, REFERENCE_TIME } from '../scripts/render-views.js';
import { checkLikeC4Workspaces, type LikeC4CheckResult } from '../scripts/likec4-check.js';
import { checkMermaidPages } from '../scripts/mermaid-check.js';
import {
  compileModel,
  createLadybugEngine,
  createSqliteHistory,
  loadAndCompileModel,
  loadModel,
  renderMermaidPages,
  renderOneViewLikeC4,
  renderOneViewMermaid,
  buildViewSet,
  type CompiledModel,
  type HistoryStore,
  type QueryEngine,
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
  engine: QueryEngine;
  history: HistoryStore;
  model: CompiledModel;
}

/** Loads and compiles one fixture, stores it as one version, and builds a query engine from that history. */
function build(name: string): Built {
  const { model, errors } = loadModel(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
  expect(errors).toEqual([]);
  const compiled = compileModel(model!);
  const history = createSqliteHistory({ clock: { now: () => DAY(1) } });
  expect(history.store({ source: 's', commit: name, committedAt: DAY(1), model: compiled }).errors).toEqual([]);
  const engine = createLadybugEngine();
  engine.rebuild(history.assertions());
  return { engine, history, model: compiled };
}

function close(built: Built): void {
  built.engine.close();
  built.history.close();
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

describe('views/one-view mermaid', () => {
  test('depth-one-equals-page: the asked view is the view set page of it without its Up and Open lines', () => {
    const built = build('views-drill-down');
    try {
      const { views, errors } = buildViewSet(built.engine, built.model, AT);
      expect(errors).toEqual([]);
      const pages = renderMermaidPages(views!);
      expect(pages.errors).toEqual([]);
      const byFile = new Map(pages.pages!.map((page) => [page.file, page.content]));
      for (const [file, element] of [['_landscape.md', undefined], ['shop.md', 'shop'], ['payments.md', 'payments'], ['checkout-web.md', 'checkout-web']] as const) {
        const asked = renderOneViewMermaid(built.engine, built.model, element === undefined ? {} : { element }, AT);
        expect(asked.errors).toEqual([]);
        expect(asked.page).toBe(withoutLinks(byFile.get(file)!));
      }
    } finally {
      close(built);
    }
  });

  test('the page of shop, written by hand from the fixture: the frame, its neighbour, numbered arrows and the table, no links', () => {
    const built = build('views-drill-down');
    try {
      const asked = renderOneViewMermaid(built.engine, built.model, { element: 'shop' }, AT);

      expect(asked).toStrictEqual({ page: SHOP_PAGE, errors: [] });
    } finally {
      close(built);
    }
  });

  test('the view of an element without children shows it as a frame with nothing inside, its neighbours outside, and it parses', async () => {
    const built = build('views-drill-down');
    let page: string;
    try {
      const asked = renderOneViewMermaid(built.engine, built.model, { element: 'catalog-api' }, AT);
      expect(asked.errors).toEqual([]);
      page = asked.page!;
    } finally {
      close(built);
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

  test('a depth below 1 is an error naming the depth and the element, and no page comes back', () => {
    const built = build('views-drill-down');
    try {
      expect(renderOneViewMermaid(built.engine, built.model, { element: 'shop', depth: 0 }, AT)).toStrictEqual({
        errors: [{ message: 'the depth 0 is below 1: the smallest depth rendered is 1', depth: 0, element: 'shop' }],
      });
    } finally {
      close(built);
    }
  });

  test('a depth above 1 is an error naming the depth and saying it is not rendered yet', () => {
    const built = build('views-drill-down');
    try {
      expect(renderOneViewMermaid(built.engine, built.model, { element: 'shop', depth: 2 }, AT)).toStrictEqual({
        errors: [{ message: 'the depth 2 is not rendered yet: only depth 1 is', depth: 2, element: 'shop' }],
      });
    } finally {
      close(built);
    }
  });

  test('without a depth the view is asked at depth 1', () => {
    const built = build('views-drill-down');
    try {
      const defaulted = renderOneViewMermaid(built.engine, built.model, { element: 'shop' }, AT);
      const asked = renderOneViewMermaid(built.engine, built.model, { element: 'shop', depth: 1 }, AT);

      expect(defaulted).toStrictEqual(asked);
      expect(defaulted.errors).toEqual([]);
    } finally {
      close(built);
    }
  });

  test('an element that does not exist at the asked time is an error naming it and the time', () => {
    const built = build('views-drill-down');
    try {
      expect(renderOneViewMermaid(built.engine, built.model, { element: 'ghost' }, AT)).toStrictEqual({
        errors: [
          {
            message: 'the view of "ghost": "ghost" does not exist at this time',
            element: 'ghost',
            query: { message: '"ghost" does not exist at this time', id: 'ghost', time: AT.valid },
          },
        ],
      });
      const before = renderOneViewMermaid(built.engine, built.model, { element: 'shop' }, { valid: DAY(0), known: AT.known });
      expect(before.errors[0]!.message).toBe('the view of "shop": "shop" does not exist at this time');
      expect(before.errors[0]!.query).toStrictEqual({ message: '"shop" does not exist at this time', id: 'shop', time: DAY(0) });
    } finally {
      close(built);
    }
  });
});

describe('views/one-view likec4', () => {
  test('one-view-likec4: the workspace of checkout-web validates alone and holds exactly that one view', () => {
    const built = build('views-drill-down');
    let workspace: string;
    try {
      const asked = renderOneViewLikeC4(built.engine, built.model, { element: 'checkout-web' }, AT);
      expect(asked.errors).toEqual([]);
      workspace = asked.workspace!;
    } finally {
      close(built);
    }

    expect(workspace).toBe(drillDownWorkspace(['  view checkout-web of shop.checkout-web {', '    title "Checkout web"', '    include *', '  }']));
    expect(viewsIn(workspace)).toEqual(['checkout-web of shop.checkout-web']);
    expect(validate(workspace)).toEqual({ files: 1, errors: [] });
  });

  test('the landscape asked with no element is the workspace whose views block holds only index', () => {
    const built = build('views-drill-down');
    let workspace: string;
    try {
      const asked = renderOneViewLikeC4(built.engine, built.model, {}, AT);
      expect(asked.errors).toEqual([]);
      workspace = asked.workspace!;
    } finally {
      close(built);
    }

    expect(workspace).toBe(drillDownWorkspace(['  view index {', '    title "Landscape"', '    include *', '  }']));
    expect(validate(workspace)).toEqual({ files: 1, errors: [] });
  });

  test('the view of an element without children is `view x of <fqn> { include * }` and validates', () => {
    const built = build('views-drill-down');
    let workspace: string;
    try {
      const asked = renderOneViewLikeC4(built.engine, built.model, { element: 'payments-api' }, AT);
      expect(asked.errors).toEqual([]);
      workspace = asked.workspace!;
    } finally {
      close(built);
    }

    expect(workspace).toBe(drillDownWorkspace(['  view payments-api of payments.payments-api {', '    title "Payments API"', '    include *', '  }']));
    expect(validate(workspace)).toEqual({ files: 1, errors: [] });
  });

  test('a depth below or above 1 is an error, and no workspace comes back', () => {
    const built = build('views-drill-down');
    try {
      expect(renderOneViewLikeC4(built.engine, built.model, { depth: -1 }, AT)).toStrictEqual({
        errors: [{ message: 'the depth -1 is below 1: the smallest depth rendered is 1', depth: -1 }],
      });
      expect(renderOneViewLikeC4(built.engine, built.model, { element: 'shop', depth: 3 }, AT)).toStrictEqual({
        errors: [{ message: 'the depth 3 is not rendered yet: only depth 1 is', depth: 3, element: 'shop' }],
      });
    } finally {
      close(built);
    }
  });

  test('an element that does not exist at the asked time is an error naming it and the time', () => {
    const built = build('views-drill-down');
    try {
      expect(renderOneViewLikeC4(built.engine, built.model, { element: 'ghost' }, AT)).toStrictEqual({
        errors: [
          {
            message: 'the view of "ghost": "ghost" does not exist at this time',
            element: 'ghost',
            query: { message: '"ghost" does not exist at this time', id: 'ghost', time: AT.valid },
          },
        ],
      });
    } finally {
      close(built);
    }
  });
});

describe('views/one-view from any query engine', () => {
  type Answer = { elements?: object[]; neighbours?: object[]; relations?: object[]; error?: object };

  /** A query engine answering from lists given by hand: the landscape at depth 0, every element at any deeper unscoped depth, a scope by its name. */
  function handEngine(answers: { landscape?: Answer; every?: Answer; scoped?: (scope: string) => Answer }): QueryEngine {
    return {
      view: (input: { scope?: string; depth: number }) =>
        input.scope !== undefined
          ? (answers.scoped?.(input.scope) ?? { elements: [], neighbours: [], relations: [] })
          : input.depth === 0
            ? (answers.landscape ?? { elements: [], relations: [] })
            : (answers.every ?? { elements: [], relations: [] }),
    } as unknown as QueryEngine;
  }

  function element(id: string, kind: string, parent?: string): { id: string; kind: string; parent?: string } {
    return parent === undefined ? { id, kind } : { id, kind, parent };
  }

  function modelOf(elements: object[]): CompiledModel {
    return { schemaVersion: 1, elements, relations: [], interfaces: [], categories: [], zones: [], environments: [], states: [] } as unknown as CompiledModel;
  }

  test('the question for the landscape refusing is named, and no element is named where none was asked', () => {
    const refusing = { message: 'refused' };
    const engine = handEngine({ landscape: { error: refusing } });
    const model = modelOf([]);

    expect(renderOneViewMermaid(engine, model, {})).toStrictEqual({ errors: [{ message: 'the landscape: refused', query: refusing }] });
    expect(renderOneViewLikeC4(engine, model, {})).toStrictEqual({ errors: [{ message: 'the landscape: refused', query: refusing }] });
  });

  test('a view whose arrows name a relation the compiled model does not hold is an error naming it, in both formats', () => {
    const engine = handEngine({
      scoped: () => ({ elements: [element('top', 'domain'), element('low', 'service', 'top')], neighbours: [], relations: [{ from: 'low', to: 'top', relationIds: ['ghost'] }] }),
    });
    const model = modelOf([element('top', 'domain'), element('low', 'service', 'top')]);

    const expected = {
      message: 'the view of "top": the arrow from "low" to "top" stands for the relation "ghost", which the compiled model does not hold',
      element: 'top',
      relationId: 'ghost',
    };
    expect(renderOneViewMermaid(engine, model, { element: 'top' })).toStrictEqual({ errors: [expected] });
    expect(renderOneViewLikeC4(engine, model, { element: 'top' })).toStrictEqual({ errors: [expected] });
  });

  test('a view with no arrows carries no table, and ends with the blank line a page leaves before its links', () => {
    const engine = handEngine({ landscape: { elements: [element('top', 'domain')], relations: [] } });
    const model = modelOf([element('top', 'domain')]);

    expect(renderOneViewMermaid(engine, model, {})).toStrictEqual({
      page: ['# Landscape', '', '```mermaid', '%%{init: {"flowchart": {"curve": "linear"}}}%%', 'flowchart LR', '  top["top"]', '```', ''].join('\n'),
      errors: [],
    });
  });

  test('a view that does not show its own element as its scope is refused as Mermaid, and no page comes back', () => {
    const engine = handEngine({ scoped: () => ({ elements: [], neighbours: [], relations: [] }) });
    const model = modelOf([element('top', 'domain')]);

    expect(renderOneViewMermaid(engine, model, { element: 'top' })).toStrictEqual({
      errors: [{ message: 'the view of "top" does not show "top" itself as its scope', element: 'top' }],
    });
  });

  test('an element whose parent does not exist at this time is an error in the workspace, which would not hold it', () => {
    const engine = handEngine({
      landscape: { elements: [element('top', 'domain')], relations: [] },
      every: { elements: [element('top', 'domain'), element('lost', 'service', 'nope')], relations: [] },
    });
    const model = modelOf([element('top', 'domain'), element('lost', 'service', 'nope')]);

    expect(renderOneViewLikeC4(engine, model, {})).toStrictEqual({
      errors: [{ message: 'the workspace: the element "lost" cannot be written under its parent "nope", which does not exist at this time', element: 'lost' }],
    });
  });
});

describe("the reference system's one view", () => {
  function reference(): { engine: QueryEngine; model: CompiledModel; at: { valid: number; known: number }; close(): void } {
    const { model, errors } = loadAndCompileModel(REFERENCE_SYSTEM);
    expect(errors).toEqual([]);
    const history = createSqliteHistory({ clock: { now: () => REFERENCE_TIME } });
    expect(history.store({ source: 'reference-system', commit: 'working-tree', committedAt: REFERENCE_TIME, model: model! }).errors).toEqual([]);
    const engine = createLadybugEngine();
    engine.rebuild(history.assertions());
    return { engine, model: model!, at: { valid: REFERENCE_TIME, known: REFERENCE_TIME }, close: () => { engine.close(); history.close(); } };
  }

  test('at depth 1 the answer for the landscape and for every element with children is its committed page without its links', () => {
    const ref = reference();
    try {
      const committed = readdirSync(MERMAID_FOLDER).filter((file) => file.endsWith('.md'));
      expect(committed.length).toBeGreaterThan(1);
      for (const file of committed) {
        const element = file === '_landscape.md' ? undefined : file.replace(/\.md$/, '');
        const asked = renderOneViewMermaid(ref.engine, ref.model, element === undefined ? {} : { element }, ref.at);
        expect(asked.errors).toEqual([]);
        expect(asked.page).toBe(withoutLinks(readFileSync(join(MERMAID_FOLDER, file), 'utf8')));
      }
    } finally {
      ref.close();
    }
  });

  test('the LikeC4 answer for the landscape and for every element with children validates alone, holding exactly one view', () => {
    const ref = reference();
    try {
      const parents = new Set(ref.model.elements.map((element) => element.parent).filter((parent) => parent !== undefined));
      const askedOf = [undefined, ...parents].map((element) => (element === undefined ? {} : { element }));
      expect(askedOf.length).toBe(8);
      for (const request of askedOf) {
        const answer = renderOneViewLikeC4(ref.engine, ref.model, request, ref.at);
        expect(answer.errors).toEqual([]);

        const views = viewsIn(answer.workspace!);
        expect(views).toHaveLength(1);
        const element = 'element' in request ? (request.element as string) : undefined;
        if (element === undefined) expect(views[0]).toBe('index');
        else expect(views[0]!.startsWith(`${element} of `)).toBe(true);
        expect(validate(answer.workspace!)).toEqual({ files: 1, errors: [] });
      }
    } finally {
      ref.close();
    }
  }, 120_000);
});
