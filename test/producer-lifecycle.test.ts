import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeProduct } from './knowledge-fixture.js';
import { seedStarterSet } from '../src/knowledge/seed.js';
import { createTestDatabaseOwner } from './test-database.js';
import { prepareStore } from '../src/adapters/prepare-store.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { closureOf } from '../src/plugin/closure.js';
import { runFill } from '../src/fill/run.js';
import { readProducerOutcomes } from '../src/graph/producer-outcomes.js';
import { generatedTableName } from '../src/graph/contract.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { successfulPluginSnapshot } from '../src/graph/plugin-turns.js';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { productStoreFolder, storeDatabasePath } from '../src/product/store.js';

let folder = '';
afterAll(() => { if (folder) rmSync(folder, { recursive: true, force: true }); });

/** Real SDK process, ordinary authored Document producer and ordinary Problem check. No model. */
test('scripted Document and Problem producers publish, abstain, fail, retract and retain run outcomes', async () => {
  folder = mkdtempSync(join(tmpdir(), 'madarch-producer-lifecycle-'));
  const repo = join(folder, 'repo');
  mkdirSync(repo);
  writeFileSync(join(repo, 'source.md'), 'An authored document.\n');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'source');
  const home = join(folder, 'home'); mkdirSync(home);
  const product = makeProduct(home, 'lifecycle', repo, 'repo'); seedStarterSet(product);
  const plugin = join(product, 'plugins', 'lifecycle'); mkdirSync(plugin, { recursive: true });
  const field = (name: string) => ({ name, type: 'text', meaning: name, example: name, required: true });
  const contract = { vertices: [
    { kind: 'Document', key: ['id'], fields: [field('id'), field('condition')] },
    { kind: 'Problem', key: ['id'], fields: [field('id'), field('title'), { ...field('detail'), required: false }] },
  ], edges: [] };
  writeFileSync(join(plugin, 'contract.json'), JSON.stringify({ id: 'lifecycle', version: '1.0.0', reads: 'whole-graph', outputs: contract, rights: { network: 'none', graph: true, graphReads: ['value'] } }));
  writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({ name: 'lifecycle', version: '1.0.0', entry: 'main.ts', runtime: { name: 'bun', version: '1.4.2' }, produces: [
    { kind: 'Document', fields: '*' }, { kind: 'Problem', fields: '*', reads: ['Document'] },
  ] }));
  writeFileSync(join(product, 'madarch', 'kinds.yaml'), `language: en
kinds:
  Document:
    template: templates/item-plain.liquid
    source: graph
    fields:
      - { name: id, type: text }
      - { name: condition, type: text }
    key: [id]
  Problem:
    template: templates/item-plain.liquid
    source: graph
    findings: true
    derives-from: [Document]
    fields:
      - { name: id, type: text }
      - { name: title, type: text }
      - { name: detail, type: text, nullable: true }
    key: [id]
plugins:
  - { id: lifecycle, version: 1, path: plugins/lifecycle, inputs: [], outputs: [Document, Problem], closure: [plugins/lifecycle/contract.json, plugins/lifecycle/main.ts, plugins/lifecycle/plugin.json] }
`);
  const author = { repository: 'repo', path: 'source.md', lineStart: 1, lineEnd: 1 };
  const configure = (mode: 'bad' | 'good' | 'partial' | 'failed') => {
    writeFileSync(join(plugin, 'main.ts'), `import { definePlugin } from 'madarch-plugin-sdk';
await definePlugin({name:'lifecycle', version:'1.0.0', reads:'whole-graph', graph:true, graphReads:['value'], contract:${JSON.stringify(contract)},
async extract(unit, context) {
  if (unit.kind === 'Document') return {vertices:[{kind:'Document',key:{id:'source'},values:{condition:${JSON.stringify(mode)}},evidence:${JSON.stringify(author)}}],end:{state:'complete'}};
  const mode = await context.graph.value('Document', {id:'source'}, 'condition');
  if (mode === 'failed') throw new Error('scripted check failure');
  if (mode === 'partial') return {vertices:[{kind:'Problem',key:{id:'uncommitted'},values:{title:'must not publish'}}],end:{state:'partial',cause:'scripted abstention'}};
  return {vertices:mode === 'bad' ? [{kind:'Problem',key:{id:'finding'},values:{title:'Bad document',detail:'grounded'},evidence:${JSON.stringify(author)}}] : [],end:{state:'complete'}};
}});`);
    const hash = closureOf(plugin).hash;
    writeFileSync(join(product, 'madarch', 'plugins.lock'), `plugins:\n  - { id: lifecycle, version: 1.0.0, closure: ${hash}, path: plugins/lifecycle }\n`);
    git(product, 'add', '-A'); git(product, '-c', 'user.name=Fixture', '-c', 'user.email=f@example.invalid', 'commit', '-qm', mode);
    return hash;
  };
  let release = configure('bad');
  const declared = readKinds(product);
  expect(declared.present).toBe(true);
  if (!declared.present) throw new Error('lifecycle kinds missing');
  expect(declared.manifest.findings).toEqual([]);
  const storeRoot = join(folder, 'store');
  const store = productStoreFolder(product, storeRoot);
  const owner = await createTestDatabaseOwner({ store: storeDatabasePath(store), btreeGist: true });
  try {
    const graph = await readPinnedGraphContract(product); await prepareStore(owner, { contract: graph });
    const run = async (runId: string) => await runFill({ product, database: owner, releaseHashes: [release], steps: ['plugin-turns'], targets: { kinds: ['Problem'] }, runId, home, store,
      prepareContract: async (held) => { await prepareStore(owner, { contract: held }); } });
    const table = generatedTableName('Problem', 'vertex');
    const problems = async () => (await owner.transaction('snapshot', async (tx) => await tx.query<{ title: string; detail: string | null; said_by: string; evidence: unknown[] }>(`SELECT title, detail, said_by, evidence FROM ${table} WHERE state='open' ORDER BY title`))).rows;
    const first = await run('bad'); expect(first.ok).toBe(true); if (!first.ok) throw new Error(JSON.stringify(first));
    expect(first.state).toBe('succeeded');
    expect(await problems()).toEqual([expect.objectContaining({ title: 'Bad document', detail: 'grounded', said_by: expect.stringContaining('lifecycle@'), evidence: expect.arrayContaining([expect.objectContaining({ path: 'source.md' })]) })]);
    const history = await readProducerOutcomes(owner, { runId: 'bad' });
    expect(history).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'Problem', outcome: 'completed', produced: 1 })]));
    const cached = await run('cached'); expect(cached.ok).toBe(true);
    expect(await readProducerOutcomes(owner, { runId: 'cached' })).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'Problem', outcome: 'unchanged' })]));
    const inherited = await successfulPluginSnapshot(owner, 'cached', 'lifecycle:Document');
    expect(inherited).toEqual(expect.objectContaining({ runId: 'bad' }));
    // A scoped replacement and omission keep another field of this producer and another producer's opinion.
    await owner.transaction('write', async (tx) => await publishGraphDrafts(tx, graph, { vertices: [
      { kind: 'Problem', key: { id: 'finding' }, values: { title: 'Scoped', detail: 'outside scope' }, producer: 'lifecycle', producerVersion: '1.0.0' },
      { kind: 'Problem', key: { id: 'finding' }, values: { title: 'Other' }, producer: 'other', producerVersion: '1' },
    ], removals: [] }));
    await owner.transaction('write', async (tx) => await publishGraphDrafts(tx, graph, { vertices: [
      { kind: 'Problem', key: { id: 'finding' }, values: { title: 'Replaced' }, selectedFields: ['title'], producer: 'lifecycle', producerVersion: '2' },
    ], removals: [] }));
    expect(await problems()).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Replaced', detail: 'outside scope' }), expect.objectContaining({ title: 'Other' })]));
    await owner.transaction('write', async (tx) => await publishGraphDrafts(tx, graph, { vertices: [], removals: [
      { kind: 'Problem', key: { id: 'finding' }, selectedFields: ['title'], producer: 'lifecycle' },
    ] }));
    expect(await problems()).toEqual(expect.arrayContaining([expect.objectContaining({ title: null, detail: 'outside scope' }), expect.objectContaining({ title: 'Other' })]));
    // Remove the additional test producer; the actual check still owns its prior finding.
    await owner.transaction('write', async (tx) => await publishGraphDrafts(tx, graph, { vertices: [], removals: [{ kind: 'Problem', key: { id: 'finding' }, producer: 'other' }] }));
    release = configure('partial'); const partial = await run('partial'); expect(partial.ok).toBe(true);
    expect(await readProducerOutcomes(owner, { runId: 'partial' })).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'Problem', outcome: 'abstained' })]));
    expect((await problems()).map((row) => row.detail)).toEqual(['outside scope']);
    release = configure('good'); const clean = await run('good'); expect(clean.ok).toBe(true);
    expect(await problems()).toEqual([]);
    expect(await readProducerOutcomes(owner, { runId: 'good' })).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'Problem', outcome: 'empty', produced: 0 })]));
    expect(await readProducerOutcomes(owner, { runId: 'bad' })).toEqual(history);
    const reader = new KnowledgeProduct({ productFolder: product, storeRoot });
    try {
      const status = await reader.status();
      expect(status.fill.outcomes).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'Problem', outcome: 'empty', produced: 0 })]));
    } finally { await reader.close(); }
    release = configure('bad'); await run('bad-again');
    expect((await problems()).map((row) => row.title)).toEqual(['Bad document']);
    release = configure('failed'); await run('failed');
    expect(await readProducerOutcomes(owner, { runId: 'failed' })).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'Problem', outcome: 'failed' })]));
    expect((await problems()).map((row) => row.title)).toEqual(['Bad document']);
  } finally { await owner.close(); }
}, 300_000);
