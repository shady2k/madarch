import { describe, expect, test } from 'bun:test';
import { createLadybugEngine, createSqliteHistory, type AssertionRecord, type Clock, type CompiledElement, type CompiledModel, type CompiledRelation, type ElementKind } from '../src/index.js';

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

/**
 * B2's own realistic-graph fixture (stage3-fixes.md): 10 000 elements and
 * 30 000 relations, random and unstructured enough to contain cycles — the
 * shape that made a plain `*1..N` variable-length Cypher pattern enumerate
 * every walk instead of every shortest one and exhaust the buffer pool
 * outright (the review's e6/e7 experiments, tried and confirmed) before
 * B2's `SHORTEST` fix.
 */
// The `v1`/`v2` calls below reseed identically on purpose (same topology,
// only `technology` differs), so a BFS oracle built from either version's
// relations answers for both — see the test's own oracle below.
//
// `from` and `to` are drawn from two independent LCG streams, not the same
// stream called twice in a row: a single stream's own consecutive outputs
// from this generator are not independent draws (Marsaglia's theorem — a
// linear congruential generator's successive outputs fall on a small
// number of hyperplanes when taken as tuples), so calling it twice per
// relation systematically under- or over-represents some `(from, to)`
// pairs relative to a true uniform-random graph, which can shrink or
// distort the transitive answer's own reachable set in a way that does not
// reflect a realistic graph (the review's own finding). Two separate
// streams have no such joint structure to correlate.
function randomGraphWithHistory(technology: string): CompiledModel {
  const elements: CompiledElement[] = [];
  for (let i = 0; i < 10_000; i++) elements.push({ ...element(`e${i}`, 'service'), technology });
  const relations: CompiledRelation[] = [];
  let seedFrom = 11;
  let seedTo = 97;
  const rndFrom = () => {
    seedFrom = (seedFrom * 1103515245 + 12345) % 2147483648;
    return seedFrom / 2147483648;
  };
  const rndTo = () => {
    seedTo = (seedTo * 1103515245 + 12345) % 2147483648;
    return seedTo / 2147483648;
  };
  for (let i = 0; i < 30_000; i++) {
    const from = Math.floor(rndFrom() * 10_000);
    const to = Math.floor(rndTo() * 10_000);
    if (from === to) continue;
    relations.push(relation(`r${i}`, `e${from}`, `e${to}`));
  }
  return model(elements, relations);
}

/**
 * A plain breadth-first count of `id`'s transitive dependents over
 * `relations` (`to` -> `from`, the same direction `dependents` walks), up
 * to the engine's own default hop ceiling (`MAX_HOPS_CEILING`, 30 — see
 * `ladybug-engine.ts`), as an oracle independent of the engine's own
 * Cypher: the performance assertion below compares the engine's answer
 * size against this rather than only asserting it is non-empty, so a
 * query that silently returned a far smaller set (e.g. capped by an
 * accidental hop or row limit) would still be caught even though it
 * technically "answers in under one second".
 */
function bfsDependentCount(id: string, relations: readonly CompiledRelation[]): number {
  const incoming = new Map<string, string[]>();
  for (const r of relations) incoming.set(r.to, [...(incoming.get(r.to) ?? []), r.from]);
  const seen = new Set<string>([id]);
  let frontier = [id];
  for (let hop = 1; hop <= 30 && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const x of frontier) {
      for (const y of incoming.get(x) ?? []) {
        if (!seen.has(y)) {
          seen.add(y);
          next.push(y);
        }
      }
    }
    frontier = next;
  }
  seen.delete(id);
  return seen.size;
}

describe('performance: B2 — transitive dependents over a random 10 000-element, 30 000-relation graph with history, default maxHops', () => {
  test.skipIf(process.env['MADARCH_SKIP_PERF'] !== undefined)(
    'answers in under one second',
    () => {
      const clock = fakeClock(DAY(2));
      const history = createSqliteHistory({ clock });
      const v1 = randomGraphWithHistory('v1');
      expect(history.store({ source: 'big', commit: 'v1', committedAt: DAY(1), model: v1 }).errors).toEqual([]);
      clock.set(DAY(12));
      expect(history.store({ source: 'big', commit: 'v2', committedAt: DAY(10), model: randomGraphWithHistory('v2') }).errors).toEqual([]);

      const engine = createLadybugEngine();
      engine.rebuild(history.assertions());
      const at = { valid: DAY(11), known: DAY(20), state: 'as-is' };

      const started = performance.now();
      const result = engine.dependents('e0', { transitive: true }, at);
      const elapsed = performance.now() - started;
      expect(result.error).toBeUndefined();
      // No element ever lists itself as its own dependent (B2's cycle rule).
      expect(result.elements?.some((e) => e.id === 'e0')).toBe(false);
      // The transitive answer's size against a plain BFS oracle (v1 and v2
      // reseed identically, so either's relations serve as the oracle for
      // the time asked): a random 10 000/30 000 graph reaches a large
      // fraction of the graph from any one node within 30 hops, so this
      // also guards against a query that silently answered with a far
      // smaller, wrongly pruned set instead of a genuinely empty or tiny
      // reachable set (the review's own concern about the fixture itself).
      expect(result.elements?.length).toBe(bfsDependentCount('e0', v1.relations));

      if (process.env['CI']) {
        // eslint-disable-next-line no-console
        console.log(`B2 transitive dependents over 10 000 elements / 30 000 relations with history: ${Math.round(elapsed)}ms, ${result.elements?.length} elements`);
      } else {
        expect(elapsed).toBeLessThan(1000);
      }

      engine.close();
      history.close();
    },
    // Building this fixture (store, rebuild) is not part of the performance
    // requirement (only the measured `dependents` call is — see the assert
    // above), but at 10 000 elements and 30 000 relations across two
    // versions it takes real wall time on its own, well past bun's default
    // 5-second per-test timeout, the same reason the view/transitive test
    // below gives itself a generous timeout of its own.
    90000,
  );
});

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

/**
 * A layered graph from `start`, `w` elements wide, `L` layers deep: `start`
 * connects to every element of layer 0; each element of layer `l` connects
 * to `kk` elements of layer `l + 1` (every element of it, a "complete"
 * layer, when `kk` is left out) — the shape that made a plain `ALL
 * SHORTEST` pattern enumerate every tied shortest path per node instead of
 * one (combinatorial in the layer width even though the node count visited
 * stays small), the review's own e12/e12k experiments, before B2's plain
 * `SHORTEST` fix.
 */
function layeredGraph(w: number, layers: number, kk?: number): { model: CompiledModel; relationCount: number } {
  const elements: CompiledElement[] = [element('start', 'service')];
  for (let l = 0; l < layers; l++) for (let i = 0; i < w; i++) elements.push(element(`n${l}_${i}`, 'service'));
  const relations: CompiledRelation[] = [];
  let k = 0;
  for (let i = 0; i < w; i++) relations.push(relation(`r${k++}`, 'start', `n0_${i}`));
  if (kk === undefined) {
    for (let l = 0; l < layers - 1; l++) for (let i = 0; i < w; i++) for (let j = 0; j < w; j++) relations.push(relation(`r${k++}`, `n${l}_${i}`, `n${l + 1}_${j}`));
  } else {
    let seed = 3;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let l = 0; l < layers - 1; l++) {
      for (let i = 0; i < w; i++) {
        for (let jj = 0; jj < kk; jj++) {
          const j = Math.floor(rnd() * w);
          relations.push(relation(`r${k++}`, `n${l}_${i}`, `n${l + 1}_${j}`));
        }
      }
    }
  }
  return { model: model(elements, relations), relationCount: relations.length };
}

describe('performance: B2 — the review\'s layered-graph shapes that made ALL SHORTEST combinatorial, now answering under plain SHORTEST', () => {
  const shapes: { name: string; w: number; layers: number; kk?: number }[] = [
    { name: '2 wide x 20 complete layers', w: 2, layers: 20 },
    { name: '8 wide x 7 complete layers', w: 8, layers: 7 },
    { name: '200 wide x 8 layers, 4 out-edges per node', w: 200, layers: 8, kk: 4 },
    { name: '300 wide x 10 layers, 3 out-edges per node', w: 300, layers: 10, kk: 3 },
    { name: '1000 wide x 10 layers, 4 out-edges per node (37 000 relations)', w: 1000, layers: 10, kk: 4 },
  ];

  test.skipIf(process.env['MADARCH_SKIP_PERF'] !== undefined)(
    'transitive dependencies from start answer without error on every shape',
    () => {
      for (const shape of shapes) {
        const { model: shapeModel, relationCount } = layeredGraph(shape.w, shape.layers, shape.kk);
        const engine = createLadybugEngine();
        const assertions: AssertionRecord[] = [
          ...shapeModel.elements.map((e) => ({ source: 's', kind: 'element' as const, id: e.id, content: JSON.stringify(e), validFrom: 0, validTo: null, recordedFrom: 0, recordedTo: null })),
          ...shapeModel.relations.map((r) => ({ source: 's', kind: 'relation' as const, id: r.id, content: JSON.stringify(r), validFrom: 0, validTo: null, recordedFrom: 0, recordedTo: null })),
        ];
        engine.rebuild(assertions);

        const result = engine.dependencies('start', { transitive: true }, { valid: 1, known: 1, state: 'as-is' });
        expect(result.error).toBeUndefined();
        // A plain forward BFS oracle (the same direction `dependencies`
        // walks), independent of the engine's own Cypher — exact coverage
        // on a "complete" layered shape (`kk` left out, every node
        // connects to every node of the next layer), and on a random-tiered
        // one too (a node in layer `l + 1` is only reached when at least
        // one of layer `l`'s `kk`-per-node random draws happens to name
        // it, so full coverage of a wide layer is not guaranteed).
        const outgoing = new Map<string, string[]>();
        for (const r of shapeModel.relations) outgoing.set(r.from, [...(outgoing.get(r.from) ?? []), r.to]);
        const reached = new Set<string>();
        let frontier = ['start'];
        for (let hop = 1; hop <= 30 && frontier.length > 0; hop++) {
          const next: string[] = [];
          for (const x of frontier) for (const y of outgoing.get(x) ?? []) if (y !== 'start' && !reached.has(y)) { reached.add(y); next.push(y); }
          frontier = next;
        }
        expect(result.elements?.length).toBe(reached.size);

        engine.close();
        // eslint-disable-next-line no-console
        if (process.env['CI']) console.log(`layered ${shape.name}: ${shapeModel.elements.length} elements, ${relationCount} relations, ${result.elements?.length} answers`);
      }
    },
    180000,
  );
});
