/**
 * The layouts of the diagram blocks, as pure functions of the data the server
 * answers: where a node, a lane or a cell stands, in diagram units (one unit is
 * one CSS pixel at scale 1). Nothing here touches the DOM, so the placement can be
 * tested and the picture checked against it.
 *
 * Why no layout library: the neighbourhood is a layered drawing whose layers are
 * given (what comes in on the left, what goes out on the right), the system and
 * module views are small layered graphs, the sequence is a table of lanes and
 * steps, and the treemap is a squarified partition. A general engine (ELK, dagre)
 * adds a few hundred kilobytes and a worker or wasm to the compiled binary to
 * compute what a few dozen lines compute here; the choice is recorded in
 * docs/changes/madarch-m38l.9/change.md.
 */
import type { DiagramEdge, DiagramMore, DiagramNode, ModuleEdge, ModuleNode, Neighborhood, SystemEdge, SystemNode } from '../types.js';

// ---- text -------------------------------------------------------------------------------------

/** The width of a text in the diagram's 12 px sans face; a measured average, with a margin, never narrower than the real thing. */
export function textWidth(text: string, size = 12): number {
  let width = 0;
  for (const char of text) {
    if ('iljtf.,:;|!\'` '.includes(char)) width += 0.36;
    else if ('mwMW@'.includes(char)) width += 0.9;
    else if (char >= 'A' && char <= 'Z') width += 0.68;
    else if (char.charCodeAt(0) > 0x2e80) width += 1.05;
    else width += 0.56;
  }
  return Math.ceil(width * size) + 2;
}

/** A text cut to a width, ending with an ellipsis; the full text stays in the title. */
export function fit(text: string, width: number, size = 12): string {
  if (textWidth(text, size) <= width) return text;
  let cut = text;
  while (cut.length > 1 && textWidth(`${cut}…`, size) > width) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** The relation as a reader reads it: the extractor's prefix dropped. */
export function relationWord(relation: string): string {
  return relation.startsWith('code.') ? relation.slice('code.'.length) : relation.startsWith('engine:') ? relation.slice('engine:'.length) : relation;
}

// ---- the neighbourhood ------------------------------------------------------------------------

export const NODE_W = 196;
export const NODE_H = 36;
const COL_GAP = 84;
const ROW_GAP = 8;
const GROUP_GAP = 18;
const HEADER_H = 18;

export interface HoodState {
  /** Hops from the centre that are shown (nodes grown by a click are shown regardless). */
  depth: number;
  /** Relations switched off, as `relation|direction`. */
  off: ReadonlySet<string>;
}

export interface PlacedNode {
  node: DiagramNode;
  x: number;
  y: number;
  column: number;
  /** The relation group the node stands in, for the header over it. */
  group: string;
  /** `+N more` chips are not nodes of the graph. */
  more?: DiagramMore;
}

export interface PlacedGroup {
  column: number;
  label: string;
  relation: string;
  direction: 'out' | 'in';
  x: number;
  y: number;
}

export interface PlacedEdge {
  from: string;
  to: string;
  relation: string;
  count: number;
  d: string;
}

export interface HoodLayout {
  nodes: PlacedNode[];
  groups: PlacedGroup[];
  edges: PlacedEdge[];
  width: number;
  height: number;
  center: { x: number; y: number };
}

export const slotOf = (relation: string, direction: 'out' | 'in'): string => `${relation}|${direction}`;

/** What two hoods hold together: the second adds nodes, edges and `more` entries; a `more` entry the second answers is replaced. */
export function mergeHood(base: Neighborhood, extra: Neighborhood, answered?: { node: string; relation: string; direction: 'out' | 'in' }): Neighborhood {
  const nodes = new Map(base.nodes.map((node) => [node.id, node]));
  const parentHops = nodes.get(extra.center)?.hops ?? 0;
  for (const node of extra.nodes) if (!nodes.has(node.id)) nodes.set(node.id, { ...node, hops: parentHops + 1 });
  const edges = new Map(base.edges.map((edge) => [`${edge.from}|${edge.to}|${edge.relation}`, edge]));
  for (const edge of extra.edges) if (!edges.has(`${edge.from}|${edge.to}|${edge.relation}`)) edges.set(`${edge.from}|${edge.to}|${edge.relation}`, edge);
  const more = base.more.filter((entry) => answered === undefined ? entry.node !== extra.center : !(entry.node === answered.node && entry.relation === answered.relation && entry.direction === answered.direction));
  for (const entry of extra.more) more.push(entry);
  return { center: base.center, nodes: [...nodes.values()], edges: [...edges.values()], more, relations: base.relations };
}

/**
 * Places the neighbourhood: columns of the nodes that come in (left) and go out (right) of the centre, each column
 * grouped by the relation that put its nodes there. A node is in the column of its first path from the centre; the
 * walk beyond the first hop continues only outward from the side it is on, so callers of callers stay on the left.
 */
export function layoutNeighborhood(hood: Neighborhood, state: HoodState, grown: ReadonlySet<string> = new Set()): HoodLayout {
  const byId = new Map(hood.nodes.map((node) => [node.id, node]));
  const column = new Map<string, number>([[hood.center, 0]]);
  const via = new Map<string, { relation: string; direction: 'out' | 'in'; parent: string }>();
  const usable = (edge: DiagramEdge, direction: 'out' | 'in'): boolean => !state.off.has(slotOf(edge.relation, direction));
  const queue: string[] = [hood.center];
  for (let at = 0; at < queue.length; at += 1) {
    const current = queue[at]!;
    const col = column.get(current)!;
    const hops = Math.abs(col);
    const expandedHere = current === hood.center || hops < state.depth || grown.has(current);
    if (!expandedHere) continue;
    const edges = [...hood.edges].sort((a, b) => (a.relation === b.relation ? 0 : a.relation < b.relation ? -1 : 1) || (a.from + a.to < b.from + b.to ? -1 : 1));
    for (const edge of edges) {
      for (const direction of ['in', 'out'] as const) {
        const [near, far] = direction === 'out' ? [edge.from, edge.to] : [edge.to, edge.from];
        if (near !== current || column.has(far) || !byId.has(far) || !usable(edge, direction)) continue;
        // Beyond the centre a node's neighbours continue on its own side.
        if (col < 0 && direction === 'out') continue;
        if (col > 0 && direction === 'in') continue;
        column.set(far, col + (direction === 'out' ? 1 : -1));
        via.set(far, { relation: edge.relation, direction, parent: current });
        queue.push(far);
      }
    }
  }
  const placed: PlacedNode[] = [];
  const groups: PlacedGroup[] = [];
  const colsUsed = [...new Set([...column.values(), ...hood.more.filter((m) => column.has(m.node) && (Math.abs(column.get(m.node)!) < state.depth || m.node === hood.center || grown.has(m.node)) && !state.off.has(slotOf(m.relation, m.direction))).map((m) => column.get(m.node)! + (m.direction === 'out' ? 1 : -1))])].sort((a, b) => a - b);
  const heights = new Map<number, number>();
  type Cell = { node: DiagramNode; more?: DiagramMore; group: string; relation: string; direction: 'out' | 'in'; parent: string };
  const cellsOf = new Map<number, Cell[]>();
  for (const [id, col] of column) {
    if (id === hood.center) continue;
    const reached = via.get(id)!;
    const cells = cellsOf.get(col) ?? [];
    cells.push({ node: byId.get(id)!, group: slotOf(reached.relation, reached.direction), relation: reached.relation, direction: reached.direction, parent: reached.parent });
    cellsOf.set(col, cells);
  }
  for (const entry of hood.more) {
    const col = column.get(entry.node);
    if (col === undefined || state.off.has(slotOf(entry.relation, entry.direction))) continue;
    if (!(entry.node === hood.center || Math.abs(col) < state.depth || grown.has(entry.node))) continue;
    if (col < 0 && entry.direction === 'out') continue;
    if (col > 0 && entry.direction === 'in') continue;
    const target = col + (entry.direction === 'out' ? 1 : -1);
    const cells = cellsOf.get(target) ?? [];
    cells.push({ node: { id: `more:${entry.node}|${entry.relation}|${entry.direction}`, kind: 'more', label: `+${entry.hidden}`, href: null }, more: entry, group: slotOf(entry.relation, entry.direction), relation: entry.relation, direction: entry.direction, parent: entry.node });
    cellsOf.set(target, cells);
  }
  for (const col of colsUsed) {
    const cells = (cellsOf.get(col) ?? []).sort((a, b) => (a.parent < b.parent ? -1 : a.parent > b.parent ? 1 : 0) || (a.group < b.group ? -1 : a.group > b.group ? 1 : 0) || (a.more ? 1 : 0) - (b.more ? 1 : 0) || (a.node.label < b.node.label ? -1 : a.node.label > b.node.label ? 1 : 0));
    let height = 0;
    let previous = '';
    for (const cell of cells) {
      const key = `${cell.parent}|${cell.group}`;
      height += (key === previous ? ROW_GAP : (previous === '' ? 0 : GROUP_GAP) + HEADER_H) + NODE_H;
      previous = key;
    }
    heights.set(col, height);
  }
  const tallest = Math.max(NODE_H, ...heights.values());
  const minCol = Math.min(0, ...colsUsed);
  const maxCol = Math.max(0, ...colsUsed);
  const columnX = (col: number): number => (col - minCol) * (NODE_W + COL_GAP);
  const centerY = tallest / 2 - NODE_H / 2;
  for (const col of colsUsed) {
    const cells = cellsOf.get(col) ?? [];
    let y = (tallest - (heights.get(col) ?? 0)) / 2;
    let previous = '';
    for (const cell of cells) {
      const key = `${cell.parent}|${cell.group}`;
      if (key !== previous) {
        y += previous === '' ? 0 : GROUP_GAP;
        groups.push({ column: col, label: `${col < 0 ? '' : '→ '}${relationWord(cell.relation)}${col < 0 ? ' →' : ''}`, relation: cell.relation, direction: cell.direction, x: columnX(col), y });
        y += HEADER_H;
      } else y += ROW_GAP;
      placed.push({ node: cell.node, x: columnX(col), y, column: col, group: cell.group, ...(cell.more === undefined ? {} : { more: cell.more }) });
      y += NODE_H;
      previous = key;
    }
  }
  const center = byId.get(hood.center)!;
  placed.push({ node: center, x: columnX(0), y: centerY, column: 0, group: '' });
  const at = new Map(placed.filter((entry) => entry.more === undefined).map((entry) => [entry.node.id, entry]));
  const edges: PlacedEdge[] = [];
  for (const edge of hood.edges) {
    const from = at.get(edge.from);
    const to = at.get(edge.to);
    if (from === undefined || to === undefined) continue;
    const out = from.x < to.x;
    const [sx, sy] = [out ? from.x + NODE_W : from.x, from.y + NODE_H / 2];
    const [tx, ty] = [out ? to.x : to.x + NODE_W, to.y + NODE_H / 2];
    if (from.column === to.column) continue;
    const bend = Math.max(24, Math.abs(tx - sx) / 2);
    edges.push({ from: edge.from, to: edge.to, relation: edge.relation, count: edge.count, d: `M${sx},${sy} C${sx + (out ? bend : -bend)},${sy} ${tx - (out ? bend : -bend)},${ty} ${tx},${ty}` });
  }
  for (const chip of placed.filter((entry) => entry.more !== undefined)) {
    const parent = at.get(chip.more!.node);
    if (parent === undefined) continue;
    const out = chip.more!.direction === 'out';
    const [sx, sy] = [out ? parent.x + NODE_W : parent.x, parent.y + NODE_H / 2];
    const [tx, ty] = [out ? chip.x : chip.x + NODE_W, chip.y + NODE_H / 2];
    const bend = Math.max(24, Math.abs(tx - sx) / 2);
    edges.push({ from: parent.node.id, to: chip.node.id, relation: chip.more!.relation, count: chip.more!.hidden, d: `M${sx},${sy} C${sx + (out ? bend : -bend)},${sy} ${tx - (out ? bend : -bend)},${ty} ${tx},${ty}` });
  }
  return {
    nodes: placed,
    groups,
    edges,
    width: (maxCol - minCol + 1) * NODE_W + (maxCol - minCol) * COL_GAP,
    height: tallest,
    center: { x: columnX(0), y: centerY },
  };
}

// ---- layered graphs (system, modules) -----------------------------------------------------------

export interface LayeredNode {
  id: string;
  w: number;
  h: number;
}

export interface LayeredEdge {
  from: string;
  to: string;
}

export interface Placed {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  layer: number;
}

/**
 * Longest-path layers left to right. An edge that closes a cycle (found by a depth-first walk in id order) points
 * backward and does not push its target, so a cycle never loops the placement; the drawing marks those edges.
 */
export function layered(nodes: readonly LayeredNode[], edges: readonly LayeredEdge[], options: { gapX: number; gapY: number; vertical?: boolean }): { placed: Map<string, Placed>; back: Set<string>; width: number; height: number } {
  const ids = nodes.map((node) => node.id).sort();
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of edges) if (out.has(edge.from) && out.has(edge.to) && edge.from !== edge.to) out.get(edge.from)!.push(edge.to);
  for (const targets of out.values()) targets.sort();
  const back = new Set<string>();
  const state = new Map<string, 1 | 2>();
  const walk = (id: string): void => {
    state.set(id, 1);
    for (const to of out.get(id)!) {
      if (state.get(to) === 1) back.add(`${id}|${to}`);
      else if (!state.has(to)) walk(to);
    }
    state.set(id, 2);
  };
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const [from, targets] of out) for (const to of targets) indegree.set(to, (indegree.get(to) ?? 0) + (from === to ? 0 : 1));
  for (const id of [...ids].sort((a, b) => (indegree.get(a)! - indegree.get(b)!) || (a < b ? -1 : 1))) if (!state.has(id)) walk(id);
  const layer = new Map<string, number>(ids.map((id) => [id, 0]));
  const forward = (from: string, to: string): boolean => !back.has(`${from}|${to}`);
  // Relax in rounds: at most as many rounds as there are nodes.
  for (let round = 0; round < ids.length; round += 1) {
    let moved = false;
    for (const [from, targets] of out) for (const to of targets) if (forward(from, to) && layer.get(to)! < layer.get(from)! + 1) {
      layer.set(to, layer.get(from)! + 1);
      moved = true;
    }
    if (!moved) break;
  }
  const byLayer = new Map<number, LayeredNode[]>();
  for (const node of nodes) {
    const l = layer.get(node.id)!;
    byLayer.set(l, [...(byLayer.get(l) ?? []), node]);
  }
  const layers = [...byLayer.keys()].sort((a, b) => a - b);
  // Order within a layer by the mean place of the neighbours already placed, so edges cross less.
  const rank = new Map<string, number>();
  for (const l of layers) {
    const members = byLayer.get(l)!;
    members.sort((a, b) => {
      const score = (id: string): number => {
        const preds = [...out.entries()].filter(([from, targets]) => targets.includes(id) && rank.has(from)).map(([from]) => rank.get(from)!);
        return preds.length === 0 ? Number.MAX_SAFE_INTEGER / 2 : preds.reduce((sum, value) => sum + value, 0) / preds.length;
      };
      return score(a.id) - score(b.id) || (a.id < b.id ? -1 : 1);
    });
    members.forEach((node, index) => rank.set(node.id, index));
  }
  const placed = new Map<string, Placed>();
  let x = 0;
  let height = 0;
  const columnHeights = layers.map((l) => byLayer.get(l)!.reduce((sum, node) => sum + node.h, 0) + (byLayer.get(l)!.length - 1) * options.gapY);
  const tallest = Math.max(0, ...columnHeights);
  layers.forEach((l, index) => {
    const members = byLayer.get(l)!;
    let y = (tallest - columnHeights[index]!) / 2;
    const widest = Math.max(...members.map((node) => node.w));
    for (const node of members) {
      placed.set(node.id, { id: node.id, x, y, w: node.w, h: node.h, layer: l });
      y += node.h + options.gapY;
    }
    height = Math.max(height, y - options.gapY);
    x += widest + options.gapX;
  });
  return { placed, back, width: Math.max(0, x - options.gapX), height };
}

// ---- the system view --------------------------------------------------------------------------

export const SYS_W = 188;
export const SYS_H = 58;

export interface SystemLayout {
  nodes: { node: SystemNode; box: Placed }[];
  edges: { edge: SystemEdge; d: string; label: { x: number; y: number }; back: boolean }[];
  width: number;
  height: number;
}

const cubic = (a: Placed, b: Placed, slot: number, slots: number): { d: string; mid: { x: number; y: number } } => {
  const forward = a.x < b.x;
  const same = a.x === b.x;
  const spread = (slot - (slots - 1) / 2) * 12;
  if (same) {
    const sx = a.x + a.w;
    const sy = a.y + a.h / 2;
    const bow = 38 + slot * 14;
    const ty = b.y + b.h / 2;
    return { d: `M${sx},${sy + spread} C${sx + bow},${sy} ${sx + bow},${ty} ${sx},${ty + spread}`, mid: { x: sx + bow * 0.75, y: (sy + ty) / 2 } };
  }
  const sx = forward ? a.x + a.w : a.x;
  const tx = forward ? b.x : b.x + b.w;
  const sy = a.y + a.h / 2 + spread;
  const ty = b.y + b.h / 2 + spread;
  const bend = Math.max(30, Math.abs(tx - sx) / 2);
  return { d: `M${sx},${sy} C${sx + (forward ? bend : -bend)},${sy} ${tx - (forward ? bend : -bend)},${ty} ${tx},${ty}`, mid: { x: (sx + tx) / 2, y: (sy + ty) / 2 } };
};

export function layoutSystem(nodes: readonly SystemNode[], edges: readonly SystemEdge[]): SystemLayout {
  const { placed, back, width, height } = layered(nodes.map((node) => ({ id: node.id, w: SYS_W, h: SYS_H })), edges, { gapX: 150, gapY: 34 });
  const pairCount = new Map<string, number>();
  const out: SystemLayout['edges'] = [];
  for (const edge of edges) {
    const a = placed.get(edge.from);
    const b = placed.get(edge.to);
    if (a === undefined || b === undefined) continue;
    const key = [edge.from, edge.to].sort().join('|');
    const slot = pairCount.get(key) ?? 0;
    pairCount.set(key, slot + 1);
    const curve = cubic(a, b, slot, 2);
    out.push({ edge, d: curve.d, label: curve.mid, back: back.has(`${edge.from}|${edge.to}`) });
  }
  return { nodes: nodes.flatMap((node) => (placed.has(node.id) ? [{ node, box: placed.get(node.id)! }] : [])), edges: out, width: width + 24, height: height + 8 };
}

// ---- the module view ----------------------------------------------------------------------------

export const MOD_W = 168;
export const MOD_H = 40;

export interface ModuleLayout {
  nodes: { node: ModuleNode; box: Placed }[];
  edges: { edge: ModuleEdge; d: string; back: boolean }[];
  width: number;
  height: number;
}

export function layoutModules(nodes: readonly ModuleNode[], edges: readonly ModuleEdge[]): ModuleLayout {
  const { placed, back, width, height } = layered(nodes.map((node) => ({ id: node.id, w: Math.max(MOD_W, Math.min(280, textWidth(node.label, 12) + 36)), h: MOD_H })), edges, { gapX: 90, gapY: 16 });
  const out: ModuleLayout['edges'] = [];
  for (const edge of edges) {
    const a = placed.get(edge.from);
    const b = placed.get(edge.to);
    if (a === undefined || b === undefined || edge.from === edge.to) continue;
    out.push({ edge, d: cubic(a, b, 0, 1).d, back: back.has(`${edge.from}|${edge.to}`) });
  }
  return { nodes: nodes.flatMap((node) => (placed.has(node.id) ? [{ node, box: placed.get(node.id)! }] : [])), edges: out, width: width + 24, height: height + 8 };
}

// ---- the treemap --------------------------------------------------------------------------------

export interface TreeLeaf {
  id: string;
  name: string;
  path: string;
  value: number;
  data: unknown;
}

export interface TreeCell {
  /** Directory cells have children; file cells carry their leaf. */
  name: string;
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
  leaf?: TreeLeaf;
}

interface Dir {
  name: string;
  path: string;
  children: Map<string, Dir>;
  leaves: TreeLeaf[];
  total: number;
}

function buildTree(leaves: readonly TreeLeaf[]): Dir {
  const root: Dir = { name: '', path: '', children: new Map(), leaves: [], total: 0 };
  for (const leaf of leaves) {
    const parts = leaf.path.split('/');
    let dir = root;
    dir.total += leaf.value;
    for (const part of parts.slice(0, -1)) {
      let child = dir.children.get(part);
      if (child === undefined) {
        child = { name: part, path: dir.path === '' ? part : `${dir.path}/${part}`, children: new Map(), leaves: [], total: 0 };
        dir.children.set(part, child);
      }
      dir = child;
      dir.total += leaf.value;
    }
    dir.leaves.push(leaf);
  }
  // A chain of directories with one child and no files is one cell: `services/payments/src` rather than three nested boxes.
  const collapse = (dir: Dir): Dir => {
    for (const [key, child] of [...dir.children]) {
      let current = collapse(child);
      while (current.leaves.length === 0 && current.children.size === 1) {
        const [only] = [...current.children.values()];
        only!.name = `${current.name}/${only!.name}`;
        current = only!;
      }
      dir.children.delete(key);
      dir.children.set(current.name, current);
    }
    return dir;
  };
  return collapse(root);
}

/** The squarified partition of items (with values) into a rectangle. */
function squarify<T extends { value: number }>(items: readonly T[], x: number, y: number, w: number, h: number): { item: T; x: number; y: number; w: number; h: number }[] {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const result: { item: T; x: number; y: number; w: number; h: number }[] = [];
  if (total <= 0 || w <= 0 || h <= 0) return result;
  const sorted = [...items].sort((a, b) => b.value - a.value);
  let rest = sorted;
  let left = x;
  let top = y;
  let width = w;
  let height = h;
  let remaining = total;
  while (rest.length > 0) {
    const short = Math.min(width, height);
    const scale = (width * height) / remaining;
    const worst = (row: readonly T[]): number => {
      const sum = row.reduce((s, item) => s + item.value * scale, 0);
      const max = Math.max(...row.map((item) => item.value * scale));
      const min = Math.min(...row.map((item) => item.value * scale));
      return Math.max((short * short * max) / (sum * sum), (sum * sum) / (short * short * min));
    };
    let take = 1;
    while (take < rest.length && worst(rest.slice(0, take + 1)) <= worst(rest.slice(0, take))) take += 1;
    const row = rest.slice(0, take);
    const rowSum = row.reduce((s, item) => s + item.value, 0);
    const thickness = (rowSum * scale) / short;
    let offset = 0;
    for (const item of row) {
      const length = (item.value * scale) / thickness;
      if (width >= height) result.push({ item, x: left, y: top + offset, w: thickness, h: length });
      else result.push({ item, x: left + offset, y: top, w: length, h: thickness });
      offset += length;
    }
    if (width >= height) { left += thickness; width -= thickness; } else { top += thickness; height -= thickness; }
    remaining -= rowSum;
    rest = rest.slice(take);
  }
  return result;
}

/** Cells of a nested treemap: a directory is a frame with a title bar, a file a cell inside it. */
export function layoutTreemap(leaves: readonly TreeLeaf[], width: number, height: number): TreeCell[] {
  const cells: TreeCell[] = [];
  const BAR = 15;
  const PAD = 2;
  const place = (dir: Dir, x: number, y: number, w: number, h: number, depth: number): void => {
    const items: { value: number; dir?: Dir; leaf?: TreeLeaf }[] = [
      ...[...dir.children.values()].map((child) => ({ value: child.total, dir: child })),
      ...dir.leaves.map((leaf) => ({ value: leaf.value, leaf })),
    ].filter((item) => item.value > 0);
    for (const part of squarify(items, x, y, w, h)) {
      if (part.item.dir !== undefined) {
        const child = part.item.dir;
        cells.push({ name: child.name, path: child.path, x: part.x, y: part.y, w: part.w, h: part.h, depth });
        const bar = part.h > BAR + 8 && part.w > 40 ? BAR : 0;
        place(child, part.x + PAD, part.y + bar + PAD, Math.max(0, part.w - 2 * PAD), Math.max(0, part.h - bar - 2 * PAD), depth + 1);
      } else {
        const leaf = part.item.leaf!;
        cells.push({ name: leaf.name, path: leaf.path, x: part.x, y: part.y, w: part.w, h: part.h, depth, leaf });
      }
    }
  };
  place(buildTree(leaves), 0, 0, width, height, 0);
  return cells;
}
