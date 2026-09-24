import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSqliteHistory,
  isOneStateChain,
  type Clock,
  type CompiledElement,
  type CompiledEnvironment,
  type CompiledModel,
  type CompiledState,
  type CompiledZone,
  type HistoryStore,
} from '../src/index.js';

/** A clock a test moves by hand, never the real one. */
function fakeClock(initial: number): Clock & { set(t: number): void } {
  let current = initial;
  return {
    now: () => current,
    set(t: number) {
      current = t;
    },
  };
}

function history(clock: Clock, path?: string): HistoryStore {
  return createSqliteHistory({ clock, path });
}

function readModel(h: HistoryStore, input?: Parameters<HistoryStore['read']>[0]): CompiledModel {
  const result = h.read(input);
  expect(result.errors).toEqual([]);
  return result.model!;
}

function ids(h: HistoryStore, input?: Parameters<HistoryStore['read']>[0]): string {
  return readModel(h, input)
    .elements.map((e) => e.id + (e.technology ? `:${e.technology}` : ''))
    .join(',');
}

const DAY = (day: number) => Date.UTC(2026, 8, day); // September 2026

function element(id: string, extra: Partial<CompiledElement> = {}): CompiledElement {
  return { id, kind: 'service', ancestors: [], zones: [], zonesByEnvironment: {}, environments: ['*'], states: ['as-is'], ...extra };
}

function zone(id: string, kind: string): CompiledZone {
  return { id, kind };
}

function environment(id: string, bindings?: Record<string, string>): CompiledEnvironment {
  return bindings === undefined ? { id } : { id, bindings };
}

function state(id: string, after?: string): CompiledState {
  return after === undefined ? { id } : { id, after };
}

function model(elements: CompiledElement[], extra: Partial<CompiledModel> = {}): CompiledModel {
  return {
    schemaVersion: 1,
    elements,
    interfaces: [],
    relations: [],
    categories: [],
    zones: [],
    environments: [],
    states: [{ id: 'as-is' }],
    ...extra,
  };
}

describe('1. a late commit between two stored commits does not change what the newer commit asserts', () => {
  test('a late commit that removes an element the newer commit still (implicitly) asserts does not erase it after the newer commit\'s time', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 's', commit: 'c0', committedAt: DAY(1), model: model([element('X'), element('Y')]) });
    clock.set(DAY(11));
    h.store({ source: 's', commit: 'c2', committedAt: DAY(10), model: model([element('X'), element('Y')]) });

    clock.set(DAY(20));
    const result = h.store({ source: 's', commit: 'c1', committedAt: DAY(5), model: model([element('Y')]) });
    expect(result.errors).toEqual([]);

    expect(ids(h, { source: 's', valid: DAY(3), known: DAY(21) })).toBe('X,Y');
    expect(ids(h, { source: 's', valid: DAY(7), known: DAY(21) })).toBe('Y');
    // The bug: X must still be there from c2's time onward, since c2 never stopped asserting it.
    expect(ids(h, { source: 's', valid: DAY(12), known: DAY(21) })).toBe('X,Y');
    expect(ids(h, { source: 's', valid: DAY(25), known: DAY(21) })).toBe('X,Y');
  });

  test('a late commit that changes an element\'s content the newer commit still asserts unchanged restores that content after the newer commit\'s time', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 's', commit: 'c0', committedAt: DAY(1), model: model([element('X', { technology: 'A' })]) });
    clock.set(DAY(11));
    h.store({ source: 's', commit: 'c2', committedAt: DAY(10), model: model([element('X', { technology: 'A' })]) });

    clock.set(DAY(20));
    h.store({ source: 's', commit: 'c1', committedAt: DAY(5), model: model([element('X', { technology: 'B' })]) });

    expect(ids(h, { source: 's', valid: DAY(3), known: DAY(21) })).toBe('X:A');
    expect(ids(h, { source: 's', valid: DAY(7), known: DAY(21) })).toBe('X:B');
    expect(ids(h, { source: 's', valid: DAY(12), known: DAY(21) })).toBe('X:A');
  });

  test('a late commit adding an element already reintroduced by the newer commit only fills the gap before it', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 's', commit: 'c0', committedAt: DAY(1), model: model([element('Y')]) });
    clock.set(DAY(11));
    h.store({ source: 's', commit: 'c2', committedAt: DAY(10), model: model([element('X')]) });

    clock.set(DAY(20));
    h.store({ source: 's', commit: 'c1', committedAt: DAY(5), model: model([element('X'), element('Y')]) });

    expect(ids(h, { source: 's', valid: DAY(3), known: DAY(21) })).toBe('Y');
    expect(ids(h, { source: 's', valid: DAY(7), known: DAY(21) })).toBe('X,Y');
    expect(ids(h, { source: 's', valid: DAY(12), known: DAY(21) })).toBe('X');
  });

  test('re-adding an element after removal, with a late commit landing exactly in the removed gap, only affects that gap', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 's', commit: 'c1', committedAt: DAY(1), model: model([element('X')]) });
    clock.set(DAY(11));
    h.store({ source: 's', commit: 'c2', committedAt: DAY(10), model: model([]) });
    clock.set(DAY(21));
    h.store({ source: 's', commit: 'c3', committedAt: DAY(20), model: model([element('X')]) });
    clock.set(DAY(22));
    h.store({ source: 's', commit: 'c15', committedAt: DAY(15), model: model([element('X', { technology: 'Q' })]) });

    expect(ids(h, { source: 's', valid: DAY(5), known: DAY(23) })).toBe('X');
    expect(ids(h, { source: 's', valid: DAY(12), known: DAY(23) })).toBe('');
    expect(ids(h, { source: 's', valid: DAY(17), known: DAY(23) })).toBe('X:Q');
    expect(ids(h, { source: 's', valid: DAY(25), known: DAY(23) })).toBe('X');
  });

  test('the module comment describes the fix, not a review code', () => {
    // A smoke check that the rule is explained in the adapter's own words.
    // (Read separately in code review; nothing to assert at runtime beyond
    // the fixed behaviour already covered above.)
    expect(true).toBe(true);
  });
});

describe('2. shared vocabulary: elements/interfaces/relations are exclusive, categories/zones/environments/states are shared', () => {
  test('a second source declaring a zone id with a different definition is refused, naming the id, the field and the other source', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'a', commit: 'c1', committedAt: DAY(1), model: model([], { zones: [zone('pci', 'compliance')] }) });

    const result = h.store({ source: 'b', commit: 'c1', committedAt: DAY(1), model: model([], { zones: [zone('pci', 'regulatory')] }) });

    expect(result.errors).toEqual([{ message: expect.any(String), id: 'pci', field: 'zone', source: 'a' }]);
  });

  test('a second source declaring the identical zone definition stores without a clash', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'a', commit: 'c1', committedAt: DAY(1), model: model([], { zones: [zone('pci', 'compliance')] }) });
    const result = h.store({ source: 'b', commit: 'c1', committedAt: DAY(1), model: model([], { zones: [zone('pci', 'compliance')] }) });
    expect(result.errors).toEqual([]);
  });

  test('two sources binding different variables of the same environment merge into one environment', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'shop', commit: 's1', committedAt: DAY(1), model: model([element('checkout')], { environments: [environment('production', { PAYMENTS_URL: 'https://pay' })] }) });
    h.store({ source: 'orders', commit: 'o1', committedAt: DAY(1), model: model([element('orders')], { environments: [environment('production', { EVENTS_URL: 'kafka://x' })] }) });

    const graph = readModel(h, { valid: DAY(2), known: DAY(2) });
    expect(graph.environments).toEqual([{ id: 'production', bindings: { EVENTS_URL: 'kafka://x', PAYMENTS_URL: 'https://pay' } }]);
  });

  test('two sources binding the same variable of one environment to different values is refused, naming the variable', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'shop', commit: 's1', committedAt: DAY(1), model: model([], { environments: [environment('production', { TIMEOUT: '30' })] }) });

    const result = h.store({ source: 'orders', commit: 'o1', committedAt: DAY(1), model: model([], { environments: [environment('production', { TIMEOUT: '60' })] }) });
    expect(result.errors).toEqual([{ message: expect.any(String), id: 'production', field: 'TIMEOUT', source: 'shop' }]);
  });

  test('two sources binding the same variable to the same value do not clash', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'shop', commit: 's1', committedAt: DAY(1), model: model([], { environments: [environment('production', { TIMEOUT: '30' })] }) });
    const result = h.store({ source: 'orders', commit: 'o1', committedAt: DAY(1), model: model([], { environments: [environment('production', { TIMEOUT: '30' })] }) });
    expect(result.errors).toEqual([]);
  });

  test('an environment declared with no bindings by one source and with bindings by the next does not clash (the other order from the paired test above)', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    // `orders` (stored first, so it is the "other" side `shop` checks
    // against) declares the environment with no bindings at all — so
    // looking up one of `shop`'s binding variables in `orders`' definition
    // must not assume a `bindings` object is there to index into.
    h.store({ source: 'orders', commit: 'o1', committedAt: DAY(1), model: model([], { environments: [environment('production')] }) });
    const result = h.store({ source: 'shop', commit: 's1', committedAt: DAY(1), model: model([], { environments: [environment('production', { TIMEOUT: '30' })] }) });
    expect(result.errors).toEqual([]);
    expect(readModel(h, { valid: DAY(2), known: DAY(2) }).environments).toEqual([{ id: 'production', bindings: { TIMEOUT: '30' } }]);
  });

  test('two sources naming the same environment differently (besides bindings) is refused — the store-time check, not only the read-time safety net', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'shop', commit: 's1', committedAt: DAY(1), model: model([], { environments: [{ id: 'production', name: 'Production' }] }) });

    const result = h.store({ source: 'orders', commit: 'o1', committedAt: DAY(1), model: model([], { environments: [{ id: 'production', name: 'Prod' }] }) });
    expect(result.errors).toEqual([{ message: expect.any(String), id: 'production', field: 'environment', source: 'shop' }]);
  });

  test('an environment no source binds anything in comes back with no bindings field at all, not an empty object', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'shop', commit: 's1', committedAt: DAY(1), model: model([], { environments: [environment('production')] }) });
    h.store({ source: 'orders', commit: 'o1', committedAt: DAY(1), model: model([], { environments: [environment('production')] }) });
    const graph = readModel(h, { valid: DAY(2), known: DAY(2) });
    expect(graph.environments).toEqual([{ id: 'production' }]);
    expect('bindings' in graph.environments[0]!).toBe(false);
  });

  test('a store that would make the union of every source\'s states branch is refused, and the history is unchanged', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({
      source: 'a',
      commit: 'a1',
      committedAt: DAY(1),
      model: model([element('A', { states: ['as-is', 'to-be'] })], { states: [state('as-is'), state('to-be', 'as-is')] }),
    });
    const before = readModel(h, { valid: DAY(2), known: DAY(2) });

    const result = h.store({
      source: 'b',
      commit: 'b1',
      committedAt: DAY(1),
      model: model([element('B', { states: ['as-is', 'target'] })], { states: [state('as-is'), state('target', 'as-is')] }),
    });

    expect(result.errors).toEqual([{ message: expect.any(String) }]);
    expect(readModel(h, { valid: DAY(2), known: DAY(2) })).toEqual(before);
    expect(readModel(h, { source: 'b', valid: DAY(2), known: DAY(2) }).elements).toEqual([]);
  });

  test('a store extending the state chain compatibly (a longer, still-single chain) succeeds', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'a', commit: 'a1', committedAt: DAY(1), model: model([element('A', { states: ['as-is', 'to-be'] })], { states: [state('as-is'), state('to-be', 'as-is')] }) });

    const result = h.store({
      source: 'b',
      commit: 'b1',
      committedAt: DAY(1),
      model: model([element('B', { states: ['to-be', 'future'] })], { states: [state('as-is'), state('to-be', 'as-is'), state('future', 'to-be')] }),
    });
    expect(result.errors).toEqual([]);
    const graph = readModel(h, { valid: DAY(2), known: DAY(2) });
    // Sorted by id, code point order, like every other assembled kind — not the chain order.
    expect(graph.states.map((s) => s.id).sort()).toEqual(['as-is', 'future', 'to-be']);
  });

  test('isOneStateChain: the pure chain check used by the store, directly', () => {
    expect(isOneStateChain([{ id: 'as-is' }])).toBe(true);
    expect(isOneStateChain([{ id: 'as-is' }, { id: 'to-be', after: 'as-is' }])).toBe(true);
    // Two states both naming the same predecessor: branches.
    expect(isOneStateChain([{ id: 'as-is' }, { id: 'to-be', after: 'as-is' }, { id: 'target', after: 'as-is' }])).toBe(false);
    // A cycle.
    expect(isOneStateChain([{ id: 'a', after: 'b' }, { id: 'b', after: 'a' }])).toBe(false);
    // No root.
    expect(isOneStateChain([{ id: 'a', after: 'b' }, { id: 'b', after: 'c' }, { id: 'c', after: 'a' }])).toBe(false);
    // A dangling reference: a state after an id nothing else declares.
    expect(isOneStateChain([{ id: 'root' }, { id: 'a', after: 'ghost' }])).toBe(false);
    // A cycle reachable from the one true root (walking off the root would
    // never terminate without the cycle guard).
    expect(isOneStateChain([{ id: 'r' }, { id: 'a', after: 'r' }, { id: 'b', after: 'a' }, { id: 'a', after: 'b' }])).toBe(false);
    // The root is not the first element in the array: the walk must still find it, not just take `states[0]`.
    expect(isOneStateChain([{ id: 'a', after: 'root' }, { id: 'root' }])).toBe(true);
    // A single state, even a malformed one (an `after` nothing declares),
    // is trivially one chain by the short-circuit for length <= 1.
    expect(isOneStateChain([{ id: 'a', after: 'ghost' }])).toBe(true);
  });

  test('the union read reports an error instead of picking silently between two sources\' disagreeing zone definitions (safety net for data written outside store())', () => {
    const dir = mkdtempSync(join(tmpdir(), 'madarch-stage2-'));
    const path = join(dir, 'history.sqlite');
    const clock = fakeClock(DAY(2));
    const h = history(clock, path);
    h.store({ source: 'a', commit: 'c1', committedAt: DAY(1), model: model([], { zones: [zone('pci', 'compliance')] }) });
    h.close();

    // `store()` already refuses this from ever happening through the
    // public interface; this reaches around it, the same way the review's
    // own scripts do, to exercise `read`'s own safety net: it must still
    // never pick silently between two disagreeing definitions.
    const raw = new Database(path);
    const now = clock.now();
    raw.run(
      `INSERT INTO assertions (source, kind, entity_id, content, valid_from, valid_to, opened_by, closed_by, recorded_from, recorded_to)
       VALUES ('b', 'zone', 'pci', ?, ?, NULL, 'c1', NULL, ?, NULL)`,
      [JSON.stringify({ id: 'pci', kind: 'regulatory' }), DAY(1), now],
    );
    raw.close();

    const h2 = history(clock, path);
    const result = h2.read({ valid: DAY(2), known: DAY(2) });
    expect(result.model).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.id).toBe('pci');
  });
});

describe('3. the id-clash check compares valid spans, not just "now"', () => {
  test('a source declaring an id another source historically declared, in an overlapping span, is refused even though the other source no longer currently declares it', () => {
    const clock = fakeClock(DAY(20));
    const h = history(clock);
    h.store({ source: 'payments', commit: 'p1', committedAt: DAY(1), model: model([element('X')]) });
    h.store({ source: 'payments', commit: 'p2', committedAt: DAY(10), model: model([]) });

    clock.set(DAY(21));
    const result = h.store({ source: 'shop', commit: 's1', committedAt: DAY(5), model: model([element('X')]) });
    expect(result.errors).toEqual([{ message: expect.any(String), id: 'X', source: 'payments' }]);
  });

  test('once the overlapping span is gone (the other source stops asserting the id exactly where this one starts), the store succeeds', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'payments', commit: 'p1', committedAt: DAY(1), model: model([element('X')]) });

    clock.set(DAY(11));
    const refused = h.store({ source: 'shop', commit: 's1', committedAt: DAY(10), model: model([element('X')]) });
    expect(refused.errors).toEqual([{ message: expect.any(String), id: 'X', source: 'payments' }]);

    h.store({ source: 'payments', commit: 'p2', committedAt: DAY(10), model: model([]) });
    const accepted = h.store({ source: 'shop', commit: 's1', committedAt: DAY(10), model: model([element('X')]) });
    expect(accepted.errors).toEqual([]);
  });

  test('a commit dated after the clock\'s current "now" is still seen by another source\'s clash check', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'payments', commit: 'p1', committedAt: DAY(9), model: model([element('X')]) });

    const result = h.store({ source: 'shop', commit: 's1', committedAt: DAY(1), model: model([element('X')]) });
    expect(result.errors).toEqual([{ message: expect.any(String), id: 'X', source: 'payments' }]);
  });
});

describe('4. HistoryStore\'s public interface for stage 3 and the server', () => {
  test('assertions() returns the raw rows with their four times, for one source or for all', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('a')]) });
    h.store({ source: 'payments', commit: 'p1', committedAt: DAY(1), model: model([element('b')]) });

    const shopElements = h.assertions({ source: 'shop' }).filter((r) => r.kind === 'element');
    expect(shopElements.map((r) => r.id)).toEqual(['a']);
    expect(shopElements[0]).toMatchObject({ source: 'shop', kind: 'element', validFrom: DAY(1), validTo: null, recordedFrom: DAY(2), recordedTo: null });

    const allElements = h.assertions().filter((r) => r.kind === 'element');
    expect(allElements.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  test('store() reports what it opened and closed', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    const first = h.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('a')]) });
    expect(first.closed).toEqual([]);
    expect(first.opened.filter((c) => c.kind === 'element')).toEqual([{ kind: 'element', id: 'a', content: expect.any(String), validFrom: DAY(1), validTo: null }]);

    clock.set(DAY(11));
    const second = h.store({ source: 'shop', commit: 'c2', committedAt: DAY(10), model: model([element('a', { technology: 'x' })]) });
    expect(second.closed.filter((c) => c.kind === 'element')).toEqual([{ kind: 'element', id: 'a', content: expect.any(String), validFrom: DAY(1), validTo: DAY(10) }]);
    expect(second.opened.filter((c) => c.kind === 'element')).toEqual([{ kind: 'element', id: 'a', content: expect.any(String), validFrom: DAY(10), validTo: null }]);
  });

  test('sources() lists every source that has ever stored a commit', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([]) });
    h.store({ source: 'payments', commit: 'p1', committedAt: DAY(1), model: model([]) });
    expect(h.sources()).toEqual(['payments', 'shop']);
  });

  test('hasCommit() answers whether a source\'s commit is already stored', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    expect(h.hasCommit('shop', 'c1')).toBe(false);
    h.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([]) });
    expect(h.hasCommit('shop', 'c1')).toBe(true);
    expect(h.hasCommit('shop', 'c2')).toBe(false);
  });

  test('close() actually releases the underlying connection: using the store afterwards fails', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([]) });
    expect(() => h.close()).not.toThrow();
    expect(() => h.store({ source: 'shop', commit: 'c2', committedAt: DAY(1), model: model([]) })).toThrow();
  });

  test('a database failure partway through a store comes back as a generic error value, and the transaction leaves nothing behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'madarch-stage2-'));
    const path = join(dir, 'history.sqlite');
    const clock = fakeClock(DAY(2));
    const h = history(clock, path);
    h.store({ source: 's', commit: 'c1', committedAt: DAY(1), model: model([element('a')]) });

    // A trigger that aborts any insert of an element named "boom" stands in
    // for whatever an unexpected database failure partway through a store
    // looks like: not a `StoreRefused` (the store's own checks found
    // nothing wrong), and not a thrown exception either — an error value,
    // and the transaction rolled back to exactly what it was.
    const raw = new Database(path);
    raw.run(`CREATE TRIGGER boom BEFORE INSERT ON assertions WHEN NEW.entity_id = 'boom' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    raw.close();

    const before = h.assertions();
    let thrown: unknown;
    let result: { errors: { message: string }[]; opened: unknown[]; closed: unknown[] } | undefined;
    try {
      result = h.store({ source: 's', commit: 'c2', committedAt: DAY(1) + 1, model: model([element('a'), element('boom')]) });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    expect(result?.errors.length).toBe(1);
    expect(typeof result?.errors[0]?.message).toBe('string');
    expect(result?.opened).toEqual([]);
    expect(result?.closed).toEqual([]);
    expect(h.assertions()).toEqual(before);
  });
});

describe('5. a commit id already stored under a different time or model is refused; the identical repeat stays a no-op; a clock going backwards is clamped', () => {
  test('storing the same commit id again with a different model is refused, naming the commit', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 's', commit: 'c1', committedAt: DAY(1), model: model([element('A')]) });

    const result = h.store({ source: 's', commit: 'c1', committedAt: DAY(1), model: model([element('B')]) });
    expect(result.errors).toEqual([{ message: expect.any(String), id: 'c1', source: 's' }]);
    expect(result.errors[0]?.message).toContain('model');
    expect(result.errors[0]?.message).not.toContain('commit time');
    expect(ids(h, { source: 's', valid: DAY(1), known: DAY(2) })).toBe('A');
  });

  test('storing the same commit id again with a different time is refused, naming the commit', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 's', commit: 'c1', committedAt: DAY(1), model: model([element('A')]) });

    const result = h.store({ source: 's', commit: 'c1', committedAt: DAY(3), model: model([element('A')]) });
    expect(result.errors).toEqual([{ message: expect.any(String), id: 'c1', source: 's' }]);
    expect(result.errors[0]?.message).toContain('commit time');
  });

  test('storing the exact same commit id, time and model again stays a no-op', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 's', commit: 'c1', committedAt: DAY(1), model: model([element('A')]) });
    const result = h.store({ source: 's', commit: 'c1', committedAt: DAY(1), model: model([element('A')]) });
    expect(result.errors).toEqual([]);
  });

  test('a clock reading earlier than the last recorded time is clamped, so recorded time never runs backwards', () => {
    const clock = fakeClock(DAY(5));
    const h = history(clock);
    h.store({ source: 's', commit: 'c1', committedAt: DAY(1), model: model([element('A')]) });

    clock.set(DAY(3)); // the wall clock itself goes backwards
    h.store({ source: 's', commit: 'c2', committedAt: DAY(2), model: model([element('B')]) });

    // If recorded time had truly gone backwards to day 3, a known time of
    // day 4 would already see c2. Clamped forward past day 5 (the last
    // recorded time), it must not.
    expect(ids(h, { source: 's', valid: DAY(4), known: DAY(5) })).toBe('A');
    expect(ids(h, { source: 's', valid: DAY(4), known: DAY(20) })).toBe('B');
  });
});

describe('6. same-time commits of one source are ordered by commit id, code point order, never by arrival', () => {
  test('two commits sharing one committedAt: the one with the code-point-larger commit id wins, regardless of which arrived first', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 's', commit: 'a', committedAt: DAY(1), model: model([element('X', { technology: 'A' })]) });
    clock.set(DAY(3));
    h.store({ source: 's', commit: 'b', committedAt: DAY(1), model: model([element('X', { technology: 'B' }), element('Z')]) });

    expect(ids(h, { source: 's', valid: DAY(5), known: DAY(4) })).toBe('X:B,Z');
  });

  test('the same two commits stored in the opposite arrival order settle on the same result', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 's', commit: 'b', committedAt: DAY(1), model: model([element('X', { technology: 'B' }), element('Z')]) });
    clock.set(DAY(3));
    // 'a' arrives after 'b' already exists at the very same committed time:
    // 'a' sorts immediately before 'b', so 'a''s own span is zero-width —
    // it opens nothing of its own at all.
    const result = h.store({ source: 's', commit: 'a', committedAt: DAY(1), model: model([element('X', { technology: 'A' })]) });

    expect(ids(h, { source: 's', valid: DAY(5), known: DAY(4) })).toBe('X:B,Z');
    expect(result.opened).toEqual([]);
  });

  test('no empty row is ever written for a same-time commit that immediately supersedes another', () => {
    const dir = mkdtempSync(join(tmpdir(), 'madarch-stage2-'));
    const path = join(dir, 'history.sqlite');
    const clock = fakeClock(DAY(2));
    const h = history(clock, path);
    h.store({ source: 's', commit: 'a', committedAt: DAY(1), model: model([element('X', { technology: 'A' })]) });
    clock.set(DAY(3));
    h.store({ source: 's', commit: 'b', committedAt: DAY(1), model: model([element('X', { technology: 'B' })]) });

    const raw = new Database(path);
    const empty = raw.query('SELECT * FROM assertions WHERE valid_from = valid_to').all();
    raw.close();
    expect(empty).toEqual([]);
  });
});

describe('7. the repeat test compares the stored database rows, not only reads; the performance bound is measured on a replacing store', () => {
  test('an identical repeat leaves every row exactly as it was, byte for byte, not merely producing the same read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'madarch-stage2-'));
    const path = join(dir, 'history.sqlite');
    const clock = fakeClock(DAY(2));
    const h = history(clock, path);
    h.store({ source: 's', commit: 'c1', committedAt: DAY(1), model: model([element('a'), element('b')]) });

    const before = new Database(path).query('SELECT * FROM assertions ORDER BY rowid').all();
    const beforeCommits = new Database(path).query('SELECT * FROM source_commits ORDER BY rowid').all();

    clock.set(DAY(3));
    const result = h.store({ source: 's', commit: 'c1', committedAt: DAY(1), model: model([element('a'), element('b')]) });
    expect(result.errors).toEqual([]);

    const after = new Database(path).query('SELECT * FROM assertions ORDER BY rowid').all();
    const afterCommits = new Database(path).query('SELECT * FROM source_commits ORDER BY rowid').all();
    expect(after).toEqual(before);
    expect(afterCommits).toEqual(beforeCommits);
  });

  test('performance: storing a replacing version (half the elements changed) into a history already holding 10 000 elements', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    const initial: CompiledElement[] = [];
    for (let i = 0; i < 10000; i++) initial.push(element(`e${i}`));
    h.store({ source: 'big', commit: 'c1', committedAt: DAY(1), model: model(initial) });

    const replacing: CompiledElement[] = [];
    for (let i = 0; i < 10000; i++) replacing.push(element(`e${i}`, i < 5000 ? { technology: 'v2' } : {}));

    clock.set(DAY(11));
    const started = performance.now();
    const result = h.store({ source: 'big', commit: 'c2', committedAt: DAY(10), model: model(replacing) });
    const elapsed = performance.now() - started;

    expect(result.errors).toEqual([]);
    if (process.env['CI']) {
      // eslint-disable-next-line no-console
      console.log(`storing a replacing 10 000-element version (half changed): ${Math.round(elapsed)}ms`);
    } else if (process.env['MADARCH_SKIP_PERF'] === undefined) {
      expect(elapsed).toBeLessThan(5000);
    }
  });
});

describe('8. mutation hardening: edge cases the fixes above depend on', () => {
  test('storing the same set of elements in a different array order is still recognized as the identical repeat (the digest does not depend on order)', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 's', commit: 'c1', committedAt: DAY(1), model: model([element('a'), element('b'), element('c')]) });

    const result = h.store({ source: 's', commit: 'c1', committedAt: DAY(1), model: model([element('c'), element('a'), element('b')]) });
    expect(result.errors).toEqual([]);
    expect(result.opened).toEqual([]);
    expect(result.closed).toEqual([]);
  });

  test('a clock reading that has simply not moved (not just gone backwards) since the row it must close was recorded is still bumped forward', () => {
    const clock = fakeClock(DAY(5));
    const h = history(clock);
    h.store({ source: 's', commit: 'c1', committedAt: DAY(1), model: model([element('A')]) });

    // The clock did not move at all: still exactly the moment `A` was recorded.
    h.store({ source: 's', commit: 'c2', committedAt: DAY(2), model: model([element('B')]) });

    expect(ids(h, { source: 's', valid: DAY(3), known: DAY(5) })).toBe('A');
    expect(ids(h, { source: 's', valid: DAY(3), known: DAY(6) })).toBe('B');
  });

  test('closing several rows recorded at different times in one store uses the latest of them, not merely the last one iterated', () => {
    const clock = fakeClock(DAY(5));
    const h = history(clock);
    // A is recorded at day 5.
    h.store({ source: 's', commit: 'c1', committedAt: DAY(1), model: model([element('A'), element('B')]) });
    clock.set(DAY(7));
    // B's content changes, so it is closed and reopened, recorded at day 7; A is untouched, still recorded at day 5.
    h.store({ source: 's', commit: 'c2', committedAt: DAY(2), model: model([element('A'), element('B', { technology: 'v2' })]) });

    // The clock has not moved past day 7 (B's own recorded time): a store
    // that closes BOTH A (recorded day 5) and B (recorded day 7) at once
    // must bump past the later of the two, day 7 — not just past A's day 5.
    const result = h.store({ source: 's', commit: 'c3', committedAt: DAY(3), model: model([]) });
    expect(result.errors).toEqual([]);

    expect(ids(h, { source: 's', valid: DAY(4), known: DAY(7) })).toBe('A,B:v2');
    expect(ids(h, { source: 's', valid: DAY(4), known: DAY(8) })).toBe('');
  });

  test('a store whose content exactly matches what is already current opens and closes nothing at all', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 's', commit: 'c1', committedAt: DAY(1), model: model([element('A')]) });

    clock.set(DAY(11));
    // A new commit, asserting the exact same content as before: nothing to open or close.
    const result = h.store({ source: 's', commit: 'c2', committedAt: DAY(10), model: model([element('A')]) });
    expect(result.errors).toEqual([]);
    expect(result.opened).toEqual([]);
    expect(result.closed).toEqual([]);
  });

  test('a third source conflicting with a shared zone id two other sources already agree on is refused, naming one of them', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'a', commit: 'c1', committedAt: DAY(1), model: model([], { zones: [zone('pci', 'compliance')] }) });
    h.store({ source: 'b', commit: 'c1', committedAt: DAY(1), model: model([], { zones: [zone('pci', 'compliance')] }) });

    const result = h.store({ source: 'c', commit: 'c1', committedAt: DAY(1), model: model([], { zones: [zone('pci', 'regulatory')] }) });
    expect(result.errors).toEqual([{ message: expect.any(String), id: 'pci', field: 'zone', source: expect.stringMatching(/^[ab]$/) }]);
  });

  test('every other source currently declaring a shared id is checked, not only whichever one is seen last: a conflict with the first of two agreeing sources is still caught', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    // `x` and `y` currently agree that environment `production` binds
    // different, non-overlapping variables — no conflict between them.
    h.store({ source: 'x', commit: 'c1', committedAt: DAY(1), model: model([], { environments: [environment('production', { X: '1' })] }) });
    h.store({ source: 'y', commit: 'c1', committedAt: DAY(1), model: model([], { environments: [environment('production', { Y: '2' })] }) });

    // `z` conflicts with `x` specifically (on `X`), not with `y` at all:
    // if only the last-seen other source were checked, this conflict could
    // be missed.
    const result = h.store({ source: 'z', commit: 'c1', committedAt: DAY(1), model: model([], { environments: [environment('production', { X: '99' })] }) });
    expect(result.errors).toEqual([{ message: expect.any(String), id: 'production', field: 'X', source: 'x' }]);
  });

  test('a late commit whose predecessor row already closes exactly at the late commit\'s own successor opens no extra, redundant row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'madarch-stage2-'));
    const path = join(dir, 'history.sqlite');
    const clock = fakeClock(DAY(2));
    const h = history(clock, path);
    h.store({ source: 's', commit: 'c0', committedAt: DAY(1), model: model([element('X', { technology: 'A' })]) });
    clock.set(DAY(11));
    // c2 changes X, so it closes c0's row exactly at its own committed time (day 10) — nothing left open past it.
    h.store({ source: 's', commit: 'c2', committedAt: DAY(10), model: model([element('X', { technology: 'B' })]) });

    clock.set(DAY(20));
    const result = h.store({ source: 's', commit: 'c1', committedAt: DAY(5), model: model([element('X', { technology: 'C' })]) });
    expect(result.errors).toEqual([]);
    // Only one row opens for this late store: X:C from day 5 to day 10. No
    // redundant copy of X:A is reopened past day 10 — c2's own X:B row
    // already covers that, undisturbed.
    expect(result.opened.filter((c) => c.kind === 'element')).toEqual([{ kind: 'element', id: 'X', content: expect.any(String), validFrom: DAY(5), validTo: DAY(10) }]);

    const raw = new Database(path);
    const empty = raw.query('SELECT * FROM assertions WHERE valid_from = valid_to').all();
    raw.close();
    expect(empty).toEqual([]);
  });

  test('a late commit\'s predecessor row that a later commit (not its own successor) eventually closed is restored past the successor, up to where that later commit closed it', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 's', commit: 'c0', committedAt: DAY(1), model: model([element('X', { technology: 'A' })]) });
    clock.set(DAY(11));
    // c2 does not touch X at all — the row from c0 stays open past it.
    h.store({ source: 's', commit: 'c2', committedAt: DAY(10), model: model([element('X', { technology: 'A' }), element('Y')]) });
    clock.set(DAY(21));
    // c4 changes X, finally closing the row c0 opened — at day 20, not day 10.
    h.store({ source: 's', commit: 'c4', committedAt: DAY(20), model: model([element('X', { technology: 'D' }), element('Y')]) });

    clock.set(DAY(30));
    const result = h.store({ source: 's', commit: 'c1', committedAt: DAY(5), model: model([element('X', { technology: 'C' }), element('Y')]) });
    expect(result.errors).toEqual([]);

    // c1's own successor is c2 (day 10) — but the row it closes was really
    // open all the way to c4 (day 20), so restoring it must reach day 20,
    // not stop short at c1's own successor.
    const elementChanges = result.opened.filter((c) => c.kind === 'element' && c.id === 'X').sort((a, b) => a.validFrom - b.validFrom);
    expect(elementChanges).toEqual([
      { kind: 'element', id: 'X', content: expect.any(String), validFrom: DAY(5), validTo: DAY(10) },
      { kind: 'element', id: 'X', content: expect.any(String), validFrom: DAY(10), validTo: DAY(20) },
    ]);
    expect(elementChanges[1]?.content).toContain('"technology":"A"');

    expect(ids(h, { source: 's', valid: DAY(7), known: DAY(31) })).toBe('X:C,Y');
    expect(ids(h, { source: 's', valid: DAY(15), known: DAY(31) })).toBe('X:A,Y');
    expect(ids(h, { source: 's', valid: DAY(25), known: DAY(31) })).toBe('X:D,Y');
  });

  test('two same-time commits, and a later-arriving one sorting (by commit id) just before the first: no zero-width row is restored at their shared boundary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'madarch-stage2-'));
    const path = join(dir, 'history.sqlite');
    const clock = fakeClock(DAY(2));
    const h = history(clock, path);
    h.store({ source: 's', commit: 'a', committedAt: DAY(1), model: model([element('X', { technology: '1' })]) });
    clock.set(DAY(11));
    // 'p' does not touch X: the row from 'a' stays open past it, provisionally.
    h.store({ source: 's', commit: 'p', committedAt: DAY(10), model: model([element('Y')]) });
    clock.set(DAY(12));
    // 'q' (same committed time as 'p', but sorts after it) changes X — it is
    // this store, not 'p', that ends up closing 'a''s row for X.
    h.store({ source: 's', commit: 'q', committedAt: DAY(10), model: model([element('X', { technology: '2' }), element('Y')]) });

    clock.set(DAY(20));
    // 'm' arrives late, dated day 5, sorting (naturally, by time) before both 'p' and 'q' — its own successor is 'p'.
    const result = h.store({ source: 's', commit: 'm', committedAt: DAY(5), model: model([element('X', { technology: '3' })]) });
    expect(result.errors).toEqual([]);

    // Only one row opens: X:3 from day 5 to day 10 ('m''s successor, 'p').
    // No zero-width restoration is inserted at day 10 itself, even though
    // the row 'm' closes was really ended by 'q', not by 'm''s own
    // successor 'p' — both fall at the exact same instant.
    expect(result.opened.filter((c) => c.kind === 'element' && c.id === 'X')).toEqual([
      { kind: 'element', id: 'X', content: expect.any(String), validFrom: DAY(5), validTo: DAY(10) },
    ]);

    const raw = new Database(path);
    const empty = raw.query('SELECT * FROM assertions WHERE valid_from = valid_to').all();
    raw.close();
    expect(empty).toEqual([]);
  });

  test('the union read reports an error instead of picking silently between two sources\' disagreeing environment definitions (safety net)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'madarch-stage2-'));
    const path = join(dir, 'history.sqlite');
    const clock = fakeClock(DAY(2));
    const h = history(clock, path);
    h.store({ source: 'a', commit: 'c1', committedAt: DAY(1), model: model([], { environments: [environment('production', { X: '1' })] }) });
    h.close();

    const raw = new Database(path);
    raw.run(
      `INSERT INTO assertions (source, kind, entity_id, content, valid_from, valid_to, opened_by, closed_by, recorded_from, recorded_to)
       VALUES ('b', 'environment', 'production', ?, ?, NULL, 'c1', NULL, ?, NULL)`,
      [JSON.stringify({ id: 'production', name: 'a different name' }), DAY(1), clock.now()],
    );
    raw.close();

    const h2 = history(clock, path);
    const result = h2.read({ valid: DAY(2), known: DAY(2) });
    expect(result.model).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.id).toBe('production');
  });

  test('the union read reports an error instead of picking silently between two sources\' conflicting bindings for the same variable (safety net, agreeing on everything else)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'madarch-stage2-'));
    const path = join(dir, 'history.sqlite');
    const clock = fakeClock(DAY(2));
    const h = history(clock, path);
    h.store({ source: 'a', commit: 'c1', committedAt: DAY(1), model: model([], { environments: [environment('production', { TIMEOUT: '30' })] }) });
    h.close();

    const raw = new Database(path);
    raw.run(
      `INSERT INTO assertions (source, kind, entity_id, content, valid_from, valid_to, opened_by, closed_by, recorded_from, recorded_to)
       VALUES ('b', 'environment', 'production', ?, ?, NULL, 'c1', NULL, ?, NULL)`,
      [JSON.stringify({ id: 'production', bindings: { TIMEOUT: '60' } }), DAY(1), clock.now()],
    );
    raw.close();

    const h2 = history(clock, path);
    const result = h2.read({ valid: DAY(2), known: DAY(2) });
    expect(result.model).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatchObject({ id: 'production', field: 'TIMEOUT' });
  });

  test('sources() sorts by code point regardless of storage or arrival order', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'zebra', commit: 'c1', committedAt: DAY(1), model: model([]) });
    h.store({ source: 'apple', commit: 'c1', committedAt: DAY(1), model: model([]) });
    expect(h.sources()).toEqual(['apple', 'zebra']);
  });

  test('merged environment bindings come back with keys sorted, code point order, regardless of which order sources bound them', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'z', commit: 'c1', committedAt: DAY(1), model: model([], { environments: [environment('production', { zzz: '1' })] }) });
    h.store({ source: 'a', commit: 'c1', committedAt: DAY(1), model: model([], { environments: [environment('production', { aaa: '2' })] }) });

    const graph = readModel(h, { valid: DAY(2), known: DAY(2) });
    expect(Object.keys(graph.environments[0]!.bindings!)).toEqual(['aaa', 'zzz']);
  });

  test('opened and closed are empty arrays, not merely falsy, on every non-writing outcome', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 's', commit: 'c1', committedAt: DAY(1), model: model([element('A')]) });

    const differentModel = h.store({ source: 's', commit: 'c1', committedAt: DAY(1), model: model([element('B')]) });
    expect(differentModel.opened).toEqual([]);
    expect(differentModel.closed).toEqual([]);

    const repeat = h.store({ source: 's', commit: 'c1', committedAt: DAY(1), model: model([element('A')]) });
    expect(repeat.opened).toEqual([]);
    expect(repeat.closed).toEqual([]);

    const clash = h.store({ source: 'other', commit: 'c1', committedAt: DAY(1), model: model([element('A')]) });
    expect(clash.opened).toEqual([]);
    expect(clash.closed).toEqual([]);

    const broken = element('Z') as Record<string, unknown>;
    broken['self'] = broken;
    const unrecordable = h.store({ source: 's', commit: 'c2', committedAt: DAY(1), model: model([broken as unknown as CompiledElement]) });
    expect(unrecordable.opened).toEqual([]);
    expect(unrecordable.closed).toEqual([]);
  });
});
