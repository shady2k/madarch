/**
 * The operations links stage (madarch-8bdc.2.4): what a repository's code reads
 * from the environment, the variable those reads make, and the environment
 * definition that sets it — published by a stage that runs after the per-file
 * operations stage and names the records the earlier stage published.
 *
 * The repository is the test's own: one service with a manifest, a configuration
 * file that reads a variable with a default, a logger module that reads another,
 * and a compose file that sets both. The expectations are those bytes.
 */
import { afterAll, beforeAll, describe as bunDescribe, expect, test as bunTest } from 'bun:test';
import { skippedBecauseOutOfWorkflow } from './fill-skip-list.js';

// The cases read a stage out of this step's list: they come back with that stage's step (test/fill-skip-list.ts).
const skippedSuite = skippedBecauseOutOfWorkflow(import.meta.path);
const describe = bunDescribe.skipIf(skippedSuite !== undefined);
const test = bunTest.skipIf(skippedSuite !== undefined);
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createFillOrchestratorService, type FillOrchestratorService, type FillRunResult } from '../src/fill/orchestrator-host.js';
import { createGraphStore, type GraphStore, type NodeVersionRow } from '../src/graph/index.js';
import { createStagesFill, type StagesFill } from '../src/product/fill-stages.js';
import { writeFirstFillWorkflow } from './fill-workflow-fixture.js';

const CONFIG_FILE = 'services/shop/src/config.ts';
const LOGGER_FILE = 'services/shop/src/logging/logger.ts';

let root = '';
let fill: StagesFill | undefined;
let owner: DatabaseOwner | undefined;
let service: FillOrchestratorService | undefined;
let store: GraphStore | undefined;
let first: FillRunResult | undefined;
let second: FillRunResult | undefined;

/** The repository the test writes: a manifest, two files that read the environment, and a compose file that sets it. */
function writeRepository(folder: string): void {
  mkdirSync(join(folder, 'services/shop/src/logging'), { recursive: true });
  writeFileSync(join(folder, 'services/shop/package.json'), `${JSON.stringify({ name: 'shop', version: '1.0.0', dependencies: { express: '^4.21.2' } }, null, 2)}\n`);
  writeFileSync(join(folder, CONFIG_FILE), [
    'export const port = Number(process.env.PORT ?? "8080");',
    'export const broker = process.env.KAFKA_BROKERS;',
    '',
  ].join('\n'));
  writeFileSync(join(folder, LOGGER_FILE), [
    'import pino from "pino";',
    '',
    'export const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });',
    '',
  ].join('\n'));
  mkdirSync(join(folder, 'services/shop/cmd/shop'), { recursive: true });
  writeFileSync(join(folder, 'services/shop/cmd/shop/main.go'), [
    'package main',
    '',
    'import (',
    '\t"os"',
    ')',
    '',
    'func main() {',
    '\turl := os.Getenv("DATABASE_URL")',
    '\tif url == "" {',
    '\t\tos.Exit(1)',
    '\t}',
    '}',
    '',
  ].join('\n'));
  writeFileSync(join(folder, 'docker-compose.yml'), [
    'services:',
    '  shop:',
    '    build: ./services/shop',
    '    ports:',
    '      - "8080:8080"',
    '    environment:',
    '      PORT: 8080',
    '      KAFKA_BROKERS: kafka:9092',
    '',
  ].join('\n'));
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd: folder, stdio: ['ignore', 'pipe', 'pipe'] }); };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('add', '-A');
  git('commit', '-qm', 'the repository of the links stage');
}

beforeAll(async () => {
  // The store the cases read is filled by stages out of this step's list: no fixture is made or closed.
  if (skippedSuite !== undefined) return;
  root = mkdtempSync(join(tmpdir(), 'madarch-links-'));
  const repository = join(root, 'shop');
  writeRepository(repository);
  const product = join(root, 'product');
  mkdirSync(join(product, 'repos'), { recursive: true });
  symlinkSync(repository, join(product, 'repos', 'shop'), 'dir');
  writeFileSync(join(product, 'workspace.yaml'), [
    'schemaVersion: 1',
    'id: 5b0f1c3e-2d44-4a91-9f60-0c7a1e8b2d55',
    'name: shop-product',
    'repos:',
    '  - name: shop',
    '    url: file:///shop',
    // The stages this case stands on are the snapshot, the code facts and the two operations
    // stages: every other stage is disabled, so the case times the linking it compares.
    'fill:',
    '  stages:',
    ...['build-configuration', 'document-index', 'history', 'inventory', 'modules', 'semantic-resolution', 'state-machines', 'syntax'].flatMap((id) => [`    ${id}:`, '      enabled: false']),
    '',
  ].join('\n'));
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd: product, stdio: ['ignore', 'pipe', 'pipe'] }); };
  writeFirstFillWorkflow(product);
  git('init', '-q', '-b', 'main');  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('add', '-A');
  git('commit', '-qm', 'the product');
  owner = createPGliteDatabaseOwner({ btreeGist: true });
  fill = await createStagesFill({ product, database: owner });
  let at = 1_700_000_000_000;
  service = createFillOrchestratorService({
    home: join(root, 'products'), owner, registry: fill.registry, wiring: () => fill!.wiring,
    clock: () => (at += 1_000), limits: { leaseMs: 86_400_000 }, maxPasses: 100_000,
  });
  store = createGraphStore(owner);
  const run = await service.run({ product: fill.product, runId: 'links-one' });
  if (!run.ok) throw new Error(`the fill was refused: ${run.code}: ${run.reason}`);
  if (run.state !== 'succeeded') {
    const failed = run.units.filter((unit) => unit.state !== 'published');
    throw new Error(`the fill did not succeed: state ${run.state}, settled ${String(run.settled)}, stopped ${String(run.stoppedBecause)}, units ${failed.map((unit) => `${unit.unitId}:${unit.state}`).join(', ')}`);
  }
  first = run;
  const again = await service.run({ product: fill.product, runId: 'links-two' });
  if (!again.ok) throw new Error(`the second fill was refused: ${again.code}: ${again.reason}`);
  second = again;
}, 900_000);

afterAll(async () => {
  // The store the cases read is filled by stages out of this step's list: no fixture is made or closed.
  if (skippedSuite !== undefined) return;
  await service?.stop();
  await owner?.close();
  if (root !== '') rmSync(root, { recursive: true, force: true });
}, 300_000);

/** One node's properties, as the store answers them. */
function propertiesOf(node: { readonly properties: unknown }): Record<string, unknown> {
  return node.properties !== null && typeof node.properties === 'object' && !Array.isArray(node.properties)
    ? node.properties as Record<string, unknown>
    : {};
}

/** Every node of one kind in one repository, one page after another. */
async function nodesOfKind(kind: string): Promise<readonly NodeVersionRow[]> {
  if (store === undefined) throw new Error('the store was not opened');
  return await store.readAll(async (page) => await store!.byProperty(kind, 'repository', 'shop', page));
}

/** One node's record, as the stage publishes a record's own fields under `record`. */
function recordOf(row: NodeVersionRow): Record<string, unknown> {
  const held = propertiesOf(row)['record'];
  return held !== null && typeof held === 'object' ? held as Record<string, unknown> : {};
}

describe('the variables a repository reads', () => {
  test('the stage publishes one variable per read name, its reads and the definition that sets it', async () => {
    expect({ state: first?.state, failed: (first?.units ?? []).filter((unit) => unit.state !== 'published').map((unit) => unit.unitId) })
      .toEqual({ state: 'succeeded', failed: [] });
    const reads = (await nodesOfKind('code.env-read')).map(recordOf);
    expect(reads.map((held) => `${String(held['variable'])}@${String(held['line'])}`).sort()).toEqual([
      'shop/DATABASE_URL@8', 'shop/KAFKA_BROKERS@2', 'shop/LOG_LEVEL@3', 'shop/PORT@1',
    ]);
    // The Go read stands in `main`, and the program stops without it.
    const goRead = reads.filter((held) => held['name'] === 'DATABASE_URL')[0]!;
    expect([goRead['symbol'], goRead['required'], goRead['default']]).toEqual(['main', true, null]);
    const port = reads.filter((held) => held['name'] === 'PORT')[0]!;
    expect([port['symbol'], port['required'], port['default']]).toEqual(['', false, '8080']);
    const variables = (await nodesOfKind('code.env-var')).map(propertiesOf);
    expect(variables.map((held) => [held['recordKey'], (held['record'] as Record<string, unknown>)['required'], (held['record'] as Record<string, unknown>)['default']]).sort())
      .toEqual([
        ['code.env-var:shop/DATABASE_URL', true, null],
        ['code.env-var:shop/KAFKA_BROKERS', false, null],
        ['code.env-var:shop/LOG_LEVEL', false, 'info'],
        ['code.env-var:shop/PORT', false, '8080'],
      ]);
    const portRow = (await nodesOfKind('code.env-var')).filter((row) => propertiesOf(row)['recordKey'] === 'code.env-var:shop/PORT')[0]!;
    expect((propertiesOf(portRow)['span'] as Record<string, unknown>)['path']).toBe(CONFIG_FILE);
    expect(portRow.label).toBe('PORT');
    const readsEdges = await store!.edgesByProperty('code.reads-env', 'repository', 'shop', { limit: 100 });
    // One edge per file and variable, at the file's first read: the variable's own record, the
    // callable the read stands in, whether the program stops without it, and its default.
    const readRows = readsEdges.rows.map((row) => {
      const record = (row.edge.properties as Record<string, unknown>)['record'] as Record<string, unknown>;
      return [String(propertiesOf(row.src)['path']), String(propertiesOf(row.dst)['recordKey']), String(record['symbol']), record['required'], String(record['default'])];
    });
    expect(readRows.sort()).toEqual([
      ['services/shop/cmd/shop/main.go', 'code.env-var:shop/DATABASE_URL', 'main', true, 'null'],
      [CONFIG_FILE, 'code.env-var:shop/KAFKA_BROKERS', '', false, 'null'],
      [CONFIG_FILE, 'code.env-var:shop/PORT', '', false, '8080'],
      [LOGGER_FILE, 'code.env-var:shop/LOG_LEVEL', '', false, 'info'],
    ]);
    const defines = await store!.edgesByProperty('code.defines', 'repository', 'shop', { limit: 100 });
    expect(defines.rows.map((row) => {
      const record = (row.edge.properties as Record<string, unknown>)['record'] as Record<string, unknown>;
      return [row.src.kind, row.dst.kind, String(propertiesOf(row.dst)['recordKey']), String(record['value'])];
    }))
      .toEqual([
        ['code.env-definition', 'code.env-var', 'code.env-var:shop/KAFKA_BROKERS', 'kafka:9092'],
        ['code.env-definition', 'code.env-var', 'code.env-var:shop/PORT', '8080'],
      ]);
  }, 900_000);

  test('a second fill of the same commit plans no unit of the stage', () => {
    expect({ state: second?.state, settled: second?.settled }).toEqual({ state: 'succeeded', settled: true });
    const units = second?.units ?? [];
    const reused = second?.reused ?? [];
    expect(units.filter((unit) => unit.unitId.startsWith('operations-links/') && !reused.includes(unit.unitId)).map((unit) => unit.unitId)).toEqual([]);
  }, 900_000);
});
