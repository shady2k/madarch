#!/usr/bin/env bun
/**
 * The plugin folders' own packages (madarch-47vw.3): a plugin's closure is the files its folder holds, its locked
 * packages included (`src/plugin/closure.ts`), and `src/plugin/bundled.ts` carries them into the binary. Bun's
 * workspaces would hoist a workspace's packages to the root `node_modules`, where the closure would not see them, so
 * each plugin that has a `package.json` is installed into its own folder instead.
 *
 * The root `package.json` runs this as its `postinstall`, so every place that installs the checkout — CI, the
 * release build, a person — gets the same plugin closures from the plugin's committed `package.json` and `bun.lock`;
 * no file of a dependency is committed and `.gitignore`'s `node_modules/` keeps them out of git.
 *
 * Bun's own bookkeeping is removed after the install: its binary links (`node_modules/.bin`) and the local artifact
 * cache (`node_modules/.cache`, written when the machine's cache cannot be linked from). A closure refuses a symbolic
 * link (`closure-symlink`), and a plugin loads its packages from the copied folder rather than from a PATH or a cache.
 * The install runs with `--ignore-scripts`: the parsers ship their files, and no dependency's own script runs here.
 *
 *   bun scripts/plugin-deps.ts [--check]
 *
 * `--check` names the folders whose packages are missing and writes nothing; without it every folder is installed.
 * Exit 0 installed (or every folder ready), 1 when an install failed or a folder is not ready.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const WHERE = 'scripts/plugin-deps.ts';
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every plugin folder that declares its own packages, in code point order of its name. */
export function pluginFolders(root: string = REPO_ROOT): string[] {
  const plugins = join(root, 'plugins');
  if (!existsSync(plugins)) return [];
  return readdirSync(plugins, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(plugins, entry.name, 'package.json')))
    .map((entry) => join(plugins, entry.name))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** Every symbolic link under a folder, so a closure reads only files that answer in the plugin's own tree. */
function symlinksUnder(folder: string): string[] {
  const found: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (lstatSync(path).isSymbolicLink()) found.push(path);
      else if (lstatSync(path).isDirectory()) visit(path);
    }
  };
  if (existsSync(folder)) visit(folder);
  return found;
}

/** Whether a folder's packages are installed: its `node_modules` stands and holds no link a closure refuses. */
export function pluginDepsReady(folder: string): boolean {
  return existsSync(join(folder, 'node_modules')) && symlinksUnder(join(folder, 'node_modules')).length === 0;
}

/** Installs one plugin folder's packages and removes the links a closure refuses. */
export function installPluginDeps(folder: string): void {
  const run = spawnSync(process.execPath, ['install', '--frozen-lockfile', '--ignore-scripts'], { cwd: folder, encoding: 'utf8' });
  if (run.status !== 0) {
    throw new Error(`${WHERE}:1: the packages of ${relative(REPO_ROOT, folder)} did not install (exit ${String(run.status)}): ${(run.stderr || run.stdout || '').trim()}`);
  }
  const modules = join(folder, 'node_modules');
  // Bun's links and its local artifact cache stand under `node_modules`; neither is a file of the plugin's closure.
  const links = symlinksUnder(modules);
  for (const name of ['.bin', '.cache']) rmSync(join(modules, name), { recursive: true, force: true });
  for (const link of links) rmSync(link, { force: true });
  console.log(`${WHERE}: ${relative(REPO_ROOT, folder)} installed${links.length === 0 ? '' : `, ${String(links.length)} link(s) removed`}`);
}

if (import.meta.main) {
  const check = process.argv.includes('--check');
  const folders = pluginFolders();
  const notReady = folders.filter((folder) => !pluginDepsReady(folder));
  if (check) {
    for (const folder of notReady) console.error(`${WHERE}:1: ${relative(REPO_ROOT, folder)} has no installed packages: run bun install at the repository root, or bun scripts/plugin-deps.ts`);
    process.exit(notReady.length === 0 ? 0 : 1);
  }
  for (const folder of folders) {
    try {
      installPluginDeps(folder);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }
}
