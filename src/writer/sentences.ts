/**
 * The sentence-level reading of a knowledge page, shared by the writer's
 * canonical form and the graph index (madarch-m38l.8). A statement is a
 * sentence that ends in footnote references; its name is the footnote's name
 * (`[^refund-window]`). Pure functions of the page text: no graph, no disk.
 */
import { sha256Hex } from '../graph/digest.js';

export const LINK = /\[([^\]\n]*)\]\(((?:[^()\s]|\([^()\s]*\))*)\)/g;
export const FOOTNOTE_DEFINITION = /^\[\^([\p{L}\p{N}_-]+)\]:[ \t]*(.*)$/u;
export const FOOTNOTE_REFERENCE = /\[\^([\p{L}\p{N}_-]+)\]/gu;
/** A run of adjacent footnote references: the end of one sentence. */
export const REFERENCE_RUN = /(?:\[\^[\p{L}\p{N}_-]+\])+/gu;
const ABBREVIATION = /\b(?:[Ee]\.g|[Ii]\.e)\.|\b(?:etc|vs|cf|approx)\.(?=\s+[a-z0-9(,;])|(?<![\p{L}\p{N}])(?:[Сс]м\.|[Тт]\.\s?[еквдпн]\.)|(?<![\p{L}\p{N}])(?:и\s+т\.\s?[дп]|напр|ср|рис|табл|стр|гг|руб|тыс|млн|млрд)\.(?=\s+[\p{Ll}\p{N}(,;])/gu;
/** Question references qualify a sentence; they are not part of its factual text or its grounds. */
export const QUESTION_LINK = /\[([^\]\n]*)\]\((madarch:question:[^()\s]+)\)/g;
export const withoutQuestionLinks = (text: string): string => text.replace(QUESTION_LINK, '').trim();
/** Characters that stand for a masked sentence end inside code spans, link targets and abbreviations; each remembers which one it hides. */
const MASK: Record<string, string> = { '.': '\u0001', '!': '\u0002', '?': '\u0003', '\u2026': '\u0004' };
const UNMASK: Record<string, string> = { '\u0001': '.', '\u0002': '!', '\u0003': '?', '\u0004': '\u2026' };
const maskEnds = (text: string): string => text.replace(/[.!?\u2026]/g, (character) => MASK[character]!);
/** The text with its masked sentence ends restored. */
export const unmask = (text: string): string => text.replace(/[\u0001-\u0004]/g, (character) => UNMASK[character]!);

export interface Sentence {
  readonly text: string;
  readonly terminated: boolean;
}

/** Masks code spans, link targets and common abbreviations, whose dots are not sentence ends. */
export function maskInline(text: string): string {
  return text
    .replace(/`[^`\n]*`/g, maskEnds)
    .replace(LINK, (whole, label: string, target: string) => target.startsWith('madarch:question:') ? maskEnds(whole) : `[${label}](${maskEnds(target)})`)
    .replace(ABBREVIATION, (whole) => whole.replace(/\./g, MASK['.']!));
}

/** Splits masked text into sentences; footnote references right after the terminal punctuation belong to the sentence. */
export function sentencesOf(masked: string): Sentence[] {
  const out: Sentence[] = [];
  const pattern = /([^]*?[.!?…][)"'”’»]*(?:\[\^[\p{L}\p{N}_-]+\])*(?:[ \t]+\[[^\]\n]*\]\(madarch:question:[^()\s]+\))*)(?=\s|$)/uy;
  const text = masked.trim();
  let at = 0;
  while (at < text.length) {
    pattern.lastIndex = at;
    const found = pattern.exec(text);
    if (found === null) break;
    out.push({ text: found[1]!.trim(), terminated: true });
    at = pattern.lastIndex;
    while (at < text.length && /\s/.test(text[at]!)) at += 1;
  }
  const rest = text.slice(at).trim();
  if (rest !== '') out.push({ text: rest, terminated: false });
  return out;
}

export interface TextUnit {
  readonly line: number;
  readonly text: string;
}

export interface Definition {
  readonly label: string;
  readonly line: number;
  readonly text: string;
}

/** The units of a body (paragraphs, list items, quotes), its headings and its footnote definitions, without judging any of them. */
export function readUnits(body: string, bodyStart: number): { units: TextUnit[]; definitions: Definition[]; headings: TextUnit[] } {
  const units: TextUnit[] = [];
  const headings: TextUnit[] = [];
  const definitions: Definition[] = [];
  let paragraph: { line: number; parts: string[] } | undefined;
  const flush = (): void => {
    if (paragraph !== undefined) units.push({ line: paragraph.line, text: paragraph.parts.join(' ') });
    paragraph = undefined;
  };
  for (const [index, raw] of body.split('\n').entries()) {
    const line = bodyStart + index;
    const trimmed = raw.trim();
    if (trimmed === '') { flush(); continue; }
    if (/^(```|~~~)/.test(trimmed) || trimmed.startsWith('|') || /^<[A-Za-z!/]/.test(trimmed)) { flush(); continue; }
    const definition = FOOTNOTE_DEFINITION.exec(trimmed);
    if (definition !== null) { flush(); definitions.push({ label: definition[1]!, line, text: definition[2]! }); continue; }
    const heading = /^#{1,6}\s+(.*)$/.exec(trimmed);
    if (heading !== null) { flush(); headings.push({ line, text: heading[1]! }); continue; }
    const item = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(trimmed);
    if (item !== null) { flush(); units.push({ line, text: item[1]! }); continue; }
    const quote = /^>\s?(.*)$/.exec(trimmed);
    const content = quote !== null ? quote[1]! : trimmed;
    if (paragraph === undefined) paragraph = { line, parts: [content] };
    else paragraph.parts.push(content);
  }
  flush();
  return { units, definitions, headings };
}

/** The grounds of a footnote definition: its links, in order. */
export function groundLinks(text: string): { label: string; target: string }[] {
  const links: { label: string; target: string }[] = [];
  text.replace(LINK, (_whole, label: string, target: string) => { links.push({ label, target }); return ''; });
  return links;
}

/** A sentence as a reader sees it: references removed, links as their labels, markup dropped, blanks collapsed. */
export function plainSentence(text: string): string {
  return withoutQuestionLinks(unmask(text))
    .replace(LINK, (_whole, label: string) => label)
    .replace(REFERENCE_RUN, '')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** One statement of a page: a sentence that ends in footnote references. */
export interface PageStatement {
  /** The footnote's name; a name used by several sentences is suffixed `~2`, `~3` from the second. */
  readonly id: string;
  /** Every footnote reference of the sentence, in order. */
  readonly labels: readonly string[];
  readonly text: string;
  /** SHA-256 of `text` in UTF-8. */
  readonly digest: string;
  /** The 1-based line of the unit the sentence is in, in the whole file. */
  readonly line: number;
  /** `madarch:` targets (without the scheme) of the links in the sentence. */
  readonly mentions: readonly string[];
  /** Grounds of all the sentence's footnotes, as `madarch:` link targets without the scheme, in order and without repeats. */
  readonly grounds: readonly string[];
}

/** The statements of a body, in document order. `bodyStart` is the line the body starts at. */
export function statementsOf(body: string, bodyStart: number): PageStatement[] {
  const { units, definitions } = readUnits(body, bodyStart);
  const grounds = new Map<string, string[]>();
  for (const definition of definitions) {
    if (grounds.has(definition.label)) continue;
    grounds.set(definition.label, groundLinks(definition.text).map((link) => link.target).filter((target) => target.startsWith('madarch:')).map((target) => target.slice('madarch:'.length)));
  }
  const seen = new Map<string, number>();
  const out: PageStatement[] = [];
  for (const unit of units) {
    for (const sentence of sentencesOf(maskInline(unit.text))) {
      const labels = [...sentence.text.matchAll(FOOTNOTE_REFERENCE)].map((match) => match[1]!);
      if (labels.length === 0) continue;
      const count = (seen.get(labels[0]!) ?? 0) + 1;
      seen.set(labels[0]!, count);
      const text = plainSentence(sentence.text);
      const own = [...new Set(labels.flatMap((label) => grounds.get(label) ?? []))];
      const mentions = [...sentence.text.matchAll(LINK)].map((match) => unmask(match[2]!)).filter((target) => target.startsWith('madarch:')).map((target) => target.slice('madarch:'.length));
      out.push({ id: count === 1 ? labels[0]! : `${labels[0]}~${count}`, labels, text, digest: sha256Hex(new TextEncoder().encode(text)), line: unit.line, mentions: [...new Set(mentions)], grounds: own });
    }
  }
  return out;
}
