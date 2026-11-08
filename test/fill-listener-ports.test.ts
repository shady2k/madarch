/**
 * The per-file port fact (madarch-8bdc.2.4, step 1 of the port's prerequisites):
 * the code-facts stage publishes the ports a file's code listens on, by the one
 * rule the contracts extractor's `portsByService` map is built with — a Go
 * `http.Server`'s Addr through its constants, a TypeScript app's `listen` port
 * and the ports a top-level listen starts with.
 *
 * The fixture (`test/fixtures/code-stages/service-units`) has a Go server on a
 * constant address, two TypeScript apps on their own ports, and a `new`
 * expression beside one of them: a grammar's `constructor` field name must not
 * cost a file its facts.
 */
import { afterAll, beforeAll, describe as bunDescribe, expect, test as bunTest } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createFillOrchestratorService, type FillOrchestratorService } from '../src/fill/orchestrator-host.js';
import { readRunPlans } from '../src/fill/orchestrator-store.js';
import { createGraphStore, type GraphStore, type NodeVersionRow } from '../src/graph/index.js';
import { createStagesFill, type StagesFill } from '../src/product/fill-stages.js';
import { CODE_FACTS_STAGE_ID } from '../src/fill/stages/code-facts.js';
import { parseFileFacts } from '../src/fill/stages/file-facts.js';
import {
  ORDERS_MAIN, TOOLS_FILE, UNITS_REPOSITORY, WEB_FILE, expectedPortsOf, writeUnitsProduct,
} from './fixtures/code-stages/service-units.js';
import { skippedBecauseOutOfWorkflow } from './fill-skip-list.js';

// The cases read a stage out of this step's list: they come back with that stage's step (test/fill-skip-list.ts).
const skippedSuite = skippedBecauseOutOfWorkflow(import.meta.path);
const describe = bunDescribe.skipIf(skippedSuite !== undefined);
const test = bunTest.skipIf(skippedSuite !== undefined);

let root = '';
let writtenRoot = '';
let owner: DatabaseOwner | undefined;
let store: GraphStore | undefined;
let fill: StagesFill | undefined;
let service: FillOrchestratorService | undefined;

beforeAll(async () => {
  // The store the cases read is filled by stages out of this step's list: no fixture is made or closed.
  if (skippedSuite !== undefined) return;
  root = mkdtempSync(join(tmpdir(), 'madarch-listener-ports-'));
  const written = writeUnitsProduct(root);
  writtenRoot = written.repository;
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
  const first = await service.run({ product: fill.product, runId: 'run-ports-1' });
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

/** Every port node of the fixture repository, by file and port. */
async function publishedPorts(): Promise<Map<string, Record<string, unknown>[]>> {
  if (store === undefined) throw new Error('the graph store was not opened');
  const graph = store;
  const nodes: NodeVersionRow[] = await graph.readAll(async (page) => await graph.byProperty('code.listener-port', 'repository', UNITS_REPOSITORY, page));
  const ports = new Map<string, Record<string, unknown>[]>();
  for (const node of nodes) {
    const held = propertiesOf(node);
    const file = held['file'];
    if (typeof file !== 'string' || file === '') throw new Error(`the graph answered a listener-port node ${node.nodeId} with no file: a port fact names the file it stands in (src/fill/stages/code-facts.ts)`);
    ports.set(file, [...(ports.get(file) ?? []), held]);
  }
  return ports;
}

describe('the per-file port fact', () => {
  test('publishes the ports a file listens on, and the unit each one serves', async () => {
    const ports = await publishedPorts();
    const expected = expectedPortsOf();
    expect([...ports.keys()].sort()).toEqual([...new Set(expected.map((entry) => entry.file))].sort());
    for (const entry of expected) {
      const held = ports.get(entry.file)!;
      expect(held.map((node) => node['port'])).toEqual([entry.port]);
      expect(held[0]!['service']).toBe(entry.service);
    }
    // The port node's key is its own: one file listens on one port once, whatever the code does.
    expect(ports.get(ORDERS_MAIN)![0]!['recordKey']).toBe(`code.listener-port:${UNITS_REPOSITORY}:${ORDERS_MAIN}#8080`);
    // A file that listens nowhere publishes no port, and a port outside every unit carries no service.
    expect(ports.has('services/orders/internal/order.go')).toBe(false);
    expect(ports.get('services/dot/src/server.ts')![0]!['service']).toBeUndefined();
  }, 900_000);

  test('reads a file whose code holds a new expression: a grammar field named constructor costs no facts', async () => {
    if (store === undefined) throw new Error('the graph store was not opened');
    const graph = store;
    // The parse answers the file's expressions, not the graph (madarch-8bdc.2.5): the walk is the
    // one the stage's facts come from, and a grammar's `constructor` field name must not cost it.
    const parsed = await parseFileFacts({
      repository: UNITS_REPOSITORY, commit: '0'.repeat(40), path: TOOLS_FILE, blob: '0'.repeat(40),
      bytes: readFileSync(join(writtenRoot, TOOLS_FILE)),
      exists: async (candidate: string) => existsSync(join(writtenRoot, candidate)),
    });
    expect(parsed.facts.expressions.some((held) => held.syntaxKind === 'new_expression')).toBe(true);
    // The port stands beside the expression: the reading lost neither.
    expect((await publishedPorts()).get(TOOLS_FILE)!.map((node) => node['port'])).toEqual(['8090']);
    // The file's coverage names what was read: a parsed file is in its `read` list and complete.
    const coverage = await graph.readAll(async (page) => await graph.byProperty('code.coverage', 'scope', WEB_FILE, page));
    const coverages = coverage.map((node) => propertiesOf(node)).filter((held) => held['repository'] === UNITS_REPOSITORY
      && ((held['provenance'] as Record<string, unknown>)['source'] as Record<string, unknown>)['system'] === 'madarch-code-facts');
    expect(coverages.length).toBe(1);
    expect(coverages[0]!['read']).toEqual([WEB_FILE]);
    expect(coverages[0]!['complete']).toBe(true);
  }, 900_000);

  test('a second run of the same commit plans no unit of the stage', async () => {
    if (service === undefined || fill === undefined || owner === undefined) throw new Error('the product was not opened');
    const second = await service.run({ product: fill.product, runId: 'run-ports-2' });
    if (!second.ok) throw new Error(`the run was refused: ${second.code}: ${second.reason}`);
    const plans = await readRunPlans(owner, 'run-ports-2');
    expect(plans.filter((row) => row.stageId === CODE_FACTS_STAGE_ID).map((row) => row.stageUnitId)).toEqual([]);
  }, 900_000);
});
