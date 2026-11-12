/**
 * The api role's first page on a filled-size store (review of d3e9e50c): a store whose last fill wrote a
 * 150 000-span trace. The status answer must not parse the whole trace for every poll; the first answer is
 * bounded, and the later answers are the cached reading.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDraft } from '../src/product/draft.js';
import { knowledgeRootOf, productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { createRun } from '../src/fill/state-store.js';
import type { StartedServer } from '../src/server/http.js';
import { startPreparedServer as startServer } from './prepared-server.js';
import { gitEnv } from './git-env.js';
import { fillInProcess } from './fill-inline.js';
import { SAMPLE_IDENTITY, withoutPluginTurns } from './knowledge-fixture.js';

const env = gitEnv(SAMPLE_IDENTITY);
let root = '';
let product = '';
let server: StartedServer | undefined;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-api-role-'));
  const home = join(root, 'products');
  const app = join(root, 'app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>wiki</title>\n');
  const draft = createDraft({ home, name: 'api-role', gitEnv: env });
  if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
  product = draft.folder;
  withoutPluginTurns(product);
  await fillInProcess(product, home);
  const store = productStoreFolder(product, knowledgeRootOf(home));
  mkdirSync(join(store, 'traces'), { recursive: true });
  const start = 1_700_000_000_000_000_000;
  const lines: string[] = [];
  for (let at = 0; at < 150_000; at += 1) {
    lines.push(JSON.stringify({
      traceId: 'trace', spanId: `span-${String(at)}`, name: at % 10 === 0 ? 'db.SELECT' : 'fill.unit',
      startTimeUnixNano: start + at * 1_000, endTimeUnixNano: start + at * 1_000 + 900,
      attributes: [{ key: 'madarch.step', value: { stringValue: 'repository-tree' } }],
    }));
  }
  const runId = 'fill-20261109T000000000Z';
  const owner = await createDatabaseOwner({ store: storeDatabasePath(store), connectOnly: true });
  try { await createRun(owner, { runId, product: 'api-role', at: Date.now() + 1_000 }); }
  finally { await owner.close(); }
  writeFileSync(join(store, 'traces', `${runId}.jsonl`), `${lines.join('\n')}\n`);
  server = await startServer({ productFolder: product, knowledgeRoot: knowledgeRootOf(home), appFolder: app, port: 0, log: () => undefined, errorLog: () => undefined });
}, 120_000);

afterAll(async () => {
  await server?.stop();
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

test('the first status answer on a 150 000-span store answers within 5 seconds', async () => {
  const at = Date.now();
  const answer = await fetch(`${server!.url}/api/status`, { headers: { accept: 'application/json' } });
  const elapsed = Date.now() - at;
  expect(answer.status).toBe(200);
  const body = await answer.json();
  expect(body.manifest).toBe('ok');
  expect(body.fill.run.runId).toBe('fill-20261109T000000000Z');
  expect(body.fill.run.state).toBe('created');
  expect(body.fill.run.spans).toBe(150_000);
  expect(body.fill.run.steps.map((step: { step: string }) => step.step)).toEqual(['repository-tree']);
  // A fill now writes about 300 spans; 150 000 is a store left by a fill before the trace was bounded. The
  // quadratic reading this guards against took 303 s here; measured after the fix: 1.0 s on the worker VM,
  // 2.1 s on the CI runner (run 42722618397), so 5 s keeps the guard without timing the runner.
  expect(elapsed).toBeLessThan(5_000);
  const secondAt = Date.now();
  const second = await fetch(`${server!.url}/api/status`, { headers: { accept: 'application/json' } });
  const secondElapsed = Date.now() - secondAt;
  expect(second.status).toBe(200);
  expect(secondElapsed).toBeLessThan(50);
}, 30_000);
