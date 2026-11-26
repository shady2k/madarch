import { readFolderManifestText, writeFolderManifest } from './catalog-folder-fixture.js';
/**
 * The tree and history passes publish the mechanism entries always and only the entities the product's manifest
 * declares (madarch-hsqs stage C): a manifest declaring code.file and not code.repository fills, and one declaring
 * code.repository and not code.file fills, each with no table and no row for the kind it does not declare.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { createDraft } from '../src/product/draft.js';
import { manifestWithRepo } from '../src/product/manifest.js';
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
  type DraftKind = {
    fields?: { name?: string; binding?: unknown; producers?: string[]; reference?: string }[];
    'derives-from'?: string[];
    'key-edges'?: { role: string; edge: string; side: 'from' | 'to' }[];
    'file-text'?: Record<string, string>;
  };
  type DraftBinding = { kind: string; fields: Record<string, string>; edges?: Record<string, { kind: string; direction: 'from' | 'to' }>; values?: Record<string, Record<string, string | number | boolean>> };
  const manifest = parse(readFolderManifestText(draft.folder)) as {
    kinds: Record<string, DraftKind>;
    edges?: { name: string; from: string[]; to: string[] }[];
    'semantic-bindings'?: Record<string, DraftBinding>;
    plugins: { id: string; outputs: string[] }[];
  };
  // ALX-461: a plugin reads the product's declared code repositories, never the product's own folder (0029). A
  // fixture that expects code facts connects one, as a person's product does with `madarch repo add`.
  const repository = join(root, 'sources', name);
  mkdirSync(join(repository, 'src'), { recursive: true });
  writeFileSync(join(repository, 'src', `${name.replace(/[^a-z0-9]+/g, '-')}.ts`), `export const sample = '${name}';\n`);
  git(repository, 'init', '-q', '-b', 'main');
  git(repository, 'add', '-A');
  git(repository, 'commit', '-qm', `the ${name} source`);
  symlinkSync(repository, join(draft.folder, 'repos', name));
  const workspace = join(draft.folder, 'workspace.yaml');
  writeFileSync(workspace, manifestWithRepo(readFileSync(workspace, 'utf8'), { name, linked: true }));
  // The disk plugin's evidence support is a mechanism entry the product installs beside the kinds the test names: every
  // fact it writes stands on an immutable snapshot, and no code kind is published without one (0039, evidence).
  const declared = [...kinds, 'code.blob'];
  for (const kind of Object.keys(manifest.kinds)) if (!declared.includes(kind)) delete manifest.kinds[kind];
  manifest.edges = (manifest.edges ?? []).filter((edge) => edge.from.every((kind) => declared.includes(kind)) && edge.to.every((kind) => declared.includes(kind)));
  const edges = new Map(manifest.edges.map((edge) => [edge.name, edge]));
  for (const kind of Object.values(manifest.kinds)) {
    if (kind['derives-from'] !== undefined) kind['derives-from'] = kind['derives-from'].filter((dependency) => declared.includes(dependency));
    if (kind.fields !== undefined) for (const field of kind.fields) {
      if (field.reference !== undefined && !declared.includes(field.reference)) delete field.reference;
      // The fixture keeps the disk plugin alone: a field another producer would fill is a person's own writing here,
      // so the plan leaves it unfilled instead of failing the kind for a producer the product does not hold.
      const bound = typeof field.binding === 'string' ? field.binding.split('@')[0]! : undefined;
      const named = [...(bound === undefined ? [] : [bound]), ...(field.producers ?? [])];
      if (!named.includes('person') && !named.includes('disk')) {
        delete field.binding;
        field.producers = ['person'];
      }
    }
    // A parent role names an edge the fixture keeps and an end the remaining declaration still holds.
    if (kind['key-edges'] !== undefined) {
      kind['key-edges'] = kind['key-edges'].filter((role) => edges.get(role.edge) !== undefined);
      if (kind['key-edges'].length === 0) delete kind['key-edges'];
    }
    // A file's text is read through the repository edge; a fixture without that edge states no text role at all.
    if (kind['file-text'] !== undefined && !edges.has(kind['file-text']['repository'] ?? '')) delete kind['file-text'];
  }
  // A semantic binding names a kind and edges the fixture keeps; a binding whose kind left is no part of this product.
  if (manifest['semantic-bindings'] !== undefined) {
    for (const [role, binding] of Object.entries(manifest['semantic-bindings'])) {
      const kind = manifest.kinds[binding.kind];
      if (kind === undefined) { delete manifest['semantic-bindings'][role]; continue; }
      for (const [property, edge] of Object.entries(binding.edges ?? {})) {
        const held = edges.get(edge.kind);
        if (held === undefined || !held[edge.direction].includes(binding.kind)) delete binding.edges![property];
      }
      if (binding.edges !== undefined && Object.keys(binding.edges).length === 0) delete binding.edges;
      for (const [property, field] of Object.entries(binding.fields)) {
        if (!(kind.fields ?? []).some((candidate) => candidate.name === field)) delete binding.fields[property];
      }
      for (const property of Object.keys(binding.values ?? {})) if (binding.fields[property] === undefined) delete binding.values![property];
    }
  }
  const pluginFolder = join(draft.folder, 'plugins', 'disk');
  const declarationFile = join(pluginFolder, 'plugin.json');
  const declaration = JSON.parse(readFileSync(declarationFile, 'utf8'));
  declaration.produces = declaration.produces.filter((output: { kind: string }) => kinds.includes(output.kind))
    .map((output: { support?: { vertices?: string[]; edges?: string[] } }) => ({
      ...output,
      support: {
        vertices: (output.support?.vertices ?? []).filter((kind) => declared.includes(kind)),
        edges: (output.support?.edges ?? []).filter((kind) => edges.has(kind)),
      },
    }));
  writeFileSync(declarationFile, JSON.stringify(declaration, null, 2));
  const contractFile = join(pluginFolder, 'contract.json');
  const contract = JSON.parse(readFileSync(contractFile, 'utf8'));
  contract.outputs.vertices = contract.outputs.vertices.filter((output: { kind: string }) => declared.includes(output.kind))
    .map((output: { keyEdges?: { role: string; edge: string }[] }) => {
      if (output.keyEdges === undefined) return output;
      const kept = output.keyEdges.filter((role) => edges.has(role.edge));
      return kept.length === 0 ? { ...output, keyEdges: undefined } : { ...output, keyEdges: kept };
    });
  contract.outputs.edges = [];
  writeFileSync(contractFile, JSON.stringify(contract, null, 2));
  manifest.plugins = manifest.plugins.filter((plugin) => plugin.id === 'disk').map((plugin) => ({ ...plugin, outputs: plugin.outputs.filter((kind) => declared.includes(kind)) }));
  writeFileSync(join(draft.folder, 'madarch', 'plugins.lock'), stringify({ plugins: [{
    id: 'disk', version: declaration.version, path: 'plugins/disk', closure: closureOf(pluginFolder).hash,
  }] }));
  writeFolderManifest(draft.folder, stringify(manifest));
  // The starter's file page also reads commit kinds that this fixture deliberately omits.
  rmSync(join(draft.folder, 'templates', 'code-file.yaml'));
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

/** One GraphQL answer as the status and body a reader sees, so a refused undeclared kind is an answer too. */
async function graphql(product: string, query: string): Promise<{ status: number; body: Record<string, any> }> {
  const answer = await fetch(`${server!.url}/products/${product}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
  return { status: answer.status, body: (await answer.json()) as Record<string, any> };
}

describe('a manifest declares one code kind and not the other', () => {
  test('code.file without code.repository fills: files are published, no repository kind answers', async () => {
    const product = join(home, 'files-only');
    await fillInProcess(product, home);
    const status = await (await fetch(`${server!.url}/products/files-only/api/status`, { headers: { accept: 'application/json' } })).json() as { filled: boolean; kinds: { kind: string; count: number }[] };
    expect(status.filled, JSON.stringify({ status, errors })).toBe(true);
    expect(status.kinds.find((kind) => kind.kind === 'code.file')?.count).toBeGreaterThan(0);
    expect(status.kinds.some((kind) => kind.kind === 'code.repository')).toBe(false);
    // Its reads: the declared kind answers through `/graphql`, and no statement names storage the manifest did not make
    // (madarch-hsqs stage C: the declared contract, not a caught 42P01). A kind the manifest leaves out has no door.
    const files = await graphql('files-only', '{ allCodeFile(first: 1) { totalCount } }');
    expect(files.status, JSON.stringify({ body: files.body, errors })).toBe(200);
    expect(files.body['data']['allCodeFile']['totalCount']).toBeGreaterThan(0);
    const repository = await graphql('files-only', '{ allCodeRepository(first: 1) { totalCount } }');
    expect(repository.status).toBe(400);
    expect(JSON.stringify(repository.body)).toContain('allCodeRepository');
    expect(errors.filter((line) => /does not exist|42P01/i.test(line))).toEqual([]);
  }, 60_000);

  test('code.repository without code.file fills: the repository is published, no file kind answers', async () => {
    const product = join(home, 'repos-only');
    await fillInProcess(product, home);
    const status = await (await fetch(`${server!.url}/products/repos-only/api/status`, { headers: { accept: 'application/json' } })).json() as { filled: boolean; kinds: { kind: string; count: number }[] };
    expect(status.filled).toBe(true);
    expect(status.kinds.find((kind) => kind.kind === 'code.repository')?.count).toBe(1);
    expect(status.kinds.some((kind) => kind.kind === 'code.file')).toBe(false);
    // The one declared kind answers through the graph; the kind the manifest leaves out has no door.
    const repositories = await graphql('repos-only', '{ allCodeRepository(first: 1) { totalCount } }');
    expect(repositories.status, JSON.stringify({ body: repositories.body, errors })).toBe(200);
    expect(repositories.body['data']['allCodeRepository']['totalCount']).toBe(1);
    const files = await graphql('repos-only', '{ allCodeFile(first: 1) { totalCount } }');
    expect(files.status).toBe(400);
    expect(JSON.stringify(files.body)).toContain('allCodeFile');
    expect(errors.filter((line) => /does not exist|42P01/i.test(line))).toEqual([]);
  }, 60_000);
});
