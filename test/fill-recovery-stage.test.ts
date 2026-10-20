/**
 * Stage 13, the system recovered and reconciled with the intended one, end to end
 * on the agent-stage shape of madarch-tzte.24.1 (decision 0026, "Stages": stage 13
 * "system recovery and reconciliation (recovered architecture beside the intended
 * one with the mapping between them)"; 0027's publication and split).
 *
 * One unit of the whole product receives the fixed part and a packet assembled
 * from what the earlier agent stages established — the module summaries of stage
 * 12, the intent claims of stages 10 and 11, the overview hypothesis and the rest
 * of the claims about the product's parts — beside the files of the product's
 * own model (`madarch/*.yaml` of the product repository, decision 0002); it
 * writes the recovered architecture, the mapping and the mismatch questions
 * through the checked write path, and its coverage says which repositories it
 * read. Every expectation is taken from the task and the decisions: 0026's
 * numbers, the answer contract the stage declares, the hierarchy's levels, and
 * 0027's publication and split semantics. The agent is the fake ACP agent of
 * `test/fixtures/acp-fake-agent` (no real prompt, no network, no token spent),
 * the MCP server is the real one of madarch-tzte.22.2 answering through the real
 * server route, and time passes through a seam, never a sleep.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { createFactStoreSchema, applyPublishedFacts, FACT_APPLICATION, readUnitFacts } from '../src/fill/fact-store.js';
import { makeEdgeFact, makeNodeFact, repositoryPath, FACT_KINDS, type Fact, type FactProvenance } from '../src/fill/facts.js';
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
import { CONTRADICTION_QUESTION_TYPE, docIntentDeclaration } from '../src/fill/stages/doc-intent.js';
import {
  RECOVERY_INTENT_PREDICATES,
  RECOVERY_KINDS,
  RECOVERY_MAPPING_PREDICATE,
  RECOVERY_MODEL_FOLDER,
  RECOVERY_STAGE_ID,
  createRecoveryStage,
  recoveryDeclaration,
  recoverySections,
} from '../src/fill/stages/recovery.js';
import { UNDERSTANDING_SUMMARY_PREDICATE } from '../src/fill/stages/understanding.js';
import { intentHistoryDeclaration } from '../src/fill/stages/intent-history.js';
import { PRODUCT_SCOPE_NAME } from '../src/fill/stages/agent-stage.js';
import { deriveStageGraph, StageRegistry } from '../src/fill/registry.js';
import { DEFAULT_STAGE_DEFAULTS, type FillStage } from '../src/fill/stage.js';
import { PRODUCT_SCOPE } from '../src/fill/checked-writes.js';
import { Type } from 'typebox';
import { createGitSnapshotSource, type RepositoryPin } from '../src/fill/snapshot.js';
import { createFillStateSchema, createUnit, readRunUnits } from '../src/fill/state-store.js';
import { UNIT_TOOL_PATH } from '../src/fill/unit-tools.js';
import { startServer, type StartedServer } from '../src/server/http.js';
import type { QueueService } from '../src/fill/queue.js';

const NOW = 1_700_000_000_000;
const PRODUCT = 'fixture-product';
const RUN = 'run-2026-10-20T07:00Z';
/** The product\'s own repository, and the one code repository the product is made of (0021, 0026\'s hierarchy). */
const PRODUCT_REPOSITORY = 'acme-shop';
const CODE_REPOSITORY = 'orders-api';
/** The files the pinned commits hold. */
const PRODUCT_README = 'README.md';
const MODEL_FILE = `${RECOVERY_MODEL_FOLDER}/model.yaml`;
/** The intended model the product declares: one element the recovery maps a recovered part to. */
const MODEL_BODY = `elements:\n  checkout-api:\n    kind: service\n    summary: Takes the order\n`;
const README_BODY = '# acme shop\n\nThe shop takes an order and settles it.\n';
const ORDER_FILE = 'src/order.ts';
const ORDER_BODY = 'export function placeOrder(cart) {\n  return { total: cart.total, state: "placed" };\n}\n';
const ARCHITECTURE_FILE = 'docs/architecture.md';
const ARCHITECTURE_BODY = '# architecture\n\n## Components\n\nOne service holds the checkout.\n';
const FAKE_AGENT = join(import.meta.dir, 'fixtures', 'acp-fake-agent', 'acp-fake-agent.ts');

let root: string | undefined;
let COMMITS: Readonly<Record<string, string>> = {};

function provenance(repository: string, file: string, line: number): FactProvenance {
  return {
    source: { system: 'madarch-fill-agent', version: '1.0.0' },
    repository: { id: repository, commit: COMMITS[repository] ?? 'a'.repeat(40) },
    place: { file: repositoryPath(file), range: { startLine: line, startColumn: 0, endLine: line, endColumn: 10 } },
  };
}

/** The graph the earlier stages published: repositories, modules, deploy units, the model file, and the claims. */
interface Graph {
  readonly productRepository: Fact;
  readonly codeRepository: Fact;
  readonly checkout: Fact;
  readonly orders: Fact;
  readonly ordersUnit: Fact;
  readonly paymentsUnit: Fact;
  readonly modelFile: Fact;
  readonly architecture: Fact;
  readonly components: Fact;
  facts(): readonly Fact[];
}

function fixture(options?: { readonly withoutModel?: boolean }): Graph {
  const productRepository = makeNodeFact({ kind: 'repository', value: { repository: PRODUCT_REPOSITORY, form: 'product' }, provenance: provenance(PRODUCT_REPOSITORY, PRODUCT_README, 1), layer: 'extracted' });
  const codeRepository = makeNodeFact({ kind: 'repository', value: { repository: CODE_REPOSITORY, form: 'code' }, provenance: provenance(CODE_REPOSITORY, ORDER_FILE, 1), layer: 'extracted' });
  // Two modules of the code repository, as stage 5 clustered them.
  const checkout = makeNodeFact({ kind: 'module', value: { repository: CODE_REPOSITORY, name: 'checkout', seed: 'package', members: 4, importance: 0.25 }, provenance: provenance(CODE_REPOSITORY, ORDER_FILE, 1), layer: 'extracted' });
  const orders = makeNodeFact({ kind: 'module', value: { repository: CODE_REPOSITORY, name: 'orders', seed: 'package', members: 9, importance: 0.75 }, provenance: provenance(CODE_REPOSITORY, ORDER_FILE, 1), layer: 'extracted' });
  // Two deploy units the interaction link can stand between (`EDGE_END_KINDS.interaction`).
  const ordersUnit = makeNodeFact({ kind: 'deploy-unit', value: { repository: CODE_REPOSITORY, name: 'orders-api', form: 'service' }, provenance: provenance(CODE_REPOSITORY, ORDER_FILE, 1), layer: 'extracted' });
  const paymentsUnit = makeNodeFact({ kind: 'deploy-unit', value: { repository: CODE_REPOSITORY, name: 'payments-gateway', form: 'service' }, provenance: provenance(CODE_REPOSITORY, ORDER_FILE, 1), layer: 'extracted' });
  // The product\'s own model file, and a document whose section stage 10 reads intent from.
  const modelFile = makeNodeFact({ kind: 'file', value: { repository: PRODUCT_REPOSITORY, path: repositoryPath(MODEL_FILE), roles: ['document'] }, provenance: provenance(PRODUCT_REPOSITORY, MODEL_FILE, 1), layer: 'extracted' });
  // A YAML file below a folder of the model's own is no file of the model: the loader reads the *.yaml
  // files directly inside `madarch/` (src/model/load.ts, no recursion), so the section names it never.
  const nestedFile = makeNodeFact({ kind: 'file', value: { repository: PRODUCT_REPOSITORY, path: repositoryPath('madarch/spec/old.yaml'), roles: ['document'] }, provenance: provenance(PRODUCT_REPOSITORY, 'madarch/spec/old.yaml', 1), layer: 'extracted' });
  const architecture = makeNodeFact({ kind: 'document', value: { repository: PRODUCT_REPOSITORY, path: repositoryPath(ARCHITECTURE_FILE), mediaType: 'text/markdown', title: 'architecture' }, provenance: provenance(PRODUCT_REPOSITORY, ARCHITECTURE_FILE, 1), layer: 'extracted' });
  const components = makeNodeFact({ kind: 'section', value: { repository: PRODUCT_REPOSITORY, document: repositoryPath(ARCHITECTURE_FILE), anchor: 'components', heading: 'Components', level: 2 }, provenance: provenance(PRODUCT_REPOSITORY, ARCHITECTURE_FILE, 2), layer: 'extracted' });
  return {
    productRepository,
    codeRepository,
    checkout,
    orders,
    ordersUnit,
    paymentsUnit,
    modelFile,
    architecture,
    components,
    facts: () => [
      productRepository,
      codeRepository,
      checkout,
      orders,
      ordersUnit,
      paymentsUnit,
      ...(options?.withoutModel ? [] : [modelFile, nestedFile]),
      architecture,
      components,
      makeEdgeFact({ kind: 'contains', value: { from: codeRepository.id, to: checkout.id }, provenance: provenance(CODE_REPOSITORY, ORDER_FILE, 1), layer: 'extracted' }),
      makeEdgeFact({ kind: 'contains', value: { from: codeRepository.id, to: orders.id }, provenance: provenance(CODE_REPOSITORY, ORDER_FILE, 1), layer: 'extracted' }),
      makeEdgeFact({ kind: 'contains', value: { from: productRepository.id, to: architecture.id }, provenance: provenance(PRODUCT_REPOSITORY, ARCHITECTURE_FILE, 1), layer: 'extracted' }),
      makeEdgeFact({ kind: 'contains', value: { from: architecture.id, to: components.id }, provenance: provenance(PRODUCT_REPOSITORY, ARCHITECTURE_FILE, 2), layer: 'extracted' }),
      // Stage 12\'s contract: the module\'s own summary, its object the literal the parent reads.
      makeNodeFact({ kind: 'claim', value: { subject: { form: 'node', id: checkout.id }, predicate: UNDERSTANDING_SUMMARY_PREDICATE, object: { form: 'literal', text: 'checkout totals the cart and hands the order on' }, text: 'checkout totals the cart and hands the order on', confidence: 0.8 }, provenance: provenance(CODE_REPOSITORY, ORDER_FILE, 1), layer: 'inferred' }),
      // Stage 11\'s intent, as the comments and commits state it.
      makeNodeFact({ kind: 'claim', value: { subject: { form: 'node', id: orders.id }, predicate: 'intent', object: { form: 'literal', text: 'orders are settled exactly once' }, text: 'the comments and commits state orders are settled exactly once', confidence: 0.7 }, provenance: provenance(CODE_REPOSITORY, ORDER_FILE, 2), layer: 'inferred' }),
      // Stage 10\'s intent, as the documents state it.
      makeNodeFact({ kind: 'claim', value: { subject: { form: 'node', id: components.id }, predicate: 'states', object: { form: 'node', id: orders.id }, text: 'the documents state one service holds the checkout' }, provenance: provenance(PRODUCT_REPOSITORY, ARCHITECTURE_FILE, 3), layer: 'inferred' }),
      // Stage 8\'s overview hypothesis, a predicate of its own.
      makeNodeFact({ kind: 'claim', value: { subject: { form: 'node', id: orders.id }, predicate: 'is-for', object: { form: 'literal', text: 'taking and settling orders' }, text: 'the orders module is for taking and settling orders', confidence: 0.6 }, provenance: provenance(PRODUCT_REPOSITORY, PRODUCT_README, 2), layer: 'inferred' }),
    ],
  };
}

/**
 * A stand-in for one of the stages the recovery stands after: it holds the stage's
 * own id, so the registry holds the ordering the recovery declares, and it plans no
 * unit, because this suite tests stage 13's units and not its siblings' (the
 * ordering itself is held against the real registry in the declaration test below).
 */
function orderingStage(id: string): FillStage {
  return {
    id,
    version: 1,
    consumes: { required: [], optional: [] },
    produces: [],
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, config: {} },
    plan: () => ({ units: [] }),
    execute: () => ({ outcome: 'draft' }),
    validate: () => ({ ok: true }),
  };
}

/**
 * The stand-in for the deterministic stages whose facts this fixture publishes: it
 * declares the capabilities stage 13 requires (`repository`, `module`) and reads
 * optional (`file`), so the derived stage graph knows where its inputs come from,
 * and it plans no unit, because the graph is already published.
 */
function structureStage(): FillStage {
  return {
    id: 'structure',
    version: 1,
    consumes: { required: [], optional: [] },
    produces: ['repository', 'module', 'deploy-unit', 'file', 'document', 'section'].map((kind) => ({ kind, schemaVersion: FACT_KINDS[kind as 'module'].version, scope: 'repository' as const })),
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, config: {} },
    plan: () => ({ units: [] }),
    execute: () => ({ outcome: 'draft' }),
    validate: () => ({ ok: true }),
  };
}

/** One world: a database with the fill\'s tables and the fixture graph, the orchestrator, the tool host and a fake agent\'s script. */
interface World {
  readonly owner: DatabaseOwner;
  readonly orchestrator: FillOrchestrator;
  readonly server: StartedServer;
  readonly queue: QueueService;
  readonly record: string;
  sent(): readonly Record<string, unknown>[];
  close(): Promise<void>;
}

/** What one world is opened with: the fake agent\'s steps, and the orchestrator\'s own limits where a test holds them still. */
interface WorldOptions {
  readonly graph?: Graph;
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
  const graph = options.graph ?? fixture();

  const owner = createPGliteDatabaseOwner();
  await createFillStateSchema(owner);
  await createOrchestratorSchema(owner);
  await createFactStoreSchema(owner);
  const queue = await createPgBossQueue({ owner, supervise: false });
  await queue.declare({ name: 'fill-units', leaseSeconds: 3_600, retries: 0, retryDelaySeconds: 0, retryBackoff: false, singletons: true });

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
    .register(orderingStage('overview'))
    .register(orderingStage('intent-history'))
    .register(orderingStage('understanding'))
    .register(createRecoveryStage({
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
  // Port 0: the server names a free one, and nothing here takes another process\'s port.
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
    orchestrator,
    server,
    queue,
    record,
    sent: () => readFileSync(record, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line, index) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch (error) {
        throw new Error(`the agent record's line ${String(index + 1)} does not read (${(error as Error).message}): ${JSON.stringify(line.slice(0, 400))}`);
      }
    }),
    close: async () => {
      await server!.stop();
      await service.stop();
      await queue.stop().catch(() => undefined);
      await owner.close();
    },
  };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'madarch-recovery-stage-'));
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
  commits[PRODUCT_REPOSITORY] = make(PRODUCT_REPOSITORY, { [PRODUCT_README]: README_BODY, [MODEL_FILE]: MODEL_BODY, [ARCHITECTURE_FILE]: ARCHITECTURE_BODY });
  commits[CODE_REPOSITORY] = make(CODE_REPOSITORY, { [ORDER_FILE]: ORDER_BODY, 'package.json': '{"name":"orders-api"}\n' });
  COMMITS = commits;
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

/** Plans and admits the run\'s one unit — the product\'s — and returns it. */
async function planAndAdmit(opened: World): Promise<{ unitId: string; generation: number }> {
  const started = await startRun(opened.orchestrator, { runId: RUN });
  expect(started.ok).toBe(true);
  const planned = await planRun(opened.orchestrator, { runId: RUN });
  if (planned.outcome !== 'planned') throw new Error(`the run was not planned: ${JSON.stringify(planned)}`);
  expect(planned.units.map((unit) => unit.stageId)).toEqual([RECOVERY_STAGE_ID]);
  // 0026\'s hierarchy, its top: one unit for the whole product, whose scope is every repository the run pins.
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

/** The facts a unit published, as the store holds them. */
async function publishedFacts(opened: World, unitId: string): Promise<readonly Fact[]> {
  return (await readUnitFacts(opened.owner, unitId)).map((entry) => entry.fact);
}

/** One mapping claim the fake agent asserts through `assert_fact`, cited to the model bytes that declare the element. */
function mappingStep(options: { subject: string; element: string; text: string; line: number }): unknown {
  return {
    call: {
      tool: 'assert_fact',
      arguments: {
        kind: 'claim',
        value: { subject: { form: 'node', id: options.subject }, predicate: RECOVERY_MAPPING_PREDICATE, object: { form: 'literal', text: options.element }, text: options.text, confidence: 0.7 },
        place: { repository: PRODUCT_REPOSITORY, file: MODEL_FILE, startLine: options.line, endLine: options.line },
      },
    },
  };
}

/** One interaction the fake agent links through `link`, cited to the code it stands on. */
function interactionStep(options: { caller: string; callee: string; via: string; file: string; line: number }): unknown {
  return {
    call: {
      tool: 'link',
      arguments: {
        kind: 'interaction',
        value: { caller: options.caller, callee: options.callee, form: 'http', via: options.via },
        place: { repository: CODE_REPOSITORY, file: options.file, startLine: options.line, endLine: options.line },
      },
    },
  };
}

/** One mismatch question the fake agent raises through `raise_question`, naming both sides. */
function mismatchStep(options: { prompt: string; about: string; file: string; line: number }): unknown {
  return {
    call: {
      tool: 'raise_question',
      arguments: {
        type: CONTRADICTION_QUESTION_TYPE,
        prompt: options.prompt,
        about: options.about,
        place: { repository: PRODUCT_REPOSITORY, file: options.file, startLine: options.line, endLine: options.line },
      },
    },
  };
}

describe('stage 13, the system recovered and reconciled with the intended one', () => {
  test('one unit of the whole product reads the earlier stages\' claims and the model files, writes the recovery through the checked writes, and publishes it with its coverage', async () => {
    const ids = fixture();
    const opened = await openWorld({
      graph: ids,
      script: {
        byPrompt: [],
        steps: [
          { say: 'reading the product' },
          // The unit reads the intended model\'s bytes before it maps anything to them.
          { call: { tool: 'evidence_span', arguments: { repository: PRODUCT_REPOSITORY, commit: COMMITS[PRODUCT_REPOSITORY], file: MODEL_FILE, startLine: 1, endLine: 10 } } },
          // The mapping: the recovered checkout answers to the intended element the model declares.
          mappingStep({ subject: ids.checkout.id, element: 'checkout-api', text: 'the recovered checkout is the intended element checkout-api', line: 2 }),
          // The recovered relation between two components of the system.
          interactionStep({ caller: ids.ordersUnit.id, callee: ids.paymentsUnit.id, via: 'POST /pay', file: ORDER_FILE, line: 1 }),
          // The mismatch: an intended element nothing recovered answers to, named as both sides.
          mismatchStep({ prompt: 'The intended model declares the element checkout-api, and the recovery maps the checkout module to it; the model names nothing for the orders module the recovery found', about: ids.orders.id, file: MODEL_FILE, line: 2 }),
          { answer: { status: 'done', covered: [PRODUCT_REPOSITORY, CODE_REPOSITORY], remaining: [], summary: 'The recovered system routes an order from checkout through payments, mapped to the intended element' } },
        ],
      },
    });
    try {
      const unit = await planAndAdmit(opened);
      const worked = await workOnce(opened.orchestrator, { worker: 'w1' });
      expect(worked.result).toBe('published');
      expect(worked.unitId).toBe(unit.unitId);

      // The prompt the agent received: the stage\'s own fixed part, the recovery packet, within 0026\'s 20K.
      const sent = prompts(opened);
      expect(sent.length).toBe(1);
      const prompt = sent[0]!;
      expect(prompt).toContain('recovers the product\'s system');
      expect(prompt).toContain('What you write is meaning');
      expect(prompt).toContain('Facts this unit may write: answer, claim, coverage, interaction, question — and nothing else');
      expect(estimateTokens(prompt, DEFAULT_GRAPH_READ_LIMITS)).toBeLessThanOrEqual(20_000);
      // The packet is the last JSON object of the prompt, after the fixed part.
      const packet = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n{') + 2)) as Record<string, unknown>;
      // The stage\'s own sections between the shape\'s own head and the kinds it may write.
      expect(Object.keys(packet)).toEqual(['unit', 'place', 'moduleSummaries', 'intent', 'overview', 'intendedModel', 'writes', 'marker']);
      expect((packet['place'] as { product?: unknown }).product).toBe(true);
      // The module summaries: stage 12\'s own bounded claim per module, `null` where none was published. The
      // rows stand in code point order of the module ids, which no test spells, so both sides are compared
      // by the module\'s own name.
      const summaries = packet['moduleSummaries'] as readonly { module: string; repository: string; name: string; summary: string | null }[];
      expect(summaries.map((row) => [row.name, row.repository, row.summary]).sort()).toEqual([
        ['checkout', CODE_REPOSITORY, 'checkout totals the cart and hands the order on'],
        ['orders', CODE_REPOSITORY, null],
      ].sort((left, right) => String(left[0]) < String(right[0]) ? -1 : 1));
      // The intent: the predicates stages 10 and 11 declare, each row with its ends and the place it stands at.
      expect(packet['intent']).toEqual([
        { id: expect.any(String), predicate: 'intent', subject: { node: ids.orders.id }, object: { literal: 'orders are settled exactly once' }, text: 'the comments and commits state orders are settled exactly once', repository: CODE_REPOSITORY, file: ORDER_FILE, line: 2 },
        { id: expect.any(String), predicate: 'states', subject: { node: ids.components.id }, object: { node: ids.orders.id }, text: 'the documents state one service holds the checkout', repository: PRODUCT_REPOSITORY, file: ARCHITECTURE_FILE, line: 3 },
      ]);
      // The overview: the claims the other sections do not hold — the hypothesis among them, no claim twice.
      expect(packet['overview']).toEqual([
        { id: expect.any(String), predicate: 'is-for', subject: { node: ids.orders.id }, object: { literal: 'taking and settling orders' }, text: 'the orders module is for taking and settling orders', repository: PRODUCT_REPOSITORY, file: PRODUCT_README, line: 2 },
      ]);
      // The intended model: the product repository\'s own model files, named and never pasted - and a
      // YAML file below a folder of `madarch/` is none of them, because the loader reads no recursion.
      expect(packet['intendedModel']).toEqual([{ id: ids.modelFile.id, repository: PRODUCT_REPOSITORY, path: MODEL_FILE }]);
      expect(packet['marker']).toBeNull();
      expect((packet['unit'] as { scope: string }).scope).toBe(PRODUCT_SCOPE);

      // What it published: the mapping claim, the interaction, the mismatch question, and the coverage per repository.
      const published = await publishedFacts(opened, unit.unitId);
      expect(published.map((fact) => fact.kind).sort()).toEqual(['claim', 'coverage', 'coverage', 'interaction', 'question']);
      const mapping = published.find((fact) => fact.kind === 'claim');
      expect(mapping).toBeDefined();
      expect((mapping!.value as unknown as { predicate: string; object: { form: string; text: string } }).predicate).toBe(RECOVERY_MAPPING_PREDICATE);
      expect((mapping!.value as unknown as { object: { text: string } }).object.text).toBe('checkout-api');
      expect(String(mapping!.provenance.place?.file)).toBe(MODEL_FILE);
      expect(mapping!.provenance.repository.id).toBe(PRODUCT_REPOSITORY);
      expect(mapping!.layer).toBe('inferred');
      expect(mapping!.status).toBe('proposed');
      const interaction = published.find((fact) => fact.kind === 'interaction');
      expect((interaction!.value as unknown as { caller: string; callee: string; form: string; via: string })).toEqual({
        caller: ids.ordersUnit.id, callee: ids.paymentsUnit.id, form: 'http', via: 'POST /pay',
      });
      const question = published.find((fact) => fact.kind === 'question');
      expect((question!.value as unknown as { type: string }).type).toBe(CONTRADICTION_QUESTION_TYPE);
      const coverages = published.filter((fact) => fact.kind === 'coverage').map((fact) => fact.value as unknown as { repository: string; scope: string; complete: boolean });
      expect(coverages.map((coverage) => [coverage.repository, coverage.scope, coverage.complete]).sort()).toEqual([
        [CODE_REPOSITORY, PRODUCT_SCOPE_NAME, true],
        [PRODUCT_REPOSITORY, PRODUCT_SCOPE_NAME, true],
      ].sort((left, right) => String(left[0]) < String(right[0]) ? -1 : 1));
      expect((await readRunUnits(opened.owner, RUN)).map((record) => record.state)).toEqual(['published']);
    } finally {
      await opened.close();
    }
  }, 180_000);

  test('a product whose repository declares no model is recovered without one: the section holds no row and no mismatch is raised', async () => {
    const opened = await openWorld({
      graph: fixture({ withoutModel: true }),
      script: {
        byPrompt: [],
        steps: [
          { say: 'reading the product' },
          { answer: { status: 'done', covered: [PRODUCT_REPOSITORY, CODE_REPOSITORY], remaining: [], summary: 'The product declares no model, and the recovery stands alone' } },
        ],
      },
    });
    try {
      const unit = await planAndAdmit(opened);
      const worked = await workOnce(opened.orchestrator, { worker: 'w1' });
      expect(worked.result).toBe('published');
      const sent = prompts(opened);
      const packet = JSON.parse(sent[0]!.slice(sent[0]!.lastIndexOf('\n\n{') + 2)) as Record<string, unknown>;
      expect(packet['intendedModel']).toEqual([]);
      const published = await publishedFacts(opened, unit.unitId);
      expect(published.filter((fact) => fact.kind === 'question')).toEqual([]);
      expect(published.map((fact) => fact.kind).sort()).toEqual(['coverage', 'coverage']);
    } finally {
      await opened.close();
    }
  }, 180_000);

  test('a malformed answer is refused by the field it got wrong, the unit is asked again, and the second answer publishes', async () => {
    const opened = await openWorld({
      script: {
        byPrompt: [{ matches: 'That was not the answer', steps: [
          { answer: { status: 'done', covered: [PRODUCT_REPOSITORY, CODE_REPOSITORY], remaining: [], summary: 'the product was recovered' } },
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
      expect(sent[1]).toContain('That was not the answer this unit contract asks for.');
      expect(sent[1]).toContain('the answer names no `status`');
      expect(sent[1]).toContain('{"status":"done"|"partial"');
      // The unit is shown the places of its own scope, which for a unit of the product are its repositories.
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
      graph: ids,
      script: {
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
      // 0026: "at most ~30 turns".
      expect(prompts(opened).length).toBe(30);
      const stopped = (await readProgress(opened.owner, RUN)).map((event) => event.summary).filter((summary) => summary.includes('stopped at its turn limit'));
      expect(stopped.length).toBe(1);
      const draft = await readUnitDraft(opened.owner, unit.unitId, unit.generation);
      const coverages = (draft?.writes ?? []).map((write) => write.value as { kind: string; value: { repository: string; scope: string; complete: boolean; read: string[]; unread: { what: string; reason: string }[] } });
      expect(coverages.map((coverage) => coverage.kind)).toEqual(['coverage', 'coverage']);
      expect(coverages.map((coverage) => [coverage.value.repository, coverage.value.scope, coverage.value.complete, coverage.value.read, coverage.value.unread])).toEqual([
        [PRODUCT_REPOSITORY, PRODUCT_SCOPE_NAME, false, [], [{ what: PRODUCT_REPOSITORY, reason: 'budget' }]],
        [CODE_REPOSITORY, PRODUCT_SCOPE_NAME, false, [], [{ what: CODE_REPOSITORY, reason: 'budget' }]],
      ]);
      // 0026\'s hierarchy: the stops split the product into its repositories, one child each.
      const children = (await readRunUnits(opened.owner, RUN)).filter((record) => record.unitId !== unit.unitId);
      const scopes = await Promise.all(children.map(async (record) => (await readUnitPlan(opened.owner, record.unitId, record.generation))?.scope));
      expect(scopes.sort()).toEqual([CODE_REPOSITORY, PRODUCT_REPOSITORY].sort((left, right) => left < right ? -1 : 1));
      expect(children.every((record) => record.state === 'planned')).toBe(true);

      // A child is a unit of the repository level (0026\'s hierarchy), and it runs: its packet is the shape\'s own
      // sections of its repository — the stage\'s own sections describe the product, and no key twice.
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

describe('stage 13\'s declaration', () => {
  test('one unit per product at 0026\'s top level, claims, interactions and questions, the level of meaning, and the sections the packet reads', () => {
    const declaration = recoveryDeclaration();
    expect(declaration.factStage).toBe('13-recovery');
    expect(declaration.level).toBe('meaning');
    // 0026\'s "Scale": the product at the top, a repository below it.
    expect(declaration.scale).toEqual({ level: 'product', child: 'repository' });
    expect(declaration.kinds).toEqual(RECOVERY_KINDS);
    expect(declaration.kinds).toEqual(['answer', 'claim', 'interaction', 'question']);
    // The section names are the packet\'s own, in the order the stage declares them.
    expect(declaration.sections?.map((section) => section.name)).toEqual(['moduleSummaries', 'intent', 'overview', 'intendedModel']);
    expect(declaration.plan).toBeDefined();
    expect(recoverySections().length).toBe(4);
    expect(createStageRegistry({ snapshots: createGitSnapshotSource(() => []) }).get(RECOVERY_STAGE_ID)).toBeUndefined();
  });

  test('the graph orders the recovery after the stages whose reading it opens, and doc-intent cannot stand in that order', () => {
    // The stage stands after overview, intent-history and understanding; doc-intent consumes the claims
    // every agent stage writes, so naming it would close a cycle the registry refuses for every product.
    const stage = createRecoveryStage({
      snapshots: createGitSnapshotSource(() => []),
      agent: { id: 'fake-agent', command: 'echo', args: [] },
    });
    expect(stage.after).toEqual(['overview', 'intent-history', 'understanding']);
    const registry = createStageRegistry({
      snapshots: createGitSnapshotSource(() => []),
      agent: { agent: { id: 'fake-agent', command: 'echo', args: [] } },
    });
    const read = deriveStageGraph(registry, undefined);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const order = read.graph.order;
    for (const earlier of ['overview', 'intent-history', 'understanding']) {
      expect(order.indexOf(earlier)).toBeGreaterThanOrEqual(0);
      expect(order.indexOf(earlier)).toBeLessThan(order.indexOf(RECOVERY_STAGE_ID));
    }
    // The edges the ordering draws, and the one the doc-intent stage\'s own consume draws back.
    // The module tree the summaries read is stage 5's and stage 9's own (the refinement proposes module facts
    // beside the clustering's), so both stand in the stage graph as its producers.
    expect(read.graph.edges.filter((edge) => edge.to === RECOVERY_STAGE_ID).map((edge) => [edge.from, edge.via]).sort())
      .toEqual([
        ['boundaries', 'module'],
        ['intent-history', 'after'],
        ['inventory', 'file'],
        ['modules', 'module'],
        ['overview', 'after'],
        ['snapshot', 'repository'],
        ['understanding', 'after'],
      ].sort((left, right) => (left[0] ?? '') < (right[0] ?? '') ? -1 : 1));
    expect(read.graph.edges.some((edge) => edge.from === RECOVERY_STAGE_ID && edge.to === 'doc-intent' && edge.via === 'claim')).toBe(true);
  });

  test('a stage of the ordering disabled leaves the graph readable: an optional ordering starves nothing', () => {
    const registry = createStageRegistry({
      snapshots: createGitSnapshotSource(() => []),
      agent: { agent: { id: 'fake-agent', command: 'echo', args: [] } },
    });
    const read = deriveStageGraph(registry, {
      ok: true as const,
      file: 'workspace.yaml',
      stages: { understanding: { enabled: false } },
      lines: { understanding: 4 },
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.graph.order).toContain(RECOVERY_STAGE_ID);
    expect(read.graph.order).not.toContain('understanding');
  });

  test('the intent predicates the packet reads by are the ones stages 10 and 11 declare in their fixed parts', () => {
    const stage10 = docIntentDeclaration().rules.join(' ');
    const stage11 = intentHistoryDeclaration().rules.join(' ');
    expect(RECOVERY_INTENT_PREDICATES).toEqual(['intent', 'promises', 'requires', 'states', 'why']);
    for (const predicate of RECOVERY_INTENT_PREDICATES) {
      expect(stage10.includes('`' + predicate + '`') || stage11.includes('`' + predicate + '`')).toBe(true);
    }
    // The summary the module summaries read is stage 12\'s own contract predicate.
    expect(UNDERSTANDING_SUMMARY_PREDICATE).toBe('summarizes');
  });
});
