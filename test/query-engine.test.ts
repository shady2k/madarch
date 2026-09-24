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

    // depth 0 shows only checkout-web and payments (both top-level); the
    // refinement's own ends (checkout-cart, payments-api) both lift to the
    // very same pair the general relation already occupies, so it stands
    // for both, not beside it (the coordinator's reading of
    // graph-queries/view, design.md "Readings decided during the run").
    const result = engine.view({ depth: 0 }, { valid: DAY(2), known: DAY(2), state: 'as-is' });
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
    // Names every state id visible at this time, so a caller can pass one
    // of them explicitly instead of guessing (item 5: the states the query
    // could use).
    expect(result.error?.states).toEqual(['as-is', 'other', 'to-be']);

    const explicit = engine.children('a', { valid: DAY(2), known: DAY(2), state: 'as-is' });
    expect(explicit.error).toBeUndefined();
    engine.close();
  });

  test("as-of: two sources declaring the very same state chain agree — a query with no explicit state succeeds (B3: duplicate rows across sources are one declaration, not a disagreement)", () => {
    const engine = createLadybugEngine();
    engine.rebuild([
      row('element', element('a', 'service', [])),
      // Both sources declare exactly the same trivial chain — the ordinary
      // case for a repository of independent sources that never mention
      // "state" at all, since the compiler always emits the default
      // `as-is` root for every source. Two identical declarations must
      // still count as one root, not two.
      row('state', JSON.stringify({ id: 'as-is' }), { source: 'x' }),
      row('state', JSON.stringify({ id: 'as-is' }), { source: 'y' }),
    ]);

    const result = engine.children('a', { valid: DAY(2), known: DAY(2) });
    expect(result.error).toBeUndefined();
    expect(result.elements).toEqual([]);
    engine.close();
  });

  test('as-of: two sources declaring the same longer chain (more than one state) still agree', () => {
    const engine = createLadybugEngine();
    engine.rebuild([
      row('element', element('a', 'service', [])),
      row('state', JSON.stringify({ id: 'as-is' }), { source: 'x' }),
      row('state', JSON.stringify({ id: 'to-be', after: 'as-is' }), { source: 'x' }),
      row('state', JSON.stringify({ id: 'as-is' }), { source: 'y' }),
      row('state', JSON.stringify({ id: 'to-be', after: 'as-is' }), { source: 'y' }),
    ]);

    const result = engine.children('a', { valid: DAY(2), known: DAY(2) });
    expect(result.error).toBeUndefined();
    engine.close();
  });

  test("as-of (B3): two sources' same-named state disagreeing on what it comes after is a real disagreement, not folded away by the same dedupe that agreeing rows use", () => {
    // Both declare a shared root "as-is" (agreeing, folded into one), but
    // then diverge: x's "to-be" comes after an x-only "mid" state, y's own
    // "to-be" comes directly after the shared root — two different
    // declarations of the very same id "to-be", which must stay two
    // distinct rows (their own `after` tells them apart), not collapse
    // into whichever happened to be seen first by a dedupe keyed on `id`
    // alone.
    const engine = createLadybugEngine();
    engine.rebuild([
      row('element', element('a', 'service', [])),
      row('state', JSON.stringify({ id: 'as-is' }), { source: 'x' }),
      row('state', JSON.stringify({ id: 'mid', after: 'as-is' }), { source: 'x' }),
      row('state', JSON.stringify({ id: 'to-be', after: 'mid' }), { source: 'x' }),
      row('state', JSON.stringify({ id: 'as-is' }), { source: 'y' }),
      row('state', JSON.stringify({ id: 'to-be', after: 'as-is' }), { source: 'y' }),
    ]);

    const result = engine.children('a', { valid: DAY(2), known: DAY(2) });
    expect(result.error).toMatchObject({ message: expect.stringContaining('disagree') });

    // Naming the state explicitly still works either way.
    expect(engine.children('a', { valid: DAY(2), known: DAY(2), state: 'as-is' }).error).toBeUndefined();
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

  test('view/dependents/dependencies: a query with no explicit state is an error when the state chains disagree, the same refusal children() gives', () => {
    const engine = createLadybugEngine();
    engine.rebuild([
      row('element', element('a', 'service', [])),
      row('state', JSON.stringify({ id: 'as-is' }), { source: 'x' }),
      row('state', JSON.stringify({ id: 'to-be', after: 'as-is' }), { source: 'x' }),
      row('state', JSON.stringify({ id: 'as-is' }), { source: 'y' }),
      row('state', JSON.stringify({ id: 'other', after: 'as-is' }), { source: 'y' }),
    ]);
    const at = { valid: DAY(2), known: DAY(2) };

    expect(engine.view({ depth: 0 }, at).error).toMatchObject({ message: expect.stringContaining('disagree') });
    expect(engine.dependents('a', {}, at).error).toMatchObject({ message: expect.stringContaining('disagree') });
    expect(engine.dependencies('a', {}, at).error).toMatchObject({ message: expect.stringContaining('disagree') });

    engine.close();
  });

  test('update: applying store()-shaped opened/closed changes keeps the engine in step, matching a full rebuild', () => {
    const engine = createLadybugEngine();
    const at = { valid: DAY(2), known: DAY(2), state: 'as-is' };

    engine.rebuild([row('element', element('payments', 'domain', []))]);
    engine.update(
      [
        {
          source: 's',
          kind: 'element',
          id: 'payments-api',
          content: element('payments-api', 'service', ['payments'], { parent: 'payments' }),
          validFrom: DAY(1),
          validTo: null,
          recordedFrom: DAY(1),
          recordedTo: null,
        },
      ],
      [],
    );
    expect(engine.children('payments', at).elements?.map((e) => e.id)).toEqual(['payments-api']);

    // Closing the element it just opened removes it again.
    engine.update(
      [],
      [
        {
          source: 's',
          kind: 'element',
          id: 'payments-api',
          content: element('payments-api', 'service', ['payments'], { parent: 'payments' }),
          validFrom: DAY(1),
          validTo: null,
          recordedFrom: DAY(1),
          recordedTo: DAY(2),
        },
      ],
    );
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

  test('view (B1): an element id outside the model\'s own id pattern reaching the engine (bypassing the schema, e.g. through rebuild() directly) is a refusal from view(), never a thrown exception', () => {
    // The model schema never lets an id like this through in the ordinary
    // path (loadModel/compileModel), but `rebuild()` takes raw
    // `AssertionRecord`s directly — `literalIdList`'s own SAFE_ID guard,
    // and `safely`'s catch around it, are what stand between a row that
    // reached the engine some other way and a query building unsafe Cypher
    // text around it.
    const engine = createLadybugEngine();
    engine.rebuild([row('element', element("bad'id; DROP", 'service', []))]);

    const result = engine.view({ depth: 0 }, { valid: DAY(2), known: DAY(2), state: 'as-is' });
    expect(result.error).toBeDefined();
    expect(result.elements).toBeUndefined();
    expect(result.relations).toBeUndefined();

    engine.close();
  });

  test('view: depth is counted from the scope, not from the root — depth 0 shows the scope alone (or the roots alone, unscoped); depth n adds n levels below', () => {
    const engine = createLadybugEngine();
    engine.rebuild([
      row('element', element('root', 'domain', [])),
      row('element', element('mid', 'service', ['root'], { parent: 'root' })),
      row('element', element('leaf', 'module', ['root', 'mid'], { parent: 'mid' })),
      row('element', element('other-root', 'domain', [])),
    ]);
    const at = { valid: DAY(2), known: DAY(2), state: 'as-is' };

    // Scoped at "root", depth 0: the scope alone, not "mid" (its immediate child), "leaf" (a grandchild) or "other-root" (outside the scope).
    const scoped = engine.view({ scope: 'root', depth: 0 }, at);
    expect(scoped.elements?.map((e) => e.id).sort()).toEqual(['root']);

    // Scoped at "root", depth 1: one level below the scope too — "mid" — still never "leaf" (two levels below) or "other-root".
    const oneLevel = engine.view({ scope: 'root', depth: 1 }, at);
    expect(oneLevel.elements?.map((e) => e.id).sort()).toEqual(['mid', 'root']);

    // Scoped at "root", depth 2: "leaf" too now, still never "other-root".
    const twoLevels = engine.view({ scope: 'root', depth: 2 }, at);
    expect(twoLevels.elements?.map((e) => e.id).sort()).toEqual(['leaf', 'mid', 'root']);

    // Scoped at "mid" itself, depth 0: "mid" alone, not "leaf" — proves the scope's own ancestor chain length
    // (root -> mid = 1 ancestor), not merely whether a scope was given, sets the depth origin.
    const atMidAlone = engine.view({ scope: 'mid', depth: 0 }, at);
    expect(atMidAlone.elements?.map((e) => e.id).sort()).toEqual(['mid']);

    // Scoped at "mid", depth 1: "mid" and "leaf" (mid's own immediate child).
    const atMidOneLevel = engine.view({ scope: 'mid', depth: 1 }, at);
    expect(atMidOneLevel.elements?.map((e) => e.id).sort()).toEqual(['leaf', 'mid']);

    // Unscoped, depth 0: the roots alone ("root" and "other-root"), never "mid" or "leaf".
    const unscoped = engine.view({ depth: 0 }, at);
    expect(unscoped.elements?.map((e) => e.id).sort()).toEqual(['other-root', 'root']);

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

  test('dependencies/dependents (transitive, B2): a cycle never lists an element as its own dependent or dependency', () => {
    const engine = createLadybugEngine();
    engine.rebuild([
      row('element', element('a', 'service', [])),
      row('element', element('b', 'service', [])),
      row('element', element('c', 'service', [])),
      row('relation', relation('a-to-b', 'a', 'b')),
      row('relation', relation('b-to-c', 'b', 'c')),
      row('relation', relation('c-to-a', 'c', 'a')),
    ]);
    const at = { valid: DAY(2), known: DAY(2), state: 'as-is' };

    const dependencies = engine.dependencies('a', { transitive: true }, at);
    expect(dependencies.error).toBeUndefined();
    expect(dependencies.elements?.map((e) => e.id).sort()).toEqual(['b', 'c']);

    const dependents = engine.dependents('a', { transitive: true }, at);
    expect(dependents.error).toBeUndefined();
    expect(dependents.elements?.map((e) => e.id).sort()).toEqual(['b', 'c']);

    engine.close();
  });

  test('dependencies (transitive, B2): a realistic-sized graph with cycles answers quickly instead of enumerating every walk (a plain variable-length pattern explodes combinatorially on a cycle)', () => {
    const engine = createLadybugEngine();
    const rows: AssertionRecord[] = [];
    const n = 10;
    for (let i = 0; i < n; i++) rows.push(row('element', element(`e${i}`, 'service', [])));
    // A ring plus a few chords: every node reaches every other, and several
    // hops complete a cycle back to the start — the shape that made the
    // review's e6/e7 experiments blow the buffer pool before B2's fix.
    for (let i = 0; i < n; i++) rows.push(row('relation', relation(`ring${i}`, `e${i}`, `e${(i + 1) % n}`)));
    for (let i = 0; i < n; i += 2) rows.push(row('relation', relation(`chord${i}`, `e${i}`, `e${(i + 5) % n}`)));
    engine.rebuild(rows);
    const at = { valid: DAY(2), known: DAY(2), state: 'as-is' };

    const started = performance.now();
    const result = engine.dependencies('e0', { transitive: true, maxHops: 30 }, at);
    const elapsed = performance.now() - started;
    expect(result.error).toBeUndefined();
    expect(result.elements?.map((e) => e.id).sort()).toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9']);
    expect(result.elements?.every((e) => !e.chain.includes(''))).toBe(true);
    expect(elapsed).toBeLessThan(5000);

    engine.close();
  });

  test('dependencies (transitive, B2): two equally-short chains to the same element pick the lexicographically least one, deterministically; multiple elements come back sorted by id', () => {
    const engine = createLadybugEngine();
    engine.rebuild([
      row('element', element('a', 'service', [])),
      row('element', element('b', 'service', [])),
      row('element', element('c', 'service', [])),
      row('element', element('d', 'service', [])),
      row('element', element('z', 'service', [])),
      // Two equally-short (2-hop) chains from a to d: via b ("a-to-b" then
      // "b-to-d") and via c ("a-to-c" then "c-to-d"). "a-to-b" sorts before
      // "a-to-c" by code point, so the chain through b must be the one
      // chosen — not whichever this LadybugDB build's own ALL SHORTEST
      // happens to enumerate first.
      row('relation', relation('a-to-b', 'a', 'b')),
      row('relation', relation('a-to-c', 'a', 'c')),
      row('relation', relation('b-to-d', 'b', 'd')),
      row('relation', relation('c-to-d', 'c', 'd')),
      // z is one hop away, d is two — reached in whatever order this
      // build's own traversal happens to enumerate them, so the answer's
      // own elements only ever come back sorted by id if `dependencyAnswer`
      // actually sorts them, not merely by coincidence of hop count.
      row('relation', relation('a-to-z', 'a', 'z')),
    ]);
    const at = { valid: DAY(2), known: DAY(2), state: 'as-is' };

    const result = engine.dependencies('a', { transitive: true }, at);
    expect(result.error).toBeUndefined();
    expect(result.elements).toEqual([
      { id: 'b', chain: ['a-to-b'] },
      { id: 'c', chain: ['a-to-c'] },
      { id: 'd', chain: ['a-to-b', 'b-to-d'] },
      { id: 'z', chain: ['a-to-z'] },
    ]);

    engine.close();
  });

  describe('dependencies (transitive, B2): the review\'s e7 shapes answer without exception or crash', () => {
    // (elements, relations, maxHops) — the exact shapes the review's e7.ts
    // experiment used to blow the buffer pool before B2's fix, a plain
    // `*1..N` pattern enumerating every walk rather than every shortest one.
    const shapes: [elements: number, relations: number, maxHops: number][] = [
      [10, 30, 30],
      [100, 300, 30],
      [50, 150, 5],
      [100, 300, 6],
    ];

    for (const [elementCount, relationCount, maxHops] of shapes) {
      test(`${elementCount} elements, ${relationCount} relations, maxHops ${maxHops}`, () => {
        const rows: AssertionRecord[] = [];
        for (let i = 0; i < elementCount; i++) rows.push(row('element', element(`e${i}`, 'service', [])));
        let seed = 5;
        const rnd = () => {
          seed = (seed * 1103515245 + 12345) % 2147483648;
          return seed / 2147483648;
        };
        for (let k = 0; k < relationCount; k++) {
          const from = Math.floor(rnd() * elementCount);
          const to = Math.floor(rnd() * elementCount);
          if (from === to) continue;
          rows.push(row('relation', relation(`r${k}`, `e${from}`, `e${to}`)));
        }
        const engine = createLadybugEngine();
        engine.rebuild(rows);
        const at = { valid: DAY(2), known: DAY(2), state: 'as-is' };

        expect(() => engine.dependencies('e0', { transitive: true, maxHops }, at)).not.toThrow();
        const result = engine.dependencies('e0', { transitive: true, maxHops }, at);
        expect(result.error).toBeUndefined();
        expect(result.elements?.some((e) => e.id === 'e0')).toBe(false);

        engine.close();
      });
    }
  });

  test('close: releases the underlying database so many engines can be opened and closed in one process without exhausting it, and each one still answers correctly before its own close', () => {
    const at = { valid: DAY(2), known: DAY(2), state: 'as-is' };
    for (let i = 0; i < 40; i++) {
      const engine = createLadybugEngine();
      engine.rebuild([row('element', element('a', 'domain', [])), row('element', element(`child${i}`, 'service', ['a'], { parent: 'a' }))]);
      // If `close` failed to release its `Database`, this many instances
      // would exhaust the process's own resources well before finishing the
      // loop (observed directly while building this engine — see its
      // module doc); a real query against each one, not merely opening and
      // closing it, is what would actually surface that.
      const result = engine.children('a', at);
      expect(result.error).toBeUndefined();
      expect(result.elements?.map((e) => e.id)).toEqual([`child${i}`]);
      engine.close();
    }
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
    engine.update([{ source: 's', kind: 'relation', id: 'a-to-b', content: relation('a-to-b', 'a', 'b'), validFrom: DAY(1), validTo: null, recordedFrom: DAY(1), recordedTo: null }], []);
    expect(engine.dependencies('a', {}, at).elements?.map((e) => e.id)).toEqual(['b']);

    engine.update([], [{ source: 's', kind: 'relation', id: 'a-to-b', content: relation('a-to-b', 'a', 'b'), validFrom: DAY(1), validTo: null, recordedFrom: DAY(1), recordedTo: DAY(2) }]);
    expect(engine.dependencies('a', {}, at).elements?.map((e) => e.id)).toEqual([]);

    // A state, opened then closed through `update`, changes what a query
    // with no explicit state defaults to.
    engine.update(
      [
        { source: 's', kind: 'state', id: 'as-is', content: JSON.stringify({ id: 'as-is' }), validFrom: DAY(1), validTo: null, recordedFrom: DAY(1), recordedTo: null },
        { source: 's', kind: 'state', id: 'to-be', content: JSON.stringify({ id: 'to-be', after: 'as-is' }), validFrom: DAY(1), validTo: null, recordedFrom: DAY(1), recordedTo: null },
      ],
      [],
    );
    engine.update(
      [],
      [{ source: 's', kind: 'state', id: 'to-be', content: JSON.stringify({ id: 'to-be', after: 'as-is' }), validFrom: DAY(1), validTo: null, recordedFrom: DAY(1), recordedTo: DAY(2) }],
    );
    const defaulted = engine.children('a', { valid: DAY(2), known: DAY(2) });
    expect(defaulted.error).toBeUndefined();

    engine.close();
  });

  test("update (B3/M1): closing a 'state' change routes to removeState, not removeRelation, and matches only the exact source/id/validFrom row it names", () => {
    const engine = createLadybugEngine();
    engine.rebuild([row('element', element('a', 'service', [], { states: ['root-x', 'root-y'] }), { recordedFrom: 0 })]);
    const at = { valid: DAY(2), known: DAY(2) };

    // Two independent roots (a genuine disagreement, source y's own):
    // known=100 sees only x's root-x; known=200 also sees y's root-y —
    // which must then refuse, naming the disagreement.
    engine.update(
      [
        { source: 'x', kind: 'state', id: 'root-x', content: JSON.stringify({ id: 'root-x' }), validFrom: DAY(1), validTo: null, recordedFrom: 100, recordedTo: null },
        { source: 'y', kind: 'state', id: 'root-y', content: JSON.stringify({ id: 'root-y' }), validFrom: DAY(1), validTo: null, recordedFrom: 200, recordedTo: null },
      ],
      [],
    );
    expect(engine.children('a', { ...at, known: 150 }).error).toBeUndefined();
    expect(engine.children('a', { ...at, known: 250 }).error).toMatchObject({ message: expect.stringContaining('disagree') });

    // Closing root-y (a `kind: 'state'` change, by source, id and
    // validFrom) must reach `removeState`, not silently no-op through
    // `removeRelation` (there is no relation named "root-y" to begin
    // with) — and must match root-y's row exactly, not root-x's, which
    // shares neither source nor id nor validFrom.
    engine.update([], [{ source: 'y', kind: 'state', id: 'root-y', content: JSON.stringify({ id: 'root-y' }), validFrom: DAY(1), validTo: null, recordedFrom: 200, recordedTo: 300 }]);

    // Before the close (known=250, between root-y's open and close): still disagrees.
    expect(engine.children('a', { ...at, known: 250 }).error).toMatchObject({ message: expect.stringContaining('disagree') });
    // At and after the close (known=300+): root-y is gone, root-x alone resolves.
    const afterClose = engine.children('a', { ...at, known: 300 });
    expect(afterClose.error).toBeUndefined();
    // root-x itself must still be there — a wrong match (e.g. matching by
    // id or validFrom alone) could have closed root-x's own row instead.
    expect(engine.children('a', { ...at, known: 150 }).error).toBeUndefined();

    engine.close();
  });

  test('as-of: with no `at` at all, a query still answers rather than throwing (both times and the state default to now/"as-is")', () => {
    const engine = createLadybugEngine();
    engine.rebuild([row('element', element('a', 'service', []), { validFrom: DAY(1) })]);
    expect(() => engine.children('a')).not.toThrow();
    expect(engine.children('a').elements?.map((e) => e.id)).toEqual([]);
    engine.close();
  });

  test('as-of (minor 6): with no `at.valid`/`at.known`, a query defaults to the clock the engine was created with, not the real wall clock', () => {
    const element1 = element('parent', 'domain', []);
    const child1 = element('child', 'service', ['parent'], { parent: 'parent' });
    const engine = createLadybugEngine({ clock: { now: () => DAY(5) } });
    engine.rebuild([row('element', element1, { validFrom: DAY(1), validTo: DAY(3) }), row('element', child1, { validFrom: DAY(1), validTo: DAY(3) })]);

    // Left out entirely, both `valid` and `known` come from the injected
    // clock (day 5) — past the element's own `validTo` (day 3), so it no
    // longer exists then — not `Date.now()`, which this fixture's days are
    // nowhere near (a real "now" would see nothing recorded at all yet,
    // a different refusal, or on a machine whose clock genuinely landed
    // inside this fixture's own tiny range, the wrong answer entirely).
    const result = engine.children('parent');
    expect(result.error).toMatchObject({ id: 'parent', time: DAY(5) });

    // An explicit `valid` still overrides the clock's own default.
    const explicit = engine.children('parent', { valid: DAY(2), known: DAY(5) });
    expect(explicit.elements?.map((e) => e.id)).toEqual(['child']);

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

    // The four tests above alone would not catch a bound whose comparison
    // was replaced outright (not merely off by one) with an
    // always-true/always-false literal: at exactly the edge, `validFrom <=
    // valid` and a literal `true` agree, and so do `validTo > valid` and a
    // literal `false` when `validTo` is unset in every other fixture this
    // file ever built. Each pair below probes the opposite side of the
    // same edge, where a real comparison and its always-true/false
    // replacement disagree.
    test('validFrom <= valid: "as-is" is not yet visible strictly before its own validFrom', () => {
      const engine = createLadybugEngine();
      engine.rebuild(statesAt('validFrom', DAY(10)));
      expect(engine.children('a', { valid: DAY(5), known: DAY(20) }).error).toMatchObject({ message: expect.stringContaining('disagree') });
      engine.close();
    });

    test('validTo > valid: "as-is" is still visible strictly before its own validTo (not merely at it)', () => {
      const engine = createLadybugEngine();
      engine.rebuild(statesAt('validTo', DAY(20)));
      expect(engine.children('a', { valid: DAY(15), known: DAY(30) }).error).toBeUndefined();
      engine.close();
    });

    test('recordedFrom <= known: "as-is" is not yet known strictly before its own recordedFrom', () => {
      const engine = createLadybugEngine();
      engine.rebuild(statesAt('recordedFrom', DAY(10)));
      expect(engine.children('a', { valid: DAY(20), known: DAY(5) }).error).toMatchObject({ message: expect.stringContaining('disagree') });
      engine.close();
    });

    test('recordedTo > known: "as-is" is still known strictly before its own recordedTo (not merely at it)', () => {
      const engine = createLadybugEngine();
      engine.rebuild(statesAt('recordedTo', DAY(20)));
      expect(engine.children('a', { valid: DAY(30), known: DAY(15) }).error).toBeUndefined();
      engine.close();
    });
  });

  test('rebuild: known-axis time travel works through the engine, not only through the history — a correction made after the fact is invisible at a known time before it was made', () => {
    // Mirrors the model-history capability's own "what-we-knew" scenario,
    // through the query engine this time: `legacy` is removed from `shop`
    // in a later commit, but the removal (a correction to the record) was
    // only recorded on day 11 — asking as of a known time before that must
    // still see the history as it stood then, `legacy` included.
    const engine = createLadybugEngine();
    engine.rebuild([
      row('element', element('shop', 'domain', [])),
      // `legacy` was believed to exist [day1, +inf) until day 11, when the
      // correction closed that belief and opened a narrower one instead —
      // both rows are in the history, only one of them current today.
      row('element', element('legacy', 'service', ['shop'], { parent: 'shop' }), { validFrom: DAY(1), validTo: null, recordedFrom: DAY(2), recordedTo: DAY(11) }),
      row('element', element('legacy', 'service', ['shop'], { parent: 'shop' }), { validFrom: DAY(1), validTo: DAY(10), recordedFrom: DAY(11), recordedTo: null }),
    ]);

    // As of a known time before the correction: legacy is still believed to exist at day 20.
    const before = engine.children('shop', { valid: DAY(20), known: DAY(5), state: 'as-is' });
    expect(before.elements?.map((e) => e.id)).toEqual(['legacy']);

    // As of now (after the correction): legacy is known to have ended at day 10.
    const after = engine.children('shop', { valid: DAY(20), known: DAY(20), state: 'as-is' });
    expect(after.elements?.map((e) => e.id)).toEqual([]);

    engine.close();
  });
});
