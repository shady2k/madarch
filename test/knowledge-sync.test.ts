/**
 * Sync in the top bar (madarch-u3vw2): the one refresh the wiki has, and what it changed. The fill of the generated
 * training repository is the real one; the product's two Markdown pages stand as an agent wrote them, and one commit
 * adds a function to a file the pages' statements stand on. The status the Sync button reads then names the pages the
 * run changed — the file's page and its new function's page — and every page it names answers at its address.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type StartedServer } from '../src/server/http.js';
import { gitEnv } from './git-env.js';
import { PAY, ROOT, SAMPLE_IDENTITY, generateTrainingRepository, makeProduct, recordKey, writeSamplePages } from './knowledge-fixture.js';

const env = gitEnv(SAMPLE_IDENTITY);
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8' });
const PAYMENT_SERVICE = 'services/payments/src/domain/payment-service.ts';

let work: string;
let server: StartedServer;

const get = async (path: string): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${server.url}${path}`);
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body };
};

/** Presses the refresh the Sync button presses and waits for its end; answers the status it ended on. */
async function refresh(product: string): Promise<any> {
  const press = await fetch(`${server.url}/products/${product}/api/k/fill`, { method: 'POST' });
  expect(press.status).toBe(202);
  let status: any;
  for (let tries = 0; tries < 900; tries += 1) {
    status = (await get(`/products/${product}/api/k/status`)).body;
    if (status.fill.state !== 'running' && status.writer.state !== 'running' && status.writer.state !== 'waiting') break;
    await new Promise((rest) => setTimeout(rest, 250));
  }
  if (status === undefined || status.fill.state === 'running') throw new Error('the fill of the training repository did not end within 225 s');
  // The pages the run changed are recorded when it ends, in a notify of their own: wait a little for the status that has them.
  for (let grace = 0; grace < 40 && status.fill.state === 'done' && status.fill.changed === undefined; grace += 1) {
    await new Promise((rest) => setTimeout(rest, 250));
    status = (await get(`/products/${product}/api/k/status`)).body;
  }
  return status;
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'madarch-knowledge-sync-'));
  const repository = generateTrainingRepository(join(work, 'training'));
  const home = join(work, 'home');
  mkdirSync(home);
  const folder = makeProduct(home, 'shop', repository, 'training');
  writeSamplePages(folder);
  const app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>app</title><div id="root"></div>');
  server = await startServer({ productHome: home, appFolder: app, port: 0, knowledgeRoot: join(work, 'store'), log: () => undefined, errorLog: () => undefined });
  await fetch(`${server.url}/products/shop/api/k/status`);
}, 120_000);

afterAll(async () => {
  await server.stop();
  rmSync(work, { recursive: true, force: true });
}, 60_000);

describe('the sync of the training product', () => {
  test('the first fill lists the pages it wrote, an unchanged refresh changes nothing, and a new commit names the page of the file it touched and the page of the function it added', async () => {
    const first = await refresh('shop');
    expect(first.fill.state).toBe('done');
    const firstChanged: { id: string; title: string }[] = first.fill.changed;
    expect(Array.isArray(firstChanged)).toBe(true);
    // The first fill wrote every page the product has: the two Markdown pages and the code's pages.
    expect(firstChanged.map((page) => page.id)).toEqual(expect.arrayContaining(['product:shop', 'domain:payment', PAY]));
    const missing: string[] = [];
    for (const page of firstChanged) {
      expect(page.title.length).toBeGreaterThan(0);
      if ((await get(`/products/shop/api/k/page?id=${encodeURIComponent(page.id)}`)).status !== 200) missing.push(page.id);
    }
    expect(missing).toEqual([]);

    const unchanged = await refresh('shop');
    expect(unchanged.fill).toMatchObject({ state: 'done', changed: [] });

    // One commit, one new function in a file the sample pages stand on.
    const file = join(work, 'training', PAYMENT_SERVICE);
    writeFileSync(file, `${readFileSync(file, 'utf8')}\nexport function refundNotes(): string {\n  return "refunds are noted";\n}\n`);
    git(join(work, 'training'), 'add', '.');
    git(join(work, 'training'), '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Note the refund policy in the code');

    const after = await refresh('shop');
    expect(after.fill.state).toBe('done');
    const changed: { id: string; title: string }[] = after.fill.changed;
    const ids = changed.map((page) => page.id);
    expect(ids).toContain(recordKey('code.file', PAYMENT_SERVICE));
    expect(ids).toContain(recordKey('code.symbol', `${PAYMENT_SERVICE}#refundNotes`));
    expect(ids).not.toContain(recordKey('code.file', 'package.json'));
    // A refresh names the pages it changed, not every page of the product.
    const total = after.kinds.reduce((sum: number, kind: { count: number }) => sum + kind.count, 0);
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.length).toBeLessThan(total);
    // Every page the button lists opens at its address, with the title the list shows.
    for (const page of changed) {
      const opened = await get(`/products/shop/api/k/page?id=${encodeURIComponent(page.id)}`);
      expect(opened.status).toBe(200);
      expect(opened.body.title).toBe(page.title);
    }
  }, 900_000);
});
