/**
 * The three static stages' publication into the 0028 graph (decision 0033,
 * "Capability boundaries" and "The file is the unit of static work"; decision
 * 0027's one atomic publication). A generated repository — no outside checkout
 * — is walked by the snapshot, inventory and syntax stages, and every unit's
 * draft lands in the graph through the fill publication's own transaction.
 *
 * The expectations come from the task and the decisions: snapshot publishes one
 * `code.file` node per file (one file's bytes per unit), inventory draws the
 * containment, syntax publishes symbols with their global names, the mentions
 * at their byte spans and the import edges as written. A second pass reads the
 * graph and plans no unit, so it writes nothing.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createGraphStore, outerTransactionOf, type EdgeEntry, type GraphStore, type NodeVersionRow } from '../src/graph/index.js';
import { createFillStateSchema, createRun, createUnit, advanceUnit, leaseUnit } from '../src/fill/state-store.js';
import { createOrchestratorSchema, publishUnit, recordUnitDraft } from '../src/fill/orchestrator-store.js';
import { createGitSnapshotSource, type SnapshotSource } from '../src/fill/snapshot.js';
import { DEFAULT_STAGE_LIMITS, type FillStage, type StageContext, type StageDraftWrite } from '../src/fill/stage.js';
import { createInventoryStage } from '../src/fill/stages/inventory.js';
import { createSnapshotStage } from '../src/fill/stages/snapshot.js';
import { createSyntaxStage } from '../src/fill/stages/syntax.js';
import { staticGraphReaderOf, staticStageContext, staticStageSourceOf } from '../src/fill/stages/static-context.js';
import { createStaticStageReadReader } from '../src/fill/stages/static-reads.js';
import { CODE_GRAPH_VOCABULARY, checkStaticGraphDraft, staticUnitPublicationOf, type StaticEnd } from '../src/fill/stages/static-graph.js';
import { nodesOfKind } from './fill-static-drafts.js';

const NOW = 1_700_000_000_000;
const PRODUCT = 'fixture-product';
const REPOSITORY = 'orders-api';

/** A throwaway repository the test commits into by hand. */
interface Fixture {
  readonly root: string;
  commit(): string;
  write(path: string, text: string): Promise<void>;
  dispose(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'madarch-static-graph-'));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  const write = async (path: string, text: string): Promise<void> => {
    const at = join(root, path);
    await mkdir(join(at, '..'), { recursive: true });
    await writeFile(at, text);
  };
  return {
    root,
    write,
    commit(): string {
      git('add', '-A');
      git('commit', '-qm', 'fixture');
      return git('rev-parse', 'HEAD').trim();
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

/** The repository a unit's scope names: `<repository>` or `<repository>:<path>`. */
function repositoryOfScope(scope: string): string {
  const at = scope.indexOf(':');
  return at < 0 ? scope : scope.slice(0, at);
}

/** One draft a unit wrote, and the unit it belongs to. */
interface Drafted {
  readonly stage: FillStage;
  readonly unitId: string;
  readonly writes: readonly StageDraftWrite[];
}

/** Runs one stage's plan and every unit, collecting the drafts without publishing them. */
async function draftStage(stage: FillStage, source: SnapshotSource, store: GraphStore): Promise<readonly Drafted[]> {
  const graph = createStaticStageReadReader(store);
  const plan = await stage.plan(graph);
  const drafted: Drafted[] = [];
  for (const unit of plan.units) {
    const writes: StageDraftWrite[] = [];
    const repository = await staticStageSourceOf(source, repositoryOfScope(unit.scope));
    const context: StageContext = {
      unit: { id: unit.id, scope: unit.scope },
      config: { id: stage.id, version: stage.version, enabled: true, concurrency: 1, limits: DEFAULT_STAGE_LIMITS, config: {} },
      graph,
      static: staticStageContext(repository, staticGraphReaderOf(store)),
      draft: { write: (entry) => { writes.push(entry); }, writes: () => ({ writes }) },
      progress: () => undefined,
      signal: new AbortController().signal,
    };
    const outcome = await stage.execute({ id: unit.id, scope: unit.scope }, context);
    if (outcome.outcome !== 'draft') throw new Error(`the ${stage.id} stage's unit ${unit.id} answered ${outcome.outcome}, and this test publishes drafts`);
    expect(stage.validate({ writes }, graph)).toEqual({ ok: true });
    drafted.push({ stage, unitId: `${stage.id}/${unit.id}`, writes });
  }
  return drafted;
}

/**
 * Publishes one drafted unit through the orchestrator's one atomic operation:
 * a run and a generation in the fill's state, the draft recorded, and the
 * publication's own transaction applying it to the graph.
 */
async function publishDrafted(owner: DatabaseOwner, store: GraphStore, runId: string, drafted: Drafted): Promise<{ readonly facts: number }> {
  const digest = createHash('sha256').update(JSON.stringify(drafted.writes)).digest('hex');
  await createUnit(owner, { unitId: drafted.unitId, product: PRODUCT, runId, stageId: drafted.stage.id, scopeKey: drafted.unitId, inputsDigest: digest, retries: 2, at: NOW });
  expect((await advanceUnit(owner, { unitId: drafted.unitId, event: { type: 'admit', at: NOW, generation: 1 } })).ok).toBe(true);
  const leased = await leaseUnit(owner, { unitId: drafted.unitId, holder: 'test', ttlMs: 60_000, at: NOW });
  expect(leased.ok).toBe(true);
  const fence = leased.ok ? leased.record.context.fence : 0;
  for (const event of [
    { type: 'start', at: NOW, generation: 1, fence },
    { type: 'submit-draft', at: NOW, generation: 1, fence },
  ] as const) {
    expect((await advanceUnit(owner, { unitId: drafted.unitId, event })).ok).toBe(true);
  }
  await recordUnitDraft(owner, { unitId: drafted.unitId, generation: 1, writes: drafted.writes, at: NOW });
  expect((await advanceUnit(owner, { unitId: drafted.unitId, event: { type: 'validate-draft', at: NOW, generation: 1, fence } })).ok).toBe(true);
  const outcome = await publishUnit(owner, {
    unitId: drafted.unitId,
    generation: 1,
    fence,
    identity: { inputsDigest: digest, stageId: drafted.stage.id, stageVersion: drafted.stage.version },
    at: NOW,
    revalidate: async () => ({ membership: 'no reads', members: 0 }),
    apply: async (executor, writes, publicationDigest) => {
      await store.publishUnit(staticUnitPublicationOf({
        unitId: drafted.unitId,
        stageId: drafted.stage.id,
        digest: publicationDigest,
        writes,
      }), outerTransactionOf(executor));
      return writes.length;
    },
  });
  expect(outcome.outcome).toBe('published');
  if (outcome.outcome !== 'published') throw new Error('the publication was not published');
  return outcome.record;
}

/** A node's properties, as the graph answered them. */
function propertiesOf(node: NodeVersionRow): Record<string, unknown> {
  return node.properties as Record<string, unknown>;
}

/** Every page of one property read, in node id order. */
async function byProperty(store: GraphStore, kind: string, field: string, value: string): Promise<NodeVersionRow[]> {
  return await store.readAll(async (page) => await store.byProperty(kind, field, value, page));
}

/** Every page of one relation read within a repository node. */
async function relationsWithin(store: GraphStore, repository: string, relation: string): Promise<EdgeEntry[]> {
  return await store.readAll(async (page) => await store.relationsWithin(repository, relation, undefined, page));
}

const owners: DatabaseOwner[] = [];
const folders: Fixture[] = [];

afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close();
  for (const folder of folders.splice(0)) await folder.dispose();
});

describe('the static stages publish into the 0028 graph', () => {
  test('snapshot, inventory and syntax write one file\'s facts per unit, and a second pass plans nothing', async () => {
    const f = await fixture();
    folders.push(f);
    await f.write('src/a.ts', 'export function create(value: number): number {\n  return value + 1;\n}\n');
    await f.write('src/b.ts', "import { create } from './a.js';\n\nexport const answer = create(41);\n");
    await f.write('docs/readme.md', '# Orders\n');
    const commit = f.commit();
    const source = createGitSnapshotSource([{ id: REPOSITORY, form: 'code', root: f.root, commit }]);

    const owner = createPGliteDatabaseOwner({ btreeGist: true });
    owners.push(owner);
    await createFillStateSchema(owner);
    await createOrchestratorSchema(owner);
    const store = createGraphStore(owner);
    await store.createSchema();
    await store.registerCodeSchema(CODE_GRAPH_VOCABULARY);
    await createRun(owner, { runId: 'run-1', product: PRODUCT, at: NOW });

    const stages = [createSnapshotStage(source), createInventoryStage(source), createSyntaxStage(source)];
    for (const stage of stages) {
      for (const drafted of await draftStage(stage, source, store)) {
        const record = await publishDrafted(owner, store, 'run-1', drafted);
        // The publication's own count is what its apply step wrote: every node and edge of the draft.
        expect(record.facts).toBe(drafted.writes.length);
      }
    }

    // Every file the tree holds is a code.file node, one unit's reading each.
    const files = await byProperty(store, 'code.file', 'repository', REPOSITORY);
    expect(files.map((node) => String(propertiesOf(node)['path'])).sort()).toEqual(['docs/readme.md', 'src/a.ts', 'src/b.ts']);
    const directories = await byProperty(store, 'code.directory', 'repository', REPOSITORY);
    expect(directories.map((node) => String(propertiesOf(node)['path'])).sort()).toEqual(['docs', 'src']);
    const repositories = await byProperty(store, 'code.repository', 'repository', REPOSITORY);
    expect(repositories).toHaveLength(1);
    const commits = await byProperty(store, 'code.commit', 'repository', REPOSITORY);
    expect(commits.map((node) => String(propertiesOf(node)['commit']))).toEqual([commit]);

    // The symbols of both files, each with the global name another file resolves it by.
    const symbols = await byProperty(store, 'code.symbol', 'repository', REPOSITORY);
    const names = symbols.map((node) => String(propertiesOf(node)['globalName'])).sort();
    expect(names).toEqual([`${REPOSITORY}:src/a.ts#create`, `${REPOSITORY}:src/b.ts#answer`]);

    const repositoryNode = repositories[0]!;
    // The mentions: one definition occurrence per symbol, positioned at its byte span.
    const mentions = await relationsWithin(store, repositoryNode.nodeId, 'code.occurrence');
    expect(mentions).toHaveLength(symbols.length);
    for (const mention of mentions) {
      expect(mention.edge.position).not.toBeNull();
      expect(mention.edge.properties).toMatchObject({ roles: ['definition'] });
    }
    // The imports: the one specifier the file wrote, joined to the file it names.
    const imports = await relationsWithin(store, repositoryNode.nodeId, 'code.imports');
    expect(imports).toHaveLength(1);
    expect(imports[0]!.edge.properties).toMatchObject({ specifier: './a.js' });
    expect(propertiesOf(imports[0]!.src)['path']).toBe('src/b.ts');
    expect(propertiesOf(imports[0]!.dst)['path']).toBe('src/a.ts');
    // The containment: the repository and its two folders, down to every file.
    const containment = await relationsWithin(store, repositoryNode.nodeId, 'code.contains');
    expect(containment.length).toBeGreaterThanOrEqual(files.length + directories.length);

    // A second pass reads the graph and names no unit: nothing is written twice.
    for (const stage of stages) expect((await stage.plan(createStaticStageReadReader(store))).units).toEqual([]);
  }, 120_000);

  test('a changed unit corrects its own node, and an empty draft retracts it', async () => {
    const f = await fixture();
    folders.push(f);
    await f.write('src/a.ts', 'export const a = 1;\n');
    const commit = f.commit();
    const source = createGitSnapshotSource([{ id: REPOSITORY, form: 'code', root: f.root, commit }]);
    const owner = createPGliteDatabaseOwner({ btreeGist: true });
    owners.push(owner);
    await createFillStateSchema(owner);
    await createOrchestratorSchema(owner);
    const store = createGraphStore(owner);
    await store.createSchema();
    await store.registerCodeSchema(CODE_GRAPH_VOCABULARY);
    await createRun(owner, { runId: 'run-1', product: PRODUCT, at: NOW });

    const stage = createSnapshotStage(source);
    const drafted = (await draftStage(stage, source, store)).find((unit) => unit.unitId.endsWith('src/a.ts'))!;
    await publishDrafted(owner, store, 'run-1', drafted);
    const key = nodesOfKind(drafted.writes, 'code.file')[0]!.key;
    const before = await store.byKey(key, { limit: 2 });
    expect(before.rows).toHaveLength(1);
    const nodeId = before.rows[0]!.nodeId;

    // The same unit, a changed reading: the node keeps its identity and its new properties are the version shown.
    const changed = drafted.writes.map((write) => (write.kind === 'node'
      ? { ...write, value: { ...write.value, properties: { ...write.value.properties, bytes: 999 } } }
      : write)) as StageDraftWrite[];
    const second = await owner.transaction('write', async (executor) => await store.publishUnit(staticUnitPublicationOf({
      unitId: drafted.unitId, stageId: drafted.stage.id, digest: 'changed-reading', writes: changed,
    }), outerTransactionOf(executor)));
    // The store allocates the next generation under the unit's one scope: the first publication was generation 1.
    expect(second.generation).toBe(2);
    const corrected = await store.byKey(key, { limit: 2 });
    expect(corrected.rows).toHaveLength(1);
    expect(corrected.rows[0]!.nodeId).toBe(nodeId);
    expect(corrected.rows[0]!.properties).toMatchObject({ bytes: 999 });

    // The same unit, an empty draft: the node and its edges end, and no other unit's facts move. It is the
    // unit's third generation, under the same scope the changed reading published under.
    const third = await owner.transaction('write', async (executor) => await store.publishUnit(staticUnitPublicationOf({
      unitId: drafted.unitId, stageId: drafted.stage.id, digest: 'empty-reading', writes: [],
    }), outerTransactionOf(executor)));
    expect(third.generation).toBe(3);
    expect(third.scope).toBe(second.scope);
    expect((await store.byKey(key, { limit: 2 })).rows).toHaveLength(0);
  }, 120_000);

  test('a publisher refuses an edge whose end no node carries, and a key two nodes carry', async () => {
    const owner = createPGliteDatabaseOwner({ btreeGist: true });
    owners.push(owner);
    await createFillStateSchema(owner);
    await createOrchestratorSchema(owner);
    const store = createGraphStore(owner);
    await store.createSchema();
    await store.registerCodeSchema(CODE_GRAPH_VOCABULARY);
    const node = (key: string): StageDraftWrite => ({ kind: 'node', evidence: 'fixture', value: {
      key, kind: 'code.file', label: key, properties: { recordKey: key, factKind: 'file', repository: REPOSITORY, path: key },
    } });
    const edge = (to: string): StageDraftWrite => ({ kind: 'edge', evidence: 'fixture', value: {
      relation: 'code.contains', from: { key: 'file:from' }, to: { key: to }, properties: { factKind: 'contains' },
    } });
    const missing = await owner.transaction('write', async (executor) => await store.publishUnit(staticUnitPublicationOf({
      unitId: 'snapshot/missing', stageId: 'snapshot', digest: 'missing', writes: [node('file:from'), edge('file:missing')],
    }), outerTransactionOf(executor))).catch((error: Error) => error);
    expect(missing).toBeInstanceOf(Error);
    expect((missing as Error).message).toContain('no node in the graph carries it');
    expect((missing as Error).message).toContain('publish unit:');
    expect((missing as Error).message).toContain('path edges(to');

    // Two current nodes that carry one key are a corrupt graph, never a choice.
    const validFrom = new Date().toISOString();
    for (const label of ['a', 'b']) {
      const nodeId = await store.newNode();
      await store.openNode({ nodeId, kind: 'code.file', label, properties: { recordKey: 'file:duplicate', factKind: 'file', repository: REPOSITORY, path: label }, validFrom, owner: { producer: 'fixture', scope: nodeId } });
    }
    const twoNodes = await owner.transaction('write', async (executor) => await store.publishUnit(staticUnitPublicationOf({
      unitId: 'snapshot/duplicate', stageId: 'snapshot', digest: 'duplicate', writes: [node('file:from'), node('file:duplicate'), edge('file:duplicate')],
    }), outerTransactionOf(executor))).catch((error: Error) => error);
    expect(twoNodes).toBeInstanceOf(Error);
    expect((twoNodes as Error).message).toContain('current nodes carry it');
    expect((twoNodes as Error).message).toContain('publish unit:');
    expect((twoNodes as Error).message).toContain('path nodes("file:duplicate")');

    // An edge's from end is resolved and refused by its own path, never the to end's.
    const fromEnd = (end: StaticEnd): StageDraftWrite => ({ kind: 'edge', evidence: 'fixture', value: {
      relation: 'code.contains', from: end, to: { key: 'file:from' }, properties: { factKind: 'contains' },
    } });
    const missingFrom = await owner.transaction('write', async (executor) => await store.publishUnit(staticUnitPublicationOf({
      unitId: 'snapshot/missing-from', stageId: 'snapshot', digest: 'missing-from', writes: [node('file:from'), fromEnd({ key: 'file:missing-from' })],
    }), outerTransactionOf(executor))).catch((error: Error) => error);
    expect((missingFrom as Error).message).toContain('no node in the graph carries it');
    expect((missingFrom as Error).message).toContain('path edges(from');

    // A key two current nodes carry is refused when an edge end, not this draft's node, names it.
    for (const label of ['c', 'd']) {
      const nodeId = await store.newNode();
      await store.openNode({ nodeId, kind: 'code.file', label, properties: { recordKey: 'file:edge-duplicate', factKind: 'file', repository: REPOSITORY, path: label }, validFrom, owner: { producer: 'fixture', scope: nodeId } });
    }
    const twoEnds = await owner.transaction('write', async (executor) => await store.publishUnit(staticUnitPublicationOf({
      unitId: 'snapshot/two-ends', stageId: 'snapshot', digest: 'two-ends', writes: [node('file:from'), fromEnd({ key: 'file:edge-duplicate' })],
    }), outerTransactionOf(executor))).catch((error: Error) => error);
    expect((twoEnds as Error).message).toContain('current nodes carry it');
    expect((twoEnds as Error).message).toContain('path edges("file:edge-duplicate")');
  }, 120_000);

  test('two records of one relation with the same ends stand apart by their discriminator', async () => {
    const owner = createPGliteDatabaseOwner({ btreeGist: true });
    owners.push(owner);
    await createFillStateSchema(owner);
    await createOrchestratorSchema(owner);
    const store = createGraphStore(owner);
    await store.createSchema();
    await store.registerCodeSchema(CODE_GRAPH_VOCABULARY);
    const node = (key: string, kind: string): StageDraftWrite => ({ kind: 'node', evidence: 'fixture', value: {
      key, kind, label: key, properties: { recordKey: key, factKind: kind.slice('code.'.length), repository: REPOSITORY, path: key },
    } });
    const use = (discriminator: string): StageDraftWrite => ({ kind: 'edge', evidence: 'fixture', value: {
      relation: 'code.uses-logger', from: { key: 'code.logger:fixture#logger' }, to: { key: 'code.file:from' },
      discriminator, properties: { factKind: 'uses-logger', repository: REPOSITORY, discriminator },
    } });
    // Two uses of one logger in one file: the draft keeps them apart by the site's starting byte,
    // and the same site twice is still one edge.
    expect(checkStaticGraphDraft('operations-links', ['uses-logger'], { writes: [use('10'), use('80')] })).toEqual({ ok: true });
    const twice = checkStaticGraphDraft('operations-links', ['uses-logger'], { writes: [use('10'), use('10')] });
    expect(twice.ok).toBe(false);
    expect(twice.ok ? '' : twice.errors.join('\n')).toContain('one draft names one edge once');

    await owner.transaction('write', async (executor) => await store.publishUnit(staticUnitPublicationOf({
      unitId: 'operations-links/fixture', stageId: 'operations-links', digest: 'two-uses',
      writes: [node('code.logger:fixture#logger', 'code.logger'), node('code.file:from', 'code.file'), use('10'), use('80')],
    }), outerTransactionOf(executor)));
    const edges = await store.readAll(async (page) => await store.edgesByProperty('code.uses-logger', 'repository', REPOSITORY, page));
    expect(edges.map((entry) => entry.edge.discriminator).sort()).toEqual(['10', '80']);
  }, 120_000);

  test('a unit that names no key, a key two of its nodes carry and a node with an empty key are refused, with file, line, path and full path', async () => {
    const owner = createPGliteDatabaseOwner({ btreeGist: true });
    owners.push(owner);
    await createFillStateSchema(owner);
    await createOrchestratorSchema(owner);
    const store = createGraphStore(owner);
    await store.createSchema();
    await store.registerCodeSchema(CODE_GRAPH_VOCABULARY);
    // The empty key and the whitespace-only one both name no unit: the store refuses both by name,
    // with the file, the line, the input path and the full path of the refusal.
    for (const key of ['', '   ']) {
      const refused = await owner.transaction('write', async (executor) => await store.publishUnit(staticUnitPublicationOf({
        unitId: key, stageId: 'snapshot', digest: 'no-unit', writes: [],
      }), outerTransactionOf(executor))).catch((error: Error) => error);
      expect(refused).toBeInstanceOf(Error);
      const message = (refused as Error).message;
      expect(message).toContain('publication scope:');
      expect(message).toContain('a publication scope names the unit it holds by a non-empty key');
      expect(message).toContain('path scopeKey');
      expect(message).toContain('src/graph/publish.ts:');
      expect(message).toContain('full path');
      // The full path is the repository's own file, not a placeholder: the message ends with it.
      expect(message).toContain(join(import.meta.dir, '..', 'src', 'graph', 'publish.ts'));
    }
    const node = (key: string): StageDraftWrite => ({ kind: 'node', evidence: 'fixture', value: {
      key, kind: 'code.file', label: key, properties: { recordKey: key, factKind: 'file', repository: REPOSITORY, path: key },
    } });
    // One unit names one node by one key, and a node names a non-empty key.
    const duplicate = await owner.transaction('write', async (executor) => await store.publishUnit(staticUnitPublicationOf({
      unitId: 'snapshot/duplicate-key', stageId: 'snapshot', digest: 'duplicate-key', writes: [node('file:a'), node('file:a')],
    }), outerTransactionOf(executor))).catch((error: Error) => error);
    expect((duplicate as Error).message).toContain('one unit names one node by one key');
    expect((duplicate as Error).message).toContain('publish unit:');
    expect((duplicate as Error).message).toContain('path nodes[1].key');
    // An empty key and a whitespace-only one name no node.
    for (const key of ['', '   ']) {
      const empty = await owner.transaction('write', async (executor) => await store.publishUnit(staticUnitPublicationOf({
        unitId: `snapshot/empty-node-${key.length}`, stageId: 'snapshot', digest: `empty-node-${key.length}`, writes: [node(key)],
      }), outerTransactionOf(executor))).catch((error: Error) => error);
      expect(empty).toBeInstanceOf(Error);
      expect((empty as Error).message).toContain('an empty key names nothing');
      expect((empty as Error).message).toContain('publish unit:');
      expect((empty as Error).message).toContain('path nodes[0].key');
    }
    // The store's own producer guard, reached without the fill's mapping.
    const noProducer = await owner.transaction('write', async (executor) => await store.publishUnit({
      producer: '', scopeKey: 'snapshot/no-producer', inputDigest: 'no-producer', leaseToken: 'fill-static:no-producer', leaseUntil: new Date(Date.now() + 60_000).toISOString(), nodes: [], edges: [],
    }, outerTransactionOf(executor))).catch((error: Error) => error);
    expect((noProducer as Error).message).toContain('a publication names its producer');
    expect((noProducer as Error).message).toContain('publish unit:');
    expect((noProducer as Error).message).toContain('path producer');
    // An edge end may name a node the graph already holds by its identity, not only by a key.
    const existing = await store.newNode();
    await store.openNode({ nodeId: existing, kind: 'code.file', label: 'existing.ts', properties: { recordKey: 'file:existing', factKind: 'file', repository: REPOSITORY, path: 'existing.ts' }, validFrom: new Date().toISOString(), owner: { producer: 'fixture', scope: existing } });
    const byIdentity = await owner.transaction('write', async (executor) => await store.publishUnit(staticUnitPublicationOf({
      unitId: 'snapshot/edge-by-identity', stageId: 'snapshot', digest: 'edge-by-identity',
      writes: [
        node('file:from'),
        { kind: 'edge', evidence: 'fixture', value: { relation: 'code.contains', from: { key: 'file:from' }, to: { id: existing }, properties: { factKind: 'contains' } } } as StageDraftWrite,
      ],
    }), outerTransactionOf(executor)));
    expect(byIdentity.publication.edgeVersionsOpened).toBe(1);
  }, 120_000);

  test('a repeated publication of one unit writes no new node or edge version', async () => {
    const f = await fixture();
    folders.push(f);
    await f.write('src/a.ts', 'export const a = 1;\n');
    const commit = f.commit();
    const source = createGitSnapshotSource([{ id: REPOSITORY, form: 'code', root: f.root, commit }]);
    const owner = createPGliteDatabaseOwner({ btreeGist: true });
    owners.push(owner);
    await createFillStateSchema(owner);
    await createOrchestratorSchema(owner);
    const store = createGraphStore(owner);
    await store.createSchema();
    await store.registerCodeSchema(CODE_GRAPH_VOCABULARY);
    await createRun(owner, { runId: 'run-1', product: PRODUCT, at: NOW });

    const stages = [createSnapshotStage(source), createInventoryStage(source), createSyntaxStage(source)];
    const drafted: Drafted[] = [];
    for (const stage of stages) drafted.push(...await draftStage(stage, source, store));
    for (const unit of drafted) await publishDrafted(owner, store, 'run-1', unit);
    const before = await owner.run(async (tx) => ({
      nodes: Number((await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM node_version')).rows[0]!.n),
      edges: Number((await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM edge_version')).rows[0]!.n),
    }));

    // The same draft, published again under the same unit and digest: the graph answers the same input.
    for (const unit of drafted) {
      const digest = createHash('sha256').update(JSON.stringify(unit.writes)).digest('hex');
      await owner.transaction('write', async (executor) => await store.publishUnit(staticUnitPublicationOf({
        unitId: unit.unitId,
        stageId: unit.stage.id,
        digest,
        writes: unit.writes,
      }), outerTransactionOf(executor)));
    }
    const after = await owner.run(async (tx) => ({
      nodes: Number((await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM node_version')).rows[0]!.n),
      edges: Number((await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM edge_version')).rows[0]!.n),
    }));
    expect(after).toEqual(before);
  }, 120_000);
});
