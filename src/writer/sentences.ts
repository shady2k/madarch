/**
 * The sentence-level reading of a knowledge page, shared by the writer's
 * canonical form and the graph index (madarch-m38l.8, madarch-ztyq.11). A
 * statement is a sentence that ends in footnote references; its name is the
 * footnote's name (`[^refund-window]`).
 *
 * A page is parsed once as a Markdown tree; the platform's sentence segmenter
 * gives the boundaries in the wiki's language, and every later question — what
 * a sentence says, which references it ends in, which links it names — is
 * answered from that tree and those ranges. The reader never splits text with a
 * regular expression or a word list: code spans, link targets, question links
 * and footnote references are masked from the tree before the segmenter sees
 * them, so their punctuation cannot invent a sentence, and their contents are
 * never read as prose.
 */
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { sha256Hex } from '../graph/digest.js';

/** Inline code is never prose; kept as a name to say so at the call sites that read the tree. */
export const codeSpan = (node: { type: string }): boolean => node.type === 'inlineCode';

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

export interface FootnoteSpan extends Span {
  readonly label: string;
}

export interface LinkSpan extends Span {
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
function indexSource(text: string, from: number, to: number, root: Node): SourceIndex {
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
      if ((node.type === 'link' || node.type === 'image') && typeof node.url === 'string') {
        links.push({ start, end, url: node.url });
        if (node.type === 'link' && node.url.startsWith('madarch:question:')) questions.push({ start, end, url: node.url });
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

function endsSentence(masked: string): boolean {
  let at = masked.length - 1;
  while (at >= 0 && isSpace(masked[at])) at -= 1;
  while (at >= 0 && isClosing(masked[at])) at -= 1;
  return at >= 0 && isTerminal(masked[at]);
}

export interface SentenceRange extends Span {
  readonly terminated: boolean;
}

/** A span lookup by its start, built once per page. */
type SpanAt<T extends Span> = ReadonlyMap<number, T>;

function atOf<T extends Span>(spans: readonly T[]): SpanAt<T> {
  const map = new Map<number, T>();
  for (const span of spans) if (!map.has(span.start)) map.set(span.start, span);
  return map;
}

/** The first span starting at or after `at`, by binary search over a sorted array. */
function firstAtOrAfter<T extends Span>(spans: readonly T[], at: number): number {
  let low = 0;
  let high = spans.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (spans[middle]!.start < at) low = middle + 1;
    else high = middle;
  }
  return low;
}

function spansIn<T extends Span>(spans: readonly T[], from: number, to: number): T[] {
  const out: T[] = [];
  for (let at = firstAtOrAfter(spans, from); at < spans.length && spans[at]!.start < to; at += 1) {
    if (spans[at]!.end <= to) out.push(spans[at]!);
  }
  return out;
}

/** Sentence ranges in `text[from, to)`: segmenter boundaries, extended over the notes and question suffix they end. */
function sentenceRanges(text: string, from: number, to: number, segmenter: Intl.Segmenter, index: SourceIndex, footnoteAt: SpanAt<FootnoteSpan>, questionAt: SpanAt<QuestionSpan>): SentenceRange[] {
  const masked = segmentationText(text, from, to, index);
  const parts = [...segmenter.segment(masked)];
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
      const footnote = footnoteAt.get(from + next);
      if (footnote !== undefined && footnote.end <= to) {
        after = footnote.end - from;
        continue;
      }
      const question = questionAt.get(from + next);
      if (question !== undefined && question.end <= to) {
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

/** The text with its masked sentence ends restored; the reader no longer masks them, so this is the text itself. */
export const unmask = (text: string): string => text;

interface Token {
  readonly start: number;
  readonly end: number;
  readonly kind: 'text' | 'code' | 'space';
  readonly value: string;
}

/** The inline text of the tree, node by node, with footnote references and question links left out. */
function tokensOf(node: Node, out: Token[]): void {
  for (const child of node.children ?? []) {
    if (child.type === 'footnoteReference') continue;
    if (child.type === 'link' && typeof child.url === 'string' && child.url.startsWith('madarch:question:')) continue;
    if (child.type === 'text' || child.type === 'html') {
      out.push({ start: startOf(child), end: endOf(child), kind: 'text', value: child.value ?? '' });
      continue;
    }
    if (child.type === 'inlineCode') {
      out.push({ start: startOf(child), end: endOf(child), kind: 'code', value: child.value ?? '' });
      continue;
    }
    if (child.type === 'break') {
      out.push({ start: startOf(child), end: endOf(child), kind: 'space', value: ' ' });
      continue;
    }
    tokensOf(child, out);
  }
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

function isWordStart(character: string): boolean {
  return character.toLowerCase() !== character.toUpperCase() || (character >= '0' && character <= '9');
}

function wordCount(text: string): number {
  let count = 0;
  let inWord = false;
  for (const character of text) {
    if (isWordStart(character)) {
      if (!inWord) count += 1;
      inWord = true;
    } else if (inWord && (character === "'" || character === '-')) {
      // A word continues over an apostrophe or a hyphen.
    } else {
      inWord = false;
    }
  }
  return count;
}

/** A sentence as the reader sees it: its source span, its plain words, and the nodes inside its range. */
export interface SentenceView {
  /** The sentence as written, trimmed: references and question links included. */
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly terminated: boolean;
  readonly plain: string;
  readonly footnotes: readonly FootnoteSpan[];
  readonly questions: readonly QuestionSpan[];
  readonly links: readonly LinkSpan[];
}

/** One statement's run of footnote references, with the sentence it ends. */
export interface StatementRun {
  readonly start: number;
  readonly end: number;
  readonly labels: readonly string[];
  readonly sentence: string;
}

export interface TextUnit {
  readonly line: number;
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export interface Definition {
  readonly label: string;
  readonly line: number;
  readonly text: string;
  /** The definition's grounds, without `[^name]:`. */
  readonly start: number;
  readonly end: number;
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

/** Whether a trimmed line is a footnote definition (`[^name]: grounds`), found by characters, not by a pattern over the prose. */
export function isFootnoteDefinitionLine(trimmed: string): boolean {
  if (!trimmed.startsWith('[^')) return false;
  let at = 2;
  while (at < trimmed.length && isLabelCharacter(trimmed[at])) at += 1;
  return at > 2 && trimmed[at] === ']' && trimmed[at + 1] === ':';
}

/**
 * One page, parsed once (madarch-ztyq.11): the tree, the spans of the nodes the
 * segmenter must not read, the segmenter of the wiki's language, and the inline
 * text tokens. Every question the format asks is answered from these.
 */
export class PageReading {
  readonly body: string;
  readonly root: Node;
  readonly index: SourceIndex;
  readonly tokens: Token[];
  private readonly segmenter: Intl.Segmenter;
  private readonly footnoteAt: SpanAt<FootnoteSpan>;
  private readonly questionAt: SpanAt<QuestionSpan>;
  private readonly sentenceCache = new Map<string, SentenceView[]>();

  constructor(body: string, language?: string) {
    this.body = body;
    this.root = treeOf(body);
    this.index = indexSource(body, 0, body.length, this.root);
    this.tokens = [];
    tokensOf(this.root, this.tokens);
    this.segmenter = segmenterFor(language);
    this.footnoteAt = atOf(this.index.footnotes);
    this.questionAt = atOf(this.index.questions);
  }

  /** The sentences in `[from, to)`, with their ranges and the nodes inside them; a range is segmented once. */
  sentences(from: number, to: number): SentenceView[] {
    const key = `${from}:${to}`;
    const held = this.sentenceCache.get(key);
    if (held !== undefined) return held;
    const views = sentenceRanges(this.body, from, to, this.segmenter, this.index, this.footnoteAt, this.questionAt).map((range) => ({
      text: this.body.slice(range.start, range.end).trim(),
      start: range.start,
      end: range.end,
      terminated: range.terminated,
      plain: this.plain(range.start, range.end),
      footnotes: spansIn(this.index.footnotes, range.start, range.end),
      questions: spansIn(this.index.questions, range.start, range.end),
      links: spansIn(this.index.links, range.start, range.end),
    }));
    this.sentenceCache.set(key, views);
    return views;
  }

  /** The sentence text a reader sees: references and question links removed, code kept, blanks collapsed. */
  plain(from: number, to: number): string {
    let out = '';
    let low = 0;
    let high = this.tokens.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.tokens[middle]!.end <= from) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < this.tokens.length; index += 1) {
      const token = this.tokens[index]!;
      if (token.start >= to) break;
      const start = Math.max(token.start, from);
      const end = Math.min(token.end, to);
      if (start >= end) continue;
      const value = start === token.start && end === token.end ? token.value : token.value.slice(start - token.start, end - token.start);
      out += token.kind === 'text' ? withoutFootnoteReferences(value) : value;
    }
    return collapseBlanks(out).trim();
  }

  /** The words of `[from, to)` as a reader counts them. */
  words(from: number, to: number): number {
    return wordCount(this.plain(from, to));
  }

  /** Every footnote reference used in `[from, to)`, in order. */
  footnotesIn(from: number, to: number): FootnoteSpan[] {
    return spansIn(this.index.footnotes, from, to);
  }

  /** Every link in `[from, to)`, in order. */
  linksIn(from: number, to: number): LinkSpan[] {
    return spansIn(this.index.links, from, to);
  }

  /** The links of a footnote definition's grounds in `[from, to)`, and the characters that are neither a link nor a separator. */
  groundsIn(from: number, to: number): { links: { label: string; target: string }[]; leftover: string } {
    const found = spansIn(this.index.links, from, to);
    const links = found.map((link) => ({ label: this.plain(link.start, link.end), target: link.url }));
    let leftover = '';
    const outside = (start: number, end: number): void => {
      for (let at = start; at < end; at += 1) {
        const character = this.body[at]!;
        if (character === ',' || isSpace(character)) continue;
        leftover += character;
      }
    };
    let cursor = from;
    for (const link of found) {
      outside(cursor, link.start);
      cursor = Math.max(cursor, link.end);
    }
    outside(cursor, to);
    return { links, leftover };
  }

  /** The words of `[from, to)` that stand outside links; the link labels are counted separately. */
  wordsOutsideLinks(from: number, to: number): number {
    let words = 0;
    let cursor = from;
    for (const link of spansIn(this.index.links, from, to)) {
      words += this.words(cursor, link.start);
      cursor = Math.max(cursor, link.end);
    }
    return words + this.words(cursor, to);
  }

  /** The units of a body (paragraphs and list items), its headings and its footnote definitions, with their spans. */
  units(bodyStart: number): { units: TextUnit[]; definitions: Definition[]; headings: TextUnit[] } {
    const units: TextUnit[] = [];
    const headings: TextUnit[] = [];
    const definitions: Definition[] = [];
    const lineOf = (node: Node): number => bodyStart + (node.position?.start.line ?? 1) - 1;
    const collect = (node: Node, inDefinition: boolean): void => {
      if (node.type === 'footnoteDefinition') {
        const start = startOf(node);
        const end = endOf(node);
        const raw = this.body.slice(start, end);
        const marker = raw.indexOf(']:');
        const text = joined(marker >= 0 ? raw.slice(marker + 2) : raw);
        definitions.push({ label: node.identifier ?? node.label ?? '', line: lineOf(node), text, start: start + (marker >= 0 ? marker + 2 : 0), end });
        return;
      }
      if (node.type === 'paragraph' && !inDefinition) {
        units.push({ line: lineOf(node), text: joined(this.body.slice(startOf(node), endOf(node))), start: startOf(node), end: endOf(node) });
        return;
      }
      if (node.type === 'heading' && !inDefinition) {
        headings.push({ line: lineOf(node), text: headingText(this.body.slice(startOf(node), endOf(node))), start: startOf(node), end: endOf(node) });
        return;
      }
      for (const child of node.children ?? []) collect(child, inDefinition);
    };
    collect(this.root, false);
    return { units, definitions, headings };
  }

  /** The runs of adjacent footnote references of the paragraphs, each with the sentence that ends in it. */
  runs(): StatementRun[] {
    const out: StatementRun[] = [];
    const collect = (node: Node): void => {
      if (node.type === 'footnoteDefinition') return;
      if (node.type === 'paragraph') {
        const children = node.children ?? [];
        const views = this.sentences(startOf(node), endOf(node));
        for (let index = 0; index < children.length; index += 1) {
          const child = children[index]!;
          if (child.type !== 'footnoteReference') continue;
          const start = startOf(child);
          const labels = [child.identifier ?? child.label ?? ''];
          let end = endOf(child);
          let next = index + 1;
          while (next < children.length && children[next]!.type === 'footnoteReference' && startOf(children[next]!) === end) {
            const reference = children[next]!;
            labels.push(reference.identifier ?? reference.label ?? '');
            end = endOf(reference);
            next += 1;
          }
          const view = views.find((entry) => entry.start <= start && end <= entry.end);
          out.push({ start, end, labels, sentence: view?.plain ?? this.plain(startOf(node), start) });
          index = next - 1;
        }
        return;
      }
      for (const child of node.children ?? []) collect(child);
    };
    collect(this.root);
    return out;
  }

  /** The source spans of the footnote definitions, so a canonical body can leave them out. */
  definitionSpans(): Span[] {
    const spans: Span[] = [];
    walk(this.root, (node) => {
      if (node.type === 'footnoteDefinition') spans.push({ start: startOf(node), end: endOf(node) });
    });
    return spans;
  }
}

/** Parses a page once; the same object answers every later question about it. */
export function readPage(body: string, language?: string): PageReading {
  return new PageReading(body, language);
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
  const reader = readPage(masked, language);
  return reader.sentences(offset, offset + text.length).map((range) => ({ text: range.text, terminated: range.terminated }));
}

/** The units of a body (paragraphs, list items, quotes), its headings and its footnote definitions, without judging any of them. */
export function readUnits(body: string, bodyStart: number): { units: TextUnit[]; definitions: Definition[]; headings: TextUnit[] } {
  return readPage(body).units(bodyStart);
}

/** The grounds of a footnote definition: its links, in order. */
export function groundLinks(text: string): { label: string; target: string }[] {
  const links: { label: string; target: string }[] = [];
  const root = treeOf(text);
  walk(root, (node) => {
    if (node.type !== 'link' || typeof node.url !== 'string') return;
    const parts: string[] = [];
    for (const child of node.children ?? []) if (child.type === 'text' || child.type === 'inlineCode') parts.push(child.value ?? '');
    links.push({ label: collapseBlanks(parts.join('')), target: node.url });
  });
  return links;
}

/** A sentence as a reader sees it: references removed, links as their labels, markup dropped, blanks collapsed. */
export function plainSentence(text: string): string {
  const reader = readPage(text);
  return reader.plain(0, text.length);
}

/** Question references are qualifiers; remove them from the text they follow while leaving the rest as written. */
export function withoutQuestionLinks(text: string): string {
  const reader = readPage(text);
  const questions = reader.linksIn(0, text.length).filter((link) => link.url.startsWith('madarch:question:'));
  if (questions.length === 0) return text.trim();
  let out = '';
  let cursor = 0;
  for (const span of questions) {
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
  const reader = new PageReading(body, language);
  const grounds = new Map<string, string[]>();
  walk(reader.root, (node) => {
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
      for (const view of reader.sentences(startOf(node), endOf(node))) {
        const labels = view.footnotes.map((span) => span.label);
        if (labels.length === 0) continue;
        const first = labels[0]!;
        const count = (seen.get(first) ?? 0) + 1;
        seen.set(first, count);
        const own = [...new Set(labels.flatMap((label) => grounds.get(label) ?? grounds.get(label.toLowerCase()) ?? []))];
        const mentions = [...new Set(view.links.filter((link) => link.url.startsWith('madarch:')).map((link) => link.url.slice('madarch:'.length)))];
        out.push({
          id: count === 1 ? first : `${first}~${count}`,
          labels,
          text: view.plain,
          digest: sha256Hex(new TextEncoder().encode(view.plain)),
          line: lineOf(node),
          mentions,
          grounds: own,
        });
      }
      return;
    }
    for (const child of node.children ?? []) statementsIn(child);
  };
  statementsIn(reader.root);
  return out;
}
