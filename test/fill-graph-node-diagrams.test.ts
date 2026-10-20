/**
 * One node's diagrams, read from the fill's fact store (madarch-tzte.23.8): the read a
 * page's diagram slot asks for, over a real fill service and its PGlite store.
 *
 * The values here are decision 0026's and madarch-tzte.23.4's, not this code's: a
 * page draws the diagrams its node's kind stands in, a fact is solid and an
 * unresolved end dashed, and the answer names the same node entry the page model
 * names. The one thing this change adds is what the read *is*: madarch-tzte.23.8
 * measured a diagrams ask paying for a whole page model on top of the models it built,
 * and the read was narrowed to the node's own fact — so a page's diagrams are a
 * function of the published graph alone, and a page read that fails (a draft set the
 * schema refuses) cannot take a page's diagrams with it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readNodeDiagrams } from '../src/fill/graph-diagrams.js';
import { readPageModel } from '../src/fill/graph-pages.js';
import { makeNodeFact, type Fact } from '../src/fill/facts.js';
import { recordUnitDraft, recordUnitPlan } from '../src/fill/orchestrator-store.js';
import { createUnit } from '../src/fill/state-store.js';
import { graphFacts, openGraphFixture, PRODUCT, provenance, writeOf, type GraphFixtureFacts, type GraphFixtureWorld } from './graph-pages-fixture.js';

let world: GraphFixtureWorld | undefined;
let facts: GraphFixtureFacts;
let packaged: Fact;
/** The code repository the fixture's nodes stand in: a module's diagrams are the views of the repository it is in. */
let engine: Fact;

beforeAll(async () => {
  facts = graphFacts();
  packaged = makeNodeFact({ kind: 'package', value: { repository: 'acme-shop', name: '@acme/checkout', form: 'package', ecosystem: 'npm' }, provenance: provenance('package.json', { startLine: 1, endLine: 6 }), layer: 'extracted' });
  engine = makeNodeFact({ kind: 'repository', value: { repository: 'acme-shop', form: 'code' }, provenance: provenance('package.json', { startLine: 1, endLine: 6 }), layer: 'extracted' });
  const published = [engine, facts.module, facts.placed, facts.total, facts.calls, facts.holds, packaged];
  world = await openGraphFixture({ drafts: () => published.map((fact) => writeOf(fact)) });
  const run = await world.service.run({ product: { name: PRODUCT, folder: world.folder }, runId: 'run-diagrams-read' });
  if (run.ok === false) throw new Error(`the fixture's run was refused: ${run.code}: ${run.reason}`);
}, 180_000);

afterAll(async () => {
  await world?.close();
});

/** One diagram answer the fixture's service gives, or the failure naming the node. */
async function diagramsOf(id: string): Promise<ReturnType<typeof readNodeDiagrams>> {
  return await world!.service.pages(world!.folder).diagrams(id);
}

describe('the diagrams of one node', () => {
  test('a module is drawn among its siblings by the two views its kind stands in, and names the same node entry its page does', async () => {
    const read = await diagramsOf(facts.module.id);
    if (!read.ok) throw new Error(`the module's diagrams were refused: ${read.code}: ${read.message}`);
    expect(read.diagrams.map((diagram) => diagram.spec.type)).toEqual(['c4-component', 'module-dependency']);
    const page = await readPageModel({ database: world!.owner, product: PRODUCT, id: facts.module.id });
    if (!page.ok) throw new Error(`the module's page was refused: ${page.code}: ${page.message}`);
    // The same entry the page model carries: a client that asks both pays for the page once and reads one node here.
    expect(read.node).toEqual(page.page.node);
    expect(read.page).toBe(page.page.page);
    expect(read.product).toBe(PRODUCT);
    expect(typeof read.readAt).toBe('number');
  });

  test('a repository is the product\'s context, its containers, its modules and its tables; a package is the container it is', async () => {
    const repository = await diagramsOf(facts.module.id.slice(0, 0) + `repository:${'9'.repeat(64)}`);
    // The fixture publishes no repository fact: the node the graph does not hold is a page that stands nowhere.
    expect(repository.ok).toBe(false);
    if (repository.ok === false) expect(repository.code).toBe('graph-pages/no-such-node');
    const pack = await diagramsOf(packaged.id);
    if (!pack.ok) throw new Error(`the package's diagrams were refused: ${pack.code}: ${pack.message}`);
    expect(pack.diagrams.map((diagram) => diagram.spec.type)).toEqual(['c4-container']);
  });

  test('a node the graph does not hold, a kind with no page and an id that is no fact id are refused in the page model\'s own words', async () => {
    const absent = await diagramsOf(`module:${'f'.repeat(64)}`);
    expect(absent.ok).toBe(false);
    if (absent.ok === false) {
      expect(absent.code).toBe('graph-pages/no-such-node');
      expect(absent.message).toContain(`module:${'f'.repeat(64)}`);
    }
    const notAPage = await diagramsOf(facts.file.id);
    expect(notAPage.ok).toBe(false);
    if (notAPage.ok === false) {
      expect(notAPage.code).toBe('graph-pages/not-a-page');
      expect(notAPage.message).toContain('"file"');
    }
    const malformed = await diagramsOf('module:not-a-digest');
    expect(malformed.ok).toBe(false);
    if (malformed.ok === false) expect(malformed.code).toBe('graph-pages/not-a-fact-id');
  });

  test('a page read that fails leaves the diagrams of that node standing: they are the published graph\'s, never a draft set\'s', async () => {
    // A draft set of another unit whose write the schema refuses: the page model refuses it by name (0026 keeps a
    // draft a run's units see, and a page shows what it can read), and the diagrams are unaffected either way.
    const unitId = 'agent/damaged';
    await createUnit(world!.owner, { unitId, product: PRODUCT, runId: 'run-damaged', stageId: 'agent', scopeKey: 'acme-shop', inputsDigest: 'damaged-inputs', retries: 0, at: 1_700_000_000_000 });
    await recordUnitPlan(world!.owner, { unitId, generation: 1, runId: 'run-damaged', stageId: 'agent', stageUnitId: 'acme-shop', scope: 'acme-shop', stagePosition: 1, planPosition: 1, at: 1_700_000_000_000 });
    await recordUnitDraft(world!.owner, {
      unitId,
      generation: 1,
      at: 1_700_000_000_100,
      // The write names the node's own id, so the page's drafts read judges it — and the schema refuses it (no
      // provenance, no layer, no value): the page refuses to show a draft set the schema refuses.
      writes: [{ kind: 'fact' as const, evidence: 'src/checkout.ts:12', value: { kind: 'module', id: facts.module.id } as unknown as Fact }],
    });
    const page = await readPageModel({ database: world!.owner, product: PRODUCT, id: facts.module.id });
    expect(page.ok).toBe(false);
    const read = await diagramsOf(facts.module.id);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.diagrams.map((diagram) => diagram.spec.type)).toEqual(['c4-component', 'module-dependency']);
  });
});
