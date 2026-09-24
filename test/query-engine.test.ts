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

  test('children: an element carries name and parent only when it has them', () => {
    const engine = createLadybugEngine();
    engine.rebuild([
      row('element', element('a', 'domain', [])),
      row('element', element('b', 'service', ['a'], { parent: 'a', name: 'B service' })),
      row('element', element('c', 'service', ['a'], { parent: 'a' })),
    ]);
    const at = { valid: DAY(2), known: DAY(2), state: 'as-is' };

    const result = engine.children('a', at);
    const byId = new Map(result.elements?.map((e) => [e.id, e]));
    expect(byId.get('b')).toEqual({ id: 'b', kind: 'service', name: 'B service', parent: 'a' });
    expect(byId.get('c')).toEqual({ id: 'c', kind: 'service', parent: 'a' });
    expect('name' in byId.get('c')!).toBe(false);

    engine.close();
  });

  test('children/view/dependents/dependencies: the refusal names the exact element and time, with a readable message', () => {
    const engine = createLadybugEngine();
    engine.rebuild([row('element', element('a', 'service', []))]);
    const at = { valid: DAY(3), known: DAY(3), state: 'as-is' };

    expect(engine.children('ghost', at)).toEqual({ error: { message: '"ghost" does not exist at this time', id: 'ghost', time: DAY(3) } });
    expect(engine.view({ scope: 'ghost', depth: 0 }, at)).toEqual({ error: { message: '"ghost" does not exist at this time', id: 'ghost', time: DAY(3) } });
    expect(engine.dependents('ghost', {}, at)).toEqual({ error: { message: '"ghost" does not exist at this time', id: 'ghost', time: DAY(3) } });
    expect(engine.dependencies('ghost', {}, at)).toEqual({ error: { message: '"ghost" does not exist at this time', id: 'ghost', time: DAY(3) } });

    engine.close();
  });

  test('view: an explicit state outside the model\'s own id pattern is a refusal, never a thrown exception', () => {
    const engine = createLadybugEngine();
    engine.rebuild([row('element', element('a', 'service', []))]);

    const result = engine.children('a', { valid: DAY(2), known: DAY(2), state: "bad state; DROP" });
    expect(result.error).toMatchObject({ id: 'bad state; DROP' });
    expect(result.elements).toBeUndefined();

    engine.close();
  });

  test('view: depth is counted from the scope, not from the root — a scoped view at depth 0 shows only the scope\'s immediate children, not grandchildren; an unscoped view excludes elements outside no subtree at all', () => {
    const engine = createLadybugEngine();
    engine.rebuild([
      row('element', element('root', 'domain', [])),
      row('element', element('mid', 'service', ['root'], { parent: 'root' })),
      row('element', element('leaf', 'module', ['root', 'mid'], { parent: 'mid' })),
      row('element', element('other-root', 'domain', [])),
    ]);
    const at = { valid: DAY(2), known: DAY(2), state: 'as-is' };

    // Scoped at "root", depth 0: the scope itself and "mid" (its immediate child), not "leaf" (a grandchild) or "other-root" (outside the scope).
    const scoped = engine.view({ scope: 'root', depth: 0 }, at);
    expect(scoped.elements?.map((e) => e.id).sort()).toEqual(['mid', 'root']);

    // Scoped at "root", depth 1: "mid" and "leaf" too, still never "other-root".
    const deeper = engine.view({ scope: 'root', depth: 1 }, at);
    expect(deeper.elements?.map((e) => e.id).sort()).toEqual(['leaf', 'mid', 'root']);

    // Scoped at "mid" itself, depth 0: "mid" and "leaf" (mid's own immediate child) — proves the scope's own ancestor
    // chain length (root -> mid = 1 ancestor), not merely whether a scope was given, sets the depth origin.
    const atMid = engine.view({ scope: 'mid', depth: 0 }, at);
    expect(atMid.elements?.map((e) => e.id).sort()).toEqual(['leaf', 'mid']);

    engine.close();
  });

  test('view: with no scope, every root-level element is shown at depth 0, never only the first one found', () => {
    const engine = createLadybugEngine();
    engine.rebuild([row('element', element('root-a', 'domain', [])), row('element', element('root-b', 'domain', []))]);
    const result = engine.view({ depth: 0 }, { valid: DAY(2), known: DAY(2), state: 'as-is' });
    expect(result.elements?.map((e) => e.id).sort()).toEqual(['root-a', 'root-b']);
    engine.close();
  });

  test('view: a merged relation\'s ids are sorted by code point, regardless of the order they were stored in', () => {
    const engine = createLadybugEngine();
    engine.rebuild([
      row('element', element('web', 'service', [])),
      row('element', element('cart', 'module', ['web'], { parent: 'web' })),
      row('element', element('ui', 'module', ['web'], { parent: 'web' })),
      row('element', element('api', 'service', [])),
      // Stored in an order that sorts the wrong way if the merge ever relied on storage/collection order.
      row('relation', relation('z-rel', 'ui', 'api')),
      row('relation', relation('a-rel', 'cart', 'api')),
    ]);
    const result = engine.view({ depth: 0 }, { valid: DAY(2), known: DAY(2), state: 'as-is' });
    expect(result.relations).toEqual([{ from: 'web', to: 'api', relationIds: ['a-rel', 'z-rel'] }]);
    engine.close();
  });

  test('dependencies: maxHops beyond the engine\'s own 30-hop ceiling is clamped, not refused or left unbounded', () => {
    const engine = createLadybugEngine();
    engine.rebuild([
      row('element', element('a', 'service', [])),
      row('element', element('b', 'service', [])),
      row('relation', relation('a-to-b', 'a', 'b')),
    ]);
    const at = { valid: DAY(2), known: DAY(2), state: 'as-is' };

    // 1000 exceeds the 30-hop ceiling a recursive Cypher pattern accepts in
    // this LadybugDB build; if the clamp used the wrong bound (Math.max
    // instead of Math.min), building the query would fail outright.
    const result = engine.dependencies('a', { transitive: true, maxHops: 1000 }, at);
    expect(result.error).toBeUndefined();
    expect(result.elements?.map((e) => e.id)).toEqual(['b']);

    engine.close();
  });

  test('close: releases the underlying database so many engines can be opened and closed in one process without exhausting it', () => {
    for (let i = 0; i < 40; i++) {
      const engine = createLadybugEngine();
      engine.rebuild([row('element', element('a', 'service', []))]);
      engine.close();
    }
    // If `close` failed to release its Database, this many instances would
    // exhaust the process's own resources well before finishing the loop
    // (observed directly while building this engine — see its module doc).
    expect(true).toBe(true);
  });

  test("a row's own key does not collide across a source/kind/id/validFrom boundary that would coincide without a real separator", () => {
    // Without a separator, `('X', 'element', '12', 3)` and `('X', 'element',
    // '1', 23)` would both join to the same text ("...12" + "3" = "...1" +
    // "23" = "...123"): two different assertions the engine must still tell
    // apart (as two distinct rows in the same node table, whose primary key
    // is exactly this join) — if it could not, inserting the second would
    // violate the table's own primary-key uniqueness and throw.
    const engine = createLadybugEngine();
    expect(() =>
      engine.rebuild([
        row('element', element('12', 'service', []), { validFrom: 3 }),
        row('element', element('1', 'service', []), { validFrom: 23 }),
      ]),
    ).not.toThrow();

    const at = { valid: DAY(2), known: DAY(2), state: 'as-is' };
    expect(engine.children('12', at).error).toBeUndefined();
    expect(engine.children('1', at).error).toBeUndefined();

    engine.close();
  });

  test('update: opening and closing a relation and a state keeps the engine in step, the same as rebuild', () => {
    const engine = createLadybugEngine();
    const at = { valid: DAY(2), known: DAY(2), state: 'as-is' };

    engine.rebuild([row('element', element('a', 'service', [])), row('element', element('b', 'service', []))]);
    engine.update([{ source: 's', kind: 'relation', id: 'a-to-b', content: relation('a-to-b', 'a', 'b'), validFrom: DAY(1), validTo: null }], []);
    expect(engine.dependencies('a', {}, at).elements?.map((e) => e.id)).toEqual(['b']);

    engine.update([], [{ source: 's', kind: 'relation', id: 'a-to-b', content: relation('a-to-b', 'a', 'b'), validFrom: DAY(1), validTo: null }]);
    expect(engine.dependencies('a', {}, at).elements?.map((e) => e.id)).toEqual([]);

    // A state, opened then closed through `update`, changes what a query
    // with no explicit state defaults to.
    engine.update(
      [
        { source: 's', kind: 'state', id: 'as-is', content: JSON.stringify({ id: 'as-is' }), validFrom: DAY(1), validTo: null },
        { source: 's', kind: 'state', id: 'to-be', content: JSON.stringify({ id: 'to-be', after: 'as-is' }), validFrom: DAY(1), validTo: null },
      ],
      [],
    );
    engine.update(
      [],
      [{ source: 's', kind: 'state', id: 'to-be', content: JSON.stringify({ id: 'to-be', after: 'as-is' }), validFrom: DAY(1), validTo: null }],
    );
    const defaulted = engine.children('a', { valid: DAY(2), known: DAY(2) });
    expect(defaulted.error).toBeUndefined();

    engine.close();
  });

  test('as-of: with no `at` at all, a query still answers rather than throwing (both times and the state default to now/"as-is")', () => {
    const engine = createLadybugEngine();
    engine.rebuild([row('element', element('a', 'service', []), { validFrom: DAY(1) })]);
    expect(() => engine.children('a')).not.toThrow();
    expect(engine.children('a').elements?.map((e) => e.id)).toEqual([]);
    engine.close();
  });

  test('as-of: with no explicit state and no states ever recorded, a query defaults to "as-is"', () => {
    const engine = createLadybugEngine();
    engine.rebuild([row('element', element('a', 'domain', [])), row('element', element('b', 'service', ['a'], { parent: 'a' }))]);
    const result = engine.children('a', { valid: DAY(2), known: DAY(2) });
    expect(result.error).toBeUndefined();
    expect(result.elements?.map((e) => e.id)).toEqual(['b']);
    engine.close();
  });

  describe('as-of: default-state resolution checks each of the four bitemporal bounds at its exact edge', () => {
    // In each case, "as-is" is the state that is right at the tested
    // bound's edge; "to-be" (after "as-is") is always comfortably visible,
    // so it alone, without its root, is what a query sees if "as-is" is
    // wrongly excluded — `chainRoot` then finds no state with no `after`
    // among what is visible, and the query refuses rather than guessing
    // (see `resolveTime`). A wrong comparison at the tested bound (`<=`
    // read as `<`, `>` read as `>=`, and so on) is only visible exactly at
    // this edge — one instant off either way and both readings agree.
    function statesAt(bound: 'validFrom' | 'validTo' | 'recordedFrom' | 'recordedTo', edge: number): AssertionRecord[] {
      const asIs: AssertionRecord = { source: 's', kind: 'state', id: 'as-is', content: JSON.stringify({ id: 'as-is' }), validFrom: DAY(1), validTo: null, recordedFrom: DAY(1), recordedTo: null };
      asIs[bound] = edge;
      const toBe: AssertionRecord = {
        source: 's',
        kind: 'state',
        id: 'to-be',
        content: JSON.stringify({ id: 'to-be', after: 'as-is' }),
        validFrom: DAY(1),
        validTo: null,
        recordedFrom: DAY(1),
        recordedTo: null,
      };
      return [row('element', element('a', 'service', [])), asIs, toBe];
    }

    test('validFrom <= valid: "as-is" is visible exactly at its own validFrom', () => {
      const engine = createLadybugEngine();
      engine.rebuild(statesAt('validFrom', DAY(10)));
      expect(engine.children('a', { valid: DAY(10), known: DAY(20) }).error).toBeUndefined();
      engine.close();
    });

    test('validTo > valid: "as-is" is no longer visible exactly at its own validTo', () => {
      const engine = createLadybugEngine();
      engine.rebuild(statesAt('validTo', DAY(10)));
      expect(engine.children('a', { valid: DAY(10), known: DAY(20) }).error).toMatchObject({ message: expect.stringContaining('disagree') });
      engine.close();
    });

    test('recordedFrom <= known: "as-is" is known exactly at its own recordedFrom', () => {
      const engine = createLadybugEngine();
      engine.rebuild(statesAt('recordedFrom', DAY(10)));
      expect(engine.children('a', { valid: DAY(20), known: DAY(10) }).error).toBeUndefined();
      engine.close();
    });

    test('recordedTo > known: "as-is" is no longer known exactly at its own recordedTo', () => {
      const engine = createLadybugEngine();
      engine.rebuild(statesAt('recordedTo', DAY(10)));
      expect(engine.children('a', { valid: DAY(20), known: DAY(10) }).error).toMatchObject({ message: expect.stringContaining('disagree') });
      engine.close();
    });
  });
});
