import { onTestFinished } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { prepareStore } from '../src/adapters/prepare-store.js';
import { runFill, type RunFillOptions } from '../src/fill/run.js';
import { startupBinding } from '../src/graph/manifest-publication.js';
import { readKindAssertions } from '../src/graph/records.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { closureOf } from '../src/plugin/closure.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { writeFolderManifest } from './catalog-folder-fixture.js';
import { makeProduct } from './knowledge-fixture.js';
import { createTestDatabaseOwner } from './test-database.js';

export const digestOf = (content: string) => createHash('sha256').update(content).digest('hex');

const field = (name: string) => ({ name, type: 'text', meaning: name, example: name, required: true });
type Mode = 'files' | 'multi' | 'unselected-write' | 'undeclared-read' | 'system-git';

/** Authored source records are captured into a locked ordinary source plugin, never a native Git stage. */
export function fixture(mode: Mode) {
  const root = mkdtempSync(join(tmpdir(), 'madarch-fill-scenarios-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'); mkdirSync(repo);
  writeFileSync(join(repo, 'source.md'), 'Authored source.\n');
  const files = mode === 'files' ? Array.from({ length: 2603 }, (_, index) => {
    const path = `source-${String(index).padStart(4, '0')}.txt`;
    writeFileSync(join(repo, path), `Authored file ${index}.\n`);
    return { path, content: readFileSync(join(repo, path), 'utf8'), description: `Description of authored file ${index}.` };
  }) : [{ path: 'source.md', content: readFileSync(join(repo, 'source.md'), 'utf8'), description: 'Authored source.' }];
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'authored sources');
  const home = join(root, 'home'); mkdirSync(home);
  const product = makeProduct(home, 'scenarios', repo, 'repo');
  const plugin = join(product, 'plugins/scenarios'); mkdirSync(plugin, { recursive: true });
  const entries = mode === 'system-git'
    ? [['X', [], ['id', 'text']], ['Y', [], ['id', 'text']], ['Healthy', [], ['id', 'text']]] as const
    : mode === 'multi' || mode === 'undeclared-read'
    ? [['X', [], ['id', 'text']], ['Y', [], ['id', 'text']], ['A', ['X'], ['id', 'text']], ['B', ['Y'], ['id', 'text']]] as const
    : [['Files', [], ['path', 'content', 'description']], ['Summary', ['Files'], ['id', 'text']]] as const;
  const contract = { vertices: entries.map(([kind, , fields]) => ({ kind, key: [fields[0]], fields: fields.map(field) })), edges: [] };
  const produces = entries.filter(([kind]) => mode !== 'system-git' || kind !== 'Healthy').map(([kind, reads]) => ({ kind, fields: '*', reads }));
  // A plugin that runs a tool is a core plugin and names the one source it owns (decision 0038): this one reads git.
  writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({ name: 'scenarios', version: '1.0.0', entry: 'main.js', runtime: { name: 'bun', version: Bun.version }, produces, ...(mode === 'system-git' ? { tier: 'core', capabilities: ['git'], tools: [{ name: 'git', source: 'system', minimumVersion: '2.31' }] } : {}) }));
  const scenarioContract = mode === 'system-git' ? { vertices: contract.vertices.filter(vertex => vertex.kind !== 'Healthy'), edges: [] } : contract;
  writeFileSync(join(plugin, 'contract.json'), JSON.stringify({ id: 'scenarios', version: '1.0.0', outputs: scenarioContract, rights: { network: 'none', graph: true, graphReads: ['value', 'ownFacts'] } }));
  writeFileSync(join(plugin, 'main.js'), readFileSync(new URL('./fixtures/plugin-declaration-scenarios/main.js', import.meta.url), 'utf8'));
  writeFileSync(join(plugin, 'scenario.js'), `export const contract=${JSON.stringify(scenarioContract)}; export const mode=${JSON.stringify(mode)}; export const files=${JSON.stringify(files.map(file => ({ ...file, digest: digestOf(file.content) })))}; export const sourceDigest=${JSON.stringify(digestOf('Authored source.\n'))};\n`);
  const kinds = Object.fromEntries(entries.map(([kind, reads, fields]) => [kind, { source: 'graph', 'derives-from': reads, key: [fields[0]], fields: fields.map(name => ({ name, type: 'text' })) }]));
  const plugins = [{ id: 'scenarios', version: 1, path: 'plugins/scenarios', inputs: [...new Set(entries.flatMap(([, reads]) => [...reads]))], outputs: entries.map(([kind]) => kind), closure: ['plugins/scenarios/plugin.json', 'plugins/scenarios/contract.json', 'plugins/scenarios/main.js', 'plugins/scenarios/scenario.js'] }];
  if (mode === 'system-git') {
    const healthy = join(product, 'plugins/healthy'); mkdirSync(healthy, { recursive: true });
    const outputs = { vertices: contract.vertices.filter(vertex => vertex.kind === 'Healthy'), edges: [] };
    writeFileSync(join(healthy, 'plugin.json'), JSON.stringify({ name: 'healthy', version: '1.0.0', entry: 'main.js', runtime: { name: 'bun', version: Bun.version }, produces: [{ kind: 'Healthy', fields: '*', reads: [] }] }));
    writeFileSync(join(healthy, 'contract.json'), JSON.stringify({ id: 'healthy', version: '1.0.0', outputs, rights: { network: 'none', graph: true, graphReads: ['files', 'value', 'ownFacts'] } }));
    writeFileSync(join(healthy, 'main.js'), `import { definePlugin } from 'madarch-plugin-sdk'; await definePlugin({ name: 'healthy', version: '1.0.0', contract: ${JSON.stringify(outputs)}, async extract() { return { vertices: [{ kind: 'Healthy', key: { id: 'independent' }, values: { text: 'still filled' }, evidence: { target: { kind: 'system.content-snapshot', key: { digest: '${digestOf('Authored source.\n')}' } }, path: 'source.md', lineStart: 1, lineEnd: 1 } }], end: { state: 'complete' } }; } });`);
    plugins[0]!.outputs = ['X', 'Y'];
    plugins.push({ id: 'healthy', version: 1, path: 'plugins/healthy', inputs: [], outputs: ['Healthy'], closure: ['plugins/healthy/plugin.json', 'plugins/healthy/contract.json', 'plugins/healthy/main.js'] });
  }
  if (mode === 'files') plugins.push({ id: 'agent-fill', version: 1, path: 'plugins/agent-fill', inputs: [], outputs: [], closure: ['plugins/agent-fill/plugin.json', 'plugins/agent-fill/contract.json', 'plugins/agent-fill/main.ts', 'plugins/agent-fill/prompt.md'] });
  writeFolderManifest(product, stringify({ language: 'en', kinds, plugins }));
  const releases = plugins.map(({ id, path }) => ({ id, path, version: '1.0.0', closure: closureOf(join(product, path)).hash }));
  writeFileSync(join(product, 'madarch/plugins.lock'), stringify({ plugins: releases }));
  git(product, 'add', '-A'); git(product, '-c', 'user.name=Fixture', '-c', 'user.email=f@example.invalid', 'commit', '-qm', mode);
  return { product, home, files, releaseHashes: releases.map(entry => entry.closure) };
}

export async function open(f: ReturnType<typeof fixture>) {
  const owner = await createTestDatabaseOwner({ btreeGist: true });
  const contract = await readPinnedGraphContract(f.product);
  await prepareStore(owner, { contract });
  // Capture the authored bytes as fixture input, not as extra plugin-produced outputs.
  const contents = [...new Set([...f.files.map(file => file.content), 'Authored source.\n'])];
  await owner.transaction('write', async tx => {
    const installed = await startupBinding(tx, contract, 'scenario-input');
    await publishGraphDrafts(tx, installed.contract, { vertices: contents.map(content => ({
      kind: 'system.content-snapshot', key: { digest: digestOf(content) }, values: { content },
      producer: 'scenario-input', producerVersion: '1',
    })), removals: [] });
  });
  const run = async (target: string | readonly string[], runId: string, limits: NonNullable<RunFillOptions['limits']> = {}) => await runFill({ product: f.product, database: owner, home: f.home, releaseHashes: f.releaseHashes,
    steps: ['plugin-turns'], targets: { kinds: typeof target === 'string' ? [target] : target }, runId, limits,
    prepareContract: async contract => { await prepareStore(owner, { contract }); } });
  const rows = async (kind: string) => await owner.transaction('snapshot', async tx => {
    const declaration = contract.vertex.find(vertex => vertex.name === kind)!;
    return (await readKindAssertions(tx, 'vertex', kind, declaration.fields.filter(field => !declaration.key.includes(field.name)).map(field => field.name), { contract }))
      .map((record): Record<string, unknown> & { assertions: typeof record.selectedAssertions } => ({ ...record.key, ...record.values, assertions: record.selectedAssertions }));
  });
  return { owner, run, rows, contract };
}
