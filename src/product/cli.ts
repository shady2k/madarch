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
import { installOwnWiki, ownWikiOff } from './own-wiki.js';
import { readPinnedGraphContract } from './fill-stages.js';
import { validateProductManifests } from '../graph/manifest-publication.js';
import { prepareDaemonProduct, withDaemonStorePreparation, publishStoreOwner, requestStorePreparation, withStorePreparationOwner } from './store-preparation.js';
import { selfCommand } from './self-command.js';
import { DEFAULT_STAGE_LIMITS } from '../fill/stage.js';
import { mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createDraft } from './draft.js';
import { STARTER_TEMPLATES, starterTemplateIds, starterTemplateOf, templateMenuLines } from '../knowledge/starter-templates.js';
import { prepareDemo, type DemoOptions } from './demo.js';
import { listProducts, type ProductList } from './list.js';
import { runningVersion } from './version.js';
import { startDaemon, stopDaemon, daemonStatus, serveDaemon, ensureDaemon, daemonUrl, daemonIsRunning } from './daemon.js';
import { API } from '../knowledge/addresses.js';
import { applyReset, type ResetPlan } from '../knowledge/reset.js';
import { knowledgeRootOf, productStoreFolder, storeDatabasePath } from '../product/store.js';
import { upgrade, type UpgradeOptions } from './upgrade.js';
import { serveWiki, machineOpener, type Opener, type ServeEnv, type ServeOptions } from '../product-wiki/serve.js';
import {
  cloneLife,
  initLife,
  bootstrapLife,
  remoteLife,
  renameLife,
  repoAddLife,
  repoAddSource,
  whereAmI,
  type LifecycleOutcome,
  type RepoConnectMode,
} from './lifecycle.js';
import { readProduct } from './manifest.js';
import { runGit } from './git.js';
import { runFill } from '../fill/run.js';
import { productsHome, type DraftEnv } from './home.js';
import { finishKnowledgeStore, startKnowledgeFill, type FinishedKnowledgeStore } from '../knowledge/fill-run.js';
import { readKinds } from './manifest/kinds.js';
import { readFillTargets } from '../knowledge/fill-targets.js';
import { createDatabaseOwner } from '../adapters/database-owner.js';
import { graphKindCounts } from '../graph/index.js';
import type { FillOrchestratorService, FillRunResult } from '../fill/orchestrator-host.js';
import { readTraceReport, renderTraceReport } from '../obs/trace-report.js';
import { byCodePoint } from '../model/order.js';

/** The compact command list shown after context-aware first-run guidance. */
const SHORT_HELP = [
  'madarch — start a product and open its wiki',
  '',
  'Start:',
  '  new       Create a product and serve its wiki',
  '  init      Create a product around this Git checkout',
  '',
  'Work with a product:',
  '  serve     Open a product wiki',
  '  list      List products',
  '  repo add  Connect a code repository',
  '  rename    Rename a product',
  '  remote    Set a product remote',
  '  clone     Clone a product',
  "  bootstrap Clone a product's code repositories",
  '  demo      Open the Madarch demo wiki',
  '  entity    Create, show, update, delete or list authored entities',
  '  fill      Fill this product wiki from its connected code repositories',
  '  fill-stages  Run the eight deterministic stages over this product',
  '',
  'Server:',
  '  start     Start one background server for every product',
  '  stop      Stop the background server',
  '  status    Show it: address, pid, uptime, products',
  '',
  'Tools:',
  "  mcp       Serve this checkout's graph to an agent over the Model Context Protocol",
  '  plugin    Check a plugin in the sandbox, or run it on a repository',
  '',
  'Other:',
  '  version   Show the version',
  '  upgrade   Upgrade madarch',
  '  reset     Start a product\'s knowledge over',
  '',
  'Run madarch <command> --help for details.',
].join('\n');

function commandHelp(command: string): string {
  const spec = COMMANDS[command];
  if (spec === undefined) return `madarch ${command} is a command group.\nUse madarch repo add --help for its command.`;
  if (command === 'fill') {
    // The fill's own usage: the probe is part of it, and it takes no agent of its own (the product's fill runs the
    // stages its workflow names; an agent's choice belongs to the wiki's wizard).
    return [
      'usage: madarch fill [--product <folder>] [--home <folder>] [--entity <kind>]... [--vertex <entity id>] [--workers <n>] [--json] [--probe-acp]',
      '',
      'Options:',
      '  --home <folder>       Products home',
      '  --product <folder>    Product folder',
      '  --entity <kind>       Fill this entity of the catalogue, the kinds it needs and the kinds that need it; repeat it',
      '  --vertex <entity id>  Rewrite only this one entity, such as doc.term:Fill',
      '  --workers <n>         Units the run holds in hand at once (16 by default)',
      '  --json                Print one object of machine-readable facts',
      '  --probe-acp           Report the agents on this machine that speak the Agent Client Protocol, and fill nothing',
      '',
      'Example: madarch fill --entity doc.term   (the glossary terms, with the files they read)',
    ].join('\n');
  }
  const positionals = command === 'repo' ? ' add <name> <url>' : spec.positionals.length === 0 ? '' : ` ${spec.positionals.map((word) => `<${word}>`).join(' ')}`;
  const flags: string[] = [];
  if (spec.flags.home) flags.push('  --home <folder>       Products home');
  if (spec.flags.product) flags.push('  --product <folder>    Product folder');
  if (spec.flags.port) {
    flags.push('  --port <n>            Wiki port (default 4180)');
    // The three commands that serve through the products home's one server
    // say whose port it is: the server was started on it, and a command that
    // names another is told so rather than served elsewhere.
    if (['new', 'init', 'start'].includes(command)) flags.push("                        the products home's server names the port it starts on; one it does not keep is reported, not ignored");
  }
  if (spec.flags.host) flags.push('  --host <address>      Wiki bind address (default 127.0.0.1)');
  if (spec.flags.open) flags.push('  --no-open             Do not open a browser');
  if (spec.flags.template) {
    flags.push(`  --template <id>       The starter template the product is made from: ${STARTER_TEMPLATES.map((template) => `${template.id} (${template.title.en})`).join(', ')}`);
    flags.push('                        Without it a terminal asks; a command with no terminal takes the first declared');
  }
  if (spec.flags.source) flags.push('  --source <path>       Local Git checkout to connect');
  if (spec.flags.mode) flags.push('  --mode <mode>         link, move or clone the checkout');
  if (spec.flags.branch) flags.push('  --branch <name>       Branch to clone');
  if (spec.flags.run) flags.push('  --run <id>            The run to plan (one built from this moment by default)');
  if (spec.flags.workers) flags.push('  --workers <n>         Units the run holds in hand at once (16 by default, 1 through 64)');
  if (spec.flags.yes) flags.push('  --yes                 Confirm without prompting');
  if (['new', 'init', 'list', 'fill', 'fill-stages'].includes(command)) flags.push('  --json                Print machine-readable facts');
  const usage = `madarch ${command}${positionals}${command === 'repo' ? ' [--source <path>] [--mode <link|move|clone>] [--branch <name>] [--product <folder>]' : ''}`;
  return [`usage: ${usage}`, '', ...(flags.length ? ['Options:', ...flags] : []), '', `Example: ${usage.split(' [')[0]}`].join('\n');
}

function whereHelp(): string {
  const context = whereAmI({ folder: process.cwd() });
  const home = process.env.MADARCH_HOME?.trim() || '~/madarch/products';
  if (context.outcome === 'product') {
    const product = readProduct(context.product);
    if (product.ok) return `This is the product ${product.product.name}. Open its wiki: madarch serve. Product documents are Markdown files in docs/; write them by hand or with any agent, or let an agent set them up with the shady2k-skills set.\nProducts live in ${home}.`;
  }
  if (context.outcome === 'none') {
    const git = runGit(process.cwd(), ['rev-parse', '--show-toplevel']);
    if (git.ok) return `This folder is a git repository. To start a product around it: madarch init\nProducts live in ${home}.`;
  }
  return `Start a new product: madarch new — or cd into your code repository and run madarch init\nProducts live in ${home}.`;
}



/** One subcommand's argument surface, whole: what it takes, and nothing else. */
interface CommandSpec {
  /** The positional words it takes, in order, by their label for the refusals. */
  positionals: readonly string[];
  /** The flags it takes, beside the ones they both share. */
  flags: { home: boolean; product: boolean; port: boolean; open: boolean; branch: boolean; yes: boolean; source?: boolean; mode?: boolean; host?: boolean; run?: boolean; workers?: boolean; steps?: boolean; store?: boolean; probe?: boolean; agent?: boolean; entity?: boolean; vertex?: boolean; template?: boolean };
}

/** The specs the subcommands answer to, whole. */
export const COMMANDS: Record<string, CommandSpec> = {
  start: { positionals: [], flags: { home: true, product: false, port: true, open: false, branch: false, yes: false } },
  stop: { positionals: [], flags: { home: true, product: false, port: false, open: false, branch: false, yes: false } },
  status: { positionals: [], flags: { home: true, product: false, port: false, open: false, branch: false, yes: false } },
  'daemon-serve': { positionals: [], flags: { home: true, product: false, port: true, open: false, branch: false, yes: false } },
  // The deterministic fill (decision 0026's stages 0 to 7, started by madarch-tzte.21.8): it runs
  // the eight stages over one product and prints what the graph holds afterwards. It serves nothing
  // and takes no agent, so it carries no port and no open.
  'fill-stages': { positionals: [], flags: { home: true, product: true, port: false, open: false, branch: false, yes: false, run: true, workers: true, steps: true } },
  // One product's knowledge store, filled by the one orchestrator (decision 0033, item 1): the same fill the
  // wiki's button starts, over the store the wiki reads. It serves nothing and takes no agent.
  fill: { positionals: [], flags: { home: true, product: true, port: false, open: false, branch: false, yes: false, workers: true, probe: true, agent: true, entity: true, vertex: true } },
  // Where the time went, read from a run's trace and nothing else (madarch-8bdc.2.5, item 2).
  trace: { positionals: [], flags: { home: true, product: false, port: false, open: false, branch: false, yes: false, store: true, run: true } },
  demo: { positionals: [], flags: { home: true, product: false, port: true, open: true, branch: false, yes: false, host: true } },
  init: { positionals: [], flags: { home: true, product: false, port: true, open: true, branch: false, yes: false, template: true } },
  new: { positionals: [], flags: { home: true, product: false, port: true, open: true, branch: false, yes: false, template: true } },
  serve: { positionals: [], flags: { home: false, product: true, port: true, open: true, branch: false, yes: false, host: true } },
  list: { positionals: [], flags: { home: true, product: false, port: false, open: false, branch: false, yes: false } },
  rename: { positionals: ['name'], flags: { home: false, product: true, port: false, open: false, branch: false, yes: false } },
  remote: { positionals: ['url'], flags: { home: false, product: true, port: false, open: false, branch: false, yes: false } },
  repo: { positionals: ['verb', 'name', 'url'], flags: { home: false, product: true, port: false, open: false, branch: true, yes: false, source: true, mode: true } },
  bootstrap: { positionals: [], flags: { home: false, product: true, port: false, open: false, branch: false, yes: false } },
  clone: { positionals: ['url'], flags: { home: true, product: false, port: false, open: false, branch: false, yes: false } },
  version: { positionals: [], flags: { home: false, product: false, port: false, open: false, branch: false, yes: false } },
  upgrade: { positionals: [], flags: { home: false, product: false, port: false, open: false, branch: false, yes: true } },
  reset: { positionals: ['product'], flags: { home: true, product: false, port: false, open: false, branch: false, yes: true } },
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
  host: string | undefined;
  run: string | undefined;
  workers: number | undefined;
  steps: readonly string[] | undefined;
  store: string | undefined;
  probe: boolean;
  agent: string | undefined;
  /** `--entity`, repeated: the kinds a selective fill was asked for (madarch-stm0.6). */
  entities?: readonly string[];
  /** `--vertex`: the one entity a vertex fill rewrites, as `<kind>:<key values>`. */
  vertex?: string;
  /** `--template`: the starter template `new` (and `init`) makes the product from. */
  template?: string;
  json: boolean;
}

/** The flags one subcommand takes, for the refusals to name them. */
function flagNamesFor(flags: CommandSpec['flags']): readonly string[] {
  return [
    ...(flags.home ? ['--home'] : []),
    ...(flags.product ? ['--product'] : []),
    ...(flags.port ? ['--port'] : []),
    ...(flags.host ? ['--host'] : []),
    ...(flags.open ? ['--no-open'] : []),
    ...(flags.branch ? ['--branch'] : []),
    ...(flags.source ? ['--source'] : []),
    ...(flags.mode ? ['--mode'] : []),
    ...(flags.run ? ['--run'] : []),
    ...(flags.workers ? ['--workers'] : []),
    ...(flags.steps ? ['--steps'] : []),
    ...(flags.store ? ['--store'] : []),
    ...(flags.probe ? ['--probe-acp'] : []),
    ...(flags.agent ? ['--agent'] : []),
    ...(flags.entity ? ['--entity'] : []),
    ...(flags.vertex ? ['--vertex'] : []),
    ...(flags.template ? ['--template'] : []),
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
  const parsed: Parsed = { words: [], home: undefined, product: undefined, port: undefined, open: true, branch: undefined, yes: false, source: undefined, mode: undefined, host: undefined, run: undefined, workers: undefined, steps: undefined, store: undefined, probe: false, agent: undefined, template: undefined, json: false };
  const seen = new Set<string>();
  const flags = flagNamesFor(spec.flags).map((name) => `${name}${name === '--no-open' ? '' : ' <value>'}`).join(', ');
  for (let i = 0; i < given.length; i++) {
    const arg = given[i]!;
    if (!arg.startsWith('--')) {
      // A positional word, taken in the order the spec names them; a word
      // beyond the surface is refused whole, never folded in.
      if (parsed.words.length >= spec.positionals.length) {
        console.error(`unexpected argument "${arg}": this subcommand takes ${spec.positionals.length === 0 ? 'no words' : spec.positionals.join(' ')}`);
        console.error('run madarch --help for help');
        return 2;
      }
      parsed.words = [...parsed.words, arg];
      continue;
    }
    const name = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (name === '--json' && !arg.includes('=')) { parsed.json = true; continue; }
    if (!flagNamesFor(spec.flags).includes(name)) {
      console.error(`unknown option "${arg}": the options are ${flags}`);
      console.error('run madarch --help for help');
      return 2;
    }
    // A value flag takes one value: a second occurrence would silently move
    // the first (a repeated --product can redirect the whole command), so it
    // is refused the way an unknown option is.
    // `--entity` is a list and is the one option a command may give more than once (madarch-stm0.6).
    if (name !== '--no-open' && name !== '--entity' && seen.has(name)) {
      console.error(`repeated option "${arg}": ${name.slice(2)} is given once`);
      console.error('run madarch --help for help');
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
        console.error('run madarch --help for help');
        return 2;
      }
      parsed.yes = true;
      continue;
    }
    if (name === '--probe-acp') {
      if (!spec.flags.probe) return unknownOption(arg, flags);
      if (arg.includes('=')) {
        console.error('the --probe-acp flag takes no value: it reports the agents on this machine');
        console.error('run madarch --help for help');
        return 2;
      }
      parsed.probe = true;
      continue;
    }
    if (name === '--no-open') {
      if (!spec.flags.open) return unknownOption(arg, flags);
      if (arg.includes('=')) {
        console.error(`the --no-open flag takes no value: it says whether the browser is opened`);
        console.error('run madarch --help for help');
        return 2;
      }
      parsed.open = false;
      continue;
    }
    if (name === '--host') {
      if (!spec.flags.host) return unknownOption(arg, flags);
      const value = flagValue();
      const problem = valueProblem('--host', value);
      if (problem !== undefined) { console.error(problem); console.error('run madarch --help for help'); return 2; }
      parsed.host = value!.trim();
      continue;
    }
    if (name === '--store') {
      if (!spec.flags.store) return unknownOption(arg, flags);
      const value = flagValue();
      const problem = valueProblem('--store', value);
      if (problem !== undefined) { console.error(problem); console.error('run madarch --help for help'); return 2; }
      parsed.store = value!.trim();
      continue;
    }
    if (name === '--workers') {
      if (!spec.flags.workers) return unknownOption(arg, flags);
      const value = flagValue();
      const n = value === undefined ? Number.NaN : Number(value);
      if (value === undefined || !Number.isInteger(n) || n < 1 || n > 64) {
        console.error(`--workers ${JSON.stringify(value ?? '')} is not a whole number from 1 through 64: the fill holds that many units in hand`);
        console.error('run madarch --help for help');
        return 2;
      }
      parsed.workers = n;
      continue;
    }
    if (name === '--run') {
      if (!spec.flags.run) return unknownOption(arg, flags);
      const value = flagValue();
      const problem = valueProblem('--run', value);
      if (problem !== undefined) { console.error(problem); console.error('run madarch --help for help'); return 2; }
      parsed.run = value!.trim();
      continue;
    }
    if (name === '--agent') {
      if (!spec.flags.agent) return unknownOption(arg, flags);
      const value = flagValue();
      const problem = valueProblem('--agent', value);
      if (problem !== undefined) { console.error(problem); console.error('run madarch --help for help'); return 2; }
      parsed.agent = value!.trim();
      continue;
    }
    if (name === '--entity') {
      if (!spec.flags.entity) return unknownOption(arg, flags);
      const value = flagValue();
      const problem = valueProblem('--entity', value);
      if (problem !== undefined) { console.error(problem); console.error('run madarch --help for help'); return 2; }
      const kinds = value!.split(',').map((kind) => kind.trim()).filter((kind) => kind !== '');
      if (kinds.length === 0) {
        console.error(`--entity ${JSON.stringify(value ?? '')} names no entity: it takes a kind the product's manifest declares, such as doc.term`);
        console.error('run madarch --help for help');
        return 2;
      }
      parsed.entities = [...(parsed.entities ?? []), ...kinds];
      continue;
    }
    if (name === '--vertex') {
      if (!spec.flags.vertex) return unknownOption(arg, flags);
      const value = flagValue();
      const problem = valueProblem('--vertex', value);
      if (problem !== undefined) { console.error(problem); console.error('run madarch --help for help'); return 2; }
      parsed.vertex = value!.trim();
      continue;
    }
    if (name === '--steps') {
      if (!spec.flags.steps) return unknownOption(arg, flags);
      const value = flagValue();
      const problem = valueProblem('--steps', value);
      if (problem !== undefined) { console.error(problem); console.error('run madarch --help for help'); return 2; }
      parsed.steps = value!.split(',').map((step) => step.trim()).filter((step) => step !== '');
      continue;
    }
    if (name === '--port') {
      if (!spec.flags.port) return unknownOption(arg, flags);
      const value = flagValue();
      const n = value === undefined ? Number.NaN : Number(value);
      if (value === undefined || !Number.isInteger(n) || n < 0 || n > 65535) {
        console.error(`--port ${JSON.stringify(value ?? '')} is not a whole port number between 0 and 65535: the address is served at that port`);
        console.error('run madarch --help for help');
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
      console.error('run madarch --help for help');
      return 2;
    }
    if (name === '--home') parsed.home = value!.trim();
    else if (name === '--template') {
      const id = value!.trim();
      if (starterTemplateOf(id) === undefined) {
        console.error(`--template ${JSON.stringify(id)} is not a starter template: choose ${starterTemplateIds().join(', ')}`);
        console.error('run madarch --help for help');
        return 2;
      }
      parsed.template = id;
    }
    else if (name === '--product') parsed.product = value!.trim();
    else if (name === '--branch') parsed.branch = value!.trim();
    else if (name === '--source') parsed.source = value!;
    else if (name === '--mode') {
      const mode = value!.trim();
      if (mode !== 'link' && mode !== 'move' && mode !== 'clone') {
        console.error(`--mode ${JSON.stringify(mode)} is not a repository connection choice: choose link, move or clone`);
        console.error('run madarch --help for help');
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
    console.error('run madarch --help for help');
    return 2;
  }
  return parsed;
}

/** The refusal one not-accepted option earns: what was given, and what the subcommand takes. */
function unknownOption(arg: string, flags: string): number {
  console.error(`unknown option "${arg}": the options are ${flags}`);
  console.error('run madarch --help for help');
  return 2;
}

/** The list of the products home, printed one product at a time; 0 listed, 2 when the home cannot be used. */
function list(home: string | undefined, json = false): number {
  const listed: ProductList = listProducts(home === undefined ? {} : { home });
  if (listed.outcome === 'refused') {
    console.error(listed.message);
    return 2;
  }
  if (json) console.log(JSON.stringify({ products: listed.products.map(({ folder, id, name }) => ({ folder, id, name })) }));
  else if (listed.products.length === 0) console.log(`No products found in the products home. Start one with: madarch new`);
  else {
    console.log('Products:');
    for (const product of listed.products) console.log(`  • ${product.name} (${product.id}) — ${displayPath(product.folder)} (open with: cd ${displayPath(product.folder)} && madarch serve)`);
  }
  for (const unreadable of listed.unreadable) console.error(`${unreadable.file}:${unreadable.line}: ${unreadable.message}`);
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
function report(outcome: LifecycleOutcome, _json = false): number {
  for (const fact of outcome.prints) console.log(fact);
  for (const error of outcome.errors) console.error(error);
  return outcome.exit;
}

/**
 * One `repo` line: the verb must be `add`, and the name and url words must
 * be there; anything else is refused naming what the subcommand takes.
 */
function repoVerb(words: readonly string[]): { ok: true } | { ok: false; exit: number } {
  const verb = words[0];
  if (verb === undefined || verb !== 'add') {
    console.error(`the subcommand is "repo add": the verb is add, and this said ${JSON.stringify(verb ?? '')}`);
    console.error('run madarch --help for help');
    return { ok: false, exit: 2 };
  }
  return { ok: true };
}

/** The clone of one line: its url word and home, or its refusal. */
function runClone(parsed: Parsed): number {
  return report(cloneLife({ url: parsed.words[0], home: parsed.home, env: process.env }), parsed.json);
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

/**
 * The manifests guide a product with no starter set needs (docs/guides/how-to-write-a-product-s-manifests.md): the
 * same address the wiki's no-manifest page links to, kept on the repository the release is published from.
 */
const MANIFESTS_GUIDE = 'https://github.com/shady2k/madarch/blob/main/docs/guides/how-to-write-a-product-s-manifests.md';

/**
 * The template the command makes the product from: `--template` when given, else the menu a terminal gets, else the
 * first declared template with `defaulted` set — a script that runs `madarch new` gets a product, and the command says
 * which template it used and how to pick another. The note is the caller's to print, after the product was made and
 * never into a `--json` line.
 */
async function templateChoice(parsed: Parsed): Promise<{ id: string; defaulted: boolean }> {
  if (parsed.template !== undefined) return { id: parsed.template, defaulted: false };
  if (process.stdin.isTTY && process.stdout.isTTY) return { id: await askTemplate(), defaulted: false };
  return { id: STARTER_TEMPLATES[0]!.id, defaulted: true };
}

/** The line that says a command with no terminal took the first declared template, and how another is chosen. */
function defaultTemplateNote(id: string): string {
  const template = starterTemplateOf(id);
  return `✓ No terminal asks which template to use: using "${template?.title.en ?? id}", the first declared. Pass --template <id> to choose another (${starterTemplateIds().join(', ')}).`;
}

/** The template menu of a terminal: every declared template, in their declared order, and the first one by default. */
async function askTemplate(): Promise<string> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('Which template should the product start from?');
    for (const line of templateMenuLines()) console.log(line);
    while (true) {
      const answer = (await prompt.question(`Choose 1-${STARTER_TEMPLATES.length} (1): `)).trim();
      if (answer === '') return STARTER_TEMPLATES[0]!.id;
      const index = Number(answer);
      if (Number.isInteger(index) && index >= 1 && index <= STARTER_TEMPLATES.length) return STARTER_TEMPLATES[index - 1]!.id;
      console.error(`choose a number from 1 to ${STARTER_TEMPLATES.length}`);
    }
  } finally {
    prompt.close();
  }
}

/** What the product was made from, in the words the newcomer bar uses: the template, its kinds, and where the guide is. */
function printTemplate(templateId: string, kinds: number): void {
  const template = starterTemplateOf(templateId);
  if (template === undefined) return;
  console.log(kinds === 0
    ? `✓ Template "${template.title.en}": no manifest was copied; write madarch/kinds.yaml to give the wiki its kinds (${MANIFESTS_GUIDE})`
    : `✓ Template "${template.title.en}": ${String(kinds)} kinds in madarch/kinds.yaml, with the page templates and plugins those kinds use`);
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
  if (['serve', 'daemon-serve', 'demo', 'fill', 'fill-stages'].includes(args[0] ?? '') && !args.includes('--help') && !args.includes('-h') && !args.includes('--probe-acp') && !args.includes('--role') && process.env.MADARCH_ROLE !== 'api' && process.env.MADARCH_ROLE !== 'fill' && process.env.MADARCH_STORE_OWNER_URL === undefined) {
    const homeAt = args.indexOf('--home');
    const fillHome = productHomeOf(homeAt === -1 ? args.find((arg) => arg.startsWith('--home='))?.slice('--home='.length) : args[homeAt + 1]);
    if ((args[0] === 'fill' || args[0] === 'fill-stages') && daemonIsRunning({ home: fillHome })) {
      return await withDaemonStorePreparation(fillHome, async () => await main(args, deps));
    }
    return await withStorePreparationOwner(async () => {
      if (args[0] === 'serve' || args[0] === 'daemon-serve' || args[0] === 'demo') {
        const named = (flag: string): string | undefined => { const at = args.indexOf(flag); return at === -1 ? args.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1) : args[at + 1]; };
        const home = productHomeOf(named('--home'));
        const demo = args[0] === 'demo' ? prepareDemo({ ...(deps.demo ?? {}), home, env: deps.demo?.env ?? process.env }) : undefined;
        if (demo !== undefined && !demo.ok) { console.error(demo.message); return 1; }
        const servingArgs = demo?.ok ? ['serve', '--product', demo.folder, ...args.slice(1)] : args;
        const folders = args[0] === 'daemon-serve'
          ? (() => { const listed = listProducts({ home }); return listed.outcome === 'listed' ? listed.products.map((product) => product.folder) : []; })()
          : [demo?.ok ? demo.folder : resolve(named('--product') ?? process.cwd())];
        const own = args[0] === 'daemon-serve' && !ownWikiOff() ? installOwnWiki({ env: process.env }) : undefined;
        if (own !== undefined && !own.ok) { console.error(own.message); return 1; }
        if (own?.ok) folders.push(own.folder);
        for (const folder of folders) {
          const read = readProduct(folder);
          // A manifestless folder has no graph-backed product to activate.
          if (!read.ok) {
            if (args[0] !== 'daemon-serve') continue;
            throw new Error(`${read.file}:${read.line}: ${read.message}`);
          }
          const manifests = validateProductManifests(folder);
          if (!manifests.ok) throw new Error(manifests.findings.map((finding) => `${finding.file}:${finding.line}: ${finding.message}`).join('\n'));
        }
        const unpublish = args[0] === 'daemon-serve' ? publishStoreOwner(home) : undefined;
        const { command, args: childArgs } = selfCommand(['--role', 'api', ...servingArgs]);
        const child = Bun.spawn([command, ...childArgs], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', env: { ...process.env, MADARCH_API_PARENT: String(process.pid) } });
        const stop = (): void => { child.kill('SIGTERM'); };
        process.once('SIGTERM', stop); process.once('SIGINT', stop);
        try { return await child.exited; }
        finally { process.off('SIGTERM', stop); process.off('SIGINT', stop); unpublish?.(); }
      }
      return await main(args, deps);
    });
  }

  // The MCP server is a program of its own that happens to be reached through this command: it reads its own flags
  // (`--repo`, `--store`, `--journal`) and must start even in a folder that is no product, so it is dispatched before
  // the command table is consulted.
  if (args[0] === 'entity') {
    const { entityCommand } = await import('./entity-cli.js');
    return await entityCommand(args.slice(1));
  }
  if (args[0] === 'mcp') {
    const { mcpCommand } = await import('../mcp/cli.js');
    return await mcpCommand(args.slice(1));
  }
  // `madarch plugin check|run` (decision 0035, item 8) is a command group of its own, parsed by its module: the
  // conformance kit and the local runner are the host's production callers, and neither takes a product.
  if (args[0] === 'plugin') {
    const { pluginCommand } = await import('../plugin/cli.js');
    return await pluginCommand(args.slice(1));
  }
  // The role of this process (madarch-8bdc.9): `--role fill` runs the fill role and nothing else, and `--role api` is the
  // api role alone — the server that answers pages and presses, which reads the store and never fills it.
  const roleAt = args.indexOf('--role');
  if (roleAt !== -1) {
    const role = args[roleAt + 1];
    const rest = args.filter((_, index) => index !== roleAt && index !== roleAt + 1);
    if (role === 'fill') { process.env.MADARCH_ROLE = 'fill'; return await fillRoleCommand(rest); }
    if (role === 'api') {
      // The api role is every command as it stands, with this process's own role named in the environment: the server
      // reads it and starts no fill process of its own.
      process.env.MADARCH_ROLE = 'api';
      const parent = Number(process.env.MADARCH_API_PARENT ?? '0');
      const watching = parent > 1 ? setInterval(() => {
        try { process.kill(parent, 0); } catch { process.kill(process.pid, 'SIGTERM'); }
      }, 50) : undefined;
      watching?.unref();
      try { return await main(rest, deps); }
      finally { if (watching !== undefined) clearInterval(watching); }
    }
    console.error(`unknown role "${role ?? ''}": the roles are "api" (serves the pages and the press) and "fill" (runs the fills the press asks for)`);
    return 2;
  }
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) return versionCommand();
  if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    console.log(args.length === 0 ? `${whereHelp()}\n\n${SHORT_HELP}` : SHORT_HELP);
    return 0;
  }
  const command = args[0]!;
  if (command === 'repo' && args[1] === 'add' && (args[2] === '--help' || args[2] === '-h') && args.length === 3) {
    console.log(commandHelp('repo'));
    return 0;
  }
  if ((args[1] === '--help' || args[1] === '-h') && args.length === 2 && command in COMMANDS) {
    console.log(commandHelp(command));
    return 0;
  }
  if (command.startsWith('--')) {
    console.error(`unknown option "${command}" before the subcommand: the subcommands are "new", "init", "demo", "serve", "start", "stop", "status", "list", "rename", "remote", "repo add", "bootstrap", "clone", "fill", "fill-stages", "trace", "plugin", "version" and "upgrade"`);
    console.error('run madarch --help for help');
    return 2;
  }
  if (!(command in COMMANDS)) {
    console.error(`unknown subcommand "${command}": the subcommands are "new", "init", "demo", "serve", "start", "stop", "status", "list", "rename", "remote", "repo add", "bootstrap", "clone", "fill", "fill-stages", "trace", "plugin", "version" and "upgrade"`);
    console.error('run madarch --help for help');
    return 2;
  }

  const spec = COMMANDS[command]!;
  if (args.slice(1).includes('--json') && !['new', 'init', 'list', 'fill', 'fill-stages'].includes(command)) {
    console.error(`unknown option "--json" for ${command}: machine-readable output is not supported by this command`);
    console.error('run madarch --help for help');
    return 2;
  }
  const parsed = parse(spec, args.slice(1));
  if (typeof parsed === 'number') return parsed;
  const { home, product, port } = parsed;

  if (command === 'list') return list(home, parsed.json);
  if (command === 'start') return await startDaemon({ home, port });
  if (command === 'stop') return stopDaemon({ home });
  if (command === 'status') return daemonStatus({ home });
  if (command === 'daemon-serve') return await serveDaemon({ home, port: port ?? 4180 });
/** The fill role: this process takes the fills pressed for the products of the home and runs them (madarch-8bdc.9). */
async function fillRoleCommand(rest: readonly string[]): Promise<number> {
  // Only `--home`: the fill role reads no product, serves no port and opens no page — it takes the jobs a server asked for.
  const parsed = parse({ positionals: [], flags: { home: true, product: false, port: false, open: false, branch: false, yes: false } }, rest);
  if (typeof parsed === 'number') return parsed;
  const { runFillRole } = await import('../knowledge/fill-role.js');
  // The fill role watches the products home a server serves; `--home` names another one, as every other command does, and
  // the server that started it names the knowledge root it serves (a test run keeps it outside the home).
  const home = productHomeOf(parsed.home);
  const root = process.env['MADARCH_KNOWLEDGE_ROOT']?.trim();
  // A fill role a server started ends with the server that started it: an orphan would work a store nothing serves.
  const parent = Number(process.env['MADARCH_FILL_PARENT'] ?? '0');
  return await runFillRole({
    knowledgeRoot: root === undefined || root === '' ? knowledgeRootOf(home) : root,
    ...(Number.isInteger(parent) && parent > 1 ? { parentPid: parent } : {}),
    // The process that owns the binary opens the stores it works: the role itself holds no connection (decision 0033, 3).
    openStore: async (databaseFolder) => await createDatabaseOwner({ store: databaseFolder, connectOnly: true }),
  });
}

/** The products home this process serves: `--home`, else `MADARCH_HOME`, else the account's own. */
function productHomeOf(named: string | undefined): string {
  return named !== undefined && named !== '' ? resolve(named) : productsHome(process.env);
}

  if (command === 'fill') return await fillCommand(parsed, home);
  if (command === 'trace') return traceCommand(parsed, home);
  if (command === 'fill-stages') return await fillStagesCommand(parsed, home);
  if (command === 'init') {
    const choice = await templateChoice(parsed);
    const template = choice.id;
    const result = initLife({ cwd: process.cwd(), home, template });
    if (result.exit !== 0) return report(result);
    const folder = result.prints.find((line) => line.startsWith('folder: '))!.slice('folder: '.length);
    const source = result.prints.find((line) => line.startsWith('source: '))?.slice('source: '.length);
    const facts = Object.fromEntries(result.prints.map((line) => { const at = line.indexOf(': '); return at < 0 ? [line, true] : [line.slice(0, at), line.slice(at + 2)]; }));
    if (!parsed.json) {
      if (choice.defaulted) console.log(defaultTemplateNote(template));
      console.log(`✓ Created the product "${basename(folder)}" in ${displayPath(folder)}`);
      printTemplate(String(facts['template'] ?? template), Number(facts['kinds'] ?? 0));
      if (source !== undefined) console.log(`✓ Connected your repository ${displayPath(source)} (it stays where it is)`);
      else if (result.prints.some((line) => line.startsWith('already linked to product: '))) console.log(`✓ Connected your repository ${displayPath(process.cwd())} (it stays where it is)`);
    }
    return await serveShared(parsed, deps, folder, true, parsed.json ? { folder, ...facts, ...(choice.defaulted ? { templateNote: defaultTemplateNote(template) } : {}) } : undefined);
  }
  if (command === 'reset') return await resetCommand(parsed.words[0], home, parsed.yes);
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
    return report(lifecycleRepo(parsed, mode, source), parsed.json);
  }
  if (command === 'serve') {
    return await serve(serveOptions(parsed, deps), product);
  }
  if (command === 'demo') {
    const demo = prepareDemo({ ...(deps.demo ?? {}), home: home ?? deps.demo?.home, env: deps.demo?.env ?? process.env });
    if (!demo.ok) { console.error(demo.message); return 1; }
    console.log(`✓ Opened the Madarch demo product in ${displayPath(demo.folder)}`);
    return serve(serveOptions(parsed, deps), demo.folder);
  }
  if (command === 'clone') return runClone(parsed);

  // The lifecycle subcommands do not serve: their own outcomes decide.
  if (command !== 'new') return report(runWrapper(command, parsed), parsed.json);

  // new: the draft is created by madarch's own creation code (decision 0021), then its wiki is served.
  const choice = await templateChoice(parsed);
  const template = choice.id;
  const draft = createDraft({ ...(home === undefined ? {} : { home }), template });
  if (draft.outcome !== 'created') {
    console.error(draft.message);
    return draft.outcome === 'refused' ? 2 : 1;
  }
  if (!parsed.json) {
    if (choice.defaulted) console.log(defaultTemplateNote(template));
    console.log(`✓ Created the product "${draft.name}" in ${displayPath(draft.folder)}`);
    printTemplate(draft.template, draft.kinds);
  }
  return await serveShared(parsed, deps, draft.folder, false, parsed.json ? { folder: draft.folder, id: draft.id, name: draft.name, template: draft.template, kinds: draft.kinds, ...(choice.defaulted ? { templateNote: defaultTemplateNote(template) } : {}) } : undefined);
}

/**
 * `madarch fill-stages`: the deterministic fill of one product (decision 0026's
 * stages 0 to 7; madarch-tzte.21.8). It pins the product's repositories, runs
 * the eight stages through the orchestrator the process owns (decision 0027),
 * and prints what the run did — the units it planned, which of them it executed
 * and which it inherited from an earlier run — and the facts the graph holds
 * afterwards, by kind. No agent is involved and no page is written: the stages
 * write graph facts, and the pages come later (the agent stages of 0026).
 *
 * The run's own id is named by `--run`, or one built from this moment's clock so
 * two runs of one commit are two runs. The command stops the queue and closes
 * the database it opened before it returns, whether the run succeeded or not.
 */
async function fillStagesCommand(parsed: Parsed, home: string | undefined): Promise<number> {
  const folder = resolve(parsed.product ?? process.cwd());
  const resolvedHome = resolve(productsHome(process.env as DraftEnv, home));
  // The one store of this product, resolved by the function the button, `madarch fill`, the daemon and
  // `madarch mcp` use: a command-line fill writes what the wiki and the MCP server read.
  let storeFolder: string;
  try {
    storeFolder = productStoreFolder(folder, knowledgeRootOf(resolvedHome));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  // The milliseconds are kept: two runs asked for inside one second are two
  // runs, and a run id that already stands is one this command may not plan.
  const runId = parsed.run ?? `stages-${new Date().toISOString().replace(/[-:.]/gu, '').replace(/Z$/u, 'Z')}`;
  // A store's cluster stands under its data directory, and the product's store may not stand yet (the host
  // would make it; this command opens the owner itself).
  const databasePath = storeDatabasePath(storeFolder);
  await mkdir(dirname(databasePath), { recursive: true });
  const workers = parsed.workers ?? 16;
  await requestStorePreparation(databasePath, await readPinnedGraphContract(folder));
  const owner = await createDatabaseOwner({ store: databasePath, connectOnly: true });
  let service: FillOrchestratorService | undefined;
  let exit = 0;
  try {
    const product = { name: basename(folder), folder };
    // The deterministic stages' units are short and a pass is not free: the run
    // holds sixteen in hand and claims sixteen per pass (`workers`), which is
    // what makes a repository of a few thousand files minutes rather than hours
    // (the walk measured one unit and 26.8 s of a 27.6 s unit in the admission of
    // a single-slot run, and 1.7-3.4 s per read of the run's unit list). The
    // stages' own concurrency (one unit each) still bounds what runs at once.
    const started = Date.now();
    // One fill, through the one runner (madarch-8bdc.2.5, item 6): the steps the caller named, or
    // the whole one list in the order the stages' declarations derive.
    const result = await runFill({
      product: folder, database: owner, runId, home: storeFolder, store: storeFolder,
      prepareContract: async (contract) => await requestStorePreparation(databasePath, contract),
      limits: { maxInFlight: workers }, workers, maxPasses: 100_000,
      ...(parsed.steps === undefined ? {} : { steps: parsed.steps }),
      onService: (started) => { service = started; },
    });
    if (!result.ok) {
      console.error(`${result.code}: ${result.reason}`);
      exit = 1;
    } else {
      // The store is finished the way the button finishes it: the pins the run published. A run that did not succeed
      // writes none.
      const finished = result.settled && result.state === 'succeeded'
        ? await finishKnowledgeStore(owner)
        : undefined;
      reportFillStages(product, storeFolder, result, Object.fromEntries((await graphKindCounts(owner)).map((entry) => [entry.kind, entry.count])), finished, Date.now() - started, parsed.json);
      // A run that did not settle, or settled without its coverage, is not a
      // fill a caller may treat as done: the exit code says so, and the line
      // names what the run ended as.
      if (!result.settled || result.state !== 'succeeded') {
        console.error(`the fill run ${result.runId} ended ${result.settled ? result.state : 'without settling'}${result.settled ? '' : ` (${result.stoppedBecause ?? 'the driver stopped for an unnamed reason'})`}: a run that does not settle leaves the units it planned unworked`);
        exit = 1;
      }
    }
  } catch (error) {
    console.error((error as Error).message);
    exit = 1;
  } finally {
    try { await service?.stop(); } catch (error) { console.error(`the fill's queue could not be stopped: ${(error as Error).message}`); }
    try { await owner.close(); } catch (error) { console.error(`the fill's database could not be closed: ${(error as Error).message}`); }
  }
  return exit;
}

/**
 * `madarch trace`: where one run's time went, read from its trace and nothing
 * else (madarch-8bdc.2.5, item 2). `--run` names the run, `--store` the store
 * whose traces are read; without either the current folder's product store is
 * read, which is the one store its fill writes.
 */
function traceCommand(parsed: Parsed, home: string | undefined): number {
  const resolvedHome = resolve(productsHome(process.env as DraftEnv, home));
  let store: string;
  if (parsed.store !== undefined) {
    store = resolve(parsed.store);
  } else {
    try {
      store = productStoreFolder(process.cwd(), knowledgeRootOf(resolvedHome));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  try {
    const report = readTraceReport({ store, ...(parsed.run === undefined ? {} : { runId: parsed.run }) });
    process.stdout.write(renderTraceReport(report));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/** One run's facts, one per line: the store it wrote, the run, its units, the stages that found nothing, and the facts by kind. */
function reportFillStages(product: { readonly name: string; readonly folder: string }, storeFolder: string, result: FillRunResult, counts: Readonly<Record<string, number>>, finished: FinishedKnowledgeStore | undefined, elapsedMs: number, json: boolean): void {
  const inherited = new Set(result.reused);
  const units = [...result.units].sort((left, right) => byCodePoint(left.unitId, right.unitId));
  const executed = units.filter((unit) => !inherited.has(unit.unitId));
  if (json) {
    console.log(JSON.stringify({ product, store: storeFolder, runId: result.runId, state: result.state, settled: result.settled, passes: result.passes, work: result.work, stoppedBecause: result.stoppedBecause, retryWaitMs: result.retryWaitMs, units, inherited: [...inherited].sort(byCodePoint), foundNothing: [...result.foundNothing].sort(byCodePoint), counts, elapsedMs }));
    return;
  }
  console.log(`Fill ${result.runId}: ${result.state}${result.settled ? '' : ', not settled'}${result.stoppedBecause === undefined ? '' : ` (${result.stoppedBecause})`}`);
  console.log(`Product: ${product.name} in ${displayPath(product.folder)}`);
  console.log(`Store: ${displayPath(storeFolder)}${finished === undefined ? ' (the run did not succeed: its pins were not written)' : ''}`);
  console.log(`Units: ${String(units.length)} in the run, ${String(executed.length)} executed and ${String(inherited.size)} inherited`);
  for (const unit of units) console.log(`${unit.unitId}\t${unit.state}\tgeneration ${String(unit.generation)}\t${inherited.has(unit.unitId) ? 'inherited' : 'executed'}`);
  if (result.foundNothing.length > 0) console.log(`Stages that read their inputs and found nothing: ${[...result.foundNothing].sort(byCodePoint).join(', ')}`);
  console.log(`Facts by kind: ${Object.keys(counts).length === 0 ? 'none' : ''}`);
  for (const kind of Object.keys(counts).sort(byCodePoint)) console.log(`${kind}\t${String(counts[kind])}`);
  console.log(`Time: ${String(Math.round(elapsedMs / 100) / 10)}s in ${String(result.passes)} passes, ${String(Math.round(result.retryWaitMs / 100) / 10)}s waiting for the run's own retries`);
}

/**
 * `madarch fill`: start or resume the local fill, or report which agents speak
 * ACP on this machine (`--probe-acp`, decision 0026: the fill drives agents
 * over the Agent Client Protocol). The probe sends no prompt and installs
 * nothing: it stops at the initialize handshake, and names what a missing
 * adapter would be installed with.
 */
/**
 * `madarch fill`: one product's knowledge store, filled by the one orchestrator (decision 0033, item 1). It is the
 * same fill the wiki's button starts — the static stages the product's `madarch/workflows.yaml` names, over the store
 * the wiki reads (`<home>/.madarch/knowledge/<product id>`) — and it writes no page: a page is an agent's work and a
 * later stage's. `--probe-acp` reports the agents this machine speaks to, and fills nothing.
 */
async function fillCommand(parsed: Parsed, home: string | undefined): Promise<number> {
  const probe = parsed.probe;
  const json = parsed.json === true;
  // A probe reports what this machine can connect and fills nothing: an agent named beside it has nothing to drive.
  if (probe && parsed.agent !== undefined) {
    console.error('--probe-acp reports the agents on this machine and fills nothing: drop --agent');
    return 2;
  }
  if (parsed.agent !== undefined) {
    console.error(`--agent is no option of madarch fill: a product's fill runs the stages its workflow names, and an agent is chosen in its wiki (${FILL_USAGE})`);
    return 2;
  }
  if (probe) {
    try {
      // The ACP client and its protocol library are loaded only here: every other command starts without them.
      const acp = await import('../fill/acp-probe.js');
      const report = await acp.probeAcpAgents({ cwd: process.cwd() });
      console.log(json ? JSON.stringify(report) : acp.formatAcpProbe(report));
      return 0;
    } catch (error) { console.error((error as Error).message); return 1; }
  }
  const folder = resolve(parsed.product ?? process.cwd());
  const identity = readProduct(folder);
  if (!identity.ok) { console.error(`${identity.file}:${identity.line}: ${identity.message}`); return 1; }
  const resolvedHome = resolve(productsHome(process.env as DraftEnv, home));
  const storeFolder = productStoreFolder(folder, knowledgeRootOf(resolvedHome));
  const runId = `fill-${new Date().toISOString().replace(/[-:.]/gu, '').replace(/Z$/u, 'Z')}`;
  // A selective fill (madarch-stm0.6, decision 0035 items 11 and 31): the entities the person named, the kinds they need
  // and the kinds that need them, in the dependency order the manifest declares. The command names what the request
  // added before the run starts, so a press that fills more than it was asked for says so.
  let targets: { kinds: readonly string[]; vertex?: string } | undefined;
  if (parsed.entities !== undefined || parsed.vertex !== undefined) {
    const kinds = readKinds(folder);
    if (!kinds.present) { console.error(`${kinds.file}:1: the product ${displayPath(folder)} has no manifest, so it declares no entity to fill: madarch new writes one`); return 1; }
    const read = readFillTargets(kinds.manifest, { ...(parsed.entities === undefined ? {} : { entities: parsed.entities }), ...(parsed.vertex === undefined ? {} : { vertex: parsed.vertex }) });
    if (!read.ok) { console.error(read.message); return 1; }
    for (const entry of read.targets.entries) {
      if (entry.reason === 'dependency') console.log(`Also filling ${entry.kind}, needed by ${entry.namedBy}.`);
      if (entry.reason === 'dependant') console.log(`Also filling ${entry.kind}, which depends on ${entry.namedBy}.`);
    }
    console.log(read.targets.vertex === undefined
      ? `Filling in dependency order: ${read.targets.order.join(', ')}.`
      : `Rewriting only ${read.targets.vertex}, and nothing else.`);
    targets = { kinds: read.targets.order, ...(read.targets.vertex === undefined ? {} : { vertex: read.targets.vertex }) };
  }
  let run;
  try {
    await requestStorePreparation(storeDatabasePath(storeFolder), await readPinnedGraphContract(folder));
    run = await startKnowledgeFill({ productFolder: folder, storeFolder, runId, prepareContract: async (contract) => await requestStorePreparation(storeDatabasePath(storeFolder), contract), database: await createDatabaseOwner({ store: storeDatabasePath(storeFolder), connectOnly: true }), ...(targets === undefined ? {} : { targets }), ...(parsed.workers === undefined ? {} : { workers: parsed.workers }) });
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
  const result = await run.done;
  if (json) {
    console.log(JSON.stringify({ product: { name: identity.product.name, folder }, runId, ...result }));
    return result.ok ? 0 : 1;
  }
  // A press the product refused never started a run: saying "failed" there would read as a broken product, and the words
  // after it say what is true (madarch-8bdc.2.18).
  console.log(`Fill ${runId}: ${result.ok ? result.state : result.refused === true ? 'not started' : 'failed'}`);
  console.log(`Product: ${identity.product.name} in ${displayPath(folder)}`);
  console.log(`Store: ${displayPath(storeFolder)}`);
  console.log(`Units: ${String(result.units)}`);
  if (!result.ok) { if (result.message !== undefined) console.error(result.message); return 1; }
  console.log('Watch the pages with: madarch serve');
  return 0;
}

const FILL_USAGE = 'usage: madarch fill [--product <folder>] [--home <folder>] [--entity <kind>]... [--vertex <entity id>] [--workers <n>] [--json] [--probe-acp]';

function displayPath(folder: string): string {
  const home = process.env.HOME;
  return home && folder.startsWith(`${home}/`) ? `~/${folder.slice(home.length + 1)}` : folder;
}

/** The next steps one reader follows after the product's wiki is up. */
function nextSteps(folder: string, init: boolean): void {
  const shown = displayPath(folder);
  console.log('');
  console.log('Next:');
  if (init) {
    console.log('  1. Open the wiki address above. The wiki is empty and says so.');
    console.log('  2. Choose the agent that writes the pages (Claude Code or Codex; madarch installs its adapter if you say yes), then press "Start the fill".');
    console.log('     The fill reads your repository, then the agent writes the product page and one page per domain; each page appears in the wiki as it is written.');
    console.log(`     No agent runs until you press, and each agent unit is bound by ${DEFAULT_STAGE_LIMITS.maxTurns} turns and ${Math.round(DEFAULT_STAGE_LIMITS.maxDurationMs / 60_000)} minutes.`);
    console.log(`  3. The pages are Markdown files in ${shown}/docs/, and they are yours to commit. Your code stays where it is.`);
  } else {
    console.log(`  • The wiki opens on the page that says the product is created and nothing is read yet: press Fill there to read the product repository into the graph. Nothing is read or written until you press.`);
    console.log(`  • Product documents are Markdown files in ${shown}/docs/. Write them by hand or with any agent; or let an agent set them up with the shady2k-skills set, then Fill again.`);
    console.log('  • To read code too, connect a code repository (madarch repo add <name> <url>) before the fill; the pages appear as the fill reads them.');
  }
  console.log('  • The wiki keeps running in the background: open the address again any time; madarch stop ends it.');
}

/**
 * The non-blocking tail of `new` and `init` (change madarch-zcti): the
 * home's shared server is started or reused, the product's address under it
 * is printed — over SSH with the tunnel command — and the command returns
 * at once where `serve` would have kept running. `jsonBase` carries the
 * facts already collected; the daemon's own are added beside them and one
 * JSON line is printed.
 */
async function serveShared(parsed: Parsed, deps: CliDeps, folder: string, init: boolean, jsonBase?: Record<string, unknown>): Promise<number> {
  const started = await ensureDaemon({ home: parsed.home, port: parsed.port, appFolder: deps.app?.appFolder, buildCommand: deps.app?.buildCommand, env: deps.app?.env });
  if (!started.ok) { console.error(started.message); return 1; }
  const ownerHome = resolve(productsHome(process.env as DraftEnv, parsed.home));
  await prepareDaemonProduct(ownerHome, storeDatabasePath(productStoreFolder(folder, knowledgeRootOf(ownerHome))), await readPinnedGraphContract(folder));
  const name = encodeURIComponent(basename(folder));
  const url = `${started.url}/products/${name}/`;
  const env: ServeEnv = deps.app?.env ?? process.env;
  const ssh = Boolean(env.SSH_CONNECTION || env.SSH_TTY);
  const tunnel = `ssh -L ${started.port}:127.0.0.1:${started.port} ${env.USER || '<user>'}@${(env.SSH_CONNECTION ?? '').split(/\s+/)[2] ?? '<host>'}`;
  if (jsonBase !== undefined) {
    // The same facts the human lines carry, the port note included: a
    // machine consumer is told that --port did not apply exactly as a
    // person reading the lines is.
    console.log(JSON.stringify({
      ...jsonBase,
      url,
      pid: started.pid,
      port: started.port,
      reused: started.reused,
      ...(started.requestedPort === undefined ? {} : { requestedPort: started.requestedPort }),
      ...(started.note === undefined ? {} : { portNote: started.note }),
      ...(ssh ? { sshTunnel: tunnel } : {}),
    }));
    return 0;
  }
  console.log(started.reused ? `The wiki is already running at ${url}` : `The wiki is running at ${url}`);
  if (started.note !== undefined) console.log(started.note);
  if (ssh) {
    console.log('This machine is remote (SSH). To open the wiki on your computer, run there:');
    console.log(`  ${tunnel}`);
    console.log(`and open http://localhost:${started.port}/products/${name}/`);
  }
  const noDesktop = process.platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY;
  const open = parsed.open !== false && !ssh && (!noDesktop || Boolean(deps.opener || env.MADARCH_BROWSER?.trim() || env.BROWSER?.trim()));
  if (open) {
    void (deps.opener ?? machineOpener(env))(url).then((opened) => { if (!opened.ok) console.error(`The browser was not opened: ${opened.message}`); });
  }
  nextSteps(folder, init);
  return 0;
}

/** `madarch version`: one fact the release answers with (or `dev` in a checkout); 0, always. */
function versionCommand(): number {
  console.log(`version: ${runningVersion()}`);
  return 0;
}

/** The serve options one subcommand's flags parsed into. */
function serveOptions(parsed: Parsed, deps: CliDeps = {}): ServeOptions {
  return {
    port: parsed.port,
    host: parsed.host,
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

/** What a reset removes and keeps, in the words both the command and the wiki's confirmation use. */
export function describeReset(name: string, plan: ResetPlan): string[] {
  return [
    `Starting ${name} over removes:`,
    `  - the product's graph store, which the next fill builds again from the code${plan.store.length === 0 ? ' (there is none now)' : ''}`,
    ...(plan.agentPages.length === 0 ? ['  - no page: the agent has written none'] : [`  - the ${plan.agentPages.length} page${plan.agentPages.length === 1 ? '' : 's'} the agent wrote: ${plan.agentPages.join(', ')}`]),
    `  - ${plan.unansweredQuestions.length} unanswered agent question${plan.unansweredQuestions.length === 1 ? '' : 's'}${plan.unansweredQuestions.length === 0 ? '' : `: ${plan.unansweredQuestions.join(', ')}`}`,
    `${plan.keptAnswers.length} answers stay${plan.keptAnswers.length === 0 ? '' : `: ${plan.keptAnswers.join(', ')}`}. People's corrections stay too.`,
    'It keeps every other file of the product, the code repositories under repos/, and the choice of the agent.',
    ...(plan.keptPages.length === 0 ? [] : [`Pages in those places that a person wrote stay: ${plan.keptPages.join(', ')}.`]),
  ];
}

/** `madarch reset <product>`: starts the product's knowledge over, asking first unless `--yes` is given. */
async function resetCommand(name: string | undefined, homeOption: string | undefined, yes: boolean): Promise<number> {
  const root = productsHome(process.env as DraftEnv, homeOption);
  const listed = listProducts({ home: root });
  const names = listed.outcome === 'listed' ? listed.products.map((entry) => basename(entry.folder)) : [];
  if (name === undefined || !names.includes(name)) {
    console.error(`madarch reset <product>: ${name === undefined ? 'name the product' : `no product "${name}" in ${root}`}; the products are ${names.length === 0 ? '(none)' : names.join(', ')}`);
    return 2;
  }
  const folder = join(root, name);
  const read = readProduct(folder);
  if (!read.ok) {
    console.error(`${read.file}:${read.line}: ${read.message}`);
    return 1;
  }
  const server = daemonUrl({ home: root });
  const asServer = server === undefined ? undefined : `${server}/products/${encodeURIComponent(name)}${API.reset}`;
  let plan: ResetPlan;
  try {
    if (asServer !== undefined) {
      const answer = await fetch(asServer);
      if (!answer.ok) throw new Error(`the background server at ${server} answered ${answer.status}: ${await answer.text()}`);
      plan = (await answer.json()) as ResetPlan;
    } else {
      const { KnowledgeProduct } = await import('../knowledge/product.js');
      const product = new KnowledgeProduct({ productFolder: folder, storeRoot: knowledgeRootOf(root) });
      try {
        plan = await product.resetPlan();
      } finally {
        await product.close();
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  for (const line of describeReset(name, plan)) console.log(line);
  if (!yes) {
    process.stderr.write('proceed? [y/N] ');
    const { answeredFromStdin } = await import('./upgrade.js');
    const answer = answeredFromStdin()();
    if (!/^(y|yes)$/i.test(answer.trim())) {
      console.error(`nothing was removed: the answer was ${JSON.stringify(answer)}, yes is y or yes`);
      return 2;
    }
  }
  try {
    if (asServer !== undefined) {
      const done = await fetch(asServer, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ preview: plan }) });
      if (!done.ok) throw new Error(`the background server at ${server} refused: ${await done.text()}`);
    } else {
      applyReset(folder, plan);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  console.log(`Done. ${name} reads as an empty product: open its wiki and press the button to fill it again.`);
  return 0;
}
