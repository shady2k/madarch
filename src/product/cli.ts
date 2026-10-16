/**
 * The `madarch` command's parsing and printing (`scripts/madarch.ts` is the
 * entry point; docs/changes/draft-product/capabilities/product-repository.md
 * and the lifecycle commands of feature madarch-525o). This module parses the
 * arguments the way the project's other command scripts parse
 * (`scripts/serve.ts`), calls the draft library or the lifecycle module for
 * the lifecycle, and decides only the exit code and the stream: 0 when the work
 * is done, 2 when an argument, a product folder, a manifest or the products
 * home cannot be used, 1 when a step failed (git refused) — the library's
 * `refused` and `failed` carry the message, printed whole on standard error.
 * Facts go to standard output, one per line.
 */
import { createInterface } from 'node:readline/promises';
import { createDraft } from './draft.js';
import { prepareDemo, type DemoOptions } from './demo.js';
import { listProducts, type ProductList } from './list.js';
import { runningVersion } from './version.js';
import { upgrade, type UpgradeOptions } from './upgrade.js';
import { serveWiki, type Opener, type ServeOptions } from '../product-wiki/serve.js';
import {
  cloneLife,
  initLife,
  bootstrapLife,
  remoteLife,
  renameLife,
  repoAddLife,
  repoAddSource,
  type LifecycleOutcome,
  type RepoConnectMode,
} from './lifecycle.js';

/** The usage lines, shaped the way `scripts/serve.ts` and `scripts/wiki.ts` print theirs. */
export const USAGE = [
  'usage: madarch serve [--product <folder>] [--port <n>] [--no-open]',
  '   or: madarch new [--home <folder>] [--port <n>] [--no-open]',
  '   or: madarch init [--home <folder>] [--port <n>] [--no-open]',
  '   or: madarch demo [--home <folder>] [--port <n>] [--no-open]',
  '   or: madarch list [--home <folder>]',
  '   or: madarch rename <name> [--product <folder>]',
  '   or: madarch remote <url> [--product <folder>]',
  '   or: madarch repo add <name> <url> [--source <path>] [--mode <link|move|clone>] [--branch <b>] [--product <folder>]',
  '   or: madarch bootstrap [--product <folder>]',
  '   or: madarch clone <url> [--home <folder>]',
  '   or: madarch version',
  '   or: madarch upgrade [--yes]',
  '   (the same commands after `bun link` in a checkout: madarch demo, madarch new, madarch serve, madarch list,',
  '    madarch init, madarch rename, madarch remote, madarch repo add, madarch bootstrap, madarch clone,',
  '    madarch version, madarch upgrade)',
].join('\n');

/** The text `--help` prints: the subcommands and the options each does what. */
export const HELP = [
  'usage: madarch serve [--product <folder>] [--port <n>] [--no-open]',
  '   or: madarch new [--home <folder>] [--port <n>] [--no-open]',
  '   or: madarch init [--home <folder>] [--port <n>] [--no-open]',
  '   or: madarch demo [--home <folder>] [--port <n>] [--no-open]',
  '   or: madarch list [--home <folder>]',
  '   or: madarch rename <name> [--product <folder>]',
  '   or: madarch remote <url> [--product <folder>]',
  '   or: madarch repo add <name> <url> [--source <path>] [--mode <link|move|clone>] [--branch <b>] [--product <folder>]',
  '   or: madarch bootstrap [--product <folder>]',
  '   or: madarch clone <url> [--home <folder>]',
  '   or: madarch demo|serve|new|init|list|rename|remote|repo add|bootstrap|clone|version|upgrade — the same',
  '   commands after `bun link` in a checkout',
  '',
  'demo clones or updates the Madarch product repository, then serves its wiki.',
  'new creates a draft product repository under the products home, then serves',
  "its wiki: the draft's folder and id, the address of the wiki, one fact per",
  'line, on standard output. serve serves a product that already exists: the',
  '--product folder, or the folder the command runs in (the folder the working',
  "agent is in). Both serve until they are stopped.",
  '',
  'list names the products the products home holds, one product at a time:',
  'its folder, id and name, one fact per line, in code point order of the',
  'folders. A product the home holds whose manifest cannot be read is named',
  'on standard error, and the list still shows what it did read.',
  '',
  'rename names a product: the draft.',
  '--product folder, or the product the command runs in, or the product a',
  "checkout under its repos/ stands in: the folder is renamed in place, the",
  'id and every other manifest byte are kept, and the change is one commit of',
  "the product's own history.",
  '',
  'remote adds origin to the product: the url, its --product folder, or the',
  "product the command runs in. It never pushes: pushing is the person's own",
  'git. An origin already there is refused, never replaced.',
  '',
  'repo add records one code repository in the manifest (name, remote url,',
  'optional --branch) and connects it at repos/<name>. With no local checkout',
  'selected, it clones the url and never searches another folder. --source',
  'names a local Git checkout; otherwise a distinct checkout the command runs',
  'from can be used. Interactive use asks link (the default), move or clone;',
  'a non-interactive run must give --mode. Link leaves the checkout in place;',
  'move preserves its branch, uncommitted work and stash; clone leaves it',
  'untouched. A Windows link is a directory junction.',
  '',
  'bootstrap clones what the manifest declares into repos/<name>: what a',
  "--product folder declares, the product the command runs in, or a checkout's",
  'parent product. One repository at a time, named whatever became of it.',
  '',
  'clone clones a pushed product repository into the products home,',
  'bootstraps it and prints the folder, its id and how to open its wiki:',
  'this is how a second engineer joins. A url that is no product repository',
  'is refused and its folder left behind nowhere.',
  '',
  'The lifecycle commands refuse without a product when the working folder',
  'carries none: no product above the folder, nothing to work on.',
  '',
  'The first serve or new also builds the app the wiki reads (wiki/app in the',
  'madarch checkout): it says so on standard output before the build starts,',
  'and never builds again while the built files are there.',
  '',
  'subcommands:',
  '  demo       clone or update the Madarch product repository and serve its wiki',
  '  init       create a product around this Git checkout and serve its wiki',
  '  new        create a draft product repository and serve its wiki',
  '  serve      serve the product of the given or the current folder',
  '  list       name the products the products home holds',
  '  rename     name a product: the draft, in place, its id kept',
  '  remote     add origin to a product: its url, never a push',
  '  repo add   enter one code repository in the manifest and clone it',
  '  bootstrap  clone what the manifest declares into repos/<name>',
  '  clone      clone a pushed product into the products home and bootstrap it',
  'options:',
  '  --home <folder>       demo, new, init, list and clone: the products home of this one command, over MADARCH_HOME',
  '                        (without either, ~/madarch/products)',
  '  --product <folder>    serve, rename, remote, repo add and bootstrap: the product folder to work on;',
  '                        the product the command runs in when absent',
  '  --branch <b>          repo add only: the branch the clone is taken from',
  '  --port <n>            the port the wiki is served on (4180 by default; a port in use is refused)',
  '  --no-open             print the address but do not open the browser',
].join('\n');

/** One subcommand's argument surface, whole: what it takes, and nothing else. */
interface CommandSpec {
  /** The positional words it takes, in order, by their label for the refusals. */
  positionals: readonly string[];
  /** The flags it takes, beside the ones they both share. */
  flags: { home: boolean; product: boolean; port: boolean; open: boolean; branch: boolean; yes: boolean; source?: boolean; mode?: boolean };
}

/** The specs the subcommands answer to, whole. */
export const COMMANDS: Record<string, CommandSpec> = {
  demo: { positionals: [], flags: { home: true, product: false, port: true, open: true, branch: false, yes: false } },
  init: { positionals: [], flags: { home: true, product: false, port: true, open: true, branch: false, yes: false } },
  new: { positionals: [], flags: { home: true, product: false, port: true, open: true, branch: false, yes: false } },
  serve: { positionals: [], flags: { home: false, product: true, port: true, open: true, branch: false, yes: false } },
  list: { positionals: [], flags: { home: true, product: false, port: false, open: false, branch: false, yes: false } },
  rename: { positionals: ['name'], flags: { home: false, product: true, port: false, open: false, branch: false, yes: false } },
  remote: { positionals: ['url'], flags: { home: false, product: true, port: false, open: false, branch: false, yes: false } },
  repo: { positionals: ['verb', 'name', 'url'], flags: { home: false, product: true, port: false, open: false, branch: true, yes: false, source: true, mode: true } },
  bootstrap: { positionals: [], flags: { home: false, product: true, port: false, open: false, branch: false, yes: false } },
  clone: { positionals: ['url'], flags: { home: true, product: false, port: false, open: false, branch: false, yes: false } },
  version: { positionals: [], flags: { home: false, product: false, port: false, open: false, branch: false, yes: false } },
  upgrade: { positionals: [], flags: { home: false, product: false, port: false, open: false, branch: false, yes: true } },
};

/** One subcommand's parsed words and options. */
interface Parsed {
  /** The positional words in the order the spec names them; empty where none stand. */
  words: readonly string[];
  home: string | undefined;
  product: string | undefined;
  port: number | undefined;
  open: boolean;
  branch: string | undefined;
  yes: boolean;
  source: string | undefined;
  mode: RepoConnectMode | undefined;
}

/** The flags one subcommand takes, for the refusals to name them. */
function flagNamesFor(flags: CommandSpec['flags']): readonly string[] {
  return [
    ...(flags.home ? ['--home'] : []),
    ...(flags.product ? ['--product'] : []),
    ...(flags.port ? ['--port'] : []),
    ...(flags.open ? ['--no-open'] : []),
    ...(flags.branch ? ['--branch'] : []),
    ...(flags.source ? ['--source'] : []),
    ...(flags.mode ? ['--mode'] : []),
    ...(flags.yes ? ['--yes'] : []),
  ];
}

/**
 * The options and words of one subcommand, parsed the way the other commands
 * parse (`--flag value` and `--flag=value` alike): a word that starts with
 * `--` is always a flag, never the value of the flag before it — `--home
 * --no-open` is refused instead of silently naming a folder `--no-open`.
 * Returns the parse, or the number of the exit a refusal needs.
 */
function parse(spec: CommandSpec, given: readonly string[]): Parsed | number {
  const parsed: Parsed = { words: [], home: undefined, product: undefined, port: undefined, open: true, branch: undefined, yes: false, source: undefined, mode: undefined };
  const seen = new Set<string>();
  const flags = flagNamesFor(spec.flags).map((name) => `${name}${name === '--no-open' ? '' : ' <value>'}`).join(', ');
  for (let i = 0; i < given.length; i++) {
    const arg = given[i]!;
    if (!arg.startsWith('--')) {
      // A positional word, taken in the order the spec names them; a word
      // beyond the surface is refused whole, never folded in.
      if (parsed.words.length >= spec.positionals.length) {
        console.error(`unexpected argument "${arg}": this subcommand takes ${spec.positionals.length === 0 ? 'no words' : spec.positionals.join(' ')}`);
        console.error(USAGE);
        return 2;
      }
      parsed.words = [...parsed.words, arg];
      continue;
    }
    const name = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (!flagNamesFor(spec.flags).includes(name)) {
      console.error(`unknown option "${arg}": the options are ${flags}`);
      console.error(USAGE);
      return 2;
    }
    // A value flag takes one value: a second occurrence would silently move
    // the first (a repeated --product can redirect the whole command), so it
    // is refused the way an unknown option is.
    if (name !== '--no-open' && seen.has(name)) {
      console.error(`repeated option "${arg}": ${name.slice(2)} is given once`);
      console.error(USAGE);
      return 2;
    }
    seen.add(name);
    // The value, whether given inline or as the next word that is not an
    // option; the exact form each flag refuses is named with the flag.
    const valueProblem = (label: string, value: string | undefined): string | undefined => {
      if (value === undefined) return `${label} needs a value: ${flags}`;
      const trimmed = value.trim();
      if (trimmed === '' || trimmed.startsWith('--')) return `${label} needs a value, not ${JSON.stringify(trimmed)}: ${flags}`;
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

    if (name === '--yes') {
      if (!spec.flags.yes) return unknownOption(arg, flags);
      if (arg.includes('=')) {
        console.error(`the --yes flag takes no value: it answers the prompt the command would ask`);
        console.error(USAGE);
        return 2;
      }
      parsed.yes = true;
      continue;
    }
    if (name === '--no-open') {
      if (!spec.flags.open) return unknownOption(arg, flags);
      if (arg.includes('=')) {
        console.error(`the --no-open flag takes no value: it says whether the browser is opened`);
        console.error(USAGE);
        return 2;
      }
      parsed.open = false;
      continue;
    }
    if (name === '--port') {
      if (!spec.flags.port) return unknownOption(arg, flags);
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
    const label = name;
    const value = flagValue();
    const problem = valueProblem(label, value);
    if (problem !== undefined) {
      console.error(problem);
      console.error(USAGE);
      return 2;
    }
    if (name === '--home') parsed.home = value!.trim();
    else if (name === '--product') parsed.product = value!.trim();
    else if (name === '--branch') parsed.branch = value!.trim();
    else if (name === '--source') parsed.source = value!;
    else if (name === '--mode') {
      const mode = value!.trim();
      if (mode !== 'link' && mode !== 'move' && mode !== 'clone') {
        console.error(`--mode ${JSON.stringify(mode)} is not a repository connection choice: choose link, move or clone`);
        console.error(USAGE);
        return 2;
      }
      parsed.mode = mode;
    }
  }
  // The words the surface promises, each taken once: a word the subcommand
  // needs and did not get is refused as plainly as one it did not expect.
  const givenWords = parsed.words.length;
  if (givenWords < spec.positionals.length) {
    const label = spec.positionals[givenWords]!;
    console.error(`the ${label} is missing: this subcommand takes ${spec.positionals.join(' ')}`);
    console.error(USAGE);
    return 2;
  }
  return parsed;
}

/** The refusal one not-accepted option earns: what was given, and what the subcommand takes. */
function unknownOption(arg: string, flags: string): number {
  console.error(`unknown option "${arg}": the options are ${flags}`);
  console.error(USAGE);
  return 2;
}

/** The list of the products home, printed one product at a time; 0 listed, 2 when the home cannot be used. */
function list(home: string | undefined): number {
  const listed: ProductList = listProducts(home === undefined ? {} : { home });
  if (listed.outcome === 'refused') {
    console.error(listed.message);
    return 2;
  }
  for (const [i, product] of listed.products.entries()) {
    if (i > 0) console.log('');
    console.log(`folder: ${product.folder}`);
    console.log(`id: ${product.id}`);
    console.log(`name: ${product.name}`);
  }
  // A manifest that stands but cannot be read is named where the reader
  // found it, and the list still says what it did read: hiding a broken
  // draft would say a folder is fine that nobody looked at.
  for (const unreadable of listed.unreadable) {
    console.error(`${unreadable.file}:${unreadable.line}: ${unreadable.message}`);
  }
  return 0;
}

/** The serving of one subcommand's product: its prints and its exit code; 0 once the address stands. */
async function serve(options: ServeOptions, productFolder: string | undefined): Promise<number> {
  const result = await serveWiki({ ...options, productFolder });
  if (result.outcome === 'serving') return 0;
  console.error(result.message);
  return result.outcome === 'refused' ? 2 : 1;
}

/** Prints one wrapper outcome the way every subcommand prints: facts whole on stdout, errors whole on stderr. */
function report(outcome: LifecycleOutcome): number {
  for (const fact of outcome.prints) console.log(fact);
  for (const error of outcome.errors) console.error(error);
  return outcome.exit;
}

/**
 * One `repo` line: the verb must be `add`, and the name and url words must
 * be there; anything else is refused naming what the subcommand takes.
 */
export function repoVerb(words: readonly string[]): { ok: true } | { ok: false; exit: number } {
  const verb = words[0];
  if (verb === undefined || verb !== 'add') {
    console.error(`the subcommand is "repo add": the verb is add, and this said ${JSON.stringify(verb ?? '')}`);
    console.error(USAGE);
    return { ok: false, exit: 2 };
  }
  return { ok: true };
}

/** The clone of one line: its url word and home, or its refusal. */
function runClone(parsed: Parsed): number {
  return report(cloneLife({ url: parsed.words[0], home: parsed.home, env: process.env }));
}

/** The command's one run: parse, then the subcommand's work. The exit code
 * is 0 done, 2 when an argument, a product folder, a manifest, a port
 * already in use or an app build cannot be used (each naming what is wrong,
 * on standard error, one message), 1 when a step of the work failed. The
 * wiki's address goes to standard output; serving keeps the process alive.
 */
export interface CliDeps {
  /** The app folder and build the serving is pointed at, over the process's environment. */
  app?: { appFolder?: string; buildCommand?: string; env?: Readonly<Record<string, string | undefined>> };
  /** The demo repository and home, injectable for local-repository tests. */
  demo?: DemoOptions;
  /** The upgrade's injected pieces: the releases API and its fetch, the yes, the replace target. */
  upgrade?: UpgradeOptions;
  /** The opener the serving uses, over the machine's own. */
  opener?: Opener;
  /** The interactive choice for an explicitly selected local checkout. */
  chooseRepoMode?: (source: string) => Promise<RepoConnectMode>;
}

export function repoModeFromAnswer(answer: string): RepoConnectMode | undefined {
  const choice = answer.trim().toLowerCase();
  if (choice === '' || choice === 'link') return 'link';
  if (choice === 'move' || choice === 'clone') return choice;
  return undefined;
}

async function askRepoMode(): Promise<RepoConnectMode> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = await prompt.question('Connect this checkout by link, move or clone? [link/move/clone] (link): ');
      const choice = repoModeFromAnswer(answer);
      if (choice !== undefined) return choice;
      console.error('choose link, move or clone');
    }
  } finally {
    prompt.close();
  }
}

export async function main(args: readonly string[], deps: CliDeps = {}): Promise<number> {
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) return versionCommand();
  if (args.length === 0) {
    console.error('no subcommand given: the subcommands are "new", "init", "demo", "serve", "list", "rename", "remote", "repo add", "bootstrap", "version" and "upgrade"');
    console.error(USAGE);
    return 2;
  }
  const command = args[0]!;
  if (command === '--help') {
    console.log(HELP);
    return 0;
  }
  if (command.startsWith('--')) {
    console.error(`unknown option "${command}" before the subcommand: the subcommands are "new", "init", "demo", "serve", "list", "rename", "remote", "repo add", "bootstrap", "version" and "upgrade"`);
    console.error(USAGE);
    return 2;
  }
  if (!(command in COMMANDS)) {
    console.error(`unknown subcommand "${command}": the subcommands are "new", "init", "demo", "serve", "list", "rename", "remote", "repo add", "bootstrap", "version" and "upgrade"`);
    console.error(USAGE);
    return 2;
  }

  const spec = COMMANDS[command]!;
  const parsed = parse(spec, args.slice(1));
  if (typeof parsed === 'number') return parsed;
  const { home, product, port, open } = parsed;

  if (command === 'list') return list(home);
  if (command === 'init') {
    const result = initLife({ cwd: process.cwd(), home });
    if (result.exit !== 0) return report(result);
    for (const fact of result.prints) console.log(fact);
    return await serve(serveOptions(parsed, deps), result.prints.find((line) => line.startsWith('folder: '))!.slice('folder: '.length));
  }
  if (command === 'version') return versionCommand();
  if (command === 'upgrade') {
    const result = await upgrade({ ...(deps.upgrade ?? {}), skipPrompt: parsed.yes });
    for (const fact of result.prints) console.log(fact);
    for (const error of result.errors) console.error(error);
    return result.exit;
  }
  if (command === 'repo') {
    const verb = repoVerb(parsed.words);
    if (!verb.ok) return verb.exit;
    const source = repoAddSource({ source: parsed.source, folder: parsed.product, cwd: process.cwd() });
    let mode = parsed.mode;
    if (source !== undefined && mode === undefined) {
      if (deps.chooseRepoMode !== undefined) mode = await deps.chooseRepoMode(source);
      else if (process.stdin.isTTY && process.stdout.isTTY) mode = await askRepoMode();
    }
    return report(lifecycleRepo(parsed, mode, source));
  }
  if (command === 'serve') {
    return await serve(serveOptions(parsed, deps), product);
  }
  if (command === 'demo') {
    const demo = prepareDemo({ ...(deps.demo ?? {}), home: home ?? deps.demo?.home, env: deps.demo?.env ?? process.env });
    if (!demo.ok) { console.error(demo.message); return 1; }
    console.log(`folder: ${demo.folder}`);
    return serve(serveOptions(parsed, deps), demo.folder);
  }
  if (command === 'clone') return runClone(parsed);

  // The lifecycle subcommands do not serve: their own outcomes decide.
  if (command !== 'new') return report(runWrapper(command, parsed));

  // new: the draft is created by madarch's own creation code (decision 0021), then its wiki is served.
  const draft = createDraft(home === undefined ? {} : { home });
  if (draft.outcome !== 'created') {
    console.error(draft.message);
    return draft.outcome === 'refused' ? 2 : 1;
  }
  console.log(`folder: ${draft.folder}`);
  console.log(`id: ${draft.id}`);
  return await serve(serveOptions(parsed, deps), draft.folder);
}

/** `madarch version`: one fact the release answers with (or `dev` in a checkout); 0, always. */
function versionCommand(): number {
  console.log(`madarch version ${runningVersion()}`);
  return 0;
}

/** The serve options one subcommand's flags parsed into. */
function serveOptions(parsed: Parsed, deps: CliDeps = {}): ServeOptions {
  return {
    port: parsed.port,
    open: parsed.open,
    appFolder: deps.app?.appFolder,
    buildCommand: deps.app?.buildCommand,
    env: deps.app?.env,
    opener: deps.opener,
  };
}

/** The wrapper work of the lifecycle subcommands (rename, remote, repo, bootstrap), chose by the word. */
function runWrapper(command: string, parsed: Parsed): LifecycleOutcome {
  if (command === 'rename') return renameLife({ name: parsed.words[0], folder: parsed.product, cwd: process.cwd() });
  if (command === 'remote') {
    return remoteLife({ url: parsed.words[0], folder: parsed.product, cwd: process.cwd() });
  }
  if (command === 'bootstrap') return bootstrapLife({ folder: parsed.product, cwd: process.cwd() });
  return lifecycleRepo(parsed);
}

/** The repo subcommand's work: the verb is decided first, whole and named. */
function lifecycleRepo(parsed: Parsed, mode: RepoConnectMode | undefined = parsed.mode, source?: string): LifecycleOutcome {
  const outcome = repoAddLife({
    name: parsed.words[1],
    url: parsed.words[2],
    ...(parsed.branch === undefined ? {} : { branch: parsed.branch }),
    ...(source === undefined ? {} : { source }),
    ...(mode === undefined ? {} : { mode }),
    folder: parsed.product,
    cwd: process.cwd(),
  });
  return outcome;
}
