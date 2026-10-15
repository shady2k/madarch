#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs';
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
const firstPort = 20000 + Math.floor(Math.random() * 20000);
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
async function serveCheck(): Promise<void> {
  const start = (command: string, extra: string[], port: number) => spawn(npx, [...npxArgs, command, ...extra, '--port', String(port), '--no-open'], { cwd: install, env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', detached: process.platform !== 'win32' });
  const stop = (process_: ReturnType<typeof spawn>) => {
    if (process_.pid === undefined) return;
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(process_.pid), '/T', '/F'], { stdio: 'ignore' });
    else { try { process.kill(-process_.pid, 'SIGTERM'); } catch { /* already stopped */ } }
  };
  const child = start('new', ['--home', home], firstPort);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (part: string) => { stdout += part; });
  child.stderr.setEncoding('utf8').on('data', (part: string) => { stderr += part; });
  const waitForProduct = async (port: number): Promise<boolean> => {
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      if (child.exitCode !== null) return false;
      try {
        const answer = await fetch(`http://127.0.0.1:${port}/api/product`);
        if (answer.ok && (await answer.text()).includes('"id"')) return true;
      } catch { /* server has not started yet */ }
      await new Promise((done) => setTimeout(done, 150));
    }
    return false;
  };
  try {
    if (!await waitForProduct(firstPort)) throw new Error(`npx madarch new did not serve the graph-backed draft. stdout: ${stdout}; stderr: ${stderr}`);
  } finally { stop(child); }
  console.log(`$ npx madarch new --home ${home} --port ${firstPort} --no-open`);
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  const name = `idea-${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`;
  const product = join(home, name);
  const secondPort = firstPort + 1;
  const server = start('serve', ['--product', product], secondPort);
  let serveOut = '';
  let serveErr = '';
  server.stdout.setEncoding('utf8').on('data', (part: string) => { serveOut += part; });
  server.stderr.setEncoding('utf8').on('data', (part: string) => { serveErr += part; });
  try {
    let served = false;
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      if (server.exitCode !== null) break;
      try { const response = await fetch(`http://127.0.0.1:${secondPort}/api/product`); if (response.ok && (await response.text()).includes('"id"')) { served = true; break; } } catch { /* startup */ }
      await new Promise((done) => setTimeout(done, 150));
    }
    if (!served) throw new Error('npx madarch serve did not reopen the graph-backed product');
  } finally { stop(server); }
  console.log(`$ npx madarch serve --product ${product} --port ${secondPort} --no-open`);
  process.stdout.write(serveOut);
  process.stderr.write(serveErr);
  console.log(`walk passed: npx madarch new --home ${home}, then npx madarch serve --product ${product}; both served /api/product with its id`);
  await removeWork();
}
serveCheck().catch(async (error: unknown) => { console.error((error as Error).message); try { await removeWork(); } catch (cleanupError) { console.error(`could not remove walk scratch ${work}: ${(cleanupError as Error).message}`); } process.exit(1); });
