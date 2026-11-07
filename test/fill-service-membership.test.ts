/**
 * The per-file service membership fact (madarch-8bdc.2.4, step 1 of the port's
 * prerequisites): the code-facts stage publishes, for one file, the unit the
 * nearest `go.mod` or `package.json` above its folder declares, read one path
 * at a time and never by listing the tree.
 *
 * The expectations are the fixture's own (`test/fixtures/code-stages/service-units`):
 * a nested package manifest, a folder the repository conventions call another
 * project's, a manifest that names nothing, a `go.mod` that declares no module,
 * and a folder holding both manifest kinds. A second run after a manifest's
 * name moves re-reads the file whose unit it declares, although the file's own
 * bytes did not move.
 */
import { afterAll, beforeAll, describe as bunDescribe, expect, test as bunTest } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createFillOrchestratorService, type FillOrchestratorService } from '../src/fill/orchestrator-host.js';
import { readRunPlans } from '../src/fill/orchestrator-store.js';
import { createCodeFactsStage } from '../src/fill/stages/code-facts.js';
import { createStaticStageReadReader } from '../src/fill/stages/static-reads.js';
import { createGraphStore, type GraphStore, type NodeVersionRow } from '../src/graph/index.js';
import { createStagesFill, type StagesFill } from '../src/product/fill-stages.js';
import { fileFactIdOf } from '../src/fill/stages/syntax-facts.js';
import { manifestChainOf, serviceMembershipOf } from '../src/fill/stages/service-membership.js';
import {
  BOTH_FILE, NAMELESS_FILE, NOMODULE_FILE, UNITS_REPOSITORY, VENDORED_FILE, commitChange,
  expectedUnitByFile, writeUnitsProduct,
} from './fixtures/code-stages/service-units.js';
import { skippedBecauseOutOfWorkflow } from './fill-skip-list.js';

// The cases read a stage out of this step's list: they come back with that stage's step (test/fill-skip-list.ts).
const skippedSuite = skippedBecauseOutOfWorkflow(import.meta.path);
const describe = bunDescribe.skipIf(skippedSuite !== undefined);
const test = bunTest.skipIf(skippedSuite !== undefined);

let root = '';
let repository = '';
let owner: DatabaseOwner | undefined;
let store: GraphStore | undefined;
let fill: StagesFill | undefined;
let service: FillOrchestratorService | undefined;

beforeAll(async () => {
  // The store the cases read is filled by stages out of this step's list: no fixture is made or closed.
  if (skippedSuite !== undefined) return;
  root = mkdtempSync(join(tmpdir(), 'madarch-service-membership-'));
  const written = writeUnitsProduct(root);
  repository = written.repository;
  owner = createPGliteDatabaseOwner({ btreeGist: true });
  fill = await createStagesFill({ product: written.product, database: owner });
  let at = 1_700_000_000_000;
  service = createFillOrchestratorService({
    owner,
    registry: fill.registry,
    wiring: () => fill!.wiring,
    clock: () => (at += 1_000),
    limits: { leaseMs: 86_400_000 },
    maxPasses: 100_000,
  });
  store = createGraphStore(owner);
  const first = await service.run({ product: fill.product, runId: 'run-units-1' });
  if (!first.ok) throw new Error(`the run was refused: ${first.code}: ${first.reason}`);
}, 900_000);

afterAll(async () => {
  // The store the cases read is filled by stages out of this step's list: no fixture is made or closed.
  if (skippedSuite !== undefined) return;
  await service?.stop();
  await owner?.close();
  if (root !== '') rmSync(root, { recursive: true, force: true });
}, 300_000);

/** A node's properties as a record. */
function propertiesOf(node: { readonly properties: unknown }): Record<string, unknown> {
  return node.properties !== null && typeof node.properties === 'object' && !Array.isArray(node.properties)
    ? node.properties as Record<string, unknown>
    : {};
}

/** Every service-unit node of the fixture repository, by the file it belongs to. */
async function publishedUnits(): Promise<Map<string, Record<string, unknown>>> {
  if (store === undefined) throw new Error('the graph store was not opened');
  const graph = store;
  const nodes: NodeVersionRow[] = await graph.readAll(async (page) => await graph.byProperty('code.service-unit', 'repository', UNITS_REPOSITORY, page));
  const units = new Map<string, Record<string, unknown>>();
  for (const node of nodes) {
    const held = propertiesOf(node);
    const file = held['file'];
    if (typeof file !== 'string' || file === '') throw new Error(`the graph answered a service-unit node ${node.nodeId} with no file: a unit fact names the file it belongs to (src/fill/stages/code-facts.ts)`);
    if (units.has(file)) throw new Error(`the graph answered two service-unit nodes for ${file}: one file belongs to one unit`);
    units.set(file, held);
  }
  return units;
}

/** One file's code-facts coverage, as the graph holds it. */
async function coverageOf(file: string): Promise<Record<string, unknown>> {
  if (store === undefined) throw new Error('the graph store was not opened');
  const graph = store;
  const nodes = await graph.readAll(async (page) => await graph.byProperty('code.coverage', 'scope', file, page));
  const mine = nodes.map((node) => propertiesOf(node)).filter((held) => held['repository'] === UNITS_REPOSITORY
    && ((held['provenance'] as Record<string, unknown>)['source'] as Record<string, unknown>)['system'] === 'madarch-code-facts');
  if (mine.length !== 1) throw new Error(`the graph holds ${String(mine.length)} code-facts coverages for ${file}: one file is read once`);
  return mine[0]!;
}

/** One run of the product, refused by name where the service refuses it. */
async function run(runId: string): Promise<void> {
  if (service === undefined || fill === undefined) throw new Error('the product was not opened');
  const result = await service.run({ product: fill.product, runId });
  if (!result.ok) throw new Error(`the run ${runId} was refused: ${result.code}: ${result.reason}`);
  expect(result.units.filter((unit) => unit.state === 'failed').map((unit) => unit.unitId)).toEqual([]);
}

describe('the per-file service membership fact', () => {
  test('publishes the unit the nearest manifest above each file declares, and no unit where none does', async () => {
    const units = await publishedUnits();
    const expected = expectedUnitByFile();
    const seen = [...units.keys()].sort();
    expect(seen).toEqual([...expected.keys()].sort());
    for (const [file, unit] of expected) {
      const held = units.get(file)!;
      expect({ file, name: held['name'], root: held['root'], manifestPath: held['manifestPath'], ecosystem: held['ecosystem'], declared: held['declared'] })
        .toEqual({ file, ...unit });
    }
    // A document, a file of the go.mod that declares no module, the go.mod itself, and a file
    // under a go.mod whose module path is a dot declare no unit.
    for (const path of ['README.md', 'services/nomodule/go.mod', NOMODULE_FILE, 'services/dot/src/x.ts']) {
      expect(units.has(path)).toBe(false);
    }
    // The vendored folder's own package.json declares no unit of this repository: the file belongs to the unit above it.
    expect(units.get(VENDORED_FILE)!['name']).toBe('web');
    // A manifest that names nothing is known by its folder.
    expect(units.get(NAMELESS_FILE)!['declared']).toBe('nameless');
    // A go.mod that declares no module is not a gap: the file's own reading is complete.
    const nomodule = await coverageOf(NOMODULE_FILE);
    expect(nomodule['complete']).toBe(true);
    expect(nomodule['unread']).toEqual([]);
    // A manifest above the cap is a named gap, and no unit is claimed for the file under it.
    expect(units.has('services/big/src/x.ts')).toBe(false);
    const big = await coverageOf('services/big/src/x.ts');
    expect(big['complete']).toBe(false);
    expect((big['unread'] as readonly { what: string }[]).map((gap) => gap.what).join('\n')).toContain('services/big/package.json:1:');
  }, 900_000);

  test('hangs the unit from its file by code.declares, and pins the manifest chain in the coverage', async () => {
    if (store === undefined) throw new Error('the graph store was not opened');
    const graph = store;
    const [fileNode] = (await graph.byKey(fileFactIdOf(UNITS_REPOSITORY, BOTH_FILE))).rows;
    if (fileNode === undefined) throw new Error(`the graph holds no file node for ${BOTH_FILE}: the inventory stage publishes it before this stage reads it`);
    const edges = await graph.readAll(async (page) => await graph.callees(fileNode.nodeId, undefined, { relation: 'code.declares', ...page }));
    const declared = edges.map((entry) => entry.dst.nodeId);
    const unitNode = (await publishedUnits()).get(BOTH_FILE);
    expect(unitNode).toBeDefined();
    expect(declared.length).toBeGreaterThan(0);
    const keys = edges.map((entry) => propertiesOf(entry.dst)['recordKey']);
    expect(keys).toContain(unitNode!['recordKey']);
    // The chain names both manifests of the folder and nothing above it: the reading stands on them.
    const coverage = await graph.readAll(async (page) => await graph.byProperty('code.coverage', 'scope', BOTH_FILE, page));
    const mine = coverage.map((node) => propertiesOf(node)).filter((held) => held['repository'] === UNITS_REPOSITORY
      && ((held['provenance'] as Record<string, unknown>)['source'] as Record<string, unknown>)['system'] === 'madarch-code-facts');
    expect(mine.length).toBe(1);
    const chain = mine[0]!['unitChain'] as readonly string[];
    expect(chain.map((entry) => entry.slice(0, entry.lastIndexOf('@')))).toEqual(['services/both/go.mod', 'services/both/package.json']);
    expect(chain.every((entry) => /^[^@]+@[0-9a-f]{40}$/.test(entry))).toBe(true);
  }, 900_000);

  test('reads a unit a manifest at the repository root declares, and one whose name is padded', async () => {
    const bytes = new TextEncoder().encode('{"name":"root-unit"}');
    const lookup = async (path: string): Promise<{ path: string; blob: string; bytes?: Uint8Array } | undefined> =>
      (path === 'package.json' ? { path, blob: 'f'.repeat(40), bytes } : undefined);
    const read = await serviceMembershipOf('main.ts', lookup);
    expect(read.unit).toEqual({ name: 'root-unit', root: '', manifestPath: 'package.json', ecosystem: 'node', declared: 'root-unit' });
    expect(read.chain).toEqual([`package.json@${'f'.repeat(40)}`]);
    expect(read.gaps).toEqual([]);
  }, 900_000);

  test('reads the manifest chain above a folder, nearest first, to the root and past another project\'s folder', async () => {
    const blobs = new Map<string, string>([
      ['go.mod', 'a'.repeat(40)],
      ['services/both/go.mod', 'b'.repeat(40)],
      ['services/both/package.json', 'c'.repeat(40)],
      ['services/web/package.json', 'd'.repeat(40)],
      ['services/web/node_modules/dep/package.json', 'e'.repeat(40)],
    ]);
    const lookup = async (path: string): Promise<{ path: string; blob: string } | undefined> => {
      const blob = blobs.get(path);
      return blob === undefined ? undefined : { path, blob };
    };
    expect(await manifestChainOf('services/both/src', lookup)).toEqual([
      `services/both/go.mod@${'b'.repeat(40)}`,
      `services/both/package.json@${'c'.repeat(40)}`,
      `go.mod@${'a'.repeat(40)}`,
    ]);
    // The repository conventions call `node_modules` another project's: its manifest declares no
    // unit of this repository, and the chain above the file reaches the unit above it.
    expect(await manifestChainOf('services/web/node_modules/dep', lookup)).toEqual([
      `services/web/package.json@${'d'.repeat(40)}`,
      `go.mod@${'a'.repeat(40)}`,
    ]);
  }, 900_000);

  test('re-reads a file whose manifest moved although the file\'s own bytes did not', async () => {
    if (owner === undefined) throw new Error('the database was not opened');
    // The smaller declared name answers where one folder holds both manifests: `omega` sorts before `zeta`.
    commitChange(repository, 'services/both/package.json', '{\n  "name": "omega",\n  "version": "1.0.0"\n}\n');
    // The plan's own answer: the file whose manifest moved is named, and no other file is.
    if (store === undefined || fill === undefined) throw new Error('the product was not opened');
    // The wiring reads the pins again for the run about to plan (`snapshot`), and the stage's
    // source answers that same read: the plan stands on the commit the manifest moved in.
    await fill.wiring.snapshot();
    const sources = fill.wiring.source === undefined ? undefined : await fill.wiring.source();
    if (sources === undefined) throw new Error('the fill wires no snapshot source');
    const plan = await createCodeFactsStage(sources).plan(createStaticStageReadReader(store));
    expect(plan.units.map((unit) => unit.id)).toEqual([`file:${UNITS_REPOSITORY}:${BOTH_FILE}`]);
    await run('run-units-2');
    const plans = await readRunPlans(owner, 'run-units-2');
    const codeFacts = plans.filter((row) => row.stageId === 'code-facts').map((row) => row.stageUnitId).sort();
    expect(codeFacts).toEqual([`file:${UNITS_REPOSITORY}:${BOTH_FILE}`]);
    const unit = (await publishedUnits()).get(BOTH_FILE)!;
    expect(unit['name']).toBe('omega');
    expect(unit['declared']).toBe('omega');
  }, 900_000);
});
