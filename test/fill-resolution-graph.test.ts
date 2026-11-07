/**
 * The resolution stage's acceptance on a repository the test generates (decision
 * 0033, items 5, 14 and 15; madarch-8bdc.2.2): the static fill runs over 100, 200
 * and 400 TypeScript files the test writes itself, and the calls, references and
 * inheritance edges the run published — read back through `src/graph`'s own reads
 * — are exactly the generator's expected set. A second run of the same commit
 * writes nothing.
 *
 * The repository is `test/fixtures/resolution-graph/repository.ts`: a ring of
 * files, each importing the next one's class and function, extending the class,
 * calling the function twice and mentioning the class once. The generator, not
 * the code under test, says which four edges each file's resolution must
 * publish. No outside repository is read, and nothing of the run leaves the
 * temporary folder the test makes.
 *
 * The sizes are large, so the cases are skipped under `MADARCH_SKIP_PERF=1`, as
 * the suite's other measured cases are; the heap these sizes cost is
 * `test/fill-static-heap.test.ts`'s subject.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createFillOrchestratorService, type FillOrchestratorService, type FillRunResult } from '../src/fill/orchestrator-host.js';
import { createGraphStore, type GraphStore } from '../src/graph/index.js';
import { createStagesFill, type StagesFill } from '../src/product/fill-stages.js';
import { expectedEdgesOf, writeProduct } from './fixtures/resolution-graph/repository.js';

const skip = process.env['MADARCH_SKIP_PERF'] !== undefined;

/** One file's index: its path and its qualified names, as the generator names them. */
interface SymbolName {
  readonly file: string;
  readonly name: string;
}

/** One edge read back from the graph, by the names of the two symbols it joins. */
interface ReadEdge {
  readonly relation: string;
  readonly from: SymbolName;
  readonly to: SymbolName;
}

/** One product open for a run: its wiring, its service, and the process's one owner. */
interface Open {
  readonly fill: StagesFill;
  readonly owner: DatabaseOwner;
  readonly service: FillOrchestratorService;
  readonly store: GraphStore;
  close(): Promise<void>;
}

/** Opens the product of one generated size: its staging fill, its service, and a graph store over the same owner. */
async function openProduct(root: string, count: number): Promise<Open> {
  const { product } = writeProduct(root, count);
  const owner = createPGliteDatabaseOwner({ btreeGist: true });
  const fill = await createStagesFill({ product, database: owner });
  let at = 1_700_000_000_000;
  const service = createFillOrchestratorService({
    owner,
    registry: fill.registry,
    wiring: () => fill.wiring,
    // A second per call, so a deferred retry is due on the next pass and no test sleeps.
    clock: () => (at += 1_000),
    limits: { leaseMs: 86_400_000 },
    // The 400-file run plans 1600 units, and a pass drives one of them: the run finishes in its own
    // drive only with a pass bound above that count.
    maxPasses: 100_000,
  });
  return {
    fill,
    owner,
    service,
    store: createGraphStore(owner),
    close: async () => {
      await service.stop();
      await owner.close();
    },
  };
}

/** One run of the product, refused by name where the service refuses it. */
async function run(opened: Open, runId: string): Promise<FillRunResult> {
  const result = await opened.service.run({ product: opened.fill.product, runId });
  if (!result.ok) throw new Error(`the run ${runId} was refused: ${result.code}: ${result.reason}`);
  return result;
}

/** Every symbol of one repository the graph holds, by node id: the names an edge is read back as. */
async function symbolsOf(opened: Open, repository: string): Promise<ReadonlyMap<string, SymbolName>> {
  const page = await opened.store.byProperty('code.symbol', 'repository', repository, { limit: 100_000 });
  if (page.next !== null) throw new Error(`the graph holds more symbols of ${repository} than this read asked for: the test asks for every one`);
  const byId = new Map<string, SymbolName>();
  for (const node of page.rows) {
    byId.set(node.nodeId, { file: String(propertiesOf(node)['file']), name: String(propertiesOf(node)['qualifiedName']) });
  }
  return byId;
}

/** A node's properties as a record: what `byProperty` answered is the version's own JSON. */
function propertiesOf(node: { readonly properties: unknown }): Record<string, unknown> {
  return node.properties !== null && typeof node.properties === 'object' && !Array.isArray(node.properties)
    ? node.properties as Record<string, unknown>
    : {};
}

/** Every edge of one relation the graph holds for one repository, read back as the two symbols it joins. */
async function edgesOf(opened: Open, repository: string, relation: string, symbols: ReadonlyMap<string, SymbolName>): Promise<readonly ReadEdge[]> {
  const page = await opened.store.edgesByProperty(relation, 'repository', repository, { limit: 100_000 });
  if (page.next !== null) throw new Error(`the graph holds more ${relation} edges of ${repository} than this read asked for: the test asks for every one`);
  return page.rows.map((entry) => {
    const from = symbols.get(entry.edge.src);
    const to = symbols.get(entry.edge.dst);
    if (from === undefined || to === undefined) {
      throw new Error(`the ${relation} edge ${entry.edge.edgeId} joins a node that is no symbol of ${repository}: ${entry.edge.src} -> ${entry.edge.dst}`);
    }
    return { relation, from, to };
  });
}

/** The code-point order of two edges, by what they join and how: the order every comparison of them uses. */
function byEdge(left: ReadEdge, right: ReadEdge): number {
  const one = `${left.relation}\u0000${left.from.file}\u0000${left.from.name}\u0000${left.to.file}\u0000${left.to.name}`;
  const other = `${right.relation}\u0000${right.from.file}\u0000${right.from.name}\u0000${right.to.file}\u0000${right.to.name}`;
  return one < other ? -1 : one > other ? 1 : 0;
}

/** The node version and edge version counts of the graph: what a run that writes nothing leaves as it found them. */
async function versions(opened: Open): Promise<{ readonly nodes: number; readonly edges: number }> {
  return await opened.owner.transaction('snapshot', async (executor) => {
    const nodes = await executor.query<{ n: string }>('SELECT count(*)::text AS n FROM node_version');
    const edges = await executor.query<{ n: string }>('SELECT count(*)::text AS n FROM edge_version');
    return { nodes: Number(nodes.rows[0]?.n ?? 0), edges: Number(edges.rows[0]?.n ?? 0) };
  });
}

for (const size of [100, 200, 400]) {
  describe(`the resolution of a repository of ${String(size)} files`, () => {
    let root = '';
    let opened: Open | undefined;
    let first: FillRunResult | undefined;
    let withinFirst: { readonly nodes: number; readonly edges: number } = { nodes: 0, edges: 0 };

    beforeAll(async () => {
      if (skip) return;
      root = mkdtempSync(join(tmpdir(), `madarch-resolution-graph-${String(size)}-`));
      opened = await openProduct(root, size);
      first = await run(opened, `run-${String(size)}-one`);
      withinFirst = await versions(opened);
    }, 1_800_000);

    afterAll(async () => {
      await opened?.close();
      if (root !== '') rmSync(root, { recursive: true, force: true });
    });

    test.skipIf(skip)(`the calls, references and inheritance edges are the generator's expected set, read through src/graph`, async () => {
      expect({ state: first?.state, settled: first?.settled }).toEqual({ state: 'succeeded', settled: true });
      const symbols = await symbolsOf(opened!, 'ring');
      // Each file declares its class, the class's method, its function and its two uses.
      expect(symbols.size).toBe(size * 5);
      const read: ReadEdge[] = [];
      for (const relation of ['code.calls', 'code.inherits', 'code.references']) {
        read.push(...await edgesOf(opened!, 'ring', relation, symbols));
      }
      const expected: ReadEdge[] = expectedEdgesOf(size).map((edge) => ({
        relation: edge.relation,
        from: { file: edge.fromFile, name: edge.fromName },
        to: { file: edge.toFile, name: edge.toName },
      }));
      expect(read.sort(byEdge)).toEqual(expected.sort(byEdge));
    }, 1_800_000);

    test.skipIf(skip)('a second run of the same commit writes nothing', async () => {
      const second = await run(opened!, `run-${String(size)}-two`);
      expect({ state: second.state, settled: second.settled }).toEqual({ state: 'succeeded', settled: true });
      // Every unit the run holds is one it inherited: nothing was planned and nothing ran.
      expect(second.units.filter((unit) => !second.reused.includes(unit.unitId)).map((unit) => unit.unitId)).toEqual([]);
      expect(await versions(opened!)).toEqual(withinFirst);
    }, 1_800_000);
  });
}
