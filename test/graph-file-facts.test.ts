/**
 * A product may declare code.file's lines and no class. The file facts read only the columns the manifest declares; the
 * absent class is unknown, never a query for a column the generated table does not hold.
 */
import { expect, test } from 'bun:test';
import type { DatabaseOwner, OuterTransaction } from '../src/adapters/database-owner.js';
import { GIT_KINDS } from '../src/fill/stages/git-contract.js';
import { GraphReader, type GeneratedKindRead } from '../src/knowledge/graph-read.js';

function reader(columns: readonly string[], row: Record<string, unknown>): { reader: GraphReader; queries: string[] } {
  const queries: string[] = [];
  const tx = { query: async (sql: string) => { queries.push(sql); return { rows: [row] }; } } as unknown as OuterTransaction;
  const file: GeneratedKindRead = { kind: GIT_KINDS.file, table: 'ordinary_file', key: ['repository', 'path'], columns, types: {} };
  return {
    queries,
    reader: new GraphReader({} as DatabaseOwner, () => '', undefined, tx, new Set([GIT_KINDS.file]), new Map([[GIT_KINDS.file, file]])),
  };
}

test('a file kind without a class reads its facts and calls the class unknown', async () => {
  const held = reader(['path', 'repository', 'lines'], { node: 'n1', path: 'src/a.ts', repository: 'repo', scope: 'repo', lines: '700', total: '1' });
  const facts = await held.reader.fileFacts('', 10);
  expect(facts.rows).toEqual([{ key: `${GIT_KINDS.file}:repo/src/a.ts`, node: 'n1', path: 'src/a.ts', repository: 'repo', scope: 'repo', class: 'unknown', lines: 700 }]);
  expect(held.queries[0]).not.toContain('"class"');
});

test('a file kind with a class reads that column', async () => {
  const held = reader(['path', 'repository', 'lines', 'class'], { node: 'n1', path: 'src/a.ts', repository: 'repo', scope: 'repo', lines: '700', class: 'generated', total: '1' });
  const facts = await held.reader.fileFacts('', 10);
  expect(facts.rows[0]?.class).toBe('generated');
  expect(held.queries[0]).toContain('o."class"');
});
