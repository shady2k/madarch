import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { makeProduct } from './knowledge-fixture.js';
import { seedStarterSet } from '../src/knowledge/seed.js';
import { createTestDatabaseOwner } from './test-database.js';
import { prepareStore } from '../src/adapters/prepare-store.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { closureOf } from '../src/plugin/closure.js';
import { runFill } from '../src/fill/run.js';
import { generatedTableName } from '../src/graph/contract.js';
import { readProducerOutcomes } from '../src/graph/producer-outcomes.js';
import { successfulPluginSnapshot, pluginSnapshotValue } from '../src/graph/plugin-turns.js';

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const field = (name: string) => ({ name, type: 'text', meaning: name, example: name, required: true });
type Mode = 'normal' | 'large' | 'fail-second' | 'empty' | 'outside';
const keys = ['a', 'b', 'c'];
const git = (folder: string, ...args: string[]) => execFileSync('git', ['-C', folder, ...args], { stdio: 'pipe' });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'madarch-output-partitions-')); roots.push(root);
  const repo = join(root, 'repo'); mkdirSync(repo);
  writeFileSync(join(repo, 'source.md'), 'Partition source.\n');
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'source');
  const home = join(root, 'home'); mkdirSync(home);
  const product = makeProduct(home, 'partitions', repo, 'repo'); seedStarterSet(product);
  const plugin = join(product, 'plugins/partitions'); mkdirSync(plugin, { recursive: true });
  const contract = { vertices: ['Items', 'Summary'].map(kind => ({ kind, key: ['id'], fields: ['id', 'text'].map(field) })), edges: [] };
  writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({ name: 'partitions', version: '1.0.0', entry: 'main.js', runtime: { name: 'bun', version: Bun.version },
    produces: [{ kind: 'Items', fields: '*', reads: [], partition: 'key' }, { kind: 'Summary', fields: '*', reads: ['Items'] }] }));
  writeFileSync(join(plugin, 'contract.json'), JSON.stringify({ id: 'partitions', version: '1.0.0', outputs: contract, rights: { network: 'none', graph: true, graphReads: ['value'] } }));
  writeFileSync(join(plugin, 'main.js'), `import { definePlugin } from 'madarch-plugin-sdk';
import { mode, revision } from './scenario.js';
const contract=${JSON.stringify(contract)};
await definePlugin({ name:'partitions', version:'1.0.0', contract, graph:true, graphReads:['value'],
  planOutput() { return {partitions: mode === 'empty' ? [] : ['a','b','c'].map(id => ({keys:[{id}]}))}; },
  async extract(unit, context) {
    const evidence={repository:'repo',path:'source.md',lineStart:1,lineEnd:1};
    if(unit.kind==='Summary') {
      const text=await context.graph.value('Items',{id:'a'},'text');
      return {vertices:[{kind:'Summary',key:{id:'summary'},values:{text},evidence}],end:{state:'complete'}};
    }
    const selected=unit.inputs.keys;
    if(!Array.isArray(selected)) throw new Error('extract must receive exact partition keys');
    if(mode==='fail-second' && selected.some(key=>key.id==='b')) throw new Error('second partition refused');
    const vertices=mode==='empty' ? [] : selected.map(key=>({kind:'Items',key:mode==='outside'?{id:'forbidden'}:key,
      values:{text:mode==='large'?key.id.repeat(3*1024*1024):revision+':'+key.id},evidence}));
    return {vertices,end:{state:'complete'}};
  }
});`);
  const kinds = Object.fromEntries(['Items', 'Summary'].map(kind => [kind, { template: 'templates/item-plain.liquid', source: 'graph', 'derives-from': kind === 'Summary' ? ['Items'] : [], key: ['id'], fields: ['id', 'text'].map(name => ({ name, type: 'text' })) }]));
  writeFileSync(join(product, 'madarch/kinds.yaml'), stringify({ language: 'en', kinds, plugins: [{ id: 'partitions', version: 1, path: 'plugins/partitions', inputs: ['Items'], outputs: ['Items', 'Summary'], closure: ['plugins/partitions/plugin.json', 'plugins/partitions/contract.json', 'plugins/partitions/main.js', 'plugins/partitions/scenario.js'] }] }));
  let releaseHashes: string[] = [];
  function change(mode: Mode, revision: string) {
    writeFileSync(join(plugin, 'scenario.js'), `export const mode=${JSON.stringify(mode)}; export const revision=${JSON.stringify(revision)};\n`);
    const hash = closureOf(plugin).hash; releaseHashes = [hash];
    writeFileSync(join(product, 'madarch/plugins.lock'), stringify({ plugins: [{ id: 'partitions', path: 'plugins/partitions', version: '1.0.0', closure: hash }] }));
    git(product, 'add', '-A'); git(product, '-c', 'user.name=Fixture', '-c', 'user.email=f@example.invalid', 'commit', '-qm', revision);
  }
  change('normal', 'first');
  return { product, home, change, get releaseHashes() { return releaseHashes; } };
}

async function open() {
  const f = fixture();
  const owner = await createTestDatabaseOwner({ btreeGist: true });
  await prepareStore(owner, { contract: await readPinnedGraphContract(f.product) });
  const run = async (id: string, target = 'Items') => {
    const result = await runFill({ product: f.product, database: owner, home: f.home, runId: id, releaseHashes: f.releaseHashes,
      targets: { kinds: [target] }, steps: ['plugin-turns'], prepareContract: async contract => { await prepareStore(owner, { contract }); } });
    if (!result.ok) throw new Error(JSON.stringify(result));
    if (result.state !== 'succeeded') {
      const generations = await owner.transaction('snapshot', async tx => await tx.query(
        'SELECT * FROM fill_unit_generation WHERE run_id=$1 ORDER BY unit_id,generation', [id]));
      const events = await owner.transaction('snapshot', async tx => await tx.query(
        'SELECT kind,summary FROM fill_event WHERE run_id=$1', [id]));
      console.error('partition fill diagnostic', JSON.stringify({ id, product: f.product, result, generations: generations.rows, events: events.rows }));
    }
    return result;
  };
  const rows = async (kind = 'Items') => (await owner.transaction('snapshot', async tx => await tx.query<{ id: string; text: string }>(
    `SELECT n.key->>'id' AS id,o.text FROM ${generatedTableName(kind, 'vertex')} o JOIN node n ON n.id=o.node_id WHERE o.state='open' ORDER BY n.key->>'id' COLLATE "C"`))).rows;
  return { f, owner, run, rows };
}

test('bounded partitions publish more than 8 MiB of complete content without raising bounds', async () => {
  const { f, owner, run, rows } = await open();
  try {
    f.change('large', 'large');
    expect((await run('large')).state).toBe('succeeded');
    const actual = await rows();
    expect(actual.map(row => row.id)).toEqual(keys);
    expect(actual.reduce((sum, row) => sum + Buffer.byteLength(row.text), 0)).toBeGreaterThan(8 * 1024 * 1024);
    for (const row of actual) expect(row.text).toBe(row.id.repeat(3 * 1024 * 1024));
    expect(await readProducerOutcomes(owner, { runId: 'large' })).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'Items', outcome: 'completed', produced: 3 })]));
  } finally { await owner.close(); }
}, 300_000);

test('a failed second partition retains the entire prior output and blocks dependants', async () => {
  const { f, owner, run, rows } = await open();
  try {
    expect((await run('prior')).state).toBe('succeeded');
    const before = await rows();
    f.change('fail-second', 'replacement');
    expect((await run('failed', 'Summary')).state).not.toBe('succeeded');
    expect(await rows()).toEqual(before);
    expect(await rows('Summary')).toEqual([]);
    const outcomes = await readProducerOutcomes(owner, { runId: 'failed' });
    expect(outcomes.some(outcome => outcome.kind === 'Summary' && outcome.outcome === 'completed')).toBe(false);
  } finally { await owner.close(); }
}, 300_000);

test('a named successful snapshot keeps every earlier partition after a later publication', async () => {
  const { f, owner, run, rows } = await open();
  try {
    expect((await run('snapshot-first')).state).toBe('succeeded');
    const snapshot = await successfulPluginSnapshot(owner, 'snapshot-first', 'partitions:Items');
    expect(snapshot.partitions).toHaveLength(3);
    f.change('normal', 'second');
    expect((await run('snapshot-second')).state).toBe('succeeded');
    expect((await rows()).map(row => row.text)).toEqual(keys.map(id => `second:${id}`));
    for (const id of keys) expect(await pluginSnapshotValue(owner, snapshot, 'Items', { id }, 'text')).toBe(`first:${id}`);
  } finally { await owner.close(); }
}, 300_000);

test('a successful empty plan retracts every prior key', async () => {
  const { f, owner, run, rows } = await open();
  try {
    expect((await run('before-empty')).state).toBe('succeeded');
    expect(await rows()).toHaveLength(3);
    f.change('empty', 'empty');
    expect((await run('empty')).state).toBe('succeeded');
    expect(await rows()).toEqual([]);
    expect(await readProducerOutcomes(owner, { runId: 'empty' })).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'Items', outcome: 'empty', produced: 0 })]));
  } finally { await owner.close(); }
}, 300_000);

test('a partition cannot publish a key outside its exact selected keys', async () => {
  const { f, owner, run, rows } = await open();
  try {
    expect((await run('before-outside')).state).toBe('succeeded');
    const before = await rows();
    f.change('outside', 'outside');
    expect((await run('outside')).state).not.toBe('succeeded');
    expect(await rows()).toEqual(before);
    expect((await rows()).some(row => row.id === 'forbidden')).toBe(false);
  } finally { await owner.close(); }
}, 300_000);
