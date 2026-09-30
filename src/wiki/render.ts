/**
 * The pieces of a page both engine writers render: the text escaping, the
 * diagram tabs (the LikeC4 web component against the Mermaid runtime the
 * site ships), the table and link rendering, and the navigation tree each
 * engine shapes into its own nav format. A writer stays engine-specific
 * only where its engine differs: where a page's file sits, where a link
 * points (`WriterLinks`) and the heading anchors its engine's Markdown
 * reader spells.
 *
 * Pure and deterministic: the same pages and options render to the same
 * text every time — nothing reads the clock, and every sort stays on code
 * points.
 */
import { documentHeadings, refusedLinkClosers, scanDocument } from './documents.js';
import { isDocumentPage, type AnyWikiPage, type WikiDocumentPage } from './pages.js';
import type { WikiCell, WikiDiagramBlock, WikiLinkCell, WikiPage } from './pages.js';
import { documentImageRoute, pagePath } from './pages-path.js';

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
  /** The view's archify page, as a file name under the site's `assets/archify/`. */
  readonly archify: string;
  /** The columns and the cells of madarch's relation table, as its page wrote them. */
  readonly table: { readonly columns: readonly string[]; readonly rows: readonly (readonly string[])[] };
}

/** The diagram assets and the first tab the writers render the diagram blocks with. */
export interface WikiRenderOptions {
  /** What each view's tabs draw, keyed by the view's scope, `''` for the landscape. */
  readonly diagrams: ReadonlyMap<string, WikiDiagramAsset>;
  /** The diagram tab shown first on every page. */
  readonly firstTab: 'likec4' | 'mermaid' | 'archify';
}

/**
 * Text in Markdown output: the characters Markdown reads as markup
 * escaped, control characters (a table cell's newline included) as
 * spaces — the same rule `src/render/mermaid.ts` writes its pages by.
 */
function markdownText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[\\`*_[\]<>|]/g, '\\$&');
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
 * A page's diagram block as two tabs the reader switches between: LikeC4's
 * web component for the interactive view, a raw `div.mermaid` with the
 * view's diagram and its relation table for the static one. The first tab
 * is the build's diagram choice; the other panel carries `hidden`, which
 * the site's module toggles. The relation table is HTML here, not
 * Markdown, because it sits inside the raw HTML the tabs are. Refuses a
 * block naming a view the wiki holds no assets for — a page never shows an
 * empty tab.
 */
export function diagramHtml(page: WikiPage, block: WikiDiagramBlock, options: WikiRenderOptions): string {
  const asset = options.diagrams.get(block.scope ?? '');
  if (asset === undefined) {
    const named = block.scope === undefined ? 'the landscape' : `the view of "${block.scope}"`;
    throw new Error(`page "${page.id}" shows ${named}, which this wiki does not hold: render the model's views before building the wiki`);
  }
  const head = `<tr>${asset.table.columns.map((column) => `<th>${tableCell(column)}</th>`).join('')}</tr>`;
  const body = asset.table.rows.map((row) => `<tr>${row.map((value) => `<td>${tableCell(value)}</td>`).join('')}</tr>`).join('');
  // The iframe's address is root-absolute, like every asset link the
  // pages carry: the same depth on every page, either engine's routes.
  const archifySrc = `/assets/archify/${asset.archify}`;
  return [
    `<div class="wiki-diagram" data-first="${options.firstTab}">`,
    '<div class="wiki-tabs" role="tablist">',
    `<button type="button" class="wiki-tab" data-tab="likec4" role="tab" aria-selected="${options.firstTab === 'likec4' ? 'true' : 'false'}">LikeC4</button>`,
    `<button type="button" class="wiki-tab" data-tab="mermaid" role="tab" aria-selected="${options.firstTab === 'mermaid' ? 'true' : 'false'}">Mermaid</button>`,
    `<button type="button" class="wiki-tab" data-tab="archify" role="tab" aria-selected="${options.firstTab === 'archify' ? 'true' : 'false'}">Archify</button>`,
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
    `<div class="wiki-panel" data-panel="archify"${options.firstTab === 'archify' ? '' : ' hidden'}>`,
    `<iframe class="wiki-archify" src="${htmlText(archifySrc)}" title="The view as an archify diagram" loading="lazy"></iframe>`,
    '</div>',
    '</div>',
  ].join('\n');
}

/**
 * The diagram tabs' stylesheet, shared whole by both engines: the tab
 * strip, the LikeC4 panel's breakout to the content area and the sizes the
 * two formats need. The rule that turns the engine's own content wrapper
 * into the measured container (`.md-content` for Zensical, Starlight's
 * main pane for Starlight) and the file's banner comment are each writer's
 * own, prepended ahead of these lines.
 */
export const TABS_CSS: readonly string[] = [
  '.wiki-panel[data-panel="likec4"] {',
  '  width: 100cqw;',
  '  margin-inline: calc((100% - 100cqw) / 2);',
  '  overflow-x: auto;',
  '}',
  '/* The archify page is a document of its own: the panel breaks out the',
  '   same way and the iframe fills it, tall enough for the fitted view,',
  '   its own page scrolling the rest. */',
  '.wiki-panel[data-panel="archify"] {',
  '  width: 100cqw;',
  '  margin-inline: calc((100% - 100cqw) / 2);',
  '}',
  'iframe.wiki-archify {',
  '  display: block;',
  '  width: 100%;',
  '  height: 760px;',
  '  border: none;',
  '}',
  '/* The component draws its view at the box width and the aspect ratio of',
  '   the view (its injected style carries aspect-ratio), so an automatic',
  '   height follows the diagram — no empty band below it. */',
  'likec4-view {',
  '  display: block;',
  '  width: 100%;',
  '  height: auto;',
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
];

/**
 * The diagram tabs' module: the Mermaid runtime the site ships draws every
 * visible `div.mermaid` on load and when a tab reveals one; a closed
 * panel's diagram is drawn when first shown, never at zero width. The tab
 * buttons swap the panels and nudge LikeC4, which sizes to its box when it
 * is revealed. `mermaidImport` is the module specifier the runtime sits at
 * in the writer's own layout, relative to where the module is written.
 */
export function diagramModuleJs(mermaidImport: string): string {
  return [
    '// Generated by madarch (scripts/wiki.ts) — edit the generator, not this file.',
    "// The diagram tabs: LikeC4's web component against the Mermaid runtime the",
    '// site ships (no CDN at reading time). A panel hidden at load draws when',
    '// it is first shown.',
    `import mermaid from '${mermaidImport}';`,
    '',
    "mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });",
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
    "  select(holder, holder.dataset.first ?? 'likec4');",
    '}',
    '// A document page carries Mermaid blocks of its own, outside any tabs:',
    '// whatever is visible at load is drawn once here.',
    'drawVisible();',
    '',
  ].join('\n');
}

/** What link rendering needs: the page written, where from, and what the wiki holds. */
export interface LinkContext {
  readonly pageId: string;
  readonly fromPath: string;
  readonly knownIds: ReadonlySet<string>;
  /** The headings each page carries, by page id: what an anchored link may land on. */
  readonly headings: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Where an engine's links point: a link's target as the built site
 * resolves it from the page carrying it, and the anchor id a heading's
 * text lands on there. Zensical spells relative `.md` paths slugged by its
 * own reader; Starlight spells root-relative route URLs slugged the way
 * GitHub slugs.
 */
export interface WriterLinks {
  readonly pathOf: (pageId: string, context: LinkContext) => string;
  readonly slugOf: (headingText: string) => string;
}

/** The links a cell leaves as, comma-joined, each refusing a page or a heading the wiki does not hold. */
function linkText(cells: readonly WikiLinkCell[], context: LinkContext, links: WriterLinks): string {
  return cells
    .map((cell) => {
      if (!context.knownIds.has(cell.page)) {
        throw new Error(`page "${context.pageId}" links to "${cell.page}", which is not a page of this wiki: add the page or fix the link`);
      }
      const target = links.pathOf(cell.page, context);
      if (cell.anchor === undefined) return `[${markdownText(cell.text)}](${target})`;
      if (!context.headings.get(cell.page)?.has(cell.anchor)) {
        throw new Error(`page "${context.pageId}" links to "${cell.page}" at the heading "${cell.anchor}", which that page does not have`);
      }
      return `[${markdownText(cell.text)}](${target}#${links.slugOf(cell.anchor)})`;
    })
    .join(', ');
}

function renderCell(cell: WikiCell, context: LinkContext, links: WriterLinks): string {
  if (typeof cell === 'string') return markdownText(cell);
  return linkText(Array.isArray(cell) ? cell : [cell], context, links);
}

/** The link and heading lookups every page of one build shares, computed once. */
export interface PreparedPages {
  readonly knownIds: ReadonlySet<string>;
  readonly headings: ReadonlyMap<string, ReadonlySet<string>>;
}

export function preparePages(pages: readonly AnyWikiPage[]): PreparedPages {
  const knownIds = new Set(pages.map((page) => page.id));
  const headings = new Map<string, Set<string>>();
  for (const page of pages) {
    const ids = new Set<string>();
    if (isDocumentPage(page)) {
      // A document's anchors land on the headings its own Markdown carries,
      // plus the title line the writers insert when it has none.
      for (const text of documentHeadings(page)) ids.add(text);
    } else {
      for (const block of page.blocks) {
        if (block.kind === 'heading') ids.add(block.text);
      }
    }
    headings.set(page.id, ids);
  }
  return { knownIds, headings };
}

/**
 * One page's body as Markdown: its title as the heading, then every
 * block. The writer adds its engine's own wrapper (frontmatter, config)
 * around this text.
 */
export function renderPageBody(page: WikiPage, options: WikiRenderOptions, prepared: PreparedPages, links: WriterLinks): string {
  const context: LinkContext = { pageId: page.id, fromPath: pagePath(page.id), knownIds: prepared.knownIds, headings: prepared.headings };
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
          ...block.rows.map((row) => `| ${row.map((cell) => renderCell(cell, context, links)).join(' | ')} |`),
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
export type NavEntry = { readonly title: string; readonly path: string } | { readonly title: string; readonly children: NavEntry[] };

/** One section of the navigation: the pages that share a first nav segment, in page order. */
export interface NavSection {
  readonly title: string;
  readonly entries: readonly NavEntry[];
}
/**
 * The navigation from the pages' `nav` places: one section per first nav
 * segment in page order. A page whose nav names further segments nests
 * under a group of each name inside its section — a document's folders —
 * as deep as the segments go; at the first level a group whose own page
 * was written before its group's entries (a domain) becomes that group's
 * first child, so it shows once.
 */
export function navTree(pages: readonly AnyWikiPage[]): readonly NavSection[] {
  const sections = new Map<string, NavEntry[]>();
  for (const page of pages) {
    if (page.id === 'home') continue;
    const section = page.nav[0] ?? page.title;
    const top = sections.get(section) ?? [];
    let entries = top;
    for (let depth = 1; depth < page.nav.length; depth++) {
      const name = page.nav[depth]!;
      let group: Extract<NavEntry, { children: NavEntry[] }> | undefined;
      for (const entry of entries) {
        if ('children' in entry && entry.title === name) group = entry;
      }
      if (group === undefined) {
        group = { title: name, children: [] };
        // The section's own page for a first-level group — a domain's page
        // written before its elements' pages — becomes the group's first
        // child, so it shows once. Folder groups deeper in (a document's
        // folders) have no page of their own.
        if (depth === 1) {
          const direct = entries.findIndex((entry) => 'path' in entry && entry.title === name);
          if (direct >= 0) group.children.push(entries.splice(direct, 1)[0]!);
        }
        entries.push(group);
      }
      entries = group.children;
    }
    entries.push({ title: page.title, path: pagePath(page.id) });
    sections.set(section, top);
  }
  return [...sections].map(([title, entries]) => ({ title, entries }));
}

/**
 * A rewritten URL as a Markdown link destination: in angle brackets when
 * a bare destination could not carry it — a space, a parenthesis, a
 * bracket — bare where a bare destination carries it.
 */
function urlDestination(url: string): string {
  return /[ \t()<>\u0000-\u001f]/.test(url) ? `<${url}>` : url;
}

/**
 * One document page's body: the document's Markdown with every resolved
 * link's target rewritten to where the writer serves it — another page by
 * `links.pathOf`, its anchor slugged by `links.slugOf`, an image at the
 * document asset route — and every Mermaid fence replaced by the raw
 * `div.mermaid` the shipped runtime draws on load. Everything else is the
 * document's own text, its raw markup escaped to text outside code spans,
 * fences and link targets; a document without a title gets its `# title`
 * line above the body. Writers call this once per document page, with
 * their own `WriterLinks`.
 */
export function renderDocumentBody(page: WikiDocumentPage, links: WriterLinks): string {
  const context: LinkContext = { pageId: page.id, fromPath: pagePath(page.id), knownIds: new Set<string>(), headings: new Map<string, ReadonlySet<string>>() };
  const urlOf = new Map<string, string>();
  const refused = new Set<string>();
  for (const link of page.links) {
    if (link.kind === 'image') {
      urlOf.set(link.written, documentImageRoute(link.filePath!));
      continue;
    }
    if (link.kind === 'refused') {
      refused.add(link.written);
      continue;
    }
    if (link.kind === 'keep') continue;
    const target = links.pathOf(link.pageId!, context);
    urlOf.set(link.written, link.anchor === undefined ? target : `${target}#${links.slugOf(link.anchor)}`);
  }
  // Positions from the same scan the page data classified, so every
  // resolved link has exactly one occurrence to land on. Applied last to
  // first: the edits never overlap, and offsets stay valid.
  const scan = scanDocument(page.body);
  const edits: { start: number; end: number; text: string }[] = [];
  for (const occurrence of scan.links) {
    if (refused.has(occurrence.written)) {
      // A refused link is shown as text: its opening bracket escaped, so
      // no engine reads a link out of it; the closer pass over the
      // finished body below stops any label the line scan never paired.
      edits.push({ start: occurrence.bracket, end: occurrence.bracket + 1, text: '\\[' });
      continue;
    }
    const url = urlOf.get(occurrence.written);
    if (url !== undefined) edits.push({ start: occurrence.start, end: occurrence.end, text: urlDestination(url) });
  }
  for (const block of scan.mermaid) {
    edits.push({ start: block.start, end: block.end, text: `<div class="mermaid">\n${htmlText(block.source)}\n</div>` });
  }
  // Raw HTML in a document is text, not markup: every `<` of the body is
  // escaped outside code spans, fences and link targets — the regions a
  // reader sees as characters — so what a repository writes as
  // `<script>` or `<img onerror=…>` reaches the reader as those
  // characters, never as an element. `>` and `&` stay as written: no
  // element begins without `<`, and blockquotes and entities keep working.
  const guarded = [
    ...scan.code,
    // A kept destination's `<` is its own; a refused one's is text, the
    // same as every `<` outside the guarded regions.
    ...scan.links.filter((link) => !refused.has(link.written)).map((link) => ({ start: link.start, end: link.end })),
  ];
  const isGuarded = (position: number): boolean => guarded.some((span) => position >= span.start && position < span.end);
  for (let at = page.body.indexOf('<'); at >= 0; at = page.body.indexOf('<', at + 1)) {
    if (!isGuarded(at)) edits.push({ start: at, end: at + 1, text: '&lt;' });
  }
  edits.sort((a, b) => b.start - a.start);
  let body = page.body;
  for (const edit of edits) body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
  // The closer pass, last: every `](` the finished body still holds whose
  // destination names a refused scheme — a link the line scan never
  // paired, its label wrapped across lines — loses its closer, so no
  // engine reads a link out of it either.
  const closers = refusedLinkClosers(body);
  for (let index = closers.length - 1; index >= 0; index--) {
    const at = closers[index]!;
    body = body.slice(0, at) + '\\]' + body.slice(at + 1);
  }
  return page.insertTitle ? `# ${page.title}\n\n${body}` : body;
}

