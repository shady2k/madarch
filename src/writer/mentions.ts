
/**
 * The names a page's prose may mention (madarch-ztyq.8, decision 0032 section 8): a reader who meets a
 * known entity in an agent's sentence should be able to open its page, and a page should list the pages
 * that mention it. The core inserts the link where the agent wrote plain text; the agent does not have
 * to know a key, and a page written before this change gains the links when it is checked again.
 *
 * The names come from data the product already holds: the titles and identifiers of its document
 * entities, the synonyms and code names of its glossary terms, and the labels of the graph's nodes.
 * Nothing here names a product kind or a product entity.
 */
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type { DocEntity } from '../knowledge/doc-entities.js';
import { parseTermText } from '../knowledge/glossary.js';
import { byCodePoint } from '../model/order.js';

/** One name a page may link: the text a reader writes and the target its page has. */
export interface MentionName {
  readonly name: string;
  /** A graph key (`code.service:orders`) or a document address (`doc:docs/glossary.md#outbox`). */
  readonly target: string;
  /**
   * Match only this exact spelling. A document title and an identifier are names as written; a graph
   * label is matched without case, except for a symbol, whose bare name is too common in prose.
   */
  readonly caseSensitive?: boolean;
}

/** What inserting links did: the text, and the targets of the links it added, in order. */
export interface MentionInsertion {
  readonly markdown: string;
  readonly targets: readonly string[];
}

/** The address of a document entity's page: the repository, the path and the anchor a reader follows. */
export function documentMentionTarget(entity: DocEntity): string {
  return `doc:${entity.repo === null ? '' : `@${entity.repo}/`}${entity.path}#${entity.anchor}`;
}

/**
 * The names the product's own documents give their entities: an identifier (`UC-1`, `BR-3`), the title
 * a reader sees, and, for a glossary term, the synonyms and code names the term declares.
 */
export function documentMentionNames(entities: Iterable<DocEntity>): MentionName[] {
  const names: MentionName[] = [];
  for (const entity of entities) {
    const target = documentMentionTarget(entity);
    const add = (name: string): void => {
      const text = name.trim();
      if (text.length < 2 || text.length > 80 || text.includes('\n')) return;
      if (!names.some((held) => held.name === text && held.target === target)) names.push({ name: text, target, caseSensitive: true });
    };
    if (entity.identifier !== null) add(entity.identifier);
    add(entity.title);
    if (entity.semantics === 'term') {
      const fields = parseTermText(entity.text);
      for (const synonym of fields.synonyms) add(synonym);
      for (const codeName of fields.code) add(codeName);
    }
  }
  return names.sort((left, right) => byCodePoint(left.name, right.name) || byCodePoint(left.target, right.target));
}

/** Whether a character belongs to a word for a mention's edge (`_` counts; `isMentionEdge` adds `-`). */
function isWord(character: string | undefined): boolean {
  if (character === undefined) return false;
  if (character === '_') return true;
  if (character >= '0' && character <= '9') return true;
  return character.toLowerCase() !== character.toUpperCase();
}

function isLetterOrDigit(character: string): boolean {
  return (character >= '0' && character <= '9') || character.toLowerCase() !== character.toUpperCase();
}

function isHex(text: string): boolean {
  if (text.length < 7) return false;
  for (const character of text) {
    const lower = character.toLowerCase();
    if (!((lower >= '0' && lower <= '9') || (lower >= 'a' && lower <= 'f'))) return false;
  }
  return true;
}

/**
 * Whether a graph node's label is a name a reader can meet in prose. Paths, hashes, route lines and
 * labels with layout characters are left out; a bare lower-case symbol (`encode`, `header`) is too
 * common to be a link, while a qualified one (`PaymentService.pay`) is not.
 */
export function graphMentionName(key: string, label: string): MentionName | undefined {
  const name = label.trim();
  if (name.length < 4 || name.length > 120) return undefined;
  if (key.startsWith('code.file:') || key.startsWith('code.directory:') || key.startsWith('code.document-section:')) return undefined;
  if (name.includes('/') || name.includes('\\') || name.includes('·') || name.includes('|') || name.includes('@') || name.includes(':')) return undefined;
  if (![...name].some(isLetterOrDigit)) return undefined;
  if (isHex(name)) return undefined;
  if (key.startsWith('code.symbol:')) {
    const qualified = name.toLowerCase() !== name
      || name.includes('.') || name.includes('_') || name.includes('#') || name.includes('-')
      || name.includes('(') || name.includes(' ') || name.includes('::');
    if (!qualified) return undefined;
  }
  return { name, target: key, ...(key.startsWith('code.symbol:') ? { caseSensitive: true } : {}) };
}

/**
 * The page context a mention is read in (madarch-ztyq.8, review 202): when several entities share
 * a name, the page itself says which one it means. The page id, its sources and the targets it
 * already links or relates to are evidence; without evidence the name stays plain.
 */
export interface MentionContext {
  readonly pageId?: string;
  readonly pageTitle?: string;
  readonly sources?: readonly string[];
  readonly evidence?: readonly string[];
}

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  identifier?: string;
  children?: MdNode[];
  position?: { start: { offset?: number; line?: number }; end: { offset?: number; line?: number } };
}

const parser = unified().use(remarkParse).use(remarkGfm);

function parseMarkdown(markdown: string): MdNode | undefined {
  try {
    return parser.parse(markdown) as unknown as MdNode;
  } catch {
    // A reader never sees a page the parser cannot read; the caller's check has already refused it.
    return undefined;
  }
}

/** The offset just after a leading YAML front matter, or 0 when the text has none. */
function frontMatterEnd(markdown: string): number {
  if (!markdown.startsWith('---')) return 0;
  let offset = 0;
  let first = true;
  for (const line of markdown.split('\n')) {
    offset += line.length + 1;
    if (first) { first = false; continue; }
    if (line.trim() === '---') return Math.min(offset, markdown.length);
  }
  return markdown.length;
}

/**
 * Every footnote identifier a rendered reference reaches: references in the body, then the references
 * inside those definitions only. A definition nobody references, and anything nested in it, is not
 * rendered.
 */
function usedFootnotes(root: MdNode): Set<string> {
  const referenced = new Set<string>();
  const definitions = new Map<string, MdNode>();
  const collect = (node: MdNode): void => {
    if (node.type === 'footnoteDefinition' && typeof node.identifier === 'string') definitions.set(node.identifier, node);
    for (const child of node.children ?? []) collect(child);
  };
  collect(root);
  const scan = (node: MdNode): void => {
    if (node.type === 'footnoteDefinition') return;
    if (node.type === 'footnoteReference' && typeof node.identifier === 'string') referenced.add(node.identifier);
    for (const child of node.children ?? []) scan(child);
  };
  scan(root);
  const expanded = new Set<string>();
  for (;;) {
    const found = [...referenced].find((identifier) => definitions.has(identifier) && !expanded.has(identifier));
    if (found === undefined) return referenced;
    expanded.add(found);
    for (const child of definitions.get(found)!.children ?? []) scan(child);
  }
}

/** The targets of every rendered `madarch:` link, in source order: inline and reference links, and rendered notes. */
export function madarchTargets(markdown: string): string[] {
  const root = parseMarkdown(markdown);
  if (root === undefined) return [];
  const definitions = new Map<string, string>();
  const collectDefinitions = (node: MdNode): void => {
    if (node.type === 'definition' && typeof node.identifier === 'string' && typeof node.url === 'string') definitions.set(node.identifier, node.url);
    for (const child of node.children ?? []) collectDefinitions(child);
  };
  collectDefinitions(root);
  const used = usedFootnotes(root);
  const targets: string[] = [];
  const add = (url: string | undefined): void => {
    if (url !== undefined && url.startsWith('madarch:')) targets.push(url.slice('madarch:'.length));
  };
  const walk = (node: MdNode): void => {
    if (node.type === 'footnoteDefinition') {
      if (node.identifier === undefined || !used.has(node.identifier)) return;
    }
    if (node.type === 'link') add(node.url);
    if (node.type === 'linkReference' && typeof node.identifier === 'string') add(definitions.get(node.identifier));
    // The destination of an image is not a page mention, and neither is a definition's URL by itself.
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return targets;
}

/**
 * Insert a link at every plain-text mention of a known name. The Markdown parser decides what is
 * prose: a text node under a setext or ATX heading, a code block, an inline code span, a link (and
 * its reference definition), an image, an HTML comment, front matter or a footnote definition is
 * not a candidate. An address of any scheme the parser knows, and a bare address it leaves as
 * text, is skipped whole. The first matching name in a position is the longest one; an exact
 * spelling wins over a name equal only without case; a name with competing entities is resolved
 * from the page's evidence and otherwise left unlinked.
 */
export function insertMentionLinks(markdown: string, names: readonly MentionName[], context: MentionContext = {}): MentionInsertion {
  const usable = names.filter((entry) => entry.name.trim() !== '' && !entry.name.includes('\n') && !entry.name.includes('[') && !entry.name.includes(']') && !entry.name.includes('(') && !entry.name.includes(')'));
  if (usable.length === 0) return { markdown, targets: [] };
  const resolved = resolveMentions(markdown, usable, context);
  if (resolved.length === 0) return { markdown, targets: [] };
  const candidates = new Map<string, MentionName[]>();
  for (const name of resolved) {
    const first = name.name[0]!.toLowerCase();
    const held = candidates.get(first);
    if (held === undefined) candidates.set(first, [name]);
    else if (!held.some((entry) => entry.target === name.target && entry.name === name.name)) held.push(name);
  }
  for (const list of candidates.values()) list.sort((left, right) => right.name.length - left.name.length || byCodePoint(left.target, right.target));
  const root = parseMarkdown(markdown);
  if (root === undefined) return { markdown, targets: [] };
  const front = frontMatterEnd(markdown);
  const nodes: MdNode[] = [];
  const walk = (node: MdNode): void => {
    if (node.type === 'footnoteDefinition') return;
    if (INSERTION_SKIP.has(node.type)) return;
    if (node.type === 'text') {
      const start = node.position?.start.offset;
      if (start !== undefined && start >= front) nodes.push(node);
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  nodes.sort((left, right) => (left.position?.start.offset ?? 0) - (right.position?.start.offset ?? 0));
  const targets: string[] = [];
  let result = '';
  let cursor = 0;
  for (const node of nodes) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined || start < cursor) continue;
    result += markdown.slice(cursor, start);
    result += transformSpan(markdown, start, end, candidates, targets, context.pageTitle);
    cursor = end;
  }
  result += markdown.slice(cursor);
  return { markdown: result, targets };
}

/** The node types whose whole contents are structure, not prose. */
const INSERTION_SKIP = new Set(['heading', 'code', 'inlineCode', 'link', 'linkReference', 'image', 'imageReference', 'definition', 'html', 'yaml', 'thematicBreak']);

/** The unique targets of a name, and the page evidence that tells several apart. */
function resolveMentions(markdown: string, names: readonly MentionName[], context: MentionContext): MentionName[] {
  const evidence = new Set<string>([...(context.evidence ?? []), ...madarchTargets(markdown)]);
  if (context.pageId !== undefined) evidence.add(context.pageId);
  const sources = context.sources ?? [];
  const groups = new Map<string, MentionName[]>();
  for (const name of names) {
    const held = groups.get(name.name);
    if (held === undefined) groups.set(name.name, [name]);
    else if (!held.some((entry) => entry.target === name.target)) held.push(name);
  }
  const resolved: MentionName[] = [];
  for (const group of groups.values()) {
    const unique = group.length === 1 ? group : group.filter((entry, index) => group.findIndex((other) => other.target === entry.target) === index);
    if (unique.length === 1) { resolved.push(unique[0]!); continue; }
    const matching = unique.filter((entry) => evidence.has(entry.target) || sourceMatches(entry.target, sources));
    if (matching.length === 1) resolved.push(matching[0]!);
  }
  return resolved;
}

/** A document target's path without its repository prefix. */
function documentPath(target: string): string | undefined {
  if (!target.startsWith('doc:')) return undefined;
  const address = target.slice('doc:'.length);
  const hash = address.indexOf('#');
  const path = hash < 0 ? address : address.slice(0, hash);
  return path.replace(/^@[^/]+\//, '');
}

function sourceMatches(target: string, sources: readonly string[]): boolean {
  const path = documentPath(target);
  if (path === undefined) return false;
  return sources.some((source) => {
    const normalized = source.replace(/^@[^/]+\//, '');
    return normalized === path || normalized.endsWith(`/${path}`) || path.endsWith(`/${normalized}`);
  });
}

/** Whether a character continues an identifier at a mention's edge (`-` is part of `UC-1`). */
function isMentionEdge(character: string | undefined): boolean {
  return isWord(character) || character === '-';
}

function transformSpan(
  text: string,
  start: number,
  end: number,
  candidates: ReadonlyMap<string, readonly MentionName[]>,
  targets: string[],
  pageTitle: string | undefined,
): string {
  let result = '';
  let last = start;
  let index = start;
  while (index < end) {
    const character = text[index]!;
    if (character === '\\') { index += 2; continue; }
    if (character === '`') {
      const run = backtickRun(text, index, end);
      const close = closingRun(text, index + run, end, run);
      if (close !== undefined) { index = close; continue; }
      index += run;
      continue;
    }
    // A footnote reference is structure too: its label is a slug, and a name inside it is not prose.
    if (character === '[' && text[index + 1] === '^') {
      const close = text.indexOf(']', index + 2);
      if (close >= 0 && close < end) { index = close + 1; continue; }
      index += 1;
      continue;
    }
    if (character === '[' || (character === '!' && text[index + 1] === '[')) {
      const from = character === '!' ? index + 1 : index;
      const close = closingBracket(text, from, end);
      if (close !== undefined) {
        const after = close + 1;
        if (text[after] === '(') {
          const destination = closingParen(text, after, end);
          if (destination !== undefined) { index = destination; continue; }
        }
        if (text[after] === '[') {
          const reference = closingBracket(text, after, end);
          if (reference !== undefined) { index = reference + 1; continue; }
        }
      }
      index += 1;
      continue;
    }
    if (character === '<') {
      const close = text.indexOf('>', index + 1);
      if (close >= 0 && close < end) { index = close + 1; continue; }
      index += 1;
      continue;
    }
    if (startsAddress(text, index, end) || startsEmail(text, index, end)) {
      index = addressEnd(text, index, end);
      continue;
    }
    const list = candidates.get(character.toLowerCase());
    if (list === undefined) { index += 1; continue; }
    const matched: { name: string; target: string; length: number; exact: boolean }[] = [];
    for (const candidate of list) {
      const length = candidate.name.length;
      if (index + length > end) continue;
      const slice = text.slice(index, index + length);
      // A page does not link its own title: it is the subject, not a mention of something else.
      if (slice === pageTitle) continue;
      const exact = slice === candidate.name;
      if (!exact && (candidate.caseSensitive === true || slice.toLowerCase() !== candidate.name.toLowerCase())) continue;
      if (!isWord(slice[0]) || !isWord(slice[slice.length - 1])) continue;
      if (isMentionEdge(text[index - 1]) || isMentionEdge(text[index + length])) continue;
      matched.push({ name: slice, target: candidate.target, length, exact });
    }
    if (matched.length === 0) { index += 1; continue; }
    const longest = Math.max(...matched.map((entry) => entry.length));
    const atLongest = matched.filter((entry) => entry.length === longest);
    const exact = atLongest.filter((entry) => entry.exact);
    const pool = exact.length > 0 ? exact : atLongest;
    const distinct = new Map(pool.map((entry) => [entry.target, entry]));
    if (distinct.size !== 1) { index += 1; continue; }
    const best = [...distinct.values()][0]!;
    result += text.slice(last, index) + `[${best.name}](madarch:${best.target})`;
    targets.push(best.target);
    index += best.length;
    last = index;
  }
  return result + text.slice(last, end);
}

function backtickRun(text: string, start: number, end: number): number {
  let length = 0;
  while (start + length < end && text[start + length] === '`') length += 1;
  return Math.max(1, length);
}

function closingRun(text: string, from: number, end: number, run: number): number | undefined {
  let index = from;
  while (index < end) {
    if (text[index] !== '`') { index += 1; continue; }
    let length = 0;
    while (index + length < end && text[index + length] === '`') length += 1;
    if (length === run) return index + length;
    index += length;
  }
  return undefined;
}

function closingBracket(text: string, from: number, end: number): number | undefined {
  let depth = 0;
  for (let index = from; index < end; index += 1) {
    if (text[index] === '\\') { index += 1; continue; }
    if (text[index] === '[') depth += 1;
    else if (text[index] === ']') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function closingParen(text: string, from: number, end: number): number | undefined {
  let depth = 0;
  for (let index = from; index < end; index += 1) {
    if (text[index] === '\\') { index += 1; continue; }
    if (text[index] === '(') depth += 1;
    else if (text[index] === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function startsAddress(text: string, index: number, end: number): boolean {
  const rest = text.slice(index, Math.min(end, index + 8)).toLowerCase();
  return rest.startsWith('http://') || rest.startsWith('https://') || rest.startsWith('ftp://') || rest.startsWith('mailto:') || rest.startsWith('www.');
}

function isLocalAddressCharacter(character: string | undefined): boolean {
  if (character === undefined) return false;
  if (character === '.' || character === '_' || character === '%' || character === '+' || character === '-') return true;
  return isLetterOrDigit(character);
}

function startsEmail(text: string, index: number, end: number): boolean {
  let at = index;
  while (at < end && isLocalAddressCharacter(text[at])) at += 1;
  if (at === index || at >= end || text[at] !== '@') return false;
  let domain = at + 1;
  let dots = 0;
  while (domain < end && (isLetterOrDigit(text[domain]!) || text[domain] === '-' || text[domain] === '.')) {
    if (text[domain] === '.') dots += 1;
    domain += 1;
  }
  if (dots === 0) return false;
  const last = text.slice(at + 1, domain).split('.').pop() ?? '';
  return last.length >= 2 && [...last].every(isLetterOrDigit);
}

function addressEnd(text: string, index: number, end: number): number {
  while (index < end && text[index] !== ' ' && text[index] !== '\n' && text[index] !== '\t' && text[index] !== '<' && text[index] !== '>') index += 1;
  return index;
}

/** One line of a document that names an identifier in rendered prose. */
export interface IdentifierMention {
  readonly line: number;
  readonly text: string;
}

/**
 * The lines of a document whose rendered prose names the identifier (madarch-ztyq.8, review 202):
 * the parser's text nodes, without code, inline code, HTML, definitions or unused notes. A
 * complete identifier boundary keeps `UC-1` out of `UC-1-extra`.
 */
export function identifierMentions(markdown: string, identifier: string): IdentifierMention[] {
  if (identifier === '') return [];
  const text = markdown.replaceAll('\r\n', '\n');
  const root = parseMarkdown(text);
  if (root === undefined) return [];
  const front = frontMatterEnd(text);
  const used = usedFootnotes(root);
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) if (text[index] === '\n') lineStarts.push(index + 1);
  const lineAt = (offset: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (lineStarts[middle]! <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
  const lines = new Map<number, string>();
  const walk = (node: MdNode): void => {
    if (node.type === 'footnoteDefinition' && (node.identifier === undefined || !used.has(node.identifier))) return;
    if (DOCUMENT_SKIP.has(node.type)) return;
    if (node.type === 'text') {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined || start < front) return;
      const source = text.slice(start, end);
      let offset = 0;
      for (const segment of source.split('\n')) {
        if (containsName(segment, identifier, false)) {
          const line = lineAt(start + offset);
          const full = text.split('\n')[line - 1] ?? segment;
          lines.set(line, full);
        }
        offset += segment.length + 1;
      }
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return [...lines.entries()].sort((left, right) => left[0] - right[0]).map(([line, value]) => ({ line, text: value }));
}

/** The node types that never hold rendered prose a document mention can name. */
const DOCUMENT_SKIP = new Set(['code', 'inlineCode', 'html', 'yaml', 'definition', 'image', 'imageReference']);

/** Whether a text segment names the identifier as a whole word, case-sensitively or not. */
function containsName(segment: string, identifier: string, caseSensitive: boolean): boolean {
  const source = caseSensitive ? segment : segment.toLowerCase();
  const name = caseSensitive ? identifier : identifier.toLowerCase();
  let at = source.indexOf(name);
  while (at >= 0) {
    const before = source[at - 1];
    const after = source[at + name.length];
    if (!isMentionEdge(before) && !isMentionEdge(after)) return true;
    at = source.indexOf(name, at + 1);
  }
  return false;
}
