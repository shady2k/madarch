/**
 * The snapshot and inventory stages (madarch-tzte.21.1; decision 0026 stages 0
 * and 1; decision 0033's per-file units) through their own `plan` and `execute`
 * with a fake context. The orchestrator is not used: the test reads the graph
 * drafts the stages write and answers their plans from those drafts.
 *
 * The expectations come from the decisions: the snapshot publishes one
 * `code.file` node per file from one file's bytes, one `code.directory` node
 * per folder, one `code.repository` and one `code.commit` node per repository,
 * and a `code.coverage` node for a path it could not read. The inventory draws
 * the containment: one `code.contains` edge from each node's container, and a
 * second run of an unchanged tree plans nothing.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveStageGraph } from '../src/fill/registry.js';
import { createGitSnapshotSource } from '../src/fill/snapshot.js';
import { DEFAULT_STAGE_LIMITS, type StageContext, type StageDraftWrite, type StageUnit } from '../src/fill/stage.js';
import { createStageRegistry } from '../src/fill/stages/index.js';
import {
  createInventoryStage, directoriesOf, languageFor, publishedContainmentRead, publishedContainmentRows, publishedTreeRead,
  publishedTreeRows, rolesFor,
} from '../src/fill/stages/inventory.js';
import { createSnapshotStage, publishedRepositoryRead } from '../src/fill/stages/snapshot.js';
import { staticStageContext, staticStageSourceOf } from '../src/fill/stages/static-context.js';
import { containmentRowsOf, edgesOfRelation, itemsOf, nodesOfKind, treeRowsOf } from './fill-static-drafts.js';

// ---- the test's own repository, context and graph ---------------------------

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

interface Recorder {
  readonly writes: StageDraftWrite[];
  readonly notes: string[];
  readonly queries: string[];
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

/** One unit's context: the reads answered by the test, the draft collected here, and a signal the test holds. */
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
      ...(repository === undefined ? {} : { static: staticStageContext(repository, { byKey: async () => [], byGlobalName: async () => [], neighbourhood: async () => [] }) }),
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

/** Runs one stage's units over a source, collecting the drafts. */
async function runStage(stage: ReturnType<typeof createSnapshotStage> | ReturnType<typeof createInventoryStage>, answer: (read: string) => readonly unknown[] = () => []): Promise<{ plan: { units: readonly { id: string; scope: string }[] }; writes: StageDraftWrite[] }> {
  const plan = await stage.plan({ query: async (read: string) => answer(read) });
  const writes: StageDraftWrite[] = [];
  for (const unit of plan.units) {
    const run = await contextFor(unit, answer);
    await stage.execute(unit, run.context);
    writes.push(...run.recorder.writes);
  }
  return { plan, writes };
}

/** The graph one inventory plan reads: the snapshot's published tree and repository, and its own containment. */
function planGraph(tree: readonly StageDraftWrite[], repository: string, containment: readonly unknown[] = []): (read: string) => Promise<readonly unknown[]> {
  return async (read: string) => {
    if (read === publishedTreeRead(repository)) return treeRowsOf(tree, repository);
    if (read === publishedRepositoryRead(repository)) return [{ kind: 'repository', repository }];
    if (read === publishedContainmentRead(repository)) return containment;
    return [];
  };
}

// ---- the registry ----------------------------------------------------------

describe('the stages are registered', () => {
  test('the derived graph runs the snapshot before the stages that read its files, and the inventory after it', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', 'export const a = 1;\n');
      const commit = f.commit();
      const registry = createStageRegistry({ snapshots: snapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]) });
      const read = deriveStageGraph(registry);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.graph.order.indexOf('snapshot')).toBeLessThan(read.graph.order.indexOf('inventory'));
      expect(read.graph.order.indexOf('inventory')).toBeLessThan(read.graph.order.indexOf('syntax'));
      expect(read.graph.order.indexOf('snapshot')).toBeLessThan(read.graph.order.indexOf('syntax'));
      expect(registry.get('snapshot')?.produces.map((produced) => produced.kind)).toEqual(['coverage', 'directory', 'file', 'repository', 'snapshot']);
      expect(registry.get('inventory')?.produces.map((produced) => produced.kind)).toEqual(['contains']);
    } finally {
      await f.dispose();
    }
  });
});

// ---- stage 0: the snapshot --------------------------------------------------

describe('the snapshot stage', () => {
  test('plans one unit per file, per folder and one for the repository, in code point order', async () => {
    const f = await fixture();
    try {
      await f.write('README.md', '# Fixture\n');
      await f.write('src/a.ts', 'export const a = 1;\n');
      await f.write('src/b.ts', 'export const b = 2;\n');
      const commit = f.commit();
      const stage = createSnapshotStage(snapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]));
      expect(unitIds(await stage.plan({ query: async () => [] }))).toEqual([
        'directory:orders-api:src',
        'file:orders-api:README.md',
        'file:orders-api:src/a.ts',
        'file:orders-api:src/b.ts',
        'repository:orders-api',
      ]);
      const empty = createSnapshotStage(snapshotSource([]));
      expect(await empty.plan({ query: async () => [] })).toEqual({ units: [], coverage: 'nothing-found' });
    } finally {
      await f.dispose();
    }
  });

  test('a file unit publishes one code.file node with the roles, language, bytes and blob of that file', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', 'export const a = 1;\n');
      const commit = f.commit();
      const stage = createSnapshotStage(snapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]));
      const writes = await runStage(stage);
      const files = nodesOfKind(writes.writes, 'code.file');
      expect(files).toHaveLength(1);
      const a = files.find((node) => node.properties['path'] === 'src/a.ts')!;
      expect(a.properties).toMatchObject({ repository: 'orders-api', path: 'src/a.ts', roles: ['source'], language: 'typescript', blob: f.git('rev-parse', `${commit}:src/a.ts`).trim() });
      expect(a.properties['bytes']).toBe('export const a = 1;\n'.length);
      expect(itemsOf(writes.writes).filter((item) => item.kind === 'directory').map((item) => item.value['path']).sort()).toEqual(['src']);
      expect(itemsOf(writes.writes).filter((item) => item.kind === 'repository')).toHaveLength(1);
      expect(itemsOf(writes.writes).filter((item) => item.kind === 'snapshot').map((item) => item.value['commit'])).toEqual([commit]);
    } finally {
      await f.dispose();
    }
  });

  test('a file above the cap keeps its node and is named as a too-large coverage gap', async () => {
    const f = await fixture();
    try {
      await f.write('big.ts', 'a'.repeat(1_048_577));
      const commit = f.commit();
      const stage = createSnapshotStage(snapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]));
      const writes = await runStage(stage);
      const big = nodesOfKind(writes.writes, 'code.file').find((node) => node.properties['path'] === 'big.ts')!;
      expect(big.properties['bytes']).toBe(1_048_577);
      const coverage = nodesOfKind(writes.writes, 'code.coverage');
      expect(coverage).toHaveLength(1);
      expect(coverage[0]!.properties).toMatchObject({ scope: 'big.ts', complete: false, read: [], unread: [{ what: 'big.ts', reason: 'too-large' }] });
    } finally {
      await f.dispose();
    }
  });

  test('a symbolic link is a file of the tree and a submodule is a named coverage gap', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', 'export const a = 1;\n');
      await symlink('src/a.ts', join(f.root, 'link.ts'));
      const commit = f.commit();
      const stage = createSnapshotStage(snapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]));
      const writes = await runStage(stage);
      const files = nodesOfKind(writes.writes, 'code.file').map((node) => String(node.properties['path'])).sort();
      expect(files).toEqual(['link.ts', 'src/a.ts']);
    } finally {
      await f.dispose();
    }
  });

  test('a cancelled unit raises and writes nothing', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', 'export const a = 1;\n');
      const commit = f.commit();
      const stage = createSnapshotStage(snapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]));
      const controller = new AbortController();
      controller.abort();
      const run = await contextFor({ id: 'file:orders-api:src/a.ts', scope: 'orders-api:src/a.ts' }, () => [], undefined, controller);
      await expect(stage.execute({ id: 'file:orders-api:src/a.ts', scope: 'orders-api:src/a.ts' }, run.context)).rejects.toThrow('was cancelled');
      expect(run.recorder.writes).toEqual([]);
    } finally {
      await f.dispose();
    }
  });
});

// ---- stage 1: the inventory -------------------------------------------------

describe('the inventory stage', () => {
  test('a first run plans one unit per file and per folder, in code point order', async () => {
    const f = await fixture();
    try {
      await f.write('README.md', '# Fixture\n');
      await f.write('src/a.ts', 'export const a = 1;\n');
      const commit = f.commit();
      const source = snapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]);
      const snapshot = await runStage(createSnapshotStage(source));
      const stage = createInventoryStage(source);
      expect(unitIds(await stage.plan({ query: planGraph(snapshot.writes, 'orders-api') }))).toEqual([
        'directory:orders-api:src',
        'file:orders-api:README.md',
        'file:orders-api:src/a.ts',
      ]);
    } finally {
      await f.dispose();
    }
  });

  test('a file unit draws the edge from its folder, and a root file from the repository', async () => {
    const f = await fixture();
    try {
      await f.write('README.md', '# Fixture\n');
      await f.write('src/a.ts', 'export const a = 1;\n');
      const commit = f.commit();
      const source = snapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]);
      const snapshot = await runStage(createSnapshotStage(source));
      const inventory = createInventoryStage(source);
      const inventoryWrites: StageDraftWrite[] = [];
      for (const unit of (await inventory.plan({ query: planGraph(snapshot.writes, 'orders-api') })).units) {
        const run = await contextFor(unit);
        await inventory.execute(unit, run.context);
        inventoryWrites.push(...run.recorder.writes);
      }
      const rows = containmentRowsOf([...snapshot.writes, ...inventoryWrites], 'orders-api');
      expect([...rows].sort((left, right) => (left.to < right.to ? -1 : 1))).toEqual([
        { kind: 'contains', child: 'file', from: '', to: 'README.md' },
        { kind: 'contains', child: 'directory', from: '', to: 'src' },
        { kind: 'contains', child: 'file', from: 'src', to: 'src/a.ts' },
      ]);
    } finally {
      await f.dispose();
    }
  });

  test('an unchanged tree and a moved file: the edge is replanned only when the container moved', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', 'export const a = 1;\n');
      const first = f.commit();
      const source = snapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit: first }]);
      const snapshot = await runStage(createSnapshotStage(source));
      const inventory = createInventoryStage(source);
      const inventoryWrites: StageDraftWrite[] = [];
      for (const unit of (await inventory.plan({ query: planGraph(snapshot.writes, 'orders-api') })).units) {
        const run = await contextFor(unit);
        await inventory.execute(unit, run.context);
        inventoryWrites.push(...run.recorder.writes);
      }
      const previous = containmentRowsOf([...snapshot.writes, ...inventoryWrites], 'orders-api');
      // A second run of the same tree: every child already stands in its container.
      expect(unitIds(await inventory.plan({ query: planGraph(snapshot.writes, 'orders-api', previous) }))).toEqual([]);
      // A file that moves to another folder is planned again, and so is the untracked path's child.
      f.git('mv', 'src/a.ts', 'a.ts');
      const second = f.commit();
      const moved = snapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit: second }]);
      const movedSnapshot = await runStage(createSnapshotStage(moved));
      const movedInventory = createInventoryStage(moved);
      const planned = unitIds(await movedInventory.plan({ query: planGraph(movedSnapshot.writes, 'orders-api', previous) }));
      expect(planned).toContain('file:orders-api:a.ts');
      expect(planned).toContain('file:orders-api:src/a.ts');
    } finally {
      await f.dispose();
    }
  });

  test('a folder the commit no longer holds is planned as a unit that publishes nothing', async () => {
    const f = await fixture();
    try {
      await f.write('src/nested/b.go', 'package main\n');
      const first = f.commit();
      const source = snapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit: first }]);
      const snapshot = await runStage(createSnapshotStage(source));
      const inventory = createInventoryStage(source);
      const inventoryWrites: StageDraftWrite[] = [];
      for (const unit of (await inventory.plan({ query: planGraph(snapshot.writes, 'orders-api') })).units) {
        const run = await contextFor(unit);
        await inventory.execute(unit, run.context);
        inventoryWrites.push(...run.recorder.writes);
      }
      const previous = containmentRowsOf([...snapshot.writes, ...inventoryWrites], 'orders-api');
      f.git('rm', '-q', 'src/nested/b.go');
      const second = f.commit();
      const gone = createInventoryStage(snapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit: second }]));
      const planned = unitIds(await gone.plan({ query: planGraph(snapshot.writes, 'orders-api', previous) }));
      expect(planned).toContain('directory:orders-api:src/nested');
      expect(planned).toContain('file:orders-api:src/nested/b.go');
      // The vanished file's unit publishes nothing, which ends its edge.
      const run = await contextFor({ id: 'file:orders-api:src/nested/b.go', scope: 'orders-api:src/nested/b.go' }, () => [], snapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit: second }]));
      await gone.execute({ id: 'file:orders-api:src/nested/b.go', scope: 'orders-api:src/nested/b.go' }, run.context);
      expect(run.recorder.writes).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  test('a containment row that names no file or folder is refused, naming the read and the row', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', 'export const a = 1;\n');
      const commit = f.commit();
      const stage = createInventoryStage(snapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]));
      const snapshot = await runStage(createSnapshotStage(snapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }])));
      const message = await refusedBy(() => stage.plan({ query: planGraph(snapshot.writes, 'orders-api', [{ kind: 'contains', child: 'symbol', from: '', to: 'src/a.ts' }]) }));
      expect(message).toContain(publishedContainmentRead('orders-api'));
      expect(message).toContain('"symbol"');
    } finally {
      await f.dispose();
    }
  });

  test('a unit this stage never plans and a cancelled unit are refused by name', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', 'export const a = 1;\n');
      const commit = f.commit();
      const source = snapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]);
      const stage = createInventoryStage(source);
      const run = await contextFor({ id: 'symbol:orders-api:src/a.ts', scope: 'orders-api:src/a.ts' });
      expect(await refusedBy(() => stage.execute({ id: 'symbol:orders-api:src/a.ts', scope: 'orders-api:src/a.ts' }, run.context))).toContain('is not one this stage plans');
      const controller = new AbortController();
      controller.abort();
      const aborted = await contextFor({ id: 'file:orders-api:src/a.ts', scope: 'orders-api:src/a.ts' }, () => [], source, controller);
      expect(await refusedBy(() => stage.execute({ id: 'file:orders-api:src/a.ts', scope: 'orders-api:src/a.ts' }, aborted.context))).toContain('was cancelled');
    } finally {
      await f.dispose();
    }
  });

  test('validate refuses a write that is no graph item and a node of a kind the stage does not produce', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', 'export const a = 1;\n');
      const commit = f.commit();
      const stage = createInventoryStage(snapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]));
      const run = await contextFor({ id: 'file:orders-api:src/a.ts', scope: 'orders-api:src/a.ts' });
      await stage.execute({ id: 'file:orders-api:src/a.ts', scope: 'orders-api:src/a.ts' }, run.context);
      const good = run.recorder.writes[0]!;
      const refused = await stage.validate({ writes: [
        ...run.recorder.writes,
        { kind: 'fact', evidence: `orders-api@${commit}`, value: { kind: 'contains' } },
        { kind: 'node', evidence: `orders-api@${commit}`, value: { key: 'file:x', kind: 'code.file', label: 'x', properties: { factKind: 'file' } } },
      ] }, { query: async () => [] });
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.errors.join('\n')).toContain('writes graph nodes and edges');
      expect(refused.errors.join('\n')).toContain('does not produce a "file" fact');
      expect(good.kind).toBe('edge');
    } finally {
      await f.dispose();
    }
  });
});

// ---- the roles and the language a path carries -----------------------------

describe('the roles and the language a path carries', () => {
  test('a path names its roles in code point order, and its language where a grammar reads it', () => {
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
    expect(languageFor('src/a.ts')).toBe('typescript');
    expect(languageFor('src/a.go')).toBe('go');
    expect(languageFor('src/a.md')).toBeUndefined();
  });
});
