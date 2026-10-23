/**
 * The tools one writer unit has (decision 0026: agents read only through the
 * graph, in bounded units with checked tools). Six reads and one checked
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
import type { GraphView } from './view.js';

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
  | { readonly kind: 'domain'; readonly id: string; readonly path: string; readonly domain: DomainDeclaration; readonly productId?: string };

/** Where checked pages go; the filesystem's is in `run.ts`. */
export interface PageSink {
  write(relativePath: string, content: string): Promise<void>;
  /** The page as written, for the units that follow. */
  read(relativePath: string): Promise<string>;
}

export interface UnitBounds {
  /** Refused or malformed writes one unit may make before it fails. */
  readonly maxWriteAttempts: number;
  /** Tool calls of all kinds one unit may make. */
  readonly maxCalls: number;
}

export const DEFAULT_UNIT_BOUNDS: UnitBounds = { maxWriteAttempts: 5, maxCalls: 80 };

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

  constructor(
    private readonly view: GraphView,
    readonly unit: UnitSpec,
    private readonly sink: PageSink,
    /** For a domain unit: the domains the product page declared. */
    private readonly knownDomains: readonly DomainDeclaration[] = [],
    private readonly bounds: UnitBounds = DEFAULT_UNIT_BOUNDS,
    /** The repositories the page is written from; recorded in its front matter. */
    private readonly basis: readonly WrittenAt[] = [],
  ) {}

  get tools(): readonly McpToolDefinition[] {
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
        case 'write_page': return await this.writePage(args);
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
    const verdict = await checkPage(markdown, { ...(previous === undefined ? {} : { previous }), ...(this.basis.length === 0 ? {} : { writtenAt: this.basis }), id: this.unit.id, kind: this.unit.kind, domains: domains.map((d) => d.slug), mustLinkDomains: this.unit.kind === 'product', ...(this.unit.kind === 'domain' && this.unit.productId !== undefined ? { productId: this.unit.productId } : {}) }, this.view);
    if (!verdict.ok) return this.refuse(verdict.refusals);
    await this.sink.write(this.unit.path, verdict.page.markdown);
    this.status = 'written';
    this.refusals = [];
    this.declared = this.unit.kind === 'product' ? domains : [];
    this.written = { grounds: verdict.page.grounds, links: verdict.page.links };
    return ok({ written: true, path: this.unit.path, grounds: verdict.page.grounds.length, links: verdict.page.links.length, ...(this.unit.kind === 'product' ? { domains: domains.map((d) => d.slug) } : {}) });
  }
}
