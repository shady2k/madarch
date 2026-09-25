import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { compileModel, createLadybugEngine, createSqliteHistory, loadModel, type AssertionRecord, type Clock, type HistoryStore, type QueryEngine } from '../src/index.js';

/**
 * graph-queries/view asked with its context (the `context` scenario and the
 * sentences before it in docs/changes/readable-views/capabilities/graph-queries.md):
 * every expected value below is worked out by hand from the fixture, never
 * from the engine's own lifting rule.
 */
function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

function fakeClock(initial: number): Clock & { set(t: number): void } {
  let current = initial;
  return { now: () => current, set: (t: number) => (current = t) };
}

const DAY = (day: number) => Date.UTC(2026, 8, day);
const AT = { valid: DAY(2), known: DAY(2), state: 'as-is' };

/** Loads and compiles each fixture in turn as one source's next commit, and builds a query engine from the history they produced. */
function engineFor(...versions: { name: string; committedAt: number; storedAt: number }[]): { engine: QueryEngine; history: HistoryStore } {
  const clock = fakeClock(versions[0]!.storedAt);
  const history = createSqliteHistory({ clock });
  for (const version of versions) {
    const { model, errors } = loadModel(fixture(version.name));
    expect(errors).toEqual([]);
    clock.set(version.storedAt);
    expect(history.store({ source: 's', commit: version.name, committedAt: version.committedAt, model: compileModel(model!) }).errors).toEqual([]);
  }
  const engine = createLadybugEngine();
  engine.rebuild(history.assertions());
  return { engine, history };
}

function oneVersion(name: string): { engine: QueryEngine; history: HistoryStore } {
  return engineFor({ name, committedAt: DAY(1), storedAt: DAY(2) });
}

describe('graph-queries/view asked with its context', () => {
  test('context: shop at depth one shows checkout-web and catalog-api inside, payments as a neighbour, and one relation from checkout-web to payments', () => {
    const { engine, history } = oneVersion('gq-context');

    const result = engine.view({ scope: 'shop', depth: 1, context: true }, AT);
    expect(result).toEqual({
      elements: [
        { id: 'catalog-api', kind: 'service', parent: 'shop' },
        { id: 'checkout-web', kind: 'service', parent: 'shop' },
        { id: 'shop', kind: 'domain' },
      ],
      neighbours: [{ id: 'payments', kind: 'domain', name: 'Payments' }],
      relations: [{ from: 'checkout-web', to: 'payments', relationIds: ['checkout-calls-payments'] }],
    });

    engine.close();
    history.close();
  });

  test('asked without its context, the same scoped view answers exactly as before: no neighbours field, no crossing relation', () => {
    const { engine, history } = oneVersion('gq-context');

    const result = engine.view({ scope: 'shop', depth: 1 }, AT);
    expect(result).not.toHaveProperty('neighbours');
    expect(result).toEqual({
      elements: [
        { id: 'catalog-api', kind: 'service', parent: 'shop' },
        { id: 'checkout-web', kind: 'service', parent: 'shop' },
        { id: 'shop', kind: 'domain' },
      ],
      relations: [],
    });
    expect(engine.view({ scope: 'shop', depth: 1, context: false }, AT)).toEqual(result);

    engine.close();
    history.close();
  });

  test('a scope with no relation crossing it answers an empty neighbour list, not a missing one', () => {
    const { engine, history } = oneVersion('gq-context');

    expect(engine.view({ scope: 'catalog-api', depth: 0, context: true }, AT)).toEqual({
      elements: [{ id: 'catalog-api', kind: 'service', parent: 'shop' }],
      neighbours: [],
      relations: [],
    });

    engine.close();
    history.close();
  });

  test('without a scope there is nothing outside: the context adds nothing', () => {
    const { engine, history } = oneVersion('gq-context-nested');

    for (const depth of [0, 1, 2]) {
      const plain = engine.view({ depth }, AT);
      expect(plain.error).toBeUndefined();
      expect(engine.view({ depth, context: true }, AT)).toStrictEqual(plain);
    }

    engine.close();
    history.close();
  });

  test('a service inside a domain: a sibling service stays itself, another domain lifts to that domain, an element with no parent stays itself; incoming and outgoing crossings both show', () => {
    const { engine, history } = oneVersion('gq-context-nested');

    const result = engine.view({ scope: 'checkout-web', depth: 1, context: true }, AT);
    expect(result.error).toBeUndefined();
    expect(result.elements?.map((e) => e.id)).toEqual(['checkout-cart', 'checkout-ui', 'checkout-web']);
    expect(result.neighbours).toEqual([
      { id: 'mail-gateway', kind: 'external' },
      { id: 'orders-api', kind: 'service', parent: 'shop' },
      { id: 'payments', kind: 'domain' },
    ]);
    // shop-pays (shop -> payments) and orders-pays (orders-core ->
    // payments-api) have both ends outside the scope and are not drawn;
    // cart-calls-orders is counted under checkout-uses-orders, which it
    // refines and which is drawn; checkout-pays refines shop-pays, which is
    // not drawn here, so it stands for itself.
    expect(result.relations).toEqual([
      { from: 'checkout-cart', to: 'checkout-ui', relationIds: ['cart-calls-ui'] },
      { from: 'checkout-cart', to: 'payments', relationIds: ['cart-charges-card'] },
      { from: 'checkout-ui', to: 'payments', relationIds: ['ui-shows-payments'] },
      { from: 'checkout-web', to: 'mail-gateway', relationIds: ['checkout-mails'] },
      { from: 'checkout-web', to: 'orders-api', relationIds: ['checkout-uses-orders'] },
      { from: 'checkout-web', to: 'payments', relationIds: ['checkout-pays'] },
      { from: 'orders-api', to: 'checkout-ui', relationIds: ['orders-notifies-ui'] },
      { from: 'payments', to: 'checkout-web', relationIds: ['payments-calls-back'] },
    ]);

    engine.close();
    history.close();
  });

  test('at depth zero the crossing relations merge per shown pair, drawn from the scope itself; a refinement whose own end is hidden is not counted beside the relation it refines', () => {
    const { engine, history } = oneVersion('gq-context-nested');

    const result = engine.view({ scope: 'checkout-web', depth: 0, context: true }, AT);
    expect(result.error).toBeUndefined();
    expect(result.elements?.map((e) => e.id)).toEqual(['checkout-web']);
    expect(result.neighbours?.map((e) => e.id)).toEqual(['mail-gateway', 'orders-api', 'payments']);
    expect(result.relations).toEqual([
      { from: 'checkout-web', to: 'mail-gateway', relationIds: ['checkout-mails'] },
      { from: 'checkout-web', to: 'orders-api', relationIds: ['checkout-uses-orders'] },
      { from: 'checkout-web', to: 'payments', relationIds: ['cart-charges-card', 'checkout-pays', 'ui-shows-payments'] },
      { from: 'orders-api', to: 'checkout-web', relationIds: ['orders-notifies-ui'] },
      { from: 'payments', to: 'checkout-web', relationIds: ['payments-calls-back'] },
    ]);

    engine.close();
    history.close();
  });

  test('a domain scope: a relation declared at the scope\'s own level crosses it, and its refinement is counted once under it', () => {
    const { engine, history } = oneVersion('gq-context-nested');

    const result = engine.view({ scope: 'shop', depth: 1, context: true }, AT);
    expect(result.error).toBeUndefined();
    expect(result.elements?.map((e) => e.id)).toEqual(['checkout-web', 'orders-api', 'shop']);
    expect(result.neighbours?.map((e) => e.id)).toEqual(['mail-gateway', 'payments']);
    expect(result.relations).toEqual([
      { from: 'checkout-web', to: 'mail-gateway', relationIds: ['checkout-mails'] },
      { from: 'checkout-web', to: 'orders-api', relationIds: ['checkout-uses-orders'] },
      { from: 'checkout-web', to: 'payments', relationIds: ['cart-charges-card', 'ui-shows-payments'] },
      { from: 'orders-api', to: 'checkout-web', relationIds: ['orders-notifies-ui'] },
      { from: 'orders-api', to: 'payments', relationIds: ['orders-pays'] },
      { from: 'payments', to: 'checkout-web', relationIds: ['payments-calls-back'] },
      { from: 'shop', to: 'payments', relationIds: ['shop-pays'] },
    ]);

    engine.close();
    history.close();
  });

  test('the sibling service seen from the other side: checkout-web stays itself, and the refinement from checkout-cart is counted under checkout-uses-orders', () => {
    const { engine, history } = oneVersion('gq-context-nested');

    const result = engine.view({ scope: 'orders-api', depth: 1, context: true }, AT);
    expect(result.error).toBeUndefined();
    expect(result.elements?.map((e) => e.id)).toEqual(['orders-api', 'orders-core']);
    expect(result.neighbours).toEqual([
      { id: 'checkout-web', kind: 'service', parent: 'shop' },
      { id: 'payments', kind: 'domain' },
    ]);
    expect(result.relations).toEqual([
      { from: 'checkout-web', to: 'orders-api', relationIds: ['checkout-uses-orders'] },
      { from: 'orders-api', to: 'checkout-web', relationIds: ['orders-notifies-ui'] },
      { from: 'orders-core', to: 'payments', relationIds: ['orders-pays'] },
    ]);

    engine.close();
    history.close();
  });

  test('a scope two levels down: every end in another domain lifts to that domain, and a relation between two of the scope\'s ancestors is not drawn', () => {
    const { engine, history } = oneVersion('gq-context-nested');

    const service = engine.view({ scope: 'payments-api', depth: 0, context: true }, AT);
    expect(service.error).toBeUndefined();
    expect(service.elements?.map((e) => e.id)).toEqual(['payments-api']);
    expect(service.neighbours).toEqual([{ id: 'shop', kind: 'domain' }]);
    expect(service.relations).toEqual([
      { from: 'payments-api', to: 'shop', relationIds: ['payments-calls-back'] },
      { from: 'shop', to: 'payments-api', relationIds: ['cart-charges-card', 'checkout-pays', 'orders-pays', 'ui-shows-payments'] },
    ]);

    const module = engine.view({ scope: 'payments-core', depth: 0, context: true }, AT);
    expect(module.error).toBeUndefined();
    expect(module.elements?.map((e) => e.id)).toEqual(['payments-core']);
    expect(module.neighbours).toEqual([{ id: 'shop', kind: 'domain' }]);
    expect(module.relations).toEqual([{ from: 'shop', to: 'payments-core', relationIds: ['cart-charges-card'] }]);

    engine.close();
    history.close();
  });

  test("an ancestor of the scope is itself a neighbour when a relation joins it to the scope's inside, and a refinement with both ends shown is drawn beside it", () => {
    const { engine, history } = oneVersion('gq-scoped');

    const result = engine.view({ scope: 'checkout-web', depth: 1, context: true }, AT);
    expect(result.error).toBeUndefined();
    expect(result.elements?.map((e) => e.id)).toEqual(['checkout-cart', 'checkout-ui', 'checkout-web']);
    expect(result.neighbours).toEqual([
      { id: 'payments-api', kind: 'service' },
      { id: 'shop', kind: 'domain' },
    ]);
    expect(result.relations).toEqual([
      { from: 'checkout-cart', to: 'checkout-ui', relationIds: ['cart-calls-ui'] },
      { from: 'checkout-cart', to: 'payments-api', relationIds: ['cart-calls-payments'] },
      { from: 'shop', to: 'checkout-ui', relationIds: ['shop-uses-ui'] },
    ]);

    engine.close();
    history.close();
  });

  test('refinement-counted-once with context: the crossing relation and its refinement are one relation to payments', () => {
    const { engine, history } = oneVersion('gq-refinement-once');

    const result = engine.view({ scope: 'shop', depth: 1, context: true }, AT);
    expect(result.error).toBeUndefined();
    expect(result.neighbours).toEqual([{ id: 'payments', kind: 'domain' }]);
    expect(result.relations).toEqual([{ from: 'checkout-web', to: 'payments', relationIds: ['checkout-uses-payments'] }]);

    engine.close();
    history.close();
  });

  test('as-of: a neighbour that exists only at another time is not shown, on either time axis', () => {
    const { engine, history } = engineFor(
      { name: 'gq-context-asof-v1', committedAt: DAY(1), storedAt: DAY(2) },
      { name: 'gq-context-asof-v2', committedAt: DAY(10), storedAt: DAY(12) },
    );
    const input = { scope: 'checkout-web', depth: 0, context: true };

    const before = engine.view(input, { valid: DAY(5), known: DAY(20), state: 'as-is' });
    expect(before).toEqual({
      elements: [{ id: 'checkout-web', kind: 'service', parent: 'shop' }],
      neighbours: [{ id: 'legacy-billing', kind: 'external' }],
      relations: [{ from: 'checkout-web', to: 'legacy-billing', relationIds: ['checkout-bills'] }],
    });

    const after = engine.view(input, { valid: DAY(15), known: DAY(20), state: 'as-is' });
    expect(after).toEqual({
      elements: [{ id: 'checkout-web', kind: 'service', parent: 'shop' }],
      neighbours: [{ id: 'payments', kind: 'domain' }],
      relations: [{ from: 'checkout-web', to: 'payments', relationIds: ['checkout-calls-payments'] }],
    });

    // Valid after the second commit, but known before it was stored: the
    // history then still held the first version as open-ended.
    expect(engine.view(input, { valid: DAY(15), known: DAY(5), state: 'as-is' })).toEqual(before);

    engine.close();
    history.close();
  });

  test('a neighbour that does not exist at the asked time (an ancestor another source no longer declares) is an error naming it and the relations drawn to it, not a neighbour left out', () => {
    const DAY1 = { validFrom: DAY(1), validTo: null, recordedFrom: DAY(1), recordedTo: null };
    const element = (source: string, id: string, kind: string, ancestors: string[], validTo: number | null = null): AssertionRecord => ({
      source,
      kind: 'element',
      id,
      content: JSON.stringify({ id, kind, ancestors, states: ['as-is'], ...(ancestors.length > 0 ? { parent: ancestors[ancestors.length - 1] } : {}) }),
      ...DAY1,
      validTo,
    });
    const relation = (id: string, from: string, to: string): AssertionRecord => ({ source: 'a', kind: 'relation', id, content: JSON.stringify({ id, from, to, states: ['as-is'] }), ...DAY1 });
    const engine = createLadybugEngine();
    engine.rebuild([
      element('a', 'shop', 'domain', []),
      element('a', 'checkout-web', 'service', ['shop']),
      element('b', 'payments', 'domain', [], DAY(3)),
      element('a', 'payments-api', 'service', ['payments']),
      relation('checkout-calls-payments', 'checkout-web', 'payments-api'),
      relation('checkout-refunds', 'payments-api', 'shop'),
    ]);

    expect(engine.view({ scope: 'shop', depth: 1, context: true }, AT).neighbours).toEqual([{ id: 'payments', kind: 'domain' }]);
    expect(engine.view({ scope: 'shop', depth: 1, context: true }, { valid: DAY(4), known: DAY(4), state: 'as-is' })).toEqual({
      error: { message: '"payments", the neighbour the relations checkout-calls-payments, checkout-refunds are drawn to or from, does not exist at this time', id: 'payments', time: DAY(4) },
    });

    engine.close();
  });

  test('a scope that does not exist is the same error with or without context', () => {
    const { engine, history } = oneVersion('gq-context');

    expect(engine.view({ scope: 'ghost', depth: 1, context: true }, AT)).toEqual({ error: { message: '"ghost" does not exist at this time', id: 'ghost', time: DAY(2) } });

    engine.close();
    history.close();
  });
});
