/**
 * The one graph's mechanism (decision 0034, item 14): `kind`, `node`, `edge`,
 * claims, evidence, contexts and layers, the journal and the coverage gaps.
 * Every kind table is built from the product's manifest and the capability
 * that fills it (`contract.ts`); no name of a product's kind (file, commit,
 * touched …) stands in this module.
 *
 * What the database itself refuses here:
 * - two attributes of one kind on one key: each kind table's natural key is
 *   unique there, made by `contract.ts`;
 * - an edge of one kind between the same ends twice unless the kind says
 *   repeats are allowed and its discriminator tells them apart;
 * - an evidence row that names none or more than one of a vertex, an edge and
 *   a claim.
 */
import { createSchemaOnce } from '../adapters/schema-stamp.js';
import type { DatabaseOwner } from '../adapters/database-owner.js';
import { createContractTables, EMPTY_CONTRACT, generatedTableName, type GraphContract } from './contract.js';

/** The mechanism tables, in code-point order. */
export const ONE_GRAPH_TABLES = [
  'claim',
  'context',
  'edge',
  'evidence',
  'gap',
  'kind',
  'layer_entry',
  'node',
  'operation',
] as const;

const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS kind (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL UNIQUE CHECK (name <> ''),
    sort text NOT NULL CHECK (sort IN ('node', 'edge')),
    repeats boolean NOT NULL DEFAULT false,
    discriminator text CHECK (discriminator IS NULL OR discriminator <> ''),
    CHECK (sort = 'edge' OR NOT repeats),
    CHECK (repeats = (discriminator IS NOT NULL))
  )`,
  `CREATE TABLE IF NOT EXISTS node (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind_id bigint NOT NULL REFERENCES kind (id),
    uid uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE
  )`,
  `CREATE TABLE IF NOT EXISTS edge (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind_id bigint NOT NULL REFERENCES kind (id),
    from_node bigint NOT NULL REFERENCES node (id),
    to_node bigint NOT NULL REFERENCES node (id),
    discriminator text NOT NULL DEFAULT '',
    context_id bigint NOT NULL DEFAULT 1,
    CHECK (from_node <> to_node)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS edge_once ON edge (kind_id, from_node, to_node, discriminator, context_id)`,
  `CREATE INDEX IF NOT EXISTS edge_to ON edge (to_node, kind_id)`,
  `CREATE INDEX IF NOT EXISTS edge_from ON edge (from_node, kind_id)`,
  // A claim is an attribute a tool may dispute: its value, its producer and version, and its evidence. Every source is kept.
  `CREATE TABLE IF NOT EXISTS claim (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    node_id bigint NOT NULL REFERENCES node (id),
    attribute text NOT NULL CHECK (attribute <> ''),
    value jsonb NOT NULL,
    producer text NOT NULL CHECK (producer <> ''),
    producer_version text NOT NULL CHECK (producer_version <> ''),
    context_id bigint NOT NULL DEFAULT 1,
    stated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS claim_node_attribute ON claim (node_id, attribute, id)`,
  // Evidence names a vertex, an edge or a claim, exactly one of them (item 7).
  `CREATE TABLE IF NOT EXISTS evidence (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    node_id bigint REFERENCES node (id),
    edge_id bigint REFERENCES edge (id),
    claim_id bigint REFERENCES claim (id),
    commit_or_digest text,
    path_id bigint,
    line_start integer CHECK (line_start IS NULL OR line_start >= 1),
    line_end integer CHECK (line_end IS NULL OR line_end >= line_start),
    producer text NOT NULL CHECK (producer <> ''),
    CHECK (num_nonnulls(node_id, edge_id, claim_id) = 1),
    CHECK ((line_start IS NULL) = (line_end IS NULL))
  )`,
  `CREATE INDEX IF NOT EXISTS evidence_node ON evidence (node_id)`,
  `CREATE INDEX IF NOT EXISTS evidence_edge ON evidence (edge_id)`,
  `CREATE INDEX IF NOT EXISTS evidence_claim ON evidence (claim_id)`,
  // A context is a layer over its parent; the default branch's graph stands whole in the base context (item 8).
  `CREATE TABLE IF NOT EXISTS context (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    parent bigint REFERENCES context (id),
    ref text NOT NULL,
    CHECK (parent IS NULL OR id <> parent)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS context_base ON context (ref) WHERE parent IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS context_child ON context (parent, ref) WHERE parent IS NOT NULL`,
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
 * Creates the mechanism and, when a contract is given, the tables its kinds declare. A second call changes
 * nothing; a changed contract adds columns and keys, or refuses a change that would drop rows.
 */
export async function createOneGraphSchema(owner: DatabaseOwner, contract: GraphContract = EMPTY_CONTRACT): Promise<void> {
  await createSchemaOnce(owner, {
    name: 'one-graph',
    tables: ONE_GRAPH_TABLES,
    parts: [...SCHEMA, ...contract.vertex.map((kind) => `vertex ${kind.name} ${generatedTableName(kind.name, 'vertex')}`), ...contract.edge.map((kind) => `edge ${kind.name} ${generatedTableName(kind.name, 'edge')} ${String(kind.repeats)} ${kind.discriminator ?? ''}`), ...contract.dictionary.map((one) => `dictionary ${one.name} ${generatedTableName(one.name, 'dictionary')}`)],
    create: async (tx) => {
      for (const statement of SCHEMA) await tx.query(statement);
      // The base context is the default branch's whole graph; a branch and a worktree are later layers (item 8).
      const base = await tx.query<{ id: string }>('SELECT id::text AS id FROM context WHERE parent IS NULL ORDER BY id LIMIT 1');
      if (base.rows[0] === undefined) await tx.query(`INSERT INTO context (parent, ref) VALUES (NULL, '')`);
    },
  });
  await createContractTables(owner, contract);
}
