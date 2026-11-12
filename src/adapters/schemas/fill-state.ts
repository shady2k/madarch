/** Preparation of the fill state machines' tables and constraints. */
import type { DatabaseOwner } from '../database-owner.js';
import { createSchemaOnce } from '../schema-stamp.js';
import { FILL_STATE_TABLES } from '../../fill/state-store.js';

const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS fill_chain (
    product text PRIMARY KEY,
    state text NOT NULL,
    context jsonb NOT NULL,
    updated_at bigint NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS fill_run (
    run_id text PRIMARY KEY,
    product text NOT NULL,
    state text NOT NULL,
    context jsonb NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS fill_run_product ON fill_run (product, created_at)',
  `CREATE TABLE IF NOT EXISTS fill_unit (
    unit_id text PRIMARY KEY,
    product text NOT NULL,
    stage_id text NOT NULL,
    scope_key text NOT NULL,
    generation integer NOT NULL,
    created_at bigint NOT NULL,
    UNIQUE (product, stage_id, scope_key)
  )`,
  `CREATE TABLE IF NOT EXISTS fill_unit_generation (
    unit_id text NOT NULL,
    generation integer NOT NULL,
    run_id text NOT NULL,
    state text NOT NULL,
    inputs_digest text NOT NULL,
    fence integer NOT NULL,
    context jsonb NOT NULL,
    published_at bigint,
    stale_at bigint,
    updated_at bigint NOT NULL,
    PRIMARY KEY (unit_id, generation)
  )`,
  `CREATE TABLE IF NOT EXISTS fill_unit_lease (
    unit_id text NOT NULL,
    generation integer NOT NULL,
    attempt integer NOT NULL,
    fence integer NOT NULL,
    holder text NOT NULL,
    issued_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    revoked_at bigint,
    PRIMARY KEY (unit_id, generation, attempt)
  )`,
  `CREATE TABLE IF NOT EXISTS fill_transition (
    seq bigserial PRIMARY KEY,
    subject_kind text NOT NULL,
    subject_id text NOT NULL,
    generation integer,
    transition_id text NOT NULL,
    from_state text NOT NULL,
    to_state text NOT NULL,
    event text NOT NULL,
    fence integer,
    at bigint NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS fill_transition_subject ON fill_transition (subject_kind, subject_id)',
  // Every pass reads a run's units several times, and admission counts them under the run's lock: without this
  // index each read scans every generation the store holds, which grows with every run a product ever planned.
  'CREATE INDEX IF NOT EXISTS fill_unit_generation_run ON fill_unit_generation (run_id)',
];

/** The foreign keys the fill's own rows must satisfy: a generation belongs to a unit and a run, and a lease to a generation. */
const FOREIGN_KEYS: readonly { readonly table: string; readonly name: string; readonly columns: string; readonly ref: string; readonly refColumns: string }[] = [
  { table: 'fill_unit_generation', name: 'fill_unit_generation_unit_fk', columns: 'unit_id', ref: 'fill_unit', refColumns: 'unit_id' },
  { table: 'fill_unit_lease', name: 'fill_unit_lease_generation_fk', columns: 'unit_id, generation', ref: 'fill_unit_generation', refColumns: 'unit_id, generation' },
];

/** The statement that adds one foreign key where it does not stand yet; `NOT VALID` keeps an older store's rows while new ones are checked. */
const foreignKeySql = (key: (typeof FOREIGN_KEYS)[number]): string =>
  `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${key.name}') THEN ALTER TABLE ${key.table} ADD CONSTRAINT ${key.name} FOREIGN KEY (${key.columns}) REFERENCES ${key.ref} (${key.refColumns}) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED NOT VALID; END IF; END $$`;

export const fillStateSchema = {
  name: 'fill-state',
  async prepare(owner: DatabaseOwner): Promise<void> {
    await createSchemaOnce(owner, {
      name: 'fill-state',
      parts: [...SCHEMA, ...FOREIGN_KEYS.map(foreignKeySql)],
      tables: FILL_STATE_TABLES,
      create: async (executor) => {
        for (const statement of SCHEMA) await executor.query(statement);
        for (const key of FOREIGN_KEYS) await executor.query(foreignKeySql(key));
      },
    });
  },
};
