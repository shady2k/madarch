/**
 * The archify documents (madarch-7br.3.1): from the layouted view LikeC4
 * produced, one architecture document for archify's renderer — every leaf
 * node a component at LikeC4's position and size, every group node a
 * boundary wrapping the leaves beneath it, every edge a connection with
 * its label. A pure function of its input, sorted by code point, never
 * the clock; anything the layout is missing is an error naming it. The
 * rendered page then gets the drill-down: a component whose element has a
 * view of its own becomes a link to that view's page (archify's document
 * schema has no link field, so the link is wrapped around the rendered
 * component, keyed by the id the renderer writes on it).
 *
 * A group node is a boundary, not a component: archify's renderer refuses
 * overlapping components outright, and a group's rectangle contains its
 * children by construction — its "frame around a group" boundary is the
 * nesting archify draws (docs/changes/wiki/change.md accepts exactly this
 * simpler nesting). An edge naming a group node has no component to
 * attach to and is refused naming the view.
 */

import { byCodePoint } from './pages.js';

/** The madarch element kinds (src/model/schema.ts) and the archify types (vendor/archify/schemas/common.schema.json). */
const TYPE_BY_KIND: Record<string, string> = {
  person: 'external',
  external: 'external',
  domain: 'external',
  system: 'external',
  service: 'backend',
  module: 'backend',
  store: 'database',
  broker: 'messagebus',
};

/** The one kind that gets an icon: a person is drawn as one. */
const ICON_BY_KIND: Record<string, string> = { person: 'person' };

/**
 * The id a node carries in the archify document and on its rendered
 * component: LikeC4's dotted full name is not a legal archify id
 * (`^[a-zA-Z][a-zA-Z0-9_-]*$`), so every dot becomes a double
 * underscore — injective, because a madarch identifier never holds a
 * dot or a double underscore inside a segment.
 */
export function componentId(fqn: string): string {
  return fqn.replaceAll('.', '__');
}

/** One node of the layouted view, exactly what the builder reads off it. */
export interface ArchifyLayoutNode {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly parent: string | null;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One edge of the layouted view: its ends and the label it carries, if any. */
export interface ArchifyLayoutEdge {
  readonly source: string;
  readonly target: string;
  readonly label?: string;
}

/** One layouted view: what LikeC4's layout pass produced for one view id. */
export interface ArchifyLayoutedView {
  readonly id: string;
  readonly title: string;
  readonly nodes: readonly ArchifyLayoutNode[];
  readonly edges: readonly ArchifyLayoutEdge[];
}

/** One archify component, exactly as the architecture schema asks. */
interface ArchifyComponent {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly sublabel: string;
  readonly icon?: string;
  readonly pos: readonly [number, number];
  readonly size: readonly [number, number];
}

/** One archify boundary: a region frame around the components it wraps. */
interface ArchifyBoundary {
  readonly kind: 'region';
  readonly label: string;
  readonly wraps: readonly string[];
}

/** One archify connection, label included only when the layout carries one. */
interface ArchifyConnection {
  readonly from: string;
  readonly to: string;
  readonly label?: string;
}

/** The architecture document, exactly the schema's top level. */
export interface ArchifyDocument {
  readonly schema_version: 1;
  readonly diagram_type: 'architecture';
  readonly meta: { readonly title: string; readonly output: string };
  readonly components: readonly ArchifyComponent[];
  readonly boundaries: readonly ArchifyBoundary[];
  readonly connections: readonly ArchifyConnection[];
}

/**
 * The archify document of one layouted view. `output` is where the
 * rendered page will sit in the site, as the schema's portable output
 * path; the document itself stays a pure value.
 */
export function archifyDocument(view: ArchifyLayoutedView, options: { output: string }): ArchifyDocument {
  const placed = new Map<string, ArchifyLayoutNode>();
  for (const node of view.nodes) {
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y) || !Number.isFinite(node.width) || !Number.isFinite(node.height) || node.width <= 0 || node.height <= 0) {
      throw new Error(`the layout did not lay out node "${node.id}" of the view "${view.id}" (x: ${node.x}, y: ${node.y}, width: ${node.width}, height: ${node.height}): the archify document needs every node at a position and size`);
    }
    if (node.title.trim() === '') {
      throw new Error(`the layout carries no label for node "${node.id}" of the view "${view.id}": the archify document labels every component and boundary`);
    }
    if (node.parent !== null && !view.nodes.some((other) => other.id === node.parent)) {
      throw new Error(`the layout puts node "${node.id}" of the view "${view.id}" under "${node.parent}", which the view does not hold`);
    }
    placed.set(node.id, node);
  }
  // A group is any node some other node names as parent; a leaf is drawn.
  const groups = new Set([...placed.values()].map((node) => node.parent).filter((parent): parent is string => parent !== null));
  const leaves = [...placed.values()].filter((node) => !groups.has(node.id));
  const components: ArchifyComponent[] = leaves
    .map((node) => ({
      id: componentId(node.id),
      type: TYPE_BY_KIND[node.kind] ?? 'external',
      label: node.title,
      sublabel: node.kind,
      ...(ICON_BY_KIND[node.kind] === undefined ? {} : { icon: ICON_BY_KIND[node.kind] }),
      pos: [node.x, node.y] as const,
      size: [node.width, node.height] as const,
    }))
    .sort((a, b) => byCodePoint(a.id, b.id));
  // Each group's frame wraps every leaf beneath it: a boundary can only
  // name components, and a nested group's own frame then sits fully
  // inside its parent's — the nesting archify's validator asks for.
  const children = new Map<string, string[]>();
  for (const group of groups) {
    const beneath: string[] = [];
    const walk = (id: string): void => {
      for (const node of placed.values()) {
        if (node.parent !== id) continue;
        if (groups.has(node.id)) walk(node.id);
        else beneath.push(componentId(node.id));
      }
    };
    walk(group);
    children.set(group, beneath.sort(byCodePoint));
  }
  const boundaries: ArchifyBoundary[] = [...children.entries()]
    .map(([id, wraps]) => ({ kind: 'region' as const, label: placed.get(id)!.title, wraps }))
    .sort((a, b) => byCodePoint(a.label, b.label));
  const connections: ArchifyConnection[] = view.edges
    .map((edge) => {
      for (const end of [edge.source, edge.target]) {
        if (groups.has(end)) {
          throw new Error(`an edge of the view "${view.id}" names "${end}", which this view draws as a group frame: archify attaches connections to components, and the frame is no component`);
        }
        if (!placed.has(end)) {
          throw new Error(`an edge of the view "${view.id}" names "${end}", which the view's layout does not hold (from "${edge.source}" to "${edge.target}")`);
        }
      }
      return {
        from: componentId(edge.source),
        to: componentId(edge.target),
        ...(edge.label === undefined || edge.label === '' ? {} : { label: edge.label }),
      };
    })
    .sort((a, b) => byCodePoint(a.from, b.from) || byCodePoint(a.to, b.to) || byCodePoint(a.label ?? '', b.label ?? ''));
  return {
    schema_version: 1,
    diagram_type: 'architecture',
    meta: { title: view.title, output: options.output },
    components,
    boundaries,
    connections,
  };
}

/**
 * Wraps the rendered components named by `links` in anchors to their
 * view's page: `<a href=…>` around the whole `<g …> … </g>` the renderer
 * wrote for the id, counting nested `<g>` groups so the closing tag lands
 * on the component's own. `links` maps the component id (the one
 * `componentId` spells, which the renderer writes as `id="node-…"` and
 * `data-node-id`) to the page's address beside this one. The renderer's
 * output is otherwise untouched. Refuses an id the page does not carry.
 */
export function archifyPageLinks(html: string, links: Readonly<Record<string, string>>): string {
  let linked = html;
  for (const [id, target] of Object.entries(links).sort(([a], [b]) => byCodePoint(a, b))) {
    const opener = `<g id="node-${id}" `;
    const at = linked.indexOf(opener);
    if (at < 0) {
      throw new Error(`the rendered archify page carries no component "${id}": the drill-down links only components the page drew`);
    }
    // The component's own closing tag: walk the groups opened and closed
    // from the opener on, and stop when the depth returns to zero.
    const tokens = /<g[\s>]|<\/g>/g;
    tokens.lastIndex = at;
    let depth = 0;
    let close = -1;
    for (let match = tokens.exec(linked); match !== null; match = tokens.exec(linked)) {
      depth += match[0].startsWith('</') ? -1 : 1;
      if (depth === 0) {
        close = match.index + match[0].length;
        break;
      }
    }
    if (close < 0) {
      throw new Error(`the rendered archify page carries no closing tag for the component "${id}": the renderer's output is truncated`);
    }
    const anchor = `<a href="${target}" data-wiki-view="${id}">`;
    linked = `${linked.slice(0, at)}${anchor}${linked.slice(at, close)}</a>${linked.slice(close)}`;
  }
  return linked;
}
