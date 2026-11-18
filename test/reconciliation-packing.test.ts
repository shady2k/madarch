import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { reconciliationBatches, type ContractDeclaration, type EntityRef, type ReconciliationWrite } from '../src/plugin-sdk.js';

const unit = { unitId: 'scan-7', kind: 'scan', key: { id: 'source' } };
const vertex = (id: string): EntityRef => ({ kind: 'item', key: { id } });
const contract = (bound: 'one' | 'optional' | 'some' | 'many' = 'one'): ContractDeclaration => ({
  vertices: [{ kind: 'item', key: ['id'] }],
  edges: [{ kind: 'in', from: 'item', to: 'item', cardinality: { from: 'many', to: bound }, labels: { en: { out: 'in', in: 'holds' }, ru: { out: 'in', in: 'holds' } } }],
});
const add = (id: string): ReconciliationWrite => ({ operation: 'add', vertex: vertex(id) });
const batches = (writes: ReconciliationWrite[], declaration = contract()) => [...reconciliationBatches(writes, declaration, unit)];
const edge = (from: string, to: string) => ({ kind: 'in', from: vertex(from), to: vertex(to) });

test('499 independent vertices leave a two-fact required group whole in the second batch', () => {
  const child = add('z-child');
  const required: ReconciliationWrite = { operation: 'add', edge: edge('z-child', 'existing') };
  const result = batches([...Array.from({ length: 499 }, (_, i) => add(String(i).padStart(3, '0'))), child, required]);
  expect(result).toHaveLength(2);
  expect(result[0]!.vertices).toHaveLength(499);
  expect(result[0]!.edges).toBeUndefined();
  expect(result[1]).toEqual({ vertices: [child.vertex!], edges: [required.edge!] });
});

test('new parents stay with their child and precede it even across lexical kind order', () => {
  const parent = { kind: 'z-parent', key: { id: 'p' } };
  const child = { kind: 'a-child', key: { id: 'c' }, keyEdges: { parent } };
  const result = batches([{ operation: 'add', vertex: child }, { operation: 'add', vertex: parent }]);
  expect(result).toEqual([{ vertices: [parent, child] }]);
});

for (const bound of ['one', 'optional'] as const) test(`${bound} target replacement stays in one group at a boundary`, () => {
  const replacement = edge('child', 'new');
  const old = edge('child', 'old');
  const result = batches([...Array.from({ length: 499 }, (_, i) => add(String(i).padStart(3, '0'))), { operation: 'add', edge: replacement }, { operation: 'remove', edge: old }], contract(bound));
  expect(result).toHaveLength(2);
  expect(result[1]).toEqual({ edges: [replacement], edgeRemovals: [old] });
});

test('retirement drops incident edge retractions and retires children before parents', () => {
  const parent = vertex('a-parent');
  const child = { ...vertex('z-child'), keyEdges: { parent } };
  const result = batches([{ operation: 'remove', vertex: parent }, { operation: 'remove', vertex: child }, { operation: 'remove', edge: { kind: 'in', from: child, to: parent } }]);
  expect(result).toEqual([{ removals: [child, parent] }]);
});

test('independent phases remain additions, edges, edge retractions, retirements', () => {
  const result = batches([{ operation: 'remove', vertex: vertex('retired') }, { operation: 'remove', edge: edge('old', 'target') }, { operation: 'add', edge: edge('new', 'target') }, add('new')], contract('many'));
  expect(result).toEqual([{ vertices: [vertex('new')] }, { edges: [edge('new', 'target')] }, { edgeRemovals: [edge('old', 'target')] }, { removals: [vertex('retired')] }]);
});

test('permutations give identical batches and content keys in code-point order', () => {
  const writes = [add('𐀀'), add(''), add('a'), { operation: 'add', edge: edge('a', 'existing') } as ReconciliationWrite];
  const first = batches(writes);
  const second = batches([...writes].reverse());
  expect(first).toEqual(second);
  const keys = (operations: typeof first) => operations.map(operation => createHash('sha256').update(JSON.stringify(operation)).digest('hex'));
  expect(keys(first)).toEqual(keys(second));
  expect(first[0]!.vertices!.map(fact => fact.key['id'])).toEqual(['a', '', '𐀀']);
});

test('oversized fact refusal names the unit, group kind and key, and actual source location', () => {
  expect(() => batches([{ operation: 'add', vertex: { ...vertex('huge'), values: { text: '界'.repeat(180000) } } }])).toThrow('scan-7');
  try { batches([{ operation: 'add', vertex: { ...vertex('huge'), values: { text: '界'.repeat(180000) } } }]); }
  catch (error) {
    const message = (error as Error).message;
    expect(message).toContain('item');
    expect(message).toContain('huge');
    expect(message).toContain('512 KB');
    expect(message).toContain('/src/plugin-sdk.ts:');
  }
});

test('a group over 500 facts goes alone, but over the byte request limit is refused whole', () => {
  const child = add('z-child');
  const edges: ReconciliationWrite[] = Array.from({ length: 500 }, (_, i) => ({ operation: 'add', edge: edge('z-child', String(i)) }));
  const result = batches([add('a'), child, ...edges], contract('some'));
  expect(result).toHaveLength(2);
  expect(result[1]!.vertices).toEqual([child.vertex!]);
  expect(result[1]!.edges).toHaveLength(500);
  expect(() => batches([child, ...edges.map(write => ({ ...write, edge: { ...write.edge!, values: { text: 'x'.repeat(1100) } } }))], contract('some'))).toThrow('z-child');
});

test('UTF-8 byte accounting includes array punctuation and accepts an exact byte boundary', () => {
  const base = { ...vertex('a'), values: { text: '' } };
  const overhead = Buffer.byteLength(JSON.stringify({ vertices: [base] }));
  const exact = { ...base, values: { text: 'x'.repeat(512 * 1024 - overhead) } };
  const result = batches([{ operation: 'add', vertex: exact }, add('b')]);
  expect(result).toHaveLength(2);
  expect(Buffer.byteLength(JSON.stringify(result[0]))).toBe(512 * 1024);
});

test('empty differences send no operation and exactly 500 facts fit together', () => {
  expect(batches([])).toEqual([]);
  const result = batches(Array.from({ length: 500 }, (_, i) => add(String(i).padStart(3, '0'))));
  expect(result).toHaveLength(1);
  expect(result[0]!.vertices).toHaveLength(500);
});

test('a second group can fill the byte limit exactly without an early flush', () => {
  const first = vertex('a');
  const base = { ...vertex('b'), values: { text: '' } };
  const overhead = Buffer.byteLength(JSON.stringify({ vertices: [first, base] }));
  const second = { ...base, values: { text: 'x'.repeat(512 * 1024 - overhead) } };
  const result = batches([{ operation: 'add', vertex: first }, { operation: 'add', vertex: second }]);
  expect(result).toHaveLength(1);
  expect(Buffer.byteLength(JSON.stringify(result[0]))).toBe(512 * 1024);
});

test('replacement stays with retirement of the old target even when its incident retraction is implicit', () => {
  const replacement = edge('child', 'new');
  const result = batches([{ operation: 'add', edge: replacement }, { operation: 'remove', edge: edge('child', 'old') }, { operation: 'remove', vertex: vertex('old') }]);
  expect(result).toEqual([{ edges: [replacement], removals: [vertex('old')] }]);
});

test('independent edge groups sharing an endpoint have a total order', () => {
  const writes: ReconciliationWrite[] = [{ operation: 'add', edge: edge('same', 'b') }, { operation: 'add', edge: edge('same', 'a') }];
  expect(batches(writes, contract('many'))).toEqual(batches([...writes].reverse(), contract('many')));
});

for (const bound of ['many', 'optional'] as const) test(`${bound} edges do not merge new endpoint groups at the batch boundary`, () => {
  const writes = [...Array.from({ length: 499 }, (_, i) => add(String(i).padStart(3, '0'))), add('z-a'), add('z-b'), { operation: 'add', edge: edge('z-a', 'z-b') } as ReconciliationWrite];
  const result = batches(writes, contract(bound));
  expect(result).toEqual([
    { vertices: writes.slice(0, 500).map(write => write.vertex!) },
    { vertices: [vertex('z-b')] },
    { edges: [edge('z-a', 'z-b')] },
  ]);
});

for (const bound of ['many', 'optional'] as const) test(`600 new vertices with ${bound} links stay within the fact limit`, () => {
  const ids = Array.from({ length: 600 }, (_, i) => String(i).padStart(3, '0'));
  const result = batches([...ids.map(add), ...ids.slice(1).map((id, i): ReconciliationWrite => ({ operation: 'add', edge: edge(ids[i]!, id) }))], contract(bound));
  expect(result.map(batch => (batch.vertices?.length ?? 0) + (batch.edges?.length ?? 0))).toEqual([500, 100, 500, 99]);
  expect(result.slice(0, 2).flatMap(batch => batch.vertices ?? [])).toHaveLength(600);
  expect(result.slice(0, 2).every(batch => batch.edges === undefined)).toBe(true);
});

test('ordering 5000 retirements indexes children instead of canonicalizing every pair', () => {
  let canonicalKeyReads = 0;
  // Canonical reads enumerable key fields; count those reads, including parent references.
  const counted = (id: string): EntityRef => ({ kind: 'item', key: { get id() { canonicalKeyReads++; return id; } } });
  const parent = counted('p');
  const children = Array.from({ length: 4999 }, (_, i) => ({ ...counted(String(i)), keyEdges: { p: parent } }));
  const result = batches([parent, ...children].map(vertex => ({ operation: 'remove', vertex })));
  expect(result).toHaveLength(1);
  expect(result[0]!.removals).toHaveLength(5000);
  expect(result[0]!.removals!.at(-1)).toEqual(parent);
  expect(canonicalKeyReads).toBeLessThan(500_000);
}, 120_000);
