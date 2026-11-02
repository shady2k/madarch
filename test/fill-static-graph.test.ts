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
import { createGraphStore, type EdgeEntry, type GraphStore, type NodeVersionRow } from '../src/graph/index.js';
import { createFillStateSchema, createRun, createUnit, advanceUnit, leaseUnit } from '../src/fill/state-store.js';
import { createOrchestratorSchema, publishUnit, recordUnitDraft } from '../src/fill/orchestrator-store.js';
import { createGitSnapshotSource, type SnapshotSource } from '../src/fill/snapshot.js';
import { DEFAULT_STAGE_LIMITS, type FillStage, type StageContext, type StageDraftWrite } from '../src/fill/stage.js';
import { createInventoryStage } from '../src/fill/stages/inventory.js';
import { createSnapshotStage } from '../src/fill/stages/snapshot.js';
import { createSyntaxStage } from '../src/fill/stages/syntax.js';
import { staticGraphReaderOf, staticStageContext, staticStageSourceOf } from '../src/fill/stages/static-context.js';
import { createStaticStageReadReader } from '../src/fill/stages/static-reads.js';
import { CODE_GRAPH_VOCABULARY, outerTransactionOf, publishStaticUnit } from '../src/fill/stages/static-graph.js';

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
async function publishDrafted(owner: DatabaseOwner, store: GraphStore, runId: string, drafted: Drafted): Promise<void> {
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
    apply: async (executor, writes, publicationDigest) => await publishStaticUnit(outerTransactionOf(executor), store, {
      unitId: drafted.unitId,
      stageId: drafted.stage.id,
      generation: 1,
      digest: publicationDigest,
      writes,
    }),
  });
  expect(outcome.outcome).toBe('published');
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
      for (const drafted of await draftStage(stage, source, store)) await publishDrafted(owner, store, 'run-1', drafted);
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
      await owner.transaction('write', async (executor) => await publishStaticUnit(outerTransactionOf(executor), store, {
        unitId: unit.unitId,
        stageId: unit.stage.id,
        generation: 1,
        digest,
        writes: unit.writes,
      }));
    }
    const after = await owner.run(async (tx) => ({
      nodes: Number((await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM node_version')).rows[0]!.n),
      edges: Number((await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM edge_version')).rows[0]!.n),
    }));
    expect(after).toEqual(before);
  }, 120_000);
});
