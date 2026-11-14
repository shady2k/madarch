import { readFolderManifestText, writeFolderManifest } from './catalog-folder-fixture.js';
/** End to end with a scripted ACP peer: one fill plans the agent for a kind's fields, runs it, and the graph carries it. */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument, stringify } from 'yaml';
import { prepareStore } from '../src/adapters/prepare-store.js';
import { connectAcpAgent } from '../src/fill/acp.js';
import { runFill } from '../src/fill/run.js';
import { generatedTableName } from '../src/graph/contract.js';
import { fillPlanView } from '../src/knowledge/fill-plan.js';
import { readTraceSpans } from '../src/obs/trace-report.js';
import { traceFiles } from '../src/obs/trace.js';
import { checkCgroupDelegation, cgroupParent } from '../src/plugin/cgroup.js';
import { sandboxSetupProblem } from '../src/plugin/sandbox.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { knowledgeRootOf, productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { executeGraphql } from '../src/graph/graphql-execute.js';
import { makeProduct } from './knowledge-fixture.js';

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const sandboxProblem = process.env['MADARCH_PLUGIN_SANDBOX'] === 'off' && process.env['MADARCH_SANDBOX_REQUIRED'] !== '1' ? undefined : checkCgroupDelegation(cgroupParent())?.message ?? (await sandboxSetupProblem({ cgroupParent: cgroupParent() }))?.message;
if (sandboxProblem !== undefined && process.env['MADARCH_SANDBOX_REQUIRED'] === '1') throw new Error(sandboxProblem);

const DECISIONS = [
  { path: 'docs/decisions/0001-choose-postgres.md', id: 'ADR-0001', title: 'Use PostgreSQL', body: 'The product stores its graph in PostgreSQL.' },
  { path: 'docs/decisions/0002-split-billing.md', id: 'ADR-0002', title: 'Split billing out', body: 'Billing becomes a service of its own.' },
];

/** A scripted ACP peer: it reads both decisions through the host's file reads and answers them with evidence. */
const FAKE = `import { createInterface } from 'node:readline';
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
let sequence = 0;
const pending = new Map();
const ask = (method, params) => new Promise((resolve) => { const id = 'fake-' + ++sequence; pending.set(id, resolve); send({ id, method, params }); });
const files = ${JSON.stringify(DECISIONS)};
createInterface({ input: process.stdin }).on('line', async (line) => {
  const m = JSON.parse(line);
  if (!m.method) { pending.get(m.id)?.(m); pending.delete(m.id); return; }
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 'decision-session', models: { currentModelId: 'fixture-model', availableModels: [{ modelId: 'fixture-model', name: 'Fixture model' }] } } });
  if (m.method === 'session/prompt') {
    const sessionId = m.params.sessionId;
    const read = [];
    for (const file of files) read.push(await ask('fs/read_text_file', { sessionId, path: '/' + 'app/' + file.path }));
    const readable = read.every((answer) => typeof answer.result?.content === 'string');
    const result = readable
      ? { vertices: files.map((file, at) => ({ kind: 'doc.decision', key: { legacy_id: file.id }, values: { title: file.title, body: file.body }, evidence: { repository: 'app', path: file.path, lineStart: 1, lineEnd: 3 } })), end: { state: 'complete' } }
      : { vertices: [], end: { state: 'partial', cause: 'a decision file could not be read: ' + JSON.stringify(read) } };
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(result) } } } });
    send({ id: m.id, result: { stopReason: 'end_turn', usage: { totalTokens: 120, inputTokens: 100, outputTokens: 20 } } });
  }
});
`;

function fixture(options: { readonly agent?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'madarch-agent-decisions-'));
  roots.push(root);
  const repository = join(root, 'app');
  mkdirSync(join(repository, 'docs/decisions'), { recursive: true });
  for (const file of DECISIONS) writeFileSync(join(repository, file.path), `# ${file.title}\n\n${file.body}\n`);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  git(repository, 'init', '-q', '-b', 'main');
  git(repository, 'add', '-A');
  git(repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'two decisions');
  const home = join(root, 'home');
  const product = makeProduct(home, 'decision-shop', repository, 'app');
  const starter = parseDocument(readFolderManifestText(product)).toJS() as Record<string, any>;
  const codeKinds = ['code.repository', 'code.directory', 'code.file', 'code.gitlink', 'code.commit', 'code.author'];
  const kinds: Record<string, unknown> = Object.fromEntries(codeKinds.map((name) => [name, starter['kinds'][name]]));
  kinds['doc.decision'] = {
    id: 'practice.decision',
    group: 'rd.decision',
    purpose: 'history',
    audience: ['developer'],
    definition: 'An architecture decision record: what was decided, why, and what follows from it.',
    sources: ['https://adr.github.io/madr/'],
    acquisition: ['document', 'conversation'],
    'relation-constraints': { out: [], in: [] },
    'template-policy': 'page',
    labels: { en: { one: 'Decision', many: 'Decisions' }, ru: { one: 'Решение', many: 'Решения' } },
    description: { en: 'An architecture decision record.', ru: 'Запись об архитектурном решении.' },
    source: 'graph',
    'derives-from': ['code.file'],
    key: ['legacy_id'],
    fields: [
      { name: 'legacy_id', type: 'text', binding: { agent: 'The decision number the record states.' } },
      { name: 'title', type: 'text', binding: { agent: 'The decision title.' } },
      { name: 'body', type: 'text', nullable: true, binding: { agent: 'What was decided and why.' } },
    ],
  };
  const names = new Set(Object.keys(kinds));
  const plugins = (starter['plugins'] as { id: string }[]).filter((plugin) => ['disk', 'git', ...(options.agent === false ? [] : ['agent-fill'])].includes(plugin.id));
  // The starter's metadata whole (its properties, purposes, roles and documents), with the fixture's kinds and plugins.
  const { kinds: _starterKinds, edges: _starterEdges, plugins: _starterPlugins, ...metadata } = starter;
  writeFolderManifest(product, stringify({
    ...metadata,
    kinds,
    edges: (starter['edges'] as { from: string[]; to: string[] }[]).filter((edge) => [...edge.from, ...edge.to].every((name) => name === 'any' || names.has(name))),
    plugins,
  }, { lineWidth: 0 }));
  writeFileSync(join(product, 'madarch', 'workflows.yaml'), 'workflows:\n  first-fill:\n    status: implemented\n    stages: [plugin-turns]\n');
  git(product, 'add', '-A');
  git(product, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'the decision product');
  const fake = join(root, 'fake-acp.ts');
  writeFileSync(fake, FAKE);
  return { root, home, product, repository, fake, starter };
}

describe.skipIf(sandboxProblem !== undefined)('the agent fills a kind the manifest leaves to it', () => {
  test('a fill of doc.decision plans agent-fill, runs it over two files, and the graph answers its evidence', async () => {
    const f = fixture();
    const declarations = readKinds(f.product);
    if (!declarations.present) throw new Error('the fixture manifest is absent');
    expect(declarations.manifest.findings).toEqual([]);
    // The plan names every producer of every field, and the agent where no deterministic producer claims it.
    const plan = fillPlanView(declarations.manifest, f.product, ['doc.decision'], ['doc.decision']);
    expect(plan.needsAgent).toEqual([{ kind: 'doc.decision', fields: ['legacy_id', 'title', 'body'] }]);
    expect(plan.kinds.find((kind) => kind.kind === 'doc.decision')?.fields).toEqual([
      { field: 'legacy_id', producers: ['agent-fill'] },
      { field: 'title', producers: ['agent-fill'] },
      { field: 'body', producers: ['agent-fill'] },
    ]);
    // A kind deterministic producers also fill keeps its own producers, and the agent only the field left to it.
    const files = fillPlanView(declarations.manifest, f.product, ['code.file'], ['code.file']);
    expect(files.kinds.find((kind) => kind.kind === 'code.file')?.fields.find((field) => field.field === 'path')?.producers).toEqual(['disk', 'git']);
    expect(files.kinds.find((kind) => kind.kind === 'code.file')?.agentFields).toEqual(['state_machines']);

    const store = productStoreFolder(f.product, knowledgeRootOf(f.home));
    const owner = await createDatabaseOwner({ store: storeDatabasePath(store), btreeGist: true });
    try {
      const run = await runFill({
        sink: (event) => { if (event.kind === 'unit-failed' || event.kind === 'unit-blocked') console.error(event.summary); },
        product: f.product, targets: { kinds: ['doc.decision'], requested: ['doc.decision'] }, tokenCap: 1000,
        database: owner, prepareContract: async (contract) => { await prepareStore(owner, { contract }); },
        home: f.home, store, steps: ['plugin-turns'], workers: 2,
        pluginAgent: { adapter: { id: 'fixture-acp', command: process.execPath, args: [f.fake] }, connect: connectAcpAgent },
      });
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      expect(run.state).toBe('succeeded');
      expect(run.units.map((unit) => unit.unitId)).toContain('plugin-turns/agent-fill:doc.decision');
      const rows = await owner.transaction('snapshot', async (tx) => await tx.query<{ legacy_id: string; title: string; evidence: { repository: string; path: string; line_start: number; line_end: number }[] }>(
        `SELECT n.key->>'legacy_id' AS legacy_id, v.title, v.evidence FROM ${generatedTableName('doc.decision', 'vertex')} v JOIN node n ON n.id = v.node_id WHERE v.state='open' ORDER BY n.key->>'legacy_id'`,
      ));
      expect(rows.rows.map((row) => [row.legacy_id, row.title])).toEqual([['ADR-0001', 'Use PostgreSQL'], ['ADR-0002', 'Split billing out']]);
      expect(rows.rows[0]?.evidence).toEqual([expect.objectContaining({ repository: 'app', path: 'docs/decisions/0001-choose-postgres.md', line_start: 1, line_end: 3 })]);
      // The run keeps what the agent spent, and the cap the press held it to.
      const usage = await owner.transaction('snapshot', async (tx) => await tx.query<{ kind: string; field: string; total_tokens: number; reported: boolean }>(
        'SELECT kind, field, total_tokens, reported FROM agent_usage WHERE run_id = $1 ORDER BY kind, field', [run.runId],
      ));
      expect(usage.rows).toEqual([{ kind: 'doc.decision', field: '', total_tokens: 120, reported: true }]);
      const trace = traceFiles(store).find((file) => file.runId === run.runId);
      if (trace === undefined) throw new Error('the run left no trace');
      const root = readTraceSpans(trace.file).find((span) => span.name === 'fill.run');
      expect(root?.attributes['madarch.tokenCap']).toBe(1000);
    } finally { await owner.close(); }

    // The same opinions answer over /graphql, with the evidence that grounds them: the one executor the route runs, over
    // the store, so the case needs no built app and no server (a test shard builds neither).
    const reader = await createDatabaseOwner({ store: storeDatabasePath(store) });
    try {
      const answer = await executeGraphql(reader, { manifest: declarations.manifest, folder: f.product }, {
        query: '{ allDocDecision(orderBy: [{ field: legacyId }]) { edges { node { legacyId title body bodyOpinions { producer evidence { repository path lineStart lineEnd } } } } } }',
      });
      expect(answer.status).toBe(200);
      const data = (answer.body as { data: any }).data;
      expect(data.allDocDecision.edges.map((edge: any) => [edge.node.legacyId, edge.node.title])).toEqual([['ADR-0001', 'Use PostgreSQL'], ['ADR-0002', 'Split billing out']]);
      const opinions = data.allDocDecision.edges[0].node.bodyOpinions;
      expect(opinions.map((opinion: any) => opinion.producer)).toEqual(['agent-fill']);
      expect(opinions[0].evidence).toEqual([{ repository: 'app', path: 'docs/decisions/0001-choose-postgres.md', lineStart: 1, lineEnd: 3 }]);
    } finally { await reader.close(); }
  }, 300_000);

  test('a product whose agent plugin is removed names the kinds and fields it leaves without a producer, and fails them', async () => {
    // The agent plugin is missing from the manifest: the fields it would fill have no producer at all, which is an error
    // naming the kind, the fields and the missing plugin — never a kind status, a badge or a filter (madarch-64o5.60).
    const f = fixture({ agent: false });
    const declarations = readKinds(f.product);
    if (!declarations.present) throw new Error('the fixture manifest is absent');
    expect(declarations.manifest.findings).toEqual([]);
    const plan = fillPlanView(declarations.manifest, f.product, ['code.directory', 'doc.decision'], ['code.directory', 'doc.decision']);
    const error = plan.errors.find((one) => one.kind === 'doc.decision');
    expect(error).toBeDefined();
    expect(error!.fields).toEqual(['body', 'legacy_id', 'title']);
    expect(error!.message).toContain('kind "doc.decision"');
    expect(error!.message).toContain('no producer');
    expect(error!.message).toContain('the agent plugin is missing from the manifest');
    expect(plan.errors.some((one) => one.kind === 'code.directory')).toBe(false);

    const store = productStoreFolder(f.product, knowledgeRootOf(f.home));
    const owner = await createDatabaseOwner({ store: storeDatabasePath(store), btreeGist: true });
    try {
      const run = await runFill({
        sink: (event) => { if (event.kind === 'unit-failed' || event.kind === 'unit-blocked') console.error(event.summary); },
        product: f.product, targets: { kinds: ['code.directory', 'doc.decision'], requested: ['code.directory', 'doc.decision'] },
        database: owner, prepareContract: async (contract) => { await prepareStore(owner, { contract }); },
        home: f.home, store, steps: ['plugin-turns'], workers: 2,
      });
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      // The kind nothing produces fails with the plan's error; the kind that has a producer runs.
      expect(run.state).toBe('completed_partial');
      const failed = run.units.find((unit) => unit.unitId === 'plugin-turns/missing:doc.decision');
      expect(failed?.state).toBe('failed');
      expect(run.units.find((unit) => unit.unitId === 'plugin-turns/disk:code.directory')?.state).toBe('published');
      const { readProgress } = await import('../src/fill/orchestrator-store.js');
      const events = await readProgress(owner, run.runId);
      expect(events.some((event) => event.kind === 'unit-failed' && event.unitId === 'plugin-turns/missing:doc.decision' && event.summary.includes('the agent plugin is missing from the manifest'))).toBe(true);
    } finally { await owner.close(); }
  }, 300_000);
});
