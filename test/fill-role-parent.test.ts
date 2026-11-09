/**
 * The fill role a server starts ends with the server (madarch-8bdc.12): `madarch serve` starts `madarch --role fill` as a
 * child, and the child takes the store's fills from its queue. A killed server must take it too — the walk found a fill
 * child still alive 30 s after its server was killed, keeping the store's PostgreSQL server up, because the role looked for
 * its parent only between passes and a pass can stand in a store's open for as long as the store takes.
 *
 * The cases run a real `serve` process, kill it, and hold the child and the store's PostgreSQL server to two seconds.
 */
import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateTrainingRepository, makeProduct } from './knowledge-fixture.js';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { productsHome } from '../src/product/home.js';
import { knowledgeRootOf } from '../src/product/store.js';

/** How long the child and the store's server are given after the server is killed: the rule the walk asked for. */
const GONE_WITHIN_MS = 2_000;

/** The command as a process, as a person runs it. */
const CLI = fileURLToPath(new URL('../scripts/madarch.ts', import.meta.url));

/** A free port on this machine. */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve) => {
    const listener = createServer();
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      listener.close(() => { resolve(port); });
    });
  });
}

/** A built app for the serve: the renderer's dist, as `madarch serve` reads it. */
function builtApp(base: string): string {
  const app = join(base, 'wiki-app');
  mkdirSync(join(app, 'dist', 'assets'), { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', private: true, scripts: { build: 'true' } }, null, 2));
  writeFileSync(join(app, 'dist', 'index.html'), '<!doctype html><title>built</title>');
  writeFileSync(join(app, 'dist', 'assets', 'app.js'), 'export const x = 1;');
  return app;
}

const work = mkdtempSync(join(tmpdir(), 'madarch-fill-parent-'));
const home = join(work, 'madarch-home');
const products = productsHome({ MADARCH_HOME: home });
const servers: { kill(): void }[] = [];
/** The fill roles this file's servers started, so the file ends them even when a case failed before killing its server. */
const roles = new Set<number>();

afterAll(async () => {
  // The role first, then its server: a role that a failing case (or a killed server) left behind would keep the store's
  // PostgreSQL server up, which is the very thing the cases hold (madarch-8bdc.12). A role this file did not see — one
  // started after the last look — is found by the home it was given, which lies inside this file's own folder.
  for (const pid of roles) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  for (const server of servers.splice(0)) { try { server.kill(); } catch { /* already gone */ } }
  const deadline = Date.now() + 5_000;
  for (;;) {
    const strays = processes().filter((row) => row.command.includes('--role fill') && row.command.includes(work));
    if (strays.length === 0) break;
    for (const stray of strays) { try { process.kill(stray.pid, 'SIGKILL'); } catch { /* gone */ } }
    if (Date.now() > deadline) break;
    await Bun.sleep(50);
  }
  // A store's PostgreSQL server a killed role left is stopped here and waited for, so a run that fails leaves nothing for
  // the next one (the run's own sweep does the same for the run's server): the stopping server still shows for a moment.
  for (const pid of postmasters()) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
  }
  const stoppedBy = Date.now() + 10_000;
  for (;;) {
    const still = postmasters().filter((pid) => alive(pid));
    if (still.length === 0 || Date.now() > stoppedBy) break;
    for (const pid of still) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    await Bun.sleep(50);
  }
  rmSync(work, { recursive: true, force: true });
});

/** Whether a process is still there: one this process may not signal counts as there. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface Row {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
}

/** The process table, as `ps` prints it: the child of a server is found by its parent and its command line. */
function processes(): Row[] {
  const listed = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' });
  return (listed.stdout ?? '').split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match === null ? [] : [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! }];
  });
}

/** The fill role `serve` started: the child of that process whose command line says `--role fill`. */
function fillRoleOf(server: number): Row | undefined {
  return processes().find((row) => row.ppid === server && row.command.includes('--role fill'));
}

/** The store folders under this home's knowledge root, as the server made them. */
function storeFolders(): string[] {
  const root = knowledgeRootOf(products);
  try {
    return readdirSync(root).map((name) => join(root, name)).filter((folder) => existsSync(join(folder, 'graph', 'pgdata', 'postmaster.pid')));
  } catch {
    return [];
  }
}

/** The pid of every PostgreSQL server of this home's stores, from the `postmaster.pid` each keeps. */
function postmasters(): number[] {
  return storeFolders().flatMap((store) => {
    try {
      const pid = Number(readFileSync(join(store, 'graph', 'pgdata', 'postmaster.pid'), 'utf8').split('\n')[0]?.trim());
      return Number.isInteger(pid) && pid > 1 ? [pid] : [];
    } catch {
      return [];
    }
  });
}

/** The fill role and every store's server, gone: what the rule says the kill leaves behind. */
interface Gone {
  readonly child: boolean;
  readonly postgres: boolean;
  readonly waitedMs: number;
}

async function awaitGone(child: number, within: number): Promise<Gone> {
  const started = Date.now();
  for (;;) {
    const postgres = postmasters().filter((pid) => alive(pid));
    const gone: Gone = { child: !alive(child), postgres: postgres.length === 0, waitedMs: Date.now() - started };
    if ((gone.child && gone.postgres) || gone.waitedMs >= within) return gone;
    await Bun.sleep(50);
  }
}

/** One product of this home, its repository the generated training one: a fill of it runs for about a second. */
function productOf(home_: string, name: string): string {
  const repository = generateTrainingRepository(join(work, `training-${name}`));
  mkdirSync(home_, { recursive: true });
  return makeProduct(home_, name, repository, 'walk-code');
}

/** Starts `madarch serve --product` on a free port and answers the process and its address. */
async function serve(product: string): Promise<{ pid: number; url: string; child: () => Row | undefined; kill: () => void }> {
  const app = builtApp(work);
  const port = await freePort();
  const server = Bun.spawn(['bun', CLI, 'serve', '--product', product, '--port', String(port), '--no-open'], {
    stdin: 'ignore', stdout: 'ignore', stderr: 'pipe',
    env: { ...process.env, MADARCH_HOME: home, MADARCH_APP: app, MADARCH_OWN_WIKI: 'off', MADARCH_BROWSER: '', NO_COLOR: '1' },
  });
  servers.push(server);
  const url = `http://127.0.0.1:${String(port)}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    const answered = await fetch(`${url}/api/k/status`).then((response) => response.ok, () => false);
    if (answered) break;
    if (Date.now() > deadline) throw new Error(`the server printed no answer at ${url}; it said: ${await new Response(server.stderr).text().catch(() => '')}`);
    await Bun.sleep(50);
  }
  return {
    pid: server.pid,
    url,
    child: () => {
      const child = fillRoleOf(server.pid);
      if (child !== undefined) roles.add(child.pid);
      return child;
    },
    kill: () => { try { server.kill('SIGKILL'); } catch { /* already gone */ } },
  };
}

test('a killed server takes its idle fill role and the store\'s PostgreSQL server with it within two seconds', async () => {
  const product = productOf(products, 'walk-idle');
  const running = await serve(product);
  const deadline = Date.now() + 30_000;
  let child = running.child();
  while (child === undefined && Date.now() < deadline) { await Bun.sleep(50); child = running.child(); }
  expect(child).toBeDefined();
  // The role a server starts watches the server's own home, not the default one (madarch-8bdc.12).
  expect(child!.command).toContain(`--home ${home}`);
  // The store's server stands, opened by the server (and by the role, which watches it).
  while (postmasters().length === 0 && Date.now() < deadline) await Bun.sleep(50);
  expect(postmasters().length).toBeGreaterThan(0);
  running.kill();
  const gone = await awaitGone(child!.pid, GONE_WITHIN_MS);
  console.log(`running fill role ${String(child!.pid)}: gone ${gone.child ? 'yes' : 'NO'}, store's PostgreSQL server gone ${gone.postgres ? 'yes' : 'NO'} after ${String(gone.waitedMs)} ms`);
  expect(gone.child, `the fill role ${String(child!.pid)} still ran ${String(gone.waitedMs)} ms after its server was killed`).toBe(true);
  expect(gone.postgres, `the store's PostgreSQL server still ran ${String(gone.waitedMs)} ms after the server was killed`).toBe(true);
}, 180_000);

test('a killed server takes a fill role running a fill, and the store\'s PostgreSQL server, with it within two seconds', async () => {
  const product = productOf(products, 'walk-fill');
  const running = await serve(product);
  const deadline = Date.now() + 30_000;
  let child = running.child();
  while (child === undefined && Date.now() < deadline) { await Bun.sleep(20); child = running.child(); }
  expect(child).toBeDefined();
  const pressed = await fetch(`${running.url}/api/k/fill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: null }) });
  expect(pressed.status).toBe(202);
  // The fill stands running when the server dies: the role is inside a run, not between passes.
  let state = '';
  while (state !== 'running' && Date.now() < deadline) {
    const status = await (await fetch(`${running.url}/api/k/status`)).json() as { fill?: { state?: string } };
    state = status.fill?.state ?? '';
    if (state !== 'running') await Bun.sleep(20);
  }
  expect(state).toBe('running');
  running.kill();
  const gone = await awaitGone(child!.pid, GONE_WITHIN_MS);
  console.log(`idle role ${String(child!.pid)}: gone ${gone.child ? 'yes' : 'NO'}, store's PostgreSQL server gone ${gone.postgres ? 'yes' : 'NO'} after ${String(gone.waitedMs)} ms`);
  expect(gone.child, `the fill role ${String(child!.pid)} still ran ${String(gone.waitedMs)} ms after its server was killed`).toBe(true);
  expect(gone.postgres, `the store's PostgreSQL server still ran ${String(gone.waitedMs)} ms after the server was killed`).toBe(true);
}, 180_000);
