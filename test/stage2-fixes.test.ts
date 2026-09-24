import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ASSERTION_KINDS,
  CLASHABLE_KINDS,
  SHARED_KINDS,
  createSqliteHistory,
  isOneStateChain,
  type AssertionChange,
  type Clock,
  type CompiledElement,
  type CompiledEnvironment,
  type CompiledModel,
  type CompiledState,
  type CompiledZone,
  type HistoryStore,
  type ReadModel,
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

function readModel(h: HistoryStore, input?: Parameters<HistoryStore['read']>[0]): ReadModel {
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

/**
 * Checks a `store` call's reported `opened`/`closed` against the store's own
 * `assertions()` afterward: every opened change must be the currently open
 * row it claims to be, and every closed change must name a row that really
 * is closed (`recordedTo` set), by the same source, kind, id, content and
 * `validFrom` — not merely a read that happens to agree.
 */
function verifyReport(h: HistoryStore, opened: readonly AssertionChange[], closed: readonly AssertionChange[]): void {
  const rows = h.assertions();
  for (const change of opened) {
    expect(rows).toContainEqual({
      source: change.source,
      kind: change.kind,
      id: change.id,
      content: change.content,
      validFrom: change.validFrom,
      validTo: change.validTo,
      recordedFrom: expect.any(Number),
      recordedTo: null,
    });
  }
  for (const change of closed) {
    const match = rows.find(
      (row) =>
        row.source === change.source &&
        row.kind === change.kind &&
        row.id === change.id &&
        row.content === change.content &&
        row.validFrom === change.validFrom &&
        row.recordedTo !== null,
    );
    expect(match).toBeDefined();
  }
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
});

describe('2. shared vocabulary: elements/interfaces/relations stay exclusive; categories/zones/environments/states are shared and never refused (the owner\'s rule, 2026-09-24)', () => {
  test('a second source declaring a zone id with a different definition is recorded, not refused: the union keeps both, and reports a discrepancy naming the id, the field and both sources', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'a', commit: 'c1', committedAt: DAY(1), model: model([], { zones: [zone('pci', 'compliance')] }) });

    const result = h.store({ source: 'b', commit: 'c1', committedAt: DAY(1), model: model([], { zones: [zone('pci', 'regulatory')] }) });
    expect(result.errors).toEqual([]);

    const read = h.read({ valid: DAY(2), known: DAY(2) });
    expect(read.errors).toEqual([]);
    expect(read.discrepancies).toEqual([{ kind: 'zone', id: 'pci', sources: ['a', 'b'], field: 'zone' }]);
    // `a` sorts first by code point, so its definition is primary; `b`'s is kept in `alsoDefinedAs`, not dropped.
    expect(read.model?.zones).toEqual([{ id: 'pci', kind: 'compliance', alsoDefinedAs: [{ source: 'b', definition: { id: 'pci', kind: 'regulatory' } }] }]);
  });

  test('a second source declaring the identical zone definition stores and reads back with no discrepancy at all', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'a', commit: 'c1', committedAt: DAY(1), model: model([], { zones: [zone('pci', 'compliance')] }) });
    const result = h.store({ source: 'b', commit: 'c1', committedAt: DAY(1), model: model([], { zones: [zone('pci', 'compliance')] }) });
    expect(result.errors).toEqual([]);

    const read = h.read({ valid: DAY(2), known: DAY(2) });
    expect(read.discrepancies).toEqual([]);
    expect(read.model?.zones).toEqual([{ id: 'pci', kind: 'compliance' }]);
  });

  test('two sources binding different variables of one environment: the union keeps each source\'s own bindings, per source, and reports no discrepancy since nothing actually conflicts', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'shop', commit: 's1', committedAt: DAY(1), model: model([element('checkout')], { environments: [environment('production', { PAYMENTS_URL: 'https://pay' })] }) });
    h.store({ source: 'orders', commit: 'o1', committedAt: DAY(1), model: model([element('orders')], { environments: [environment('production', { EVENTS_URL: 'kafka://x' })] }) });

    const read = h.read({ valid: DAY(2), known: DAY(2) });
    expect(read.discrepancies).toEqual([]);
    expect(read.model?.environments).toEqual([
      { id: 'production', bindingsBySource: { orders: { EVENTS_URL: 'kafka://x' }, shop: { PAYMENTS_URL: 'https://pay' } } },
    ]);
  });

  test('two sources binding the same variable of one environment to different values: both values are kept, per source, and reported as a discrepancy naming the variable', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'shop', commit: 's1', committedAt: DAY(1), model: model([], { environments: [environment('production', { TIMEOUT: '30' })] }) });

    const result = h.store({ source: 'orders', commit: 'o1', committedAt: DAY(1), model: model([], { environments: [environment('production', { TIMEOUT: '60' })] }) });
    expect(result.errors).toEqual([]);

    const read = h.read({ valid: DAY(2), known: DAY(2) });
    expect(read.discrepancies).toEqual([{ kind: 'environment', id: 'production', sources: ['orders', 'shop'], field: 'TIMEOUT' }]);
    expect(read.model?.environments).toEqual([{ id: 'production', bindingsBySource: { orders: { TIMEOUT: '60' }, shop: { TIMEOUT: '30' } } }]);
  });

  test('two sources binding the same variable to the same value: no discrepancy', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'shop', commit: 's1', committedAt: DAY(1), model: model([], { environments: [environment('production', { TIMEOUT: '30' })] }) });
    const result = h.store({ source: 'orders', commit: 'o1', committedAt: DAY(1), model: model([], { environments: [environment('production', { TIMEOUT: '30' })] }) });
    expect(result.errors).toEqual([]);

    const read = h.read({ valid: DAY(2), known: DAY(2) });
    expect(read.discrepancies).toEqual([]);
    expect(read.model?.environments).toEqual([{ id: 'production', bindingsBySource: { orders: { TIMEOUT: '30' }, shop: { TIMEOUT: '30' } } }]);
  });

  test('an environment declared with no bindings by one source and with bindings by the next: no discrepancy, and `bindingsBySource` names only the source that actually bound something', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'orders', commit: 'o1', committedAt: DAY(1), model: model([], { environments: [environment('production')] }) });
    const result = h.store({ source: 'shop', commit: 's1', committedAt: DAY(1), model: model([], { environments: [environment('production', { TIMEOUT: '30' })] }) });
    expect(result.errors).toEqual([]);

    const read = h.read({ valid: DAY(2), known: DAY(2) });
    expect(read.discrepancies).toEqual([]);
    expect(read.model?.environments).toEqual([{ id: 'production', bindingsBySource: { shop: { TIMEOUT: '30' } } }]);
  });

  test('two sources naming the same environment differently (besides bindings): recorded, not refused; the union keeps both definitions and reports a discrepancy', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'shop', commit: 's1', committedAt: DAY(1), model: model([], { environments: [{ id: 'production', name: 'Production' }] }) });

    const result = h.store({ source: 'orders', commit: 'o1', committedAt: DAY(1), model: model([], { environments: [{ id: 'production', name: 'Prod' }] }) });
    expect(result.errors).toEqual([]);

    const read = h.read({ valid: DAY(2), known: DAY(2) });
    expect(read.discrepancies).toEqual([{ kind: 'environment', id: 'production', sources: ['orders', 'shop'], field: 'environment' }]);
    expect(read.model?.environments).toEqual([{ id: 'production', name: 'Prod', alsoDefinedAs: [{ source: 'shop', definition: { id: 'production', name: 'Production' } }] }]);
  });

  test('an environment no source binds anything in comes back with no `bindingsBySource` field at all, not an empty object', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'shop', commit: 's1', committedAt: DAY(1), model: model([], { environments: [environment('production')] }) });
    h.store({ source: 'orders', commit: 'o1', committedAt: DAY(1), model: model([], { environments: [environment('production')] }) });
    const graph = readModel(h, { valid: DAY(2), known: DAY(2) });
    expect(graph.environments).toEqual([{ id: 'production' }]);
    expect('bindingsBySource' in graph.environments[0]!).toBe(false);
  });

  test('a source that declares `bindings: {}` explicitly (not merely omitted) is still left out of `bindingsBySource`, exactly like a source that declares no bindings at all', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'shop', commit: 's1', committedAt: DAY(1), model: model([], { environments: [{ id: 'production', bindings: {} }] }) });
    const graph = readModel(h, { valid: DAY(2), known: DAY(2) });
    expect(graph.environments).toEqual([{ id: 'production' }]);
    expect('bindingsBySource' in graph.environments[0]!).toBe(false);
  });

  test('a store that would make the union of every source\'s states branch succeeds — no longer refused — and the union read reports the one chain-wide discrepancy instead', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({
      source: 'a',
      commit: 'a1',
      committedAt: DAY(1),
      model: model([element('A', { states: ['as-is', 'to-be'] })], { states: [state('as-is'), state('to-be', 'as-is')] }),
    });

    const result = h.store({
      source: 'b',
      commit: 'b1',
      committedAt: DAY(1),
      model: model([element('B', { states: ['as-is', 'target'] })], { states: [state('as-is'), state('target', 'as-is')] }),
    });
    expect(result.errors).toEqual([]);

    const read = h.read({ valid: DAY(2), known: DAY(2) });
    expect(read.errors).toEqual([]);
    expect(read.discrepancies).toEqual([{ kind: 'state', id: '*', sources: ['a', 'b'], field: 'order' }]);
    expect(read.model?.states.map((s) => s.id).sort()).toEqual(['as-is', 'target', 'to-be']);
    // Both sources' own elements read back fine; nothing was refused.
    expect(readModel(h, { source: 'a', valid: DAY(2), known: DAY(2) }).elements.map((e) => e.id)).toEqual(['A']);
    expect(readModel(h, { source: 'b', valid: DAY(2), known: DAY(2) }).elements.map((e) => e.id)).toEqual(['B']);
  });

  test('a store extending the state chain compatibly (a longer, still-single chain) reports no chain discrepancy', () => {
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
    const read = h.read({ valid: DAY(2), known: DAY(2) });
    expect(read.discrepancies).toEqual([]);
    // Sorted by id, code point order, like every other assembled kind — not the chain order.
    expect(read.model?.states.map((s) => s.id).sort()).toEqual(['as-is', 'future', 'to-be']);
  });

  test('a source\'s own chain evolving over its own history (a different chain at different valid times) never fools the union read at one moment into seeing both at once', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    // `o`'s own chain changes over its own history: as-is>x until day 5, then as-is>y from day 5 on. The two never coexist.
    h.store({ source: 'o', commit: 'o1', committedAt: DAY(1), model: model([], { states: [state('as-is'), state('x', 'as-is')] }) });
    clock.set(DAY(6));
    h.store({ source: 'o', commit: 'o2', committedAt: DAY(5), model: model([], { states: [state('as-is'), state('y', 'as-is')] }) });

    // `s` only ever asserts `as-is`.
    const result = h.store({ source: 's', commit: 's1', committedAt: DAY(1), model: model([element('S')]) });
    expect(result.errors).toEqual([]);

    const early = h.read({ valid: DAY(2), known: DAY(7) });
    expect(early.discrepancies).toEqual([]);
    expect(early.model?.states.map((st) => st.id).sort()).toEqual(['as-is', 'x']);

    const later = h.read({ valid: DAY(7), known: DAY(7) });
    expect(later.discrepancies).toEqual([]);
    expect(later.model?.states.map((st) => st.id).sort()).toEqual(['as-is', 'y']);
  });

  test('two sources whose states really do branch at the very same moment: the union read at that moment reports the chain discrepancy', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'o', commit: 'o1', committedAt: DAY(1), model: model([], { states: [state('as-is'), state('x', 'as-is')] }) });

    // `s` asserts `y` after `as-is` too, throughout the very same span `o`'s `x` occupies: a real, simultaneous branch.
    const result = h.store({ source: 's', commit: 's1', committedAt: DAY(1), model: model([], { states: [state('as-is'), state('y', 'as-is')] }) });
    expect(result.errors).toEqual([]);

    const read = h.read({ valid: DAY(2), known: DAY(2) });
    expect(read.discrepancies).toEqual([{ kind: 'state', id: '*', sources: ['o', 's'], field: 'order' }]);
  });

  test('the chain discrepancy names its sources sorted code point order, regardless of which order they were stored in', () => {
    // Stored in reverse alphabetical order (`z` before `m`), so a
    // discrepancy that merely kept storage order would list them the wrong
    // way round.
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'z', commit: 'c1', committedAt: DAY(1), model: model([], { states: [state('as-is'), state('branch-z', 'as-is')] }) });
    const result = h.store({ source: 'm', commit: 'c1', committedAt: DAY(1), model: model([], { states: [state('as-is'), state('branch-m', 'as-is')] }) });
    expect(result.errors).toEqual([]);

    const read = h.read({ valid: DAY(2), known: DAY(2) });
    expect(read.discrepancies).toEqual([{ kind: 'state', id: '*', sources: ['m', 'z'], field: 'order' }]);
  });

  test('isOneStateChain: the pure chain check the union read uses, directly', () => {
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

  test('the union read keeps every source\'s zone definition instead of picking silently between them, even for data written outside store() (safety net for the assembler itself)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'madarch-stage2-'));
    const path = join(dir, 'history.sqlite');
    const clock = fakeClock(DAY(2));
    const h = history(clock, path);
    h.store({ source: 'a', commit: 'c1', committedAt: DAY(1), model: model([], { zones: [zone('pci', 'compliance')] }) });
    h.close();

    // Reaches around `store()`'s own (still-refusing) id-clash check the
    // same way the review's own scripts do, to exercise the assembler's own
    // merge logic directly: it must never drop a source's definition.
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
    expect(result.errors).toEqual([]);
    expect(result.discrepancies).toEqual([{ kind: 'zone', id: 'pci', sources: ['a', 'b'], field: 'zone' }]);
    expect(result.model?.zones).toEqual([{ id: 'pci', kind: 'compliance', alsoDefinedAs: [{ source: 'b', definition: { id: 'pci', kind: 'regulatory' } }] }]);
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
  test('ASSERTION_KINDS, CLASHABLE_KINDS and SHARED_KINDS name exactly the seven, three and four kinds the design describes', () => {
    expect(ASSERTION_KINDS).toEqual(['element', 'interface', 'relation', 'category', 'zone', 'environment', 'state']);
    expect(CLASHABLE_KINDS).toEqual(['element', 'interface', 'relation']);
    expect(SHARED_KINDS).toEqual(['category', 'zone', 'environment', 'state']);
  });

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

  test('a source-filtered read\'s `discrepancies` is always the empty array: a single source can never disagree with itself', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('a')], { zones: [zone('pci', 'compliance')] }) });
    const result = h.read({ source: 'shop', valid: DAY(2), known: DAY(2) });
    expect(result.errors).toEqual([]);
    expect(result.discrepancies).toEqual([]);
  });

  test('store() reports what it opened and closed', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    const first = h.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('a')]) });
    expect(first.closed).toEqual([]);
    expect(first.opened.filter((c) => c.kind === 'element')).toEqual([{ source: 'shop', kind: 'element', id: 'a', content: expect.any(String), validFrom: DAY(1), validTo: null, recordedFrom: expect.any(Number), recordedTo: null }]);

    clock.set(DAY(11));
    const second = h.store({ source: 'shop', commit: 'c2', committedAt: DAY(10), model: model([element('a', { technology: 'x' })]) });
    // `closed` reports the row exactly as it stood before this store: its
    // own valid end (still open, `null`), not the point this commit
    // truncates it to.
    expect(second.closed.filter((c) => c.kind === 'element')).toEqual([{ source: 'shop', kind: 'element', id: 'a', content: expect.any(String), validFrom: DAY(1), validTo: null, recordedFrom: expect.any(Number), recordedTo: expect.any(Number) }]);
    // `opened` carries every row this store wrote: the shortened
    // replacement (the old content, now ending at day 10) as well as the
    // brand-new one.
    expect(second.opened.filter((c) => c.kind === 'element')).toEqual([
      { source: 'shop', kind: 'element', id: 'a', content: expect.any(String), validFrom: DAY(1), validTo: DAY(10), recordedFrom: expect.any(Number), recordedTo: null },
      { source: 'shop', kind: 'element', id: 'a', content: expect.any(String), validFrom: DAY(10), validTo: null, recordedFrom: expect.any(Number), recordedTo: null },
    ]);
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

  test('a clock reading earlier than the last recorded time is clamped even for a store that only opens rows, closing nothing', () => {
    const clock = fakeClock(DAY(10));
    const h = history(clock);
    h.store({ source: 's', commit: 'c1', committedAt: DAY(1), model: model([element('X')]) });

    clock.set(DAY(5)); // the wall clock goes backwards; this store only adds Y, closing nothing
    h.store({ source: 's', commit: 'c2', committedAt: DAY(3), model: model([element('X'), element('Y')]) });

    // If Y had truly been recorded at day 5, a known time of day 7 would
    // already see it. Clamped up to c1's own recorded time (day 10), it
    // must not — a state with Y but not X never existed.
    expect(ids(h, { source: 's', valid: DAY(4), known: DAY(7) })).toBe('');
    expect(ids(h, { source: 's', valid: DAY(4), known: DAY(20) })).toBe('X,Y');
  });

  test('a clock reading exactly equal to the last recorded time is not pushed further forward: equal values are fine', () => {
    const clock = fakeClock(DAY(10));
    const h = history(clock);
    h.store({ source: 's', commit: 'c1', committedAt: DAY(1), model: model([element('X')]) });

    // The wall clock has not moved at all: still exactly c1's own recorded time.
    h.store({ source: 's', commit: 'c2', committedAt: DAY(3), model: model([element('X'), element('Y')]) });

    expect(ids(h, { source: 's', valid: DAY(4), known: DAY(10) })).toBe('X,Y');
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

  test('a clock reading that has not moved is still bumped forward when closing a row whose content changed, not merely one that disappeared', () => {
    const clock = fakeClock(DAY(5));
    const h = history(clock);
    h.store({ source: 's', commit: 'c1', committedAt: DAY(1), model: model([element('A', { technology: 'x' })]) });

    // The clock did not move: still exactly the moment `A` was recorded. Unlike the test above, `A` is not removed — it is replaced, same id, different content.
    h.store({ source: 's', commit: 'c2', committedAt: DAY(2), model: model([element('A', { technology: 'y' })]) });

    expect(ids(h, { source: 's', valid: DAY(3), known: DAY(5) })).toBe('A:x');
    expect(ids(h, { source: 's', valid: DAY(3), known: DAY(6) })).toBe('A:y');
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

  test('closing several rows recorded at different times still uses the true latest even when the alphabetically later id is the earlier-recorded one (iteration order is not sort order)', () => {
    // Unlike the paired test above, `A` (alphabetically, and so in
    // iteration order, first) is the one recorded LATER here, and `Z`
    // (iterated last) is recorded EARLIER: a check that took whichever row
    // it saw last, rather than the true maximum, would pick `Z`'s earlier
    // moment and under-clamp.
    const clock = fakeClock(DAY(5));
    const h = history(clock);
    h.store({ source: 's', commit: 'c1', committedAt: DAY(1), model: model([element('A'), element('Z')]) });
    clock.set(DAY(7));
    // `A` changes (recorded day 7); `Z` stays untouched, still recorded day 5.
    h.store({ source: 's', commit: 'c2', committedAt: DAY(2), model: model([element('A', { technology: 'v2' }), element('Z')]) });

    // The clock has not moved past day 7 (A's own recorded time): closing
    // BOTH A and Z at once must bump past the later of the two (A's day 7),
    // not merely past Z's day 5.
    clock.set(DAY(7));
    const result = h.store({ source: 's', commit: 'c3', committedAt: DAY(3), model: model([]) });
    expect(result.errors).toEqual([]);

    // Right at day 7 (A's own prior recorded moment, before c3's own),
    // c3's removal must not be visible yet: both must still show.
    expect(ids(h, { source: 's', valid: DAY(4), known: DAY(7) })).toBe('A:v2,Z');
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

  test('a third source conflicting with a shared zone id two other sources already agree on succeeds; the read names all three sources in one discrepancy', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'a', commit: 'c1', committedAt: DAY(1), model: model([], { zones: [zone('pci', 'compliance')] }) });
    h.store({ source: 'b', commit: 'c1', committedAt: DAY(1), model: model([], { zones: [zone('pci', 'compliance')] }) });

    const result = h.store({ source: 'c', commit: 'c1', committedAt: DAY(1), model: model([], { zones: [zone('pci', 'regulatory')] }) });
    expect(result.errors).toEqual([]);

    const read = h.read({ valid: DAY(2), known: DAY(2) });
    expect(read.discrepancies).toEqual([{ kind: 'zone', id: 'pci', sources: ['a', 'b', 'c'], field: 'zone' }]);
    expect(read.model?.zones).toEqual([{ id: 'pci', kind: 'compliance', alsoDefinedAs: [{ source: 'c', definition: { id: 'pci', kind: 'regulatory' } }] }]);
  });

  test('two sources sharing one definition, with a third (alphabetically between them) source declaring a different one: the shared definition still wins as primary — every agreeing source counts toward the tie-break, not just whichever was seen last', () => {
    // `x` and `z` agree ("compliance"); `y`, sorting alphabetically between
    // them, disagrees ("regulatory"). Picking the primary by the first
    // agreeing source (`x`) must still beat `y`: an implementation that
    // only remembered the *last* source to agree (`z`) would wrongly let
    // `y` win the tie-break instead, since 'y' < 'z'.
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'x', commit: 'c1', committedAt: DAY(1), model: model([], { zones: [zone('shared', 'compliance')] }) });
    h.store({ source: 'y', commit: 'c1', committedAt: DAY(1), model: model([], { zones: [zone('shared', 'regulatory')] }) });
    h.store({ source: 'z', commit: 'c1', committedAt: DAY(1), model: model([], { zones: [zone('shared', 'compliance')] }) });

    const read = h.read({ valid: DAY(2), known: DAY(2) });
    expect(read.discrepancies).toEqual([{ kind: 'zone', id: 'shared', sources: ['x', 'y', 'z'], field: 'zone' }]);
    expect(read.model?.zones).toEqual([{ id: 'shared', kind: 'compliance', alsoDefinedAs: [{ source: 'y', definition: { id: 'shared', kind: 'regulatory' } }] }]);
  });

  test('each content group\'s own sources are sorted before the tie-break compares them, not left in storage order', () => {
    // `z` and `x` agree ("compliance"), stored in that order (`z` first);
    // `y` (alphabetically between them) disagrees ("regulatory"). Sorting
    // `z`/`x`'s own group down to `x` first is what lets "compliance" (x
    // sorts before y) win the tie-break; left in storage order ("z" first),
    // "regulatory" (y sorts before z) would wrongly win instead.
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'z', commit: 'c1', committedAt: DAY(1), model: model([], { zones: [zone('shared2', 'compliance')] }) });
    h.store({ source: 'y', commit: 'c1', committedAt: DAY(1), model: model([], { zones: [zone('shared2', 'regulatory')] }) });
    h.store({ source: 'x', commit: 'c1', committedAt: DAY(1), model: model([], { zones: [zone('shared2', 'compliance')] }) });

    const read = h.read({ valid: DAY(2), known: DAY(2) });
    expect(read.model?.zones).toEqual([{ id: 'shared2', kind: 'compliance', alsoDefinedAs: [{ source: 'y', definition: { id: 'shared2', kind: 'regulatory' } }] }]);
  });

  test('a category id two sources declare differently is recorded, not refused: the union keeps both and reports a discrepancy with field "category"', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'a', commit: 'c1', committedAt: DAY(1), model: model([], { categories: [{ id: 'pii', name: 'Personal data' }] }) });
    const result = h.store({ source: 'b', commit: 'c1', committedAt: DAY(1), model: model([], { categories: [{ id: 'pii', name: 'PII' }] }) });
    expect(result.errors).toEqual([]);

    const read = h.read({ valid: DAY(2), known: DAY(2) });
    expect(read.discrepancies).toEqual([{ kind: 'category', id: 'pii', sources: ['a', 'b'], field: 'category' }]);
    expect(read.model?.categories).toEqual([{ id: 'pii', name: 'Personal data', alsoDefinedAs: [{ source: 'b', definition: { id: 'pii', name: 'PII' } }] }]);
  });

  test('a state id two sources declare differently (its own definition, not the chain order) is recorded, not refused: the union keeps both and reports a discrepancy with field "state"', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'a', commit: 'c1', committedAt: DAY(1), model: model([], { states: [state('as-is'), { id: 'to-be', name: 'Target', after: 'as-is' }] }) });
    const result = h.store({ source: 'b', commit: 'c1', committedAt: DAY(1), model: model([], { states: [state('as-is'), { id: 'to-be', name: 'Future', after: 'as-is' }] }) });
    expect(result.errors).toEqual([]);

    const read = h.read({ valid: DAY(2), known: DAY(2) });
    expect(read.discrepancies).toEqual([{ kind: 'state', id: 'to-be', sources: ['a', 'b'], field: 'state' }]);
    expect((read.model as ReadModel | undefined)?.states.find((s) => s.id === 'to-be')).toEqual({
      id: 'to-be',
      name: 'Target',
      after: 'as-is',
      alsoDefinedAs: [{ source: 'b', definition: { id: 'to-be', name: 'Future', after: 'as-is' } }],
    });
  });

  test('every source currently declaring a shared binding is checked, not only whichever one is seen last: a conflict with the first of two agreeing sources is still caught', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    // `x` and `y` bind different, non-overlapping variables of `production` — no conflict between them.
    h.store({ source: 'x', commit: 'c1', committedAt: DAY(1), model: model([], { environments: [environment('production', { X: '1' })] }) });
    h.store({ source: 'y', commit: 'c1', committedAt: DAY(1), model: model([], { environments: [environment('production', { Y: '2' })] }) });

    // `z` conflicts with `x` specifically (on `X`), not with `y` at all:
    // if only the last-seen other source were scanned, this conflict could
    // be missed.
    const result = h.store({ source: 'z', commit: 'c1', committedAt: DAY(1), model: model([], { environments: [environment('production', { X: '99' })] }) });
    expect(result.errors).toEqual([]);

    const read = h.read({ valid: DAY(2), known: DAY(2) });
    expect(read.discrepancies).toEqual([{ kind: 'environment', id: 'production', sources: ['x', 'z'], field: 'X' }]);
    expect(read.model?.environments).toEqual([{ id: 'production', bindingsBySource: { x: { X: '1' }, y: { Y: '2' }, z: { X: '99' } } }]);
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
    // Two rows open for this late store: the shortened X:A, now ending at
    // day 5, and X:C from day 5 to day 10. No redundant copy of X:A is
    // reopened past day 10 — c2's own X:B row already covers that,
    // undisturbed.
    expect(result.opened.filter((c) => c.kind === 'element')).toEqual([
      { source: 's', kind: 'element', id: 'X', content: expect.any(String), validFrom: DAY(1), validTo: DAY(5), recordedFrom: expect.any(Number), recordedTo: null },
      { source: 's', kind: 'element', id: 'X', content: expect.any(String), validFrom: DAY(5), validTo: DAY(10), recordedFrom: expect.any(Number), recordedTo: null },
    ]);

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
      { source: 's', kind: 'element', id: 'X', content: expect.any(String), validFrom: DAY(1), validTo: DAY(5), recordedFrom: expect.any(Number), recordedTo: null },
      { source: 's', kind: 'element', id: 'X', content: expect.any(String), validFrom: DAY(5), validTo: DAY(10), recordedFrom: expect.any(Number), recordedTo: null },
      { source: 's', kind: 'element', id: 'X', content: expect.any(String), validFrom: DAY(10), validTo: DAY(20), recordedFrom: expect.any(Number), recordedTo: null },
    ]);
    expect(elementChanges[0]?.content).toContain('"technology":"A"');
    expect(elementChanges[2]?.content).toContain('"technology":"A"');

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
      { source: 's', kind: 'element', id: 'X', content: expect.any(String), validFrom: DAY(1), validTo: DAY(5), recordedFrom: expect.any(Number), recordedTo: null },
      { source: 's', kind: 'element', id: 'X', content: expect.any(String), validFrom: DAY(5), validTo: DAY(10), recordedFrom: expect.any(Number), recordedTo: null },
    ]);

    const raw = new Database(path);
    const empty = raw.query('SELECT * FROM assertions WHERE valid_from = valid_to').all();
    raw.close();
    expect(empty).toEqual([]);
  });

  test('the union read keeps both sources\' disagreeing environment definitions instead of picking silently between them (safety net for the assembler itself)', () => {
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
    expect(result.errors).toEqual([]);
    expect(result.discrepancies).toEqual([{ kind: 'environment', id: 'production', sources: ['a', 'b'], field: 'environment' }]);
    expect(result.model?.environments).toEqual([
      { id: 'production', bindingsBySource: { a: { X: '1' } }, alsoDefinedAs: [{ source: 'b', definition: { id: 'production', name: 'a different name' } }] },
    ]);
  });

  test('the union read keeps both sources\' conflicting bindings for the same variable instead of picking silently between them (safety net, agreeing on everything else)', () => {
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
    expect(result.errors).toEqual([]);
    expect(result.discrepancies).toEqual([{ kind: 'environment', id: 'production', sources: ['a', 'b'], field: 'TIMEOUT' }]);
    expect(result.model?.environments).toEqual([{ id: 'production', bindingsBySource: { a: { TIMEOUT: '30' }, b: { TIMEOUT: '60' } } }]);
  });

  test('the union read does not report a discrepancy when two sources bind the same variable to the same value (stays silent when there is truly nothing to disagree about)', () => {
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
      [JSON.stringify({ id: 'production', bindings: { TIMEOUT: '30' } }), DAY(1), clock.now()],
    );
    raw.close();

    const h2 = history(clock, path);
    const result = h2.read({ valid: DAY(2), known: DAY(2) });
    expect(result.errors).toEqual([]);
    expect(result.discrepancies).toEqual([]);
    expect(result.model?.environments).toEqual([{ id: 'production', bindingsBySource: { a: { TIMEOUT: '30' }, b: { TIMEOUT: '30' } } }]);
  });

  test('sources() sorts by code point regardless of storage or arrival order', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'zebra', commit: 'c1', committedAt: DAY(1), model: model([]) });
    h.store({ source: 'apple', commit: 'c1', committedAt: DAY(1), model: model([]) });
    expect(h.sources()).toEqual(['apple', 'zebra']);
  });

  test('`bindingsBySource`\'s own source keys, and each source\'s own variable keys, come back sorted code point order, regardless of which order sources bound them', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'z', commit: 'c1', committedAt: DAY(1), model: model([], { environments: [environment('production', { zzz: '1', bbb: '9' })] }) });
    h.store({ source: 'a', commit: 'c1', committedAt: DAY(1), model: model([], { environments: [environment('production', { aaa: '2' })] }) });

    const graph = readModel(h, { valid: DAY(2), known: DAY(2) });
    const bindingsBySource = graph.environments[0]!.bindingsBySource!;
    expect(Object.keys(bindingsBySource)).toEqual(['a', 'z']);
    expect(Object.keys(bindingsBySource['z']!)).toEqual(['bbb', 'zzz']);
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
    expect(unrecordable.errors).toEqual([{ message: expect.stringContaining('could not be recorded') }]);
  });
});

describe('9. store()\'s reported opened/closed carry their source and always match assertions() afterward', () => {
  test('a single store: every opened row is current, carries its source', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    const result = h.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('a'), element('b')]) });
    expect(result.closed).toEqual([]);
    expect(result.opened.every((c) => c.source === 'shop')).toBe(true);
    verifyReport(h, result.opened, result.closed);
  });

  test('a replace: the closed row and the opened row both carry their source, and both match assertions()', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('a')]) });
    clock.set(DAY(11));
    const result = h.store({ source: 'shop', commit: 'c2', committedAt: DAY(10), model: model([element('a', { technology: 'x' })]) });
    expect(result.closed.every((c) => c.source === 'shop')).toBe(true);
    expect(result.opened.every((c) => c.source === 'shop')).toBe(true);
    verifyReport(h, result.opened, result.closed);
  });

  test('a late commit: the restored, split rows it opens all match assertions(), each carrying its source', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 's', commit: 'c0', committedAt: DAY(1), model: model([element('X', { technology: 'A' })]) });
    clock.set(DAY(11));
    h.store({ source: 's', commit: 'c2', committedAt: DAY(10), model: model([element('X', { technology: 'A' }), element('Y')]) });
    clock.set(DAY(21));
    h.store({ source: 's', commit: 'c4', committedAt: DAY(20), model: model([element('X', { technology: 'D' }), element('Y')]) });

    clock.set(DAY(30));
    const result = h.store({ source: 's', commit: 'c1', committedAt: DAY(5), model: model([element('X', { technology: 'C' }), element('Y')]) });
    expect(result.errors).toEqual([]);
    expect(result.closed.every((c) => c.source === 's')).toBe(true);
    expect(result.opened.every((c) => c.source === 's')).toBe(true);
    verifyReport(h, result.opened, result.closed);
  });

  test('same-time commits: the superseded row is closed with no shortened replacement (both start at the same instant), and matches assertions()', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 's', commit: 'a', committedAt: DAY(1), model: model([element('X', { technology: 'A' })]) });
    clock.set(DAY(3));
    const result = h.store({ source: 's', commit: 'b', committedAt: DAY(1), model: model([element('X', { technology: 'B' })]) });

    // `closed` reports the row exactly as it stood before closing: it was
    // still open (`validTo: null`) — `b` shares `a`'s own `committedAt`
    // (day 1), so there is no elapsed valid span left to report a shortened
    // replacement for; only the brand-new row opens.
    const closedX = result.closed.find((c) => c.kind === 'element' && c.id === 'X');
    expect(closedX).toMatchObject({ source: 's', validFrom: DAY(1), validTo: null });
    expect(result.opened.filter((c) => c.kind === 'element' && c.id === 'X')).toEqual([
      { source: 's', kind: 'element', id: 'X', content: expect.any(String), validFrom: DAY(1), validTo: null, recordedFrom: expect.any(Number), recordedTo: null },
    ]);
    verifyReport(h, result.opened, result.closed);

    // No row was ever persisted for a zero-width valid span.
    expect(h.assertions().some((r) => r.validTo !== null && r.validTo === r.validFrom)).toBe(false);
  });
});

describe('10. a seeded random sequence of stores matches an independently computed model (kept cheap: one fixed seed, not the review\'s full fuzz run)', () => {
  test('regardless of arrival order, the final read at every checked valid time matches "the latest commit at or before that time"; no empty or overlapping current rows for one id', () => {
    let seed = 1;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const ri = (n: number) => Math.floor(rnd() * n);

    for (let trial = 0; trial < 40; trial++) {
      const n = 1 + ri(6);
      const commits = Array.from({ length: n }, (_, i) => {
        const els: CompiledElement[] = [];
        for (const id of ['A', 'B', 'C']) {
          if (rnd() < 0.6) els.push(element(id, rnd() < 0.5 ? {} : { technology: `t${ri(2)}` }));
        }
        return { id: `c${ri(100)}_${i}`, t: 1000 * (1 + ri(5)), els };
      });

      const clock = fakeClock(100000);
      const h = history(clock);
      const stored: { id: string; t: number; els: CompiledElement[] }[] = [];
      for (const cm of commits) {
        clock.set(100000 + stored.length * 10 + (rnd() < 0.2 ? -50 : 0)); // sometimes jumps back
        const result = h.store({ source: 's', commit: cm.id, committedAt: cm.t, model: model(cm.els) });
        expect(result.errors).toEqual([]);
        stored.push(cm);
      }

      // The independent oracle: sort the commits actually stored so far by
      // (time, id), and take the last one at or before `v` — exactly what
      // "ordered by commit time, not arrival" (the `order-by-commit`
      // requirement) means the history should settle on.
      const oracle = (v: number): string => {
        const candidates = stored.filter((x) => x.t <= v).sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        if (candidates.length === 0) return '';
        return candidates[candidates.length - 1]!.els
          .map((e) => e.id + (e.technology ? `:${e.technology}` : ''))
          .sort()
          .join(',');
      };

      for (let v = 500; v <= 6500; v += 500) {
        expect(ids(h, { valid: v, known: 1e9 })).toBe(oracle(v));
      }

      const current = h.assertions().filter((r) => r.recordedTo === null);
      for (const row of current) {
        expect(row.validTo === null || row.validTo > row.validFrom).toBe(true);
      }
      for (const a of current) {
        for (const b of current) {
          if (a === b || a.id !== b.id || a.kind !== b.kind) continue;
          const overlap = a.validFrom < (b.validTo ?? Infinity) && b.validFrom < (a.validTo ?? Infinity);
          expect(overlap).toBe(false);
        }
      }
    }
  });
});

describe('11. the review\'s own scenarios (t8, t9): both stores succeed; the union shows each source\'s value and a discrepancy; each relation still carries its own source\'s address', () => {
  test('t8(a): both sources evolve a shared zone\'s kind on different days — both stores succeed, and the union carries a discrepancy that tracks the latest agreed content', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'a', commit: 'a1', committedAt: DAY(1), model: model([element('A')], { zones: [zone('pci', 'regulatory')] }) });
    h.store({ source: 'b', commit: 'b1', committedAt: DAY(1), model: model([element('B')], { zones: [zone('pci', 'regulatory')] }) });

    // Both start out agreeing, so no discrepancy yet.
    expect(h.read({ valid: DAY(2), known: DAY(2) }).discrepancies).toEqual([]);

    clock.set(DAY(13));
    const ra = h.store({ source: 'a', commit: 'a2', committedAt: DAY(10), model: model([element('A')], { zones: [zone('pci', 'compliance')] }) });
    const rb = h.store({ source: 'b', commit: 'b2', committedAt: DAY(12), model: model([element('B')], { zones: [zone('pci', 'compliance')] }) });
    expect(ra.errors).toEqual([]);
    expect(rb.errors).toEqual([]);

    // `a` moved first (day 10): from day 10 to day 12, the sources disagree.
    const between = h.read({ valid: DAY(11), known: DAY(13) });
    expect(between.discrepancies).toEqual([{ kind: 'zone', id: 'pci', sources: ['a', 'b'], field: 'zone' }]);

    // Once `b` catches up (day 12 on), both agree again: no discrepancy.
    const after = h.read({ valid: DAY(13), known: DAY(13) });
    expect(after.discrepancies).toEqual([]);
    expect(after.model?.zones).toEqual([{ id: 'pci', kind: 'compliance' }]);

    // Repeating `a`'s own already-stored commit stays the idempotent no-op it always was.
    const retry = h.store({ source: 'a', commit: 'a2', committedAt: DAY(10), model: model([element('A')], { zones: [zone('pci', 'compliance')] }) });
    expect(retry.errors).toEqual([]);
    expect(retry.opened).toEqual([]);
  });

  test('t9: two sources moving the same environment binding to a new value on different days — both stores succeed; the union keeps each source\'s own value, and each relation still carries its own source\'s address', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    const withPayments = (id: string, url: string): CompiledModel =>
      model([element(id), element(`${id}-gateway`)], {
        relations: [{ id: `${id}-to-gateway`, from: id, to: `${id}-gateway`, interaction: true, environments: ['production'], states: ['as-is'], binding: { env: 'PAYMENTS_URL' }, bindingByEnvironment: { production: url } }],
        environments: [environment('production', { PAYMENTS_URL: url })],
      });

    h.store({ source: 'shop', commit: 's1', committedAt: DAY(1), model: withPayments('shop', 'https://old') });
    h.store({ source: 'orders', commit: 'o1', committedAt: DAY(1), model: withPayments('orders', 'https://old') });
    expect(h.read({ valid: DAY(2), known: DAY(2) }).discrepancies).toEqual([]);

    clock.set(DAY(20));
    const rShop = h.store({ source: 'shop', commit: 's2', committedAt: DAY(10), model: withPayments('shop', 'https://new') });
    const rOrders = h.store({ source: 'orders', commit: 'o2', committedAt: DAY(11), model: withPayments('orders', 'https://new') });
    expect(rShop.errors).toEqual([]);
    expect(rOrders.errors).toEqual([]);

    // Between day 10 and day 11, `shop` has already moved but `orders` has not: the union keeps both, tagged by source, and reports the disagreement.
    const between = h.read({ valid: DAY(10), known: DAY(20) });
    expect(between.discrepancies).toEqual([{ kind: 'environment', id: 'production', sources: ['orders', 'shop'], field: 'PAYMENTS_URL' }]);
    expect(between.model?.environments).toEqual([{ id: 'production', bindingsBySource: { orders: { PAYMENTS_URL: 'https://old' }, shop: { PAYMENTS_URL: 'https://new' } } }]);
    // Each source's own relation still carries its own source's address, untouched by the other source's disagreement.
    expect(readModel(h, { source: 'shop', valid: DAY(10), known: DAY(20) }).relations[0]?.bindingByEnvironment).toEqual({ production: 'https://new' });
    expect(readModel(h, { source: 'orders', valid: DAY(10), known: DAY(20) }).relations[0]?.bindingByEnvironment).toEqual({ production: 'https://old' });

    // Once `orders` also moves (day 11 on), both agree again: no discrepancy, one shared value.
    const after = h.read({ valid: DAY(11), known: DAY(20) });
    expect(after.discrepancies).toEqual([]);
    expect(after.model?.environments).toEqual([{ id: 'production', bindingsBySource: { orders: { PAYMENTS_URL: 'https://new' }, shop: { PAYMENTS_URL: 'https://new' } } }]);
  });
});

describe('12. known-time correctness: a read at an earlier known time reproduces exactly what history held right then (madarch-ozp.8)', () => {
  test('a store whose clock, once corrected up to the recorded-time floor, would otherwise land exactly on an unrelated earlier store\'s own moment is bumped strictly past it, not tied to it', () => {
    // The smallest sequence the review's fuzz2.ts (seed 1, trial 9) found
    // still failing at fd94e36: a third store's clock, after going
    // backwards, gets floored up to *exactly* a second store's own
    // (unrelated) recorded moment — because landing exactly on the floor
    // was, at that commit, treated as fine. A `read` at the known time
    // right after the second store then wrongly already saw the third
    // store's effects too, even though nothing yet connected the two.
    const clock = fakeClock(100000);
    const h = history(clock);

    h.store({ source: 's', commit: 'c46_0', committedAt: 4000, model: model([element('A', { technology: 't0' }), element('B'), element('C', { technology: 't1' })]) });
    clock.set(100010);
    h.store({ source: 's', commit: 'c11_1', committedAt: 3000, model: model([element('A', { technology: 't1' }), element('B')]) });
    clock.set(100020);
    h.store({ source: 's', commit: 'c51_2', committedAt: 3000, model: model([element('A')]) });

    // The known moment right after the third store above: nothing later has happened yet.
    const knownAfterThirdStore = Math.max(...h.assertions().map((a) => a.recordedFrom), ...h.assertions().map((a) => a.recordedTo ?? 0));

    // The wall clock goes backwards for the fourth store, well behind the
    // recorded-time floor (100020): it must not tie with it.
    clock.set(99980);
    const result = h.store({ source: 's', commit: 'c97_3', committedAt: 2000, model: model([element('B')]) });
    expect(result.errors).toEqual([]);

    // At v = 2500, nothing was known yet as of `knownAfterThirdStore`: `B`'s
    // early row (valid 2000–3000) is the fourth store's own doing, recorded
    // strictly after it.
    expect(ids(h, { valid: 2500, known: knownAfterThirdStore })).toBe('');
    // Once known time reaches the fourth store's own (later) recorded moment, it appears.
    expect(ids(h, { valid: 2500, known: 1e9 })).toBe('B');
  });

  test('a clock reading that genuinely, not just after correction, equals the recorded-time floor still ties with it (the accepted case stays accepted)', () => {
    const clock = fakeClock(DAY(10));
    const h = history(clock);
    h.store({ source: 's', commit: 'c1', committedAt: DAY(1), model: model([element('X')]) });
    // The wall clock has genuinely not moved: still exactly DAY(10), the same reading `c1` itself used — not a correction up from behind it.
    const result = h.store({ source: 's', commit: 'c2', committedAt: DAY(2), model: model([element('X'), element('Y')]) });
    expect(result.errors).toEqual([]);
    expect(ids(h, { valid: DAY(3), known: DAY(10) })).toBe('X,Y');
  });

  test('a seeded sequence of stores, some with a clock that jumps backwards: a read at the known time right after each store matches a read taken at that point in the sequence, for every valid time checked (the review\'s own property, one fixed seed)', () => {
    let seed = 1;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const ri = (n: number) => Math.floor(rnd() * n);
    const validPoints = [500, 1500, 2500, 3500, 4500, 5500];

    for (let trial = 0; trial < 200; trial++) {
      const n = 1 + ri(6);
      const commits = Array.from({ length: n }, (_, i) => {
        const els: CompiledElement[] = [];
        for (const id of ['A', 'B', 'C']) {
          if (rnd() < 0.6) els.push(element(id, rnd() < 0.5 ? {} : { technology: `t${ri(2)}` }));
        }
        return { id: `c${ri(100)}_${i}`, t: 1000 * (1 + ri(5)), els };
      });

      const clock = fakeClock(100000);
      const h = history(clock);
      const knownAt: number[] = [];
      const snapshots: string[] = [];
      for (const cm of commits) {
        clock.set(100000 + knownAt.length * 10 + (rnd() < 0.2 ? -50 : 0));
        const result = h.store({ source: 's', commit: cm.id, committedAt: cm.t, model: model(cm.els) });
        expect(result.errors).toEqual([]);
        const rows = h.assertions();
        knownAt.push(Math.max(...rows.map((a) => a.recordedFrom), ...rows.map((a) => a.recordedTo ?? 0)));
        snapshots.push(validPoints.map((v) => ids(h, { valid: v, known: 1e9 })).join('|'));
      }

      // Every store's own known-time boundary, read back from the FINAL
      // history (every commit stored, including later ones), must
      // reproduce exactly the snapshot taken right after that store — no
      // later store's effects leaking in through a tied recorded moment.
      for (let i = 0; i < commits.length; i++) {
        const replay = validPoints.map((v) => ids(h, { valid: v, known: knownAt[i]! })).join('|');
        expect(replay).toBe(snapshots[i]!);
      }
    }
  });
});

describe('13. the exclusive-kind safety net names the right kind for every one of the seven kinds (data written outside store())', () => {
  function insertRaw(path: string, rows: { source: string; kind: string; id: string; content: unknown }[]): void {
    // Creates the schema (a fresh store, immediately closed) before writing raw rows into it.
    createSqliteHistory({ clock: fakeClock(0), path }).close();
    const raw = new Database(path);
    const insert = raw.query(
      `INSERT INTO assertions (source, kind, entity_id, content, valid_from, valid_to, opened_by, closed_by, recorded_from, recorded_to)
       VALUES (?, ?, ?, ?, ?, NULL, 'c1', NULL, ?, NULL)`,
    );
    for (const row of rows) insert.run(row.source, row.kind, row.id, JSON.stringify(row.content), DAY(1), DAY(1));
    raw.close();
  }

  for (const kind of ASSERTION_KINDS) {
    test(`the union read's exclusive-kind safety net reports "${kind}" as the field when two sources' rows for the same id disagree`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'madarch-stage2-'));
      const path = join(dir, 'history.sqlite');
      insertRaw(path, [
        { source: 'a', kind, id: 'x', content: { id: 'x', v: 'A' } },
        { source: 'b', kind, id: 'x', content: { id: 'x', v: 'B' } },
      ]);

      const clock = fakeClock(DAY(2));
      const h = history(clock, path);
      const result = h.read({ valid: DAY(2), known: DAY(2) });
      if (CLASHABLE_KINDS.includes(kind)) {
        // element/interface/relation: a real safety-net finding, reported as an error.
        expect(result.model).toBeUndefined();
        expect(result.errors).toEqual([{ message: expect.any(String), id: 'x', field: kind, source: expect.any(String) }]);
      } else {
        // category/zone/environment/state: kept, not refused — a Discrepancy, not an error.
        expect(result.errors).toEqual([]);
      }
    });
  }

  for (const kind of ASSERTION_KINDS) {
    test(`a source-filtered read's own exclusive-kind safety net reports "${kind}" as the field when one source's own two rows for the same id disagree (never happens through store(), which always closes the old row first)`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'madarch-stage2-'));
      const path = join(dir, 'history.sqlite');
      insertRaw(path, [
        { source: 's', kind, id: 'x', content: { id: 'x', v: 'A' } },
        { source: 's', kind, id: 'x', content: { id: 'x', v: 'B' } },
      ]);

      const clock = fakeClock(DAY(2));
      const h = history(clock, path);
      const result = h.read({ source: 's', valid: DAY(2), known: DAY(2) });
      expect(result.model).toBeUndefined();
      expect(result.errors).toEqual([{ message: expect.any(String), id: 'x', field: kind, source: expect.any(String) }]);
    });
  }
});
