import { expect, test } from 'bun:test';
import { requireSchema } from '../src/adapters/store-readiness.js';
import { createTestDatabaseOwner, TEST_SERVER_VARIABLE } from './test-database.js';

// Capture at module load: a helper called inside a case must not supply startup.
const socketBeforeCases = process.env[TEST_SERVER_VARIABLE];

test('the preload starts the run server before the first database case', () => {
  expect(socketBeforeCases?.trim()).toBeTruthy();
});

test('fresh database owners are prepared and isolate data and schema changes', async () => {
  const phases = new Map<string, number>();
  const first = await createTestDatabaseOwner({ timing: (phase, elapsedMs) => { phases.set(phase, elapsedMs); } });
  try {
    await requireSchema(first, 'history');
    await requireSchema(first, 'one-graph');
    await requireSchema(first, 'queue:pgboss');
    await first.exec("CREATE TABLE case_only (value text); INSERT INTO case_only VALUES ('first')");
    await first.exec("UPDATE madarch_meta.schema_stamp SET stamp = 'case-only' WHERE name = 'history'");
    const second = await createTestDatabaseOwner();
    try {
      expect(second.location).not.toBe(first.location);
      await requireSchema(second, 'history');
      const isolated = await second.run((tx) => tx.query<{ table_name: string | null; stamp: string }>(
        "SELECT to_regclass('case_only')::text AS table_name, stamp FROM madarch_meta.schema_stamp WHERE name = 'history'",
      ));
      expect(isolated.rows[0]?.table_name).toBeNull();
      expect(isolated.rows[0]?.stamp).not.toBe('case-only');
      const queues = await second.run((tx) => tx.query('SELECT name FROM pgboss.queue'));
      expect(queues.rows.length).toBeGreaterThan(0);
    } finally { await second.close(); }
    const own = await first.run((tx) => tx.query<{ value: string }>('SELECT value FROM case_only'));
    expect(own.rows).toEqual([{ value: 'first' }]);
  } finally { await first.close(); }
  for (const phase of ['server-ready', 'template-ready', 'database-clone', 'database-owner-open', 'database-owner-close', 'database-drop']) {
    expect(phases.get(phase)).toBeGreaterThanOrEqual(0);
  }
});
