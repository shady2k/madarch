import { expect, test } from 'bun:test';
import { assertionReadSql, assertionSelectionSql, type AssertionSqlSelector } from '../src/graph/assertion-read.js';
import { generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { pinContext } from '../src/graph/context.js';
import { bindWriteCapability, bootstrapWriteIdentity, publishGraphDrafts, writeAssertion } from '../src/graph/write.js';
import type { SqlExecutor } from '../src/sql-driver.js';
import { createTestDatabaseOwner } from './test-database.js';
import { bindTestWriteCapability, TEST_SOURCE_UID } from './write-capability-fixture.js';

// Frozen before the production rewrite. Keep the SQL and parameter binding independent.
function legacySelectionSql(raw: string, selector: AssertionSqlSelector = {}, parameter?: (value: unknown) => string): string {
  const quote = (value: string): string => "'" + value.replaceAll("'", "''") + "'";
  for (const at of [selector.validAt, selector.recordedAt]) if (at !== undefined && !Number.isFinite(Date.parse(at))) throw new Error(`${import.meta.path}:37: invalid temporal selector ${JSON.stringify(at)}`);
  const contexts = selector.contexts ?? [1];
  if (contexts.length === 0 || contexts.some(id => !Number.isSafeInteger(id))) throw new Error(`${import.meta.path}:39: invalid context selector`);
  const bind = parameter ?? ((value: unknown) => typeof value === 'number' ? String(value) : quote(String(value)));
  const array = (values: readonly unknown[], type: string): string => parameter ? `${parameter(values)}::${type}[]` : `ARRAY[${values.map(value => quote(String(value))).join(',')}]::${type}[]`;
  const currentTime = selector.currentStatement === true ? 'statement_timestamp()' : 'transaction_timestamp()';
  const valid = selector.validAt === undefined ? currentTime : `${bind(selector.validAt)}::timestamptz`;
  const recorded = selector.recordedAt === undefined ? currentTime : `${bind(selector.recordedAt)}::timestamptz`;
  const cutoffs = Object.entries(selector.contextRecordedThrough ?? {}).filter(([,seq]) => seq !== null).map(([id,seq]) => {
    if (!Number.isSafeInteger(Number(id)) || BigInt(seq!) < 0n) throw new Error(`${import.meta.path}:44: invalid context recorded cutoff`);
    return { context: Number(id), sequence: BigInt(seq!).toString() };
  });
  const fences = parameter
    ? `NOT EXISTS(SELECT 1 FROM jsonb_to_recordset(${parameter(JSON.stringify(cutoffs))}::jsonb) fence(context bigint,sequence bigint) WHERE fence.context=r.context_id AND r.recorded_sequence::bigint>fence.sequence)`
    : cutoffs.map(fence => `(r.context_id<>${fence.context} OR r.recorded_sequence::bigint<=${fence.sequence})`).join(' AND ') || 'TRUE';
  return `WITH RECURSIVE context_path AS (
    SELECT id,parent,parent_recorded_seq,0 AS layer,NULL::bigint AS cutoff FROM context WHERE id=${bind(contexts[0])}
    UNION ALL SELECT c.id,c.parent,c.parent_recorded_seq,p.layer+1,least(p.cutoff,p.parent_recorded_seq)
    FROM context c JOIN context_path p ON c.id=p.parent
  ), raw AS MATERIALIZED (${raw}), eligible AS (
    SELECT r.request_index,r.subject_id,${selector.projectMergedSubjects ? 'r.original_subject_id' : 'r.subject_id'} AS original_subject_id,r.property,r.language,r.source,r.id,r.operation,r.valid_from,r.valid_to,r.recorded_sequence,p.layer
    FROM raw r JOIN context_path p ON p.id=r.context_id
    WHERE ${selector.unitUids === undefined ? 'TRUE' : `EXISTS(SELECT 1 FROM edge unit_edge JOIN entity unit_kind ON unit_kind.id=unit_edge.entity_id JOIN node unit_node ON unit_node.id=unit_edge.to_node WHERE unit_edge.from_node=(SELECT id FROM node WHERE uid=r.id::uuid) AND unit_kind.name='system.assertion-unit' AND unit_node.uid=ANY(${array(selector.unitUids,'uuid')}))`} AND ${selector.sourceUids === undefined ? 'TRUE' : `r.source=ANY(${array(selector.sourceUids,'text')})`} AND r.recorded_at<=${recorded} AND (p.cutoff IS NULL OR r.recorded_sequence::bigint<=p.cutoff) AND ${fences}
  ), layers AS (
    SELECT eligible.*,min(layer) OVER (PARTITION BY request_index,original_subject_id,property,language,source) AS nearest FROM eligible
  ), streams AS (
    SELECT DISTINCT ON (request_index,original_subject_id,property,language,source) * FROM layers
    WHERE layer=nearest AND valid_from<=${valid} AND (valid_to IS NULL OR valid_to>${valid})
    ORDER BY request_index,original_subject_id,property,language,source,recorded_sequence::bigint DESC,id COLLATE "C" DESC
  ), selected AS (
    SELECT DISTINCT ON (request_index,subject_id,property,language) * FROM streams WHERE operation='assert'
    ORDER BY request_index,subject_id,property,language,(id=ANY(${array(selector.resolvedAssertionIds ?? [],'text')})) DESC,valid_from DESC,recorded_sequence::bigint DESC,id COLLATE "C" DESC
  ) SELECT raw.*,active_stream.id IS NOT NULL AS active,selected_stream.id IS NOT NULL AS selected${selector.diagnostics ? `,
      EXISTS(SELECT 1 FROM context_path p WHERE p.id=raw.context_id) AS diagnostic_context,
      raw.recorded_at<=${recorded} AS diagnostic_recorded,
      raw.valid_from<=${valid} AND (raw.valid_to IS NULL OR raw.valid_to>${valid}) AS diagnostic_valid,
      raw.valid_from>${valid} AS diagnostic_valid_before,
      raw.valid_to IS NOT NULL AND raw.valid_to<=${valid} AS diagnostic_valid_after,
      EXISTS(SELECT 1 FROM eligible e WHERE e.request_index=raw.request_index AND e.id=raw.id) AS diagnostic_eligible,
      EXISTS(SELECT 1 FROM streams s WHERE s.request_index=raw.request_index AND s.id=raw.id) AS diagnostic_stream` : ''}
    FROM raw
    LEFT JOIN streams active_stream ON active_stream.request_index=raw.request_index AND active_stream.id=raw.id AND active_stream.operation='assert'
    LEFT JOIN selected selected_stream ON selected_stream.request_index=raw.request_index AND selected_stream.id=raw.id`;
}

const at = '2030-01-01T00:00:00Z';
const selectors: readonly AssertionSqlSelector[] = [
  {}, { diagnostics: true }, { currentStatement: true },
  { validAt: '2019-01-01', recordedAt: at, diagnostics: true },
  { validAt: '2020-01-01', recordedAt: at },
  { validAt: '2023-01-01', recordedAt: at },
  { validAt: at, recordedAt: '2019-01-01', diagnostics: true },
  { validAt: at, recordedAt: '2022-01-01', diagnostics: true },
  { validAt: at, recordedAt: at, resolvedAssertionIds: ['a', 'é'] },
  { validAt: at, recordedAt: at, sourceUids: ['first'] },
  { validAt: at, recordedAt: at, sourceUids: [] },
];

async function bytes(tx: SqlExecutor, sql: string, parameters: readonly unknown[] = [], deduplicate = false): Promise<string[]> {
  const result = await tx.query<{ bytes: string }>(`SELECT bytes FROM (SELECT ${deduplicate ? 'DISTINCT' : ''} to_jsonb(result)::text AS bytes,ARRAY(SELECT value FROM jsonb_each_text(to_jsonb(result)) ORDER BY key COLLATE "C") AS keys FROM (${sql}) result) ordered ORDER BY keys COLLATE "C",bytes COLLATE "C"`, parameters);
  return result.rows.map(row => row.bytes);
}

async function compareRaw(tx: SqlExecutor, raw: string, selector: AssertionSqlSelector, repeated = false): Promise<void> {
  const parameters: unknown[] = [];
  const parameter = (value: unknown): string => { parameters.push(value); return `$${parameters.length}`; };
  const current = assertionSelectionSql(raw, selector, parameter);
  const legacyParameters: unknown[] = [];
  const legacy = legacySelectionSql(raw, selector, value => { legacyParameters.push(value); return `$${legacyParameters.length}`; });
  // The old joins multiply repeated keys. Their distinct full rows define the flags,
  // while the new query must return precisely one result per input row.
  expect(await bytes(tx, current, parameters, repeated)).toEqual(await bytes(tx, legacy, legacyParameters, repeated));
  const counts = await tx.query<{ count: string }>(`SELECT count(*)::text AS count FROM (${current}) result`, parameters);
  const rawCount = await tx.query<{ count: string }>(`SELECT count(*)::text AS count FROM (${raw}) result`);
  if (!repeated || current !== legacy) expect(counts.rows[0]!.count).toBe(rawCount.rows[0]!.count);
}

// SQL emitted here has standard quoted strings/identifiers and balanced parentheses.
function closing(sql: string, open: number): number {
  let depth = 0;
  let quote = '';
  for (let i = open; i < sql.length; i++) {
    const char = sql[i]!;
    if (quote) {
      if (char === quote) { if (sql[i + 1] === quote) i++; else quote = ''; }
    } else if (char === "'" || char === '"') quote = char;
    else if (char === '(') depth++;
    else if (char === ')' && --depth === 0) return i;
  }
  throw new Error(`${import.meta.path}:112: unbalanced captured assertion SQL`);
}

function legacyCaptured(sql: string, selector: AssertionSqlSelector, parameters: readonly unknown[]): string {
  const marker = 'WITH RECURSIVE context_path AS (';
  const start = sql.indexOf(marker);
  if (start === -1) return sql;
  const open = sql.lastIndexOf('(', start);
  const end = closing(sql, open);
  const rawMarker = 'raw AS MATERIALIZED (';
  const rawOpen = sql.indexOf(rawMarker, start) + rawMarker.length - 1;
  const rawEnd = closing(sql, rawOpen);
  const raw = legacyCaptured(sql.slice(rawOpen + 1, rawEnd), selector, parameters);
  const bind = (value: unknown): string => {
    const index = parameters.findIndex(held => JSON.stringify(held) === JSON.stringify(value));
    if (index < 0) throw new Error(`${import.meta.path}:127: legacy selector binding not captured: ${JSON.stringify(value)}`);
    return `$${index + 1}`;
  };
  return sql.slice(0, start) + legacySelectionSql(raw, selector, bind) + legacyCaptured(sql.slice(end), selector, parameters);
}

const contract: GraphContract = {
  vertex: ['sample', 'code.repository'].map(name => ({ name, table: generatedTableName(name, 'vertex'), key: ['name'], fields: [{ name: 'name', type: 'text' as const }, { name: 'note', type: 'text' as const, nullable: true }], capability: 'fixture' })),
  edge: [{ name: 'sample-repository', from: ['sample'], to: ['code.repository'], repeats: false, cardinality: { from: 'many', to: 'many' }, labels: { en: { out: 'repository', in: 'sample' }, ru: { out: 'repository', in: 'sample' } }, fields: [], capability: 'fixture' }],
  dictionary: [],
};

test('selection matches frozen full rows across layers, sources, intervals, resolutions and repeated requests', async () => {
  const owner = await createTestDatabaseOwner({ authenticated: false });
  try {
    await owner.transaction('write', async tx => {
      for (let i = 0; i < 5; i++) await tx.query('SELECT graph_next_recorded_sequence()');
      const branch = Number(await pinContext(tx, '1', 'equivalence-branch'));
      for (let i = 0; i < 2; i++) await tx.query('SELECT graph_next_recorded_sequence()');
      const child = Number(await pinContext(tx, String(branch), 'equivalence-child'));
      const cutoffs = await tx.query<{ id: number; parent_recorded_seq: string }>('SELECT id,parent_recorded_seq::text FROM context WHERE id=ANY($1::bigint[])', [[branch, child]]);
      const rows = [
        [0, 1, 1, 'a', 'note', null, 'first', 'assert', 1, '2020-01-01', null, '2020-01-01', '1'],
        [0, 1, 1, 'z', 'note', null, 'first', 'assert', 1, '2020-01-01', null, '2021-01-01', '2'],
        [0, 1, 1, 'é', 'note', null, 'second', 'assert', 1, '2020-01-01', null, '2021-01-01', '2'],
        [0, 1, 1, 'retract', 'note', null, 'second', 'retract', 1, '2022-01-01', null, '2022-01-01', '3'],
        [0, 1, 1, 'expired', 'note', 'en', 'first', 'assert', 1, '2020-01-01', '2023-01-01', '2020-01-01', '4'],
        [0, 1, 1, 'future', 'note', 'en', 'first', 'assert', 1, '2040-01-01', null, '2020-01-01', '5'],
        [0, 1, 1, 'branch', 'note', null, 'first', 'assert', branch, '2020-01-01', null, '2020-01-01', '6'],
        [0, 1, 1, 'child', 'note', null, 'first', 'assert', child, '2020-01-01', null, '2020-01-01', '7'],
        [0, 1, 1, 'outside', '$exists', null, 'first', 'assert', 999999, '2020-01-01', null, '2020-01-01', '8'],
        [0, 1, 2, 'merged', 'note', null, 'first', 'assert', 1, '2020-01-01', null, '2020-01-01', '9'],
      ];
      const raw = (input: unknown[][]) => `SELECT request_index,subject_id,original_subject_id,id,property,language,source,operation,context_id,valid_from::timestamptz,valid_to::timestamptz,recorded_at::timestamptz,recorded_sequence::bigint FROM jsonb_to_recordset('${JSON.stringify(input.map(row => Object.fromEntries(['request_index','subject_id','original_subject_id','id','property','language','source','operation','context_id','valid_from','valid_to','recorded_at','recorded_sequence'].map((key, i) => [key, row[i]])))).replaceAll("'", "''")}') AS r(request_index integer,subject_id bigint,original_subject_id bigint,id text,property text,language text,source text,operation text,context_id bigint,valid_from text,valid_to text,recorded_at text,recorded_sequence text)`;
      const requests = [...rows, ...rows.map(row => [1, ...row.slice(1)])];
      for (const selector of [...selectors, ...[branch, child].flatMap(context => [
        { contexts: [context], validAt: at, recordedAt: at, diagnostics: true },
        { contexts: [context], validAt: at, recordedAt: at, contextRecordedThrough: { 1: '1', [branch]: '0', [child]: null } },
      ]), { validAt: at, recordedAt: at, contexts: [999999], diagnostics: true }]) {
        for (const projectMergedSubjects of [false, true]) await compareRaw(tx, raw(requests), { ...selector, projectMergedSubjects });
      }
      expect(cutoffs.rows.map(row => [Number(row.id), row.parent_recorded_seq])).toEqual([[branch, '6'], [child, '9']]);
      const branchResult = await tx.query<{ id: string; selected: boolean }>(assertionSelectionSql(raw(rows), { contexts: [branch], validAt: at, recordedAt: at }));
      expect(branchResult.rows.filter(row => row.selected).map(row => row.id)).toEqual(['branch']);
      const inherited = await tx.query<{ id: string; selected: boolean }>(assertionSelectionSql(raw(rows), { contexts: [child], contextRecordedThrough: { [child]: '0', [branch]: '0' }, validAt: '2021-01-01', recordedAt: at }));
      expect(inherited.rows.filter(row => row.selected).map(row => row.id).sort()).toEqual(['expired', 'é']);
      // Repeated raw keys retain both physical rows but agree with legacy deduplicated flags.
      await compareRaw(tx, raw([rows[0]!, rows[0]!, ...rows.slice(1)]), { diagnostics: true, validAt: at, recordedAt: at }, true);
      await compareRaw(tx, raw([rows[0]!, [0, 2, 2, 'a', 'other', 'fr', 'second', 'assert', 1, '2020-01-01', null, '2020-01-01', '1'], ...rows.slice(1)]), { diagnostics: true, projectMergedSubjects: true, validAt: at, recordedAt: at }, true);
    });
  } finally { await owner.close(); }
}, 30_000);


test('published merge, unit/source replay, repository selection and overlapping requests match frozen bytes', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract, authenticated: false });
  const unitUids = ['019a0000-0000-7000-8000-000000000011', '019a0000-0000-7000-8000-000000000012'];
  const secondSource = '019a0000-0000-7000-8000-000000000003';
  try {
    await owner.transaction('write', async tx => {
      const binding = await bindTestWriteCapability(tx, contract);
      for (const unit of unitUids) await bootstrapWriteIdentity(tx, 'system.unit', unit, binding.productUid);
      bindWriteCapability(tx, { ...binding, unitUid: unitUids[0]! });
      await publishGraphDrafts(tx, contract, {
        vertices: [
          ...['one', 'two'].map(name => ({ kind: 'sample', key: { name }, values: { note: name }, validFrom: '2020-01-01', producer: 'fixture', producerVersion: '1' })),
          { kind: 'code.repository', key: { name: 'example' }, values: { note: 'repository' }, validFrom: '2020-01-01', producer: 'fixture', producerVersion: '1' },
        ],
        edges: ['one', 'two'].map(name => ({ kind: 'sample-repository', from: { kind: 'sample', key: { name } }, to: { kind: 'code.repository', key: { name: 'example' } }, validFrom: '2020-01-01', producer: 'fixture', producerVersion: '1' })),
        removals: [],
      });
      const members = (await tx.query<{ id: number; uid: string }>("SELECT n.id,n.uid::text FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='sample' ORDER BY n.id")).rows;
      const newer = await bindTestWriteCapability(tx, contract, secondSource);
      bindWriteCapability(tx, { ...newer, unitUid: unitUids[1]! });
      await writeAssertion(tx, contract, { sort: 'vertex', kind: 'sample', subjectId: String(members[0]!.id), property: 'note', value: 'other source', operation: 'assert', validFrom: '2021-01-01' });
      const { createHash } = await import('node:crypto');
      const digest = createHash('sha256').update('Evidence').digest('hex');
      const support = { kind: 'system.content-snapshot', key: { digest } };
      await publishGraphDrafts(tx, contract, { vertices: [{ ...support, values: { content: 'Evidence' }, producer: 'fixture', producerVersion: '1' }], removals: [] });
      const merge = { kind: 'system.merge', key: {}, uid: crypto.randomUUID() };
      await publishGraphDrafts(tx, contract, {
        vertices: [{ ...merge, values: { state: 'ACTIVE', reason: 'Same entity checked' }, evidence: [{ target: support }], producer: 'fixture', producerVersion: '1' }],
        edges: [
          ...members.map(member => ({ kind: 'system.merge-member', from: merge, to: { kind: 'sample', key: {}, uid: member.uid }, discriminator: member.uid, producer: 'fixture', producerVersion: '1' })),
          { kind: 'system.merge-survivor', from: merge, to: { kind: 'sample', key: {}, uid: members[0]!.uid }, discriminator: members[0]!.uid, producer: 'fixture', producerVersion: '1' },
        ], removals: [],
      });
    });
    await owner.transaction('snapshot', async tx => {
      const ids = (await tx.query<{ id: number }>("SELECT n.id FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='sample' ORDER BY n.id")).rows.map(row => Number(row.id));
      const assertionIds = (await tx.query<{ uid: string }>("SELECT n.uid::text FROM node n JOIN assertion a ON a.assertion_id=n.id WHERE a.property='note' ORDER BY n.uid::text COLLATE \"C\"")).rows.map(row => row.uid);
      const requests = [
        { sort: 'vertex' as const, kind: 'sample', properties: ['$exists', 'name', 'note'], repositoryKinds: ['sample-repository'] },
        { sort: 'vertex' as const, kind: 'sample', properties: ['note'], subjectIds: ids, repositoryKinds: ['sample-repository'] },
        { sort: 'vertex' as const, kind: 'sample', properties: ['note'], subjectIds: [ids[0]!], unprojectedProperties: ['name'] },
        { sort: 'edge' as const, kind: 'sample-repository', properties: ['$exists'] },
      ];
      expect(ids).toHaveLength(2);
      expect(assertionIds.length).toBeGreaterThan(2);
      for (const selector of [
        {}, { diagnostics: true }, { sourceUids: [TEST_SOURCE_UID] }, { sourceUids: [secondSource] }, { sourceUids: [] },
        { unitUids: [unitUids[0]!] }, { unitUids }, { unitUids: [] },
        { resolvedAssertionIds: assertionIds.slice(0, 1), diagnostics: true },
        { contextRecordedThrough: { 1: '0' }, diagnostics: true },
      ] satisfies AssertionSqlSelector[]) {
        for (const projectMergedSubjects of [false, true]) {
          const options = { ...selector, projectMergedSubjects };
          const captured = await assertionReadSql(requests, options);
          const oldSql = legacyCaptured(captured.sql, options, captured.parameters);
          const literal = (value: unknown): string => Array.isArray(value) ? `ARRAY[${value.map(literal).join(',')}]` : value === null ? 'NULL' : typeof value === 'number' ? String(value) : "'" + String(value).replaceAll("'", "''") + "'";
          const inline = (sql: string): string => sql.replace(/\$(\d+)/g, (_, index: string) => literal(captured.parameters[Number(index) - 1]));
          const actual = await bytes(tx, captured.sql, captured.parameters);
          expect(actual).toEqual(await bytes(tx, inline(oldSql)));
          expect(actual.length).toBeGreaterThan(0);
          if (projectMergedSubjects && Object.keys(selector).length === 0) {
            const result = await tx.query<{ subject_id: number; original_subject_id: number; repository_targets: unknown[] }>(captured.sql, captured.parameters);
            expect(result.rows.some(row => Number(row.subject_id) !== Number(row.original_subject_id))).toBe(true);
            expect(result.rows.some(row => row.repository_targets.length > 0)).toBe(true);
          }
        }
      }
    });
  } finally { await owner.close(); }
}, 60_000);
