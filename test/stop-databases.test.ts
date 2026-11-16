/**
 * Stopping madarch stops every PostgreSQL server it started for the products home (madarch-64o5.78): `madarch stop`,
 * SIGTERM of a standalone `serve`, SIGTERM of the daemon, and a SIGKILL of the daemon followed by a start. A server is
 * found by its data folder's `postmaster.pid`; none may outlive the madarch process that started it.
 */
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDaemon } from '../src/product/daemon.js';
import { createDraft } from '../src/product/draft.js';
import { manifestWithRepo } from '../src/product/manifest.js';
import { KINDS_FILE } from '../src/product/manifest/kinds.js';
import { postgresInstallFolder, postgresProgram } from '../src/adapters/postgres-builds.js';
import { SAMPLE_IDENTITY, commitProduct } from './knowledge-fixture.js';
import { gitEnv } from './git-env.js';
import { writeFolderManifest } from './catalog-folder-fixture.js';
import { clusterPaths, openCluster, fallbackSignalAllowed, postmasterOfDataDir, postmasterStill, processStartTime, stopDatabasesUnderSync, syncStopSignalPlan } from '../src/adapters/postgres-cluster.js';

const CLI = fileURLToPath(new URL('../scripts/madarch.ts', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'madarch-stop-databases-'));
const children: ReturnType<typeof Bun.spawn>[] = [];
afterAll(() => {
  for (const child of children) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  // The folder stays for the run's own sweep: this run lives in a scratch folder its preload removes when it ends
  // (test/run-scratch.ts). Removing every fixture here — thousands of files and a dozen data directories — outlasts
  // the five seconds a hook has on a loaded runner, and bun reports that as "(fail) (unnamed)" (madarch-64o5.79:
  // CI shard 5 of #311 stopped at 5083.91 ms).
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

/** A catalogue-only product: this case tests cancellation at a SQL lock, not starter-catalogue throughput. */
function catalogueShutdownFixture(): Fixture {
  const base = mkdtempSync(join(root, 'catalogue-case-'));
  const home = join(base, 'products');
  const app = join(base, 'app');
  mkdirSync(join(app, 'dist'), { recursive: true });
  writeFileSync(join(app, 'dist', 'index.html'), '<!doctype html><title>Built</title>');
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', private: true, scripts: { build: 'true' } }));
  const draft = createDraft({ home, name: 'shop', template: 'none', gitEnv: gitEnv(SAMPLE_IDENTITY) });
  if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
  mkdirSync(join(draft.folder, 'madarch'), { recursive: true });
  writeFolderManifest(draft.folder, 'kinds:\n  note: { source: graph, origin: person }\n');
  commitProduct(draft.folder, 'declare the catalogue shutdown fixture');
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
  // The kinds here are the ones the plugins finish alone: this case is about stopping the database server, never about
  // an agent, and the catalogue binds code.file's state machines to one, which a fill without an agent is refused for.
  const started = await fetch(`${base}/api/fill-selected`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ selected: ['code.directory'], agent: null, tokenCap: null, pluginsOnly: true }) });
  if (started.status !== 202) throw new Error(`the fill press answered ${String(started.status)}: ${await started.text()}`);
  await waitUntil('the store PostgreSQL server to start', () => servers(fix.home).some((server) => alive(server.pid)), 30_000);
}

async function daemon(fix: Fixture): Promise<{ base: string; pid: number }> {
  const started = await ensureDaemon({ home: fix.home, port: 0, appFolder: fix.app, env: fix.env, print: () => undefined });
  if (!started.ok) throw new Error(started.message);
  const state = JSON.parse(readFileSync(join(fix.home, '.madarch-daemon.json'), 'utf8')) as { pid: number };
  return { base: started.url, pid: state.pid };
}

function runCli(fix: Fixture, args: string[], overrides: Record<string, string> = {}): string {
  const result = Bun.spawnSync(['bun', CLI, ...args], { cwd: root, env: { ...fix.env, ...overrides }, stdout: 'pipe', stderr: 'pipe' });
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
  if (!after.includes('not running') || after.includes('databases:')) throw new Error(`status listed a database after the stop: ${after}`);
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

test('SIGTERM cancels a blocked watched catalogue before the daemon exits', async () => {
  const fix = catalogueShutdownFixture();
  const first = await daemon(fix);
  const readyDeadline = Date.now() + 30_000;
  let published = false;
  while (Date.now() < readyDeadline) {
    const response = await fetch(`${first.base}/products/${fix.name}/api/status`);
    const status = await response.json() as { publication?: string };
    if (response.ok && status.publication === 'done') { published = true; break; }
    await Bun.sleep(100);
  }
  if (!published) throw new Error(`${fix.folder}:1: the initial catalogue was not published within 30000 ms`);
  const recorded = servers(fix.home);
  if (recorded.length !== 1) throw new Error(`${fix.home}:1: expected one prepared store, found ${JSON.stringify(recorded)}`);
  const dataDir = recorded[0]!.dataDir;
  const psql = join(postgresInstallFolder(fix.env), 'bin', postgresProgram('psql'));
  const connection = ['-X', '-h', clusterPaths(join(dataDir, '..')).socketDir, '-U', 'postgres', '-d', 'madarch'];
  const blocker = Bun.spawn([psql, ...connection, '-v', 'ON_ERROR_STOP=1'], {
    env: { ...fix.env, PGAPPNAME: 'stop-test-catalogue-blocker' }, stdin: 'pipe', stdout: 'ignore', stderr: 'pipe',
  });
  children.push(blocker);
  const query = (sql: string): string => execFileSync(psql, [...connection, '-A', '-t', '-c', sql], { env: fix.env, encoding: 'utf8' }).trim();
  try {
    // startupBinding's catalogue installation lock (src/graph/manifest-publication.ts) keeps a real publication
    // in flight. The SQL blocker is not a cluster lease and must not keep a stopping daemon's server alive.
    blocker.stdin.write('BEGIN; SELECT pg_advisory_xact_lock(739141);\n');
    blocker.stdin.flush();
    await waitUntil('the test session to hold the catalogue lock', () => query("SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.application_name='stop-test-catalogue-blocker' AND l.locktype='advisory' AND l.granted") === '1');
    const kindsFile = join(fix.folder, KINDS_FILE);
    writeFileSync(kindsFile, `${readFileSync(kindsFile, 'utf8')}\n# Refresh the catalogue while its installation lock is held.\n`);
    await waitUntil('the watched catalogue to wait behind the test session', () => query("SELECT count(*) FROM pg_stat_activity a WHERE a.wait_event_type='Lock' AND EXISTS (SELECT 1 FROM pg_stat_activity blocker WHERE blocker.application_name='stop-test-catalogue-blocker' AND blocker.pid=ANY(pg_blocking_pids(a.pid)))") !== '0', 30_000);
    process.kill(first.pid, 'SIGTERM');
    await waitUntil(`the daemon ${String(first.pid)} with a blocked watched catalogue to exit`, () => !alive(first.pid));
    await waitUntil(`the recorded PostgreSQL server ${String(recorded[0]!.pid)} to exit`, () => !alive(recorded[0]!.pid));
    await noServers(fix.home);
  } finally {
    blocker.kill('SIGKILL');
    await blocker.exited;
    if (alive(first.pid)) { process.kill(first.pid, 'SIGKILL'); killMadarchOf(fix.home); }
  }
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
  writeFileSync(join(dataDir, 'PG_VERSION'), '18\n');
  const unrelated = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
  children.push(unrelated);
  writeFileSync(join(dataDir, 'postmaster.pid'), `${String(unrelated.pid)}\n${dataDir}\n`);
  stopDatabasesUnderSync(join(base, 'knowledge'));
  if (!alive(unrelated.pid)) throw new Error('the sweep killed an unrelated process whose pid was reused');
  if (!existsSync(join(dataDir, 'postmaster.pid'))) throw new Error('the sweep removed a pid file without a stopped server');
  unrelated.kill('SIGKILL');
}, 60_000);
test('a stale pid of a postgres serving a sibling data folder is not its postmaster', async () => {
  const base = mkdtempSync(join(root, 'decoy-'));
  const dataDir = join(base, 'knowledge', 'one', 'graph', 'pgdata');
  const other = `${dataDir}-old`;
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(other, { recursive: true });
  writeFileSync(join(dataDir, 'PG_VERSION'), '18\n');
  writeFileSync(join(other, 'PG_VERSION'), '18\n');
  const script = join(base, 'postgres');
  writeFileSync(script, '#!/bin/sh\nsleep 30\n');
  execFileSync('chmod', ['755', script]);
  const decoy = Bun.spawn([script, '-D', other], { stdout: 'ignore', stderr: 'ignore' });
  children.push(decoy);
  writeFileSync(join(dataDir, 'postmaster.pid'), `${String(decoy.pid)}\n`);
  expect(postmasterOfDataDir(dataDir, decoy.pid)).toBe(false);
  stopDatabasesUnderSync(join(base, 'knowledge'));
  if (!alive(decoy.pid)) throw new Error('the sweep killed a decoy postgres of a sibling data folder');
  if (!existsSync(join(dataDir, 'postmaster.pid'))) throw new Error('the sweep removed the decoy record');
  decoy.kill('SIGKILL');
}, 30_000);

test('a script named postgres with the exact data folder is not the installed postmaster', async () => {
  const base = mkdtempSync(join(root, 'decoy-exact-'));
  const dataDir = join(base, 'knowledge', 'one', 'graph', 'pgdata');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'PG_VERSION'), '18\n');
  const script = join(base, 'postgres');
  writeFileSync(script, '#!/bin/sh\nsleep 30\n');
  execFileSync('chmod', ['755', script]);
  const decoy = Bun.spawn([script, '-D', dataDir], { cwd: dataDir, stdout: 'ignore', stderr: 'ignore' });
  children.push(decoy);
  writeFileSync(join(dataDir, 'postmaster.pid'), `${String(decoy.pid)}\n${dataDir}\n${Math.floor(Date.now() / 1000)}\n5432\n${clusterPaths(join(base, 'knowledge', 'one', 'graph')).socketDir}\n\n0 0\nready\n`);
  expect(postmasterOfDataDir(dataDir, decoy.pid)).toBe(false);
  stopDatabasesUnderSync(join(base, 'knowledge'));
  expect(alive(decoy.pid)).toBe(true);
  expect(existsSync(join(dataDir, 'postmaster.pid'))).toBe(true);
  decoy.kill('SIGKILL');
  await decoy.exited;
}, 30_000);

test('a non-postgres process whose arguments name the data folder is not its postmaster', async () => {
  const base = mkdtempSync(join(root, 'decoy-args-'));
  const dataDir = join(base, 'knowledge', 'one', 'graph', 'pgdata');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'PG_VERSION'), '18\n');
  const decoy = Bun.spawn(['bun', '-e', 'setTimeout(() => {}, 30000)', dataDir], { stdout: 'ignore', stderr: 'ignore' });
  children.push(decoy);
  writeFileSync(join(dataDir, 'postmaster.pid'), `${String(decoy.pid)}\n`);
  expect(postmasterOfDataDir(dataDir, decoy.pid)).toBe(false);
  stopDatabasesUnderSync(join(base, 'knowledge'));
  if (!alive(decoy.pid)) throw new Error('the sweep killed an unrelated process whose arguments held the path');
  if (!existsSync(join(dataDir, 'postmaster.pid'))) throw new Error('the sweep removed the unrelated record');
  decoy.kill('SIGKILL');
}, 30_000);

test('the installed postgres in single-user mode is not a postmaster', async () => {
  const base = mkdtempSync(join(root, 'single-user-'));
  const cluster = await openCluster(clusterPaths(join(base, 'knowledge', 'one', 'graph')));
  await cluster.stop();
  const standalone = Bun.spawn([join(cluster.bin, 'postgres'), '--single', '-D', cluster.dataDir, 'postgres'], { cwd: cluster.dataDir, stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
  children.push(standalone);
  const pidFile = join(cluster.dataDir, 'postmaster.pid');
  try {
    writeFileSync(pidFile, `${String(standalone.pid)}\n${cluster.dataDir}\n${Math.floor(Date.now() / 1000)}\n`);
    expect(postmasterOfDataDir(cluster.dataDir, standalone.pid)).toBe(false);
    stopDatabasesUnderSync(join(base, 'knowledge'));
    expect(alive(standalone.pid)).toBe(true);
    expect(existsSync(pidFile)).toBe(true);
  } finally {
    standalone.kill('SIGKILL');
    await standalone.exited;
  }
}, 60_000);

test('a real postmaster that refuses authentication is verified and stopped without a socket answer', async () => {
  const base = mkdtempSync(join(root, 'auth-refused-'));
  const store = join(base, 'knowledge', 'one', 'graph');
  const cluster = await openCluster(clusterPaths(store));
  const pid = Number(readFileSync(join(cluster.dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]);
  try {
    writeFileSync(join(cluster.dataDir, 'pg_hba.conf'), 'local all all reject\n');
    execFileSync(join(cluster.bin, 'pg_ctl'), ['-D', cluster.dataDir, 'reload']);
    await waitUntil('the postmaster to reject authentication', () => {
      try { execFileSync(join(cluster.bin, 'psql'), ['-X', '-h', cluster.socketDir, '-U', 'postgres', '-d', 'postgres', '-c', 'SELECT 1'], { stdio: 'pipe' }); return false; }
      catch (error) { return String((error as { stderr?: Buffer }).stderr).includes('pg_hba.conf rejects connection'); }
    });
    expect(postmasterOfDataDir(cluster.dataDir, pid)).toBe(true);
    // Give this process's lease back without asking its failed socket to prove identity.
    await cluster.stop();
    stopDatabasesUnderSync(join(base, 'knowledge'));
    expect(alive(pid)).toBe(false);
    expect(existsSync(join(cluster.dataDir, 'postmaster.pid'))).toBe(false);
  } finally {
    try { execFileSync(join(cluster.bin, 'pg_ctl'), ['-D', cluster.dataDir, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' }); } catch { /* already stopped */ }
  }
}, 60_000);

test('the fallback signal is decided by the platform, never by an unverified pid', () => {
  expect(syncStopSignalPlan('win32', true)).toEqual({ signal: false });
  expect(syncStopSignalPlan('win32', false)).toEqual({ signal: false });
  expect(syncStopSignalPlan('linux', true)).toEqual({ signal: true });
  expect(syncStopSignalPlan('linux', false)).toEqual({ signal: false });
});
test('a reader\'s .psqlrc does not prevent the stop', async () => {
  const fix = fixture();
  const { base } = await daemon(fix);
  await openStore(fix, `${base}/products/${fix.name}`);
  const homeWithPsqlrc = mkdtempSync(join(root, 'psqlrc-'));
  writeFileSync(join(homeWithPsqlrc, '.psqlrc'), '\\timing on\n');
  runCli(fix, ['stop'], { HOME: homeWithPsqlrc });
  await noServers(fix.home);
}, 120_000);

test('a process whose working directory is pgdata is not taken for the postmaster', async () => {
  const base = mkdtempSync(join(root, 'busy-'));
  const dataDir = join(base, 'knowledge', 'one', 'graph', 'pgdata');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'PG_VERSION'), '18\n');
  const holder = Bun.spawn(['sleep', '30'], { cwd: dataDir, stdout: 'ignore', stderr: 'ignore' });
  children.push(holder);
  writeFileSync(join(dataDir, 'postmaster.pid'), `${String(holder.pid)}\n`);
  stopDatabasesUnderSync(join(base, 'knowledge'));
  if (!alive(holder.pid)) throw new Error('the sweep killed a process that only stood in pgdata');
  if (!existsSync(join(dataDir, 'postmaster.pid'))) throw new Error('the sweep removed the record of a process it could not verify');
  holder.kill('SIGKILL');
}, 30_000);

test('the escalation follows the verified pid and its start time, not a second socket answer', async () => {
  const base = mkdtempSync(join(root, 'still-'));
  const dataDir = join(base, 'knowledge', 'one', 'graph', 'pgdata');
  mkdirSync(dataDir, { recursive: true });
  const holder = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
  children.push(holder);
  const pidFile = join(dataDir, 'postmaster.pid');
  writeFileSync(pidFile, `${String(holder.pid)}\n`);
  const start = processStartTime(holder.pid);
  expect(postmasterStill(dataDir, holder.pid, start)).toBe(true);
  expect(fallbackSignalAllowed(dataDir, holder.pid, start)).toBe(true);
  // A different start time is a different process: no SIGTERM either.
  expect(fallbackSignalAllowed(dataDir, holder.pid, '0')).toBe(false);
  // No stable identity without the captured start time, and none on macOS or Windows.
  expect(postmasterStill(dataDir, holder.pid, undefined)).toBe(false);
  expect(fallbackSignalAllowed(dataDir, holder.pid, undefined)).toBe(false);
  expect(fallbackSignalAllowed(dataDir, holder.pid, start, 'darwin')).toBe(false);
  expect(postmasterStill(dataDir, holder.pid, start, 'darwin')).toBe(false);
  expect(postmasterStill(dataDir, holder.pid, start, 'win32')).toBe(false);
  writeFileSync(pidFile, `${String(process.pid)}\n`);
  expect(postmasterStill(dataDir, holder.pid, start)).toBe(false);
  writeFileSync(pidFile, `${String(holder.pid)}\n`);
  expect(postmasterStill(dataDir, holder.pid, start)).toBe(true);
  holder.kill('SIGKILL');
  await holder.exited;
  expect(postmasterStill(dataDir, holder.pid, start)).toBe(false);
}, 30_000);
