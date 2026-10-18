/**
 * The snapshot and inventory stages (madarch-tzte.21.1, decision 0026 stages 0
 * and 1) through their own `plan` and `execute` with a fake context: the
 * orchestrator (madarch-tzte.19.5) is not needed and not used.
 *
 * Every expectation comes from the task and the decisions, never from the
 * module: stage 0 writes one `snapshot`, one `repository` and one `coverage`
 * fact per pinned repository at the commit it was read at; stage 1 writes a
 * `file` fact per file (its roles, its language, its bytes and the blob its
 * bytes stand under), a `directory` fact per folder, and a `contains` edge from
 * each node's container; a second run after a one-file commit plans that file's
 * unit and its folders' and nothing else; and a renamed file leaves no stale
 * fact behind because the vanished path's unit publishes nothing.
 *
 * The graph is the test's own: the reads a plan makes are answered from the
 * facts an earlier run's draft set held, which is what a fact store would
 * answer, and no test touches a real database. Every repository is one the test
 * makes in a temporary folder and removes.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFact } from '../src/fill/facts.js';
import { deriveStageGraph } from '../src/fill/registry.js';
import { createGitSnapshotSource } from '../src/fill/snapshot.js';
import { DEFAULT_STAGE_LIMITS, type StageContext, type StageDraftWrite, type StageUnit } from '../src/fill/stage.js';
import { createStageRegistry } from '../src/fill/stages/index.js';
import { createInventoryStage, publishedTreeRead, rolesFor, type PublishedTreeRow } from '../src/fill/stages/inventory.js';
import { createSnapshotStage } from '../src/fill/stages/snapshot.js';

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
  const root = await mkdtemp(join(tmpdir(), 'madarch-inventory-'));
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
      config: { id: 'test', version: 1, enabled: true, concurrency: 1, limits: DEFAULT_STAGE_LIMITS, config: {} },
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

/** One write's fact envelope, for a test that reads a draft back. */
function factOf(write: StageDraftWrite): unknown {
  if (write.kind !== 'fact') throw new Error(`the stage wrote a ${write.kind}, and this test reads facts`);
  return write.value;
}

/** The kinds of the facts one draft set holds, in the order they were written. */
function kindsOf(writes: readonly StageDraftWrite[]): string[] {
  return factsOf(writes).map((fact) => fact.kind);
}

/** WHAT a fact store would answer for one repository's stage-1 tree: the file and directory facts a draft set holds. */
function publishedRows(writes: readonly StageDraftWrite[], repository: string): readonly PublishedTreeRow[] {
  const rows: PublishedTreeRow[] = [];
  for (const fact of factsOf(writes)) {
    if (fact.kind !== 'file' && fact.kind !== 'directory') continue;
    const path = String(fact.value['path']);
    const blob = fact.value['blob'];
    rows.push({ kind: fact.kind, repository, path, ...(typeof blob === 'string' ? { blob } : {}) });
  }
  return rows;
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

describe('the stages are registered', () => {
  test('the stages register and the derived graph runs the snapshot before the history, the inventory, the build and configuration, the document index and the syntax stage', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', 'export const a = 1;\n');
      const commit = f.commit();
      const registry = createStageRegistry({ snapshots: createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]) });
      const read = deriveStageGraph(registry);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      // The build and configuration stage (madarch-tzte.21.5) is registered
      // beside them too: the history reads the snapshot and is ordered between
      // the two by code point, the inventory, the build and configuration, the
      // syntax stage and the document index all read the inventory's `file`
      // facts (and the build and configuration, the document index and the
      // history the snapshot), and the graph is the one every registered stage
      // derives.
      expect(read.graph.order).toEqual(['snapshot', 'history', 'inventory', 'build-configuration', 'document-index', 'syntax']);
      expect(read.graph.edges).toEqual([
        { from: 'inventory', to: 'build-configuration', via: 'file' },
        { from: 'inventory', to: 'document-index', via: 'file' },
        { from: 'inventory', to: 'syntax', via: 'file' },
        { from: 'snapshot', to: 'build-configuration', via: 'snapshot' },
        { from: 'snapshot', to: 'document-index', via: 'snapshot' },
        { from: 'snapshot', to: 'history', via: 'snapshot' },
        { from: 'snapshot', to: 'inventory', via: 'repository' },
        { from: 'snapshot', to: 'inventory', via: 'snapshot' },
      ]);
        { from: 'snapshot', to: 'inventory', via: 'repository' },
        { from: 'snapshot', to: 'inventory', via: 'snapshot' },
      ]);
      expect(registry.get('history')?.produces.map((produced) => produced.kind)).toEqual(['commit', 'coverage', 'task-key']);
      expect(registry.get('snapshot')?.produces.map((produced) => produced.kind)).toEqual(['coverage', 'repository', 'snapshot']);
      expect(registry.get('inventory')?.produces.map((produced) => produced.kind)).toEqual(['contains', 'directory', 'file']);
      expect(registry.get('document-index')?.produces.map((produced) => produced.kind)).toEqual(['coverage', 'document', 'document-link', 'section', 'task-key']);
    } finally {
      await f.dispose();
    }
  });
});

// ---- stage 0: the snapshot --------------------------------------------------

describe('the snapshot stage', () => {
  test('plans one unit per pinned repository, in code point order, and none for a run that pins nothing', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', 'export const a = 1;\n');
      const commit = f.commit();
      const source = createGitSnapshotSource([
        { id: 'web', form: 'code', root: f.root, commit },
        { id: 'catalog-api', form: 'product', root: f.root, commit, defaultBranch: 'main' },
      ]);
      const stage = createSnapshotStage(source);
      const plan = await stage.plan({ query: async () => [] });
      expect(unitIds(plan)).toEqual(['catalog-api', 'web']);
      expect(plan.coverage).toBe('planned');
      expect(plan.units.map((unit) => unit.scope)).toEqual(['catalog-api', 'web']);
      // A run that pins nothing plans nothing, and says so: the fill is not starved.
      const empty = createSnapshotStage(createGitSnapshotSource([]));
      expect(await empty.plan({ query: async () => [] })).toEqual({ units: [], coverage: 'nothing-found' });
    } finally {
      await f.dispose();
    }
  });

  test('writes one snapshot, one repository and one coverage fact at the pinned commit', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', 'export const a = 1;\n');
      await f.write('README.md', '# fixture\n');
      const commit = f.commit();
      const tree = f.git('rev-parse', `${commit}^{tree}`).trim();
      const stage = createSnapshotStage(createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]));
      const { context, recorder } = contextFor({ id: 'orders-api', scope: 'orders-api' });
      expect(await stage.execute({ id: 'orders-api', scope: 'orders-api' }, context)).toEqual({ outcome: 'draft' });
      expect(kindsOf(recorder.writes)).toEqual(['coverage', 'repository', 'snapshot']);
      // Every write is a fact the schema reads.
      for (const write of recorder.writes) expect(checkFact(factOf(write))).toEqual([]);
      const [coverage, repository, snapshot] = factsOf(recorder.writes);
      expect(snapshot?.value).toEqual({
        repository: 'orders-api',
        commit,
        tree,
        fileCount: 2,
        byteCount: 'export const a = 1;\n'.length + '# fixture\n'.length,
      });
      expect(repository?.value).toEqual({ repository: 'orders-api', form: 'code' });
      // One node per repository across commits: the same id at another commit.
      expect(snapshot?.provenance.repository).toEqual({ id: 'orders-api', commit });
      // The coverage covers the repository node it was read for and found no
      // gap; a folder holds no bytes of its own, so the kinds it names are the
      // kinds of file the tree held.
      expect(coverage?.value).toEqual({ repository: 'orders-api', scope: repository!.id, complete: true, read: ['file'], unread: [] });
      // The evidence a reader can check the write against: the repository and the commit.
      for (const write of recorder.writes) expect(write.evidence).toBe(`orders-api@${commit}`);
      expect(recorder.notes).toHaveLength(1);
      expect(await stage.validate({ writes: recorder.writes }, { query: async () => [] })).toEqual({ ok: true });
    } finally {
      await f.dispose();
    }
  });

  test('a submodule the tree holds is coverage, named with its path, and never a silent gap', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', 'export const a = 1;\n');
      const first = f.commit();
      // A submodule's tree entry: put in the index after the worktree was
      // staged, since `git add -A` would drop an entry with no folder on disk.
      f.git('update-index', '--add', '--cacheinfo', `160000,${first},sub`);
      f.git('commit', '-qm', 'submodule');
      const second = f.git('rev-parse', 'HEAD').trim();
      const stage = createSnapshotStage(createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit: second }]));
      const { context, recorder } = contextFor({ id: 'orders-api', scope: 'orders-api' });
      await stage.execute({ id: 'orders-api', scope: 'orders-api' }, context);
      const coverage = factsOf(recorder.writes).find((fact) => fact.kind === 'coverage');
      expect(coverage?.value['complete']).toBe(false);
      expect(coverage?.value['unread']).toEqual([{ what: 'sub', reason: 'unsupported' }]);
      expect(checkFact(factOf(recorder.writes[0]!))).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  test('a symbolic link is a file of the tree: it is counted, and the coverage names its kind', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', 'export const a = 1;\n');
      await symlink('src/a.ts', join(f.root, 'link.ts'));
      const commit = f.commit();
      const stage = createSnapshotStage(createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]));
      const { context, recorder } = contextFor({ id: 'orders-api', scope: 'orders-api' });
      await stage.execute({ id: 'orders-api', scope: 'orders-api' }, context);
      const [coverage, , snapshot] = factsOf(recorder.writes);
      // A link's bytes are the path it points at, so the tree holds two files
      // and the coverage says which kinds they are.
      expect(snapshot?.value['fileCount']).toBe(2);
      expect(coverage?.value['read']).toEqual(['file', 'symbolic-link']);
      expect(coverage?.value['complete']).toBe(true);
      expect(checkFact(factOf(recorder.writes[0]!))).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  test('a tree path the fill cannot name is coverage, named with its path, and no fact is written for it', async () => {
    const f = await fixture();
    try {
      await f.write('plain.ts', 'export const a = 1;\n');
      await f.write('a\\b.txt', 'the backslash file\n');
      await f.write('C:/inside.txt', 'the drive-shaped file\n');
      const commit = f.commit();
      const stage = createSnapshotStage(createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]));
      const { context, recorder } = contextFor({ id: 'orders-api', scope: 'orders-api' });
      await stage.execute({ id: 'orders-api', scope: 'orders-api' }, context);
      const coverage = factsOf(recorder.writes).find((fact) => fact.kind === 'coverage');
      expect(coverage?.value['complete']).toBe(false);
      expect(coverage?.value['unread']).toEqual([
        { what: 'C:/inside.txt', reason: 'unsupported' },
        { what: 'a\\b.txt', reason: 'unsupported' },
      ]);
      // Only the file the fill can name is read: two files were not read, and
      // the coverage is what says so rather than a silence.
      expect(coverage?.value['read']).toEqual(['file']);
      expect(factsOf(recorder.writes).find((fact) => fact.kind === 'snapshot')?.value['fileCount']).toBe(1);
      expect(checkFact(factOf(recorder.writes[0]!))).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  test('a cancelled unit raises after the reader opened too, and writes nothing', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', 'export const a = 1;\n');
      const commit = f.commit();
      const real = createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]);
      const { context, recorder, controller } = contextFor({ id: 'orders-api', scope: 'orders-api' });
      // A source that cancels in the moment the reader is handed over: the
      // check after the open is what this proves.
      const stage = createSnapshotStage({
        pins: () => real.pins(),
        open: async (repository) => {
          const reader = await real.open(repository);
          controller.abort();
          return reader;
        },
      });
      await expect(stage.execute({ id: 'orders-api', scope: 'orders-api' }, context)).rejects.toThrow('was cancelled');
      expect(recorder.writes).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  test('the same reading twice is the same facts, and a cancelled unit publishes nothing', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', 'export const a = 1;\n');
      const commit = f.commit();
      const stage = createSnapshotStage(createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]));
      const once = contextFor({ id: 'orders-api', scope: 'orders-api' });
      const twice = contextFor({ id: 'orders-api', scope: 'orders-api' });
      await stage.execute({ id: 'orders-api', scope: 'orders-api' }, once.context);
      await stage.execute({ id: 'orders-api', scope: 'orders-api' }, twice.context);
      expect(factsOf(twice.recorder.writes).map((fact) => fact.id)).toEqual(factsOf(once.recorder.writes).map((fact) => fact.id));
      // A cancelled unit raises rather than draft an empty set, which would retract what it wrote before.
      const cancelled = contextFor({ id: 'orders-api', scope: 'orders-api' });
      cancelled.controller.abort();
      await expect(stage.execute({ id: 'orders-api', scope: 'orders-api' }, cancelled.context)).rejects.toThrow('was cancelled');
      expect(cancelled.recorder.writes).toEqual([]);
    } finally {
      await f.dispose();
    }
  });
});

// ---- stage 1: the inventory -------------------------------------------------

describe('the inventory stage', () => {
  test('plans a unit per file and per folder, in code point order', async () => {
    const f = await fixture();
    try {
      await f.write('README.md', '# fixture\n');
      await f.write('src/a.ts', 'export const a = 1;\n');
      await f.write('src/nested/b.go', 'package b\n');
      const commit = f.commit();
      const stage = createInventoryStage(createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]));
      const plan = await stage.plan({ query: async (read) => { expect(read).toBe(publishedTreeRead('orders-api')); return []; } });
      expect(unitIds(plan)).toEqual([
        'directory:orders-api:src',
        'directory:orders-api:src/nested',
        'file:orders-api:README.md',
        'file:orders-api:src/a.ts',
        'file:orders-api:src/nested/b.go',
      ]);
      expect(plan.coverage).toBe('planned');
      expect(plan.units[0]?.scope).toBe('orders-api:src');
      // A tree with no file plans nothing, and says so rather than planning an empty repository.
      const bare = await fixture();
      try {
        // A repository whose commit holds no file at all: `git commit
        // --allow-empty`, since git stages no empty tree otherwise.
        bare.git('commit', '--allow-empty', '-qm', 'empty');
        const empty = bare.git('rev-parse', 'HEAD').trim();
        const emptyStage = createInventoryStage(createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: bare.root, commit: empty }]));
        expect(await emptyStage.plan({ query: async () => [] })).toEqual({ units: [], coverage: 'nothing-found' });
      } finally {
        await bare.dispose();
      }
    } finally {
      await f.dispose();
    }
  });

  test('a file unit writes the file’s roles, language, bytes and blob, and the edge from its folder', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', 'export const a = 1;\n');
      await f.write('test/a.test.ts', 'export const test = 1;\n');
      await f.write('README.md', '# fixture\n');
      const commit = f.commit();
      const blob = f.git('rev-parse', `${commit}:src/a.ts`).trim();
      const source = createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]);
      const stage = createInventoryStage(source);
      const { context, recorder } = contextFor({ id: 'file:orders-api:src/a.ts', scope: 'orders-api:src/a.ts' });
      expect(await stage.execute({ id: 'file:orders-api:src/a.ts', scope: 'orders-api:src/a.ts' }, context)).toEqual({ outcome: 'draft' });
      expect(kindsOf(recorder.writes)).toEqual(['file', 'contains']);
      for (const write of recorder.writes) expect(checkFact(factOf(write))).toEqual([]);
      const [file, contains] = factsOf(recorder.writes);
      expect(file?.value).toEqual({
        repository: 'orders-api',
        path: 'src/a.ts',
        roles: ['source'],
        language: 'typescript',
        bytes: 'export const a = 1;\n'.length,
        blob,
      });
      // A file fact's place is the whole file: the first line's first character
      // to the last line's end.
      expect(file?.provenance.place).toEqual({
        file: 'src/a.ts',
        range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 'export const a = 1;'.length },
      });
      // The container of a file inside a folder is that folder's node.
      expect(contains?.value['to']).toBe(file!.id);
      expect(contains?.value['from']).toBe(
        factsOf(await drafted({ id: 'directory:orders-api:src', scope: 'orders-api:src' }, stage))[0]?.id,
      );
      expect(recorder.writes.every((write) => write.evidence === `orders-api@${commit}:src/a.ts`)).toBe(true);
      expect(await stage.validate({ writes: recorder.writes }, { query: async () => [] })).toEqual({ ok: true });

      // A file at the repository's root stands in the repository node stage 0 published.
      const rootUnit = contextFor({ id: 'file:orders-api:README.md', scope: 'orders-api:README.md' });
      await stage.execute({ id: 'file:orders-api:README.md', scope: 'orders-api:README.md' }, rootUnit.context);
      const repositoryNode = factsOf(await drafted({ id: 'orders-api', scope: 'orders-api' }, createSnapshotStage(source)))
        .find((fact) => fact.kind === 'repository');
      expect(factsOf(rootUnit.recorder.writes)[1]?.value['from']).toBe(repositoryNode?.id);

      // A top-level folder stands in the repository node too.
      const folderUnit = contextFor({ id: 'directory:orders-api:src', scope: 'orders-api:src' });
      await stage.execute({ id: 'directory:orders-api:src', scope: 'orders-api:src' }, folderUnit.context);
      expect(kindsOf(folderUnit.recorder.writes)).toEqual(['directory', 'contains']);
      expect(factsOf(folderUnit.recorder.writes)[1]?.value['from']).toBe(repositoryNode?.id);
    } finally {
      await f.dispose();
    }
  });

  test('the roles and the language a path carries, as the inventory reads them', () => {
    // From the change record's table: a source file, a test, a document, a configuration, a fixture, and nothing placed.
    expect(rolesFor('src/order.ts')).toEqual(['source']);
    expect(rolesFor('test/order.test.ts')).toEqual(['source', 'test']);
    expect(rolesFor('test/fixtures/order.json')).toEqual(['config', 'fixture', 'test']);
    expect(rolesFor('docs/architecture.md')).toEqual(['document']);
    expect(rolesFor('package.json')).toEqual(['config']);
    expect(rolesFor('Dockerfile')).toEqual(['build']);
    expect(rolesFor('migrations/0001-orders.sql')).toEqual(['migration', 'source']);
    expect(rolesFor('LICENSE')).toEqual(['document']);
    expect(rolesFor('scripts/data.weird')).toEqual(['asset']);
    expect(rolesFor('scripts/run.py')).toEqual(['source']);
    expect(rolesFor('src/order.ts').length).toBeGreaterThan(0);
  });

  test('incremental: after a one-file commit only that file’s unit and its folders’ are planned', async () => {
    const f = await fixture();
    try {
      await f.write('README.md', '# fixture\n');
      await f.write('src/a.ts', 'export const a = 1;\n');
      await f.write('src/b.ts', 'export const b = 1;\n');
      const first = f.commit();
      let commit = first;
      const source = createGitSnapshotSource(() => [{ id: 'orders-api', form: 'code', root: f.root, commit }]);
      const stage = createInventoryStage(source);
      // The first run: nothing is published, so every path is planned and written.
      const firstPlan = await stage.plan({ query: async () => [] });
      const published: StageDraftWrite[] = [];
      for (const unit of firstPlan.units) {
        const run = contextFor(unit);
        await stage.execute(unit, run.context);
        published.push(...run.recorder.writes);
      }
      // Three files and the one folder they stand in.
      expect(firstPlan.units).toHaveLength(4);
      // A second run of the same commit has nothing to do.
      const again = await stage.plan({ query: async () => publishedRows(published, 'orders-api') });
      expect(unitIds(again)).toEqual([]);
      expect(again.coverage).toBe('planned');
      // One file's bytes change: that file's unit and the folders it stands in.
      await f.write('src/a.ts', 'export const a = 2;\n');
      commit = f.commit();
      const second = await stage.plan({ query: async () => publishedRows(published, 'orders-api') });
      expect(unitIds(second)).toEqual(['directory:orders-api:src', 'file:orders-api:src/a.ts']);
      const run = contextFor(second.units[1]!);
      await stage.execute(second.units[1]!, run.context);
      const written = factsOf(run.recorder.writes);
      expect(written.map((fact) => fact.kind)).toEqual(['file', 'contains']);
      expect(written[0]?.value['path']).toBe('src/a.ts');
      expect(written[0]?.value['blob']).toBe(f.git('rev-parse', `${commit}:src/a.ts`).trim());
      expect(written[0]?.provenance.repository.commit).toBe(commit);
      // No other file's fact is in the draft.
      expect(JSON.stringify(run.recorder.writes)).not.toContain('src/b.ts');
    } finally {
      await f.dispose();
    }
  });

  test('a renamed file plans its new path and a retraction, which publishes nothing', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', 'export const a = 1;\n');
      const first = f.commit();
      let commit = first;
      const source = createGitSnapshotSource(() => [{ id: 'orders-api', form: 'code', root: f.root, commit }]);
      const stage = createInventoryStage(source);
      const firstPlan = await stage.plan({ query: async () => [] });
      const published: StageDraftWrite[] = [];
      for (const unit of firstPlan.units) {
        const run = contextFor(unit);
        await stage.execute(unit, run.context);
        published.push(...run.recorder.writes);
      }
      const oldFile = factsOf(published).find((fact) => fact.kind === 'file');
      expect(oldFile?.value['path']).toBe('src/a.ts');
      // Rename the file and commit: the old path is gone from the pinned tree.
      f.git('mv', 'src/a.ts', 'src/b.ts');
      commit = f.commit();
      const plan = await stage.plan({ query: async () => publishedRows(published, 'orders-api') });
      expect(unitIds(plan)).toEqual(['directory:orders-api:src', 'file:orders-api:src/a.ts', 'file:orders-api:src/b.ts']);
      // The vanished path's unit publishes nothing: the publication retracts what the first run wrote there.
      const retraction = contextFor({ id: 'file:orders-api:src/a.ts', scope: 'orders-api:src/a.ts' });
      await stage.execute({ id: 'file:orders-api:src/a.ts', scope: 'orders-api:src/a.ts' }, retraction.context);
      expect(retraction.recorder.writes).toEqual([]);
      expect(retraction.recorder.notes[0]).toContain('publishes nothing');
      // The new path's fact is its own: another id, and no path of the old one.
      const moved = contextFor({ id: 'file:orders-api:src/b.ts', scope: 'orders-api:src/b.ts' });
      await stage.execute({ id: 'file:orders-api:src/b.ts', scope: 'orders-api:src/b.ts' }, moved.context);
      const newFile = factsOf(moved.recorder.writes).find((fact) => fact.kind === 'file');
      expect(newFile?.value['path']).toBe('src/b.ts');
      expect(newFile?.id).not.toBe(oldFile?.id);
      expect(JSON.stringify(moved.recorder.writes)).not.toContain('src/a.ts');
      // Nothing of the old path is left for a reader: no write in the run names it.
      expect(JSON.stringify([...retraction.recorder.writes, ...moved.recorder.writes])).not.toContain('"src/a.ts"');
    } finally {
      await f.dispose();
    }
  });

  test('a folder the commit no longer holds is planned as a unit that publishes nothing', async () => {
    const f = await fixture();
    try {
      await f.write('src/nested/b.go', 'package b\n');
      await f.write('keep.ts', 'export const k = 1;\n');
      const first = f.commit();
      let commit = first;
      const source = createGitSnapshotSource(() => [{ id: 'orders-api', form: 'code', root: f.root, commit }]);
      const stage = createInventoryStage(source);
      const firstPlan = await stage.plan({ query: async () => [] });
      const published: StageDraftWrite[] = [];
      for (const unit of firstPlan.units) {
        const run = contextFor(unit);
        await stage.execute(unit, run.context);
        published.push(...run.recorder.writes);
      }
      expect(unitIds(firstPlan)).toEqual([
        'directory:orders-api:src',
        'directory:orders-api:src/nested',
        'file:orders-api:keep.ts',
        'file:orders-api:src/nested/b.go',
      ]);
      // The one file standing in `src/nested` goes: the folder goes with it.
      f.git('rm', '-q', 'src/nested/b.go');
      commit = f.commit();
      const plan = await stage.plan({ query: async () => publishedRows(published, 'orders-api') });
      // The file's unit is a retraction, and so is every folder that held it and
      // holds nothing now: `src/nested` and `src` both stop standing in the tree.
      expect(unitIds(plan)).toEqual([
        'directory:orders-api:src',
        'directory:orders-api:src/nested',
        'file:orders-api:src/nested/b.go',
      ]);
      for (const id of ['directory:orders-api:src', 'directory:orders-api:src/nested']) {
        const folder = contextFor({ id, scope: id.slice('directory:'.length) });
        await stage.execute({ id, scope: id.slice('directory:'.length) }, folder.context);
        expect(folder.recorder.writes).toEqual([]);
        expect(folder.recorder.notes[0]).toContain('publishes nothing');
      }
      // A folder no file stands in is not planned when it was never published.
      expect(unitIds(plan)).not.toContain('file:orders-api:keep.ts');
    } finally {
      await f.dispose();
    }
  });

  test('a unit the stage never plans, a row a read misreads and a cancelled unit are all refused', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', 'export const a = 1;\n');
      const commit = f.commit();
      const stage = createInventoryStage(createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]));
      const unplanned = contextFor({ id: 'src/a.ts', scope: 'orders-api:src/a.ts' });
      await expect(stage.execute({ id: 'src/a.ts', scope: 'orders-api:src/a.ts' }, unplanned.context)).rejects.toThrow('is not one this stage plans');
      // A read that answers a row for another repository, a kind the stage does
      // not hold, a path that is no path, a blob that is no blob, a key the read
      // does not name, a folder carrying a blob, or one path twice.
      const good = { kind: 'file', repository: 'orders-api', path: 'src/a.ts', blob: 'a'.repeat(40) };
      for (const rows of [
        [{ kind: 'file', repository: 'catalog-api', path: 'src/a.ts' }],
        [{ kind: 'package', repository: 'orders-api', path: 'src/a.ts' }],
        [{ kind: 'file', repository: 'orders-api', path: '/etc/passwd' }],
        [{ kind: 'file', repository: 'orders-api', path: 'src/a.ts', blob: 'not-a-blob' }],
        [{ kind: 'file', repository: 'orders-api', path: 'src/a.ts', runId: 'run-7' }],
        [{ kind: 'directory', repository: 'orders-api', path: 'src', blob: 'a'.repeat(40) }],
        [good, { ...good, blob: 'b'.repeat(40) }],
      ]) {
        const message = await refusedBy(() => stage.plan({ query: async () => rows }));
        expect(message).not.toBe('answered');
        expect(String(message)).toContain(publishedTreeRead('orders-api'));
        expect(String(message)).toContain('row ');
        if (rows.length > 1) expect(String(message)).toContain('row 2');
        else expect(String(message)).toContain('row 1');
      }
      const cancelled = contextFor({ id: 'file:orders-api:src/a.ts', scope: 'orders-api:src/a.ts' });
      cancelled.controller.abort();
      await expect(stage.execute({ id: 'file:orders-api:src/a.ts', scope: 'orders-api:src/a.ts' }, cancelled.context)).rejects.toThrow('was cancelled');
      expect(cancelled.recorder.writes).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  test('validate refuses a write that is no fact, a kind the stage does not produce and a fact the schema does not read', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', 'export const a = 1;\n');
      const commit = f.commit();
      const stage = createInventoryStage(createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]));
      const run = contextFor({ id: 'file:orders-api:src/a.ts', scope: 'orders-api:src/a.ts' });
      await stage.execute({ id: 'file:orders-api:src/a.ts', scope: 'orders-api:src/a.ts' }, run.context);
      const [file, contains] = factsOf(run.recorder.writes) as [DraftFact, DraftFact];
      const broken = await stage.validate({
        writes: [
          ...run.recorder.writes,
          // A link write carries the edge fact it writes (the contains edge above): the stage refuses it
          // because it writes "fact" writes and nothing else.
          { kind: 'link', evidence: 'orders-api@' + commit, value: contains },
          { kind: 'fact', evidence: 'orders-api@' + commit, value: { ...contains, kind: 'symbol' } },
          { kind: 'fact', evidence: 'orders-api@' + commit, value: { ...file, id: 'file:' + '0'.repeat(64), value: { ...file.value, path: '/etc/passwd' } } },
        ],
      }, { query: async () => [] });
      expect(broken.ok).toBe(false);
      if (broken.ok) return;
      expect(broken.errors.some((error) => error.includes('a "link" write is not one'))).toBe(true);
      expect(broken.errors.some((error) => error.includes('does not produce a "symbol" fact'))).toBe(true);
      expect(broken.errors.some((error) => error.includes('value.path'))).toBe(true);
    } finally {
      await f.dispose();
    }
  });
});

/** What one unit's draft set held, for a test that reads it back. */
async function drafted(unit: StageUnit, stage: { execute: (unit: StageUnit, context: StageContext) => unknown }): Promise<readonly StageDraftWrite[]> {
  const run = contextFor(unit);
  await stage.execute(unit, run.context);
  return run.recorder.writes;
}
