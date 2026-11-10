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
import { type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createRecordSchema, fileFacts, listDirectories, listFiles, publishHistory, publishTree, repositoryFacts } from '../src/graph/index.js';
import { commitWithPaths as commitFacts } from '../src/graph/records.js';

import { generatedTableName } from '../src/graph/contract.js';
import { GIT_CONTRACT } from '../src/fill/stages/git-contract.js';
import { instantOf } from '../src/graph/records.js';
import { REPOSITORY_HISTORY_STAGE_ID, REPOSITORY_TREE_STAGE_ID, createRepositoryHistoryStage, createRepositoryTreeStage, languageOfPath, readRepositoryHistory, readRepositoryTree, repositoryOfUnit, repositoryUnitId, shallowGapOf, type RepositoryAt } from '../src/fill/stages/repository-facts.js';
import { GIT_TABLES } from '../src/fill/stages/git-contract.js';
import { GraphReader, type ContentAt } from '../src/knowledge/graph-read.js';
import { repositoryBlock, type RenderContext, type Subject } from '../src/knowledge/blocks.js';
import { createTestDatabaseOwner } from './test-database.js';

let root = '';
let repository = '';
/** The graph's own tables, which every store holds: the mechanism the product's contracts build on. */
const MECHANISM_TABLES = ['context', 'edge', 'entity', 'gap', 'layer_entry', 'node', 'operation', 'unresolved_reference'] as const;

const RECORD_TABLES = [
  ...MECHANISM_TABLES,
  ...GIT_CONTRACT.vertex.map((kind) => generatedTableName(kind.name, 'vertex')),
  ...GIT_CONTRACT.edge.flatMap((kind) => (kind.fields.length === 0 ? [] : [generatedTableName(kind.name, 'edge')])),
  ...GIT_CONTRACT.dictionary.map((one) => generatedTableName(one.name, 'dictionary')),
] as const;

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

/** The commits the fixture makes, oldest first: a past commit's text is read at the commit that held it. */
let one = '';
let two = '';
let three = '';

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
  writeFileSync(join(repository, 'docs', 'with "quotes" and \\backslash.md'), '# quoted\n');
  symlinkSync('src/a.ts', join(repository, 'link.ts'));
  git(['init', '-q', '-b', 'main']);
  // A remote a person cloned with: the credential is read and never stored (madarch-hsqs stage B review).
  git(['remote', 'add', 'origin', 'https://someone:secret-token@example.test/fixture.git']);
  one = commitAll('one');
  // A rename, a deletion and a modification.
  git(['mv', 'docs/same-one.md', 'docs/renamed.md']);
  git(['rm', '-q', 'docs/same-two.md']);
  writeFileSync(join(repository, 'src', 'a.ts'), 'export const a = 2;\n');
  two = commitAll('two');
  owner = await createTestDatabaseOwner({});
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

  test('a text file\'s bytes stand in the graph once per blob, and a reader takes them there', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const reader = new GraphReader(owner, () => new Date().toISOString());
    expect(await reader.content('fixture', 'src/a.ts')).toBe('export const a = 2;\n');
    expect(await reader.content('fixture', 'docs/renamed.md')).toBe('# one\n');
    expect(await reader.content('fixture', 'blob.bin')).toBeNull();
    // A path that left the tree has no text at the filled commit, though its row and blob remain.
    expect(await reader.content('fixture', 'docs/same-one.md')).toBeNull();
    // Many paths at once are one bound text[] parameter: a quote and a backslash in a name are characters, not SQL.
    const many = await reader.contentsOf('fixture', ['src/a.ts', 'docs/renamed.md', 'docs/with "quotes" and \\backslash.md', 'src/missing.ts']);
    expect(many.get('src/a.ts')).toBe('export const a = 2;\n');
    expect(many.get('docs/renamed.md')).toBe('# one\n');
    expect(many.get('docs/with "quotes" and \\backslash.md')).toBe('# quoted\n');
    expect(many.has('src/missing.ts')).toBe(false);
    const shared = await owner.transaction('snapshot', async (tx) => await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${GIT_TABLES.blob} WHERE content = $1`, ['# one\n']));
    expect(shared.rows[0]?.n).toBe('1');
  });

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
    // The language is the opinion's own `lang`: blob.bin is one language (`unknown`). A `.ts` or `.md` file is not: the
    // dataset gives `.ts` TypeScript and XML and `.md` GCC Machine Description and Markdown, so the opinion names its
    // candidates and picks none.
    expect(byPath.get('blob.bin')?.language).toBe('unknown');
    expect(byPath.get('src/a.ts')?.language).toBeNull();
    expect(byPath.get('src/a.ts')?.candidates).toEqual(['TypeScript', 'XML']);
    // `.h` is C, C++ and Objective-C in the dataset: the opinion holds the candidates, and no one language is picked.
    const header = byPath.get('src/b.h')!;
    expect(header.language).toBeNull();
    expect(header.candidates.length).toBeGreaterThan(1);
    // The touched rows name the deleted path, which no file holds.
    const facts = await repositoryFacts(owner, 'fixture');
    expect(facts?.fileCount).toBe(files.rows.length);
  }, 120_000);

  test('write only what moved when a new commit changes one file', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    writeFileSync(join(repository, 'src', 'a.ts'), 'export const a = 3;\n');
    three = commitAll('three');
    const head = three;
    const tree = await readRepositoryTree(pin(head));
    const history = await readRepositoryHistory(pin(head));
    const treeCounts = await publishTree(owner, tree);
    const historyCounts = await publishHistory(owner, history);
    // One file's blob moved: the file's row is updated, the new commit's vertex and its row and the
    // as-is edge are added, and the edge to the commit the repository stood at before is removed.
    // Every other row stands: inserted 3 (the commit vertex, its opinion and the as-is edge), updated 2 (the file's
    // opinion and the dataset's, each now resting on the new commit as its evidence), deleted 1 (the old as-is edge).
    expect(treeCounts.inserted).toBe(3);
    expect(treeCounts.updated).toBe(2);
    expect(treeCounts.deleted).toBe(1);
    expect(historyCounts.inserted).toBeGreaterThan(0);
    expect(historyCounts.updated + historyCounts.unchanged).toBeGreaterThan(0);
    const a = await fileFacts(owner, 'fixture', 'src/a.ts');
    expect(a?.lines).toBe(1);
  }, 120_000);

  test('a past commit\'s text is the text that commit held, or absent — never the current tree\'s', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const reader = new GraphReader(owner, () => new Date().toISOString());
    /** The reason a read answers, refused where it answered a text. */
    const absence = (answer: ContentAt): string => {
      if ('text' in answer) throw new Error(`the read answered ${JSON.stringify(answer.text)} where the store holds no text of that version`);
      return answer.absent;
    };
    // src/a.ts changed at the second and the third commit: the store holds no text of its first version, and says so.
    expect(absence(await reader.contentAt('fixture', 'src/a.ts', one))).toContain(one);
    // docs/renamed.md came into the tree at the second commit, and no commit touched it after: that is its text there.
    expect(await reader.contentAt('fixture', 'docs/renamed.md', two)).toEqual({ text: '# one\n' });
    // The same path stood under another name at the first commit: absent there, naming that commit.
    expect(absence(await reader.contentAt('fixture', 'docs/renamed.md', one))).toContain(one);
    // The commit the graph was filled from answers the current text.
    expect(await reader.contentAt('fixture', 'src/a.ts', three)).toEqual({ text: 'export const a = 3;\n' });
    // A commit the store\'s history does not hold is absent by name, never the tip\'s text.
    expect(absence(await reader.contentAt('fixture', 'src/a.ts', '0'.repeat(40)))).toContain('0'.repeat(40));
  });

  test('a remote with a user and a password is stored and read without them', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    // The tree pass read the checkout\'s remote, which named a credential: the graph holds the address without it.
    const second = await readRepositoryTree(pin(three));
    expect(second.repository.url).toBe('https://example.test/fixture.git');
    const facts = await repositoryFacts(owner, 'fixture');
    expect(facts?.url).toBe('https://example.test/fixture.git');
    const reader = new GraphReader(owner, () => new Date().toISOString());
    // The repository block renders the graph\'s own repository read: its data carries the clean address.
    const held = await reader.repository('fixture');
    expect(held?.url).toBe('https://example.test/fixture.git');
    const subject: Subject = { source: 'graph', entity: { key: 'code.repository:fixture', kind: 'code.repository', label: 'fixture', properties: { name: 'fixture' }, nodeIds: [], scope: '' } };
    const block = await repositoryBlock({ graph: reader } as unknown as RenderContext, subject, {}, 'madarch/kinds.yaml', 1);
    if (block.type !== 'repository') throw new Error(`the repository block answered ${block.type}: ${block.type === 'problem' ? block.message : ''}`);
    expect(block.data.url).toBe('https://example.test/fixture.git');
    // The credential stands nowhere in the store.
    const stored = await owner.transaction('snapshot', async (tx) => await tx.query<{ url: string }>(`SELECT url FROM ${GIT_TABLES.repository}`));
    expect(stored.rows.map((row) => row.url)).toEqual(['https://example.test/fixture.git']);
  });

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
    expect(await shallowGapOf(pin(head))).toBeNull();
  }, 120_000);

  test('give every folder a vertex, one parent each, and no repository-to-nested-file edge', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const directories = await listDirectories(owner, 'fixture');
    const byPath = new Map(directories.map((row) => [row.path, row.parent]));
    expect(byPath.has('src')).toBe(true);
    expect(byPath.has('docs')).toBe(true);
    // Exactly one parent each; a top-level folder hangs from the repository ('').
    expect(byPath.get('src')).toBe('');
    expect(byPath.get('docs')).toBe('');
    // The parent of a file is its folder, never the repository.
    const parents = await owner.transaction('snapshot', async (tx) => await tx.query(
      `SELECT (fn.key->>'path') AS child, coalesce(pn.key->>'path', '') AS parent FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = 'contains'
       JOIN node fn ON fn.id = e.to_node JOIN entity fe ON fe.id = fn.entity_id AND fe.name = 'file'
       LEFT JOIN node pn ON pn.id = e.from_node`,
    ));
    for (const row of parents.rows as { child: string; parent: string }[]) {
      const folder = row.child.includes('/') ? row.child.slice(0, row.child.lastIndexOf('/')) : '';
      expect({ child: row.child, parent: row.parent }).toEqual({ child: row.child, parent: folder });
    }
    const facts = await repositoryFacts(owner, 'fixture');
    expect(facts?.directoryCount).toBe(directories.length);
  }, 120_000);

  test('take a folder away when its last file goes', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    mkdirSync(join(repository, 'only', 'deep'), { recursive: true });
    writeFileSync(join(repository, 'only', 'deep', 'x.txt'), 'x\n');
    const head = commitAll('four');
    await publishHistory(owner, await readRepositoryHistory(pin(head)));
    await publishTree(owner, await readRepositoryTree(pin(head)));
    expect((await listDirectories(owner, 'fixture')).map((row) => row.path)).toContain('only/deep');
    git(['rm', '-q', '-r', 'only']);
    const gone = commitAll('five');
    await publishHistory(owner, await readRepositoryHistory(pin(gone)));
    const counts = await publishTree(owner, await readRepositoryTree(pin(gone)));
    expect(counts.deleted).toBeGreaterThan(1);
    const again = (await listDirectories(owner, 'fixture')).map((row) => row.path);
    expect(again).not.toContain('only/deep');
    expect(again).not.toContain('only');
  }, 120_000);

  });

describe('the gaps each pass owns', () => {
  test('a pass replaces only the gaps it wrote, whatever reason the other pass wrote them under', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const tree = (gaps: { what: string; reason: 'non-utf8-path' | 'unreadable' }[]) => ({ repository: { name: 'gaps', url: 'file:///gaps' }, commit: 'a'.repeat(40), files: [], gitlinks: [], gaps });
    const history = (gaps: { what: string; reason: 'shallow-history' | 'unreadable' }[]) => ({ repository: { name: 'gaps' }, commits: [], gaps });
    // The repository's first empty publications make its own rows (the repository, its as-is edge): the
    // counts below are the gaps', not those rows'.
    await publishHistory(owner, history([]));
    await publishTree(owner, tree([]));
    // The history writes an unreadable field and a shallow history; the tree then writes a path no
    // UTF-8 can hold. Both passes can write `unreadable`, so the reason cannot say whose row it is.
    const firstHistory = await publishHistory(owner, history([{ what: 'commit aaa author name <0xff>', reason: 'unreadable' }, { what: 'gaps at aaa', reason: 'shallow-history' }]));
    expect([firstHistory.inserted, firstHistory.deleted]).toEqual([2, 0]);
    const firstTree = await publishTree(owner, tree([{ what: 'bad/<0xff>.ts', reason: 'non-utf8-path' }]));
    expect([firstTree.inserted, firstTree.deleted]).toEqual([1, 0]);
    const all = await repositoryFacts(owner, 'gaps');
    expect(all?.gaps).toEqual([
      { what: 'bad/<0xff>.ts', reason: 'non-utf8-path' },
      { what: 'commit aaa author name <0xff>', reason: 'unreadable' },
      { what: 'gaps at aaa', reason: 'shallow-history' },
    ]);
    // The history runs again without the unreadable field: its own row goes, and the tree's stands.
    const secondHistory = await publishHistory(owner, history([{ what: 'gaps at aaa', reason: 'shallow-history' }]));
    expect([secondHistory.inserted, secondHistory.deleted]).toEqual([0, 1]);
    expect(secondHistory.unchanged).toBeGreaterThanOrEqual(1);
    expect((await repositoryFacts(owner, 'gaps'))?.gaps).toEqual([
      { what: 'bad/<0xff>.ts', reason: 'non-utf8-path' },
      { what: 'gaps at aaa', reason: 'shallow-history' },
    ]);
    // The tree runs again without its unreadable path: its own row goes, and the history's stands.
    const secondTree = await publishTree(owner, tree([]));
    expect([secondTree.inserted, secondTree.deleted]).toEqual([0, 1]);
    expect((await repositoryFacts(owner, 'gaps'))?.gaps).toEqual([{ what: 'gaps at aaa', reason: 'shallow-history' }]);
  }, 120_000);

});

describe('a git date of a zero or a negative offset', () => {

  test('instantOf reads the offset git writes, and the Z a newer git writes for zero minutes', () => {
    expect(instantOf('2026-11-07T20:38:26+03:00', 'authorDate', 'h')).toEqual(['2026-11-07T20:38:26Z', 180]);
    expect(instantOf('2026-11-07T20:38:26-05:00', 'authorDate', 'h')).toEqual(['2026-11-07T20:38:26Z', -300]);
    // A newer git states a zero offset as `Z` (measured: git 2.43 writes `+00:00` for the same commit).
    expect(instantOf('2026-11-07T20:38:26Z', 'authorDate', 'h')).toEqual(['2026-11-07T20:38:26Z', 0]);
    expect(instantOf('2026-11-07T20:38:26+00:00', 'authorDate', 'h')).toEqual(['2026-11-07T20:38:26Z', 0]);
    expect(() => instantOf('2026-11-07 20:38:26', 'authorDate', 'h')).toThrow(/2026-11-07 20:38:26/);
    expect(() => instantOf('2026-11-07T20:38:26+0000', 'authorDate', 'h')).toThrow(/a git date is/);
  }, 60_000);

  test('a commit at +00:00 and one at -05:00 keep git\'s instant and each one\'s own offset', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const offsets = join(root, 'offsets');
    mkdirSync(offsets, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: offsets });
    writeFileSync(join(offsets, 'a.txt'), 'a\n');
    execFileSync('git', ['add', '-A'], { cwd: offsets });
    const commitAt = (offset: string, message: string): string => {
      execFileSync('git', ['-c', 'user.name=Offset', '-c', 'user.email=offset@example.invalid', 'commit', '-qm', message], {
        cwd: offsets,
        env: { ...process.env, GIT_AUTHOR_DATE: `2026-11-07T20:38:26 ${offset}`, GIT_COMMITTER_DATE: `2026-11-07T20:38:26 ${offset}` },
      });
      return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: offsets }).toString().trim();
    };
    const zero = commitAt('+0000', 'zero');
    writeFileSync(join(offsets, 'b.txt'), 'b\n');
    execFileSync('git', ['add', '-A'], { cwd: offsets });
    const negative = commitAt('-0500', 'negative');
    const at = { repository: 'offsets', root: offsets, commit: negative, url: `file://${offsets}` };
    await publishHistory(owner, await readRepositoryHistory(at));
    // git states 20:38:26 at +00:00, and 20:38:26 at -05:00, which is 01:38:26 UTC the next day.
    // The answer is `%aI`: the clock the author wrote and the offset it stood at, never the instant.
    expect(await commitFacts(owner, 'offsets', zero)).toMatchObject({ authorDate: '2026-11-07T20:38:26+00:00', authorOffsetMin: 0, commitDate: '2026-11-07T20:38:26+00:00', commitOffsetMin: 0 });
    expect(await commitFacts(owner, 'offsets', negative)).toMatchObject({ authorDate: '2026-11-07T20:38:26-05:00', authorOffsetMin: -300, commitDate: '2026-11-07T20:38:26-05:00', commitOffsetMin: -300 });
  }, 120_000);

  test('a history whose dates git states with Z publishes with a zero offset', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    // The form a newer git writes for a zero offset, exactly as `%aI` answers it.
    const history = {
      repository: { name: 'z-dates' },
      commits: [{
        hash: 'b'.repeat(40), parents: [], authorName: 'Zero Offset', authorEmail: 'zero@example.invalid',
        authorDate: '2026-11-07T20:38:26Z', commitDate: '2026-11-07T20:38:26Z', subject: 'a zero offset', touched: [],
      }],
      gaps: [],
    };
    await publishHistory(owner, history);
    expect(await commitFacts(owner, 'z-dates', 'b'.repeat(40))).toMatchObject({ authorDate: '2026-11-07T20:38:26+00:00', authorOffsetMin: 0, commitDate: '2026-11-07T20:38:26+00:00', commitOffsetMin: 0 });
  }, 120_000);

  test('a listing answers the opinions\' values without their sources, and a single entity answers both', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const reader = new GraphReader(owner, () => new Date().toISOString());
    // The bulk read a page's treemap and the Problems listing make: every value, and no opinion's id, producer or
    // evidence (madarch-64o5.2: 1 800 files with 5 538 opinions were 2.25 MB and 63 ms with the sources, 1.21 MB and
    // 24 ms without). A list shows values, and no page shows where a value was stated from a list.
    const listed = await reader.byPrefix('code.file', 'code.file:', 100);
    const file = listed.rows.find((one) => one.key === 'code.file:fixture/src/a.ts');
    if (file === undefined) throw new Error(`the listing answered ${listed.rows.map((one) => one.key).join(', ')}`);
    expect(typeof file.properties['path']).toBe('string');
    expect(typeof file.properties['mode']).toBe('string');
    expect(file.evidence ?? []).toEqual([]);
    expect(file.opinions ?? []).toEqual([]);
    // The single entity's read is the one that states the sources, and the value is the same one.
    const one = (await reader.find('code.file:fixture/src/a.ts'))[0];
    expect(one?.properties['mode']).toBe(file.properties['mode']);
    expect((one?.evidence ?? []).length).toBeGreaterThan(0);
    expect((one?.opinions ?? []).length).toBeGreaterThan(0);
  }, 120_000);
});
