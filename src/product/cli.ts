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

/** The one-line usage, shaped the way `scripts/serve.ts` and `scripts/wiki.ts` print theirs. */
export const USAGE = 'usage: bun scripts/madarch.ts new [--home <folder>]';

/** The text `--help` prints: the subcommands and the options each does what. */
export const HELP = [
  'usage: bun scripts/madarch.ts new [--home <folder>]',
  '   or: madarch new [--home <folder>] — the same command after `bun link` in a checkout',
  '',
  'new creates a draft product repository under the products home: a git',
  "repository with the product's constitution, its manifest and its empty",
  "folders, one commit holding them. It prints the draft's folder and its",
  'id, one fact per line, on standard output.',
  '',
  'subcommands:',
  '  new   create a draft product repository',
  'options:',
  '  --home <folder>   the products home of this one command, over MADARCH_HOME',
  '                    (without either, ~/madarch/products)',
].join('\n');

/** The exit code of one run of the command: 0, 2 or 1, with its own stream's output printed. */
export function main(args: readonly string[]): number {
  if (args.length === 0) {
    console.error('no subcommand given: the subcommand is "new"');
    console.error(USAGE);
    return 2;
  }
  const command = args[0]!;
  if (command === '--help') {
    console.log(HELP);
    return 0;
  }
  if (command.startsWith('--')) {
    console.error(`unknown option "${command}" before the subcommand: the subcommands are "new"`);
    console.error(USAGE);
    return 2;
  }
  if (command !== 'new') {
    console.error(`unknown subcommand "${command}": the subcommands are "new"`);
    console.error(USAGE);
    return 2;
  }

  let home: string | undefined;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--home') {
      // The next word is the home: a word that is empty, that is only the
      // next option, or that never comes is not a home anyone named. The
      // command refuses before the library is called — a folder named
      // `--no-open`, or a fall-through to MADARCH_HOME and the machine
      // default, is a draft written where nobody asked.
      home = args[i + 1];
      i++;
      if (home === undefined || home === '' || home.startsWith('--')) {
        console.error(`the --home flag needs a folder${home === undefined ? '' : `, not "${home}"`}: it names the products home of this one command`);
        console.error(USAGE);
        return 2;
      }
    } else if (arg.startsWith('--home=')) {
      home = arg.slice('--home='.length);
      if (home === '' || home.startsWith('--')) {
        console.error(`the --home flag needs a folder${home === '' ? '' : `, not "${home}"`}: it names the products home of this one command`);
        console.error(USAGE);
        return 2;
      }
    } else if (arg.startsWith('--')) {
      console.error(`unknown option "${arg}": the options "new" accepts are --home <folder>`);
      console.error(USAGE);
      return 2;
    } else {
      console.error(`unexpected argument "${arg}": "new" takes only --home <folder>`);
      console.error(USAGE);
      return 2;
    }
  }

  const draft = createDraft(home === undefined ? {} : { home });
  if (draft.outcome === 'created') {
    console.log(`folder: ${draft.folder}`);
    console.log(`id: ${draft.id}`);
    return 0;
  }
  console.error(draft.message);
  return draft.outcome === 'refused' ? 2 : 1;
}
