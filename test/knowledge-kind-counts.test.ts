import { expect, test } from 'bun:test';
import type { DatabaseOwner, OuterTransaction } from '../src/adapters/database-owner.js';
import { GraphReader } from '../src/knowledge/graph-read.js';

const repository = { kind: 'code.repository', table: 'ordinary_repository', key: ['name'], columns: [], types: {} };

test.each([0, 1])('wiki counts use canonical declared repository identities (%i additional)', async (additional) => {
  const queries: string[] = [];
  const tx = { query: async (sql: string) => {
    queries.push(sql);
    return { rows: [
      { kind: 'example.topic', n: '3' },
      { kind: 'code.repository', n: String(1 + additional) },
    ] };
  } } as unknown as OuterTransaction;
  const reader = new GraphReader({} as DatabaseOwner, () => '', undefined, tx, new Set(['code.repository', 'example.topic']), new Map([
    ['code.repository', repository],
    ['example.topic', { kind: 'example.topic', table: 'ordinary_topic', key: ['name'], columns: [], types: {} }],
  ]));
  expect(await reader.kindCounts()).toEqual([
    { kind: 'code.repository', count: 1 + additional },
    { kind: 'example.topic', count: 3 },
  ]);
  expect(queries).toHaveLength(1);
  expect(queries[0]).toContain('FROM ordinary_repository t');
  expect(queries[0]).toContain('FROM ordinary_topic t');
});

test('find of an empty declared repository source does not query another source', async () => {
  let queries = 0;
  const tx = { query: async (sql: string) => {
    expect(sql).toContain('FROM ordinary_repository t');
    queries++;
    return { rows: [] };
  } } as unknown as OuterTransaction;
  const reader = new GraphReader({} as DatabaseOwner, () => '', undefined, tx, new Set(['code.repository']), new Map([
    ['code.repository', repository],
  ]));
  expect(await reader.find('code.repository:fixture')).toEqual([]);
  expect(queries).toBe(1);
});

test.each([false, true])('find reads only the mapped canonical kind (%s declared)', async (declared) => {
  const queries: string[] = [];
  const tx = { query: async (sql: string) => {
    queries.push(sql);
    expect(sql).toContain('FROM ordinary_repository t');
    return { rows: sql.includes('ORDER BY node_id')
      ? [{ node_id: '2', key: { name: 'fixture' } }] : [] };
  } } as unknown as OuterTransaction;
  const reader = new GraphReader({} as DatabaseOwner, () => '', undefined, tx, new Set(declared ? ['code.repository'] : []), new Map(
    declared ? [['code.repository', repository]] : [],
  ));
  const matches = await reader.find('code.repository:fixture');
  expect(matches.map((entity) => entity.key)).toEqual(declared ? ['code.repository:fixture'] : []);
  expect(queries).toHaveLength(declared ? 2 : 0);
});

test('find and counts of undeclared kinds open no snapshot', async () => {
  const reader = new GraphReader({} as DatabaseOwner, () => '', undefined, undefined, new Set());
  expect(await reader.find('example.unknown:fixture')).toEqual([]);
  expect(await reader.kindCounts()).toEqual([]);
});
