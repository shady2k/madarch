/**
 * The code pass (decision 0033's "The code pass", items 5 and 14 as amended
 * 2026-11-06): the mapping from the library's records to ours, the join of the
 * library's declarations to the published symbols by place, and one unit run
 * over a fixture the test commits itself — through the real library, so the
 * pipeline that writes a commit's tree out and reads the library's answer is
 * exercised and not mocked away.
 *
 * Every expectation comes from the decision and the library's own answers: an
 * interface-to-implementation link is an `implements` edge, a constructor call
 * is a call, an end no published record answers writes no edge, and a file no
 * per-file pass of ours reads gets the library's symbols as its records.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { createGitSnapshotSource } from '../src/fill/snapshot.js';
import { DEFAULT_STAGE_LIMITS, type StageContext, type StageDraftWrite, type StageUnit } from '../src/fill/stage.js';
import { createCodegraphStage, CODEGRAPH_PUBLISHED_READ, codegraphPublishedRows, treeUnitId } from '../src/fill/stages/codegraph.js';
import {
  codegraphJoin, EDGE_KINDS_OUT, EDGE_TIES, edgeWriteOf, gapsOf, NODE_KINDS_OUT, NODE_TIES, simpleNameOf,
  type LibraryEdge, type LibraryIndex, type LibraryNode, type LibraryRun, type PublishedSymbol,
} from '../src/fill/stages/codegraph-map.js';
import { moduleRootsOf } from '../src/fill/stages/codegraph-index.js';
import type { StaticGraphNode } from '../src/fill/stages/static-context.js';
import type { StaticEdgeDraft, StaticNodeDraft } from '../src/fill/stages/static-graph.js';

const REPOSITORY = 'orders-api';
const COMMIT = 'b'.repeat(40);

/** One library node of the test's making. */
function node(id: string, kind: string, filePath: string, startLine: number, name = id): LibraryNode {
  return { id, kind, name, qualifiedName: `${filePath}::${name}`, filePath, startLine, endLine: startLine, startColumn: 0, endColumn: 4 };
}

/** One library edge of the test's making. */
function edge(source: string, target: string, kind: string, metadata: Record<string, unknown> = {}, line = 1): LibraryEdge {
  return { source, target, kind, line, metadata };
}

/** One index run of the test's making. */
function run(root: string, nodes: readonly LibraryNode[], edges: readonly LibraryEdge[], module?: string): LibraryRun {
  return { root, module, nodes, edges, indexed: [], skipped: [], wallMs: 1, processPeakRssBytes: 1, libraryDurationMs: 1 };
}

/** One published symbol of the test's making. */
function symbol(file: string, qualifiedName: string, startLine: number, endLine = startLine): PublishedSymbol {
  return { key: `code.symbol:${file}#${qualifiedName}`, file, qualifiedName, startLine, endLine };
}

/** The join over one repository's runs and symbols, with every file readable by the per-file passes unless the test says otherwise. */
function joinedOf(index: LibraryIndex, published: readonly PublishedSymbol[], unreadable: readonly string[] = []) {
  return codegraphJoin({ repository: REPOSITORY, commit: COMMIT, index, published, readByFill: (path) => !unreadable.includes(path) });
}

const published = [symbol('src/a.ts', 'alpha', 1), symbol('src/a.ts', 'beta', 5, 9), symbol('src/b.ts', 'Gamma', 2)];

describe('the library vocabulary tied to ours', () => {
  test('the simple name of a qualified name is its last leg, under "." or "::"', () => {
    expect(['A.b', 'A::b', 'b', 'A.B.c'].map(simpleNameOf)).toEqual(['b', 'b', 'b', 'c']);
  });

  test('every node kind and every relation of the library is either tied or named as left out', () => {
    // The two tables together cover the library's own vocabulary: a kind that is neither
    // tied nor named would be dropped in silence, which is what the decision forbids.
    const tied = Object.keys(NODE_TIES);
    expect(Object.keys(EDGE_TIES)).toEqual(['calls', 'extends', 'implements', 'instantiates', 'references']);
    expect(EDGE_KINDS_OUT.map((entry) => entry.kind)).toEqual(['contains', 'decorates', 'exports', 'imports', 'navigates', 'overrides', 'returns', 'type_of']);
    expect(NODE_KINDS_OUT.map((entry) => entry.kind)).toEqual(['export', 'field', 'file', 'import', 'module', 'namespace', 'parameter', 'property', 'route']);
    expect([...tied, ...NODE_KINDS_OUT.map((entry) => entry.kind)].sort()).toEqual([
      'class', 'component', 'constant', 'enum', 'enum_member', 'export', 'field', 'file', 'function', 'import',
      'interface', 'method', 'module', 'namespace', 'parameter', 'property', 'protocol', 'route', 'struct',
      'trait', 'type_alias', 'union', 'variable',
    ]);
  });
});

describe('the join of the library per-file passes published', () => {
  test('a call joins both ends by place and carries the library mark it was obtained by', () => {
    // The line table of `src/a.ts`, in bytes: line 6 starts at byte 90 and line 7 at 110.
    const lines = new Map([['src/a.ts', [0, 10, 30, 50, 70, 90, 110, 130]]]);
    const joined = joinedOf(
      { runs: [run('', [node('n1', 'function', 'src/a.ts', 1, 'alpha'), node('n2', 'function', 'src/a.ts', 5, 'beta')], [edge('n1', 'n2', 'calls', { resolvedBy: 'exact-match', confidence: 0.9 }, 6)])], moduleRoots: [''], lines, wallMs: 1, processPeakRssBytes: 1 },
      published,
    );
    expect(joined.edges).toEqual([{
      relation: 'code.calls', factKind: 'call', from: 'code.symbol:src/a.ts#alpha', to: 'code.symbol:src/a.ts#beta',
      libraryKind: 'calls', marks: [{ resolvedBy: 'exact-match', confidence: 0.9, count: 1 }], count: 1,
      resolvedBy: 'exact-match', confidence: 0.9, line: 6,
      // The library names the call's line; the file the fill wrote out turns it into a span.
      place: { file: 'src/a.ts', line: 6, startByte: 90, endByte: 110 },
    }]);
    // What the served tools read as the call's site (src/knowledge/graph-read.ts, `spanFromProvenance`).
    const write = edgeWriteOf(joined.edges[0]!, REPOSITORY, COMMIT, 'evidence');
    const provenance = (write.value as StaticEdgeDraft).properties!['provenance'] as Record<string, unknown>;
    expect(provenance['place']).toEqual({ file: 'src/a.ts', range: { startLine: 6, startColumn: 0, endLine: 6, endColumn: 0, startByte: 90, endByte: 110 } });
    expect(joined.nodes).toEqual([]);
  }, 30_000);

  test('a constructor call is a call, an interface-to-implementation link is an implements edge, and an extends is an inheritance', () => {
    const joined = joinedOf(
      {
        runs: [run('', [
          node('a', 'function', 'src/a.ts', 1, 'alpha'),
          node('b', 'class', 'src/b.ts', 2, 'Gamma'),
          node('c', 'interface', 'src/b.ts', 8, 'Shape'),
          node('d', 'class', 'src/b.ts', 20, 'Square'),
        ], [
          edge('a', 'b', 'instantiates', { resolvedBy: 'import', confidence: 0.9 }),
          edge('a', 'c', 'calls', { synthesizedBy: 'interface-impl' }),
          edge('d', 'c', 'implements', { resolvedBy: 'exact-match', confidence: 0.9 }),
          edge('d', 'b', 'extends', { resolvedBy: 'exact-match', confidence: 0.9 }),
        ])],
        moduleRoots: [''], lines: new Map(), wallMs: 1, processPeakRssBytes: 1,
      },
      [...published, symbol('src/b.ts', 'Shape', 8), symbol('src/b.ts', 'Square', 20)],
    );
    expect(joined.edges.map((held) => [held.relation, held.libraryKind, held.factKind, held.form ?? '', held.resolvedBy])).toEqual([
      ['code.calls', 'instantiates', 'call', '', 'import'],
      ['code.implements', 'calls', 'inherits', 'implements', 'synthesized'],
      ['code.implements', 'implements', 'inherits', 'implements', 'exact-match'],
      ['code.inherits', 'extends', 'inherits', 'extends', 'exact-match'],
    ]);
  }, 30_000);

  test('an end no published record answers writes no edge, and the gap names how many', () => {
    const joined = joinedOf(
      { runs: [run('', [node('a', 'function', 'src/a.ts', 1, 'alpha'), node('p', 'property', 'src/a.ts', 12, 'x')], [edge('a', 'p', 'calls', { resolvedBy: 'exact-match', confidence: 0.9 })])], moduleRoots: [''], lines: new Map(), wallMs: 1, processPeakRssBytes: 1 },
      published,
    );
    expect(joined.edges).toEqual([]);
    expect(joined.left).toEqual([{ what: 'calls left without an end: the target is no record of ours', count: 1 }]);
    expect(gapsOf({ runs: [], moduleRoots: [''], lines: new Map(), wallMs: 1, processPeakRssBytes: 1 }, joined)).toEqual([{ what: 'calls left without an end: the target is no record of ours (1)', reason: 'unsupported' }]);
  }, 30_000);

  test('a symbol of a file no per-file pass of ours reads becomes a record of ours', () => {
    const joined = joinedOf(
      { runs: [run('', [node('m', 'function', 'src/app.py', 3, 'handler')], [])], moduleRoots: [''], lines: new Map(), wallMs: 1, processPeakRssBytes: 1 },
      published,
      ['src/app.py'],
    );
    expect(joined.nodes).toHaveLength(1);
    const held = joined.nodes[0]!;
    expect(held.key).toBe('code.symbol:src/app.py#handler');
    expect(held.kind).toBe('code.symbol');
    const properties = held.properties as Record<string, unknown>;
    expect([properties['file'], properties['qualifiedName'], properties['symbolKind'], properties['globalName'], properties['factKind']]).toEqual(['src/app.py', 'handler', 'function', `${REPOSITORY}:src/app.py#handler`, 'symbol']);
    // Not a file the per-file pass can read, so no unresolved declaration is counted for it.
    expect(joined.symbolsUnresolved).toBe(0);
  }, 30_000);

  test('one source per file: a file a module root holds is taken from that root alone', () => {
    const joined = joinedOf(
      {
        runs: [
          run('', [node('root', 'function', 'services/orders/handler.go', 4, 'Serve'), node('outside', 'function', 'cmd/main.go', 3, 'main', )], []),
          run('services/orders', [node('module', 'function', 'handler.go', 4, 'Serve')], []),
        ],
        moduleRoots: ['', 'services/orders'], lines: new Map(), wallMs: 1, processPeakRssBytes: 1,
      },
      [],
      ['cmd/main.go', 'services/orders/handler.go', 'src/a.ts'],
    );
    // Both runs name the same declaration; only the module's run is its source.
    expect(joined.nodes.map((held) => held.key)).toEqual(['code.symbol:cmd/main.go#main', 'code.symbol:services/orders/handler.go#Serve']);
  }, 30_000);

  test('an edge of two marks keeps both, and the strongest names the edge', () => {
    const joined = joinedOf(
      { runs: [run('', [node('a', 'function', 'src/a.ts', 1, 'alpha'), node('b', 'function', 'src/a.ts', 5, 'beta')], [
        edge('a', 'b', 'calls', { resolvedBy: 'instance-method', confidence: 0.7 }),
        edge('a', 'b', 'calls', { resolvedBy: 'exact-match', confidence: 0.9 }),
      ])], moduleRoots: [''], lines: new Map(), wallMs: 1, processPeakRssBytes: 1 },
      published,
    );
    expect(joined.edges).toHaveLength(1);
    expect(joined.edges[0]).toMatchObject({ count: 2, resolvedBy: 'exact-match', confidence: 0.9 });
    expect(joined.edges[0]!.marks).toEqual([
      { resolvedBy: 'exact-match', confidence: 0.9, count: 1 },
      { resolvedBy: 'instance-method', confidence: 0.7, count: 1 },
    ]);
  }, 30_000);

  test('the edge draft carries the mark as properties, and its provenance names the pass', () => {
    const write = edgeWriteOf({
      relation: 'code.calls', factKind: 'call', from: 'code.symbol:src/a.ts#alpha', to: 'code.symbol:src/a.ts#beta',
      libraryKind: 'instantiates', marks: [{ resolvedBy: 'import', confidence: 0.9, count: 2 }], count: 2,
      resolvedBy: 'import', confidence: 0.9, line: 7, place: undefined,
    }, REPOSITORY, COMMIT, 'evidence');
    expect(write.kind).toBe('edge');
    const value = write.value as StaticEdgeDraft;
    expect(value.from).toEqual({ key: 'code.symbol:src/a.ts#alpha' });
    expect([value.properties!['resolvedBy'], value.properties!['confidence'], value.properties!['count'], value.properties!['libraryKind'], value.properties!['line']]).toEqual(['import', 0.9, 2, 'instantiates', 7]);
    expect((value.properties!['provenance'] as Record<string, unknown>)['pass']).toBe('codegraph');
  }, 30_000);
});

describe('one unit over a fixture the test commits', () => {
  test('the tree is written out, the library indexes it, and the call between two published symbols is published', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'madarch-codegraph-'));
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    try {
      git('init', '-q');
      git('config', 'user.name', 'Fixture');
      git('config', 'user.email', 'fixture@example.invalid');
      mkdirSync(pathJoin(root, 'src'), { recursive: true });
      writeFileSync(pathJoin(root, 'src', 'total.ts'), 'export function total(): number {\n  return 42;\n}\n');
      writeFileSync(pathJoin(root, 'src', 'order.ts'), "import { total } from './total.js';\n\nexport function checkout(): number {\n  return total();\n}\n");
      writeFileSync(pathJoin(root, 'NOTES.md'), '# Notes\n');
      git('add', '-A');
      git('commit', '-qm', 'one');
      const commit = git('rev-parse', 'HEAD').trim();
      const source = createGitSnapshotSource([{ id: REPOSITORY, form: 'code', root, commit }]);
      const stage = createCodegraphStage(source);
      const unit: StageUnit = { id: treeUnitId(REPOSITORY), scope: REPOSITORY };
      const plan = await stage.plan({ query: async () => [] });
      expect(plan.units).toEqual([{ id: treeUnitId(REPOSITORY), scope: REPOSITORY }]);
      const symbols: readonly PublishedSymbol[] = [symbol('src/order.ts', 'checkout', 3, 5), symbol('src/total.ts', 'total', 1, 3)];
      const writes: StageDraftWrite[] = [];
      const notes: string[] = [];
      const context = {
        unit,
        config: { id: 'codegraph', version: 1, enabled: true, concurrency: 1, limits: DEFAULT_STAGE_LIMITS, config: {} },
        graph: { query: async () => [] },
        static: {
          repository: { repository: REPOSITORY, commit, source: { system: 'git', version: '2' }, form: 'code' },
          byKey: async () => [],
          byGlobalName: async () => [],
          neighbourhood: async () => ({ rows: [], next: null }),
          byProperty: async (kind: string) => ({
            rows: kind === 'code.symbol' ? symbols.map((held, index): StaticGraphNode => ({
              id: `n${String(index)}`, kind: 'code.symbol', label: held.qualifiedName,
              properties: { repository: REPOSITORY, file: held.file, qualifiedName: held.qualifiedName, recordKey: held.key, provenance: { source: { system: 'tree-sitter', version: '1' }, repository: { id: REPOSITORY, commit }, place: { file: held.file, range: { startLine: held.startLine, startColumn: 0, endLine: held.endLine, endColumn: 1 } } } },
              producer: 'fill.syntax', scope: '0',
            })) : [],
            next: null,
          }),
          edgesByProperty: async () => ({ rows: [], next: null }),
        },
        draft: { write: (entry: StageDraftWrite) => { writes.push(entry); }, writes: () => ({ writes }) },
        progress: (note: string) => { notes.push(note); },
        signal: new AbortController().signal,
      } as unknown as StageContext;
      expect(await stage.execute(unit, context)).toEqual({ outcome: 'draft' });
      expect(await stage.validate({ writes }, { query: async () => [] })).toEqual({ ok: true });
      const edges = writes.filter((write) => write.kind === 'edge').map((write) => write.value as StaticEdgeDraft);
      const calls = edges.filter((held) => held.relation === 'code.calls');
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.some((held) => (held.from as { key: string }).key === 'code.symbol:src/order.ts#checkout' && (held.to as { key: string }).key === 'code.symbol:src/total.ts#total')).toBe(true);
      const coverage = writes.filter((write) => write.kind === 'node').map((write) => write.value as StaticNodeDraft).filter((held) => held.properties['factKind'] === 'coverage');
      expect(coverage).toHaveLength(1);
      const measurement = coverage[0]!.properties['measurement'] as Record<string, unknown>;
      expect(measurement['moduleRoots']).toEqual(['']);
      expect(measurement['linkedEdges']).toBe(edges.length);
      expect(Number(measurement['processPeakRssBytes'])).toBeGreaterThan(0);
      expect((measurement['runs'] as readonly Record<string, unknown>[])[0]!['indexed']).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  test('a Go call across packages resolves when the module is indexed as its own root', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'madarch-codegraph-go-call-'));
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    try {
      git('init', '-q');
      git('config', 'user.name', 'Fixture');
      git('config', 'user.email', 'fixture@example.invalid');
      mkdirSync(pathJoin(root, 'services', 'orders', 'store'), { recursive: true });
      writeFileSync(pathJoin(root, 'services', 'orders', 'go.mod'), 'module example/orders\n\ngo 1.22\n');
      writeFileSync(pathJoin(root, 'services', 'orders', 'main.go'), 'package main\n\nimport "example/orders/store"\n\nfunc run() {\n\tstore.Open()\n}\n');
      writeFileSync(pathJoin(root, 'services', 'orders', 'store', 'store.go'), 'package store\n\nfunc Open() {}\n');
      git('add', '-A');
      git('commit', '-qm', 'one');
      const commit = git('rev-parse', 'HEAD').trim();
      const source = createGitSnapshotSource([{ id: REPOSITORY, form: 'code', root, commit }]);
      const stage = createCodegraphStage(source);
      const unit: StageUnit = { id: treeUnitId(REPOSITORY), scope: REPOSITORY };
      const symbols: readonly PublishedSymbol[] = [symbol('services/orders/main.go', 'run', 5, 7), symbol('services/orders/store/store.go', 'Open', 3, 3)];
      const writes: StageDraftWrite[] = [];
      const context = {
        unit,
        config: { id: 'codegraph', version: 1, enabled: true, concurrency: 1, limits: DEFAULT_STAGE_LIMITS, config: {} },
        graph: { query: async () => [] },
        static: {
          repository: { repository: REPOSITORY, commit, source: { system: 'git', version: '2' }, form: 'code' },
          byKey: async () => [], byGlobalName: async () => [], neighbourhood: async () => ({ rows: [], next: null }),
          byProperty: async (kind: string) => ({
            rows: kind === 'code.symbol' ? symbols.map((held, index): StaticGraphNode => ({
              id: `n${String(index)}`, kind: 'code.symbol', label: held.qualifiedName,
              properties: { repository: REPOSITORY, file: held.file, qualifiedName: held.qualifiedName, recordKey: held.key, provenance: { source: { system: 'tree-sitter', version: '1' }, repository: { id: REPOSITORY, commit }, place: { file: held.file, range: { startLine: held.startLine, startColumn: 0, endLine: held.endLine, endColumn: 1 } } } },
              producer: 'fill.syntax', scope: '0',
            })) : [],
            next: null,
          }),
          edgesByProperty: async () => ({ rows: [], next: null }),
        },
        draft: { write: (entry: StageDraftWrite) => { writes.push(entry); }, writes: () => ({ writes }) },
        progress: () => undefined,
        signal: new AbortController().signal,
      } as unknown as StageContext;
      expect(await stage.execute(unit, context)).toEqual({ outcome: 'draft' });
      const calls = writes.filter((write) => write.kind === 'edge').map((write) => write.value as StaticEdgeDraft).filter((held) => held.relation === 'code.calls');
      // The call `store.Open()` in `run`: a package-qualified call the library resolves only when the
      // module's own folder is the root it indexes (its `go.mod` is below the repository's root).
      expect(calls.map((held) => [(held.from as { key: string }).key, (held.to as { key: string }).key, held.properties!['resolvedBy']])).toEqual([
        ['code.symbol:services/orders/main.go#run', 'code.symbol:services/orders/store/store.go#Open', 'import'],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  test('the module roots of a tree are the folders that hold a go.mod, and the root itself', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'madarch-codegraph-go-'));
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    try {
      git('init', '-q');
      git('config', 'user.name', 'Fixture');
      git('config', 'user.email', 'fixture@example.invalid');
      mkdirSync(pathJoin(root, 'services', 'orders'), { recursive: true });
      mkdirSync(pathJoin(root, 'services', 'promotions'), { recursive: true });
      writeFileSync(pathJoin(root, 'go.mod'), 'module example/root\n\ngo 1.22\n');
      writeFileSync(pathJoin(root, 'services', 'orders', 'go.mod'), 'module example/orders\n\ngo 1.22\n');
      writeFileSync(pathJoin(root, 'services', 'orders', 'main.go'), 'package main\n');
      writeFileSync(pathJoin(root, 'services', 'promotions', 'NOTES.txt'), 'no module here\n');
      git('add', '-A');
      git('commit', '-qm', 'one');
      const commit = git('rev-parse', 'HEAD').trim();
      const reader = await (await createGitSnapshotSource([{ id: REPOSITORY, form: 'code', root, commit }])).open(REPOSITORY);
      expect(await moduleRootsOf(reader)).toEqual([
        { folder: '', module: 'example/root' },
        { folder: 'services/orders', module: 'example/orders' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
