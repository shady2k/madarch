/**
 * The sentence-level reading of a knowledge page, shared by the writer's
 * canonical form and the graph index (madarch-m38l.8, madarch-ztyq.11). A
 * statement is a sentence that ends in footnote references; its name is the
 * footnote's name (`[^refund-window]`).
 *
 * The reader parses the page once as a Markdown tree and asks the platform's
 * sentence segmenter for the sentence boundaries in the wiki's language. It
 * never splits text itself: code spans, link targets, question links and
 * footnote references are masked from the tree before the segmenter sees them,
 * so their punctuation cannot invent a sentence. The word list of abbreviations
 * the first reader kept is gone: an abbreviation is `Intl.Segmenter`'s
 * knowledge of the language, not a list in the engine.
 */
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { sha256Hex } from '../graph/digest.js';

/** Inline links as written; kept for the writer's independent format checks. */
export const LINK = /\[([^\]\n]*)\]\(((?:[^()\s]|\([^()\s]*\))*)\)/g;
export const FOOTNOTE_DEFINITION = /^\[\^([\p{L}\p{N}_-]+)\]:[ \t]*(.*)$/u;
export const FOOTNOTE_REFERENCE = /\[\^([\p{L}\p{N}_-]+)\]/gu;
/** A run of adjacent footnote references: the end of one sentence. */
export const REFERENCE_RUN = /(?:\[\^[\p{L}\p{N}_-]+\])+/gu;
/** Question references qualify a sentence; they are not part of its factual text or its grounds. */
export const QUESTION_LINK = /\[([^\]\n]*)\]\((madarch:question:[^()\s]+)\)/g;

/** Characters that stood for a masked sentence end in the old reader; kept so old text still unmasks. */
const UNMASK: Record<string, string> = { '\u0001': '.', '\u0002': '!', '\u0003': '?', '\u0004': '\u2026' };
/** The text with its masked sentence ends restored. */
export const unmask = (text: string): string => text.replace(/[\u0001-\u0004]/g, (character) => UNMASK[character]!);

export interface Sentence {
  readonly text: string;
  readonly terminated: boolean;
}

interface Node {
  type: string;
  value?: string;
  url?: string;
  identifier?: string;
  label?: string;
  children?: Node[];
  position?: {
    start: { line: number; column?: number; offset?: number };
    end: { line: number; column?: number; offset?: number };
  };
}

interface Span {
  readonly start: number;
  readonly end: number;
}

interface FootnoteSpan extends Span {
  readonly label: string;
}

interface LinkSpan extends Span {
  readonly url: string;
}

interface QuestionSpan extends Span {
  readonly url: string;
}

interface SourceIndex {
  readonly footnotes: readonly FootnoteSpan[];
  readonly questions: readonly QuestionSpan[];
  readonly codes: readonly Span[];
  readonly targets: readonly Span[];
  readonly links: readonly LinkSpan[];
}

const parser = unified().use(remarkParse).use(remarkGfm);

function treeOf(text: string): Node {
  return parser.parse(text) as unknown as Node;
}

const startOf = (node: Node): number => node.position?.start.offset ?? 0;
const endOf = (node: Node): number => node.position?.end.offset ?? startOf(node);

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function isSpace(character: string | undefined): boolean {
  return character === ' ' || character === '\t' || character === '\n' || character === '\r' || character === '\f' || character === '\v';
}

function isTerminal(character: string | undefined): boolean {
  return character === '.' || character === '!' || character === '?' || character === '\u2026';
}

function isClosing(character: string | undefined): boolean {
  return character === ')' || character === ']' || character === '"' || character === "'" || character === '\u201d' || character === '\u2019' || character === '\u00bb';
}

function isLabelCharacter(character: string | undefined): boolean {
  if (character === undefined) return false;
  // A footnote name is a run of letters, digits, `_` and `-`; without a
  // regular expression, letters and digits are the characters whose case or
  // numeric value the platform knows.
  return character === '_' || character === '-' || (character.toLowerCase() !== character.toUpperCase()) || (character >= '0' && character <= '9');
}

function inside(spans: readonly Span[], start: number, end: number): boolean {
  return spans.some((span) => start >= span.start && end <= span.end);
}

/** The destination between `](` and its matching `)`, when the link is written inline. */
function targetRange(text: string, node: Node): Span | undefined {
  const start = startOf(node);
  const end = endOf(node);
  let bracket = start;
  while (bracket < end - 1) {
    if (text[bracket] === ']' && text[bracket + 1] === '(') {
      let depth = 1;
      let at = bracket + 2;
      while (at < end) {
        if (text[at] === '(') depth += 1;
        else if (text[at] === ')') {
          depth -= 1;
          if (depth === 0) return { start: bracket + 2, end: at };
        }
        at += 1;
      }
      return { start: bracket + 2, end };
    }
    bracket += 1;
  }
  return undefined;
}

/** Every span whose punctuation the segmenter must not see, found in the tree. */
function indexSource(text: string, from: number, to: number, root: Node = treeOf(text)): SourceIndex {
  const codes: Span[] = [];
  const targets: Span[] = [];
  const links: LinkSpan[] = [];
  const questions: QuestionSpan[] = [];
  walk(root, (node) => {
    const start = startOf(node);
    const end = endOf(node);
    if (end <= from || start >= to) return;
    if (node.type === 'inlineCode') codes.push({ start, end });
    if (node.type === 'link' || node.type === 'image') {
      const target = targetRange(text, node);
      if (target !== undefined) targets.push(target);
      if (node.type === 'link' && typeof node.url === 'string') {
        links.push({ start, end, url: node.url });
        if (node.url.startsWith('madarch:question:')) questions.push({ start, end, url: node.url });
      }
    }
  });
  // A reference the parser left as text is still a footnote reference; scan the
  // source, skipping code spans and link destinations where brackets are data.
  const footnotes: FootnoteSpan[] = [];
  for (let at = from; at < to; at += 1) {
    if (text[at] !== '[' || text[at + 1] !== '^') continue;
    let end = at + 2;
    while (end < to && isLabelCharacter(text[end])) end += 1;
    if (end === at + 2 || text[end] !== ']') continue;
    const after = end + 1;
    if (inside(codes, at, after) || inside(targets, at, after)) continue;
    footnotes.push({ start: at, end: after, label: text.slice(at + 2, end) });
    at = end;
  }
  return { footnotes, questions, codes, targets, links };
}

function maskPunctuation(characters: string[], text: string, span: Span, from: number, to: number): void {
  const start = Math.max(span.start, from);
  const end = Math.min(span.end, to);
  for (let at = start; at < end; at += 1) {
    if (isTerminal(text[at])) characters[at - from] = ' ';
  }
}

/** The text the segmenter sees: sentence punctuation in data is blanked; footnote references are blanked whole. */
function segmentationText(text: string, from: number, to: number, index: SourceIndex): string {
  const characters = text.slice(from, to).split('');
  for (const span of index.codes) maskPunctuation(characters, text, span, from, to);
  for (const span of index.targets) maskPunctuation(characters, text, span, from, to);
  for (const span of index.questions) {
    const start = Math.max(span.start, from);
    const end = Math.min(span.end, to);
    for (let at = start; at < end; at += 1) characters[at - from] = ' ';
  }
  for (const span of index.footnotes) {
    const start = Math.max(span.start, from);
    const end = Math.min(span.end, to);
    for (let at = start; at < end; at += 1) characters[at - from] = ' ';
  }
  // The segmenter does not end a sentence at a single ellipsis; a full stop
  // does, and the source keeps its own character for the reader.
  for (let at = 0; at < characters.length; at += 1) if (characters[at] === '\u2026') characters[at] = '!';
  return characters.join('');
}

function segmenterFor(language: string | undefined): Intl.Segmenter {
  try {
    return new Intl.Segmenter(language, { granularity: 'sentence' });
  } catch {
    return new Intl.Segmenter(undefined, { granularity: 'sentence' });
  }
}


function isLetter(character: string | undefined): boolean {
  return character !== undefined && character.toLowerCase() !== character.toUpperCase();
}

function isUpper(character: string | undefined): boolean {
  if (character === undefined) return false;
  const lower = character.toLowerCase();
  const upper = character.toUpperCase();
  return lower !== upper && character === upper;
}

/**
 * A segmenter knows most abbreviations. A two-letter abbreviation it does not
 * know (Russian `См.`, a title such as `Dr.`) is a word of one or two letters
 * before a full stop, followed by a capital; blank its full stop so the
 * segmenter keeps it inside the sentence. This is a shape, not a word list.
 */
function blankShortAbbreviations(masked: string): string {
  const characters = masked.split('');
  for (let at = 0; at < characters.length; at += 1) {
    if (characters[at] !== '.') continue;
    let start = at;
    while (start > 0 && isLetter(characters[start - 1])) start -= 1;
    const length = at - start;
    if (length < 1 || length > 2) continue;
    let next = at + 1;
    while (next < characters.length && isSpace(characters[next])) next += 1;
    if (next < characters.length && isUpper(characters[next])) characters[at] = '\u0000';
  }
  return characters.join('');
}

function endsSentence(masked: string): boolean {
  let at = masked.length - 1;
  while (at >= 0 && isSpace(masked[at])) at -= 1;
  while (at >= 0 && isClosing(masked[at])) at -= 1;
  return at >= 0 && isTerminal(masked[at]);
}

interface SentenceRange extends Span {
  readonly terminated: boolean;
}

/** Sentence ranges in `text[from, to)`: segmenter boundaries, extended over the notes and question suffix they end. */
function sentenceRanges(text: string, from: number, to: number, language: string | undefined, index: SourceIndex): SentenceRange[] {
  const masked = segmentationText(text, from, to, index);
  const parts = [...segmenterFor(language).segment(blankShortAbbreviations(masked))];
  const out: SentenceRange[] = [];
  let cursor = 0;
  for (const part of parts) {
    const localStart = part.index;
    const localEnd = part.index + part.segment.length;
    let start = Math.max(cursor, localStart);
    while (start < localEnd && isSpace(text[from + start])) start += 1;
    let end = localEnd;
    while (end > start && isSpace(text[from + end - 1])) end -= 1;
    if (start >= end) continue;
    const terminated = endsSentence(masked.slice(start, end));
    let after = end;
    for (;;) {
      let next = after;
      while (next < masked.length && isSpace(text[from + next])) next += 1;
      const footnote = index.footnotes.find((span) => span.start === from + next && span.end <= to);
      if (footnote !== undefined) {
        after = footnote.end - from;
        continue;
      }
      const question = index.questions.find((span) => span.start === from + next && span.end <= to);
      if (question !== undefined) {
        after = question.end - from;
        continue;
      }
      break;
    }
    const shown = text.slice(from + start, from + after).trim();
    if (shown !== '') out.push({ start: from + start, end: from + after, terminated });
    cursor = Math.max(cursor, after);
    while (cursor < masked.length && isSpace(text[from + cursor])) cursor += 1;
  }
  // A tail with no terminal punctuation is one unterminated sentence, not a lost one.
  if (cursor < masked.length && out.every((range) => range.end <= from + cursor)) {
    const tail = text.slice(from + cursor, to).trim();
    if (tail !== '') out.push({ start: from + cursor, end: to, terminated: false });
  }
  return out;
}

/** Masks code spans, link targets and question links from the tree; the text itself is returned unchanged. */
export function maskInline(text: string): string {
  return text;
}

/** Splits a Markdown text into sentences in the wiki's language. */
export function sentencesOf(masked: string, language?: string): Sentence[] {
  const text = masked.trim();
  if (text === '') return [];
  const offset = masked.indexOf(text);
  const index = indexSource(masked, 0, masked.length);
  return sentenceRanges(masked, offset, offset + text.length, language, index).map((range) => ({
    text: masked.slice(range.start, range.end).trim(),
    terminated: range.terminated,
  }));
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

function joined(lines: string): string {
  return lines.split('\n').map((line) => line.trim()).join(' ');
}

function headingText(raw: string): string {
  const first = raw.split('\n')[0]!.trim();
  if (!first.startsWith('#')) return first.trim();
  let at = 0;
  while (first[at] === '#') at += 1;
  while (first[at] === ' ' || first[at] === '\t') at += 1;
  return first.slice(at).trim();
}

/** The units of a body (paragraphs, list items, quotes), its headings and its footnote definitions, without judging any of them. */
export function readUnits(body: string, bodyStart: number): { units: TextUnit[]; definitions: Definition[]; headings: TextUnit[] } {
  const root = treeOf(body);
  const units: TextUnit[] = [];
  const headings: TextUnit[] = [];
  const definitions: Definition[] = [];
  const lineOf = (node: Node): number => bodyStart + (node.position?.start.line ?? 1) - 1;
  const collect = (node: Node, inDefinition: boolean): void => {
    if (node.type === 'footnoteDefinition') {
      const raw = body.slice(startOf(node), endOf(node));
      const marker = raw.indexOf(']:');
      const text = joined(marker >= 0 ? raw.slice(marker + 2) : raw);
      definitions.push({ label: node.identifier ?? node.label ?? '', line: lineOf(node), text });
      return;
    }
    if (node.type === 'paragraph' && !inDefinition) {
      units.push({ line: lineOf(node), text: joined(body.slice(startOf(node), endOf(node))) });
      return;
    }
    if (node.type === 'heading' && !inDefinition) {
      headings.push({ line: lineOf(node), text: headingText(body.slice(startOf(node), endOf(node))) });
      return;
    }
    for (const child of node.children ?? []) collect(child, inDefinition);
  };
  collect(root, false);
  return { units, definitions, headings };
}

function plainOfNode(node: Node, out: string[]): void {
  if (node.type === 'footnoteReference') return;
  if (node.type === 'link' && typeof node.url === 'string' && node.url.startsWith('madarch:question:')) return;
  if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'html') {
    out.push(node.value ?? '');
    return;
  }
  if (node.type === 'break') {
    out.push(' ');
    return;
  }
  for (const child of node.children ?? []) plainOfNode(child, out);
}

function withoutFootnoteReferences(text: string): string {
  let out = '';
  let at = 0;
  while (at < text.length) {
    if (text[at] === '[' && text[at + 1] === '^') {
      let end = at + 2;
      while (end < text.length && isLabelCharacter(text[end])) end += 1;
      if (end > at + 2 && text[end] === ']') {
        at = end + 1;
        continue;
      }
    }
    out += text[at]!;
    at += 1;
  }
  return out;
}

function collapseBlanks(text: string): string {
  const out: string[] = [];
  let blank = false;
  for (const character of text) {
    if (isSpace(character)) {
      blank = out.length > 0;
      continue;
    }
    if (blank) out.push(' ');
    blank = false;
    out.push(character);
  }
  return out.join('');
}

/** The grounds of a footnote definition: its links, in order. */
export function groundLinks(text: string): { label: string; target: string }[] {
  const links: { label: string; target: string }[] = [];
  const root = treeOf(text);
  walk(root, (node) => {
    if (node.type !== 'link' || typeof node.url !== 'string') return;
    const parts: string[] = [];
    for (const child of node.children ?? []) plainOfNode(child, parts);
    links.push({ label: collapseBlanks(parts.join('')), target: node.url });
  });
  return links;
}

/** A sentence as a reader sees it: references removed, links as their labels, markup dropped, blanks collapsed. */
export function plainSentence(text: string): string {
  const out: string[] = [];
  plainOfNode(treeOf(text), out);
  return collapseBlanks(withoutFootnoteReferences(out.join(''))).trim();
}

/** Question references are qualifiers; remove them from the text they follow while leaving the rest as written. */
export function withoutQuestionLinks(text: string): string {
  const index = indexSource(text, 0, text.length);
  if (index.questions.length === 0) return text.trim();
  let out = '';
  let cursor = 0;
  for (const span of [...index.questions].sort((left, right) => left.start - right.start)) {
    out += text.slice(cursor, span.start);
    cursor = span.end;
  }
  out += text.slice(cursor);
  return out.trim();
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

/** The statements of a body, in document order. `bodyStart` is the line the body starts at; `language` is the wiki's. */
export function statementsOf(body: string, bodyStart: number, language?: string): PageStatement[] {
  const root = treeOf(body);
  const index = indexSource(body, 0, body.length, root);
  const grounds = new Map<string, string[]>();
  walk(root, (node) => {
    if (node.type !== 'footnoteDefinition') return;
    const label = node.identifier ?? node.label ?? '';
    if (grounds.has(label)) return;
    const found: string[] = [];
    walk(node, (child) => {
      if (child.type !== 'link' || typeof child.url !== 'string') return;
      if (child.url.startsWith('madarch:')) found.push(child.url.slice('madarch:'.length));
    });
    grounds.set(label, found);
    grounds.set(label.toLowerCase(), found);
  });
  const seen = new Map<string, number>();
  const out: PageStatement[] = [];
  const lineOf = (node: Node): number => bodyStart + (node.position?.start.line ?? 1) - 1;
  const statementsIn = (node: Node): void => {
    if (node.type === 'footnoteDefinition') return;
    if (node.type === 'paragraph') {
      const from = startOf(node);
      const to = endOf(node);
      for (const range of sentenceRanges(body, from, to, language, index)) {
        const text = body.slice(range.start, range.end);
        const labels = index.footnotes.filter((span) => span.start >= range.start && span.end <= range.end).map((span) => span.label);
        if (labels.length === 0) continue;
        const first = labels[0]!;
        const count = (seen.get(first) ?? 0) + 1;
        seen.set(first, count);
        const plain = plainSentence(text);
        const own = [...new Set(labels.flatMap((label) => grounds.get(label) ?? grounds.get(label.toLowerCase()) ?? []))];
        const mentions = [...new Set(index.links
          .filter((link) => link.start >= range.start && link.end <= range.end && link.url.startsWith('madarch:'))
          .map((link) => link.url.slice('madarch:'.length)))];
        out.push({
          id: count === 1 ? first : `${first}~${count}`,
          labels,
          text: plain,
          digest: sha256Hex(new TextEncoder().encode(plain)),
          line: lineOf(node),
          mentions,
          grounds: own,
        });
      }
      return;
    }
    for (const child of node.children ?? []) statementsIn(child);
  };
  statementsIn(root);
  return out;
}
