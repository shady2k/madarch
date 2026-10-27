/**
 * The sections of a Markdown document that a ground can name, in one place
 * (madarch-m38l.4, remark 11). The writer checks a ground
 * `madarch:doc:<path>#<anchor>` before it writes a page, and the wiki resolves
 * the same ground when it draws the page; when they read a document two ways, a
 * ground the writer accepted showed as a problem on the page. Both now ask
 * this module, so what the writer accepts the wiki resolves.
 *
 * An anchor is, in lower case: a heading's GitHub slug (a repeated one
 * suffixed -1, -2), an explicit `{#anchor}` on a heading, the slug of a list
 * item's leading bold phrase (`- **Place an order.** ...`), the identifier a
 * heading, a bold phrase or a line opens with (`UC-1`, `BR-3`, `ADR-0001`), and
 * — for a block that none of those names, such as a paragraph or a plain list
 * item under `## Qualities` — the enclosing heading's anchor, a dot and the
 * block's place in that section (`qualities.1`, `qualities.2`). The last one is
 * what a document read by meaning needs (madarch-ztyq.3): an unnumbered section
 * holds entities too, and a ground to one of them must open it. Fenced code is
 * skipped. The line is the first one that names the anchor, and a heading's
 * name is never shadowed by the place of a block under it.
 */
import { SLUGGER_REGEX } from '../wiki/github-slugger-regex.js';
import { byCodePoint } from '../model/order.js';

/** The slug GitHub gives a heading; emphasis and code marks are not part of it. */
export function slugOf(heading: string): string {
  return heading.replace(/[`*_~]/g, '').trim().toLowerCase().replace(SLUGGER_REGEX, '').replace(/ /g, '-');
}

const IDENTIFIER = /^([A-Za-z]+-\d+)\b/;
/** A line that opens with a label such as `UC-2` or `ADR-0001`, with an optional list mark and bold. */
const LABEL = /^\s*(?:[-*+]|\d+[.)])?\s*(?:\*\*|__)?\s*([A-Za-z][\w-]*)(?=[\s.:*_)-]|$)/;

/** A line that opens a list item: its mark, or the ordered number. */
const LIST_MARK = /^(\s*)(?:[-*+]|\d+[.)])\s+/;
/** A list item whose leading phrase is bold: the phrase names the item. */
const BOLD_LEAD = /^\s*(?:[-*+]|\d+[.)])\s+(?:\*\*|__)/;
/** A heading of the document, with the explicit `{#anchor}` it may carry. */
const HEADING = /^(#{1,6})\s+(.*?)\s*(?:\{#([\w-]+)\})?\s*#*\s*$/;

/**
 * The anchors of the blocks of a document that no heading, bold phrase or
 * identifier names — a paragraph, or a plain list item — with the line each
 * starts at. The anchor is the enclosing heading's anchor, a dot, and the
 * block's place among the unnamed blocks of that section: the section's own
 * blocks keep their place when a named block is added or removed, and no
 * heading slug can hold a dot, so a block's anchor never shadows a heading's.
 * A block before the document's first heading has no section to belong to and
 * so has no anchor.
 */
export function blockAnchors(text: string): Map<number, string> {
  const anchors = new Map<number, string>();
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const seen = new Map<string, number>();
  let fenced = false;
  let heading: string | null = null;
  let ordinal = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const named = HEADING.exec(line);
    if (named !== null) {
      const slug = slugOf(named[2]!);
      const count = seen.get(slug) ?? 0;
      seen.set(slug, count + 1);
      heading = named[3] !== undefined ? named[3].toLowerCase() : count === 0 ? slug : `${slug}-${count}`;
      ordinal = 0;
      continue;
    }
    if (line.trim() === '') continue;
    const item = LIST_MARK.test(line);
    // A paragraph starts where a blank line ends and something that is not a heading, a fence, a table, a quote or an HTML block begins.
    const paragraph = !item && (index === 0 || lines[index - 1]!.trim() === '')
      && !/^\s*(?:[<>|]|\[\^)/.test(line) && !/^\s*(?:[-*_]\s*){3,}$/.test(line);
    if (!item && !paragraph) continue;
    if (BOLD_LEAD.test(line)) continue;
    if (IDENTIFIER.test(line.replace(/^\s*(?:[-*+]|\d+[.)])?\s*(?:\*\*|__)?\s*/, ''))) continue;
    if (heading === null) continue;
    ordinal += 1;
    anchors.set(index + 1, `${heading}.${ordinal}`);
  }
  return anchors;
}

/** Every anchor of a document with the line (1-based) that first names it. */
export function anchorLines(text: string): Map<string, number> {
  const anchors = new Map<string, number>();
  const seen = new Map<string, number>();
  const add = (anchor: string, line: number): void => {
    if (anchor !== '' && !anchors.has(anchor)) anchors.set(anchor, line);
  };
  let fenced = false;
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const number = index + 1;
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const identifier = (phrase: string): void => {
      const lead = IDENTIFIER.exec(phrase.replace(/[`*_~]/g, '').trim());
      if (lead !== null) add(lead[1]!.toLowerCase(), number);
    };
    const heading = /^#{1,6}\s+(.*?)\s*(?:\{#([\w-]+)\})?\s*#*\s*$/.exec(line);
    if (heading !== null) {
      if (heading[2] !== undefined) add(heading[2].toLowerCase(), number);
      const slug = slugOf(heading[1]!);
      const count = seen.get(slug) ?? 0;
      seen.set(slug, count + 1);
      add(count === 0 ? slug : `${slug}-${count}`, number);
      identifier(heading[1]!);
      continue;
    }
    const bold = /^\s*(?:[-*+]|\d+[.)])\s+(?:\*\*|__)([^*_]+)(?:\*\*|__)/.exec(line);
    if (bold !== null) {
      const phrase = bold[1]!.replace(/[.:]\s*$/, '');
      add(slugOf(phrase), number);
      identifier(phrase);
    }
    const label = LABEL.exec(line);
    if (label !== null && /[\w-]+\d|[A-Z]{2,}-/.test(label[1]!)) add(label[1]!.toLowerCase(), number);
  }
  // A block no name of its own covers is named by the heading it stands under and its place there.
  for (const [line, anchor] of blockAnchors(text)) add(anchor, line);
  return anchors;
}

/**
 * The lines a document's headings stand on, by the name `anchorLines()` gives a heading: its GitHub slug (a repeated
 * one suffixed -1, -2) and, where the heading carries one, its explicit `{#anchor}`.
 *
 * Why this is a second reading and not `anchorLines()`: an *anchor* names the smallest thing a ground may open — a
 * heading, a bold item's phrase, a block a heading and a place name (`qualities.1`) — and a ground to any of them is
 * a ground to that part, so every one of them must be in `anchorLines()`. A section's *extent* is another question:
 * it runs from the thing the anchor names to the line before the next heading, whatever smaller named or unnamed thing
 * the document writes inside it. Reading the extent from `anchorLines()` cut a section off at its first bold item or
 * its first plain paragraph, and never at its next heading (madarch-ztyq.3): a commit that changed a later line of the
 * section then touched no scope, and the task it named stayed open.
 */
export function headingLines(text: string): Map<string, number> {
  const headings = new Map<string, number>();
  const seen = new Map<string, number>();
  const add = (anchor: string, line: number): void => {
    if (anchor !== '' && !headings.has(anchor)) headings.set(anchor, line);
  };
  let fenced = false;
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const heading = HEADING.exec(line);
    if (heading === null) continue;
    const number = index + 1;
    if (heading[3] !== undefined) add(heading[3].toLowerCase(), number);
    const slug = slugOf(heading[2]!);
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    add(count === 0 ? slug : `${slug}-${count}`, number);
  }
  return headings;
}

/** The anchors of a document, code-point sorted. */
export function documentAnchors(text: string): string[] {
  return [...anchorLines(text).keys()].sort(byCodePoint);
}

/** The line a document's section is on, or null when the document has no such section. */
export function findAnchor(text: string, anchor: string): number | null {
  return anchorLines(text).get(anchor.toLowerCase()) ?? null;
}
