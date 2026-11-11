/** Preparation of a source history's tables and canonical model digest migration. */
import type { DatabaseOwner } from '../database-owner.js';
import { createSchemaOnce } from '../schema-stamp.js';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS assertions (
    source TEXT NOT NULL,
    kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    content TEXT NOT NULL,
    valid_from DOUBLE PRECISION NOT NULL,
    valid_to DOUBLE PRECISION,
    opened_by TEXT NOT NULL,
    closed_by TEXT,
    recorded_from DOUBLE PRECISION NOT NULL,
    recorded_to DOUBLE PRECISION
  )`,
  `CREATE INDEX IF NOT EXISTS assertions_current ON assertions (source, kind, entity_id, recorded_to)`,
  `CREATE INDEX IF NOT EXISTS assertions_time ON assertions (valid_from, valid_to, recorded_from, recorded_to)`,
  `CREATE INDEX IF NOT EXISTS assertions_other ON assertions (kind, recorded_to, source)`,
  `CREATE TABLE IF NOT EXISTS source_commits (
    source TEXT NOT NULL,
    commit_id TEXT NOT NULL,
    committed_at DOUBLE PRECISION NOT NULL,
    content_digest TEXT NOT NULL,
    recorded_at DOUBLE PRECISION NOT NULL,
    canonical_digest TEXT NOT NULL,
    PRIMARY KEY (source, commit_id)
  )`,
  `CREATE INDEX IF NOT EXISTS source_commits_order_c ON source_commits (source, committed_at, commit_id COLLATE "C")`,
  `CREATE TABLE IF NOT EXISTS source_registry (
    source TEXT PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    former_names TEXT NOT NULL
  )`,
] as const;

export const historySchema = {
  name: 'history',
  async prepare(owner: DatabaseOwner): Promise<void> {
    const location = owner.location;
    await createSchemaOnce(owner, {
      name: 'history',
      parts: [...SCHEMA, 'canonical-digest-migration'],
      tables: ['assertions', 'source_commits', 'source_registry'],
      create: async (transaction) => {
        for (const statement of SCHEMA) await transaction.query(statement);
        const columns = await transaction.query<{ column_name: string }>(
          "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'source_commits'",
        );
        if (!columns.rows.some((column) => column.column_name === 'canonical_digest')) {
          const legacyCommit = await transaction.query<{ source: string; commit_id: string }>(
            'SELECT source, commit_id FROM source_commits ORDER BY source, committed_at, commit_id LIMIT 1',
          );
          if (legacyCommit.rows.length > 0) {
            const row = legacyCommit.rows[0]!;
            throw new Error(`the history database "${location}" holds commit "${row.commit_id}" of source "${row.source}" without a canonical model digest; the stored assertions cannot faithfully recover the model's original array order, so the history must be migrated by a server that still has the original sent models`);
          }
          await transaction.query('ALTER TABLE source_commits ADD COLUMN canonical_digest TEXT');
        }
      },
    });
  },
};
