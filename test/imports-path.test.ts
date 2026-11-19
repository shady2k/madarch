/**
 * The imports plugin end to end (decision 0035, items 3, 7, 8, 11, 15 and 24; task madarch-o0eq.6): the plugin reads the
 * graph's TypeScript files and the host publishes `code.imports` between two files and `code.imports-package` from a file
 * to the package entity the same answer creates. Each edge repeats, told apart by the line and column of its import, and
 * carries the specifier as written, the kind of import and the imported names.
 *
 * The fetch case runs the plugin in the sandbox with a source it holds; the fill case runs a product's own fill over a
 * fixture repository with the static plugins disk, git and imports and no agent, and reads the edges the graph holds.
 */
import { useFixturePlugins } from './enabled-plugins-fixture.js';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDraft } from '../src/product/draft.js';
import { manifestWithRepo } from '../src/product/manifest.js';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { closureOf } from '../src/plugin/closure.js';
import type {FactsOperation} from '../src/plugin-sdk.js';
import { PluginHost } from '../src/plugin/host.js';
import { checkCgroupDelegation, cgroupParent } from '../src/plugin/cgroup.js';
import { sandboxSetupProblem } from '../src/plugin/sandbox.js';
import { gitEnv } from './git-env.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { createTestDatabaseOwner } from './test-database.js';
import {readKindAssertions} from '../src/graph/records.js';
import { readProducerOutcomes } from '../src/graph/producer-outcomes.js';
import { retainTestStorePreparationOwner } from './prepared-server.js';

const IDENTITY = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
const PLUGINS = fileURLToPath(new URL('..', import.meta.url));

/** The fixture's files: one user per import form, its targets, a path alias and a package. */
const FILES: Record<string, string> = {
  'tsconfig.json': `{ "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["src/*"] } } }`,
  'src/graph/write.ts': "import { read } from './read.js';\nimport type { Shape } from '../shape.js';\nimport { helper } from '@app/helper.js';\nimport pg from 'pg';\n",
  'src/edges.ts': "import { write } from './graph/write.js';\n",
  'src/graph/read.ts': 'export const read = 1;\n',
  'src/shape.ts': 'export type Shape = { id: number };\n',
  'src/helper.ts': 'export const helper = 1;\n',
  'src/dangling.ts': "import './nope.js';\n",
  // A file no parser accepts: its place is reported and the other files' imports still stand.
  'src/broken.ts': 'export const broken = ;\n',
};

/** The reason this machine cannot run a plugin, when it cannot: the cases that need one are skipped with it. */
const sandboxProblem: string | undefined = await (async (): Promise<string | undefined> => {
  if (process.env['MADARCH_PLUGIN_SANDBOX'] === 'off') return undefined;
  const parent = cgroupParent();
  const delegation = checkCgroupDelegation(parent);
  if (delegation !== undefined) return delegation.message;
  const problem = await sandboxSetupProblem({ cgroupParent: parent });
  return problem?.message;
})();

/** Whether the fake host answers no text for the file the unread-content case asks for. */
let broken = false;

describe.skipIf(sandboxProblem !== undefined)('the imports plugin on a source the host holds', () => {
  let work: string;
  const operations:FactsOperation[]=[];
  let session: Awaited<ReturnType<PluginHost['open']>>;

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'madarch-imports-unit-'));
    const closure = closureOf(join(PLUGINS, 'plugins', 'imports'));
    const host = new PluginHost({
      operations:{async apply(_unitId,_key,operation){operations.push(operation as FactsOperation);return {accepted:true};}},
      pluginFolder: join(PLUGINS, 'plugins', 'imports'),
      closure,
      repository: work,
      workRoot: mkdtempSync(join(tmpdir(), 'madarch-imports-host-')),
      trust: 'production',
      releaseHashes: [closure.hash],
      ...(cgroupParent() === undefined ? {} : { cgroupParent: cgroupParent() }),
      graph: {
        // The plugin reconciles what it produced before (decision 0039): the host answers the unit's own facts, none here.
        ownFacts: async () => ({ vertices: [], edges: [] }),
        files: async () => [...Object.keys(FILES), 'src/absent.ts'].map((path) => ({ kind: 'code.file', key: { path }, keyEdges:{'code.file-repository':{kind:'code.repository',key:{name:'app'}}} })),
        value: async (_kind, key, field) => field === 'blob' ? `blob-${String(key['path'])}` : null,
      },
      // The one blob read (decision 0038): the graph names the blob, and the host answers its text — or cannot answer it,
      // which is the case one test names.
      readBlob: async (ask) => {
        const path = String(ask.blob).replace(/^blob-/u, '');
        if (path === 'src/absent.ts' && broken) throw new Error(`the host holds no text for ${path}`);
        const text = path === 'src/absent.ts' ? 'export const absent = 1;\n' : (FILES[path] ?? '');
        return { text, lines: text.split('\n').length, bytes: text.length, binary: false };
      },
    });
    session = await host.open();
  }, 120_000);
  afterAll(async () => { await session?.close(); rmSync(work, { recursive: true, force: true }); });

  test('it answers the imports of src/graph/write.ts with their places, forms and names, and the package they name', async () => {
    operations.length=0;
    const outcome = await session.runUnit({ unitId: 'imports-code.package', kind: 'code.package', key: {}, inputs: {} });
    if (outcome.state !== 'extracted') throw new Error(`the unit was not extracted: ${outcome.cause.code}: ${outcome.cause.message}`);
    expect(outcome.result.end.state).toBe('complete');
    // The unparseable file is a problem with its place; the unit still answers every other file.
    expect([...(outcome.result.problems??[])].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)).toEqual([
      { repository: 'app', path: 'src/broken.ts', line: 1, column: 23, message: 'the parser refused the file: Unexpected token (1:22)' },
      { repository: 'app', path: 'src/dangling.ts', line: 1, column: 1, message: 'the relative specifier "./nope.js" resolves to no file of the repository' },
    ]);
    const imports = operations.flatMap(operation=>operation.edges??[]).filter((edge) => edge.kind === 'code.imports' && edge.from.key['path'] === 'src/graph/write.ts')
      .map((edge) => [edge.discriminator, edge.to.key['path'], edge.values?.['specifier'], edge.values?.['form'], edge.values?.['names']])
      .sort();
    expect(imports).toEqual([
      ['1:1', 'src/graph/read.ts', './read.js', 'static', ['read']],
      ['2:1', 'src/shape.ts', '../shape.js', 'type', ['Shape']],
      ['3:1', 'src/helper.ts', '@app/helper.js', 'static', ['helper']],
    ]);
    const packages = operations.flatMap(operation=>operation.edges??[]).filter((edge) => edge.kind === 'code.imports-package').map((edge) => [edge.from.key['path'], edge.to.key]);
    expect(packages).toEqual([['src/graph/write.ts', { ecosystem: 'node', name: 'pg' }]]);
    // The plugin's contract declares `code.blob` vertices beside the package's (a699a96a4): the snapshot of each file
    // it read, keyed by its digest. This case holds the package's key to the sole `code.package` vertex.
    expect(operations.flatMap(operation=>operation.vertices??[]).filter((vertex) => vertex.kind === 'code.package').map((vertex) => vertex.key)).toEqual([{ ecosystem: 'node', name: 'pg' }]);
    // Missing endpoints are reported as problems and never sent to the atomic writer.
    const dangling=operations.flatMap(operation=>operation.edges??[]).filter(edge=>edge.kind==='code.imports'&&edge.from.key['path']==='src/dangling.ts');
    expect(dangling).toEqual([]);
    // The evidence names the file, its content and the line the import opens on. Under decision 0039 and the plugin's
    // contract (a699a96a4) the evidence's target is the `code.blob` vertex of the text, and the locator's digest is
    // that text's SHA-256, not the blob the graph names.
    const first = operations.flatMap(operation=>operation.edges??[]).find((edge) => edge.kind === 'code.imports' && edge.from.key['path'] === 'src/graph/write.ts' && edge.discriminator === '1:1');
    const digest = createHash('sha256').update(FILES['src/graph/write.ts']!).digest('hex');
    expect(first?.evidence).toMatchObject({ target:{kind:'code.blob',key:{digest}}, path: 'src/graph/write.ts', lineStart: 1, lineEnd: 1, digest });
  }, 120_000);

  test('a file the host did not answer is a problem with its place, and the unit still answers the rest', async () => {
    broken = true;
    try {
      operations.length=0;
      const outcome = await session.runUnit({ unitId: 'imports-unread', kind: 'code.package', key: {}, inputs: {} });
      if (outcome.state !== 'extracted') throw new Error(JSON.stringify(outcome));
      expect(outcome.result.end.state).toBe('complete');
      expect([...(outcome.result.problems??[])].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)).toEqual([
        { repository: 'app', path: 'src/absent.ts', line: 1, column: 1, message: 'the file holds no blob the graph names, or the host could not read its text: src/plugin/host.ts:1: the read of blob "blob-src/absent.ts" of "app" for the plugin "imports" failed: the host holds no text for src/absent.ts' },
        { repository: 'app', path: 'src/broken.ts', line: 1, column: 23, message: 'the parser refused the file: Unexpected token (1:22)' },
        { repository: 'app', path: 'src/dangling.ts', line: 1, column: 1, message: 'the relative specifier "./nope.js" resolves to no file of the repository' },
      ]);
      // The files the host did answer are still read: write.ts's first import stands.
      expect(operations.flatMap(operation=>operation.edges??[]).some((edge) => edge.kind === 'code.imports' && edge.from.key['path'] === 'src/graph/write.ts')).toBe(true);
    } finally { broken = false; }
  }, 120_000);

});

describe.skipIf(sandboxProblem !== undefined)('a product repository filled with the static plugins and no agent', () => {
  let work: string;
  let folder: string;
  let product: KnowledgeProduct;
  let closeOwner: (() => Promise<void>) | undefined;

  /** The code.store rows the fill published: every import edge with its place and the two files it joins. */
  async function importEdges(): Promise<{ kind: string; discriminator: string; place: string; specifier: string; form: string; from: string; to: string; repository: string }[]> {
    const owner = await createTestDatabaseOwner({
      store: storeDatabasePath(productStoreFolder(folder, join(work, 'store'))),
      graphContract: withManifestContract(await readPinnedGraphContract(folder)),
    });
    try {
      const kinds = readKinds(folder);
      if (!kinds.present) throw new Error('the fixture manifest is absent');
      const contract = graphContractOf(kinds.manifest);
      const imports = contract.edge.find((edge) => edge.name === 'code.imports')!;
      const packages = contract.edge.find((edge) => edge.name === 'code.imports-package')!;
      const read=async(edge:typeof imports,packageEdge:boolean)=>await owner.run(async tx=>{
        const assertions=await readKindAssertions(tx,'edge',edge.name,['place','specifier','form']);
        const nodes=await tx.query<{id:number;key:Record<string,string>}>('SELECT id,key FROM node');
        const keys=new Map(nodes.rows.map(n=>[Number(n.id),n.key]));
        return assertions.sort((a,b)=>(a.discriminator??'')<(b.discriminator??'')?-1:1).map(row=>({kind:edge.name,discriminator:row.discriminator!,place:String(row.values['place']),specifier:String(row.values['specifier']),form:String(row.values['form']),from:String(keys.get(row.from!)?.['path']),to:String(keys.get(row.to!)?.[packageEdge?'name':'path']),repository:'app'}));
      });
      return [...(await read(imports, false)), ...(await read(packages, true))];
    } finally { await owner.close(); }
  }

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'madarch-imports-path-'));
    const draft = createDraft({ home: join(work, 'home'), name: 'imports-shop', gitEnv: gitEnv(IDENTITY) });
    if (draft.outcome !== 'created') throw new Error(`the draft product was not made: ${JSON.stringify(draft)}`);
    folder = draft.folder;
    const code = join(folder, 'repos', 'app');
    for (const [path, text] of Object.entries(FILES)) {
      mkdirSync(join(code, path.slice(0, path.lastIndexOf('/'))), { recursive: true });
      writeFileSync(join(code, path), text);
    }
    execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: code, env: gitEnv(IDENTITY) });
    execFileSync('git', ['add', '-A'], { cwd: code, env: gitEnv(IDENTITY) });
    execFileSync('git', ['commit', '--quiet', '-m', 'First commit'], { cwd: code, env: gitEnv(IDENTITY) });
    useFixturePlugins(folder, ['disk', 'git', 'imports']);
    const manifest = join(folder, 'workspace.yaml');
    writeFileSync(manifest, manifestWithRepo(readFileSync(manifest, 'utf8'), { name: 'app', linked: true }));
    execFileSync('git', ['add', '-A'], { cwd: folder, env: gitEnv(IDENTITY) });
    execFileSync('git', ['commit', '--quiet', '-m', 'Connect the code repository'], { cwd: folder, env: gitEnv(IDENTITY) });
    closeOwner = await retainTestStorePreparationOwner();
    product = new KnowledgeProduct({ productFolder: folder, storeRoot: join(work, 'store') });
    const started = await product.startFill();
    if (!('started' in started) || started.started !== true) throw new Error(`the fill did not start: ${JSON.stringify(started)}`);
    await product.settled();
    const state = product.fillState();
    if (state.state !== 'done') throw new Error(`the fill did not finish: ${JSON.stringify(state)}`);
  }, 600_000);

  afterAll(async () => {
    await product?.close();
    await closeOwner?.();
    rmSync(work, { recursive: true, force: true });
  });

  test('the graph holds the imports of src/graph/write.ts and the files that import it, with their places', async () => {
    const edges = (await importEdges()).filter((edge) => edge.repository === 'app');
    const imports = edges.filter((edge) => edge.kind === 'code.imports' && edge.from === 'src/graph/write.ts').map((edge) => [edge.place, edge.to, edge.specifier, edge.form]);
    expect(imports.sort()).toEqual([
      ['1:1', 'src/graph/read.ts', './read.js', 'static'],
      ['2:1', 'src/shape.ts', '../shape.js', 'type'],
      ['3:1', 'src/helper.ts', '@app/helper.js', 'static'],
    ]);
    const importers = edges.filter((edge) => edge.kind === 'code.imports' && edge.to === 'src/graph/write.ts').map((edge) => [edge.from, edge.place, edge.specifier]);
    expect(importers).toEqual([['src/edges.ts', '1:1', './graph/write.js']]);
    const packages = edges.filter((edge) => edge.kind === 'code.imports-package' && edge.from === 'src/graph/write.ts').map((edge) => [edge.place, edge.to, edge.specifier]);
    expect(packages).toEqual([['4:1', 'pg', 'pg']]);
  }, 300_000);

  test('0039.1: a missing import target never creates an edge or placeholder vertex',async()=>{
    const edges=await importEdges();
    expect(edges.filter(edge=>edge.kind==='code.imports'&&edge.from==='src/dangling.ts')).toEqual([]);
    const owner=await createTestDatabaseOwner({store:storeDatabasePath(productStoreFolder(folder,join(work,'store'))),graphContract:withManifestContract(await readPinnedGraphContract(folder))});
    try{
      const absent=await owner.run(tx=>tx.query("SELECT n.uid FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='code.file' AND n.key->>'path'='src/nope.js'"));
      expect(absent.rows).toEqual([]);
    }finally{await owner.close();}
  },300000);

  test('the unparseable file is recorded as the producer\'s problem, with its place, and the fill still completes', async () => {
    const owner = await createTestDatabaseOwner({
      store: storeDatabasePath(productStoreFolder(folder, join(work, 'store'))),
      graphContract: withManifestContract(await readPinnedGraphContract(folder)),
    });
    try {
      const outcomes = await readProducerOutcomes(owner, {});
      const imports = outcomes.find((outcome) => outcome.plugin === 'imports');
      expect(imports?.outcome).toBe('completed');
      expect(imports?.reason).toContain('2 places could not be read:');
      expect(imports?.reason).toContain('app/src/broken.ts:1:23 the parser refused the file: Unexpected token (1:22)');
      expect(imports?.reason).toContain('app/src/dangling.ts:1:1 the relative specifier "./nope.js" resolves to no file of the repository');
    } finally { await owner.close(); }
  }, 300_000);
});
