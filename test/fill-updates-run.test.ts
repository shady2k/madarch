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
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type StartedServer } from '../src/index.js';
import { countPublishedFactsByKind } from '../src/fill/fact-store.js';
import type { FillOrchestratorService, FillRunResult } from '../src/fill/orchestrator-host.js';
import type { RunStatus } from '../src/fill/orchestrator.js';
import { daemonFillOrchestrator, daemonUpdateWatch } from '../src/product/daemon.js';
import type { UpdateWatch } from '../src/product/fill-updates.js';
import { updateRunId } from '../src/product/fill-updates.js';

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
let commit = '';

function git(folder: string, ...args: string[]): string {
  return spawnSync('git', args, { cwd: folder, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).stdout.trim();
}

function commitAll(folder: string, message: string): string {
  git(folder, 'add', '-A');
  const made = spawnSync('git', ['-c', 'user.name=Update', '-c', 'user.email=update@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', message], { cwd: folder, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  if (made.status !== 0) throw new Error(`git commit failed in ${folder}: ${made.stderr}`);
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

  service = daemonFillOrchestrator(home);
  const filled = await service.run({ product: { name: 'shop', folder: product }, runId: 'first-fill' });
  if (!filled.ok) throw new Error(`the first fill was refused: ${filled.code}: ${filled.reason}`);
  first = filled;
  watch = daemonUpdateWatch(home, service, { debounceMs: 40, intervalMs: 0, log: (line) => lines.push(line) });
  await watch.outset();
  // One commit on the default branch of the product repository, after the watcher read its baseline.
  writeFileSync(join(product, 'src', 'total.ts'), 'export function total(): number {\n  return 43;\n}\n');
  commit = commitAll(product, 'two');
  await watch.pass();
  await pause(60);
  const started = await watch.pass();
  const asked = started.asked[0];
  if (asked === undefined) throw new Error('the watcher asked for no run after a commit on the default branch');
  lastRequest = asked.request.runId;
  update = await service.status({ product: { name: 'shop', folder: product }, runId: lastRequest }) ?? undefined;
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
    expect(update?.run.runId).toBe(updateRunId('shop', commit));
    expect(update?.run.state).toBe('succeeded');
    expect(update?.units.every((unit) => unit.state === 'published')).toBe(true);
    expect(lines.some((line) => line.includes(`started as ${updateRunId('shop', commit)}`))).toBe(true);
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
    expect(progress?.run.id).toBe(updateRunId('shop', commit));
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
      expect(body.run?.id).toBe(updateRunId('shop', commit));
      expect(body.run?.status).toBe('succeeded');
      expect((body.units ?? []).length).toBeGreaterThan(0);
      expect((body.events ?? []).length).toBeGreaterThan(0);
    } finally {
      await server?.stop();
    }
  }, 900_000);
});
