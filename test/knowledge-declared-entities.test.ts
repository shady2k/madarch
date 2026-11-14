import { readFolderManifestText, writeFolderManifest } from './catalog-folder-fixture.js';
/**
 * The tree and history passes publish the mechanism entries always and only the entities the product's manifest
 * declares (madarch-hsqs stage C): a manifest declaring code.file and not code.repository fills, and one declaring
 * code.repository and not code.file fills, each with no table and no row for the kind it does not declare.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { createDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createDraft } from '../src/product/draft.js';
import { knowledgeRootOf, productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import type { StartedServer } from '../src/server/http.js';
import { startPreparedServer } from './prepared-server.js';
import { prepareStore } from '../src/adapters/prepare-store.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { runFill } from '../src/fill/run.js';
import { closureOf } from '../src/plugin/closure.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';
import { gitEnv } from './git-env.js';

const env = gitEnv(SAMPLE_IDENTITY);
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

let root = '';
let home = '';
let app = '';
let server: StartedServer | undefined;
const errors: string[] = [];

/** An ordinary disk fixture declaring only the named code kinds and references within that set. */
function draftWithKinds(name: string, kinds: readonly string[]): string {
  const draft = createDraft({ home, name, gitEnv: env });
  if (draft.outcome !== 'created') throw new Error(`the fixture product was not made: ${JSON.stringify(draft)}`);
  const manifest = parse(readFolderManifestText(draft.folder)) as { kinds: Record<string, { fields?: { reference?: string }[]; 'derives-from'?: string[] }>; edges?: { from: string[]; to: string[] }[]; plugins: { id: string; outputs: string[] }[] };
  const declared = [...kinds];
  for (const kind of Object.keys(manifest.kinds)) if (!declared.includes(kind)) delete manifest.kinds[kind];
  for (const kind of Object.values(manifest.kinds)) {
    if (kind['derives-from'] !== undefined) kind['derives-from'] = kind['derives-from'].filter((dependency) => declared.includes(dependency));
    if (kind.fields !== undefined) for (const field of kind.fields) {
      if (field.reference !== undefined && !declared.includes(field.reference)) delete field.reference;
    }
  }
  manifest.edges = (manifest.edges ?? []).filter((edge) => edge.from.every((kind) => declared.includes(kind)) && edge.to.every((kind) => declared.includes(kind)));
  const pluginFolder = join(draft.folder, 'plugins', 'disk');
  const declarationFile = join(pluginFolder, 'plugin.json');
  const declaration = JSON.parse(readFileSync(declarationFile, 'utf8'));
  declaration.produces = declaration.produces.filter((output: { kind: string }) => kinds.includes(output.kind));
  writeFileSync(declarationFile, JSON.stringify(declaration, null, 2));
  const contractFile = join(pluginFolder, 'contract.json');
  const contract = JSON.parse(readFileSync(contractFile, 'utf8'));
  contract.outputs.vertices = contract.outputs.vertices.filter((output: { kind: string }) => kinds.includes(output.kind));
  contract.outputs.edges = [];
  writeFileSync(contractFile, JSON.stringify(contract, null, 2));
  manifest.plugins = manifest.plugins.filter((plugin) => plugin.id === 'disk').map((plugin) => ({ ...plugin, outputs: plugin.outputs.filter((kind) => kinds.includes(kind)) }));
  writeFileSync(join(draft.folder, 'madarch', 'plugins.lock'), stringify({ plugins: [{
    id: 'disk', version: declaration.version, path: 'plugins/disk', closure: closureOf(pluginFolder).hash,
  }] }));
  writeFolderManifest(draft.folder, stringify(manifest));
  writeFileSync(join(draft.folder, 'madarch', 'workflows.yaml'), `workflows:
  first-fill:
    status: implemented
    stages: [plugin-turns]
`);
  git(draft.folder, 'add', '-A');
  git(draft.folder, 'commit', '-qm', `the manifest declares ${kinds.join(', ')} and no other code kind`);
  return draft.folder;
}

/** Trust the fixture's explicitly narrowed disk closure, not a native producer exception. */
async function fillInProcess(product: string, productHome: string) {
  const store = productStoreFolder(product, knowledgeRootOf(productHome));
  const owner = await createDatabaseOwner({ store: storeDatabasePath(store), btreeGist: true });
  try {
    await prepareStore(owner, { contract: await readPinnedGraphContract(product) });
    return await runFill({ product, home: productHome, store, database: owner,
      releaseHashes: [closureOf(join(product, 'plugins', 'disk')).hash],
      prepareContract: async (contract) => { await prepareStore(owner, { contract }); },
    });
  } finally { await owner.close(); }
}

async function tables(store: string): Promise<string[]> {
  const owner: DatabaseOwner = await createDatabaseOwner({ store: storeDatabasePath(store), btreeGist: true });
  try {
    const found = await owner.run((tx) => tx.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`,
    ));
    return found.rows.map((row) => row.table_name);
  } finally {
    await owner.close().catch(() => undefined);
  }
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-declared-entities-'));
  home = join(root, 'products');
  app = join(root, 'app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>wiki</title>\n');
  draftWithKinds('files-only', ['code.file']);
  draftWithKinds('repos-only', ['code.repository']);
  server = await startPreparedServer({ productHome: home, knowledgeRoot: knowledgeRootOf(home), appFolder: app, port: 0, log: () => undefined, errorLog: (line) => errors.push(line) });
}, 120_000);

afterAll(async () => {
  await server?.stop();
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

describe('a manifest declares one code kind and not the other', () => {
  test('code.file without code.repository fills: files are published, no repository table stands', async () => {
    const product = join(home, 'files-only');
    const filled = await fillInProcess(product, home);
    const status = await (await fetch(`${server!.url}/products/files-only/api/status`, { headers: { accept: 'application/json' } })).json() as { filled: boolean; kinds: { kind: string; count: number }[] };
    expect(status.filled, JSON.stringify({ filled, status, errors })).toBe(true);
    expect(status.kinds.find((kind) => kind.kind === 'code.file')?.count).toBeGreaterThan(0);
    expect(status.kinds.some((kind) => kind.kind === 'code.repository')).toBe(false);
    const names = await tables(productStoreFolder(product, knowledgeRootOf(home)));
    expect(names.some((name) => name.startsWith('k_code_file_'))).toBe(true);
    expect(names.some((name) => name.startsWith('k_code_repository_'))).toBe(false);
    // Its reads: the product's status answers, and no statement names a table the manifest did not make (madarch-hsqs
    // stage C: the declared contract, not a caught 42P01). The graph itself is read through `/graphql`.
    const graph = await fetch(`${server!.url}/products/files-only/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ allCodeFile(first: 1) { totalCount } }' }) });
    expect(graph.status, JSON.stringify({ body: await graph.clone().text(), errors })).toBe(200);
    expect(errors.filter((line) => /does not exist|42P01/i.test(line))).toEqual([]);
  }, 60_000);

  test('code.repository without code.file fills: the repository is published, no file table stands', async () => {
    const product = join(home, 'repos-only');
    await fillInProcess(product, home);
    const status = await (await fetch(`${server!.url}/products/repos-only/api/status`, { headers: { accept: 'application/json' } })).json() as { filled: boolean; kinds: { kind: string; count: number }[] };
    expect(status.filled).toBe(true);
    expect(status.kinds.find((kind) => kind.kind === 'code.repository')?.count).toBe(1);
    expect(status.kinds.some((kind) => kind.kind === 'code.file')).toBe(false);
    const names = await tables(productStoreFolder(product, knowledgeRootOf(home)));
    expect(names.some((name) => name.startsWith('k_code_repository_'))).toBe(true);
    expect(names.some((name) => name.startsWith('k_code_file_'))).toBe(false);
    // The one declared kind answers through the graph, and nothing names a file or commit table.
    const graph = await fetch(`${server!.url}/products/repos-only/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ allCodeRepository(first: 1) { totalCount } }' }) });
    expect(graph.status, JSON.stringify({ body: await graph.text(), errors })).toBe(200);
    expect(errors.filter((line) => /does not exist|42P01/i.test(line))).toEqual([]);
  }, 60_000);
});
