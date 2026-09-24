import { describe, expect, test } from 'bun:test';
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

    const read = h.read({ source: 'shop', valid: DAY(1), known: DAY(2) });
    expect(read.elements.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  test('nothing is returned before the commit\'s valid time', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('a')]) });

    expect(h.read({ source: 'shop', valid: DAY(1) - 1, known: DAY(2) }).elements).toEqual([]);
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

    const before = h.read({ source: 'shop', valid: DAY(5), known: DAY(12) });
    expect(before.elements.map((e) => e.id).sort()).toEqual(['checkout-web', 'legacy-billing']);

    const after = h.read({ source: 'shop', valid: DAY(12), known: DAY(12) });
    expect(after.elements.map((e) => e.id)).toEqual(['checkout-web']);
  });

  test('what-we-knew: read at a known time before the removal was recorded still shows the removed element', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    storeTwoVersions(clock, h);

    // As of 12 September (valid), the history knew, on 3 September, only
    // what c1 said — c2 (which removes legacy-billing) was not recorded
    // until 11 September.
    const asKnownEarly = h.read({ source: 'shop', valid: DAY(12), known: DAY(3) });
    expect(asKnownEarly.elements.map((e) => e.id).sort()).toEqual(['checkout-web', 'legacy-billing']);
  });

  test('an element unchanged across the two versions is left exactly as it was, not closed and reopened', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    storeTwoVersions(clock, h);

    // checkout-web survives both versions: reading it as of any time from
    // c1's onward, known now, finds the same one assertion of it.
    const atC1 = h.read({ source: 'shop', valid: DAY(1), known: DAY(20) }).elements.find((e) => e.id === 'checkout-web');
    const atC2 = h.read({ source: 'shop', valid: DAY(10), known: DAY(20) }).elements.find((e) => e.id === 'checkout-web');
    expect(atC1).toEqual(atC2);
  });
});

describe('idempotent: storing the same commit twice changes nothing', () => {
  test('repeat: the second store is a no-op and every read returns the same', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('a'), element('b')]) });

    const before = h.read({ source: 'shop', valid: DAY(1), known: DAY(2) });

    clock.set(DAY(3));
    const result = h.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('a'), element('b')]) });
    expect(result.errors).toEqual([]);

    const after = h.read({ source: 'shop', valid: DAY(1), known: DAY(2) });
    expect(after).toEqual(before);
    // Storing again did not even open a new "as we now know it" record: a
    // known time after the repeat still reads the very same thing.
    expect(h.read({ source: 'shop', valid: DAY(1), known: DAY(3) })).toEqual(before);
  });
});

describe('order-by-commit: commits are ordered by their time, not by arrival', () => {
  test('late-arrival: an older commit stored after a newer one does not replace it', () => {
    const clock = fakeClock(DAY(11));
    const h = history(clock);
    h.store({ source: 'shop', commit: 'c2', committedAt: DAY(10), model: model([element('billing-api')]) });

    clock.set(DAY(20));
    h.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('legacy-billing')]) });

    const read = h.read({ source: 'shop', valid: DAY(12), known: DAY(20) });
    expect(read.elements.map((e) => e.id)).toEqual(['billing-api']);
  });

  test('the late-arriving commit is recorded so reads between the two commits return it', () => {
    const clock = fakeClock(DAY(11));
    const h = history(clock);
    h.store({ source: 'shop', commit: 'c2', committedAt: DAY(10), model: model([element('billing-api')]) });

    clock.set(DAY(20));
    h.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('legacy-billing')]) });

    const between = h.read({ source: 'shop', valid: DAY(5), known: DAY(20) });
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

    const readBack = h.read({ source: 'reference', valid: DAY(1), known: DAY(2) });
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
