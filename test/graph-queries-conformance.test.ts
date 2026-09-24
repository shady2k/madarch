import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import {
  compileModel,
  createLadybugEngine,
  createSqliteHistory,
  loadModel,
  type Clock,
  type CompiledElement,
  type CompiledModel,
  type CompiledRelation,
  type ElementKind,
  type HistoryStore,
  type QueryEngine,
} from '../src/index.js';

function element(id: string, kind: ElementKind, parent?: string): CompiledElement {
  const compiled: CompiledElement = { id, kind, ancestors: parent === undefined ? [] : [parent], zones: [], zonesByEnvironment: {}, environments: ['*'], states: ['as-is'] };
  if (parent !== undefined) compiled.parent = parent;
  return compiled;
}

function relation(id: string, from: string, to: string): CompiledRelation {
  return { id, from, to, interaction: false, environments: ['*'], states: ['as-is'] };
}

function model(elements: CompiledElement[], relations: CompiledRelation[]): CompiledModel {
  return { schemaVersion: 1, elements, interfaces: [], relations, categories: [], zones: [], environments: [], states: [{ id: 'as-is' }] };
}

/**
 * The review's five end-to-end conformance scenarios (graph-queries.md's
 * `collapse`, `refinement-counted-once`, `inside-one-box`,
 * `transitive-dependents`, plus the intended-model capability's
 * `service-gains-internal-elements`, checked here through the view query
 * per stage3-brief.md): from a YAML fixture folder, through `loadModel` and
 * `compileModel`, stored in the (SQLite) model history with a fake clock,
 * to a `QueryEngine` built from that history's own `assertions()` — never
 * from the compiled model directly, so this also exercises `rebuild`.
 */
function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

function fakeClock(initial: number): Clock & { set(t: number): void } {
  let current = initial;
  return { now: () => current, set: (t: number) => (current = t) };
}

const DAY = (day: number) => Date.UTC(2026, 8, day);

/** Loads and compiles a fixture, stores it as one source's one commit, and builds a query engine from the history it produced. */
function engineFor(fixtureName: string, commit: string, committedAt: number, storedAt: number): { engine: QueryEngine; history: HistoryStore } {
  const { model, errors } = loadModel(fixture(fixtureName));
  expect(errors).toEqual([]);
  const compiled = compileModel(model!);

  const clock = fakeClock(storedAt);
  const history = createSqliteHistory({ clock });
  const stored = history.store({ source: 's', commit, committedAt, model: compiled });
  expect(stored.errors).toEqual([]);

  const engine = createLadybugEngine();
  engine.rebuild(history.assertions());
  return { engine, history };
}

describe('the graph-queries capability, end to end from YAML fixtures to query answers', () => {
  test('collapse: two modules calling one service, viewed at the depth of services, show one relation with both calls behind it', () => {
    const { engine, history } = engineFor('gq-collapse', 'c1', DAY(1), DAY(2));
    const at = { valid: DAY(2), known: DAY(2), state: 'as-is' };

    const result = engine.view({ depth: 0 }, at);
    expect(result.error).toBeUndefined();
    expect(result.elements?.map((e) => e.id).sort()).toEqual(['checkout-web', 'payments-api']);
    expect(result.relations).toEqual([{ from: 'checkout-web', to: 'payments-api', relationIds: ['cart-calls-payments', 'ui-calls-payments'] }]);

    engine.close();
    history.close();
  });

  test('refinement-drawn-when-distinct: a refinement is drawn on its own once its own lifted pair differs from the relation it refines, alongside that relation', () => {
    const { engine, history } = engineFor('gq-refinement-once', 'c1', DAY(1), DAY(2));
    const at = { valid: DAY(2), known: DAY(2), state: 'as-is' };

    // Depth 1 (domains and services): checkout-cart (a module) is hidden
    // and lifts to checkout-web, but payments-api (a service) is itself
    // shown — the refinement's own pair (checkout-web, payments-api)
    // already differs from the general relation's (checkout-web, payments),
    // so both are drawn (the coordinator's reading of graph-queries/view,
    // design.md "Readings decided during the run").
    const atDepth1 = engine.view({ depth: 1 }, at);
    expect(atDepth1.error).toBeUndefined();
    expect(atDepth1.relations).toEqual([
      { from: 'checkout-web', to: 'payments', relationIds: ['checkout-uses-payments'] },
      { from: 'checkout-web', to: 'payments-api', relationIds: ['checkout-charges-card'] },
    ]);

    // Depth 2 (down to modules): checkout-cart is shown too now, so the
    // refinement draws its own full-detail pair, checkout-cart to
    // payments-api, beside the general relation it refines.
    const atDepth2 = engine.view({ depth: 2 }, at);
    expect(atDepth2.error).toBeUndefined();
    expect(atDepth2.relations).toEqual([
      { from: 'checkout-cart', to: 'payments-api', relationIds: ['checkout-charges-card'] },
      { from: 'checkout-web', to: 'payments', relationIds: ['checkout-uses-payments'] },
    ]);

    engine.close();
    history.close();
  });

  test('inside-one-box: a relation whose ends both lift to the same shown service is not drawn', () => {
    const { engine, history } = engineFor('gq-inside-one-box', 'c1', DAY(1), DAY(2));
    const at = { valid: DAY(2), known: DAY(2), state: 'as-is' };

    const result = engine.view({ depth: 0 }, at);
    expect(result.error).toBeUndefined();
    expect(result.elements?.map((e) => e.id)).toEqual(['checkout-web']);
    expect(result.relations).toEqual([]);

    engine.close();
    history.close();
  });

  test('transitive-dependents: checkout-web depends on event-bus through two relations, orders-api through one', () => {
    const { engine, history } = engineFor('gq-transitive-dependents', 'c1', DAY(1), DAY(2));
    const at = { valid: DAY(2), known: DAY(2), state: 'as-is' };

    const result = engine.dependents('event-bus', { transitive: true }, at);
    expect(result.error).toBeUndefined();
    const byId = new Map(result.elements?.map((e) => [e.id, e.chain]));
    expect(byId.get('orders-api')).toEqual(['orders-publishes']);
    expect(byId.get('checkout-web')).toEqual(['checkout-calls-orders', 'orders-publishes']);
    expect(byId.size).toBe(2);

    engine.close();
    history.close();
  });

  test('service-gains-internal-elements: two versions of one source in one history — a relation moved to a newly-added internal module still lifts to the same single relation at the service level, before and after', () => {
    const v1 = loadModel(fixture('gq-nesting-v1'));
    expect(v1.errors).toEqual([]);
    const v2 = loadModel(fixture('gq-nesting-v2'));
    expect(v2.errors).toEqual([]);

    // One history, one source, two versions: v2's commit lands after v1's,
    // so the engine (rebuilt from this single history's own assertions)
    // must answer the same view both before and after the second commit —
    // exactly the `rebuild`/`as-of` requirement, not two independent
    // histories compared side by side.
    const clock = fakeClock(DAY(2));
    const history = createSqliteHistory({ clock });
    expect(history.store({ source: 's', commit: 'v1', committedAt: DAY(1), model: compileModel(v1.model!) }).errors).toEqual([]);
    clock.set(DAY(12));
    expect(history.store({ source: 's', commit: 'v2', committedAt: DAY(10), model: compileModel(v2.model!) }).errors).toEqual([]);

    const engine = createLadybugEngine();
    engine.rebuild(history.assertions());

    // Before v2's commit: the relation is still checkout-web's own direct
    // call (checkout-cart, the internal module it later moves to, does not
    // exist yet).
    const before = engine.view({ depth: 0 }, { valid: DAY(5), known: DAY(20), state: 'as-is' });
    expect(before.error).toBeUndefined();
    expect(before.relations).toEqual([{ from: 'checkout-web', to: 'payments-api', relationIds: ['checkout-calls-payments'] }]);

    // After v2's commit: the same relation id now runs from the new
    // internal module, but still lifts to the very same single relation
    // from checkout-web to payments-api.
    const after = engine.view({ depth: 0 }, { valid: DAY(15), known: DAY(20), state: 'as-is' });
    expect(after.error).toBeUndefined();
    expect(after.relations).toEqual([{ from: 'checkout-web', to: 'payments-api', relationIds: ['checkout-calls-payments'] }]);

    expect(after.relations).toEqual(before.relations);

    engine.close();
    history.close();
  });

  test("scoped (M2, the review's fx/scoped fixture): a scoped view shows a refinement whose own general relation reaches outside the scope entirely", () => {
    const { engine, history } = engineFor('gq-scoped', 'c1', DAY(1), DAY(2));
    const at = { valid: DAY(2), known: DAY(2), state: 'as-is' };

    // shop-uses-ui (shop -> checkout-ui) reaches outside the checkout-web
    // scope entirely (shop is not inside it), so it never appears; its
    // refinement cart-calls-ui (checkout-cart -> checkout-ui) has both ends
    // inside the scope and is drawn on its own, standing for itself since
    // nothing else in this view does.
    const scoped = engine.view({ scope: 'checkout-web', depth: 0 }, at);
    expect(scoped.error).toBeUndefined();
    expect(scoped.elements?.map((e) => e.id).sort()).toEqual(['checkout-cart', 'checkout-ui', 'checkout-web']);
    expect(scoped.relations).toEqual([{ from: 'checkout-cart', to: 'checkout-ui', relationIds: ['cart-calls-ui'] }]);

    engine.close();
    history.close();
  });

  test('children: payments with the services payments-api and payments-stub, end to end from a YAML fixture', () => {
    const { engine, history } = engineFor('gq-children', 'c1', DAY(1), DAY(2));
    const at = { valid: DAY(2), known: DAY(2), state: 'as-is' };

    const result = engine.children('payments', at);
    expect(result.error).toBeUndefined();
    expect(result.elements?.map((e) => e.id).sort()).toEqual(['payments-api', 'payments-stub']);

    engine.close();
    history.close();
  });

  test('dependency-appears (as-of): orders-api starts depending on event-bus in a commit of 5 September, stored the same day, end to end from YAML', () => {
    const v1 = loadModel(fixture('gq-dependency-appears-v1'));
    expect(v1.errors).toEqual([]);
    const v2 = loadModel(fixture('gq-dependency-appears-v2'));
    expect(v2.errors).toEqual([]);

    const SEPTEMBER = (day: number) => Date.UTC(2026, 8, day);
    const clock = fakeClock(SEPTEMBER(1));
    const history = createSqliteHistory({ clock });
    expect(history.store({ source: 's', commit: 'v1', committedAt: SEPTEMBER(1), model: compileModel(v1.model!) }).errors).toEqual([]);
    clock.set(SEPTEMBER(5));
    expect(history.store({ source: 's', commit: 'v2', committedAt: SEPTEMBER(5), model: compileModel(v2.model!) }).errors).toEqual([]);

    const engine = createLadybugEngine();
    engine.rebuild(history.assertions());

    const before = engine.dependents('event-bus', { transitive: false }, { valid: SEPTEMBER(3), known: SEPTEMBER(20), state: 'as-is' });
    expect(before.error).toBeUndefined();
    expect(before.elements?.map((e) => e.id)).toEqual([]);

    const after = engine.dependents('event-bus', { transitive: false }, { valid: SEPTEMBER(7), known: SEPTEMBER(20), state: 'as-is' });
    expect(after.error).toBeUndefined();
    expect(after.elements?.map((e) => e.id)).toEqual(['orders-api']);

    engine.close();
    history.close();
  });

  test('rebuild: a history with three versions of two sources answers a fixed set of queries the same way after the engine is thrown away and rebuilt', () => {
    // Two sources, disjoint id namespaces (`checkout-*` for `s`,
    // `billing-*` for `p`), each evolving over three versions — the
    // `rebuild` requirement's own scenario (graph-queries.md): the same
    // history, thrown-away-and-rebuilt engine answers the same.
    function checkoutModel(withCart: boolean): CompiledModel {
      const elements = [
        element('checkout-web', 'service'),
        element('payments-api', 'service'),
        ...(withCart ? [element('checkout-cart', 'module', 'checkout-web')] : []),
      ];
      const relations = [relation('checkout-calls-payments', withCart ? 'checkout-cart' : 'checkout-web', 'payments-api')];
      return model(elements, relations);
    }
    function billingModel(version: number): CompiledModel {
      const elements = [element('billing-api', 'service'), element('ledger-svc', 'service')];
      const relations = version >= 2 ? [relation('billing-calls-ledger', 'billing-api', 'ledger-svc')] : [];
      return model(elements, relations);
    }

    const clock = fakeClock(DAY(1));
    const history = createSqliteHistory({ clock });

    expect(history.store({ source: 's', commit: 's1', committedAt: DAY(1), model: checkoutModel(false) }).errors).toEqual([]);
    clock.set(DAY(2));
    expect(history.store({ source: 'p', commit: 'p1', committedAt: DAY(2), model: billingModel(1) }).errors).toEqual([]);
    clock.set(DAY(3));
    expect(history.store({ source: 's', commit: 's2', committedAt: DAY(3), model: checkoutModel(true) }).errors).toEqual([]);
    clock.set(DAY(4));
    expect(history.store({ source: 'p', commit: 'p2', committedAt: DAY(4), model: billingModel(2) }).errors).toEqual([]);
    clock.set(DAY(5));
    expect(history.store({ source: 's', commit: 's3', committedAt: DAY(5), model: checkoutModel(true) }).errors).toEqual([]);
    clock.set(DAY(6));
    expect(history.store({ source: 'p', commit: 'p3', committedAt: DAY(6), model: billingModel(2) }).errors).toEqual([]);

    const at = { valid: DAY(6), known: DAY(6), state: 'as-is' };
    const fixedQueries = (engine: QueryEngine) => ({
      view: engine.view({ depth: 0 }, at),
      children: engine.children('checkout-web', at),
      dependents: engine.dependents('ledger-svc', { transitive: true }, at),
    });

    const first = createLadybugEngine();
    first.rebuild(history.assertions());
    const before = fixedQueries(first);
    expect(before.view.error).toBeUndefined();
    expect(before.view.relations).toEqual([{ from: 'billing-api', to: 'ledger-svc', relationIds: ['billing-calls-ledger'] }, { from: 'checkout-web', to: 'payments-api', relationIds: ['checkout-calls-payments'] }]);
    expect(before.dependents.elements?.map((e) => e.id)).toEqual(['billing-api']);
    first.close();

    // Thrown away and rebuilt from the very same history.
    const second = createLadybugEngine();
    second.rebuild(history.assertions());
    const after = fixedQueries(second);
    second.close();

    expect(after).toEqual(before);
    history.close();
  });
});
