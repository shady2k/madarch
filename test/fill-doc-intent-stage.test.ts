/**
 * Stage 10, the intent the documents state, end to end on the agent-stage shape of
 * madarch-tzte.24.1 (decision 0026, "10 intent from documents", "Agent input",
 * "Scale" and "Writing"; 0027's publication and split; self-filling's outcomes 4
 * and 5).
 *
 * A unit reads one repository's document cluster — the document index of stage 6
 * (madarch-tzte.21.4): the documents, their sections, and the ends their links
 * name — writes intent claims tied to the sections that state them and to the code
 * nodes they name, and turns a contradiction between a document and the code into
 * an open question of type `contradiction`. The fixture is shaped like the
 * training repository plants it (the stale README claim: a README that states a
 * flat 5% tax while the code sets 0.08), and every expectation is taken from the
 * task, the decisions and the document index the stage reads — never from this
 * stage's own code. The agent is the fake ACP agent of
 * `test/fixtures/acp-fake-agent` (no real prompt, no network, no token spent),
 * the MCP server is the real one answering through the real server route, and
 * time passes through a seam, never a sleep.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { createFactStoreSchema, applyPublishedFacts, FACT_APPLICATION, readUnitFacts } from '../src/fill/fact-store.js';
import { makeEdgeFact, makeNodeFact, repositoryPath, type Fact, type FactProvenance, type FactTerm } from '../src/fill/facts.js';
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
  CONTRADICTION_QUESTION_TYPE,
  DOC_INTENT_DOCUMENT_ROWS,
  DOC_INTENT_KINDS,
  DOC_INTENT_LINK_ROWS,
  DOC_INTENT_SECTION_ROWS,
  DOC_INTENT_STAGE_ID,
  createDocIntentStage,
  docIntentDeclaration,
  planDocumentUnits,
} from '../src/fill/stages/doc-intent.js';
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
/** The one repository the fixture fills: shaped like the training repository's ordering slice. */
const REPOSITORY = 'orders-api';
/** The stale README claim the training repository plants: a document that contradicts the code. */
const README = 'README.md';
const README_BODY = '# orders api\n\n## Checkout\n\nThe checkout charges a flat 5% tax on every order, see [checkout](src/checkout.ts).\n\n## Retention\n\nOrders are retained indefinitely, see [policies](policies/retention.md).\n';
const CODE_FILE = 'src/checkout.ts';
const CODE_BODY = 'export const taxRate = 0.08;\nexport function discountFor(subtotal: number, percent: number) {\n  return subtotal * (1 - percent / 100);\n}\n';
const SECOND_DOCUMENT = 'docs/architecture.md';
const SECOND_BODY = '# architecture\n\nOne service holds the whole checkout.\n';
const FAKE_AGENT = join(import.meta.dir, 'fixtures', 'acp-fake-agent', 'acp-fake-agent.ts');

let root: string | undefined;
let COMMITS: Readonly<Record<string, string>> = {};

function provenance(repository: string, file: string, line: number): FactProvenance {
  return {
    source: { system: 'document-index', version: '1.0.0' },
    repository: { id: repository, commit: COMMITS[repository] ?? 'a'.repeat(40) },
    place: { file: repositoryPath(file), range: { startLine: line, startColumn: 0, endLine: line, endColumn: 20 } },
  };
}

/**
 * The graph the deterministic stages published for the document cluster the unit
 * reads: the repository, its files, the README document, its two sections, and the
 * `document-link` edges the sections hold — one resolved to the code file the
 * section names (the "links to code" of madarch-tzte.21.4), one unresolved (a path
 * the pinned commit does not hold, written with its place, never dropped).
 */
interface Graph {
  readonly repository: Fact;
  readonly readme: Fact;
  readonly architecture: Fact;
  readonly checkoutSection: Fact;
  readonly retentionSection: Fact;
  readonly codeFile: Fact;
  facts(): readonly Fact[];
}

function fixture(): Graph {
  const repository = makeNodeFact({ kind: 'repository', value: { repository: REPOSITORY, form: 'code' }, provenance: provenance(REPOSITORY, README, 1), layer: 'extracted' });
  const readmeFile = makeNodeFact({ kind: 'file', value: { repository: REPOSITORY, path: repositoryPath(README), roles: ['document'] }, provenance: provenance(REPOSITORY, README, 1), layer: 'extracted' });
  const codeFile = makeNodeFact({ kind: 'file', value: { repository: REPOSITORY, path: repositoryPath(CODE_FILE), roles: ['source'], language: 'typescript' }, provenance: provenance(REPOSITORY, CODE_FILE, 1), layer: 'extracted' });
  const readme = makeNodeFact({ kind: 'document', value: { repository: REPOSITORY, path: repositoryPath(README), mediaType: 'text/markdown', title: 'orders api', bytes: README_BODY.length, blob: 'b'.repeat(40) }, provenance: provenance(REPOSITORY, README, 1), layer: 'extracted' });
  const architecture = makeNodeFact({ kind: 'document', value: { repository: REPOSITORY, path: repositoryPath(SECOND_DOCUMENT), mediaType: 'text/markdown', title: 'architecture', bytes: SECOND_BODY.length, blob: 'c'.repeat(40) }, provenance: provenance(REPOSITORY, SECOND_DOCUMENT, 1), layer: 'extracted' });
  const checkoutSection = makeNodeFact({ kind: 'section', value: { repository: REPOSITORY, document: repositoryPath(README), anchor: 'checkout', heading: 'Checkout', level: 2 }, provenance: provenance(REPOSITORY, README, 3), layer: 'extracted' });
  const retentionSection = makeNodeFact({ kind: 'section', value: { repository: REPOSITORY, document: repositoryPath(README), anchor: 'retention', heading: 'Retention', level: 2 }, provenance: provenance(REPOSITORY, README, 7), layer: 'extracted' });
  const unresolved: FactTerm = { form: 'literal', text: 'policies/retention.md' };
  return {
    repository,
    readme,
    architecture,
    checkoutSection,
    retentionSection,
    codeFile,
    facts: () => [
      repository,
      readmeFile,
      codeFile,
      readme,
      architecture,
      checkoutSection,
      retentionSection,
      // The contains edges stage 1 publishes (a repository holds its files). The document index's document and
      // section facts stand in the graph as facts of their own, exactly as stage 6 wrote them — no edge names them,
      // so the packet's `members` section is stage 1's own list and the stage's `documents` and `sections` sections
      // are where a unit reads the document index.
      makeEdgeFact({ kind: 'contains', value: { from: repository.id, to: readmeFile.id }, provenance: provenance(REPOSITORY, README, 1), layer: 'extracted' }),
      makeEdgeFact({ kind: 'contains', value: { from: repository.id, to: codeFile.id }, provenance: provenance(REPOSITORY, CODE_FILE, 1), layer: 'extracted' }),
      // The link to code the section names, at the place the link stands at.
      makeEdgeFact({ kind: 'document-link', value: { from: checkoutSection.id, to: { form: 'node', id: codeFile.id } }, provenance: provenance(REPOSITORY, README, 5), layer: 'extracted' }),
      // The unresolved link: written with its place, never dropped (madarch-tzte.21.4).
      makeEdgeFact({ kind: 'document-link', value: { from: retentionSection.id, to: unresolved }, provenance: provenance(REPOSITORY, README, 9), layer: 'extracted' }),
    ],
  };
}

/**
 * The stand-in for the deterministic stages this fixture publishes the facts of: it
 * declares the capabilities stage 10 requires (`repository`, `document`, `section`,
 * `document-link`) so the derived stage graph knows where its inputs come from, and
 * it plans no unit, because the graph is already published.
 */
function structureStage(): FillStage {
  return {
    id: 'structure',
    version: 1,
    consumes: { required: [], optional: [] },
    produces: ['repository', 'file', 'document', 'section', 'document-link'].map((kind) => ({ kind, schemaVersion: FACT_KINDS[kind as 'document'].version, scope: 'file' as const })),
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
    .register(createDocIntentStage({
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
  root = mkdtempSync(join(tmpdir(), 'madarch-doc-intent-stage-'));
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
  commits[REPOSITORY] = make(REPOSITORY, { [README]: README_BODY, [CODE_FILE]: CODE_BODY, [SECOND_DOCUMENT]: SECOND_BODY });
  COMMITS = commits;
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

/** Plans and admits the run's one unit — the repository's document cluster — and returns it. */
async function planAndAdmit(opened: World): Promise<{ unitId: string; generation: number }> {
  const started = await startRun(opened.orchestrator, { runId: RUN });
  expect(started.ok).toBe(true);
  const planned = await planRun(opened.orchestrator, { runId: RUN });
  if (planned.outcome !== 'planned') throw new Error(`the run was not planned: ${JSON.stringify(planned)}`);
  // 0026's stage 10 plans the document clusters: one unit per repository that holds documents.
  expect(planned.units.length).toBe(1);
  expect(planned.units.map((unit) => unit.stageId)).toEqual([DOC_INTENT_STAGE_ID]);
  expect(planned.units[0]!.scope).toBe(REPOSITORY);
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

/** One intent claim the fake agent asserts through `assert_fact`, tied to a section and to the code node it names. */
function claimStep(options: { subject: string; object: string; text: string; repository?: string; file: string; line: number }): unknown {
  return {
    call: {
      tool: 'assert_fact',
      arguments: {
        kind: 'claim',
        value: { subject: { form: 'node', id: options.subject }, predicate: 'states', object: { form: 'node', id: options.object }, text: options.text, confidence: 0.7 },
        place: { repository: options.repository ?? REPOSITORY, file: options.file, startLine: options.line, endLine: options.line },
      },
    },
  };
}

/** One contradiction question the fake agent raises through `raise_question`, citing the section that contradicts the code. */
function questionStep(options: { prompt: string; about: string; file: string; line: number }): unknown {
  return {
    call: {
      tool: 'raise_question',
      arguments: {
        type: CONTRADICTION_QUESTION_TYPE,
        prompt: options.prompt,
        about: options.about,
        place: { repository: REPOSITORY, file: options.file, startLine: options.line, endLine: options.line },
      },
    },
  };
}

describe('stage 10, the intent the documents state', () => {
  test('one unit of a repository\'s document cluster writes its intent claims and the contradiction question, and publishes them with its coverage', async () => {
    const ids = fixture();
    const opened = await openWorld({
      script: {
        byPrompt: [],
        steps: [
          { say: 'reading the document index' },
          // The intent claim the README's checkout section states, tied to the section and to the code node it names.
          claimStep({ subject: ids.checkoutSection.id, object: ids.codeFile.id, text: 'The checkout charges a flat 5% tax on every order', file: README, line: 3 }),
          // The stale README claim against the code: the open question outcome 5 gives a contradiction.
          questionStep({ prompt: 'The README\'s Checkout section states a flat 5% tax, and src/checkout.ts sets taxRate to 0.08 — which holds?', about: ids.codeFile.id, file: README, line: 3 }),
          { answer: { status: 'done', covered: [README, SECOND_DOCUMENT], remaining: [], summary: 'The README promises a flat 5% tax; the code applies 8%' } },
        ],
      },
    });
    try {
      const unit = await planAndAdmit(opened);
      // The unit's id is the repository fact's own id, under the stage's own prefix: a node of the graph, never a run
      // (0026, "Updates").
      expect(unit.unitId).toBe(`${DOC_INTENT_STAGE_ID}/${ids.repository.id}`);
      const worked = await workOnce(opened.orchestrator, { worker: 'w1' });
      expect(worked.result).toBe('published');
      expect(worked.unitId).toBe(unit.unitId);

      // The prompt the agent received: the stage's own fixed part, the document-index packet, within 0026's 20K.
      const sent = prompts(opened);
      expect(sent.length).toBe(1);
      const prompt = sent[0]!;
      expect(prompt).toContain('You are one unit of madarch\'s fill that writes what a repository\'s documents say the system is meant to do');
      // The level of self-filling's outcome 4 this stage's statements stand at: what people recorded, not what the agent assumes.
      expect(prompt).toContain('What you write is intent');
      expect(prompt).toContain('Facts this unit may write: claim, coverage, question — and nothing else');
      expect(estimateTokens(prompt, DEFAULT_GRAPH_READ_LIMITS)).toBeLessThanOrEqual(20_000);
      // The packet is the last JSON object of the prompt, after the fixed part.
      const packet = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n{') + 2)) as Record<string, unknown>;
      // The shape's own sections of the scope, then the document index this stage declares, then what it may write.
      expect(Object.keys(packet)).toEqual(['unit', 'place', 'scope', 'members', 'entryPoints', 'data', 'relations', 'history', 'documents', 'sections', 'links', 'writes', 'marker']);
      expect((packet['unit'] as { id: string; scope: string }).scope).toBe(REPOSITORY);
      expect((packet['scope'] as { id: string; kind: string }).id).toBe(ids.repository.id);
      expect((packet['scope'] as { kind: string }).kind).toBe('repository');
      // The document index of the scope: the documents, their sections in the order a reader meets them, and the ends
      // their links name — the resolved one with the node it names, the unresolved one as the term the document wrote.
      expect(packet['documents']).toEqual([
        { id: ids.readme.id, path: 'README.md', title: 'orders api', mediaType: 'text/markdown' },
        { id: ids.architecture.id, path: SECOND_DOCUMENT, title: 'architecture', mediaType: 'text/markdown' },
      ]);
      expect(packet['sections']).toEqual([
        { id: ids.checkoutSection.id, document: 'README.md', anchor: 'checkout', heading: 'Checkout', level: 2, line: 3 },
        { id: ids.retentionSection.id, document: 'README.md', anchor: 'retention', heading: 'Retention', level: 2, line: 7 },
      ]);
      expect(packet['links']).toEqual([
        { from: ids.checkoutSection.id, document: 'README.md', line: 5, to: { form: 'node', id: ids.codeFile.id }, end: { kind: 'file', path: 'src/checkout.ts' } },
        { from: ids.retentionSection.id, document: 'README.md', line: 9, to: { form: 'literal', text: 'policies/retention.md' } },
      ]);
      expect(packet['marker']).toBeNull();

      // What it published: the intent claim, the contradiction question, and the coverage of the document cluster.
      const published = await publishedFacts(opened, unit.unitId);
      expect(published.map((fact) => fact.kind).sort()).toEqual(['claim', 'coverage', 'question']);
      const claim = published.find((fact) => fact.kind === 'claim')!;
      // 0005's layer and status for an agent's reading: inferred, and proposed until a person accepts it.
      expect(claim.layer).toBe('inferred');
      expect(claim.status).toBe('proposed');
      expect((claim.value as { subject: { id: string }; object: { id: string } }).subject.id).toBe(ids.checkoutSection.id);
      expect((claim.value as { object: { id: string } }).object.id).toBe(ids.codeFile.id);
      // The evidence is the section's own bytes at the pinned commit.
      expect(claim.provenance.place?.file).toBe(repositoryPath(README));
      expect(claim.provenance.place?.range.startLine).toBe(3);
      expect(claim.provenance.repository).toEqual({ id: REPOSITORY, commit: COMMITS[REPOSITORY]! });
      const question = published.find((fact) => fact.kind === 'question')!;
      // Self-filling's outcome 5: the contradiction is an open question of its own type, about the code it contradicts.
      expect((question.value as { type: string }).type).toBe('contradiction');
      expect((question.value as { repository: string }).repository).toBe(REPOSITORY);
      expect((question.value as { about?: string }).about).toBe(ids.codeFile.id);
      expect(question.layer).toBe('inferred');
      expect(question.status).toBe('proposed');
      const coverage = published.find((fact) => fact.kind === 'coverage')!;
      // The coverage names what of the document cluster was read, and its scope is the unit's own scope node — the
      // stage unit's id, the repository fact's own (the orchestrator's composite unit id prefixes the stage's).
      expect(coverage.value).toEqual({ repository: REPOSITORY, scope: ids.repository.id, complete: true, read: [README, SECOND_DOCUMENT], unread: [] });
      expect((await readRunUnits(opened.owner, RUN)).map((record) => record.state)).toEqual(['published']);
    } finally {
      await opened.close();
    }
  }, 180_000);

  test('a write outside the unit\'s scope lands nothing, and the coverage is what publishes', async () => {
    const ids = fixture();
    const opened = await openWorld({
      script: {
        byPrompt: [],
        steps: [
          { say: 'writing' },
          // A claim cited to a repository this run pins nowhere: the checked write refuses it by name, and nothing of
          // it lands in the unit's draft set (the refusal itself is held by `test/fill-checked-writes.test.ts`).
          claimStep({ subject: ids.checkoutSection.id, object: ids.codeFile.id, text: 'the checkout charges a flat 5% tax', repository: 'somewhere-else', file: README, line: 3 }),
          { answer: { status: 'done', covered: [README, SECOND_DOCUMENT], remaining: [], summary: 'nothing was written' } },
        ],
      },
    });
    try {
      const unit = await planAndAdmit(opened);
      const worked = await workOnce(opened.orchestrator, { worker: 'w1' });
      expect(worked.result).toBe('published');
      const published = await publishedFacts(opened, unit.unitId);
      // Nothing of the refused write stands, not even in part: the unit published its coverage alone and carried on.
      expect(published.filter((fact) => fact.kind === 'claim' || fact.kind === 'question')).toEqual([]);
      expect(published.map((fact) => fact.kind)).toEqual(['coverage']);
    } finally {
      await opened.close();
    }
  }, 180_000);

  test('a malformed answer is refused by the field it got wrong, the unit is asked again with its documents, and the second answer publishes', async () => {
    const opened = await openWorld({
      script: {
        // The first turn's object has no `status`: the answer schema names the field it lacks, and the unit is asked
        // again — inside 0026's turn limit, not as a failure. The turn that answers is the one that matches the nudge.
        byPrompt: [{ matches: 'That was not the answer', steps: [
          { answer: { status: 'done', covered: [README, SECOND_DOCUMENT], remaining: [], summary: 'the documents were read' } },
        ] }],
        steps: [
          { say: 'reading the documents' },
          { say: '{"covered":[]}' },
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
      // The nudge names the field the answer lacked, the shape, and the documents of the scope, so the unit can name
      // its places without reading the packet again.
      expect(sent[1]).toContain('That was not the answer this unit contract asks for.');
      expect(sent[1]).toContain('the answer names no `status`');
      expect(sent[1]).toContain('{"status":"done"|"partial"');
      expect(sent[1]).toContain(`The places of ${REPOSITORY} are: ${README}, ${SECOND_DOCUMENT}.`);
      expect((await publishedFacts(opened, unit.unitId)).length).toBe(1);
    } finally {
      await opened.close();
    }
  }, 180_000);

  test('a unit that never answers is stopped at 0026\'s turn limit and splits its document cluster into its documents', async () => {
    const opened = await openWorld({
      script: {
        // The children of the split run on the same stage, and each reads the one document its scope names. A child's
        // packet is the shape's own sections of its document — the one with a `members` list — and its answer names
        // the document it covers.
        byPrompt: [
          // A child's own unit scope (`"scope": "<repository>:<path>"`, in its `unit` section) is a text its parent's
          // packet never holds — the parent's members name a document's path as their `place`, not as a scope — so each
          // child is matched by it: the README child reads the README, the architecture child its own.
          { matches: `"scope": "${REPOSITORY}:${README}"`, steps: [{ answer: { status: 'done', covered: [README], remaining: [], summary: 'the README was read' } }] },
          { matches: `"scope": "${REPOSITORY}:${SECOND_DOCUMENT}"`, steps: [{ answer: { status: 'done', covered: [SECOND_DOCUMENT], remaining: [], summary: 'the architecture note was read' } }] },
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
      // Its partial draft keeps the coverage: no document was read, and each is a `budget` gap.
      const draft = await readUnitDraft(opened.owner, unit.unitId, unit.generation);
      const coverages = (draft?.writes ?? []).map((write) => write.value as { kind: string; value: { repository: string; scope: string; complete: boolean; read: string[]; unread: { what: string; reason: string }[] } });
      expect(coverages.map((coverage) => coverage.kind)).toEqual(['coverage']);
      expect(coverages[0]!.value).toEqual({ repository: REPOSITORY, scope: fixture().repository.id, complete: false, read: [], unread: [{ what: README, reason: 'budget' }, { what: SECOND_DOCUMENT, reason: 'budget' }] });
      // 0026's hierarchy: the split names the documents of the cluster, one child each, named by their document facts.
      const children = (await readRunUnits(opened.owner, RUN)).filter((record) => record.unitId !== unit.unitId);
      const scopes = await Promise.all(children.map(async (record) => (await readUnitPlan(opened.owner, record.unitId, record.generation))?.scope));
      expect(scopes.sort()).toEqual([`${REPOSITORY}:${README}`, `${REPOSITORY}:${SECOND_DOCUMENT}`].sort((left, right) => left < right ? -1 : 1));
      expect(children.every((record) => record.state === 'planned')).toBe(true);

      // A child is a unit of one document (stage 6's own granularity), and it runs: its packet is the shape's own
      // sections of its document — no document index beyond its own — and it publishes the coverage of the document
      // it read.
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
        const coverage = facts[0]!.value as { complete: boolean; read: readonly string[] };
        expect(coverage.complete).toBe(true);
        expect(coverage.read.length).toBe(1);
      }
      // A child's packet is the shape's own of its document: the document index sections name its one document.
      // The child prompts, told from the parent's by the unit scope the `unit` section spells: the parent's members
      // name a document's path as their `place`, never as a scope.
      const childPrompts = prompts(opened).filter((prompt) => prompt.includes(`"scope": "${REPOSITORY}:`));
      expect(childPrompts.length).toBe(children.length);
      const childPackets = childPrompts.map((prompt) => JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n{') + 2)) as Record<string, unknown>);
      for (const childPacket of childPackets) {
        expect(Object.keys(childPacket)).toEqual(['unit', 'place', 'scope', 'members', 'entryPoints', 'data', 'relations', 'history', 'documents', 'sections', 'links', 'writes', 'marker']);
        expect((childPacket['documents'] as { path: string }[]).length).toBe(1);
      }
    } finally {
      await opened.close();
    }
  }, 240_000);
});

describe('stage 10\'s declaration', () => {
  test('the intent level, the repository scale with document places, claims and questions, and the document-index sections', () => {
    const declaration = docIntentDeclaration();
    expect(declaration.factStage).toBe('10-intent-documents');
    // Self-filling's outcome 4: the intent the documents state is what people recorded, the level above meaning.
    expect(declaration.level).toBe('intent');
    // 0026's "Scale": the repository's document cluster, a document below it.
    expect(declaration.scale).toEqual({ level: 'repository', child: 'place' });
    expect(declaration.kinds).toEqual(DOC_INTENT_KINDS);
    expect(declaration.kinds).toEqual(['claim', 'question']);
    // The section names are the packet's own, in the order the stage declares them, each with the bound its rows
    // are held to: a bound the packet's own `boundedList` enforces and names in the marker when it cuts.
    expect(declaration.sections?.map((section) => section.name)).toEqual(['documents', 'sections', 'links']);
    expect(declaration.sections?.map((section) => section.max)).toEqual([DOC_INTENT_DOCUMENT_ROWS, DOC_INTENT_SECTION_ROWS, DOC_INTENT_LINK_ROWS]);
    expect(DOC_INTENT_DOCUMENT_ROWS).toBe(40);
    expect(DOC_INTENT_SECTION_ROWS).toBe(80);
    expect(DOC_INTENT_LINK_ROWS).toBe(80);
    // The stage reads the document index (madarch-tzte.21.4) and nothing else as its required input.
    expect(declaration.consumes.required.map((need) => need.capability)).toEqual(['repository', 'document', 'section', 'document-link']);
    // The question type outcome 5 gives a document that contradicts the code.
    expect(CONTRADICTION_QUESTION_TYPE).toBe('contradiction');
  });

  test('a run that wires an agent registers the stage; a run that wires none holds no unit that could read nothing', () => {
    const snapshots = createGitSnapshotSource(() => []);
    expect(createStageRegistry({ snapshots }).get(DOC_INTENT_STAGE_ID)).toBeUndefined();
    const wired = createStageRegistry({ snapshots, agent: { agent: { id: 'fake-agent', command: 'bun' } } });
    const stage = wired.get(DOC_INTENT_STAGE_ID);
    expect(stage?.usesTools).toBe(true);
    // Stage 10 writes the intent claims and the questions, and the coverage the shape adds to every agent stage; each
    // kind carries the schema's own version, and the schema's table writes a claim at `10-intent-documents`.
    expect(stage?.produces.map((produced) => produced.kind)).toEqual(['claim', 'coverage', 'question']);
    expect(stage?.produces.every((produced) => produced.schemaVersion === FACT_KINDS[produced.kind as 'claim'].version)).toBe(true);
  });
});

describe('the plan of stage 10', () => {
  /**
   * The reads a plan makes, answered from a fixture that stands for the graph,
   * through the grammar's own read texts: the repositories by their form and the
   * documents of one repository by its name. A repository past 0026's planned size
   * (68 documents at one bounded reading each) is planned one unit per document.
   */
  function planReader(data: {
    readonly repositories: readonly { readonly id: string; readonly name: string; readonly form: string }[];
    readonly documents: Readonly<Record<string, readonly { readonly id: string; readonly path: string }[]>>;
  }): StageGraphReader {
    return {
      async query(text: string) {
        const request = JSON.parse(text) as { read: string; kind?: string; field?: string; value?: string; form?: string };
        if (request.read === 'facts-with' && request.kind === 'repository' && request.field === 'form') {
          const held = data.repositories.filter((repository) => repository.form === request.value);
          return held.map((repository) => ({ id: repository.id, kind: 'repository', schema_version: FACT_KINDS.repository.version, value: { repository: repository.name, form: repository.form }, provenance: { source: { system: 'fixture', version: '1' }, repository: { id: repository.name, commit: 'a'.repeat(40) } }, layer: 'extracted', status: 'proposed' }));
        }
        if (request.read === 'facts-with' && request.kind === 'document' && request.field === 'repository') {
          return (data.documents[request.value ?? ''] ?? []).map((document) => ({ id: document.id, kind: 'document', schema_version: FACT_KINDS.document.version, value: { repository: request.value, path: document.path, mediaType: 'text/markdown' }, provenance: { source: { system: 'fixture', version: '1' }, repository: { id: request.value, commit: 'a'.repeat(40) } }, layer: 'extracted', status: 'proposed' }));
        }
        throw new Error(`the plan reader was asked for ${text}`);
      },
    };
  }

  test('one unit per repository that holds documents; a repository past the planned size is planned one unit per document; none is nothing found', async () => {
    const small = { id: 'repository:' + '1'.repeat(64), name: 'small-api', form: 'code' };
    const large = { id: 'repository:' + '2'.repeat(64), name: 'large-docs', form: 'code' };
    const empty = { id: 'repository:' + '3'.repeat(64), name: 'no-docs', form: 'code' };
    // 69 documents: one bounded reading each is past 0026's planned size (plannedTokens(DEFAULT_STAGE_LIMITS) = 136_000
    // at the 272K window), so the plan names one unit per document instead of one for the cluster.
    const many = Array.from({ length: 69 }, (_, index) => ({ id: `document:${String(index).padStart(2, '0')}${'4'.repeat(62)}`, path: `docs/doc-${String(index).padStart(2, '0')}.md` }));
    const plan = await planDocumentUnits(planReader({
      repositories: [small, large, empty],
      documents: { 'small-api': [{ id: 'document:' + '5'.repeat(64), path: 'README.md' }], 'large-docs': many, 'no-docs': [] },
    }));
    expect(plan.coverage).toBe('planned');
    // The small repository's cluster is one unit, named by the repository fact, at the repository's own scope.
    expect(plan.units.filter((unit) => unit.scope === 'small-api')).toEqual([{ id: small.id, scope: 'small-api', estimatedTokens: 2_000 }]);
    // The large one is planned at the level below: one unit per document, named by its document fact, at the
    // document's own scope — stage 6's own granularity.
    const largeUnits = plan.units.filter((unit) => unit.scope.startsWith('large-docs:'));
    expect(largeUnits.length).toBe(69);
    expect(largeUnits[0]).toEqual({ id: many[0]!.id, scope: 'large-docs:docs/doc-00.md', estimatedTokens: 2_000 });
    // A repository that holds no documents is planned no unit: there is nothing for the stage to read there.
    expect(plan.units.some((unit) => unit.scope.startsWith('no-docs'))).toBe(false);
  });

  test('a product that holds no documents at all is nothing found, not a failed plan', async () => {
    const plan = await planDocumentUnits(planReader({ repositories: [{ id: 'repository:' + '6'.repeat(64), name: 'plain-api', form: 'code' }], documents: {} }));
    // 0027: "no producer" is distinct from "producer found nothing" — the document index found nothing, and the run's
    // own coverage word says so.
    expect(plan).toEqual({ units: [], coverage: 'nothing-found' });
  });
});
