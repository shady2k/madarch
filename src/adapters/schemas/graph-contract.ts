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

/** Keep standing trigger definitions: replacing them locks out page readers. */
async function installTrigger(tx: OuterTransaction, table: string, name: string, fn: string, type: number, deferred: boolean, statement: string): Promise<void> {
  return await withSpan('graph.schema.trigger', {}, async () => {
    const held = await tx.query<{ matches: boolean }>(`SELECT
      t.tgfoid = to_regproc($3) AND t.tgtype = $4 AND t.tgenabled = 'O'
      AND t.tgdeferrable = $5 AND t.tginitdeferred = $5
      AND (t.tgconstraint <> 0) = $5 AND t.tgnargs = 0 AND t.tgattr::text = ''
      AND t.tgqual IS NULL AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL AS matches
      FROM pg_trigger t WHERE t.tgrelid = $1::regclass AND t.tgname = $2 AND NOT t.tgisinternal`,
      [table, name, fn, type, deferred]);
    if (held.rows[0]?.matches === true) return;
    if (held.rows.length > 0) await tx.query(`DROP TRIGGER "${name}" ON "${table}"`);
    await tx.query(statement);
  });
}

/** The generated storage contains values, not relations or identity strings. */
export async function createContractTablesIn(tx: OuterTransaction, declared: GraphContract): Promise<void> {
  return await withSpan('graph.schema.contract', {}, async () => {
    const contract = withAssertionContract(declared);
    validateValueContracts(contract);
    // A previous build forbade self relations; other edge checks remain untouched.
    const legacy = await tx.query<{ definition: string }>(`SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid='edge'::regclass AND conname='edge_check' AND contype='c'`);
    if (legacy.rows[0]?.definition === 'CHECK ((from_node <> to_node))') {
      await tx.query('ALTER TABLE edge DROP CONSTRAINT edge_check');
    }
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
          await installTrigger(tx, table, 'immutable', 'graph_immutable', 27, false,
        `CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON "${table}" FOR EACH ROW EXECUTE FUNCTION graph_immutable()`);
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
        const targetAssertions = sort === 'vertex'
          ? 'SELECT s.assertion_id FROM edge se CROSS JOIN LATERAL (SELECT av.assertion_id FROM assertion_vertex_subject av WHERE av.subject_edge_id=se.id OFFSET 0) s WHERE se.to_node=wanted_subject'
          : 'SELECT s.assertion_id FROM assertion_edge_subject s WHERE s.edge_id=wanted_subject';
        const activeQuery = (bounded: boolean): string => `          RETURN QUERY ${layers}${bounded ? `, target_assertions AS MATERIALIZED (${targetAssertions})` : ''}, visible AS (
            SELECT ${id} AS subject_id,source.to_node AS source_id,an.uid AS assertion_uid,a.operation,v.value,a.valid_from,a.valid_to,a.recorded_sequence,
              layer.depth,min(layer.depth) OVER (PARTITION BY ${id},source.to_node) AS nearest
            FROM ${bounded ? 'target_assertions target CROSS JOIN LATERAL (SELECT header.* FROM assertion header WHERE header.assertion_id=target.assertion_id OFFSET 0) a' : 'assertion a'} ${subject} JOIN node an ON an.id=a.assertion_id
            JOIN layers layer ON layer.id=a.context_id AND (layer.cutoff IS NULL OR a.recorded_sequence<=layer.cutoff)
            JOIN edge source ON source.from_node=a.assertion_id
            JOIN entity sk ON sk.id=source.entity_id AND sk.name='system.assertion-source'
            LEFT JOIN "${valueTable}" v ON v.assertion_id=a.assertion_id
            WHERE a.property='$exists' ${bounded ? '' : `AND (wanted_subject IS NULL OR ${id}=wanted_subject)`} ${resolve ? `AND (chosen IS NULL OR date_trunc('milliseconds',a.recorded_at)<=(nullif(current_setting('${DISPUTE_EXISTENCE_SETTING}',true),'')::jsonb->>'recordedAt')::timestamptz)` : ''}
          ), current_stream AS (
            SELECT DISTINCT ON (subject_id,source_id) subject_id,assertion_uid,operation,value FROM visible
            WHERE depth=nearest AND date_trunc('milliseconds',valid_from)<=snapshot_at AND (valid_to IS NULL OR date_trunc('milliseconds',valid_to)>snapshot_at)
            ORDER BY subject_id,source_id,recorded_sequence DESC
          ), candidates AS (SELECT * FROM current_stream WHERE operation='assert')
          SELECT subject_id FROM candidates GROUP BY subject_id
          HAVING CASE WHEN bool_or(assertion_uid=ANY(chosen)) THEN bool_or(value AND assertion_uid=ANY(chosen)) ELSE bool_or(value) END;`;
        return `WHEN ${literal(kind.name)} THEN
          ${resolve ? 'chosen := graph_dispute_selection(ctx);' : 'chosen := ARRAY[]::uuid[];'}
          snapshot_at := CASE WHEN chosen IS NOT NULL AND ${resolve ? 'true' : 'false'} THEN (nullif(current_setting('${DISPUTE_EXISTENCE_SETTING}',true),'')::jsonb->>'at')::timestamptz ELSE date_trunc('milliseconds',clock_timestamp()) END;
          IF wanted_subject IS NULL THEN ${activeQuery(false)} ELSE ${activeQuery(true)} END IF;`;
      });
      await tx.query(`CREATE OR REPLACE FUNCTION graph_${sort}_active_ids(kind text,ctx bigint,wanted_subject bigint DEFAULT NULL) RETURNS SETOF bigint LANGUAGE plpgsql AS $$
        DECLARE chosen uuid[]; snapshot_at timestamptz; BEGIN CASE kind ${setBranches.join(' ')} ELSE RETURN; END CASE; END $$`);
      await tx.query(`CREATE OR REPLACE FUNCTION graph_${sort}_active(subject bigint,kind text,ctx bigint) RETURNS boolean LANGUAGE sql AS $$
        SELECT EXISTS(SELECT 1 FROM graph_${sort}_active_ids(kind,ctx,subject) active(id) WHERE active.id=subject)
      $$`);
    }
    const relationChecks: string[] = [];
    for (const kind of contract.edge.filter(kind => kind.capability !== 'system')) {
      const edgeKind = literal(kind.name);
      const vertexKinds = [...new Set([...kind.from,...kind.to])];
      const active = `WITH active_edges AS MATERIALIZED (
        SELECT ctx.id AS context_id,e.id,e.from_node,e.to_node FROM context ctx
        CROSS JOIN LATERAL graph_edge_active_ids(${edgeKind},ctx.id) active(id)
        JOIN edge e ON e.id=active.id
      ), active_vertices AS MATERIALIZED (
        SELECT ctx.id AS context_id,k.name AS kind,active.id FROM context ctx
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
          GROUP BY n.context_id,n.id HAVING count(e.id) ${bound==='one'?'<> 1':bound==='some'?'< 1':'> 1'})
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
      await installTrigger(tx, table, 'graph_relations_dirty', 'graph_relations_dirty', 7, false,
        `CREATE TRIGGER graph_relations_dirty BEFORE INSERT ON "${table}" FOR EACH ROW EXECUTE FUNCTION graph_relations_dirty()`);
      await installTrigger(tx, table, 'graph_relations', 'graph_relations_check', 5, true,
        `CREATE CONSTRAINT TRIGGER graph_relations AFTER INSERT ON "${table}" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION graph_relations_check()`);
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
      await installTrigger(tx, table, 'typed_value', 'graph_value_check', 5, true,
        `CREATE CONSTRAINT TRIGGER typed_value AFTER INSERT ON "${table}" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION graph_value_check()`);
    }

    const keyChecks = contract.vertex.filter(kind => kind.key.length > 0).map(kind => {
      const fields: readonly FieldContract[] = kind.key.map(name => kind.fields.find(field => field.name === name)!);
      return `WHEN ${literal(kind.name)} THEN
        ${fields.map(field => {
          const table = assertionValueTableName(kind.name,'vertex',field.name);
          const projected = field.type === 'json' ? `identity_key->${literal(field.name)}` : `(identity_key->>${literal(field.name)})::${sqlType(field)}`;
          const subjectAssertions = `WITH subject_assertions AS MATERIALIZED (
            SELECT s.assertion_id FROM edge attachment JOIN assertion_vertex_subject s ON s.subject_edge_id=attachment.id
            WHERE attachment.to_node=subject_id)`;
          return `IF NOT (identity_key ? ${literal(field.name)}) OR NOT EXISTS(
            ${subjectAssertions}
            SELECT 1 FROM subject_assertions s JOIN assertion a ON a.assertion_id=s.assertion_id
            JOIN "${table}" v ON v.assertion_id=a.assertion_id
            WHERE a.property=${literal(field.name)} AND a.operation='assert')
            OR EXISTS(${subjectAssertions}
            SELECT 1 FROM subject_assertions s JOIN assertion a ON a.assertion_id=s.assertion_id
            LEFT JOIN "${table}" v ON v.assertion_id=a.assertion_id
            WHERE a.property=${literal(field.name)}
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
      await installTrigger(tx, table, 'immutable_key', 'graph_key_check', 5, true,
        `CREATE CONSTRAINT TRIGGER immutable_key AFTER INSERT ON "${table}" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION graph_key_check()`);
    }
  });
}
