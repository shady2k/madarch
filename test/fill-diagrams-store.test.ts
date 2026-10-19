/**
 * The diagram models over the landed fact store (madarch-tzte.23.2): the same
 * graph the pure suite makes, published through the store's own sink
 * (`applyPublishedFacts`) and read back through `factStoreDiagramReads` — the
 * reads a served page will make. Here the SQL is what is under test: the
 * `contains` walk that rolls a file up to its module, the repository join that
 * finds the relations of a product's scope, and the facts answered by a value
 * field. The expectations are the pure suite's own, taken from the task, from
 * decision 0026 and from the schema's kinds.
 *
 * The graph is one this test makes with the schema's constructors and publishes
 * into a PGlite of its own, so nothing here reads this checkout.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { buildDiagram, buildFactStoreDiagram, factStoreDiagramReads, type DiagramGraphReads } from '../src/fill/diagrams.js';
import { applyPublishedFacts, createFactStoreSchema } from '../src/fill/fact-store.js';
import { makeEdgeFact, repositoryPath, type Fact } from '../src/fill/facts.js';
import { createOrchestratorSchema, type UnitPlanRecord } from '../src/fill/orchestrator-store.js';
import { createFillStateSchema, createUnit, readUnit } from '../src/fill/state-store.js';
import { DIAGRAM_FIXTURE } from './fill-diagram-fixture.js';

const NOW = 1_700_000_000_000;
const PRODUCT = 'fixture-product';
/** The unit that publishes the graph a product holds, and the one that later publishes an edge into a file no unit holds. */
const BASE_UNIT = 'diagrams/base';
const UNRESOLVED_UNIT = 'diagrams/unresolved';
/** The unit that publishes a second module holding a file an arrow already rolls up: two ancestors at one depth. */
const TIE_UNIT = 'diagrams/tie';

const fx = DIAGRAM_FIXTURE;
let owner: DatabaseOwner | undefined;
let reads: DiagramGraphReads;

/** Publishes one unit's facts through the store's own sink, in the transaction the orchestrator's publication holds. */
async function publish(database: DatabaseOwner, unitId: string, digest: string, facts: readonly Fact[]): Promise<number> {
  const unit = await readUnit(database, unitId);
  if (unit === null) throw new Error(`the fixture publishes the unit "${unitId}", which the store does not hold`);
  const plan: UnitPlanRecord = {
    unitId,
    generation: unit.generation,
    runId: unit.runId,
    stageId: 'diagrams',
    stageUnitId: unitId,
    scope: unitId,
    stagePosition: 0,
    planPosition: 0,
    plannedAt: NOW,
  };
  return await database.transaction('write', async (executor) => await applyPublishedFacts({
    executor,
    unit,
    plan,
    digest,
    writes: facts.map((fact) => ({ kind: 'fact' as const, evidence: 'src/cart.ts:1', value: fact })),
  }));
}

beforeAll(async () => {
  const database = createPGliteDatabaseOwner();
  await createFillStateSchema(database);
  await createOrchestratorSchema(database);
  await createFactStoreSchema(database);
  for (const unitId of [BASE_UNIT, UNRESOLVED_UNIT, TIE_UNIT]) {
    await createUnit(database, { unitId, product: PRODUCT, runId: 'run-diagrams', stageId: 'diagrams', scopeKey: unitId, inputsDigest: `${unitId}-inputs`, retries: 0, at: NOW });
  }
  const published = await publish(database, BASE_UNIT, 'publication-base', fx.facts.filter((fact) => fact.id !== fx.orphanImportsGone.id));
  if (published === 0) throw new Error('the fixture published no fact: the store holds no graph to draw from');
  owner = database;
  reads = factStoreDiagramReads(database);
}, 180_000);

afterAll(async () => {
  await owner?.close();
  owner = undefined;
});

describe('the graph the store holds', () => {
  test('two modules with one import between them are two elements and one solid edge', async () => {
    const model = await buildDiagram({ type: 'module-dependency', nodes: [fx.shop.id] }, reads);
    expect(model.elements.map((element) => element.label)).toEqual(['checkout', 'payment']);
    expect(model.edges.map((arrow) => [arrow.from, arrow.to, arrow.label, arrow.dashed])).toEqual([[fx.checkout.id, fx.payment.id, 'import', false]]);
    // The store answers the fact's own provenance: a module's page link and the code place it was measured at.
    const checkout = model.elements.find((element) => element.id === fx.checkout.id);
    expect(checkout?.page?.href).toBe(`/p/graph/${fx.checkout.id}`);
    expect(checkout?.place).toEqual({ repository: 'acme-shop', commit: 'a'.repeat(40), file: 'src/cart.ts', line: 1, endLine: 1 });
  });

  test('the context of the product is its repositories, and the import across them is one arrow', async () => {
    const model = await buildDiagram({ type: 'c4-context', nodes: [] }, reads);
    expect(model.elements.map((element) => element.label)).toEqual(['acme-shop', 'acme-web']);
    expect(model.edges.map((arrow) => [arrow.from, arrow.to, arrow.label])).toEqual([[fx.web.id, fx.shop.id, 'import']]);
  });

  test('the tables of a repository carry the columns the store holds, and a column whose table no fact holds is dashed', async () => {
    const model = await buildDiagram({ type: 'er', nodes: [fx.shop.id] }, reads);
    expect(model.elements.map((element) => element.label)).toEqual(['acme-shop:public.audit', 'acme-shop:public.orders', 'acme-shop:public.payments']);
    const orders = model.elements.find((element) => element.id === fx.ordersTable.id);
    expect(orders?.columns?.map((column) => [column.label, column.dataType])).toEqual([['id', 'bigint'], ['total', 'numeric']]);
    expect(orders?.columns?.[1]?.place).toEqual({ repository: 'acme-shop', commit: 'a'.repeat(40), file: 'migrations/001.sql', line: 5, endLine: 5 });
    expect(model.elements.find((element) => element.label === 'acme-shop:public.audit')?.dashed).toBe(true);
  });

  test('the states of a machine and their transitions come back as the agent wrote them', async () => {
    const model = await buildDiagram({ type: 'state', nodes: [fx.newState.id] }, reads);
    expect(model.elements.map((element) => element.label)).toEqual(['OrderStatus.new', 'OrderStatus.paid', 'OrderStatus.shipped', fx.refundedState.id]);
    expect(model.edges.map((arrow) => `${arrow.label}|${arrow.evidence}`).sort()).toEqual(['pay|assumption', 'refund|unresolved', 'ship|assumption']);
  });

  test('past its budget the view collapses to the repository the modules stand in', async () => {
    const model = await buildDiagram({ type: 'module-dependency', nodes: [fx.web.id] }, reads, { limits: { nodes: 2 } });
    expect(model.elements.map((element) => element.label)).toEqual(['acme-web']);
    expect(model.collapsed).toBe(true);
    expect(model.elements[0]!.standsFor).toEqual([fx.webApp.id, fx.webApi.id, fx.webShared.id].sort());
  });
});

describe('the relations an agent proposed', () => {
  test('a component view draws the interaction between two modules, which the store answers by its own end fields', async () => {
    // The interaction keeps its ends in `caller` and `callee`, and no other edge kind does: a read that joined the
    // `from` field alone would answer none of them and the view would lose every arrow an agent drew.
    const model = await buildDiagram({ type: 'c4-component', nodes: [fx.shop.id] }, reads);
    const named = new Map(model.elements.map((element) => [element.id, element.label]));
    const drawn = (arrow: (typeof model.edges)[number]): string => `${String(named.get(arrow.from))}>${String(named.get(arrow.to))}:${arrow.label}:${arrow.evidence}`;
    expect(model.edges.map(drawn).sort()).toEqual(['checkout>payment:import, interaction:assumption', 'payment>checkout:interaction:assumption']);
  });

  test('a model built inside one transaction answers what the reads answer one by one', async () => {
    const once = await buildFactStoreDiagram({ type: 'module-dependency', nodes: [fx.shop.id] }, owner!);
    const readByRead = await buildDiagram({ type: 'module-dependency', nodes: [fx.shop.id] }, reads);
    expect(once).toEqual(readByRead);
    expect(once.edges.map((arrow) => arrow.label)).toEqual(['import']);
  });
});

describe('an edge into a node no unit holds', () => {
  test('the store answers the edge and not its end, and the view draws the end as unresolved', async () => {
    const published = await publish(owner!, UNRESOLVED_UNIT, 'publication-unresolved', [fx.orphanImportsGone]);
    expect(published).toBe(1);
    const model = await buildDiagram({ type: 'module-dependency', nodes: [fx.shop.id] }, reads);
    const unresolved = model.elements.find((element) => element.kind === null);
    expect(unresolved?.label).toBe(fx.gone.id);
    expect(unresolved?.dashed).toBe(true);
    const arrow = model.edges.find((each) => each.to === unresolved?.id);
    expect([arrow?.label, arrow?.evidence, arrow?.dashed]).toEqual(['import', 'unresolved', true]);
  });
});

describe('the containment walk', () => {
  test('two ancestors at one depth come back in code point order of their ids, and the repository last', async () => {
    // A second module holds the file the import starts at: two ancestors at depth 1. The order is this module's own and
    // never the database's collation, which is what tells the two modules apart when an arrow rolls the file up.
    const contains = makeEdgeFact({
      kind: 'contains',
      value: { from: fx.payment.id, to: fx.cart.id },
      provenance: { source: { system: 'fill-stage-5', version: '1.0.0' }, repository: { id: 'acme-shop', commit: 'a'.repeat(40) }, place: { file: repositoryPath('src/cart.ts'), range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 10 } } },
      layer: 'extracted',
    });
    const published = await publish(owner!, TIE_UNIT, 'publication-tie', [contains]);
    expect(published).toBe(1);
    const chain = (await reads.ancestors([fx.cart.id])).get(fx.cart.id) ?? [];
    const above = chain.filter((each) => each.kind !== 'repository');
    expect(above.map((each) => each.id)).toEqual([fx.checkout.id, fx.payment.id].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));
    expect(chain[chain.length - 1]?.id).toBe(fx.shop.id);
  });
});
