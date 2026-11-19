/** Typed assertion reads shared by every graph view (decision 0039, item 25). */
import type { SqlExecutor } from '../sql-driver.js';
import { withSpan } from '../obs/trace.js';
import { assertionValueTableName } from './contract.js';
export interface AssertionRow {
  readonly id: string;
  readonly subject: { readonly type: 'vertex'; readonly uid: string } | { readonly type: 'edge'; readonly id: string; readonly kind: string; readonly from: string; readonly to: string };
  readonly property: string;
  readonly context: number;
  readonly language: string | null;
  readonly source: string;
  readonly value: unknown;
  readonly operation: 'assert' | 'retract';
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly recordedAt: string;
  readonly recordedSequence: bigint;
}

export interface AssertionSqlSelector {
  readonly unitUids?: readonly string[];
  readonly sourceUids?: readonly string[];
  readonly currentStatement?: boolean;
  readonly validAt?: string;
  readonly recordedAt?: string;
  readonly contexts?: readonly number[];
  readonly contextRecordedThrough?: Readonly<Record<number, string | null>>;
  readonly projectMergedSubjects?: boolean;
  readonly resolvedAssertionIds?: readonly string[];
}

/** Item 25: pin the base, choose the nearest source layer, then recorded and valid-time order. */
export function assertionSelectionSql(raw: string, selector: AssertionSqlSelector = {}): string {
  const quote = (value: string): string => "'" + value.replaceAll("'", "''") + "'";
  for (const at of [selector.validAt, selector.recordedAt]) if (at !== undefined && !Number.isFinite(Date.parse(at))) throw new Error(`${import.meta.path}:37: invalid temporal selector ${JSON.stringify(at)}`);
  const contexts = selector.contexts ?? [1];
  if (contexts.length === 0 || contexts.some(id => !Number.isSafeInteger(id))) throw new Error(`${import.meta.path}:39: invalid context selector`);
  const currentTime = selector.currentStatement === true ? 'statement_timestamp()' : 'transaction_timestamp()';
  const valid = selector.validAt === undefined ? currentTime : `${quote(selector.validAt)}::timestamptz`;
  const recorded = selector.recordedAt === undefined ? currentTime : `${quote(selector.recordedAt)}::timestamptz`;
  const fences = Object.entries(selector.contextRecordedThrough ?? {}).filter(([,seq]) => seq !== null).map(([id,seq]) => {
    if (!Number.isSafeInteger(Number(id)) || BigInt(seq!) < 0n) throw new Error(`${import.meta.path}:44: invalid context recorded cutoff`);
    return `(r.context_id<>${Number(id)} OR r.recorded_sequence::bigint<=${BigInt(seq!)})`;
  }).join(' AND ') || 'TRUE';
  return `WITH RECURSIVE context_path AS (
    SELECT id,parent,parent_recorded_seq,0 AS layer,NULL::bigint AS cutoff FROM context WHERE id=${contexts[0]}
    UNION ALL SELECT c.id,c.parent,c.parent_recorded_seq,p.layer+1,least(p.cutoff,p.parent_recorded_seq)
    FROM context c JOIN context_path p ON c.id=p.parent
  ), raw AS MATERIALIZED (${raw}), eligible AS (
    SELECT r.request_index,r.subject_id,${selector.projectMergedSubjects ? 'r.original_subject_id' : 'r.subject_id'} AS original_subject_id,r.property,r.language,r.source,r.id,r.operation,r.valid_from,r.valid_to,r.recorded_sequence,p.layer
    FROM raw r JOIN context_path p ON p.id=r.context_id
    WHERE ${selector.unitUids === undefined ? 'TRUE' : `EXISTS(SELECT 1 FROM edge unit_edge JOIN entity unit_kind ON unit_kind.id=unit_edge.entity_id JOIN node unit_node ON unit_node.id=unit_edge.to_node WHERE unit_edge.from_node=(SELECT id FROM node WHERE uid=r.id::uuid) AND unit_kind.name='system.assertion-unit' AND unit_node.uid=ANY(ARRAY[${selector.unitUids.map(quote).join(',')}]::uuid[]))`} AND ${selector.sourceUids === undefined ? 'TRUE' : `r.source=ANY(ARRAY[${selector.sourceUids.map(quote).join(',')}]::text[])`} AND r.recorded_at<=${recorded} AND (p.cutoff IS NULL OR r.recorded_sequence::bigint<=p.cutoff) AND ${fences}
  ), layers AS (
    SELECT eligible.*,min(layer) OVER (PARTITION BY request_index,original_subject_id,property,language,source) AS nearest FROM eligible
  ), streams AS (
    SELECT DISTINCT ON (request_index,original_subject_id,property,language,source) * FROM layers
    WHERE layer=nearest AND valid_from<=${valid} AND (valid_to IS NULL OR valid_to>${valid})
    ORDER BY request_index,original_subject_id,property,language,source,recorded_sequence::bigint DESC,id COLLATE "C" DESC
  ), selected AS (
    SELECT DISTINCT ON (request_index,subject_id,property,language) * FROM streams WHERE operation='assert'
    ORDER BY request_index,subject_id,property,language,(id=ANY(ARRAY[${(selector.resolvedAssertionIds ?? []).map(quote).join(',')}]::text[])) DESC,valid_from DESC,recorded_sequence::bigint DESC,id COLLATE "C" DESC
  ) SELECT raw.*,active_stream.id IS NOT NULL AS active,selected_stream.id IS NOT NULL AS selected
    FROM raw
    LEFT JOIN streams active_stream ON active_stream.request_index=raw.request_index AND active_stream.id=raw.id AND active_stream.operation='assert'
    LEFT JOIN selected selected_stream ON selected_stream.request_index=raw.request_index AND selected_stream.id=raw.id`;
}


export interface StoredAssertion extends AssertionRow {
  readonly subjectId: number;
  readonly selected?: boolean;
  readonly active?: boolean;
  readonly originalSubjectId?:number;
  readonly originalSubjectUid?:string;
  readonly author: string;
  readonly unit: string | null;
  readonly operationUid: string;
  readonly evidence: readonly string[];
  readonly evidenceAttachments: readonly { readonly targetUid: string; readonly locator: string; readonly key: Record<string, unknown> }[];
  readonly repositoryTargets: readonly { readonly uid: string; readonly key: Record<string, unknown> }[];
}

export interface AssertionReadRequest {
  readonly sort: 'vertex' | 'edge';
  readonly kind: string;
  readonly properties: readonly string[];
  readonly repositoryKinds?: readonly string[];
  readonly unprojectedProperties?: readonly string[];
  readonly subjectIds?: readonly number[];
}

function assertionJSON(this: StoredAssertion): Omit<StoredAssertion, 'recordedSequence'> & { recordedSequence: string } {
  return { ...this, recordedSequence: this.recordedSequence.toString() };
}

/** Numeric ids are internal joins only; all exposed identities are graph uids. */
export async function loadAssertions(executor: SqlExecutor, sort: 'vertex' | 'edge', kind: string, properties: readonly string[], subjectIds?: readonly number[], selector?: AssertionSqlSelector): Promise<StoredAssertion[]> {
  return (await loadAssertionsBatch(executor, [{ sort, kind, properties, ...(subjectIds === undefined ? {} : { subjectIds }) }], selector))[0]!;
}

/** One statement reads independent typed requests without merging their field or subject boundaries. */
export async function loadAssertionsBatch(executor: SqlExecutor, requests: readonly AssertionReadRequest[], selector?: AssertionSqlSelector): Promise<StoredAssertion[][]> {
  return await withSpan('graph.assertions.read', { 'madarch.requests': requests.length }, async () => {
    const result: StoredAssertion[][] = requests.map(() => []);
    const parameters: unknown[] = [];
    const param = (value: unknown): string => { parameters.push(value); return `$${parameters.length}`; };
    const statements: string[] = [];
    for (const [requestIndex, { sort, kind, properties, subjectIds, repositoryKinds = [], unprojectedProperties = [] }] of requests.entries()) {
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
      const mapped = sort === 'vertex' && selector?.projectMergedSubjects
        ? `CASE WHEN a.property=ANY(${param(unprojectedProperties)}::text[]) THEN subject.id ELSE graph_assertion_target(subject.id,a.assertion_id,${Number(selector.contexts?.[0] ?? 1)},${selector.validAt === undefined ? 'transaction_timestamp()' : param(selector.validAt)+'::timestamptz'},${selector.recordedAt === undefined ? 'transaction_timestamp()' : param(selector.recordedAt)+'::timestamptz'}) END` : 'subject.id';
      const repositoryStatements = repositoryKinds.map(edgeKind => {
        const literal = "'" + edgeKind.replaceAll("'", "''") + "'";
        return `SELECT 0 AS request_index,e.id AS subject_id,e.id AS original_subject_id,an.uid::text AS id,a.property,a.context_id,a.language,a.operation,a.valid_from,a.valid_to,a.recorded_at,a.recorded_sequence::text,v.value,
          (SELECT lineage.to_node::text FROM edge lineage JOIN entity lk ON lk.id=lineage.entity_id WHERE lineage.from_node=a.assertion_id AND lk.name='system.assertion-source') AS source,
          target.uid::text AS target_uid,target.key AS target_key
          FROM edge e JOIN entity ek ON ek.id=e.entity_id JOIN node target ON target.id=e.to_node JOIN entity tk ON tk.id=target.entity_id
          JOIN assertion_edge_subject attachment ON attachment.edge_id=e.id JOIN assertion a ON a.assertion_id=attachment.assertion_id
          JOIN node an ON an.id=a.assertion_id LEFT JOIN "${assertionValueTableName(edgeKind, 'edge', '$exists')}" v ON v.assertion_id=a.assertion_id
          WHERE e.from_node=subject.id AND ek.name=${literal} AND tk.name='code.repository' AND a.property='$exists'`;
      });
      const repositories = repositoryStatements.length === 0 ? "'[]'::jsonb" : `(SELECT coalesce(jsonb_agg(jsonb_build_object('uid',r.target_uid,'key',r.target_key) ORDER BY r.subject_id),'[]'::jsonb) FROM (${assertionSelectionSql(repositoryStatements.join(' UNION ALL '), selector)}) r WHERE r.selected AND r.value=TRUE)`;
      const kindParameter = param(kind);
      const propertiesParameter = param(properties);
      const subjectsParameter = subjectIds === undefined ? undefined : param(subjectIds);
      statements.push(`SELECT ${requestIndex}::integer AS request_index, array_position(${propertiesParameter}::text[],assertion_rows.property) AS property_rank, assertion_rows.* FROM (
 SELECT assertion_node.uid::text AS id, subject.id AS original_subject_id, subject.uid::text AS original_subject_uid, ${mapped} AS subject_id, ${mapped === 'subject.id' ? 'subject.uid::text' : `(SELECT uid::text FROM node WHERE id=${mapped})`} AS subject_uid,
        ${sort === 'edge' ? 'edge_from.uid::text AS edge_from, edge_to.uid::text AS edge_to' : 'NULL::text AS edge_from, NULL::text AS edge_to'},
        a.property,a.context_id,a.language,a.operation,a.valid_from,a.valid_to,a.recorded_at,a.recorded_sequence::text,
        ${repositories} AS repository_targets,value_row.value,value_row.value_type,
        lineage.source,lineage.author,lineage.unit,lineage.operation_uid,lineage.evidence,lineage.evidence_attachments
        FROM assertion a JOIN node assertion_node ON assertion_node.id=a.assertion_id
        ${subjectJoin} LEFT JOIN LATERAL (${values} OFFSET 0) value_row ON TRUE
        LEFT JOIN LATERAL (
          SELECT (SELECT value FROM unnest(array_agg(target.uid::text) FILTER (WHERE k.name='system.assertion-source')) AS scalar(value)) AS source,
                 (SELECT value FROM unnest(array_agg(target.uid::text) FILTER (WHERE k.name='system.assertion-author')) AS scalar(value)) AS author,
                 (SELECT value FROM unnest(array_agg(target.uid::text ORDER BY lineage.id) FILTER (WHERE k.name='system.assertion-unit')) AS scalar(value) LIMIT 1) AS unit,
                 (SELECT value FROM unnest(array_agg(target.uid::text ORDER BY lineage.id) FILTER (WHERE k.name='system.assertion-operation')) AS scalar(value) LIMIT 1) AS operation_uid,
                 coalesce(array_agg(DISTINCT target.uid::text COLLATE "C" ORDER BY target.uid::text COLLATE "C") FILTER (WHERE k.name='system.assertion-evidence'),ARRAY[]::text[]) AS evidence,
                 coalesce(jsonb_agg(jsonb_build_object('targetUid',target.uid::text,'locator',lineage.discriminator,'key',target.key) ORDER BY target.uid,lineage.discriminator) FILTER (WHERE k.name='system.assertion-evidence'),'[]'::jsonb) AS evidence_attachments
          FROM edge lineage JOIN entity k ON k.id=lineage.entity_id JOIN node target ON target.id=lineage.to_node
          WHERE lineage.from_node=a.assertion_id
            AND k.name IN ('system.assertion-source','system.assertion-author','system.assertion-unit','system.assertion-operation','system.assertion-evidence')
        ) lineage ON TRUE
        WHERE subject_kind.name=${kindParameter} AND a.property=ANY(${propertiesParameter}::text[]) ${subjectsParameter === undefined ? '' : `AND (${mapped})=ANY(${subjectsParameter}::bigint[])`}
        ORDER BY array_position(${propertiesParameter}::text[],a.property),a.recorded_sequence) assertion_rows`);
    }
    if (statements.length === 0) return result;
    const { rows } = await executor.query<{
      request_index: number; selected?: boolean; active?: boolean;
        id: string; original_subject_id: number; original_subject_uid: string; subject_id: number; subject_uid: string; edge_from: string | null; edge_to: string | null;
        property: string; context_id: number; language: string | null; source: string; author: string;
        unit: string | null; operation_uid: string; evidence: string[]; evidence_attachments: StoredAssertion['evidenceAttachments']; repository_targets: StoredAssertion['repositoryTargets']; value: unknown; value_type:string|null;
        operation: 'assert' | 'retract'; valid_from: string | Date; valid_to: string | Date | null;
        recorded_at: string | Date; recorded_sequence: string;
    }>(`SELECT * FROM (${selector === undefined ? statements.join(' UNION ALL ') : assertionSelectionSql(statements.join(' UNION ALL '), selector)}) batches ORDER BY request_index,property_rank,recorded_sequence::bigint`, parameters);
      const text = (value: string | Date): string => value instanceof Date ? value.toISOString() : value;
      for (const row of rows) {
        const request = requests[row.request_index]!;
        const assertion = {
        id: row.id, originalSubjectId: Number(row.original_subject_id), originalSubjectUid: row.original_subject_uid, ...(row.selected === undefined ? {} : { selected: row.selected, active: row.active! }),
        subject: request.sort === 'vertex' ? { type: 'vertex', uid: row.subject_uid } : { type: 'edge', id: row.subject_uid, kind: request.kind, from: row.edge_from!, to: row.edge_to! },
        subjectId: Number(row.subject_id), property: row.property, context: Number(row.context_id), language: row.language,
        source: row.source, author: row.author, unit: row.unit, operationUid: row.operation_uid, evidence: row.evidence, evidenceAttachments: row.evidence_attachments, repositoryTargets: row.repository_targets,
        value: row.value_type === 'bigint' && typeof row.value === 'string' && Number.isSafeInteger(Number(row.value)) ? Number(row.value) : row.value_type==='timestamp with time zone'&&typeof row.value==='string' ? new Date(row.value).toISOString() : row.value instanceof Date ? row.value.toISOString() : row.value, operation: row.operation, validFrom: text(row.valid_from), validTo: row.valid_to === null ? null : text(row.valid_to),
        recordedAt: text(row.recorded_at), recordedSequence: BigInt(row.recorded_sequence),
      } satisfies StoredAssertion;
        Object.defineProperty(assertion, 'toJSON', { value: assertionJSON });
        result[row.request_index]!.push(assertion);
      }
    return result;
  });
}

/** Build the same typed SQL without executing it, for page membership in its own statement. */
export async function assertionReadSql(requests: readonly AssertionReadRequest[], selector: AssertionSqlSelector = {}): Promise<{ sql: string; parameters: readonly unknown[] }> {
  let captured: { sql: string; parameters: readonly unknown[] } | undefined;
  await loadAssertionsBatch({ query: async <Row extends object>(sql: string, parameters?: readonly unknown[]) => { captured = { sql, parameters: parameters ?? [] }; return { rows: [] as Row[] }; } }, requests, selector);
  if (captured === undefined) throw new Error(`${import.meta.path}:201: assertion SQL requires at least one property`);
  return captured;
}

/** Active source existence, never historical identity presence (0039 items 25, 26 and 30).
 * Structural assertion lineage is attached to immutable headers, not recursively asserted.
 */
export function activeExistenceSql(sort: 'vertex' | 'edge', alias: string, kinds: readonly string[], options: { readonly validAt: string; readonly recordedAt: string; readonly contexts: readonly number[]; readonly contextRecordedThrough?: Readonly<Record<number, string | null>>; readonly resolvedAssertionIds?: readonly string[]; readonly projectMergedSubjects?: boolean }, structural: readonly string[] = []): string {
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
  const originalSubject = sort === 'vertex' ? 'subject.to_node' : 'av.edge_id';
  const subject = sort === 'vertex' && options.projectMergedSubjects
    ? `graph_assertion_target(subject.to_node,a.assertion_id,${options.contexts[0]},${quote(options.validAt)}::timestamptz,${quote(options.recordedAt)}::timestamptz)` : originalSubject;
  const targetAssertions = sort === 'vertex'
    ? `SELECT attachment.assertion_id FROM edge subject_edge CROSS JOIN LATERAL (SELECT s.assertion_id FROM assertion_vertex_subject s WHERE s.subject_edge_id=subject_edge.id OFFSET 0) attachment WHERE ${options.projectMergedSubjects ? 'TRUE' : `subject_edge.to_node=${alias}.id`}`
    : `SELECT attachment.assertion_id FROM assertion_edge_subject attachment WHERE attachment.edge_id=${alias}.id`;
  return `(${structuralClause} OR EXISTS (WITH target_assertions AS MATERIALIZED (${targetAssertions}), eligible AS (
    SELECT a.*,an.uid,v.value,s.to_node AS source,${originalSubject} AS original_subject,array_position(${contexts},a.context_id) AS layer
    FROM target_assertions target CROSS JOIN LATERAL (SELECT header.* FROM assertion header WHERE header.assertion_id=target.assertion_id OFFSET 0) a JOIN node an ON an.id=a.assertion_id ${attachment}
    LEFT JOIN (${values.join(' UNION ALL ')}) v ON v.assertion_id=a.assertion_id
    JOIN edge s ON s.from_node=a.assertion_id JOIN entity sk ON sk.id=s.entity_id AND sk.name='system.assertion-source'
    WHERE ${subject}=${alias}.id AND a.property='$exists' AND a.context_id=ANY(${contexts}) AND a.recorded_at<=${quote(options.recordedAt)}::timestamptz AND ${sequenceFence('a')}
  ), layers AS (SELECT eligible.*,min(layer) OVER (PARTITION BY original_subject,source) AS nearest FROM eligible),
  streams AS (SELECT DISTINCT ON (original_subject,source) * FROM layers WHERE layer=nearest AND valid_from<=${quote(options.validAt)}::timestamptz AND (valid_to IS NULL OR valid_to>${quote(options.validAt)}::timestamptz) ORDER BY original_subject,source,recorded_sequence DESC)
  SELECT 1 FROM (SELECT DISTINCT ON (language) * FROM streams WHERE operation='assert'
    ORDER BY language,(uid=ANY(ARRAY[${(options.resolvedAssertionIds ?? []).map(quote).join(',')}]::uuid[])) DESC,valid_from DESC,recorded_sequence DESC,uid::text COLLATE "C" DESC) selected WHERE value=TRUE))`;
}
