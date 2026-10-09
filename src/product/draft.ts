/**
 * The draft product repository — what `madarch new` gives a person with
 * only an idea (docs/changes/draft-product/capabilities/product-repository.md,
 * requirement draft): a real git repository under the products home, one
 * commit holding the skeleton, and `repos/` on disk and untracked. The
 * command script maps the outcomes onto its exit codes (2 refused, 1
 * failed); the library itself only reports them.
 *
 * Nothing written into the product names where it lives: the skeleton is
 * the same bytes in every draft, so a draft can be renamed without
 * breaking it (change record "AGENTS.md is written once").
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** The environment the products home is read from: the process's, or the caller's. */
export type DraftEnv = Readonly<Record<string, string | undefined>>;

/** The schema version this madarch writes and reads; the folder layout is fixed by it alone. */
export const PRODUCT_SCHEMA_VERSION = 1;

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

export interface DraftOptions {
  /**
   * The products home, as `--home` names it for this one command. Left
   * out, `MADARCH_HOME` and then the machine's default decide it
   * (`productsHome`).
   */
  home?: string;
  /**
   * The moment the draft's name is folded from. Left out, the current
   * moment is used; tests give the day so a run does not depend on the
   * clock or the machine's zone.
   */
  today?: Date;
  /**
   * Extra environment for this draft's own git invocations, merged over a
   * process environment with the loader variables (`GIT_DIR` and its
   * companions) stripped, so a git call here never reaches into another
   * repository's worktree. Tests pass a sealed identity this way; the
   * command leaves it out and commits with the person's own identity.
   */
  gitEnv?: Record<string, string>;
}

/** How creating a draft ended. `refused` is the command's exit 2, `failed` its exit 1. */
export type DraftResult =
  | { outcome: 'created'; folder: string; id: string; name: string }
  | { outcome: 'refused'; message: string }
  | { outcome: 'failed'; message: string };

/** The subset of the environment git must not inherit from a caller. */
const GIT_LEAKS = ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'] as const;

/** The folders the schema version fixes: every draft holds them, in this layout. */
const FOLDERS = ['docs', 'model', 'skills', 'prototypes', 'repos'] as const;
/** The folders of `FOLDERS` git does track, each kept by its `.gitkeep`. */
const TRACKED_FOLDERS = ['docs', 'model', 'skills', 'prototypes'] as const;
const FILES = ['AGENTS.md', 'CLAUDE.md', 'workspace.yaml', '.gitignore', 'docs/.gitkeep', 'model/.gitkeep', 'skills/.gitkeep', 'prototypes/.gitkeep'] as const;

const AGENTS_MD = [
  '# Constitution',
  '',
  'This repository holds one product\'s knowledge, apart from the product\'s',
  'code: its documents, its intended model, its skills and its prototypes,',
  'kept as plain files in git. A local madarch serves this repository\'s',
  'wiki, so what is written here is what is read.',
  '',
  '## Folders',
  '',
  '- docs/ — the wiki\'s documents, written in Markdown and kept in git; a',
  '  local madarch serves every page from them.',
  '- model/ — the product\'s intended model, in madarch\'s YAML.',
  "- skills/ — the team's own skills, written for this product; never a",
  '  copy of madarch\'s skill set, whose pinned version is field',
  '  `skills` of the manifest, naming the set and its version (`shady2k:',
  '  <version>` against the shady2k-skills set).',
  '- prototypes/ — throwaway prototypes built to answer design questions.',
  '- repos/ — the code repositories the product spans. Each one is a git',
  '  repository of its own; this one leaves repos/ untracked.',
  '',
  'The folders\' places are fixed by the manifest\'s `schemaVersion`,',
  'never read from the manifest.',
  '',
  '## Documents',
  '',
  'Every document is Markdown in git: a page someone writes, and what the',
  'reader later sees. Links between documents are relative paths, so this',
  'folder may be renamed without breaking them.',
  '',
  '<!-- madarch:maintained -->',
  'The manifest `workspace.yaml` is how a product is recognised. Its',
  '`schemaVersion`, `id` and `name` are never renamed; anything else a',
  'later madarch adds grows beside them. `schemaVersion` (1 here) fixes the',
  'folder layout above; `id` is given at creation and kept for the',
  "product's life, whatever this folder is later called; for a draft,",
  "`name` is this folder's name. Madarch writes this file once, and later",
  'updates no part of it outside this marked section.',
  '<!-- /madarch:maintained -->',
  '',
].join('\n');

/** The manifest's text: the three fields that are never renamed, and nothing else yet. */
function manifestText(id: string, name: string): string {
  return [`schemaVersion: ${PRODUCT_SCHEMA_VERSION}`, `id: ${id}`, `name: ${name}`, ''].join('\n');
}

/**
 * Creates a draft product repository under the products home. Nothing is
 * refused half-done: a refusal (the products home cannot be used) happens
 * before any product folder exists. After the folder was created, every
 * failure removes the folder again when the removal succeeds; when even
 * the removal fails, the failure is reported and its message names the
 * folder that was left behind. So a failed `madarch new` normally leaves
 * no folder behind — and it never leaves one without saying where.
 */
export function createDraft(options: DraftOptions = {}): DraftResult {
  const home = resolve(productsHome(process.env as DraftEnv, options.home));

  // A products home that is not a folder is refused before anything is
  // written: a file of that name, wherever the path came from, must not be
  // replaced and nothing must land beside it by surprise.
  try {
    const stats = statSync(home);
    if (!stats.isDirectory()) {
      return { outcome: 'refused', message: `the products home ${home} cannot be used: a file of that name is in the way, and madarch writes products under it — point the command at another home` };
    }
  } catch {
    // Absent: created below, as any missing products home is.
  }
  try {
    mkdirSync(home, { recursive: true });
  } catch (error) {
    return { outcome: 'refused', message: `the products home ${home} cannot be created: ${(error as Error).message}` };
  }

  // The day's name. The candidate is reserved with one non-recursive
  // `mkdirSync`, which fails with EEXIST when another run took the name:
  // a recursive reservation would succeed into the other run's folder and
  // its cleanup would delete it. The suffix grows, `-2`, `-3`, and so on,
  // until a name this run alone reserved.
  const today = options.today ?? new Date();
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  // The draft's name is the reserved candidate's own name — the folder's
  // basename the reservation chose — read once here for the manifest and
  // the result, never again from a slice of the path: a home of `/`
  // would cut a basename's first letter that way.
  let folder: string;
  let name: string;
  try {
    const reserved = reserveDraftFolder(home, day);
    folder = reserved.folder;
    name = reserved.name;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      return { outcome: 'refused', message: `the products home ${home} cannot be written into: ${(error as Error).message}` };
    }
    return { outcome: 'failed', message: `the draft could not be created in ${home}: ${(error as Error).message}` };
  }

  const id = randomUUID();
  try {
    for (const folderName of FOLDERS) mkdirSync(join(folder, folderName));
    writeFileSync(join(folder, 'AGENTS.md'), AGENTS_MD);
    writeFileSync(join(folder, 'CLAUDE.md'), '@AGENTS.md\n');
    writeFileSync(join(folder, 'workspace.yaml'), manifestText(id, name));
    writeFileSync(join(folder, '.gitignore'), 'repos/\n');
    for (const folderName of TRACKED_FOLDERS) writeFileSync(join(folder, folderName, '.gitkeep'), '');

    const init = runGit(folder, ['init', '-b', 'main'], options.gitEnv);
    if (!init.ok) throw new Error(`git init failed in ${folder}: ${init.output}`);
    const add = runGit(folder, ['add', ...FILES], options.gitEnv);
    if (!add.ok) throw new Error(`git add failed in ${folder}: ${add.output}`);
    const commit = runGit(folder, ['commit', '--quiet', '-m', 'Create the draft product'], options.gitEnv);
    if (!commit.ok) throw new Error(`git commit failed in ${folder}: ${commit.output}`);
  } catch (error) {
    // Whatever failed — a folder that could not be written, git that
    // refused a step — the folder this run reserved is removed whole.
    const failure = error instanceof Error ? error.message : String(error);
    const cleanup = removeDraftFolder(folder);
    return { outcome: 'failed', message: cleanup === undefined ? failure : `${failure}; ${cleanup}` };
  }
  return { outcome: 'created', folder, id, name };
}

/** One git invocation in the product folder, with the caller's environment sealed off the loader variables. */
function runGit(folder: string, args: string[], extra?: Record<string, string>): { ok: boolean; output: string } {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !GIT_LEAKS.includes(name as (typeof GIT_LEAKS)[number])) env[name] = value;
  }
  Object.assign(env, extra);
  const run = spawnSync('git', args, { cwd: folder, encoding: 'utf8', env });
  const output = `${run.stderr ?? ''}${run.stdout ?? ''}`.trim();
  if (run.error !== undefined) {
    // No run happened: git's own error — normally ENOENT under a name the
    // PATH does not hold — is the only cause there is.
    return { ok: false, output: output === '' ? run.error.message : `${output}; ${run.error.message}` };
  }
  if (run.status !== 0) return { ok: false, output };
  return { ok: true, output: '' };
}

/**
 * Reserves the day's folder name in the products home: one non-recursive
 * `mkdirSync` of the candidate, growing the suffix until a name this call
 * alone reserved. Exported because the reservation is itself the seam the
 * race is tested at: it must take the next suffix on EEXIST and never
 * touch a folder it did not create.
 */
export function reserveDraftFolder(home: string, day: string): { folder: string; name: string } {
  for (let attempt = 1; ; attempt++) {
    const name = attempt === 1 ? `idea-${day}` : `idea-${day}-${attempt}`;
    const candidate = join(home, name);
    try {
      // Non-recursive: the home exists, so this is the reservation, and
      // it is the only thing that answers what the folder belongs to.
      mkdirSync(candidate);
      return { folder: candidate, name };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; // another run's name; the next suffix.
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

