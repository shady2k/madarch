import { describe, expect, test } from 'bun:test';
import {
  createSqliteHistory,
  type Clock,
  type CompiledElement,
  type CompiledInterface,
  type CompiledModel,
  type CompiledRelation,
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

function history(clock: Clock): HistoryStore {
  return createSqliteHistory({ clock });
}

function readModel(h: HistoryStore, input?: Parameters<HistoryStore['read']>[0]): ReadModel {
  const result = h.read(input);
  expect(result.errors).toEqual([]);
  return result.model!;
}

const DAY = (day: number) => Date.UTC(2026, 8, day); // September 2026

function element(id: string, extra: Partial<CompiledElement> = {}): CompiledElement {
  return { id, kind: 'service', ancestors: [], zones: [], zonesByEnvironment: {}, environments: ['*'], states: ['as-is'], ...extra };
}

function relation(id: string, from: string, to: string): CompiledRelation {
  return { id, from, to, interaction: false, environments: ['*'], states: ['as-is'] };
}

function iface(id: string): CompiledInterface {
  return { id, provider: 'p', contract: `http::GET::/${id}` };
}

function zone(id: string, kind: string): CompiledZone {
  return { id, kind };
}

function model(elements: CompiledElement[], relations: CompiledRelation[] = []): CompiledModel {
  return {
    schemaVersion: 1,
    elements,
    interfaces: [],
    relations,
    categories: [],
    zones: [],
    environments: [],
    states: [{ id: 'as-is' }],
  };
}

describe('sources: a graph is the union of its sources', () => {
  test('two-sources: reading with no source returns the union, and a cross-source relation joins them', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({
      source: 'shop',
      commit: 'c1',
      committedAt: DAY(1),
      model: model([element('checkout-web')], [relation('checkout-charges-card', 'checkout-web', 'payments-api')]),
    });
    h.store({ source: 'payments', commit: 'p1', committedAt: DAY(1), model: model([element('payments-api')]) });

    const graph = readModel(h, { valid: DAY(2), known: DAY(2) });
    expect(graph.elements.map((e) => e.id).sort()).toEqual(['checkout-web', 'payments-api']);
    expect(graph.relations.map((r) => r.id)).toEqual(['checkout-charges-card']);
    expect(graph.relations[0]).toMatchObject({ from: 'checkout-web', to: 'payments-api' });
  });

  test('id-clash: storing a source that declares an id another source already declares is refused, naming both', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'payments', commit: 'p1', committedAt: DAY(1), model: model([element('payments-api')]) });

    const before = readModel(h, { valid: DAY(2), known: DAY(2) });

    const result = h.store({ source: 'shop', commit: 's1', committedAt: DAY(1), model: model([element('payments-api')]) });

    expect(result.errors).toEqual([{ message: expect.any(String), id: 'payments-api', source: 'payments' }]);
    // The history is unchanged: shop's store did not go through at all.
    const after = readModel(h, { valid: DAY(2), known: DAY(2) });
    expect(after).toEqual(before);
    expect(readModel(h, { source: 'shop', valid: DAY(2), known: DAY(2) }).elements).toEqual([]);
  });

  test('two sources declaring different ids both store successfully (the paired normal case)', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'payments', commit: 'p1', committedAt: DAY(1), model: model([element('payments-api')]) });
    const result = h.store({ source: 'shop', commit: 's1', committedAt: DAY(1), model: model([element('checkout-web')]) });
    expect(result.errors).toEqual([]);
  });

  test('two sources may share vocabulary ids (a default state id) without clashing', () => {
    // Both sources here declare no states of their own, so both compile the
    // same default state id `as-is` (see `compileStates`). That is not a
    // claim of ownership the way an element id is: refusing it would make
    // the ordinary case of two unrelated sources fail to combine.
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'payments', commit: 'p1', committedAt: DAY(1), model: model([element('payments-api')]) });
    const result = h.store({ source: 'shop', commit: 's1', committedAt: DAY(1), model: model([element('checkout-web')]) });
    expect(result.errors).toEqual([]);

    const graph = readModel(h, { valid: DAY(2), known: DAY(2) });
    expect(graph.states.map((s) => s.id)).toEqual(['as-is']);
  });

  test('an interface id clash is refused too, naming it and the other source', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({
      source: 'payments',
      commit: 'p1',
      committedAt: DAY(1),
      model: { ...model([]), interfaces: [iface('payments-charge')] },
    });

    const result = h.store({
      source: 'shop',
      commit: 's1',
      committedAt: DAY(1),
      model: { ...model([]), interfaces: [iface('payments-charge')] },
    });
    expect(result.errors).toEqual([{ message: expect.any(String), id: 'payments-charge', source: 'payments' }]);
  });

  test('an interface id declared by only one source stores without a clash (the paired normal case)', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'payments', commit: 'p1', committedAt: DAY(1), model: { ...model([]), interfaces: [iface('payments-charge')] } });
    const result = h.store({ source: 'shop', commit: 's1', committedAt: DAY(1), model: { ...model([]), interfaces: [iface('checkout-charge')] } });
    expect(result.errors).toEqual([]);
  });

  test('a relation id clash is refused too, naming it and the other source', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({
      source: 'payments',
      commit: 'p1',
      committedAt: DAY(1),
      model: model([element('a'), element('b')], [relation('shared-id', 'a', 'b')]),
    });

    const result = h.store({
      source: 'shop',
      commit: 's1',
      committedAt: DAY(1),
      model: model([element('c'), element('d')], [relation('shared-id', 'c', 'd')]),
    });
    expect(result.errors).toEqual([{ message: expect.any(String), id: 'shared-id', source: 'payments' }]);
  });

  test('a relation id declared by only one source stores without a clash (the paired normal case)', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'payments', commit: 'p1', committedAt: DAY(1), model: model([element('a'), element('b')], [relation('r1', 'a', 'b')]) });
    const result = h.store({ source: 'shop', commit: 's1', committedAt: DAY(1), model: model([element('c'), element('d')], [relation('r2', 'c', 'd')]) });
    expect(result.errors).toEqual([]);
  });

  test('a new version declaring the same clashing id twice over (a malformed model) is refused with one error, not one per occurrence', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'payments', commit: 'p1', committedAt: DAY(1), model: model([element('payments-api')]) });

    // Two elements sharing one id: `parseModel`/`compileModel` would never
    // produce this (duplicate ids are refused earlier), but the history
    // does not re-check that — it is handed an already-compiled model — so
    // this only exercises `store`'s own dedup of a clash reported more than
    // once for the same slot.
    const malformed: CompiledModel = { ...model([]), elements: [element('payments-api'), element('payments-api')] };
    const result = h.store({ source: 'shop', commit: 's1', committedAt: DAY(1), model: malformed });
    expect(result.errors).toEqual([{ message: expect.any(String), id: 'payments-api', source: 'payments' }]);
  });

  test('two sources sharing a zone id whose content disagrees is recorded, not refused: the union keeps both definitions and reports a discrepancy naming the id, the field and both sources', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'a', commit: 'c1', committedAt: DAY(1), model: { ...model([]), zones: [zone('pci', 'compliance')] } });

    const result = h.store({ source: 'b', commit: 'c1', committedAt: DAY(1), model: { ...model([]), zones: [zone('pci', 'regulatory')] } });
    expect(result.errors).toEqual([]);

    const read = h.read({ valid: DAY(2), known: DAY(2) });
    expect(read.errors).toEqual([]);
    expect(read.discrepancies).toEqual([{ kind: 'zone', id: 'pci', sources: ['a', 'b'], field: 'zone' }]);
    expect(read.model?.zones).toEqual([{ id: 'pci', kind: 'compliance', alsoDefinedAs: [{ source: 'b', definition: { id: 'pci', kind: 'regulatory' } }] }]);
    // `b`'s own read is unaffected: it is, byte for byte, what `b` itself stored.
    expect(readModel(h, { source: 'b', valid: DAY(2), known: DAY(2) }).zones).toEqual([{ id: 'pci', kind: 'regulatory' }]);
  });

  test('two sources sharing a zone id with the identical definition store without a clash (the paired normal case)', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'a', commit: 'c1', committedAt: DAY(1), model: { ...model([]), zones: [zone('pci', 'compliance')] } });
    const result = h.store({ source: 'b', commit: 'c1', committedAt: DAY(1), model: { ...model([]), zones: [zone('pci', 'compliance')] } });

    expect(result.errors).toEqual([]);
    const graph = readModel(h, { valid: DAY(2), known: DAY(2) });
    expect(graph.zones).toEqual([{ id: 'pci', kind: 'compliance' }]);
  });
});
