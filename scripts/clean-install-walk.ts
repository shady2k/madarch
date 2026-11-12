#!/usr/bin/env bun
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { stopWindowsDaemon } from '../src/product/windows-daemon-stop.js';
import { postgresInstallFolder, postgresProgram } from '../src/adapters/postgres-builds.js';

interface Options { binary: string; os: string; arch: string }
function args(argv: string[]): Options {
  const result: Options = { binary: '', os: process.platform, arch: process.arch };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--binary' || key === '--os' || key === '--arch') {
      const value = argv[++i] ?? '';
      if (key === '--binary') result.binary = value;
      else if (key === '--os') result.os = value;
      else result.arch = value;
      continue;
    }
    throw new Error(`unknown option ${key}`);
  }
  if (!result.binary) throw new Error('give --binary <built release binary>');
  return result;
}
const options = args(process.argv.slice(2));
const platform = options.os === 'windows' ? 'win32' : options.os;
const platformKey = `${platform}-${options.arch}`;
const work = mkdtempSync(join(tmpdir(), 'madarch clean install-'));
const packages = join(work, 'packages');
const install = join(work, 'install');
const binary = resolve(options.binary);
const packageBuilder = resolve('scripts/build-npm-package.ts');
// cmd.exe does not quote an argument array when shell=true (npm/npx are .cmd launchers).
const shellParameters = (parameters: string[]): string[] => process.platform === 'win32'
  ? parameters.map((value) => `"${value}"`)
  : parameters;
const run = (command: string, parameters: string[], cwd = process.cwd(), env: Record<string, string | undefined> = process.env): number => {
  const result = spawnSync(command, shellParameters(parameters), { cwd, env, encoding: 'utf8', shell: process.platform === 'win32', timeout: 120_000 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status ?? 1;
};
const buildPlatform = run('bun', [packageBuilder, '--version', '0.0.1', '--os', platform, '--arch', options.arch, '--packages-dir', packages, '--binary', binary]);
if (buildPlatform !== 0) process.exit(buildPlatform);
const buildWrapper = run('bun', [packageBuilder, '--version', '0.0.1', '--wrapper', '--local-walk', '--local-platform', platformKey, '--packages-dir', packages]);
if (buildWrapper !== 0) process.exit(buildWrapper);
const installCode = run('npm', ['install', '--install-links', '--no-save', '--prefix', install, join(packages, 'madarch'), join(packages, `@madarch-${platformKey}`)]);
if (installCode !== 0) process.exit(installCode);
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const npxArgs = ['--yes', 'madarch'];
const home = join(work, 'products');
const env = { ...process.env, MADARCH_HOME: work, MADARCH_OWN_WIKI: 'off', GIT_AUTHOR_NAME: 'Madarch Clean Walk', GIT_AUTHOR_EMAIL: 'walk@example.invalid', GIT_COMMITTER_NAME: 'Madarch Clean Walk', GIT_COMMITTER_EMAIL: 'walk@example.invalid' };
async function removeWork(): Promise<void> {
  // Stop the home's background server after the foreground walk has ended too,
  // on both success and failure, before deleting its files.
  // Windows cannot unlink a running daemon's executable from the npm install.
  const stopped = run(npx, [...npxArgs, 'stop', '--home', home], install, env);
  if (stopped !== 0) throw new Error(`could not stop the walk's server before removing ${work} (exit ${stopped})`);
  // The product's own store server is a process of its own, and it outlives the daemon that started it: the walk's
  // scratch folder is named in its command line, so a walk stops what still names the folder before the folder goes
  // (measured: a `postgres -D <scratch>/…/pgdata` left after `madarch stop`). The Windows foreground
  // tree and its clusters have already been explicitly stopped and awaited by finish().
  if (process.platform !== 'win32') spawnSync('pkill', ['-f', work], { stdio: 'ignore' });
  await new Promise((done) => setTimeout(done, 500));
  for (let attempt = 0; attempt < 20; attempt++) {
    try { rmSync(work, { recursive: true, force: true }); return; }
    catch (error) {
      if (attempt === 19 || process.platform !== 'win32') throw error;
      await new Promise((done) => setTimeout(done, 100));
    }
  }
}
/** One port nothing on this machine holds right now: the port the walk's own server is named on, never 4180. */
async function freePort(): Promise<number> {
  return await new Promise((answer) => {
    const listener = createServer();
    listener.once('error', () => answer(0));
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      listener.close(() => answer(port === 4180 ? 0 : port));
    });
  });
}

async function serveCheck(): Promise<void> {
  /** Runs one `npx madarch` command to its end, the way a person does, and answers what it printed. */
  const runMadarch = (command: string, extra: string[]): { status: number; stdout: string; stderr: string } => {
    const finished = spawnSync(npx, shellParameters([...npxArgs, command, ...extra]), { cwd: install, env, encoding: 'utf8', timeout: 180_000, shell: process.platform === 'win32' });
    const stdout = finished.stdout ?? '';
    const stderr = finished.stderr ?? '';
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    return { status: finished.status ?? 1, stdout, stderr };
  };
  /** The product API answers the draft's id at an address the command printed. */
  const waitForProduct = async (url: string): Promise<boolean> => {
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      try {
        const answer = await fetch(`${url}api/product`);
        if (answer.ok && (await answer.text()).includes('"id"')) return true;
      } catch { /* the server has not answered yet */ }
      await new Promise((done) => setTimeout(done, 150));
    }
    return false;
  };
  /** Stops the home's server the way the command says, and proves no server is left. */
  const stopServer = (): void => {
    const stopped = runMadarch('stop', ['--home', home]);
    if (stopped.status !== 0 || !stopped.stdout.includes('stopped')) throw new Error(`npx madarch stop did not stop the server the walk started (exit ${stopped.status})`);
    const status = runMadarch('status', ['--home', home]);
    if (status.status !== 0 || status.stdout.trim() !== 'not running') throw new Error(`npx madarch status still reports a server after the walk stopped it: ${status.stdout.trim()}`);
  };
  // `new` returns at once: the products home's background server serves the
  // draft, so the walk reads the address the command printed instead of
  // waiting on a foreground that no longer exists.
  /** The daemon's log, for a failure that only the server's own words explain (the status answers a plain 500). */
  const daemonTail = (): string => {
    const files = [join(home, '.madarch-daemon.log')];
    const walkLogs = (folder: string): void => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink()) walkLogs(path);
        else if (entry.name === 'postgres.log') files.push(path);
      }
    };
    try { walkLogs(home); } catch (error) { return `${home}:1: cannot collect logs: ${String(error)}`; }
    return files.map((path) => {
      try { return `\n${path}:1:\n${readFileSync(path, 'utf8')}`; }
      catch (error) { return `\n${path}:1: cannot read log: ${String(error)}`; }
    }).join('\n');
  };
  const port = await freePort();
  let failure: Error | undefined;
  let product = '';
  const daemonTimeout = setTimeout(() => { runMadarch('stop', ['--home', home]); }, 480_000);
  try {
    if (port === 0) throw new Error('the walk could not find a free port on 127.0.0.1 to start the server on');
    console.log(`$ npx madarch new --home ${home} --port ${port} --template everything --json --no-open`);
    const created = runMadarch('new', ['--home', home, '--port', String(port), '--template', 'everything', '--json', '--no-open']);
    if (created.status !== 0) throw new Error(`npx madarch new did not create a draft and serve it (exit ${created.status})`);
    const line = created.stdout.trim().split('\n').filter((part) => part !== '').at(-1) ?? '';
    let facts: { url: string; folder: string; port: number; reused: boolean };
    try { facts = JSON.parse(line) as typeof facts; } catch { throw new Error(`npx madarch new printed no facts to read the wiki's address from: ${created.stdout}`); }
    if (facts.reused !== false || facts.port !== port) throw new Error(`npx madarch new served on ${String(facts.port)} though the walk named the free port ${port}: ${line}`);
    if (!await waitForProduct(facts.url)) throw new Error(`npx madarch new did not serve the graph-backed draft at ${facts.url}`);
    // The draft's manifest stands in its repository, and no fill has read it into the graph: the wiki reads the second
    // of its three states, `not-filled`, and nothing is written before the person presses Fill. The first answer may
    // fail while the product's store opens (a Windows runner installs the server on this first use), so the walk
    // retries and, when it still fails, prints the server's own words.
    let state: { manifest?: string; manifestFile?: string; fill?: { state?: string } } = {};
    let last = '';
    let answered = 0;
    const untilStatus = Date.now() + 60_000;
    while (Date.now() < untilStatus) {
      const status = await fetch(`${facts.url}api/status`).catch(() => undefined);
      if (status !== undefined) {
        answered = status.status;
        last = await status.text();
        if (status.ok) {
          const read = JSON.parse(last) as typeof state;
          if (read.manifest === 'not-filled') { state = read; break; }
        }
      }
      await new Promise((done) => setTimeout(done, 250));
    }
    if (state.manifest !== 'not-filled') throw new Error(`npx madarch new: the draft's status answered HTTP ${String(answered)} and read "${String(state.manifest)}"; a product whose manifest stands is not filled yet reads "not-filled": ${last}${daemonTail()}`);
    if (!String(state.manifestFile ?? '').replaceAll('\\', '/').endsWith('madarch/kinds.yaml')) throw new Error(`npx madarch new: the draft's status names no madarch/kinds.yaml: ${last}`);
    if (state.fill?.state !== 'idle') throw new Error(`npx madarch new: the draft's fill is "${String(state.fill?.state)}", and the walk pressed nothing`);
    // Store acceptance is deliberately plugin-free: Windows has no plugin sandbox. Keep that separate failure
    // out of this fixture, not out of the engine. Fill still reads and publishes the product's committed files.
    const manifest = join(facts.folder, 'madarch', 'kinds.yaml');
    writeFileSync(manifest, 'kinds:\n  code.file: { template: templates/file.liquid, source: graph }\n');
    console.log(`${manifest}:1: store acceptance fixture: code.file only, no plugins (Windows has no plugin sandbox)`);
    for (const parameters of [['add', 'madarch/kinds.yaml'], ['commit', '-m', 'Prepare plugin-free store acceptance fixture']]) {
      if (run('git', parameters, facts.folder, env) !== 0) throw new Error(`${manifest}:1: cannot commit the store acceptance fixture`);
    }
    // This is the first write and MUST open the installed store, even when the unfilled status is folder-only.
    const pressed = await fetch(`${facts.url}api/fill`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: null }),
      signal: AbortSignal.timeout(180_000),
    });
    const pressBody = await pressed.text();
    if (pressed.status !== 202) throw new Error(`${facts.folder}:1: Fill answered HTTP ${pressed.status}: ${pressBody}`);
    let completed = false;
    const fillDeadline = Date.now() + 180_000;
    while (Date.now() < fillDeadline) {
      const answer = await fetch(`${facts.url}api/status`, { signal: AbortSignal.timeout(10_000) });
      last = await answer.text();
      if (!answer.ok) throw new Error(`${facts.folder}:1: Fill status answered HTTP ${answer.status}: ${last}`);
      const filled = JSON.parse(last) as { manifest?: string; filled?: boolean; fill?: { state?: string } };
      if (filled.fill?.state === 'failed' || filled.fill?.state === 'stopped') throw new Error(`${facts.folder}:1: Fill did not finish: ${last}`);
      if (filled.fill?.state === 'done' && filled.manifest === 'ok' && filled.filled === true) { completed = true; break; }
      await new Promise((done) => setTimeout(done, 250));
    }
    if (!completed) throw new Error(`${facts.folder}:1: Fill did not finish within 180000 ms: ${last}`);
    console.log(`Fill completed: ${last}`);
    const entry = await fetch(facts.url);
    if (!entry.ok || !(await entry.text()).includes('<div id="root"')) throw new Error(`npx madarch new: ${facts.url} is not the wiki app's page (HTTP ${entry.status})`);
    product = facts.folder;
  } catch (error) {
    failure = new Error(`${(error as Error).message}${daemonTail()}`);
  } finally {
    // The server the draft's home started is stopped whether the walk went on
    // or stopped here: nothing of the walk outlives it, pass or fail.
    clearTimeout(daemonTimeout);
    try { stopServer(); } catch (error) {
      failure = failure === undefined ? error as Error : new Error(`${failure.message}; and ${(error as Error).message}`);
    }
  }
  if (failure !== undefined) throw failure;
  if (product === '') throw new Error('the walk read no product folder from the facts madarch new printed');
  // `serve` is still the foreground command: it serves until it is ended.
  const server = spawn(npx, shellParameters([...npxArgs, 'serve', '--product', product, '--port', '0', '--no-open']), { cwd: install, env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', detached: process.platform !== 'win32' });
  // Capture close before signaling: taskkill's exit is not proof that inherited handles or PostgreSQL are gone.
  const closed = new Promise<void>((done, reject) => { server.once('close', () => done()); server.once('error', reject); });
  let finishing: Promise<void> | undefined;
  const finish = (): Promise<void> => finishing ??= (async () => {
    if (server.pid !== undefined) {
      if (process.platform === 'win32') {
        // This foreground serve is the walk's child, not the daemon named in the home's state file.
        // Sweep its stores too: force-killing the npm shell alone leaves PostgreSQL holding scratch files.
        if (!stopWindowsDaemon({ pid: server.pid, home }, { pgCtl: join(postgresInstallFolder(env), 'bin', postgresProgram('pg_ctl')) })) throw new Error(`the walk's foreground serve tree did not stop (pid ${server.pid})`);
      } else { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already stopped */ } }
    }
    await closed;
  })();
  let serveOut = '';
  let serveErr = '';
  server.stdout.setEncoding('utf8').on('data', (part: string) => { serveOut += part; });
  server.stderr.setEncoding('utf8').on('data', (part: string) => { serveErr += part; });
  const serveTimeout = setTimeout(() => { void finish().catch((error: unknown) => console.error(error)); }, 90_000);
  try {
    // The address is the one the command prints once it stands.
    let address: string | undefined;
    const until = Date.now() + 60_000;
    while (Date.now() < until) {
      address = serveOut.match(/^(?:The wiki is running at|Wiki:) (\S+)/m)?.[1];
      if (address !== undefined || server.exitCode !== null) break;
      await new Promise((done) => setTimeout(done, 150));
    }
    if (address === undefined) throw new Error(`npx madarch serve printed no address for the product it serves. stdout: ${serveOut}; stderr: ${serveErr}`);
    const base = address.startsWith('http') && address.endsWith('/') ? address : `${address.replace(/\/$/, '')}/`;
    if (!await waitForProduct(base)) throw new Error(`npx madarch serve did not reopen the graph-backed product at ${base}. stdout: ${serveOut}; stderr: ${serveErr}`);
  } finally { clearTimeout(serveTimeout); await finish(); }
  console.log(`$ npx madarch serve --product ${product} --port 0 --no-open  (the foreground serve names its own free port)`);
  console.log(`walk passed (plugin-free store fixture, Fill completed): npx madarch new --home ${home} served ${product} on the port the walk named, npx madarch stop ended that server, and npx madarch serve --product ${product} served the same product again`);
  await removeWork();
}

serveCheck().catch(async (error: unknown) => { console.error(`${resolve('scripts/clean-install-walk.ts')}:1: ${(error as Error).stack ?? String(error)}`); try { await removeWork(); } catch (cleanupError) { console.error(`could not remove walk scratch ${work}: ${(cleanupError as Error).message}`); } process.exit(1); });
