import { expect, test } from 'bun:test';
import type { OuterTransaction } from '../src/adapters/database-owner.js';
import { readFilesPage } from '../src/graph/files-page.js';

function txWith(files: Record<string, unknown>[], rhythm: Record<string, unknown>[] = []): { tx: OuterTransaction; queries: string[] } {
  const queries: string[] = [];
  const tx = { query: async (sql: string) => {
    queries.push(sql);
    return { rows: sql.includes('WITH marks') ? rhythm : files };
  } } as unknown as OuterTransaction;
  return { tx, queries };
}

const columns = { hasLines: true, hasBytes: true, hasLanguage: true, hasTouched: true, hasCommitDate: true, hasAuthors: true };

test('the files page reads facts and rhythm, and a file no claim names is other', async () => {
  const held = txWith([
    { node: 'n1', repository: 'repo', path: 'src/a.ts', lines: '12', bytes: '345', language: 'TypeScript', languages: [['TypeScript']] },
    { node: 'n2', repository: 'repo', path: 'asset.bin', lines: null, bytes: '900', language: null, languages: [['C', 'C++']] },
  ], [
    { file_node: 'n1', d30: '3', d90: '7', d365: '9', all_count: '11', last: '2026-11-10T00:00:00Z', authors: '2' },
  ]);
  const page = await readFilesPage(held.tx, columns);
  expect(page.files.map((file) => [file.kind, file.node, file.path, file.lines, file.bytes, file.language, file.heat, file.authorCount])).toEqual([
    ['code.file', 'n2', 'asset.bin', null, 900, null, { d30: 0, d90: 0, d365: 0, all: 0 }, 0],
    ['code.file', 'n1', 'src/a.ts', 12, 345, 'TypeScript', { d30: 3, d90: 7, d365: 9, all: 11 }, 2],
  ]);
  expect(page.files[1]?.lastChange).toBe('2026-11-10T00:00:00.000Z');
  expect(held.queries).toHaveLength(2);
  expect(held.queries[0]).toContain('"lines"');
  expect(held.queries[1]).toContain('code.touched');
});

test('a product that declares no class or history reads no rhythm statement', async () => {
  const held = txWith([{ node: 'n1', repository: 'repo', path: 'README', lines: '2', bytes: null, language: null, languages: null }]);
  const page = await readFilesPage(held.tx, { ...columns, hasTouched: false });
  expect(page.files[0]?.heat).toEqual({ d30: 0, d90: 0, d365: 0, all: 0 });
  expect(held.queries).toHaveLength(1);
  expect(held.queries[0]).not.toContain('"class"');
});
