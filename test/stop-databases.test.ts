/**
 * Stopping madarch stops every PostgreSQL server it started for the products home (madarch-64o5.78): `madarch stop`,
 * SIGTERM of a standalone `serve`, SIGTERM of the daemon, and a SIGKILL of the daemon followed by a start. A server is
 * found by its data folder's `postmaster.pid`; none may outlive the madarch process that started it.
 */
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDaemon } from '../src/product/daemon.js';
import { createDraft } from '../src/product/draft.js';
import { manifestWithRepo } from '../src/product/manifest.js';
import { SAMPLE_IDENTITY, commitProduct } from './knowledge-fixture.js';
import { gitEnv } from './git-env.js';
import { stopDatabasesUnderSync } from '../src/adapters/postgres-cluster.js';

const CLI = fileURLToPath(new URL('../scripts/madarch.ts', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'madarch-stop-databases-'));
const children: ReturnType<typeof Bun.spawn>[] = [];
afterAll(() => {
  for (const child of children) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  readonly home: string;
  readonly folder: string;
  readonly name: string;
  readonly app: string;
  readonly env: NodeJS.ProcessEnv;
}

function fixture(): Fixture {
  const base = mkdtempSync(join(root, 'case-'));
  const home = join(base, 'products');
  const app = join(base, 'app');
  const code = join(base, 'code');
  mkdirSync(join(app, 'dist'), { recursive: true });
  writeFileSync(join(app, 'dist', 'index.html'), '<!doctype html><title>Built</title>');
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', private: true, scripts: { build: 'true' } }));
  mkdirSync(join(code, 'src'), { recursive: true });
  writeFileSync(join(code, 'README.md'), '# Code\n');
  // A tree large enough that the fill is still running when the stop arrives, as the owner's own fills are.
  for (let index = 0; index < 3_000; index += 1) {
    const folder = join(code, 'src', `d${String(index % 30)}`);
    if (!existsSync(folder)) mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `f${String(index)}.ts`), `export const value${String(index)} = ${String(index)};\n`);
  }
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: code, env: { ...process.env, ...gitEnv(SAMPLE_IDENTITY) } });
  execFileSync('git', ['add', '.'], { cwd: code, env: { ...process.env, ...gitEnv(SAMPLE_IDENTITY) } });
  execFileSync('git', ['commit', '--quiet', '-m', 'code'], { cwd: code, env: { ...process.env, ...gitEnv(SAMPLE_IDENTITY) } });
  const draft = createDraft({ home, name: 'shop', gitEnv: gitEnv(SAMPLE_IDENTITY) });
  if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
  writeFileSync(join(draft.folder, 'workspace.yaml'), manifestWithRepo(readFileSync(join(draft.folder, 'workspace.yaml'), 'utf8'), { name: 'code', linked: true }));
  mkdirSync(join(draft.folder, 'repos'), { recursive: true });
  execFileSync('ln', ['-s', code, join(draft.folder, 'repos', 'code')]);
  commitProduct(draft.folder, 'link code');
  const env: NodeJS.ProcessEnv = { ...process.env, MADARCH_HOME: base, MADARCH_OWN_WIKI: 'off', MADARCH_APP: app };
  return { home, folder: draft.folder, name: 'shop', app, env };
}

/** Every PostgreSQL server this home's data folders record, by data folder and pid. */
function servers(home: string): { dataDir: string; pid: number }[] {
  const knowledge = join(home, '.madarch', 'knowledge');
  if (!existsSync(knowledge)) return [];
  const found: { dataDir: string; pid: number }[] = [];
  for (const id of readdirSync(knowledge)) {
    const dataDir = join(knowledge, id, 'graph', 'pgdata');
    try {
      const pid = Number(readFileSync(join(dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]?.trim());
      if (Number.isInteger(pid) && pid > 1) found.push({ dataDir, pid });
    } catch { /* no server recorded */ }
  }
  return found;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}


/** Kills every madarch process of one home: the crash a killed daemon leaves, children included. */
function killMadarchOf(home: string): void {
  if (process.platform === 'win32') return;
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const command = readFileSync(`/proc/${name}/cmdline`, 'utf8');
      if (command.includes('scripts/madarch.ts') && command.includes(home)) process.kill(Number(name), 'SIGKILL');
    } catch { /* gone or not ours */ }
  }
}

async function waitUntil(what: string, check: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (check()) return; await Bun.sleep(100); }
  throw new Error(`waited ${String(ms)} ms for ${what}`);
}

async function noServers(home: string): Promise<void> {
  await waitUntil(`every PostgreSQL server of ${home} to stop: ${JSON.stringify(servers(home))}`, () => servers(home).every((server) => !alive(server.pid)));
  const left = servers(home).filter((server) => alive(server.pid));
  if (left.length > 0) throw new Error(`PostgreSQL servers are still running for ${home}: ${JSON.stringify(left)}`);
}

async function openStore(fix: Fixture, base: string): Promise<void> {
  const started = await fetch(`${base}/api/fill-selected`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ selected: ['code.repository', 'code.directory', 'code.file'], agent: null, tokenCap: null }) });
  if (started.status !== 202) throw new Error(`the fill press answered ${String(started.status)}: ${await started.text()}`);
  await waitUntil('the store PostgreSQL server to start', () => servers(fix.home).some((server) => alive(server.pid)), 30_000);
}

async function daemon(fix: Fixture): Promise<{ base: string; pid: number }> {
  const started = await ensureDaemon({ home: fix.home, port: 0, appFolder: fix.app, env: fix.env, print: () => undefined });
  if (!started.ok) throw new Error(started.message);
  const state = JSON.parse(readFileSync(join(fix.home, '.madarch-daemon.json'), 'utf8')) as { pid: number };
  return { base: started.url, pid: state.pid };
}

function runCli(fix: Fixture, args: string[]): string {
  const result = Bun.spawnSync(['bun', CLI, ...args], { cwd: root, env: fix.env, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`madarch ${args.join(' ')} exited ${String(result.exitCode)}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

test('madarch stop stops the product PostgreSQL server', async () => {
  const fix = fixture();
  const { base } = await daemon(fix);
  await openStore(fix, `${base}/products/${fix.name}`);
  const listing = runCli(fix, ['status']);
  if (!listing.includes('databases: 1') || !listing.includes('pgdata')) throw new Error(`status did not list the one database: ${listing}`);
  runCli(fix, ['stop']);
  await noServers(fix.home);
  const after = runCli(fix, ['status']);
  if (!after.includes('databases: 0')) throw new Error(`status listed a database after the stop: ${after}`);
}, 120_000);

test('SIGTERM of a standalone serve stops the product PostgreSQL server', async () => {
  const fix = fixture();
  const serve = Bun.spawn(['bun', CLI, 'serve', '--product', fix.folder, '--port', '0', '--no-open'], { cwd: root, env: fix.env, stdout: 'pipe', stderr: 'pipe' });
  children.push(serve);
  let base = '';
  const start = Date.now();
  let stdout = '';
  const reader = (serve.stdout as ReadableStream).getReader();
  void (async () => { for (;;) { const { done, value } = await reader.read(); if (done) break; stdout += new TextDecoder().decode(value); } })();
  while (Date.now() - start < 20_000) {
    base = stdout.split('\n').find((line) => line.startsWith('The wiki is running at ') || line.startsWith('Wiki: '))?.match(/(https?:\/\/\S+)/)?.[1] ?? '';
    if (base !== '') break;
    await Bun.sleep(100);
  }
  if (base === '') throw new Error(`serve printed no address: ${stdout}`);
  await openStore(fix, base);
  serve.kill('SIGTERM');
  await serve.exited;
  await noServers(fix.home);
}, 120_000);

test('SIGTERM of the daemon stops the product PostgreSQL server', async () => {
  const fix = fixture();
  const { base, pid } = await daemon(fix);
  await openStore(fix, `${base}/products/${fix.name}`);
  process.kill(pid, 'SIGTERM');
  await noServers(fix.home);
}, 120_000);

test('SIGKILL of the daemon leaves no server after the next start, and opens the store cleanly', async () => {
  const fix = fixture();
  const { base, pid } = await daemon(fix);
  await openStore(fix, `${base}/products/${fix.name}`);
  process.kill(pid, 'SIGKILL');
  // The crash the owner saw: every madarch process of the home gone, its PostgreSQL servers left behind.
  killMadarchOf(fix.home);
  await waitUntil('the daemon process to end', () => !alive(pid), 15_000);
  const before = servers(fix.home).filter((server) => alive(server.pid));
  const next = await daemon(fix);
  await waitUntil(`the server a killed daemon left to stop: ${JSON.stringify(before)}`, () => before.every((server) => !alive(server.pid)), 20_000);
  const status = await fetch(`${next.base}/products/${fix.name}/api/status`);
  expect(status.status).toBe(200);
  const after = servers(fix.home);
  expect(after.filter((server) => alive(server.pid)).length).toBeLessThanOrEqual(1);
}, 120_000);
test('madarch stop leaves a standalone serve\'s database alone', async () => {
  const fix = fixture();
  const serve = Bun.spawn(['bun', CLI, 'serve', '--product', fix.folder, '--port', '0', '--no-open'], { cwd: root, env: fix.env, stdout: 'pipe', stderr: 'pipe' });
  children.push(serve);
  let base = '';
  let stdout = '';
  const reader = (serve.stdout as ReadableStream).getReader();
  void (async () => { for (;;) { const { done, value } = await reader.read(); if (done) break; stdout += new TextDecoder().decode(value); } })();
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    base = stdout.split('\n').find((line) => line.startsWith('The wiki is running at ') || line.startsWith('Wiki: '))?.match(/(https?:\/\/\S+)/)?.[1] ?? '';
    if (base !== '') break;
    await Bun.sleep(100);
  }
  if (base === '') throw new Error(`serve printed no address: ${stdout}`);
  await openStore(fix, base);
  const before = servers(fix.home).filter((server) => alive(server.pid));
  if (before.length === 0) throw new Error('serve opened no database');
  runCli(fix, ['stop']);
  await Bun.sleep(500);
  const after = servers(fix.home).filter((server) => alive(server.pid));
  if (after.length !== before.length) throw new Error(`madarch stop took the standalone serve's database: ${JSON.stringify(after)}`);
  const status = await fetch(`${base}/api/status`);
  if (status.status !== 200) throw new Error(`the standalone serve stopped answering: ${String(status.status)}`);
  serve.kill('SIGTERM');
  await serve.exited;
  await noServers(fix.home);
}, 120_000);

test('the synchronous sweep signals no pid it cannot verify is the data folder\'s postmaster', async () => {
  const base = mkdtempSync(join(root, 'orphan-'));
  const dataDir = join(base, 'knowledge', 'one', 'graph', 'pgdata');
  mkdirSync(dataDir, { recursive: true });
  const unrelated = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
  children.push(unrelated);
  writeFileSync(join(dataDir, 'postmaster.pid'), `${String(unrelated.pid)}\n${dataDir}\n`);
  stopDatabasesUnderSync(join(base, 'knowledge'));
  if (!alive(unrelated.pid)) throw new Error('the sweep killed an unrelated process whose pid was reused');
  if (!existsSync(join(dataDir, 'postmaster.pid'))) throw new Error('the sweep removed a pid file without a stopped server');
  unrelated.kill('SIGKILL');
}, 60_000);
