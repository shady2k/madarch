/**
 * A schema made by several processes at once (madarch-8bdc.2.5): `CREATE SCHEMA IF NOT EXISTS` and
 * `CREATE TABLE IF NOT EXISTS` are not safe under concurrency in PostgreSQL — two connections both pass the existence
 * check and the second insert into `pg_namespace` (or `pg_class`) fails with a duplicate key. One store is opened by a
 * fill worker, a read worker and the server's own process at the same moment, so `createSchemaOnce` must serialize.
 */
import { describe, expect, test } from 'bun:test';
import { createOneGraphSchema } from '../src/graph/one-graph.js';
import { createTestDatabaseOwner } from './test-database.js';

describe('a schema made at once from several connections', () => {
  test('eight schema creations of one fresh store all succeed, and the stamp is written once', async () => {
    const owner = await createTestDatabaseOwner();
    try {
      // Eight calls at once: eight clients of the owner's pool, so eight connections of one server, as the fill worker,
      // the read worker and the server are eight connections.
      const answers = await Promise.allSettled(Array.from({ length: 8 }, async () => await createOneGraphSchema(owner)));
      const failed = answers.filter((answer): answer is PromiseRejectedResult => answer.status === 'rejected');
      expect(failed.map((answer) => (answer.reason as Error).message)).toEqual([]);
      const stamps = await owner.run(async (tx) => await tx.query<{ name: string; stamp: string }>('SELECT name, stamp FROM madarch_meta.schema_stamp ORDER BY name'));
      // The schema's stamp, the revision of its rows' meaning, and the mark a fresh store carries: it needs a fill.
      expect(stamps.rows.map((row) => row.name)).toEqual(['graph-reset', 'one-graph', 'one-graph-revision']);
      expect(stamps.rows.find((row) => row.name === 'one-graph-revision')?.stamp).toBe('3');
      const tables = await owner.run(async (tx) => await tx.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name IN ('node', 'edge', 'entity') ORDER BY table_name",
      ));
      expect(tables.rows.map((row) => row.table_name)).toEqual(['edge', 'entity', 'node']);
    } finally {
      await owner.close();
    }
  }, 120_000);
});
