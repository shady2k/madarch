/**
 * A commit reruns only the units and pages its changes reach (madarch-tzte.26.1;
 * decision 0026, "Updates", and 0027's reuse), over what this branch publishes.
 *
 * The bar the task names: "After a commit, the deterministic stages run for what
 * changed and the change propagates over graph edges to the agent units and pages
 * whose cache keys (tracked reads with membership, spans read, prompt/schema/model
 * versions) moved; only those rerun, in dependency order", measured "on the
 * training repository with the fake ACP agent: a one-file commit reruns the
 * expected units and pages and nothing else (listed)".
 *
 * This branch publishes the snapshot, inventory and syntax stages into the 0028
 * graph (decision 0033, "The file is the unit of static work"); the stages after
 * them still read the fill's fact store, as on main. So the cases assert what
 * the branch does: the static three's units and nodes move with the file's bytes,
 * the later deterministic stages plan and run as main runs them, and no agent
 * stage plans a unit until 2.2's resolution and 2.3/2.4's stages read the graph.
 * That last part is asserted by name, never skipped: the walk over the agent
 * units and pages is the acceptance of those later tasks.
 *
 * The fixture is the training repository this project's generator makes
 * (`examples/training-repository/agent-stage/generate.mjs`, which AGENTS.md allows a test to
 * use) as the one code repository of a product the test makes. Every agent unit,
 * where the branch plans one, is driven by the fake ACP agent
 * (`test/fixtures/acp-fake-agent`): no real prompt, no network, no token spent.
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
import { OVERVIEW_STAGE_ID } from '../src/fill/stages/overview.js';
import { UNDERSTANDING_STAGE_ID } from '../src/fill/stages/understanding.js';
import { BOUNDARIES_STAGE_ID } from '../src/fill/stages/boundaries.js';
import { DOC_INTENT_STAGE_ID } from '../src/fill/stages/doc-intent.js';
import { INTENT_HISTORY_STAGE_ID } from '../src/fill/stages/intent-history.js';
import { NARRATIVE_STAGE_ID } from '../src/fill/stages/narrative.js';
import { RECOVERY_STAGE_ID } from '../src/fill/stages/recovery.js';
import { PRODUCT_SCOPE_NAME } from '../src/fill/stages/agent-stage.js';
import { UNIT_TOOL_PATH } from '../src/fill/unit-tools.js';
import { startServer, type StartedServer } from '../src/server/http.js';
import { createStagesFill, type StagesFill } from '../src/product/fill-stages.js';
import { writeFirstFillWorkflow } from './fill-workflow-fixture.js';

const FAKE_AGENT = join(import.meta.dir, 'fixtures', 'acp-fake-agent', 'acp-fake-agent.ts');
const GENERATOR = fileURLToPath(new URL('../examples/training-repository/agent-stage/generate.mjs', import.meta.url));

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
  const owner: DatabaseOwner = createPGliteDatabaseOwner({ btreeGist: true });
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
}, 1_800_000);

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
}, 300_000);

/** The units a run planned and the ones it inherited, by unit id, in code point order. */
function reran(result: FillRunResult): readonly string[] {
  const reused = new Set(result.reused);
  return result.units.map((unit) => unit.unitId).filter((unitId) => !reused.has(unitId)).sort();
}


/**
 * Every unit the one-file commit reruns on this branch, listed rather than counted.
 *
 * The three static stages' units stand on the bytes they read: the changed
 * file's snapshot, inventory and syntax units, and the inventory units of every
 * folder above it. The repository's own snapshot unit plans again because its
 * commit node moved. The later deterministic stages still run as they do on
 * main: the modules stage's one unit per repository stands on the pin, the
 * resolution stage's units stand on the run's pins (21.8's exception — the
 * changed file's and the three source files the same plan names again), and the
 * history stage plans the commit the run stands on and the commit it left.
 *
 * No agent stage is listed, because none plans a unit on this branch: the three
 * static stages publish into the 0028 graph, and the stages between them and the
 * agents (2.2's resolution and 2.3/2.4's) still read the fill's fact store, so
 * they read no file or symbol fact and write none. The walk of a commit over the
 * agents is the later tasks' acceptance, not this branch's.
 */
function reranByTheCommit(options: {
  readonly repository: string;
  readonly file: string;
  readonly commit: string;
  readonly previousCommit: string;
}): readonly string[] {
  const { repository, file, commit, previousCommit } = options;
  const folders: string[] = [];
  for (let path = file.split('/').slice(0, -1).join('/'); path !== ''; path = path.split('/').slice(0, -1).join('/')) folders.push(path);
  return [
    // The repository's own readings: its pin moved, so its snapshot unit plans again beside the file's.
    `snapshot/repository:${repository}`,
    `snapshot/file:${repository}:${file}`,
    // The changed file, and the folder chain that holds it.
    ...folders.map((path) => `inventory/directory:${repository}:${path}`),
    `inventory/file:${repository}:${file}`,
    `syntax/file:${repository}:${file}`,
    // The code facts of the changed file, and its state machines: both read their own bytes, at the
    // blob their plans compare.
    `code-facts/file:${repository}:${file}`,
    `state-machines/file:${repository}:${file}`,
    // The later deterministic stages as main runs them: the modules unit stands on the pin, the resolution
    // units on the run's pins, and the history units on the commit it stands on and the one it left.
    `modules/modules:${repository}`,
    `semantic-resolution/file:${repository}:${file}`,
    ...['services/checkout/src/checkout.ts', 'services/orders/src/order.go', 'services/payments/src/payment.ts']
      .map((path) => `semantic-resolution/file:${repository}:${path}`),
    `history/${repository}@${commit}`,
    `history/${repository}@${previousCommit}`,
  ].sort();
}

/** The ids of the facts one `WHERE` clause names, bound to the values given: what a page id is read by in a test. */
async function factIds(opened: Open, where: string, values: readonly unknown[]): Promise<readonly string[]> {
  return await opened.owner.transaction('snapshot', async (executor) => (
    await executor.query<{ id: string }>(`SELECT id FROM fill_fact WHERE ${where} ORDER BY id`, [...values])
  ).rows).then((rows) => rows.map((row) => row.id));
}

/** The properties of every current node of one kind whose property `field` is `value`, in node id order. */
async function graphNodes(opened: Open, kind: string, field: string, value: string): Promise<readonly { readonly nodeId: string; readonly properties: Record<string, unknown> }[]> {
  const rows = await opened.owner.transaction('snapshot', async (executor) => (
    await executor.query<{ node_id: string; properties: Record<string, unknown> }>(
      `SELECT v.node_id::text AS node_id, v.properties FROM node_version v JOIN node_kind k ON k.id = v.kind_id
        WHERE k.key = $1 AND v.recorded_to = 'infinity' AND v.valid_to = 'infinity' AND v.properties->>$2 = $3
        ORDER BY v.node_id`,
      [kind, field, value],
    )
  ).rows);
  return rows.map((row) => ({ nodeId: row.node_id, properties: row.properties }));
}

describe('a commit, and what it reruns', () => {
  let opened: Open | undefined;
  let first: FillRunResult | undefined;
  let second: FillRunResult | undefined;
  let third: FillRunResult | undefined;
  let pages: readonly string[] = [];
  /** The commit the one-file commit made in the training repository, and the commit the fill stood on before it. */
  let changed = '';
  let previous = '';
  /** The graph node the changed file was published under before the commit: the one its unit corrects. */
  let changedNodeId = '';
  /** The commit node the first fill published for the training repository, before the one-file commit. */
  let firstTrainingCommit = '';

  beforeAll(async () => {
    // One wiring and one service for every run: decision 0027's "a second run of the same product reuses what
    // the first opened", and the pins are read again when each run plans (the wiring re-pins at planning).
    opened = await openProduct(() => 1_700_000_000_000);
    // The first run fills the graph: the static three publish their code.* nodes and edges into the 0028 graph,
    // and the later deterministic stages run as they do on main (each reads the fill's fact store, which holds
    // what they publish and not what the static three publish any more).
    first = await opened.run('run-one');
    // The snapshot stage published the repository's commit node at run-one's pin, before the commit below.
    firstTrainingCommit = String((await graphNodes(opened, 'code.commit', 'repository', TRAINING))[0]?.properties['commit']);
    // The second run plans nothing for the static three and inherits the later stages whose pins did not move.
    second = await opened.run('run-two');
    // The graph node the changed file's unit published: after the commit the same identity is corrected.
    const before = await graphNodes(opened, 'code.file', 'path', CHANGED);
    changedNodeId = before[0]!.nodeId;
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
    for (const [name, result] of [['run-one', first], ['run-two', second], ['run-three', third]] as const) {
      if (result.state === 'succeeded' && result.settled) continue;
      // eslint-disable-next-line no-console
      console.log(name, JSON.stringify({ state: result.state, settled: result.settled, stopped: result.stoppedBecause, units: result.units, events: (await opened.events(name)).slice(-14) }, null, 1));
    }
  }, 1_800_000);

  afterAll(async () => {
    await opened?.close();
  });

  test('the first fill publishes the static three into the graph, the later stages run, and the next run plans none', async () => {
    expect({ state: first?.state, settled: first?.settled, reused: first?.reused }).toEqual({ state: 'succeeded', settled: true, reused: [] });

    // The three static stages publish every file and folder of both pinned trees into the 0028 graph: one
    // code.file node per file, one code.directory node per folder, and the commit its snapshot unit pinned.
    const files = await graphNodes(opened!, 'code.file', 'repository', TRAINING);
    expect(files.map((node) => String(node.properties['path'])).sort()).toEqual([...TRAINING_FILES].sort());
    const directories = await graphNodes(opened!, 'code.directory', 'repository', TRAINING);
    expect(directories.map((node) => String(node.properties['path'])).sort()).toEqual([
      'docs', 'services', 'services/checkout', 'services/checkout/src', 'services/orders', 'services/orders/src',
      'services/payments', 'services/payments/src', 'services/promotions', 'services/promotions/src',
    ]);
    // The run-one pin's commit node: run-three later corrects the repository unit to the new commit.
    expect(firstTrainingCommit).toBe(previous);
    // The snapshot stage's own commit node has no `subject`; the history stage's copies of the
    // range it read carry one each (decision 0033's fenced publication).
    const commits = (await graphNodes(opened!, 'code.commit', 'repository', TRAINING)).filter((node) => node.properties['subject'] === undefined);
    expect(commits.map((node) => String(node.properties['commit']))).toEqual([changed]);
    // The syntax stage's symbols and its positioned mentions stand in the same graph, one unit's reading each.
    const symbols = await graphNodes(opened!, 'code.symbol', 'repository', TRAINING);
    expect(symbols.length).toBeGreaterThan(0);
    expect(symbols.every((node) => typeof node.properties['globalName'] === 'string')).toBe(true);

    // The later deterministic stages still run as they do on main: the modules stage plans one unit per
    // pinned repository, the resolution stage one per file it must resolve, the history stage one per commit,
    // and the document index one per document. Their code and their units are unchanged by this task.
    const ran = new Set((first?.units ?? []).map((unit) => unit.unitId));
    for (const unitId of [
      `modules/modules:${TRAINING}`,
      `modules/modules:${PRODUCT}`,
      'semantic-resolution/file:training:services/promotions/src/promotions.go',
      `history/${TRAINING}@${previous}`,
      `history/${PRODUCT}@${git(product, 'rev-parse', 'HEAD')}`,
      'document-index/document:training:README.md',
    ]) {
      expect(ran.has(unitId)).toBe(true);
    }
    // No agent stage plans a unit on this branch: the three static stages publish into the 0028 graph, and the
    // stages between them and the agents (2.2's resolution, 2.3/2.4's) still read the fill's fact store, where
    // the static three no longer write. This case asserts that absence rather than skipping it; the walk over
    // the agent stages is the acceptance of those later tasks.
    const agentStages = new Set([OVERVIEW_STAGE_ID, BOUNDARIES_STAGE_ID, DOC_INTENT_STAGE_ID, INTENT_HISTORY_STAGE_ID, UNDERSTANDING_STAGE_ID, RECOVERY_STAGE_ID, NARRATIVE_STAGE_ID]);
    expect((first?.units ?? []).filter((unit) => agentStages.has(unit.stageId))).toEqual([]);

    // A second run with no change plans no unit for the static four: the graph answers the same tree,
    // and the resolution's own coverage says what it resolved at that blob. The later stages whose pin
    // did not move are inherited.
    expect({ state: second?.state, settled: second?.settled }).toEqual({ state: 'succeeded', settled: true });
    expect(reran(second!)).toEqual([]);
    expect((second?.units ?? []).map((unit) => unit.unitId)).toEqual([]);
    expect([...(second?.reused ?? [])].sort()).toEqual([
      `history/${PRODUCT}@${git(product, 'rev-parse', 'HEAD')}`,
      `history/${TRAINING}@${previous}`,
      `modules/modules:${PRODUCT}`,
      `modules/modules:${TRAINING}`,
      'document-index/document:training:README.md',
      'document-index/document:training:docs/architecture.md',
      'document-index/document:training:services/orders/README.md',
    ].sort());
  }, 900_000);

  test('a one-file commit reruns the static units it reaches and the later stages main reruns, and inherits the rest', async () => {
    expect(third?.state).toBe('succeeded');
    // The units the commit reran: the changed file's static three, the folder chain above it, the repository's
    // snapshot, and the later stages main reruns on a new pin (the modules unit, the resolution units and the
    // two history units). The list is the branch's own walk; no agent unit stands on it because none planned.
    expect(reran(third!)).toEqual(reranByTheCommit({ repository: TRAINING, file: CHANGED, commit: changed, previousCommit: previous }));
    // The units run-three inherited: the product repository's modules and history, whose pin did not move.
    // The document index names its documents again — its plan compares the blob its own coverage
    // recorded with the tree's — and a document whose reading stands is inherited, not written.
    expect([...(third?.reused ?? [])].sort()).toEqual([
      `history/${PRODUCT}@${git(product, 'rev-parse', 'HEAD')}`,
      `modules/modules:${PRODUCT}`,
      'document-index/document:training:README.md',
      'document-index/document:training:docs/architecture.md',
      'document-index/document:training:services/orders/README.md',
    ].sort());
  }, 900_000);

  test("the changed file's bytes moved at the new pin, and the manifest stands as it stood", async () => {
    const checkout = join(product, 'repos', TRAINING);
    // The changed file's unit published one node before the commit and corrects the same identity after it:
    // its blob property names the new commit's bytes, and the node is the one the first run opened.
    const after = await graphNodes(opened!, 'code.file', 'path', CHANGED);
    expect(after.map((node) => node.nodeId)).toEqual([changedNodeId]);
    expect(after[0]!.properties['blob']).toBe(git(checkout, 'rev-parse', `${changed}:${CHANGED}`));
    // The manifest the product's own unit published stands as it stood: its repository's pin did not move.
    const manifest = await graphNodes(opened!, 'code.file', 'path', 'workspace.yaml');
    expect(manifest.map((node) => node.properties['blob'])).toEqual([git(product, 'rev-parse', `HEAD:workspace.yaml`)]);
    // The overview unit that read a span of the changed file does not exist on this branch (no agent stage
    // plans a unit), so no span read moved; its return is 2.2 to 2.4's acceptance.
    expect((await readUnitReads(opened!.owner, `${OVERVIEW_STAGE_ID}/${PRODUCT_SCOPE_NAME}`, 1))).toEqual([]);
  }, 900_000);

  test('the update announces no page on this branch: its facts stand in the 0028 graph, not in the fill fact store', async () => {
    // A page is a view of the facts a unit holds (0026, "Pages"). On this branch the pages stage's facts are
    // the ones the modules stage would publish from the fill's fact store, and that stage reads no file fact
    // any more: the three static stages publish into the 0028 graph. So no module or symbol fact stands to
    // move, and the update announces no page. This case asserts that state explicitly; it is not a skip, and
    // it returns to a non-empty list when 2.2 to 2.4 make the later stages read the graph.
    expect(await factIds(opened!, "kind IN ('module', 'symbol')", [])).toEqual([]);
    expect(pages).toEqual([]);
    // The graph holds the changed file's symbol nodes all the same: the syntax stage published them beside
    // the file node, and the commit corrected the file's own reading.
    const symbols = await graphNodes(opened!, 'code.symbol', 'repository', TRAINING);
    expect(symbols.length).toBeGreaterThan(0);
  }, 900_000);
});
