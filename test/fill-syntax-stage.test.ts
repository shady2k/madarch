/**
 * The syntax stage (madarch-tzte.21.3, decision 0026's stage 3) through its own
 * `plan` and `execute` with a fake context: the orchestrator (madarch-tzte.19.5)
 * is not needed and not used.
 *
 * Every expectation comes from the task and the schema, never from the module:
 * one unit per source file, named by the repository and the path; the symbols,
 * their definitions, the comments, the entry points, the tests and the imports
 * of a file, each with its place; a file in a language with no grammar as a
 * coverage gap; a file whose blob did not move is not planned again; and a
 * renamed file leaves no stale fact behind because the vanished path's unit
 * publishes nothing.
 *
 * The graph is the test's own: the reads a plan makes are answered from the
 * facts an earlier run's draft set held, which is what a fact store would
 * answer, and no test touches a real database. Every repository is one the test
 * makes in a temporary folder and removes.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFact } from '../src/fill/facts.js';
import { deriveStageGraph } from '../src/fill/registry.js';
import { createGitSnapshotSource } from '../src/fill/snapshot.js';
import { DEFAULT_STAGE_LIMITS, type StageContext, type StageDraftWrite, type StageUnit } from '../src/fill/stage.js';
import { createInventoryStage, publishedTreeRead, type PublishedTreeRow } from '../src/fill/stages/inventory.js';
import { createSnapshotStage } from '../src/fill/stages/snapshot.js';
import { createStageRegistry } from '../src/fill/stages/index.js';
import { createSyntaxStage, fileUnitId } from '../src/fill/stages/syntax.js';
import { fileFactIdOf } from '../src/fill/stages/syntax-facts.js';
import { publishedGapsRead, publishedImportsRead } from '../src/fill/stages/syntax-specifiers.js';

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

/** What a stage recorded while it ran. */
interface Recorder {
  readonly writes: StageDraftWrite[];
  readonly notes: string[];
  readonly queries: string[];
}

/** One unit's context: the reads answered by the test, the draft collected here, and a signal the test holds. */
function contextFor(unit: StageUnit, answer: (read: string) => readonly unknown[] = () => []): { context: StageContext; recorder: Recorder; controller: AbortController } {
  const recorder: Recorder = { writes: [], notes: [], queries: [] };
  const controller = new AbortController();
  return {
    recorder,
    controller,
    context: {
      unit,
      config: { id: 'syntax', version: 1, enabled: true, concurrency: 1, limits: DEFAULT_STAGE_LIMITS, config: {} },
      graph: {
        query: async (read: string) => {
          recorder.queries.push(read);
          return answer(read);
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

/** The kinds of the facts one draft set holds. */
function kindsOf(writes: readonly StageDraftWrite[]): string[] {
  return factsOf(writes).map((fact) => fact.kind);
}

/** The fact of a kind in a draft set, refused where the draft holds none. */
function factOfKind(writes: readonly StageDraftWrite[], kind: string): DraftFact {
  const held = factsOf(writes).filter((fact) => fact.kind === kind);
  if (held.length === 0) throw new Error(`the draft holds no ${kind} fact: it holds ${kindsOf(writes).join(', ')}`);
  return held[0]!;
}

/** The facts of a kind in a draft set, in the order they were written. */
function factsOfKind(writes: readonly StageDraftWrite[], kind: string): readonly DraftFact[] {
  return factsOf(writes).filter((fact) => fact.kind === kind);
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

/** Everything the inventory stage of one commit writes for a repository: what the syntax stage's plan reads back. */
async function inventoryFacts(root: string, commit: string, repository: string): Promise<readonly StageDraftWrite[]> {
  const sources = createGitSnapshotSource([{ id: repository, form: 'code', root, commit }]);
  const stage = createInventoryStage(sources);
  const plan = await stage.plan({ query: async () => [] });
  const published: StageDraftWrite[] = [];
  for (const unit of plan.units) {
    const run = contextFor(unit);
    await stage.execute(unit, run.context);
    published.push(...run.recorder.writes);
  }
  return published;
}

/** What a fact store would answer for one repository's stage-3 gaps: one row per gap of a coverage fact a draft set holds. */
function gapRows(writes: readonly StageDraftWrite[]): readonly { readonly kind: 'coverage'; readonly file: string; readonly what: string }[] {
  const rows: { kind: 'coverage'; file: string; what: string }[] = [];
  for (const fact of factsOf(writes)) {
    if (fact.kind !== 'coverage') continue;
    const unread = (fact.value['unread'] as readonly { readonly what: string }[] | undefined) ?? [];
    for (const gap of unread) rows.push({ kind: 'coverage', file: String(fact.value['scope']), what: gap.what });
  }
  return rows;
}

/**
 * What a fact store would answer for one repository's published imports: the
 * `import` edges a draft set holds, an edge whose target the graph no longer
 * holds among them (the read filters by the edge's importer,
 * `src/fill/stage-reads.ts`).
 */
function importRows(writes: readonly StageDraftWrite[]): readonly { readonly kind: 'import'; readonly from: string; readonly to: string; readonly specifier: string }[] {
  return factsOf(writes).filter((fact) => fact.kind === 'import').map((fact) => ({
    kind: 'import' as const,
    from: String(fact.value['from']),
    to: String(fact.value['to']),
    specifier: String(fact.value['specifier']),
  }));
}

/**
 * The graph one syntax plan reads of one repository: the published tree, and the
 * two facts about specifiers this stage published. A read this test does not
 * answer is refused rather than answered with nothing, so a plan that starts
 * asking something new fails here instead of planning quietly.
 */
function graphOf(tree: readonly StageDraftWrite[], writes: readonly StageDraftWrite[], repository: string): (read: string) => Promise<readonly unknown[]> {
  return async (read: string) => {
    if (read === publishedTreeRead(repository)) return publishedRows(tree, repository);
    if (read === publishedGapsRead(repository)) return gapRows(writes);
    if (read === publishedImportsRead(repository)) return importRows(writes);
    throw new Error(`the syntax stage's plan made the read ${read}, and this test answers the published tree and the two reads about specifiers`);
  };
}

/** What the inventory and the syntax stages of one commit published: what this stage's own plan reads back. */
async function publishedAt(root: string, commit: string, repository: string): Promise<{ readonly tree: readonly StageDraftWrite[]; readonly writes: readonly StageDraftWrite[] }> {
  const tree = await inventoryFacts(root, commit, repository);
  const stage = createSyntaxStage(createGitSnapshotSource([{ id: repository, form: 'code', root, commit }]));
  const writes: StageDraftWrite[] = [];
  for (const unit of (await stage.plan({ query: async () => [] })).units) {
    const run = contextFor(unit);
    await stage.execute(unit, run.context);
    writes.push(...run.recorder.writes);
  }
  return { tree, writes };
}

/** The id the inventory published for one file of a repository, by the path it stands at. */
function fileIdOf(tree: readonly StageDraftWrite[], path: string): string {
  const held = factsOf(tree).filter((fact) => fact.kind === 'file' && fact.value['path'] === path);
  if (held.length !== 1) throw new Error(`the inventory published ${held.length} file facts for ${path}, and this test needs exactly one`);
  return held[0]!.id;
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

/** The units one plan named, by id. */
function unitIds(plan: { units: readonly { id: string }[] }): string[] {
  return plan.units.map((unit) => unit.id);
}

// ---- the registry ----------------------------------------------------------

describe('the syntax stage is registered', () => {
  test('the derived graph runs the syntax stage after the inventory, on the file facts it consumes, with every stage this madarch holds', async () => {
    const f = await fixture();
    try {
      await f.write('src/orders.ts', 'export const orders = 1;\n');
      const commit = f.commit();
      const registry = createStageRegistry({ snapshots: createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]) });
      const read = deriveStageGraph(registry);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      // The history stage (madarch-tzte.21.2), the document index stage
      // (madarch-tzte.21.4), the build and configuration stage
      // (madarch-tzte.21.5) and the semantic resolution stage (madarch-tzte.21.6)
      // are registered beside these: the history reads the snapshot too and is
      // ordered among the first by code point, the document index and the build
      // and configuration stage read the inventory's file facts like this stage
      // does, so the four are ordered by code point between themselves, and the
      // resolution reads this stage's symbols and imports, so it runs after it.
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
      expect(registry.get('syntax')?.produces.map((produced) => produced.kind)).toEqual([
        'comment', 'coverage', 'defines', 'entry-point', 'import', 'occurrence', 'symbol', 'test',
      ]);
    } finally {
      await f.dispose();
    }
  });
});

// ---- planning --------------------------------------------------------------

describe('the syntax stage plans one unit per source file', () => {
  test('a first run plans every source file, in code point order of the unit ids, and no document', async () => {
    const f = await fixture();
    try {
      await f.write('README.md', '# fixture\n');
      await f.write('src/orders.ts', 'export const orders = 1;\n');
      await f.write('src/helper.ts', 'export const helper = 1;\n');
      await f.write('scripts/run.py', 'print("hello")\n');
      const commit = f.commit();
      const stage = createSyntaxStage(createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]));
      // The three reads one repository's plan makes: the tree, and the two facts
      // about specifiers this stage published (its gaps and its import edges).
      const reads: string[] = [];
      const plan = await stage.plan({ query: async (read) => { reads.push(read); return []; } });
      expect(reads).toEqual([publishedTreeRead('orders-api'), publishedGapsRead('orders-api'), publishedImportsRead('orders-api')]);
      expect(unitIds(plan)).toEqual([
        'file:orders-api:scripts/run.py',
        'file:orders-api:src/helper.ts',
        'file:orders-api:src/orders.ts',
      ]);
      expect(plan.coverage).toBe('planned');
      expect(plan.units[0]?.scope).toBe('orders-api:scripts/run.py');
      // A tree that holds no source file at all plans nothing, and says so.
      const bare = await fixture();
      try {
        await bare.write('README.md', '# nothing to read\n');
        const empty = bare.commit();
        const emptyStage = createSyntaxStage(createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: bare.root, commit: empty }]));
        expect(await emptyStage.plan({ query: async () => [] })).toEqual({ units: [], coverage: 'nothing-found' });
      } finally {
        await bare.dispose();
      }
    } finally {
      await f.dispose();
    }
  });

  test('a file whose blob did not move is not planned again, and one whose blob moved is', async () => {
    const f = await fixture();
    try {
      await f.write('src/orders.ts', 'export const orders = 1;\n');
      await f.write('src/helper.ts', 'export const helper = 1;\n');
      let commit = f.commit();
      const source = createGitSnapshotSource(() => [{ id: 'orders-api', form: 'code', root: f.root, commit }]);
      const stage = createSyntaxStage(source);
      const published = await inventoryFacts(f.root, commit, 'orders-api');
      // The first run read both files.
      expect(unitIds(await stage.plan({ query: async () => [] })).length).toBe(2);
      // A second run of the same commit has nothing left to read.
      const again = await stage.plan({ query: graphOf(published, [], 'orders-api') });
      expect(unitIds(again)).toEqual([]);
      expect(again.coverage).toBe('planned');
      // One file's bytes change: that file's unit, and no other.
      await f.write('src/orders.ts', 'export const orders = 2;\n');
      commit = f.commit();
      const second = await stage.plan({ query: graphOf(published, [], 'orders-api') });
      expect(unitIds(second)).toEqual(['file:orders-api:src/orders.ts']);
      const run = contextFor(second.units[0]!);
      await stage.execute(second.units[0]!, run.context);
      expect(factsOfKind(run.recorder.writes, 'symbol')[0]?.value['file']).toBe('src/orders.ts');
      expect(run.recorder.writes[0]?.evidence).toBe(`orders-api@${commit}:src/orders.ts`);
      // No fact of the untouched file is in the draft.
      expect(JSON.stringify(run.recorder.writes)).not.toContain('helper');
    } finally {
      await f.dispose();
    }
  });

  test('a renamed file plans its new path and a retraction, which publishes nothing', async () => {
    const f = await fixture();
    try {
      await f.write('src/orders.ts', 'export const orders = 1;\n');
      let commit = f.commit();
      const stage = createSyntaxStage(createGitSnapshotSource(() => [{ id: 'orders-api', form: 'code', root: f.root, commit }]));
      const published = await inventoryFacts(f.root, commit, 'orders-api');
      f.git('mv', 'src/orders.ts', 'src/moved.ts');
      commit = f.commit();
      const plan = await stage.plan({ query: graphOf(published, [], 'orders-api') });
      expect(unitIds(plan)).toEqual(['file:orders-api:src/moved.ts', 'file:orders-api:src/orders.ts']);
      // The vanished path's unit publishes nothing: the publication retracts
      // every fact the first run wrote for that file.
      const vanished = { id: fileUnitId('orders-api', 'src/orders.ts'), scope: 'orders-api:src/orders.ts' };
      const retraction = contextFor(vanished);
      expect(await stage.execute(vanished, retraction.context)).toEqual({ outcome: 'draft' });
      expect(retraction.recorder.writes).toEqual([]);
      expect(retraction.recorder.notes[0]).toContain('publishes nothing');
      // The new path's facts name the new path and nothing of the old one.
      const moved = { id: fileUnitId('orders-api', 'src/moved.ts'), scope: 'orders-api:src/moved.ts' };
      const run = contextFor(moved);
      await stage.execute(moved, run.context);
      expect(factsOfKind(run.recorder.writes, 'symbol')[0]?.value['file']).toBe('src/moved.ts');
      expect(JSON.stringify(run.recorder.writes)).not.toContain('src/orders.ts');
    } finally {
      await f.dispose();
    }
  });

  test('a specifier stage 3 could not tie to a file is read again once the file exists, and its coverage stops naming the gap', async () => {
    const f = await fixture();
    try {
      // The first commit imports a file that does not exist yet: stage 3 writes
      // the specifier as a gap of the importer's coverage and no import edge.
      await f.write('src/a.ts', "import { create } from './b.js';\n\nexport function run(): void {\n  create();\n}\n");
      await f.write('src/c.ts', 'export const other = 1;\n');
      let commit = f.commit();
      const stage = createSyntaxStage(createGitSnapshotSource(() => [{ id: 'orders-api', form: 'code', root: f.root, commit }]));
      const first = await publishedAt(f.root, commit, 'orders-api');
      expect(gapRows(first.writes)).toEqual([{ kind: 'coverage', file: 'src/a.ts', what: './b.js' }]);
      expect(importRows(first.writes)).toEqual([]);
      // A file appears under the specifier. No byte of `src/a.ts` moved.
      await f.write('src/b.ts', 'export function create(): void {}\n');
      commit = f.commit();
      const plan = await stage.plan({ query: graphOf(first.tree, first.writes, 'orders-api') });
      // The file that wrote the gap, and the file that appeared — not `src/c.ts`,
      // which was not touched and imports nothing.
      expect(unitIds(plan)).toEqual(['file:orders-api:src/a.ts', 'file:orders-api:src/b.ts']);
      // The re-read publishes the edge the specifier names now, and a coverage
      // with no gap left in it.
      const importer = plan.units.find((unit) => unit.id === 'file:orders-api:src/a.ts')!;
      const run = contextFor(importer);
      await stage.execute(importer, run.context);
      expect(factsOfKind(run.recorder.writes, 'import').map((fact) => fact.value['specifier'])).toEqual(['./b.js']);
      expect(factOfKind(run.recorder.writes, 'coverage').value).toEqual({
        repository: 'orders-api',
        scope: 'src/a.ts',
        complete: true,
        read: ['src/a.ts'],
        unread: [],
      });
      // A second run of an unchanged commit plans nothing: the facts the re-read
      // published answer what the specifier names, so the rule does not fire.
      const settled = await publishedAt(f.root, commit, 'orders-api');
      expect(unitIds(await stage.plan({ query: graphOf(settled.tree, settled.writes, 'orders-api') }))).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  test('an import edge that names a file the commit no longer holds is read again, and its specifier becomes a gap', async () => {
    const f = await fixture();
    try {
      await f.write('src/b.ts', 'export function create(): void {}\n');
      await f.write('src/a.ts', "import { create } from './b.js';\n\nexport function run(): void {\n  create();\n}\n");
      let commit = f.commit();
      const stage = createSyntaxStage(createGitSnapshotSource(() => [{ id: 'orders-api', form: 'code', root: f.root, commit }]));
      const first = await publishedAt(f.root, commit, 'orders-api');
      expect(importRows(first.writes).map((row) => row.to)).toEqual([fileIdOf(first.tree, 'src/b.ts')]);
      // The file the specifier named is gone, and no byte of `src/a.ts` moved.
      f.git('rm', '-q', 'src/b.ts');
      commit = f.commit();
      const plan = await stage.plan({ query: graphOf(first.tree, first.writes, 'orders-api') });
      // The importer, and the vanished path's own retraction.
      expect(unitIds(plan)).toEqual(['file:orders-api:src/a.ts', 'file:orders-api:src/b.ts']);
      const importer = plan.units.find((unit) => unit.id === 'file:orders-api:src/a.ts')!;
      const run = contextFor(importer);
      await stage.execute(importer, run.context);
      // The specifier names no file of the repository now: no edge is written,
      // and the coverage says which specifier could not be tied.
      expect(factsOfKind(run.recorder.writes, 'import')).toEqual([]);
      expect(factOfKind(run.recorder.writes, 'coverage').value).toEqual({
        repository: 'orders-api',
        scope: 'src/a.ts',
        complete: false,
        read: ['src/a.ts'],
        unread: [{ what: './b.js', reason: 'unsupported' }],
      });
      // A second run of that commit plans nothing.
      const settled = await publishedAt(f.root, commit, 'orders-api');
      expect(unitIds(await stage.plan({ query: graphOf(settled.tree, settled.writes, 'orders-api') }))).toEqual([]);
      // The state a run that stopped between the retraction and the importer's
      // reading resumes in: the tree holds no `b.ts` and the graph answers no
      // `file` fact for it either, so the edge is the only witness of what
      // `src/a.ts` imported. The read answers it (its filter is the edge's
      // importer: test/fill-stage-reads.test.ts), and it is what plans the
      // importer again.
      const resumed = await stage.plan({ query: graphOf(settled.tree, first.writes, 'orders-api') });
      expect(unitIds(resumed)).toEqual(['file:orders-api:src/a.ts']);
    } finally {
      await f.dispose();
    }
  });

  test('an import edge whose specifier names a file that appeared beside its target is read again, and the edge follows the specifier', async () => {
    const f = await fixture();
    try {
      // Stage 3 ties `./b.js` to the `b.ts` beside it, which is what the
      // specifier names while nothing else stands there.
      await f.write('src/b.ts', 'export function create(): void {}\n');
      await f.write('src/a.ts', "import { create } from './b.js';\n\nexport function run(): void {\n  create();\n}\n");
      let commit = f.commit();
      const stage = createSyntaxStage(createGitSnapshotSource(() => [{ id: 'orders-api', form: 'code', root: f.root, commit }]));
      const first = await publishedAt(f.root, commit, 'orders-api');
      expect(importRows(first.writes).map((row) => row.to)).toEqual([fileIdOf(first.tree, 'src/b.ts')]);
      // A `src/b.js` appears beside it: the specifier names that file now, and no
      // byte of `src/a.ts` moved. `src/b.ts` is not planned: its blob stood.
      await f.write('src/b.js', 'export function create() {}\n');
      commit = f.commit();
      const plan = await stage.plan({ query: graphOf(first.tree, first.writes, 'orders-api') });
      expect(unitIds(plan)).toEqual(['file:orders-api:src/a.ts', 'file:orders-api:src/b.js']);
      // The re-read's edge names the file the specifier answers at this commit,
      // which is the file fact the inventory published for `src/b.js`.
      const settled = await publishedAt(f.root, commit, 'orders-api');
      const importer = plan.units.find((unit) => unit.id === 'file:orders-api:src/a.ts')!;
      const run = contextFor(importer);
      await stage.execute(importer, run.context);
      expect(factsOfKind(run.recorder.writes, 'import').map((fact) => fact.value['to'])).toEqual([fileIdOf(settled.tree, 'src/b.js')]);
      // A second run of an unchanged commit plans nothing.
      expect(unitIds(await stage.plan({ query: graphOf(settled.tree, settled.writes, 'orders-api') }))).toEqual([]);
    } finally {
      await f.dispose();
    }
  });
});

// ---- one unit --------------------------------------------------------------

describe('the syntax stage reads one source file', () => {
  test('a fixture with two exported functions and one import writes those two symbols, their definitions, the import edge and the file\'s coverage', async () => {
    const f = await fixture();
    try {
      await f.write('src/helper.ts', 'export function helper(value: number): number {\n  return value + 1;\n}\n');
      await f.write('src/orders.ts', [
        "import { helper } from './helper.js';",
        '',
        'export function first(value: number): number {',
        '  return helper(value);',
        '}',
        '',
        'export function second(): void {}',
        '',
      ].join('\n'));
      const commit = f.commit();
      const sources = createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]);
      const stage = createSyntaxStage(sources);
      const unit = { id: fileUnitId('orders-api', 'src/orders.ts'), scope: 'orders-api:src/orders.ts' };
      const run = contextFor(unit);
      expect(await stage.execute(unit, run.context)).toEqual({ outcome: 'draft' });

      // Exactly what the task names: two symbols, their definitions and the import edge.
      expect(factsOfKind(run.recorder.writes, 'symbol')).toHaveLength(2);
      expect(factsOfKind(run.recorder.writes, 'occurrence')).toHaveLength(2);
      expect(factsOfKind(run.recorder.writes, 'defines')).toHaveLength(2);
      expect(factsOfKind(run.recorder.writes, 'import')).toHaveLength(1);
      expect(factsOfKind(run.recorder.writes, 'coverage')).toHaveLength(1);
      for (const fact of factsOf(run.recorder.writes)) expect(checkFact(fact)).toEqual([]);
      for (const write of run.recorder.writes) expect(write.evidence).toBe(`orders-api@${commit}:src/orders.ts`);

      // The two symbols are the file's two functions, each named and placed.
      const symbols = factsOfKind(run.recorder.writes, 'symbol');
      expect(symbols.map((fact) => fact.value['qualifiedName']).sort()).toEqual(['first', 'second']);
      expect(symbols.map((fact) => fact.value['symbolKind'])).toEqual(['function', 'function']);
      const first = symbols.find((fact) => fact.value['qualifiedName'] === 'first')!;
      expect(first.provenance.place?.file).toBe('src/orders.ts');
      expect(first.provenance.place?.range.startLine).toBe(3);
      // The definition occurrence stands at the name a reader sees.
      const occurrence = factsOfKind(run.recorder.writes, 'occurrence').find((fact) => fact.value['symbol'] === first.id)!;
      expect(occurrence.value['roles']).toEqual(['definition']);
      expect(occurrence.provenance.place?.range.startColumn).toBe(16);

      // The edges name the file facts the inventory stage publishes: the same
      // repository and the same paths, so the same ids.
      const inventory = await inventoryFacts(f.root, commit, 'orders-api');
      const fileFacts = factsOf(inventory).filter((fact) => fact.kind === 'file');
      const orders = fileFacts.find((fact) => fact.value['path'] === 'src/orders.ts')!;
      const helper = fileFacts.find((fact) => fact.value['path'] === 'src/helper.ts')!;
      expect(factsOfKind(run.recorder.writes, 'defines').every((fact) => fact.value['from'] === orders.id)).toBe(true);
      expect(factsOfKind(run.recorder.writes, 'defines').map((fact) => fact.value['to']).sort()).toEqual(symbols.map((fact) => fact.id).sort());
      expect(factOfKind(run.recorder.writes, 'import').value).toEqual({
        from: orders.id,
        to: helper.id,
        specifier: './helper.js',
      });

      // The file's coverage says what was read, and that nothing was left out.
      expect(factOfKind(run.recorder.writes, 'coverage').value).toEqual({
        repository: 'orders-api',
        scope: 'src/orders.ts',
        complete: true,
        read: ['src/orders.ts'],
        unread: [],
      });
      expect(await stage.validate({ writes: run.recorder.writes }, { query: async () => [] })).toEqual({ ok: true });
    } finally {
      await f.dispose();
    }
  });

  test('a file in a language without a grammar is coverage, never a silence', async () => {
    const f = await fixture();
    try {
      await f.write('scripts/run.py', 'def main():\n    pass\n');
      const commit = f.commit();
      const stage = createSyntaxStage(createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]));
      const unit = { id: fileUnitId('orders-api', 'scripts/run.py'), scope: 'orders-api:scripts/run.py' };
      const run = contextFor(unit);
      await stage.execute(unit, run.context);
      expect(kindsOf(run.recorder.writes)).toEqual(['coverage']);
      expect(factOfKind(run.recorder.writes, 'coverage').value).toEqual({
        repository: 'orders-api',
        scope: 'scripts/run.py',
        complete: false,
        read: [],
        unread: [{ what: 'scripts/run.py', reason: 'unsupported' }],
      });
      expect(run.recorder.notes[0]).toContain('scripts/run.py was not read');
    } finally {
      await f.dispose();
    }
  });

  test('a Go file\'s declarations, comments and tests are read at the pinned commit', async () => {
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
      const stage = createSyntaxStage(createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]));
      const unit = { id: fileUnitId('orders-api', 'cmd/server/main.go'), scope: 'orders-api:cmd/server/main.go' };
      const run = contextFor(unit);
      await stage.execute(unit, run.context);
      expect(factsOfKind(run.recorder.writes, 'symbol').map((fact) => fact.value['qualifiedName']).sort()).toEqual(['Start', 'main']);
      expect(factOfKind(run.recorder.writes, 'comment').value).toEqual({ text: 'Start greets the caller.', form: 'line' });
      expect(factsOfKind(run.recorder.writes, 'entry-point').map((fact) => fact.value['form']).sort()).toEqual(['library-export', 'main']);
      // A Go import names a package path, never a file of this repository:
      // stage 3 ties no edge for it and the file's coverage says so, rather
      // than joining the specifier to a file it does not name.
      expect(factsOfKind(run.recorder.writes, 'import')).toEqual([]);
      expect(factOfKind(run.recorder.writes, 'coverage').value['unread']).toEqual([{ what: 'fmt', reason: 'unsupported' }]);
      for (const fact of factsOf(run.recorder.writes)) expect(checkFact(fact)).toEqual([]);
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
      const stage = createSyntaxStage(createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]));
      const unit = { id: fileUnitId('orders-api', 'src/deep.ts'), scope: 'orders-api:src/deep.ts' };
      const run = contextFor(unit);
      expect(await stage.execute(unit, run.context)).toEqual({ outcome: 'draft' });
      expect(kindsOf(run.recorder.writes)).toEqual(['coverage']);
      expect(factOfKind(run.recorder.writes, 'coverage').value).toEqual({
        repository: 'orders-api',
        scope: 'src/deep.ts',
        complete: false,
        read: [],
        unread: [{ what: 'src/deep.ts', reason: 'error' }],
      });
      expect(run.recorder.notes.join(' ')).toContain('nested past what this reader can walk');
    } finally {
      await f.dispose();
    }
  });

  test('the same file read twice is the same facts, and a cancelled unit publishes nothing', async () => {
    const f = await fixture();
    try {
      await f.write('src/orders.ts', 'export function first(): void {}\n');
      const commit = f.commit();
      const stage = createSyntaxStage(createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]));
      const unit = { id: fileUnitId('orders-api', 'src/orders.ts'), scope: 'orders-api:src/orders.ts' };
      const once = contextFor(unit);
      const twice = contextFor(unit);
      await stage.execute(unit, once.context);
      await stage.execute(unit, twice.context);
      expect(factsOf(twice.recorder.writes).map((fact) => fact.id)).toEqual(factsOf(once.recorder.writes).map((fact) => fact.id));
      // A cancellation raises rather than draft an empty set, which would
      // retract every fact the unit's earlier generation published.
      const cancelled = contextFor(unit);
      cancelled.controller.abort();
      await expect(stage.execute(unit, cancelled.context)).rejects.toThrow('was cancelled');
      expect(cancelled.recorder.writes).toEqual([]);
    } finally {
      await f.dispose();
    }
  });
});

// ---- refusals --------------------------------------------------------------

describe('the syntax stage refuses what it cannot read', () => {
  test('a unit this stage never plans, a misread row and a cancelled unit are refused by name', async () => {
    const f = await fixture();
    try {
      await f.write('src/orders.ts', 'export const orders = 1;\n');
      const commit = f.commit();
      const stage = createSyntaxStage(createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]));
      const unplanned = contextFor({ id: 'src/orders.ts', scope: 'orders-api:src/orders.ts' });
      const message = await refusedBy(() => stage.execute({ id: 'src/orders.ts', scope: 'orders-api:src/orders.ts' }, unplanned.context));
      expect(message).toContain('is not one this stage plans');
      expect(unplanned.recorder.writes).toEqual([]);
      // A row the plan cannot read is refused naming the read, the row and what
      // was wrong with it: a row read past would plan a wrong unit in silence.
      for (const row of [
        { kind: 'file', repository: 'catalog-api', path: 'src/orders.ts' },
        { kind: 'symbol', repository: 'orders-api', path: 'src/orders.ts' },
        { kind: 'file', repository: 'orders-api', path: '/etc/passwd' },
        { kind: 'file', repository: 'orders-api', path: 'src/orders.ts', blob: 'not-a-blob' },
        { kind: 'file', repository: 'orders-api', path: 'src/orders.ts', runId: 'run-7' },
        // The two refusals the shared reader gained: a folder carrying a blob,
        // and one path standing in two rows.
        { kind: 'directory', repository: 'orders-api', path: 'src', blob: 'a'.repeat(40) },
      ]) {
        const refusal = await refusedBy(() => stage.plan({ query: async () => [row] }));
        expect(refusal).not.toBe('answered');
        expect(refusal).toContain(publishedTreeRead('orders-api'));
        expect(refusal).toContain('row 1');
      }
      const twice = await refusedBy(() => stage.plan({ query: async () => [
        { kind: 'file', repository: 'orders-api', path: 'src/orders.ts' },
        { kind: 'file', repository: 'orders-api', path: 'src/orders.ts' },
      ] }));
      expect(twice).toContain('stands in an earlier row');
      // Rows for a repository the read was not made for are refused too.
      const wrongRepository = await refusedBy(() => stage.plan({ query: async () => [{ kind: 'directory', repository: 'web', path: 'src' }] }));
      expect(wrongRepository).toContain('the read was for "orders-api"');
      const cancelled = contextFor({ id: fileUnitId('orders-api', 'src/orders.ts'), scope: 'orders-api:src/orders.ts' });
      cancelled.controller.abort();
      await expect(stage.execute({ id: fileUnitId('orders-api', 'src/orders.ts'), scope: 'orders-api:src/orders.ts' }, cancelled.context)).rejects.toThrow('was cancelled');
      expect(cancelled.recorder.writes).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  test('a gap row or an import row the plan cannot read is refused, naming the read, the row and the field', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', "import { create } from './b.js';\n");
      const commit = f.commit();
      const stage = createSyntaxStage(createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]));
      const fileId = fileFactIdOf('orders-api', 'src/b.ts');
      const gapsRead = publishedGapsRead('orders-api');
      const importsRead = publishedImportsRead('orders-api');
      const cases: readonly (readonly [string, unknown, string])[] = [
        [gapsRead, { kind: 'import', file: 'src/a.ts', what: './b.js' }, 'answers "coverage" gaps'],
        [gapsRead, { kind: 'coverage', file: '/etc/passwd', what: './b.js' }, 'no repository path'],
        [gapsRead, { kind: 'coverage', file: 'src/a.ts', what: ' ' }, 'is no gap'],
        [importsRead, { kind: 'coverage', from: fileId, to: fileId, specifier: './b.js' }, 'answers "import" edges'],
        [importsRead, { kind: 'import', from: 'symbol:0', to: fileId, specifier: './b.js' }, 'no file fact id'],
        [importsRead, { kind: 'import', from: fileId, to: fileId, specifier: ' ' }, 'is no specifier'],
        [importsRead, { kind: 'import', from: fileId, to: fileId, specifier: './b.js', runId: 'run-7' }, 'a row holds'],
      ];
      for (const [read, row, expected] of cases) {
        const refusal = await refusedBy(() => stage.plan({
          query: async (asked: string) => (asked === read ? [row] : await graphOf([], [], 'orders-api')(asked)),
        }));
        expect(refusal).not.toBe('answered');
        expect(refusal).toContain(read);
        expect(refusal).toContain('row 1');
        expect(refusal).toContain(expected);
      }
    } finally {
      await f.dispose();
    }
  });

  test('validate refuses a write that is no fact, and a kind the stage does not produce', async () => {
    const f = await fixture();
    try {
      await f.write('src/orders.ts', 'export const orders = 1;\n');
      const commit = f.commit();
      const stage = createSyntaxStage(createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]));
      const unit = { id: fileUnitId('orders-api', 'src/orders.ts'), scope: 'orders-api:src/orders.ts' };
      const run = contextFor(unit);
      await stage.execute(unit, run.context);
      const symbol = factOfKind(run.recorder.writes, 'symbol');
      const broken = await stage.validate({
        writes: [
          ...run.recorder.writes,
          // A link write carries its fact in `value` like every other write
          // (madarch-tzte.20.2); this stage writes facts, so it is still refused.
          { kind: 'link', evidence: `orders-api@${commit}`, value: { kind: 'import', value: { from: 'a', to: 'b' } } },
          { kind: 'fact', evidence: `orders-api@${commit}`, value: { ...symbol, kind: 'module' } },
          { kind: 'fact', evidence: `orders-api@${commit}`, value: { ...symbol, value: { ...symbol.value, file: '/etc/passwd' } } },
        ],
      }, { query: async () => [] });
      expect(broken.ok).toBe(false);
      if (broken.ok) return;
      expect(broken.errors.some((error) => error.includes('a "link" write is not one'))).toBe(true);
      expect(broken.errors.some((error) => error.includes('does not produce a "module" fact'))).toBe(true);
      expect(broken.errors.some((error) => error.includes('value.file'))).toBe(true);
    } finally {
      await f.dispose();
    }
  });
});
