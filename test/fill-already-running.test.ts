/**
 * A fill started while the product's fill runs says so, and how to follow it (madarch-8bdc.2.18): the reader used to meet
 * `fill-chain/no-transition`, an internal code that named nothing they could act on — a fill of one product runs one at a
 * time (decision 0027), and the answer is that one is already running, since when, and where its progress is.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { createDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createFillOrchestratorService, type FillOrchestratorService } from '../src/fill/orchestrator-host.js';
import { StageRegistry } from '../src/fill/registry.js';
import { DEFAULT_STAGE_DEFAULTS, type FillStage } from '../src/fill/stage.js';
import { createFillStateSchema, readChain } from '../src/fill/state-store.js';
import { createDraft } from '../src/product/draft.js';
import { manifestWithRepo } from '../src/product/manifest.js';
import { productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { gitEnv } from './git-env.js';

const IDENTITY = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };

/** The `madarch` command, run the way a person runs it. */
const CLI = join(import.meta.dir, '..', 'scripts', 'madarch.ts');

let work: string;
let home: string;
let folder: string;
let product: string;
let owner: DatabaseOwner;

/**
 * The stage the background fill runs: it reads one unit and answers it only when the test lets go, so the run really
 * stands live while the second fill asks for the product.
 */
let release: () => void = () => undefined;
const blocked = new Promise<void>((resolve) => { release = resolve; });
const blocker: FillStage = {
  id: 'blocker',
  version: 1,
  consumes: { required: [], optional: [] },
  produces: [{ kind: 'blocker-facts', schemaVersion: 1, scope: 'product' }],
  configSchema: Type.Object({}),
  defaults: { ...DEFAULT_STAGE_DEFAULTS, config: {} },
  plan: () => ({ units: [{ id: 'one', scope: 'one' }], coverage: 'planned' }),
  execute: async () => { await blocked; return { outcome: 'draft' }; },
  validate: () => ({ ok: true }),
};

/** One `madarch fill` of the product, as the command answered: its exit code and both its streams. */
function fillCommand(): { code: number; stdout: string; stderr: string } {
  const answer = Bun.spawnSync(['bun', CLI, 'fill', '--product', folder, '--home', home], { env: { ...process.env, HOME: home }, stdout: 'pipe', stderr: 'pipe' });
  return { code: answer.exitCode ?? 1, stdout: new TextDecoder().decode(answer.stdout), stderr: new TextDecoder().decode(answer.stderr) };
}

/** Waits until the store says the product's chain follows a live run. */
async function untilRunning(): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const chain = await readChain(owner, product);
    if (chain?.state === 'active' && chain.context.activeRunId !== null) return;
    await new Promise((rest) => setTimeout(rest, 100));
  }
  throw new Error(`the background fill never stood running: the chain is ${JSON.stringify(await readChain(owner, product))}`);
}

describe('a fill started while the product\'s fill runs', () => {
  let service: FillOrchestratorService;
  let background: Promise<unknown>;

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'madarch-fill-already-running-'));
    home = join(work, 'home');
    const draft = createDraft({ home, name: 'served-shop', gitEnv: gitEnv(IDENTITY) });
    if (draft.outcome !== 'created') throw new Error(`the draft product was not made: ${JSON.stringify(draft)}`);
    folder = draft.folder;
    product = draft.name;
    const code = join(folder, 'repos', 'app');
    mkdirSync(code, { recursive: true });
    writeFileSync(join(code, 'README.md'), '# App\n');
    execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: code, env: gitEnv(IDENTITY) });
    execFileSync('git', ['add', 'README.md'], { cwd: code, env: gitEnv(IDENTITY) });
    execFileSync('git', ['commit', '--quiet', '-m', 'First commit'], { cwd: code, env: gitEnv(IDENTITY) });
    const manifest = join(folder, 'workspace.yaml');
    writeFileSync(manifest, manifestWithRepo(readFileSync(manifest, 'utf8'), { name: 'app', linked: true }));
    execFileSync('git', ['add', '-A'], { cwd: folder, env: gitEnv(IDENTITY) });
    execFileSync('git', ['commit', '--quiet', '-m', 'The product'], { cwd: folder, env: gitEnv(IDENTITY) });
    // The store the command and this test share: `<home>/.madarch/knowledge/<product id>/graph`.
    const storeFolder = productStoreFolder(folder, join(home, '.madarch', 'knowledge'));
    mkdirSync(storeFolder, { recursive: true });
    owner = await createDatabaseOwner({ store: storeDatabasePath(storeFolder), btreeGist: true });
    await owner.ready;
    await createFillStateSchema(owner);
    service = createFillOrchestratorService({
      owner,
      registry: new StageRegistry().register(blocker),
      wiring: () => ({ snapshot: () => ({ repository: folder, defaultBranch: 'main', commit: 'a1b2c3d4', registryHash: 'sha256:registry' }), configuration: () => undefined, graph: () => ({ query: async () => [] }), inputs: () => ({ commit: 'a1b2c3d4' }) }),
    });
    // The background fill: a run whose unit stands in flight while the command asks for the product.
    background = service.run({ product: { name: product, folder }, runId: 'fill-background', workers: 1 });
    await untilRunning();
  }, 120_000);

  afterAll(async () => {
    release();
    await background?.catch(() => undefined);
    await service?.stop().catch(() => undefined);
    await owner?.close().catch(() => undefined);
    rmSync(work, { recursive: true, force: true });
  });

  test('the second fill says a fill is already running, since when, and how to follow it, with no internal code', async () => {
    const answer = fillCommand();
    expect(answer.code).not.toBe(0);
    const said = `${answer.stderr}${answer.stdout}`;
    expect(said).toContain(`a fill of ${product} is already running`);
    expect(said).toContain('run fill-background');
    expect(said).toContain('started ');
    // The way to follow it, in the words the command can act on.
    expect(said).toContain('madarch serve');
    expect(said).toContain('/fill');
    expect(said).toContain('madarch trace --run fill-background');
    expect(said).toContain('This fill started nothing.');
    // The command does not call a press the product refused a failed fill.
    expect(answer.stdout).toContain(': not started');
    // No internal code of the chain of runs, and no code of the orchestrator, reaches the reader.
    expect(said).not.toContain('fill-chain/');
    expect(said).not.toContain('fill-orchestrator/');
  }, 300_000);

  test('a fill with none running starts as today', async () => {
    release();
    await background;
    await service.stop();
    const answer = fillCommand();
    expect(answer.code).toBe(0);
    expect(answer.stdout).toContain('Units:');
    expect(answer.stdout).toContain('Watch the pages with: madarch serve');
  }, 300_000);
});
