import { describe, expect, test } from 'bun:test';
import type { Clock, CompiledElement, CompiledModel } from '../src/index.js';
import { createFillStateSchema, openChain } from '../src/fill/state-store.js';
import { createQueryDatabase } from '../src/adapters/query-database.js';
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { createHistoryStore } from '../src/adapters/sql-history.js';
import { createTestDatabaseOwner } from './test-database.js';

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
  const owner = await createTestDatabaseOwner();
  const history = createHistoryStore({ owner, clock });
  const database = await createQueryDatabase({ owner, clock });
  const engine = database.forSources([SOURCE]);
  return { clock, owner, history, database, engine };
}

describe('one database owner per process', () => {
  test('the history and the query database hold their tables in the one database the owner opened', async () => {
    const { owner, history, database } = await sharedAdapters();
    // The history makes its tables on its first use: this read is what makes them, and then both adapters' tables
    // answer from the one connection, which is what "one owner" means.
    await history.read();
    const tables = await owner.run(async (transaction) => {
      const rows = await transaction.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
      );
      return rows.rows.map((row) => row.table_name);
    });
    // The projection's own tables are there; `vector_items` is not, because the
    // database carries no pgvector and the vector index is what refuses by name
    // (decision 0024's amendment, item 4 of this task).
    expect(tables).toEqual(expect.arrayContaining(['assertions', 'source_commits', 'source_registry', 'query_elements', 'query_relations', 'query_states']));
    expect(tables).not.toContain('vector_items');
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
    const owner = await createTestDatabaseOwner();
    await expect(owner.transaction('write', async (transaction) => {
      await transaction.query('CREATE TABLE swallowed (value INTEGER)');
      await transaction.query('INSERT INTO swallowed VALUES (1)');
      try {
        await transaction.query('SELECT 1/0');
      } catch {
        // Swallowed on purpose: the caller carries on as if nothing happened.
      }
    })).rejects.toThrow(/was aborted by a failed statement and cannot be committed/);
    // Nothing of it survived, and the owner still answers afterwards.
    const tables = await owner.run(async (transaction) => await transaction.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'swallowed'",
    ));
    expect(tables.rows).toEqual([]);
    await owner.close();
  });

  test('a call on an owner from inside its own transaction is refused, instead of waiting on the transaction that waits on it', async () => {
    // The pool would run the second call on another client, outside the
    // caller's transaction; both shapes are refused with the same words,
    // naming the owner and the way out. This case opens an owner of its own,
    // because a close it provokes on purpose must reach the owner untouched.
    const owner = await createDatabaseOwner({});
    await expect(owner.transaction('write', async () => {
      await owner.transaction('write', async () => undefined);
    })).rejects.toThrow(/was called from inside its own transaction; pass that transaction to the operation instead of opening another/);
    await expect(owner.transaction('write', async () => {
      await owner.run(async () => undefined);
    })).rejects.toThrow(/was called from inside its own transaction/);
    await expect(owner.transaction('write', async () => {
      await owner.close();
    })).rejects.toThrow(/from inside its own transaction/);
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
    })).rejects.toThrow(/was called from inside its own transaction/);
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
    await expect(history.read()).rejects.toThrow(/is closed/);

    await owner.close();
    await expect(owner.run(async (transaction) => await transaction.query('SELECT 1'))).rejects.toThrow(/database owner ".*" is closed/);
    // Closing twice is a no-op, never a second close of the database.
    await owner.close();
  });

  test('a history refuses a store beside a lent owner, and so does the query database', async () => {
    const owner = await createTestDatabaseOwner();
    expect(() => createHistoryStore({ clock: fakeClock(DAY(1)), owner, store: '/tmp/madarch-shared-history' }))
      .toThrow(/cannot be given both a database owner and the store "\/tmp\/madarch-shared-history"/);
    await expect(createQueryDatabase({ owner, store: '/tmp/madarch-shared-query' }))
      .rejects.toThrow(/cannot be given both a database owner and the store "\/tmp\/madarch-shared-query"/);
    await owner.close();
  });

  test('a query database lent a store owner opens, and its vector index is what refuses: the pinned build carries no pgvector', async () => {
    // The server madarch installs carries PostgreSQL's own contrib extensions
    // and no pgvector (src/adapters/postgres-builds.ts). The projection's own
    // tables and every graph query answer there; a vector rebuild or search
    // says what it needs, naming the database.
    const owner = await createTestDatabaseOwner();
    const database = await createQueryDatabase({ owner });
    const engine = database.forSources(['s']);
    expect(await engine.children('nothing', { valid: DAY(1), known: DAY(1) })).toBeDefined();
    await expect(database.vectorIndexForSources(['s']).rebuild(['s'], [])).rejects.toThrow(/the vector index needs pgvector 0\.8\.7/);
    await engine.close();
    await database.close();
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

  test('a history opened with a store of its own still opens and closes its own cluster', async () => {
    // The behaviour existing callers rely on: no owner lent, the history owns
    // its store and closes it. A second history on the same store sees the
    // first one's tables, so the server was really released and restarted.
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const folder = mkdtempSync(join(tmpdir(), 'madarch-owner-'));
    try {
      const first = createHistoryStore({ clock: fakeClock(DAY(2)), store: folder });
      await first.store({ source: SOURCE, commit: 'c1', committedAt: DAY(1), model: model([element('shop')]) });
      await first.close();
      const second = createHistoryStore({ clock: fakeClock(DAY(2)), store: folder });
      expect((await second.commits(SOURCE)).map((each) => each.commit)).toEqual(['c1']);
      await second.close();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }, 30_000);

  test('an owner runs a batch of statements with no parameters as one message', async () => {
    // pg-boss sends its schema creation as one `BEGIN … COMMIT` text, which
    // the extended protocol `query` refuses.
    const owner = await createTestDatabaseOwner();
    try {
      const created = await owner.exec('BEGIN; CREATE TABLE batched (a int); INSERT INTO batched VALUES (1); COMMIT;');
      // One result per statement in the batch, which is four here.
      expect(created).toHaveLength(4);
      expect((await owner.run(async (transaction) => (await transaction.query<{ a: number }>('SELECT a FROM batched')).rows))).toEqual([{ a: 1 }]);
    } finally {
      await owner.close();
    }
  }, 15_000);

  test('a batch whose statement fails rolls back on the same connection and leaves the owner usable', async () => {
    const owner = await createTestDatabaseOwner();
    try {
      await owner.exec('BEGIN; CREATE TABLE batched (a int); COMMIT;');
      await expect(owner.exec('BEGIN; INSERT INTO batched VALUES (2); SELECT * FROM no_such_table; COMMIT;')).rejects.toThrow();
      // The failed batch left neither its insert nor an aborted transaction
      // behind: the next statement runs and the table holds only what the
      // first batch wrote.
      expect((await owner.run(async (transaction) => (await transaction.query<{ a: number }>('SELECT a FROM batched')).rows))).toEqual([]);
    } finally {
      await owner.close();
    }
  }, 15_000);
});
