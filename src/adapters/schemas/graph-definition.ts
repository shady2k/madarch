/** Pure graph schema definition and fingerprint, shared by preparation and connection. */
import { sha256Hex } from '../../graph/digest.js';
import type { GraphContract } from '../../graph/contract.js';

/**
 * The revision of the graph's meaning, part of the stamp: a store whose revision differs is reset as a whole, because
 * what its rows say changed even where their shape did not. Revision 2 (madarch-64o5.2): a file's programming language
 * is an opinion field, `language`, not the opinion's `lang`, which is the natural language of a text value and stands
 * null for a language name; a file opinion written under revision 1 cannot be matched by the writer any more, and its
 * store is made again and filled. Revision 3: the store holds no table but the graph's and its mechanisms' —
 * `layer_entry`, `gap` and `knowledge_fill` are gone — and a store that still holds them is reset and filled once.
 * Revision 4: the product repository's files are mechanism state (`file_entry` beside its path and blob dictionaries),
 * so a store written under revision 3 holds no such table and is reset and filled once. Revision 5: a dangling edge's
 * row carries its discriminator (`unresolved_reference.edge_discriminator`), so two dangling edges of one kind and one
 * target are two rows; a store written under revision 4 is reset and filled once.
 */
/** Revision 6: repository files and history are ordinary declared plugin opinions, not mechanism tables. */
export const SCHEMA_REVISION = 6;

export const SCHEMA: readonly string[] = [
  // Every opinion's id is unique across the graph (the review of stage 1, finding 14): `{type: 'opinion', id}` has
  // one meaning in every entity's table.
  `CREATE SEQUENCE IF NOT EXISTS opinion_id`,
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
  // A vertex is identity and key: the key belongs to the vertex, never to an opinion, in one canonical encoding
  // (fields in the contract's key order, values normalised) and is the same on every machine (A2 of the amendment).
  `CREATE TABLE IF NOT EXISTS node (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity_id bigint NOT NULL REFERENCES entity (id),
    uid uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    key jsonb NOT NULL DEFAULT '{}'::jsonb,
    context_id bigint NOT NULL DEFAULT 1 REFERENCES context (id),
    removed boolean NOT NULL DEFAULT false
  )`,
  // A keyless vertex (a kind with no natural key) is keyed by nothing: it stands by its uid alone.
  `CREATE UNIQUE INDEX IF NOT EXISTS node_key_context ON node (entity_id, key, context_id) WHERE key <> '{}'::jsonb`,
  `CREATE INDEX IF NOT EXISTS node_key_lookup ON node USING gin (key jsonb_path_ops)`,
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
  `CREATE UNIQUE INDEX IF NOT EXISTS edge_once ON edge (entity_id, from_node, to_node, discriminator, context_id)`,
  `CREATE INDEX IF NOT EXISTS edge_to ON edge (to_node, entity_id)`,
  `CREATE INDEX IF NOT EXISTS edge_from ON edge (from_node, entity_id)`,
  // One journal of every change: each publication's unit, and every operation a person or the agent makes. Its author
  // is a producer and its version, `agent`, or `person:<uid>`; the change names the vertices, edges and opinions it
  // touched, by id (stage 2).
  `CREATE TABLE IF NOT EXISTS operation (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The journal's durable total order: a row's number is assigned when it is inserted, never by a clock, so the
    -- entries of one publication and of two publications are replayed in the order they were written (codex, stage 2
    -- review, P2). The time column is kept for a reader that shows when a row was written, never for order.
    seq bigint GENERATED BY DEFAULT AS IDENTITY,
    author text NOT NULL CHECK (author <> ''),
    machine text NOT NULL DEFAULT '',
    session text NOT NULL DEFAULT '',
    at timestamptz NOT NULL DEFAULT now(),
    words text NOT NULL DEFAULT '',
    expectation jsonb,
    change jsonb NOT NULL
  )`,
  // A reference to a key no vertex holds: the publication records it and goes on (A2; the consistency plugin
  // madarch-stm0.7 reads these). A rerun of the same answer records the same row once (nulls not distinct); the row
  // names its producer and, for an edge end, the edge kind and the other endpoint; and it goes when the reference
  // resolves.
  `CREATE TABLE IF NOT EXISTS unresolved_reference (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    referrer_node bigint REFERENCES node (id),
    edge_entity text,
    field text NOT NULL CHECK (field <> ''),
    target_entity text NOT NULL CHECK (target_entity <> ''),
    target_key jsonb NOT NULL,
    producer text NOT NULL CHECK (producer <> ''),
    against_node bigint REFERENCES node (id),
    edge_discriminator text,
    context_id bigint NOT NULL DEFAULT 1,
    at timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (referrer_node, edge_entity, field, target_entity, target_key, producer, against_node, edge_discriminator, context_id)
  )`,
  // A store made before the discriminator: the column is added, the old identity is replaced, and the rows keep their
  // place. The discriminator tells two dangling edges of one kind and one target apart.
  `ALTER TABLE unresolved_reference ADD COLUMN IF NOT EXISTS edge_discriminator text`,
  `UPDATE unresolved_reference SET edge_discriminator = '' WHERE edge_entity IS NOT NULL AND edge_discriminator IS NULL`,
  `DO $$ DECLARE held text; BEGIN
     SELECT conname INTO held FROM pg_constraint WHERE conrelid = 'unresolved_reference'::regclass AND contype = 'u';
     IF held IS NOT NULL THEN EXECUTE 'ALTER TABLE unresolved_reference DROP CONSTRAINT ' || quote_ident(held); END IF;
   END $$`,
  `CREATE UNIQUE INDEX IF NOT EXISTS unresolved_reference_identity ON unresolved_reference
     (referrer_node, edge_entity, field, target_entity, target_key, producer, against_node, edge_discriminator, context_id) NULLS NOT DISTINCT`,
];


/** Every declared property participates; object property insertion order does not change a contract. */
export function graphSchemaStamp(contract: GraphContract): string {
  const declaration = JSON.stringify(contract, (_key, value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, object[key]]));
  });
  const parts = [`revision ${String(SCHEMA_REVISION)}`, ...SCHEMA, declaration];
  return sha256Hex(new TextEncoder().encode(parts.join('\n')));
}
