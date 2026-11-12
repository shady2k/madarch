/** Real sandboxed plugin turns and a fake ACP peer: no model, adapter install or credentials. */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectAcpAgent } from '../src/fill/acp.js';
import type { PluginAgentReport } from '../src/plugin/agent.js';
import { parseDocument } from 'yaml';
import { readKinds } from '../src/product/manifest/kinds.js';
import { runFill } from '../src/fill/run.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { prepareStore } from '../src/adapters/prepare-store.js';
import { generatedTableName } from '../src/graph/contract.js';
import { closureOf } from '../src/plugin/closure.js';
import { checkCgroupDelegation, cgroupParent } from '../src/plugin/cgroup.js';
import { sandboxSetupProblem } from '../src/plugin/sandbox.js';
import { createTestDatabaseOwner } from './test-database.js';
import { makeProduct } from './knowledge-fixture.js';

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const sandboxProblem = checkCgroupDelegation(cgroupParent())?.message ?? (await sandboxSetupProblem({ cgroupParent: cgroupParent() }))?.message;
if (sandboxProblem !== undefined && process.env['MADARCH_SANDBOX_REQUIRED'] === '1') throw new Error(sandboxProblem);

const fields = [
  { name: 'id', type: 'text', meaning: 'The stable summary identity.', example: 'joined', required: true },
  { name: 'title', type: 'text', meaning: 'The statement read from the documents.', example: 'Alpha and Beta', required: true, evidence: true },
];
const outputs = { vertices: [{ kind: 'probe.summary', key: ['id'], fields }], edges: [] };
const answer = { vertices: [{ kind: 'probe.summary', key: { id: 'joined' }, values: { title: 'Alpha and Beta' }, evidence: { repository: 'repo', path: 'docs/a.md', lineStart: 1, lineEnd: 1 } }], end: { state: 'complete' } };

/** Independent ACP framing; each assertion is conditional on actual host file answers. */
const FAKE = `import { createInterface } from 'node:readline';
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
let sequence = 0;
const pending = new Map();
const ask = (method, params) => new Promise((resolve) => { const id = 'fake-' + ++sequence; pending.set(id, resolve); send({id, method, params}); });
createInterface({ input: process.stdin }).on('line', async (line) => {
  const m = JSON.parse(line);
  if (!m.method) { pending.get(m.id)?.(m); pending.delete(m.id); return; }
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 'fixture-session', models: { currentModelId: 'fixture-model', availableModels: [{ modelId: 'fixture-model', name: 'Fixture model' }] } } });
  if (m.method === 'session/prompt') {
    const sessionId = m.params.sessionId;
    const a = await ask('fs/read_text_file', { sessionId, path: '/repo/docs/a.md' });
    const b = await ask('fs/read_text_file', { sessionId, path: '/repo/docs/b.md' });
    const outside = await ask('fs/read_text_file', { sessionId, path: '/repo/absent.md' });
    const write = await ask('fs/write_text_file', { sessionId, path: '/repo/docs/a.md', content: 'changed' });
    const ok = a.result?.content === 'Alpha\\n' && b.result?.content === 'Beta\\n' && outside.error && write.error;
    const contract = JSON.parse(m.params.prompt[0].text.split('Output contract: ')[1]);
    const kind = contract.vertices[0].kind;
    const vertex = { kind, key: { id: kind }, values: { title: kind }, evidence: { repository: 'repo', path: 'docs/a.md', lineStart: 1, lineEnd: 1 } };
    const edges = contract.edges.map((edge) => ({ kind: edge.kind, from: { kind: edge.from, key: { id: edge.from } }, to: { kind: edge.to, key: { id: edge.to } }, evidence: vertex.evidence }));
    const result = ok ? { vertices: [vertex], edges, end: { state: 'complete' } } : { end: { state: 'partial', cause: JSON.stringify({ a, b, outside, write }) } };
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'usage_update', used: 31, size: 1000 } } });
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(result) } } } });
    send({ id: m.id, result: { stopReason: 'end_turn' } });
  }
});
`;

function fixture(agent: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'madarch-agent-fill-'));
  roots.push(root);
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'docs'), { recursive: true });
  writeFileSync(join(repo, 'docs/a.md'), 'Alpha\n');
  writeFileSync(join(repo, 'docs/b.md'), 'Beta\n');
  writeFileSync(join(repo, 'private.md'), 'Not an allowed graph file\n');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'documents');
  const home = join(root, 'home');
  mkdirSync(home);
  const product = makeProduct(home, 'agent-fixture', repo, 'repo');
  const folder = join(product, 'plugins/probe-summary');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ name: 'probe-summary', version: '1.0.0', entry: 'main.ts', runtime: { name: 'bun', version: Bun.version }, ...(agent ? { agent: { prompt: 'prompt.md', roots: ['repo/docs'] } } : {}) }));
  writeFileSync(join(folder, 'prompt.md'), 'Read both allowed documents and state one evidenced summary.');
  writeFileSync(join(folder, 'contract.json'), JSON.stringify({ id: 'probe-summary', version: '1.0.0', outputs, rights: { network: 'none', graph: true } }));
  writeFileSync(join(folder, 'main.ts'), `import { definePlugin } from 'madarch-plugin-sdk';\nawait definePlugin({name:'probe-summary',version:'1.0.0',graph:true,contract:${JSON.stringify(outputs)},extract:async(unit,context)=>${agent ? 'await context.agent(unit.inputs)' : `(${JSON.stringify(answer)})`}});\n`);
  writeFileSync(join(product, 'madarch/kinds.yaml'), `language: en
kinds:
  code.file: { template: templates/file.liquid, source: graph, capability: git }
  code.repository: { template: templates/repository.liquid, source: graph, capability: git }
  code.directory: { template: templates/directory.liquid, source: graph, capability: git }
  probe.summary:
    template: templates/item-plain.liquid
    source: graph
    depends-on: [code.file]
    key: [id]
    fields:
      - { name: id, type: text, binding: "probe-summary@1.id" }
      - { name: title, type: text, binding: "probe-summary@1.title" }
edges:
  - { name: code.contains, from: [code.repository, code.directory], to: [code.directory, code.file, code.gitlink], capability: git }
  - { name: code.as-is, from: [code.repository], to: [code.commit], capability: git }
plugins:
  - { id: probe-summary, version: 1, path: plugins/probe-summary, inputs: [code.file], outputs: [probe.summary], closure: [plugins/probe-summary/contract.json, plugins/probe-summary/main.ts, plugins/probe-summary/plugin.json, plugins/probe-summary/prompt.md] }
`);
  const closure = closureOf(folder).hash;
  writeFileSync(join(product, 'madarch/plugins.lock'), `plugins:\n  - { id: probe-summary, version: 1.0.0, closure: ${closure}, path: plugins/probe-summary }\n`);
  git(product, 'add', '-A');
  git(product, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'plugin');
  const fake = join(root, 'fake-acp.ts');
  writeFileSync(fake, FAKE);
  return { root, home, product, repo, closure, fake };
}


describe.skipIf(sandboxProblem !== undefined)('catalogue agent dependency edges', () => {
  test('the first fill publishes an edge in its later endpoint turn', async () => {
    const f = fixture(true);
    const file = join(f.product, 'madarch/kinds.yaml');
    const manifest = parseDocument(readFileSync(file, 'utf8'));
    manifest.deleteIn(['kinds', 'probe.summary']);
    for (const name of ['probe.a', 'probe.b']) manifest.setIn(['kinds', name], {
      template: 'templates/item-plain.liquid', source: 'graph',
      'depends-on': [name === 'probe.a' ? 'code.file' : 'probe.a'], key: ['id'],
      fields: [{ name: 'id', type: 'text', binding: { agent: 'Stable identity.' } }, { name: 'title', type: 'text', binding: { agent: 'The title.' } }],
    });
    manifest.setIn(['edges'], [...(manifest.toJS() as { edges: Record<string, unknown>[] }).edges, { name: 'probe.link', from: ['probe.a'], to: ['probe.b'], capability: 'agent-fill' }]);
    manifest.setIn(['plugins'], [{ id: 'agent-fill', version: 1, path: 'plugins/agent-fill', inputs: ['code.file'], outputs: [], closure: ['plugins/agent-fill/contract.json', 'plugins/agent-fill/main.ts', 'plugins/agent-fill/plugin.json', 'plugins/agent-fill/prompt.md'] }]);
    writeFileSync(file, manifest.toString());
    const closure = closureOf(join(f.product, 'plugins/agent-fill')).hash;
    writeFileSync(join(f.product, 'madarch/plugins.lock'), `plugins:\n  - { id: agent-fill, version: 1.0.0, closure: ${closure}, path: plugins/agent-fill }\n`);
    const declarations = readKinds(f.product);
    if (!declarations.present) throw new Error('Missing manifest');
    expect(declarations.manifest.findings).toEqual([]);
    execFileSync('git', ['-C', f.product, 'add', '-A']);
    execFileSync('git', ['-C', f.product, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'dependent kinds']);
    const owner = await createTestDatabaseOwner({ btreeGist: true, graphContract: await readPinnedGraphContract(f.product) });
    const sessions: PluginAgentReport[] = [];
    try {
      const run = await runFill({ product: f.product, database: owner, prepareContract: async (contract) => { await prepareStore(owner, { contract }); }, home: f.home, releaseHashes: [closure], steps: ['repository-tree', 'plugin-turns'], pluginAgent: {
        adapter: { id: 'fixture-acp', command: process.execPath, args: [f.fake] },
        connect: connectAcpAgent,
        onSession: (report) => sessions.push(report),
      } });
      expect(run.ok).toBe(true);
      if (!run.ok) throw new Error(JSON.stringify(run));
      if (run.state !== 'succeeded') throw new Error(JSON.stringify(run));
      const rows = await owner.transaction('snapshot', async (tx) => await tx.query(`SELECT * FROM ${generatedTableName('probe.link', 'edge')} WHERE state='open'`));
      expect(rows.rows).toHaveLength(1);
      expect(sessions).toHaveLength(2);
    } finally { await owner.close(); }
  }, 120_000);
});
