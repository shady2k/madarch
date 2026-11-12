/**
 * The relations block (madarch-j9ao.3.1): an entity's one-step neighbourhood through the three diagram engines, the
 * same relations as lists, and every entity with an edge to it. It reads the store's edges and the evidence a produced
 * value carries; no kind is named here beyond the git capability's own file kind.
 */
import { expect, test } from 'bun:test';
import { buildViews, relationsBlock } from '../src/knowledge/views.js';
import type { RenderContext } from '../src/knowledge/blocks.js';
import type { GraphEntity, GraphReader } from '../src/knowledge/graph-read.js';
import { fixtureManifest } from './knowledge-manifest-fixture.js';

/** One graph entity of a fixture: its key, kind, label, properties and the node ids a read names. */
const entity = (key: string, kind: string, label: string, properties: Record<string, unknown> = {}): GraphEntity => ({
  key, kind, label, properties, nodeIds: [`node:${key}`], scope: 'fixture',
});

const MANIFEST = fixtureManifest({ 'code.file': {}, 'code.directory': {}, 'code.commit': {}, 'doc.term': { source: 'document' } });

const contextOf = (graph: unknown): RenderContext => ({
  productFolder: '.', manifest: MANIFEST, markdown: new Map(), language: 'en', repositories: [],
  commitOf: () => null, repoOfScope: () => undefined, readSource: async () => undefined,
  graph: graph as GraphReader,
} as unknown as RenderContext);

test('a file page shows the commits that touched it, its folder, and the terms its file defines, under links here', async () => {
  const file = entity('code.file:repo/src/a.ts', 'code.file', 'src/a.ts', { repository: 'repo', path: 'src/a.ts' });
  const first = entity('code.commit:aaaa', 'code.commit', 'aaaa');
  const second = entity('code.commit:bbbb', 'code.commit', 'bbbb');
  const folder = entity('code.directory:repo/src', 'code.directory', 'src', { repository: 'repo', path: 'src' });
  const term = entity('doc.term:Fill', 'doc.term', 'Fill');
  const graph = {
    find: async () => [],
    allNeighbors: async () => [
      { relation: 'touched', direction: 'out', total: 3, edges: 3, rows: [{ entity: first, edges: 1 }, { entity: second, edges: 1 }] },
      { relation: 'contains', direction: 'in', total: 1, edges: 1, rows: [{ entity: folder, edges: 1 }] },
    ],
    evidenceToward: async () => [{ entity: term, sources: ['glossary@1'] }],
  };
  const block = await relationsBlock({ ctx: contextOf(graph), lang: 'en', productTitle: 'Shop' }, { source: 'graph', entity: file }, { title: 'Relations' }, { product: undefined, env: {} }, { file: 'templates/file.liquid', line: 3 });
  if (block.type !== 'relations') throw new Error(`the block was ${block.type}: ${JSON.stringify(block)}`);
  expect(block.groups.map((group) => `${group.direction}:${group.relation}`)).toEqual(['out:touched', 'in:contains', 'in:stated-in']);
  expect(block.groups.find((group) => group.relation === 'touched')!.rows.map((row) => row.entity.id)).toEqual([first.key, second.key]);
  expect(block.groups.find((group) => group.relation === 'touched')!.total).toBe(3);
  expect(block.groups.find((group) => group.relation === 'stated-in')!.rows[0]!.sources).toEqual(['glossary@1']);
  expect(block.linksHere.map((row) => row.entity.id)).toEqual([folder.key, term.key]);
  expect(block.linksHere.find((row) => row.entity.id === term.key)!.relations).toEqual(['stated-in']);
  expect(block.views).toHaveLength(1);
  expect(block.views[0]!.renderers).toEqual(['likec4', 'mermaid', 'archify']);
  expect(block.views[0]!.mermaidSource).toContain('touched');
  expect(block.views[0]!.mermaidSource).toContain('src/a.ts');
});

test('a term page shows the file it is defined in, with the opinion that said so', async () => {
  const glossary = entity('code.file:repo/docs/glossary.md', 'code.file', 'docs/glossary.md', { repository: 'repo', path: 'docs/glossary.md' });
  const term: GraphEntity = {
    ...entity('doc.term:Fill', 'doc.term', 'Fill'),
    evidence: [{ field: 'definition', repository: 'repo', path: 'docs/glossary.md', lineStart: 3, lineEnd: 4, commit: null, type: 'file', saidBy: 'glossary@1' }],
  };
  const graph = {
    find: async (key: string) => (key === glossary.key ? [glossary] : []),
    allNeighbors: async () => [],
    evidenceToward: async () => [],
  };
  const block = await relationsBlock({ ctx: contextOf(graph), lang: 'ru', productTitle: 'Shop' }, { source: 'graph', entity: term }, { title: 'Связи' }, { product: 'mermaid', env: {} }, { file: 'templates/term.md', line: 1 });
  if (block.type !== 'relations') throw new Error(`the block was ${block.type}: ${JSON.stringify(block)}`);
  const stated = block.groups.find((group) => group.relation === 'stated-in' && group.direction === 'out');
  expect(stated!.rows.map((row) => row.entity.id)).toEqual([glossary.key]);
  expect(stated!.rows[0]!.sources).toEqual(['glossary@1']);
  expect(block.renderer).toBe('mermaid');
  expect(block.views[0]!.renderers).toEqual(['mermaid', 'likec4', 'archify']);
});

test('a page the graph holds no relation to says so instead of an empty frame', async () => {
  const lonely = entity('doc.term:Lonely', 'doc.term', 'Lonely');
  const graph = { find: async () => [], allNeighbors: async () => [], evidenceToward: async () => [] };
  const block = await relationsBlock({ ctx: contextOf(graph), lang: 'en', productTitle: 'Shop' }, { source: 'graph', entity: lonely }, { title: 'Relations' }, { product: undefined, env: {} }, { file: 'templates/term.liquid', line: 1 });
  if (block.type !== 'relations') throw new Error(`the block was ${block.type}: ${JSON.stringify(block)}`);
  expect(block.views).toEqual([]);
  expect(block.groups).toEqual([]);
  expect(block.linksHere).toEqual([]);
  expect(block.empty).toBe('The graph records no relation to this page.');
});

test('the relations view names no entity kind and draws every edge through the three engines', async () => {
  const file = entity('code.file:repo/src/a.ts', 'code.file', 'src/a.ts', { repository: 'repo', path: 'src/a.ts' });
  const commit = entity('code.commit:aaaa', 'code.commit', 'aaaa');
  const graph = {
    find: async (key: string) => (key === file.key ? [file] : []),
    allNeighbors: async () => [{ relation: 'touched', direction: 'out', total: 1, edges: 1, rows: [{ entity: commit, edges: 1 }] }],
    evidenceToward: async () => [],
  };
  const [view] = await buildViews({ ctx: contextOf(graph), lang: 'en', productTitle: 'Shop' }, { type: 'relations', subject: file.key });
  expect(view!.elements.map((element) => element.kind)).toEqual(['product', 'component']);
  expect(view!.edges.map((edge) => `${edge.from}->${edge.to}:${edge.label}`)).toEqual([`${file.key}->${commit.key}:touched`]);
  expect(view!.mermaid).toBeUndefined();
  expect(view!.empty).toBeNull();
});

for (const lang of ['en', 'ru'] as const) {
  test(`relation diagrams use ${lang} words in every renderer payload`, async () => {
    const file = entity('file:a', 'code.file', 'a');
    const folder = entity('folder:b', 'code.directory', 'b');
    const graph = {
      find: async () => [file], evidenceToward: async () => [],
      allNeighbors: async () => [{ relation: 'code.contains', direction: 'out', total: 1, rows: [{ entity: folder, edges: 1 }] }],
    };
    const [view] = await buildViews({ ctx: contextOf(graph), lang, productTitle: 'Shop' }, { type: 'relations', subject: file.key });
    expect(view!.edges[0]!.label).toBe(lang === 'ru' ? 'содержит' : 'contains');
    const block = await relationsBlock({ ctx: contextOf(graph), lang, productTitle: 'Shop' }, { source: 'graph', entity: file }, {}, { product: undefined, env: {} }, { file: 'templates/file.liquid', line: 1 });
    if (block.type !== 'relations') throw new Error('expected relations');
    expect(block.views[0]!.mermaidSource).toContain(lang === 'ru' ? 'содержит' : 'contains');
  });
}
