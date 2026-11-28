/**
 * A product's catalogue is the manifest's, published when the wiki opens the product, and its code is the linked
 * repositories' alone (ALX-1937: FR-005, FR-006, UC-003, UC-004; the owner's decision of 2026-11-27).
 *
 * Five cases, each on a product this file builds itself, never a model and never a network:
 *
 * - a fresh start publishes the catalogue — kinds and their fields, workflows and relationship types — before any fill
 *   is pressed and without an agent;
 * - a fill of a product that links one repository publishes code entities for that repository only: no
 *   `code.repository`, `code.directory` or `code.file` of the product's own checkout reaches the graph;
 * - a product whose manifest links no repository has its catalogue and no code entity at all;
 * - the managed press with an agent (ALX-2067, finding 7): the reader's own serving, the fill the button asks for, and
 *   the agent at the end of it — a hand-written ACP adapter found by its product name on the PATH, as a real one is.
 *   It reads the graph through the session's server and the file inventory through madarch's own file callback, and
 *   writes what it saw to a record the case asserts on: the linked repository alone, and no product file at all. The
 *   same boundary is exercised for an explicitly empty declared `repos:`.
 *
 * The product's own checkout is still pinned, because its manifests are read from the commit the run stands on; what
 * changed is that the pinned checkout is handed to no code plugin and to no agent (`src/fill/plugin-turns.ts`).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { parse, stringify } from 'yaml';
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { probePluginSandbox } from '../src/plugin/sandbox-probe.js';
import { readFolderManifestText, writeFolderManifest } from './catalog-folder-fixture.js';
import { runFill } from '../src/fill/run.js';
import { seedStarterSet } from '../src/knowledge/seed.js';
import { prepareStore } from '../src/adapters/prepare-store.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { manifestWithRepo } from '../src/product/manifest.js';
import { createDraft } from '../src/product/draft.js';
import { knowledgeRootOf, productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { serveWiki, type ServeResult } from '../src/product-wiki/serve.js';
import type { StartedServer } from '../src/server/http.js';
import { prepareTestProduct } from './prepared-server.js';
import { useFixturePlugins } from './enabled-plugins-fixture.js';
import { commitProduct, SAMPLE_IDENTITY } from './knowledge-fixture.js';
import { gitEnv } from './git-env.js';

const folders: string[] = [];
const servers: StartedServer[] = [];
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const close of closers.splice(0)) await close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function scratch(): string {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-catalogue-boundary-'));
  folders.push(folder);
  return folder;
}

/** A built stand-in for the wiki app: these cases read the server's answers, never its files. */
function builtApp(base: string): string {
  const app = join(base, 'app', 'dist');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>test app</title>');
  return join(base, 'app');
}

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: gitEnv(SAMPLE_IDENTITY) }).trim();

/**
 * A committed source repository the product can link: two files, one of them under a folder, so the disk plugin has a
 * file, a directory and an inventory to publish.
 */
function sourceRepository(base: string): string {
  const repository = join(base, 'source');
  mkdirSync(join(repository, 'src'), { recursive: true });
  writeFileSync(join(repository, 'README.md'), '# Source\n');
  writeFileSync(join(repository, 'src/a.ts'), 'export const a = 1;\n');
  git(repository, 'init', '--quiet', '--initial-branch=main');
  git(repository, 'add', '-A');
  git(repository, 'commit', '--quiet', '-m', 'Source');
  return repository;
}

/**
 * A product with the starter catalogue and one file producer, committed so the fill pins a commit. `repository` links a
 * code repository under `repos/`; leaving it out writes a manifest that links none. `realPlugins` keeps the product's
 * whole plugin set for the managed press, whose agent the fixture below asks for.
 */
function product(base: string, name: string, repository?: string, realPlugins = false): string {
  const draft = createDraft({ home: base, name, gitEnv: gitEnv(SAMPLE_IDENTITY) });
  if (draft.outcome !== 'created') throw new Error(`${import.meta.path}:1: the fixture product was not made: ${JSON.stringify(draft)}`);
  if (repository !== undefined) {
    writeFileSync(join(draft.folder, 'workspace.yaml'), manifestWithRepo(readFileSync(join(draft.folder, 'workspace.yaml'), 'utf8'), { name: 'source', linked: true }));
    symlinkSync(repository, join(draft.folder, 'repos', 'source'), 'dir');
  }
  seedStarterSet(draft.folder);
  // Only the disk producer and the product kind it refers to: these cases read code entities, not an agent's pages.
  // The managed press keeps the product's whole plugin set: its catalogue binds the plugins the agent's run reads.
  if (!realPlugins) useFixturePlugins(draft.folder, ['disk'], ['product']);
  commitProduct(draft.folder, 'Use the real scripted disk plugin');
  return draft.folder;
}

/** The entity kinds the store holds and how many nodes each stands on, read by the kind's own name. */
async function kindsOf(folder: string, home: string): Promise<Map<string, number>> {
  const store = productStoreFolder(folder, knowledgeRootOf(home));
  const owner = await createDatabaseOwner({ store: storeDatabasePath(store), btreeGist: true });
  try {
    const rows = await owner.run(async tx => (await tx.query<{ name: string; held: string }>(
      'SELECT e.name AS name, count(*)::text AS held FROM node n JOIN entity e ON e.id=n.entity_id GROUP BY e.name',
    )).rows);
    return new Map(rows.map(row => [row.name, Number(row.held)] as const));
  } finally {
    await owner.close();
  }
}

/** The edge kinds the store holds and how many edges each stands on, read by the kind's own name. */
async function edgesOf(folder: string, home: string): Promise<Map<string, number>> {
  const store = productStoreFolder(folder, knowledgeRootOf(home));
  const owner = await createDatabaseOwner({ store: storeDatabasePath(store), btreeGist: true });
  try {
    const rows = await owner.run(async tx => (await tx.query<{ name: string; held: string }>(
      'SELECT e.name AS name, count(*)::text AS held FROM edge ed JOIN entity e ON e.id=ed.entity_id GROUP BY e.name',
    )).rows);
    return new Map(rows.map(row => [row.name, Number(row.held)] as const));
  } finally {
    await owner.close();
  }
}

/** The keys of one kind's vertices in the store, in code point order. */
async function keysOf(folder: string, home: string, kind: string): Promise<Record<string, unknown>[]> {
  const store = productStoreFolder(folder, knowledgeRootOf(home));
  const owner = await createDatabaseOwner({ store: storeDatabasePath(store), btreeGist: true });
  try {
    const rows = await owner.run(async tx => (await tx.query<{ key: Record<string, unknown> }>(
      'SELECT n.key AS key FROM node n JOIN entity e ON e.id=n.entity_id WHERE e.name=$1 ORDER BY n.key::text',
      [kind],
    )).rows);
    return rows.map(row => row.key);
  } finally {
    await owner.close();
  }
}

/** Fills one product's code kinds with the fixture plugins only, through the same runner the wiki's button asks. */
async function fillCode(product: string, home: string): Promise<void> {
  const store = productStoreFolder(product, knowledgeRootOf(home));
  const owner = await createDatabaseOwner({ store: storeDatabasePath(store), btreeGist: true });
  try {
    const contract = await readPinnedGraphContract(product);
    await prepareStore(owner, { contract });
    const result = await runFill({
      product, database: owner, store, home, runId: `catalogue-boundary-${String(Date.now())}`,
      steps: ['plugin-turns'],
      targets: { kinds: ['code.repository', 'code.directory', 'code.file', 'code.gitlink'], pluginsOnly: true },
      prepareContract: async (held) => { await prepareStore(owner, { contract: held }); },
    });
    if (!result.ok) throw new Error(`${import.meta.path}:1: the fill was refused (${result.code}): ${result.reason}`);
    expect(result.state).toBe('succeeded');
  } finally {
    await owner.close().catch(() => undefined);
  }
}

const CATALOGUE_KINDS = ['manifest.kind', 'manifest.field', 'manifest.relation', 'manifest.workflow'] as const;
const CODE_KINDS = ['code.repository', 'code.directory', 'code.file', 'code.gitlink'] as const;

test('a fresh start publishes the catalogue before any fill, and the product links one repository', async () => {
  const base = scratch();
  const productFolder = product(base, 'catalogue-start', sourceRepository(base));
  closers.push(await prepareTestProduct(productFolder, base));
  const served: ServeResult = await serveWiki({ productFolder, appFolder: builtApp(base), port: 0, open: false, print: () => {}, printError: () => {} });
  if (served.outcome !== 'serving') throw new Error(`${import.meta.path}:1: the wiki did not serve: ${served.message}`);
  servers.push(served.server);
  // The app's first read: the catalogue is the manifest's, so it stands before any fill and without an agent.
  expect((await fetch(`${served.url}/api/status`)).status).toBe(200);
  const kinds = await kindsOf(productFolder, base);
  for (const kind of CATALOGUE_KINDS) expect([kind, (kinds.get(kind) ?? 0) > 0]).toEqual([kind, true]);
  // No fill has run: no code entity of any repository stands in the graph yet.
  for (const kind of CODE_KINDS) expect([kind, kinds.get(kind) ?? 0]).toEqual([kind, 0]);
  expect(kinds.get('agent-usage') ?? 0).toBe(0);
  expect(kinds.get('agent-session') ?? 0).toBe(0);
  // The reader sees the same catalogue through the GraphQL schema the wiki, MCP and outside systems read (decision
  // 0036): managed startup published it, and no fill was pressed for this answer (ALX-2067, finding 7).
  const answered = await fetch(`${served.url}/graphql`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'query { allManifestCatalogue(first: 1) { totalCount } allManifestField(first: 1) { totalCount } allManifestRelation(first: 1) { totalCount } allManifestWorkflow(first: 1) { totalCount } allCodeRepository(first: 1) { totalCount } }' }),
  });
  const body = (await answered.json()) as { data?: Record<string, { totalCount: number }>; errors?: { message: string }[] };
  if (answered.status !== 200 || (body.errors?.length ?? 0) > 0) throw new Error(`${import.meta.path}:1: the catalogue GraphQL read answered ${String(answered.status)}: ${(body.errors ?? []).map((error) => error.message).join('; ') || JSON.stringify(body)}`);
  // The schema's own names for the manifest's declarations (decision 0036): the catalogue with its fields, the
  // relationship types and the workflows, and no code repository before a fill.
  for (const field of ['allManifestCatalogue', 'allManifestField', 'allManifestRelation', 'allManifestWorkflow'] as const) expect([field, (body.data?.[field]?.totalCount ?? 0) > 0]).toEqual([field, true]);
  expect(body.data?.['allCodeRepository']?.totalCount ?? -1).toBe(0);
}, 300_000);

test('a fill with a linked repository publishes code entities of that repository alone', async () => {
  const base = scratch();
  const productFolder = product(base, 'catalogue-linked', sourceRepository(base));
  await fillCode(productFolder, base);
  const repositories = await keysOf(productFolder, base, 'code.repository');
  expect(repositories.map(key => key['name'])).toEqual(['source']);
  const files = (await keysOf(productFolder, base, 'code.file')).map(key => String(key['path'])).sort();
  expect(files).toEqual(['README.md', 'src/a.ts']);
  // Nothing of the product's own checkout reached the graph: not its manifest, not its documents, not its plugin folder.
  for (const path of files) expect(path.startsWith('madarch/') || path === 'workspace.yaml' || path.startsWith('docs/')).toBe(false);
  const kinds = await kindsOf(productFolder, base);
  expect(kinds.get('code.directory') ?? 0).toBeGreaterThan(0);
  // The one reference the product states is the one to the repository it links, and no second one to its own checkout.
  const edges = await edgesOf(productFolder, base);
  expect(edges.get('product.uses-repository') ?? 0).toBe(1);
}, 300_000);

test('a product that links no repository has its catalogue and no code entity at all', async () => {
  const base = scratch();
  const productFolder = product(base, 'catalogue-empty');
  closers.push(await prepareTestProduct(productFolder, base));
  const served: ServeResult = await serveWiki({ productFolder, appFolder: builtApp(base), port: 0, open: false, print: () => {}, printError: () => {} });
  if (served.outcome !== 'serving') throw new Error(`${import.meta.path}:1: the wiki did not serve: ${served.message}`);
  servers.push(served.server);
  expect((await fetch(`${served.url}/api/status`)).status).toBe(200);
  await fillCode(productFolder, base);
  const kinds = await kindsOf(productFolder, base);
  for (const kind of CATALOGUE_KINDS) expect([kind, (kinds.get(kind) ?? 0) > 0]).toEqual([kind, true]);
  for (const kind of [...CODE_KINDS, 'code.blob']) expect([kind, kinds.get(kind) ?? 0]).toEqual([kind, 0]);
  expect((await edgesOf(productFolder, base)).get('product.uses-repository') ?? 0).toBe(0);
}, 300_000);

/**
 * The adapter a real one is found by (`claude-agent-acp` on the PATH), standing behind a scripted agent: it speaks the
 * session's own graph server over HTTP and madarch's file callback, writes what it saw to the record beside it, and
 * answers an empty complete result for the kind it was asked. It never streams what it read into its answer, because
 * the unit's answer is the one JSON object it sends.
 */
const BOUNDARY_AGENT = String.raw`import { createInterface } from 'node:readline';
import { appendFileSync, readdirSync } from 'node:fs';
const record = process.argv[2];
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const pending = new Map();
let sequence = 0;
const ask = (method, params) => new Promise((resolve) => { const id = 'agent-' + ++sequence; pending.set(id, resolve); send({ id, method, params }); });
let session;
const post = async (server, body) => {
  const headers = Object.fromEntries((server.headers ?? []).map((one) => [one.name, one.value]));
  const response = await fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...headers }, body: JSON.stringify(body) });
  if (response.status === 202) return null;
  if (!response.ok) throw new Error('the MCP server answered HTTP ' + response.status + ': ' + (await response.text()));
  return await response.json();
};
const tool = async (server, name, args) => {
  const answer = await post(server, { jsonrpc: '2.0', id: ++sequence, method: 'tools/call', params: { name, arguments: args } });
  return JSON.parse(((answer.result ?? {}).content ?? []).map((block) => block.text ?? '').join(''));
};
createInterface({ input: process.stdin }).on('line', async (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); return; }
  if (message.method === 'initialize') return send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } } } });
  if (message.method === 'session/new') {
    session = message.params;
    return send({ id: message.id, result: { sessionId: 'boundary', models: { currentModelId: 'fixture', availableModels: [{ modelId: 'fixture', name: 'Fixture' }] } } });
  }
  if (message.method !== 'session/prompt') return;
  const graph = session.mcpServers.find((one) => one.url !== undefined);
  const seen = { prompt: message.params.prompt.map((part) => String(part.text ?? '')).join('\n'), cwd: readdirSync(session.cwd).sort(), servers: session.mcpServers.map((one) => [one.name, one.command ?? one.url]), tools: [], graph: undefined, files: [] };
  try {
    await post(graph, { jsonrpc: '2.0', id: ++sequence, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'boundary-agent', version: '1.0.0' } } });
    await post(graph, { jsonrpc: '2.0', method: 'notifications/initialized' });
    seen.tools = (((await post(graph, { jsonrpc: '2.0', id: ++sequence, method: 'tools/list', params: {} })).result ?? {}).tools ?? []).map((one) => one.name);
    seen.graph = await tool(graph, 'graph_query', { query: '{ allCodeRepository(orderBy: [{field: name}]) { edges { node { name } } } allCodeDirectory(orderBy: [{field: path}]) { edges { node { path } } } allCodeFile(orderBy: [{field: path}]) { edges { node { path } } } }' });
    for (const path of ['source/README.md', 'source/src/a.ts', 'workspace.yaml', 'madarch/catalog.yaml']) {
      const reply = await ask('fs/read_text_file', { sessionId: message.params.sessionId, path });
      seen.files.push(reply.error === undefined ? { path, content: String(reply.result.content).split('\n')[0] } : { path, refused: String(reply.error.message) });
    }
  } catch (error) { seen.failed = String(error); }
  appendFileSync(record, JSON.stringify(seen) + '\n');
  send({ method: 'session/update', params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify({ vertices: [], edges: [], end: { state: 'complete' } }) } } } });
  send({ id: message.id, result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } });
});
`;

/** The adapter executable the managed press finds by the name a real one has, and the record the agent writes. */
function agentAdapter(base: string): { bin: string; record: string } {
  const bin = join(base, 'bin');
  const adapter = join(bin, 'boundary-agent.ts');
  const record = join(base, 'agent-record.jsonl');
  mkdirSync(bin, { recursive: true });
  writeFileSync(adapter, BOUNDARY_AGENT);
  writeFileSync(join(bin, 'claude-agent-acp'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(adapter)} ${JSON.stringify(record)}\n`, { mode: 0o755 });
  return { bin, record };
}

/** What one press's record holds, as the agent wrote it. */
interface AgentRecord {
  readonly prompt: string;
  readonly cwd: readonly string[];
  readonly servers: readonly (readonly string[])[];
  readonly tools: readonly string[];
  readonly graph: { readonly data?: Record<string, { readonly edges: { readonly node: Record<string, string> }[] }>; readonly errors?: readonly { readonly message: string }[] };
  readonly files: readonly { readonly path: string; readonly content?: string; readonly refused?: string }[];
  readonly failed?: string;
}

/**
 * Serves the product the way the reader opens it and waits for the answer the wiki's first page makes: a server that
 * does not answer before the bound is named with what the last request said, never as a bare timeout.
 */
async function serveReady(folder: string, base: string): Promise<{ url: string; server: StartedServer }> {
  const served: ServeResult = await serveWiki({ productFolder: folder, appFolder: builtApp(base), port: 0, open: false, print: () => {}, printError: () => {} });
  if (served.outcome !== 'serving') throw new Error(`${import.meta.path}:1: the wiki did not serve: ${served.message}`);
  servers.push(served.server);
  const deadline = Date.now() + 120_000;
  let last = 'no request was made';
  while (Date.now() < deadline) {
    try {
      const answer = await fetch(`${served.url}/api/status`);
      if (answer.status === 200) {
        const body = (await answer.json()) as { publication?: string; publicationMessage?: string };
        if (body.publication === 'failed') throw new Error(`${import.meta.path}:1: the store's publication failed before the press: ${body.publicationMessage ?? 'no reason'}`);
        return { url: served.url, server: served.server };
      }
      last = `GET /api/status answered ${String(answer.status)}: ${await answer.text()}`;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(import.meta.path)) throw error;
      last = `GET /api/status could not connect: ${error instanceof Error ? error.message : String(error)}`;
    }
    await Bun.sleep(250);
  }
  throw new Error(`${import.meta.path}:1: the wiki never answered its own first page within 120 s; the last request reported: ${last}`);
}

/** Presses the fill for one kind with an agent chosen, and waits for the run's own end. */
async function fillWithAgent(url: string, selected: readonly string[]): Promise<void> {
  const pressed = await fetch(`${url}/api/fill-selected`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ selected, agent: 'claude-code', tokenCap: 100_000 }) });
  const body = (await pressed.json()) as { runId?: string; order?: string[]; error?: { message?: string } };
  if (pressed.status !== 202 || body.runId === undefined) throw new Error(`${import.meta.path}:1: the press was not accepted (${String(pressed.status)}): ${body.error?.message ?? JSON.stringify(body)}`);
  const deadline = Date.now() + 240_000;
  let last = 'no answer was read';
  while (Date.now() < deadline) {
    try {
      const answer = await fetch(`${url}/api/fill-runs?run=${encodeURIComponent(body.runId)}`);
      const detail = (await answer.json()) as { run?: { state?: string; summary?: { error?: string }; error?: string; units?: { unitId: string; status: string; skippedBecause?: string }[] } };
      const run = detail.run;
      if (run !== undefined && ['succeeded', 'completed_partial', 'failed', 'blocked', 'cancelled'].includes(run.state ?? '')) {
        if (run.state !== 'succeeded') {
          const units = (run.units ?? []).filter((unit) => unit.status !== 'published').map((unit) => `${unit.unitId}: ${unit.status}${unit.skippedBecause === undefined ? '' : ` (${unit.skippedBecause})`}`);
          throw new Error(`${import.meta.path}:1: the fill ended ${run.state}: ${run.summary?.error ?? run.error ?? 'no reason'}${units.length === 0 ? '' : `; ${units.join('; ')}`}`);
        }
        return;
      }
      last = `the run stands ${run?.state ?? 'unknown'}`;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(import.meta.path)) throw error;
      last = `GET /api/fill-runs could not connect: ${error instanceof Error ? error.message : String(error)}`;
    }
    await Bun.sleep(250);
  }
  throw new Error(`${import.meta.path}:1: the fill did not end within 240 s; the last request reported: ${last}`);
}

/** The agent's record for the run, one line per turn. */
function agentTurns(record: string): AgentRecord[] {
  const text = readFileSync(record, 'utf8').trim();
  return text === '' ? [] : text.split('\n').map((line) => JSON.parse(line) as AgentRecord);
}

/** The values one connection's nodes hold for a field, sorted by code point. */
const nodesOf = (connection: { readonly edges: { readonly node: Record<string, string> }[] } | undefined, field: string): string[] =>
  (connection?.edges ?? []).map((edge) => edge.node[field]!).sort();

for (const linked of [true, false]) test(`the managed press gives its agent the linked code alone (${linked ? 'a linked repository' : 'an empty declared repos:'})`, async () => {
  const base = scratch();
  const name = linked ? 'catalogue-agent' : 'catalogue-agent-empty';
  const productFolder = product(base, name, linked ? sourceRepository(base) : undefined, true);
  if (!linked) {
    // A declared, explicitly empty code set: the manifest names `repos:`, and no entry stands under it.
    writeFileSync(join(productFolder, 'workspace.yaml'), `${readFileSync(join(productFolder, 'workspace.yaml'), 'utf8')}repos:\n`);
  }
  const manifest = parse(readFolderManifestText(productFolder));
  // The kind the press fills is the agent's, and its prerequisites are the code the product links: the run reads the
  // code first, and then asks the agent for the domains that code holds.
  manifest.kinds.domain.agent = { plugin: 'agent-fill', fields: '*' };
  manifest.kinds.domain['derives-from'] = ['code.directory', 'code.file'];
  writeFolderManifest(productFolder, stringify(manifest));
  commitProduct(productFolder, 'Fill the domains with an agent, from the linked code');
  const { bin, record } = agentAdapter(base);
  // The machine's own ability to confine a plugin decides what the fill can run: a machine that cannot is named here,
  // where the reason is a sentence, and never read later as a timeout of the fill.
  const sandbox = await probePluginSandbox();
  if (sandbox.state !== 'confined' && process.env['MADARCH_PLUGIN_SANDBOX'] !== 'off') {
    throw new Error(`${import.meta.path}:1: this machine cannot confine a plugin, so the fill's producers cannot run: ${sandbox.reason}${sandbox.detail === undefined ? '' : ` (${sandbox.detail})`}`);
  }
  const oldPath = process.env['PATH'];
  process.env['PATH'] = `${bin}:${oldPath ?? ''}`;
  try {
    closers.push(await prepareTestProduct(productFolder, base));
    const served = await serveReady(productFolder, base);
    await fillWithAgent(served.url, ['domain']);
  } finally {
    if (oldPath === undefined) delete process.env['PATH']; else process.env['PATH'] = oldPath;
  }
  const turns = agentTurns(record);
  expect(turns.length, `${import.meta.path}:1: the agent's record holds ${String(turns.length)} turns`).toBe(1);
  const [turn] = turns as [AgentRecord];
  expect(turn.failed).toBeUndefined();
  // The agent's session is madarch's graph server and nothing of the product's checkout: an empty folder of its own.
  expect(turn.servers.map(server => server[0])).toEqual(['madarch']);
  expect(turn.cwd).toEqual([]);
  expect(turn.prompt).not.toContain(productFolder);
  expect(turn.tools).toEqual(['graph_schema', 'graph_query', 'graph_text']);
  // The graph the agent reads holds the linked repository's code and no repository of the product's own checkout.
  expect(turn.graph.errors).toBeUndefined();
  const graph = turn.graph.data ?? {};
  expect(nodesOf(graph['allCodeRepository'], 'name')).toEqual(linked ? ['source'] : []);
  expect(nodesOf(graph['allCodeDirectory'], 'path')).toEqual(linked ? ['src'] : []);
  expect(nodesOf(graph['allCodeFile'], 'path')).toEqual(linked ? ['README.md', 'src/a.ts'] : []);
  // The file inventory the agent may open is the graph's: the linked files answer, and the product's own files are no
  // part of it, so a read of one is refused by madarch's callback rather than served from the checkout.
  const read = new Map(turn.files.map(file => [file.path, file] as const));
  expect(read.get('source/README.md')?.content).toBe(linked ? '# Source' : undefined);
  expect(read.get('source/src/a.ts')?.content).toBe(linked ? 'export const a = 1;' : undefined);
  expect(read.get('workspace.yaml')?.content).toBeUndefined();
  expect(read.get('workspace.yaml')?.refused).toBeDefined();
  expect(read.get('madarch/catalog.yaml')?.content).toBeUndefined();
  expect(read.get('madarch/catalog.yaml')?.refused).toBeDefined();
  // And the graph the same fill leaves behind holds exactly what the agent read.
  expect((await keysOf(productFolder, base, 'code.repository')).map(key => key['name'])).toEqual(linked ? ['source'] : []);
  expect((await keysOf(productFolder, base, 'code.file')).map(key => String(key['path'])).sort()).toEqual(linked ? ['README.md', 'src/a.ts'] : []);
}, 300_000);
