/**
 * The diagram of one entity, rendered on the server (decision 0036, sections 7 and 8; capability views, one-view): the
 * neighbourhood the graph read layer answered, an edge and its inverse drawn once, more than `aggregateAbove` neighbours
 * of one kind folded into one node with the count, and the picture in one of the three formats — Mermaid's text, a
 * LikeC4 workspace with its laid-out view, and archify's self-contained HTML page. The same graph revision and the same
 * request give the same bytes; the clock and the machine never enter. Nothing here reads the graph: the input is what
 * `ReadContext.diagramNeighbourhood` answered, so this module is a writer of pictures, not a read surface.
 */
import { byCodePoint } from '../model/order.js';
import type { DiagramNeighbourhood } from '../graph/graphql-read.js';

/** One node of a diagram: an entity, or the fold of several of one kind. */
export interface DiagramNode {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  /** The entity's page, absent for a fold (several entities, no one page). */
  readonly href?: string;
  /** How many entities of one kind the node stands for, when it is a fold. */
  readonly count?: number;
}

/** One edge of a diagram: an edge and its inverse are one line, `both` when both directions were read. */
export interface DiagramEdge {
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly both: boolean;
}

/** The picture's data: the asked entity, its neighbours and the relations between them. */
export interface DiagramGraph {
  readonly entity: DiagramNode;
  readonly depth: number;
  readonly nodes: readonly DiagramNode[];
  readonly edges: readonly DiagramEdge[];
  /** How many entities the folds stand for, when any were folded. */
  readonly folded: number;
  /** Whether a level read short of every relation. */
  readonly truncated: boolean;
}

/** The relation an edge is labelled with: an inverse field is its edge's name, so the two directions read once. */
export function relationBase(relation: string): string {
  return relation.endsWith('Of') ? relation.slice(0, -2) : relation;
}

/** The entity's page address, as the app answers it (decision 0036, section 7). */
export function pageOf(kind: string, id: string): string {
  return `/e/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`;
}

/**
 * The picture's data: an edge and its inverse are one line (the same pair of entities and the same relation, read from
 * either end), and neighbours of one kind above the bound are one node that says how many. A folded node keeps no page:
 * the count stands for several entities, and a press on it opens none of them.
 */
export function diagramGraphOf(neighbourhood: DiagramNeighbourhood, depth: number, aggregateAbove: number): DiagramGraph {
  const entity = neighbourhood.entity;
  const labelOf = (uid: string): string => neighbourhood.labels.get(uid) ?? uid;
  const root: DiagramNode = { id: entity.uid, kind: entity.kind, label: labelOf(entity.uid), href: pageOf(entity.kind, entity.uid) };
  const byUid = new Map([...neighbourhood.nodes.entries()].map(([uid, one]) => [uid, one]));
  // The labels the read layer answers are read through the field resolver's own label; a node here carries its id when
  // the label is not yet known, and `labelled` names them before the picture is written.
  const nodes = new Map<string, DiagramNode>();
  nodes.set(root.id, root);
  for (const [uid, one] of byUid) {
    if (uid === root.id) continue;
    nodes.set(uid, { id: uid, kind: one.kind, label: labelOf(uid), href: pageOf(one.kind, uid) });
  }
  // Fold: one node per kind above the bound, in code point order of the kind.
  const byKind = new Map<string, string[]>();
  for (const node of nodes.values()) {
    if (node.id === root.id) continue;
    byKind.set(node.kind, [...(byKind.get(node.kind) ?? []), node.id]);
  }
  const folded = new Map<string, string>();
  let foldedCount = 0;
  for (const [kind, ids] of [...byKind.entries()].sort(([left], [right]) => byCodePoint(left, right))) {
    if (ids.length <= aggregateAbove) continue;
    const key = `kind:${kind}`;
    foldedCount += ids.length;
    for (const id of ids) {
      folded.set(id, key);
      nodes.delete(id);
    }
    nodes.set(key, { id: key, kind, label: kind, count: ids.length });
  }
  const edges: DiagramEdge[] = [];
  const byKey = new Map<string, number>();
  for (const link of neighbourhood.links) {
    const from = folded.get(link.from) ?? link.from;
    const to = folded.get(link.to) ?? link.to;
    if (from === to) continue;
    const label = relationBase(link.relation);
    const key = byCodePoint(from, to) <= 0 ? `${from}\u0000${to}\u0000${label}` : `${to}\u0000${from}\u0000${label}`;
    const at = byKey.get(key);
    if (at === undefined) {
      byKey.set(key, edges.length);
      edges.push({ from, to, label, both: false });
      continue;
    }
    // The same pair and relation read from the other end: one line, drawn both ways.
    const held = edges[at]!;
    if (held.from !== from) edges[at] = { ...held, both: true };
  }
  edges.sort((left, right) => byCodePoint(left.from, right.from) || byCodePoint(left.to, right.to) || byCodePoint(left.label, right.label));
  return {
    entity: root,
    depth,
    nodes: [...nodes.values()].sort((left, right) => byCodePoint(left.id, right.id)),
    edges,
    folded: foldedCount,
    truncated: neighbourhood.truncated,
  };
}

/** The Mermaid source of one picture: one flowchart, one line per edge, a click per node that has a page. */
export function mermaidText(graph: DiagramGraph): string {
  const ids = new Map(graph.nodes.map((node, at) => [node.id, `n${String(at)}`]));
  const lines = ['%%{init: {"flowchart": {"curve": "linear"}}}%%', 'flowchart LR'];
  for (const node of graph.nodes) {
    const label = node.label === '' ? node.id : node.label;
    lines.push(`  ${ids.get(node.id)!}["${escape(label)}${node.count === undefined ? '' : `<br/>× ${String(node.count)}`}"]`);
  }
  for (const edge of graph.edges) {
    const arrow = edge.both ? '<-->' : '-->';
    lines.push(`  ${ids.get(edge.from)!} ${arrow}|"${escape(edge.label)}"| ${ids.get(edge.to)!}`);
  }
  for (const node of graph.nodes) {
    if (node.href === undefined) continue;
    lines.push(`  click ${ids.get(node.id)!} href "${node.href}" "${escape(node.label === '' ? node.id : node.label)}"`);
  }
  return `${lines.join('\n')}\n`;
}

/** A Mermaid label or name: in double quotes, a quote escaped and a line break folded. */
function escape(value: string): string {
  return value.replaceAll('"', '&quot;').replaceAll('\n', ' ');
}

/** A LikeC4 identifier: a kind's name carries dots, which LikeC4 reads as nesting, so it is respelled for the grammar. */
export function likec4Name(name: string): string {
  const replaced = name.replace(/[^A-Za-z0-9_-]/g, '_');
  return /^[A-Za-z]/.test(replaced) ? replaced : `_${replaced}`;
}

/** A LikeC4 identifier for a node: the entity ids are uids and folds, neither a LikeC4 name, so the position names them. */
function likec4Id(index: number): string {
  return `n${String(index)}`;
}

/** The LikeC4 model, as one workspace text: the kinds, the nodes, the edges and one view of everything. */
export function likec4Workspace(graph: DiagramGraph): string {
  const ids = new Map(graph.nodes.map((node, at) => [node.id, likec4Id(at)]));
  const kinds = [...new Set(graph.nodes.map((node) => node.kind))].sort(byCodePoint);
  const lines: string[] = ['specification {'];
  for (const kind of kinds) lines.push(`  element ${likec4Name(kind)}`);
  lines.push('}', '', 'model {');
  for (const node of graph.nodes) {
    const label = node.label === '' ? node.id : node.label;
    lines.push(`  ${ids.get(node.id)!} = ${likec4Name(node.kind)} "${quote(node.count === undefined ? label : `${label} × ${String(node.count)}`)}"`);
  }
  for (const edge of graph.edges) {
    const label = edge.both ? `${edge.label} ⇄` : edge.label;
    lines.push(`  ${ids.get(edge.from)!} -> ${ids.get(edge.to)!} "${quote(label)}"`);
  }
  lines.push('}', '', 'views {', '  view index {', `    title "${quote(graph.entity.label === '' ? graph.entity.id : graph.entity.label)}"`, '    include *', '  }', '', '}');
  return `${lines.join('\n')}\n`;
}

function quote(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

/** The LikeC4 view of one picture: the workspace text and its laid-out model, as the browser's LikeC4 runtime renders it. */
export interface LikeC4Picture {
  readonly format: 'likec4';
  readonly workspace: string;
  /** The laid-out model (`LikeC4Model.create` takes it): elements, relations and the `index` view at its positions. */
  readonly view: unknown;
  /** Each node's page, by the LikeC4 element id the view carries: a press on it opens that entity. */
  readonly links: Readonly<Record<string, string>>;
}

/** Lays the picture out with LikeC4 itself: one workspace in, its laid-out model out. */
export async function likec4PictureOf(graph: DiagramGraph): Promise<LikeC4Picture> {
  const workspace = likec4Workspace(graph);
  const { LikeC4 } = await import('likec4');
  const likec4 = await LikeC4.fromSource(workspace, { logger: false, printErrors: false, throwIfInvalid: true });
  try {
    const model = await likec4.layoutedModel();
    const ids = new Map(graph.nodes.map((node, at) => [node.id, likec4Id(at)]));
    const links: Record<string, string> = {};
    for (const node of graph.nodes) if (node.href !== undefined) links[ids.get(node.id)!] = node.href;
    return { format: 'likec4', workspace, view: model.$data, links };
  } finally {
    await likec4[Symbol.asyncDispose]?.();
  }
}

/** One node of a laid-out LikeC4 view, as its model data holds it. */
interface LayoutNode {
  readonly id: string;
  readonly title?: string;
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
}

/** One edge of a laid-out LikeC4 view. */
interface LayoutEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly label?: string;
  readonly labelBBox?: { readonly x: number; readonly y: number };
}

/** The laid-out `index` view of a LikeC4 model, or undefined when the model holds none. */
export function layoutOf(likec4: LikeC4Picture): { nodes: readonly LayoutNode[]; edges: readonly LayoutEdge[] } | undefined {
  const views = (likec4.view as { views?: Record<string, { nodes?: readonly LayoutNode[]; edges?: readonly LayoutEdge[] }> } | null)?.views;
  const view = views?.['index'];
  return view?.nodes === undefined ? undefined : { nodes: view.nodes, edges: view.edges ?? [] };
}

/** The archify component type a LikeC4 node reads as: the graph knows no archify kinds, and the picture's one look says so. */
function archifyType(index: number): string {
  return index === 0 ? 'cloud' : 'backend';
}

/** The archify document of a laid-out view: every node a component at LikeC4's position, every edge a connection. */
export function archifyDocument(graph: DiagramGraph, liked: LikeC4Picture): Record<string, unknown> {
  const layout = layoutOf(liked);
  if (layout === undefined) throw new Error(`${import.meta.filename}:1: the LikeC4 layout holds no "index" view, so archify has no picture to draw`);
  const order = new Map(graph.nodes.map((node, at) => [node.id, at]));
  const componentIds = new Map<string, string>();
  const components = layout.nodes.map((node, at) => {
    const id = `c${String(at)}`;
    componentIds.set(node.id, id);
    const own = graph.nodes.find((one) => likec4Id(order.get(one.id) ?? -1) === node.id);
    return {
      id,
      type: archifyType(at),
      label: node.title === undefined || node.title === '' ? node.id : node.title,
      sublabel: own?.kind ?? '',

      pos: [Math.round(node.x ?? 0), Math.round(node.y ?? 0)],
      size: [Math.round(node.width ?? 160), Math.round(node.height ?? 60)],
    };
  });
  if (components.length === 0) throw new Error(`${import.meta.filename}:1: the laid-out view holds no node, and an archify document needs at least one`);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const connections = layout.edges.map((edge, at) => {
    const from = componentIds.get(edge.source);
    const to = componentIds.get(edge.target);
    const label = typeof edge.label === 'string' && edge.label !== '' ? edge.label : undefined;
    return {
      ...(from === undefined || to === undefined ? {} : { id: `e${String(at)}`, from, to }),
      ...(label === undefined ? {} : { label }),
      ...(edge.labelBBox === undefined ? {} : { labelAt: [Math.round(edge.labelBBox.x), Math.round(edge.labelBBox.y)] }),
      route: 'auto' as const,
    };
  }).filter((one) => 'from' in one);
  const title = byId.get(graph.entity.id)?.label ?? graph.entity.label ?? graph.entity.id;
  return {
    schema_version: 1,
    diagram_type: 'architecture',
    meta: { title, subtitle: `${String(graph.nodes.length)} nodes · ${String(graph.edges.length)} relations`, output: 'diagram.html' },
    components,
    connections,
  };
}

/**
 * Runs the vendored archify renderer (vendor/archify, unmodified) on one document and answers its self-contained page with
 * a forwarder appended: a press on a node posts its page to the frame's parent, so the wiki opens the entity the node
 * stands for. The renderer runs as its own process, and the whole call is bounded.
 */
export async function renderArchify(document: Record<string, unknown>, graph: DiagramGraph, options: { timeoutMs?: number } = {}): Promise<string> {
  const { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const renderer = fileURLToPath(new URL('../../vendor/archify/renderers/architecture/render-architecture.mjs', import.meta.url));
  if (!existsSync(renderer)) throw new Error(`${renderer}:1: the vendored archify renderer is missing`);
  const folder = mkdtempSync(join(tmpdir(), 'madarch-diagram-'));
  const timeout = options.timeoutMs ?? 30_000;
  try {
    const input = join(folder, 'document.json');
    const output = join(folder, 'diagram.html');
    writeFileSync(input, JSON.stringify(document));
    const child = Bun.spawn({ cmd: [process.execPath, renderer, input, output], cwd: folder, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, BUN_BE_BUN: '1' } });
    const ended = await Promise.race([child.exited, new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeout))]);
    if (ended === 'timeout') {
      child.kill('SIGKILL');
      throw new Error(`${renderer}:1: the archify renderer did not finish within ${String(timeout)} ms`);
    }
    if (ended !== 0) {
      const said = (await new Response(child.stderr).text()).trim();
      throw new Error(`${renderer}:1: the archify renderer ended with ${String(ended)}: ${said === '' ? 'it said nothing' : said}`);
    }
    if (!existsSync(output)) throw new Error(`${renderer}:1: the archify renderer wrote no page`);
    return forwarder(readFileSync(output, 'utf8'), graph);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** The rendered page with the press forwarded: a click on a node's box opens the entity's page in the wiki. */
export function forwarder(html: string, graph: DiagramGraph): string {
  const links: Record<string, string> = {};
  for (const node of graph.nodes) if (node.href !== undefined) links[node.id] = node.href;
  const script = `<script>(function(){var links=${JSON.stringify(links).replaceAll('<', '\\u003c')};document.addEventListener('click',function(event){var target=event.target;while(target&&target.getAttribute){var id=target.getAttribute('data-node-id');if(id&&links[id]){parent.postMessage({madarch:'open',href:links[id]},'*');return;}target=target.parentNode;}},true);})();</script>`;
  const at = html.toLowerCase().lastIndexOf('</body>');
  return at < 0 ? `${html}${script}` : `${html.slice(0, at)}${script}${html.slice(at)}`;
}
