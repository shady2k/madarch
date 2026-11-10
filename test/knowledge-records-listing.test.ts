/**
 * The kind `code.file` over the store's records (madarch-8bdc.2.5): the listing and the count a page reads when the
 * fill published the repository's paths into the record tables rather than into versions of the temporal graph.
 *
 * The store is stubbed here — the mapping from a page of the store's files to the rows a reader follows, and from one
 * file's facts to the page that states them, are what this file pins down; `test/knowledge-fill-process.test.ts` reads
 * the same listing and the same pages from a store a fill wrote.
 */
import { describe, expect, test } from 'bun:test';
import { kindSummaries, listEntities } from '../src/knowledge/render.js';
import type { RenderContext } from '../src/knowledge/blocks.js';
import type { KindsManifest } from '../src/knowledge/kinds.js';

const decl = (name: string): KindsManifest['kinds'] extends ReadonlyMap<string, infer Decl> ? Decl : never => ({ name, source: 'graph' } as never);

/** The smallest context a listing of `code.file` reads: the manifest declaring the kind, and the store's records. */
function context(files: { total: number; rows: readonly { path: string; repository: string }[]; next: string | null }, asked: { after?: string; prefix?: string }[], source?: (repo: string | null, path: string) => Promise<string | undefined>, details?: readonly string[], properties: ReadonlyMap<string, unknown> = new Map()): RenderContext {
  return {
    productFolder: '/nowhere',
    manifest: { file: 'madarch/kinds.yaml', roles: new Map(), properties, kinds: new Map([['code.file', { ...decl('code.file'), ...(details === undefined ? {} : { details }) }]]), declaredTemplates: [], groups: new Map(), excludeDocuments: [], ignoreBlocks: [], findings: [] } as unknown as KindsManifest,
    graph: { kindCounts: async () => [], list: async () => ({ rows: [], next: null, total: 0 }) } as unknown as RenderContext['graph'],
    markdown: new Map(),
    language: 'en',
    
    repositories: ['shop-forward'],
    webOf: () => undefined,
    commitOf: () => null,
    resolver: {} as RenderContext['resolver'],
    repoOfScope: () => undefined,
    readSource: source ?? (async () => undefined),
    records: {
      files: {
        count: async () => files.total,
        page: async (options) => { asked.push({ ...(options.after === undefined ? {} : { after: options.after }), ...(options.prefix === undefined ? {} : { prefix: options.prefix }) }); return files; },
      },
    },
  };
}



describe('the kind code.file over the store’s records', () => {
  test('the listing answers the files the store holds, each linking to the repository’s file page', async () => {
    const asked: { after?: string; prefix?: string }[] = [];
    const listing = await listEntities(context({ total: 2, rows: [{ path: 'src/a.ts', repository: 'shop-forward' }, { path: 'src/nested/b.ts', repository: 'shop-forward' }], next: null }, asked), 'code.file', { limit: 100 });
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
    // The page is the store's own: the cursor it was asked for, and no filter when the reader typed none.
    expect(asked).toEqual([{}]);
  });

  test('the listing asks the store for the page the reader is on, and for its filter as a path prefix', async () => {
    const asked: { after?: string; prefix?: string }[] = [];
    const listing = await listEntities(context({ total: 1, rows: [{ path: 'src/a.ts', repository: 'shop-forward' }], next: 'src/a.ts' }, asked), 'code.file', { limit: 1, after: 'src/a.ts', q: '  src/  ' });
    expect(listing?.next).toBe('src/a.ts');
    expect(asked).toEqual([{ after: 'src/a.ts', prefix: 'src/' }]);
  });

  test('the kind’s count is the store’s count of its files, in the summary the navigation and the listing read', async () => {
    const summaries = await kindSummaries(context({ total: 7, rows: [], next: null }, [] ));
    expect(summaries.find((summary) => summary.kind === 'code.file')?.count).toBe(7);
  });

  test('a store that answers no records leaves the listing to the graph', async () => {
    const bare = context({ total: 0, rows: [], next: null }, []);
    const withoutRecords = { ...bare, records: undefined } as RenderContext;
    const listing = await listEntities(withoutRecords, 'code.file', { limit: 100 });
    expect(listing?.total).toBe(0);
    expect(listing?.rows).toEqual([]);
  });
});


describe('the page of one file the store holds', () => {
  
  
  });
