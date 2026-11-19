/**
 * The run's PostgreSQL server is non-durable (ALX-186, C1): a case's database is
 * dropped inside `close()`, and `DROP DATABASE` forces a checkpoint of the whole
 * cluster, whose `fsync` of every dirty page cost 1.2 s on a quiet cluster and
 * 8.4 s with 240 MB of them (ALX-119). The server the preload leases therefore
 * runs with `fsync`, `full_page_writes` and `synchronous_commit` off — and only
 * that server: a store folder a case opens for itself keeps the defaults,
 * because its data outlives the run.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabaseOwner, type TestDatabaseOwner } from './test-database.js';

/** The settings a run server must not sync to disk, and a store's cluster must. */
const SETTINGS = ['fsync', 'full_page_writes', 'synchronous_commit'] as const;

/** The three settings as the database this owner opened answers them. */
async function settingsOf(owner: TestDatabaseOwner): Promise<Record<string, string>> {
  const rows = (await owner.run((tx) => tx.query<{ name: string; setting: string }>('SELECT name, setting FROM pg_settings WHERE name = ANY($1)', [SETTINGS]))).rows;
  return Object.fromEntries(rows.map((row) => [row.name, row.setting]));
}

test('the run server runs without fsync, full_page_writes and synchronous_commit', async () => {
  const owner = await createTestDatabaseOwner();
  try {
    expect(await settingsOf(owner)).toEqual({ fsync: 'off', full_page_writes: 'off', synchronous_commit: 'off' });
  } finally { await owner.close(); }
}, 60_000);

test('a store cluster of a case keeps the durable defaults', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'run-settings-store-'));
  try {
    const owner = await createTestDatabaseOwner({ store: folder });
    try {
      expect(await settingsOf(owner)).toEqual({ fsync: 'on', full_page_writes: 'on', synchronous_commit: 'on' });
    } finally { await owner.close(); }
  } finally { rmSync(folder, { recursive: true, force: true }); }
}, 120_000);
