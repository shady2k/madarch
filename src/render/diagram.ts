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
import { ARCHIFY_RENDERER, archifyVendorCandidates, archifyVendorFolder, copyArchifyVendor } from './archify-vendor.js';

/** One node of a diagram: an entity, or the fold of several of one kind. */
export interface DiagramNode {
  readonly id: string;
  readonly kind: string;
  /** The name the node shows: a path's last segment, the whole label otherwise (madarch-64o5.96). */
  readonly label: string;
  /** The whole label, when the shown name is its last segment: the hover text. */
  readonly title?: string;
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

/** The entity's page address, as the app answers it (decision 0036, section 7). */
export function pageOf(kind: string, id: string): string {
  return `/e/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`;
}

/**
 * The picture's data: the root, and each group of its neighbours as the read counted it — a group within the fold bound
 * is its entities, one edge each to the root; a group above it is one node with the count and the page that lists them,
 * drawn as a single edge. The layout therefore never sees more nodes than the groups and the small groups' rows.
 */
export function diagramGraphOf(neighbourhood: DiagramNeighbourhood, depth: number, aggregateAbove: number, base = ''): DiagramGraph {
  const entity = neighbourhood.entity;
  const labelOf = (uid: string): string => neighbourhood.labels.get(uid) ?? uid;
  // Every node's page stands under the product's own base (madarch-64o5.98): a server that serves several products
  // answers `/products/<folder>/e/...`, and a link without the prefix is a different address of that server.
  const page = (kind: string, id: string): string => `${base}${pageOf(kind, id)}`;
  // A node shows its name; a label that is a path shows its last segment, and the whole path stands as the hover text.
  const named = (id: string): { label: string; title?: string } => {
    const full = labelOf(id);
    const cut = full.lastIndexOf('/');
    return cut >= 0 && cut < full.length - 1 ? { label: full.slice(cut + 1), title: full } : { label: full };
  };
  const rootNamed = named(entity.uid);
  const root: DiagramNode = { id: entity.uid, kind: entity.kind, ...rootNamed, href: page(entity.kind, entity.uid) };
  const nodes = new Map<string, DiagramNode>([[root.id, root]]);
  const edges: DiagramEdge[] = [];
  let folded = 0;
  for (const group of neighbourhood.groups) {
    // The edge's words are the published catalogue's (owner's decision, 2026-11-15). A relation the catalogue names no
    // words for draws no edge: the declaration key never reaches a diagram, and no renderer writes an empty label.
    const word = group.label ?? '';
    if (group.total > aggregateAbove) {
      const kindWord = neighbourhood.kindWords.get(group.kind) ?? group.kind;
      const id = `fold:${group.side}:${group.relation}:${group.kind}`;
      const listed = neighbourhood.kindPages.get(group.kind);
      nodes.set(id, { id, kind: group.kind, label: `${kindWord} · ${String(group.total)}`, count: group.total, ...(listed === undefined ? {} : { href: `${base}${listed}` }) });
      folded += group.total;
      if (word !== '') edges.push(group.side === 'out' ? { from: root.id, to: id, label: word, both: false } : { from: id, to: root.id, label: word, both: false });
      continue;
    }
    for (const uid of group.nodes) {
      const held = neighbourhood.nodes.get(uid);
      if (held === undefined) continue;
      nodes.set(uid, { id: uid, kind: held.kind, ...named(uid), href: page(held.kind, uid) });
      if (word !== '') edges.push(group.side === 'out' ? { from: root.id, to: uid, label: word, both: false } : { from: uid, to: root.id, label: word, both: false });
    }
  }
  edges.sort((left, right) => byCodePoint(left.from, right.from) || byCodePoint(left.to, right.to) || byCodePoint(left.label, right.label));
  return { entity: root, depth, nodes: [...nodes.values()].sort((left, right) => byCodePoint(left.id, right.id)), edges, folded, truncated: neighbourhood.truncated };
}

/** The Mermaid source of one picture: one flowchart, one line per edge, a click per node that has a page. */
export function mermaidText(graph: DiagramGraph): string {
  const ids = new Map(graph.nodes.map((node, at) => [node.id, `n${String(at)}`]));
  const lines = ['%%{init: {"flowchart": {"curve": "linear"}}}%%', 'flowchart LR'];
  for (const node of graph.nodes) {
    const label = node.label === '' ? node.id : node.label;
    // A folded node's label already names its count («Файлы · 1 290»): the renderer adds no second one.
    lines.push(`  ${ids.get(node.id)!}["${escape(label)}"]`);
  }
  for (const edge of graph.edges) {
    const arrow = edge.both ? '<-->' : '-->';
    lines.push(`  ${ids.get(edge.from)!} ${arrow}|"${escape(edge.label)}"| ${ids.get(edge.to)!}`);
  }
  for (const node of graph.nodes) {
    if (node.href === undefined) continue;
    // The node shows its name; the hover text is the whole label, a path whole (madarch-64o5.96).
    lines.push(`  click ${ids.get(node.id)!} href "${node.href}" "${escape(node.title ?? (node.label === '' ? node.id : node.label))}"`);
  }
  // The page's own entity stands out from its neighbours, as it does in every renderer (madarch-64o5.96): the kit's
  // tokens are read by the page, so the class is stated in CSS variables the svg resolves where it is drawn.
  const rootId = ids.get(graph.entity.id);
  // The class alone: the page paints it from the kit's tokens in its own CSS, since Mermaid's classDef grammar takes no
  // CSS variables (madarch-64o5.96).
  if (rootId !== undefined) lines.push(`  class ${rootId} madarch-focus`);
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

/** LikeC4 rejects self-relations, so their targets are another occurrence of the same entity, with its same page. */
function likec4Occurrences(graph: DiagramGraph): DiagramGraph {
  const selfTargets = new Set(graph.edges.filter((edge) => edge.from === edge.to).map((edge) => edge.to));
  const occurrence = (id: string): string => `likec4-self:${id}`;
  return {
    ...graph,
    nodes: [...graph.nodes, ...graph.nodes.filter((node) => selfTargets.has(node.id)).map((node) => ({ ...node, id: occurrence(node.id) }))],
    edges: graph.edges.map((edge) => edge.from === edge.to ? { ...edge, to: occurrence(edge.to) } : edge),
  };
}

/** The LikeC4 model, as one workspace text: the kinds, the nodes, the edges and one view of everything. */
export function likec4Workspace(graph: DiagramGraph): string {
  graph = likec4Occurrences(graph);
  const ids = new Map(graph.nodes.map((node, at) => [node.id, likec4Id(at)]));
  const kinds = [...new Set(graph.nodes.map((node) => node.kind))].sort(byCodePoint);
  const lines: string[] = ['specification {'];
  for (const kind of kinds) lines.push(`  element ${likec4Name(kind)}`);
  lines.push('}', '', 'model {');
  for (const node of graph.nodes) {
    const label = node.label === '' ? node.id : node.label;
    lines.push(`  ${ids.get(node.id)!} = ${likec4Name(node.kind)} "${quote(label)}"`);
  }
  for (const edge of graph.edges) {
    const label = edge.both ? `${edge.label} ⇄` : edge.label;
    lines.push(`  ${ids.get(edge.from)!} -> ${ids.get(edge.to)!} "${quote(label)}"`);
  }
  lines.push('}', '', 'views {', '  view index {', `    title "${quote(graph.entity.label === '' ? graph.entity.id : graph.entity.label)}"`, '    include *', '    include * -> * with { multiple true }', '  }', '', '}');
  return `${lines.join('\n')}\n`;
}

function quote(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

/** The LikeC4 view of one picture: the workspace text and its laid-out model, as the browser's runtime renders it. */
export interface LikeC4Picture {
  readonly format: 'likec4';
  readonly workspace: string;
  /** The laid-out model (`LikeC4Model.create` takes it): elements, relations and the `index` view at its positions. */
  readonly view: unknown;
  /** Each node's page, by the LikeC4 element id the view carries: a press on it opens that entity. */
  readonly links: Readonly<Record<string, string>>;
  /** The whole label of each node whose shown name is its last segment, by element id: the hover text (madarch-64o5.96). */
  readonly titles: Readonly<Record<string, string>>;
  /** The page's own entity, by its LikeC4 element id: it stands out from its neighbours (madarch-64o5.96). */
  readonly root: string;
}

/** Lays the picture out with LikeC4 itself: one workspace in, its laid-out model out. */
export async function likec4PictureOf(graph: DiagramGraph): Promise<LikeC4Picture> {
  const workspace = likec4Workspace(graph);
  const { LikeC4 } = await import('likec4');
  const likec4 = await LikeC4.fromSource(workspace, { logger: false, printErrors: false, throwIfInvalid: true });
  try {
    const model = await likec4.layoutedModel();
    const occurrences = likec4Occurrences(graph);
    const ids = new Map(occurrences.nodes.map((node, at) => [node.id, likec4Id(at)]));
    const links: Record<string, string> = {};
    const titles: Record<string, string> = {};
    for (const node of occurrences.nodes) {
      if (node.href !== undefined) links[ids.get(node.id)!] = node.href;
      if (node.title !== undefined) titles[ids.get(node.id)!] = node.title;
    }
    return { format: 'likec4', workspace, view: model.$data, links, titles, root: ids.get(graph.entity.id) ?? '' };
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

/** The units a text occupies at the archify renderer's own 0.6 px-per-unit advance. */
function archifyTextUnits(text: string): number {
  let units = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const wide = (code >= 0x1100 && code <= 0x115f) || code === 0x2329 || code === 0x232a
      || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe19)
      || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff);
    units += wide ? 2 : 1;
  }
  return units;
}

/** The width a sublabel needs at the renderer's preferred 9 px, so the visible text keeps a margin inside its card. */
function sublabelPreferredWidth(text: string): number {
  return archifyTextUnits(text) * 9 * 0.6;
}

/**
 * The sublabel a node can show: the whole path when it fits at the preferred 9 px inside the card, else a
 * middle-shortened path that does. The whole path stays in the node's hover title (the forwarder writes it there), so a
 * deep path never makes the archify renderer refuse the diagram and never starts at the card's edge.
 */
export function archifySublabel(text: string, width: number): string {
  const available = Math.max(1, width - 16);
  if (sublabelPreferredWidth(text) <= available) return text;
  const parts = text.split('/');
  for (let keep = parts.length - 1; keep >= 1; keep -= 1) {
    const candidate = `…/${parts.slice(-keep).join('/')}`;
    if (sublabelPreferredWidth(candidate) <= available) return candidate;
  }
  let tail = parts[parts.length - 1] ?? text;
  while (tail.length > 1 && sublabelPreferredWidth(`…${tail}`) > available) tail = tail.slice(1);
  return `…${tail}`;
}

/** The archify document of a laid-out view: every node a component at LikeC4's position, every edge a connection. */
export function archifyDocument(graph: DiagramGraph, liked: LikeC4Picture): Record<string, unknown> {
  const layout = layoutOf(liked);
  if (layout === undefined) throw new Error(`${import.meta.filename}:1: the LikeC4 layout holds no "index" view, so archify has no picture to draw`);
  const occurrences = likec4Occurrences(graph);
  const order = new Map(occurrences.nodes.map((node, at) => [node.id, at]));
  const componentIds = new Map<string, string>();
  const components = layout.nodes.map((node, at) => {
    const own = occurrences.nodes.find((one) => likec4Id(order.get(one.id) ?? -1) === node.id);
    const id = own === undefined ? `c${String(at)}` : `node_${likec4Name(own.id)}`;
    componentIds.set(node.id, id);
    const width = Math.round(node.width ?? 160);
    const full = own?.title ?? own?.kind ?? '';
    return {
      id,
      type: archifyType(at),
      label: node.title === undefined || node.title === '' ? node.id : node.title,
      // The whole path stands under a shortened name, so two files of one name read apart (madarch-64o5.96); a path
      // longer than the node can carry at the legible minimum is shortened here, and the whole path stays in the
      // node's hover title (see the forwarder).
      sublabel: full === '' ? '' : archifySublabel(full, width),

      pos: [Math.round(node.x ?? 0), Math.round(node.y ?? 0)],
      size: [width, Math.round(node.height ?? 60)],
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
export async function renderArchify(document: Record<string, unknown>, graph: DiagramGraph, options: { timeoutMs?: number; started?: (pid: number, folder: string) => void; stopped?: () => void } = {}): Promise<string> {
  const { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const vendor = archifyVendorFolder();
  if (vendor === undefined) throw new Error(`the vendored archify renderer is missing: neither the checkout's vendor/archify nor the wiki app's dist/archify carries it (looked in ${archifyVendorCandidates().join(', ')})`);
  const folder = mkdtempSync(join(tmpdir(), 'madarch-diagram-'));
  const timeout = options.timeoutMs ?? 30_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const input = join(folder, 'document.json');
    const output = join(folder, 'diagram.html');
    writeFileSync(input, JSON.stringify(document));
    // The release binary carries the renderer inside its own bundle, which only its own process can open: the vendor
    // folder is laid beside the document, file by file, and the renderer runs from there (madarch-64o5.97). The same
    // layout serves a checkout's vendor tree, whose entry imports its sibling modules and reads its template.
    copyArchifyVendor(vendor, join(folder, 'archify'));
    const renderer = join(folder, 'archify', ...ARCHIFY_RENDERER);
    const child = Bun.spawn({ cmd: [process.execPath, renderer, input, output], cwd: folder, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, BUN_BE_BUN: '1' } });
    options.started?.(child.pid, folder);
    const ended = await Promise.race([child.exited, new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), timeout); })]);
    if (ended === 'timeout') {
      child.kill('SIGKILL');
      throw new Error(`the archify renderer did not finish within ${String(timeout)} ms`);
    }
    if (ended !== 0) {
      const said = (await new Response(child.stderr).text()).trim();
      throw new Error(`the archify renderer ended with ${String(ended)}: ${said === '' ? 'it said nothing' : said}`);
    }
    if (!existsSync(output)) throw new Error('the archify renderer wrote no page');
    return forwarder(readFileSync(output, 'utf8'), graph);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.stopped?.();
    rmSync(folder, { recursive: true, force: true });
  }
}

/** The rendered page with the press forwarded: a click on a node's box opens the entity's page in the wiki. */

/** The rendered page with the press forwarded: a click on a node's box opens the entity's page in the wiki. */
export function forwarder(html: string, graph: DiagramGraph): string {
  const links: Record<string, string> = {};
  const titles: Record<string, string> = {};
  for (const node of likec4Occurrences(graph).nodes) {
    if (node.href !== undefined) links[`node_${likec4Name(node.id)}`] = node.href;
    if (node.title !== undefined) titles[`node_${likec4Name(node.id)}`] = node.title;
  }
  // The press opens a node's page; a theme message paints the page from the kit's own tokens (madarch-64o5.96). The
  // renderer keeps its own layout and behaviour, and only its colours come from the wiki the frame stands in. A node
  // whose visible sublabel was shortened keeps its whole path in the passport detail and the SVG title.
  const focus = `node_${likec4Name(graph.entity.id)}`;
  const script = `<script>(function(){var focusId=${JSON.stringify(focus)};var links=${JSON.stringify(links).replaceAll('<', '\\u003c')};var titles=${JSON.stringify(titles).replaceAll('<', '\\u003c')};for(var tid in titles){var detailNode=document.querySelector('[data-node-id="'+tid+'"]');if(detailNode){detailNode.setAttribute('data-node-sublabel',titles[tid]);var titleNode=detailNode.querySelector('title');if(titleNode)titleNode.textContent=titles[tid];}}document.addEventListener('click',function(event){var target=event.target;while(target&&target.getAttribute){var id=target.getAttribute('data-node-id');if(id&&links[id]){parent.postMessage({madarch:'open',href:links[id]},'*');return;}target=target.parentNode;}},true);window.addEventListener('message',function(event){var data=event.data||{};if(data.madarch!=='theme'||!data.theme)return;var theme=data.theme;var paints={'--bg':theme.canvas,'--grid':theme.nodeBorder,'--canvas-dot':theme.nodeBorder,'--text':theme.nodeText,'--text-muted':theme.edge,'--text-dim':theme.edge,'--text-faint':theme.edge,'--panel':theme.canvas,'--panel-border':theme.nodeBorder,'--lane-fill':theme.canvas,'--lane-stroke':theme.nodeBorder,'--arrow':theme.edge,'--arrow-emphasis':theme.nodeText,'--mask':theme.canvas,'--accept-fill':theme.nodeFill,'--accept-stroke':theme.nodeBorder,'--frontend-fill':theme.nodeFill,'--frontend-stroke':theme.nodeBorder,'--backend-fill':theme.nodeFill,'--backend-stroke':theme.nodeBorder,'--database-fill':theme.nodeFill,'--database-stroke':theme.nodeBorder,'--cloud-fill':theme.nodeFill,'--cloud-stroke':theme.nodeBorder,'--security-fill':theme.nodeFill,'--security-stroke':theme.nodeBorder,'--messagebus-fill':theme.nodeFill,'--messagebus-stroke':theme.nodeBorder,'--external-fill':theme.nodeFill,'--external-stroke':theme.nodeBorder,'--toolbar-bg':theme.canvas,'--toolbar-border':theme.nodeBorder,'--toolbar-text':theme.nodeText,'--toolbar-menu-bg':theme.canvas};var root=document.documentElement;for(var name in paints){root.style.setProperty(name,paints[name]);}root.setAttribute('data-theme',theme.scheme==='dark'?'dark':'light');var focus=document.querySelector('[data-node-id="'+focusId+'"]');if(focus){focus.querySelectorAll('rect,path,polygon').forEach(function(shape){shape.style.fill=theme.focusFill;shape.style.stroke=theme.focusBorder;shape.style.strokeWidth='2';});}parent.postMessage({madarch:'themed'},'*');});})();</script>`;
  const at = html.toLowerCase().lastIndexOf('</body>');
  return at < 0 ? `${html}${script}` : `${html.slice(0, at)}${script}${html.slice(at)}`;
}
