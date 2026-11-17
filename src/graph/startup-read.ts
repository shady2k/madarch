/** Bounded startup reads: only the named subjects and properties, with the ordinary assertion selection rules. */
import { withSpan } from '../obs/trace.js';
import type { SqlExecutor } from '../sql-driver.js';
import { assertionSelectionSql } from './assertion-read.js';
import { assertionValueTableName } from './contract.js';

export async function readStartupAssertions(tx: SqlExecutor, kind: string, properties: readonly string[], key?: Readonly<Record<string, unknown>>) {
  return await withSpan('graph.startup.read', {}, async () => {
  const subjects = `SELECT n.id,n.uid::text,n.key FROM node n
    WHERE n.entity_id=(SELECT id FROM entity WHERE name=$1 AND sort='node') ${key === undefined ? '' : 'AND n.key=$3::jsonb'}`;
  const values = properties.map(property => {
    const literal = "'" + property.replaceAll("'", "''") + "'";
    return `SELECT to_jsonb(value) AS value FROM "${assertionValueTableName(kind, 'vertex', property)}" WHERE assertion_id=a.assertion_id AND a.property=${literal}`;
  }).join(' UNION ALL ');
  const raw = `SELECT 0 AS request_index,se.to_node AS subject_id,a.property,a.language,an.uid::text AS id,
    a.context_id,a.operation,a.valid_from,a.valid_to,a.recorded_at,a.recorded_sequence,
    source.uid::text AS source,v.value
    FROM (${subjects}) wanted
    CROSS JOIN LATERAL (SELECT e.from_node,e.to_node FROM edge e WHERE e.to_node=wanted.id
      AND e.entity_id=(SELECT id FROM entity WHERE name='system.assertion-subject') OFFSET 0) se
    JOIN assertion a ON a.assertion_id=se.from_node
    JOIN node an ON an.id=a.assertion_id
    CROSS JOIN LATERAL (${values}) v
    JOIN edge lineage ON lineage.from_node=a.assertion_id AND lineage.entity_id=(SELECT id FROM entity WHERE name='system.assertion-source')
    JOIN node source ON source.id=lineage.to_node
    WHERE a.property=ANY($2::text[])`;
  const rows = await tx.query<{ id: number; uid: string; key: Record<string, unknown>; assertions: { property: string; source: string; value: unknown }[] }>(
    `SELECT subject.id,subject.uid,subject.key,coalesce(jsonb_agg(jsonb_build_object('property',chosen.property,'source',chosen.source,'value',chosen.value)) FILTER (WHERE chosen.selected),'[]'::jsonb) AS assertions
     FROM (${subjects}) subject LEFT JOIN (${assertionSelectionSql(raw)}) chosen ON chosen.subject_id=subject.id
     GROUP BY subject.id,subject.uid,subject.key`, [kind, properties, ...(key === undefined ? [] : [JSON.stringify(key)])]);
  return rows.rows;
  });
}
