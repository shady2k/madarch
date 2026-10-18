import { afterEach, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type StartedServer } from '../src/server/http.js';
import { startDaemon, stopDaemon, daemonStatus, daemonCommand, isDaemonCommandLine } from '../src/product/daemon.js';
import { spawnSync } from 'node:child_process';
import { createServer as netServer } from 'node:net';

let root: string | undefined;
let server: StartedServer | undefined;
let daemonHome: string | undefined;
let daemonPid: number | undefined;
let previousAppDist: string | undefined;
let previousApp: string | undefined;
let previousMadarchHome: string | undefined;
function product(home: string, folder: string, id: string): void {
  const path = join(home, folder); mkdirSync(join(path, 'docs'), { recursive: true });
  writeFileSync(join(path, 'workspace.yaml'), `schemaVersion: 1\nid: ${id}\nname: ${folder}\n`);
  writeFileSync(join(path, 'docs', 'vision.md'), `# ${folder} vision\n`);
}
function appDist(rootFolder: string): string {
  const app = join(rootFolder, 'app'); mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'index.html'), '<!doctype html><script src="/assets/app.js"></script><link href="/assets/style.css" rel="stylesheet"><title>wiki</title>');
  mkdirSync(join(app, 'assets'));
  writeFileSync(join(app, 'assets', 'app.js'), 'ok');
  writeFileSync(join(app, 'assets', 'style.css'), 'body { font-family: var(--font-sans); }');
  return app;
}
/**
 * The app folder the daemon's own start reads (`MADARCH_APP`), holding the
 * built dist: with it a test's `madarch start` serves what is there and builds
 * nothing. Without it the start looks for the checkout's own `wiki/app`, where
 * a run that never built the app would build it — slow enough to cross a
 * test's own deadline on a machine that has no dist yet, which is how this
 * seam was found (CI run 39137149685, shard 2).
 */
function appFolderAround(dist: string, rootFolder: string): string {
  const folder = join(rootFolder, 'app-folder'); mkdirSync(folder, { recursive: true });
  cpSync(dist, join(folder, 'dist'), { recursive: true });
  writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: 'app', private: true, scripts: { build: 'true' } }, null, 2));
  return folder;
}
/** The product declares the problem its home card names: a registry whose overview reads one vision section. */
function productWithDescription(home: string, folder: string, id: string, problem: string): void {
  product(home, folder, id);
  mkdirSync(join(home, folder, 'docs'), { recursive: true }); writeFileSync(join(home, folder, 'docs', 'kinds.yaml'), `contract: 1\nstages:\n  - id: idea\n    name: Idea\nkinds: []\noverview:\n  problem: { document: docs/vision.md, section: Problem }\n`);
  writeFileSync(join(home, folder, 'docs', 'vision.md'), `# ${folder} vision\n\n## Problem\n\n${problem}\n`);
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
  if (previousApp === undefined) delete process.env.MADARCH_APP; else process.env.MADARCH_APP = previousApp;
  previousMadarchHome = undefined; previousAppDist = undefined; previousApp = undefined;
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

test("the home answers in the app's own look with product cards and a language switch", async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-daemon-home-look-'));
  const home = join(root, 'products'); mkdirSync(home);
  product(home, 'alpha', 'alpha-id');
  productWithDescription(home, 'beta', 'beta-id', 'Notes from a small trip: the route, the budget and the photos.');
  server = await startServer({ productHome: home, appFolder: appDist(root), port: 0 });
  const index = await fetch(server.url);
  expect(index.status).toBe(200);
  const page = await index.text();
  // The page is the app's own look: its built stylesheet (tokens and fonts) is
  // linked the way its shell is, and the shell's brand, toolbar, reading area
  // and language switch stand on it.
  expect(page).toContain('<link rel="stylesheet" crossorigin href="/assets/style.css">');
  expect(page).toContain('data-testid="nav-brand"');
  expect(page).toContain('>madarch</strong>');
  expect(page).toContain('data-testid="language-toggle"');
  expect(page).toContain('madarch-wiki-language');
  // The product cards: one per product, code-point ordered, with the one-line
  // description the product declares and none where it declares none.
  expect(page.split('data-testid="product-card"').length - 1).toBe(2);
  expect(page.indexOf('>alpha</strong>')).toBeGreaterThan(-1);
  expect(page.indexOf('>beta</strong>')).toBeGreaterThan(page.indexOf('>alpha</strong>'));
  expect(page).toContain('Notes from a small trip: the route, the budget and the photos.');
  // The builds' own assets answer the home with: the stylesheet by its plain path.
  const css = await fetch(`${server.url}/assets/style.css`);
  expect(css.status).toBe(200);
  expect(await css.text()).toContain('font-family');
  const missing = await fetch(`${server.url}/assets/nothing.js`);
  expect(missing.status).toBe(404);
  expect((await missing.json() as { message: string }).message).toContain('no built app file answers');
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
  previousApp = process.env.MADARCH_APP;
  process.env.MADARCH_APP_DIST = appDist(root);
  process.env.MADARCH_APP = appFolderAround(process.env.MADARCH_APP_DIST, root);
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

test('daemon start treats --port 0 as a free port, records the real one, and status reports it', async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-daemon-port0-'));
  const home = join(root, 'products'); mkdirSync(home);
  product(home, 'alpha', 'alpha-id');
  previousAppDist = process.env.MADARCH_APP_DIST;
  previousApp = process.env.MADARCH_APP;
  process.env.MADARCH_APP_DIST = appDist(root);
  process.env.MADARCH_APP = appFolderAround(process.env.MADARCH_APP_DIST, root);
  previousMadarchHome = process.env.MADARCH_HOME;
  process.env.MADARCH_HOME = root;
  daemonHome = home;
  expect(await startDaemon({ home, port: 0 })).toBe(0);
  const state = JSON.parse(readFileSync(join(home, '.madarch-daemon.json'), 'utf8')) as { pid: number; port: number };
  // The requirement's words: on port 4180 unless another free port is
  // explicitly named. The state names a port the machine actually serves,
  // never 0, and it answers the same address the status prints.
  expect(state.port).toBeGreaterThan(0);
  expect(state.pid).toBeGreaterThan(0);
  daemonPid = state.pid;
  const status = spawnSync('bun', ['scripts/madarch.ts', 'status', '--home', home], { encoding: 'utf8', env: process.env });
  expect(status.status).toBe(0);
  expect(status.stdout).toContain(`running: http://127.0.0.1:${state.port}`);
  const answer = await fetch(`http://127.0.0.1:${state.port}/products/alpha/api/product`);
  expect((await answer.json() as { id: string }).id).toBe('alpha-id');
  expect(stopDaemon({ home })).toBe(0);
  expect(existsSync(join(home, '.madarch-daemon.json'))).toBe(false);
});

test('daemon stop on a home with nothing to stop reports not running and never creates the home', async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-daemon-stop-absent-'));
  const absent = join(root, 'absent');
  expect(stopDaemon({ home: absent })).toBe(0);
  expect(existsSync(absent)).toBe(false);
  writeFileSync(join(root, 'plain'), 'a file, not a folder\n');
  expect(stopDaemon({ home: join(root, 'plain') })).toBe(0);
});

test('a record whose pid is a live process that is not this daemon is never stopped', async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-daemon-foreign-'));
  const home = join(root, 'products'); mkdirSync(home);
  product(home, 'alpha', 'alpha-id');
  // A live process whose command line merely holds the daemon's own word: it
  // is not the child this home started, so the record is stale and the
  // process is never signalled.
  const script = join(root, 'foreign.ts');
  writeFileSync(script, 'await Bun.sleep(60_000);\n');
  const foreign = Bun.spawn([process.execPath, script, 'daemon-serve'], { stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    writeFileSync(join(home, '.madarch-daemon.json'), JSON.stringify({ pid: foreign.pid, port: 1, startedAt: 0, home, token: 'not-ours' }));
    expect(daemonStatus({ home })).toBe(0);
    expect(stopDaemon({ home })).toBe(0);
    expect(existsSync(join(home, '.madarch-daemon.json'))).toBe(false);
    let alive = true;
    try { process.kill(foreign.pid, 0); } catch { alive = false; }
    expect(alive).toBeTrue();
  } finally { foreign.kill(); }
});

test("the daemon's own command line is recognised on every platform's shape", () => {
  const state = { home: '/tmp/products', port: 43137 };
  // What the command starts: bun with the checkout's entry, and the compiled
  // binary started again, on Windows and on Unix alike.
  expect(isDaemonCommandLine('bun /opt/madarch/scripts/madarch.ts daemon-serve --home /tmp/products --port 43137', state)).toBeTrue();
  expect(isDaemonCommandLine('/tmp/dist/madarch-linux-x64 daemon-serve --home /tmp/products --port 43137', state)).toBeTrue();
  expect(isDaemonCommandLine('"C:\\Program Files\\madarch\\madarch.exe" daemon-serve --home /tmp/products --port 43137', state)).toBeTrue();
  // Everything else is another program: no daemon word, another home, another
  // port, or a plain command of the same binary.
  expect(isDaemonCommandLine('sleep daemon-serve 60', state)).toBeFalse();
  expect(isDaemonCommandLine('bun /opt/madarch/scripts/madarch.ts daemon-serve --home /tmp/other --port 43137', state)).toBeFalse();
  expect(isDaemonCommandLine('bun /opt/madarch/scripts/madarch.ts daemon-serve --home /tmp/products --port 4180', state)).toBeFalse();
  expect(isDaemonCommandLine('/tmp/dist/madarch-linux-x64 status --home /tmp/products', state)).toBeFalse();
});

test("the daemon child is the checkout's script, and the binary itself from a bundle", () => {
  const words = ['daemon-serve', '--home', '/tmp/products', '--port', '43137'];
  // A released binary's own facts: it carries embedded files (the wiki app and
  // the version), its module URL names the bundle, and the script path it
  // derives answers no file. Any one of the three starts the program itself.
  const fromLinuxBundle = daemonCommand('/tmp/products', 43137, { moduleUrl: 'file:///$bunfs/root/madarch-linux-x64', scriptPath: '/scripts/madarch.ts', scriptExists: () => false });
  expect(fromLinuxBundle.command).toBe(process.execPath);
  expect(fromLinuxBundle.args).toEqual(words);
  const fromWindowsBundle = daemonCommand('/tmp/products', 43137, { moduleUrl: 'file:///B:/~BUN/root/madarch-windows-x64.exe', scriptPath: 'B:\\scripts\\madarch.ts', scriptExists: () => false });
  expect(fromWindowsBundle.command).toBe(process.execPath);
  expect(fromWindowsBundle.args).toEqual(words);
  // A Windows machine that happens to hold that path on its B: drive is still
  // a bundle: the embedded files and the marker decide it, file or no file.
  const windowsWithTheFile = daemonCommand('/tmp/products', 43137, { moduleUrl: 'file:///B:/~BUN/root/madarch-windows-x64.exe', scriptPath: 'B:\\scripts\\madarch.ts', scriptExists: () => true, embeddedFiles: [] });
  expect(windowsWithTheFile.command).toBe(process.execPath);
  // And the run CI failed on: a test process under a shard, whose module URL is
  // its own real file, which embeds nothing, and whose script is there. Bun.main
  // is not consulted: in a test run it names the test file, and in the shard it
  // named something else again.
  const fromTestRun = daemonCommand('/tmp/products', 43137, { moduleUrl: 'file:///opt/madarch/test/thing.test.ts', scriptPath: '/opt/madarch/scripts/madarch.ts', scriptExists: () => true, embeddedFiles: [] });
  expect(fromTestRun.command).toBe('bun');
  expect(fromTestRun.args).toEqual(['/opt/madarch/scripts/madarch.ts', ...words]);
  // Run from a checkout, the script is there and bun is what runs it.
  const fromCheckout = daemonCommand('/tmp/products', 43137, { moduleUrl: 'file:///opt/madarch/src/product/daemon.ts', scriptPath: '/opt/madarch/scripts/madarch.ts', scriptExists: () => true, embeddedFiles: [] });
  expect(fromCheckout.command).toBe('bun');
  expect(fromCheckout.args).toEqual(['/opt/madarch/scripts/madarch.ts', ...words]);
});

test('daemon start refuses a port another process holds', async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-daemon-port-'));
  const home = join(root, 'products'); mkdirSync(home);
  product(home, 'alpha', 'alpha-id');
  previousAppDist = process.env.MADARCH_APP_DIST;
  previousApp = process.env.MADARCH_APP;
  process.env.MADARCH_APP_DIST = appDist(root);
  process.env.MADARCH_APP = appFolderAround(process.env.MADARCH_APP_DIST, root);
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
