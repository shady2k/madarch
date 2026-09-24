import { describe, expect, test } from 'bun:test';
import { createLadybugEngine, createSqliteHistory, type Clock, type CompiledElement, type CompiledModel, type CompiledRelation, type ElementKind } from '../src/index.js';

/**
 * Performance requirement (graph-queries.md's "Quality requirements"): a
 * view or a transitive query over a graph of 10 000 elements *with
 * history* answers in under one second. Skipped when `MADARCH_SKIP_PERF` is
 * set (mirrors `test/history.test.ts`'s own performance test); under CI the
 * measured time is logged rather than asserted, matching that same
 * pattern, since decision 0009 left the bound to be measured, not assumed.
 */

const DAY = (day: number) => Date.UTC(2026, 8, day);

function fakeClock(initial: number): Clock & { set(t: number): void } {
  let current = initial;
  return { now: () => current, set: (t: number) => (current = t) };
}

function element(id: string, kind: ElementKind, parent?: string): CompiledElement {
  const compiled: CompiledElement = { id, kind, ancestors: parent === undefined ? [] : [parent], zones: [], zonesByEnvironment: {}, environments: ['*'], states: ['as-is'] };
  if (parent !== undefined) compiled.parent = parent;
  return compiled;
}

function relation(id: string, from: string, to: string): CompiledRelation {
  return { id, from, to, interaction: false, environments: ['*'], states: ['as-is'] };
}

function model(elements: CompiledElement[], relations: CompiledRelation[]): CompiledModel {
  return { schemaVersion: 1, elements, interfaces: [], relations, categories: [], zones: [], environments: [], states: [{ id: 'as-is' }] };
}

/** 100 services, each with 99 modules: exactly 10 000 elements. */
function bigModel(technology: string): CompiledModel {
  const elements: CompiledElement[] = [];
  const relations: CompiledRelation[] = [];
  for (let s = 0; s < 100; s++) {
    const serviceId = `service${s}`;
    elements.push({ ...element(serviceId, 'service'), technology });
    for (let m = 0; m < 99; m++) elements.push(element(`service${s}-module${m}`, 'module', serviceId));
  }
  // A chain across 30 services (the engine's own hop ceiling), for the transitive query.
  for (let s = 0; s < 29; s++) relations.push(relation(`chain${s}`, `service${s}`, `service${s + 1}`));
  // ~3000 cross-service relations between modules, for the view's collapsing.
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = 0; i < 3000; i++) {
    const fromService = Math.floor(rnd() * 100);
    const toService = Math.floor(rnd() * 100);
    if (fromService === toService) continue;
    relations.push(relation(`cross${i}`, `service${fromService}-module${Math.floor(rnd() * 99)}`, `service${toService}-module${Math.floor(rnd() * 99)}`));
  }
  return model(elements, relations);
}

describe('performance: a view and a transitive query over 10 000 elements with history', () => {
  // Only the two measured calls (`view`, `dependents`) are held to the one-
  // second bound below; building the 10 000-element fixture (`store`,
  // `rebuild`) is not part of the performance requirement, but still needs
  // more than bun's default 5-second per-test timeout to finish at this
  // size, so this test is given a generous one of its own.
  test.skipIf(process.env['MADARCH_SKIP_PERF'] !== undefined)(
    'both answer in under one second',
    () => {
    const clock = fakeClock(DAY(2));
    const history = createSqliteHistory({ clock });
    // Two versions, so the history — and so the engine, built from its full
    // `assertions()` — carries real history, not only the current state.
    expect(history.store({ source: 'big', commit: 'v1', committedAt: DAY(1), model: bigModel('v1') }).errors).toEqual([]);
    clock.set(DAY(12));
    expect(history.store({ source: 'big', commit: 'v2', committedAt: DAY(10), model: bigModel('v2') }).errors).toEqual([]);

    const engine = createLadybugEngine();
    engine.rebuild(history.assertions());

    const at = { valid: DAY(11), known: DAY(20), state: 'as-is' };

    const viewStarted = performance.now();
    const viewResult = engine.view({ depth: 0 }, at);
    const viewElapsed = performance.now() - viewStarted;
    expect(viewResult.error).toBeUndefined();
    expect(viewResult.elements?.length).toBe(100);

    const transitiveStarted = performance.now();
    const transitiveResult = engine.dependents('service29', { transitive: true }, at);
    const transitiveElapsed = performance.now() - transitiveStarted;
    expect(transitiveResult.error).toBeUndefined();
    expect(transitiveResult.elements?.length).toBeGreaterThan(0);

    if (process.env['CI']) {
      // eslint-disable-next-line no-console
      console.log(`view over 10 000 elements with history: ${Math.round(viewElapsed)}ms; transitive query: ${Math.round(transitiveElapsed)}ms`);
    } else {
      expect(viewElapsed).toBeLessThan(1000);
      expect(transitiveElapsed).toBeLessThan(1000);
    }

    engine.close();
    history.close();
    },
    30000,
  );
});
