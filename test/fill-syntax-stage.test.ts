/**
 * The syntax stage (madarch-tzte.21.3; decision 0026 stage 3; decision 0033's
 * per-file units) through its own `plan` and `execute` with a fake context: the
 * stage reads one file's bytes through the static context and writes the file's
 * symbols, definitions, mentions, imports and coverage as graph drafts.
 *
 * The expectations come from the decisions and the task: a symbol carries its
 * global name (`<repository>:<path>#<qualified name>`), a mention is a
 * positioned `code.occurrence` edge, an import is a `code.imports` edge with
 * the specifier as written, and the file's coverage records the blob it read so
 * the next plan knows what it already read. A second run of an unchanged tree
 * plans nothing.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveStageGraph } from '../src/fill/registry.js';
import { createGitSnapshotSource } from '../src/fill/snapshot.js';
import { DEFAULT_STAGE_LIMITS, type StageContext, type StageDraftWrite, type StageUnit } from '../src/fill/stage.js';
import { createStageRegistry } from '../src/fill/stages/index.js';
import { createInventoryStage } from '../src/fill/stages/inventory.js';
import { createSnapshotStage } from '../src/fill/stages/snapshot.js';
import { staticStageContext, staticStageSourceOf } from '../src/fill/stages/static-context.js';
import {
  createSyntaxStage, publishedCoverageRead, publishedCoverageRows,
} from '../src/fill/stages/syntax.js';
import { publishedGapsRead, publishedImportsRead } from '../src/fill/stages/syntax-specifiers.js';
import { publishedTreeRead, publishedTreeRows } from '../src/fill/stages/tree-rows.js';
import { coverageRowsOf, edgesOfRelation, gapRowsOf, importRowsOf, itemsOf, itemsOfKind, nodesOfKind, treeRowsOf } from './fill-static-drafts.js';
import { fileFactIdOf } from '../src/fill/stages/syntax-facts.js';

interface Fixture {
  readonly root: string;
  commit(): string;
  git(...args: string[]): string;
  write(path: string, text: string): Promise<void>;
  dispose(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'madarch-syntax-'));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  const write = async (path: string, text: string): Promise<void> => {
    const at = join(root, path);
    await mkdir(join(at, '..'), { recursive: true });
    await writeFile(at, text);
  };
  return {
    root,
    git,
    write,
    commit(): string {
      git('add', '-A');
      git('commit', '-qm', 'fixture');
      return git('rev-parse', 'HEAD').trim();
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

let testSource: ReturnType<typeof createGitSnapshotSource> | undefined;

function snapshotSource(...args: Parameters<typeof createGitSnapshotSource>): ReturnType<typeof createGitSnapshotSource> {
  const source = createGitSnapshotSource(...args);
  testSource = source;
  return source;
}

function repositoryOfScope(scope: string): string {
  const at = scope.indexOf(':');
  return at < 0 ? scope : scope.slice(0, at);
}

interface Recorder {
  readonly writes: StageDraftWrite[];
  readonly notes: string[];
  readonly queries: string[];
}

async function contextFor(unit: StageUnit, answer: (read: string) => readonly unknown[] = () => [], source = testSource, controller = new AbortController()): Promise<{ context: StageContext; recorder: Recorder; controller: AbortController }> {
  const recorder: Recorder = { writes: [], notes: [], queries: [] };
  const graph = { query: async (read: string) => { recorder.queries.push(read); return answer(read); } };
  const repository = source === undefined ? undefined : await staticStageSourceOf(source, repositoryOfScope(unit.scope));
  return {
    recorder,
    controller,
    context: {
      unit,
      config: { id: 'test', version: 1, enabled: true, concurrency: 1, limits: DEFAULT_STAGE_LIMITS, config: {} },
      graph,
      ...(repository === undefined ? {} : { static: staticStageContext(repository, { byKey: async () => [], byGlobalName: async () => [], neighbourhood: async () => ({ rows: [], next: null }), byProperty: async () => ({ rows: [], next: null }), edgesByProperty: async () => ({ rows: [], next: null }) }) }),
      draft: { write: (entry: StageDraftWrite) => { recorder.writes.push(entry); }, writes: () => ({ writes: recorder.writes }) },
      progress: (note: string) => { recorder.notes.push(note); },
      signal: controller.signal,
    },
  };
}

async function refusedBy(call: () => unknown): Promise<string> {
  try {
    await call();
    return 'answered';
  } catch (error) {
    return (error as Error).message;
  }
}

function unitIds(plan: { units: readonly { id: string }[] }): string[] {
  return plan.units.map((unit) => unit.id);
}

/** The graph a syntax plan reads: the snapshot's tree and this stage's own coverage, gaps and imports. */
function graphOf(tree: readonly StageDraftWrite[], writes: readonly StageDraftWrite[], repository: string): (read: string) => Promise<readonly unknown[]> {
  return async (read: string) => {
    if (read === publishedTreeRead(repository)) return treeRowsOf(tree, repository);
    if (read === publishedCoverageRead(repository)) return coverageRowsOf(writes, repository);
    if (read === publishedGapsRead(repository)) return gapRowsOf(writes);
    if (read === publishedImportsRead(repository)) return importRowsOf(writes);
    throw new Error(`the syntax stage's plan made the read ${read}, and this test answers the published tree, coverage, gaps and imports`);
  };
}

/** Runs the snapshot stage, then the syntax stage, over one repository. */
async function publishedAt(root: string, commit: string, repository: string): Promise<{ tree: readonly StageDraftWrite[]; writes: StageDraftWrite[] }> {
  const source = snapshotSource([{ id: repository, form: 'code', root, commit }]);
  const snapshot = createSnapshotStage(source);
  const tree: StageDraftWrite[] = [];
  for (const unit of (await snapshot.plan({ query: async () => [] })).units) {
    const run = await contextFor(unit, () => [], source);
    await snapshot.execute(unit, run.context);
    tree.push(...run.recorder.writes);
  }
  const syntax = createSyntaxStage(source);
  const writes: StageDraftWrite[] = [];
  for (const unit of (await syntax.plan({ query: graphOf(tree, [], repository) })).units) {
    const run = await contextFor(unit, () => [], source);
    await syntax.execute(unit, run.context);
    writes.push(...run.recorder.writes);
  }
  return { tree, writes };
}

// ---- the registry ----------------------------------------------------------

describe('the syntax stage is registered', () => {
  test('the derived graph runs the syntax stage after the snapshot and the inventory', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', 'export const a = 1;\n');
      const commit = f.commit();
      const registry = createStageRegistry({ snapshots: snapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]) });
      const read = deriveStageGraph(registry);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.graph.order.indexOf('snapshot')).toBeLessThan(read.graph.order.indexOf('inventory'));
      expect(registry.get('syntax')?.produces.map((produced) => produced.kind)).toEqual([
        'comment', 'coverage', 'defines', 'entry-point', 'import', 'occurrence', 'symbol', 'test',
        // The names the file writes, which the resolution stage resolves (decision 0033, item 14).
        'mention',
      ]);
    } finally {
      await f.dispose();
    }
  });
});

// ---- planning --------------------------------------------------------------

describe('the syntax stage plans one unit per source file', () => {
  test('a first run plans every source file, in code point order, and no document', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', 'export const a = 1;\n');
      await f.write('src/b.ts', 'export const b = 2;\n');
      await f.write('docs/readme.md', '# Fixture\n');
      const commit = f.commit();
      const source = snapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]);
      const snapshot = createSnapshotStage(source);
      const tree: StageDraftWrite[] = [];
      for (const unit of (await snapshot.plan({ query: async () => [] })).units) {
        const run = await contextFor(unit, () => [], source);
        await snapshot.execute(unit, run.context);
        tree.push(...run.recorder.writes);
      }
      const syntax = createSyntaxStage(source);
      const plan = await syntax.plan({ query: graphOf(tree, [], 'orders-api') });
      expect(unitIds(plan)).toEqual(['file:orders-api:src/a.ts', 'file:orders-api:src/b.ts']);
    } finally {
      await f.dispose();
    }
  });

  test('a file this stage read at the pinned blob is not planned again, and one whose blob moved is', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', 'export const a = 1;\n');
      const first = f.commit();
      const one = await publishedAt(f.root, first, 'orders-api');
      const source = snapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit: first }]);
      const syntax = createSyntaxStage(source);
      expect(unitIds(await syntax.plan({ query: graphOf(one.tree, one.writes, 'orders-api') }))).toEqual([]);
      await f.write('src/a.ts', 'export const a = 2;\n');
      const second = f.commit();
      const two = await publishedAt(f.root, second, 'orders-api');
      const movedSource = snapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit: second }]);
      expect(unitIds(await createSyntaxStage(movedSource).plan({ query: graphOf(two.tree, one.writes, 'orders-api') }))).toEqual(['file:orders-api:src/a.ts']);
    } finally {
      await f.dispose();
    }
  });

  test('a vanished source path is planned as a unit that publishes nothing', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', 'export const a = 1;\n');
      const first = f.commit();
      const one = await publishedAt(f.root, first, 'orders-api');
      f.git('rm', '-q', 'src/a.ts');
      const second = f.commit();
      const source = snapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit: second }]);
      const syntax = createSyntaxStage(source);
      const plan = await syntax.plan({ query: graphOf(one.tree, one.writes, 'orders-api') });
      expect(unitIds(plan)).toEqual(['file:orders-api:src/a.ts']);
      const run = await contextFor({ id: 'file:orders-api:src/a.ts', scope: 'orders-api:src/a.ts' }, () => [], source);
      await syntax.execute({ id: 'file:orders-api:src/a.ts', scope: 'orders-api:src/a.ts' }, run.context);
      expect(run.recorder.writes).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  test('a specifier that named nothing is read again once the file it names exists', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', "import { b } from './b.js';\n");
      const first = f.commit();
      const one = await publishedAt(f.root, first, 'orders-api');
      await f.write('src/b.ts', 'export const b = 1;\n');
      const second = f.commit();
      const source = snapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit: second }]);
      const snapshot = createSnapshotStage(source);
      const tree: StageDraftWrite[] = [];
      for (const unit of (await snapshot.plan({ query: async () => [] })).units) {
        const run = await contextFor(unit, () => [], source);
        await snapshot.execute(unit, run.context);
        tree.push(...run.recorder.writes);
      }
      const syntax = createSyntaxStage(source);
      expect(unitIds(await syntax.plan({ query: graphOf(tree, one.writes, 'orders-api') }))).toContain('file:orders-api:src/a.ts');
    } finally {
      await f.dispose();
    }
  });
});

// ---- one file --------------------------------------------------------------

describe('the syntax stage reads one source file', () => {
  test('two symbols, their definitions and mentions, the import as written, and the coverage blob', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', 'export function first(): void {}\nexport function second(): void {}\n');
      await f.write('src/b.ts', "import { first } from './a.js';\n\nexport const answer = first();\n");
      const commit = f.commit();
      const { writes } = await publishedAt(f.root, commit, 'orders-api');
      const symbols = itemsOfKind(writes, 'symbol');
      expect(symbols.map((symbol) => symbol.value['globalName']).sort()).toEqual([
        'orders-api:src/a.ts#first',
        'orders-api:src/a.ts#second',
        'orders-api:src/b.ts#answer',
      ]);
      const defines = edgesOfRelation(writes, 'code.contains').filter((edge) => edge.properties?.['factKind'] === 'defines');
      expect(defines).toHaveLength(3);
      const mentions = edgesOfRelation(writes, 'code.occurrence');
      expect(mentions).toHaveLength(3);
      for (const mention of mentions) {
        expect(mention.position).toBeDefined();
        expect(mention.position!.end).toBeGreaterThan(mention.position!.start);
        expect(mention.properties).toMatchObject({ roles: ['definition'] });
      }
      const imports = edgesOfRelation(writes, 'code.imports');
      expect(imports).toHaveLength(1);
      expect(imports[0]!.properties).toMatchObject({ specifier: './a.js' });
      const coverage = coverageRowsOf(writes, 'orders-api');
      expect(coverage.map((row) => row.file).sort()).toEqual(['src/a.ts', 'src/b.ts']);
      for (const row of coverage) expect(row.blob).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await f.dispose();
    }
  });

  test('one node per name the file writes, hung from its file, with the import each name is bound by', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', 'export function first(): void {}\n');
      await f.write('src/b.ts', "import { first as second } from './a.js';\nexport function run(): void { second(); }\n");
      const commit = f.commit();
      const { writes } = await publishedAt(f.root, commit, 'orders-api');
      const mentions = nodesOfKind(writes, 'code.mention');
      // `second` is one mention: the callee of the call. The declaration's own name is no
      // mention, and neither is the import's.
      expect(mentions.map((mention) => [mention.properties['file'], mention.properties['name'], mention.properties['use'], mention.properties['access']])).toEqual([
        ['src/b.ts', 'second', 'call', 'read-access'],
      ]);
      const binding = mentions[0]!.properties['binding'] as Record<string, unknown>;
      expect(binding).toMatchObject({ local: 'second', specifier: './a.js', form: 'named', name: 'first', target: 'src/a.ts' });
      expect(String(binding['targetKey']).startsWith('file:')).toBe(true);
      const range = mentions[0]!.properties['range'] as Record<string, number>;
      expect(range['startByte']).toBeDefined();
      expect(range['endByte']).toBeGreaterThan(range['startByte']!);
      // The edge hangs the mention from the node of the file it stands in.
      const hung = edgesOfRelation(writes, 'code.mentions');
      expect(hung).toHaveLength(1);
      expect(hung[0]!.to).toEqual({ key: mentions[0]!.key });
      // The file's own node is the snapshot stage's, and its key is the file fact's id.
      expect(hung[0]!.from).toEqual({ key: fileFactIdOf('orders-api', 'src/b.ts') });
      // A mention of a package's name carries no binding: its symbols are not in the graph.
      expect(nodesOfKind(writes, 'code.mention').every((mention) => mention.properties['parameterBound'] === false)).toBe(true);
    } finally {
      await f.dispose();
    }
  });

  test('a file in a language without a grammar is a named coverage gap, never a silence', async () => {
    const f = await fixture();
    try {
      await f.write('src/run.rb', "puts 'hi'\n");
      const commit = f.commit();
      const { writes } = await publishedAt(f.root, commit, 'orders-api');
      const coverage = itemsOfKind(writes, 'coverage');
      expect(coverage).toHaveLength(1);
      expect(coverage[0]!.value).toMatchObject({ scope: 'src/run.rb', complete: false, read: [], unread: [{ what: 'src/run.rb', reason: 'unsupported' }] });
      expect(itemsOfKind(writes, 'symbol')).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  test('a Go file\'s declarations, comments and entry points are read at the pinned commit', async () => {
    const f = await fixture();
    try {
      await f.write('cmd/server/main.go', [
        'package main',
        '',
        'import "fmt"',
        '',
        '// Start greets the caller.',
        'func Start() { fmt.Println("hello") }',
        '',
        'func main() { Start() }',
        '',
      ].join('\n'));
      const commit = f.commit();
      const { writes } = await publishedAt(f.root, commit, 'orders-api');
      expect(itemsOfKind(writes, 'symbol').map((symbol) => symbol.value['qualifiedName']).sort()).toEqual(['Start', 'main']);
      expect(itemsOfKind(writes, 'comment').map((comment) => comment.value['text'])).toContain('Start greets the caller.');
      expect(itemsOfKind(writes, 'entry-point').map((entry) => entry.value['form']).sort()).toEqual(['library-export', 'main']);
      // A Go import names a package path, never a file of this repository: no edge, and the coverage says so.
      expect(edgesOfRelation(writes, 'code.imports')).toEqual([]);
      expect(itemsOfKind(writes, 'coverage')[0]!.value['unread']).toEqual([{ what: 'fmt', reason: 'unsupported' }]);
    } finally {
      await f.dispose();
    }
  });

  test('a cancelled unit raises before reading the file and writes nothing', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', 'export const a = 1;\n');
      const commit = f.commit();
      const source = snapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]);
      const syntax = createSyntaxStage(source);
      const controller = new AbortController();
      controller.abort();
      const run = await contextFor({ id: 'file:orders-api:src/a.ts', scope: 'orders-api:src/a.ts' }, () => [], source, controller);
      expect(await refusedBy(() => syntax.execute({ id: 'file:orders-api:src/a.ts', scope: 'orders-api:src/a.ts' }, run.context))).toContain('was cancelled');
      expect(run.recorder.writes).toEqual([]);
    } finally {
      await f.dispose();
    }
  });
});

// ---- refusals --------------------------------------------------------------

describe('the syntax stage refuses what it cannot read', () => {
  test('a unit this stage never plans and a malformed coverage row are refused by name', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', 'export const a = 1;\n');
      const commit = f.commit();
      const source = snapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]);
      const syntax = createSyntaxStage(source);
      const run = await contextFor({ id: 'directory:orders-api:src', scope: 'orders-api:src' });
      expect(await refusedBy(() => syntax.execute({ id: 'directory:orders-api:src', scope: 'orders-api:src' }, run.context))).toContain('is not one this stage plans');
      const message = await refusedBy(() => syntax.plan({ query: async (read) => (read === publishedCoverageRead('orders-api') ? [{ kind: 'coverage', file: 'src/a.ts', blob: 'not-a-blob' }] : read === publishedTreeRead('orders-api') ? [{ kind: 'file', repository: 'orders-api', path: 'src/a.ts', blob: 'a'.repeat(40) }] : []) }));
      expect(message).toContain(publishedCoverageRead('orders-api'));
      expect(message).toContain('blob');
    } finally {
      await f.dispose();
    }
  });

  test('a gap row or an import row the plan cannot read is refused, naming the read, the row and the field', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', 'export const a = 1;\n');
      const commit = f.commit();
      const source = snapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]);
      const syntax = createSyntaxStage(source);
      const gaps = await refusedBy(() => syntax.plan({ query: async (read) => (read === publishedGapsRead('orders-api') ? [{ kind: 'coverage', file: '/etc/passwd', what: 'x' }] : read === publishedTreeRead('orders-api') ? [] : []) }));
      expect(gaps).toContain(publishedGapsRead('orders-api'));
      expect(gaps).toContain('/etc/passwd');
      const imports = await refusedBy(() => syntax.plan({ query: async (read) => (read === publishedImportsRead('orders-api') ? [{ kind: 'import', from: 'x', to: 'y', specifier: './a.js' }] : read === publishedTreeRead('orders-api') ? [] : []) }));
      expect(imports).toContain(publishedImportsRead('orders-api'));
      expect(imports).toContain('is no file fact id');
    } finally {
      await f.dispose();
    }
  });

  test('validate refuses a write that is no graph item and a node of a kind the stage does not produce', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', 'export const a = 1;\n');
      const commit = f.commit();
      const { writes } = await publishedAt(f.root, commit, 'orders-api');
      const source = snapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]);
      const syntax = createSyntaxStage(source);
      const refused = await syntax.validate({ writes: [
        ...writes,
        { kind: 'fact', evidence: `orders-api@${commit}`, value: { kind: 'symbol' } },
        { kind: 'node', evidence: `orders-api@${commit}`, value: { key: 'file:x', kind: 'code.file', label: 'x', properties: { factKind: 'file' } } },
      ] }, { query: async () => [] });
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.errors.join('\n')).toContain('writes graph nodes and edges');
      expect(refused.errors.join('\n')).toContain('does not produce a "file" fact');
      expect(itemsOf(writes).length).toBeGreaterThan(0);
      expect(fileFactIdOf('orders-api', 'src/a.ts')).toContain('file:');
    } finally {
      await f.dispose();
    }
  });
});
