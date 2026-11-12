import { writeFolderManifest } from './catalog-folder-fixture.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { prepareStore } from '../src/adapters/prepare-store.js';
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
import { createTestDatabaseOwner } from './test-database.js';
import { makeProduct } from './knowledge-fixture.js';
import { seedStarterSet } from '../src/knowledge/seed.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { planWholeGraphTurns, type PluginTurnWiring } from '../src/fill/plugin-turns.js';
import { runFill } from '../src/fill/run.js';
import { publishGraphDrafts, removeEntity } from '../src/graph/write.js';
import { removedEdgeEnds, unresolvedReferences, unevidencedOpinions } from '../src/graph/index.js';
import { parsePluginLock } from '../src/plugin/lock.js';
import { generatedTableName } from '../src/graph/contract.js';
import { closureOf } from '../src/plugin/closure.js';

const FIXTURE = join(import.meta.dir, 'fixtures', 'plugin-consistency');
let root = '';
let product = '';
let repositoryFolder = '';
let fixtureClosure = '';
let owner: DatabaseOwner | undefined;

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
    template: templates/file.liquid
    source: graph
    capability: git
  code.repository:
    template: templates/repository.liquid
    source: graph
    capability: git
  code.directory:
    template: templates/directory.liquid
    source: graph
    capability: git
  probe.finding:
    template: templates/item-plain.liquid
    source: graph
    findings: true
    depends-on: [code.file]
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
    template: templates/item-plain.liquid
    source: graph
    depends-on: [code.file]
    labels:
      en: { one: Probe opinion, many: Probe opinions }
      ru: { one: Утверждение, many: Утверждения }
    fields:
      - { name: id, type: text, binding: "plugin-consistency@1.id" }
      - { name: first, type: text, nullable: true, binding: "plugin-consistency@1.first" }
      - { name: second, type: text, nullable: true, binding: "plugin-consistency@1.second" }
    key: [id]
  probe.keyed:
    template: templates/item-plain.liquid
    source: graph
    depends-on: [code.file]
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
  return closure;
}

/** The findings the fixture plugin stated, as the Problems page reads them. */
async function findings(): Promise<{ rule: string; subject: string; target: string; cause: string }[]> {
  if (owner === undefined) throw new Error('the store was not opened');
  const table = generatedTableName('probe.finding', 'vertex');
  const found = await owner.transaction('snapshot', async (tx) => await tx.query<{ rule: string; subject: string; target: string; cause: string }>(
    `SELECT o.rule AS rule, o.subject AS subject, o.target AS target, o.cause AS cause FROM ${table} o WHERE o.state = 'open' ORDER BY o.id`,
  ));
  return found.rows;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-consistency-'));
  const repository = join(root, 'repo');
  repositoryFolder = repository;
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
  git(product, 'add', '-A');
  git(product, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'the product');
  owner = await createTestDatabaseOwner({ btreeGist: true });
});

afterAll(async () => {
  await owner?.close();
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

describe('a whole-graph fixture plugin reads through the host and runs last', () => {
  test('a consistent fill states no finding', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    await prepareStore(owner, { contract: await readPinnedGraphContract(product) });
    const preparedOwner = owner;
    const run = await runFill({ product, database: owner, releaseHashes: [fixtureClosure], steps: ['repository-tree', 'plugin-turns', 'whole-graph-turns'], runId: 'consistent', home: join(root, 'home'), prepareContract: async (contract) => { await prepareStore(preparedOwner, { contract }); } });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.state).toBe('succeeded');
    // The whole-graph turn is its own stage, planned after the plugin turns published.
    expect(run.units.filter((unit) => unit.stageId === 'whole-graph-turns').length).toBe(1);
    expect(await findings()).toEqual([]);
  }, 300_000);

  test('two unevidenced fields of one entity are two findings, not one key twice', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const read = readKinds(product);
    if (!read.present) throw new Error('manifest absent');
    const contract = graphContractOf(read.manifest);
    await owner.transaction('write', async (tx) => await publishGraphDrafts(tx, contract, {
      vertices: [{ kind: 'probe.opinion', key: { id: 'one' }, values: { first: 'a', second: 'b' }, producer: 'plugin-consistency', producerVersion: '1.0.0' }],
      removals: [],
    }, 1));
    await prepareStore(owner, { contract: await readPinnedGraphContract(product) });
    const preparedOwner = owner;
    const run = await runFill({ product, database: owner, releaseHashes: [fixtureClosure], steps: ['whole-graph-turns'], targets: { kinds: ['probe.opinion'] }, runId: 'unevidenced', home: join(root, 'home'), prepareContract: async (contract) => { await prepareStore(preparedOwner, { contract }); } });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.state).toBe('succeeded');
    const found = (await findings()).filter((one) => one.rule === 'unevidenced-opinion');
    expect(found.map((one) => one.target.split(':')[1]).sort()).toEqual(['first', 'second']);
    expect(new Set(found.map((one) => one.target)).size).toBe(2);
  }, 300_000);

  test('one dangling edge and one reference to a missing key are exactly two findings, and a fix clears them', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const read = readKinds(product);
    if (!read.present) return;
    const contract = graphContractOf(read.manifest);
    // Normal withdrawal removes incident edges. Keep one damaged historical edge explicitly for the consistency probe.
    const damaged = await owner.transaction('snapshot', async (tx) => await tx.query<{
      entity_id: string; from_node: string; to_node: string; discriminator: string; context_id: string;
    }>(`SELECT e.entity_id::text, e.from_node::text, e.to_node::text, e.discriminator, e.context_id::text
        FROM edge e JOIN entity k ON k.id = e.entity_id JOIN node n ON n.id = e.to_node
        WHERE k.name = 'contains' AND n.key->>'path' = 'src/a.ts'`));
    expect(damaged.rows).toHaveLength(1);
    for (const producer of ['git-tree', 'linguist']) {
      expect(await owner.transaction('write', async (tx) => await removeEntity(tx, contract, { kind: 'file', key: { repository: { kind: 'repository', key: { name: 'repo' } }, path: 'src/a.ts' }, producer }, 1))).toBe(true);
    }
    await owner.transaction('write', async (tx) => {
      const edge = damaged.rows[0]!;
      await tx.query('INSERT INTO edge (entity_id, from_node, to_node, discriminator, context_id) VALUES ($1::bigint, $2::bigint, $3::bigint, $4, $5::bigint)',
        [edge.entity_id, edge.from_node, edge.to_node, edge.discriminator, edge.context_id]);
    });
    await owner.transaction('write', async (tx) => await publishGraphDrafts(tx, contract, {
      vertices: [{ kind: 'file', key: { repository: { kind: 'repository', key: { name: 'ghost' } }, path: 'ghost.ts' }, values: {}, producer: 'test', producerVersion: '1' }],
      removals: [],
    }, 1));
    expect((await unresolvedReferences(owner, { limit: 10 })).rows.map((one) => one.edge === undefined ? 'key' : 'edge')).toEqual(['key']);
    expect((await removedEdgeEnds(owner, { limit: 10 })).rows.map((one) => one.edge.kind)).toEqual(['contains']);
    await prepareStore(owner, { contract: await readPinnedGraphContract(product) });
    const preparedOwner = owner;
    const alone = await runFill({ product, database: owner, releaseHashes: [fixtureClosure], steps: ['whole-graph-turns'], targets: { kinds: ['probe.finding'] }, runId: 'alone', home: join(root, 'home'), prepareContract: async (contract) => { await prepareStore(preparedOwner, { contract }); } });
    expect(alone.ok).toBe(true);
    if (!alone.ok) return;
    expect(alone.units.map((unit) => unit.unitId)).toEqual([expect.stringContaining('plugin-consistency:whole-graph@')]);
    expect((await findings()).map((one) => one.rule).sort()).toEqual(['missing-reference', 'removed-end']);
    // The fix: the repository the file names stands, the file is declared again, and the tree publishes the removed file.
    await owner.transaction('write', async (tx) => await publishGraphDrafts(tx, contract, {
      vertices: [
        { kind: 'repository', key: { name: 'ghost' }, values: { url: null }, producer: 'test', producerVersion: '1' },
        { kind: 'file', key: { repository: { kind: 'repository', key: { name: 'ghost' } }, path: 'ghost.ts' }, values: {}, producer: 'test', producerVersion: '1' },
      ],
      removals: [],
    }, 1));
    writeFileSync(join(repositoryFolder, 'src', 'a.ts'), 'export const a = 2;\n');
    git(repositoryFolder, 'add', '-A');
    git(repositoryFolder, '-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'two');
    await prepareStore(owner, { contract: await readPinnedGraphContract(product) });
    const fixed = await runFill({ product, database: owner, releaseHashes: [fixtureClosure], steps: ['repository-tree', 'plugin-turns', 'whole-graph-turns'], runId: 'fixed', home: join(root, 'home'), prepareContract: async (contract) => { await prepareStore(preparedOwner, { contract }); } });
    expect(fixed.ok).toBe(true);
    if (!fixed.ok) return;
    expect((await findings()).filter((one) => one.rule !== 'unevidenced-opinion')).toEqual([]);
  }, 300_000);
  test('a reference leaves the read when its target stands, and the read pages by a cursor', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const read = readKinds(product);
    if (!read.present) return;
    const contract = graphContractOf(read.manifest);
    const fileVertex = (name: string) => ({ kind: 'file', key: { repository: { kind: 'repository', key: { name } }, path: `${name}.ts` }, values: {}, producer: 'test', producerVersion: '1' });
    await owner.transaction('write', async (tx) => await publishGraphDrafts(tx, contract, { vertices: [fileVertex('page-a'), fileVertex('page-b')], removals: [] }, 1));
    const first = await unresolvedReferences(owner, { limit: 1 });
    expect(first.rows).toHaveLength(1);
    expect(first.next).toBeDefined();
    const second = await unresolvedReferences(owner, { after: first.next, limit: 1 });
    expect(second.rows).toHaveLength(1);
    // The target stands now: the row the writer kept is no longer a problem, while the other still is.
    await owner.transaction('write', async (tx) => await publishGraphDrafts(tx, contract, { vertices: [{ kind: 'repository', key: { name: 'page-a' }, values: { url: null }, producer: 'test', producerVersion: '1' }], removals: [] }, 1));
    const after = await unresolvedReferences(owner, { limit: 10 });
    expect(after.rows.filter((one) => one.target.label.startsWith('page-')).map((one) => one.target.label)).toEqual(['page-b']);
    await owner.transaction('write', async (tx) => {
      await tx.query(`DELETE FROM unresolved_reference WHERE target_entity = 'repository' AND target_key->>'name' IN ('page-a', 'page-b')`);
      for (const kind of contract.vertex) await tx.query(`DELETE FROM ${kind.table} WHERE node_id IN (SELECT id FROM node WHERE key->'repository'->'key'->>'name' IN ('page-a', 'page-b') OR key->>'name' IN ('page-a', 'page-b'))`);
      await tx.query(`DELETE FROM node WHERE key->'repository'->'key'->>'name' IN ('page-a', 'page-b')`);
      await tx.query(`DELETE FROM node WHERE key->>'name' IN ('page-a', 'page-b')`);
    });
  }, 120_000);

  test('a withdrawn referrer no longer yields a missing reference, while another producer still holds it', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const read = readKinds(product);
    if (!read.present) return;
    const contract = graphContractOf(read.manifest);
    const key = { repository: { kind: 'repository', key: { name: 'withdrawn-ghost' } }, path: 'withdrawn.ts' };
    await owner.transaction('write', async (tx) => await publishGraphDrafts(tx, contract, {
      vertices: [
        { kind: 'file', key, values: {}, producer: 'test', producerVersion: '1' },
        { kind: 'file', key, values: {}, producer: 'other', producerVersion: '1' },
      ],
      removals: [],
    }, 1));
    await owner.transaction('write', async (tx) => await removeEntity(tx, contract, { kind: 'file', key, producer: 'test' }, 1));
    const found = await unresolvedReferences(owner, { limit: 20 });
    expect(found.rows.filter((one) => one.target.label === 'withdrawn-ghost').map((one) => one.producer)).toEqual(['other@1']);
    await owner.transaction('write', async (tx) => {
      for (const kind of contract.vertex) await tx.query(`DELETE FROM ${kind.table} WHERE node_id IN (SELECT id FROM node WHERE key->'repository'->'key'->>'name' = 'withdrawn-ghost')`);
      await tx.query(`DELETE FROM unresolved_reference WHERE target_entity = 'repository' AND target_key->>'name' = 'withdrawn-ghost'`);
      await tx.query(`DELETE FROM node WHERE key->'repository'->'key'->>'name' = 'withdrawn-ghost'`);
    });
  }, 120_000);

  test('two dangling edges of one kind and one target carry their discriminator and row id', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const read = readKinds(product);
    if (!read.present) return;
    const contract = graphContractOf(read.manifest);
    const edge = (discriminator: string) => ({
      kind: 'contains',
      from: { kind: 'directory', key: { repository: { kind: 'repository', key: { name: 'repo' } }, path: 'src' } },
      to: { kind: 'file', key: { repository: { kind: 'repository', key: { name: 'edge-ghost' } }, path: 'e.ts' } },
      discriminator,
      producer: 'test', producerVersion: '1',
    });
    await owner.transaction('write', async (tx) => await publishGraphDrafts(tx, contract, { vertices: [], edges: [edge('d1'), edge('d2')], removals: [] }, 1));
    const found = (await unresolvedReferences(owner, { limit: 20 })).rows.filter((one) => one.edge?.kind === 'contains' && one.target.key['repository'] === 'edge-ghost');
    expect(found.map((one) => one.edge?.discriminator).sort()).toEqual(['d1', 'd2']);
    expect(new Set(found.map((one) => one.id)).size).toBe(2);
    await owner.transaction('write', async (tx) => await tx.query(`DELETE FROM unresolved_reference WHERE target_entity = 'repository' AND target_key->>'name' = 'edge-ghost'`));
  }, 120_000);

  test('an opinion with two evidence-required fields is two pages at limit one, and every key field is emitted', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const read = readKinds(product);
    if (!read.present) return;
    const contract = graphContractOf(read.manifest);
    await owner.transaction('write', async (tx) => await publishGraphDrafts(tx, contract, {
      vertices: [
        { kind: 'probe.opinion', key: { id: 'paged' }, values: { first: 'a', second: 'b' }, producer: 'plugin-consistency', producerVersion: '1.0.0' },
        { kind: 'probe.keyed', key: { id: 'keyed', title: 'the title' }, values: {}, producer: 'plugin-consistency', producerVersion: '1.0.0' },
      ],
      removals: [],
    }, 1));
    const opinion = { kind: 'probe.opinion', table: generatedTableName('probe.opinion', 'vertex'), producer: 'plugin-consistency', fields: ['first', 'second'], key: ['id'] };
    const first = await unevidencedOpinions(owner, [opinion], { limit: 1 });
    expect(first.rows.map((one) => one.field)).toEqual(['first']);
    expect(first.next).toBeDefined();
    const second = await unevidencedOpinions(owner, [opinion], { after: first.next, limit: 1 });
    expect(second.rows.map((one) => one.field)).toEqual(['second']);
    const keyed = await unevidencedOpinions(owner, [{ kind: 'probe.keyed', table: generatedTableName('probe.keyed', 'vertex'), producer: 'plugin-consistency', fields: ['id', 'title'], key: ['id', 'title'] }], { limit: 10 });
    expect(keyed.rows.map((one) => one.field)).toEqual(['id', 'title']);
    await owner.transaction('write', async (tx) => {
      await tx.query(`DELETE FROM ${opinion.table} WHERE node_id IN (SELECT id FROM node WHERE key->>'id' = 'paged')`);
      await tx.query(`DELETE FROM ${generatedTableName('probe.keyed', 'vertex')} WHERE node_id IN (SELECT id FROM node WHERE key->>'id' = 'keyed')`);
      await tx.query(`DELETE FROM node WHERE key->>'id' IN ('paged', 'keyed')`);
    });
  }, 120_000);

  test('a targeted whole-graph unit has an identity of its own', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const read = readKinds(product);
    const lock = parsePluginLock(readFileSync(join(product, 'madarch', 'plugins.lock'), 'utf8'));
    if (!read.present || !lock.ok) return;
    const wiring: PluginTurnWiring = {
      productFolder: product, manifest: read.manifest, locks: new Map(lock.entries.map((entry) => [entry.id, entry])), owner,
      snapshots: { pins: async () => [], open: async () => { throw new Error('no repository'); } } as never,
      contract: graphContractOf(read.manifest),
    };
    const whole = await planWholeGraphTurns(wiring);
    const targeted = await planWholeGraphTurns({ ...wiring, targets: { kinds: ['probe.finding'], vertex: 'probe.finding:A' } });
    expect(whole[0]?.id).not.toBe(targeted[0]?.id);
    expect(targeted[0]?.id).toContain('@probe.finding:A');
  }, 120_000);

});
