/**
 * The edges one node stands at the end of, read out of the store (madarch-tzte.23.8):
 * the read a page's relations are made of, over a graph that carries each shape an
 * edge's end takes — a plain fact id (`import`), a variable (`consumes`), a caller and a
 * callee (`interaction`), and a document link's term, which names a node in `{form, id}`.
 *
 * The read asks the store by containment (`value @> {"to": …}`) so that one index of an
 * edge fact's value answers it; the values here are the schema's own shapes
 * (`EDGE_END_FIELDS`, `src/fill/graph-reads.ts`), and the case that matters is a
 * document link: its end is a term, so the question asked of the store is
 * `{"to": {"id": …}}` and not `{"to": …}` — a read that asked the plain one would answer
 * every other edge and silently drop this one.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { applyPublishedFacts, createFactStoreSchema } from '../src/fill/fact-store.js';
import { FACT_EDGE_KINDS, makeEdgeFact, makeNodeFact, repositoryPath, type Fact } from '../src/fill/facts.js';
import { answerGraphRead } from '../src/fill/graph-reads.js';
import { createOrchestratorSchema, type UnitPlanRecord } from '../src/fill/orchestrator-store.js';
import { createFillStateSchema, createUnit, readUnit } from '../src/fill/state-store.js';

const PRODUCT = 'adjacent-product';
const UNIT = 'adjacent/base';
const COMMIT = 'a'.repeat(40);
const REPOSITORY = 'acme-shop';

/** One fact's provenance: read out of a file of the repository at the commit. */
const provenance = (file: string): Fact['provenance'] => ({
  source: { system: 'tree-sitter', version: '1.0.0' },
  repository: { id: REPOSITORY, commit: COMMIT },
  place: { file: repositoryPath(file), range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 } },
});

let owner: DatabaseOwner | undefined;
const symbol = (): Fact => makeNodeFact({ kind: 'symbol', value: { repository: REPOSITORY, file: repositoryPath('src/a.ts'), qualifiedName: 'a.one', symbolKind: 'function' }, provenance: provenance('src/a.ts'), layer: 'extracted' });
const other = (): Fact => makeNodeFact({ kind: 'symbol', value: { repository: REPOSITORY, file: repositoryPath('src/b.ts'), qualifiedName: 'b.two', symbolKind: 'function' }, provenance: provenance('src/b.ts'), layer: 'extracted' });
const variable = (): Fact => makeNodeFact({ kind: 'environment-variable', value: { name: 'ORDERS_TOPIC' }, provenance: provenance('src/a.ts'), layer: 'extracted' });

beforeAll(async () => {
  const database = createPGliteDatabaseOwner();
  await createFillStateSchema(database);
  await createOrchestratorSchema(database);
  await createFactStoreSchema(database);
  await createUnit(database, { unitId: UNIT, product: PRODUCT, runId: 'run-adjacent', stageId: 'adjacent', scopeKey: UNIT, inputsDigest: 'adjacent-inputs', retries: 0, at: 1_700_000_000_000 });
  const unit = await readUnit(database, UNIT);
  if (unit === null) throw new Error(`the store does not hold the unit ${UNIT}`);
  const plan: UnitPlanRecord = { unitId: UNIT, generation: 1, runId: 'run-adjacent', stageId: 'adjacent', stageUnitId: UNIT, scope: REPOSITORY, stagePosition: 0, planPosition: 0, plannedAt: 1_700_000_000_000 };
  const one = symbol();
  const two = other();
  const topic = variable();
  const facts: Fact[] = [
    one,
    two,
    topic,
    makeEdgeFact({ kind: 'import', value: { from: one.id, to: two.id, specifier: './b.js' }, provenance: provenance('src/a.ts'), layer: 'extracted' }),
    makeEdgeFact({ kind: 'consumes', value: { from: one.id, variable: topic.id }, provenance: provenance('src/a.ts'), layer: 'extracted' }),
    // A document link's end is a term: `{form: 'node', id}`, never the id alone.
    makeEdgeFact({ kind: 'document-link', value: { from: one.id, to: { form: 'node', id: two.id } }, provenance: provenance('docs/design.md'), layer: 'extracted' }),
    // An interaction keeps its ends in `caller` and `callee`.
    makeEdgeFact({ kind: 'interaction', value: { caller: two.id, callee: one.id, form: 'call' }, provenance: provenance('src/b.ts'), layer: 'inferred' }),
  ];
  await database.transaction('write', async (executor) => await applyPublishedFacts({
    executor,
    unit,
    plan,
    digest: 'publication-adjacent',
    writes: facts.map((fact) => ({ kind: 'fact' as const, evidence: 'src/a.ts:1', value: fact })),
  }));
  owner = database;
  symbolFact = one;
  otherFact = two;
}, 120_000);

let symbolFact: Fact;
let otherFact: Fact;

afterAll(async () => {
  await owner?.close();
  owner = undefined;
});

/** The edges the read answers for one node, by the kind and the end they name. */
async function edgesOf(id: string): Promise<{ kinds: string[]; ids: string[] }> {
  const rows = await answerGraphRead({ database: owner!, snapshot: { open: async (): Promise<never> => { throw new Error('no snapshot is read here'); } } }, { read: 'adjacent', id, kinds: FACT_EDGE_KINDS, product: PRODUCT }) as readonly { id: string; kind: string }[];
  return { kinds: rows.map((row) => row.kind).sort(), ids: rows.map((row) => row.id).sort() };
}

describe('the edges one node stands at the end of', () => {
  test('a document link whose end is a node term is answered beside every edge that names the node plainly', async () => {
    const edges = await edgesOf(symbolFact.id);
    // `import` and `interaction` name the symbol as their `to`/`callee`, `consumes` holds it as its `from`, and the
    // document link names it as a term: four edges of four shapes, and none of them is dropped.
    expect(edges.kinds).toEqual(['consumes', 'document-link', 'import', 'interaction']);
  });

  test('the other end of the same edges is answered from the node it names', async () => {
    const edges = await edgesOf(otherFact.id);
    expect(edges.kinds).toEqual(['document-link', 'import', 'interaction']);
  });
});
