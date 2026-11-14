/**
 * madarch's own wiki never blocks a start (decision 0031): a pinned product the engine cannot publish is named in the
 * daemon's log and its wiki answers that it could not be published, while every other product in the home is served.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeWikiRepository, ownGit } from './own-wiki-fixture.js';
import { SAMPLE_IDENTITY, makeProduct } from './knowledge-fixture.js';

let work = '';
let home = '';
let source = '';
let child: ReturnType<typeof spawn> | undefined;
let base = '';

const freePort = (): Promise<number> => new Promise((answer) => {
  const listener = createServer();
  listener.listen(0, '127.0.0.1', () => { const port = (listener.address() as { port: number }).port; listener.close(() => answer(port)); });
});

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'madarch-own-wiki-start-'));
  home = join(work, 'madarch-home');
  const products = join(home, 'products');
  // A valid draft beside madarch's own wiki, made by the same starter set.
  const code = join(work, 'code');
  mkdirSync(code, { recursive: true });
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: { ...process.env, ...SAMPLE_IDENTITY }, encoding: 'utf8' }).trim();
  git(code, 'init', '-q', '-b', 'main');
  writeFileSync(join(code, 'README.md'), '# Code\n');
  git(code, 'add', '-A');
  git(code, 'commit', '-qm', 'first');
  makeProduct(products, 'shop', code, 'code');
  // madarch's own wiki, from a fixture repository one revision behind the engine: a kind still names the deleted template.
  source = makeWikiRepository(join(work, 'own-source'));
  mkdirSync(join(source, 'madarch', 'kinds', 'code', 'probe'), { recursive: true });
  writeFileSync(join(source, 'madarch', 'kinds', 'code', 'probe', 'code.page-era.yaml'), 'source: graph\ntemplate: templates/item.liquid\n');
  ownGit(source, ['add', '-A']);
  ownGit(source, ['commit', '-qm', 'a kind of the page era']);
  const app = join(work, 'app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>wiki</title><div id="root"></div>');
  const port = await freePort();
  child = spawn(process.execPath, [join(import.meta.dir, '..', 'scripts', 'madarch.ts'), 'daemon-serve', '--home', products, '--port', String(port)], {
    env: { ...process.env, ...SAMPLE_IDENTITY, MADARCH_HOME: home, MADARCH_OWN_WIKI: 'on', MADARCH_OWN_WIKI_REPOSITORY: source, MADARCH_APP_DIST: app },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = `http://127.0.0.1:${port}`;
  let errors = '';
  child.stderr?.setEncoding('utf8').on('data', (part: string) => { errors += part; });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/api/products`)).ok) break; } catch { /* still starting */ }
    if (child.exitCode !== null) throw new Error(`the daemon ended before it served: ${errors}`);
    await new Promise((done) => setTimeout(done, 200));
  }

}, 120_000);

afterAll(() => {
  child?.kill('SIGKILL');
  if (work !== '') rmSync(work, { recursive: true, force: true });
});

test('an own wiki the engine cannot publish is named and answers failed, while the draft is served', async () => {
  const listed = await fetch(`${base}/api/products`);
  expect(listed.status).toBe(200);
  expect(await listed.text()).toContain('"own":true');
  const own = await fetch(`${base}/products/madarch-wiki/api/status`);
  expect(own.status).toBe(200);
  expect(await own.json()).toMatchObject({ publication: 'failed', publicationMessage: expect.stringContaining('"template" is not a field of a kind') });
  expect((await fetch(`${base}/products/shop/api/status`)).status).toBe(200);
  expect((await fetch(`${base}/products/shop/`)).status).toBe(200);
}, 60_000);
