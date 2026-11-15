/** Preparation of the orchestrator's tables, constraints and plan migration. */
import type { DatabaseOwner } from '../database-owner.js';
import { createSchemaOnce } from '../schema-stamp.js';
import { ORCHESTRATOR_TABLES } from '../../fill/orchestrator-store.js';

const FILL_END_TABLE = `CREATE TABLE IF NOT EXISTS fill_end (
    run_id text PRIMARY KEY,
    state text NOT NULL,
    message text,
    unread jsonb,
    finished_at timestamptz NOT NULL DEFAULT now()
  )`;

const SCHEMA: readonly string[] = [
  FILL_END_TABLE,
  `CREATE TABLE IF NOT EXISTS fill_run_configuration (
    run_id text PRIMARY KEY,
    digest text NOT NULL,
    snapshot jsonb NOT NULL,
    recorded_at bigint NOT NULL
  )`,
  // The stages of one run that have planned (madarch-tzte.26.3): a stage whose
  // producers have settled inside the run plans then, so the record of which
  // stages planned is the run's resume point — a run that crashed between a
  // producer's publication and its consumer's planning plans the consumer when
  // it is driven again, and never plans a stage twice.
  `CREATE TABLE IF NOT EXISTS fill_run_stage (
    run_id text NOT NULL,
    stage_id text NOT NULL,
    planned_at bigint NOT NULL,
    units integer NOT NULL,
    publications integer NOT NULL,
    PRIMARY KEY (run_id, stage_id)
  )`,
  `CREATE TABLE IF NOT EXISTS fill_unit_plan (
    unit_id text NOT NULL,
    generation integer NOT NULL,
    run_id text NOT NULL,
    stage_id text NOT NULL,
    stage_unit_id text NOT NULL,
    scope text NOT NULL,
    stage_position integer NOT NULL,
    plan_position integer NOT NULL,
    planned_at bigint NOT NULL,
    PRIMARY KEY (unit_id, generation)
  )`,
  'CREATE INDEX IF NOT EXISTS fill_unit_plan_run ON fill_unit_plan (run_id)',
  `CREATE TABLE IF NOT EXISTS fill_event (
    run_id text NOT NULL,
    seq integer NOT NULL,
    at bigint NOT NULL,
    stage text NOT NULL,
    unit_id text NOT NULL,
    generation integer,
    kind text NOT NULL,
    summary text NOT NULL,
    PRIMARY KEY (run_id, seq)
  )`,
  `CREATE INDEX IF NOT EXISTS fill_event_unit_failure ON fill_event (unit_id, generation, seq DESC)
    WHERE kind IN ('unit-failed', 'unit-blocked', 'unit-cancelled')`,
  `CREATE INDEX IF NOT EXISTS fill_event_inherited_unit ON fill_event (run_id, unit_id, generation)
    WHERE kind = 'unit-inherited'`,
  `CREATE TABLE IF NOT EXISTS fill_unit_read (
    unit_id text NOT NULL,
    generation integer NOT NULL,
    query_digest text NOT NULL,
    query text NOT NULL,
    membership text NOT NULL,
    members integer NOT NULL,
    read_seq integer NOT NULL,
    at bigint NOT NULL,
    PRIMARY KEY (unit_id, generation, query_digest)
  )`,
  'CREATE INDEX IF NOT EXISTS fill_unit_read_sequence ON fill_unit_read (unit_id, generation, read_seq)',
  `CREATE TABLE IF NOT EXISTS fill_unit_split (
    parent_unit_id text NOT NULL,
    parent_generation integer NOT NULL,
    child_unit_id text NOT NULL,
    child_generation integer NOT NULL,
    sealed_at bigint NOT NULL,
    PRIMARY KEY (parent_unit_id, parent_generation, child_unit_id)
  )`,
  `CREATE TABLE IF NOT EXISTS fill_publication (
    unit_id text NOT NULL,
    generation integer NOT NULL,
    digest text NOT NULL,
    facts integer NOT NULL,
    published_at bigint NOT NULL,
    PRIMARY KEY (unit_id, generation)
  )`,
];

/**
 * The column a build before madarch-tzte.26.1 did not write: the versions that decided what a unit
 * reads and answers when it was planned — its stage's `id@version` and the stage's own prompt,
 * answer-schema and model versions — recorded with the plan, so a run that resolves another names the
 * one that moved instead of two digests. A plan row that holds none was written before it existed.
 */
const CACHE_VERSIONS_COLUMN = 'ALTER TABLE fill_unit_plan ADD COLUMN IF NOT EXISTS cache_versions jsonb';

/**
 * The tables this schema no longer holds (decision 0039, items 12 and 13): a
 * unit's writes go through the one writer while it runs, so there is no draft set
 * to keep, and a person's pause or stop is the run's own state, so there is no
 * control row to read. A store made before them drops them here, whole.
 */
const REMOVED: readonly string[] = [
  'DROP TABLE IF EXISTS fill_unit_draft_part',
  'DROP TABLE IF EXISTS fill_unit_draft',
  'DROP TABLE IF EXISTS fill_control',
];

/** The foreign keys the orchestrator's rows must satisfy: a run's stages, events and ends belong to the run, and every unit row to its generation. */
const FOREIGN_KEYS: readonly { readonly table: string; readonly name: string; readonly columns: string; readonly ref: string; readonly refColumns: string }[] = [
  { table: 'fill_run_configuration', name: 'fill_run_configuration_run_fk', columns: 'run_id', ref: 'fill_run', refColumns: 'run_id' },
  { table: 'fill_run_stage', name: 'fill_run_stage_run_fk', columns: 'run_id', ref: 'fill_run', refColumns: 'run_id' },
  { table: 'fill_event', name: 'fill_event_run_fk', columns: 'run_id', ref: 'fill_run', refColumns: 'run_id' },
  { table: 'fill_event', name: 'fill_event_generation_fk', columns: 'unit_id, generation', ref: 'fill_unit_generation', refColumns: 'unit_id, generation' },
  { table: 'fill_end', name: 'fill_end_run_fk', columns: 'run_id', ref: 'fill_run', refColumns: 'run_id' },
  { table: 'fill_unit_plan', name: 'fill_unit_plan_generation_fk', columns: 'unit_id, generation', ref: 'fill_unit_generation', refColumns: 'unit_id, generation' },
  { table: 'fill_unit_plan', name: 'fill_unit_plan_run_fk', columns: 'run_id', ref: 'fill_run', refColumns: 'run_id' },
  { table: 'fill_unit_read', name: 'fill_unit_read_generation_fk', columns: 'unit_id, generation', ref: 'fill_unit_generation', refColumns: 'unit_id, generation' },
  { table: 'fill_unit_split', name: 'fill_unit_split_parent_fk', columns: 'parent_unit_id, parent_generation', ref: 'fill_unit_generation', refColumns: 'unit_id, generation' },
  { table: 'fill_unit_split', name: 'fill_unit_split_child_fk', columns: 'child_unit_id, child_generation', ref: 'fill_unit_generation', refColumns: 'unit_id, generation' },
  { table: 'fill_publication', name: 'fill_publication_generation_fk', columns: 'unit_id, generation', ref: 'fill_unit_generation', refColumns: 'unit_id, generation' },
];

/** The statement that adds one foreign key where it does not stand yet; `NOT VALID` keeps an older store's rows while new ones are checked. */
const foreignKeySql = (key: (typeof FOREIGN_KEYS)[number]): string =>
  `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${key.name}') THEN ALTER TABLE ${key.table} ADD CONSTRAINT ${key.name} FOREIGN KEY (${key.columns}) REFERENCES ${key.ref} (${key.refColumns}) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED NOT VALID; END IF; END $$`;

export const orchestratorSchema = {
  name: 'orchestrator',
  async prepare(owner: DatabaseOwner): Promise<void> {
    await createSchemaOnce(owner, {
      name: 'orchestrator',
      parts: [...REMOVED, ...SCHEMA, ...FOREIGN_KEYS.map(foreignKeySql), CACHE_VERSIONS_COLUMN],
      tables: ORCHESTRATOR_TABLES,
      create: async (executor) => {
        for (const statement of REMOVED) await executor.query(statement);
        for (const statement of SCHEMA) await executor.query(statement);
        for (const key of FOREIGN_KEYS) await executor.query(foreignKeySql(key));
        await executor.query(CACHE_VERSIONS_COLUMN);
      },
    });
  },
};
