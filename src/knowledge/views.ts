/**
 * The diagram views (decision 0026, "Diagrams"; madarch-m38l.15): madarch draws from the graph, and a page only
 * chooses *what to show* — a view specification, `{type, subject, scope?, entry?}` — which this module checks against
 * the graph before it reads anything. One view is one model (elements, arrows, notes) that the three renderers draw:
 * the switcher offers every renderer that supports the view's type, the first tab following the product's setting.
 *
 * - **Types.** C4 context (the product and what it talks to), C4 container (services, databases, topics),
 *   C4 component (the modules of a service), sequence (an end-to-end chain from a route), ER (the tables of a
 *   database), state (a transition table found in the code) and deployment (compose, Kubernetes and Dockerfiles).
 * - **Solid lines are facts, dashed are assumptions.** An arrow the graph holds is solid; one the graph only suggests
 *   (an image matched to its Dockerfile by name, a service matched to a deployment by name and port, a client assumed
 *   to call the routes, a step the graph holds no order for) is dashed, and the model says why.
 * - **Elements link to their pages and code.** Every element carries the address of its page and, where it stands in a
 *   file, the place; a state has no page and links to the line of its table.
 * - **A large diagram collapses to the level above.** Past `NODE_BUDGET` elements a view folds its elements into the
 *   folders that hold them, and each folded element carries the view that opens it (drill-down); a container carries
 *   the view of its components, a database the view of its tables.
 *
 * The module reads the graph and the source through the page's `RenderContext` and writes nothing. Words a reader sees
 * inside a diagram come in both interface languages (`WORDS`); names come from the graph as they are.
 */
import { dirname } from 'node:path';
import { mermaidOfDiagram } from '../product-wiki/graph-mermaid.js';
import type { ShapeDiagram, ShapeEdge, ShapeElement } from '../product-wiki/diagram-shape.js';
import { byCodePoint } from '../model/order.js';
import type { RenderContext, Subject } from './blocks.js';
import { locationOf, refOfGraph, refOfMarkdown } from './blocks.js';
import { chainFrom, entriesOf, modulesBlockModel, pathOfKey, serviceLocator, systemModel, type Entry } from './diagrams.js';
import type { GraphEntity } from './graph-read.js';
import type { Chain, CodeLocation } from './model.js';
import { sourceAddress } from './resolve.js';
import { stateMachinesOf } from './state-machines.js';

// ---- the vocabulary ----------------------------------------------------------------------------------

export const VIEW_TYPES = ['c4-context', 'c4-container', 'c4-component', 'sequence', 'er', 'state', 'deployment', 'domain', 'domain-map'] as const;
export type ViewType = (typeof VIEW_TYPES)[number];

/** The renderers, in the order the tabs stand in when the setting does not move one to the front. */
export const RENDERERS = ['likec4', 'mermaid', 'archify'] as const;
export type Renderer = (typeof RENDERERS)[number];

/**
 * What each type is drawn by (decision 0026): archify and Mermaid wherever they can, LikeC4 for C4 and deployment. The
 * vendored archify renders an architecture document — components and connections — and so draws no lifeline with an
 * order: a sequence is Mermaid's alone.
 */
export const RENDERERS_OF: Readonly<Record<ViewType, readonly Renderer[]>> = {
  'c4-context': ['likec4', 'mermaid', 'archify'],
  'c4-container': ['likec4', 'mermaid', 'archify'],
  'c4-component': ['likec4', 'mermaid', 'archify'],
  deployment: ['likec4', 'mermaid', 'archify'],
  domain: ['likec4', 'mermaid', 'archify'],
  'domain-map': ['likec4', 'mermaid', 'archify'],
  er: ['mermaid'],
  state: ['mermaid', 'archify'],
  sequence: ['mermaid'],
};

/** The renderer the tabs open on when neither the product nor the environment names one. */
export const DEFAULT_RENDERER: Renderer = 'likec4';

/**
 * The first tab: the product's setting, else `MADARCH_WIKI_DIAGRAM`, else LikeC4; a type the renderer cannot draw falls
 * back to the first renderer of the fixed order that can, so no tab ever draws nothing. A value that is no renderer is
 * a refusal naming where it came from.
 */
export function chosenRenderer(product: string | undefined, env: Readonly<Record<string, string | undefined>>): { ok: true; renderer: Renderer } | { ok: false; message: string } {
  const [value, source] = product !== undefined ? [product, 'the "diagram" setting of the manifest'] : env['MADARCH_WIKI_DIAGRAM'] !== undefined && env['MADARCH_WIKI_DIAGRAM'] !== '' ? [env['MADARCH_WIKI_DIAGRAM'], 'MADARCH_WIKI_DIAGRAM'] : [DEFAULT_RENDERER, 'the default'];
  const renderer = RENDERERS.find((candidate) => candidate === value);
  if (renderer === undefined) return { ok: false, message: `${source} is ${JSON.stringify(value)}: the diagram renderers are ${RENDERERS.map((name) => `"${name}"`).join(', ')}` };
  return { ok: true, renderer };
}

/** The tabs of one type, the chosen renderer first. */
export function tabsOf(type: ViewType, chosen: Renderer): Renderer[] {
  const supported = RENDERERS.filter((renderer) => RENDERERS_OF[type].includes(renderer));
  return supported.includes(chosen) ? [chosen, ...supported.filter((renderer) => renderer !== chosen)] : supported;
}

/** What a view is of. `subject` is an entity key, a Markdown page's id, or empty for the whole product. */
export interface ViewSpec {
  type: ViewType;
  subject: string;
  /** A folded element's id: the view of what it stands for. */
  scope?: string;
  /** A sequence's entry point (a route or function key) when the subject is a page with several. */
  entry?: string;
}

/** A refusal of a specification, naming what is wrong with it. */
export class ViewRefusal extends Error {
  constructor(readonly status: 400 | 404, message: string) {
    super(message);
  }
}

/** The specification a request carries (`type`, `subject`, `scope`, `entry`), or the refusal naming the field. */
export function parseSpec(query: URLSearchParams): ViewSpec {
  const type = query.get('type');
  if (type === null || !(VIEW_TYPES as readonly string[]).includes(type)) throw new ViewRefusal(400, `"type" is ${JSON.stringify(type)}: the diagram types are ${VIEW_TYPES.join(', ')}`);
  const spec: ViewSpec = { type: type as ViewType, subject: query.get('subject') ?? '' };
  const scope = query.get('scope');
  if (scope !== null && scope !== '') spec.scope = scope;
  const entry = query.get('entry');
  if (entry !== null && entry !== '') spec.entry = entry;
  return spec;
}

/** The specification as the query a request carries it in. */
export function specQuery(spec: ViewSpec): string {
  const query = new URLSearchParams({ type: spec.type, subject: spec.subject });
  if (spec.scope !== undefined) query.set('scope', spec.scope);
  if (spec.entry !== undefined) query.set('entry', spec.entry);
  return query.toString();
}

// ---- the model ---------------------------------------------------------------------------------------

/** How many elements a view shows before it folds them into the level above. */
export const NODE_BUDGET = 40;

export interface ViewElement {
  id: string;
  label: string;
  /** The look: the kind the renderers style (`container`, `database`, `channel`, `external`, `person`, `component`, `table`, `participant`, `state`, `node`, `image`, `product`). */
  kind: string;
  /** One more line under the name. */
  detail?: string;
  /** The page the element opens, when its kind has one. */
  href: string | null;
  /** Where it stands in code. */
  location?: CodeLocation;
  /** An assumption, not a fact. */
  dashed: boolean;
  /** The element that holds this one (a compose file around its services). */
  parent?: string;
  /** The view the element opens: a container's components, a folded folder's members. */
  drill?: { spec: ViewSpec; title: string };
  /** A table's columns. */
  columns?: { name: string; type?: string; key?: boolean; fk?: boolean }[];
  /** How many elements a folded element stands for. */
  standsFor?: number;
}

export interface ViewEdge {
  /** A graph relation discriminator, retained when parallel facts share both ends. */
  discriminator?: string;
  from: string;
  to: string;
  label: string;
  dashed: boolean;
  /** Why the arrow is dashed, in words. */
  why?: string;
  step?: number;
  /** A sequence step's kind (route, call, read, write, http, grpc, publish, consume). */
  kind?: string;
  /** What the step adds: the middleware a route runs under, the code that calls a service remotely. */
  note?: string;
  href?: string | null;
  location?: CodeLocation;
}

/** One view, ready for the renderers and the page. */
export interface GraphView {
  spec: ViewSpec;
  title: string;
  /** What the view is, as the switcher names it. */
  label: string;
  elements: ViewElement[];
  edges: ViewEdge[];
  /** All raw members and facts, retained beside a budgeted picture without invented ownership. */
  fullElements?: ViewElement[];
  fullEdges?: ViewEdge[];
  notes: string[];
  /** Why nothing is drawn, when nothing is. */
  empty: string | null;
  /** The view one level up. */
  up?: { spec: ViewSpec; title: string };
  /** Set when the budget folded the view. */
  marker: string | null;
  /** A hand-written Mermaid source for the types whose own syntax reads better than a flowchart (ER, state) while every line is a fact. */
  mermaid?: string;
}

/** Russian counts a noun in three forms: one, two to four, and the rest. */
function russianPlural(n: number, one: string, few: string, many: string): string {
  const rest10 = n % 10;
  const rest100 = n % 100;
  if (rest10 === 1 && rest100 !== 11) return one;
  if (rest10 >= 2 && rest10 <= 4 && (rest100 < 12 || rest100 > 14)) return few;
  return many;
}

/** The three languages' words inside a diagram. */
const WORDS = {
  en: {
    client: 'Clients', clientDetail: 'assumed: the graph holds routes, not who calls them', uses: 'uses (assumed)', system: 'The system',
    context: 'Context', containers: 'Containers', components: 'Components', deployment: 'Deployment', er: 'Tables', state: 'States', sequence: 'Chain',
    unorderedWhy: 'the graph holds no order for this step', nameMatchWhy: 'matched by name only', portMatchWhy: 'matched by name and port only',
    caller: 'Caller', foreignKey: 'foreign key', routesTo: 'routes to', builds: 'builds', dependsOn: 'depends on', builtBy: 'built by', replicas: (n: number) => `${n} replica${n === 1 ? '' : 's'}`,
    folded: (n: number, g: string) => `${n} in ${g}`, truncated: (shown: number, total: number) => `Showing ${shown} of ${total}.`, erIncoming: 'Incoming foreign keys', erOutgoing: 'Outgoing foreign keys',
    columnsTruncated: (list: string) => `Some columns are not drawn: ${list}.`,
    files: (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`, cycle: 'cycle',
    noServices: 'The graph holds no service yet.', noModules: (root: string) => `The graph holds no module under ${root}.`, noTables: 'The graph holds no table here.',
    noMachines: 'No transition table was found in the code of this page.', noDeploy: 'The graph holds no compose service, Kubernetes deployment or Dockerfile.',
    noEntry: 'No route or function of the graph starts a chain here.', outside: (n: number) => `${n} links to elements outside this folder are not drawn.`,
    folding: (shown: number, total: number) => `${total} elements fold into ${shown} folders; open a folder to see its members.`,
    ownershipFolding: (shown: number, total: number) => `${total} elements are represented by ${shown} ownership groups; open a group to see its members.`,
    foldedLinks: (n: number) => `${n} relationships inside folded groups are shown when those groups are opened.`,
    stepsFolded: (n: number) => `${n} further steps are not drawn.`,
    entriesFolded: (shown: number, total: number) => `${total} entry points start a chain here; the ${shown} first are drawn, and each one opens on its own page.`,
    filesNotSearched: (n: number) => `${n} further files of this page were not searched for a transition table.`,
    domain: 'Domain', domains: 'Domains', neighbours: 'neighbouring domain', implementedBy: 'implemented by', implementedWhy: 'which service implements a domain is the agent\'s reading of the code, not a fact the graph holds',
    mentions: 'mentions', mentioned: (shown: number, total: number) => `Showing ${shown} of ${total} pages whose text names the domain.`, mentionsWhy: 'the text names the domain; nothing in the graph links them', neighbourWhy: 'which domain the service belongs to is the agent\'s reading', uses2: 'uses', noDomains: 'No page relates to a service of the graph, so there is no map of domains to draw.',
    domainOf: (title: string) => `Domain: ${title}`, event: (name: string) => `event ${name}`, nothingNearby: 'Nothing else the graph knows is attached to this domain.',
  },
  ru: {
    client: 'Клиенты', clientDetail: 'предположение: граф знает маршруты, но не знает, кто их вызывает', uses: 'пользуются (предположение)', system: 'Система',
    context: 'Контекст', containers: 'Контейнеры', components: 'Компоненты', deployment: 'Развёртывание', er: 'Таблицы', state: 'Состояния', sequence: 'Цепочка',
    unorderedWhy: 'граф не знает порядка этого шага', nameMatchWhy: 'сопоставлено только по имени', portMatchWhy: 'сопоставлено только по имени и порту',
    caller: 'Вызывающий', foreignKey: 'внешний ключ', routesTo: 'направляет на', builds: 'собирает', dependsOn: 'зависит от', builtBy: 'собран из', replicas: (n: number) => `реплик: ${n}`,
    folded: (n: number, g: string) => `${n} в ${g}`, truncated: (shown: number, total: number) => `Показано ${shown} из ${total}.`, erIncoming: 'Входящие внешние ключи', erOutgoing: 'Исходящие внешние ключи',
    columnsTruncated: (list: string) => `Часть столбцов не нарисована: ${list}.`,
    files: (n: number) => `${n} ${russianPlural(n, 'файл', 'файла', 'файлов')}`, cycle: 'цикл',
    noServices: 'В графе пока нет ни одного сервиса.', noModules: (root: string) => `В графе нет модулей в ${root}.`, noTables: 'В графе здесь нет таблиц.',
    noMachines: 'В коде этой страницы не найдено таблицы переходов.', noDeploy: 'В графе нет ни сервисов compose, ни развёртываний Kubernetes, ни Dockerfile.',
    noEntry: 'Ни один маршрут или функция графа не начинает здесь цепочку.', outside: (n: number) => `Связи с элементами за пределами этой папки (${n}) не нарисованы.`,
    folding: (shown: number, total: number) => `${total} элементов свёрнуты в ${shown} папок; откройте папку, чтобы увидеть её содержимое.`,
    ownershipFolding: (shown: number, total: number) => `${total} элементов представлены группами владения (${shown}); откройте группу, чтобы увидеть её содержимое.`,
    foldedLinks: (n: number) => `Связи внутри свёрнутых групп (${n}) показаны при открытии этих групп.`,
    stepsFolded: (n: number) => `Ещё ${n} шагов не нарисованы.`,
    entriesFolded: (shown: number, total: number) => `Здесь ${total} точек входа начинают цепочку; нарисованы первые ${shown}, каждая открывается на своей странице.`,
    filesNotSearched: (n: number) => `Ещё ${n} файлов этой страницы не проверялись на таблицу переходов.`,
    domain: 'Домен', domains: 'Домены', neighbours: 'соседний домен', implementedBy: 'реализует', implementedWhy: 'какой сервис реализует домен, решил агент по коду; граф такого факта не хранит',
    mentions: 'упоминает', mentioned: (shown: number, total: number) => `Показано ${shown} из ${total} страниц, в тексте которых назван домен.`, mentionsWhy: 'текст называет домен; в графе между ними связи нет', neighbourWhy: 'к какому домену относится сервис, решил агент', uses2: 'использует', noDomains: 'Ни одна страница не связана с сервисом графа, поэтому карту доменов рисовать не из чего.',
    domainOf: (title: string) => `Домен: ${title}`, event: (name: string) => `событие ${name}`, nothingNearby: 'К этому домену не привязано ничего из того, что знает граф.',
  },
};
export type Words = (typeof WORDS)['en'];
export const wordsOf = (lang: string | undefined): Words => (lang === 'ru' ? WORDS.ru : WORDS.en);

const via = (word: string, label: string): string => {
  // One label per relation: a label that already says the verb is not said twice ("publishes publishes").
  if (label === '') return word;
  const verb = word.split(' (')[0]!.toLowerCase();
  return label.toLowerCase().startsWith(verb) ? label : `${word} ${label}`;
};

// ---- shared helpers ----------------------------------------------------------------------------------

const keyTail = (key: string): string => key.slice(key.indexOf(':') + 1);

async function entityAt(ctx: RenderContext, key: string): Promise<GraphEntity | undefined> {
  return (await ctx.graph.find(key))[0];
}

function hrefOf(ctx: RenderContext, entity: GraphEntity): string | null {
  return refOfGraph(ctx, entity).href;
}

/** The fewest-folders fold of elements into their folders when the budget is passed: folder name per element id. */
function foldInto<T extends { id: string }>(items: readonly T[], folderOf: (item: T) => string, budget: number): { folders: Map<string, T[]> } | undefined {
  if (items.length <= budget) return undefined;
  const folders = new Map<string, T[]>();
  for (const item of items) {
    const folder = folderOf(item);
    folders.set(folder, [...(folders.get(folder) ?? []), item]);
  }
  // One folder holding everything folds nothing: a flat product has no level above to fold into.
  return folders.size <= 1 ? undefined : { folders };
}

/** A bounded first picture with every raw member and relationship available in the adjacent full list. */
function firstOwnershipPage(view: GraphView, w: Words): GraphView {
  const ordered: ViewElement[] = [];
  const visited = new Set<string>();
  const visit = (parent: string | undefined): void => {
    for (const element of view.elements.filter(item => item.parent === parent).sort((a, b) => byCodePoint(a.id, b.id))) {
      if (visited.has(element.id)) throw new ViewRefusal(400, `the ${view.spec.type} view repeats ownership element "${element.id}"`);
      visited.add(element.id);
      ordered.push(element);
      visit(element.id);
    }
  };
  visit(undefined);
  if (ordered.length !== view.elements.length) throw new ViewRefusal(400, `the ${view.spec.type} view has cyclic or missing ownership parents`);
  const elements = ordered.slice(0, NODE_BUDGET);
  const ids = new Set(elements.map(element => element.id));
  return { ...view, elements, edges: view.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)), fullElements: view.fullElements ?? ordered, fullEdges: view.fullEdges ?? view.edges, marker: [view.marker, w.truncated(elements.length, ordered.length)].filter(Boolean).join(' ') };
}

/** Fold only an ownership level the graph actually holds. Scoped views reopen that exact parent and its children. */
function foldOwnership(view: GraphView, w: Words): GraphView {
  const all = view.elements;
  if (view.spec.scope !== undefined) {
    const holder = all.find(element => element.id === view.spec.scope);
    if (!holder) throw new ViewRefusal(404, `the ${view.spec.type} scope "${view.spec.scope}" is not an ownership group in this view`);
    const ids = new Set([holder.id]);
    const collect = (id: string): void => { for (const child of all.filter(element => element.parent === id)) { ids.add(child.id); collect(child.id); } };
    collect(holder.id);
    const outside = view.edges.filter(edge => ids.has(edge.from) !== ids.has(edge.to)).length;
    const scoped = { ...view, elements: all.filter(element => ids.has(element.id)), edges: view.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)), notes: [...view.notes, ...(outside > 0 ? [w.outside(outside)] : [])], up: { spec: { type: view.spec.type, subject: view.spec.subject }, title: view.label }, marker: null };
    // The reopened holder is the root of this picture; its recorded parent may be outside the scope.
    const rooted = { ...scoped, elements: scoped.elements.map(element => element.id === holder.id ? { ...element, parent: undefined } : element) };
    const result = ids.size > NODE_BUDGET ? firstOwnershipPage(rooted, w) : rooted;
    return result.fullElements === undefined ? result : { ...result, fullElements: scoped.elements };
  }
  if (all.length <= NODE_BUDGET) return view;
  const roots = all.filter(element => element.parent === undefined);
  // Unrelated roots and one oversized group still get an ordinary first picture, never a fabricated owner.
  if (roots.length > NODE_BUDGET || roots.length === all.length || roots.length === 1) return firstOwnershipPage(view, w);
  const owner = new Map<string, string>();
  const represented = (id: string): number => {
    owner.set(id, id);
    let count = 1;
    for (const child of all.filter(element => element.parent === id)) {
      count += represented(child.id);
      for (const [member, root] of owner) if (root === child.id) owner.set(member, id);
    }
    return count;
  };
  const elements = roots.map(root => {
    const count = represented(root.id);
    return count === 1 ? root : { ...root, standsFor: count, detail: w.folded(count, root.label), drill: { spec: { type: view.spec.type, subject: view.spec.subject, scope: root.id }, title: root.label } };
  });
  const merged = new Map<string, ViewEdge>();
  let internal = 0;
  for (const edge of view.edges) {
    const from = owner.get(edge.from)!, to = owner.get(edge.to)!;
    if (from === to) { internal++; continue; }
    // Distinct labels/assumption reasons remain distinct. Only identical copied facts combine in the overview.
    const key = JSON.stringify([from, to, edge.label, edge.dashed, edge.why ?? null]);
    merged.set(key, { ...edge, from, to });
  }
  return { ...view, elements, fullElements: all, fullEdges: view.edges, edges: [...merged.values()].sort((a, b) => byCodePoint(JSON.stringify(a), JSON.stringify(b))), notes: [...view.notes, ...(internal > 0 ? [w.foldedLinks(internal)] : [])], marker: w.ownershipFolding(elements.length, all.length) };
}

/** The shape renderers read, from a view. */
export function shapeOf(view: GraphView): ShapeDiagram {
  const elements: ShapeElement[] = view.elements.map((element) => ({
    id: element.id,
    kind: element.kind,
    label: element.label,
    dashed: element.dashed,
    ...(element.detail === undefined ? {} : { detail: element.detail }),
    ...(element.href === null ? {} : { page: { id: element.id, href: element.href } }),
    ...(element.parent === undefined ? {} : { parent: element.parent }),
    ...(element.columns === undefined ? {} : {
      columns: element.columns.map((column) => ({ id: `${element.id}/${column.name}`, label: column.name, dataType: `${column.type ?? 'text'}${column.key ? ' PK' : ''}${column.fk ? ' FK' : ''}`, evidence: 'fact' as const, dashed: false, page: { id: element.id, href: element.href ?? '' } })),
    }),
  }));
  return {
    type: view.spec.type === 'sequence' ? 'sequence' : view.spec.type,
    title: view.title,
    elements,
    edges: view.edges.map((edge): ShapeEdge => ({ from: edge.from, to: edge.to, label: edge.label, dashed: edge.dashed, ...(edge.step === undefined ? {} : { step: edge.step }) })),
  };
}

/** The Mermaid source of a view: its own where the type has a better syntax, else the shared flowchart or sequence. */
export function mermaidOfView(view: GraphView): string {
  return view.mermaid ?? mermaidOfDiagram(shapeOf(view));
}

const empty = (spec: ViewSpec, title: string, label: string, reason: string, up?: GraphView['up']): GraphView => ({ spec, title, label, elements: [], edges: [], notes: [], empty: reason, marker: null, ...(up === undefined ? {} : { up }) });

// ---- C4 container and context ------------------------------------------------------------------------

const VIA_WORD: Readonly<Record<string, string>> = { http: 'HTTP', grpc: 'gRPC', sql: 'SQL', publishes: 'publishes', consumes: 'consumes' };

async function containerView(ctx: RenderContext, spec: ViewSpec, w: Words): Promise<GraphView> {
  const title = w.containers;
  const model = await systemModel(ctx);
  if (model.nodes.length === 0) return empty(spec, title, w.containers, w.noServices);
  const kindOf: Record<string, string> = { service: 'container', database: 'database', topic: 'channel', external: 'external' };
  const entities = new Map<string, GraphEntity | undefined>();
  for (const node of model.nodes) if (node.kind === 'service') entities.set(node.id, await entityAt(ctx, node.id));
  let elements: ViewElement[] = model.nodes.map((node) => {
    const entity = entities.get(node.id);
    return {
      id: node.id,
      label: node.label,
      kind: kindOf[node.kind] ?? 'container',
      ...(node.sub === '' ? {} : { detail: node.sub }),
      href: node.href,
      ...(entity?.span === undefined ? {} : { location: locationOf(ctx, entity.scope, entity.span) }),
      dashed: false,
      ...(node.kind === 'service' ? { drill: { spec: { type: 'c4-component' as const, subject: node.id }, title: w.components } } : {}),
      ...(node.kind === 'database' ? { drill: { spec: { type: 'er' as const, subject: node.id }, title: w.er } } : {}),
    };
  });
  let edges: ViewEdge[] = model.edges.map((edge) => ({ from: edge.from, to: edge.to, label: via(VIA_WORD[edge.via] ?? edge.via, edge.count > 1 ? `${edge.label} ×${edge.count}` : edge.label), dashed: false }));
  const notes = [...model.notes];
  let marker: string | null = null;
  // Past the budget the services fold into the folders that hold them; a folder opens as a view of its own.
  const folderOf = (element: ViewElement): string => {
    const entity = entities.get(element.id);
    return entity?.span === undefined ? element.kind : dirname(entity.span.path);
  };
  if (spec.scope !== undefined) {
    const members = elements.filter((element) => folderOf(element) === spec.scope);
    if (members.length === 0) throw new ViewRefusal(404, `the folder "${spec.scope}" holds no container of this product: the container view folds only folders it drew`);
    const ids = new Set(members.map((member) => member.id));
    const outside = edges.filter((edge) => ids.has(edge.from) !== ids.has(edge.to)).length;
    edges = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
    elements = members;
    if (outside > 0) notes.push(w.outside(outside));
    const scoped: GraphView = { spec, title: `${title}: ${spec.scope}`, label: title, elements, edges, notes, empty: null, up: { spec: { type: 'c4-container', subject: '' }, title }, marker };
    return elements.length > NODE_BUDGET ? firstOwnershipPage(scoped, w) : scoped;
  }
  const fullElements = elements;
  const fullEdges = edges;
  const folded = foldInto(elements, folderOf, NODE_BUDGET);
  if (folded !== undefined) {
    const owner = new Map<string, string>();
    const folders: ViewElement[] = [];
    for (const [folder, members] of [...folded.folders.entries()].sort((a, b) => byCodePoint(a[0], b[0]))) {
      const id = `folder:${folder}`;
      for (const member of members) owner.set(member.id, id);
      folders.push({ id, label: folder, kind: 'container', detail: w.folded(members.length, folder), href: null, dashed: false, standsFor: members.length, drill: { spec: { type: 'c4-container', subject: '', scope: folder }, title: folder } });
    }
    const merged = new Map<string, ViewEdge>();
    for (const edge of edges) {
      const from = owner.get(edge.from)!;
      const to = owner.get(edge.to)!;
      if (from === to) continue;
      const key = `${from}|${to}`;
      const held = merged.get(key);
      if (held === undefined) merged.set(key, { from, to, label: edge.label, dashed: false });
      else if (!held.label.split(' · ').includes(edge.label) && held.label.length < 60) held.label = `${held.label} · ${edge.label}`;
    }
    elements = folders;
    edges = [...merged.values()];
    marker = w.folding(folders.length, model.nodes.length);
  }
  const result: GraphView = { spec, title, label: w.containers, elements, edges, notes, empty: null, marker, ...(folded === undefined ? {} : { fullElements, fullEdges }) };
  return elements.length > NODE_BUDGET ? firstOwnershipPage(result, w) : result;
}

async function contextView(ctx: RenderContext, spec: ViewSpec, w: Words, productTitle: string): Promise<GraphView> {
  const title = w.context;
  const model = await systemModel(ctx);
  const services = model.nodes.filter((node) => node.kind === 'service');
  if (services.length === 0) return empty(spec, title, w.context, w.noServices);
  const system: ViewElement = { id: 'product', label: productTitle, kind: 'product', detail: w.system, href: null, dashed: false, drill: { spec: { type: 'c4-container', subject: '' }, title: w.containers } };
  const externals = model.nodes.filter((node) => node.kind === 'external');
  const elements: ViewElement[] = [
    { id: 'clients', label: w.client, kind: 'person', detail: w.clientDetail, href: null, dashed: true },
    system,
    ...externals.map((node): ViewElement => ({ id: node.id, label: node.label, kind: 'external', detail: node.sub, href: node.href, dashed: false })),
  ];
  const edges: ViewEdge[] = [{ from: 'clients', to: 'product', label: w.uses, dashed: true, why: w.clientDetail }];
  const serviceIds = new Set(services.map((service) => service.id));
  const merged = new Map<string, ViewEdge>();
  for (const edge of model.edges) {
    if (!serviceIds.has(edge.from) || !externals.some((node) => node.id === edge.to)) continue;
    const key = `product|${edge.to}`;
    const word = via(VIA_WORD[edge.via] ?? edge.via, edge.label);
    const held = merged.get(key);
    if (held === undefined) merged.set(key, { from: 'product', to: edge.to, label: word, dashed: false });
    else if (!held.label.split(' · ').includes(word)) held.label = `${held.label} · ${word}`;
  }
  edges.push(...merged.values());
  return { spec, title, label: w.context, elements, edges, notes: [...model.notes], empty: null, marker: null };
}

// ---- C4 component ------------------------------------------------------------------------------------

async function componentView(ctx: RenderContext, spec: ViewSpec, w: Words): Promise<GraphView> {
  const service = await entityAt(ctx, spec.subject);
  if (service === undefined || service.kind !== 'code.service') throw new ViewRefusal(404, `"${spec.subject}" is no service of the graph: a component view is the modules of a service`);
  const up = { spec: { type: 'c4-container' as const, subject: '' }, title: w.containers };
  const title = `${w.components}: ${service.label}`;
  const model = await modulesBlockModel(ctx, { source: 'graph', entity: service });
  if (model === undefined) return empty(spec, title, w.components, w.noModules(service.span?.path ?? service.key), up);
  if (model.nodes.length === 0) return empty(spec, title, w.components, w.noModules(dirname(service.span?.path ?? '.')), up);
  let nodes = model.nodes;
  let edges = model.edges;
  const notes = [...model.notes];
  let marker: string | null = null;
  const topFolder = (label: string): string => (label.includes('/') ? label.slice(0, label.indexOf('/')) : label);
  const byKey = new Map(nodes.map((node) => [node.id, node]));
  if (spec.scope !== undefined) {
    const members = nodes.filter((node) => topFolder(node.label) === spec.scope);
    if (members.length === 0) throw new ViewRefusal(404, `the folder "${spec.scope}" holds no module of ${service.label}: the component view folds only folders it drew`);
    const ids = new Set(members.map((member) => member.id));
    const outside = edges.filter((edge) => ids.has(edge.from) !== ids.has(edge.to)).length;
    nodes = members;
    edges = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
    if (outside > 0) notes.push(w.outside(outside));
    const elements = nodes.map((node): ViewElement => ({ id: node.id, label: node.label, kind: 'component', detail: `${w.files(node.files)}${node.cycle ? ` · ${w.cycle}` : ''}`, href: node.href, dashed: false }));
    const scoped: GraphView = { spec, title: `${title} / ${spec.scope}`, label: w.components, elements, edges: edges.map((edge) => ({ from: edge.from, to: edge.to, label: edge.cycle ? 'cycle' : w.dependsOn, dashed: false })), notes, empty: null, up: { spec: { type: 'c4-component', subject: spec.subject }, title }, marker };
    return elements.length > NODE_BUDGET ? firstOwnershipPage(scoped, w) : scoped;
  }
  let elements: ViewElement[] = nodes.map((node) => ({ id: node.id, label: node.label, kind: 'component', detail: `${w.files(node.files)}${node.cycle ? ` · ${w.cycle}` : ''}`, href: node.href, dashed: false }));
  let arrows: ViewEdge[] = edges.map((edge) => ({ from: edge.from, to: edge.to, label: edge.cycle ? 'cycle' : w.dependsOn, dashed: false }));
  const fullElements = elements;
  const fullEdges = arrows;
  const folded = foldInto(nodes.map((node) => ({ id: node.id })), (item) => topFolder(byKey.get(item.id)!.label), NODE_BUDGET);
  if (folded !== undefined) {
    const owner = new Map<string, string>();
    const folders: ViewElement[] = [];
    for (const [folder, members] of [...folded.folders.entries()].sort((a, b) => byCodePoint(a[0], b[0]))) {
      const id = `folder:${folder}`;
      for (const member of members) owner.set(member.id, id);
      const cycle = members.some((member) => byKey.get(member.id)!.cycle);
      folders.push({ id, label: folder, kind: 'component', detail: `${w.folded(members.length, folder)}${cycle ? ' · cycle' : ''}`, href: null, dashed: false, standsFor: members.length, drill: { spec: { type: 'c4-component', subject: spec.subject, scope: folder }, title: folder } });
    }
    const merged = new Map<string, ViewEdge>();
    for (const edge of arrows) {
      const from = owner.get(edge.from)!;
      const to = owner.get(edge.to)!;
      if (from === to) continue;
      merged.set(`${from}|${to}`, { from, to, label: w.dependsOn, dashed: false });
    }
    elements = folders;
    arrows = [...merged.values()];
    marker = w.folding(folders.length, nodes.length);
  }
  const result: GraphView = { spec, title, label: w.components, elements, edges: arrows, notes, empty: null, up, marker, ...(folded === undefined ? {} : { fullElements, fullEdges }) };
  return elements.length > NODE_BUDGET ? firstOwnershipPage(result, w) : result;
}

// ---- ER ----------------------------------------------------------------------------------------------

const erType = (type: unknown): string => {
  const word = String(type ?? 'text').trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9_(),-]/g, '');
  return word === '' ? 'text' : word;
};

async function erView(ctx: RenderContext, spec: ViewSpec, w: Words, limit: number): Promise<GraphView> {
  const subject = await entityAt(ctx, spec.subject);
  if (subject === undefined || (subject.kind !== 'code.database' && subject.kind !== 'code.table')) throw new ViewRefusal(404, `"${spec.subject}" is no database or table of the graph: an ER view draws the tables of a database`);
  const up = { spec: { type: 'c4-container' as const, subject: '' }, title: w.containers };
  let tables: GraphEntity[];
  let total: number;
  if (subject.kind === 'code.database') {
    let found = await ctx.graph.byPrefix('code.table', `code.table:${keyTail(subject.key)}/`, limit);
    if (found.total > found.rows.length) found = await ctx.graph.byPrefix('code.table', `code.table:${keyTail(subject.key)}/`, found.total);
    if (found.total !== found.rows.length) throw new ViewRefusal(400, `ER database "${subject.key}": expected ${found.total} tables, read ${found.rows.length}`);
    tables = found.rows;
    total = found.total;
  } else {
    // A table is drawn with the tables it points to by foreign key and the tables that point to it.
    tables = [subject];
    for (const direction of ['out', 'in'] as const) {
      let groups = await ctx.graph.neighbors(subject, { relations: ['code.foreign-key'], direction, limit: Math.max(20, limit) });
      const total = Math.max(0, ...groups.map(group => group.total));
      if (groups.some(group => group.total > group.rows.length)) groups = await ctx.graph.neighbors(subject, { relations: ['code.foreign-key'], direction, limit: total });
      for (const group of groups) {
        if (group.total !== group.rows.length) throw new ViewRefusal(400, `ER table "${subject.key}" ${direction}: expected ${group.total} foreign-key neighbours, read ${group.rows.length}`);
        for (const row of group.rows) if (!tables.some((table) => table.key === row.entity.key)) tables.push(row.entity);
      }
    }
    total = tables.length;
  }
  const title = `${w.er}: ${subject.label}`;
  if (tables.length === 0) return empty(spec, title, w.er, w.noTables, up);
  const inView = new Set(tables.map((table) => table.key));
  const elements: ViewElement[] = [];
  // Keep the relation discriminator and column on each fact: two columns can reference the same table.
  let foreignKeys = await ctx.graph.relationEdges('code.foreign-key', 2000);
  if (foreignKeys.total > foreignKeys.rows.length) foreignKeys = await ctx.graph.relationEdges('code.foreign-key', foreignKeys.total);
  if (foreignKeys.total !== foreignKeys.rows.length) throw new ViewRefusal(400, `ER foreign keys: expected ${foreignKeys.total} relationships, read ${foreignKeys.rows.length}`);
  const columnsOf = new Map<string, Set<string>>();
  for (const edge of foreignKeys.rows) {
    const column = edge.properties['column'];
    if (typeof column !== 'string' || column === '') continue;
    const columns = columnsOf.get(edge.from.key) ?? new Set<string>();
    columns.add(column);
    columnsOf.set(edge.from.key, columns);
  }
  for (const table of tables) {
    let columns = await ctx.graph.byPrefix('code.column', `${table.key}/`, 40);
    if (columns.total > columns.rows.length) columns = await ctx.graph.byPrefix('code.column', `${table.key}/`, columns.total);
    if (columns.total !== columns.rows.length) throw new ViewRefusal(400, `ER table "${table.key}": expected ${columns.total} columns, read ${columns.rows.length}`);
    const ownColumns = columnsOf.get(table.key) ?? new Set<string>();
    elements.push({
      id: table.key,
      label: table.label,
      kind: 'table',
      href: hrefOf(ctx, table),
      ...(table.span === undefined ? {} : { location: locationOf(ctx, table.scope, table.span) }),
      dashed: false,
      columns: columns.rows.map((column) => ({ name: column.label, type: erType(column.properties['type']), key: column.properties['primaryKey'] === true, fk: ownColumns.has(column.label) })),
    });
  }
  const edges: ViewEdge[] = [];
  const seen = new Set<string>();
  for (const table of tables) {
    for (const edge of foreignKeys.rows) {
      if (edge.from.key !== table.key || !inView.has(edge.to.key)) continue;
      const column = edge.properties['column'];
      const label = typeof column === 'string' && column !== '' ? column : w.foreignKey;
      const key = JSON.stringify([edge.from.key, edge.to.key, edge.discriminator ?? edge.properties['constraint'] ?? label]);
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: table.key, to: edge.to.key, label, dashed: false, ...(edge.discriminator === undefined ? {} : { discriminator: edge.discriminator }) });
    }
  }
  edges.sort((a, b) => byCodePoint(`${a.from}|${a.to}|${a.label}`, `${b.from}|${b.to}|${b.label}`));
  const notes = [
    ...(total > tables.length ? [w.truncated(tables.length, total)] : []),
    ...(foreignKeys.total > foreignKeys.rows.length ? [w.truncated(foreignKeys.rows.length, foreignKeys.total)] : []),
  ];
  // Mermaid's own ER syntax (decision 0026 names ER as a view type of its own): one entity per table, one row per
  // column with its type and its key, and one relationship per foreign key. An entity's name is a sanitised identifier,
  // made unique, because two schemas may hold a table of one name; the table's own name and its page stay in the list of
  // elements under the picture, which Mermaid's `erDiagram` cannot carry as clicks.
  const drawnElements = elements.slice(0, limit);
  const drawnIds = new Set(drawnElements.map(element => element.id));
  const drawnEdges = edges.filter(edge => drawnIds.has(edge.from) && drawnIds.has(edge.to));
  const lines = ['erDiagram'];
  const mermaidId = new Map<string, string>();
  const used = new Set<string>();
  for (const element of drawnElements) {
    const base = element.label.replace(/[^A-Za-z0-9_]/g, '_') || 'table';
    let id = base;
    for (let n = 2; used.has(id); n += 1) id = `${base}_${String(n)}`;
    used.add(id);
    mermaidId.set(element.id, id);
  }
  const erText = (value: string): string => value.replace(/["\r\n]/g, char => char === '"' ? '#quot;' : ' ');
  for (const element of drawnElements) {
    lines.push(`  ${mermaidId.get(element.id)!} {`);
    for (const column of element.columns ?? []) lines.push(`    ${erType(column.type)} ${column.name.replace(/[^A-Za-z0-9_]/g, '_')}${column.key && column.fk ? ' PK,FK' : column.key ? ' PK' : column.fk ? ' FK' : ''}`);
    lines.push('  }');
  }
  // The arrow points from the table that is referenced to the table that holds the key.
  for (const edge of drawnEdges) lines.push(`  ${mermaidId.get(edge.to)!} ||--o{ ${mermaidId.get(edge.from)!} : "${erText(edge.label)}"`);
  return { spec, title, label: w.er, elements: drawnElements, edges: drawnEdges, ...(elements.length > drawnElements.length ? { fullElements: elements, fullEdges: edges } : {}), notes, empty: null, up, marker: elements.length > drawnElements.length ? w.truncated(drawnElements.length, elements.length) : null, mermaid: lines.join('\n') };
}

// ---- state -------------------------------------------------------------------------------------------

/** The files whose text a subject's state machines are read from. */
interface SubjectFiles {
  files: { repo: string | null; path: string; scope: string }[];
  /** How many files of the subject the read did not reach, so a view says what it did not search. */
  dropped: number;
}

async function filesOfSubject(ctx: RenderContext, subject: GraphEntity): Promise<SubjectFiles> {
  const repo = ctx.repoOfScope(subject.scope) ?? null;
  const own = typeof subject.properties['path'] === 'string' ? subject.properties['path'] : subject.span?.path;
  if (subject.kind === 'code.file' || subject.kind === 'code.symbol') return { files: own === undefined ? [] : [{ repo, path: own, scope: subject.scope }], dropped: 0 };
  if (subject.kind === 'code.module' || subject.kind === 'code.package' || subject.kind === 'code.service') {
    const root = subject.kind === 'code.service' ? dirname(subject.span?.path ?? '.') : keyTail(subject.key);
    const found = await ctx.graph.byPrefix('code.file', root === '.' ? 'code.file:' : `code.file:${root}/`, 400);
    return {
      files: found.rows.map((file) => ({ repo: ctx.repoOfScope(file.scope) ?? null, path: String(file.properties['path'] ?? keyTail(file.key)), scope: file.scope })).filter((file) => /\.(go|ts|tsx|js|mjs)$/.test(file.path) && !/(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[a-z]+$|_test\.go$/.test(file.path)),
      dropped: Math.max(0, found.total - found.rows.length),
    };
  }
  return { files: [], dropped: 0 };
}

/** Every state view the subject's files hold, one per transition table. */
export async function stateViews(ctx: RenderContext, subject: GraphEntity, w: Words): Promise<GraphView[]> {
  const { files, dropped } = await filesOfSubject(ctx, subject);
  const views: GraphView[] = [];
  const queue = [...files];
  const results = new Map<string, Awaited<ReturnType<typeof stateMachinesOf>>>();
  const read = async (): Promise<void> => {
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      const text = await ctx.readSource(file.repo, file.path);
      if (text !== undefined) results.set(`${file.repo ?? ''}|${file.path}`, await stateMachinesOf(file.path, text));
    }
  };
  await Promise.all(Array.from({ length: 8 }, read));
  const notSearched = dropped === 0 ? [] : [w.filesNotSearched(dropped)];
  for (const file of files) {
    for (const machine of results.get(`${file.repo ?? ''}|${file.path}`) ?? []) {
      const spec: ViewSpec = { type: 'state', subject: subject.key, entry: `${file.path}#${machine.name}` };
      const place = (line: number): CodeLocation => ({ repo: file.repo, path: file.path, lineStart: line, lineEnd: line, href: sourceAddress(file.repo, file.path, line) });
      const ids = new Map(machine.states.map((state) => [state.name, `${file.path}#${machine.name}/${state.name}`]));
      const label = machine.type === null ? machine.name : `${machine.type} (${machine.name})`;
      const elements: ViewElement[] = machine.states.map((state) => ({ id: ids.get(state.name)!, label: state.label, kind: 'state', href: place(state.line).href, location: place(state.line), dashed: false }));
      const edges: ViewEdge[] = machine.transitions.map((transition) => ({ from: ids.get(transition.from)!, to: ids.get(transition.to)!, label: transition.event ?? '', dashed: false, location: place(transition.line), href: sourceAddress(file.repo, file.path, transition.line) }));
      // Mermaid's own state syntax: every transition here is a fact, and the syntax draws no dashed arrow.
      const stateIds = new Map(machine.states.map((state, at) => [state.name, `s${at}`]));
      const mermaid = ['stateDiagram-v2', ...machine.states.map((state) => `  state "${state.label.replace(/"/g, "'")}" as ${stateIds.get(state.name)!}`), ...machine.transitions.map((transition) => `  ${stateIds.get(transition.from)!} --> ${stateIds.get(transition.to)!}${transition.event === null ? '' : ` : ${transition.event.replace(/[:\n]/g, ' ')}`}`)].join('\n');
      views.push({ spec, title: `${w.state}: ${label}`, label: label, elements, edges, notes: [`${file.path}:${machine.lineStart}-${machine.lineEnd}`, ...notSearched], empty: null, marker: null, mermaid });
    }
  }
  return views;
}

// ---- sequence ----------------------------------------------------------------------------------------

const STEP_BUDGET = 40;

async function participantsOf(ctx: RenderContext, chain: Chain): Promise<Map<string, ViewElement>> {
  const participants = new Map<string, ViewElement>();
  for (const lane of chain.lanes) {
    if (participants.has(lane.group)) continue;
    let kind = 'participant';
    let href: string | null = null;
    if (lane.kind === 'actor') kind = 'person';
    else if (lane.kind === 'code.table') kind = 'database';
    else if (lane.kind === 'code.channel') kind = 'channel';
    else if (lane.kind === 'external') kind = 'external';
    if (lane.kind === 'code.file') {
      const service = await entityAt(ctx, `code.service:${lane.group}`);
      if (service !== undefined) href = hrefOf(ctx, service);
    } else if (lane.kind === 'code.table') {
      const database = lane.group.replace(/ database$/, '');
      const entity = await entityAt(ctx, `code.database:${database}`);
      if (entity !== undefined) href = hrefOf(ctx, entity);
    }
    participants.set(lane.group, { id: `lane:${lane.group}`, label: lane.group, kind, href, dashed: lane.kind === 'actor' });
  }
  return participants;
}

async function sequenceViews(ctx: RenderContext, spec: ViewSpec, subject: Subject | undefined, w: Words): Promise<GraphView[]> {
  const title = w.sequence;
  const entries: Entry[] = [];
  if (spec.entry !== undefined) {
    const entity = await entityAt(ctx, spec.entry);
    if (entity === undefined) throw new ViewRefusal(404, `"${spec.entry}" is no route or function of the graph: a chain starts at one`);
    entries.push(...(await entriesOf(ctx, { source: 'graph', entity })));
  } else if (subject !== undefined) entries.push(...(await entriesOf(ctx, subject)));
  if (entries.length === 0) return [empty(spec, title, w.sequence, w.noEntry)];
  const drawn = entries.slice(0, 3);
  // A page with more entry points than the three drawn says so on every chain, rather than showing three as if the
  // page held no others.
  const foldedEntries = entries.length > drawn.length ? [w.entriesFolded(drawn.length, entries.length)] : [];
  const views: GraphView[] = [];
  for (const entry of drawn) {
    const chain = await chainFrom(ctx, entry, { limit: 100, depth: 6 });
    const participants = await participantsOf(ctx, chain);
    const laneGroup = new Map(chain.lanes.map((lane) => [lane.id, lane.group]));
    const steps = chain.steps.slice(0, STEP_BUDGET);
    const used = new Set(steps.flatMap((step) => [laneGroup.get(step.from), laneGroup.get(step.to)]));
    const elements = [...participants.entries()].filter(([group]) => used.has(group)).map(([, element]) => element);
    const edges: ViewEdge[] = steps.map((step) => ({
      from: participants.get(laneGroup.get(step.from)!)!.id,
      to: participants.get(laneGroup.get(step.to)!)!.id,
      label: step.label,
      dashed: step.order === 'unordered',
      ...(step.order === 'unordered' ? { why: w.unorderedWhy } : {}),
      step: step.n,
      kind: step.kind,
      ...(step.note === undefined ? {} : { note: step.note }),
      href: step.href,
      ...(step.site === undefined ? {} : { location: step.site }),
    }));
    const notes = [...foldedEntries, ...chain.notes];
    if (chain.steps.length > steps.length) notes.push(w.stepsFolded(chain.steps.length - steps.length));
    const entrySpec: ViewSpec = { type: 'sequence', subject: spec.subject, entry: entry.entity.key };
    views.push({ spec: entrySpec, title: `${w.sequence}: ${chain.title}`, label: chain.title, elements, edges, notes, empty: edges.length === 0 ? w.noEntry : null, marker: null });
  }
  return views;
}

// ---- deployment --------------------------------------------------------------------------------------

async function deploymentView(ctx: RenderContext, spec: ViewSpec, w: Words): Promise<GraphView> {
  const title = w.deployment;
  const allOfKind = async (kind: string) => {
    const first = await ctx.graph.list(kind, { limit: 200 });
    return first.total > first.rows.length ? await ctx.graph.list(kind, { limit: first.total }) : first;
  };
  const allRelations = async (relation: string) => {
    const first = await ctx.graph.relationEdges(relation, 2000);
    return first.total > first.rows.length ? await ctx.graph.relationEdges(relation, first.total) : first;
  };
  const compose = await allOfKind('code.compose-service');
  const deployments = await allOfKind('code.k8s-deployment');
  const kubeServices = await allOfKind('code.k8s-service');
  const dockerfiles = await allOfKind('code.dockerfile');
  if (compose.rows.length + deployments.rows.length + kubeServices.rows.length + dockerfiles.rows.length === 0) return empty(spec, title, w.deployment, w.noDeploy);
  const elements: ViewElement[] = [];
  const edges: ViewEdge[] = [];
  const have = new Set<string>();
  const add = (element: ViewElement): void => {
    if (have.has(element.id)) return;
    have.add(element.id);
    elements.push(element);
  };
  const fileNode = (path: string): string => {
    const id = `file:${path}`;
    add({ id, label: path, kind: 'node', href: null, dashed: false });
    return id;
  };
  const place = (entity: GraphEntity): { location?: CodeLocation } => (entity.span === undefined ? {} : { location: locationOf(ctx, entity.scope, entity.span) });
  const pathOf = (entity: GraphEntity): string => entity.span?.path ?? keyTail(entity.key).split('#')[0]!;
  const notes: string[] = [];
  for (const [name, read] of [['compose services', compose], ['Kubernetes deployments', deployments], ['Kubernetes services', kubeServices], ['Dockerfiles', dockerfiles]] as const) if (read.total > read.rows.length) notes.push(w.truncated(read.rows.length, read.total) + ` (${name})`);
  for (const service of compose.rows) {
    const ports = Array.isArray(service.properties['ports']) ? (service.properties['ports'] as unknown[]).map(String).join(', ') : '';
    const detail = [service.properties['image'] !== null && service.properties['image'] !== undefined ? String(service.properties['image']) : '', ports === '' ? '' : `ports ${ports}`].filter(Boolean).join(' · ');
    add({ id: service.key, label: service.label, kind: 'container', ...(detail === '' ? {} : { detail }), href: hrefOf(ctx, service), ...place(service), dashed: false, parent: fileNode(pathOf(service)) });
  }
  for (const deployment of deployments.rows) {
    const replicas = deployment.properties['replicas'];
    const detail = [typeof replicas === 'number' ? w.replicas(replicas) : '', deployment.properties['image'] === null || deployment.properties['image'] === undefined ? '' : String(deployment.properties['image'])].filter(Boolean).join(' · ');
    add({ id: deployment.key, label: deployment.label, kind: 'container', ...(detail === '' ? {} : { detail }), href: hrefOf(ctx, deployment), ...place(deployment), dashed: false, parent: fileNode(pathOf(deployment)) });
  }
  for (const service of kubeServices.rows) {
    add({ id: service.key, label: service.label, kind: 'channel', detail: 'Service', href: hrefOf(ctx, service), ...place(service), dashed: false, parent: fileNode(pathOf(service)) });
  }
  for (const dockerfile of dockerfiles.rows) {
    add({ id: dockerfile.key, label: pathOf(dockerfile), kind: 'image', detail: 'Dockerfile', href: hrefOf(ctx, dockerfile), ...place(dockerfile), dashed: false });
  }
  const links = async (relation: string, make: (edge: { from: string; to: string; properties: Record<string, unknown> }) => ViewEdge | undefined): Promise<void> => {
    const found = await allRelations(relation);
    if (found.total > found.rows.length) notes.push(w.truncated(found.rows.length, found.total) + ` (${relation})`);
    for (const row of found.rows) {
      if (!have.has(row.from.key)) continue;
      const edge = make({ from: row.from.key, to: row.to.key, properties: row.properties });
      if (edge !== undefined && have.has(edge.to)) edges.push(edge);
    }
  };
  await links('code.depends-on', (edge) => (edge.from.startsWith('code.compose-service:') && edge.to.startsWith('code.compose-service:') ? { from: edge.from, to: edge.to, label: w.dependsOn, dashed: false } : undefined));
  await links('code.builds', (edge) => ({ from: edge.from, to: edge.to, label: w.builds, dashed: false }));
  // A deployment meets its Dockerfile through its image: the extractor matches them by the image's name only.
  const runs = await allRelations('code.runs');
  const builtBy = await allRelations('code.built-by');
  const dockerOfImage = new Map(builtBy.rows.map((row) => [row.from.key, row.to.key]));
  for (const row of runs.rows) {
    const dockerfile = dockerOfImage.get(row.to.key);
    if (dockerfile !== undefined && have.has(row.from.key) && have.has(dockerfile)) edges.push({ from: row.from.key, to: dockerfile, label: w.builtBy, dashed: true, why: w.nameMatchWhy });
  }
  // A Kubernetes Service reaches the deployment that exposes the port it targets; the port node is named after the service.
  const targets = await allRelations('code.targets');
  const exposes = await allRelations('code.exposes');
  const exposers = new Map<string, string[]>();
  for (const row of exposes.rows) exposers.set(row.to.key, [...(exposers.get(row.to.key) ?? []), row.from.key]);
  for (const row of targets.rows) {
    for (const deployment of exposers.get(row.to.key) ?? []) if (have.has(row.from.key) && have.has(deployment)) edges.push({ from: row.from.key, to: deployment, label: w.routesTo, dashed: true, why: w.portMatchWhy });
  }
  edges.sort((a, b) => byCodePoint(`${a.from}|${a.to}|${a.label}`, `${b.from}|${b.to}|${b.label}`));
  return foldOwnership({ spec, title, label: w.deployment, elements, edges, notes, empty: null, marker: null }, w);
}

// ---- domains -----------------------------------------------------------------------------------------

/** The domains of a kind (Markdown pages) and the services each one is implemented by: the service a related entity is, or lives in. */
async function domainsOf(ctx: RenderContext, kind: string): Promise<{ id: string; title: string; href: string | null; services: string[] }[]> {
  const locator = await serviceLocator(ctx);
  const out: { id: string; title: string; href: string | null; services: string[] }[] = [];
  for (const page of [...ctx.markdown.values()].filter((entity) => entity.kind === kind).sort((a, b) => byCodePoint(a.id, b.id))) {
    const services = new Set<string>();
    for (const key of page.relates) {
      const [entity] = await ctx.graph.find(key);
      if (entity === undefined) continue;
      if (entity.kind === 'code.service') services.add(entity.key);
      else {
        const owner = locator.ownerOf(entity.span?.path ?? pathOfKey(entity.key));
        if (owner !== undefined) services.add(owner);
      }
    }
    out.push({ id: page.id, title: page.title, href: refOfMarkdown(ctx, page).href, services: [...services].sort(byCodePoint) });
  }
  return out;
}

/** The links between services, as the code has them: direct calls, and the topics one publishes and another consumes. */
async function serviceLinks(ctx: RenderContext): Promise<{ from: string; to: string; label: string }[]> {
  const model = await systemModel(ctx);
  const services = new Set(model.nodes.filter((node) => node.kind === 'service').map((node) => node.id));
  const links: { from: string; to: string; label: string }[] = [];
  for (const edge of model.edges) if (services.has(edge.from) && services.has(edge.to)) links.push({ from: edge.from, to: edge.to, label: VIA_WORD[edge.via] ?? edge.via });
  const nameOf = new Map(model.nodes.map((node) => [node.id, node.label]));
  for (const published of model.edges.filter((edge) => edge.via === 'publishes')) {
    for (const consumed of model.edges.filter((edge) => edge.via === 'consumes' && edge.from === published.to && services.has(edge.to))) links.push({ from: published.from, to: consumed.to, label: `event ${nameOf.get(published.to) ?? ''}`.trim() });
  }
  return links;
}

async function domainMapView(ctx: RenderContext, spec: ViewSpec, w: Words): Promise<GraphView> {
  const title = w.domains;
  const domains = (await domainsOf(ctx, spec.subject)).filter((domain) => domain.services.length > 0);
  if (domains.length === 0) return empty(spec, title, w.domains, w.noDomains);
  const labelOf = new Map<string, string>();
  for (const service of (await serviceLocator(ctx)).services) labelOf.set(service.key, service.label);
  const elements: ViewElement[] = [];
  const copies = new Map<string, string[]>();
  for (const domain of domains) {
    elements.push({ id: domain.id, label: domain.title, kind: 'domain', detail: w.domain, href: domain.href, dashed: false, drill: { spec: { type: 'domain', subject: domain.id }, title: w.domainOf(domain.title) } });
    for (const key of domain.services) {
      const id = `${domain.id}|${key}`;
      const [entity] = await ctx.graph.find(key);
      elements.push({ id, label: labelOf.get(key) ?? keyTail(key), kind: 'container', href: entity === undefined ? null : hrefOf(ctx, entity), dashed: false, parent: domain.id });
      copies.set(key, [...(copies.get(key) ?? []), id]);
    }
  }
  const edges: ViewEdge[] = [];
  const seen = new Set<string>();
  for (const link of await serviceLinks(ctx)) {
    for (const from of copies.get(link.from) ?? []) for (const to of copies.get(link.to) ?? []) {
      if (from.split('|')[0] === to.split('|')[0]) continue;
      const key = `${from}>${to}>${link.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from, to, label: link.label, dashed: false });
    }
  }
  edges.sort((a, b) => byCodePoint(`${a.from}>${a.to}>${a.label}`, `${b.from}>${b.to}>${b.label}`));
  return foldOwnership({ spec, title, label: w.domains, elements, edges, notes: [w.implementedWhy], empty: null, marker: null }, w);
}

async function domainView(ctx: RenderContext, spec: ViewSpec, w: Words): Promise<GraphView> {
  const page = ctx.markdown.get(spec.subject);
  if (page === undefined) throw new ViewRefusal(404, `"${spec.subject}" is no Markdown page of the product: a domain view is drawn around one`);
  const title = w.domainOf(page.title);
  const domains = await domainsOf(ctx, page.kind);
  const mine = domains.find((domain) => domain.id === page.id)!;
  const up = { spec: { type: 'domain-map' as const, subject: page.kind }, title: w.domains };
  const elements: ViewElement[] = [{ id: page.id, label: page.title, kind: 'domain', detail: w.domain, href: mine.href, dashed: false }];
  const edges: ViewEdge[] = [];
  const have = new Set([page.id]);
  const ids = new Set(mine.services);
  const model = await systemModel(ctx);
  const nodeOf = new Map(model.nodes.map((node) => [node.id, node]));
  for (const key of mine.services) {
    const [entity] = await ctx.graph.find(key);
    elements.push({ id: key, label: entity?.label ?? keyTail(key), kind: 'container', href: entity === undefined ? null : hrefOf(ctx, entity), dashed: false, ...(entity?.span === undefined ? {} : { location: locationOf(ctx, entity.scope, entity.span) }), drill: { spec: { type: 'c4-component', subject: key }, title: w.components } });
    have.add(key);
    edges.push({ from: page.id, to: key, label: w.implementedBy, dashed: true, why: w.implementedWhy });
  }
  // The data the services use: their databases and the topics they publish or consume.
  for (const edge of model.edges) {
    const mineFrom = ids.has(edge.from);
    const mineTo = ids.has(edge.to);
    if (!mineFrom && !mineTo) continue;
    const other = nodeOf.get(mineFrom ? edge.to : edge.from);
    if (other === undefined) continue;
    if (other.kind === 'database' || other.kind === 'topic' || other.kind === 'external') {
      if (!have.has(other.id)) {
        have.add(other.id);
        elements.push({ id: other.id, label: other.label, kind: other.kind === 'database' ? 'database' : other.kind === 'topic' ? 'channel' : 'external', href: other.href, dashed: false, ...(other.kind === 'database' ? { drill: { spec: { type: 'er' as const, subject: other.id }, title: w.er } } : {}) });
      }
      edges.push({ from: edge.from, to: edge.to, label: via(VIA_WORD[edge.via] ?? edge.via, edge.label), dashed: false });
    }
  }
  // Neighbouring domains: the services of other domains these services call or are called by.
  const links = await serviceLinks(ctx);
  const seenNeighbour = new Set<string>();
  for (const other of domains) {
    if (other.id === page.id) continue;
    for (const link of links) {
      const out = ids.has(link.from) && other.services.includes(link.to) && !ids.has(link.to);
      const into = ids.has(link.to) && other.services.includes(link.from) && !ids.has(link.from);
      if (!out && !into) continue;
      const key = `${other.id}|${link.from}|${link.to}|${link.label}`;
      if (seenNeighbour.has(key)) continue;
      seenNeighbour.add(key);
      if (!have.has(other.id)) {
        have.add(other.id);
        elements.push({ id: other.id, label: other.title, kind: 'domain', detail: w.neighbours, href: other.href, dashed: false, drill: { spec: { type: 'domain', subject: other.id }, title: w.domainOf(other.title) } });
      }
      edges.push(out ? { from: link.from, to: other.id, label: link.label, dashed: true, why: w.neighbourWhy } : { from: other.id, to: link.to, label: link.label, dashed: true, why: w.neighbourWhy });
    }
  }
  // Use cases and rules the text of the documents ties to the domain by name.
  const needle = page.title.toLowerCase();
  const naming = [...ctx.docEntities.values()].filter((doc) => doc.title.toLowerCase().includes(needle) || doc.text.toLowerCase().includes(needle)).sort((a, b) => byCodePoint(a.id, b.id));
  const mentioned = naming.slice(0, 12);
  const notes: string[] = [];
  if (naming.length > mentioned.length) notes.push(w.mentioned(mentioned.length, naming.length));
  for (const doc of mentioned) {
    elements.push({ id: doc.id, label: doc.title, kind: 'component', detail: doc.kind, href: refOfMarkdown(ctx, doc).href, dashed: true });
    edges.push({ from: page.id, to: doc.id, label: w.mentions, dashed: true, why: w.mentionsWhy });
  }
  if (elements.length === 1) return empty(spec, title, w.domain, w.nothingNearby, up);
  return { spec, title, label: w.domain, elements, edges, notes, empty: null, up, marker: null };
}

// ---- the entry points --------------------------------------------------------------------------------

/** The context a view is built in: the page's, and the words of the reader's language. */
export interface ViewContext {
  ctx: RenderContext;
  lang: string | undefined;
  /** The product's name, for the context view's system. */
  productTitle: string;
}

/** The view a specification asks for, checked against the graph; a refusal names what is wrong. */
export async function buildViews(view: ViewContext, spec: ViewSpec, subject?: Subject): Promise<GraphView[]> {
  const w = wordsOf(view.lang);
  switch (spec.type) {
    case 'c4-context': return [await contextView(view.ctx, spec, w, view.productTitle)];
    case 'c4-container': return [await containerView(view.ctx, spec, w)];
    case 'c4-component': return [await componentView(view.ctx, spec, w)];
    case 'er': return [await erView(view.ctx, spec, w, 12)];
    case 'deployment': return [await deploymentView(view.ctx, spec, w)];
    case 'sequence': return await sequenceViews(view.ctx, spec, subject, w);
    case 'domain-map': return [await domainMapView(view.ctx, spec, w)];
    case 'domain': return [await domainView(view.ctx, spec, w)];
    case 'state': {
      const entity = await entityAt(view.ctx, spec.subject);
      if (entity === undefined) throw new ViewRefusal(404, `"${spec.subject}" is no entity of the graph: a state view reads the transition tables of its code`);
      const all = await stateViews(view.ctx, entity, w);
      const wanted = spec.entry === undefined ? all : all.filter((candidate) => candidate.spec.entry === spec.entry);
      if (wanted.length === 0) return [empty(spec, w.state, w.state, w.noMachines)];
      return wanted;
    }
  }
}

// ---- the block ---------------------------------------------------------------------------------------

/** One view as the page receives it: the model, the tabs it offers and the query the frames and drill-downs ask it by. */
export interface ViewPayload extends GraphView {
  /** The renderers that draw this type, the chosen one first. */
  renderers: Renderer[];
  /** The Mermaid source (drawn in the page itself). */
  mermaidSource: string;
  /** `type=…&subject=…` of the view, to ask the server for it again in another form. */
  query: string;
}

export function payloadOf(view: GraphView, chosen: Renderer): ViewPayload {
  const { mermaid: _own, ...rest } = view;
  return { ...rest, renderers: tabsOf(view.spec.type, chosen), mermaidSource: view.empty === null ? mermaidOfView(view) : '', query: specQuery(view.spec) };
}

export interface DiagramsBlockShape {
  type: 'diagrams';
  title: string;
  /** The renderer the tabs open on (the product's setting, else MADARCH_WIKI_DIAGRAM, else LikeC4). */
  renderer: Renderer;
  views: ViewPayload[];
}

/** The views one template block asks for, on the page of `subject`. */
export async function diagramsBlock(
  view: ViewContext,
  subject: Subject,
  name: 'system' | 'modules' | 'er' | 'sequence',
  params: Readonly<Record<string, string>>,
  setting: { product: string | undefined; env: Readonly<Record<string, string | undefined>> },
  where: { file: string; line: number },
): Promise<DiagramsBlockShape | { type: 'problem'; block: string; message: string; file: string; line: number }> {
  const chosen = chosenRenderer(setting.product, setting.env);
  if (!chosen.ok) return { type: 'problem', block: name, message: chosen.message, ...where };
  const title = params['title'] ?? '';
  const problem = (message: string) => ({ type: 'problem' as const, block: name, message, ...where });
  const graphSubject = subject.source === 'graph' ? subject.entity : undefined;
  const built: GraphView[] = [];
  try {
    if (name === 'system' && params['view'] === 'domain') {
      if (subject.source !== 'markdown') return problem('view="domain" draws the architecture around a Markdown page (a domain), and this entity is not one');
      built.push(...(await buildViews(view, { type: 'domain', subject: subject.entity.id }, subject)));
    } else if (name === 'system' && params['view'] === 'domains') {
      built.push(...(await buildViews(view, { type: 'domain-map', subject: params['kind'] ?? '' }, subject)));
    } else if (name === 'system') {
      if (subject.source === 'graph') return problem('the system block draws the whole product and belongs on the product page, not on the page of a graph entity');
      built.push(...(await buildViews(view, { type: 'c4-context', subject: '' }, subject)), ...(await buildViews(view, { type: 'c4-container', subject: '' }, subject)));
      const deployment = (await buildViews(view, { type: 'deployment', subject: '' }, subject))[0]!;
      if (deployment.empty === null) built.push(deployment);
    } else if (name === 'modules') {
      if (graphSubject?.kind === 'code.service') built.push(...(await buildViews(view, { type: 'c4-component', subject: graphSubject.key }, subject)));
      if (graphSubject !== undefined) {
        const machines = await stateViews(view.ctx, graphSubject, wordsOf(view.lang));
        built.push(...machines);
      } else return problem('the modules block draws the components and state machines of a graph entity (a service, module, package, file or function)');
    } else if (name === 'er') {
      if (graphSubject === undefined) return problem('the er block draws the tables of the graph; the entities of this kind are Markdown pages');
      if (graphSubject.kind !== 'code.database' && graphSubject.kind !== 'code.table') return problem(`the er block draws a database or a table, and this is a ${graphSubject.kind}`);
      built.push(...(await buildViews(view, { type: 'er', subject: graphSubject.key }, subject)));
    } else {
      built.push(...(await buildViews(view, { type: 'sequence', subject: graphSubject?.key ?? (subject.source === 'markdown' ? subject.entity.id : '') }, subject)));
    }
  } catch (error) {
    if (error instanceof ViewRefusal) return problem(error.message);
    throw error;
  }
  return { type: 'diagrams', title, renderer: chosen.renderer, views: built.map((one) => payloadOf(one, chosen.renderer)) };
}
