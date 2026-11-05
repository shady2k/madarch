
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner } from './src/adapters/database-owner.js';
import { createFillOrchestratorService } from './src/fill/orchestrator-host.js';
import { createGraphStore, type NodeVersionRow } from './src/graph/index.js';
import { createStagesFill } from './src/product/fill-stages.js';

const root = mkdtempSync(join(tmpdir(), 'madarch-sym-'));
const repository = join(root, 'training');
execFileSync(process.execPath, ['examples/training-repository/generate.mjs', repository], { stdio: ['ignore', 'pipe', 'pipe'] });
const product = join(root, 'product');
mkdirSync(join(product, 'repos'), { recursive: true });
symlinkSync(repository, join(product, 'repos', 'training'), 'dir');
const off = ['build-configuration', 'document-index', 'history', 'inventory', 'modules', 'semantic-resolution', 'state-machines', 'operations'];
writeFileSync(join(product, 'workspace.yaml'), ['schemaVersion: 1', 'id: 5c2e8a52-9c3e-4f7a-8b21-6d2e9c0a5b41', 'name: training-shop', 'repos:', '  - name: training', '    url: file:///training', 'fill:', '  stages:', ...off.flatMap((id) => [`    ${id}:`, '      enabled: false']), ''].join('\n'));
const git = (...args: string[]): void => { execFileSync('git', args, { cwd: product, stdio: ['ignore', 'pipe', 'pipe'] }); };
git('init', '-q', '-b', 'main'); git('config', 'user.name', 'F'); git('config', 'user.email', 'f@x.invalid'); git('add', '-A'); git('commit', '-qm', 'p');
const owner = createPGliteDatabaseOwner({ btreeGist: true });
const fill = await createStagesFill({ product, database: owner });
let at = 1_700_000_000_000;
const service = createFillOrchestratorService({ home: join(root, 'products'), owner, registry: fill.registry, wiring: () => fill.wiring, clock: () => (at += 1_000), limits: { leaseMs: 86_400_000 }, maxPasses: 100_000 });
const store = createGraphStore(owner);
const run = await service.run({ product: fill.product, runId: 'one' });
if (!run.ok) throw new Error(`refused: ${run.code}: ${run.reason}`);
const rows: NodeVersionRow[] = [];
let after: string | undefined;
for (;;) {
  const page = await store.byProperty('code.symbol', 'repository', 'training', { limit: 1000, ...(after === undefined ? {} : { after }) });
  rows.push(...page.rows);
  if (page.next === null) break;
  after = page.next;
}
const held = rows.map((row) => ({ producer: row.producer, recordKey: String(row.properties['recordKey']), qualifiedName: row.properties['qualifiedName'], span: row.properties['span'], symbolKind: row.properties['symbolKind'] }));
writeFileSync('/work/out/symbols.json', JSON.stringify({ failed: run.units.filter((u) => u.state !== 'published').map((u) => u.unitId), count: held.length, held }, null, 1));
console.log('symbols', held.length, 'failed', run.units.filter((u) => u.state !== 'published').length);
await service.stop();
await owner.close();
rmSync(root, { recursive: true, force: true });
