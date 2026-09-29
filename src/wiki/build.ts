/**
 * The wiki build (docs/changes/wiki/capabilities/wiki.md, requirements
 * engine and result): loads and compiles a repository's model with the
 * shared loader, computes the engine-neutral pages, and hands them to the
 * chosen engine's writer, then runs that engine's build. Zensical runs as
 * `uvx zensical==0.0.66 build` (pinned) in the written project folder, and
 * the site it writes moves to `<out>/site`; the project itself stays at
 * `<out>/source`. Regenerating replaces both.
 *
 * Exit codes: 0 built (the site's path as the message); 1 the engine's
 * build failed (its output printed); 2 the input cannot be read — an
 * unknown engine, a repository or model that cannot be read (every error
 * with its file and line), or a missing toolchain. The engine is refused
 * and uv is checked before anything is written.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { loadAndCompileModel } from '../model/load-and-compile.js';
import { wikiPages } from './pages.js';
import { writeZensicalProject } from './zensical.js';

/** The pinned Zensical the engine runs, exactly as uvx names it. */
export const ZENSICAL_SPEC = 'zensical==0.0.66';

/** How the reader is told to get uv, in the refusal when it is missing. */
export const UV_INSTALL_HINT = 'install uv first, e.g. "curl -LsSf https://astral.sh/uv/install.sh | sh" (https://docs.astral.sh/uv/)';

export interface WikiBuildOptions {
  /** The `--engine` value; when absent the environment chooses, then zensical. */
  readonly engine?: string;
  /** The environment the engine choice reads; `process.env` by default. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface WikiBuildResult {
  readonly code: 0 | 1 | 2;
  /** The line to print: the built site's path on 0, the reason on 1 or 2. */
  readonly message: string;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function chooseEngine(explicit: string | undefined, env: Readonly<Record<string, string | undefined>>): WikiBuildResult | { engine: 'zensical' } {
  const chosen = explicit ?? env.MADARCH_WIKI_ENGINE ?? 'zensical';
  if (chosen === 'zensical') return { engine: 'zensical' };
  if (chosen === 'starlight') return { code: 2, message: 'the starlight wiki engine is not built yet: only zensical is implemented; leave the engine unset or pass --engine zensical' };
  return { code: 2, message: `unknown wiki engine "${chosen}": allowed engines are "zensical" and "starlight" (--engine or MADARCH_WIKI_ENGINE)` };
}

function runEngineBuild(source: string): { status: number | null; output: string; ran: boolean } {
  const build = spawnSync('uvx', [ZENSICAL_SPEC, 'build'], { cwd: source, encoding: 'utf8' });
  const ran = build.error === undefined;
  const output = ran ? `${build.stdout ?? ''}${build.stderr ?? ''}`.trim() : `uvx could not be run: ${build.error?.message}`;
  return { status: ran ? build.status : null, output, ran };
}

export function buildWiki(repoPath: string, outPath: string, options: WikiBuildOptions = {}): WikiBuildResult {
  const env = options.env ?? process.env;
  const chosen = chooseEngine(options.engine, env);
  if ('code' in chosen) return chosen;

  const repo = resolve(repoPath);
  if (!isDirectory(repo)) return { code: 2, message: `${repo} is not a directory: pass the path of a repository whose madarch/ folder holds the model` };

  const { model, errors } = loadAndCompileModel(repo);
  if (model === undefined) {
    return { code: 2, message: errors.map((error) => `error: ${error.file}:${error.line}: ${error.path}: ${error.message}`).join('\n') };
  }
  const pages = wikiPages(model);

  // Nothing has been written yet: a missing toolchain is still an unreadable input.
  const uv = spawnSync('uv', ['--version'], { stdio: 'ignore' });
  if (uv.error !== undefined || uv.status !== 0) {
    return { code: 2, message: `uv was not found on PATH: the zensical engine builds with "uvx ${ZENSICAL_SPEC} build"; ${UV_INSTALL_HINT}` };
  }

  const out = resolve(outPath);
  const source = join(out, 'source');
  const site = join(out, 'site');
  rmSync(source, { recursive: true, force: true });
  rmSync(site, { recursive: true, force: true });
  mkdirSync(source, { recursive: true });
  writeZensicalProject(pages, source, { siteName: basename(repo) });

  const build = runEngineBuild(source);
  if (!build.ran || build.status !== 0) return { code: 1, message: `the zensical build failed (exit ${build.status ?? 'unknown'}):\n${build.output}` };
  const built = join(source, 'site');
  if (!existsSync(built)) return { code: 1, message: `the zensical build wrote no site folder:\n${build.output}` };
  renameSync(built, site);
  return { code: 0, message: site };
}
