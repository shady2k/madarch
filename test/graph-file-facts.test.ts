/**
 * A product may declare code.file's lines and no class. The file facts read only the columns the manifest declares; the
 * absent class is unknown, never a query for a column the generated table does not hold.
 */
import { assertionValueTableName, type GraphContract } from '../src/graph/contract.js';
import { withAssertionContract } from '../src/graph/system-contract.js';
import { expect, test } from 'bun:test';
import type { DatabaseOwner, OuterTransaction } from '../src/adapters/database-owner.js';
import { GIT_KINDS } from '../src/fill/stages/git-contract.js';
import { GraphReader, type GeneratedKindRead } from '../src/knowledge/graph-read.js';

function reader(columns: readonly string[], row: Record<string, unknown>): { reader: GraphReader; queries: string[] } {
  const queries: string[] = [];
  const at = '2026-01-01T00:00:00.000Z';
  const assertionRows = (kind: string, fields: readonly string[]) => fields.map((property, index) => ({
    request_index: 0,
    id: `019a0000-0000-7000-8000-${String((kind === GIT_KINDS.file ? 10 : 30) + index).padStart(12, '0')}`,
    subject_id: kind === GIT_KINDS.file ? 1 : 3,
    subject_uid: kind === GIT_KINDS.file ? String(row['node']) : '019a0000-0000-7000-8000-000000000003',
    edge_from: null, edge_to: null, property, context_id: 1, language: null,
    source: '019a0000-0000-7000-8000-000000000004', author: '019a0000-0000-7000-8000-000000000004',
    unit: null, operation_uid: '019a0000-0000-7000-8000-000000000005', evidence: [],
    value: property === '$exists' ? true : row[property], value_type: property === '$exists' ? 'boolean' : property === 'lines' ? 'bigint' : 'text',
    operation: 'assert', valid_from: at, valid_to: null, recorded_at: at, recorded_sequence: String(index + 1),
  }));
  const tx = { query: async (sql: string, values: readonly unknown[] = []) => {
    queries.push(sql);
    if (sql.includes('WITH anchors AS')) return { rows: [] };
    if (sql.includes('AS assertion_uid')) throw new Error('fixture assertions have no evidence');
    if (sql.includes('AS target_kind')) return { rows: [{ id: 3, kind: 'fixture.file-repository', target_uid: row['scope'], target_kind: GIT_KINDS.repository, target_key: { name: 'repo' } }] };
    if (sql.includes('FROM assertion a JOIN node assertion_node')) return { rows: assertionRows(String(values[0]), values[1] as string[]) };
    if (sql.includes('FROM node n JOIN entity k')) return { rows: [{ request_index: 0, id: 1, uid: row['node'], key: { repository: row['repository'], path: row['path'] }, read_at: at }] };
    if (sql.includes('FROM edge n JOIN entity k')) return { rows: [{ request_index: 0, id: 3, uid: '019a0000-0000-7000-8000-000000000003', key: {}, from_node: 1, to_node: 2, discriminator: '', read_at: at }] };
    throw new Error(`unexpected fixture query: ${sql}`);
  } } as unknown as OuterTransaction;
  const file: GeneratedKindRead = { kind: GIT_KINDS.file, table: 'ordinary_file', key: ['repository', 'path'], columns, types: {} };
  const contract: GraphContract = withAssertionContract({
    vertex: [{ name: GIT_KINDS.repository, table: 'ordinary_repository', capability: 'disk', key: ['name'], fields: [{ name: 'name', type: 'text' }] }, { name: file.kind, table: file.table, capability: 'disk', key: file.key,
      fields: columns.map(name => ({ name, type: name === 'lines' ? 'integer' : 'text' })) }],
    edge: [{ name: 'fixture.file-repository', capability: 'disk', from: [GIT_KINDS.file], to: [GIT_KINDS.repository], fields: [], repeats: false,
      cardinality: { from: 'one', to: 'many' }, labels: { en: { out: 'repository', in: 'files' }, ru: { out: 'repository', in: 'files' } } }], dictionary: [],
  });
  return {
    queries,
    reader: new GraphReader({} as DatabaseOwner, () => at, undefined, tx, new Set([GIT_KINDS.file]), new Map([[GIT_KINDS.file, file]]), new Map([['fixture.file-repository', { kind: 'fixture.file-repository', columns: [], types: {}, from: [GIT_KINDS.file], to: [GIT_KINDS.repository] }]]), contract),
  };
}

test('a file kind without a class reads its facts and calls the class unknown', async () => {
  const held = reader(['path', 'repository', 'lines'], { node: 'n1', path: 'src/a.ts', repository: 'repo', scope: 'repo', lines: '700', total: '1' });
  const facts = await held.reader.fileFacts('', 10);
  expect(facts.rows).toEqual([{ key: `${GIT_KINDS.file}:repo/src/a.ts`, node: 'n1', path: 'src/a.ts', repository: 'repo', scope: 'repo', class: 'unknown', lines: 700 }]);
  expect(held.queries.join('\n')).not.toContain(assertionValueTableName(GIT_KINDS.file, 'vertex', 'class'));
});

test('a file kind with a class reads that column', async () => {
  const held = reader(['path', 'repository', 'lines', 'class'], { node: 'n1', path: 'src/a.ts', repository: 'repo', scope: 'repo', lines: '700', class: 'generated', total: '1' });
  const facts = await held.reader.fileFacts('', 10);
  expect(facts.rows[0]?.class).toBe('generated');
  expect(held.queries.join('\n')).toContain(assertionValueTableName(GIT_KINDS.file, 'vertex', 'class'));
});
