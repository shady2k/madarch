import { describe, expect, test } from 'bun:test';
import {
  createPGliteDatabaseOwner,
  createPGliteHistory,
  createPGliteQueryDatabase,
  type Clock,
  type CompiledElement,
  type CompiledModel,
} from '../src/index.js';
import { createFillStateSchema, openChain } from '../src/fill/state-store.js';

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

function element(id: string): CompiledElement {
  return { id, kind: 'service', ancestors: [], zones: [], zonesByEnvironment: {}, environments: ['*'], states: ['as-is'] };
}

function model(elements: CompiledElement[]): CompiledModel {
  return {
    schemaVersion: 1,
    elements,
    interfaces: [],
    relations: [],
    categories: [],
    entities: [],
    scenarios: [],
    zones: [],
    environments: [],
    states: [{ id: 'as-is' }],
  };
}

const SOURCE = 'github.com/acme/shop';

/** One owner serving both adapters, as decision 0027 makes the process do. */
async function sharedAdapters() {
  const clock = fakeClock(DAY(2));
  const owner = createPGliteDatabaseOwner({ vector: true });
  const history = createPGliteHistory({ clock, owner });
  const database = await createPGliteQueryDatabase({ owner, clock });
  const engine = database.forSources([SOURCE]);
  return { clock, owner, history, database, engine };
}

describe('one database owner per process', () => {
  test('the history and the query database hold their tables in the one database the owner opened', async () => {
    const { owner, history, database } = await sharedAdapters();
    // Both adapters' tables answering from one connection is what "one
    // owner" means; two databases would each show only its own tables.
    const tables = await owner.run(async (transaction) => {
      const rows = await transaction.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
      );
      return rows.rows.map((row) => row.table_name);
    });
    expect(tables).toEqual(expect.arrayContaining(['assertions', 'source_commits', 'source_registry', 'query_elements', 'query_relations', 'query_states', 'vector_items']));
    await database.close();
    await history.close();
    await owner.close();
  });

  test('one transaction carries a history store and its projection rebuild, both readable inside it and both present after it commits', async () => {
    const { owner, history, database, engine } = await sharedAdapters();
    const commit = { source: SOURCE, commit: 'c1', committedAt: DAY(1), model: model([element('shop'), element('cart')]) };

    await owner.transaction('write', async (transaction) => {
      const stored = await history.store(commit, undefined, transaction);
      expect(stored.errors).toEqual([]);
      // The history reads back its own uncommitted rows through the same
      // transaction, and the projection is rebuilt from exactly those.
      const assertions = await history.assertions({ source: SOURCE }, transaction);
      expect(assertions.filter((assertion) => assertion.kind === 'element').map((assertion) => assertion.id)).toEqual(['cart', 'shop']);
      await engine.rebuild(assertions, transaction);
      // The projection answers from its own uncommitted rebuild: nothing of
      // this transaction is visible outside it yet.
      const inside = await engine.withSnapshot(async (snapshot) => await snapshot.view({ depth: 0 }), transaction);
      expect(inside.elements?.map((each) => each.id)).toEqual(['cart', 'shop']);
    });

    // Outside the transaction both writes are there, from the same commit.
    expect(await history.commits(SOURCE)).toEqual([{ commit: 'c1', committedAt: DAY(1), storedAt: DAY(2), canonicalDigest: expect.any(String) }]);
    const after = await engine.view({ depth: 0 });
    expect(after.elements?.map((each) => each.id)).toEqual(['cart', 'shop']);
    await database.close();
    await history.close();
    await owner.close();
  });

  test('a rolled-back transaction leaves neither the history nor the projection holding its writes', async () => {
    const { owner, history, database, engine } = await sharedAdapters();
    await history.store({ source: SOURCE, commit: 'c1', committedAt: DAY(1), model: model([element('shop'), element('cart')]) });
    await engine.rebuild(await history.assertions({ source: SOURCE }));

    await expect(owner.transaction('write', async (transaction) => {
      const stored = await history.store({ source: SOURCE, commit: 'c2', committedAt: DAY(3), model: model([element('shop')]) }, undefined, transaction);
      expect(stored.errors).toEqual([]);
      await engine.update(stored.opened, stored.closed, transaction);
      // Inside the transaction the removal is visible at the second commit's
      // own time, so the rollback below has something real to undo.
      const inside = await engine.withSnapshot(async (snapshot) => await snapshot.view({ depth: 0 }, { valid: DAY(3), known: DAY(3) }), transaction);
      expect(inside.elements?.map((each) => each.id)).toEqual(['shop']);
      throw new Error('rolled back on purpose');
    })).rejects.toThrow('rolled back on purpose');

    // None of it survives: the second commit is not in the history and the
    // projection still answers the first commit's graph at the second
    // commit's own time, where the removed element would have been gone.
    expect(await history.hasCommit(SOURCE, 'c2')).toBe(false);
    expect((await history.commits(SOURCE)).map((each) => each.commit)).toEqual(['c1']);
    const after = await engine.view({ depth: 0 }, { valid: DAY(3), known: DAY(3) });
    expect(after.elements?.map((each) => each.id)).toEqual(['cart', 'shop']);
    await database.close();
    await history.close();
    await owner.close();
  });

  test("a history failure inside the caller's transaction is thrown to the caller, not reported as a smaller result the caller could commit", async () => {
    const { owner, history, database } = await sharedAdapters();
    // A registry whose names cannot be serialized fails after the store has
    // already written this version's assertion rows: a code failure, not a
    // database abort, and not a refusal (which is decided before any write).
    const circular: string[] = [];
    (circular as unknown as unknown[]).push(circular);
    const input = { source: SOURCE, commit: 'c1', committedAt: DAY(1), model: model([element('shop')]) };
    const registry = { id: 'shop-id', formerNames: circular };

    await expect(owner.transaction('write', async (transaction) => {
      await history.store(input, registry, transaction);
    })).rejects.toThrow(/the history could not be updated inside the caller's transaction/);

    // Nothing of it survived, and an owner of its own still reports the same
    // failure as an error result, because an owner of its own rolled it back.
    expect(await history.hasCommit(SOURCE, 'c1')).toBe(false);
    expect(await history.assertions({ source: SOURCE })).toEqual([]);
    const reported = await history.store(input, registry);
    expect(reported.errors[0]?.message).toMatch(/^the history could not be updated: /);
    expect(await history.hasCommit(SOURCE, 'c1')).toBe(false);
    await database.close();
    await history.close();
    await owner.close();
  });

  test('a transaction whose work swallowed a failed statement is refused, never committed as a silent rollback', async () => {
    // A database answers COMMIT of an aborted transaction with a rollback, so
    // work that caught its own failed statement and resolved would otherwise
    // be reported as kept while every row of it was thrown away.
    const owner = createPGliteDatabaseOwner();
    await expect(owner.transaction('write', async (transaction) => {
      await transaction.query('CREATE TABLE swallowed (value INTEGER)');
      await transaction.query('INSERT INTO swallowed VALUES (1)');
      try {
        await transaction.query('SELECT 1/0');
      } catch {
        // Swallowed on purpose: the caller carries on as if nothing happened.
      }
    })).rejects.toThrow(/the transaction of the database owner ":memory:" was aborted by a failed statement and cannot be committed/);
    // Nothing of it survived, and the owner still answers afterwards.
    const tables = await owner.run(async (transaction) => await transaction.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'swallowed'",
    ));
    expect(tables.rows).toEqual([]);
    await owner.close();
  });

  test('a call on an owner from inside its own transaction is refused, instead of waiting on the transaction that waits on it', async () => {
    // PGlite serves one connection, so a second call queued behind the
    // caller's own transaction would never run; a PostgreSQL pool would run it
    // on another client, outside the caller's transaction. Both are refused
    // with the same words, naming the owner and the way out.
    const owner = createPGliteDatabaseOwner();
    await expect(owner.transaction('write', async () => {
      await owner.transaction('write', async () => undefined);
    })).rejects.toThrow(/the database owner ":memory:" was called from inside its own transaction; pass that transaction to the operation instead of opening another/);
    await expect(owner.transaction('write', async () => {
      await owner.run(async () => undefined);
    })).rejects.toThrow(/the database owner ":memory:" was called from inside its own transaction/);
    await expect(owner.transaction('write', async () => {
      await owner.close();
    })).rejects.toThrow(/the database owner ":memory:" was closed from inside its own transaction/);
    // Every refusal rolled the transaction back and left the owner answering.
    await owner.run(async (transaction) => await transaction.query('SELECT 1'));
    await owner.close();
  });

  test('a history operation without a transaction, called inside an owner transaction, is refused by the owner rather than queued behind it', async () => {
    const { owner, history, database } = await sharedAdapters();
    await expect(owner.transaction('write', async () => {
      // The mistake this guards: the caller holds the owner's transaction but
      // forgot to pass it, so the history asks the owner for a bare read.
      await history.read();
    })).rejects.toThrow(/the database owner ":memory:" was called from inside its own transaction/);
    expect(await history.read()).toEqual(expect.objectContaining({ discrepancies: [], errors: [] }));
    await database.close();
    await history.close();
    await owner.close();
  });

  test('a lent owner outlives the adapters that borrowed it, and the caller that opened it closes it once', async () => {
    const { owner, history, database } = await sharedAdapters();
    await database.close();
    await history.close();
    // Borrowed, not owned: closing either adapter leaves the database open.
    await owner.run(async (transaction) => await transaction.query('SELECT 1'));
    // A closed history refuses its own operations, naming its database.
    await expect(history.read()).rejects.toThrow(/history database ":memory:" is closed/);

    await owner.close();
    await expect(owner.run(async (transaction) => await transaction.query('SELECT 1'))).rejects.toThrow(/database owner ":memory:" is closed/);
    // Closing twice is a no-op, never a second close of the database.
    await owner.close();
  });

  test('a history refuses a path beside a lent owner, and so does the query database', async () => {
    const owner = createPGliteDatabaseOwner();
    expect(() => createPGliteHistory({ clock: fakeClock(DAY(1)), owner, path: '/tmp/madarch-shared-history' }))
      .toThrow(/cannot be given both a database owner and the path "\/tmp\/madarch-shared-history"/);
    await expect(createPGliteQueryDatabase({ owner, path: '/tmp/madarch-shared-query' }))
      .rejects.toThrow(/cannot be given both a database owner and the path "\/tmp\/madarch-shared-query"/);
    await owner.close();
  });

  test('a query database lent an owner opened without the vector extension is refused, naming the owner and the way to open it', async () => {
    // Without this refusal the projection would fail later, inside its own
    // CREATE EXTENSION, with the engine's message and no owner named.
    const owner = createPGliteDatabaseOwner();
    await expect(createPGliteQueryDatabase({ owner }))
      .rejects.toThrow(/the query database was lent the database owner ":memory:", whose database was not opened with the pgvector extension/);
    await owner.close();
  });

  test("the fill's state store borrows the same owner: its tables are created beside the history's and a step runs through the owner's transaction", async () => {
    // madarch-tzte.19.4's store declares its whole database surface as
    // `transaction(kind, work)`; this proves the owner is that surface, so
    // madarch-tzte.19.5 can pass a lent owner to `createFillStateSchema` and
    // the store's steps without an adapter between them.
    const { owner, history, database } = await sharedAdapters();
    await history.store({ source: SOURCE, commit: 'c1', committedAt: DAY(1), model: model([element('shop')]) });
    await createFillStateSchema(owner);
    expect(await openChain(owner, { product: 'shop', at: DAY(2) })).toMatchObject({ state: 'idle', context: { activeRunId: null } });
    // Both table sets answer from the one database the owner opened.
    const tables = await owner.run(async (transaction) => await transaction.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('assertions', 'fill_chain') ORDER BY table_name",
    ));
    expect(tables.rows.map((row) => row.table_name)).toEqual(['assertions', 'fill_chain']);
    await database.close();
    await history.close();
    await owner.close();
  });

  test('a history opened with a path of its own still opens and closes its own database', async () => {
    // The behaviour existing callers rely on: no owner lent, the history owns
    // its database and closes it. A second history on the same path sees the
    // first one's tables, so the file was really released.
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createPGliteHistory: create } = await import('../src/index.js');
    const folder = mkdtempSync(join(tmpdir(), 'madarch-owner-'));
    const path = join(folder, 'history.pglite');
    try {
      const first = create({ clock: fakeClock(DAY(2)), path });
      await first.store({ source: SOURCE, commit: 'c1', committedAt: DAY(1), model: model([element('shop')]) });
      await first.close();
      const second = create({ clock: fakeClock(DAY(2)), path });
      expect((await second.commits(SOURCE)).map((each) => each.commit)).toEqual(['c1']);
      await second.close();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }, 15_000);
});
