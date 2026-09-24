import { describe, expect, test } from 'bun:test';
import { createLadybugEngine, type AssertionRecord } from '../src/index.js';

const DAY = (day: number) => Date.UTC(2026, 8, day);

function element(id: string, kind: string, ancestors: string[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ id, kind, ancestors, states: ['as-is'], ...extra });
}

function relation(id: string, from: string, to: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ id, from, to, states: ['as-is'], ...extra });
}

function row(kind: 'element' | 'relation' | 'state', content: string, opts: Partial<AssertionRecord> = {}): AssertionRecord {
  return { source: 's', kind, id: (JSON.parse(content) as { id: string }).id, content, validFrom: DAY(1), validTo: null, recordedFrom: DAY(1), recordedTo: null, ...opts };
}

describe('the LadybugDB query engine', () => {
  test('children: returns the direct children of an element at a time; an unknown element is an error naming it and the time', () => {
    const engine = createLadybugEngine();
    engine.rebuild([
      row('element', element('payments', 'domain', [])),
      row('element', element('payments-api', 'service', ['payments'], { parent: 'payments' })),
      row('element', element('payments-stub', 'service', ['payments'], { parent: 'payments' })),
    ]);

    const result = engine.children('payments', { valid: DAY(2), known: DAY(2), state: 'as-is' });
    expect(result.error).toBeUndefined();
    expect(result.elements?.map((e) => e.id)).toEqual(['payments-api', 'payments-stub']);

    const missing = engine.children('nope', { valid: DAY(2), known: DAY(2), state: 'as-is' });
    expect(missing.error).toMatchObject({ id: 'nope', time: DAY(2) });

    engine.close();
  });

  test('as-of: a dependent that appears in a later commit is absent before that time and present after', () => {
    const engine = createLadybugEngine();
    engine.rebuild([
      row('element', element('orders-api', 'service', [])),
      row('element', element('event-bus', 'broker', [])),
      row('relation', relation('orders-publishes', 'orders-api', 'event-bus'), { validFrom: DAY(5) }),
    ]);

    const before = engine.dependents('event-bus', { transitive: false }, { valid: DAY(3), known: DAY(6), state: 'as-is' });
    expect(before.elements?.map((e) => e.id)).toEqual([]);

    const after = engine.dependents('event-bus', { transitive: false }, { valid: DAY(7), known: DAY(8), state: 'as-is' });
    expect(after.elements?.map((e) => e.id)).toEqual(['orders-api']);

    engine.close();
  });

  test('view: two modules calling one service collapse into one relation with both ids behind it', () => {
    const engine = createLadybugEngine();
    engine.rebuild([
      row('element', element('checkout-web', 'service', [])),
      row('element', element('checkout-cart', 'module', ['checkout-web'], { parent: 'checkout-web' })),
      row('element', element('checkout-ui', 'module', ['checkout-web'], { parent: 'checkout-web' })),
      row('element', element('payments-api', 'service', [])),
      row('relation', relation('cart-calls-payments', 'checkout-cart', 'payments-api')),
      row('relation', relation('ui-calls-payments', 'checkout-ui', 'payments-api')),
    ]);

    const result = engine.view({ depth: 0 }, { valid: DAY(2), known: DAY(2), state: 'as-is' });
    expect(result.error).toBeUndefined();
    expect(result.elements?.map((e) => e.id).sort()).toEqual(['checkout-web', 'payments-api']);
    expect(result.relations).toEqual([{ from: 'checkout-web', to: 'payments-api', relationIds: ['cart-calls-payments', 'ui-calls-payments'] }]);

    engine.close();
  });

  test('view: a refinement is not counted beside the relation it refines', () => {
    const engine = createLadybugEngine();
    engine.rebuild([
      row('element', element('checkout-web', 'service', [])),
      row('element', element('checkout-cart', 'module', ['checkout-web'], { parent: 'checkout-web' })),
      row('element', element('payments', 'domain', [])),
      row('element', element('payments-api', 'service', ['payments'], { parent: 'payments' })),
      row('relation', relation('checkout-uses-payments', 'checkout-web', 'payments')),
      row('relation', relation('checkout-charges-card', 'checkout-cart', 'payments-api'), {
        content: JSON.stringify({ id: 'checkout-charges-card', from: 'checkout-cart', to: 'payments-api', refines: 'checkout-uses-payments', states: ['as-is'] }),
      }),
    ]);

    // depth 1 shows domains and services (checkout-web, payments, payments-api) but not modules.
    const result = engine.view({ depth: 1 }, { valid: DAY(2), known: DAY(2), state: 'as-is' });
    expect(result.relations).toEqual([{ from: 'checkout-web', to: 'payments', relationIds: ['checkout-uses-payments'] }]);

    engine.close();
  });

  test('view: a relation whose ends fall inside one shown element is not drawn', () => {
    const engine = createLadybugEngine();
    engine.rebuild([
      row('element', element('checkout-web', 'service', [])),
      row('element', element('checkout-cart', 'module', ['checkout-web'], { parent: 'checkout-web' })),
      row('element', element('checkout-ui', 'module', ['checkout-web'], { parent: 'checkout-web' })),
      row('relation', relation('cart-calls-ui', 'checkout-cart', 'checkout-ui')),
    ]);

    const result = engine.view({ depth: 0 }, { valid: DAY(2), known: DAY(2), state: 'as-is' });
    expect(result.relations).toEqual([]);

    engine.close();
  });

  test('dependencies (transitive): the chain of relation ids joining each element, shortest first', () => {
    const engine = createLadybugEngine();
    engine.rebuild([
      row('element', element('checkout-web', 'service', [])),
      row('element', element('orders-api', 'service', [])),
      row('element', element('event-bus', 'broker', [])),
      row('relation', relation('checkout-calls-orders', 'checkout-web', 'orders-api')),
      row('relation', relation('orders-publishes', 'orders-api', 'event-bus')),
    ]);

    const result = engine.dependents('event-bus', { transitive: true }, { valid: DAY(2), known: DAY(2), state: 'as-is' });
    expect(result.error).toBeUndefined();
    const byId = new Map(result.elements?.map((e) => [e.id, e.chain]));
    expect(byId.get('orders-api')).toEqual(['orders-publishes']);
    expect(byId.get('checkout-web')).toEqual(['checkout-calls-orders', 'orders-publishes']);

    engine.close();
  });

  test('rebuild: thrown away and rebuilt from the same assertions, answers stay the same', () => {
    const engine = createLadybugEngine();
    const assertions = [row('element', element('a', 'service', [])), row('element', element('b', 'service', ['a'], { parent: 'a' }))];
    engine.rebuild(assertions);
    const first = engine.children('a', { valid: DAY(2), known: DAY(2), state: 'as-is' });
    engine.rebuild(assertions);
    const second = engine.children('a', { valid: DAY(2), known: DAY(2), state: 'as-is' });
    expect(second).toEqual(first);
    engine.close();
  });

  test('as-of: a query with no explicit state defaults to the first state of the chain when the model has one', () => {
    const engine = createLadybugEngine();
    engine.rebuild([
      row('element', element('a', 'service', [], { states: ['as-is', 'to-be'] }), { content: JSON.stringify({ id: 'a', kind: 'service', ancestors: [], states: ['as-is', 'to-be'] }) }),
      row('element', element('b', 'service', ['a'], { parent: 'a', states: ['to-be'] }), {
        content: JSON.stringify({ id: 'b', kind: 'service', ancestors: ['a'], parent: 'a', states: ['to-be'] }),
      }),
      row('state', JSON.stringify({ id: 'as-is' })),
      row('state', JSON.stringify({ id: 'to-be', after: 'as-is' })),
    ]);

    // No `state` given: defaults to "as-is" (the chain's first state), where `b` does not yet exist.
    const defaulted = engine.children('a', { valid: DAY(2), known: DAY(2) });
    expect(defaulted.elements?.map((e) => e.id)).toEqual([]);

    const explicit = engine.children('a', { valid: DAY(2), known: DAY(2), state: 'to-be' });
    expect(explicit.elements?.map((e) => e.id)).toEqual(['b']);

    engine.close();
  });

  test('as-of: a query with no explicit state is an error when the state chains disagree, naming the disagreement; an explicit state still works', () => {
    const engine = createLadybugEngine();
    engine.rebuild([
      row('element', element('a', 'service', [])),
      row('state', JSON.stringify({ id: 'as-is' }), { source: 'x' }),
      row('state', JSON.stringify({ id: 'to-be', after: 'as-is' }), { source: 'x' }),
      row('state', JSON.stringify({ id: 'as-is' }), { source: 'y' }),
      row('state', JSON.stringify({ id: 'other', after: 'as-is' }), { source: 'y' }),
    ]);

    const result = engine.children('a', { valid: DAY(2), known: DAY(2) });
    expect(result.error).toMatchObject({ message: expect.stringContaining('disagree') });

    const explicit = engine.children('a', { valid: DAY(2), known: DAY(2), state: 'as-is' });
    expect(explicit.error).toBeUndefined();
    engine.close();
  });

  test('dependencies: the elements an element depends on, transitively, with the chain of relation ids joining each', () => {
    const engine = createLadybugEngine();
    engine.rebuild([
      row('element', element('checkout-web', 'service', [])),
      row('element', element('orders-api', 'service', [])),
      row('element', element('event-bus', 'broker', [])),
      row('relation', relation('checkout-calls-orders', 'checkout-web', 'orders-api')),
      row('relation', relation('orders-publishes', 'orders-api', 'event-bus')),
    ]);

    const direct = engine.dependencies('checkout-web', { transitive: false }, { valid: DAY(2), known: DAY(2), state: 'as-is' });
    expect(direct.elements?.map((e) => e.id)).toEqual(['orders-api']);

    const transitive = engine.dependencies('checkout-web', { transitive: true }, { valid: DAY(2), known: DAY(2), state: 'as-is' });
    const byId = new Map(transitive.elements?.map((e) => [e.id, e.chain]));
    expect(byId.get('orders-api')).toEqual(['checkout-calls-orders']);
    expect(byId.get('event-bus')).toEqual(['checkout-calls-orders', 'orders-publishes']);

    engine.close();
  });

  test('view/dependents/dependencies: an unknown element at the asked time is an error naming it and the time, paired with the same element once it exists', () => {
    const engine = createLadybugEngine();
    engine.rebuild([row('element', element('a', 'service', []))]);
    const at = { valid: DAY(2), known: DAY(2), state: 'as-is' };

    expect(engine.view({ scope: 'ghost', depth: 0 }, at).error).toMatchObject({ id: 'ghost', time: DAY(2) });
    expect(engine.view({ scope: 'a', depth: 0 }, at).error).toBeUndefined();

    expect(engine.dependents('ghost', {}, at).error).toMatchObject({ id: 'ghost', time: DAY(2) });
    expect(engine.dependents('a', {}, at).error).toBeUndefined();

    expect(engine.dependencies('ghost', {}, at).error).toMatchObject({ id: 'ghost', time: DAY(2) });
    expect(engine.dependencies('a', {}, at).error).toBeUndefined();

    engine.close();
  });

  test('update: applying store()-shaped opened/closed changes keeps the engine in step, matching a full rebuild', () => {
    const engine = createLadybugEngine();
    const at = { valid: DAY(2), known: DAY(2), state: 'as-is' };

    engine.rebuild([row('element', element('payments', 'domain', []))]);
    engine.update(
      [{ source: 's', kind: 'element', id: 'payments-api', content: element('payments-api', 'service', ['payments'], { parent: 'payments' }), validFrom: DAY(1), validTo: null }],
      [],
    );
    expect(engine.children('payments', at).elements?.map((e) => e.id)).toEqual(['payments-api']);

    // Closing the element it just opened removes it again.
    engine.update([], [{ source: 's', kind: 'element', id: 'payments-api', content: element('payments-api', 'service', ['payments'], { parent: 'payments' }), validFrom: DAY(1), validTo: null }]);
    expect(engine.children('payments', at).elements?.map((e) => e.id)).toEqual([]);

    engine.close();
  });
});
