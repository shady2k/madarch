/**
 * The kind `code.file` over the graph (madarch-hsqs stage A): the listing and the count a page reads come from the
 * graph's own `code.file` entities, whose keys carry the repository, and no record-store reader stands beside them.
 */
import { describe, expect, test } from 'bun:test';
import { kindSummaries, listEntities } from '../src/knowledge/render.js';
import type { RenderContext } from '../src/knowledge/blocks.js';
import type { KindsManifest } from '../src/knowledge/kinds.js';
import type { GraphEntity } from '../src/knowledge/graph-read.js';
import { workingTreeFiles } from '../src/knowledge/product-files.js';

const decl = (name: string): KindsManifest['kinds'] extends ReadonlyMap<string, infer Decl> ? Decl : never => ({ name, source: 'graph' } as never);

const entity = (repository: string, path: string): GraphEntity => ({
  key: `code.file:${repository}/${path}`, kind: 'code.file', label: path,
  properties: { repository, path }, nodeIds: ['1'], scope: repository,
});

/** The smallest context a listing of `code.file` reads: the manifest declaring the kind, and the graph's answer. */
function context(files: readonly GraphEntity[], asked: { after?: string; prefix?: string }[], count = files.length): RenderContext {
  return {
    productFolder: '/nowhere',
    files: workingTreeFiles('/nowhere'),
    manifest: { file: 'madarch/kinds.yaml', roles: new Map(), properties: new Map(), kinds: new Map([['code.file', decl('code.file')]]), declaredTemplates: [], groups: new Map(), excludeDocuments: [], ignoreBlocks: [], findings: [] } as unknown as KindsManifest,
    graph: {
      kindCounts: async () => [{ kind: 'code.file', count }],
      byPrefix: async (_kind: string, prefix: string, limit: number, after?: string) => {
        asked.push({ ...(prefix === 'code.file:' ? {} : { prefix: prefix.slice('code.file:'.length) }), ...(after === undefined ? {} : { after }) });
        const rest = prefix.startsWith('code.file:') ? prefix.slice('code.file:'.length) : '';
        const matching = files.filter((one) => one.key.startsWith(prefix) || (rest !== '' && String(one.properties['path'] ?? '').startsWith(rest)));
        const tail = after === undefined ? matching : matching.filter((one) => one.key > after);
        return { total: matching.length, rows: tail.slice(0, limit) };
      },
    } as unknown as RenderContext['graph'],
    markdown: new Map(),
    language: 'en',
    repositories: ['shop-forward'],
    webOf: () => undefined,
    commitOf: () => null,
    resolver: {} as RenderContext['resolver'],
    repoOfScope: () => undefined,
    readSource: async () => undefined,
  };
}

describe('the kind code.file over the graph', () => {
  test('the listing answers the graph\'s files, each linking to its entity page', async () => {
    const asked: { after?: string; prefix?: string }[] = [];
    const listing = await listEntities(context([entity('shop-forward', 'src/a.ts'), entity('shop-forward', 'src/nested/b.ts')], asked), 'code.file', { limit: 100 });
    expect(listing?.total).toBe(2);
    expect(listing?.rows).toEqual([
      {
        id: 'code.file:shop-forward/src/a.ts', kind: 'code.file', label: 'src/a.ts', href: '/e/code.file%3Ashop-forward%2Fsrc%2Fa.ts',
        location: { repo: 'shop-forward', path: 'src/a.ts', lineStart: 1, lineEnd: 1, href: `/src?repo=shop-forward&path=src%2Fa.ts&line=1` },
      },
      {
        id: 'code.file:shop-forward/src/nested/b.ts', kind: 'code.file', label: 'src/nested/b.ts', href: '/e/code.file%3Ashop-forward%2Fsrc%2Fnested%2Fb.ts',
        location: { repo: 'shop-forward', path: 'src/nested/b.ts', lineStart: 1, lineEnd: 1, href: `/src?repo=shop-forward&path=src%2Fnested%2Fb.ts&line=1` },
      },
    ]);
    expect(asked).toEqual([{}]);
  });

  test('the listing asks the graph for the page the reader is on, and for its filter as a path prefix', async () => {
    const asked: { after?: string; prefix?: string }[] = [];
    const listing = await listEntities(context([entity('shop-forward', 'src/a.ts'), entity('shop-forward', 'src/nested/b.ts')], asked), 'code.file', { limit: 1, after: 'code.file:shop-forward/src/a.ts', q: '  src/  ' });
    expect(listing?.rows.map((row) => row.id)).toEqual(['code.file:shop-forward/src/nested/b.ts']);
    expect(listing?.next).toBeNull();
    expect(asked).toEqual([{ after: 'code.file:shop-forward/src/a.ts', prefix: 'src/' }]);
  });

  test('the kind\'s count is the graph\'s count of its files, in the summary the navigation and the listing read', async () => {
    const summaries = await kindSummaries(context([], [], 7));
    expect(summaries.find((summary) => summary.kind === 'code.file')?.count).toBe(7);
  });
});
