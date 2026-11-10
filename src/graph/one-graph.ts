/**
 * The one graph's mechanism (decision 0034, item 14; its amendment of 2026-11-10): `entity`,
 * `node`, `edge`, contexts and layers, the journal and the coverage gaps. Every entity's table is
 * built from the product's contract (`contract.ts`) and holds one row per opinion about one
 * vertex or edge; no name of a product's entity (file, commit, touched …) stands in this module.
 *
 * What the database itself refuses here:
 * - two vertices of one entity on one key in one context: `node` is unique by them;
 * - an edge of one entity between the same ends twice unless the entity says repeats are allowed
 *   and its discriminator tells them apart;
 * - an opinion whose state is none of open, confirmed and closed.
 */
import { createSchemaOnce } from '../adapters/schema-stamp.js';
import type { DatabaseOwner } from '../adapters/database-owner.js';
import { createContractTables, EMPTY_CONTRACT, generatedTableName, type GraphContract } from './contract.js';

/** The mechanism tables, in code-point order. */
export const ONE_GRAPH_TABLES = [
  'context',
  'edge',
  'entity',
  'gap',
  'layer_entry',
  'node',
  'operation',
] as const;

const SCHEMA: readonly string[] = [
  // A store made before the catalogue was renamed keeps its rows: the table is the same, its name is the owner's word
  // for it (decision 0034's amendment: «Сущность файл»).
  `DO $$ BEGIN
     IF to_regclass(current_schema() || '.kind') IS NOT NULL AND to_regclass(current_schema() || '.entity') IS NULL THEN
       ALTER TABLE kind RENAME TO entity;
     END IF;
   END $$`,
  `CREATE TABLE IF NOT EXISTS entity (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL UNIQUE CHECK (name <> ''),
    sort text NOT NULL CHECK (sort IN ('node', 'edge')),
    repeats boolean NOT NULL DEFAULT false,
    discriminator text CHECK (discriminator IS NULL OR discriminator <> ''),
    CHECK (sort = 'edge' OR NOT repeats),
    CHECK (repeats = (discriminator IS NOT NULL))
  )`,
  // A context is a layer over its parent; the default branch's graph stands whole in the base context (item 8).
  `CREATE TABLE IF NOT EXISTS context (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    parent bigint REFERENCES context (id),
    ref text NOT NULL,
    CHECK (parent IS NULL OR id <> parent)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS context_base ON context (ref) WHERE parent IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS context_child ON context (parent, ref) WHERE parent IS NOT NULL`,
  // A vertex is identity and key: the key belongs to the vertex, never to an opinion, and it is the same on every
  // machine because a producer names the entity by those values (decision 0034, item 2; A2 of the amendment).
  `CREATE TABLE IF NOT EXISTS node (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity_id bigint NOT NULL REFERENCES entity (id),
    uid uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    key jsonb NOT NULL DEFAULT '{}'::jsonb,
    context_id bigint NOT NULL DEFAULT 1 REFERENCES context (id),
    removed boolean NOT NULL DEFAULT false
  )`,
  `DO $$ BEGIN
     IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'node' AND column_name = 'kind_id') THEN
       ALTER TABLE node RENAME COLUMN kind_id TO entity_id;
     END IF;
   END $$`,
  `ALTER TABLE node ADD COLUMN IF NOT EXISTS key jsonb NOT NULL DEFAULT '{}'::jsonb`,
  `ALTER TABLE node ADD COLUMN IF NOT EXISTS context_id bigint NOT NULL DEFAULT 1 REFERENCES context (id)`,
  `ALTER TABLE node ADD COLUMN IF NOT EXISTS removed boolean NOT NULL DEFAULT false`,
  `CREATE UNIQUE INDEX IF NOT EXISTS node_key_context ON node (entity_id, key, context_id)`,
  `CREATE INDEX IF NOT EXISTS node_entity ON node (entity_id, id)`,
  `CREATE TABLE IF NOT EXISTS edge (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity_id bigint NOT NULL REFERENCES entity (id),
    from_node bigint NOT NULL REFERENCES node (id),
    to_node bigint NOT NULL REFERENCES node (id),
    discriminator text NOT NULL DEFAULT '',
    context_id bigint NOT NULL DEFAULT 1,
    CHECK (from_node <> to_node)
  )`,
  `DO $$ BEGIN
     IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'edge' AND column_name = 'kind_id') THEN
       ALTER TABLE edge RENAME COLUMN kind_id TO entity_id;
     END IF;
   END $$`,
  `CREATE UNIQUE INDEX IF NOT EXISTS edge_once ON edge (entity_id, from_node, to_node, discriminator, context_id)`,
  `CREATE INDEX IF NOT EXISTS edge_to ON edge (to_node, entity_id)`,
  `CREATE INDEX IF NOT EXISTS edge_from ON edge (from_node, entity_id)`,
  // The opinions of every vertex and edge stand in the tables the contract makes (`contract.ts`); the two tables that
  // held them one row per value are gone (A3 of the amendment), and a store made before this change lets them go: a
  // fill writes every opinion again from the producers that stated it.
  `DROP TABLE IF EXISTS evidence`,
  `DROP TABLE IF EXISTS claim`,
  `CREATE TABLE IF NOT EXISTS layer_entry (
    context_id bigint NOT NULL REFERENCES context (id),
    slot text NOT NULL CHECK (slot <> ''),
    replaces bigint,
    removed boolean NOT NULL DEFAULT false,
    PRIMARY KEY (context_id, slot)
  )`,
  // One journal for what people and the agent do: the authored and aspect tables are computed from it (item 10).
  `CREATE TABLE IF NOT EXISTS operation (
    id uuid PRIMARY KEY,
    author bigint REFERENCES node (id),
    machine text NOT NULL DEFAULT '',
    session text NOT NULL DEFAULT '',
    at timestamptz NOT NULL DEFAULT now(),
    words text NOT NULL DEFAULT '',
    expectation jsonb,
    change jsonb NOT NULL
  )`,
  // What a pass could not read, under the pass that read it (kept from the record store's explicit coverage gaps).
  `CREATE TABLE IF NOT EXISTS gap (
    repository_node bigint NOT NULL REFERENCES node (id),
    what text NOT NULL CHECK (what <> ''),
    reason text NOT NULL CHECK (reason IN ('non-utf8-path', 'shallow-history', 'unreadable')),
    producer text NOT NULL CHECK (producer IN ('tree', 'history')),
    PRIMARY KEY (repository_node, what)
  )`,
];

/**
 * Creates the mechanism and, when a contract is given, the tables its entities declare. A second call changes
 * nothing; a changed contract adds columns and keys, or refuses a change that would drop rows.
 */
export async function createOneGraphSchema(owner: DatabaseOwner, contract: GraphContract = EMPTY_CONTRACT): Promise<void> {
  await createSchemaOnce(owner, {
    name: 'one-graph',
    tables: ONE_GRAPH_TABLES,
    parts: [...SCHEMA, ...contract.vertex.map((kind) => `vertex ${kind.name} ${generatedTableName(kind.name, 'vertex')} ${kind.key.join(',')}`), ...contract.edge.map((kind) => `edge ${kind.name} ${generatedTableName(kind.name, 'edge')} ${String(kind.repeats)} ${kind.discriminator ?? ''}`), ...contract.dictionary.map((one) => `dictionary ${one.name} ${generatedTableName(one.name, 'dictionary')}`)],
    create: async (tx) => {
      for (const statement of SCHEMA) await tx.query(statement);
      // The base context is the default branch's whole graph; a branch and a worktree are later layers (item 8).
      const base = await tx.query<{ id: string }>('SELECT id::text AS id FROM context WHERE parent IS NULL ORDER BY id LIMIT 1');
      if (base.rows[0] === undefined) await tx.query(`INSERT INTO context (parent, ref) VALUES (NULL, '')`);
    },
  });
  await createContractTables(owner, contract);
}
