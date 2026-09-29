/**
 * The Zensical engine's writer: turns the engine-neutral pages
 * (src/wiki/pages.ts) into a Zensical project — one Markdown file per page
 * under `docs/` and a `zensical.toml` with the site's name and navigation.
 * A page link is written by page id and leaves this writer as a relative
 * path into the page's own file, with an `#anchor` when the link lands on
 * one of that page's headings; the built site itself is produced by
 * `uvx zensical==0.0.66 build`, which the caller runs in the project
 * folder afterwards. Deterministic: the same pages and site name give the
 * same bytes, with no clock and no locale anywhere.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { WikiCell, WikiLinkCell, WikiPage } from './pages.js';

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

/** One page's Markdown: its title as the heading, then every block. */
function renderPage(page: WikiPage, knownIds: ReadonlySet<string>, headings: ReadonlyMap<string, ReadonlySet<string>>): string {
  const context: LinkContext = { pageId: page.id, fromPath: pagePath(page.id), knownIds, headings };
  const chunks: string[] = [];
  for (const block of page.blocks) {
    if (block.kind === 'heading') {
      chunks.push(`${'#'.repeat(block.level)} ${markdownText(block.text)}`);
    } else if (block.kind === 'paragraph') {
      chunks.push(markdownText(block.text));
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

export interface ZensicalSiteOptions {
  /** The site's name, as `zensical.toml`'s `site_name`. */
  readonly siteName: string;
}

/**
 * Writes the Zensical project for `pages` into `projectDir` (created):
 * `docs/<page path>.md` for every page and `zensical.toml` beside it.
 * Throws when a link names a page or a heading the set does not hold — a
 * broken link never reaches the engine.
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
    writeFileSync(file, renderPage(page, knownIds, headings));
  }
  writeFileSync(join(projectDir, 'zensical.toml'), zensicalToml(pages, options.siteName));
}
