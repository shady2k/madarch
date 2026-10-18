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
      // The history stage (madarch-tzte.21.2) and the document index stage
      // (madarch-tzte.21.4) are registered beside these: the history reads the
      // snapshot too and is ordered among the first by code point, and the
      // document index reads the inventory's file facts like this stage does, so
      // the two are ordered by code point between themselves.
      expect(read.graph.order).toEqual(['snapshot', 'history', 'inventory', 'document-index', 'syntax']);
      expect(read.graph.edges).toEqual([
        { from: 'inventory', to: 'document-index', via: 'file' },
        { from: 'inventory', to: 'syntax', via: 'file' },
        { from: 'snapshot', to: 'document-index', via: 'snapshot' },
        { from: 'snapshot', to: 'history', via: 'snapshot' },
        { from: 'snapshot', to: 'inventory', via: 'repository' },
        { from: 'snapshot', to: 'inventory', via: 'snapshot' },
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
      const plan = await stage.plan({ query: async (read) => { expect(read).toBe(publishedTreeRead('orders-api')); return []; } });
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
      const again = await stage.plan({ query: async () => publishedRows(published, 'orders-api') });
      expect(unitIds(again)).toEqual([]);
      expect(again.coverage).toBe('planned');
      // One file's bytes change: that file's unit, and no other.
      await f.write('src/orders.ts', 'export const orders = 2;\n');
      commit = f.commit();
      const second = await stage.plan({ query: async () => publishedRows(published, 'orders-api') });
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
      const plan = await stage.plan({ query: async () => publishedRows(published, 'orders-api') });
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
