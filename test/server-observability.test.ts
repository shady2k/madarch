/**
 * The server's own record of its requests (the owner's words, 2026-11-14): every request says it started and how it went,
 * its span names the method and the route, and a request still running past the bound warns with the stage it stands in —
 * so a hung API is visible in the trace and the log, and `madarch trace --slow` lists it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPreparedServer } from './prepared-server.js';
import type { StartedServer } from '../src/server/http.js';
import { SAMPLE_IDENTITY, makeProduct } from './knowledge-fixture.js';
import { watchRequest, type WatchdogReport } from '../src/server/watchdog.js';

/** A clock a test drives: the warning is read without waiting for it. */
function fakeClock(): { clock: { setTimeout: (work: () => void, ms: number) => unknown; clearTimeout: (handle: unknown) => void }; fire: () => void; cleared: () => number } {
  let work: (() => void) | undefined;
  let cleared = 0;
  return {
    clock: {
      setTimeout: (held: () => void) => { work = held; return 1; },
      clearTimeout: () => { work = undefined; cleared += 1; },
    },
    fire: () => work?.(),
    cleared: () => cleared,
  };
}

describe('the request watchdog', () => {
  test('a request still running after the bound warns with its path and the stage it stands in', () => {
    const seen: WatchdogReport[] = [];
    const held = fakeClock();
    let at = 0;
    const armed = watchRequest({ requestId: 'r1', httpMethod: 'GET', httpPath: '/e/code.directory/1' }, (report) => seen.push(report), { clock: held.clock, now: () => at });
    armed.stage('laying out (likec4)');
    at = 2_000;
    held.fire();
    expect(seen).toEqual([{ requestId: 'r1', httpMethod: 'GET', httpPath: '/e/code.directory/1', stage: 'laying out (likec4)', elapsedMs: 2_000 }]);
  });

  test('a request that ends first clears the timer and warns nothing', () => {
    const seen: WatchdogReport[] = [];
    const held = fakeClock();
    const armed = watchRequest({ requestId: 'r2', httpMethod: 'GET', httpPath: '/graphql' }, (report) => seen.push(report), { clock: held.clock, now: () => 0 });
    armed.done();
    held.fire();
    expect(seen).toEqual([]);
    expect(held.cleared()).toBe(1);
  });
});

describe('the server logs and traces its requests', () => {
  let root = '';
  let server: StartedServer | undefined;
  let trace = '';
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'madarch-observability-'));
    const home = join(root, 'products');
    const app = join(root, 'app');
    const repository = join(root, 'code');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(app, { recursive: true });
    mkdirSync(repository, { recursive: true });
    writeFileSync(join(app, 'index.html'), '<!doctype html><title>wiki</title>\n');
    const { execFileSync } = await import('node:child_process');
    const { gitEnv } = await import('./git-env.js');
    const env = gitEnv(SAMPLE_IDENTITY);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repository, env });
    writeFileSync(join(repository, 'README.md'), '# Code\n');
    execFileSync('git', ['add', '-A'], { cwd: repository, env });
    execFileSync('git', ['commit', '-qm', 'the tree'], { cwd: repository, env });
    const folder = makeProduct(home, 'traced', repository, 'traced-code');
    process.env.MADARCH_WATCHDOG_MS = '1';
    server = await startPreparedServer({ productHome: home, appFolder: app, port: 0, log: () => undefined, errorLog: () => undefined, knowledgeRoot: join(root, 'state') });
    void folder;
    trace = join(root, 'state', 'traces', `server-${String(process.pid)}.jsonl`);
  }, 120_000);
  afterAll(() => {
    delete process.env.MADARCH_WATCHDOG_MS;
    void server?.stop();
    if (root !== '') rmSync(root, { recursive: true, force: true });
  });

  test('the request is in the trace with its method and route, and in the log at its start and its end', async () => {
    const answer = await fetch(`${server!.url}/products/traced/api/status`, { headers: { accept: 'application/json' } });
    expect(answer.status).toBe(200);
    // The spans are written as they end, batched: the file is read once the server's flush has had its moment.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (existsSync(trace) && readFileSync(trace, 'utf8').includes('http.request')) break;
      await new Promise((rest) => setTimeout(rest, 50));
    }
    const spans = existsSync(trace) ? readFileSync(trace, 'utf8').split('\n').filter((line) => line.includes('http.request')) : [];
    expect(spans.length).toBeGreaterThan(0);
    const span = JSON.parse(spans[0]!) as { name: string; attributes: { key: string; value: Record<string, unknown> }[] };
    const attributes = new Map(span.attributes.map((one) => [one.key, one.value['stringValue'] ?? one.value['intValue']]));
    expect(attributes.get('http.request.method')).toBe('GET');
    expect(String(attributes.get('http.route'))).toBe('/api/status');
    const logFile = trace.replace(/\.jsonl$/u, '.log.jsonl');
    const lines = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
    expect(lines).toContain('http.request.start');
    expect(lines).toContain('http.request.end');
  }, 60_000);
});


test('request start and end reach the configured sink without tracing; concurrent stages stay separate', async () => {
  const { createHandler } = await import('../src/server/http.js');
  const { requestStage } = await import('../src/server/stage.js');
  const lines: string[] = [];
  const warnings: string[] = [];
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const handler = createHandler({
    log: (line) => lines.push(line),
    errorLog: (line) => warnings.push(line),
    env: { MADARCH_WATCHDOG_MS: '15' },
    wiki: { app: () => undefined } as never,
    knowledge: {
      diagram: async () => {
        requestStage.getStore()?.stage('reading the neighbourhood');
        await waiting;
        return { response: Response.json({ code: 'TIMEOUT' }) };
      },
    } as never,
  });
  const pending = handler(new Request('http://test/render/diagram'));
  expect(lines.some((line) => line.includes('http.request.start'))).toBe(true);
  const other = await handler(new Request('http://test/not-found'));
  expect(other.status).toBe(404);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const slow = warnings.map((line) => { try { return JSON.parse(line); } catch { return {}; } }).find((line) => line.message === 'http.request.slow');
  expect(slow, JSON.stringify({ lines, warnings })).toMatchObject({ httpPath: '/render/diagram', stage: 'reading the neighbourhood' });
  release!();
  await pending;
  const records = lines.map((line) => { try { return JSON.parse(line); } catch { return {}; } });
  const begin = records.find((line) => line.message === 'http.request.start' && line.httpPath === '/render/diagram');
  const end = records.find((line) => line.message === 'http.request.end' && line.requestId === begin.requestId);
  expect(end).toMatchObject({ status: 200, httpMethod: 'GET', httpPath: '/render/diagram' });
  expect(end.durationMs).toBeGreaterThanOrEqual(15);
});


test('a looping render logs start, warning and cancellation while another page answers', async () => {
  const { writeFileSync } = await import('node:fs');
  const { pathToFileURL } = await import('node:url');
  const { createHandler } = await import('../src/server/http.js');
  const { renderDiagram } = await import('../src/render/diagram-render.js');
  const root = mkdtempSync(join(tmpdir(), 'looping-render-'));
  const worker = join(root, 'loop.ts');
  writeFileSync(worker, "self.onmessage = () => { self.postMessage({ kind: 'stage', stage: 'laying out (likec4)' }); while (true) {} };\n");
  const lines: string[] = [];
  const warnings: string[] = [];
  const handler = createHandler({
    log: (line) => lines.push(line), errorLog: (line) => warnings.push(line),
    wiki: { app: () => undefined } as never,
    knowledge: {
      diagram: async () => ({ response: Response.json(await renderDiagram({ readDeadlineMs: 5_800, diagramNeighbourhood: async () => undefined } as never, { entity: 'loop', format: 'likec4' }, { workerUrl: pathToFileURL(worker) })) }),
    } as never,
  });
  try {
    const pending = handler(new Request('http://test/render/diagram'));
    expect(lines.some((line) => line.includes('http.request.start'))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5_200));
    const started = performance.now();
    expect((await handler(new Request('http://test/a-page'))).status).toBe(404);
    expect(performance.now() - started).toBeLessThan(500);
    const warning = warnings.map((line) => { try { return JSON.parse(line); } catch { return {}; } }).find((line) => line.message === 'http.request.slow');
    expect(warning).toMatchObject({ httpPath: '/render/diagram', stage: 'laying out (likec4)' });
    const answer = await pending;
    expect(await answer.json()).toMatchObject({ code: 'TIMEOUT' });
    const records = lines.map((line) => { try { return JSON.parse(line); } catch { return {}; } });
    const begin = records.find((line) => line.message === 'http.request.start' && line.httpPath === '/render/diagram');
    expect(records.find((line) => line.message === 'http.request.end' && line.requestId === begin.requestId)).toMatchObject({ status: 200 });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 15_000);
