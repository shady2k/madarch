/**
 * One graph page's diagrams as the app receives them (madarch-tzte.23.4; decision
 * 0026, "Diagrams"): the models madarch-tzte.23.2 builds, each under the tabs of
 * every renderer that supports its type, with the first tab following
 * `MADARCH_WIKI_DIAGRAM`.
 *
 * The renderers, and what each type is drawn by:
 *
 * - **Mermaid** draws every type: the box-and-arrow types as a flowchart and a
 *   sequence as a sequence diagram (`graph-mermaid.ts`).
 * - **LikeC4** draws the C4 types — context, container and component — which is
 *   what decision 0026 gives it ("LikeC4 for C4 and deployment"; no deployment
 *   kind exists in the schema yet, so none is offered).
 * - **archify** draws whatever LikeC4 can lay out: the C4 types, module
 *   dependencies, ER and state. A sequence is not one of them — archify's document
 *   is components and connections, and a lifeline with an order is neither.
 *
 * The tabs stand in one fixed order (LikeC4, Mermaid, Archify, the order the static
 * wiki's own tabs keep), and the chosen renderer is moved to the front: the first
 * tab is the setting, and a type the setting cannot draw falls back to the first
 * renderer of that order that can, so no page ever shows a tab that draws nothing.
 *
 * Nothing here reads the store: the models arrive from `src/fill/graph-diagrams.ts`
 * and this module turns them into addresses and lists. The addresses are the
 * server's own (`/api/graph/…`); the app prefixes them with the base it is served
 * under, the way it prefixes every other answer's.
 */
import { type DiagramElement, type DiagramEvidence, type DiagramModel, type DiagramPlace, type DiagramType, type DiagramViewSpec } from '../fill/diagrams.js';
import type { NodeDiagram } from '../fill/graph-diagrams.js';
import type { GraphPageEntry } from '../fill/graph-pages.js';
import { mermaidOfDiagram } from './graph-mermaid.js';

/** The renderers a diagram is drawn by, in the one order the tabs stand in (the static wiki's own). */
export const DIAGRAM_RENDERERS = ['likec4', 'mermaid', 'archify'] as const;
export type GraphDiagramRenderer = (typeof DIAGRAM_RENDERERS)[number];

/**
 * What each diagram type is drawn by. LikeC4's three are the C4 levels 0026 names
 * for it; archify's six are the ones a set of components and connections can say;
 * Mermaid draws all seven.
 */
export const DIAGRAM_RENDERERS_OF: Readonly<Record<DiagramType, readonly GraphDiagramRenderer[]>> = {
  'c4-component': ['likec4', 'mermaid', 'archify'],
  'c4-container': ['likec4', 'mermaid', 'archify'],
  'c4-context': ['likec4', 'mermaid', 'archify'],
  'er': ['mermaid', 'archify'],
  'module-dependency': ['mermaid', 'archify'],
  'sequence': ['mermaid'],
  'state': ['mermaid', 'archify'],
};

/** The setting's own words, as `MADARCH_WIKI_DIAGRAM` spells them. */
const CHOSEN_TABS: readonly GraphDiagramRenderer[] = ['archify', 'likec4', 'mermaid'];

/** The tab shown first when the setting names none: the same default the static wiki's build keeps. */
export const DEFAULT_DIAGRAM_TAB: GraphDiagramRenderer = 'likec4';

/** The diagram tab the environment asks for, or the refusal naming the value and the three it accepts. */
export function chosenDiagramTab(env: Readonly<Record<string, string | undefined>>): { readonly ok: true; readonly tab: GraphDiagramRenderer } | { readonly ok: false; readonly message: string } {
  const chosen = env.MADARCH_WIKI_DIAGRAM ?? DEFAULT_DIAGRAM_TAB;
  const tab = CHOSEN_TABS.find((candidate) => candidate === chosen);
  if (tab === undefined) {
    return { ok: false, message: `unknown wiki diagram format "${chosen}": allowed formats are "likec4", "mermaid" and "archify" (MADARCH_WIKI_DIAGRAM)` };
  }
  return { ok: true, tab };
}

/**
 * One type's tabs, the chosen renderer first: the setting's tab where the type is
 * drawn by it, else the first of the fixed order that draws the type. A setting
 * that names a renderer the type cannot use is not an error — a sequence is drawn
 * by Mermaid whatever the setting says — and no tab the type has no renderer for
 * is ever offered.
 */
export function orderedTabs(type: DiagramType, chosen: GraphDiagramRenderer): readonly GraphDiagramRenderer[] {
  const supported = DIAGRAM_RENDERERS_OF[type];
  const rest = DIAGRAM_RENDERERS.filter((renderer) => supported.includes(renderer));
  return rest.includes(chosen) ? [chosen, ...rest.filter((renderer) => renderer !== chosen)] : rest;
}

/** One renderer's tab of one diagram: the renderer, and what the app needs to draw it. */
export interface GraphDiagramTab {
  readonly renderer: GraphDiagramRenderer;
  /** Mermaid: the source the app renders. */
  readonly source?: string;
  /** Archify and LikeC4: the address of the rendered page the tab frames. */
  readonly src?: string;
}

/** One column of an ER table: its own name and type, and the page and the place it opens where the graph holds them. */
export interface GraphDiagramColumn {
  readonly label: string;
  readonly page?: string;
  readonly place?: DiagramPlace;
}

/** One element of a diagram, as the page lists it under every renderer: what it is, how it stands, where it opens. */
export interface GraphDiagramElement {
  readonly id: string;
  readonly kind: string | null;
  readonly label: string;
  readonly evidence: DiagramEvidence;
  readonly dashed: boolean;
  /** The address of the element's page (server-relative), when its kind has one. */
  readonly page?: string;
  readonly place?: DiagramPlace;
  /** A table's columns: what each reads as, and the page and the place the column stands at where it has them. */
  readonly columns?: readonly GraphDiagramColumn[];
  /** The address of the view the element opens once the node budget collapsed it. */
  readonly drillDown?: string;
  /** The elements this one stands for, when the budget collapsed it. */
  readonly standsFor?: readonly string[];
}

/** One arrow of a diagram, as the page lists it under every renderer. */
export interface GraphDiagramEdge {
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly evidence: DiagramEvidence;
  readonly dashed: boolean;
  readonly kind: string;
}

/** One diagram of a page: its tabs, its elements and its arrows, exactly as the server answered them. */
export interface GraphDiagramAnswer {
  readonly type: DiagramType;
  readonly level: number;
  readonly title: string;
  readonly spec: DiagramViewSpec;
  readonly collapsed: boolean;
  readonly marker: string | null;
  /** Whether the graph answered the view with nothing: the page says so instead of drawing an empty frame. */
  readonly empty: boolean;
  readonly tabs: readonly GraphDiagramTab[];
  readonly elements: readonly GraphDiagramElement[];
  readonly edges: readonly GraphDiagramEdge[];
}

/** One page's whole answer: its node, its diagrams, and the setting the tabs followed. */
export interface GraphDiagramsAnswer {
  readonly product: string;
  readonly node: GraphPageEntry;
  /** The renderer `MADARCH_WIKI_DIAGRAM` names (or the default), which the first tab of each diagram follows. */
  readonly firstTab: GraphDiagramRenderer;
  readonly diagrams: readonly GraphDiagramAnswer[];
  readonly readAt: number;
}

/** The address of one diagram's archify page: the page and the type it draws. */
export function archifyAddress(node: string, type: DiagramType): string {
  return `/api/graph/archify?id=${encodeURIComponent(node)}&type=${encodeURIComponent(type)}`;
}

/** The address of one diagram's LikeC4 webcomponent bundle: the page and the type it draws. */
export function likec4Address(node: string, type: DiagramType): string {
  return `/api/graph/likec4.js?id=${encodeURIComponent(node)}&type=${encodeURIComponent(type)}`;
}

/** The address of one diagram's LikeC4 page: the document the LikeC4 tab frames. */
export function likec4PageAddress(node: string, type: DiagramType): string {
  return `/api/graph/likec4.html?id=${encodeURIComponent(node)}&type=${encodeURIComponent(type)}`;
}

/**
 * One diagram as the app shows it: its tabs (the first one the setting's), its
 * elements and arrows. The addresses it hands out are the server's own paths; the
 * app prefixes them with the base it is served under, and the generated documents
 * are made with that prefix at their own routes (`graph-render.ts`).
 */
export function graphDiagramOf(diagram: NodeDiagram, options: { readonly node: string; readonly chosen: GraphDiagramRenderer }): GraphDiagramAnswer {
  const { spec, model } = diagram;
  const tabs: GraphDiagramTab[] = orderedTabs(model.type, options.chosen).map((renderer): GraphDiagramTab => {
    switch (renderer) {
      case 'mermaid':
        return { renderer, source: mermaidOfDiagram(model) };
      case 'archify':
        return { renderer, src: archifyAddress(options.node, model.type) };
      case 'likec4':
        // LikeC4 draws in a document of its own: the bundle is generated from this diagram's workspace, and the
        // page it is framed in carries the element (graph-render.ts, `graphLikeC4Page`).
        return { renderer, src: likec4PageAddress(options.node, model.type) };
    }
  });
  return {
    type: model.type,
    level: model.level,
    title: model.title,
    spec,
    collapsed: model.collapsed,
    marker: model.marker,
    empty: model.elements.length === 0,
    tabs,
    elements: model.elements.map((element) => elementOf(element)),
    edges: model.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      label: edge.label,
      evidence: edge.evidence,
      dashed: edge.dashed,
      kind: edge.kinds.join(', '),
    })),
  };
}

/** One element as the page lists it: the model's own words, and the address of the page it opens. */
function elementOf(element: DiagramElement): GraphDiagramElement {
  return {
    id: element.id,
    kind: element.kind,
    label: element.label,
    evidence: element.evidence,
    dashed: element.dashed,
    ...(element.page === undefined ? {} : { page: element.page.href }),
    ...(element.place === undefined ? {} : { place: element.place }),
    ...(element.columns === undefined ? {} : {
      columns: element.columns.map((column) => ({
        label: column.dataType === undefined ? column.label : `${column.label} ${column.dataType}`,
        ...(column.page === undefined ? {} : { page: column.page.href }),
        ...(column.place === undefined ? {} : { place: column.place }),
      })),
    }),
    ...(element.drillDown === undefined ? {} : { drillDown: element.drillDown.href }),
    ...(element.standsFor === undefined ? {} : { standsFor: element.standsFor }),
  };
}

/** One page's answer, its diagrams in the order its kind gives them. */
export function graphDiagramsAnswer(options: {
  readonly product: string;
  readonly node: GraphPageEntry;
  readonly diagrams: readonly NodeDiagram[];
  readonly chosen: GraphDiagramRenderer;
  readonly readAt: number;
}): GraphDiagramsAnswer {
  return {
    product: options.product,
    node: options.node,
    firstTab: options.chosen,
    diagrams: options.diagrams.map((diagram) => graphDiagramOf(diagram, { node: options.node.id, chosen: options.chosen })),
    readAt: options.readAt,
  };
}
