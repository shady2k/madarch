/**
 * The static stage context (decision 0033, "Capability boundaries" and "The
 * file is the unit of static work"): one repository's path-scoped answers and
 * three bounded graph reads, with no whole-tree reader in a stage's hands.
 *
 * Every expectation comes from the decision, never from the module: a file's
 * bytes are read at the pinned commit and a file above the cap is a named gap;
 * a folder stands while a file stands under it; a graph read answers a bounded
 * number of nodes and refuses a wider answer; a key and a global name are
 * asked of the graph, and a neighbourhood follows the relations it names.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitSnapshotSource } from '../src/fill/snapshot.js';
import {
  STATIC_FILE_BYTE_LIMIT, STATIC_READ_ROW_LIMIT, staticStageContext, staticStageSourceOf,
  type StaticGraphNode, type StaticGraphReader,
} from '../src/fill/stages/static-context.js';

interface Fixture {
  readonly root: string;
  commit(): string;
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
    write,
    commit(): string {
      git('add', '-A');
      git('commit', '-qm', 'fixture');
      return git('rev-parse', 'HEAD').trim();
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

/** One node the fake graph answers. */
function node(id: string, kind: string, properties: Record<string, unknown> = {}): StaticGraphNode {
  return { id, kind, label: id, properties, producer: 'fill.test', scope: '0' };
}

/** A graph reader whose every answer the test names. */
function fakeGraph(answers: Partial<StaticGraphReader> = {}): StaticGraphReader {
  return {
    byKey: answers.byKey ?? (async () => []),
    byGlobalName: answers.byGlobalName ?? (async () => []),
    neighbourhood: answers.neighbourhood ?? (async () => []),
  };
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
      expect(await source.entry('src/orders.ts')).toEqual({ path: 'src/orders.ts', form: 'blob', id: f.root !== '' ? execFileSync('git', ['rev-parse', `${commit}:src/orders.ts`], { cwd: f.root, encoding: 'utf8' }).trim() : '', bytes: 'export function create(): void {}\n'.length });
      expect(await source.entry('src/missing.ts')).toBeUndefined();
      expect(await source.holdsDirectory('src')).toBe(true);
      expect(await source.holdsDirectory('src/missing')).toBe(false);
      const file = await source.file('src/orders.ts');
      expect(file?.content === undefined ? undefined : new TextDecoder().decode(file.content)).toBe('export function create(): void {}\n');
      expect(file?.unread).toBeUndefined();
      // The tree's scalars are metadata; no method hands out its entries.
      expect(source.tree).toMatch(/^[0-9a-f]{40}$/);
      expect(source.fileCount).toBe(1);
      expect('repositoryTree' in source).toBe(false);
      expect('entries' in source).toBe(false);
    } finally {
      await f.dispose();
    }
  }, 20_000);

  test('a file above the cap answers its metadata and no bytes, so a stage can name the gap', async () => {
    const f = await fixture();
    try {
      await f.write('big.ts', 'a'.repeat(STATIC_FILE_BYTE_LIMIT + 1));
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
});

describe('three bounded graph reads', () => {
  test('a key and a global name are asked of the graph, and a wider answer is refused rather than cut', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', 'export const a = 1;\n');
      const commit = f.commit();
      const source = await staticStageSourceOf(createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]), 'orders-api');
      const asked: string[] = [];
      const graph = fakeGraph({
        byKey: async (key: string, options?: { limit?: number }) => {
          asked.push(`key:${key}:${String(options?.limit)}`);
          return [node('1', 'code.file', { recordKey: key })];
        },
        byGlobalName: async (name: string, options?: { limit?: number }) => {
          asked.push(`global:${name}:${String(options?.limit)}`);
          return [node('2', 'code.symbol', { globalName: name })];
        },
        neighbourhood: async (id: string, options) => {
          asked.push(`near:${id}:${options.relations.join(',')}:${options.direction}`);
          return [node('3', 'code.symbol')];
        },
      });
      const context = staticStageContext(source, graph);
      expect(await context.byKey('file:abc', { limit: 3 })).toHaveLength(1);
      expect(await context.byGlobalName('orders-api:src/a.ts#a')).toHaveLength(1);
      expect(await context.neighbourhood('1', { relations: ['code.contains'], direction: 'out' })).toHaveLength(1);
      expect(asked).toEqual([
        'key:file:abc:3',
        'global:orders-api:src/a.ts#a:256',
        'near:1:code.contains:out',
      ]);
      // More rows than the cap is a refusal, never a cut window.
      await expect(staticStageContext(source, fakeGraph({ byKey: async () => Array.from({ length: 4 }, (_, index) => node(String(index), 'code.file')) })).byKey('file:abc', { limit: 3 })).rejects.toThrow('answered 4 rows where the cap is 3');
      await expect(context.byKey('file:abc', { limit: STATIC_READ_ROW_LIMIT + 1 })).rejects.toThrow(`1 to ${STATIC_READ_ROW_LIMIT}`);
    } finally {
      await f.dispose();
    }
  }, 20_000);

  test('a global name and a key are never empty, and a neighbourhood names its relations', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', 'export const a = 1;\n');
      const commit = f.commit();
      const source = await staticStageSourceOf(createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]), 'orders-api');
      const context = staticStageContext(source, fakeGraph());
      await expect(context.byGlobalName('  ')).rejects.toThrow('non-empty');
      await expect(context.byKey('  ')).rejects.toThrow('non-empty');
      await expect(context.byKey('file:abc', { limit: 0 })).rejects.toThrow('1 to');
      await expect(context.neighbourhood('1', { relations: [], direction: 'out' })).rejects.toThrow('names the relations');
    } finally {
      await f.dispose();
    }
  }, 20_000);
});
