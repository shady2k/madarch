import { describe, expect, test } from 'bun:test';
import {
  createLadybugEngine,
  createSqliteHistory,
  type Clock,
  type CompiledElement,
  type CompiledModel,
  type CompiledRelation,
} from '../src/index.js';

/**
 * M1's own repository test (stage3-fixes.md): over seeded random sequences
 * of two sources' commits, including late and same-time commits, an engine
 * kept in step through `update()` after every `store()` must answer exactly
 * like an engine thrown away and rebuilt from the same history's
 * `assertions()`, at many `(valid, known)` pairs — earlier known times
 * included, since a `known` time before a later commit closed a row must
 * still see it (the very axis `update()` used to drop by deleting a closed
 * row outright instead of closing it — see `ladybug-engine.ts`'s own doc).
 * `history.read()` is the independent oracle neither engine is built from
 * directly.
 */

function fakeClock(initial: number): Clock & { set(t: number): void } {
  let current = initial;
  return { now: () => current, set: (t: number) => (current = t) };
}

function seededRandom(seed: number): { next(): number; int(bound: number): number } {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  return { next, int: (bound: number) => Math.floor(next() * bound) };
}

function element(id: string, parent: string | undefined, extra: Partial<CompiledElement> = {}): CompiledElement {
  const compiled: CompiledElement = { id, kind: 'service', ancestors: parent === undefined ? [] : [parent], zones: [], zonesByEnvironment: {}, environments: ['*'], states: ['as-is'], ...extra };
  if (parent !== undefined) compiled.parent = parent;
  return compiled;
}

function relation(id: string, from: string, to: string): CompiledRelation {
  return { id, from, to, interaction: false, environments: ['*'], states: ['as-is'] };
}

function model(elements: CompiledElement[], relations: CompiledRelation[]): CompiledModel {
  return { schemaVersion: 1, elements, interfaces: [], relations, categories: [], zones: [], environments: [], states: [{ id: 'as-is' }] };
}

describe('M1: an engine kept in step through update() answers exactly like a rebuilt one, at every known time the history could report', () => {
  test(
    'over 8 seeded random sequences of two sources (with late and same-time commits), children/dependencies agree between update() and rebuild(), and both agree with history.read()',
    () => {
      for (let seed = 1; seed <= 8; seed++) {
        const rnd = seededRandom(seed);
        let now = 100_000;
        const clock = fakeClock(now);
        const history = createSqliteHistory({ clock });
        const updated = createLadybugEngine();
        updated.rebuild([]);

        const storeTimes: number[] = [];
        for (let i = 0; i < 12; i++) {
          const source = ['s', 'p'][rnd.int(2)]!;
          const elements: CompiledElement[] = [];
          const relations: CompiledRelation[] = [];
          if (rnd.next() < 0.8) {
            elements.push(element(`${source}A`, undefined));
            if (rnd.next() < 0.7) elements.push(element(`${source}B`, `${source}A`));
          }
          if (rnd.next() < 0.8) elements.push(element(`${source}C`, undefined));
          const ids = new Set(elements.map((e) => e.id));
          for (const [from, to] of [
            ['A', 'C'],
            ['B', 'C'],
            ['C', 'A'],
          ]) {
            if (ids.has(`${source}${from}`) && ids.has(`${source}${to}`) && rnd.next() < 0.6) relations.push(relation(`${source}${from}${to}`, `${source}${from}`, `${source}${to}`));
          }

          // A same-time commit sometimes, a late one (an earlier
          // committedAt than the clock's own reading) sometimes — both
          // exercise store()'s own recorded-time handling that update()
          // must carry forward faithfully (see AssertionChange's
          // recordedFrom/recordedTo).
          now += 10 * (1 + rnd.int(2));
          clock.set(now);
          storeTimes.push(now);
          const committedAt = 1000 * (1 + rnd.int(5));
          const result = history.store({ source, commit: `c${i}`, committedAt, model: model(elements, relations) });
          expect(result.errors).toEqual([]);
          updated.update(result.opened, result.closed);
        }

        const rebuilt = createLadybugEngine();
        rebuilt.rebuild(history.assertions());

        // Sparse but deliberate sampling: the earliest and latest store
        // moments, one from the middle, and just after/before the whole
        // run, on the known axis — the same shape of coverage the review's
        // own e2 experiment used, kept small enough here to run inside a
        // test's own timeout.
        const knowns = [storeTimes[0]! - 1, storeTimes[0]!, storeTimes[Math.floor(storeTimes.length / 2)]!, storeTimes.at(-1)!, now + 5];
        for (const known of knowns) {
          for (const valid of [500, 1500, 2500, 3500, 4500]) {
            const at = { valid, known, state: 'as-is' };
            const readModel = history.read({ valid, known }).model!;
            const knownElements = new Set(readModel.elements.filter((e) => e.states.includes('as-is')).map((e) => e.id));

            for (const id of ['sA', 'sC', 'pA', 'pC']) {
              const wantChildren = knownElements.has(id) ? readModel.elements.filter((e) => e.parent === id).map((e) => e.id).sort() : undefined;
              const wantDependencies = knownElements.has(id) ? readModel.relations.filter((r) => r.from === id).map((r) => r.to).sort() : undefined;

              for (const engine of [rebuilt, updated]) {
                const children = engine.children(id, at);
                const dependencies = engine.dependencies(id, {}, at);
                if (wantChildren === undefined) {
                  expect(children.error).toBeDefined();
                  expect(dependencies.error).toBeDefined();
                } else {
                  expect(children.elements?.map((e) => e.id).sort()).toEqual(wantChildren);
                  expect(dependencies.elements?.map((e) => e.id).sort()).toEqual(wantDependencies!);
                }
              }
            }
          }
        }

        rebuilt.close();
        updated.close();
        history.close();
      }
    },
    60000,
  );
});
