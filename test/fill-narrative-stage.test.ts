/**
 * The pages stage, end to end on the agent-stage shape (madarch-tzte.25.1; decision
 * 0026, "Pages": "Narrative text is a second layer written by agent units in order of
 * importance, each sentence tied to fact or claim ids, stored as Markdown in the
 * product's git with status proposed"; decision 0027's publication and staleness).
 *
 * Every expectation here is taken from the task and the decisions: the plan names one
 * unit per page in PageRank order; the unit writes its page through the checked write
 * path, each sentence tied to fact ids that stand in the graph; the published page
 * shows in the page's model above the facts, `proposed`, and stale the moment a fact
 * it stands on stands no more; the sweep that finds the page's reads moved marks the
 * unit stale and replans it; the outbox commits the page into the product's git, and
 * a person's file stands. The agent is the fake ACP agent of
 * `test/fixtures/acp-fake-agent` (no real prompt, no network, no token spent), and
 * time passes through a seam, never a sleep.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import type { QueueService } from '../src/fill/queue.js';
import { draftSetOf } from '../src/fill/checked-writes.js';
import { applyPublishedFacts, createFactStoreSchema, readUnitFacts, FACT_APPLICATION } from '../src/fill/fact-store.js';
import { makeEdgeFact, makeNodeFact, repositoryPath, type Fact, type FactProvenance } from '../src/fill/facts.js';
import { createFactGraphReader, DEFAULT_GRAPH_READ_LIMITS, estimateTokens } from '../src/fill/graph-reads.js';
import { commitNarrativePages } from '../src/fill/narrative-outbox.js';
import { narrativePagePath, renderNarrativePage, NARRATIVE_PAGE_STATUS, NARRATIVE_PAGE_WRITER } from '../src/fill/narrative-text.js';
import { createFillOrchestratorService, type ProductFillWiring } from '../src/fill/orchestrator-host.js';
import { createOrchestrator, planRun, schedulerPass, startRun, workOnce, type FillOrchestrator } from '../src/fill/orchestrator.js';
import { createOrchestratorSchema, readUnitDraft, type RunSnapshot } from '../src/fill/orchestrator-store.js';
import { readPageModel } from '../src/fill/graph-pages.js';
import { createStageRegistry } from '../src/fill/stages/index.js';
import { NARRATIVE_STAGE_ID, createNarrativeStage, narrativeDeclaration } from '../src/fill/stages/narrative.js';
import { StageRegistry } from '../src/fill/registry.js';
import { DEFAULT_STAGE_DEFAULTS, type FillStage } from '../src/fill/stage.js';
import { FACT_KINDS } from '../src/fill/facts.js';
import { Type } from 'typebox';
import { createGitSnapshotSource, type RepositoryPin } from '../src/fill/snapshot.js';
import { createFillStateSchema, createUnit, readRunUnits } from '../src/fill/state-store.js';
import { UNIT_TOOL_PATH } from '../src/fill/unit-tools.js';
import { startServer, type StartedServer } from '../src/server/http.js';

const NOW = 1_700_000_000_000;
const PRODUCT = 'fixture-product';
const RUN = 'run-2026-10-20T10:00Z';
const PRODUCT_REPOSITORY = 'acme-shop';
const CODE_REPOSITORY = 'orders-api';
const ORDER_FILE = 'src/order.ts';
const ORDER_BODY = 'export function placeOrder(cart) {\n  return { state: "placed" };\n}\n';
const README_BODY = '# acme shop\n\nThe shop takes an order and settles it.\n';
const FAKE_AGENT = join(import.meta.dir, 'fixtures', 'acp-fake-agent', 'acp-fake-agent.ts');

let root: string | undefined;
let COMMITS: Readonly<Record<string, string>> = {};

function provenance(repository: string, file: string, line: number): FactProvenance {
  return {
    source: { system: 'tree-sitter', version: '1.0.0' },
    repository: { id: repository, commit: COMMITS[repository] ?? 'a'.repeat(40) },
    place: { file: repositoryPath(file), range: { startLine: line, startColumn: 0, endLine: line, endColumn: 10 } },
  };
}

/**
 * The graph the deterministic stages published: two repositories, two modules ranked
 * by stage 5's PageRank (orders the more important), the file the modules stand in,
 * and one claim about the orders module — the fact a sentence of the page stands on.
 */
interface Graph {
  readonly productRepository: Fact;
  readonly codeRepository: Fact;
  readonly orders: Fact;
  readonly checkout: Fact;
  readonly file: Fact;
  readonly claim: Fact;
  facts(): readonly Fact[];
}

function fixture(): Graph {
  const productRepository = makeNodeFact({ kind: 'repository', value: { repository: PRODUCT_REPOSITORY, form: 'product' }, provenance: provenance(PRODUCT_REPOSITORY, 'README.md', 1), layer: 'extracted' });
  const codeRepository = makeNodeFact({ kind: 'repository', value: { repository: CODE_REPOSITORY, form: 'code' }, provenance: provenance(CODE_REPOSITORY, ORDER_FILE, 1), layer: 'extracted' });
  const orders = makeNodeFact({ kind: 'module', value: { repository: CODE_REPOSITORY, name: 'orders', seed: 'package', members: 9, importance: 0.75 }, provenance: provenance(CODE_REPOSITORY, ORDER_FILE, 1), layer: 'extracted' });
  const checkout = makeNodeFact({ kind: 'module', value: { repository: CODE_REPOSITORY, name: 'checkout', seed: 'package', members: 4, importance: 0.25 }, provenance: provenance(CODE_REPOSITORY, ORDER_FILE, 1), layer: 'extracted' });
  const file = makeNodeFact({ kind: 'file', value: { repository: CODE_REPOSITORY, path: repositoryPath(ORDER_FILE), roles: ['source'], language: 'typescript' }, provenance: provenance(CODE_REPOSITORY, ORDER_FILE, 1), layer: 'extracted' });
  const claim = makeNodeFact({
    kind: 'claim',
    value: { subject: { form: 'node', id: orders.id }, predicate: 'places', object: { form: 'literal', text: 'an order is placed once' }, text: 'the orders module places an order once', confidence: 0.6 },
    provenance: provenance(CODE_REPOSITORY, ORDER_FILE, 2),
    layer: 'inferred',
  });
  return {
    productRepository,
    codeRepository,
    orders,
    checkout,
    file,
    claim,
    facts: () => [
      productRepository,
      codeRepository,
      orders,
      checkout,
      file,
      claim,
      makeEdgeFact({ kind: 'contains', value: { from: codeRepository.id, to: orders.id }, provenance: provenance(CODE_REPOSITORY, ORDER_FILE, 1), layer: 'extracted' }),
      makeEdgeFact({ kind: 'contains', value: { from: codeRepository.id, to: checkout.id }, provenance: provenance(CODE_REPOSITORY, ORDER_FILE, 1), layer: 'extracted' }),
      makeEdgeFact({ kind: 'contains', value: { from: codeRepository.id, to: file.id }, provenance: provenance(CODE_REPOSITORY, ORDER_FILE, 1), layer: 'extracted' }),
    ],
  };
}

/** The deterministic stages' stand-in: it declares what the graph holds and plans no unit. */
function structureStage(): FillStage {
  return {
    id: 'structure',
    version: 1,
    consumes: { required: [], optional: [] },
    produces: ['repository', 'module', 'file', 'claim'].map((kind) => ({ kind, schemaVersion: FACT_KINDS[kind as 'module'].version, scope: 'repository' as const })),
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, config: {} },
    plan: () => ({ units: [] }),
    execute: () => ({ outcome: 'draft' }),
    validate: () => ({ ok: true }),
  };
}

interface World {
  readonly owner: DatabaseOwner;
  readonly graph: Graph;
  readonly orchestrator: FillOrchestrator;
  readonly server: StartedServer;
  readonly queue: QueueService;
  readonly productRepo: string;
  readonly record: string;
  sent(): readonly Record<string, unknown>[];
  close(): Promise<void>;
}

interface WorldOptions {
  readonly script: { readonly byPrompt: readonly { readonly matches: string; readonly steps: readonly unknown[] }[]; readonly steps: readonly unknown[] };
  readonly clock?: () => number;
}

async function openWorld(options: WorldOptions): Promise<World> {
  const folder = mkdtempSync(join(root!, 'world-'));
  const scriptPath = join(folder, 'script.json');
  writeFileSync(scriptPath, JSON.stringify(options.script));
  const record = join(folder, 'agent-record.jsonl');
  const clock = options.clock ?? (() => NOW);

  const owner = createPGliteDatabaseOwner();
  await createFillStateSchema(owner);
  await createOrchestratorSchema(owner);
  await createFactStoreSchema(owner);
  const queue = await createPgBossQueue({ owner, supervise: false });
  await queue.declare({ name: 'fill-units', leaseSeconds: 3_600, retries: 0, retryDelaySeconds: 0, retryBackoff: false, singletons: true });

  const graph = fixture();
  await createUnit(owner, { unitId: 'graph/all', product: PRODUCT, runId: 'run-seed', stageId: 'graph', scopeKey: 'all', inputsDigest: 'graph-inputs', retries: 0, at: NOW });
  const seed = await owner.transaction('snapshot', async (executor) => (await executor.query<{ unit_id: string; generation: number }>('SELECT unit_id, generation FROM fill_unit WHERE unit_id = $1', ['graph/all'])).rows[0]);
  if (seed === undefined) throw new Error('the fixture unit was not created');
  const seedGeneration = Number(seed.generation);
  const publishSeed = async (facts: readonly Fact[], generation: number): Promise<void> => {
    await owner.transaction('write', async (executor) => await applyPublishedFacts({
      executor,
      unit: { unitId: 'graph/all', generation } as Parameters<typeof applyPublishedFacts>[0]['unit'],
      plan: { unitId: 'graph/all', generation, runId: 'run-seed', stageId: 'graph', stageUnitId: 'all', scope: 'all', stagePosition: 0, planPosition: 0, plannedAt: NOW },
      digest: `graph-publication-${String(generation)}`,
      writes: facts.map((fact) => ({ kind: 'fact' as const, evidence: `${CODE_REPOSITORY}@${COMMITS[CODE_REPOSITORY] ?? ''}`, value: fact })),
    }));
  };
  await publishSeed(graph.facts(), seedGeneration);

  const pins: readonly RepositoryPin[] = [
    { id: PRODUCT_REPOSITORY, form: 'product', root: join(root!, PRODUCT_REPOSITORY), commit: COMMITS[PRODUCT_REPOSITORY]! },
    { id: CODE_REPOSITORY, form: 'code', root: join(root!, CODE_REPOSITORY), commit: COMMITS[CODE_REPOSITORY]! },
  ];
  const snapshots = createGitSnapshotSource(() => pins);
  const snapshot: RunSnapshot = { repository: 'example.invalid/acme/shop', defaultBranch: 'main', commit: COMMITS[PRODUCT_REPOSITORY]!, registryHash: 'sha256:registry' };
  const wiring: ProductFillWiring = {
    snapshot: () => snapshot,
    configuration: () => undefined,
    graph: () => createFactGraphReader({ database: owner, snapshot: snapshots }),
    inputs: () => ({}),
    source: () => snapshots,
  };
  const registry = new StageRegistry()
    .register(structureStage())
    .register(createNarrativeStage({
      snapshots,
      agent: { id: 'fake-agent', command: process.execPath, args: [FAKE_AGENT, '--scenario', 'script', '--script', scriptPath, '--record', record] },
      clock,
      cwd: folder,
      timeouts: { initializeMs: 30_000, sessionMs: 30_000 },
    }));

  let server: StartedServer | undefined;
  const service = createFillOrchestratorService({
    home: join(folder, 'products'),
    registry,
    owner,
    wiring: () => wiring,
    queueFactory: async () => queue,
    toolUrl: () => (server === undefined ? undefined : `${server.url}${UNIT_TOOL_PATH}`),
  });
  const appFolder = join(folder, 'app');
  mkdirSync(appFolder, { recursive: true });
  writeFileSync(join(appFolder, 'index.html'), '<!doctype html><title>fixture app</title>');
  const home = join(folder, 'home');
  mkdirSync(home, { recursive: true });
  server = await startServer({ productHome: home, appFolder, port: 0, orchestrator: service, log: () => undefined, errorLog: () => undefined });

  const orchestrator = createOrchestrator({
    database: owner,
    registry,
    queue,
    queueName: 'fill-units',
    product: PRODUCT,
    configuration: () => undefined,
    snapshot: () => snapshot,
    graph: async (ref, transaction) => createFactGraphReader({ database: owner, snapshot: snapshots, ...(transaction === undefined ? {} : { executor: transaction }) }),
    inputs: () => ({}),
    facts: FACT_APPLICATION,
    clock,
    unitTools: async (opening) => await service.unitTools({
      product: { name: PRODUCT, folder: home },
      unit: { unitId: opening.unit.unitId, generation: opening.unit.generation },
      url: `${server!.url}${UNIT_TOOL_PATH}`,
      draft: draftSetOf(opening.draft),
    }),
  });

  return {
    owner,
    graph,
    orchestrator,
    server,
    queue,
    productRepo: join(root!, PRODUCT_REPOSITORY),
    record,
    sent: () => readFileSync(record, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as Record<string, unknown>),
    close: async () => {
      await server!.stop();
      await service.stop();
      await queue.stop().catch(() => undefined);
      await owner.close();
    },
  };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'madarch-narrative-stage-'));
  const commits: Record<string, string> = {};
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });
  const make = (repository: string, files: Readonly<Record<string, string>>): string => {
    const folder = join(root!, repository);
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(join(folder, path, '..'), { recursive: true });
      writeFileSync(join(folder, path), body);
    }
    git(folder, 'init', '-q');
    git(folder, 'config', 'user.name', 'Fixture');
    git(folder, 'config', 'user.email', 'fixture@example.invalid');
    git(folder, 'add', '-A');
    git(folder, 'commit', '-qm', 'one');
    return git(folder, 'rev-parse', 'HEAD').trim();
  };
  commits[PRODUCT_REPOSITORY] = make(PRODUCT_REPOSITORY, { 'README.md': README_BODY });
  commits[CODE_REPOSITORY] = make(CODE_REPOSITORY, { [ORDER_FILE]: ORDER_BODY });
  COMMITS = commits;
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

function prompts(opened: World): readonly string[] {
  return opened.sent()
    .filter((message) => message['method'] === 'session/prompt')
    .map((message) => String(((message['params'] as { prompt?: { text?: string }[] }).prompt ?? [])[0]?.text ?? ''));
}

/** The page's write, as the fake agent asserts it: one sentence, tied to the claim and the file it stands on. */
function pageCall(about: string, facts: readonly string[]): unknown {
  return {
    call: {
      tool: 'assert_fact',
      arguments: {
        kind: 'narrative',
        value: {
          about,
          sentences: [{ text: 'The orders module places an order once.', facts }],
        },
        place: { repository: CODE_REPOSITORY, file: ORDER_FILE, startLine: 1, endLine: 2 },
      },
    },
  };
}

const factsOf = async (opened: World, unitId: string): Promise<readonly Fact[]> => (await readUnitFacts(opened.owner, unitId)).map((entry) => entry.fact);

describe('the pages stage', () => {
  test('the plan names one unit per page, most important first, and a narrated page is named no more', async () => {
    const ids = fixture();
    const opened = await openWorld({
      script: {
        byPrompt: [{ matches: ids.claim.id, steps: [pageCall(ids.orders.id, [ids.claim.id, ids.file.id].sort()), { answer: { status: 'done', covered: [ids.orders.id], remaining: [], summary: 'The orders module places an order once' } }] }],
        // Every other page's unit covers what its packet showed and writes no page: a page of one
        // sentence is a page, and a unit that found nothing to say still reports what it read.
        steps: [{ answerMembers: {} }],
      },
    });
    try {
      // One unit per page-worthy node: the two modules, then the two repositories the graph holds —
      // orders (0.75) before checkout (0.25), the unranked pages after them in code point order.
      const started = await startRun(opened.orchestrator, { runId: RUN });
      expect(started.ok).toBe(true);
      const plannedRun = await planRun(opened.orchestrator, { runId: RUN });
      if (plannedRun.outcome !== 'planned') throw new Error(`the run was not planned: ${JSON.stringify(plannedRun)}`);
      expect(plannedRun.units.map((unit) => unit.stageId)).toEqual([NARRATIVE_STAGE_ID, NARRATIVE_STAGE_ID, NARRATIVE_STAGE_ID, NARRATIVE_STAGE_ID]);
      const nodes = plannedRun.units.map((unit) => unit.unitId.split('/')[1]);
      expect(nodes[0]).toBe(ids.orders.id);
      expect(nodes[1]).toBe(ids.checkout.id);
      expect(new Set(nodes.slice(2))).toEqual(new Set([ids.codeRepository.id, ids.productRepository.id]));
      // Each unit's scope is its node's place: the file a module stands in, in its repository.
      expect(plannedRun.units.slice(0, 2).every((unit) => unit.scope.startsWith(`${CODE_REPOSITORY}:`))).toBe(true);
      await opened.close();
    } finally {
      // closed above
    }
  }, 240_000);

  test('a unit writes its page through the checked writes, publishes it proposed, and the page shows above the facts', async () => {
    const ids = fixture();
    const opened = await openWorld({
      script: {
        byPrompt: [{ matches: ids.claim.id, steps: [pageCall(ids.orders.id, [ids.claim.id, ids.file.id].sort()), { answer: { status: 'done', covered: [ids.orders.id], remaining: [], summary: 'The orders module places an order once' } }] }],
        steps: [],
      },
    });
    try {
      const started = await startRun(opened.orchestrator, { runId: RUN });
      expect(started.ok).toBe(true);
      const planned = await planRun(opened.orchestrator, { runId: RUN });
      if (planned.outcome !== 'planned') throw new Error(`the run was not planned: ${JSON.stringify(planned)}`);
      // Four pages: the two modules and the two repositories.
      expect(planned.units.length).toBe(4);
      const pass = await schedulerPass(opened.orchestrator, { runId: RUN });
      // The stage's own concurrency holds how many of its units run at once; the plan's order decides
      // which one it is, and the plan's order is the importance's.
      expect(pass.admitted).toBeGreaterThanOrEqual(1);
      const worked = await workOnce(opened.orchestrator, { worker: 'w1' });
      expect(worked.result).toBe('published');
      // The most important page first: the run's plan names the orders unit, and it is admitted first.
      expect(worked.unitId).toBe(`narrative/${ids.orders.id}`);

      // The prompt was the fixed part and the packet, within 0026's window, carrying the statements a
      // sentence can name.
      const sent = prompts(opened);
      expect(sent.length).toBe(1);
      const first = sent[0]!;
      expect(first).toContain('writes one page\'s narrative text');
      expect(first).toContain('What you write is meaning');
      expect(first).toContain('Facts this unit may write: coverage, narrative — and nothing else');
      expect(first).toContain(ids.claim.id);
      expect(estimateTokens(first, DEFAULT_GRAPH_READ_LIMITS)).toBeLessThanOrEqual(20_000);

      // The unit's product: the page fact, proposed at the inferred layer, and its coverage of what it read.
      const published = await factsOf(opened, worked.unitId!);
      const page = published.find((fact) => fact.kind === 'narrative');
      expect(page).toBeDefined();
      expect(page?.status).toBe('proposed');
      expect(page?.layer).toBe('inferred');
      expect((page?.value as { about?: string }).about).toBe(ids.orders.id);
      expect((page?.value as { sentences?: readonly { text: string; facts: readonly string[] }[] }).sentences).toEqual([
        { text: 'The orders module places an order once.', facts: [ids.claim.id, ids.file.id].sort() },
      ]);
      const coverage = published.find((fact) => fact.kind === 'coverage');
      expect((coverage?.value as { scope?: string }).scope).toBe(ids.orders.id);

      // The page's model shows the narrative above the facts: proposed, not stale, the sentence standing.
      const model = await readPageModel({ database: opened.owner, product: PRODUCT, id: ids.orders.id });
      if (!model.ok) throw new Error(`the page was not read: ${model.message}`);
      expect(model.page.narrative).not.toBeNull();
      expect(model.page.narrative?.status).toBe(NARRATIVE_PAGE_STATUS);
      expect(model.page.narrative?.path).toBe(narrativePagePath(ids.orders.id));
      expect(model.page.narrative?.stale).toBe(false);
      expect(model.page.narrative?.sentences.map((sentence) => ({ text: sentence.text, stale: sentence.stale }))).toEqual([
        { text: 'The orders module places an order once.', stale: false },
      ]);

      // The outbox: the page's Markdown stands in the product's git, proposed, written by the fill.
      const outbox = await commitNarrativePages({ database: opened.owner, folder: opened.productRepo, product: PRODUCT, clock: () => NOW });
      expect(outbox.committed.map((page) => page.path)).toEqual([narrativePagePath(ids.orders.id)]);
      const standing = readFileSync(join(opened.productRepo, narrativePagePath(ids.orders.id)), 'utf8');
      expect(standing).toBe(renderNarrativePage({ about: ids.orders.id, sentences: [{ text: 'The orders module places an order once.', facts: [ids.claim.id, ids.file.id].sort() }] }));
      expect(standing).toContain(`status: ${NARRATIVE_PAGE_STATUS}`);
      expect(standing).toContain(`writer: ${NARRATIVE_PAGE_WRITER}`);
    } finally {
      await opened.close();
    }
  }, 240_000);

  test('a sentence whose facts change is marked stale, and its unit is replanned by the sweep', async () => {
    const ids = fixture();
    const opened = await openWorld({
      script: {
        // The first generation cites the claim; the run's other pages' units cover what their packets
        // showed and write no page — a page of one sentence is a page, and no unit writes another node's.
        byPrompt: [{ matches: ids.claim.id, steps: [pageCall(ids.orders.id, [ids.claim.id, ids.file.id].sort()), { answer: { status: 'done', covered: [ids.orders.id], remaining: [], summary: 'The orders module places an order once' } }] }],
        steps: [{ answerMembers: {} }],
      },
    });
    try {
      const started = await startRun(opened.orchestrator, { runId: RUN });
      expect(started.ok).toBe(true);
      await planRun(opened.orchestrator, { runId: RUN });
      await schedulerPass(opened.orchestrator, { runId: RUN });
      const worked = await workOnce(opened.orchestrator, { worker: 'w1' });
      expect(worked.result).toBe('published');
      expect(worked.unitId).toBe(`narrative/${ids.orders.id}`);

      // The claim stands no more: the seed's next generation holds the graph without it.
      const withoutClaim = fixture().facts().filter((fact) => fact.id !== ids.claim.id);
      const seed = await opened.owner.transaction('snapshot', async (executor) => (await executor.query<{ generation: number }>('SELECT generation FROM fill_unit WHERE unit_id = $1', ['graph/all'])).rows[0]);
      const next = Number(seed?.generation ?? 1) + 1;
      await opened.owner.transaction('write', async (executor) => await applyPublishedFacts({
        executor,
        unit: { unitId: 'graph/all', generation: next } as Parameters<typeof applyPublishedFacts>[0]['unit'],
        plan: { unitId: 'graph/all', generation: next, runId: 'run-seed', stageId: 'graph', stageUnitId: 'all', scope: 'all', stagePosition: 0, planPosition: 0, plannedAt: NOW },
        digest: `graph-publication-${String(next)}`,
        writes: withoutClaim.map((fact) => ({ kind: 'fact' as const, evidence: `${CODE_REPOSITORY}@${COMMITS[CODE_REPOSITORY] ?? ''}`, value: fact })),
      }));

      // The page marks its sentence stale at once: the fact it stands on stands in the graph no more.
      const before = await readPageModel({ database: opened.owner, product: PRODUCT, id: ids.orders.id });
      if (!before.ok) throw new Error('the page was not read');
      expect(before.page.narrative?.sentences[0]?.stale).toBe(true);
      expect(before.page.narrative?.stale).toBe(false);

      // The run writes its remaining pages; the pass that would settle it first asks whether what it
      // published still stands — and the page's reads moved, so the unit is marked stale and its
      // replacement generation is opened. The check stands between the pass and the worker, so the
      // moment is read before the replacement can run.
      const firstGeneration = worked.generation ?? 1;
      let pageUnit: Awaited<ReturnType<typeof readRunUnits>>[number] | undefined;
      for (let at = 0; at < 12; at += 1) {
        await schedulerPass(opened.orchestrator, { runId: RUN });
        const units = await readRunUnits(opened.owner, RUN);
        pageUnit = units.find((unit) => unit.unitId === worked.unitId);
        if (pageUnit !== undefined && pageUnit.generation > firstGeneration) break;
        await workOnce(opened.orchestrator, { worker: 'w1' });
      }
      expect(pageUnit?.state).toBe('planned');
      expect(pageUnit?.generation).toBe(firstGeneration + 1);
      const replanned = await readPageModel({ database: opened.owner, product: PRODUCT, id: ids.orders.id });
      if (!replanned.ok) throw new Error('the page was not read');
      // The layer itself says it: the page's unit was replanned, and this page is the stale record.
      expect(replanned.page.narrative?.stale).toBe(true);

      // The replacement runs and writes no page: the graph holds the page's sentence no more, so the
      // stale page goes with the unit's own product, and the page shows no narrative until a new one
      // is written. A pass admits what the last one opened, so the pass and the worker alternate.
      for (let at = 0; at < 12; at += 1) {
        await schedulerPass(opened.orchestrator, { runId: RUN });
        await workOnce(opened.orchestrator, { worker: 'w1' });
        const units = await readRunUnits(opened.owner, RUN);
        pageUnit = units.find((unit) => unit.unitId === worked.unitId);
        if (pageUnit !== undefined && pageUnit.generation === firstGeneration + 1 && pageUnit.state === 'published') break;
      }
      expect(pageUnit?.state).toBe('published');
      expect(pageUnit?.generation).toBe(firstGeneration + 1);
      const settled = await readPageModel({ database: opened.owner, product: PRODUCT, id: ids.orders.id });
      if (!settled.ok) throw new Error('the page was not read');
      expect(settled.page.narrative).toBeNull();
      // The replacement's own product is its coverage of what it read; the page it does not rewrite
      // stands published no more.
      const published = await factsOf(opened, worked.unitId!);
      expect(published.some((fact) => fact.kind === 'narrative')).toBe(false);
      const coverage = published.find((fact) => fact.kind === 'coverage');
      expect((coverage?.value as { scope?: string }).scope).toBe(ids.orders.id);
    } finally {
      await opened.close();
    }
  }, 240_000);

  test('a sentence citing a fact the graph does not hold is refused by the checked write, by the id', async () => {
    const ids = fixture();
    const missing = `claim:${'e'.repeat(64)}`;
    const opened = await openWorld({
      script: {
        byPrompt: [],
        steps: [
          pageCall(ids.orders.id, [missing]),
          // Asked again, the unit writes the page on the facts that stand.
          pageCall(ids.orders.id, [ids.file.id]),
          { answer: { status: 'done', covered: [ids.orders.id], remaining: [], summary: 'The orders module places an order once' } },
        ],
      },
    });
    try {
      const started = await startRun(opened.orchestrator, { runId: RUN });
      expect(started.ok).toBe(true);
      await planRun(opened.orchestrator, { runId: RUN });
      await schedulerPass(opened.orchestrator, { runId: RUN });
      const worked = await workOnce(opened.orchestrator, { worker: 'w1' });
      expect(worked.result).toBe('published');
      expect(worked.unitId).toBe(`narrative/${ids.orders.id}`);
      // The page's write naming the missing id was refused in the turn it was made (the write path's own
      // contract, checked at once), and the unit's second call is the one that landed: the page stands on
      // the facts that exist, and the fact that stands nowhere appears nowhere in it.
      const published = await factsOf(opened, worked.unitId!);
      const page = published.find((fact) => fact.kind === 'narrative');
      expect(page).toBeDefined();
      expect((page?.value as { sentences?: readonly { facts: readonly string[] }[] }).sentences?.[0]?.facts).toEqual([ids.file.id]);
      expect(JSON.stringify(page)).not.toContain(missing);
      // The draft set holds no second page: a refused write is in no draft.
      const pages = published.filter((fact) => fact.kind === 'narrative');
      expect(pages.length).toBe(1);
    } finally {
      await opened.close();
    }
  }, 240_000);
});
