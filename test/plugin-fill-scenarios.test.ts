import { writeFolderManifest } from './catalog-folder-fixture.js';
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { makeProduct } from './knowledge-fixture.js';
import { seedStarterSet } from '../src/knowledge/seed.js';
import { createTestDatabaseOwner } from './test-database.js';
import { prepareStore } from '../src/adapters/prepare-store.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { closureOf } from '../src/plugin/closure.js';
import { planManifestFill } from '../src/plugin/fill-declarations.js';
import { runFill } from '../src/fill/run.js';
import { readProducerOutcomes } from '../src/graph/producer-outcomes.js';
import { generatedTableName } from '../src/graph/contract.js';

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const field = (name: string) => ({ name, type: 'text', meaning: name, example: name, required: true });
type Mode = 'files' | 'multi' | 'unselected-write' | 'undeclared-read' | 'system-git';

/** Authored source records are captured into a locked ordinary source plugin, never a native Git stage. */
function fixture(mode: Mode) {
  const root = mkdtempSync(join(tmpdir(), 'madarch-fill-scenarios-')); roots.push(root);
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
  const product = makeProduct(home, 'scenarios', repo, 'repo'); seedStarterSet(product);
  const plugin = join(product, 'plugins/scenarios'); mkdirSync(plugin, { recursive: true });
  const entries = mode === 'system-git'
    ? [['X', [], ['id', 'text']], ['Y', [], ['id', 'text']], ['Healthy', [], ['id', 'text']]] as const
    : mode === 'multi' || mode === 'undeclared-read'
    ? [['X', [], ['id', 'text']], ['Y', [], ['id', 'text']], ['A', ['X'], ['id', 'text']], ['B', ['Y'], ['id', 'text']]] as const
    : [['Files', [], ['path', 'content', 'description']], ['Summary', ['Files'], ['id', 'text']]] as const;
  const contract = { vertices: entries.map(([kind, , fields]) => ({ kind, key: [fields[0]], fields: fields.map(field) })), edges: [] };
  const produces = entries.filter(([kind]) => mode !== 'system-git' || kind !== 'Healthy').map(([kind, reads]) => ({ kind, fields: '*', reads }));
  writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({ name: 'scenarios', version: '1.0.0', entry: 'main.js', runtime: { name: 'bun', version: Bun.version }, produces, ...(mode === 'system-git' ? { tools: [{ name: 'git', source: 'system', minimumVersion: '2.31' }] } : {}) }));
  const scenarioContract = mode === 'system-git' ? { vertices: contract.vertices.filter(vertex => vertex.kind !== 'Healthy'), edges: [] } : contract;
  writeFileSync(join(plugin, 'contract.json'), JSON.stringify({ id: 'scenarios', version: '1.0.0', outputs: scenarioContract, rights: { network: 'none', graph: true, graphReads: ['value'] } }));
  writeFileSync(join(plugin, 'main.js'), readFileSync(new URL('./fixtures/plugin-declaration-scenarios/main.js', import.meta.url), 'utf8'));
  writeFileSync(join(plugin, 'scenario.js'), `export const contract=${JSON.stringify(scenarioContract)}; export const mode=${JSON.stringify(mode)}; export const files=${JSON.stringify(files)};\n`);
  const kinds = Object.fromEntries(entries.map(([kind, reads, fields]) => [kind, { template: 'templates/item-plain.liquid', source: 'graph', 'derives-from': reads, key: [fields[0]], fields: fields.map(name => ({ name, type: 'text' })) }]));
  const plugins = [{ id: 'scenarios', version: 1, path: 'plugins/scenarios', inputs: [...new Set(entries.flatMap(([, reads]) => [...reads]))], outputs: entries.map(([kind]) => kind), closure: ['plugins/scenarios/plugin.json', 'plugins/scenarios/contract.json', 'plugins/scenarios/main.js', 'plugins/scenarios/scenario.js'] }];
  if (mode === 'system-git') {
    const healthy = join(product, 'plugins/healthy'); mkdirSync(healthy, { recursive: true });
    const outputs = { vertices: contract.vertices.filter(vertex => vertex.kind === 'Healthy'), edges: [] };
    writeFileSync(join(healthy, 'plugin.json'), JSON.stringify({ name: 'healthy', version: '1.0.0', entry: 'main.js', runtime: { name: 'bun', version: Bun.version }, produces: [{ kind: 'Healthy', fields: '*', reads: [] }] }));
    writeFileSync(join(healthy, 'contract.json'), JSON.stringify({ id: 'healthy', version: '1.0.0', outputs, rights: { network: 'none' } }));
    writeFileSync(join(healthy, 'main.js'), `import { definePlugin } from 'madarch-plugin-sdk'; await definePlugin({ name: 'healthy', version: '1.0.0', contract: ${JSON.stringify(outputs)}, async extract() { return { vertices: [{ kind: 'Healthy', key: { id: 'independent' }, values: { text: 'still filled' } }], end: { state: 'complete' } }; } });`);
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

async function open(f: ReturnType<typeof fixture>) {
  const owner = await createTestDatabaseOwner({ btreeGist: true });
  await prepareStore(owner, { contract: await readPinnedGraphContract(f.product) });
  const run = async (target: string | readonly string[], runId: string) => await runFill({ product: f.product, database: owner, home: f.home, releaseHashes: f.releaseHashes,
    steps: ['plugin-turns'], targets: { kinds: typeof target === 'string' ? [target] : target }, runId,
    prepareContract: async contract => { await prepareStore(owner, { contract }); } });
  const rows = async (kind: string) => (await owner.transaction('snapshot', async tx => await tx.query<Record<string, unknown>>(`SELECT o.*, n.key->>'path' AS path FROM ${generatedTableName(kind, 'vertex')} o JOIN node n ON n.id=o.node_id WHERE o.state='open' ORDER BY n.key->>'path' COLLATE "C"`))).rows;
  return { owner, run, rows };
}

test('2,603 fully covered Files fill without scheduling the available general agent or Summary', async () => {
  const f = fixture('files');
  const read = readKinds(f.product); if (!read.present) throw new Error('fixture manifest absent');
  expect(read.manifest.findings).toEqual([]);
  for (const agentSelected of [false, true]) {
    const plan = planManifestFill(read.manifest, f.product, ['Files'], agentSelected);
    expect(plan.order).toEqual(['scenarios']);
    expect([...plan.outputs.get('scenarios')!.keys()]).toEqual(['Files']);
    expect(plan.outputs.has('agent-fill')).toBe(false);
  }
  const { owner, run, rows } = await open(f);
  try {
    // No adapter or token cap is supplied; merely available agent capability cannot require either.
    const result = await run('Files', 'files-covered');
    expect(result.ok).toBe(true); if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.state).toBe('succeeded');
    expect(result.units.filter(unit => unit.stageId === 'plugin-turns').map(unit => unit.unitId)).toEqual(['plugin-turns/scenarios:Files']);
    const actual = await rows('Files');
    expect(actual).toHaveLength(2603);
    expect(actual.map(row => [row.path, row.content, row.description]).sort()).toEqual(f.files.map(file => [file.path, file.content, file.description]).sort());
    expect(actual.every(row => String(row.said_by).startsWith('scenarios@') && Array.isArray(row.evidence) && row.evidence.length > 0)).toBe(true);
    expect(await rows('Summary')).toEqual([]);
    expect(await readProducerOutcomes(owner, { runId: 'files-covered' })).toEqual([expect.objectContaining({ kind: 'Files', outcome: 'completed', produced: 2603 })]);
  } finally { await owner.close(); }
}, 300_000);

test('one multi-output process reads X for A and Y for B without selecting the other branch', async () => {
  const f = fixture('multi'); const { owner, run, rows } = await open(f);
  try {
    const a = await run('A', 'only-a'); expect(a.ok).toBe(true); if (!a.ok) throw new Error(JSON.stringify(a));
    expect(a.state).toBe('succeeded');
    expect(a.units.filter(unit => unit.stageId === 'plugin-turns').map(unit => unit.unitId).sort()).toEqual(['plugin-turns/scenarios:A', 'plugin-turns/scenarios:X']);
    expect(await rows('A')).toEqual([expect.objectContaining({ text: 'authored X' })]);
    expect(await rows('Y')).toEqual([]); expect(await rows('B')).toEqual([]);
    const b = await run('B', 'only-b'); expect(b.ok).toBe(true); if (!b.ok) throw new Error(JSON.stringify(b));
    expect(b.state).toBe('succeeded');
    expect(await rows('B')).toEqual([expect.objectContaining({ text: 'authored Y' })]);
    const outcomes = await readProducerOutcomes(owner, { runId: 'only-b' });
    expect(outcomes.map(outcome => outcome.kind).sort()).toEqual(['B', 'Y']);
  } finally { await owner.close(); }
}, 300_000);

test.each(['unselected-write', 'undeclared-read'] as const)('real plugin %s fails without publishing forbidden or selected output', async mode => {
  const f = fixture(mode); const { owner, run, rows } = await open(f);
  const target = mode === 'unselected-write' ? 'Files' : 'A';
  try {
    const result = await run(target, mode);
    expect(result.ok && result.state === 'succeeded').toBe(false);
    expect(await rows(target)).toEqual([]);
    if (mode === 'unselected-write') expect(await rows('Summary')).toEqual([]);
    else { expect(await rows('Y')).toEqual([]); expect(await rows('X')).toHaveLength(1); }
    expect(await readProducerOutcomes(owner, { runId: mode })).toEqual(expect.arrayContaining([expect.objectContaining({ kind: target, outcome: 'failed' })]));
  } finally { await owner.close(); }
}, 300_000);

/** Product metadata still uses real Git; only the producer's system-tool probe is unavailable/old. */
test.each(['unavailable', 'old'] as const)('system Git %s fails each Git output durably while an unrelated producer publishes', async mode => {
  const f = fixture('system-git');
  const { owner, run, rows } = await open(f);
  const previousPath = process.env.PATH;
  const realGit = Bun.which('git');
  if (realGit === null) throw new Error('fixture setup requires Git');
  const bin = join(f.home, 'git-probe'); mkdirSync(bin);
  const executable = join(bin, 'git');
  writeFileSync(executable, `#!/bin/sh\nif [ "$1" = "--version" ]; then\n${mode === 'old' ? 'echo "git version 2.30.5"' : 'echo "git unavailable for producer" >&2; exit 127'}\nelse\nexec ${JSON.stringify(realGit)} "$@"\nfi\n`);
  chmodSync(executable, 0o755);
  process.env.PATH = `${bin}:${previousPath ?? ''}`;
  try {
    const runId = `system-git-${mode}`;
    const result = await run(['X', 'Y', 'Healthy'], runId);
    expect(result.ok).toBe(true); if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.state).not.toBe('succeeded');
    for (const kind of ['X', 'Y']) {
      expect(result.units.find(unit => unit.unitId === `plugin-turns/scenarios:${kind}`)?.state).toBe('blocked');
    }
    expect(await rows('X')).toEqual([]); expect(await rows('Y')).toEqual([]);
    expect(await rows('Healthy')).toEqual([expect.objectContaining({ text: 'still filled' })]);
    const retried = await owner.transaction('snapshot', async tx => await tx.query(`SELECT unit_id FROM fill_event WHERE run_id=$1 AND kind='unit-retried'`, [runId]));
    expect(retried.rows).toEqual([]);
    const outcomes = await readProducerOutcomes(owner, { runId });
    expect(outcomes).toHaveLength(3);
    for (const kind of ['X', 'Y']) {
      const failed = outcomes.filter(outcome => outcome.kind === kind);
      expect(failed).toEqual([expect.objectContaining({ plugin: 'scenarios', outcome: 'failed', produced: 0 })]);
      expect(failed[0]!.reason).toContain('system Git found');
      expect(failed[0]!.reason).toContain('Git 2.31 or newer');
      expect(failed[0]!.reason).toContain(mode === 'old' ? '2.30.5' : 'could not run --version');
    }
    expect(outcomes.find(outcome => outcome.kind === 'Healthy')).toMatchObject({ plugin: 'healthy', outcome: 'completed', produced: 1 });
    // Read completion metadata again in a separate committed transaction: failures are not private drafts.
    expect(await readProducerOutcomes(owner, { runId })).toEqual(outcomes);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await owner.close();
  }
}, 300_000);
