/**
 * The sections of a Markdown document (madarch-m38l.8): the same anchors a
 * ground may name as `doc:<path>#<anchor>` (heading slugs, the slug of a list
 * item's leading bold phrase, and the identifier such a phrase or heading
 * starts with, like UC-2), each with its text, so a section has a digest and a
 * changed section can be told from an unchanged one.
 */
import { byCodePoint } from '../../model/order.js';
import { sha256Hex } from '../../graph/digest.js';
import { slugOf } from '../../writer/view.js';

export interface Section {
  readonly anchor: string;
  /** The section's lines, joined by newlines, trailing blanks removed. */
  readonly text: string;
}

/** Every anchor of a document with the text it names, in code-point anchor order; a repeated anchor keeps its first section. */
export function documentSections(text: string): Section[] {
  const lines = text.split('\n');
  const found = new Map<string, { start: number; end: number }>();
  const seen = new Map<string, number>();
  const open: { anchors: string[]; start: number; level: number; kind: 'heading' | 'item'; indent: number }[] = [];
  let fenced = false;
  const close = (entry: (typeof open)[number], end: number): void => {
    for (const anchor of entry.anchors) if (anchor !== '' && !found.has(anchor)) found.set(anchor, { start: entry.start, end });
  };
  const identifier = (phrase: string): string[] => {
    const lead = /^([A-Za-z]+-\d+)\b/.exec(phrase.trim());
    return lead === null ? [] : [lead[1]!.toLowerCase()];
  };
  for (const [index, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading !== null) {
      const level = heading[1]!.length;
      while (open.length > 0 && (open[open.length - 1]!.kind === 'item' || open[open.length - 1]!.level >= level)) close(open.pop()!, index);
      const slug = slugOf(heading[2]!);
      const count = seen.get(slug) ?? 0;
      seen.set(slug, count + 1);
      open.push({ anchors: [count === 0 ? slug : `${slug}-${count}`, ...identifier(heading[2]!)], start: index, level, kind: 'heading', indent: 0 });
      continue;
    }
    const bold = /^(\s*)(?:[-*+]|\d+[.)])\s+\*\*([^*]+)\*\*/.exec(line);
    if (bold !== null) {
      // An item that is indented deeper than the one above it is part of it: the parent's text holds its children.
      while (open.length > 0 && open[open.length - 1]!.kind === 'item' && open[open.length - 1]!.indent >= bold[1]!.length) close(open.pop()!, index);
      const phrase = bold[2]!.replace(/[.:]\s*$/, '');
      open.push({ anchors: [slugOf(phrase), ...identifier(phrase)], start: index, level: 7, kind: 'item', indent: bold[1]!.length });
      continue;
    }
    const plain = /^(\s*)(?:[-*+]|\d+[.)])\s+/.exec(line);
    if (plain !== null) {
      while (open.length > 0 && open[open.length - 1]!.kind === 'item' && open[open.length - 1]!.indent >= plain[1]!.length) close(open.pop()!, index);
    }
  }
  while (open.length > 0) close(open.pop()!, lines.length);
  const sections = [...found].map(([anchor, span]) => ({ anchor, text: lines.slice(span.start, span.end).join('\n').replace(/\s+$/, '') }));
  return sections.sort((a, b) => byCodePoint(a.anchor, b.anchor));
}

/** SHA-256 of a section's text. */
export function sectionDigest(text: string): string {
  return sha256Hex(new TextEncoder().encode(text));
}
