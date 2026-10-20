/**
 * A commit reruns only the units and pages its changes reach (madarch-tzte.26.1;
 * decision 0026, "Updates", and 0027's reuse).
 *
 * The bar the task names: "After a commit, the deterministic stages run for what
 * changed and the change propagates over graph edges to the agent units and pages
 * whose cache keys (tracked reads with membership, spans read, prompt/schema/model
 * versions) moved; only those rerun, in dependency order", measured "on the
 * training repository with the fake ACP agent: a one-file commit reruns the
 * expected units and pages and nothing else (listed)".
 *
 * The fixture is the training repository this project's generator makes
 * (`examples/training-repository/generate.mjs`, which AGENTS.md allows a test to
 * use) as the one code repository of a product the test makes. Every agent unit is
 * driven by the fake ACP agent (`test/fixtures/acp-fake-agent`): no real prompt, no
 * network, no token spent. The fake agent reads one evidence span of the file the
 * test commits and answers its scope whole, so the units' cache keys differ in
 * exactly the part the commit moves — the bytes of that span.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createFillOrchestratorService, type FillOrchestratorService, type FillRunResult } from '../src/fill/orchestrator-host.js';
import { readProgress, readUnitReads } from '../src/fill/orchestrator-store.js';
import { readRunUnits } from '../src/fill/state-store.js';
import { answerMembership } from '../src/fill/graph-reads.js';
import { OVERVIEW_STAGE_ID } from '../src/fill/stages/overview.js';
import { UNDERSTANDING_STAGE_ID } from '../src/fill/stages/understanding.js';
import { DOC_INTENT_STAGE_ID } from '../src/fill/stages/doc-intent.js';
import { INTENT_HISTORY_STAGE_ID } from '../src/fill/stages/intent-history.js';
import { NARRATIVE_STAGE_ID } from '../src/fill/stages/narrative.js';
import { PRODUCT_SCOPE_NAME } from '../src/fill/stages/agent-stage.js';
import { UNIT_TOOL_PATH } from '../src/fill/unit-tools.js';
import { startServer, type StartedServer } from '../src/server/http.js';
import { createStagesFill, type StagesFill } from '../src/product/fill-stages.js';

const FAKE_AGENT = join(import.meta.dir, 'fixtures', 'acp-fake-agent', 'acp-fake-agent.ts');
const GENERATOR = fileURLToPath(new URL('../examples/training-repository/generate.mjs', import.meta.url));

/** The product's name, and the name of the one code repository it declares. */
const PRODUCT = 'shop';
const TRAINING = 'training';

/** Every file the training repository holds, which is what its unit answers as covered (the generator's own list). */
const TRAINING_FILES = [
  'README.md',
  'docs/architecture.md',
  'model-ids.json',
  'services/checkout/src/checkout.ts',
  'services/orders/README.md',
  'services/orders/src/order.go',
  'services/payments/src/payment.ts',
  'services/promotions/src/promotions.go',
];

/** The one file the test commits a change to, and the change: a comment, which moves the file's bytes and no symbol. */
const CHANGED = 'services/promotions/src/promotions.go';
const CHANGE = '\n// The minimum order is spelled out for the walk, not for the compiler.\n';

let root = '';
/** The product folder, the generated training repository, and where the fake agent's script and record stand. */
let product = '';
let world = '';

/** One git call in a fixture checkout. */
function git(folder: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: folder, encoding: 'utf8' }).trim();
}

/** One product open for runs: its wiring, its service, the server its units' tools answer through, and the database. */
interface Open {
  readonly fill: StagesFill;
  readonly owner: DatabaseOwner;
  readonly service: FillOrchestratorService;
  readonly server: StartedServer;
  /** Writes the fake agent's script for a run at the given pin of the training repository. */
  script(commit: string): void;
  run(runId: string): Promise<FillRunResult>;
  /** Every page a run's publications touched, in code point order. */
  pagesOf(runId: string): Promise<readonly string[]>;
  /** The durable progress events of one run, in the order they were written. */
  events(runId: string): Promise<readonly { kind: string; unitId: string; summary: string }[]>;
  close(): Promise<void>;
}

/**
 * The fake agent's script for one run: an agent unit of the training repository reads one span of the file
 * the test changes and answers its scope whole; the product repository's unit reads a span of the product's
 * own manifest and answers its own scope whole. The span names the commit the run pins, which is what a real
 * agent reads out of its packet.
 */
function agentScript(commit: string): Record<string, unknown> {
  return {
    // The agent stages of 0026 this build lands, each with its own answer: the product's one overview
    // unit (stage 8, its scope the whole product, its places the repositories) reads the bytes of the
    // file the test changes; stage 10's unit of the training repository's documents names them all, so
    // its coverage is complete and it splits into nothing; stage 11's unit of the training
    // repository's one module names every file the repository holds, and its places — the module's own
    // member files — are all inside that list. Its prompt is told apart by the `comments` section, which
    // no other stage's packet holds.
    byPrompt: [
      {
        // Stage 12's units (madarch-tzte.24.5) answer their own packet's members whole: a module's members
        // are the files it holds, and the module was understood from the graph and its children's summaries.
        matches: '"task": "Understand this module from the graph',
        steps: [{ answerMembers: { summary: 'the module was understood from the graph and its children\'s summaries' } }],
      },
      {
        matches: '"comments"',
        steps: [
          // Stage 11 plans one unit per module, and the fixture holds two: the training repository's module, whose
          // member files the first list names, and the product repository's own module, whose members are its
          // manifest and the training checkout's link. A unit that names every place it was shown publishes without
          // splitting, which is what the rerun expectations below count on.
          { answer: { status: 'done', covered: [...TRAINING_FILES, 'repos/training', 'workspace.yaml'], remaining: [], summary: 'The module comments and commits state the pricing rules and the tracked work that built them' } },
        ],
      },
      {
        matches: '"scope": "training"',
        steps: [
          { answer: { status: 'done', covered: ['README.md', 'docs/architecture.md', 'services/orders/README.md', 'model-ids.json'], remaining: [], summary: 'The README promises a retention the orders service spells out' } },
        ],
      },
      // Stage 9's units (madarch-tzte.24.2) are answered by their packet's own word: `clustering` is the key of
      // the stage's own section and stands in no other stage's packet. The default steps would leave a unit of
      // stage 9 recording the overview's span reads — which is the update's business and not its own — and the
      // pages stage's units (25.1) must keep running those default steps, so the match is the section's key and
      // not the unit's scope text.
      {
        matches: 'clustering',
        steps: [
          { answer: { status: 'done', covered: [], remaining: [], summary: 'The modules of this scope are read whole through the packet, and their boundary is proposed as it stands' } },
        ],
      },
    ],
    steps: [
      { call: { tool: 'evidence_span', arguments: { repository: TRAINING, commit, file: CHANGED, startLine: 1, endLine: 200 } } },
      { call: { tool: 'evidence_span', arguments: { repository: PRODUCT, commit: git(product, 'rev-parse', 'HEAD'), file: 'workspace.yaml', startLine: 1, endLine: 200 } } },
      { answer: { status: 'done', covered: [TRAINING, PRODUCT], remaining: [], summary: 'The training system prices a discount as a share of the subtotal; the product declares it as a repository' } },
    ],
  };
}

/**
 * The clock a run reads: a second per call, so a retry the orchestrator deferred is due on the next pass and
 * no test sleeps. The fake agent's own clock is a constant, so a unit's ten-minute limit never trips on a
 * clock the run moves.
 */
function runClock(): { now(): number } {
  let at = 1_700_000_000_000;
  return { now: () => (at += 1_000) };
}

/** Opens one product for runs: its stages fill, its service, and the server that answers its units' tool calls. */
async function openProduct(agentClock: () => number): Promise<Open> {
  const folder = join(world, 'home');
  mkdirSync(folder, { recursive: true });
  const owner: DatabaseOwner = createPGliteDatabaseOwner();
  const scriptPath = join(world, 'script.json');
  const record = join(world, 'agent-record.jsonl');
  const script = (commit: string): void => { writeFileSync(scriptPath, JSON.stringify(agentScript(commit))); };
  script(git(join(product, 'repos', TRAINING), 'rev-parse', 'HEAD'));
  const fill = await createStagesFill({
    product,
    database: owner,
    agent: {
      agent: { id: 'fake-agent', command: process.execPath, args: [FAKE_AGENT, '--scenario', 'script', '--script', scriptPath, '--record', record] },
      clock: agentClock,
      cwd: world,
      timeouts: { initializeMs: 30_000, sessionMs: 30_000 },
    },
  });
  let server: StartedServer | undefined;
  const clock = runClock();
  const service = createFillOrchestratorService({
    home: join(world, 'products'),
    owner,
    registry: fill.registry,
    wiring: () => fill.wiring,
    toolUrl: () => (server === undefined ? undefined : `${server.url}${UNIT_TOOL_PATH}`),
    clock: clock.now,
    // The run's clock moves a second per call, so a lease must hold across the calls a pass makes: a day is
    // longer than any run of this test, and a lapsed lease is not what it measures.
    limits: { leaseMs: 86_400_000 },
  });
  const appFolder = join(world, 'app');
  mkdirSync(appFolder, { recursive: true });
  writeFileSync(join(appFolder, 'index.html'), '<!doctype html><title>fixture app</title>');
  const home = join(world, 'served');
  mkdirSync(home, { recursive: true });
  server = await startServer({ productHome: home, appFolder, port: 0, orchestrator: service, log: () => undefined, errorLog: () => undefined });
  const started = server;
  return {
    fill,
    owner,
    service,
    server: started,
    script,
    run: async (runId) => {
      const result = await service.run({ product: fill.product, runId });
      if (!result.ok) throw new Error(`the run ${runId} was refused: ${result.code}: ${result.reason}`);
      return result;
    },
    pagesOf: async (runId) => (await owner.transaction('snapshot', async (executor) => (
      await executor.query<{ node_id: string }>(
        `SELECT DISTINCT c.node_id FROM fill_page_change c
           JOIN fill_unit_generation g ON g.unit_id = c.unit_id AND g.generation = c.generation
          WHERE g.run_id = $1 ORDER BY c.node_id`,
        [runId],
      )
    ).rows)).map((row) => row.node_id),
    events: async (runId) => (await readProgress(owner, runId)).map((event) => ({ kind: event.kind, unitId: event.unitId, summary: event.summary })),
    close: async () => {
      await started.stop();
      await service.stop();
      await owner.close();
    },
  };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'madarch-impact-'));
  const checkout = join(root, TRAINING);
  // The training repository this project's generator makes: a deterministic Git repository with fixed authors.
  execFileSync(process.execPath, [GENERATOR, checkout], { encoding: 'utf8', cwd: root });
  product = join(root, PRODUCT);
  mkdirSync(join(product, 'repos'), { recursive: true });
  writeFileSync(join(product, 'workspace.yaml'), [
    'schemaVersion: 1',
    'id: 4f1d8a52-9c3e-4f7a-8b21-6d2e9c0a5b13',
    `name: ${PRODUCT}`,
    'repos:',
    `  - name: ${TRAINING}`,
    '    url: https://example.invalid/ordering-payments-training.git',
    '',
  ].join('\n'));
  // The checkout a product declares stands at `repos/<name>`, which `madarch repo add` makes a link.
  symlinkSync(checkout, join(product, 'repos', TRAINING), 'dir');
  git(product, 'init', '-q');
  git(product, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'add', '-A');
  git(product, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'one');
  world = mkdtempSync(join(root, 'world-'));
});

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

/** The units a run planned and the ones it inherited, by unit id, in code point order. */
function reran(result: FillRunResult): readonly string[] {
  const reused = new Set(result.reused);
  return result.units.map((unit) => unit.unitId).filter((unitId) => !reused.has(unitId)).sort();
}


/**
 * Every unit the one-file commit reruns, listed rather than counted.
 *
 * The deterministic part is madarch-tzte.21.x's own incrementality, unchanged by this task: the changed file's
 * units in the stages that read its bytes, the inventory unit of every folder above it, the three units that read
 * its repository whole (the snapshot of its pin, the clustering of its graph and its history at the new commit),
 * the history unit of the commit the run left behind (its scope names a commit, so the new pin replaces it and it
 * retracts the facts it published), and the resolution units the resolution stage's own input — the run's pins —
 * makes it compute again on any new commit (madarch-tzte.21.8's documented exception, `inputsOf`).
 *
 * The agent part is this task's: the training repository's agent unit, whose recorded span read answers different
 * bytes at the new pin, and no unit of the product repository, whose reads and spans the commit never touched.
 */
function reranByTheCommit(options: {
  readonly repository: string;
  readonly file: string;
  readonly commit: string;
  readonly previousCommit: string;
  readonly agentUnitOfRepository: string;
}): readonly string[] {
  const { repository, file, commit, previousCommit } = options;
  const folders: string[] = [];
  for (let path = file.split('/').slice(0, -1).join('/'); path !== ''; path = path.split('/').slice(0, -1).join('/')) folders.push(path);
  return [
    // The repository's own readings.
    `snapshot/${repository}`,
    `modules/modules:${repository}`,
    `history/${repository}@${commit}`,
    `history/${repository}@${previousCommit}`,
    // The changed file, and the folder chain that holds it.
    ...folders.map((path) => `inventory/directory:${repository}:${path}`),
    `inventory/file:${repository}:${file}`,
    `syntax/file:${repository}:${file}`,
    // The resolution stage's units, which stand on the run's pins (21.8's exception): the changed file's, and the
    // three source files of the same repository that its plan names again.
    `semantic-resolution/file:${repository}:${file}`,
    ...['services/checkout/src/checkout.ts', 'services/orders/src/order.go', 'services/payments/src/payment.ts']
      .map((path) => `semantic-resolution/file:${repository}:${path}`),
    // The agent units the commit's own readings moved: the overview's recorded span (madarch-tzte.26.1) and the
    // boundary refinement's reads, which the clustering the commit replans made stale (madarch-tzte.24.2).
    options.agentUnitOfRepository,
  ].sort();
}

/** The ids of the facts one `WHERE` clause names, bound to the values given: what a page id is read by in a test. */
async function factIds(opened: Open, where: string, values: readonly unknown[]): Promise<readonly string[]> {
  return await opened.owner.transaction('snapshot', async (executor) => (
    await executor.query<{ id: string }>(`SELECT id FROM fill_fact WHERE ${where} ORDER BY id`, [...values])
  ).rows).then((rows) => rows.map((row) => row.id));
}

describe('a commit, and what it reruns', () => {
  let opened: Open | undefined;
  let first: FillRunResult | undefined;
  let second: FillRunResult | undefined;
  let third: FillRunResult | undefined;
  let pages: readonly string[] = [];
  /** The understanding units of run-three, by unit id, read from the store (the stage plans one per module, and the ids name no node a constant could spell). */
  let understandingUnitIds: readonly string[] = [];
  /** The commit the one-file commit made in the training repository, and the commit the fill stood on before it. */
  let changed = '';
  let previous = '';
  /** The training repository fact's id, which stage 10's unit of it is named by. */
  let trainingRepositoryId = '';
  /** The training repository's clustering unit, which stage 9 plans at its top module (madarch-tzte.24.2). */
  let trainingModuleUnitId = '';
  /** The product repository fact's id, which stage 9's unit of it is named by. */
  let shopRepositoryId = '';

  beforeAll(async () => {
    // One wiring and one service for every run: decision 0027's "a second run of the same product reuses what
    // the first opened", and the pins are read again when each run plans (the wiring re-pins at planning).
    opened = await openProduct(() => 1_700_000_000_000);
    // The first run fills the graph: it is the deterministic fill, because a run plans before any stage
    // publishes and the agent stage's plan reads the graph the other stages write.
    first = await opened.run('run-one');
    // The second run plans the agent unit now that the graph holds the repositories and their places.
    second = await opened.run('run-two');
    // The one-file commit: a comment at the end of one source file, so the file's bytes move and no symbol does.
    const checkout = join(product, 'repos', TRAINING);
    previous = git(checkout, 'rev-parse', 'HEAD');
    writeFileSync(join(checkout, CHANGED), `${readFileSync(join(checkout, CHANGED), 'utf8')}${CHANGE}`);
    git(checkout, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'add', '-A');
    git(checkout, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'PRM-8 spell the minimum order out');
    changed = git(checkout, 'rev-parse', 'HEAD');
    opened.script(changed);
    try {
      third = await opened.run('run-three');
    } catch (error) {
      for (const event of await readProgress(opened!.owner, 'run-two')) console.log('R2EVENT', event.kind, event.unitId, event.summary);
      throw error;
    }
    pages = await opened.pagesOf('run-three');
    trainingRepositoryId = await opened.owner.transaction('snapshot', async (executor) => (
      await executor.query<{ id: string }>("SELECT id FROM fill_fact WHERE kind = 'repository' AND value->>'repository' = $1", [TRAINING])
    ).rows[0]!.id);
    const understandingRecords = (await readRunUnits(opened!.owner, 'run-three')).filter((unit: { stageId: string }) => unit.stageId === UNDERSTANDING_STAGE_ID);
    // The understanding units run-three holds (madarch-tzte.24.5): the stage plans one per module, and the
    // ids name no node a constant could spell, so they are read from the store like the repository's own.
    understandingUnitIds = understandingRecords.map((unit: { unitId: string }) => unit.unitId);
    // Stage 9's units (madarch-tzte.24.2), which the run inherited: the training repository's clustering plans
    // at its one top module, whose fact id the unit is named by, and the product repository's stays the
    // repository unit its clustering leaves room for. The ids are the run's own record, read here rather than
    // guessed: a unit id is a fact id or the fact the clustering's level below names, and the fixture holds
    // neither spelling.
    const boundariesUnits = (third?.reused ?? []).filter((unitId) => unitId.startsWith('boundaries/'));
    expect(boundariesUnits).toHaveLength(2);
    trainingModuleUnitId = boundariesUnits.find((unitId) => unitId.startsWith('boundaries/module:')) ?? '';
    shopRepositoryId = boundariesUnits.find((unitId) => unitId.startsWith('boundaries/repository:')) ?? '';
    for (const [name, result] of [['run-one', first], ['run-two', second], ['run-three', third]] as const) {
      if (result.state === 'succeeded' && result.settled) continue;
      // eslint-disable-next-line no-console
      console.log(name, JSON.stringify({ state: result.state, settled: result.settled, stopped: result.stoppedBecause, units: result.units, events: (await opened.events(name)).slice(-14) }, null, 1));
    }

  }, 1_800_000);

  afterAll(async () => {
    await opened?.close();
  });

  test('the first run fills the graph, and the agent unit is planned by the run that follows it', () => {
    expect({ state: first?.state, settled: first?.settled, reused: first?.reused }).toEqual({ state: 'succeeded', settled: true, reused: [] });
    // A run plans before anything publishes, and the agent stage plans from the graph (0027): the first run of a
    // product plans no agent unit, and the run after the graph is filled plans one per repository.
    expect((first?.units ?? []).filter((unit) => unit.stageId === OVERVIEW_STAGE_ID || unit.stageId === DOC_INTENT_STAGE_ID || unit.stageId === INTENT_HISTORY_STAGE_ID)).toEqual([]);
    expect({ state: second?.state, settled: second?.settled }).toEqual({ state: 'succeeded', settled: true });
    // 0026's hierarchy, its top: the product's one overview unit, whose scope is every repository the run pins.
    expect((second?.units ?? []).filter((unit) => unit.stageId === OVERVIEW_STAGE_ID).map((unit) => `${unit.unitId}: ${unit.state}`)).toEqual([
      `${OVERVIEW_STAGE_ID}/${PRODUCT_SCOPE_NAME}: published`,
    ]);
  }, 900_000);

  test('a one-file commit reruns the units it reaches and inherits every other unit', async () => {
    expect(third?.state).toBe('succeeded');
    // The units the commit reran: the changed file's own, its folder chain's, the three units that read the
    // repository whole, the history unit of the commit it left, the resolution units the stage's own pins-input
    // computes again, the product's overview unit, whose recorded span read the commit moved — and the pages
    // stage's units (25.1) whose own cache key moved the same way: this world's scripted agent reads the changed
    // file's span in every unit's session but the ones the `byPrompt` entries answer (stage 10's unit of the
    // training repository's documents, every unit whose scope is that repository, and stage 9's units, whose
    // prompts the entries for the training and product repositories answer), so every page whose scope is not
    // that one carries the span read, and the page is rewritten. Stage 9's own units stand beside them reused:
    // a comment-only commit moves no module, no member count and no containment (madarch-tzte.24.2).
    const { narrativeReran } = await narrativePlansOfRunTwo();
    expect(reran(third!)).toEqual([...reranByTheCommit({
      repository: TRAINING,
      file: CHANGED,
      commit: changed,
      previousCommit: previous,
      agentUnitOfRepository: `${OVERVIEW_STAGE_ID}/${PRODUCT_SCOPE_NAME}`,
    }), ...narrativeReran].sort());
    // The units the run planned and inherited, listed whole: the product repository's snapshot, clustering and
    // history, whose pin, reads and spans the commit did not move. The two lists hold the run's planned units and
    // the ones it inherited between them; a unit an earlier run published that this run plans nothing of stands
    // outside both, and the store's own answer below is what says the overview unit was the only agent unit.
    expect((third?.units ?? []).filter((unit) => unit.stageId === OVERVIEW_STAGE_ID).map((unit) => unit.unitId))
      .toEqual([`${OVERVIEW_STAGE_ID}/${PRODUCT_SCOPE_NAME}`]);
    // Stage 10's unit of the training repository's documents is inherited too: the commit moved no
    // document, and its reads stand. The unit's id is the repository fact's own (24.3's plan), read
    // from the store here rather than guessed.
    // Stage 11's units are inherited too: a run plans before any stage publishes, and at planning the reads the
    // units recorded — the commits of their repository and the comments of their files, both the stage's own SQL —
    // still answer what they answered when the units ran in run-two. The commit moves those reads (a new commit
    // fact, and a new comment in the changed file), and what that makes of the units is the next run's planning,
    // not this run's list. The training repository's module stood past 0026's planned size, so the plan named its
    // files, and the product repository's own module stands as one unit; the ids are the store's own.
    const intentUnitsOfTraining = await factIds(opened!, "kind = 'file' AND value->>'repository' = $1", [TRAINING]);
    const moduleOfProduct = await factIds(opened!, "kind = 'module' AND value->>'repository' = $1", [PRODUCT]);
    // Stage 12's units (madarch-tzte.24.5) are inherited as the others are: the one module the training
    // repository clusters into was understood from the graph and its children's summaries, and the commit
    // moves what that makes of it into the next run's planning. The units are read from the store, as the
    // repository fact's id is above, and the stage is bound non-empty: the clustering holds one module, so
    // one unit must have run and been reused.
    expect(understandingUnitIds.length).toBeGreaterThan(0);
    // The pages stage's unit the `byPrompt` entry answered is inherited beside them.
    const { narrativePlans } = await narrativePlansOfRunTwo();

    expect([...(third?.reused ?? [])].sort()).toEqual([
      `snapshot/${PRODUCT}`,
      `modules/modules:${PRODUCT}`,
      `history/${PRODUCT}@${git(product, 'rev-parse', 'HEAD')}`,
      // The unit's id is the store's: the stage's own, then the unit's, which is the repository fact's id.
      `doc-intent/${trainingRepositoryId}`,
      ...intentUnitsOfTraining.map((id) => `${INTENT_HISTORY_STAGE_ID}/${id}`),
      ...moduleOfProduct.map((id) => `${INTENT_HISTORY_STAGE_ID}/${id}`),
      ...understandingUnitIds,
      ...narrativePlans.filter((plan) => plan.scope === TRAINING).map((plan) => plan.unit_id),
      // Stage 9's units are inherited whole (madarch-tzte.24.2): a comment-only commit moves no module, no
      // member count and no containment, and the recorded reads of both units stand. The training repository's
      // clustering is one module unit, planned at the level below the repository because its estimate is past
      // 0026's planned size, and the product repository's is the repository unit its one module leaves room for.
      trainingModuleUnitId,
      shopRepositoryId,
    ].sort());
  }, 900_000);

  test("the bytes the overview unit read moved at the new pin, and the manifest span stands as it stood", async () => {
    // the changed file (5 lines before the commit, 7 after) and the product's own manifest, and the changed file's
    // span answers different bytes at the commit the update run pins while the manifest's stand as they stood.
    const reads = await readUnitReads(opened!.owner, `${OVERVIEW_STAGE_ID}/${PRODUCT_SCOPE_NAME}`, 1);
    const spans = reads.filter((read) => (JSON.parse(read.query) as { read?: string }).read === 'span');
    expect(spans.map((read) => ({ query: JSON.parse(read.query), membership: read.membership }))).toEqual([
      { query: { read: 'span', repository: TRAINING, file: CHANGED, startLine: 1, endLine: 200 }, membership: expect.any(String) },
      { query: { read: 'span', repository: PRODUCT, file: 'workspace.yaml', startLine: 1, endLine: 200 }, membership: expect.any(String) },
    ]);
    const spanOf = (repository: string) => spans.find((read) => (JSON.parse(read.query) as { repository: string }).repository === repository)!;
    // The reader the run reads through answers a span at its own pin: the same read, the moved bytes.
    const reader = await opened!.fill.wiring.graph({ stageId: OVERVIEW_STAGE_ID, stageUnitId: PRODUCT_SCOPE_NAME, unitId: `${OVERVIEW_STAGE_ID}/${PRODUCT_SCOPE_NAME}`, scope: '*', generation: 1 });
    const movedNow = await reader.query(spanOf(TRAINING).query);
    expect(answerMembership(spanOf(TRAINING).query, movedNow)).not.toBe(spanOf(TRAINING).membership);
    const keptNow = await reader.query(spanOf(PRODUCT).query);
    expect(answerMembership(spanOf(PRODUCT).query, keptNow)).toBe(spanOf(PRODUCT).membership);
    // What the sweep said it replaced, and why: the run's own progress names the read that moved.
    const stale = (await opened!.events('run-three')).filter((event) => event.kind === 'unit-stale' && event.unitId === `${OVERVIEW_STAGE_ID}/${PRODUCT_SCOPE_NAME}`);
    expect(stale.length).toBe(1);
    expect(stale[0]!.summary).toContain('went stale (a read the generation recorded answers something else now:');
  }, 900_000);

  /** The pages stage's planned units of run two, and the ones whose scope the changed file's span stands inside. */
  async function narrativePlansOfRunTwo(): Promise<{ readonly narrativePlans: readonly { readonly unit_id: string; readonly scope: string }[]; readonly narrativeReran: readonly string[] }> {
    const narrativePlans = await opened!.owner.transaction('snapshot', async (executor) => (
      await executor.query<{ unit_id: string; scope: string }>(
        'SELECT unit_id, scope FROM fill_unit_plan WHERE run_id = $1 AND stage_id = $2',
        ['run-two', NARRATIVE_STAGE_ID],
      )
    ).rows);
    expect(narrativePlans.length).toBeGreaterThan(0);
    return {
      narrativePlans,
      narrativeReran: narrativePlans.filter((plan) => plan.scope !== TRAINING).map((plan) => plan.unit_id),
    };
  }

  test('the pages the update announces are the pages its publications changed, and no other', async () => {
    // A page is a view of the facts a unit holds (0026, "Pages"), so the pages an update announces are the pages
    // whose facts its publications changed. The one-file commit moved the bytes of one file, so what moved in the
    // graph is stage 5's re-measurement of that repository: its module's membership and importance, and the
    // importance of the three symbols the file declares. The file's own fact stands as it stood — a file's fact
    // is its identity, so a later publication of it adds a holding and changes no row — and no page of the
    // product repository, of a document or of another file's symbols is announced.
    const moduleOfTraining = await factIds(opened!, "kind = 'module' AND value->>'repository' = $1", [TRAINING]);
    const symbolsOfTheFile = await factIds(opened!, "kind = 'symbol' AND value->>'file' = $1", [CHANGED]);
    expect(moduleOfTraining.length).toBe(1);
    expect(symbolsOfTheFile.length).toBe(3);
    // The pages stage's units publish their coverage of what they read, and a coverage names the page it was
    // read for — but a coverage whose row stands as it stood is no change to any page (0026: a page is
    // announced when its facts changed), and the replacement generation's coverage is the same record the last
    // one wrote. The pages stage's rerun announces nothing of its own.
    expect(pages).toEqual([...moduleOfTraining, ...symbolsOfTheFile].sort());
    // The file whose bytes the commit moved has a page, and it is not one of the announced ones: its own row
    // moved nothing. Neither did the product repository's.
    const filePage = await factIds(opened!, "kind = 'file' AND value->>'path' = $1 AND value->>'repository' = $2", [CHANGED, TRAINING]);
    expect(filePage.length).toBe(1);
    expect(pages).not.toContain(filePage[0]!);
    // A repository page stands announced only where the pages stage's units moved one: none here.
    expect(pages.filter((id) => id.startsWith('repository:'))).toEqual([]);
    expect(pages.filter((id) => id.startsWith('document:'))).toEqual([]);
  }, 900_000);
});
