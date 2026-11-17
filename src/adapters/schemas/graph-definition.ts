/** Graph core storage, decision 0039 items 25 and 28. */
import { sha256Hex } from '../../graph/digest.js';
import type { GraphContract } from '../../graph/contract.js';
import { endpointKindNames, assertionValueTableName, type FieldContract } from '../../graph/contract.js';
import { withAssertionContract } from '../../graph/system-contract.js';

export const SCHEMA_REVISION = 9;
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
        OR (SELECT count(*) FROM edge e JOIN entity k ON k.id=e.entity_id WHERE e.from_node=a AND k.name='system.assertion-operation') < 1 THEN
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
    `DROP TRIGGER IF EXISTS subject_attachment ON ${table};
     CREATE CONSTRAINT TRIGGER subject_attachment AFTER INSERT ON ${table} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION graph_subject_check()`),
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
    const checks: string[] = [];
    const names: string[] = [];
    for (const sort of ['vertex','edge'] as const) {
      for (const kind of contract[sort]) {
        entities.push({name:kind.name,sort:sort === 'vertex' ? 'node':'edge',repeats:sort === 'edge' ? ('repeats' in kind && kind.repeats):false,discriminator:'discriminator' in kind ? kind.discriminator ?? null:null});
        const fields: readonly FieldContract[] = [{name:'$exists',type:'boolean'}, ...kind.fields];
        for (const field of fields) {
          const table = assertionValueTableName(kind.name,sort,field.name);
          names.push(table);
          statements.push(`CREATE TABLE IF NOT EXISTS "${table}" (assertion_id bigint PRIMARY KEY REFERENCES assertion(assertion_id), value ${sqlType(field)}${field.nullable === true ? '' : ' NOT NULL'})`);
          trigger(table, 'immutable', 'graph_immutable', 27, false,
        `CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON "${table}" FOR EACH ROW EXECUTE FUNCTION graph_immutable()`);
          const literal = (value: string): string => "'" + value.split("'").join("''") + "'";
          checks.push(`WHEN subject_sort=${literal(sort)} AND subject_kind=${literal(kind.name)} AND h.property=${literal(field.name)} THEN ${literal(table)}`);
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
          ${readerLayers} SELECT a.assertion_id FROM assertion a JOIN layers layer ON layer.id=a.context_id AND (wanted_subject IS NULL OR a.assertion_id=wanted_subject)
          AND (layer.cutoff IS NULL OR a.recorded_sequence<=layer.cutoff);`;
        const targetAssertions = sort === 'vertex'
          ? 'SELECT s.assertion_id FROM edge se CROSS JOIN LATERAL (SELECT av.assertion_id FROM assertion_vertex_subject av WHERE av.subject_edge_id=se.id OFFSET 0) s WHERE se.to_node=wanted_subject'
          : 'SELECT s.assertion_id FROM assertion_edge_subject s WHERE s.edge_id=wanted_subject';
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
            WHERE a.property='$exists' ${bounded ? '' : `AND (wanted_subject IS NULL OR ${id}=wanted_subject)`}
          ), current_stream AS (
            SELECT DISTINCT ON (subject_id,source_id) subject_id,assertion_uid,operation,value,valid_from,recorded_sequence FROM visible
            WHERE depth=nearest AND ${bounded ? "valid_from<snapshot_at+interval '1 millisecond'" : "date_trunc('milliseconds',valid_from)<=snapshot_at"} AND (valid_to IS NULL OR ${bounded ? "valid_to>=snapshot_at+interval '1 millisecond'" : "date_trunc('milliseconds',valid_to)>snapshot_at"})
            ORDER BY subject_id,source_id,recorded_sequence DESC
          ), candidates AS (SELECT DISTINCT ON (subject_id) * FROM current_stream WHERE operation='assert' ORDER BY subject_id,valid_from DESC,recorded_sequence DESC,assertion_uid DESC)
          SELECT subject_id FROM candidates WHERE value=TRUE;`;
        return `WHEN ${literal(kind.name)} THEN
          snapshot_at := date_trunc('milliseconds',coalesce(instant,clock_timestamp()));
          IF wanted_subject IS NULL THEN ${activeQuery(false)} ELSE ${activeQuery(true)} END IF;`;
      });
      statements.push(`DROP FUNCTION IF EXISTS graph_${sort}_active_ids(text,bigint,bigint)`);
      statements.push(`CREATE OR REPLACE FUNCTION graph_${sort}_active_ids(kind text,ctx bigint,wanted_subject bigint DEFAULT NULL,instant timestamptz DEFAULT NULL,source_kind_id bigint DEFAULT NULL) RETURNS SETOF bigint LANGUAGE plpgsql AS $$
        DECLARE snapshot_at timestamptz; BEGIN
        IF wanted_subject IS NOT NULL AND source_kind_id IS NULL THEN SELECT id INTO source_kind_id FROM entity WHERE name='system.assertion-source'; END IF;
        CASE kind ${setBranches.join(' ')} ELSE RETURN; END CASE; END $$`);
      statements.push(`CREATE OR REPLACE FUNCTION graph_${sort}_active(subject bigint,kind text,ctx bigint) RETURNS boolean LANGUAGE sql AS $$
        SELECT EXISTS(SELECT 1 FROM graph_${sort}_active_ids(kind,ctx,subject) active(id) WHERE active.id=subject)
      $$`);
    }
    const relationChecks: string[] = [];
    const relationKinds = contract.edge.filter(kind => kind.capability !== 'system');
    const vertexKinds = [...new Set(relationKinds.flatMap(kind => [...endpointKindNames(kind.from, contract.vertex), ...endpointKindNames(kind.to, contract.vertex)]))];
    if (relationKinds.length > 0) {
      const failures: string[] = [];
      const refusals: string[] = [];
      for (const [index, kind] of relationKinds.entries()) {
        const edgeKind = literal(kind.name);
        const from = endpointKindNames(kind.from, contract.vertex);
        const to = endpointKindNames(kind.to, contract.vertex);
        const endpointCode = index * 2 + 1;
        const cardinalityCode = endpointCode + 1;
        failures.push(`WHEN EXISTS(
          SELECT 1 FROM active_edges e WHERE e.id=ANY(checked_edges) AND e.kind=${edgeKind} AND (
            NOT EXISTS(SELECT 1 FROM active_vertices f WHERE f.context_id=e.context_id AND f.id=e.from_node AND f.kind=ANY(ARRAY[${from.map(literal).join(',')}]::text[]))
            OR NOT EXISTS(SELECT 1 FROM active_vertices t WHERE t.context_id=e.context_id AND t.id=e.to_node AND t.kind=ANY(ARRAY[${to.map(literal).join(',')}]::text[])))) THEN ${endpointCode}`);
        for (const [direction, ends, bound] of [['from',from,kind.cardinality.to],['to',to,kind.cardinality.from]] as const) {
          if (bound === 'many') continue;
          failures.push(`WHEN EXISTS(
            SELECT 1 FROM active_vertices n LEFT JOIN active_edges e
              ON e.context_id=n.context_id AND e.${direction}_node=n.id AND e.kind=${edgeKind}
            WHERE n.kind=ANY(ARRAY[${ends.map(literal).join(',')}]::text[])
            GROUP BY n.context_id,n.id HAVING count(e.id) ${bound==='one'?'<> 1':bound==='some'?'< 1':'> 1'}) THEN ${cardinalityCode}`);
        }
        refusals.push(`IF violation=${endpointCode} THEN RAISE EXCEPTION '${import.meta.path}:118: TARGET_MISSING or END_KIND_INVALID for %',${edgeKind}; END IF;
          IF violation=${cardinalityCode} THEN RAISE EXCEPTION '${import.meta.path}:125: CARDINALITY_INVALID for %',${edgeKind}; END IF;`);
      }
      relationChecks.push(`
      SELECT coalesce(array_agg(DISTINCT subject), '{}') INTO changed_vertices FROM (
        SELECT n.id AS subject FROM (SELECT * FROM node WHERE id>=node_lower OFFSET 0) n
          WHERE n.entity_id=ANY(vertex_kind_ids)
        UNION SELECT attachment.to_node FROM (SELECT * FROM assertion_vertex_subject WHERE assertion_id>=node_lower OFFSET 0) s
          CROSS JOIN LATERAL (SELECT to_node FROM edge WHERE id=s.subject_edge_id OFFSET 0) attachment
          CROSS JOIN LATERAL (SELECT entity_id FROM node WHERE id=attachment.to_node OFFSET 0) n
          WHERE s.assertion_id>=node_lower AND n.entity_id=ANY(vertex_kind_ids)
      ) changed;
      SELECT coalesce(array_agg(DISTINCT subject), '{}') INTO changed_edges FROM (
        SELECT e.id AS subject FROM (SELECT * FROM edge WHERE id>=edge_lower OFFSET 0) e
          WHERE e.entity_id=ANY(edge_kind_ids)
        UNION SELECT s.edge_id FROM (SELECT * FROM assertion_edge_subject WHERE assertion_id>=node_lower OFFSET 0) s CROSS JOIN LATERAL (SELECT entity_id FROM edge WHERE id=s.edge_id OFFSET 0) e
           WHERE s.assertion_id>=node_lower AND e.entity_id=ANY(edge_kind_ids)
      ) changed;
      SELECT coalesce(array_agg(DISTINCT id),'{}') INTO checked_edges FROM (
        SELECT unnest(changed_edges) AS id
        UNION SELECT e.id FROM unnest(changed_vertices) v(id) CROSS JOIN LATERAL (SELECT * FROM edge WHERE from_node=v.id OFFSET 0) e
           WHERE e.entity_id=ANY(edge_kind_ids)
        UNION SELECT e.id FROM unnest(changed_vertices) v(id) CROSS JOIN LATERAL (SELECT * FROM edge WHERE to_node=v.id OFFSET 0) e
           WHERE e.entity_id=ANY(edge_kind_ids)
      ) checked;
      SELECT coalesce(array_agg(DISTINCT id),'{}') INTO checked_vertices FROM (
        SELECT unnest(changed_vertices) AS id
        UNION SELECT e.from_node FROM unnest(checked_edges) v(id) CROSS JOIN LATERAL (SELECT from_node,to_node FROM edge WHERE id=v.id OFFSET 0) e
        UNION SELECT e.to_node FROM unnest(checked_edges) v(id) CROSS JOIN LATERAL (SELECT from_node,to_node FROM edge WHERE id=v.id OFFSET 0) e
      ) checked;
      SELECT coalesce(array_agg(DISTINCT id),'{}') INTO counted_edges FROM (
        SELECT e.id FROM unnest(checked_vertices) v(id) CROSS JOIN LATERAL (SELECT * FROM edge WHERE from_node=v.id OFFSET 0) e
           WHERE e.entity_id=ANY(edge_kind_ids)
        UNION SELECT e.id FROM unnest(checked_vertices) v(id) CROSS JOIN LATERAL (SELECT * FROM edge WHERE to_node=v.id OFFSET 0) e
           WHERE e.entity_id=ANY(edge_kind_ids)
      ) counted;
      SELECT coalesce(array_agg(DISTINCT assertion_id),'{}') INTO checked_assertions FROM (
        SELECT s.assertion_id FROM unnest(checked_vertices) v(id) CROSS JOIN LATERAL (SELECT id FROM edge WHERE to_node=v.id OFFSET 0) e
          CROSS JOIN LATERAL (SELECT assertion_id FROM assertion_vertex_subject WHERE subject_edge_id=e.id OFFSET 0) s
        UNION SELECT s.assertion_id FROM unnest(counted_edges) e(id) CROSS JOIN LATERAL (SELECT assertion_id FROM assertion_edge_subject WHERE edge_id=e.id OFFSET 0) s
      ) checked;
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
WITH active_edges AS MATERIALIZED (
        SELECT ctx.id AS context_id,k.name AS kind,e.id,e.from_node,e.to_node FROM unnest(checked_contexts) ctx(id)
        CROSS JOIN unnest(counted_edges) candidate(id)
        CROSS JOIN LATERAL (SELECT * FROM edge WHERE id=candidate.id OFFSET 0) e
        CROSS JOIN LATERAL (SELECT edge_kinds[array_position(edge_kind_ids,e.entity_id)] AS name) k
        CROSS JOIN LATERAL graph_edge_active_ids(k.name,ctx.id,e.id,instant,source_kind_id) active(id)
      ), active_vertices AS MATERIALIZED (
        SELECT ctx.id AS context_id,k.name AS kind,n.id FROM unnest(checked_contexts) ctx(id)
        CROSS JOIN unnest(checked_vertices) candidate(id)
        CROSS JOIN LATERAL (SELECT * FROM node WHERE id=candidate.id OFFSET 0) n
        CROSS JOIN LATERAL (SELECT vertex_kinds[array_position(vertex_kind_ids,n.entity_id)] AS name) k
        CROSS JOIN LATERAL graph_vertex_active_ids(k.name,ctx.id,n.id,instant,source_kind_id) active(id)
      ) SELECT CASE ${failures.join(' ')} ELSE 0 END INTO violation;
      ${refusals.join('\n')}
      END LOOP;`);
    }
    statements.push(`CREATE OR REPLACE FUNCTION graph_relations_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_TABLE_NAME IN ('node','edge','context') THEN
          IF nullif(current_setting('madarch.graph_' || TG_TABLE_NAME || '_lower',true),'') IS NULL THEN
            PERFORM set_config('madarch.graph_' || TG_TABLE_NAME || '_lower',NEW.id::text,true);
          END IF;
        END IF;
        PERFORM set_config('madarch.graph_revision',(coalesce(nullif(current_setting('madarch.graph_revision',true),''),'0')::bigint+1)::text,true);
        RETURN NEW;
      END $$`);
    statements.push(`CREATE OR REPLACE FUNCTION graph_relations_check() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE revision text; violation integer;
        node_lower bigint := coalesce(nullif(current_setting('madarch.graph_node_lower',true),'')::bigint,9223372036854775807);
        edge_lower bigint := coalesce(nullif(current_setting('madarch.graph_edge_lower',true),'')::bigint,9223372036854775807);
        context_lower bigint := coalesce(nullif(current_setting('madarch.graph_context_lower',true),'')::bigint,9223372036854775807);
        changed_vertices bigint[]; changed_edges bigint[]; checked_edges bigint[]; checked_vertices bigint[];
        counted_edges bigint[]; checked_assertions bigint[]; checked_contexts bigint[]; instant timestamptz;
        vertex_kind_ids bigint[]; edge_kind_ids bigint[]; source_kind_id bigint;
        vertex_kinds text[] := ARRAY[${vertexKinds.map(literal).join(',')}]::text[];
        edge_kinds text[] := ARRAY[${relationKinds.map(kind => literal(kind.name)).join(',')}]::text[]; BEGIN
      revision := current_setting('madarch.graph_revision',true);
      IF current_setting('madarch.checked_graph_revision',true)=revision THEN RETURN NULL; END IF;
      SELECT id INTO source_kind_id FROM entity WHERE name='system.assertion-source';
      SELECT array_agg(kind.id ORDER BY kind.name COLLATE "C"),array_agg(kind.name ORDER BY kind.name COLLATE "C") INTO vertex_kind_ids,vertex_kinds FROM unnest(vertex_kinds) wanted(name) CROSS JOIN LATERAL (SELECT id,name FROM entity WHERE name=wanted.name OFFSET 0) kind;
      SELECT array_agg(kind.id ORDER BY kind.name COLLATE "C"),array_agg(kind.name ORDER BY kind.name COLLATE "C") INTO edge_kind_ids,edge_kinds FROM unnest(edge_kinds) wanted(name) CROSS JOIN LATERAL (SELECT id,name FROM entity WHERE name=wanted.name OFFSET 0) kind;
      ${relationChecks.join('\n')}
      PERFORM set_config('madarch.checked_graph_revision',revision,true);
      PERFORM set_config('madarch.graph_node_lower','',true);
      PERFORM set_config('madarch.graph_edge_lower','',true);
      PERFORM set_config('madarch.graph_context_lower','',true);
      RETURN NULL; END $$`);
    for (const table of ['node','edge','assertion','context','assertion_vertex_subject','assertion_edge_subject',...names]) {
      trigger(table, 'graph_relations_dirty', 'graph_relations_dirty', 7, false,
        `CREATE TRIGGER graph_relations_dirty BEFORE INSERT ON "${table}" FOR EACH ROW EXECUTE FUNCTION graph_relations_dirty()`);
      trigger(table, 'graph_relations', 'graph_relations_check', 5, true,
        `CREATE CONSTRAINT TRIGGER graph_relations AFTER INSERT ON "${table}" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION graph_relations_check()`);
    }

    statements.push(`CREATE OR REPLACE FUNCTION graph_value_check() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE a bigint; h assertion%ROWTYPE; expected_table text; has_value boolean; subject_kind text; subject_sort text;
      BEGIN
        a:=NEW.assertion_id; SELECT * INTO h FROM assertion WHERE assertion_id=a;
        SELECT k.name,'vertex' INTO subject_kind,subject_sort FROM assertion_vertex_subject s JOIN edge e ON e.id=s.subject_edge_id JOIN node n ON n.id=e.to_node JOIN entity k ON k.id=n.entity_id WHERE s.assertion_id=a;
        IF subject_kind IS NULL THEN
          SELECT k.name,'edge' INTO subject_kind,subject_sort FROM assertion_edge_subject s JOIN edge e ON e.id=s.edge_id JOIN entity k ON k.id=e.entity_id WHERE s.assertion_id=a;
        END IF;
        expected_table := CASE ${checks.join('\n')} ELSE NULL END;
        IF TG_TABLE_NAME <> 'assertion' THEN
          IF h.operation <> 'assert' OR expected_table IS NULL OR TG_TABLE_NAME <> expected_table THEN
            RAISE EXCEPTION '${import.meta.path}:43: assertion value does not match declared subject/property';
          END IF;
        ELSIF h.operation='assert' THEN
          IF expected_table IS NULL THEN
            RAISE EXCEPTION '${import.meta.path}:60: assertion requires exactly one typed value; retraction requires none';
          END IF;
          EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I WHERE assertion_id=$1)',expected_table) INTO has_value USING a;
          IF NOT has_value THEN
            RAISE EXCEPTION '${import.meta.path}:60: assertion requires exactly one typed value; retraction requires none';
          END IF;
        END IF;
        RETURN NULL;
      END $$`);
    for (const table of ['assertion',...names]) {
      trigger(table, 'typed_value', 'graph_value_check', 5, true,
        `CREATE CONSTRAINT TRIGGER typed_value AFTER INSERT ON "${table}" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION graph_value_check()`);
    }

    const keyFields = contract.vertex.flatMap(kind => kind.key.map(name => {
      const field = kind.fields.find(field => field.name === name)!;
      return `(${literal(kind.name)},${literal(name)},${literal(assertionValueTableName(kind.name,'vertex',name))},${literal(sqlType(field))})`;
    }));
    // Contract metadata is separate from the one validation plan (0039.2,28).
    statements.push(`CREATE OR REPLACE FUNCTION graph_key_fields(kind text)
      RETURNS TABLE(property text,value_table text,value_type text) LANGUAGE sql AS $$
      SELECT property,value_table,value_type FROM (VALUES ${keyFields.length === 0 ? "(NULL::text,NULL::text,NULL::text,NULL::text)" : keyFields.join(',')})
        fields(kind_name,property,value_table,value_type) WHERE kind_name=kind
      $$`);
    statements.push(`CREATE OR REPLACE FUNCTION graph_key_check() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE subject_id bigint; subject_kind text; identity_key jsonb; field record; valid boolean; projected text; BEGIN
        IF TG_TABLE_NAME='node' THEN subject_id:=NEW.id;
        ELSE SELECT attachment.to_node INTO subject_id FROM assertion_vertex_subject s
          JOIN edge attachment ON attachment.id=s.subject_edge_id WHERE s.assertion_id=NEW.assertion_id; END IF;
        IF subject_id IS NULL THEN RETURN NULL; END IF;
        SELECT k.name,n.key INTO subject_kind,identity_key FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.id=subject_id;
        FOR field IN SELECT * FROM graph_key_fields(subject_kind) LOOP
          IF NOT (identity_key ? field.property) THEN
            RAISE EXCEPTION '${import.meta.path}:214: IMMUTABLE_KEY missing or contradictory assertion for %.%',subject_kind,field.property;
          END IF;
          projected := CASE WHEN field.value_type='jsonb' THEN '$2->$3' ELSE format('($2->>$3)::%s',field.value_type) END;
          EXECUTE format('WITH subject_assertions AS MATERIALIZED (
            SELECT s.assertion_id FROM edge attachment JOIN assertion_vertex_subject s ON s.subject_edge_id=attachment.id
            WHERE attachment.to_node=$1)
            SELECT count(v.assertion_id)>0 AND NOT coalesce(bool_or(a.operation<>''assert'' OR a.language IS NOT NULL OR v.value IS DISTINCT FROM %s),false)
            FROM subject_assertions s JOIN assertion a ON a.assertion_id=s.assertion_id
            LEFT JOIN %I v ON v.assertion_id=a.assertion_id WHERE a.property=$3',projected,field.value_table)
            INTO valid USING subject_id,identity_key,field.property;
          IF NOT valid THEN
            RAISE EXCEPTION '${import.meta.path}:214: IMMUTABLE_KEY missing or contradictory assertion for %.%',subject_kind,field.property;
          END IF;
        END LOOP;
        RETURN NULL;
      END $$`);
    const keyTables = contract.vertex.flatMap(kind => kind.key.map(name => assertionValueTableName(kind.name,'vertex',name)));
    for (const table of ['node','assertion','assertion_vertex_subject',...keyTables]) {
      trigger(table, 'immutable_key', 'graph_key_check', 5, true,
        `CREATE CONSTRAINT TRIGGER immutable_key AFTER INSERT ON "${table}" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION graph_key_check()`);
    }
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
