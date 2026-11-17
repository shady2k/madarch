/** Subject-first startup read, using the ordinary item 25 assertion selection. */
import { withSpan } from '../obs/trace.js';
import type { SqlExecutor } from '../sql-driver.js';
import { assertionSelectionSql } from './assertion-read.js';
import { SYSTEM_CONTRACT } from './system-contract.js';
import { assertionValueTableName } from './contract.js';

export async function readPublicationFingerprint(tx: SqlExecutor): Promise<string | undefined> {
  return await withSpan('graph.startup.read', {}, async () => {
    // An ordered index seek avoids scanning the small kind dictionary once per lineage step.
    const kindId = (name: string) => `(SELECT id FROM (SELECT id,name FROM entity WHERE name>='${name}' ORDER BY name LIMIT 1) found WHERE name='${name}')`;
    const subjectKind = kindId('system.assertion-subject');
    const sourceKind = kindId('system.assertion-source');
    const assertions = (subject: string, kind: string, properties: readonly string[]) => {
      const values = properties.map(property => `SELECT to_jsonb(value) AS value FROM "${assertionValueTableName(kind, 'vertex', property)}" WHERE assertion_id=a.assertion_id AND a.property='${property}' OFFSET 0`).map(sql => `(${sql})`).join(' UNION ALL ');
      return `SELECT 0 AS request_index,se.to_node AS subject_id,a.property,a.language,an.uid::text AS id,
        a.context_id,a.operation,a.valid_from,a.valid_to,a.recorded_at,a.recorded_sequence,source.uid::text AS source,v.value
        FROM LATERAL (SELECT e.from_node,e.to_node FROM edge e WHERE e.to_node=${subject}
          AND e.entity_id=${subjectKind} OFFSET 0) se
        CROSS JOIN LATERAL (SELECT * FROM assertion WHERE assertion_id=se.from_node AND property IN (${properties.map(p => `'${p}'`).join(',')}) OFFSET 0) a
        CROSS JOIN LATERAL (${values}) v
        CROSS JOIN LATERAL (SELECT uid FROM node WHERE id=a.assertion_id OFFSET 0) an
        CROSS JOIN LATERAL (SELECT to_node FROM edge WHERE from_node=a.assertion_id AND entity_id=${sourceKind} OFFSET 0) lineage
        CROSS JOIN LATERAL (SELECT uid FROM node WHERE id=lineage.to_node OFFSET 0) source`;
    };
    const marker = assertionSelectionSql(`SELECT raw.* FROM (SELECT id FROM node WHERE entity_id=${kindId('manifest.catalogue')} AND key='{"name":"product"}'::jsonb OFFSET 0) catalogue
      CROSS JOIN LATERAL (${assertions('catalogue.id', 'manifest.catalogue', ['publication_fingerprint'])}) raw`);
    const installation = assertionSelectionSql(assertions('producer.id', 'plugin', SYSTEM_CONTRACT.vertex.find(kind => kind.name === 'plugin')!.fields.map(field => field.name)));
    const rows = await tx.query<{ fingerprint: string }>(`SELECT marker.value #>> '{}' AS fingerprint FROM (${marker}) marker
      CROSS JOIN LATERAL (SELECT id,identity_scope FROM node WHERE uid=marker.source::uuid OFFSET 0) producer
      CROSS JOIN LATERAL (SELECT
        bool_or(selected AND property='installation' AND value=to_jsonb($1::text)) AS manifest,
        bool_or(selected AND property='scope' AND value=to_jsonb(producer.identity_scope::text)) AS scoped
        FROM (${installation}) current_source OFFSET 0) installed
      WHERE marker.selected AND installed.manifest AND installed.scoped`, [JSON.stringify(['system-engine', 'manifest'])]);
    return rows.rows[0]?.fingerprint;
  });
}
