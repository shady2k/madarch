import { readFolderManifestText, writeFolderManifest } from './catalog-folder-fixture.js';
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
import { useFixturePlugins } from './enabled-plugins-fixture.js';
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
import { GraphReader } from '../src/knowledge/graph-read.js';
import { gitEnv } from './git-env.js';
import { parseDocument } from 'yaml';
import { declaredEdgeReads, declaredKindReads, graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { retainTestStorePreparationOwner } from './prepared-server.js';
import { createTestDatabaseOwner } from './test-database.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { readProducerOutcomes } from '../src/graph/producer-outcomes.js';

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
  'CREATE INDEX child_expression ON child ((lower(note)));',
  '`;',
  "export const ALTER = 'ALTER TABLE child ADD COLUMN amount integer DEFAULT 0';",
  'export const composed = (table: string): string => `CREATE TABLE IF NOT EXISTS ${table} (id bigint)`;',
  "export const prose = 'the parser must not read this sentence as SQL';",
  '',
].join('\n');

/** The presentation phase keeps every static statement and its line, replacing only the dynamic table declaration. */
const STATIC_SOURCE = SOURCE.replace(
  'export const composed = (table: string): string => `CREATE TABLE IF NOT EXISTS ${table} (id bigint)`;',
  '// The dynamic table declaration was removed after its abstention was recorded.',
);

/** The line the table's CREATE TABLE opens on in the source above: a reader of the page opens it there. */
const CHILD_LINE = SOURCE.split('\n').findIndex((line) => line.startsWith('CREATE TABLE child')) + 1;

/** The line the composed literal opens on: the table it names is made at run time, so the unit ends partial there. */
const COMPOSED_LINE = SOURCE.split('\n').findIndex((line) => line.includes('const composed')) + 1;

/** The reason this machine cannot run a plugin, when it cannot: the cases that need one are skipped with it. */
const sandboxProblem: string | undefined = await (async (): Promise<string | undefined> => {
  if (process.env['MADARCH_PLUGIN_SANDBOX'] === 'off') return undefined;
  const parent = cgroupParent();
  const delegation = checkCgroupDelegation(parent);
  if (delegation !== undefined) return delegation.message;
  const problem = await sandboxSetupProblem({ cgroupParent: parent });
  return problem?.message;
})();

/** One git command in a repository. */
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv(IDENTITY) });

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
      expect(note?.values).toMatchObject({ type: 'text', nullable: false, primary_key: false, default: "''" });
      const amount = columns.find((column) => column.key['name'] === 'amount');
      expect(amount?.values).toMatchObject({ type: 'integer', default: '0' });
      const id = columns.find((column) => column.key['name'] === 'id');
      expect(id?.values).toMatchObject({ type: 'bigint', primary_key: true, nullable: false });

      const indexes = outcome.result.vertices.filter((vertex) => vertex.kind === 'code.index');
      expect(indexes.map((index) => [index.key['name'], index.values?.['unique'], index.values?.['columns']])).toEqual([['child_parent', true, ['parent_id']]]);

      const key = outcome.result.edges.filter((edge) => edge.kind === 'code.foreign-key');
      expect(key.map((edge) => [edge.from.key, edge.to.key, edge.values?.['column']])).toEqual([[{ table: 'app/child', name: 'parent_id' }, { table: 'app/parent', name: 'id' }, 'parent_id']]);
      // A table is declared in the file that holds its SQL: the edge names the file vertex the host answered for.
      const declared = outcome.result.edges.filter((edge) => edge.kind === 'code.declared-in');
      expect(declared.map((edge) => edge.to.key)).toEqual([{ repository: 'app', path: 'src/schema.ts' }, { repository: 'app', path: 'src/schema.ts' }]);
      const parent = outcome.result.vertices.find((vertex) => vertex.kind === 'code.table' && vertex.key['name'] === 'parent');
      expect(parent?.evidence).toMatchObject({ repository: 'app', path: 'src/schema.ts' });
      const child = outcome.result.vertices.find((vertex) => vertex.kind === 'code.table' && vertex.key['name'] === 'child');
      expect(child?.evidence).toMatchObject({ repository: 'app', path: 'src/schema.ts', lineStart: CHILD_LINE });
      const selected = await session.runUnit({ unitId: 'selected-database', kind: 'code.database', key: {}, inputs: {
        patterns: ['**/*.ts'], contract: { vertices: [{ kind: 'code.database', fields: [{ name: 'repository' }] }] }, edgeOutputs: [],
      } });
      if (selected.state !== 'extracted') throw new Error(JSON.stringify(selected));
      expect(selected.result.vertices.map((vertex) => vertex.kind)).toEqual(['code.database']);
      expect(selected.result.vertices[0]?.values).toEqual({ repository: 'app' });
      expect(selected.result.edges).toEqual([]);
      expect(selected.result.end).toEqual(outcome.result.end);
    } finally {
      await session.close();
    }
  }, 120_000);
});

describe.skipIf(sandboxProblem !== undefined)('declared SQL scope and explicit parser limits', () => {
  test('only declared files are read, duplicates are not merged, and unsupported constraints are table values', async () => {
    const sources: Record<string, string> = {
      'src/a.ts': "const META = 'madarch_meta'; export const sql = `CREATE TABLE ${META}.schema_stamp (id bigint PRIMARY KEY); CREATE TABLE sample (a text, b text, UNIQUE (a,b), CHECK (a <> b)); CREATE INDEX expression_idx ON sample ((lower(a))); CREATE INDEX opclass_idx ON sample (a text_pattern_ops); CREATE INDEX method_idx ON sample USING hash (a);`;",
      'src/b.ts': 'export const sql = `CREATE TABLE sample (fixture_only boolean)`;',
      'src/shadow.ts': "const S = 'incorrect'; function ddl(S: string) { return `CREATE TABLE ${S}.shadowed (id bigint)`; }",
      'src/function-shadow.ts': "const F = 'incorrect'; function ddl() { function F() {} return `CREATE TABLE ${F}.function_shadowed (id bigint)`; }",
      'src/foreign-schema.ts': "export const sql = `CREATE TABLE known (id bigint REFERENCES ${unknownSchema}.parent(id))`;",
      'test/fixture.ts': 'export const sql = `CREATE TABLE unwanted (id bigint)`;',
    };
    const requested: string[] = [];
    const closure = closureOf(join(PLUGINS, 'plugins', 'db-schema'));
    const work = mkdtempSync(join(tmpdir(), 'madarch-schema-scope-'));
    const host = new PluginHost({
      pluginFolder: join(PLUGINS, 'plugins', 'db-schema'), closure, repository: work, workRoot: join(work, 'host'),
      trust: 'production', releaseHashes: [closure.hash],
      ...(cgroupParent() === undefined ? {} : { cgroupParent: cgroupParent() }),
      graph: {
        files: async (pattern) => {
          requested.push(pattern);
          return Object.keys(sources).filter((path) => pattern === 'src/*.ts' ? path.startsWith('src/') : true)
            .map((path) => ({ kind: 'code.file', key: { repository: 'app', path } }));
        },
        value: async (_kind, key) => sources[String(key['path'])] ?? null,
      },
    });
    const session = await host.open();
    try {
      const result = await session.runUnit({ unitId: 'scope', kind: 'code.table', key: {}, inputs: { patterns: ['src/*.ts', 'src/*.ts'] } });
      if (result.state !== 'extracted') throw new Error(JSON.stringify(result));
      const tables = result.result.vertices.filter((v) => v.kind === 'code.table');
      expect(tables.map((v) => v.key['name']).sort()).toEqual(['known', 'madarch_meta.schema_stamp', 'sample']);
      const sample = tables.find((v) => v.key['name'] === 'sample');
      expect(sample?.values?.['unsupported']).toContain('composite UNIQUE');
      expect(sample?.values?.['unsupported']).toContain('table CHECK');
      expect(sample?.values?.['unsupported']).toContain('expression index');
      expect(sample?.values?.['unsupported']).toContain('operator class');
      expect(sample?.values?.['unsupported']).toContain('access method hash');
      expect(sample?.values?.['unsupported']).toContain('src/a.ts:');
      expect(sample?.values?.['unsupported']).toContain('src/b.ts:');
      const columns = result.result.vertices.filter((v) => v.kind === 'code.column' && v.key['table'] === 'app/sample');
      expect(columns.map((v) => v.key['name']).sort()).toEqual(['a', 'b']);
      expect(columns.every((v) => v.values?.['unique'] === false)).toBe(true);
      expect(result.result.end.state).toBe('partial');
      if (result.result.end.state !== 'partial') throw new Error('expected source diagnostics');
      expect(result.result.end.cause).toContain('app/src/foreign-schema.ts:1');
      expect(result.result.end.cause).toContain('app/src/function-shadow.ts:1');
      expect(result.result.end.cause).toContain('app/src/shadow.ts:1');
      expect(requested.every((pattern) => pattern === 'src/*.ts')).toBe(true);
      requested.length = 0;
      const empty = await session.runUnit({ unitId: 'empty', kind: 'code.table', key: {}, inputs: { patterns: [] } });
      if (empty.state !== 'extracted') throw new Error(JSON.stringify(empty));
      expect(empty.result.vertices).toEqual([]);
      expect(requested).toEqual([]);
    } finally { await session.close(); rmSync(work, { recursive: true, force: true }); }
  }, 120_000);
});

describe.skipIf(sandboxProblem !== undefined)('a product database, filled from its code through the plugin', () => {
  let work: string;
  let folder: string;
  let product: KnowledgeProduct;
  let closeOwner: (() => Promise<void>) | undefined;

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
    mkdirSync(join(code, 'fixtures'), { recursive: true });
    writeFileSync(join(code, 'fixtures', 'schema.ts'), 'export const sql = `CREATE TABLE unwanted_fixture (id bigint); CREATE TABLE child (kind_id bigint)`;');
    useFixturePlugins(folder, ['disk', 'git', 'db-schema']);
    const kinds = parseDocument(readFolderManifestText(folder));
    for (const output of ['code.database', 'code.table', 'code.column', 'code.index']) {
      expect(kinds.hasIn(['kinds', output])).toBe(true);
      kinds.setIn(['kinds', output, 'terms'], ['src/**/*.ts']);
    }
    kinds.addIn(['kinds', 'code.table', 'fields'], { name: 'source', type: 'json', nullable: true, binding: { agent: 'The structured source excerpt a page shows.' } });
    writeFolderManifest(folder, kinds.toString());
    git(code, 'init', '--quiet', '--initial-branch=main');
    git(code, 'add', '-A');
    git(code, 'commit', '--quiet', '-m', 'First commit');
    const manifest = join(folder, 'workspace.yaml');
    writeFileSync(manifest, manifestWithRepo(readFileSync(manifest, 'utf8'), { name: 'app', linked: true }));
    git(folder, 'add', '-A');
    git(folder, 'commit', '--quiet', '-m', 'Connect the code repository');
    closeOwner = await retainTestStorePreparationOwner();
    product = new KnowledgeProduct({ productFolder: folder, storeRoot: join(work, 'store') });
    const partial = await product.startFill();
    if (!('started' in partial) || partial.started !== true) throw new Error(`the partial fill did not start: ${JSON.stringify(partial)}`);
    await product.settled();
    const partialOwner = await createTestDatabaseOwner({
      store: storeDatabasePath(productStoreFolder(folder, join(work, 'store'))),
      graphContract: withManifestContract(await readPinnedGraphContract(folder)),
    });
    try {
      const outcomes = await readProducerOutcomes(partialOwner, {});
      const database = outcomes.find((outcome) => outcome.plugin === 'db-schema' && outcome.kind === 'code.database');
      expect(database).toBeDefined();
      expect(database?.outcome).toBe('abstained');
      expect(database?.produced).toBe(0);
      expect(database?.reason).toContain(`src/schema.ts:${String(COMPOSED_LINE)}`);
      const run = await partialOwner.run((tx) => tx.query<{ state: string }>('SELECT state FROM fill_run WHERE run_id = $1', [database!.runId]));
      expect(run.rows[0]?.state).toBe('completed_partial');
      for (const kind of ['code.table', 'code.column', 'code.index']) {
        expect(outcomes.find((outcome) => outcome.plugin === 'db-schema' && outcome.kind === kind)?.outcome).toBe('failed');
      }
      const afterPartial = await partialOwner.run(async (tx) => await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM "k_code_table" n JOIN node o ON o.id = n.node_id WHERE n.state = 'open' AND NOT o.removed`));
      expect(afterPartial.rows[0]?.n).toBe('0');
    } finally { await partialOwner.close(); }

    writeFileSync(join(code, 'src', 'schema.ts'), STATIC_SOURCE);
    git(code, 'add', '-A');
    git(code, 'commit', '--quiet', '-m', 'Keep the static schema after the dynamic declaration abstained');
    await refill();
    const owner = await createTestDatabaseOwner({
      store: storeDatabasePath(productStoreFolder(folder, join(work, 'store'))),
      graphContract: withManifestContract(await readPinnedGraphContract(folder)),
    });
    try {
      const read = readKinds(folder);
      if (!read.present) throw new Error('the fixture manifest is absent');
      // Every table the SQL declares is in the graph, and nothing for the table the SQL composes at run time.
      const contract = graphContractOf(read.manifest);
      const reader = new GraphReader(owner, () => new Date().toISOString(), undefined, undefined, new Set([...contract.vertex.map((vertex) => vertex.name), ...contract.edge.map((edge) => edge.name)]), declaredKindReads(read.manifest), declaredEdgeReads(read.manifest));
      const tables = await reader.list('code.table', { limit: 100 });
      expect(tables.rows.map((row) => row.properties['name']).sort()).toEqual(['child', 'parent']);
      const child = tables.rows.find((row) => row.properties['name'] === 'child')!;
      const keys = await reader.edgesOf(child, 'code.foreign-key', 'out', 20);
      expect(keys.rows.map((row) => row.other.properties['name'])).toEqual(['parent']);
      expect(keys.rows[0]!.properties['column']).toBe('parent_id');
      const columns = await reader.list('code.column', { limit: 200 });
      expect(columns.rows.map((row) => row.properties['name']).filter((name) => ['amount', 'id', 'note', 'parent_id'].includes(String(name))).sort()).toEqual(['amount', 'id', 'note', 'parent_id']);
      const indexes = await reader.list('code.index', { limit: 100 });
      expect(indexes.rows.map((row) => row.properties['name'])).toEqual(['child_parent']);
    } finally { await owner.close(); }
  }, 300_000);

  afterAll(async () => {
    await product?.close();
    await closeOwner?.();
    rmSync(work, { recursive: true, force: true });
  });

  test('the variable table the SQL composes is no table of the graph, and the plugin said so rather than inventing one', async () => {
    const read = readKinds(folder);
    if (!read.present) throw new Error('the fixture manifest is absent');
    const contract = graphContractOf(read.manifest);
    const owner = await createTestDatabaseOwner({
      store: storeDatabasePath(productStoreFolder(folder, join(work, 'store'))),
      graphContract: withManifestContract(await readPinnedGraphContract(folder)),
    });
    try {
      const reader = new GraphReader(owner, () => new Date().toISOString(), undefined, undefined, new Set([...contract.vertex.map((vertex) => vertex.name), ...contract.edge.map((edge) => edge.name)]), declaredKindReads(read.manifest), declaredEdgeReads(read.manifest));
      expect((await reader.list('code.table', { limit: 100 })).rows.map((row) => row.properties['name']).sort()).toEqual(['child', 'parent']);
      expect((await reader.find('code.table:app/madarch_substitution')).length).toBe(0);
    } finally { await owner.close(); }
  }, 300_000);
});
