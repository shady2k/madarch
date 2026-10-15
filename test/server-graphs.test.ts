import { describe, expect, test } from 'bun:test';
import {
  createGraphs,
  createPGliteHistory,
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
    entities: [],
    scenarios: [],
    zones: [],
    environments: [],
    states: [{ id: 'as-is' }],
  };
}

/** A history with the commits already stored; each commit's model is named by its elements and relations. */
async function storedHistory(source: string, clock: Clock, commits: { commit: string; committedAt: number; elements: CompiledElement[]; relations?: CompiledRelation[] }[]): Promise<HistoryStore> {
  const history = createPGliteHistory({ clock });
  for (const each of commits) {
    await history.store({ source, commit: each.commit, committedAt: each.committedAt, model: model(each.elements, each.relations) });
  }
  return history;
}

describe('a graph built from two sources', () => {
  test('the union view holds both sources’ roots, whose ids do not clash', async () => {
    const clock = fakeClock(DAY(9));
    const one = await storedHistory('github.com/acme/one', clock, [{ commit: 'c1', committedAt: DAY(1), elements: [element('one-root', { kind: 'system' })] }]);
    const two = await storedHistory('github.com/acme/two', clock, [{ commit: 'c1', committedAt: DAY(1), elements: [element('two-root', { kind: 'system' })] }]);
    const graphs = createGraphs({ historyOf: (source) => (source === 'github.com/acme/one' ? one : two), clock });

    const union = graphs.addGraph('union', ['github.com/acme/one', 'github.com/acme/two']);
    const view = (await union.engine()).view({ depth: 0 });
    graphs.close();

    expect(view.error).toBeUndefined();
    expect(view.elements?.map((e) => e.id).sort()).toEqual(['one-root', 'two-root']);
  });

  test('a graph listing one source answers that source alone', async () => {
    const clock = fakeClock(DAY(9));
    const one = await storedHistory('github.com/acme/one', clock, [{ commit: 'c1', committedAt: DAY(1), elements: [element('one-root', { kind: 'system' })] }]);
    const two = await storedHistory('github.com/acme/two', clock, [{ commit: 'c1', committedAt: DAY(1), elements: [element('two-root', { kind: 'system' })] }]);
    const graphs = createGraphs({ historyOf: (source) => (source === 'github.com/acme/one' ? one : two), clock });

    const single = graphs.graphForSource('github.com/acme/one');
    const view = (await single.engine()).view({ depth: 0 });
    graphs.close();

    expect(view.error).toBeUndefined();
    expect(view.elements?.map((e) => e.id)).toEqual(['one-root']);
    expect(single.name).toBe('github.com/acme/one');
    expect(single.sources).toEqual(['github.com/acme/one']);
  });

  test('a relation across the two sources joins them in the union view', async () => {
    const clock = fakeClock(DAY(9));
    const one = await storedHistory('github.com/acme/one', clock, [
      { commit: 'c1', committedAt: DAY(1), elements: [element('one-api')], relations: [relation('one-calls-two', 'one-api', 'two-api')] },
    ]);
    const two = await storedHistory('github.com/acme/two', clock, [{ commit: 'c1', committedAt: DAY(1), elements: [element('two-api')] }]);
    const graphs = createGraphs({ historyOf: (source) => (source === 'github.com/acme/one' ? one : two), clock });

    const union = graphs.addGraph('union', ['github.com/acme/one', 'github.com/acme/two']);
    const view = (await union.engine()).view({ depth: 0 });
    graphs.close();

    expect(view.relations?.map((r) => [r.from, r.to])).toEqual([['one-api', 'two-api']]);
  });
});

describe('asynchronous graph engine construction', () => {
  test('concurrent first calls share one engine', async () => {
    const clock = fakeClock(DAY(9));
    const history = await storedHistory('shop', clock, [{ commit: 'c1', committedAt: DAY(1), elements: [element('root', { kind: 'system' })] }]);
    const graphs = createGraphs({ historyOf: () => history, clock });
    const graph = graphs.graphForSource('shop');

    const [first, second] = await Promise.all([graph.engine(), graph.engine()]);
    graphs.close();
    await history.close();

    expect(first).toBe(second);
  });

  test('a store during a pending build invalidates it and the caller receives a fresh engine', async () => {
    const clock = fakeClock(DAY(9));
    const history = await storedHistory('shop', clock, [{ commit: 'c1', committedAt: DAY(1), elements: [element('root', { kind: 'system' })] }]);
    const originalAssertions = history.assertions.bind(history);
    let started!: () => void;
    let release!: () => void;
    const readStarted = new Promise<void>((resolve) => { started = resolve; });
    const holdRead = new Promise<void>((resolve) => { release = resolve; });
    let firstRead = true;
    history.assertions = async (input) => {
      if (firstRead) {
        firstRead = false;
        started();
        await holdRead;
      }
      return originalAssertions(input);
    };
    const graphs = createGraphs({ historyOf: () => history, clock });
    const graph = graphs.graphForSource('shop');
    const pendingEngine = graph.engine();
    await readStarted;

    const stored = await history.store({ source: 'shop', commit: 'c2', committedAt: DAY(2), model: model([element('root', { kind: 'system' }), element('next')]) });
    graphs.applyStore('shop', stored);
    release();
    const engine = await pendingEngine;
    const view = engine.view({ depth: 0 });
    graphs.close();
    await history.close();

    expect(view.elements?.map((each) => each.id).sort()).toEqual(['next', 'root']);
  });

  test('a failed read invalidated during a pending build retries from the history', async () => {
    const clock = fakeClock(DAY(9));
    const history = await storedHistory('shop', clock, [{ commit: 'c1', committedAt: DAY(1), elements: [element('root', { kind: 'system' })] }]);
    const originalAssertions = history.assertions.bind(history);
    let started!: () => void;
    let release!: () => void;
    const readStarted = new Promise<void>((resolve) => { started = resolve; });
    const holdRead = new Promise<void>((resolve) => { release = resolve; });
    let firstRead = true;
    history.assertions = async (input) => {
      if (firstRead) {
        firstRead = false;
        started();
        await holdRead;
        throw new Error('stale read failed');
      }
      return originalAssertions(input);
    };
    const graphs = createGraphs({ historyOf: () => history, clock });
    const graph = graphs.graphForSource('shop');
    const pendingEngine = graph.engine();
    await readStarted;

    graphs.dropBuilt('shop');
    release();
    const engine = await pendingEngine;
    const view = engine.view({ depth: 0 });
    graphs.close();
    await history.close();

    expect(view.elements?.map((each) => each.id)).toEqual(['root']);
  });

  test('closing a graph during a pending build does not leave an engine behind', async () => {
    const clock = fakeClock(DAY(9));
    const history = await storedHistory('shop', clock, [{ commit: 'c1', committedAt: DAY(1), elements: [element('root', { kind: 'system' })] }]);
    const originalAssertions = history.assertions.bind(history);
    let release!: () => void;
    const holdRead = new Promise<void>((resolve) => { release = resolve; });
    history.assertions = async (input) => {
      await holdRead;
      return originalAssertions(input);
    };
    const graphs = createGraphs({ historyOf: () => history, clock });
    const graph = graphs.graphForSource('shop');
    const pendingEngine = graph.engine();

    graphs.close();
    release();
    await expect(pendingEngine).rejects.toThrow(/graph "shop" is closed/);
    await history.close();
  });
});

describe('a graph is a set of sources', () => {
  test('a graph listing the same source twice is refused naming it', async () => {
    const clock = fakeClock(DAY(9));
    const one = createPGliteHistory({ clock });
    const graphs = createGraphs({ historyOf: () => one, clock });
    expect(() => graphs.addGraph('union', ['shop', 'shop'])).toThrow(/shop/);
    graphs.close();
  });

  test('two sources declaring the same element id are an error naming the id and both sources', async () => {
    const clock = fakeClock(DAY(9));
    const one = await storedHistory('github.com/acme/one', clock, [{ commit: 'c1', committedAt: DAY(1), elements: [element('core')] }]);
    const two = await storedHistory('github.com/acme/two', clock, [{ commit: 'c1', committedAt: DAY(1), elements: [element('core')] }]);
    const graphs = createGraphs({ historyOf: (source) => (source === 'github.com/acme/one' ? one : two), clock });
    const union = graphs.addGraph('union', ['github.com/acme/one', 'github.com/acme/two']);

    let thrown: unknown;
    try {
      await union.engine();
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toContain('"core"');
    expect((thrown as Error).message).toContain('github.com/acme/one');
    expect((thrown as Error).message).toContain('github.com/acme/two');
    graphs.close();
  });

  test('an id one source dropped before another declares it is no clash', async () => {
    const clock = fakeClock(DAY(9));
    const one = createPGliteHistory({ clock });
    const two = createPGliteHistory({ clock });
    clock.set(DAY(10));
    await one.store({ source: 'github.com/acme/one', commit: 'c1', committedAt: DAY(1), model: model([element('core')]) });
    clock.set(DAY(12));
    await one.store({ source: 'github.com/acme/one', commit: 'c2', committedAt: DAY(3), model: model([]) });
    clock.set(DAY(14));
    await two.store({ source: 'github.com/acme/two', commit: 'c1', committedAt: DAY(3), model: model([element('core')]) });

    const graphs = createGraphs({ historyOf: (source) => (source === 'github.com/acme/one' ? one : two), clock });
    const union = graphs.addGraph('union', ['github.com/acme/one', 'github.com/acme/two']);
    expect((await union.engine()).view({ depth: 0 }).elements?.map((each) => each.id)).toEqual(['core']);
    graphs.close();
  });
});

describe('keeping a built graph in step', () => {
  test('a store after the engine was built is applied, and the view changes with it', async () => {
    const clock = fakeClock(DAY(9));
    const one = createPGliteHistory({ clock });
    await one.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('root', { kind: 'system' })]) });
    const graphs = createGraphs({ historyOf: () => one, clock });
    const graph = graphs.graphForSource('shop');
    expect((await graph.engine()).view({ depth: 1 }).elements?.map((e) => e.id)).toEqual(['root']);

    const result = await one.store({ source: 'shop', commit: 'c2', committedAt: DAY(2), model: model([element('root', { kind: 'system' }), element('child', { parent: 'root', ancestors: ['root'] })]) });
    expect(result.errors).toEqual([]);
    graphs.applyStore('shop', result);

    const view = (await graph.engine()).view({ depth: 1 });
    graphs.close();
    expect(view.elements?.map((e) => e.id).sort()).toEqual(['child', 'root']);
  });

  test('a store report that both closes and opens rows reaches a built engine', async () => {
    // The closed row leaves the assertion-driven view; the opened child
    // row must arrive in the same update.
    const clock = fakeClock(DAY(9));
    const one = createPGliteHistory({ clock });
    await one.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('a'), element('keep')]) });
    const graphs = createGraphs({ historyOf: () => one, clock });
    const graph = graphs.graphForSource('shop');
    expect((await graph.engine()).view({ depth: 1 }).elements?.map((each) => each.id).sort()).toEqual(['a', 'keep']);

    const result = await one.store({ source: 'shop', commit: 'c2', committedAt: DAY(2), model: model([element('keep'), element('child', { parent: 'keep', ancestors: ['keep'] })]) });
    expect(result.errors).toEqual([]);
    expect(result.closed.length).toBeGreaterThan(0);
    expect(result.opened.length).toBeGreaterThan(0);
    graphs.applyStore('shop', result);
    // Closing `a` clamped the store's own recorded moment 1 ms past the
    // frozen clock; move real time past it, as a running server would,
    // before asking the view.
    clock.set(DAY(15));
    const view = (await graph.engine()).view({ depth: 1 });
    graphs.close();
    expect(view.elements?.map((each) => each.id).sort()).toEqual(['child', 'keep']);
  });

  test('a store report that only closes rows reaches a built engine', async () => {
    // A commit at the very instant the dropped row starts, sorting after
    // it by id, closes the old row and opens no replacement (a zero-width
    // slice is never written).
    const clock = fakeClock(DAY(9));
    const one = createPGliteHistory({ clock });
    await one.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('a')]) });
    const graphs = createGraphs({ historyOf: () => one, clock });
    const graph = graphs.graphForSource('shop');
    expect((await graph.engine()).view({ depth: 1 }).elements?.map((each) => each.id)).toEqual(['a']);

    const result = await one.store({ source: 'shop', commit: 'c2', committedAt: DAY(1), model: model([]) });
    expect(result.errors).toEqual([]);
    expect(result.closed.length).toBeGreaterThan(0);
    expect(result.opened).toEqual([]);
    graphs.applyStore('shop', result);
    clock.set(DAY(15));

    const view = (await graph.engine()).view({ depth: 1 });
    graphs.close();
    expect(view.elements?.map((each) => each.id)).toEqual([]);
  });

  test('dropBuilt drops the built engines of every graph listing the source, and the next use rebuilds from the history', async () => {
    const clock = fakeClock(DAY(9));
    const one = createPGliteHistory({ clock });
    await one.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('a')]) });
    const graphs = createGraphs({ historyOf: () => one, clock });
    const own = graphs.graphForSource('shop');
    const union = graphs.addGraph('union', ['shop', 'other']);
    expect((await own.engine()).view({ depth: 0 }).elements?.map((each) => each.id)).toEqual(['a']);
    expect((await union.engine()).view({ depth: 0 }).elements?.map((each) => each.id)).toEqual(['a']);

    await one.store({ source: 'shop', commit: 'c2', committedAt: DAY(2), model: model([element('b')]) });
    // The second store recorded its rows 1 ms past the frozen clock (it
    // closed c1's row); move real time past that before asking again.
    clock.set(DAY(15));
    graphs.dropBuilt('shop');

    expect((await own.engine()).view({ depth: 0 }).elements?.map((each) => each.id)).toEqual(['b']);
    expect((await union.engine()).view({ depth: 0 }).elements?.map((each) => each.id)).toEqual(['b']);
    graphs.close();
  });

  test('remove takes the graphs listing the source out of the set, and a graph of the name is built fresh', async () => {
    const clock = fakeClock(DAY(9));
    const one = createPGliteHistory({ clock });
    await one.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('a')]) });
    const graphs = createGraphs({ historyOf: () => one, clock });
    const own = graphs.graphForSource('shop');
    const union = graphs.addGraph('union', ['shop', 'other']);
    expect((await own.engine()).view({ depth: 0 }).elements?.map((each) => each.id)).toEqual(['a']);
    expect((await union.engine()).view({ depth: 0 }).elements?.map((each) => each.id)).toEqual(['a']);

    graphs.remove('shop');

    // Both graphs listed shop, so both are gone: a graph holding the old
    // name's rows is never asked again, and the next use rebuilds.
    expect(graphs.get('shop')).toBeUndefined();
    expect(graphs.get('union')).toBeUndefined();
    // A graph of the name is built again from the histories, as a view
    // under a new name would build it: what the old one held is gone.
    const fresh = graphs.graphForSource('shop');
    expect(fresh).not.toBe(own);
    expect((await fresh.engine()).view({ depth: 0 }).elements?.map((each) => each.id)).toEqual(['a']);
    graphs.close();
  });
  test('removes every matching graph even when one graph close throws, then rethrows the failure', async () => {
    const clock = fakeClock(DAY(9));
    const one = createPGliteHistory({ clock });
    const graphs = createGraphs({ historyOf: () => one, clock });
    const first = graphs.addGraph('first', ['shop']);
    const second = graphs.addGraph('second', ['shop']);
    first.close = () => { throw new Error('close failed'); };
    let thrown: unknown;
    try {
      graphs.remove('shop');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('close failed');
    expect(graphs.get('first')).toBeUndefined();
    expect(graphs.get('second')).toBeUndefined();
    one.close();
  });

  test('a store whose report a built engine fails to apply is dropped, not left behind: the throw passes on and the next use rebuilds from the history', async () => {
    const clock = fakeClock(DAY(9));
    const one = createPGliteHistory({ clock });
    await one.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('a')]) });
    const graphs = createGraphs({ historyOf: () => one, clock });
    const graph = graphs.graphForSource('shop');
    expect((await graph.engine()).view({ depth: 0 }).elements?.map((each) => each.id)).toEqual(['a']);

    const result = await one.store({ source: 'shop', commit: 'c2', committedAt: DAY(2), model: model([element('b')]) });
    expect(result.errors).toEqual([]);
    expect(result.opened.length + result.closed.length).toBeGreaterThan(0);
    // Sabotage the built engine's own update, as a failing Ladybug write
    // would: the history has the commit, the engine cannot take it.
    const engine = await graph.engine();
    engine.update = () => {
      throw new Error('the engine update failed');
    };
    expect(() => graphs.applyStore('shop', result)).toThrow(/the engine update failed/);

    // The retry answers "already stored": an empty report that must
    // change nothing, yet leave no half-updated engine behind.
    graphs.applyStore('shop', { errors: [], opened: [], closed: [] });
    // The second store recorded its rows 1 ms past the frozen clock (it
    // closed c1's row); move real time past that before asking again.
    clock.set(DAY(15));
    const view = (await graph.engine()).view({ depth: 0 });
    graphs.close();
    expect(view.elements?.map((each) => each.id)).toEqual(['b']);
  });

  test('a recovery whose engine close fails still drops every listing graph and passes the original error on', async () => {
    const clock = fakeClock(DAY(9));
    const one = createPGliteHistory({ clock });
    await one.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('a')]) });
    const graphs = createGraphs({ historyOf: () => one, clock });
    const own = graphs.graphForSource('shop');
    const union = graphs.addGraph('union', ['shop', 'other']);
    expect((await own.engine()).view({ depth: 0 }).elements?.map((each) => each.id)).toEqual(['a']);
    expect((await union.engine()).view({ depth: 0 }).elements?.map((each) => each.id)).toEqual(['a']);

    const result = await one.store({ source: 'shop', commit: 'c2', committedAt: DAY(2), model: model([element('b')]) });
    expect(result.errors).toEqual([]);
    // Sabotage the one graph's engine twice over: its update throws (the
    // failure being recovered from) and so does its close (the destructor
    // failing on the recovery path).
    const engine = await own.engine();
    engine.update = () => {
      throw new Error('the engine update failed');
    };
    engine.close = () => {
      throw new Error('the engine close failed');
    };

    let thrown: unknown;
    try {
      graphs.applyStore('shop', result);
    } catch (error) {
      thrown = error;
    }
    // The original update error is the one the caller sees — a failing
    // close never masks it.
    expect((thrown as Error).message).toBe('the engine update failed');

    // The second store recorded its rows 1 ms past the frozen clock (it
    // closed c1's row); move real time past that before asking again.
    clock.set(DAY(15));
    // Both graphs' engines are gone: each next use rebuilds from the
    // history and answers at c2, not from the engine the close failed on.
    expect((await own.engine()).view({ depth: 0 }).elements?.map((each) => each.id)).toEqual(['b']);
    expect((await union.engine()).view({ depth: 0 }).elements?.map((each) => each.id)).toEqual(['b']);
    graphs.close();
  });

  test('a graph built after several stores sees all of them without any update call', async () => {
    const clock = fakeClock(DAY(9));
    const one = createPGliteHistory({ clock });
    await one.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('a')]) });
    await one.store({ source: 'shop', commit: 'c2', committedAt: DAY(2), model: model([element('a'), element('b')]) });
    const graphs = createGraphs({ historyOf: () => one, clock });

    const view = (await graphs.graphForSource('shop').engine()).view({ depth: 0 });
    graphs.close();
    expect(view.elements?.map((e) => e.id)).toEqual(['a', 'b']);
  });

  test('a store with nothing opened or closed changes nothing', async () => {
    const clock = fakeClock(DAY(9));
    const one = createPGliteHistory({ clock });
    await one.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('a')]) });
    const graphs = createGraphs({ historyOf: () => one, clock });
    const graph = graphs.graphForSource('shop');
    const before = (await graph.engine()).view({ depth: 0 }).elements?.map((e) => e.id);

    graphs.applyStore('shop', { errors: [], opened: [], closed: [] });

    expect((await graph.engine()).view({ depth: 0 }).elements?.map((e) => e.id)).toEqual(before);
    graphs.close();
  });

  test('a store for a source the graph does not list is not applied', async () => {
    const clock = fakeClock(DAY(9));
    const one = createPGliteHistory({ clock });
    await one.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('shop-root')]) });
    await one.store({ source: 'other', commit: 'c1', committedAt: DAY(1), model: model([element('other-root')]) });
    const graphs = createGraphs({ historyOf: () => one, clock });
    const graph = graphs.graphForSource('shop');
    expect((await graph.engine()).view({ depth: 0 }).elements?.map((e) => e.id)).toEqual(['shop-root']);

    const result = await one.store({ source: 'other', commit: 'c2', committedAt: DAY(2), model: model([element('other-root'), element('other-new')]) });
    graphs.applyStore('other', result);

    const view = (await graph.engine()).view({ depth: 0 });
    graphs.close();
    expect(view.elements?.map((e) => e.id)).toEqual(['shop-root']);
  });

  test('a store that brings a clash into a built two-source graph drops its engine, and the next use refuses instead of answering with duplicate rows', async () => {
    const clock = fakeClock(DAY(9));
    const one = createPGliteHistory({ clock });
    const two = createPGliteHistory({ clock });
    await one.store({ source: 'github.com/acme/one', commit: 'c1', committedAt: DAY(1), model: model([element('one-root')]) });
    await two.store({ source: 'github.com/acme/two', commit: 'c1', committedAt: DAY(1), model: model([element('two-root')]) });
    const graphs = createGraphs({ historyOf: (source) => (source === 'github.com/acme/one' ? one : two), clock });
    const union = graphs.addGraph('union', ['github.com/acme/one', 'github.com/acme/two']);
    expect((await union.engine()).view({ depth: 0 }).elements?.map((each) => each.id).sort()).toEqual(['one-root', 'two-root']);

    // The store's own report reaches the built engine as rows; only a
    // rebuild through the clash check can refuse what they declare.
    const result = await one.store({ source: 'github.com/acme/one', commit: 'c2', committedAt: DAY(2), model: model([element('one-root'), element('two-root')]) });
    expect(result.errors).toEqual([]);
    graphs.applyStore('github.com/acme/one', result);

    let thrown: unknown;
    try {
      await union.engine();
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toContain('"two-root"');
    expect((thrown as Error).message).toContain('github.com/acme/one');
    expect((thrown as Error).message).toContain('github.com/acme/two');
    graphs.close();
  });
});

describe('graph names', () => {
  test('a graph name taken twice is refused naming it', async () => {
    const clock = fakeClock(DAY(9));
    const one = createPGliteHistory({ clock });
    const graphs = createGraphs({ historyOf: () => one, clock });
    graphs.addGraph('union', ['shop']);
    expect(() => graphs.addGraph('union', ['other'])).toThrow(/union/);
    graphs.close();
  });

  test('a graph listing no source is refused naming it', async () => {
    const clock = fakeClock(DAY(9));
    const one = createPGliteHistory({ clock });
    const graphs = createGraphs({ historyOf: () => one, clock });
    expect(() => graphs.addGraph('empty', [])).toThrow(/empty/);
    graphs.close();
  });

  test('graphForSource hands the same graph back and get finds it by name', async () => {
    const clock = fakeClock(DAY(9));
    const one = createPGliteHistory({ clock });
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
  test('the sources are held in code point order, whatever order they were listed in', async () => {
    const clock = fakeClock(DAY(9));
    const one = createPGliteHistory({ clock });
    const graphs = createGraphs({ historyOf: () => one, clock });
    const union = graphs.addGraph('union', ['github.com/acme/two', 'github.com/acme/one', 'github.com/acme/three']);
    expect(union.sources).toEqual(['github.com/acme/one', 'github.com/acme/three', 'github.com/acme/two']);
    graphs.close();
  });

  test('the engine answers at the clock the graphs were given, not the real one', async () => {
    // A commit dated far past the real "now": only an engine answering at
    // the injected clock sees it as current.
    const far = Date.UTC(2030, 0, 2);
    const clock = fakeClock(far);
    const one = createPGliteHistory({ clock });
    await one.store({ source: 'shop', commit: 'c1', committedAt: Date.UTC(2030, 0, 1), model: model([element('far-future')]) });
    const graphs = createGraphs({ historyOf: () => one, clock });
    const view = (await graphs.graphForSource('shop').engine()).view({ depth: 0 });
    graphs.close();
    expect(view.elements?.map((each) => each.id)).toEqual(['far-future']);
  });

  test('a store report applied before the engine was ever built is not lost and does not build it', async () => {
    const clock = fakeClock(DAY(9));
    const one = createPGliteHistory({ clock });
    await one.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('root', { kind: 'system' })]) });
    const graphs = createGraphs({ historyOf: () => one, clock });
    const graph = graphs.addGraph('shop', ['shop']);

    const result = await one.store({ source: 'shop', commit: 'c2', committedAt: DAY(2), model: model([element('root', { kind: 'system' }), element('child', { parent: 'root', ancestors: ['root'] })]) });
    expect(result.errors).toEqual([]);
    expect(() => graphs.applyStore('shop', result)).not.toThrow();

    expect((await graph.engine()).view({ depth: 1 }).elements?.map((each) => each.id).sort()).toEqual(['child', 'root']);
    graphs.close();
  });
});

