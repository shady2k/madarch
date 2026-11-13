import { expect, test } from 'bun:test';
import type { DatabaseOwner, OuterTransaction } from '../src/adapters/database-owner.js';
import { GraphReader, type GraphEntity } from '../src/knowledge/graph-read.js';

test('neighbors chooses natural-key rows before reading opinions and keeps totals and edge counts', async () => {
  let call = 0;
  const tx = { query: async (_sql: string, parameters?: unknown[]) => {
    call += 1;
    if (call === 1) return { rows: [
      { id: '1', relation: 'touches', from_node: '1', to_node: '20' },
      { id: '2', relation: 'touches', from_node: '1', to_node: '30' },
      { id: '3', relation: 'touches', from_node: '1', to_node: '30' },
      { id: '4', relation: 'touches', from_node: '1', to_node: '40' },
    ] };
    if (call === 2) return { rows: [
      { node: '20', uid: '20', kind: 'file', key: { repository: 'repo', path: 'z.ts' } },
      { node: '30', uid: '30', kind: 'file', key: { repository: 'repo', path: 'a.ts' } },
    ] };
    expect(parameters?.[0]).toBe('{30}');
    return { rows: [{ node_id: '30', uid: '30', key: { repository: 'repo', path: 'a.ts' }, kind: 'file', opinions: [{ node: '30', opinion_id: '1', said_by: 'fixture@1', evidence: [] }] }] };
  } } as unknown as OuterTransaction;
  const reader = new GraphReader({} as DatabaseOwner, () => '', undefined, tx, undefined,
    new Map([['file', { kind: 'file', table: 'file_opinion', key: ['repository', 'path'], columns: [], types: {} }]]),
    new Map([['touches', { kind: 'touches', columns: [], types: {}, from: ['commit'], to: ['file'] }]]));
  const groups = await reader.neighbors({ nodeIds: ['1'] } as GraphEntity, { relations: ['touches'], direction: 'out', limit: 1 });
  expect(call).toBe(3);
  expect(groups).toMatchObject([{ relation: 'touches', direction: 'out', total: 2, edges: 4, rows: [{ entity: { key: 'file:repo/a.ts' }, edges: 2 }] }]);
});


test('neighbors orders keyless identities by uid before resolving their opinions', async () => {
  let call = 0;
  const tx = { query: async (_sql: string, parameters?: unknown[]) => {
    call += 1;
    if (call === 1) return { rows: [
      { id: '1', relation: 'links', from_node: '1', to_node: '2' },
      { id: '2', relation: 'links', from_node: '1', to_node: '3' },
    ] };
    if (call === 2) return { rows: [
      { node: '2', uid: 'zz', kind: 'item', key: {} },
      { node: '3', uid: 'aa', kind: 'item', key: {} },
    ] };
    expect(parameters?.[0]).toBe('{3}');
    return { rows: [{ node_id: '3', uid: 'aa', key: {}, kind: 'item', opinions: [{ node: '3', opinion_id: '1', said_by: 'fixture@1', evidence: [] }] }] };
  } } as unknown as OuterTransaction;
  const reader = new GraphReader({} as DatabaseOwner, () => '', undefined, tx, undefined,
    new Map([['item', { kind: 'item', table: 'item_opinion', key: [], columns: [], types: {} }]]),
    new Map([['links', { kind: 'links', columns: [], types: {}, from: ['item'], to: ['item'] }]]));
  expect(await reader.neighbors({ nodeIds: ['1'] } as GraphEntity, { relations: ['links'], direction: 'out', limit: 1 }))
    .toMatchObject([{ total: 2, edges: 2, rows: [{ entity: { key: 'item:aa' } }] }]);
});


test.each(['both', 'out', 'in'] as const)('neighbors keeps polymorphic endpoints in the %s direction', async (direction) => {
  let call = 0;
  const tx = { query: async (_sql: string, parameters?: unknown[]) => {
    call += 1;
    if (call === 1) return { rows: [
      { id: '1', relation: 'links', from_node: '1', to_node: '2' },
      { id: '2', relation: 'links', from_node: '1', to_node: '3' },
      { id: '3', relation: 'links', from_node: '4', to_node: '1' },
    ] };
    if (call === 2) return { rows: [
      { node: '2', uid: '2', kind: 'alpha', key: { name: 'a' } },
      { node: '3', uid: '3', kind: 'beta', key: { name: 'b' } },
      { node: '4', uid: '4', kind: 'gamma', key: { name: 'c' } },
    ] };
    expect(parameters?.[0]).toBe(direction === 'out' ? '{2,3}' : direction === 'in' ? '{4}' : '{2,3,4}');
    return { rows: ['alpha', 'beta', 'gamma'].map((kind, at) => ({ node_id: String(at + 2), uid: String(at + 2), kind, key: { name: ['a', 'b', 'c'][at] }, opinions: [{ node: String(at + 2), opinion_id: String(at), said_by: 'fixture@1', evidence: [] }] })) };
  } } as unknown as OuterTransaction;
  const generated = new Map(['alpha', 'beta', 'gamma', 'unrelated'].map((kind) => [kind, { kind, table: `${kind}_opinion`, key: ['name'], columns: [], types: {} }]));
  const reader = new GraphReader({} as DatabaseOwner, () => '', undefined, tx, undefined, generated,
    new Map([['links', { kind: 'links', columns: [], types: {}, from: ['alpha', 'gamma'], to: ['alpha', 'beta'] }]]));
  const groups = await reader.neighbors({ nodeIds: ['1'] } as GraphEntity, { relations: ['links'], direction, limit: 10 });
  expect(groups.map((group) => [group.direction, group.rows.map((row) => row.entity.key)]))
    .toEqual(direction === 'out' ? [['out', ['alpha:a', 'beta:b']]] : direction === 'in' ? [['in', ['gamma:c']]] : [['out', ['alpha:a', 'beta:b']], ['in', ['gamma:c']]]);
});
