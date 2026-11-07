/**
 * The library effects of one file (madarch-8bdc.2.4, step 3 of the task's plan):
 * a call of a modelled library is proved from the file's code facts, and an
 * import is chained to the file it comes from *by global name through the
 * graph* — the fixture's `app.ts` calls a logger its `logger.ts` declares with
 * pino's own model, and no tree's symbol table is built for it.
 *
 * What the extract driver's `evaluateLibraryModels` answers for the same bytes is
 * the expectation: the fixture's two files are the smallest shape the training
 * repository writes (`logging/logger.ts` and its callers).
 */
import { afterAll, beforeAll, describe as bunDescribe, expect, test as bunTest } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createFillOrchestratorService, type FillOrchestratorService } from '../src/fill/orchestrator-host.js';
import { createGraphStore, type GraphStore } from '../src/graph/index.js';
import { createStagesFill, type StagesFill } from '../src/product/fill-stages.js';
import { createGitSnapshotSource } from '../src/fill/snapshot.js';
import { staticGraphReaderOf, staticStageContext, staticStageSourceOf } from '../src/fill/stages/static-context.js';
import { libraryEffectsOf } from '../src/fill/stages/library-effects.js';
import { APP_FILE, LOGGER_FILE, writeProduct } from './fixtures/code-stages/repository.js';
import { skippedBecauseOutOfWorkflow } from './fill-skip-list.js';

// The cases read a stage out of this step's list: they come back with that stage's step (test/fill-skip-list.ts).
const skippedSuite = skippedBecauseOutOfWorkflow(import.meta.path);
const describe = bunDescribe.skipIf(skippedSuite !== undefined);
const test = bunTest.skipIf(skippedSuite !== undefined);

let root = '';
let owner: DatabaseOwner | undefined;
let store: GraphStore | undefined;
let fill: StagesFill | undefined;
let service: FillOrchestratorService | undefined;
let repositoryRoot = '';

beforeAll(async () => {
  // The store the cases read is filled by stages out of this step's list: no fixture is made or closed.
  if (skippedSuite !== undefined) return;
  root = mkdtempSync(join(tmpdir(), 'madarch-library-effects-'));
  const { product, repository } = writeProduct(root);
  repositoryRoot = repository;
  owner = createPGliteDatabaseOwner({ btreeGist: true });
  fill = await createStagesFill({ product, database: owner });
  let at = 1_700_000_000_000;
  service = createFillOrchestratorService({
    owner,
    registry: fill.registry,
    wiring: () => fill!.wiring,
    clock: () => (at += 1_000),
    limits: { leaseMs: 86_400_000 },
    maxPasses: 100_000,
  });
  const result = await service.run({ product: fill.product, runId: 'run-library-effects' });
  if (!result.ok) throw new Error(`the run was refused: ${result.code}: ${result.reason}`);
  store = createGraphStore(owner);
}, 900_000);

afterAll(async () => {
  // The store the cases read is filled by stages out of this step's list: no fixture is made or closed.
  if (skippedSuite !== undefined) return;
  await service?.stop();
  await owner?.close();
  if (root !== '') rmSync(root, { recursive: true, force: true });
}, 300_000);

describe('one file\'s library effects, read from the graph', () => {
  test('chains an import by global name to the file it comes from and proves the logger call', async () => {
    if (store === undefined) throw new Error('the graph store was not opened');
    const { execFileSync } = await import('node:child_process');
    const commit = execFileSync('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const sources = createGitSnapshotSource([{ id: 'shop', form: 'code', root: repositoryRoot, commit }]);
    const context = staticStageContext(await staticStageSourceOf(sources, 'shop'), staticGraphReaderOf(store));
    const effects = await libraryEffectsOf(context, 'shop', APP_FILE);
    // The call `logger.info(...)` is pino's logger model, proved through the import of
    // `./logging/logger.js`: the closure holds both files, and the effect stands in `app.ts`.
    const ids = effects.effects.map((effect) => effect.modelId).sort();
    expect(ids).toEqual(['pino.logger.info']);
    expect(effects.files).toBe(2);
    const call = effects.effects[0]!;
    expect(call.span.path).toBe(APP_FILE);
    expect(call.package).toBe('pino');
    expect(call.span.lineStart).toBe(4);
    // The logger's own declaration is the other file's answer, and the unit's answer holds neither.
    const declared = await libraryEffectsOf(context, 'shop', LOGGER_FILE);
    expect(declared.effects.map((effect) => effect.modelId).sort()).toEqual(['pino.default']);
    expect(declared.files).toBe(1);
  }, 300_000);
});
