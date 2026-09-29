/**
 * The wiki build (docs/changes/wiki/capabilities/wiki.md, requirements
 * engine, diagrams and result): loads and compiles a repository's model
 * with the shared loader, renders the model's views with the shared
 * renderer (`renderModel` — no second renderer), computes the
 * engine-neutral pages with the diagrams the view set names, and hands them
 * to the chosen engine's writer, then runs that engine's build. The LikeC4
 * web component is generated from the rendered workspace with the pinned
 * `likec4`, and the pinned `mermaid`'s own runtime is copied into the
 * project, so the built site draws both formats without a CDN. Zensical
 * runs as `uvx zensical==0.0.66 build` (pinned) in the written project
 * folder, and the site it writes moves to `<out>/site`; the project itself
 * stays at `<out>/source`. Regenerating replaces both.
 *
 * The model is rendered at one version that never comes from the clock: the
 * repository's HEAD commit and its commit time when the folder is a git
 * work tree, else a fixed moment (`NO_REPO_TIME`), so the same input gives
 * the same pages.
 *
 * After the engine has built the site, every internal link of it is
 * checked against the built files and the anchors in them (requirement
 * `links`), engine-neutral so the Starlight writer reuses the check.
 *
 * Exit codes: 0 built (the site's path as the message); 1 the engine's
 * build failed (its output printed) or the built site carries broken links
 * (every one named, sorted by code point); 2 the input cannot be read — an
 * unknown engine or diagram format, a repository or model that cannot be
 * read or rendered (every error with its file and line), a missing
 * toolchain, or a built site whose files cannot be read. The choices are
 * refused and the toolchains are checked before anything is written.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAndCompileModel } from '../model/load-and-compile.js';
import type { MermaidPage } from '../render/mermaid.js';
import { renderModel, type RenderedVersion } from '../render/prepare.js';
import { brokenLinks, readSiteFiles } from './links.js';
import { wikiPages } from './pages.js';
import { writeZensicalProject, type WikiDiagramAsset } from './zensical.js';

/** The pinned Zensical the engine runs, exactly as uvx names it. */
export const ZENSICAL_SPEC = 'zensical==0.0.66';

/** How the reader is told to get uv, in the refusal when it is missing. */
export const UV_INSTALL_HINT = 'install uv first, e.g. "curl -LsSf https://astral.sh/uv/install.sh | sh" (https://docs.astral.sh/uv/)';

/**
 * The diagram formats the tabs offer; `archify` is a legal value of the
 * choice until the archify task builds it, and is refused for now.
 */
export type DiagramFormat = 'likec4' | 'mermaid';

/**
 * The moment a model outside a git work tree is rendered at:
 * 2026-01-01T00:00:00Z — fixed, so the same input still gives the same
 * pages, never the machine's clock.
 */
export const NO_REPO_TIME = Date.UTC(2026, 0, 1);

/** The madarch checkout the build runs from: where the pinned toolchains live. */
const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export interface WikiBuildOptions {
  /** The `--engine` value; when absent the environment chooses, then zensical. */
  readonly engine?: string;
  /** The environment the engine and diagram choices read; `process.env` by default. */
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

/**
 * The diagram tab shown first: what `MADARCH_WIKI_DIAGRAM` names, else
 * LikeC4. `archify` is accepted by the choice and refused until the
 * archify task builds it; any other value is refused naming the value and
 * the three allowed.
 */
function chooseDiagram(env: Readonly<Record<string, string | undefined>>): WikiBuildResult | { format: DiagramFormat } {
  const chosen = env.MADARCH_WIKI_DIAGRAM ?? 'likec4';
  if (chosen === 'likec4' || chosen === 'mermaid') return { format: chosen };
  if (chosen === 'archify') {
    return { code: 2, message: 'the archify wiki diagram is not built yet: only likec4 and mermaid are implemented; leave MADARCH_WIKI_DIAGRAM unset or set it to likec4 or mermaid' };
  }
  return { code: 2, message: `unknown wiki diagram format "${chosen}": allowed formats are "likec4", "mermaid" and "archify" (MADARCH_WIKI_DIAGRAM)` };
}

/**
 * The one version the model is rendered at, never from the clock: the
 * repository's HEAD commit and its commit time when the folder is in a git
 * work tree, else `no-git` at `NO_REPO_TIME`.
 */
function renderVersion(repo: string): RenderedVersion {
  const head = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const time = spawnSync('git', ['-C', repo, 'log', '-1', '--format=%ct'], { encoding: 'utf8' });
  const commit = head.status === 0 ? head.stdout.trim() : '';
  const seconds = time.status === 0 ? Number(time.stdout.trim()) : Number.NaN;
  if (commit.length > 0 && Number.isFinite(seconds)) return { source: repo, commit, at: seconds * 1000 };
  return { source: repo, commit: 'no-git', at: NO_REPO_TIME };
}

/**
 * What each view's tabs draw, from the renderer's own outputs: the LikeC4
 * view id from the workspace's view declarations, and the Mermaid source
 * and relation table from the matching Mermaid page. Both lists come in
 * the view set's order — the landscape first, then one view per element
 * with children in code point order — so the i-th declaration pairs with
 * the i-th page. Keyed by the view's scope, `''` for the landscape.
 */
function diagramAssets(mermaidPages: readonly MermaidPage[], workspace: string): Map<string, WikiDiagramAsset> {
  const viewIds = [...workspace.matchAll(/^ {2}view (\S+)(?: of \S+)? \{$/gm)].map((match) => match[1]!);
  if (viewIds.length !== mermaidPages.length) {
    throw new Error(`the rendered LikeC4 workspace holds ${viewIds.length} views but the renderer wrote ${mermaidPages.length} Mermaid pages: the renderer's outputs disagree`);
  }
  const assets = new Map<string, WikiDiagramAsset>();
  mermaidPages.forEach((page, index) => {
    const key = page.file === '_landscape.md' ? '' : page.file.replace(/\.md$/, '');
    assets.set(key, { likec4: viewIds[index]!, ...mermaidOfPage(page.content) });
  });
  return assets;
}

/**
 * One Mermaid page's diagram source and relation table, exactly as
 * madarch's page carries them: the lines of its mermaid fence, and the
 * `|`-lines after it — a header row, a separator, one row per arrow. A
 * view with no arrows has no table, and the table stays empty then.
 */
function mermaidOfPage(content: string): { mermaid: string; table: { columns: string[]; rows: string[][] } } {
  const open = content.indexOf('```mermaid\n');
  const from = open + '```mermaid\n'.length;
  const close = content.indexOf('\n```', from);
  if (open < 0 || close < 0) throw new Error('a rendered Mermaid page carries no mermaid fence');
  const tableLines: string[] = [];
  for (const line of content.slice(close + 4).split('\n')) {
    if (!line.startsWith('|')) {
      if (tableLines.length > 0) break;
      continue;
    }
    tableLines.push(line);
  }
  const cells = (line: string): string[] =>
    line
      .split(/(?<!\\)\|/)
      .slice(1, -1)
      .map((value) => value.replace(/\\([\\`*_[\]<>|])/g, '$1').trim());
  return {
    mermaid: content.slice(from, close),
    table:
      tableLines.length < 2
        ? { columns: [], rows: [] }
        : { columns: cells(tableLines[0]!), rows: tableLines.slice(2).map(cells) },
  };
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
  const diagram = chooseDiagram(env);
  if ('code' in diagram) return diagram;

  const repo = resolve(repoPath);
  if (!isDirectory(repo)) return { code: 2, message: `${repo} is not a directory: pass the path of a repository whose madarch/ folder holds the model` };

  const { model, errors } = loadAndCompileModel(repo);
  if (model === undefined) {
    return { code: 2, message: errors.map((error) => `error: ${error.file}:${error.line}: ${error.path}: ${error.message}`).join('\n') };
  }

  // The views, from the shared renderer at a version that never moves.
  const rendering = renderModel(model, renderVersion(repo));
  if (rendering.pages === undefined || rendering.workspace === undefined) {
    return { code: 2, message: ['the model cannot be rendered:', ...rendering.errors].join('\n') };
  }

  // Nothing has been written yet: a missing toolchain is still an unreadable input.
  const uv = spawnSync('uv', ['--version'], { stdio: 'ignore' });
  if (uv.error !== undefined || uv.status !== 0) {
    return { code: 2, message: `uv was not found on PATH: the zensical engine builds with "uvx ${ZENSICAL_SPEC} build"; ${UV_INSTALL_HINT}` };
  }
  const likec4Bin = join(PACKAGE_ROOT, 'node_modules', '.bin', 'likec4');
  if (!existsSync(likec4Bin)) {
    return { code: 2, message: `likec4 was not found at ${likec4Bin}: the wiki embeds the LikeC4 web component the pinned likec4 in devDependencies generates; run "bun install" in the madarch checkout` };
  }
  const mermaidDist = join(PACKAGE_ROOT, 'node_modules', 'mermaid', 'dist');
  if (!existsSync(join(mermaidDist, 'mermaid.esm.min.mjs'))) {
    return { code: 2, message: `the mermaid runtime was not found at ${join(mermaidDist, 'mermaid.esm.min.mjs')}: the wiki ships the pinned mermaid's own runtime; run "bun install" in the madarch checkout` };
  }

  // The pages, with the views the renderer produced: every page's diagram
  // names one of them, or the landscape.
  const pages = wikiPages(
    model,
    rendering.pages.filter((page) => page.file !== '_landscape.md').map((page) => page.file.replace(/\.md$/, '')),
  );

  // The LikeC4 web component, generated from the rendered workspace. The
  // scratch folder is named after the workspace's content, because the
  // generated bundle embeds ids the tool derives from the folder's path:
  // the same workspace always generates the same bytes, wherever the site
  // is built, and two builds of one model share the folder harmlessly,
  // writing the same bytes into it.
  const scratch = join(tmpdir(), `madarch-wiki-likec4-${createHash('sha256').update(rendering.workspace).digest('hex').slice(0, 16)}`);
  mkdirSync(scratch, { recursive: true });
  writeFileSync(join(scratch, 'model.c4'), rendering.workspace);
  const gen = spawnSync(likec4Bin, ['gen', 'webcomponent', scratch, '-o', join(scratch, 'likec4-view.js')], { encoding: 'utf8' });
  if (gen.status !== 0 || !existsSync(join(scratch, 'likec4-view.js'))) {
    return { code: 2, message: `the LikeC4 web component could not be generated:\n${`${gen.stdout ?? ''}${gen.stderr ?? ''}`.trim()}` };
  }

  const diagrams = diagramAssets(rendering.pages, rendering.workspace);
  const out = resolve(outPath);
  const source = join(out, 'source');
  const site = join(out, 'site');
  rmSync(source, { recursive: true, force: true });
  rmSync(site, { recursive: true, force: true });
  mkdirSync(source, { recursive: true });
  writeZensicalProject(pages, source, { siteName: basename(repo), diagrams, firstTab: diagram.format });
  const assets = join(source, 'docs', 'assets');
  mkdirSync(join(assets, 'mermaid', 'chunks'), { recursive: true });
  cpSync(join(scratch, 'likec4-view.js'), join(assets, 'likec4-view.js'));
  cpSync(join(mermaidDist, 'mermaid.esm.min.mjs'), join(assets, 'mermaid', 'mermaid.esm.min.mjs'));
  cpSync(join(mermaidDist, 'chunks', 'mermaid.esm.min'), join(assets, 'mermaid', 'chunks', 'mermaid.esm.min'), { recursive: true });

  const build = runEngineBuild(source);
  if (!build.ran || build.status !== 0) return { code: 1, message: `the zensical build failed (exit ${build.status ?? 'unknown'}):\n${build.output}` };
  const built = join(source, 'site');
  if (!existsSync(built)) return { code: 1, message: `the zensical build wrote no site folder:\n${build.output}` };
  renameSync(built, site);
  // The engine's build cache is its own byproduct, not the project the pages
  // wrote: remove it, so source/ holds exactly the project and two runs of
  // the same model leave byte-identical trees.
  rmSync(join(source, '.cache'), { recursive: true, force: true });

  // The link check (requirement links): the engine has built the site, so
  // every internal link of it must open a page, an asset or an anchor the
  // site holds — a page whose link leads nowhere fails the build, naming
  // every one of them. A site that cannot be read stays an unreadable input.
  let siteFiles: Map<string, string>;
  try {
    siteFiles = readSiteFiles(site);
  } catch (error) {
    return { code: 2, message: error instanceof Error ? error.message : String(error) };
  }
  const broken = brokenLinks(siteFiles);
  if (broken.length > 0) {
    return {
      code: 1,
      message: ['the built site carries broken links:', ...broken.map((link) => `${link.page}: "${link.link}" — ${link.problem}`)].join('\n'),
    };
  }
  return { code: 0, message: site };
}
