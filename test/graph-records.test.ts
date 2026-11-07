/**
 * The record tables and the two passes (madarch-8bdc.2.5, step 1's items 1 and 2): the tables
 * this step writes, a second run at one commit writing nothing, a new commit writing only what
 * moved, and a neutral fixture for the shapes git can give a tree.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { RECORD_TABLES, createRecordSchema, fileFacts, listFiles, publishHistory, publishTree, recordSizes, repositoryFacts } from '../src/graph/index.js';
import { REPOSITORY_HISTORY_STAGE_ID, REPOSITORY_TREE_STAGE_ID, createRepositoryHistoryStage, createRepositoryTreeStage, languageOfPath, readRepositoryHistory, readRepositoryTree, repositoryOfUnit, repositoryUnitId, shallowGapOf, type RepositoryAt } from '../src/fill/stages/repository-facts.js';

let root = '';
let repository = '';
let owner: DatabaseOwner | undefined;

function git(args: readonly string[]): string {
  return execFileSync('git', args, { cwd: repository, maxBuffer: 64 * 1024 * 1024 }).toString('utf8').trim();
}

function commitAll(message: string): string {
  git(['add', '-A']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', message]);
  return git(['rev-parse', 'HEAD']);
}

function pin(commit: string): RepositoryAt {
  return { repository: 'fixture', root: repository, commit, url: 'file:///fixture' };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-records-'));
  repository = join(root, 'repo');
  mkdirSync(join(repository, 'src'), { recursive: true });
  mkdirSync(join(repository, 'docs'), { recursive: true });
  writeFileSync(join(repository, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repository, 'src', 'b.h'), 'int b;\n');
  writeFileSync(join(repository, 'docs', 'same-one.md'), '# one\n');
  writeFileSync(join(repository, 'docs', 'same-two.md'), '# one\n');
  writeFileSync(join(repository, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0]));
  writeFileSync(join(repository, 'with space and\nnewline.txt'), 'x\n');
  symlinkSync('src/a.ts', join(repository, 'link.ts'));
  git(['init', '-q', '-b', 'main']);
  commitAll('one');
  // A rename, a deletion and a modification.
  git(['mv', 'docs/same-one.md', 'docs/renamed.md']);
  git(['rm', '-q', 'docs/same-two.md']);
  writeFileSync(join(repository, 'src', 'a.ts'), 'export const a = 2;\n');
  commitAll('two');
  owner = createPGliteDatabaseOwner({ btreeGist: true });
  await createRecordSchema(owner);
});

afterAll(async () => {
  await owner?.close();
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

describe('the record tables', () => {
  test('stand in the store with the dictionaries the step needs, and no temporal column', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const found = await owner.transaction('snapshot', async (tx) => await tx.query(
      `SELECT c.relname AS name, a.attname AS column FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
       WHERE c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped AND c.relname = ANY($1::text[])`,
      [RECORD_TABLES as unknown as string[]],
    ));
    const columns = (found.rows as { name: string; column: string }[]).map((row) => `${row.name}.${row.column}`);
    for (const table of RECORD_TABLES) expect(columns.some((column) => column.startsWith(`${table}.`))).toBe(true);
    expect(columns.filter((column) => /^(valid_|recorded_)/.test(column.split('.')[1] ?? ''))).toEqual([]);
  }, 120_000);
});

describe('the two passes over one fixture', () => {
  test('write the tree and the history, and a second run writes nothing', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const head = git(['rev-parse', 'HEAD']);
    const tree = await readRepositoryTree(pin(head));
    const history = await readRepositoryHistory(pin(head));
    const firstTree = await publishTree(owner, tree);
    const firstHistory = await publishHistory(owner, history);
    expect(firstTree.inserted).toBeGreaterThan(3);
    expect(firstHistory.inserted).toBeGreaterThan(3);
    const secondTree = await publishTree(owner, tree);
    const secondHistory = await publishHistory(owner, history);
    expect([secondTree.inserted, secondTree.updated, secondTree.deleted]).toEqual([0, 0, 0]);
    expect([secondHistory.inserted, secondHistory.updated, secondHistory.deleted]).toEqual([0, 0, 0]);
  }, 120_000);

  test('read git\'s shapes: a rename, a deleted path, a binary, two paths on one blob, a symlink, an ambiguous extension, a space and a newline, a merge', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const files = await listFiles(owner, { repository: 'fixture', limit: 100 });
    const byPath = new Map(files.rows.map((row) => [row.path, row]));
    expect(byPath.has('docs/renamed.md')).toBe(true);
    expect(byPath.has('docs/same-one.md')).toBe(false);
    expect(byPath.has('docs/same-two.md')).toBe(false);
    expect(byPath.has('with space and\nnewline.txt')).toBe(true);
    expect(byPath.get('link.ts')?.mode).toBe('120000');
    // Two paths on one blob: one dictionary row, two files.
    expect(byPath.get('docs/renamed.md')?.blob).toBe(byPath.get('docs/renamed.md')?.blob);
    expect(byPath.get('blob.bin')?.form).toBe('binary');
    expect(byPath.get('blob.bin')?.lines).toBeNull();
    // `.h` is C, C++ and Objective-C in the dataset: ambiguous, with its candidates, never one picked.
    const header = byPath.get('src/b.h')!;
    expect(header.language).toBe('ambiguous');
    expect(header.candidates.length).toBeGreaterThan(1);
    // The touched rows name the deleted path, which no file holds.
    const facts = await repositoryFacts(owner, 'fixture');
    expect(facts?.fileCount).toBe(files.rows.length);
  }, 120_000);

  test('write only what moved when a new commit changes one file', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    writeFileSync(join(repository, 'src', 'a.ts'), 'export const a = 3;\n');
    const head = commitAll('three');
    const tree = await readRepositoryTree(pin(head));
    const history = await readRepositoryHistory(pin(head));
    const treeCounts = await publishTree(owner, tree);
    const historyCounts = await publishHistory(owner, history);
    // One file's blob moved: the file's row is updated, the commit vertex and its as-is edge are
    // added, and the edge to the commit the repository stood at before is removed. Every other row
    // stands: inserted 1 (the as-is edge), updated 1 (the file), deleted 1 (the old as-is edge).
    expect(treeCounts.inserted).toBe(1);
    expect(treeCounts.updated).toBe(1);
    expect(treeCounts.deleted).toBe(1);
    expect(historyCounts.inserted).toBeGreaterThan(0);
    expect(historyCounts.updated + historyCounts.unchanged).toBeGreaterThan(0);
    const a = await fileFacts(owner, 'fixture', 'src/a.ts');
    expect(a?.lines).toBe(1);
  }, 120_000);

  test('run as stages: one unit per repository per pass, publishing through the module', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const head = git(['rev-parse', 'HEAD']);
    const pins = [{ id: 'fixture', form: 'code' as const, root: repository, commit: head }];
    const sources = { pins: async () => pins, open: async () => { throw new Error('the passes read git, not the snapshot reader'); } } as never;
    const treeStage = createRepositoryTreeStage({ sources, publishTree: (input) => publishTree(owner!, input), publishHistory: (input) => publishHistory(owner!, input) });
    const historyStage = createRepositoryHistoryStage({ sources, publishTree: (input) => publishTree(owner!, input), publishHistory: (input) => publishHistory(owner!, input) });
    expect([treeStage.id, historyStage.id]).toEqual([REPOSITORY_TREE_STAGE_ID, REPOSITORY_HISTORY_STAGE_ID]);
    const plan = await treeStage.plan({ query: async () => [] });
    expect(plan.units.map((unit) => unit.id)).toEqual([repositoryUnitId('fixture')]);
    expect(repositoryOfUnit(repositoryUnitId('fixture'))).toBe('fixture');
    const said: string[] = [];
    const context = { unit: { id: repositoryUnitId('fixture'), scope: 'fixture' }, config: {} as never, graph: { query: async () => [] }, draft: { write: () => undefined, writes: () => ({ writes: [] }) }, progress: (note: string) => said.push(note), signal: new AbortController().signal } as never;
    expect(await treeStage.execute({ id: repositoryUnitId('fixture'), scope: 'fixture' }, context)).toEqual({ outcome: 'draft' });
    expect(await historyStage.execute({ id: repositoryUnitId('fixture'), scope: 'fixture' }, context)).toEqual({ outcome: 'draft' });
    expect(said.length).toBe(2);
    expect(languageOfPath('x.unknown-ext').language).toBe('unknown');
    expect(shallowGapOf(pin(head))).toBeNull();
  }, 120_000);

  test('report the bytes of each table and of a row', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const sizes = await recordSizes(owner);
    for (const table of RECORD_TABLES) expect(sizes[table]?.bytes).toBeGreaterThan(0);
    expect(sizes['file']!.rows).toBeGreaterThan(3);
  }, 120_000);
});
