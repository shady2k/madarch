import { expect, test } from 'bun:test';
import type { GraphEntity, GraphReader } from '../src/knowledge/graph-read.js';
import type { KindsManifest } from '../src/product/manifest/kinds.js';
import { graphMarkdownEntities } from '../src/knowledge/markdown.js';
import { graphKnowledgePages } from '../src/knowledge/index/index.js';

const manifest = { file: 'madarch/kinds.yaml', kinds: new Map([['page', { name: 'page', source: 'graph' }]]) } as unknown as KindsManifest;
function graph(rows: GraphEntity[]): Pick<GraphReader, 'list'> {
  return { list: async (_kind, options) => options?.after === undefined
    ? { rows: rows.slice(0, 1), next: 'next', total: rows.length }
    : { rows: rows.slice(1), next: null, total: rows.length } } as Pick<GraphReader, 'list'>;
}
const entity = (key: string, properties: Record<string, unknown>): GraphEntity => ({ key, kind: 'page', label: key, properties, nodeIds: [], scope: '' });

test('pages consume structured opinions across every result page, in code-point order', async () => {
  const statement = { id: 'claim', text: 'A stated fact.', paragraph: 'A stated fact.', labels: ['claim'], line: 8, digest: 'sentence', mentions: [], grounds: ['code:one'] };
  const input = graph([
    entity('page:z', { body: '---not YAML---', statements: [statement], file: 'pages/z.md', digest: 'page', relates: ['code:one'] }),
    entity('page:a', { body: 'plain body', title: 'Page A' }),
    entity('page:code', { path: 'code.ts' }),
  ]);
  const read = await graphMarkdownEntities(input, manifest);
  expect(read.entities.map((page) => page.id)).toEqual(['page:a', 'page:z']);
  expect(read.entities[0]!.title).toBe('Page A');
  expect(read.entities[1]!.statementReading.definitions.get('claim')).toEqual(['madarch:code:one']);
  const indexed = await graphKnowledgePages(input, manifest);
  expect(indexed.pages[1]!.statements).toEqual([statement]);
  expect(indexed.pages[1]!.digest).toBe('page');
});

test('invalid structured list opinions fail rather than silently dropping a page', async () => {
  await expect(graphMarkdownEntities(graph([entity('page:broken', { body: '', relates: ['ok', 7] })]), manifest)).rejects.toThrow('page:broken.relates');
});

test('a present malformed body is rejected even when no body field is declared', async () => {
  await expect(graphMarkdownEntities(graph([entity('page:broken', { body: 7 })]), manifest)).rejects.toThrow('page:broken.body');
});
