/**
 * The fill runs in a process of its own (madarch-8bdc.2.9; the owner: "Ну он и должен быть отдельным процессом").
 *
 * The fixture's one source file is deliberately large — a few thousand exported constants — so the file's unit is slow
 * and the fill is really running while the test reads. Two things are held:
 *
 * - while the fill runs, a page of the product answers within the bound stated below, and the process that runs the
 *   fill is not the server's (`fill-state.json` names it). A fill in the server's process would hold the event loop
 *   for the whole unit and miss the bound;
 * - a child killed mid-fill leaves a failure the wiki says, and a press after it starts a new run.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type StartedServer } from '../src/server/http.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';
import { writeFirstFillWorkflow } from './fill-workflow-fixture.js';

/** The bound a page of a product answers within while its fill runs: stated here, and what a fill in the server's own process would miss. */
const ANSWER_BOUND_MS = 3_000;

/** The lines of the fixture's slow file: the one unit that keeps the fill running while the page is read. */
const SLOW_LINES = 40_000;

const env = gitEnv(SAMPLE_IDENTITY);
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8' });

let root = '';
let home = '';
let server: StartedServer;

/** Each fixture's own id, as its manifest names it: the folder its knowledge store stands in. */
const PRODUCT_IDS: Readonly<Record<string, string>> = {
  'walk-a': '6a2f3c14-6a4e-4b0a-9a2c-2f7a1b3c4d5e',
  'walk-b': '9c4e1d2a-3b5f-4a61-8d2e-7f0a1b2c3d4e',
};

/** A product in the home, with one code repository whose source file is slow to read. */
function makeFixture(name: string): string {
  const product = join(home, name);
  const repository = join(root, `${name}-code`);
  mkdirSync(join(repository, 'src'), { recursive: true });
  mkdirSync(join(product, 'repos'), { recursive: true });
  git(repository, 'init', '-q', '-b', 'main');
  writeFileSync(join(repository, 'package.json'), `{\n  "name": "${name}-code",\n  "version": "1.0.0",\n  "type": "module"\n}\n`);
  const lines = ['/** One number, one constant: the file the fill reads slowly. */'];
  for (let index = 0; index < SLOW_LINES; index++) lines.push(`export const value${index} = ${index};`);
  writeFileSync(join(repository, 'src', 'slow.ts'), `${lines.join('\n')}\n`);
  git(repository, 'add', '-A');
  git(repository, 'commit', '-qm', 'the code the fill reads');
  symlinkSync(repository, join(product, 'repos', `${name}-code`), 'dir');
  writeFileSync(join(product, 'workspace.yaml'), `schemaVersion: 1\nid: ${PRODUCT_IDS[name]}\nname: ${name}\nrepos:\n  - name: ${name}-code\n    url: file:///${name}-code\n`);
  writeFirstFillWorkflow(product);
  git(product, 'init', '-q', '-b', 'main');
  git(product, 'add', '-A');
  git(product, 'commit', '-qm', 'the product the fill reads');
  return product;
}

/** The store the fill runs in, as the server's `knowledgeRoot` names it. */
const storeOf = (name: string): string => join(root, 'store', PRODUCT_IDS[name]!);

/** The state the fill's own process wrote, if any. */
function fillState(name: string): { runId: string; state: string; pid: number; snapshot?: number; message?: string } | undefined {
  try {
    return JSON.parse(readFileSync(join(storeOf(name), 'fill-state.json'), 'utf8')) as { runId: string; state: string; pid: number; snapshot?: number; message?: string };
  } catch {
    return undefined;
  }
}

/** One product's answer, timed: the promise settles with the body and the milliseconds it took. */
async function timed(path: string): Promise<{ status: number; ms: number; body: Record<string, unknown> }> {
  const started = performance.now();
  const answer = await fetch(`${server.url}${path}`, { headers: { accept: 'application/json' } });
  const body = (await answer.json()) as Record<string, unknown>;
  return { status: answer.status, ms: performance.now() - started, body };
}

/** Waits for the product's fill to reach one state, bounded by the deadline it names. */
async function untilState(name: string, states: readonly string[], deadlineMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const status = await timed(`/products/${name}/api/k/status`);
    const fill = status.body['fill'] as { state?: string; message?: string } | undefined;
    if (fill !== undefined && states.includes(String(fill.state))) return status.body;
    if (Date.now() > deadline) throw new Error(`the fill of ${name} did not reach ${states.join(' or ')} within ${String(deadlineMs)} ms: it stands ${JSON.stringify(fill)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-fill-child-'));
  home = join(root, 'products');
  mkdirSync(join(root, 'store'), { recursive: true });
  makeFixture('walk-a');
  const app = join(root, 'app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>walk</title>\n');
  server = await startServer({ productHome: home, knowledgeRoot: join(root, 'store'), appFolder: app, port: 0, log: () => undefined, errorLog: () => undefined });
}, 240_000);

afterAll(async () => {
  await server?.stop();
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

describe('the fill is a process of its own', () => {
  test('a page answers within the bound while the fill runs, and the fill is another process', async () => {
    const pressed = await fetch(`${server.url}/products/walk-a/api/k/fill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: null }) });
    expect(pressed.status).toBe(202);
    // The child is named by the fill's own state file, and it is not this process.
    const deadline = Date.now() + 10_000;
    while (fillState('walk-a')?.state !== 'running' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    const running = fillState('walk-a');
    expect(running?.state).toBe('running');
    expect(running!.pid).not.toBe(process.pid);
    // The pages answer while the fill really runs: both reads are inside the bound, and the fill is still running at
    // the second one. A fill in the server's process would hold the event loop for the slow unit and miss the bound.
    const status = await timed('/products/walk-a/api/k/status');
    expect(status.ms).toBeLessThan(ANSWER_BOUND_MS);
    expect((status.body['fill'] as { state?: string }).state).toBe('running');
    const files = await timed('/products/walk-a/api/k/entities?kind=code.file&limit=5');
    expect(files.ms).toBeLessThan(ANSWER_BOUND_MS);
    expect(files.status).toBe(200);
    expect(fillState('walk-a')?.state).toBe('running');
    // The run ends, the child made the snapshot, and the pages read it.
    const done = await untilState('walk-a', ['done'], 240_000);
    expect(done['fill']).toMatchObject({ state: 'done' });
    const read = await timed('/products/walk-a/api/k/entities?kind=code.file&limit=100');
    expect(JSON.stringify(read.body)).toContain('src/slow.ts');
  }, 300_000);

  test('a child killed mid-fill is a failure the wiki says, and a press starts again', async () => {
    // A second product of its own: its first fill is a full one, so it is running when the child is killed.
    makeFixture('walk-b');
    const pressed = await fetch(`${server.url}/products/walk-b/api/k/fill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: null }) });
    expect(pressed.status).toBe(202);
    const previous = fillState('walk-b')?.runId;
    const deadline = Date.now() + 10_000;
    while (!(fillState('walk-b')?.state === 'running' && fillState('walk-b')?.runId !== previous) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    const running = fillState('walk-b');
    expect(running?.state).toBe('running');
    expect(running!.runId).not.toBe(previous);
    // The child is killed outright: the wiki hears it, names it, and the press after it starts a new run.
    process.kill(running!.pid, 'SIGKILL');
    const failed = await untilState('walk-b', ['failed'], 30_000);
    expect((failed['fill'] as { code?: string }).code).toBe('worker-exit');
    expect(String((failed['fill'] as { message?: string }).message)).toContain('ended before the run did');
    const again = await fetch(`${server.url}/products/walk-b/api/k/fill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: null }) });
    expect(again.status).toBe(202);
    const done = await untilState('walk-b', ['done'], 240_000);
    expect(done['fill']).toMatchObject({ state: 'done' });
  }, 400_000);
});
