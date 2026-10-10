import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'bun:test';
import { homeOfCommand, noStrayDrafts, sealedHome } from './scratch-home.js';

/**
 * The `madarch` command's serve step (docs/changes/draft-product/
 * capabilities/product-wiki.md, requirements `serve`, `app` and `result`):
 * `new` creates the draft and serves its wiki in one command; `serve`
 * serves the product of the given or the current folder; the app's built
 * files are built once on first use, through an injectable builder, and
 * the address is printed before the machine's opener — an injectable
 * opener — is asked to open it. A run that cannot serve exits 2 naming
 * what is wrong: an unknown argument, a folder that holds no manifest,
 * a port already in use, an app build that cannot be used. 1 is the exit
 * of a step that failed.
 *
 * Every test runs the command as a child process the way a person runs
 * it. A serving run ends only when the test ends it, so none hangs. The
 * opener the tests give never launches a browser; the only network is a
 * localhost fetch to the command's own server. The app folder and the
 * build step are injected through the command's own seams (MADARCH_APP
 * and MADARCH_APP_BUILD), so no test runs bun's real build or a registry.
 */
const CLI = fileURLToPath(new URL('../scripts/madarch.ts', import.meta.url));

/** The set's example product folder, vendored with the pinned program. */
const SET_MADE_FIXTURE = fileURLToPath(new URL('../vendor/shady2k-skills/0.94.0/fixtures/product/good', import.meta.url));

const SEALED_GIT = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Product CLI',
  GIT_AUTHOR_EMAIL: 'product-cli@example.com',
  GIT_COMMITTER_NAME: 'Product CLI',
  GIT_COMMITTER_EMAIL: 'product-cli@example.com',
};
const scratchFolders: string[] = [];
const runningChildren: { kill(): void }[] = [];

function scratchFolder(prefix = 'madarch-serve-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchFolders.push(dir);
  return dir;
}

function stopAll(): void {
  for (const proc of runningChildren.splice(0)) try { proc.kill(); } catch { /* already gone */ }
}

afterEach(() => {
  stopAll();
  for (const dir of scratchFolders.splice(0)) rmSync(dir, { recursive: true, force: true });
  const strays = noStrayDrafts();
  if (strays.leftAlone.length) throw new Error(`the tests left what they cannot own in the real products home, untouched: ${strays.leftAlone.join(', ')}`);
  if (strays.removed.length) throw new Error(`the tests left stray drafts in the real products home (removed): ${strays.removed.join(', ')}`);
});
process.on('exit', stopAll);

/** Runs the command to its own end: for the exits that terminate by themselves. */
function runCommand(args: string[], overrides: Record<string, string> = {}, cwd?: string):
  { status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env, ...SEALED_GIT, ...sealedHome(overrides), ...overrides };
  if (args[0] === 'new' || args[0] === 'list') homeOfCommand(args, env);
  const run = spawnSync('bun', [CLI, ...args], {
    encoding: 'utf8',
    env,
    ...(cwd === undefined ? {} : { cwd }),
  });
  return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
}

/** One live child of a serve run: its stdout is watched; the test decides when it ends. */
interface LiveServe {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly address: string | undefined;
  finish(): Promise<{ status: number | null; stdout: string; stderr: string }>;
}
/** The address line's URL, once the run printed it. */
function addressOf(stdout: string): string | undefined {
  return stdout.split("\n").find((line) => line.startsWith('address: '))?.slice('address: '.length);
}

/** Starts the command live, watching its stdout, until the test closes it through `finish`. */
function serveLive(args: string[], overrides: Record<string, string>, cwd?: string): LiveServe & { raw: Bun.Subprocess } {
  const env = { ...process.env, ...SEALED_GIT, ...sealedHome(overrides), ...overrides };
  if (args[0] === 'new') homeOfCommand(args, env);
  const proc = Bun.spawn(['bun', CLI, ...args], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env,
    ...(cwd === undefined ? {} : { cwd }),
  });
  runningChildren.push(proc);
  // stdout is read incrementally: a serving child never ends its stream while
  // it runs, so the address has to be seen chunk by chunk as it arrives.
  let stdoutText = '';
  const whenStdout = (async () => {
    const reader = (proc.stdout as ReadableStream).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stdoutText += new TextDecoder().decode(value);
    }
    return stdoutText;
  })();
  let stderrText = '';
  const whenStderr = (async () => {
    const reader = (proc.stderr as ReadableStream).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stderrText += new TextDecoder().decode(value);
    }
    return stderrText;
  })();
  return {
    get stdout() { return stdoutText; },
    get stderr() { return stderrText; },
    get exitCode() { return proc.exitCode; },
    get address() { return addressOf(stdoutText); },
    finish: async () => {
      // The command serves until it is stopped and does not watch its
      // stdin, so a serving child is stopped the way a reader stops a
      // server: killed, then waited for. The exit is the signal's code
      // (143 for SIGTERM).
      proc.kill();
      const [status, stdout, stderr] = await Promise.all([proc.exited, whenStdout, whenStderr]);
      return { status, stdout, stderr };
    },
  } as LiveServe & { raw: Bun.Subprocess };
}

/** Waits until the run has printed its address and its server answers one path over HTTP. */
async function whenServing(serve: LiveServe & { raw: Bun.Subprocess }, urlPath = '/api/product'): Promise<string> {
  const start = Date.now();
  for (;;) {
    if (serve.address !== undefined) {
      try {
        const answer = await fetch(`${serve.address}${urlPath}`);
        if (answer.ok) return serve.address;
      } catch { /* the server is not listening yet */ }
    }
    if (Date.now() - start > 20_000) {
      const parts = [`the command never served; stdout was: ${serve.stdout}`, `stderr was: ${serve.stderr}`];
      if (serve.raw.exitCode !== null) parts.push(`exit status was: ${serve.raw.exitCode}`);
      throw new Error(parts.join('\n'));
    }
    await Bun.sleep(100);
  }
}

/** A product folder to serve: its manifest plus docs. */
function product(base: string, name = 'demo'): string {
  const folder = join(base, 'demo');
  mkdirSync(join(folder, 'docs'), { recursive: true });
  writeFileSync(join(folder, 'workspace.yaml'), "schemaVersion: 1\nid: demo-id\nname: " + name + "\n");
  writeFileSync(join(folder, 'docs', 'vision.md'), '# Vision\n\nWhat it is for.\n');
  return folder;
}

/** An app folder the command builds in when MADARCH_APP points it there: its build is a no-op script. */
function freshApp(base: string): string {
  const app = join(base, 'wiki-app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', private: true, scripts: { build: 'true' } }, null, 2));
  writeFileSync(join(app, 'bun.lock'), 'lock');
  return app;
}

/** An app whose dist is already there: no build may run while it stands. */
function builtApp(base: string): string {
  const app = freshApp(base);
  mkdirSync(join(app, 'dist', 'assets'), { recursive: true });
  writeFileSync(join(app, 'dist', 'index.html'), '<!doctype html><title>built</title>');
  writeFileSync(join(app, 'dist', 'assets', 'app.js'), 'export const x = 1;');
  return app;
}

/**
 * The builder the tests inject at MADARCH_APP_BUILD: a script acting as
 * the build, recording that it was called, failing or laying no dist as
 * told, and otherwise laying the tiny dist the server then serves.
 */
type BuilderMode = 'ok' | 'install-fails' | 'build-fails' | 'empty';

function injectableBuilder(app: string, mode: BuilderMode): { command: string; callsFile: string } {
  const folder = scratchFolder('madarch-serve-builder-');
  const callsFile = join(folder, 'calls.log');
  const lines: string[] = ["#!/bin/sh", "echo called >> " + JSON.stringify(callsFile)];
  const failure: Record<BuilderMode, string> = {
    ok: '',
    'install-fails': 'echo "no registry here" >&2\nexit 7',
    'build-fails': 'echo "the build failed" >&2\nexit 9',
    empty: 'echo "the build finished without dist" >&2\nexit 0',
  };
  if (failure[mode] !== '') lines.push(failure[mode]);
  lines.push(
    'mkdir -p ' + JSON.stringify(join(app, 'dist', 'assets')),
    "echo '<!doctype html><title>built</title>' > " + JSON.stringify(join(app, 'dist', 'index.html')),
    "echo 'export const x = 1;' > " + JSON.stringify(join(app, 'dist', 'assets', 'app.js')),
    'exit 0',
    '',
  );
  const command = join(folder, 'build');
  writeFileSync(command, lines.join('\n'));
  chmodSync(command, 0o755);
  return { command, callsFile };
}

/** The opener the tests inject at MADARCH_BROWSER: it records every URL it is given. */
function injectableOpener(mode: 'ok' | 'fail'): string {
  const folder = scratchFolder('madarch-serve-opener-');
  const openFile = join(folder, 'open.log');
  const lines = ["#!/bin/sh", "echo $1 >> " + JSON.stringify(openFile), mode === 'ok' ? 'exit 0' : 'echo "the stub opener failed" >&2\nexit 3', ''];
  const command = join(folder, 'march-open');
  writeFileSync(command, lines.join('\n'));
  chmodSync(command, 0o755);
  return command;
}

describe('madarch serve: an existing product served', () => {
  test('a folder without a manifest is refused with exit 2, naming the folder and the manifest', () => {
    const base = scratchFolder();
    const run = runCommand(['serve'], { MADARCH_HOME: base }, base);
    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain(base);
    expect(run.stderr).toContain('no workspace.yaml');
  });

  test('serve --product names the folder it was given when it holds no manifest', () => {
    const base = scratchFolder();
    const folder = join(base, 'not-a-product');
    mkdirSync(folder, { recursive: true });
    const run = runCommand(['serve', '--product', folder], { MADARCH_HOME: base }, base);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(folder);
  });

  test('an unknown option to serve is refused, naming what is accepted', () => {
    const run = runCommand(['serve', '--nope'], {});
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('--nope');
    expect(run.stderr).toContain('--product');
  });

  test('--port without a value, and a --port that is no port number, are refused', () => {
    const noValue = runCommand(['serve', '--port'], {});
    expect(noValue.status).toBe(2);
    expect(noValue.stderr).toContain('--port');
    const notANumber = runCommand(['serve', '--port', 'not-a-port'], {});
    expect(notANumber.status).toBe(2);
    expect(notANumber.stderr).toContain('--port');
    expect(notANumber.stderr).toContain('not-a-port');
  });

  test('--product without a value is refused', () => {
    const run = runCommand(['serve', '--product'], {});
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('--product');
  });

  test('the app build failing stops the command with exit 2, printing what the builder said and serving nothing', () => {
    const base = scratchFolder();
    const built = freshApp(base);
    const builder = injectableBuilder(built, 'build-fails');
    const run = runCommand(['serve', '--product', product(base), '--port', '0', '--no-open'],
      { MADARCH_HOME: base, MADARCH_APP: built, MADARCH_APP_BUILD: builder.command }, base);
    expect(run.status).toBe(2);
    expect(run.stdout).toContain(`building the wiki app in ${built}`);
    expect(run.stderr).toContain('the build failed');
    expect(run.stderr).toContain(builder.command);
  });

  test('the install step failing behaves the same: exit 2 with what the builder said', () => {
    const base = scratchFolder();
    const built = freshApp(base);
    const builder = injectableBuilder(built, 'install-fails');
    const run = runCommand(['serve', '--product', product(base), '--port', '0', '--no-open'],
      { MADARCH_HOME: base, MADARCH_APP: built, MADARCH_APP_BUILD: builder.command }, base);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('no registry here');
  });

  test('a build that succeeds with no dist refuses: the app cannot be served then', () => {
    const base = scratchFolder();
    const built = freshApp(base);
    const builder = injectableBuilder(built, 'empty');
    const run = runCommand(['serve', '--product', product(base), '--port', '0', '--no-open'],
      { MADARCH_HOME: base, MADARCH_APP: built, MADARCH_APP_BUILD: builder.command }, base);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('dist');
    expect(run.stderr).toContain('index.html');
  });

  test('a served product answers its home and one page over HTTP; the build runs once and the opener is not reached with --no-open', async () => {
    const base = scratchFolder();
    const built = freshApp(base);
    const builder = injectableBuilder(built, 'ok');
    const opener = injectableOpener('ok');
    const folder = product(base, 'named');
    const serve = serveLive(['serve', '--product', folder, '--port', '0', '--no-open'],
      { MADARCH_HOME: base, MADARCH_APP: built, MADARCH_APP_BUILD: builder.command, MADARCH_BROWSER: opener });
    const address = await whenServing(serve, '/api/product');
    const body = (await (await fetch(`${address}/api/product`)).json()) as { id: string; name: string };
    expect(body).toEqual({ id: 'demo-id', name: 'named' });
    const vision = (await (await fetch(`${address}/api/page?path=docs/vision.md`)).json()) as { title: string; markdown: string };
    expect(vision.title).toBe('Vision');
    expect(vision.markdown).toBe('# Vision\n\nWhat it is for.\n');
    // The app's files come from the built app, and the page route answers through index.html.
    const home = await (await fetch(`${address}/`)).text();
    expect(home).toContain('<!doctype html>');
    const asset = await (await fetch(`${address}/assets/app.js`)).text();
    expect(asset).toContain('export const x = 1;');
    const pageRoute = await (await fetch(`${address}/p/docs/vision.md`)).text();
    expect(pageRoute).toContain('<!doctype html>');
    await Bun.sleep(500);
    // --no-open never reaches the opener.
    expect(existsSync(opener.replace('march-open', 'open.log'))).toBe(false);
    await serve.finish();
    // The build ran exactly once for this serving.
    const calls = await Bun.file(builder.callsFile).text();
    expect(calls.split('\n').filter((line) => line !== '')).toHaveLength(1);
  }, 30_000);

  test('a folder the set made serves the same way: its identity and its pages come from its manifest and docs', async () => {
    // The set's example product folder (decision 0019: madarch serves a
    // set-made, a madarch-made and a hand-made folder alike).
    const base = scratchFolder();
    const built = builtApp(base);
    const setMade = join(base, 'leftover-listings');
    cpSync(SET_MADE_FIXTURE, setMade, { recursive: true });
    const serve = serveLive(['serve', '--product', setMade, '--port', '0', '--no-open'],
      { MADARCH_HOME: base, MADARCH_APP: built });
    const address = await whenServing(serve, '/api/product');
    const body = (await (await fetch(`${address}/api/product`)).json()) as { id: string; name: string; schemaVersion: number };
    expect(body.id).toBe('8f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f');
    expect(body.name).toBe('leftover-listings');
    const pages = (await (await fetch(`${address}/api/pages`)).json()) as unknown as { pages: { path: string; title: string }[] };
    const paths = pages.pages.map((page) => page.path);
    expect(paths).toContain('docs/vision.md');
    expect(paths).toContain('docs/requirements/FR-001-list-in-a-minute.md');
    await serve.finish();
  }, 30_000);

  test('a step that fails exits 1: the server could not take the port it was given', () => {
    // The start itself failing — a port the user may not listen on, not an
    // address already in use — is a failed step, exit 1, whole words added.
    const base = scratchFolder();
    const built = builtApp(base);
    const folder = product(base);
    const run = runCommand(['serve', '--product', folder, '--port', '1', '--no-open'],
      { MADARCH_HOME: base, MADARCH_APP: built }, folder);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('port 1');
    expect(run.stderr).toContain('the server could not be started');
  });

  test('a second serve while the dist stands builds nothing', async () => {
    const base = scratchFolder();
    const built = builtApp(base);
    const builder = injectableBuilder(built, 'ok');
    const folder = product(base);
    const serve = serveLive(['serve', '--product', folder, '--port', '0', '--no-open'],
      { MADARCH_HOME: base, MADARCH_APP: built, MADARCH_APP_BUILD: builder.command });
    await whenServing(serve);
    await serve.finish();
    expect(existsSync(builder.callsFile)).toBe(false);
  }, 30_000);

  test('a port already in use is refused with exit 2, naming --port; the holder keeps serving', async () => {
    const base = scratchFolder();
    const built = builtApp(base);
    const folder = product(base);
    const holder = serveLive(['serve', '--port', '0'], { MADARCH_HOME: base, MADARCH_APP: built }, folder);
    const url = await whenServing(holder);
    const port = url.split(':').pop() ?? '???';
    const over = runCommand(['serve', '--port', port], { MADARCH_HOME: base, MADARCH_APP: built }, folder);
    expect(over.status).toBe(2);
    expect(over.stderr).toContain('--port');
    expect(over.stderr).toContain(port);
    await holder.finish();
  }, 30_000);

  test('serve opens the browser it was told (MADARCH_BROWSER) after printing the address; a failing opener only warns, holding the address', async () => {
    const base = scratchFolder();
    const built = builtApp(base);
    const folder = product(base);
    const opener = injectableOpener('fail');
    const serve = serveLive(['serve', '--product', folder, '--port', '0'],
      { MADARCH_HOME: base, MADARCH_APP: built, MADARCH_BROWSER: opener });
    const address = await whenServing(serve);
    await Bun.sleep(1000);
    // The opener was given the address; the server still stands for the person.
    expect(await Bun.file(opener.replace('march-open', 'open.log')).text().catch(() => '')).toContain(address);
    const finished = await serve.finish();
    expect(finished.stderr).toContain('could not open the browser');
    expect(finished.stderr).toContain(address);
  }, 30_000);

  test('a slow opener does not block the server: the address answers while the opener runs', async () => {
    const base = scratchFolder();
    const built = builtApp(base);
    const folder = product(base);
    const opener = scratchFolder('madarch-serve-opener-');
    const openerCommand = join(opener, 'march-open');
    writeFileSync(openerCommand, '#!/bin/sh\nsleep 15\n');
    chmodSync(openerCommand, 0o755);
    const serve = serveLive(['serve', '--product', folder, '--port', '0'],
      { MADARCH_HOME: base, MADARCH_APP: built, MADARCH_BROWSER: openerCommand });
    // The whole wait is the point: the server must answer while the opener is alive.
    const address = await whenServing(serve);
    const answer = await fetch(`${address}/api/product`);
    expect(answer.ok).toBeTrue();
    await serve.finish();
  }, 30_000);

  test('a manifest refusal names the manifest file and its line', () => {
    const base = scratchFolder();
    const folder = join(base, 'bad');
    mkdirSync(join(folder, 'docs'), { recursive: true });
    writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: [unclosed\n');
    const built = builtApp(base);
    const run = runCommand(['serve', '--product', folder, '--no-open'],
      { MADARCH_HOME: base, MADARCH_APP: built }, base);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(join(folder, 'workspace.yaml'));
    expect(run.stderr).toMatch(/line \d/);
  });

  test('a builder that cannot be launched names the cause, not just exit null', () => {
    const base = scratchFolder();
    const app = join(base, 'app-folder-never-created');
    const run = runCommand(['serve', '--product', product(base), '--port', '0', '--no-open'],
      { MADARCH_HOME: base, MADARCH_APP: app, MADARCH_APP_BUILD: 'true' }, base);
    expect(run.status).toBe(2);
    expect(run.stderr).not.toContain('exit null');
    expect(run.stderr).toMatch(/no such file|ENOENT/i);
  });

  test('serve --no-open opens nothing, not even through MADARCH_BROWSER', async () => {
    const base = scratchFolder();
    const built = builtApp(base);
    const folder = product(base);
    const opener = injectableOpener('ok');
    const serve = serveLive(['serve', '--product', folder, '--port', '0', '--no-open'],
      { MADARCH_HOME: base, MADARCH_APP: built, MADARCH_BROWSER: opener });
    await whenServing(serve);
    await Bun.sleep(1000);
    expect(existsSync(opener.replace('march-open', 'open.log'))).toBe(false);
    await serve.finish();
  }, 30_000);
});

describe('madarch new serving the draft it just created', () => {
  test('new creates the draft, serves it, prints the address, and the home page answers over HTTP', async () => {
    const base = scratchFolder();
    const built = builtApp(base);
    const opener = injectableOpener('ok');
    const serve = serveLive(['new', '--home', base, '--port', '0', '--no-open'],
      { MADARCH_HOME: base, MADARCH_APP: built, MADARCH_BROWSER: opener });
    const address = await whenServing(serve, '/api/product');
    await Bun.sleep(500);
    // The draft's facts come first, one per line, then the address.
    const lines = serve.stdout.split('\n').filter((line) => line !== '');
    expect(lines[0]).toStartWith('folder: ');
    expect(lines[1]).toStartWith('id: ');
    const body = (await (await fetch(`${address}/api/product`)).json()) as { name: string };
    expect(body.name).toStartWith('idea-');
    await serve.finish();
  }, 30_000);

  test('new keeps refusing an unknown option with exit 2, before any draft is created', () => {
    const base = scratchFolder();
    const run = runCommand(['new', '--nope'], { MADARCH_HOME: base });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('--nope');
  });

  test('new keeps refusing a --port with no value and a --port that is no port number', () => {
    const base = scratchFolder();
    const portOnly = runCommand(['new', '--port'], { MADARCH_HOME: base });
    expect(portOnly.status).toBe(2);
    expect(portOnly.stderr).toContain('--port');
    const portNotANumber = runCommand(['new', '--port', 'not-a-port'], { MADARCH_HOME: base });
    expect(portNotANumber.status).toBe(2);
    expect(portNotANumber.stderr).toContain('not-a-port');
  });

  test('new keeps refusing an option where the --home value was meant', () => {
    const base = scratchFolder();
    const homeValue = runCommand(['new', '--home', '--no-open'], { MADARCH_HOME: base });
    expect(homeValue.status).toBe(2);
    expect(homeValue.stderr).toContain('--home');
    expect(homeValue.stderr).toContain('--no-open');
  });
});

describe('the help the command gives', () => {
  test('--help names new and serve with every option, and a usage line in the shape scripts/serve.ts uses', () => {
    const run = runCommand(['--help'], {});
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('new');
    expect(run.stdout).toContain('serve');
    expect(run.stdout).toContain('--home');
    expect(run.stdout).toContain('--product');
    expect(run.stdout).toContain('--port');
    expect(run.stdout).toContain('--no-open');
    expect(run.stdout).toContain('usage: bun scripts/madarch.ts');
  });
});
