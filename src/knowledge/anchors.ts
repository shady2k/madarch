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
 * item's leading bold phrase (`- **Place an order.** ...`), and the identifier a
 * heading, a bold phrase or a line opens with (`UC-1`, `BR-3`, `ADR-0001`).
 * Fenced code is skipped. The line is the first one that names the anchor.
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
  return anchors;
}

/** The anchors of a document, code-point sorted. */
export function documentAnchors(text: string): string[] {
  return [...anchorLines(text).keys()].sort(byCodePoint);
}

/** The line a document's section is on, or null when the document has no such section. */
export function findAnchor(text: string, anchor: string): number | null {
  return anchorLines(text).get(anchor.toLowerCase()) ?? null;
}
