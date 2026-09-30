import { describe, expect, test } from 'bun:test';
import {
  createGraphs,
  createSqliteHistory,
  type Clock,
  type CompiledElement,
  type CompiledModel,
  type CompiledRelation,
  type HistoryStore,
} from '../src/index.js';

const DAY = (day: number) => Date.UTC(2026, 8, day); // September 2026

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

function element(id: string, extra: Partial<CompiledElement> = {}): CompiledElement {
  return { id, kind: 'service', ancestors: [], zones: [], zonesByEnvironment: {}, environments: ['*'], states: ['as-is'], ...extra };
}

function relation(id: string, from: string, to: string): CompiledRelation {
  return { id, from, to, interaction: false, environments: ['*'], states: ['as-is'] };
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

/** A history with the commits already stored; each commit's model is named by its elements and relations. */
function storedHistory(source: string, clock: Clock, commits: { commit: string; committedAt: number; elements: CompiledElement[]; relations?: CompiledRelation[] }[]): HistoryStore {
  const history = createSqliteHistory({ clock });
  for (const each of commits) {
    history.store({ source, commit: each.commit, committedAt: each.committedAt, model: model(each.elements, each.relations) });
  }
  return history;
}

describe('a graph built from two sources', () => {
  test('the union view holds both sources’ roots, whose ids do not clash', () => {
    const clock = fakeClock(DAY(9));
    const one = storedHistory('github.com/a/one', clock, [{ commit: 'c1', committedAt: DAY(1), elements: [element('one-root', { kind: 'system' })] }]);
    const two = storedHistory('github.com/b/two', clock, [{ commit: 'c1', committedAt: DAY(1), elements: [element('two-root', { kind: 'system' })] }]);
    const graphs = createGraphs({ historyOf: (source) => (source === 'github.com/a/one' ? one : two), clock });

    const union = graphs.addGraph('union', ['github.com/a/one', 'github.com/b/two']);
    const view = union.engine().view({ depth: 0 });
    graphs.close();

    expect(view.error).toBeUndefined();
    expect(view.elements?.map((e) => e.id).sort()).toEqual(['one-root', 'two-root']);
  });

  test('a graph listing one source answers that source alone', () => {
    const clock = fakeClock(DAY(9));
    const one = storedHistory('github.com/a/one', clock, [{ commit: 'c1', committedAt: DAY(1), elements: [element('one-root', { kind: 'system' })] }]);
    const two = storedHistory('github.com/b/two', clock, [{ commit: 'c1', committedAt: DAY(1), elements: [element('two-root', { kind: 'system' })] }]);
    const graphs = createGraphs({ historyOf: (source) => (source === 'github.com/a/one' ? one : two), clock });

    const single = graphs.graphForSource('github.com/a/one');
    const view = single.engine().view({ depth: 0 });
    graphs.close();

    expect(view.error).toBeUndefined();
    expect(view.elements?.map((e) => e.id)).toEqual(['one-root']);
    expect(single.name).toBe('github.com/a/one');
    expect(single.sources).toEqual(['github.com/a/one']);
  });

  test('a relation across the two sources joins them in the union view', () => {
    const clock = fakeClock(DAY(9));
    const one = storedHistory('github.com/a/one', clock, [
      { commit: 'c1', committedAt: DAY(1), elements: [element('one-api')], relations: [relation('one-calls-two', 'one-api', 'two-api')] },
    ]);
    const two = storedHistory('github.com/b/two', clock, [{ commit: 'c1', committedAt: DAY(1), elements: [element('two-api')] }]);
    const graphs = createGraphs({ historyOf: (source) => (source === 'github.com/a/one' ? one : two), clock });

    const union = graphs.addGraph('union', ['github.com/a/one', 'github.com/b/two']);
    const view = union.engine().view({ depth: 0 });
    graphs.close();

    expect(view.relations?.map((r) => [r.from, r.to])).toEqual([['one-api', 'two-api']]);
  });
});

describe('a graph is a set of sources', () => {
  test('a graph listing the same source twice is refused naming it', () => {
    const clock = fakeClock(DAY(9));
    const one = createSqliteHistory({ clock });
    const graphs = createGraphs({ historyOf: () => one, clock });
    expect(() => graphs.addGraph('union', ['shop', 'shop'])).toThrow(/shop/);
    graphs.close();
  });

  test('two sources declaring the same element id are an error naming the id and both sources', () => {
    const clock = fakeClock(DAY(9));
    const one = storedHistory('github.com/a/one', clock, [{ commit: 'c1', committedAt: DAY(1), elements: [element('core')] }]);
    const two = storedHistory('github.com/b/two', clock, [{ commit: 'c1', committedAt: DAY(1), elements: [element('core')] }]);
    const graphs = createGraphs({ historyOf: (source) => (source === 'github.com/a/one' ? one : two), clock });
    const union = graphs.addGraph('union', ['github.com/a/one', 'github.com/b/two']);

    let thrown: unknown;
    try {
      union.engine();
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toContain('"core"');
    expect((thrown as Error).message).toContain('github.com/a/one');
    expect((thrown as Error).message).toContain('github.com/b/two');
    graphs.close();
  });

  test('an id one source dropped before another declares it is no clash', () => {
    const clock = fakeClock(DAY(9));
    const one = createSqliteHistory({ clock });
    const two = createSqliteHistory({ clock });
    clock.set(DAY(10));
    one.store({ source: 'github.com/a/one', commit: 'c1', committedAt: DAY(1), model: model([element('core')]) });
    clock.set(DAY(12));
    one.store({ source: 'github.com/a/one', commit: 'c2', committedAt: DAY(3), model: model([]) });
    clock.set(DAY(14));
    two.store({ source: 'github.com/b/two', commit: 'c1', committedAt: DAY(3), model: model([element('core')]) });

    const graphs = createGraphs({ historyOf: (source) => (source === 'github.com/a/one' ? one : two), clock });
    const union = graphs.addGraph('union', ['github.com/a/one', 'github.com/b/two']);
    expect(union.engine().view({ depth: 0 }).elements?.map((each) => each.id)).toEqual(['core']);
    graphs.close();
  });
});

describe('keeping a built graph in step', () => {
  test('a store after the engine was built is applied, and the view changes with it', () => {
    const clock = fakeClock(DAY(9));
    const one = createSqliteHistory({ clock });
    one.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('root', { kind: 'system' })]) });
    const graphs = createGraphs({ historyOf: () => one, clock });
    const graph = graphs.graphForSource('shop');
    expect(graph.engine().view({ depth: 1 }).elements?.map((e) => e.id)).toEqual(['root']);

    const result = one.store({ source: 'shop', commit: 'c2', committedAt: DAY(2), model: model([element('root', { kind: 'system' }), element('child', { parent: 'root', ancestors: ['root'] })]) });
    expect(result.errors).toEqual([]);
    graphs.applyStore('shop', result);

    const view = graph.engine().view({ depth: 1 });
    graphs.close();
    expect(view.elements?.map((e) => e.id).sort()).toEqual(['child', 'root']);
  });

  test('a store report that both closes and opens rows reaches a built engine', () => {
    // The closed row leaves the assertion-driven view; the opened child
    // row must arrive in the same update.
    const clock = fakeClock(DAY(9));
    const one = createSqliteHistory({ clock });
    one.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('a'), element('keep')]) });
    const graphs = createGraphs({ historyOf: () => one, clock });
    const graph = graphs.graphForSource('shop');
    expect(graph.engine().view({ depth: 1 }).elements?.map((each) => each.id).sort()).toEqual(['a', 'keep']);

    const result = one.store({ source: 'shop', commit: 'c2', committedAt: DAY(2), model: model([element('keep'), element('child', { parent: 'keep', ancestors: ['keep'] })]) });
    expect(result.errors).toEqual([]);
    expect(result.closed.length).toBeGreaterThan(0);
    expect(result.opened.length).toBeGreaterThan(0);
    graphs.applyStore('shop', result);
    // Closing `a` clamped the store's own recorded moment 1 ms past the
    // frozen clock; move real time past it, as a running server would,
    // before asking the view.
    clock.set(DAY(15));
    const view = graph.engine().view({ depth: 1 });
    graphs.close();
    expect(view.elements?.map((each) => each.id).sort()).toEqual(['child', 'keep']);
  });

  test('a store report that only closes rows reaches a built engine', () => {
    // A commit at the very instant the dropped row starts, sorting after
    // it by id, closes the old row and opens no replacement (a zero-width
    // slice is never written).
    const clock = fakeClock(DAY(9));
    const one = createSqliteHistory({ clock });
    one.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('a')]) });
    const graphs = createGraphs({ historyOf: () => one, clock });
    const graph = graphs.graphForSource('shop');
    expect(graph.engine().view({ depth: 1 }).elements?.map((each) => each.id)).toEqual(['a']);

    const result = one.store({ source: 'shop', commit: 'c2', committedAt: DAY(1), model: model([]) });
    expect(result.errors).toEqual([]);
    expect(result.closed.length).toBeGreaterThan(0);
    expect(result.opened).toEqual([]);
    graphs.applyStore('shop', result);
    clock.set(DAY(15));

    const view = graph.engine().view({ depth: 1 });
    graphs.close();
    expect(view.elements?.map((each) => each.id)).toEqual([]);
  });

  test('a graph built after several stores sees all of them without any update call', () => {
    const clock = fakeClock(DAY(9));
    const one = createSqliteHistory({ clock });
    one.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('a')]) });
    one.store({ source: 'shop', commit: 'c2', committedAt: DAY(2), model: model([element('a'), element('b')]) });
    const graphs = createGraphs({ historyOf: () => one, clock });

    const view = graphs.graphForSource('shop').engine().view({ depth: 0 });
    graphs.close();
    expect(view.elements?.map((e) => e.id)).toEqual(['a', 'b']);
  });

  test('a store with nothing opened or closed changes nothing', () => {
    const clock = fakeClock(DAY(9));
    const one = createSqliteHistory({ clock });
    one.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('a')]) });
    const graphs = createGraphs({ historyOf: () => one, clock });
    const graph = graphs.graphForSource('shop');
    const before = graph.engine().view({ depth: 0 }).elements?.map((e) => e.id);

    graphs.applyStore('shop', { errors: [], opened: [], closed: [] });

    expect(graph.engine().view({ depth: 0 }).elements?.map((e) => e.id)).toEqual(before);
    graphs.close();
  });

  test('a store for a source the graph does not list is not applied', () => {
    const clock = fakeClock(DAY(9));
    const one = createSqliteHistory({ clock });
    one.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('shop-root')]) });
    one.store({ source: 'other', commit: 'c1', committedAt: DAY(1), model: model([element('other-root')]) });
    const graphs = createGraphs({ historyOf: () => one, clock });
    const graph = graphs.graphForSource('shop');
    expect(graph.engine().view({ depth: 0 }).elements?.map((e) => e.id)).toEqual(['shop-root']);

    const result = one.store({ source: 'other', commit: 'c2', committedAt: DAY(2), model: model([element('other-root'), element('other-new')]) });
    graphs.applyStore('other', result);

    const view = graph.engine().view({ depth: 0 });
    graphs.close();
    expect(view.elements?.map((e) => e.id)).toEqual(['shop-root']);
  });
});

describe('graph names', () => {
  test('a graph name taken twice is refused naming it', () => {
    const clock = fakeClock(DAY(9));
    const one = createSqliteHistory({ clock });
    const graphs = createGraphs({ historyOf: () => one, clock });
    graphs.addGraph('union', ['shop']);
    expect(() => graphs.addGraph('union', ['other'])).toThrow(/union/);
    graphs.close();
  });

  test('a graph listing no source is refused naming it', () => {
    const clock = fakeClock(DAY(9));
    const one = createSqliteHistory({ clock });
    const graphs = createGraphs({ historyOf: () => one, clock });
    expect(() => graphs.addGraph('empty', [])).toThrow(/empty/);
    graphs.close();
  });

  test('graphForSource hands the same graph back and get finds it by name', () => {
    const clock = fakeClock(DAY(9));
    const one = createSqliteHistory({ clock });
    const graphs = createGraphs({ historyOf: () => one, clock });
    const first = graphs.graphForSource('shop');
    const second = graphs.graphForSource('shop');
    expect(second).toBe(first);
    expect(graphs.get('shop')).toBe(first);
    expect(graphs.get('nope')).toBeUndefined();
    graphs.close();
  });
});

describe('the graph engine and its clock', () => {
  test('the sources are held in code point order, whatever order they were listed in', () => {
    const clock = fakeClock(DAY(9));
    const one = createSqliteHistory({ clock });
    const graphs = createGraphs({ historyOf: () => one, clock });
    const union = graphs.addGraph('union', ['github.com/b/two', 'github.com/a/one', 'github.com/c/three']);
    expect(union.sources).toEqual(['github.com/a/one', 'github.com/b/two', 'github.com/c/three']);
    graphs.close();
  });

  test('the engine answers at the clock the graphs were given, not the real one', () => {
    // A commit dated far past the real "now": only an engine answering at
    // the injected clock sees it as current.
    const far = Date.UTC(2030, 0, 2);
    const clock = fakeClock(far);
    const one = createSqliteHistory({ clock });
    one.store({ source: 'shop', commit: 'c1', committedAt: Date.UTC(2030, 0, 1), model: model([element('far-future')]) });
    const graphs = createGraphs({ historyOf: () => one, clock });
    const view = graphs.graphForSource('shop').engine().view({ depth: 0 });
    graphs.close();
    expect(view.elements?.map((each) => each.id)).toEqual(['far-future']);
  });

  test('a store report applied before the engine was ever built is not lost and does not build it', () => {
    const clock = fakeClock(DAY(9));
    const one = createSqliteHistory({ clock });
    one.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('root', { kind: 'system' })]) });
    const graphs = createGraphs({ historyOf: () => one, clock });
    const graph = graphs.addGraph('shop', ['shop']);

    const result = one.store({ source: 'shop', commit: 'c2', committedAt: DAY(2), model: model([element('root', { kind: 'system' }), element('child', { parent: 'root', ancestors: ['root'] })]) });
    expect(result.errors).toEqual([]);
    expect(() => graphs.applyStore('shop', result)).not.toThrow();

    expect(graph.engine().view({ depth: 1 }).elements?.map((each) => each.id).sort()).toEqual(['child', 'root']);
    graphs.close();
  });
});

