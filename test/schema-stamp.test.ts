/**
 * A schema made by several processes at once (madarch-8bdc.2.5): `CREATE SCHEMA IF NOT EXISTS` and
 * `CREATE TABLE IF NOT EXISTS` are not safe under concurrency in PostgreSQL — two connections both pass the existence
 * check and the second insert into `pg_namespace` (or `pg_class`) fails with a duplicate key. One store is opened by a
 * fill worker, a read worker and the server's own process at the same moment, so `createSchemaOnce` must serialize.
 */
import { describe, expect, test } from 'bun:test';
import { createGraphSchema } from '../src/graph/schema.js';
import { createTestDatabaseOwner } from './test-database.js';

describe('a schema made at once from several connections', () => {
  test('eight schema creations of one fresh store all succeed, and the stamp is written once', async () => {
    const owner = await createTestDatabaseOwner();
    try {
      const at = new Date('2026-11-05T10:00:00.000Z').toISOString();
      // Eight calls at once: eight clients of the owner's pool, so eight connections of one server, as the fill worker,
      // the read worker and the server are eight connections.
      const answers = await Promise.allSettled(Array.from({ length: 8 }, async () => await createGraphSchema(owner, at)));
      const failed = answers.filter((answer): answer is PromiseRejectedResult => answer.status === 'rejected');
      expect(failed.map((answer) => (answer.reason as Error).message)).toEqual([]);
      const stamps = await owner.run(async (tx) => await tx.query<{ name: string; stamp: string }>('SELECT name, stamp FROM madarch_meta.schema_stamp ORDER BY name'));
      expect(stamps.rows.map((row) => row.name)).toEqual(['graph']);
      const tables = await owner.run(async (tx) => await tx.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name IN ('node_version', 'edge_version', 'work_item') ORDER BY table_name",
      ));
      expect(tables.rows.map((row) => row.table_name)).toEqual(['edge_version', 'node_version', 'work_item']);
    } finally {
      await owner.close();
    }
  }, 120_000);
});
