/**
 * What the architecture's rules look at, and how a module's path is written.
 *
 * The rules of decision 0033 (item 4) govern the product: the modules of `src/`
 * and the programs of `scripts/`. They do not govern `test/` — a test holds a
 * database and starts a fill to exercise the product, so it stands beside the
 * architecture, not in it — nor `.shady2k/` (the tracker's tooling) or
 * `wiki/app/` (the browser app, a package of its own); the dependency rules
 * (.dependency-cruiser.mjs) say the same in their own words, and knip covers all
 * of them for reachability, because dead code is waste wherever it lies.
 */
import { readdirSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { byCodePoint } from '../../../src/model/order.js';

/** The folders whose modules the rules govern. */
const RULE_ROOTS = ['src', 'scripts'] as const;

/** The extensions this repository writes a module in, most specific first. */
const MODULE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'] as const;

/** Folders no rule reads: dependencies, build output, the tracker's own store, scratch runs. */
const SKIPPED_FOLDERS: ReadonlySet<string> = new Set([
  '.beads',
  '.git',
  '.stryker-tmp',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'vendor',
]);

/** The repository root this module belongs to: the checkout whose src/ holds it. */
export function repositoryRoot(): string {
  return resolve(import.meta.dirname, '../../..');
}

/** The absolute path of a module the rules name as a path from the repository root. */
export function absolutePathOf(root: string, file: string): string {
  return join(root, ...file.split('/'));
}

/**
 * The modules of one repository, walked once: the paths the rules speak (from the
 * repository root, in code point order) and the same paths as a set, so resolving
 * an import asks a set rather than the file system.
 */
export interface ModuleSet {
  readonly root: string;
  readonly modules: readonly string[];
  readonly known: ReadonlySet<string>;
}

/**
 * Every module under the folders named. A folder that does not exist is skipped: a
 * fixture project holds only the folders its case needs.
 */
export function moduleSet(root: string, folders: readonly string[] = RULE_ROOTS): ModuleSet {
  const modules = modulesUnder(root, folders);
  return { root, modules, known: new Set(modules) };
}

function modulesUnder(root: string, folders: readonly string[]): string[] {
  const found: string[] = [];
  const walk = (folder: string): void => {
    let entries;
    try {
      entries = readdirSync(join(root, ...folder.split('/')), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = `${folder}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(entry.name)) walk(path);
      } else if (entry.isFile() && MODULE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
        found.push(path);
      }
    }
  };
  for (const folder of folders) walk(folder);
  return found.sort(byCodePoint);
}

/**
 * The module a written import specifier names, as a path from the repository root,
 * or `null` where nothing of this repository stands there — a package, or a module
 * the set does not hold.
 *
 * Only the repository's own specifiers are resolved, and the way its modules write
 * them: a relative path, spelled with the `.js` extension a TypeScript module is
 * imported by, which names the `.ts` file beside it.
 */
export function resolveModuleSpecifier(modules: ModuleSet, fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const joined = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  if (joined === '..' || joined.startsWith('../')) return null;
  const written = MODULE_EXTENSIONS.find((extension) => joined.endsWith(extension));
  const candidates =
    written === undefined
      ? [
          ...MODULE_EXTENSIONS.map((extension) => `${joined}${extension}`),
          ...MODULE_EXTENSIONS.map((extension) => `${joined}/index${extension}`),
        ]
      : MODULE_EXTENSIONS.map((extension) => `${joined.slice(0, joined.length - written.length)}${extension}`);
  return candidates.find((candidate) => modules.known.has(candidate)) ?? null;
}
