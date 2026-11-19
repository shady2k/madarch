import { createHash } from 'node:crypto';
import { STARTER_FILES } from '../src/knowledge/seed.js';
import { dirname } from 'node:path';
import { composePage, splitResponse, type Bootstrap } from '../src/page-contract/index.js';
import { executeGraphql, type MessageBody } from '../src/graph/graphql-execute.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { bindTestWriteCapability } from './write-capability-fixture.js';
import type { PluginEvidence } from '../src/plugin/protocol.js';

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
import type { FactsOperation } from '../src/plugin-sdk.js';
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
import { readRun, readRunUnits } from '../src/graph/fill-state.js';
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
    const operations: FactsOperation[] = [];
    const host = new PluginHost({
      operations: {async apply(_unitId,_key,operation){operations.push(operation as FactsOperation);return {accepted:true};}},
      pluginFolder: folder,
      closure,
      repository: work,
      workRoot: mkdtempSync(join(tmpdir(), 'madarch-db-schema-host-')),
      trust: 'production',
      releaseHashes: [closure.hash],
      ...(cgroupParent() === undefined ? {} : { cgroupParent: cgroupParent() }),
      graph: {
        // The plugin reconciles what it produced before (decision 0039): the host answers the unit's own facts, none here.
        ownFacts: async () => ({ vertices: [], edges: [] }),
        files: async (pattern) => (pattern.endsWith('.ts') ? [{ kind: 'code.file', key: { path: 'src/schema.ts' }, keyEdges:{'code.file-repository':{kind:'code.repository',key:{name:'app'}}} }] : []),
        value: async (_kind, _key, field) => field === 'blob' ? 'blob-src/schema.ts' : null,
      },
      readBlob: async (ask) => ({ text: ask.blob === 'blob-src/schema.ts' ? readFileSync(sourceFile, 'utf8') : '', lines: 1, bytes: 1, binary: false }),
    });
    const session = await host.open();
    try {
      const outcome = await session.runUnit({ unitId: 'db-schema', kind: 'code.database', key: { pattern: '**/*.ts' }, inputs: { patterns: ['**/*.ts'] } });
      if (outcome.state !== 'extracted') throw new Error(`the unit was not extracted: ${outcome.cause.code}: ${outcome.cause.message}`);
      const tables = operations.flatMap(operation=>operation.vertices??[]).filter((vertex) => vertex.kind === 'code.table').map((vertex) => String(vertex.key['name'])).sort();
      // The composed CREATE TABLE names its table at run time: it is no table of the answer, and the unit says so.
      expect(tables).toEqual(['child', 'parent']);
      expect(outcome.result.end.state).toBe('partial');
      const cause = outcome.result.end.state === 'partial' ? outcome.result.end.cause : '';
      // Every unreadable literal is named with its file and its line: the composed CREATE TABLE stands where it is written.
      expect(cause).toContain(`app/src/schema.ts:${String(COMPOSED_LINE)}`);

      const columns = operations.flatMap(operation=>operation.vertices??[]).filter((vertex) => vertex.kind === 'code.column' && vertex.keyEdges?.['code.column-table']?.key['name'] === 'child');
      expect(columns.map((column) => column.key['name']).sort()).toEqual(['amount', 'id', 'note', 'parent_id']);
      const note = columns.find((column) => column.key['name'] === 'note');
      expect(note?.values).toMatchObject({ type: 'text', nullable: false, primary_key: false, default: "''" });
      const amount = columns.find((column) => column.key['name'] === 'amount');
      expect(amount?.values).toMatchObject({ type: 'integer', default: '0' });
      const id = columns.find((column) => column.key['name'] === 'id');
      expect(id?.values).toMatchObject({ type: 'bigint', primary_key: true, nullable: false });

      const indexes = operations.flatMap(operation=>operation.vertices??[]).filter((vertex) => vertex.kind === 'code.index');
      expect(indexes.map((index) => [index.key['name'], index.values?.['unique']])).toEqual([['child_parent', true]]);

      const key = operations.flatMap(operation=>operation.edges??[]).filter((edge) => edge.kind === 'code.foreign-key');
      expect(key.map((edge) => [edge.from.key, edge.from.keyEdges?.['code.column-table']?.key, edge.to.key, edge.to.keyEdges?.['code.column-table']?.key])).toEqual([[{ name: 'parent_id' }, {name:'child'}, { name: 'id' }, {name:'parent'}]]);
      expect(operations.flatMap(operation=>operation.edges??[]).filter(edge=>edge.kind==='code.index-columns').map(edge=>[edge.from.key,edge.to.key,edge.values?.['position']])).toEqual([[{name:'child_parent'},{name:'parent_id'},0]]);
      // A table is declared in the file that holds its SQL: the edge names the file vertex the host answered for.
      const declared = operations.flatMap(operation=>operation.edges??[]).filter((edge) => edge.kind === 'code.declared-in');
      expect(declared.map((edge) => edge.to.key)).toEqual([{ path: 'src/schema.ts' }, { path: 'src/schema.ts' }]);
      const parent = operations.flatMap(operation=>operation.vertices??[]).find((vertex) => vertex.kind === 'code.table' && vertex.key['name'] === 'parent');
      expect(parent?.evidence).toMatchObject({ target:{kind:'code.blob',key:{digest:createHash('sha256').update(SOURCE).digest('hex')}}, path: 'src/schema.ts' });
      const child = operations.flatMap(operation=>operation.vertices??[]).find((vertex) => vertex.kind === 'code.table' && vertex.key['name'] === 'child');
      expect(child?.evidence).toMatchObject({ target:{kind:'code.blob',key:{digest:createHash('sha256').update(SOURCE).digest('hex')}}, path: 'src/schema.ts', lineStart: CHILD_LINE });
      operations.length=0;
      const selected = await session.runUnit({ unitId: 'selected-database', kind: 'code.database', key: {}, inputs: {
        patterns: ['**/*.ts'], contract: { vertices: [{ kind: 'code.database', fields: [{ name: 'repository' }] }] }, edgeOutputs: [],
      } });
      if (selected.state !== 'extracted') throw new Error(JSON.stringify(selected));
      expect(operations.flatMap(operation=>operation.vertices??[]).map((vertex) => vertex.kind)).toEqual(['code.blob','code.database']);
      const selectedDatabase=operations.flatMap(operation=>operation.vertices??[]).find(vertex=>vertex.kind==='code.database');
      const selectedBlob=operations.flatMap(operation=>operation.vertices??[]).find(vertex=>vertex.kind==='code.blob');
      expect(selectedBlob?.values?.['content']).toBe(SOURCE);
      expect(selectedBlob?.key['digest']).toBe(createHash('sha256').update(SOURCE).digest('hex'));
      // The repository and the name are the database's key, as the catalogue declares them; neither is a value.
      expect(selectedDatabase?.key).toEqual({ name: 'app' });
      expect(selectedDatabase?.values).toBeUndefined();
      expect(selectedDatabase?.keyEdges?.['code.database-repository']).toEqual({kind:'code.repository',key:{name:'app'}});
      expect(operations.flatMap(operation=>operation.edges??[])).toEqual([{kind:'code.blob-about',from:{kind:'code.blob',key:{digest:createHash('sha256').update(SOURCE).digest('hex')}},to:{kind:'code.file',key:{path:'src/schema.ts'},keyEdges:{'code.file-repository':{kind:'code.repository',key:{name:'app'}}}}}]);
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
    const operations: FactsOperation[] = [];
    const host = new PluginHost({
      operations: {async apply(_unitId,_key,operation){operations.push(operation as FactsOperation);return {accepted:true};}},
      pluginFolder: join(PLUGINS, 'plugins', 'db-schema'), closure, repository: work, workRoot: join(work, 'host'),
      trust: 'production', releaseHashes: [closure.hash],
      ...(cgroupParent() === undefined ? {} : { cgroupParent: cgroupParent() }),
      graph: {
        ownFacts: async () => ({ vertices: [], edges: [] }),
        files: async (pattern) => {
          requested.push(pattern);
          return Object.keys(sources).filter((path) => pattern === 'src/*.ts' ? path.startsWith('src/') : true)
            .map((path) => ({ kind: 'code.file', key: { path },keyEdges:{'code.file-repository':{kind:'code.repository',key:{name:'app'}}} }));
        },
        // The graph names each file's blob; the host answers the text by it (decision 0037).
        value: async (_kind, key, field) => field === 'blob' ? `blob-${String(key['path'])}` : null,
      },
      readBlob: async (ask) => {
        const text = sources[String(ask.blob).replace(/^blob-/u, '')] ?? '';
        return { text, lines: text.split('\n').length, bytes: text.length, binary: false };
      },
    });
    const session = await host.open();
    try {
      const result = await session.runUnit({ unitId: 'scope', kind: 'code.table', key: {}, inputs: { patterns: ['src/*.ts', 'src/*.ts'] } });
      if (result.state !== 'extracted') throw new Error(JSON.stringify(result));
      const tables = operations.flatMap(operation=>operation.vertices??[]).filter((v) => v.kind === 'code.table');
      expect(tables.map((v) => v.key['name']).sort()).toEqual(['known', 'madarch_meta.schema_stamp', 'sample']);
      const sample = tables.find((v) => v.key['name'] === 'sample');
      expect(sample?.values?.['unsupported']).toContain('composite UNIQUE');
      expect(sample?.values?.['unsupported']).toContain('table CHECK');
      expect(sample?.values?.['unsupported']).toContain('expression index');
      expect(sample?.values?.['unsupported']).toContain('operator class');
      expect(sample?.values?.['unsupported']).toContain('access method hash');
      expect(sample?.values?.['unsupported']).toContain('src/a.ts:');
      expect(sample?.values?.['unsupported']).toContain('src/b.ts:');
      const columns = operations.flatMap(operation=>operation.vertices??[]).filter((v) => v.kind === 'code.column' && v.keyEdges?.['code.column-table']?.key['name'] === 'sample');
      expect(columns.map((v) => v.key['name']).sort()).toEqual(['a', 'b']);
      expect(columns.every((v) => v.values?.['unique'] === false)).toBe(true);
      expect(result.result.end.state).toBe('partial');
      if (result.result.end.state !== 'partial') throw new Error('expected source diagnostics');
      expect(result.result.end.cause).toContain('app/src/foreign-schema.ts:1');
      expect(result.result.end.cause).toContain('app/src/function-shadow.ts:1');
      expect(result.result.end.cause).toContain('app/src/shadow.ts:1');
      expect(requested.every((pattern) => pattern === 'src/*.ts')).toBe(true);
      requested.length = 0;
      operations.length=0;
      const empty = await session.runUnit({ unitId: 'empty', kind: 'code.table', key: {}, inputs: { patterns: [] } });
      if (empty.state !== 'extracted') throw new Error(JSON.stringify(empty));
      expect(operations.flatMap(operation=>operation.vertices??[])).toEqual([]);
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
    // The fixture keeps no agent plugin: the field is a person's own writing, so no fill waits for one.
    kinds.addIn(['kinds', 'code.table', 'fields'], { name: 'source', type: 'json', schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { repository: { type: 'string' }, path: { type: 'string' }, lineStart: { type: 'integer' }, lineEnd: { type: 'integer' } }, required: ['repository', 'path'], additionalProperties: false }, nullable: true, producers: ['person'] });
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
      // The owner's rule (2026-11-15): a partial answer keeps every entry it holds, and only an answer that holds
      // nothing abstains. The database the readable SQL declares is published, and the composed literal is the reason.
      expect(database?.outcome).toBe('completed');
      expect(database?.produced).toBeGreaterThan(0);
      expect(database?.reason).toContain(`src/schema.ts:${String(COMPOSED_LINE)}`);
      const run = await readRun(partialOwner, database!.runId);
      expect(run?.state).toBe('succeeded');
      // The owner rule: a final run leaves no blocked or waiting unit. The database published, so its dependants ran.
      const units = await readRunUnits(partialOwner, database!.runId);
      for (const kind of ['code.table', 'code.column', 'code.index']) {
        expect(units.find((unit) => unit.unitId.includes(`:${kind}`))?.state).toBe('published');
      }
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
      const reader = new GraphReader(owner, () => new Date().toISOString(), undefined, undefined, new Set([...contract.vertex.map((vertex) => vertex.name), ...contract.edge.map((edge) => edge.name)]), declaredKindReads(read.manifest), declaredEdgeReads(read.manifest), contract);
      const tables = await reader.list('code.table', { limit: 100 });
      expect(tables.rows.map((row) => row.properties['name']).sort()).toEqual(['child', 'parent']);
      const columns = await reader.list('code.column', { limit: 200 });
      const child = tables.rows.find((row) => row.properties['name'] === 'child');
      if (child === undefined) throw new Error(`${import.meta.path}:362: fixture table child is absent`);
      const childColumns = [];
      for (const column of columns.rows) {
        const table = await reader.edgesOf(column, 'code.column-table', 'out', 2);
        if (table.rows.some((edge) => edge.other.uid === child.uid)) childColumns.push(column);
      }
      expect(childColumns.map((row) => `app/child.${String(row.properties['name'])}`).sort()).toEqual(['app/child.amount', 'app/child.id', 'app/child.note', 'app/child.parent_id']);
      const indexes = await reader.list('code.index', { limit: 100 });
      expect(indexes.rows.map((row) => row.properties['name'])).toEqual(['child_parent']);
      // The foreign key is an edge between the two columns (code.foreign-key), naming the constraint and its target.
      const keyColumn = childColumns.find((row) => row.properties['name'] === 'parent_id')!;
      const keys = await reader.edgesOf(keyColumn, 'code.foreign-key', 'out', 20);
      expect(keys.rows.map((row) => row.other.properties['name'])).toEqual(['id']);
      expect(keys.rows[0]!.properties['target_column']).toBe('id');
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
      const reader = new GraphReader(owner, () => new Date().toISOString(), undefined, undefined, new Set([...contract.vertex.map((vertex) => vertex.name), ...contract.edge.map((edge) => edge.name)]), declaredKindReads(read.manifest), declaredEdgeReads(read.manifest), contract);
      expect((await reader.list('code.table', { limit: 100 })).rows.map((row) => row.properties['name']).sort()).toEqual(['child', 'parent']);
      expect((await reader.find('code.table:app/madarch_substitution')).length).toBe(0);
    } finally { await owner.close(); }
  }, 300_000);
});

describe.skipIf(sandboxProblem !== undefined)('db-schema output in the table page index columns cell', () => {
  for (const width of [1, 11]) test(`all ${width} index columns reach the page cell through the declared edge`, async () => {
    const work = mkdtempSync(join(tmpdir(), 'madarch-index-page-'));
    const folder = join(work, 'product');
    const names = width === 1 ? ['parent_id'] : Array.from({ length: width }, (_, i) => `column_${String(i + 1).padStart(2, '0')}`);
    const source = width === 1 ? STATIC_SOURCE : `export const sql = \`CREATE TABLE child (${names.map(name => `${name} bigint`).join(', ')}); CREATE INDEX child_parent ON child USING btree (${names.join(', ')});\`;`;
    for (const file of STARTER_FILES) {
      const path = join(folder, file.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.bytes ?? file.content);
    }
    const read = readKinds(folder);
    if (!read.present) throw new Error(`${folder}/madarch/catalog.yaml:1: fixture manifest is absent`);
    expect(read.manifest.findings).toEqual([]);
    const contract = withManifestContract(graphContractOf(read.manifest));
    const owner = await createTestDatabaseOwner({ graphContract: contract });
    const operations: FactsOperation[] = [];
    const pluginFolder = join(PLUGINS, 'plugins/db-schema');
    const closure = closureOf(pluginFolder);
    const repository = { kind: 'code.repository', key: { name: 'app' } };
    const file = { kind: 'code.file', key: { path: 'src/schema.ts' }, keyEdges: { 'code.file-repository': repository } };
    const host = new PluginHost({
      operations: { async apply(_unitId, _key, operation) { operations.push(operation as FactsOperation); return { accepted: true }; } },
      pluginFolder, closure, repository: folder, workRoot: join(work, 'host'),
      trust: 'production', releaseHashes: [closure.hash],
      ...(cgroupParent() === undefined ? {} : { cgroupParent: cgroupParent() }),
      graph: {
        ownFacts: async () => ({ vertices: [], edges: [] }),
        files: async () => [file],
        value: async (_kind, _key, field) => field === 'blob' ? 'source-blob' : null,
      },
      readBlob: async () => ({ text: source, lines: source.split('\n').length, bytes: source.length, binary: false }),
    });
    const session = await host.open();
    try {
      const outcome = await session.runUnit({ unitId: 'index-page', kind: 'code.database', key: {}, inputs: { patterns: ['src/*.ts'] } });
      if (outcome.state !== 'extracted') throw new Error(JSON.stringify(outcome));
      const vertices = operations.flatMap(operation => operation.vertices ?? []);
      const edges = operations.flatMap(operation => operation.edges ?? []);
      // Assert the producer/catalogue boundary before publication, rather than accepting an empty cell.
      expect(edges.filter(edge => edge.from.kind === 'code.index').map(edge => edge.kind)).toEqual(names.map(() => 'code.index-columns'));
      const evidence = (value: PluginEvidence | undefined) => value === undefined ? [] : [{
        target: value.target, locator: { path: value.path, lineStart: value.lineStart, lineEnd: value.lineEnd },
      }];
      await owner.transaction('write', async tx => {
        await bindTestWriteCapability(tx, contract);
        await publishGraphDrafts(tx, contract, {
          vertices: [repository, file, ...vertices].map(vertex => ({ ...vertex, evidence: evidence('evidence' in vertex ? vertex.evidence : undefined), producer: 'db-schema', producerVersion: '1' })),
          edges: edges.map(edge => ({ ...edge, evidence: evidence(edge.evidence), producer: 'db-schema', producerVersion: '1' })),
          removals: [],
        }, 1, { author: 'db-schema@1' });
      });
      const reader = new GraphReader(owner, () => new Date().toISOString(), undefined, undefined,
        new Set(contract.vertex.map(vertex => vertex.name)), declaredKindReads(read.manifest), declaredEdgeReads(read.manifest), contract);
      const table = (await reader.list('code.table', { limit: 100 })).rows.find(row => row.properties['name'] === 'child');
      expect(table).toBeDefined();
      const bootstrap: Bootstrap = {
        structureRevision: 'fixture', home: null, catalogueTemplate: 'entity',
        templates: ['entity', 'code-table'].map(name => ({ name, body: readFileSync(join(PLUGINS, 'catalog/templates/pages', `${name}.yaml`), 'utf8') })),
        recordTemplates: [{ kind: 'code.table', template: 'code-table' }], ownTemplates: [], roles: [], roleLeads: [],
      };
      const page = composePage(bootstrap, { kind: 'code.table', id: table!.uid });
      expect(page.findings).toEqual([]);
      const answer = await executeGraphql(owner, { manifest: read.manifest, folder }, { query: page.operation, variables: page.variables });
      const body = answer.body as MessageBody;
      expect(body.errors).toBeUndefined();
      const data = splitResponse(page, body.data as Record<string, unknown> | undefined);
      const indexes = data['indexes'] as { edges: { node: { name: string; columns: { edges: { node: { label: string } }[]; totalCount: number; pageInfo: { hasNextPage: boolean } } } }[] };
      const index = indexes.edges.find(edge => edge.node.name === 'child_parent')?.node;
      expect(index).toBeDefined();
      const cell = page.sections.find(section => section.id === 'indexes')?.params['columns'] as { path: string; format?: string }[];
      expect(cell.find(column => column.path === 'node.columns')?.format).toBe('links');
      expect(index!.columns.edges.map(edge => edge.node.label).sort()).toEqual([...names].sort());
      expect(index!.columns.totalCount).toBe(width);
      expect(index!.columns.pageInfo.hasNextPage).toBe(false);
    } finally {
      await session.close();
      await owner.close();
      rmSync(work, { recursive: true, force: true });
    }
  }, 120_000);
});
