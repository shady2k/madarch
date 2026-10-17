/**
 * Serving a product's wiki from the `madarch` command (madarch-rtr.2.3;
 * the capability product-wiki's requirements `serve`, `app` and `result`).
 * The command parses the arguments; this is the work behind both
 * subcommands: `new` serves the draft it just created, `serve` serves the
 * product of a folder given with `--product`, or of the current folder
 * when none was given.
 *
 * The flow is the requirement's: a valid product is opened first; an
 * existing directory with no manifest opts into a temporary, read-only
 * wiki home; every other manifest refusal is named. Then the app's built
 * files are built once on first use (`ensureBuilt`, saying so before the
 * build starts); then the server is started on the port named, or refused
 * naming `--port`; then the address is printed, and only after it, the
 * machine's own opener is asked to open it — `MADARCH_BROWSER`, then
 * `BROWSER`, then `xdg-open` on Linux and `open` on macOS. An opener that
 * is absent or fails is a warning on standard error holding the address,
 * never the command's failure; `--no-open` skips it entirely.
 *
 * Serving changes nothing in the product and reads it fresh at every ask,
 * through the server's own product mode. The command serves until it is
 * stopped; the exit codes are 2 for a refusal, 1 only for a step that
 * failed.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { startServer, type StartedServer } from '../server/http.js';
import { readProduct } from '../product/manifest.js';
import { isExistingDirectoryWithoutManifest } from './manifestless.js';
import { ensureBuilt, type AppBuildOptions } from './app.js';

/** The port the command serves on when none is named; the model server's own default. */
const DEFAULT_PORT = 4180;

/** The environment the opener's choice is read from, or the process's. */
export type ServeEnv = Readonly<Record<string, string | undefined>>;

/**
 * An address opener: the whole machine's way, or whatever a test holds
 * instead. It answers without waiting for the browser to close: a
 * foreground browser must never hold the server back, so the opener is
 * launched and its failure — a command that cannot run, or one that exits
 * with an error — is learned later, as a warning.
 */
export type Opener = (url: string) => Promise<{ ok: true } | { ok: false; message: string }>;

/** How serving one product ended; the command maps `refused` to exit 2, `failed` to 1. */
export type ServeResult =
  | { outcome: 'serving'; server: StartedServer; url: string }
  | { outcome: 'refused'; message: string }
  | { outcome: 'failed'; message: string };

export interface ServeOptions extends AppBuildOptions {
  /**
   * The product folder to serve. Left out, the current working folder —
   * the folder the agent runs in, for `serve` — is served; the same
   * refusal naming it follows when it is not a product.
   */
  productFolder?: string;
  /** The port to listen on; `4180` by default, `0` for a port of the moment's own. */
  port?: number;
  /** The address to bind; loopback by default. */
  host?: string;
  /** Whether the browser is opened; yes unless `--no-open` was given. */
  open?: boolean;
  /** Where the product's folder is resolved from when `productFolder` is left out. */
  cwd?: string;
  /** Where the address and the build notice go; standard output by default, one fact per line. */
  print?: (line: string) => void;
  /** Where a refusal and an opener warning go; standard error by default. */
  printError?: (line: string) => void;
  /** The environment the opener is chosen by, or the process's. */
  env?: ServeEnv;
  /** The opener; the machine's pointer chain by default. */
  opener?: Opener;
}

/** How the default opener resolves the browser it runs. */
export function browserCommand(env: ServeEnv = process.env): string | { message: string } {
  const named = env.MADARCH_BROWSER?.trim() || env.BROWSER?.trim();
  if (named !== undefined && named !== '') return named;
  if (process.platform === 'linux') return 'xdg-open';
  if (process.platform === 'darwin') return 'open';
  return { message: `the platform ${process.platform} has no browser opener madarch knows` };
}

/** The machine's opener: a command pointer from the environment, or the platform's own. */
export function machineOpener(env: ServeEnv = process.env): Opener {
  return (url) =>
    new Promise((resolveOutcome) => {
      const chosen = browserCommand(env);
      if (typeof chosen !== 'string') {
        resolveOutcome({ ok: false, message: chosen.message });
        return;
      }
      // A `BROWSER` in the wild often carries a `%s` where the address goes;
      // the plain form takes the address as the last argument.
      const argv = chosen.includes('%s') ? chosen.split('%s').map((part, index) => (index === 0 ? [part] : [url])).flat() : [chosen, url];
      let child;
      try {
        // Detached from this process's lifetime and never waited on here:
        // a foreground browser runs as long as it likes and the server
        // keeps serving. The exit and error handlers are attached at once,
        // so the child is reaped and cannot become a zombie.
        child = spawn(argv[0]!, argv.slice(1), { stdio: 'ignore', detached: true });
      } catch (error) {
        resolveOutcome({ ok: false, message: `the opener ${JSON.stringify(chosen)} could not be launched: ${(error as Error).message}` });
        return;
      }
      // The opener's lifetime is the browser's, never this process's: once
      // the handlers above are attached, the child is unref'd so a stopped
      // server does not stay alive while a browser (or a sleeping opener)
      // still runs (finding 8).
      child.unref();
      child.on('error', (error) => {
        resolveOutcome({ ok: false, message: `the opener ${JSON.stringify(chosen)} failed: ${error.message}` });
      });
      child.on('exit', (code, signal) => {
        if (code === 0) {
          resolveOutcome({ ok: true });
          return;
        }
        const said = signal !== null ? `killed by ${signal}` : `exit ${String(code)}`;
        resolveOutcome({ ok: false, message: `the opener ${JSON.stringify(chosen)} failed (${said})` });
      });
    });
}

/** Serves one product's wiki; the command's own serving, to be stopped by the one who ran it. */
export async function serveWiki(options: ServeOptions = {}): Promise<ServeResult> {
  const print = options.print ?? ((line: string) => console.log(line));
  const printError = options.printError ?? ((line: string) => console.error(line));
  const cwd = options.cwd ?? process.cwd();
  const folder = resolve(options.productFolder?.trim() || cwd);

  const read = readProduct(folder);
  const noManifest = !read.ok && isExistingDirectoryWithoutManifest(folder);
  if (!read.ok && !noManifest) {
    return { outcome: 'refused', message: `the folder ${folder} cannot be served as a product's wiki: ${read.message} (${read.file}, line ${read.line})` };
  }
  const built = ensureBuilt({ appFolder: options.appFolder, buildCommand: options.buildCommand, env: options.env }, print);
  if (!built.ok) return { outcome: 'refused', message: built.message };
  const port = options.port ?? DEFAULT_PORT;
  let server: StartedServer;
  try {
    server = await startServer({ productFolder: folder, appFolder: built.dist, port, host: options.host ?? '127.0.0.1', allowNoManifest: noManifest });
  } catch (error) {
    const message = (error as Error).message;
    // Bun's thrown error carries the POSIX code ("EADDRINUSE") rather than the
    // words, so the code is checked beside the message's own text.
    if ((error as { code?: string }).code === 'EADDRINUSE' || message.includes('EADDRINUSE') || message.toLowerCase().includes('address already in use')) {
      return { outcome: 'refused', message: `the port ${port} is already in use: nothing else can serve there — name another with --port <n>` };
    }
    return { outcome: 'failed', message: `the server could not be started on port ${port}: ${message}` };
  }
  // The address first; the opener's outcome is never the address's.
  const networkBound = options.host !== undefined && !['127.0.0.1', 'localhost', '::1'].includes(options.host);
  if (networkBound) print('Warning: this wiki is reachable from the network without a password.');
  const env = options.env ?? process.env;
  const ssh = Boolean(env.SSH_CONNECTION || env.SSH_TTY);
  const noDesktop = process.platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY;
  const open = options.open !== false && !ssh && (!noDesktop || Boolean(options.opener || env.MADARCH_BROWSER?.trim() || env.BROWSER?.trim()));
  print(open ? `The wiki is running at ${server.url}  (Ctrl+C stops it)` : `Wiki: ${server.url}  (Ctrl+C stops it)`);
  if (ssh) {
    const [remoteHost] = (env.SSH_CONNECTION ?? '').split(/\s+/).slice(2, 3);
    const user = env.USER || '<user>';
    print('This machine is remote (SSH). To open the wiki on your computer, run there:');
    print(`  ssh -L ${server.port}:127.0.0.1:${server.port} ${user}@${remoteHost || '<host>'}`);
    print(`and open http://localhost:${server.port}`);
  }
  if (open) {
    void (options.opener ?? machineOpener(env))(server.url).then((opened) => {
      if (!opened.ok) print(`The browser was not opened: ${opened.message}`);
    });
  }
  return { outcome: 'serving', server, url: server.url };
}
