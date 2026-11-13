/** Authored entities replace the retired Markdown lifecycle over HTTP. No agent runs. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StartedServer } from '../src/server/http.js';
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { knowledgeRootOf, productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { authoredEnv, authoredFixture } from './authored-fixture.js';
import { startPreparedServer } from './prepared-server.js';

let work: string;
let folder: string;
let server: StartedServer;
let base: string;
let store: string;
const send = (path: string, body: unknown, method = 'POST') => fetch(`${base}${path}`, {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const revision = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: folder, env: authoredEnv, encoding: 'utf8' });

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'madarch-loop-http-'));
  const home = join(work, 'products');
  folder = await authoredFixture(home);
  store = productStoreFolder(folder, knowledgeRootOf(home));
  const app = join(work, 'app');
  mkdirSync(app); writeFileSync(join(app, 'index.html'), '<!doctype html><title>Fixture</title>');
  server = await startPreparedServer({ productHome: home, appFolder: app, knowledgeRoot: knowledgeRootOf(home), port: 0, env: authoredEnv, log: () => {}, errorLog: () => {} });
  base = `${server.url}/products/authored/api`;
}, 60_000);
afterAll(async () => { await server?.stop(); if (work) rmSync(work, { recursive: true, force: true }); });

function noMarkdownWrites(before: string): void {
  expect(revision()).toBe(before);
  for (const path of ['docs/questions', 'docs/answers', 'docs/tasks', 'docs/corrections', 'docs/problems']) {
    expect(existsSync(join(folder, path))).toBe(false);
  }
  expect(execFileSync('git', ['status', '--porcelain'], { cwd: folder, env: authoredEnv, encoding: 'utf8' })).toBe('');
}

test('create, read, update and withdraw use the declared DB kind without Markdown files or commits', async () => {
  const before = revision();
  const endpoint = '/authored?kind=note';
  const created = await send(endpoint, { values: { title: 'Use the caller discount', count: 1 }, words: '  Keep my words\r\n' });
  expect(created.status).toBe(201);
  const made = await created.json() as { entity: { uid: string; values: unknown; opinions: unknown[] } };
  expect(made.entity.uid).toMatch(/^[0-9a-f-]{36}$/u);
  expect(made.entity.values).toEqual({ title: 'Use the caller discount', count: 1 });
  expect(made.entity.opinions.length).toBeGreaterThan(0);
  const entity = `${endpoint}&uid=${encodeURIComponent(made.entity.uid)}`;
  const read = await fetch(`${base}${entity}`);
  expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject({ entity: { uid: made.entity.uid, values: made.entity.values } });
  const updated = await send(entity, { values: { count: 2 }, words: 'Revise the count' }, 'PATCH');
  expect(updated.status).toBe(200);
  expect(await updated.json()).toMatchObject({ entity: { uid: made.entity.uid, values: { title: 'Use the caller discount', count: 2 } } });
  expect((await send(entity, { words: 'Withdraw my request' }, 'DELETE')).status).toBe(200);
  expect((await fetch(`${base}${entity}`)).status).toBe(404);
  expect(await (await fetch(`${base}${endpoint}`)).json()).toMatchObject({ entities: [] });
  // Withdrawal hides the entity, not its authored history or exact original words.
  const owner = await createDatabaseOwner({ store: storeDatabasePath(store), btreeGist: true });
  try {
    await owner.ready;
    const operations = await owner.run((tx) => tx.query<{ author: string; words: string }>(
      'SELECT author, words FROM operation WHERE words = ANY($1::text[]) ORDER BY seq',
      [['  Keep my words\r\n', 'Revise the count', 'Withdraw my request']],
    ));
    expect(operations.rows.map((row) => row.words)).toEqual(['  Keep my words\r\n', 'Revise the count', 'Withdraw my request']);
    expect(new Set(operations.rows.map((row) => row.author))).toEqual(new Set([`person:${authoredEnv.GIT_AUTHOR_NAME} <${authoredEnv.GIT_AUTHOR_EMAIL}>`]));
    const history = await owner.run((tx) => tx.query<{ removed: boolean }>('SELECT removed FROM node WHERE uid = $1::uuid', [made.entity.uid]));
    expect(history.rows).toEqual([{ removed: true }]);
    const refused = await send('/reset', {});
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { message: expect.stringContaining(`${store}:1:`) } });
    const retained = await owner.run((tx) => tx.query<{ count: number }>('SELECT count(*) AS count FROM operation WHERE words = ANY($1::text[])', [['  Keep my words\r\n', 'Revise the count', 'Withdraw my request']]));
    expect(retained.rows).toEqual([{ count: 3 }]);
  } finally { await owner.close(); }
  noMarkdownWrites(before);
}, 30_000);

const retiredReads = ['/question?id=discount', '/questions', '/task?id=discount', '/tasks'];
const retiredWrites: readonly [string, unknown][] = [
  ['/answer', { question: 'discount', text: 'Use the caller value.' }],
  ['/correction', { statement: 'domain:orders#discount', reason: 'Use the caller value.' }],
  ['/problem-task', { id: 'old-problem' }],
  ['/task-close', { id: 'discount' }],
  ['/task-create', { question: 'discount', title: 'Use the caller value', grounds: ['doc:README.md'], scope: [{ type: 'file', path: 'README.md' }] }],
  ['/task-propose', { question: 'discount', choice: 'docs' }],
];
for (const path of retiredReads) {
  test(`retired GET ${path} refuses with an absolute location and changes nothing`, async () => {
    const before = revision();
    const response = await fetch(`${base}${path}`);
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining(`${join(folder, 'madarch/catalog.yaml')}:1:`) } });
    noMarkdownWrites(before);
  });
}
for (const [path, body] of retiredWrites) {
  test(`retired POST ${path} refuses with an absolute location and changes nothing`, async () => {
    const before = revision();
    const response = await send(path, body);
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining(`${join(folder, 'madarch/catalog.yaml')}:1:`) } });
    noMarkdownWrites(before);
  });
}

test('generic authored writes retain same-site, JSON and field validation', async () => {
  const path = `${base}/authored?kind=note`;
  const foreign = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: JSON.stringify({ values: { title: 'No' } }) });
  expect(foreign.status).toBe(403);
  expect((await fetch(path, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
  expect((await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' })).status).toBe(400);
  const invalid = await send('/authored?kind=note', { values: { title: 1 } });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({ error: { field: 'title' } });
});

test('retired task execution refuses without starting a fill', async () => {
  const before = revision();
  const response = await send('/task-run', { id: 'discount' });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining(`${join(folder, 'madarch/catalog.yaml')}:1:`) } });
  noMarkdownWrites(before);
});

test('a dismissal for a missing generic problem is refused without writing files', async () => {
  const before = revision();
  const response = await send('/problem-dismiss', { id: 'missing-problem', reason: 'Not a problem.' });
  expect(response.status, await response.clone().text()).toBe(404);
  expect(await response.json()).toMatchObject({ error: { field: 'id' } });
  noMarkdownWrites(before);
});
