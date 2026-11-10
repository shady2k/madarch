/**
 * The Files page's read (madarch-j9ao.1): the repository map and the file table,
 * read from the graph alone. Every file's size, language, heat, last change and
 * authors come from the file row and the history's touched edges; a map that cuts
 * its files says how many it left out, and a block the template wrote wrong is a
 * problem naming the template's file and line.
 */
import { expect, test } from 'bun:test';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import type { RenderContext, Subject } from '../src/knowledge/blocks.js';
import { filesBlock, treemapBlock } from '../src/knowledge/diagrams.js';
import { readFilesMap } from '../src/knowledge/files-map.js';
import { GraphReader, type FileRhythm, type GraphEntity } from '../src/knowledge/graph-read.js';
import type { Block } from '../src/knowledge/model.js';
import { Resolver } from '../src/knowledge/resolve.js';
import { byCodePoint } from '../src/model/order.js';

const unusedOwner: DatabaseOwner = {
  location: 'unused Files fixture', ready: Promise.resolve(), allowConcurrentSnapshots: false,
  hasVector: false,
  transaction: async () => { throw new Error('the Files fixture must not query SQL'); },
  run: async () => { throw new Error('the Files fixture must not query SQL'); },
  exec: async () => { throw new Error('the Files fixture must not query SQL'); }, close: async () => {},
};

const SCOPE = '42';
const REPO = 'shop';

/** The graph the block reads: the file rows it holds and the rhythms its one bounded read answers. */
class FixtureReader extends GraphReader {
  constructor(readonly rows: GraphEntity[], readonly rhythms: ReadonlyMap<string, FileRhythm> = new Map()) {
    super(unusedOwner, () => '2026-11-10T00:00:00Z');
  }
  /** The repository's files, as the one storage read answers them: the path prefix filters, the cursor pages. */
  override async files(repository: string, options: { prefix?: string; language?: string; after?: string; limit: number }) {
    const rows = this.rows
      .filter((entity) => entity.properties['repository'] === repository)
      .filter((entity) => options.prefix === undefined || String(entity.properties['path'] ?? '').startsWith(options.prefix))
      .sort((left, right) => byCodePoint(String(left.properties['path']), String(right.properties['path'])))
      .filter((entity) => options.after === undefined || String(entity.properties['path']) > options.after)
      .map((entity) => ({
        path: String(entity.properties['path']), mode: null, blob: null, form: 'text' as const,
        bytes: entity.properties['bytes'] as number, lines: entity.properties['lines'] as number,
        language: (entity.properties['language'] as string | undefined) ?? null,
        candidates: entity.properties['candidates'] as readonly string[],
      }));
    const shown = rows.slice(0, options.limit);
    return { rows: shown, next: rows.length > options.limit ? shown[shown.length - 1]!.path : null };
  }

  /** The repository's own counts, as the repository block reads them: the map's total comes from here. */
  override async repository(name: string) {
    return { name, counts: { files: this.rows.filter((entity) => entity.properties['repository'] === name).length, commits: 0, folders: 0 } } as never;
  }
  override async fileRhythm(_repository: string, _windows: { d30: string; d90: string; d365: string }): Promise<Map<string, FileRhythm>> {
    return new Map(this.rhythms);
  }
}

type FileFacts = { lines?: number | null; bytes?: number | null; language?: string | null; candidates?: string[] };

const fileRow = (path: string, facts: FileFacts = {}): GraphEntity => ({
  key: `code.file:${REPO}/${path}`,
  kind: 'code.file',
  label: path,
  properties: {
    repository: REPO, path,
    ...(facts.lines === undefined ? {} : { lines: facts.lines }),
    ...(facts.bytes === undefined ? { bytes: 100 } : { bytes: facts.bytes }),
    ...(facts.language === undefined ? {} : { language: facts.language }),
    candidates: facts.candidates ?? (typeof facts.language === 'string' ? [facts.language] : []),
  },
  nodeIds: [],
  scope: SCOPE,
  span: { path, lineStart: 1, lineEnd: 2, byteStart: 0, byteEnd: 10 },
});

const DAY = 86_400_000;
const NOW = new Date('2026-11-10T00:00:00Z');
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString();

const repository: GraphEntity = { key: `code.repository:${REPO}`, kind: 'code.repository', label: REPO, properties: { name: REPO }, nodeIds: [SCOPE], scope: SCOPE };
const subject: Subject = { source: 'graph', entity: repository };

function fixture(files: GraphEntity[], rhythms: ReadonlyMap<string, FileRhythm> = new Map()): RenderContext {
  const reader = new FixtureReader(files, rhythms);
  return {
    productFolder: '',
    manifest: { file: 'madarch/kinds.yaml', roles: new Map(), properties: new Map(), kinds: new Map(), groups: new Map(), excludeDocuments: [], ignoreBlocks: [], findings: [] },
    graph: reader,
    markdown: new Map(),
    language: 'en',
    repositories: [REPO],
    commitOf: () => null,
    repoOfScope: () => REPO,
    readSource: async () => undefined,
    resolver: new Resolver({ graph: reader, markdown: new Map(), declared: () => false, readDocument: async () => undefined, repositories: () => [], locate: () => undefined }),
  };
}

const treemapOf = async (ctx: RenderContext, params: Record<string, string> = {}, subjectOf: Subject = subject): Promise<Extract<Block, { type: 'treemap' }>> => {
  const block = await treemapBlock(ctx, subjectOf, params, 'templates/repository.liquid', 7);
  if (block.type !== 'treemap') throw new Error(`the block asked for came back as ${block.type}: ${JSON.stringify(block)}`);
  return block;
};

const problemOf = async (ctx: RenderContext, params: Record<string, string>, subjectOf: Subject = subject): Promise<Extract<Block, { type: 'problem' }>> => {
  const block = await treemapBlock(ctx, subjectOf, params, 'templates/repository.liquid', 7);
  if (block.type !== 'problem') throw new Error(`the block asked for came back as ${block.type}`);
  return block;
};

test('the totals count what the graph holds: files, lines, bytes and the languages the claims accept', async () => {
  const ctx = fixture([
    fileRow('src/a.ts', { lines: 100, bytes: 900, language: 'TypeScript' }),
    fileRow('src/b.ts', { lines: 50, bytes: 400, language: 'TypeScript' }),
    fileRow('README.md', { lines: 20, bytes: 200, language: 'Markdown' }),
    fileRow('package.json', { lines: 30, bytes: 300, language: null, candidates: ['JSON', 'OASv3-json'] }),
    fileRow('logo.png', { lines: null, bytes: 5000, language: null, candidates: [] }),
  ]);
  const block = await treemapOf(ctx);
  expect(block.data.totals.files).toBe(5);
  expect(block.data.totals.lines).toBe(200);
  expect(block.data.totals.bytes).toBe(6800);
  expect(block.data.totals.withoutLines).toBe(1);
  expect(block.data.totals.ambiguous).toBe(1);
  expect(block.data.totals.other).toBe(1);
  expect(block.data.totals.languages).toEqual([
    { name: 'TypeScript', files: 2, lines: 150, bytes: 1300 },
    { name: 'Markdown', files: 1, lines: 20, bytes: 200 },
  ]);
  // A file with no line count is still a row and still counted, drawn with no area.
  expect(block.data.files.map((file) => file.path)).toEqual(['README.md', 'logo.png', 'package.json', 'src/a.ts', 'src/b.ts']);
  expect(block.notes.some((note) => note.includes('no line count'))).toBe(true);
});

test('the heat of a file is the commits that touched it in each window, and its authors are distinct', async () => {
  const files = [fileRow('src/a.ts', { lines: 10, language: 'TypeScript' })];
  const rhythms = new Map<string, FileRhythm>([
    ['src/a.ts', { path: 'src/a.ts', d30: 2, d90: 3, d365: 4, all: 5, last: daysAgo(5), authors: ['Ada', 'Grace', 'Linus'] }],
  ]);
  const ctx = fixture(files, rhythms);
  const map = await readFilesMap(ctx, subject, { limit: 100, now: new Date('2026-11-10T00:00:00Z') });
  const file = map.files[0]!;
  expect(file.heat).toEqual([2, 3, 4, 5]);
  expect(file.last).toBe(daysAgo(5));
  expect(file.authors).toEqual(['Ada', 'Grace', 'Linus']);
});

test('a map cut by its limit says how many files it left out, and the table reads the same cut', async () => {
  const files = [fileRow('a.ts', { lines: 1 }), fileRow('b.ts', { lines: 2 }), fileRow('c.ts', { lines: 3 })];
  const ctx = fixture(files);
  const block = await treemapOf(ctx, { limit: '2' });
  expect(block.data.files.map((file) => file.path)).toEqual(['a.ts', 'b.ts']);
  expect(block.data.graphTotal).toBe(3);
  expect(block.notes[0]).toBe('Showing 2 of 3 files: the rest were not read (the block\'s limit).');
  const table = await filesBlock(ctx, subject, { limit: '2' }, 'templates/repository.liquid', 9);
  if (table.type !== 'files') throw new Error(`the table came back as ${table.type}`);
  expect(table.data.files).toHaveLength(2);
  expect(table.pageSize).toBe(50);
});

test('a directory page maps its own folder and the table agrees', async () => {
  const ctx = fixture([fileRow('src/a.ts', { lines: 1 }), fileRow('src/deep/b.ts', { lines: 2 }), fileRow('docs/readme.md', { lines: 3 })]);
  const directory: Subject = {
    source: 'graph',
    entity: { key: `code.directory:${REPO}/src`, kind: 'code.directory', label: 'src', properties: { repository: REPO, path: 'src' }, nodeIds: [], scope: SCOPE },
  };
  const block = await treemapOf(ctx, {}, directory);
  expect(block.data.folder).toBe('src');
  expect(block.data.files.map((file) => file.path)).toEqual(['src/a.ts', 'src/deep/b.ts']);
  expect(block.data.totals.files).toBe(2);
});

test('the area, colour and window switches reach the block, and the Mermaid picture is built beside them', async () => {
  const ctx = fixture([fileRow('src/a.ts', { lines: 100, bytes: 500, language: 'TypeScript' })]);
  const block = await treemapOf(ctx, { area: 'bytes', colour: 'heat', window: '30d', engine: 'mermaid' });
  expect(block.area).toBe('bytes');
  expect(block.colour).toBe('heat');
  expect(block.window).toBe('30d');
  expect(block.engine).toBe('mermaid');
  expect(block.mermaid).toContain('treemap');
  expect(block.mermaid).toContain('"a.ts": 500');
});

test('a block the template wrote wrong is a problem naming the template file and line', async () => {
  const ctx = fixture([fileRow('a.ts', { lines: 1 })]);
  const unknown = await problemOf(ctx, { rows: '10' });
  expect(unknown).toMatchObject({ block: 'treemap', file: 'templates/repository.liquid', line: 7 });
  expect(unknown.message).toContain('"rows" is not a parameter of the treemap block');
  const area = await problemOf(ctx, { area: 'size' });
  expect(area.message).toContain('"area" is "size"');
  const colour = await problemOf(ctx, { colour: 'health' });
  expect(colour.message).toContain('"colour" is "health"');
  const window = await problemOf(ctx, { window: 'yesterday' });
  expect(window.message).toContain('"window" is "yesterday"');
  const engine = await problemOf(ctx, { engine: 'likec4' });
  expect(engine.message).toContain('cannot be drawn by likec4: it is drawn by echarts or mermaid');
  const archify = await problemOf(ctx, { engine: 'archify' });
  expect(archify.message).toContain('cannot be drawn by archify');
});

test('the manifest\'s own diagram setting opens the map on the engine that can draw it', async () => {
  const files = [fileRow('a.ts', { lines: 1 })];
  const mermaid = fixture(files);
  const block = await treemapOf({ ...mermaid, manifest: { ...mermaid.manifest, diagram: 'mermaid' } });
  expect(block.engine).toBe('mermaid');
  // A setting the drawn views alone can honour never breaks the map: it opens on ECharts.
  const likec4 = fixture(files);
  const drawn = await treemapBlock({ ...likec4, manifest: { ...likec4.manifest, diagram: 'likec4' } }, subject, {}, 'templates/repository.liquid', 3);
  if (drawn.type !== 'treemap') throw new Error(`the map came back as ${drawn.type}`);
  expect(drawn.engine).toBe('echarts');
});
