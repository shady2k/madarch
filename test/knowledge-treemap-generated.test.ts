/**
 * The treemap draws what the graph says (madarch-mwhd.3). A file is left out only where the graph proves it is not code
 * anyone edits: the dependency extractor's `code.lockfile` node for that exact path, or the file's own `generated` fact.
 * Its size is the line count the tree lister files with it, never a guess, and only a row that carries no count
 * falls back to its bytes. No list of file names stands here. The graph-read boundary and the bytes read are doubled; the block is the
 * real one.
 */
import { expect, test } from 'bun:test';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import type { RenderContext, Subject } from '../src/knowledge/blocks.js';
import { treemapBlock } from '../src/knowledge/diagrams.js';
import { GraphReader, type GraphEntity } from '../src/knowledge/graph-read.js';
import type { Block } from '../src/knowledge/model.js';
import { byCodePoint } from '../src/model/order.js';
import { Resolver } from '../src/knowledge/resolve.js';

const unusedOwner: DatabaseOwner = {
  location: 'unused treemap fixture', ready: Promise.resolve(), allowConcurrentSnapshots: false,
  backend: 'pglite', hasVector: false,
  transaction: async () => { throw new Error('the treemap fixture must not query SQL'); },
  run: async () => { throw new Error('the treemap fixture must not query SQL'); },
  exec: async () => { throw new Error('the treemap fixture must not query SQL'); }, close: async () => {},
};

/** The graph-read boundary only: the rows a path-prefix read answers, the churn counts, and the prefix each read asked for. */
class FixtureReader extends GraphReader {
  readonly prefixes: string[] = [];
  readonly relations: string[] = [];
  constructor(readonly entities: GraphEntity[], readonly touched: ReadonlyMap<string, number> = new Map()) {
    super(unusedOwner, () => '2026-01-01T00:00:00Z');
  }
  override async byPrefix(kind: string, prefix: string, limit: number): Promise<{ total: number; rows: GraphEntity[] }> {
    this.prefixes.push(`${kind} ${prefix}`);
    // The real read answers the keys in code point order, and `limit` cuts that order.
    const rows = this.entities.filter((entity) => entity.kind === kind && entity.key.startsWith(prefix)).sort((a, b) => byCodePoint(a.key, b.key));
    return { rows: rows.slice(0, limit), total: rows.length };
  }
  override async inDegrees(relation: string, keys: readonly string[]): Promise<Map<string, number>> {
    this.relations.push(relation);
    return new Map<string, number>(keys.map((key): [string, number] => [key, this.touched.get(key) ?? 0]));
  }
}

const SCOPE = 'repo';
const REPO = 'catalog';

/** A `code.file` row as the tree lister files it: its path, the lines it holds, its span, and its declared facts. */
const fileRow = (path: string, facts: { lines?: number; generated?: unknown } = {}): GraphEntity => ({
  key: `code.file:${path}`,
  kind: 'code.file',
  label: path,
  properties: { path, ...(facts.lines === undefined ? {} : { lines: facts.lines }),
    ...(facts.generated === undefined ? {} : { generated: facts.generated }) },
  nodeIds: [],
  scope: SCOPE,
  span: { path, lineStart: 1, lineEnd: (facts.lines ?? 1) + 1, byteStart: 0, byteEnd: 0 },
});

/** A `code.lockfile` row as the dependency extractor files it: the node names the exact path it read. */
const lockRow = (path: string): GraphEntity => ({ key: `code.lockfile:${path}`, kind: 'code.lockfile', label: path, properties: { path }, nodeIds: [], scope: SCOPE });

const repository: GraphEntity = { key: `code.repository:${REPO}`, kind: 'code.repository', label: REPO, properties: {}, nodeIds: [], scope: SCOPE };
const subject: Subject = { source: 'graph', entity: repository };

interface Fixture {
  readonly reader: FixtureReader;
  readonly ctx: RenderContext;
  /** Every path the block asked the bytes for, in the order it asked. */
  readonly reads: string[];
}

const fixture = (rows: GraphEntity[], sources: ReadonlyMap<string, string> = new Map(), touched: ReadonlyMap<string, number> = new Map()): Fixture => {
  const reader = new FixtureReader([...rows], touched);
  const reads: string[] = [];
  const ctx: RenderContext = {
    productFolder: '',
    manifest: { file: '', roles: new Map(), properties: new Map(), kinds: new Map(), groups: new Map(), excludeDocuments: [], ignoreBlocks: [], findings: [] },
    graph: reader,
    markdown: new Map(),
    docEntities: new Map(),
    localizedSources: new Map(),
    language: 'en',
    documents: [],
    repositories: [REPO],
    commitOf: () => null,
    repoOfScope: () => REPO,
    readSource: async (_repo: string | null, path: string) => {
      reads.push(path);
      return sources.get(path);
    },
    resolver: new Resolver({ graph: reader, markdown: new Map(), declared: () => false, readDocument: async () => undefined, repositories: () => [], locate: () => undefined }),
  };
  return { reader, ctx, reads };
};

const treemapOf = async (f: Fixture, params: Readonly<Record<string, string>> = {}): Promise<Extract<Block, { type: 'treemap' }>> => {
  const block = await treemapBlock(f.ctx, subject, params);
  if (block.type !== 'treemap') throw new Error(`the block asked for came back as ${block.type}`);
  return block;
};

const drawn = (block: Extract<Block, { type: 'treemap' }>): string[] => block.files.map((file) => file.path);
const readsOf = (f: Fixture): string[] => [...f.reads].sort();

test('a file the repository declares generated or vendored is hidden by its own fact, and its bytes are never read', async () => {
  const f = fixture(
    [
      fileRow('catalog/reports/rows.ts', { lines: 42 }),
      fileRow('catalog/reports/generated-table.ts', { lines: 9000, generated: true }),
      fileRow('catalog/vendor/bundle.js', { lines: 500, generated: true }),
      // Only the fact `generated: true` hides a file: a repository that declares one not generated keeps it.
      fileRow('catalog/reports/kept.ts', { lines: 7, generated: false }),
    ],
    new Map<string, string>([['catalog/reports/generated-table.ts', 'a\nb\nc\n'], ['catalog/vendor/bundle.js', 'a\n']]),
    new Map<string, number>([['code.file:catalog/reports/rows.ts', 3]]),
  );
  const block = await treemapOf(f);
  expect(drawn(block)).toEqual(['catalog/reports/kept.ts', 'catalog/reports/rows.ts']);
  expect(block.files.find((file) => file.path === 'catalog/reports/rows.ts')).toMatchObject({ lines: 42, churn: 3 });
  expect(block.maxChurn).toBe(3);
  // The two hidden files have text behind them in the fixture; a read would show here.
  expect(readsOf(f)).toEqual([]);
  expect(block.notes).toEqual(['2 repository-declared generated or vendored files are not drawn.']);
  expect(block.total).toBe(4);
  expect(block.notes.join(' ')).not.toContain('generated-table');
  expect(f.reader.relations).toContain('code.touched');
});

test('a file whose name looks like a lock file is drawn when the graph holds no lock-file node for it: no list of names stands here', async () => {
  const paths = ['library/tools/package-lock.json', 'library/tools/npm-shrinkwrap.json', 'library/tools/yarn.lock', 'library/tools/pnpm-lock.yaml', 'library/tools/bun.lockb', 'library/tools/go.sum', 'library/tools/Cargo.lock', 'library/tools/poetry.lock', 'library/tools/composer.lock'];
  const f = fixture(paths.map((path) => fileRow(path, { lines: 11 })));
  const block = await treemapOf(f);
  expect(drawn(block)).toEqual([...paths].sort(byCodePoint));
  expect(block.files.every((file) => file.lines === 11)).toBe(true);
  expect(block.notes).toEqual([]);
  expect(block.notes.join(' ')).not.toContain('lock');
  // One question, at the scope's own prefix.
  expect(f.reader.prefixes).toEqual(['code.file code.file:', 'code.lockfile code.lockfile:']);
});

test('a lock-file node hides exactly the path it names, never a name or a folder', async () => {
  const f = fixture([
    fileRow('services/alpha/package-lock.json', { lines: 1100 }),
    fileRow('services/alpha/package-lock.json.bak', { lines: 8 }),
    fileRow('services/alpha/notes/package-lock.json', { lines: 5 }),
    fileRow('services/alpha/go.sum', { lines: 300 }),
    fileRow('services/beta/package-lock.json', { lines: 900 }),
    // A node the graph holds for a path the scope holds no file of hides nothing and counts nothing.
    lockRow('services/gamma/go.sum'),
    lockRow('services/alpha/package-lock.json'),
    lockRow('services/alpha/go.sum'),
  ]);
  const block = await treemapOf(f);
  expect(drawn(block)).toEqual(['services/alpha/notes/package-lock.json', 'services/alpha/package-lock.json.bak', 'services/beta/package-lock.json']);
  expect(block.total).toBe(5);
  expect(block.notes).toEqual(['2 lock files are not drawn.']);
  expect(readsOf(f)).toEqual([]);
  expect(block.notes.join(' ')).not.toContain('package-lock');
  expect(block.notes.join(' ')).not.toContain('go.sum');
});

test('a lock-file node in another folder hides nothing: the comparison is the whole path', async () => {
  const f = fixture([
    fileRow('services/beta/package-lock.json', { lines: 900 }),
    lockRow('services/alpha/package-lock.json'),
  ]);
  const block = await treemapOf(f);
  expect(drawn(block)).toEqual(['services/beta/package-lock.json']);
  expect(block.notes).toEqual([]);
});

test('the scope keeps the treemap to its folder, and the lock-file question is asked once for that scope', async () => {
  const f = fixture([
    fileRow('services/alpha/package-lock.json', { lines: 1100 }),
    fileRow('services/alpha/package-lock.json.bak', { lines: 8 }),
    fileRow('services/alpha/notes/package-lock.json', { lines: 5 }),
    fileRow('services/alpha/go.sum', { lines: 300 }),
    fileRow('services/beta/package-lock.json', { lines: 900 }),
    lockRow('services/alpha/package-lock.json'),
    lockRow('services/alpha/go.sum'),
    lockRow('services/beta/package-lock.json'),
  ]);
  const block = await treemapOf(f, { scope: 'services/alpha/' });
  expect(block.scope).toBe('services/alpha');
  expect(drawn(block)).toEqual(['services/alpha/notes/package-lock.json', 'services/alpha/package-lock.json.bak']);
  expect(block.total).toBe(4);
  expect(block.notes).toEqual(['2 lock files are not drawn.']);
  expect(f.reader.prefixes).toEqual(['code.file code.file:services/alpha/', 'code.lockfile code.lockfile:services/alpha/']);
});

test('the line count is the row\'s own fact, and a row that carries one costs no read', async () => {
  const f = fixture(
    [fileRow('catalog/large.ts', { lines: 1200 }), fileRow('catalog/small.ts', { lines: 2 }), fileRow('catalog/middle.ts', { lines: 15 })],
    new Map<string, string>([['catalog/large.ts', 'a\nb\nc\n'], ['catalog/small.ts', 'a\nb\nc\n'], ['catalog/middle.ts', '']]),
  );
  const block = await treemapOf(f);
  expect(block.files.map((file) => [file.path, file.lines])).toEqual([['catalog/large.ts', 1200], ['catalog/middle.ts', 15], ['catalog/small.ts', 2]]);
  expect(readsOf(f)).toEqual([]);
  expect(block.notes).toEqual([]);
});

test('a row with no count falls back to its bytes, and a file the bytes cannot answer for is said and not drawn', async () => {
  const f = fixture(
    [fileRow('catalog/known.ts', { lines: 9 }), fileRow('catalog/legacy.txt'), fileRow('catalog/missing.txt'), fileRow('catalog/empty.txt')],
    new Map<string, string>([['catalog/legacy.txt', 'one\ntwo\nthree\n'], ['catalog/empty.txt', '']]),
  );
  const block = await treemapOf(f);
  expect(block.files.map((file) => [file.path, file.lines])).toEqual([['catalog/empty.txt', 0], ['catalog/known.ts', 9], ['catalog/legacy.txt', 3]]);
  // Only the rows without a count were read: the one carrying its own count was not.
  expect(readsOf(f)).toEqual(['catalog/empty.txt', 'catalog/legacy.txt', 'catalog/missing.txt']);
  expect(block.notes).toEqual(['1 file was not readable at the commit the graph was filled from and is not drawn.']);
  expect(block.total).toBe(4);
});

test('the limit and the order keep their meaning: the first files by path, the count of the whole, the churn of the drawn ones', async () => {
  const paths = ['catalog/B.ts', 'catalog/a.ts', 'catalog/Z.ts', 'catalog/b.ts', 'catalog/A.ts', 'catalog/z.ts', 'catalog/file-1.ts', 'catalog/file-10.ts', 'catalog/file-2.ts', 'catalog/file-3.ts', 'catalog/file-4.ts', 'catalog/file-5.ts'];
  const touched = new Map<string, number>(paths.map((path, index): [string, number] => [`code.file:${path}`, index]));
  const f = fixture(paths.map((path) => fileRow(path, { lines: 4 })), new Map(), touched);
  const block = await treemapOf(f, { limit: '10' });
  // Code point order, not a locale's: the capitals first.
  expect(drawn(block)).toEqual(['catalog/A.ts', 'catalog/B.ts', 'catalog/Z.ts', 'catalog/a.ts', 'catalog/b.ts', 'catalog/file-1.ts', 'catalog/file-10.ts', 'catalog/file-2.ts', 'catalog/file-3.ts', 'catalog/file-4.ts']);
  expect(block.total).toBe(12);
  expect(block.notes).toEqual(['Showing the first 10 of 12 files by path.']);
  // file-5, the most changed file, is beyond the limit and does not set the scale.
  expect(block.maxChurn).toBe(10);
});

test('the note counts every reason the graph gives, names no pattern, and reads no hidden file', async () => {
  const f = fixture(
    [
      fileRow('catalog/package-lock.json', { lines: 500 }),
      fileRow('catalog/go.sum', { lines: 60 }),
      fileRow('catalog/table.ts', { lines: 700, generated: true }),
      fileRow('catalog/rows.ts', { lines: 400, generated: true }),
      fileRow('catalog/bundle.js', { lines: 900, generated: true }),
      fileRow('catalog/kept.ts', { lines: 5 }),
      fileRow('catalog/unreachable.ts'),
      lockRow('catalog/package-lock.json'),
      lockRow('catalog/go.sum'),
    ],
    new Map<string, string>([['catalog/package-lock.json', 'a\n'], ['catalog/go.sum', 'a\n'], ['catalog/table.ts', 'a\n']]),
  );
  const block = await treemapOf(f);
  expect(drawn(block)).toEqual(['catalog/kept.ts']);
  expect(readsOf(f)).toEqual(['catalog/unreachable.ts']);
  expect(block.notes).toEqual([
    '2 lock files and 3 repository-declared generated or vendored files are not drawn.',
    '1 file was not readable at the commit the graph was filled from and is not drawn.',
  ]);
  for (const name of ['package-lock', 'go.sum', 'bundle.js', 'table.ts']) expect(block.notes.join(' ')).not.toContain(name);
  expect(block.total).toBe(7);
});

test('a single hidden file of one reason is said in the singular', async () => {
  const lock = await treemapOf(fixture([fileRow('catalog/package-lock.json', { lines: 500 }), lockRow('catalog/package-lock.json'), fileRow('catalog/kept.ts', { lines: 5 })]));
  expect(lock.notes).toEqual(['1 lock file is not drawn.']);
  const declared = await treemapOf(fixture([fileRow('catalog/table.ts', { lines: 700, generated: true }), fileRow('catalog/kept.ts', { lines: 5 })]));
  expect(declared.notes).toEqual(['1 repository-declared generated or vendored file is not drawn.']);
});
