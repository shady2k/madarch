import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type StartedServer } from '../src/server/http.js';
import { activateTestProduct, retainTestStorePreparationOwner } from './prepared-server.js';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { knowledgeRootOf } from '../src/product/store.js';
import { authoredEnv, authoredFixture } from './authored-fixture.js';

let work: string;
let server: StartedServer;
let base: string;
let home: string;
let folder: string;
let closePreparationOwner: (() => Promise<void>) | undefined;
beforeAll(async () => {
  closePreparationOwner = await retainTestStorePreparationOwner();
  work = mkdtempSync(join(tmpdir(), 'authored-http-'));
  home = join(work, 'products');
  folder = await authoredFixture(home);
  const empty = await authoredFixture(home, 'empty', false);
  await activateTestProduct(folder, home);
  await activateTestProduct(empty, home);
  const app = join(work, 'app');
  mkdirSync(app); writeFileSync(join(app, 'index.html'), '<!doctype html><title>Fixture</title>');
  server = await startServer({ productHome: home, appFolder: app, knowledgeRoot: knowledgeRootOf(home), port: 0, env: authoredEnv, log: () => {}, errorLog: () => {} });
  base = `${server.url}/products/authored/api/authored?kind=note`;
}, 60000);
afterAll(async () => {
  try { await server?.stop(); } finally {
    try { await closePreparationOwner?.(); } finally {
      if (work) rmSync(work, { recursive: true, force: true });
    }
  }
});
const send = (method: string, body: unknown, uid = '') => fetch(base + (uid ? `&uid=${encodeURIComponent(uid)}` : ''), { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('HTTP authors a kind from its contract, errors at the field, refuses cross-site and keeps history on delete', async () => {
  const invalid = await send('POST', { values: { title: 3 } });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({ error: { field: 'title' } });
  const created = await send('POST', { values: { title: 'A person said this', count: 1 }, words: '  exact words\r\n' });
  expect(created.status).toBe(201);
  const made = await created.json() as { entity: { uid: string; id: string } };
  expect(made.entity.id).toStartWith('authored-');
  expect((await fetch(`${server.url}/products/authored/api/status`)).status).toBe(200);
  expect((await fetch(`${base}&uid=${made.entity.uid}`)).status).toBe(200);
  const product = new KnowledgeProduct({ productFolder: folder, storeRoot: knowledgeRootOf(home), env: authoredEnv });
  try { expect(await product.reset()).toMatchObject({ ok: false, message: expect.stringContaining('person-authored history') }); } finally { await product.close(); }
  const changed = await send('PATCH', { values: { count: 2 } }, made.entity.uid);
  expect(changed.status).toBe(200);
  expect(await changed.json()).toMatchObject({ entity: { values: { title: 'A person said this', count: 2 } } });
  const foreign = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: '{"values":{"title":"No"}}' });
  expect(foreign.status).toBe(403);
  expect((await send('DELETE', {}, made.entity.uid)).status).toBe(200);
  expect(await (await fetch(base)).json()).toMatchObject({ entities: [] });
}, 30000);

test('before first permitted fill the newcomer is told what to press and no entity is created', async () => {
  const response = await fetch(`${server.url}/products/empty/api/authored?kind=note`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"values":{"title":"No fill"}}' });
  expect(response.status).toBe(409);
  expect(JSON.stringify(await response.json())).toContain('press Fill first');
});

test('conditional HTTP edits preserve intervening fields and report conflicts with the current author', async () => {
  const madeResponse = await send('POST', { values: { title: 'Alice title', count: 1 } });
  const made = await madeResponse.json() as { entity: { uid: string; revision: string } };
  const read = await fetch(`${base}&uid=${made.entity.uid}`);
  const etag = read.headers.get('etag');
  expect(etag).toBe(`"${made.entity.revision}"`);
  await send('PATCH', { values: { title: 'Bob title' } }, made.entity.uid);
  const patch = (values: Record<string, unknown>) => fetch(`${base}&uid=${made.entity.uid}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', 'if-match': etag! }, body: JSON.stringify({ values }),
  });
  const unrelated = await patch({ count: 2 });
  expect(unrelated.status).toBe(200);
  expect(await unrelated.json()).toMatchObject({ entity: { values: { title: 'Bob title', count: 2 } } });
  const conflict = await patch({ title: 'Alice stale title' });
  expect(conflict.status).toBe(412);
  expect(await conflict.json()).toMatchObject({ error: { field: 'title', conflict: { field: 'title', current: 'Bob title', author: expect.stringContaining('person:') } } });
  await send('DELETE', {}, made.entity.uid);
}, 30000);

test('conditional HTTP deletes refuse stale and invalid If-Match revisions before removing an entity', async () => {
  const made = await (await send('POST', { values: { title: 'Delete baseline', count: 1 } })).json() as { entity: { uid: string; revision: string } };
  const other = await (await send('POST', { values: { title: 'Other entity' } })).json() as { entity: { uid: string; revision: string } };
  const changed = await (await send('PATCH', { values: { count: 2 } }, made.entity.uid)).json() as { entity: { revision: string } };
  const remove = (revision: string) => fetch(`${base}&uid=${made.entity.uid}`, {
    method: 'DELETE', headers: { 'content-type': 'application/json', 'if-match': `"${revision}"` }, body: '{}',
  });
  expect((await remove('invalid')).status).toBe(400);
  for (const revision of [made.entity.revision, '0', other.entity.revision]) {
    expect((await remove(revision)).status).toBe(412);
    expect(await (await fetch(`${base}&uid=${made.entity.uid}`)).json()).toMatchObject({ entity: { revision: changed.entity.revision, values: { count: 2 } } });
  }
  expect((await remove(changed.entity.revision)).status).toBe(200);
  expect((await fetch(`${base}&uid=${made.entity.uid}`)).status).toBe(404);
  expect((await send('DELETE', {}, other.entity.uid)).status).toBe(200);
}, 30000);
