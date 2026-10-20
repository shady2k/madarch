/**
 * The diagrams one graph page is drawn with (madarch-tzte.23.4; decision 0026,
 * "Diagrams"): which view specifications the node's own kind can be shown by, the
 * models madarch-tzte.23.2 builds for them out of the fact store, and nothing
 * about how they are drawn.
 *
 * A page shows the diagrams its node stands in, and the rule is by kind:
 *
 * - a **repository** is a system in the product's context, a container in its own
 *   right, the modules stage 5 clustered under it at the first level that has more
 *   than one (madarch-tzte.23.7: a single top-level module says nothing about the
 *   code, so the level below it is the one a reader is shown), and the tables it
 *   holds;
 * - a **package**, a **deploy unit**, a **table** and a **column** are containers —
 *   a column's tables are drawn as the ER view of its repository, because a column
 *   is an attribute of a table and no element of a view of its own;
 * - a **module** is its own child modules in the component view, and itself among the
 *   modules of its own level it relates to in the module dependencies view;
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
import { endsOf } from './graph-reads.js';
import { byCodePoint } from '../model/order.js';
import type { Fact, FactEdgeKind, FactKind, FactNodeKind } from './facts.js';

/** The node a page is about, as the specs are derived from it. */
export interface DiagramNode {
  readonly id: string;
  readonly kind: FactKind;
  /** The name the node's value or place gives its repository, when it names one. */
  readonly repository?: string;
}

/**
 * The modules a page's module views are drawn from, as the graph holds them: the scope
 * the repository page draws a level below, and the neighbours and children a module page
 * draws beside itself. Both are read from the graph (below), so a page shows the
 * structure that is there rather than a level that only names the repository.
 */
export interface ModuleScopes {
  /** A repository's: the fact ids whose children its two module views draw — the repository's own when its top level has more than one module, else the module whose children are the first level that has. */
  readonly view?: readonly string[];
  /** A module's: the modules of its own level it relates to, which its page draws beside it. */
  readonly neighbours?: readonly string[];
  /** A module's: whether it holds child modules, which is what its module-dependency view draws when it relates to no module of its level. */
  readonly childModules?: boolean;
}

/**
 * The view specifications one node stands in, by its kind. `repositoryId` and
 * `tableId` are the fact ids of the repository and the table the node names, resolved
 * by the caller: a spec is scoped by fact ids and a node's value names its repository
 * and its table by name. `moduleScopes` is what `moduleScopesOf` read for the node: a
 * caller that names none gets a repository's module views drawn at its own top level and
 * a module drawn by its own child modules, which is the page before madarch-tzte.23.7.
 */
export function diagramSpecsFor(options: {
  readonly kind: FactKind;
  readonly id: string;
  readonly repositoryId?: string;
  readonly tableId?: string;
  readonly moduleScopes?: ModuleScopes;
}): readonly DiagramViewSpec[] {
  const { kind, id, repositoryId, tableId, moduleScopes } = options;
  switch (kind) {
    case 'repository': {
      // A repository whose clustering holds one module at the top and its real structure a level below draws that
      // level: `moduleScopes.view` is the scope whose children are the first level that has more than one module
      // (madarch-tzte.23.7), and a repository whose own top level already has more than one keeps its own id.
      const scope = moduleScopes?.view ?? [id];
      return [
        { type: 'c4-context', nodes: [] },
        { type: 'c4-container', nodes: [id] },
        { type: 'c4-component', nodes: [...scope] },
        { type: 'module-dependency', nodes: [...scope] },
        { type: 'er', nodes: [id] },
      ];
    }
    case 'package':
    case 'deploy-unit':
      return [{ type: 'c4-container', nodes: [id] }];
    case 'table':
      return [{ type: 'er', nodes: [id] }, { type: 'c4-container', nodes: [id] }];
    case 'column':
      if (tableId !== undefined) return [{ type: 'er', nodes: [tableId] }];
      if (repositoryId !== undefined) return [{ type: 'er', nodes: [repositoryId] }];
      return [];
    case 'module': {
      // The module's own child modules, and — beside them — the module among the modules it relates to at its own
      // level: a depth of 0 draws the modules a view names themselves, which is the only way a view holds a neighbour
      // no child of the module's scope holds. A module that relates to no module of its level has its children drawn
      // by the second view; a module that holds no child either keeps one view, because two diagrams of one box say
      // nothing twice, and a module nothing relates to is exactly one box.
      const neighbours = moduleScopes?.neighbours ?? [];
      const dependencies: DiagramViewSpec | undefined = neighbours.length > 0
        ? { type: 'module-dependency', nodes: [id, ...neighbours], level: 0 }
        : moduleScopes?.childModules === true ? { type: 'module-dependency', nodes: [id] } : undefined;
      return dependencies === undefined ? [{ type: 'c4-component', nodes: [id] }] : [{ type: 'c4-component', nodes: [id] }, dependencies];
    }
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

/** The kinds a module's neighbours are read through: the edge kinds the module-dependency view draws. */
const MODULE_NEIGHBOUR_EDGE_KINDS: readonly FactEdgeKind[] = ['dependency', 'import'];

/** One text field of a fact's own value, when it holds one. */
function textOf(fact: Fact, field: string): string | undefined {
  const value = fact.value;
  const held = value !== null && typeof value === 'object' ? (value as unknown as Record<string, unknown>)[field] : undefined;
  return typeof held === 'string' && held !== '' ? held : undefined;
}

/** The modules of one level: the top-level modules of a repository (they name no parent), or one module's children. */
async function modulesOfLevel(reads: DiagramGraphReads, repositoryName: string, parent: string | undefined): Promise<readonly Fact[]> {
  if (parent !== undefined) return await reads.factsWith('module', 'parent', parent);
  // A repository's top-level modules name no parent: stage 5 holds them by the repository's own `contains` edge.
  return (await reads.factsWith('module', 'repository', repositoryName)).filter((module) => textOf(module, 'parent') === undefined);
}

/**
 * The scope a repository page's module views draw, which is `[repositoryId]` unless the
 * repository's clustering puts its real structure below a single top-level module: stage
 * 5 seeds the tree with the packages, and a repository of one package is one top-level
 * module holding a level of folders (a page drawn there says nothing about the code).
 *
 * The walk descends while a level holds exactly one module, and answers the scope whose
 * children are the first level with more than one. A repository with no module at all,
 * one whose single module has nothing below it, and one whose top level already has more
 * than one all answer the repository itself.
 */
export async function moduleViewScope(reads: DiagramGraphReads, repository: { readonly id: string; readonly name: string }): Promise<readonly string[]> {
  let level = await modulesOfLevel(reads, repository.name, undefined);
  let scope = repository.id;
  while (level.length === 1) {
    const children = await modulesOfLevel(reads, repository.name, level[0]!.id);
    // The single module is a leaf: the level above it is the finest structure the clustering holds, and the
    // repository's own scope draws that one module rather than an empty level below it.
    if (children.length === 0) return [repository.id];
    scope = level[0]!.id;
    level = children;
  }
  return [scope];
}

/**
 * The modules one module relates to at its own level: the modules of the level it stands
 * in (its parent's children, or the repository's top-level ones) that a `dependency` or
 * an `import` fact joins to it. Every end is rolled up the way the module views roll it
 * up — the nearest ancestor that stands in the level — so a file of one module importing
 * a file three levels down in another names that other module, exactly as the view that
 * draws the two folds the arrow.
 *
 * An end the graph does not hold, an end inside the module itself, and an end that
 * reaches no module of the level (a file standing at the repository's root outside every
 * module) are no neighbour: the view could not stand them anywhere either.
 */
export async function moduleNeighbours(reads: DiagramGraphReads, module: Fact, repositoryName: string): Promise<readonly string[]> {
  const level = await modulesOfLevel(reads, repositoryName, textOf(module, 'parent'));
  const peers = new Set(level.map((fact) => fact.id));
  // A module the level does not hold — another product's, or one whose parent was republished — relates to nothing.
  if (peers.has(module.id) === false) return [];
  const edges = await reads.edgesIn([repositoryName], MODULE_NEIGHBOUR_EDGE_KINDS);
  const ends = new Set<string>();
  for (const edge of edges) {
    const pair = endsOf(edge.kind as FactEdgeKind, edge.value);
    if (pair.from !== undefined) ends.add(pair.from);
    if (pair.to !== undefined) ends.add(pair.to);
  }
  if (ends.size === 0) return [];
  const chains = await reads.ancestors([...ends].sort(byCodePoint));
  const peerOf = (id: string): string | undefined => {
    if (peers.has(id)) return id;
    for (const ancestor of chains.get(id) ?? []) if (peers.has(ancestor.id)) return ancestor.id;
    return undefined;
  };
  const neighbours = new Set<string>();
  for (const edge of edges) {
    const pair = endsOf(edge.kind as FactEdgeKind, edge.value);
    if (pair.from === undefined || pair.to === undefined) continue;
    const from = peerOf(pair.from);
    const to = peerOf(pair.to);
    if (from === module.id && to !== undefined && to !== module.id) neighbours.add(to);
    if (to === module.id && from !== undefined && from !== module.id) neighbours.add(from);
  }
  return [...neighbours].sort(byCodePoint);
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

/**
 * The modules a page's module views are drawn from, read from the graph for the two kinds
 * that have any: a repository's is the scope whose children are the first level with more
 * than one module, and a module's is the module among the modules of its own level it
 * relates to. Every other kind is drawn by no module view and reads nothing.
 */
async function moduleScopesOf(
  reads: DiagramGraphReads,
  kind: FactKind,
  id: string,
  repository: string | undefined,
  repositoryId: string | undefined,
): Promise<ModuleScopes | undefined> {
  if (repository === undefined || repositoryId === undefined) return undefined;
  if (kind === 'repository') return { view: await moduleViewScope(reads, { id: repositoryId, name: repository }) };
  if (kind !== 'module') return undefined;
  const module = (await reads.facts([id])).get(id);
  if (module === undefined) return undefined;
  return { neighbours: await moduleNeighbours(reads, module, repository), childModules: (await reads.factsWith('module', 'parent', id)).length > 0 };
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
  const moduleScopes = await moduleScopesOf(reads, kind, options.id, repository, repositoryId);
  const specs: DiagramViewSpec[] = [...diagramSpecsFor({
    kind,
    id: options.id,
    moduleScopes,
    ...(repositoryId === undefined ? {} : { repositoryId }),
    ...(tableId === undefined ? {} : { tableId }),
  })];
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
