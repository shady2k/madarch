/**
 * Creating a draft product repository, as `madarch new` gives it to a person
 * with only an idea (docs/changes/draft-product/capabilities/
 * product-repository.md, requirement draft): a real git repository under the
 * products home, one commit holding the skeleton, and `repos/` on disk and
 * untracked.
 *
 * The creation itself is the skill set's product-repository program, at the
 * release pinned in `./program.ts` (decision 0019: the product repository's
 * lifecycle is the set's; madarch keeps a thin wrapper over a pinned release
 * and holds no creation code of its own). This module is that wrapper: it
 * keeps only what is madarch's own — the products home, which the program
 * takes from its caller alone (no default, no environment variable), and the
 * day a test folds a name from a given moment — and hands everything else,
 * the skeleton, the manifest, the git history and the outcomes' words, to the
 * pinned program. The command script maps the outcomes onto its exit codes
 * (2 refused, 1 failed); the library itself only reports them.
 */
import { createDraft as programCreateDraft } from './program.js';
import type { ProgramDraftResult, ProgramGitEnv } from './program.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The environment the products home is read from: the process's, or the caller's. */
export type DraftEnv = Readonly<Record<string, string | undefined>>;

/** How creating a draft ended. `refused` is the command's exit 2, `failed` its exit 1. */
export type DraftResult = ProgramDraftResult;

export interface DraftOptions {
  /**
   * The products home, as `--home` names it for this one command. Left
   * out, `MADARCH_HOME` and then the machine's default decide it
   * (`productsHome`).
   */
  home?: string;
  /**
   * The moment the draft's name is folded from. Left out, the program
   * reads the local clock itself; tests give the day so a run does not
   * depend on the clock or the machine's zone.
   */
  today?: Date;
  /**
   * Extra environment for this draft's own git invocations, merged over a
   * process environment with the loader variables (`GIT_DIR` and its
   * companions) stripped by the program itself, so a git call here never
   * reaches into another repository's worktree. Tests pass a sealed
   * identity this way; the command leaves it out and commits with the
   * person's own identity.
   */
  gitEnv?: ProgramGitEnv;
}

/**
 * The products home: the folder `--home` names when this command was given
 * one; otherwise `products` under the madarch home that `MADARCH_HOME`
 * names; otherwise `products` under `~/madarch`. An option or a variable
 * that names only spaces counts as unset, as everywhere in madarch.
 */
export function productsHome(env: DraftEnv, given?: string): string {
  const named = given?.trim();
  if (named !== undefined && named !== '') return named;
  const madarchHome = env.MADARCH_HOME?.trim();
  if (madarchHome !== undefined && madarchHome !== '') return join(madarchHome, 'products');
  return join(homedir(), 'madarch', 'products');
}

/**
 * The draft's day, as the program writes it `YYYY-MM-DD`, from the local
 * date of the given moment: the same local day the creation read before the
 * program carried the date, never a UTC day standing in for the zone's.
 */
function localDay(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Creates a draft product repository under the products home, through the pinned program. */
export function createDraft(options: DraftOptions = {}): DraftResult {
  const home = productsHome(process.env as DraftEnv, options.home);
  const date = options.today === undefined ? undefined : localDay(options.today);
  return programCreateDraft({ home, date, gitEnv: options.gitEnv });
}
