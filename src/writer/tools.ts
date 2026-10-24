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
import { byCodePoint } from '../model/order.js';
import type { McpToolDefinition } from '../fill/unit-mcp.js';
import { checkPage, MAX_SLUG_LENGTH, parseTarget, SLUG, type Refusal } from './format.js';
import type { WrittenAt } from '../knowledge/index/page.js';
import { MAX_ABOUT, MAX_SIDES, MAX_TEXT, MAX_TITLE, QUESTION_HEADINGS, QUESTION_TYPES, parseStatementRef, questionPath, renderQuestion, type Question, type QuestionLanguage, type QuestionType } from '../loop/entities.js';
import { slugOf } from './names.js';
import { statementsOf } from './sentences.js';
import { splitFrontMatter } from '../knowledge/markdown.js';
import type { GraphView } from './view.js';
import { detectStatementLanguage, LOCALIZED_SOURCE_SCHEMA, parseLocalizedSource, renderLocalizedSource } from './localized-source.js';

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
  | { readonly kind: 'localized-source'; readonly id: string; readonly path: string; readonly entity: import('../knowledge/doc-entities.js').DocEntity; readonly sourceLanguage: 'en' | 'ru'; readonly language: 'en' | 'ru' };

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

/** What a unit's tools take from the run besides the graph and the sink. */
export interface UnitExtras {
  /** The ids of the answered questions and the corrections a statement may stand on, read when a page is written. */
  readonly entityIds?: () => Promise<readonly string[]>;
  readonly clock?: () => Date;
  /** The language the pages and the questions' headings are written in. */
  readonly language?: string;
  /** The questions asked so far in the product (earlier runs and earlier units), read fresh at each ask: a question about a subject already asked adds its page to the one that exists. */
  readonly questions?: () => Promise<readonly Question[]>;
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
    description: `Asks the people a question you could not settle from the graph and the documents, and keeps going. Ask when two sources disagree (a document says one thing, the code another: say what each says, with its ground), when a term is used two ways, or when the code does something no document describes. Do not guess and do not state either side as fact. The question is saved as a file in the product; a person answers it in the wiki and the next refresh gives you the answer. The same subject is asked once: a question of the same type about mostly the same entities (graph keys and document sections, in its about and its sides' grounds) as an earlier one is added to that question as one more page, not saved again. At most ${MAX_QUESTIONS_PER_UNIT} questions per unit; asking does not end your unit, you still write your page, and for a contradiction the page keeps both sides.`,
    inputSchema: object({
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
  /** The contradictions this unit raised, with what each side says: its page must keep both sides. */
  private readonly contradictions: { id: string; sides: readonly { claim: string; grounds: readonly string[] }[] }[] = [];

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
    if (this.unit.kind === 'localized-source') return [
      { name: 'write_localized_source', description: `Write one grounded ${this.unit.language === 'ru' ? 'Russian' : 'English'} statement for this document entity. Use only the supplied source excerpt.`, inputSchema: object({ statement: { type: 'string' } }, ['statement']) },
    ];
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
    if (this.calls > this.bounds.maxCalls) return fail('call-limit', `this unit has made its ${this.bounds.maxCalls} tool calls; nothing more is answered`);
    const args = argumentsOf(argumentsValue);
    try {
      switch (tool) {
        case 'overview': return await this.overview();
        case 'find_nodes': return await this.findNodes(args);
        case 'get_node': return await this.getNode(args);
        case 'neighbors': return await this.neighbors(args);
        case 'read_file': return await this.readFile(args);
        case 'write_localized_source': return await this.writeLocalizedSource(args);
        case 'write_page': return await this.writePage(args);
        case 'ask_question': return await this.askQuestion(args);
        default: return fail('unknown-tool', `"${tool}" is no tool of this unit: the tools are ${WRITER_TOOLS.map((t) => t.name).join(', ')}`);
      }
    } catch (error) {
      return fail('tool-failed', `${tool} failed: ${error instanceof Error ? error.message : String(error)} (src/writer/tools.ts)`);
    }
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
    return ok({ written: true, id: this.unit.entity.id, path: this.unit.path });
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
    const anchors = /\.(md|markdown)$/i.test(path) ? await this.view.anchorsOf(path) : null;
    return ok({ path, totalLines: lines.length, startLine: start, endLine: end, next: end < lines.length ? end + 1 : null, text: shown.join('\n'), ...(anchors === null ? {} : { sectionAnchors: [...anchors].sort(byCodePoint) }) });
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

  private async askQuestion(args: Record<string, unknown>): Promise<ToolAnswer> {
    if (this.asked.length >= MAX_QUESTIONS_PER_UNIT) return fail('too-many-questions', `this unit asked its ${MAX_QUESTIONS_PER_UNIT} questions; write your page with what you know and leave the rest out`);
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
    // The same subject is asked once: a question of the same type whose entities are those of an earlier one (a Jaccard share of at least SAME_SUBJECT) adds this page to that one.
    const subject = subjectOf([...about], sides);
    const language = this.extras.language ?? 'en';
    if (subject.size > 0 && this.extras.questions !== undefined) {
      const same = (await this.extras.questions()).find((held) => held.type === type && overlap(subjectOf(held.about, held.sides), subject) >= SAME_SUBJECT);
      if (same !== undefined) {
        if (same.status === 'answered') {
          this.merged.push(same.id);
          return ok({ asked: false, answered: true, id: same.id, answer: same.answer?.text ?? null, note: `This subject was asked and answered (${same.id}). Do not ask it again; once the answer is used in a rewrite, ground the statement on ${same.id}.` });
        }
        const widened = [...new Set([...same.about, ...[...about].filter((entry) => parseTarget(entry)?.type === 'page' || parseStatementRef(entry) !== undefined || subject.has(entry))])].sort(byCodePoint);
        const kept = widened.length > MAX_ABOUT ? [...new Set([...same.about, this.unit.id])].sort(byCodePoint) : widened;
        if (kept.join('\n') !== [...same.about].join('\n')) await this.sink.write(questionPath(same.slug), renderQuestion({ ...same, about: kept }));
        if (!this.merged.includes(same.id)) this.merged.push(same.id);
        if (type === 'contradiction') this.contradictions.push({ id: same.id, sides });
        return ok({ asked: false, merged: true, id: same.id, note: `The same subject is already asked as ${same.id} ("${same.title}"); your page ${this.unit.id} was added to it, so a person answers it once. Do not ask it again and do not state either side as fact; go on and write what the sources agree on.` });
      }
    }
    const path = questionPath(slug);
    const existing = await this.sink.read(path).then(() => true, () => false);
    if (existing) return fail('question-exists', `a question "${slug}" is already asked (${path}); if it is yours to ask again it is the same question, and if it is another, give it a title that names what is different`);
    const now = (this.extras.clock?.() ?? new Date()).toISOString();
    const markdown = renderQuestion({
      language: language in QUESTION_HEADINGS ? language as QuestionLanguage : 'en',
      slug, title, type: type as QuestionType, status: 'open', about: [...about].sort(byCodePoint), askedIn: this.unit.id, askedAt: now,
      question, why, sides, answer: null, resolvedBy: [], resolvedAt: null, writtenAt: this.basis,
    });
    await this.sink.write(path, markdown);
    this.asked.push(`question:${slug}`);
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
    if (this.unit.kind === 'localized-source') return fail('wrong-unit', 'write_page is unavailable to a localized document-source unit');
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
    const entities = await this.extras.entityIds?.();
    const verdict = await checkPage(markdown, { ...(previous === undefined ? {} : { previous }), ...(entities === undefined ? {} : { entities }), ...(this.basis.length === 0 ? {} : { writtenAt: this.basis }), id: this.unit.id, kind: this.unit.kind, domains: domains.map((d) => d.slug), mustLinkDomains: this.unit.kind === 'product', ...(this.unit.kind === 'domain' && this.unit.productId !== undefined ? { productId: this.unit.productId } : {}) }, this.view);
    if (!verdict.ok) return this.refuse(verdict.refusals);
    const lost = this.contradictionProblems(verdict.page.grounds);
    if (lost.length > 0) return this.refuse(lost);
    await this.sink.write(this.unit.path, verdict.page.markdown);
    this.status = 'written';
    this.refusals = [];
    this.declared = this.unit.kind === 'product' ? domains : [];
    this.written = { grounds: verdict.page.grounds, links: verdict.page.links };
    return ok({ written: true, path: this.unit.path, grounds: verdict.page.grounds.length, links: verdict.page.links.length, ...(this.unit.kind === 'product' ? { domains: domains.map((d) => d.slug) } : {}) });
  }
}
