/**
 * The graph's pages (decision 0026, "Pages"; madarch-tzte.23.1): the page-worthy
 * nodes of a product's graph, one node's page model, and the record of what each
 * publication touched — the three answers the background server gives, and the
 * ground the wiki app's live pages stand on (madarch-tzte.23.3).
 *
 * 0026: "Every graph node of a page-worthy kind has a live page at once,
 * rendered from the graph without an agent (facts with code links, relations,
 * diagrams, intent, questions, coverage) and updated in the browser as facts
 * arrive; it is a view, not a file in git." Nothing here writes the graph: the
 * page set, a page and the changes are reads of the fill's own stores
 * (`fact-store.ts`, and the orchestrator's draft rows for the drafts a page
 * shows), and the one row this module's sibling writes — `fill_page_change`,
 * written inside a publication's own transaction by `applyPublishedFacts` — is
 * the publication's own record of the pages it touched.
 *
 * **Which kinds have a page.** A page is *about* one node, so the page-worthy
 * kinds are the ones the product registry may be about: the fact kinds
 * `REGISTRY_KIND_MAPPINGS` gives the role `subject` ("a node such a document may
 * be about — a module, a package, an endpoint — and so a claim's subject"). The
 * role is read from that table and never restated, so a kind the table maps
 * joins the pages by itself: today the repositories, packages, deploy units,
 * API endpoints, tables, columns, environment variables, symbols, entry points,
 * tests, modules, entity proposals, rules, states and questions. A kind of the
 * roles `place` (a file, a directory, a document, a section) and `evidence` (a
 * snapshot, a commit, an occurrence, a comment, a claim, a coverage) has no page
 * of its own: it is where a node lives or what is cited about it, and it is shown
 * on the page of the node it is about, with its code link.
 *
 * **What a page holds.** Its node's own fact (the kind's own value, its code
 * link at the pinned commit, its layer and status); the claims and rules the
 * graph asserts about it, and — apart from them, never mixed in (0005) — the ones
 * an agent inferred; the edges that name it at either end, both ways, each with
 * the place it stands at; the coverage facts that name one of its scopes; its
 * open questions; and the drafts other units hold about it, each marked as a
 * draft. A row that is not a draft is a published fact, and `asDraft` is how a
 * reader tells them apart.
 *
 * **Caps.** A page is read by a person, so its cap is the page's own
 * (`PAGE_ANSWER_TOKENS`, far above the 8K a unit's tool answer holds) and not a
 * unit's window; an answer the cap cut says so in its `marker`, naming what was
 * cut and by which cap — a smaller page is never a silent one.
 *
 * **Order.** Every list is in code point order (`byCodePoint`), never the
 * database's collation: a page is the same on every machine that holds the same
 * facts.
 */
import { byCodePoint } from '../model/order.js';
import type { SqlExecutor } from '../query/sql-driver.js';
import { factsOfWrites, type FactStoreDatabase } from './fact-store.js';
import {
  FACT_EDGE_KINDS,
  isFactId,
  isFactKind,
  type FactEdgeKind,
  type Fact,
  type FactKind,
  type FactLayer,
  type FactStatus,
} from './facts.js';
import type { GraphDiagramsRead } from './graph-diagrams.js';
import {
  answerGraphRead,
  bounded,
  coverage,
  endsOf,
  markerOf,
  factsOfRows,
  estimateTokens,
  graphReadLimits,
  labelOf,
  nodeRefOf,
  type CoverageRow,
  type DraftRow,
  type GraphNodeRef,
  type GraphRead,
  type GraphReadContext,
  type GraphReadLimits,
  type GraphSnapshotSource,
} from './graph-reads.js';
import { here, raise, withLocation } from './fsm-core.js';
import { withDraftParts } from './orchestrator-store.js';
import type { StageDraftWrite } from './stage.js';

// ---------------------------------------------------------------------------------------------
// The page-worthy kinds
// ---------------------------------------------------------------------------------------------

/**
 * Which kinds have a page, and which pages a publication touched, are the rule
 * `page-changes.ts` declares once for the store that writes the change record and
 * for these reads: `PAGE_KINDS` is the registry's own role column (the kinds a
 * document of a registry kind may be about), `isPageId` answers whether an id is a
 * page from the id's own kind, and `pagesTouchedBy` names the pages one
 * publication's facts touch. They are re-exported here because a reader of pages
 * names them, and this module is where pages are read.
 */
export { PAGE_ADDRESS_PREFIX, PAGE_CHANGE_TABLE, PAGE_KINDS, isPageId, isPageKind, pageAddress, pagesTouchedBy } from './page-changes.js';
import { PAGE_KINDS, isPageId, isPageKind, namesFactId, pageAddress } from './page-changes.js';

/**
 * The most tokens one *list* of a page holds: a page is read by a person, so its lists are read under a far wider
 * cap than a unit's 8K window, and each of them is bounded on its own — the facts and the assumptions on one
 * budget, the relations, the questions, the drafts, and the coverage union. A page's whole size is its `tokens`,
 * the sum of its bounded lists, and a list a cap cut says so in `marker` and `truncated`.
 */
export const PAGE_LIST_TOKENS = 32_000;

/** The most page changes one notification's answer holds; a reader past it is told so (see `readPageChanges`). */
export const PAGE_CHANGES_PER_ANSWER = 500;

/**
 * The snapshot a page never reads: a page's code link is the fact's own
 * provenance — the repository, the commit, the file and the line span it was read
 * at — so no byte of a repository is opened for a page, and a read that asked for
 * one is refused by name rather than answered from something else.
 */
const NO_SPANS: GraphSnapshotSource = {
  open: async (repository: string): Promise<never> => raise(`${here()}: the page of a graph node reads no bytes: a page's code link is the fact's own provenance, so the snapshot of "${repository}" is not opened`),
};

/** The caps a page's reads answer within: the page's own, unless a caller names others. */
function pageLimits(limits: Partial<GraphReadLimits> | undefined): GraphReadLimits {
  return graphReadLimits({ answerTokens: PAGE_LIST_TOKENS, ...limits });
}

/** Runs one read of the page's graph inside one transaction of the owner, or the caller's own. */
async function pageTransaction<R>(
  site: string,
  database: FactStoreDatabase,
  operation: string,
  tables: readonly string[],
  work: (executor: SqlExecutor) => Promise<R>,
  kind: 'snapshot' | 'write' = 'snapshot',
): Promise<R> {
  return await withLocation(site, operation, tables, async () => await database.transaction(kind, work));
}

// ---------------------------------------------------------------------------------------------
// What a page shows of one fact
// ---------------------------------------------------------------------------------------------

/** Where a fact stands in code at the commit it was read: the code link a page opens. */
export interface GraphCodeLink {
  /** The product's own name for the repository (decision 0021: never a machine path). */
  readonly repository: string;
  /** The commit the fact was read at, so the link opens the lines the fact is about. */
  readonly commit: string;
  readonly file: string;
  /** The first line of the fact's span, 1-based. */
  readonly startLine: number;
  /** The last line of the fact's span, 1-based; never before `startLine`. */
  readonly endLine: number;
}

/** One fact as a page shows it: what it says, how it was obtained, the status it stands at, and where it is in code. */
export interface GraphPageFact {
  readonly id: string;
  readonly kind: FactKind;
  /** The name a reader knows the fact by (`labelOf`): a claim's own words, a rule's statement, a symbol's name. */
  readonly label: string;
  readonly layer: FactLayer;
  readonly status: FactStatus;
  /** Where the fact stands in code, when its provenance names a place; a fact of a kind that cites none has none. */
  readonly code?: GraphCodeLink;
  /**
   * What a claim names, resolved where the graph holds it: so a page links a claim's
   * subject and object to their own pages. A fact that names no ends (a rule, a
   * module) has none.
   */
  readonly ends?: { readonly subject?: GraphPageNodeRef; readonly object?: GraphPageNodeRef };
}

/** One fact as a page shows it, from the fact itself: its code link is its own provenance. */
export function pageFactOf(fact: Fact): GraphPageFact {
  const place = fact.provenance.place;
  return {
    id: fact.id,
    kind: fact.kind,
    label: labelOf(fact),
    layer: fact.layer,
    status: fact.status,
    ...(place === undefined ? {} : {
      code: {
        repository: fact.provenance.repository.id,
        commit: fact.provenance.repository.commit,
        file: place.file,
        startLine: place.range.startLine,
        endLine: place.range.endLine,
      },
    }),
  };
}

/**
 * One node a page names, with the address of its page where it has one: a client
 * links `page`, and a node of a kind with no page (a file an edge names) has none —
 * so a relation to a file is text and a link to a page is never a 404 by its own
 * construction.
 */
export interface GraphPageNodeRef extends GraphNodeRef {
  /** The address the node's page is served at, when the node's kind has a page (`isPageId`). */
  readonly page?: string;
}

/** One node as a page names it: with its page's address when it has one. */
export function pageRefOf(ref: GraphNodeRef): GraphPageNodeRef {
  return isPageId(ref.id) ? { ...ref, page: pageAddress(ref.id) } : { ...ref };
}

/** One node a page shows, as the page set and every relation names it. */
export interface GraphPageEntry {
  /** The node's fact id: the page's own key and the address's last segment. */
  readonly id: string;
  readonly kind: FactKind;
  /** The name a reader knows it by (`labelOf`). */
  readonly label: string;
  /** The address the wiki app answers the node's page at. */
  readonly page: string;
  readonly layer: FactLayer;
  readonly status: FactStatus;
  /** Where the node's own fact stands in code, when its provenance names a place. */
  readonly code?: GraphCodeLink;
  /** The rank stage 5 measured of the node, when the kind carries one (a module, a file, a symbol; `importance`). */
  readonly importance?: number;
}

/** One page-worthy node as an entry of the page set. */
export function pageEntryOf(fact: Fact): GraphPageEntry {
  const value = (fact.value ?? {}) as unknown as Record<string, unknown>;
  const importance = value['importance'];
  const entry = pageFactOf(fact);
  return {
    id: fact.id,
    kind: fact.kind,
    label: entry.label,
    page: pageAddress(fact.id),
    layer: fact.layer,
    status: fact.status,
    ...(entry.code === undefined ? {} : { code: entry.code }),
    ...(typeof importance === 'number' ? { importance } : {}),
  };
}

/** One edge as a page shows it: which way it stands, the place it stands at, and what is at its other end. */
export interface GraphRelation {
  /** `out` when this page's node is the edge's from end, `in` when it is its to end, `both` when it is both. */
  readonly direction: 'in' | 'out' | 'both';
  readonly edge: GraphPageFact;
  /** The node at the edge's other end, when that end is one the graph holds (or this page's own node). */
  readonly node?: GraphPageNodeRef;
  /**
   * What the other end names when it is no node: a `provides` edge's contract id, a
   * `binds` edge's variable, a `task-key` edge's key. A page shows it as text and
   * links nothing, because the graph holds no page for it.
   */
  readonly end?: string;
}

/** One open question on a page: the question fact's own words and the place it was raised from. */
export interface GraphQuestion {
  readonly id: string;
  /** The kind of question (`assumption-check`, `contradiction`, `unverifiable`). */
  readonly type: string;
  /** What it is about, as the question names it: a fact id, or a scope. */
  readonly about?: string;
  /** The question as a person reads it, one sentence. */
  readonly prompt: string;
  readonly layer: FactLayer;
  readonly status: FactStatus;
  readonly code?: GraphCodeLink;
}

// ---------------------------------------------------------------------------------------------
// The page set
// ---------------------------------------------------------------------------------------------

/** One kind's share of a page set, so a reader sees the whole set's size without counting the list. */
export interface GraphPageCount {
  readonly kind: FactKind;
  readonly count: number;
}

/** A product's page set: every page-worthy node, and what to do when there is none. */
export interface GraphPageSetAnswer {
  /** The product's own name, as its manifest names it: what a fill's runs name it (0027's `product`). */
  readonly product: string;
  /** Every page-worthy node, in code point order of the kind, then the label, then the id. */
  readonly pages: readonly GraphPageEntry[];
  /** How many nodes each kind holds, in code point order of the kind: the whole set's own counts. */
  readonly counts: readonly GraphPageCount[];
  readonly total: number;
  /**
   * The product's latest page change (`fill_page_change.seq`), or 0 when no
   * publication has touched a page yet: a reader subscribes to the live channel
   * from this number (`GET /api/graph/events?after=<seq>`), so no change between
   * this answer and the subscription is lost.
   */
  readonly changeSeq: number;
  /** The moment the set was read, in epoch milliseconds. */
  readonly readAt: number;
  /** What to do when the set is empty (0026: an empty graph answers a message, never an error); null when it holds a page. */
  readonly message: string | null;
}

/**
 * The message an empty page set carries: the fill writes the graph, and the pages
 * come from it (0026, "Pages"). It names no machine path — an answer a browser
 * reads carries the product's name and nothing of this machine's folders.
 */
export function emptyPageSetMessage(product: string): string {
  return `the fill has published no page-worthy node for the product "${product}" yet: the pages are drawn from the graph a fill run writes, and they appear as its units publish`;
}

/** The message a server that holds no fill's graph gives instead of an empty set. */
export const NO_GRAPH_SOURCE_MESSAGE = 'this server holds no fill\'s graph: the pages are read from the fact store the background server owns — start it with "madarch start" and open the product there';

/** One page's row of the set, from the store's own columns. */
interface PageRow extends Record<string, unknown> {
  id: string;
  kind: string;
  schema_version: unknown;
  provenance: unknown;
  layer: string;
  status: string;
  value: unknown;
}

/** The rows of a page's own kind, as the store holds them, read into facts. */
function pageFactsOfRows(rows: readonly unknown[], read: GraphRead): readonly Fact[] {
  return factsOfRows(rows, read);
}

/**
 * One product's page set, read now: every fact of a page-worthy kind that a unit
 * of this product holds (`fill_fact` joined through its holdings onto the unit
 * that published it, `fact-store.ts`), in code point order of the kind, the label
 * and the id. A home's database carries several products' facts, so the join onto
 * `fill_unit.product` is what keeps one product's pages out of another's.
 */
export async function readPageSet(options: { readonly database: FactStoreDatabase; readonly product: string; readonly folder: string; readonly at?: number }): Promise<GraphPageSetAnswer> {
  const at = here();
  const readAt = options.at ?? Date.now();
  return await pageTransaction(at, options.database, `readPageSet(${options.product})`, ['fill_fact', 'fill_fact_holding', 'fill_unit', 'fill_page_change'], async (executor) => {
    const { rows } = await executor.query<PageRow>(
      `SELECT f.id, f.kind, f.schema_version, f.provenance, f.layer, f.status, f.value
         FROM fill_fact f
        WHERE f.kind = ANY($1::text[])
          AND EXISTS (
            SELECT 1 FROM fill_fact_holding h JOIN fill_unit u ON u.unit_id = h.unit_id
             WHERE h.id = f.id AND u.product = $2
          )`,
      [PAGE_KINDS, options.product],
    );
    const facts = pageFactsOfRows(rows, { read: 'facts', ids: rows.map((row) => row.id) });
    const pages = facts.map(pageEntryOf).sort((left, right) => byCodePoint(left.kind, right.kind) || byCodePoint(left.label, right.label) || byCodePoint(left.id, right.id));
    const counts: GraphPageCount[] = [];
    for (const page of pages) {
      const last = counts[counts.length - 1];
      if (last !== undefined && last.kind === page.kind) counts[counts.length - 1] = { kind: last.kind, count: last.count + 1 };
      else counts.push({ kind: page.kind, count: 1 });
    }
    const changeSeq = await latestPageChangeIn(executor, options.product);
    return {
      product: options.product,
      pages,
      counts,
      total: pages.length,
      changeSeq,
      readAt,
      message: pages.length === 0 ? emptyPageSetMessage(options.product) : null,
    };
  });
}

/** The product's latest page change: the number a reader subscribes from (`fill_page_change.seq`), 0 when it has none. */
async function latestPageChangeIn(executor: SqlExecutor, product: string): Promise<number> {
  const { rows } = await executor.query<{ last: unknown }>(
    `SELECT COALESCE(max(c.seq), 0) AS last
       FROM fill_page_change c JOIN fill_unit u ON u.unit_id = c.unit_id
      WHERE u.product = $1`,
    [product],
  );
  const last = rows[0]?.last;
  return typeof last === 'number' ? last : Number(last ?? 0);
}

// ---------------------------------------------------------------------------------------------
// One node's page model
// ---------------------------------------------------------------------------------------------

/** One node's page, whole: its facts, its relations, its coverage, its questions and its drafts. */
export interface GraphPageModelAnswer {
  readonly product: string;
  /** The node this page is about, as the page set names it. */
  readonly node: GraphPageEntry;
  /** The address the page is served at. */
  readonly page: string;
  /** The node fact's own value: the kind's fields, as the stage that read it wrote them. */
  readonly value: unknown;
  /** The facts the graph asserts about the node, the node's own fact first: 0005's declared, extracted and observed ones. */
  readonly facts: readonly GraphPageFact[];
  /** What an agent inferred about the node (0005), kept apart from the facts: the page's assumptions. */
  readonly assumptions: readonly GraphPageFact[];
  /** The edges that name the node at either end, both ways. */
  readonly relations: { readonly out: readonly GraphRelation[]; readonly in: readonly GraphRelation[] };
  /** What is known about the node's scopes, and what could not be read: the coverage facts that name one of `coverageScopes`. */
  readonly coverage: readonly CoverageRow[];
  /** The scope tokens the coverage section was read by, in code point order: the node's own id, its place, and the snapshot its fact was read at. */
  readonly coverageScopes: readonly string[];
  /** The open questions about the node, in code point order of the question's words, then its id. */
  readonly questions: readonly GraphQuestion[];
  /** The writes other units now hold about the node, each marked as a draft and never mixed into the facts. */
  readonly drafts: readonly DraftRow[];
  readonly counts: { readonly facts: number; readonly assumptions: number; readonly out: number; readonly in: number; readonly coverage: number; readonly questions: number; readonly drafts: number };
  /** Whether a cap cut this page: true only when something a page should hold is not in it. */
  readonly truncated: boolean;
  /** What was cut and by which cap, or null when nothing was cut. */
  readonly marker: string | null;
  /**
   * The page's own size, by the fill's estimate (four code points a token): every
   * list of the page was read under the page's cap (`PAGE_ANSWER_TOKENS`), and a
   * page holds one capped answer per list (its facts and assumptions, its
   * relations, each coverage scope, its questions, its drafts), so this is the whole
   * of it as a reader receives it.
   */
  readonly tokens: number;
  readonly readAt: number;
}

/** One page asked for: the page, or the refusal naming why the graph holds none. */
export type GraphPageModelRead =
  | { readonly ok: true; readonly page: GraphPageModelAnswer }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * One node's page, read now from the fact store. A node the graph does not hold,
 * a fact of a kind that has no page, and a node whose fact another product's units
 * published are each refused by name: a page about nothing would read as an
 * absence nobody stated (0005 makes a coverage, not a silence, the ground of one).
 */
export async function readPageModel(options: {
  readonly database: FactStoreDatabase;
  readonly product: string;
  readonly id: string;
  readonly limits?: Partial<GraphReadLimits>;
  readonly at?: number;
}): Promise<GraphPageModelRead> {
  const at = here();
  const id = options.id;
  if (!isFactId(id)) {
    return { ok: false, code: 'graph-pages/not-a-fact-id', message: `"${id}" is no fact id: a page is named by the fact id of its node (a kind, a colon and the 64 lower-case hexadecimal digits of the fact's identity)` };
  }
  if (isPageId(id) === false) {
    const kind = id.slice(0, id.indexOf(':'));
    return {
      ok: false,
      code: 'graph-pages/not-a-page',
      message: `the node ${id} is ${isFactKind(kind) ? `a "${kind}" fact` : 'no fact of a kind this graph reads'}, and no page exists for that kind: a page exists for ${PAGE_KINDS.join(', ')} (decision 0026, "Pages"; the kinds a registry document may be about)`,
    };
  }
  const readAt = options.at ?? Date.now();
  const limits = pageLimits(options.limits);
  // One transaction for the whole page: every read of it sees the same store, so a page can never show a fact
  // and then a relation that the publication in between took away, and one page read is one transaction of the
  // process's single connection rather than a dozen.
  const read = await pageTransaction<PageReadOutcome>(at, options.database, `readPageModel(${id})`, ['fill_fact', 'fill_fact_holding', 'fill_unit', 'fill_unit_draft', 'fill_unit_draft_part', 'fill_unit_plan', 'fill_publication'], async (executor) => {
    // Every read of a page is scoped to its product: a home's store carries every product's facts, and two
    // products that declare a repository of the same name publish facts of one id.
    const scoped = (request: GraphRead): GraphRead => withProduct(request, options.product);
    const context: GraphReadContext = {
      limits,
      read: async (request: GraphRead): Promise<readonly unknown[]> => await answerGraphRead({ database: options.database, snapshot: NO_SPANS, executor }, scoped(request)),
    };
    const nodeRead: GraphRead = { read: 'fact', id, product: options.product };
    const node = factsOfRows(await context.read(nodeRead), nodeRead)[0];
    if (node === undefined) return { refusal: { ok: false as const, code: 'graph-pages/no-such-node', message: `the graph holds no "${id.slice(0, id.indexOf(':'))}" fact of the id ${id} among the facts the product "${options.product}" publishes: a page is read after the unit that publishes its node (decision 0026)` } };
    const claimsReads: readonly GraphRead[] = [
      { read: 'facts-with', kind: 'claim', field: 'subject.id', value: id },
      { read: 'facts-with', kind: 'claim', field: 'object.id', value: id },
    ];
    const rulesRead: GraphRead = { read: 'facts-with', kind: 'rule', field: 'subject', value: id };
    const questionsRead: GraphRead = { read: 'facts-with', kind: 'question', field: 'about', value: id };
    const edgesRead: GraphRead = { read: 'adjacent', id, kinds: FACT_EDGE_KINDS };
    const claimFacts = new Map<string, Fact>();
    for (const claimRead of claimsReads) for (const fact of factsOfRows(await context.read(claimRead), claimRead)) claimFacts.set(fact.id, fact);
    const ruleFacts = factsOfRows(await context.read(rulesRead), rulesRead);
    const questionFacts = factsOfRows(await context.read(questionsRead), questionsRead);
    const edgeFacts = factsOfRows(await context.read(edgesRead), edgesRead);
    // The node's own fact stands first, and the facts about it follow in code point order of their ids: a reader
    // asks "what is this" before "what is said about it".
    const facts = [node, ...[...claimFacts.values()], ...ruleFacts].sort((left, right) => (left.id === node.id ? -1 : right.id === node.id ? 1 : 0) || byCodePoint(left.id, right.id));
    // The nodes the edges and the claims name: one read, so every relation and every claim's ends carry the label
    // of the node they name where the graph holds it.
    const named = new Set<string>();
    for (const edge of edgeFacts) {
      const ends = endsOf(edge.kind as FactEdgeKind, edge.value);
      for (const end of [ends.from, ends.to]) if (end !== undefined && end !== id) named.add(end);
    }
    for (const claim of [...claimFacts.values()]) {
      for (const field of ['subject', 'object'] as const) {
        const end = termOf(claim, field);
        if (end !== undefined && end !== id) named.add(end);
      }
    }
    const refs = await nodeRefsOf(context, [...named]);
    // The page's own node is one of the ends a claim or an edge of it may name, and its label is already in hand.
    refs.set(id, nodeRefOf(node));
    // A `provides` edge names its endpoint by the contract's own id, and the graph holds the endpoint's node: the
    // page links it. The contracts are read once, before the relations are made.
    const contracts = await contractNodes(context, edgeFacts);
    const relations: GraphRelation[] = [];
    for (const edge of edgeFacts) {
      const ends = endsOf(edge.kind as FactEdgeKind, edge.value);
      const out = ends.from === id;
      const into = ends.to === id;
      const direction: GraphRelation['direction'] = out && into ? 'both' : out ? 'out' : 'in';
      const other = direction === 'in' ? ends.from : ends.to;
      const contract = edge.kind === 'provides' ? ((edge.value ?? {}) as unknown as Record<string, unknown>)['contract'] : undefined;
      const contracted = typeof contract === 'string' ? contracts.get(contract) : undefined;
      const found = other === undefined ? contracted : other === id ? nodeRefOf(node) : refs.get(other) ?? { id: other, kind: null, label: other };
      const neighbour = found === undefined ? undefined : pageRefOf(found);
      // An edge whose other end is no fact id names something the graph holds no node for (an environment, a task
      // key, an address outside the repositories): the page shows what it names and links nothing, and a relation
      // always says what it joins — the edge's own id is the last resort.
      const end = neighbour === undefined ? textEndOf(edge, direction === 'in' ? 'from' : 'to') ?? edge.id : undefined;
      relations.push({ direction, edge: pageFactOf(edge), ...(neighbour === undefined ? {} : { node: neighbour }), ...(end === undefined ? {} : { end }) });
    }
    relations.sort((left, right) => byCodePoint(left.edge.kind, right.edge.kind) || byCodePoint(left.node?.label ?? left.end ?? '', right.node?.label ?? right.end ?? '') || byCodePoint(left.edge.id, right.edge.id) || byCodePoint(left.node?.id ?? '', right.node?.id ?? ''));
    const scopeTokens = await coverageScopesOf(executor, options.product, node);
    const coverageRows: CoverageRow[] = [];
    const markers: string[] = [...scopeTokens.markers];
    for (const scope of scopeTokens.scopes) {
      const answer = await coverage(context, { tool: 'coverage', scope });
      for (const row of answer.rows) coverageRows.push(row);
      if (answer.marker !== null) markers.push(answer.marker);
    }
    const everyCoverage = [...new Map(coverageRows.map((row) => [row.id, row])).values()].sort((left, right) => byCodePoint(left.scope, right.scope) || byCodePoint(left.id, right.id));
    // The coverage of every scope is one list of the page, so it is bounded as one: three scopes each read under a
    // cap of their own would be three caps, not the page's.
    const coverageHeld = bounded(everyCoverage, limits, `the coverage the page of ${id} shows`, limits.answerTokens);
    const coverageScopes = coverageHeld.rows.length === 0 ? [] : [...new Set(coverageHeld.rows.map((row) => row.scope))].sort(byCodePoint);
    const uniqueCoverage = coverageHeld.rows;
    const questions: GraphQuestion[] = questionFacts.map((fact) => questionOf(fact)).sort((left, right) => byCodePoint(left.prompt, right.prompt) || byCodePoint(left.id, right.id));
    // A claim names two ends, and a page links them to their own pages: the nodes were read once, above, with the
    // nodes the edges name, so a claim about a module costs no read of its own.
    const pageFacts = facts.map((fact) => fact.kind === 'claim' ? { ...pageFactOf(fact), ends: claimEndsOf(fact, refs) } : pageFactOf(fact));
    // Every list of a page is read under the page's own cap, and a list the cap cut says what it cut and by which
    // cap: a smaller page is never a silent one (0026's "no silently smaller result").
    const drafts = sortDrafts(await readPageDraftsIn(executor, options.product, id));
    const factsHeld = bounded(pageFacts, limits, `the facts the page of ${id} shows`, limits.answerTokens);
    const assumptionsHeld = bounded(factsHeld.rows.filter((fact) => fact.layer === 'inferred'), limits, `the assumptions the page of ${id} shows`, limits.answerTokens);
    const assertedHeld = factsHeld.rows.filter((fact) => fact.layer !== 'inferred');
    const relationsHeld = bounded(relations, limits, `the relations of ${id}`, limits.answerTokens);
    const questionsHeld = bounded(questions, limits, `the questions about ${id}`, limits.answerTokens);
    const draftsHeld = bounded(drafts, limits, `the drafts about ${id}`, limits.answerTokens);
    const cut = [factsHeld.marker, relationsHeld.marker, coverageHeld.marker, questionsHeld.marker, draftsHeld.marker, ...markers];
    const out = relationsHeld.rows.filter((relation) => relation.direction !== 'in');
    const into = relationsHeld.rows.filter((relation) => relation.direction !== 'out');
    const body: Omit<GraphPageModelAnswer, 'tokens'> = {
      product: options.product,
      node: pageEntryOf(node),
      page: pageAddress(id),
      value: node.value,
      facts: assertedHeld,
      assumptions: assumptionsHeld.rows,
      relations: { out, in: into },
      coverage: uniqueCoverage,
      coverageScopes,
      questions: questionsHeld.rows,
      drafts: draftsHeld.rows,
      counts: {
        facts: assertedHeld.length,
        assumptions: assumptionsHeld.rows.length,
        out: out.length,
        in: into.length,
        coverage: uniqueCoverage.length,
        questions: questionsHeld.rows.length,
        drafts: draftsHeld.rows.length,
      },
      truncated: cut.some((marker) => marker !== null),
      marker: markerOf(...cut),
      readAt,
    };
    const page: GraphPageModelAnswer = { ...body, tokens: estimateTokens(JSON.stringify({ ...body, tokens: 0 }), limits) };
    return { page };
  });
  if ('refusal' in read) return read.refusal;
  return { ok: true as const, page: read.page };
}

/** What one page read inside its transaction answers: the page, or the refusal naming why the graph holds none. */
type PageReadOutcome = { readonly refusal: Extract<GraphPageModelRead, { readonly ok: false }> } | { readonly page: GraphPageModelAnswer };

/** The product a store read of a page is scoped to: the field the read layer's own reads take (`graph-reads.ts`). */
function withProduct(request: GraphRead, product: string): GraphRead {
  switch (request.read) {
    case 'fact':
    case 'facts':
    case 'adjacent':
    case 'facts-with':
    case 'held':
      return { ...request, product };
    default:
      return request;
  }
}

/** The drafts a page shows, in code point order of the holding unit and its generation: never the database's collation. */
function sortDrafts(drafts: readonly DraftRow[]): readonly DraftRow[] {
  return [...drafts].sort((left, right) => byCodePoint(left.unit, right.unit) || left.generation - right.generation);
}

/**
 * What an edge names at one end, where that end is no fact id: a `provides` edge's
 * contract, a `task-key` edge's key, a `binds` edge's environment, a
 * `document-link` edge's address outside the repositories. The table is the read
 * layer's own (`EDGE_END_FIELDS`) for the ends that are nodes, and this one names
 * the fields of the ends that are not.
 */
const EDGE_TEXT_END_FIELDS: { readonly [K in FactEdgeKind]?: { readonly from?: string; readonly to?: string } } = {
  provides: { to: 'contract' },
  'task-key': { to: 'key' },
  binds: { to: 'environment' },
};

/**
 * The endpoint each contract a `provides` edge names belongs to: a contract is an
 * `api-endpoint` node's own identity (`ApiEndpointValue.contract`), so an edge whose
 * other end is no fact id still reaches the node whose page shows the endpoint. One
 * read per distinct contract, and a contract no endpoint of this product holds is no
 * node — the page shows it as text.
 */
async function contractNodes(context: GraphReadContext, edges: readonly Fact[]): Promise<Map<string, GraphNodeRef>> {
  const wanted = [...new Set(edges
    .filter((edge) => edge.kind === 'provides')
    .map((edge) => ((edge.value ?? {}) as unknown as Record<string, unknown>)['contract'])
    .filter((contract): contract is string => typeof contract === 'string' && contract !== ''))].sort(byCodePoint);
  const nodes = new Map<string, GraphNodeRef>();
  for (const contract of wanted) {
    const read: GraphRead = { read: 'facts-with', kind: 'api-endpoint', field: 'contract', value: contract };
    const found = factsOfRows(await context.read(read), read);
    const endpoint = found[0];
    if (endpoint !== undefined) nodes.set(contract, nodeRefOf(endpoint));
  }
  return nodes;
}

/** What an edge names at one end, where that end is no fact id (see `EDGE_TEXT_END_FIELDS`); undefined where it names nothing readable. */
function textEndOf(edge: Fact, side: 'from' | 'to'): string | undefined {
  const value = (edge.value ?? {}) as unknown as Record<string, unknown>;
  const field = EDGE_TEXT_END_FIELDS[edge.kind as FactEdgeKind]?.[side];
  const at = field === undefined ? undefined : value[field];
  if (typeof at === 'string') return at === '' ? undefined : at;
  // A `document-link` names its object as a term, and a term that is no node is an address outside the
  // repositories or a literal: the page shows it as text.
  if (edge.kind === 'document-link' && side === 'to') {
    const term = value['to'];
    if (term === null || typeof term !== 'object' || Array.isArray(term)) return undefined;
    const fields = term as Record<string, unknown>;
    for (const key of ['url', 'text'] as const) if (typeof fields[key] === 'string' && fields[key] !== '') return fields[key] as string;
  }
  return undefined;
}

/** The two ends a claim names, as the nodes read above answer them; an end the claim does not name a node for is left out. */
function claimEndsOf(claim: Fact, refs: ReadonlyMap<string, GraphNodeRef>): { readonly subject?: GraphPageNodeRef; readonly object?: GraphPageNodeRef } {
  const subject = termOf(claim, 'subject');
  const object = termOf(claim, 'object');
  return {
    ...(subject === undefined ? {} : { subject: pageRefOf(refs.get(subject) ?? { id: subject, kind: null, label: subject }) }),
    ...(object === undefined ? {} : { object: pageRefOf(refs.get(object) ?? { id: object, kind: null, label: object }) }),
  };
}

/** The fact id one end of a claim names, when it names a node. */
function termOf(claim: Fact, field: 'subject' | 'object'): string | undefined {
  const value = (claim.value ?? {}) as unknown as Record<string, unknown>;
  const entry = value[field];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  const fields = entry as Record<string, unknown>;
  if (fields['form'] !== 'node') return undefined;
  return typeof fields['id'] === 'string' ? fields['id'] : undefined;
}

/** The nodes the given ids name, as one read answers them: the id itself where the graph holds no such fact. */
async function nodeRefsOf(context: GraphReadContext, ids: readonly string[]): Promise<Map<string, GraphNodeRef>> {
  const wanted = [...new Set(ids)].sort(byCodePoint);
  const refs = new Map<string, GraphNodeRef>();
  if (wanted.length === 0) return refs;
  const read: GraphRead = { read: 'facts', ids: wanted };
  for (const fact of factsOfRows(await context.read(read), read)) refs.set(fact.id, nodeRefOf(fact));
  return refs;
}

/** One question fact as a page shows it, refused by name where the value is not the kind's own shape. */
function questionOf(fact: Fact): GraphQuestion {
  const value = (fact.value ?? {}) as unknown as Record<string, unknown>;
  const type = value['type'];
  const prompt = value['prompt'];
  if (typeof type !== 'string' || type === '') raise(`${here()}: the question ${fact.id} names the type ${JSON.stringify(type)}: a question's type is one lower-case kebab token (src/fill/facts.ts)`);
  if (typeof prompt !== 'string' || prompt === '') raise(`${here()}: the question ${fact.id} carries the prompt ${JSON.stringify(prompt)}: a question is one sentence a person answers`);
  const about = value['about'];
  const place = fact.provenance.place;
  return {
    id: fact.id,
    type,
    ...(typeof about === 'string' ? { about } : {}),
    prompt,
    layer: fact.layer,
    status: fact.status,
    ...(place === undefined ? {} : {
      code: {
        repository: fact.provenance.repository.id,
        commit: fact.provenance.repository.commit,
        file: place.file,
        startLine: place.range.startLine,
        endLine: place.range.endLine,
      },
    }),
  };
}

/**
 * The scope tokens a page's coverage section is read by, in code point order: the
 * node's own fact id (an agent stage keys its coverage by its scope node, 0026's
 * unit), the node's place as the fill spells a scope (`<repository>:<path>`, what
 * the inventory and the build stage's file units name), and the snapshot fact of
 * the commit the node was read at (stage 5 keys a repository's coverage by the
 * snapshot it read, madarch-tzte.21.7). A token the graph holds no coverage of
 * simply answers none.
 */
/** The most snapshot facts of one commit a page's coverage section reads: a commit carries one per reader, and a
 * page reads that many rather than every reader the repository ever had; a longer list is named in the marker. */
export const PAGE_SNAPSHOT_SCOPES = 8;

/** The coverage scope tokens of one page, and the marker that says which of them a bound left out. */
interface PageCoverageScopes {
  readonly scopes: readonly string[];
  /** One sentence per cut this read made (`PAGE_SNAPSHOT_SCOPES`), in code point order; empty when nothing was cut. */
  readonly markers: readonly string[];
}

async function coverageScopesOf(executor: SqlExecutor, product: string, node: Fact): Promise<PageCoverageScopes> {
  const tokens = new Set<string>([node.id]);
  const place = node.provenance.place;
  const repository = node.provenance.repository.id;
  if (place !== undefined) tokens.add(`${repository}:${place.file}`);
  const commit = node.provenance.repository.commit;
  if (commit !== '') {
    // The snapshot facts of that repository and commit, read on the page's own transaction and scoped to its
    // product: a snapshot another product's unit published is no scope of this page.
    const { rows } = await executor.query<{ id: string }>(
      `SELECT f.id FROM fill_fact f
        WHERE f.kind = 'snapshot' AND f.value->>'repository' = $1 AND f.value->>'commit' = $2
          AND EXISTS (SELECT 1 FROM fill_fact_holding h JOIN fill_unit u ON u.unit_id = h.unit_id WHERE h.id = f.id AND u.product = $3)
        ORDER BY f.id ASC`,
      [repository, commit, product],
    );
    const snapshots = rows.map((row) => row.id).sort(byCodePoint);
    for (const id of snapshots.slice(0, PAGE_SNAPSHOT_SCOPES)) tokens.add(id);
    if (snapshots.length > PAGE_SNAPSHOT_SCOPES) {
      return {
        scopes: [...tokens].sort(byCodePoint),
        markers: [`truncated: the coverage of ${node.id} reads the first ${PAGE_SNAPSHOT_SCOPES} snapshot facts of commit ${commit} and the graph holds ${snapshots.length}: ${snapshots.length - PAGE_SNAPSHOT_SCOPES} scopes were cut`],
      };
    }
  }
  return { scopes: [...tokens].sort(byCodePoint), markers: [] };
}

// ---------------------------------------------------------------------------------------------
// The drafts a page shows
// ---------------------------------------------------------------------------------------------

/** One draft set as the store holds it: its unit, its generation, the writes, and the scope its plan named. */
interface DraftSetRow extends Record<string, unknown> {
  unit_id: unknown;
  generation: unknown;
  writes: unknown;
  scope: unknown;
}

/**
 * The drafts a page shows: the writes other units of this product hold now that
 * name the node — whose fact is the node itself or names it anywhere in its value
 * (the rule the read layer's own `drafts` read applies, `graph-reads.ts`) — each
 * marked as a draft. The read layer's `drafts` read is bound to one run and to a
 * reading generation (0026 makes a draft visible to *other* units of a run); a
 * page belongs to no run and to no unit, so it reads its product's live draft sets
 * itself: retracted sets, published sets and sets whose unit is not this product's
 * are not drafts a page shows. A draft set, or a write, the store holds that is
 * not one the schema's write path makes is refused by name, never skipped.
 */
async function readPageDraftsIn(executor: SqlExecutor, product: string, id: string): Promise<readonly DraftRow[]> {
  const { rows: heads } = await executor.query<DraftSetRow>(
    `SELECT d.unit_id, d.generation, d.writes, p.scope
       FROM fill_unit_draft d
       JOIN fill_unit_plan p ON p.unit_id = d.unit_id AND p.generation = d.generation
       JOIN fill_unit u ON u.unit_id = d.unit_id
      WHERE u.product = $1
        AND d.retracted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM fill_publication f WHERE f.unit_id = d.unit_id AND f.generation = d.generation)
      ORDER BY d.unit_id ASC, d.generation ASC`,
    [product],
  );
  const rows = await withDraftParts(executor, heads);
  const kept: DraftRow[] = [];
  for (const row of rows) {
    const unit = row.unit_id;
    if (typeof unit !== 'string' || unit === '') raise(`${here()}: a draft set of the product "${product}" names the unit ${JSON.stringify(unit)}: every draft set belongs to a unit of a stage`);
    const generation = Number(row.generation);
    if (!Number.isInteger(generation) || generation < 1) raise(`${here()}: the draft set of ${unit} is at generation ${JSON.stringify(row.generation)}: a generation is a whole number, one or more`);
    const scope = row.scope;
    if (typeof scope !== 'string' || scope === '') raise(`${here()}: the draft set of ${unit}/${generation} names no scope: the plan row of a unit names what it covers`);
    const writes = row.writes;
    if (!Array.isArray(writes)) raise(`${here()}: the draft set of ${unit}/${generation} carries ${JSON.stringify(writes)} as its writes: a draft set is a list of writes`);
    writes.forEach((write: unknown, index: number) => {
      const entry = (write ?? {}) as Record<string, unknown>;
      // A write that names nothing on this page is not this page's business, and it is skipped before it is judged:
      // one older or damaged draft set elsewhere in the product must not make every page unreadable.
      if (namesFactId(entry['value'], id) === false) return;
      const evidence = entry['evidence'];
      if (typeof evidence !== 'string') raise(`${here()}: the draft write at position ${index + 1} of ${unit}/${generation} cites ${JSON.stringify(evidence)}: every write cites what it stands on`);
      // The row is JSON read back from the store: `factsOfWrites` is the one check of what a draft write is, and a
      // write it refuses is refused here by name (the store's own read of a draft set refuses the same way).
      const read = factsOfWrites([write as StageDraftWrite]);
      const problem = read.problems[0];
      if (problem !== undefined) {
        raise(`${here()}: the draft write at position ${index + 1} of ${unit}/${generation} is not a fact the schema reads (${problem.path === '' ? problem.message : `${problem.path}: ${problem.message}`}): a page never shows a write the schema refuses`);
      }
      const fact = read.facts[0];
      if (fact === undefined) return;
      kept.push({ asDraft: true, unit, generation, scope, write: (entry['kind'] ?? 'fact') as StageDraftWriteKind, evidence, fact });
    });
  }
  return kept;
}

/** One draft write's kind, as `src/fill/stage.ts` names it. */
type StageDraftWriteKind = 'fact' | 'entity' | 'link' | 'question';

// ---------------------------------------------------------------------------------------------
// What a publication changed
// ---------------------------------------------------------------------------------------------

/** One product's graph pages as a server reads them: the page set, one page's model, the changes, and the wake-up a publication gives. */
export interface GraphPagesSource {
  /** The product's page set, read now. */
  readonly pageSet: () => Promise<GraphPageSetAnswer>;
  /** One node's page model, or the refusal naming why the graph holds none. */
  readonly page: (id: string) => Promise<GraphPageModelRead>;
  /**
   * One node's diagrams (madarch-tzte.23.4): the models the page's own kind is
   * drawn by, built from the same store the page is, or the page's own refusal.
   */
  readonly diagrams: (id: string) => Promise<GraphDiagramsRead>;
  /** The page changes after one sequence number, in publication order. */
  readonly changes: (after: number) => Promise<GraphPageChanges>;
  /**
   * Hears that something may have been published: the listener reads the changes
   * itself, so a wake-up is a hint and never a payload a failed read could lose.
   * The answer ends the subscription.
   */
  readonly subscribe: (listener: () => void) => () => void;
}

/** One page change as a client receives it: the publication, and the pages it touched. */
export interface GraphPageChange {
  /** The store's own sequence number of the publication's last change row: what a client resumes from. */
  readonly seq: number;
  /** The pages the publication touched, in code point order. */
  readonly nodes: readonly string[];
  readonly unitId: string;
  readonly generation: number;
  readonly publication: string;
}

/** What one read of the changes answers. */
export interface GraphPageChanges {
  readonly changes: readonly GraphPageChange[];
  /** The latest change the product holds after this read: the number a client resumes from. */
  readonly lastSeq: number;
  /** Whether the read stopped at its own bound and more changes stand past it (`PAGE_CHANGES_PER_ANSWER`). */
  readonly truncated: boolean;
  readonly marker: string | null;
}

/**
 * The page changes a product's publications made after one sequence number, in the
 * order they were published, one change per publication: the record
 * `applyPublishedFacts` writes inside the publication's own transaction, so a
 * change is a change only once its facts are committed, and a rolled-back
 * publication announces nothing.
 */
export async function readPageChanges(options: { readonly database: FactStoreDatabase; readonly product: string; readonly after: number; readonly limit?: number }): Promise<GraphPageChanges> {
  const at = here();
  const limit = options.limit ?? PAGE_CHANGES_PER_ANSWER;
  if (!Number.isInteger(limit) || limit < 1) raise(`${at}: the page changes are read ${limit} rows at a time: a read holds at least one`);
  return await pageTransaction(at, options.database, `readPageChanges(${options.product}, after ${options.after})`, ['fill_page_change', 'fill_unit'], async (executor) => {
    // One row past the bound is read as well: a change is one publication, and a publication whose pages do not
    // all fit in one answer is never answered in part (that answer would name some of the pages it touched as if
    // they were all of them). The extra row is what tells a full answer from a cut one.
    const { rows } = await executor.query<{ seq: unknown; node_id: string; unit_id: string; generation: unknown; publication: string }>(
      `SELECT c.seq, c.node_id, c.unit_id, c.generation, c.publication
         FROM fill_page_change c JOIN fill_unit u ON u.unit_id = c.unit_id
        WHERE u.product = $1 AND c.seq > $2
        ORDER BY c.seq ASC
        LIMIT $3`,
      [options.product, options.after, limit + 1],
    );
    const changes: GraphPageChange[] = [];
    for (const row of rows) {
      const seq = typeof row.seq === 'number' ? row.seq : Number(row.seq);
      const generation = typeof row.generation === 'number' ? row.generation : Number(row.generation);
      const last = changes[changes.length - 1];
      if (last !== undefined && last.publication === row.publication && last.unitId === row.unit_id && last.generation === generation) {
        changes[changes.length - 1] = { ...last, seq, nodes: [...last.nodes, row.node_id].sort(byCodePoint) };
        continue;
      }
      changes.push({ seq, nodes: [row.node_id], unitId: row.unit_id, generation, publication: row.publication });
    }
    const lastSeq = await latestPageChangeIn(executor, options.product);
    // The bound cut the answer when there is a row past it. That row may continue the last change, and a change
    // is answered whole or not at all: the group it belongs to is left for the next read. A bound of one row
    // that the first change already fills is answered as that change, partly, and the marker says which pages
    // stand past it — a reader that could hold nothing would loop for ever on one publication.
    const past = rows.length > limit;
    const held = past && changes.length > 1 ? changes.slice(0, -1) : changes;
    const truncated = past;
    return {
      changes: held,
      lastSeq,
      truncated,
      marker: truncated
        ? `truncated: the changes after ${options.after} hold more than the ${limit} page rows one answer reads (the product's latest is ${lastSeq}): read again from ${held[held.length - 1]?.seq ?? options.after} for the rest`
        : null,
    };
  });
}
