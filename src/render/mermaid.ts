/**
 * The view set as Mermaid pages (see design.md, "Mermaid"): one Markdown
 * page per view, holding one `flowchart LR` block and the links under it.
 * Text only, from the view set alone; writing the pages anywhere is the
 * caller's. This module touches no Bun-specific API.
 */
import { byCodePoint } from '../model/order.js';
import type { ShownElement, View } from './view-set.js';

/** One page: its file name (the landscape `index.md`, every other `<element id>.md`) and its whole text. */
export interface MermaidPage {
  file: string;
  content: string;
}

/** One problem that kept the pages from being rendered. */
export interface MermaidError {
  message: string;
  /** The view whose page could not be rendered; left out for the landscape. */
  scope?: string;
}

export interface MermaidResult {
  /** In the view set's order. Left out when there are errors. */
  pages?: MermaidPage[];
  errors: MermaidError[];
}

const LANDSCAPE_FILE = 'index.md';

/** Each kind with a shape of its own, as the opening and closing of its node; every other kind is a plain box. */
const SHAPES: Readonly<Record<string, readonly [string, string]>> = {
  person: ['([', '])'],
  store: ['[(', ')]'],
  broker: ['[[', ']]'],
};
const BOX: readonly [string, string] = ['[', ']'];

const EXTERNAL_CLASS = '  classDef external fill:#f4f4f4,stroke:#888888,stroke-dasharray:5 5';

/**
 * Words Mermaid's flowchart grammar reads as keywords where a node id
 * stands (`end` closes a subgraph, the others start a statement); a node id
 * equal to one of them, in any case, gets a trailing `_`.
 */
const RESERVED = new Set([
  'accdescr',
  'acctitle',
  'call',
  'callback',
  'class',
  'classdef',
  'click',
  'default',
  'direction',
  'end',
  'flowchart',
  'graph',
  'href',
  'interpolate',
  'linkstyle',
  'style',
  'subgraph',
]);

/** Renders every view of the set as a page; an element id that would overwrite the landscape's page, or a view not showing its own scope, is an error. */
export function renderMermaidPages(views: readonly View[]): MermaidResult {
  const errors: MermaidError[] = [];
  const pages: MermaidPage[] = [];
  for (const view of views) {
    const file = pageFile(view.scope);
    if (view.scope !== undefined && file === LANDSCAPE_FILE) {
      errors.push({ message: `the view of "${view.scope}" would be written to ${LANDSCAPE_FILE}, the landscape's page`, scope: view.scope });
      continue;
    }
    const scope = view.scope === undefined ? undefined : view.elements.find((element) => element.id === view.scope && element.place === 'scope');
    if (view.scope !== undefined && scope === undefined) {
      errors.push({ message: `the view of "${view.scope}" does not show "${view.scope}" itself as its scope`, scope: view.scope });
      continue;
    }
    pages.push({ file, content: renderPage(view, scope) });
  }
  return errors.length > 0 ? { errors } : { pages, errors };
}

function pageFile(scope: string | undefined): string {
  return scope === undefined ? LANDSCAPE_FILE : `${scope}.md`;
}

/** `scope` is the view's own element, left out for the landscape. */
function renderPage(view: View, scope: ShownElement | undefined): string {
  const ids = nodeIds(view.elements.map((element) => element.id));

  const lines: string[] = [];
  lines.push(scope === undefined ? '# Landscape' : `# ${markdownText(title(scope))} (${scope.kind})`, '', '```mermaid', 'flowchart LR');
  const inside = view.elements.filter((element) => element.place === 'inside');
  if (scope === undefined) {
    for (const element of inside) lines.push(`  ${node(element, ids)}`);
  } else {
    lines.push(`  subgraph ${ids.get(scope.id)} ["${mermaidText(title(scope))}"]`);
    for (const element of inside) lines.push(`    ${node(element, ids)}`);
    lines.push('  end');
  }
  for (const element of view.elements.filter((element) => element.place === 'neighbour')) lines.push(`  ${node(element, ids)}`);
  for (const arrow of view.arrows) lines.push(`  ${ids.get(arrow.from)} -->|"${mermaidText(arrow.label)}"| ${ids.get(arrow.to)}`);
  const externals = view.elements.filter((element) => element.kind === 'external');
  if (externals.length > 0) lines.push(EXTERNAL_CLASS, `  class ${externals.map((element) => ids.get(element.id)).join(',')} external`);
  lines.push('```', '');

  if (scope !== undefined) {
    const up = view.up === undefined ? `[Landscape](${LANDSCAPE_FILE})` : `[${markdownText(view.up.name ?? view.up.id)}](${pageFile(view.up.id)})`;
    lines.push(`Up: ${up}`, '');
  }
  const open = view.elements.filter((element) => element.hasView && element.place !== 'scope');
  if (open.length > 0) lines.push(`Open: ${open.map((element) => `[${markdownText(title(element))}](${pageFile(element.id)})`).join(' · ')}`, '');
  return lines.join('\n');
}

function title(element: ShownElement): string {
  return element.name ?? element.id;
}

function node(element: ShownElement, ids: ReadonlyMap<string, string>): string {
  const [open, close] = SHAPES[element.kind] ?? BOX;
  return `${ids.get(element.id)}${open}"${mermaidText(title(element))}"${close}`;
}

/**
 * Each element id made a Mermaid node id: every character outside letters,
 * digits and `_` replaced by `_`, a keyword given a trailing `_`, and kept
 * unique within the page. Ids that are node ids as they stand keep
 * themselves; the others, in code point order, take the first free
 * `<id>_2`, `<id>_3`, ... after a clash.
 */
function nodeIds(elementIds: readonly string[]): Map<string, string> {
  const ids = new Map<string, string>();
  const used = new Set<string>();
  const safe = (id: string): string => {
    const replaced = id.replace(/[^A-Za-z0-9_]/g, '_');
    return RESERVED.has(replaced.toLowerCase()) ? `${replaced}_` : replaced;
  };
  const sorted = [...elementIds].sort(byCodePoint);
  for (const id of sorted.filter((id) => safe(id) === id)) {
    ids.set(id, id);
    used.add(id);
  }
  for (const id of sorted.filter((id) => safe(id) !== id)) {
    const base = safe(id);
    let candidate = base;
    for (let n = 2; used.has(candidate); n++) candidate = `${base}_${n}`;
    ids.set(id, candidate);
    used.add(candidate);
  }
  return ids;
}

const MERMAID_ENTITIES: Readonly<Record<string, string>> = { '"': '#quot;', '&': '#amp;', '<': '#lt;', '>': '#gt;' };

/**
 * Text inside a quoted Mermaid label: a quote, `&`, `<` and `>` as Mermaid's
 * named entity codes, and `#` (which starts an entity code), `|` (which
 * ends an edge label), a backtick (which starts Markdown text) and every
 * control character as its numeric code.
 */
function mermaidText(text: string): string {
  return text.replace(/["&<>#|`\u0000-\u001f\u007f]/g, (char) => MERMAID_ENTITIES[char] ?? `#${char.codePointAt(0)};`);
}

/** Text in a Markdown heading or link: the characters Markdown reads as markup escaped, control characters as spaces. */
function markdownText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[\\`*_[\]<>|]/g, '\\$&');
}
