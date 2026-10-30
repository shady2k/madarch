
/**
 * The writer's answers to the questions a unit asks about the product (decision 0032, section 2):
 * a symbol by name with its code, callers, callees, references and tests; an entity's context in one
 * call; a flow from a route to its tables and events; document sections by intent; the pages written
 * so far; one page as Markdown or JSON; and the questions the people were asked.
 *
 * Every read is made at one pinned instant of the graph (the fill's last commit) through the pinned
 * snapshot reader (`GraphReader`, decision 0028): edge sites, key prefixes and whole relations come
 * from the reader, never from a hand-written query, and nothing is read from the working tree. The
 * documents are cut into sections by `documentSections()`, the reader the index itself uses, so an
 * anchor this module answers with is an anchor a page may ground on.
 *
 * Nothing here says how an answer is used on a page: that is the unit prompt's. Every answer names
 * the repositories and the instant it was read at, the evidence it stands on, and every list it cut;
 * a join it could not make is counted and said, never dropped.
 */
import { parse as parseYaml } from 'yaml';
import { anchorLines } from '../knowledge/anchors.js';
import { GraphReader, type GraphEntity, type NeighborEdge, type NeighborGroup } from '../knowledge/graph-read.js';
import { documentSections } from '../knowledge/index/sections.js';
import { splitFrontMatter } from '../knowledge/markdown.js';
import { fileKey, symbolKey } from '../extract/code/keys.js';
import type { Question } from '../loop/entities.js';
import { byCodePoint } from '../model/order.js';
import { statementsOf } from './sentences.js';
import type { PageSink } from './tools.js';

// ---- the reads an answer makes ------------------------------------------------------------

/** The reads the answers need: the pinned snapshot reader's, and the file texts the fill stored in the graph. */
export interface GraphReads {
  /** The instant every read is made at: the last commit the fill listed files for. */
  readonly at: string;
  /** The entity of a logical key, or undefined when the graph has none. */
  entity(key: string): Promise<GraphEntity | undefined>;
  /** One page of a kind's entities, by key, filtered by a text in the key or the label. */
  list(kind: string, options: { q?: string; limit: number }): Promise<{ rows: GraphEntity[]; total: number }>;
  /** The entities of a kind whose key starts with the prefix, in key order. */
  byPrefix(kind: string, prefix: string, limit: number): Promise<{ rows: GraphEntity[]; total: number }>;
  /** The edges of one relation at an entity, each with the site it was read at; `total` counts the entities at the other end. */
  edges(entity: GraphEntity, relation: string, direction: 'out' | 'in', limit: number): Promise<{ total: number; rows: NeighborEdge[] }>;
  /** The entity's relations grouped by relation and direction, with the count behind each group. */
  neighbors(entity: GraphEntity, options: { direction: 'out' | 'in' | 'both'; limit: number }): Promise<NeighborGroup[]>;
  /** The Markdown documents the graph holds, in code-point order. */
  documentPaths(): Promise<string[]>;
  /** The text of a file at the pinned instant, or null when the graph holds none. */
  fileText(path: string): Promise<string | null>;
}

/** The graph's own reads as the answers see them: the pinned snapshot reader at the view's instant. */
export class SnapshotReads implements GraphReads {
  private held: GraphReader | undefined;

  constructor(private readonly view: {
    readonly at: string;
    reader(): GraphReader;
    fileText(path: string): Promise<string | null>;
    documentPaths(): Promise<string[]>;
  }) {}

  get at(): string {
    return this.view.at;
  }

  /** The one reader of this view: every read of one unit's answer is made at the same pinned instant. */
  private reader(): GraphReader {
    if (this.held === undefined) this.held = this.view.reader();
    return this.held;
  }

  async entity(key: string): Promise<GraphEntity | undefined> {
    const [found] = await this.reader().find(key);
    return found;
  }

  async list(kind: string, options: { q?: string; limit: number }): Promise<{ rows: GraphEntity[]; total: number }> {
    const page = await this.reader().list(kind, options);
    return { rows: page.rows, total: page.total };
  }

  async byPrefix(kind: string, prefix: string, limit: number): Promise<{ rows: GraphEntity[]; total: number }> {
    return await this.reader().byPrefix(kind, prefix, limit);
  }

  async edges(entity: GraphEntity, relation: string, direction: 'out' | 'in', limit: number): Promise<{ total: number; rows: NeighborEdge[] }> {
    return await this.reader().edgesOf(entity, relation, direction, limit);
  }

  async neighbors(entity: GraphEntity, options: { direction: 'out' | 'in' | 'both'; limit: number }): Promise<NeighborGroup[]> {
    return await this.reader().neighbors(entity, options);
  }

  async documentPaths(): Promise<string[]> {
    return await this.view.documentPaths();
  }

  async fileText(path: string): Promise<string | null> {
    return await this.view.fileText(path);
  }
}

/** An answer that cannot be given, in the words the unit needs to change what it asked. */
export class AnswerRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** A place the answer showed, for the count of source bytes and of what a unit read twice. */
export interface SourceRead {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  /** The bytes of these lines, line breaks included. */
  readonly bytes: number;
}

/** What one answer holds beside what the agent reads: the evidence, the joins it could not make, and the cuts it made. */
export interface AnswerResult {
  readonly body: Record<string, unknown>;
  /** The graph keys, document sections and page paths the answer stands on, in the order they were read; the tool that serves it sorts them. */
  readonly evidence: readonly string[];
  /** The joins that were asked for and could not be made, each in words. */
  readonly unresolved: readonly string[];
  /** The source the answer showed, for the count of source bytes. */
  readonly reads: readonly SourceRead[];
  /** True when any list of the answer was cut. */
  readonly truncated: boolean;
}

/** The bounds one answer keeps; every one of them is said when it cuts. */
export const SYMBOL_SIDE_LIMIT = 8;
export const CONTEXT_ROWS = 6;
export const CONTEXT_MAX_ROWS = 36;
export const FLOW_STEPS = 60;
export const FLOW_STEP_LIMIT = 200;
export const FLOW_DEPTH = 4;
export const SECTIONS_SHOWN = 30;
export const SECTION_EXCERPT = 400;
export const DOCUMENT_SCAN = 200;
export const SECTION_NAME = 120;
export const PAGE_LINES = 400;
export const PAGE_MATCHES = 4;
export const PAGE_TEXT = 240;
export const PAGES_SHOWN = 10;
export const QUESTIONS_SHOWN = 60;
export const EVIDENCE_SHOWN = 60;
export const UNRESOLVED_SHOWN = 20;

const lines = (text: string): string[] => {
  const all = text.split('\n');
  if (all[all.length - 1] === '') all.pop();
  return all;
};

const bytesOf = (all: readonly string[], start: number, end: number): number =>
  all.slice(start - 1, end).reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8') + 1, 0);

const read = (path: string, all: readonly string[], start: number, end: number): SourceRead =>
  ({ path, startLine: start, endLine: end, bytes: bytesOf(all, start, end) });

const shorten = (text: string, most: number): string => (text.length <= most ? text : `${text.slice(0, most - 1)}…`);

/** The words a text is matched by: the language's word-like segments, lower case. */
function words(text: string): string[] {
  const out: string[] = [];
  for (const segment of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text.toLowerCase())) {
    if (!segment.isWordLike) continue;
    let word = '';
    for (const character of segment.segment) {
      if (character === '_' || character === '-' || character >= '0' && character <= '9' || character.toLowerCase() !== character.toUpperCase()) word += character;
    }
    if (word !== '') out.push(word);
  }
  return out;
}

/** How many of the intent's words a text holds, each counted once; a word matches a longer one that contains it. */
function score(intent: readonly string[], text: string): number {
  const held = new Set(words(text));
  let found = 0;
  for (const word of intent) {
    for (const candidate of held) {
      if (candidate.includes(word)) { found += 1; break; }
    }
  }
  return found;
}

function headingOf(line: string): string {
  let text = line.trimStart();
  let hash = 0;
  while (text[hash] === '#') hash += 1;
  if (hash > 0 && hash <= 6) text = text.slice(hash).trimStart();
  const anchor = text.lastIndexOf('{#');
  if (anchor >= 0 && text.trimEnd().endsWith('}')) text = text.slice(0, anchor);
  text = text.trimEnd();
  while (text.endsWith('#')) text = text.slice(0, -1).trimEnd();
  return text.trim();
}

const isHeading = (line: string): boolean => {
  let at = 0;
  while (line[at] === ' ' && at < 3) at += 1;
  let hash = 0;
  while (line[at + hash] === '#') hash += 1;
  return hash > 0 && hash <= 6 && line[at + hash] === ' ';
};

function collapse(text: string): string {
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

/** The repository path a symbol, file or route key names; undefined for a key that names no file. */
function pathOf(key: string): string | undefined {
  const colon = key.indexOf(':');
  if (colon < 0) return undefined;
  const rest = key.slice(colon + 1);
  const hash = rest.indexOf('#');
  return hash < 0 ? (key.startsWith('code.file:') ? rest : undefined) : rest.slice(0, hash);
}

const nameOf = (key: string): string => {
  const hash = key.indexOf('#');
  return hash < 0 ? key : key.slice(hash + 1);
};

/** The shortest declaration around a span in the file; the function or class a call site or a route stands in. */
async function enclosing(graph: GraphReads, path: string, span: { lineStart: number; lineEnd: number }): Promise<GraphEntity | undefined> {
  const found = await graph.byPrefix('code.symbol', `code.symbol:${path}#`, 2000);
  let best: GraphEntity | undefined;
  for (const symbol of found.rows) {
    const held = symbol.span;
    if (held === undefined) continue;
    if (held.lineStart > span.lineStart || held.lineEnd < span.lineEnd) continue;
    if (best === undefined || best.span === undefined || held.lineEnd - held.lineStart < best.span.lineEnd - best.span.lineStart) best = symbol;
  }
  return best;
}

/** The signature of a declaration: the lines of its span up to the one that opens its body, cut at four lines. */
function signatureOf(all: readonly string[], span: { lineStart: number; lineEnd: number }): { text: string; lineStart: number; lineEnd: number; cut: boolean } {
  const taken: string[] = [];
  let end = span.lineStart;
  for (let line = span.lineStart; line <= Math.min(span.lineEnd, span.lineStart + 3); line += 1) {
    const text = all[line - 1] ?? '';
    taken.push(text);
    end = line;
    let close = false;
    for (let at = 0; at < text.length; at += 1) if (text[at] === '{' || text[at] === '(' || (text[at] === '=' && text[at + 1] === '>')) { close = true; break; }
    if (!close) {
      let at = text.length - 1;
      while (at >= 0 && text[at]!.trim() === '') at -= 1;
      if (at >= 0 && text[at] === ';') close = true;
    }
    if (close) break;
  }
  const text = taken.join('\n');
  return { text: shorten(text, 400), lineStart: span.lineStart, lineEnd: end, cut: end < span.lineEnd || text.length > 400 };
}

/** The entities at the other end of one relation, each with the site it was read at, and how many there are. */
interface Side {
  readonly relation: string;
  readonly direction: 'out' | 'in';
  readonly total: number;
  readonly shown: readonly { readonly key: string; readonly kind: string; readonly label: string; readonly site: { readonly path: string; readonly lineStart: number; readonly lineEnd: number } | null }[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** What the owner of a symbol is: the declaration that holds it by its qualified name, or the file it stands in. */
async function ownerOf(graph: GraphReads, symbol: GraphEntity): Promise<{ key: string; kind: string; label: string; symbolKind: string | null } | null> {
  const path = pathOf(symbol.key);
  if (path === undefined) return null;
  const qualified = nameOf(symbol.key);
  const dot = qualified.lastIndexOf('.');
  if (dot > 0) {
    const owner = await graph.entity(symbolKey(path, qualified.slice(0, dot)));
    if (owner !== undefined) {
      const kind = owner.properties['symbolKind'];
      return { key: owner.key, kind: owner.kind, label: owner.label, symbolKind: typeof kind === 'string' ? kind : null };
    }
  }
  const file = await graph.entity(fileKey(path));
  return file === undefined ? null : { key: file.key, kind: file.kind, label: file.label, symbolKind: null };
}

/** The service an entity belongs to, when the graph holds one: the service whose folder holds the entity's file. */
async function serviceOf(graph: GraphReads, entity: GraphEntity): Promise<GraphEntity | null> {
  const path = entity.span?.path ?? pathOf(entity.key);
  if (path === undefined) return null;
  const services = await graph.list('code.service', { limit: 200 });
  let best: GraphEntity | null = null;
  let longest = -1;
  for (const service of services.rows) {
    const root = service.span?.path;
    if (root === undefined) continue;
    const folder = root.slice(0, Math.max(0, root.lastIndexOf('/')));
    if (folder !== '' && path !== folder && !path.startsWith(`${folder}/`)) continue;
    if (folder.length > longest) { best = service; longest = folder.length; }
  }
  return best;
}

/** The symbols a name may mean: the key itself, a `path#name` key, or every declaration whose qualified name it is. */
async function symbolCandidates(graph: GraphReads, name: string, service: string | undefined): Promise<{ candidates: GraphEntity[]; searched: number; unresolved: string[] }> {
  const unresolved: string[] = [];
  const direct = name.startsWith('code.symbol:') ? await graph.entity(name) : name.includes('#') ? await graph.entity(symbolKey(name.slice(0, name.indexOf('#')), name.slice(name.indexOf('#') + 1))) : undefined;
  let found: GraphEntity[] = direct === undefined ? [] : [direct];
  if (direct !== undefined && direct.kind !== 'code.symbol') return { candidates: [], searched: 1, unresolved: [`${name} is a ${direct.kind}, not a symbol: get_symbol answers about code.symbol declarations; get_node or get_context answers about the others`] };
  let searched = 1;
  if (found.length === 0) {
    const tail = name.slice(name.lastIndexOf('.') + 1);
    const listed = await graph.list('code.symbol', { q: tail, limit: 200 });
    searched = listed.total;
    found = listed.rows.filter((row) => row.label === name || row.label.endsWith(`.${name}`) || nameOf(row.key) === name);
    if (listed.total > listed.rows.length) unresolved.push(`${listed.rows.length} of the ${listed.total} declarations whose name holds ${JSON.stringify(tail)} were searched: the name is too common to read whole`);
  }
  if (service === undefined) return { candidates: found, searched, unresolved };
  const wanted = await resolveService(graph, service);
  if (wanted === null) throw new AnswerRefusal('no-such-service', `the graph has no service ${JSON.stringify(service)}; the services are ${(await graph.list('code.service', { limit: 200 })).rows.map((row) => row.key).sort(byCodePoint).join(', ')}`);
  const root = wanted.span?.path;
  const folder = root === undefined ? undefined : root.slice(0, Math.max(0, root.lastIndexOf('/')));
  return {
    candidates: found.filter((row) => {
      const path = pathOf(row.key);
      if (path === undefined) return false;
      if (folder === undefined || folder === '') return true;
      return path === folder || path.startsWith(`${folder}/`);
    }),
    searched,
    unresolved,
  };
}

/** A service by its key, its name or its label. */
async function resolveService(graph: GraphReads, service: string): Promise<GraphEntity | null> {
  const key = service.startsWith('code.service:') ? service : `code.service:${service}`;
  const direct = await graph.entity(key);
  if (direct !== undefined) return direct;
  const listed = await graph.list('code.service', { q: service, limit: 200 });
  return listed.rows.find((row) => row.label === service || row.key === key) ?? null;
}

export interface GetSymbolArgs {
  readonly name: string;
  readonly service?: string;
}

/**
 * One symbol: the candidates a name means, and for the one it means its signature, its exact source
 * span, its owner, its callers, its callees, its references and its tests.
 */
export async function getSymbol(graph: GraphReads, args: GetSymbolArgs): Promise<AnswerResult> {
  const { candidates, unresolved, searched } = await symbolCandidates(graph, args.name, args.service);
  if (candidates.length === 0) {
    const why = unresolved.length > 0
      ? unresolved.join('; ')
      : `the graph holds no symbol named ${JSON.stringify(args.name)}${args.service === undefined ? '' : ` in the service ${JSON.stringify(args.service)}`}; ${searched} declarations of that name were searched: find one by its file with find_nodes, or pass its key`;
    throw new AnswerRefusal('no-such-symbol', why);
  }
  if (candidates.length > 1) {
    const shown = candidates.slice(0, SYMBOL_SIDE_LIMIT);
    return {
      body: {
        name: args.name,
        selected: null,
        candidates: shown.map((row) => ({ key: row.key, label: row.label, symbolKind: row.properties['symbolKind'] ?? null, path: pathOf(row.key) ?? null, lineStart: row.span?.lineStart ?? null })),
        total: candidates.length,
        note: candidates.length > shown.length ? `the first ${shown.length} of ${candidates.length} declarations of that name are listed: pass "service" or the symbol's key` : 'several declarations have that name: pass "service" or the symbol\'s key',
      },
      evidence: shown.map((row) => row.key),
      unresolved,
      reads: [],
      truncated: candidates.length > shown.length,
    };
  }
  const symbol = candidates[0]!;
  const path = pathOf(symbol.key);
  const span = symbol.span;
  const text = path === undefined ? null : await graph.fileText(path);
  const all = text === null ? [] : lines(text);
  const reads: SourceRead[] = [];
  let truncated = false;
  let signature: unknown = null;
  if (span === undefined || text === null) {
    unresolved.push(`${symbol.key} has no source span the graph can read${span === undefined ? '' : `: the graph holds no text for ${span.path}`}`);
  } else {
    const read = signatureOf(all, span);
    signature = read;
    reads.push({ path: span.path, startLine: read.lineStart, endLine: read.lineEnd, bytes: bytesOf(all, read.lineStart, read.lineEnd) });
  }
  const owner = await ownerOf(graph, symbol);
  const service = await serviceOf(graph, symbol);
  const sides: Side[] = [];
  const evidence = [symbol.key, ...(path === undefined ? [] : [fileKey(path)]), ...(owner === null ? [] : [owner.key]), ...(service === null ? [] : [service.key])];
  for (const [relation, direction] of [['code.calls', 'in'], ['code.calls', 'out'], ['code.references', 'in'], ['code.tests', 'in']] as const) {
    const found = await graph.edges(symbol, relation, direction, SYMBOL_SIDE_LIMIT);
    const shown: Side['shown'] = found.rows.map((row) => ({
      key: row.other.key,
      kind: row.other.kind,
      label: row.other.label,
      site: row.span === undefined ? null : { path: row.span.path, lineStart: row.span.lineStart, lineEnd: row.span.lineEnd },
    }));
    if (found.total > shown.length) truncated = true;
    if (shown.length === 0 && found.total === 0) continue;
    sides.push({ relation, direction, total: found.total, shown });
    evidence.push(...shown.map((row) => row.key));
  }
  const kind = symbol.properties['symbolKind'];
  return {
    body: {
      name: args.name,
      selected: {
        key: symbol.key,
        label: symbol.label,
        symbolKind: typeof kind === 'string' ? kind : null,
        language: symbol.properties['language'] ?? null,
        path: path ?? null,
        signature,
        span: span === undefined ? null : { path: span.path, lineStart: span.lineStart, lineEnd: span.lineEnd, byteStart: span.byteStart, byteEnd: span.byteEnd },
        owner,
        service: service === null ? null : { key: service.key, label: service.label },
        exported: symbol.properties['exported'] === true,
        test: symbol.properties['test'] === true,
      },
      callers: sideOf(sides, 'code.calls', 'in'),
      callees: sideOf(sides, 'code.calls', 'out'),
      references: sideOf(sides, 'code.references', 'in'),
      tests: sideOf(sides, 'code.tests', 'in'),
      note: 'callers and references are read from the declarations of the graph; a call site of a function the graph did not resolve is in no list',
    },
    evidence,
    unresolved,
    reads,
    truncated,
  };
}

function sideOf(sides: readonly Side[], relation: string, direction: 'out' | 'in'): unknown {
  const held = sides.find((side) => side.relation === relation && side.direction === direction);
  return held === undefined ? { total: 0, shown: [] } : { total: held.total, shown: held.shown };
}

// ---- one entity's context -------------------------------------------------------------------

/** What a unit is about to write with the context: the unit's own purposes, never a product's. */
export const CONTEXT_PURPOSES = ['domain', 'scenario', 'rule', 'decision', 'implementation', 'overview'] as const;
export type ContextPurpose = (typeof CONTEXT_PURPOSES)[number];

/** The relations each purpose reads, in the order it reads them. */
const CONTEXT_PLAN: Readonly<Record<ContextPurpose, readonly { readonly relation: string; readonly direction: 'out' | 'in' }[]>> = {
  domain: [
    { relation: 'code.contains', direction: 'in' },
    { relation: 'code.declares', direction: 'in' },
    { relation: 'code.contains', direction: 'out' },
    { relation: 'code.serves', direction: 'in' },
    { relation: 'code.imports', direction: 'in' },
    { relation: 'code.depends-on', direction: 'in' },
    { relation: 'code.reads-table', direction: 'out' },
    { relation: 'code.writes-table', direction: 'out' },
    { relation: 'code.publishes', direction: 'out' },
    { relation: 'code.consumes', direction: 'out' },
    { relation: 'code.calls', direction: 'out' },
  ],
  scenario: [
    { relation: 'code.serves', direction: 'in' },
    { relation: 'code.contains', direction: 'in' },
    { relation: 'code.calls', direction: 'out' },
    { relation: 'code.calls', direction: 'in' },
    { relation: 'code.reads-table', direction: 'out' },
    { relation: 'code.writes-table', direction: 'out' },
    { relation: 'code.publishes', direction: 'out' },
    { relation: 'code.calls-remote', direction: 'out' },
    { relation: 'code.consumes', direction: 'in' },
  ],
  rule: [
    { relation: 'code.references', direction: 'in' },
    { relation: 'code.calls', direction: 'in' },
    { relation: 'code.tests', direction: 'in' },
    { relation: 'code.contains', direction: 'in' },
  ],
  decision: [
    { relation: 'code.contains', direction: 'in' },
    { relation: 'code.serves', direction: 'in' },
    { relation: 'code.references', direction: 'in' },
    { relation: 'code.tests', direction: 'in' },
  ],
  implementation: [
    { relation: 'code.calls', direction: 'in' },
    { relation: 'code.calls', direction: 'out' },
    { relation: 'code.references', direction: 'in' },
    { relation: 'code.tests', direction: 'in' },
    { relation: 'code.implements', direction: 'out' },
    { relation: 'code.implements', direction: 'in' },
    { relation: 'code.imports', direction: 'out' },
    { relation: 'code.contains', direction: 'in' },
    { relation: 'code.reads-table', direction: 'out' },
    { relation: 'code.writes-table', direction: 'out' },
  ],
  overview: [
    { relation: 'code.contains', direction: 'out' },
    { relation: 'code.contains', direction: 'in' },
  ],
};

/** The purposes whose answer also names the document sections that mention the entity. */
const CONTEXT_DOCUMENTS: readonly ContextPurpose[] = ['domain', 'scenario', 'rule', 'decision'];

export interface GetContextArgs {
  readonly entity: string;
  readonly purpose: ContextPurpose;
}

/** The name a text is searched for in documents: a symbol's own name, a service's label. */
const searchNameOf = (entity: GraphEntity): string => {
  const name = entity.properties['name'];
  if (typeof name === 'string' && name.trim() !== '') return name.trim();
  const key = entity.key;
  const named = key.includes('#') ? key.slice(key.indexOf('#') + 1) : key.slice(key.indexOf(':') + 1);
  const last = named.includes('.') ? named.slice(named.lastIndexOf('.') + 1) : named;
  return last === '' ? entity.label : last;
};

/** The document sections whose text names a word, bounded by documents scanned and by sections found. */
async function mentioning(graph: GraphReads, name: string, most: number): Promise<{ sections: { target: string; path: string; anchor: string; line: number; heading: string }[]; reads: SourceRead[]; scanned: number; documents: number; cut: boolean; unresolved: string[] }> {
  const paths = (await graph.documentPaths()).sort(byCodePoint);
  const wanted = words(name).filter((word) => word.length > 2);
  const sections: { target: string; path: string; anchor: string; line: number; heading: string }[] = [];
  const reads: SourceRead[] = [];
  const unresolved: string[] = [];
  let scanned = 0;
  let stopped = false;
  for (const path of paths) {
    if (sections.length >= most) { stopped = true; break; }
    if (scanned >= DOCUMENT_SCAN) { stopped = true; break; }
    const text = await graph.fileText(path);
    if (text === null) { unresolved.push(`the graph holds no text for the document ${path}`); continue; }
    scanned += 1;
    const all = lines(text);
    const anchors = anchorLines(text);
    for (const section of documentSections(text)) {
      if (wanted.length === 0) break;
      if (score(wanted, section.text) < wanted.length) continue;
      const first = section.text.split('\n')[0] ?? '';
      const lineStart = anchors.get(section.anchor) ?? 0;
      if (lineStart === 0) { unresolved.push(`the section ${path}#${section.anchor} has no line the graph's own anchor reader names`); continue; }
      const lineEnd = Math.min(all.length, lineStart + section.text.split('\n').length - 1);
      sections.push({ target: `doc:${path}#${section.anchor}`, path, anchor: section.anchor, line: lineStart, heading: shorten(isHeading(first) ? headingOf(first) : first.trim(), SECTION_NAME) });
      reads.push(read(path, all, lineStart, lineEnd));
      if (sections.length >= most) break;
    }
  }
  return { sections, reads, scanned, documents: paths.length, cut: stopped, unresolved };
}

/** One entity's context in one call: what holds it, what it is made of, what reads and writes it, and the documents that name it. */
export async function getContext(graph: GraphReads, args: GetContextArgs): Promise<AnswerResult> {
  const entity = await graph.entity(args.entity);
  const unresolved: string[] = [];
  if (entity === undefined) {
    throw new AnswerRefusal('no-such-entity', `the graph has no entity with the key ${JSON.stringify(args.entity)} at the last filled commit; find it with find_nodes or get_symbol. A page is read with get_page, a document section with get_document_sections`);
  }
  const purpose = args.purpose;
  const plan = CONTEXT_PLAN[purpose];
  if (plan === undefined) throw new AnswerRefusal('bad-argument', `"purpose" is one of ${CONTEXT_PURPOSES.join(', ')}`);
  const rows = purpose === 'overview' ? 1 : CONTEXT_ROWS;
  const groups = await graph.neighbors(entity, { direction: 'both', limit: rows });
  const key = (relation: string, direction: 'out' | 'in'): string => `${relation}\u0000${direction}`;
  const held = new Map(groups.map((group) => [key(group.relation, group.direction), group]));
  const ordered = [
    ...plan.flatMap((entry) => {
      const group = held.get(key(entry.relation, entry.direction));
      return group === undefined ? [] : [group];
    }),
    ...groups.filter((group) => !plan.some((entry) => entry.relation === group.relation && entry.direction === group.direction)).sort((a, b) => byCodePoint(a.relation, b.relation) || (a.direction === b.direction ? 0 : a.direction === 'in' ? -1 : 1)),
  ];
  const shown: { relation: string; direction: 'out' | 'in'; total: number; entities: { key: string; kind: string; label: string; site: { path: string; lineStart: number; lineEnd: number } | null }[] }[] = [];
  const leftOut: { relation: string; direction: 'out' | 'in'; hidden: number }[] = [];
  const evidence = [entity.key];
  let used = 0;
  let truncated = false;
  for (const group of ordered) {
    const room = Math.max(0, Math.min(CONTEXT_MAX_ROWS - used, purpose === 'overview' ? 0 : group.rows.length));
    const entities = purpose === 'overview' ? [] : group.rows.slice(0, room).map((row) => ({
      key: row.entity.key,
      kind: row.entity.kind,
      label: row.entity.label,
      site: row.span === undefined ? null : { path: row.span.path, lineStart: row.span.lineStart, lineEnd: row.span.lineEnd },
    }));
    used += entities.length;
    if (group.total > entities.length) {
      if (entities.length > 0) leftOut.push({ relation: group.relation, direction: group.direction, hidden: group.total - entities.length });
      truncated = true;
    }
    shown.push({ relation: group.relation, direction: group.direction, total: group.total, entities });
    evidence.push(...entities.map((one) => one.key));
    if (group.edges > group.rows.length) unresolved.push(`${group.relation} (${group.direction}) of ${entity.key} holds ${group.edges} edges between ${group.total} entities: the graph folds repeated sites into one edge`);
  }
  const service = await serviceOf(graph, entity);
  let documents: unknown = null;
  let reads: SourceRead[] = [];
  if (CONTEXT_DOCUMENTS.includes(purpose)) {
    const mentioned = await mentioning(graph, searchNameOf(entity), 6);
    documents = { sections: mentioned.sections, scanned: mentioned.scanned, documents: mentioned.documents };
    evidence.push(...mentioned.sections.map((section) => section.target));
    truncated = truncated || mentioned.cut;
    unresolved.push(...mentioned.unresolved);
    if (mentioned.cut) unresolved.push(`the documents that name ${JSON.stringify(searchNameOf(entity))} were searched ${mentioned.scanned} of ${mentioned.documents}: a section beyond them is not in this answer`);
    reads = mentioned.reads;
  }
  if (entity.span === undefined) unresolved.push(`${entity.key} has no source span in the graph: its place in a file is unknown`);
  return {
    body: {
      entity: {
        key: entity.key,
        kind: entity.kind,
        label: entity.label,
        path: entity.span?.path ?? null,
        lineStart: entity.span?.lineStart ?? null,
        lineEnd: entity.span?.lineEnd ?? null,
        service: service === null ? null : { key: service.key, label: service.label },
      },
      purpose,
      relations: shown,
      ...(documents === null ? {} : { documents }),
      ...(leftOut.length === 0 ? {} : { leftOut }),
    },
    evidence,
    unresolved,
    reads,
    truncated,
  };
}

// ---- a flow from a route to its tables and events --------------------------------------------

/** What a flow is traced to: a table it reads or writes, a channel it publishes on, a call into another service. */
export const FLOW_TARGETS = ['table', 'event', 'external'] as const;
export type FlowTarget = (typeof FLOW_TARGETS)[number];

export interface TraceFlowArgs {
  readonly entry: string;
  readonly targets: readonly FlowTarget[];
  readonly depth: number;
  readonly maxSteps: number;
}

/** One step of a flow: what it was read from, what it reached, and where in the source it was read. */
interface FlowStep {
  readonly from: { readonly key: string; readonly label: string };
  readonly to: { readonly key: string; readonly label: string };
  readonly relation: string;
  readonly kind: 'call' | 'table-read' | 'table-write' | 'event' | 'external';
  /** How many calls away from the entry the step's source is: reachability, never an order. */
  readonly depth: number;
  /** Where the step was read: `source` when the graph holds its site, `unknown` when it does not. */
  readonly order: 'source' | 'unknown';
  readonly site: { readonly path: string; readonly lineStart: number; readonly lineEnd: number } | null;
  readonly note?: string;
}

const FLOW_RELATIONS: readonly { readonly relation: string; readonly kind: FlowStep['kind'] }[] = [
  { relation: 'code.calls', kind: 'call' },
  { relation: 'code.reads-table', kind: 'table-read' },
  { relation: 'code.writes-table', kind: 'table-write' },
  { relation: 'code.publishes', kind: 'event' },
  { relation: 'code.calls-remote', kind: 'external' },
];

/** The functions a route hands its request to: what its registration calls at the route's own lines, or the registrar itself. */
async function handlersOfRoute(graph: GraphReads, route: GraphEntity): Promise<{ handlers: GraphEntity[]; unresolved: string[] }> {
  const span = route.span;
  if (span === undefined) return { handlers: [], unresolved: [`the route ${route.key} has no source span, so the function that serves it cannot be read`] };
  const named = route.properties['handlerKey'];
  const handlers = new Map<string, GraphEntity>();
  const unresolved: string[] = [];
  if (typeof named === 'string') {
    const held = await graph.entity(named);
    if (held !== undefined) handlers.set(held.key, held);
    else unresolved.push(`the route names the handler ${named} and the graph holds no such declaration`);
  }
  const registrar = await enclosing(graph, span.path, span);
  if (registrar === undefined) {
    unresolved.push(`the route is registered in ${span.path}, and the graph names no function that holds the registration`);
    return { handlers: [...handlers.values()].sort((a, b) => byCodePoint(a.key, b.key)), unresolved };
  }
  const calls = await graph.edges(registrar, 'code.calls', 'out', FLOW_STEP_LIMIT);
  for (const call of calls.rows) {
    if (call.other.kind !== 'code.symbol' || call.other.properties['test'] === true) continue;
    if (call.span === undefined || call.span.lineStart < span.lineStart || call.span.lineEnd > span.lineEnd) continue;
    handlers.set(call.other.key, call.other);
  }
  if (handlers.size === 0) handlers.set(registrar.key, registrar);
  return { handlers: [...handlers.values()].sort((a, b) => byCodePoint(a.key, b.key)), unresolved };
}

/** The edges of one relation at a node, read once per trace. */
type EdgeCache = Map<string, NeighborEdge[]>;

async function edgesAt(graph: GraphReads, node: GraphEntity, relation: string, unresolved: string[], cache: EdgeCache): Promise<NeighborEdge[]> {
  const id = `${node.key}\u0000${relation}`;
  const held = cache.get(id);
  if (held !== undefined) return held;
  const found = await graph.edges(node, relation, 'out', FLOW_STEP_LIMIT);
  if (found.total > found.rows.length) unresolved.push(`${node.key} has ${found.total} ${relation} targets and the first ${found.rows.length} were read: the flow stops there`);
  cache.set(id, found.rows);
  return found.rows;
}

/**
 * The steps one declaration takes, sorted by the site the graph read each at: its own calls and table
 * accesses, and the publications and remote calls of its file that stand inside it (the contract
 * extractor reads those at the file).
 */
async function stepsOf(graph: GraphReads, entity: GraphEntity, unresolved: string[], depth: number, cache: EdgeCache): Promise<FlowStep[]> {
  const span = entity.span;
  const out: (FlowStep & { at: number })[] = [];
  const steps: { relation: string; kind: FlowStep['kind']; edge: NeighborEdge }[] = [];
  for (const { relation, kind } of FLOW_RELATIONS) for (const edge of await edgesAt(graph, entity, relation, unresolved, cache)) steps.push({ relation, kind, edge });
  if (span !== undefined) {
    const file = await graph.entity(fileKey(span.path));
    if (file === undefined) unresolved.push(`the graph holds no file ${span.path}, so what its registrations publish is unknown`);
    else for (const relation of ['code.publishes', 'code.calls-remote'] as const) {
      for (const edge of await edgesAt(graph, file, relation, unresolved, cache)) {
        if (edge.span === undefined || edge.span.lineStart < span.lineStart || edge.span.lineEnd > span.lineEnd) continue;
        steps.push({ relation, kind: relation === 'code.publishes' ? 'event' : 'external', edge });
      }
    }
  }
  const at = (edge: NeighborEdge): number => edge.span?.byteStart ?? Number.MAX_SAFE_INTEGER;
  for (const { relation, kind, edge } of steps.sort((a, b) => at(a.edge) - at(b.edge) || byCodePoint(a.edge.other.key, b.edge.other.key)).map((one) => one)) {
    if (kind === 'call' && (edge.other.kind !== 'code.symbol' || edge.other.properties['test'] === true)) continue;
    if (kind === 'event' && edge.other.kind !== 'code.channel') continue;
    // A call or an access the graph read outside this declaration belongs to another function of the same file.
    if (span !== undefined && kind !== 'external' && edge.span !== undefined && (edge.span.lineStart < span.lineStart || edge.span.lineEnd > span.lineEnd)) continue;
    out.push({
      from: { key: entity.key, label: entity.label },
      to: { key: edge.other.key, label: edge.other.label },
      relation,
      kind,
      depth,
      order: edge.span === undefined ? 'unknown' : 'source',
      site: edge.span === undefined ? null : { path: edge.span.path, lineStart: edge.span.lineStart, lineEnd: edge.span.lineEnd },
      at: at(edge),
      ...(edge.span === undefined ? { note: 'the graph holds no site for this edge, so its place in the source is unknown' } : {}),
    });
  }
  return [...out].sort((a, b) => a.at - b.at || byCodePoint(a.to.key, b.to.key)).map(({ at: _at, ...step }) => step);
}

/** The flow of an entry: the route, the function that serves it, what it calls, and the tables and events it reaches. */
export async function traceFlow(graph: GraphReads, args: TraceFlowArgs): Promise<AnswerResult> {
  const entry = await resolveEntry(graph, args.entry);
  const unresolved: string[] = [];
  const evidence: string[] = [entry.key];
  let starts: GraphEntity[];
  let route: GraphEntity | null = null;
  if (entry.kind === 'code.route') {
    route = entry;
    const found = await handlersOfRoute(graph, entry);
    starts = found.handlers;
    unresolved.push(...found.unresolved);
    evidence.push(...starts.map((one) => one.key));
  } else starts = [entry];
  if (starts.length === 0) throw new AnswerRefusal('no-handler', `the entry ${entry.key} reaches no function in the graph: nothing can be traced from it`);
  const wanted = new Set(args.targets);
  const steps: FlowStep[] = [];
  const found: { kind: FlowTarget; key: string; label: string; hops: number }[] = [];
  const seen = new Set<string>(starts.map((one) => one.key));
  const cache: EdgeCache = new Map();
  const queue: { entity: GraphEntity; depth: number }[] = starts.map((entity) => ({ entity, depth: 0 }));
  let cutByDepth = 0;
  let cutBySteps = false;
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.entity.span === undefined) {
      unresolved.push(`${current.entity.key} has no source span the graph can read, so what it calls is unknown`);
      continue;
    }
    for (const step of await stepsOf(graph, current.entity, unresolved, current.depth, cache)) {
      if (steps.length >= args.maxSteps) { cutBySteps = true; break; }
      steps.push(step);
      const target: FlowTarget | null = step.kind === 'table-read' || step.kind === 'table-write' ? 'table' : step.kind === 'event' ? 'event' : step.kind === 'external' ? 'external' : null;
      if (target !== null && wanted.has(target)) found.push({ kind: target, key: step.to.key, label: step.to.label, hops: current.depth + 1 });
      if (step.kind !== 'call') continue;
      if (current.depth + 1 >= args.depth) { cutByDepth += 1; continue; }
      if (seen.has(step.to.key)) continue;
      const next = await graph.entity(step.to.key);
      if (next === undefined) { unresolved.push(`the call to ${step.to.key} is in the graph and the declaration it names is not`); continue; }
      seen.add(next.key);
      queue.push({ entity: next, depth: current.depth + 1 });
    }
    if (cutBySteps) break;
  }
  evidence.push(...steps.map((step) => step.to.key));
  // A target reached twice is one target at its nearest distance: a flow counts what it reaches, not the ways there.
  const nearest = new Map<string, { kind: FlowTarget; key: string; label: string; hops: number }>();
  for (const one of found) {
    const held = nearest.get(`${one.kind}\u0000${one.key}`);
    if (held === undefined || one.hops < held.hops) nearest.set(`${one.kind}\u0000${one.key}`, one);
  }
  const foundOrdered = [...nearest.values()].sort((a, b) => a.hops - b.hops || byCodePoint(a.kind, b.kind) || byCodePoint(a.key, b.key));
  const unknownOrder = steps.filter((step) => step.order === 'unknown').length;
  if (unknownOrder > 0) unresolved.push(`${unknownOrder} steps have no site in the graph: their place in the source, and so any order between them and their neighbours, is unknown`);
  return {
    body: {
      entry: { key: entry.key, kind: entry.kind, label: entry.label, ...(route === null ? {} : { method: route.properties['method'] ?? null, path: route.properties['path'] ?? null }) },
      handlers: starts.map((one) => one.key),
      targets: [...args.targets].sort(byCodePoint),
      depth: args.depth,
      maxSteps: args.maxSteps,
      steps,
      found: foundOrdered,
      stopped: { steps: cutBySteps, byDepth: cutByDepth },
      orderNote: 'depth is how many calls away a step is, not an order; a step\'s "order" is its site in the source file ("source") and "unknown" where the graph holds no site. Two steps of one depth are not a sequence unless their sites say so.',
    },
    evidence,
    unresolved,
    reads: [],
    truncated: cutBySteps || cutByDepth > 0 || unknownOrder > 0,
  };
}

/** The entity a flow starts at: a route, a symbol key or a symbol's name. */
async function resolveEntry(graph: GraphReads, entry: string): Promise<GraphEntity> {
  if (/^code\.[a-z-]+:/.test(entry)) {
    const held = await graph.entity(entry);
    if (held === undefined) throw new AnswerRefusal('no-such-entry', `the graph has no entity with the key ${JSON.stringify(entry)} at the last filled commit`);
    if (held.kind !== 'code.symbol' && held.kind !== 'code.route') throw new AnswerRefusal('bad-entry', `${entry} is a ${held.kind}: a flow starts at a code.route or a code.symbol declaration; get_context answers about the others`);
    return held;
  }
  const written = /^([A-Za-z]+)\s+(\S+)$/.exec(entry.trim());
  if (written !== null) {
    const method = written[1]!.toUpperCase();
    const path = written[2]!;
    const routes = await graph.list('code.route', { q: path, limit: FLOW_STEP_LIMIT });
    const matches = routes.rows.filter((row) => row.key.endsWith(`#${method}:${path}`) || (row.properties['method'] === method && row.properties['path'] === path));
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw new AnswerRefusal('ambiguous-entry', `the route ${method} ${path} is declared ${matches.length} times: ${matches.map((row) => row.key).sort(byCodePoint).join(', ')}; pass its key`);
    throw new AnswerRefusal('no-such-entry', `the graph holds no route ${method} ${path}; find one with find_nodes of kind code.route`);
  }
  const { candidates, searched } = await symbolCandidates(graph, entry, undefined);
  if (candidates.length === 0) throw new AnswerRefusal('no-such-entry', `the graph holds no route or symbol named ${JSON.stringify(entry)}; ${searched} declarations of that name were searched`);
  if (candidates.length > 1) throw new AnswerRefusal('ambiguous-entry', `${candidates.length} declarations have that name: ${candidates.slice(0, SYMBOL_SIDE_LIMIT).map((row) => row.key).sort(byCodePoint).join(', ')}${candidates.length > SYMBOL_SIDE_LIMIT ? ', ...' : ''}; pass the key`);
  return candidates[0]!;
}

// ---- documents by meaning --------------------------------------------------------------------

export interface GetDocumentSectionsArgs {
  /** The words the unit is looking for: the question it must answer on its page. */
  readonly intent: string;
  /** A document path or a folder of the product; every document when absent. */
  readonly scope?: string;
}

/** A section of a document, named as a ground names it. */
interface FoundSection {
  readonly target: string;
  readonly path: string;
  readonly anchor: string;
  readonly heading: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly excerpt: string;
  readonly matched: number;
}

/**
 * The document sections whose heading or text holds the words of an intent, in the order of how many
 * of them each holds and then in code-point order. The sections are cut by the reader the index uses,
 * so the anchor of every answer is an anchor a page may ground on.
 */
export async function getDocumentSections(graph: GraphReads, args: GetDocumentSectionsArgs): Promise<AnswerResult> {
  const wanted = words(args.intent);
  if (wanted.length === 0) throw new AnswerRefusal('bad-argument', '"intent" is a text of at least one word: the question the sections must answer');
  const scope = args.scope?.replace(/\/+$/, '');
  const all = (await graph.documentPaths()).sort(byCodePoint);
  const paths = scope === undefined || scope === '' ? all : all.filter((path) => path === scope || path.startsWith(`${scope}/`));
  const unresolved: string[] = [];
  if (paths.length === 0) throw new AnswerRefusal('no-documents', `the graph holds no Markdown document ${scope === undefined ? '' : `under ${JSON.stringify(scope)} `}at the last filled commit; the documents are ${all.join(', ') || 'none'}`);
  const found: (FoundSection & { read: SourceRead })[] = [];
  let scanned = 0;
  let stopped = false;
  for (const path of paths) {
    if (scanned >= DOCUMENT_SCAN) { stopped = true; break; }
    const text = await graph.fileText(path);
    if (text === null) { unresolved.push(`the graph holds no text for the document ${path}`); continue; }
    scanned += 1;
    const body = lines(text);
    const anchors = anchorLines(text);
    for (const section of documentSections(text)) {
      const first = section.text.split('\n')[0] ?? '';
      const heading = shorten(isHeading(first) ? headingOf(first) : first.trim(), SECTION_NAME);
      const matched = score(wanted, `${heading}\n${section.text}`);
      if (matched === 0) continue;
      const lineStart = anchors.get(section.anchor) ?? 0;
      if (lineStart === 0) { unresolved.push(`the section ${path}#${section.anchor} has no line the graph's own anchor reader names`); continue; }
      const lineEnd = Math.min(body.length, lineStart + section.text.split('\n').length - 1);
      found.push({
        target: `doc:${path}#${section.anchor}`,
        path,
        anchor: section.anchor,
        heading,
        lineStart,
        lineEnd,
        excerpt: shorten(collapse(section.text), SECTION_EXCERPT),
        matched,
        read: read(path, body, lineStart, lineEnd),
      });
    }
  }
  const ordered = found.sort((a, b) => b.matched - a.matched || byCodePoint(a.path, b.path) || byCodePoint(a.anchor, b.anchor));
  const shown = ordered.slice(0, SECTIONS_SHOWN);
  const sections = shown.map(({ read: _read, ...section }) => section);
  return {
    body: {
      intent: args.intent,
      scope: scope ?? null,
      documents: { scanned, held: paths.length },
      sections,
      total: ordered.length,
      note: 'a section is matched by the words of the intent, in its heading and its text: this is a word search over the documents\' own sections, not a classification of what each section means',
    },
    evidence: shown.map((section) => section.target),
    unresolved,
    reads: shown.map((section) => section.read),
    truncated: stopped || ordered.length > shown.length || scanned < paths.length,
  };
}

// ---- the pages written so far ----------------------------------------------------------------

export interface SearchPagesArgs {
  readonly text: string;
  readonly kind?: string;
  readonly limit: number;
}

/** The pages of the product the writer can read: the product page, the domain pages and the questions. */
const PAGE_FOLDERS = ['docs/domains', 'docs/questions'] as const;

async function pagePaths(pages: PageSink): Promise<string[]> {
  const found: string[] = ['docs/product.md'];
  if (pages.list === undefined) return found;
  for (const folder of PAGE_FOLDERS) found.push(...(await pages.list(folder)));
  return [...new Set(found)].sort(byCodePoint);
}

interface PageHead {
  readonly path: string;
  readonly id: string | null;
  readonly kind: string | null;
  readonly title: string | null;
  readonly body: string;
  readonly bodyLine: number;
}

async function readHead(pages: PageSink, path: string): Promise<PageHead | null> {
  let text: string;
  try { text = await pages.read(path); } catch { return null; }
  const { front, body, bodyLine } = splitFrontMatter(text);
  let record: Record<string, unknown> = {};
  if (front !== null) {
    try {
      const parsed: unknown = parseYaml(front);
      if (isRecord(parsed)) record = parsed;
    } catch { record = {}; }
  }
  const textOf = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
  return { path, id: textOf(record['id']), kind: textOf(record['kind']), title: textOf(record['title']), body, bodyLine };
}

/** The pages of the product whose title or text holds the words asked for, with the lines that hold them. */
export async function searchPages(pages: PageSink, args: SearchPagesArgs): Promise<AnswerResult> {
  const wanted = words(args.text);
  if (wanted.length === 0) throw new AnswerRefusal('bad-argument', '"text" is a text of at least one word to look for in the pages');
  const paths = await pagePaths(pages);
  const unresolved: string[] = [];
  const found: { path: string; id: string | null; kind: string | null; title: string | null; score: number; matches: { line: number; text: string }[]; lines: number }[] = [];
  let read_ = 0;
  for (const path of paths) {
    const head = await readHead(pages, path);
    if (head === null) continue;
    read_ += 1;
    if (args.kind !== undefined && head.kind !== args.kind) continue;
    const body = lines(head.body);
    const matches: { line: number; text: string }[] = [];
    const held = score(wanted, `${head.title ?? ''}\n${head.body}`);
    if (held === 0) continue;
    let hits = 0;
    for (const [index, line] of body.entries()) {
      if (score(wanted, line) === 0) continue;
      hits += 1;
      if (matches.length < PAGE_MATCHES) matches.push({ line: head.bodyLine + index, text: shorten(line.trim(), PAGE_TEXT) });
    }
    found.push({ path, id: head.id, kind: head.kind, title: head.title, score: held, matches, lines: hits });
  }
  const ordered = found.sort((a, b) => b.score - a.score || byCodePoint(a.path, b.path));
  const shown = ordered.slice(0, args.limit);
  // A page with a hit whose lines were not read is a page the search could not see whole; it is said, not hidden.
  if (shown.length === 0) unresolved.push(`no page of the ${read_} read holds ${JSON.stringify(args.text)}: the pages are ${paths.length === 0 ? 'none' : paths.join(', ')}`);
  return {
    body: {
      text: args.text,
      kind: args.kind ?? null,
      pages: shown,
      total: ordered.length,
      scanned: read_,
    },
    evidence: shown.map((page) => page.path),
    unresolved,
    reads: [],
    truncated: ordered.length > shown.length || shown.some((page) => page.lines > page.matches.length),
  };
}

// ---- one page ---------------------------------------------------------------------------------

export interface GetPageArgs {
  /** A page id (`product:<slug>`, `domain:<slug>`, `question:<slug>`) or a repository path such as `docs/domains/payments.md`. */
  readonly page: string;
  readonly format: 'md' | 'json';
  /** The wiki's language: the segmenter reads its sentences in it. */
  readonly language?: string;
}

/** The path a page id names, when it names one the writer keeps. */
function pathOfPage(page: string): string | null {
  if (page.endsWith('.md') && page.startsWith('docs/')) return page;
  const colon = page.indexOf(':');
  if (colon < 0) return null;
  const kind = page.slice(0, colon);
  const slug = page.slice(colon + 1);
  if (slug === '' || slug.includes('/')) return null;
  if (kind === 'product') return 'docs/product.md';
  if (kind === 'domain' || kind === 'question') return `docs/${kind}s/${slug}.md`;
  return null;
}

/** One page of the product: the Markdown as written, or its front matter and its statements with their grounds. */
export async function getPage(pages: PageSink, args: GetPageArgs): Promise<AnswerResult> {
  const path = pathOfPage(args.page);
  if (path === null) throw new AnswerRefusal('bad-page', `${JSON.stringify(args.page)} is no page the writer keeps: pass a page id such as product:<slug>, domain:<slug> or question:<slug>, or a path such as docs/domains/<slug>.md`);
  const head = await readHead(pages, path);
  if (head === null) {
    const known = await pagePaths(pages);
    throw new AnswerRefusal('no-such-page', `the product holds no ${path}; the pages are ${known.join(', ') || 'none'}`);
  }
  const whole = await pages.read(path);
  const body = lines(whole);
  if (args.format === 'md') {
    const shown = body.slice(0, PAGE_LINES);
    return {
      body: {
        page: args.page,
        path,
        id: head.id,
        kind: head.kind,
        title: head.title,
        totalLines: body.length,
        text: shown.join('\n'),
        ...(shown.length < body.length ? { next: shown.length + 1 } : {}),
      },
      evidence: [path],
      unresolved: [],
      reads: [{ path, startLine: 1, endLine: shown.length, bytes: bytesOf(body, 1, shown.length) }],
      truncated: shown.length < body.length,
    };
  }
  const statements = statementsOf(head.body, head.bodyLine, args.language);
  const { front } = splitFrontMatter(whole);
  let record: Record<string, unknown> = {};
  if (front !== null) {
    try {
      const parsed: unknown = parseYaml(front);
      if (isRecord(parsed)) record = parsed;
    } catch { record = {}; }
  }
  return {
    body: {
      page: args.page,
      path,
      id: head.id,
      kind: head.kind,
      title: head.title,
      frontMatter: record,
      statements: statements.map((statement) => ({ id: statement.id, line: statement.line, text: statement.text, grounds: statement.grounds, mentions: statement.mentions })),
      statementCount: statements.length,
    },
    evidence: [path],
    unresolved: [],
    reads: [],
    truncated: false,
  };
}

// ---- the questions the people were asked -------------------------------------------------------

export interface SearchQuestionsArgs {
  readonly text?: string;
  readonly includeAnswered: boolean;
  readonly limit: number;
}

/** The questions of the product, open ones and — when asked for — answered ones, with what each is about. */
export async function searchQuestions(questions: () => Promise<readonly Question[]>, args: SearchQuestionsArgs): Promise<AnswerResult> {
  const all = [...await questions()].sort((a, b) => byCodePoint(a.id, b.id));
  const wanted = args.text === undefined ? [] : words(args.text);
  const matching = all.filter((question) => {
    if (!args.includeAnswered && question.status === 'answered') return false;
    if (wanted.length === 0) return true;
    return score(wanted, [question.title, question.question, question.why, question.about.join(' '), question.answer?.text ?? ''].join('\n')) > 0;
  });
  const shown = matching.slice(0, args.limit);
  return {
    body: {
      text: args.text ?? null,
      includeAnswered: args.includeAnswered,
      questions: shown.map((question) => ({
        id: question.id,
        path: question.file,
        status: question.status,
        type: question.type,
        title: question.title,
        question: question.question,
        why: question.why,
        about: [...question.about].sort(byCodePoint),
        askedIn: question.askedIn,
        answer: question.answer === null ? null : shorten(question.answer.text, SECTION_EXCERPT),
      })),
      total: matching.length,
      held: { open: all.filter((question) => question.status === 'open').length, answered: all.filter((question) => question.status === 'answered').length },
    },
    evidence: shown.map((question) => question.file),
    unresolved: [],
    reads: [],
    truncated: matching.length > shown.length,
  };
}
