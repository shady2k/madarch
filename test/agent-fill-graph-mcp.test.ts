/**
 * The agent fill reads the graph through madarch's own MCP server (owner's decision, 2026-11-15): the task it is given is
 * the kind it fills and what that kind means, nothing of the graph stands in the prompt, and the agent's tool calls read
 * the folders, the files and their text from the graph. A scripted ACP agent stands in for the model: it speaks the
 * protocol, it calls the session's server, and it answers from what it read.
 *
 * The fill runs unconfined here (`unconfined: true`): a sandboxed plugin has no network namespace of its own, and an
 * agent's model is reached over the network too, so a fill with an agent runs unconfined today (madarch-64o5.110 gives
 * the agent session its own environment). The choice is the fill's, never the process's environment.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectAcpAgent } from '../src/fill/acp.js';
import { runFill } from '../src/fill/run.js';
import { pluginTurnAuthority, type PluginTurnWiring } from '../src/fill/plugin-turns.js';
import { executeGraphql } from '../src/graph/graphql-execute.js';
import { byCodePoint } from '../src/model/order.js';
import { readProgress } from '../src/graph/fill-orchestration.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { createTestDatabaseOwner, prepareTestStore } from './test-database.js';
import { makeProduct } from './knowledge-fixture.js';
import { parse, stringify } from 'yaml';
import { CATALOG_FILES } from '../src/knowledge/catalog-assets.js';
import { createHash } from 'node:crypto';

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

/** The files the fixture repository holds, by folder: the agent reads these through the graph. */
const FILES: Readonly<Record<string, string>> = {
  'src/orders/create-order.ts': "export function createOrder(sku: string): string {\n  return `order:${sku}`;\n}\n",
  'src/orders/refund.ts': "export function refund(order: string): boolean {\n  return order !== '';\n}\n",
  'src/identity/login.ts': "export function login(user: string): string {\n  return `session:${user}`;\n}\n",
  'README.md': '# Orders and identity\n\nThe fixture product keeps orders and the people who place them.\n',
};

/**
 * A scripted ACP agent: it starts nothing of its own, it speaks the session's MCP server over HTTP (initialize,
 * notifications/initialized, tools/list, tools/call), reads the folders, the files and one file's text from the graph,
 * and answers with the kind its task names. Every turn is appended to the record file as one JSON line.
 */
const FAKE = `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const recordPath = process.argv[2];
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
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
  calls.push({ tool: name, arguments: args, isError: answer.result?.isError === true, answer: text.slice(0, 4000) });
  return JSON.parse(text);
};
const capitalised = (word) => word.slice(0, 1).toUpperCase() + word.slice(1);
createInterface({ input: process.stdin }).on('line', async (line) => {
  const m = JSON.parse(line);
  if (!m.method) { pending.get(m.id)?.(m); pending.delete(m.id); return; }
  if (m.method === 'initialize') { send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true, sse: true } } } }); return; }
  if (m.method === 'session/new') {
    servers = m.params.mcpServers ?? [];
    send({ id: m.id, result: { sessionId: 'graph-session', models: { currentModelId: 'fixture-model', availableModels: [{ modelId: 'fixture-model', name: 'Fixture model' }] } } });
    return;
  }
  if (m.method !== 'session/prompt') return;
  const prompt = (m.params.prompt ?? []).map((part) => String(part.text ?? '')).join('\\n');
  const task = JSON.parse(prompt.slice(prompt.lastIndexOf('Task: ') + 'Task: '.length));
  let answer;
  let tools;
  try {
    const initialized = await post({ jsonrpc: '2.0', id: ++sequence, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture-agent', version: '1.0.0' } } });
    if (initialized.error !== undefined) throw new Error('initialize refused: ' + JSON.stringify(initialized.error));
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const listed = await post({ jsonrpc: '2.0', id: ++sequence, method: 'tools/list', params: {} });
    tools = ((listed.result ?? {}).tools ?? []).map((one) => one.name);
    const folders = await tool('graph_query', { query: '{ allCodeDirectory(where: {path: {_like: "src/%"}}, orderBy: [{field: path}]) { edges { node { path codeDirectoryRepository(first: 1) { edges { node { node { ... on KindCodeRepository { name } } } } } } } } }' });
    // The fixture's source files, not the product catalogue that sorts before src/ in the default page.
    const files = await tool('graph_query', { query: '{ allCodeFile(where: {path: {_like: "src/%"}}, orderBy: [{field: path}]) { edges { node { path lines codeBlobAboutOf(first: 1) { edges { node { node { ... on KindCodeBlob { digest } } } } } codeFileRepository(first: 1) { edges { node { node { ... on KindCodeRepository { name } } } } } } } } }' });
    const repositoryOf = (node, edge) => node[edge].edges[0]?.node.node.name;
    const fileNodes = files.data.allCodeFile.edges.map((edge) => ({ ...edge.node, digest: edge.node.codeBlobAboutOf.edges[0]?.node.node.digest, repository: repositoryOf(edge.node, 'codeFileRepository') })).filter(node => node.repository === 'app');
    const first = fileNodes.find((node) => node.path.endsWith('create-order.ts')) ?? fileNodes[0];
    const content = await tool('graph_text', { kind: 'code.blob', key: { digest: first.digest }, field: 'content', lineStart: 1, lineEnd: Math.min(3, first.lines) });
    // What the agent found: one folder per area of the code, its first file as the evidence of each entity.
    const areas = folders.data.allCodeDirectory.edges.map((edge) => ({ ...edge.node, repository: repositoryOf(edge.node, 'codeDirectoryRepository') })).filter((node) => node.repository === 'app' && /^src\\/[^/]+$/.test(node.path));
    const evidenceOf = (area) => {
      const held = fileNodes.find((node) => node.path.startsWith(area.path + '/'));
      return { target: { kind: 'code.blob', key: { digest: held.digest } }, path: held.path, lineStart: 1, lineEnd: Math.min(2, held.lines) };
    };
    const domains = areas.map((area) => ({
      kind: 'domain',
      key: { name: capitalised(area.path.split('/').pop()) },
      values: { description: 'The area of the product that ' + area.path + ' answers for, read from its files: ' + content.text.split('\\n')[0] },
      evidence: evidenceOf(area),
    }));
    const modules = areas.map((area) => ({
      kind: 'code.module',
      key: { name: area.path.split('/').pop() },
      values: { responsibility: 'The module held in ' + area.path + '.' },
      evidence: evidenceOf(area),
    }));
    const directoryOf = (area) => ({ kind: 'code.directory', key: { path: area.path }, keyEdges: { 'code.directory-repository': { kind: 'code.repository', key: { name: area.repository } } } });
    const edges = domains.map((domain) => ({
      kind: 'domain.covers-folder',
      from: { kind: 'domain', key: domain.key },
      to: directoryOf(areas.find((area) => capitalised(area.path.split('/').pop()) === domain.key.name)),
      evidence: domain.evidence,
    }));
    answer = task.kind === 'domain'
      ? { vertices: domains, edges, end: { state: 'complete' } }
      : { vertices: modules, edges: modules.map((module, index) => ({ kind: 'code.module-folder', from: { kind: module.kind, key: module.key }, to: directoryOf(areas[index]), evidence: module.evidence })), end: { state: 'complete' } };
    // The malformed mode: the entries the agent got right stand beside entries no contract can take — an undeclared
    // field, an undeclared kind, evidence at a file the graph does not hold, and an edge of no declared kind (owner's
    // rule, 2026-11-15: a produced result is never discarded, entry by entry).
    if (process.argv[3] === 'malformed' && task.kind === 'domain') {
      answer.vertices.push(
        { kind: 'domain', key: { name: 'Ghost' }, values: { colour: 'red' }, evidence: domains[0].evidence },
        { kind: 'nonsense', key: { name: 'Nothing' }, values: {}, evidence: domains[0].evidence },
        { kind: 'domain', key: { name: 'Absent' }, values: { description: 'read from a file that is not there' }, evidence: { target: { kind: 'code.blob', key: { digest: '0'.repeat(64) } }, path: 'src/absent.ts', lineStart: 1, lineEnd: 1 } },
      );
      answer.edges.push({ kind: 'domain.links-to-nothing', from: { kind: 'domain', key: domains[0].key }, to: { kind: 'domain', key: domains[0].key }, evidence: domains[0].evidence });
    }
  } catch (error) {
    answer = { vertices: [], edges: [], end: { state: 'partial', cause: String(error) } };
  }
  appendFileSync(recordPath, JSON.stringify({ prompt, task, servers, tools, calls, answer }) + '\\n');
  send({ method: 'session/update', params: { sessionId: m.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(answer) } } } });
  // What one turn spent, as an agent that re-sends its prompt from the cache reports it: the cache reads are huge,
  // and the tokens a cap counts — input, output and cache writes — are the 460 beside them (owner's decision,
  // 2026-11-15).
  send({ id: m.id, result: { stopReason: 'end_turn', usage: { inputTokens: 300, outputTokens: 150, cachedWriteTokens: 10, cachedReadTokens: 1_000_000, totalTokens: 1_000_460 } } });
});
`;

/** The product, its linked fixture repository and the scripted agent. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'madarch-agent-graph-'));
  roots.push(root);
  const repository = join(root, 'app');
  for (const [path, content] of Object.entries(FILES)) {
    mkdirSync(join(repository, path, '..'), { recursive: true });
    writeFileSync(join(repository, path), content);
  }
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  git(repository, 'init', '-q', '-b', 'main');
  git(repository, 'add', '-A');
  git(repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'the fixture code');
  const home = join(root, 'home');
  const product = makeProduct(home, 'graph-agent', repository, 'app');
  // The fixture tests these relations explicitly; the starter catalogue need not offer them to a new product.
  const metadataPath = join(product, 'madarch/catalog.yaml');
  const metadata = parse(readFileSync(metadataPath, 'utf8'));
  const catalogue = parse(CATALOG_FILES['catalog.yaml']!);
  const relations = ['domain.covers-folder', 'domain.covers', 'module.depends-on', 'code.module-folder'];
  metadata.edges = [...metadata.edges.filter((edge: { name: string }) => !relations.includes(edge.name) && !['domain.contains', 'code.module.contains', 'class-diagram-module', 'component.implemented-by'].includes(edge.name)),
    ...catalogue.edges.filter((edge: { name: string }) => relations.includes(edge.name))];
  writeFileSync(metadataPath, stringify(metadata));
  const domainPath = join(product, 'madarch/kinds/strategy/product/domain.yaml');
  const domain = parse(readFileSync(domainPath, 'utf8'));
  domain['derives-from'] = [...new Set([...(domain['derives-from'] ?? []), 'code.directory'])];
  domain.description.en = 'A domain is an area of the business with its own responsibilities and language.';
  writeFileSync(domainPath, stringify(domain));
  const modulePath = join(product, 'madarch/kinds/code/structure/code.module.yaml');
  const module = parse(readFileSync(modulePath, 'utf8'));
  module['derives-from'] = [...new Set([...(module['derives-from'] ?? []), 'domain'])];
  writeFileSync(modulePath, stringify(module));
  git(product, 'add', '-A');
  git(product, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'the product');
  const fake = join(root, 'fake-acp.ts');
  writeFileSync(fake, FAKE);
  return { root, home, product, fake, record: join(root, 'turns.jsonl') };
}

describe('the agent fill reads the graph through madarch\'s MCP server', () => {
  test('a missing-kind unit receives no plugin authority', () => {
    expect(pluginTurnAuthority({} as PluginTurnWiring, 'missing:domain')).toBeUndefined();
  });

  test('domain and code.module are filled from the graph, the task is the kind and no path, and the agent reads with tools', async () => {
    const f = fixture();
    const declarations = readKinds(f.product);
    expect(declarations.present).toBe(true);
    if (!declarations.present) return;
    expect(declarations.manifest.findings).toEqual([]);
    const owner = await createTestDatabaseOwner({ btreeGist: true, graphContract: await readPinnedGraphContract(f.product) });
    try {
      const run = await runFill({
        sink: (event) => { if (event.kind === 'unit-failed' || event.kind === 'unit-blocked') console.error(event.summary); },
        product: f.product, targets: { kinds: ['domain', 'code.module'], requested: ['domain', 'code.module'] },
        tokenCap: 200_000, database: owner,
        prepareContract: async (contract) => { await prepareTestStore(owner, { contract }); },
        home: f.home, steps: ['plugin-turns'], workers: 2,
        // The fill's own choice, never the test process's environment: a leaked variable would run every later plugin
        // of the run unconfined (decision 0038).
        unconfined: true,
        pluginAgent: { adapter: { id: 'fixture-acp', command: process.execPath, args: [f.fake, f.record] }, connect: connectAcpAgent },
      });
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      expect(run.state).toBe('succeeded');
      expect(run.units.filter((unit) => unit.unitId === 'plugin-turns/agent-fill:domain' || unit.unitId === 'plugin-turns/agent-fill:code.module').map((unit) => [unit.unitId, unit.state] as const).sort((left, right) => byCodePoint(left[0], right[0]))).toEqual([['plugin-turns/agent-fill:code.module', 'published'], ['plugin-turns/agent-fill:domain', 'published']]);

      // What the agent was given: the kind and what it means, and nothing of the graph.
      const turns = readFileSync(f.record, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as {
        prompt: string; task: { kind: string; what: string; fields: { name: string; meaning: string }[]; relations: { kind: string }[] };
        tools: string[]; calls: { tool: string; arguments: unknown; isError: boolean; answer: string }[]; answer: { vertices: unknown[]; edges: unknown[]; end: { state: string } };
      });
      const domainTurn = turns.find((turn) => turn.task.kind === 'domain');
      const moduleTurn = turns.find((turn) => turn.task.kind === 'code.module');
      if (domainTurn === undefined || moduleTurn === undefined) throw new Error(`the fill ran no turn for both kinds: ${JSON.stringify(turns.map((turn) => turn.task.kind))}`);
      for (const turn of [domainTurn, moduleTurn]) {
        // English only, no path and no list of files: the prompt is the role, the tools and the task.
        expect(turn.prompt).not.toContain('Files available');
        expect(turn.prompt).not.toContain('Output contract');
        expect(turn.prompt).not.toContain('**/*');
        expect(turn.prompt).not.toContain('docs/');
        expect(turn.prompt).not.toMatch(/[\u0400-\u04FF]/u);
        expect(Math.ceil(turn.prompt.length / 4)).toBeLessThan(2000);
        // The tools are madarch's graph server's own, and the agent read the graph with them.
        expect(turn.tools).toEqual(['graph_schema', 'graph_query', 'graph_text']);
        expect(turn.calls.map((call) => call.tool)).toEqual(['graph_query', 'graph_query', 'graph_text']);
        expect(turn.calls.some((call) => call.answer.includes('src/orders'))).toBe(true);
        expect(turn.calls.some((call) => call.answer.includes('createOrder'))).toBe(true);
        expect(turn.calls.every((call) => call.isError === false)).toBe(true);
        expect(turn.answer.end.state).toBe('complete');
      }
      expect(domainTurn.task.what).toContain('area of the business');
      expect(domainTurn.task.fields.map((field) => field.name)).toEqual(['name', 'description', 'type']);
      // An edge between two kinds one agent fills belongs to the later unit's turn: the domain turn owns the edge to
      // the folder, which the repository plugins fill, and the module's turn owns the edge to the module.
      expect(domainTurn.task.relations.map((relation) => relation.kind)).toEqual(['domain.covers-folder']);
      expect(moduleTurn.task.fields.map((field) => field.name)).toEqual(['name', 'responsibility']);
      // The module's turn owns the edge from a domain to the module, as the later of the two agent-filled kinds' turns.
      expect(moduleTurn.task.relations.map((relation) => relation.kind)).toEqual(['domain.covers', 'module.depends-on', 'code.module-folder']);

      // What the graph holds: the domains with the folders they cover, and the modules with their folders.
      const graph = async (query: string) => await executeGraphql(owner, { manifest: declarations.manifest, folder: f.product }, { query });
      type Covered = { edges: { node: { node: { kind: string; path: string } } }[] };
      const domains = await graph('{ allDomain(first: 10, orderBy: [{field: name}]) { edges { node { name description domainCoversFolder(first: 10) { edges { node { node { kind ... on KindCodeDirectory { path } } } } } } } } }');
      expect(domains.status).toBe(200);
      const domainRows = (domains.body as { data: { allDomain: { edges: { node: { name: string; description: string; domainCoversFolder: Covered } }[] } } }).data.allDomain.edges.map((edge) => edge.node);
      expect(domainRows.map((node) => [node.name, node.domainCoversFolder.edges.map((held) => [held.node.node.kind, held.node.node.path])])).toEqual([['Identity', [['code.directory', 'src/identity']]], ['Orders', [['code.directory', 'src/orders']]]]);
      expect(domainRows[0]?.description).toContain('area of the product');
      type RepositoryNode = { id: string; path: string; codeDirectoryRepository: { edges: { node: { node: { name: string } } }[] } };
      const directories = await graph('{ allCodeDirectory(first: 10, where: {path: {_like: "src/%"}}) { edges { node { id path codeDirectoryRepository(first: 1) { edges { node { node { ... on KindCodeRepository { name } } } } } } } } }');
      expect(directories.status).toBe(200);
      const directoryRows = (directories.body as { data: { allCodeDirectory: { edges: { node: RepositoryNode }[] } } }).data.allCodeDirectory.edges.map((edge) => edge.node);
      const modules = await graph('{ allCodeModule(first: 10, orderBy: [{field: name}]) { edges { node { name responsibility codeModuleFolder(first: 10) { edges { node { node { id ... on KindCodeDirectory { path } } } } } } } } }');
      expect(modules.status).toBe(200);
      type ModuleFolder = { id: string; path: string };
      const moduleRows = (modules.body as { data: { allCodeModule: { edges: { node: { name: string; codeModuleFolder: { edges: { node: { node: ModuleFolder } }[] }; responsibility: string } }[] } } }).data.allCodeModule.edges.map((edge) => edge.node);
      expect(moduleRows.map((node) => [node.name, node.codeModuleFolder.edges.map((edge) => [directoryRows.find((directory) => directory.id === edge.node.node.id)?.codeDirectoryRepository.edges[0]?.node.node.name, edge.node.node.path]), node.responsibility])).toEqual([['identity', [['app', 'src/identity']], 'The module held in src/identity.'], ['orders', [['app', 'src/orders']], 'The module held in src/orders.']]);
      // Every entity names the graph file its fact rests on: the file the agent read through the server.
      const evidence = await graph('{ allDomain(first: 10, orderBy: [{field: name}]) { edges { node { name descriptionAssertions { selected evidence { locator target { kind ... on KindCodeBlob { digest } } } } } } } }');
      expect(evidence.status).toBe(200);
      const blobs = await graph('{ allCodeBlob(first: 10, where: {digest: {_in: ' + JSON.stringify(Object.entries(FILES).filter(([path]) => path.startsWith('src/')).map(([, content]) => createHash('sha256').update(content).digest('hex'))) + '}}) { edges { node { digest codeBlobAbout(first: 10) { edges { node { node { id ... on KindCodeFile { path } } } } } } } } }');
      expect(blobs.status).toBe(200);
      const files = await graph('{ allCodeFile(first: 10, where: {path: {_like: "src/%"}}) { edges { node { id path codeFileRepository(first: 1) { edges { node { node { ... on KindCodeRepository { name } } } } } } } } }');
      expect(files.status).toBe(200);
      type FileNode = { id: string; path: string; codeFileRepository: { edges: { node: { node: { name: string } } }[] } };
      const fileRows = (files.body as { data: { allCodeFile: { edges: { node: FileNode }[] } } }).data.allCodeFile.edges.map((edge) => edge.node);
      type BlobNode = { digest: string; codeBlobAbout: { edges: { node: { node: { id: string; path: string } } }[] } };
      const blobRows = (blobs.body as { data: { allCodeBlob: { edges: { node: BlobNode }[] } } }).data.allCodeBlob.edges.map((edge) => edge.node);
      type Ground = { locator: { path: string; lineStart: number; lineEnd: number }; target: { kind: string; digest: string } };
      const evidenceRows = (evidence.body as { data: { allDomain: { edges: { node: { name: string; descriptionAssertions: { selected: boolean; evidence: Ground[] }[] } }[] } } }).data.allDomain.edges.map(({ node }) => ({ name: node.name, evidence: node.descriptionAssertions.filter((assertion) => assertion.selected).flatMap((assertion) => assertion.evidence.map((ground) => ({
        kind: ground.target.kind, digest: ground.target.digest, path: ground.locator.path, lineStart: ground.locator.lineStart, lineEnd: ground.locator.lineEnd,
        files: blobRows.find((blob) => blob.digest === ground.target.digest)?.codeBlobAbout.edges.map((edge) => ({ path: edge.node.node.path, repository: fileRows.find((file) => file.id === edge.node.node.id)?.codeFileRepository.edges[0]?.node.node.name })),
      }))) }));
      expect(evidenceRows).toEqual([
        { name: 'Identity', evidence: [{ kind: 'code.blob', digest: createHash('sha256').update(FILES['src/identity/login.ts']!).digest('hex'), path: 'src/identity/login.ts', lineStart: 1, lineEnd: 2, files: [{ repository: 'app', path: 'src/identity/login.ts' }] }] },
        { name: 'Orders', evidence: [{ kind: 'code.blob', digest: createHash('sha256').update(FILES['src/orders/create-order.ts']!).digest('hex'), path: 'src/orders/create-order.ts', lineStart: 1, lineEnd: 2, files: [{ repository: 'app', path: 'src/orders/create-order.ts' }] }] },
      ]);
    } finally {
      await owner.close();
    }
  }, 180_000);

  test('a turn that reports a million cache reads spends only its input, output and cache writes, and a result past the cap is kept', async () => {
    // The owner's real run (madarch-64o5.112): Claude Code reported 1 000 639 tokens, of which almost all were cache
    // reads re-sent every step, and the finished result was thrown away. Here the same report meets a 300-token cap: the
    // domain turn spends the 460 the cap counts, its answer is kept and published, and the next unit is not prompted at
    // all — it ends with the cap's reason, once, and is not retried.
    const f = fixture();
    const declarations = readKinds(f.product);
    if (!declarations.present) return;
    const owner = await createTestDatabaseOwner({ btreeGist: true, graphContract: await readPinnedGraphContract(f.product) });
    try {
      const run = await runFill({
        product: f.product, targets: { kinds: ['domain', 'code.module'], requested: ['domain', 'code.module'] },
        tokenCap: 300, database: owner,
        prepareContract: async (contract) => { await prepareTestStore(owner, { contract }); },
        home: f.home, steps: ['plugin-turns'], workers: 1,
        unconfined: true,
        pluginAgent: { adapter: { id: 'fixture-acp', command: process.execPath, args: [f.fake, f.record] }, connect: connectAcpAgent },
      });
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      // One agent unit runs first and its result stands; the next finds the cap spent, ends with that reason once, and
      // is not retried (one attempt, where a plain failure spends three).
      const units = run.units.filter((unit) => unit.unitId.startsWith('plugin-turns/agent-fill:'));
      expect(units.map((unit) => unit.state).sort()).toEqual(['failed', 'published']);
      expect(units.find((unit) => unit.state === 'failed')?.attempts).toBe(1);
      expect(run.state).toBe('completed_partial');
      // What the first agent produced stands, with its evidence: the cap took nothing away from it.
      const entities = await executeGraphql(owner, { manifest: declarations.manifest, folder: f.product }, { query: '{ allDomain(first: 10, orderBy: [{field: name}]) { edges { node { name } } } allCodeModule(first: 10, orderBy: [{field: name}]) { edges { node { name } } } }' });
      expect(entities.status).toBe(200);
      const held = (entities.body as { data: { allDomain: { edges: { node: { name: string } }[] }; allCodeModule: { edges: { node: { name: string } }[] } } }).data;
      expect([held.allDomain.edges.map((edge) => edge.node.name), held.allCodeModule.edges.map((edge) => edge.node.name)].filter((names) => names.length > 0)).toEqual([expect.any(Array)]);
      // The run says it went over, and the unit that went over the cap says why it ended.
      const events = await readProgress(owner, run.runId);
      expect(events.some((event) => event.kind === 'unit-progress' && event.summary.includes('went over its bound after producing'))).toBe(true);
      const failed = events.find((event) => event.kind === 'unit-failed' && event.unitId === units.find((unit) => unit.state === 'failed')?.unitId);
      expect(failed?.summary).toContain('was stopped by its tokens bound and is not retried');
      expect(failed?.summary).toContain('cache reads are not counted');
      // Only one turn asked the model anything: the second unit ended before its prompt.
      const turns = readFileSync(f.record, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { task: { kind: string } });
      expect(turns.map((turn) => turn.task.kind)).toHaveLength(1);
    } finally {
      await owner.close();
    }
  }, 180_000);

  test('a malformed answer with entries that stand publishes those entries, and the run says it answered partly', async () => {
    // Owner's rule (2026-11-15): a produced result is never discarded, even incomplete — the entries the contract and
    // the graph can take are published, the rest are named with the reason, and the run says the answer was partial.
    const f = fixture();
    const declarations = readKinds(f.product);
    if (!declarations.present) return;
    const owner = await createTestDatabaseOwner({ btreeGist: true, graphContract: await readPinnedGraphContract(f.product) });
    try {
      const run = await runFill({
        product: f.product, targets: { kinds: ['domain'], requested: ['domain'] },
        tokenCap: 200_000, database: owner,
        prepareContract: async (contract) => { await prepareTestStore(owner, { contract }); },
        home: f.home, steps: ['plugin-turns'], workers: 1,
        unconfined: true,
        pluginAgent: { adapter: { id: 'fixture-acp', command: process.execPath, args: [f.fake, f.record, 'malformed'] }, connect: connectAcpAgent },
      });
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      expect(run.state).toBe('succeeded');
      // The two entries that stand are published; the three the contract or the graph cannot take are not.
      const domains = await executeGraphql(owner, { manifest: declarations.manifest, folder: f.product }, { query: '{ allDomain(first: 10, orderBy: [{field: name}]) { edges { node { name domainCoversFolder { totalCount } } } } }' });
      expect(domains.status).toBe(200);
      const domainRows = (domains.body as { data: { allDomain: { edges: { node: { name: string; domainCoversFolder: { totalCount: number } } }[] } } }).data.allDomain.edges.map((edge) => edge.node);
      expect(domainRows.map((row) => row.name)).toEqual(['Identity', 'Orders']);
      expect(domainRows.reduce((count, row) => count + row.domainCoversFolder.totalCount, 0)).toBe(2);
      // The run says the answer was partial, and names what was left out and why.
      const events = await readProgress(owner, run.runId);
      const partial = events.find((event) => event.kind === 'unit-progress' && event.summary.includes('answered partly and published what it held'));
      expect(partial?.summary).toContain('published what it held (4)');
      expect(partial?.summary).toContain('declares no field "colour"');
      expect(partial?.summary).toContain('declares no vertex kind "nonsense"');
      expect(partial?.summary).toContain('it names no declared immutable graph content and line range as its evidence');
      expect(partial?.summary).toContain('declares no edge kind "domain.links-to-nothing"');
      // The record holds the whole answer the agent gave: five vertices and three edges, of which the two that stand were kept.
      const turns = readFileSync(f.record, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { answer: { vertices: unknown[]; edges: unknown[] } });
      expect([turns[0]?.answer.vertices.length, turns[0]?.answer.edges.length]).toEqual([5, 3]);
    } finally {
      await owner.close();
    }
  }, 180_000);
});
