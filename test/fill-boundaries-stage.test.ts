/**
 * Stage 9, the module-boundary refinement, end to end on the agent-stage shape of
 * madarch-tzte.24.1 (decision 0026, "9 module-boundary refinement", "Agent input",
 * "Scale" and "Writing"; 0027's publication and split; madarch-tzte.24.2's
 * proposal field).
 *
 * A unit reads one repository's clustering — the module tree of stage 5
 * (madarch-tzte.21.7): the modules, the members stage 5 counted, the importance
 * its PageRank gave them, and the `contains` edges that hold the tree together —
 * and proposes the boundary changes the code's own reading asks for: merges,
 * splits and renames, each a `module` fact at the `inferred` layer, always
 * `proposed`, carrying the `proposal` the schema gives stage 9. Nothing accepts a
 * proposal: the modules it would replace stand beside it until a person decides.
 * Every expectation is taken from the task, the decisions and the clustering the
 * modules stage wrote — never from this stage's own code. The agent is the fake
 * ACP agent of `test/fixtures/acp-fake-agent` (no real prompt, no network, no
 * token spent), the MCP server is the real one of madarch-tzte.22.2 answering
 * through the real server route, and time passes through a seam, never a sleep.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { createFactStoreSchema, applyPublishedFacts, FACT_APPLICATION, readUnitFacts } from '../src/fill/fact-store.js';
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
  BOUNDARIES_KINDS,
  BOUNDARIES_MEMBER_ROWS,
  BOUNDARIES_MODULE_ROWS,
  BOUNDARIES_STAGE_ID,
  boundariesDeclaration,
  createBoundariesStage,
  planBoundaryUnits,
} from '../src/fill/stages/boundaries.js';
import { StageRegistry } from '../src/fill/registry.js';
import { DEFAULT_STAGE_DEFAULTS, type FillStage, type StageGraphReader } from '../src/fill/stage.js';
import { FACT_KINDS } from '../src/fill/facts.js';
import { createGitSnapshotSource, type RepositoryPin } from '../src/fill/snapshot.js';
import { createFillStateSchema, createUnit, readRunUnits } from '../src/fill/state-store.js';
import { UNIT_TOOL_PATH } from '../src/fill/unit-tools.js';
import { startServer, type StartedServer } from '../src/server/http.js';
import type { QueueService } from '../src/fill/queue.js';
import { Type } from 'typebox';

const NOW = 1_700_000_000_000;
const PRODUCT = 'fixture-product';
const RUN = 'run-2026-10-20T07:00Z';
/** The repository whose clustering the unit refines, and the neighbour one an out-of-scope proposal may name. */
const REPOSITORY = 'orders-api';
const OTHER_REPOSITORY = 'billing-api';
/** The files the pinned commits hold: two package folders the clustering splits, and a README the docs module holds. */
const CHARGE_FILE = 'packages/checkout/src/charge.ts';
const CHARGE_BODY = 'export function charge(cart) {\n  return { total: cart.total, state: "charged" };\n}\n';
const SETTLE_FILE = 'packages/payments/src/settle.ts';
const SETTLE_BODY = 'export function settle(charged) {\n  return { id: charged.id, state: "settled" };\n}\n';
const README = 'README.md';
const README_BODY = '# orders api\n\nOne checkout, one settlement.\n';
const OTHER_FILE = 'src/invoice.ts';
const OTHER_BODY = 'export function invoice(order) {\n  return { number: "INV-1" };\n}\n';
const FAKE_AGENT = join(import.meta.dir, 'fixtures', 'acp-fake-agent', 'acp-fake-agent.ts');

let root: string | undefined;
let COMMITS: Readonly<Record<string, string>> = {};

function provenance(repository: string, file: string, line: number): FactProvenance {
  return {
    source: { system: 'modules', version: '1.0.0' },
    repository: { id: repository, commit: COMMITS[repository] ?? 'a'.repeat(40) },
    place: { file: repositoryPath(file), range: { startLine: line, startColumn: 0, endLine: line, endColumn: 20 } },
  };
}

/**
 * The clustering stage 5 published for the fixture repository: three top-level
 * modules — the two packages and a cluster of the repository's own documents —
 * the `contains` tree that holds them to their files, and the neighbour
 * repository's one module, which a proposal of this repository's unit may name
 * only to be refused (madarch-tzte.24.2: a unit names the nodes of its scope).
 */
interface Graph {
  readonly repository: Fact;
  readonly checkout: Fact;
  readonly payments: Fact;
  readonly docs: Fact;
  readonly otherModule: Fact;
  facts(): readonly Fact[];
}

function fixture(): Graph {
  const repository = makeNodeFact({ kind: 'repository', value: { repository: REPOSITORY, form: 'code' }, provenance: provenance(REPOSITORY, README, 1), layer: 'extracted' });
  const chargeFile = makeNodeFact({ kind: 'file', value: { repository: REPOSITORY, path: repositoryPath(CHARGE_FILE), roles: ['source'], language: 'typescript' }, provenance: provenance(REPOSITORY, CHARGE_FILE, 1), layer: 'extracted' });
  const settleFile = makeNodeFact({ kind: 'file', value: { repository: REPOSITORY, path: repositoryPath(SETTLE_FILE), roles: ['source'], language: 'typescript' }, provenance: provenance(REPOSITORY, SETTLE_FILE, 1), layer: 'extracted' });
  const readmeFile = makeNodeFact({ kind: 'file', value: { repository: REPOSITORY, path: repositoryPath(README), roles: ['document'] }, provenance: provenance(REPOSITORY, README, 1), layer: 'extracted' });
  const checkout = makeNodeFact({ kind: 'module', value: { repository: REPOSITORY, name: 'checkout', seed: 'package', members: 4, importance: 0.5 }, provenance: provenance(REPOSITORY, CHARGE_FILE, 1), layer: 'extracted' });
  const payments = makeNodeFact({ kind: 'module', value: { repository: REPOSITORY, name: 'payments', seed: 'package', members: 3, importance: 0.3 }, provenance: provenance(REPOSITORY, SETTLE_FILE, 1), layer: 'extracted' });
  const docs = makeNodeFact({ kind: 'module', value: { repository: REPOSITORY, name: 'docs', seed: 'cluster', members: 1, importance: 0.2 }, provenance: provenance(REPOSITORY, README, 1), layer: 'extracted' });
  const otherRepository = makeNodeFact({ kind: 'repository', value: { repository: OTHER_REPOSITORY, form: 'code' }, provenance: provenance(OTHER_REPOSITORY, OTHER_FILE, 1), layer: 'extracted' });
  const otherFile = makeNodeFact({ kind: 'file', value: { repository: OTHER_REPOSITORY, path: repositoryPath(OTHER_FILE), roles: ['source'], language: 'typescript' }, provenance: provenance(OTHER_REPOSITORY, OTHER_FILE, 1), layer: 'extracted' });
  const otherModule = makeNodeFact({ kind: 'module', value: { repository: OTHER_REPOSITORY, name: 'invoicing', seed: 'cluster', members: 2, importance: 1 }, provenance: provenance(OTHER_REPOSITORY, OTHER_FILE, 1), layer: 'extracted' });
  return {
    repository,
    checkout,
    payments,
    docs,
    otherModule,
    facts: () => [
      repository,
      otherRepository,
      chargeFile,
      settleFile,
      readmeFile,
      otherFile,
      checkout,
      payments,
      docs,
      otherModule,
      // The tree the modules stage wrote: the repository holds its top-level modules, each module its own files, and
      // the neighbour repository its own module and file.
      makeEdgeFact({ kind: 'contains', value: { from: repository.id, to: checkout.id }, provenance: provenance(REPOSITORY, CHARGE_FILE, 1), layer: 'extracted' }),
      makeEdgeFact({ kind: 'contains', value: { from: repository.id, to: payments.id }, provenance: provenance(REPOSITORY, SETTLE_FILE, 1), layer: 'extracted' }),
      makeEdgeFact({ kind: 'contains', value: { from: repository.id, to: docs.id }, provenance: provenance(REPOSITORY, README, 1), layer: 'extracted' }),
      makeEdgeFact({ kind: 'contains', value: { from: checkout.id, to: chargeFile.id }, provenance: provenance(REPOSITORY, CHARGE_FILE, 1), layer: 'extracted' }),
      makeEdgeFact({ kind: 'contains', value: { from: payments.id, to: settleFile.id }, provenance: provenance(REPOSITORY, SETTLE_FILE, 1), layer: 'extracted' }),
      makeEdgeFact({ kind: 'contains', value: { from: docs.id, to: readmeFile.id }, provenance: provenance(REPOSITORY, README, 1), layer: 'extracted' }),
      makeEdgeFact({ kind: 'contains', value: { from: otherRepository.id, to: otherModule.id }, provenance: provenance(OTHER_REPOSITORY, OTHER_FILE, 1), layer: 'extracted' }),
      makeEdgeFact({ kind: 'contains', value: { from: otherModule.id, to: otherFile.id }, provenance: provenance(OTHER_REPOSITORY, OTHER_FILE, 1), layer: 'extracted' }),
    ],
  };
}

/**
 * The stand-in for the deterministic stages this fixture publishes the facts of: it
 * declares the capabilities stage 9 requires (`repository`, `module`) and the ones
 * its sections read beside them (`file`, `contains`), so the derived stage graph
 * knows where its inputs come from, and it plans no unit, because the graph is
 * already published.
 */
function structureStage(): FillStage {
  return {
    id: 'structure',
    version: 1,
    consumes: { required: [], optional: [] },
    produces: ['repository', 'file', 'module', 'contains'].map((kind) => ({ kind, schemaVersion: FACT_KINDS[kind as 'module'].version, scope: 'repository' as const })),
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
    writes: graph.facts().map((fact) => ({ kind: 'fact' as const, evidence: `${REPOSITORY}@${COMMITS[REPOSITORY] ?? ''}`, value: fact })),
  }));

  const pins: readonly RepositoryPin[] = [
    { id: REPOSITORY, form: 'code', root: join(root!, REPOSITORY), commit: COMMITS[REPOSITORY]! },
    { id: OTHER_REPOSITORY, form: 'code', root: join(root!, OTHER_REPOSITORY), commit: COMMITS[OTHER_REPOSITORY]! },
  ];
  const snapshots = createGitSnapshotSource(() => pins);
  const snapshot: RunSnapshot = { repository: 'example.invalid/acme/shop', defaultBranch: 'main', commit: COMMITS[REPOSITORY]!, registryHash: 'sha256:registry' };
  const wiring: ProductFillWiring = {
    snapshot: () => snapshot,
    configuration: () => undefined,
    graph: () => createFactGraphReader({ database: owner, snapshot: snapshots }),
    inputs: () => ({}),
    source: () => snapshots,
  };
  const registry = new StageRegistry()
    .register(structureStage())
    .register(createBoundariesStage({
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
  root = mkdtempSync(join(tmpdir(), 'madarch-boundaries-stage-'));
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
  commits[REPOSITORY] = make(REPOSITORY, { [CHARGE_FILE]: CHARGE_BODY, [SETTLE_FILE]: SETTLE_BODY, [README]: README_BODY });
  commits[OTHER_REPOSITORY] = make(OTHER_REPOSITORY, { [OTHER_FILE]: OTHER_BODY });
  COMMITS = commits;
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

/**
 * Plans the run and returns the unit of one repository — its clustering. The
 * fixture pins two repositories, so the run plans two units and the scheduler
 * admits them one at a time in its own priority; every script answers the
 * neighbour repository's unit (`byPrompt`), so whichever runs first publishes and
 * the next pass admits the unit under test.
 */
async function planAndAdmit(opened: World, repository: string): Promise<{ unitId: string; generation: number }> {
  const started = await startRun(opened.orchestrator, { runId: RUN });
  expect(started.ok).toBe(true);
  const planned = await planRun(opened.orchestrator, { runId: RUN });
  if (planned.outcome !== 'planned') throw new Error(`the run was not planned: ${JSON.stringify(planned)}`);
  // 0026's stage 9 plans the clusterings: one unit per repository that holds modules.
  expect(planned.units.map((unit) => unit.stageId)).toEqual([BOUNDARIES_STAGE_ID, BOUNDARIES_STAGE_ID]);
  const mine = planned.units.find((unit) => unit.scope === repository);
  if (mine === undefined) throw new Error(`the run planned no unit of ${repository}: ${JSON.stringify(planned.units)}`);
  return { unitId: mine.unitId, generation: mine.generation };
}

/** Throws with the unit's recorded draft, so a result the test did not expect says what the unit wrote. */
async function expectResult(opened: World, unit: { readonly unitId: string; readonly generation: number }, worked: Awaited<ReturnType<typeof runUnit>>, want: string): Promise<void> {
  if (worked.result === want) return;
  const draft = await readUnitDraft(opened.owner, unit.unitId, unit.generation);
  const rows = (draft?.writes ?? []).map((write) => ({ kind: write.kind, fact: (write.value as { kind?: string; value?: unknown }).kind, value: (write.value as { value?: unknown }).value }));
  throw new Error(`the unit ended ${worked.result}, not ${want}; its draft holds ${JSON.stringify(rows)}`);
}

/** Runs whole units until the named one is claimed, and returns its result: the scheduler admits one unit a pass. */
async function runUnit(opened: World, unitId: string): Promise<Awaited<ReturnType<typeof workOnce>>> {
  for (let pass = 0; pass < 6; pass += 1) {
    await schedulerPass(opened.orchestrator, { runId: RUN });
    const worked = await workOnce(opened.orchestrator, { worker: 'w1' });
    if (!worked.claimed) continue;
    if (worked.unitId === unitId) return worked;
  }
  throw new Error(`the unit ${unitId} was never claimed`);
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

/** One boundary proposal the fake agent asserts through `assert_fact`, cited to the bytes the boundary stands on. */
function proposalStep(options: {
  readonly name: string;
  readonly change: 'merge' | 'split' | 'rename';
  readonly replaces: readonly string[];
  readonly parent?: string;
  readonly members?: number;
  readonly repository?: string;
  readonly file: string;
  readonly line: number;
}): unknown {
  return {
    call: {
      tool: 'assert_fact',
      arguments: {
        kind: 'module',
        value: {
          repository: options.repository ?? REPOSITORY,
          name: options.name,
          ...(options.parent === undefined ? {} : { parent: options.parent }),
          seed: 'cluster',
          ...(options.members === undefined ? {} : { members: options.members }),
          proposal: { change: options.change, replaces: [...options.replaces].sort() },
        },
        place: { repository: options.repository ?? REPOSITORY, file: options.file, startLine: options.line, endLine: options.line },
      },
    },
  };
}

/** One boundary question the fake agent raises through `raise_question`, citing the clustering that raised it. */
function questionStep(options: { readonly prompt: string; readonly about: string; readonly file: string; readonly line: number }): unknown {
  return {
    call: {
      tool: 'raise_question',
      arguments: {
        type: 'assumption-check',
        prompt: options.prompt,
        about: options.about,
        place: { repository: REPOSITORY, file: options.file, startLine: options.line, endLine: options.line },
      },
    },
  };
}

describe('stage 9, the module-boundary refinement', () => {
  test('one unit of a repository\'s clustering proposes a merge and a rename through the checked writes, and publishes them proposed with its coverage', async () => {
    const ids = fixture();
    const opened = await openWorld({
      script: {
        // The neighbour repository's unit is answered by its own match, so whichever unit the scheduler admits first
        // publishes and the next pass admits the unit under test.
        byPrompt: [{ matches: `"scope": "${OTHER_REPOSITORY}"`, steps: [{ answer: { status: 'done', covered: ['src'], remaining: [], summary: 'the invoicing module was read' } }] }],
        steps: [
          { say: 'reading the clustering' },
          // The merge the two packages ask for: one proposed module that would replace both, cited to the file whose
          // import ties them.
          proposalStep({ name: 'checkout-payments', change: 'merge', replaces: [ids.checkout.id, ids.payments.id], members: 7, file: CHARGE_FILE, line: 1 }),
          // A rename of the docs cluster, cited to the README it holds.
          proposalStep({ name: 'documents', change: 'rename', replaces: [ids.docs.id], file: README, line: 1 }),
          // A split of the checkout module: one proposed module per part, each naming the module it would leave,
          // cited to the file whose imports cut it apart.
          proposalStep({ name: 'authorization', change: 'split', replaces: [ids.checkout.id], parent: ids.checkout.id, members: 2, file: CHARGE_FILE, line: 1 }),
          // The question the clustering cannot settle: the docs module's boundary.
          questionStep({ prompt: 'The docs module holds one file — is it a boundary of its own?', about: ids.docs.id, file: README, line: 1 }),
          { answer: { status: 'done', covered: ['packages/checkout/src', 'packages/payments/src'], remaining: [], summary: 'checkout and payments are one boundary; the docs cluster is named wrong' } },
        ],
      },
    });
    try {
      const unit = await planAndAdmit(opened, REPOSITORY);
      // The unit's id is the repository fact's own id, under the stage's own prefix: a node of the graph, never a run
      // (0026, "Updates").
      expect(unit.unitId).toBe(`${BOUNDARIES_STAGE_ID}/${ids.repository.id}`);
      const worked = await runUnit(opened, unit.unitId);
      await expectResult(opened, unit, worked, 'published');

      // The prompt the agent received: the stage's own fixed part, the clustering packet, within 0026's 20K. The
      // neighbour repository's unit answers on its own single prompt and is not counted here.
      const sent = prompts(opened).filter((prompt) => prompt.includes(REPOSITORY));
      expect(sent.length).toBe(1);
      const prompt = sent[0]!;
      expect(prompt).toContain('You are one unit of madarch\'s fill that proposes how a repository\'s module boundaries should change');
      // The level of self-filling's outcome 4 this stage's statements stand at: what the code means, assumed.
      expect(prompt).toContain('What you write is meaning');
      expect(prompt).toContain('Facts this unit may write: coverage, module, question — and nothing else');
      expect(estimateTokens(prompt, DEFAULT_GRAPH_READ_LIMITS)).toBeLessThanOrEqual(20_000);
      // The packet is the last JSON object of the prompt, after the fixed part.
      const packet = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n{') + 2)) as Record<string, unknown>;
      // The shape's own sections of the scope, then the clustering this stage declares, then what it may write.
      expect(Object.keys(packet)).toEqual(['unit', 'place', 'scope', 'members', 'entryPoints', 'data', 'relations', 'history', 'clustering', 'moduleMembers', 'writes', 'marker']);
      expect((packet['unit'] as { id: string; scope: string }).scope).toBe(REPOSITORY);
      expect((packet['scope'] as { id: string; kind: string }).id).toBe(ids.repository.id);
      // The clustering: the modules with the members stage 5 counted and the importance its PageRank gave them, most
      // important first, each with the folder its own files stand in.
      expect(packet['clustering']).toEqual([
        { id: ids.checkout.id, name: 'checkout', seed: 'package', members: 4, folder: 'packages/checkout/src', importance: 0.5 },
        { id: ids.payments.id, name: 'payments', seed: 'package', members: 3, folder: 'packages/payments/src', importance: 0.3 },
        { id: ids.docs.id, name: 'docs', seed: 'cluster', members: 1, importance: 0.2 },
      ]);
      // The tree: each module's own files at their paths, in the section's own order — by module, then kind, then
      // path — read here as rows so the digest ids the fixtures cannot name stand beside the ones it can.
      const tree = packet['moduleMembers'] as { module: string; member: string; kind: string; path?: string }[];
      expect([...tree].map((row) => [row.module, row.kind, row.path]).sort()).toEqual([
        [ids.checkout.id, 'file', CHARGE_FILE],
        [ids.docs.id, 'file', README],
        [ids.payments.id, 'file', SETTLE_FILE],
      ].sort());
      expect(packet['marker']).toBeNull();

      // What it published: the merge, the rename, the split, the question, and the coverage of the clustering.
      const published = await publishedFacts(opened, unit.unitId);
      expect(published.map((fact) => fact.kind).sort()).toEqual(['coverage', 'module', 'module', 'module', 'question']);
      const proposals = published.filter((fact) => fact.kind === 'module');
      // 0005's layer and status for an agent's reading: inferred, and proposed until a person accepts it — accepted by
      // nothing automatically, and the modules it would replace stand beside it untouched.
      for (const proposal of proposals) {
        expect(proposal.layer).toBe('inferred');
        expect(proposal.status).toBe('proposed');
        expect(proposal.schemaVersion).toBe(FACT_KINDS['module'].version);
      }
      const merge = proposals.find((fact) => (fact.value as { proposal?: { change?: string } }).proposal?.change === 'merge');
      expect(merge).toBeDefined();
      const mergeValue = merge!.value as unknown as { name: string; proposal: { replaces: readonly string[] } };
      expect(mergeValue.name).toBe('checkout-payments');
      expect(mergeValue.proposal.replaces).toEqual([ids.checkout.id, ids.payments.id].sort());
      expect((merge!.value as { seed: string }).seed).toBe('cluster');
      // The evidence is the file the boundary stands on, at the pinned commit.
      expect(merge!.provenance.place?.file).toBe(repositoryPath(CHARGE_FILE));
      expect(merge!.provenance.repository).toEqual({ id: REPOSITORY, commit: COMMITS[REPOSITORY]! });
      const rename = proposals.find((fact) => (fact.value as { proposal?: { change?: string } }).proposal?.change === 'rename');
      expect((rename!.value as unknown as { proposal: { replaces: readonly string[] } }).proposal.replaces).toEqual([ids.docs.id]);
      // The split's part nests in the module it would leave: its parent is that module's own id, and it replaces
      // it — the parts of one split each stand in the module they cut out.
      const split = proposals.find((fact) => (fact.value as { proposal?: { change?: string } }).proposal?.change === 'split');
      expect(split).toBeDefined();
      expect((split!.value as { name: string; parent?: string }).name).toBe('authorization');
      expect((split!.value as { parent?: string }).parent).toBe(ids.checkout.id);
      expect((split!.value as unknown as { proposal: { replaces: readonly string[] } }).proposal.replaces).toEqual([ids.checkout.id]);
      const question = published.find((fact) => fact.kind === 'question')!;
      expect((question.value as { type: string }).type).toBe('assumption-check');
      expect((question.value as { repository: string }).repository).toBe(REPOSITORY);
      const coverage = published.find((fact) => fact.kind === 'coverage')!;
      // The coverage names what of the clustering was read, and its scope is the unit's own scope node — the
      // repository fact's own id. The two folders the answer named are its read list.
      // The coverage's read list holds every place the unit covered: the two folders the answer named. The docs
      // module is no place — its one file stands in no folder of its own, so its scope would be the unit's own — and
      // it is read through the packet's clustering, inside the unit's own scope, like every other module of it.
      expect(coverage.value).toEqual({ repository: REPOSITORY, scope: ids.repository.id, complete: true, read: ['packages/checkout/src', 'packages/payments/src'], unread: [] });
      expect((await readRunUnits(opened.owner, RUN)).every((record) => record.state === 'published')).toBe(true);
    } finally {
      await opened.close();
    }
  }, 180_000);

  test('a proposal that names a module outside the unit\'s scope is refused when it is made, and the coverage is what publishes', async () => {
    const ids = fixture();
    const opened = await openWorld({
      script: {
        byPrompt: [{ matches: `"scope": "${OTHER_REPOSITORY}"`, steps: [{ answer: { status: 'done', covered: ['src'], remaining: [], summary: 'the invoicing module was read' } }] }],
        steps: [
          { say: 'writing' },
          // A merge whose replaced modules name the neighbour repository's clustering: the checked write refuses it at
          // once (0026, "Writing"), and nothing of it lands in the unit's draft set. The refusal itself, which names
          // both repositories, is held by `test/fill-checked-writes.test.ts`.
          proposalStep({ name: 'everything', change: 'merge', replaces: [ids.checkout.id, ids.otherModule.id], file: CHARGE_FILE, line: 1 }),
          // A proposal named after a module the clustering holds digests to that module's own id — the identity is
          // the repository, the parent and the name — and the write refuses it too: the proposal would overwrite the
          // extracted fact it asked to refine, and the record's guarantee is that it stands beside, never over.
          proposalStep({ name: 'checkout', change: 'merge', replaces: [ids.payments.id], file: CHARGE_FILE, line: 1 }),
          { answer: { status: 'done', covered: ['packages/checkout/src', 'packages/payments/src'], remaining: [], summary: 'nothing was proposed' } },
        ],
      },
    });
    try {
      const unit = await planAndAdmit(opened, REPOSITORY);
      const worked = await runUnit(opened, unit.unitId);
      await expectResult(opened, unit, worked, 'published');
      const published = await publishedFacts(opened, unit.unitId);
      // Nothing of the refused write stands, not even in part: the unit published its coverage alone and carried on.
      expect(published.filter((fact) => fact.kind === 'module' || fact.kind === 'question')).toEqual([]);
      expect(published.map((fact) => fact.kind)).toEqual(['coverage']);
    } finally {
      await opened.close();
    }
  }, 180_000);

  test('a malformed answer is refused by the field it got wrong, the unit is asked again with its folders, and the second answer publishes', async () => {
    const opened = await openWorld({
      script: {
        // The first turn's object has no `status`: the answer schema names the field it lacks, and the unit is asked
        // again — inside 0026's turn limit, not as a failure. The turn that answers is the one that matches the nudge.
        byPrompt: [
          { matches: `"scope": "${OTHER_REPOSITORY}"`, steps: [{ answer: { status: 'done', covered: ['src'], remaining: [], summary: 'the invoicing module was read' } }] },
          { matches: 'That was not the answer', steps: [
            { answer: { status: 'done', covered: ['packages/checkout/src', 'packages/payments/src'], remaining: [], summary: 'the clustering was read' } },
          ] },
        ],
        steps: [
          { say: 'reading the clustering' },
          { say: '{"covered":[]}' },
          { end: {} },
        ],
      },
    });
    try {
      const unit = await planAndAdmit(opened, REPOSITORY);
      const worked = await runUnit(opened, unit.unitId);
      await expectResult(opened, unit, worked, 'published');
      const sent = prompts(opened).filter((prompt) => prompt.includes(REPOSITORY));
      expect(sent.length).toBe(2);
      // The nudge names the field the answer lacked, the shape, and the places of the scope — the folders the
      // clustering's own modules stand at, and the one module whose files name no folder, named by itself — so the
      // unit can name them without reading the packet again.
      expect(sent[1]).toContain('That was not the answer this unit contract asks for.');
      expect(sent[1]).toContain('the answer names no `status`');
      expect(sent[1]).toContain('{"status":"done"|"partial"');
      expect(sent[1]).toContain(`The places of ${REPOSITORY} are: packages/checkout/src, packages/payments/src.`);
      expect((await publishedFacts(opened, unit.unitId)).length).toBe(1);
    } finally {
      await opened.close();
    }
  }, 180_000);

  test('a unit that never answers is stopped at 0026\'s turn limit and splits its clustering into its top-level modules', async () => {
    const opened = await openWorld({
      script: {
        // The children of the split run on the same stage, and each reads the one module folder its scope names. A
        // child's own unit scope is a text its parent's packet never holds, so each child is matched by it.
        byPrompt: [
          { matches: `"scope": "${OTHER_REPOSITORY}"`, steps: [{ answer: { status: 'done', covered: ['src'], remaining: [], summary: 'the invoicing module was read' } }] },
          { matches: `"scope": "${REPOSITORY}:packages/checkout/src"`, steps: [{ answer: { status: 'done', covered: ['packages/checkout/src'], remaining: [], summary: 'the checkout module was read' } }] },
          { matches: `"scope": "${REPOSITORY}:packages/payments/src"`, steps: [{ answer: { status: 'done', covered: ['packages/payments/src'], remaining: [], summary: 'the payments module was read' } }] },
        ],
        steps: [{ say: 'still reading' }, { end: {} }],
      },
      limits: { leaseMs: 86_400_000 },
    });
    try {
      const ids = fixture();
      const unit = await planAndAdmit(opened, REPOSITORY);
      const worked = await runUnit(opened, unit.unitId);
      expect(worked.result).toBe('split');
      // 0026: "at most ~30 turns". The unit was asked once per turn and stopped at the thirtieth (the neighbour
      // repository's unit answered on its own first turn and is not counted here).
      expect(prompts(opened).filter((prompt) => prompt.includes(REPOSITORY)).length).toBe(30);
      const stopped = (await readProgress(opened.owner, RUN)).map((event) => event.summary).filter((summary) => summary.includes('stopped at its turn limit'));
      expect(stopped.length).toBe(1);
      // Its partial draft keeps the coverage: no folder was read, and each is a `budget` gap. The docs module names no
      // folder of its own, so it is no place at all — its scope would be the unit's own — and the split names no unit
      // for it: it stays inside the unit's own scope, read through the packet's clustering.
      const draft = await readUnitDraft(opened.owner, unit.unitId, unit.generation);
      const coverages = (draft?.writes ?? []).map((write) => write.value as { kind: string; value: { repository: string; scope: string; complete: boolean; read: string[]; unread: { what: string; reason: string }[] } });
      expect(coverages.map((coverage) => coverage.kind)).toEqual(['coverage']);
      expect(coverages[0]!.value).toEqual({
        repository: REPOSITORY,
        scope: ids.repository.id,
        complete: false,
        read: [],
        unread: [
          { what: 'packages/checkout/src', reason: 'budget' },
          { what: 'packages/payments/src', reason: 'budget' },
        ],
      });
      // 0026's hierarchy: the split names the folders the top-level modules stand at, one child each, named by their
      // module facts. The docs module is no child: it is no place of the unit at all.
      const children = (await readRunUnits(opened.owner, RUN)).filter((record) => record.state === 'planned');
      const scopes = await Promise.all(children.map(async (record) => (await readUnitPlan(opened.owner, record.unitId, record.generation))?.scope));
      expect(scopes.sort()).toEqual([`${REPOSITORY}:packages/checkout/src`, `${REPOSITORY}:packages/payments/src`].sort((left, right) => left < right ? -1 : 1));
      expect(children.every((record) => record.unitId.startsWith(`${BOUNDARIES_STAGE_ID}/`))).toBe(true);

      // A child is a unit of one module's folder, and it runs: its packet's clustering is the module alone, and it
      // publishes the coverage of the folder it read.
      const childStates: (string | undefined)[] = [];
      for (let pass = 0; pass < 4 && childStates.length < children.length; pass += 1) {
        await schedulerPass(opened.orchestrator, { runId: RUN });
        const child = await workOnce(opened.orchestrator, { worker: 'w1' });
        if (child.claimed) childStates.push(child.result);
      }
      expect(childStates).toEqual(['published', 'published']);
      for (const child of children) {
        const published = await publishedFacts(opened, child.unitId);
        const coverages = published.filter((fact) => fact.kind === 'coverage');
        expect(coverages.length).toBe(1);
        const coverage = coverages[0]!.value as { repository: string; scope: string; complete: boolean; read: readonly string[] };
        expect(coverage.complete).toBe(true);
        expect(coverage.scope).toBe(child.unitId.split('/')[1] ?? '');
        expect(coverage.read.length).toBe(1);
      }
    } finally {
      await opened.close();
    }
  }, 180_000);

  test('the stage a run registers: declared on the shape, its kinds the schema gives stage 9, and absent when no agent is wired', () => {
    const snapshots = createGitSnapshotSource(() => []);
    expect(createStageRegistry({ snapshots }).get(BOUNDARIES_STAGE_ID)).toBeUndefined();
    const wired = createStageRegistry({ snapshots, agent: { agent: { id: 'fake-agent', command: 'bun' } } });
    const stage = wired.get(BOUNDARIES_STAGE_ID);
    expect(stage?.usesTools).toBe(true);
    // Stage 9 writes the proposed modules and the questions, and the coverage the shape adds to every agent stage; each
    // kind carries the schema's own version, and the schema's table writes a module at `9-boundaries`.
    expect(stage?.produces.map((produced) => produced.kind)).toEqual(['coverage', 'module', 'question']);
    expect(stage?.produces.every((produced) => produced.schemaVersion === FACT_KINDS[produced.kind as 'module'].version)).toBe(true);
    const declaration = boundariesDeclaration();
    expect(declaration.level).toBe('meaning');
    // The bounds the shape holds every stage to, named so a reader of the declaration reads the same numbers the run enforces.
    expect(BOUNDARIES_MODULE_ROWS).toBe(60);
    expect(BOUNDARIES_MEMBER_ROWS).toBe(200);
    // The stage reads the clustering (stage 5, madarch-tzte.21.7) and nothing else as its required input.
    expect(declaration.consumes.required.map((need) => need.capability)).toEqual(['repository', 'module']);
  });
});

describe('the plan of stage 9', () => {
  /**
   * The reads a plan makes, answered from a fixture that stands for the graph,
   * through the grammar's own read texts: the repositories by their form, the
   * modules of one repository by its name, the files by theirs, and the
   * `contains` edges a module holds by its own id.
   */
  function planReader(data: {
    readonly repositories: readonly { readonly id: string; readonly name: string; readonly form: string }[];
    readonly modules: Readonly<Record<string, readonly { readonly id: string; readonly name: string; readonly members: number }[]>>;
    readonly files: Readonly<Record<string, readonly { readonly id: string; readonly path: string }[]>>;
  }): StageGraphReader {
    // Which repository a module belongs to, and its own name: what the
    // containment answers are read from.
    const ofModule = new Map<string, { readonly repository: string; readonly name: string }>();
    for (const [repository, modules] of Object.entries(data.modules)) {
      for (const module of modules) ofModule.set(module.id, { repository, name: module.name });
    }
    const fact = (kind: string, id: string, value: Record<string, unknown>): unknown => ({
      id,
      kind,
      schema_version: FACT_KINDS[kind as 'module'].version,
      value,
      provenance: { source: { system: 'fixture', version: '1' }, repository: { id: String(value['repository'] ?? ''), commit: 'a'.repeat(40) } },
      layer: 'extracted',
      status: 'proposed',
    });
    return {
      async query(text: string) {
        const request = JSON.parse(text) as { read: string; kind?: string; field?: string; value?: string };
        if (request.read === 'facts-with' && request.kind === 'repository' && request.field === 'form') {
          return data.repositories.filter((repository) => repository.form === request.value).map((repository) => fact('repository', repository.id, { repository: repository.name, form: repository.form }));
        }
        if (request.read === 'facts-with' && request.kind === 'module' && request.field === 'repository') {
          return (data.modules[request.value ?? ''] ?? []).map((module) => fact('module', module.id, { repository: request.value, name: module.name, seed: 'package', members: module.members, importance: 0.5 }));
        }
        if (request.read === 'facts-with' && request.kind === 'file' && request.field === 'repository') {
          return (data.files[request.value ?? ''] ?? []).map((file) => fact('file', file.id, { repository: request.value, path: file.path, roles: ['source'] }));
        }
        if (request.read === 'facts-with' && request.kind === 'contains' && request.field === 'from') {
          // The fixture's containment: a module holds the files whose path stands
          // under the folder its name spells (`<name>/...`), as stage 5's own tree
          // holds a package's files under its folder.
          const mine = ofModule.get(request.value ?? '');
          if (mine === undefined) return [];
          return (data.files[mine.repository] ?? [])
            .filter((file) => file.path.startsWith(`${mine.name}/`))
            .map((file) => fact('contains', `contains:${'e'.repeat(60)}${file.id.slice(-4)}`, { from: request.value, to: file.id }));
        }
        throw new Error(`the plan reader was asked for ${text}`);
      },
    };
  }

  test('one unit per repository that holds modules; a repository past the planned size is planned one unit per top-level module; none is nothing found', async () => {
    const small = { id: 'repository:' + '1'.repeat(64), name: 'small-api', form: 'code' };
    const large = { id: 'repository:' + '2'.repeat(64), name: 'large-monolith', form: 'code' };
    const empty = { id: 'repository:' + '3'.repeat(64), name: 'no-modules', form: 'code' };
    const smallModules = [{ id: 'module:' + '5'.repeat(64), name: 'whole', members: 10 }];
    // Three top-level modules of 40 members each: 120 members at 0026's own
    // measure (2_000 tokens a member) is past the planned size (136_000 at the
    // 272K window), so the plan names one unit per module instead of one for the
    // repository's clustering.
    const largeModules = [
      { id: 'module:' + '6'.repeat(64), name: 'orders', members: 40 },
      { id: 'module:' + '7'.repeat(64), name: 'payments', members: 40 },
      { id: 'module:' + '8'.repeat(64), name: 'shipping', members: 40 },
    ];
    const largeFiles = [
      { id: 'file:' + 'a'.repeat(64), path: 'orders/order.ts' },
      { id: 'file:' + 'b'.repeat(64), path: 'payments/charge.ts' },
      { id: 'file:' + 'c'.repeat(64), path: 'shipping/parcel.ts' },
    ];
    const plan = await planBoundaryUnits(planReader({
      repositories: [small, large, empty],
      modules: { 'small-api': smallModules, 'large-monolith': largeModules, 'no-modules': [] },
      files: { 'small-api': [], 'large-monolith': largeFiles, 'no-modules': [] },
    }));
    expect(plan.coverage).toBe('planned');
    // The small repository's clustering is one unit, named by the repository fact, at the repository's own scope.
    expect(plan.units.filter((unit) => unit.scope === 'small-api')).toEqual([{ id: small.id, scope: 'small-api', estimatedTokens: 20_000 }]);
    // The large one is planned at the level below: one unit per top-level module, named by its module fact, at the
    // folder the module's own files stand in, in code point order of the folders.
    const largeUnits = plan.units.filter((unit) => unit.scope.startsWith('large-monolith:'));
    expect(largeUnits.map((unit) => unit.scope)).toEqual(['large-monolith:orders', 'large-monolith:payments', 'large-monolith:shipping']);
    expect(largeUnits[0]).toEqual({ id: largeModules[0]!.id, scope: 'large-monolith:orders', estimatedTokens: 80_000 });
    // A repository that holds no modules is planned no unit: there is nothing for the stage to read there.
    expect(plan.units.some((unit) => unit.scope.startsWith('no-modules'))).toBe(false);
  });

  test('a product that holds no modules at all is nothing found, not a failed plan', async () => {
    const plan = await planBoundaryUnits(planReader({ repositories: [{ id: 'repository:' + '6'.repeat(64), name: 'plain-api', form: 'code' }], modules: {}, files: {} }));
    // 0027: "no producer" is distinct from "producer found nothing" — the modules stage clustered nothing, and the
    // run's own coverage word says so.
    expect(plan).toEqual({ units: [], coverage: 'nothing-found' });
  });
});
