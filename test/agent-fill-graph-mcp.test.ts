/**
 * The agent fill reads the graph through madarch's own MCP server (owner's decision, 2026-11-15): the task it is given is
 * the kind it fills and what that kind means, nothing of the graph stands in the prompt, and the agent's tool calls read
 * the folders, the files and their text from the graph. A scripted ACP agent stands in for the model: it speaks the
 * protocol, it calls the session's server, and it answers from what it read.
 *
 * The plugin runs unconfined here (`MADARCH_PLUGIN_SANDBOX=off`): a sandboxed plugin has no network namespace of its
 * own, and an agent's model is reached over the network too, so a fill with an agent runs unconfined today (madarch-64o5.110
 * gives the agent session its own environment).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareStore } from '../src/adapters/prepare-store.js';
import { connectAcpAgent } from '../src/fill/acp.js';
import { runFill } from '../src/fill/run.js';
import { executeGraphql } from '../src/graph/graphql-execute.js';
import { byCodePoint } from '../src/model/order.js';
import { generatedTableName } from '../src/graph/contract.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { createTestDatabaseOwner } from './test-database.js';
import { makeProduct } from './knowledge-fixture.js';

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
    const folders = await tool('graph_query', { query: '{ allCodeDirectory(where: {repository: {_eq: "app"}, path: {_like: "src/%"}}, orderBy: [{field: path}]) { edges { node { repository path } } } }' });
    const files = await tool('graph_query', { query: '{ allCodeFile(where: {repository: {_eq: "app"}}, orderBy: [{field: path}]) { edges { node { repository path lines } } } }' });
    const fileNodes = files.data.allCodeFile.edges.map((edge) => edge.node);
    const first = fileNodes.find((node) => node.path.endsWith('create-order.ts')) ?? fileNodes[0];
    const content = await tool('graph_text', { kind: 'code.file', key: { repository: first.repository, path: first.path }, field: 'content', lineStart: 1, lineEnd: Math.min(3, first.lines) });
    // What the agent found: one folder per area of the code, its first file as the evidence of each entity.
    const areas = folders.data.allCodeDirectory.edges.map((edge) => edge.node).filter((node) => /^src\\/[^/]+$/.test(node.path));
    const evidenceOf = (area) => {
      const held = fileNodes.find((node) => node.path.startsWith(area.path + '/'));
      return { repository: area.repository, path: held.path, lineStart: 1, lineEnd: Math.min(2, held.lines) };
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
      values: { folder: { kind: 'code.directory', key: { repository: area.repository, path: area.path } }, responsibility: 'The module held in ' + area.path + '.' },
      evidence: evidenceOf(area),
    }));
    const edges = domains.map((domain) => ({
      kind: 'domain.covers-folder',
      from: { kind: 'domain', key: domain.key },
      to: { kind: 'code.directory', key: { repository: areas.find((area) => capitalised(area.path.split('/').pop()) === domain.key.name).repository, path: areas.find((area) => capitalised(area.path.split('/').pop()) === domain.key.name).path } },
      evidence: domain.evidence,
    }));
    answer = task.kind === 'domain'
      ? { vertices: domains, edges, end: { state: 'complete' } }
      : { vertices: modules, edges: [], end: { state: 'complete' } };
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
  git(product, 'add', '-A');
  git(product, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'the product');
  const fake = join(root, 'fake-acp.ts');
  writeFileSync(fake, FAKE);
  return { root, home, product, fake, record: join(root, 'turns.jsonl') };
}

describe('the agent fill reads the graph through madarch\'s MCP server', () => {
  test('domain and code.module are filled from the graph, the task is the kind and no path, and the agent reads with tools', async () => {
    const f = fixture();
    const declarations = readKinds(f.product);
    expect(declarations.present).toBe(true);
    if (!declarations.present) return;
    expect(declarations.manifest.findings).toEqual([]);
    const previous = process.env['MADARCH_PLUGIN_SANDBOX'];
    process.env['MADARCH_PLUGIN_SANDBOX'] = 'off';
    const owner = await createTestDatabaseOwner({ btreeGist: true, graphContract: await readPinnedGraphContract(f.product) });
    try {
      const run = await runFill({
        sink: (event) => { if (event.kind === 'unit-failed' || event.kind === 'unit-blocked') console.error(event.summary); },
        product: f.product, targets: { kinds: ['domain', 'code.module'], requested: ['domain', 'code.module'] },
        tokenCap: 200_000, database: owner,
        prepareContract: async (contract) => { await prepareStore(owner, { contract }); },
        home: f.home, steps: ['plugin-turns'], workers: 2,
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
      expect(moduleTurn.task.fields.map((field) => field.name)).toEqual(['name', 'folder', 'responsibility']);
      // The module's turn owns the edge from a domain to the module, as the later of the two agent-filled kinds' turns.
      expect(moduleTurn.task.relations.map((relation) => relation.kind)).toEqual(['domain.covers', 'module.depends-on']);

      // What the graph holds: the domains with the folders they cover, and the modules with their folders.
      const graph = async (query: string) => await executeGraphql(owner, { manifest: declarations.manifest, folder: f.product }, { query });
      type Covered = { edges: { node: { node: { kind: string; path: string } } }[] };
      const domains = await graph('{ allDomain(orderBy: [{field: name}]) { edges { node { name description domainCoversFolder(first: 10) { edges { node { node { kind ... on CodeDirectory { path } } } } } } } } }');
      expect(domains.status).toBe(200);
      const domainRows = (domains.body as { data: { allDomain: { edges: { node: { name: string; description: string; domainCoversFolder: Covered } }[] } } }).data.allDomain.edges.map((edge) => edge.node);
      expect(domainRows.map((node) => [node.name, node.domainCoversFolder.edges.map((held) => [held.node.node.kind, held.node.node.path])])).toEqual([['Identity', [['code.directory', 'src/identity']]], ['Orders', [['code.directory', 'src/orders']]]]);
      expect(domainRows[0]?.description).toContain('area of the product');
      const modules = await graph('{ allCodeModule(orderBy: [{field: name}]) { edges { node { name responsibility folder { repository path } } } } }');
      expect(modules.status).toBe(200);
      const moduleRows = (modules.body as { data: { allCodeModule: { edges: { node: { name: string; folder: { repository: string; path: string }; responsibility: string } }[] } } }).data.allCodeModule.edges.map((edge) => edge.node);
      expect(moduleRows.map((node) => [node.name, node.folder.path, node.responsibility])).toEqual([['identity', 'src/identity', 'The module held in src/identity.'], ['orders', 'src/orders', 'The module held in src/orders.']]);
      // Every entity names the graph file its fact rests on: the file the agent read through the server.
      const evidence = await owner.transaction('snapshot', async (tx) => await tx.query<{ name: string; evidence: { repository: string; path: string; line_start: number; line_end: number }[] }>(
        `SELECT n.key->>'name' AS name, v.evidence FROM ${generatedTableName('domain', 'vertex')} v JOIN node n ON n.id = v.node_id WHERE v.state = 'open' ORDER BY name`));
      expect(evidence.rows).toEqual([
        { name: 'Identity', evidence: [expect.objectContaining({ repository: 'app', path: 'src/identity/login.ts', line_start: 1, line_end: 2 })] },
        { name: 'Orders', evidence: [expect.objectContaining({ repository: 'app', path: 'src/orders/create-order.ts', line_start: 1, line_end: 2 })] },
      ]);
    } finally {
      await owner.close();
      if (previous === undefined) delete process.env['MADARCH_PLUGIN_SANDBOX'];
      else process.env['MADARCH_PLUGIN_SANDBOX'] = previous;
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
    const previous = process.env['MADARCH_PLUGIN_SANDBOX'];
    process.env['MADARCH_PLUGIN_SANDBOX'] = 'off';
    const owner = await createTestDatabaseOwner({ btreeGist: true, graphContract: await readPinnedGraphContract(f.product) });
    try {
      const run = await runFill({
        product: f.product, targets: { kinds: ['domain', 'code.module'], requested: ['domain', 'code.module'] },
        tokenCap: 300, database: owner,
        prepareContract: async (contract) => { await prepareStore(owner, { contract }); },
        home: f.home, steps: ['plugin-turns'], workers: 1,
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
      const domains = await owner.transaction('snapshot', async (tx) => await tx.query<{ name: string }>(`SELECT n.key->>'name' AS name FROM ${generatedTableName('domain', 'vertex')} v JOIN node n ON n.id = v.node_id WHERE v.state = 'open' ORDER BY name`));
      const modules = await owner.transaction('snapshot', async (tx) => await tx.query<{ name: string }>(`SELECT n.key->>'name' AS name FROM ${generatedTableName('code.module', 'vertex')} v JOIN node n ON n.id = v.node_id WHERE v.state = 'open' ORDER BY name`));
      expect([domains.rows.map((row) => row.name), modules.rows.map((row) => row.name)].filter((held) => held.length > 0)).toEqual([expect.any(Array)]);
      // The run says it went over, and the unit that went over the cap says why it ended.
      const events = await owner.transaction('snapshot', async (tx) => await tx.query<{ kind: string; unit_id: string; summary: string }>('SELECT kind, unit_id, summary FROM fill_event ORDER BY seq'));
      expect(events.rows.some((event) => event.kind === 'unit-progress' && event.summary.includes('went over its bound after producing'))).toBe(true);
      const failed = events.rows.find((event) => event.kind === 'unit-failed' && event.unit_id === units.find((unit) => unit.state === 'failed')?.unitId);
      expect(failed?.summary).toContain('was stopped by its tokens bound and is not retried');
      expect(failed?.summary).toContain('cache reads are not counted');
      // Only one turn asked the model anything: the second unit ended before its prompt.
      const turns = readFileSync(f.record, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { task: { kind: string } });
      expect(turns.map((turn) => turn.task.kind)).toHaveLength(1);
    } finally {
      await owner.close();
      if (previous === undefined) delete process.env['MADARCH_PLUGIN_SANDBOX'];
      else process.env['MADARCH_PLUGIN_SANDBOX'] = previous;
    }
  }, 180_000);
});
