/** Preparation of the file-text requests table (madarch-u3vw.16, decision 0037). */
import type { DatabaseOwner } from '../database-owner.js';
import { createSchemaOnce } from '../schema-stamp.js';

/** The table's name, as the schema's stamp holds it. */
export const FILE_TEXT_TABLES = ['file_text_request'] as const;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS file_text_request (
    id text PRIMARY KEY CHECK (id <> ''),
    product text NOT NULL CHECK (product <> ''),
    plugin text NOT NULL CHECK (plugin <> ''),
    repository text NOT NULL CHECK (repository <> ''),
    root text NOT NULL CHECK (root <> ''),
    blob text NOT NULL CHECK (blob <> ''),
    from_line integer NOT NULL CHECK (from_line >= 1),
    to_line integer CHECK (to_line IS NULL OR to_line >= 1),
    text text,
    lines integer CHECK (lines IS NULL OR lines >= 0),
    bytes integer CHECK (bytes IS NULL OR bytes >= 0),
    is_binary boolean,
    error text,
    requested_at bigint NOT NULL,
    claimed_at bigint,
    answered_at bigint
  )`,
  // The api role asks and waits; the host takes the oldest unanswered row: the two indexes are the two directions.
  'CREATE INDEX IF NOT EXISTS file_text_request_waiting ON file_text_request (requested_at) WHERE answered_at IS NULL',
  'CREATE INDEX IF NOT EXISTS file_text_request_answered ON file_text_request (answered_at)',
];

export const fileTextSchema = {
  name: 'file-text',
  async prepare(owner: DatabaseOwner): Promise<void> {
    await createSchemaOnce(owner, {
      name: 'file-text',
      parts: SCHEMA,
      tables: FILE_TEXT_TABLES,
      create: async (executor) => {
        for (const statement of SCHEMA) await executor.query(statement);
      },
    });
  },
};
