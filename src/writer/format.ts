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
import { maskInline, plainSentence, QUESTION_LINK, REFERENCE_RUN, sentencesOf, statementsOf, unmask, withoutQuestionLinks } from './sentences.js';

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
const LINK = /\[([^\]\n]*)\]\(((?:[^()\s]|\([^()\s]*\))*)\)/g;
const FOOTNOTE_DEFINITION = /^\[\^([A-Za-z0-9_-]+)\]:[ \t]*(.*)$/;
const FOOTNOTE_REFERENCE = /\[\^([A-Za-z0-9_-]+)\]/g;
/** The words that open a connecting "See also" line, in English and in Russian (`См. также`, `Смотрите также`). */
const SEE_ALSO = /^(?:see also|см\.?\s+также|смотрите также)(?![\p{L}\p{N}])/iu;
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
function plainWords(text: string): string[] {
  const stripped = text
    .replace(LINK, (_whole, label: string) => label)
    .replace(FOOTNOTE_REFERENCE, '')
    .replace(/[`*_]/g, '');
  return stripped.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];
}

interface TextUnit {
  readonly line: number;
  readonly text: string;
}

function textUnits(body: string, bodyStart: number, refusals: Refusal[]): { units: TextUnit[]; definitions: { label: string; line: number; text: string }[]; headings: TextUnit[] } {
  const units: TextUnit[] = [];
  const headings: TextUnit[] = [];
  const definitions: { label: string; line: number; text: string }[] = [];
  let paragraph: { line: number; parts: string[] } | undefined;
  const flush = (): void => {
    if (paragraph !== undefined) units.push({ line: paragraph.line, text: paragraph.parts.join(' ') });
    paragraph = undefined;
  };
  for (const [index, raw] of body.split('\n').entries()) {
    const line = bodyStart + index;
    if (/[\u0001-\u0004]/.test(raw)) refusals.push({ line, rule: 'characters', message: 'the page holds a control character (U+0001 to U+0004), which the format does not allow' });
    const trimmed = raw.trim();
    if (trimmed === '') { flush(); continue; }
    if (/^(```|~~~)/.test(trimmed)) {
      flush();
      refusals.push({ line, rule: 'fenced-code', message: 'a fenced block is not part of the format: madarch draws diagrams and shows code from the graph, so state each fact as a sentence with grounds' });
      continue;
    }
    if (trimmed.startsWith('|')) {
      flush();
      refusals.push({ line, rule: 'table', message: 'a table is not part of the format: state each fact as a sentence with its own footnote' });
      continue;
    }
    const definition = FOOTNOTE_DEFINITION.exec(trimmed);
    if (definition !== null) { flush(); definitions.push({ label: definition[1]!, line, text: definition[2]! }); continue; }
    if (/^<[A-Za-z!/]/.test(trimmed)) {
      flush();
      refusals.push({ line, rule: 'html', message: 'raw HTML is not part of the format' });
      continue;
    }
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

/** The most words a link-only line may carry in its labels before it is read as a statement. */
const LINK_ONLY_WORDS = 5;

/** A short factual label is still a claim, not navigation. Structural checks below also forbid prose beside links. */
function assertionLabel(text: string): boolean {
  return /(?<![\p{L}\p{N}])(?:is|are|was|were|has|have|stores?|keeps?|requires?|supports?|costs?|free|бесплат[\p{L}]*|хран[\p{L}]*|требу[\p{L}]*|поддержива[\p{L}]*|стоит|стоят|явля[\p{L}]*)(?![\p{L}\p{N}])/iu.test(text.replace(LINK, (_whole, label: string) => label));
}

/**
 * A unit that only connects: a one-sentence "See also" line, or nothing but
 * links and punctuation. The words in link labels count: a statement does not
 * hide in a label or behind "See also".
 */
function connecting(text: string): boolean {
  const plain = text.replace(FOOTNOTE_REFERENCE, '').trim();
  const labelWords = plainWords([...plain.matchAll(LINK)].map((m) => m[1]!).join(' ')).length;
  if (SEE_ALSO.test(plain)) {
    const rest = plain.replace(SEE_ALSO, '').replace(LINK, '').replace(/[\s,;:.–—-]+/g, ' ').trim();
    // Only navigation glue is exempt. Word counts alone used to accept short claims such as "delivery is free".
    const navigation = /^(?:(?:the|and|or|page|pages|section|sections|service|services|и|или|страница|страницы|страницу|раздел|разделы|сервис|сервисы)\s*)*$/iu.test(rest)
      || (labelWords === 0 && /^(?:the\s+)?(?:[\p{L}\p{N}'-]+\s+){1,3}(?:page|section)$/iu.test(rest));
    return sentencesOf(maskInline(plain)).length <= 1 && navigation && labelWords <= 2 * LINK_ONLY_WORDS && !assertionLabel(plain);
  }
  const rest = plain.replace(LINK, '').replace(/[\s,;:.\u2013\u2014-]+/g, '');
  return rest === '' && plain.includes('](') && labelWords <= LINK_ONLY_WORDS && !assertionLabel(plain);
}

/** Parses the grounds of a footnote definition: links separated by commas and nothing else. */
function groundsOf(text: string): { links: { label: string; target: string }[]; leftover: string } {
  const links: { label: string; target: string }[] = [];
  const leftover = text.replace(LINK, (_whole, label: string, target: string) => { links.push({ label, target }); return ''; }).replace(/[\s,]+/g, '');
  return { links, leftover };
}

const ROUTE_SPAN = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S*)$/;
const SYMBOL_SPAN = /^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)(?:\(\))?$/;

/**
 * A route or an operation named in a code span is an entity, and an entity is named with a link (madarch-m38l.13):
 * `POST /pay` becomes [POST /pay](madarch:code.route:...) when the graph has that one route, and `refund` becomes a link
 * when exactly one symbol bears the name. A span that names nothing, or something ambiguous, stays as the agent wrote it.
 * Headings, footnote lines and what already sits inside a link are left alone.
 */
async function linkCodeSpans(body: string, resolver: GroundResolver): Promise<string> {
  if (resolver.uniqueRoute === undefined && resolver.uniqueSymbol === undefined) return body;
  const out: string[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!line.includes('`') || FOOTNOTE_DEFINITION.test(trimmed) || /^#{1,6}\s/.test(trimmed) || /^(```|~~~)/.test(trimmed)) { out.push(line); continue; }
    let rebuilt = '';
    let cursor = 0;
    const segment = async (text: string): Promise<string> => {
      let result = '';
      let last = 0;
      for (const match of text.matchAll(/`([^`\n]+)`/g)) {
        const inner = match[1]!.trim();
        let key: string | undefined;
        const route = ROUTE_SPAN.exec(inner);
        if (route !== null) key = await resolver.uniqueRoute?.(route[1]!, route[2]!);
        else {
          const symbol = SYMBOL_SPAN.exec(inner);
          if (symbol !== null) key = await resolver.uniqueSymbol?.(symbol[1]!);
        }
        result += text.slice(last, match.index);
        result += key === undefined || /\s/.test(key) ? match[0] : `[${inner.replace(/\(\)$/, '')}](madarch:${key})`;
        last = match.index + match[0].length;
      }
      return result + text.slice(last);
    };
    for (const link of line.matchAll(LINK)) {
      rebuilt += await segment(line.slice(cursor, link.index)) + link[0];
      cursor = link.index + link[0].length;
    }
    rebuilt += await segment(line.slice(cursor));
    out.push(rebuilt);
  }
  return out.join('\n');
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
  const { units, definitions, headings } = textUnits(body, split.bodyStart, refusals);
  // Work on source lines, not joined paragraphs, so an id on a later line keeps its true location.
  for (const [index, line] of split.body.split('\n').entries()) {
    if (FOOTNOTE_DEFINITION.test(line.trim())) continue;
    const outsideLinks = line.replace(LINK, '');
    for (const match of outsideLinks.matchAll(/(?<![\p{L}\p{N}_])(?:madarch:)?(?:question|correction|domain|product|doc|engine|code\.[a-z][a-z0-9.-]*):[^\s`<>\[\]()]+/gu)) {
      refusals.push({ line: split.bodyStart + index, rule: 'raw-entity-id', message: `the raw entity id ${JSON.stringify(match[0])} is not reader-facing prose: use a human-readable Markdown link; place a question link at the end of its sentence as [→ question: …](madarch:question:<slug>) or [→ вопрос: …](madarch:question:<slug>)` });
    }
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
    const { links, leftover } = groundsOf(definition.text);
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
    for (const match of unit.text.matchAll(LINK)) {
      const target = match[2]!;
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
    const outsideLinks = heading.text.replace(LINK, '').replace(/[`*_\s:,.→–—-]/g, '');
    if ((outsideLinks === '' && [...heading.text.matchAll(LINK)].length > 0) || /^(?:see\s+(?:also\s+)?question|см\.?\s+(?:также\s+)?вопрос|смотрите\s+вопрос|→\s*(?:question|вопрос))(?![\p{L}\p{N}])/iu.test(heading.text)) {
      refusals.push({ line: heading.line, rule: 'reference-heading', message: 'a reference-only heading is not a topic: use a descriptive heading and put the human-readable question link at the end of the sentence it concerns ([→ question: …] / [→ вопрос: …])' });
    }
    if (FOOTNOTE_REFERENCE.test(heading.text)) refusals.push({ line: heading.line, rule: 'heading-footnote', message: 'a heading is connecting text and carries no footnote: put the statement in a sentence below it' });
    FOOTNOTE_REFERENCE.lastIndex = 0;
    const headingWords = plainWords(heading.text).length;
    if (headingWords > HEADING_WORDS) refusals.push({ line: heading.line, rule: 'heading-statement', message: `this heading has ${headingWords} words; a heading is at most ${HEADING_WORDS}, so a statement belongs in a sentence with grounds below it` });
  }
  const used: string[] = [];
  for (const unit of units) {
    await checkLinks(unit);
    for (const sentence of sentencesOf(maskInline(unit.text))) {
      const shown = unmask(sentence.text);
      const questionLinks = [...shown.matchAll(QUESTION_LINK)];
      if (questionLinks.length === 0) continue;
      const claim = withoutQuestionLinks(shown);
      const first = questionLinks[0]!;
      const suffix = shown.slice(first.index).replace(QUESTION_LINK, '').trim();
      if (!sentence.terminated || !/[.!?…][)"'”’»]*(?:\[\^[A-Za-z0-9_-]+\])*$/.test(claim) || suffix !== '') {
        refusals.push({ line: unit.line, rule: 'question-link-position', message: 'put the question link after the terminal punctuation and grounds of the sentence it concerns, not in a heading, a separate paragraph or the middle of a claim' });
      }
      for (const link of questionLinks) {
        const label = link[1]!.trim();
        const localized = /^→\s*(question|вопрос):\s*(.+)$/u.exec(label);
        if (localized === null || localized[2]!.trim() === '' || /^(?:madarch:)?question:/.test(localized[2]!.trim())) {
          refusals.push({ line: unit.line, rule: 'question-link-label', message: 'a question link needs a human-readable title: [→ question: Which decision?](madarch:question:<slug>) / [→ вопрос: Какое решение?](madarch:question:<slug>)' });
        } else if (expected.language !== undefined && localized[1] !== (expected.language === 'ru' ? 'вопрос' : 'question')) {
          refusals.push({ line: unit.line, rule: 'question-link-language', message: `the question label must follow the wiki language (${expected.language}): use ${expected.language === 'ru' ? '→ вопрос: …' : '→ question: …'}` });
        }
      }
    }
    for (const match of unit.text.matchAll(FOOTNOTE_REFERENCE)) {
      if (!defined.has(match[1]!)) refusals.push({ line: unit.line, rule: 'undefined-footnote', message: `[^${match[1]}] is used but never defined: add a line "[^${match[1]}]: [name](madarch:<key>)" at the end` });
      used.push(match[1]!);
    }
    if (connecting(unit.text)) continue;
    for (const sentence of sentencesOf(maskInline(unit.text))) {
      const claim = withoutQuestionLinks(sentence.text);
      const shown = unmask(claim);
      const hasLink = shown.includes('](madarch:');
      if (plainWords(shown).length < 2 && !hasLink) continue;
      const labels = [...shown.matchAll(FOOTNOTE_REFERENCE)].map((m) => m[1]!);
      const named = new Set([...shown.matchAll(LINK)].map((m) => m[2]!));
      const supports = labels.flatMap((label) => defined.get(label)?.grounds.map((g) => g.target) ?? []);
      // A link names an entity; it does not support the sentence that names it. A container named in a sentence and used as its only ground says nothing the link does not.
      if (supports.length > 0 && supports.every((target) => named.has(target) && /^madarch:code\.(service|module):/.test(target))) {
        refusals.push({ line: unit.line, rule: 'link-is-not-a-ground', message: `this sentence is grounded only on ${[...new Set(supports)].map((t) => t.slice('madarch:'.length)).join(', ')}, which it already names with a link; a link names an entity and a ground supports the sentence: ground it on the code or the document section that shows what it says` });
      }
      const grounded = sentence.terminated ? /[.!?\u2026][)"'\u201d\u2019\u00bb]*(?:\[\^[A-Za-z0-9_-]+\])+$/.test(claim) : /(?:\[\^[A-Za-z0-9_-]+\])+$/.test(claim);
      if (!grounded) {
        const quoted = shown.replace(LINK, (_w, label: string) => label);
        refusals.push({ line: unit.line, rule: 'ungrounded-statement', message: `this sentence states something and has no footnote at its end: ${JSON.stringify(quoted.length > 90 ? `${quoted.slice(0, 87)}...` : quoted)}. End it with a footnote reference that lists its grounds, or, if it only connects text, make it a heading or a "See also" line` });
      }
    }
  }
  for (const [label, entry] of defined) if (!used.includes(label)) refusals.push({ line: entry.line, rule: 'unused-footnote', message: `the footnote [^${label}] is never used in the text` });
  if (expected.mustLinkDomains) {
    for (const slug of expected.domains) if (!links.includes(`domain:${slug}`)) refusals.push({ line: split.bodyStart, rule: 'domain-not-linked', message: `the declared domain "${slug}" is not linked from the page: mention it as [name](madarch:domain:${slug})` });
  }
  if (units.length === 0) refusals.push({ line: split.bodyStart, rule: 'empty', message: 'the page states nothing: it has no sentence with grounds' });
  if (refusals.length > 0 || front.front === undefined) return { ok: false, refusals: refusals.sort((a, b) => a.line - b.line || byCodePoint(a.rule, b.rule)).map(located) };
  const page = canonical(front.front, body, defined, links, allGrounds, expected.previous, names);
  if (mentions.length === 0) return { ok: true, page };
  // The core writes the link where the agent wrote a known name (madarch-ztyq.8): the agent's own links and
  // footnote definitions are already structure, so only plain prose gains one. The page is checked first;
  // insertion cannot make an accepted page unacceptable.
  const inserted = insertMentionLinks(page.markdown, mentions);
  return { ok: true, page: inserted.targets.length === 0 ? page : { ...page, markdown: inserted.markdown, links: [...page.links, ...inserted.targets] } };
}

/** The names the replaced page gave its sentences, by sentence. */
function previousNames(previous: string | undefined): Map<string, string> {
  const names = new Map<string, string>();
  if (previous === undefined) return names;
  const lines = previous.replace(/\r\n/g, '\n').split('\n');
  const end = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  if (end < 0) return names;
  // A numbered label is no name: a page still numbered is renamed when it is written again.
  for (const statement of statementsOf(lines.slice(end + 1).join('\n'), end + 2)) if (!isNumbered(statement.labels[0]!) && !names.has(sentenceKey(statement.text))) names.set(sentenceKey(statement.text), statement.labels[0]!);
  return names;
}

/** The sentence a run of footnote references ends: the text since the previous run, a blank line or a new list item, cut at its last sentence start. */
function sentenceBefore(text: string, from: number, to: number): string {
  let start = from;
  const blank = text.lastIndexOf('\n\n', to);
  if (blank >= start) start = blank + 2;
  const item = /\n(?=\s*(?:[-*+]|\d+[.)])\s|#{1,6}\s|>)/g;
  const slice = text.slice(start, to);
  let last = 0;
  for (const match of slice.matchAll(item)) last = match.index + 1;
  start += last;
  const chunk = text.slice(start, to).replace(/^\s*(?:[-*+]|\d+[.)]|>)\s*/, '');
  const sentences = sentencesOf(maskInline(chunk));
  return plainSentence(sentences.length === 0 ? chunk : sentences[sentences.length - 1]!.text);
}

/**
 * The canonical form: front matter in the format's key order, the body with
 * its blank lines collapsed, and one footnote per statement, named for it
 * (`[^refund-window]`; see `names.ts`) and listed after the body in order of
 * first use. A sentence that ends in several footnotes gets one, listing all
 * their grounds; a name several sentences shared is made unique. The same
 * checked page, with the same replaced page, always gives the same bytes.
 */
function canonical(front: FrontMatter, body: string, defined: Map<string, { line: number; grounds: { label: string; target: string }[] }>, links: string[], grounds: string[], previous: string | undefined, names: ReadonlyMap<string, string> = new Map()): CheckedPage {
  const lines: string[] = [];
  for (const raw of body.split('\n')) {
    if (FOOTNOTE_DEFINITION.test(raw.trim())) continue;
    lines.push(raw.replace(/[ \t]+$/, ''));
  }
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const runs = [...text.matchAll(REFERENCE_RUN)].map((match) => ({ at: match.index, length: match[0].length, labels: [...new Set([...match[0].matchAll(FOOTNOTE_REFERENCE)].map((m) => m[1]!))] }));
  const items = runs.map((run, index) => {
    const own = [...new Map(run.labels.flatMap((label) => defined.get(label)?.grounds ?? []).map((ground) => [ground.target, ground])).values()];
    return { run, own, sentence: sentenceBefore(text, index === 0 ? 0 : runs[index - 1]!.at + runs[index - 1]!.length, run.at), labels: run.labels, hint: own[0]?.label ?? '' };
  });
  const statementNames = nameStatements(items, previousNames(previous));
  let renamed = '';
  let cursor = 0;
  items.forEach((item, index) => {
    renamed += `${text.slice(cursor, item.run.at)}[^${statementNames[index]}]`;
    cursor = item.run.at + item.run.length;
  });
  renamed += text.slice(cursor);
  const notes = items.map((item, index) => `[^${statementNames[index]}]: ${item.own.map((ground) => `[${(names.get(ground.target) ?? ground.label).replace(/[\[\]]/g, '')}](${ground.target})`).join(', ')}`);
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
