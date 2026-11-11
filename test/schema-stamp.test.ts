import { createHistoryStore } from '../src/adapters/sql-history.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { createFillSelectionSchema, readFillSelection } from '../src/adapters/fill-selection.js';
import { createFillStateSchema, readChain } from '../src/fill/state-store.js';
import { createOrchestratorSchema, readRunControl } from '../src/fill/orchestrator-store.js';
/** Explicit preparation precedes every connect-only graph role (madarch-8bdc.10). */
import { describe, expect, test } from 'bun:test';
import { createDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { prepareStore } from '../src/adapters/prepare-store.js';
import { createOneGraphSchema } from '../src/graph/one-graph.js';
import { createRecordSchema } from '../src/graph/records.js';
import { GIT_CONTRACT } from '../src/fill/stages/git-contract.js';
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
      await expect(createRecordSchema(client, GIT_CONTRACT)).rejects.toThrow('run madarch start');
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
        await prepareStore(owner, { contract: GIT_CONTRACT });
        const stamps = await owner.run(async (tx) => await tx.query('SELECT * FROM madarch_meta.schema_stamp ORDER BY name'));
        const statements: string[] = [];
        const answers = await Promise.allSettled(Array.from({ length: 8 }, async (_, role) => {
          const connection = await createDatabaseOwner({ cluster, database, connectOnly: true });
          const client = observed(connection, statements);
          try {
          switch (role) {
            case 0: await createOneGraphSchema(client, GIT_CONTRACT); break;
            case 1: await createRecordSchema(client, GIT_CONTRACT); break;
            case 2: {
              const history = createHistoryStore({ owner: client, clock: { now: () => 1 } });
              try { expect(await history.registry('fixture')).toBeUndefined(); }
              finally { await history.close(); }
              break;
            }
            case 3:
              await createFillStateSchema(client);
              expect(await readChain(client, 'fixture')).toBeNull();
              break;
            case 4:
              await createOrchestratorSchema(client);
              expect(await readRunControl(client, 'fixture')).toBeNull();
              break;
            case 5:
              await createFillSelectionSchema(client);
              await readFillSelection(client, 'fixture');
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
