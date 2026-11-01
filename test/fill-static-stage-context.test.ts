/**
 * The static stage context (decision 0033, "Capability boundaries" and "The
 * file is the unit of static work"): one repository's path-scoped answers and
 * bounded graph reads, with no whole-tree reader in a stage's hands.
 *
 * Every expectation comes from the decision, never from the module: a file's
 * bytes are read at the pinned commit and a file above the cap is a named gap;
 * a folder stands while a file stands under it; a graph read answers a bounded
 * number of rows and refuses a wider answer; a symbol's global name is its
 * file's place and its qualified name; and two passes over one generated
 * repository write the same facts.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitSnapshotSource } from '../src/fill/snapshot.js';
import { DEFAULT_STAGE_LIMITS, type StageContext, type StageDraftWrite, type StageUnit } from '../src/fill/stage.js';
import { createInventoryStage } from '../src/fill/stages/inventory.js';
import { globalSymbolName } from '../src/fill/stages/syntax-facts.js';
import { STATIC_FILE_BYTE_LIMIT, STATIC_READ_ROW_LIMIT, staticStageContext, staticStageSourceOf } from '../src/fill/stages/static-context.js';
import { createSyntaxStage } from '../src/fill/stages/syntax.js';

/** A throwaway repository the test commits into by hand. */
interface Fixture {
  readonly root: string;
  commit(): string;
  git(...args: string[]): string;
  write(path: string, text: string): Promise<void>;
  dispose(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'madarch-static-context-'));
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

/** One unit's context over a static source: the tracked graph answers the test names. */
async function contextFor(unit: StageUnit, source: Awaited<ReturnType<typeof staticStageSourceOf>>, answer: (read: string) => readonly unknown[] = () => []): Promise<{ context: StageContext; writes: StageDraftWrite[]; queries: string[] }> {
  const writes: StageDraftWrite[] = [];
  const queries: string[] = [];
  const graph = {
    query: async (read: string) => {
      queries.push(read);
      return answer(read);
    },
  };
  return {
    writes,
    queries,
    context: {
      unit,
      config: { id: 'test', version: 1, enabled: true, concurrency: 1, limits: DEFAULT_STAGE_LIMITS, config: {} },
      graph,
      static: staticStageContext(source, graph),
      draft: { write: (entry) => { writes.push(entry); }, writes: () => ({ writes }) },
      progress: () => undefined,
      signal: new AbortController().signal,
    },
  };
}

/** The facts a draft set holds, in the order they were written. */
function factsOf(writes: readonly StageDraftWrite[]): readonly { readonly kind: string; readonly id: string; readonly value: Record<string, unknown> }[] {
  return writes.filter((write) => write.kind === 'fact').map((write) => write.value as { kind: string; id: string; value: Record<string, unknown> });
}

describe('one pinned repository, read through the static context', () => {
  test('a file’s bytes, its entry and the folder it stands in are read at the pinned commit, and nothing lists the tree', async () => {
    const f = await fixture();
    try {
      await f.write('src/orders.ts', 'export function create(): void {}\n');
      const commit = f.commit();
      const source = await staticStageSourceOf(createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]), 'orders-api');
      expect(source.repository).toBe('orders-api');
      expect(source.commit).toBe(commit);
      expect(await source.entry('src/orders.ts')).toEqual({ path: 'src/orders.ts', form: 'blob', id: f.git('rev-parse', `${commit}:src/orders.ts`).trim(), bytes: 'export function create(): void {}\n'.length });
      expect(await source.entry('src/missing.ts')).toBeUndefined();
      expect(await source.holdsDirectory('src')).toBe(true);
      expect(await source.holdsDirectory('src/missing')).toBe(false);
      const file = await source.file('src/orders.ts');
      expect(file?.content === undefined ? undefined : new TextDecoder().decode(file.content)).toBe('export function create(): void {}\n');
      expect(file?.unread).toBeUndefined();
    } finally {
      await f.dispose();
    }
  }, 20_000);

  test('a file above the cap answers its metadata and no bytes, so a stage can name the gap', async () => {
    const f = await fixture();
    try {
      await f.write('big.ts', `${'a'.repeat(STATIC_FILE_BYTE_LIMIT + 1)}`);
      const commit = f.commit();
      const source = await staticStageSourceOf(createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]), 'orders-api');
      const file = await source.file('big.ts');
      expect(file?.unread).toBe('too-large');
      expect(file?.content).toBeUndefined();
      expect(file?.bytes).toBe(STATIC_FILE_BYTE_LIMIT + 1);
    } finally {
      await f.dispose();
    }
  }, 20_000);

  test('a graph read answers within its cap, and a wider answer is refused rather than cut', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', 'export const a = 1;\n');
      const commit = f.commit();
      const source = await staticStageSourceOf(createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]), 'orders-api');
      const rows = Array.from({ length: 3 }, (_, index) => ({ id: `file:${index}`, value: { repository: 'orders-api' } }));
      const read = staticStageContext(source, { query: async () => rows });
      expect(await read.read('a read', { limit: 3 })).toEqual(rows);
      await expect(read.read('a read', { limit: 2 })).rejects.toThrow('answered 3 rows where the cap is 2');
      await expect(read.read('a read', { limit: STATIC_READ_ROW_LIMIT + 1 })).rejects.toThrow(`1 to ${STATIC_READ_ROW_LIMIT}`);
    } finally {
      await f.dispose();
    }
  }, 20_000);

  test('a symbol is queried by its global name, in this repository only, through the graph’s own read', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', 'export const a = 1;\n');
      const commit = f.commit();
      const source = await staticStageSourceOf(createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]), 'orders-api');
      const asked: string[] = [];
      const mine = { kind: 'symbol', value: { repository: 'orders-api', file: 'src/a.ts', globalName: 'orders-api:src/a.ts#a' } };
      const theirs = { kind: 'symbol', value: { repository: 'catalog-api', file: 'src/a.ts', globalName: 'catalog-api:src/a.ts#a' } };
      const read = staticStageContext(source, {
        query: async (text) => {
          asked.push(text);
          return [mine, theirs];
        },
      });
      expect(await read.byGlobalName('orders-api:src/a.ts#a')).toEqual([mine]);
      expect(JSON.parse(asked[0]!)).toEqual({ read: 'facts-with', kind: 'symbol', field: 'globalName', value: 'orders-api:src/a.ts#a' });
    } finally {
      await f.dispose();
    }
  }, 20_000);
});

describe('the static stages over one generated repository', () => {
  test('two passes write the same facts, the second plans nothing, and a symbol carries its global name', async () => {
    const f = await fixture();
    try {
      for (let index = 0; index < 40; index += 1) {
        const next = index + 1 < 40 ? `import { value${index + 1} } from './file${index + 1}.js';\n` : '';
        await f.write(`src/file${index}.ts`, `${next}export const value${index} = ${index};\n`);
      }
      const commit = f.commit();
      const source = createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]);
      const inventory = createInventoryStage(source);
      const syntax = createSyntaxStage(source);
      const repository = await staticStageSourceOf(source, 'orders-api');

      const firstTree: StageDraftWrite[] = [];
      for (const unit of (await inventory.plan({ query: async () => [] })).units) {
        const run = await contextFor(unit, repository);
        await inventory.execute(unit, run.context);
        firstTree.push(...run.writes);
      }
      const firstWrites: StageDraftWrite[] = [];
      for (const unit of (await syntax.plan({ query: async () => [] })).units) {
        const run = await contextFor(unit, repository);
        await syntax.execute(unit, run.context);
        firstWrites.push(...run.writes);
      }
      const symbols = factsOf(firstWrites).filter((fact) => fact.kind === 'symbol');
      expect(symbols.length).toBe(40);
      expect(symbols[0]?.value['globalName']).toBe(globalSymbolName('orders-api', 'src/file0.ts', 'value0'));

      // A second pass of the same commit: the plan reads what the first wrote
      // and names no unit, so the same bytes answer the same facts and nothing
      // is written twice.
      const publishedRows = firstTree.filter((write) => write.kind === 'fact').map((write) => write.value as { kind: string; value: { path: string; blob?: string } });
      const treeRows = publishedRows
        .filter((fact) => fact.kind === 'file' || fact.kind === 'directory')
        .map((fact) => ({ kind: fact.kind, repository: 'orders-api', path: String(fact.value.path), ...(fact.kind === 'file' && typeof fact.value.blob === 'string' ? { blob: fact.value.blob } : {}) }));
      expect((await inventory.plan({ query: async () => treeRows })).units).toEqual([]);
      const syntaxRows = { tree: treeRows, gaps: [], imports: [] };
      const second = await syntax.plan({ query: async (read) => {
        if (read.includes('stage-1-published-tree')) return syntaxRows.tree;
        if (read.includes('stage-3-coverage-gaps')) return syntaxRows.gaps;
        if (read.includes('stage-4-published-imports')) return syntaxRows.imports;
        return [];
      } });
      expect(second.units).toEqual([]);
    } finally {
      await f.dispose();
    }
  }, 60_000);
});

describe('the static stages name what they cannot read', () => {
  test('a file above the cap is a too-large gap in the syntax stage, and its inventory fact keeps its metadata', async () => {
    const f = await fixture();
    try {
      await f.write('big.ts', `${'a'.repeat(STATIC_FILE_BYTE_LIMIT + 1)}`);
      const commit = f.commit();
      const source = createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]);
      const repository = await staticStageSourceOf(source, 'orders-api');

      const inventory = createInventoryStage(source);
      const inventoryRun = await contextFor({ id: 'file:orders-api:big.ts', scope: 'orders-api:big.ts' }, repository);
      await inventory.execute({ id: 'file:orders-api:big.ts', scope: 'orders-api:big.ts' }, inventoryRun.context);
      const file = factsOf(inventoryRun.writes).find((fact) => fact.kind === 'file');
      expect(file?.value['bytes']).toBe(STATIC_FILE_BYTE_LIMIT + 1);

      const syntax = createSyntaxStage(source);
      const syntaxRun = await contextFor({ id: 'file:orders-api:big.ts', scope: 'orders-api:big.ts' }, repository);
      await syntax.execute({ id: 'file:orders-api:big.ts', scope: 'orders-api:big.ts' }, syntaxRun.context);
      const coverage = factsOf(syntaxRun.writes).find((fact) => fact.kind === 'coverage');
      expect(coverage?.value).toMatchObject({ complete: false, read: [], unread: [{ what: 'big.ts', reason: 'too-large' }] });
      expect(factsOf(syntaxRun.writes).filter((fact) => fact.kind === 'symbol')).toEqual([]);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  test('a symbolic link is an unsupported gap, never its target path parsed as source', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', 'export const a = 1;\n');
      const { symlink } = await import('node:fs/promises');
      await symlink('src/a.ts', join(f.root, 'link.ts'));
      const commit = f.commit();
      const source = createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]);
      const syntax = createSyntaxStage(source);
      const repository = await staticStageSourceOf(source, 'orders-api');
      const run = await contextFor({ id: 'file:orders-api:link.ts', scope: 'orders-api:link.ts' }, repository);
      await syntax.execute({ id: 'file:orders-api:link.ts', scope: 'orders-api:link.ts' }, run.context);
      const coverage = factsOf(run.writes).find((fact) => fact.kind === 'coverage');
      expect(coverage?.value).toMatchObject({ complete: false, read: [], unread: [{ what: 'link.ts', reason: 'unsupported' }] });
    } finally {
      await f.dispose();
    }
  }, 30_000);

  test('an import is tied to the file the pinned tree holds under its specifier, and a missing one is a gap', async () => {
    const f = await fixture();
    try {
      await f.write('src/b.ts', 'export const b = 1;\n');
      await f.write('src/a.ts', "import { b } from './b.js';\nimport { missing } from './missing.js';\n");
      const commit = f.commit();
      const source = createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]);
      const syntax = createSyntaxStage(source);
      const repository = await staticStageSourceOf(source, 'orders-api');
      const run = await contextFor({ id: 'file:orders-api:src/a.ts', scope: 'orders-api:src/a.ts' }, repository);
      await syntax.execute({ id: 'file:orders-api:src/a.ts', scope: 'orders-api:src/a.ts' }, run.context);
      const imports = factsOf(run.writes).filter((fact) => fact.kind === 'import');
      expect(imports.map((fact) => fact.value['specifier'])).toEqual(['./b.js']);
      const coverage = factsOf(run.writes).find((fact) => fact.kind === 'coverage');
      expect(coverage?.value['unread']).toEqual([{ what: './missing.js', reason: 'unsupported' }]);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  test('a cancelled unit raises before the stage reads its file', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', 'export const a = 1;\n');
      const commit = f.commit();
      const source = createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]);
      const repository = await staticStageSourceOf(source, 'orders-api');
      const syntax = createSyntaxStage(source);
      const run = await contextFor({ id: 'file:orders-api:src/a.ts', scope: 'orders-api:src/a.ts' }, repository);
      // The context's signal is the test's own controller, aborted below.
      const controller = new AbortController();
      controller.abort();
      const aborted = { ...run.context, signal: controller.signal };
      await expect(syntax.execute({ id: 'file:orders-api:src/a.ts', scope: 'orders-api:src/a.ts' }, aborted)).rejects.toThrow('was cancelled');
    } finally {
      await f.dispose();
    }
  }, 30_000);

  test('a global name is never empty, and a read asks for at most the context’s own cap', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', 'export const a = 1;\n');
      const commit = f.commit();
      const source = await staticStageSourceOf(createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]), 'orders-api');
      const read = staticStageContext(source, { query: async () => [] });
      await expect(read.byGlobalName('  ')).rejects.toThrow('non-empty');
      await expect(read.byGlobalName('orders-api:src/a.ts#a', { limit: 0 })).rejects.toThrow('1 to');
      expect(await read.read('a read')).toEqual([]);
    } finally {
      await f.dispose();
    }
  }, 30_000);
});
