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
import { gitEnv } from './git-env.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { createTestDatabaseOwner } from './test-database.js';
import { unresolvedReferences } from '../src/graph/index.js';
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

/** The glob the fixture's fake graph answers: every file for `**` and a suffix match for a source pattern. */
function matched(pattern: string, path: string): boolean {
  if (pattern === '**/*') return true;
  const wildcard = pattern.replace('**/', '');
  if (wildcard.startsWith('*.')) return path.endsWith(wildcard.slice(1));
  return path === wildcard;
}

/** Whether the fake host answers no text for the file the unread-content case asks for. */
let broken = false;

describe.skipIf(sandboxProblem !== undefined)('the imports plugin on a source the host holds', () => {
  let work: string;
  let session: Awaited<ReturnType<PluginHost['open']>>;

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'madarch-imports-unit-'));
    const closure = closureOf(join(PLUGINS, 'plugins', 'imports'));
    const host = new PluginHost({
      pluginFolder: join(PLUGINS, 'plugins', 'imports'),
      closure,
      repository: work,
      workRoot: mkdtempSync(join(tmpdir(), 'madarch-imports-host-')),
      trust: 'production',
      releaseHashes: [closure.hash],
      ...(cgroupParent() === undefined ? {} : { cgroupParent: cgroupParent() }),
      graph: {
        files: async (pattern) => [...Object.keys(FILES), 'src/absent.ts'].filter((path) => matched(pattern, path)).map((path) => ({ kind: 'code.file', key: { repository: 'app', path } })),
        value: async (_kind, key, field) => {
          const path = String(key['path']);
          if (field === 'blob') return `blob-${path}`;
          if (field !== 'content') return null;
          // The case that asks for the unread file makes the host answer no text for it.
          if (path === 'src/absent.ts') return broken ? null : 'export const absent = 1;\n';
          return FILES[path] ?? null;
        },
      },
    });
    session = await host.open();
  }, 120_000);
  afterAll(async () => { await session?.close(); rmSync(work, { recursive: true, force: true }); });

  test('it answers the imports of src/graph/write.ts with their places, forms and names, and the package they name', async () => {
    const outcome = await session.runUnit({ unitId: 'imports-code.package', kind: 'code.package', key: { pattern: '' }, inputs: { patterns: [] } });
    if (outcome.state !== 'extracted') throw new Error(`the unit was not extracted: ${outcome.cause.code}: ${outcome.cause.message}`);
    expect(outcome.result.end.state).toBe('complete');
    const imports = outcome.result.edges.filter((edge) => edge.kind === 'code.imports' && edge.from.key['path'] === 'src/graph/write.ts')
      .map((edge) => [edge.discriminator, edge.to.key['path'], edge.values?.['specifier'], edge.values?.['form'], edge.values?.['names']])
      .sort();
    expect(imports).toEqual([
      ['1:1', 'src/graph/read.ts', './read.js', 'static', ['read']],
      ['2:1', 'src/shape.ts', '../shape.js', 'type', ['Shape']],
      ['3:1', 'src/helper.ts', '@app/helper.js', 'static', ['helper']],
    ]);
    const packages = outcome.result.edges.filter((edge) => edge.kind === 'code.imports-package').map((edge) => [edge.from.key['path'], edge.to.key]);
    expect(packages).toEqual([['src/graph/write.ts', { ecosystem: 'node', name: 'pg' }]]);
    expect(outcome.result.vertices.map((vertex) => vertex.key)).toEqual([{ ecosystem: 'node', name: 'pg' }]);
    // A relative specifier no file answers is an edge to the path it names: the host records the unresolved end and its
    // place, and the unit states everything it did read.
    const dangling = outcome.result.edges.filter((edge) => edge.kind === 'code.imports' && edge.from.key['path'] === 'src/dangling.ts');
    expect(dangling.map((edge) => [edge.discriminator, edge.to.key, edge.values?.['specifier'], edge.values?.['form']])).toEqual([['1:1', { repository: 'app', path: 'src/nope.js' }, './nope.js', 'static']]);
    // The evidence names the file, its blob and the line the import opens on.
    const first = outcome.result.edges.find((edge) => edge.kind === 'code.imports' && edge.from.key['path'] === 'src/graph/write.ts' && edge.discriminator === '1:1');
    expect(first?.evidence).toMatchObject({ repository: 'app', path: 'src/graph/write.ts', lineStart: 1, lineEnd: 1, commitOrDigest: 'blob-src/graph/write.ts' });
  }, 120_000);

  test('a file the host was asked for and did not answer is a partial unit naming its place', async () => {
    broken = true;
    try {
      const outcome = await session.runUnit({ unitId: 'imports-unread', kind: 'code.package', key: { pattern: 'src/absent.ts' }, inputs: { patterns: ['src/absent.ts'] } });
      if (outcome.state !== 'extracted') throw new Error(JSON.stringify(outcome));
      expect(outcome.result.end.state).toBe('partial');
      if (outcome.result.end.state !== 'partial') throw new Error('expected a partial unit');
      expect(outcome.result.end.cause).toBe('1 import could not be read: app/src/absent.ts:1:1 the file content is not in the graph');
      expect(outcome.result.edges).toEqual([]);
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
      const read = async (edge: typeof imports, packageEdge: boolean) => (await owner.transaction('snapshot', async (tx) => await tx.query<{ discriminator: string; place: string; specifier: string; form: string; from_key: Record<string, string>; to_key: Record<string, string> }>(
        `SELECT e.discriminator, a.place, a.specifier, a.form, fn.key AS from_key, tn.key AS to_key
           FROM edge e
           JOIN entity k ON k.id = e.entity_id AND k.name = $1
           JOIN ${edge.table} a ON a.edge_id = e.id AND a.state = 'open'
           JOIN node fn ON fn.id = e.from_node
           JOIN node tn ON tn.id = e.to_node
          ORDER BY e.discriminator`, [edge.name]))).rows.map((row) => ({
            kind: edge.name,
            discriminator: row.discriminator,
            place: row.place,
            specifier: row.specifier,
            form: row.form,
            from: String(row.from_key['path']),
            to: packageEdge ? String(row.to_key['name']) : String(row.to_key['path']),
            repository: String(row.from_key['repository']),
          }));
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

  test('an import no file answers is an unresolved reference of the graph, with its place', async () => {
    const owner = await createTestDatabaseOwner({
      store: storeDatabasePath(productStoreFolder(folder, join(work, 'store'))),
      graphContract: withManifestContract(await readPinnedGraphContract(folder)),
    });
    try {
      const refs = await unresolvedReferences(owner, { limit: 1_000 });
      const dangling = refs.rows.filter((row) => row.edge?.kind === 'code.imports' && row.edge.from?.key['path'] === 'src/dangling.ts');
      expect(dangling.map((row) => [row.edge?.from?.key, row.field, row.target.key, row.edge?.discriminator])).toEqual([
        [{ repository: 'app', path: 'src/dangling.ts' }, 'to', { repository: 'app', path: 'src/nope.js' }, '1:1'],
      ]);
    } finally { await owner.close(); }
  }, 300_000);
});
