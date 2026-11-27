/** Graph core storage, decision 0039 items 25 and 28. */
import { sha256Hex } from '../../graph/digest.js';
import type { GraphContract } from '../../graph/contract.js';
import { endpointKindNames, assertionValueTableName, type FieldContract } from '../../graph/contract.js';
import { withAssertionContract } from '../../graph/system-contract.js';

export const GRAPH_CHECK_STATS = `SELECT coalesce(jsonb_object_agg(funcname, counters), '{}'::jsonb) AS stats FROM (
  SELECT funcname, jsonb_build_object('calls', sum(calls), 'total_ms', sum(total_time), 'self_ms', sum(self_time)) AS counters
  FROM pg_stat_xact_user_functions WHERE funcname IN ('graph_relations_check', 'graph_checks_pass') GROUP BY funcname
) functions`;

/** Session-local measurement objects; never part of the prepared product graph or its stamp. */
export const GRAPH_CHECK_DIAGNOSTIC_SCHEMA = `CREATE TEMP TABLE madarch_graph_check_trace (stats jsonb) ON COMMIT PRESERVE ROWS;
    CREATE FUNCTION pg_temp.madarch_graph_check_trace() RETURNS trigger LANGUAGE plpgsql AS $trace$
    DECLARE measured jsonb;
    BEGIN
      SELECT stats INTO measured FROM (${GRAPH_CHECK_STATS}) measured_stats;
      UPDATE pg_temp.madarch_graph_check_trace SET stats = measured;
      RETURN NULL;
    END $trace$;
    CREATE CONSTRAINT TRIGGER madarch_graph_check_trace AFTER INSERT ON madarch_graph_check_trace
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pg_temp.madarch_graph_check_trace()`;

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
    CHECK (parent_recorded_seq IS NULL OR (parent IS NOT NULL AND parent_recorded_seq >= 0)),
    CHECK (parent IS NULL OR parent <> id)
  )`,
  `CREATE OR REPLACE FUNCTION graph_context_pin() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.parent IS NULL THEN
      IF NEW.parent_recorded_seq IS NOT NULL THEN
        RAISE EXCEPTION '${import.meta.path}:33: root context fence does not match its parent';
      END IF;
    ELSE
      IF NEW.parent_recorded_seq = -1 THEN
        NEW.parent_recorded_seq := graph_next_recorded_sequence();
      ELSIF NEW.parent_recorded_seq IS NOT NULL THEN
        RAISE EXCEPTION '${import.meta.path}:37: context fence is assigned by the database';
      END IF;
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

];

function sqlType(field: FieldContract): string {
  switch (field.type) {
    case 'text': return 'text';
    case 'integer': return 'integer';
    case 'bigint': return 'bigint';
    case 'boolean': return 'boolean';
    case 'timestamp': return 'timestamptz';
    case 'json': return 'jsonb';
  }
}

interface ContractTrigger {
  readonly table: string;
  readonly name: string;
  readonly fn: string;
  readonly type: number;
  readonly deferred: boolean;
  readonly statement: string;
}

/** One pure source for the installed SQL and the schema fingerprint. */
export function generateContractStatements(declared: GraphContract) {
    const compare = (a: {name:string}, b: {name:string}) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    const inherited = withAssertionContract(declared);
    const contract = {...inherited, vertex:[...inherited.vertex].sort(compare),edge:[...inherited.edge].sort(compare)};
    const statements: string[] = [];
    const triggers: ContractTrigger[] = [];
    const entities: {name:string;sort:string;repeats:boolean;discriminator:string|null}[] = [];
    const trigger = (table:string,name:string,fn:string,type:number,deferred:boolean,statement:string):void => {
      triggers.push({table,name,fn,type,deferred,statement});
    };
    statements.push(`DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='edge'::regclass AND conname='edge_check'
        AND contype='c' AND pg_get_constraintdef(oid)='CHECK ((from_node <> to_node))') THEN
        ALTER TABLE edge DROP CONSTRAINT edge_check;
      END IF;
    END $$`);
    const valueChecks: string[] = [];
    const keyChecks: string[] = [];
    const keyedKinds = contract.vertex.filter(kind => kind.key.length > 0);
    const valueTables = (sort: 'vertex'|'edge') => Object.fromEntries(contract[sort].map(kind => [kind.name,
      Object.fromEntries(['$exists',...kind.fields.map(field => field.name)].map(property => [property,assertionValueTableName(kind.name,sort,property)]))]));
    const names: string[] = [];
    const lookups: string[] = [];
    for (const sort of ['vertex','edge'] as const) {
      for (const kind of contract[sort]) {
        entities.push({name:kind.name,sort:sort === 'vertex' ? 'node':'edge',repeats:sort === 'edge' ? ('repeats' in kind && kind.repeats):false,discriminator:'discriminator' in kind ? kind.discriminator ?? null:null});
        const fields: readonly FieldContract[] = [{name:'$exists',type:'boolean'}, ...kind.fields];
        for (const field of fields) {
          const table = assertionValueTableName(kind.name,sort,field.name);
          names.push(table);
          if (field.lookup === true) lookups.push(table);
          statements.push(`CREATE TABLE IF NOT EXISTS "${table}" (assertion_id bigint PRIMARY KEY REFERENCES assertion(assertion_id), value ${sqlType(field)}${field.nullable === true ? '' : ' NOT NULL'})`);
          trigger(table, 'immutable', 'graph_immutable', 27, false,
        `CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON "${table}" FOR EACH ROW EXECUTE FUNCTION graph_immutable()`);
          const literal = (value: string): string => "'" + value.split("'").join("''") + "'";
          valueChecks.push(`IF touched_value_tables ? ${literal(table)} OR required_values ? ${literal(table)} THEN
            SELECT id,code INTO candidate_id,candidate_code FROM (
            SELECT v.assertion_id AS id,43 AS code FROM (SELECT * FROM "${table}" WHERE assertion_id>=node_lower OFFSET 0) v
              WHERE expected_values->>v.assertion_id::text IS DISTINCT FROM ${literal(table)}
            UNION ALL SELECT checked.id,60 FROM jsonb_array_elements_text(required_values->${literal(table)}) wanted(id)
              CROSS JOIN LATERAL (SELECT wanted.id::bigint AS id) checked
              WHERE NOT EXISTS(SELECT 1 FROM "${table}" v WHERE v.assertion_id=checked.id OFFSET 0)
            ) failures ORDER BY id,code DESC LIMIT 1;
            IF candidate_id IS NOT NULL AND (bad_id IS NULL OR (candidate_id,-candidate_code)<(bad_id,-violation)) THEN
              bad_id:=candidate_id; violation:=candidate_code;
            END IF; END IF;`);
          if (sort === 'vertex' && 'key' in kind && kind.key.includes(field.name)) {
            const projected = field.type === 'json' ? `n.key->${literal(field.name)}` : `(n.key->>${literal(field.name)})::${sqlType(field)}`;
            keyChecks.push(`SELECT n.id,${literal(kind.name)}::text AS kind,${literal(field.name)}::text AS property
              FROM jsonb_array_elements_text(changed_keys->${literal(kind.name)}) changed(id) CROSS JOIN LATERAL (SELECT * FROM node WHERE id=changed.id::bigint AND entity_id=(SELECT id FROM entity WHERE name=${literal(kind.name)}) OFFSET 0) n CROSS JOIN LATERAL (
                SELECT count(v.assertion_id) AS total,
                  bool_or(a.operation<>'assert' OR a.language IS NOT NULL OR v.value IS DISTINCT FROM ${projected}) AS contradictory
                FROM (SELECT id FROM edge WHERE to_node=n.id OFFSET 0) attachment
                CROSS JOIN LATERAL (SELECT assertion_id FROM assertion_vertex_subject WHERE subject_edge_id=attachment.id OFFSET 0) s
                CROSS JOIN LATERAL (SELECT * FROM assertion WHERE assertion_id=s.assertion_id OFFSET 0) a
                LEFT JOIN LATERAL (SELECT * FROM "${table}" WHERE assertion_id=a.assertion_id OFFSET 0) v ON true
                WHERE a.property=${literal(field.name)}
              ) checked
              WHERE n.entity_id=(SELECT id FROM entity WHERE name=${literal(kind.name)})
                AND (NOT (n.key ? ${literal(field.name)}) OR checked.total=0 OR checked.contradictory)`);
          }
        }
      }
    }

    // Deferred checks see the final operation, never a half-created child (0039.28).
    const literal = (value: string): string => "'" + value.split("'").join("''") + "'";
    for (const sort of ['vertex','edge'] as const) {
      const setBranches = contract[sort].map(kind => {
        const valueTable = assertionValueTableName(kind.name,sort,'$exists');
        const subject = sort === 'vertex'
          ? 'JOIN assertion_vertex_subject s ON s.assertion_id=a.assertion_id JOIN edge se ON se.id=s.subject_edge_id'
          : 'JOIN assertion_edge_subject s ON s.assertion_id=a.assertion_id';
        const id = sort === 'vertex' ? 'se.to_node' : 's.edge_id';
        const readerLayers = `WITH RECURSIVE layers AS (
          SELECT c.id,c.parent,c.parent_recorded_seq,NULL::bigint AS cutoff,0 AS depth FROM context c WHERE c.id=ctx
          UNION ALL SELECT c.id,c.parent,c.parent_recorded_seq,least(l.cutoff,l.parent_recorded_seq),l.depth+1 FROM context c JOIN layers l ON c.id=l.parent
        )`;
        const layers = `WITH RECURSIVE layers AS (
          SELECT c.id,c.parent,c.parent_recorded_seq,NULL::bigint AS cutoff,0 AS depth FROM unnest(ARRAY[ctx]) root(id) CROSS JOIN LATERAL (SELECT id,parent,parent_recorded_seq FROM context WHERE id=root.id OFFSET 0) c
          UNION ALL SELECT c.id,c.parent,c.parent_recorded_seq,least(l.cutoff,l.parent_recorded_seq),l.depth+1 FROM layers l CROSS JOIN LATERAL (SELECT id,parent,parent_recorded_seq FROM context WHERE id=l.parent OFFSET 0) c
        )`;
        if (sort==='vertex' && kind.name==='system.assertion') return `WHEN ${literal(kind.name)} THEN RETURN QUERY
          ${readerLayers} SELECT a.assertion_id FROM assertion a JOIN layers layer ON layer.id=a.context_id AND (wanted_subjects IS NULL OR a.assertion_id=ANY(wanted_subjects))
          AND (layer.cutoff IS NULL OR a.recorded_sequence<=layer.cutoff);`;
        const targetAssertions = sort === 'vertex'
          ? 'SELECT s.assertion_id FROM edge se CROSS JOIN LATERAL (SELECT av.assertion_id FROM assertion_vertex_subject av WHERE av.subject_edge_id=se.id OFFSET 0) s WHERE se.to_node=ANY(wanted_subjects) AND se.entity_id=(SELECT id FROM entity WHERE name=\'system.assertion-subject\')'
          : 'SELECT s.assertion_id FROM assertion_edge_subject s WHERE s.edge_id=ANY(wanted_subjects)';
        const boundedSubject = sort === 'vertex'
          ? 'CROSS JOIN LATERAL (SELECT subject_edge_id FROM assertion_vertex_subject WHERE assertion_id=a.assertion_id OFFSET 0) s CROSS JOIN LATERAL (SELECT to_node FROM edge WHERE id=s.subject_edge_id OFFSET 0) se'
          : 'CROSS JOIN LATERAL (SELECT edge_id FROM assertion_edge_subject WHERE assertion_id=a.assertion_id OFFSET 0) s';
        const activeQuery = (bounded: boolean): string => `          RETURN QUERY ${bounded ? layers : readerLayers}${bounded ? `, target_assertions AS MATERIALIZED (${targetAssertions})` : ''}, visible AS (
            SELECT ${id} AS subject_id,source.to_node AS source_id,an.uid AS assertion_uid,a.operation,v.value,a.valid_from,a.valid_to,a.recorded_sequence,
              layer.depth,min(layer.depth) OVER (PARTITION BY ${id},source.to_node) AS nearest
            FROM ${bounded ? 'target_assertions target CROSS JOIN LATERAL (SELECT header.* FROM assertion header WHERE header.assertion_id=target.assertion_id OFFSET 0) a' : 'assertion a'} ${bounded ? boundedSubject + ' CROSS JOIN LATERAL (SELECT uid FROM node WHERE id=a.assertion_id OFFSET 0) an' : subject + ' JOIN node an ON an.id=a.assertion_id'}
            JOIN layers layer ON layer.id=a.context_id AND (layer.cutoff IS NULL OR a.recorded_sequence<=layer.cutoff)
            ${bounded ? 'CROSS JOIN LATERAL (SELECT to_node FROM edge WHERE from_node=a.assertion_id AND entity_id=source_kind_id OFFSET 0) source' : "JOIN edge source ON source.from_node=a.assertion_id JOIN entity sk ON sk.id=source.entity_id AND sk.name='system.assertion-source'"}
            ${bounded ? `LEFT JOIN LATERAL (SELECT value FROM "${valueTable}" WHERE assertion_id=a.assertion_id OFFSET 0) v ON true` : `LEFT JOIN "${valueTable}" v ON v.assertion_id=a.assertion_id`}
            WHERE a.property='$exists' ${bounded ? '' : `AND (wanted_subjects IS NULL OR ${id}=ANY(wanted_subjects))`}
          ), current_stream AS (
            SELECT DISTINCT ON (subject_id,source_id) subject_id,assertion_uid,operation,value,valid_from,recorded_sequence FROM visible
            WHERE depth=nearest AND ${bounded ? "valid_from<snapshot_at+interval '1 millisecond'" : "date_trunc('milliseconds',valid_from)<=snapshot_at"} AND (valid_to IS NULL OR ${bounded ? "valid_to>=snapshot_at+interval '1 millisecond'" : "date_trunc('milliseconds',valid_to)>snapshot_at"})
            ORDER BY subject_id,source_id,recorded_sequence DESC
          ), candidates AS (SELECT DISTINCT ON (subject_id) * FROM current_stream WHERE operation='assert' ORDER BY subject_id,valid_from DESC,recorded_sequence DESC,assertion_uid DESC)
          SELECT subject_id FROM candidates WHERE value=TRUE;`;
        return `WHEN ${literal(kind.name)} THEN
          snapshot_at := date_trunc('milliseconds',coalesce(instant,clock_timestamp()));
          IF wanted_subjects IS NULL THEN ${activeQuery(false)} ELSE ${activeQuery(true)} END IF;`;
      });
      statements.push(`DROP FUNCTION IF EXISTS graph_${sort}_active_ids(text,bigint,bigint)`);
      statements.push(`CREATE OR REPLACE FUNCTION graph_${sort}_active_ids_batch(kind text,ctx bigint,wanted_subjects bigint[],instant timestamptz,source_kind_id bigint) RETURNS SETOF bigint LANGUAGE plpgsql AS $$
        DECLARE snapshot_at timestamptz; BEGIN
        IF wanted_subjects IS NOT NULL AND source_kind_id IS NULL THEN SELECT id INTO source_kind_id FROM entity WHERE name='system.assertion-source'; END IF;
        CASE kind ${setBranches.join(' ')} ELSE RETURN; END CASE; END $$`);
      statements.push(`CREATE OR REPLACE FUNCTION graph_${sort}_active_ids(kind text,ctx bigint,wanted_subject bigint DEFAULT NULL,instant timestamptz DEFAULT NULL,source_kind_id bigint DEFAULT NULL) RETURNS SETOF bigint LANGUAGE sql AS $$
        SELECT * FROM graph_${sort}_active_ids_batch(kind,ctx,CASE WHEN wanted_subject IS NULL THEN NULL::bigint[] ELSE ARRAY[wanted_subject] END,instant,source_kind_id)
      $$`);
      statements.push(`CREATE OR REPLACE FUNCTION graph_${sort}_active(subject bigint,kind text,ctx bigint) RETURNS boolean LANGUAGE sql AS $$
        SELECT EXISTS(SELECT 1 FROM graph_${sort}_active_ids(kind,ctx,subject) active(id) WHERE active.id=subject)
      $$`);
    }
    // 0039.20/32: immutable aliases and endpoints, selected through graph merge records.
    statements.push(`CREATE OR REPLACE FUNCTION graph_merge_target(subject bigint,ctx bigint,valid_at timestamptz DEFAULT clock_timestamp(),recorded_cutoff timestamptz DEFAULT clock_timestamp()) RETURNS bigint LANGUAGE plpgsql STABLE AS $$
      BEGIN
        IF NOT EXISTS(SELECT 1 FROM node WHERE entity_id=(SELECT id FROM entity WHERE name='system.merge')) THEN RETURN subject; END IF;
        RETURN (WITH RECURSIVE layers AS (
          SELECT c.id,c.parent,c.parent_recorded_seq,NULL::bigint AS cutoff,0 AS depth FROM context c WHERE c.id=ctx
          UNION ALL SELECT c.id,c.parent,c.parent_recorded_seq,least(l.cutoff,l.parent_recorded_seq),l.depth+1 FROM context c JOIN layers l ON c.id=l.parent
        ), visible_states AS (
          SELECT attachment.to_node AS merge_id,a.operation,v.value,a.valid_from,a.valid_to,a.recorded_sequence,l.depth,
            min(l.depth) OVER (PARTITION BY attachment.to_node) AS nearest
          FROM assertion a JOIN assertion_vertex_subject av ON av.assertion_id=a.assertion_id
          JOIN edge attachment ON attachment.id=av.subject_edge_id
          LEFT JOIN "${assertionValueTableName('system.merge','vertex','state')}" v ON v.assertion_id=a.assertion_id
          JOIN layers l ON l.id=a.context_id AND (l.cutoff IS NULL OR a.recorded_sequence<=l.cutoff)
          WHERE a.property='state' AND a.recorded_at<=recorded_cutoff
            AND EXISTS(SELECT 1 FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.id=attachment.to_node AND k.name='system.merge')
        ), states AS (
          SELECT DISTINCT ON (merge_id) merge_id,CASE WHEN operation='assert' THEN value ELSE NULL END AS value
          FROM visible_states WHERE depth=nearest AND valid_from<=valid_at AND (valid_to IS NULL OR valid_to>valid_at)
          ORDER BY merge_id,recorded_sequence DESC
        ), membership AS (
          SELECT e.from_node AS merge_id,e.to_node AS member FROM states JOIN edge e ON e.from_node=states.merge_id JOIN entity k ON k.id=e.entity_id AND k.name='system.merge-member' WHERE states.value='ACTIVE'
        ), component(id) AS (
          SELECT subject UNION SELECT b.member FROM component c JOIN membership a ON a.member=c.id JOIN membership b ON b.merge_id=a.merge_id
        ) SELECT n.id FROM component c JOIN node n ON n.id=c.id ORDER BY (n.key<>'{}'::jsonb) DESC,n.id,n.uid LIMIT 1);
      END $$`);
    statements.push(`CREATE OR REPLACE FUNCTION graph_assertion_target(subject bigint,assertion bigint,ctx bigint,valid_at timestamptz,recorded_cutoff timestamptz,side text DEFAULT NULL) RETURNS bigint LANGUAGE plpgsql STABLE AS $$
      BEGIN
      IF NOT EXISTS(SELECT 1 FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='system.merge-allocation') THEN RETURN graph_merge_target(subject,ctx,valid_at,recorded_cutoff); END IF;
      RETURN (WITH RECURSIVE layers AS (
        SELECT c.id,c.parent,c.parent_recorded_seq,NULL::bigint AS cutoff,0 AS depth FROM context c WHERE c.id=ctx
        UNION ALL SELECT c.id,c.parent,c.parent_recorded_seq,least(l.cutoff,l.parent_recorded_seq),l.depth+1 FROM context c JOIN layers l ON c.id=l.parent
      ), visible_metadata AS (
        SELECT attachment.to_node AS id,a.property,a.operation,a.assertion_id,a.valid_from,a.valid_to,a.recorded_sequence,l.depth,
          min(l.depth) OVER (PARTITION BY attachment.to_node,a.property) AS nearest
        FROM assertion a JOIN assertion_vertex_subject av ON av.assertion_id=a.assertion_id JOIN edge attachment ON attachment.id=av.subject_edge_id
        JOIN node metadata_node ON metadata_node.id=attachment.to_node JOIN entity metadata_kind ON metadata_kind.id=metadata_node.entity_id
          AND metadata_kind.name IN ('system.merge','system.merge-allocation')
        JOIN layers l ON l.id=a.context_id AND (l.cutoff IS NULL OR a.recorded_sequence<=l.cutoff)
        WHERE a.recorded_at<=recorded_cutoff AND a.property IN ('state','$exists','direction')
      ), metadata AS (
        SELECT DISTINCT ON (id,property) id,property,operation,assertion_id FROM visible_metadata
        WHERE depth=nearest AND valid_from<=valid_at AND (valid_to IS NULL OR valid_to>valid_at)
        ORDER BY id,property,recorded_sequence DESC
      ) SELECT graph_merge_target(coalesce((
        SELECT member.to_node FROM edge allocation JOIN entity ak ON ak.id=allocation.entity_id AND ak.name='system.merge-allocation-assertion'
        JOIN edge member ON member.from_node=allocation.from_node JOIN entity mk ON mk.id=member.entity_id AND mk.name='system.merge-allocation-member'
        JOIN edge link ON link.from_node=allocation.from_node JOIN entity lk ON lk.id=link.entity_id AND lk.name='system.merge-allocation-merge'
        JOIN metadata state_meta ON state_meta.id=link.to_node AND state_meta.property='state' AND state_meta.operation='assert'
        JOIN "${assertionValueTableName('system.merge','vertex','state')}" state ON state.assertion_id=state_meta.assertion_id AND state.value='UNDONE'
        JOIN metadata born ON born.id=allocation.from_node AND born.property='$exists' AND born.operation='assert'
        JOIN "${assertionValueTableName('system.merge-allocation','vertex','$exists')}" existence ON existence.assertion_id=born.assertion_id AND existence.value=true
        LEFT JOIN metadata direction_meta ON direction_meta.id=allocation.from_node AND direction_meta.property='direction' AND direction_meta.operation='assert'
        LEFT JOIN "${assertionValueTableName('system.merge-allocation','vertex','direction')}" direction ON direction.assertion_id=direction_meta.assertion_id
        WHERE allocation.to_node=assertion AND (side IS NULL AND direction.value IS NULL OR direction.value=side)
        ORDER BY born.assertion_id DESC LIMIT 1
      ),subject),ctx,valid_at,recorded_cutoff));
      END $$`);
    statements.push(`CREATE OR REPLACE FUNCTION graph_edge_endpoint(relation bigint,endpoint bigint,side text,ctx bigint,valid_at timestamptz,recorded_cutoff timestamptz) RETURNS bigint LANGUAGE plpgsql STABLE AS $$
      BEGIN
      IF NOT EXISTS(SELECT 1 FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='system.merge-allocation') THEN RETURN graph_merge_target(endpoint,ctx,valid_at,recorded_cutoff); END IF;
      RETURN coalesce((WITH RECURSIVE layers AS (
        SELECT c.id,c.parent,c.parent_recorded_seq,NULL::bigint AS cutoff,0 AS depth FROM context c WHERE c.id=ctx
        UNION ALL SELECT c.id,c.parent,c.parent_recorded_seq,least(l.cutoff,l.parent_recorded_seq),l.depth+1 FROM context c JOIN layers l ON c.id=l.parent
      ) SELECT graph_assertion_target(endpoint,ae.assertion_id,ctx,valid_at,recorded_cutoff,side)
        FROM assertion_edge_subject ae JOIN assertion a ON a.assertion_id=ae.assertion_id
        JOIN layers al ON al.id=a.context_id AND (al.cutoff IS NULL OR a.recorded_sequence<=al.cutoff)
        JOIN edge allocation ON allocation.to_node=ae.assertion_id JOIN entity ak ON ak.id=allocation.entity_id AND ak.name='system.merge-allocation-assertion'
        JOIN assertion_vertex_subject av ON true JOIN edge attachment ON attachment.id=av.subject_edge_id AND attachment.to_node=allocation.from_node
        JOIN assertion direction_assertion ON direction_assertion.assertion_id=av.assertion_id
        JOIN layers dl ON dl.id=direction_assertion.context_id AND (dl.cutoff IS NULL OR direction_assertion.recorded_sequence<=dl.cutoff)
        JOIN "${assertionValueTableName('system.merge-allocation','vertex','direction')}" direction ON direction.assertion_id=av.assertion_id AND direction.value=side
        WHERE ae.edge_id=relation AND a.recorded_at<=recorded_cutoff AND a.valid_from<=valid_at AND (a.valid_to IS NULL OR a.valid_to>valid_at)
          AND graph_assertion_target(endpoint,ae.assertion_id,ctx,valid_at,recorded_cutoff,side)<>graph_merge_target(endpoint,ctx,valid_at,recorded_cutoff)
          AND direction_assertion.recorded_at<=recorded_cutoff AND direction_assertion.valid_from<=valid_at AND (direction_assertion.valid_to IS NULL OR direction_assertion.valid_to>valid_at)
        ORDER BY al.depth,a.recorded_sequence DESC LIMIT 1),graph_merge_target(endpoint,ctx,valid_at,recorded_cutoff));
      END $$`);
    const keyEdgeNames=contract.vertex.flatMap(kind=>(kind.keyEdges??[]).map(role=>role.edge));
    statements.push(`CREATE OR REPLACE FUNCTION graph_effective_edges(ctx bigint,valid_at timestamptz DEFAULT clock_timestamp(),recorded_cutoff timestamptz DEFAULT clock_timestamp()) RETURNS SETOF edge LANGUAGE sql STABLE AS $$
      SELECT e.id,e.uid,e.entity_id,
        CASE WHEN k.name=ANY(ARRAY[${keyEdgeNames.map(literal).join(',')}]::text[]) OR k.capability_system THEN e.from_node ELSE graph_edge_endpoint(e.id,e.from_node,'from',ctx,valid_at,recorded_cutoff) END,
        CASE WHEN k.name=ANY(ARRAY[${keyEdgeNames.map(literal).join(',')}]::text[]) OR k.capability_system THEN e.to_node ELSE graph_edge_endpoint(e.id,e.to_node,'to',ctx,valid_at,recorded_cutoff) END,
        e.discriminator,e.context_id
      FROM edge e JOIN (SELECT entity.*,name=ANY(ARRAY[${contract.edge.filter(e=>e.capability==='system').map(e=>literal(e.name)).join(',')}]::text[]) AS capability_system FROM entity) k ON k.id=e.entity_id
      $$`);
    const relationChecks: string[] = [];
    const relationKinds = contract.edge.filter(kind => kind.capability !== 'system');
    const vertexKinds = [...new Set(relationKinds.flatMap(kind => [...endpointKindNames(kind.from, contract.vertex), ...endpointKindNames(kind.to, contract.vertex)]))];
    if (relationKinds.length > 0) {
      const failures: string[] = [];
      const refusals: string[] = [];
      const boundedSides: string[] = [];
      const mergeAliases = (vertex: string): string => `
        CROSS JOIN LATERAL (SELECT from_node FROM edge WHERE to_node=${vertex} AND entity_id=merge_member_kind_id OFFSET 0) membership
        CROSS JOIN LATERAL (SELECT to_node FROM edge WHERE from_node=membership.from_node AND entity_id=merge_member_kind_id OFFSET 0) member`;
      for (const [index, kind] of relationKinds.entries()) {
        const edgeKind = literal(kind.name);
        const vertexId = keyEdgeNames.includes(kind.name) ? 'raw_id' : 'id';
        const from = endpointKindNames(kind.from, contract.vertex);
        const to = endpointKindNames(kind.to, contract.vertex);
        const endpointCode = index * 2 + 1;
        const cardinalityCode = endpointCode + 1;
        failures.push(`WHEN EXISTS(
          SELECT 1 FROM active_edges e WHERE e.kind=${edgeKind} AND e.id IN (SELECT unnest(checked_edges)) AND (
            NOT EXISTS(SELECT 1 FROM active_vertices f WHERE f.context_id=e.context_id AND f.${vertexId}=e.from_node AND f.kind=ANY(ARRAY[${from.map(literal).join(',')}]::text[]))
            OR NOT EXISTS(SELECT 1 FROM active_vertices t WHERE t.context_id=e.context_id AND t.${vertexId}=e.to_node AND t.kind=ANY(ARRAY[${to.map(literal).join(',')}]::text[])))) THEN ${endpointCode}`);
        for (const [direction, ends, bound] of [['from',from,kind.cardinality.to],['to',to,kind.cardinality.from]] as const) {
          if (bound === 'many') continue;
          const atFrom = direction === 'from';
          boundedSides.push(`(${edgeKind},${atFrom},ARRAY[${ends.map(literal).join(',')}]::text[])`);
          failures.push(`WHEN EXISTS(
            SELECT 1 FROM active_vertices n LEFT JOIN active_edges e
              ON e.context_id=n.context_id AND e.${direction}_node=n.${vertexId} AND e.kind=${edgeKind}
            WHERE n.kind=ANY(ARRAY[${ends.map(literal).join(',')}]::text[]) AND EXISTS(
              SELECT 1 FROM cardinality_vertices target WHERE target.kind=${edgeKind} AND target.at_from=${atFrom} AND target.vertex_id=n.raw_id)
            GROUP BY n.context_id,n.${vertexId} HAVING count(DISTINCT (e.from_node,e.to_node,e.discriminator)) FILTER (WHERE e.id IS NOT NULL) ${bound==='one'?'<> 1':bound==='some'?'< 1':'> 1'}) THEN ${cardinalityCode}`);
        }
        refusals.push(`IF violation=${endpointCode} THEN RAISE EXCEPTION '${import.meta.path}:118: TARGET_MISSING or END_KIND_INVALID for %',${edgeKind}; END IF;
          IF violation=${cardinalityCode} THEN RAISE EXCEPTION '${import.meta.path}:125: CARDINALITY_INVALID for %',${edgeKind}; END IF;`);
      }
      // Drop the previous signature when preparing a store that already has decision 0039's storage.
      statements.push('DROP FUNCTION IF EXISTS graph_relation_violation(bigint[],bigint[],bigint[],bigint[],bigint[],bigint[],text[],text[],bigint,boolean,timestamptz)');
      // Keep this parameterized statement on one generic plan across boundary instants and passes.
      statements.push(`CREATE OR REPLACE FUNCTION graph_relation_violation(
        checked_vertices bigint[],counted_edges bigint[],checked_edges bigint[],checked_contexts bigint[],
        vertex_kind_ids bigint[],edge_kind_ids bigint[],vertex_kinds text[],edge_kinds text[],
        source_kind_id bigint,merge_present boolean,instant timestamptz,cardinality_targets jsonb
      ) RETURNS integer LANGUAGE plpgsql SET plan_cache_mode=force_generic_plan AS $$
        DECLARE violation integer; BEGIN
WITH cardinality_vertices AS MATERIALIZED (
        SELECT * FROM jsonb_to_recordset(cardinality_targets) AS target(kind text,at_from boolean,vertex_id bigint)
      ), vertex_groups AS MATERIALIZED (
        SELECT vertex_kinds[array_position(vertex_kind_ids,n.entity_id)] AS name,array_agg(n.id) AS ids
        FROM unnest(checked_vertices) candidate(id) CROSS JOIN LATERAL (SELECT id,entity_id FROM node WHERE id=candidate.id OFFSET 0) n
        WHERE n.entity_id=ANY(vertex_kind_ids) GROUP BY n.entity_id
      ), edge_groups AS MATERIALIZED (
        SELECT edge_kinds[array_position(edge_kind_ids,e.entity_id)] AS name,array_agg(e.id) AS ids
        FROM (SELECT unnest(counted_edges) AS id UNION SELECT unnest(checked_edges)) candidate
        CROSS JOIN LATERAL (SELECT id,entity_id FROM edge WHERE id=candidate.id OFFSET 0) e
        GROUP BY e.entity_id
      ), active_edges AS MATERIALIZED (
        SELECT ctx.id AS context_id,k.name AS kind,e.id,e.discriminator,
          CASE WHEN NOT merge_present OR k.name=ANY(ARRAY[${keyEdgeNames.map(literal).join(',')}]::text[]) THEN e.from_node ELSE graph_edge_endpoint(e.id,e.from_node,'from',ctx.id,instant,clock_timestamp()) END AS from_node,
          CASE WHEN NOT merge_present OR k.name=ANY(ARRAY[${keyEdgeNames.map(literal).join(',')}]::text[]) THEN e.to_node ELSE graph_edge_endpoint(e.id,e.to_node,'to',ctx.id,instant,clock_timestamp()) END AS to_node
        FROM unnest(checked_contexts) ctx(id)
        CROSS JOIN edge_groups k
        CROSS JOIN LATERAL graph_edge_active_ids_batch(k.name,ctx.id,k.ids,instant,source_kind_id) active(id)
        CROSS JOIN LATERAL (SELECT * FROM edge WHERE id=active.id OFFSET 0) e
      ), active_vertices AS MATERIALIZED (
        SELECT DISTINCT ctx.id AS context_id,k.name AS kind,n.id AS raw_id,
          CASE WHEN merge_present THEN graph_merge_target(n.id,ctx.id,instant,clock_timestamp()) ELSE n.id END AS id FROM unnest(checked_contexts) ctx(id)
        CROSS JOIN vertex_groups k
        CROSS JOIN LATERAL graph_vertex_active_ids_batch(k.name,ctx.id,k.ids,instant,source_kind_id) active(id)
        CROSS JOIN LATERAL (SELECT id FROM node WHERE id=active.id OFFSET 0) n
      ) SELECT CASE ${failures.join(' ')} ELSE 0 END INTO violation;
        RETURN violation;
      END $$`);
      relationChecks.push(`
      -- Only existence assertions affect activity. Merge allocations can also project individual edge assertions.
      SELECT coalesce(array_agg(subject), '{}') INTO changed_vertices FROM (
        SELECT n.id AS subject FROM (SELECT * FROM node WHERE id>=node_lower OFFSET 0) n
          WHERE n.entity_id=ANY(vertex_kind_ids)
        UNION SELECT attachment.to_node FROM (SELECT assertion_id,property FROM assertion WHERE assertion_id>=node_lower OFFSET 0) a
          CROSS JOIN LATERAL (SELECT subject_edge_id FROM assertion_vertex_subject WHERE assertion_id=a.assertion_id OFFSET 0) s
          CROSS JOIN LATERAL (SELECT to_node FROM edge WHERE id=s.subject_edge_id OFFSET 0) attachment
          CROSS JOIN LATERAL (SELECT entity_id FROM node WHERE id=attachment.to_node OFFSET 0) n
          WHERE a.property='$exists' AND n.entity_id=ANY(vertex_kind_ids)
      ) changed;
      SELECT coalesce(array_agg(subject), '{}') INTO changed_edges FROM (
        SELECT e.id AS subject FROM (SELECT * FROM edge WHERE id>=edge_lower OFFSET 0) e
          WHERE e.entity_id=ANY(edge_kind_ids)
        UNION SELECT s.edge_id FROM (SELECT assertion_id,property FROM assertion WHERE assertion_id>=node_lower OFFSET 0) a
          CROSS JOIN LATERAL (SELECT edge_id FROM assertion_edge_subject WHERE assertion_id=a.assertion_id OFFSET 0) s
          CROSS JOIN LATERAL (SELECT entity_id FROM edge WHERE id=s.edge_id OFFSET 0) e
          WHERE (merge_present OR a.property='$exists') AND e.entity_id=ANY(edge_kind_ids)
      ) changed;
      IF merge_present THEN
        SELECT id INTO merge_member_kind_id FROM entity WHERE name='system.merge-member';
        -- Structural membership includes undone links and allocation destinations.
        SELECT coalesce(array_agg(DISTINCT attachment.to_node),'{}') INTO changed_merge_metadata
        FROM (SELECT subject_edge_id FROM assertion_vertex_subject WHERE assertion_id>=node_lower OFFSET 0) s
        CROSS JOIN LATERAL (SELECT to_node FROM edge WHERE id=s.subject_edge_id OFFSET 0) attachment
        CROSS JOIN LATERAL (SELECT entity_id FROM node WHERE id=attachment.to_node OFFSET 0) n
        WHERE n.entity_id IN (SELECT id FROM entity WHERE name IN ('system.merge','system.merge-allocation'));
        WITH RECURSIVE seeds(id) AS (
          SELECT unnest(changed_vertices)
          UNION SELECT e.to_node FROM unnest(changed_merge_metadata) t(id) CROSS JOIN LATERAL (
            SELECT to_node FROM edge WHERE from_node=t.id AND entity_id IN (
              merge_member_kind_id,(SELECT id FROM entity WHERE name='system.merge-allocation-member')
            ) OFFSET 0
          ) e
          UNION SELECT member.to_node FROM unnest(changed_merge_metadata) t(id)
            CROSS JOIN LATERAL (
              SELECT to_node FROM edge WHERE from_node=t.id AND entity_id=(SELECT id FROM entity WHERE name='system.merge-allocation-merge') OFFSET 0
            ) link
            CROSS JOIN LATERAL (SELECT to_node FROM edge WHERE from_node=link.to_node AND entity_id=merge_member_kind_id OFFSET 0) member
        ), members(id) AS (
          SELECT id FROM seeds UNION SELECT member.to_node FROM members m ${mergeAliases('m.id')}
        ) SELECT coalesce(array_agg(id),'{}') INTO changed_vertices FROM members;
      END IF;
      IF cardinality(changed_vertices)>0 OR cardinality(changed_edges)>0 THEN
      SELECT coalesce(array_agg(id),'{}') INTO checked_edges FROM (
        SELECT unnest(changed_edges) AS id
        UNION SELECT e.id FROM unnest(changed_vertices) v(id) CROSS JOIN LATERAL (SELECT id FROM edge WHERE from_node=v.id AND entity_id=ANY(edge_kind_ids) OFFSET 0) e
        UNION SELECT e.id FROM unnest(changed_vertices) v(id) CROSS JOIN LATERAL (SELECT id FROM edge WHERE to_node=v.id AND entity_id=ANY(edge_kind_ids) OFFSET 0) e
      ) checked;
      ${boundedSides.length === 0 ? "cardinality_targets := '[]'; counted_edges := '{}'; cardinality_vertex_ids := '{}';" : `
      -- A changed vertex can acquire a lower bound even with no edge. A changed edge
      -- can affect only its own kind at its bounded ends. A merge can also change
      -- projected ends of incident edges without changing their assertion streams.
      WITH RECURSIVE bounded_sides AS MATERIALIZED (
        SELECT k.id AS entity_id,side.* FROM (VALUES ${boundedSides.join(',')}) side(kind,at_from,vertex_kinds)
        CROSS JOIN LATERAL (SELECT id FROM entity WHERE name=side.kind OFFSET 0) k
      ), vertices AS (
        SELECT v.id,k.name FROM unnest(changed_vertices) v(id)
        CROSS JOIN LATERAL (SELECT entity_id FROM node WHERE id=v.id OFFSET 0) n
        CROSS JOIN LATERAL (SELECT name FROM entity WHERE id=n.entity_id OFFSET 0) k
      ), seeds(kind,entity_id,at_from,vertex_id) AS (
        SELECT side.kind,side.entity_id,side.at_from,v.id FROM vertices v
          JOIN bounded_sides side ON v.name=ANY(side.vertex_kinds)
        UNION
        SELECT side.kind,side.entity_id,side.at_from,CASE WHEN side.at_from THEN e.from_node ELSE e.to_node END
          FROM unnest(CASE WHEN merge_present THEN checked_edges ELSE changed_edges END) changed(id)
          CROSS JOIN LATERAL (SELECT entity_id,from_node,to_node FROM edge WHERE id=changed.id OFFSET 0) e
          JOIN bounded_sides side ON side.entity_id=e.entity_id
      ), targets(kind,entity_id,at_from,vertex_id) AS MATERIALIZED (
        SELECT * FROM seeds
        UNION
        SELECT t.kind,t.entity_id,t.at_from,member.to_node FROM targets t ${mergeAliases('t.vertex_id')}
      ), counted AS (
        SELECT e.id FROM targets t CROSS JOIN LATERAL (
          SELECT id FROM edge WHERE from_node=t.vertex_id AND entity_id=t.entity_id AND t.at_from OFFSET 0
        ) e
        UNION
        SELECT e.id FROM targets t CROSS JOIN LATERAL (
          SELECT id FROM edge WHERE to_node=t.vertex_id AND entity_id=t.entity_id AND NOT t.at_from OFFSET 0
        ) e
      ) SELECT (SELECT coalesce(jsonb_agg(jsonb_build_object('kind',kind,'at_from',at_from,'vertex_id',vertex_id)),'[]') FROM targets),
        (SELECT coalesce(array_agg(DISTINCT vertex_id),'{}') FROM targets),
        (SELECT coalesce(array_agg(id),'{}') FROM counted)
      INTO cardinality_targets,cardinality_vertex_ids,counted_edges;`}
      SELECT coalesce(array_agg(id),'{}') INTO checked_vertices FROM (
        SELECT unnest(cardinality_vertex_ids) AS id
        UNION SELECT e.from_node FROM unnest(checked_edges) v(id) CROSS JOIN LATERAL (SELECT from_node FROM edge WHERE id=v.id OFFSET 0) e
        UNION SELECT e.to_node FROM unnest(checked_edges) v(id) CROSS JOIN LATERAL (SELECT to_node FROM edge WHERE id=v.id OFFSET 0) e
      ) checked;
      IF merge_present THEN
        WITH RECURSIVE members(id) AS (
          SELECT unnest(checked_vertices) UNION SELECT member.to_node FROM members m ${mergeAliases('m.id')}
        ) SELECT coalesce(array_agg(id),'{}') INTO checked_vertices FROM members;
      END IF;
      SELECT coalesce(array_agg(assertion_id),'{}') INTO checked_assertions FROM (
        SELECT a.assertion_id FROM unnest(checked_vertices) v(id)
          CROSS JOIN LATERAL (SELECT id FROM edge WHERE to_node=v.id AND entity_id=(SELECT id FROM entity WHERE name='system.assertion-subject') OFFSET 0) e
          CROSS JOIN LATERAL (SELECT assertion_id FROM assertion_vertex_subject WHERE subject_edge_id=e.id OFFSET 0) s
          CROSS JOIN LATERAL (SELECT assertion_id FROM assertion WHERE assertion_id=s.assertion_id AND property='$exists' OFFSET 0) a
        UNION
        SELECT a.assertion_id FROM (SELECT unnest(counted_edges) AS id UNION SELECT unnest(checked_edges)) e
          CROSS JOIN LATERAL (SELECT assertion_id FROM assertion_edge_subject WHERE edge_id=e.id OFFSET 0) s
          CROSS JOIN LATERAL (SELECT assertion_id FROM assertion WHERE assertion_id=s.assertion_id AND (merge_present OR property='$exists') OFFSET 0) a
      ) checked;
      IF merge_present THEN
        -- Counts distinguish complete projected edges. Either end of a counted edge can change that identity.
        WITH RECURSIVE seeds(id) AS (
          SELECT unnest(checked_vertices)
          UNION SELECT endpoint.id FROM unnest(counted_edges) c(id)
            CROSS JOIN LATERAL (SELECT from_node,to_node FROM edge WHERE id=c.id OFFSET 0) e
            CROSS JOIN LATERAL (VALUES(e.from_node),(e.to_node)) endpoint(id)
        ), members(id) AS (
          SELECT id FROM seeds UNION SELECT member.to_node FROM members m ${mergeAliases('m.id')}
        ), metadata(id) AS (
          SELECT unnest(changed_merge_metadata)
          UNION SELECT e.from_node FROM members m CROSS JOIN LATERAL (
            SELECT from_node FROM edge WHERE to_node=m.id AND entity_id IN (
              merge_member_kind_id,(SELECT id FROM entity WHERE name='system.merge-allocation-member')
            ) OFFSET 0
          ) e
        ) SELECT ARRAY(
          SELECT unnest(checked_assertions)
          UNION SELECT s.assertion_id FROM metadata n
            CROSS JOIN LATERAL (
              SELECT id FROM edge WHERE to_node=n.id AND entity_id=(SELECT id FROM entity WHERE name='system.assertion-subject') OFFSET 0
            ) attachment
            CROSS JOIN LATERAL (SELECT assertion_id FROM assertion_vertex_subject WHERE subject_edge_id=attachment.id OFFSET 0) s
        ) INTO checked_assertions;
      END IF;
      SELECT coalesce(array_agg(DISTINCT id),'{}') INTO checked_contexts FROM (
        WITH RECURSIVE affected(id) AS (
          SELECT c.id FROM (SELECT id FROM context WHERE id>=context_lower OFFSET 0) c
          UNION SELECT a.context_id FROM unnest(checked_assertions) s(id) CROSS JOIN LATERAL (SELECT context_id,valid_from,valid_to FROM assertion WHERE assertion_id=s.id AND assertion_id>=node_lower OFFSET 0) a
          UNION SELECT c.id FROM affected p CROSS JOIN LATERAL (SELECT id FROM context WHERE parent=p.id OFFSET 0) c
        ) SELECT id FROM affected
      ) contexts;
      FOR instant IN
        WITH intervals AS MATERIALIZED (
          SELECT a.valid_from AS lo,a.valid_to AS hi FROM unnest(checked_assertions) s(id) CROSS JOIN LATERAL (SELECT context_id,valid_from,valid_to FROM assertion WHERE assertion_id=s.id AND assertion_id>=node_lower OFFSET 0) a
        ), boundaries AS (
          SELECT lo AS at FROM intervals UNION SELECT hi FROM intervals WHERE hi IS NOT NULL
          UNION SELECT boundary.at FROM unnest(checked_assertions) s(id) CROSS JOIN LATERAL (SELECT valid_from,valid_to FROM assertion WHERE assertion_id=s.id OFFSET 0) a
            CROSS JOIN LATERAL (VALUES (a.valid_from),(a.valid_to)) boundary(at)
            WHERE boundary.at IS NOT NULL AND EXISTS(SELECT 1 FROM intervals i WHERE boundary.at>=i.lo AND (i.hi IS NULL OR boundary.at<=i.hi))
        ) SELECT DISTINCT at FROM boundaries ORDER BY at
      LOOP
        violation:=graph_relation_violation(checked_vertices,counted_edges,checked_edges,checked_contexts,
          vertex_kind_ids,edge_kind_ids,vertex_kinds,edge_kinds,source_kind_id,merge_present,instant,cardinality_targets);
      ${refusals.join('\n')}
      END LOOP;
      END IF;`);
    }
    statements.push(`CREATE OR REPLACE FUNCTION graph_relations_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_TABLE_NAME IN ('node','edge','context') THEN
          IF nullif(current_setting('madarch.graph_' || TG_TABLE_NAME || '_lower',true),'') IS NULL THEN
            PERFORM set_config('madarch.graph_' || TG_TABLE_NAME || '_lower',NEW.id::text,true);
          END IF;
        END IF;
        IF TG_TABLE_NAME IN ('assertion','assertion_vertex_subject','assertion_edge_subject') OR TG_TABLE_NAME NOT IN ('node','edge','context') THEN
          PERFORM set_config('madarch.graph_node_lower',least(NEW.assertion_id,
            coalesce(nullif(current_setting('madarch.graph_node_lower',true),'')::bigint,NEW.assertion_id))::text,true);
        END IF;
        IF TG_TABLE_NAME NOT IN ('node','edge','context','assertion','assertion_vertex_subject','assertion_edge_subject') THEN
          PERFORM set_config('madarch.graph_value_tables',(coalesce(nullif(current_setting('madarch.graph_value_tables',true),''),'{}')::jsonb || jsonb_build_object(TG_TABLE_NAME,true))::text,true);
        END IF;
        PERFORM set_config('madarch.graph_revision',(coalesce(nullif(current_setting('madarch.graph_revision',true),''),'0')::bigint+1)::text,true);
        RETURN NEW;
      END $$`);
    statements.push(`CREATE OR REPLACE FUNCTION graph_checks_pass() RETURNS void LANGUAGE plpgsql SET jit=off AS $$
      DECLARE vertex_value_tables jsonb := ${literal(JSON.stringify(valueTables('vertex')))}::jsonb;
      edge_value_tables jsonb := ${literal(JSON.stringify(valueTables('edge')))}::jsonb;
      touched_value_tables jsonb := coalesce(nullif(current_setting('madarch.graph_value_tables',true),''),'{}')::jsonb;
      revision text; violation integer; merge_present boolean; expected_values jsonb; required_values jsonb; bad_id bigint; candidate_id bigint; candidate_code integer; candidate_kind text; candidate_property text; changed_keys jsonb; bad_kind text; bad_property text;
        node_lower bigint := coalesce(nullif(current_setting('madarch.graph_node_lower',true),'')::bigint,9223372036854775807);
        edge_lower bigint := coalesce(nullif(current_setting('madarch.graph_edge_lower',true),'')::bigint,9223372036854775807);
        context_lower bigint := coalesce(nullif(current_setting('madarch.graph_context_lower',true),'')::bigint,9223372036854775807);
        changed_vertices bigint[]; changed_edges bigint[]; checked_edges bigint[]; checked_vertices bigint[];
        counted_edges bigint[]; checked_assertions bigint[]; checked_contexts bigint[]; instant timestamptz;
        vertex_kind_ids bigint[]; edge_kind_ids bigint[]; source_kind_id bigint; merge_member_kind_id bigint;
        cardinality_targets jsonb; cardinality_vertex_ids bigint[]; changed_merge_metadata bigint[];
        vertex_kinds text[] := ARRAY[${vertexKinds.map(literal).join(',')}]::text[];
        edge_kinds text[] := ARRAY[${relationKinds.map(kind => literal(kind.name)).join(',')}]::text[]; BEGIN
      revision := current_setting('madarch.graph_revision',true);

WITH assertion_headers AS MATERIALIZED (
        SELECT assertion_id FROM assertion WHERE assertion_id>=node_lower
      ), subjects AS MATERIALIZED (
        SELECT h.assertion_id,count(av.assertion_id)+count(ae.assertion_id) AS total,
          bool_or(attachment.from_node<>h.assertion_id OR kind.name<>'system.assertion-subject') AS invalid
        FROM assertion_headers h
        LEFT JOIN LATERAL (SELECT assertion_id,subject_edge_id FROM assertion_vertex_subject WHERE assertion_id=h.assertion_id OFFSET 0) av ON true
        LEFT JOIN LATERAL (SELECT assertion_id FROM assertion_edge_subject WHERE assertion_id=h.assertion_id OFFSET 0) ae ON true
        LEFT JOIN edge attachment ON attachment.id=av.subject_edge_id
        LEFT JOIN LATERAL (SELECT name FROM entity WHERE id=attachment.entity_id OFFSET 0) kind ON true
        GROUP BY h.assertion_id
      ), provenance AS MATERIALIZED (
        SELECT e.from_node AS assertion_id,
          count(*) FILTER (WHERE kind.name='system.assertion-source') AS sources,
          count(*) FILTER (WHERE kind.name='system.assertion-author') AS authors,
          count(*) FILTER (WHERE kind.name='system.assertion-operation') AS operations,
          bool_or((kind.name IN ('system.assertion-source','system.assertion-author') AND target_kind.name NOT IN ('source','person','plugin','agent','agent-session'))
            OR (kind.name='system.assertion-operation' AND target_kind.name<>'system.operation')
            OR (kind.name='system.assertion-unit' AND target_kind.name<>'system.unit')) AS invalid
        FROM assertion_headers h CROSS JOIN LATERAL (SELECT * FROM edge WHERE from_node=h.assertion_id OFFSET 0) e
        CROSS JOIN LATERAL (SELECT name FROM entity WHERE id=e.entity_id OFFSET 0) kind
        LEFT JOIN LATERAL (SELECT entity_id FROM node WHERE id=e.to_node OFFSET 0) target ON true LEFT JOIN LATERAL (SELECT name FROM entity WHERE id=target.entity_id OFFSET 0) target_kind ON true
        GROUP BY e.from_node
      ), failures AS MATERIALIZED (
        SELECT h.assertion_id AS id,CASE
          WHEN subjects.total<>1 THEN 77
          WHEN subjects.invalid THEN 80
          WHEN kind.name IS DISTINCT FROM 'system.assertion' THEN 83
          WHEN coalesce(provenance.sources,0)<>1 OR coalesce(provenance.authors,0)<>1 OR coalesce(provenance.operations,0)<1 THEN 88
          WHEN provenance.invalid THEN 106 ELSE 0 END AS code
        FROM assertion_headers h JOIN subjects ON subjects.assertion_id=h.assertion_id
        LEFT JOIN LATERAL (SELECT entity_id FROM node WHERE id=h.assertion_id OFFSET 0) n ON true LEFT JOIN LATERAL (SELECT name FROM entity WHERE id=n.entity_id OFFSET 0) kind ON true
        LEFT JOIN provenance ON provenance.assertion_id=h.assertion_id
      ) SELECT id,code INTO bad_id,violation FROM failures WHERE code<>0 ORDER BY id,code LIMIT 1;
IF violation=77 THEN RAISE EXCEPTION '${import.meta.path}:77: assertion % requires exactly one subject',bad_id; END IF;
IF violation=80 THEN RAISE EXCEPTION '${import.meta.path}:80: invalid assertion subject edge'; END IF;
IF violation=83 THEN RAISE EXCEPTION '${import.meta.path}:83: assertion header requires a system.assertion vertex'; END IF;
IF violation=88 THEN RAISE EXCEPTION '${import.meta.path}:88: assertion requires source, author and operation edges'; END IF;
IF violation=106 THEN RAISE EXCEPTION '${import.meta.path}:106: END_KIND_INVALID assertion lineage'; END IF;

      WITH headers AS MATERIALIZED (
        SELECT a.assertion_id,a.operation,coalesce(vertex_value_tables->vk.name->>a.property,edge_value_tables->ek.name->>a.property) AS expected
        FROM (SELECT * FROM assertion WHERE assertion_id>=node_lower OFFSET 0) a
        LEFT JOIN LATERAL (SELECT * FROM assertion_vertex_subject WHERE assertion_id=a.assertion_id OFFSET 0) av ON true
        LEFT JOIN LATERAL (SELECT * FROM edge WHERE id=av.subject_edge_id OFFSET 0) attachment ON true
        LEFT JOIN LATERAL (SELECT * FROM node WHERE id=attachment.to_node OFFSET 0) target ON true LEFT JOIN LATERAL (SELECT name FROM entity WHERE id=target.entity_id OFFSET 0) vk ON true
        LEFT JOIN LATERAL (SELECT * FROM assertion_edge_subject WHERE assertion_id=a.assertion_id OFFSET 0) ae ON true
        LEFT JOIN LATERAL (SELECT * FROM edge WHERE id=ae.edge_id OFFSET 0) relation ON true LEFT JOIN LATERAL (SELECT name FROM entity WHERE id=relation.entity_id OFFSET 0) ek ON true
      ) SELECT (SELECT jsonb_object_agg(assertion_id,expected) FROM headers WHERE operation='assert'),
        (SELECT jsonb_object_agg(expected,ids) FROM (SELECT expected,jsonb_agg(assertion_id) ids FROM headers WHERE operation='assert' AND expected IS NOT NULL GROUP BY expected) grouped),
        (SELECT min(assertion_id) FROM headers WHERE operation='assert' AND expected IS NULL)
        INTO expected_values,required_values,bad_id;
      violation:=CASE WHEN bad_id IS NULL THEN NULL ELSE 60 END;
      ${valueChecks.join('\n')}
      IF violation=43 THEN RAISE EXCEPTION '${import.meta.path}:43: assertion value does not match declared subject/property'; END IF;
      IF violation=60 THEN RAISE EXCEPTION '${import.meta.path}:60: assertion requires exactly one typed value; retraction requires none'; END IF;
      SELECT jsonb_object_agg(name,ids) INTO changed_keys FROM (
        SELECT k.name,jsonb_agg(n.id ORDER BY n.id) AS ids FROM (
          SELECT id FROM node WHERE id>=node_lower
          UNION SELECT attachment.to_node FROM (SELECT * FROM assertion_vertex_subject WHERE assertion_id>=node_lower OFFSET 0) s
            CROSS JOIN LATERAL (SELECT to_node FROM edge WHERE id=s.subject_edge_id OFFSET 0) attachment
        ) changed CROSS JOIN LATERAL (SELECT id,entity_id FROM node WHERE id=changed.id OFFSET 0) n JOIN LATERAL (SELECT name FROM entity WHERE id=n.entity_id OFFSET 0) k ON true
        WHERE k.name=ANY(ARRAY[${keyedKinds.map(kind => literal(kind.name)).join(',')}]::text[]) GROUP BY k.name
      ) grouped;
      bad_id:=NULL;
      ${keyChecks.map(query => `SELECT id,kind,property INTO candidate_id,candidate_kind,candidate_property FROM (
        ${query}
      ) failures ORDER BY id LIMIT 1;
      IF candidate_id IS NOT NULL AND (bad_id IS NULL OR (candidate_id,candidate_kind COLLATE "C",candidate_property COLLATE "C")<(bad_id,bad_kind COLLATE "C",bad_property COLLATE "C")) THEN
        bad_id:=candidate_id; bad_kind:=candidate_kind; bad_property:=candidate_property;
      END IF;`).join('\n')}
      IF bad_id IS NOT NULL THEN RAISE EXCEPTION '${import.meta.path}:214: IMMUTABLE_KEY missing or contradictory assertion for %.%',bad_kind,bad_property; END IF;
      SELECT id,EXISTS(SELECT 1 FROM node WHERE entity_id=(SELECT id FROM entity WHERE name='system.merge')) INTO source_kind_id,merge_present FROM entity WHERE name='system.assertion-source';
      SELECT array_agg(kind.id ORDER BY kind.name COLLATE "C"),array_agg(kind.name ORDER BY kind.name COLLATE "C") INTO vertex_kind_ids,vertex_kinds FROM unnest(vertex_kinds) wanted(name) CROSS JOIN LATERAL (SELECT id,name FROM entity WHERE name=wanted.name OFFSET 0) kind;
      SELECT array_agg(kind.id ORDER BY kind.name COLLATE "C"),array_agg(kind.name ORDER BY kind.name COLLATE "C") INTO edge_kind_ids,edge_kinds FROM unnest(edge_kinds) wanted(name) CROSS JOIN LATERAL (SELECT id,name FROM entity WHERE name=wanted.name OFFSET 0) kind;
      ${relationChecks.join('\n')}
      PERFORM set_config('madarch.graph_value_tables','',true);
      PERFORM set_config('madarch.checked_graph_revision',revision,true);
      PERFORM set_config('madarch.graph_node_lower','',true);
      PERFORM set_config('madarch.graph_edge_lower','',true);
      PERFORM set_config('madarch.graph_context_lower','',true);
      RETURN; END $$`);
    statements.push(`CREATE OR REPLACE FUNCTION graph_relations_check() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF current_setting('madarch.checked_graph_revision',true)=current_setting('madarch.graph_revision',true) THEN RETURN NULL; END IF;
      PERFORM graph_checks_pass();
      RETURN NULL;
    END $$`);
    for (const table of ['node','edge','assertion','context','assertion_vertex_subject','assertion_edge_subject',...names]) {
      trigger(table, 'graph_relations_dirty', 'graph_relations_dirty', 7, false,
        `CREATE TRIGGER graph_relations_dirty BEFORE INSERT ON "${table}" FOR EACH ROW EXECUTE FUNCTION graph_relations_dirty()`);
      trigger(table, 'graph_relations', 'graph_relations_check', 5, true,
        `CREATE CONSTRAINT TRIGGER graph_relations AFTER INSERT ON "${table}" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION graph_relations_check()`);
    }

    statements.push('DROP FUNCTION IF EXISTS graph_subject_check(), graph_value_check(), graph_key_check() CASCADE');
    statements.push('DROP FUNCTION IF EXISTS graph_key_fields(text)');
    for (const table of lookups) statements.push(`CREATE INDEX IF NOT EXISTS "${table}_lookup" ON "${table}"(value)`);
    const entityStatement = `INSERT INTO entity(name,sort,repeats,discriminator)
      SELECT name,sort,repeats,discriminator FROM jsonb_to_recordset($1::jsonb)
        AS kinds(name text,sort text,repeats boolean,discriminator text)
      ON CONFLICT(name) DO UPDATE SET sort=excluded.sort,repeats=excluded.repeats,discriminator=excluded.discriminator`;
    return {contract, statements, triggers, entities, entityStatement};
}

/** Canonical declarations and every generated statement define a prepared schema. */
export function graphSchemaStamp(contract: GraphContract): string {
  const generated = generateContractStatements(contract);
  const declaration = JSON.stringify(generated.contract, (_key, value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map(key => [key, object[key]]));
  });
  const stamp = sha256Hex(new TextEncoder().encode([String(SCHEMA_REVISION), ...SCHEMA, declaration,
    ...generated.statements, ...generated.triggers.map(trigger => trigger.statement), generated.entityStatement].join('\n')));
  return stamp;
}
