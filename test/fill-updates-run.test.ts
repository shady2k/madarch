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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fillStatePaths } from '../src/product/fill-runtime.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type StartedServer } from '../src/index.js';
import type { FillOrchestratorService, FillRunResult } from '../src/fill/orchestrator-host.js';
import type { RunStatus } from '../src/fill/orchestrator.js';
import { daemonFillOrchestrator, daemonUpdateWatch } from '../src/product/daemon.js';
import type { UpdateWatch } from '../src/product/fill-updates.js';

let root = '';
/** The products home: the server's own, where its fill database and its update state stand. */
let home = '';
let product = '';
let service: FillOrchestratorService | undefined;
let watch: UpdateWatch | undefined;
let first: FillRunResult | undefined;
let update: RunStatus | undefined;
let lastRequest = '';
let lines: string[] = [];
/** The wiki app's built files, as a served product needs them: the test's own folder with its shell in it. */
let appFolder = '';
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

  appFolder = mkdtempSync(join(tmpdir(), 'madarch-update-app-'));
  writeFileSync(join(appFolder, 'index.html'), '<!doctype html><title>update wiki</title>');

  service = daemonFillOrchestrator(home);
  const filled = await service.run({ product: { name: 'shop', folder: product }, runId: 'first-fill' });
  if (!filled.ok) throw new Error(`the first fill was refused: ${filled.code}: ${filled.reason}`);
  first = filled;
  // The gate reads the person's own home for the wizard's agent choice, which a test does not set: it names its own,
  // and the gate itself is `test/fill-updates.test.ts`'s subject.
  watch = daemonUpdateWatch(home, service, { debounceMs: 40, intervalMs: 0, log: (line) => lines.push(line), enabled: () => true });
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
    const status = await service.status({ product: { name: 'shop', folder: product }, runId: lastRequest });
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
  if (appFolder !== '') rmSync(appFolder, { recursive: true, force: true });
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

  test('the update recomputes the units the commit touched and inherits the rest', () => {
    const planned = new Set((update?.units ?? []).map((unit) => unit.unitId));
    // The file whose bytes moved is read again by every stage that reads its bytes.
    expect(planned.has('inventory/file:shop:src/total.ts')).toBe(true);
    expect(planned.has('syntax/file:shop:src/total.ts')).toBe(true);
    // The file the commit did not touch is inherited: the update is not a full refill.
    expect(planned.has('inventory/file:shop:src/order.ts')).toBe(false);
    expect(planned.has('syntax/file:shop:src/order.ts')).toBe(false);
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
    expect((progress?.units ?? []).map((unit) => unit.stage)).toContain('inventory');
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

  test('GET /api/fill answers the orchestrator\'s run, and the state file where it answers none', async () => {
    let server: StartedServer | undefined;
    try {
      const asked: string[] = [];
      server = await startServer({
        productFolder: product,
        appFolder,
        port: 0,
        host: '127.0.0.1',
        orchestrator: {
          stop: async () => undefined,
          progress: async (folder) => {
            asked.push(folder);
            return await service!.progress(folder);
          },
        },
      });
      const answered = await fetch(`${server.url}/api/fill`);
      expect(answered.status).toBe(200);
      const body = await answered.json() as { run?: { id: string; status: string }; units?: { stage: string }[]; events?: { type: string }[] };
      expect(asked).toEqual([product]);
      expect(body.run?.id).toBe(lastRequest);
      expect(body.run?.status).toBe('succeeded');
      expect((body.units ?? []).length).toBeGreaterThan(0);
      expect((body.events ?? []).length).toBeGreaterThan(0);
    } finally {
      await server?.stop();
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
  }, 900_000);

  test('POST /api/fill/control takes the orchestrator\'s answer first and the state file\'s where it holds no run', async () => {
    let server: StartedServer | undefined;
    try {
      server = await startServer({
        productFolder: product,
        appFolder,
        port: 0,
        host: '127.0.0.1',
        orchestrator: { stop: async () => undefined, control: (request) => service!.control(request) },
      });
      const mine = await fetch(`${server.url}/api/fill/control?runId=${encodeURIComponent(lastRequest)}&action=stop`, { method: 'POST' });
      expect(mine.status).toBe(409);
      expect(((await mine.json()) as { error: { message: string } }).error.message).toContain('cannot be cancelled');
      // A run the orchestrator does not hold falls through to the landed fill's state file, which answers its own 404.
      const theirs = await fetch(`${server.url}/api/fill/control?runId=the-landed-fills-run&action=stop`, { method: 'POST' });
      expect(theirs.status).toBe(404);
      expect(((await theirs.json()) as { error: { message: string } }).error.message).toContain('No fill run is active');
      // An action that is neither of the two is refused before anything is asked.
      const wrong = await fetch(`${server.url}/api/fill/control?runId=${encodeURIComponent(lastRequest)}&action=restart`, { method: 'POST' });
      expect(wrong.status).toBe(400);
    } finally {
      await server?.stop();
    }
  }, 900_000);
});

describe('the landed fill beside the update', () => {
  /** The landed fill's state, as the wizard's own Start writes it: a run record and its two folders. */
  function writeLandedFill(status: string): void {
    const state = fillStatePaths(product);
    mkdirSync(state.units, { recursive: true });
    mkdirSync(state.outputs, { recursive: true });
    writeFileSync(state.run, `${JSON.stringify({ id: 'landed-1', status, createdAt: new Date().toISOString(), controlOpen: status === 'running' })}\n`);
    writeFileSync(state.events, '');
  }

  function removeLandedFill(): void {
    rmSync(fillStatePaths(product).root, { recursive: true, force: true });
  }

  test('the landed fill\'s live run is what the progress shows while it runs', async () => {
    let server: StartedServer | undefined;
    try {
      writeLandedFill('running');
      server = await startServer({
        productFolder: product,
        appFolder,
        port: 0,
        host: '127.0.0.1',
        orchestrator: { stop: async () => undefined, progress: (folder) => service!.progress(folder) },
      });
      const answered = await fetch(`${server.url}/api/fill`);
      const body = await answered.json() as { run: { id: string; status: string } };
      expect(body.run.id).toBe('landed-1');
      expect(body.run.status).toBe('running');
      // The landed fill ends: the orchestrator's newest run of this product is what the panel shows next, and the
      // landed record stands aside.
      writeLandedFill('complete');
      const after = await fetch(`${server.url}/api/fill`);
      const afterBody = await after.json() as { run: { id: string; product: string } };
      expect(afterBody.run.id).not.toBe('landed-1');
      expect(afterBody.run.product).toBe('shop');
    } finally {
      await server?.stop();
      removeLandedFill();
    }
  }, 900_000);

  test('an update waits for the landed fill of its product, and follows it when it ends', async () => {
    try {
      writeLandedFill('running');
      writeFileSync(join(product, 'src', 'order.ts'), 'export function checkout(): number {\n  return 43;\n}\n');
      const moved = commitAll(product, 'three');
      const deferred = await (async () => {
        await watch!.pass();
        await pause(60);
        return await watch!.pass();
      })();
      const answer = deferred.asked[0]?.answer;
      expect(answer?.started).toBe(false);
      if (answer === undefined || answer.started) return;
      expect('deferred' in answer && answer.deferred).toBe(true);
      expect('reason' in answer && answer.reason).toContain(join(product, '.madarch', 'fill', 'run.json'));
      expect('reason' in answer && answer.reason).toContain('running');
      // The landed fill ends: the commit that waited is the run the next pass asks for.
      writeLandedFill('complete');
      const started = await watch!.pass();
      expect(started.asked.map((entry) => entry.request.commit)).toEqual([moved]);
      expect(started.asked[0]?.answer.started).toBe(true);
    } finally {
      removeLandedFill();
    }
  }, 900_000);
});
