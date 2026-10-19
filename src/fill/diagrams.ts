/**
 * The graph's diagram models (decision 0026, "Diagrams"; madarch-tzte.23.2): an
 * agent, or a page, chooses what to show as a *view specification* — the type,
 * the nodes, the scenario and the level — and this module turns it into a model
 * a renderer draws, read from the product graph and never pasted into a prompt.
 *
 * 0026 fixes what a diagram means and this module is the whole of it:
 *
 * - **The types are the graph's.** Seven types are drawn here of the nine 0026
 *   names: C4 context, container and component, module dependencies, ER (tables
 *   and columns), state (states and transitions) and sequence (interactions).
 *   Activity, class and deployment diagrams need fact kinds the schema does not
 *   hold yet, and a type nothing can be read for is not offered.
 * - **The view is checked against the graph.** A node the graph does not hold,
 *   a node of a kind the type cannot be made of, a level the type does not have
 *   and a scenario another type was given are each refused by name: a model
 *   built from a spec the graph does not answer would read as a diagram of
 *   nothing.
 * - **Facts are solid, assumptions and unresolved ends are dashed.** A fact's
 *   own `layer` and `status` say which it is (0005): an `inferred` fact is an
 *   agent's reading and a `rejected` declaration is one a person turned down, so
 *   both are dashed and marked `assumption`; every other fact is solid. An edge
 *   an end of which the graph does not hold any more is `unresolved`, dashed,
 *   and its missing end stands as a placeholder element — the graph names the
 *   end and no unit holds it, which is exactly what a reader must see.
 * - **Everything links.** Every element carries the address of its page and,
 *   where its provenance names one, the code place it stands at. The address is
 *   made in one function (`graphPageHref`), which is the one place a served
 *   route moves.
 * - **A diagram stays readable by size.** Past the node budget the view
 *   collapses to the level above — a module to its parent module or its
 *   repository, a container or a table to its repository — and every collapsed
 *   element carries the view it stands for as its drill-down link. Nothing is
 *   ever dropped: an element that stands for others says how many, and a view
 *   whose budget cannot be met at all says that instead of drawing fewer nodes.
 *
 * The module is pure: it reads the graph through `DiagramGraphReads` and writes
 * nothing. `factStoreDiagramReads` is that interface over the landed fact store
 * (`fact-store.ts`, the `fill_fact` rows), in a read-only transaction, and it is
 * the only part of this file that touches a database. Rendering the model is
 * madarch-tzte.23.4's, and serving the pages the elements link to is
 * madarch-tzte.23.1's: nothing here draws a line or answers a request.
 */
import { byCodePoint } from '../model/order.js';
import type { SqlExecutor } from '../query/sql-driver.js';
import { FACT_EDGE_KINDS, isFactId, type Fact, type FactEdgeKind, type FactNodeKind } from './facts.js';
import { FACT_STORE_TABLES, type FactStoreDatabase } from './fact-store.js';
import { here, raise, withLocation } from './fsm-core.js';
import { EDGE_END_FIELDS, endsOf, labelOf } from './graph-reads.js';

// ---------------------------------------------------------------------------------------------
// What a diagram is
// ---------------------------------------------------------------------------------------------

/**
 * The diagram types drawn from the graph, in code point order. 0026's list is
 * nine: these seven are the ones the schema's kinds answer, and `activity`,
 * `class` and `deployment` are named there as the types still owed a kind
 * (madarch-tzte.23.2's record says so).
 */
export const DIAGRAM_TYPES = ['c4-component', 'c4-container', 'c4-context', 'er', 'module-dependency', 'sequence', 'state'] as const;
export type DiagramType = (typeof DIAGRAM_TYPES)[number];

/** How a fact stands behind what a diagram shows (0005): a fact, an assumption, or an end the graph does not hold. */
export type DiagramEvidence = 'assumption' | 'fact' | 'unresolved';

/**
 * The view specification 0026 gives an agent: what to show, and nothing about
 * how it is drawn. `nodes` are the things the view is about — fact ids — and
 * each type says which kinds it can be made of (`DIAGRAM_TYPE_DECLARATIONS`);
 * left empty, a view is of the whole product. `scenario` is a sequence's steps
 * in the order the scenario takes them: the graph holds no order between
 * interactions, so the order is the chooser's, which is what 0026 means by "an
 * agent only chooses what to show". `level` is a C4 type's own level where the
 * spec names one, and module-dependency's depth under the scopes it names.
 */
export interface DiagramViewSpec {
  readonly type: DiagramType;
  readonly nodes: readonly string[];
  readonly scenario?: readonly string[];
  readonly level?: number;
}

/** The size a diagram is held to: how many elements it may show before it collapses to the level above. */
export interface DiagramLimits {
  readonly nodes: number;
}

/**
 * The elements a view may show before it collapses. 0026 bounds a diagram by
 * what a reader can still read, and names no number; forty is this module's,
 * chosen so a C4 or module diagram of a mid-sized repository still carries its
 * labels, and a product that wants another number sets it (`buildDiagram`'s
 * `limits`).
 */
export const DEFAULT_DIAGRAM_NODE_BUDGET = 40;

/** Where an element stands in code: the file, at the pinned commit, and the lines it spans. */
export interface DiagramPlace {
  /** The product's own name for the repository the place stands in. */
  readonly repository: string;
  /** The commit the fact was read at, 40 lower-case hexadecimal digits: a place is opened at one commit. */
  readonly commit: string;
  readonly file: string;
  readonly line: number;
  readonly endLine: number;
}

/** The page an element opens: the graph node's own address, made by `graphPageHref`. */
export interface DiagramPage {
  readonly id: string;
  readonly href: string;
}

/** One column of a table, as an ER diagram shows it: an attribute of the table's box, not a box of its own. */
export interface DiagramColumn {
  readonly id: string;
  readonly label: string;
  readonly dataType?: string;
  readonly evidence: DiagramEvidence;
  readonly dashed: boolean;
  readonly page: DiagramPage;
  readonly place?: DiagramPlace;
}

/** The view a collapsed element stands for: the same diagram, scoped to the elements it folded. */
export interface DiagramDrillDown {
  readonly type: DiagramType;
  readonly level: number;
  /** The elements the collapsed one stands for, in code point order. */
  readonly nodes: readonly string[];
  readonly href: string;
}

/** One element a diagram shows: a graph node, or an end the graph does not hold. */
export interface DiagramElement {
  /** The graph node's fact id; for an end the graph does not hold, an id prefixed `unresolved:` that no fact can carry. */
  readonly id: string;
  /** The fact's kind, or null for an end the graph does not hold. */
  readonly kind: FactNodeKind | null;
  readonly label: string;
  readonly evidence: DiagramEvidence;
  /** Whether the element is drawn dashed: an assumption, or an end the graph does not hold. */
  readonly dashed: boolean;
  /** The element's page; absent for an end the graph does not hold, which has no page to open. */
  readonly page?: DiagramPage;
  readonly place?: DiagramPlace;
  /** A table's columns, in code point order of their labels; present on an ER diagram's tables. */
  readonly columns?: readonly DiagramColumn[];
  /** What this element stands for once the node budget collapsed the view, in code point order; absent when it stands for itself. */
  readonly standsFor?: readonly string[];
  /** The view this element opens, when it stands for others. */
  readonly drillDown?: DiagramDrillDown;
}

/** One arrow a diagram draws: two elements, what it is called, and the facts behind it. */
export interface DiagramEdge {
  readonly from: string;
  readonly to: string;
  readonly label: string;
  /** The kinds of the facts behind the arrow, in code point order. */
  readonly kinds: readonly FactEdgeKind[];
  /** The fact ids behind the arrow, in code point order: one for a state or sequence arrow, every folded one otherwise. */
  readonly facts: readonly string[];
  readonly evidence: DiagramEvidence;
  readonly dashed: boolean;
  /** Where the first fact behind the arrow stands in code, when its provenance names a place: where a reader checks it. */
  readonly place?: DiagramPlace;
  /** A sequence's place in the scenario, 1-based; absent on every other type. */
  readonly step?: number;
}

/** One diagram, ready to be drawn: its elements, its arrows and what its size did to it. */
export interface DiagramModel {
  readonly type: DiagramType;
  /** The level the diagram stands at: 1, 2 or 3 for the C4 types, module-dependency's depth, 1 for the rest. */
  readonly level: number;
  readonly title: string;
  /** The nodes the view was scoped by, in code point order; empty for the whole product. */
  readonly nodes: readonly string[];
  /** The scenario's steps, in their order; empty when the view names none. */
  readonly scenario: readonly string[];
  /** Every element, in code point order of the id. */
  readonly elements: readonly DiagramElement[];
  /** Every arrow, by `from` then `to` in code point order, and in a sequence by its step. */
  readonly edges: readonly DiagramEdge[];
  /** Whether the node budget collapsed the view. */
  readonly collapsed: boolean;
  /** One sentence naming what the budget did, or null when it did nothing. */
  readonly marker: string | null;
}

/** What one type of diagram is made of, as the graph names it. */
interface DiagramTypeDeclaration {
  /** The C4 level the type stands at (0026: context, container, component), or null for a type that has none. */
  readonly level: number | null;
  /** Whether the type takes a depth of its own as its `level`: module-dependency's, under each scope it names. */
  readonly depth: boolean;
  /** The kinds of the nodes a view of this type may be scoped by. */
  readonly scopes: readonly FactNodeKind[];
  /** The kinds the view's elements are. */
  readonly elements: readonly FactNodeKind[];
  /** The edge kinds the view draws. */
  readonly edges: readonly FactEdgeKind[];
  /** The kinds an element's level above is; empty when no element of the type has one. */
  readonly above: readonly FactNodeKind[];
  /** Whether an edge's end rolls up to the element that holds it, or must be an element itself. */
  readonly rollsUp: boolean;
  /** The heading the model's title opens with, in the words a reader reads. */
  readonly heading: string;
}

/**
 * What each type is made of. The edge kinds are the relations each view is
 * about: a module view draws the imports and dependencies 0026 calls the
 * dependency graph, a component view adds the calls and references that run
 * inside them, and a context view draws every relation but the two that place a
 * node (`NEIGHBOR_EDGE_KINDS`) rolled up to the repositories that hold its ends.
 */
export const DIAGRAM_TYPE_DECLARATIONS: { readonly [K in DiagramType]: DiagramTypeDeclaration } = {
  'c4-context': {
    level: 1,
    depth: false,
    scopes: ['repository'],
    elements: ['repository'],
    // The relations between systems: the kinds that mean one node names or uses another. The schema's other seven edge
    // kinds are left out on purpose — `contains` and `defines` place a node rather than relate two, `document-link` and
    // `task-key` record where a document or a commit points, `transition` is a state machine's move inside one node,
    // and `binds` and `provides` name an end that is no node (an environment's value, an endpoint's contract).
    edges: ['call', 'consumes', 'dependency', 'import', 'inherits', 'interaction', 'reference', 'resolves'],
    above: [],
    rollsUp: true,
    heading: 'C4 context',
  },
  'c4-container': {
    level: 2,
    depth: false,
    // A view is scoped by a repository (its containers) or by the containers themselves, which is what a collapsed
    // view's drill-down names: a link back into a spec this module refuses would be a dead end.
    scopes: ['deploy-unit', 'package', 'repository', 'table'],
    elements: ['deploy-unit', 'package', 'table'],
    // The relations a container view is made of: the dependencies stage 2 writes between the packages, and the
    // interactions an agent named between deploy units. A call, a reference or an import joins files or symbols, which
    // are no containers, so a view of containers can never roll them up and does not declare them.
    edges: ['dependency', 'interaction'],
    above: ['repository'],
    rollsUp: false,
    heading: 'C4 containers',
  },
  'c4-component': {
    level: 3,
    depth: false,
    scopes: ['module', 'repository'],
    elements: ['module'],
    edges: ['call', 'import', 'interaction', 'reference'],
    above: ['module', 'repository'],
    rollsUp: true,
    heading: 'C4 components',
  },
  'module-dependency': {
    level: null,
    depth: true,
    scopes: ['module', 'repository'],
    elements: ['module'],
    edges: ['dependency', 'import'],
    above: ['module', 'repository'],
    rollsUp: true,
    heading: 'Module dependencies',
  },
  'er': {
    level: null,
    depth: false,
    scopes: ['repository', 'table'],
    elements: ['table'],
    edges: [],
    above: ['repository'],
    rollsUp: false,
    heading: 'Data model',
  },
  'sequence': {
    level: null,
    depth: false,
    scopes: ['deploy-unit', 'symbol'],
    elements: ['deploy-unit', 'symbol'],
    edges: ['interaction'],
    above: [],
    rollsUp: false,
    heading: 'Sequence',
  },
  'state': {
    level: null,
    depth: false,
    scopes: ['repository', 'state'],
    elements: ['state'],
    edges: ['transition'],
    above: [],
    rollsUp: false,
    heading: 'States',
  },
};

/**
 * The prefix of an element id that names an end the graph does not hold: the id
 * of such an element is `unresolved:` and the fact id the view was asked about
 * (or the name parts of a table no fact of the scope holds), so it can never
 * collide with a fact id, which is a kind, a colon and 64 hexadecimal digits.
 */
export const UNRESOLVED_PREFIX = 'unresolved:';

/**
 * The address of one graph node's page: the wiki app's page prefix and the
 * node's own fact id. This is the one place the address is made
 * (madarch-tzte.23.1 serves the pages it names, madarch-tzte.23.3 shows them),
 * so a served route that moves moves here and nowhere else.
 */
export function graphPageHref(id: string): string {
  if (typeof id !== 'string' || !isFactId(id)) raise(`${here()}: ${shown(id)} is no fact id: a page's address is the fact id of the node it is the page of (src/fill/facts.ts)`);
  return `/p/graph/${id}`;
}

/** The address of one view of the graph (the same page prefix), its type, its level and the nodes it is scoped by. */
export function diagramHref(spec: DiagramViewSpec): string {
  // Neither a fact id (a kind, a colon and 64 hexadecimal digits) nor a type (a closed list of words) needs escaping: a
  // reader reads the address it copies.
  const parts = [`diagram=${spec.type}`];
  if (spec.level !== undefined) parts.push(`level=${String(spec.level)}`);
  for (const node of [...spec.nodes].sort(byCodePoint)) parts.push(`node=${node}`);
  return `/p/graph?${parts.join('&')}`;
}

// ---------------------------------------------------------------------------------------------
// What a diagram reads of the graph
// ---------------------------------------------------------------------------------------------

/** One node an element sits in, as the graph places it: its kind, so a view can tell a module from a repository. */
export interface DiagramAncestor {
  readonly id: string;
  readonly kind: FactNodeKind;
}

/**
 * The graph as a diagram reads it: the questions a view asks, answered from the
 * fact store and none of them a write. It is an interface and not a store
 * handle, so a test draws diagrams from a fixture it makes, and the only
 * implementation here (`factStoreDiagramReads`) reads the landed `fill_fact`
 * rows.
 */
export interface DiagramGraphReads {
  /** The facts of the given ids, whatever kind, by id; an id the graph holds no fact of is absent. */
  facts(ids: readonly string[]): Promise<ReadonlyMap<string, Fact>>;
  /** Every node fact of one kind, in code point order of the id. */
  kind(kind: FactNodeKind): Promise<readonly Fact[]>;
  /** The node facts of one kind whose value, at `field`, is exactly `value`, in code point order of the id. */
  factsWith(kind: FactNodeKind, field: string, value: string): Promise<readonly Fact[]>;
  /** The edge facts of the given kinds that name one of the ids at one of their ends, in code point order of the id. */
  edges(ids: readonly string[], kinds: readonly FactEdgeKind[]): Promise<readonly Fact[]>;
  /**
   * The edge facts of the given kinds one of whose ends is a node of one of the
   * given repositories — the relations a product's scope holds, which is what a
   * view rolled up to its elements draws. Both ends are joined with a left join, so
   * an edge whose other end no unit holds is still answered: an unresolved end is
   * exactly what a view must draw.
   */
  edgesIn(repositories: readonly string[], kinds: readonly FactEdgeKind[]): Promise<readonly Fact[]>;
  /**
   * Every node each id sits in, nearest first: its `contains` ancestors, and the
   * repository its own `repository` value names when that chain does not hold it
   * — a package, a deploy unit and a table stand in a repository the graph
   * writes no `contains` edge for.
   */
  ancestors(ids: readonly string[]): Promise<ReadonlyMap<string, readonly DiagramAncestor[]>>;
}

// ---------------------------------------------------------------------------------------------
// The reads over the landed fact store
// ---------------------------------------------------------------------------------------------

/** The columns of `fill_fact` a diagram reads: the same ones every other read of the store answers. */
const FACT_COLUMNS = 'id, kind, schema_version, provenance, layer, status, value';

/** The most steps one ancestry walk takes: a containment cycle is a graph fault, never a diagram's hang. */
const MAX_ANCESTRY_STEPS = 32;

/** One row of `fill_fact`, as the store writes it. */
interface FactRow extends Record<string, unknown> {
  id: string;
  kind: string;
  schema_version: unknown;
  provenance: unknown;
  layer: string;
  status: string;
  value: unknown;
}

/** One stored row as the schema's own fact: the columns back to the fields `facts.ts` declares. */
function storedFact(row: FactRow): Fact {
  return {
    kind: row.kind,
    schemaVersion: typeof row.schema_version === 'number' ? row.schema_version : Number(row.schema_version),
    id: row.id,
    provenance: typeof row.provenance === 'string' ? JSON.parse(row.provenance) : row.provenance,
    layer: row.layer,
    status: row.status,
    value: typeof row.value === 'string' ? JSON.parse(row.value) : row.value,
  } as Fact;
}

/**
 * The SQL expression that reads one end of the edges of the given kinds, wherever
 * each kind keeps it (`EDGE_END_FIELDS`, graph-reads.ts: a `from` and a `to`, an
 * interaction's `caller` and `callee`, a consumed variable's `variable`, a document
 * link's term), and the kind groups it binds: the plain field where the kind names
 * the end there, and one parameter per other field. The field names come from this
 * module's own table and never from a reader's text.
 */
function endExpression(side: 'from' | 'to', kinds: readonly FactEdgeKind[], firstParameter: number): { readonly sql: string; readonly values: readonly (readonly FactEdgeKind[])[] } {
  const plain = `value->>'${side}'`;
  const grouped = new Map<string, FactEdgeKind[]>();
  for (const kind of kinds) {
    const fields = EDGE_END_FIELDS[kind];
    const field = fields[side];
    if (field === null) continue;
    const expression = side === 'to' && fields.toTerm === true ? `value->'${field}'->>'id'` : `value->>'${field}'`;
    if (expression === plain) continue;
    const held = grouped.get(expression) ?? [];
    held.push(kind);
    grouped.set(expression, held);
  }
  const groups = [...grouped.entries()]
    .map(([expression, group]) => ({ expression, kinds: [...new Set(group)].sort(byCodePoint) }))
    .sort((left, right) => byCodePoint(left.expression, right.expression));
  const clauses = groups.map((group, index) => `WHEN e.kind = ANY($${firstParameter + index}::text[]) THEN e.${group.expression}`);
  return {
    sql: clauses.length === 0 ? `e.${plain}` : `CASE ${clauses.join(' ')} ELSE e.${plain} END`,
    values: groups.map((group) => group.kinds),
  };
}

/**
 * The diagram models' reads over the landed fact store (madarch-tzte.23.2): the
 * `fill_fact` rows, read in the owner's `snapshot` transaction and written
 * never. Every failure names the operation, the table it touched and the
 * database's own words (`withLocation`), and every list is sorted here rather
 * than left to the database — PostgreSQL orders text by its own collation, and
 * a diagram must come out the same list on every machine.
 */
export function factStoreDiagramReads(database: FactStoreDatabase): DiagramGraphReads {
  return readsOver(async (operation, work) => {
    const at = here();
    return await withLocation(at, operation, FACT_STORE_TABLES, async () => await database.transaction('snapshot', work));
  });
}

/**
 * One model of the landed fact store, built inside one `snapshot` transaction:
 * every read a diagram makes answers the same state of the graph, so a model can
 * never draw an element read before a publication beside an edge read after it.
 * `buildDiagram` over `factStoreDiagramReads` is the same model read by read, each
 * in a transaction of its own; a caller that serves a diagram asks for this one.
 */
export async function buildFactStoreDiagram(
  spec: DiagramViewSpec,
  database: FactStoreDatabase,
  options: { readonly limits?: Partial<DiagramLimits> } = {},
): Promise<DiagramModel> {
  const at = here();
  return await withLocation(at, `buildFactStoreDiagram(${String(spec?.type)})`, FACT_STORE_TABLES, async () => await database.transaction(
    'snapshot',
    async (executor) => await buildDiagram(spec, readsOver(async (_operation, work) => await work(executor)), options),
  ));
}

/** The diagram reads over one way of running a statement: the process's owner, or the executor of a model's one transaction. */
function readsOver(
  run: <R>(operation: string, work: (executor: SqlExecutor) => Promise<R>) => Promise<R>,
): DiagramGraphReads {
  const read = run;
  return {
    facts: async (ids) => await read(`diagramFacts(${String(ids.length)} ids)`, async (executor) => {
      const wanted = [...new Set(ids)].sort(byCodePoint);
      const found = new Map<string, Fact>();
      if (wanted.length === 0) return found;
      const { rows } = await executor.query<FactRow>(
        `SELECT ${FACT_COLUMNS} FROM fill_fact WHERE id = ANY($1::text[]) ORDER BY id ASC`,
        [wanted],
      );
      for (const fact of rows.map(storedFact)) found.set(fact.id, fact);
      return found;
    }),
    kind: async (kind) => await read(`diagramKind(${kind})`, async (executor) => {
      const { rows } = await executor.query<FactRow>(`SELECT ${FACT_COLUMNS} FROM fill_fact WHERE kind = $1 ORDER BY id ASC`, [kind]);
      return rows.map(storedFact).sort((left, right) => byCodePoint(left.id, right.id));
    }),
    factsWith: async (kind, field, value) => await read(`diagramFactsWith(${kind}.${field})`, async (executor) => {
      const { rows } = await executor.query<FactRow>(
        `SELECT ${FACT_COLUMNS} FROM fill_fact WHERE kind = $1 AND value ->> $2 = $3 ORDER BY id ASC`,
        [kind, field, value],
      );
      return rows.map(storedFact).sort((left, right) => byCodePoint(left.id, right.id));
    }),
    edges: async (ids, kinds) => await read(`diagramEdges(${String(ids.length)} ids)`, async (executor) => {
      const wanted = [...new Set(ids)].sort(byCodePoint);
      if (wanted.length === 0 || kinds.length === 0) return [];
      // Every field an edge value can name an end by (`EDGE_END_FIELDS`, graph-reads.ts): the statement asks the
      // store which edges touch the ids, and the answers are read by `endsOf`, so a kind whose end stands in one of
      // these fields is answered and a kind whose end is a term (`document-link`, `binds`) matches nothing.
      const { rows } = await executor.query<FactRow>(
        `SELECT ${FACT_COLUMNS} FROM fill_fact
          WHERE kind = ANY($1::text[])
            AND (value ->> 'from' = ANY($2::text[])
              OR value ->> 'to' = ANY($2::text[])
              OR value ->> 'caller' = ANY($2::text[])
              OR value ->> 'callee' = ANY($2::text[])
              OR value ->> 'variable' = ANY($2::text[]))
          ORDER BY id ASC`,
        [kinds, wanted],
      );
      return rows.map(storedFact).sort((left, right) => byCodePoint(left.id, right.id));
    }),
    edgesIn: async (repositories, kinds) => await read(`diagramEdgesIn(${repositories.join(', ')})`, async (executor) => {
      const wanted = [...new Set(repositories)].sort(byCodePoint);
      if (wanted.length === 0 || kinds.length === 0) return [];
      // Each end is read out of the field its kind keeps it in (`EDGE_END_FIELDS`, graph-reads.ts: `from` and `to`, a
      // `caller` and a `callee` for an interaction, a `variable` for a consumed one), and both ends are left-joined so
      // an edge one of whose ends no unit holds is still answered — that is the edge a view draws as unresolved.
      const fromEnd = endExpression('from', kinds, 3);
      const toEnd = endExpression('to', kinds, 3 + fromEnd.values.length);
      const { rows } = await executor.query<FactRow>(
        `SELECT e.id, e.kind, e.schema_version, e.provenance, e.layer, e.status, e.value
           FROM fill_fact e
           LEFT JOIN fill_fact f ON f.id = ${fromEnd.sql}
           LEFT JOIN fill_fact t ON t.id = ${toEnd.sql}
          WHERE e.kind = ANY($1::text[])
            AND (f.value ->> 'repository' = ANY($2::text[]) OR t.value ->> 'repository' = ANY($2::text[]))
          ORDER BY e.id ASC`,
        [kinds, wanted, ...fromEnd.values, ...toEnd.values],
      );
      return rows.map(storedFact).sort((left, right) => byCodePoint(left.id, right.id));
    }),
    ancestors: async (ids) => await read(`diagramAncestors(${String(ids.length)} ids)`, async (executor) => {
      const wanted = [...new Set(ids)].sort(byCodePoint);
      const chains = new Map<string, DiagramAncestor[]>();
      for (const id of wanted) chains.set(id, []);
      if (wanted.length === 0) return chains;
      const { rows } = await executor.query<{ root: unknown; id: unknown; depth: unknown; kind: unknown }>(
        `WITH RECURSIVE walk(root, id, depth) AS (
           SELECT n.id, c.value ->> 'from', 1
             FROM fill_fact n JOIN fill_fact c ON c.kind = 'contains' AND c.value ->> 'to' = n.id
            WHERE n.id = ANY($1::text[])
           UNION ALL
           SELECT w.root, c.value ->> 'from', w.depth + 1
             FROM walk w JOIN fill_fact c ON c.kind = 'contains' AND c.value ->> 'to' = w.id
            WHERE w.depth < $2
         )
         SELECT w.root, w.id, w.depth, f.kind
           FROM walk w JOIN fill_fact f ON f.id = w.id`,
        [wanted, MAX_ANCESTRY_STEPS],
      );
      // The nearest step an ancestor stands at, and the whole order built here rather than by the query: a database
      // orders text by its own collation, and two ancestors at one depth (two modules holding one symbol, a folder and
      // a module holding one file) must roll a node up to the same one on every machine.
      const nearest = new Map<string, Map<string, { depth: number; kind: FactNodeKind }>>();
      for (const id of wanted) nearest.set(id, new Map());
      for (const row of rows) {
        const root = typeof row.root === 'string' ? row.root : undefined;
        const id = typeof row.id === 'string' ? row.id : undefined;
        const kind = typeof row.kind === 'string' ? row.kind : undefined;
        const depth = typeof row.depth === 'number' ? row.depth : Number(row.depth);
        if (root === undefined || id === undefined || kind === undefined || Number.isInteger(depth) === false) continue;
        if ((FACT_EDGE_KINDS as readonly string[]).includes(kind)) continue;
        const held = nearest.get(root);
        if (held === undefined) continue;
        const seen = held.get(id);
        if (seen === undefined || seen.depth > depth) held.set(id, { depth, kind: kind as FactNodeKind });
      }
      for (const id of wanted) {
        const chain = chains.get(id);
        const held = nearest.get(id);
        if (chain === undefined || held === undefined) continue;
        for (const [ancestor, step] of [...held.entries()].sort(([leftId, left], [rightId, right]) => left.depth - right.depth || byCodePoint(leftId, rightId))) {
          chain.push({ id: ancestor, kind: step.kind });
        }
      }
      // The repository a fact's own value names, for the kinds the graph places by value and not by a `contains`
      // edge: a package, a deploy unit and a table, and a node whose own `contains` chain reaches no repository.
      const chainIds = wanted.flatMap((id) => [id, ...(chains.get(id) ?? []).map((each) => each.id)]);
      const { rows: repositories } = await executor.query<{ node: unknown; repository: unknown }>(
        `SELECT f.id AS node, r.id AS repository
           FROM fill_fact f JOIN fill_fact r ON r.kind = 'repository' AND r.value ->> 'repository' = f.value ->> 'repository'
          WHERE f.id = ANY($1::text[])`,
        [[...new Set(chainIds)].sort(byCodePoint)],
      );
      const repositoryOf = new Map<string, string>();
      for (const row of repositories) {
        if (typeof row.node !== 'string' || typeof row.repository !== 'string') continue;
        const held = repositoryOf.get(row.node);
        if (held === undefined || byCodePoint(row.repository, held) < 0) repositoryOf.set(row.node, row.repository);
      }
      for (const id of wanted) {
        const chain = chains.get(id);
        if (chain === undefined) continue;
        for (const ancestor of [...chain]) {
          const repository = repositoryOf.get(ancestor.id);
          if (repository !== undefined && ancestor.id !== repository && !chain.some((each) => each.id === repository)) {
            chain.push({ id: repository, kind: 'repository' });
          }
        }
        const own = repositoryOf.get(id);
        if (own !== undefined && own !== id && !chain.some((each) => each.id === own)) chain.push({ id: own, kind: 'repository' });
      }
      return chains;
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Reading a spec, and the pieces every view shares
// ---------------------------------------------------------------------------------------------

/** A spec the graph's own terms accept, with the level the view stands at resolved. */
interface CheckedSpec {
  readonly type: DiagramType;
  readonly level: number;
  readonly nodes: readonly string[];
  readonly scenario: readonly string[];
  readonly declaration: DiagramTypeDeclaration;
}

/** What one view gathered, before the size of the view is judged. */
interface Gathered {
  readonly elements: readonly DiagramElement[];
  readonly edges: readonly DiagramEdge[];
}

/** A value as a failure shows it: a string quoted, anything else as JSON. */
function shown(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value) ?? String(value);
}

/** One fact's value as an object to read fields out of; a value that is no object answers none. */
function valueOf(fact: Fact): Record<string, unknown> {
  const value = fact.value;
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as unknown as Record<string, unknown> : {};
}

/** One text field of a fact's value, when it holds one. */
function textOf(fact: Fact, field: string): string | undefined {
  const held = valueOf(fact)[field];
  return typeof held === 'string' && held !== '' ? held : undefined;
}

/** The product's own name for the repository a fact stands in: its own value's, or the provenance's. */
function repositoryNameOf(fact: Fact): string {
  return textOf(fact, 'repository') ?? fact.provenance.repository.id;
}

/** The page an element opens: the node's own address. */
function pageOfFact(fact: Fact): DiagramPage {
  return { id: fact.id, href: graphPageHref(fact.id) };
}

/** Where a fact stands in code, when its provenance names a place: the repository and the commit a reader opens it at. */
function placeOfFact(fact: Fact): DiagramPlace | undefined {
  const place = fact.provenance.place;
  if (place === undefined) return undefined;
  return {
    repository: fact.provenance.repository.id,
    commit: fact.provenance.repository.commit,
    file: place.file,
    line: place.range.startLine,
    endLine: place.range.endLine,
  };
}

/**
 * How a fact stands behind what a diagram shows (0005): an `inferred` fact is an
 * agent's reading, and a `rejected` declaration is one a person turned down — both
 * are assumptions and are drawn dashed. Every other fact is a fact and is solid:
 * `declared` (a person's own words), `extracted` (a deterministic reader of code)
 * and `observed` (runtime traffic).
 */
function evidenceOfFact(fact: Fact): DiagramEvidence {
  return fact.layer === 'inferred' || fact.status === 'rejected' ? 'assumption' : 'fact';
}

/** One graph fact as a diagram element: its label, its page, its code place and how it stands. */
function elementOfFact(fact: Fact): DiagramElement {
  const place = placeOfFact(fact);
  const evidence = evidenceOfFact(fact);
  return {
    id: fact.id,
    kind: fact.kind as FactNodeKind,
    label: labelOf(fact),
    evidence,
    dashed: evidence !== 'fact',
    page: pageOfFact(fact),
    ...(place === undefined ? {} : { place }),
  };
}

/** One column fact as an ER diagram shows it: the column's own name, its type, its page and place. */
function columnOfFact(fact: Fact): DiagramColumn {
  const place = placeOfFact(fact);
  const evidence = evidenceOfFact(fact);
  const dataType = textOf(fact, 'dataType');
  return {
    id: fact.id,
    label: textOf(fact, 'name') ?? labelOf(fact),
    ...(dataType === undefined ? {} : { dataType }),
    evidence,
    dashed: evidence !== 'fact',
    page: pageOfFact(fact),
    ...(place === undefined ? {} : { place }),
  };
}

/** An element for an end the graph does not hold: dashed, no page, no code, and an id no fact can carry. */
function unresolvedElement(id: string): DiagramElement {
  return {
    id: `${UNRESOLVED_PREFIX}${id}`,
    kind: null,
    label: id,
    evidence: 'unresolved',
    dashed: true,
  };
}

/** A spec read against the graph's own terms: the type, the level, the nodes and the scenario, or a refusal naming what is wrong. */
function checkedSpec(spec: DiagramViewSpec): CheckedSpec {
  const at = here();
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    raise(`${at}: the view is ${shown(spec)}: a view specification is an object — a type, its nodes, a scenario and a level (decision 0026, "Diagrams"; src/fill/diagrams.ts)`);
  }
  const type = spec.type;
  if (typeof type !== 'string' || (DIAGRAM_TYPES as readonly string[]).includes(type) === false) {
    raise(`${at}: the view names the diagram type ${shown(type)}: the types this module draws are ${DIAGRAM_TYPES.join(', ')} (decision 0026, "Diagrams"; src/fill/diagrams.ts)`);
  }
  const declaration = DIAGRAM_TYPE_DECLARATIONS[type];
  if (!Array.isArray(spec.nodes)) {
    raise(`${at}: the view names the nodes ${shown(spec.nodes)}: a view's nodes are a list of fact ids, empty for the whole product`);
  }
  const seen = new Set<string>();
  for (const id of spec.nodes) {
    if (typeof id !== 'string' || isFactId(id) === false) {
      raise(`${at}: the view names the node ${shown(id)}: a node is a fact id — the kind, a colon and the 64 lower-case hexadecimal digits of the fact's identity (src/fill/facts.ts)`);
    }
    if (seen.has(id)) raise(`${at}: the view names the node ${shown(id)} twice: a view's nodes are a set, each named once`);
    seen.add(id);
  }
  let level: number;
  if (spec.level === undefined) {
    level = declaration.depth ? 1 : (declaration.level ?? 1);
  } else {
    const asked = spec.level;
    if (typeof asked !== 'number' || Number.isInteger(asked) === false || asked < 1) {
      raise(`${at}: the view names the level ${shown(asked)}: a level is a whole number, at least 1`);
    }
    if (declaration.depth) {
      level = asked;
    } else if (declaration.level === null) {
      raise(`${at}: the view names the level ${asked} for the ${type} diagram: ${type} has no level — the levels are the C4 types' own (c4-context 1, c4-container 2, c4-component 3) and module-dependency's depth`);
    } else if (asked !== declaration.level) {
      raise(`${at}: the view names the level ${asked} for the ${type} diagram: that type is level ${declaration.level}, and another level is another type of diagram (c4-context 1, c4-container 2, c4-component 3)`);
    } else {
      level = asked;
    }
  }
  let scenario: readonly string[] = [];
  if (spec.scenario !== undefined) {
    if (type !== 'sequence') {
      raise(`${at}: the view names a scenario for the ${type} diagram: a scenario is a sequence diagram's steps, and no other type takes one`);
    }
    if (!Array.isArray(spec.scenario)) raise(`${at}: the view names the scenario ${shown(spec.scenario)}: a scenario is a list of interaction fact ids, in the order the scenario takes them`);
    for (const step of spec.scenario) {
      if (typeof step !== 'string' || isFactId(step) === false) {
        raise(`${at}: the scenario names the step ${shown(step)}: a step is the fact id of one interaction (src/fill/facts.ts)`);
      }
    }
    scenario = [...spec.scenario];
  }
  return { type, level, nodes: [...seen].sort(byCodePoint), scenario, declaration };
}

/**
 * The nodes a view names, read and checked: each is a fact the graph holds, of a
 * kind the type can be scoped by. The whole product is named by no node at all,
 * and a view that names none is drawn from every repository.
 */
async function scopedFacts(checked: CheckedSpec, reads: DiagramGraphReads): Promise<readonly Fact[]> {
  const at = here();
  if (checked.nodes.length === 0) return [];
  const held = await reads.facts(checked.nodes);
  const scopes = checked.declaration.scopes as readonly string[];
  return checked.nodes.map((id) => {
    const fact = held.get(id);
    if (fact === undefined) {
      raise(`${at}: the view names the node ${shown(id)} and the graph holds no fact of that id: a diagram is drawn from the graph, so a node it does not hold is refused rather than drawn as nothing`);
    }
    if ((FACT_EDGE_KINDS as readonly string[]).includes(fact.kind)) {
      raise(`${at}: the view names the node ${shown(id)}, which is a ${fact.kind} edge: an edge is no node a diagram is scoped by`);
    }
    if (scopes.includes(fact.kind) === false) {
      raise(`${at}: the view names ${shown(labelOf(fact))} (${fact.kind} ${fact.id}) for the ${checked.type} diagram: a ${checked.type} view is scoped by ${checked.declaration.scopes.join(', ')}, and a ${fact.kind} is none of them`);
    }
    return fact;
  });
}

// ---------------------------------------------------------------------------------------------
// The arrows a view draws
// ---------------------------------------------------------------------------------------------

/** What one end of an edge stands for in a view: the element it maps to, the id the graph does not hold, or nothing at all. */
type StandIn = { readonly element: string } | { readonly missing: string } | null;

/** What one arrow is called, in the fact's own words where it has them: a transition by its event, an interaction by what carries it. */
function arrowLabel(fact: Fact): string {
  if (fact.kind === 'transition') return textOf(fact, 'event') ?? 'transition';
  if (fact.kind === 'interaction') return textOf(fact, 'via') ?? textOf(fact, 'form') ?? 'interaction';
  return fact.kind;
}

/** How the arrow of these facts stands: unresolved when an end is missing, an assumption when any fact is one, a fact otherwise. */
function arrowEvidence(facts: readonly Fact[], unresolvedEnd: boolean): DiagramEvidence {
  if (unresolvedEnd) return 'unresolved';
  return facts.some((fact) => evidenceOfFact(fact) !== 'fact') ? 'assumption' : 'fact';
}

/**
 * The arrows a candidate set of edges makes of one view's elements: each end is
 * mapped to the element that stands for it — the element itself, the element
 * that holds it when the view rolls its ends up, or a placeholder when the graph
 * does not hold the end at all — and an edge whose end stands for no element of
 * the view is not about this view and is not drawn.
 *
 * A rolled view folds every edge of one pair of elements into one arrow
 * (`fold`), which is what makes a module view say "these two modules are joined"
 * rather than naming every import between them; a view whose arrows are single
 * facts (state, sequence) draws each fact as its own arrow, in the order the
 * caller numbers it.
 */
async function linkEdges(
  candidates: readonly Fact[],
  elements: readonly DiagramElement[],
  declaration: DiagramTypeDeclaration,
  reads: DiagramGraphReads,
  options: { readonly fold: boolean; readonly stepOf?: (fact: Fact) => number | undefined },
): Promise<{ readonly elements: readonly DiagramElement[]; readonly arrows: readonly DiagramEdge[] }> {
  const elementIds = new Set(elements.map((each) => each.id));
  const ends: string[] = [];
  for (const edge of candidates) {
    const pair = endsOf(edge.kind as FactEdgeKind, edge.value);
    if (pair.from !== undefined) ends.push(pair.from);
    if (pair.to !== undefined) ends.push(pair.to);
  }
  const unknown = [...new Set(ends)].filter((id) => elementIds.has(id) === false).sort(byCodePoint);
  const held = unknown.length === 0 ? new Map<string, Fact>() : await reads.facts(unknown);
  const ancestors = declaration.rollsUp && unknown.length > 0 ? await reads.ancestors(unknown) : new Map<string, readonly DiagramAncestor[]>();
  const standIn = (id: string): StandIn => {
    if (elementIds.has(id)) return { element: id };
    if (held.has(id) === false) return { missing: id };
    if (declaration.rollsUp === false) return null;
    for (const ancestor of ancestors.get(id) ?? []) {
      if (elementIds.has(ancestor.id)) return { element: ancestor.id };
    }
    return null;
  };
  const placeholders = new Map<string, DiagramElement>();
  const folded = new Map<string, { from: string; to: string; facts: Fact[] }>();
  const arrows: DiagramEdge[] = [];
  for (const edge of candidates) {
    const pair = endsOf(edge.kind as FactEdgeKind, edge.value);
    // An edge one of whose ends names no node of the graph — `binds` has no to end at all, `task-key` ends at a
    // tracker key and a `document-link` may end at an address or a literal — is drawn between nodes, and a fact with
    // one node end is not.
    if (pair.from === undefined || pair.to === undefined) continue;
    const from = standIn(pair.from);
    const to = standIn(pair.to);
    if (from === null || to === null) continue;
    const fromId = 'element' in from ? from.element : `${UNRESOLVED_PREFIX}${from.missing}`;
    const toId = 'element' in to ? to.element : `${UNRESOLVED_PREFIX}${to.missing}`;
    // A relation whose two ends stand for one element is a relation inside that element: it is not drawn between a
    // node and itself, and the element's own page is where a reader follows it.
    if (fromId === toId) continue;
    for (const stand of [from, to]) {
      if ('missing' in stand === false) continue;
      const id = `${UNRESOLVED_PREFIX}${stand.missing}`;
      if (placeholders.has(id) === false) placeholders.set(id, unresolvedElement(stand.missing));
    }
    if (options.fold) {
      const key = `${fromId}\u0000${toId}`;
      const group = folded.get(key) ?? { from: fromId, to: toId, facts: [] };
      group.facts.push(edge);
      folded.set(key, group);
      continue;
    }
    const evidence = arrowEvidence([edge], fromId.startsWith(UNRESOLVED_PREFIX) || toId.startsWith(UNRESOLVED_PREFIX));
    const step = options.stepOf?.(edge);
    const place = placeOfFact(edge);
    arrows.push({
      from: fromId,
      to: toId,
      label: arrowLabel(edge),
      kinds: [edge.kind as FactEdgeKind],
      facts: [edge.id],
      evidence,
      dashed: evidence !== 'fact',
      ...(place === undefined ? {} : { place }),
      ...(step === undefined ? {} : { step }),
    });
  }
  for (const group of folded.values()) {
    const kinds = [...new Set(group.facts.map((fact) => fact.kind as FactEdgeKind))].sort(byCodePoint);
    const facts = group.facts.map((fact) => fact.id).sort(byCodePoint);
    const evidence = arrowEvidence(group.facts, group.from.startsWith(UNRESOLVED_PREFIX) || group.to.startsWith(UNRESOLVED_PREFIX));
    const first = [...group.facts].sort((left, right) => byCodePoint(left.id, right.id))[0];
    const place = first === undefined ? undefined : placeOfFact(first);
    arrows.push({ from: group.from, to: group.to, label: kinds.join(', '), kinds, facts, evidence, dashed: evidence !== 'fact', ...(place === undefined ? {} : { place }) });
  }
  arrows.sort((left, right) => {
    if (left.step !== undefined && right.step !== undefined && left.step !== right.step) return left.step - right.step;
    const byFrom = byCodePoint(left.from, right.from);
    if (byFrom !== 0) return byFrom;
    const byTo = byCodePoint(left.to, right.to);
    if (byTo !== 0) return byTo;
    return byCodePoint(left.facts[0] ?? '', right.facts[0] ?? '');
  });
  return { elements: [...placeholders.values()], arrows };
}

// ---------------------------------------------------------------------------------------------
// One view of each type
// ---------------------------------------------------------------------------------------------

/** The modules one level below a container, `depth` levels down, in code point order. */
async function modulesBelow(container: Fact, depth: number, reads: DiagramGraphReads): Promise<readonly Fact[]> {
  let level: readonly Fact[] = container.kind === 'module'
    ? await reads.factsWith('module', 'parent', container.id)
    // A repository's top-level modules name no parent: stage 5 holds them by the repository's own `contains` edge.
    : (await reads.factsWith('module', 'repository', repositoryNameOf(container))).filter((module) => textOf(module, 'parent') === undefined);
  for (let step = 1; step < depth; step += 1) {
    if (level.length === 0) break;
    const below: Fact[] = [];
    for (const module of level) below.push(...await reads.factsWith('module', 'parent', module.id));
    level = below;
  }
  return dedupedByFactId(level);
}

/** The same facts, each once, in code point order of the id. */
function dedupedByFactId(facts: readonly Fact[]): readonly Fact[] {
  const held = new Map<string, Fact>();
  for (const fact of facts) if (held.has(fact.id) === false) held.set(fact.id, fact);
  return [...held.values()].sort((left, right) => byCodePoint(left.id, right.id));
}

/** The repositories a view is drawn over: the ones it names, or every repository of the product. */
async function viewRepositories(scoped: readonly Fact[], reads: DiagramGraphReads): Promise<readonly Fact[]> {
  if (scoped.length === 0) return await reads.kind('repository');
  return scoped.filter((fact) => fact.kind === 'repository');
}

/**
 * 0026's C4 context: the product's repositories, and the relations between them,
 * rolled up from the files and symbols that carry them. An arrow needs an element
 * at each end, so a scoped context view draws the relations between the
 * repositories it names and not the ones that leave the view: the system on the
 * other side is no element of it.
 */
async function gatherContext(checked: CheckedSpec, scoped: readonly Fact[], reads: DiagramGraphReads): Promise<Gathered> {
  const repositories = await viewRepositories(scoped, reads);
  const elements = repositories.map(elementOfFact);
  const candidates = await reads.edgesIn(repositories.map(repositoryNameOf), checked.declaration.edges);
  const linked = await linkEdges(candidates, elements, checked.declaration, reads, { fold: true });
  return { elements: [...elements, ...linked.elements], edges: linked.arrows };
}

/** 0026's C4 container: the packages, deploy units and tables of the view's repositories, and the relations the graph holds between them. */
async function gatherContainers(checked: CheckedSpec, scoped: readonly Fact[], reads: DiagramGraphReads): Promise<Gathered> {
  const repositories = await viewRepositories(scoped, reads);
  // A container the view names is drawn as itself (a collapsed container view's drill-down names the containers it
  // folded), and a repository the view names contributes its containers.
  const containers: Fact[] = scoped.filter((fact) => fact.kind !== 'repository');
  for (const repository of repositories) {
    for (const kind of checked.declaration.elements) containers.push(...await reads.factsWith(kind, 'repository', repositoryNameOf(repository)));
  }
  const facts = dedupedByFactId(containers);
  const elements = facts.map(elementOfFact);
  const candidates = await reads.edges(elements.map((element) => element.id), checked.declaration.edges);
  const linked = await linkEdges(candidates, elements, checked.declaration, reads, { fold: true });
  return { elements: [...elements, ...linked.elements], edges: linked.arrows };
}

/**
 * 0026's module views: the modules a scope holds, `level` levels below it, and
 * the edges between their members rolled up to them. A scope with no module below
 * it is drawn as itself — the finest cluster is still one thing a reader asked
 * to see — while a repository the stages have not clustered contributes nothing,
 * because the graph holds no module there to draw.
 */
async function gatherModules(checked: CheckedSpec, scoped: readonly Fact[], reads: DiagramGraphReads): Promise<Gathered> {
  const containers = scoped.length === 0 ? await reads.kind('repository') : scoped;
  // A C4 component view is the level below its container, whatever C4 level the type itself stands at; a module view is
  // as deep as the spec asked for.
  const depth = checked.declaration.depth ? checked.level : 1;
  const elements: DiagramElement[] = [];
  for (const container of containers) {
    const below = await modulesBelow(container, depth, reads);
    if (below.length > 0) {
      for (const module of below) elements.push(elementOfFact(module));
      continue;
    }
    if (container.kind === 'module') elements.push(elementOfFact(container));
  }
  const kept = new Map<string, DiagramElement>();
  for (const element of elements) if (kept.has(element.id) === false) kept.set(element.id, element);
  const held = [...kept.values()].sort((left, right) => byCodePoint(left.id, right.id));
  const repositories = [...new Set(containers.map(repositoryNameOf))].sort(byCodePoint);
  const candidates = await reads.edgesIn(repositories, checked.declaration.edges);
  const linked = await linkEdges(candidates, held, checked.declaration, reads, { fold: true });
  return { elements: [...held, ...linked.elements], edges: linked.arrows };
}

/**
 * 0026's ER diagram: the tables of the view's scope, each with its columns. The
 * schema joins a column to its table by the table's name (`ColumnValue.table`),
 * and holds no edge between two tables at all, so the tables of a view stand
 * beside each other and a column whose table no fact of the view holds makes that
 * table a dashed placeholder carrying the columns it names.
 */
async function gatherTables(checked: CheckedSpec, scoped: readonly Fact[], reads: DiagramGraphReads): Promise<Gathered> {
  const tables: Fact[] = [];
  if (scoped.length === 0) tables.push(...await reads.kind('table'));
  for (const fact of scoped) {
    if (fact.kind === 'table') tables.push(fact);
    else tables.push(...await reads.factsWith('table', 'repository', repositoryNameOf(fact)));
  }
  const held = dedupedByFactId(tables);
  const repositories = [...new Set([...(scoped.length === 0 ? [] : scoped.map(repositoryNameOf)), ...held.map(repositoryNameOf)])].sort(byCodePoint);
  const columnsByTable = new Map<string, DiagramColumn[]>();
  for (const repository of repositories) {
    for (const column of await reads.factsWith('column', 'repository', repository)) {
      const key = `${repository}\u0000${textOf(column, 'table') ?? ''}`;
      const at = columnsByTable.get(key) ?? [];
      at.push(columnOfFact(column));
      columnsByTable.set(key, at);
    }
  }
  const columnsOf = (key: string): readonly DiagramColumn[] => [...(columnsByTable.get(key) ?? [])].sort((left, right) => byCodePoint(left.label, right.label) || byCodePoint(left.id, right.id));
  const elements: DiagramElement[] = [];
  const claimed = new Set<string>();
  for (const table of held) {
    const key = `${repositoryNameOf(table)}\u0000${textOf(table, 'name') ?? ''}`;
    claimed.add(key);
    const columns = columnsOf(key);
    elements.push({ ...elementOfFact(table), ...(columns.length === 0 ? {} : { columns }) });
  }
  for (const key of [...columnsByTable.keys()].sort(byCodePoint)) {
    if (claimed.has(key)) continue;
    const [repository = '', table = ''] = key.split('\u0000');
    const columns = columnsOf(key);
    elements.push({
      id: `${UNRESOLVED_PREFIX}table:${repository}/${table}`,
      kind: null,
      label: `${repository}:${table}`,
      evidence: 'unresolved',
      dashed: true,
      columns,
    });
  }
  return { elements, edges: [] };
}

/** The machine a state belongs to, as one key: the same machine name in two repositories is two machines. */
function machineKey(state: Fact): string {
  return `${repositoryNameOf(state)}\u0000${textOf(state, 'machine') ?? ''}`;
}

/**
 * 0026's state diagram: every state of the machines the view names — the
 * machines its state facts belong to, or every machine of the repositories it
 * names — and the transitions between them, each arrow named by its event.
 */
async function gatherStates(checked: CheckedSpec, scoped: readonly Fact[], reads: DiagramGraphReads): Promise<Gathered> {
  const machines = new Set<string>();
  if (scoped.length === 0) for (const state of await reads.kind('state')) machines.add(machineKey(state));
  for (const fact of scoped) {
    if (fact.kind === 'state') {
      machines.add(machineKey(fact));
      continue;
    }
    for (const state of await reads.factsWith('state', 'repository', repositoryNameOf(fact))) machines.add(machineKey(state));
  }
  const states = new Map<string, Fact>();
  for (const key of [...machines].sort(byCodePoint)) {
    const [repository = '', machine = ''] = key.split('\u0000');
    for (const state of await reads.factsWith('state', 'machine', machine)) {
      if (repositoryNameOf(state) !== repository) continue;
      if (states.has(state.id) === false) states.set(state.id, state);
    }
  }
  const elements = [...states.values()].sort((left, right) => byCodePoint(left.id, right.id)).map(elementOfFact);
  const candidates = await reads.edges(elements.map((element) => element.id), checked.declaration.edges);
  const linked = await linkEdges(candidates, elements, checked.declaration, reads, { fold: false });
  return { elements: [...elements, ...linked.elements], edges: linked.arrows };
}

/**
 * 0026's sequence: the participants the view names and the interactions between
 * them, in the order the scenario gives when it names one and, when it names
 * none, by the code point order of their two ends and then of the fact — the
 * graph holds no order between interactions, so the order is the chooser's. A scenario that names a step outside the view, or one
 * step twice, is refused by name: a scenario drawn shorter or shuffling a retry
 * into one arrow is not the scenario anybody chose.
 */
async function gatherSequence(checked: CheckedSpec, scoped: readonly Fact[], reads: DiagramGraphReads): Promise<Gathered> {
  const at = here();
  const participants = new Map<string, Fact>();
  for (const fact of scoped) participants.set(fact.id, fact);
  if (scoped.length === 0 && checked.scenario.length === 0) {
    raise(`${at}: the view names no participant and no scenario: a sequence diagram is drawn of the participants it names, or of the ends of the scenario's steps, and a view of neither draws nothing`);
  }
  const steps: Fact[] = [];
  let stepOf: ((fact: Fact) => number | undefined) | undefined;
  if (checked.scenario.length > 0) {
    const held = await reads.facts(checked.scenario);
    const positions = new Map<string, number>();
    const ends = new Set<string>();
    for (const [index, id] of checked.scenario.entries()) {
      const fact = held.get(id);
      if (fact === undefined) raise(`${at}: the scenario names the step ${shown(id)} and the graph holds no fact of that id: a step is an interaction the graph holds`);
      if (fact.kind !== 'interaction') raise(`${at}: the scenario names the step ${shown(id)}, a fact of kind ${fact.kind}: a sequence diagram's steps are interactions (src/fill/facts.ts)`);
      if (positions.has(id)) raise(`${at}: the scenario names the interaction ${shown(id)} twice: an interaction is one fact of the graph, and a scenario draws each of its steps once`);
      for (const end of [endsOf('interaction', fact.value).from, endsOf('interaction', fact.value).to]) if (end !== undefined) ends.add(end);
      positions.set(id, index + 1);
      steps.push(fact);
    }
    const outside = [...ends].filter((end) => participants.has(end) === false).sort(byCodePoint);
    const present = outside.length === 0 ? new Map<string, Fact>() : await reads.facts(outside);
    for (const end of outside) {
      const fact = present.get(end);
      // A view that names no participant takes them from the scenario itself: 0026 makes the spec's nodes one way of
      // saying what a view shows, and a scenario's own steps the other. A view that does name them keeps to them.
      if (fact !== undefined && scoped.length === 0) {
        participants.set(end, fact);
        continue;
      }
      if (fact !== undefined) raise(`${at}: a step of the scenario is joined to ${shown(end)}, which the view does not name as a participant: a sequence draws the participants its view names, and an end outside them is a scenario the graph does not answer`);
    }
    stepOf = (fact) => positions.get(fact.id);
  } else {
    steps.push(...await reads.edges([...participants.keys()], checked.declaration.edges));
  }
  const elements = [...participants.values()].sort((left, right) => byCodePoint(left.id, right.id)).map(elementOfFact);
  const linked = await linkEdges(steps, elements, checked.declaration, reads, { fold: false, ...(stepOf === undefined ? {} : { stepOf }) });
  return { elements: [...elements, ...linked.elements], edges: linked.arrows };
}

// ---------------------------------------------------------------------------------------------
// The size of a view, and the model
// ---------------------------------------------------------------------------------------------

/** The weaker of two ways facts stand: unresolved below an assumption below a fact. */
function weakest(left: DiagramEvidence, right: DiagramEvidence): DiagramEvidence {
  const rank = (evidence: DiagramEvidence): number => (evidence === 'unresolved' ? 0 : evidence === 'assumption' ? 1 : 2);
  return rank(left) <= rank(right) ? left : right;
}

/** The arrows of a collapsed view: each end moved to what stands for it, an arrow inside one element dropped, and the rest folded again. */
function refoldedArrows(edges: readonly DiagramEdge[], above: ReadonlyMap<string, string>): readonly DiagramEdge[] {
  const groups = new Map<string, { from: string; to: string; kinds: Set<FactEdgeKind>; facts: Set<string>; evidence: DiagramEvidence; place?: DiagramPlace }>();
  for (const edge of edges) {
    const from = above.get(edge.from) ?? edge.from;
    const to = above.get(edge.to) ?? edge.to;
    // An arrow whose ends both stand for one element is an arrow inside that element: it is not drawn between a
    // node and itself, and the element it is inside says what it stands for.
    if (from === to) continue;
    const key = `${from}\u0000${to}`;
    const group = groups.get(key) ?? { from, to, kinds: new Set<FactEdgeKind>(), facts: new Set<string>(), evidence: 'fact' as DiagramEvidence };
    for (const kind of edge.kinds) group.kinds.add(kind);
    for (const fact of edge.facts) group.facts.add(fact);
    if (group.place === undefined && edge.place !== undefined) group.place = edge.place;
    group.evidence = weakest(group.evidence, edge.evidence);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => {
      const kinds = [...group.kinds].sort(byCodePoint);
      const facts = [...group.facts].sort(byCodePoint);
      return {
        from: group.from,
        to: group.to,
        label: kinds.join(', '),
        kinds,
        facts,
        evidence: group.evidence,
        dashed: group.evidence !== 'fact',
        ...(group.place === undefined ? {} : { place: group.place }),
      } satisfies DiagramEdge;
    })
    .sort((left, right) => byCodePoint(left.from, right.from) || byCodePoint(left.to, right.to) || byCodePoint(left.facts[0] ?? '', right.facts[0] ?? ''));
}

/** The order a model's elements stand in: by the label a reader reads, then by id, so the order is a reader's and never a database's. */
function byElementOrder(left: DiagramElement, right: DiagramElement): number {
  return byCodePoint(left.label, right.label) || byCodePoint(left.id, right.id);
}

/** What one element stands for: its own id when it stands for itself, and the elements it already stood for when it does not. */
function stoodFor(element: DiagramElement): readonly string[] {
  return element.standsFor ?? [element.id];
}

/** Why a view the budget could not fit still holds too many elements, in the words the marker uses. */
function whyStillTooLarge(stopped: 'no-level' | 'level-not-held' | 'no-move' | undefined): string {
  switch (stopped) {
    case 'no-level':
      return 'no element of it has a level above it in the graph';
    case 'level-not-held':
      return 'the level above its elements is a node the graph does not hold';
    case 'no-move':
      return 'nothing of it could stand for a level above';
    case undefined:
      return 'it could not be collapsed further';
  }
}

/** The view after the node budget had its say: the elements, the arrows, and one sentence naming what happened. */
interface SizedView {
  readonly elements: readonly DiagramElement[];
  readonly edges: readonly DiagramEdge[];
  readonly collapsed: boolean;
  readonly marker: string | null;
}

/**
 * 0026's rule that a diagram stays readable by size. A view past its node budget
 * collapses to the level above — each element is replaced by the module, the
 * repository or the container kind its type calls its level above, and one
 * element of that level holds everything that collapsed into it, with the view it
 * stands for as its drill-down link. The collapse repeats until the view fits or
 * nothing is left to collapse; a view no element of which has a level above it
 * says so rather than drawing fewer nodes, so a reader always knows what a diagram
 * left out.
 */
async function sizeView(
  checked: CheckedSpec,
  gathered: Gathered,
  budget: number,
  reads: DiagramGraphReads,
): Promise<SizedView> {
  let elements: readonly DiagramElement[] = [...gathered.elements].sort(byElementOrder);
  let edges: readonly DiagramEdge[] = gathered.edges;
  const before = elements.length;
  let collapsed = false;
  /** Why the collapse stopped with too many elements, once it has: which of the three ways out the loop took. */
  let stopped: 'no-level' | 'level-not-held' | 'no-move' | undefined;
  while (elements.length > budget) {
    const above = new Map<string, string>();
    const chains = await reads.ancestors(elements.map((element) => element.id));
    for (const element of elements) {
      const level = (chains.get(element.id) ?? []).find((ancestor) => checked.declaration.above.includes(ancestor.kind));
      if (level !== undefined) above.set(element.id, level.id);
    }
    if (above.size === 0) {
      stopped = 'no-level';
      break;
    }
    const levelFacts = await reads.facts([...new Set(above.values())].sort(byCodePoint));
    const groups = new Map<string, string[]>();
    const kept: DiagramElement[] = [];
    for (const element of elements) {
      const level = above.get(element.id);
      if (level === undefined) {
        kept.push(element);
        continue;
      }
      const stood = groups.get(level) ?? [];
      stood.push(element.id);
      groups.set(level, stood);
    }
    const next: DiagramElement[] = [...kept];
    const moved = new Map<string, string>();
    for (const [level, stood] of [...groups].sort(([left], [right]) => byCodePoint(left, right))) {
      const fact = levelFacts.get(level);
      // The graph names the level above and no fact of it is held: the elements stay as they stand rather than
      // being folded into a node nothing can be drawn for. The marker below says the budget was not met.
      if (fact === undefined) continue;
      // What an element stands for never includes the element itself: a drill-down names the elements the level above
      // replaced, unless the level above was one of them and stands there alone.
      const seeding = stood.filter((id) => id !== level);
      const seedingIds = seeding.length === 0 ? stood : seeding;
      const stands = [...new Set(seedingIds.flatMap((id) => {
        const element = elements.find((each) => each.id === id);
        return element === undefined ? [id] : stoodFor(element);
      }))].sort(byCodePoint);
      for (const id of stood) moved.set(id, level);
      next.push({
        ...elementOfFact(fact),
        standsFor: stands,
        drillDown: { type: checked.type, level: checked.level, nodes: stands, href: diagramHref({ type: checked.type, level: checked.level, nodes: stands }) },
      });
    }
    if (moved.size === 0) {
      stopped = levelFacts.size === 0 ? 'level-not-held' : 'no-move';
      break;
    }
    elements = next.sort(byElementOrder);
    edges = refoldedArrows(edges, moved);
    collapsed = true;
  }
  if (elements.length > budget) {
    // The budget was not met, whatever the collapse did before it stopped: the marker says how many elements the view
    // still holds and why they could not collapse further. A view is never drawn smaller than the graph and never
    // claims a budget it does not meet.
    return { elements, edges, collapsed, marker: `truncated: the view holds ${before} elements and the ${budget}-element budget holds ${elements.length}: ${whyStillTooLarge(stopped)}` };
  }
  if (collapsed === false) return { elements, edges, collapsed: false, marker: null };
  return {
    elements,
    edges,
    collapsed: true,
    marker: `collapsed: the view holds ${before} elements and the ${budget}-element budget holds ${elements.length}: each element stands for the level above it, and its link opens the view it stands for`,
  };
}

/** The node budget a caller asked for, 0026's readability bound when it names none. */
function budgetOf(limits: Partial<DiagramLimits> | undefined): number {
  const budget = limits?.nodes ?? DEFAULT_DIAGRAM_NODE_BUDGET;
  if (typeof budget !== 'number' || Number.isInteger(budget) === false || budget < 1) {
    raise(`${here()}: the node budget is ${shown(budget)}: a diagram holds at least one element`);
  }
  return budget;
}

/** What a model is called: its type's heading and the scopes it was drawn over. */
function titleOf(checked: CheckedSpec, scoped: readonly Fact[]): string {
  const scope = scoped.length === 0 ? 'the whole product' : scoped.map((fact) => labelOf(fact)).join(', ');
  const depth = checked.declaration.depth && checked.level > 1 ? ` (depth ${checked.level})` : '';
  return `${checked.declaration.heading}: ${scope}${depth}`;
}

/**
 * The diagram models' one way in (madarch-tzte.23.2): 0026's view specification
 * read against the graph, drawn as a model a renderer can carry and nobody can
 * silently shrink. A spec the graph does not answer is refused by name — an
 * unknown node, a node kind the type cannot be made of, a level the type does not
 * have, a scenario another type was given, a scenario step outside the view — and
 * a spec that answers nothing (a repository the stages have not clustered, a
 * scope with no table) is an empty model and never an error, because an empty
 * graph is a fact about the product and not a reader's mistake.
 */
export async function buildDiagram(
  spec: DiagramViewSpec,
  reads: DiagramGraphReads,
  options: { readonly limits?: Partial<DiagramLimits> } = {},
): Promise<DiagramModel> {
  const checked = checkedSpec(spec);
  const scoped = await scopedFacts(checked, reads);
  const gathered = await gatherView(checked, scoped, reads);
  const sized = await sizeView(checked, gathered, budgetOf(options.limits), reads);
  return {
    type: checked.type,
    level: checked.level,
    title: titleOf(checked, scoped),
    nodes: checked.nodes,
    scenario: checked.scenario,
    elements: [...sized.elements].sort(byElementOrder),
    edges: sized.edges,
    collapsed: sized.collapsed,
    marker: sized.marker,
  };
}

/** One view of the type the spec named: the gathering that type is made of. */
async function gatherView(checked: CheckedSpec, scoped: readonly Fact[], reads: DiagramGraphReads): Promise<Gathered> {
  switch (checked.type) {
    case 'c4-context':
      return await gatherContext(checked, scoped, reads);
    case 'c4-container':
      return await gatherContainers(checked, scoped, reads);
    case 'c4-component':
    case 'module-dependency':
      return await gatherModules(checked, scoped, reads);
    case 'er':
      return await gatherTables(checked, scoped, reads);
    case 'sequence':
      return await gatherSequence(checked, scoped, reads);
    case 'state':
      return await gatherStates(checked, scoped, reads);
  }
}
