
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

/** Whether a character belongs to a word for the purpose of a mention's edge (`_` counts, `-` does not). */
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
 * Insert a link at every plain-text mention of a known name: outside front matter, headings, fenced
 * blocks, inline code, footnote definitions and existing links. The first matching name in a position
 * is the longest one; an exact spelling wins over a name only equal without case.
 */
export function insertMentionLinks(markdown: string, names: readonly MentionName[]): MentionInsertion {
  const usable = names.filter((entry) => entry.name.trim() !== '' && !entry.name.includes('\n') && !entry.name.includes('[') && !entry.name.includes(']') && !entry.name.includes('(') && !entry.name.includes(')'));
  if (usable.length === 0) return { markdown, targets: [] };
  const candidates = new Map<string, MentionName[]>();
  for (const name of usable) {
    const first = name.name[0]!.toLowerCase();
    const held = candidates.get(first);
    if (held === undefined) candidates.set(first, [name]);
    else held.push(name);
  }
  for (const list of candidates.values()) list.sort((left, right) => right.name.length - left.name.length || byCodePoint(left.target, right.target));
  const forbidden = forbiddenLines(markdown);
  const targets: string[] = [];
  let result = '';
  let cursor = 0;
  for (const [start, end] of forbidden) {
    result += transformSpan(markdown, cursor, start, candidates, targets);
    result += markdown.slice(start, end);
    cursor = end;
  }
  result += transformSpan(markdown, cursor, markdown.length, candidates, targets);
  return { markdown: result, targets };
}

/** The spans a mention never enters: front matter, headings, fenced blocks and footnote definitions, line by line. */
function forbiddenLines(markdown: string): [number, number][] {
  const spans: [number, number][] = [];
  let offset = 0;
  let front = markdown.startsWith('---');
  let fence: string | undefined;
  let frontDone = !front;
  let first = true;
  for (const line of markdown.split('\n')) {
    const start = offset;
    const end = offset + line.length;
    const trimmed = line.trim();
    if (front) {
      spans.push([start, end]);
      if (trimmed === '---' && !first) { front = false; frontDone = true; }
      first = false;
      offset = end + 1;
      continue;
    }
    if (fence !== undefined) {
      spans.push([start, end]);
      if (trimmed.startsWith(fence)) fence = undefined;
      offset = end + 1;
      continue;
    }
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      spans.push([start, end]);
      fence = trimmed.slice(0, 3);
      offset = end + 1;
      continue;
    }
    if (headingLine(line)) { spans.push([start, end]); offset = end + 1; continue; }
    if (footnoteDefinition(trimmed)) { spans.push([start, end]); offset = end + 1; continue; }
    offset = end + 1;
  }
  if (!frontDone) spans.push([0, markdown.length]);
  return mergeSpans(spans);
}

function headingLine(line: string): boolean {
  let spaces = 0;
  while (spaces < line.length && spaces < 4 && line[spaces] === ' ') spaces += 1;
  if (spaces > 3) return false;
  let hashes = 0;
  while (spaces + hashes < line.length && line[spaces + hashes] === '#') hashes += 1;
  if (hashes < 1 || hashes > 6) return false;
  const after = line[spaces + hashes];
  return after === undefined || after === ' ' || after === '\t';
}

function footnoteDefinition(line: string): boolean {
  return line.startsWith('[^') && line.includes(']:');
}

function mergeSpans(spans: [number, number][]): [number, number][] {
  const sorted = [...spans].sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged: [number, number][] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return merged;
}

function transformSpan(
  text: string,
  start: number,
  end: number,
  candidates: ReadonlyMap<string, readonly MentionName[]>,
  targets: string[],
): string {
  let result = '';
  let last = start;
  let index = start;
  while (index < end) {
    const character = text[index]!;
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
    if ((character === 'h' || character === 'H') && startsAddress(text, index, end)) {
      index = addressEnd(text, index, end);
      continue;
    }
    const list = candidates.get(character.toLowerCase());
    if (list === undefined) { index += 1; continue; }
    let best: { name: string; target: string; length: number; exact: boolean } | undefined;
    for (const candidate of list) {
      const length = candidate.name.length;
      if (index + length > end) continue;
      if (best !== undefined && length < best.length) break;
      const slice = text.slice(index, index + length);
      const exact = slice === candidate.name;
      if (!exact && (candidate.caseSensitive === true || slice.toLowerCase() !== candidate.name.toLowerCase())) continue;
      if (!isWord(slice[0]) || !isWord(slice[slice.length - 1])) continue;
      if (isWord(text[index - 1]) || isWord(text[index + length])) continue;
      if (best === undefined || length > best.length || (length === best.length && exact && !best.exact) || (length === best.length && exact === best.exact && byCodePoint(candidate.target, best.target) < 0)) {
        best = { name: slice, target: candidate.target, length, exact };
      }
    }
    if (best === undefined) { index += 1; continue; }
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
  return rest.startsWith('http://') || rest.startsWith('https://');
}

function addressEnd(text: string, index: number, end: number): number {
  while (index < end && text[index] !== ' ' && text[index] !== '\n' && text[index] !== '\t' && text[index] !== '<' && text[index] !== '>') index += 1;
  return index;
}

/** The `madarch:` targets of a Markdown text's links, read structurally (not by a pattern over the prose). */
export function madarchTargets(markdown: string): string[] {
  const targets: string[] = [];
  let index = 0;
  while (index < markdown.length) {
    const character = markdown[index]!;
    if (character === '`') {
      const run = backtickRun(markdown, index, markdown.length);
      const close = closingRun(markdown, index + run, markdown.length, run);
      index = close ?? index + run;
      continue;
    }
    if (character === '[' || (character === '!' && markdown[index + 1] === '[')) {
      const from = character === '!' ? index + 1 : index;
      const close = closingBracket(markdown, from, markdown.length);
      if (close !== undefined && markdown[close + 1] === '(') {
        const destination = closingParen(markdown, close + 1, markdown.length);
        if (destination !== undefined) {
          const inside = markdown.slice(close + 2, destination);
          let from = 0;
          while (from < inside.length && (inside[from] === ' ' || inside[from] === '\t' || inside[from] === '\n' || inside[from] === '\r')) from += 1;
          let to = from;
          while (to < inside.length && inside[to] !== ' ' && inside[to] !== '\t' && inside[to] !== '\n' && inside[to] !== '\r') to += 1;
          const url = inside.slice(from, to);
          if (url.startsWith('madarch:')) targets.push(url.slice('madarch:'.length));
          index = destination + 1;
          continue;
        }
      }
      index += 1;
      continue;
    }
    index += 1;
  }
  return targets;
}
