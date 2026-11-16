import { writeFolderManifest } from './catalog-folder-fixture.js';
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { makeProduct } from './knowledge-fixture.js';
import { seedStarterSet } from '../src/knowledge/seed.js';
import { createTestDatabaseOwner, prepareTestStore } from './test-database.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { closureOf } from '../src/plugin/closure.js';
import { runFill } from '../src/fill/run.js';
import { sha256Hex } from '../src/graph/digest.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { bindTestWriteCapability } from './write-capability-fixture.js';
import { readProgress } from '../src/graph/fill-orchestration.js';
import { readKindAssertions } from '../src/graph/records.js';
import { readProducerOutcomes } from '../src/graph/producer-outcomes.js';
import { successfulPluginSnapshot, pluginSnapshotVertices } from '../src/graph/plugin-turns.js';

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const field = (name: string) => ({ name, type: 'text', meaning: name, example: name, required: true });
type Mode = 'normal' | 'large' | 'fail-second' | 'empty' | 'outside';
const keys = Array.from({ length: 23 }, (_, index) => String.fromCharCode(97 + index));
const textBytes = 400_000;
const sourceContent = 'Partition source.\n';
const sourceDigest = sha256Hex(Buffer.from(sourceContent));
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
  writeFileSync(join(plugin, 'contract.json'), JSON.stringify({ id: 'partitions', version: '1.0.0', outputs: contract, rights: { network: 'none', graph: true, graphReads: ['value', 'ownFacts'] } }));
  writeFileSync(join(plugin, 'main.js'), `import { definePlugin } from 'madarch-plugin-sdk';
import { mode, revision } from './scenario.js';
const contract=${JSON.stringify(contract)};
await definePlugin({ name:'partitions', version:'1.0.0', contract, graph:true, graphReads:['value'],
  planOutput() { return {partitions: mode === 'empty' ? [] : ${JSON.stringify(keys)}.map(id => ({keys:[{id}]}))}; },
  async extract(unit, context) {
    const evidence={target:{kind:'system.content-snapshot',key:{digest:${JSON.stringify(sourceDigest)}}},digest:${JSON.stringify(sourceDigest)},path:'source.md',lineStart:1,lineEnd:1};
    if(unit.kind==='Summary') {
      const text=await context.graph.value('Items',{id:'a'},'text');
      await context.facts.apply('summary',{vertices:[{kind:'Summary',key:{id:'summary'},values:{text},evidence}]});
      return {end:{state:'complete'}};
    }
    const selected=unit.inputs.keys;
    if(!Array.isArray(selected)) throw new Error('extract must receive exact partition keys');
    if(mode==='fail-second' && selected.some(key=>key.id==='b')) throw new Error('second partition refused');
    const vertices=mode==='empty' ? [] : selected.map(key=>({kind:'Items',key:mode==='outside'?{id:'forbidden'}:key,
      values:{text:mode==='large'?key.id.repeat(${textBytes}):revision+':'+key.id},evidence}));
    for (const vertex of vertices) await context.facts.apply('item:'+vertex.key.id,{vertices:[vertex]});
    return {end:{state:'complete'}};
  }
});`);
  const kinds = Object.fromEntries(['Items', 'Summary'].map(kind => [kind, { source: 'graph', 'derives-from': kind === 'Summary' ? ['Items'] : [], key: ['id'], fields: ['id', 'text'].map(name => ({ name, type: 'text' })) }]));
  writeFolderManifest(product, stringify({ language: 'en', kinds, plugins: [{ id: 'partitions', version: 1, path: 'plugins/partitions', inputs: ['Items'], outputs: ['Items', 'Summary'], closure: ['plugins/partitions/plugin.json', 'plugins/partitions/contract.json', 'plugins/partitions/main.js', 'plugins/partitions/scenario.js'] }] }));
  let releaseHashes: string[] = [];
  function change(mode: Mode, revision: string, releaseNote = revision) {
    writeFileSync(join(plugin, 'scenario.js'), `export const mode=${JSON.stringify(mode)}; export const revision=${JSON.stringify(revision)}; // ${releaseNote}\n`);
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
  const contract = await readPinnedGraphContract(f.product);
  await prepareTestStore(owner, { contract });
  await owner.transaction('write', async tx => {
    await bindTestWriteCapability(tx, contract);
    await publishGraphDrafts(tx, contract, { vertices: [{ kind:'system.content-snapshot', key:{digest:sourceDigest}, values:{content:sourceContent}, producer:'fixture', producerVersion:'1' }], removals:[] });
  });
  const run = async (id: string, target = 'Items') => {
    const result = await runFill({ product: f.product, database: owner, home: f.home, runId: id, releaseHashes: f.releaseHashes,
      targets: { kinds: [target] }, steps: ['plugin-turns'], prepareContract: async contract => { await prepareTestStore(owner, { contract }); } });
    if (!result.ok) throw new Error(JSON.stringify(result));
    return result;
  };
  const rows = async (kind = 'Items') => owner.transaction('snapshot',async tx=>(await readKindAssertions(tx,'vertex',kind,['text'])).map(row=>({id:String(row.key['id']),text:String(row.values['text'])})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0));
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
    for (const row of actual) expect(row.text).toBe(row.id.repeat(textBytes));
    expect(await readProducerOutcomes(owner, { runId: 'large' })).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'Items', outcome: 'completed', produced: keys.length })]));
  } finally { await owner.close(); }
}, 300_000);

test('a failed partition retains prior and accepted facts but blocks dependants', async () => {
  const { f, owner, run, rows } = await open();
  try {
    expect((await run('prior')).state).toBe('succeeded');
    const before = await rows();
    f.change('fail-second', 'replacement');
    const failed = await run('failed', 'Summary');
    expect(failed.state).not.toBe('succeeded');
    expect(failed.units.some(unit => unit.unitId.startsWith('plugin-turns/partitions:Items#') && unit.attempts > 0 && unit.state === 'failed')).toBe(true);
    expect((await readProgress(owner,'failed')).some(event=>event.kind==='unit-failed' && event.summary.includes('second partition refused'))).toBe(true);
    // Accepted partitions remain visible even when a later partition fails.
    expect(await rows()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'a', text: 'replacement:a' }),
      expect.objectContaining({ id: 'b', text: 'first:b' }),
    ]));
    expect(await rows('Summary')).toEqual([]);
    // The facts the earlier run published are still the earlier run's: nothing retracted them.
    expect(before.length).toBe(keys.length);
    const outcomes = await readProducerOutcomes(owner, { runId: 'failed' });
    expect(outcomes.some(outcome => outcome.kind === 'Summary' && outcome.outcome === 'completed')).toBe(false);
  } finally { await owner.close(); }
}, 300_000);

test('a named successful snapshot keeps every earlier partition after a later publication', async () => {
  const { f, owner, run, rows } = await open();
  try {
    expect((await run('snapshot-first')).state).toBe('succeeded');
    const snapshot = await successfulPluginSnapshot(owner, 'snapshot-first', 'partitions:Items');
    expect(snapshot.unitUid).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.keys(snapshot).sort()).toEqual(['recordedAt', 'unitUid', 'validAt']);
    expect(Number.isFinite(Date.parse(snapshot.recordedAt))).toBe(true);
    expect(Number.isFinite(Date.parse(snapshot.validAt))).toBe(true);
    const captured = { ...snapshot };
    f.change('normal', 'second');
    expect((await run('snapshot-second')).state).toBe('succeeded');
    expect((await rows()).map(row => row.text)).toEqual(keys.map(id => `second:${id}`));
    const snapshotVertices = await pluginSnapshotVertices(owner, snapshot, 'Items');
    expect(snapshot).toEqual(captured);
    for (const id of keys) expect(snapshotVertices.find(vertex => vertex.key['id'] === id)?.values['text']).toBe(`first:${id}`);
    expect(snapshotVertices.map(vertex => [vertex.key['id'], vertex.values['text']]).sort((a,b)=>String(a[0])<String(b[0])?-1:String(a[0])>String(b[0])?1:0))
      .toEqual(keys.map(id => [id, `first:${id}`]));
  } finally { await owner.close(); }
}, 300_000);

test('a successful empty plan retracts every prior key', async () => {
  const { f, owner, run, rows } = await open();
  try {
    expect((await run('before-empty')).state).toBe('succeeded');
    expect(await rows()).toHaveLength(keys.length);
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
    const failed = await run('outside');
    expect(failed.state).not.toBe('succeeded');
    expect(failed.units.some(unit => unit.unitId.startsWith('plugin-turns/partitions:Items#') && unit.attempts > 0 && unit.state === 'failed')).toBe(true);
    expect((await readProgress(owner,'outside')).some(event=>event.kind==='unit-failed' && event.summary.includes('outside selected partition keys'))).toBe(true);
    expect(await rows()).toEqual(before);
    expect((await rows()).some(row => row.id === 'forbidden')).toBe(false);
  } finally { await owner.close(); }
}, 300_000);
