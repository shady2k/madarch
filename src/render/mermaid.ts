/**
 * The view set as Mermaid pages (see design.md, "Mermaid"): one Markdown
 * page per view, holding one `flowchart LR` block, the table of its arrows
 * and the links under it.
 * Text only, from the view set alone; writing the pages anywhere is the
 * caller's. This module touches no Bun-specific API.
 */
import { uniqueSafeIds } from './safe-ids.js';
import { childrenByParent, type ShownElement, type View } from './view-set.js';





/** Each kind with a shape of its own, as the opening and closing of its node; every other kind is a plain box. */
const SHAPES: Readonly<Record<string, readonly [string, string]>> = {
  person: ['([', '])'],
  store: ['[(', ')]'],
  broker: ['[[', ']]'],
};
const BOX: readonly [string, string] = ['[', ']'];

// Dark text on the light fill: GitHub's dark theme would draw it light, and unreadable.
const EXTERNAL_CLASS = '  classDef external fill:#f4f4f4,stroke:#888888,stroke-dasharray:5 5,color:#222222';
// Straight lines (views/mermaid): with numbered arrows, curves were what still
// laid labels over each other on GitHub's renderer.
const STRAIGHT = '%%{init: {"flowchart": {"curve": "linear"}}}%%';

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



/**
 * The page without its links (views/one-view): the heading, the flowchart
 * and the table of arrows, ending with the blank line a page leaves before
 * its links. `scope` is the view's own element, left out for the landscape.
 */
export function renderPageBody(view: View, scope: ShownElement | undefined): string {
  const ids = nodeIds(view.elements.map((element) => element.id));
  const childrenOf = childrenByParent(view.elements);

  const lines: string[] = [];
  lines.push(scope === undefined ? '# Landscape' : `# ${markdownText(title(scope))} (${scope.kind})`, '', '```mermaid', STRAIGHT, 'flowchart LR');
  if (scope === undefined) {
    emitElements(lines, ids, childrenOf, undefined, '  ');
  } else {
    lines.push(`  subgraph ${ids.get(scope.id)} ["${mermaidText(title(scope))}"]`);
    emitElements(lines, ids, childrenOf, scope.id, '    ');
    lines.push('  end');
  }
  for (const element of view.elements.filter((element) => element.place === 'neighbour')) lines.push(`  ${node(element, ids)}`);
  // Each arrow carries its row number in the table under the diagram, a
  // dotted link where its relations all mark their action (views/mermaid).
  view.arrows.forEach((arrow, index) => lines.push(`  ${ids.get(arrow.from)} ${arrow.dashed ? '-.->' : '-->'}|"${index + 1}"| ${ids.get(arrow.to)}`));
  const externals = view.elements.filter((element) => element.kind === 'external');
  if (externals.length > 0) lines.push(EXTERNAL_CLASS, `  class ${externals.map((element) => ids.get(element.id)).join(',')} external`);
  lines.push('```', '');
  if (view.arrows.length > 0) lines.push(...arrowTable(view), '');
  return lines.join('\n');
}

/**
 * The elements under `parent` drawn — the landscape's parent-less ones, or
 * the asked element's own subtree: an element whose own children are shown
 * is a frame around them (views/one-view, a depth above 1), the others
 * keep their own shapes.
 */
function emitElements(
  lines: string[],
  ids: ReadonlyMap<string, string>,
  childrenOf: ReadonlyMap<string | undefined, readonly ShownElement[]>,
  parent: string | undefined,
  indent: string,
): void {
  for (const element of childrenOf.get(parent) ?? []) {
    if (!childrenOf.has(element.id)) {
      lines.push(`${indent}${node(element, ids)}`);
      continue;
    }
    lines.push(`${indent}subgraph ${ids.get(element.id)} ["${mermaidText(title(element))}"]`);
    emitElements(lines, ids, childrenOf, element.id, `${indent}  `);
    lines.push(`${indent}end`);
  }
}


/**
 * The table under the diagram (views/mermaid), the diagram's key: one row per
 * arrow in the diagram's order, numbered as the arrows are labelled, with the
 * names of its ends and every relation behind it by its entry.
 */
function arrowTable(view: View): string[] {
  const byId = new Map(view.elements.map((element) => [element.id, element]));
  const end = (id: string): string => markdownText(title(byId.get(id)!));
  return [
    '| # | From | To | Relations |',
    '| --- | --- | --- | --- |',
    ...view.arrows.map((arrow, index) => `| ${index + 1} | ${end(arrow.from)} | ${end(arrow.to)} | ${markdownText(arrow.names.join('; '))} |`),
  ];
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
  return uniqueSafeIds(elementIds, (id) => {
    const replaced = id.replace(/[^A-Za-z0-9_]/g, '_');
    return RESERVED.has(replaced.toLowerCase()) ? `${replaced}_` : replaced;
  });
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
