import { prepareStore } from '../src/adapters/prepare-store.js';
/** A reader and a forced schema migration must not deadlock on standing typed key storage. */
import { describe, expect, test } from 'bun:test';
import { EMPTY_CONTRACT, assertionValueTableName, type GraphContract } from '../src/graph/contract.js';
const dictionaryTables = { language: assertionValueTableName('reader_language', 'vertex', 'name'), path: assertionValueTableName('reader_path', 'vertex', 'text') };
const dictionaryContract: GraphContract = { ...EMPTY_CONTRACT, vertex: [
  { name: 'reader_language', table: 'reader_language', capability: 'reader-fixture', fields: [{ name: 'name', type: 'text' }], key: ['name'] },
  { name: 'reader_path', table: 'reader_path', capability: 'reader-fixture', fields: [{ name: 'text', type: 'text' }], key: ['text'] },
] };
import { createTestDatabaseOwner } from './test-database.js';

describe('a page reads while a fill migrates its schema', () => {
  test('a forced migration repairs missing and changed typed storage guards', async () => {
    const owner = await createTestDatabaseOwner();
    try {
      await prepareStore(owner, { contract: dictionaryContract });
      await owner.exec(`DROP TRIGGER typed_value ON "${dictionaryTables.language}"`);
      await owner.exec(`DROP TRIGGER immutable_key ON "${dictionaryTables.language}"`);
      await owner.exec(`CREATE TRIGGER immutable_key AFTER INSERT ON "${dictionaryTables.language}" FOR EACH ROW EXECUTE FUNCTION graph_key_check()`);
      await owner.exec("DELETE FROM madarch_meta.schema_stamp WHERE name = 'one-graph'");
      await prepareStore(owner, { contract: dictionaryContract });
      const guards = await owner.run(tx => tx.query<{ name: string; deferred: boolean; initiallyDeferred: boolean; fn: string }>(
        `SELECT t.tgname AS name, t.tgdeferrable AS deferred, t.tginitdeferred AS "initiallyDeferred", p.proname AS fn
         FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
         WHERE t.tgrelid=$1::regclass AND t.tgname IN ('typed_value','immutable_key') ORDER BY t.tgname`,
        [dictionaryTables.language],
      ));
      expect(guards.rows).toEqual([
        { name: 'immutable_key', deferred: true, initiallyDeferred: true, fn: 'graph_key_check' },
        { name: 'typed_value', deferred: true, initiallyDeferred: true, fn: 'graph_value_check' },
      ]);
    } finally { await owner.close(); }
  });
  test('a migration leaves a standing key index alone, so a reader and it cannot deadlock', async () => {
    const owner = await createTestDatabaseOwner();
    try {
      // The store a page has already read: its typed key storage and primary indexes stand.
      await prepareStore(owner, { contract: dictionaryContract });

      const standingTriggers = await owner.run(tx => tx.query<{ oid: string }>(
        'SELECT oid::text FROM pg_trigger WHERE tgrelid = $1::regclass ORDER BY tgname', [dictionaryTables.language],
      ));
      await owner.exec("DELETE FROM madarch_meta.schema_stamp WHERE name = 'one-graph'");

      let migrationSettled = false;
      let letTheReaderCheck!: () => void;
      const readerMayCheck = new Promise<void>((resolve) => { letTheReaderCheck = resolve; });
      let theReaderHoldsTheLanguage!: () => void;
      let readerSetupFailed!: (error: unknown) => void;
      const theReaderHoldsTheLanguageTable = new Promise<void>((resolve, reject) => { theReaderHoldsTheLanguage = resolve; readerSetupFailed = reject; });
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
        readerSetupFailed(readerError);
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
      expect((await owner.run(tx => tx.query<{ oid: string }>(
        'SELECT oid::text FROM pg_trigger WHERE tgrelid = $1::regclass ORDER BY tgname', [dictionaryTables.language],
      ))).rows).toEqual(standingTriggers.rows);
    } finally {
      await owner.close();
    }
  }, 120_000);
});
