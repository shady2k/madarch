/**
 * The db-schema path end to end (decision 0035, items 6, 7, 15, 17 and 18; task madarch-47vw.3): the plugin reads the SQL
 * its TypeScript literals hold with parsers — a TypeScript parser for the literals, libpg_query for the SQL — and answers
 * the graph's database, tables, columns, indexes and the edges between them. A fill publishes them, and the wiki reads
 * only the graph: a table's page lists its columns and its indexes and links the file and the line that declared it, and
 * the database's page draws the tables and their foreign keys.
 *
 * A literal the parsers cannot read whole is a partial unit naming its file and its line, never a smaller answer: the
 * case runs the plugin in the sandbox with a source it holds and reads the cause it answers with.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDraft } from '../src/product/draft.js';
import { manifestWithRepo } from '../src/product/manifest.js';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { closureOf } from '../src/plugin/closure.js';
import { PluginHost } from '../src/plugin/host.js';
import { checkCgroupDelegation, cgroupParent } from '../src/plugin/cgroup.js';
import { sandboxSetupProblem } from '../src/plugin/sandbox.js';
import type { Block, PageModel } from '../src/knowledge/model.js';
import type { DiagramsBlockShape } from '../src/knowledge/views.js';
import { gitEnv } from './git-env.js';

const IDENTITY = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
const PLUGINS = fileURLToPath(new URL('..', import.meta.url));

/** The source the product's code repository holds: two tables, a foreign key, an index, an ALTER TABLE, a template the
 * SQL cannot name (the table is composed at run time) and a string that is not SQL at all. */
const SOURCE = [
  '/** The schema the service keeps in its one database. */',
  'export const SCHEMA = `',
  'CREATE TABLE parent (',
  '  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,',
  '  name text NOT NULL',
  ');',
  'CREATE TABLE child (',
  '  id bigint PRIMARY KEY,',
  '  parent_id bigint NOT NULL REFERENCES parent (id) ON DELETE CASCADE,',
  "  note text NOT NULL DEFAULT ''",
  ');',
  'CREATE UNIQUE INDEX child_parent ON child (parent_id);',
  '`;',
  "export const ALTER = 'ALTER TABLE child ADD COLUMN amount integer DEFAULT 0';",
  'export const composed = (table: string): string => `CREATE TABLE IF NOT EXISTS ${table} (id bigint)`;',
  "export const prose = 'the parser must not read this sentence as SQL';",
  '',
].join('\n');

/** The line the table's CREATE TABLE opens on in the source above: a reader of the page opens it there. */
const CHILD_LINE = SOURCE.split('\n').findIndex((line) => line.startsWith('CREATE TABLE child')) + 1;

/** The line the composed literal opens on: the table it names is made at run time, so the unit ends partial there. */
const COMPOSED_LINE = SOURCE.split('\n').findIndex((line) => line.includes('const composed')) + 1;

/** The reason this machine cannot run a plugin, when it cannot: the cases that need one are skipped with it. */
const sandboxProblem: string | undefined = await (async (): Promise<string | undefined> => {
  const parent = cgroupParent();
  const delegation = checkCgroupDelegation(parent);
  if (delegation !== undefined) return delegation.message;
  const problem = await sandboxSetupProblem({ cgroupParent: parent });
  return problem?.message;
})();

/** One git command in a repository. */
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv(IDENTITY) });

/** The diagrams block of a page. */
const diagramsBlock = (page: PageModel): DiagramsBlockShape => {
  const block = page.blocks.find((entry) => entry.type === 'diagrams');
  if (block === undefined || block.type !== 'diagrams') throw new Error(`the page ${page.id} holds no diagrams block: ${JSON.stringify(page.blocks.map((entry) => entry.type))}`);
  return block;
};

/** The groups one related block of a page shows, by their relation: the block the template's children tag drew. */
const relatedGroups = (page: PageModel, relation: string): string[] => {
  const groups = page.blocks
    .filter((entry): entry is Extract<Block, { type: 'related' }> => entry.type === 'related')
    .flatMap((block) => block.groups)
    .filter((group) => group.relation === relation);
  if (groups.length === 0) throw new Error(`the page ${page.id} holds no group of ${JSON.stringify(relation)}: ${JSON.stringify(page.blocks.map((entry) => (entry.type === 'related' ? entry.title : entry.type)))}`);
  return groups.flatMap((group) => group.rows.map((row) => row.entity.label));
};

describe.skipIf(sandboxProblem !== undefined)('the db-schema plugin on a source it holds', () => {
  let work: string;
  let sourceFile: string;
  let folder: string;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'madarch-db-schema-unit-'));
    sourceFile = join(work, 'src', 'schema.ts');
    mkdirSync(join(work, 'src'), { recursive: true });
    writeFileSync(sourceFile, SOURCE);
    folder = join(PLUGINS, 'plugins', 'db-schema');
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  test('it answers the tables, their columns, the index and the foreign key, and names the composed table as partial', async () => {
    const closure = closureOf(folder);
    const host = new PluginHost({
      pluginFolder: folder,
      closure,
      repository: work,
      workRoot: mkdtempSync(join(tmpdir(), 'madarch-db-schema-host-')),
      trust: 'production',
      releaseHashes: [closure.hash],
      ...(cgroupParent() === undefined ? {} : { cgroupParent: cgroupParent() }),
      graph: {
        files: async (pattern) => (pattern.endsWith('.ts') ? [{ kind: 'code.file', key: { repository: 'app', path: 'src/schema.ts' } }] : []),
        value: async () => readFileSync(sourceFile, 'utf8'),
      },
    });
    const session = await host.open();
    try {
      const outcome = await session.runUnit({ unitId: 'db-schema', kind: 'code.database', key: { pattern: '**/*.ts' }, inputs: { patterns: ['**/*.ts'] } });
      if (outcome.state !== 'extracted') throw new Error(`the unit was not extracted: ${outcome.cause.code}: ${outcome.cause.message}`);
      const tables = outcome.result.vertices.filter((vertex) => vertex.kind === 'code.table').map((vertex) => String(vertex.key['name'])).sort();
      // The composed CREATE TABLE names its table at run time: it is no table of the answer, and the unit says so.
      expect(tables).toEqual(['child', 'parent']);
      expect(outcome.result.end.state).toBe('partial');
      const cause = outcome.result.end.state === 'partial' ? outcome.result.end.cause : '';
      // Every unreadable literal is named with its file and its line: the composed CREATE TABLE stands where it is written.
      expect(cause).toContain(`app/src/schema.ts:${String(COMPOSED_LINE)}`);

      const columns = outcome.result.vertices.filter((vertex) => vertex.kind === 'code.column' && vertex.key['table'] === 'app/child');
      expect(columns.map((column) => column.key['name']).sort()).toEqual(['amount', 'id', 'note', 'parent_id']);
      const note = columns.find((column) => column.key['name'] === 'note');
      expect(note?.attributes).toMatchObject({ type: 'text', nullable: false, primary_key: false, default: "''" });
      const amount = columns.find((column) => column.key['name'] === 'amount');
      expect(amount?.attributes).toMatchObject({ type: 'integer', default: '0' });
      const id = columns.find((column) => column.key['name'] === 'id');
      expect(id?.attributes).toMatchObject({ type: 'bigint', primary_key: true, nullable: false });

      const indexes = outcome.result.vertices.filter((vertex) => vertex.kind === 'code.index');
      expect(indexes.map((index) => [index.key['name'], index.attributes?.['unique'], index.attributes?.['columns']])).toEqual([['child_parent', true, ['parent_id']]]);

      const key = outcome.result.edges.filter((edge) => edge.kind === 'code.foreign-key');
      expect(key.map((edge) => [edge.from.key, edge.to.key, edge.attributes?.['column']])).toEqual([[{ table: 'app/child', name: 'parent_id' }, { table: 'app/parent', name: 'id' }, 'parent_id']]);
      // A table is declared in the file that holds its SQL: the edge names the file vertex the host answered for.
      const declared = outcome.result.edges.filter((edge) => edge.kind === 'code.declared-in');
      expect(declared.map((edge) => edge.to.key)).toEqual([{ repository: 'app', path: 'src/schema.ts' }, { repository: 'app', path: 'src/schema.ts' }]);
      const parent = outcome.result.vertices.find((vertex) => vertex.kind === 'code.table' && vertex.key['name'] === 'parent');
      expect(parent?.evidence).toMatchObject({ repository: 'app', path: 'src/schema.ts' });
    } finally {
      await session.close();
    }
  }, 120_000);
});

describe.skipIf(sandboxProblem !== undefined)('a product database, filled from its code through the plugin', () => {
  let work: string;
  let folder: string;
  let product: KnowledgeProduct;

  /** Runs one fill of the product and waits for it. */
  async function refill(): Promise<void> {
    const started = await product.startFill();
    if (!('started' in started) || started.started !== true) throw new Error(`the fill did not start: ${JSON.stringify(started)}`);
    await product.settled();
    const state = product.fillState();
    if (state.state !== 'done') throw new Error(`the fill did not finish: ${JSON.stringify(state)}`);
  }

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'madarch-db-schema-path-'));
    const draft = createDraft({ home: join(work, 'home'), name: 'schema-shop', gitEnv: gitEnv(IDENTITY) });
    if (draft.outcome !== 'created') throw new Error(`the draft product was not made: ${JSON.stringify(draft)}`);
    folder = draft.folder;
    const code = join(folder, 'repos', 'app');
    mkdirSync(join(code, 'src'), { recursive: true });
    writeFileSync(join(code, 'src', 'schema.ts'), SOURCE);
    git(code, 'init', '--quiet', '--initial-branch=main');
    git(code, 'add', '-A');
    git(code, 'commit', '--quiet', '-m', 'First commit');
    const manifest = join(folder, 'workspace.yaml');
    writeFileSync(manifest, manifestWithRepo(readFileSync(manifest, 'utf8'), { name: 'app', linked: true }));
    git(folder, 'add', '-A');
    git(folder, 'commit', '--quiet', '-m', 'Connect the code repository');
    product = new KnowledgeProduct({ productFolder: folder, storeRoot: join(work, 'store') });
    await refill();
  }, 300_000);

  afterAll(async () => {
    await product?.close();
    rmSync(work, { recursive: true, force: true });
  });

  test('the database page draws every table the SQL creates and the foreign key between them', async () => {
    const page = await product.page('code.database:app');
    if (!page.ok) throw new Error(page.message);
    const view = diagramsBlock(page.page).views[0];
    if (view === undefined) throw new Error('the database page draws no view');
    const tables = view.elements.map((element) => element.label).sort();
    expect(tables).toEqual(['child', 'parent']);
    expect(view.edges.map((edge) => [edge.from, edge.to, edge.label])).toEqual([['code.table:app/child', 'code.table:app/parent', 'parent_id']]);
    expect(view.mermaidSource).toContain('erDiagram');
    expect(view.mermaidSource).not.toContain('madarch_substitution');
  }, 300_000);

  test('a table page lists its columns and its indexes and links the file and the line that declared it', async () => {
    const page = await product.page('code.table:app/child');
    if (!page.ok) throw new Error(page.message);
    expect(relatedGroups(page.page, 'code.has-column').sort()).toEqual(['amount', 'id', 'note', 'parent_id']);
    expect(relatedGroups(page.page, 'code.has-index')).toEqual(['child_parent']);
    const source = page.page.blocks.find((entry): entry is Extract<Block, { type: 'source' }> => entry.type === 'source');
    expect(source?.location.path).toBe('src/schema.ts');
    expect(source?.location.lineStart).toBe(CHILD_LINE);
    expect(page.page.findings).toEqual([]);
  }, 300_000);

  test('the variable table the SQL composes is no table of the wiki, and the plugin said so rather than inventing one', async () => {
    const listed = await product.list('code.table', { limit: 100 });
    if (listed === undefined) throw new Error('the product declares no code.table kind');
    expect(listed.rows.map((row) => row.id).sort()).toEqual(['code.table:app/child', 'code.table:app/parent']);
    const absent = await product.page('code.table:app/madarch_substitution');
    expect(absent.ok).toBe(false);
  }, 300_000);
});
