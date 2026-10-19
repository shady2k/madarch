/**
 * The semantic resolution stage (madarch-tzte.21.6, decision 0026's stage 4)
 * through its own `plan` and `execute` with a fake context: the orchestrator
 * (madarch-tzte.19.5) is not needed and not used.
 *
 * Every expectation comes from the task and the schema, never from the module:
 * the fixture the task names (`a.ts` calls an exported function of `b.ts`)
 * yields one resolved call edge with precision `syntactic`; an unresolved
 * reference is written with its own place; the compiler index is named in the
 * coverage when there is none and answers the edges where there is one; and a
 * change to one file re-resolves that file and the files whose resolution read
 * its symbols, and nothing else.
 *
 * The graph is the test's own: the reads a plan and a unit make are answered
 * from the facts the stages before this one published in the same test, which is
 * what a fact store would answer, and no test touches a real database. Every
 * repository is one the test makes in a temporary folder and removes.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFact } from '../src/fill/facts.js';
import { deriveStageGraph } from '../src/fill/registry.js';
import { createGitSnapshotSource, type SnapshotSource } from '../src/fill/snapshot.js';
import { DEFAULT_STAGE_LIMITS, type StageContext, type StageDraftWrite, type StageUnit } from '../src/fill/stage.js';
import { publishedTreeRead, createInventoryStage, type PublishedTreeRow } from '../src/fill/stages/inventory.js';
import {
  compilerIndexRead, createSemanticResolutionStage, indexRows, publishedGapRows, publishedGapsRead, publishedImportRows,
  publishedImportsRead, publishedReadRows, publishedReadsRead, publishedSymbolsRead, symbolRows, SEMANTIC_RESOLUTION_STAGE_ID,
  type PublishedImportRow,
} from '../src/fill/stages/semantic-resolution.js';
import { createStageRegistry } from '../src/fill/stages/index.js';
import { createSyntaxStage } from '../src/fill/stages/syntax.js';

// ---- the test's own repository, context and graph ---------------------------

/** A throwaway repository the test commits into by hand. */
interface Fixture {
  readonly root: string;
  commit(): string;
  git(...args: string[]): string;
  write(path: string, text: string): Promise<void>;
  dispose(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'madarch-resolution-'));
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

/** What a stage recorded while it ran. */
interface Recorder {
  readonly writes: StageDraftWrite[];
  readonly notes: string[];
  readonly queries: string[];
}

/** One unit's context: the reads answered by the test, the draft collected here, and a signal the test holds. */
function contextFor(unit: StageUnit, answer: (read: string) => readonly unknown[] | Promise<readonly unknown[]> = () => []): { context: StageContext; recorder: Recorder; controller: AbortController } {
  const recorder: Recorder = { writes: [], notes: [], queries: [] };
  const controller = new AbortController();
  return {
    recorder,
    controller,
    context: {
      unit,
      config: { id: SEMANTIC_RESOLUTION_STAGE_ID, version: 1, enabled: true, concurrency: 1, limits: DEFAULT_STAGE_LIMITS, config: {} },
      graph: {
        query: async (read: string) => {
          recorder.queries.push(read);
          return await answer(read);
        },
      },
      draft: {
        write: (entry: StageDraftWrite) => { recorder.writes.push(entry); },
        writes: () => ({ writes: recorder.writes }),
      },
      progress: (note: string) => { recorder.notes.push(note); },
      signal: controller.signal,
    },
  };
}

/** One fact of a draft set, as the fact store would hold it. */
interface DraftFact {
  readonly kind: string;
  readonly id: string;
  readonly value: Record<string, unknown>;
  readonly provenance: {
    readonly repository: { readonly id: string; readonly commit: string };
    readonly place?: { readonly file: string; readonly range: { readonly startLine: number; readonly startColumn: number; readonly endLine: number; readonly endColumn: number } };
  };
}

/** The facts one draft set holds, in the order they were written; a write that is no fact is left out. */
function factsOf(writes: readonly StageDraftWrite[]): readonly DraftFact[] {
  const facts: DraftFact[] = [];
  for (const write of writes) {
    if (write.kind !== 'fact') continue;
    facts.push(write.value as DraftFact);
  }
  return facts;
}

/** The facts of a kind in a draft set, in the order they were written. */
function factsOfKind(writes: readonly StageDraftWrite[], kind: string): readonly DraftFact[] {
  return factsOf(writes).filter((fact) => fact.kind === kind);
}

/** The one fact of a kind in a draft set, refused where the draft holds another number of them. */
function factOfKind(writes: readonly StageDraftWrite[], kind: string): DraftFact {
  const held = factsOfKind(writes, kind);
  if (held.length !== 1) throw new Error(`the draft holds ${held.length} ${kind} facts, and this test expects one: ${held.map((fact) => fact.id).join(', ')}`);
  return held[0]!;
}

/** What a fact store would answer for one repository's stage-1 tree: the file and directory facts a draft set holds. */
function publishedRows(writes: readonly StageDraftWrite[], repository: string): readonly PublishedTreeRow[] {
  const rows: PublishedTreeRow[] = [];
  for (const fact of factsOf(writes)) {
    if (fact.kind !== 'file' && fact.kind !== 'directory') continue;
    const blob = fact.value['blob'];
    rows.push({ kind: fact.kind, repository, path: String(fact.value['path']), ...(typeof blob === 'string' ? { blob } : {}) });
  }
  return rows;
}

/** What a fact store would answer for this stage's own last reading: one row a file, with the files its resolution read. */
function readRows(writes: readonly StageDraftWrite[]): readonly { readonly kind: 'coverage'; readonly file: string; readonly read: readonly string[] }[] {
  const rows: { kind: 'coverage'; file: string; read: readonly string[] }[] = [];
  for (const fact of factsOf(writes)) {
    if (fact.kind !== 'coverage') continue;
    rows.push({ kind: 'coverage', file: String(fact.value['scope']), read: (fact.value['read'] as readonly string[] | undefined) ?? [] });
  }
  return rows;
}

/** What a fact store would answer for one repository's stage-3 gaps: the coverage facts a draft set holds, one row a gap. */
function gapRows(writes: readonly StageDraftWrite[]): readonly { readonly kind: 'coverage'; readonly file: string; readonly what: string }[] {
  const rows: { kind: 'coverage'; file: string; what: string }[] = [];
  for (const fact of factsOf(writes)) {
    if (fact.kind !== 'coverage') continue;
    const unread = fact.value['unread'] as readonly { readonly what: string }[] | undefined;
    for (const gap of unread ?? []) rows.push({ kind: 'coverage', file: String(fact.value['scope']), what: gap.what });
  }
  return rows;
}

/** What a fact store would answer for one repository's stage-3 imports: the `import` edges a draft set holds. */
function importRows(writes: readonly StageDraftWrite[]): readonly PublishedImportRow[] {
  return factsOf(writes).filter((fact) => fact.kind === 'import').map((fact) => ({
    kind: 'import' as const,
    from: String(fact.value['from']),
    to: String(fact.value['to']),
    specifier: String(fact.value['specifier']),
  }));
}

/** What a fact store would answer for one file's stage-3 symbols: the `symbol` facts a draft set holds for that file. */
function symbolRowsOf(writes: readonly StageDraftWrite[], path: string): readonly Record<string, unknown>[] {
  return factsOf(writes)
    .filter((fact) => fact.kind === 'symbol' && fact.value['file'] === path && fact.provenance.place !== undefined)
    .map((fact) => ({
      kind: 'symbol' as const,
      id: fact.id,
      file: path,
      qualifiedName: String(fact.value['qualifiedName']),
      symbolKind: fact.value['symbolKind'],
      startLine: fact.provenance.place!.range.startLine,
      startColumn: fact.provenance.place!.range.startColumn,
      endLine: fact.provenance.place!.range.endLine,
      endColumn: fact.provenance.place!.range.endColumn,
    }));
}

/** What the inventory stage and the syntax stage of one commit published: what the resolution stage's reads answer. */
interface Published {
  readonly tree: readonly PublishedTreeRow[];
  readonly writes: readonly StageDraftWrite[];
  /** What this stage's own last run wrote, for the plan's read of it. */
  readonly resolution?: readonly StageDraftWrite[];
}

async function publishedAt(source: SnapshotSource): Promise<Published> {
  const inventory = createInventoryStage(source);
  const tree: StageDraftWrite[] = [];
  for (const unit of (await inventory.plan({ query: async () => [] })).units) {
    const run = contextFor(unit);
    await inventory.execute(unit, run.context);
    tree.push(...run.recorder.writes);
  }
  const syntax = createSyntaxStage(source);
  const writes: StageDraftWrite[] = [];
  for (const unit of (await syntax.plan({ query: async () => [] })).units) {
    const run = contextFor(unit);
    await syntax.execute(unit, run.context);
    writes.push(...run.recorder.writes);
  }
  return { tree: publishedRows(tree, repositoryOf(tree)), writes };
}

/** The repository a set of inventory facts was published for. */
function repositoryOf(writes: readonly StageDraftWrite[]): string {
  for (const fact of factsOf(writes)) {
    if (fact.kind === 'file') return String(fact.value['repository']);
  }
  throw new Error('the inventory published no file fact: this test needs its repository name');
}

/** The graph one resolution run reads: the published tree, the imports, the symbols, and the compiler's index. */
function graphOf(published: Published, repository: string, options: { readonly index?: (path: string) => readonly unknown[] } = {}): (read: string) => Promise<readonly unknown[]> {
  return async (read: string) => {
    if (read === publishedTreeRead(repository)) return published.tree;
    if (read === publishedReadsRead(repository)) return readRows(published.resolution ?? []);
    if (read === publishedImportsRead(repository)) return importRows(published.writes);
    if (read === publishedGapsRead(repository)) return gapRows(published.writes);
    for (const fact of factsOf(published.writes)) {
      if (fact.kind !== 'symbol') continue;
      const path = String(fact.value['file']);
      if (read === publishedSymbolsRead(repository, path)) return symbolRowsOf(published.writes, path);
    }
    const indexed = /stage-4-compiler-index/.exec(read);
    if (indexed !== null) {
      const parsed = JSON.parse(read) as { readonly path?: string };
      return options.index?.(String(parsed.path)) ?? [];
    }
    return [];
  };
}

/** The units one plan named, by id. */
function unitIds(plan: { units: readonly { id: string }[] }): string[] {
  return plan.units.map((unit) => unit.id);
}

/** What a call refused with, so a test can read what it names; `answered` when it did not refuse. */
async function refusedBy(call: () => unknown): Promise<string> {
  try {
    await call();
    return 'answered';
  } catch (error) {
    return (error as Error).message;
  }
}

/**
 * The id stage 3 published for one file's symbol, by its qualified name.
 */
function symbolIdOf(published: Published, path: string, qualifiedName: string): string {
  const held = factsOf(published.writes).filter((fact) => fact.kind === 'symbol' && fact.value['file'] === path && fact.value['qualifiedName'] === qualifiedName);
  if (held.length !== 1) throw new Error(`stage 3 published ${held.length} symbols named ${qualifiedName} in ${path}, and this test needs exactly one`);
  return held[0]!.id;
}

/** The stage, one unit and what it wrote: the shape every execution test reads. */
async function runUnit(source: SnapshotSource, unit: StageUnit, graph: (read: string) => readonly unknown[] | Promise<readonly unknown[]>): Promise<{ readonly stage: ReturnType<typeof createSemanticResolutionStage>; readonly run: { context: StageContext; recorder: Recorder; controller: AbortController }; readonly outcome: unknown }> {
  const stage = createSemanticResolutionStage(source);
  const run = contextFor(unit, graph);
  const outcome = await stage.execute(unit, run.context);
  return { stage, run, outcome };
}

/** The two files of the task's own fixture: `a.ts` calls an exported function of `b.ts`. */
const CALLS_AN_EXPORTED_FUNCTION: readonly { readonly path: string; readonly text: string }[] = [
  { path: 'src/b.ts', text: "export function create(order: string): string {\n  return order;\n}\n" },
  { path: 'src/a.ts', text: "import { create } from './b.js';\n\nexport function run(order: string): string {\n  return create(order);\n}\n" },
];

/** A source pinned at one commit of the test's repository. */
function sourceAt(root: string, commit: string, repository = 'orders-api'): SnapshotSource {
  return createGitSnapshotSource([{ id: repository, form: 'code', root, commit }]);
}

/** Writes the fixture's files and commits them. */
async function writeFixture(f: Fixture, files: readonly { readonly path: string; readonly text: string }[]): Promise<string> {
  for (const file of files) await f.write(file.path, file.text);
  return f.commit();
}

// ---- the registry ----------------------------------------------------------

describe('the semantic resolution stage is registered', () => {
  test('the derived graph runs it after the syntax stage, on stage 3\'s symbols and imports and stage 1\'s files', async () => {
    const f = await fixture();
    try {
      await f.write('src/orders.ts', 'export const orders = 1;\n');
      const commit = f.commit();
      const registry = createStageRegistry({ snapshots: sourceAt(f.root, commit) });
      const read = deriveStageGraph(registry);
      if (!read.ok) throw new Error(`the graph did not derive: ${JSON.stringify(read)}`);
      expect(read.graph.order).toEqual(['snapshot', 'history', 'inventory', 'build-configuration', 'document-index', 'syntax', 'semantic-resolution', 'modules']);
      expect(read.graph.edges).toEqual([
        { from: 'build-configuration', to: 'modules', via: 'package' },
        { from: 'inventory', to: 'build-configuration', via: 'file' },
        { from: 'inventory', to: 'document-index', via: 'file' },
        { from: 'inventory', to: 'modules', via: 'file' },
        { from: 'inventory', to: 'semantic-resolution', via: 'file' },
        { from: 'inventory', to: 'syntax', via: 'file' },
        { from: 'semantic-resolution', to: 'modules', via: 'call' },
        { from: 'semantic-resolution', to: 'modules', via: 'inherits' },
        { from: 'semantic-resolution', to: 'modules', via: 'reference' },
        { from: 'snapshot', to: 'build-configuration', via: 'snapshot' },
        { from: 'snapshot', to: 'document-index', via: 'snapshot' },
        { from: 'snapshot', to: 'history', via: 'snapshot' },
        { from: 'snapshot', to: 'inventory', via: 'repository' },
        { from: 'snapshot', to: 'inventory', via: 'snapshot' },
        { from: 'syntax', to: 'modules', via: 'import' },
        { from: 'syntax', to: 'modules', via: 'symbol' },
        { from: 'syntax', to: 'semantic-resolution', via: 'import' },
        { from: 'syntax', to: 'semantic-resolution', via: 'symbol' },
      ]);
      expect(registry.get(SEMANTIC_RESOLUTION_STAGE_ID)?.produces.map((produced) => produced.kind)).toEqual([
        'call', 'coverage', 'inherits', 'occurrence', 'reference',
      ]);
    } finally {
      await f.dispose();
    }
  });
});

// ---- planning --------------------------------------------------------------

describe('the resolution stage plans the files a commit moves', () => {
  test('a first run plans every source file, in code point order of the unit ids, and no document', async () => {
    const f = await fixture();
    try {
      await f.write('README.md', '# fixture\n');
      await f.write('src/orders.ts', 'export const orders = 1;\n');
      await f.write('src/helper.ts', 'export const helper = 1;\n');
      await f.write('scripts/run.py', 'print("hello")\n');
      const commit = f.commit();
      const stage = createSemanticResolutionStage(sourceAt(f.root, commit));
      const plan = await stage.plan({ query: async () => [] });
      expect(unitIds(plan)).toEqual([
        'file:orders-api:scripts/run.py',
        'file:orders-api:src/helper.ts',
        'file:orders-api:src/orders.ts',
      ]);
      expect(plan.coverage).toBe('planned');
      // A tree that holds no source file at all plans nothing, and says so.
      const bare = await fixture();
      try {
        await bare.write('README.md', '# nothing to read\n');
        const empty = bare.commit();
        const emptyStage = createSemanticResolutionStage(sourceAt(bare.root, empty));
        expect(await emptyStage.plan({ query: async () => [] })).toEqual({ units: [], coverage: 'nothing-found' });
      } finally {
        await bare.dispose();
      }
    } finally {
      await f.dispose();
    }
  });

  test('a file whose blob did not move is not planned again', async () => {
    const f = await fixture();
    try {
      const commit = await writeFixture(f, CALLS_AN_EXPORTED_FUNCTION);
      const source = sourceAt(f.root, commit);
      const published = await publishedAt(source);
      const stage = createSemanticResolutionStage(source);
      // A first run has nothing published and plans both files.
      expect(unitIds(await stage.plan({ query: async () => [] })).length).toBe(2);
      // A second run of the same commit has nothing left to resolve.
      const again = await stage.plan({ query: graphOf(published, 'orders-api') });
      expect(unitIds(again)).toEqual([]);
      expect(again.coverage).toBe('planned');
    } finally {
      await f.dispose();
    }
  });

  test('a change to one file re-resolves that file and every file whose resolution read its symbols, and no other', async () => {
    const f = await fixture();
    try {
      const first = await writeFixture(f, [
        { path: 'src/core.ts', text: 'export function core(): number {\n  return 1;\n}\n' },
        { path: 'src/uses.ts', text: "import { core } from './core.js';\n\nexport function run(): number {\n  return core();\n}\n" },
        { path: 'src/other.ts', text: 'export const other = 1;\n' },
      ]);
      const published = await publishedAt(sourceAt(f.root, first));
      // One file's symbols move: that file, and the file whose resolution read
      // them, and nothing else.
      await f.write('src/core.ts', 'export function core(): number {\n  return 2;\n}\n');
      const second = f.commit();
      const stage = createSemanticResolutionStage(sourceAt(f.root, second));
      const plan = await stage.plan({ query: graphOf(published, 'orders-api') });
      expect(unitIds(plan)).toEqual([
        'file:orders-api:src/core.ts',
        'file:orders-api:src/uses.ts',
      ]);
    } finally {
      await f.dispose();
    }
  });

  test('an imported file the commit no longer holds re-resolves its importers', async () => {
    const f = await fixture();
    try {
      const first = await writeFixture(f, CALLS_AN_EXPORTED_FUNCTION);
      const published = await publishedAt(sourceAt(f.root, first));
      f.git('rm', '-q', 'src/b.ts');
      const second = f.commit();
      const stage = createSemanticResolutionStage(sourceAt(f.root, second));
      // `src/b.ts` is gone, so `src/a.ts` read symbols that no longer stand:
      // it is planned again beside the vanished path's own retraction, and its
      // unit writes the import's names as unresolved, at their places.
      const plan = await stage.plan({ query: graphOf(published, 'orders-api') });
      expect(unitIds(plan)).toEqual(['file:orders-api:src/a.ts', 'file:orders-api:src/b.ts']);
      const importer = plan.units.find((unit) => unit.id === 'file:orders-api:src/a.ts')!;
      const run = await runUnit(sourceAt(f.root, second), importer, graphOf(published, 'orders-api'));
      expect(factsOfKind(run.run.recorder.writes, 'call')).toEqual([]);
      const gaps = factOfKind(run.run.recorder.writes, 'coverage').value['unread'] as readonly { readonly what: string }[];
      expect(gaps.some((gap) => gap.what.includes('create at src/a.ts:4:9'))).toBe(true);
    } finally {
      await f.dispose();
    }
  });

  test('a file that appears under a specifier stage 3 could not tie re-resolves the file that wrote it', async () => {
    const f = await fixture();
    try {
      // The first commit imports a file that does not exist yet: stage 3 writes
      // the specifier as a gap of the importer's coverage and no import edge.
      const first = await writeFixture(f, [
        { path: 'src/a.ts', text: "import { create } from './b.js';\n\nexport function run(): void {\n  create();\n}\n" },
        { path: 'src/c.ts', text: 'export const other = 1;\n' },
      ]);
      const published = await publishedAt(sourceAt(f.root, first));
      expect(gapRows(published.writes).some((row) => row.file === 'src/a.ts' && row.what === './b.js')).toBe(true);
      await f.write('src/b.ts', 'export function create(): void {}\n');
      const second = f.commit();
      const stage = createSemanticResolutionStage(sourceAt(f.root, second));
      const plan = await stage.plan({ query: graphOf(published, 'orders-api') });
      // The importer and the file that appeared; not the file that imports
      // nothing and was not touched.
      expect(unitIds(plan)).toEqual(['file:orders-api:src/a.ts', 'file:orders-api:src/b.ts']);
      // This stage's own runs read both files and their coverage says so: the
      // next run of the same commit plans nothing, whatever stage 3's older gap
      // still names — the plan does not re-fire on a specifier it has resolved.
      const resolution: StageDraftWrite[] = [];
      for (const unit of plan.units) {
        const run = await runUnit(sourceAt(f.root, second), unit, graphOf(published, 'orders-api'));
        resolution.push(...run.run.recorder.writes);
      }
      // The second commit's *tree* against the first commit's stage-3 facts —
      // the state the bound exists for: stage 3 has not re-read the importer, so
      // its gap still names the specifier the file's resolution now answers. With
      // this stage's own runs in the graph too, a run plans nothing; without the
      // bound, rule 3 fires again and plans the importer, which is what makes
      // this assertion fail on the unbounded code.
      const settled = await publishedAt(sourceAt(f.root, second));
      const after = await stage.plan({ query: graphOf({ tree: settled.tree, writes: published.writes, resolution }, 'orders-api') });
      expect(unitIds(after)).toEqual([]);
      // And without this stage's own reading the same graph plans the importer
      // again: the bound is the reading, and a wiring that answers none re-plans.
      const unbounded = await stage.plan({ query: graphOf({ tree: settled.tree, writes: published.writes }, 'orders-api') });
      expect(unitIds(unbounded)).toContain('file:orders-api:src/a.ts');
    } finally {
      await f.dispose();
    }
  });

  test('an import whose specifier names another file of the pinned tree now re-resolves its importer', async () => {
    const f = await fixture();
    try {
      // Stage 3 reads `./b.js` as the `b.ts` beside it, and writes that import
      // edge. A `b.js` that appears beside it is the file the specifier names
      // now, and the importer's resolution moves although no file it read moved.
      const first = await writeFixture(f, [
        { path: 'src/b.ts', text: 'export function create(): void {}\n' },
        { path: 'src/a.ts', text: "import { create } from './b.js';\n\nexport function run(): void {\n  create();\n}\n" },
      ]);
      const published = await publishedAt(sourceAt(f.root, first));
      expect(importRows(published.writes).map((row) => row.specifier)).toEqual(['./b.js']);
      await f.write('src/b.js', 'export function create() {}\n');
      const second = f.commit();
      const stage = createSemanticResolutionStage(sourceAt(f.root, second));
      const plan = await stage.plan({ query: graphOf(published, 'orders-api') });
      expect(unitIds(plan)).toContain('file:orders-api:src/a.ts');
      expect(unitIds(plan)).toContain('file:orders-api:src/b.js');
      // The file stage 3's edge named did not move, and it is not planned.
      expect(unitIds(plan)).not.toContain('file:orders-api:src/b.ts');
      // This stage's own run reads the file the specifier names now, and its
      // coverage says so: the graph of that commit, with this stage's runs in it,
      // plans nothing — stage 3's older import edge does not re-fire the rule.
      const resolution: StageDraftWrite[] = [];
      for (const unit of plan.units) {
        const run = await runUnit(sourceAt(f.root, second), unit, graphOf(published, 'orders-api'));
        resolution.push(...run.run.recorder.writes);
      }
      // Stage 3's own facts are the first commit's — its import edge still names
      // `src/b.ts` — and this stage's runs are the newer reading: the rule fires
      // once and not again, which is what the unbounded code would fail.
      const settled = await publishedAt(sourceAt(f.root, second));
      const after = await stage.plan({ query: graphOf({ tree: settled.tree, writes: published.writes, resolution }, 'orders-api') });
      expect(unitIds(after)).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  test('a source file the pinned commit no longer holds is planned, and its unit publishes nothing', async () => {
    const f = await fixture();
    try {
      const first = await writeFixture(f, CALLS_AN_EXPORTED_FUNCTION);
      const published = await publishedAt(sourceAt(f.root, first));
      f.git('rm', '-q', 'src/a.ts');
      const second = f.commit();
      const stage = createSemanticResolutionStage(sourceAt(f.root, second));
      const plan = await stage.plan({ query: graphOf(published, 'orders-api') });
      expect(unitIds(plan)).toContain('file:orders-api:src/a.ts');
      // The vanished path's unit publishes nothing, which is how the facts an
      // earlier run wrote for it are retracted.
      const gone = plan.units.find((unit) => unit.id === 'file:orders-api:src/a.ts')!;
      const run = contextFor(gone, graphOf(published, 'orders-api'));
      expect(await stage.execute(gone, run.context)).toEqual({ outcome: 'draft' });
      expect(run.recorder.writes).toEqual([]);
      expect(run.recorder.notes[0]).toContain('src/a.ts');
    } finally {
      await f.dispose();
    }
  });
});

// ---- one unit --------------------------------------------------------------

describe('one unit resolves the file it names', () => {
  test('a.ts calls an exported function of b.ts: one resolved call edge, at precision syntactic', async () => {
    const f = await fixture();
    try {
      const commit = await writeFixture(f, CALLS_AN_EXPORTED_FUNCTION);
      const source = sourceAt(f.root, commit);
      const published = await publishedAt(source);
      const run = await runUnit(source, { id: 'file:orders-api:src/a.ts', scope: 'orders-api:src/a.ts' }, graphOf(published, 'orders-api'));
      const calls = factsOfKind(run.run.recorder.writes, 'call');
      expect(calls.length).toBe(1);
      const call = calls[0]!;
      // The task's own words: one resolved call edge, with precision syntactic.
      expect(call.value['precision']).toBe('syntactic');
      expect(call.value['count']).toBe(1);
      expect(call.value['from']).toBe(symbolIdOf(published, 'src/a.ts', 'run'));
      expect(call.value['to']).toBe(symbolIdOf(published, 'src/b.ts', 'create'));
      // The mention itself is an occurrence at its own place, tied to the symbol.
      const occurrences = factsOfKind(run.run.recorder.writes, 'occurrence');
      expect(occurrences.length).toBe(1);
      expect(occurrences[0]!.value['symbol']).toBe(symbolIdOf(published, 'src/b.ts', 'create'));
      expect(occurrences[0]!.value['roles']).toEqual(['read-access']);
      expect(occurrences[0]!.provenance.place).toEqual({ file: 'src/a.ts', range: { startLine: 4, startColumn: 9, endLine: 4, endColumn: 15 } });
      // Every fact the unit wrote is one the schema reads and this stage produces.
      const validation = await run.stage.validate({ writes: run.run.recorder.writes }, { query: async () => [] });
      expect(validation).toEqual({ ok: true });
      expect(factsOf(run.run.recorder.writes).every((fact) => checkFact(fact).length === 0)).toBe(true);
    } finally {
      await f.dispose();
    }
  });

  test('the file\'s coverage names the compiler index it did not have, and the files whose symbols it read', async () => {
    const f = await fixture();
    try {
      const commit = await writeFixture(f, CALLS_AN_EXPORTED_FUNCTION);
      const source = sourceAt(f.root, commit);
      const published = await publishedAt(source);
      const run = await runUnit(source, { id: 'file:orders-api:src/a.ts', scope: 'orders-api:src/a.ts' }, graphOf(published, 'orders-api'));
      const coverage = factOfKind(run.run.recorder.writes, 'coverage');
      // The resolution is the syntactic fallback, and the file's coverage says
      // which compiler index it did not have; it also names the files whose
      // symbols the resolution read, which is what a later run re-resolves.
      expect(coverage.value['scope']).toBe('src/a.ts');
      expect(coverage.value['complete']).toBe(false);
      expect(coverage.value['read']).toEqual(['src/a.ts', 'src/b.ts']);
      const gaps = coverage.value['unread'] as readonly { readonly what: string; readonly reason: string }[];
      expect(gaps.length).toBe(1);
      expect(gaps[0]!.reason).toBe('unsupported');
      expect(gaps[0]!.what).toContain('compiler index');
      // The unit read its own symbols and the symbols of the file its import
      // names, each as a tracked read, and asked for the compiler's index once.
      const queries = [...run.run.recorder.queries].sort();
      expect(queries).toEqual([
        compilerIndexRead('orders-api', 'src/a.ts'),
        publishedSymbolsRead('orders-api', 'src/a.ts'),
        publishedSymbolsRead('orders-api', 'src/b.ts'),
      ].sort());
      expect(queries.filter((read) => read === compilerIndexRead('orders-api', 'src/a.ts')).length).toBe(1);
    } finally {
      await f.dispose();
    }
  });

  test('an imported name the target file does not declare is written as unresolved with its place', async () => {
    const f = await fixture();
    try {
      const commit = await writeFixture(f, [
        { path: 'src/b.ts', text: 'export function create(): void {}\n' },
        { path: 'src/a.ts', text: "import { missing } from './b.js';\n\nexport function run(): void {\n  missing();\n}\n" },
      ]);
      const source = sourceAt(f.root, commit);
      const published = await publishedAt(source);
      const run = await runUnit(source, { id: 'file:orders-api:src/a.ts', scope: 'orders-api:src/a.ts' }, graphOf(published, 'orders-api'));
      // No edge to a symbol that does not exist: the mention is a gap naming the
      // name and the place a reader can go to.
      expect(factsOfKind(run.run.recorder.writes, 'call')).toEqual([]);
      expect(factsOfKind(run.run.recorder.writes, 'reference')).toEqual([]);
      expect(factsOfKind(run.run.recorder.writes, 'occurrence')).toEqual([]);
      const coverage = factOfKind(run.run.recorder.writes, 'coverage');
      const gaps = coverage.value['unread'] as readonly { readonly what: string }[];
      expect(gaps.some((gap) => gap.what.includes('missing at src/a.ts:4:2'))).toBe(true);
      expect(run.run.recorder.notes[0]).toContain('1 unresolved');
    } finally {
      await f.dispose();
    }
  });

  test('a name imported from a package outside the repository is named once, and its uses are not resolved', async () => {
    const f = await fixture();
    try {
      const commit = await writeFixture(f, [
        { path: 'src/a.ts', text: "import { map } from 'lodash';\n\nexport function run(): unknown {\n  return map([]);\n}\n" },
      ]);
      const source = sourceAt(f.root, commit);
      const published = await publishedAt(source);
      const run = await runUnit(source, { id: 'file:orders-api:src/a.ts', scope: 'orders-api:src/a.ts' }, graphOf(published, 'orders-api'));
      expect(factsOfKind(run.run.recorder.writes, 'call')).toEqual([]);
      const coverage = factOfKind(run.run.recorder.writes, 'coverage');
      const gaps = coverage.value['unread'] as readonly { readonly what: string }[];
      // One gap for the import, and none per use: the package's symbols are not
      // in this repository, which is a fact about the import, not about the call.
      expect(gaps.filter((gap) => gap.what.includes('lodash')).length).toBe(1);
      expect(gaps.filter((gap) => gap.what.includes('map at')).length).toBe(0);
    } finally {
      await f.dispose();
    }
  });

  test('a compiler index answers at precision compiler, and its absence is not named', async () => {
    const f = await fixture();
    try {
      const commit = await writeFixture(f, [
        { path: 'src/a.ts', text: "import { map } from 'lodash';\n\nexport function run(): unknown {\n  return map([]);\n}\n" },
      ]);
      const source = sourceAt(f.root, commit);
      const published = await publishedAt(source);
      const target = symbolIdOf(published, 'src/a.ts', 'run');
      // A compiler index that resolved the call `map([])` to the symbol `run`
      // itself — the fixture's own symbol, since the index names fact ids.
      const index = (path: string): readonly unknown[] => path === 'src/a.ts' ? [{ line: 4, column: 9, symbol: target }] : [];
      const run = await runUnit(source, { id: 'file:orders-api:src/a.ts', scope: 'orders-api:src/a.ts' }, graphOf(published, 'orders-api', { index }));
      const calls = factsOfKind(run.run.recorder.writes, 'call');
      expect(calls.length).toBe(1);
      expect(calls[0]!.value['precision']).toBe('compiler');
      expect(calls[0]!.value['to']).toBe(target);
      const coverage = factOfKind(run.run.recorder.writes, 'coverage');
      const gaps = coverage.value['unread'] as readonly { readonly what: string }[];
      expect(gaps.some((gap) => gap.what.includes('compiler index'))).toBe(false);
    } finally {
      await f.dispose();
    }
  });

  test('the resolution is deterministic: two runs of one commit write the same facts', async () => {
    const f = await fixture();
    try {
      const commit = await writeFixture(f, CALLS_AN_EXPORTED_FUNCTION);
      const source = sourceAt(f.root, commit);
      const published = await publishedAt(source);
      const unit = { id: 'file:orders-api:src/a.ts', scope: 'orders-api:src/a.ts' };
      const once = await runUnit(source, unit, graphOf(published, 'orders-api'));
      const twice = await runUnit(source, unit, graphOf(published, 'orders-api'));
      expect(twice.run.recorder.writes).toEqual(once.run.recorder.writes);
    } finally {
      await f.dispose();
    }
  });

  test('a cancelled unit raises rather than publishing an empty draft', async () => {
    const f = await fixture();
    try {
      const commit = await writeFixture(f, CALLS_AN_EXPORTED_FUNCTION);
      const source = sourceAt(f.root, commit);
      const stage = createSemanticResolutionStage(source);
      const run = contextFor({ id: 'file:orders-api:src/a.ts', scope: 'orders-api:src/a.ts' });
      run.controller.abort();
      const message = await refusedBy(() => stage.execute({ id: 'file:orders-api:src/a.ts', scope: 'orders-api:src/a.ts' }, run.context));
      expect(message).toContain('file:orders-api:src/a.ts');
      expect(message).toContain('cancelled');
      expect(run.recorder.writes).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  test('a source file no grammar of the syntax stage reads is published as a coverage gap', async () => {
    const f = await fixture();
    try {
      const commit = await writeFixture(f, [{ path: 'scripts/run.py', text: 'print("hello")\n' }]);
      const source = sourceAt(f.root, commit);
      const published = await publishedAt(source);
      const run = await runUnit(source, { id: 'file:orders-api:scripts/run.py', scope: 'orders-api:scripts/run.py' }, graphOf(published, 'orders-api'));
      const coverage = factOfKind(run.run.recorder.writes, 'coverage');
      expect(coverage.value['complete']).toBe(false);
      expect(coverage.value['read']).toEqual([]);
      expect(coverage.value['unread']).toEqual([{ what: 'scripts/run.py', reason: 'unsupported' }]);
      expect(factsOfKind(run.run.recorder.writes, 'occurrence')).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  test('a source path that holds a symbolic link is published as a coverage gap', async () => {
    const f = await fixture();
    try {
      await f.write('src/b.ts', 'export function create(): void {}\n');
      await f.write('src/a.ts', "import { create } from './link.js';\n\nexport function run(): void {\n  create();\n}\n");
      execFileSync('ln', ['-s', 'b.ts', join(f.root, 'src/link.ts')]);
      const commit = f.commit();
      const source = sourceAt(f.root, commit);
      const published = await publishedAt(source);
      const unit = { id: 'file:orders-api:src/link.ts', scope: 'orders-api:src/link.ts' };
      const run = await runUnit(source, unit, graphOf(published, 'orders-api'));
      const coverage = factOfKind(run.run.recorder.writes, 'coverage');
      expect(coverage.value['complete']).toBe(false);
      expect(coverage.value['unread']).toEqual([{ what: 'src/link.ts', reason: 'unsupported' }]);
      expect(factsOfKind(run.run.recorder.writes, 'occurrence')).toEqual([]);
      expect(run.run.recorder.notes.join(' ')).toContain('a symbolic link');
    } finally {
      await f.dispose();
    }
  });

  test('a file nested past what the walk can read is the unit\'s coverage gap, not a raised unit', async () => {
    const f = await fixture();
    try {
      // The walk is recursive, so only a depth well past any real file reaches
      // this: the threshold is the machine's stack, hence the headroom here.
      const depth = 12_000;
      const deep = `${Array.from({ length: depth }, (_, index) => `function f${index}() {`).join('\n')}\n${'}'.repeat(depth)}\n`;
      await f.write('src/deep.ts', deep);
      const commit = f.commit();
      const source = sourceAt(f.root, commit);
      const published = await publishedAt(source);
      const unit = { id: 'file:orders-api:src/deep.ts', scope: 'orders-api:src/deep.ts' };
      const run = await runUnit(source, unit, graphOf(published, 'orders-api'));
      expect(await run.stage.validate({ writes: run.run.recorder.writes }, { query: async () => [] })).toEqual({ ok: true });
      const coverage = factOfKind(run.run.recorder.writes, 'coverage');
      expect(coverage.value['unread']).toEqual([{ what: 'src/deep.ts', reason: 'error' }]);
      expect(run.run.recorder.notes.join(' ')).toContain('nested past what this reader can walk');
    } finally {
      await f.dispose();
    }
  });

  test('a RangeError that is not a stack overflow travels instead of becoming a coverage gap', async () => {
    const f = await fixture();
    try {
      const commit = await writeFixture(f, CALLS_AN_EXPORTED_FUNCTION);
      const published = await publishedAt(sourceAt(f.root, commit));
      // A reader that answers a file with a `RangeError` of its own: only the
      // walk's own stack overflow is a file's gap, and a defect still travels.
      const sources = sourceAt(f.root, commit);
      const failing: SnapshotSource = {
        pins: () => sources.pins(),
        open: async (id: string) => {
          const reader = await sources.open(id);
          // The reader the stage sees, with one file's bytes refused by a
          // `RangeError` of its own: a structural stand-in for the class.
          return {
            repository: reader.repository,
            form: reader.form,
            root: reader.root,
            commit: reader.commit,
            tree: reader.tree,
            defaultBranch: reader.defaultBranch,
            source: reader.source,
            entries: () => reader.entries(),
            files: () => reader.files(),
            unfiled: () => reader.unfiled(),
            fileCount: reader.fileCount,
            byteCount: reader.byteCount,
            entry: (path: string) => reader.entry(path),
            read: async (path: string) => {
              if (path === 'src/a.ts') throw new RangeError('the blob is out of bounds');
              return reader.read(path);
            },
          } as unknown as Awaited<ReturnType<SnapshotSource['open']>>;
        },
      };
      const stage = createSemanticResolutionStage(failing);
      const unit = { id: 'file:orders-api:src/a.ts', scope: 'orders-api:src/a.ts' };
      const message = await refusedBy(() => stage.execute(unit, contextFor(unit, graphOf(published, 'orders-api')).context));
      expect(message).toContain('out of bounds');
    } finally {
      await f.dispose();
    }
  });

  test('a default import of a file whose default export has its own name is written unresolved, with its place', async () => {
    const f = await fixture();
    try {
      const commit = await writeFixture(f, [
        { path: 'src/b.ts', text: 'export default function named(): void {}\n' },
        { path: 'src/a.ts', text: "import named from './b.js';\n\nexport function run(): void {\n  named();\n}\n" },
      ]);
      const source = sourceAt(f.root, commit);
      const published = await publishedAt(source);
      const run = await runUnit(source, { id: 'file:orders-api:src/a.ts', scope: 'orders-api:src/a.ts' }, graphOf(published, 'orders-api'));
      // Stage 3 reads `export default function named` as the symbol `named` and
      // publishes no `default` symbol for it, so the import binds a name this
      // stage cannot tie: a gap at the mention's own place, never a wrong edge.
      expect(factsOfKind(run.run.recorder.writes, 'call')).toEqual([]);
      const gaps = factOfKind(run.run.recorder.writes, 'coverage').value['unread'] as readonly { readonly what: string }[];
      expect(gaps.some((gap) => gap.what.includes('named at src/a.ts:4:2') && gap.what.includes('"default"'))).toBe(true);
    } finally {
      await f.dispose();
    }
  });
});

// ---- the reads' own refusals -----------------------------------------------

/** A fact id of the shape a symbol fact carries, for a row a test hands the reader. */
const SYMBOL_ID = `symbol:${'a'.repeat(64)}`;
/** A fact id of the shape a file fact carries. */
const FILE_ID = `file:${'b'.repeat(64)}`;

describe('a read that does not answer what the stage asked for is refused, naming the read, the row and the field', () => {
  const read = publishedSymbolsRead('orders-api', 'src/a.ts');
  const row = { kind: 'symbol', id: SYMBOL_ID, file: 'src/a.ts', qualifiedName: 'run', symbolKind: 'function', startLine: 1, startColumn: 0, endLine: 1, endColumn: 3 };

  test('a symbol row with a key the read does not define', async () => {
    const message = await refusedBy(() => symbolRows([{ ...row, run: 'r1' }], 'orders-api', 'src/a.ts', read));
    expect(message).toContain(read);
    expect(message).toContain('row 1');
    expect(message).toContain('"run"');
  });

  test('a symbol row declared in another file, and one whose id is no symbol fact', async () => {
    const elsewhere = await refusedBy(() => symbolRows([{ ...row, file: 'src/b.ts' }], 'orders-api', 'src/a.ts', read));
    expect(elsewhere).toContain('one read is one file\'s symbols');
    const wrong = await refusedBy(() => symbolRows([{ ...row, id: FILE_ID }], 'orders-api', 'src/a.ts', read));
    expect(wrong).toContain('no symbol fact id');
  });

  test('a symbol row whose range is no range, and one whose end stands before its start', async () => {
    const broken = await refusedBy(() => symbolRows([{ ...row, endLine: 'two' }], 'orders-api', 'src/a.ts', read));
    expect(broken).toContain('endLine');
    const backwards = await refusedBy(() => symbolRows([{ ...row, startLine: 4, endLine: 2 }], 'orders-api', 'src/a.ts', read));
    expect(backwards).toContain('never before its start');
  });

  test('an import row that names another kind, an id that is no file fact', async () => {
    const imports = publishedImportsRead('orders-api');
    const kind = await refusedBy(() => publishedImportRows([{ kind: 'call', from: FILE_ID, to: FILE_ID, specifier: './b.js' }], 'orders-api', imports));
    expect(kind).toContain('answers "import" edges');
    const id = await refusedBy(() => publishedImportRows([{ kind: 'import', from: SYMBOL_ID, to: FILE_ID, specifier: './b.js' }], 'orders-api', imports));
    expect(id).toContain('no file fact id');
    const specifier = await refusedBy(() => publishedImportRows([{ kind: 'import', from: FILE_ID, to: FILE_ID, specifier: ' ' }], 'orders-api', imports));
    expect(specifier).toContain('is no specifier');
  });

  test('a gap row that names another kind, a file that is no repository path, an empty what', async () => {
    const read = publishedGapsRead('orders-api');
    expect(await refusedBy(() => publishedGapRows([{ kind: 'symbol', file: 'src/a.ts', what: './b.js' }], 'orders-api', read))).toContain('answers "coverage" gaps');
    expect(await refusedBy(() => publishedGapRows([{ kind: 'coverage', file: '/abs/a.ts', what: './b.js' }], 'orders-api', read))).toContain('no repository path');
    expect(await refusedBy(() => publishedGapRows([{ kind: 'coverage', file: 'src/a.ts', what: ' ' }], 'orders-api', read))).toContain('is no gap');
  });

  test('a read row that names another kind, a file that is no repository path, a read list that is no list', async () => {
    const read = publishedReadsRead('orders-api');
    expect(await refusedBy(() => publishedReadRows([{ kind: 'symbol', file: 'src/a.ts', read: ['src/a.ts'] }], 'orders-api', read))).toContain('answers "coverage" facts');
    expect(await refusedBy(() => publishedReadRows([{ kind: 'coverage', file: '/abs/a.ts', read: ['src/a.ts'] }], 'orders-api', read))).toContain('no repository path');
    expect(await refusedBy(() => publishedReadRows([{ kind: 'coverage', file: 'src/a.ts', read: 'src/a.ts' }], 'orders-api', read))).toContain('no list of paths');
    expect(await refusedBy(() => publishedReadRows([{ kind: 'coverage', file: 'src/a.ts', read: ['../a.ts'] }], 'orders-api', read))).toContain('no repository path');
  });

  test('an index row whose place stands twice, and one whose symbol is no symbol fact', async () => {
    const index = compilerIndexRead('orders-api', 'src/a.ts');
    const twice = await refusedBy(() => indexRows([{ line: 2, column: 1, symbol: SYMBOL_ID }, { line: 2, column: 1, symbol: SYMBOL_ID }], 'orders-api', 'src/a.ts', index));
    expect(twice).toContain('2:1');
    const wrong = await refusedBy(() => indexRows([{ line: 2, column: 1, symbol: 'create' }], 'orders-api', 'src/a.ts', index));
    expect(wrong).toContain('no symbol fact id');
  });
});
