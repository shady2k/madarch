import { expect, test } from 'bun:test';
import { readKindAssertions } from '../src/graph/records.js';
import type { SqlExecutor } from '../src/sql-driver.js';

const now = '2026-11-15T12:00:00.000Z';
function executor(values: readonly { property: string; value: unknown; operation?: string; validFrom?: string; source?: string; context?: number; recordedAt?: string; subjectId?: number }[]): SqlExecutor {
  return { async query<Row extends Record<string, unknown>>(sql: string, parameters?: readonly unknown[]) {
    let rows: Record<string, unknown>[];
    if (sql.includes('FROM assertion a')) rows = values.filter(value => (parameters?.[1] as readonly string[]).includes(value.property)).map((value, index) => ({
      id: `assertion-${value.property}-${index}`, subject_id: value.subjectId ?? 1, subject_uid: value.subjectId === 2 ? 'other' : 'subject', edge_from: 'from-uid', edge_to: 'to-uid',
      property: value.property, context_id: value.context ?? 1, language: null, source: value.source ?? 'source', author: 'author',
      unit: null, operation_uid: 'operation', evidence: [], value: value.value, operation: value.operation ?? 'assert',
      valid_from: value.validFrom ?? '2026-11-14T00:00:00.000Z', valid_to: null,
      recorded_at: value.recordedAt ?? '2026-11-14T00:00:00.000Z', recorded_sequence: String(index + 1),
    }));
    else if (sql.includes('transaction_timestamp()')) rows = [{ now }];
    else if (sql.includes('FROM node n')) rows = [{ id: 1, uid: 'subject', key: { name: 'fixture' } }, ...(values.some(value => value.subjectId === 2) ? [{ id: 2, uid: 'other', key: { name: 'other' } }] : [])];
    else if (sql.includes('FROM edge n')) rows = [{ id: 1, uid: 'subject', key: {}, from_node: 4, to_node: 5, discriminator: 'role' }];
    else throw new Error(`Unexpected query: ${sql}`);
    return { rows: rows as Row[] };
  } };
}

test('0039.25: existence is selected from assertions, not retained identity', async () => {
  const present = await readKindAssertions(executor([{ property: '$exists', value: true }]), 'vertex', 'fixture', []);
  expect(present).toHaveLength(1);
  expect(present[0]?.activeSources).toEqual(['source']);
  expect(await readKindAssertions(executor([{ property: '$exists', value: false }]), 'vertex', 'fixture', [])).toEqual([]);
  expect(await readKindAssertions(executor([{ property: '$exists', value: true, operation: 'retract' }]), 'vertex', 'fixture', [])).toEqual([]);
  expect(await readKindAssertions(executor([{ property: '$exists', value: true, validFrom: '2026-11-16T00:00:00.000Z' }]), 'vertex', 'fixture', [])).toEqual([]);
});

test('0039.25: missing generated typed storage refuses instead of returning a smaller graph', async () => {
  const broken: SqlExecutor = { async query() { throw new Error('missing typed assertion table'); } };
  await expect(readKindAssertions(broken, 'vertex', 'fixture', ['amount'])).rejects.toThrow('missing typed assertion table');
});

test('0039.30: valid time selector is shared with existence and values', async () => {
  const tx = executor([{ property: '$exists', value: true }, { property: 'amount', value: 4, validFrom: '2026-11-16T00:00:00.000Z' }]);
  expect((await readKindAssertions(tx, 'vertex', 'fixture', ['amount']))[0]?.values['amount']).toBeUndefined();
  expect((await readKindAssertions(tx, 'vertex', 'fixture', ['amount'], { validAt: '2026-11-17T00:00:00.000Z' }))[0]?.values['amount']).toBe(4);
});

test('0039.30: edge identities, selected evidence, source streams and cutoffs are retained exactly', async () => {
  const tx = executor([
    { property: '$exists', value: true, source: 'first' },
    { property: '$exists', value: true, source: 'second' },
    { property: '$exists', value: null, operation: 'retract', source: 'second' },
    { property: 'amount', value: 1 },
    { property: 'amount', value: 2, recordedAt: '2026-11-16T00:00:00.000Z' },
  ]);
  const [edge] = await readKindAssertions(tx, 'edge', 'fixture', ['amount', 'amount']);
  expect(edge).toMatchObject({ id: 1, uid: 'subject', key: {}, from: 4, to: 5, discriminator: 'role', values: { '$exists': true, amount: 1 }, activeSources: ['first'] });
  expect(edge?.assertions).toHaveLength(5);
  expect(edge?.selectedAssertions.map(assertion => [assertion.property, assertion.value])).toEqual([['$exists', true], ['amount', 1]]);
  expect((await readKindAssertions(tx, 'edge', 'fixture', ['amount'], { recordedAt: '2026-11-17T00:00:00.000Z' }))[0]?.values['amount']).toBe(2);
  expect(await readKindAssertions(tx, 'edge', 'fixture', [], { contexts: [2] })).toEqual([]);
});

test('0039.25: reconciliation retains only true existence sources of the exact subject', async () => {
  const rows = await readKindAssertions(executor([
    { property: '$exists', value: false, source: 'denier' },
    { property: '$exists', value: true, source: 'holder' },
    { property: '$exists', value: true, source: 'foreign', subjectId: 2 },
    { property: 'flag', value: true, source: 'field-only' },
  ]), 'vertex', 'fixture', ['flag']);
  expect(rows.map(row => [row.uid, row.activeSources])).toEqual([['subject', ['holder']], ['other', ['foreign']]]);
  expect(Object.keys(rows[0]!)).not.toContain('from');
  expect(Object.keys(rows[0]!)).not.toContain('to');
  expect(Object.keys(rows[0]!)).not.toContain('discriminator');
});

test('0039.30: subject UID bounds apply before assertion loading and preserve context cutoffs', async () => {
  const calls: { sql: string; parameters?: readonly unknown[] }[] = [];
  const base = executor([{ property: '$exists', value: true }, { property: 'amount', value: 1 }, { property: 'amount', value: 2, recordedAt: '2026-11-16T00:00:00.000Z' }]);
  const tx: SqlExecutor = { async query(sql, parameters) { calls.push({ sql, ...(parameters === undefined ? {} : { parameters }) }); return await base.query(sql, parameters); } };
  const rows = await readKindAssertions(tx, 'vertex', 'fixture', ['amount'], { subjectUids: ['subject'], recordedAt: '2026-11-17T00:00:00.000Z', contextRecordedThrough: { 1: '2' } });
  expect(calls[0]?.sql).toContain('n.uid=ANY($2::uuid[])');
  expect(calls[0]?.parameters).toEqual(['fixture', ['subject']]);
  expect(calls.filter(call => call.sql.includes('FROM assertion a')).every(call => call.parameters?.some(parameter => Array.isArray(parameter) && parameter.length === 1 && parameter[0] === 1))).toBe(true);
  expect(rows[0]?.values['amount']).toBe(1);
  calls.length = 0;
  expect(await readKindAssertions(tx, 'vertex', 'fixture', ['amount'], { subjectUids: [] })).toEqual([]);
  expect(calls).toEqual([]);
});
