/**
 * The run page's token figure while a fill is active (madarch-rcyu, ALX-1936; review ALX-2032): an agent spends as it
 * streams its turn, and the meter charges that text's tokens to the unit's row and to the run's cap — the run page read
 * the turn's answer alone, so a fill whose adapter reports its usage only at the end (or not at all) showed zero tokens
 * while its work ran (owner's walk: 9/12 units and 0 tokens).
 *
 * The cases drive one fill through the regular adapter boundary with a fixture ACP peer, and read the product's own run
 * answer over HTTP, as the api role serves it (`GET /api/fill-runs?run=…`): the figure the store's row and the run's cap
 * hold must be the figure the answer states, whatever the adapter reports and whenever it reports it.
 *
 * The peer holds one named unit deterministically: it writes its readiness file only once it has streamed its text and
 * stands at the barrier, and waits for that unit's release file, which the case writes after its assertion and in its
 * cleanup. Nothing here is timed by the scheduler: the case reads the answer of a turn the peer has not answered.
 *
 * No model is called: the peer is a repository-owned script that speaks the protocol on its own streams.
 */
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument, stringify } from 'yaml';
import { prepareStore } from '../src/adapters/prepare-store.js';
import { createDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { connectAcpAgent } from '../src/fill/acp.js';
import { runFill } from '../src/fill/run.js';
import { fillPlanView } from '../src/knowledge/fill-plan.js';
import { kindClosure } from '../src/knowledge/starter-templates.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { knowledgeRootOf, productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import type { StartedServer } from '../src/server/http.js';
import { readFolderManifestText, writeFolderManifest } from './catalog-folder-fixture.js';
import { makeProduct } from './knowledge-fixture.js';
import { startPreparedServer } from './prepared-server.js';

const roots: string[] = [];
const servers: StartedServer[] = [];
afterAll(async () => {
  for (const server of servers.splice(0)) await server.stop().catch(() => undefined);
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const DECISIONS = [
  { path: 'docs/decisions/0001-choose-postgres.md', id: 'ADR-0001', title: 'Use PostgreSQL', body: 'The product stores its graph in PostgreSQL.' },
  { path: 'docs/decisions/0002-split-billing.md', id: 'ADR-0002', title: 'Split billing out', body: 'Billing becomes a service of its own.' },
];

/** The answer one decision turn gives: a complete result that asserts nothing, so the fill goes on. */
const ANSWER = '{"vertices":[],"end":{"state":"complete"}}';
/** The thought the peer streams before it stands at its barrier: 400 code points, four a token. */
const THOUGHT = 'x'.repeat(400);
/** What the meter charges for the thought: four code points a token (owner's decision, 2026-11-15). */
const THOUGHT_TOKENS = 100;
/**
 * The unit the peer holds at its barrier, and the unit that answers with a usage report of its own. The plan runs the
 * agent units one after the other in the order of the selection, so the reporting unit answers first and the held one
 * keeps the fill open behind it.
 */
const HELD = 'doc.term';
const REPORTING = 'doc.decision';
/** What the reporting adapter says its turn spent, in every category the protocol carries. */
const REPORT = { inputTokens: 120, outputTokens: 20, cachedWriteTokens: 14, cachedReadTokens: 60, totalTokens: 214 };

/**
 * A scripted ACP peer: it streams the same known thought for every turn, reports nothing for the held kind, reports
 * `REPORT` for the other, and stands at its barrier for the held kind until that unit's release file exists — writing
 * its readiness file, named by the unit's kind, only once it stands there.
 */
const FAKE = `import { createInterface } from 'node:readline';
import { existsSync, writeFileSync } from 'node:fs';
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
createInterface({ input: process.stdin }).on('line', async (line) => {
  const m = JSON.parse(line);
  if (!m.method) return;
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true, sse: true } } } });
  if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 'live-session', models: { currentModelId: 'fixture-model', availableModels: [{ modelId: 'fixture-model', name: 'Fixture model' }] } } });
  if (m.method === 'session/prompt') {
    const sessionId = m.params.sessionId;
    const said = String((m.params.prompt ?? [{ text: '' }])[0]?.text ?? '');
    const at = said.lastIndexOf('Task: ');
    const task = at < 0 ? {} : JSON.parse(said.slice(at + 6).split('\\n')[0] ?? '{}');
    const kind = String(task.kind ?? 'none');
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: ${JSON.stringify(THOUGHT)} } } } });
    if (kind === ${JSON.stringify(HELD)}) {
      // The barrier: the text is streamed and charged, and this unit answers nothing until the case releases it.
      writeFileSync(${JSON.stringify('PLACEHOLDER/ready.')} + kind, 'ready ' + String(process.pid) + ' ' + kind + '\\n');
      for (;;) { if (existsSync(${JSON.stringify('PLACEHOLDER/release.')} + kind)) break; await new Promise((rest) => setTimeout(rest, 25)); }
      send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ${JSON.stringify(ANSWER)} } } } });
      send({ id: m.id, result: { stopReason: 'end_turn' } });
    } else {
      send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ${JSON.stringify(ANSWER)} } } } });
      send({ id: m.id, result: { stopReason: 'end_turn', usage: ${JSON.stringify(REPORT)} } });
    }
  }
});
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'madarch-live-usage-'));
  roots.push(root);
  const repository = join(root, 'app');
  mkdirSync(join(repository, 'docs/decisions'), { recursive: true });
  for (const file of DECISIONS) writeFileSync(join(repository, file.path), `# ${file.title}\n\n${file.body}\n`);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  git(repository, 'init', '-q', '-b', 'main');
  git(repository, 'add', '-A');
  git(repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'two decisions');
  const home = join(root, 'home');
  const product = makeProduct(home, 'live-shop', repository, 'app');
  const starter = parseDocument(readFolderManifestText(product)).toJS() as Record<string, any>;
  const selectedKinds = ['code.repository', 'code.directory', 'code.file', 'code.blob', 'code.gitlink', 'code.commit', 'code.author'];
  // The kinds the selected ones rest on, from the same closure a template uses (as the agent fill's own case does it).
  const codeKinds = [...kindClosure(selectedKinds, (name) => starter['kinds'][name]?.['derives-from'])]
    .filter((name) => starter['kinds'][name] !== undefined);
  const kinds: Record<string, unknown> = Object.fromEntries(codeKinds.map((name) => [name, starter['kinds'][name]]));
  kinds['doc.decision'] = {
    id: 'practice.decision', group: 'rd.decision', purpose: 'history', audience: ['developer'],
    definition: 'An architecture decision record: what was decided, why, and what follows from it.',
    sources: ['https://adr.github.io/madr/'], acquisition: ['document', 'conversation'],
    'relation-constraints': { out: [], in: [] }, 'template-policy': 'page',
    labels: { en: { one: 'Decision', many: 'Decisions' }, ru: { one: 'Решение', many: 'Решения' } },
    description: { en: 'An architecture decision record.', ru: 'Запись об архитектурном решении.' },
    source: 'graph', 'derives-from': ['code.file'], key: ['legacy_id'],
    fields: [
      { name: 'legacy_id', type: 'text', binding: { agent: 'The decision number the record states.' } },
      { name: 'title', type: 'text', binding: { agent: 'The decision title.' } },
      { name: 'body', type: 'text', nullable: true, binding: { agent: 'What was decided and why.' } },
    ],
  };
  // A second agent-filled kind: two agent units, so one can be held while the other answers.
  kinds['doc.term'] = {
    id: 'practice.term', group: 'rd.decision', purpose: 'history', audience: ['developer'],
    definition: 'A term the documents define.', sources: ['https://adr.github.io/madr/'], acquisition: ['document'],
    'relation-constraints': { out: [], in: [] }, 'template-policy': 'page',
    labels: { en: { one: 'Term', many: 'Terms' }, ru: { one: 'Термин', many: 'Термины' } },
    description: { en: 'A defined term.', ru: 'Определённый термин.' },
    source: 'graph', 'derives-from': ['code.file'], key: ['legacy_id'],
    fields: [
      { name: 'legacy_id', type: 'text', binding: { agent: 'The term the record defines.' } },
      { name: 'definition', type: 'text', nullable: true, binding: { agent: 'What the documents say the term means.' } },
    ],
  };
  const names = new Set([...Object.keys(kinds), 'system.product']);
  const plugins = (starter['plugins'] as { id: string }[]).filter((plugin) => ['disk', 'git', 'agent-fill'].includes(plugin.id));
  const semanticRoles = ['repository', 'directory', 'file', 'source', 'author', 'commit', 'evidence-support'];
  const semanticBindings = Object.fromEntries(semanticRoles.map((role) => [role, starter['semantic-bindings'][role]]));
  const { kinds: _kinds, edges: _edges, plugins: _plugins, 'semantic-bindings': _bindings, ...metadata } = starter;
  void _kinds; void _edges; void _plugins; void _bindings;
  writeFolderManifest(product, stringify({
    ...metadata, 'semantic-bindings': semanticBindings, kinds,
    edges: (starter['edges'] as { from: string[]; to: string[] }[]).filter((edge) => [...edge.from, ...edge.to].every((name) => name === 'any' || names.has(name))),
    plugins,
  }, { lineWidth: 0 }));
  writeFileSync(join(product, 'madarch', 'workflows.yaml'), 'workflows:\n  first-fill:\n    status: implemented\n    stages: [plugin-turns]\n');
  git(product, 'add', '-A');
  git(product, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'the decision product');
  const ready = join(root, 'ready');
  const release = join(root, 'release');
  const fake = join(root, 'fake-acp.ts');
  writeFileSync(fake, FAKE.replace('PLACEHOLDER/ready', ready).replace('PLACEHOLDER/release', release));
  const serverApp = join(root, 'wiki');
  mkdirSync(serverApp, { recursive: true });
  writeFileSync(join(serverApp, 'index.html'), '<!doctype html><title>wiki</title>\n');
  return { root, home, product, repository, fake, ready, release, serverApp };
}

/** The readiness of one held unit: the peer wrote it, and it names the process that wrote it. */
const readyFile = (f: ReturnType<typeof fixture>, kind: string): string => `${f.ready}.${kind}`;
/** That unit's release: the case writes it after its assertion, and in its cleanup. */
const releaseFile = (f: ReturnType<typeof fixture>, kind: string): string => `${f.release}.${kind}`;

/** Waits for a file a fixture process writes, up to a bound; a machine's speed changes only how long this takes. */
async function waitForFile(file: string, ms: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (existsSync(file)) return;
    await Bun.sleep(50);
  }
  throw new Error(`${import.meta.path}:1: the fixture peer did not write ${file} within ${String(ms)} ms`);
}

/** The run as the product's own API states it: the route the run page reads (`GET /api/fill-runs?run=…`). */
async function runAnswer(server: StartedServer, product: string, runId: string): Promise<{
  run: {
    state: string; final: boolean;
    units: { unitId: string; status: string; phase: string }[];
    agentUsage: { lines: { kind: string; field: string; model: string; inputTokens: number; outputTokens: number; cachedWriteTokens: number; cachedReadTokens: number; totalTokens: number; turns: number }[]; inputTokens: number; outputTokens: number; cachedWriteTokens: number; cachedReadTokens: number; totalTokens: number; turns: number };
  };
}> {
  const answer = await fetch(`${server.url}/products/${encodeURIComponent(product)}/api/fill-runs?run=${encodeURIComponent(runId)}`, { headers: { accept: 'application/json' } });
  if (answer.status !== 200) throw new Error(`${import.meta.path}:1: GET /api/fill-runs?run=${runId} answered ${String(answer.status)}: ${await answer.text()}`);
  return await answer.json() as never;
}

/** One fill of the two agent kinds, its server and its owner; the case releases the held unit in its own cleanup. */
async function started(): Promise<{
  f: ReturnType<typeof fixture>;
  server: StartedServer;
  owner: DatabaseOwner;
  running: ReturnType<typeof runFill>;
  release: () => void;
}> {
  const f = fixture();
  const declarations = readKinds(f.product);
  if (!declarations.present) throw new Error('the fixture manifest is absent');
  expect(declarations.manifest.findings).toEqual([]);
  // The plan leaves every field of the two kinds to the agent: two agent units, each a process of its own.
  expect(fillPlanView(declarations.manifest, f.product, ['doc.decision', 'doc.term'], ['doc.decision', 'doc.term']).needsAgent)
    .toEqual([{ kind: 'doc.decision', fields: ['legacy_id', 'title', 'body'] }, { kind: 'doc.term', fields: ['legacy_id', 'definition'] }]);
  const storeRoot = knowledgeRootOf(f.home);
  const store = productStoreFolder(f.product, storeRoot);
  const owner = await createDatabaseOwner({ store: storeDatabasePath(store), btreeGist: true });
  // The api role reads the store the fill writes: one server for this product, serving the product's own run answer.
  const server = await startPreparedServer({ productHome: f.home, appFolder: f.serverApp, port: 0, log: () => undefined, errorLog: () => undefined, knowledgeRoot: storeRoot });
  servers.push(server);
  const runId = 'fill-live-usage';
  const running = runFill({
    product: f.product, targets: { kinds: ['doc.decision', 'doc.term'], requested: ['doc.decision', 'doc.term'] }, tokenCap: 100_000, runId,
    database: owner, prepareContract: async (contract) => { await prepareStore(owner, { contract }); },
    home: f.home, store, steps: ['plugin-turns'], workers: 2, unconfined: true,
    pluginAgent: { adapter: { id: 'fixture-acp', command: process.execPath, args: [f.fake] }, connect: connectAcpAgent },
  });
  return { f, server, owner, running, release: () => { for (const kind of [HELD, REPORTING]) writeFileSync(releaseFile(f, kind), 'release\n'); } };
}

test('a first turn that streams and stays open states its estimate over the API before it answers', async () => {
  const startedFill = await started();
  const { f, server, owner, running } = startedFill;
  try {
    // The peer stands at the barrier only after it streamed its text: the case reads the answer of a turn with none.
    await waitForFile(readyFile(f, HELD), 180_000);
    const ready = readFileSync(readyFile(f, HELD), 'utf8');
    expect(ready).toContain(` ${HELD}`);
    const { run } = await runAnswer(server, 'live-shop', 'fill-live-usage');
    expect({ state: run.state, final: run.final }).toEqual({ state: 'running', final: false });
    // The unit the peer holds is the one the answer states as running: the readiness file names its process, and that
    // process is the one this unit's turn is in.
    const held = run.units.find((unit) => unit.unitId.includes(HELD));
    expect(held?.status).toBe('running');
    expect(held?.phase).toBe('running');
    // The estimate the stream already charged — the run's cap holds it — is the figure the answer states, not zero, and
    // the turn that stands at the barrier counts no turn yet.
    const line = run.agentUsage.lines.find((one) => one.kind === HELD);
    expect(line).toEqual(expect.objectContaining({ kind: HELD, inputTokens: THOUGHT_TOKENS, outputTokens: 0, cachedWriteTokens: 0, cachedReadTokens: 0, totalTokens: THOUGHT_TOKENS }));
    expect(line?.turns).toBe(0);
    expect(run.agentUsage.totalTokens).toBeGreaterThanOrEqual(THOUGHT_TOKENS);
  } finally {
    startedFill.release();
    await running.catch(() => undefined);
    await owner.close();
  }
}, 300_000);

test('a turn that reports its usage states that reported spend over the API while the fill is open', async () => {
  const startedFill = await started();
  const { f, server, owner, running } = startedFill;
  try {
    await waitForFile(readyFile(f, HELD), 180_000);
    // Waits until the answer states both: the unit that answered with its report, published, and the held unit's
    // streamed estimate — the trace is flushed as it grows, so the answer lags the stream by one flush, never more.
    const start = Date.now();
    let answer = await runAnswer(server, 'live-shop', 'fill-live-usage');
    while (Date.now() - start < 180_000) {
      const reported = answer.run.units.some((unit) => unit.unitId.includes(REPORTING) && unit.status === 'published');
      const streaming = answer.run.agentUsage.lines.some((one) => one.kind === HELD);
      if (reported && streaming) break;
      await Bun.sleep(100);
      answer = await runAnswer(server, 'live-shop', 'fill-live-usage');
    }
    const run = answer.run;
    expect({ state: run.state, final: run.final }).toEqual({ state: 'running', final: false });
    // The turn's own report stands exactly once: its streamed estimate was reconciled by the report, never added to it,
    // and every cache category is kept beside the tokens a cap counts.
    const line = run.agentUsage.lines.find((one) => one.kind === REPORTING);
    expect(line).toEqual(expect.objectContaining({ kind: REPORTING, ...REPORT, turns: 1 }));
    // The run's own totals count both units: the reported turn and the estimate of the one still open.
    expect(run.agentUsage.inputTokens).toBe(REPORT.inputTokens + THOUGHT_TOKENS);
    expect(run.agentUsage.outputTokens).toBe(REPORT.outputTokens);
    expect(run.agentUsage.cachedWriteTokens).toBe(REPORT.cachedWriteTokens);
    expect(run.agentUsage.cachedReadTokens).toBe(REPORT.cachedReadTokens);
    expect(run.agentUsage.totalTokens).toBe(REPORT.totalTokens + THOUGHT_TOKENS);
  } finally {
    startedFill.release();
    const result = await running.catch(() => undefined);
    expect(result?.ok).toBe(true);
    await owner.close();
  }
}, 300_000);
