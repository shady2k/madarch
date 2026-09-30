/**
 * The Starlight engine's writer: turns the engine-neutral pages
 * (src/wiki/pages.ts) into a Starlight (Astro) project from the template
 * in `wiki/starlight/` — one Markdown file per page under
 * `src/content/docs/`, the site's title and sidebar generated into
 * `src/generated/site.mjs` for the template's `astro.config.mjs`, and the
 * diagram tabs' stylesheet and module written where the template serves
 * them from. The page bodies, the tab markup and the nav tree come from
 * the shared render module; this writer adds what Starlight owns: root
 * relative route links, heading anchors slugged the way GitHub slugs (the
 * engine's own rule, mirrored), and the sidebar. The repository's
 * documents are pages of the same layout, their file names slugged the
 * way the engine slugs them onto routes. The engine itself runs later:
 * the template is installed once with bun into the wiki's per-user cache
 * root (src/wiki/cache.ts), the build symlinks that install's
 * `node_modules` into the written project and runs `bun run build` there.
 *
 * Deterministic: the same pages and options give the same bytes — no
 * clock, and every sort stays on code points.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDocumentPage, type AnyWikiPage } from './pages.js';
import { pagePath } from './pages-path.js';
import { byCodePoint } from './pages.js';
import { SLUGGER_REGEX } from './github-slugger-regex.js';
import { diagramModuleJs, navTree, preparePages, renderDocumentBody, renderPageBody, TABS_CSS, type NavEntry, type WriterLinks, type WikiRenderOptions } from './render.js';

/** The madarch checkout the build runs from: where the template lives. */
const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The Starlight project template the writer copies every project from. */
export const STARLIGHT_TEMPLATE_DIR = join(PACKAGE_ROOT, 'wiki', 'starlight');

/**
 * The heading anchor Starlight's Markdown pipeline spells for a heading's
 * text: github-slugger's rule exactly — lowercased, the vendored
 * character class dropped, every remaining space a dash. Not trimmed and
 * not collapsed on purpose: it must match the engine, not be tidy.
 */
export function starlightSlug(text: string): string {
  return text.toLowerCase().replace(SLUGGER_REGEX, '').replace(/ /g, '-');
}

/**
 * The slug Starlight's content loader gives a page path: every path
 * segment slugged by the same rule, joined with `/`, a trailing `index`
 * segment dropped — Astro's own `getContentEntryIdAndSlug` slugs each
 * segment and strips a trailing `/index`, so the sidebar's entries and
 * the routes must be spelled exactly so. Model page ids are lower-case
 * words that pass through unchanged; documents carry the repository's
 * file names, `README.md` included.
 */
function sluggedDocumentPath(path: string): string {
  const slug = path.split('/').map(starlightSlug).join('/');
  return slug.endsWith('/index') ? slug.slice(0, -'/index'.length) : slug;
}

/** The route a page's file is served at in the built site: its page path, extensionless, from the root. */
export function pageRoute(id: string): string {
  if (id === 'home') return '/';
  const path = pagePath(id).replace(/\.md$/, '');
  if (id.startsWith('document/')) return `/${sluggedDocumentPath(path)}/`;
  return `/${path}/`;
}

/** Where a Starlight link points and how its anchors are spelled. */
export const starlightLinks: WriterLinks = {
  pathOf: pageRoute,
  slugOf: starlightSlug,
};

/** One entry of Starlight's sidebar: a doc by its slug, a link, or a group. */
export type StarlightSidebarItem = string | { readonly label: string; readonly link: string } | { readonly label: string; readonly items: readonly StarlightSidebarItem[] };

function sidebarEntry(entry: NavEntry): StarlightSidebarItem {
  if ('path' in entry) {
    const path = entry.path.replace(/\.md$/, '');
    // A document's sidebar entry is the slug the engine serves it at.
    return path.startsWith('documents/') ? sluggedDocumentPath(path) : path;
  }
  return { label: entry.title, items: entry.children.map(sidebarEntry) };
}

/**
 * The sidebar from the shared nav tree: the home page as a link first,
 * then one group per section — the same structure the Zensical nav
 * renders, so both engines read the same.
 */
export function starlightSidebar(pages: readonly AnyWikiPage[]): readonly StarlightSidebarItem[] {
  return [
    { label: 'Home', link: pageRoute('home') },
    ...navTree(pages).map((section) => ({ label: section.title, items: section.entries.map(sidebarEntry) })),
  ];
}

/** A page's Starlight frontmatter: the title the sidebar and the browser name the page by. */
function frontmatter(page: AnyWikiPage): string {
  const title = `"${page.title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return `---\ntitle: ${title}\n---\n`;
}

/**
 * The body's own first-level title: the engine renders the frontmatter
 * title as the page heading already, and the same text again as the body's
 * first `# heading` would name every page twice. Only a leading level-1
 * heading matches — a body opening `## deeper` keeps its line, and a
 * level-1 heading after content is content.
 */
const LEADING_TITLE = /^#[ \t]+[^\n]*\n(?:[ \t]*\n)?/;

/** Where the diagram tabs' module finds the Mermaid runtime the build ships: beside it under public/. */
const MERMAID_IMPORT = './assets/mermaid/mermaid.esm.min.mjs';

/**
 * The stylesheet's Starlight own head: the banner and the rule that makes
 * the engine's content pane (`.main-pane`) the container the LikeC4
 * panel breaks out to. The tab rules shared by both engines follow.
 */
const STARLIGHT_CSS_HEAD: readonly string[] = [
  '/* Generated by madarch (scripts/wiki.ts) — edit the generator, not this file. */',
  '/* The LikeC4 panel is framed by the content area of the page (the',
  '   .main-pane of the engine), not by the text column: it breaks out to',
  '   exactly that area, centred, so the view stays on the page at any',
  '   width and the fitted diagram scales as large as the area allows.',
  '   The container query measures the pane wherever Starlight puts it;',
  '   without it the panel simply fills the text column. Comments here',
  '   are CSS block comments: a // line is not a comment in CSS, and the',
  '   parser eats the rule after it. */',
  '.main-pane {',
  '  container-type: inline-size;',
  '}',
];

/**
 * Writes the Starlight project for `pages` into `projectDir` (created):
 * the template's own files, `src/content/docs/<page path>.md` for every
 * page — the model pages rendered from their blocks, the repository's
 * documents from their own Markdown, links rewritten, each under its
 * frontmatter — the generated `src/generated/site.mjs` (title and
 * sidebar, which the template's `astro.config.mjs` imports), the diagram
 * tabs' stylesheet under `src/styles/` and their module under `public/` —
 * the LikeC4 web component, the Mermaid runtime and the documents'
 * images are the build's to ship into `public/assets/`. Throws when a
 * link names a page or a heading the set does not hold, or a diagram
 * block names a view the diagrams map does not — a broken page never
 * reaches the engine.
 */
export function writeStarlightProject(pages: readonly AnyWikiPage[], projectDir: string, options: StarlightSiteOptions): void {
  cpSync(STARLIGHT_TEMPLATE_DIR, projectDir, {
    recursive: true,
    filter: (source) => !source.slice(STARLIGHT_TEMPLATE_DIR.length).split(/[\\/]/).includes('node_modules'),
  });
  const prepared = preparePages(pages);
  for (const page of pages) {
    const file = join(projectDir, 'src', 'content', 'docs', pagePath(page.id));
    mkdirSync(dirname(file), { recursive: true });
    const body = isDocumentPage(page) ? renderDocumentBody(page, starlightLinks) : renderPageBody(page, options, prepared, starlightLinks);
    // Where the body's own title heading was, an invisible anchor keeps
    // the title's slug: links aimed at the page's title heading must
    // still land, and the engine's own h1 (from the frontmatter) carries
    // the engine's `_top` id, not this slug. A slug holds only letters,
    // digits, underscores and dashes, so it is safe as an id as it is.
    writeFileSync(file, `${frontmatter(page)}<span id="${starlightSlug(page.title)}"></span>\n\n${body.replace(LEADING_TITLE, '')}`);
  }
  const site = { title: options.siteName, sidebar: starlightSidebar(pages) };
  mkdirSync(join(projectDir, 'src', 'generated'), { recursive: true });
  writeFileSync(
    join(projectDir, 'src', 'generated', 'site.mjs'),
    `// Generated by madarch (scripts/wiki.ts) — edit the generator, not this file.\nexport const site = ${JSON.stringify(site, null, 2)};\n`,
  );
  mkdirSync(join(projectDir, 'src', 'styles'), { recursive: true });
  writeFileSync(join(projectDir, 'src', 'styles', 'wiki.css'), [...STARLIGHT_CSS_HEAD, ...TABS_CSS].join('\n'));
  writeFileSync(join(projectDir, 'public', 'wiki-diagram.mjs'), diagramModuleJs(MERMAID_IMPORT));
}

export interface StarlightSiteOptions extends WikiRenderOptions {
  /** The site's name, as Starlight's `title`. */
  readonly siteName: string;
}

/** The astro shim a cache folder must carry — and it must answer `--version` — for the install to count as working. */
const INSTALL_MARKER = join('node_modules', '.bin', 'astro');

/**
 * Whether a cached install's astro actually works: the marker must run,
 * exit 0 and name a version. Presence alone is not trust — a fake install
 * (the script tests') or a killed real one can leave a file at the
 * marker's path that no build could execute.
 */
function astroAnswers(marker: string): boolean {
  const probe = spawnSync(marker, ['--version'], { encoding: 'utf8', timeout: 60000 });
  return probe.error === undefined && probe.status === 0 && (probe.stdout ?? '').trim() !== '';
}

/** The template's content fingerprint: its files, paths and bytes, sorted by code point. */
function templateDigest(templateDir: string): string {
  const hash = createHash('sha256');
  const walk = (dir: string, prefix: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => byCodePoint(a.name, b.name));
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue;
      const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), name);
      else hash.update(name).update('\0').update(readFileSync(join(dir, entry.name))).update('\0');
    }
  };
  walk(templateDir, '');
  return hash.digest('hex').slice(0, 16);
}

/**
 * Makes sure the template is installed once at `cacheRoot`, ready to be
 * symlinked into a project: the template present, a bun on PATH (both
 * checked before anything is written), then the install itself — copied
 * fresh and built by `bun install --frozen-lockfile` when the cache holds
 * no working install yet. The install is built in a staging sibling and
 * renamed into place only when its astro answers: a folder at the
 * install's address is always a whole install or nothing. Returns the
 * refusal naming the cause, or the installed project's folder.
 */
export function ensureStarlightInstall(templateDir: string, cacheRoot: string): { ok: true; project: string } | { ok: false; message: string } {
  if (!existsSync(templateDir)) {
    return { ok: false, message: `the starlight template folder was not found at ${templateDir}: the wiki ships it as wiki/starlight in the madarch checkout; restore it there` };
  }
  const bun = spawnSync('bun', ['--version'], { encoding: 'utf8' });
  if (bun.error !== undefined || bun.status !== 0) {
    return { ok: false, message: 'bun was not found on PATH: the starlight engine installs and builds its template with bun; install bun first, e.g. "curl -fsSL https://bun.sh/install | bash" (https://bun.sh)' };
  }
  const dir = join(cacheRoot, `template-${templateDigest(templateDir)}`);
  const marker = join(dir, ...INSTALL_MARKER.split('/'));
  if (!astroAnswers(marker)) {
    const staging = join(cacheRoot, `template-${templateDigest(templateDir)}.staging-${process.pid}-${randomBytes(6).toString('hex')}`);
    rmSync(staging, { recursive: true, force: true });
    try {
      cpSync(templateDir, staging, {
        recursive: true,
        filter: (source) => !source.slice(templateDir.length).split(/[\\/]/).includes('node_modules'),
      });
      const install = spawnSync('bun', ['install', '--frozen-lockfile'], { cwd: staging, encoding: 'utf8' });
      const ran = install.error === undefined;
      const stagingMarker = join(staging, ...INSTALL_MARKER.split('/'));
      const output = ran ? `${install.stdout ?? ''}${install.stderr ?? ''}`.trim() : `bun could not be run: ${install.error?.message}`;
      if (!ran || install.status !== 0 || !astroAnswers(stagingMarker)) {
        const why = !ran
          ? 'bun could not be run'
          : install.status !== 0
            ? `"bun install --frozen-lockfile" failed (exit ${install.status})`
            : !existsSync(stagingMarker)
              ? `"bun install --frozen-lockfile" finished without astro at ${marker}`
              : '"bun install --frozen-lockfile" finished, but the astro it wrote does not answer --version';
        return { ok: false, message: `the starlight template could not be installed at ${dir}: ${why}${output === '' ? '' : `:\n${output}`}` };
      }
      // Only a complete install takes the install's address, and nothing
      // broken stays at it: the old folder goes first, the rename lands
      // the whole install in one step.
      rmSync(dir, { recursive: true, force: true });
      renameSync(staging, dir);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  return { ok: true, project: dir };
}

/** Points the project's `node_modules` at the cache's install for the engine's build. */
export function linkStarlightNodeModules(installedProject: string, projectDir: string): void {
  symlinkSync(join(installedProject, 'node_modules'), join(projectDir, 'node_modules'), 'dir');
}

/**
 * Removes the engine build's byproducts from the written project — the
 * `.astro` cache and the `node_modules` symlink (the link itself, never
 * the cache it points at) — so source/ holds exactly the written project
 * and two runs leave byte-identical trees.
 */
export function cleanStarlightSource(projectDir: string): void {
  rmSync(join(projectDir, '.astro'), { recursive: true, force: true });
  rmSync(join(projectDir, 'node_modules'), { recursive: true, force: true });
}
