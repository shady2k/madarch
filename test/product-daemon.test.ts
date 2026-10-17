import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type StartedServer } from '../src/server/http.js';
import { startDaemon, stopDaemon, daemonStatus } from '../src/product/daemon.js';
import { spawnSync } from 'node:child_process';
import { createServer as netServer } from 'node:net';

let root: string | undefined;
let server: StartedServer | undefined;
let daemonHome: string | undefined;
let daemonPid: number | undefined;
let previousAppDist: string | undefined;
let previousMadarchHome: string | undefined;
function product(home: string, folder: string, id: string): void {
  const path = join(home, folder); mkdirSync(join(path, 'docs'), { recursive: true });
  writeFileSync(join(path, 'workspace.yaml'), `schemaVersion: 1\nid: ${id}\nname: ${folder}\n`);
  writeFileSync(join(path, 'docs', 'vision.md'), `# ${folder} vision\n`);
}
function appDist(rootFolder: string): string {
  const app = join(rootFolder, 'app'); mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'index.html'), '<!doctype html><script src="/assets/app.js"></script><link href="/assets/style.css"><title>wiki</title>');
  mkdirSync(join(app, 'assets')); writeFileSync(join(app, 'assets', 'app.js'), 'ok');
  return app;
}
function freePort(): Promise<number> {
  return new Promise<number>((resolvePort) => { const listener = netServer(); listener.listen(0, '127.0.0.1', () => { const address = listener.address(); const port = typeof address === 'object' && address ? address.port : 0; listener.close(() => resolvePort(port)); }); });
}
afterEach(async () => {
  await server?.stop(); server = undefined;
  if (daemonHome !== undefined) {
    stopDaemon({ home: daemonHome });
    if (daemonPid !== undefined) {
      let stillAlive = true;
      const deadline = Date.now() + 3000;
      while (stillAlive && Date.now() < deadline) {
        try { process.kill(daemonPid, 0); } catch { stillAlive = false; break; }
        await Bun.sleep(40);
      }
      if (stillAlive) throw new Error(`daemon test process ${daemonPid} is still alive after teardown for ${daemonHome}`);
    }
  }
  daemonHome = undefined; daemonPid = undefined;
  if (previousMadarchHome === undefined) delete process.env.MADARCH_HOME; else process.env.MADARCH_HOME = previousMadarchHome;
  if (previousAppDist === undefined) delete process.env.MADARCH_APP_DIST; else process.env.MADARCH_APP_DIST = previousAppDist;
  previousMadarchHome = undefined; previousAppDist = undefined;
  if (root) rmSync(root, { recursive: true, force: true }); root = undefined;
});

test('products-home mode lists products and routes each wiki under its folder', async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-daemon-home-'));
  const home = join(root, 'products'); mkdirSync(home);
  product(home, 'alpha', 'alpha-id'); product(home, 'beta', 'beta-id');
  server = await startServer({ productHome: home, appFolder: appDist(root), port: 0 });
  const index = await fetch(server.url);
  expect(index.status).toBe(200);
  const page = await index.text();
  expect(page).toContain('/products/alpha/');
  expect(page).toContain('/products/beta/');
  expect(page.indexOf('/products/alpha/')).toBeLessThan(page.indexOf('/products/beta/'));
  const first = await fetch(`${server.url}/products/alpha/api/product`);
  const second = await fetch(`${server.url}/products/beta/api/product`);
  expect((await first.json() as { id: string }).id).toBe('alpha-id');
  expect((await second.json() as { id: string }).id).toBe('beta-id');
  const appPage = await fetch(`${server.url}/products/alpha/`);
  expect(await appPage.text()).toContain('/products/alpha/assets/');
  const nestedPage = await fetch(`${server.url}/products/alpha/p/docs/vision.md`);
  expect(await nestedPage.text()).toContain('/products/alpha/assets/');
  expect((await fetch(`${server.url}/products/alpha/assets/app.js`)).status).toBe(200);
  // The wiki's own addresses stay product-relative: the app adds its mount base itself.
  const pages = await (await fetch(`${server.url}/products/alpha/api/pages`)).json() as { pages: { address: string }[] };
  expect(pages.pages[0]!.address).toBe('/p/docs/vision.md');
});

test('products-home mode refuses unknown products and paths the home does not hold', async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-daemon-unknown-'));
  const home = join(root, 'products'); mkdirSync(home);
  product(home, 'alpha', 'alpha-id');
  server = await startServer({ productHome: home, appFolder: appDist(root), port: 0 });
  const unknown = await fetch(`${server.url}/products/unknown/`);
  expect(unknown.status).toBe(404);
  expect((await unknown.json() as { message: string }).message).toContain('unknown');
  const outside = await fetch(`${server.url}/nowhere`);
  expect(outside.status).toBe(404);
  expect((await outside.json() as { message: string }).message).toContain('products home');
});

test('products-home mode serves a product created after the server started', async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-daemon-late-'));
  const home = join(root, 'products'); mkdirSync(home);
  product(home, 'alpha', 'alpha-id');
  server = await startServer({ productHome: home, appFolder: appDist(root), port: 0 });
  expect((await fetch(`${server.url}/products/late/api/product`)).status).toBe(404);
  await Bun.sleep(10);
  product(home, 'late', 'late-id');
  const late = await fetch(`${server.url}/products/late/api/product`);
  expect((await late.json() as { id: string }).id).toBe('late-id');
  const listed = await (await fetch(server.url)).text();
  expect(listed).toContain('/products/late/');
});

test('single-product foreground mode keeps wiki and API at root paths', async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-daemon-root-'));
  const home = join(root, 'products'); mkdirSync(home); product(home, 'alpha', 'alpha-id');
  server = await startServer({ productFolder: join(home, 'alpha'), appFolder: appDist(root), port: 0 });
  const answer = await fetch(`${server.url}/api/product`);
  expect((await answer.json() as { id: string }).id).toBe('alpha-id');
});

test('daemon start reuses a live daemon, replaces a stale record, and stop clears the state', async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-daemon-controls-'));
  const home = join(root, 'products'); mkdirSync(home);
  product(home, 'alpha', 'alpha-id');
  previousAppDist = process.env.MADARCH_APP_DIST;
  process.env.MADARCH_APP_DIST = appDist(root);
  const allocated = await freePort();
  previousMadarchHome = process.env.MADARCH_HOME;
  process.env.MADARCH_HOME = root;
  daemonHome = home;
  // A stale record whose pid belongs to no daemon: start replaces it without signaling anything.
  writeFileSync(join(home, '.madarch-daemon.json'), JSON.stringify({ pid: 2147483000, port: allocated, startedAt: 0, home, token: 'stale' }));
  const startResult = await startDaemon({ home, port: allocated });
  expect(startResult).toBe(0);
  daemonPid = (JSON.parse(readFileSync(join(home, '.madarch-daemon.json'), 'utf8')) as { pid: number }).pid;
  expect(daemonPid).toBeGreaterThan(0);
  // A second start reuses the running daemon instead of starting another one,
  // and reports the address it reused.
  const second = spawnSync('bun', ['scripts/madarch.ts', 'start', '--home', home, '--port', String(allocated)], { encoding: 'utf8', env: process.env });
  expect(second.status).toBe(0);
  expect(second.stdout).toContain(`already running: http://127.0.0.1:${allocated} (pid `);
  const status = spawnSync('bun', ['scripts/madarch.ts', 'status', '--home', home], { encoding: 'utf8', env: process.env });
  expect(status.status).toBe(0);
  expect(status.stdout).toContain(`running: http://127.0.0.1:${allocated}`);
  expect(status.stdout).toContain(`pid: ${daemonPid}`);
  expect(status.stdout).toMatch(/uptime: \d+s/);
  expect(status.stdout).toContain('alpha');
  expect(stopDaemon({ home })).toBe(0);
  expect(existsSync(join(home, '.madarch-daemon.json'))).toBe(false);
  expect(daemonStatus({ home })).toBe(0);
});

test('daemon start refuses a port another process holds', async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-daemon-port-'));
  const home = join(root, 'products'); mkdirSync(home);
  product(home, 'alpha', 'alpha-id');
  previousAppDist = process.env.MADARCH_APP_DIST;
  process.env.MADARCH_APP_DIST = appDist(root);
  previousMadarchHome = process.env.MADARCH_HOME;
  process.env.MADARCH_HOME = root;
  daemonHome = home;
  const holder = netServer(); holder.listen(0, '127.0.0.1');
  await new Promise<void>((resolveHeld) => holder.once('listening', resolveHeld));
  const held = (holder.address() as { port: number }).port;
  try {
    const refused = await startDaemon({ home, port: held });
    expect(refused).toBe(1);
    expect(existsSync(join(home, '.madarch-daemon.json'))).toBe(false);
  } finally { await new Promise<void>((resolveClose) => holder.close(() => resolveClose())); }
});
