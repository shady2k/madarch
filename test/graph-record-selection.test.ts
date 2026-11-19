import { afterEach, expect, test } from 'bun:test';
import { createTestDatabaseOwner, type TestDatabaseOwner } from './test-database.js';
const owners: TestDatabaseOwner[] = [];
afterEach(async () => { for (const owner of owners.splice(0)) await owner.close(); });
import { readKindAssertions } from '../src/graph/records.js';
import { generatedTableName, type GraphContract } from '../src/graph/contract.js';
import type { SqlExecutor } from '../src/sql-driver.js';

const contract: GraphContract = {
  vertex: [{ name: 'fixture', table: generatedTableName('fixture', 'vertex'), key: ['name'], capability: 'fixture', fields: [{ name: 'name', type: 'text' }, { name: 'amount', type: 'integer' }, { name: 'flag', type: 'boolean' }] }],
  edge: [{ name: 'fixture', from: ['fixture'], to: ['fixture'], repeats: true, discriminator: 'role', cardinality: { from: 'many', to: 'many' }, labels: { en: { out: 'links', in: 'linked by' }, ru: { out: 'links', in: 'linked by' } }, fields: [{ name: 'amount', type: 'integer' }], capability: 'fixture' }],
  dictionary: [],
};

const now = '2026-11-15T12:00:00.000Z';
async function executor(values: readonly { property: string; value: unknown; operation?: string; validFrom?: string; source?: string; context?: number; recordedAt?: string; subjectId?: number }[]): Promise<SqlExecutor> {
  const owner = await createTestDatabaseOwner({ authenticated: false });
  owners.push(owner);
  return { async query<Row extends Record<string, unknown>>(sql: string, parameters?: readonly unknown[]) {
    let rows: Record<string, unknown>[];
    if (sql.includes("AS present")) rows = [{ present: false }];
    else if (sql.includes('WITH anchors AS')) rows = [];
    else if (sql.includes('FROM assertion a')) rows = values.filter(value => (parameters?.[1] as readonly string[]).includes(value.property)).map((value, index) => ({
      request_index: 0, property_rank: (parameters?.[1] as readonly string[]).indexOf(value.property), id: `assertion-${value.property}-${index}`, subject_id: value.subjectId ?? 1, subject_uid: value.subjectId === 2 ? 'other' : 'subject', edge_from: 'from-uid', edge_to: 'to-uid',
      property: value.property, context_id: value.context ?? 1, language: null, source: value.source ?? 'source', author: 'author',
      unit: null, operation_uid: 'operation', evidence: [], value: value.value, operation: value.operation ?? 'assert',
      valid_from: value.validFrom ?? '2026-11-14T00:00:00.000Z', valid_to: null,
      recorded_at: value.recordedAt ?? '2026-11-14T00:00:00.000Z', recorded_sequence: String(index + 1),
    }));
    else if (sql === 'SELECT transaction_timestamp() AS now') rows = [{ now }];
    else if (sql.includes('FROM node n')) rows = [{ request_index: 0, id: 1, uid: 'subject', key: { name: 'fixture' }, read_at: now }, ...(values.some(value => value.subjectId === 2) ? [{ request_index: 0, id: 2, uid: 'other', key: { name: 'other' }, read_at: now }] : [])];
    else if (sql.includes('FROM edge n')) rows = [{ request_index: 0, id: 1, uid: 'subject', key: {}, from_node: 4, to_node: 5, discriminator: 'role', read_at: now }];
    else throw new Error(`Unexpected query: ${sql}`);
    if (sql.includes('FROM assertion a')) {
      const raw = `SELECT * FROM jsonb_to_recordset($1::jsonb) AS fixture(request_index integer, property_rank integer, id text, subject_id bigint, original_subject_id bigint, subject_uid text, edge_from text, edge_to text, property text, context_id bigint, language text, source text, author text, unit text, operation_uid text, evidence jsonb, value jsonb, operation text, valid_from timestamptz, valid_to timestamptz, recorded_at timestamptz, recorded_sequence text)`;
      const start = sql.indexOf('raw AS MATERIALIZED (') + 'raw AS MATERIALIZED ('.length;
      const end = sql.indexOf('), eligible AS (', start);
      const selectedSql = sql.slice(0, start) + raw + sql.slice(end);
      return await owner.run(tx => tx.query<Row>(selectedSql.replaceAll('transaction_timestamp()', `'${now}'::timestamptz`), [JSON.stringify(rows)]));
    }
    return { rows: rows as Row[] };
  } };
}

test('0039.25: existence is selected from assertions, not retained identity', async () => {
  const present = await readKindAssertions(await executor([{ property: '$exists', value: true }]), 'vertex', 'fixture', [], { contract });
  expect(present).toHaveLength(1);
  expect(present[0]?.activeSources).toEqual(['source']);
  expect(await readKindAssertions(await executor([{ property: '$exists', value: false }]), 'vertex', 'fixture', [], { contract })).toEqual([]);
  expect(await readKindAssertions(await executor([{ property: '$exists', value: true, operation: 'retract' }]), 'vertex', 'fixture', [], { contract })).toEqual([]);
  expect(await readKindAssertions(await executor([{ property: '$exists', value: true, validFrom: '2026-11-16T00:00:00.000Z' }]), 'vertex', 'fixture', [], { contract })).toEqual([]);
});

test('0039.25: missing generated typed storage refuses instead of returning a smaller graph', async () => {
  const broken: SqlExecutor = { async query() { throw new Error('missing typed assertion table'); } };
  await expect(readKindAssertions(broken, 'vertex', 'fixture', ['amount'], { contract })).rejects.toThrow('missing typed assertion table');
});

test('0039.30: valid time selector is shared with existence and values', async () => {
  const tx = await executor([{ property: '$exists', value: true }, { property: 'amount', value: 4, validFrom: '2026-11-16T00:00:00.000Z' }]);
  expect((await readKindAssertions(tx, 'vertex', 'fixture', ['amount'], { contract }))[0]?.values['amount']).toBeUndefined();
  expect((await readKindAssertions(tx, 'vertex', 'fixture', ['amount'], { contract, validAt: '2026-11-17T00:00:00.000Z' }))[0]?.values['amount']).toBe(4);
});

test('0039.30: edge identities, selected evidence, source streams and cutoffs are retained exactly', async () => {
  const tx = await executor([
    { property: '$exists', value: true, source: 'first' },
    { property: '$exists', value: true, source: 'second' },
    { property: '$exists', value: null, operation: 'retract', source: 'second' },
    { property: 'amount', value: 1 },
    { property: 'amount', value: 2, recordedAt: '2026-11-16T00:00:00.000Z' },
  ]);
  const [edge] = await readKindAssertions(tx, 'edge', 'fixture', ['amount', 'amount'], { contract });
  expect(edge).toMatchObject({ id: 1, uid: 'subject', key: {}, from: 4, to: 5, discriminator: 'role', values: { '$exists': true, amount: 1 }, activeSources: ['first'] });
  expect(edge?.assertions).toHaveLength(5);
  expect(edge?.selectedAssertions.map(assertion => [assertion.property, assertion.value])).toEqual([['$exists', true], ['amount', 1]]);
  expect((await readKindAssertions(tx, 'edge', 'fixture', ['amount'], { contract, recordedAt: '2026-11-17T00:00:00.000Z' }))[0]?.values['amount']).toBe(2);
  expect(await readKindAssertions(tx, 'edge', 'fixture', [], { contract, contexts: [2] })).toEqual([]);
});

test('0039.25: reconciliation retains only true existence sources of the exact subject', async () => {
  const rows = await readKindAssertions(await executor([
    { property: '$exists', value: false, source: 'denier' },
    { property: '$exists', value: true, source: 'holder' },
    { property: '$exists', value: true, source: 'foreign', subjectId: 2 },
    { property: 'flag', value: true, source: 'field-only' },
  ]), 'vertex', 'fixture', ['flag'], { contract });
  expect(rows.map(row => [row.uid, row.activeSources])).toEqual([['subject', ['holder']], ['other', ['foreign']]]);
  expect(Object.keys(rows[0]!)).not.toContain('from');
  expect(Object.keys(rows[0]!)).not.toContain('to');
  expect(Object.keys(rows[0]!)).not.toContain('discriminator');
});

test('0039.30: subject UID bounds apply before assertion loading and preserve context cutoffs', async () => {
  const calls: { sql: string; parameters?: readonly unknown[] }[] = [];
  const base = await executor([{ property: '$exists', value: true }, { property: 'amount', value: 1 }, { property: 'amount', value: 2, recordedAt: '2026-11-16T00:00:00.000Z' }]);
  const tx: SqlExecutor = { async query(sql, parameters) { calls.push({ sql, ...(parameters === undefined ? {} : { parameters }) }); return await base.query(sql, parameters); } };
  const rows = await readKindAssertions(tx, 'vertex', 'fixture', ['amount'], { contract, subjectUids: ['subject'], recordedAt: '2026-11-17T00:00:00.000Z', contextRecordedThrough: { 1: '2' } });
  const identity = calls.find(call => call.sql.includes('n.uid=ANY($2::uuid[])'));
  expect(identity).toBeDefined();
  expect(identity?.parameters).toEqual(['fixture', ['subject']]);
  expect(calls.filter(call => call.sql.includes('FROM assertion a')).every(call => call.parameters?.some(parameter => Array.isArray(parameter) && parameter.length === 1 && parameter[0] === 1))).toBe(true);
  expect(rows[0]?.values['amount']).toBe(1);
  calls.length = 0;
  expect(await readKindAssertions(tx, 'vertex', 'fixture', ['amount'], { contract, subjectUids: [] })).toEqual([]);
  expect(calls.some(call => call.sql.includes('FROM assertion a'))).toBe(false);
});

test('0039.25: the effective false existence beats an older true candidate from another source', async () => {
  const tx = await executor([
    { property: '$exists', value: true, source: 'holder' },
    { property: '$exists', value: false, source: 'denier', validFrom: '2026-11-15T00:00:00.000Z' },
  ]);
  expect(await readKindAssertions(tx, 'vertex', 'fixture', [], { contract })).toEqual([]);
});
