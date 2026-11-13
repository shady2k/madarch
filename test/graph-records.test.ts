import { contentsOf } from '../src/plugin/stored-text.js';
/**
 * The ordinary repository plugins (madarch-8bdc.2.5, step 1's items 1 and 2): the tables
 * this step writes, a second run at one commit writing nothing, a new commit writing only what
 * moved, and a neutral fixture for the shapes git can give a tree.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DatabaseOwner } from '../src/adapters/database-owner.js';
import { fileFacts, listDirectories, listFiles, repositoryFacts } from '../src/graph/index.js';
import { commitWithPaths as commitFacts } from '../src/graph/records.js';

import { generatedTableName } from '../src/graph/contract.js';
import { repositoryContract as GIT_CONTRACT, repositoryKindReads, repositoryEdgeReads, restrictRepositoryDeclarations } from './repository-contract-fixture.js';
import { runFill } from '../src/fill/run.js';
import { prepareStore } from '../src/adapters/prepare-store.js';
import { seedRepositoryPlugins } from './enabled-plugins-fixture.js';
import { instantOf } from '../plugins/git/main.js';
import { languageOfPath } from '../plugins/disk/reader.js';
import { GIT_KINDS, GIT_TABLES } from '../src/fill/stages/git-contract.js';
import { GraphReader } from '../src/knowledge/graph-read.js';
import { ensureVertex, journalFor, publishOpinion, writeJournal } from '../src/graph/write.js';
import { repositoryBlock, type RenderContext, type Subject } from '../src/knowledge/blocks.js';
import { createTestDatabaseOwner } from './test-database.js';

let root = '';
let repository = '';
let product = '';
let runSequence = 0;
/** The graph's own tables, which every store holds: the mechanism the product's contracts build on. */
const MECHANISM_TABLES = ['context', 'edge', 'entity', 'node', 'operation', 'unresolved_reference'] as const;

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

/** Runs the same declared ordinary plugins used by a product fill. */
async function fillRepository(folder = repository, name = 'fixture') {
  if (owner === undefined) throw new Error('the store was not opened');
  const fixture = folder === repository ? product : join(root, `product-${name}`);
  if (folder !== repository && !existsSync(fixture)) makeProduct(fixture, folder, name);
  const result = await runFill({ product: fixture, database: owner, home: join(root, 'home'), runId: `records-${++runSequence}`, prepareContract: async contract => { await prepareStore(owner!, { contract }); } });
  if (!result.ok) throw new Error(`fill refused: ${result.reason}`);
  expect(result.state).toBe('succeeded');
  return result;
}

function makeProduct(folder: string, source: string, name: string): void {
  mkdirSync(join(folder, 'repos'), { recursive: true });
  symlinkSync(source, join(folder, 'repos', name));
  writeFileSync(join(folder, 'workspace.yaml'), `schemaVersion: 1\nid: 8a1c6f2e-4f2b-4b8a-9f7e-1a2b3c4d5e6f\nname: records\nrepos:\n  - name: ${name}\n    url: file://${source}\n`);
  seedRepositoryPlugins(folder);
  restrictRepositoryDeclarations(folder);
  execFileSync('git', ['init', '-q'], { cwd: folder });
  execFileSync('git', ['add', '-A'], { cwd: folder });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Declare repository plugins'], { cwd: folder });
}

/** The commits the fixture makes, oldest first: a past commit's text is read at the commit that held it. */
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
  commitAll('one');
  // A rename, a deletion and a modification.
  git(['mv', 'docs/same-one.md', 'docs/renamed.md']);
  git(['rm', '-q', 'docs/same-two.md']);
  writeFileSync(join(repository, 'src', 'a.ts'), 'export const a = 2;\n');
  commitAll('two');
  product = join(root, 'product');
  makeProduct(product, repository, 'fixture');
  owner = await createTestDatabaseOwner({ graphContract: GIT_CONTRACT });
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

test('file-only facts need no repository entity or history, and a missing file is null', async () => {
  const files = await createTestDatabaseOwner({ graphContract: {
    vertex: GIT_CONTRACT.vertex.filter((kind) => kind.name === GIT_KINDS.file),
    edge: [], dictionary: [],
  } });
  try {
    const blob = 'b'.repeat(40);
    await files.transaction('write', async (tx) => {
      const journal = journalFor('disk@1');
      const node = await ensureVertex(tx, GIT_CONTRACT, { kind: GIT_KINDS.file, key: { repository: 'files-only', path: 'src/one.ts' } }, 1, journal);
      await publishOpinion(tx, GIT_CONTRACT, {
        kind: GIT_KINDS.file, nodeId: node.nodeId, producer: 'disk', producerVersion: '1',
        values: { mode: '100644', blob, bytes: 20, form: 'text', lines: 1, content: 'export const n = 1;\n', language: 'TypeScript', languages: ['TypeScript'] },
      }, 1, journal);
      await writeJournal(tx, journal);
    });
    const repositories = await files.run((tx) => tx.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM node n JOIN entity e ON e.id = n.entity_id WHERE e.name = $1',
      [GIT_KINDS.repository],
    ));
    expect(repositories.rows).toEqual([{ count: '0' }]);
    expect(await fileFacts(files, 'files-only', 'src/one.ts', { history: false })).toMatchObject({
      path: 'src/one.ts', mode: '100644', blob, bytes: 20, form: 'text', lines: 1,
      language: 'TypeScript', candidates: ['TypeScript'],
      created: null, modified: null, commitCount: 0, authors: [],
    });
    expect(await fileFacts(files, 'files-only', 'src/missing.ts', { history: false })).toBeNull();
  } finally {
    await files.close();
  }
});

describe('the two passes over one fixture', () => {
  test('write the tree and the history, and a second run writes nothing', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const first = await fillRepository();
    const roots = first.units.filter(unit => !unit.unitId.includes('#')).map(unit => unit.unitId).sort();
    expect(roots).toEqual(['disk:code.directory', 'disk:code.file', 'disk:code.gitlink', 'disk:code.repository',
      'git:code.author', 'git:code.commit', 'git:code.file', 'git:code.repository'].map(id => `plugin-turns/${id}`).sort());
    expect(first.units.every(unit => unit.stageId === 'plugin-turns')).toBe(true);
    const before = await owner.transaction('snapshot', tx => tx.query(`SELECT count(*)::integer AS n FROM operation`));
    const second = await fillRepository();
    expect([...new Set(second.reused.map(id => id.split('#')[0]))].sort()).toEqual(roots);
    const after = await owner.transaction('snapshot', tx => tx.query(`SELECT count(*)::integer AS n FROM operation`));
    expect(after.rows).toEqual(before.rows);
  }, 120_000);

  test('every opinion event of the tree and the history pass names its vertex by uid and its own producer', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const entries = await owner.transaction('snapshot', async (tx) => await tx.query<{ change: { opinions: { node?: string; said_by: string; state: string; values?: Record<string, unknown>; evidence?: unknown[]; context?: number; said_at?: string }[] } }>(
      `SELECT change FROM operation WHERE split_part(author, '@', 1) IN ('disk', 'git') ORDER BY seq`,
    ));
    const opinions = entries.rows.flatMap((row) => row.change.opinions);
    expect(opinions.length).toBeGreaterThan(10);
    // A node's opinion states the vertex's uid — though the pass holds its local node id — and an edge's its edge;
    // a replay names no local id of this store.
    expect(opinions.every((one) => typeof one.node === 'string' ? one.node.length === 36 : typeof (one as { edge?: string }).edge === 'string')).toBe(true);
    // Inventory and history identify their ordinary plugin producers, with language candidates kept as fields.
    expect(new Set(opinions.map((one) => one.said_by.split('@')[0]))).toEqual(new Set(['disk', 'git']));
    // An opened opinion carries what a replay needs: its values, its evidence, its context and the moment it was said.
    const opened = opinions.filter((one) => one.state === 'opened');
    expect(opened.length).toBeGreaterThan(5);
    expect(opened.every((one) => one.values !== undefined && Array.isArray(one.evidence) && one.context === 1 && typeof one.said_at === 'string' && one.said_at.length > 10)).toBe(true);
  }, 120_000);

  test('a text file\'s bytes stand in ordinary opinions, and a reader takes them there', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const reader = new GraphReader(owner, () => new Date().toISOString(), undefined, undefined, undefined, repositoryKindReads, repositoryEdgeReads);
    expect(await contentsOf(reader, 'fixture', ['src/a.ts']).then(texts => texts.get('src/a.ts') ?? null)).toBe('export const a = 2;\n');
    expect(await contentsOf(reader, 'fixture', ['docs/renamed.md']).then(texts => texts.get('docs/renamed.md') ?? null)).toBe('# one\n');
    expect(await contentsOf(reader, 'fixture', ['blob.bin']).then(texts => texts.get('blob.bin') ?? null)).toBeNull();
    // A path that left the tree has no text at the filled commit, though its row and blob remain.
    expect(await contentsOf(reader, 'fixture', ['docs/same-one.md']).then(texts => texts.get('docs/same-one.md') ?? null)).toBeNull();
    // Many paths at once are one bound text[] parameter: a quote and a backslash in a name are characters, not SQL.
    const many = await contentsOf(reader, 'fixture', ['src/a.ts', 'docs/renamed.md', 'docs/with "quotes" and \\backslash.md', 'src/missing.ts']);
    expect(many.get('src/a.ts')).toBe('export const a = 2;\n');
    expect(many.get('docs/renamed.md')).toBe('# one\n');
    expect(many.get('docs/with "quotes" and \\backslash.md')).toBe('# quoted\n');
    expect(many.has('src/missing.ts')).toBe(false);
    const shared = await owner.transaction('snapshot', async (tx) => await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${GIT_TABLES.file} WHERE content = $1 AND state = 'open'`, ['# one\n']));
    expect(shared.rows[0]?.n).toBe('1');
  });

  test('read git\'s shapes: a rename, a deleted path, a binary, two paths on one blob, a symlink, an extension several languages claim, a space and a newline, a merge', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const files = await listFiles(owner, { repository: 'fixture', limit: 100 });
    const byPath = new Map(files.rows.filter((row) => row.mode !== null).map((row) => [row.path, row]));
    expect(byPath.has('docs/renamed.md')).toBe(true);
    expect(byPath.has('docs/same-one.md')).toBe(false);
    expect(byPath.has('docs/same-two.md')).toBe(false);
    expect(byPath.has('with space and\nnewline.txt')).toBe(true);
    expect(byPath.get('link.ts')?.mode).toBe('120000');
    // Blob identity remains a field of the ordinary file opinion.
    expect(byPath.get('docs/renamed.md')?.blob).toBe(byPath.get('docs/renamed.md')?.blob);
    expect(byPath.get('blob.bin')?.form).toBe('binary');
    expect(byPath.get('blob.bin')?.lines).toBeNull();
    // The extension dataset supplies candidates, but no text heuristic chooses among them.
    expect(byPath.get('blob.bin')?.language).toBe('unknown');
    expect(byPath.get('src/a.ts')?.language).toBe('ambiguous');
    expect(byPath.get('src/a.ts')?.candidates).toEqual(['TypeScript', 'XML']);
    const header = byPath.get('src/b.h')!;
    expect(header.language).toBe('ambiguous');
    expect(header.candidates).toEqual(['C', 'C++', 'Objective-C']);
    // The touched rows name the deleted path, which no file holds.
    const facts = await repositoryFacts(owner, 'fixture');
    expect(facts?.fileCount).toBe(files.rows.length);
  }, 120_000);

  test('write only what moved when a new commit changes one file', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    writeFileSync(join(repository, 'src', 'a.ts'), 'export const a = 3;\n');
    three = commitAll('three');
    const before = await owner.transaction('snapshot', tx => tx.query<{ id: string }>(`SELECT (n.key->>'path') AS path, o.mode, o.blob, o.bytes, o.lines, o.content FROM ${GIT_TABLES.file} o JOIN node n ON n.id = o.node_id WHERE o.state = 'open' AND n.key->>'path' <> 'src/a.ts' ORDER BY n.key->>'path'`));
    const old = await fileFacts(owner, 'fixture', 'src/a.ts');
    const run = await fillRepository();
    expect(run.units.every(unit => unit.state === 'published')).toBe(true);
    const moved = await fileFacts(owner, 'fixture', 'src/a.ts');
    expect(moved?.blob).not.toBe(old?.blob);
    expect(await commitFacts(owner, 'fixture', three)).toMatchObject({ hash: three, subject: 'three' });
    const after = await owner.transaction('snapshot', tx => tx.query<{ id: string }>(`SELECT (n.key->>'path') AS path, o.mode, o.blob, o.bytes, o.lines, o.content FROM ${GIT_TABLES.file} o JOIN node n ON n.id = o.node_id WHERE o.state = 'open' AND n.key->>'path' <> 'src/a.ts' ORDER BY n.key->>'path'`));
    const canonical = (rows: readonly unknown[]) => rows.map(row => JSON.stringify(row)).sort();
    expect(canonical(after.rows)).toEqual(canonical(before.rows));
    const a = await fileFacts(owner, 'fixture', 'src/a.ts');
    expect(a?.lines).toBe(1);
  }, 120_000);



  test('a file\'s language is an opinion field: a changed language closes the old opinion, and the filter reads the field', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    // The tree's dataset opinion states candidates in ordinary fields, never in the text's natural-language tag.
    const stored = await owner.transaction('snapshot', async (tx) => await tx.query<{ lang: string | null; language: string | null; languages: unknown }>(
      `SELECT o."lang", o."language", o."languages" FROM ${GIT_TABLES.file} o JOIN node n ON n.id = o."node_id"
       WHERE o."state" = 'open' AND (n.key->>'path') = 'src/a.ts' AND split_part(o."said_by", '@', 1) = 'disk'`,
    ));
    expect(stored.rows).toEqual([{ lang: null, language: 'ambiguous', languages: ['TypeScript', 'XML'] }]);
    const node = await owner.transaction('write', async (tx) => await ensureVertex(tx, GIT_CONTRACT, { kind: GIT_KINDS.file, key: { repository: 'fixture', path: 'src/a.ts' } }));
    // The producer states one language, then another: a changed value closes the opinion it supersedes, so one open
    // opinion of the producer is left. Before the move both rows matched on the producer and stayed open.
    await owner.transaction('write', async (tx) => await publishOpinion(tx, GIT_CONTRACT, { kind: GIT_KINDS.file, nodeId: node.nodeId, producer: 'disk', producerVersion: '9.5.0', values: { language: 'TypeScript', languages: ['TypeScript', 'XML'] }, lang: null }));
    const first = await owner.transaction('snapshot', async (tx) => await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${GIT_TABLES.file} WHERE "node_id" = $1::bigint AND "state" = 'open' AND split_part("said_by", '@', 1) = 'disk'`, [node.nodeId],
    ));
    expect(first.rows[0]?.n).toBe('1');
    await owner.transaction('write', async (tx) => await publishOpinion(tx, GIT_CONTRACT, { kind: GIT_KINDS.file, nodeId: node.nodeId, producer: 'disk', producerVersion: '9.5.0', values: { language: 'JavaScript', languages: ['JavaScript'] }, lang: null }));
    const states = await owner.transaction('snapshot', async (tx) => await tx.query<{ state: string; language: string | null; lang: string | null }>(
      `SELECT "state", "language", "lang" FROM ${GIT_TABLES.file} WHERE "node_id" = $1::bigint AND split_part("said_by", '@', 1) = 'disk' ORDER BY "id"`, [node.nodeId],
    ));
    expect(states.rows.filter((row) => row.state === 'open')).toHaveLength(1);
    expect(states.rows.every((row) => row.lang === null)).toBe(true);
    expect(states.rows.filter((row) => row.state === 'open')[0]).toMatchObject({ language: 'JavaScript', lang: null });
    expect(states.rows.some((row) => row.state === 'closed' && row.language === 'TypeScript')).toBe(true);
    // The language filter reads the field: the new language finds the file and the one it superseded does not.
    expect((await listFiles(owner, { repository: 'fixture', language: 'JavaScript', limit: 10 })).rows.map((row) => row.path)).toContain('src/a.ts');
    expect((await listFiles(owner, { repository: 'fixture', language: 'TypeScript', limit: 10 })).rows.map((row) => row.path)).not.toContain('src/a.ts');
  }, 120_000);

  test('a remote with a user and a password is stored and read without them', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    // The tree pass read the checkout\'s remote, which named a credential: the graph holds the address without it.
    expect(git(['remote', 'get-url', 'origin'])).toBe('https://someone:secret-token@example.test/fixture.git');
    const facts = await repositoryFacts(owner, 'fixture');
    expect(facts?.url).toBe('https://example.test/fixture.git');
    const reader = new GraphReader(owner, () => new Date().toISOString(), undefined, undefined, undefined, repositoryKindReads, repositoryEdgeReads);
    // The repository block renders the graph\'s own repository read: its data carries the clean address.
    const held = await reader.repository('fixture');
    expect(held?.url).toBe('https://example.test/fixture.git');
    const subject: Subject = { source: 'graph', entity: { key: 'code.repository:fixture', kind: 'code.repository', label: 'fixture', properties: { name: 'fixture' }, nodeIds: [], scope: '' } };
    const block = await repositoryBlock({ graph: reader } as unknown as RenderContext, subject, {}, 'madarch/catalog.yaml', 1);
    if (block.type !== 'repository') throw new Error(`the repository block answered ${block.type}: ${block.type === 'problem' ? block.message : ''}`);
    expect(block.data.url).toBe('https://example.test/fixture.git');
    // The credential stands nowhere in the store.
    // The tree states the address; the history's own opinion of the repository states only its shallow fact, so its
    // url column is null — and the credential stands in neither.
    const stored = await owner.transaction('snapshot', async (tx) => await tx.query<{ url: string | null }>(`SELECT url FROM ${GIT_TABLES.repository} ORDER BY id`));
    expect(stored.rows.map((row) => row.url).filter((url) => url !== null).sort()).toEqual(['', 'https://example.test/fixture.git']);
  });

  test('ordinary output units execute through the plugin runtime', async () => {
    const run = await fillRepository();
    expect(run.units).toEqual([]);
    expect([...new Set(run.reused.map(id => id.split('#')[0]))].sort()).toEqual(['disk:code.directory', 'disk:code.file', 'disk:code.gitlink', 'disk:code.repository', 'git:code.author', 'git:code.commit', 'git:code.file', 'git:code.repository'].map(id => `plugin-turns/${id}`).sort());
    expect(languageOfPath('x.unknown-ext').language).toBe('unknown');
    expect(git(['rev-parse', '--is-shallow-repository'])).toBe('false');
    expect((await repositoryFacts(owner!, 'fixture'))?.historyShallow).toBe(false);
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
      `SELECT (fn.key->>'path') AS child, coalesce(pn.key->>'path', '') AS parent FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = 'code.contains'
       JOIN node fn ON fn.id = e.to_node JOIN entity fe ON fe.id = fn.entity_id AND fe.name = 'code.file'
       LEFT JOIN node pn ON pn.id = e.from_node`,
    ));
    expect(parents.rows.length).toBeGreaterThan(0);
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
    commitAll('four');
    await fillRepository();
    expect((await listDirectories(owner, 'fixture')).map((row) => row.path)).toContain('only/deep');
    git(['rm', '-q', '-r', 'only']);
    commitAll('five');
    await fillRepository();
    const again = (await listDirectories(owner, 'fixture')).map((row) => row.path);
    expect(again).not.toContain('only/deep');
    expect(again).not.toContain('only');
  }, 120_000);

  });

describe('a shallow clone is the history pass\'s own opinion of the repository', () => {
  test('a shallow clone is stated by the pass, and a deeper clone takes the statement back', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    // Stage 3: `gap` is gone. What a pass could not read is a problem for a person, said in the run's log and trace; a
    // fact it can state about a vertex — a shallow clone — is its opinion of that vertex.
    const shallow = join(root, 'shallow');
    execFileSync('git', ['clone', '--depth=1', `file://${repository}`, shallow]);
    await fillRepository(shallow, 'shallow');
    expect((await repositoryFacts(owner, 'shallow'))?.historyShallow).toBe(true);
    const subject: Subject = { source: 'graph', entity: { key: 'code.repository:shallow', kind: 'code.repository', label: 'shallow', properties: { name: 'shallow' }, nodeIds: [], scope: '' } };
    const wireBlock = async () => {
      const reader = new GraphReader(owner!, () => new Date().toISOString(), undefined, undefined, undefined, repositoryKindReads, repositoryEdgeReads);
      const block = await repositoryBlock({ graph: reader } as unknown as RenderContext, subject, {}, 'madarch/catalog.yaml', 1);
      if (block.type !== 'repository') throw new Error(`expected repository, got ${block.type}`);
      return JSON.parse(JSON.stringify(block)).data;
    };
    expect((await wireBlock()).historyShallow).toBe(true);
    expect(await wireBlock()).not.toHaveProperty('gaps');
    // A deeper clone states false: the same producer's opinion is replaced, never added beside it.
    execFileSync('git', ['fetch', '--unshallow'], { cwd: shallow });
    await fillRepository(shallow, 'shallow');
    expect((await repositoryFacts(owner, 'shallow'))?.historyShallow).toBe(false);
    expect((await wireBlock()).historyShallow).toBe(false);
    expect(await wireBlock()).not.toHaveProperty('gaps');
    const open = await owner.transaction('snapshot', async (tx) => await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${GIT_TABLES.repository} o JOIN node n ON n.id = o."node_id" WHERE o."state" = 'open' AND split_part(o."said_by", '@', 1) = 'git' AND (n.key->>'name') = 'shallow'`,
    ));
    expect(open.rows[0]?.n).toBe('1');
  }, 120_000);
});

describe('a git date of a zero or a negative offset', () => {

  test('instantOf reads the offset git writes, and the Z a newer git writes for zero minutes', () => {
    expect(instantOf('2026-11-07T20:38:26+03:00')).toEqual(['2026-11-07T17:38:26.000Z', 180]);
    expect(instantOf('2026-11-07T20:38:26-05:00')).toEqual(['2026-11-08T01:38:26.000Z', -300]);
    // A newer git states a zero offset as `Z` (measured: git 2.43 writes `+00:00` for the same commit).
    expect(instantOf('2026-11-07T20:38:26Z')).toEqual(['2026-11-07T20:38:26.000Z', 0]);
    expect(instantOf('2026-11-07T20:38:26+00:00')).toEqual(['2026-11-07T20:38:26.000Z', 0]);
    expect(() => instantOf('2026-11-07 20:38:26')).toThrow(/2026-11-07 20:38:26/);
    expect(() => instantOf('2026-11-07T20:38:26+0000')).toThrow(/unreadable git date/);
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
    await fillRepository(at.root, at.repository);
    // git states 20:38:26 at +00:00, and 20:38:26 at -05:00, which is 01:38:26 UTC the next day.
    // The answer is `%aI`: the clock the author wrote and the offset it stood at, never the instant.
    expect(await commitFacts(owner, 'offsets', zero)).toMatchObject({ authorDate: '2026-11-07T20:38:26+00:00', authorOffsetMin: 0, commitDate: '2026-11-07T20:38:26+00:00', commitOffsetMin: 0 });
    expect(await commitFacts(owner, 'offsets', negative)).toMatchObject({ authorDate: '2026-11-07T20:38:26-05:00', authorOffsetMin: -300, commitDate: '2026-11-07T20:38:26-05:00', commitOffsetMin: -300 });
  }, 120_000);

  test('a history whose dates git states with Z publishes with a zero offset', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    // Newer Git's Z form and explicit zero offset denote the same instant and stored offset.
    expect(instantOf('2026-11-07T20:38:26Z')).toEqual(instantOf('2026-11-07T20:38:26+00:00'));
    const held = await commitFacts(owner, 'offsets', execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: join(root, 'offsets') }).toString().trim());
    expect(held).toMatchObject({ authorDate: '2026-11-07T20:38:26+00:00', authorOffsetMin: 0, commitDate: '2026-11-07T20:38:26+00:00', commitOffsetMin: 0 });
  }, 120_000);

  test('a listing answers the opinions\' values without their sources, and a single entity answers both', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const reader = new GraphReader(owner, () => new Date().toISOString(), undefined, undefined, undefined, repositoryKindReads, repositoryEdgeReads);
    // The bulk read a page's treemap and the Problems listing make: every value, and no opinion's id, producer or
    // evidence (madarch-64o5.2: 1 800 files with 5 538 opinions were 2.25 MB and 63 ms with the sources, 1.21 MB and
    // 24 ms without). A list shows values, and no page shows where a value was stated from a list.
    let page = await reader.byPrefix('code.file', 'code.file:', 100);
    const listed = { total: page.total, rows: [...page.rows] };
    while (page.rows.length !== 0) {
      page = await reader.byPrefix('code.file', 'code.file:', 100, page.rows.at(-1)!.key);
      listed.rows.push(...page.rows);
    }
    expect(listed.rows).toHaveLength(listed.total);
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
