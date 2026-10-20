/**
 * Stage 8, the product's overview hypothesis, end to end on the agent-stage shape of
 * madarch-tzte.24.1 (decision 0026, "Stage 8 overview hypothesis", "Agent input" and
 * "Scale"; 0027's publication, split and join).
 *
 * A unit of the whole product receives the fixed part and a packet of at most 0026's
 * 20K tokens assembled from the repository-level graph — its repositories, its modules
 * with the importance stage 5's PageRank gave them, its entry points, its packages and
 * its documents' sections — writes claims through the checked write path, and its
 * coverage says what of the product it read. Every expectation is taken from the task
 * and the decisions: 0026's numbers, the answer contract the stage declares, the
 * hierarchy's levels, and 0027's publication and split semantics. The agent is the fake
 * ACP agent of `test/fixtures/acp-fake-agent` (no real prompt, no network, no token
 * spent), the MCP server is the real one of madarch-tzte.22.2 answering through the
 * real server route, and time passes through a seam, never a sleep.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { createFactStoreSchema, applyPublishedFacts, readUnitFacts } from '../src/fill/fact-store.js';
import { makeEdgeFact, makeNodeFact, repositoryPath, type Fact, type FactProvenance } from '../src/fill/facts.js';
import { createFactGraphReader, estimateTokens, DEFAULT_GRAPH_READ_LIMITS } from '../src/fill/graph-reads.js';
import { draftSetOf } from '../src/fill/checked-writes.js';
import { createFillOrchestratorService, type ProductFillWiring } from '../src/fill/orchestrator-host.js';
import {
  createOrchestrator,
  planRun,
  schedulerPass,
  startRun,
  workOnce,
  type FillOrchestrator,
} from '../src/fill/orchestrator.js';
import { createOrchestratorSchema, readProgress, readUnitDraft, readUnitPlan, type RunSnapshot } from '../src/fill/orchestrator-store.js';
import { createStageRegistry } from '../src/fill/stages/index.js';
import {
  OVERVIEW_KINDS,
  OVERVIEW_STAGE_ID,
  createOverviewStage,
  overviewDeclaration,
} from '../src/fill/stages/overview.js';
import { PRODUCT_SCOPE_NAME } from '../src/fill/stages/agent-stage.js';
import { StageRegistry } from '../src/fill/registry.js';
import { DEFAULT_STAGE_DEFAULTS, type FillStage } from '../src/fill/stage.js';
import { FACT_KINDS } from '../src/fill/facts.js';
import { PRODUCT_SCOPE } from '../src/fill/checked-writes.js';
import { FACT_APPLICATION } from '../src/fill/fact-store.js';
import { Type } from 'typebox';
import { createGitSnapshotSource, type RepositoryPin } from '../src/fill/snapshot.js';
import { createFillStateSchema, createUnit, readRunUnits } from '../src/fill/state-store.js';
import { UNIT_TOOL_PATH } from '../src/fill/unit-tools.js';
import { startServer, type StartedServer } from '../src/server/http.js';
import type { QueueService } from '../src/fill/queue.js';

const NOW = 1_700_000_000_000;
const PRODUCT = 'fixture-product';
const RUN = 'run-2026-10-20T07:00Z';
/** The product's own repository, and the one code repository the product is made of (0021, 0026's hierarchy). */
const PRODUCT_REPOSITORY = 'acme-shop';
const CODE_REPOSITORY = 'orders-api';
/** The files the pinned commits hold, and the lines a claim may cite. */
const PRODUCT_README = 'README.md';
const ORDER_FILE = 'src/order.ts';
const ORDER_BODY = 'export function placeOrder(cart) {\n  return { total: cart.total, state: "placed" };\n}\n';
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

/** The repository-level graph stage 8 reads: two repositories, two modules, an entry point, a package, a document and a section. */
interface Graph {
  readonly productRepository: Fact;
  readonly codeRepository: Fact;
  readonly checkout: Fact;
  readonly orders: Fact;
  readonly entry: Fact;
  readonly pkg: Fact;
  readonly document: Fact;
  readonly section: Fact;
  facts(): readonly Fact[];
}

function fixture(): Graph {
  const productRepository = makeNodeFact({ kind: 'repository', value: { repository: PRODUCT_REPOSITORY, form: 'product' }, provenance: provenance(PRODUCT_REPOSITORY, PRODUCT_README, 1), layer: 'extracted' });
  const codeRepository = makeNodeFact({ kind: 'repository', value: { repository: CODE_REPOSITORY, form: 'code' }, provenance: provenance(CODE_REPOSITORY, ORDER_FILE, 1), layer: 'extracted' });
  // Two modules of one repository, ranked by the importance stage 5's PageRank gave them (0026: "modules … by
  // importance"), in the order the packet's own section ranks them.
  const checkout = makeNodeFact({ kind: 'module', value: { repository: CODE_REPOSITORY, name: 'checkout', seed: 'package', members: 4, importance: 0.25 }, provenance: provenance(CODE_REPOSITORY, ORDER_FILE, 1), layer: 'extracted' });
  const orders = makeNodeFact({ kind: 'module', value: { repository: CODE_REPOSITORY, name: 'orders', seed: 'package', members: 9, importance: 0.75 }, provenance: provenance(CODE_REPOSITORY, ORDER_FILE, 1), layer: 'extracted' });
  const entry = makeNodeFact({ kind: 'entry-point', value: { repository: CODE_REPOSITORY, file: repositoryPath(ORDER_FILE), name: 'POST /orders', form: 'http-route' }, provenance: provenance(CODE_REPOSITORY, ORDER_FILE, 1), layer: 'extracted' });
  // A package stands at its own manifest's bytes (`FACT_KINDS.package`), which the fixture repository holds.
  const pkg = makeNodeFact({ kind: 'package', value: { repository: CODE_REPOSITORY, form: 'package', name: 'orders-api', manifest: repositoryPath('package.json') }, provenance: provenance(CODE_REPOSITORY, 'package.json', 1), layer: 'extracted' });
  const document = makeNodeFact({ kind: 'document', value: { repository: PRODUCT_REPOSITORY, path: repositoryPath(PRODUCT_README), mediaType: 'text/markdown', title: 'acme shop' }, provenance: provenance(PRODUCT_REPOSITORY, PRODUCT_README, 1), layer: 'extracted' });
  const section = makeNodeFact({ kind: 'section', value: { repository: PRODUCT_REPOSITORY, document: repositoryPath(PRODUCT_README), anchor: 'what-it-is', heading: 'What it is', level: 1 }, provenance: provenance(PRODUCT_REPOSITORY, PRODUCT_README, 2), layer: 'extracted' });
  return {
    productRepository,
    codeRepository,
    checkout,
    orders,
    entry,
    pkg,
    document,
    section,
    facts: () => [
      productRepository,
      codeRepository,
      checkout,
      orders,
      entry,
      pkg,
      document,
      section,
      makeEdgeFact({ kind: 'contains', value: { from: codeRepository.id, to: orders.id }, provenance: provenance(CODE_REPOSITORY, ORDER_FILE, 1), layer: 'extracted' }),
      makeEdgeFact({ kind: 'contains', value: { from: codeRepository.id, to: checkout.id }, provenance: provenance(CODE_REPOSITORY, ORDER_FILE, 1), layer: 'extracted' }),
      makeEdgeFact({ kind: 'contains', value: { from: productRepository.id, to: document.id }, provenance: provenance(PRODUCT_REPOSITORY, PRODUCT_README, 1), layer: 'extracted' }),
      makeEdgeFact({ kind: 'contains', value: { from: document.id, to: section.id }, provenance: provenance(PRODUCT_REPOSITORY, PRODUCT_README, 2), layer: 'extracted' }),
    ],
  };
}

/**
 * The stand-in for the deterministic stages this fixture publishes the facts of: it
 * declares the capabilities stage 8 requires (`repository`, `module`) so the derived
 * stage graph knows where its inputs come from, and it plans no unit, because the
 * graph is already published.
 */
function structureStage(): FillStage {
  return {
    id: 'structure',
    version: 1,
    consumes: { required: [], optional: [] },
    produces: ['repository', 'module', 'entry-point', 'package', 'document', 'section'].map((kind) => ({ kind, schemaVersion: FACT_KINDS[kind as 'module'].version, scope: 'repository' as const })),
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, config: {} },
    plan: () => ({ units: [] }),
    execute: () => ({ outcome: 'draft' }),
    validate: () => ({ ok: true }),
  };
}

/** One world: a database with the fill's tables and the fixture graph, the orchestrator, the tool host and a fake agent's script. */
interface World {
  readonly owner: DatabaseOwner;
  readonly graph: Graph;
  readonly orchestrator: FillOrchestrator;
  readonly server: StartedServer;
  readonly queue: QueueService;
  readonly record: string;
  sent(): readonly Record<string, unknown>[];
  close(): Promise<void>;
}

/** What one world is opened with: the fake agent's steps, and the orchestrator's own limits where a test holds them still. */
interface WorldOptions {
  readonly script: { readonly byPrompt: readonly { readonly matches: string; readonly steps: readonly unknown[] }[]; readonly steps: readonly unknown[] };
  readonly clock?: () => number;
  readonly limits?: Parameters<typeof createOrchestrator>[0]['limits'];
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
  const record0 = { unitId: 'graph/all', generation: Number(seed.generation) } as Parameters<typeof applyPublishedFacts>[0]['unit'];
  await owner.transaction('write', async (executor) => await applyPublishedFacts({
    executor,
    unit: record0,
    plan: { unitId: 'graph/all', generation: record0.generation, runId: 'run-seed', stageId: 'graph', stageUnitId: 'all', scope: 'all', stagePosition: 0, planPosition: 0, plannedAt: NOW },
    digest: 'graph-publication-1',
    writes: graph.facts().map((fact) => ({ kind: 'fact' as const, evidence: `${CODE_REPOSITORY}@${COMMITS[CODE_REPOSITORY] ?? ''}`, value: fact })),
  }));

  const pins: readonly RepositoryPin[] = [
    { id: PRODUCT_REPOSITORY, form: 'product', root: join(root!, PRODUCT_REPOSITORY), commit: COMMITS[PRODUCT_REPOSITORY]! },
    { id: CODE_REPOSITORY, form: 'code', root: join(root!, CODE_REPOSITORY), commit: COMMITS[CODE_REPOSITORY]! },
  ];
  const snapshots = createGitSnapshotSource(() => pins);
  const snapshot: RunSnapshot = { repository: 'example.invalid/acme/shop', defaultBranch: 'main', commit: COMMITS[CODE_REPOSITORY]!, registryHash: 'sha256:registry' };
  const wiring: ProductFillWiring = {
    snapshot: () => snapshot,
    configuration: () => undefined,
    graph: () => createFactGraphReader({ database: owner, snapshot: snapshots }),
    inputs: () => ({}),
    source: () => snapshots,
  };
  const registry = new StageRegistry()
    .register(structureStage())
    .register(createOverviewStage({
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
  // Port 0: the server names a free one, and nothing here takes another process's port.
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
    ...(options.limits === undefined ? {} : { limits: options.limits }),
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
  root = mkdtempSync(join(tmpdir(), 'madarch-overview-stage-'));
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
  commits[PRODUCT_REPOSITORY] = make(PRODUCT_REPOSITORY, { [PRODUCT_README]: README_BODY, 'docs/index.md': '# Index\n' });
  commits[CODE_REPOSITORY] = make(CODE_REPOSITORY, { [ORDER_FILE]: ORDER_BODY, 'package.json': '{"name":"orders-api"}\n' });
  COMMITS = commits;
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

/** Plans and admits the run's one unit — the product's — and returns it. */
async function planAndAdmit(opened: World): Promise<{ unitId: string; generation: number }> {
  const started = await startRun(opened.orchestrator, { runId: RUN });
  expect(started.ok).toBe(true);
  const planned = await planRun(opened.orchestrator, { runId: RUN });
  if (planned.outcome !== 'planned') throw new Error(`the run was not planned: ${JSON.stringify(planned)}`);
  expect(planned.units.map((unit) => unit.stageId)).toEqual([OVERVIEW_STAGE_ID]);
  // 0026's hierarchy, its top: one unit for the whole product, whose scope is every repository the run pins.
  expect(planned.units.length).toBe(1);
  expect(planned.units[0]?.scope).toBe(PRODUCT_SCOPE);
  const pass = await schedulerPass(opened.orchestrator, { runId: RUN });
  expect(pass.admitted).toBe(1);
  return { unitId: planned.units[0]!.unitId, generation: planned.units[0]!.generation };
}

/** The prompt texts the fake agent was sent, in order. */
function prompts(opened: World): readonly string[] {
  return opened.sent()
    .filter((message) => message['method'] === 'session/prompt')
    .map((message) => String(((message['params'] as { prompt?: { text?: string }[] }).prompt ?? [])[0]?.text ?? ''));
}

/** One claim of the product, as the fake agent asserts it through `assert_fact`. */
function claimCall(options: { subject: string; predicate: string; text: string; repository: string; file: string; line: number }): unknown {
  return {
    call: {
      tool: 'assert_fact',
      arguments: {
        kind: 'claim',
        value: { subject: { form: 'node', id: options.subject }, predicate: options.predicate, object: { form: 'literal', text: options.text }, text: options.text, confidence: 0.6 },
        place: { repository: options.repository, file: options.file, startLine: options.line, endLine: options.line },
      },
    },
  };
}

/** The facts a unit published, as the store holds them. */
async function publishedFacts(opened: World, unitId: string): Promise<readonly Fact[]> {
  return (await readUnitFacts(opened.owner, unitId)).map((entry) => entry.fact);
}

describe('stage 8, the product\'s overview hypothesis', () => {
  test('one unit of the whole product writes its claims through the checked writes and publishes them with its coverage', async () => {
    const ids = fixture();
    const opened = await openWorld({
      script: {
        byPrompt: [],
        steps: [
          { say: 'reading the product' },
          // A claim about a module of the code repository, cited to that repository's bytes: the unit's scope is the
          // product, so a write in any repository it pins stands inside it.
          claimCall({ subject: ids.orders.id, predicate: 'carries', text: 'orders carries the checkout', repository: CODE_REPOSITORY, file: ORDER_FILE, line: 1 }),
          // A claim about the product repository's own document.
          claimCall({ subject: ids.document.id, predicate: 'states', text: 'the shop takes an order and settles it', repository: PRODUCT_REPOSITORY, file: PRODUCT_README, line: 3 }),
          { answer: { status: 'done', covered: [PRODUCT_REPOSITORY, CODE_REPOSITORY], remaining: [], summary: 'The shop takes an order and settles it' } },
        ],
      },
    });
    try {
      const unit = await planAndAdmit(opened);
      const worked = await workOnce(opened.orchestrator, { worker: 'w1' });
      expect(worked.result).toBe('published');
      expect(worked.unitId).toBe(unit.unitId);

      // The prompt the agent received: the stage's own fixed part, the repository-level packet, within 0026's 20K.
      const sent = prompts(opened);
      expect(sent.length).toBe(1);
      const prompt = sent[0]!;
      expect(prompt).toContain('You are one unit of madarch\'s fill that writes the product\'s overview hypothesis');
      expect(prompt).toContain('What you write is meaning');
      expect(prompt).toContain('Facts this unit may write: answer, claim, coverage, question — and nothing else');
      expect(estimateTokens(prompt, DEFAULT_GRAPH_READ_LIMITS)).toBeLessThanOrEqual(20_000);
      // The packet is the last JSON object of the prompt, after the fixed part: the fixed part has blank lines of its
      // own, so the packet is read from where the object opens.
      const packet = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n{') + 2)) as Record<string, unknown>;
      // 0026's "Agent input" for this stage: the product, its repositories, its modules by importance, its entry
      // points, its packages, its documents and their sections — and the kinds it may write, in code point order.
      expect(Object.keys(packet)).toEqual(['unit', 'place', 'repositories', 'modules', 'entryPoints', 'packages', 'documents', 'sections', 'writes', 'marker']);
      expect((packet['place'] as { product?: unknown }).product).toBe(true);
      expect((packet['place'] as { repositories?: { repository: string; commit: string }[] }).repositories?.map((entry) => [entry.repository, entry.commit])).toEqual([
        [PRODUCT_REPOSITORY, COMMITS[PRODUCT_REPOSITORY]!],
        [CODE_REPOSITORY, COMMITS[CODE_REPOSITORY]!],
      ]);
      // The modules by the importance stage 5 ranked them with, the more important first.
      expect((packet['modules'] as { name: string; importance: number }[]).map((row) => [row.name, row.importance])).toEqual([['orders', 0.75], ['checkout', 0.25]]);
      expect((packet['entryPoints'] as { name: string }[]).map((row) => row.name)).toEqual(['POST /orders']);
      expect((packet['packages'] as { name: string }[]).map((row) => row.name)).toEqual(['orders-api']);
      expect((packet['documents'] as { path: string }[]).map((row) => row.path)).toEqual([PRODUCT_README]);
      expect((packet['sections'] as { heading: string }[]).map((row) => row.heading)).toEqual(['What it is']);
      expect(packet['marker']).toBeNull();
      // 0026's packet list: the task the unit is for, in one sentence (0026's "the task").
      expect((packet['unit'] as { scope: string }).scope).toBe(PRODUCT_SCOPE);

      // What it published: its two claims and the coverage of the product, one fact per repository.
      const published = await publishedFacts(opened, unit.unitId);
      expect(published.map((fact) => fact.kind).sort()).toEqual(['claim', 'claim', 'coverage', 'coverage']);
      const claims = published.filter((fact) => fact.kind === 'claim');
      // The claim about the code repository's module cites that repository's bytes: a unit of the whole product writes
      // in whichever repository it pinned, and the evidence names the one it read.
      const orderClaim = claims.find((fact) => fact.provenance.repository.id === CODE_REPOSITORY);
      expect(orderClaim).toBeDefined();
      expect(String(orderClaim?.provenance.place?.file)).toBe(ORDER_FILE);
      expect(orderClaim?.layer).toBe('inferred');
      expect(orderClaim?.status).toBe('proposed');
      expect(String(claims.find((fact) => fact.provenance.repository.id === PRODUCT_REPOSITORY)?.provenance.place?.file)).toBe(PRODUCT_README);
      const coverages = published.filter((fact) => fact.kind === 'coverage').map((fact) => fact.value as unknown as { repository: string; scope: string; complete: boolean; read: readonly string[] });
      // One coverage per repository the unit's places stand in, each naming the graph's word for a product-wide scope;
      // the store answers the published facts by id, so the two are compared in code point order of the repository.
      const ordered = (rows: readonly (readonly [string, string, boolean, readonly string[]])[]): readonly (readonly [string, string, boolean, readonly string[]])[] =>
        [...rows].sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
      expect(ordered(coverages.map((coverage) => [coverage.repository, coverage.scope, coverage.complete, coverage.read] as const))).toEqual(ordered([
        [PRODUCT_REPOSITORY, PRODUCT_SCOPE_NAME, true, [PRODUCT_REPOSITORY]],
        [CODE_REPOSITORY, PRODUCT_SCOPE_NAME, true, [CODE_REPOSITORY]],
      ] as const));
      expect((await readRunUnits(opened.owner, RUN)).map((record) => record.state)).toEqual(['published']);
    } finally {
      await opened.close();
    }
  }, 180_000);

  test('a write outside the product\'s pinned repositories lands nothing, and the unit\'s answer is what publishes', async () => {
    const ids = fixture();
    const opened = await openWorld({
      script: {
        byPrompt: [],
        steps: [
          { say: 'writing' },
          // A claim cited to a repository this run pins nowhere: the checked write refuses it by name, and nothing of it
          // lands in the unit's draft set.
          claimCall({ subject: ids.orders.id, predicate: 'carries', text: 'orders carries the checkout', repository: 'somewhere-else', file: ORDER_FILE, line: 1 }),
          { answer: { status: 'done', covered: [PRODUCT_REPOSITORY, CODE_REPOSITORY], remaining: [], summary: 'nothing was written' } },
        ],
      },
    });
    try {
      const unit = await planAndAdmit(opened);
      const worked = await workOnce(opened.orchestrator, { worker: 'w1' });
      expect(worked.result).toBe('published');
      const published = await publishedFacts(opened, unit.unitId);
      // Nothing of the refused write stands, not even in part: the unit published its coverage alone and carried on
      // (the refusal itself, which names the repositories the run does pin, is held by `test/fill-checked-writes.test.ts`).
      expect(published.filter((fact) => fact.kind === 'claim')).toEqual([]);
      expect(published.map((fact) => fact.kind).sort()).toEqual(['coverage', 'coverage']);
    } finally {
      await opened.close();
    }
  }, 180_000);

  test('a malformed answer is refused by the field it got wrong, the unit is asked again, and the second answer publishes', async () => {
    const opened = await openWorld({
      script: {
        // The first turn's object has no `status`: the answer schema names the field it lacks, and the unit is asked
        // again — inside 0026's turn limit, not as a failure. The fake agent runs the `steps` of every prompt, so the
        // turn that answers is the one that matches the nudge.
        byPrompt: [{ matches: 'That was not the answer', steps: [
          { answer: { status: 'done', covered: [PRODUCT_REPOSITORY, CODE_REPOSITORY], remaining: [], summary: 'the product was read' } },
        ] }],
        steps: [
          { say: 'reading the product' },
          { say: '{"covered":[],"remaining":[]}' },
          { end: {} },
        ],
      },
    });
    try {
      const unit = await planAndAdmit(opened);
      const worked = await workOnce(opened.orchestrator, { worker: 'w1' });
      expect(worked.result).toBe('published');
      const sent = prompts(opened);
      expect(sent.length).toBe(2);
      // The nudge names the field the answer lacked, and the shape the unit must answer with.
      expect(sent[1]).toContain('That was not the answer this unit contract asks for.');
      expect(sent[1]).toContain('the answer names no `status`');
      expect(sent[1]).toContain('{"status":"done"|"partial"');
      // The unit is shown the places of its own scope, which for a unit of the product are its repositories: an answer
      // that names them can be given without reading the packet again.
      expect(sent[1]).toContain('The repositories of the product are: acme-shop, orders-api.');
      expect((await publishedFacts(opened, unit.unitId)).length).toBe(2);
    } finally {
      await opened.close();
    }
  }, 180_000);

  test('a unit whose answer calls itself partial publishes no complete coverage, whatever its place list says', async () => {
    const opened = await openWorld({
      script: {
        byPrompt: [],
        // 0026's unit contract: `partial` is the unit's own word for "I did not finish", and 0005 makes a complete
        // coverage the only ground for a claim of absence — so a `partial` answer never claims one, even when its
        // `remaining` list is empty.
        steps: [{ say: 'read both repositories, but not to the end' }, { answer: { status: 'partial', covered: [PRODUCT_REPOSITORY, CODE_REPOSITORY], remaining: [], summary: 'a first look only' } }],
      },
    });
    try {
      const unit = await planAndAdmit(opened);
      const worked = await workOnce(opened.orchestrator, { worker: 'w1' });
      expect(worked.result).toBe('published');
      const coverages = (await publishedFacts(opened, unit.unitId)).map((fact) => fact.value as unknown as { repository: string; complete: boolean });
      expect(coverages.map((coverage) => [coverage.repository, coverage.complete]).sort()).toEqual([
        [PRODUCT_REPOSITORY, false],
        [CODE_REPOSITORY, false],
      ].sort((left, right) => String(left[0]) < String(right[0]) ? -1 : 1));
    } finally {
      await opened.close();
    }
  }, 180_000);

  test('a unit that never answers is stopped at 0026\'s turn limit and splits the product into its repositories', async () => {
    const ids = fixture();
    const opened = await openWorld({
      script: {
        // The children of the split run on the same stage, and each reads its own repository. A child's packet is the
        // shape's own of its repository — the one with a `members` list, which a unit of the product has none of —
        // and its answer names the two repositories, of which the one it covers is its own place.
        byPrompt: [
          { matches: '"members": [', steps: [{ answer: { status: 'done', covered: [PRODUCT_REPOSITORY, CODE_REPOSITORY], remaining: [], summary: 'the repository was read' } }] },
        ],
        steps: [{ say: 'still reading' }, { end: {} }],
      },
      limits: { leaseMs: 86_400_000 },
    });
    try {
      const unit = await planAndAdmit(opened);
      const worked = await workOnce(opened.orchestrator, { worker: 'w1' });
      expect(worked.result).toBe('split');
      // 0026: "at most ~30 turns". The unit was asked once per turn and stopped at the thirtieth.
      expect(prompts(opened).length).toBe(30);
      const stopped = (await readProgress(opened.owner, RUN)).map((event) => event.summary).filter((summary) => summary.includes('stopped at its turn limit'));
      expect(stopped.length).toBe(1);
      // Its partial draft keeps the coverage: no place of the product was read, and each repository is a `budget` gap.
      const draft = await readUnitDraft(opened.owner, unit.unitId, unit.generation);
      // A unit of the whole product writes one coverage fact per repository of the product (a coverage's identity is
      // its repository, its scope and its reader): each says that repository was not read, as a `budget` gap.
      const coverages = (draft?.writes ?? []).map((write) => write.value as { kind: string; value: { repository: string; scope: string; complete: boolean; read: string[]; unread: { what: string; reason: string }[] } });
      expect(coverages.map((coverage) => coverage.kind)).toEqual(['coverage', 'coverage']);
      // A coverage fact's scope names the graph's own word for a product-wide scope (`CoverageValue.scope`), and the
      // scope *text* the plan carries is the one no repository can be named by.
      expect(coverages.map((coverage) => [coverage.value.repository, coverage.value.scope, coverage.value.complete, coverage.value.read, coverage.value.unread])).toEqual([
        [PRODUCT_REPOSITORY, PRODUCT_SCOPE_NAME, false, [], [{ what: PRODUCT_REPOSITORY, reason: 'budget' }]],
        [CODE_REPOSITORY, PRODUCT_SCOPE_NAME, false, [], [{ what: CODE_REPOSITORY, reason: 'budget' }]],
      ]);
      // 0026's hierarchy: the stops split the product into its repositories, one child each, named by their facts.
      const children = (await readRunUnits(opened.owner, RUN)).filter((record) => record.unitId !== unit.unitId);
      const scopes = await Promise.all(children.map(async (record) => (await readUnitPlan(opened.owner, record.unitId, record.generation))?.scope));
      expect(scopes.sort()).toEqual([CODE_REPOSITORY, PRODUCT_REPOSITORY].sort((left, right) => left < right ? -1 : 1));
      expect(children.every((record) => record.state === 'planned')).toBe(true);

      // A child is a unit of the repository level (0026's hierarchy), and it runs: its packet is the shape's own
      // sections of its repository — no key twice, since a stage's section may not replace one the shape holds — and
      // it publishes the coverage of the repository it read.
      const childStates: (string | undefined)[] = [];
      for (let pass = 0; pass < 4 && childStates.length < children.length; pass += 1) {
        await schedulerPass(opened.orchestrator, { runId: RUN });
        const child = await workOnce(opened.orchestrator, { worker: 'w1' });
        if (child.claimed) childStates.push(child.result);
      }
      expect(childStates).toEqual(['published', 'published']);
      for (const child of children) {
        const record = (await readRunUnits(opened.owner, RUN)).find((each) => each.unitId === child.unitId);
        expect(record?.state).toBe('published');
        const facts = await publishedFacts(opened, child.unitId);
        expect(facts.map((fact) => fact.kind)).toEqual(['coverage']);
        expect((facts[0]!.value as unknown as { complete: boolean }).complete).toBe(true);
      }
      const childPrompts = prompts(opened).filter((prompt) => prompt.includes('"members": ['));
      expect(childPrompts.length).toBe(children.length);
      const childPackets = childPrompts.map((prompt) => JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n{') + 2)) as Record<string, unknown>);
      for (const childPacket of childPackets) {
        expect(Object.keys(childPacket)).toEqual(['unit', 'place', 'scope', 'members', 'entryPoints', 'data', 'relations', 'history', 'writes', 'marker']);
      }
      expect(childPackets.map((childPacket) => (childPacket['scope'] as { id: string }).id).sort())
        .toEqual([ids.productRepository.id, ids.codeRepository.id].sort((left, right) => left < right ? -1 : 1));
    } finally {
      await opened.close();
    }
  }, 240_000);
});

describe('stage 8\'s declaration', () => {
  test('one unit per product at 0026\'s top level, claims and questions, the level of meaning, and the importance of a module a place is estimated from', () => {
    const declaration = overviewDeclaration();
    expect(declaration.factStage).toBe('8-overview');
    expect(declaration.level).toBe('meaning');
    // 0026's "Scale": the product at the top, a repository below it.
    expect(declaration.scale).toEqual({ level: 'product', child: 'repository' });
    expect(declaration.kinds).toEqual(OVERVIEW_KINDS);
    expect(declaration.kinds).toEqual(['answer', 'claim', 'question']);
    // The section names are the packet's own, in the order the stage declares them.
    expect(declaration.sections?.map((section) => section.name)).toEqual(['repositories', 'modules', 'entryPoints', 'packages', 'documents', 'sections']);
    expect(createStageRegistry({ snapshots: createGitSnapshotSource(() => []) }).get(OVERVIEW_STAGE_ID)).toBeUndefined();
  });
});
