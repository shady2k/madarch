import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { writeFolderManifest } from './catalog-folder-fixture.js';
import { makeProduct } from './knowledge-fixture.js';
import { seedStarterSet } from '../src/knowledge/seed.js';
import { createTestDatabaseOwner, prepareTestStore } from './test-database.js';
import { bindTestWriteCapability } from './write-capability-fixture.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { closureOf } from '../src/plugin/closure.js';
import { runFill } from '../src/fill/run.js';
import { readKindAssertions } from '../src/graph/records.js';
import { loadAssertions } from '../src/graph/assertion-read.js';
import { readProgress } from '../src/graph/fill-orchestration.js';

const git = (folder: string, ...args: string[]) => execFileSync('git', ['-C', folder, ...args], { stdio: 'pipe' });
const field = (name: string) => ({ name, type: 'text', meaning: name, example: name, required: true });
const from = { kind: 'Fixture.left', key: { id: 'left' } };
const to = { kind: 'Fixture.right', key: { id: 'right' } };

test('the last output turn retracts a stale non-support edge between two foreign kinds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-edge-owner-'));
  const owner = await createTestDatabaseOwner({ btreeGist: true });
  try {
    const repo = join(root, 'repo'); mkdirSync(repo);
    writeFileSync(join(repo, 'source.txt'), 'source');
    git(repo, 'init', '-q', '-b', 'main'); git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'source');
    const home = join(root, 'home'); mkdirSync(home);
    const product = makeProduct(home, 'edge-owner', repo, 'repo'); seedStarterSet(product);
    const plugin = join(product, 'plugins/edge-owner'); mkdirSync(plugin, { recursive: true });
    const edge = { kind: 'Fixture.foreign-link', from: from.kind, to: to.kind, cardinality: { from: 'many', to: 'many' }, labels: { en: { out: 'links', in: 'linked by' }, ru: { out: 'links', in: 'linked by' } } };
    const outputKinds = ['Fixture.first', 'Fixture.last'];
    const outputs = { vertices: outputKinds.map(kind => ({ kind, key: ['id'], fields: [field('id')] })), edges: [edge] };
    writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({ name: 'edge-owner', version: '1.0.0', entry: 'main.js', runtime: { name: 'bun', version: Bun.version }, produces: [
      { kind: 'Fixture.first', fields: '*', reads: [] },
      { kind: 'Fixture.last', fields: '*', reads: ['Fixture.first', from.kind, to.kind] },
    ] }));
    writeFileSync(join(plugin, 'contract.json'), JSON.stringify({ id: 'edge-owner', version: '1.0.0', outputs, rights: { network: 'none', graph: true, graphReads: ['files', 'value', 'ownFacts'] } }));
    writeFileSync(join(plugin, 'main.js'), `import { definePlugin } from 'madarch-plugin-sdk';
import { includeEdge } from './scenario.js';
await definePlugin({name:'edge-owner',version:'1.0.0',contract:${JSON.stringify(outputs)},async extract(unit,context){
await context.facts.apply('publish',{vertices:[{kind:unit.kind,key:{id:unit.kind}}],edges:unit.kind==='Fixture.last' && includeEdge ? [{kind:'Fixture.foreign-link',from:${JSON.stringify(from)},to:${JSON.stringify(to)}}] : []});
return {end:{state:'complete'}};
}});`);
    const kinds = Object.fromEntries([...outputKinds, from.kind, to.kind].map(kind => [kind, { source: 'graph', ...(kind === 'Fixture.last' ? { 'derives-from': ['Fixture.first', from.kind, to.kind] } : {}), key: ['id'], fields: [{ name: 'id', type: 'text', ...(!outputKinds.includes(kind) ? { producers: ['person'] } : {}) }] }]));
    writeFolderManifest(product, stringify({ language: 'en', kinds, edges: [{ name: edge.kind, from: [from.kind], to: [to.kind], cardinality: { from: { min: 0, max: null }, to: { min: 0, max: null } }, labels: edge.labels }], plugins: [{ id: 'edge-owner', version: 1, path: 'plugins/edge-owner', inputs: [from.kind, to.kind], outputs: outputKinds, closure: ['plugins/edge-owner/plugin.json', 'plugins/edge-owner/contract.json', 'plugins/edge-owner/main.js', 'plugins/edge-owner/scenario.js'] }] }));
    const run = async (id: string, includeEdge: boolean) => {
      writeFileSync(join(plugin, 'scenario.js'), `export const includeEdge=${includeEdge};`);
      const closure = closureOf(plugin).hash;
      writeFileSync(join(product, 'madarch/plugins.lock'), stringify({ plugins: [{ id: 'edge-owner', path: 'plugins/edge-owner', version: '1.0.0', closure }] }));
      git(product, 'add', '-A'); git(product, '-c', 'user.name=Fixture', '-c', 'user.email=f@example.invalid', 'commit', '-qm', id);
      const contract = await readPinnedGraphContract(product);
      await prepareTestStore(owner, { contract });
      if (includeEdge) await owner.transaction('write', async tx => {
        await bindTestWriteCapability(tx, contract);
        await publishGraphDrafts(tx, contract, { vertices: [from, to].map(ref => ({ ...ref, producer: 'fixture', producerVersion: '1' })), removals: [] });
      });
      const result = await runFill({ product, database: owner, home, runId: id, releaseHashes: [closure], targets: { kinds: ['Fixture.last'] }, steps: ['plugin-turns'], prepareContract: async contract => { await prepareTestStore(owner, { contract }); } });
      if (!result.ok) throw new Error(JSON.stringify(result));
      if (result.state !== 'succeeded') throw new Error(JSON.stringify({ result, progress: await readProgress(owner, id) }));
      expect(result.state).toBe('succeeded');
      return contract;
    };
    const firstContract = await run('first', true);
    const before = await owner.run(tx => readKindAssertions(tx, 'edge', edge.kind, [], { contract: firstContract }));
    expect(before).toHaveLength(1);
    const first = await owner.run(tx => readKindAssertions(tx, 'vertex', 'Fixture.first', [], { contract: firstContract }));
    const last = await owner.run(tx => readKindAssertions(tx, 'vertex', 'Fixture.last', [], { contract: firstContract }));
    expect(first).toHaveLength(1);
    expect(last).toHaveLength(1);
    const secondContract = await run('second', false);
    expect(await owner.run(tx => readKindAssertions(tx, 'edge', edge.kind, [], { contract: secondContract }))).toEqual([]);
    for (const kind of [from.kind, to.kind, ...outputKinds]) {
      expect(await owner.run(tx => readKindAssertions(tx, 'vertex', kind, [], { contract: secondContract }))).toHaveLength(1);
    }
    const history = await owner.run(tx => loadAssertions(tx, 'edge', edge.kind, ['$exists']));
    expect(history.some(assertion => assertion.operation === 'retract' && assertion.subjectId === before[0]!.id)).toBe(true);
  } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); }
}, 120_000);
