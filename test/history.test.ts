import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJsonDigest } from '../src/model/canonical.js';
import {
  createSqliteHistory,
  loadAndCompileModel,
  serializeCompiledModel,
  type Clock,
  type CompiledElement,
  type CompiledEntity,
  type CompiledModel,
  type CompiledRelation,
  type CompiledScenario,
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

function entity(id: string, extra: Partial<CompiledEntity> = {}): CompiledEntity {
  return { id, categories: [], ...extra };
}

function scenario(id: string, extra: Partial<CompiledScenario> = {}): CompiledScenario {
  return { id, steps: [], requirements: [], ...extra };
}

function model(
  elements: CompiledElement[],
  relations: CompiledRelation[] = [],
  extra: Partial<Pick<CompiledModel, 'entities' | 'scenarios'>> = {},
): CompiledModel {
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
    ...extra,
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
  test('a repeated commit with another time and model reports both differences', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('a')]) });

    const result = h.store({ source: 'shop', commit: 'c1', committedAt: DAY(3), model: model([element('b')]) });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain('different commit time');
    expect(result.errors[0]?.message).toContain(canonicalJsonDigest(model([element('a')])));
    expect(result.errors[0]?.message).toContain(canonicalJsonDigest(model([element('b')])));
    h.close();
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

describe('commits: every commit of one source, in the history\'s own commit order', () => {
  test('commits are listed with their times and storing moments, oldest first', () => {
    const clock = fakeClock(DAY(10));
    const h = history(clock);
    h.store({ source: 'shop', commit: 'c9', committedAt: DAY(2), model: model([element('a')]) });

    clock.set(DAY(11));
    h.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('b')]) });

    clock.set(DAY(12));
    h.store({ source: 'other', commit: 'o1', committedAt: DAY(3), model: model([element('c')]) });

    expect(h.commits('shop')).toEqual([
      { commit: 'c1', committedAt: DAY(1), storedAt: DAY(11), canonicalDigest: canonicalJsonDigest(model([element('b')])) },
      { commit: 'c9', committedAt: DAY(2), storedAt: DAY(10), canonicalDigest: canonicalJsonDigest(model([element('a')])) },
    ]);
    expect(h.commits('other')).toEqual([{ commit: 'o1', committedAt: DAY(3), storedAt: DAY(12), canonicalDigest: canonicalJsonDigest(model([element('c')])) }]);
    expect(h.commits('never-sent')).toEqual([]);
    h.close();
  });

  test('commits at the same time are ordered by the commit id', () => {
    const clock = fakeClock(DAY(10));
    const h = history(clock);
    h.store({ source: 'shop', commit: 'zzz', committedAt: DAY(1), model: model([element('a')]) });
    h.store({ source: 'shop', commit: 'aaa', committedAt: DAY(1), model: model([element('b')]) });

    expect(h.commits('shop').map((each) => each.commit)).toEqual(['aaa', 'zzz']);
    h.close();
  });

  test('commitRecord exposes the canonical digest stored beside each commit', () => {
    const clock = fakeClock(DAY(10));
    const h = history(clock);
    const storedModel = model([element('a')]);
    h.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: storedModel });

    expect(h.commitRecord('shop', 'c1')?.canonicalDigest).toBe(canonicalJsonDigest(storedModel));
    expect(h.commits('shop')[0]?.canonicalDigest).toBe(canonicalJsonDigest(storedModel));
    h.close();
  });

  test('opening a legacy history with commits refuses when its canonical digest cannot be reconstructed faithfully', () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-legacy-history-'));
    const path = join(folder, 'history.sqlite');
    try {
      const db = new Database(path);
      db.run(`CREATE TABLE source_commits (
        source TEXT NOT NULL,
        commit_id TEXT NOT NULL,
        committed_at INTEGER NOT NULL,
        content_digest TEXT NOT NULL,
        recorded_at INTEGER NOT NULL,
        PRIMARY KEY (source, commit_id)
      )`);
      db.query('INSERT INTO source_commits VALUES (?, ?, ?, ?, ?)').run('shop', 'legacy-c1', DAY(1), 'old-content-digest', DAY(2));
      db.close();

      expect(() => createSqliteHistory({ path, clock: fakeClock(DAY(10)) })).toThrow(/history\.sqlite.*legacy-c1.*shop.*cannot faithfully recover/i);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("commitRecord reads one commit's own row, or says the source never stored it", () => {
    const clock = fakeClock(DAY(10));
    const h = history(clock);
    h.store({ source: 'shop', commit: 'c9', committedAt: DAY(2), model: model([element('a')]) });

    clock.set(DAY(11));
    h.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('b')]) });

    expect(h.commitRecord('shop', 'c1')).toEqual({
      commit: 'c1',
      committedAt: DAY(1),
      storedAt: DAY(11),
      canonicalDigest: canonicalJsonDigest(model([element('b')])),
    });
    expect(h.commitRecord('shop', 'never-stored')).toBeUndefined();
    expect(h.commitRecord('never-sent', 'c1')).toBeUndefined();
    h.close();
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

  test('round-trip: data entities and scenarios, stored and read back at their commit\'s time, equal the compiled model (madarch-hnq.1.4)', () => {
    const { model: compiled, errors } = loadAndCompileModel(fixture('entities-and-scenarios'));
    expect(errors).toEqual([]);
    expect(compiled?.entities.map((e) => e.id)).toEqual(['order-number', 'user-name']);
    expect(compiled?.scenarios.map((s) => s.id)).toEqual(['order-fails', 'place-order']);

    const clock = fakeClock(DAY(2));
    const h = history(clock);
    const result = h.store({ source: 'reference', commit: 'c1', committedAt: DAY(1), model: compiled! });
    expect(result.errors).toEqual([]);

    // Stored assertions exist for every kind, not only the seven the
    // history knew before: an entity and a scenario are each one assertion
    // of their source, closed and reopened like any other.
    const kinds = new Set(h.assertions({ source: 'reference' }).map((row) => row.kind));
    expect(kinds.has('entity')).toBe(true);
    expect(kinds.has('scenario')).toBe(true);

    const readBack = readModel(h, { source: 'reference', valid: DAY(1), known: DAY(2) });
    expect(serializeCompiledModel(readBack)).toEqual(serializeCompiledModel(compiled!));
  });

  test('the union read carries entities and scenarios beside the seven kinds, sorted by id', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({
      source: 'shop',
      commit: 'c1',
      committedAt: DAY(1),
      model: model(
        [element('a')],
        [relation('r1', 'a', 'a')],
        { entities: [entity('z-entity'), entity('a-entity')], scenarios: [scenario('z-scenario', { steps: [{ id: 's1', relation: 'r1' }] }), scenario('a-scenario')] },
      ),
    });

    const union = readModel(h, { valid: DAY(1), known: DAY(2) });
    expect(union.entities.map((e) => e.id)).toEqual(['a-entity', 'z-entity']);
    expect(union.scenarios.map((s) => s.id)).toEqual(['a-scenario', 'z-scenario']);
    expect(serializeCompiledModel(union)).toBe(serializeCompiledModel(readModel(h, { source: 'shop', valid: DAY(1), known: DAY(2) })));
  });

  test('a newer commit replaces the entities and scenarios the source asserted, like every other kind', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    const relations = [relation('r1', 'a', 'a')];
    h.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('a')], relations, { entities: [entity('gone')], scenarios: [scenario('gone-too')] }) });
    clock.set(DAY(11));
    h.store({ source: 'shop', commit: 'c2', committedAt: DAY(10), model: model([element('a')], relations, { entities: [entity('kept', { name: 'Kept' })] }) });

    // As of c1's time: everything it asserted.
    const before = readModel(h, { source: 'shop', valid: DAY(5), known: DAY(11) });
    expect(before.entities.map((e) => e.id)).toEqual(['gone']);
    expect(before.scenarios.map((s) => s.id)).toEqual(['gone-too']);

    // As of c2's time: the removed entity and scenario are gone, the kept
    // one is there, and nothing lingers from c1.
    const after = readModel(h, { source: 'shop', valid: DAY(12), known: DAY(11) });
    expect(after.entities).toEqual([{ id: 'kept', categories: [], name: 'Kept' }]);
    expect(after.scenarios).toEqual([]);
    // The kept entity lost its scenario: an empty array, always present,
    // never a missing key.
    expect(Object.hasOwn(after, 'scenarios')).toBe(true);

    // As of c2's time but known before c2 was recorded: c1's view stands.
    const asKnownEarly = readModel(h, { source: 'shop', valid: DAY(12), known: DAY(3) });
    expect(asKnownEarly.entities.map((e) => e.id)).toEqual(['gone']);
    expect(asKnownEarly.scenarios.map((s) => s.id)).toEqual(['gone-too']);
  });

  test('entities and scenarios are each one source\'s exclusive claim: a second source redeclaring an id is refused, naming the id and the other source', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    h.store({ source: 'payments', commit: 'p1', committedAt: DAY(1), model: model([element('x')], [], { entities: [entity('session-id')], scenarios: [scenario('place-order')] }) });

    const refusedEntity = h.store({ source: 'shop', commit: 's1', committedAt: DAY(1), model: model([element('y')], [], { entities: [entity('session-id')] }) });
    expect(refusedEntity.errors).toEqual([{ message: expect.any(String), id: 'session-id', source: 'payments' }]);
    expect(refusedEntity.errors[0]?.message).toContain('already declared by source "payments"');

    const refusedScenario = h.store({ source: 'shop', commit: 's1', committedAt: DAY(1), model: model([element('y')], [], { scenarios: [scenario('place-order')] }) });
    expect(refusedScenario.errors).toEqual([{ message: expect.any(String), id: 'place-order', source: 'payments' }]);
    expect(refusedScenario.errors[0]?.message).toContain('already declared by source "payments"');

    // A source declaring its own entity and scenario ids stores fine, and
    // a store of an id the other source no longer declares succeeds too.
    const accepted = h.store({ source: 'shop', commit: 's1', committedAt: DAY(1), model: model([element('y')], [], { entities: [entity('cart-id')], scenarios: [scenario('checkout')] }) });
    expect(accepted.errors).toEqual([]);

    clock.set(DAY(11));
    h.store({ source: 'payments', commit: 'p2', committedAt: DAY(10), model: model([element('x')]) });
    const nowFree = h.store({ source: 'shop', commit: 's2', committedAt: DAY(10), model: model([element('y')], [], { entities: [entity('session-id')] }) });
    expect(nowFree.errors).toEqual([]);
  });

  test('the exclusive-kind safety net reports an entity or scenario id two sources claim, like the other clashable kinds (data written outside store())', () => {
    const dir = mkdtempSync(join(tmpdir(), 'madarch-hnq14-'));
    const path = join(dir, 'history.sqlite');
    try {
      createSqliteHistory({ clock: fakeClock(DAY(2)), path }).close();
      const raw = new Database(path);
      const insert = raw.query(
        `INSERT INTO assertions (source, kind, entity_id, content, valid_from, valid_to, opened_by, closed_by, recorded_from, recorded_to)
         VALUES (?, ?, ?, ?, ?, NULL, 'c1', NULL, ?, NULL)`,
      );
      for (const kind of ['entity', 'scenario'] as const) {
        insert.run('a', kind, 'x', JSON.stringify({ id: 'x', v: 'A' }), DAY(1), DAY(1));
        insert.run('b', kind, 'x', JSON.stringify({ id: 'x', v: 'B' }), DAY(1), DAY(1));
      }
      raw.close();

      const h = createSqliteHistory({ clock: fakeClock(DAY(2)), path });
      const result = h.read({ valid: DAY(2), known: DAY(2) });
      expect(result.model).toBeUndefined();
      expect(result.errors).toEqual([
        { message: expect.any(String), id: 'x', field: 'entity', source: expect.any(String) },
        { message: expect.any(String), id: 'x', field: 'scenario', source: expect.any(String) },
      ]);
      for (const error of result.errors) expect(error.message).toContain('declared differently across sources');
      h.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('idempotent: storing the same model with entities and scenarios twice changes nothing, and its rows match assertions()', () => {
    const clock = fakeClock(DAY(2));
    const h = history(clock);
    const withBoth = model([element('a')], [relation('r1', 'a', 'a')], {
      entities: [entity('session-id', { name: 'Session id' })],
      scenarios: [scenario('place-order', { steps: [{ id: 's1', relation: 'r1' }], requirements: ['ordering/place-order'] })],
    });
    h.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: withBoth });

    const before = h.assertions();
    const readBefore = readModel(h, { source: 'shop', valid: DAY(1), known: DAY(2) });

    clock.set(DAY(3));
    const repeat = h.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: withBoth });
    expect(repeat.errors).toEqual([]);
    expect(repeat.opened).toEqual([]);
    expect(repeat.closed).toEqual([]);
    expect(h.assertions()).toEqual(before);
    expect(readModel(h, { source: 'shop', valid: DAY(1), known: DAY(3) })).toEqual(readBefore);
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
