import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSqliteHistory,
  loadAndCompileModel,
  serializeCompiledModel,
  type Clock,
  type CompiledElement,
  type CompiledModel,
  type CompiledRelation,
  type HistoryStore,
} from '../src/index.js';

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

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

function readModel(h: HistoryStore, input?: Parameters<HistoryStore['read']>[0]): CompiledModel {
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

describe('store-version: storing a source at a commit', () => {
  test('reading as of the commit\'s valid time and the storing moment\'s known time returns what was stored', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);

    const shopAtC1 = model([element('a'), element('b'), element('c')]);
    const result = h.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: shopAtC1 });
    expect(result.errors).toEqual([]);

    const read = readModel(h, { source: 'shop', valid: DAY(1), known: DAY(2) });
    expect(read.elements.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  test('nothing is returned before the commit\'s valid time', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('a')]) });

    expect(readModel(h, { source: 'shop', valid: DAY(1) - 1, known: DAY(2) }).elements).toEqual([]);
  });
});

describe('replace: a new version replaces what the source asserted', () => {
  function storeTwoVersions(clock: ReturnType<typeof fakeClock>, h: HistoryStore) {
    clock.set(DAY(2));
    h.store({
      source: 'shop',
      commit: 'c1',
      committedAt: DAY(1),
      model: model([element('legacy-billing'), element('checkout-web')]),
    });
    clock.set(DAY(11));
    h.store({ source: 'shop', commit: 'c2', committedAt: DAY(10), model: model([element('checkout-web')]) });
  }

  test('element-removed: the removed element is there before the commit that removes it, and gone after, at the latest known time', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    storeTwoVersions(clock, h);

    const before = readModel(h, { source: 'shop', valid: DAY(5), known: DAY(12) });
    expect(before.elements.map((e) => e.id).sort()).toEqual(['checkout-web', 'legacy-billing']);

    const after = readModel(h, { source: 'shop', valid: DAY(12), known: DAY(12) });
    expect(after.elements.map((e) => e.id)).toEqual(['checkout-web']);
  });

  test('what-we-knew: read at a known time before the removal was recorded still shows the removed element', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    storeTwoVersions(clock, h);

    // As of 12 September (valid), the history knew, on 3 September, only
    // what c1 said — c2 (which removes legacy-billing) was not recorded
    // until 11 September.
    const asKnownEarly = readModel(h, { source: 'shop', valid: DAY(12), known: DAY(3) });
    expect(asKnownEarly.elements.map((e) => e.id).sort()).toEqual(['checkout-web', 'legacy-billing']);
  });

  test('an element unchanged across the two versions is left exactly as it was, not closed and reopened', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    storeTwoVersions(clock, h);

    // checkout-web survives both versions: reading it as of any time from
    // c1's onward, known now, finds the same one assertion of it.
    const atC1 = readModel(h, { source: 'shop', valid: DAY(1), known: DAY(20) }).elements.find((e) => e.id === 'checkout-web');
    const atC2 = readModel(h, { source: 'shop', valid: DAY(10), known: DAY(20) }).elements.find((e) => e.id === 'checkout-web');
    expect(atC1).toEqual(atC2);
  });

  test('an element whose content changes (same id, different fields) is closed and reopened with the new content', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('checkout-web', { technology: 'AAA' })]) });
    clock.set(DAY(11));
    h.store({ source: 'shop', commit: 'c2', committedAt: DAY(10), model: model([element('checkout-web', { technology: 'ZZZ' })]) });

    const before = readModel(h, { source: 'shop', valid: DAY(5), known: DAY(20) }).elements.find((e) => e.id === 'checkout-web');
    expect(before?.technology).toBe('AAA');

    const after = readModel(h, { source: 'shop', valid: DAY(12), known: DAY(20) }).elements.find((e) => e.id === 'checkout-web');
    expect(after?.technology).toBe('ZZZ');
  });

  test('an element unchanged across a version does not linger as a stray assertion once a later version removes it', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    // c1: two elements. c2 (10 September): the same two, unchanged — this
    // must not open a redundant duplicate of the unchanged one. c3 (20
    // September): only one left.
    h.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('checkout-web'), element('legacy-billing')]) });
    clock.set(DAY(11));
    h.store({ source: 'shop', commit: 'c2', committedAt: DAY(10), model: model([element('checkout-web'), element('legacy-billing')]) });
    clock.set(DAY(21));
    h.store({ source: 'shop', commit: 'c3', committedAt: DAY(20), model: model([element('checkout-web')]) });

    const after = readModel(h, { source: 'shop', valid: DAY(25), known: DAY(21) });
    expect(after.elements.map((e) => e.id)).toEqual(['checkout-web']);
  });
});

describe('reading the union of an unsorted store: entities come back sorted by id, code point order', () => {
  test('elements are sorted regardless of the order they were stored in, whether read by source or across every source', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    // Stored out of order across two separate commits, so neither
    // insertion order nor a single commit's own array order could explain
    // a sorted result by accident.
    h.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('c')]) });
    h.store({ source: 'shop', commit: 'c2', committedAt: DAY(1) + 1, model: model([element('c'), element('a'), element('b')]) });

    expect(readModel(h, { source: 'shop', valid: DAY(1) + 1, known: DAY(2) }).elements.map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(readModel(h, { valid: DAY(1) + 1, known: DAY(2) }).elements.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('the database path option', () => {
  test('an in-memory history (the default) is not shared between two independent instances', () => {
    const clock = fakeClock(DAY(2));
    const h1 = createSqliteHistory({ clock });
    h1.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('a')]) });

    const h2 = createSqliteHistory({ clock });
    expect(readModel(h2, { source: 'shop', valid: DAY(1), known: DAY(2) }).elements).toEqual([]);
  });

  test('a file path persists the history: a second instance opened on the same path reads what the first stored', () => {
    const dir = mkdtempSync(join(tmpdir(), 'madarch-history-'));
    const path = join(dir, 'history.sqlite');
    const clock = fakeClock(DAY(2));

    const h1 = createSqliteHistory({ path, clock });
    h1.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('a')]) });

    const h2 = createSqliteHistory({ path, clock });
    expect(readModel(h2, { source: 'shop', valid: DAY(1), known: DAY(2) }).elements.map((e) => e.id)).toEqual(['a']);
  });
});

describe('a store failure comes back as an error value, never thrown, and leaves the history as it was', () => {
  test('an unrecordable model (here, one whose content cannot be turned into JSON) is reported, not thrown', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);

    // A circular reference is not something `parseModel`/`compileModel`
    // could ever produce, but `store` takes an already-compiled model, so
    // this stands in for whatever a database or serialization failure
    // looks like from `store`'s own boundary: something throws partway
    // through, and it must still come back as an error value.
    const broken = element('a') as Record<string, unknown>;
    broken['self'] = broken;

    let thrown: unknown;
    let result: { errors: { message: string }[] } | undefined;
    try {
      result = h.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([broken as unknown as CompiledElement]) });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    expect(result?.errors.length).toBe(1);
    expect(typeof result?.errors[0]?.message).toBe('string');
    expect(result?.errors[0]?.message.length).toBeGreaterThan(0);

    // Nothing was written: the source has no commit at all.
    expect(readModel(h, { source: 'shop', valid: DAY(1), known: DAY(2) }).elements).toEqual([]);
  });
});

describe('idempotent: storing the same commit twice changes nothing', () => {
  test('repeat: the second store is a no-op and every read returns the same', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('a'), element('b')]) });

    const before = readModel(h, { source: 'shop', valid: DAY(1), known: DAY(2) });

    clock.set(DAY(3));
    const result = h.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('a'), element('b')]) });
    expect(result.errors).toEqual([]);

    const after = readModel(h, { source: 'shop', valid: DAY(1), known: DAY(2) });
    expect(after).toEqual(before);
    // Storing again did not even open a new "as we now know it" record: a
    // known time after the repeat still reads the very same thing.
    expect(readModel(h, { source: 'shop', valid: DAY(1), known: DAY(3) })).toEqual(before);
  });
});

describe('order-by-commit: commits are ordered by their time, not by arrival', () => {
  test('late-arrival: an older commit stored after a newer one does not replace it', () => {
    const clock = fakeClock(DAY(11));
    const h = history(clock);
    h.store({ source: 'shop', commit: 'c2', committedAt: DAY(10), model: model([element('billing-api')]) });

    clock.set(DAY(20));
    h.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('legacy-billing')]) });

    const read = readModel(h, { source: 'shop', valid: DAY(12), known: DAY(20) });
    expect(read.elements.map((e) => e.id)).toEqual(['billing-api']);
  });

  test('the late-arriving commit is recorded so reads between the two commits return it', () => {
    const clock = fakeClock(DAY(11));
    const h = history(clock);
    h.store({ source: 'shop', commit: 'c2', committedAt: DAY(10), model: model([element('billing-api')]) });

    clock.set(DAY(20));
    h.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('legacy-billing')]) });

    const between = readModel(h, { source: 'shop', valid: DAY(5), known: DAY(20) });
    expect(between.elements.map((e) => e.id)).toEqual(['legacy-billing']);
  });
});

describe('lossless: what is stored reads back as compiled', () => {
  test('round-trip: the reference example, stored and read back at its commit\'s time, equals the compiled model', () => {
    const { model: compiled, errors } = loadAndCompileModel(fixture('reference-example'));
    expect(errors).toEqual([]);
    expect(compiled).toBeDefined();

    const clock = fakeClock(DAY(2));
    const h = history(clock);
    const result = h.store({ source: 'reference', commit: 'c1', committedAt: DAY(1), model: compiled! });
    expect(result.errors).toEqual([]);

    const readBack = readModel(h, { source: 'reference', valid: DAY(1), known: DAY(2) });
    expect(serializeCompiledModel(readBack)).toEqual(serializeCompiledModel(compiled!));
  });
});

describe('performance: storing a new version of a 10 000-element model', () => {
  test.skipIf(process.env['MADARCH_SKIP_PERF'] !== undefined)('stores in reasonable time', () => {
    const elements: CompiledElement[] = [];
    for (let i = 0; i < 10000; i++) elements.push(element(`e${i}`));
    const relations: CompiledRelation[] = [];
    for (let i = 1; i < 10000; i++) relations.push(relation(`r${i}`, `e${i}`, `e${(i * 7) % 10000}`));
    const big = model(elements, relations);

    const clock = fakeClock(DAY(2));
    const h = history(clock);

    const started = performance.now();
    const result = h.store({ source: 'big', commit: 'c1', committedAt: DAY(1), model: big });
    const elapsed = performance.now() - started;

    expect(result.errors).toEqual([]);
    if (process.env['CI']) {
      // eslint-disable-next-line no-console
      console.log(`storing a 10 000-element model: ${Math.round(elapsed)}ms`);
    } else {
      expect(elapsed).toBeLessThan(5000);
    }
  });
});
