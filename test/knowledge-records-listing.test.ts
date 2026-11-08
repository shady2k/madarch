/**
 * The kind `code.file` over the store's records (madarch-8bdc.2.5): the listing and the count a page reads when the
 * fill published the repository's paths into the record tables rather than into versions of the temporal graph.
 *
 * The store is stubbed here — the mapping from a page of the store's files to the rows a reader follows, and from one
 * file's facts to the page that states them, are what this file pins down; `test/knowledge-fill-process.test.ts` reads
 * the same listing and the same pages from a store a fill wrote.
 */
import { describe, expect, test } from 'bun:test';
import { kindSummaries, listEntities, recordFilePage } from '../src/knowledge/render.js';
import type { RenderContext } from '../src/knowledge/blocks.js';
import type { KindsManifest } from '../src/knowledge/kinds.js';
import type { FilePageFacts } from '../src/knowledge/repository-view.js';

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

const factsOf = (over: Partial<FilePageFacts> = {}): FilePageFacts => ({
  repository: 'shop-forward', asIsCommit: 'a'.repeat(40), path: 'src/a.ts', mode: '100644', blob: 'b'.repeat(40),
  bytes: 21, lines: 1, form: 'text', language: 'typescript', candidates: ['typescript'],
  created: { date: '2026-01-01T00:00:00Z', commit: 'c'.repeat(40), author: 'Ada' },
  modified: { date: '2026-01-02T00:00:00Z', commit: 'd'.repeat(40), author: 'Ada' },
  commitCount: 2, authors: ['Ada', 'Bob'], ...over,
});

describe('the kind code.file over the store’s records', () => {
  test('the listing answers the files the store holds, each linking to the repository’s file page', async () => {
    const asked: { after?: string; prefix?: string }[] = [];
    const listing = await listEntities(context({ total: 2, rows: [{ path: 'src/a.ts', repository: 'shop-forward' }, { path: 'src/nested/b.ts', repository: 'shop-forward' }], next: null }, asked), 'code.file', { limit: 100 });
    expect(listing?.total).toBe(2);
    expect(listing?.rows).toEqual([
      {
        id: 'code.file:src/a.ts', kind: 'code.file', label: 'src/a.ts', href: '/k/file?path=src%2Fa.ts',
        location: { repo: 'shop-forward', path: 'src/a.ts', lineStart: 1, lineEnd: 1, href: `/k/src?repo=shop-forward&path=src%2Fa.ts&line=1` },
      },
      {
        id: 'code.file:src/nested/b.ts', kind: 'code.file', label: 'src/nested/b.ts', href: '/k/file?path=src%2Fnested%2Fb.ts',
        location: { repo: 'shop-forward', path: 'src/nested/b.ts', lineStart: 1, lineEnd: 1, href: `/k/src?repo=shop-forward&path=src%2Fnested%2Fb.ts&line=1` },
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

/** The manifest's property declarations for the names given, as the starter set declares them: labels per language. */
const labels = (...names: readonly string[]): ReadonlyMap<string, unknown> => new Map(names.map((name) => [name, { labels: { en: `en:${name}`, ru: `ru:${name}` }, format: name === 'authors' ? 'list' : 'number' }]));

describe('the page of one file the store holds', () => {
  test('states the properties the manifest declares for the kind, in the manifest’s words, from the store’s facts', async () => {
    const ask = context({ total: 1, rows: [], next: null }, [], async () => 'export const a = 1;\n', ['lines', 'commitCount', 'authors'], labels('lines', 'commitCount', 'authors'));
    const page = await recordFilePage(ask, factsOf(), 'code.file:src/a.ts', 'en');
    expect(page?.id).toBe('code.file:src/a.ts');
    expect(page?.kind).toBe('code.file');
    expect(page?.title).toBe('src/a.ts');
    const properties = page!.blocks[0]!;
    expect(properties.type).toBe('properties');
    expect(properties.type === 'properties' ? properties.rows : []).toEqual([
      { name: 'lines', value: '1', label: 'en:lines' },
      { name: 'commitCount', value: '2', label: 'en:commitCount' },
      { name: 'authors', value: 'Ada, Bob', label: 'en:authors' },
    ]);
    const source = page!.blocks[1]!;
    expect(source.type).toBe('source');
    // The source is the file at the as-is commit, and its place is the file.
    expect(source.type === 'source' ? source.text : '').toBe('export const a = 1;');
    expect(source.type === 'source' ? source.location.path : '').toBe('src/a.ts');
    expect(source.type === 'source' ? source.truncated : true).toBe(false);
  });

  test('answers the same page in the interface language it was asked in', async () => {
    const ask = context({ total: 1, rows: [], next: null }, [], async () => 'x\n', ['lines'], labels('lines'));
    const page = await recordFilePage(ask, factsOf(), 'code.file:src/a.ts', 'ru');
    const properties = page!.blocks[0]!;
    expect(properties.type === 'properties' ? properties.title : '').toBe('Сведения');
    expect(properties.type === 'properties' ? properties.rows.map((row) => row.label) : []).toEqual(['ru:lines']);
    const source = page!.blocks[1]!;
    expect(source.type === 'source' ? source.title : '').toBe('Исходный текст');
  });

  test('draws no source for a binary or a file the checkout cannot read, and none of a graph it does not hold', async () => {
    const binary = await recordFilePage(context({ total: 1, rows: [], next: null }, [], async () => undefined, ['lines', 'commitCount', 'authors'], labels('lines', 'commitCount', 'authors')), factsOf({ path: 'picture.bin', form: 'binary', lines: null, language: 'ambiguous' }), 'code.file:picture.bin', 'en');
    // The facts stand: a binary has its lines absent, and the page then draws its properties and no source.
    expect(binary?.blocks.map((block) => block.type)).toEqual(['properties']);
    const unreadable = await recordFilePage(context({ total: 1, rows: [], next: null }, [], async () => undefined, ['lines'], labels('lines')), factsOf(), 'code.file:src/a.ts', 'en');
    expect(unreadable?.blocks.map((block) => block.type)).toEqual(['properties']);
    // A manifest that does not declare the kind has no page for it, as it has none from the graph: the caller answers 404.
    const undeclared = { ...context({ total: 1, rows: [], next: null }, []), manifest: { ...context({ total: 1, rows: [], next: null }, []).manifest, kinds: new Map() } as unknown as KindsManifest };
    expect(await recordFilePage(undeclared, factsOf(), 'code.file:src/a.ts', 'en')).toBeUndefined();
  });
});
