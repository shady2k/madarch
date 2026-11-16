/** Typed assertion reads shared by every graph view (decision 0039, item 25). */
import type { SqlExecutor } from '../sql-driver.js';
import { withSpan } from '../obs/trace.js';
import { assertionValueTableName } from './contract.js';
import { selectAssertions, type AssertionRow, type AssertionSelection } from './assertion-selection.js';

export interface StoredAssertion extends AssertionRow {
  readonly subjectId: number;
  readonly author: string;
  readonly unit: string | null;
  readonly operationUid: string;
  readonly evidence: readonly string[];
}

export interface AssertionReadRequest {
  readonly sort: 'vertex' | 'edge';
  readonly kind: string;
  readonly properties: readonly string[];
  readonly subjectIds?: readonly number[];
}

function assertionJSON(this: StoredAssertion): Omit<StoredAssertion, 'recordedSequence'> & { recordedSequence: string } {
  return { ...this, recordedSequence: this.recordedSequence.toString() };
}

/** Numeric ids are internal joins only; all exposed identities are graph uids. */
export async function loadAssertions(executor: SqlExecutor, sort: 'vertex' | 'edge', kind: string, properties: readonly string[], subjectIds?: readonly number[]): Promise<StoredAssertion[]> {
  return (await loadAssertionsBatch(executor, [{ sort, kind, properties, ...(subjectIds === undefined ? {} : { subjectIds }) }]))[0]!;
}

/** One statement reads independent typed requests without merging their field or subject boundaries. */
export async function loadAssertionsBatch(executor: SqlExecutor, requests: readonly AssertionReadRequest[]): Promise<StoredAssertion[][]> {
  return await withSpan('graph.assertions.read', { 'madarch.requests': requests.length }, async () => {
    const result: StoredAssertion[][] = requests.map(() => []);
    const parameters: unknown[] = [];
    const param = (value: unknown): string => { parameters.push(value); return `$${parameters.length}`; };
    const statements: string[] = [];
    for (const [requestIndex, { sort, kind, properties, subjectIds }] of requests.entries()) {
      if (properties.length === 0 || subjectIds?.length === 0) continue;
    const values=properties.map(property=>{
      const table=assertionValueTableName(kind,sort,property);
      const literal="'"+property.replaceAll("'","''")+"'";
      return `SELECT assertion_id,${literal}::text AS property,CASE WHEN pg_typeof(value)::text='bigint' THEN to_jsonb(value::text) ELSE to_jsonb(value) END AS value,pg_typeof(value)::text AS value_type FROM "${table}" WHERE a.property=${literal} AND assertion_id=a.assertion_id`;
    }).join(' UNION ALL ');
      const subjectJoin = sort === 'vertex'
        ? `JOIN assertion_vertex_subject attachment ON attachment.assertion_id=a.assertion_id
           JOIN edge subject_edge ON subject_edge.id=attachment.subject_edge_id
           JOIN node subject ON subject.id=subject_edge.to_node
           JOIN entity subject_kind ON subject_kind.id=subject.entity_id`
        : `JOIN assertion_edge_subject attachment ON attachment.assertion_id=a.assertion_id
           JOIN edge subject ON subject.id=attachment.edge_id
           JOIN entity subject_kind ON subject_kind.id=subject.entity_id
           JOIN node edge_from ON edge_from.id=subject.from_node
           JOIN node edge_to ON edge_to.id=subject.to_node`;
      const kindParameter = param(kind);
      const propertiesParameter = param(properties);
      const subjectsParameter = subjectIds === undefined ? undefined : param(subjectIds);
      statements.push(`SELECT ${requestIndex}::integer AS request_index, array_position(${propertiesParameter}::text[],assertion_rows.property) AS property_rank, assertion_rows.* FROM (
 SELECT assertion_node.uid::text AS id, subject.id AS subject_id, subject.uid::text AS subject_uid,
        ${sort === 'edge' ? 'edge_from.uid::text AS edge_from, edge_to.uid::text AS edge_to' : 'NULL::text AS edge_from, NULL::text AS edge_to'},
        a.property,a.context_id,a.language,a.operation,a.valid_from,a.valid_to,a.recorded_at,a.recorded_sequence::text,
        value_row.value,value_row.value_type,
        lineage.source,lineage.author,lineage.unit,lineage.operation_uid,lineage.evidence
        FROM assertion a JOIN node assertion_node ON assertion_node.id=a.assertion_id
        ${subjectJoin} LEFT JOIN LATERAL (${values}) value_row ON TRUE
        LEFT JOIN LATERAL (
          SELECT (SELECT value FROM unnest(array_agg(target.uid::text) FILTER (WHERE k.name='system.assertion-source')) AS scalar(value)) AS source,
                 (SELECT value FROM unnest(array_agg(target.uid::text) FILTER (WHERE k.name='system.assertion-author')) AS scalar(value)) AS author,
                 (SELECT value FROM unnest(array_agg(target.uid::text) FILTER (WHERE k.name='system.assertion-unit')) AS scalar(value)) AS unit,
                 (SELECT value FROM unnest(array_agg(target.uid::text) FILTER (WHERE k.name='system.assertion-operation')) AS scalar(value)) AS operation_uid,
                 coalesce(array_agg(target.uid::text ORDER BY target.uid) FILTER (WHERE k.name='system.assertion-evidence'),ARRAY[]::text[]) AS evidence
          FROM edge lineage JOIN entity k ON k.id=lineage.entity_id JOIN node target ON target.id=lineage.to_node
          WHERE lineage.from_node=a.assertion_id
            AND k.name IN ('system.assertion-source','system.assertion-author','system.assertion-unit','system.assertion-operation','system.assertion-evidence')
        ) lineage ON TRUE
        WHERE subject_kind.name=${kindParameter} AND a.property=ANY(${propertiesParameter}::text[]) ${subjectsParameter === undefined ? '' : `AND subject.id=ANY(${subjectsParameter}::bigint[])`}
        ORDER BY array_position(${propertiesParameter}::text[],a.property),a.recorded_sequence) assertion_rows`);
    }
    if (statements.length === 0) return result;
    const { rows } = await executor.query<{
      request_index: number;
        id: string; subject_id: number; subject_uid: string; edge_from: string | null; edge_to: string | null;
        property: string; context_id: number; language: string | null; source: string; author: string;
        unit: string | null; operation_uid: string; evidence: string[]; value: unknown; value_type:string|null;
        operation: 'assert' | 'retract'; valid_from: string | Date; valid_to: string | Date | null;
        recorded_at: string | Date; recorded_sequence: string;
    }>(`SELECT * FROM (${statements.join(' UNION ALL ')}) batches ORDER BY request_index,property_rank,recorded_sequence::bigint`, parameters);
      const text = (value: string | Date): string => value instanceof Date ? value.toISOString() : value;
      for (const row of rows) {
        const request = requests[row.request_index]!;
        const assertion = {
        id: row.id,
        subject: request.sort === 'vertex' ? { type: 'vertex', uid: row.subject_uid } : { type: 'edge', id: row.subject_uid, kind: request.kind, from: row.edge_from!, to: row.edge_to! },
        subjectId: Number(row.subject_id), property: row.property, context: Number(row.context_id), language: row.language,
        source: row.source, author: row.author, unit: row.unit, operationUid: row.operation_uid, evidence: row.evidence,
        value: row.value_type === 'bigint' && typeof row.value === 'string' && Number.isSafeInteger(Number(row.value)) ? Number(row.value) : row.value_type==='timestamp with time zone'&&typeof row.value==='string' ? new Date(row.value).toISOString() : row.value instanceof Date ? row.value.toISOString() : row.value, operation: row.operation, validFrom: text(row.valid_from), validTo: row.valid_to === null ? null : text(row.valid_to),
        recordedAt: text(row.recorded_at), recordedSequence: BigInt(row.recorded_sequence),
      } satisfies StoredAssertion;
        Object.defineProperty(assertion, 'toJSON', { value: assertionJSON });
        result[row.request_index]!.push(assertion);
      }
    return result;
  });
}

/** Batch callers partition by subject, property and language before source survivorship. */
export function selectAssertionSlots(rows: readonly StoredAssertion[], options: Parameters<typeof selectAssertions>[1]): ReadonlyMap<string, AssertionSelection> {
  const slots = new Map<string, StoredAssertion[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.subject.type, row.subject.type === 'vertex' ? row.subject.uid : row.subject.id, row.property, row.language]);
    const values = slots.get(key) ?? [];
    values.push(row);
    slots.set(key, values);
  }
  return new Map([...slots].map(([key, values]) => [key, selectAssertions(values, options)]));
}

/** Active source existence, never historical identity presence (0039 items 25, 26 and 30).
 * Structural assertion lineage is attached to immutable headers, not recursively asserted.
 */
export function activeExistenceSql(sort: 'vertex' | 'edge', alias: string, kinds: readonly string[], options: { readonly validAt: string; readonly recordedAt: string; readonly contexts: readonly number[]; readonly contextRecordedThrough?: Readonly<Record<number, string | null>>; readonly resolvedAssertionIds?: readonly string[] }, structural: readonly string[] = []): string {
  const quote = (value: string): string => "'" + value.replaceAll("'", "''") + "'";
  if (!Number.isFinite(Date.parse(options.validAt)) || !Number.isFinite(Date.parse(options.recordedAt)) || options.contexts.length === 0 || options.contexts.some((id) => !Number.isSafeInteger(id)) || Object.entries(options.contextRecordedThrough ?? {}).some(([id, cutoff]) => !Number.isSafeInteger(Number(id)) || (cutoff !== null && (BigInt(cutoff) < 0n || BigInt(cutoff).toString() !== cutoff)))) throw new Error(`${import.meta.path}:96: invalid temporal selector`);
  const contexts = `ARRAY[${options.contexts.join(',')}]::bigint[]`;
  const sequenceFence = (alias: string): string => Object.entries(options.contextRecordedThrough ?? {}).filter(([, cutoff]) => cutoff !== null).map(([id, cutoff]) => `(${alias}.context_id<>${Number(id)} OR ${alias}.recorded_sequence<=${BigInt(cutoff!)})`).join(' AND ') || 'TRUE';
  const values = kinds.filter((kind) => !structural.includes(kind)).map((kind) => `SELECT v.assertion_id,v.value FROM "${assertionValueTableName(kind, sort, '$exists')}" v`);
  const structuralClause = sort === 'vertex'
    ? `(${alias}.entity_id=(SELECT id FROM entity WHERE name='system.assertion') AND EXISTS (SELECT 1 FROM assertion header WHERE header.assertion_id=${alias}.id AND header.context_id=ANY(${contexts}) AND header.recorded_at<=${quote(options.recordedAt)}::timestamptz AND ${sequenceFence('header')} AND header.valid_from<=${quote(options.validAt)}::timestamptz AND (header.valid_to IS NULL OR header.valid_to>${quote(options.validAt)}::timestamptz)))`
    : structural.length === 0 ? 'FALSE' : `${alias}.entity_id IN (SELECT id FROM entity WHERE name IN (${structural.map(quote).join(',')}))`;
  if (values.length === 0) return structuralClause;
  const attachment = sort === 'vertex' ? 'JOIN assertion_vertex_subject av ON av.assertion_id=a.assertion_id JOIN edge subject ON subject.id=av.subject_edge_id' : 'JOIN assertion_edge_subject av ON av.assertion_id=a.assertion_id';
  const subject = sort === 'vertex' ? 'subject.to_node' : 'av.edge_id';
  const targetAssertions = sort === 'vertex'
    ? `SELECT attachment.assertion_id FROM edge subject_edge CROSS JOIN LATERAL (SELECT s.assertion_id FROM assertion_vertex_subject s WHERE s.subject_edge_id=subject_edge.id OFFSET 0) attachment WHERE subject_edge.to_node=${alias}.id`
    : `SELECT attachment.assertion_id FROM assertion_edge_subject attachment WHERE attachment.edge_id=${alias}.id`;
  return `(${structuralClause} OR EXISTS (WITH target_assertions AS MATERIALIZED (${targetAssertions}), eligible AS (
    SELECT a.*,an.uid,v.value,s.to_node AS source,array_position(${contexts},a.context_id) AS layer
    FROM target_assertions target CROSS JOIN LATERAL (SELECT header.* FROM assertion header WHERE header.assertion_id=target.assertion_id OFFSET 0) a JOIN node an ON an.id=a.assertion_id ${attachment}
    LEFT JOIN (${values.join(' UNION ALL ')}) v ON v.assertion_id=a.assertion_id
    JOIN edge s ON s.from_node=a.assertion_id JOIN entity sk ON sk.id=s.entity_id AND sk.name='system.assertion-source'
    WHERE ${subject}=${alias}.id AND a.property='$exists' AND a.context_id=ANY(${contexts}) AND a.recorded_at<=${quote(options.recordedAt)}::timestamptz AND ${sequenceFence('a')}
  ), layers AS (SELECT eligible.*,min(layer) OVER (PARTITION BY source) AS nearest FROM eligible),
  streams AS (SELECT DISTINCT ON (source) * FROM layers WHERE layer=nearest AND valid_from<=${quote(options.validAt)}::timestamptz AND (valid_to IS NULL OR valid_to>${quote(options.validAt)}::timestamptz) ORDER BY source,recorded_sequence DESC)
  SELECT 1 FROM streams WHERE operation='assert' AND value=TRUE
    AND (NOT EXISTS (SELECT 1 FROM streams resolved WHERE resolved.operation='assert' AND resolved.uid=ANY(ARRAY[${(options.resolvedAssertionIds ?? []).map(quote).join(',')}]::uuid[]))
      OR uid=ANY(ARRAY[${(options.resolvedAssertionIds ?? []).map(quote).join(',')}]::uuid[]))))`;
}
