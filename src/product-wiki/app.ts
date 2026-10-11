/**
 * The wiki app's built files and the decision to build them (madarch-rtr.2.3;
 * the capability product-wiki's requirement `app`): when the app's `dist` is
 * absent, the command builds it once, saying so on standard output before the
 * build starts. The dist is built once by the command and then compared
 * against the app's sources instead of trusted: at build time the command
 * records a hash of the app's sources and lockfile into the dist, and on
 * every later start it compares the hash against them — the same sources
 * stand unrebuilt, sources changed since the build are built again with a
 * one-line notice first. A dist holding no hash record (built by hand) is
 * served as it stands. A build that fails is a refusal carrying the
 * builder's own words.
 *
 * The build runs in the app folder in madarch's own checkout, `wiki/app`
 * beside the sources, with `bun install --frozen-lockfile && bun run build`
 * there; what it lays is served from `wiki/app/dist`, never from inside a
 * product. The app folder and the build step are injectable: the command
 * reads them from the environment (MADARCH_APP and MADARCH_APP_BUILD), the
 * machine's checkout and the real build by default, and tests exercise the
 * decision through the same two seams, running neither bun nor a registry.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The checkout's own app folder: `wiki/app` from a module two folders below the root. */
const CHECKOUT_APP: string = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'wiki', 'app');

/** The stamp file inside the dist that carries the hash of the sources built. */
const STAMP = '.sources-hash';

/** The folders inside the app folder that are not its sources: the build's own output and laid packages. */
const NOT_SOURCES = new Set(['dist', 'node_modules', '.git']);

/** The features the command names the app's build by, on the command line and in the sources. */
export interface AppBuildOptions {
  /** The app folder whose built files the wiki is served from; the checkout's own `wiki/app` by default. */
  appFolder?: string;
  /** The whole build step, run in the app folder; `bun install --frozen-lockfile && bun run build` by default. */
  buildCommand?: string;
  /** The environment the two falls-backs are read from, or the process's. */
  env?: Readonly<Record<string, string | undefined>>;
}

export type EnsureBuilt =
  | { ok: true; dist: string; appFolder: string; built: boolean }
  | { ok: false; message: string };

/** What the real build is: the two steps, install then build, in the app folder. */
const DEFAULT_BUILD_COMMAND = 'bun install --frozen-lockfile && bun run build';

/** Walks the app folder's own files (sources and lockfile), skipping what the build lays. */
function sourceFiles(appFolder: string): string[] {
  const files: string[] = [];
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (NOT_SOURCES.has(entry.name)) continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  walk(appFolder);
  return files;
}

/** The hash naming the app's sources: every source file's relative path and content. */
export function sourcesHash(appFolder: string): string {
  const hash = createHash('sha256');
  for (const path of sourceFiles(appFolder)) {
    hash.update(JSON.stringify(path.slice(appFolder.length)));
    hash.update(readFileSync(path));
  }
  return hash.digest('hex');
}

/**
 * Makes sure the app's built files are there, building them once when the
 * `dist` is absent. The notice of a build — one line on standard output,
 * before the build starts — is printed by the caller's `say`, so the
 * decision and its telling stay one fact apart.
 */
export function ensureBuilt(options: AppBuildOptions = {}, say: (line: string) => void = (line) => void line): EnsureBuilt {
  const env = options.env ?? process.env;
  const appFolder = options.appFolder?.trim() || env.MADARCH_APP?.trim() || CHECKOUT_APP;
  const dist = join(appFolder, 'dist');
  const buildCommand = options.buildCommand?.trim() || env.MADARCH_APP_BUILD?.trim() || DEFAULT_BUILD_COMMAND;
  const stampPath = join(dist, STAMP);
  if (existsSync(join(dist, 'index.html'))) {
    // A dist from outside the command (no hash record) is trusted as built.
    if (!existsSync(stampPath)) return { ok: true, dist, appFolder, built: false };
    const recorded = readFileSync(stampPath, 'utf8').trim();
    let current: string;
    try {
      current = sourcesHash(appFolder);
    } catch {
      // The app folder cannot be read — whatever would be built there cannot
      // run either, so the dist already in place is what this run serves.
      return { ok: true, dist, appFolder, built: false };
    }
    if (current === recorded) return { ok: true, dist, appFolder, built: false };
    say(`rebuilding the wiki app in ${appFolder}: its sources changed since the dist was built`);
  } else {
    say(`building the wiki app in ${appFolder}: the dist ${JSON.stringify(dist)} does not hold index.html yet`);
  }
  const build = spawnSync('sh', ['-c', buildCommand], { cwd: appFolder, encoding: 'utf8' });
  if (build.error !== undefined) {
    // The step could not be run at all — a missing shell, a folder that is
    // not there: the cause is named, never folded into `exit null`.
    return {
      ok: false,
      message: `the wiki app could not be built with ${buildCommand}, run in ${appFolder}: the build could not be launched (${build.error.message})`,
    };
  }
  if (build.status !== 0) {
    const said = `${build.stdout ?? ''}${build.stderr ?? ''}`.trim();
    return {
      ok: false,
      message: `the wiki app could not be built with ${buildCommand}, run in ${appFolder} (exit ${String(build.status)})${said === '' ? '.' : ':\n' + said}`,
    };
  }
  if (!existsSync(join(dist, 'index.html'))) {
    return {
      ok: false,
      message: `the build ${buildCommand} finished in ${appFolder} but left no index.html at ${JSON.stringify(dist)}: nothing to serve the wiki from`,
    };
  }
  let sources: string;
  try {
    sources = sourcesHash(appFolder);
  } catch {
    // The sources cannot be read for a record; the build just produced the
    // dist, and without a record the next start trusts it as built.
    return { ok: true, dist, appFolder, built: true };
  }
  writeFileSync(stampPath, sources);
  return { ok: true, dist, appFolder, built: true };
}
