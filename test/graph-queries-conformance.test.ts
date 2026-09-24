import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { compileModel, createLadybugEngine, createSqliteHistory, loadModel, type Clock, type HistoryStore, type QueryEngine } from '../src/index.js';

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

  test('refinement-counted-once: a general relation and its refinement, viewed at the depth of domains and services, show one relation standing for both', () => {
    const { engine, history } = engineFor('gq-refinement-once', 'c1', DAY(1), DAY(2));
    const at = { valid: DAY(2), known: DAY(2), state: 'as-is' };

    const result = engine.view({ depth: 1 }, at);
    expect(result.error).toBeUndefined();
    expect(result.relations).toEqual([{ from: 'checkout-web', to: 'payments', relationIds: ['checkout-uses-payments'] }]);

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

  test('service-gains-internal-elements: a relation moved to a newly-added internal module still lifts to the same single relation at the service level', () => {
    const v1 = loadModel(fixture('gq-nesting-v1'));
    expect(v1.errors).toEqual([]);
    const v2 = loadModel(fixture('gq-nesting-v2'));
    expect(v2.errors).toEqual([]);

    const at = { valid: DAY(2), known: DAY(2), state: 'as-is' };

    const clock1 = fakeClock(DAY(2));
    const history1 = createSqliteHistory({ clock: clock1 });
    expect(history1.store({ source: 's', commit: 'v1', committedAt: DAY(1), model: compileModel(v1.model!) }).errors).toEqual([]);
    const engine1 = createLadybugEngine();
    engine1.rebuild(history1.assertions());
    const view1 = engine1.view({ depth: 0 }, at);
    expect(view1.error).toBeUndefined();
    expect(view1.relations).toEqual([{ from: 'checkout-web', to: 'payments-api', relationIds: ['checkout-calls-payments'] }]);
    engine1.close();
    history1.close();

    const clock2 = fakeClock(DAY(2));
    const history2 = createSqliteHistory({ clock: clock2 });
    expect(history2.store({ source: 's', commit: 'v2', committedAt: DAY(1), model: compileModel(v2.model!) }).errors).toEqual([]);
    const engine2 = createLadybugEngine();
    engine2.rebuild(history2.assertions());
    const view2 = engine2.view({ depth: 0 }, at);
    expect(view2.error).toBeUndefined();
    expect(view2.relations).toEqual([{ from: 'checkout-web', to: 'payments-api', relationIds: ['checkout-calls-payments'] }]);
    engine2.close();
    history2.close();

    // Both versions show the same single relation from checkout-web to payments-api.
    expect(view2.relations).toEqual(view1.relations);
  });
});
