import { writeFolderManifest } from './catalog-folder-fixture.js';
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
type Mode = 'files' | 'multi' | 'unselected-write' | 'undeclared-read';

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
  const entries = mode === 'multi' || mode === 'undeclared-read'
    ? [['X', [], ['id', 'text']], ['Y', [], ['id', 'text']], ['A', ['X'], ['id', 'text']], ['B', ['Y'], ['id', 'text']]] as const
    : [['Files', [], ['path', 'content', 'description']], ['Summary', ['Files'], ['id', 'text']]] as const;
  const contract = { vertices: entries.map(([kind, , fields]) => ({ kind, key: [fields[0]], fields: fields.map(field) })), edges: [] };
  const produces = entries.map(([kind, reads]) => ({ kind, fields: '*', reads }));
  writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({ name: 'scenarios', version: '1.0.0', entry: 'main.js', runtime: { name: 'bun', version: Bun.version }, produces }));
  writeFileSync(join(plugin, 'contract.json'), JSON.stringify({ id: 'scenarios', version: '1.0.0', outputs: contract, rights: { network: 'none', graph: true, graphReads: ['value'] } }));
  writeFileSync(join(plugin, 'main.js'), readFileSync(new URL('./fixtures/plugin-declaration-scenarios/main.js', import.meta.url), 'utf8'));
  writeFileSync(join(plugin, 'scenario.js'), `export const contract=${JSON.stringify(contract)}; export const mode=${JSON.stringify(mode)}; export const files=${JSON.stringify(files)};\n`);
  const kinds = Object.fromEntries(entries.map(([kind, reads, fields]) => [kind, { template: 'templates/item-plain.liquid', source: 'graph', 'derives-from': reads, key: [fields[0]], fields: fields.map(name => ({ name, type: 'text' })) }]));
  const plugins = [{ id: 'scenarios', version: 1, path: 'plugins/scenarios', inputs: [...new Set(entries.flatMap(([, reads]) => [...reads]))], outputs: entries.map(([kind]) => kind), closure: ['plugins/scenarios/plugin.json', 'plugins/scenarios/contract.json', 'plugins/scenarios/main.js', 'plugins/scenarios/scenario.js'] }];
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
  const run = async (target: string, runId: string) => await runFill({ product: f.product, database: owner, home: f.home, releaseHashes: f.releaseHashes,
    steps: ['plugin-turns'], targets: { kinds: [target] }, runId,
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
