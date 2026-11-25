#!/usr/bin/env bun
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { prepareStoreAcceptanceFixture } from './clean-install-fixture.js';
import { postgresInstallFolder, postgresProgram } from '../src/adapters/postgres-builds.js';
import { stopChildWithin } from '../src/product/child-stop.js';

// The very first statement: a walk that never gets further says so, and CI shows this line or none at all.
process.stderr.write('walk: start\n');

/**
 * Ends a child this script started, within a bound — its own copy, so a walk loads nothing of madarch's runtime: a
 * module graph of the product (a PostgreSQL client, a library call) has no place in a script that only drives commands.
 */
async function stopChildWithin(child: { readonly pid: number | undefined; kill(signal?: NodeJS.Signals | number): unknown; readonly exited: Promise<unknown> }, options: { readonly what: string; readonly graceMs?: number; readonly killWaitMs?: number }): Promise<'ended' | 'killed' | 'stuck'> {
  const graceMs = options.graceMs ?? 30_000;
  const killWaitMs = options.killWaitMs ?? 10_000;
  const within = async (work: Promise<unknown>, ms: number): Promise<boolean> =>
    await Promise.race([work.then(() => true, () => true), new Promise<boolean>((answer) => { const timer = setTimeout(() => answer(false), ms); (timer as unknown as { unref?: () => void }).unref?.(); })]);
  try { child.kill('SIGTERM'); } catch { /* gone between the check and the signal */ }
  if (await within(child.exited, graceMs)) return 'ended';
  process.stderr.write(`walk: ${options.what} (pid ${String(child.pid)}) did not end within ${String(graceMs)} ms of SIGTERM, so it is killed\n`);
  try { child.kill('SIGKILL'); } catch { /* gone */ }
  if (await within(child.exited, killWaitMs)) return 'killed';
  process.stderr.write(`walk: ${options.what} (pid ${String(child.pid)}) did not end within ${String(killWaitMs)} ms of SIGKILL: something of it still holds the walk's output open\n`);
  return 'stuck';
}

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
/**
 * Every step's own bound: a walk may fail, but a step of it never waits without end. A step that outlives its bound has
 * its whole process tree ended and printed, so a stuck command names itself instead of holding the job for an hour.
 */
const STEP_TIMEOUT_MS = 240_000;

/** The processes of one pid's tree, for a step that ran past its bound: pid, parent and command line. */
function treeOf(pid: number): string {
  const rows: string[] = [];
  const tree = new Set<number>([pid]);
  if (process.platform === 'win32') {
    const query = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress';
    const answer = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8', timeout: 30_000 });
    try {
      const value = JSON.parse(answer.stdout) as { ProcessId: number; ParentProcessId: number; Name: string; CommandLine?: string } | { ProcessId: number; ParentProcessId: number; Name: string; CommandLine?: string }[];
      const all = Array.isArray(value) ? value : [value];
      for (let grew = true; grew;) { grew = false; for (const row of all) if (tree.has(row.ParentProcessId) && !tree.has(row.ProcessId)) { tree.add(row.ProcessId); grew = true; } }
      for (const row of all) if (tree.has(row.ProcessId)) rows.push(`${String(row.ProcessId)} ${String(row.ParentProcessId)} ${row.Name} ${(row.CommandLine ?? '').slice(0, 140)}`);
    } catch { rows.push(`${String(pid)} (the tree could not be read)`); }
    return rows.join('\n');
  }
  try {
    const all: { pid: number; ppid: number; cmd: string }[] = [];
    for (const id of readdirSync('/proc')) {
      if (!/^\d+$/.test(id)) continue;
      try {
        const stat = readFileSync(`/proc/${id}/stat`, 'utf8');
        const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        all.push({ pid: Number(id), ppid: Number(after[1]), cmd: readFileSync(`/proc/${id}/cmdline`, 'utf8').split('\0').join(' ').slice(0, 140) });
      } catch { /* gone */ }
    }
    for (let grew = true; grew;) { grew = false; for (const row of all) if (tree.has(row.ppid) && !tree.has(row.pid)) { tree.add(row.pid); grew = true; } }
    for (const row of all) if (tree.has(row.pid)) rows.push(`${String(row.pid)} ${String(row.ppid)} ${row.cmd}`);
  } catch { rows.push(`${String(pid)} (the tree could not be read)`); }
  return rows.join('\n');
}

/** Ends a step's whole tree: its process group on POSIX, `taskkill /T` on Windows. */
function endTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') { spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { encoding: 'utf8', timeout: 10_000 }); return; }
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

/** Runs one step: says so first on stderr, streams what it prints, and ends its tree when it outlives its bound. */
async function runStep(label: string, command: string, parameters: string[], cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env, timeoutMs: number = STEP_TIMEOUT_MS): Promise<{ status: number; stdout: string; stderr: string }> {
  // stderr, so CI shows where a walk is the moment it is there: stdout of a step is its own, and it is asked for later.
  process.stderr.write(`walk: ${label}\n`);
  const child = spawn(command, shellParameters(parameters), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', shell: process.platform === 'win32' });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8').on('data', (part: string) => { stdout += part; process.stdout.write(part); });
  child.stderr?.setEncoding('utf8').on('data', (part: string) => { stderr += part; process.stderr.write(part); });
  const ended = new Promise<number | null>((answer) => { child.once('error', () => answer(null)); child.once('close', (code) => answer(code)); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((answer) => { timer = setTimeout(() => answer('timeout'), timeoutMs); });
  const outcome = await Promise.race([ended, timedOut]);
  if (timer !== undefined) clearTimeout(timer);
  if (outcome === 'timeout') {
    process.stderr.write(`walk: ${label} did not end within ${String(timeoutMs)} ms; ending its process tree:\n${treeOf(child.pid ?? 0)}\n`);
    endTree(child.pid);
    return { status: 1, stdout, stderr };
  }
  return { status: outcome ?? 1, stdout, stderr };
}
const buildPlatform = (await runStep('build the platform package', 'bun', [packageBuilder, '--version', '0.0.1', '--os', platform, '--arch', options.arch, '--packages-dir', packages, '--binary', binary])).status;
if (buildPlatform !== 0) process.exit(buildPlatform);
const buildWrapper = (await runStep('build the wrapper package', 'bun', [packageBuilder, '--version', '0.0.1', '--wrapper', '--local-walk', '--local-platform', platformKey, '--packages-dir', packages])).status;
if (buildWrapper !== 0) process.exit(buildWrapper);
const installCode = (await runStep('install the packages', 'npm', ['install', '--install-links', '--no-save', '--prefix', install, join(packages, 'madarch'), join(packages, `@madarch-${platformKey}`)])).status;
if (installCode !== 0) process.exit(installCode);
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const npxArgs = ['--yes', 'madarch'];
const home = join(work, 'products');
const env = { ...process.env, MADARCH_HOME: work, MADARCH_OWN_WIKI: 'off', GIT_AUTHOR_NAME: 'Madarch Clean Walk', GIT_AUTHOR_EMAIL: 'walk@example.invalid', GIT_COMMITTER_NAME: 'Madarch Clean Walk', GIT_COMMITTER_EMAIL: 'walk@example.invalid' };
async function removeWork(): Promise<void> {
  // Stop the home's background server after the foreground walk has ended too,
  // on both success and failure, before deleting its files.
  // Windows cannot unlink a running daemon's executable from the npm install.
  const stopped = (await runStep('npx madarch stop (before removing the walk\'s folder)', npx, [...npxArgs, 'stop', '--home', home], install, env)).status;
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

/** Live Windows ownership proof: verifies `endWindowsProcesses` refuses a mismatched creation time and kills an exact match. */
async function verifyWindowsProcessOwnership(): Promise<void> {
  const { listWindowsProcesses, endWindowsProcesses } = await import('../src/adapters/windows-processes.js');
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  const exited = new Promise<void>((done) => { sleeper.once('close', () => done()); sleeper.once('error', () => done()); });
  const isRunning = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
  };
  try {
    const pid = sleeper.pid;
    if (pid === undefined) throw new Error('Windows ownership check could not spawn a sleeper process');
    const listed = listWindowsProcesses();
    if (listed === undefined) throw new Error('Windows ownership check could not list Windows processes');
    const row = listed.find((one) => one.pid === pid);
    if (row === undefined || row.created === undefined) throw new Error(`Windows ownership check could not read created timestamp for sleeper pid ${pid}`);
    const wrong = endWindowsProcesses([{ pid, created: row.created - 1_000_000 }]);
    if (wrong === undefined) throw new Error('Windows ownership check: endWindowsProcesses failed on mismatched created timestamp');
    if (wrong.held.includes(pid)) throw new Error(`Windows ownership check: pid ${pid} was held despite mismatched created timestamp`);
    if (!isRunning(pid)) throw new Error(`Windows ownership check: pid ${pid} stopped after mismatched created timestamp`);
    const right = endWindowsProcesses([{ pid, created: row.created }]);
    if (right === undefined) throw new Error('Windows ownership check: endWindowsProcesses failed on matching created timestamp');
    if (!right.held.includes(pid)) throw new Error(`Windows ownership check: pid ${pid} was not held on matching created timestamp`);
    if (right.left.includes(pid)) throw new Error(`Windows ownership check: pid ${pid} remained in left after matching termination`);
    await Promise.race([exited, new Promise((done) => setTimeout(done, 1_000))]);
    if (isRunning(pid)) throw new Error(`Windows ownership check: pid ${pid} is still running after matching termination`);
  } finally {
    try { sleeper.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

async function serveCheck(): Promise<void> {
  /** Runs one `npx madarch` command to its end, the way a person does, and answers what it printed. */
  const runMadarch = async (command: string, extra: string[]): Promise<{ status: number; stdout: string; stderr: string }> =>
    await runStep(`npx madarch ${command}`, npx, [...npxArgs, command, ...extra], install, env, 190_000);
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
  const stopServer = async (): Promise<void> => {
    const stopped = await runMadarch('stop', ['--home', home]);
    // The stop names on stderr why it failed: the walk's own message carries those words, since the CI summary shows
    // the error and not the commands' output.
    if (stopped.status !== 0 || !stopped.stdout.includes('stopped')) throw new Error(`npx madarch stop did not stop the server the walk started (exit ${stopped.status})${stopped.stderr.trim() === '' ? '' : `: ${stopped.stderr.trim()}`}`);
    const status = await runMadarch('status', ['--home', home]);
    if (status.status !== 0 || status.stdout.trim() !== 'not running') throw new Error(`npx madarch status still reports a server after the walk stopped it: ${status.stdout.trim()}`);
  };
  /**
   * The preparation page's isolation question (madarch-64o5.86), answered the way its person answers it: a machine that
   * cannot confine a plugin says so in one sentence, and the person presses «run them without isolation» on that page.
   * The walk reads the page's own answer (`/api/settings`) and presses the same button (that answer's POST), because a
   * walk without a terminal answers a question as a person does, never through a variable or a hidden flag. Windows has
   * no plugin sandbox at all: the probe answers "this system has no plugin sandbox" there, the page asks the same
   * question a Linux machine without delegation gets, and the same press answers it. A machine that confines plugins
   * asks nothing, and nothing is written.
   */
  const answerIsolation = async (url: string): Promise<void> => {
    const settingsFile = join(work, 'settings.json');
    // The wiki publishes a draft's catalogue for about fifteen seconds after its server starts (measured 2026-11-15 on
    // Linux arm64: 14 s from init to the page's first answer), and until then that page's own answer says the catalogue
    // is being published. The walk waits for the page, as its person does, and names the bound when it never comes.
    const until = Date.now() + 120_000;
    const settingsAnswer = async (): Promise<string> => {
      for (;;) {
        const answer = await fetch(`${url}api/settings`, { signal: AbortSignal.timeout(30_000) });
        const text = await answer.text();
        if (answer.ok) return text;
        let publishing = false;
        try { publishing = (JSON.parse(text) as { publication?: unknown }).publication === 'pending'; } catch { publishing = false; }
        if (!publishing) throw new Error(`${settingsFile}:1: the preparation page's settings could not be read (HTTP ${answer.status}): ${text}`);
        if (Date.now() > until) throw new Error(`${settingsFile}:1: the preparation page's settings did not answer within 120000 ms while the catalogue was being published: ${text}`);
        await new Promise((done) => setTimeout(done, 250));
      }
    };
    const body = await settingsAnswer();
    let held: { pluginsUnconfined?: unknown; pluginIsolation?: { capable?: unknown; reason?: unknown } };
    try { held = JSON.parse(body) as typeof held; } catch (error) { throw new Error(`${settingsFile}:1: the settings answer is not JSON: ${(error as Error).message}: ${body}`); }
    const isolation = held.pluginIsolation;
    if (typeof isolation?.capable !== 'boolean' || typeof isolation.reason !== 'string' || isolation.reason === '') throw new Error(`${settingsFile}:1: the settings answer names no pluginIsolation with a capable flag and a reason: ${body}`);
    if (isolation.capable) { console.log(`The preparation page asks nothing about isolation: ${isolation.reason}`); return; }
    // A person's "no" stands: the walk reports it and never presses the other answer over it.
    if (held.pluginsUnconfined === false) throw new Error(`${settingsFile}:1: the preparation page's isolation question is answered "no" here, and Fill cannot run: ${isolation.reason}`);
    if (held.pluginsUnconfined === true) { console.log(`The preparation page's isolation question stands answered: ${isolation.reason}`); return; }
    // The page's own press — «run them without isolation» — for the machine that offers none.
    const pressed = await fetch(`${url}api/settings`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pluginsUnconfined: true }),
      signal: AbortSignal.timeout(30_000),
    });
    const pressedBody = await pressed.text();
    if (!pressed.ok) throw new Error(`${settingsFile}:1: the preparation page's isolation answer was not saved (HTTP ${pressed.status}): ${pressedBody}`);
    let answered: { pluginsUnconfined?: unknown };
    try { answered = JSON.parse(pressedBody) as typeof answered; } catch (error) { throw new Error(`${settingsFile}:1: the saved settings answer is not JSON: ${(error as Error).message}: ${pressedBody}`); }
    if (answered.pluginsUnconfined !== true) throw new Error(`${settingsFile}:1: the preparation page's isolation answer was saved as ${JSON.stringify(answered.pluginsUnconfined)}, not as pluginsUnconfined true: ${pressedBody}`);
    console.log(`The preparation page asked why plugins cannot be isolated here ("${isolation.reason}"); the walk answered it on that page, as its person does: plugins run without isolation`);
  };
  // `init` returns at once: the products home's background server serves the
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
  const checkForegroundServe = async (product: string, manifest: 'not-filled' | 'ok'): Promise<void> => {
    const server = spawn(npx, shellParameters([...npxArgs, 'serve', '--product', product, '--port', '0', '--no-open']), { cwd: install, env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', detached: process.platform !== 'win32' });
    // Capture close before signaling: taskkill's exit is not proof that inherited handles or PostgreSQL are gone.
    const closed = new Promise<void>((done, reject) => { server.once('close', () => done()); server.once('error', reject); });
    let finishing: Promise<void> | undefined;
    const finish = (): Promise<void> => finishing ??= (async () => {
      if (server.pid !== undefined) {
        if (process.platform === 'win32') {
          // This foreground serve is the walk's child, not the daemon named in the home's state file.
          // Sweep its stores too: force-killing the npm shell alone leaves PostgreSQL holding scratch files.
          // Loaded here, never at the top: the walk reads no madarch runtime it does not use, and a Linux run
          // (which installs no packages) never reaches a module that would ask for a tracing dependency.
          const { stopWindowsDaemon } = await import('../src/product/windows-daemon-stop.js');
          const ownsRoot = server.exitCode === null && server.signalCode === null
            ? (line: string) => line.includes(product)
            : 'stores-only' as const;
          if (!stopWindowsDaemon({ pid: server.pid, home }, ownsRoot, { pgCtl: join(postgresInstallFolder(env), 'bin', postgresProgram('pg_ctl')) })) throw new Error(`the walk's foreground serve tree did not stop (pid ${server.pid})`);
        } else {
          // The serve and everything it started are one process group. A role that will not leave, or one whose
          // descendant still holds the serve's output open, must not become a wait with no end: the walk names it.
          const tree = server.pid;
          const outcome = await stopChildWithin(
            { pid: tree, kill: (signal) => { try { process.kill(-tree, signal as NodeJS.Signals); } catch { /* already stopped */ } }, exited: closed },
            { what: `the walk's foreground serve tree (pid ${String(tree)})`, graceMs: 30_000, killWaitMs: 10_000 },
          );
          if (outcome === 'stuck') throw new Error(`the walk's foreground serve tree (pid ${String(tree)}) did not end: something of it still holds the walk's output open`);
        }
      }
      await closed;
    })();
    let serveOut = '';
    let serveErr = '';
    server.stdout.setEncoding('utf8').on('data', (part: string) => { serveOut += part; });
    server.stderr.setEncoding('utf8').on('data', (part: string) => { serveErr += part; });
    // The store's own bounds are initdb's 90 seconds and a readiness wait of 60 seconds after the server is launched;
    // this loop waits past both, so serve's refusal — with the reason the last connection gave and the store's log — is
    // what the job reports, not this script's "printed no address". The loop ends at once when serve exits, and its own
    // words are then the ones reported (madarch-64o5.81).
    const serveTimeout = setTimeout(() => { void finish().catch((error: unknown) => console.error(error)); }, 230_000);
    try {
      // The address is the one the command prints once it stands.
      let address: string | undefined;
      const until = Date.now() + 200_000;
      while (Date.now() < until) {
        address = serveOut.match(/^(?:The wiki is running at|Wiki:) (\S+)/m)?.[1];
        if (address !== undefined || server.exitCode !== null) break;
        await new Promise((done) => setTimeout(done, 150));
      }
      if (address === undefined) throw new Error(`npx madarch serve printed no address for the product it serves. stdout: ${serveOut}; stderr: ${serveErr}`);
      const base = address.startsWith('http') && address.endsWith('/') ? address : `${address.replace(/\/$/, '')}/`;
      if (!await waitForProduct(base)) throw new Error(`npx madarch serve did not reopen the graph-backed product at ${base}. stdout: ${serveOut}; stderr: ${serveErr}`);
      const response = await fetch(`${base}api/status`);
      const state = await response.json() as { manifest?: string };
      if (!response.ok || state.manifest !== manifest) throw new Error(`${product}/madarch/catalog.yaml:1: foreground serve read ${String(state.manifest)} instead of ${manifest} (HTTP ${response.status})`);
    } finally { clearTimeout(serveTimeout); await finish(); }
  };
  const port = await freePort();
  let failure: Error | undefined;
  let product = '';
  const daemonTimeout = setTimeout(() => { void runMadarch('stop', ['--home', home]); }, 480_000);
  try {
    if (port === 0) throw new Error('the walk could not find a free port on 127.0.0.1 to start the server on');
    console.log(`$ npx madarch init --home ${home} --port ${port} --template everything --json --no-open`);
    const created = await runMadarch('init', ['--home', home, '--port', String(port), '--template', 'everything', '--json', '--no-open']);
    if (created.status !== 0) throw new Error(`npx madarch init did not create a draft and serve it (exit ${created.status})`);
    const line = created.stdout.trim().split('\n').filter((part) => part !== '').at(-1) ?? '';
    let facts: { url: string; folder: string; port: number; reused: boolean };
    try { facts = JSON.parse(line) as typeof facts; } catch { throw new Error(`npx madarch init printed no facts to read the wiki's address from: ${created.stdout}`); }
    if (facts.reused !== false || facts.port !== port) throw new Error(`npx madarch init served on ${String(facts.port)} though the walk named the free port ${port}: ${line}`);
    if (!await waitForProduct(facts.url)) throw new Error(`npx madarch init did not serve the graph-backed draft at ${facts.url}`);
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
    if (state.manifest !== 'not-filled') throw new Error(`npx madarch init: the draft's status answered HTTP ${String(answered)} and read "${String(state.manifest)}"; a product whose manifest stands is not filled yet reads "not-filled": ${last}${daemonTail()}`);
    if (!String(state.manifestFile ?? '').replaceAll('\\', '/').endsWith('madarch/catalog.yaml')) throw new Error(`npx madarch init: the draft's status names no madarch/catalog.yaml: ${last}`);
    if (state.fill?.state !== 'idle') throw new Error(`npx madarch init: the draft's fill is "${String(state.fill?.state)}", and the walk pressed nothing`);
    // Foreground cleanup on Windows stops the home's stores, so no daemon may still hold one here.
    // `not-filled` is not store readiness: startup publication may still be in initdb. Stop must end preparation too.
    await stopServer();
    if (process.platform === 'win32') await verifyWindowsProcessOwnership();
    await checkForegroundServe(facts.folder, 'not-filled');
    console.log(`Fresh unfilled product reopened by npx madarch serve: ${facts.folder}`);
    const restarted = await runMadarch('start', ['--home', home, '--port', String(port)]);
    if (restarted.status !== 0 || !await waitForProduct(facts.url)) throw new Error(`${facts.folder}:1: could not restart the daemon after the fresh foreground check (exit ${restarted.status})${daemonTail()}`);
    // Store acceptance is deliberately plugin-free: Windows has no plugin sandbox. Keep that separate failure
    // out of this fixture, not out of the engine. Without a producer, Fill publishes no file opinions.
    const manifest = join(facts.folder, 'madarch', 'catalog.yaml');
    prepareStoreAcceptanceFixture(facts.folder);
    console.log(`${manifest}:1: store acceptance fixture: code.file only, no plugins (Windows has no plugin sandbox)`);
    for (const parameters of [['add', 'madarch'], ['commit', '-m', 'Prepare plugin-free store acceptance fixture']]) {
      if ((await runStep(`git ${parameters.join(' ')}`, 'git', parameters, facts.folder, env)).status !== 0) throw new Error(`${manifest}:1: cannot commit the store acceptance fixture`);
    }
    // The preparation page's isolation question, answered on that page just before the person presses Fill there.
    await answerIsolation(facts.url);
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
    if (!entry.ok || !(await entry.text()).includes('<div id="root"')) throw new Error(`npx madarch init: ${facts.url} is not the wiki app's page (HTTP ${entry.status})`);
    product = facts.folder;
  } catch (error) {
    failure = new Error(`${(error as Error).message}${daemonTail()}`);
  } finally {
    // The server the draft's home started is stopped whether the walk went on
    // or stopped here: nothing of the walk outlives it, pass or fail.
    clearTimeout(daemonTimeout);
    try { await stopServer(); } catch (error) {
      failure = failure === undefined ? error as Error : new Error(`${failure.message}; and ${(error as Error).message}`);
    }
  }
  if (failure !== undefined) throw failure;
  if (product === '') throw new Error('the walk read no product folder from the facts madarch init printed');
  await checkForegroundServe(product, 'ok');
  console.log(`$ npx madarch serve --product ${product} --port 0 --no-open  (the foreground serve names its own free port)`);
  console.log(`walk passed (plugin-free store fixture, Fill completed): npx madarch init --home ${home} served ${product} on the port the walk named, npx madarch stop ended that server, and npx madarch serve --product ${product} served the same product again`);
  await removeWork();
}

serveCheck().catch(async (error: unknown) => { console.error(`${resolve('scripts/clean-install-walk.ts')}:1: ${(error as Error).stack ?? String(error)}`); try { await removeWork(); } catch (cleanupError) { console.error(`could not remove walk scratch ${work}: ${(cleanupError as Error).message}`); } process.exit(1); });
