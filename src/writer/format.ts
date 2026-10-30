/**
 * The knowledge Markdown an agent writes (decision 0029; the vertical's shared
 * formats, section 1): one file per entity, a YAML front matter, a body whose
 * every statement sentence ends in footnote references, and footnotes whose
 * grounds are `madarch:` links to graph keys or document sections.
 *
 * `checkPage` is the writer's whole check: it parses a page, refuses what does
 * not follow the format (each refusal names the line and the rule), asks the
 * resolver whether every ground and every link exists, and returns the page in
 * its canonical form. Nothing here knows a product: the kinds, ids and domains
 * a page may name come from the caller.
 */
import { parse as parseYaml } from 'yaml';
import { byCodePoint } from '../model/order.js';
import { headingLinks } from '../knowledge/markdown.js';
import type { WrittenAt } from '../knowledge/index/page.js';
import { isNumbered, nameStatements, sentenceKey } from './names.js';
import { insertMentionLinks, type MentionName } from './mentions.js';
import { type Definition, type PageReading, readPage, statementsOf } from './sentences.js';

/** One reason a page is refused: the line (1-based, in the whole file), the rule and a message the agent can act on. */
export interface Refusal {
  readonly line: number;
  readonly rule: string;
  readonly message: string;
}

/** Whether a ground or a link exists; the graph's implementation is in `grounds.ts`. */
export interface GroundResolver {
  /** A graph logical key exists in the graph at the fill's last commit. */
  graphKey(key: string): Promise<boolean>;
  /** The document at `path` has a section `anchor` (lower case). */
  docSection(path: string, anchor: string): Promise<boolean>;
  /** A `sources` entry: a document path of the graph, or an id or anchor found in a document. */
  sourceName(name: string): Promise<boolean>;
  /**
   * The name a ground is shown by: the entity's label, or the section's heading. The writer sets every ground's label
   * from it, so an agent's own wording never stands for an entity (madarch-m38l.13). Absent: the agent's label stays.
   */
  nameOf?(target: MadarchTarget): Promise<string | undefined>;
  /** The key of the one route `METHOD path` names, when the graph has exactly one; a code span that names it is made a link. */
  uniqueRoute?(method: string, routePath: string): Promise<string | undefined>;
  /** The key of the one symbol of this exact name, when the graph has exactly one; a code span that names it is made a link. */
  uniqueSymbol?(name: string): Promise<string | undefined>;
  /** The graph's key prefixes at the last commit, used to recognize a raw entity id in prose. */
  keyPrefixes?(): Promise<readonly string[]>;
}

/**
 * The kinds of page the writer checks (decision 0032, section 1): the product page and the domain
 * pages of 0029, the graph's verdicts, an entity's enrichment, the home page and the editorial
 * pass's report. A kind is what the page's front matter must say it is; the rules of the format are
 * the same for all of them.
 */
export type PageKind = 'product' | 'domain' | 'validation' | 'enrichment' | 'overview' | 'editorial';

/** What the caller knows about the page being checked. */
export interface PageExpectation {
  readonly id: string;
  readonly kind: PageKind;
  /** The domains the product page declared; `madarch:domain:<slug>` links may name only these. */
  readonly domains: readonly string[];
  /** For a product page: every declared domain must be linked from it. */
  readonly mustLinkDomains: boolean;
  /** For a domain page: the product page it may link. */
  readonly productId?: string;
  /** The repositories the page is written from, recorded in its front matter as `written-at`; the agent does not write them. */
  readonly writtenAt?: readonly WrittenAt[];
  /** The page this one replaces, as written: a sentence it kept keeps its footnote name. */
  readonly previous?: string;
  /**
   * The ids of the question and correction files a statement may stand on or a link may name (`question:<slug>`):
   * the answered questions and the corrections of the product (madarch-m38l.7). Any other entity page is refused.
   */
  readonly entities?: readonly string[];
  /** All fresh question ids, including unanswered questions: links, not necessarily grounds. */
  readonly questions?: readonly string[];
  /** The wiki language, when known at the write boundary. */
  readonly language?: 'en' | 'ru';
  /** Product-relative file and its full path, when the caller knows them. */
  readonly file?: string;
  readonly fullPath?: string;
  /**
   * Keys this kind of page owns beside the format's own, each a text or a whole number: the identity an
   * enrichment is keyed by and the lines of the source it enriches (`src/writer/enrichment.ts`). A page
   * of another kind that carries one is still refused, so the format stays one format.
   */
  readonly extraFrontKeys?: readonly string[];
}

export interface FrontMatter {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly relates: readonly string[];
  readonly producer: 'agent';
  readonly sources: readonly string[];
  readonly writtenAt: readonly WrittenAt[];
  /**
   * The keys this kind of page owns beside the format's own (`PageExpectation.extraFrontKeys`), in code
   * point order of their names: an enrichment's identity and the lines of the source it stands at
   * (`src/writer/enrichment.ts`). A page of a kind that owns none carries none.
   */
  readonly extra: Readonly<Record<string, string | number>>;
}

/** A page that passed, in canonical form (what is written to disk). */
export interface CheckedPage {
  readonly frontMatter: FrontMatter;
  readonly markdown: string;
  /** Every ground of every footnote, in order of appearance. */
  readonly grounds: readonly string[];
  /** Every entity link in the text, in order of appearance. */
  readonly links: readonly string[];
}

export type PageCheck = { readonly ok: true; readonly page: CheckedPage } | { readonly ok: false; readonly refusals: readonly Refusal[] };

export const SLUG = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
export const MAX_SLUG_LENGTH = 40;

const FRONT_KEYS = ['id', 'kind', 'title', 'relates', 'producer', 'sources'] as const;
/** Keys the writer fills in; an agent may leave them out, and what it writes is replaced. */
const WRITER_KEYS = ['written-at'] as const;
/** The most words a heading may have; a longer one reads as a statement. */
const HEADING_WORDS = 10;

type Split = { front: string; body: string; bodyStart: number };

/** Splits a file into its front matter text and body, with the 1-based line the body starts at. */
function splitFrontMatter(markdown: string): Split | Refusal {
  const lines = markdown.split('\n');
  if (lines[0] !== '---') return { line: 1, rule: 'front-matter', message: 'a page starts with a line of three dashes that opens its YAML front matter (id, kind, title, relates, producer, sources)' };
  const end = lines.indexOf('---', 1);
  if (end < 0) return { line: 1, rule: 'front-matter', message: 'the front matter opened on line 1 is never closed by a line of three dashes' };
  return { front: lines.slice(1, end).join('\n'), body: lines.slice(end + 1).join('\n'), bodyStart: end + 2 };
}

function frontMatterOf(text: string, expected: PageExpectation): { front?: FrontMatter; refusals: Refusal[] } {
  const refusals: Refusal[] = [];
  const refuse = (message: string): void => { refusals.push({ line: 2, rule: 'front-matter', message }); };
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    return { refusals: [{ line: 2, rule: 'front-matter', message: `the front matter is no YAML: ${(error as Error).message.split('\n')[0]}` }] };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { refusals: [{ line: 2, rule: 'front-matter', message: 'the front matter is a YAML mapping with the keys id, kind, title, relates, producer, sources' }] };
  const record = raw as Record<string, unknown>;
  const owned = expected.extraFrontKeys ?? [];
  for (const key of Object.keys(record)) {
    if ((FRONT_KEYS as readonly string[]).includes(key) || (WRITER_KEYS as readonly string[]).includes(key)) continue;
    if (owned.includes(key)) {
      const value = record[key];
      if (typeof value !== 'string' && !(typeof value === 'number' && Number.isInteger(value))) refuse(`the front matter key "${key}" is a text or a whole number`);
      continue;
    }
    refuse(`the front matter key "${key}" is not part of the format; the keys are ${[...FRONT_KEYS, ...owned].join(', ')}`);
  }
  for (const key of FRONT_KEYS) if (!(key in record)) refuse(`the front matter lacks "${key}"`);
  if (record['id'] !== expected.id) refuse(`id is ${JSON.stringify(record['id'])} but this page's id is "${expected.id}"`);
  if (record['kind'] !== expected.kind) refuse(`kind is ${JSON.stringify(record['kind'])} but this page's kind is "${expected.kind}"`);
  if (typeof record['title'] !== 'string' || record['title'].trim() === '') refuse('title is a non-empty text');
  if (record['producer'] !== 'agent') refuse(`producer is ${JSON.stringify(record['producer'])}: a page an agent writes names producer "agent"`);
  const list = (key: 'relates' | 'sources'): string[] => {
    const value = record[key];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
      if (key in record) refuse(`${key} is a list of non-empty texts`);
      return [];
    }
    return value as string[];
  };
  const relates = list('relates');
  const sources = list('sources');
  // The kind's own keys, kept as written: a text or a whole number, never a nested value.
  const extra: Record<string, string | number> = {};
  for (const key of owned) {
    const value = record[key];
    if (typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value))) extra[key] = value;
  }
  if (refusals.length > 0) return { refusals };
  return {
    refusals,
    front: {
      id: expected.id,
      kind: expected.kind,
      title: (record['title'] as string).trim(),
      relates: [...new Set(relates)].sort(byCodePoint),
      producer: 'agent',
      sources: [...new Set(sources)].sort(byCodePoint),
      writtenAt: expected.writtenAt ?? [],
      extra: Object.fromEntries(Object.entries(extra).sort(([left], [right]) => byCodePoint(left, right))),
    },
  };
}

/** The target of a `madarch:` link, classified. */
export type MadarchTarget =
  | { readonly type: 'doc'; readonly path: string; readonly anchor: string }
  | { readonly type: 'page'; readonly id: string }
  | { readonly type: 'graph'; readonly key: string };

/** Reads the target after the `madarch:` scheme; `undefined` when it has no usable shape. */
export function parseTarget(target: string): MadarchTarget | undefined {
  if (target === '') return undefined;
  if (target.startsWith('doc:')) {
    const rest = target.slice(4);
    const hash = rest.indexOf('#');
    if (hash <= 0 || hash === rest.length - 1) return undefined;
    return { type: 'doc', path: rest.slice(0, hash), anchor: rest.slice(hash + 1).toLowerCase() };
  }
  if (target.startsWith('domain:') || target.startsWith('product:') || target.startsWith('question:') || target.startsWith('correction:')) return { type: 'page', id: target };
  if (!/^[a-z][a-z0-9.-]*:.+/.test(target)) return undefined;
  return { type: 'graph', key: target };
}

/** The words of a unit: link targets and footnote references removed, markup dropped. */
interface TextUnit {
  readonly line: number;
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function lineStarts(body: string): number[] {
  const starts = [0];
  for (let at = 0; at < body.length; at += 1) if (body[at] === '\n') starts.push(at + 1);
  return starts;
}

/** The 1-based line in the whole file of an offset in the body. */
function lineAt(starts: readonly number[], bodyStart: number, offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (starts[middle]! <= offset) low = middle + 1;
    else high = middle;
  }
  return bodyStart + Math.max(0, low - 1);
}

interface TreeLike {
  type: string;
  value?: string;
  position?: { start?: { line?: number; offset?: number }; end?: { line?: number; offset?: number } };
  children?: TreeLike[];
}

function textUnits(body: string, bodyStart: number, refusals: Refusal[], reader: PageReading): { units: TextUnit[]; definitions: Definition[]; headings: TextUnit[] } {
  // The tree says what the units and headings are; this walk only names the shapes the format forbids.
  const starts = lineStarts(body);
  const controlled = new Set<number>();
  for (let at = 0; at < body.length; at += 1) {
    const code = body.charCodeAt(at);
    if (code >= 1 && code <= 4) controlled.add(lineAt(starts, bodyStart, at));
  }
  for (const line of controlled) refusals.push({ line, rule: 'characters', message: 'the page holds a control character (U+0001 to U+0004), which the format does not allow' });
  const startOf = (node: TreeLike): number => node.position?.start?.offset ?? 0;
  const endOf = (node: TreeLike): number => node.position?.end?.offset ?? startOf(node);
  const visit = (node: TreeLike): void => {
    const start = startOf(node);
    const line = bodyStart + ((node.position?.start?.line ?? 1) - 1);
    if (node.type === 'code') {
      const raw = body.slice(start, endOf(node)).trimStart();
      if (raw.startsWith('```') || raw.startsWith('~~~')) refusals.push({ line, rule: 'fenced-code', message: 'a fenced block is not part of the format: madarch draws diagrams and shows code from the graph, so state each fact as a sentence with grounds' });
    } else if (node.type === 'table') {
      refusals.push({ line, rule: 'table', message: 'a table is not part of the format: state each fact as a sentence with its own footnote' });
    } else if (node.type === 'html') {
      const localLine = (node.position?.start?.line ?? 1) - 1;
      const lineStart = starts[Math.max(0, localLine)] ?? 0;
      const before = body.slice(lineStart, start).trim();
      const raw = body.slice(start, endOf(node));
      const first = raw[0];
      const next = raw[1];
      if (before === '' && first === '<' && next !== undefined && ((next >= 'A' && next <= 'Z') || (next >= 'a' && next <= 'z') || next === '!' || next === '/')) {
        refusals.push({ line, rule: 'html', message: 'raw HTML is not part of the format' });
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(reader.root as unknown as TreeLike);
  return reader.units(bodyStart);
}

/** The most words one link label may carry before the line reads as a statement rather than a place. */
const LINK_LABEL_WORDS = 2;

/** The most words all labels of a connecting line may carry together. */
const LINK_LINE_WORDS = 10;

/**
 * A unit that only connects: every word it shows stands in a link, and the text
 * outside the links is whitespace or separator punctuation. This is structure,
 * not vocabulary: one word between or around the links makes the unit a
 * statement, and a label is a name only when it is at most two words.
 */
function connecting(unit: TextUnit, reader: PageReading): boolean {
  const views = reader.sentences(unit.start, unit.end);
  if (views.length !== 1) return false;
  const sentence = views[0]!;
  if (sentence.footnotes.length > 0 || sentence.questions.length > 0) return false;
  const links = sentence.links.filter((link) => !link.url.startsWith('madarch:question:'));
  if (links.length === 0) return false;
  const labels = links.map((link) => reader.words(link.start, link.end));
  if (labels.some((count) => count > LINK_LABEL_WORDS)) return false;
  if (labels.reduce((sum, count) => sum + count, 0) > LINK_LINE_WORDS) return false;
  return reader.wordsOutsideLinks(unit.start, unit.end) === 0;
}

const isSpaceCharacter = (character: string | undefined): boolean => character === ' ' || character === '\t' || character === '\n' || character === '\r' || character === '\f' || character === '\v';
const isTerminalCharacter = (character: string | undefined): boolean => character === '.' || character === '!' || character === '?' || character === '\u2026';
const isClosingCharacter = (character: string | undefined): boolean => character === ')' || character === ']' || character === '"' || character === "'" || character === '\u201d' || character === '\u2019' || character === '\u00bb';
const isFootnoteLabelCharacter = (character: string | undefined): boolean => character !== undefined && (character === '_' || character === '-' || character.toLowerCase() !== character.toUpperCase() || (character >= '0' && character <= '9'));

/** The slice `body[from, to)` with the given absolute spans left out. */
function textWithout(body: string, from: number, to: number, spans: readonly { start: number; end: number }[]): string {
  let out = '';
  let cursor = from;
  for (const span of spans) {
    if (span.end <= from || span.start >= to) continue;
    out += body.slice(cursor, Math.max(cursor, span.start));
    cursor = Math.max(cursor, span.end);
  }
  return out + body.slice(cursor, to);
}

/** Whether the text ends in one or more footnote references, and, when the sentence is terminated, in terminal punctuation before them. */
function groundedEnd(text: string, terminated: boolean): boolean {
  let end = text.length;
  while (end > 0 && isSpaceCharacter(text[end - 1])) end -= 1;
  let references = 0;
  for (;;) {
    if (end === 0 || text[end - 1] !== ']') break;
    let at = end - 2;
    while (at >= 0 && isFootnoteLabelCharacter(text[at])) at -= 1;
    if (at < 1 || text[at] !== '^' || text[at - 1] !== '[' || at === end - 2) break;
    references += 1;
    end = at - 1;
  }
  if (references === 0) return false;
  if (!terminated) return true;
  let at = end - 1;
  while (at >= 0 && isSpaceCharacter(text[at])) at -= 1;
  while (at >= 0 && isClosingCharacter(text[at])) at -= 1;
  return at >= 0 && isTerminalCharacter(text[at]);
}

/** Whether an offset range lies inside one of the sorted spans. */
function inSpans(spans: readonly { start: number; end: number }[], start: number, end: number): boolean {
  let low = 0;
  let high = spans.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (spans[middle]!.start <= start) low = middle + 1;
    else high = middle;
  }
  for (let index = low - 1; index >= 0; index -= 1) {
    const span = spans[index]!;
    if (span.end <= start) break;
    if (start >= span.start && end <= span.end) return true;
  }
  return false;
}

function hasBlank(text: string): boolean {
  for (const character of text) if (character.trim() === '') return true;
  return false;
}

function withoutCall(text: string): string {
  return text.endsWith('()') ? text.slice(0, -2) : text;
}

function collapseInline(text: string): string {
  let out = '';
  let blank = false;
  for (const character of text.trim()) {
    if (character.trim() === '') { blank = out !== ''; continue; }
    if (blank) out += ' ';
    blank = false;
    out += character;
  }
  return out;
}

/** `POST /pay` when a code span is one method and one absolute path; no HTTP-method list is needed. */
function routeOf(text: string): { method: string; path: string } | undefined {
  const trimmed = text.trim();
  let space = -1;
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index]!.trim() === '') { space = index; break; }
  }
  if (space <= 0) return undefined;
  const method = trimmed.slice(0, space);
  let rest = space + 1;
  while (rest < trimmed.length && trimmed[rest]!.trim() === '') rest += 1;
  const path = trimmed.slice(rest);
  if (path[0] !== '/' || hasBlank(path)) return undefined;
  return { method, path };
}

/**
 * A route or an operation named in a code span is an entity, and an entity is named with a link (madarch-m38l.13):
 * `POST /pay` becomes [POST /pay](madarch:code.route:...) when the graph has that one route, and `refund` becomes a link
 * when exactly one symbol bears the name. A span that names nothing, or something ambiguous, stays as the agent wrote it.
 * The reader's inlineCode nodes say where the spans are; headings, footnote definitions and what already sits inside a
 * link are left alone.
 */
async function linkCodeSpans(body: string, resolver: GroundResolver): Promise<string> {
  if (resolver.uniqueRoute === undefined && resolver.uniqueSymbol === undefined) return body;
  const reader = readPage(body);
  const links = reader.linksIn(0, body.length);
  const units = reader.units(1);
  const structural = [...units.headings, ...units.definitions].sort((left, right) => left.start - right.start);
  const codes = reader.tokens.filter((token) => token.kind === 'code');
  let out = body;
  for (let index = codes.length - 1; index >= 0; index -= 1) {
    const code = codes[index]!;
    if (inSpans(links, code.start, code.end) || inSpans(structural, code.start, code.end)) continue;
    const inner = code.value.trim();
    if (inner === '') continue;
    const route = routeOf(inner);
    let key: string | undefined;
    if (route !== undefined) key = await resolver.uniqueRoute?.(route.method, route.path);
    else if (!hasBlank(inner)) key = await resolver.uniqueSymbol?.(withoutCall(inner));
    if (key === undefined || hasBlank(key)) continue;
    const label = withoutCall(collapseInline(inner));
    out = out.slice(0, code.start) + `[${label}](madarch:${key})` + out.slice(code.end);
  }
  return out;
}

/** The key prefixes the writer always knows: its page and document targets. */
const DEFAULT_KEY_PREFIXES: readonly string[] = ['question', 'correction', 'domain', 'product', 'doc', 'engine', 'code.'];

const TOKEN_EDGES = new Set(['(', ')', '[', ']', '{', '}', '<', '>', '"', "'", '“', '”', '«', '»', '.', ',', ';', ':', '!', '?']);

interface TextToken {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** The whitespace-separated tokens of one parsed text node, with surrounding punctuation removed. */
function tokensIn(value: string, offset: number): TextToken[] {
  const out: TextToken[] = [];
  let start = -1;
  for (let index = 0; index <= value.length; index += 1) {
    const character = value[index];
    const blank = character === undefined || character.trim() === '';
    if (!blank) {
      if (start < 0) start = index;
      continue;
    }
    if (start >= 0) {
      let from = start;
      let to = index;
      while (from < to && TOKEN_EDGES.has(value[from]!)) from += 1;
      while (to > from && TOKEN_EDGES.has(value[to - 1]!)) to -= 1;
      if (to > from) out.push({ start: offset + from, end: offset + to, text: value.slice(from, to) });
      start = -1;
    }
  }
  return out;
}

function hasKeyPrefix(token: string, prefixes: readonly string[]): boolean {
  if (token.startsWith('madarch:')) token = token.slice('madarch:'.length);
  for (const prefix of prefixes) {
    if (prefix.endsWith('.')) {
      if (token.startsWith(prefix)) return true;
    } else if (token.startsWith(`${prefix}:`)) return true;
  }
  return false;
}

/** The raw ids written in parsed text and code nodes, outside links; the graph's prefixes are data. */
function rawEntityTokens(reader: PageReading, body: string, prefixes: readonly string[]): TextToken[] {
  const links = reader.linksIn(0, body.length);
  const out: TextToken[] = [];
  let link = 0;
  for (const token of reader.tokens) {
    while (link < links.length && links[link]!.end <= token.start) link += 1;
    const held = link < links.length && token.start >= links[link]!.start && token.end <= links[link]!.end;
    if (held) continue;
    for (const candidate of tokensIn(token.value, token.start)) {
      if (hasKeyPrefix(candidate.text, prefixes)) out.push(candidate);
    }
  }
  return out;
}

/**
 * Checks one page. Every rule that fails is reported at once, so an agent
 * fixes a page in one round rather than one rule at a time.
 */
export async function checkPage(markdown: string, expected: PageExpectation, resolver: GroundResolver, mentions: readonly MentionName[] = []): Promise<PageCheck> {
  const located = (refusal: Refusal): Refusal => {
    const location = [expected.file, expected.fullPath].filter((part): part is string => part !== undefined).join(' — ');
    return location === '' ? refusal : { ...refusal, message: `${location}:${refusal.line}: ${refusal.message}` };
  };
  const split = splitFrontMatter(markdown.replace(/\r\n/g, '\n'));
  if ('rule' in split) return { ok: false, refusals: [located(split)] };
  const refusals: Refusal[] = [];
  const front = frontMatterOf(split.front, expected);
  refusals.push(...front.refusals);
  const body = await linkCodeSpans(split.body, resolver);
  const reader = readPage(body, expected.language);
  const { units, definitions, headings } = textUnits(body, split.bodyStart, refusals, reader);
  // The tree's text and code nodes carry candidate tokens; a graph key prefix says a token is a raw id.
  const prefixes = resolver.keyPrefixes === undefined ? DEFAULT_KEY_PREFIXES : await resolver.keyPrefixes();
  const starts = lineStarts(body);
  for (const token of rawEntityTokens(reader, body, prefixes)) {
    refusals.push({ line: lineAt(starts, split.bodyStart, token.start), rule: 'raw-entity-id', message: `the raw entity id ${JSON.stringify(token.text)} is not reader-facing prose: use a human-readable Markdown link; place a question link at the end of its sentence as [→ question: …](madarch:question:<slug>) or [→ вопрос: …](madarch:question:<slug>)` });
  }

  const known = new Map<string, boolean>();
  const resolves = async (target: MadarchTarget): Promise<boolean> => {
    const id = target.type === 'doc' ? `doc:${target.path}#${target.anchor}` : target.type === 'graph' ? target.key : target.id;
    const held = known.get(id);
    if (held !== undefined) return held;
    const found = target.type === 'doc' ? await resolver.docSection(target.path, target.anchor) : target.type === 'graph' ? await resolver.graphKey(target.key) : true;
    known.set(id, found);
    return found;
  };

  if (front.front !== undefined) {
    for (const key of front.front.relates) {
      const parsed = parseTarget(key);
      if (parsed === undefined || parsed.type !== 'graph') refusals.push({ line: 2, rule: 'unresolved-relation', message: `relates entry "${key}" is no graph logical key` });
      else if (!(await resolves(parsed))) refusals.push({ line: 2, rule: 'unresolved-relation', message: `relates entry "${key}" is no key of the graph at the last filled commit` });
    }
    for (const name of front.front.sources) {
      if (!(await resolver.sourceName(name))) refusals.push({ line: 2, rule: 'unresolved-source', message: `sources entry "${name}" is neither a document path of the graph nor an id found in a document` });
    }
  }

  const defined = new Map<string, { line: number; grounds: { label: string; target: string }[] }>();
  const allGrounds: string[] = [];
  for (const definition of definitions) {
    if (defined.has(definition.label)) { refusals.push({ line: definition.line, rule: 'footnote', message: `the footnote [^${definition.label}] is defined twice` }); continue; }
    const { links, leftover } = reader.groundsIn(definition.start, definition.end);
    if (links.length === 0) refusals.push({ line: definition.line, rule: 'ungrounded-footnote', message: `the footnote [^${definition.label}] lists no ground: it is one or more madarch: links separated by commas` });
    if (leftover !== '') refusals.push({ line: definition.line, rule: 'footnote', message: `the footnote [^${definition.label}] holds text that is no ground (${JSON.stringify(leftover.slice(0, 40))}): only madarch: links separated by commas` });
    for (const ground of links) {
      if (!ground.target.startsWith('madarch:')) { refusals.push({ line: definition.line, rule: 'ground-scheme', message: `the ground "${ground.label}" links ${JSON.stringify(ground.target)}: a ground is a madarch: link to a graph key or to doc:<path>#<anchor>` }); continue; }
      const parsed = parseTarget(ground.target.slice('madarch:'.length));
      if (parsed === undefined) { refusals.push({ line: definition.line, rule: 'ground-shape', message: `the ground target ${JSON.stringify(ground.target)} is no graph key (kind:path) and no doc:<path>#<anchor>` }); continue; }
      if (parsed.type === 'page' && /^(question|correction):/.test(parsed.id) && expected.entities?.includes(parsed.id) === true) { allGrounds.push(parsed.id); continue; }
      if (parsed.type === 'page') { refusals.push({ line: definition.line, rule: 'ground-shape', message: /^(question|correction):/.test(parsed.id) ? `the ground ${JSON.stringify(ground.target)} is no answered question and no correction of this product (${expected.entities === undefined || expected.entities.length === 0 ? 'there are none' : expected.entities.join(', ')})` : `the ground target ${JSON.stringify(ground.target)} is a page, not evidence: a ground is a graph key or a document section` }); continue; }
      if (!(await resolves(parsed))) {
        refusals.push({
          line: definition.line,
          rule: 'unresolved-ground',
          message: parsed.type === 'doc'
            ? `the ground ${ground.target} does not resolve: the document ${parsed.path} has no section "${parsed.anchor}" at the last filled commit`
            : `the ground ${ground.target} does not resolve: the graph has no key ${parsed.key} at the last filled commit`,
        });
      }
      allGrounds.push(ground.target.slice('madarch:'.length));
    }
    defined.set(definition.label, { line: definition.line, grounds: links });
  }
  // Each ground is shown by the name the graph gives it, never by the agent's wording.
  const names = new Map<string, string>();
  if (resolver.nameOf !== undefined) {
    for (const entry of defined.values()) {
      for (const ground of entry.grounds) {
        if (names.has(ground.target) || !ground.target.startsWith('madarch:')) continue;
        const parsed = parseTarget(ground.target.slice('madarch:'.length));
        if (parsed === undefined || parsed.type === 'page') continue;
        const name = await resolver.nameOf(parsed);
        if (name !== undefined && name.trim() !== '') names.set(ground.target, name.trim());
      }
    }
  }

  const links: string[] = [];
  const checkLinks = async (unit: TextUnit): Promise<void> => {
    for (const link of reader.linksIn(unit.start, unit.end)) {
      const target = link.url;
      if (!target.startsWith('madarch:')) { refusals.push({ line: unit.line, rule: 'link-scheme', message: `the link ${JSON.stringify(target)} is no madarch: link: mention an entity as [name](madarch:<graph key>)` }); continue; }
      const parsed = parseTarget(target.slice('madarch:'.length));
      if (parsed === undefined) { refusals.push({ line: unit.line, rule: 'link-shape', message: `the link target ${JSON.stringify(target)} is no graph key (kind:path), doc:<path>#<anchor> or domain:<slug>` }); continue; }
      links.push(target.slice('madarch:'.length));
      if (parsed.type === 'page') {
        const slug = parsed.id.startsWith('domain:') ? parsed.id.slice('domain:'.length) : undefined;
        const own = parsed.id === expected.id || parsed.id === expected.productId || expected.entities?.includes(parsed.id) === true || expected.questions?.includes(parsed.id) === true;
        if (!own && !(slug !== undefined && expected.domains.includes(slug))) {
          refusals.push({ line: unit.line, rule: 'link-outside-graph', message: `the link ${target} names a page that does not exist: the pages are this one (${expected.id}) and the declared domains (${expected.domains.map((d) => `domain:${d}`).join(', ') || 'none declared'})` });
        }
      } else if (!(await resolves(parsed))) {
        refusals.push({ line: unit.line, rule: 'link-outside-graph', message: parsed.type === 'doc' ? `the link ${target} is outside the graph: the document ${parsed.path} has no section "${parsed.anchor}"` : `the link ${target} is outside the graph: no node has the key ${parsed.key} at the last filled commit` });
      }
    }
  };
  for (const link of headingLinks(body, split.bodyStart)) {
    if (!link.url.startsWith('madarch:')) continue;
    const target = parseTarget(link.url.slice('madarch:'.length));
    if (target?.type === 'page' && target.id.startsWith('question:')) refusals.push({ line: link.line, rule: 'question-link-position', message: 'a question link cannot stand in a heading: put it as a localized suffix after the affected grounded sentence' });
  }
  for (const heading of headings) {
    await checkLinks(heading);
    const linksInHeading = reader.linksIn(heading.start, heading.end);
    if (reader.wordsOutsideLinks(heading.start, heading.end) === 0 && linksInHeading.length > 0) {
      refusals.push({ line: heading.line, rule: 'reference-heading', message: 'a reference-only heading is not a topic: use a descriptive heading and put the human-readable question link at the end of the sentence it concerns ([→ question: …] / [→ вопрос: …])' });
    }
    if (reader.footnotesIn(heading.start, heading.end).length > 0) refusals.push({ line: heading.line, rule: 'heading-footnote', message: 'a heading is connecting text and carries no footnote: put the statement in a sentence below it' });
    const headingWords = reader.words(heading.start, heading.end);
    if (headingWords > HEADING_WORDS) refusals.push({ line: heading.line, rule: 'heading-statement', message: `this heading has ${headingWords} words; a heading is at most ${HEADING_WORDS}, so a statement belongs in a sentence with grounds below it` });
  }
  const used: string[] = [];
  for (const unit of units) {
    await checkLinks(unit);
    for (const sentence of reader.sentences(unit.start, unit.end)) {
      if (sentence.questions.length === 0) continue;
      const claim = textWithout(body, sentence.start, sentence.end, sentence.questions);
      const first = sentence.questions[0]!;
      const suffix = textWithout(body, first.end, sentence.end, sentence.questions).trim();
      if (!sentence.terminated || !groundedEnd(claim, true) || suffix !== '') {
        refusals.push({ line: unit.line, rule: 'question-link-position', message: 'put the question link after the terminal punctuation and grounds of the sentence it concerns, not in a heading, a separate paragraph or the middle of a claim' });
      }
      for (const link of sentence.questions) {
        const label = reader.linkLabel(link.start, link.end);
        if (label === '' || label === '→' || label.startsWith('question:') || label.startsWith('madarch:question:')) {
          refusals.push({ line: unit.line, rule: 'question-link-label', message: 'a question link needs a human-readable title: [Which decision?](madarch:question:<slug>)' });
        }
      }
    }
    for (const reference of reader.footnotesIn(unit.start, unit.end)) {
      if (!defined.has(reference.label)) refusals.push({ line: unit.line, rule: 'undefined-footnote', message: `[^${reference.label}] is used but never defined: add a line "[^${reference.label}]: [name](madarch:<key>)" at the end` });
      used.push(reference.label);
    }
    if (connecting(unit, reader)) continue;
    for (const sentence of reader.sentences(unit.start, unit.end)) {
      const claim = textWithout(body, sentence.start, sentence.end, sentence.questions);
      const linksOfSentence = sentence.links.filter((link) => !link.url.startsWith('madarch:question:'));
      const hasLink = linksOfSentence.some((link) => link.url.startsWith('madarch:'));
      if (reader.words(sentence.start, sentence.end) < 2 && !hasLink) continue;
      const labels = sentence.footnotes.map((reference) => reference.label);
      const named = new Set(linksOfSentence.map((link) => link.url));
      const supports = labels.flatMap((label) => defined.get(label)?.grounds.map((g) => g.target) ?? []);
      // A link names an entity; it does not support the sentence that names it. A container named in a sentence and used as its only ground says nothing the link does not.
      if (supports.length > 0 && supports.every((target) => named.has(target) && /^madarch:code\.(service|module):/.test(target))) {
        refusals.push({ line: unit.line, rule: 'link-is-not-a-ground', message: `this sentence is grounded only on ${[...new Set(supports)].map((t) => t.slice('madarch:'.length)).join(', ')}, which it already names with a link; a link names an entity and a ground supports the sentence: ground it on the code or the document section that shows what it says` });
      }
      if (!groundedEnd(claim, sentence.terminated)) {
        const quoted = reader.plain(sentence.start, sentence.end);
        refusals.push({ line: unit.line, rule: 'ungrounded-statement', message: `this sentence states something and has no footnote at its end: ${JSON.stringify(quoted.length > 90 ? `${quoted.slice(0, 87)}...` : quoted)}. End it with a footnote reference that lists its grounds, or, if it only connects text, make it a heading or a line of links` });
      }
    }
  }
  for (const [label, entry] of defined) if (!used.includes(label)) refusals.push({ line: entry.line, rule: 'unused-footnote', message: `the footnote [^${label}] is never used in the text` });
  if (expected.mustLinkDomains) {
    for (const slug of expected.domains) if (!links.includes(`domain:${slug}`)) refusals.push({ line: split.bodyStart, rule: 'domain-not-linked', message: `the declared domain "${slug}" is not linked from the page: mention it as [name](madarch:domain:${slug})` });
  }
  if (units.length === 0) refusals.push({ line: split.bodyStart, rule: 'empty', message: 'the page states nothing: it has no sentence with grounds' });
  if (refusals.length > 0 || front.front === undefined) return { ok: false, refusals: refusals.sort((a, b) => a.line - b.line || byCodePoint(a.rule, b.rule)).map(located) };
  const page = canonical(reader, front.front, defined, links, allGrounds, expected.previous, expected.language, names);
  if (mentions.length === 0) return { ok: true, page };
  // The core writes the link where the agent wrote a known name (madarch-ztyq.8): the agent's own links and
  // footnote definitions are already structure, so only plain prose gains one. The page is checked first;
  // insertion cannot make an accepted page unacceptable.
  const inserted = insertMentionLinks(page.markdown, mentions, { pageId: expected.id, pageTitle: front.front.title, sources: front.front.sources, evidence: front.front.relates });
  return { ok: true, page: inserted.targets.length === 0 ? page : { ...page, markdown: inserted.markdown, links: [...page.links, ...inserted.targets] } };
}

/** The names the replaced page gave its sentences, by sentence. */
function previousNames(previous: string | undefined, language?: string): Map<string, string> {
  const names = new Map<string, string>();
  if (previous === undefined) return names;
  const split = splitFrontMatter(previous.replace(/\r\n/g, '\n'));
  if ('rule' in split) return names;
  // A numbered label is no name: a page still numbered is renamed when it is written again.
  for (const statement of statementsOf(split.body, split.bodyStart, language)) if (!isNumbered(statement.labels[0]!) && !names.has(sentenceKey(statement.text))) names.set(sentenceKey(statement.text), statement.labels[0]!);
  return names;
}

/**
 * The canonical form: front matter in the format's key order, the body with
 * its blank lines collapsed, and one footnote per statement, named for it
 * (`[^refund-window]`; see `names.ts`) and listed after the body in order of
 * first use. A sentence that ends in several footnotes gets one, listing all
 * their grounds; a name several sentences shared is made unique. The same
 * checked page, with the same replaced page, always gives the same bytes.
 */
function canonical(reader: PageReading, front: FrontMatter, defined: Map<string, { line: number; grounds: { label: string; target: string }[] }>, links: string[], grounds: string[], previous: string | undefined, language: string | undefined, names: ReadonlyMap<string, string> = new Map()): CheckedPage {
  const body = reader.body;
  const runs = reader.runs();
  const items = runs.map((run) => {
    const labels = [...new Set(run.labels)];
    const own = [...new Map(labels.flatMap((label) => defined.get(label)?.grounds ?? []).map((ground) => [ground.target, ground])).values()];
    return { run, own, sentence: run.sentence, labels, hint: own[0]?.label ?? '' };
  });
  const statementNames = nameStatements(items, previousNames(previous, language));
  const cuts = [
    ...reader.definitionSpans().map((span) => ({ start: span.start, end: span.end, run: -1 })),
    ...items.map((item, index) => ({ start: item.run.start, end: item.run.end, run: index })),
  ].sort((left, right) => left.start - right.start);
  let renamed = '';
  let cursor = 0;
  for (const cut of cuts) {
    renamed += body.slice(cursor, cut.start);
    if (cut.run >= 0) renamed += `[^${statementNames[cut.run]}]`;
    cursor = Math.max(cursor, cut.end);
  }
  renamed += body.slice(cursor);
  // Blank lines collapse and trailing blanks go, as the format always wrote them.
  const kept: string[] = [];
  let blank = false;
  for (const raw of renamed.split('\n')) {
    let line = raw;
    while (line.endsWith(' ') || line.endsWith('\t')) line = line.slice(0, -1);
    if (line === '') { if (kept.length > 0) blank = true; continue; }
    if (blank) kept.push('');
    blank = false;
    kept.push(line);
  }
  renamed = kept.join('\n');
  const notes = items.map((item, index) => `[^${statementNames[index]}]: ${item.own.map((ground) => `[${(names.get(ground.target) ?? ground.label).replaceAll('[', '').replaceAll(']', '')}](${ground.target})`).join(', ')}`);
  const yamlList = (name: string, list: readonly string[]): string => (list.length === 0 ? `${name}: []` : `${name}:\n${list.map((entry) => `  - ${JSON.stringify(entry)}`).join('\n')}`);
  const writtenAt = front.writtenAt.length === 0 ? [] : [`written-at:\n${front.writtenAt.map((entry) => [`  - repository: ${JSON.stringify(entry.repository)}`, `    commit: ${entry.commit}`, ...(entry.branch === undefined ? [] : [`    branch: ${JSON.stringify(entry.branch)}`]), ...(entry.origin === undefined ? [] : [`    origin: ${JSON.stringify(entry.origin)}`])].join('\n')).join('\n')}`];
  const header = [
    '---',
    `id: ${front.id}`,
    `kind: ${front.kind}`,
    `title: ${JSON.stringify(front.title)}`,
    yamlList('relates', front.relates),
    'producer: agent',
    yamlList('sources', front.sources),
    ...Object.entries(front.extra).sort(([left], [right]) => byCodePoint(left, right)).map(([key, value]) => `${key}: ${typeof value === 'number' ? String(value) : JSON.stringify(value)}`),
    ...writtenAt,
    '---',
  ].join('\n');
  return { frontMatter: front, markdown: `${header}\n\n${renamed}\n\n${notes.join('\n')}\n`, grounds, links };
}
