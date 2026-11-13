import { prepareStore } from '../src/adapters/prepare-store.js';
/**
 * A schema migration and a page's read (madarch-8bdc.2.9). A page reads in one `REPEATABLE READ` transaction, which
 * holds `AccessShare` on every table it reads until it commits; `DROP INDEX` takes `AccessExclusive` on the table. The
 * one graph's schema runs no DDL on a store whose stamp stands, but when a migration does run its dictionary key
 * indexes were compared with a quoted spelling `pg_get_indexdef` never writes, so every dictionary's key index was
 * dropped and made again. A migration that drops an index that stands holds one dictionary table while it waits for
 * the next, and a page that holds the next and then reads the first deadlocks with it — PostgreSQL killed one of them
 * (CI run 42905848312, `deadlock detected`).
 *
 * The case forces that interleaving with two connections and an explicit lock order: the reader holds the language
 * dictionary, the migration's `DROP INDEX` on the path dictionary holds that one and waits for the language table, and
 * the reader then asks for the path table. A key index a migration finds standing must be left alone, so the migration
 * answers while the reader still holds the language table and no deadlock can form.
 */
import { describe, expect, test } from 'bun:test';
import { EMPTY_CONTRACT, generatedTableName, type GraphContract } from '../src/graph/contract.js';
const dictionaryTables = { language: generatedTableName('reader_language', 'dictionary'), path: generatedTableName('reader_path', 'dictionary') };
const dictionaryContract: GraphContract = { ...EMPTY_CONTRACT, dictionary: [
  { name: 'reader_language', fields: [{ name: 'name', type: 'text' }], key: ['name'] },
  { name: 'reader_path', fields: [{ name: 'text', type: 'text' }], key: ['text'] },
] };
import { createTestDatabaseOwner } from './test-database.js';

describe('a page reads while a fill migrates its schema', () => {
  test('a migration leaves a standing key index alone, so a reader and it cannot deadlock', async () => {
    const owner = await createTestDatabaseOwner();
    try {
      // The store a page has already read: its schema and every dictionary's key index stand.
      await prepareStore(owner, { contract: dictionaryContract });

      await owner.exec("DELETE FROM madarch_meta.schema_stamp WHERE name = 'one-graph'");

      let migrationSettled = false;
      let letTheReaderCheck!: () => void;
      const readerMayCheck = new Promise<void>((resolve) => { letTheReaderCheck = resolve; });
      let theReaderHoldsTheLanguage!: () => void;
      const theReaderHoldsTheLanguageTable = new Promise<void>((resolve) => { theReaderHoldsTheLanguage = resolve; });
      let blocked = false;
      let sawTheMigrationFinish = false;
      let readerError: Error | undefined;

      // The page: one read-only transaction, as a listing reads it — the language dictionary first, the path next.
      const reader = owner.transaction('snapshot', async (tx) => {
        // The detector waits this long in the process that waits; the default second only makes this test slower.
        await tx.query("SET LOCAL deadlock_timeout = '200ms'");
        await tx.query(`LOCK TABLE ${dictionaryTables.language} IN ACCESS SHARE MODE`);
        theReaderHoldsTheLanguage();
        await readerMayCheck;
        const deadline = Date.now() + 15_000;
        for (;;) {
          if (migrationSettled) { sawTheMigrationFinish = true; break; }
          const waiting = await tx.query<{ waiting: boolean }>(
            `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE relation = $1::regclass AND mode = 'AccessExclusiveLock' AND NOT granted) AS waiting`,
            [dictionaryTables.language],
          );
          if (waiting.rows[0]?.waiting === true) { blocked = true; break; }
          if (Date.now() > deadline) throw new Error(`the migration neither finished nor waited for ${dictionaryTables.language}: the store answered neither way`);
          await Bun.sleep(10);
        }
        // The page reads the path dictionary next. A migration on its way to the language table already holds it.
        await tx.query(`LOCK TABLE ${dictionaryTables.path} IN ACCESS SHARE MODE`);
      }).catch((error: unknown) => {
        readerError = error instanceof Error ? error : new Error(String(error));
        return undefined;
      });

      await theReaderHoldsTheLanguageTable;
      // The migration, in another connection: it must leave a key index that stands alone.
      const migration = prepareStore(owner, { contract: dictionaryContract });
      void migration.then(() => { migrationSettled = true; }, () => { migrationSettled = true; });
      letTheReaderCheck();
      const migrationError = await migration.then(() => undefined, (error: unknown) => (error instanceof Error ? error : new Error(String(error))));
      await reader;
      expect(readerError?.message).toBeUndefined();
      expect(migrationError?.message).toBeUndefined();
      expect(blocked, 'the migration waited for a table the page held, so it dropped a key index that stands').toBe(false);
      expect(sawTheMigrationFinish, 'the migration did not finish while the page held the language table').toBe(true);
    } finally {
      await owner.close();
    }
  }, 120_000);
});
