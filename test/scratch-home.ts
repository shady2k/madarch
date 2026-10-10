/**
 * The guard that keeps the product tests out of the machine's real products
 * home (madarch-1xq's rule; the run 4fk trap: a product code mutant that
 * breaks home handling must never reach `~/madarch/products` — the close-out
 * before it found stray drafts there).
 *
 * Three holds, each honest about what it can stop:
 * 1. `refuseNonScratchHome` refuses, before a run or a library call, any
 *    products home a test computes that is not under the system temporary
 *    folder — the straightforward leak, an argument a test built wrong.
 * 2. `homeOfCommand` resolves the products home the way `madarch new` and
 *    `madarch list` resolve it, so a test that runs the command as a child
 *    process can refuse a home the child would read — including the one a
 *    mutated home resolution would invent beside `--home`.
 * 3. `noStrayDrafts` is the backstop against what no argument can see: the
 *    folder a mutant writes anywhere it wants. It lists the real home once
 *    when the tests load, and after every test removes what is new there and
 *    fails the run naming it.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/** The one real products home, whose contents the guard never adds to. */
export const REAL_PRODUCTS_HOME = join(homedir(), 'madarch', 'products');

/** The real home's top-level entries, read once when the tests load. */
const BEFORE = new Set(entriesAtLoad());
function entriesAtLoad(): string[] {
  if (!existsSync(REAL_PRODUCTS_HOME)) return [];
  return readdirSync(REAL_PRODUCTS_HOME);
}

/** Throws unless the products home stands under the system temporary folder. */
export function refuseNonScratchHome(home: string, what: string): string {
  const resolved = resolve(home);
  if (!resolved.startsWith(tmpdir() + sep) && resolved !== tmpdir()) {
    throw new Error(`${what} names the products home ${resolved}, not under the scratch folder (${tmpdir()}): the product tests must never reach a real home`);
  }
  return resolved;
}

/**
 * The products home the command child would read, resolved the way `madarch
 * new` and `madarch list` resolve it: `--home` over `MADARCH_HOME`'s
 * `products` over the machine's default. serve reads no products home, and a
 * run that starts no subcommand reads none either.
 */
export function homeOfCommand(args: readonly string[], env: Record<string, string | undefined>): string {
  const command = args[0] ?? '';
  if (command !== 'new' && command !== 'list') return '';
  for (let i = 1; i < args.length; i++) {
    const arg = args[i] ?? '';
    // Only a value the command would actually take is resolved: a missing
    // value, an empty one and one the command refuses — another option
    // hidden where a folder should stand — create nothing, and the guard
    // does not guess what they name.
    const given = arg === '--home' ? args[i + 1] : arg.startsWith('--home=') ? arg.slice('--home='.length) : undefined;
    if (given === undefined) continue;
    const value = given.trim();
    if (value === '' || value.startsWith('--')) continue;
    return refuseNonScratchHome(value, `the run of madarch ${command}`);
  }
  const madarchHome = env.MADARCH_HOME?.trim();
  if (madarchHome !== undefined && madarchHome !== '') return refuseNonScratchHome(join(madarchHome, 'products'), `MADARCH_HOME of the run of madarch ${command}`);
  return refuseNonScratchHome(join(homedir(), 'madarch', 'products'), `the default home of the run of madarch ${command}`);
}

/**
 * The stray drafts the tests left in the real products home since it was
 * first listed, each removed: the run's residue is never left behind. An
 * entry the tests did not make stays, and this only says what it found;
 * removing someone's draft that the tests cannot tell apart would be a
 * theft the tests must never commit.
 */
export function noStrayDrafts(): string[] {
  if (!existsSync(REAL_PRODUCTS_HOME)) return [];
  if (!statSync(REAL_PRODUCTS_HOME).isDirectory()) return [];
  const strays = readdirSync(REAL_PRODUCTS_HOME).filter((name) => !BEFORE.has(name));
  for (const name of strays) rmSync(join(REAL_PRODUCTS_HOME, name), { recursive: true, force: true });
  return strays;
}
