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
