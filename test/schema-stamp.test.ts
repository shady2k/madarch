import { withAssertionContract } from '../src/graph/system-contract.js';
import { createHistoryStore } from '../src/adapters/sql-history.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { readChain } from '../src/graph/fill-state.js';
import { createOrchestratorSchema, readRunControl } from '../src/graph/fill-orchestration.js';
/** Explicit preparation precedes every connect-only graph role (madarch-8bdc.10). */
import { describe, expect, test } from 'bun:test';
import { createDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { prepareStore } from '../src/adapters/prepare-store.js';
import { createOneGraphSchema } from '../src/graph/one-graph.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { repositoryContract } from './repository-contract-fixture.js';
import { testStoreServer } from './test-database.js';

/** Observe every client query, including a forbidden attempt that PostgreSQL rejects. */
function observed(owner: DatabaseOwner, statements: string[]): DatabaseOwner {
  return new Proxy(owner, {
    get(target, key) {
      if (key === 'run') return async (work: (executor: never) => Promise<unknown>) =>
        await target.run(async (executor) => work(new Proxy(executor, {
          get(inner, name) {
            if (name === 'query') return async (sql: string, values?: readonly unknown[]) => {
              statements.push(sql);
              return await inner.query(sql, values);
            };
            const value = Reflect.get(inner, name);
            return typeof value === 'function' ? value.bind(inner) : value;
          },
        }) as never));
      if (key === 'exec') return async (sql: string) => { statements.push(sql); return await target.exec(sql); };
      if (key === 'transaction') return async (kind: never, work: (tx: never) => Promise<unknown>) =>
        await target.transaction(kind, async (tx) => work(new Proxy(tx, {
          get(inner, name) {
            if (name === 'query') return async (sql: string, values?: readonly unknown[]) => {
              statements.push(sql);
              return await inner.query(sql, values);
            };
            const value = Reflect.get(inner, name);
            return typeof value === 'function' ? value.bind(inner) : value;
          },
        }) as never));
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
const ddl = (sql: string): boolean => /\b(?:CREATE|ALTER|DROP|TRUNCATE)\s/iu.test(sql);

async function fresh(): Promise<DatabaseOwner> {
  return await createDatabaseOwner({ cluster: await testStoreServer(), database: `schema_${crypto.randomUUID().replaceAll('-', '')}` });
}

describe('explicit store preparation and connect-only clients', () => {
  test('an unprepared graph client refuses with a preparation instruction and attempts no DDL', async () => {
    const owner = await fresh();
    try {
      const statements: string[] = [];
      const client = observed(owner, statements);
      await expect(createOneGraphSchema(client)).rejects.toThrow('run madarch start');
      await expect(createOneGraphSchema(client, withManifestContract(repositoryContract))).rejects.toThrow('run madarch start');
      expect(statements.filter(ddl)).toEqual([]);
      const held = await owner.run(async (tx) => await tx.query<{ name: string | null }>("SELECT to_regclass('madarch_meta.schema_stamp')::text AS name"));
      expect(held.rows).toEqual([{ name: null }]);
    } finally { await owner.close(); }
  }, 120_000);

  test('twenty fresh prepared stores accept eight concurrent module clients without DDL or retries', async () => {
    for (let run = 0; run < 20; run += 1) {
      const database = `roles_${crypto.randomUUID().replaceAll('-', '')}`;
      const cluster = await testStoreServer();
      const owner = await createDatabaseOwner({ cluster, database });
      try {
        await prepareStore(owner, { contract: withManifestContract(repositoryContract) });
        const stamps = await owner.run(async (tx) => await tx.query('SELECT * FROM madarch_meta.schema_stamp ORDER BY name'));
        const statements: string[] = [];
        const answers = await Promise.allSettled(Array.from({ length: 8 }, async (_, role) => {
          const connection = await createDatabaseOwner({ cluster, database, connectOnly: true });
          const observedOwner = observed(connection, statements);
          const client = {
            ...observedOwner,
            transaction: observedOwner.transaction.bind(observedOwner),
            run: observedOwner.run.bind(observedOwner),
            exec: observedOwner.exec.bind(observedOwner),
            close: observedOwner.close.bind(observedOwner),
            graphContract: withAssertionContract(withManifestContract(repositoryContract)),
          };
          try {
          switch (role) {
            case 0: await createOneGraphSchema(client, withManifestContract(repositoryContract)); break;
            case 1: await createOneGraphSchema(client, withManifestContract(repositoryContract)); break;
            case 2: {
              const history = createHistoryStore({ owner: client, clock: { now: () => 1 } });
              try { expect(await history.registry('fixture')).toBeUndefined(); }
              finally { await history.close(); }
              break;
            }
            case 3:

              expect(await readChain(client, 'fixture')).toBeNull();
              break;
            case 4:
              await createOrchestratorSchema(client);
              expect(await readRunControl(client, 'fixture')).toBeNull();
              break;
            case 5:

              expect(await readChain(client, 'fixture')).toBeNull();
              break;
            default: {
              const queue = await createPgBossQueue({ owner: client, supervise: false });
              try { await queue.declare({ name: 'fill-units', leaseSeconds: 60, retries: 0, retryDelaySeconds: 0, retryBackoff: false, singletons: true }); }
              finally { await queue.stop(); }
            }
          }
          } finally { await connection.close(); }
        }));
        expect(answers.filter((answer) => answer.status === 'rejected')).toEqual([]);
        expect(statements.filter(ddl)).toEqual([]);
        expect(await owner.run(async (tx) => await tx.query('SELECT * FROM madarch_meta.schema_stamp ORDER BY name'))).toEqual(stamps);
        const tables = await owner.run(async (tx) => await tx.query<{ table_name: string }>(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name IN ('node', 'edge', 'entity') ORDER BY table_name",
        ));
        expect(tables.rows.map((row) => row.table_name)).toEqual(['edge', 'entity', 'node']);
      } finally { await owner.close(); }
    }
  }, 120_000);
});


describe('transaction client query admission', () => {
  test('one transaction submits concurrent calls to its native client one at a time', async () => {
    const owner = await fresh();
    await owner.ready;
    const { Client } = await import('pg');
    const original = Client.prototype.query;
    const active = new WeakMap<object, number>();
    let maximum = 0;
    Client.prototype.query = function (this: InstanceType<typeof Client>, ...args: unknown[]) {
      const pending = (active.get(this) ?? 0) + 1;
      active.set(this, pending);
      maximum = Math.max(maximum, pending);
      const finish = (): void => { active.set(this, (active.get(this) ?? 1) - 1); };
      try {
        const answer = Reflect.apply(original, this, args) as Promise<unknown>;
        return answer.then((value) => { finish(); return value; }, (error: unknown) => { finish(); throw error; });
      } catch (error) { finish(); throw error; }
    } as typeof original;
    try {
      await owner.exec('CREATE TABLE queue_probe (position integer GENERATED ALWAYS AS IDENTITY, value integer NOT NULL)');
      const answers = await owner.transaction('write', async (tx) => await Promise.all([
        tx.query('SELECT pg_sleep(0.02)'),
        ...[10, 20, 30].map((value) => tx.query<{ position: number; value: number }>('INSERT INTO queue_probe (value) VALUES ($1) RETURNING position,value', [value])),
      ]));
      expect(answers.slice(1).map((answer) => answer.rows)).toEqual([
        [{ position: 1, value: 10 }], [{ position: 2, value: 20 }], [{ position: 3, value: 30 }],
      ]);
      expect(maximum).toBe(1);
    } finally {
      Client.prototype.query = original;
      await owner.close();
    }
  });

  test('a handled statement error can recover through its savepoint', async () => {
    const owner = await fresh();
    try {
      await owner.exec('CREATE TABLE queue_probe (value integer NOT NULL)');
      await owner.transaction('write', async (tx) => {
        await tx.query('SAVEPOINT recover');
        await expect(tx.query('SELECT 1 / 0')).rejects.toThrow();
        await tx.query('ROLLBACK TO SAVEPOINT recover');
        await tx.query('INSERT INTO queue_probe VALUES (7)');
      });
      expect((await owner.run((tx) => tx.query('SELECT value FROM queue_probe'))).rows).toEqual([{ value: 7 }]);
    } finally { await owner.close(); }
  });

  test('callback rejection drains accepted calls before rollback and refuses calls through a retained executor', async () => {
    const owner = await fresh();
    let lateQuery: (() => Promise<unknown>) | undefined;
    let settled = false;
    let accepted: Promise<PromiseSettledResult<unknown>[]> | undefined;
    const failure = new Error('fixture callback failed');
    try {
      await owner.exec('CREATE TABLE queue_probe (value integer NOT NULL)');
      await expect(owner.transaction('write', async (tx) => {
        lateQuery = () => tx.query('INSERT INTO queue_probe VALUES (99)');
        accepted = Promise.allSettled([
          tx.query('SELECT pg_sleep(0.02)'),
          tx.query('INSERT INTO queue_probe VALUES (1)'),
          tx.query('INSERT INTO queue_probe VALUES (2)'),
        ]).then((answers) => { settled = true; return answers; });
        throw failure;
      })).rejects.toBe(failure);
      expect(settled).toBe(true);
      expect((await accepted!).every((answer) => answer.status === 'fulfilled')).toBe(true);
      await expect(lateQuery!()).rejects.toThrow();
      await owner.transaction('write', async (tx) => { await tx.query('INSERT INTO queue_probe VALUES (3)'); });
      expect((await owner.run((tx) => tx.query('SELECT value FROM queue_probe ORDER BY value'))).rows).toEqual([{ value: 3 }]);
    } finally { await owner.close(); }
  });
});
