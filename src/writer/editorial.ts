
/**
 * The editorial pass (madarch-ztyq.9; decision 0032, section 6): after a batch of pages is
 * written, read them as a newcomer would and ask for bounded revisions.
 *
 * The order is deterministic first. Everything the pass finds without a model comes from the
 * pages' own structure and the graph:
 *
 * - two pages state the same fact (their statements stand on the same ground) with the same
 *   words and different numbers;
 * - a glossary passage's own synonym stands in the prose where the term's title does not;
 * - a graph key, a file path or a code name the graph holds stands in a reader's sentence.
 *
 * Only then is the editing role asked, through a judge seam: it sees bounded excerpts of the
 * pages, the deterministic findings and the per-page bound, and it answers with page/passage
 * pairs it was shown. The pass returns findings and requests; it writes no page. The writer
 * decides how a request becomes a bounded rework of the named passage.
 *
 * Findings and accepted requests are journal entries, so a revision is never a hidden edit.
 */
import { byCodePoint } from '../model/order.js';
import { splitFrontMatter } from '../knowledge/markdown.js';
import { parseTermText } from '../knowledge/glossary.js';
import { statementsOf, type PageStatement } from './sentences.js';
import type { DocEntity } from '../knowledge/doc-entities.js';
import type { Journal } from './journal.js';

/** The most revision requests one pass returns; a page's own bound is the smaller of this and `maxPerPage`. */
export const MAX_EDITORIAL_REQUESTS = 12;

/** The setting's default: the most revision requests one page may receive in a pass (madarch-ztyq.9). */
export const DEFAULT_EDITORIAL_REQUESTS_PER_PAGE = 2;

export type EditorialFindingKind = 'conflicting-fact' | 'glossary-alias' | 'internal-identifier';

/** One thing the deterministic checks found. `page` and `passage` name where a revision is asked for. */
export interface EditorialFinding {
  readonly kind: EditorialFindingKind;
  readonly page: string;
  readonly passage: string;
  readonly line: number;
  readonly message: string;
  /** For a conflicting fact: the value this page gives, and the page and value that give another. */
  readonly value?: string;
  readonly otherPage?: string;
  readonly otherPassage?: string;
  readonly otherValue?: string;
  /** For a glossary alias: the term's title and the synonym the prose used. */
  readonly term?: string;
  readonly used?: string;
  /** For an internal identifier: the key, path or code name found in the prose. */
  readonly identifier?: string;
}

/** A bounded request to the writer: change one named passage, on one page, for a stated reason. */
export interface RevisionRequest {
  readonly page: string;
  readonly passage: string;
  readonly change: string;
  readonly why: string;
  readonly source: 'deterministic' | 'editing';
}

/** One page as the judge sees it: only the statements whose ids it may name. */
export interface EditorialJudgePage {
  readonly path: string;
  readonly title: string;
  readonly statements: readonly { readonly id: string; readonly line: number; readonly text: string }[];
}

/** What the editing model is handed. `pages` is bounded here, never by the model. */
export interface EditorialJudgePack {
  readonly pages: readonly EditorialJudgePage[];
  readonly findings: readonly EditorialFinding[];
  readonly maxPerPage: number;
}

export interface EditorialJudgeRequest {
  readonly page: string;
  readonly passage: string;
  readonly change: string;
  readonly why: string;
}

export interface EditorialJudgeAnswer {
  readonly requests: readonly EditorialJudgeRequest[];
}

/** The judge seam: a role's resolved pair becomes one of these (the ACP one is in `editorial-acp-judge.ts`). */
export interface EditorialJudge {
  judge(pack: EditorialJudgePack): Promise<EditorialJudgeAnswer>;
  warnings?(): readonly string[];
  close?(): Promise<void>;
}

/** The graph reader the deterministic identifier check uses; `GraphView` satisfies it. */
export interface EditorialGraph {
  find(options: { readonly kind?: string; readonly text?: string; readonly after?: string; readonly limit: number }): Promise<{
    readonly nodes: readonly { readonly kind: string; readonly key: string; readonly label: string; readonly properties: Readonly<Record<string, unknown>> }[];
    readonly next: string | null;
  }>;
}

export interface EditorialPage {
  readonly path: string;
  readonly title: string;
  readonly text: string;
}

export interface EditorialPassOptions {
  readonly pages: readonly EditorialPage[];
  readonly documentEntities: readonly DocEntity[];
  /** The graph the reader prose is checked against; absent means there is no identifier check. */
  readonly graph?: EditorialGraph;
  readonly judge?: EditorialJudge;
  /** The most requests one page may receive; the whole pass is bounded by `MAX_EDITORIAL_REQUESTS` too. */
  readonly maxPerPage?: number;
  readonly journal?: Journal;
  /** Called only if this pass ever writes a page. It never does; a test can prove the call never happens. */
  readonly onWrite?: (path: string) => void;
}

export interface EditorialPassResult {
  readonly findings: readonly EditorialFinding[];
  readonly requests: readonly RevisionRequest[];
  /** Requests the judge made that named a page or passage it was not shown, and failures of the judge itself. */
  readonly errors: readonly string[];
}

interface Held {
  readonly page: string;
  readonly statement: PageStatement;
  readonly index: number;
}

interface ParsedPage {
  readonly page: EditorialPage;
  readonly statements: readonly PageStatement[];
}

/** The statements of a page; a page that is not Markdown with a body simply has none. */
function parsed(page: EditorialPage): ParsedPage {
  const split = splitFrontMatter(page.text.split('\r\n').join('\n'));
  return { page, statements: statementsOf(split.body, split.bodyLine) };
}

const isWordCharacter = (character: string): boolean => character.toLowerCase() !== character.toUpperCase() || (character >= '0' && character <= '9');

const isDigit = (character: string): boolean => character >= '0' && character <= '9';

/** The sentence's words; punctuation and whitespace separate them, and no word list is involved. */
const tokensOf = (text: string): string[] => {
  const tokens: string[] = [];
  let held = '';
  for (const character of text.toLowerCase()) {
    if (isWordCharacter(character)) held += character;
    else if (held !== '') { tokens.push(held); held = ''; }
  }
  if (held !== '') tokens.push(held);
  return tokens;
};

const numbersOf = (text: string): string[] => {
  const numbers: string[] = [];
  let held = '';
  for (const character of text) {
    if (isDigit(character)) held += character;
    else if (held !== '') { numbers.push(held); held = ''; }
  }
  if (held !== '') numbers.push(held);
  return numbers;
};

/** The sentence's words with every number as one placeholder: two statements with this shape say the same thing, in numbers. */
const shapeOf = (text: string): string => tokensOf(text).map((token) => {
  let shape = '';
  for (const character of token) shape += isDigit(character) ? '#' : character;
  return shape;
}).join(' ');

/** A whole-word occurrence, without a word list and without a regular expression over the prose. */
function occurrence(text: string, needle: string): number {
  const haystack = text.toLowerCase();
  const wanted = needle.toLowerCase();
  let at = haystack.indexOf(wanted);
  while (at >= 0) {
    const before = at === 0 ? '' : haystack[at - 1]!;
    const after = haystack[at + wanted.length] ?? '';
    if ((before === '' || !isWordCharacter(before)) && (after === '' || !isWordCharacter(after))) return at;
    at = haystack.indexOf(wanted, at + 1);
  }
  return -1;
}

/** The same fact on two pages, with different values: same ground, same word shape, different numbers. */
function conflictingFacts(pages: readonly ParsedPage[]): EditorialFinding[] {
  const byGround = new Map<string, Held[]>();
  pages.forEach((parsedPage, index) => {
    for (const statement of parsedPage.statements) {
      for (const ground of statement.grounds) {
        const held = byGround.get(ground) ?? [];
        held.push({ page: parsedPage.page.path, statement, index });
        byGround.set(ground, held);
      }
    }
  });
  const findings: EditorialFinding[] = [];
  const once = new Set<string>();
  for (const [ground, held] of byGround) {
    for (let left = 0; left < held.length; left += 1) {
      for (let right = left + 1; right < held.length; right += 1) {
        const first = held[left]!;
        const second = held[right]!;
        if (first.page === second.page) continue;
        const firstNumbers = numbersOf(first.statement.text);
        const secondNumbers = numbersOf(second.statement.text);
        if (firstNumbers.length === 0 || secondNumbers.length === 0) continue;
        if (firstNumbers.join('\u0000') === secondNumbers.join('\u0000')) continue;
        if (shapeOf(first.statement.text) !== shapeOf(second.statement.text)) continue;
        const key = `${ground}\u0000${first.page}\u0000${first.statement.id}\u0000${second.page}\u0000${second.statement.id}`;
        if (once.has(key)) continue;
        once.add(key);
        findings.push({
          kind: 'conflicting-fact', page: second.page, passage: second.statement.id, line: second.statement.line,
          message: `${second.page}:${second.statement.line}: this page says ${secondNumbers.join(', ')} where ${first.page}:${first.statement.line} says ${firstNumbers.join(', ')} for the same fact (both stand on ${ground})`,
          value: secondNumbers[0], otherPage: first.page, otherPassage: first.statement.id, otherValue: firstNumbers[0],
        });
      }
    }
  }
  return findings;
}

/** A glossary synonym in prose where the term's title is not: the document itself says which names are aliases. */
function glossaryAliases(pages: readonly ParsedPage[], entities: readonly DocEntity[]): EditorialFinding[] {
  const terms = entities.filter((entity) => entity.semantics === 'term').map((entity) => ({ entity, fields: parseTermText(entity.text) }));
  const findings: EditorialFinding[] = [];
  for (const parsedPage of pages) {
    const pageText = parsedPage.page.text.toLowerCase();
    for (const { entity, fields } of terms) {
      const title = entity.title.trim();
      if (title === '') continue;
      for (const synonym of fields.synonyms) {
        const used = synonym.trim();
        if (used.length < 3 || used.toLowerCase() === title.toLowerCase()) continue;
        if (title.toLowerCase().includes(used.toLowerCase()) || used.toLowerCase().includes(title.toLowerCase())) continue;
        if (occurrence(pageText, used) < 0) continue;
        const statement = parsedPage.statements.find((held) => occurrence(held.text, used) >= 0 && occurrence(held.text, title) < 0);
        if (statement === undefined) continue;
        findings.push({
          kind: 'glossary-alias', page: parsedPage.page.path, passage: statement.id, line: statement.line,
          message: `${parsedPage.page.path}:${statement.line}: the glossary term "${title}" is used here as "${used}"; a newcomer cannot tell the two names are one term`,
          term: title, used,
        });
      }
    }
  }
  return findings;
}

/** Whether a code name is the kind of name that reads as an identifier rather than as a word. */
function identifierLike(value: string): boolean {
  if (value.length < 4) return false;
  if ([...value].some((character) => character === '_' || character === '.' || character === '/' || character === ':' || character === '#')) return true;
  for (let index = 1; index < value.length; index += 1) {
    const before = value[index - 1]!;
    const after = value[index]!;
    if (before.toLowerCase() === before && before.toUpperCase() !== before && after.toUpperCase() === after && after.toLowerCase() !== after) return true;
  }
  return false;
}

/** An all-capitals name with a digit or an underscore: the shape of an environment variable, not a word. */
function upperName(value: string): boolean {
  if (value.length < 3 || value !== value.toUpperCase() || value === value.toLowerCase()) return false;
  return [...value].some((character) => character === '_' || isDigit(character));
}

/** What the graph holds that a reader would not know by name: keys, file paths and code names. */
async function graphIdentifiers(graph: EditorialGraph | undefined): Promise<{ value: string; kind: string }[]> {
  if (graph === undefined) return [];
  const candidates = new Map<string, string>();
  let after: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const found = await graph.find({ limit: 200, ...(after === undefined ? {} : { after }) });
    for (const node of found.nodes) {
      candidates.set(node.key, node.kind);
      const suffix = node.key.includes(':') ? node.key.slice(node.key.indexOf(':') + 1) : node.key;
      if (identifierLike(suffix) || upperName(suffix)) candidates.set(suffix, node.kind);
      if (identifierLike(node.label) || upperName(node.label)) candidates.set(node.label, node.kind);
      for (const value of Object.values(node.properties)) {
        if (typeof value === 'string' && (identifierLike(value) || upperName(value))) candidates.set(value, node.kind);
      }
    }
    if (found.next === null || found.next === after) break;
    after = found.next;
  }
  return [...candidates].map(([value, kind]) => ({ value, kind })).sort((left, right) => right.value.length - left.value.length || byCodePoint(left.value, right.value));
}

/** A graph key, a path or a code name in a reader's sentence. */
function internalIdentifiers(pages: readonly ParsedPage[], identifiers: readonly { value: string; kind: string }[]): EditorialFinding[] {
  const findings: EditorialFinding[] = [];
  const once = new Set<string>();
  for (const parsedPage of pages) {
    for (const statement of parsedPage.statements) {
      for (const identifier of identifiers) {
        if (!statement.text.includes(identifier.value)) continue;
        const key = `${parsedPage.page.path}\u0000${statement.id}\u0000${identifier.value}`;
        if (once.has(key)) continue;
        once.add(key);
        findings.push({
          kind: 'internal-identifier', page: parsedPage.page.path, passage: statement.id, line: statement.line,
          message: `${parsedPage.page.path}:${statement.line}: the reader's sentence carries the internal ${identifier.kind} "${identifier.value}"; name it the way the product names it for a reader`,
          identifier: identifier.value,
        });
      }
    }
  }
  return findings;
}

/** The request the deterministic checks send for a finding. A conflict is sent to one page, naming the other. */
function deterministicRequest(finding: EditorialFinding): RevisionRequest {
  switch (finding.kind) {
    case 'conflicting-fact':
      return {
        page: finding.page, passage: finding.passage, source: 'deterministic',
        change: `Change the value in this sentence so it agrees with ${finding.otherPage}: ${finding.otherValue}. Keep the sentence's grounds.`,
        why: finding.message,
      };
    case 'glossary-alias':
      return {
        page: finding.page, passage: finding.passage, source: 'deterministic',
        change: `Use the glossary term "${finding.term}" instead of "${finding.used}".`,
        why: finding.message,
      };
    case 'internal-identifier':
      return {
        page: finding.page, passage: finding.passage, source: 'deterministic',
        change: `Say this in the reader's words instead of naming "${finding.identifier}".`,
        why: finding.message,
      };
  }
}

function record(journal: Journal | undefined, kind: 'editorial-finding' | 'revision-request', value: object): void {
  if (journal === undefined) return;
  journal.record(
    { run: journal.run, unit: 'editorial:pass', agent: 'editing', model: null, session: null },
    { kind, tool: kind, arguments: value, response: JSON.stringify(value), isError: false, outcome: 'ok', reason: null, startedAt: new Date(), durationMs: 0 },
  );
}

/** Keeps requests in page order, at most `maxPerPage` of each page and `MAX_EDITORIAL_REQUESTS` overall. */
function boundRequests(requests: readonly RevisionRequest[], maxPerPage: number): RevisionRequest[] {
  const perPage = new Map<string, number>();
  const out: RevisionRequest[] = [];
  for (const request of requests) {
    if (out.length >= MAX_EDITORIAL_REQUESTS) break;
    const used = perPage.get(request.page) ?? 0;
    if (used >= maxPerPage) continue;
    perPage.set(request.page, used + 1);
    out.push(request);
  }
  return out;
}

/**
 * Runs the pass over the pages a batch wrote. It reads only: no page's text is changed here, and no
 * file is written. The result's requests are bounded per page and over the whole pass.
 */
export async function runEditorialPass(options: EditorialPassOptions): Promise<EditorialPassResult> {
  const maxPerPage = Math.max(0, Math.floor(options.maxPerPage ?? 2));
  const parsedPages = options.pages.map(parsed);
  const findings: EditorialFinding[] = [
    ...conflictingFacts(parsedPages),
    ...glossaryAliases(parsedPages, options.documentEntities),
    ...internalIdentifiers(parsedPages, await graphIdentifiers(options.graph)),
  ];
  for (const finding of findings) record(options.journal, 'editorial-finding', finding);

  const deterministic = findings.map(deterministicRequest);
  const errors: string[] = [];
  const edited: RevisionRequest[] = [];
  if (options.judge !== undefined && maxPerPage > 0) {
    const pack: EditorialJudgePack = {
      pages: parsedPages.map(({ page, statements }) => ({
        path: page.path,
        title: page.title,
        statements: statements.map((statement) => ({ id: statement.id, line: statement.line, text: statement.text })),
      })),
      findings,
      maxPerPage,
    };
    let answer: EditorialJudgeAnswer | undefined;
    try {
      answer = await options.judge.judge(pack);
    } catch (error) {
      errors.push(`the editing judge did not answer: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (answer !== undefined) {
      const byPage = new Map(pack.pages.map((page) => [page.path, new Set(page.statements.map((statement) => statement.id))]));
      const answered = Array.isArray(answer.requests) ? answer.requests : [];
      for (const [index, request] of answered.entries()) {
        const page = typeof request?.page === 'string' ? request.page : '';
        const passage = typeof request?.passage === 'string' ? request.passage : '';
        const change = typeof request?.change === 'string' ? request.change.trim() : '';
        const why = typeof request?.why === 'string' ? request.why.trim() : '';
        if (!byPage.has(page)) { errors.push(`the editing judge's request ${index + 1} names the page ${JSON.stringify(page)}, which it was not shown`); continue; }
        if (!byPage.get(page)!.has(passage)) { errors.push(`the editing judge's request ${index + 1} names the passage ${JSON.stringify(passage)}, which it was not shown on ${page}`); continue; }
        if (change === '' || why === '') { errors.push(`the editing judge's request ${index + 1} on ${page} has no change or no reason`); continue; }
        if (change.length > 2000 || why.length > 2000) { errors.push(`the editing judge's request ${index + 1} on ${page} is longer than 2000 characters`); continue; }
        edited.push({ page, passage, change, why, source: 'editing' });
      }
    }
  }

  const requests = boundRequests([...deterministic, ...edited], maxPerPage);
  for (const request of requests) record(options.journal, 'revision-request', request);
  return { findings, requests, errors };
}
