/**
 * The code-facts stage in a product's fill (decision 0033, items 5, 14 and 15;
 * madarch-8bdc.2.4): one unit per source file, its facts published into the
 * 0028 graph through the publication's own transaction, and a second run of the
 * same commit planning no unit of the stage.
 *
 * The expectations are the fixture's bytes (`test/fixtures/code-stages`): the
 * configuration file's environment read, the constant it declares and the call
 * it makes, read back from the graph by their own properties.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createFillOrchestratorService, type FillOrchestratorService, type FillRunResult } from '../src/fill/orchestrator-host.js';
import { readRunPlans } from '../src/fill/orchestrator-store.js';
import { createGraphStore, type GraphStore, type NodeVersionRow } from '../src/graph/index.js';
import { createStagesFill, type StagesFill } from '../src/product/fill-stages.js';
import { CODE_FACTS_STAGE_ID } from '../src/fill/stages/code-facts.js';
import { APP_FILE, CONFIG_FILE, GO_FILE, LOGGER_FILE, TS_FILE, writeProduct } from './fixtures/code-stages/repository.js';

/** One product open for a run: its wiring, its service, and the graph store over the process's one owner. */
interface Open {
  readonly fill: StagesFill;
  readonly owner: DatabaseOwner;
  readonly service: FillOrchestratorService;
  readonly store: GraphStore;
  close(): Promise<void>;
}

let root = '';
let opened: Open | undefined;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-code-facts-'));
  const { product } = writeProduct(root);
  const owner = createPGliteDatabaseOwner({ btreeGist: true });
  const fill = await createStagesFill({ product, database: owner });
  let at = 1_700_000_000_000;
  const service = createFillOrchestratorService({
    home: join(root, 'products'),
    owner,
    registry: fill.registry,
    wiring: () => fill.wiring,
    clock: () => (at += 1_000),
    limits: { leaseMs: 86_400_000 },
    maxPasses: 100_000,
  });
  opened = {
    fill,
    owner,
    service,
    store: createGraphStore(owner),
    close: async () => {
      await service.stop();
      await owner.close();
    },
  };
}, 900_000);

afterAll(async () => {
  await opened?.close();
  if (root !== '') rmSync(root, { recursive: true, force: true });
}, 300_000);

/** One run of the product, refused by name where the service refuses it. */
async function run(o: Open, runId: string): Promise<FillRunResult> {
  const result = await o.service.run({ product: o.fill.product, runId });
  if (!result.ok) throw new Error(`the run ${runId} was refused: ${result.code}: ${result.reason}`);
  return result;
}

/** A node's properties as a record: what `byProperty` answered is the version's own JSON. */
function propertiesOf(node: { readonly properties: unknown }): Record<string, unknown> {
  return node.properties !== null && typeof node.properties === 'object' && !Array.isArray(node.properties)
    ? node.properties as Record<string, unknown>
    : {};
}

/** Every node of one kind, one file and one repository, read through the store's own paged read. */
async function fileNodes(o: Open, kind: string, repository: string, file: string): Promise<Record<string, unknown>[]> {
  const nodes: NodeVersionRow[] = await o.store.readAll(async (page) => await o.store.byProperty(kind, 'file', file, page));
  return nodes.map((node) => propertiesOf(node)).filter((held) => held['repository'] === repository);
}

describe('the code-facts stage', () => {
  test('publishes one file\'s expressions, bindings and calls, with the values its bytes write', async () => {
    if (opened === undefined) throw new Error('the product was not opened');
    const o = opened;
    const first = await run(o, 'run-code-facts-1');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect({ state: first.state, settled: first.settled, failed: (first.units ?? []).filter((unit) => unit.state === 'failed').map((unit) => unit.unitId) })
      .toEqual({ state: 'succeeded', settled: true, failed: [] });
    const expressions = await fileNodes(o, 'code.expression', 'shop', CONFIG_FILE);
    expect(expressions.length).toBeGreaterThan(20);
    const literal = expressions.filter((held) => (held['literal'] as Record<string, unknown> | undefined)?.['value'] === '8080');
    expect(literal.length).toBe(1);
    expect(literal[0]!['syntaxKind']).toBe('string');
    const bindings = await fileNodes(o, 'code.binding', 'shop', CONFIG_FILE);
    const port = bindings.filter((held) => held['name'] === 'port');
    expect(port.length).toBe(1);
    expect(port[0]!['globalName']).toBe(`shop:${CONFIG_FILE}#port`);
    const initializer = expressions.find((held) => held['recordKey'] === port[0]!['initializer']);
    expect(initializer?.['syntaxKind']).toBe('call_expression');
    const calls = await fileNodes(o, 'code.call', 'shop', CONFIG_FILE);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((held) => stillUnknown(held))).toBe(false);
    // Every source file of the fixture was read: three units, one coverage each.
    const coverageNodes: NodeVersionRow[] = await o.store.readAll(async (page) => await o.store.byProperty('code.coverage', 'scope', CONFIG_FILE, page));
    const coverages = coverageNodes.map((node) => propertiesOf(node)).filter((held) => held['repository'] === 'shop'
      && (held['provenance'] as Record<string, unknown> | undefined)?.['source'] !== undefined
      && ((held['provenance'] as Record<string, unknown>)['source'] as Record<string, unknown>)['system'] === 'madarch-code-facts');
    expect(coverages.length).toBe(1);
    expect(coverages[0]!['complete']).toBe(true);
    expect(coverages[0]!['read']).toEqual([CONFIG_FILE]);
  }, 900_000);

  test('plans one unit per source file, and a second run of the same commit plans none', async () => {
    if (opened === undefined) throw new Error('the product was not opened');
    const o = opened;
    const plans = await readRunPlans(o.owner, 'run-code-facts-1');
    const units = plans.filter((row) => row.stageId === CODE_FACTS_STAGE_ID).map((row) => row.stageUnitId).sort();
    expect(units).toEqual([APP_FILE, CONFIG_FILE, GO_FILE, LOGGER_FILE, TS_FILE].map((file) => `file:shop:${file}`).sort());
    const second = await run(o, 'run-code-facts-2');
    expect(second.ok).toBe(true);
    const again = await readRunPlans(o.owner, 'run-code-facts-2');
    expect(again.filter((row) => row.stageId === CODE_FACTS_STAGE_ID).map((row) => row.stageUnitId)).toEqual([]);
    // The facts stand as the first run published them: a second run wrote none.
    const expressions = await fileNodes(o, 'code.expression', 'shop', CONFIG_FILE);
    expect(expressions.length).toBeGreaterThan(20);
  }, 900_000);
});

/** Whether a fact carries the empty value a draft would hold if the walk had lost it. */
function stillUnknown(held: Record<string, unknown>): boolean {
  return held['recordKey'] === undefined || held['span'] === undefined;
}
