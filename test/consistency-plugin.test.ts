import { readFolderManifestText, starterManifestText, writeFolderManifest } from './catalog-folder-fixture.js';
import { useFixturePlugins, useRepositoryPlugins } from './enabled-plugins-fixture.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
/**
 * The consistency plugin's engine side (madarch-stm0.7.1): a whole-graph plugin is planned in its own stage only after
 * every plugin turn published, reads the writer's records through the host one bounded page at a time, and answers one
 * finding per problem. The plugin here is the test's own fixture, not a product's: the engine holds no product plugin.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import { createTestDatabaseOwner, prepareTestStore, type TestDatabaseOwner } from './test-database.js';
import { makeProduct } from './knowledge-fixture.js';
import { parseDocument } from 'yaml';
import { seedStarterSet } from '../src/knowledge/seed.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { planPluginTurns, type PluginTurnWiring } from '../src/fill/plugin-turns.js';
import { runFill } from '../src/fill/run.js';
import { readProducerOutcomes } from '../src/graph/producer-outcomes.js';
import { publishGraphDrafts, removeEntity } from '../src/graph/write.js';
import { removedEdgeEnds, unevidencedAssertions } from '../src/graph/index.js';
import { parsePluginLock } from '../src/plugin/lock.js';
import { generatedTableName } from '../src/graph/contract.js';
import { loadAssertions, activeExistenceSql } from '../src/graph/assertion-read.js';
import { graphContractVersion, type GraphContract } from '../src/graph/contract.js';
import { withAssertionContract } from '../src/graph/system-contract.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { installSystemSources, registerSystemSource } from '../src/graph/system-installation.js';
import { activateGraphProducer, bindGraphProducer, type ProducerBinding } from '../src/graph/producer-binding.js';
import { readKindAssertions } from '../src/graph/records.js';
import { selectAssertions } from '../src/graph/assertion-selection.js';
import { closureOf } from '../src/plugin/closure.js';
import { RELEASE_CLOSURE_HASHES } from '../src/plugin/release-closures.js';

const FIXTURE = join(import.meta.dir, 'fixtures', 'plugin-consistency');
let root = '';
let product = '';
let fixtureClosure = '';
let owner: TestDatabaseOwner | undefined;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Add the fixture plugin, its kinds, its rules and its lock to the product the test holds. */
function addConsistency(folder: string): string {
  cpSync(FIXTURE, join(folder, 'plugins', 'plugin-consistency'), { recursive: true });
  const closure = closureOf(join(folder, 'plugins', 'plugin-consistency')).hash;
  const manifest = `language: en
kinds:
  code.file:
    
    source: graph
    capability: git
  code.repository:
    
    source: graph
    capability: git
  code.directory:
    
    source: graph
    capability: git
  probe.finding:
    
    source: graph
    findings: true
    # Consistency records are read through graphReads rights, not as executable content inputs.
    derives-from: [code.file, code.repository, code.directory]
    labels:
      en: { one: Probe finding, many: Probe findings }
      ru: { one: Находка, many: Находки }
    fields:
      - { name: id, type: text, binding: "plugin-consistency@1.id" }
      - { name: rule, type: text, binding: "plugin-consistency@1.rule" }
      - { name: subject, type: text, binding: "plugin-consistency@1.subject" }
      - { name: target, type: text, nullable: true, binding: "plugin-consistency@1.target" }
      - { name: cause, type: text, binding: "plugin-consistency@1.cause" }
      - { name: severity, type: text, nullable: true, binding: "plugin-consistency@1.severity" }
    key: [id]
  probe.opinion:
    
    source: graph
    derives-from: [code.file]
    labels:
      en: { one: Probe opinion, many: Probe opinions }
      ru: { one: Утверждение, many: Утверждения }
    fields:
      - { name: id, type: text, binding: "plugin-consistency@1.id" }
      - { name: first, type: text, nullable: true, binding: "plugin-consistency@1.first" }
      - { name: second, type: text, nullable: true, binding: "plugin-consistency@1.second" }
    key: [id]
  probe.keyed:
    
    source: graph
    derives-from: [code.file]
    labels:
      en: { one: Probe keyed, many: Probe keyeds }
      ru: { one: Ключ, many: Ключи }
    fields:
      - { name: id, type: text, binding: "plugin-consistency@1.id" }
      - { name: title, type: text, binding: "plugin-consistency@1.title" }
    key: [id, title]
edges:
  - { name: code.contains, from: [code.repository, code.directory], to: [code.directory, code.file, code.gitlink], capability: git }
  - { name: code.as-is, from: [code.repository], to: [code.commit], capability: git }
plugins:
  - { id: plugin-consistency, version: 1, path: plugins/plugin-consistency, inputs: [code.file], outputs: [probe.finding, probe.opinion, probe.keyed], closure: [plugins/plugin-consistency/contract.json, plugins/plugin-consistency/main.ts, plugins/plugin-consistency/plugin.json] }
problems:
  rules:
    missing-reference: { predicate: findings, kind: missing-reference, sonar: bug, severity: major, section: code, action: task, enabled: true, label: { en: Reference to a missing key, ru: Ссылка на отсутствующий ключ } }
    dangling-reference: { predicate: findings, kind: dangling-reference, sonar: bug, severity: major, section: code, action: task, enabled: true, label: { en: Edge end names a missing key, ru: Конец ребра ссылается на отсутствующий ключ } }
    removed-end: { predicate: findings, kind: removed-end, sonar: bug, severity: major, section: code, action: task, enabled: true, label: { en: Edge ends at a removed vertex, ru: Ребро ведёт к удалённой вершине } }
    unevidenced-opinion: { predicate: findings, kind: unevidenced-opinion, sonar: bug, severity: minor, section: code, action: task, enabled: true, label: { en: Opinion without evidence, ru: Утверждение без основания } }
`;
  writeFolderManifest(folder, manifest);
  writeFileSync(join(folder, 'madarch', 'plugins.lock'), `plugins:\n  - { id: plugin-consistency, version: 1.0.0, closure: ${closure}, path: plugins/plugin-consistency }\n`);
  useRepositoryPlugins(folder);
  const declared = parseDocument(readFolderManifestText(folder));
  const starter = parseDocument(starterManifestText()).toJS();
  for (const section of ['catalog', 'value-types', 'properties', 'groups', 'purposes', 'roles']) declared.set(section, starter[section]);
  for (const name of ['code.repository', 'code.directory', 'code.file', 'code.gitlink', 'code.commit', 'code.author', 'code.blob']) declared.setIn(['kinds', name], starter.kinds[name]);
  declared.setIn(['kinds', 'probe.referrer'], {
    source: 'graph', key: ['path'], 'key-edges': [{role:'repository',edge:'probe.referrer-repository',side:'from'}],
    // The fixture writes this record itself: its fields are a person's authored write, not a plugin's.
    fields: [{ name: 'path', type: 'text', producers: ['person'] }],
  });
  declared.addIn(['edges'], {name:'probe.referrer-repository',from:['probe.referrer'],to:['code.repository'],'on-parent-delete':'restrict',cardinality:{from:{min:1,max:1},to:{min:0,max:null}},labels:{en:{out:'belongs to',in:'contains'},ru:{out:'принадлежит',in:'содержит'}}});
  const descriptions: Record<string, { en: string; ru: string }> = {
    'probe.finding': { en: 'A consistency finding emitted by the fixture plugin.', ru: 'Находка проверки согласованности тестового плагина.' },
    'probe.opinion': { en: 'An opinion with two fields requiring evidence.', ru: 'Утверждение с двумя полями, требующими основания.' },
    'probe.keyed': { en: 'An opinion identified by two key fields.', ru: 'Утверждение, определяемое двумя ключевыми полями.' },
    'probe.referrer': { en: 'A fixture record referencing a repository.', ru: 'Тестовая запись, ссылающаяся на репозиторий.' },
  };
  for (const [name, description] of Object.entries(descriptions)) {
    declared.setIn(['kinds', name], {
      ...declared.toJS().kinds[name],
      id: name, definition: description.en, description, purpose: 'quality', audience: ['developer', 'architect'],
      sources: ['https://www.w3.org/TR/prov-dm/'],
      acquisition: ['agent-from-graph'],
      'template-policy': 'page', group: starter.kinds['code.file'].group,
      'relation-constraints': { out: [], in: [] },
      ...(name === 'probe.referrer' ? { labels: {
        en: { one: 'Probe referrer', many: 'Probe referrers' },
        ru: { one: 'Тестовая ссылка', many: 'Тестовые ссылки' },
      } } : {}),
    });
  }
  writeFolderManifest(folder, declared.toString());
  // The fixture keeps the kinds its plugins fill and the records it writes itself, and no field nothing fills: the
  // starter kinds it merged last would otherwise carry the agent's field, and the product keeps no agent plugin.
  useFixturePlugins(folder, ['disk', 'git', 'plugin-consistency'], ['probe.opinion', 'probe.keyed', 'probe.referrer']);
  return closure;
}

const fixtureGrants = new WeakMap<DatabaseOwner, Map<string, { person: ProducerBinding; other: ProducerBinding }>>();

/** Retain the person's author identity while granting a second source its own assertion history. */
async function fixtureBindings(contract: GraphContract) {
  if (owner === undefined) throw new Error('the store was not opened');
  const version = graphContractVersion(contract);
  const held = fixtureGrants.get(owner);
  const existing = held?.get(version);
  if (existing !== undefined) return existing;
  const installedContract = withAssertionContract(contract);
  const { person } = await installSystemSources(owner, installedContract);
  const other = await registerSystemSource(owner, installedContract, {
    type: 'plugin', installationKey: 'fixture:other', scope: 'consistency fixture', version: '1', principalUid: person.uid,
  });
  const vertices = Object.fromEntries(['probe.opinion', 'probe.keyed', 'probe.referrer', 'code.repository'].map(name => {
    const kind = contract.vertex.find(kind => kind.name === name);
    if (kind === undefined) throw new Error(`fixture vertex ${name} is not declared`);
    return [name, kind.fields.map(field => field.name)];
  }));
  const edges = Object.fromEntries(['code.contains', 'probe.referrer-repository'].map(name => {
    const kind = contract.edge.find(kind => kind.name === name);
    if (kind === undefined) throw new Error(`fixture edge ${name} is not declared`);
    return [name, kind.fields.map(field => field.name)];
  }));
  const grants = {
    person: bindGraphProducer(owner, contract, { principal: person.principal, vertices, edges }),
    other: bindGraphProducer(owner, contract, { principal: other.principal, vertices, edges }),
  };
  const versions = held ?? new Map();
  versions.set(version, grants);
  fixtureGrants.set(owner, versions);
  return grants;
}

function fixtureReadContract(): GraphContract {
  const read = readKinds(product);
  if (!read.present) throw new Error('fixture manifest is absent');
  return withAssertionContract(withManifestContract(graphContractOf(read.manifest)));
}

/** The findings the fixture plugin stated, as the Problems page reads them. */
async function findings(): Promise<{ rule: string; subject: string; target: string; cause: string }[]> {
  if (owner === undefined) throw new Error('the store was not opened');
  return await owner.transaction('snapshot', async tx => {
    const now = new Date().toISOString();
    const options = {validAt:now,recordedAt:now,contexts:[1]};
    const ids = await tx.query<{id:number}>(`SELECT n.id FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='probe.finding' AND ${activeExistenceSql('vertex','n',['probe.finding'],options)}`);
    const fields = ['rule','subject','target','cause'] as const;
    const assertions = await loadAssertions(tx,'vertex','probe.finding',fields,ids.rows.map(row=>Number(row.id)));
    return ids.rows.map(row => Object.fromEntries(fields.map(field=>[field,selectAssertions(assertions.filter(a=>a.subjectId===Number(row.id)&&a.property===field),options).selected?.value ?? ''])) as {rule:string;subject:string;target:string;cause:string});
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-consistency-'));
  const repository = join(root, 'repo');
  mkdirSync(join(repository, 'src'), { recursive: true });
  mkdirSync(join(repository, 'docs'), { recursive: true });
  writeFileSync(join(repository, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repository, 'docs', 'glossary.md'), '# Terms\n\n- **Fill** — the one run that reads a product.\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repository });
  execFileSync('git', ['add', '-A'], { cwd: repository });
  execFileSync('git', ['-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'one'], { cwd: repository });
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  product = makeProduct(home, 'consistency', repository, 'repo');
  seedStarterSet(product);
  fixtureClosure = addConsistency(product);
  const declared = readKinds(product);
  if (!declared.present) throw new Error('fixture manifest is absent');
  expect(declared.manifest.findings).toEqual([]);
  git(product, 'add', '-A');
  git(product, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'the product');
  owner = await createTestDatabaseOwner({ authenticated:false, btreeGist: true, graphContract: graphContractOf(declared.manifest) });
});

afterAll(async () => {
  await owner?.close();
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

describe('a declared fixture plugin reads consistency records through the host', () => {
  test('unevidenced pages follow recorded write order, not UUID order, over twenty opinions', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const read = readKinds(product);
    if (!read.present) throw new Error('manifest absent');
    const contract = graphContractOf(read.manifest);
    const bindings = await fixtureBindings(contract);
    const opinion = { kind: 'probe.opinion', table: generatedTableName('probe.opinion', 'vertex'), producer: 'plugin-consistency', fields: ['second', 'first'], key: ['id'] };
    for (let repeat = 0; repeat < 20; repeat++) {
      const key = { id: `write-order-${repeat}` };
      await owner.transaction('write', async tx => {
        await activateGraphProducer(tx, contract, bindings.person);
        await publishGraphDrafts(tx, contract, {
          vertices: [{ kind: 'probe.opinion', key, values: { first: 'a', second: 'b' }, producer: 'plugin-consistency', producerVersion: '1.0.0' }],
          removals: [],
        }, 1);
      });
      await owner.transaction('write', async tx => {
        const subject = await tx.query<{ id: number }>("SELECT n.id FROM node n JOIN entity e ON e.id=n.entity_id WHERE e.name='probe.opinion' AND n.key=$1::jsonb", [JSON.stringify(key)]);
        const assertions = await loadAssertions(tx, 'vertex', 'probe.opinion', ['first', 'second'], [Number(subject.rows[0]!.id)]);
        // Fixture-only identity rewrite: preserve write sequences and force the opposite UUID order.
        await tx.query('ALTER TABLE node DISABLE TRIGGER immutable');
        for (const assertion of assertions) {
          const uid = `${assertion.property === 'first' ? 'ffffffff' : '00000000'}-0000-7000-8000-${String(repeat).padStart(12, '0')}`;
          await tx.query('UPDATE node SET uid=$1::uuid WHERE uid=$2::uuid', [uid, assertion.id]);
        }
        await tx.query('ALTER TABLE node ENABLE TRIGGER immutable');
        const written = await loadAssertions(tx, 'vertex', 'probe.opinion', ['first', 'second'], [Number(subject.rows[0]!.id)]);
        written.sort((left, right) => left.recordedSequence < right.recordedSequence ? -1 : left.recordedSequence > right.recordedSequence ? 1 : 0);
        expect(written.map(row => row.property)).toEqual(['first', 'second']);
        expect(written[0]!.id > written[1]!.id).toBe(true);
      });
      try {
        const page = await unevidencedAssertions(owner, [opinion], { limit: 1 });
        expect(page.rows.map(row => row.field)).toEqual(['first']);
        expect(page.next).toBeDefined();
        const next = await unevidencedAssertions(owner, [opinion], { after: page.next, limit: 1 });
        expect(next.rows.map(row => row.field)).toEqual(['second']);
        expect(next.next).toBeUndefined();
        expect((await unevidencedAssertions(owner, [opinion])).rows.map(row => row.field)).toEqual(['first', 'second']);
      } finally {
        await owner.transaction('write', async tx => {
          await activateGraphProducer(tx, contract, bindings.person);
          await removeEntity(tx, contract, { kind: 'probe.opinion', key, producer: 'plugin-consistency' });
        });
      }
    }
  }, 120_000);

  test('a consistent fill states no finding', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    await prepareTestStore(owner, { contract: await readPinnedGraphContract(product) });
    const preparedOwner = owner;
    const run = await runFill({ product, database: owner, releaseHashes: [...RELEASE_CLOSURE_HASHES, fixtureClosure], steps: ['plugin-turns'], runId: 'consistent', home: join(root, 'home'), prepareContract: async (contract) => { await prepareTestStore(preparedOwner, { contract }); } });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.state, JSON.stringify({run,outcomes:await readProducerOutcomes(owner,{}),diagnostics:await owner.transaction('snapshot',async tx=>readKindAssertions(tx,'vertex','system.unit',['reason','last_progress','scope','state'], { contract: fixtureReadContract() }).then(rows=>rows.map(row=>row.values)))})).toBe('succeeded');
    // The check declares its finding output and uses the ordinary plugin stage.
    expect(run.units.filter((unit) => unit.unitId.includes('plugin-consistency:probe.finding'))).toHaveLength(1);
    expect(run.units.some((unit) => unit.stageId === 'plugin-turns' && unit.unitId.startsWith('plugin-turns/disk:'))).toBe(true);
    expect(await findings()).toEqual([]);
    expect((await readProducerOutcomes(owner, { runId: 'consistent' })).filter((one) => one.plugin === 'plugin-consistency')).toEqual([expect.objectContaining({ kind: 'probe.finding', outcome: 'empty', produced: 0, generation: 1 })]);
  }, 300_000);

  test('two unevidenced fields of one entity are two findings, not one key twice', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const read = readKinds(product);
    if (!read.present) throw new Error('manifest absent');
    const contract = graphContractOf(read.manifest);
    const bindings = await fixtureBindings(contract);
    await owner.transaction('write', async (tx) => { await activateGraphProducer(tx, contract, bindings.person); return await publishGraphDrafts(tx, contract, {
      vertices: [{ kind: 'probe.opinion', key: { id: 'one' }, values: { first: 'a', second: 'b' }, producer: 'plugin-consistency', producerVersion: '1.0.0' }],
      removals: [],
    }, 1); });
    await prepareTestStore(owner, { contract: await readPinnedGraphContract(product) });
    const preparedOwner = owner;
    const run = await runFill({ product, database: owner, releaseHashes: [...RELEASE_CLOSURE_HASHES, fixtureClosure], steps: ['plugin-turns'], targets: { kinds: ['probe.finding'] }, runId: 'unevidenced', home: join(root, 'home'), prepareContract: async (contract) => { await prepareTestStore(preparedOwner, { contract }); } });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.state, JSON.stringify({run,outcomes:await readProducerOutcomes(owner,{}),diagnostics:await owner.transaction('snapshot',async tx=>readKindAssertions(tx,'vertex','system.unit',['reason','last_progress','scope','state'], { contract: fixtureReadContract() }).then(rows=>rows.map(row=>row.values)))})).toBe('succeeded');
    const found = (await findings()).filter((one) => one.rule === 'unevidenced-opinion');
    expect(found.map((one) => one.target.split(':')[1]).sort()).toEqual(['first', 'second']);
    expect(new Set(found.map((one) => one.target)).size).toBe(2);
  }, 300_000);

  test('missing parent and dangling edge writes refuse atomically rather than becoming consistency findings (0039.1,2,28)', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const read = readKinds(product);
    if (!read.present) throw new Error('manifest absent');
    const contract = graphContractOf(read.manifest);
    const bindings = await fixtureBindings(contract);
    const count = () => owner!.transaction('snapshot', async tx => (await tx.query<{count:number}>('SELECT count(*)::int AS count FROM assertion')).rows[0]!.count);
    const before = await count();
    await expect(owner.transaction('write',async tx=>{await activateGraphProducer(tx, contract, bindings.person);return await publishGraphDrafts(tx,contract,{vertices:[{kind:'probe.referrer',key:{path:'ghost.ts'},keyEdges:{repository:{kind:'code.repository',key:{name:'ghost'}}},producer:'test',producerVersion:'1'}],removals:[]});})).rejects.toThrow('REQUIRED_PARENT');
    expect(await count()).toBe(before);
    await expect(owner.transaction('write',async tx=>{await activateGraphProducer(tx, contract, bindings.person);return await publishGraphDrafts(tx,contract,{vertices:[],edges:[{kind:'code.contains',from:{kind:'code.repository',key:{name:'repo'}},to:{kind:'code.file',key:{path:'missing.ts'},keyEdges:{'code.file-repository':{kind:'code.repository',key:{name:'repo'}}}},producer:'test',producerVersion:'1'}],removals:[]});})).rejects.toThrow('MISSING_ENDPOINT');
    expect(await count()).toBe(before);
    expect((await removedEdgeEnds(owner)).rows).toEqual([]);
  },30_000);

  test('missing-parent refusal leaves no child; declaring the parent admits it, and withdrawing one source preserves another (0039.2,26)', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const read = readKinds(product); if (!read.present) throw new Error('manifest absent');
    const contract = graphContractOf(read.manifest);
    const bindings = await fixtureBindings(contract);
    const key = {path:'withdrawn.ts'};
    const keyEdges = {repository:{kind:'code.repository',key:{name:'withdrawn-parent'}}};
    const child = {kind:'probe.referrer',key,keyEdges,producer:'test',producerVersion:'1'};
    await expect(owner.transaction('write',async tx=>{await activateGraphProducer(tx, contract, bindings.person);return await publishGraphDrafts(tx,contract,{vertices:[child],removals:[]});})).rejects.toThrow('REQUIRED_PARENT');
    const stored = () => owner!.transaction('snapshot',async tx=>(await tx.query("SELECT n.id FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='probe.referrer' AND n.key->>'path'='withdrawn.ts'")).rows);
    expect(await stored()).toEqual([]);
    await owner.transaction('write',async tx=>{await activateGraphProducer(tx, contract, bindings.person);return await publishGraphDrafts(tx,contract,{vertices:[{kind:'code.repository',key:{name:'withdrawn-parent'},producer:'test',producerVersion:'1'},child],removals:[]});});
    expect(await stored()).toHaveLength(1);
    await owner.transaction('write',async tx=>{
      await activateGraphProducer(tx, contract, bindings.other);
      await publishGraphDrafts(tx,contract,{vertices:[{...child,producer:'other'}],removals:[]});
    });
    expect(await stored()).toHaveLength(1);
    await owner.transaction('write',async tx=>{await activateGraphProducer(tx, contract, bindings.person);return await removeEntity(tx,contract,{...child},1);});
    const now = new Date().toISOString();
    const selected = await owner.transaction('snapshot',async tx=>(await tx.query(`SELECT n.id FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='probe.referrer' AND n.key->>'path'='withdrawn.ts' AND ${activeExistenceSql('vertex','n',['probe.referrer'],{validAt:now,recordedAt:now,contexts:[1]})}`)).rows);
    expect(selected).toHaveLength(1);
    expect((await removedEdgeEnds(owner)).rows).toEqual([]);
  },30_000);

  test.each(['d1','d2'])('dangling repeated edge %s is refused without retaining unresolved rows (0039.1)', async discriminator => {
    if (owner === undefined) throw new Error('the store was not opened');
    const read = readKinds(product); if (!read.present) throw new Error('manifest absent');
    const contract = graphContractOf(read.manifest);
    const bindings = await fixtureBindings(contract);
    const before = await owner.transaction('snapshot',async tx=>(await tx.query('SELECT * FROM assertion ORDER BY recorded_sequence')).rows);
    await expect(owner.transaction('write',async tx=>{await activateGraphProducer(tx, contract, bindings.person);return await publishGraphDrafts(tx,contract,{vertices:[],edges:[{kind:'code.contains',from:{kind:'code.repository',key:{name:'repo'}},to:{kind:'code.file',key:{path:'e.ts'},keyEdges:{'code.file-repository':{kind:'code.repository',key:{name:'edge-ghost'}}}},discriminator,producer:'test',producerVersion:'1'}],removals:[]});})).rejects.toThrow('MISSING_ENDPOINT');
    expect(await owner.transaction('snapshot',async tx=>(await tx.query('SELECT * FROM assertion ORDER BY recorded_sequence')).rows)).toEqual(before);
  },30_000);

  test('an opinion with two evidence-required fields is two pages at limit one, and every key field is emitted', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const read = readKinds(product);
    if (!read.present) return;
    const contract = graphContractOf(read.manifest);
    const bindings = await fixtureBindings(contract);
    await owner.transaction('write', async (tx) => { await activateGraphProducer(tx, contract, bindings.person); return await publishGraphDrafts(tx, contract, {
      vertices: [
        { kind: 'probe.opinion', key: { id: 'paged' }, values: { first: 'a', second: 'b' }, producer: 'plugin-consistency', producerVersion: '1.0.0' },
        { kind: 'probe.keyed', key: { id: 'keyed', title: 'the title' }, values: {}, producer: 'plugin-consistency', producerVersion: '1.0.0' },
      ],
      removals: [],
    }, 1); });
    const opinion = { kind: 'probe.opinion', table: generatedTableName('probe.opinion', 'vertex'), producer: 'plugin-consistency', fields: ['first', 'second'], key: ['id'] };
    const first = await unevidencedAssertions(owner, [opinion], { limit: 1 });
    expect(first.rows.map((one) => one.field)).toEqual(['first']);
    expect(first.next).toBeDefined();
    const second = await unevidencedAssertions(owner, [opinion], { after: first.next, limit: 1 });
    expect(second.rows.map((one) => one.field)).toEqual(['second']);
    const keyed = await unevidencedAssertions(owner, [{ kind: 'probe.keyed', table: generatedTableName('probe.keyed', 'vertex'), producer: 'plugin-consistency', fields: ['id', 'title'], key: ['id', 'title'] }], { limit: 10 });
    expect(keyed.rows).toEqual([]); // Immutable key fields have no source assertions to evidence.
    await owner.transaction('write', async tx => {
      await activateGraphProducer(tx, contract, bindings.person);
      await removeEntity(tx,contract,{kind:'probe.opinion',key:{id:'paged'},producer:'plugin-consistency'});
      await removeEntity(tx,contract,{kind:'probe.keyed',key:{id:'keyed',title:'the title'},producer:'plugin-consistency'});
    });
  }, 120_000);

  test('a targeted declared unit has an identity of its own', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const read = readKinds(product);
    const lock = parsePluginLock(readFileSync(join(product, 'madarch', 'plugins.lock'), 'utf8'));
    if (!read.present || !lock.ok) return;
    const wiring: PluginTurnWiring = {
      productFolder: product, manifest: read.manifest, locks: new Map(lock.entries.map((entry) => [entry.id, entry])), owner,
      snapshots: { pins: async () => [], open: async () => { throw new Error('no repository'); } } as never,
      contract: graphContractOf(read.manifest),
    };
    const whole = await planPluginTurns(wiring);
    const targeted = await planPluginTurns({ ...wiring, targets: { kinds: ['probe.finding'], vertex: 'probe.finding:A' } });
    const wholeFinding = whole.find((unit) => unit.id.includes('plugin-consistency:probe.finding'));
    const targetedFinding = targeted.find((unit) => unit.id.includes('plugin-consistency:probe.finding'));
    expect(wholeFinding).toBeDefined();
    expect(targetedFinding).toBeDefined();
    expect(wholeFinding!.id).not.toBe(targetedFinding!.id);
    expect(targetedFinding!.id).toContain('@probe.finding:A');
  }, 120_000);

});
