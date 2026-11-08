/**
 * The temporal graph's tables (decision 0028, "Tables" and "Time"): the
 * identities, the versions, the encoded vocabulary, the publication scopes one
 * producer names its units by (decision 0027) and the extraction queue's work
 * items, and nothing else. The module owns exactly these tables
 * (`GRAPH_TABLES`); the vector index and pg-boss's tables belong to other
 * modules.
 *
 * What the database itself refuses:
 * - two versions of one identity that overlap on valid time, recorded time and
 *   states (`EXCLUDE USING gist`, which needs `btree_gist` for the identity);
 * - a null or empty range (NOT NULL columns and checks);
 * - an update of a version other than the close of its `recorded_to`, and any
 *   delete (a trigger);
 * - content nodes whose bytes or digest differ between versions, and claims
 *   without a digest (a trigger);
 * - a second publication record of one work item (a trigger).
 */
import { createSchemaOnce } from '../adapters/schema-stamp.js';
import type { DatabaseOwner } from '../adapters/database-owner.js';
import { GraphError, databaseMessage } from './errors.js';
import { CODE_NODE_KINDS, CODE_PREFIX, CODE_RELATIONS, ENGINE_NODE_KINDS, ENGINE_PREFIX, ENGINE_RELATIONS } from './vocabulary.js';

/** The graph's own tables, in code-point order. */
export const GRAPH_TABLES = [
  'edge_identity',
  'edge_version',
  'node_identity',
  'node_kind',
  'node_version',
  'publication_scope',
  'relation_type',
  'work_item',
] as const;

const VERSION_COLUMNS = `
    valid_from timestamptz NOT NULL,
    valid_to timestamptz NOT NULL DEFAULT 'infinity',
    recorded_from timestamptz NOT NULL,
    recorded_to timestamptz NOT NULL DEFAULT 'infinity',
    states int8range NOT NULL,
    producer text NOT NULL CHECK (producer <> ''),
    scope_id bigint NOT NULL REFERENCES node_identity (id),
    opened_by bigint REFERENCES work_item (id),
    closed_by bigint REFERENCES work_item (id),
    closed_as text CHECK (closed_as IN ('correction', 'cascade')),
    payload_digest text NOT NULL CHECK (payload_digest <> ''),
    properties jsonb NOT NULL`;

const VERSION_CHECKS = `
    CHECK (valid_from < valid_to),
    CHECK (recorded_from < recorded_to),
    CHECK (valid_from <> 'infinity' AND recorded_from <> '-infinity' AND recorded_from <> 'infinity'),
    CHECK (NOT isempty(states) AND NOT lower_inf(states) AND NOT upper_inf(states) AND lower(states) >= 0),
    CHECK ((recorded_to = 'infinity') = (closed_as IS NULL)),
    CHECK ((closed_by IS NULL) OR (closed_as IS NOT NULL))`;

const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS node_kind (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    key text NOT NULL UNIQUE CHECK (key <> ''),
    namespace text NOT NULL CHECK (namespace IN ('engine', 'product')),
    registered_at timestamptz NOT NULL,
    CHECK ((namespace = 'engine') = (left(key, ${ENGINE_PREFIX.length}) = '${ENGINE_PREFIX}' OR left(key, ${CODE_PREFIX.length}) = '${CODE_PREFIX}'))
  )`,
  `CREATE TABLE IF NOT EXISTS relation_type (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    key text NOT NULL UNIQUE CHECK (key <> ''),
    namespace text NOT NULL CHECK (namespace IN ('engine', 'product')),
    discriminated boolean NOT NULL DEFAULT false,
    positioned boolean NOT NULL DEFAULT false,
    registered_at timestamptz NOT NULL,
    CHECK ((namespace = 'engine') = (left(key, ${ENGINE_PREFIX.length}) = '${ENGINE_PREFIX}' OR left(key, ${CODE_PREFIX.length}) = '${CODE_PREFIX}'))
  )`,
  `CREATE TABLE IF NOT EXISTS node_identity (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS edge_identity (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    key_hash text NOT NULL UNIQUE CHECK (length(key_hash) = 64)
  )`,
  // The stable identity one producer publishes one unit under (decision 0027's per-unit scope, decision
  // 0033's per-file units): the caller's key names it, and a later run of the unit finds the same node, so
  // its publication corrects its own versions rather than opening a second identity.
  `CREATE TABLE IF NOT EXISTS publication_scope (
    producer text NOT NULL CHECK (producer <> ''),
    scope_key text NOT NULL CHECK (scope_key <> ''),
    node_id bigint NOT NULL REFERENCES node_identity (id),
    last_generation bigint NOT NULL DEFAULT 0 CHECK (last_generation >= 0),
    PRIMARY KEY (producer, scope_key)
  )`,
  `CREATE TABLE IF NOT EXISTS work_item (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    producer text NOT NULL CHECK (producer <> ''),
    scope_id bigint NOT NULL REFERENCES node_identity (id),
    generation bigint NOT NULL CHECK (generation > 0),
    input_digest text NOT NULL CHECK (input_digest <> ''),
    lease_token text NOT NULL CHECK (lease_token <> ''),
    lease_until timestamptz NOT NULL,
    published_at timestamptz,
    published_digest text,
    UNIQUE (producer, scope_id, generation),
    CHECK ((published_at IS NULL) = (published_digest IS NULL))
  )`,
  `CREATE TABLE IF NOT EXISTS node_version (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    node_id bigint NOT NULL REFERENCES node_identity (id),
    kind_id bigint NOT NULL REFERENCES node_kind (id),
    label text NOT NULL,
    content bytea,
    content_sha256 text,
    claim_digest text,
    state_key bigint,${VERSION_COLUMNS},${VERSION_CHECKS},
    CHECK ((content IS NULL) = (content_sha256 IS NULL)),
    CHECK (content_sha256 IS NULL OR content_sha256 = encode(sha256(content), 'hex')),
    CHECK (claim_digest IS NULL OR length(claim_digest) = 64),
    CHECK (state_key IS NULL OR state_key >= 0),
    -- states-stable: a state key belongs to one state node for good and a state node keeps its key, whatever versions or writers come.
    CONSTRAINT node_version_state_key_one_node EXCLUDE USING gist (state_key WITH =, node_id WITH <>) WHERE (state_key IS NOT NULL),
    CONSTRAINT node_version_state_one_key EXCLUDE USING gist (node_id WITH =, state_key WITH <>) WHERE (state_key IS NOT NULL),
    -- content-immutable: one content node holds one digest, whatever versions or writers come.
    CONSTRAINT node_version_content_one_digest EXCLUDE USING gist (node_id WITH =, content_sha256 WITH <>) WHERE (content_sha256 IS NOT NULL),
    CONSTRAINT node_version_no_overlap EXCLUDE USING gist (
      node_id WITH =,
      tstzrange(valid_from, valid_to) WITH &&,
      tstzrange(recorded_from, recorded_to) WITH &&,
      states WITH &&
    )
  )`,
  `CREATE TABLE IF NOT EXISTS edge_version (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    edge_id bigint NOT NULL REFERENCES edge_identity (id),
    relation_type_id bigint NOT NULL REFERENCES relation_type (id),
    src_id bigint NOT NULL REFERENCES node_identity (id),
    dst_id bigint NOT NULL REFERENCES node_identity (id),
    discriminator text NOT NULL DEFAULT '',
    byte_start bigint,
    byte_end bigint,${VERSION_COLUMNS},${VERSION_CHECKS},
    CHECK ((byte_start IS NULL) = (byte_end IS NULL)),
    CHECK (byte_start IS NULL OR (byte_start >= 0 AND byte_end > byte_start)),
    CONSTRAINT edge_version_no_overlap EXCLUDE USING gist (
      edge_id WITH =,
      tstzrange(valid_from, valid_to) WITH &&,
      tstzrange(recorded_from, recorded_to) WITH &&,
      states WITH &&
    )
  )`,
  // Current reads (0028, "Reads"): partial indexes over what is believed now.
  `CREATE INDEX IF NOT EXISTS node_version_current ON node_version (node_id) WHERE recorded_to = 'infinity'`,
  `CREATE INDEX IF NOT EXISTS node_version_current_kind ON node_version (kind_id) WHERE recorded_to = 'infinity'`,
  `CREATE INDEX IF NOT EXISTS node_version_content ON node_version (content_sha256) WHERE content_sha256 IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS node_version_claim ON node_version (claim_digest) WHERE claim_digest IS NOT NULL`,
  // The wiki finds an entity by its logical key (the extract driver's \`recordKey\` property) on every page it draws.
  `CREATE INDEX IF NOT EXISTS node_version_record_key ON node_version ((properties->>'recordKey')) WHERE recorded_to = 'infinity'`,
  // The publication rechecks a unit's node keys and edge ends in one `= ANY` statement; this is its index.
  // It is the only index over `recordKey`: a read reaches it through the lens (`recorded_from <= $ AND
  // $ < recorded_to`), a predicate a partial index on `recorded_to = 'infinity'` does not imply, so a second
  // index with that predicate was maintained on every write and served no statement (madarch-8bdc.2.5).
  'CREATE INDEX IF NOT EXISTS node_version_record_key_all ON node_version ((properties->>\'recordKey\'))',
  // The static stages ask for one kind's nodes by one property, paged in node id order. Without an index on
  // the property a page walks the whole kind and filters each row, which grows with the graph; these are the
  // fields the stages ask by. They are schema fields, never product data.
  ...['file', 'globalName', 'path', 'range', 'repository', 'scope'].map((field) =>
    `CREATE INDEX IF NOT EXISTS node_version_prop_${field} ON node_version (kind_id, (properties->>'${field}'), node_id)`),
  'CREATE INDEX IF NOT EXISTS edge_version_prop_repository ON edge_version (relation_type_id, (properties->>\'repository\'), edge_id)',
  // The sweep of a complete publication (publish.ts) asks for the current versions of one producer and one
  // scope on every publication, and without an index over those two columns it read every page of the table
  // (madarch-8bdc.2.5, measured on 2.5 million node versions: 474 830 pages, 964 ms, for one unit's rows).
  `CREATE INDEX IF NOT EXISTS node_version_producer_scope ON node_version (producer, scope_id) WHERE recorded_to = 'infinity'`,
  `CREATE INDEX IF NOT EXISTS edge_version_producer_scope ON edge_version (producer, scope_id) WHERE recorded_to = 'infinity'`,
  `CREATE INDEX IF NOT EXISTS edge_version_current_src ON edge_version (src_id, relation_type_id) WHERE recorded_to = 'infinity'`,
  `CREATE INDEX IF NOT EXISTS edge_version_current_dst ON edge_version (dst_id, relation_type_id) WHERE recorded_to = 'infinity'`,
  `CREATE INDEX IF NOT EXISTS edge_version_current_edge ON edge_version (edge_id) WHERE recorded_to = 'infinity'`,
  // Historical reads: a GiST index over the two time ranges and the states. The node table needs no index of
  // its own: `node_version_no_overlap` is the same definition, the exclusion constraint's index, and the
  // planner uses it for a historical read (madarch-8bdc.2.5; stated in test/graph-index-duplicates.test.ts).
  `CREATE INDEX IF NOT EXISTS edge_version_history_src ON edge_version USING gist (src_id, tstzrange(valid_from, valid_to), tstzrange(recorded_from, recorded_to), states)`,
  `CREATE INDEX IF NOT EXISTS edge_version_history_dst ON edge_version USING gist (dst_id, tstzrange(valid_from, valid_to), tstzrange(recorded_from, recorded_to), states)`,
  // Two indexes this module once declared are gone, and a store that was created with them keeps them otherwise:
  // `node_version_history` duplicated the no-overlap constraint's index (same GiST definition, 488 MB on a
  // 2.5-million-version store) and `node_version_record_key` was a partial index no statement could use (above).
  // Each was maintained on every insert for no read, so the module drops them where they stand.
  'DROP INDEX IF EXISTS node_version_history',
  'DROP INDEX IF EXISTS node_version_record_key',
  `CREATE OR REPLACE FUNCTION graph_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'append-only: % version % cannot be deleted; a correction closes recorded_to and inserts the new belief', TG_TABLE_NAME, OLD.id;
    END IF;
    IF OLD.recorded_to <> 'infinity' OR NEW.recorded_to = 'infinity' OR NEW.closed_as IS NULL
       OR (to_jsonb(NEW) - 'recorded_to' - 'closed_by' - 'closed_as') <> (to_jsonb(OLD) - 'recorded_to' - 'closed_by' - 'closed_as') THEN
      RAISE EXCEPTION 'append-only: % version % can only be closed (recorded_to, closed_by, closed_as set once); no other column changes', TG_TABLE_NAME, OLD.id;
    END IF;
    RETURN NEW;
  END $$`,
  `CREATE OR REPLACE FUNCTION graph_node_version_checks() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE kind_key text;
  BEGIN
    SELECT key INTO kind_key FROM node_kind WHERE id = NEW.kind_id;
    IF kind_key = 'engine:content' THEN
      IF NEW.content IS NULL THEN
        RAISE EXCEPTION 'content-immutable: a content node (%) carries its bytes and their SHA-256', NEW.node_id;
      END IF;
      IF EXISTS (SELECT 1 FROM node_version o WHERE o.node_id = NEW.node_id AND o.content_sha256 <> NEW.content_sha256) THEN
        RAISE EXCEPTION 'content-immutable: node % already holds other bytes; a content node''s bytes and digest never change', NEW.node_id;
      END IF;
    ELSIF NEW.content IS NOT NULL THEN
      RAISE EXCEPTION 'content-immutable: only a content node carries bytes (node % is %)', NEW.node_id, kind_key;
    END IF;
    IF kind_key = 'engine:state' THEN
      IF NEW.state_key IS NULL OR NEW.state_key <> (NEW.properties->>'stateKey')::bigint THEN
        RAISE EXCEPTION 'states-stable: state node % must carry state_key equal to its properties.stateKey', NEW.node_id;
      END IF;
    ELSIF NEW.state_key IS NOT NULL THEN
      RAISE EXCEPTION 'states-stable: only a state node carries a state key (node % is %)', NEW.node_id, kind_key;
    END IF;
    IF kind_key = 'engine:claim' AND NEW.claim_digest IS NULL THEN
      RAISE EXCEPTION 'acceptance-bound: claim node % carries no revision digest', NEW.node_id;
    END IF;
    IF kind_key <> 'engine:claim' AND NEW.claim_digest IS NOT NULL THEN
      RAISE EXCEPTION 'acceptance-bound: only a claim carries a revision digest (node % is %)', NEW.node_id, kind_key;
    END IF;
    RETURN NEW;
  END $$`,
  `CREATE OR REPLACE FUNCTION graph_work_item_published_once() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF OLD.published_at IS NOT NULL THEN
      RAISE EXCEPTION 'fenced-publication: work item % (generation % of scope %) was already published and its record cannot change', OLD.id, OLD.generation, OLD.scope_id;
    END IF;
    IF NEW.producer <> OLD.producer OR NEW.scope_id <> OLD.scope_id OR NEW.generation <> OLD.generation THEN
      RAISE EXCEPTION 'fenced-publication: work item % cannot change its producer, scope or generation', OLD.id;
    END IF;
    RETURN NEW;
  END $$`,
];

const TRIGGERS: readonly { name: string; table: string; statement: string }[] = [
  { name: 'node_version_append_only', table: 'node_version', statement: 'BEFORE UPDATE OR DELETE ON node_version FOR EACH ROW EXECUTE FUNCTION graph_append_only()' },
  { name: 'edge_version_append_only', table: 'edge_version', statement: 'BEFORE UPDATE OR DELETE ON edge_version FOR EACH ROW EXECUTE FUNCTION graph_append_only()' },
  { name: 'node_version_checks', table: 'node_version', statement: 'BEFORE INSERT ON node_version FOR EACH ROW EXECUTE FUNCTION graph_node_version_checks()' },
  { name: 'work_item_published_once', table: 'work_item', statement: 'BEFORE UPDATE ON work_item FOR EACH ROW EXECUTE FUNCTION graph_work_item_published_once()' },
];

/**
 * Creates the graph's tables, its constraints and the engine's own
 * vocabulary; a second call changes nothing. The owner must have been
 * opened with `btreeGist: true`.
 */
export async function createGraphSchema(owner: DatabaseOwner, at: string): Promise<void> {
  // A schema that already stands is not made again: its forty DDL statements would lock the tables a reader reads for as
  // long as they run. `createSchemaOnce` holds the digest of what made it (`src/adapters/schema-stamp.ts`).
  await createSchemaOnce(owner, {
    name: 'graph',
    tables: GRAPH_TABLES,
    parts: [...SCHEMA, ...TRIGGERS.map((trigger) => `${trigger.name} ${trigger.statement}`), ...ENGINE_NODE_KINDS, ...CODE_NODE_KINDS, ...ENGINE_RELATIONS.map((relation) => relation.key), ...CODE_RELATIONS.map((relation) => relation.key)],
    create: async (tx) => {
      try {
        await tx.query('CREATE EXTENSION IF NOT EXISTS btree_gist');
      } catch (error) {
        throw new GraphError('create graph schema', 'extension btree_gist', `the database "${owner.location}" does not load btree_gist, which the no-overlap constraints need (open the owner with btreeGist: true): ${databaseMessage(error)}`);
      }
      for (const statement of SCHEMA) await tx.query(statement);
      for (const trigger of TRIGGERS) {
        const exists = await tx.query(`SELECT 1 FROM pg_trigger WHERE tgname = $1 AND tgrelid = $2::regclass`, [trigger.name, trigger.table]);
        if (exists.rows.length === 0) await tx.query(`CREATE TRIGGER ${trigger.name} ${trigger.statement}`);
      }
      for (const key of [...ENGINE_NODE_KINDS, ...CODE_NODE_KINDS]) {
        await tx.query(`INSERT INTO node_kind (key, namespace, registered_at) VALUES ($1, 'engine', $2::timestamptz) ON CONFLICT (key) DO NOTHING`, [key, at]);
      }
      for (const relation of [...ENGINE_RELATIONS, ...CODE_RELATIONS]) {
        await tx.query(
          `INSERT INTO relation_type (key, namespace, discriminated, positioned, registered_at) VALUES ($1, 'engine', $2, $3, $4::timestamptz) ON CONFLICT (key) DO NOTHING`,
          [relation.key, relation.discriminated === true, relation.positioned === true, at],
        );
      }
    },
  });
}
