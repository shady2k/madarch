#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

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
const work = mkdtempSync(join(tmpdir(), 'madarch-clean-install-'));
const packages = join(work, 'packages');
const install = join(work, 'install');
const binary = resolve(options.binary);
const packageBuilder = resolve('scripts/build-npm-package.ts');
const run = (command: string, parameters: string[], cwd = process.cwd(), env: Record<string, string | undefined> = process.env): number => {
  const result = spawnSync(command, parameters, { cwd, env, encoding: 'utf8', shell: process.platform === 'win32', timeout: 120_000 });
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
const env = { ...process.env, GIT_AUTHOR_NAME: 'Madarch Clean Walk', GIT_AUTHOR_EMAIL: 'walk@example.invalid', GIT_COMMITTER_NAME: 'Madarch Clean Walk', GIT_COMMITTER_EMAIL: 'walk@example.invalid' };
async function removeWork(): Promise<void> {
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
    const finished = spawnSync(npx, [...npxArgs, command, ...extra], { cwd: install, env, encoding: 'utf8', timeout: 180_000, shell: process.platform === 'win32' });
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
  const port = await freePort();
  let failure: Error | undefined;
  let product = '';
  try {
    if (port === 0) throw new Error('the walk could not find a free port on 127.0.0.1 to start the server on');
    console.log(`$ npx madarch new --home ${home} --port ${port} --json --no-open`);
    const created = runMadarch('new', ['--home', home, '--port', String(port), '--json', '--no-open']);
    if (created.status !== 0) throw new Error(`npx madarch new did not create a draft and serve it (exit ${created.status})`);
    const line = created.stdout.trim().split('\n').filter((part) => part !== '').at(-1) ?? '';
    let facts: { url: string; folder: string; port: number; reused: boolean };
    try { facts = JSON.parse(line) as typeof facts; } catch { throw new Error(`npx madarch new printed no facts to read the wiki's address from: ${created.stdout}`); }
    if (facts.reused !== false || facts.port !== port) throw new Error(`npx madarch new served on ${String(facts.port)} though the walk named the free port ${port}: ${line}`);
    if (!await waitForProduct(facts.url)) throw new Error(`npx madarch new did not serve the graph-backed draft at ${facts.url}`);
    product = facts.folder;
  } catch (error) {
    failure = error as Error;
  } finally {
    // The server the draft's home started is stopped whether the walk went on
    // or stopped here: nothing of the walk outlives it, pass or fail.
    try { stopServer(); } catch (error) {
      failure = failure === undefined ? error as Error : new Error(`${failure.message}; and ${(error as Error).message}`);
    }
  }
  if (failure !== undefined) throw failure;
  if (product === '') throw new Error('the walk read no product folder from the facts madarch new printed');
  // `serve` is still the foreground command: it serves until it is ended.
  const server = spawn(npx, [...npxArgs, 'serve', '--product', product, '--port', '0', '--no-open'], { cwd: install, env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', detached: process.platform !== 'win32' });
  const finish = (process_: ReturnType<typeof spawn>) => {
    if (process_.pid === undefined) return;
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(process_.pid), '/T', '/F'], { stdio: 'ignore' });
    else { try { process.kill(-process_.pid, 'SIGTERM'); } catch { /* already stopped */ } }
  };
  let serveOut = '';
  let serveErr = '';
  server.stdout.setEncoding('utf8').on('data', (part: string) => { serveOut += part; });
  server.stderr.setEncoding('utf8').on('data', (part: string) => { serveErr += part; });
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
  } finally { finish(server); }
  console.log(`$ npx madarch serve --product ${product} --port 0 --no-open  (the foreground serve names its own free port)`);
  console.log(`walk passed: npx madarch new --home ${home} served ${product} on the port the walk named, npx madarch stop ended that server, and npx madarch serve --product ${product} served the same product again`);
  await removeWork();
}

serveCheck().catch(async (error: unknown) => { console.error((error as Error).message); try { await removeWork(); } catch (cleanupError) { console.error(`could not remove walk scratch ${work}: ${(cleanupError as Error).message}`); } process.exit(1); });
