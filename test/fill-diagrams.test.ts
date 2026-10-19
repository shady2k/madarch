/**
 * The graph's diagram models (madarch-tzte.23.2; decision 0026, "Diagrams"): a
 * view specification read against the graph, drawn as a model a renderer
 * carries — facts solid, assumptions and unresolved ends dashed, every element
 * linking its page and its code place, and a view past its node budget collapsed
 * to the level above with the view it stands for as its drill-down link.
 *
 * Every expectation here is taken from the task, from 0026 and from the schema's
 * own kinds, never from the module: 0026's nine types and the seven the schema
 * answers, the dashes its "Solid lines are facts, dashed are assumptions or
 * unresolved" fixes, and the labels `graph-reads.ts` gives a node. The graph is
 * one this test makes with the schema's constructors and holds in memory
 * (`readsOf`), so nothing here reads this checkout; `fill-diagrams-store.test.ts`
 * runs the same models through the landed fact store.
 */
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_DIAGRAM_NODE_BUDGET,
  DIAGRAM_TYPES,
  UNRESOLVED_PREFIX,
  buildDiagram,
  diagramHref,
  graphPageHref,
  type DiagramGraphReads,
  type DiagramModel,
  type DiagramViewSpec,
} from '../src/fill/diagrams.js';
import { DIAGRAM_FIXTURE, readsOf } from './fill-diagram-fixture.js';

/** The fixture's graph, and the same graph with the edge into the file no unit holds left out — the normally published one. */
const fx = DIAGRAM_FIXTURE;
const clean = readsOf(fx.facts.filter((fact) => fact.id !== fx.orphanImportsGone.id));
const full = readsOf(fx.facts);

/** The labels of a model's elements, in the order the model holds them. */
function labels(model: DiagramModel): readonly string[] {
  return model.elements.map((element) => element.label);
}

/** One arrow as a line a test compares, its own words and how it stands. */
function arrowLine(arrow: DiagramModel['edges'][number]): string {
  return `${arrow.label}|${arrow.evidence}|${String(arrow.dashed)}`;
}

describe('module dependencies', () => {
  test('two modules and the one import between them are two elements and one solid edge', async () => {
    const model = await buildDiagram({ type: 'module-dependency', nodes: [fx.shop.id] }, clean);
    expect(model.type).toBe('module-dependency');
    expect(model.level).toBe(1);
    expect(model.title).toBe('Module dependencies: acme-shop');
    expect(labels(model)).toEqual(['checkout', 'payment']);
    expect(model.edges.map((arrow) => [arrow.from, arrow.to])).toEqual([[fx.checkout.id, fx.payment.id]]);
    expect(model.edges.map(arrowLine)).toEqual(['import|fact|false']);
    expect(model.edges[0]!.kinds).toEqual(['import']);
    expect(model.edges[0]!.facts).toEqual([fx.cartImportsPay.id]);
    expect(model.collapsed).toBe(false);
    expect(model.marker).toBeNull();
    expect(model.nodes).toEqual([fx.shop.id]);
  });

  test('a scope with no module below it is drawn as itself', async () => {
    const model = await buildDiagram({ type: 'module-dependency', nodes: [fx.checkout.id] }, clean);
    expect(labels(model)).toEqual(['checkout']);
    expect(model.elements[0]!.id).toBe(fx.checkout.id);
    expect(model.edges).toEqual([]);
  });

  test('the whole product draws every repository\'s top-level modules, in label order', async () => {
    const model = await buildDiagram({ type: 'module-dependency', nodes: [] }, clean);
    expect(model.title).toBe('Module dependencies: the whole product');
    expect(labels(model)).toEqual(['checkout', 'payment', 'web-api', 'web-app', 'web-shared']);
  });

  test('an import whose file no unit holds any more is an unresolved end, drawn dashed', async () => {
    const model = await buildDiagram({ type: 'module-dependency', nodes: [fx.shop.id] }, full);
    const unresolved = model.elements.find((element) => element.kind === null);
    expect(unresolved?.id).toBe(`${UNRESOLVED_PREFIX}${fx.gone.id}`);
    expect(unresolved?.evidence).toBe('unresolved');
    expect(unresolved?.dashed).toBe(true);
    expect(unresolved?.page).toBeUndefined();
    const arrows = model.edges.filter((arrow) => arrow.to === unresolved?.id);
    expect(arrows.map(arrowLine)).toEqual(['import|unresolved|true']);
  });
});

describe('C4 views', () => {
  test('the context is the product\'s repositories, and an import across them is one solid arrow', async () => {
    const model = await buildDiagram({ type: 'c4-context', nodes: [] }, clean);
    expect(model.type).toBe('c4-context');
    expect(model.level).toBe(1);
    expect(model.title).toBe('C4 context: the whole product');
    expect(labels(model)).toEqual(['acme-shop', 'acme-web']);
    expect(model.edges.map((arrow) => [arrow.from, arrow.to, arrowLine(arrow)])).toEqual([[fx.web.id, fx.shop.id, 'import|fact|false']]);
    // An import inside one repository is a relation inside it: it is not drawn between a repository and itself.
    expect(model.edges).toHaveLength(1);
  });

  test('the containers of a repository are its packages and tables, with the dependencies the graph holds between them', async () => {
    const model = await buildDiagram({ type: 'c4-container', nodes: [fx.shop.id] }, clean);
    expect(model.level).toBe(2);
    expect(model.title).toBe('C4 containers: acme-shop');
    expect(labels(model)).toEqual(['acme-shop:@acme/checkout', 'acme-shop:@acme/payments', 'acme-shop:public.orders', 'acme-shop:public.payments']);
    expect(model.elements.map((element) => element.kind)).toEqual(['package', 'package', 'table', 'table']);
    expect(model.edges.map((arrow) => [arrow.from, arrow.to, arrowLine(arrow)])).toEqual([[fx.checkoutPackage.id, fx.paymentsPackage.id, 'dependency|fact|false']]);
  });

  test('the components of a repository are its modules, and an agent interaction between them is dashed', async () => {
    const model = await buildDiagram({ type: 'c4-component', nodes: [fx.shop.id] }, clean);
    expect(model.level).toBe(3);
    expect(labels(model)).toEqual(['checkout', 'payment']);
    // Every import and every interaction of the two modules is one arrow of the view, each way: the facts of one pair
    // are folded into one arrow, and the weakest of them is what the arrow stands on.
    const named = new Map(model.elements.map((element) => [element.id, element.label]));
    const drawn = (arrow: DiagramModel['edges'][number]): string => `${String(named.get(arrow.from))}>${String(named.get(arrow.to))}:${arrow.label}:${arrow.evidence}`;
    expect(model.edges.map(drawn).sort()).toEqual([
      'checkout>payment:import, interaction:assumption',
      'payment>checkout:interaction:assumption',
    ]);
    const forwards = model.edges.find((arrow) => arrow.from === fx.checkout.id)!;
    expect(forwards.kinds).toEqual(['import', 'interaction']);
    expect(forwards.facts).toEqual([fx.cartImportsPay.id, fx.placeCalls.id].sort());
  });
});

describe('an entity-relationship view', () => {
  test('the tables of a repository carry their columns, and a column whose table no fact holds makes it dashed', async () => {
    const model = await buildDiagram({ type: 'er', nodes: [fx.shop.id] }, clean);
    expect(model.title).toBe('Data model: acme-shop');
    expect(labels(model)).toEqual(['acme-shop:public.audit', 'acme-shop:public.orders', 'acme-shop:public.payments']);
    expect(model.edges).toEqual([]);
    const orders = model.elements.find((element) => element.id === fx.ordersTable.id);
    expect(orders?.columns?.map((column) => column.label)).toEqual(['id', 'total']);
    expect(orders?.columns?.map((column) => column.dataType)).toEqual(['bigint', 'numeric']);
    expect(orders?.columns?.[0]?.page?.href).toBe(`/p/graph/${fx.columns[0]!.id}`);
    expect(orders?.columns?.[0]?.place).toEqual({ repository: 'acme-shop', commit: 'a'.repeat(40), file: 'migrations/001.sql', line: 4, endLine: 4 });
    const audit = model.elements.find((element) => element.label === 'acme-shop:public.audit');
    expect(audit?.kind).toBeNull();
    expect(audit?.evidence).toBe('unresolved');
    expect(audit?.dashed).toBe(true);
    expect(audit?.columns?.map((column) => column.label)).toEqual(['id']);
  });

  test('a repository with no table is an empty model and not an error', async () => {
    const model = await buildDiagram({ type: 'er', nodes: [fx.web.id] }, clean);
    expect(model.elements).toEqual([]);
    expect(model.edges).toEqual([]);
    expect(model.marker).toBeNull();
    expect(model.title).toBe('Data model: acme-web');
  });
});

describe('a state view', () => {
  test('the states of the machine and their transitions, each arrow named by its event and dashed as an agent read it', async () => {
    const model = await buildDiagram({ type: 'state', nodes: [fx.newState.id] }, clean);
    expect(model.title).toBe('States: OrderStatus.new');
    expect(labels(model)).toEqual(['OrderStatus.new', 'OrderStatus.paid', 'OrderStatus.shipped', fx.refundedState.id]);
    expect(model.edges.map(arrowLine).sort()).toEqual(['pay|assumption|true', 'refund|unresolved|true', 'ship|assumption|true']);
    const refund = model.edges.find((arrow) => arrow.label === 'refund');
    expect(refund?.to).toBe(`${UNRESOLVED_PREFIX}${fx.refundedState.id}`);
    // A transition is one fact: the arrow carries it and nothing else, and its place is the transition's own.
    expect(refund?.facts).toEqual([fx.refundTransition.id]);
    expect(model.elements.find((element) => element.id === `${UNRESOLVED_PREFIX}${fx.refundedState.id}`)?.kind).toBeNull();
  });

  test('a repository draws every machine its states belong to', async () => {
    const model = await buildDiagram({ type: 'state', nodes: [fx.shop.id] }, clean);
    expect(labels(model)).toEqual(['OrderStatus.new', 'OrderStatus.paid', 'OrderStatus.shipped', fx.refundedState.id]);
    expect(model.title).toBe('States: acme-shop');
  });
});

describe('a sequence view', () => {
  test('the scenario\'s steps are drawn in its order, each named by what carries it', async () => {
    const model = await buildDiagram({ type: 'sequence', nodes: [fx.placeSymbol.id, fx.chargeSymbol.id], scenario: [fx.settled.id, fx.placeCalls.id] }, clean);
    expect(model.title).toBe('Sequence: acme-shop:src/cart.ts#CheckoutController.place, acme-shop:src/pay.ts#PaymentGateway.charge');
    expect(labels(model)).toEqual(['acme-shop:src/cart.ts#CheckoutController.place', 'acme-shop:src/pay.ts#PaymentGateway.charge']);
    expect(model.edges.map((arrow) => [arrow.step, arrow.from, arrow.to, arrow.label])).toEqual([
      [1, fx.chargeSymbol.id, fx.placeSymbol.id, 'payment-settled'],
      [2, fx.placeSymbol.id, fx.chargeSymbol.id, 'POST /payments'],
    ]);
    expect(model.edges.map(arrowLine)).toEqual(['payment-settled|assumption|true', 'POST /payments|assumption|true']);
    expect(model.scenario).toEqual([fx.settled.id, fx.placeCalls.id]);
  });

  test('a sequence that names no participant takes them from its scenario, and one that names neither is refused', async () => {
    const fromScenario = await buildDiagram({ type: 'sequence', nodes: [], scenario: [fx.placeCalls.id] }, clean);
    expect(labels(fromScenario)).toEqual(['acme-shop:src/cart.ts#CheckoutController.place', 'acme-shop:src/pay.ts#PaymentGateway.charge']);
    expect(fromScenario.edges.map((arrow) => [arrow.step, arrow.label])).toEqual([[1, 'POST /payments']]);
    await expect(buildDiagram({ type: 'sequence', nodes: [] }, clean)).rejects.toThrow(/the view names no participant and no scenario/);
  });

  test('a view with no scenario draws every interaction between its participants, by the code point order of their ends', async () => {
    const model = await buildDiagram({ type: 'sequence', nodes: [fx.placeSymbol.id, fx.chargeSymbol.id] }, clean);
    expect(model.edges.map((arrow) => arrow.step)).toEqual([undefined, undefined]);
    // The order is the one the module documents — each arrow's two ends in code point order — so the expectation is
    // built from that rule and not from what the model answered.
    const expected = [
      `${fx.chargeSymbol.id}>${fx.placeSymbol.id}:payment-settled`,
      `${fx.placeSymbol.id}>${fx.chargeSymbol.id}:POST /payments`,
    ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    expect(model.edges.map((arrow) => `${arrow.from}>${arrow.to}:${arrow.label}`)).toEqual(expected);
  });
});

describe('the size of a view', () => {
  test('past its node budget a view collapses to the level above, and each element links what it stands for', async () => {
    const model = await buildDiagram({ type: 'module-dependency', nodes: [fx.web.id] }, clean, { limits: { nodes: 2 } });
    expect(labels(model)).toEqual(['acme-web']);
    expect(model.collapsed).toBe(true);
    expect(model.marker).toBe('collapsed: the view holds 3 elements and the 2-element budget holds 1: each element stands for the level above it, and its link opens the view it stands for');
    const stood = [fx.webApp.id, fx.webApi.id, fx.webShared.id].sort();
    expect(model.elements[0]!.standsFor).toEqual(stood);
    expect(model.elements[0]!.drillDown).toEqual({
      type: 'module-dependency',
      level: 1,
      nodes: stood,
      href: diagramHref({ type: 'module-dependency', level: 1, nodes: stood }),
    });
    expect(model.elements[0]!.drillDown?.href).toContain('diagram=module-dependency');
  });

  test('a view no element of which has a level above it says the budget was not met instead of drawing fewer nodes', async () => {
    const model = await buildDiagram({ type: 'state', nodes: [fx.newState.id] }, clean, { limits: { nodes: 1 } });
    expect(model.collapsed).toBe(false);
    expect(model.marker).toBe('truncated: the view holds 4 elements and the 1-element budget holds 4: no element of it has a level above it in the graph');
    expect(model.elements).toHaveLength(4);
  });

  test('a view that collapses and still does not fit says the budget was not met, and how many elements it holds', async () => {
    // Five modules of two repositories collapse twice: to the two repositories, and no further, because a repository has
    // no level above it. A one-element budget is not met, and the marker says so rather than claiming it.
    const model = await buildDiagram({ type: 'module-dependency', nodes: [] }, clean, { limits: { nodes: 1 } });
    expect(model.collapsed).toBe(true);
    expect(labels(model)).toEqual(['acme-shop', 'acme-web']);
    expect(model.marker).toBe('truncated: the view holds 5 elements and the 1-element budget holds 2: no element of it has a level above it in the graph');
  });

  test('a container view collapses to its repositories, and the drill-down it writes is a view this module builds', async () => {
    const model = await buildDiagram({ type: 'c4-container', nodes: [fx.shop.id] }, clean, { limits: { nodes: 3 } });
    expect(labels(model)).toEqual(['acme-shop']);
    expect(model.collapsed).toBe(true);
    const drill = model.elements[0]!.drillDown!;
    expect(drill.nodes).toEqual([fx.checkoutPackage.id, fx.paymentsPackage.id, fx.ordersTable.id, fx.paymentsTable.id].sort());
    // The drill-down is a spec of this module's own: read back, it draws the containers it stands for.
    const below = await buildDiagram({ type: drill.type, nodes: drill.nodes, level: drill.level }, clean, { limits: { nodes: 40 } });
    expect(labels(below)).toEqual(['acme-shop:@acme/checkout', 'acme-shop:@acme/payments', 'acme-shop:public.orders', 'acme-shop:public.payments']);
    expect(below.collapsed).toBe(false);
  });

  test('a container view inside its budget says nothing about its size', async () => {
    const model = await buildDiagram({ type: 'module-dependency', nodes: [fx.shop.id] }, clean, { limits: { nodes: 2 } });
    expect(model.collapsed).toBe(false);
    expect(model.marker).toBeNull();
    expect(labels(model)).toEqual(['checkout', 'payment']);
  });

  test('a budget below one element is refused by name', async () => {
    await expect(buildDiagram({ type: 'module-dependency', nodes: [] }, clean, { limits: { nodes: 0 } })).rejects.toThrow(/the node budget is 0: a diagram holds at least one element/);
  });

  test('the default budget is the module\'s own and clears a small view', async () => {
    expect(DEFAULT_DIAGRAM_NODE_BUDGET).toBe(40);
    const model = await buildDiagram({ type: 'module-dependency', nodes: [fx.shop.id] }, clean);
    expect(model.elements.length).toBeLessThanOrEqual(DEFAULT_DIAGRAM_NODE_BUDGET);
  });
});

describe('what every element carries', () => {
  test('each element links its page, and each fact that stands in code carries that place', async () => {
    for (const spec of [
      { type: 'c4-context', nodes: [] },
      { type: 'c4-container', nodes: [fx.shop.id] },
      { type: 'c4-component', nodes: [fx.shop.id] },
      { type: 'er', nodes: [fx.shop.id] },
      { type: 'module-dependency', nodes: [fx.shop.id] },
      { type: 'state', nodes: [fx.shop.id] },
      { type: 'sequence', nodes: [fx.placeSymbol.id, fx.chargeSymbol.id] },
    ] as const satisfies readonly DiagramViewSpec[]) {
      const model = await buildDiagram(spec, clean);
      expect(model.elements.length).toBeGreaterThan(0);
      for (const element of model.elements) {
        expect(element.dashed).toBe(element.evidence !== 'fact');
        // An end the graph does not hold is a placeholder: it is dashed, and it has neither a page to open nor a place.
        if (element.kind === null) {
          expect(element.evidence).toBe('unresolved');
          expect(element.page).toBeUndefined();
          expect(element.place).toBeUndefined();
          continue;
        }
        expect(element.page?.id).toBe(element.id);
        expect(element.page?.href).toBe(graphPageHref(element.id));
        // A place is the fact's own code position: the repository and the commit a reader opens it at, the file and the
        // lines. A fact whose provenance names none carries none, which the assertion below covers.
        if (element.place !== undefined) {
          expect(element.place.repository).toBe('acme-shop');
          expect(element.place.file).not.toBe('');
        }
      }
    }
  });

  test('an element whose fact stands at no place carries none, and the one beside it carries its own', async () => {
    const model = await buildDiagram({ type: 'c4-context', nodes: [] }, clean);
    expect(model.elements.find((element) => element.id === fx.web.id)?.place).toBeUndefined();
    expect(model.elements.find((element) => element.id === fx.shop.id)?.place).toEqual({ repository: 'acme-shop', commit: 'a'.repeat(40), file: 'README.md', line: 1, endLine: 1 });
  });

  test('an arrow carries the code place of the first fact behind it, where a reader checks the relation', async () => {
    const model = await buildDiagram({ type: 'module-dependency', nodes: [fx.shop.id] }, clean);
    expect(model.edges[0]!.place).toEqual({ repository: 'acme-shop', commit: 'a'.repeat(40), file: 'src/cart.ts', line: 3, endLine: 3 });
  });

  test('an element\'s code place is the fact\'s own file and lines', async () => {
    const model = await buildDiagram({ type: 'module-dependency', nodes: [fx.shop.id] }, clean);
    const checkout = model.elements.find((element) => element.id === fx.checkout.id);
    expect(checkout?.place).toEqual({ repository: 'acme-shop', commit: 'a'.repeat(40), file: 'src/cart.ts', line: 1, endLine: 1 });
  });

  test('a page\'s address is the node\'s fact id, and a view\'s address names its type, its level and its nodes', async () => {
    expect(graphPageHref(fx.cart.id)).toBe(`/p/graph/${fx.cart.id}`);
    expect(diagramHref({ type: 'c4-context', level: 1, nodes: [fx.web.id, fx.shop.id] })).toBe(`/p/graph?diagram=c4-context&level=1&node=${fx.shop.id}&node=${fx.web.id}`);
    expect(() => graphPageHref('not-a-fact-id')).toThrow(/is no fact id/);
  });
});

describe('a view the graph does not answer', () => {
  test('a node the graph holds no fact of is refused by name', async () => {
    const missing = `module:${'f'.repeat(64)}`;
    await expect(buildDiagram({ type: 'module-dependency', nodes: [missing] }, clean)).rejects.toThrow(new RegExp(`the view names the node "${missing}" and the graph holds no fact of that id`));
  });

  test('a node of a kind the type cannot be made of is refused with the kinds it takes', async () => {
    await expect(buildDiagram({ type: 'module-dependency', nodes: [fx.cart.id] }, clean)).rejects.toThrow(/for the module-dependency diagram: a module-dependency view is scoped by module, repository, and a file is none of them/);
  });

  test('an edge named as a node is refused', async () => {
    await expect(buildDiagram({ type: 'er', nodes: [fx.cartImportsPay.id] }, clean)).rejects.toThrow(/which is a import edge: an edge is no node a diagram is scoped by/);
  });

  test('a level on a type that has none is refused, and so is another level of a C4 type', async () => {
    await expect(buildDiagram({ type: 'er', nodes: [], level: 2 }, clean)).rejects.toThrow(/er has no level — the levels are the C4 types' own/);
    await expect(buildDiagram({ type: 'c4-context', nodes: [], level: 2 }, clean)).rejects.toThrow(/that type is level 1, and another level is another type of diagram/);
  });

  test('a scenario on any type but a sequence is refused', async () => {
    await expect(buildDiagram({ type: 'state', nodes: [], scenario: [fx.payTransition.id] }, clean)).rejects.toThrow(/a scenario is a sequence diagram's steps, and no other type takes one/);
  });

  test('a scenario step that is not an interaction, one outside the view, and one named twice are each refused', async () => {
    await expect(buildDiagram({ type: 'sequence', nodes: [fx.placeSymbol.id, fx.chargeSymbol.id], scenario: [fx.cartImportsPay.id] }, clean)).rejects.toThrow(/a fact of kind import: a sequence diagram's steps are interactions/);
    await expect(buildDiagram({ type: 'sequence', nodes: [fx.placeSymbol.id], scenario: [fx.placeCalls.id] }, clean)).rejects.toThrow(/which the view does not name as a participant/);
    await expect(buildDiagram({ type: 'sequence', nodes: [fx.placeSymbol.id, fx.chargeSymbol.id], scenario: [fx.placeCalls.id, fx.placeCalls.id] }, clean)).rejects.toThrow(/twice: an interaction is one fact of the graph/);
  });

  test('a malformed spec is refused field by field', async () => {
    await expect(buildDiagram({ type: 'module-dependency', nodes: [fx.shop.id, fx.shop.id] }, clean)).rejects.toThrow(/twice: a view's nodes are a set, each named once/);
    await expect(buildDiagram({ type: 'module-dependency', nodes: ['acme-shop'] }, clean)).rejects.toThrow(/a node is a fact id/);
    await expect(buildDiagram({ type: 'module-dependency', nodes: [], level: 0 }, clean)).rejects.toThrow(/a level is a whole number, at least 1/);
    await expect(buildDiagram({ type: 'activity' } as unknown as DiagramViewSpec, clean)).rejects.toThrow(/the view names the diagram type "activity": the types this module draws are/);
    await expect(buildDiagram(null as unknown as DiagramViewSpec, clean)).rejects.toThrow(/the view is null: a view specification is an object/);
    await expect(buildDiagram('c4-context' as unknown as DiagramViewSpec, clean)).rejects.toThrow(/the view is "c4-context": a view specification is an object/);
  });

  test('the types drawn are the seven the schema answers, in code point order', () => {
    expect([...DIAGRAM_TYPES]).toEqual(['c4-component', 'c4-container', 'c4-context', 'er', 'module-dependency', 'sequence', 'state']);
  });
});

describe('the same view twice', () => {
  test('a model is the same model at every build: elements by label, arrows by their ends', async () => {
    const once = await buildDiagram({ type: 'c4-component', nodes: [fx.shop.id] }, full, { limits: { nodes: 40 } });
    const twice = await buildDiagram({ type: 'c4-component', nodes: [fx.shop.id] }, full, { limits: { nodes: 40 } });
    expect(twice).toEqual(once);
    expect(once.elements.map((element) => element.label)).toEqual([...once.elements.map((element) => element.label)].sort());
  });
});
