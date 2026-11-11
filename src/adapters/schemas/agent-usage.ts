/** Store-owner preparation of agent usage tables. */
import type { DatabaseOwner } from '../database-owner.js';
import { createSchemaOnce } from '../schema-stamp.js';

/** The tables' names, in code point order, as the schema's stamp holds them. */
const TABLES = ['agent_usage'] as const;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS agent_usage (
    run_id text NOT NULL CHECK (run_id <> ''),
    unit text NOT NULL CHECK (unit <> ''),
    plugin text NOT NULL CHECK (plugin <> ''),
    plugin_version text NOT NULL CHECK (plugin_version <> ''),
    kind text NOT NULL CHECK (kind <> ''),
    field text NOT NULL DEFAULT '',
    model text,
    input_tokens bigint NOT NULL CHECK (input_tokens >= 0),
    output_tokens bigint NOT NULL CHECK (output_tokens >= 0),
    total_tokens bigint NOT NULL CHECK (total_tokens >= 0),
    cost_amount numeric(20, 6),
    cost_currency text,
    turns integer NOT NULL CHECK (turns >= 0),
    reported boolean NOT NULL,
    stopped text CHECK (stopped IS NULL OR stopped IN ('tokens', 'cost')),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((cost_amount IS NULL) = (cost_currency IS NULL)),
    CHECK (cost_currency IS NULL OR cost_currency <> '')
  )`,
  // One row per run, unit, kind, field and model: a model the agent reported no name for is one model, not every null
  // different from every other (`NULLS NOT DISTINCT`).
  `CREATE UNIQUE INDEX IF NOT EXISTS agent_usage_identity ON agent_usage (run_id, unit, kind, field, model) NULLS NOT DISTINCT`,
  // The kind's page reads the runs of one kind, newest first.
  `CREATE INDEX IF NOT EXISTS agent_usage_kind ON agent_usage (kind, updated_at)`,
];

/** Makes this module's table in a store that has none; a second call runs no DDL (`schema-stamp.ts`). */
async function prepare(owner: DatabaseOwner): Promise<void> {
  await createSchemaOnce(owner, {
    name: 'agent-usage',
    tables: TABLES,
    parts: SCHEMA,
    create: async (transaction) => {
      for (const statement of SCHEMA) await transaction.query(statement);
    },
  });
}

export const agentUsageSchema = { name: 'agent-usage', prepare };
