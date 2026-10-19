/**
 * The diagrams one graph page is drawn with (madarch-tzte.23.4; decision 0026,
 * "Diagrams"): which view specifications the node's own kind can be shown by, the
 * models madarch-tzte.23.2 builds for them out of the fact store, and nothing
 * about how they are drawn.
 *
 * A page shows the diagrams its node stands in, and the rule is by kind:
 *
 * - a **repository** is a system in the product's context, a container in its own
 *   right, the modules stage 5 clustered under it, and the tables it holds;
 * - a **package**, a **deploy unit**, a **table** and a **column** are containers —
 *   a column's tables are drawn as the ER view of its repository, because a column
 *   is an attribute of a table and no element of a view of its own;
 * - a **module** is drawn among its siblings: the component view and the module
 *   dependencies of the repository it stands in;
 * - a **symbol** is drawn by the sequence of the interactions that name it, in code
 *   point order of the interaction facts (the graph holds no order of its own, so a
 *   symbol's page takes the one order it can state);
 * - a **state** is drawn by its machine's state diagram;
 * - the remaining page kinds (an api-endpoint, an entry-point, a test, an
 *   environment variable) are drawn as the containers of their repository, and a
 *   question, a rule and an entity proposal stand in no diagram at all — no type of
 *   0026's seven is scoped by them, and drawing them as the containers around them
 *   would say nothing about them.
 *
 * A spec the graph answers with nothing is still a spec: it comes back as an empty
 * model, which the page shows as its own words rather than as an empty frame.
 */
import type { FactStoreDatabase } from './fact-store.js';
import { readPageModel, type GraphPageModelAnswer } from './graph-pages.js';
import { isPageKind } from './page-changes.js';
import { buildFactStoreDiagram, factStoreDiagramReads, type DiagramGraphReads, type DiagramLimits, type DiagramModel, type DiagramViewSpec } from './diagrams.js';
import type { Fact, FactKind, FactNodeKind } from './facts.js';

/** The node a page is about, as the specs are derived from it. */
export interface DiagramNode {
  readonly id: string;
  readonly kind: FactKind;
  /** The name the node's value or place gives its repository, when it names one. */
  readonly repository?: string;
}

/**
 * The view specifications one node stands in, by its kind. `repositoryId` and
 * `tableId` are the fact ids of the repository and the table the node names,
 * resolved by the caller: a spec is scoped by fact ids and a node's value names
 * its repository and its table by name.
 */
export function diagramSpecsFor(options: { readonly kind: FactKind; readonly id: string; readonly repositoryId?: string; readonly tableId?: string }): readonly DiagramViewSpec[] {
  const { kind, id, repositoryId, tableId } = options;
  switch (kind) {
    case 'repository':
      return [
        { type: 'c4-context', nodes: [] },
        { type: 'c4-container', nodes: [id] },
        { type: 'c4-component', nodes: [id] },
        { type: 'module-dependency', nodes: [id] },
        { type: 'er', nodes: [id] },
      ];
    case 'package':
    case 'deploy-unit':
      return [{ type: 'c4-container', nodes: [id] }];
    case 'table':
      return [{ type: 'er', nodes: [id] }, { type: 'c4-container', nodes: [id] }];
    case 'column':
      if (tableId !== undefined) return [{ type: 'er', nodes: [tableId] }];
      if (repositoryId !== undefined) return [{ type: 'er', nodes: [repositoryId] }];
      return [];
    case 'module':
      if (repositoryId === undefined) return [];
      return [{ type: 'c4-component', nodes: [repositoryId] }, { type: 'module-dependency', nodes: [repositoryId] }];
    case 'state':
      return [{ type: 'state', nodes: [id] }];
    case 'symbol':
      // A sequence's participants are its own ends; the spec is made once the interactions are read (below).
      return [];
    case 'api-endpoint':
    case 'entry-point':
    case 'test':
    case 'environment-variable':
      return repositoryId === undefined ? [] : [{ type: 'c4-container', nodes: [repositoryId] }];
    default:
      return [];
  }
}

/** One diagram of a page: the specification it was asked for and the model the graph answered. */
export interface NodeDiagram {
  readonly spec: DiagramViewSpec;
  readonly model: DiagramModel;
}

/** One page's diagrams, or the refusal that says why the page has none. */
export type GraphDiagramsRead =
  | { readonly ok: true; readonly page: GraphPageModelAnswer; readonly diagrams: readonly NodeDiagram[] }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** The repository a node's own value or place names, as the graph spells it. */
function repositoryOf(page: GraphPageModelAnswer): string | undefined {
  const value = page.value;
  if (value !== null && typeof value === 'object' && typeof (value as { repository?: unknown }).repository === 'string') return (value as { repository: string }).repository;
  return page.node.code?.repository;
}

/** The table a column's value names, as the graph spells it. */
function tableOf(page: GraphPageModelAnswer): string | undefined {
  const value = page.value;
  if (value !== null && typeof value === 'object' && typeof (value as { table?: unknown }).table === 'string') return (value as { table: string }).table;
  return undefined;
}

/** The node fact of one kind whose value, at `field`, is exactly `value`; undefined when the graph holds none or several. */
async function oneFactOf(reads: DiagramGraphReads, kind: FactNodeKind, field: string, value: string): Promise<string | undefined> {
  const held: readonly Fact[] = await reads.factsWith(kind, field, value);
  return held.length === 1 ? held[0]!.id : undefined;
}

/**
 * One node's diagrams, read now from the fact store: the page's own kind decides
 * the specifications (`diagramSpecsFor`), and every model is built inside one
 * `snapshot` transaction of its own, so a diagram never draws an element read
 * before a publication beside an arrow read after it.
 *
 * A page the graph holds none of, and a fact of a kind with no page, are refused
 * with the page model's own words — a page about nothing would read as an absence
 * nobody stated (0005).
 */
export async function readNodeDiagrams(options: {
  readonly database: FactStoreDatabase;
  readonly product: string;
  readonly id: string;
  readonly limits?: Partial<DiagramLimits>;
  readonly at?: number;
}): Promise<GraphDiagramsRead> {
  const page = await readPageModel({ database: options.database, product: options.product, id: options.id, ...(options.at === undefined ? {} : { at: options.at }) });
  if (!page.ok) return { ok: false, code: page.code, message: page.message };
  const kind = page.page.node.kind as FactKind;
  if (!isPageKind(kind)) return { ok: false, code: 'graph-pages/not-a-page', message: `the node ${options.id} is a "${kind}" fact, and no page exists for that kind: a page exists for the kinds a registry document may be about (src/fill/page-changes.ts)` };
  const reads = factStoreDiagramReads(options.database, options.product);
  const repository = repositoryOf(page.page);
  const repositoryId = repository === undefined ? undefined : await oneFactOf(reads, 'repository', 'repository', repository);
  const table = tableOf(page.page);
  const tableId = table === undefined ? undefined : await oneFactOf(reads, 'table', 'name', table);
  const specs: DiagramViewSpec[] = [...diagramSpecsFor({ kind, id: options.id, ...(repositoryId === undefined ? {} : { repositoryId }), ...(tableId === undefined ? {} : { tableId }) })];
  if (kind === 'symbol') {
    const steps = await reads.edges([options.id], ['interaction']);
    if (steps.length > 0) specs.push({ type: 'sequence', nodes: [], scenario: steps.map((step) => step.id).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)) });
  }
  const diagrams: NodeDiagram[] = [];
  for (const spec of specs) {
    diagrams.push({ spec, model: await buildFactStoreDiagram(spec, options.database, { product: options.product, ...(options.limits === undefined ? {} : { limits: options.limits }) }) });
  }
  return { ok: true, page: page.page, diagrams };
}
