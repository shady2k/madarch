import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIKEC4_FILE, renderReferenceSystem } from '../scripts/render-views.js';
import { checkLikeC4Workspaces } from '../scripts/likec4-check.js';
import {
  compileModel,
  createLadybugEngine,
  createSqliteHistory,
  loadModel,
  renderLikeC4Workspace,
  type CompiledElement,
  type CompiledModel,
  type CompiledRelation,
  type LikeC4Result,
  type QueryEngine,
} from '../src/index.js';

/**
 * The views capability's likec4 and deterministic requirements, and labels
 * on LikeC4's arrows (docs/changes/readable-views/capabilities/views.md).
 * Every expected workspace below is written by hand from the fixture and
 * the requirement; validation runs the pinned `likec4` itself.
 */
function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

const DAY = (day: number) => Date.UTC(2026, 8, day);
const AT = { valid: DAY(2), known: DAY(2) };

/** Loads, compiles and stores one fixture as one version, then renders its workspace from a query engine built from that history. */
function renderFixture(name: string): LikeC4Result {
  const { model, errors } = loadModel(fixture(name));
  expect(errors).toEqual([]);
  const compiled = compileModel(model!);
  const history = createSqliteHistory({ clock: { now: () => DAY(1) } });
  const engine = createLadybugEngine();
  try {
    expect(history.store({ source: 's', commit: name, committedAt: DAY(1), model: compiled }).errors).toEqual([]);
    engine.rebuild(history.assertions());
    return renderLikeC4Workspace(engine, compiled, AT);
  } finally {
    engine.close();
    history.close();
  }
}

/** The workspace of a fixture every relation of which LikeC4 can draw. */
function workspaceOf(name: string): string {
  const { workspace, notDrawn, errors } = renderFixture(name);
  expect(errors).toEqual([]);
  expect(notDrawn).toEqual([]);
  return workspace!;
}

/** Writes one workspace into a folder of its own and validates it with the real `likec4`. */
function validate(workspace: string): ReturnType<typeof checkLikeC4Workspaces> {
  const dir = mkdtempSync(join(tmpdir(), 'madarch-likec4-'));
  writeFileSync(join(dir, 'model.c4'), workspace);
  return checkLikeC4Workspaces([dir]);
}

const HEADER = '// Rendered by madarch from the architecture model; edit the model, not this file.';

const DRILL_DOWN = [
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
  '  view index {',
  '    title "Landscape"',
  '    include *',
  '  }',
  '  view checkout-web of shop.checkout-web {',
  '    title "Checkout web"',
  '    include *',
  '  }',
  '  view payments of payments {',
  '    title "Payments"',
  '    include *',
  '  }',
  '  view shop of shop {',
  '    title "Shop"',
  '    include *',
  '  }',
  '}',
  '',
].join('\n');

describe('views/likec4', () => {
  test('likec4-validates: the drill-down workspace validates and has the views index, shop, payments and checkout-web', () => {
    const workspace = workspaceOf('views-drill-down');

    expect(workspace).toBe(DRILL_DOWN);
    expect(validate(workspace)).toEqual({ files: 1, errors: [] });
  });

  test('ids made LikeC4 identifiers, unique and never a keyword; strings escaped; technology; shapes per kind; one arrow per relation, each labelled, unnamed ones by contract or id', () => {
    const workspace = workspaceOf('views-likec4');

    expect(workspace).toBe(
      [
        HEADER,
        '',
        'specification {',
        '  element broker {',
        '    style {',
        '      shape queue',
        '    }',
        '  }',
        '  element domain',
        '  element external {',
        '    style {',
        '      color muted',
        '      border dashed',
        '    }',
        '  }',
        '  element module',
        '  element person {',
        '    style {',
        '      shape person',
        '    }',
        '  }',
        '  element service',
        '  element store {',
        '    style {',
        '      shape storage',
        '    }',
        '  }',
        '}',
        '',
        'model {',
        '  _3d-store = store "Stock \\"3D\\" \\\\ store" {',
        '    technology "PostgreSQL"',
        '  }',
        '  buyer = person "Buyer"',
        '  events = broker "Events"',
        '  mailer = external "Mailer"',
        '  style_ = domain "Style" {',
        '    style_web_2 = service "Style web" {',
        '      technology "TypeScript"',
        '      style_web = module "style_web"',
        '    }',
        '  }',
        '',
        '  buyer -> style_.style_web_2 "opens the \\"shop\\""',
        '  style_.style_web_2 -> mailer "web-mails"',
        '  style_.style_web_2.style_web -> events "topic::stock-changed"',
        '  style_.style_web_2.style_web -> _3d-store "reads\\\\stock"',
        '  style_.style_web_2.style_web -> _3d-store "writes stock"',
        '}',
        '',
        'views {',
        '  view index {',
        '    title "Landscape"',
        '    include *',
        '  }',
        '  view style_ of style_ {',
        '    title "Style"',
        '    include *',
        '  }',
        '  view style_web_2 of style_.style_web_2 {',
        '    title "Style web"',
        '    include *',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    expect(validate(workspace)).toEqual({ files: 1, errors: [] });
  });

  test('an element whose id is "index" still gets a view of its own beside the landscape\'s index', () => {
    const workspace = workspaceOf('views-index');

    expect(workspace).toContain('\n  index_ = domain "Search index" {\n    index-api = service "Index API"\n  }\n');
    expect(workspace).toContain('\n  view index {\n    title "Landscape"\n');
    expect(workspace).toContain('\n  view index_ of index_ {\n    title "Search index"\n');
    expect(validate(workspace)).toEqual({ files: 1, errors: [] });
  });

  test('before the model existed the workspace is empty but still valid: no kinds, no elements, the landscape alone', () => {
    const { model } = loadModel(fixture('views-drill-down'));
    const compiled = compileModel(model!);
    const history = createSqliteHistory({ clock: { now: () => DAY(1) } });
    const engine = createLadybugEngine();
    history.store({ source: 's', commit: 'c', committedAt: DAY(1), model: compiled });
    engine.rebuild(history.assertions());
    const result = renderLikeC4Workspace(engine, compiled, { valid: DAY(1) - 1, known: DAY(2) });
    engine.close();
    history.close();

    const empty = [HEADER, '', 'specification {', '}', '', 'model {', '}', '', 'views {', '  view index {', '    title "Landscape"', '    include *', '  }', '}', ''].join('\n');
    expect(result).toStrictEqual({ workspace: empty, notDrawn: [], errors: [] });
    expect(validate(empty)).toEqual({ files: 1, errors: [] });
  });
});

describe('views/likec4 relations LikeC4 cannot draw', () => {
  test('a relation between an element and its own descendant, either way, and one of an element to itself are listed apart, not drawn; the ordinary relation is drawn and the workspace validates', () => {
    const { workspace, notDrawn, errors } = renderFixture('views-likec4-not-drawn');
    expect(errors).toEqual([]);

    expect(notDrawn).toStrictEqual([
      {
        relationId: 'loop-retries',
        from: 'loop',
        to: 'loop',
        reason: 'self',
        message: 'the relation "loop-retries" from "loop" to "loop" is not drawn in the LikeC4 workspace: LikeC4 cannot draw a relation of an element to itself',
      },
      {
        relationId: 'shop-runs-cart',
        from: 'shop',
        to: 'cart',
        reason: 'descendant',
        message: 'the relation "shop-runs-cart" from "shop" to "cart" is not drawn in the LikeC4 workspace: LikeC4 cannot draw a relation between an element and its own descendant',
      },
      {
        relationId: 'ui-reports-to-shop',
        from: 'cart-ui',
        to: 'shop',
        reason: 'descendant',
        message:
          'the relation "ui-reports-to-shop" from "cart-ui" to "shop" is not drawn in the LikeC4 workspace: LikeC4 cannot draw a relation between an element and its own descendant',
      },
    ]);
    expect(workspace).toContain(
      [
        'model {',
        '  loop = service "Loop"',
        '  shop = domain "Shop" {',
        '    cart = service "Cart" {',
        '      cart-ui = module "Cart UI"',
        '    }',
        '  }',
        '',
        '  shop.cart -> loop "calls the loop"',
        '}',
      ].join('\n'),
    );
    expect(validate(workspace!)).toEqual({ files: 1, errors: [] });
  });

  test('a self-relation an engine does draw is still left out and listed once', () => {
    const answers = [{ id: 'loop', kind: 'service' }];
    const engine = handEngine({
      landscape: { elements: answers, relations: [] },
      every: { elements: answers, relations: [{ from: 'loop', to: 'loop', relationIds: ['loop-retries'] }] },
    });
    const { model } = loadModel(fixture('views-likec4-not-drawn'));

    const { workspace, notDrawn } = renderLikeC4Workspace(engine, compileModel(model!));

    expect(workspace).toContain('\nmodel {\n  loop = service "Loop"\n}\n');
    expect(notDrawn!.map((relation) => [relation.relationId, relation.reason])).toEqual([['loop-retries', 'self']]);
  });

  test('a self-relation of an element absent at the asked time is not listed: there is nothing to draw it on', () => {
    const { model } = loadModel(fixture('views-likec4-not-drawn'));
    const compiled = compileModel(model!);
    const engine = handEngine({
      landscape: { elements: [{ id: 'shop', kind: 'domain' }], relations: [] },
      every: { elements: [{ id: 'shop', kind: 'domain' }], relations: [] },
    });

    expect(renderLikeC4Workspace(engine, compiled).notDrawn).toEqual([]);
  });
});

describe('views/likec4 deterministic', () => {
  test('twice: the same model rendered twice, from two engines built apart, gives the same bytes', () => {
    expect(workspaceOf('views-likec4')).toBe(workspaceOf('views-likec4'));
  });
});

function element(id: string, kind: CompiledElement['kind'], parent?: string, name?: string): CompiledElement {
  const compiled: CompiledElement = { id, kind, ancestors: parent === undefined ? [] : [parent], zones: [], zonesByEnvironment: {}, environments: ['*'], states: ['as-is'] };
  if (parent !== undefined) compiled.parent = parent;
  if (name !== undefined) compiled.name = name;
  return compiled;
}

function modelOf(elements: CompiledElement[], relations: CompiledRelation[] = []): CompiledModel {
  return { schemaVersion: 1, elements, relations, interfaces: [], categories: [], zones: [], environments: [], states: [] };
}

type Answer = { elements?: object[]; neighbours?: object[]; relations?: object[]; error?: object };

/** A query engine answering from lists given by hand: `landscape` at depth 0, `every` unscoped any deeper, `scoped` (or an empty view) for a scope. */
function handEngine(answers: { landscape: Answer; every: Answer; scoped?: (scope: string) => Answer }): QueryEngine {
  return {
    view: (input: { scope?: string; depth: number }) =>
      input.scope !== undefined ? (answers.scoped?.(input.scope) ?? { elements: [], neighbours: [], relations: [] }) : input.depth === 0 ? answers.landscape : answers.every,
  } as unknown as QueryEngine;
}

describe('views/likec4 identifiers', () => {
  test('every word LikeC4 reads as a keyword where an identifier stands, and "index", gets a trailing underscore, and the workspace validates', () => {
    // Keywords LikeC4 1.59.4's grammar has that its identifier rule does not
    // accept (found by validating each one as an element and a view name),
    // with "index", the landscape's view.
    const keywords = [
      'BottomTop', 'LeftRight', 'RightLeft', 'TopBottom', 'and', 'autoLayout', 'border', 'color', 'deploymentNode', 'description', 'dynamic',
      'dynamicPredicateGroup', 'exclude', 'extend', 'extends', 'from', 'global', 'head', 'icon', 'iconColor', 'iconPosition', 'iconSize', 'icons',
      'import', 'include', 'includeAncestors', 'index', 'instanceOf', 'is', 'it', 'kind', 'likec4lib', 'line', 'link', 'metadata', 'multiple',
      'navigateTo', 'not', 'notation', 'notes', 'of', 'opacity', 'or', 'order', 'padding', 'predicate', 'predicateGroup', 'rank', 'rgb', 'rgba',
      'shape', 'size', 'specification', 'style', 'styleGroup', 'summary', 'tag', 'tail', 'technology', 'textSize', 'this', 'title', 'variant',
      'views', 'where', 'with',
    ];
    const elements = keywords.flatMap((word) => [element(word, 'domain'), element(`${word}-x`, 'service', word)]);
    const answers = elements.map(({ id, kind, parent }) => (parent === undefined ? { id, kind } : { id, kind, parent }));
    const engine = handEngine({ landscape: { elements: answers.filter((a) => !('parent' in a)), relations: [] }, every: { elements: answers, relations: [] } });

    const { workspace, errors } = renderLikeC4Workspace(engine, modelOf(elements));

    expect(errors).toEqual([]);
    for (const word of keywords) expect(workspace).toContain(`\n  view ${word}_ of ${word}_ {\n`);
    expect(validate(workspace!)).toEqual({ files: 1, errors: [] });
  });

  test('a keyword in another case, a word only starting like a keyword, and "view" or "model" stay as they are', () => {
    const elements = [element('Style', 'domain'), element('styles', 'domain'), element('view', 'domain'), element('model', 'domain')];
    const answers = elements.map(({ id, kind }) => ({ id, kind }));
    const engine = handEngine({ landscape: { elements: answers, relations: [] }, every: { elements: answers, relations: [] } });

    const { workspace } = renderLikeC4Workspace(engine, modelOf(elements));

    expect(workspace).toContain('\nmodel {\n  Style = domain "Style"\n  model = domain "model"\n  styles = domain "styles"\n  view = domain "view"\n}\n');
  });

  test('clashing identifiers take _2, _3, ... in code point order of the element ids; a leading digit gets a leading underscore', () => {
    const ids = ['a.b', 'a_b', 'a-b', '9.b', '9_b'];
    const elements = ids.map((id) => element(id, 'service'));
    const answers = elements.map(({ id, kind }) => ({ id, kind }));
    const engine = handEngine({ landscape: { elements: answers, relations: [] }, every: { elements: answers, relations: [] } });

    const { workspace } = renderLikeC4Workspace(engine, modelOf(elements));

    // "9.b" and "9_b" both become "_9_b"; "a-b" (0x2D) sorts before "a.b" (0x2E), and "a_b" is an identifier as it stands.
    expect(workspace).toContain(
      '\nmodel {\n  _9_b = service "9.b"\n  _9_b_2 = service "9_b"\n  a-b = service "a-b"\n  a_b_2 = service "a.b"\n  a_b = service "a_b"\n}\n',
    );
  });

  test('every control character LikeC4 has an escape for is escaped; the others stay as they are', () => {
    const elements = [element('a', 'service', undefined, 'q"b\\ \b\f\n\r\t\v\u0000\u0001\u007f end')];
    const engine = handEngine({ landscape: { elements: [{ id: 'a', kind: 'service' }], relations: [] }, every: { elements: [{ id: 'a', kind: 'service' }], relations: [] } });

    const { workspace } = renderLikeC4Workspace(engine, modelOf(elements));

    expect(workspace).toContain('\n  a = service "q\\"b\\\\ \\b\\f\\n\\r\\t\\v\\0\u0001\u007f end"\n');
    expect(validate(workspace!)).toEqual({ files: 1, errors: [] });
  });
});

describe('views/likec4 refuses what it cannot render whole', () => {
  test("the view set's errors are the workspace's, and no workspace comes back", () => {
    const refusing = { message: 'refused' };
    const engine = handEngine({ landscape: { error: refusing }, every: { elements: [], relations: [] } });

    expect(renderLikeC4Workspace(engine, modelOf([]))).toStrictEqual({ errors: [{ message: 'the landscape: refused', query: refusing }] });
  });

  test("a view set error keeps the view and the relation it names", () => {
    const top = element('top', 'domain');
    const engine = handEngine({
      landscape: { elements: [{ id: 'top', kind: 'domain' }], relations: [] },
      every: { elements: [{ id: 'top', kind: 'domain' }, { id: 'low', kind: 'service', parent: 'top' }], relations: [] },
      scoped: () => ({ elements: [], neighbours: [], relations: [{ from: 'low', to: 'top', relationIds: ['ghost'] }] }),
    });

    expect(renderLikeC4Workspace(engine, modelOf([top, element('low', 'service', 'top')]))).toStrictEqual({
      errors: [
        {
          message: 'the view of "top": the arrow from "low" to "top" stands for the relation "ghost", which the compiled model does not hold',
          scope: 'top',
          relationId: 'ghost',
        },
      ],
    });
  });

  test('the question for every element and relation refusing is named, and no workspace comes back', () => {
    // The view set asks first and is answered; the workspace's own question is refused.
    let asked = 0;
    const refusing = { message: 'refused' };
    const engine = {
      view: (input: { depth: number }) => (input.depth === 0 || ++asked === 1 ? { elements: [], relations: [] } : { error: refusing }),
    } as unknown as QueryEngine;

    expect(renderLikeC4Workspace(engine, modelOf([]))).toStrictEqual({ errors: [{ message: 'the workspace: every element and relation: refused', query: refusing }] });
  });

  test('an element or a relation the engine answers but the compiled model does not hold is an error naming it, and no workspace comes back', () => {
    const engine = handEngine({
      landscape: { elements: [{ id: 'a', kind: 'service' }, { id: 'ghost', kind: 'service' }], relations: [] },
      every: {
        elements: [{ id: 'a', kind: 'service' }, { id: 'ghost', kind: 'service' }],
        relations: [{ from: 'a', to: 'ghost', relationIds: ['a-calls', 'lost'] }],
      },
    });
    const model = modelOf(
      [element('a', 'service')],
      [{ id: 'a-calls', name: 'calls', from: 'a', to: 'ghost', interaction: false, environments: ['*'], states: ['as-is'] }],
    );

    expect(renderLikeC4Workspace(engine, model)).toStrictEqual({
      errors: [
        { message: 'the workspace: the element "ghost" is shown by the query engine but the compiled model does not hold it', elementId: 'ghost' },
        { message: 'the workspace: the arrow from "a" to "ghost" stands for the relation "lost", which the compiled model does not hold', relationId: 'lost' },
      ],
    });
  });
});

describe("the reference system's committed LikeC4 workspace", () => {
  test('rendering examples/reference-system again gives exactly the committed model.c4, and it validates', () => {
    const { workspace, notDrawn, errors } = renderReferenceSystem();
    expect(errors).toEqual([]);
    expect(notDrawn).toEqual([]);

    expect(readFileSync(LIKEC4_FILE, 'utf8')).toBe(workspace!);
    expect(checkLikeC4Workspaces([join(LIKEC4_FILE, '..')])).toEqual({ files: 1, errors: [] });
  });
});
