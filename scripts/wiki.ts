/**
 * The wiki's command line: `bun scripts/wiki.ts <repository path> --out
 * <folder> [--engine zensical|starlight]`. The build itself lives in
 * `src/wiki/build.ts`; this script only parses arguments, prints and
 * exits: 0 when the site is built, its path printed; 1 when the engine's
 * build failed, its output printed; 2 when the input cannot be read —
 * the usage, an unknown engine, a model that does not compile (every
 * error with its file and line), or a missing toolchain (naming the
 * install).
 */
import { buildWiki } from '../src/wiki/build.js';

const USAGE = 'usage: bun scripts/wiki.ts <repository path> --out <folder> [--engine zensical|starlight]';

function main(args: readonly string[]): number {
  let repoPath: string | undefined;
  let out: string | undefined;
  let engine: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--engine') {
      engine = args[i + 1];
      if (engine === undefined) {
        console.error(USAGE);
        return 2;
      }
      i++;
    } else if (arg.startsWith('--engine=')) {
      engine = arg.slice('--engine='.length);
    } else if (arg === '--out') {
      out = args[i + 1];
      if (out === undefined) {
        console.error(USAGE);
        return 2;
      }
      i++;
    } else if (arg.startsWith('--out=')) {
      out = arg.slice('--out='.length);
    } else if (arg.startsWith('--')) {
      console.error(`unknown option "${arg}"`);
      console.error(USAGE);
      return 2;
    } else if (repoPath === undefined) {
      repoPath = arg;
    } else {
      console.error(`unexpected argument "${arg}"`);
      console.error(USAGE);
      return 2;
    }
  }
  if (repoPath === undefined || out === undefined) {
    console.error(USAGE);
    return 2;
  }

  const result = buildWiki(repoPath, out, { engine });
  if (result.code === 0) console.log(result.message);
  else console.error(result.message);
  return result.code;
}

process.exitCode = main(process.argv.slice(2));
