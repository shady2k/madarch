import { expect, test } from 'bun:test';
import type { DatabaseOwner, OuterTransaction } from '../src/adapters/database-owner.js';
import { GraphReader } from '../src/knowledge/graph-read.js';

test.each([0, 1])('one wiki kind combines native and generated counts (%i generated)', async (generated) => {
  const tx = { query: async () => ({ rows: [
    { kind: 'repository', n: '1' },
    { kind: 'code.repository', n: String(generated) },
    { kind: 'example.topic', n: '3' },
  ] }) } as unknown as OuterTransaction;
  const reader = new GraphReader({} as DatabaseOwner, () => '', undefined, tx);
  expect(await reader.kindCounts()).toEqual([
    { kind: 'code.repository', count: 1 + generated },
    { kind: 'example.topic', count: 3 },
  ]);
});


test('find reads native entities even when the same wiki kind has an empty generated source', async () => {
  const tx = { query: async (sql: string) => ({ rows: sql.includes('native_repository_table') ? [] : [
    { kind: 'repository', node_id: '1', repository_name: 'fixture', key: { name: 'fixture' } },
  ] }) } as unknown as OuterTransaction;
  const reader = new GraphReader({} as DatabaseOwner, () => '', undefined, tx, new Set(['repository']), new Map([
    ['code.repository', { kind: 'code.repository', table: 'native_repository_table', key: ['name'], columns: [], types: {} }],
  ]));
  expect((await reader.find('code.repository:fixture')).map((entity) => entity.key)).toEqual(['code.repository:fixture']);
});


test.each([false, true])('find keeps a generated match and reads native only when declared (%s)', async (native) => {
  let nativeQueries = 0;
  const tx = { query: async (sql: string) => {
    if (sql.includes('FROM generated_repository t')) return { rows: sql.includes('ORDER BY node_id')
      ? [{ node_id: '2', key: { name: 'fixture' } }] : [] };
    nativeQueries++;
    return { rows: [{ kind: 'repository', node_id: '1', repository_name: 'fixture', key: { name: 'fixture' } }] };
  } } as unknown as OuterTransaction;
  const reader = new GraphReader({} as DatabaseOwner, () => '', undefined, tx, new Set(native ? ['repository'] : []), new Map([
    ['code.repository', { kind: 'code.repository', table: 'generated_repository', key: ['name'], columns: [], types: {} }],
  ]));
  const matches = await reader.find('code.repository:fixture');
  expect(matches.map((entity) => entity.key)).toEqual(Array(native ? 2 : 1).fill('code.repository:fixture'));
  expect(nativeQueries).toBe(native ? 1 : 0);
});

test('find of an undeclared kind opens no snapshot', async () => {
  const reader = new GraphReader({} as DatabaseOwner, () => '', undefined, undefined, new Set());
  expect(await reader.find('example.unknown:fixture')).toEqual([]);
});
