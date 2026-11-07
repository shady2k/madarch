/**
 * The state-machines stage on a repository the test generates (decision 0033,
 * items 5, 14 and 15; madarch-8bdc.2.4): the stage runs in the product's fill
 * beside the other static stages, one unit per source file, and publishes the
 * machines its files write down — the machine, its states and the moves between
 * them — into the 0028 graph through the publication's own transaction.
 *
 * The expectations are the fixture's (`expectedMachinesOf`), never the stage's
 * answer: the generator writes the bytes and says which states, labels, lines
 * and moves they hold. A document and a data file hold no machine, and their
 * files are not units of this stage. A second run of the same commit plans no
 * unit of this stage, so nothing of it is written twice.
 */
import { afterAll, beforeAll, describe as bunDescribe, expect, test as bunTest } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createFillOrchestratorService, type FillOrchestratorService, type FillRunResult } from '../src/fill/orchestrator-host.js';
import { readRunPlans } from '../src/fill/orchestrator-store.js';
import { createGraphStore, type EdgeEntry, type GraphStore, type NodeVersionRow } from '../src/graph/index.js';
import { createStagesFill, type StagesFill } from '../src/product/fill-stages.js';
import { STATE_MACHINES_STAGE_ID } from '../src/fill/stages/state-machines.js';
import { fileFactIdOf } from '../src/fill/stages/syntax-facts.js';
import { APP_FILE, CONFIG_FILE, expectedMachinesOf, GO_FILE, LOGGER_FILE, TS_FILE, writeProduct } from './fixtures/code-stages/repository.js';
import { skippedBecauseOutOfWorkflow } from './fill-skip-list.js';

// The cases read a stage out of this step's list: they come back with that stage's step (test/fill-skip-list.ts).
const skippedSuite = skippedBecauseOutOfWorkflow(import.meta.path);
const describe = bunDescribe.skipIf(skippedSuite !== undefined);
const test = bunTest.skipIf(skippedSuite !== undefined);

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
  // The store the cases read is filled by stages out of this step's list: no fixture is made or closed.
  if (skippedSuite !== undefined) return;
  root = mkdtempSync(join(tmpdir(), 'madarch-code-stages-'));
  const { product } = writeProduct(root);
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
  // The store the cases read is filled by stages out of this step's list: no fixture is made or closed.
  if (skippedSuite !== undefined) return;
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

/** Every node of one kind and repository, read through the store's own paged read. */
async function kindNodes(o: Open, kind: string, repository: string): Promise<NodeVersionRow[]> {
  return await o.store.readAll(async (page) => await o.store.byProperty(kind, 'repository', repository, page));
}

/** Every edge of one relation and repository, read through the store's own paged read. */
async function relationEdges(o: Open, relation: string, repository: string): Promise<EdgeEntry[]> {
  return await o.store.readAll(async (page) => await o.store.edgesByProperty(relation, 'repository', repository, page));
}

/** Every node's properties by the key its version carries: what an edge's end is read back as. */
function keysOf(nodes: readonly NodeVersionRow[]): Map<string, Record<string, unknown>> {
  const byKey = new Map<string, Record<string, unknown>>();
  for (const node of nodes) {
    const held = propertiesOf(node);
    byKey.set(String(held['recordKey']), held);
  }
  return byKey;
}

/** The edge's ends as the keys the graph holds them at, or the node ids where the read named them by id. */
function endKeyOf(entry: EdgeEntry, side: 'src' | 'dst', keysById: ReadonlyMap<string, string>): string {
  return keysById.get(side === 'src' ? entry.edge.src : entry.edge.dst) ?? (side === 'src' ? entry.edge.src : entry.edge.dst);
}

describe('the state-machines stage', () => {
  test('publishes the machines the fixture writes, one unit per source file', async () => {
    if (opened === undefined) throw new Error('the product was not opened');
    const o = opened;
    const first = await run(o, 'run-code-stages-1');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // The whole walk finishes with nothing failed: the fixture is one every stage reads.
    expect({
      state: first.state,
      settled: first.settled,
      failed: (first.units ?? []).filter((unit) => unit.state === 'failed').map((unit) => unit.unitId),
    }).toEqual({ state: 'succeeded', settled: true, failed: [] });
    const repository = 'shop';
    // The commit the run pinned, read from the product's own repository pin.
    const coveredCommit = execFileSync('git', ['-C', join(root, 'shop'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const machines = await kindNodes(o, 'code.state-machine', repository);
    const states = await kindNodes(o, 'code.state', repository);
    const transitions = await relationEdges(o, 'code.transitions', repository);
    const machineKeys = keysOf(machines);
    const stateKeys = keysOf(states);
    const keyById = new Map<string, string>();
    for (const node of states) keyById.set(node.nodeId, String(propertiesOf(node)['recordKey']));
    for (const node of machines) keyById.set(node.nodeId, String(propertiesOf(node)['recordKey']));

    // What the run published, in the fixture's order, read back by the keys the graph holds.
    const published = expectedMachinesOf().map((machine) => {
      const key = `code.state-machine:${repository}:${machine.file}#${machine.name}`;
      const held = machineKeys.get(key);
      expect(held).toBeDefined();
      const prefix = `code.state:${repository}:${machine.file}#${machine.name}/`;
      const machineStates = [...stateKeys.entries()]
        .filter(([stateKey]) => stateKey.startsWith(prefix))
        .map(([, state]) => ({ name: String(state['name']), label: String(state['label']), line: Number(state['line']) }))
        .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
      const propsOf = (entry: EdgeEntry): Record<string, unknown> => (entry.edge.properties === null || typeof entry.edge.properties !== 'object' ? {} : entry.edge.properties as Record<string, unknown>);
      const machineTransitions = transitions
        .filter((entry) => String(propsOf(entry)['machine'] ?? '') === machine.name && String(propsOf(entry)['file'] ?? '') === machine.file)
        .map((entry) => ({
          from: endKeyOf(entry, 'src', keyById).slice(prefix.length),
          to: endKeyOf(entry, 'dst', keyById).slice(prefix.length),
          event: propsOf(entry)['event'] === undefined ? null : String(propsOf(entry)['event']),
          line: Number(propsOf(entry)['line'] ?? 0),
        }))
        .sort((left, right) => (left.line - right.line) || (left.from < right.from ? -1 : left.from > right.from ? 1 : 0));
      return {
        key,
        file: held?.['file'],
        name: held?.['name'],
        type: held?.['type'] ?? null,
        lineStart: held?.['lineStart'],
        lineEnd: held?.['lineEnd'],
        // The node cites the reader and the commit the bytes stood under.
        provenance: {
          system: (held?.['provenance'] as Record<string, unknown> | undefined)?.['source'],
          commit: ((held?.['provenance'] as Record<string, unknown> | undefined)?.['repository'] as Record<string, unknown> | undefined)?.['commit'],
        },
        states: machineStates,
        transitions: machineTransitions,
      };
    });
    expect(published).toEqual(expectedMachinesOf().map((machine) => ({
      key: `code.state-machine:${repository}:${machine.file}#${machine.name}`,
      file: machine.file,
      name: machine.name,
      type: machine.type,
      lineStart: machine.lineStart,
      lineEnd: machine.lineEnd,
      provenance: { system: { system: 'madarch-state-machines', version: '1' }, commit: coveredCommit },
      states: [...machine.states].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
      transitions: [...machine.transitions],
    })));
    // The machine is declared by its file's node, and holds its states: the file pass reads a file's
    // `code.contains` children as its symbols, so a machine never stands among them.
    const declares = await relationEdges(o, 'code.declares', repository);
    const holds = await relationEdges(o, 'code.contains', repository);
    const fileNodes = await kindNodes(o, 'code.file', repository);
    for (const node of fileNodes) keyById.set(node.nodeId, String(propertiesOf(node)['recordKey'] ?? ''));
    for (const [machineKey, held] of machineKeys) {
      const fileKey = fileFactIdOf(repository, String(held['file']));
      const declared = declares.some((entry) => endKeyOf(entry, 'src', keyById) === fileKey && endKeyOf(entry, 'dst', keyById) === machineKey);
      expect({ machine: machineKey, declared }).toEqual({ machine: machineKey, declared: true });
      const statesOfMachine = [...stateKeys.keys()].filter((stateKey) => stateKey.startsWith(`code.state:${repository}:${String(held['file'])}#${String(held['name'])}/`));
      for (const stateKey of statesOfMachine) {
        const heldByMachine = holds.some((entry) => endKeyOf(entry, 'src', keyById) === machineKey && endKeyOf(entry, 'dst', keyById) === stateKey);
        expect({ state: stateKey, held: heldByMachine }).toEqual({ state: stateKey, held: true });
      }
      expect(statesOfMachine.length).toBeGreaterThan(0);
    }
    // No machine stands among a file's `code.contains` children: the resolution stage reads those as symbols.
    for (const entry of holds) {
      const source = endKeyOf(entry, 'src', keyById);
      if (!source.startsWith('file:')) continue;
      const target = endKeyOf(entry, 'dst', keyById);
      expect({ machineAmongSymbols: target.startsWith('code.state-machine:') }).toEqual({ machineAmongSymbols: false });
    }
  }, 300_000);

  test('publishes one coverage per file, and a second run of the same commit plans no unit', async () => {
    if (opened === undefined) throw new Error('the product was not opened');
    const o = opened;
    const repository = 'shop';
    // What the first run's units left: one coverage node per source file, complete, at the pinned blob.
    const coverages = await kindNodes(o, 'code.coverage', repository);
    const mine = coverages
      .map((node) => propertiesOf(node))
      .filter((held) => (held['provenance'] as Record<string, unknown> | undefined)?.['source'] !== undefined
        && ((held['provenance'] as Record<string, unknown>)['source'] as Record<string, unknown>)['system'] === 'madarch-state-machines');
    const covered = mine.map((held) => ({ complete: held['complete'], blob: typeof held['blob'] === 'string' && held['blob'].length === 40, unread: held['unread'] }))
      .sort((left, right) => Number(left.blob) - Number(right.blob));
    expect(covered).toEqual([
      { complete: true, blob: true, unread: [] },
      { complete: true, blob: true, unread: [] },
      { complete: true, blob: true, unread: [] },
      { complete: true, blob: true, unread: [] },
      { complete: true, blob: true, unread: [] },
    ]);
    const second = await run(o, 'run-code-stages-2');
    expect(second.ok).toBe(true);
    const plans = await readRunPlans(o.owner, 'run-code-stages-2');
    expect(plans.filter((row) => row.stageId === STATE_MACHINES_STAGE_ID).map((row) => row.stageUnitId)).toEqual([]);
  }, 300_000);

  test('plans one unit per source file and none for a document or a data file', async () => {
    if (opened === undefined) throw new Error('the product was not opened');
    const o = opened;
    const plans = await readRunPlans(o.owner, 'run-code-stages-1');
    const mine = plans.filter((row) => row.stageId === STATE_MACHINES_STAGE_ID).map((row) => row.stageUnitId).sort();
    expect(mine).toEqual([`file:shop:${GO_FILE}`, `file:shop:${TS_FILE}`, `file:shop:${CONFIG_FILE}`, `file:shop:${LOGGER_FILE}`, `file:shop:${APP_FILE}`].sort());
  }, 60_000);
});
