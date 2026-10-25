/**
 * The layouts of the diagram blocks, as pure functions of the data the server
 * answers: where a node, a lane or a cell stands, in diagram units (one unit is
 * one CSS pixel at scale 1). Nothing here touches the DOM, so the placement can be
 * tested and the picture checked against it.
 *
 * Why no layout library: the neighbourhood is a layered drawing whose layers are
 * given (what comes in on the left, what goes out on the right) and the treemap
 * is a squarified partition; the C4, sequence, ER, state and deployment views are
 * drawn by LikeC4, archify and Mermaid (views.tsx). A general engine (ELK, dagre)
 * adds a few hundred kilobytes and a worker or wasm to the compiled binary to
 * compute what a few dozen lines compute here; the choice is recorded in
 * docs/changes/madarch-m38l.9/change.md.
 */
import type { DiagramEdge, DiagramMore, DiagramNode, Neighborhood } from '../types.js';

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
        // Beyond the centre a node's neighbours continue on its own side; a node the reader opened shows all of its own,
        // those on the wrong side of it in its own column, the edge drawn as a loop beside it.
        const wrongSide = (col < 0 && direction === 'out') || (col > 0 && direction === 'in');
        if (wrongSide && !grown.has(current)) continue;
        column.set(far, wrongSide ? col : col + (direction === 'out' ? 1 : -1));
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
    const side: 'out' | 'in' = Math.max(from.column, to.column) <= 0 ? 'in' : 'out';
    if (state.off.has(slotOf(edge.relation, side))) continue;
    if (from.column === to.column) {
      const x = from.column <= 0 ? from.x : from.x + NODE_W;
      const bow = from.column <= 0 ? -34 : 34;
      edges.push({ from: edge.from, to: edge.to, relation: edge.relation, count: edge.count, d: `M${x},${from.y + NODE_H / 2} C${x + bow},${from.y + NODE_H / 2} ${x + bow},${to.y + NODE_H / 2} ${x},${to.y + NODE_H / 2}` });
      continue;
    }
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
