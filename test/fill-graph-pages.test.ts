/**
 * The graph's pages, read from the fill's fact store (madarch-tzte.23.1; decision
 * 0026, "Pages"): the page set of a product, one node's page model, and the record
 * of what each publication touched — the answers the background server gives.
 *
 * The values here are the task's and the decision's, never the code's: the fact
 * kinds the registry's own mapping makes subjects (modules and packages among them)
 * for the page set, and "its facts with code links (repository path and line span at
 * the pinned commit), its relations both ways, its coverage, its open questions,
 * layer and status per fact (facts vs assumptions kept apart), drafts marked as
 * draft" for a page.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PAGE_KINDS,
  isPageId,
  pageAddress,
  pagesTouchedBy,
  readPageChanges,
  readPageModel,
  readPageSet,
} from '../src/fill/graph-pages.js';
import { FACT_NODE_KINDS, REGISTRY_KIND_MAPPINGS, makeNodeFact, type Fact, type FactKind } from '../src/fill/facts.js';
import { recordUnitDraft, recordUnitPlan } from '../src/fill/orchestrator-store.js';
import { createUnit } from '../src/fill/state-store.js';
import { byCodePoint } from '../src/model/order.js';
import {
  graphFacts,
  LATER_COMMIT,
  openGraphFixture,
  PRODUCT,
  provenance,
  publishForAnotherProduct,
  writeOf,
  type GraphFixtureFacts,
  type GraphFixtureWorld,
} from './graph-pages-fixture.js';

/** The facts one publication of the fixture's stage holds, in the order they are written. */
function everything(all: GraphFixtureFacts): readonly Fact[] {
  return [all.module, all.placed, all.total, all.holds, all.calls, all.claim, all.rule, all.coverage, all.question, all.file, all.endpoint, all.variable, all.provides, all.consumes, all.binds];
}

let world: GraphFixtureWorld | undefined;
let facts: GraphFixtureFacts;

beforeAll(async () => {
  facts = graphFacts();
  world = await openGraphFixture({ drafts: () => everything(facts).map((fact) => writeOf(fact)) });
  const run = await world.service.run({ product: { name: PRODUCT, folder: world.folder }, runId: 'run-pages-1' });
  if (run.ok === false) throw new Error(`the fixture's first run was refused: ${run.code}: ${run.reason}`);
}, 120_000);

afterAll(async () => {
  await world?.close();
});

describe('the kinds a page exists for', () => {
  /**
   * The task's words: "the fact kinds that map to registry storage forms in
   * `REGISTRY_KIND_MAPPINGS`, plus modules and packages". A page is *about* one node,
   * so the list is the mapping's own `subject` role — the nodes a registry document
   * may be about — and the kinds of the roles `place` and `evidence` have no page.
   */
  test('are the registry subjects, modules and packages among them, and no place or evidence kind', () => {
    const subjects = FACT_NODE_KINDS.filter((kind) => REGISTRY_KIND_MAPPINGS[kind].relation === 'subject').sort(byCodePoint);
    expect([...PAGE_KINDS]).toEqual(subjects);
    const pageKindsOfTheDecision: FactKind[] = [
      'api-endpoint', 'column', 'deploy-unit', 'entity-proposal', 'entry-point', 'environment-variable',
      'module', 'package', 'question', 'repository', 'rule', 'state', 'symbol', 'table', 'test',
    ];
    expect([...PAGE_KINDS]).toEqual(pageKindsOfTheDecision.sort(byCodePoint));
    for (const kind of ['file', 'directory', 'document', 'section', 'snapshot', 'commit', 'occurrence', 'comment', 'claim', 'coverage'] as FactKind[]) {
      expect(PAGE_KINDS).not.toContain(kind);
    }
    // The rule is answered from an id alone, which is what a publication's own record needs.
    expect(isPageId(facts.module.id)).toBe(true);
    expect(isPageId(facts.file.id)).toBe(false);
    expect(isPageId('not a fact id')).toBe(false);
  });

  test('a publication touches the pages of the nodes its facts are and name, and no others', () => {
    const touched = pagesTouchedBy([facts.module, facts.placed, facts.holds, facts.calls, facts.claim, facts.rule, facts.coverage, facts.question, facts.file, facts.endpoint, facts.variable, facts.provides, facts.consumes, facts.binds]);
    // The module, the two symbols and the variable the edges and the claim name, and the rule's and the question's
    // own pages: the coverage (a kind with no page) and the file (a place) wake nobody of their own.
    expect([...touched]).toEqual([facts.endpoint.id, facts.module.id, facts.placed.id, facts.question.id, facts.rule.id, facts.total.id, facts.variable.id].sort(byCodePoint));
    expect(touched).not.toContain(facts.coverage.id);
    expect(touched).not.toContain(facts.file.id);
  });
});

describe('the page set of a product', () => {
  test('holds every page-worthy node the product\'s units published, in code point order of the kind, the label and the id', async () => {
    const set = await readPageSet({ database: world!.owner, product: PRODUCT, folder: world!.folder });
    const labelled = set.pages.map((page) => `${page.kind}:${page.label}`);
    expect(labelled).toEqual([...labelled].sort(byCodePoint));
    expect(set.pages.map((page) => page.id).sort(byCodePoint))
      .toEqual([facts.endpoint.id, facts.module.id, facts.placed.id, facts.question.id, facts.rule.id, facts.total.id, facts.variable.id].sort(byCodePoint));
    expect(set.total).toBe(7);
    expect(set.counts).toEqual([
      { kind: 'api-endpoint', count: 1 },
      { kind: 'environment-variable', count: 1 },
      { kind: 'module', count: 1 },
      { kind: 'question', count: 1 },
      { kind: 'rule', count: 1 },
      { kind: 'symbol', count: 2 },
    ]);
    // A fact of a kind with no page is no page, and the empty message is not there when the set holds one.
    expect(set.pages.map((page) => page.id)).not.toContain(facts.file.id);
    expect(set.message).toBeNull();
    expect(set.product).toBe(PRODUCT);
    expect(set.changeSeq).toBeGreaterThan(0);
  });

  test('a node names its page and its code place at the pinned commit', async () => {
    const set = await readPageSet({ database: world!.owner, product: PRODUCT, folder: world!.folder });
    const module = set.pages.find((page) => page.id === facts.module.id);
    expect(module).toEqual({
      id: facts.module.id,
      kind: 'module',
      label: 'checkout',
      page: pageAddress(facts.module.id),
      layer: 'extracted',
      status: 'proposed',
      code: { repository: 'acme-shop', commit: 'a'.repeat(40), file: 'src/checkout.ts', startLine: 1, endLine: 40 },
    });
    // A node whose kind carries no rank has no rank field at all, rather than a null one.
    expect(Object.hasOwn(module!, 'importance')).toBe(false);
    // The address is the app's own page route and the node's fact id whole: the one address madarch-tzte.23.2's
    // diagram elements carry too (`graphPageHref`, the same function).
    expect(module?.page).toBe(`/p/graph/${facts.module.id}`);
  });

  test('an empty graph answers an empty set with the what-to-do message, never an error', async () => {
    const empty = await readPageSet({ database: world!.owner, product: 'a product nothing filled', folder: '/nowhere' });
    expect(empty.pages).toEqual([]);
    expect(empty.counts).toEqual([]);
    expect(empty.total).toBe(0);
    expect(empty.changeSeq).toBe(0);
    expect(empty.message).toContain('no page-worthy node');
    expect(empty.message).toContain('a product nothing filled');
    // The answer a browser reads names no machine path.
    expect(empty.message).not.toContain('/nowhere');
  });

  test('a home whose fill never ran holds no page set, answers the message, and opens no database of its own', async () => {
    const { createFillOrchestratorService } = await import('../src/fill/orchestrator-host.js');
    const { StageRegistry } = await import('../src/fill/registry.js');
    const home = await mkdtemp(join(tmpdir(), 'madarch-graph-pages-empty-'));
    try {
      const folder = join(home, 'product');
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, 'workspace.yaml'), `schemaVersion: 1\nid: 3f6d2dc8-b16e-4bf0-9d3a-2c9c00b5287d\nname: ${PRODUCT}\n`);
      const service = createFillOrchestratorService({ home, registry: new StageRegistry() });
      const set = await service.pages(folder).pageSet();
      expect(set.pages).toEqual([]);
      expect(set.total).toBe(0);
      expect(set.message).toContain('no page-worthy node');
      expect(set.message).not.toContain(folder);
      expect((await service.pages(folder).page(facts.module.id)).ok).toBe(false);
      expect(existsSync(join(home, '.madarch'))).toBe(false);
      await service.stop();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('a page is its own product\'s', () => {
  test('a claim, a rule and a package another product publishes in one home never reach this product\'s pages', async () => {
    // The other product declares the same repository and holds the same module, so the module's id is its own too.
    const other = graphFacts();
    expect(other.module.id).toBe(facts.module.id);
    const foreignClaim = makeNodeFact({
      kind: 'claim',
      value: { subject: { form: 'node', id: other.module.id }, predicate: 'other-product-states', object: { form: 'literal', text: 'not this product' } },
      provenance: provenance('src/checkout.ts', { startLine: 33, endLine: 33 }),
      layer: 'inferred',
    });
    const foreignPackage = makeNodeFact({
      kind: 'package',
      value: { repository: 'acme-shop', name: '@other/product-only', form: 'package' },
      provenance: provenance('package.json', { startLine: 1, endLine: 3 }),
      layer: 'extracted',
    });
    const unit = await publishForAnotherProduct(world!.owner, 'Other Product', [other.module, foreignClaim, foreignPackage]);
    expect(unit).toContain('other-stage');

    const set = await readPageSet({ database: world!.owner, product: PRODUCT, folder: world!.folder });
    expect(set.pages.map((page) => page.id)).not.toContain(foreignPackage.id);
    const read = await readPageModel({ database: world!.owner, product: PRODUCT, id: facts.module.id });
    if (!read.ok) throw new Error(`the module's page was refused: ${read.code}: ${read.message}`);
    expect(read.page.assumptions.map((fact) => fact.id)).not.toContain(foreignClaim.id);
    // The other product's page does hold it: the fact stands in the store, and only this product's page leaves it out.
    const theirs = await readPageModel({ database: world!.owner, product: 'Other Product', id: facts.module.id });
    if (!theirs.ok) throw new Error(`the other product's page was refused: ${theirs.code}: ${theirs.message}`);
    expect(theirs.page.assumptions.map((fact) => fact.id)).toContain(foreignClaim.id);
  });
});

describe('one node\'s page model', () => {
  test('holds its facts with code links, its assumptions kept apart, its relations both ways, its coverage, its questions and its drafts marked as draft', async () => {
    // A unit of another stage of the same product holds a draft about the module: a page shows it as a draft.
    const draftUnit = 'agent/checkout';
    await createUnit(world!.owner, { unitId: draftUnit, product: PRODUCT, runId: 'run-draft', stageId: 'agent', scopeKey: 'checkout', inputsDigest: 'draft-inputs', retries: 0, at: 1_700_000_000_000 });
    await recordUnitPlan(world!.owner, { unitId: draftUnit, generation: 1, runId: 'run-draft', stageId: 'agent', stageUnitId: 'checkout', scope: 'acme-shop:src/checkout.ts', stagePosition: 1, planPosition: 1, at: 1_700_000_000_000 });
    const drafted = makeNodeFact({
      kind: 'claim',
      value: { subject: { form: 'node', id: facts.module.id }, predicate: 'states', object: { form: 'literal', text: 'one order at a time' }, text: 'the module states a rule' },
      provenance: provenance('src/checkout.ts', { startLine: 14, endLine: 14 }),
      layer: 'inferred',
    });
    await recordUnitDraft(world!.owner, { unitId: draftUnit, generation: 1, writes: [writeOf(drafted)], at: 1_700_000_000_100 });

    const read = await readPageModel({ database: world!.owner, product: PRODUCT, id: facts.module.id });
    if (!read.ok) throw new Error(`the module's page was refused: ${read.code}: ${read.message}`);
    const page = read.page;
    expect(page.product).toBe(PRODUCT);
    expect(page.node.id).toBe(facts.module.id);
    expect(page.value).toEqual({ repository: 'acme-shop', name: 'checkout', seed: 'package' });
    // The node's own fact is the first of its facts, and every fact carries the layer and status it stands at.
    expect(page.facts.map((fact) => `${fact.kind}:${fact.layer}:${fact.status}`)).toEqual(['module:extracted:proposed']);
    expect(page.facts[0]!.code).toEqual({ repository: 'acme-shop', commit: 'a'.repeat(40), file: 'src/checkout.ts', startLine: 1, endLine: 40 });
    // An agent's interpretation is no fact of the page: the claim and the rule stand apart, as assumptions.
    expect(page.assumptions.map((fact) => fact.kind).sort(byCodePoint)).toEqual(['claim', 'rule']);
    expect(page.assumptions.every((fact) => fact.layer === 'inferred')).toBe(true);
    expect(page.assumptions.find((fact) => fact.kind === 'claim')?.code).toEqual({ repository: 'acme-shop', commit: 'a'.repeat(40), file: 'src/checkout.ts', startLine: 12, endLine: 12 });
    // A claim names two ends, and the page resolves both to the nodes they are, so a reader can open their pages.
    expect(page.assumptions.find((fact) => fact.kind === 'claim')?.ends).toEqual({
      subject: { id: facts.module.id, kind: 'module', label: 'checkout', file: 'src/checkout.ts', line: 1, page: pageAddress(facts.module.id) },
      object: { id: facts.placed.id, kind: 'symbol', label: 'acme-shop:src/checkout.ts#checkout.place', file: 'src/checkout.ts', line: 12, page: pageAddress(facts.placed.id) },
    });
    // The containment and the endpoint the module provides stand out of it; the contract the edge names is the
    // endpoint's own identity, and the page links the endpoint's page.
    expect(page.relations.out.map((relation) => `${relation.edge.kind}->${relation.node?.label ?? relation.end}`))
      .toEqual(['contains->acme-shop:src/checkout.ts#checkout.place', 'provides->http::POST::/orders/{}']);
    const provided = page.relations.out.find((relation) => relation.edge.kind === 'provides');
    expect(provided?.node?.id).toBe(facts.endpoint.id);
    // A node a page names carries the address of its page when its kind has one, so a client links it and never
    // asks for a page that does not exist.
    expect(provided?.node?.page).toBe(pageAddress(facts.endpoint.id));
    expect(page.relations.out.find((relation) => relation.edge.kind === 'contains')?.node?.page).toBe(pageAddress(facts.placed.id));
    expect(page.relations.in).toEqual([]);
    // The coverage names the module as its scope, with the gap it did not read.
    expect(page.coverageScopes).toContain(facts.module.id);
    expect(page.coverage.map((row) => `${row.scope}:${row.complete}:${row.unread.map((gap) => gap.what).join(',')}`)).toEqual([`${facts.module.id}:false:src/refunds.ts`]);
    expect(page.questions.map((question) => `${question.type}:${question.prompt}`)).toEqual(['assumption-check:is the total used anywhere?']);
    expect(page.drafts.map((draft) => `${draft.asDraft}:${draft.unit}:${draft.fact.id}`)).toEqual([`true:${draftUnit}:${drafted.id}`]);
    expect(page.counts).toEqual({ facts: 1, assumptions: 2, out: 2, in: 0, coverage: 1, questions: 1, drafts: 1 });
    expect(page.truncated).toBe(false);
    expect(page.marker).toBeNull();
    expect(page.tokens).toBeGreaterThan(0);
  });

  test('a page of a symbol names the calls that come and go, both ways', async () => {
    const read = await readPageModel({ database: world!.owner, product: PRODUCT, id: facts.placed.id });
    if (!read.ok) throw new Error(`the symbol's page was refused: ${read.code}: ${read.message}`);
    // The symbol calls another, consumes a variable (a node whose page it links) and is held by its module.
    expect(read.page.relations.out.map((relation) => relation.edge.kind)).toEqual(['call', 'consumes']);
    expect(read.page.relations.out.find((relation) => relation.edge.kind === 'consumes')?.node?.label).toBe('ORDERS_TOPIC');
    expect(read.page.relations.in.map((relation) => relation.edge.kind)).toEqual(['contains']);
    expect(read.page.relations.in[0]!.node?.label).toBe('checkout');
  });

  test('a relation whose other end is no node says what it names, and never names the page itself', async () => {
    const read = await readPageModel({ database: world!.owner, product: PRODUCT, id: facts.variable.id });
    if (!read.ok) throw new Error(`the variable's page was refused: ${read.code}: ${read.message}`);
    // The variable is consumed by a symbol (a node) and bound to an environment's name (no node).
    expect(read.page.relations.in.map((relation) => relation.node?.label ?? relation.end)).toEqual(['acme-shop:src/checkout.ts#checkout.place']);
    expect(read.page.relations.out.map((relation) => `${relation.edge.kind}:${relation.end ?? relation.node?.label}`)).toEqual(['binds:production']);
    for (const relation of [...read.page.relations.in, ...read.page.relations.out]) {
      expect(relation.node !== undefined || relation.end !== undefined).toBe(true);
    }
  });

  test('a list longer than the page\'s cap is cut by that cap, and the page says so', async () => {
    const read = await readPageModel({ database: world!.owner, product: PRODUCT, id: facts.module.id, limits: { answerTokens: 120 } });
    if (!read.ok) throw new Error(`the module's page was refused: ${read.code}: ${read.message}`);
    expect(read.page.truncated).toBe(true);
    expect(read.page.marker).toContain('truncated');
    expect(read.page.marker).toContain('120-token cap');
  });

  test('its drafts are in code point order of the holding unit, never the database\'s collation', async () => {
    // Two units whose ids differ only in the case of their first letter: a database ordering text by its own
    // collation puts "alpha" first, and this store's order is code point order, where "Zeta" comes first.
    for (const unitId of ['Zeta/late', 'alpha/early']) {
      await createUnit(world!.owner, { unitId, product: PRODUCT, runId: `run-${unitId}`, stageId: 'agent', scopeKey: unitId, inputsDigest: `inputs-${unitId}`, retries: 0, at: 1_700_000_001_000 });
      await recordUnitPlan(world!.owner, { unitId, generation: 1, runId: `run-${unitId}`, stageId: 'agent', stageUnitId: unitId, scope: 'acme-shop', stagePosition: 1, planPosition: 1, at: 1_700_000_001_000 });
      const write = makeNodeFact({
        kind: 'question',
        value: { repository: 'acme-shop', type: 'unverifiable', about: facts.module.id, prompt: `${unitId} asks about the module` },
        provenance: provenance('src/checkout.ts', { startLine: 21, endLine: 21 }),
        layer: 'inferred',
      });
      await recordUnitDraft(world!.owner, { unitId, generation: 1, writes: [writeOf(write)], at: 1_700_000_001_100 });
    }
    const read = await readPageModel({ database: world!.owner, product: PRODUCT, id: facts.module.id });
    if (!read.ok) throw new Error(`the module's page was refused: ${read.code}: ${read.message}`);
    // Code point order: "Zeta/late" (Z is 0x5A) before "agent/checkout" before "alpha/early"; a database's own
    // collation would put "Zeta/late" last.
    expect(read.page.drafts.map((draft) => draft.unit)).toEqual(['Zeta/late', 'agent/checkout', 'alpha/early']);
  });

  test('a node the graph does not hold, and a fact of a kind with no page, are refused by name', async () => {
    const missing = await readPageModel({ database: world!.owner, product: PRODUCT, id: `module:${'f'.repeat(64)}` });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.code).toBe('graph-pages/no-such-node');
    expect(missing.message).toContain(`module:${'f'.repeat(64)}`);

    const place = await readPageModel({ database: world!.owner, product: PRODUCT, id: facts.file.id });
    expect(place.ok).toBe(false);
    if (place.ok) return;
    expect(place.code).toBe('graph-pages/not-a-page');
    expect(place.message).toContain('"file"');
    expect(place.message).toContain('module');

    const nonsense = await readPageModel({ database: world!.owner, product: PRODUCT, id: 'not-a-fact-id' });
    expect(nonsense.ok).toBe(false);
    if (nonsense.ok) return;
    expect(nonsense.code).toBe('graph-pages/not-a-fact-id');
  });
});

describe('the pages a publication touched', () => {
  test('the first publication\'s record names exactly the pages its facts are and name', async () => {
    const changes = await readPageChanges({ database: world!.owner, product: PRODUCT, after: 0 });
    expect(changes.changes).toHaveLength(1);
    expect(changes.changes[0]!.nodes).toEqual([facts.endpoint.id, facts.module.id, facts.placed.id, facts.question.id, facts.rule.id, facts.total.id, facts.variable.id].sort(byCodePoint));
    expect(changes.changes[0]!.unitId).toBe('graph-fixture/src');
    expect(changes.changes[0]!.generation).toBe(1);
    expect(changes.truncated).toBe(false);
    expect(changes.marker).toBeNull();
  });

  test('a read bounded at exactly the rows it holds cuts nothing and says nothing', async () => {
    const all = await readPageChanges({ database: world!.owner, product: PRODUCT, after: 0 });
    const rows = all.changes.reduce((total, change) => total + change.nodes.length, 0);
    const exact = await readPageChanges({ database: world!.owner, product: PRODUCT, after: 0, limit: rows });
    expect(exact.changes).toEqual(all.changes);
    expect(exact.truncated).toBe(false);
    expect(exact.marker).toBeNull();
    // One row fewer is a cut, and it says so, naming the bound and where to read on from; the change the bound
    // falls inside is the one publication this store holds, and it is answered as it stands rather than left out.
    const cut = await readPageChanges({ database: world!.owner, product: PRODUCT, after: 0, limit: rows - 1 });
    expect(cut.truncated).toBe(true);
    expect(cut.marker).toContain('truncated');
    expect(cut.marker).toContain(`${rows - 1} page rows`);
  });
});

describe('a fact another product still holds', () => {
  test('is gone from this product\'s graph, so its page is announced here and not on the other product\'s channel', async () => {
    const all = graphFacts();
    let held: readonly Fact[] = [all.module, all.placed, all.holds, all.calls];
    const own = await openGraphFixture({ drafts: () => held.map((fact) => writeOf(fact)) });
    try {
      const first = await own.service.run({ product: { name: PRODUCT, folder: own.folder }, runId: 'run-shared-1' });
      if (first.ok === false) throw new Error(`the first run was refused: ${first.code}: ${first.reason}`);
      // The other product's unit publishes the same module and the same containment: the ids are the graph's own.
      await publishForAnotherProduct(own.owner, 'Other Product', [all.module, all.placed, all.holds]);
      const oursBefore = (await readPageChanges({ database: own.owner, product: PRODUCT, after: 0 })).lastSeq;
      const theirsBefore = (await readPageChanges({ database: own.owner, product: 'Other Product', after: 0 })).lastSeq;
      // This product's unit publishes again without them, and the store keeps the rows the other product still holds.
      held = [all.placed, all.calls];
      own.repin(LATER_COMMIT);
      const second = await own.service.run({ product: { name: PRODUCT, folder: own.folder }, runId: 'run-shared-2' });
      if (second.ok === false) throw new Error(`the second run was refused: ${second.code}: ${second.reason}`);
      const ours = await readPageChanges({ database: own.owner, product: PRODUCT, after: oursBefore });
      expect(ours.changes).toHaveLength(1);
      // The module's page is announced here although another product keeps the row: this product's graph lost it.
      expect(ours.changes[0]!.nodes).toEqual([all.module.id, all.placed.id, all.total.id].sort(byCodePoint));
      // The other product's graph did not change, so its channel hears nothing, and its pages still show the edge.
      const theirs = await readPageChanges({ database: own.owner, product: 'Other Product', after: theirsBefore });
      expect(theirs.changes).toEqual([]);
      expect((await readPageModel({ database: own.owner, product: PRODUCT, id: all.module.id })).ok).toBe(false);
      const stillTheirs = await readPageModel({ database: own.owner, product: 'Other Product', id: all.module.id });
      if (!stillTheirs.ok) throw new Error(`the other product's page was refused: ${stillTheirs.code}: ${stillTheirs.message}`);
      expect(stillTheirs.page.relations.out.map((relation) => relation.edge.kind)).toEqual(['contains']);
    } finally {
      await own.close();
    }
  }, 120_000);

  test('a service that was stopped reads no page and says so, rather than claiming the graph is empty', async () => {
    const { createFillOrchestratorService } = await import('../src/fill/orchestrator-host.js');
    const { StageRegistry } = await import('../src/fill/registry.js');
    const home = await mkdtemp(join(tmpdir(), 'madarch-graph-pages-stopped-'));
    try {
      const folder = join(home, 'product');
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, 'workspace.yaml'), `schemaVersion: 1\nid: 3f6d2dc8-b16e-4bf0-9d3a-2c9c00b5287d\nname: ${PRODUCT}\n`);
      const service = createFillOrchestratorService({ home, registry: new StageRegistry() });
      const pages = service.pages(folder);
      await service.stop();
      await expect(pages.pageSet()).rejects.toThrow(/the fill service was stopped/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('the answers a service keeps between publications', () => {
  test('a page set and a page are answered from what the service read, and a publication gives new ones', async () => {
    // A world of its own: the publication that adds a module must not move the pages the tests above read.
    const all = graphFacts();
    let held: readonly Fact[] = [all.placed, all.total, all.calls, all.file];
    const own = await openGraphFixture({ drafts: () => held.map((fact) => writeOf(fact)) });
    try {
      const first = await own.service.run({ product: { name: PRODUCT, folder: own.folder }, runId: 'run-kept-1' });
      if (first.ok === false) throw new Error(`the first run was refused: ${first.code}: ${first.reason}`);
      const source = own.service.pages(own.folder);
      const set = await source.pageSet();
      // The same answer, not a second read of the store: a page set of the current madarch tree costs minutes to read
      // (madarch-tzte.23.8 measured 276 618 ms), and nothing published since it was read.
      expect(await source.pageSet()).toBe(set);
      expect(set.total).toBe(2);
      const missing = await source.page(all.module.id);
      expect(missing.ok).toBe(false);
      // A publication lands: the cache is dropped by the same event that wakes the live channel, so the set grows.
      held = [all.module, all.placed, all.total, all.calls, all.file];
      own.repin(LATER_COMMIT);
      const second = await own.service.run({ product: { name: PRODUCT, folder: own.folder }, runId: 'run-kept-2' });
      if (second.ok === false) throw new Error(`the second run was refused: ${second.code}: ${second.reason}`);
      const after = await source.pageSet();
      expect(after).not.toBe(set);
      expect(after.total).toBe(3);
      expect(after.pages.map((page) => page.kind)).toEqual(['module', 'symbol', 'symbol']);
      const module = await source.page(all.module.id);
      expect(module.ok).toBe(true);
      // The page too is answered from what the service read, until the next publication: the model is one object.
      const again = await source.page(all.module.id);
      expect(module.ok && again.ok ? again.page === module.page : false).toBe(true);
    } finally {
      await own.close();
    }
  }, 120_000);
});

describe('a publication that stops holding facts', () => {
  test('touches the pages it named, and only those, and the pages follow', async () => {
    // A world of its own: the run that stops holding the module must not move the pages the tests above read.
    const all = graphFacts();
    let held: readonly Fact[] = everything(all);
    const own = await openGraphFixture({ drafts: () => held.map((fact) => writeOf(fact)) });
    try {
      const first = await own.service.run({ product: { name: PRODUCT, folder: own.folder }, runId: 'run-drop-1' });
      if (first.ok === false) throw new Error(`the first run was refused: ${first.code}: ${first.reason}`);
      const before = (await readPageChanges({ database: own.owner, product: PRODUCT, after: 0 })).lastSeq;
      // The unit publishes again with a moved input and stops holding the module, the rule, the question and the
      // edges that named them.
      held = [all.placed, all.total, all.calls, all.file, all.variable];
      own.repin(LATER_COMMIT);
      const second = await own.service.run({ product: { name: PRODUCT, folder: own.folder }, runId: 'run-drop-2' });
      if (second.ok === false) throw new Error(`the second run was refused: ${second.code}: ${second.reason}`);
      const changes = await readPageChanges({ database: own.owner, product: PRODUCT, after: before });
      expect(changes.changes).toHaveLength(1);
      // A bound that holds the first publication whole and only part of the second answers the first and no
      // fragment of the second: a change names every page its publication touched, or it is not answered yet.
      const firstOnly = await readPageChanges({ database: own.owner, product: PRODUCT, after: 0, limit: 7 });
      expect(firstOnly.changes).toHaveLength(1);
      expect(firstOnly.changes[0]!.unitId).toBe('graph-fixture/src');
      expect(firstOnly.changes[0]!.nodes).toHaveLength(7);
      expect(firstOnly.truncated).toBe(true);
      const change = changes.changes[0]!;
      expect(change.generation).toBe(2);
      // The module, the rule and the question are gone, and the pages of the symbols and the variable whose facts
      // the publication repeats come with them; the file is no page.
      expect(change.nodes).toEqual([all.endpoint.id, all.module.id, all.placed.id, all.question.id, all.rule.id, all.total.id, all.variable.id].sort(byCodePoint));
      expect(changes.lastSeq).toBeGreaterThan(before);
      const set = await readPageSet({ database: own.owner, product: PRODUCT, folder: own.folder });
      expect(set.pages.map((page) => page.kind)).toEqual(['environment-variable', 'symbol', 'symbol']);
      expect((await readPageModel({ database: own.owner, product: PRODUCT, id: all.module.id })).ok).toBe(false);
    } finally {
      await own.close();
    }
  }, 120_000);
});
