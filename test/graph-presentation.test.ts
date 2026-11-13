/** Canonical identity and source presentation come from ordinary declared keys and opinion evidence. */
import { expect, test } from 'bun:test';
import { generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { GraphReader, type GeneratedKindRead } from '../src/knowledge/graph-read.js';
import { createTestDatabaseOwner } from './test-database.js';

const fileTable = generatedTableName('code.file', 'vertex');
const termTable = generatedTableName('doc.term', 'vertex');
const contract: GraphContract = {
  vertex: [
    { name: 'code.file', table: fileTable, capability: 'disk', key: ['repository', 'path'], fields: [{ name: 'repository', type: 'text' }, { name: 'path', type: 'text' }, { name: 'language', type: 'text' }] },
    { name: 'doc.term', table: termTable, capability: 'glossary', key: ['name'], fields: [{ name: 'name', type: 'text' }, { name: 'definition', type: 'text' }] },
  ],
  edge: [], dictionary: [],
};
const generated = new Map<string, GeneratedKindRead>([
  ['code.file', { kind: 'code.file', table: fileTable, key: ['repository', 'path'], columns: ['language'], types: { repository: 'text', path: 'text', language: 'text' } }],
  ['doc.term', { kind: 'doc.term', table: termTable, key: ['name'], columns: ['definition'], types: { name: 'text', definition: 'text' } }],
]);

test('ordinary declarations preserve canonical keys across producers and present each opinion source', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    await owner.transaction('write', async (tx) => {
      await publishGraphDrafts(tx, contract, {
        vertices: ['disk', 'linguist'].map((producer) => ({
          kind: 'code.file', key: { repository: 'repo', path: 'src/a.ts' }, values: { language: 'TypeScript' }, producer, producerVersion: '1',
          evidence: [{ type: 'file' as const, repository: 'repo', path: 'src/a.ts', commit_or_digest: 'c0ffee', line_start: 2, line_end: 4 }],
        })), removals: [],
      });
      await publishGraphDrafts(tx, contract, {
        vertices: [
          { kind: 'doc.term', key: { name: 'ordinary' }, values: { definition: 'Declared values' }, producer: 'glossary', producerVersion: '1', evidence: [{ type: 'file', repository: 'repo', path: 'docs/terms.md', commit_or_digest: 'c0ffee', line_start: 3, line_end: 5 }] },
          { kind: 'doc.term', key: { name: 'unplaced' }, values: { definition: 'No source place' }, producer: 'glossary', producerVersion: '1' },
        ], removals: [],
      });
    });
    const reader = new GraphReader(owner, () => 'now', undefined, undefined, undefined, generated);
    const files = await reader.find('code.file:repo/src/a.ts');
    expect(files).toHaveLength(1);
    expect(files[0]?.key).toBe('code.file:repo/src/a.ts');
    expect(files[0]?.properties).toMatchObject({ recordKey: 'code.file:repo/src/a.ts', repository: 'repo', path: 'src/a.ts', language: 'TypeScript' });
    expect(files[0]?.opinions?.map((opinion) => opinion.producer).sort()).toEqual(['disk@1', 'linguist@1']);
    expect(files[0]?.span).toEqual({ path: 'src/a.ts', lineStart: 2, lineEnd: 4, byteStart: 0, byteEnd: 0 });
    expect(await reader.find('file:9f2c')).toEqual([]);
    const [term] = await reader.find('doc.term:ordinary');
    expect(term?.key).toBe('doc.term:ordinary');
    expect(term?.label).toBe('ordinary');
    expect(term?.span).toEqual({ path: 'docs/terms.md', lineStart: 3, lineEnd: 5, byteStart: 0, byteEnd: 0 });
    expect(term?.opinions?.[0]?.evidence).toEqual([expect.objectContaining({ field: 'definition', repository: 'repo', path: 'docs/terms.md', lineStart: 3, lineEnd: 5, commit: 'c0ffee', saidBy: 'glossary@1' })]);
    const [unplaced] = await reader.find('doc.term:unplaced');
    expect(unplaced?.span).toBeUndefined();
    expect(unplaced?.evidence).toBeUndefined();
    expect(unplaced?.properties['definition']).toBe('No source place');
    // A mixed-kind relation read uses the batched path; it must keep the same opinions and presentation as find.
    const expected = [...files, term!, unplaced!];
    await owner.transaction('snapshot', async (tx) => {
      const batchReader = reader as unknown as { entitiesOfIds(transaction: typeof tx, ids: readonly string[]): Promise<Map<string, typeof files[number]>> };
      const batched = await batchReader.entitiesOfIds(tx, expected.flatMap((entity) => entity.nodeIds));
      expect([...batched.values()].sort((left, right) => left.key.localeCompare(right.key)))
        .toEqual(expected.sort((left, right) => left.key.localeCompare(right.key)));
    });
  } finally { await owner.close(); }
});
