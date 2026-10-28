/**
 * The tools one writer unit has (decision 0026: agents read only through the
 * graph, in bounded units with checked tools). Five reads, one checked page write and one question
 * write; nothing else reaches the repository or the disk.
 *
 * - Reads answer bounded pages in code-point order and say when they cut:
 *   `overview`, `find_nodes`, `get_node`, `neighbors`, `read_file` (served
 *   from the graph's content nodes, 200 lines at most).
 * - `write_page` is the one write. It checks the whole page (format, every
 *   ground, every link) before it writes anything; a refusal comes back to the
 *   agent with every rule that failed, and the unit has a bounded number of
 *   attempts. The core writes the file; the agent never touches the disk.
 *
 * A tool never raises: an answer that is a refusal says so with `isError`, so
 * an agent learns what to fix and a session does not die of it.
 */
import { resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { byCodePoint } from '../model/order.js';
import type { McpToolDefinition } from '../fill/unit-mcp.js';
import { checkPage, MAX_SLUG_LENGTH, parseTarget, SLUG, type Refusal } from './format.js';
import type { WrittenAt } from '../knowledge/index/page.js';
import { MAX_ABOUT, MAX_SIDES, MAX_TEXT, MAX_TITLE, QUESTION_HEADINGS, QUESTION_TYPES, parseQuestion, parseStatementRef, questionPath, renderQuestion, type Question, type QuestionLanguage, type QuestionType } from '../loop/entities.js';
import { slugOf } from './names.js';
import { statementsOf } from './sentences.js';
import { splitFrontMatter } from '../knowledge/markdown.js';
import type { GraphView } from './view.js';
import { AnswerRefusal, CONTEXT_PURPOSES, EVIDENCE_SHOWN, FLOW_DEPTH, FLOW_STEPS, FLOW_TARGETS, PAGES_SHOWN, QUESTIONS_SHOWN, UNRESOLVED_SHOWN, getContext, getDocumentSections, getPage, getSymbol, searchPages, searchQuestions, traceFlow, SnapshotReads, type AnswerResult, type ContextPurpose, type FlowTarget, type GraphReads, type SourceRead } from './answers.js';
import { betweenCounters, NO_COUNTERS, type CallCounters } from './journal.js';
import { detectStatementLanguage, LOCALIZED_SOURCE_SCHEMA, parseLocalizedSource, renderLocalizedSource } from './localized-source.js';
import { ENRICHMENT_FRONT_KEYS, enrichmentPageId, renderEnrichment } from './enrichment.js';
import type { GuidePreparedUnit } from './guides/host-contract.js';
import { validateGuide } from './guides/validate.js';
import { renderGuideArtifact } from './guides/artifact.js';
import { firstGuideCursor, guidePagesComplete, readGuidePageContext } from './guides/prepared.js';

/** A domain the product page declares. */
export interface DomainDeclaration {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  /** Graph keys or `doc:<path>#<anchor>` targets that show the domain exists; each must resolve. */
  readonly evidence: readonly string[];
}

export type UnitSpec =
  | { readonly kind: 'product'; readonly id: string; readonly path: string; readonly name: string }
  | { readonly kind: 'domain'; readonly id: string; readonly path: string; readonly domain: DomainDeclaration; readonly productId?: string }
  | { readonly kind: 'administrator-guide'; readonly id: string; readonly path: string; readonly prepared: GuidePreparedUnit }
  | { readonly kind: 'user-guide'; readonly id: string; readonly path: string; readonly prepared: GuidePreparedUnit }
  | { readonly kind: 'localized-source'; readonly id: string; readonly path: string; readonly entity: import('../knowledge/doc-entities.js').DocEntity; readonly sourceLanguage: 'en' | 'ru'; readonly language: 'en' | 'ru' }
  // The writer's own page kinds (decision 0032, section 1; madarch-ztyq.4): the graph's verdicts, the home
  // page and the editorial pass's report are knowledge pages of the same format, so they are checked and
  // written like the product and domain pages.
  | { readonly kind: 'validation' | 'overview' | 'editorial'; readonly id: string; readonly path: string; readonly name: string; readonly productId?: string }
  // The enrichment of ONE passage of a person's document: stored apart from the document, keyed by the
  // entity's identity, written through `write_enrichment` (`src/writer/enrichment.ts`).
  | { readonly kind: 'enrichment'; readonly id: string; readonly path: string; readonly entity: import('../knowledge/doc-entities.js').DocEntity; readonly task: string };

/** Where checked pages go; the filesystem's is in `run.ts`. */
export interface PageSink {
  write(relativePath: string, content: string): Promise<void>;
  /** The page as written, for the units that follow. */
  read(relativePath: string): Promise<string>;
  /** The files under a folder of the product (`docs/questions`), by repository path; absent when the sink cannot list. */
  list?(folder: string): Promise<string[]>;
}

/**
 * Whether two questions are about the same subject is decided on the entities they name (madarch-m38l.13): the graph
 * keys and document sections of their `about` and of their sides' grounds, without the containers that hold everything
 * (services, modules) and the pages.
 */
const BROAD_ENTITY = /^(code\.(service|module):|domain:|product:|question:|correction:)/;

/** How much of its entities a question must share with an earlier one to be the same question: the Jaccard index, at least this. */
export const SAME_SUBJECT = 0.5;

/** The share two subjects have in common, from 0 to 1. */
export function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const entity of a) if (b.has(entity)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** The entities a question is about: the graph keys and document sections of its `about` and of its sides' grounds, without the broad containers. */
export function subjectOf(about: readonly string[], sides: readonly { readonly grounds: readonly string[] }[]): Set<string> {
  const out = new Set<string>();
  for (const entry of [...about, ...sides.flatMap((side) => side.grounds)]) {
    const target = entry.startsWith('madarch:') ? entry.slice('madarch:'.length) : entry;
    if (BROAD_ENTITY.test(target) || parseStatementRef(target) !== undefined) continue;
    const parsed = parseTarget(target);
    if (parsed === undefined || parsed.type === 'page') continue;
    out.add(target);
  }
  return out;
}

/** The file a ground is in, so a ground on a function and on its file are the same place. */
function placeOf(ground: string): string {
  const target = ground.startsWith('madarch:') ? ground.slice('madarch:'.length) : ground;
  const hash = target.indexOf('#');
  const head = hash < 0 ? target : target.slice(0, hash);
  return head.startsWith('doc:') ? head : head.replace(/^code\.[a-z-]+:/, '');
}

export interface UnitBounds {
  /** Refused or malformed writes one unit may make before it fails. */
  readonly maxWriteAttempts: number;
  /** Tool calls of all kinds one unit may make. */
  readonly maxCalls: number;
}

export const DEFAULT_UNIT_BOUNDS: UnitBounds = { maxWriteAttempts: 5, maxCalls: 80 };

/** The questions one unit may ask (madarch-m38l.7): a person answers each, so the number is bounded. */
export const MAX_QUESTIONS_PER_UNIT = 6;
/** A comparison packet is whole or refused, never shortened to fit a tool response. */
export const MAX_QUESTION_COMPARISON_CHARACTERS = 120_000;

/** What a unit's tools take from the run besides the graph and the sink. */
export interface UnitExtras {
  /** The ids of the answered questions and the corrections a statement may stand on, read when a page is written. */
  readonly entityIds?: () => Promise<readonly string[]>;
  readonly clock?: () => Date;
  /** Product repository used to report full paths of failed writes. */
  readonly output?: string;
  /** The language the pages and the questions' headings are written in. */
  readonly language?: string;
  /** The questions asked so far in the product (earlier runs and earlier units), read fresh at each ask: a question about a subject already asked adds its page to the one that exists. */
  readonly questions?: () => Promise<readonly Question[]>;
  /** The graph reads the answers make: the pinned snapshot reader of the fill's view unless a caller gives its own. */
  readonly reads?: GraphReads;
}

export const MAX_DOMAINS = 12;
export const FIND_LIMIT = 40;
export const NEIGHBOR_LIMIT = 40;
export const FILE_LINES = 200;
const LINE_CHARACTERS = 400;
const PROPERTY_CHARACTERS = 2000;

export interface ToolAnswer {
  readonly answer: unknown;
  readonly isError: boolean;
  /**
   * What this call read, could not resolve and produced (decision 0032, section 2). It never reaches
   * the agent — only `answer` does — and is what the journal records beside the call.
   */
  readonly counters?: CallCounters;
}

export interface UnitOutcome {
  readonly unit: string;
  readonly status: 'written' | 'failed' | 'not-written';
  readonly path: string;
  readonly writeAttempts: number;
  readonly calls: number;
  /** The refusals of the last refused write (empty when written). */
  readonly refusals: readonly Refusal[];
  /** The domains the product page declared, in slug order (product unit only). */
  readonly domains: readonly DomainDeclaration[];
  /** The page's grounds and links, as written (empty unless written). */
  readonly grounds: readonly string[];
  readonly links: readonly string[];
  /** The paths the unit read through `read_file`, in order of first read. */
  readonly filesRead: readonly string[];
  /** The ids of the questions the unit asked, in order. */
  readonly questions: readonly string[];
  /** The ids of the existing questions this unit's questions were added to instead of being asked again (madarch-m38l.13). */
  readonly merged?: readonly string[];
}

const object = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({ type: 'object', additionalProperties: false, required, properties });

export const WRITER_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'overview',
    description: 'What the graph holds at the last filled commit: node kinds and relation types with their counts, and the Markdown documents of the product. Start here.',
    inputSchema: object({}),
  },
  {
    name: 'find_nodes',
    description: `Nodes of the graph in key order, ${FIND_LIMIT} at most per page: of one kind (such as code.service, code.module, code.symbol, code.route, code.table) and/or whose key or label contains a text. Pass the previous answer's "next" as "after" for the next page.`,
    inputSchema: object({
      kind: { type: 'string', description: 'A node kind, like "code.service".' },
      text: { type: 'string', description: 'Case-insensitive text that the key or the label contains.' },
      after: { type: 'string', description: 'The "next" of the previous page.' },
      limit: { type: 'integer', minimum: 1, maximum: FIND_LIMIT },
    }),
  },
  {
    name: 'get_node',
    description: 'One node by its graph logical key: kind, label, properties (cut when long) and its edge counts by relation and direction.',
    inputSchema: object({ key: { type: 'string', description: 'A key as find_nodes shows it, like "code.service:orders".' } }, ['key']),
  },
  {
    name: 'neighbors',
    description: `The nodes a node is linked to, ${NEIGHBOR_LIMIT} at most per page, in (relation, key) order. Direction "out" follows the node's own edges (what it calls, contains, imports), "in" the edges that end at it (its callers, its container).`,
    inputSchema: object({
      key: { type: 'string' },
      direction: { type: 'string', enum: ['out', 'in'] },
      relation: { type: 'string', description: 'Only this relation, like "code.calls".' },
      after: { type: 'string', description: 'The "next" of the previous page.' },
      limit: { type: 'integer', minimum: 1, maximum: NEIGHBOR_LIMIT },
    }, ['key', 'direction']),
  },
  {
    name: 'read_file',
    description: `The text of a file of the product, from the graph, with line numbers: ${FILE_LINES} lines at most per call (pass startLine to go on). For a Markdown document the answer also lists its section anchors, which a ground names as doc:<path>#<anchor>.`,
    inputSchema: object({
      path: { type: 'string', description: 'A repository path such as "docs/vision.md".' },
      startLine: { type: 'integer', minimum: 1 },
      endLine: { type: 'integer', minimum: 1 },
    }, ['path']),
  },
  {
    name: 'get_symbol',
    description: 'One declaration by name, with its code: the candidates when the name is not unique, and then its signature, its exact source span, the declaration that owns it, its callers, its callees, its references and the tests that exercise it. Ask this before reading a file: it answers about the function itself.',
    inputSchema: object({
      name: { type: 'string', description: 'A function, method, class or constant: "refund", "PaymentService.refund", or a key as find_nodes shows it.' },
      service: { type: 'string', description: 'Only the declarations of this service: "orders", "code.service:orders" or its label.' },
    }, ['name']),
  },
  {
    name: 'get_context',
    description: 'One entity\'s context in one call: what holds it, what it is made of, what calls, reads, writes and serves it, and the document sections that name it. The purpose decided what is read and how much.',
    inputSchema: object({
      entity: { type: 'string', description: 'A graph key as find_nodes shows it, like "code.service:orders".' },
      purpose: { type: 'string', enum: [...CONTEXT_PURPOSES], description: 'What you are about to write with it: domain, scenario, rule, decision, implementation or overview.' },
    }, ['entity', 'purpose']),
  },
  {
    name: 'trace_flow',
    description: 'A flow from a route or a function: the function that serves it, what it calls in the order the file reads, and the tables it reads or writes and the channels it publishes. A step\'s depth is how many calls away it is, never an order; a step whose site the graph does not hold says so.',
    inputSchema: object({
      entry: { type: 'string', description: 'A route ("POST /pay", or its key) or a function (its name, or its key).' },
      targets: { type: 'array', items: { type: 'string', enum: [...FLOW_TARGETS] }, description: 'What the flow is traced to: tables, events, calls into other services. All of them when absent.' },
      depth: { type: 'integer', minimum: 1, maximum: 8, description: `How many calls away the walk goes; ${FLOW_DEPTH} when absent.` },
      maxSteps: { type: 'integer', minimum: 1, maximum: 200, description: `How many steps the answer holds; ${FLOW_STEPS} when absent.` },
    }, ['entry']),
  },
  {
    name: 'get_document_sections',
    description: 'The sections of the product\'s documents whose heading or text holds the words you ask for, each as the ground doc:<path>#<anchor>, with its heading, its lines and an excerpt: the way to a use case, a rule or a decision, numbered or not.',
    inputSchema: object({
      intent: { type: 'string', description: 'The question, or the words the section must hold.' },
      scope: { type: 'string', description: 'Only the documents under this path, or one document, such as "docs/requirements.md".' },
    }, ['intent']),
  },
  {
    name: 'search_pages',
    description: 'The pages of the product already written — the product page, the domain pages and the questions — whose title or text holds the words you ask for, with the lines that hold them.',
    inputSchema: object({
      text: { type: 'string', description: 'The words to look for.' },
      kind: { type: 'string', description: 'Only the pages of this kind: "product", "domain" or "question".' },
      limit: { type: 'integer', minimum: 1, maximum: 20 },
    }, ['text']),
  },
  {
    name: 'get_page',
    description: 'One page of the product: the Markdown as written, or its front matter and its statements, each with the grounds behind it. A page id such as "domain:payments", or a path such as "docs/domains/payments.md".',
    inputSchema: object({
      page: { type: 'string', description: 'A page id or a repository path.' },
      format: { type: 'string', enum: ['md', 'json'], description: '"md" when absent.' },
    }, ['page']),
  },
  {
    name: 'search_questions',
    description: 'The questions the people were asked, with their status and what each is about. Open ones by default, the answered ones when asked for. Read this before you ask a question.',
    inputSchema: object({
      text: { type: 'string', description: 'Only the questions whose title, text or subjects hold these words.' },
      includeAnswered: { type: 'boolean', description: 'Also the answered questions, with their answer; false when absent.' },
      limit: { type: 'integer', minimum: 1, maximum: 60 },
    }),
  },
  {
    name: 'write_page',
    description: 'Writes this unit\'s page. The whole page is checked first against the format in your instructions: front matter, a footnote of grounds at the end of every statement sentence, and every ground and link resolved in the graph. If anything is wrong nothing is written and every problem is listed with its line; fix them and call again (attempts are bounded). The product unit also passes "domains", the domains of the product.',
    inputSchema: object({
      markdown: { type: 'string', description: 'The whole page: front matter, body, footnotes.' },
      domains: {
        type: 'array',
        description: 'Product unit only: the product\'s domains, each with evidence that resolves in the graph.',
        items: object({
          slug: { type: 'string', description: 'Lower-case words joined by hyphens, like "payments".' },
          title: { type: 'string' },
          summary: { type: 'string', description: 'One sentence of what the domain is.' },
          evidence: { type: 'array', items: { type: 'string' }, description: 'Graph keys or doc:<path>#<anchor> that show the domain exists.' },
        }, ['slug', 'title', 'summary', 'evidence']),
      },
    }, ['markdown']),
  },
  {
    name: 'ask_question',
    description: `Asks the people a decision you could not settle from the graph and documents. Before saving, compares with ALL open and answered questions by meaning, not title or shared entities. If comparison is needed, returns question-comparison-required with candidates; retry the same proposal with comparison entries for EVERY candidate, each id, same (boolean) and reason (what decision is shared or different). Different decisions about one entity stay separate. A matching answered question returns its answer: use it and ground the rewritten sentence on its id. A matching open question reuses its id and adds your page. Ask at most ${MAX_QUESTIONS_PER_UNIT} new questions per unit; keep both source sides of an open contradiction on the page and link its question at the sentence end. Write title, question, why and side claims in the wiki language.`,
    inputSchema: object({
      comparison: { type: 'array', description: 'Semantic judgment against every candidate returned by the previous ask. Same means the same decision, even if type, title or grounds differ.', items: object({ id: { type: 'string' }, same: { type: 'boolean' }, reason: { type: 'string', minLength: 1 } }, ['id', 'same', 'reason']) },
      type: { type: 'string', enum: [...QUESTION_TYPES], description: 'contradiction: sources disagree; ambiguous-term: a word means two things; undocumented: code behaviour no document describes; gap: something you could not ground.' },
      title: { type: 'string', description: `The question in one line (${MAX_TITLE} characters at most).` },
      question: { type: 'string', description: 'The question in full: what exactly a person must decide or tell.' },
      why: { type: 'string', description: 'Why it matters to a reader of the wiki.' },
      sides: {
        type: 'array',
        description: `What each source says, one entry per side (1 to ${MAX_SIDES}; a contradiction has at least two): a sentence and the grounds that show it.`,
        items: object({
          claim: { type: 'string', description: 'One sentence: what this source says.' },
          grounds: { type: 'array', items: { type: 'string' }, description: 'Graph keys or doc:<path>#<anchor> that show it; each must resolve.' },
        }, ['claim', 'grounds']),
      },
      about: { type: 'array', items: { type: 'string' }, description: `Optional, up to ${MAX_ABOUT}: graph keys, doc:<path>#<anchor>, or ids of pages the answer would change. Your own page is always included.` },
    }, ['type', 'title', 'question', 'why', 'sides']),
  },
];

/**
 * The one write of an enrichment unit (decision 0032, section 1; `src/writer/enrichment.ts`): the agent
 * writes the page's body, and the core writes the front matter that names the entity the page enriches.
 * The identity is therefore never the agent's to choose, and a page that would stand for another entity
 * cannot be written.
 */
export const WRITE_ENRICHMENT_TOOL: McpToolDefinition = {
  name: 'write_enrichment',
  description: 'Writes the enrichment of the one passage this unit is given. The body is Markdown in the page format: headings, then statements each ending in its footnotes, every ground a madarch: link. The core writes the front matter that names the entity, its source and the lines it stands at, and checks the whole page before it writes anything.',
  inputSchema: object({
    body: { type: 'string', description: 'The page body only: its headings, its statements with their footnotes, and the footnote definitions. No front matter.' },
  }, ['body']),
};

const fail = (code: string, message: string, extra: Record<string, unknown> = {}): ToolAnswer => ({ answer: { error: { code, message, ...extra } }, isError: true });
const ok = (answer: unknown): ToolAnswer => ({ answer, isError: false });

function argumentsOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, name: string): string | ToolAnswer {
  return typeof value === 'string' && value !== '' ? value : fail('bad-argument', `"${name}" is a non-empty text`);
}

function count(value: unknown, name: string, least: number, most: number, fallback: number): number | ToolAnswer {
  if (value === undefined) return fallback;
  return typeof value === 'number' && Number.isInteger(value) && value >= least && value <= most ? value : fail('bad-argument', `"${name}" is a whole number from ${least} to ${most}`);
}

const isFailure = (value: unknown): value is ToolAnswer => typeof value === 'object' && value !== null && 'isError' in value;

function shortProperties(properties: Record<string, unknown>): unknown {
  const shown = { ...properties };
  delete shown['recordKey'];
  const json = JSON.stringify(shown);
  return json.length <= PROPERTY_CHARACTERS ? shown : { truncated: true, firstCharacters: json.slice(0, PROPERTY_CHARACTERS) };
}

/** Check and create share one queue for every unit writing to the same product sink. */
const questionWrites = new WeakMap<PageSink, Promise<void>>();

/**
 * The source one unit has been shown, by file and line: the bytes of a file the unit is shown twice
 * are counted as repeated, so a unit that rereads a whole file instead of asking a question is
 * visible in the journal (decision 0032, section 2). A read is counted by its lines, because every
 * tool that shows source shows whole lines of it.
 */
class SourceLedger {
  private readonly byPath = new Map<string, { start: number; end: number }[]>();
  served = 0;
  repeated = 0;

  note(read: SourceRead): void {
    const held = this.byPath.get(read.path) ?? [];
    const total = Math.max(0, read.endLine - read.startLine + 1);
    let repeatedLines = 0;
    for (let line = read.startLine; line <= read.endLine; line += 1) if (held.some((range) => line >= range.start && line <= range.end)) repeatedLines += 1;
    const perLine = total === 0 ? 0 : read.bytes / total;
    this.repeated += Math.round(perLine * repeatedLines);
    this.served += Math.round(perLine * (total - repeatedLines));
    held.push({ start: read.startLine, end: read.endLine });
    this.byPath.set(read.path, held);
  }
}

/** One unit's tool session: counts what it does and enforces its bounds. */
export class UnitTools {
  private calls = 0;
  private writing = false;
  private writeAttempts = 0;
  private status: UnitOutcome['status'] = 'not-written';
  private refusals: readonly Refusal[] = [];
  private declared: readonly DomainDeclaration[] = [];
  private written: { grounds: readonly string[]; links: readonly string[] } = { grounds: [], links: [] };
  private readonly read: string[] = [];
  private readonly asked: string[] = [];
  private readonly merged: string[] = [];
  private readonly answersUsed = new Set<string>();
  /** The contradictions this unit raised, with what each side says: its page must keep both sides. */
  private readonly contradictions: { id: string; sides: readonly { claim: string; grounds: readonly string[] }[] }[] = [];
  /** The source this unit was shown, and the evidence, the joins and the output its calls made. */
  private readonly ledger = new SourceLedger();
  private readonly evidenceSeen = new Set<string>();
  private unresolvedJoins = 0;
  private readonly produced = { pages: 0, statements: 0, grounds: 0, links: 0, questions: 0 };
  private snapshot: GraphReads | undefined;

  constructor(
    private readonly view: GraphView,
    readonly unit: UnitSpec,
    private readonly sink: PageSink,
    /** For a domain unit: the domains the product page declared. */
    private readonly knownDomains: readonly DomainDeclaration[] = [],
    private readonly bounds: UnitBounds = DEFAULT_UNIT_BOUNDS,
    /** The repositories the page is written from; recorded in its front matter. */
    private readonly basis: readonly WrittenAt[] = [],
    private readonly extras: UnitExtras = {},
  ) {}

  get tools(): readonly McpToolDefinition[] {
    if (this.unit.kind === 'administrator-guide' || this.unit.kind === 'user-guide') return [
      ...(firstGuideCursor(this.unit.prepared) === undefined ? [] : [{ name: 'read_prepared_context', description: 'Read the next complete secret-safe prepared context packet. Start with the prompt cursor; follow next until null. No source entry is silently cut.', inputSchema: object({ cursor: { type: 'string' } }, ['cursor']) }]),
      { name: 'write_guide', description: 'Submit the complete structured guide after reading every prepared context packet. This tool never executes instructions.', inputSchema: object({ guide: { type: 'object', additionalProperties: true } }, ['guide']) },
    ];
    if (this.unit.kind === 'localized-source') return [
      { name: 'write_localized_source', description: `Write one grounded ${this.unit.language === 'ru' ? 'Russian' : 'English'} statement for this document entity. Use only the supplied source excerpt.`, inputSchema: object({ statement: { type: 'string' } }, ['statement']) },
    ];
    // An enrichment unit writes the page of one passage: the body is the agent's, the identity and the source
    // are the core's, so the page cannot be written about another entity or over a person's text.
    if (this.unit.kind === 'enrichment') return WRITER_TOOLS.map((tool) => (tool.name === 'write_page' ? WRITE_ENRICHMENT_TOOL : tool));
    return this.unit.kind === 'product' ? WRITER_TOOLS : WRITER_TOOLS.map((tool) => (tool.name === 'write_page' ? { ...tool, inputSchema: object({ markdown: { type: 'string' } }, ['markdown']) } : tool));
  }

  /** Whether the unit can still do anything: it wrote its page, or ran out of attempts or calls. */
  get finished(): boolean {
    return this.status === 'written' || this.writeAttempts >= this.bounds.maxWriteAttempts || this.calls >= this.bounds.maxCalls;
  }

  outcome(): UnitOutcome {
    return {
      unit: this.unit.id,
      status: this.status === 'written' ? 'written' : this.writeAttempts > 0 ? 'failed' : 'not-written',
      path: this.unit.path,
      writeAttempts: this.writeAttempts,
      calls: this.calls,
      refusals: this.refusals,
      domains: this.declared,
      grounds: this.written.grounds,
      links: this.written.links,
      filesRead: this.read,
      questions: this.asked,
      merged: this.merged,
    };
  }

  async call(tool: string, argumentsValue: unknown): Promise<ToolAnswer> {
    this.calls += 1;
    if (this.calls > this.bounds.maxCalls) return { ...fail('call-limit', `this unit has made its ${this.bounds.maxCalls} tool calls; nothing more is answered`), counters: NO_COUNTERS };
    const before = this.counters();
    const answer = await this.dispatch(tool, argumentsValue);
    return { ...answer, counters: betweenCounters(before, this.counters()) };
  }

  /** What this unit has read, could not resolve and produced so far: the journal's totals are the sum of its calls' deltas. */
  counters(): CallCounters {
    return {
      sourceBytes: { served: this.ledger.served, repeated: this.ledger.repeated },
      evidence: this.evidenceSeen.size,
      unresolvedJoins: this.unresolvedJoins,
      produced: { ...this.produced },
    };
  }

  /** The repository, the revision and the instant every answer is read at: an answer that names none is a claim without a basis. */
  private source(): Record<string, unknown> {
    return {
      repositories: this.basis.map((one) => ({ repository: one.repository, commit: one.commit })),
      at: this.view.at,
    };
  }

  private reads(): GraphReads {
    if (this.extras.reads !== undefined) return this.extras.reads;
    if (this.snapshot === undefined) this.snapshot = new SnapshotReads(this.view);
    return this.snapshot;
  }

  /** One answer of the graph-reading tools: its evidence, its unresolved joins and its cuts are counted and said. */
  private async answered(work: () => Promise<AnswerResult>): Promise<ToolAnswer> {
    let result: AnswerResult;
    try {
      result = await work();
    } catch (error) {
      if (error instanceof AnswerRefusal) {
        // A join the tool was asked for and could not make is counted; an argument of no shape is the unit's mistake.
        if (error.code !== 'bad-argument') this.unresolvedJoins += 1;
        return fail(error.code, error.message);
      }
      throw error;
    }
    for (const read of result.reads) this.ledger.note(read);
    for (const target of result.evidence) this.evidenceSeen.add(target);
    this.unresolvedJoins += result.unresolved.length;
    // One evidence target once: the file a symbol stands in is often its owner as well.
    const evidence = [...new Set(result.evidence)].sort(byCodePoint);
    const shown = evidence.slice(0, EVIDENCE_SHOWN);
    return ok({
      source: this.source(),
      ...result.body,
      evidence: shown,
      ...(result.unresolved.length === 0 ? {} : { unresolved: result.unresolved.slice(0, UNRESOLVED_SHOWN) }),
      truncated: result.truncated || shown.length < evidence.length,
    });
  }

  private async dispatch(tool: string, argumentsValue: unknown): Promise<ToolAnswer> {
    const args = argumentsOf(argumentsValue);
    try {
      if ((this.unit.kind === 'administrator-guide' || this.unit.kind === 'user-guide') && tool !== 'write_guide' && tool !== 'read_prepared_context') return fail('wrong-unit', 'this guide unit accepts only write_guide; its prepared source context is the complete bounded input');
      switch (tool) {
        case 'read_prepared_context': {
          if (this.unit.kind !== 'administrator-guide' && this.unit.kind !== 'user-guide') return fail('wrong-unit', 'prepared context belongs to guide units');
          const page=readGuidePageContext(this.unit.prepared,args['cursor']);
          return page===undefined?fail('prepared-cursor','the prepared-context cursor is invalid, out of order, or beyond the final packet'):ok(page);
        }
        case 'write_guide': return await this.writeGuide(args);
        case 'overview': return await this.overview();
        case 'find_nodes': return await this.findNodes(args);
        case 'get_node': return await this.getNode(args);
        case 'neighbors': return await this.neighbors(args);
        case 'read_file': return await this.readFile(args);
        case 'get_symbol': return await this.getSymbolAnswer(args);
        case 'get_context': return await this.getContextAnswer(args);
        case 'trace_flow': return await this.traceFlowAnswer(args);
        case 'get_document_sections': return await this.getDocumentSectionsAnswer(args);
        case 'search_pages': return await this.searchPagesAnswer(args);
        case 'get_page': return await this.getPageAnswer(args);
        case 'search_questions': return await this.searchQuestionsAnswer(args);
        case 'write_localized_source': return await this.writeLocalizedSource(args);
        case 'write_enrichment': return await this.writeEnrichment(args);
        case 'write_page': return await this.writePage(args);
        case 'ask_question': return await this.serialQuestion(args);
        default: return fail('unknown-tool', `"${tool}" is no tool of this unit: the tools are ${WRITER_TOOLS.map((t) => t.name).join(', ')}`);
      }
    } catch (error) {
      if (this.unit.kind === 'administrator-guide' || this.unit.kind === 'user-guide') return fail('tool-failed', 'guide tool failed; sensitive details withheld (src/writer/tools.ts)');
      return fail('tool-failed', `${tool} failed: ${error instanceof Error ? error.message : String(error)} (src/writer/tools.ts)`);
    }
  }

  /**
   * Writes one passage's enrichment: the body the agent wrote inside the front matter the core owns, checked
   * as the page it is. The file lands apart from the person's document (`enrichmentPath`), and a refusal keeps
   * every problem with its line, so the agent can fix it and call again within its bound.
   */
  private async writeEnrichment(args: Record<string, unknown>): Promise<ToolAnswer> {
    const unit = this.unit;
    if (unit.kind !== 'enrichment') return fail('wrong-unit', 'write_enrichment belongs only to an enrichment unit');
    if (this.status === 'written') return fail('already-written', `this unit already wrote ${unit.path}`);
    if (this.writeAttempts >= this.bounds.maxWriteAttempts) return fail('no-attempts', `this unit made ${this.bounds.maxWriteAttempts} refused writes and has failed; nothing more is accepted`);
    this.writeAttempts += 1;
    const body = args['body'];
    if (typeof body !== 'string' || body.trim() === '') return this.refuse([{ line: 0, rule: 'body', message: '"body" is the non-empty Markdown of the page: headings, then statements each ending in its footnotes, and the footnote definitions' }]);
    let draft: string;
    try {
      draft = renderEnrichment({ entity: unit.entity, title: unit.entity.title, body });
    } catch (error) {
      return this.refuse([{ line: 0, rule: 'body', message: `${unit.path}:1: ${error instanceof Error ? error.message : String(error)}` }]);
    }
    const questions = await this.existingQuestions();
    const entities = [...new Set([...(await this.extras.entityIds?.() ?? []), ...questions.filter((question) => question.status === 'answered').map((question) => question.id)])];
    // A page written before stands: a sentence this write keeps keeps its footnote name, so the wiki's
    // statement identity survives a rewritten enrichment (0029).
    const previous = await this.sink.read(unit.path).catch(() => undefined);
    const verdict = await checkPage(draft, {
      file: unit.path,
      fullPath: resolve(this.extras.output ?? process.cwd(), unit.path),
      language: this.extras.language === 'ru' ? 'ru' : 'en',
      questions: questions.map((question) => question.id),
      ...(previous === undefined ? {} : { previous }),
      entities,
      ...(this.basis.length === 0 ? {} : { writtenAt: this.basis }),
      id: enrichmentPageId(unit.entity),
      kind: 'enrichment',
      domains: [],
      mustLinkDomains: false,
      extraFrontKeys: ENRICHMENT_FRONT_KEYS,
    }, this.view);
    if (!verdict.ok) return this.refuse(verdict.refusals);
    const unused = [...this.answersUsed].filter((id) => !verdict.page.grounds.includes(id));
    if (unused.length > 0) return this.refuse(unused.map((id) => ({ line: 1, rule: 'answer-not-used', message: `use the answer returned for ${id} and ground its rewritten sentence on that answered question` })));
    const lost = this.contradictionProblems(verdict.page.grounds);
    if (lost.length > 0) return this.refuse(lost);
    await this.sink.write(unit.path, verdict.page.markdown);
    this.status = 'written';
    this.refusals = [];
    this.written = { grounds: verdict.page.grounds, links: verdict.page.links };
    this.produced.pages += 1;
    const written = splitFrontMatter(verdict.page.markdown);
    this.produced.statements += statementsOf(written.body, written.bodyLine).length;
    this.produced.grounds += verdict.page.grounds.length;
    this.produced.links += verdict.page.links.length;
    return ok({ written: true, path: unit.path, entity: enrichmentPageId(unit.entity), grounds: verdict.page.grounds.length });
  }

  private async writeGuide(args: Record<string, unknown>): Promise<ToolAnswer> {
    const unit = this.unit;
    if (unit.kind !== 'administrator-guide' && unit.kind !== 'user-guide') return fail('wrong-unit', 'write_guide belongs only to guide units');
    if (this.writing) return fail('busy', 'one guide publication is already being checked');
    if (this.status === 'written') return fail('already-written', 'this guide was already published');
    if (this.writeAttempts >= this.bounds.maxWriteAttempts) return fail('no-attempts', 'this guide exhausted its checked write attempts');
    this.writeAttempts += 1;
    if (!guidePagesComplete(unit.prepared)) return this.refuse([{ line: 1, rule: 'guide-context-incomplete', message: `${unit.prepared.validation.file}:1: $.context: required prepared packets remain unread; no partial guide was published` }]);
    this.writing = true;
    let phase: 'guide-validation' | 'guide-render' | 'guide-publication' = 'guide-validation';
    try {
      const checked = await validateGuide(args['guide'], unit.prepared.validation);
      if (!checked.ok) return this.refuse(checked.diagnostics.map((problem) => ({ line: problem.line, rule: problem.code, message: `${unit.prepared.validation.file}:${problem.line}: ${problem.path}: validation refused (${problem.code}); authored values withheld` })));
      const guide = checked.guide;
      if (guide.kind !== unit.kind || guide.id !== unit.id) return this.refuse([{ line: 1, rule: 'guide-identity', message: `${unit.prepared.validation.file}:1: $.id: guide identity and kind differ from the unit` }]);
      phase = 'guide-render';
      const artifact = renderGuideArtifact(guide);
      phase = 'guide-publication';
      const published = await unit.prepared.publishChecked({ guide, artifact, expectedContext: unit.prepared.validation.expectedContext, expectedInputDigest: unit.prepared.validation.expectedInputDigest, expectedUnitVersion: unit.prepared.validation.expectedUnitVersion });
      if (!published.ok) return this.refuse(published.diagnostics.map((problem) => ({ line: problem.line, rule: problem.code, message: problem.message })));
      if (published.path !== unit.path) return this.refuse([{ line: 1, rule: 'guide-publication-path', message: `${unit.prepared.validation.file}:1: $.path: publication returned another path` }]);
      this.status = 'written';
      this.refusals = [];
      this.produced.pages += 1;
      return ok({ written: true, path: unit.path, unchanged: published.unchanged });
    } catch {
      // A source, agent or publication exception may contain sensitive source bytes.
      return this.refuse([{ line: 1, rule: phase, message: `${unit.prepared.validation.file}:1: $.guide: ${phase} failed; authored values and host exception details withheld; no success is certified` }]);
    } finally { this.writing = false; }
  }

  private async overview(): Promise<ToolAnswer> {
    const overview = await this.view.overview();
    return ok({ atCommit: this.view.at, kinds: overview.kinds, relations: overview.relations, documents: overview.documents });
  }

  private async findNodes(args: Record<string, unknown>): Promise<ToolAnswer> {
    const limit = count(args['limit'], 'limit', 1, FIND_LIMIT, FIND_LIMIT);
    if (isFailure(limit)) return limit;
    for (const name of ['kind', 'text', 'after'] as const) if (args[name] !== undefined && typeof args[name] !== 'string') return fail('bad-argument', `"${name}" is a text`);
    const page = await this.view.find({ ...(args['kind'] === undefined ? {} : { kind: args['kind'] as string }), ...(args['text'] === undefined ? {} : { text: args['text'] as string }), ...(args['after'] === undefined ? {} : { after: args['after'] as string }), limit });
    return ok({ nodes: page.nodes.map((n) => ({ key: n.key, kind: n.kind, label: n.label })), next: page.next });
  }

  private async getNode(args: Record<string, unknown>): Promise<ToolAnswer> {
    const key = text(args['key'], 'key');
    if (isFailure(key)) return key;
    const node = await this.view.node(key);
    if (node === null) return fail('no-such-key', `the graph has no node with the key ${JSON.stringify(key)} at the last filled commit; find it with find_nodes`);
    return ok({ key: node.key, kind: node.kind, label: node.label, properties: shortProperties(node.properties), edges: await this.view.degree(node) });
  }

  private async neighbors(args: Record<string, unknown>): Promise<ToolAnswer> {
    const key = text(args['key'], 'key');
    if (isFailure(key)) return key;
    const direction = args['direction'];
    if (direction !== 'out' && direction !== 'in') return fail('bad-argument', '"direction" is "out" or "in"');
    const limit = count(args['limit'], 'limit', 1, NEIGHBOR_LIMIT, NEIGHBOR_LIMIT);
    if (isFailure(limit)) return limit;
    for (const name of ['relation', 'after'] as const) if (args[name] !== undefined && typeof args[name] !== 'string') return fail('bad-argument', `"${name}" is a text`);
    const node = await this.view.node(key);
    if (node === null) return fail('no-such-key', `the graph has no node with the key ${JSON.stringify(key)} at the last filled commit`);
    const page = await this.view.neighbors(node, { direction, ...(args['relation'] === undefined ? {} : { relation: args['relation'] as string }), ...(args['after'] === undefined ? {} : { after: args['after'] as string }), limit });
    return ok({ key, direction, neighbors: page.neighbors.map((n) => ({ relation: n.relation, key: n.key, kind: n.kind, label: n.label })), next: page.next });
  }

  private async writeLocalizedSource(args: Record<string, unknown>): Promise<ToolAnswer> {
    if (this.unit.kind !== 'localized-source') return fail('wrong-unit', 'write_localized_source is available only to a localized document-source unit');
    if (this.status === 'written') return fail('already-written', `this unit already wrote ${this.unit.path}`);
    if (this.writeAttempts >= this.bounds.maxWriteAttempts) return fail('no-attempts', `this unit made ${this.bounds.maxWriteAttempts} refused writes and has failed; nothing more is accepted`);
    this.writeAttempts += 1;
    const reject = (code: string, rule: string, message: string): ToolAnswer => {
      this.refusals = [{ line: this.unit.kind === 'localized-source' ? this.unit.entity.line : 1, rule, message }];
      return fail(code, message);
    };
    const statement = args['statement'];
    if (typeof statement !== 'string' || statement.trim() === '') return reject('bad-statement', 'localized-statement', '"statement" is non-empty Markdown');
    if (statement.trim().length > 12_000) return reject('bad-statement', 'localized-statement', '"statement" is over the 12,000 character limit');
    // The fresh extracted excerpt is part of this isolated unit's input; product-owned documents are not code-graph files.
    const language = this.unit.language;
    const original = this.unit.entity.text;
    if (language === this.unit.sourceLanguage && statement.trim() === original.trim()) {
      this.status = 'written';
      return ok({ written: true, unchanged: true, id: this.unit.entity.id, path: this.unit.path });
    }
    if (detectStatementLanguage(statement) !== language) return reject('wrong-language', 'localized-language', `the statement does not appear to be in ${language}`);
    const content = renderLocalizedSource({ schema: LOCALIZED_SOURCE_SCHEMA, entity: this.unit.entity.id, kind: this.unit.entity.kind, wikiLanguage: language, sourceLanguage: this.unit.sourceLanguage, sourceDocument: this.unit.entity.repo === null ? this.unit.entity.path : `repos/${this.unit.entity.repo}/${this.unit.entity.path}`, sourceLine: this.unit.entity.line, sourceEndLine: this.unit.entity.endLine, original, statement: statement.trim() });
    const validated = parseLocalizedSource(this.unit.path, content, this.unit.entity, language);
    if (!validated.ok) return reject('invalid-localized-source', 'localized-format', `${this.unit.path}:${validated.line}: the generated artifact is invalid: ${validated.message}`);
    await this.sink.write(this.unit.path, content);
    this.refusals = [];
    this.status = 'written';
    this.written = { grounds: [`doc:${this.unit.entity.path}#${this.unit.entity.anchor}`], links: [] };
    this.produced.pages += 1;
    this.produced.statements += 1;
    this.produced.grounds += 1;
    return ok({ written: true, id: this.unit.entity.id, path: this.unit.path });
  }

  private async getSymbolAnswer(args: Record<string, unknown>): Promise<ToolAnswer> {
    const name = text(args['name'], 'name');
    if (isFailure(name)) return name;
    if (args['service'] !== undefined && typeof args['service'] !== 'string') return fail('bad-argument', '"service" is a text');
    return await this.answered(() => getSymbol(this.reads(), { name, ...(args['service'] === undefined ? {} : { service: args['service'] as string }) }));
  }

  private async getContextAnswer(args: Record<string, unknown>): Promise<ToolAnswer> {
    const entity = text(args['entity'], 'entity');
    if (isFailure(entity)) return entity;
    const purpose = args['purpose'];
    if (typeof purpose !== 'string' || !(CONTEXT_PURPOSES as readonly string[]).includes(purpose)) return fail('bad-argument', `"purpose" is one of ${CONTEXT_PURPOSES.join(', ')}`);
    return await this.answered(() => getContext(this.reads(), { entity, purpose: purpose as ContextPurpose }));
  }

  private async traceFlowAnswer(args: Record<string, unknown>): Promise<ToolAnswer> {
    const entry = text(args['entry'], 'entry');
    if (isFailure(entry)) return entry;
    const rawTargets = args['targets'];
    if (rawTargets !== undefined && (!Array.isArray(rawTargets) || rawTargets.some((one) => !(FLOW_TARGETS as readonly unknown[]).includes(one)))) return fail('bad-argument', `"targets" is a list of ${FLOW_TARGETS.join(', ')}`);
    const depth = count(args['depth'], 'depth', 1, 8, FLOW_DEPTH);
    if (isFailure(depth)) return depth;
    const maxSteps = count(args['maxSteps'], 'maxSteps', 1, 200, FLOW_STEPS);
    if (isFailure(maxSteps)) return maxSteps;
    const targets = (rawTargets === undefined ? [...FLOW_TARGETS] : [...new Set(rawTargets as FlowTarget[])].sort(byCodePoint));
    return await this.answered(() => traceFlow(this.reads(), { entry, targets, depth, maxSteps }));
  }

  private async getDocumentSectionsAnswer(args: Record<string, unknown>): Promise<ToolAnswer> {
    const intent = text(args['intent'], 'intent');
    if (isFailure(intent)) return intent;
    if (args['scope'] !== undefined && typeof args['scope'] !== 'string') return fail('bad-argument', '"scope" is a text');
    return await this.answered(() => getDocumentSections(this.reads(), { intent, ...(args['scope'] === undefined ? {} : { scope: args['scope'] as string }) }));
  }

  private async searchPagesAnswer(args: Record<string, unknown>): Promise<ToolAnswer> {
    const wanted = text(args['text'], 'text');
    if (isFailure(wanted)) return wanted;
    if (args['kind'] !== undefined && typeof args['kind'] !== 'string') return fail('bad-argument', '"kind" is a text, such as "product" or "domain"');
    const limit = count(args['limit'], 'limit', 1, 20, PAGES_SHOWN);
    if (isFailure(limit)) return limit;
    return await this.answered(() => searchPages(this.sink, { text: wanted, ...(args['kind'] === undefined ? {} : { kind: args['kind'] as string }), limit }));
  }

  private async getPageAnswer(args: Record<string, unknown>): Promise<ToolAnswer> {
    const page = text(args['page'], 'page');
    if (isFailure(page)) return page;
    const format = args['format'] ?? 'md';
    if (format !== 'md' && format !== 'json') return fail('bad-argument', '"format" is "md" or "json"');
    return await this.answered(() => getPage(this.sink, { page, format }));
  }

  private async searchQuestionsAnswer(args: Record<string, unknown>): Promise<ToolAnswer> {
    if (args['text'] !== undefined && typeof args['text'] !== 'string') return fail('bad-argument', '"text" is a text');
    if (args['includeAnswered'] !== undefined && typeof args['includeAnswered'] !== 'boolean') return fail('bad-argument', '"includeAnswered" is true or false');
    const limit = count(args['limit'], 'limit', 1, 60, QUESTIONS_SHOWN);
    if (isFailure(limit)) return limit;
    return await this.answered(() => searchQuestions(async () => await this.existingQuestions(), { ...(args['text'] === undefined ? {} : { text: args['text'] as string }), includeAnswered: args['includeAnswered'] === true, limit }));
  }

  private async readFile(args: Record<string, unknown>): Promise<ToolAnswer> {
    const path = text(args['path'], 'path');
    if (isFailure(path)) return path;
    const content = await this.view.fileText(path);
    if (content === null) {
      const known = (await this.view.node(`code.file:${path}`)) !== null;
      return fail('no-content', known ? `the file ${path} is in the graph but its text is not stored there (binary, too large, or not ingested)` : `the graph has no file ${JSON.stringify(path)} at the last filled commit`);
    }
    const lines = content.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const start = count(args['startLine'], 'startLine', 1, Math.max(1, lines.length), 1);
    if (isFailure(start)) return start;
    const requestedEnd = count(args['endLine'], 'endLine', 1, Number.MAX_SAFE_INTEGER, lines.length);
    if (isFailure(requestedEnd)) return requestedEnd;
    if (requestedEnd < start) return fail('bad-argument', '"endLine" is not before "startLine"');
    const end = Math.min(requestedEnd, lines.length, start + FILE_LINES - 1);
    if (!this.read.includes(path)) this.read.push(path);
    const shown = lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line.length > LINE_CHARACTERS ? `${line.slice(0, LINE_CHARACTERS)} [line cut at ${LINE_CHARACTERS} characters]` : line}`);
    // The source this unit was shown, so a second read of the same lines is counted as repeated bytes.
    this.ledger.note({ path, startLine: start, endLine: end, bytes: lines.slice(start - 1, end).reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8') + 1, 0) });
    this.evidenceSeen.add(path);
    const anchors = /\.(md|markdown)$/i.test(path) ? await this.view.anchorsOf(path) : null;
    // read_file answers with the same basis as the other reads: the repository and the pinned revision the text is from.
    return ok({ source: this.source(), path, totalLines: lines.length, startLine: start, endLine: end, next: end < lines.length ? end + 1 : null, text: shown.join('\n'), ...(anchors === null ? {} : { sectionAnchors: [...anchors].sort(byCodePoint) }) });
  }

  private async validateDomains(value: unknown): Promise<{ domains: DomainDeclaration[] } | { problems: Refusal[] }> {
    const problems: Refusal[] = [];
    const problem = (message: string): void => { problems.push({ line: 0, rule: 'domains', message }); };
    if (!Array.isArray(value) || value.length === 0) return { problems: [{ line: 0, rule: 'domains', message: `the product unit passes "domains": a list of 1 to ${MAX_DOMAINS} domains, each with slug, title, summary and evidence` }] };
    if (value.length > MAX_DOMAINS) problem(`${value.length} domains were declared; at most ${MAX_DOMAINS}`);
    const out: DomainDeclaration[] = [];
    const seen = new Set<string>();
    for (const [index, raw] of value.entries()) {
      const entry = argumentsOf(raw);
      const slug = entry['slug'];
      const title = entry['title'];
      const summary = entry['summary'];
      const evidence = entry['evidence'];
      const where = `domains[${index}]`;
      if (typeof slug !== 'string' || !SLUG.test(slug) || slug.length > MAX_SLUG_LENGTH) { problem(`${where}.slug ${JSON.stringify(slug)} is lower-case words joined by hyphens, at most ${MAX_SLUG_LENGTH} characters`); continue; }
      if (seen.has(slug)) problem(`${where}.slug "${slug}" is declared twice`);
      seen.add(slug);
      if (typeof title !== 'string' || title.trim() === '') problem(`${where}.title is a non-empty text`);
      if (typeof summary !== 'string' || summary.trim() === '') problem(`${where}.summary is a non-empty text`);
      if (!Array.isArray(evidence) || evidence.length === 0 || evidence.some((e) => typeof e !== 'string')) { problem(`${where}.evidence is a non-empty list of graph keys or doc:<path>#<anchor>`); continue; }
      for (const target of evidence as string[]) {
        const parsed = parseTarget(target.startsWith('madarch:') ? target.slice('madarch:'.length) : target);
        if (parsed === undefined || parsed.type === 'page') { problem(`${where}.evidence "${target}" is no graph key and no doc:<path>#<anchor>`); continue; }
        const found = parsed.type === 'doc' ? await this.view.docSection(parsed.path, parsed.anchor) : await this.view.graphKey(parsed.key);
        if (!found) problem(`${where}.evidence "${target}" does not resolve in the graph at the last filled commit`);
      }
      if (typeof title === 'string' && typeof summary === 'string') out.push({ slug, title: title.trim(), summary: summary.trim(), evidence: [...new Set((evidence as string[]).map((e) => (e.startsWith('madarch:') ? e.slice('madarch:'.length) : e)))].sort(byCodePoint) });
    }
    return problems.length > 0 ? { problems } : { domains: out.sort((a, b) => byCodePoint(a.slug, b.slug)) };
  }

  private async existingQuestions(): Promise<readonly Question[]> {
    if (this.extras.questions !== undefined) return [...await this.extras.questions()].sort((a, b) => byCodePoint(a.id, b.id));
    if (this.sink.list === undefined) throw new Error(`${this.extras.output === undefined ? this.unit.path : resolve(this.extras.output, this.unit.path)}:1: cannot compare questions: the sink cannot list docs/questions`);
    const questions: Question[] = [];
    for (const file of (await this.sink.list('docs/questions')).sort(byCodePoint)) {
      const fullPath = resolve(this.extras.output ?? process.cwd(), file);
      try { questions.push({ ...parseQuestion(fullPath, await this.sink.read(file)), file }); }
      catch (error) { throw new Error(`${fullPath}:1: cannot read a question candidate: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return questions;
  }

  /** Change only page association metadata; never re-render a person's answer or producer. */
  private async associateQuestion(question: Question, about: readonly string[]): Promise<void> {
    const source = await this.sink.read(question.file);
    const current = parseQuestion(question.file, source);
    if (JSON.stringify(current) !== JSON.stringify(question)) throw new Error(`${resolve(this.extras.output ?? process.cwd(), question.file)}:1: the question changed during comparison; retry against the fresh candidates; nothing was saved`);
    const header = /^(?:\uFEFF)?---\r?\n([^]*?)\r?\n---(?:\r?\n|$)/.exec(source);
    if (header === null) throw new Error(`${resolve(this.extras.output ?? process.cwd(), question.file)}:1: cannot update question associations without intact front matter`);
    const doc = parseDocument(header[1]!);
    if (doc.errors.length > 0) throw new Error(`${resolve(this.extras.output ?? process.cwd(), question.file)}:2: cannot update malformed question metadata`);
    doc.set('about', [...about]);
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const opening = source.slice(0, source.indexOf(newline) + newline.length);
    const closing = source.indexOf(newline + '---', opening.length);
    await this.sink.write(question.file, opening + doc.toString({ lineWidth: 0 }).trimEnd().replace(/\n/g, newline) + source.slice(closing));
  }

  private async serialQuestion(args: Record<string, unknown>): Promise<ToolAnswer> {
    const earlier = questionWrites.get(this.sink) ?? Promise.resolve();
    const answer = earlier.then(() => this.askQuestion(args));
    // Keep the queue usable after a read/write failure; the caller still receives that failure.
    questionWrites.set(this.sink, answer.then(() => undefined, () => undefined));
    return await answer;
  }

  private async askQuestion(args: Record<string, unknown>): Promise<ToolAnswer> {
    const problems: string[] = [];
    const bad = (message: string): void => { problems.push(message); };
    const type = args['type'];
    if (typeof type !== 'string' || !(QUESTION_TYPES as readonly string[]).includes(type)) bad(`"type" is one of ${QUESTION_TYPES.join(', ')}`);
    const bounded = (name: 'title' | 'question' | 'why', most: number): string => {
      const value = args[name];
      if (typeof value !== 'string' || value.trim() === '') { bad(`"${name}" is a non-empty text`); return ''; }
      if (value.trim().length > most) bad(`"${name}" is ${value.trim().length} characters; at most ${most}`);
      // The file's own structure (headings, a rule, a fence, footnote marks) is not the question's to write.
      if (/^\s{0,3}(#{1,6}\s|---\s*$|```|~~~)|\[\^/m.test(value)) bad(`"${name}" is plain paragraphs: no headings, rules, code fences or footnote marks`);
      return value.trim();
    };
    const title = bounded('title', MAX_TITLE).replace(/\s+/g, ' ');
    const question = bounded('question', MAX_TEXT);
    const why = bounded('why', MAX_TEXT);
    const rawSides = args['sides'];
    const sides: { claim: string; grounds: string[] }[] = [];
    if (!Array.isArray(rawSides) || rawSides.length === 0 || rawSides.length > MAX_SIDES) bad(`"sides" is a list of 1 to ${MAX_SIDES} entries, each with a claim and grounds`);
    else {
      if (type === 'contradiction' && rawSides.length < 2) bad('a contradiction has at least two sides: what one source says and what the other says');
      for (const [index, raw] of rawSides.entries()) {
        const entry = argumentsOf(raw);
        const where = `sides[${index}]`;
        const claim = entry['claim'];
        const grounds = entry['grounds'];
        if (typeof claim !== 'string' || claim.trim() === '' || claim.trim().length > MAX_TEXT) { bad(`${where}.claim is a non-empty text of at most ${MAX_TEXT} characters`); continue; }
        if (/\[\^|\]\(|\n/.test(claim)) { bad(`${where}.claim is one plain sentence: no line breaks, no links and no footnote marks`); continue; }
        if (!Array.isArray(grounds) || grounds.length === 0 || grounds.some((g) => typeof g !== 'string')) { bad(`${where}.grounds is a non-empty list of graph keys or doc:<path>#<anchor>`); continue; }
        const kept: string[] = [];
        for (const ground of [...new Set((grounds as string[]).map((g) => (g.startsWith('madarch:') ? g.slice('madarch:'.length) : g)))].sort(byCodePoint)) {
          const parsed = parseTarget(ground);
          if (parsed === undefined || parsed.type === 'page') { bad(`${where}.grounds "${ground}" is no graph key and no doc:<path>#<anchor>`); continue; }
          const found = parsed.type === 'doc' ? await this.view.docSection(parsed.path, parsed.anchor) : await this.view.graphKey(parsed.key);
          if (!found) { bad(`${where}.grounds "${ground}" does not resolve in the graph at the last filled commit${parsed.type === 'doc' ? `: the document ${parsed.path} has no section "${parsed.anchor}"` : ''}`); continue; }
          kept.push(ground);
        }
        sides.push({ claim: claim.trim(), grounds: kept });
      }
    }
    const rawAbout = args['about'];
    const about = new Set<string>([this.unit.id]);
    if (rawAbout !== undefined) {
      if (!Array.isArray(rawAbout) || rawAbout.length > MAX_ABOUT || rawAbout.some((a) => typeof a !== 'string')) bad(`"about" is a list of at most ${MAX_ABOUT} texts`);
      else {
        for (const entry of (rawAbout as string[]).map((a) => (a.startsWith('madarch:') ? a.slice('madarch:'.length) : a))) {
          const statement = parseStatementRef(entry);
          if (statement !== undefined) {
            if (statement.page !== this.unit.id) { bad(`about "${entry}": a statement can be named only on your own page (${this.unit.id}); name the page ${statement.page} instead`); continue; }
            const previous = await this.sink.read(this.unit.path).catch(() => undefined);
            const read = previous === undefined ? undefined : splitFrontMatter(previous);
            const body = read === undefined ? [] : statementsOf(read.body, read.bodyLine);
            if (!body.some((s) => s.id === statement.statement)) { bad(`about "${entry}": your page ${this.unit.id} has no statement ${statement.statement}`); continue; }
            about.add(entry);
            continue;
          }
          const parsed = parseTarget(entry);
          if (parsed === undefined) { bad(`about "${entry}" is no graph key, doc:<path>#<anchor> or page id`); continue; }
          if (parsed.type === 'page') {
            const own = parsed.id === this.unit.id || (this.unit.kind === 'domain' && parsed.id === this.unit.productId) || (parsed.id.startsWith('domain:') && this.knownDomains.some((d) => `domain:${d.slug}` === parsed.id));
            if (!own) { bad(`about "${entry}" names a page that does not exist: the pages are ${[...new Set([this.unit.id, ...this.knownDomains.map((d) => `domain:${d.slug}`)])].join(', ')}`); continue; }
            about.add(entry);
            continue;
          }
          const found = parsed.type === 'doc' ? await this.view.docSection(parsed.path, parsed.anchor) : await this.view.graphKey(parsed.key);
          if (!found) { bad(`about "${entry}" does not resolve in the graph at the last filled commit`); continue; }
          about.add(entry);
        }
      }
    }
    const slug = title === '' ? '' : slugOf(title);
    if (title !== '' && slug === 'statement') bad('"title" has no word to name the question by: say what it is about in words');
    if (problems.length > 0) return fail('bad-question', `the question was not saved: ${problems.join('; ')}`, { problems });
    const language = this.extras.language ?? 'en';
    const proseLanguage = (value: string): string | undefined => detectStatementLanguage(value.replace(/`[^`]*`|[“«][^”»]*[”»]|"[^"\n]*"/g, ''));
    const wrong = [['title', title], ['question', question], ['why', why], ...sides.map((side, index) => [`sides[${index}].claim`, side.claim])].filter(([, value]) => proseLanguage(value!) !== language);
    if (wrong.length > 0) return fail('question-language', `write ${wrong.map(([name]) => name).join(', ')} in ${language}; identifiers and explicit source quotations may stay unchanged`);
    const held = await this.existingQuestions();
    const seenCandidates = new Set<string>();
    for (const candidate of held) {
      if (seenCandidates.has(candidate.id)) return fail('question-candidates-invalid', `${resolve(this.extras.output ?? process.cwd(), candidate.file)}:2: duplicate candidate id ${candidate.id}; no complete comparison is possible and nothing was saved`);
      seenCandidates.add(candidate.id);
    }
    if (held.length > 0) {
      const raw = args['comparison'];
      const judgments = Array.isArray(raw) ? raw.map(argumentsOf) : [];
      const ids = new Set(judgments.map((entry) => entry['id']));
      const complete = judgments.length === held.length && ids.size === held.length && held.every((candidate) => ids.has(candidate.id)) && judgments.every((entry) => typeof entry['same'] === 'boolean' && typeof entry['reason'] === 'string' && entry['reason'].trim() !== '');
      const candidates = held.map((candidate) => ({ id: candidate.id, type: candidate.type, title: candidate.title, question: candidate.question, why: candidate.why, sides: candidate.sides, status: candidate.status, answer: candidate.answer?.text ?? null }));
      const characters = JSON.stringify(candidates).length;
      if (characters > MAX_QUESTION_COMPARISON_CHARACTERS) return fail('question-comparison-limit', `${resolve(this.extras.output ?? process.cwd(), 'docs/questions')}:1: the complete comparison of ${held.length} candidates needs ${characters} characters, above ${MAX_QUESTION_COMPARISON_CHARACTERS}; no candidate was shortened or omitted and no question was saved`, { count: held.length, characters, limit: MAX_QUESTION_COMPARISON_CHARACTERS });
      if (!complete) return { answer: { error: { code: 'question-comparison-required', message: 'Compare the decision by meaning against every fresh candidate, then retry this question with all comparison entries. Shared entities or title equality alone do not decide equivalence.' }, candidates }, isError: true };
      const matches = held.filter((candidate) => judgments.some((entry) => entry['id'] === candidate.id && entry['same'] === true));
      const same = matches.find((candidate) => candidate.status === 'answered') ?? matches[0];
      if (same !== undefined) {
        const widened = [...new Set([...same.about, this.unit.id])].sort(byCodePoint);
        if (widened.length > MAX_ABOUT) return fail('question-association-limit', `${resolve(this.extras.output ?? process.cwd(), same.file)}:2: the question already associates ${same.about.length} places; adding ${this.unit.id} would exceed ${MAX_ABOUT}; nothing was dropped or saved`);
        if (widened.join('\n') !== same.about.join('\n')) await this.associateQuestion(same, widened);
        if (!this.merged.includes(same.id)) this.merged.push(same.id);
        if (same.status === 'answered') {
          this.answersUsed.add(same.id);
          return ok({ asked: false, answered: true, id: same.id, answer: same.answer!.text, note: `Use this existing answer in your rewrite and ground the statement on ${same.id}. Do not ask the answered uncertainty again.` });
        }
        if (same.type === 'contradiction') this.contradictions.push({ id: same.id, sides: same.sides });
        else if (type === 'contradiction') this.contradictions.push({ id: same.id, sides });
        return ok({ asked: false, merged: true, id: same.id, note: `The same decision is already asked as ${same.id}; your page was added. Keep both sides of an open contradiction and link this question at the affected sentence end.` });
      }
    } else if (args['comparison'] !== undefined && (!Array.isArray(args['comparison']) || args['comparison'].length !== 0)) {
      return fail('question-comparison-required', 'The question set changed; there are no candidates now. Retry with an empty comparison.');
    }
    if (this.asked.length >= MAX_QUESTIONS_PER_UNIT) return fail('too-many-questions', `this unit asked its ${MAX_QUESTIONS_PER_UNIT} new questions; reuse existing decisions or write your page with what you know`);
    const path = questionPath(slug);
    // The serialized, fully read candidate set is authoritative; a failed read is never treated as absence.
    const existing = held.some((candidate) => candidate.file === path);
    if (existing) return fail('question-exists', `a question "${slug}" is already asked (${path}); if it is yours to ask again it is the same question, and if it is another, give it a title that names what is different`);
    const now = (this.extras.clock?.() ?? new Date()).toISOString();
    const markdown = renderQuestion({
      language: language in QUESTION_HEADINGS ? language as QuestionLanguage : 'en',
      slug, title, type: type as QuestionType, status: 'open', about: [...about].sort(byCodePoint), askedIn: this.unit.id, askedAt: now,
      question, why, sides, answer: null, resolvedBy: [], resolvedAt: null, writtenAt: this.basis,
    });
    await this.sink.write(path, markdown);
    this.asked.push(`question:${slug}`);
    this.produced.questions += 1;
    if (type === 'contradiction') this.contradictions.push({ id: `question:${slug}`, sides });
    return ok({ asked: true, id: `question:${slug}`, path, note: 'Saved for the people to answer. Do not state either side as fact on your page; go on and write what the sources agree on. When the question is a contradiction, keep what the code does and what the document says on your page, each as its own grounded sentence, and point to the question.' });
  }

  /** The sides of this unit's contradictions that the checked page does not ground, one problem per question. */
  private contradictionProblems(pageGrounds: readonly string[]): Refusal[] {
    const places = new Set(pageGrounds.map(placeOf));
    const problems: Refusal[] = [];
    for (const contradiction of this.contradictions) {
      const missing = contradiction.sides.filter((side) => !side.grounds.some((ground) => pageGrounds.includes(ground) || places.has(placeOf(ground))));
      if (missing.length === 0) continue;
      problems.push({
        line: 0,
        rule: 'contradiction-side-missing',
        message: `you asked ${contradiction.id} as a contradiction, and a question does not replace what the page knows: the page must keep every side as its own grounded sentence ("the code does X, the document says Y; see the question"). Not on the page yet: ${missing.map((side) => `${JSON.stringify(side.claim)} (ground it on ${side.grounds.join(', ')})`).join('; ')}`,
      });
    }
    return problems;
  }

  private refuse(refusals: readonly Refusal[]): ToolAnswer {
    this.refusals = refusals;
    const left = this.bounds.maxWriteAttempts - this.writeAttempts;
    return {
      answer: {
        written: false,
        refused: refusals.map((r) => ({ line: r.line, rule: r.rule, message: r.message })),
        attemptsLeft: left,
        note: left > 0 ? 'Nothing was written. Fix every listed problem and call write_page again with the whole page.' : 'Nothing was written and this unit has no attempts left: it has failed.',
      },
      isError: true,
    };
  }

  private async writePage(args: Record<string, unknown>): Promise<ToolAnswer> {
    if (this.writing) return fail('busy', 'another write_page of this unit is still being checked; call write_page one at a time');
    this.writing = true;
    try {
      return await this.writePageNow(args);
    } finally {
      this.writing = false;
    }
  }

  private async writePageNow(args: Record<string, unknown>): Promise<ToolAnswer> {
    if (this.unit.kind === 'localized-source' || this.unit.kind === 'administrator-guide' || this.unit.kind === 'user-guide' || this.unit.kind === 'enrichment') return fail('wrong-unit', `write_page is unavailable to this unit${this.unit.kind === 'enrichment' ? ': an enrichment is written with write_enrichment, whose front matter the core owns' : ''}`);
    if (this.status === 'written') return fail('already-written', `this unit already wrote ${this.unit.path}`);
    if (this.writeAttempts >= this.bounds.maxWriteAttempts) return fail('no-attempts', `this unit made ${this.bounds.maxWriteAttempts} refused writes and has failed; nothing more is accepted`);
    this.writeAttempts += 1;
    const markdown = args['markdown'];
    if (typeof markdown !== 'string' || markdown.trim() === '') return this.refuse([{ line: 0, rule: 'markdown', message: '"markdown" is the whole page as a non-empty text' }]);
    let domains = this.knownDomains;
    if (this.unit.kind === 'product') {
      const checked = await this.validateDomains(args['domains']);
      if ('problems' in checked) return this.refuse(checked.problems);
      domains = checked.domains;
    }
    // The page this one replaces, when there is one: a sentence that stands keeps its footnote name.
    const previous = await this.sink.read(this.unit.path).catch(() => undefined);
    const questions = await this.existingQuestions();
    const entities = [...new Set([...(await this.extras.entityIds?.() ?? []), ...questions.filter((question) => question.status === 'answered').map((question) => question.id)])];
    const verdict = await checkPage(markdown, { file: this.unit.path, fullPath: resolve(this.extras.output ?? process.cwd(), this.unit.path), language: this.extras.language === 'ru' ? 'ru' : 'en', questions: questions.map((question) => question.id), ...(previous === undefined ? {} : { previous }), ...(entities === undefined ? {} : { entities }), ...(this.basis.length === 0 ? {} : { writtenAt: this.basis }), id: this.unit.id, kind: this.unit.kind, domains: domains.map((d) => d.slug), mustLinkDomains: this.unit.kind === 'product', ...(this.unit.kind === 'domain' && this.unit.productId !== undefined ? { productId: this.unit.productId } : {}) }, this.view);
    if (!verdict.ok) return this.refuse(verdict.refusals);
    const unused = [...this.answersUsed].filter((id) => !verdict.page.grounds.includes(id));
    if (unused.length > 0) return this.refuse(unused.map((id) => ({ line: 1, rule: 'answer-not-used', message: `use the answer returned for ${id} and ground its rewritten sentence on that answered question` })));
    const lost = this.contradictionProblems(verdict.page.grounds);
    if (lost.length > 0) return this.refuse(lost);
    await this.sink.write(this.unit.path, verdict.page.markdown);
    this.status = 'written';
    this.refusals = [];
    this.declared = this.unit.kind === 'product' ? domains : [];
    this.written = { grounds: verdict.page.grounds, links: verdict.page.links };
    this.produced.pages += 1;
    const written = splitFrontMatter(verdict.page.markdown);
    this.produced.statements += statementsOf(written.body, written.bodyLine).length;
    this.produced.grounds += verdict.page.grounds.length;
    this.produced.links += verdict.page.links.length;
    return ok({ written: true, path: this.unit.path, grounds: verdict.page.grounds.length, links: verdict.page.links.length, ...(this.unit.kind === 'product' ? { domains: domains.map((d) => d.slug) } : {}) });
  }
}
