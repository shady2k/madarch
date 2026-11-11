/** Preparation of catalogue selection tables. */
import type { DatabaseOwner } from '../database-owner.js';
import { createSchemaOnce } from '../schema-stamp.js';

/** The tables' names, in code point order, as the schema's stamp holds them. */
const TABLES = ['fill_selection', 'fill_selection_settings'] as const;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS fill_selection (
    product text NOT NULL CHECK (product <> ''),
    kind text NOT NULL CHECK (kind <> ''),
    selected boolean NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (product, kind)
  )`,
  // One row per product: the panel's other choices, which are written with the selection so a reload shows them again.
  `CREATE TABLE IF NOT EXISTS fill_selection_settings (
    product text PRIMARY KEY CHECK (product <> ''),
    agent text,
    token_cap integer CHECK (token_cap IS NULL OR token_cap > 0),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
];

/** Makes this module's tables in a store that has none of them; a second call runs no DDL (`schema-stamp.ts`). */
async function prepare(owner: DatabaseOwner): Promise<void> {
  await createSchemaOnce(owner, {
    name: 'fill-selection',
    tables: TABLES,
    parts: SCHEMA,
    create: async (transaction) => {
      for (const statement of SCHEMA) await transaction.query(statement);
    },
  });
}


export const fillSelectionSchema = { name: 'fill-selection', prepare };
