import { describe, expect, test } from 'bun:test';
import { type Clock, type CompiledElement, type CompiledModel, type HistoryStore } from './api.js';
import { createTestDatabaseOwner, createTestHistory } from './test-database.js';
import { createHistoryStore } from '../src/adapters/sql-history.js';
import { TEST_SOURCE_UID } from './write-capability-fixture.js';
import { requireWriteCapability } from '../src/graph/write.js';

/**
 * Replays `store()`'s own `opened`/`closed` report as a literal patch —
 * `closed` removes exactly the row it names (by source, kind, id,
 * `validFrom`), `opened` adds exactly the row it names — over long random
 * sequences of commits from two sources, and checks the replayed state
 * equals `assertions()`'s own currently-open rows (`recordedTo === null`)
 * after every single store. This is `store()`'s own contract for a caller
 * keeping a derived index in step (the `rebuild`/`update` requirement the
 * query engine relies on): if the report ever under- or over-reports what
 * changed, a derived index built from it alone would drift from the history
 * it is meant to mirror.
 */
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

function model(elements: CompiledElement[], zones: { id: string; kind: string }[] = []): CompiledModel {
  return { schemaVersion: 1, elements, interfaces: [], relations: [], categories: [], entities: [], scenarios: [], zones, environments: [], states: [{ id: 'as-is' }] };
}

/** A tiny seeded PRNG (LCG): deterministic across runs, no external dependency. */
function seededRandom(seed: number): { next(): number; int(bound: number): number } {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  return { next, int: (bound: number) => Math.floor(next() * bound) };
}

const key = (a: { source: string; kind: string; id: string; validFrom: number }) => [a.source, a.kind, a.id, a.validFrom].join('\u0000');

describe('the repository test: store()\'s change report replays into exactly assertions() (a literal patch)', () => {
  test('over 20 random seeds, each driving up to 3000 stores across two sources, the replayed set of currently-open rows matches assertions() after every store', async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rnd = seededRandom(seed);
      const clock = fakeClock(100_000);
      const h: HistoryStore = await createTestHistory({ clock });

      // The replay: a plain map, patched only from `store()`'s own report —
      // never read from `h` directly — keyed so a literal `closed` remove and
      // a literal `opened` add can never collide within one source/kind/id.
      const replayed = new Map<string, string>(); // key -> `${content}|${validTo}`

      for (let i = 0; i < 150; i++) {
        const source = ['s', 'p'][rnd.int(2)]!;
        const elements: CompiledElement[] = [];
        for (const id of ['A', 'B', 'C']) {
          if (rnd.next() < 0.6) elements.push(element(source + id, rnd.next() < 0.5 ? {} : { technology: `t${rnd.int(2)}` }));
        }
        const zones = rnd.next() < 0.5 ? [{ id: 'pci', kind: `k${rnd.int(2)}` }] : [];

        clock.set(100_000 + i * 10);
        const result = await h.store({
          source,
          commit: `c${rnd.int(50)}_${i}`,
          committedAt: 1000 * (1 + rnd.int(5)),
          model: model(elements, zones),
        });
        expect(result.errors).toEqual([]);

        for (const change of result.closed) replayed.delete(key(change));
        for (const change of result.opened) replayed.set(key(change), `${change.content}|${change.validTo}`);

        const truth = new Map((await h.assertions()).filter((a) => a.recordedTo === null).map((a) => [key(a), `${a.content}|${a.validTo}`]));
        expect(replayed.size).toBe(truth.size);
        for (const [k, v] of truth) expect(replayed.get(k)).toBe(v);
      }

      await h.close();
    }
  }, 60_000);
});


test('plain history writes do not bind graph sources while graph fixture writes still do', async () => {
  const owner = await createTestDatabaseOwner({ authenticated: false });
  const history = createHistoryStore({ owner, clock: fakeClock(100_000) });
  const countAssertions = async () => (await owner.run(tx => tx.query<{ count: string }>('SELECT count(*)::text AS count FROM assertion'))).rows[0]!.count;
  try {
    await owner.transaction('write', async tx => {
      expect(() => requireWriteCapability(tx)).toThrow('AUTH_REQUIRED');
    });
    const before = await countAssertions();
    const result = await history.store({ source: 'fixture', commit: 'first', committedAt: 1000, model: model([element('A')]) });
    expect(result.errors).toEqual([]);
    expect(result.opened.map(row => [row.kind, row.id])).toEqual([['element', 'A'], ['state', 'as-is']]);
    expect(await countAssertions()).toBe(before);
    const graphSources = await owner.run(tx => tx.query<{ count: string }>('SELECT count(*)::text AS count FROM node WHERE uid=$1::uuid', [TEST_SOURCE_UID]));
    expect(graphSources.rows[0]!.count).toBe('0');
  } finally {
    await history.close();
    await owner.close();
  }
  const graph = await createTestDatabaseOwner();
  try {
    await graph.transaction('write', async tx => {
      const source = await tx.query<{ count: string }>('SELECT count(*)::text AS count FROM node WHERE uid=$1::uuid', [TEST_SOURCE_UID]);
      expect(source.rows[0]!.count).toBe('1');
    });
  } finally { await graph.close(); }
});
