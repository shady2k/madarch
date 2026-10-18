#!/usr/bin/env bun
/**
 * Assembles one release binary of the madarch command (madarch-lfhu): the
 * wiki app's built folder, the release's version and the files PGlite's own
 * build reads (the process's database, decision 0027) are laid the way the
 * compiled binary reads them (`Bun.main`'s directory), then `bun build
 * --compile` embeds and bundles the entry. The wiki app's
 * dist must be built first (`bun install --frozen-lockfile && bun run build`
 * in `wiki/app`); the release workflow and a local run both call this
 * script, so the layout the binary reads is checked here and not in the
 * workflow's steps.
 *
 *   bun scripts/build-binary.ts --version 1.2.3 [--os linux|darwin|windows] [--arch x64] [--out dist]
 *
 * --version is what `madarch version` answers and the name `madarch
 * upgrade` matches against the release tag (`v` and what the file holds).
 * --os and --arch name the artifact (`madarch-<os>-<arch>`, `.exe` on
 * Windows); the defaults are this machine's own. The script smoke-runs the
 * binary from outside the checkout, as an installed one runs: it asks its
 * `version`, then runs `new`, reads the address it printed, verifies the
 * served product API (which opens LadybugDB), lists the graph-backed draft,
 * and stops the background server `new` started before it reports done —
 * pass or fail, so no madarch process outlives the build.
 *
 * Exit 0 built, 1 when a step of the build fails, 2 when an argument or
 * the input (the wiki app's dist) cannot be used; every refusal names what
 * is wrong.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer as netServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { pgliteAssetFiles } from './pglite-assets.js';

const USAGE = 'usage: bun scripts/build-binary.ts --version <x.y.z> [--os linux|darwin|windows] [--arch x64|arm64] [--out <folder>]';

interface BuildOptions {
  version: string;
  os: string;
  arch: string;
  out: string;
}

/** The repo's own checkout root, where the built wiki app and the entry stand. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv: readonly string[]): BuildOptions | number {
  const parsed: BuildOptions = { version: '', os: '', arch: '', out: 'dist' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const takes = (name: string): string | undefined => {
      if (arg === `--${name}`) return argv[i + 1] ?? '';
      if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
      return undefined;
    };
    const version = takes('version');
    if (version !== undefined) {
      parsed.version = version;
      if (arg === '--version') i++;
      continue;
    }
    const os = takes('os');
    if (os !== undefined) {
      parsed.os = os;
      if (arg === '--os') i++;
      continue;
    }
    const arch = takes('arch');
    if (arch !== undefined) {
      parsed.arch = arch;
      if (arg === '--arch') i++;
      continue;
    }
    const out = takes('out');
    if (out !== undefined) {
      parsed.out = out;
      if (arg === '--out') i++;
      continue;
    }
    console.error(`unknown option "${arg}"`);
    console.error(USAGE);
    return 2;
  }
  if (parsed.os === '') parsed.os = process.platform === 'win32' ? 'windows' : process.platform;
  if (parsed.arch === '') parsed.arch = process.arch;
  if (parsed.os !== 'linux' && parsed.os !== 'darwin' && parsed.os !== 'windows') {
    console.error(`--os ${JSON.stringify(parsed.os)} names no released platform: the release builds linux, darwin and windows`);
    return 2;
  }
  if (parsed.os === 'windows' && parsed.arch === 'arm64') {
    console.error('Windows arm64 is not supported: this release does not include a Windows arm64 binary');
    return 2;
  }
  if (parsed.arch !== 'x64' && parsed.arch !== 'arm64') {
    console.error(`--arch ${JSON.stringify(parsed.arch)} names no released architecture: the release builds x64 and arm64`);
    return 2;
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(parsed.version)) {
    console.error(`--version ${JSON.stringify(parsed.version)} is no release version: the file the binary embeds answers read as "x.y.z" text`);
    return 2;
  }
  return parsed;
}

/** Lays the embed tree the binary reads: `wiki-app` (the dist, its stamp out) and `version` (the text). */
function stageAssets(stage: string, options: BuildOptions): { ok: true } | { ok: false; message: string } {
  const sourceDist = join(REPO_ROOT, 'wiki', 'app', 'dist');
  if (!existsSync(join(sourceDist, 'index.html'))) {
    return { ok: false, message: `the wiki app's built files are not at ${join(sourceDist, 'index.html')}: build the wiki app first ("bun install --frozen-lockfile && bun run build" in wiki/app)` };
  }
  const wikiApp = join(stage, 'wiki-app');
  cpSync(sourceDist, join(wikiApp, 'dist'), { recursive: true });
  // The dist of a working checkout carries the app-folder stamp its own
  // sources hash; inside the binary there are no sources to compare with,
  // so the stamp would make every start want a rebuild. The embedded dist
  // ships without it: a dist with no stamp record is served as it stands.
  const stamp = join(wikiApp, 'dist', '.sources-hash');
  if (existsSync(stamp)) rmSync(stamp);
  rmSync(join(wikiApp, 'dist', 'node_modules'), { recursive: true, force: true });
  writeFileSync(join(stage, 'version'), `${options.version}\n`);
  return { ok: true };
}

/** One port nothing on this machine holds right now: the free port the smoke names for the server; undefined when none can be found. */
async function freePort(): Promise<number | undefined> {
  return await new Promise((answer) => {
    const listener = netServer();
    listener.once('error', () => answer(undefined));
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      listener.close(() => answer(port > 0 ? port : undefined));
    });
  });
}

/** A folder outside the checkout to run the built binary from: the draft's own home. */
function resideElsewhere(products: string): string {
  return dirname(products);
}

/** The state file and the log the background server keeps in a products home (`src/product/daemon.ts`). */
const DAEMON_STATE = '.madarch-daemon.json';
const DAEMON_LOG = '.madarch-daemon.log';

/** The tail of a text file, for a failure that must carry what a child said; empty where it cannot be read. */
function tailOf(path: string, limit = 4000): string {
  try {
    const text = readFileSync(path, 'utf8').trim();
    return text.slice(Math.max(0, text.length - limit));
  } catch { return ''; }
}

/** Whether a process id still names a live process (a permission-denied one does). */
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** The process id the products home's server recorded, or undefined where it recorded none. */
function recordedServerPid(products: string): number | undefined {
  try {
    const state = JSON.parse(readFileSync(join(products, DAEMON_STATE), 'utf8')) as { pid?: number };
    return Number.isInteger(state.pid) ? state.pid! : undefined;
  } catch { return undefined; }
}

/** The server's own log, carried into a failure so the build log says why it did not come up. */
function daemonLog(products: string): string {
  const log = tailOf(join(products, DAEMON_LOG));
  return log === '' ? '' : `\nthe server's log at ${join(products, DAEMON_LOG)} said:\n${log}`;
}

/** What `new --json` prints of a run that started the home's server. */
interface NewFacts { folder?: string; url?: string; port?: number; reused?: boolean }

/**
 * The smoke's own run: `new --json` creates a draft in the scratch home on a
 * free port of the smoke's own and lets the home's background server serve it.
 * The address is the one the command printed — never one the smoke guessed —
 * and the product's API is asked for the draft (which opens the graph store);
 * the home is listed, and the server is stopped again whatever happened.
 * Answers the failure, whole and naming what to read, or undefined when the
 * smoke passed and no server process of it is left.
 */
async function smokeServing(outfile: string, home: string): Promise<string | undefined> {
  const products = join(home, 'products');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Madarch Build Smoke', GIT_AUTHOR_EMAIL: 'build@example.invalid',
    GIT_COMMITTER_NAME: 'Madarch Build Smoke', GIT_COMMITTER_EMAIL: 'build@example.invalid',
  };
  // A port of the smoke's own, found free on the machine: the facts the
  // command prints must name it, so a server that took another port — or
  // ignored the flag and kept 4180 — fails the smoke.
  const port = await freePort();
  if (port === undefined) return 'the smoke could not find a free port on 127.0.0.1 to start the server on';
  let failure: string | undefined;
  try {
    failure = await createsAndServes(outfile, products, port, env);
    if (failure === undefined) failure = listsTheDraft(outfile, products);
  } finally {
    const stopped = stopsTheServer(outfile, products);
    if (stopped !== undefined) failure = failure === undefined ? stopped : `${failure}\n${stopped}`;
  }
  return failure;
}

/** Runs `new` in the scratch home on the port it was given, and waits for its product's API to answer with the draft's id. */
async function createsAndServes(outfile: string, products: string, port: number, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  // Every run stands outside the checkout, the way an installed binary does:
  // a server the binary could only start with the repository beside it would
  // be no release.
  const created = spawnSync(outfile, ['new', '--home', products, '--port', String(port), '--json', '--no-open'], { encoding: 'utf8', timeout: 120_000, env, cwd: resideElsewhere(products) });
  const said = `${created.stdout ?? ''}${created.stderr ?? ''}`.trim();
  if (created.status !== 0) {
    return `the built binary could not create a draft, open the graph store and serve it (exit ${String(created.status)}): ${said}${daemonLog(products)}`;
  }
  const line = (created.stdout ?? '').trim().split('\n').filter((part) => part !== '').at(-1) ?? '';
  let facts: NewFacts;
  try { facts = JSON.parse(line) as NewFacts; } catch {
    return `the built binary created a draft but printed no facts to read its address from: ${said}`;
  }
  if (typeof facts.url !== 'string' || !facts.url.startsWith('http://127.0.0.1:') || !facts.url.endsWith('/')) {
    return `the built binary printed no wiki address for the draft it created (--json printed ${line}): ${said}`;
  }
  // The port it was given is the port the server took: the address the
  // command prints is the one the smoke reads it in.
  if (facts.port !== port) {
    return `the built binary served the draft on port ${String(facts.port)} though it was started on the free port ${port} it was given (--json printed ${line})`;
  }
  if (!facts.url.includes(`:${facts.port}/`)) {
    return `the built binary's wiki address ${facts.url} does not name the port its own facts record (${facts.port})`;
  }
  if (facts.reused !== false) {
    return `the built binary reused a server in a products home it had just made (--json printed ${line})`;
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const answer = await fetch(`${facts.url}api/product`);
      if (answer.ok && (await answer.text()).includes('"id"')) return undefined;
    } catch { /* the product's API is still coming up */ }
    await new Promise((done) => setTimeout(done, 100));
  }
  return `the built binary created a draft but no product answered at ${facts.url}api/product within 30 s: ${said}${daemonLog(products)}`;
}

/** Lists the scratch home: the draft the graph store holds is the one the list names. */
function listsTheDraft(outfile: string, products: string): string | undefined {
  const list = spawnSync(outfile, ['list', '--home', products], { encoding: 'utf8', timeout: 60_000, cwd: resideElsewhere(products) });
  if (list.status !== 0 || !(list.stdout ?? '').includes('idea-')) {
    return `the built binary could not list the graph-backed draft (exit ${String(list.status)}): ${(list.stderr ?? '').trim()}`;
  }
  return undefined;
}

/**
 * Stops the server this smoke started and proves nothing of it is left: the
 * process it recorded is gone and the home reports no server. Answers the
 * failure, or undefined when the home is quiet again.
 */
function stopsTheServer(outfile: string, products: string): string | undefined {
  const pid = recordedServerPid(products);
  const stop = spawnSync(outfile, ['stop', '--home', products], { encoding: 'utf8', timeout: 60_000, cwd: resideElsewhere(products) });
  const problems: string[] = [];
  if (stop.status !== 0) problems.push(`the smoke could not stop the server it started (madarch stop exit ${String(stop.status)}): ${(stop.stderr ?? '').trim()}`);
  const status = spawnSync(outfile, ['status', '--home', products], { encoding: 'utf8', timeout: 60_000, cwd: resideElsewhere(products) });
  if (status.status !== 0 || (status.stdout ?? '').trim() !== 'not running') {
    problems.push(`the products home still reports its server after the smoke stopped it (madarch status exit ${String(status.status)}): ${((status.stdout ?? '') + (status.stderr ?? '')).trim()}`);
  }
  if (pid !== undefined && processAlive(pid)) problems.push(`the server the smoke started (pid ${pid}) is still running after madarch stop${daemonLog(products)}`);
  return problems.length === 0 ? undefined : problems.join('\n');
}

async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);
  if (typeof options === 'number') return options;
  const stage = mkdtempSync(join(tmpdir(), 'madarch-build-binary-'));
  try {
    const staged = stageAssets(stage, options);
    if (!staged.ok) {
      console.error(staged.message);
      return 2;
    }
    let databaseFiles: string[];
    try {
      databaseFiles = pgliteAssetFiles();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 2;
    }
    const artifact = `madarch-${options.os}-${options.arch}${options.os === 'windows' ? '.exe' : ''}`;
    const outfile = resolve(options.out, artifact);
    const target = options.os === 'darwin' ? `bun-darwin-${options.arch}` : options.os === 'windows' ? `bun-windows-${options.arch}` : `bun-linux-${options.arch}`;
    const run = spawnSync('bun', [
      'build', '--compile', join(REPO_ROOT, 'scripts', 'madarch.ts'),
      '--asset', join(stage, 'wiki-app'), '--asset', join(stage, 'version'),
      ...databaseFiles.flatMap((file) => ['--asset', file]),
      '--target', target, '--outfile', outfile,
    ], { encoding: 'utf8' });
    const said = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
    if (run.status !== 0 || !existsSync(outfile) || statSync(outfile).size === 0) {
      console.error(`the binary could not be built for ${options.os}/${options.arch} (exit ${String(run.status)})${said === '' ? '' : ':\n' + said}`);
      return 1;
    }
    // Smoke: the binary answers its version; the scratch home's draft, served
    // by the background server, runs the graph through, and the smoke stops
    // that server again whatever happens below.
    const version = spawnSync(outfile, ['version'], { encoding: 'utf8', cwd: stage });
    if (version.status !== 0 || version.stdout.trim() !== `version: ${options.version}`) {
      console.error(`the built binary answered no version (exit ${String(version.status)}): ${version.stdout.trim() || version.stderr.trim()}`);
      return 1;
    }
    const smoke = await smokeServing(outfile, mkdtempSync(join(stage, 'home-')));
    if (smoke !== undefined) {
      console.error(smoke);
      return 1;
    }
    console.log(`built ${outfile} (version ${options.version}, graph-store smoke ok)`);
    return 0;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

process.exitCode = await main(process.argv.slice(2));
