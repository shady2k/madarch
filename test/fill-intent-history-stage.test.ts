/**
 * Stage 11, the intent the comments and commits state, end to end on the agent-stage
 * shape of madarch-tzte.24.1 (decision 0026, "Stage 11 intent from comments and
 * commits", "Agent input" and "Scale"; 0027's publication, split and join;
 * madarch-tzte.24.4).
 *
 * One unit per module receives the fixed part and a packet of at most 0026's 20K
 * tokens, whose own sections stand beside two of this stage's: `comments`, naming
 * where each comment of the module's files stands (never the words — the unit reads
 * them with `evidence_span`), and `commits`, the commits that touched those files
 * with the task keys their messages name. The unit writes intent claims and 'why'
 * rationale cited to those words, and a question of type `undocumented-behaviour`
 * where nobody documented. Every expectation is taken from the task and the
 * decisions, not from the code. The comment and the commit messages are shaped like
 * the training repository's planted fixtures (`examples/training-repository`): the
 * 'why' comment is its `intentEvidence` words, the commit subjects carry its task
 * keys. The agent is the fake ACP agent of `test/fixtures/acp-fake-agent` (no real
 * prompt, no network, no token spent), the MCP server is the real one answering
 * through the real server route, and time passes through a seam, never a sleep.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { createFactStoreSchema, applyPublishedFacts, readUnitFacts, FACT_APPLICATION } from '../src/fill/fact-store.js';
import { makeEdgeFact, makeNodeFact, repositoryPath, type Fact, type FactProvenance } from '../src/fill/facts.js';
import { createFactGraphReader, estimateTokens, graphReadsOver, DEFAULT_GRAPH_READ_LIMITS } from '../src/fill/graph-reads.js';
import { byCodePoint } from '../src/model/order.js';
import type { AgentSectionRequest } from '../src/fill/agent-packet.js';
import { draftSetOf, writeScope } from '../src/fill/checked-writes.js';
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
import { unitIdFor } from '../src/fill/orchestrator.js';
import { createStageRegistry } from '../src/fill/stages/index.js';
import {
  INTENT_HISTORY_KINDS,
  INTENT_HISTORY_STAGE_ID,
  createIntentHistoryStage,
  intentHistoryDeclaration,
  intentHistorySections,
  planIntentUnits,
} from '../src/fill/stages/intent-history.js';
import { deriveStageGraph, StageRegistry } from '../src/fill/registry.js';
import { DEFAULT_STAGE_DEFAULTS, type FillStage } from '../src/fill/stage.js';
import { FACT_KINDS } from '../src/fill/facts.js';
import { Type } from 'typebox';
import { createGitSnapshotSource, type RepositoryPin } from '../src/fill/snapshot.js';
import { createStageReadSchema } from '../src/fill/stage-reads.js';
import { createFillStateSchema, createUnit, readRunUnits } from '../src/fill/state-store.js';
import { UNIT_TOOL_PATH } from '../src/fill/unit-tools.js';
import { startServer, type StartedServer } from '../src/server/http.js';
import type { QueueService } from '../src/fill/queue.js';

const NOW = 1_700_000_000_000;
const PRODUCT = 'fixture-product';
const RUN = 'run-2026-10-20T07:00Z';
const PRODUCT_REPOSITORY = 'acme-shop';
const CODE_REPOSITORY = 'orders-api';
/** The payment file carries the training repository's planted 'why' comment, above the symbol it explains. */
const PAYMENT_FILE = 'src/payment.ts';
const ORDER_FILE = 'src/order.ts';
const WHY_COMMENT = 'Keep the order identifier stable across retries so the payment callback is idempotent.';
const PAYMENT_BODY = `// ${WHY_COMMENT}\nexport function capture(orderId: string): string { return orderId; }\n`;
const ORDER_BODY = 'export function purgeExpired(now: number): boolean { return now > 90; }\n';
const README_BODY = '# acme shop\n\nThe shop takes an order and settles it.\n';
/** The commit subjects, shaped like the training repository's scripted history: the task key leads the subject. */
const ORDER_COMMIT_SUBJECT = 'ORD-12 add order lifecycle';
const PAYMENT_COMMIT_SUBJECT = 'PAY-4 add checkout pricing and promotions';
const FAKE_AGENT = join(import.meta.dir, 'fixtures', 'acp-fake-agent', 'acp-fake-agent.ts');

let root: string | undefined;
let COMMITS: Readonly<Record<string, string>> = {};
/** The repository's own two commits, oldest first: the order commit, then the payment commit, which is the pin. */
let HISTORY: readonly { readonly commit: string; readonly subject: string; readonly files: readonly string[]; readonly at: string }[] = [];

function provenance(repository: string, file: string, line: number): FactProvenance {
  return {
    source: { system: 'tree-sitter', version: '1.0.0' },
    repository: { id: repository, commit: COMMITS[repository] ?? 'a'.repeat(40) },
    place: { file: repositoryPath(file), range: { startLine: line, startColumn: 0, endLine: line, endColumn: 10 } },
  };
}

/** The graph stage 11 reads: two repositories, two modules, their files and symbols, the planted comment, the history. */
interface Graph {
  readonly productRepository: Fact;
  readonly codeRepository: Fact;
  readonly payments: Fact;
  readonly orders: Fact;
  readonly paymentFile: Fact;
  readonly orderFile: Fact;
  readonly capture: Fact;
  readonly purge: Fact;
  readonly comment: Fact;
  readonly commits: readonly Fact[];
  facts(): readonly Fact[];
}

function fixture(): Graph {
  const productRepository = makeNodeFact({ kind: 'repository', value: { repository: PRODUCT_REPOSITORY, form: 'product' }, provenance: provenance(PRODUCT_REPOSITORY, 'README.md', 1), layer: 'extracted' });
  const codeRepository = makeNodeFact({ kind: 'repository', value: { repository: CODE_REPOSITORY, form: 'code' }, provenance: provenance(CODE_REPOSITORY, PAYMENT_FILE, 1), layer: 'extracted' });
  const payments = makeNodeFact({ kind: 'module', value: { repository: CODE_REPOSITORY, name: 'payments', seed: 'package', members: 3, importance: 0.75 }, provenance: provenance(CODE_REPOSITORY, PAYMENT_FILE, 1), layer: 'extracted' });
  const orders = makeNodeFact({ kind: 'module', value: { repository: CODE_REPOSITORY, name: 'orders', seed: 'package', members: 2, importance: 0.5 }, provenance: provenance(CODE_REPOSITORY, ORDER_FILE, 1), layer: 'extracted' });
  const paymentFile = makeNodeFact({ kind: 'file', value: { repository: CODE_REPOSITORY, path: repositoryPath(PAYMENT_FILE), roles: ['source'] }, provenance: provenance(CODE_REPOSITORY, PAYMENT_FILE, 1), layer: 'extracted' });
  const orderFile = makeNodeFact({ kind: 'file', value: { repository: CODE_REPOSITORY, path: repositoryPath(ORDER_FILE), roles: ['source'] }, provenance: provenance(CODE_REPOSITORY, ORDER_FILE, 1), layer: 'extracted' });
  const capture = makeNodeFact({ kind: 'symbol', value: { repository: CODE_REPOSITORY, file: repositoryPath(PAYMENT_FILE), qualifiedName: 'capture', symbolKind: 'function' }, provenance: provenance(CODE_REPOSITORY, PAYMENT_FILE, 2), layer: 'extracted' });
  const purge = makeNodeFact({ kind: 'symbol', value: { repository: CODE_REPOSITORY, file: repositoryPath(ORDER_FILE), qualifiedName: 'purgeExpired', symbolKind: 'function' }, provenance: provenance(CODE_REPOSITORY, ORDER_FILE, 1), layer: 'extracted' });
  // The planted 'why' comment, where it stands in the payment file's first line. The words live in the file's bytes,
  // which no packet pastes: the section names the place, and the unit reads the words with `evidence_span`.
  const comment = makeNodeFact({ kind: 'comment', value: { text: WHY_COMMENT, form: 'line' }, provenance: provenance(CODE_REPOSITORY, PAYMENT_FILE, 1), layer: 'extracted' });
  // A commit fact is one commit (the schema ties its value's commit to the commit its provenance was read at), so
  // each commit fact carries its own provenance, as the history stage writes it.
  const commits = HISTORY.map((entry) => makeNodeFact({
    kind: 'commit',
    value: { repository: CODE_REPOSITORY, commit: entry.commit, committedAt: entry.at, authoredAt: entry.at, subject: entry.subject, parents: [], files: entry.files.map((file) => repositoryPath(file)) },
    provenance: { source: { system: 'git', version: '1.0.0' }, repository: { id: CODE_REPOSITORY, commit: entry.commit } },
    layer: 'extracted',
  }));
  const [orderCommit, paymentCommit] = commits;
  return {
    productRepository,
    codeRepository,
    payments,
    orders,
    paymentFile,
    orderFile,
    capture,
    purge,
    comment,
    commits,
    facts: () => [
      productRepository,
      codeRepository,
      payments,
      orders,
      paymentFile,
      orderFile,
      capture,
      purge,
      comment,
      ...commits,
      makeEdgeFact({ kind: 'contains', value: { from: codeRepository.id, to: payments.id }, provenance: provenance(CODE_REPOSITORY, PAYMENT_FILE, 1), layer: 'extracted' }),
      makeEdgeFact({ kind: 'contains', value: { from: codeRepository.id, to: orders.id }, provenance: provenance(CODE_REPOSITORY, ORDER_FILE, 1), layer: 'extracted' }),
      makeEdgeFact({ kind: 'contains', value: { from: payments.id, to: paymentFile.id }, provenance: provenance(CODE_REPOSITORY, PAYMENT_FILE, 1), layer: 'extracted' }),
      makeEdgeFact({ kind: 'contains', value: { from: orders.id, to: orderFile.id }, provenance: provenance(CODE_REPOSITORY, ORDER_FILE, 1), layer: 'extracted' }),
      makeEdgeFact({ kind: 'defines', value: { from: paymentFile.id, to: capture.id }, provenance: provenance(CODE_REPOSITORY, PAYMENT_FILE, 2), layer: 'extracted' }),
      makeEdgeFact({ kind: 'defines', value: { from: orderFile.id, to: purge.id }, provenance: provenance(CODE_REPOSITORY, ORDER_FILE, 1), layer: 'extracted' }),
      // The task keys the commit messages name (madarch-tzte.21.2): one edge per commit, its from the commit's fact.
      makeEdgeFact({ kind: 'task-key', value: { from: orderCommit!.id, key: 'ORD-12' }, provenance: orderCommit!.provenance, layer: 'extracted' }),
      makeEdgeFact({ kind: 'task-key', value: { from: paymentCommit!.id, key: 'PAY-4' }, provenance: paymentCommit!.provenance, layer: 'extracted' }),
    ],
  };
}

/**
 * The stand-in for the deterministic stages this fixture publishes the facts of: it
 * declares the capabilities stage 11 requires (`repository`, `module`) and the ones
 * its packet reads (`comment`, `commit`, `task-key`) so the derived stage graph
 * knows where its inputs come from, and it plans no unit, because the graph is
 * already published.
 */
function structureStage(): FillStage {
  return {
    id: 'structure',
    version: 1,
    consumes: { required: [], optional: [] },
    produces: ['repository', 'module', 'comment', 'commit', 'task-key', 'file'].map((kind) => ({ kind, schemaVersion: FACT_KINDS[kind as 'module'].version, scope: 'repository' as const })),
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
  // The stage's own SQL reads over the `fact` view, which the fill's wiring creates before a run
  // (`src/product/fill-stages.ts`); a world that runs stage 11 creates it the same way.
  await createStageReadSchema(owner);
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
    .register(createIntentHistoryStage({
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
  root = mkdtempSync(join(tmpdir(), 'madarch-intent-history-stage-'));
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });
  // The product repository is one commit; the code repository is two, oldest first, whose subjects name the task keys
  // the training repository's scripted history carries. The pin is the second commit, so both files' bytes stand at it.
  const make = (repository: string, steps: readonly { readonly files: Readonly<Record<string, string>>; readonly message: string; readonly at: string }[]): readonly string[] => {
    const folder = join(root!, repository);
    mkdirSync(folder, { recursive: true });
    const hashes: string[] = [];
    git(folder, 'init', '-q');
    git(folder, 'config', 'user.name', 'Fixture');
    git(folder, 'config', 'user.email', 'fixture@example.invalid');
    for (const step of steps) {
      for (const [path, body] of Object.entries(step.files)) {
        mkdirSync(join(folder, path, '..'), { recursive: true });
        writeFileSync(join(folder, path), body);
      }
      git(folder, 'add', '-A');
      const env: Record<string, string> = { ...process.env, GIT_AUTHOR_DATE: step.at, GIT_COMMITTER_DATE: step.at };
      execFileSync('git', ['commit', '-qm', step.message], { cwd: folder, encoding: 'utf8', env });
      hashes.push(git(folder, 'rev-parse', 'HEAD').trim());
    }
    return hashes;
  };
  const productHashes = make(PRODUCT_REPOSITORY, [{ files: { 'README.md': README_BODY }, message: 'one', at: '2024-01-01T00:00:00Z' }]);
  const codeHashes = make(CODE_REPOSITORY, [
    { files: { [ORDER_FILE]: ORDER_BODY, 'package.json': '{"name":"orders-api"}\n' }, message: ORDER_COMMIT_SUBJECT, at: '2024-01-01T00:00:00Z' },
    { files: { [PAYMENT_FILE]: PAYMENT_BODY }, message: PAYMENT_COMMIT_SUBJECT, at: '2024-01-02T00:00:00Z' },
  ]);
  COMMITS = { [PRODUCT_REPOSITORY]: productHashes[0]!, [CODE_REPOSITORY]: codeHashes[1]! };
  HISTORY = [
    { commit: codeHashes[0]!, subject: ORDER_COMMIT_SUBJECT, files: [ORDER_FILE], at: '2024-01-01T00:00:00Z' },
    { commit: codeHashes[1]!, subject: PAYMENT_COMMIT_SUBJECT, files: [PAYMENT_FILE], at: '2024-01-02T00:00:00Z' },
  ];
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

/** Plans and admits the run's units — one per module of the fixture — and returns them, in plan order. */
async function planAndAdmit(opened: World): Promise<readonly { unitId: string; generation: number }[]> {
  const started = await startRun(opened.orchestrator, { runId: RUN });
  expect(started.ok).toBe(true);
  const planned = await planRun(opened.orchestrator, { runId: RUN });
  if (planned.outcome !== 'planned') throw new Error(`the run was not planned: ${JSON.stringify(planned)}`);
  expect(planned.units.map((unit) => unit.stageId)).toEqual([INTENT_HISTORY_STAGE_ID, INTENT_HISTORY_STAGE_ID]);
  // One unit per module (0026's cluster level), and a module unit's scope text is its repository: a module is a
  // cluster of files and no one path of them, so its checked writes cite bytes anywhere in that repository.
  expect(planned.units.length).toBe(2);
  expect(planned.units.map((unit) => unit.scope)).toEqual([CODE_REPOSITORY, CODE_REPOSITORY]);
  const pass = await schedulerPass(opened.orchestrator, { runId: RUN });
  expect(pass.admitted).toBe(1);
  return planned.units.map((unit) => ({ unitId: unit.unitId, generation: unit.generation }));
}

/** The prompt texts the fake agent was sent, in order. */
function prompts(opened: World): readonly string[] {
  return opened.sent()
    .filter((message) => message['method'] === 'session/prompt')
    .map((message) => String(((message['params'] as { prompt?: { text?: string }[] }).prompt ?? [])[0]?.text ?? ''));
}

/** The packet of one prompt: the last JSON object of the text, after the fixed part. */
function packetOf(prompt: string): Record<string, unknown> {
  return JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n{') + 2)) as Record<string, unknown>;
}

/** Works the run until every unit named is published, or the bound passes; returns the results in the order they ended. */
async function runToPublished(opened: World, expected: number): Promise<readonly string[]> {
  const results: string[] = [];
  for (let pass = 0; pass < 12 && results.length < expected; pass += 1) {
    await schedulerPass(opened.orchestrator, { runId: RUN });
    const worked = await workOnce(opened.orchestrator, { worker: 'w1' });
    if (worked.claimed && worked.result !== undefined) results.push(worked.result);
  }
  return results;
}

/** The facts a unit published, as the store holds them. */
async function publishedFacts(opened: World, unitId: string): Promise<readonly Fact[]> {
  return (await readUnitFacts(opened.owner, unitId)).map((entry) => entry.fact);
}

/** One claim asserted through `assert_fact`, cited to the bytes it stands on. */
function claimCall(options: { subject: string; predicate: string; text: string; repository: string; file: string; line: number }): unknown {
  return {
    call: {
      tool: 'assert_fact',
      arguments: {
        kind: 'claim',
        value: { subject: { form: 'node', id: options.subject }, predicate: options.predicate, object: { form: 'literal', text: options.text }, text: options.text, confidence: 0.7 },
        place: { repository: options.repository, file: options.file, startLine: options.line, endLine: options.line },
      },
    },
  };
}

/** One question raised through `raise_question`, about the node whose behaviour it is. */
function questionCall(options: { type: string; prompt: string; about: string; repository: string; file: string; line: number }): unknown {
  return {
    call: {
      tool: 'raise_question',
      arguments: {
        type: options.type,
        prompt: options.prompt,
        about: options.about,
        place: { repository: options.repository, file: options.file, startLine: options.line, endLine: options.line },
      },
    },
  };
}

describe('stage 11, the intent the comments and commits state', () => {
  test('one unit per module reads where its comments and commits stand, writes the intent they state, and publishes it with its coverage', async () => {
    const ids = fixture();
    const opened = await openWorld({
      script: {
        // The payments unit reads the planted 'why' comment's words with `evidence_span` — the one read that carries
        // bytes — then writes the rationale as a `why` claim cited to the comment's own lines. The orders unit states
        // the intent its commit's task key names and asks what nobody documented.
        byPrompt: [
          {
            matches: '"payments"',
            steps: [
              { call: { tool: 'evidence_span', arguments: { repository: CODE_REPOSITORY, commit: COMMITS[CODE_REPOSITORY], file: PAYMENT_FILE, startLine: 1, endLine: 2 } } },
              { say: 'the comment gives the rationale' },
              claimCall({ subject: ids.capture.id, predicate: 'why', text: 'The order identifier is kept stable across retries so the payment callback is idempotent.', repository: CODE_REPOSITORY, file: PAYMENT_FILE, line: 1 }),
              { answer: { status: 'done', covered: [PAYMENT_FILE], remaining: [], summary: 'The stable order identifier is a deliberate choice for idempotent payment callbacks' } },
            ],
          },
          {
            matches: '"orders"',
            steps: [
              claimCall({ subject: ids.purge.id, predicate: 'intent', text: `The order lifecycle was built as the tracked work ${'ORD-12'} names`, repository: CODE_REPOSITORY, file: ORDER_FILE, line: 1 }),
              questionCall({ type: 'undocumented-behaviour', prompt: 'Why do non-shipped orders expire after ninety days, and what else can move them?', about: ids.purge.id, repository: CODE_REPOSITORY, file: ORDER_FILE, line: 1 }),
              { answer: { status: 'done', covered: [ORDER_FILE], remaining: [], summary: 'The lifecycle was tracked work; its expiry on day ninety is documented nowhere' } },
            ],
          },
        ],
        steps: [],
      },
    });
    try {
      const planned = await planAndAdmit(opened);
      const results = await runToPublished(opened, planned.length);
      expect(results).toEqual(['published', 'published']);

      // The prompts: one per module unit, each the stage's own fixed part, within 0026's 20K.
      const sent = prompts(opened);
      expect(sent.length).toBe(2);
      for (const prompt of sent) {
        expect(prompt).toContain('You are one unit of madarch\'s fill that writes the intent a module\'s own words state');
        expect(prompt).toContain('What you write is intent');
        expect(prompt).toContain('Facts this unit may write: claim, coverage, question — and nothing else');
        expect(estimateTokens(prompt, DEFAULT_GRAPH_READ_LIMITS)).toBeLessThanOrEqual(20_000);
      }

      // The payments unit's packet: the shape's own sections, then this stage's two, then the writes and the marker.
      const paymentPrompt = sent.find((prompt) => prompt.includes('"payments"'))!;
      const paymentPacket = packetOf(paymentPrompt);
      expect(Object.keys(paymentPacket)).toEqual(['unit', 'place', 'scope', 'members', 'entryPoints', 'data', 'relations', 'history', 'comments', 'commits', 'writes', 'marker']);
      // The comments section names where each comment stands — and never the words, which no packet pastes (0026).
      // The unit read them with `evidence_span`: the claim's own words below are the comment's words, which the
      // prompt held nowhere.
      expect(paymentPacket['comments']).toEqual([{ id: ids.comment.id, form: 'line', file: PAYMENT_FILE, line: 1 }]);
      expect(paymentPrompt).not.toContain('Keep the order identifier');
      expect(paymentPrompt).not.toContain('idempotent');
      // The commits section holds only the commits that touched the module's files, newest first, with their task keys.
      expect(paymentPacket['commits']).toEqual([{
        id: ids.commits[1]!.id,
        commit: HISTORY[1]!.commit,
        committedAt: HISTORY[1]!.at,
        subject: PAYMENT_COMMIT_SUBJECT,
        touched: [PAYMENT_FILE],
        touchedMore: 0,
        taskKeys: ['PAY-4'],
      }]);

      // The orders unit's packet: no comments stand in its file, and its commit is the one that touched it.
      const orderPrompt = sent.find((prompt) => prompt.includes('"orders"'))!;
      const orderPacket = packetOf(orderPrompt);
      expect(orderPacket['comments']).toEqual([]);
      expect(orderPacket['commits']).toEqual([{
        id: ids.commits[0]!.id,
        commit: HISTORY[0]!.commit,
        committedAt: HISTORY[0]!.at,
        subject: ORDER_COMMIT_SUBJECT,
        touched: [ORDER_FILE],
        touchedMore: 0,
        taskKeys: ['ORD-12'],
      }]);

      // What the two units published: the payments unit's 'why' claim, the orders unit's intent claim and its
      // undocumented-behaviour question, and each unit's coverage of its own module.
      const byUnit = new Map<string, readonly Fact[]>();
      for (const unit of planned) byUnit.set(unit.unitId, await publishedFacts(opened, unit.unitId));
      const paymentUnit = planned.find((unit) => byUnit.get(unit.unitId)!.some((fact) => fact.kind === 'claim' && (fact.value as { predicate?: string }).predicate === 'why'))!;
      const paymentFacts = byUnit.get(paymentUnit.unitId)!;
      expect(paymentFacts.map((fact) => fact.kind).sort()).toEqual(['claim', 'coverage']);
      const whyClaim = paymentFacts.find((fact) => fact.kind === 'claim')!;
      expect((whyClaim.value as { predicate: string }).predicate).toBe('why');
      expect((whyClaim.value as { text: string }).text).toContain('idempotent');
      expect(whyClaim.layer).toBe('inferred');
      expect(whyClaim.status).toBe('proposed');
      expect(String(whyClaim.provenance.place?.file)).toBe(PAYMENT_FILE);
      const paymentCoverage = paymentFacts.find((fact) => fact.kind === 'coverage')!.value as unknown as { repository: string; scope: string; complete: boolean; read: readonly string[] };
      expect([paymentCoverage.repository, paymentCoverage.scope, paymentCoverage.complete, paymentCoverage.read]).toEqual([
        CODE_REPOSITORY, ids.payments.id, true, [PAYMENT_FILE],
      ]);

      const orderUnit = planned.find((unit) => unit.unitId !== paymentUnit.unitId)!;
      const orderFacts = byUnit.get(orderUnit.unitId)!;
      expect(orderFacts.map((fact) => fact.kind).sort()).toEqual(['claim', 'coverage', 'question']);
      const intentClaim = orderFacts.find((fact) => fact.kind === 'claim')!;
      expect((intentClaim.value as { predicate: string }).predicate).toBe('intent');
      expect((intentClaim.value as { text: string }).text).toContain('ORD-12');
      expect(String(intentClaim.provenance.place?.file)).toBe(ORDER_FILE);
      const question = orderFacts.find((fact) => fact.kind === 'question')!;
      expect((question.value as { type: string }).type).toBe('undocumented-behaviour');
      expect((question.value as { about: string }).about).toBe(ids.purge.id);
      const orderCoverage = orderFacts.find((fact) => fact.kind === 'coverage')!.value as unknown as { repository: string; scope: string; complete: boolean; read: readonly string[] };
      expect([orderCoverage.repository, orderCoverage.scope, orderCoverage.complete, orderCoverage.read]).toEqual([
        CODE_REPOSITORY, ids.orders.id, true, [ORDER_FILE],
      ]);
      expect((await readRunUnits(opened.owner, RUN)).map((record) => record.state).sort()).toEqual(['published', 'published']);
    } finally {
      await opened.close();
    }
  }, 240_000);

  test('a write outside the run\'s pinned repositories lands nothing, and the unit publishes its coverage alone', async () => {
    const opened = await openWorld({
      script: {
        byPrompt: [
          {
            matches: '"payments"',
            steps: [
              // A claim cited to a repository this run pins nowhere: the checked write refuses it by name, and nothing
              // of it lands in the unit's draft set.
              claimCall({ subject: 'claim:no-such-node', predicate: 'why', text: 'a claim nowhere pinned', repository: 'somewhere-else', file: PAYMENT_FILE, line: 1 }),
              { answer: { status: 'done', covered: [PAYMENT_FILE], remaining: [], summary: 'nothing was written' } },
            ],
          },
          { matches: '"orders"', steps: [{ answer: { status: 'done', covered: [ORDER_FILE], remaining: [], summary: 'read' } }] },
        ],
        steps: [],
      },
    });
    try {
      const planned = await planAndAdmit(opened);
      const results = await runToPublished(opened, planned.length);
      expect(results).toEqual(['published', 'published']);
      for (const unit of planned) {
        const facts = await publishedFacts(opened, unit.unitId);
        // Every unit published its coverage and nothing else: the refused write stands nowhere, not even in part.
        expect(facts.map((fact) => fact.kind)).toEqual(['coverage']);
      }
    } finally {
      await opened.close();
    }
  }, 240_000);

  test('a malformed answer is refused by the field it got wrong, the unit is asked again, and its own places are what an answer may name', async () => {
    const opened = await openWorld({
      script: {
        // Each unit's first turn is no answer the contract reads: the answer schema names the field it lacks, and the
        // unit is asked again — inside 0026's turn limit, not as a failure. Both nudged units are answered by the one
        // scripted turn, whose `covered` names both modules' files: a unit counts only the places of its own scope.
        byPrompt: [
          {
            matches: 'That was not the answer',
            steps: [{ answer: { status: 'done', covered: [PAYMENT_FILE, ORDER_FILE], remaining: [], summary: 'both were read' } }],
          },
        ],
        steps: [{ say: 'reading the module' }, { say: '{"covered":[]}' }, { end: {} }],
      },
    });
    try {
      const planned = await planAndAdmit(opened);
      const results = await runToPublished(opened, planned.length);
      expect(results).toEqual(['published', 'published']);
      const sent = prompts(opened);
      expect(sent.length).toBe(4);
      const nudges = sent.filter((prompt) => prompt.includes('That was not the answer this unit contract asks for.'));
      expect(nudges.length).toBe(2);
      for (const nudge of nudges) {
        expect(nudge).toContain('the answer names no `status`');
        expect(nudge).toContain('{"status":"done"|"partial"');
      }
      // Each nudge names the places of its own scope, so the unit can answer without reading the packet again.
      expect(nudges.find((nudge) => nudge.includes('src/payment.ts'))).toBeDefined();
      expect(nudges.find((nudge) => nudge.includes('src/order.ts'))).toBeDefined();
      for (const unit of planned) {
        const facts = await publishedFacts(opened, unit.unitId);
        expect(facts.map((fact) => fact.kind)).toEqual(['coverage']);
        const coverage = facts[0]!.value as unknown as { complete: boolean; read: readonly string[] };
        expect(coverage.complete).toBe(true);
        expect(coverage.read.length).toBe(1);
      }
    } finally {
      await opened.close();
    }
  }, 240_000);

  test('a unit that never answers is stopped at 0026\'s turn limit and splits its module into its files, which read the same sections for one file', async () => {
    const ids = fixture();
    const opened = await openWorld({
      script: {
        byPrompt: [
          // The orders unit finishes. The child is told by the scope text only its own packet spells (its `unit` and
          // `place` sections carry it; the parent's `members` rows spell the same text as a `place`, and its nudges
          // spell it as a bare path), so the payments parent is never answered: every one of its turns ends without
          // an answer, and at 0026's turn limit it stops and its uncovered places — its own file — are the children
          // the split seals.
          { matches: '"orders"', steps: [{ answer: { status: 'done', covered: [ORDER_FILE], remaining: [], summary: 'read' } }] },
          { matches: '"scope": "orders-api:src/payment.ts"', steps: [{ answer: { status: 'done', covered: [PAYMENT_FILE], remaining: [], summary: 'the file was read' } }] },
        ],
        steps: [],
      },
      limits: { leaseMs: 86_400_000 },
    });
    try {
      const planned = await planAndAdmit(opened);
      // Four ends over the run: the payments parent stops at its turn limit and splits; the split's child publishes;
      // the child's publication is what releases the parent's join, whose attempt the script never answers either, so
      // it stops a second time and, trying to seal the child its generation already sealed, ends blocked — the
      // machine's own re-seal refusal (madarch-tzte.22.3: a parent whose children settled builds on them rather than
      // sealing them again), which is what a person would resolve; and the orders unit publishes. Which runs first is
      // the scheduler's own order, so the results are compared as a set.
      const results = await runToPublished(opened, 4);
      expect([...results].sort()).toEqual(['blocked', 'published', 'published', 'split']);
      // The parent's two attempts of thirty turns each: its first prompt and every nudge after it name its file, and
      // the child's one prompt is told apart by the scope text only its own packet spells.
      expect(prompts(opened).filter((prompt) => prompt.includes(PAYMENT_FILE) && prompt.includes('"scope": "orders-api:src/payment.ts"') === false).length).toBe(60);
      const stopped = (await readProgress(opened.owner, RUN)).map((event) => event.summary).filter((summary) => summary.includes('stopped at its turn limit'));
      expect(stopped.length).toBe(2);
      // A plan's unit id is the stage's own (`unitIdFor`): the stage id, then the module fact the plan named it by.
      let paymentUnit = planned[1]!;
      for (const unit of planned) {
        const plan = await readUnitPlan(opened.owner, unit.unitId, unit.generation);
        if (unit.unitId === unitIdFor(INTENT_HISTORY_STAGE_ID, ids.payments.id) && plan?.scope === CODE_REPOSITORY) paymentUnit = unit;
      }
      // The parent's partial draft keeps its coverage: no place of the module was read, and its file is a `budget` gap.
      const draft = await readUnitDraft(opened.owner, paymentUnit.unitId, paymentUnit.generation);
      const coverages = (draft?.writes ?? []).map((write) => write.value as { kind: string; value: { scope: string; complete: boolean; read: string[]; unread: { what: string; reason: string }[] } });
      expect(coverages.map((coverage) => [coverage.kind, coverage.value.scope, coverage.value.complete, coverage.value.read, coverage.value.unread])).toEqual([
        ['coverage', ids.payments.id, false, [], [{ what: PAYMENT_FILE, reason: 'budget' }]],
      ]);

      // 0026's hierarchy: the stop splits the module into its files, one child, named by its file's own fact.
      const children = (await readRunUnits(opened.owner, RUN)).filter((record) => record.unitId !== unitIdFor(INTENT_HISTORY_STAGE_ID, ids.payments.id) && record.unitId !== unitIdFor(INTENT_HISTORY_STAGE_ID, ids.orders.id));
      expect(children.length).toBe(1);
      const childScope = (await readUnitPlan(opened.owner, children[0]!.unitId, children[0]!.generation))?.scope;
      expect(childScope).toBe(`${CODE_REPOSITORY}:${PAYMENT_FILE}`);
      // The child ran inside the loop above (one unit at a time: the parent split, then the child was admitted and
      // published), so its state is the store's own word for it.
      const childRecord = (await readRunUnits(opened.owner, RUN)).find((record) => record.unitId === children[0]!.unitId);
      expect(childRecord?.state).toBe('published');
      const childFacts = await publishedFacts(opened, children[0]!.unitId);
      expect(childFacts.map((fact) => fact.kind)).toEqual(['coverage']);
      expect((childFacts[0]!.value as unknown as { complete: boolean; read: readonly string[] }).complete).toBe(true);
      // The child's packet held the same two sections for its one file: the planted comment and the commit that
      // touched it, with its task key.
      const childPrompt = prompts(opened).find((prompt) => prompt.includes(`"scope": "${CODE_REPOSITORY}:${PAYMENT_FILE}"`))!;
      const childPacket = packetOf(childPrompt);
      expect(Object.keys(childPacket)).toEqual(['unit', 'place', 'scope', 'members', 'entryPoints', 'data', 'relations', 'history', 'comments', 'commits', 'writes', 'marker']);
      expect(childPacket['comments']).toEqual([{ id: ids.comment.id, form: 'line', file: PAYMENT_FILE, line: 1 }]);
      expect(childPacket['commits']).toEqual([{
        id: ids.commits[1]!.id,
        commit: HISTORY[1]!.commit,
        committedAt: HISTORY[1]!.at,
        subject: PAYMENT_COMMIT_SUBJECT,
        touched: [PAYMENT_FILE],
        touchedMore: 0,
        taskKeys: ['PAY-4'],
      }]);
    } finally {
      await opened.close();
    }
  }, 300_000);
});

describe('stage 11\'s declaration', () => {
  test('one unit per module at 0026\'s cluster level, claims and questions at the intent level, and its own sections', () => {
    const declaration = intentHistoryDeclaration();
    expect(declaration.factStage).toBe('11-intent-history');
    // Self-filling's outcome 4: what people recorded, as the comments and the commits state it.
    expect(declaration.level).toBe('intent');
    // 0026's hierarchy: stage 5's modules are its clusters, and a unit that splits covers its own files.
    expect(declaration.scale).toEqual({ level: 'cluster', child: 'place' });
    expect(declaration.kinds).toEqual(INTENT_HISTORY_KINDS);
    expect(declaration.kinds).toEqual(['claim', 'question']);
    expect(declaration.sections?.map((section) => section.name)).toEqual(['comments', 'commits']);
    expect(declaration.answer.fields.map((field) => field.name)).toEqual(['status', 'covered', 'remaining', 'summary']);
    // A run that wires no agent registers no agent stage at all.
    expect(createStageRegistry({ snapshots: createGitSnapshotSource(() => []) }).get(INTENT_HISTORY_STAGE_ID)).toBeUndefined();
    const wired = createStageRegistry({
      snapshots: createGitSnapshotSource(() => []),
      agent: { agent: { id: 'fake-agent', command: process.execPath, args: [FAKE_AGENT, '--scenario', 'no-usage'] } },
    });
    expect(wired.get(INTENT_HISTORY_STAGE_ID)?.id).toBe(INTENT_HISTORY_STAGE_ID);
    expect(wired.get('overview')?.id).toBe('overview');
    // The whole registered registry derives with every landed agent stage wired: stages 8, 10 and 11 all produce the
    // one `claim` kind, and stage 10's optional `claim` consume draws its edge to every producer of it, so the graph
    // must stay a DAG whatever a later agent stage produces beside the others (the cycle madarch-tzte.26.1 named).
    const derived = deriveStageGraph(wired);
    if (!derived.ok) throw new Error(`the agent-wired registry does not derive: ${JSON.stringify(derived)}`);
    // Stage 10 after both of its claim producers, and the run's own order holds no cycle by construction: a refused
    // derivation throws above.
    expect(derived.graph.order.indexOf(INTENT_HISTORY_STAGE_ID)).toBeLessThan(derived.graph.order.indexOf('doc-intent'));
    expect(derived.graph.order.indexOf('overview')).toBeLessThan(derived.graph.order.indexOf('doc-intent'));
  });
});

describe('stage 11\'s plan', () => {
  test('nothing found where the graph holds no module, and a module past 0026\'s planned size planned as its files', async () => {
    const empty = createPGliteDatabaseOwner();
    try {
      await createFactStoreSchema(empty);
      const emptyReader = createFactGraphReader({ database: empty, snapshot: createGitSnapshotSource(() => []) });
      const plan = await planIntentUnits(emptyReader);
      expect(plan.coverage).toBe('nothing-found');
      expect(plan.units).toEqual([]);
    } finally {
      await empty.close();
    }

    // A module whose own count is past 0026's planned size (272K × 50% at about 2K a member) is planned as its
    // member files, each a unit of its own, whose scope is the file the plan names.
    const big = createPGliteDatabaseOwner();
    try {
      await createFillStateSchema(big);
      await createFactStoreSchema(big);
      const repository = makeNodeFact({ kind: 'repository', value: { repository: 'big-repo', form: 'code' }, provenance: provenance('big-repo', 'src/a.ts', 1), layer: 'extracted' });
      const module = makeNodeFact({ kind: 'module', value: { repository: 'big-repo', name: 'everything', seed: 'package', members: 500, importance: 1 }, provenance: provenance('big-repo', 'src/a.ts', 1), layer: 'extracted' });
      const fileA = makeNodeFact({ kind: 'file', value: { repository: 'big-repo', path: repositoryPath('src/a.ts'), roles: ['source'] }, provenance: provenance('big-repo', 'src/a.ts', 1), layer: 'extracted' });
      const fileB = makeNodeFact({ kind: 'file', value: { repository: 'big-repo', path: repositoryPath('src/b.ts'), roles: ['source'] }, provenance: provenance('big-repo', 'src/b.ts', 1), layer: 'extracted' });
      const writes = [
        repository, module, fileA, fileB,
        makeEdgeFact({ kind: 'contains', value: { from: repository.id, to: module.id }, provenance: provenance('big-repo', 'src/a.ts', 1), layer: 'extracted' }),
        makeEdgeFact({ kind: 'contains', value: { from: module.id, to: fileA.id }, provenance: provenance('big-repo', 'src/a.ts', 1), layer: 'extracted' }),
        makeEdgeFact({ kind: 'contains', value: { from: module.id, to: fileB.id }, provenance: provenance('big-repo', 'src/b.ts', 1), layer: 'extracted' }),
      ];
      await createUnit(big, { unitId: 'graph/all', product: 'fixture-product', runId: 'run-seed', stageId: 'graph', scopeKey: 'all', inputsDigest: 'graph-inputs', retries: 0, at: NOW });
      const seed = await big.transaction('snapshot', async (executor) => (await executor.query<{ unit_id: string; generation: number }>('SELECT unit_id, generation FROM fill_unit WHERE unit_id = $1', ['graph/all'])).rows[0]);
      if (seed === undefined) throw new Error('the fixture unit was not created');
      const record = { unitId: 'graph/all', generation: Number(seed.generation) } as Parameters<typeof applyPublishedFacts>[0]['unit'];
      await big.transaction('write', async (executor) => await applyPublishedFacts({
        executor,
        unit: record,
        plan: { unitId: 'graph/all', generation: record.generation, runId: 'run-seed', stageId: 'graph', stageUnitId: 'all', scope: 'all', stagePosition: 0, planPosition: 0, plannedAt: NOW },
        digest: 'graph-publication-1',
        writes: writes.map((fact) => ({ kind: 'fact' as const, evidence: 'big-repo@head', value: fact })),
      }));
      await createStageReadSchema(big);
      const reader = createFactGraphReader({ database: big, snapshot: createGitSnapshotSource(() => []) });
      const plan = await planIntentUnits(reader);
      expect(plan.coverage).toBe('planned');
      expect(plan.units.map((unit) => [unit.id, unit.scope])).toEqual([
        [fileA.id, `big-repo:${'src/a.ts'}`],
        [fileB.id, `big-repo:${'src/b.ts'}`],
      ]);
    } finally {
      await big.close();
    }
  }, 60_000);
});

describe('stage 11\'s sections', () => {
  test('a commit that touched more of the module than its row holds says how many more', async () => {
    const owner = createPGliteDatabaseOwner();
    try {
      await createFillStateSchema(owner);
      await createFactStoreSchema(owner);
      await createStageReadSchema(owner);
      // A module of twenty-two files, and one commit that touched all of them plus three files of another module: the
      // row names twenty of the twenty-two and says two more stood, which is a cut the row itself names and no reader
      // has to guess.
      const repository = makeNodeFact({ kind: 'repository', value: { repository: 'cut-repo', form: 'code' }, provenance: provenance('cut-repo', 'src/f01.ts', 1), layer: 'extracted' });
      const module = makeNodeFact({ kind: 'module', value: { repository: 'cut-repo', name: 'wide', seed: 'package', members: 22, importance: 1 }, provenance: provenance('cut-repo', 'src/f01.ts', 1), layer: 'extracted' });
      const moduleFiles = Array.from({ length: 22 }, (_, index) => `src/f${String(index + 1).padStart(2, '0')}.ts`);
      const files = moduleFiles.map((path) => makeNodeFact({ kind: 'file', value: { repository: 'cut-repo', path: repositoryPath(path), roles: ['source'] }, provenance: provenance('cut-repo', path, 1), layer: 'extracted' }));
      const commit = makeNodeFact({
        kind: 'commit',
        value: {
          repository: 'cut-repo', commit: 'b'.repeat(40), committedAt: '2024-01-03T00:00:00Z', authoredAt: '2024-01-03T00:00:00Z',
          subject: 'WIDE-1 merge the wide branch', parents: [],
          files: [...moduleFiles, 'src/other-01.ts', 'src/other-02.ts', 'src/other-03.ts'].map((path) => repositoryPath(path)),
        },
        provenance: { source: { system: 'git', version: '1.0.0' }, repository: { id: 'cut-repo', commit: 'b'.repeat(40) } },
        layer: 'extracted',
      });
      const writes = [
        repository, module, commit, ...files,
        makeEdgeFact({ kind: 'contains', value: { from: repository.id, to: module.id }, provenance: provenance('cut-repo', 'src/f01.ts', 1), layer: 'extracted' }),
        ...files.map((file) => makeEdgeFact({ kind: 'contains', value: { from: module.id, to: file.id }, provenance: provenance('cut-repo', 'src/f01.ts', 1), layer: 'extracted' })),
        makeEdgeFact({ kind: 'task-key', value: { from: commit.id, key: 'WIDE-1' }, provenance: commit.provenance, layer: 'extracted' }),
      ];
      await createUnit(owner, { unitId: 'graph/all', product: 'fixture-product', runId: 'run-seed', stageId: 'graph', scopeKey: 'all', inputsDigest: 'graph-inputs', retries: 0, at: NOW });
      const seed = await owner.transaction('snapshot', async (executor) => (await executor.query<{ unit_id: string; generation: number }>('SELECT unit_id, generation FROM fill_unit WHERE unit_id = $1', ['graph/all'])).rows[0]);
      if (seed === undefined) throw new Error('the fixture unit was not created');
      const record = { unitId: 'graph/all', generation: Number(seed.generation) } as Parameters<typeof applyPublishedFacts>[0]['unit'];
      await owner.transaction('write', async (executor) => await applyPublishedFacts({
        executor,
        unit: record,
        plan: { unitId: 'graph/all', generation: record.generation, runId: 'run-seed', stageId: 'graph', stageUnitId: 'all', scope: 'all', stagePosition: 0, planPosition: 0, plannedAt: NOW },
        digest: 'graph-publication-1',
        writes: writes.map((fact) => ({ kind: 'fact' as const, evidence: 'cut-repo@head', value: fact })),
      }));
      const reader = createFactGraphReader({ database: owner, snapshot: createGitSnapshotSource(() => []) });
      const request: AgentSectionRequest = {
        unit: { id: module.id, scope: 'cut-repo' },
        scope: writeScope('cut-repo'),
        reads: graphReadsOver(reader),
        graph: reader,
      };
      const sections = intentHistorySections();
      const rows = await sections.find((section) => section.name === 'commits')!.rows(request) as readonly {
        commit: string; subject: string; touched: readonly string[]; touchedMore: number; taskKeys: readonly string[];
      }[];
      expect(rows.length).toBe(1);
      expect(rows[0]!.subject).toBe('WIDE-1 merge the wide branch');
      expect(rows[0]!.touched.length).toBe(20);
      expect(rows[0]!.touched).toEqual([...moduleFiles].sort(byCodePoint).slice(0, 20));
      expect(rows[0]!.touchedMore).toBe(2);
      expect(rows[0]!.taskKeys).toEqual(['WIDE-1']);
      // A commit whose touched list fits the row names nothing more.
      const commentRows = await sections.find((section) => section.name === 'comments')!.rows(request) as readonly unknown[];
      expect(commentRows).toEqual([]);
    } finally {
      await owner.close();
    }
  }, 60_000);
});
