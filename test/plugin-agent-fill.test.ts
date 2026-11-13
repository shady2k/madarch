import { useRepositoryPlugins } from './enabled-plugins-fixture.js';
import { STARTER_FILES } from '../src/knowledge/seed.js';
import { RELEASE_CLOSURE_HASHES } from '../src/plugin/release-closures.js';
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
const sandboxProblem = process.env['MADARCH_PLUGIN_SANDBOX'] === 'off' && process.env['MADARCH_SANDBOX_REQUIRED'] !== '1' ? undefined : checkCgroupDelegation(cgroupParent())?.message ?? (await sandboxSetupProblem({ cgroupParent: cgroupParent() }))?.message;
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
    const outside = await ask('fs/read_text_file', { sessionId, path: '/repo/private.md' });
    const write = await ask('fs/write_text_file', { sessionId, path: '/repo/docs/a.md', content: 'changed' });
    const ok = a.result?.content === 'Alpha\\n' && b.result?.content === 'Beta\\n' && outside.error && write.error;
    const result = ok ? ${JSON.stringify(answer)} : { vertices: [{ kind: 'fixture-read-refusal', key: {}, values: { detail: JSON.stringify({ a, b, outside, write }) } }], end: { state: 'complete' } };
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
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ name: 'probe-summary', version: '1.0.0', entry: 'main.ts', runtime: { name: 'bun', version: Bun.version }, produces: [{ kind: 'probe.summary', fields: '*', reads: [] }], ...(agent ? { agent: { prompt: 'prompt.md', roots: ['repo/docs'] } } : {}) }));
  writeFileSync(join(folder, 'prompt.md'), 'Read both allowed documents and state one evidenced summary.');
  writeFileSync(join(folder, 'contract.json'), JSON.stringify({ id: 'probe-summary', version: '1.0.0', outputs, rights: { network: 'none', graph: true } }));
  writeFileSync(join(folder, 'main.ts'), `import { definePlugin } from 'madarch-plugin-sdk';\nawait definePlugin({name:'probe-summary',version:'1.0.0',graph:true,contract:${JSON.stringify(outputs)},extract:async(unit,context)=>${agent ? 'await context.agent(unit.inputs)' : `(${JSON.stringify(answer)})`}});\n`);
  writeFileSync(join(product, 'madarch/kinds.yaml'), `language: en
kinds:
  code.file: { template: templates/file.liquid, source: graph, capability: git }
  code.repository: { template: templates/repository.liquid, source: graph, capability: git }
  code.directory: { template: templates/directory.liquid, source: graph, capability: git }
  probe.summary:
    id: probe.summary
    group: code.structure
    definition: A summary of the fixture documents.
    sources: ["https://example.test/probe-summary"]
    acquisition: [agent-from-graph]
    status: implemented
    relation-constraints: { out: [], in: [] }
    template-policy: page
    labels:
      en: { one: Summary, many: Summaries }
      ru: { one: Сводка, many: Сводки }
    description:
      en: A summary of the fixture documents.
      ru: Сводка документов примера.
    template: templates/item-plain.liquid
    source: graph
    derives-from: [code.file]
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
  const manifestFile = join(product, 'madarch/kinds.yaml');
  const manifest = parseDocument(readFileSync(manifestFile, 'utf8'));
  const starter = parseDocument(STARTER_FILES.find(file => file.path === 'madarch/kinds.yaml')!.content).toJS();
  for (const key of ['catalog', 'groups', 'properties']) manifest.set(key, starter[key]);
  for (const name of ['code.repository', 'code.directory', 'code.file', 'code.gitlink', 'code.commit', 'code.author']) {
    manifest.setIn(['kinds', name], starter.kinds[name]);
  }
  writeFileSync(manifestFile, manifest.toString());
  const closure = closureOf(folder).hash;
  writeFileSync(join(product, 'madarch/plugins.lock'), `plugins:\n  - { id: probe-summary, version: 1.0.0, closure: ${closure}, path: plugins/probe-summary }\n`);
  useRepositoryPlugins(product);
  git(product, 'add', '-A');
  git(product, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'plugin');
  const fake = join(root, 'fake-acp.ts');
  writeFileSync(fake, FAKE);
  return { root, home, product, repo, closure, fake };
}

describe.skipIf(sandboxProblem !== undefined)('plugin agent parts in the one fill', () => {
  test('a pressed fill runs ACP over two graph files, denies outside reads and writes, and publishes evidence', async () => {
    const f = fixture(true);
    const owner = await createTestDatabaseOwner({ btreeGist: true, graphContract: await readPinnedGraphContract(f.product) });
    const sessions: PluginAgentReport[] = [];
    try {
      const run = await runFill({ product: f.product, targets: { kinds: ['probe.summary'] }, tokenCap: 1000, database: owner, prepareContract: async (contract) => { await prepareStore(owner, { contract }); }, home: f.home, releaseHashes: [...RELEASE_CLOSURE_HASHES, f.closure], steps: ['plugin-turns'], pluginAgent: {
        adapter: { id: 'fixture-acp', command: process.execPath, args: [f.fake] },
        connect: connectAcpAgent,
        onSession: (session) => sessions.push(session),
      } });
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      expect(run.state).toBe('succeeded');
      const rows = await owner.transaction('snapshot', async (tx) => await tx.query<{ title: string; evidence: Record<string, unknown>[] }>(`SELECT title,evidence FROM ${generatedTableName('probe.summary', 'vertex')} WHERE state='open'`));
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.title).toBe('Alpha and Beta');
      expect(rows.rows[0]?.evidence).toEqual([expect.objectContaining({ repository: 'repo', path: 'docs/a.md', line_start: 1, line_end: 1 })]);
      expect(readFileSync(join(f.repo, 'docs/a.md'), 'utf8')).toBe('Alpha\n');
      expect(sessions.length).toBeGreaterThanOrEqual(1);
      expect(sessions.every((session) => session.agentId === 'fixture-acp')).toBe(true);
      expect(sessions[0]?.agentId).toBe('fixture-acp');
      expect(sessions[0]?.model).toBe('fixture-model');
      expect(sessions[0]?.usage.context).toEqual({ used: 31, size: 1000 });
    } finally { await owner.close(); }
  }, 120_000);

  test('the bundled general agent refines a declared kind already filled by another plugin', async () => {
    const f = fixture(true);
    writeFileSync(f.fake, FAKE.replace('/repo/private.md', '/repo/absent.md'));
    const file = join(f.product, 'madarch/kinds.yaml');
    const manifest = parseDocument(readFileSync(file, 'utf8'));
    manifest.setIn(['plugins'], [...(manifest.getIn(['plugins']) as import('yaml').YAMLSeq).toJSON(), { id: 'agent-fill', version: 1, path: 'plugins/agent-fill', inputs: [], outputs: [], closure: ['plugins/agent-fill/contract.json', 'plugins/agent-fill/main.ts', 'plugins/agent-fill/plugin.json', 'plugins/agent-fill/prompt.md'] }]);
    manifest.setIn(['kinds', 'probe.summary', 'agent'], { plugin: 'agent-fill', fields: '*', refines: ['probe-summary'] });
    const probe = JSON.parse(readFileSync(join(f.product, 'plugins/probe-summary/plugin.json'), 'utf8'));
    delete probe.agent;
    writeFileSync(join(f.product, 'plugins/probe-summary/plugin.json'), JSON.stringify(probe));
    writeFileSync(file, manifest.toString());
    writeFileSync(join(f.product, 'plugins/probe-summary/main.ts'), `import { definePlugin } from 'madarch-plugin-sdk';\nawait definePlugin({name:'probe-summary',version:'1.0.0',graph:true,contract:${JSON.stringify(outputs)},extract:async()=>(${JSON.stringify(answer)})});\n`);
    const probeClosure = closureOf(join(f.product, 'plugins/probe-summary')).hash;
    const closure = closureOf(join(f.product, 'plugins/agent-fill')).hash;
    writeFileSync(join(f.product, 'madarch/plugins.lock'), `plugins:
  - { id: probe-summary, version: 1.0.0, closure: ${probeClosure}, path: plugins/probe-summary }
  - { id: agent-fill, version: 1.0.0, closure: ${closure}, path: plugins/agent-fill }
`);
    useRepositoryPlugins(f.product);
    const declarations = readKinds(f.product);
    expect(declarations.present).toBe(true);
    if (!declarations.present) throw new Error('the fixture manifest is absent');
    expect(declarations.manifest.findings).toEqual([]);
    execFileSync('git', ['-C', f.product, 'add', '-A']);
    execFileSync('git', ['-C', f.product, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'agent-bound kind']);
    const owner = await createTestDatabaseOwner({ btreeGist: true, graphContract: await readPinnedGraphContract(f.product) });
    try {
      const run = await runFill({ product: f.product, targets: { kinds: ['probe.summary'] }, tokenCap: 1000, database: owner, prepareContract: async (contract) => { await prepareStore(owner, { contract }); }, home: f.home, releaseHashes: [...RELEASE_CLOSURE_HASHES, closure, probeClosure], steps: ['plugin-turns'], pluginAgent: {
        adapter: { id: 'fixture-acp', command: process.execPath, args: [f.fake] },
        connect: connectAcpAgent,
      } });
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      expect(run.state).toBe('succeeded');
      expect(run.units.some((unit) => unit.unitId === 'plugin-turns/agent-fill:probe.summary')).toBe(true);
      const rows = await owner.transaction('snapshot', async (tx) => await tx.query<{ title: string; producer: string }>(`SELECT title,split_part(said_by, '@', 1) AS producer FROM ${generatedTableName('probe.summary', 'vertex')} WHERE state='open' ORDER BY producer`));
      expect(rows.rows).toEqual([{ title: 'Alpha and Beta', producer: 'agent-fill' }, { title: 'Alpha and Beta', producer: 'probe-summary' }]);
    } finally { await owner.close(); }
  }, 120_000);

  test('the packaged agent fills a novel unbound declared kind', async () => {
    const f = fixture(true);
    writeFileSync(f.fake, FAKE.replace('/repo/private.md', '/repo/absent.md'));
    const file = join(f.product, 'madarch/kinds.yaml');
    const manifest = parseDocument(readFileSync(file, 'utf8'));
    manifest.setIn(['plugins'], [{ id: 'agent-fill', version: 1, path: 'plugins/agent-fill', inputs: [], outputs: [], closure: ['plugins/agent-fill/contract.json', 'plugins/agent-fill/main.ts', 'plugins/agent-fill/plugin.json', 'plugins/agent-fill/prompt.md'] }]);
    manifest.setIn(['kinds', 'probe.summary', 'fields'], [{ name: 'id', type: 'text' }, { name: 'title', type: 'text' }]);
    manifest.setIn(['kinds', 'probe.summary', 'agent'], { plugin: 'agent-fill', fields: '*' });
    writeFileSync(file, manifest.toString());
    const closure = closureOf(join(f.product, 'plugins/agent-fill')).hash;
    writeFileSync(join(f.product, 'madarch/plugins.lock'), `plugins:
  - { id: agent-fill, version: 1.0.0, closure: ${closure}, path: plugins/agent-fill }
`);
    useRepositoryPlugins(f.product);
    const declarations = readKinds(f.product);
    expect(declarations.present).toBe(true);
    if (!declarations.present) throw new Error('the fixture manifest is absent');
    expect(declarations.manifest.findings).toEqual([]);
    execFileSync('git', ['-C', f.product, 'add', '-A']);
    execFileSync('git', ['-C', f.product, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'agent-bound kind']);
    const owner = await createTestDatabaseOwner({ btreeGist: true, graphContract: await readPinnedGraphContract(f.product) });
    try {
      const run = await runFill({ product: f.product, targets: { kinds: ['probe.summary'] }, tokenCap: 1000, database: owner, prepareContract: async (contract) => { await prepareStore(owner, { contract }); }, home: f.home, releaseHashes: [...RELEASE_CLOSURE_HASHES, closure], steps: ['plugin-turns'], pluginAgent: {
        adapter: { id: 'fixture-acp', command: process.execPath, args: [f.fake] },
        connect: connectAcpAgent,
      } });
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      expect(run.state).toBe('succeeded');
      expect(run.units.some((unit) => unit.unitId === 'plugin-turns/agent-fill:probe.summary')).toBe(true);
      const rows = await owner.transaction('snapshot', async (tx) => await tx.query<{ title: string; producer: string }>(`SELECT title,split_part(said_by, '@', 1) AS producer FROM ${generatedTableName('probe.summary', 'vertex')} WHERE state='open' ORDER BY producer`));
      expect(rows.rows).toEqual([{ title: 'Alpha and Beta', producer: 'agent-fill' }]);
    } finally { await owner.close(); }
  }, 120_000);

  test('a deterministic-only plugin still fills without configuring or starting any agent', async () => {
    const f = fixture(false);
    const owner = await createTestDatabaseOwner({ btreeGist: true, graphContract: await readPinnedGraphContract(f.product) });
    try {
      const run = await runFill({ product: f.product, targets: { kinds: ['probe.summary'] }, tokenCap: 1000, database: owner, prepareContract: async (contract) => { await prepareStore(owner, { contract }); }, home: f.home, releaseHashes: [...RELEASE_CLOSURE_HASHES, f.closure], steps: ['plugin-turns'] });
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      expect(run.state).toBe('succeeded');
      expect(run.units.some((unit) => unit.unitId === 'plugin-turns/probe-summary:probe.summary')).toBe(true);
      const rows = await owner.transaction('snapshot', async (tx) => await tx.query<{ title: string }>(`SELECT title FROM ${generatedTableName('probe.summary', 'vertex')} WHERE state='open'`));
      expect(rows.rows).toEqual([{ title: 'Alpha and Beta' }]);
    } finally { await owner.close(); }
  }, 120_000);
});
