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
 * folder; Starlight builds from the template in `wiki/starlight/` with
 * `bun run build`, its install cached outside the repository. The site
 * the engine writes moves to `<out>/site`; the project itself stays at
 * `<out>/source`. Regenerating replaces both.
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
 * refused and the chosen engine's toolchain is checked before anything is
 * written.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAndCompileModel } from '../model/load-and-compile.js';
import type { MermaidPage } from '../render/mermaid.js';
import { renderModel, type RenderedVersion } from '../render/prepare.js';
import { brokenLinks, readSiteFiles } from './links.js';
import { documentImages, documentPages, DocumentLinkError } from './documents.js';
import { archifyDocument, archifyPageLinks, componentId, type ArchifyDocument, type ArchifyLayoutedView, type LayoutPoint } from './archify.js';
import { wikiPages, type AnyWikiPage, type WikiDocumentPage } from './pages.js';
import type { WikiDiagramAsset } from './render.js';
import { cleanStarlightSource, ensureStarlightInstall, linkStarlightNodeModules, STARLIGHT_CACHE_ROOT, STARLIGHT_TEMPLATE_DIR, writeStarlightProject } from './starlight.js';
import { writeZensicalProject } from './zensical.js';

/** The pinned Zensical the engine runs, exactly as uvx names it. */
export const ZENSICAL_SPEC = 'zensical==0.0.66';

/** How the reader is told to get uv, in the refusal when it is missing. */
export const UV_INSTALL_HINT = 'install uv first, e.g. "curl -LsSf https://astral.sh/uv/install.sh | sh" (https://docs.astral.sh/uv/)';

/** The diagram formats the tabs offer: LikeC4's own view, madarch's Mermaid, and archify's page laid out from LikeC4. */
export type DiagramFormat = 'likec4' | 'mermaid' | 'archify';

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

/** The wiki engine a build runs: the writer, the toolchain and the build command change with it. */
type Engine = 'zensical' | 'starlight';

function chooseEngine(explicit: string | undefined, env: Readonly<Record<string, string | undefined>>): WikiBuildResult | { engine: Engine } {
  const chosen = explicit ?? env.MADARCH_WIKI_ENGINE ?? 'zensical';
  if (chosen === 'zensical' || chosen === 'starlight') return { engine: chosen };
  return { code: 2, message: `unknown wiki engine "${chosen}": allowed engines are "zensical" and "starlight" (--engine or MADARCH_WIKI_ENGINE)` };
}

/**
 * The diagram tab shown first: what `MADARCH_WIKI_DIAGRAM` names, else
 * LikeC4. Any unknown value is refused naming the value and the three
 * allowed.
 */
function chooseDiagram(env: Readonly<Record<string, string | undefined>>): WikiBuildResult | { format: DiagramFormat } {
  const chosen = env.MADARCH_WIKI_DIAGRAM ?? 'likec4';
  if (chosen === 'likec4' || chosen === 'mermaid' || chosen === 'archify') return { format: chosen };
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
    assets.set(key, { likec4: viewIds[index]!, archify: archifyAssetName(key), ...mermaidOfPage(page.content) });
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

/** The vendored renderer the archify pages are made with, pinned at 3.0.1 (vendor/archify/README.md). */
const ARCHIFY_RENDERER = join(PACKAGE_ROOT, 'vendor', 'archify', 'renderers', 'architecture', 'render-architecture.mjs');

/** The file name of a view's archify page under the site's `assets/archify/`. */
function archifyAssetName(scope: string): string {
  return scope === '' ? 'landscape.html' : `${scope}.html`;
}

/**
 * The element each element view is of, as LikeC4 spells it: the workspace's
 * own `view <id> of <full name> {` declarations — the same lines the view
 * pairing above reads, plus the full name. The landscape carries none. A
 * node's full name in the layouted view is the key this map answers.
 */
function viewScopeFullNames(workspace: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const match of workspace.matchAll(/^ {2}view (\S+) of (\S+) \{$/gm)) names.set(match[1]!, match[2]!);
  return names;
}

/**
 * The layout LikeC4 computed for every view of the workspace: node
 * positions, sizes, groups and edges, exactly what the archify document
 * is built from. A view the layout pass skipped is an error naming it.
 */
async function layoutedViews(workspace: string): Promise<Map<string, ArchifyLayoutedView>> {
  const { LikeC4 } = await import('likec4');
  const likec4 = await LikeC4.fromSource(workspace, { logger: false, printErrors: false, throwIfInvalid: true });
  try {
    const views = new Map<string, ArchifyLayoutedView>();
    for (const diagram of (await likec4.diagrams()) as unknown as ReadonlyArray<Record<string, unknown>>) {
      const id = diagram.id as string;
      const nodes = (diagram.nodes as ReadonlyArray<Record<string, unknown>>).map((node) => ({
        id: node.id as string,
        kind: (node.kind as string | undefined) ?? 'external',
        title: node.title as string,
        parent: (node.parent as string | null) ?? null,
        x: node.x as number,
        y: node.y as number,
        width: node.width as number,
        height: node.height as number,
      }));
      const edges = (diagram.edges as ReadonlyArray<Record<string, unknown>>).map((edge) => ({
        source: edge.source as string,
        target: edge.target as string,
        ...(edge.label === undefined ? {} : { label: edge.label as string }),
        ...(edge.labelBBox === undefined
          ? {}
          : {
              labelAt: [
                (edge.labelBBox as { x: number; y: number; width: number; height: number }).x + (edge.labelBBox as { width: number }).width / 2,
                (edge.labelBBox as { x: number; y: number; height: number }).y + (edge.labelBBox as { height: number }).height / 2,
              ] as LayoutPoint,
            }),
      }));
      views.set(id, { id, title: diagram.title as string, nodes, edges });
    }
    return views;
  } finally {
    await likec4[Symbol.asyncDispose]?.();
  }
}

/** Renders one archify document with the vendored renderer: document in, self-contained page out. */
function renderArchifyPage(document: ArchifyDocument, input: string, output: string): { status: number | null; output: string } {
  writeFileSync(input, JSON.stringify(document));
  const run = spawnSync('node', [ARCHIFY_RENDERER, input, output], { encoding: 'utf8' });
  return { status: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}`.trim() };
}

function runZensicalBuild(source: string): { status: number | null; output: string; ran: boolean } {
  const build = spawnSync('uvx', [ZENSICAL_SPEC, 'build'], { cwd: source, encoding: 'utf8' });
  return finish(build, 'uvx');
}

function runStarlightBuild(source: string): { status: number | null; output: string; ran: boolean } {
  // Astro's telemetry is off: the build reports to the reader, not to a
  // service, and stays quiet and deterministic.
  const build = spawnSync('bun', ['run', 'build'], { cwd: source, encoding: 'utf8', env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' } });
  return finish(build, 'bun');
}

function finish(build: ReturnType<typeof spawnSync>, tool: string): { status: number | null; output: string; ran: boolean } {
  const ran = build.error === undefined;
  const output = ran ? `${build.stdout ?? ''}${build.stderr ?? ''}`.trim() : `${tool} could not be run: ${build.error?.message}`;
  return { status: ran ? build.status : null, output, ran };
}

export async function buildWiki(repoPath: string, outPath: string, options: WikiBuildOptions = {}): Promise<WikiBuildResult> {
  // A reusable entry point (the server calls it too): an empty output value
  // would resolve to the current directory and be cleared below. The command
  // line refuses it earlier, with the usage; this guard stands behind it.
  if (outPath.trim() === '') return { code: 2, message: 'the output folder is empty: pass the folder the wiki is built into, e.g. --out <folder>' };
  const env = options.env ?? process.env;
  const chosen = chooseEngine(options.engine, env);
  if ('code' in chosen) return chosen;
  const engine = chosen.engine;
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

  // Nothing has been written yet: a missing toolchain is still an unreadable
  // input. Each engine brings its own: uv for Zensical, bun and a template
  // install for Starlight.
  let installedProject: string | undefined;
  if (engine === 'zensical') {
    const uv = spawnSync('uv', ['--version'], { stdio: 'ignore' });
    if (uv.error !== undefined || uv.status !== 0) {
      return { code: 2, message: `uv was not found on PATH: the zensical engine builds with "uvx ${ZENSICAL_SPEC} build"; ${UV_INSTALL_HINT}` };
    }
  } else {
    const install = ensureStarlightInstall(STARLIGHT_TEMPLATE_DIR, STARLIGHT_CACHE_ROOT);
    if (!install.ok) return { code: 2, message: install.message };
    installedProject = install.project;
  }
  const likec4Bin = join(PACKAGE_ROOT, 'node_modules', '.bin', 'likec4');
  if (!existsSync(likec4Bin)) {
    return { code: 2, message: `likec4 was not found at ${likec4Bin}: the wiki embeds the LikeC4 web component the pinned likec4 in devDependencies generates; run "bun install" in the madarch checkout` };
  }
  const mermaidDist = join(PACKAGE_ROOT, 'node_modules', 'mermaid', 'dist');
  if (!existsSync(join(mermaidDist, 'mermaid.esm.min.mjs'))) {
    return { code: 2, message: `the mermaid runtime was not found at ${join(mermaidDist, 'mermaid.esm.min.mjs')}: the wiki ships the pinned mermaid's own runtime; run "bun install" in the madarch checkout` };
  }
  const nodeBin = spawnSync('node', ['--version'], { stdio: 'ignore' });
  if (nodeBin.error !== undefined || nodeBin.status !== 0) {
    return { code: 2, message: 'node was not found on PATH: the wiki renders the archify pages with the archify renderer vendored at vendor/archify; install Node.js (https://nodejs.org/)' };
  }

  // The pages, with the views the renderer produced: every page's diagram
  // names one of them, or the landscape.
  const pages = wikiPages(
    model,
    rendering.pages.filter((page) => page.file !== '_landscape.md').map((page) => page.file.replace(/\.md$/, '')),
  );

  // The repository's own documents, beside the model's pages. A broken
  // document link fails the build here, before anything is written,
  // naming every document and the target it misses (requirement links);
  // a document that cannot be read is an unreadable input.
  let documents: readonly WikiDocumentPage[];
  try {
    documents = documentPages(repo);
  } catch (error) {
    if (error instanceof DocumentLinkError) return { code: 1, message: error.message };
    return { code: 2, message: error instanceof Error ? error.message : String(error) };
  }
  const allPages: readonly AnyWikiPage[] = [...pages, ...documents];

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
  // The archify page per view: the layout LikeC4 computed for that view,
  // one architecture document built from it, rendered by the vendored
  // renderer, then the drill-down links put on the components whose
  // element has a view of its own. A render failure is an unreadable
  // input, its output printed.
  const archifyPages: { name: string; html: string }[] = [];
  try {
    const layouted = await layoutedViews(rendering.workspace);
    const scopeFullNames = viewScopeFullNames(rendering.workspace);
    const archifyDir = join(scratch, 'archify');
    mkdirSync(archifyDir, { recursive: true });
    for (const [scope, asset] of diagrams) {
      const view = layouted.get(asset.likec4);
      const named = scope === '' ? 'the landscape' : `the view of "${scope}"`;
      if (view === undefined) {
        return { code: 2, message: `LikeC4 did not lay out ${named} (the view "${asset.likec4}"): the archify page needs every view laid out` };
      }
      const name = archifyAssetName(scope);
      const document = archifyDocument(view, { output: `assets/archify/${name}` });
      const links: Record<string, string> = {};
      for (const node of view.nodes) {
        for (const [other, fullName] of scopeFullNames) {
          if (other !== scope && fullName === node.id) links[componentId(node.id)] = archifyAssetName(other);
        }
      }
      const rendered = renderArchifyPage(document, join(archifyDir, `${name}.json`), join(archifyDir, name));
      if (rendered.status !== 0 || !existsSync(join(archifyDir, name))) {
        return { code: 2, message: `the archify page for ${named} could not be rendered:\n${rendered.output}` };
      }
      archifyPages.push({ name, html: archifyPageLinks(readFileSync(join(archifyDir, name), 'utf8'), links) });
    }
  } catch (error) {
    // The layout pass, the document builder and the drill-down links are
    // in-process and throw; the result contract stays intact: exit 2,
    // the reason printed, nothing written.
    return { code: 2, message: `the archify pages could not be built:\n${error instanceof Error ? error.message : String(error)}` };
  }
  const out = resolve(outPath);
  const source = join(out, 'source');
  const site = join(out, 'site');
  rmSync(source, { recursive: true, force: true });
  rmSync(site, { recursive: true, force: true });
  mkdirSync(source, { recursive: true });
  const siteOptions = { siteName: basename(repo), diagrams, firstTab: diagram.format };
  if (engine === 'zensical') writeZensicalProject(allPages, source, siteOptions);
  else writeStarlightProject(allPages, source, siteOptions);
  // The diagram assets ride where the engine serves static files from:
  // Zensical's project docs/, Starlight's public/.
  const assets = join(source, engine === 'zensical' ? join('docs', 'assets') : join('public', 'assets'));
  mkdirSync(join(assets, 'mermaid', 'chunks'), { recursive: true });
  cpSync(join(scratch, 'likec4-view.js'), join(assets, 'likec4-view.js'));
  mkdirSync(join(assets, 'archify'), { recursive: true });
  for (const page of archifyPages) writeFileSync(join(assets, 'archify', page.name), page.html);
  cpSync(join(mermaidDist, 'mermaid.esm.min.mjs'), join(assets, 'mermaid', 'mermaid.esm.min.mjs'));
  cpSync(join(mermaidDist, 'chunks', 'mermaid.esm.min'), join(assets, 'mermaid', 'chunks', 'mermaid.esm.min'), { recursive: true });
  // The documents' images, copied where their rewritten links point: the
  // same documents asset route both writers spell, under this engine's
  // static folder. Copied as file content, dereferenced: a symlinked image
  // never becomes a link in the built tree.
  for (const image of documentImages(documents)) {
    const file = join(assets, 'documents', image);
    mkdirSync(dirname(file), { recursive: true });
    cpSync(join(repo, image), file, { dereference: true });
  }

  if (engine === 'starlight') linkStarlightNodeModules(installedProject!, source);
  const build = engine === 'zensical' ? runZensicalBuild(source) : runStarlightBuild(source);
  if (!build.ran || build.status !== 0) return { code: 1, message: `the ${engine} build failed (exit ${build.status ?? 'unknown'}):\n${build.output}` };
  const built = join(source, 'site');
  if (!existsSync(built)) return { code: 1, message: `the ${engine} build wrote no site folder:\n${build.output}` };
  renameSync(built, site);
  // The engine's build cache and link are its own byproducts, not the
  // project the pages wrote: remove them, so source/ holds exactly the
  // project and two runs of the same model leave byte-identical trees.
  if (engine === 'zensical') rmSync(join(source, '.cache'), { recursive: true, force: true });
  else cleanStarlightSource(source);

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
