/** Declared keys and typed assertions retain source and evidence presentation (0039.14,25,30). */
import { expect, test } from 'bun:test';
import { generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { GraphReader, type GeneratedKindRead } from '../src/knowledge/graph-read.js';
import { createTestDatabaseOwner } from './test-database.js';
import { bindTestWriteCapability } from './write-capability-fixture.js';
import { sha256Hex } from '../src/graph/digest.js';

const contract: GraphContract = {
  vertex: [
    { name: 'code.file', table: generatedTableName('code.file', 'vertex'), capability: 'disk', key: ['path'], fields: [{ name: 'path', type: 'text' }, { name: 'language', type: 'text' }] },
    { name: 'doc.term', table: generatedTableName('doc.term', 'vertex'), capability: 'glossary', key: ['name'], fields: [{ name: 'name', type: 'text' }, { name: 'definition', type: 'text' }] },
  ], edge: [], dictionary: [],
};
const generated = new Map<string, GeneratedKindRead>(contract.vertex.map(kind => [kind.name, { kind: kind.name, table: kind.table, key: kind.key, columns: kind.fields.filter(f => !kind.key.includes(f.name)).map(f => f.name), types: Object.fromEntries(kind.fields.map(f => [f.name, f.type])) }]));
const sources = ['019a0000-0000-7000-8000-000000000011', '019a0000-0000-7000-8000-000000000012'];
const content = 'line 1\nline 2\nline 3\nline 4\nline 5\n';
const digest = sha256Hex(Buffer.from(content));
const snapshot = { kind: 'system.content-snapshot', key: { digest } };

test('ordinary declarations preserve canonical keys and present each assertion source and graph evidence', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    for (const source of sources) await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, contract, source);
      await publishGraphDrafts(tx, contract, { vertices: [
        { ...snapshot, values: { content }, producer: 'fixture', producerVersion: '1' },
        { kind: 'code.file', key: { path: 'src/a.ts' }, values: { language: 'TypeScript' }, producer: 'fixture', producerVersion: '1', evidence: [{ target: snapshot, locator: { path: 'src/a.ts', digest, lineStart: 2, lineEnd: 4 } }] },
      ], removals: [] });
    });
    await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, contract, sources[0]);
      await publishGraphDrafts(tx, contract, { vertices: [
        { kind: 'doc.term', key: { name: 'ordinary' }, values: { definition: 'Declared values' }, producer: 'fixture', producerVersion: '1', evidence: [{ target: snapshot, locator: { path: 'docs/terms.md', digest, lineStart: 3, lineEnd: 5 } }] },
        { kind: 'doc.term', key: { name: 'unplaced' }, values: { definition: 'No source place' }, producer: 'fixture', producerVersion: '1' },
      ], removals: [] });
    });
    const reader = new GraphReader(owner, () => new Date().toISOString(), undefined, undefined, undefined, generated, undefined, owner.graphContract);
    const files = await reader.find('code.file:src/a.ts');
    expect(files).toHaveLength(1);
    expect(files[0]!.nodeIds).toEqual([files[0]!.uid!]);
    expect(files[0]?.uid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(files[0]?.evidence).toEqual([
      expect.objectContaining({ historicalValidity: 'valid', currentApplicability: 'unknown', availability: 'available' }),
      expect.objectContaining({ historicalValidity: 'valid', currentApplicability: 'unknown', availability: 'available' }),
    ]);
    expect(files[0]?.properties).toMatchObject({ recordKey: 'code.file:src/a.ts', path: 'src/a.ts', language: 'TypeScript' });
    expect(files[0]?.opinions?.map(o => o.producer).sort()).toEqual(sources);
    expect(files[0]?.span).toEqual({ path: 'src/a.ts', lineStart: 2, lineEnd: 4, byteStart: 0, byteEnd: 0 });
    expect(await reader.find('file:9f2c')).toEqual([]);
    const [term] = await reader.find('doc.term:ordinary');
    expect(term?.key).toBe('doc.term:ordinary');
    expect(term?.label).toBe('ordinary');
    expect(term?.span).toEqual({ path: 'docs/terms.md', lineStart: 3, lineEnd: 5, byteStart: 0, byteEnd: 0 });
    expect(term?.opinions?.[0]?.evidence).toEqual([expect.objectContaining({ field: 'definition', path: 'docs/terms.md', lineStart: 3, lineEnd: 5, saidBy: sources[0] })]);
    const [unplaced] = await reader.find('doc.term:unplaced');
    expect(unplaced?.span).toBeUndefined();
    expect(unplaced?.evidence).toEqual([]);
    expect(unplaced?.properties['definition']).toBe('No source place');
    const expected = [...files, term!, unplaced!];
    await owner.transaction('snapshot', async tx => {
      const batchReader = reader as unknown as { entitiesOfIds(transaction: typeof tx, ids: readonly string[]): Promise<Map<string, typeof files[number]>> };
      const batched = await batchReader.entitiesOfIds(tx, expected.flatMap(entity => entity.nodeIds));
      const order = (a: typeof files[number], b: typeof files[number]) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
      expect([...batched.values()].sort(order)).toEqual(expected.sort(order));
    });
  } finally { await owner.close(); }
});
