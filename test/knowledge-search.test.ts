/**
 * The wiki's search over HTTP (madarch-o0d): pages and entities by title and text, grouped by kind, read from the same
 * product read as the pages — the Markdown the manifest declares, and the store the graph lives in. The product is a
 * fixture of its own: the starter set seeds its manifest, and two sample pages stand in its repository.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type StartedServer } from '../src/server/http.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY, makeProduct, writeSamplePages } from './knowledge-fixture.js';

let work: string;
let server: StartedServer;

const get = async (path: string): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${server.url}${path}`);
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status, body };
};

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'madarch-knowledge-search-'));
  const repository = join(work, 'repo');
  mkdirSync(join(repository, 'src'), { recursive: true });
  writeFileSync(join(repository, 'README.md'), '# Shop\n\nA search fixture.\n');
  writeFileSync(join(repository, 'src', 'pay.ts'), 'export function pay(): number { return 1; }\n');
  const env = gitEnv(SAMPLE_IDENTITY);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: repository, env });
  execFileSync('git', ['add', '-A'], { cwd: repository, env });
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Seed'], { cwd: repository, env });
  const home = join(work, 'home');
  mkdirSync(home);
  const product = makeProduct(home, 'shop', repository, 'shop');
  const app = join(work, 'app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'index.html'), '<!doctype html><html><head><title>app</title></head><body><div id="root"></div></body></html>');
  server = await startServer({ productFolder: product, appFolder: app, port: 0, knowledgeRoot: join(work, 'store'), log: () => undefined, errorLog: (line) => console.error(line) });
  // The fixture product holds its own copy of the starter set; the pages then stand in the product's repository.
  const seeded = await fetch(`${server.url}/api/status`);
  expect(seeded.status).toBe(200);
  writeSamplePages(product);
  // The pages and the manifest are the graph's for a reader: a fill reads the product repository into it.
  const started = await fetch(`${server.url}/api/fill`, { method: 'POST' });
  expect(started.status).toBe(202);
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const state = (await (await fetch(`${server.url}/api/status`)).json() as { fill: { state: string } }).fill.state;
    if (state !== 'running') break;
    await new Promise((rest) => setTimeout(rest, 250));
  }
}, 300_000);

afterAll(async () => {
  await server.stop();
  rmSync(work, { recursive: true, force: true });
});

describe('the wiki search', () => {
  test('a page is found by the text of its body, with the words around the match and its address', async () => {
    const answer = await get('/api/search?q=shoppers&lang=en');
    expect(answer.status).toBe(200);
    expect(answer.body.query).toBe('shoppers');
    expect(answer.body.total).toBeGreaterThan(0);
    const group = answer.body.groups.find((entry: { kind: string }) => entry.kind === 'product');
    expect(group).toBeDefined();
    expect(group.total).toBe(1);
    expect(group.rows[0]).toMatchObject({ id: 'product:shop', kind: 'product', title: 'Online shop', href: expect.stringContaining('/e/') });
    expect(group.rows[0].excerpt).toContain('shoppers');
    expect(group.rows[0].excerpt).not.toContain('<!--');
  });

  test('a page is found by its title in the wiki\'s language, and the case of the query does not matter', async () => {
    const answer = await get('/api/search?q=Payment&lang=ru');
    expect(answer.status).toBe(200);
    const group = answer.body.groups.find((entry: { kind: string }) => entry.kind === 'domain');
    expect(group?.rows[0]).toMatchObject({ id: 'domain:payment', title: 'Payment' });
    const upper = await get('/api/search?q=SHOPPERS&lang=en');
    expect(upper.body.total).toBeGreaterThan(0);
  });

  test('an empty query asks nothing, a word nothing holds finds nothing, and an over-long query is refused in words', async () => {
    const empty = await get('/api/search?q=&lang=en');
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ groups: [], total: 0 });
    const nothing = await get('/api/search?q=zzz-nothing-holds-this&lang=en');
    expect(nothing.status).toBe(200);
    expect(nothing.body).toMatchObject({ groups: [], total: 0 });
    const long = await get(`/api/search?q=${'w'.repeat(201)}&lang=en`);
    expect(long.status).toBe(400);
    expect(long.body.error.field).toBe('q');
    expect(long.body.message).toContain('200');
  });
});
