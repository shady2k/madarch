/**
 * The guard that keeps the product tests out of the machine's real products
 * home (madarch-1xq's rule; the run 4fk trap: a product code mutant that
 * breaks home handling must never reach `~/madarch/products` — the close-out
 * before it found stray drafts there).
 *
 * Three holds, each honest about what it can stop:
 * 1. `refuseNonScratchHome` refuses, before a run or a library call, any
 *    products home a test computes that is not the real folder behind a
 *    scratch name — a symlink to anywhere is followed, so the folder the
 *    writes would land in is the one that is judged.
 * 2. `homeOfCommand` resolves the products home the way `madarch new` and
 *    `madarch list` resolve it — the last `--home` wins, as their argument
 *    reading does — so a test that runs the command as a child process can
 *    refuse a home the child would read; a `--home` the command refuses is
 *    never resolved, because that run creates nothing.
 * 3. `noStrayDrafts` is the backstop against what no argument can see: a
 *    mutant writing a draft anywhere it wants. It lists the real home once
 *    when the tests load, and after every test names everything new there
 *    and fails the run — and removes nothing: a person's draft created in
 *    the run's window cannot be told apart from a mutant's, so the deletion
 *    is the operator's, with the list in hand.
 *
 * The real home is read from the account's own record (`userInfo`), never
 * from `HOME`, so a test or a sandbox that moves `HOME` off the account
 * cannot move what the guard watches.
 */
import { existsSync, mkdtempSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

/** The account's own home: what `~` and the machine's default mean, whatever `HOME` says. */
export const ACCOUNT_HOME = userInfo().homedir;
/** The one real products home, whose contents the guard never adds to. */
export const REAL_PRODUCTS_HOME = join(ACCOUNT_HOME, 'madarch', 'products');
/** What the load-time read saw, so "new since the tests started" is a fact. */
const LOADED_AT = Date.now();
const BEFORE = new Set(entriesAtLoad());
function entriesAtLoad(): string[] {
  if (!existsSync(REAL_PRODUCTS_HOME) || !statSync(REAL_PRODUCTS_HOME).isDirectory()) return [];
  return readdirSync(REAL_PRODUCTS_HOME);
}

/** One scratch home the guard owns, beside the tests' own temporary folders. */
export const ISOLATED_HOME = mkdtempSync(join(tmpdir(), 'madarch-home-guard-'));

/**
 * Throws unless the folder the writes would land in stands under the system
 * temporary folder. `unless` carves the one exemption a test may take, and
 * must say why it exists: the root-of-the-machine test, which touches `/`
 * as a products home on purpose and cleans its own folder after itself.
 */
export function refuseNonScratchHome(home: string, what: string, unless?: { allow: 'the root home test'; why: string }): string {
  const resolved = resolve(home);
  // The folder the writes would land in, resolved: real where it exists,
  // and otherwise the nearest ancestor that does, carrying the names of the
  // rest — a products home the tests refuse to create is judged by what its
  // first real ancestor holds, as the creation would be.
  let real: string | undefined;
  try {
    let cursor = resolved;
    const tail: string[] = [];
    while (!existsSync(cursor)) {
      tail.unshift(basename(cursor));
      const parent = dirname(cursor);
      if (parent === cursor) break; // the root of the path, and nowhere under it exists
      cursor = parent;
    }
    real = join(realpathSync(cursor), ...tail);
  } catch {
    real = undefined; // a path that cannot be resolved is refused below, not assumed inside
  }
  const insideScratch = real !== undefined
    && (real === tmpdir() || real.startsWith(tmpdir() + sep))
    && !real.startsWith(REAL_PRODUCTS_HOME + sep);
  if (insideScratch) return resolved;
  if (unless?.allow === 'the root home test' && real === '/') return resolved;
  const named = real ?? resolved;
  throw new Error(`${what} names the products home ${named}, not under the scratch folder (${tmpdir()})${unless ? ` — the allowance named was ${unless.allow}` : ''}: the product tests must never reach a real home`);
}

/**
 * The products home the command child would read, resolved the way `madarch
 * new` and `madarch list` resolve it: the last `--home` over `MADARCH_HOME`'s
 * `products` over the account's default, the way their argument reading
 * decides. serve reads no products home, and a run that starts no creator
 * reads none either.
 */
export function homeOfCommand(args: readonly string[], env: Record<string, string | undefined>): string {
  const command = args[0] ?? '';
  if (command !== 'new' && command !== 'list') return '';
  let named: string | undefined;
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
    named = value;
  }
  if (named !== undefined) return refuseNonScratchHome(named, `the run of madarch ${command}`);
  const madarchHome = env.MADARCH_HOME?.trim();
  if (madarchHome !== undefined && madarchHome !== '') return refuseNonScratchHome(join(madarchHome, 'products'), `MADARCH_HOME of the run of madarch ${command}`);
  return refuseNonScratchHome(join(ACCOUNT_HOME, 'madarch', 'products'), `the default home of the run of madarch ${command}`);
}

/**
 * The environment a test's command child runs in: `HOME` and `MADARCH_HOME`
 * are pointed at the guard's scratch home wherever the surrounding shell did
 * not already point them at a scratch one (the mutation sandbox does), so a
 * child whose home handling anything broke cannot create under the account's
 * real home. A `MADARCH_HOME` the test itself chose stands; a scratch `HOME`
 * is kept as it is, git's identity being sealed beside it by the callers.
 */
export function sealedHome(overrides: Record<string, string>): { HOME: string; MADARCH_HOME: string } {
  return {
    HOME: tmpdirIsolation() ? process.env.HOME! : ISOLATED_HOME,
    // The test's own MADARCH_HOME is refused to scratch before the spawn
    // (homeOfCommand); what it is not is never inherited from the shell.
    MADARCH_HOME: overrides.MADARCH_HOME ?? join(ISOLATED_HOME, 'madarch'),
  };
}

/** Whether the surrounding process's home is already a scratch one: true inside the mutation sandboxes. */
export function tmpdirIsolation(): boolean {
  const home = process.env.HOME;
  if (home === undefined) return false;
  try {
    const real = realpathSync(home);
    return real.startsWith(tmpdir() + sep) || real === tmpdir();
  } catch {
    return false;
  }
}

/** What the tripwire found after a test: everything new in the real home since it loaded, each named. */
export interface Strays {
  /** Entries new in the real home: named, and never touched — their removal is the operator's. */
  newEntries: string[];
}

/** The entries the real products home gained since the tests loaded, each named and never touched. */
export function noStrayDrafts(): Strays {
  if (!existsSync(REAL_PRODUCTS_HOME) || !statSync(REAL_PRODUCTS_HOME).isDirectory()) return { newEntries: [] };
  return { newEntries: readdirSync(REAL_PRODUCTS_HOME).filter((name) => !BEFORE.has(name)) };
}
