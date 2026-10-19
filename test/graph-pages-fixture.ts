/**
 * The fixture the graph pages' tests publish through (madarch-tzte.23.1): a real
 * background-server fill service over PGlite, a product folder with a manifest,
 * and one stage whose unit drafts the facts its caller names — so a page set, a
 * page's model and the live channel are read from facts a publication really
 * wrote, and never from a stand-in store.
 *
 * Nothing here asserts: each test names the values it expects from the task and
 * from decision 0026, the way `test/fill-fact-store-scenario.ts` leaves the
 * judgement to its callers.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { makeEdgeFact, makeNodeFact, repositoryPath, type Fact, type FactProvenance } from '../src/fill/facts.js';
import { createFillOrchestratorService, type FillOrchestratorService } from '../src/fill/orchestrator-host.js';
import { FACT_APPLICATION } from '../src/fill/fact-store.js';
import { createUnit } from '../src/fill/state-store.js';
import { StageRegistry } from '../src/fill/registry.js';
import { DEFAULT_STAGE_DEFAULTS, type FillStage } from '../src/fill/stage.js';
import type { StageDraftWrite } from '../src/fill/stage.js';

/** The product's own name, as its manifest and a fill's runs name it: the scope of every page read. */
export const PRODUCT = 'Fixture Product';

/** The commit every fixture fact was read at, and the one a later run stands on. */
export const COMMIT = 'a'.repeat(40);
export const LATER_COMMIT = 'b'.repeat(40);

/** One fact's provenance: read out of a file of `acme-shop` at a commit, at the lines it stands at. */
export function provenance(file: string, options: { commit?: string; system?: string; startLine?: number; endLine?: number } = {}): FactProvenance {
  return {
    source: { system: options.system ?? 'tree-sitter', version: '1.0.0' },
    repository: { id: 'acme-shop', commit: options.commit ?? COMMIT },
    place: {
      file: repositoryPath(file),
      range: { startLine: options.startLine ?? 1, startColumn: 0, endLine: options.endLine ?? 1, endColumn: 12 },
    },
  };
}

/** The module whose page every read here is about. */
export function moduleFact(options: { commit?: string; importance?: number; name?: string } = {}): Fact {
  return makeNodeFact({
    kind: 'module',
    value: { repository: 'acme-shop', name: options.name ?? 'checkout', seed: 'package', ...(options.importance === undefined ? {} : { importance: options.importance }) },
    provenance: provenance('src/checkout.ts', { commit: options.commit ?? COMMIT, system: 'fill-stage-5', startLine: 1, endLine: 40 }),
    layer: 'extracted',
  });
}

/** One symbol of the module's file: a page-worthy node of its own. */
export function symbolFact(name: string): Fact {
  return makeNodeFact({
    kind: 'symbol',
    value: { repository: 'acme-shop', file: repositoryPath('src/checkout.ts'), qualifiedName: name, symbolKind: 'function' },
    provenance: provenance('src/checkout.ts', { startLine: 12, endLine: 18 }),
    layer: 'extracted',
  });
}

/** The facts one run of the fixture's stage publishes, named so a test can say exactly what it expects. */
export interface GraphFixtureFacts {
  readonly module: Fact;
  readonly placed: Fact;
  readonly total: Fact;
  readonly holds: Fact;
  readonly calls: Fact;
  readonly claim: Fact;
  readonly rule: Fact;
  readonly coverage: Fact;
  readonly question: Fact;
  /** A fact of a kind with no page (a file is a `place` the registry is not about): it is shown on a page, never as one. */
  readonly file: Fact;
  /** The endpoint a `provides` edge names by its contract: a node of its own, whose page the module's relation links. */
  readonly endpoint: Fact;
  /** An environment variable: a node of its own, and the ends of the two edges below. */
  readonly variable: Fact;
  /** A `provides` edge, whose other end is a contract id and no node: the page shows it as text, links nothing. */
  readonly provides: Fact;
  /** A `consumes` edge, whose other end is the environment variable's node. */
  readonly consumes: Fact;
  /** A `binds` edge, whose other end is an environment's name and no node. */
  readonly binds: Fact;
}

/** The fixture's facts: one module, two symbols, the edges between them, and the intent an agent stage adds. */
export function graphFacts(): GraphFixtureFacts {
  const module = moduleFact();
  const placed = symbolFact('checkout.place');
  const total = symbolFact('checkout.total');
  const endpoint = makeNodeFact({
    kind: 'api-endpoint',
    value: { contract: 'http::POST::/orders/{}', framework: 'express' },
    provenance: provenance('src/checkout.ts', { startLine: 5, endLine: 5 }),
    layer: 'extracted',
  });
  const variable = makeNodeFact({
    kind: 'environment-variable',
    value: { name: 'ORDERS_TOPIC' },
    provenance: provenance('src/checkout.ts', { startLine: 8, endLine: 8 }),
    layer: 'extracted',
  });
  return {
    module,
    placed,
    total,
    holds: makeEdgeFact({ kind: 'contains', value: { from: module.id, to: placed.id }, provenance: provenance('src/checkout.ts', { startLine: 1, endLine: 40 }), layer: 'extracted' }),
    calls: makeEdgeFact({ kind: 'call', value: { from: placed.id, to: total.id, count: 2, precision: 'syntactic' }, provenance: provenance('src/checkout.ts', { startLine: 14, endLine: 14 }), layer: 'extracted' }),
    claim: makeNodeFact({
      kind: 'claim',
      value: { subject: { form: 'node', id: module.id }, predicate: 'is-implemented-by', object: { form: 'node', id: placed.id }, text: 'the checkout module places an order' },
      provenance: provenance('src/checkout.ts', { startLine: 12, endLine: 12 }),
      layer: 'inferred',
    }),
    rule: makeNodeFact({
      kind: 'rule',
      value: { statement: 'an order is placed once', subject: module.id, form: 'invariant' },
      provenance: provenance('src/checkout.ts', { startLine: 20, endLine: 20 }),
      layer: 'inferred',
    }),
    coverage: makeNodeFact({
      kind: 'coverage',
      value: { repository: 'acme-shop', scope: module.id, complete: false, read: ['src/checkout.ts'], unread: [{ what: 'src/refunds.ts', reason: 'budget' }] },
      provenance: provenance('src/checkout.ts', { startLine: 1, endLine: 40, system: 'fill-stage-5' }),
      layer: 'extracted',
    }),
    question: makeNodeFact({
      kind: 'question',
      value: { repository: 'acme-shop', type: 'assumption-check', about: module.id, prompt: 'is the total used anywhere?' },
      provenance: provenance('src/checkout.ts', { startLine: 18, endLine: 18 }),
      layer: 'inferred',
    }),
    file: makeNodeFact({
      kind: 'file',
      value: { repository: 'acme-shop', path: repositoryPath('src/checkout.ts'), roles: ['source'] },
      provenance: provenance('src/checkout.ts', { startLine: 1, endLine: 40 }),
      layer: 'extracted',
    }),
    endpoint,
    variable,
    provides: makeEdgeFact({
      kind: 'provides',
      value: { from: module.id, contract: 'http::POST::/orders/{}' },
      provenance: provenance('src/checkout.ts', { startLine: 5, endLine: 5 }),
      layer: 'extracted',
    }),
    consumes: makeEdgeFact({
      kind: 'consumes',
      value: { from: placed.id, variable: variable.id },
      provenance: provenance('src/checkout.ts', { startLine: 13, endLine: 13 }),
      layer: 'extracted',
    }),
    binds: makeEdgeFact({
      kind: 'binds',
      value: { variable: variable.id, environment: 'production', value: { form: 'literal', text: 'orders' } },
      provenance: provenance('src/checkout.ts', { startLine: 9, endLine: 9 }),
      layer: 'extracted',
    }),
  };
}

/** One write of a fact, as a stage's draft writer makes it. */
export function writeOf(fact: Fact, evidence = 'acme-shop@' + COMMIT + ':src/checkout.ts'): StageDraftWrite {
  return { kind: 'fact', evidence, value: fact };
}

/**
 * The stage a fixture run publishes through: its plan is one unit over the
 * repository, and what that unit drafts is `drafts()` read at the moment it runs —
 * so a second run can publish a different set over the same unit, and a page can
 * appear or disappear between two runs.
 */
export function graphStage(options: { readonly id?: string; readonly drafts: () => readonly StageDraftWrite[] }): FillStage {
  return {
    id: options.id ?? 'graph-fixture',
    version: 1,
    consumes: { required: [], optional: [] },
    produces: [{ kind: 'fixture-facts', schemaVersion: 1, scope: 'repository' }],
    configSchema: Type.Object({}),
    defaults: DEFAULT_STAGE_DEFAULTS,
    plan: () => ({ units: [{ id: 'src', scope: 'src' }], coverage: 'planned' }),
    execute: (_unit, context) => {
      for (const write of options.drafts()) context.draft.write(write);
      return { outcome: 'draft' };
    },
    validate: () => ({ ok: true }),
  };
}

/**
 * Publishes facts for a unit of *another* product in the same home's store: what a
 * second product's publication leaves, for a test that asks whether a page answers
 * only its own product's facts. A home's store carries every product, and two
 * products that declare a repository of the same name publish facts of one id.
 */
export async function publishForAnotherProduct(owner: DatabaseOwner, product: string, facts: readonly Fact[]): Promise<string> {
  const at = 1_700_000_000_500;
  const unitId = `other-stage/${product}`;
  const unit = await createUnit(owner, { unitId, product, runId: `run-${product}`, stageId: 'other-stage', scopeKey: product, inputsDigest: 'other-inputs', retries: 0, at });
  const plan = { unitId, generation: 1, runId: `run-${product}`, stageId: 'other-stage', stageUnitId: product, scope: 'acme-shop', stagePosition: 0, planPosition: 0, plannedAt: at };
  await owner.transaction('write', async (executor) => {
    await FACT_APPLICATION.apply({ executor, unit, plan, digest: `other-publication-${product}`, writes: facts.map((fact) => writeOf(fact)) });
  });
  return unitId;
}

/** One product folder with a manifest the wiki can open, and the home its fill's database lives under. */
export interface GraphFixtureWorld {
  readonly home: string;
  readonly folder: string;
  readonly owner: DatabaseOwner;
  readonly service: FillOrchestratorService;
  /** The commit the next run's inputs name: moving it re-plans the unit, so a second run publishes again. */
  repin(commit: string): void;
  close(): Promise<void>;
}

/** Opens the fixture: a product folder, one database owner, and the fill service over them. */
export async function openGraphFixture(options: {
  readonly drafts: () => readonly StageDraftWrite[];
  /** Stages registered beside the drafting one: their units' inputs never move, so a second run reuses them and they publish nothing. */
  readonly extraStages?: readonly FillStage[];
  readonly registry?: StageRegistry;
}): Promise<GraphFixtureWorld> {
  const home = await mkdtemp(join(tmpdir(), 'madarch-graph-pages-home-'));
  const folder = join(home, 'fixture-product');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'workspace.yaml'), `schemaVersion: 1\nid: 3f6d2dc8-b16e-4bf0-9d3a-2c9c00b5287d\nname: ${PRODUCT}\n`);
  const owner = createPGliteDatabaseOwner();
  let commit = COMMIT;
  const registry = (options.registry ?? new StageRegistry()).register(graphStage({ drafts: options.drafts }));
  for (const stage of options.extraStages ?? []) registry.register(stage);
  const service = createFillOrchestratorService({
    home,
    owner,
    registry,
    wiring: () => ({
      snapshot: () => ({ repository: 'acme-shop', defaultBranch: 'main', commit, registryHash: 'sha256:fixture' }),
      configuration: () => undefined,
      graph: () => ({ query: async () => [] }),
      // The drafting stage's input is the run's pin, so moving it re-plans that stage's unit; every other stage's
      // unit stands on its own constant, so a second run inherits it and publishes nothing.
      inputs: (ref) => ({ commit: ref.stageId === 'graph-fixture' ? commit : `static-${ref.stageUnitId}` }),
    }),
  });
  return {
    home,
    folder,
    owner,
    service,
    repin: (next: string) => {
      commit = next;
    },
    close: async () => {
      await service.stop();
      await owner.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
