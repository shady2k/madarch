/** Graph core storage, decision 0039 items 25 and 28. */
import { sha256Hex } from '../../graph/digest.js';
import type { GraphContract } from '../../graph/contract.js';

export const SCHEMA_REVISION = 10;
export const METADATA_SCHEMA = [
  'CREATE SCHEMA IF NOT EXISTS madarch_meta',
  `CREATE TABLE IF NOT EXISTS madarch_meta.schema_stamp(name text PRIMARY KEY,stamp text NOT NULL,created_at timestamptz NOT NULL DEFAULT now())`,
] as const;
export const SCHEMA: readonly string[] = [
  `CREATE SEQUENCE IF NOT EXISTS graph_recorded_seq`,
  `CREATE OR REPLACE FUNCTION graph_next_recorded_sequence() RETURNS bigint LANGUAGE plpgsql AS $$ BEGIN
    PERFORM pg_advisory_xact_lock(739141, 1);
    RETURN nextval('graph_recorded_seq');
  END $$`,
  `CREATE TABLE IF NOT EXISTS entity (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL UNIQUE, sort text NOT NULL CHECK (sort IN ('node','edge')),
    repeats boolean NOT NULL DEFAULT false, discriminator text
  )`,
  `CREATE TABLE IF NOT EXISTS context (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    parent bigint REFERENCES context(id), ref text NOT NULL,
    parent_recorded_seq bigint,
    CHECK ((parent IS NULL AND parent_recorded_seq IS NULL) OR (parent IS NOT NULL AND parent_recorded_seq IS NOT NULL)),
    CHECK (parent IS NULL OR parent <> id)
  )`,
  `CREATE OR REPLACE FUNCTION graph_context_pin() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.parent IS NULL THEN
      IF NEW.parent_recorded_seq IS NOT NULL THEN
        RAISE EXCEPTION '${import.meta.path}:33: root context fence does not match its parent';
      END IF;
    ELSE
      IF NEW.parent_recorded_seq IS NOT NULL THEN
        RAISE EXCEPTION '${import.meta.path}:37: context fence is assigned by the database';
      END IF;
      NEW.parent_recorded_seq := graph_next_recorded_sequence();
    END IF;
    RETURN NEW;
  END $$`,
  `CREATE OR REPLACE TRIGGER context_pin_guard BEFORE INSERT ON context FOR EACH ROW EXECUTE FUNCTION graph_context_pin()`,
  `CREATE UNIQUE INDEX IF NOT EXISTS context_base ON context(ref) WHERE parent IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS context_child ON context(parent,ref) WHERE parent IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS node (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity_id bigint NOT NULL REFERENCES entity(id), uid uuid NOT NULL UNIQUE,
    key jsonb NOT NULL DEFAULT '{}'::jsonb,
    identity_scope uuid NOT NULL, context_id bigint NOT NULL DEFAULT 1 REFERENCES context(id)
  )`,
  `CREATE INDEX IF NOT EXISTS node_entity ON node(entity_id,id)`,
  `CREATE TABLE IF NOT EXISTS edge (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uid uuid NOT NULL UNIQUE, entity_id bigint NOT NULL REFERENCES entity(id),
    from_node bigint NOT NULL REFERENCES node(id), to_node bigint NOT NULL REFERENCES node(id),
    discriminator text NOT NULL DEFAULT '', context_id bigint NOT NULL DEFAULT 1 REFERENCES context(id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS edge_once ON edge(entity_id,from_node,to_node,discriminator,context_id)`,
  `CREATE INDEX IF NOT EXISTS edge_to ON edge(to_node,entity_id)`,
  `CREATE INDEX IF NOT EXISTS edge_from ON edge(from_node,entity_id)`,
  `CREATE TABLE IF NOT EXISTS assertion (
    assertion_id bigint PRIMARY KEY REFERENCES node(id),
    property text NOT NULL CHECK (property <> ''), language text,
    context_id bigint NOT NULL REFERENCES context(id),
    valid_from timestamptz NOT NULL, valid_to timestamptz,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    recorded_sequence bigint NOT NULL UNIQUE,
    operation text NOT NULL CHECK (operation IN ('assert','retract')),
    CHECK (valid_to IS NULL OR valid_to > valid_from)
  )`,
  `CREATE OR REPLACE FUNCTION graph_record_assertion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.recorded_sequence IS NOT NULL THEN
      RAISE EXCEPTION '${import.meta.path}:75: assertion recorded sequence is assigned by the database';
    END IF;
    NEW.recorded_sequence := graph_next_recorded_sequence();
    NEW.recorded_at := clock_timestamp();
    RETURN NEW;
  END $$`,
  `CREATE OR REPLACE TRIGGER assertion_record BEFORE INSERT ON assertion FOR EACH ROW EXECUTE FUNCTION graph_record_assertion()`,
  `CREATE TABLE IF NOT EXISTS assertion_vertex_subject (
    assertion_id bigint PRIMARY KEY REFERENCES assertion(assertion_id),
    subject_edge_id bigint NOT NULL UNIQUE REFERENCES edge(id)
  )`,
  `CREATE TABLE IF NOT EXISTS assertion_edge_subject (
    assertion_id bigint PRIMARY KEY REFERENCES assertion(assertion_id),
    edge_id bigint NOT NULL REFERENCES edge(id)
  )`,
  `CREATE INDEX IF NOT EXISTS assertion_edge_lookup ON assertion_edge_subject(edge_id,assertion_id)`,
  `CREATE INDEX IF NOT EXISTS assertion_slot ON assertion(property,context_id,recorded_sequence)`,
  `CREATE OR REPLACE FUNCTION graph_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    RAISE EXCEPTION '${import.meta.path}:67: immutable graph assertion history cannot be changed';
  END $$`,
  ...['context','node','edge','assertion','assertion_vertex_subject','assertion_edge_subject'].map(table =>
    `CREATE OR REPLACE TRIGGER immutable BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION graph_immutable()`),
  `CREATE OR REPLACE FUNCTION graph_subject_check() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE a bigint; total integer; BEGIN
      a := NEW.assertion_id;
      SELECT (SELECT count(*) FROM assertion_vertex_subject WHERE assertion_id = a) +
             (SELECT count(*) FROM assertion_edge_subject WHERE assertion_id = a) INTO total;
      IF total <> 1 THEN RAISE EXCEPTION '${import.meta.path}:77: assertion % requires exactly one subject', a; END IF;
      IF EXISTS (SELECT 1 FROM assertion_vertex_subject s JOIN edge e ON e.id=s.subject_edge_id
        JOIN entity k ON k.id=e.entity_id WHERE s.assertion_id=a AND (e.from_node <> a OR k.name <> 'system.assertion-subject')) THEN
        RAISE EXCEPTION '${import.meta.path}:80: invalid assertion subject edge';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.id=a AND k.name='system.assertion') THEN
        RAISE EXCEPTION '${import.meta.path}:83: assertion header requires a system.assertion vertex';
      END IF;
      IF (SELECT count(*) FROM edge e JOIN entity k ON k.id=e.entity_id WHERE e.from_node=a AND k.name='system.assertion-source') <> 1
        OR (SELECT count(*) FROM edge e JOIN entity k ON k.id=e.entity_id WHERE e.from_node=a AND k.name='system.assertion-author') <> 1
        OR (SELECT count(*) FROM edge e JOIN entity k ON k.id=e.entity_id WHERE e.from_node=a AND k.name='system.assertion-operation') <> 1 THEN
        RAISE EXCEPTION '${import.meta.path}:88: assertion requires source, author and operation edges';
      END IF;
      IF EXISTS (SELECT 1 FROM edge e JOIN entity k ON k.id=e.entity_id JOIN node target ON target.id=e.to_node JOIN entity tk ON tk.id=target.entity_id
        WHERE e.from_node=a AND ((k.name='system.assertion-source' AND tk.name NOT IN ('source','person','plugin','agent','agent-session'))
          OR (k.name='system.assertion-author' AND tk.name NOT IN ('source','person','plugin','agent','agent-session'))
          OR (k.name='system.assertion-operation' AND tk.name<>'system.operation')
          OR (k.name='system.assertion-unit' AND tk.name<>'system.unit'))) THEN
        RAISE EXCEPTION '${import.meta.path}:106: END_KIND_INVALID assertion lineage';
      END IF;
      RETURN NULL;
    END $$`,
  ...['assertion','assertion_vertex_subject','assertion_edge_subject'].map(table =>
    `CREATE CONSTRAINT TRIGGER subject_attachment AFTER INSERT ON ${table} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION graph_subject_check()`),
];

/** The full declaration and core revision define the prepared schema. */
export function graphSchemaStamp(contract: GraphContract): string {
  const declaration = JSON.stringify(contract, (_key, value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map(key => [key, object[key]]));
  });
  return sha256Hex(new TextEncoder().encode([String(SCHEMA_REVISION), ...SCHEMA, declaration].join('\n')));
}
