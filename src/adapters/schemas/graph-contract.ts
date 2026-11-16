/** Generated typed assertion storage, decision 0039 items 10 and 25. */
import type { OuterTransaction } from '../database-owner.js';
import { withSpan } from '../../obs/trace.js';
import { assertionValueTableName, type FieldContract, type GraphContract } from '../../graph/contract.js';
import { validateValueContracts } from '../../graph/value-validation.js';
import { DISPUTE_EXISTENCE_SETTING } from '../../graph/assertion-selection.js';
import { isDisputableProperty, withAssertionContract } from '../../graph/system-contract.js';

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

/** The generated storage contains values, not relations or identity strings. */
export async function createContractTablesIn(tx: OuterTransaction, declared: GraphContract): Promise<void> {
  return await withSpan('graph.schema.contract', {}, async () => {
    const contract = withAssertionContract(declared);
    validateValueContracts(contract);
    const checks: string[] = [];
    const names: string[] = [];
    for (const sort of ['vertex','edge'] as const) {
      for (const kind of contract[sort]) {
        await tx.query(`INSERT INTO entity(name,sort,repeats,discriminator) VALUES($1,$2,$3,$4)
          ON CONFLICT(name) DO UPDATE SET sort=excluded.sort,repeats=excluded.repeats,discriminator=excluded.discriminator`,
          [kind.name,sort === 'vertex' ? 'node':'edge',sort === 'edge' ? ('repeats' in kind && kind.repeats):false,'discriminator' in kind ? kind.discriminator ?? null:null]);
        const fields: readonly FieldContract[] = [{name:'$exists',type:'boolean'}, ...kind.fields];
        for (const field of fields) {
          const table = assertionValueTableName(kind.name,sort,field.name);
          names.push(table);
          await tx.query(`CREATE TABLE IF NOT EXISTS "${table}" (assertion_id bigint PRIMARY KEY REFERENCES assertion(assertion_id), value ${sqlType(field)}${field.nullable === true ? '' : ' NOT NULL'})`);
          await tx.query(`CREATE OR REPLACE TRIGGER immutable BEFORE UPDATE OR DELETE ON "${table}" FOR EACH ROW EXECUTE FUNCTION graph_immutable()`);
          const literal = (value: string): string => "'" + value.split("'").join("''") + "'";
          checks.push(`WHEN subject_sort=${literal(sort)} AND subject_kind=${literal(kind.name)} AND h.property=${literal(field.name)} THEN ${literal(table)}`);
        }
      }
    }

    // Deferred checks see the final operation, never a half-created child (0039.28).
    const literal = (value: string): string => "'" + value.split("'").join("''") + "'";
    await tx.query(`CREATE OR REPLACE FUNCTION graph_dispute_selection(ctx bigint) RETURNS uuid[] LANGUAGE plpgsql AS $$
      DECLARE projection jsonb; BEGIN
        IF NOT EXISTS(SELECT 1 FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='system.dispute-resolution') THEN RETURN NULL; END IF;
        projection := nullif(current_setting('${DISPUTE_EXISTENCE_SETTING}',true),'')::jsonb;
        IF projection IS NULL OR projection->>'txid' IS DISTINCT FROM txid_current()::text
          OR projection->>'revision' IS DISTINCT FROM coalesce(nullif(current_setting('madarch.graph_revision',true),''),'0')
          OR projection->>'at' IS NULL
          OR projection->>'recordedAt' IS NULL OR NOT (projection->'contexts' ? ctx::text) THEN
          RAISE EXCEPTION '${import.meta.path}:60: DISPUTE_SELECTION_STALE: checked host must refresh canonical dispute selection';
        END IF;
        RETURN ARRAY(SELECT jsonb_array_elements_text(projection->'contexts'->ctx::text)::uuid);
      END $$`);
    for (const sort of ['vertex','edge'] as const) {
      const setBranches = contract[sort].map(kind => {
        const valueTable = assertionValueTableName(kind.name,sort,'$exists');
        const subject = sort === 'vertex'
          ? 'JOIN assertion_vertex_subject s ON s.assertion_id=a.assertion_id JOIN edge se ON se.id=s.subject_edge_id'
          : 'JOIN assertion_edge_subject s ON s.assertion_id=a.assertion_id';
        const id = sort === 'vertex' ? 'se.to_node' : 's.edge_id';
        const layers = `WITH RECURSIVE layers AS (
          SELECT c.id,c.parent,c.parent_recorded_seq,NULL::bigint AS cutoff,0 AS depth FROM context c WHERE c.id=ctx
          UNION ALL SELECT c.id,c.parent,c.parent_recorded_seq,least(l.cutoff,l.parent_recorded_seq),l.depth+1 FROM context c JOIN layers l ON c.id=l.parent
        )`;
        if (sort==='vertex' && kind.name==='system.assertion') return `WHEN ${literal(kind.name)} THEN RETURN QUERY
          ${layers} SELECT a.assertion_id FROM assertion a JOIN layers layer ON layer.id=a.context_id AND (wanted_subject IS NULL OR a.assertion_id=wanted_subject)
          AND (layer.cutoff IS NULL OR a.recorded_sequence<=layer.cutoff);`;
        const resolve = isDisputableProperty(sort,kind.name,'$exists');
        return `WHEN ${literal(kind.name)} THEN
          ${resolve ? 'chosen := graph_dispute_selection(ctx);' : 'chosen := ARRAY[]::uuid[];'}
          snapshot_at := CASE WHEN chosen IS NOT NULL AND ${resolve ? 'true' : 'false'} THEN (nullif(current_setting('${DISPUTE_EXISTENCE_SETTING}',true),'')::jsonb->>'at')::timestamptz ELSE date_trunc('milliseconds',clock_timestamp()) END;
          RETURN QUERY ${layers}, visible AS (
            SELECT ${id} AS subject_id,source.to_node AS source_id,an.uid AS assertion_uid,a.operation,v.value,a.valid_from,a.valid_to,a.recorded_sequence,
              layer.depth,min(layer.depth) OVER (PARTITION BY ${id},source.to_node) AS nearest
            FROM assertion a ${subject} JOIN node an ON an.id=a.assertion_id
            JOIN layers layer ON layer.id=a.context_id AND (layer.cutoff IS NULL OR a.recorded_sequence<=layer.cutoff)
            JOIN edge source ON source.from_node=a.assertion_id
            JOIN entity sk ON sk.id=source.entity_id AND sk.name='system.assertion-source'
            LEFT JOIN "${valueTable}" v ON v.assertion_id=a.assertion_id
            WHERE a.property='$exists' AND (wanted_subject IS NULL OR ${id}=wanted_subject) ${resolve ? `AND (chosen IS NULL OR date_trunc('milliseconds',a.recorded_at)<=(nullif(current_setting('${DISPUTE_EXISTENCE_SETTING}',true),'')::jsonb->>'recordedAt')::timestamptz)` : ''}
          ), current_stream AS (
            SELECT DISTINCT ON (subject_id,source_id) subject_id,assertion_uid,operation,value FROM visible
            WHERE depth=nearest AND date_trunc('milliseconds',valid_from)<=snapshot_at AND (valid_to IS NULL OR date_trunc('milliseconds',valid_to)>snapshot_at)
            ORDER BY subject_id,source_id,recorded_sequence DESC
          ), candidates AS (SELECT * FROM current_stream WHERE operation='assert')
          SELECT subject_id FROM candidates GROUP BY subject_id
          HAVING CASE WHEN bool_or(assertion_uid=ANY(chosen)) THEN bool_or(value AND assertion_uid=ANY(chosen)) ELSE bool_or(value) END;`;
      });
      await tx.query(`CREATE OR REPLACE FUNCTION graph_${sort}_active_ids(kind text,ctx bigint,wanted_subject bigint DEFAULT NULL) RETURNS SETOF bigint LANGUAGE plpgsql AS $$
        DECLARE chosen uuid[]; snapshot_at timestamptz; BEGIN CASE kind ${setBranches.join(' ')} ELSE RETURN; END CASE; END $$`);
      await tx.query(`CREATE OR REPLACE FUNCTION graph_${sort}_active(subject bigint,kind text,ctx bigint) RETURNS boolean LANGUAGE sql AS $$
        SELECT EXISTS(SELECT 1 FROM graph_${sort}_active_ids(kind,ctx,subject) active(id) WHERE active.id=subject)
      $$`);
    }
    // 0039.20/32: immutable aliases and endpoints, selected through graph merge records.
    await tx.query(`CREATE OR REPLACE FUNCTION graph_merge_target(subject bigint,ctx bigint,valid_at timestamptz DEFAULT clock_timestamp(),recorded_cutoff timestamptz DEFAULT clock_timestamp()) RETURNS bigint LANGUAGE plpgsql STABLE AS $$
      BEGIN
        IF NOT EXISTS(SELECT 1 FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='system.merge') THEN RETURN subject; END IF;
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
    await tx.query(`CREATE OR REPLACE FUNCTION graph_assertion_target(subject bigint,assertion bigint,ctx bigint,valid_at timestamptz,recorded_cutoff timestamptz,side text DEFAULT NULL) RETURNS bigint LANGUAGE plpgsql STABLE AS $$
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
    await tx.query(`CREATE OR REPLACE FUNCTION graph_edge_endpoint(relation bigint,endpoint bigint,side text,ctx bigint,valid_at timestamptz,recorded_cutoff timestamptz) RETURNS bigint LANGUAGE plpgsql STABLE AS $$
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
    await tx.query(`CREATE OR REPLACE FUNCTION graph_effective_edges(ctx bigint,valid_at timestamptz DEFAULT clock_timestamp(),recorded_cutoff timestamptz DEFAULT clock_timestamp()) RETURNS SETOF edge LANGUAGE sql STABLE AS $$
      SELECT e.id,e.uid,e.entity_id,
        CASE WHEN k.name=ANY(ARRAY[${keyEdgeNames.map(literal).join(',')}]::text[]) OR k.capability_system THEN e.from_node ELSE graph_edge_endpoint(e.id,e.from_node,'from',ctx,valid_at,recorded_cutoff) END,
        CASE WHEN k.name=ANY(ARRAY[${keyEdgeNames.map(literal).join(',')}]::text[]) OR k.capability_system THEN e.to_node ELSE graph_edge_endpoint(e.id,e.to_node,'to',ctx,valid_at,recorded_cutoff) END,
        e.discriminator,e.context_id
      FROM edge e JOIN (SELECT entity.*,name=ANY(ARRAY[${contract.edge.filter(e=>e.capability==='system').map(e=>literal(e.name)).join(',')}]::text[]) AS capability_system FROM entity) k ON k.id=e.entity_id
      $$`);
    const relationChecks: string[] = [];
    for (const kind of contract.edge.filter(kind => kind.capability !== 'system')) {
      const edgeKind = literal(kind.name);
      const vertexKinds = [...new Set([...kind.from,...kind.to])];
      const keyEdge=contract.vertex.some(vertex=>vertex.keyEdges?.some(role=>role.edge===kind.name));
      const active = `WITH active_edges AS MATERIALIZED (
        SELECT DISTINCT ctx.id AS context_id,e.entity_id,e.discriminator,${keyEdge?'e.from_node':"graph_edge_endpoint(e.id,e.from_node,'from',ctx.id,clock_timestamp(),clock_timestamp())"} AS from_node,${keyEdge?'e.to_node':"graph_edge_endpoint(e.id,e.to_node,'to',ctx.id,clock_timestamp(),clock_timestamp())"} AS to_node FROM context ctx
        CROSS JOIN LATERAL graph_edge_active_ids(${edgeKind},ctx.id) active(id)
        JOIN edge e ON e.id=active.id
      ), active_vertices AS MATERIALIZED (
        SELECT DISTINCT ctx.id AS context_id,k.name AS kind,${keyEdge?'active.id':'graph_merge_target(active.id,ctx.id)'} AS id FROM context ctx
        CROSS JOIN (VALUES ${vertexKinds.map(name => `(${literal(name)})`).join(',')}) k(name)
        CROSS JOIN LATERAL graph_vertex_active_ids(k.name,ctx.id) active(id)
      )`;
      relationChecks.push(`IF EXISTS(${active}
        SELECT 1 FROM active_edges e
        WHERE NOT EXISTS(SELECT 1 FROM active_vertices f WHERE f.context_id=e.context_id AND f.id=e.from_node AND f.kind=ANY(ARRAY[${kind.from.map(literal).join(',')}]::text[]))
          OR NOT EXISTS(SELECT 1 FROM active_vertices t WHERE t.context_id=e.context_id AND t.id=e.to_node AND t.kind=ANY(ARRAY[${kind.to.map(literal).join(',')}]::text[])))
        THEN RAISE EXCEPTION '${import.meta.path}:118: TARGET_MISSING or END_KIND_INVALID for %',${edgeKind}; END IF;`);
      for (const [direction, ends, bound] of [['from',kind.from,kind.cardinality.to],['to',kind.to,kind.cardinality.from]] as const) {
        if (bound === 'many') continue;
        relationChecks.push(`IF EXISTS(${active}
          SELECT 1 FROM active_vertices n LEFT JOIN active_edges e ON e.context_id=n.context_id AND e.${direction}_node=n.id
          WHERE n.kind=ANY(ARRAY[${ends.map(literal).join(',')}]::text[])
          GROUP BY n.context_id,n.id HAVING count(e.entity_id) ${bound==='one'?'<> 1':bound==='some'?'< 1':'> 1'})
          THEN RAISE EXCEPTION '${import.meta.path}:125: CARDINALITY_INVALID for %',${edgeKind}; END IF;`);
      }
    }
    await tx.query(`CREATE OR REPLACE FUNCTION graph_relations_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM set_config('madarch.graph_revision',(coalesce(nullif(current_setting('madarch.graph_revision',true),''),'0')::bigint+1)::text,true);
        RETURN NEW;
      END $$`);
    await tx.query(`CREATE OR REPLACE FUNCTION graph_relations_check() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE revision text; BEGIN
      revision := current_setting('madarch.graph_revision',true);
      IF current_setting('madarch.checked_graph_revision',true)=revision THEN RETURN NULL; END IF;
      ${relationChecks.join('\n')}
      PERFORM set_config('madarch.checked_graph_revision',revision,true);
      RETURN NULL; END $$`);
    for (const table of ['node','edge','assertion','context','assertion_vertex_subject','assertion_edge_subject',...names]) {
      await tx.query(`CREATE OR REPLACE TRIGGER graph_relations_dirty BEFORE INSERT ON "${table}" FOR EACH ROW EXECUTE FUNCTION graph_relations_dirty()`);
      await tx.query(`DROP TRIGGER IF EXISTS graph_relations ON "${table}"`);
      await tx.query(`CREATE CONSTRAINT TRIGGER graph_relations AFTER INSERT ON "${table}" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION graph_relations_check()`);
    }

    await tx.query(`CREATE OR REPLACE FUNCTION graph_value_check() RETURNS trigger LANGUAGE plpgsql AS $$
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
      await tx.query(`DROP TRIGGER IF EXISTS typed_value ON "${table}"`);
      await tx.query(`CREATE CONSTRAINT TRIGGER typed_value AFTER INSERT ON "${table}" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION graph_value_check()`);
    }

    const keyChecks = contract.vertex.filter(kind => kind.key.length > 0).map(kind => {
      const fields: readonly FieldContract[] = kind.key.map(name => kind.fields.find(field => field.name === name)!);
      return `WHEN ${literal(kind.name)} THEN
        ${fields.map(field => {
          const table = assertionValueTableName(kind.name,'vertex',field.name);
          const projected = field.type === 'json' ? `identity_key->${literal(field.name)}` : `(identity_key->>${literal(field.name)})::${sqlType(field)}`;
          return `IF NOT (identity_key ? ${literal(field.name)}) OR NOT EXISTS(
            SELECT 1 FROM assertion a JOIN assertion_vertex_subject s ON s.assertion_id=a.assertion_id
            JOIN edge attachment ON attachment.id=s.subject_edge_id JOIN "${table}" v ON v.assertion_id=a.assertion_id
            WHERE attachment.to_node=subject_id AND a.property=${literal(field.name)} AND a.operation='assert')
            OR EXISTS(SELECT 1 FROM assertion a JOIN assertion_vertex_subject s ON s.assertion_id=a.assertion_id
            JOIN edge attachment ON attachment.id=s.subject_edge_id LEFT JOIN "${table}" v ON v.assertion_id=a.assertion_id
            WHERE attachment.to_node=subject_id AND a.property=${literal(field.name)}
              AND (a.operation<>'assert' OR a.language IS NOT NULL OR v.value IS DISTINCT FROM ${projected}))
          THEN RAISE EXCEPTION '${import.meta.path}:214: IMMUTABLE_KEY missing or contradictory assertion for %.%',subject_kind,${literal(field.name)}; END IF;`;
        }).join('\n')}`;
    });
    await tx.query(`CREATE OR REPLACE FUNCTION graph_key_check() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE subject_id bigint; subject_kind text; identity_key jsonb; BEGIN
        IF TG_TABLE_NAME='node' THEN subject_id:=NEW.id;
        ELSE SELECT attachment.to_node INTO subject_id FROM assertion_vertex_subject s
          JOIN edge attachment ON attachment.id=s.subject_edge_id WHERE s.assertion_id=NEW.assertion_id; END IF;
        IF subject_id IS NULL THEN RETURN NULL; END IF;
        SELECT k.name,n.key INTO subject_kind,identity_key FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.id=subject_id;
        CASE subject_kind ${keyChecks.join('\n')} ELSE NULL; END CASE;
        RETURN NULL;
      END $$`);
    const keyTables = contract.vertex.flatMap(kind => kind.key.map(name => assertionValueTableName(kind.name,'vertex',name)));
    for (const table of ['node','assertion','assertion_vertex_subject',...keyTables]) {
      await tx.query(`DROP TRIGGER IF EXISTS immutable_key ON "${table}"`);
      await tx.query(`CREATE CONSTRAINT TRIGGER immutable_key AFTER INSERT ON "${table}" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION graph_key_check()`);
    }
  });
}
