/**
 * The machine store of plugin dependency closures (madarch-64o5.72): a product's repository holds a starter plugin's
 * sources and `madarch/plugins.lock`, and the packages those sources import — the parsers the db-schema plugin reads SQL
 * with, and whatever else a plugin declares — live here, under the product's store, restored from the release that
 * carries them. A product's git therefore holds no third-party library code it did not choose, and a fresh clone runs
 * the same closure the lock names.
 *
 * A restoration is named by the hash of the closure it belongs to, so the folder a release restores is the one its hash
 * names: a newer release whose packages changed restores its own folder instead of writing over a copy a run has already
 * verified. Nothing is trusted because it stands there: `closureOf` hashes the restored files with the plugin's sources
 * and the lock comparison refuses a file that is not the one the release shipped, before any plugin process starts.
 *
 * A plugin folder that carries its own `node_modules` is left alone: a product that vendors its libraries chose those
 * bytes (the file class of madarch-64o5.66), and the store is read only for a folder that carries none.
 */
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { withSpanSync } from '../obs/trace.js';
import { bundledPluginById, type BundledPlugin } from './bundled.js';
import { closureOf, readPluginManifest, type Closure, type ClosureOptions } from './closure.js';
import { ClosureRefusal } from './closure-refusal.js';
import { PLUGINS_LOCK_FILE, type PluginLockEntry } from './lock.js';

const WHERE = 'src/plugin/dependency-store.ts';

/** The folder of a product's store the restorations stand under. */
export const DEPENDENCY_STORE_FOLDER = 'plugin-dependencies';

/** The folder one closure's dependency copy stands in, named by the hash of that closure. */
export function dependencyStoreFolder(store: string, hash: string): string {
  return join(resolve(store), DEPENDENCY_STORE_FOLDER, hash);
}

/**
 * Writes one release plugin's dependency closure into the store, and answers the folder it stands in. The folder is
 * named by the plugin's closure hash and written once: a copy that is already there is the release's own, and the run's
 * hash check is what refuses a file somebody changed — never a silent overwrite of bytes a person may have approved.
 */
export function restoreBundledDependencies(store: string, plugin: BundledPlugin): string {
  const folder = dependencyStoreFolder(store, plugin.hash);
  if (existsSync(folder)) return folder;
  const parent = dirname(folder);
  withSpanSync('fs.mkdir', { 'file.path': parent }, () => mkdirSync(parent, { recursive: true }));
  // A half-written folder would answer as a restoration and could never be made again: the copy is built beside it and
  // moved into place in one step, and a copy another process moved there first is the one used.
  const staging = withSpanSync('fs.mkdtemp', { 'file.path': parent }, () => mkdtempSync(join(parent, '.restoring-')));
  const removeStaging = (): void => { withSpanSync('fs.remove', { 'file.path': staging }, () => rmSync(staging, { recursive: true, force: true })); };
  try {
    // The declarations are the plugin's own `package.json`: the store resolves the packages it names, exactly as the
    // plugin's folder resolved them when the release carried them beside its code.
    withSpanSync('plugin.dependencies.restore', { 'file.path': folder, 'plugin.dependencies': plugin.dependencies.length + 1 }, () => {
      for (const file of [...plugin.files.filter((held) => held.path === 'package.json'), ...plugin.dependencies]) {
        const target = join(staging, file.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.content);
      }
    });
    try {
      renameSync(staging, folder);
    } catch (error) {
      if (!existsSync(folder)) throw error;
      removeStaging();
    }
    return folder;
  } catch (error) {
    removeStaging();
    throw new ClosureRefusal('plugin-dependencies', `${WHERE}:1: the dependency closure of the plugin ${plugin.id} could not be restored to ${folder}: ${(error as Error).message}`, folder);
  }
}

/**
 * The options one plugin folder's closure is read with: the machine store's copy of the release's declared dependencies
 * when the folder carries none, and nothing when the product carries its own packages or the release carries no such
 * plugin. A folder whose manifest names a plugin this release does not carry is read as it stands, and the closure's own
 * refusal then names the dependency the folder does not hold.
 */
export function closureOptionsFor(pluginFolder: string, store: string | undefined): ClosureOptions {
  if (store === undefined || existsSync(join(pluginFolder, 'node_modules'))) return {};
  let name: string;
  try { name = readPluginManifest(pluginFolder).name; } catch { return {}; }
  const plugin = bundledPluginById(name);
  if (plugin === undefined || plugin.dependencies.length === 0) return {};
  return { dependencies: restoreBundledDependencies(store, plugin) };
}

/**
 * The closure of one plugin the product's lock names, read with the dependencies the release restores into the store,
 * and refused when the hash of those bytes is not the locked one: a fill and a file's read execute exactly the closure
 * the lock names, and a changed closure needs a person's approval. The refusal names the plugin, its folder, the store
 * its dependencies came from and both hashes.
 */
export function lockedClosureOf(pluginFolder: string, locked: Pick<PluginLockEntry, 'id' | 'closure'>, store: string | undefined, where: string = WHERE): Closure {
  const options = closureOptionsFor(pluginFolder, store);
  const closure = closureOf(pluginFolder, options);
  if (closure.hash === locked.closure) return closure;
  const restored = options.dependencies === undefined ? '' : ` with its dependencies restored at ${options.dependencies}`;
  throw new ClosureRefusal('closure-lock', `${where}:1: the plugin ${locked.id} at ${pluginFolder}${restored} hashes to ${closure.hash}, and ${PLUGINS_LOCK_FILE} locks ${locked.closure}: a run executes exactly the closure the lock names, and a changed closure needs a person's approval`, join(pluginFolder, 'plugin.json'));
}
