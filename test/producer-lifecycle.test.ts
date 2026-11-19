import { testHostBinding } from './host-binding-fixture.js';
import { writeFolderManifest } from './catalog-folder-fixture.js';
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
import { publishGraphDrafts } from '../src/graph/write.js';
import { readKindAssertions } from '../src/graph/records.js';
import { sha256Hex } from '../src/graph/digest.js';
import { bindTestWriteCapability } from './write-capability-fixture.js';
import { activateGraphProducer, bindGraphProducer, registerGraphPrincipal, type ProducerBinding } from '../src/graph/producer-binding.js';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { retainTestStorePreparationOwner } from './prepared-server.js';

let folder = '';
afterAll(() => { if (folder) rmSync(folder, { recursive: true, force: true }); });

/** Real SDK process, ordinary authored Document producer and ordinary Problem check. No model. */
test('scripted Document and Problem producers publish, abstain, fail, retract and retain run outcomes', async () => {
  folder = mkdtempSync(join(tmpdir(), 'madarch-producer-lifecycle-'));
  const repo = join(folder, 'repo');
  mkdirSync(repo);
  const sourceContent = 'An authored document.\n';
  const sourceDigest = sha256Hex(Buffer.from(sourceContent));
  writeFileSync(join(repo, 'source.md'), sourceContent);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'source');
  const home = join(folder, 'home'); mkdirSync(home);
  const product = makeProduct(home, 'lifecycle', repo, 'repo'); seedStarterSet(product);
  const plugin = join(product, 'plugins', 'lifecycle'); mkdirSync(plugin, { recursive: true });
  const field = (name: string) => ({ name, type: 'text', meaning: name, example: name, required: true });
  const contract = { vertices: [
    { kind: 'Document', key: ['id'], fields: [field('id'), field('condition')] },
    { kind: 'FixtureProblem', key: ['id'], fields: [field('id'), field('title'), { ...field('detail'), required: false }] },
  ], edges: [] };
  writeFileSync(join(plugin, 'contract.json'), JSON.stringify({ id: 'lifecycle', version: '1.0.0', reads: 'whole-graph', outputs: contract, rights: { network: 'none', graph: true, graphReads: ['value', 'ownFacts'] } }));
  writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({ name: 'lifecycle', version: '1.0.0', entry: 'main.ts', runtime: { name: 'bun', version: '1.4.2' }, produces: [
    { kind: 'Document', fields: '*' }, { kind: 'FixtureProblem', fields: '*', reads: ['Document'] },
  ] }));
  writeFolderManifest(product, `language: en
kinds:
  Document:
    
    source: graph
    fields:
      - { name: id, type: text }
      - { name: condition, type: text }
    key: [id]
  FixtureProblem:
    
    source: graph
    findings: true
    derives-from: [Document]
    fields:
      - { name: id, type: text }
      - { name: title, type: text }
      - { name: detail, type: text, nullable: true }
    key: [id]
plugins:
  - { id: lifecycle, version: 1, path: plugins/lifecycle, inputs: [], outputs: [Document, FixtureProblem], closure: [plugins/lifecycle/contract.json, plugins/lifecycle/main.ts, plugins/lifecycle/plugin.json] }
`);
  const author = { target: { kind: 'system.content-snapshot', key: { digest: sourceDigest } }, path: 'source.md', lineStart: 1, lineEnd: 1 };
  const configure = (mode: 'bad' | 'good' | 'partial' | 'failed') => {
    writeFileSync(join(plugin, 'main.ts'), `import { definePlugin } from 'madarch-plugin-sdk';
await definePlugin({name:'lifecycle', version:'1.0.0', reads:'whole-graph', graph:true, graphReads:['value'], contract:${JSON.stringify(contract)},
async extract(unit, context) {
  if (unit.kind === 'Document') return {vertices:[{kind:'Document',key:{id:'source'},values:{condition:${JSON.stringify(mode)}},evidence:${JSON.stringify(author)}}],end:{state:'complete'}};
  const mode = await context.graph.value('Document', {id:'source'}, 'condition');
  if (mode === 'failed') throw new Error('scripted check failure');
  if (mode === 'partial') return {vertices:[{kind:'FixtureProblem',key:{id:'partial-answer'},values:{title:'Partial finding'}}],end:{state:'partial',cause:'scripted abstention'}};
  return {vertices:mode === 'bad' ? [{kind:'FixtureProblem',key:{id:'finding'},values:{title:'Bad document',detail:'grounded'},evidence:${JSON.stringify(author)}}] : [],end:{state:'complete'}};
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
    // The evidence is immutable content: the source the check read stands as one snapshot, and every opinion names it.
    await owner.transaction('write', async (tx) => {
      await bindTestWriteCapability(tx, graph);
      await publishGraphDrafts(tx, graph, { vertices: [{ kind: 'system.content-snapshot', key: { digest: sourceDigest }, values: { content: sourceContent }, producer: 'fixture', producerVersion: '1' }], removals: [] });
    });
    const run = async (runId: string) => await runFill({ product, database: owner, releaseHashes: [release], steps: ['plugin-turns'], targets: { kinds: ['FixtureProblem'] }, runId, home, store,
      prepareContract: async (held) => { await prepareStore(owner, { contract: held }); } });
    // One row per producing plugin, as the opinion read shows it: every opinion the plugin still holds of the entity,
    // with the title and detail it states and the evidence what it states stands on.
    const problems = async () => await owner.transaction('snapshot', async (tx) => {
      const sources = new Map((await readKindAssertions(tx, 'vertex', 'plugin', ['label', 'version'], { contract: graph })).map((row) => [row.uid, { label: String(row.values['label']), said: `${String(row.values['label'])}@${String(row.values['version'])}` }]));
      const evidenceOf = (assertion: { evidenceAttachments: readonly { targetUid: string; locator: string; key: Record<string, unknown> }[] } | undefined) => assertion?.evidenceAttachments.map((attachment) => {
        const held = JSON.parse(attachment.locator) as { locator?: Record<string, unknown>; relation?: string };
        return { ...(held.locator ?? {}), targetUid: attachment.targetUid, key: attachment.key, relation: held.relation };
      }) ?? [];
      const rows = (await readKindAssertions(tx, 'vertex', 'FixtureProblem', ['title', 'detail'], { contract: graph })).flatMap((row) => {
        const held = new Map<string, { title: string | null; detail: string | null; said_by: string; evidence: unknown[] }>();
        for (const assertion of row.assertions) {
          if (assertion.active !== true || assertion.operation !== 'assert' || (assertion.property !== 'title' && assertion.property !== 'detail')) continue;
          const source = sources.get(assertion.source);
          const identity = source?.said ?? assertion.source;
          const opinion = held.get(identity) ?? { title: null, detail: null, said_by: identity, evidence: [] };
          if (assertion.property === 'title') { opinion.title = assertion.value as string | null; opinion.evidence = evidenceOf(assertion); }
          else opinion.detail = assertion.value as string | null;
          held.set(identity, opinion);
        }
        return [...held.values()];
      });
      return rows.sort((left, right) => left.title === right.title ? 0 : left.title === null ? 1 : right.title === null ? -1 : left.title < right.title ? -1 : 1);
    });
    const first = await run('bad'); expect(first.ok).toBe(true); if (!first.ok) throw new Error(JSON.stringify(first));
    if (first.state !== 'succeeded') throw new Error(`fill failed: ${JSON.stringify(first)} outcomes: ${JSON.stringify(await readProducerOutcomes(owner, { runId: 'bad' }))}`);
    expect(first.state).toBe('succeeded');
    expect(await problems()).toEqual([expect.objectContaining({ title: 'Bad document', detail: 'grounded', said_by: expect.stringContaining('lifecycle@'), evidence: expect.arrayContaining([expect.objectContaining({ path: 'source.md' })]) })]);
    const history = await readProducerOutcomes(owner, { runId: 'bad' });
    expect(history).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'FixtureProblem', outcome: 'completed', produced: 1 })]));
    const cached = await run('cached'); expect(cached.ok).toBe(true);
    expect(await readProducerOutcomes(owner, { runId: 'cached' })).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'FixtureProblem', outcome: 'unchanged' })]));
    const publishAs = async (binding: ProducerBinding, drafts: Parameters<typeof publishGraphDrafts>[2]) => await owner.transaction('write', async (tx) => {
      await activateGraphProducer(tx, graph, binding);
      await publishGraphDrafts(tx, graph, drafts);
    });
    // A scoped replacement and omission keep another field of this producer and another producer's opinion. The plugin's
    // own installed source states them, so the replacement is the producer's own new opinion and not a second source's.
    const installed = async (label: string): Promise<ProducerBinding> => {
      const rows = await owner.transaction('snapshot', async (tx) => await readKindAssertions(tx, 'vertex', 'plugin', ['label', 'version', 'scope'], { contract: graph }));
      const held = rows.find((row) => row.values['label'] === label);
      if (held === undefined) throw new Error(`plugin source ${label} is absent`);
      const principal = await registerGraphPrincipal(owner, { producer: label, version: String(held.values['version']), uid: held.uid, kind: 'plugin', sourceUid: held.uid, principalUid: held.uid, scope: String(held.values['scope']) });
      return bindGraphProducer(owner, graph, { principal, actions: ['assert', 'retract-own'], vertices: Object.fromEntries(graph.vertex.map((kind) => [kind.name, kind.fields.map((field) => field.name)])), edges: Object.fromEntries(graph.edge.map((kind) => [kind.name, kind.fields.map((field) => field.name)])) });
    };
    const lifecycleSource = await installed('lifecycle');
    const otherOne = await testHostBinding(owner, graph, 'other', '1');
    await publishAs(lifecycleSource, { vertices: [{ kind: 'FixtureProblem', key: { id: 'finding' }, values: { title: 'Scoped', detail: 'outside scope' }, producer: 'lifecycle', producerVersion: lifecycleSource.version }], removals: [] });
    await publishAs(otherOne, { vertices: [{ kind: 'FixtureProblem', key: { id: 'finding' }, values: { title: 'Other' }, producer: 'other', producerVersion: '1' }], removals: [] });
    await publishAs(lifecycleSource, { vertices: [
      { kind: 'FixtureProblem', key: { id: 'finding' }, values: { title: 'Replaced' }, selectedFields: ['title'], producer: 'lifecycle', producerVersion: lifecycleSource.version },
    ], removals: [] });
    expect(await problems()).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Replaced', detail: 'outside scope' }), expect.objectContaining({ title: 'Other' })]));
    await publishAs(lifecycleSource, { vertices: [], removals: [
      { kind: 'FixtureProblem', key: { id: 'finding' }, selectedFields: ['title'], producer: 'lifecycle' },
    ] });
    expect(await problems()).toEqual(expect.arrayContaining([expect.objectContaining({ title: null, detail: 'outside scope' }), expect.objectContaining({ title: 'Other' })]));
    // Remove the additional test producer; the actual check still owns its prior finding.
    await publishAs(otherOne, { vertices: [], removals: [{ kind: 'FixtureProblem', key: { id: 'finding' }, producer: 'other' }] });
    release = configure('partial'); const partial = await run('partial'); expect(partial.ok).toBe(true);
    // The owner's rule (2026-11-15): a partial answer keeps every entry it holds, so the Problem it states is published
    // and the outcome names the cause; only an answer that holds nothing abstains.
    expect(await readProducerOutcomes(owner, { runId: 'partial' })).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'FixtureProblem', outcome: 'completed', produced: 1, reason: 'scripted abstention' })]));
    expect((await problems()).map((row) => row.title as string | null)).toEqual(['Partial finding', null]);
    release = configure('good'); const clean = await run('good'); expect(clean.ok).toBe(true);
    expect(await problems()).toEqual([]);
    // The entries a complete answer retires are entries it committed (a2c14d9f0): the empty answer clears the finding's
    // existence and the detail it held, so the outcome is completed, and the graph holds no problem of it.
    expect(await readProducerOutcomes(owner, { runId: 'good' })).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'FixtureProblem', outcome: 'completed', produced: 2 })]));
    expect(await readProducerOutcomes(owner, { runId: 'bad' })).toEqual(history);
    const releasePreparation = await retainTestStorePreparationOwner();
    const reader = new KnowledgeProduct({ productFolder: product, storeRoot });
    try {
      const status = await reader.status();
      expect(status.fill.outcomes).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'FixtureProblem', outcome: 'completed', produced: 2 })]));
    } finally { await reader.close(); await releasePreparation(); }
    release = configure('bad'); await run('bad-again');
    expect((await problems()).map((row) => row.title)).toEqual(['Bad document']);
    release = configure('failed'); await run('failed');
    expect(await readProducerOutcomes(owner, { runId: 'failed' })).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'FixtureProblem', outcome: 'failed' })]));
    expect((await problems()).map((row) => row.title)).toEqual(['Bad document']);
  } finally { await owner.close(); }
}, 300_000);
