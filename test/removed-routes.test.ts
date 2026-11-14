/**
 * Nothing deleted by decision 0036, section 8 is still served: every read route the record deletes answers 404, and the
 * one read API answers (C11: "a test that each removed route answers 404").
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StartedServer } from '../src/server/http.js';
import { startPreparedServer } from './prepared-server.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY, makeProduct } from './knowledge-fixture.js';

/** Every read route section 8 deletes, as the app addressed it (`<id>` stands for any entity id). */
const REMOVED: readonly string[] = [
  '/api/page?id=product:shop',
  '/api/block?id=product:shop&block=body',
  '/api/entities?kind=code.file',
  '/api/catalog',
  '/api/search?q=shop',
  '/api/facts',
  '/api/statement?id=product:shop',
  '/api/neighborhood?id=product:shop',
  '/api/view?view=er',
  '/api/view-frame?view=er',
  '/api/glossary',
  '/api/documents',
  '/api/document?path=docs/product.md',
  '/api/authored-schema?kind=note',
  '/api/problems',
  '/api/questions',
  '/api/question?id=one',
  '/api/tasks',
  '/api/task?id=one',
  '/llms.txt',
];

/** The addresses the app itself owns now (decision 0036, section 7): a page route, never a Markdown answer. */
const APP_PAGES: readonly string[] = ['/e/product:shop.md', '/kind/domain.md'];

/** The paths whose writes section 8 keeps: their read methods answer 405, and no other method but the kept ones. */
const WRITE_ONLY: readonly string[] = ['/api/authored?kind=note'];

let work = '';
let server: StartedServer | undefined;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'madarch-removed-routes-'));
  const repository = join(work, 'code');
  mkdirSync(repository, { recursive: true });
  const env = gitEnv(SAMPLE_IDENTITY);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repository, env });
  writeFileSync(join(repository, 'README.md'), '# Code\n');
  execFileSync('git', ['add', '-A'], { cwd: repository, env });
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'first'], { cwd: repository, env });
  const home = join(work, 'products');
  makeProduct(home, 'shop', repository, 'shop-code');
  const app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>app</title>');
  server = await startPreparedServer({ productHome: home, appFolder: app, knowledgeRoot: join(work, 'store'), port: 0, log: () => undefined, errorLog: () => undefined });
}, 120_000);

afterAll(async () => {
  await server?.stop();
  if (work !== '') rmSync(work, { recursive: true, force: true });
});

test('every read route section 8 deletes answers 404', async () => {
  for (const path of REMOVED) {
    const response = await fetch(`${server!.url}/products/shop${path}`);
    expect({ path, status: response.status }).toEqual({ path, status: 404 });
  }
}, 60_000);

test('a path whose writes are kept answers no read: GET is method not allowed', async () => {
  for (const path of WRITE_ONLY) {
    const response = await fetch(`${server!.url}/products/shop${path}`);
    expect({ path, status: response.status }).toEqual({ path, status: 405 });
  }
}, 60_000);

test('the app addresses answer the app shell as HTML, not a page rendered by the server', async () => {
  for (const path of APP_PAGES) {
    const response = await fetch(`${server!.url}/products/shop${path}`);
    expect({ path, status: response.status }).toEqual({ path, status: 200 });
    expect(response.headers.get('content-type') ?? '').toContain('text/html');
    expect(await response.text()).toContain('<!doctype html>');
  }
}, 60_000);

test('the one read API answers, and the routes section 8 keeps are served', async () => {
  const graphql = await fetch(`${server!.url}/products/shop/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ __typename }' }) });
  expect(graphql.status).toBe(200);
  expect((await fetch(`${server!.url}/products/shop/api/status`)).status).toBe(200);
  expect((await fetch(`${server!.url}/products/shop/api/product`)).status).toBe(200);
}, 60_000);
