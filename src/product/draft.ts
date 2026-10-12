/**
 * Creating a draft product repository, as `madarch new` gives it to a person
 * with only an idea (docs/changes/draft-product/capabilities/
 * product-repository.md, requirement draft; decision 0021: the lifecycle
 * commands are madarch's own code): a real git repository under the products
 * home, one commit holding the skeleton, and `repos/` on disk and untracked.
 *
 * What madarch decides is its own: the products home (no default inside the
 * library, the command and `MADARCH_HOME` above it), and the day a test
 * folds a name from a given moment. The skeleton itself — the constitution,
 * the manifest, the git history and the outcomes' words — is the layout the
 * schema version fixes, and this module writes it. The command script maps
 * the outcomes onto its exit codes (2 refused, 1 failed); the library only
 * reports them.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { runGit, type GitEnv } from './git.js';
import { MANIFEST_FILE, yamlWord } from './manifest.js';

/** The environment the products home is read from: the process's, or the caller's. */
export type DraftEnv = Readonly<Record<string, string | undefined>>;

/**
 * The manifest's schema version fixes the folders every product holds, in
 * this layout, and never reads them from the manifest: `repos/` is the only
 * folder untracked, and each tracked one is kept by the file git needs to
 * keep an empty folder.
 */
const FOLDERS = ['docs', 'model', 'skills', 'prototypes', 'repos'];
const TRACKED_FOLDERS = ['docs', 'model', 'skills', 'prototypes'];
const COMMITTED_FILES = ['AGENTS.md', 'CLAUDE.md', `${MANIFEST_FILE}`, '.gitignore',
  'docs/.gitkeep', 'model/.gitkeep', 'skills/.gitkeep', 'prototypes/.gitkeep'];

/** The markers around the part of `AGENTS.md` madarch's commands maintain. */
export const MAINTAINED_OPEN = '<!-- product:maintained -->';
export const MAINTAINED_CLOSE = '<!-- /product:maintained -->';

/**
 * The constitution `new` writes: the folders and what each is for. It names
 * no project and no wiki, holds no path, and is written once — the part
 * between the markers is the only part a later version may update, so every
 * section below it, the engineer's own included, is left as it was.
 */
export const CONSTITUTION = [
  '# Constitution',
  '',
  "This repository holds one product's knowledge, apart from the product's",
  'code: its documents, its intended model, its skills and its prototypes,',
  'kept as plain files in git. A product wiki serves these files as pages, so',
  'what is written here is what is read.',
  '',
  '## Folders',
  '',
  "- docs/ — the product's documents, written in Markdown and kept in git.",
  '- model/ — the model the product is meant to have.',
  "- skills/ — the team's own skills, written for this product; never a copy",
  "  of the skill set's own, whose pinned version is field `skills` of the",
  '  manifest, naming the set and its version (`shady2k: <version>`).',
  '- prototypes/ — throwaway prototypes built to answer design questions.',
  '- repos/ — the code repositories the product spans. Each one is a git',
  '  repository of its own, and this repository leaves repos/ untracked.',
  '',
  "The folders' places come with the manifest's `schemaVersion` and are never",
  'read from the manifest, so every tool and every agent knows where things',
  'are from the schema version alone.',
  '',
  '## Documents',
  '',
  'Every document is Markdown in git: a page someone writes, and what the',
  'reader later sees. Links between documents are relative paths, so this',
  'folder may be renamed without breaking them.',
  '',
  MAINTAINED_OPEN,
  'The manifest `workspace.yaml` is how a product is recognised. Its',
  '`schemaVersion`, `id` and `name` are never renamed; anything a later',
  'version adds grows beside them. `schemaVersion` (1 here) fixes the folder',
  "layout above; `id` is given at creation and kept for the product's life,",
  "whatever this folder is later called; for a draft, `name` is this folder's",
  'name. This file is written once, and a later version updates no part of it',
  'outside this marked section.',
  MAINTAINED_CLOSE,
  '',
].join('\n');

/** The manifest's text as `new` writes it: the three fields that are never renamed. */
const manifestText = (id: string, name: string): string =>
  [`schemaVersion: ${1}`, `id: ${id}`, `name: ${yamlWord(name)}`, ''].join('\n');

/** How creating a draft ended. `refused` is the command's exit 2, `failed` its exit 1. */
export type DraftResult =
  | { outcome: 'created'; folder: string; id: string; name: string }
  | { outcome: 'refused'; message: string }
  | { outcome: 'failed'; message: string };

export interface DraftOptions {
  /**
   * The products home, as `--home` names it for this one command. Left
   * out, `MADARCH_HOME` and then the machine's default decide it
   * (`productsHome`).
   */
  home?: string;
  /**
   * The moment the draft's name is folded from. Left out, the local clock
   * decides the day; tests give the day so a run does not depend on the
   * clock or the machine's zone.
   */
  today?: Date;
  /**
   * Extra environment for this draft's own git invocations, merged over a
   * process environment with the loader variables (`GIT_DIR` and its
   * companions) stripped by `runGit` itself, so a git call here never
   * reaches into another repository's worktree. Tests pass a sealed
   * identity this way; the command leaves it out and commits with the
   * person's own identity.
   */
  gitEnv?: GitEnv;
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
 * Whether a day is written `YYYY-MM-DD` and is a day the calendar has. A
 * draft's day is written `YYYY-MM-DD` and is a day the calendar has, so a
 * test never depends on the clock and no folder is named after a day that
 * does not exist.
 */
export function whyNotADay(date: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'is not written YYYY-MM-DD';
  const [year, month, day] = date.split('-').map(Number);
  const asDate = new Date(Date.UTC(year!, month! - 1, day!));
  if (asDate.getUTCFullYear() !== year || asDate.getUTCMonth() !== month! - 1 || asDate.getUTCDate() !== day)
    return 'is not a day of the calendar';
  return null;
}

/** A draft's day, as `YYYY-MM-DD`, from the caller's word or the local clock. */
function dayOf(date?: string): { ok: true; day: string } | { ok: false; message: string } {
  if (typeof date === 'string') {
    const why = whyNotADay(date);
    if (why !== null) return { ok: false, message: `the day "${date}" ${why}` };
    return { ok: true, day: date };
  }
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return { ok: true, day: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` };
}

/**
 * Reserves the day's folder name in the products home: one non-recursive
 * mkdir of the candidate, growing the suffix until a name this call alone
 * reserved. A recursive reservation would succeed into another run's folder,
 * and its cleanup would then delete that run's work.
 */
export function reserveDraftFolder(home: string, day: string): { folder: string; name: string } {
  for (let attempt = 1; ; attempt++) {
    const name = attempt === 1 ? `idea-${day}` : `idea-${day}-${attempt}`;
    const candidate = join(home, name);
    try {
      mkdirSync(candidate);
      return { folder: candidate, name };
    } catch (error) {
      if ((error as { code?: string }).code === 'EEXIST') continue;
      throw error;
    }
  }
}

/** Removes the folder this invocation itself reserved; the failure, when there is one, is the caller's to report. */
function removeDraftFolder(folder: string): string | undefined {
  try {
    rmSync(folder, { recursive: true, force: true });
    return undefined;
  } catch (error) {
    return `the failed draft's folder ${folder} could not be removed: ${(error as Error).message}`;
  }
}

/**
 * Creates a draft product repository under the products home the caller
 * names. Nothing is refused half-done: the home is judged before any product
 * folder exists, and after the folder was created, every failure removes it
 * again — when even that removal fails, the message names the folder that was
 * left behind, so a failed run never leaves one without saying where.
 */
export function createDraft(options: DraftOptions = {}): DraftResult {
  // The home is madarch's own decision: the `--home` the command was given,
  // over `MADARCH_HOME`, over the machine's default (productsHome).
  // productsHome itself trims: the home it names is the folder, never shell whitespace.
  const products = resolve(productsHome(process.env as DraftEnv, options.home));

  // The day is judged before anything at all is made: a command refused for
  // its arguments leaves no folder behind, not even the home.
  const day = dayOf(options.today === undefined ? undefined : localDay(options.today));
  if (!day.ok) return { outcome: 'refused', message: day.message };

  // A home that is not a folder is refused before anything is written: a
  // file of that name must not be replaced, and nothing must land beside it
  // by surprise.
  try {
    if (!statSync(products).isDirectory())
      return { outcome: 'refused', message: `the products home ${products} cannot be used: a file of that name is in the way, and products are written under it — point the command at another home` };
  } catch {
    // Absent: created below, as any missing products home is.
  }
  try {
    mkdirSync(products, { recursive: true });
  } catch (error) {
    return { outcome: 'refused', message: `the products home ${products} cannot be created: ${(error as Error).message}` };
  }

  let folder: string;
  let name: string;
  try {
    // The draft's name is the reserved candidate's own name, read once here
    // for the manifest and the result — never again from a slice of the path,
    // which a home of `/` would cut a letter off.
    const reserved = reserveDraftFolder(products, day.day);
    folder = reserved.folder;
    name = reserved.name;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (['EACCES', 'EPERM', 'EROFS'].includes(code ?? ''))
      return { outcome: 'refused', message: `the products home ${products} cannot be written into: ${(error as Error).message}` };
    return { outcome: 'failed', message: `the draft could not be created in ${products}: ${(error as Error).message}` };
  }

  const id = randomUUID();
  try {
    for (const folderName of FOLDERS) mkdirSync(join(folder, folderName));
    writeFileSync(join(folder, 'AGENTS.md'), CONSTITUTION);
    writeFileSync(join(folder, 'CLAUDE.md'), '@AGENTS.md\n');
    writeFileSync(join(folder, MANIFEST_FILE), manifestText(id, name));
    writeFileSync(join(folder, '.gitignore'), 'repos/\n');
    for (const folderName of TRACKED_FOLDERS) writeFileSync(join(folder, folderName, '.gitkeep'), '');

    const init = runGit(folder, ['init', '--quiet', '--initial-branch=main'], options.gitEnv);
    if (!init.ok) throw new Error(`git init failed in ${folder}: ${init.output}`);
    const add = runGit(folder, ['add', ...COMMITTED_FILES], options.gitEnv);
    if (!add.ok) throw new Error(`git add failed in ${folder}: ${add.output}`);
    const commit = runGit(folder, ['commit', '--quiet', '-m', 'Create the draft product'], options.gitEnv);
    if (!commit.ok) throw new Error(`git commit failed in ${folder}: ${commit.output}`);
  } catch (error) {
    const failure = (error as Error).message;
    const cleanup = removeDraftFolder(folder);
    return { outcome: 'failed', message: cleanup === undefined ? failure : `${failure}; ${cleanup}` };
  }
  return { outcome: 'created', folder, id, name };
}

/**
 * The draft's day, as the manifest writes it `YYYY-MM-DD`, from the local
 * date of the given moment: the same local day the creation read before the
 * day arrived here, never a UTC day standing in for the zone's.
 */
function localDay(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
