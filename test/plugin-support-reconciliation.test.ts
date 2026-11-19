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
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { closureOf } from '../src/plugin/closure.js';
import { runFill } from '../src/fill/run.js';
import { readKindAssertions } from '../src/graph/records.js';
import { loadAssertions } from '../src/graph/assertion-read.js';
import { createHash } from 'node:crypto';
import { readProgress } from '../src/graph/fill-orchestration.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const git = (folder: string, ...args: string[]) => execFileSync('git', ['-C', folder, ...args], { stdio: 'pipe' });
const field = (name: string) => ({ name, type: 'text', meaning: name, example: name, required: true });

test('complete plugin turns retire old support relations but preserve immutable evidence bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-support-reconciliation-'));
  const owner = await createTestDatabaseOwner({ btreeGist: true });
  try {
    const repo = join(root, 'repo'); mkdirSync(repo);
    writeFileSync(join(repo, 'source.txt'), 'source');
    git(repo, 'init', '-q', '-b', 'main'); git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'source');
    const home = join(root, 'home'); mkdirSync(home);
    const product = makeProduct(home, 'support', repo, 'repo'); seedStarterSet(product);
    const plugin = join(product, 'plugins/support'); mkdirSync(plugin, { recursive: true });
    const edge = { kind: 'Fixture.snapshot-about', from: 'Fixture.snapshot', to: 'Fixture.file', cardinality: { from: 'many', to: 'many' }, labels: { en: { out: 'about', in: 'snapshot' }, ru: { out: 'about', in: 'snapshot' } } };
    const immutable = { immutable: true, digestField: 'digest', contentField: 'content', digestAlgorithm: 'sha256' };
    const outputs = { vertices: [
      { kind: 'Fixture.fact', key: ['id'], fields: ['id', 'text'].map(field) },
      { kind: 'Fixture.file', key: ['path'], fields: [field('path')] },
      { kind: 'Fixture.snapshot', key: ['digest'], fields: ['digest', 'content'].map(field), evidence: immutable },
    ], edges: [edge] };
    writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({ name: 'support', version: '1.0.0', entry: 'main.js', runtime: { name: 'bun', version: Bun.version }, produces: [{ kind: 'Fixture.file', fields: '*', reads: [] }, { kind: 'Fixture.fact', fields: '*', reads: ['Fixture.file'], support: { vertices: ['Fixture.snapshot'], edges: ['Fixture.snapshot-about'] } }] }));
    writeFileSync(join(plugin, 'contract.json'), JSON.stringify({ id: 'support', version: '1.0.0', outputs, rights: { network: 'none', graph: true, graphReads: ['files', 'value', 'ownFacts'] } }));
    writeFileSync(join(plugin, 'main.js'), `import { definePlugin } from 'madarch-plugin-sdk';
import { content } from './scenario.js';
import { createHash } from 'node:crypto';
await definePlugin({name:'support',version:'1.0.0',contract:${JSON.stringify(outputs)},async extract(unit,context){
if(unit.kind==='Fixture.file'){ await context.facts.apply('file',{vertices:[{kind:'Fixture.file',key:{path:'source.txt'}}]}); return {end:{state:'complete'}}; }
const digest=createHash('sha256').update(content).digest('hex');
const snapshot={kind:'Fixture.snapshot',key:{digest}};
const file={kind:'Fixture.file',key:{path:'source.txt'}};
await context.facts.apply('publish',{vertices:[{...snapshot,values:{content}},{kind:'Fixture.fact',key:{id:'fact'},values:{text:content},evidence:{target:snapshot}}],edges:[{kind:'Fixture.snapshot-about',from:snapshot,to:file}]});
return {end:{state:'complete'}};
}});`);
    writeFolderManifest(product, stringify({ language: 'en', kinds: {
      'Fixture.fact': { source: 'graph', 'derives-from': ['Fixture.file'], key: ['id'], fields: ['id', 'text'].map(name => ({ name, type: 'text' })) },
      'Fixture.file': { source: 'graph', key: ['path'], fields: [{ name: 'path', type: 'text', producers: ['support'] }] },
      'Fixture.snapshot': { source: 'graph', key: ['digest'], fields: ['digest', 'content'].map(name => ({ name, type: 'text', producers: ['support'] })), evidence: immutable },
    }, edges: [{ name: edge.kind, from: ['Fixture.snapshot'], to: ['Fixture.file'], cardinality: { from: { min: 0, max: null }, to: { min: 0, max: null } }, labels: edge.labels }], plugins: [{ id: 'support', version: 1, path: 'plugins/support', inputs: [], outputs: ['Fixture.file', 'Fixture.fact'], closure: ['plugins/support/plugin.json', 'plugins/support/contract.json', 'plugins/support/main.js', 'plugins/support/scenario.js'] }] }));
    const run = async (id: string, content: string) => {
      writeFileSync(join(plugin, 'scenario.js'), `export const content=${JSON.stringify(content)};`);
      const closure = closureOf(plugin).hash;
      writeFileSync(join(product, 'madarch/plugins.lock'), stringify({ plugins: [{ id: 'support', path: 'plugins/support', version: '1.0.0', closure }] }));
      git(product, 'add', '-A'); git(product, '-c', 'user.name=Fixture', '-c', 'user.email=f@example.invalid', 'commit', '-qm', id);
      const contract = await readPinnedGraphContract(product);
      await prepareTestStore(owner, { contract });
      const result = await runFill({ sink: event => { if (event.kind === 'unit-failed' || event.kind === 'unit-blocked') console.error(event.summary); }, product, database: owner, home, runId: id, releaseHashes: [closure], targets: { kinds: ['Fixture.fact'] }, steps: ['plugin-turns'], prepareContract: async contract => { await prepareTestStore(owner, { contract }); } });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(JSON.stringify(result));
      if (result.state !== 'succeeded') throw new Error(JSON.stringify({ result, progress: await readProgress(owner, id) }));
      expect(result.state).toBe('succeeded');
    };
    const first = 'Original immutable bytes'; const second = 'Replacement immutable bytes';
    await run('first', first);
    const before = await owner.run(tx => loadAssertions(tx, 'vertex', 'Fixture.fact', ['text']));
    expect(before).toHaveLength(1);
    const oldEvidence = before[0]!.evidence;
    expect(oldEvidence).toHaveLength(1);
    await run('second', second);
    const contract = await readPinnedGraphContract(product);
    const blobs = await owner.run(tx => readKindAssertions(tx, 'vertex', 'Fixture.snapshot', ['content'], { contract }));
    expect(blobs.map(blob => [blob.key['digest'], blob.values['content']]).sort()).toEqual([[hash(first), first], [hash(second), second]].sort());
    const about = await owner.run(tx => readKindAssertions(tx, 'edge', 'Fixture.snapshot-about', [], { contract }));
    expect(about).toHaveLength(1);
    expect(about[0]!.from).toBe(blobs.find(blob => blob.key['digest'] === hash(second))!.id);
    const after = await owner.run(tx => loadAssertions(tx, 'vertex', 'Fixture.fact', ['text']));
    expect(after.find(assertion => assertion.id === before[0]!.id)?.evidence).toEqual(oldEvidence);
    expect(oldEvidence).toEqual([blobs.find(blob => blob.key['digest'] === hash(first))!.uid]);
    const relationHistory = await owner.run(tx => loadAssertions(tx, 'edge', 'Fixture.snapshot-about', ['$exists']));
    expect(relationHistory.some(assertion => assertion.operation === 'retract')).toBe(true);
  } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); }
}, 120_000);
