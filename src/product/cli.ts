/**
 * The `madarch` command's parsing and printing
 * (docs/changes/draft-product/capabilities/product-repository.md,
 * requirement draft). `scripts/madarch.ts` is the entry point; this
 * module parses the arguments the way the project's other command
 * scripts parse (`scripts/serve.ts`), calls the draft library, and
 * decides only the exit code and the stream: 0 when the draft was
 * created, 2 when an argument or the products home cannot be used, 1
 * when a step of the creation failed (git refused) — the library's
 * `refused` and `failed` carry the message, printed whole on standard
 * error. The created draft's folder and its id go to standard output,
 * one fact per line, as `folder: <path>` and `id: <id>`.
 *
 * This task creates the draft only: `new` starts no server and opens
 * no browser (madarch-rtr.2.3's work), so `--port` and `--no-open` are
 * not options yet and an unknown option is refused, naming what is
 * accepted — a silently ignored option would tell a person a browser
 * was opened when nothing was.
 */
import { createDraft } from './draft.js';
import { serveWiki, type Opener, type ServeOptions } from '../product-wiki/serve.js';

/** The usage lines, shaped the way `scripts/serve.ts` and `scripts/wiki.ts` print theirs. */
export const USAGE = [
  'usage: bun scripts/madarch.ts serve [--product <folder>] [--port <n>] [--no-open]',
  '   or: bun scripts/madarch.ts new [--home <folder>] [--port <n>] [--no-open]',
  '   (the same commands after `bun link` in a checkout: madarch new, madarch serve)',
].join('\n');

/** The text `--help` prints: the subcommands and the options each does what. */
export const HELP = [
  'usage: bun scripts/madarch.ts serve [--product <folder>] [--port <n>] [--no-open]',
  '   or: bun scripts/madarch.ts new [--home <folder>] [--port <n>] [--no-open]',
  '   or: madarch serve|new — the same commands after `bun link` in a checkout',
  '',
  'new creates a draft product repository under the products home, then serves',
  "its wiki: the draft's folder and id, the address of the wiki, one fact per",
  'line, on standard output. serve serves a product that already exists: the',
  '--product folder, or the folder the command runs in (the folder the working',
  "agent is in). Both serve until they are stopped.",
  '',
  'The first run also builds the app the wiki reads (wiki/app in the madarch',
  'checkout): it says so on standard output before the build starts, and never',
  'builds again while the built files are there.',
  '',
  'subcommands:',
  '  new     create a draft product repository and serve its wiki',
  '  serve   serve the product of the given or the current folder',
  'options:',
  '  --home <folder>       new only: the products home of this one command, over MADARCH_HOME',
  '                        (without either, ~/madarch/products)',
  '  --product <folder>    serve only: the product folder to serve; the current folder when absent',
  '  --port <n>            the port the wiki is served on (4180 by default; a port in use is refused)',
  '  --no-open             print the address but do not open the browser',
].join('\n');

/**
 * The command's one run: parse, then the subcommand's work. The exit code
 * is 0 created-and-served or refused-to-serve-nothing's opposite — 0 when
 * the wiki is being served, 2 when an argument, a product folder, a
 * manifest, a port already in use or an app build cannot be used (each
 * naming what is wrong, on standard error, one message), 1 when a step of
 * the creation or the serving failed. The wiki's address goes to standard
 * output; serving keeps the process alive until it is stopped.
 */
export interface CliDeps {
  /** The app folder and build the serving is pointed at, over the process's environment. */
  app?: { appFolder?: string; buildCommand?: string; env?: Readonly<Record<string, string | undefined>> };
  /** The opener the serving uses, over the machine's own. */
  opener?: Opener;
}

export function main(args: readonly string[], deps: CliDeps = {}): number {
  if (args.length === 0) {
    console.error('no subcommand given: the subcommands are "new" and "serve"');
    console.error(USAGE);
    return 2;
  }
  const command = args[0]!;
  if (command === '--help') {
    console.log(HELP);
    return 0;
  }
  if (command.startsWith('--')) {
    console.error(`unknown option "${command}" before the subcommand: the subcommands are "new" and "serve"`);
    console.error(USAGE);
    return 2;
  }
  if (command !== 'new' && command !== 'serve') {
    console.error(`unknown subcommand "${command}": the subcommands are "new" and "serve"`);
    console.error(USAGE);
    return 2;
  }

  const parsed = parse({ home: command === 'new', product: command === 'serve' }, args.slice(1));
  if (typeof parsed === 'number') return parsed;
  const { home, product, port, open } = parsed;

  const serveOptions: ServeOptions = {
    port,
    open,
    appFolder: deps.app?.appFolder,
    buildCommand: deps.app?.buildCommand,
    env: deps.app?.env,
    opener: deps.opener,
  };

  if (command === 'serve') {
    return serve(serveOptions, product);
  }
  // new: the draft is created as it ever was, then its wiki is served.
  const draft = createDraft(home === undefined ? {} : { home });
  if (draft.outcome !== 'created') {
    console.error(draft.message);
    return draft.outcome === 'refused' ? 2 : 1;
  }
  console.log(`folder: ${draft.folder}`);
  console.log(`id: ${draft.id}`);
  return serve(serveOptions, draft.folder);
}

/** The serving of one subcommand's product: its prints and its exit code; 0 once the address stands. */
function serve(options: ServeOptions, productFolder: string | undefined): number {
  const result = serveWiki({ ...options, productFolder });
  if (result.outcome === 'serving') return 0;
  console.error(result.message);
  return result.outcome === 'refused' ? 2 : 1;
}

/** One subcommand's options, parsed: the flags each accepts, or the number of the exit a refusal needs. */
interface Parsed {
  home: string | undefined;
  product: string | undefined;
  port: number | undefined;
  open: boolean;
}

/**
 * The options of the subcommand, parsed the way the other commands parse
 * (`--flag value` and `--flag=value` alike): a word that starts with `--`
 * is always a flag, never the value of the flag before it — `--home
 * --no-open` is refused instead of silently naming a folder `--no-open`.
 */
function parse(accepts: { home: boolean; product: boolean }, given: readonly string[]): Parsed | number {
  const parsed: Parsed = { home: undefined, product: undefined, port: undefined, open: true };
  const flags = [
    ...(accepts.home ? ['--home <folder>'] : []),
    ...(accepts.product ? ['--product <folder>'] : []),
    '--port <n>',
    '--no-open',
  ].join(', ');
  for (let i = 0; i < given.length; i++) {
    const arg = given[i]!;
    if (!arg.startsWith('--')) {
      console.error(`unexpected argument "${arg}": the only options are ${flags}`);
      console.error(USAGE);
      return 2;
    }
    const name = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (!flagListFor(accepts).includes(name)) {
      console.error(`unknown option "${arg}": the options are ${flags}`);
      console.error(USAGE);
      return 2;
    }
    // The value, whether given inline or as the next word that is not an
    // option; the exact form each flag refuses is named with the flag.
    const valueProblem = (label: string, value: string | undefined): string | undefined => {
      if (value === undefined) return `${label} needs a value: ${flags}`;
      const trimmed = value.trim();
      if (trimmed === '' || trimmed.startsWith('--')) return `${label} needs a folder, not ${JSON.stringify(trimmed)}: ${flags}`;
      return undefined;
    };
    const flagValue = (): string | undefined => {
      const inlineValue = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : undefined;
      if (inlineValue !== undefined) return inlineValue;
      const next = given[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        i++;
        return next;
      }
      return next === undefined ? undefined : next; // an option there: refused below by valueProblem
    };

    if (name === '--no-open') {
      if (arg.includes('=')) {
        console.error(`the --no-open flag takes no value: it says whether the browser is opened`);
        console.error(USAGE);
        return 2;
      }
      parsed.open = false;
      continue;
    }
    if (name === '--port') {
      const value = flagValue();
      const n = value === undefined ? Number.NaN : Number(value);
      if (value === undefined || !Number.isInteger(n) || n < 0 || n > 65535) {
        console.error(`--port ${JSON.stringify(value ?? '')} is not a whole port number between 0 and 65535: the address is served at that port`);
        console.error(USAGE);
        return 2;
      }
      parsed.port = n;
      continue;
    }
    // --home and --product: a folder.
    const label = name === '--home' ? '--home' : '--product';
    const value = flagValue();
    const problem = valueProblem(label, value);
    if (problem !== undefined) {
      console.error(problem);
      console.error(USAGE);
      return 2;
    }
    if (name === '--home') parsed.home = value!.trim();
    else parsed.product = value!.trim();
  }
  return parsed;
}

/** The flags one subcommand takes, beside the ones they both share. */
function flagListFor(accepts: { home: boolean; product: boolean }): readonly string[] {
  return [
    ...(accepts.home ? ['--home'] : []),
    ...(accepts.product ? ['--product'] : []),
    '--port',
    '--no-open',
  ];
}
