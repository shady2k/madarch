/**
 * The wiki app's built files and the decision to build them (madarch-rtr.2.3;
 * the capability product-wiki's requirement `app`): when the app's `dist` is
 * absent, the command builds it once, saying so on standard output before the
 * build starts, and never builds again while the dist is there. A build that
 * fails is a refusal carrying the builder's own words.
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
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The checkout's own app folder: `wiki/app` from a module two folders below the root. */
const CHECKOUT_APP: string = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'wiki', 'app');

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
  if (existsSync(join(dist, 'index.html'))) return { ok: true, dist, appFolder, built: false };
  const buildCommand = options.buildCommand?.trim() || env.MADARCH_APP_BUILD?.trim() || DEFAULT_BUILD_COMMAND;
  say(`building the wiki app in ${appFolder}: the dist ${JSON.stringify(dist)} does not hold index.html yet`);
  const build = spawnSync('sh', ['-c', buildCommand], { cwd: appFolder, encoding: 'utf8' });
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
  return { ok: true, dist, appFolder, built: true };
}
