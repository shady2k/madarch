/**
 * A page answers while a fill runs (madarch-m38l.4, remark 3). The owner's walk: every page took about 3 seconds
 * during a fill, because the fill ran in the server's own process and PGlite runs a statement on the thread that
 * owns it. The fill is a worker process now and the server reads a snapshot of its store, so the 99th percentile of every page
 * during the fill of the generated training repository must stay under 300 ms, and no answer may take a second.
 *
 * The fill of the training repository takes about 50 s on the pod; `MADARCH_SKIP_PERF=1` skips it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type StartedServer } from '../src/server/http.js';
import { generateTrainingRepository, makeProduct, PAY } from './knowledge-fixture.js';

const skip = process.env['MADARCH_SKIP_PERF'] === '1';
const BOUND_MS = 300;
/** The slowest single answer allowed: a cold first render under three readers at once on a two-core machine. */
const WORST_MS = 1_000;

let work: string;
let server: StartedServer;

beforeAll(async () => {
  if (skip) return;
  work = mkdtempSync(join(tmpdir(), 'madarch-responsive-'));
  const repository = generateTrainingRepository(join(work, 'training'));
  const home = join(work, 'home');
  mkdirSync(home);
  makeProduct(home, 'shop', repository, 'training');
  const app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>app</title><div id="root"></div>');
  server = await startServer({ productHome: home, appFolder: app, port: 0, knowledgeRoot: join(work, 'store'), log: () => undefined, errorLog: (line) => console.error(line) });
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await server.stop();
  rmSync(work, { recursive: true, force: true });
}, 60_000);

describe.skipIf(skip)('the wiki while a fill runs', () => {
  test('every page answers within 300 ms during the fill of the training repository, and the files it counts are listed', async () => {
    const base = `${server.url}/products/shop`;
    // The wiki is open before the press, as it is in a reader's browser: the reader of the store has started.
    for (const path of ['/api/k/status', '/api/k/entities?kind=code.file&limit=100', `/api/k/page?id=${encodeURIComponent(PAY)}`]) await fetch(base + path);
    const press = await fetch(`${base}/api/k/fill`, { method: 'POST' });
    expect(press.status).toBe(202);
    const paths = [
      '/api/k/status',
      '/api/k/entities?kind=code.file&limit=100',
      '/api/k/entities?kind=code.symbol&limit=100',
      `/api/k/page?id=${encodeURIComponent(PAY)}`,
      `/api/k/page?id=${encodeURIComponent('code.file:services/payments/src/providers/factory.ts')}`,
      '/api/k/documents',
    ];
    const samples: { path: string; ms: number; running: boolean; at: number; phase: string }[] = [];
    let phase = 'none';
    let running = true;
    const started = Date.now();
    let lastFiles = 0;
    const ask = async (path: string): Promise<void> => {
      const at = performance.now();
      const response = await fetch(base + path);
      const body = await response.text();
      const ms = performance.now() - at;
      if (path === '/api/k/status' && response.ok) { const fill = (JSON.parse(body) as { fill: { state: string; phase?: string } }).fill; running = fill.state === 'running'; phase = fill.phase ?? fill.state; }
      if (path.startsWith('/api/k/entities?kind=code.file') && response.ok) lastFiles = (JSON.parse(body) as { rows: unknown[] }).rows.length;
      if (response.ok || response.status === 404) samples.push({ path: path.slice(0, 48), ms, running, at: Math.round(Date.now() - started), phase });
    };
    // Three readers at once, as a reader's browser asks (the page and what it holds), until the fill ends.
    while (running && Date.now() - started < 1_200_000) {
      await Promise.all([ask(paths[0]!), ask(paths[1]!), ask(paths[3]!)]);
      await Promise.all([ask(paths[2]!), ask(paths[4]!), ask(paths[5]!)]);
      await new Promise((rest) => setTimeout(rest, 60));
    }
    const during = samples.filter((sample) => sample.running);
    const byPath = new Map<string, number[]>();
    for (const sample of during) byPath.set(sample.path, [...(byPath.get(sample.path) ?? []), sample.ms]);
    const stat = (list: number[]): string => { const sorted = [...list].sort((a, b) => a - b); return `n ${sorted.length}, p50 ${Math.round(sorted[Math.floor(sorted.length / 2)]!)}, p99 ${Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))]!)}, max ${Math.round(sorted[sorted.length - 1]!)} ms`; };
    console.log(`the fill ran ${Math.round((Date.now() - started) / 1000)} s; answers during it: ${stat(during.map((sample) => sample.ms))}`);
    for (const [path, list] of byPath) console.log(`  ${path}: ${stat(list)}`);
    for (const slow of during.filter((sample) => sample.ms > 150).sort((a, b) => a.at - b.at)) console.log(`  slow: ${Math.round(slow.ms)} ms at ${slow.at} ms in the ${slow.phase} phase: ${slow.path}`);
    // Every path answers within 300 ms at its 99th percentile while the fill runs (the owner's walk: about 3 s for every
    // page), and nothing waits for a commit: the slowest single answer is the first render of the heaviest page, which
    // three readers ask at once right after the code is first published, and it stays far under the seconds of the walk.
    for (const [path, list] of byPath) {
      const sorted = [...list].sort((a, b) => a - b);
      const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))]!;
      expect(p99, `the 99th percentile of ${path} during the fill was ${Math.round(p99)} ms`).toBeLessThan(BOUND_MS);
    }
    const slowest = [...during].sort((a, b) => b.ms - a.ms)[0]!;
    expect(during.length).toBeGreaterThan(30);
    expect(slowest.ms, `the slowest answer during the fill was ${Math.round(slowest.ms)} ms (${slowest.path})`).toBeLessThan(WORST_MS);
    // The Files list shows files while the count says how many there are (the empty list of the owner's walk).
    expect(lastFiles).toBeGreaterThan(0);
    const status = await (await fetch(`${base}/api/k/status`)).json() as { fill: { state: string }; kinds: { kind: string; count: number }[] };
    expect(status.fill.state).toBe('done');
    const files = await (await fetch(`${base}/api/k/entities?kind=code.file&limit=100`)).json() as { total: number; rows: unknown[] };
    expect(files.total).toBe(status.kinds.find((kind) => kind.kind === 'code.file')!.count);
    expect(files.rows.length).toBe(Math.min(100, files.total));
  }, 1_500_000);
});
