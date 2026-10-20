/**
 * The bounded graph reads (decision 0026, "Agents and tools" and "Units and
 * limits"; madarch-tzte.20.3): the six tools an agent unit reads the product
 * graph through — `describe_scope`, `neighbors`, `references`,
 * `claims_about`, `coverage` and `evidence_span` — each a plain function with a
 * typed request and a typed answer, answering from the fill's fact store
 * (`fact-store.ts`, the landed `fill_fact` rows) and, for a span, from the
 * pinned snapshot (`snapshot.ts`, the commit's own bytes).
 *
 * Three things hold for every tool:
 *
 * - **Within the caps.** A tool answer holds at most 8K tokens and an evidence
 *   span about 200 lines (0026). The caps are the unit's own (`limits`, bound
 *   to the unit's server in madarch-tzte.22.2) and the 0026 numbers are their
 *   defaults. Tokens are counted by the fill's own estimate — four code points
 *   a token — because a cap a server enforces must not need a tokeniser of the
 *   model that will read the answer.
 * - **Never silently smaller.** An answer the cap cut says so: `truncated` is
 *   true and `marker` is one sentence naming what was cut and by which cap.
 *   A single row too large for the cap is a whole answer that says it holds
 *   nothing, never an answer that quietly drops it.
 * - **Every read recorded.** A tool answers only through the context it is
 *   given, and the context records each read of the pinned graph as the reading
 *   unit's dependency: the query and the membership of the rows it answered, an
 *   empty answer included (`recordUnitRead`, `orchestrator-store.ts`;
 *   `readMembership` is the digest). A later publication that changes one of
 *   those memberships is exactly what the orchestrator's staleness recheck sees
 *   (`invalidateStaleUnits`), so a unit whose graph moved is replaced instead of
 *   being published on top of what it read. The answer carries the reads it
 *   made (`reads`), in the order it made them.
 *
 * A read of the pinned graph is one value of `GraphRead`: a small grammar of
 * named reads over the fact store, or a span read of the pinned commit's bytes.
 * The recorded query is the canonical JSON of that value, so two reads differ
 * exactly when their request differs (their ids, kinds and windows included) and
 * a read replayed at revalidation is the same read. The reader answers a read
 * request and passes any other text to the store unchanged, so a stage's own SQL
 * keeps working through the same seam (`UnitGraphReader`, `orchestrator.ts`).
 *
 * Nothing here writes the graph: the only row this module ever writes is the
 * unit's own read record.
 */
import { canonicalJsonDigest } from '../model/canonical.js';
import { byCodePoint } from '../model/order.js';
import { ID_PATTERN } from '../model/schema.js';
import type { SqlExecutor } from '../query/sql-driver.js';
import type { FactStoreDatabase } from './fact-store.js';
import {
  COVERAGE_GAP_REASONS,
  FACT_EDGE_KINDS,
  isFactId,
  isFactKind,
  type CoverageGapReason,
  type Fact,
  type FactEdgeKind,
  type FactLayer,
  type FactKind,
  type FactStatus,
} from './facts.js';
import { scopeHolds, scopeText, writeScope } from './checked-writes.js';
import { here, raise, withLocation } from './fsm-core.js';
import { queryDigest, readMembership, recordUnitRead, recordUnitReadIn, withDraftParts } from './orchestrator-store.js';
import type { SnapshotSource } from './snapshot.js';
import type { StageDraftWrite } from './stage.js';

// ---------------------------------------------------------------------------------------------
// The caps
// ---------------------------------------------------------------------------------------------

/**
 * The caps one unit's reads answer within. 0026 fixes the numbers (a tool answer
 * at most 8K tokens, an evidence span about 200 lines) and the unit's MCP server
 * binds them to the unit, so a caller names its own where it has them.
 */
export interface GraphReadLimits {
  /** The most tokens one tool answer holds. */
  readonly answerTokens: number;
  /** The most lines one evidence span holds. */
  readonly spanLines: number;
  /** How many code points the fill's own estimate counts for one token. */
  readonly charactersPerToken: number;
}

/** The caps 0026 fixes: what a unit reads under when its server names none. */
export const DEFAULT_GRAPH_READ_LIMITS: GraphReadLimits = { answerTokens: 8_000, spanLines: 200, charactersPerToken: 4 };

/**
 * The caps a caller left out, filled with 0026's numbers; a cap below one is
 * refused by name. A cap smaller than an answer's own envelope — the request it
 * echoes, the reads it names and the marker it writes — cannot be met and is not
 * refused: the answer holds none of its rows and says so in its marker, and its
 * own `tokens` is then the envelope's size, which is the smallest answer this
 * module can write. Every cap 0026 or a unit's server names is far above it.
 */
export function graphReadLimits(limits: Partial<GraphReadLimits> | undefined, at = here()): GraphReadLimits {
  const resolved = { ...DEFAULT_GRAPH_READ_LIMITS, ...limits };
  if (!Number.isInteger(resolved.answerTokens) || resolved.answerTokens < 1) raise(`${at}: the answer cap is ${resolved.answerTokens}: a tool answer holds at least one token`);
  if (!Number.isInteger(resolved.spanLines) || resolved.spanLines < 1) raise(`${at}: the evidence span cap is ${resolved.spanLines}: an evidence span holds at least one line`);
  if (!Number.isInteger(resolved.charactersPerToken) || resolved.charactersPerToken < 1) raise(`${at}: the estimate counts ${resolved.charactersPerToken} code points for a token: it counts at least one`);
  return resolved;
}

/** How many tokens a text is, by the fill's own estimate: one token for every `charactersPerToken` code points. */
export function estimateTokens(text: string, limits: GraphReadLimits): number {
  return Math.ceil([...text].length / limits.charactersPerToken);
}

// ---------------------------------------------------------------------------------------------
// The reads a tool makes
// ---------------------------------------------------------------------------------------------

/**
 * One read of the pinned graph: what a tool asks for and what is recorded as
 * the reading unit's dependency. The four store reads answer published facts
 * (`fill_fact`); the `drafts` reads answer what other units of the same run hold
 * as draft (`fill_unit_draft`, joined with the plan row that names each holder's
 * scope), each row marked as a draft; `span` answers the bytes of one file at one
 * pinned commit.
 *
 * Every value here is data, never text that reaches SQL: the reader binds each
 * one as a parameter, and the recorded query is the canonical JSON of this
 * value, so a read is remembered by what it asked for and not by what it
 * answered.
 *
 * The four store reads take an optional `product`: the name a fill's runs name the
 * product (`fill_unit.product`), which scopes the read to the facts *that*
 * product's units published. A home's database carries every product's facts, and
 * two products that declare a repository of the same name publish facts of the same
 * content-addressed id — so a reader that answers one product's page asks for its
 * product, and a unit's own reads (a run's graph, which is one product's) leave the
 * field out and are answered as they always were.
 */
export type GraphRead =
  /** One fact by id, whatever kind it is. */
  | { readonly read: 'fact'; readonly id: string; readonly product?: string }
  /** The facts of the given ids, in code point order of the id; an id the graph does not hold is not a row. */
  | { readonly read: 'facts'; readonly ids: readonly string[]; readonly product?: string }
  /** Every edge fact that names the id at one of its ends, in code point order of the edge's id. */
  | { readonly read: 'adjacent'; readonly id: string; readonly kinds?: readonly FactEdgeKind[]; readonly product?: string }
  /** The nodes the given edges of the id point at, counted by their kind: what one scope holds. */
  | { readonly read: 'held'; readonly id: string; readonly via: readonly FactEdgeKind[]; readonly product?: string }
  /** The facts of one kind whose value, at a dotted path, is exactly the given text. */
  | { readonly read: 'facts-with'; readonly kind: FactKind; readonly field: string; readonly value: string; readonly product?: string }
  /**
   * The writes *another* unit of one run holds as draft, each marked as a draft,
   * whose fact is the given id or names it anywhere in its value (0026: a draft
   * is "visible to other units as draft"). `reader` is the reading generation, and
   * its own draft set is never answered: a unit's own writes are its own, and a
   * unit that read its own recorded set would make its own read move the moment it
   * wrote (`fill_unit_draft` is recorded while the attempt runs).
   */
  | { readonly read: 'drafts'; readonly run: string; readonly reader: ReadingUnit; readonly about: string }
  /**
   * The writes *another* unit of one run holds as draft, each marked as a draft,
   * whose cited place stands inside the given scope (`<repository>` or
   * `<repository>:<path>`); a write that cites no place stands in no scope.
   */
  | { readonly read: 'drafts'; readonly run: string; readonly reader: ReadingUnit; readonly in: string }
  /**
   * The lines of one file at one pinned commit, from `startLine` to `endLine`, both counted as a reader
   * counts them. A read that names no commit is answered at the run's own pin of that repository, which
   * is what a recorded span read is replayed as: a unit's cache key holds the bytes it read, never the
   * commit it read them at (decision 0026, "Updates"; `recordedReadText`).
   */
  | { readonly read: 'span'; readonly repository: string; readonly commit?: string; readonly file: string; readonly startLine: number; readonly endLine: number };

/** Every read kind's own name, for a refusal that must name the read it does not know. */
export const GRAPH_READ_KINDS = ['fact', 'facts', 'adjacent', 'held', 'facts-with', 'drafts', 'span'] as const;

/**
 * The tables every store read of this module reads; a failure names them. The
 * `drafts` reads read the orchestrator's own rows as well: a draft set, the plan
 * row that names the scope its holder was planned for, and the publication record
 * that says whether that holder has published (a published set is no draft).
 */
export const GRAPH_READ_TABLES = ['fill_fact', 'fill_fact_holding', 'fill_publication', 'fill_unit', 'fill_unit_draft', 'fill_unit_draft_part', 'fill_unit_plan'] as const;

/** The columns of one fact row, as the store holds them: the reader's own select list. */
const FACT_COLUMNS = 'id, kind, schema_version, provenance, layer, status, value';

/**
 * The text of one read: the canonical JSON of the request, its keys in code
 * point order so the same read is the same text wherever it is built. This is
 * the text a dependency is recorded by (`recordUnitRead`) and the text the
 * reader is given back at revalidation, so a read is replayed exactly.
 */
export function readText(request: GraphRead): string {
  return JSON.stringify(sortKeys(canonicalSets(request)));
}

/**
 * One read with the sets in it ordered and deduplicated: the ids of a `facts`
 * read and the kinds of an `adjacent` or `held` read are sets, so two requests
 * that differ only in how those were written are one read — one query, one
 * recorded dependency, and one membership rechecked at publication.
 */
function canonicalSets(request: GraphRead): GraphRead {
  // The product a read is scoped to is part of what it asks for: a scoped read and an unscoped one are two reads,
  // recorded under two texts and replayed as themselves (a read that lost its scope would answer a wider set).
  const product = 'product' in request && request.product !== undefined ? { product: request.product } : {};
  switch (request.read) {
    case 'facts':
      return { read: 'facts', ids: [...new Set(request.ids)].sort(byCodePoint), ...product };
    case 'adjacent':
      return { read: 'adjacent', id: request.id, ...(request.kinds === undefined ? {} : { kinds: [...new Set(request.kinds)].sort(byCodePoint) }), ...product };
    case 'held':
      return { read: 'held', id: request.id, via: [...new Set(request.via)].sort(byCodePoint), ...product };
    default:
      return request;
  }
}

/** One value with the keys of every object in it in code point order, arrays as they stand. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  const fields = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(fields).sort(byCodePoint)) sorted[key] = sortKeys(fields[key]);
  return sorted;
}

/**
 * The read a text names, or null when the text is no read of this module: a
 * text that does not open a JSON object is another reader's own query (a
 * stage's SQL) and is answered as it stands. A text that opens one and is not a
 * read of this grammar is refused by name, never answered as SQL.
 */
export function parseGraphRead(text: string): GraphRead | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    raise(`the text ${shown(text)} opens a JSON object and does not parse as one, so it is no read of the graph: ${(error as Error).message}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) raise(`the read ${shown(text)} is ${Array.isArray(value) ? 'a list' : typeof value}, not a read: a read names its kind ("fact", "facts", "adjacent", "held", "facts-with", "span") and the values it reads`);
  const fields = value as Record<string, unknown>;
  const kind = fields['read'];
  if (GRAPH_READ_KINDS.includes(kind as (typeof GRAPH_READ_KINDS)[number]) === false) {
    raise(`the read ${shown(text)} names ${shown(kind)}: a read of the graph is one of ${GRAPH_READ_KINDS.join(', ')}`);
  }
  switch (kind as (typeof GRAPH_READ_KINDS)[number]) {
    case 'fact':
      return { read: 'fact', id: readFactId(fields['id'], text), ...productField(fields['product'], text) };
    case 'facts':
      return { read: 'facts', ids: readFactIds(fields['ids'], text), ...productField(fields['product'], text) };
    case 'adjacent':
      return { read: 'adjacent', id: readFactId(fields['id'], text), ...(fields['kinds'] === undefined ? {} : { kinds: readEdgeKinds(fields['kinds'], text) }), ...productField(fields['product'], text) };
    case 'held':
      return { read: 'held', id: readFactId(fields['id'], text), via: readEdgeKinds(fields['via'], text), ...productField(fields['product'], text) };
    case 'facts-with':
      return { read: 'facts-with', kind: readFactKind(fields['kind'], text), field: readPath(fields['field'], text), value: readValueText(fields['value'], text), ...productField(fields['product'], text) };
    case 'drafts': {
      const run = readRun(fields['run'], text);
      const reader = readReader(fields['reader'], text);
      const about = fields['about'];
      const scope = fields['in'];
      if ((about === undefined) === (scope === undefined)) {
        raise(`the read ${shown(text)} names ${about === undefined ? 'no' : 'both'} of "about" and "in": a read of drafts names the fact id its writes name ("about") or the scope they stand in ("in"), never both and never neither`);
      }
      return about === undefined
        ? { read: 'drafts', run, reader, in: readScope(scope, text) }
        : { read: 'drafts', run, reader, about: readFactId(about, text) };
    }
    case 'span':
      // A span names the commit it is read at, or none: none is the run's own pin, which is the form a recorded
      // span read is replayed in (`recordedReadText`), so a unit's cache key stands on its bytes and not on the
      // commit those bytes were read at (decision 0026, "Updates").
      return {
        read: 'span',
        repository: readRepository(fields['repository'], text),
        ...(fields['commit'] === undefined ? {} : { commit: readCommit(fields['commit'], text) }),
        file: readFile(fields['file'], text),
        startLine: readLine(fields['startLine'], 'startLine', text),
        endLine: readLine(fields['endLine'], 'endLine', text),
      };
    default:
      raise(`the read ${shown(text)} is named ${shown(kind)}`);
  }
}

/** The reader's own templates over the store: the text of one read, for a failure to show. */
function shown(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value) ?? String(value);
}

/** The product a read is scoped to, when it names one: a product's own name, as a fill's runs name it. */
function productField(value: unknown, read: string): { readonly product?: string } {
  if (value === undefined) return {};
  if (typeof value !== 'string' || value.trim() === '') raise(`the read ${shown(read)} names the product ${shown(value)}: a product is named by its own name, a non-empty string (the name a fill's runs give it)`);
  return { product: value };
}

/** A read's id: the schema's own form, never a guess. */
function readFactId(value: unknown, read: string): string {
  if (typeof value !== 'string' || !isFactId(value)) raise(`the read ${shown(read)} names ${shown(value)}: a fact id is the kind, a colon, and the 64 lower-case hexadecimal digits of the fact's identity (src/fill/facts.ts)`);
  return value;
}

/** A read's ids: distinct, in code point order, each one a fact id. */
function readFactIds(value: unknown, read: string): readonly string[] {
  if (!Array.isArray(value)) raise(`the read ${shown(read)} names ${shown(value)}: the ids of a read are a list of fact ids`);
  const ids = new Set<string>();
  for (const entry of value) ids.add(readFactId(entry, read));
  return [...ids].sort(byCodePoint);
}

/** A read's edge kinds: distinct, in code point order, each one an edge kind of the schema. */
function readEdgeKinds(value: unknown, read: string): readonly FactEdgeKind[] {
  if (!Array.isArray(value)) raise(`the read ${shown(read)} names ${shown(value)}: the kinds of a read are a list of edge kinds`);
  const kinds = new Set<FactEdgeKind>();
  for (const entry of value) {
    if (typeof entry !== 'string' || (FACT_EDGE_KINDS as readonly string[]).includes(entry) === false) {
      raise(`the read ${shown(read)} names the kind ${shown(entry)}: an edge kind is one of ${FACT_EDGE_KINDS.join(', ')}`);
    }
    kinds.add(entry as FactEdgeKind);
  }
  return [...kinds].sort(byCodePoint);
}

/** A read's fact kind: one kind of the schema. */
function readFactKind(value: unknown, read: string): FactKind {
  if (typeof value !== 'string' || !isFactKind(value)) raise(`the read ${shown(read)} names the kind ${shown(value)}: a fact kind is one of the schema's kinds (src/fill/facts.ts)`);
  return value;
}

/** A read's field path: dotted names, at most three deep, never empty and never a path that reads nothing. */
function readPath(value: unknown, read: string): string {
  const tokens = typeof value === 'string' ? value.split('.') : [];
  if (tokens.length === 0 || tokens.length > 3 || tokens.some((token) => /^[A-Za-z][A-Za-z0-9_]*$/.test(token) === false)) {
    raise(`the read ${shown(read)} reads the field ${shown(value)}: a field is one to three dotted names, like "subject.id"`);
  }
  return tokens.join('.');
}

/** A read's repository: the product's own name for it. */
function readRepository(value: unknown, read: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) raise(`the read ${shown(read)} names the repository ${shown(value)}: the product's own name for a repository, like "orders-api", never a path, a URL or a branch`);
  return value;
}

/** A read's commit: 40 lower-case hexadecimal digits, as the schema writes one. */
function readCommit(value: unknown, read: string): string {
  if (typeof value !== 'string' || /^[0-9a-f]{40}$/.test(value) === false) raise(`the read ${shown(read)} pins the commit ${shown(value)}: a pinned commit is 40 lower-case hexadecimal digits`);
  return value;
}

/** A read's file: a repository path, relative, `/`-separated, with no leg that climbs out. */
function readFile(value: unknown, read: string): string {
  if (typeof value !== 'string' || value === '' || value.startsWith('/') || value.endsWith('/') || /(^|\/)\.\.?(\/|$)/.test(value) || /^[A-Za-z]:/.test(value)) {
    raise(`the read ${shown(read)} names the file ${shown(value)}: a repository path is relative, separated by "/", from the repository's root, like "src/fill/facts.ts"`);
  }
  return value;
}

/** A read's own text value: the exact text a read filters by, never empty. */
function readValueText(value: unknown, read: string): string {
  if (typeof value !== 'string' || value === '') raise(`the read ${shown(read)} filters by ${shown(value)}: the value a read filters by is a non-empty text`);
  return value;
}

/** A read's run: the run whose units' drafts are read, a non-empty text with no line break in it. */
function readRun(value: unknown, read: string): string {
  if (typeof value !== 'string' || value.trim() === '' || /[\n\r]/.test(value)) {
    raise(`the read ${shown(read)} names the run ${shown(value)}: the run whose units hold the drafts is a non-empty text, like "run-2026-10-18T21:00Z"`);
  }
  return value;
}

/** A read's reader: the unit generation the read is made for, whose own draft set is never answered. */
function readReader(value: unknown, read: string): ReadingUnit {
  const held = (value ?? {}) as Record<string, unknown>;
  const unitId = held['unitId'];
  const generation = held['generation'];
  if (typeof unitId !== 'string' || unitId === '') {
    raise(`the read ${shown(read)} names the reader ${shown(unitId)}: a read of drafts names the unit generation it is made for, as { unitId, generation }`);
  }
  if (typeof generation !== 'number' || Number.isInteger(generation) === false || generation < 1) {
    raise(`the read ${shown(read)} names the reader of ${unitId} at generation ${shown(generation)}: a generation is a whole number, one or more`);
  }
  return { unitId, generation };
}

/** A read's scope: a unit's own scope text, `<repository>` or `<repository>:<path>`, as the write path reads one. */
function readScope(value: unknown, read: string): string {
  try {
    return scopeText(writeScope(value as string));
  } catch (error) {
    raise(`the read ${shown(read)} names the scope ${shown(value)}: ${(error as Error).message}`);
  }
}

/** A read's line: a whole number, one or more. */
function readLine(value: unknown, field: string, read: string): number {
  if (typeof value !== 'number' || Number.isInteger(value) === false || value < 1) raise(`the read ${shown(read)} names ${field} ${shown(value)}: a line is a whole number, one or more, as a reader counts lines`);
  return value;
}

/** One read as text, for a refusal that names what was asked. */
function describedRead(request: GraphRead): string {
  return readText(request);
}

// ---------------------------------------------------------------------------------------------
// Which value field of an edge names which end
// ---------------------------------------------------------------------------------------------

/** The two ends of an edge, as the edge's own value holds them: the field names, and whether an end is a term. */
interface EdgeEndFields {
  /** The value field naming the edge's from end (its subject), or null when that end is no node of the graph. */
  readonly from: string | null;
  /** The value field naming the edge's to end (its object), or null when that end is no node of the graph. */
  readonly to: string | null;
  /** True where the to end is a term (`{ form: 'node', id }`) rather than the id itself. */
  readonly toTerm?: boolean;
}

/**
 * How each edge kind's own value names its two ends. The store is a table of
 * facts and an edge's ends stand inside its value, so a reader of the graph needs
 * this table: it is what `adjacent` asks the store for, what the tools read the
 * ends out of, and what `held` joins on.
 *
 * Three kinds name an end that is no fact id, and they are named exactly:
 * `provides` ends at an api-endpoint through its contract id — a node of the
 * graph, but not named by the id the store joins; `binds` ends at an environment's
 * name; and `task-key` at the tracker's own key. `document-link` ends at a term,
 * which may name a node or an address outside the repositories, so the field is
 * read as a term rather than as an id (`toTerm`).
 */
export const EDGE_END_FIELDS: { readonly [K in FactEdgeKind]: EdgeEndFields } = {
  'contains': { from: 'from', to: 'to' },
  'defines': { from: 'from', to: 'to' },
  'import': { from: 'from', to: 'to' },
  'dependency': { from: 'from', to: 'to' },
  'call': { from: 'from', to: 'to' },
  'reference': { from: 'from', to: 'to' },
  'inherits': { from: 'from', to: 'to' },
  'provides': { from: 'from', to: null },
  'consumes': { from: 'from', to: 'variable' },
  'binds': { from: 'variable', to: null },
  'resolves': { from: 'from', to: 'to' },
  'document-link': { from: 'from', to: 'to', toTerm: true },
  'task-key': { from: 'from', to: null },
  'transition': { from: 'from', to: 'to' },
  'interaction': { from: 'caller', to: 'callee' },
};

/** The two ends of one edge fact's value, as the ids the graph holds: an end that is no node is left out. */
export function endsOf(kind: FactEdgeKind, value: unknown): { readonly from?: string; readonly to?: string } {
  const fields = EDGE_END_FIELDS[kind];
  const held = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const from = fields.from === null ? undefined : idAt(held[fields.from]);
  const to = fields.to === null ? undefined : (fields.toTerm === true ? idOfTerm(held[fields.to]) : idAt(held[fields.to]));
  return { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) };
}

/** One value as a fact id, or undefined when it is no id. */
function idAt(value: unknown): string | undefined {
  return typeof value === 'string' && isFactId(value) ? value : undefined;
}

/** One value as a term naming a node, or undefined when it names something else. */
function idOfTerm(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const term = value as { readonly form?: unknown; readonly id?: unknown };
  return term.form === 'node' ? idAt(term.id) : undefined;
}

/**
 * The kinds a scope of `describe_scope` may be: the node kinds a unit's scope is
 * named by (0026's product to repository to package/build target to cluster to
 * sub-cluster walk), and the snapshot of one commit, which is the scope a reading
 * of the graph names itself by — stage 5's coverage of a repository is one per
 * commit, so a reader asks for it with the commit's snapshot id
 * (madarch-tzte.21.7). A read named by any other fact id is refused rather than
 * answered with empty lists, which would read as a scope that holds nothing.
 */
export const SCOPE_KINDS: readonly FactKind[] = ['directory', 'file', 'module', 'package', 'repository'];

/**
 * The edge kinds that mean "this node names or uses that node", which is what
 * `references` answers: `contains` and `defines` place a node rather than citing
 * it, and `provides`, `binds` and `task-key` end at a contract, a name and a key.
 */
export const REFERENCE_EDGE_KINDS: readonly FactEdgeKind[] = ['call', 'consumes', 'dependency', 'document-link', 'import', 'inherits', 'interaction', 'reference', 'resolves', 'transition'];

/**
 * The edge kinds whose to end is a node named by its fact id — wherever the edge's
 * own value keeps that id (`to`, `variable`, `callee`) — which is what a count of
 * a scope's members joins on. `provides`, `binds`, `task-key` and `document-link`
 * are not among them: their to end is a contract id, a name, a key and a term.
 */
export const HOLDING_EDGE_KINDS: readonly FactEdgeKind[] = FACT_EDGE_KINDS
  .filter((kind) => EDGE_END_FIELDS[kind].to !== null && EDGE_END_FIELDS[kind].toTerm !== true)
  .sort(byCodePoint);

/** Why one edge kind's to end is no fact id, for a refusal that must name it. */
function whyNotHeld(kind: FactEdgeKind): string {
  switch (kind) {
    case 'provides':
      return "the api-endpoint's contract id, which is the endpoint's own identity and not the fact id this read joins";
    case 'binds':
      return "the environment's name, not a node of the graph";
    case 'task-key':
      return "the tracker's key, not a node of the graph";
    case 'document-link':
      return 'a term, which may name a node of the graph or an address outside the repositories';
    default:
      return 'no node of the graph';
  }
}

/** The edge kinds that place a node inside another: what a scope holds, and never a neighbourhood. */
export const STRUCTURE_EDGE_KINDS: readonly FactEdgeKind[] = ['contains', 'defines'];

/**
 * The edge kinds `neighbors` answers when the caller names none: every edge kind
 * but the two that place a node (`contains`, `defines`). A symbol's three callers
 * are then its three neighbours and nothing else stands between the reader and
 * them, while what a node sits in is what `describe_scope` answers. A caller that
 * means the placement too asks for those kinds by name, and the answer's own
 * `kinds` always says which kinds it answered.
 */
export const NEIGHBOR_EDGE_KINDS: readonly FactEdgeKind[] = FACT_EDGE_KINDS
  .filter((kind) => (STRUCTURE_EDGE_KINDS as readonly string[]).includes(kind) === false)
  .sort(byCodePoint);

// ---------------------------------------------------------------------------------------------
// The reader over the fact store
// ---------------------------------------------------------------------------------------------

/**
 * Where an evidence span's bytes come from: the run's pinned repositories, which
 * is the landed `SnapshotSource` (`snapshot.ts`) with the one operation a span
 * reads — `open`, which holds its readers, so a span costs no second listing of a
 * tree. Its `pins()` is not needed here: a span names the repository and the
 * commit it reads, and `open` refuses a repository this run does not pin.
 */
export type GraphSnapshotSource = Pick<SnapshotSource, 'open'>;

/** What a graph read answers from: the process's one database and the run's pinned snapshot. */
export interface FactGraphReaderOptions {
  readonly database: FactStoreDatabase;
  readonly snapshot: GraphSnapshotSource;
  /**
   * A transaction the caller already opened: the process's owner refuses a
   * second transaction on its connection, so a read made inside one (a
   * publication's recheck) is made on it. Recording a read writes the
   * orchestrator's row, so a context lent an executor must be lent one a write
   * is allowed in (`SqlTransactionKind`), which is what a publication holds.
   */
  readonly executor?: SqlExecutor;
}

/**
 * The reader the orchestrator's own seam takes (`UnitGraphReader.query`): it
 * answers a read of this module's grammar — the canonical JSON of a `GraphRead`
 * — and passes any other text to the store unchanged, so a stage's own SQL query
 * is answered as it stands.
 */
export function createFactGraphReader(options: FactGraphReaderOptions): { query(text: string): Promise<readonly unknown[]> } {
  return {
    async query(text: string): Promise<readonly unknown[]> {
      const request = parseGraphRead(text);
      if (request === null) return await inTransaction(options, async (executor) => (await executor.query(text)).rows);
      return await answerGraphRead(options, request);
    },
  };
}

/** Runs one read inside the caller's transaction, or inside one of the owner's own. */
async function inTransaction<R>(options: FactGraphReaderOptions, work: (executor: SqlExecutor) => Promise<R>): Promise<R> {
  const lent = options.executor;
  if (lent !== undefined) return await work(lent);
  return await options.database.transaction('snapshot', async (executor) => await work(executor));
}

/**
 * A read the graph cannot answer as it was asked because nothing stands there any more: the file a span cites is
 * gone, or shorter than the span's first line. It is the one failure of a read that a recheck reads as the read
 * having moved (madarch-tzte.26.1): every other failure of a reader — a store error, a statement a stage wrote
 * wrong — is a failure of the run, never a movement of the graph.
 */
export class GraphReadRefusal extends Error {}

/** The row a span read answers: one file's lines at one pinned commit, with the file's own line count. */
export interface SpanRow {
  readonly repository: string;
  readonly commit: string;
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  /** How many lines the file has at that commit, counted as a reader counts them. */
  readonly totalLines: number;
  readonly lines: readonly { readonly line: number; readonly text: string }[];
}

/**
 * The clause that scopes one store read to a product, and the value it binds: the
 * facts one of that product's units published (`fill_fact_holding` joined onto
 * `fill_unit.product`). A read that names no product is answered from the whole
 * store, which is what a unit's own graph is — one run's product — and what every
 * read before this field existed was.
 */
function productScope(product: string | undefined, parameter: number): { readonly sql: string; readonly values: readonly string[] } {
  if (product === undefined) return { sql: '', values: [] };
  if (product.trim() === '') raise(`${here()}: a read of the store names the product "" to scope its facts: a product is named by the name its runs give it (src/fill/orchestrator-host.ts)`);
  return {
    sql: ` AND EXISTS (SELECT 1 FROM fill_fact_holding h JOIN fill_unit u ON u.unit_id = h.unit_id WHERE h.id = f.id AND u.product = $${parameter})`,
    values: [product],
  };
}

/**
 * One read of the pinned graph, answered: the same request answers the same rows
 * as long as the graph stands, which is what makes a read a dependency.
 */
export async function answerGraphRead(options: FactGraphReaderOptions, request: GraphRead): Promise<readonly unknown[]> {
  const at = here();
  return await withLocation(at, `answerGraphRead(${describedRead(request)})`, GRAPH_READ_TABLES, async () => {
    switch (request.read) {
      case 'fact': {
        const scope = productScope(request.product, 2);
        const rows = await inTransaction(options, async (executor) => (await executor.query(`SELECT ${FACT_COLUMNS} FROM fill_fact f WHERE f.id = $1${scope.sql}`, [request.id, ...scope.values])).rows);
        return rows;
      }
      case 'facts': {
        if (request.ids.length === 0) return [];
        const scope = productScope(request.product, 2);
        const rows = await inTransaction(options, async (executor) => (await executor.query(`SELECT ${FACT_COLUMNS} FROM fill_fact f WHERE f.id = ANY($1::text[])${scope.sql}`, [request.ids, ...scope.values])).rows);
        return byId(rows);
      }
      case 'adjacent': {
        const kinds = request.kinds ?? FACT_EDGE_KINDS;
        if (kinds.length === 0) raise(`${at}: the read ${describedRead(request)} names no edge kind: a read of edges answers the kinds it is given`);
        const groups = adjacencyGroups(kinds);
        // Each group asks for its own field's end by containment, which the store's index of an edge fact's value
        // answers (`fill_fact_edge_values`); the id is bound as the JSON the field must hold, so a term end
        // (`{"to": {"id": …}}`) and a plain one (`{"to": …}`) are the same kind of question.
        const clause = groups.map((group, index) => `(kind = ANY($${index + 2}::text[]) AND value @> $${groups.length + 2 + index}::jsonb)`).join(' OR ');
        const scope = productScope(request.product, groups.length * 2 + 2);
        const values: unknown[] = [kinds, ...groups.map((group) => group.kinds), ...groups.map((group) => endContainedIn(group, request.id)), ...scope.values];
        const rows = await inTransaction(options, async (executor) => (await executor.query(`SELECT ${FACT_COLUMNS} FROM fill_fact f WHERE f.kind = ANY($1::text[]) AND (${clause})${scope.sql}`, values)).rows);
        return byId(rows);
      }
      case 'held': {
        if (request.via.length === 0) raise(`${at}: the read ${describedRead(request)} names no edge kind: a read of what a scope holds counts the edges of the kinds it is given`);
        const scope = productScope(request.product, 0);
        for (const kind of request.via) {
          // The count joins the store's own rows on the ends the edge value carries as a fact id, wherever the
          // kind keeps them (`to`, `variable`, `callee`), so a kind whose to end is no id cannot be counted:
          // a read that asked for one would answer nothing rather than be counted, and that silence is what
          // this refusal is for.
          if (HOLDING_EDGE_KINDS.includes(kind) === false) {
            raise(`${at}: the read ${describedRead(request)} counts what the edges of "${kind}" hold, and a "${kind}" edge's to end is ${whyNotHeld(kind)}: the kinds whose to end this read joins by fact id are ${HOLDING_EDGE_KINDS.join(', ')}`);
          }
        }
        // One statement, its joins built from the same end table `adjacent` reads: a kind that keeps its to
        // end in another field of its value (`consumes` in `variable`, `interaction` in `callee`) and a kind
        // that keeps its from end elsewhere (`interaction` in `caller`) are joined where they keep it.
        // The parameters start after the kinds and the id (`$1`, `$2`): the first group of the to end is `$3`.
        const toEnd = endJoin('value->>\'to\'', request.via, 3);
        const fromEnd = endJoin('value->>\'from\'', request.via, 3 + toEnd.values.length);
        // The edges counted are the ones this product's units published, when the read names a product: a scope's
        // contents are that product's graph, never a home's.
        const edgeScope = request.product === undefined ? '' : ` AND EXISTS (SELECT 1 FROM fill_fact_holding h JOIN fill_unit u ON u.unit_id = h.unit_id WHERE h.id = e.id AND u.product = $${3 + toEnd.values.length + fromEnd.values.length})`;
        const rows = await inTransaction(options, async (executor) => (await executor.query(
          `SELECT n.kind AS kind, count(*)::int AS count FROM fill_fact e JOIN fill_fact n ON n.id = ${toEnd.sql} WHERE e.kind = ANY($1::text[]) AND ${fromEnd.sql} = $2${edgeScope} GROUP BY n.kind`,
          [request.via, request.id, ...toEnd.values, ...fromEnd.values, ...scope.values.length === 0 ? [] : [request.product]],
        )).rows);
        // The order is read here and not left to the query: a database orders text by its own collation
        // (PostgreSQL's is `en_US.UTF-8` in CI, where `Unit-a` sorts before `unit-a`), and a read of this
        // fill answers code point order whatever the engine's locale is.
        return [...rows].sort((left, right) => byCodePoint(String((left as Record<string, unknown>)['kind']), String((right as Record<string, unknown>)['kind'])));
      }
      case 'facts-with': {
        const scope = productScope(request.product, 4);
        const rows = await inTransaction(options, async (executor) => (await executor.query(
          `SELECT ${FACT_COLUMNS} FROM fill_fact f WHERE f.kind = $1 AND f.value #>> $2::text[] = $3${scope.sql}`,
          [request.kind, request.field.split('.'), request.value, ...scope.values],
        )).rows);
        return byId(rows);
      }
      case 'drafts': {
        // One row per draft set of the run, with the plan row that names the scope its holder was
        // planned for. Three sets are no drafts of this read: a retracted one (0027's retry), a
        // published one (its facts stand in `fill_fact`, and nothing keeps its set as a draft), and the
        // reading unit's own (0026 makes a draft visible to *other* units, and a unit that read its own
        // recorded set would move its own read the moment it wrote). The writes are then filtered here,
        // so what the read answers — and what its membership digest covers — is exactly the drafts that
        // bear on the question asked.
        const rows = await inTransaction(options, async (executor) => await withDraftParts(executor, (await executor.query<DraftSetRow>(
          `SELECT d.unit_id, d.generation, d.writes, p.scope
             FROM fill_unit_draft d JOIN fill_unit_plan p ON p.unit_id = d.unit_id AND p.generation = d.generation
            WHERE p.run_id = $1 AND d.retracted_at IS NULL
              AND NOT (d.unit_id = $2 AND d.generation = $3)
              AND NOT EXISTS (SELECT 1 FROM fill_publication f WHERE f.unit_id = d.unit_id AND f.generation = d.generation)`,
          [request.run, request.reader.unitId, request.reader.generation],
        )).rows));
        return draftRowsOf(rows, request, at);
      }
      case 'span': {
        return [await spanRow(options, request, at)];
      }
    }
  });
}

/** The rows of a read of facts, in code point order of the ids they carry. */
function byId(rows: readonly Record<string, unknown>[]): readonly Record<string, unknown>[] {
  return [...rows].sort((left, right) => byCodePoint(String(left['id']), String(right['id'])));
}

/**
 * The expression that reads one end of the edges of the given kinds, wherever each
 * kind of the table keeps it: the plain field of the end (`value->>'to'`,
 * `value->>'from'`) for the kinds that name it there, and one parameter per kind
 * group it does not (`consumes`'s `variable`, `interaction`'s `caller` and
 * `callee`). The values are the kind groups, in the order they are read.
 */
function endJoin(plain: string, kinds: readonly FactEdgeKind[], firstParameter: number): { readonly sql: string; readonly values: readonly (readonly FactEdgeKind[])[] } {
  const side = plain.endsWith("'from'") ? 'from' : 'to';
  const grouped = new Map<string, FactEdgeKind[]>();
  for (const kind of kinds) {
    const field = EDGE_END_FIELDS[kind][side];
    if (field === null) continue;
    const expression = `value->>'${field}'`;
    if (expression === plain) continue;
    const held = grouped.get(expression) ?? [];
    held.push(kind);
    grouped.set(expression, held);
  }
  const groups = [...grouped.entries()].map(([expression, group]) => ({ expression, kinds: [...new Set(group)].sort(byCodePoint) })).sort((left, right) => byCodePoint(left.expression, right.expression));
  const values = groups.map((group) => group.kinds);
  const clauses = groups.map((group, index) => `WHEN e.kind = ANY($${firstParameter + index}::text[]) THEN e.${group.expression}`);
  return { sql: clauses.length === 0 ? `e.${plain}` : `CASE ${clauses.join(' ')} ELSE e.${plain} END`, values };
}

/**
 * How the ends of the given edge kinds stand in the store: one group per field an end is
 * kept in, with the kinds whose ends are read out of that field — and whether the field
 * holds a term (a document link's `to`) rather than the fact id itself.
 *
 * The groups are what a read of one node's edges asks with, and the question they ask is
 * a containment question (`value @> {"to": …}`) rather than a text comparison of one
 * field (`value->>'to' = …`): the store indexes the value of an edge fact once
 * (`fill_fact_edge_values`, `fact-store.ts`), and a containment is the form that index
 * answers. madarch-tzte.23.8 measured a node's page reading every edge fact of the
 * product to find its own, which is what the containment form and its index replace.
 */
interface AdjacencyGroup {
  readonly kinds: readonly FactEdgeKind[];
  /** The field the end is kept in (`from`, `to`, `variable`, `caller`, `callee`). */
  readonly field: string;
  /** Whether the field holds a term naming a node (`{form, id}`), as a document link's `to` does. */
  readonly toTerm: boolean;
}

function adjacencyGroups(kinds: readonly FactEdgeKind[]): readonly AdjacencyGroup[] {
  // Grouped by the field *and* by the shape it holds: `to` is a fact id for fourteen kinds and a term for a document
  // link (`EDGE_END_FIELDS`, `toTerm`), so one group per field would ask a document link's end the plain way and never
  // find it (madarch-tzte.23.8's review, D1).
  const byField = new Map<string, { field: string; kinds: FactEdgeKind[]; toTerm: boolean }>();
  const key = (field: string, toTerm: boolean): string => `${toTerm ? 'term' : 'id'}\u0000${field}`;
  const add = (field: string, toTerm: boolean, kind: FactEdgeKind): void => {
    const held = byField.get(key(field, toTerm)) ?? { field, kinds: [], toTerm };
    held.kinds.push(kind);
    byField.set(key(field, toTerm), held);
  };
  for (const kind of kinds) {
    const fields = EDGE_END_FIELDS[kind];
    if (fields.from !== null) add(fields.from, false, kind);
    if (fields.to !== null) add(fields.to, fields.toTerm === true, kind);
  }
  return [...byField.entries()]
    .map(([, group]) => ({ field: group.field, toTerm: group.toTerm, kinds: [...new Set(group.kinds)].sort(byCodePoint) }))
    .sort((left, right) => byCodePoint(left.field, right.field) || Number(left.toTerm) - Number(right.toTerm));
}

/** The value an edge fact's end is contained in, as the read asks the store for it: the id, or the term naming it. */
function endContainedIn(group: AdjacencyGroup, id: string): string {
  return JSON.stringify(group.toTerm ? { [group.field]: { id } } : { [group.field]: id });
}

/** One file's lines at one pinned commit: the commit's own bytes, split as a reader counts lines. */
async function spanRow(options: FactGraphReaderOptions, request: Extract<GraphRead, { read: 'span' }>, at: string): Promise<SpanRow> {
  if (request.endLine < request.startLine) raise(`${at}: the read ${describedRead(request)} asks for the lines ${request.startLine} to ${request.endLine} of ${request.file}: a span starts at a line and ends at that line or a later one`);
  const reader = await options.snapshot.open(request.repository);
  if (request.commit !== undefined && reader.commit !== request.commit) {
    raise(`${at}: the read ${describedRead(request)} pins ${request.file} at ${request.commit}, and the repository "${request.repository}" is pinned at ${reader.commit}: an evidence span is read at the commit of the run's pin`);
  }
  // A read that named no commit asks for the run's own pin (`GraphRead`'s span), which is the form a recorded
  // span read is replayed in: a unit's cache key holds the bytes it read, never the commit they were read at.
  const commit = request.commit ?? reader.commit;
  const lines = linesOf(await reader.readText(request.file));
  if (request.startLine > lines.length) {
    throw new GraphReadRefusal(`${at}: the read ${describedRead(request)} asks for line ${request.startLine} of ${request.file} at ${commit} in the repository "${request.repository}", and that file has ${lines.length} ${lines.length === 1 ? 'line' : 'lines'}: a span cites lines the file holds (the path read here is ${request.file})`);
  }
  const end = Math.min(request.endLine, lines.length);
  const held: { line: number; text: string }[] = [];
  for (let line = request.startLine; line <= end; line += 1) held.push({ line, text: lines[line - 1] ?? '' });
  return { repository: request.repository, commit, file: request.file, startLine: request.startLine, endLine: end, totalLines: lines.length, lines: held };
}

/**
 * The membership a span read's answer stands under: the bytes it read — the
 * repository, the file, the lines and their text — and never the commit those
 * bytes were read at (decision 0026, "Updates"). A unit's cache key holds "the
 * spans it read"; a commit that leaves the bytes of a span as they were is no
 * change to a unit that read them, and a membership that carried the commit
 * would call every span read of every unit moved on every commit.
 */
export function spanMembership(rows: readonly unknown[]): string {
  const row = rows.length === 1 ? rows[0] : undefined;
  if (row === null || typeof row !== 'object' || Array.isArray(row)) raise(`${here()}: a span read answered ${rows.length} ${rows.length === 1 ? 'row' : 'rows'} and its first is no span: a span read answers the one span row of the lines it read`);
  const fields = row as Record<string, unknown>;
  const { repository, file, startLine, endLine, lines } = fields;
  if (typeof repository !== 'string' || typeof file !== 'string' || typeof startLine !== 'number' || typeof endLine !== 'number' || !Array.isArray(lines)) {
    raise(`${here()}: a span read answered ${JSON.stringify(row)}, which is no span row: a span row names the repository, the file, the first and the last line and the lines it holds`);
  }
  return canonicalJsonDigest({ repository, file, startLine, endLine, lines });
}

/**
 * The text one read is recorded under, as the dependency a recheck replays: a span
 * read is recorded by its place in the run's pins — the repository, the file and the
 * lines — and never by the commit it was read at, so a recheck at the run's next pin
 * compares bytes with bytes (`spanMembership`). Every other read is recorded as the
 * canonical text it asked for, which is the text the reader is given back.
 */
export function recordedReadText(text: string): string {
  const request = readOf(text);
  if (request === null) return text;
  if (request.read !== 'span') return readText(request);
  return readText({ read: 'span', repository: request.repository, file: request.file, startLine: request.startLine, endLine: request.endLine });
}

/**
 * The read one text names, or null where it is no read of this grammar: a stage's own named read
 * (`src/fill/stage-reads.ts`) and its own SQL are answered by other readers, and a text this module does
 * not know is recorded as it stands rather than refused by a recorder that was only asking what it was.
 */
function readOf(text: string): GraphRead | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const kind = (value as Record<string, unknown>)['read'];
  if ((GRAPH_READ_KINDS as readonly unknown[]).includes(kind) === false) return null;
  return parseGraphRead(text);
}

/**
 * The membership one read's answer stands under: a span's bytes (`spanMembership`),
 * every other read's rows (`readMembership`, the digest of the rows in a canonical
 * order, an empty answer included). Recording and rechecking both take it here, so a
 * read is compared with itself and never with a second reading of what it answered.
 */
export function answerMembership(text: string, rows: readonly unknown[]): string {
  const request = readOf(text);
  if (request !== null && request.read === 'span') return spanMembership(rows);
  return readMembership(rows);
}

/**
 * The lines of a text, counted as a reader counts them: one per newline, and a
 * file that ends with a newline has no empty line after it. The bytes are kept
 * as they stand (a `\r` of a CRLF file stands in the line), because a span is
 * evidence of the commit's own bytes.
 */
export function linesOf(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Recording a read as the reading unit's dependency
// ---------------------------------------------------------------------------------------------

/** The reading unit a read is recorded for: the dependency belongs to this generation. */
export interface ReadingUnit {
  readonly unitId: string;
  readonly generation: number;
}

/**
 * What a tool reads through: the pinned graph, with every read recorded as the
 * reading unit's dependency. A tool answers only through this, so "every read is
 * recorded" holds by construction rather than by each tool remembering it.
 */
export interface GraphReadContext {
  /** Answers one read of the pinned graph and records it as the reading unit's dependency: its query and its membership, an empty answer included. */
  read(request: GraphRead): Promise<readonly unknown[]>;
  /** The caps this unit reads under. */
  readonly limits: GraphReadLimits;
  /** The run whose units' draft sets this unit sees beside the published facts; absent, it reads published facts only. */
  readonly drafts?: DraftReading;
}

/** What the context a unit reads through is built from. */
export interface FactGraphReadsOptions extends FactGraphReaderOptions {
  readonly unit: ReadingUnit;
  readonly limits?: Partial<GraphReadLimits>;
  /** The run whose units' draft sets this unit sees beside the published facts; absent, it reads published facts only. */
  readonly drafts?: DraftReading;
  /** Supplies the recorded time; the real clock unless a test passes its own. */
  readonly clock?: () => number;
}

/**
 * The context one unit reads through: the run's pinned graph and snapshot, with
 * every read written as that generation's tracked read (`recordUnitRead`,
 * `orchestrator-store.ts`). The read record is the query and the membership of
 * the rows it answered — an empty answer is a membership of its own, so a read
 * that answered nothing and answers a row later moves, which is what decision
 * 0027's staleness recheck is for.
 */
export function createGraphReadContext(options: FactGraphReadsOptions): GraphReadContext {
  const at = here();
  const limits = graphReadLimits(options.limits, at);
  const unit = options.unit;
  if (typeof unit.unitId !== 'string' || unit.unitId === '') raise(`${at}: the reading unit is named ${shown(unit.unitId)}: a read belongs to a unit of a stage, and every tracked read names it`);
  if (Number.isInteger(unit.generation) === false || unit.generation < 1) raise(`${at}: the reading unit "${unit.unitId}" is at generation ${shown(unit.generation)}: a generation is a whole number, one or more`);
  return {
    limits,
    ...(options.drafts === undefined ? {} : { drafts: options.drafts }),
    async read(request: GraphRead): Promise<readonly unknown[]> {
      const rows = await answerGraphRead(options, request);
      const text = readText(request);
      const record = { unitId: unit.unitId, generation: unit.generation, query: recordedReadText(text), rows, membership: answerMembership(text, rows), at: (options.clock ?? Date.now)() };
      if (options.executor !== undefined) await recordUnitReadIn(options.executor, record);
      else await recordUnitRead(options.database, record);
      return rows;
    },
  };
}

/**
 * The context a reader that takes text answers through — a stage's own graph
 * reader (`StageGraphReader.query`, the orchestrator's `context.graph`), which
 * records every read it is asked for and replays it at publication. The tools
 * then read through the reader the orchestrator already tracks, so a unit that
 * calls them needs no second way of recording what it read.
 */
export function graphReadsOver(reader: { query(text: string): Promise<readonly unknown[]> }, limits?: Partial<GraphReadLimits>, drafts?: DraftReading): GraphReadContext {
  return {
    limits: graphReadLimits(limits, here()),
    ...(drafts === undefined ? {} : { drafts }),
    async read(request: GraphRead): Promise<readonly unknown[]> {
      return await reader.query(readText(request));
    },
  };
}

/** The reads one tool makes, in the order it makes them: each one is recorded as the unit's dependency. */
function traced(context: GraphReadContext): { readonly read: (request: GraphRead) => Promise<readonly unknown[]>; readonly made: GraphRead[] } {
  const made: GraphRead[] = [];
  return {
    made,
    read: async (request: GraphRead): Promise<readonly unknown[]> => {
      made.push(request);
      return await context.read(request);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The facts a read answered
// ---------------------------------------------------------------------------------------------

/** Every layer a fact may be read at (0005). */
const FACT_LAYERS = ['declared', 'extracted', 'inferred', 'observed'] as const;
/** Every status a fact may stand in (0005). */
const FACT_STATUSES = ['proposed', 'accepted', 'rejected'] as const;

/**
 * One row of the store as a fact, refused by name where it is not one: a row is
 * a fact of the schema or the store is damaged, and a reader that silently
 * skipped it would answer a smaller graph than the one that stands. A draft write
 * carries the same fact spelled the schema's own way and with its version as
 * `schemaVersion` (`src/fill/checked-writes.ts`), so a draft row is read through
 * `draftFactOfRow`, which spells the version the store's way and then judges it by
 * these same rules.
 */
export function factOfRow(row: unknown, read: GraphRead): Fact {
  const where = `the row ${shown(row)} of the read ${describedRead(read)}`;
  if (row === null || typeof row !== 'object' || Array.isArray(row)) raise(`${where} is no fact row: a fact row is a record of id, kind, schema_version, provenance, layer, status and value`);
  const fields = row as Record<string, unknown>;
  const id = fields['id'];
  if (typeof id !== 'string' || !isFactId(id)) raise(`${where} names the id ${shown(id)}: a fact id is the kind, a colon, and the 64 lower-case hexadecimal digits of the fact's identity`);
  const kind = fields['kind'];
  if (typeof kind !== 'string' || !isFactKind(kind)) raise(`${where} names the kind ${shown(kind)}: a fact kind is one of the schema's kinds (src/fill/facts.ts)`);
  const schemaVersion = fields['schema_version'];
  if ((typeof schemaVersion !== 'number' && typeof schemaVersion !== 'string') || !Number.isInteger(Number(schemaVersion))) {
    raise(`${where} carries the schema version ${shown(schemaVersion)}: a kind's version is a whole number`);
  }
  const layer = fields['layer'];
  if (typeof layer !== 'string' || (FACT_LAYERS as readonly string[]).includes(layer) === false) raise(`${where} is read at the layer ${shown(layer)}: a fact's layer is one of ${FACT_LAYERS.join(', ')}`);
  const status = fields['status'];
  if (typeof status !== 'string' || (FACT_STATUSES as readonly string[]).includes(status) === false) raise(`${where} stands at the status ${shown(status)}: a fact's status is one of ${FACT_STATUSES.join(', ')}`);
  const provenance = column(fields['provenance']);
  if (provenance === null || typeof provenance !== 'object' || Array.isArray(provenance)) raise(`${where} carries the provenance ${shown(provenance)}: every fact names the source, the repository and the commit it was read from`);
  const value = column(fields['value']);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) raise(`${where} carries the value ${shown(value)}: a fact's value is the kind's own record`);
  return {
    kind,
    schemaVersion: Number(schemaVersion),
    id,
    provenance: provenance as Fact['provenance'],
    layer: layer as FactLayer,
    status: status as FactStatus,
    value,
  } as Fact;
}

/** A `jsonb` column as a value: a driver answers an object, and a text-encoded one is parsed. */
function column(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    raise(`the column ${shown(value)} is text and not JSON: ${(error as Error).message}`);
  }
}

/**
 * The facts of the rows one read answered, in code point order of their ids, each
 * id once.
 */
export function factsOfRows(rows: readonly unknown[], read: GraphRead): readonly Fact[] {
  const byId = new Map<string, Fact>();
  for (const row of rows) {
    const fact = factOfRow(row, read);
    byId.set(fact.id, fact);
  }
  return [...byId.values()].sort((left, right) => byCodePoint(left.id, right.id));
}

// ---------------------------------------------------------------------------------------------
// The drafts another unit holds
// ---------------------------------------------------------------------------------------------

/**
 * One write another unit of the run holds as draft, as a read of drafts answers
 * it: the fact the write would publish, marked as a draft so no reader can take
 * it for a published fact (0026: "lands in the unit's draft set, visible to other
 * units as draft").
 */
export interface DraftRow {
  /** Always true: the write stands in a draft set, and nothing has published it. */
  readonly asDraft: true;
  /** The unit holding the draft, as the store names it. */
  readonly unit: string;
  readonly generation: number;
  /** The scope the holding unit was planned for, as its plan wrote it. */
  readonly scope: string;
  /** The kind of tool that made the write (`fact`, `entity`, `link` or `question`). */
  readonly write: StageDraftWrite['kind'];
  /** What the write cites, as the draft set records it: `repository@commit:file`. */
  readonly evidence: string;
  /** The fact the write holds, as the store would hold it once this unit publishes. */
  readonly fact: Fact;
}

/** The kinds of write a draft set holds, as `StageDraftWrite` names them. */
const DRAFT_WRITE_KINDS: readonly StageDraftWrite['kind'][] = ['fact', 'entity', 'link', 'question'];

/** One draft set's row as the store answers it, before its writes are read. */
interface DraftSetRow extends Record<string, unknown> {
  unit_id: unknown;
  generation: unknown;
  writes: unknown;
  scope: unknown;
}

/**
 * The writes of the run's draft sets that bear on one read of drafts, in code
 * point order of the holding unit and its generation — the order the set's own
 * writes were made in, within one set. `about` keeps the writes whose fact is
 * that id or names it anywhere in its value; `in` keeps the writes whose cited
 * place stands inside that scope, and a write that cites no place — a `snapshot`,
 * a `repository` or a `directory` fact, which the schema asks for no place of —
 * stands in no scope, so no scope's section holds it. A draft set, or a write, the
 * store holds that is not one the schema's write path makes is refused by name,
 * never skipped: an answer that dropped it would be a smaller graph than the one
 * that stands.
 */
function draftRowsOf(rows: readonly unknown[], request: Extract<GraphRead, { read: 'drafts' }>, at: string): readonly DraftRow[] {
  const kept: DraftRow[] = [];
  for (const row of rows) {
    const held = (row ?? {}) as DraftSetRow;
    const unit = held.unit_id;
    if (typeof unit !== 'string' || unit === '') raise(`${at}: the read ${describedRead(request)} answered a draft set whose unit is ${shown(unit)}: every draft set belongs to a unit of a stage`);
    const generation = Number(held.generation);
    if (!Number.isInteger(generation) || generation < 1) raise(`${at}: the draft set of ${unit} is at generation ${shown(held.generation)}: a generation is a whole number, one or more`);
    const scope = held.scope;
    if (typeof scope !== 'string' || scope === '') raise(`${at}: the draft set of ${unit}/${generation} names no scope: the plan row of a unit names what it covers`);
    const writes = held.writes;
    if (!Array.isArray(writes)) raise(`${at}: the draft set of ${unit}/${generation} carries ${shown(writes)} as its writes: a draft set is a list of writes`);
    writes.forEach((write: unknown, index: number) => {
      const entry = (write ?? {}) as Record<string, unknown>;
      const kind = entry['kind'];
      if (typeof kind !== 'string' || (DRAFT_WRITE_KINDS as readonly string[]).includes(kind) === false) {
        raise(`${at}: the draft set of ${unit}/${generation} holds at position ${index + 1} the write ${shown(kind)}: a draft write is one of ${DRAFT_WRITE_KINDS.join(', ')} (src/fill/stage.ts)`);
      }
      const evidence = entry['evidence'];
      if (typeof evidence !== 'string') raise(`${at}: the draft write at position ${index + 1} of ${unit}/${generation} cites ${shown(evidence)}: every write cites what it stands on`);
      const fact = draftFactOfRow(entry['value'], request);
      if ('about' in request) {
        if (fact.id !== request.about && namesId(fact.value, request.about) === false) return;
      } else {
        const place = fact.provenance.place;
        if (place === undefined) return;
        if (scopeHolds(writeScope(request.in), { repository: fact.provenance.repository.id, file: String(place.file) }) === false) return;
      }
      kept.push({ asDraft: true, unit, generation, scope, write: kind as StageDraftWrite['kind'], evidence, fact });
    });
  }
  // A stable sort: the writes of one set keep the order the unit made them in.
  return kept.sort((left, right) => byCodePoint(left.unit, right.unit) || left.generation - right.generation);
}

/**
 * One draft write's fact, refused by name where it is not one: a draft set holds
 * the fact itself (`StageDraftWrite.value`), spelled with the schema's own
 * `schemaVersion` field, so the version is written the store's way before the
 * reader's own rules judge it.
 */
function draftFactOfRow(value: unknown, read: GraphRead): Fact {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    raise(`the write ${shown(value)} of the read ${describedRead(read)} carries no fact: a draft write holds the fact it would publish`);
  }
  const held = value as Record<string, unknown>;
  if (held['schemaVersion'] === undefined) {
    raise(`the fact ${shown(held['id'])} of the read ${describedRead(read)} names no schema version: a draft write holds the fact as the write path built it (src/fill/checked-writes.ts)`);
  }
  return factOfRow({ ...held, schema_version: held['schemaVersion'] }, read);
}

/** Whether a fact's value names one fact id anywhere in it: its ends, its subject, its object, its about. */
function namesId(value: unknown, id: string): boolean {
  if (typeof value === 'string') return value === id;
  if (Array.isArray(value)) return value.some((entry) => namesId(entry, id));
  if (value === null || typeof value !== 'object') return false;
  return Object.keys(value as Record<string, unknown>).some((key) => namesId((value as Record<string, unknown>)[key], id));
}

/** One answer's draft rows, refused by name where a row is not one this module wrote. */
function draftRowsFrom(rows: readonly unknown[], read: GraphRead): readonly DraftRow[] {
  return rows.map((row) => {
    const where = `the row ${shown(row)} of the read ${describedRead(read)}`;
    const held = (row ?? {}) as Record<string, unknown>;
    if (held['asDraft'] !== true) raise(`${where} is not marked as a draft: every row of a read of drafts is a draft and says so`);
    const unit = held['unit'];
    if (typeof unit !== 'string' || unit === '') raise(`${where} names the unit ${shown(unit)}: every draft set belongs to a unit of a stage`);
    const generation = held['generation'];
    if (typeof generation !== 'number' || Number.isInteger(generation) === false || generation < 1) raise(`the draft set of ${unit} names generation ${shown(generation)}: a generation is a whole number, one or more`);
    const scope = held['scope'];
    if (typeof scope !== 'string' || scope === '') raise(`the draft set of ${unit}/${generation} names no scope: the plan row of a unit names what it covers`);
    const write = held['write'];
    if (typeof write !== 'string' || (DRAFT_WRITE_KINDS as readonly string[]).includes(write) === false) {
      raise(`the draft set of ${unit}/${generation} names the write ${shown(write)}: a draft write is one of ${DRAFT_WRITE_KINDS.join(', ')} (src/fill/stage.ts)`);
    }
    const evidence = held['evidence'];
    if (typeof evidence !== 'string') raise(`the draft write of ${unit}/${generation} cites ${shown(evidence)}: every write cites what it stands on`);
    return { asDraft: true as const, unit, generation, scope, write: write as StageDraftWrite['kind'], evidence, fact: draftFactOfRow(held['fact'], read) };
  });
}

/**
 * What a context reads drafts for: the run whose units' recorded draft sets it
 * sees beside the published facts. A context without it answers published facts
 * only, which is what a deterministic stage's reader does: it has no unit of its
 * own whose run would say whose drafts are its business.
 */
export interface DraftReading {
  /** The run whose units' draft sets are read. */
  readonly run: string;
  /** The reading generation, whose own draft set is never answered as another unit's draft. */
  readonly unit: ReadingUnit;
}

/**
 * The drafts one tool answer shows beside its published rows, marked as drafts
 * and never mixed into them: the writes another unit of the reading unit's run
 * holds that name the node asked about, or that stand inside the scope asked
 * about. A context that reads no drafts answers none and makes no read, so a
 * stage's own reads stay what they were.
 */
async function draftsOf(context: GraphReadContext, trace: { readonly read: (request: GraphRead) => Promise<readonly unknown[]> }, request: { readonly about: string } | { readonly in: string }): Promise<readonly DraftRow[]> {
  if (context.drafts === undefined) return [];
  const read: GraphRead = 'about' in request
    ? { read: 'drafts', run: context.drafts.run, reader: context.drafts.unit, about: request.about }
    : { read: 'drafts', run: context.drafts.run, reader: context.drafts.unit, in: request.in };
  return draftRowsFrom(await trace.read(read), read);
}

/**
 * How one scope's draft section is read: by the place the scope's own node stands
 * in, or by the scope node's id.
 *
 * A repository, a folder and a file name a place — the repository, its `path` —
 * and the drafts that bear on them are the writes that cite a place inside it. A
 * module and a package name no place: a module's extent is its members and a
 * package's is the manifest its own value cites, so a place filter would answer
 * every draft of the repository as "inside the module" and make a module unit
 * stale on an unrelated draft anywhere in that repository. Their draft section is
 * therefore the writes of the run that name the node itself, and the answer's
 * `draftScope` says which of the two it read.
 */
function draftScopeOf(fact: Fact): { readonly by: 'place' | 'node'; readonly scope: string } {
  const value = (fact.value ?? {}) as unknown as Record<string, unknown>;
  const repository = typeof value['repository'] === 'string' ? value['repository'] : fact.provenance.repository.id;
  const path = typeof value['path'] === 'string' ? value['path'] : undefined;
  if (fact.kind === 'module' || fact.kind === 'package') return { by: 'node', scope: fact.id };
  return { by: 'place', scope: path === undefined ? repository : `${repository}:${path}` };
}

// ---------------------------------------------------------------------------------------------
// How a reader sees a node
// ---------------------------------------------------------------------------------------------

/** One node of the graph as a reader sees it. */
export interface GraphNodeRef {
  readonly id: string;
  /** The kind of the fact this names, or null when the graph holds no fact of that id (an end a write named and no unit holds any more). */
  readonly kind: FactKind | null;
  /** The name a reader knows it by: the node's own label, or the id itself where the graph holds no such fact. */
  readonly label: string;
  /** The file the fact stands at, when its provenance names a place. */
  readonly file?: string;
  /** The first line of that place. */
  readonly line?: number;
}

/** One node as a reader sees it; a fact the graph answers is always a node of its own kind. */
export function nodeRefOf(fact: Fact): GraphNodeRef {
  const place = fact.provenance.place;
  return {
    id: fact.id,
    kind: fact.kind,
    label: labelOf(fact),
    ...(place === undefined ? {} : { file: place.file, line: place.range.startLine }),
  };
}

/** One node the graph was asked for and does not hold: named by its id, with no kind and no label of its own. */
export function missingNode(id: string): GraphNodeRef {
  return { id, kind: null, label: id };
}

/** The most code points of a text a label keeps before the rest is cut. */
const LABEL_CODE_POINTS = 80;

/** A text as one label: its first line, at most `LABEL_CODE_POINTS` code points, cut with an ellipsis. */
function labelled(text: string): string {
  const line = text.split('\n')[0] ?? '';
  const points = [...line];
  return points.length <= LABEL_CODE_POINTS ? line : `${points.slice(0, LABEL_CODE_POINTS - 1).join('')}…`;
}

/**
 * The name a reader knows one fact by: a symbol by its qualified name in its
 * file, a file by its path in its repository, a claim by what it says. A label
 * is for a reader, never for a join: what a read filters by is always the fact
 * id. A kind this table does not name is shown by its kind, and a value that
 * does not carry the fields a label reads falls back to the fact's id.
 */
export function labelOf(fact: Fact): string {
  const value = (fact.value ?? {}) as unknown as Record<string, unknown>;
  const text = (field: string): string | undefined => {
    const held = value[field];
    return typeof held === 'string' && held !== '' ? held : undefined;
  };
  const repository = text('repository') ?? fact.provenance.repository.id;
  const place = fact.provenance.place;
  const at = place === undefined ? undefined : `${place.file}:${place.range.startLine}`;
  switch (fact.kind) {
    case 'snapshot':
      return `${text('repository') ?? repository}@${text('commit') ?? ''}`;
    case 'repository':
      return repository;
    case 'directory':
      return `${repository}:${text('path') ?? ''}/`;
    case 'file':
    case 'document':
      return `${repository}:${text('path') ?? at ?? ''}`;
    case 'package':
    case 'deploy-unit':
    case 'table':
      return `${repository}:${text('name') ?? fact.id}`;
    case 'column':
      return `${repository}:${text('table') ?? ''}.${text('name') ?? ''}`;
    case 'api-endpoint':
      return text('contract') ?? fact.id;
    case 'environment-variable':
      return text('name') ?? fact.id;
    case 'symbol':
      return `${repository}:${text('file') ?? ''}#${text('qualifiedName') ?? fact.id}`;
    case 'occurrence':
      return at === undefined ? `occurrence ${fact.id}` : `occurrence at ${at}`;
    case 'entry-point':
    case 'test':
    case 'module':
    case 'entity-proposal':
      return text('name') ?? fact.id;
    case 'comment':
      return labelled(text('text') ?? fact.id);
    case 'section':
      return `${repository}:${text('document') ?? ''}#${text('anchor') ?? ''}`;
    case 'commit': {
      const commit = text('commit') ?? '';
      return `${repository}@${[...commit].slice(0, 12).join('')}`;
    }
    case 'claim':
      return labelled(text('text') ?? text('predicate') ?? fact.id);
    case 'rule':
      return labelled(text('statement') ?? fact.id);
    case 'state':
      return `${text('machine') ?? ''}.${text('name') ?? ''}`;
    case 'coverage':
      return `coverage of ${text('scope') ?? ''}`;
    case 'question':
      return labelled(text('prompt') ?? fact.id);
    default:
      return fact.kind;
  }
}

// ---------------------------------------------------------------------------------------------
// The shape every answer has
// ---------------------------------------------------------------------------------------------

/** What every tool's answer holds, whatever it answers. */
export interface GraphReadEnvelope {
  /** The reads this answer stands on, in the order they were made: each was recorded as the reading unit's dependency under its own digest. */
  readonly reads: readonly GraphReadRef[];
  /** Whether a cap cut this answer: true only when something an answer should hold is not in it. */
  readonly truncated: boolean;
  /** What was cut and by which cap, in one sentence, or null when nothing was cut. */
  readonly marker: string | null;
  /** The answer's own size, by the fill's estimate (four code points a token by default). */
  readonly tokens: number;
}

/**
 * One read an answer stands on, as the answer names it: the read's kind and the
 * digest of its canonical text — the very digest the orchestrator records the
 * dependency row under (`fill_unit_read.query_digest`, `queryDigest`), so an
 * answer names the records it made without carrying their texts.
 */
export interface GraphReadRef {
  readonly read: GraphRead['read'];
  readonly digest: string;
}

/** One read as the answer names it. */
function readRef(request: GraphRead): GraphReadRef {
  return { read: request.read, digest: queryDigest(readText(request)) };
}

/** One list of rows as the cap holds it, with the sentence that says what it cut. */
export interface Bounded<T> {
  readonly rows: readonly T[];
  readonly cut: number;
  readonly marker: string | null;
  readonly tokens: number;
}

/**
 * The rows one answer holds under the cap: rows are added while the cap has room
 * for them, and the ones past it are counted and named. A row too large for the
 * cap on its own leaves the answer with none of them and a marker that says so —
 * a whole answer is smaller than a silent one.
 *
 * It is exported for the graph's pages (`graph-pages.ts`), whose lists are read
 * under the page's own cap and must say what they cut the same way a tool's answer
 * does.
 */
export function bounded<T>(rows: readonly T[], limits: GraphReadLimits, what: string, answerTokens: number): Bounded<T> {
  const held: T[] = [];
  let tokens = 0;
  for (const row of rows) {
    const cost = estimateTokens(JSON.stringify(row) ?? 'null', limits);
    if (tokens + cost > limits.answerTokens) break;
    held.push(row);
    tokens += cost;
  }
  const cut = rows.length - held.length;
  if (cut === 0) return { rows: held, cut: 0, marker: null, tokens };
  // The cap the marker names is the answer's own (`answerTokens`), never the smaller one the rows were bounded
  // by: the envelope's share is not a cap a reader set, and a marker that named it would name the wrong number.
  const marker = `truncated: ${what} holds ${rows.length} ${rows.length === 1 ? 'row' : 'rows'} and the answer's ${answerTokens}-token cap holds ${held.length}: ${cut} ${cut === 1 ? 'row was' : 'rows were'} cut`;
  return { rows: held, cut, marker, tokens };
}

/**
 * The tokens one marker's own words and the id it names take: reserved before the rows
 * are bounded, once for every marker an answer can carry (`rowsCap`'s `markers`), so
 * the cap holds the whole answer.
 */
const MARKER_RESERVE = 64;

/**
 * The cap one answer's rows are bounded by: the answer's own cap less what its
 * envelope takes — the request it echoes, the reads it stands on, and the words of
 * every marker the answer can carry (`markers`, one per list it bounds and per
 * list a row of it bounds itself). The cap is 0026's "a tool answer at most 8K
 * tokens", and it is the whole answer that holds it, not only its rows.
 */
function rowsCap(envelope: Record<string, unknown>, limits: GraphReadLimits, markers = 1): GraphReadLimits {
  const reserved = estimateTokens(JSON.stringify({ ...envelope, rows: [], lines: [], coverage: [], draft: [] }), limits) + MARKER_RESERVE * Math.max(1, markers);
  return { ...limits, answerTokens: Math.max(1, limits.answerTokens - reserved) };
}

/**
 * The cap a second list of the same answer holds: what the answer's own cap has
 * left once the lists before it were bounded, so two lists never add up past the
 * cap the reader set.
 */
function leftOf(limits: GraphReadLimits, taken: number): GraphReadLimits {
  return { ...limits, answerTokens: Math.max(1, limits.answerTokens - taken) };
}

/** One answer, with the size its own text comes to. */
function answered<A extends GraphReadEnvelope>(body: Omit<A, 'tokens'> & { readonly tokens?: number }, limits: GraphReadLimits): A {
  const tokens = estimateTokens(JSON.stringify({ ...body, tokens: 0 }), limits);
  return { ...body, tokens } as A;
}

/** The one marker of an answer whose parts were cut, or null when none was. */
export function markerOf(...markers: readonly (string | null)[]): string | null {
  const cut = markers.filter((marker): marker is string => marker !== null);
  return cut.length === 0 ? null : cut.join('; ');
}

// ---------------------------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------------------------

/** The six tools a unit reads the graph through (decision 0026). */
export const GRAPH_READ_TOOLS = ['describe_scope', 'neighbors', 'references', 'claims_about', 'coverage', 'evidence_span'] as const;
export type GraphReadTool = (typeof GRAPH_READ_TOOLS)[number];

/** Which way an edge stands toward the node a read is about. */
export type EdgeDirection = 'in' | 'out' | 'both';

/** The direction an edge stands in toward one node: `out` when the node is its from end, `in` when it is its to end. */
function directionOf(fact: Fact, id: string): EdgeDirection | null {
  const kind = fact.kind;
  if ((FACT_EDGE_KINDS as readonly string[]).includes(kind) === false) raise(`${here()}: the row ${fact.id} is ${shown(kind)}, which is no edge kind of the schema: a read of edges filters by edge kinds`);
  const ends = endsOf(kind as FactEdgeKind, fact.value);
  const out = ends.from === id;
  const into = ends.to === id;
  if (out && into) return 'both';
  if (out) return 'out';
  if (into) return 'in';
  return null;
}

/** One edge as a reader sees it: the id and kind a join uses, and the place a reader opens. */
export interface GraphEdgeRef {
  readonly id: string;
  readonly kind: FactEdgeKind;
  readonly file?: string;
  readonly line?: number;
  /** How many sites the edge's producer folded into it (a call, a mention), when it says. */
  readonly count?: number;
  /** How the edge was resolved (madarch-tzte.21.6): a compiler's index or a syntactic reading, when the kind carries one. */
  readonly precision?: string;
}

function edgeRefOf(fact: Fact): GraphEdgeRef {
  const place = fact.provenance.place;
  const value = (fact.value ?? {}) as unknown as Record<string, unknown>;
  const count = value['count'];
  const precision = value['precision'];
  return {
    id: fact.id,
    kind: fact.kind as FactEdgeKind,
    ...(place === undefined ? {} : { file: place.file, line: place.range.startLine }),
    ...(typeof count === 'number' ? { count } : {}),
    ...(typeof precision === 'string' ? { precision } : {}),
  };
}

/** The nodes the given ids name, as the graph holds them: a read of them, and the id itself where it holds none. */
async function refsOf(read: (request: GraphRead) => Promise<readonly unknown[]>, ids: readonly string[]): Promise<ReadonlyMap<string, GraphNodeRef>> {
  const wanted = [...new Set(ids)].sort(byCodePoint);
  const refs = new Map<string, GraphNodeRef>();
  if (wanted.length > 0) {
    const request: GraphRead = { read: 'facts', ids: wanted };
    for (const fact of factsOfRows(await read(request), request)) refs.set(fact.id, nodeRefOf(fact));
  }
  for (const id of wanted) if (!refs.has(id)) refs.set(id, missingNode(id));
  return refs;
}

// ---- describe_scope --------------------------------------------------------

export interface DescribeScopeRequest {
  readonly tool: 'describe_scope';
  /** The fact id of the scope: a repository, directory, file, package or module of the graph. */
  readonly scope: string;
}

/** One kind of node a scope holds, and how many of them. */
export interface ScopeHeld {
  readonly kind: FactKind;
  readonly count: number;
}

/** One kind of edge that touches a scope, which way it stands, and how many of them. */
export interface ScopeEdgeCount extends ScopeHeld {
  readonly kind: FactEdgeKind;
  readonly direction: EdgeDirection;
}

export interface DescribeScopeAnswer extends GraphReadEnvelope {
  readonly tool: 'describe_scope';
  readonly scope: string;
  readonly node: GraphNodeRef;
  readonly holds: readonly ScopeHeld[];
  readonly edges: readonly ScopeEdgeCount[];
  readonly coverage: readonly CoverageRow[];
  /** The writes other units of the run hold as drafts about this scope (0026), each marked as a draft. */
  readonly draft: readonly DraftRow[];
  /** What the draft section was read for: the scope's own place, or the scope node's id (a module or a package names no place). */
  readonly draftScope: { readonly by: 'place' | 'node'; readonly scope: string };
}

/**
 * What one scope is, what it holds and how it stands in the graph: the scope
 * node, the kinds of the nodes it holds (`contains`, `defines`) by count, the
 * edges touching it by kind and direction, and the coverage facts that name it.
 * A scope the graph does not hold, or an id of a kind no scope is, is refused by
 * name — an answer about a node that is not there would read as "nothing here",
 * which is a statement about the graph nobody made. The `fact` read behind that
 * refusal is made and recorded like any other: the unit did read the graph, and a
 * generation that then fails keeps the dependency it made.
 */
export async function describeScope(context: GraphReadContext, request: DescribeScopeRequest): Promise<DescribeScopeAnswer> {
  const at = here();
  if (typeof request.scope !== 'string' || !isFactId(request.scope)) raise(`${at}: describe_scope names the scope ${shown(request.scope)}: a scope is the fact id of a repository, directory, file, package or module (src/fill/facts.ts)`);
  const trace = traced(context);
  const scopeRead: GraphRead = { read: 'fact', id: request.scope };
  const scopeFacts = factsOfRows(await trace.read(scopeRead), scopeRead);
  const node = scopeFacts[0];
  if (node === undefined) raise(`${at}: describe_scope names the scope ${request.scope} and the graph holds no fact of that id: a scope is read after its stage published it (the id is the fact's own, src/fill/facts.ts)`);
  if (SCOPE_KINDS.includes(node.kind) === false) {
    raise(`${at}: describe_scope names the scope ${request.scope}, which is ${shown(node.kind)} fact: a scope is one of ${SCOPE_KINDS.join(', ')}, and what another kind of fact holds would read as a scope that holds nothing`);
  }
  const heldRead: GraphRead = { read: 'held', id: request.scope, via: STRUCTURE_EDGE_KINDS };
  const adjacencyRead: GraphRead = { read: 'adjacent', id: request.scope };
  const coverageRead: GraphRead = { read: 'facts-with', kind: 'coverage', field: 'scope', value: request.scope };
  const holds = (await trace.read(heldRead)).map((row) => heldCount(row, heldRead)).sort((left, right) => byCodePoint(left.kind, right.kind));
  const edges = countEdges(factsOfRows(await trace.read(adjacencyRead), adjacencyRead), request.scope);
  const coverage = await coverageRows(factsOfRows(await trace.read(coverageRead), coverageRead));
  const draftScope = draftScopeOf(node);
  const drafts = await draftsOf(context, trace, draftScope.by === 'place' ? { in: draftScope.scope } : { about: draftScope.scope });
  const skeleton = { tool: 'describe_scope' as const, scope: request.scope, node: nodeRefOf(node), holds, edges, coverage: [], draft: [], draftScope, reads: trace.made.map(readRef), truncated: false, marker: null };
  // Three markers at most: the coverage the cap cut, a coverage row's own sample and gap cuts, and the drafts.
  const cap = rowsCap(skeleton, context.limits, 3);
  const held = bounded(coverage.rows, cap, `the coverage of the scope ${request.scope}`, context.limits.answerTokens);
  const drafted = bounded(drafts, leftOf(cap, held.tokens), `the drafts about the scope ${request.scope}`, context.limits.answerTokens);
  const marker = markerOf(held.marker, coverage.marker, drafted.marker);
  return answered<DescribeScopeAnswer>({ ...skeleton, coverage: held.rows, draft: drafted.rows, truncated: marker !== null, marker }, context.limits);
}

/** One `held` read's row as a count of one kind. */
function heldCount(row: unknown, read: GraphRead): ScopeHeld {
  const where = `the row ${shown(row)} of the read ${describedRead(read)}`;
  if (row === null || typeof row !== 'object' || Array.isArray(row)) raise(`${where} is no count: a count of the read is the kind of a node and how many of them`);
  const fields = row as Record<string, unknown>;
  const kind = fields['kind'];
  if (typeof kind !== 'string' || !isFactKind(kind)) raise(`${where} names the kind ${shown(kind)}: a fact kind is one of the schema's kinds (src/fill/facts.ts)`);
  const count = fields['count'];
  if (typeof count !== 'number' && typeof count !== 'string') raise(`${where} counts ${shown(count)}: a count is a whole number`);
  return { kind, count: Number(count) };
}

/** The edges touching one node, counted by kind and direction, in code point order of the kind then the direction. */
function countEdges(facts: readonly Fact[], id: string): readonly ScopeEdgeCount[] {
  const counts = new Map<string, ScopeEdgeCount>();
  for (const fact of facts) {
    const direction = directionOf(fact, id);
    if (direction === null) continue;
    const key = `${fact.kind}\u0000${direction}`;
    const held = counts.get(key);
    counts.set(key, { kind: fact.kind as FactEdgeKind, direction, count: (held?.count ?? 0) + 1 });
  }
  return [...counts.values()].sort((left, right) => byCodePoint(left.kind, right.kind) || byCodePoint(left.direction, right.direction));
}

// ---- neighbors -------------------------------------------------------------

export interface NeighborsRequest {
  readonly tool: 'neighbors';
  /** The fact id of the node whose neighbourhood is asked for. */
  readonly id: string;
  /** Which way the neighbours stand; both directions when it is left out. */
  readonly direction?: EdgeDirection;
  /** The edge kinds to answer; the relation kinds (`NEIGHBOR_EDGE_KINDS`) when it is left out. */
  readonly kinds?: readonly FactEdgeKind[];
}

/** One neighbour of a node: the edge that joins them and the node at its other end. */
export interface NeighborRow {
  readonly direction: EdgeDirection;
  readonly edge: GraphEdgeRef;
  readonly neighbor: GraphNodeRef;
}

export interface NeighborsAnswer extends GraphReadEnvelope {
  readonly tool: 'neighbors';
  readonly id: string;
  readonly direction: EdgeDirection;
  /** The edge kinds this answer walked, in code point order: what the answer holds and what it left out. */
  readonly kinds: readonly FactEdgeKind[];
  readonly rows: readonly NeighborRow[];
  /** The writes other units of the run hold as drafts about this node (0026), each marked as a draft. */
  readonly draft: readonly DraftRow[];
}

/**
 * The nodes one node stands next to: every edge fact of the kinds asked for (the
 * relation kinds by default, so `contains` and `defines` are not neighbours
 * unless they are asked for) that names it at an end, with the node at the other
 * end of that edge. A symbol three callers call is three rows here, in code point
 * order of the caller's label and id, and nothing else stands between the reader
 * and that answer. An edge whose other end is no fact id (`provides` names a
 * contract, `binds` an environment, `task-key` a key, `document-link` a term) has
 * no node to name and is not one of the rows: the answer's own `kinds` says which
 * kinds it walked.
 */
export async function neighbors(context: GraphReadContext, request: NeighborsRequest): Promise<NeighborsAnswer> {
  const at = here();
  const id = readFactId(request.id, `neighbors of ${shown(request.id)}`);
  const direction = request.direction ?? 'both';
  if (direction !== 'in' && direction !== 'out' && direction !== 'both') raise(`${at}: neighbors of ${id} asks for the direction ${shown(direction)}: a direction is "in", "out" or "both"`);
  const kinds = request.kinds === undefined ? NEIGHBOR_EDGE_KINDS : readEdgeKinds(request.kinds, `neighbors of ${id}`);
  if (kinds.length === 0) raise(`${at}: neighbors of ${id} names no edge kind: a read of neighbours answers the edges of the kinds it is given (the relation kinds unless it names its own)`);
  const trace = traced(context);
  const read: GraphRead = { read: 'adjacent', id, kinds };
  const edges = factsOfRows(await trace.read(read), read);
  const rows: NeighborRow[] = [];
  const wanted: string[] = [];
  for (const edge of edges) {
    const ends = endsOf(edge.kind as FactEdgeKind, edge.value);
    const out = ends.from === id;
    const into = ends.to === id;
    const standing: EdgeDirection | null = out && into ? 'both' : out ? 'out' : into ? 'in' : null;
    if (standing === null) continue;
    if (direction !== 'both' && standing !== direction) continue;
    const other = standing === 'in' ? ends.from : ends.to;
    if (other === undefined) continue;
    wanted.push(other);
    rows.push({ direction: standing, edge: edgeRefOf(edge), neighbor: missingNode(other) });
  }
  const refs = await refsOf(trace.read, wanted);
  const resolved = rows.map((row) => ({ ...row, neighbor: refs.get(row.neighbor.id) ?? row.neighbor }));
  resolved.sort((left, right) => byCodePoint(left.neighbor.label, right.neighbor.label)
    || byCodePoint(left.neighbor.id, right.neighbor.id)
    || byCodePoint(left.edge.id, right.edge.id));
  const drafts = await draftsOf(context, trace, { about: id });
  const skeleton = { tool: 'neighbors' as const, id, direction, kinds, rows: [], draft: [], reads: trace.made.map(readRef), truncated: false, marker: null };
  const cap = rowsCap(skeleton, context.limits, 2);
  const held = bounded(resolved, cap, `the neighbours of ${id}`, context.limits.answerTokens);
  const drafted = bounded(drafts, leftOf(cap, held.tokens), `the drafts about ${id}`, context.limits.answerTokens);
  const marker = markerOf(held.marker, drafted.marker);
  return answered<NeighborsAnswer>({ ...skeleton, rows: held.rows, draft: drafted.rows, truncated: marker !== null, marker }, context.limits);
}

// ---- references ------------------------------------------------------------

export interface ReferencesRequest {
  readonly tool: 'references';
  /** The fact id of the node that is referenced. */
  readonly id: string;
  /** The edge kinds to answer; the kinds that name or use a node when it is left out. */
  readonly kinds?: readonly FactEdgeKind[];
}

/** One place that references a node: the referencing node and the edge that cites it. */
export interface ReferenceRow {
  readonly from: GraphNodeRef;
  readonly edge: GraphEdgeRef;
}

export interface ReferencesAnswer extends GraphReadEnvelope {
  readonly tool: 'references';
  readonly id: string;
  readonly kinds: readonly FactEdgeKind[];
  readonly rows: readonly ReferenceRow[];
  /** The writes other units of the run hold as drafts that name this node (0026), each marked as a draft. */
  readonly draft: readonly DraftRow[];
}

/**
 * Who names or uses one node, and where: every edge of a citing kind that points
 * at the node, each with the node it comes from and the place the edge stands at
 * (a call's place is the code-point-smallest call site its producer folded, with
 * the count it folded). The rows are in code point order of the file, then by
 * line, then by the referencing node's label and id, then the edge's id. An edge
 * whose from end is no fact id names no citing node and is not one of the rows;
 * the answer's own `kinds` says which kinds it walked.
 */
export async function references(context: GraphReadContext, request: ReferencesRequest): Promise<ReferencesAnswer> {
  const at = here();
  const id = readFactId(request.id, `references to ${shown(request.id)}`);
  const kinds = request.kinds === undefined ? REFERENCE_EDGE_KINDS : readEdgeKinds(request.kinds, `references to ${id}`);
  if (kinds.length === 0) raise(`${at}: references to ${id} names no edge kind: a read of references answers the edges of the kinds it is given`);
  const trace = traced(context);
  const read: GraphRead = { read: 'adjacent', id, kinds };
  const edges = factsOfRows(await trace.read(read), read);
  const citing = edges.filter((edge) => directionOf(edge, id) !== 'out');
  const refs = await refsOf(trace.read, citing.map((edge) => endsOf(edge.kind as FactEdgeKind, edge.value).from ?? '').filter((from) => from !== ''));
  const rows: ReferenceRow[] = citing.map((edge) => {
    const from = endsOf(edge.kind as FactEdgeKind, edge.value).from ?? '';
    return { from: refs.get(from) ?? missingNode(from), edge: edgeRefOf(edge) };
  });
  rows.sort((left, right) => byCodePoint(left.edge.file ?? '', right.edge.file ?? '')
    || (left.edge.line ?? 0) - (right.edge.line ?? 0)
    || byCodePoint(left.from.label, right.from.label)
    || byCodePoint(left.from.id, right.from.id)
    || byCodePoint(left.edge.id, right.edge.id));
  const drafts = await draftsOf(context, trace, { about: id });
  const skeleton = { tool: 'references' as const, id, kinds, rows: [], draft: [], reads: trace.made.map(readRef), truncated: false, marker: null };
  const cap = rowsCap(skeleton, context.limits, 2);
  const held = bounded(rows, cap, `the references to ${id}`, context.limits.answerTokens);
  const drafted = bounded(drafts, leftOf(cap, held.tokens), `the drafts about ${id}`, context.limits.answerTokens);
  const marker = markerOf(held.marker, drafted.marker);
  return answered<ReferencesAnswer>({ ...skeleton, rows: held.rows, draft: drafted.rows, truncated: marker !== null, marker }, context.limits);
}

// ---- claims_about ----------------------------------------------------------

/** Which way a claim names the node a read is about. */
export type ClaimDirection = 'about' | 'names' | 'both';

export interface ClaimsAboutRequest {
  readonly tool: 'claims_about';
  /** The fact id of the node the claims are about. */
  readonly id: string;
  /** `about` for the claims whose subject is the node, `names` for those whose object is; both when it is left out. */
  readonly direction?: ClaimDirection;
}

/** One end of a claim as a reader sees it: a node of the graph (with its label), an address, or a literal. */
export interface GraphTermRef {
  readonly form: 'node' | 'external' | 'literal';
  readonly id?: string;
  readonly url?: string;
  readonly text?: string;
  /** The label of the node this names, where the graph holds it. */
  readonly label?: string;
}

/** One claim about a node, as the graph holds it. */
export interface ClaimRow {
  readonly id: string;
  readonly predicate: string;
  readonly subject: GraphTermRef;
  readonly object: GraphTermRef;
  readonly text?: string;
  readonly confidence?: number;
  readonly layer: FactLayer;
  readonly status: FactStatus;
  readonly file?: string;
  readonly line?: number;
}

export interface ClaimsAboutAnswer extends GraphReadEnvelope {
  readonly tool: 'claims_about';
  readonly id: string;
  readonly direction: ClaimDirection;
  readonly rows: readonly ClaimRow[];
  /** The writes other units of the run hold as drafts about this node (0026), each marked as a draft. */
  readonly draft: readonly DraftRow[];
}

/**
 * What the graph says about one node: the claims whose subject is the node, and
 * — asked for — the claims whose object names it. A claim is a person's or an
 * agent's assertion (0004's atom), so every row carries the layer and status it
 * stands at, and the ends that are nodes carry the label of the node they name.
 */
export async function claimsAbout(context: GraphReadContext, request: ClaimsAboutRequest): Promise<ClaimsAboutAnswer> {
  const at = here();
  const id = readFactId(request.id, `claims_about ${shown(request.id)}`);
  const direction = request.direction ?? 'both';
  if (direction !== 'about' && direction !== 'names' && direction !== 'both') raise(`${at}: claims_about ${id} asks for the direction ${shown(direction)}: a direction is "about", "names" or "both"`);
  const trace = traced(context);
  const found = new Map<string, Fact>();
  const reads: GraphRead[] = [];
  if (direction !== 'names') reads.push({ read: 'facts-with', kind: 'claim', field: 'subject.id', value: id });
  if (direction !== 'about') reads.push({ read: 'facts-with', kind: 'claim', field: 'object.id', value: id });
  for (const read of reads) for (const fact of factsOfRows(await trace.read(read), read)) found.set(fact.id, fact);
  const claims = [...found.values()].sort((left, right) => byCodePoint(left.id, right.id));
  const refs = await refsOf(trace.read, claims.flatMap((claim) => [term(claim.value, 'subject'), term(claim.value, 'object')])
    .filter((held): held is { form: 'node'; id: string } => held !== undefined && held.form === 'node')
    .map((held) => held.id));
  const rows: ClaimRow[] = claims.map((claim) => {
    const value = claim.value as unknown as Record<string, unknown>;
    const place = claim.provenance.place;
    const confidence = value['confidence'];
    const text = value['text'];
    if (typeof value['predicate'] !== 'string') raise(`${at}: the claim ${claim.id} carries the predicate ${shown(value['predicate'])}: a claim says what it asserts about its subject, as one lower-case kebab token`);
    const subject = term(claim.value, 'subject');
    const object = term(claim.value, 'object');
    if (subject === undefined) raise(`${at}: the claim ${claim.id} carries ${shown(value['subject'])} at value.subject: a claim's subject is a node, an address outside the repositories, or a literal (src/fill/facts.ts)`);
    if (object === undefined) raise(`${at}: the claim ${claim.id} carries ${shown(value['object'])} at value.object: a claim's object is a node, an address outside the repositories, or a literal (src/fill/facts.ts)`);
    return {
      id: claim.id,
      predicate: value['predicate'],
      subject: termRef(subject, refs),
      object: termRef(object, refs),
      ...(typeof text === 'string' ? { text } : {}),
      ...(typeof confidence === 'number' ? { confidence } : {}),
      layer: claim.layer,
      status: claim.status,
      ...(place === undefined ? {} : { file: place.file, line: place.range.startLine }),
    };
  });
  const drafts = await draftsOf(context, trace, { about: id });
  const skeleton = { tool: 'claims_about' as const, id, direction, rows: [], draft: [], reads: trace.made.map(readRef), truncated: false, marker: null };
  const cap = rowsCap(skeleton, context.limits, 2);
  const held = bounded(rows, cap, `the claims about ${id}`, context.limits.answerTokens);
  const drafted = bounded(drafts, leftOf(cap, held.tokens), `the drafts about ${id}`, context.limits.answerTokens);
  const marker = markerOf(held.marker, drafted.marker);
  return answered<ClaimsAboutAnswer>({ ...skeleton, rows: held.rows, draft: drafted.rows, truncated: marker !== null, marker }, context.limits);
}

/** One term of a claim's value, as the schema writes it. */
function term(value: unknown, field: 'subject' | 'object'): { readonly form: 'node' | 'external' | 'literal'; readonly id?: string; readonly url?: string; readonly text?: string } | undefined {
  const held = (value ?? {}) as Record<string, unknown>;
  const entry = held[field];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  const fields = entry as Record<string, unknown>;
  const form = fields['form'];
  if (form !== 'node' && form !== 'external' && form !== 'literal') return undefined;
  return {
    form,
    ...(typeof fields['id'] === 'string' ? { id: fields['id'] } : {}),
    ...(typeof fields['url'] === 'string' ? { url: fields['url'] } : {}),
    ...(typeof fields['text'] === 'string' ? { text: fields['text'] } : {}),
  };
}

/** One term as a reader sees it, with the label of the node it names where the graph holds it. */
function termRef(held: NonNullable<ReturnType<typeof term>>, refs: ReadonlyMap<string, GraphNodeRef>): GraphTermRef {
  if (held.form !== 'node' || held.id === undefined) {
    return { form: held.form, ...(held.url === undefined ? {} : { url: held.url }), ...(held.text === undefined ? {} : { text: held.text }) };
  }
  const ref = refs.get(held.id);
  return { form: 'node', id: held.id, ...(ref === undefined ? {} : { label: ref.label }) };
}

// ---- coverage --------------------------------------------------------------

/** The most entries of one coverage fact's `read` list an answer shows. */
export const COVERAGE_READ_SAMPLE = 50;
/** The most gaps of one coverage fact an answer shows. */
export const COVERAGE_GAP_LIMIT = 200;

export interface CoverageRequest {
  readonly tool: 'coverage';
  /** The scope as the coverage facts name it (`CoverageValue.scope`): a scope token, a node fact id or a path. */
  readonly scope: string;
}

/** One thing a coverage could not read, and why. */
export interface CoverageGapRow {
  readonly what: string;
  readonly reason: CoverageGapReason;
}

/** What one stage's reader read of one scope, and what it could not read. */
export interface CoverageRow {
  readonly id: string;
  readonly repository: string;
  readonly scope: string;
  /** Whether the reader read the whole scope; false is a scope with a gap, never an absence (0005). */
  readonly complete: boolean;
  /** How many things the coverage read. */
  readonly readCount: number;
  /** A sample of what it read, bounded; `readCut` says how many entries the sample left out. */
  readonly read: readonly string[];
  readonly readCut: number;
  /** What could not be read; `unreadCut` says how many gaps this answer left out. */
  readonly unread: readonly CoverageGapRow[];
  readonly unreadCut: number;
  readonly file?: string;
  readonly line?: number;
}

export interface CoverageAnswer extends GraphReadEnvelope {
  readonly tool: 'coverage';
  readonly scope: string;
  /** Whether the scope was read whole: true when every coverage fact of it is complete, false when one names a gap, null when no stage recorded coverage for it. */
  readonly complete: boolean | null;
  readonly rows: readonly CoverageRow[];
}

/**
 * What is known about one scope and what could not be read: the coverage facts
 * that name the scope, each with the count of what it read, a bounded sample of
 * it and the gaps it names — a gap is never dropped in silence, and the sample
 * and the gaps each say how many entries they left out.
 */
export async function coverage(context: GraphReadContext, request: CoverageRequest): Promise<CoverageAnswer> {
  const at = here();
  if (typeof request.scope !== 'string' || request.scope === '') raise(`${at}: coverage names the scope ${shown(request.scope)}: a scope is the one the coverage facts carry (a repository, a module's fact id or a path)`);
  const trace = traced(context);
  const read: GraphRead = { read: 'facts-with', kind: 'coverage', field: 'scope', value: request.scope };
  const coverage = await coverageRows(factsOfRows(await trace.read(read), read));
  const complete = coverage.rows.length === 0 ? null : coverage.rows.every((row) => row.complete);
  const skeleton = { tool: 'coverage' as const, scope: request.scope, complete, rows: [], reads: trace.made.map(readRef), truncated: false, marker: null };
  const held = bounded(coverage.rows, rowsCap(skeleton, context.limits, 2), `the coverage of the scope ${request.scope}`, context.limits.answerTokens);
  const marker = markerOf(held.marker, coverage.marker);
  return answered<CoverageAnswer>({ ...skeleton, rows: held.rows, truncated: marker !== null, marker }, context.limits);
}

/** The coverage rows of the coverage facts one read answered, each bounded in its own lists. */
async function coverageRows(facts: readonly Fact[]): Promise<{ readonly rows: readonly CoverageRow[]; readonly marker: string | null }> {
  const rows: CoverageRow[] = [];
  const cut: string[] = [];
  for (const fact of facts) {
    const value = (fact.value ?? {}) as unknown as Record<string, unknown>;
    const place = fact.provenance.place;
    const readList = Array.isArray(value['read']) ? value['read'].filter((entry): entry is string => typeof entry === 'string') : [];
    const gaps = Array.isArray(value['unread']) ? value['unread'] : [];
    const unread = gaps.slice(0, COVERAGE_GAP_LIMIT).map((gap) => coverageGapOf(gap, fact.id));
    const unreadCut = gaps.length - unread.length;
    const read = readList.slice(0, COVERAGE_READ_SAMPLE);
    const readCut = readList.length - read.length;
    if (readCut > 0) cut.push(`${readCut} ${readCut === 1 ? 'entry' : 'entries'} of what ${fact.id} read were cut by the ${COVERAGE_READ_SAMPLE}-entry sample`);
    if (unreadCut > 0) cut.push(`${unreadCut} ${unreadCut === 1 ? 'gap' : 'gaps'} of ${fact.id} were cut by the ${COVERAGE_GAP_LIMIT}-gap cap`);
    if (typeof value['scope'] !== 'string') raise(`${here()}: the coverage fact ${fact.id} names the scope ${shown(value['scope'])}: a coverage names the scope it read`);
    if (typeof value['complete'] !== 'boolean') raise(`${here()}: the coverage fact ${fact.id} carries complete ${shown(value['complete'])}: a coverage says whether it read the whole scope`);
    rows.push({
      id: fact.id,
      repository: typeof value['repository'] === 'string' ? value['repository'] : fact.provenance.repository.id,
      scope: value['scope'],
      complete: value['complete'],
      readCount: readList.length,
      read,
      readCut,
      unread,
      unreadCut,
      ...(place === undefined ? {} : { file: place.file, line: place.range.startLine }),
    });
  }
  rows.sort((left, right) => byCodePoint(left.scope, right.scope) || byCodePoint(left.id, right.id));
  return { rows, marker: cut.length === 0 ? null : `truncated: ${cut.join('; ')}` };
}

/** One gap as the coverage value holds it, refused by name where it is not one. */
function coverageGapOf(gap: unknown, coverageId: string): CoverageGapRow {
  if (gap === null || typeof gap !== 'object' || Array.isArray(gap)) raise(`${here()}: the coverage fact ${coverageId} names the gap ${shown(gap)}: a gap names what was not read and why`);
  const fields = gap as Record<string, unknown>;
  const what = fields['what'];
  const reason = fields['reason'];
  if (typeof what !== 'string') raise(`${here()}: the coverage fact ${coverageId} names the gap ${shown(gap)} whose "what" is ${shown(what)}: a gap names what was not read, as text`);
  if (typeof reason !== 'string' || (COVERAGE_GAP_REASONS as readonly string[]).includes(reason) === false) {
    raise(`${here()}: the coverage fact ${coverageId} names the gap ${shown(what)} with the reason ${shown(reason)}: a reason is one of ${COVERAGE_GAP_REASONS.join(', ')}`);
  }
  return { what, reason: reason as CoverageGapReason };
}

// ---- evidence_span ---------------------------------------------------------

export interface EvidenceSpanRequest {
  readonly tool: 'evidence_span';
  /** The repository the bytes are read from, as the product names it. */
  readonly repository: string;
  /** The commit the bytes are read at: the run's own pin, 40 lower-case hexadecimal digits. */
  readonly commit: string;
  /** The file, as a repository path. */
  readonly file: string;
  /** The first line to show; the file's first line when it is left out. */
  readonly startLine?: number;
  /** The last line to show; the file's last line when it is left out (and the span's cap always applies). */
  readonly endLine?: number;
}

/** One line of a file at the pinned commit. */
export interface EvidenceLine {
  readonly line: number;
  readonly text: string;
}

export interface EvidenceSpanAnswer extends GraphReadEnvelope {
  readonly tool: 'evidence_span';
  readonly repository: string;
  readonly commit: string;
  readonly file: string;
  /** The lines this answer holds: `endLine` is one less than `startLine` when the caps held none of them. */
  readonly startLine: number;
  readonly endLine: number;
  /**
   * What the caller asked for, as it asked it (an end past the file's own last
   * line is not rewritten here). The marker and `cut` count the lines the file
   * has of that request.
   */
  readonly asked: { readonly startLine: number; readonly endLine: number };
  /** How many lines the file has at that commit. */
  readonly totalLines: number;
  readonly lines: readonly EvidenceLine[];
  /** How many lines of what was asked are not in this answer. */
  readonly cut: number;
}

/**
 * The bytes of one file at the pinned commit, as the lines a reader counts, at
 * most 0026's ~200 lines and the answer's own token cap. A line past the file's
 * last one is refused naming the file, the line and the file's own line count;
 * a span longer than the caps is answered with the lines that fit and a marker
 * naming what was cut. The read this answer stands on is the window the spans'
 * line cap allows the store to answer — what the answer shows clasped to that
 * window — so the unit's dependency covers what it read, and a further cut by the
 * answer's token cap is the answer's own, named in the marker.
 */
export async function evidenceSpan(context: GraphReadContext, request: EvidenceSpanRequest): Promise<EvidenceSpanAnswer> {
  const at = here();
  const repository = readRepository(request.repository, `evidence_span of ${shown(request.file)}`);
  const commit = readCommit(request.commit, `evidence_span of ${shown(request.file)}`);
  const file = readFile(request.file, 'evidence_span');
  const from = request.startLine === undefined ? 1 : readLine(request.startLine, 'startLine', 'evidence_span');
  const wants = request.endLine === undefined ? null : readLine(request.endLine, 'endLine', 'evidence_span');
  if (wants !== null && wants < from) raise(`${at}: evidence_span asks for the lines ${from} to ${wants} of ${file}: a span starts at a line and ends at that line or a later one`);
  const trace = traced(context);
  const readTo = wants === null ? from + context.limits.spanLines - 1 : Math.min(wants, from + context.limits.spanLines - 1);
  const read: GraphRead = { read: 'span', repository, commit, file, startLine: from, endLine: readTo };
  const row = (await trace.read(read))[0];
  const span = spanOfRow(row, read);
  // What was asked, and what the read held of it: the file's own last line is the end of a span
  // that names none, and lines past the file's end are lines the file does not have.
  const askedEnd = Math.min(wants ?? span.totalLines, span.totalLines);
  // The lines the span could hold: a request past the file's own last line asks for lines the file does
  // not have, which is not a cut of anything.
  const window = Math.max(0, Math.min(readTo, span.totalLines) - from + 1);
  const pastSpanCap = Math.max(0, askedEnd - from + 1 - window);
  const skeleton = { tool: 'evidence_span' as const, repository, commit: span.commit, file, startLine: from, endLine: 0, asked: { startLine: from, endLine: askedEnd }, totalLines: span.totalLines, lines: [], cut: 0, reads: trace.made.map(readRef), truncated: false, marker: null };
  const held = bounded(span.lines, rowsCap(skeleton, context.limits), `the lines ${from}–${askedEnd} of ${file}`, context.limits.answerTokens);
  const pastTokenCap = Math.max(0, window - held.rows.length);
  const last = held.rows.length === 0 ? from - 1 : held.rows[held.rows.length - 1]!.line;
  const cut = pastSpanCap + pastTokenCap;
  const holds = held.rows.length === 0 ? 'this answer holds none of them' : `this answer holds lines ${from}–${last} (${held.rows.length} ${held.rows.length === 1 ? 'line' : 'lines'})`;
  // Only the caps that cut are named: a sentence that counted a cap which cut nothing would be noise in the
  // one place a reader looks for what is missing.
  const by = [
    pastSpanCap === 0 ? '' : `${pastSpanCap} past the ${context.limits.spanLines}-line cap of an evidence span`,
    pastTokenCap === 0 ? '' : `${pastTokenCap} past the answer's ${context.limits.answerTokens}-token cap`,
  ].filter((part) => part !== '').join(', ');
  const marker = cut === 0 ? null : `truncated: asked lines ${from}–${askedEnd} of ${file} (${askedEnd - from + 1} lines); ${holds}: ${cut} ${cut === 1 ? 'line was' : 'lines were'} cut (${by})`;
  return answered<EvidenceSpanAnswer>({
    tool: 'evidence_span',
    repository,
    commit: span.commit,
    file,
    startLine: from,
    endLine: last,
    // What was asked, as it was asked: an end past the file's own last line is not rewritten here (the
    // count below is what is clamped), and a span that named no end asked for the file's own last line.
    asked: { startLine: from, endLine: wants ?? span.totalLines },
    totalLines: span.totalLines,
    lines: held.rows,
    cut,
    reads: trace.made.map(readRef),
    truncated: marker !== null,
    marker,
  }, context.limits);
}

/** The span row one read answered, refused by name where it is not one. */
function spanOfRow(row: unknown, read: GraphRead): SpanRow {
  const where = `the row ${shown(row)} of the read ${describedRead(read)}`;
  if (row === null || typeof row !== 'object' || Array.isArray(row)) raise(`${where} is no span: a span names the file, the commit and the lines it holds`);
  const fields = row as Record<string, unknown>;
  const lines = Array.isArray(fields['lines']) ? fields['lines'] : null;
  if (lines === null) raise(`${where} carries ${shown(fields['lines'])} as its lines: a span's lines are a list of {line, text}`);
  return {
    repository: String(fields['repository'] ?? ''),
    commit: String(fields['commit'] ?? ''),
    file: String(fields['file'] ?? ''),
    startLine: Number(fields['startLine'] ?? 0),
    endLine: Number(fields['endLine'] ?? 0),
    totalLines: Number(fields['totalLines'] ?? 0),
    lines: lines.map((line) => {
      const held = (line ?? {}) as Record<string, unknown>;
      return { line: Number(held['line'] ?? 0), text: typeof held['text'] === 'string' ? held['text'] : '' };
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// One call, whatever tool it is
// ---------------------------------------------------------------------------------------------

/** One call of one tool: the tool's name and its own request. */
export type GraphReadCall = DescribeScopeRequest | NeighborsRequest | ReferencesRequest | ClaimsAboutRequest | CoverageRequest | EvidenceSpanRequest;

/** What one call answered. */
export type GraphReadResult = DescribeScopeAnswer | NeighborsAnswer | ReferencesAnswer | ClaimsAboutAnswer | CoverageAnswer | EvidenceSpanAnswer;

/** Runs one call of whichever tool it names, so a server exposing them has one entrance. */
export async function callGraphRead(context: GraphReadContext, call: GraphReadCall): Promise<GraphReadResult> {
  switch (call.tool) {
    case 'describe_scope': return await describeScope(context, call);
    case 'neighbors': return await neighbors(context, call);
    case 'references': return await references(context, call);
    case 'claims_about': return await claimsAbout(context, call);
    case 'coverage': return await coverage(context, call);
    case 'evidence_span': return await evidenceSpan(context, call);
    default: return raise(`${here()}: ${shown((call as { readonly tool?: unknown }).tool)} is no tool of the fill: a unit reads through ${GRAPH_READ_TOOLS.join(', ')}`);
  }
}
