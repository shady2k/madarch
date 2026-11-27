/**
 * The foundation's first slice, end to end (decision 0039 items 1, 2, 14, 25 and 35, and the catalogue tree of
 * madarch-64o5.144): a product is made with a small repository this test builds itself — a few folders, TypeScript files
 * that import one another, and a README that names the two parts — and filled by the disk, git and imports plugins
 * together with a scripted agent; never a model. The graph is then read through madarch's own MCP server (`madarch mcp`,
 * the session an agent is given), and the wiki is walked in a real browser at 1440 and 390 px.
 *
 * What it holds the landing to, by decision item:
 *
 * - item 1: every relation is an edge. A file's and a folder's repository is their parent key edge, the folder a file
 *   sits in is an edge, an import is an edge, and a component reaches the folder that realises it through edges only.
 *   No kind declares a field that holds another entity's identity.
 * - item 2: identity is the parent edge plus the entity's own key — the published schema has no `repository` field on a
 *   folder or a file.
 * - items 14 and 25: every value is an assertion per source, with its evidence, readable as `<field>Assertions`.
 * - item 35: the catalogue counts the kinds the fill took and marks the kind nothing in the repository answers with
 *   «неприменимо» and the reason of what was searched.
 *
 * Run with `MADARCH_FOUNDATION_E2E=1` after `bun run build` in `wiki/app`, as an ordinary user. The fill runs
 * unconfined (`MADARCH_PLUGIN_SANDBOX=off`), as every walk with an agent does: the session's model and the plugin's
 * reader stand outside a plugin's sandbox, and this walk is about the graph and the pages, not the confinement.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer, { type Browser } from 'puppeteer';
import { parse as parseYaml, parseDocument } from 'yaml';
import { resolveBrowserExecutable } from '../scripts/chromium.js';
import { prepareStore } from '../src/adapters/prepare-store.js';
import { connectAcpAgent } from '../src/fill/acp.js';
import { runFill } from '../src/fill/run.js';
import { fieldNameOf, kindTypeNameOf, typeNameOf } from '../src/graphql/names.js';
import { createDraft } from '../src/product/draft.js';
import { SYSTEM_VERTEX_DEFINITIONS } from '../src/graph/system-contract.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { manifestWithRepo } from '../src/product/manifest.js';
import { readKinds, type EdgeDecl, type KindsManifest } from '../src/product/manifest/kinds.js';
import { knowledgeRootOf, productStoreFolder } from '../src/product/store.js';
import type { StartedServer } from '../src/server/http.js';
import { readFolderManifestText, writeFolderManifest } from './catalog-folder-fixture.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY, commitProduct } from './knowledge-fixture.js';
import { startPreparedServer } from './prepared-server.js';
import { stopServersUnder } from './run-postgres.js';
import { createTestDatabaseOwner } from './test-database.js';

const ROOT = join(import.meta.dir, '..');
const APP = join(ROOT, 'wiki', 'app', 'dist');
const SHOTS = process.env['MADARCH_FOUNDATION_SHOTS'] ?? join(tmpdir(), 'madarch-foundation-shots');
const enabled = process.env['MADARCH_FOUNDATION_E2E'] === '1';
const run = enabled ? describe.serial : describe.skip;
if (!enabled) console.info('The foundation slice walk is skipped: set MADARCH_FOUNDATION_E2E=1 after building wiki/app to run it.');

/** The product the walk makes and the repository it links. */
const PRODUCT = 'foundation-slice';
const REPOSITORY = 'app';

/**
 * The repository the test builds itself: two parts worth of code, a shared folder both parts import, and a README that
 * names the two parts. What the fill reads and what the agent answers from is this, and nothing outside the test.
 */
const READ_ME = [
  '# Shop app',
  '',
  'The repository holds two parts.',
  '',
  'Orders prices an order and places it.',
  'Identity signs a person in.',
  '',
].join('\n');

const SOURCES: Readonly<Record<string, string>> = {
  'README.md': READ_ME,
  'src/orders/create-order.ts': [
    "import { price } from './pricing';",
    "import { money } from '../shared/money';",
    '',
    'export function createOrder(sku: string): string {',
    '  return `price:${price(sku)} money:${money(1)}`;',
    '}',
    '',
  ].join('\n'),
  'src/orders/pricing.ts': [
    "import { money } from '../shared/money';",
    '',
    'export function price(sku: string): string {',
    '  return `price:${sku}:${money(1)}`;',
    '}',
    '',
  ].join('\n'),
  'src/identity/login.ts': [
    "import { money } from '../shared/money';",
    '',
    'export function login(user: string): string {',
    '  return `session:${user}:${money(0)}`;',
    '}',
    '',
  ].join('\n'),
  'src/shared/money.ts': [
    'export function money(amount: number): string {',
    '  return `money:${String(amount)}`;',
    '}',
    '',
  ].join('\n'),
};

/** The two parts the README names: the folder each answers for, the component and the module of each. */
const PARTS = [
  { folder: 'src/orders', component: 'Orders', module: 'orders' },
  { folder: 'src/identity', component: 'Identity', module: 'identity' },
] as const;
/** The modules the agent answers: the two parts and the shared folder both import from. */
const MODULES = [...PARTS.map((part) => ({ folder: part.folder, module: part.module })), { folder: 'src/shared', module: 'shared' }] as const;
/** The folders the disk plugin publishes for this repository, in code-point order. */
const FOLDERS = ['src', 'src/identity', 'src/orders', 'src/shared'] as const;
/** The files of the repository, and the folder each stands in. */
const FILE_FOLDERS: Readonly<Record<string, string>> = {
  'src/identity/login.ts': 'src/identity',
  'src/orders/create-order.ts': 'src/orders',
  'src/orders/pricing.ts': 'src/orders',
  'src/shared/money.ts': 'src/shared',
};

/**
 * The kinds and relations the slice cannot do without, named as the catalogue declares them (decision 0039 items 1, 2 and
 * 35; the catalogue tree of madarch-64o5.144). A product that lacks one is named with everything else it lacks, so a
 * landing reads one list, never one failure at a time.
 */
const SLICE_KINDS = ['product', 'code.repository', 'code.directory', 'code.file', 'code.module', 'c4.component', 'code.debt'] as const;
const SLICE_EDGES = ['product.uses-repository', 'code.contains', 'code.imports', 'code.file-repository', 'code.directory-repository', 'code.file-directory'] as const;

/**
 * A scripted ACP agent: it starts nothing of its own, it speaks the session's MCP server over HTTP (initialize,
 * notifications/initialized, tools/list, tools/call), reads the folders, the files and the README's text from the graph,
 * and answers the kind its task names. Every turn is appended to the record file as one JSON line, so the walk can read
 * what the agent was given and what it answered.
 */
const FAKE = String.raw`import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

const recordPath = process.argv[2];
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
let sequence = 0;
const pending = new Map();
const ask = (method, params) => new Promise((resolve) => { const id = 'fake-' + ++sequence; pending.set(id, resolve); send({ id, method, params }); });
let servers = [];
const post = async (body) => {
  const server = servers.find((one) => typeof one.url === 'string');
  if (server === undefined) throw new Error('the session was given no MCP server: ' + JSON.stringify(servers));
  const headers = Object.fromEntries((server.headers ?? []).map((each) => [each.name, each.value]));
  const response = await fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...headers }, body: JSON.stringify(body) });
  if (response.status === 202) return null;
  if (!response.ok) throw new Error('the MCP server answered HTTP ' + response.status + ': ' + await response.text());
  return await response.json();
};
const calls = [];
const tool = async (name, args) => {
  const answer = await post({ jsonrpc: '2.0', id: ++sequence, method: 'tools/call', params: { name, arguments: args } });
  const text = ((answer.result ?? {}).content ?? []).map((block) => block.text ?? '').join('');
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (error) { parsed = { unreadable: text.slice(0, 400) }; }
  calls.push({ tool: name, arguments: args, isError: answer.result?.isError === true, answer: text.slice(0, 4000) });
  return parsed;
};
const capitalised = (word) => word.slice(0, 1).toUpperCase() + word.slice(1);
/** The service the agent names, and the container of every component it answers: the repository's one application. */
const SERVICE = 'shop';
/** The entity reference of one folder: its path and the repository its key edge names. */
const folderRef = (path) => ({ kind: 'code.directory', key: { path }, keyEdges: { 'code.directory-repository': { kind: 'code.repository', key: { name: 'app' } } } });
/** The edge's words and ends, from the task, so the agent states what the catalogue asks and never a kind of its own. */
// The task lists every relation of the kind, including one whose two ends are both this kind (module.depends-on):
// the folder edge is the one that leaves the kind for a folder, and only that direction is a realisation.
const edgeOf = (task, from, to) => (task.relations ?? []).find((relation) => relation.from === from && relation.to === to);

const answerFor = async (task) => {
  const folders = await tool('graph_query', { query: '{ allCodeDirectory(where: {path: {_like: "src%"}}, orderBy: [{field: path}]) { edges { node { path } } } }' });
  const folderPaths = (folders.data?.allCodeDirectory?.edges ?? []).map((edge) => edge.node.path).filter((path) => /^src\/[^/]+$/.test(path));
  // A file's text is not a field of the file: it is the content of the immutable blob the file's code.blob-about edge
  // reaches (decision 0037), read by graph_text.
  const files = await tool('graph_query', { query: '{ allCodeFile(where: {path: {_in: ["README.md", "src/orders/create-order.ts", "src/orders/pricing.ts", "src/identity/login.ts", "src/shared/money.ts"]}}, orderBy: [{field: path}]) { edges { node { path lines blob codeBlobAboutOf(first: 1) { edges { node { node { ... on KindCodeBlob { digest } } } } } } } } }' });
  if (files.data?.allCodeFile === undefined) return { vertices: [], edges: [], end: { state: 'partial', cause: 'the files of the repository are not readable through the graph: ' + JSON.stringify(files).slice(0, 300) } };
  const held = new Map((files.data.allCodeFile.edges ?? []).map((edge) => [edge.node.path, edge.node]));
  // A value the agent states stands on a blob of the graph, at the lines it was read at: the immutable target the host
  // checks its digest against (decision 0037).
  const noEvidence = { vertices: [], edges: [], end: { state: 'partial', cause: 'the graph holds no blob id of a file, so no value the agent states has evidence (decision 0037)' } };
  const digestOf = (path) => held.get(path)?.codeBlobAboutOf?.edges?.[0]?.node?.node?.digest;
  const evidenceOf = (path, line) => {
    const digest = digestOf(path);
    if (typeof digest !== 'string') return undefined;
    return { target: { kind: 'code.blob', key: { digest } }, path, lineStart: line, lineEnd: line };
  };
  const textOf = async (path, lineStart, lineEnd) => {
    const digest = digestOf(path);
    if (typeof digest !== 'string') return '';
    const read = await tool('graph_text', { kind: 'code.blob', key: { digest }, field: 'content', ...(lineStart === undefined ? {} : { lineStart }), ...(lineEnd === undefined ? {} : { lineEnd }) });
    return String(read?.text ?? '');
  };
  if (evidenceOf('README.md', 1) === undefined) return noEvidence;
  if (task.kind === 'code.module') {
    const relation = edgeOf(task, 'code.module', 'code.directory');
    // The module turn owns the realisation edge too: the catalogue declares component.implemented-by from the component
    // to the module, and the later of the two agent kinds' turns writes it (the fill's edge ownership rule). A component
    // exists only where the README names the part, so the agent reads the document it is answering from.
    const implemented = edgeOf(task, 'c4.component', 'code.module');
    const lines = (await textOf('README.md')).split('\n');
    const parts = new Set(folderPaths
      .filter((path) => lines.some((line) => line.startsWith(capitalised(path.split('/').pop()) + ' ')))
      .map((path) => path.split('/').pop()));
    const vertices = folderPaths.map((path) => ({
      kind: task.kind,
      key: { name: path.split('/').pop() },
      values: { responsibility: 'The module held in ' + path + ', one folder of the repository.' },
      evidence: evidenceOf('README.md', 1),
    })).filter((vertex) => vertex.evidence !== undefined);
    const folderEdges = relation === undefined ? [] : vertices.map((vertex) => ({
      kind: relation.kind,
      from: { kind: 'code.module', key: vertex.key },
      to: folderRef(folderPaths.find((path) => path.split('/').pop() === vertex.key.name)),
      evidence: evidenceOf('README.md', 1),
    }));
    const realised = implemented === undefined ? [] : vertices.filter((vertex) => parts.has(vertex.key.name)).map((vertex) => ({
      kind: implemented.kind,
      from: { kind: 'c4.component', key: { name: capitalised(vertex.key.name) }, keyEdges: { container: { kind: 'code.service', key: { name: SERVICE } } } },
      to: { kind: 'code.module', key: vertex.key },
      evidence: evidenceOf('README.md', 1),
    }));
    return { vertices, edges: [...folderEdges, ...realised], end: { state: 'complete' } };
  }
  if (task.kind === 'code.service') {
    return { vertices: [{ kind: task.kind, key: { name: SERVICE }, values: { purpose: 'The application the product runs.' }, evidence: evidenceOf('README.md', 1) }], edges: [], end: { state: 'complete' } };
  }
  if (task.kind === 'c4.component') {
    // The README is the document that names the parts. Its text is read twice: as one field of the file through the
    // graph, and as the file's own text — the read a person's page makes too (decision 0037).
    const lines = (await textOf('README.md')).split('\n');
    const parts = folderPaths.map((path) => ({ path, name: capitalised(path.split('/').pop()) }));
    // A component's container is its parent key edge: the catalogue declares container.contains-component from the
    // service to the component (c4.component's key-edges, role "container"), so each part names the service it belongs
    // to and the writer resolves that entity (decision 0039, item 2).
    const vertices = parts.filter((part) => lines.some((line) => line.startsWith(part.name + ' '))).map((part) => {
      const line = lines.findIndex((held) => held.startsWith(part.name + ' ')) + 1;
      return {
        kind: task.kind,
        key: { name: part.name },
        keyEdges: { container: { kind: 'code.service', key: { name: SERVICE } } },
        values: { responsibility: 'The part of the product that ' + part.path + ' answers for: ' + lines[line - 1] },
        evidence: evidenceOf('README.md', line),
      };
    }).filter((vertex) => vertex.evidence !== undefined);
    return { vertices, edges: [], end: { state: 'complete' } };
  }
  // A kind the repository answers nothing of: the agent searched the folders and the code, found no entity of it, and
  // says so — an inapplicable end names what was searched and stands on the evidence it read (decision 0039, item 35).
  return { vertices: [], edges: [], end: { state: 'inapplicable', searched: 'the folders and the files of the repository in the graph', evidence: [evidenceOf('README.md', 1)] } };
};

createInterface({ input: process.stdin }).on('line', async (line) => {
  const message = JSON.parse(line);
  if (!message.method) { pending.get(message.id)?.(message); pending.delete(message.id); return; }
  if (message.method === 'initialize') { send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true, sse: true } } } }); return; }
  if (message.method === 'session/new') {
    servers = message.params.mcpServers ?? [];
    send({ id: message.id, result: { sessionId: 'foundation-session', models: { currentModelId: 'fixture-model', availableModels: [{ modelId: 'fixture-model', name: 'Fixture model' }] } } });
    return;
  }
  if (message.method !== 'session/prompt') return;
  const prompt = (message.params.prompt ?? []).map((part) => String(part.text ?? '')).join('\n');
  const task = JSON.parse(prompt.slice(prompt.lastIndexOf('Task: ') + 'Task: '.length));
  let answer;
  let tools;
  try {
    const initialized = await post({ jsonrpc: '2.0', id: ++sequence, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'foundation-fixture-agent', version: '1.0.0' } } });
    if (initialized.error !== undefined) throw new Error('initialize refused: ' + JSON.stringify(initialized.error));
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const listed = await post({ jsonrpc: '2.0', id: ++sequence, method: 'tools/list', params: {} });
    tools = ((listed.result ?? {}).tools ?? []).map((one) => one.name);
    answer = await answerFor(task);
  } catch (error) {
    answer = { vertices: [], edges: [], end: { state: 'partial', cause: String(error) } };
  }
  appendFileSync(recordPath, JSON.stringify({ prompt, task, servers, tools, calls, answer }) + '\n');
  send({ method: 'session/update', params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(answer) } } } });
  send({ id: message.id, result: { stopReason: 'end_turn', usage: { inputTokens: 200, outputTokens: 100, cachedWriteTokens: 0, cachedReadTokens: 0, totalTokens: 300 } } });
});
`;
/** Runs git in a folder; a refused command throws with its own words. */
function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The repository the test builds: its files and its commit. */
function buildRepository(root: string): string {
  const repository = join(root, REPOSITORY);
  for (const [path, content] of Object.entries(SOURCES)) {
    mkdirSync(join(repository, path, '..'), { recursive: true });
    writeFileSync(join(repository, path), content);
  }
  git(repository, 'init', '-q', '-b', 'main');
  git(repository, 'add', '-A');
  git(repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'the fixture code');
  return repository;
}

/** The rows a connection answered, by its root field: `edges[].node`, as every list root answers them. */
function rowsOf(answer: Record<string, unknown>, root: string): Record<string, unknown>[] {
  const edges = (answer[root] as { edges?: unknown } | undefined)?.edges;
  return Array.isArray(edges) ? (edges as { node: Record<string, unknown> }[]).map((edge) => edge.node) : [];
}

/** The entity an edge record reaches: the record's own `node`, or nothing when the row is a plain entity. */
function endOf(record: Record<string, unknown>): Record<string, unknown> {
  const held = record['node'];
  return typeof held === 'object' && held !== null && !Array.isArray(held) ? held as Record<string, unknown> : {};
}

/** One session on madarch's own MCP server: one JSON-RPC message per line, as the stdio transport specifies. */
interface McpSession {
  ask(tool: string, args?: unknown): Promise<Record<string, unknown>>;
  query(text: string, variables?: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

/**
 * A session on madarch's own MCP server: the child `madarch mcp --product … --home …` answers one JSON-RPC message per
 * line over its standard input and output, and the walk asks it the questions an agent asks. Nothing of the graph is read
 * any other way.
 */
async function mcpSession(home: string, product: string): Promise<McpSession> {
  const child = Bun.spawn({
    cmd: [process.execPath, join(ROOT, 'scripts', 'madarch.ts'), 'mcp', '--product', product, '--home', home],
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...process.env } as Record<string, string>,
  });
  const decoder = new TextDecoder();
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();
  let buffer = '';
  let stderr = '';
  void (async () => {
    const reader = child.stderr.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      stderr += decoder.decode(value);
    }
  })();
  void (async () => {
    const reader = child.stdout.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value);
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (line === '') continue;
        const message = JSON.parse(line) as Record<string, unknown>;
        const id = typeof message['id'] === 'number' ? message['id'] : undefined;
        if (id === undefined) continue;
        const answer = waiting.get(id);
        if (answer === undefined) continue;
        waiting.delete(id);
        answer(message);
      }
    }
  })();
  let sequence = 0;
  const request = async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = ++sequence;
    const answered = new Promise<Record<string, unknown>>((accept, refuse) => {
      waiting.set(id, accept);
      setTimeout(() => { if (waiting.delete(id)) refuse(new Error(`madarch mcp did not answer ${method} within 120 s: ${stderr.slice(-2000)}`)); }, 120_000);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    child.stdin.flush();
    const message = await answered;
    if (message['error'] !== undefined) throw new Error(`madarch mcp refused ${method}: ${JSON.stringify(message['error'])}`);
    return (message['result'] ?? {}) as Record<string, unknown>;
  };
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'foundation-walk', version: '1.0.0' } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  child.stdin.flush();
  return {
    ask: async (tool: string, args?: unknown): Promise<Record<string, unknown>> => {
      const result = await request('tools/call', { name: tool, arguments: args ?? {} });
      const content = (result['content'] ?? []) as { text?: string }[];
      const text = content.map((block) => block.text ?? '').join('');
      if (result['isError'] === true) throw new Error(`${tool} refused: ${text}`);
      return JSON.parse(text) as Record<string, unknown>;
    },
    query: async (text: string, variables?: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const body = await request('tools/call', { name: 'graph_query', arguments: { query: text, ...(variables === undefined ? {} : { variables }) } });
      const content = (body['content'] ?? []) as { text?: string }[];
      const answer = JSON.parse(content.map((block) => block.text ?? '').join('')) as Record<string, unknown>;
      const errors = answer['errors'];
      if (Array.isArray(errors) && errors.length > 0) throw new Error(`the graph refused the operation ${text}: ${JSON.stringify(errors)}`);
      return (answer['data'] ?? {}) as Record<string, unknown>;
    },
    close: async () => { child.kill(); await child.exited; },
  };
}

/** Every kind file of the product's catalogue, in code-point order. */
function kindFiles(product: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.yaml')) found.push(path);
    }
  };
  const kinds = join(product, 'madarch', 'kinds');
  if (existsSync(kinds)) walk(kinds);
  return found.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * Item 1: no kind declares a field that holds another entity's kind or identity. The check reads the declarations — a
 * field's `reference:` is the declaration the old model used — and never guesses from a field's name.
 */
function referenceFieldFindings(product: string): string[] {
  const findings: string[] = [];
  for (const file of kindFiles(product)) {
    const text = readFileSync(file, 'utf8');
    const document = parseYaml(text) as { fields?: readonly { name?: string; reference?: unknown }[] } | null;
    for (const field of document?.fields ?? []) {
      if (field.reference === undefined) continue;
      const at = text.split('\n').findIndex((held) => held.trimStart().startsWith(`- name: ${field.name ?? ''}`));
      findings.push(`${file}:${String(at < 0 ? 1 : at + 1)}: the field "${field.name ?? ''}" declares "reference: ${String(field.reference)}", and a reference between entities is an edge (decision 0039, item 1)`);
    }
  }
  return findings;
}

/**
 * Item 35 read with item 1: the edge chain a component reaches the folder that realises it by. The catalogue may take it
 * in one hop (component → the folder it is realised by) or in two (component → the module, module → its folder). The test
 * follows what the product declares and names the missing hop when there is none.
 */
function realisationChain(edges: readonly EdgeDecl[]): { first?: string; second?: string; problem?: string } {
  const first = edges.find((edge) => edge.from.includes('c4.component') && edge.to.includes('code.module'));
  if (first !== undefined) {
    const second = edges.find((edge) => edge.from.includes('code.module') && edge.to.includes('code.directory') && edge.name !== first.name);
    return second === undefined
      ? { first: first.name, problem: 'no edge kind takes a module to the folder its code stands in, so a component cannot reach the folder that realises it' }
      : { first: first.name, second: second.name };
  }
  const direct = edges.find((edge) => edge.from.includes('c4.component') && edge.to.includes('code.directory'));
  if (direct !== undefined) return { first: direct.name };
  return { problem: 'no edge kind takes a component to the module or the folder that realises it (decision 0039, item 35)' };
}

/** Every finding that keeps the slice from standing, read from the product's own declarations: one list, never one failure at a time. */
function sliceFindings(product: string): { findings: string[]; manifest?: KindsManifest } {
  const findings: string[] = [];
  const declarations = readKinds(product);
  if (!declarations.present) return { findings: [`${declarations.file}: the product holds no kinds manifest, so it declares no kind of the slice`] };
  const manifest = declarations.manifest;
  for (const finding of manifest.findings) findings.push(`${finding.file}:${String(finding.line)}: ${finding.message}`);
  for (const name of SLICE_KINDS) if (!manifest.kinds.has(name)) findings.push(`${manifest.file}: the product declares no kind "${name}"`);
  const edges = [...(manifest.edges?.values() ?? [])];
  for (const name of SLICE_EDGES) if (!edges.some((edge) => edge.name === name)) findings.push(`${manifest.file}: the product declares no edge kind "${name}"`);
  for (const [kind, role] of [['code.directory', 'code.directory-repository'], ['code.file', 'code.file-repository']] as const) {
    const declared = manifest.kinds.get(kind)?.keyEdges ?? [];
    if (!declared.some((keyEdge) => keyEdge.edge === role)) findings.push(`${manifest.file}:${String(manifest.kinds.get(kind)?.line ?? 1)}: the kind "${kind}" names no key edge "${role}", so its parent is not part of its identity (decision 0039, item 2)`);
  }
  const chain = realisationChain(edges);
  if (chain.problem !== undefined) findings.push(`${manifest.file}: ${chain.problem}`);
  findings.push(...referenceFieldFindings(product));
  return { findings, manifest };
}

/** The fields one type of the published schema declares, read from the SDL the graph answers with. */
function fieldsOf(sdl: string, type: string): string[] {
  const lines = sdl.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`type ${type} `));
  if (start < 0) return [];
  const fields: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('}')) break;
    const name = line.trim().split(/[\s(:]/u)[0];
    if (name !== undefined && name !== '') fields.push(name);
  }
  return fields;
}

/** One turn the scripted agent answered, as it recorded it. */
interface Turn {
  readonly prompt: string;
  readonly task: { kind: string; what: string; key?: readonly string[]; fields?: readonly { name: string; meaning: string }[]; relations?: readonly { kind: string; from: string; to: string }[] };
  readonly tools?: readonly string[];
  readonly calls: readonly { tool: string; arguments: Record<string, unknown>; isError: boolean; answer: string }[];
  readonly answer: { vertices?: readonly unknown[]; edges?: readonly unknown[]; end: { state: string; cause?: string } };
}

/** The plugins this walk runs: the disk, git and imports plugins and the agent. No db-schema, glossary or quarantine. */
const PLUGINS = ['disk', 'git', 'imports', 'agent-fill'] as const;
/** The kinds a kept plugin declares beside the ones it fills: a blob's text, a gitlink, a commit and its author. */
const SUPPORT_KINDS = ['code.blob', 'code.gitlink', 'code.commit', 'code.author'] as const;

/**
 * The product's declarations, cut to the slice the walk fills: the kinds it asks for, every kind they rest on
 * (`derives-from`), the kinds the kept plugins declare, and the four plugins themselves. A fixture product declares the
 * kinds it is walked on, as any product's manifest is its own choice.
 */
function restrictToSlice(folder: string, wanted: readonly string[]): void {
  const document = parseDocument(readFolderManifestText(folder));
  const body = document.toJS() as {
    kinds?: Record<string, { 'derives-from'?: string[]; fields?: { binding?: unknown; producers?: string[] }[] }>;
    edges?: { name: string; from: string[]; to: string[] }[];
    plugins?: { id: string; inputs?: string[]; outputs?: string[] }[];
    'semantic-bindings'?: Record<string, { kind: string; edges?: Record<string, { kind: string }> }>;
  };
  const held = body.kinds ?? {};
  const plugins = (body.plugins ?? []).filter((plugin) => (PLUGINS as readonly string[]).includes(plugin.id));
  // The product's own page is the kind `start` writes: it is declared whether or not the fill asks for it.
  const named = new Set<string>([...wanted, ...SUPPORT_KINDS, 'product']);
  for (const plugin of plugins) for (const kind of [...(plugin.inputs ?? []), ...(plugin.outputs ?? [])]) named.add(kind);
  // The wiki's own readers project the catalogue's explicit semantic roles (the problem list reads documents, commits and
  // tasks; a file's page reads its source): a product the wiki serves declares the kinds those roles name, though this
  // fill states most of them nowhere (decision 0039, item 35: the bindings are explicit, never inferred from names).
  for (const binding of Object.values(body['semantic-bindings'] ?? {})) named.add(binding.kind);
  const kept = new Set<string>();
  const follow = (name: string): void => {
    if (kept.has(name) || held[name] === undefined) return;
    kept.add(name);
    for (const parent of held[name]?.['derives-from'] ?? []) follow(parent);
  };
  for (const name of named) follow(name);
  for (const name of Object.keys(held)) if (!kept.has(name)) document.deleteIn(['kinds', name]);
  // A field bound to a plugin the product no longer holds stays the shape of the kind, as a person's own writing.
  const keptIds = new Set(plugins.map((plugin) => plugin.id));
  for (const name of Object.keys(held)) {
    if (!kept.has(name)) continue;
    for (const [index, field] of (held[name]?.fields ?? []).entries()) {
      const binding = field.binding;
      const producer = typeof binding === 'string' ? binding.split('@')[0] : undefined;
      if (producer === undefined || keptIds.has(producer)) continue;
      document.deleteIn(['kinds', name, 'fields', index, 'binding']);
      document.setIn(['kinds', name, 'fields', index, 'producers'], ['person']);
    }
  }
  // The product's problem rules are not part of the slice: a rule over a kind this product does not declare is a page
  // that answers no count, and a product without rules declares none.
  document.delete('problems');
  document.set('plugins', plugins.map((plugin) => ({
    ...plugin,
    inputs: (plugin.inputs ?? []).filter((kind) => kept.has(kind)),
    outputs: (plugin.outputs ?? []).filter((kind) => kept.has(kind)),
  })));
  // The engine writes its own protected kinds (`system.product` and the rest), which stand outside the product's kinds
  // folder: an edge of the product may name one as an end — `code.repository` derives from `product-profile`, whose key
  // edge `profile-product` reaches `system.product` — and the cut keeps it, or the kind kept for that edge loses its key.
  const engineKinds = new Set(SYSTEM_VERTEX_DEFINITIONS.map((kind) => kind.name));
  const edges = (body.edges ?? []).filter((edge) => [...edge.from, ...edge.to].every((end) => end === 'any' || kept.has(end) || engineKinds.has(end)));
  document.set('edges', edges);
  const edgeNames = new Set(edges.map((edge) => edge.name));
  for (const [role, binding] of Object.entries(body['semantic-bindings'] ?? {})) {
    if (!kept.has(binding.kind)) { document.deleteIn(['semantic-bindings', role]); continue; }
    for (const [name, edge] of Object.entries(binding.edges ?? {})) if (!edgeNames.has(edge.kind)) document.deleteIn(['semantic-bindings', role, 'edges', name]);
  }
  writeFolderManifest(folder, document.toString());
}

let root = '';
let home = '';
let folder = '';
let server: StartedServer | undefined;
let browser: Browser | undefined;
let session: McpSession | undefined;
let manifest: KindsManifest | undefined;
let turns: readonly Turn[] = [];
let fillState = '';
let fillUnits: readonly { readonly unitId: string; readonly state: string; readonly attempts?: number; readonly summary?: string }[] = [];
let unread: readonly { readonly repository: string; readonly path: string; readonly reason: string }[] = [];
let filled: Promise<void> | undefined;

run('the foundation slice on a product the test builds itself', () => {
  // What the walk asks the fill for, in the order their turns run: the repository's facts, the modules and components
  // the agent answers from its folders, and the kind nothing in this repository answers.
  const WANTED = ['code.repository', 'code.directory', 'code.file', 'code.package', 'code.module', 'code.service', 'code.debt', 'c4.component', 'code.commit', 'code.author'] as const;

  beforeAll(async () => {
    if (!existsSync(join(APP, 'index.html'))) throw new Error(`the built app is missing: ${join(APP, 'index.html')}`);
    root = mkdtempSync(join(tmpdir(), 'madarch-foundation-'));
    home = join(root, 'products');
    const repository = buildRepository(root);
    const draft = createDraft({ home, name: PRODUCT, gitEnv: gitEnv(SAMPLE_IDENTITY) });
    if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
    folder = draft.folder;
    writeFileSync(join(folder, 'workspace.yaml'), manifestWithRepo(readFileSync(join(folder, 'workspace.yaml'), 'utf8'), { name: REPOSITORY, linked: true }));
    symlinkSync(repository, join(folder, 'repos', REPOSITORY));
    // A fixture product declares the slice it is walked on, its four plugins and no model.
    // The document kind stays declared, though nothing fills it: the wiki's frame reads the catalogue's `document`
    // semantic role on every page, and a manifest without that kind makes /api/problems refuse (a Doubt of the report).
    restrictToSlice(folder, [...WANTED, 'document']);
    commitProduct(folder, 'A product the foundation slice is walked on');
    const declarations = readKinds(folder);
    if (declarations.present) manifest = declarations.manifest;
  }, 600_000);

  /** Fills the product once, starts the wiki on it and opens the walk's MCP session: the work every later test stands on. */
  const fillOnce = async (): Promise<void> => {
    filled ??= (async () => {
      const fake = join(root, 'scripted-agent.ts');
      const record = join(root, 'turns.jsonl');
      writeFileSync(fake, FAKE);
      const previousSandbox = process.env['MADARCH_PLUGIN_SANDBOX'];
      process.env['MADARCH_PLUGIN_SANDBOX'] = 'off';
      const store = productStoreFolder(folder, knowledgeRootOf(home));
      mkdirSync(join(store, 'graph'), { recursive: true });
      const owner = await createTestDatabaseOwner({ store: join(store, 'graph'), btreeGist: true });
      try {
        await prepareStore(owner, { contract: await readPinnedGraphContract(folder) });
        const targets = WANTED.filter((name) => manifest?.kinds.has(name) === true);
        const result = await runFill({
          product: folder, database: owner, store, home: store, runId: 'foundation-slice',
          targets: { kinds: targets, requested: targets },
          steps: ['plugin-turns'], workers: 1, tokenCap: 500_000,
          // A unit's lease is a minute by default, and a unit of this walk takes longer on a slow disk: the lease is the
          // run's own bound here, so the walk does not end a unit that is still working.
          limits: { attemptSeconds: 900 },
          prepareContract: async (contract) => { await prepareStore(owner, { contract }); },
          sink: (event) => { if (event.kind === 'unit-failed' || event.kind === 'unit-blocked') console.error(event.summary); },
          pluginAgent: { adapter: { id: 'foundation-agent', command: process.execPath, args: [fake, record] }, connect: connectAcpAgent },
        });
        if (!result.ok) throw new Error(`the fill was refused (${result.code}): ${result.reason}`);
        fillState = result.state;
        fillUnits = result.units;
        unread = result.unread ?? [];
      } finally {
        await owner.close();
        if (previousSandbox === undefined) delete process.env['MADARCH_PLUGIN_SANDBOX'];
        else process.env['MADARCH_PLUGIN_SANDBOX'] = previousSandbox;
      }
      if (existsSync(record)) turns = readFileSync(record, 'utf8').trim().split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Turn);
      server = await startPreparedServer({ productFolder: folder, appFolder: APP, port: 0, log: () => undefined, errorLog: () => undefined });
      session = await mcpSession(home, folder);
    })();
    await filled;
  };

  /** The browser the two walks below read the pages in: launched once, when the first of them opens a page. */
  const ensureBrowser = async (): Promise<Browser> => {
    browser ??= await puppeteer.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    return browser;
  };

  afterAll(async () => {
    await session?.close();
    await browser?.close();
    await server?.stop();
    // The store the fixture made runs its own PostgreSQL server; the owners are closed, and this waits for any server
    // whose data directory stands under the fixture's folder before the folder goes: a finished walk leaves nothing.
    if (root !== '') await stopServersUnder(root);
    if (root !== '') rmSync(root, { recursive: true, force: true });
  });

  test('the product declares the kinds and the relations the slice cannot do without', () => {
    const { findings } = sliceFindings(folder);
    expect(findings).toEqual([]);
  }, 120_000);

  test('the graph holds one product, its repository, every folder and file, the imports and the components', async () => {
    await fillOnce();
    const graph = session;
    if (graph === undefined) throw new Error('the walk opened no MCP session');
    const problems: string[] = [];
    const declared = (kind: string): boolean => manifest?.kinds.has(kind) === true;
    if (fillState !== 'succeeded' && fillState !== 'completed_partial') problems.push(`the fill ended ${JSON.stringify(fillState)}, and the walk needs the graph it fills`);
    if (unread.length > 0) problems.push(`the run could not read the repositories ${JSON.stringify(unread.map((one) => [one.repository, one.path, one.reason]))}`);
    const notPublished = fillUnits.filter((unit) => unit.state !== 'published');
    if (notPublished.length > 0) problems.push(`the run left units not published: ${JSON.stringify(notPublished.map((unit) => [unit.unitId, unit.state, unit.summary ?? '']))}`);
    const D = typeNameOf('code.directory');
    const F = typeNameOf('code.file');
    const C = typeNameOf('c4.component');
    // A kind's entities answer as the schema type `Kind<Name>` (decision 0036, section 1: the `Kind` family keeps a
    // product's kind names apart from the engine's own types); the list root stays `all<Name>`.
    const DT = kindTypeNameOf('code.directory');
    const FT = kindTypeNameOf('code.file');
    const dirRepository = fieldNameOf('code.directory-repository');
    const fileRepository = fieldNameOf('code.file-repository');
    const fileDirectory = fieldNameOf('code.file-directory');
    const importsField = fieldNameOf('code.imports');

    // Items 1 and 2, read from the schema the server publishes: a relation is an edge, and a parent is not a scalar.
    const sdl = String((await graph.ask('graph_schema'))['schema'] ?? '');
    for (const type of [DT, FT]) {
      const fields = fieldsOf(sdl, type);
      if (fields.length === 0) problems.push(`the schema publishes no type ${type}, so the kind has no page and no rows`);
      else if (fields.includes('repository')) problems.push(`the type ${type} carries a scalar field "repository", and its repository must be its parent key edge (decision 0039, items 1 and 2)`);
    }

    // One product, and its repository reached through an edge.
    const products = rowsOf(await graph.query(`{ all${typeNameOf('product')} { totalCount edges { node { id label } } } }`), `all${typeNameOf('product')}`);
    if (products.length !== 1) problems.push(`the graph holds ${String(products.length)} products, and the walk made one`);
    const product = products.find((one) => String(one['label']) === PRODUCT);
    if (product === undefined) problems.push(`no product is labelled "${PRODUCT}"`);
    let repositoryId = '';
    if (product !== undefined) {
      const reached = rowsOf(await graph.query(`query($id: ID!) { related(id: $id, edge: "product.uses-repository", inverse: false, first: 5) { edges { node { id kind label } } } }`, { id: product['id'] }), 'related');
      if (reached.length !== 1 || String(reached[0]?.['label']) !== REPOSITORY) problems.push(`the product's product.uses-repository reaches ${JSON.stringify(reached.map((one) => one['label']))}, and it should reach "${REPOSITORY}"`);
      else repositoryId = String(reached[0]?.['id']);
    }

    // Every folder, each with its repository through its key edge.
    const directories = rowsOf(await graph.query(`{ all${D}(orderBy: [{field: path}]) { edges { node { id path ${dirRepository}(first: 1) { edges { node { node { id kind label } } } } } } } }`), `all${D}`);
    const folderPaths = directories.map((one) => String(one['path'])).filter((path) => path === 'src' || path.startsWith('src/'));
    if (JSON.stringify(folderPaths) !== JSON.stringify([...FOLDERS])) problems.push(`the graph holds the folders ${JSON.stringify(folderPaths)}, and the repository has ${JSON.stringify([...FOLDERS])}`);
    for (const directory of directories.filter((one) => (FOLDERS as readonly string[]).includes(String(one['path'])))) {
      const parents = rowsOf({ [dirRepository]: directory[dirRepository] }, dirRepository).map(endOf).map((one) => String(one['label']));
      if (JSON.stringify(parents) !== JSON.stringify([REPOSITORY])) problems.push(`the folder ${String(directory['path'])} reaches the repository ${JSON.stringify(parents)} through its key edge, and not "${REPOSITORY}"`);
    }

    // The modules the agent answered, and the folder each one covers, through the edge the catalogue declares.
    const Ma = typeNameOf('code.module');
    const moduleFolder = fieldNameOf('code.module-folder');
    if (!declared('code.module')) problems.push('the product declares no kind "code.module", so the graph holds no module');
    const modules = !declared('code.module') ? [] : rowsOf(await graph.query(`{ all${Ma}(orderBy: [{field: name}]) { edges { node { name ${moduleFolder}(first: 1) { edges { node { node { kind label } } } } } } } }`), `all${Ma}`);
    const moduleNames = modules.map((one) => String(one['name']));
    // Both sides in code-point order: the graph answers by name, and the fixture's own list is the order the README
    // names its parts in (decision 0039's determinism rule: a comparison sorts by code point, never by an answer's order).
    const codePoint = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
    if (JSON.stringify([...moduleNames].sort(codePoint)) !== JSON.stringify([...MODULES.map((module) => module.module)].sort(codePoint))) {
      const turn = turns.find((one) => one.task.kind === 'code.module');
      problems.push(`the graph holds the modules ${JSON.stringify(moduleNames)}, and the agent answered ${JSON.stringify(MODULES.map((module) => module.module))}: its turn ended ${JSON.stringify(turn?.answer.end)} with ${JSON.stringify(turn?.answer.vertices?.length ?? 0)} vertices`);
    }
    for (const module of modules) {
      const expected = MODULES.find((one) => one.module === String(module['name']))?.folder;
      const held = rowsOf({ [moduleFolder]: module[moduleFolder] }, moduleFolder).map(endOf).map((one) => String(one['label']));
      if (expected !== undefined && JSON.stringify(held) !== JSON.stringify([expected])) problems.push(`the module ${String(module['name'])} covers the folder ${JSON.stringify(held)}, and it is held in "${expected}"`);
    }

    // Every file, with the repository and the folder it stands in, both as edges.
    const wanted = ['README.md', ...Object.keys(FILE_FOLDERS)];
    const files = rowsOf(await graph.query(`{ all${F}(where: {path: {_in: ${JSON.stringify(wanted)}}}, orderBy: [{field: path}]) { edges { node { id path ${fileRepository}(first: 1) { edges { node { node { id label } } } } ${fileDirectory}(first: 1) { edges { node { node { id kind label } } } } } } } }`), `all${F}`);
    const filePaths = files.map((one) => String(one['path']));
    for (const path of wanted) if (!filePaths.includes(path)) problems.push(`the graph holds no file "${path}" of the repository "${REPOSITORY}"`);
    for (const file of files) {
      const path = String(file['path']);
      const folderOf = rowsOf({ [fileRepository]: file[fileRepository] }, fileRepository).map(endOf).map((one) => String(one['label']));
      if (!folderOf.includes(REPOSITORY)) problems.push(`the file ${path} reaches no repository "${REPOSITORY}" through ${fileRepository}`);
      const expected = FILE_FOLDERS[path];
      if (expected === undefined) continue;
      const held = rowsOf({ [fileDirectory]: file[fileDirectory] }, fileDirectory).map(endOf).map((one) => String(one['label']));
      if (JSON.stringify(held) !== JSON.stringify([expected])) problems.push(`the file ${path} reaches the folder ${JSON.stringify(held)} through ${fileDirectory}, and it stands in "${expected}"`);
    }

    // A file's facts are the graph's own: the blob id its text is read by (decision 0037) and the lines it holds.
    const facts = rowsOf(await graph.query(`{ all${F}(where: {path: {_in: ${JSON.stringify(wanted)}}}) { edges { node { path blob lines } } } }`), `all${F}`);
    for (const file of facts) {
      if (String(file['blob'] ?? '') === '' || file['blob'] === null) problems.push(`the file ${String(file['path'])} holds no blob id, and a file's text is read by it (decision 0037)`);
      if (file['lines'] === null) problems.push(`the file ${String(file['path'])} holds no line count`);
    }

    // The imports the imports plugin read: one edge per import, told apart by its place, carrying its specifier.
    const sources = Object.keys(FILE_FOLDERS);
    const reading = rowsOf(await graph.query(`{ all${F}(where: {path: {_in: ${JSON.stringify(sources)}}}, orderBy: [{field: path}]) { edges { node { path ${importsField}(first: 5) { totalCount edges { node { discriminator specifier place node { ... on ${FT} { path } } } } } } } } }`), `all${F}`);
    // The place is `<line>:<column>`, and the order of two imports of one file is the order of their places: an edge
    // list answers in its own order, so the walk compares places as numbers rather than trusting the first row.
    const placeOrder = (left: string, right: string): number => {
      const [leftLine, leftColumn] = left.split(':').map((part) => Number(part));
      const [rightLine, rightColumn] = right.split(':').map((part) => Number(part));
      return (leftLine ?? 0) - (rightLine ?? 0) || (leftColumn ?? 0) - (rightColumn ?? 0);
    };
    const importsOf = (path: string): { to: string; specifier: string; place: string; discriminator: string }[] => {
      const file = reading.find((one) => String(one['path']) === path);
      return rowsOf({ [importsField]: file?.[importsField] }, importsField).map((edge) => ({
        to: String(endOf(edge)['path'] ?? ''), specifier: String(edge['specifier'] ?? ''), place: String(edge['place'] ?? ''), discriminator: String(edge['discriminator'] ?? ''),
      })).sort((left, right) => placeOrder(left.place, right.place));
    };
    const expectedImports: Readonly<Record<string, readonly string[]>> = {
      'src/identity/login.ts': ['src/shared/money.ts'],
      'src/orders/create-order.ts': ['src/orders/pricing.ts', 'src/shared/money.ts'],
      'src/orders/pricing.ts': ['src/shared/money.ts'],
      'src/shared/money.ts': [],
    };
    for (const [path, wanted] of Object.entries(expectedImports)) {
      const held = importsOf(path).map((one) => one.to);
      // The order of two imports of one file is the order of their places, not of the answer: compare as sets first.
      if (JSON.stringify([...held].sort()) !== JSON.stringify([...wanted].sort())) problems.push(`the file ${path} imports ${JSON.stringify(held)}, and its source imports ${JSON.stringify(wanted)}`);
    }
    const firstImport = importsOf('src/orders/create-order.ts')[0];
    if (firstImport !== undefined && (firstImport.specifier !== './pricing' || firstImport.place === '' || firstImport.discriminator === '')) problems.push(`an import of src/orders/create-order.ts reads as ${JSON.stringify(firstImport)}: its specifier, place and discriminator name the import`);

    // The components the agent answered from the folders, and the folder each one is realised by, through edges only.
    const chain = realisationChain([...(manifest?.edges?.values() ?? [])]);
    if (chain.problem !== undefined) problems.push(chain.problem);
    if (!declared('c4.component')) problems.push('the product declares no kind "c4.component", so the graph holds no component (see the declarations test)');
    const components = !declared('c4.component') ? [] : rowsOf(await graph.query(`{ all${C}(orderBy: [{field: name}]) { edges { node { id label name responsibility } } } }`), `all${C}`);
    const names = components.map((one) => String(one['name'] ?? one['label']));
    if (declared('c4.component') && JSON.stringify([...names].sort(codePoint)) !== JSON.stringify([...PARTS.map((part) => part.component)].sort(codePoint))) problems.push(`the graph holds the components ${JSON.stringify(names)}, and the README names ${JSON.stringify(PARTS.map((part) => part.component))}`);
    for (const component of components) {
      const part = PARTS.find((one) => one.component === String(component['name'] ?? component['label']));
      if (part === undefined || chain.first === undefined) continue;
      const first = rowsOf(await graph.query(`query($id: ID!) { related(id: $id, edge: "${chain.first}", inverse: false, first: 5) { edges { node { id kind label } } } }`, { id: component['id'] }), 'related');
      if (first.length !== 1) { problems.push(`the component ${part.component} reaches ${String(first.length)} entities through ${chain.first}, and one realises it`); continue; }
      let folder = first[0]!;
      if (chain.second !== undefined) {
        const second = rowsOf(await graph.query(`query($id: ID!) { related(id: $id, edge: "${chain.second}", inverse: false, first: 5) { edges { node { id kind label } } } }`, { id: folder['id'] }), 'related');
        if (second.length !== 1) { problems.push(`the module of ${part.component} reaches ${String(second.length)} folders through ${chain.second}, and it is held in one`); continue; }
        folder = second[0]!;
      }
      if (String(folder['kind']) !== 'code.directory' || String(folder['label']) !== part.folder) problems.push(`the component ${part.component} is realised by ${JSON.stringify({ kind: folder['kind'], label: folder['label'] })}, and the folder that realises it is "${part.folder}"`);
    }
    if (repositoryId === '') problems.push('the walk found no repository entity, so the wiki below opens on nothing');
    expect(problems).toEqual([]);
  }, 1_800_000);

  test('every value is an assertion with its source and its evidence', async () => {
    await fillOnce();
    const graph = session;
    if (graph === undefined) throw new Error('the walk opened no MCP session');
    const problems: string[] = [];
    const F = typeNameOf('code.file');
    const M = typeNameOf('code.module');
    interface AssertionRow {
      readonly property: string;
      readonly value: unknown;
      readonly selected: boolean;
      readonly source: { readonly id: string; readonly kind: string; readonly label: string };
      readonly evidence: readonly { readonly relation: string; readonly target: { readonly label: string } | null; readonly locator: unknown }[];
    }
    const assertionsQuery = `{ property value selected source { id kind label } evidence { relation target { id kind label } locator } }`;
    const fileRows = rowsOf(await graph.query(`{ all${F}(where: {path: {_eq: "src/orders/create-order.ts"}}) { edges { node { path ${fieldNameOf('path')}Assertions ${assertionsQuery} } } } }`), `all${F}`);
    const paths = (fileRows[0]?.[`${fieldNameOf('path')}Assertions`] ?? []) as AssertionRow[];
    if (paths.length === 0) problems.push('the file src/orders/create-order.ts states no assertion of its path');
    for (const assertion of paths) {
      if (typeof assertion.source?.label !== 'string' || assertion.source.label === '') problems.push(`the assertion of ${assertion.property} names no source`);
      if (!Array.isArray(assertion.evidence) || assertion.evidence.length === 0) problems.push(`the assertion of ${assertion.property} names no evidence`);
      // Every source states the same path, and the read selects one of them for the view (decision 0039, item 25: a
      // statement per source, equal values agreeing even where their evidence differs, and the newest one selected).
      if (assertion.value !== 'src/orders/create-order.ts') problems.push(`the assertion of ${assertion.property} of the source ${JSON.stringify(assertion.source?.label)} states ${JSON.stringify(assertion.value)}, and the file states one path`);
    }
    const chosen = paths.filter((assertion) => assertion.selected === true);
    if (chosen.length !== 1) problems.push(`the graph selects ${String(chosen.length)} of the ${String(paths.length)} assertions of the file's path, and the read selects one value`);
    // The disk and git plugins are the sources of a file's path: plugins, not the agent, and one selected value.
    const pluginSources = [...new Set(chosen.map((assertion) => `${assertion.source?.kind}:${assertion.source?.id}`))];
    if (pluginSources.length !== 1 || !pluginSources[0]?.startsWith('plugin:')) problems.push(`the file's path is asserted by the sources ${JSON.stringify(pluginSources)}, and one plugin of the manifest is the source of a file's path`);
    const responsibility = `${fieldNameOf('responsibility')}Assertions`;
    const moduleRows = manifest?.kinds.has('code.module') !== true ? [] : rowsOf(await graph.query(`{ all${M}(where: {name: {_eq: "orders"}}) { edges { node { name ${responsibility} ${assertionsQuery} } } } }`), `all${M}`);
    const stated = (moduleRows[0]?.[responsibility] ?? []) as AssertionRow[];
    if (stated.length === 0) problems.push('the module orders states no assertion of its responsibility, and the agent answered it');
    for (const assertion of stated) {
      // Who said it is an edge to the plugin that ran the turn, an agent session or a person (decision 0039, item 14):
      // agent-fill is a plugin, so its answers are asserted by a plugin source and never by an unnamed one.
      if (!['plugin', 'agent', 'agent-session', 'person'].includes(String(assertion.source?.kind)) || String(assertion.source?.label ?? '') === '') problems.push(`the module's responsibility is asserted by the source ${JSON.stringify(assertion.source)}, and the agent's answer stands on the plugin that ran the turn (decision 0039, item 14)`);
      if (!Array.isArray(assertion.evidence) || assertion.evidence.length === 0 || assertion.evidence[0]?.target == null) problems.push(`the module's responsibility names no evidence target, and the agent read a file of the repository`);
    }
    expect(problems).toEqual([]);
  }, 1_800_000);

  test('the agent was given the kind, and read the folders and the README through the session\'s own graph server', async () => {
    await fillOnce();
    const problems: string[] = [];
    const kinds = turns.map((turn) => turn.task.kind);
    for (const kind of ['code.module', 'c4.component', 'code.debt']) {
      if (!kinds.includes(kind)) problems.push(`the agent was asked for no turn of ${kind}: it answered ${JSON.stringify(kinds)}`);
    }
    const moduleTurn = turns.find((turn) => turn.task.kind === 'code.module');
    const componentTurn = turns.find((turn) => turn.task.kind === 'c4.component');
    for (const turn of [moduleTurn, componentTurn]) {
      if (turn === undefined) continue;
      // The task is the kind, what it is and the fields of its answer: no list of files, no dump of the graph, and no
      // path of this machine.
      if (turn.prompt.includes(root)) problems.push(`the prompt of ${turn.task.kind} names a path of this machine`);
      for (const leaked of ['Files available', 'Output contract', '**/*']) if (turn.prompt.includes(leaked)) problems.push(`the prompt of ${turn.task.kind} carries ${JSON.stringify(leaked)}`);
      if (JSON.stringify([...(turn.tools ?? [])]) !== JSON.stringify(['graph_schema', 'graph_query', 'graph_text'])) problems.push(`the session of ${turn.task.kind} offers ${JSON.stringify(turn.tools)}, and madarch's graph server offers graph_schema, graph_query and graph_text`);
      if (!turn.calls.some((call) => call.tool === 'graph_query' && call.answer.includes('src/orders'))) problems.push(`the turn of ${turn.task.kind} read no folder of the repository from the graph`);
      if (turn.calls.some((call) => call.isError)) problems.push(`a read of ${turn.task.kind} was refused: ${JSON.stringify(turn.calls.filter((call) => call.isError).map((call) => call.answer).slice(0, 2))}`);
    }
    // The README's text is read from the graph, not from a working copy: the component turn names its lines.
    const readme = componentTurn?.calls.find((call) => call.tool === 'graph_text');
    if (readme === undefined) problems.push('the component turn read no text from the graph, and the README is what names the parts');
    else if (readme.isError) problems.push(`the README's text read was refused: ${readme.answer.slice(0, 600)}`);
    expect(problems).toEqual([]);
  }, 120_000);

  test('the wiki renders the product, the repository, the folder, the file with its text, and the component', async () => {
    await fillOnce();
    const graph = session;
    if (graph === undefined || server === undefined) throw new Error('the walk opened no session or server');
    const chrome = await ensureBrowser();
    const problems: string[] = [];
    const idOf = async (kind: string, where: string): Promise<string> => {
      const rows = rowsOf(await graph.query(`{ all${typeNameOf(kind)}(where: ${where}, first: 1) { edges { node { id } } } }`), `all${typeNameOf(kind)}`);
      return String(rows[0]?.['id'] ?? '');
    };
    const declares = (kind: string): boolean => manifest?.kinds.has(kind) === true;
    const repositoryId = await idOf('code.repository', `{name: {_eq: "${REPOSITORY}"}}`);
    const folderId = await idOf('code.directory', '{path: {_eq: "src/orders"}}');
    const fileId = await idOf('code.file', '{path: {_eq: "src/orders/create-order.ts"}}');
    const moduleId = declares('code.module') ? await idOf('code.module', '{name: {_eq: "orders"}}') : '';
    const componentId = declares('c4.component') ? await idOf('c4.component', '{name: {_eq: "Orders"}}') : '';
    mkdirSync(SHOTS, { recursive: true });
    const page = await chrome.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => { failures.push(String(error)); });
    page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()); });
    page.on('response', (response) => { if (response.status() >= 500) failures.push(`HTTP ${String(response.status())} on ${response.url()}`); });
    const textOf = async (): Promise<string> => await page.evaluate(() => document.body.textContent ?? '');
    const titleOf = async (): Promise<string> => (await page.$eval('[data-testid="page-title"]', (element) => element.textContent ?? '').catch(() => '')).trim();
    const links = async (): Promise<string[]> => await page.$$eval('a[href]', (anchors) => anchors.map((anchor) => anchor.getAttribute('href') ?? ''));
    const shotAt = async (name: string, width: number, height: number): Promise<void> => {
      await page.setViewport({ width, height, deviceScaleFactor: 1 });
      await new Promise((accept) => setTimeout(accept, 250));
      await page.screenshot({ path: join(SHOTS, `${name}-${String(width)}.png`) });
    };
    /** One address of the wiki, read as a person reads it: the first-visit role question answered once. */
    const open = async (address: string): Promise<string> => {
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.goto(`${server!.url}${address}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const dialog = await page.waitForSelector('[data-testid="role-first"]', { timeout: 8_000 }).catch(() => null);
      if (dialog !== null) {
        await page.click('[data-testid="role-first-continue"]');
        await page.waitForSelector('[data-testid="role-first"]', { hidden: true, timeout: 30_000 });
      }
      await page.waitForSelector('[data-testid="page-title"]', { timeout: 60_000 });
      return await titleOf();
    };
    try {
      await page.evaluateOnNewDocument(() => { try { window.localStorage.setItem('madarch-wiki-language', 'ru'); } catch { /* no storage */ } });
      // The product's own page.
      const homeTitle = await open('/');
      if (homeTitle !== PRODUCT) problems.push(`the home's title reads ${JSON.stringify(homeTitle)}, and the product is called "${PRODUCT}"`);
      await shotAt('home', 1440, 900);
      await shotAt('home', 390, 844);
      // The repository, and the folder it links: a folder page opens by the link the repository's page draws.
      const repositoryTitle = await open(`/e/code.repository/${encodeURIComponent(repositoryId)}`);
      if (repositoryTitle !== REPOSITORY) problems.push(`the repository page's title reads ${JSON.stringify(repositoryTitle)}, and the repository is called "${REPOSITORY}"`);
      const fromRepository = await links();
      const folderAddress = `/e/${encodeURIComponent('code.directory')}/${encodeURIComponent(folderId)}`;
      if (folderId === '' || !fromRepository.includes(folderAddress)) problems.push(`the repository page links the folder of its code at no ${JSON.stringify(folderAddress)}: its links are ${JSON.stringify(fromRepository.slice(0, 24))}`);
      await shotAt('repository', 1440, 900);
      await shotAt('repository', 390, 844);
      await page.click(`a[href="${folderAddress}"]`).catch(() => null);
      const moved = await page.waitForFunction((address: string) => window.location.pathname === address, { timeout: 30_000 }, folderAddress).then(() => true, () => false);
      if (!moved) problems.push(`the repository page's link to the folder moves the reader nowhere: the address is still ${page.url()}`);
      await page.waitForFunction((title: string) => (document.querySelector('[data-testid="page-title"]')?.textContent ?? '').trim() === title, { timeout: 30_000 }, 'src/orders').catch(() => null);
      const folderTitle = await titleOf();
      if (folderTitle !== 'src/orders') problems.push(`the folder page's title reads ${JSON.stringify(folderTitle)}, and the folder is "src/orders"`);
      const folderText = await textOf();
      if (!folderText.includes('create-order.ts') || !folderText.includes('pricing.ts')) problems.push('the folder page lists no file of its own');
      const fromFolder = await links();
      const fileAddress = `/e/${encodeURIComponent('code.file')}/${encodeURIComponent(fileId)}`;
      if (fileId === '' || !fromFolder.includes(fileAddress)) problems.push(`the folder page links the file at no ${JSON.stringify(fileAddress)}: its links are ${JSON.stringify(fromFolder.slice(0, 24))}`);
      await shotAt('folder', 1440, 900);
      await shotAt('folder', 390, 844);
      // The file: its name, its place, its imports, and its text — read from git by the blob id of the filled revision.
      const fileTitle = await open(fileAddress);
      if (!fileTitle.includes('create-order.ts')) problems.push(`the file page's title reads ${JSON.stringify(fileTitle)}, and the file is "src/orders/create-order.ts"`);
      await page.waitForFunction(() => (document.body.textContent ?? '').includes("import { price } from './pricing';"), { timeout: 30_000 }).catch(() => null);
      const fileText = await textOf();
      if (!fileText.includes("import { price } from './pricing';")) problems.push(`the file page shows no text of the file: it reads ${JSON.stringify(fileText.slice(0, 800))}`);
      if (!fileText.includes('src/orders')) problems.push('the file page names not the folder it stands in');
      if (!fileText.includes(REPOSITORY)) problems.push('the file page names not the repository it belongs to');
      await shotAt('file', 1440, 900);
      await shotAt('file', 390, 844);
      // The component: its name, its responsibility, and the way to the folder that realises it.
      if (componentId === '') {
        problems.push('the graph holds no component "Orders", so its page opens on nothing');
      } else {
        const componentTitle = await open(`/e/${encodeURIComponent('c4.component')}/${encodeURIComponent(componentId)}`);
        if (componentTitle !== 'Orders') problems.push(`the component page's title reads ${JSON.stringify(componentTitle)}, and the component is "Orders"`);
        const componentText = await textOf();
        if (!componentText.includes('src/orders')) problems.push('the component page says nothing of the folder that realises it');
        const fromComponent = await links();
        const reachable = [moduleId === '' ? undefined : `/e/${encodeURIComponent('code.module')}/${encodeURIComponent(moduleId)}`, folderId === '' ? undefined : folderAddress].filter((one): one is string => one !== undefined);
        if (reachable.length === 0 || !reachable.some((target) => fromComponent.includes(target))) problems.push(`the component page links neither its module nor its folder: its links are ${JSON.stringify(fromComponent.slice(0, 24))}`);
        await shotAt('component', 1440, 900);
        await shotAt('component', 390, 844);
      }
      const logged = failures.filter((one) => !one.includes('favicon'));
      if (logged.length > 0) problems.push(`the pages logged errors: ${logged.join(' | ')}`);
    } finally {
      await page.close();
    }
    expect(problems).toEqual([]);
  }, 1_800_000);

  test('the catalogue counts the kinds the fill took and marks the kind nothing answers inapplicable, with why', async () => {
    await fillOnce();
    if (server === undefined) throw new Error('the walk opened no server');
    const problems: string[] = [];
    mkdirSync(SHOTS, { recursive: true });
    const page = await (await ensureBrowser()).newPage();
    try {
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.goto(`${server.url}/p/catalogue`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const dialog = await page.waitForSelector('[data-testid="role-first"]', { timeout: 8_000 }).catch(() => null);
      if (dialog !== null) {
        await page.click('[data-testid="role-first-continue"]');
        await page.waitForSelector('[data-testid="role-first"]', { hidden: true, timeout: 30_000 });
      }
      await page.waitForSelector('[data-testid="catalogue-page"]', { timeout: 60_000 });
      await page.waitForSelector('[data-testid="catalogue-kind"][data-kind="code.file"]', { timeout: 60_000 });
      const rowText = async (kind: string): Promise<string> => await page.$eval(`[data-testid="catalogue-kind"][data-kind="${kind}"]`, (element) => element.textContent ?? '').catch(() => '');
      // The kinds the fill took carry the number of entities the graph holds of them: the page and the graph agree.
      const graph = session;
      if (graph === undefined) throw new Error('the walk opened no MCP session');
      for (const kind of ['code.file', 'code.directory', 'code.repository']) {
        const text = (await rowText(kind)).replace(/\s+/gu, ' ').trim();
        if (text === '') { problems.push(`the catalogue lists no row for ${kind}`); continue; }
        const answer = await graph.query(`{ all${typeNameOf(kind)} { totalCount } }`);
        const held = Number(((answer[`all${typeNameOf(kind)}`] ?? {}) as { totalCount?: number }).totalCount ?? -1);
        if (held <= 0) problems.push(`the graph holds no ${kind}, and the fill published some`);
        const counted = /(\d+)/u.exec(text)?.[1];
        if (counted !== String(held)) problems.push(`the catalogue's row for ${kind} counts ${String(counted)} records, and the graph holds ${String(held)}`);
      }
      // The kind nothing in this repository answers: the agent searched and found none, and the row says so, with why.
      const debt = (await rowText('code.debt')).replace(/\s+/gu, ' ').trim();
      if (debt === '') problems.push('the catalogue lists no row for code.debt');
      else if (!debt.includes('неприменимо')) problems.push(`the catalogue's row for code.debt reads ${JSON.stringify(debt)}, and no file of the repository states a debt, so the kind is inapplicable here (decision 0039, item 35)`);
      else if (!/неприменимо\s*\S.*\S/u.test(debt.replace('неприменимо', 'неприменимо '))) problems.push(`the catalogue's row for code.debt names no reason for its inapplicability: ${JSON.stringify(debt)}`);
      await page.screenshot({ path: join(SHOTS, 'catalogue-1440.png') });
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
      await new Promise((accept) => setTimeout(accept, 250));
      await page.screenshot({ path: join(SHOTS, 'catalogue-390.png') });
    } finally {
      await page.close();
    }
    expect(problems).toEqual([]);
  }, 300_000);
});
