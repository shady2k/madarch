/**
 * Serving a product's wiki from the `madarch` command (madarch-rtr.2.3;
 * the capability product-wiki's requirements `serve`, `app` and `result`).
 * The command parses the arguments; this is the work behind both
 * subcommands: `new` serves the draft it just created, `serve` serves the
 * product of a folder given with `--product`, or of the current folder
 * when none was given.
 *
 * The flow is the requirement's: the product is opened first (a folder
 * whose manifest cannot be read is refused by name); then the app's built
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
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { startServer, type StartedServer } from '../server/http.js';
import { readProduct } from '../product/manifest.js';
import { ensureBuilt, type AppBuildOptions } from './app.js';

/** The port the command serves on when none is named; the model server's own default. */
const DEFAULT_PORT = 4180;

/** The environment the opener's choice is read from, or the process's. */
export type ServeEnv = Readonly<Record<string, string | undefined>>;

/** An address opener: the whole machine's way, or whatever a test holds instead. */
export type Opener = (url: string) => { ok: true } | { ok: false; message: string };

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
  return (url) => {
    const chosen = browserCommand(env);
    if (typeof chosen !== 'string') return { ok: false, message: chosen.message };
    // A `BROWSER` in the wild often carries a `%s` where the address goes;
    // the plain form takes the address as the last argument.
    const argv = chosen.includes('%s') ? chosen.split('%s').map((part, index) => (index === 0 ? [part] : [url])).flat() : [chosen, url];
    const run = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8' });
    if (run.status !== 0) {
      const said = run.status === null ? 'nothing was run' : `exit ${String(run.status)}${run.stderr?.trim() ? ': ' + run.stderr.trim() : ''}`;
      return { ok: false, message: `the opener ${JSON.stringify(chosen)} failed for ${url} (${said})` };
    }
    return { ok: true };
  };
}

/** Serves one product's wiki; the command's own serving, to be stopped by the one who ran it. */
export function serveWiki(options: ServeOptions = {}): ServeResult {
  const print = options.print ?? ((line: string) => console.log(line));
  const printError = options.printError ?? ((line: string) => console.error(line));
  const cwd = options.cwd ?? process.cwd();
  const folder = resolve(options.productFolder?.trim() || cwd);

  const read = readProduct(folder);
  if (!read.ok) {
    return { outcome: 'refused', message: `the folder ${folder} cannot be served as a product's wiki: ${read.message}` };
  }
  const built = ensureBuilt({ appFolder: options.appFolder, buildCommand: options.buildCommand, env: options.env }, print);
  if (!built.ok) return { outcome: 'refused', message: built.message };
  const port = options.port ?? DEFAULT_PORT;
  let server: StartedServer;
  try {
    server = startServer({ productFolder: folder, appFolder: built.dist, port });
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
  print(`address: ${server.url}`);
  if (options.open !== false) {
    const opened = (options.opener ?? machineOpener(options.env ?? process.env))(server.url);
    if (!opened.ok) printError(`could not open the browser: ${opened.message} — the wiki is at ${server.url}`);
  }
  return { outcome: 'serving', server, url: server.url };
}
