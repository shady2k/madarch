/**
 * The Zensical engine's writer: turns the engine-neutral pages
 * (src/wiki/pages.ts) into a Zensical project — one Markdown file per page
 * under `docs/` and a `zensical.toml` with the site's name and navigation.
 * A page's diagram block becomes two tabs the reader switches between,
 * LikeC4 and Mermaid, plain HTML that the site's small stylesheet and
 * module drive: the LikeC4 web component the build ships, and the Mermaid
 * runtime the build copies beside it. A page link is written by page id and
 * leaves this writer as a relative path into the page's own file, with an
 * `#anchor` when the link lands on one of that page's headings; the built
 * site itself is produced by `uvx zensical==0.0.66 build`, which the caller
 * runs in the project folder afterwards. Deterministic: the same pages,
 * site name and diagram options give the same bytes, with no clock and no
 * locale anywhere.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { WikiCell, WikiDiagramBlock, WikiLinkCell, WikiPage } from './pages.js';

/** The folder a prefixed page id lives in, one level under `docs/`. */
const FOLDER_BY_PREFIX: Record<string, string> = { domain: 'domains', element: 'elements' };

/** Pages that sit directly under docs/: single pages holding a section apiece. */
const PATH_BY_TOP_LEVEL_ID: Record<string, string> = { interfaces: 'interfaces.md', zones: 'zones.md', 'data-categories': 'data-categories.md' };

/**
 * The project-relative file a page id is written to: `home` is the site's
 * index, a top-level id its own file under `docs/`, and `domain/<id>` or
 * `element/<id>` a file in its kind's folder. Throws for an id this writer
 * has no place for, so a new page kind cannot silently build into the
 * wrong place.
 */
export function pagePath(id: string): string {
  if (id === 'home') return 'index.md';
  const topLevel = PATH_BY_TOP_LEVEL_ID[id];
  if (topLevel !== undefined) return topLevel;
  const slash = id.indexOf('/');
  if (slash < 0) throw new Error(`page id "${id}" has no kind prefix: expected "home", a top-level page id or "<kind>/<id>"`);
  const folder = FOLDER_BY_PREFIX[id.slice(0, slash)];
  if (folder === undefined) throw new Error(`page id "${id}" names an unknown kind: no folder is mapped for "${id.slice(0, slash)}"`);
  return `${folder}/${id.slice(slash + 1)}.md`;
}

/**
 * Text in Markdown output: the characters Markdown reads as markup
 * escaped, control characters (a table cell's newline included) as
 * spaces — the same rule `src/render/mermaid.ts` writes its pages by.
 */
function markdownText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[\\`*_[\]<>|]/g, '\\$&');
}

/** A TOML basic string: backslash and quote escaped, nothing else. */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The heading id a Zensical page carries for a heading's text: lowercased,
 * punctuation dropped, whitespace and dash runs dashed — the slug rule the
 * engine's Markdown reader applies, so a `#` link lands on it.
 */
function headingId(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s-]/gu, '')
    .trim()
    .replace(/[-_\s]+/g, '-');
}

/** What link rendering needs: the page written, where from, and what the wiki holds. */
interface LinkContext {
  readonly pageId: string;
  readonly fromPath: string;
  readonly knownIds: ReadonlySet<string>;
  /** The headings each page carries, by page id: what an anchored link may land on. */
  readonly headings: ReadonlyMap<string, ReadonlySet<string>>;
}

/** The links a cell leaves as, comma-joined, each refusing a page or a heading the wiki does not hold. */
function linkText(cells: readonly WikiLinkCell[], context: LinkContext): string {
  return cells
    .map((cell) => {
      if (!context.knownIds.has(cell.page)) {
        throw new Error(`page "${context.pageId}" links to "${cell.page}", which is not a page of this wiki: add the page or fix the link`);
      }
      const target = relative(dirname(context.fromPath), pagePath(cell.page));
      if (cell.anchor === undefined) return `[${markdownText(cell.text)}](${target})`;
      if (!context.headings.get(cell.page)?.has(cell.anchor)) {
        throw new Error(`page "${context.pageId}" links to "${cell.page}" at the heading "${cell.anchor}", which that page does not have`);
      }
      return `[${markdownText(cell.text)}](${target}#${headingId(cell.anchor)})`;
    })
    .join(', ');
}

function renderCell(cell: WikiCell, context: LinkContext): string {
  if (typeof cell === 'string') return markdownText(cell);
  return linkText(Array.isArray(cell) ? cell : [cell], context);
}

/** Text in raw HTML output: HTML's own specials escaped, nothing else. */
function htmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * One cell of the relation table under the Mermaid diagram, as table text:
 * madarch's page escapes Markdown in its cells, so those backslashes come
 * off again, and HTML's own specials are escaped.
 */
function tableCell(value: string): string {
  return htmlText(value.replace(/\\([\\`*_[\]<>|])/g, '$1').trim());
}

/**
 * What a view's tabs draw, per diagram block: the LikeC4 view id the
 * shipped web component accepts, the view's diagram as Mermaid source
 * (exactly what madarch's Mermaid page draws, init directive included) and
 * the relation table under it. Keyed by the view's scope, `''` for the
 * landscape — the same naming the diagram blocks use.
 */
export interface WikiDiagramAsset {
  readonly likec4: string;
  readonly mermaid: string;
  /** The columns and the cells of madarch's relation table, as its page wrote them. */
  readonly table: { readonly columns: readonly string[]; readonly rows: readonly (readonly string[])[] };
}

export interface ZensicalSiteOptions {
  /** The site's name, as `zensical.toml`'s `site_name`. */
  readonly siteName: string;
  /** What each view's tabs draw, keyed by the view's scope, `''` for the landscape. */
  readonly diagrams: ReadonlyMap<string, WikiDiagramAsset>;
  /** The diagram tab shown first on every page. */
  readonly firstTab: 'likec4' | 'mermaid';
}

/**
 * A page's diagram block as two tabs the reader switches between: LikeC4's
 * web component for the interactive view, a raw `div.mermaid` with the
 * view's diagram and its relation table for the static one. The first tab
 * is the build's diagram choice; the other panel carries `hidden`, which
 * the site's module toggles. The relation table is HTML here, not
 * Markdown, because it sits inside the raw HTML the tabs are. Refuses a
 * block naming a view the wiki holds no assets for — a page never shows an
 * empty tab.
 */
function diagramHtml(page: WikiPage, block: WikiDiagramBlock, options: ZensicalSiteOptions): string {
  const asset = options.diagrams.get(block.scope ?? '');
  if (asset === undefined) {
    const named = block.scope === undefined ? 'the landscape' : `the view of "${block.scope}"`;
    throw new Error(`page "${page.id}" shows ${named}, which this wiki does not hold: render the model's views before building the wiki`);
  }
  const head = `<tr>${asset.table.columns.map((column) => `<th>${tableCell(column)}</th>`).join('')}</tr>`;
  const body = asset.table.rows.map((row) => `<tr>${row.map((value) => `<td>${tableCell(value)}</td>`).join('')}</tr>`).join('');
  return [
    `<div class="wiki-diagram" data-first="${options.firstTab}">`,
    '<div class="wiki-tabs" role="tablist">',
    `<button type="button" class="wiki-tab" data-tab="likec4" role="tab" aria-selected="${options.firstTab === 'likec4' ? 'true' : 'false'}">LikeC4</button>`,
    `<button type="button" class="wiki-tab" data-tab="mermaid" role="tab" aria-selected="${options.firstTab === 'mermaid' ? 'true' : 'false'}">Mermaid</button>`,
    '</div>',
    `<div class="wiki-panel" data-panel="likec4"${options.firstTab === 'likec4' ? '' : ' hidden'}>`,
    `<likec4-view view-id="${htmlText(asset.likec4)}"></likec4-view>`,
    '</div>',
    `<div class="wiki-panel" data-panel="mermaid"${options.firstTab === 'mermaid' ? '' : ' hidden'}>`,
    '<div class="mermaid">',
    htmlText(asset.mermaid),
    '</div>',
    '<table class="wiki-relations">',
    `<thead>${head}</thead>`,
    `<tbody>${body}</tbody>`,
    '</table>',
    '</div>',
    '</div>',
  ].join('\n');
}

/** One page's Markdown: its title as the heading, then every block. */
function renderPage(page: WikiPage, options: ZensicalSiteOptions, knownIds: ReadonlySet<string>, headings: ReadonlyMap<string, ReadonlySet<string>>): string {
  const context: LinkContext = { pageId: page.id, fromPath: pagePath(page.id), knownIds, headings };
  const chunks: string[] = [];
  for (const block of page.blocks) {
    if (block.kind === 'heading') {
      chunks.push(`${'#'.repeat(block.level)} ${markdownText(block.text)}`);
    } else if (block.kind === 'paragraph') {
      chunks.push(markdownText(block.text));
    } else if (block.kind === 'diagram') {
      chunks.push(diagramHtml(page, block, options));
    } else {
      chunks.push(
        [
          `| ${block.columns.map(markdownText).join(' | ')} |`,
          `| ${block.columns.map(() => '---').join(' | ')} |`,
          ...block.rows.map((row) => `| ${row.map((cell) => renderCell(cell, context)).join(' | ')} |`),
        ].join('\n'),
      );
    }
  }
  const head = `# ${markdownText(page.title)}`;
  return chunks.length === 0 ? `${head}\n` : `${head}\n\n${chunks.join('\n\n')}\n`;
}

/**
 * One entry of the navigation: a page, or a group of entries under one
 * title — Zensical renders both, and nests a group's entries beneath it.
 */
type NavEntry = { readonly title: string; readonly path: string } | { readonly title: string; readonly children: NavEntry[] };

function navEntryToml(entry: NavEntry): string {
  if ('path' in entry) return `{ ${tomlString(entry.title)} = ${tomlString(entry.path)} }`;
  return `{ ${tomlString(entry.title)} = [${entry.children.map(navEntryToml).join(', ')}] }`;
}

/**
 * The navigation from the pages' `nav` places: the home page first, then
 * one section per first nav segment in page order. A page whose nav names
 * a second segment nests under a group of that name inside its section;
 * the section's own page for that group — a domain's page written before
 * its elements' pages — becomes the group's first child, so it shows once.
 */
function navToml(pages: readonly WikiPage[]): string {
  const sections = new Map<string, NavEntry[]>();
  for (const page of pages) {
    if (page.id === 'home') continue;
    const section = page.nav[0] ?? page.title;
    const entries = sections.get(section) ?? [];
    const parent = page.nav[1];
    if (parent === undefined) {
      entries.push({ title: page.title, path: pagePath(page.id) });
    } else {
      let group: Extract<NavEntry, { children: NavEntry[] }> | undefined;
      for (const entry of entries) {
        if ('children' in entry && entry.title === parent) group = entry;
      }
      if (group === undefined) {
        group = { title: parent, children: [] };
        const direct = entries.findIndex((entry) => 'path' in entry && entry.title === parent);
        if (direct >= 0) group.children.push(entries.splice(direct, 1)[0]!);
        entries.push(group);
      }
      group.children.push({ title: page.title, path: pagePath(page.id) });
    }
    sections.set(section, entries);
  }
  const parts = [`{ ${tomlString('Home')} = ${tomlString(pagePath('home'))} }`];
  for (const [section, entries] of sections) {
    parts.push(`{ ${tomlString(section)} = [${entries.map(navEntryToml).join(', ')}] }`);
  }
  return `nav = [${parts.join(', ')}]`;
}

function zensicalToml(pages: readonly WikiPage[], siteName: string): string {
  return [
    '# Generated by madarch (scripts/wiki.ts) — edit the generator, not this file.',
    '[project]',
    `site_name = ${tomlString(siteName)}`,
    navToml(pages),
    // The diagram tabs' wiring: the stylesheet the writer emits, the LikeC4
    // web component and the Mermaid runtime the build ships beside it.
    'extra_css = ["stylesheets/wiki.css"]',
    'extra_javascript = [{ path = "assets/likec4-view.js", type = "module" }, { path = "javascripts/wiki-diagram.mjs", type = "module" }]',
    '',
    '[project.theme]',
    'language = "en"',
    '',
    '[[project.theme.palette]]',
    'media = "(prefers-color-scheme: light)"',
    'scheme = "default"',
    'toggle.icon = "lucide/sun"',
    'toggle.name = "Switch to dark mode"',
    '',
    '[[project.theme.palette]]',
    'media = "(prefers-color-scheme: dark)"',
    'scheme = "slate"',
    'toggle.icon = "lucide/moon"',
    'toggle.name = "Switch to light mode"',
    '',
  ].join('\n');
}

/** The diagram tabs' stylesheet: the tab strip and the sizes the two formats need. */
const WIKI_CSS = [
  '/* Generated by madarch (scripts/wiki.ts) — edit the generator, not this file. */',
  '// The static LikeC4 view breaks out of the text column: the wider its box,',
  '// the more the fitted diagram scales up, and the labels stay readable.',
  '.wiki-panel[data-panel="likec4"] {',
  '  overflow-x: auto;',
  '}',
  'likec4-view {',
  '  display: block;',
  '  width: 1100px;',
  '  height: 640px;',
  '  margin-left: max(0px, calc((100% - 1100px) / 2));',
  '}',
  '.wiki-tabs {',
  '  display: flex;',
  '  gap: 0.25rem;',
  '  margin-bottom: 0.5rem;',
  '  border-bottom: 1px solid rgba(128, 128, 128, 0.3);',
  '}',
  '.wiki-tab {',
  '  appearance: none;',
  '  background: none;',
  '  border: none;',
  '  border-bottom: 2px solid transparent;',
  '  padding: 0.4rem 0.8rem;',
  '  cursor: pointer;',
  '  font: inherit;',
  '  color: inherit;',
  '  opacity: 0.7;',
  '}',
  ".wiki-tab[aria-selected='true'] {",
  '  border-bottom-color: currentColor;',
  '  font-weight: 600;',
  '  opacity: 1;',
  '}',
  '.wiki-panel[hidden] {',
  '  display: none;',
  '}',
  'table.wiki-relations {',
  '  margin-top: 0.5rem;',
  '}',
  '',
].join('\n');

/**
 * The diagram tabs' module: the Mermaid runtime the site ships draws every
 * visible `div.mermaid` on load and when a tab reveals one; a closed
 * panel's diagram is drawn when first shown, never at zero width. The tab
 * buttons swap the panels and nudge LikeC4, which sizes to its box when it
 * is revealed.
 */
const WIKI_DIAGRAM_MJS = [
  '// Generated by madarch (scripts/wiki.ts) — edit the generator, not this file.',
  "// The diagram tabs: LikeC4's web component against the Mermaid runtime the",
  '// site ships (no CDN at reading time). A panel hidden at load draws when',
  '// it is first shown.',
  "import mermaid from '../assets/mermaid/mermaid.esm.min.mjs';",
  '',
  "mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' });",
  '',
  'async function drawVisible() {',
  "  const nodes = [...document.querySelectorAll('.mermaid')].filter(",
  '    (node) => node.dataset.wikiMermaid === undefined && node.offsetParent !== null,',
  '  );',
  '  if (nodes.length === 0) return;',
  '  await mermaid.run({ nodes });',
  "  for (const node of nodes) node.dataset.wikiMermaid = 'drawn';",
  '}',
  '',
  'function select(holder, tab) {',
  "  for (const button of holder.querySelectorAll('.wiki-tab')) {",
  "    button.setAttribute('aria-selected', button.dataset.tab === tab ? 'true' : 'false');",
  '  }',
  "  for (const panel of holder.querySelectorAll('.wiki-panel')) {",
  '    panel.hidden = panel.dataset.panel !== tab;',
  '  }',
  "  // LikeC4 sizes its diagram to the box it is revealed in.",
  "  window.dispatchEvent(new Event('resize'));",
  '  drawVisible();',
  '}',
  '',
  "for (const holder of document.querySelectorAll('.wiki-diagram')) {",
  "  for (const button of holder.querySelectorAll('.wiki-tab')) {",
  "    button.addEventListener('click', () => select(holder, button.dataset.tab));",
  '  }',
  "  select(holder, holder.dataset.first === 'mermaid' ? 'mermaid' : 'likec4');",
  '}',
  '',
].join('\n');

/**
 * Writes the Zensical project for `pages` into `projectDir` (created):
 * `docs/<page path>.md` for every page, `zensical.toml` beside it, and the
 * diagram tabs' stylesheet and module under `docs/` — the LikeC4 web
 * component and the Mermaid runtime themselves are the build's to ship.
 * Throws when a link names a page or a heading the set does not hold, or a
 * diagram block names a view the diagrams map does not — a broken page
 * never reaches the engine.
 */
export function writeZensicalProject(pages: readonly WikiPage[], projectDir: string, options: ZensicalSiteOptions): void {
  const knownIds = new Set(pages.map((page) => page.id));
  const headings = new Map<string, Set<string>>();
  for (const page of pages) {
    const ids = new Set<string>();
    for (const block of page.blocks) {
      if (block.kind === 'heading') ids.add(block.text);
    }
    headings.set(page.id, ids);
  }
  for (const page of pages) {
    const file = join(projectDir, 'docs', pagePath(page.id));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, renderPage(page, options, knownIds, headings));
  }
  mkdirSync(join(projectDir, 'docs', 'stylesheets'), { recursive: true });
  mkdirSync(join(projectDir, 'docs', 'javascripts'), { recursive: true });
  writeFileSync(join(projectDir, 'docs', 'stylesheets', 'wiki.css'), WIKI_CSS);
  writeFileSync(join(projectDir, 'docs', 'javascripts', 'wiki-diagram.mjs'), WIKI_DIAGRAM_MJS);
  writeFileSync(join(projectDir, 'zensical.toml'), zensicalToml(pages, options.siteName));
}
