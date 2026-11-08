/**
 * The update after commits to a default branch, end to end (madarch-tzte.26.2;
 * decision 0026, "Updates" and "Pages"; decision 0027's host): the background
 * server's own fill service fills a product, a commit lands on its default branch,
 * and the server starts the update by itself — a real run of the declared stages on
 * a repository this test makes, then the person's fill progress answering it.
 *
 * The expectations come from the requirement: the update is a run of the product's
 * fill (it publishes facts), it is the person's own fill repeated on the new commit
 * (the units whose bytes did not move are inherited, not recomputed), and a
 * watching person finds it in `GET /api/fill` — the same answer the panel shows.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { runGit } from '../src/product/git.js';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createPGliteDatabaseOwner } from '../src/adapters/database-owner.js';
import { repositoryFacts } from '../src/graph/index.js';
import { readProduct } from '../src/product/manifest.js';
import { knowledgeRootOf, productStoreFolder, storeSnapshotsFolder } from '../src/product/store.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FillRunResult } from '../src/fill/orchestrator-host.js';
import type { RunStatus } from '../src/fill/orchestrator.js';
import { daemonFills, daemonUpdateWatch, type DaemonFills } from '../src/product/daemon.js';
import type { UpdateWatch } from '../src/product/fill-updates.js';

let root = '';
/** The products home: the server's own, where its fill database and its update state stand. */
let home = '';
let product = '';
let service: DaemonFills | undefined;
let watch: UpdateWatch | undefined;
let first: FillRunResult | undefined;
let update: RunStatus | undefined;
let lastRequest = '';
let lines: string[] = [];
/** The wiki app's built files, as a served product needs them: the test's own folder with its shell in it. */
let commit = '';

/** One git call in a fixture checkout, through the project's own runner (which strips a caller's loader variables). */
function git(folder: string, ...args: string[]): string {
  const answer = runGit(folder, args);
  if (!answer.ok) throw new Error(`git ${args.join(' ')} failed in ${folder}: ${answer.output}`);
  return answer.output;
}

/** Commits everything the fixture folder holds, under the fixture's own identity, and answers the commit. */
function commitAll(folder: string, message: string): string {
  git(folder, 'add', '-A');
  git(folder, '-c', 'user.name=Update', '-c', 'user.email=update@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', message);
  return git(folder, 'rev-parse', 'HEAD');
}

const pause = (ms: number): Promise<void> => new Promise((answer) => setTimeout(answer, ms));

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-update-run-'));
  home = join(root, 'home');
  product = join(home, 'shop');
  mkdirSync(join(product, 'src'), { recursive: true });
  mkdirSync(join(product, 'docs'), { recursive: true });
  writeFileSync(join(product, 'workspace.yaml'), 'schemaVersion: 1\nid: 8a1c6f2e-4f2b-4b8a-9f7e-1a2b3c4d5e6f\nname: shop\n');
  writeFileSync(join(product, 'src', 'order.ts'), 'export function checkout(): number {\n  return 42;\n}\n');
  writeFileSync(join(product, 'src', 'total.ts'), 'export function total(): number {\n  return 42;\n}\n');
  writeFileSync(join(product, 'docs', 'readme.md'), '# Shop\n\nThe shop adds up an order.\n');
  git(product, 'init', '-q');
  git(product, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  commitAll(product, 'one');


  const fills = daemonFills(home);
  service = fills;
  const filled = await fills.run({ product: { name: 'shop', folder: product }, runId: 'first-fill' });
  if (!filled.ok) throw new Error(`the first fill was refused: ${filled.code}: ${filled.reason}`);
  first = filled;
  // The gate reads the person's own home for the wizard's agent choice, which a test does not set: it names its own,
  // and the gate itself is `test/fill-updates.test.ts`'s subject.
  watch = daemonUpdateWatch(home, fills, { debounceMs: 40, intervalMs: 0, log: (line) => lines.push(line), enabled: () => true });
  await watch.outset();
  // One commit on the default branch of the product repository, after the watcher read its baseline. The pass that
  // reads the commit keeps it waiting for the debounce, and the timer that ends the debounce runs the pass that
  // starts the run and drives it to its end — nothing else drives the watcher here.
  writeFileSync(join(product, 'src', 'total.ts'), 'export function total(): number {\n  return 43;\n}\n');
  commit = commitAll(product, 'two');
  await watch.pass();
  lastRequest = `update-shop-${commit.slice(0, 12)}`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await pause(250);
    const status = await fills.status({ product: { name: 'shop', folder: product }, runId: lastRequest });
    if (status !== null && ['succeeded', 'completed_partial', 'blocked', 'failed', 'cancelled'].includes(status.run.state)) {
      update = status;
      break;
    }
  }
  if (update === undefined) throw new Error(`the watcher started no run named ${lastRequest} after a commit on the default branch: the commit is ${commit}`);
}, 900_000);

afterAll(async () => {
  watch?.stop();
  await service?.stop();
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

describe('the update a default-branch commit starts', () => {
  test('the first fill publishes its facts, and the commit after it starts one update run by itself', () => {
    expect(first?.ok).toBe(true);
    expect(first?.state).toBe('succeeded');
    expect(first?.units.length).toBeGreaterThan(0);
    // The update is the person's fill again on the new commit, started by the server: one run, named after the commit.
    expect(update).toBeDefined();
    expect(update?.run.runId).toBe(lastRequest);
    expect(update?.run.state).toBe('succeeded');
    expect(update?.units.every((unit) => unit.state === 'published')).toBe(true);
    expect(lines.some((line) => line.includes(`started as ${lastRequest}`))).toBe(true);
  }, 900_000);

  test('the update is the person\'s fill again on the new commit: both repository passes run for it', () => {
    const planned = (update?.units ?? []).map((unit) => ({ unitId: unit.unitId, stage: unit.stageId, state: unit.state }));
    // This step's fill is the two repository passes, one unit each; the update republishes both on the commit.
    expect([...new Set(planned.map((unit) => unit.stage))].sort()).toEqual(['repository-history', 'repository-tree']);
    expect(planned.map((unit) => unit.unitId).sort()).toEqual(['repository-history/repository:shop', 'repository-tree/repository:shop']);
    expect(planned.every((unit) => unit.state === 'published')).toBe(true);
  }, 900_000);

  test('the person finds it in the fill progress: the newest run, its units and its events', async () => {
    const progress = await service!.progress(product);
    expect(progress).not.toBeNull();
    expect(progress?.run.id).toBe(lastRequest);
    expect(progress?.run.status).toBe('succeeded');
    expect(progress?.run.product).toBe('shop');
    // The events a watching person reads: the run was started, planned and completed, and its units were planned.
    const kinds = new Set((progress?.events ?? []).map((event) => event.type));
    for (const kind of ['run-started', 'run-planned', 'unit-published', 'run-completed']) expect(kinds.has(kind)).toBe(true);
    expect((progress?.events ?? []).length).toBeGreaterThan(0);
    expect(progress?.events.every((event) => Number.isFinite(event.seq) && !Number.isNaN(Date.parse(event.at)))).toBe(true);
    expect((progress?.units ?? []).map((unit) => unit.stage)).toContain('repository-tree');
    expect(progress?.units.every((unit) => unit.status === 'published')).toBe(true);
    // The answer's own fields are the panel's: one run, its units and its events in order, and no unit left unnamed.
    expect((progress?.units ?? []).every((unit) => unit.unitId !== '' && unit.stage !== '')).toBe(true);
    expect((progress?.events ?? []).map((event) => event.seq)).toEqual([...(progress?.events ?? []).map((event) => event.seq)].sort((left, right) => left - right));
  }, 900_000);

  test('a product with no run answers null, so the progress falls back to the state file', async () => {
    const other = join(home, 'other');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'workspace.yaml'), 'schemaVersion: 1\nid: 1b2c3d4e-5f60-4a1b-8c9d-0e1f2a3b4c5d\nname: other\n');
    expect(await service!.progress(other)).toBeNull();
  }, 900_000);

  test('the update reaches the store the wiki reads: the newest snapshot names the commit the daemon filled', async () => {
    const read = readProduct(product);
    if (!read.ok) throw new Error(`${read.file}:${read.line}: ${read.message}`);
    // The one store of this product, resolved by the function the button, `madarch fill-stages` and `madarch mcp` use.
    const store = productStoreFolder(product, knowledgeRootOf(home));
    const snapshots = readdirSync(storeSnapshotsFolder(store)).filter((name) => /^\d+$/.test(name)).map(Number).sort((left, right) => left - right);
    // The first fill and the update each finished a snapshot for the reader.
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    const newest = snapshots.at(-1)!;
    const owner = createPGliteDatabaseOwner({ path: join(storeSnapshotsFolder(store), String(newest)), btreeGist: true });
    await owner.ready;
    try {
      const pins = await owner.run((tx) => tx.query<{ repo: string; commit_hash: string }>('SELECT repo, commit_hash FROM knowledge_fill ORDER BY repo'));
      expect(pins.rows).toContainEqual({ repo: read.product.name, commit_hash: commit });
      expect((await repositoryFacts(owner, read.product.name))?.asIsCommit).toBe(commit);
    } finally {
      await owner.close();
    }
  }, 900_000);

});

describe('the person\'s control of a run the server keeps', () => {
  test('a stop of a run this service holds is the run\'s own cancellation, and a run it does not hold answers null', async () => {
    // A run the service asked not to drive: its units are planned and the run stands running, which is what a
    // person stops from the panel.
    const held = await service!.run({ product: { name: 'shop', folder: product }, runId: 'stop-me', maxPasses: 0 });
    expect(held.ok).toBe(true);
    const before = await service!.status({ product: { name: 'shop', folder: product }, runId: 'stop-me' });
    // The run stands where the state machine left it after planning and no pass: it has not ended.
    expect(['planning', 'running']).toContain(before?.run.state ?? 'ended');

    const stopped = await service!.control({ productFolder: product, runId: 'stop-me', action: 'stop' });
    expect(stopped).toEqual({ ok: true, runId: 'stop-me', state: 'cancelled' });
    expect((await service!.status({ product: { name: 'shop', folder: product }, runId: 'stop-me' }))?.run.state).toBe('cancelled');

    // The landed fill's run stands in the product's state file, not in this store: the answer is null, which is
    // what lets that file's own control answer for it.
    expect(await service!.control({ productFolder: product, runId: 'the-landed-fills-run', action: 'pause' })).toBeNull();
  }, 900_000);

  test('a step a run\'s machine refuses says so in the machine\'s words, not as a missing run', async () => {
    // The update run ended succeeded: there is nothing left to stop, and the refusal names the state it stands in.
    const refused = await service!.control({ productFolder: product, runId: lastRequest, action: 'stop' });
    expect(refused?.ok).toBe(false);
    if (refused === null || refused.ok) return;
    expect(refused.code).toBe('fill-orchestrator/control-refused');
    expect(refused.reason).toContain('cannot be cancelled');
    expect(refused.reason).toContain('succeeded');
    // A pause is a step only a running run takes, and a run that ended says so instead of reporting a pause it did
    // not take.
    const paused = await service!.control({ productFolder: product, runId: lastRequest, action: 'pause' });
    expect(paused?.ok).toBe(false);
    if (paused === null || paused.ok) return;
    expect(paused.code).toBe('fill-orchestrator/control-refused');
    expect(paused.reason).toContain('succeeded');
    expect(paused.reason).toContain('nothing was paused');
  }, 900_000);
});

