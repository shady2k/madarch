/**
 * The names a Markdown document gives its parts, in one place (madarch-m38l.4, remark 11; decision 0032 section 4).
 *
 * Every one of them is read from the parsed tree (`doc-tree.ts`) and never from an expression over the document's
 * lines: a heading, its section and its blocks are nodes with exact ranges, and the anchors below are names of those
 * nodes. A Setext heading (`Title` over `=====`) is a heading to the parser, so it carries an anchor like an ATX one.
 *
 * An anchor is, in lower case: a heading's GitHub slug (a repeated one suffixed -1, -2), an explicit `{#anchor}` on a
 * heading, the slug of a list item's leading bold phrase (`- **Place an order.** ...`), the identifier a heading, a bold
 * phrase or a block opens with (`UC-1`, `BR-3`, `ADR-0001`), the label a block opens with (`HTTP2`, when the block
 * says `HTTP2 support ...`), and — for a block that none of those names, such as a paragraph under `## Qualities` —
 * the enclosing heading's anchor, a dot and the block's place in that section (`qualities.1`, `qualities.2`). A
 * passage a classifier split out of one block is named by the block's anchor and its place there (`qualities.1.2`),
 * which resolves to the block's line.
 *
 * Two readings live here and differ on purpose: `anchorLines()` names every part a ground may open, and
 * `headingLines()` names only headings, because a section's EXTENT runs to the next heading whatever named block it
 * holds (see `anchorExtent()`).
 */
import { byCodePoint } from '../model/order.js';
import { SLUGGER_REGEX } from '../wiki/github-slugger-regex.js';
import { boldLead, leadText, readDocTree, sectionBlocks, walkNodes, type DocNode, type DocSection, type DocTree } from './doc-tree.js';

const LETTER = (code: number): boolean => (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
const DIGIT = (code: number): boolean => code >= 0x30 && code <= 0x39;
const WORD = (char: string | undefined): boolean => {
  if (char === undefined) return false;
  const code = char.codePointAt(0)!;
  return LETTER(code) || DIGIT(code) || char === '_';
};

/** The slug GitHub gives a heading: its marks are not part of it, and its spaces become hyphens. */
export function slugOf(heading: string): string {
  let marked = '';
  for (const char of heading) if (char !== '`' && char !== '*' && char !== '_' && char !== '~') marked += char;
  return marked.trim().toLowerCase().replace(SLUGGER_REGEX, '').replace(/ /g, '-');
}

/** The identifier a text opens with (`UC-2`, `ADR-0001`), or null: letters, a hyphen and digits, then a boundary. */
export function identifierOf(text: string): string | null {
  const plain = text.trim();
  let at = 0;
  while (at < plain.length && LETTER(plain.codePointAt(at)!)) at += 1;
  const letters = plain.slice(0, at);
  if (letters === '' || plain[at] !== '-') return null;
  at += 1;
  const start = at;
  while (at < plain.length && DIGIT(plain.codePointAt(at)!)) at += 1;
  const digits = plain.slice(start, at);
  if (digits === '' || WORD(plain[at])) return null;
  return `${letters.toUpperCase()}-${digits}`;
}

/**
 * The label a block opens with, when the label names something: the first word's letters, digits, `_` and `-` in lower
 * case, kept when it carries a digit (`HTTP2`) or opens with two capitals and a hyphen (`NFR-`). Today's documents name
 * a block this way as well as by an identifier, and the two rules meet on `UC-2`.
 */
function labelOf(text: string): string | null {
  const plain = text.trim();
  let at = 0;
  while (at < plain.length && (LETTER(plain.codePointAt(at)!) || DIGIT(plain.codePointAt(at)!) || plain[at] === '_' || plain[at] === '-')) at += 1;
  if (at === 0) return null;
  const word = plain.slice(0, at);
  const capitals = word.slice(0, 2).split('');
  const named = [...word].some((char) => DIGIT(char.codePointAt(0)!)) || (capitals.length === 2 && capitals.every((char) => char >= 'A' && char <= 'Z') && word[2] === '-');
  return named ? word.toLowerCase() : null;
}

/** A heading's text with the explicit `{#anchor}` it may carry taken off it. */
function splitExplicit(text: string): { text: string; explicit?: string } {
  const plain = text.trim();
  if (!plain.endsWith('}')) return { text: plain };
  const open = plain.lastIndexOf('{#');
  if (open < 0) return { text: plain };
  const inside = plain.slice(open + 2, -1);
  if (inside === '' || ![...inside].every((char) => LETTER(char.codePointAt(0)!) || DIGIT(char.codePointAt(0)!) || char === '_' || char === '-')) return { text: plain };
  return { text: plain.slice(0, open).trim(), explicit: inside };
}

/** The trailing `.` and `:` a bold phrase ends with are not part of its name. */
function stripTail(text: string): string {
  let end = text.trimEnd().length;
  while (end > 0 && (text[end - 1] === '.' || text[end - 1] === ':')) end -= 1;
  return text.slice(0, end).trim();
}

/** What one document's parts are called, and where they stand. */
export interface AnchorReading {
  /** Every anchor, with the 1-based line it first names. */
  readonly lines: ReadonlyMap<string, number>;
  /** The anchors of headings alone, with their lines: what a section's end is read from. */
  readonly headings: ReadonlyMap<string, number>;
  /** The anchors of the blocks no name covers (a paragraph, a plain list item), by the line they start at. */
  readonly blocks: ReadonlyMap<number, string>;
  /** The node each anchor names, in document order: a heading (which covers its section), an item or a paragraph. */
  readonly nodes: ReadonlyMap<string, DocNode>;
}

/** The anchors of one parsed document. */
export function anchorsOfTree(tree: DocTree): AnchorReading {
  const lines = new Map<string, number>();
  const headings = new Map<string, number>();
  const blocks = new Map<number, string>();
  const nodes = new Map<string, DocNode>();
  const add = (anchor: string, node: DocNode): void => {
    if (anchor === '' || lines.has(anchor)) return;
    lines.set(anchor, node.line);
    nodes.set(anchor, node);
  };
  // Headings: an explicit `{#anchor}`, the GitHub slug (a repeated one suffixed -1, -2) and the identifier they open with.
  const headingName = new Map<DocNode, string>();
  const seen = new Map<string, number>();
  walkNodes(tree.nodes, (node) => {
    if (node.type !== 'heading') return;
    const heading = splitExplicit(node.plain);
    if (heading.explicit !== undefined) add(heading.explicit.toLowerCase(), node);
    const slug = slugOf(heading.text);
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    const name = count === 0 ? slug : `${slug}-${count}`;
    headingName.set(node, name);
    add(name, node);
    if (!headings.has(name)) headings.set(name, node.line);
    const identifier = identifierOf(heading.text);
    if (identifier !== null) add(identifier.toLowerCase(), node);
  });
  // Every list item and paragraph the document writes is named by its bold phrase, its identifier or its label — a nested
  // item too, which stands inside another item and is no block of its own section.
  walkNodes(tree.nodes, (node) => {
    if (node.type !== 'listItem' && node.type !== 'paragraph') return;
    const bold = boldLead(node);
    if (bold !== undefined) {
      const phrase = stripTail(bold.plain);
      add(slugOf(phrase), node);
      const identifier = identifierOf(phrase);
      if (identifier !== null) add(identifier.toLowerCase(), node);
      return;
    }
    const lead = leadText(node);
    const identifier = identifierOf(lead);
    if (identifier !== null) { add(identifier.toLowerCase(), node); return; }
    const label = labelOf(lead);
    if (label !== null) add(label, node);
  });
  // A block none of those names is named by its heading and its place in that section, and a block before the document's
  // first heading has no section to belong to.
  for (const section of tree.sections) {
    const heading = section.heading === null ? undefined : headingName.get(section.heading);
    let ordinal = 0;
    for (const block of sectionBlocks(section)) {
      const bold = boldLead(block);
      if (bold !== undefined) {
        const phrase = stripTail(bold.plain);
        add(slugOf(phrase), block);
        const identifier = identifierOf(phrase);
        if (identifier !== null) add(identifier.toLowerCase(), block);
        continue;
      }
      const lead = leadText(block);
      const identifier = identifierOf(lead);
      if (identifier !== null) { add(identifier.toLowerCase(), block); continue; }
      const label = labelOf(lead);
      if (label !== null) add(label, block);
      if (heading === undefined) continue;
      ordinal += 1;
      const anchor = `${heading}.${ordinal}`;
      add(anchor, block);
      if (!blocks.has(block.line)) blocks.set(block.line, anchor);
    }
  }
  return { lines, headings, blocks, nodes };
}

/** The anchors of a document's text; the text is parsed once, and the same tree answers every reading below. */
export function anchorsOf(text: string): AnchorReading {
  return anchorsOfTree(readDocTree({ repo: null, path: '', text }));
}

/** Every anchor of a document with the line (1-based) that first names it. */
export function anchorLines(text: string): Map<string, number> {
  return new Map(anchorsOf(text).lines);
}

/** The lines a document's headings stand on, by the name `anchorLines()` gives a heading. */
export function headingLines(text: string): Map<string, number> {
  return new Map(anchorsOf(text).headings);
}

/** The anchors of the blocks no name covers, by the line each starts at. */
export function blockAnchors(text: string): Map<number, string> {
  return new Map(anchorsOf(text).blocks);
}

/** The anchors of a document, code-point sorted. */
export function documentAnchors(text: string): string[] {
  return [...anchorsOf(text).lines.keys()].sort(byCodePoint);
}

/**
 * The line a `doc:<path>#<anchor>` ground names, or null. A passage a classifier split out of a block is named by the
 * block's anchor and its place there (`qualities.1.2`), and so resolves to the block's own line.
 */
export function findAnchor(text: string, anchor: string): number | null {
  const reading = anchorsOf(text);
  const name = anchor.toLowerCase();
  const line = reading.lines.get(name);
  if (line !== undefined) return line;
  let cut = name.lastIndexOf('.');
  while (cut > 0) {
    const block = name.slice(0, cut);
    const place = name.slice(cut + 1);
    const at = reading.lines.get(block);
    if (at !== undefined && place !== '' && [...place].every((char) => DIGIT(char.codePointAt(0)!))) return at;
    cut = block.lastIndexOf('.');
  }
  return null;
}

/**
 * The lines a node covers: a heading covers its whole section (its blocks and its sub-sections), a list item or a
 * paragraph covers itself and only what stands under it, never the sibling that follows it.
 */
export function extentOfNode(tree: DocTree, node: DocNode): { start: number; end: number } {
  if (node.type !== 'heading') return { start: node.line, end: node.endLine };
  const section = tree.sections.find((candidate) => candidate.heading === node);
  return { start: node.line, end: section?.endLine ?? node.endLine };
}

/**
 * The lines an anchor's part covers, or undefined when the document has no such anchor: the extent of the node the
 * anchor names. A task scoped to `br-1` closes on a commit that changes `br-1` and not on one that changes its sibling
 * `br-2`, because a list item covers only its own lines (madarch-ztyq.3, the review of finding 4).
 */
export function anchorExtent(text: string, anchor: string): { start: number; end: number } | undefined {
  const tree = readDocTree({ repo: null, path: '', text });
  const reading = anchorsOfTree(tree);
  const name = anchor.toLowerCase();
  const direct = reading.nodes.get(name);
  if (direct !== undefined) return extentOfNode(tree, direct);
  let cut = name.lastIndexOf('.');
  while (cut > 0) {
    const node = reading.nodes.get(name.slice(0, cut));
    if (node !== undefined && name.slice(cut + 1) !== '' && [...name.slice(cut + 1)].every((char) => DIGIT(char.codePointAt(0)!))) return extentOfNode(tree, node);
    cut = name.slice(0, cut).lastIndexOf('.');
  }
  return undefined;
}

/**
 * What a reader calls the part an anchor names: a heading's text (its explicit `{#anchor}` aside), a bold item's phrase,
 * or nothing when the part has no name of its own. A place a task names is read this way, from the tree, so a label is
 * the name the document gives the part and never a line of its source.
 */
export function titleOfAnchor(text: string, anchor: string): string | undefined {
  const tree = readDocTree({ repo: null, path: '', text });
  const node = anchorsOfTree(tree).nodes.get(anchor.toLowerCase());
  if (node === undefined) return undefined;
  if (node.type === 'heading') {
    const heading = splitExplicit(node.plain).text.trim();
    return heading === '' ? undefined : heading;
  }
  const bold = boldLead(node);
  if (bold === undefined) return undefined;
  const phrase = stripTail(bold.plain);
  return phrase === '' ? undefined : phrase;
}

/** The section a heading opens, for a reader that holds a tree. */
export function sectionOfHeading(tree: DocTree, heading: DocNode): DocSection | undefined {
  return tree.sections.find((section) => section.heading === heading);
}

