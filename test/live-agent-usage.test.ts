/**
 * The run page's token figure while a fill is active (madarch-rcyu, ALX-1936): an agent spends as it streams its turn,
 * and the meter charges that text's tokens to the unit's row and to the run's cap — the run page read the turn's answer
 * alone, so a fill whose adapter reports its usage only at the end (or not at all) showed zero tokens while its work ran
 * (owner's walk: 9/12 units and 0 tokens). The case drives one fill through the regular adapter boundary with a fixture
 * ACP peer that streams a known text, reports no token usage of its own, and holds its next turn until this case releases
 * it: while the fill is still active, the product's own run read states the tokens the meter charged.
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
import { connectAcpAgent } from '../src/fill/acp.js';
import { runFill } from '../src/fill/run.js';
import { fillPlanView } from '../src/knowledge/fill-plan.js';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { kindClosure } from '../src/knowledge/starter-templates.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { knowledgeRootOf, productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { readFolderManifestText, writeFolderManifest } from './catalog-folder-fixture.js';
import { makeProduct } from './knowledge-fixture.js';

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const DECISIONS = [
  { path: 'docs/decisions/0001-choose-postgres.md', id: 'ADR-0001', title: 'Use PostgreSQL', body: 'The product stores its graph in PostgreSQL.' },
  { path: 'docs/decisions/0002-split-billing.md', id: 'ADR-0002', title: 'Split billing out', body: 'Billing becomes a service of its own.' },
];

/** The answer one decision turn gives: a complete result that asserts nothing, so the fill goes on. */
const ANSWER = '{"vertices":[],"end":{"state":"complete"}}';
/** The thought the peer streams before its answer: 400 code points, which the meter charges as text spends. */
const THOUGHT = 'x'.repeat(400);
/**
 * What the meter charges for one turn that reports no usage: four code points a token (owner's decision, 2026-11-15),
 * so the thought's 400 code points are 100 tokens and the answer's 42 code points are 11 more.
 */
const TURN_TOKENS = 111;

/** A scripted ACP peer: it streams a known text and holds every turn but its first until the release file exists. */
const FAKE = `import { createInterface } from 'node:readline';
import { appendFileSync, existsSync } from 'node:fs';
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
let prompts = 0;
createInterface({ input: process.stdin }).on('line', async (line) => {
  const m = JSON.parse(line);
  if (!m.method) return;
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true, sse: true } } } });
  if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 'live-session', models: { currentModelId: 'fixture-model', availableModels: [{ modelId: 'fixture-model', name: 'Fixture model' }] } } });
  if (m.method === 'session/prompt') {
    prompts += 1;
    appendFileSync(${JSON.stringify('PLACEHOLDER/prompts.log')}, 'prompt ' + prompts + '\\n');
    const sessionId = m.params.sessionId;
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: ${JSON.stringify(THOUGHT)} } } } });
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ${JSON.stringify(ANSWER)} } } } });
    if (prompts > 1) {
      // The fill stays active here until the case has read the page: no answer, no usage report, only waiting.
      for (;;) { if (existsSync(${JSON.stringify('PLACEHOLDER/release')})) break; await new Promise((rest) => setTimeout(rest, 25)); }
    }
    send({ id: m.id, result: { stopReason: 'end_turn' } });
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
  // A second agent-filled kind: two agent units, so one turn ends and the next is held while the page is read.
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
  const release = join(root, 'release');
  const prompts = join(root, 'prompts.log');
  const fake = join(root, 'fake-acp.ts');
  writeFileSync(fake, FAKE.replace('PLACEHOLDER/release', release).replace('PLACEHOLDER/prompts.log', prompts));
  return { root, home, product, repository, fake, release, prompts };
}

test('the run page states the tokens a live turn spent, not zero, while the fill is active', async () => {
  const f = fixture();
  const declarations = readKinds(f.product);
  if (!declarations.present) throw new Error('the fixture manifest is absent');
  expect(declarations.manifest.findings).toEqual([]);
  // The plan leaves every field of the two kinds to the agent: two agent units, and the second turn is what this case
  // reads the page during.
  expect(fillPlanView(declarations.manifest, f.product, ['doc.decision', 'doc.term'], ['doc.decision', 'doc.term']).needsAgent)
    .toEqual([{ kind: 'doc.decision', fields: ['legacy_id', 'title', 'body'] }, { kind: 'doc.term', fields: ['legacy_id', 'definition'] }]);
  const storeRoot = knowledgeRootOf(f.home);
  const store = productStoreFolder(f.product, storeRoot);
  const owner = await createDatabaseOwner({ store: storeDatabasePath(store), btreeGist: true });
  const runId = 'fill-live-usage';
  try {
    const running = runFill({
      product: f.product, targets: { kinds: ['doc.decision', 'doc.term'], requested: ['doc.decision', 'doc.term'] }, tokenCap: 100_000, runId,
      database: owner, prepareContract: async (contract) => { await prepareStore(owner, { contract }); },
      home: f.home, store, steps: ['plugin-turns'], workers: 2, unconfined: true,
      pluginAgent: { adapter: { id: 'fixture-acp', command: process.execPath, args: [f.fake] }, connect: connectAcpAgent },
    });
    // The product's own run read as the api role composes it: `fillRuns` over the store and the run's trace, with the
    // owner and the product's identity the server would hand it (`test/fill-runs.test.ts` stubs the same two).
    const page = Object.create(KnowledgeProduct.prototype) as KnowledgeProduct;
    Object.assign(page, { open: async () => owner, product: () => ({ name: 'live-shop' }), options: { productFolder: f.product, storeRoot } });
    const prompts = (): number => existsSync(f.prompts) ? readFileSync(f.prompts, 'utf8').trim().split('\n').filter(Boolean).length : 0;
    // The wait is for the peer's second turn: its first ended, and this one is held, so the run is active.
    const start = Date.now();
    while (Date.now() - start < 180_000 && prompts() < 2) await Bun.sleep(100);
    if (prompts() < 2) {
      const [held] = await page.fillRuns(runId);
      throw new Error(`the peer took ${String(prompts())} prompt(s); the run is ${JSON.stringify({ state: held?.state, units: held?.units.map((unit) => unit.status) })}`);
    }
    const [live] = await page.fillRuns(runId);
    expect(live).toBeDefined();
    expect({ state: live!.state, final: live!.final }).toEqual({ state: 'running', final: false });
    // The turns the peer has ended so far (the held one has ended none), each charged its streamed text: the product's
    // own run read states that spend, and it is not zero while the fill is under way.
    const turns = live!.agentUsage!.turns;
    expect(turns).toBeGreaterThan(0);
    expect(live!.agentUsage).toMatchObject({ outputTokens: 0, cachedWriteTokens: 0, cachedReadTokens: 0, totalTokens: TURN_TOKENS * turns });
    expect(live!.agentUsage!.lines.length).toBeGreaterThan(0);
    // The store's rows carry the same figure: the page, the cap and the rows count one spend.
    const rows = await owner.transaction('snapshot', async (tx) => await tx.query<{ input_tokens: number; total_tokens: number; reported: boolean }>(
      'SELECT input_tokens, total_tokens, reported FROM agent_usage WHERE run_id = $1 ORDER BY unit', [runId]));
    expect(rows.rows.reduce((sum, row) => sum + row.input_tokens, 0)).toBe(TURN_TOKENS * turns);
    expect(rows.rows.reduce((sum, row) => sum + row.total_tokens, 0)).toBe(TURN_TOKENS * turns);
    expect(rows.rows.every((row) => row.reported === false)).toBe(true);
    writeFileSync(f.release, 'release\n');
    const result = await running;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.state).toBe('succeeded');
  } finally {
    await owner.close();
  }
}, 300_000);
