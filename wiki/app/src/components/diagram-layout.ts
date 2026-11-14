/**
 * The layout of a page's diagram (decision 0036, section 7): the entity in the middle, what leads to it on the left,
 * what it leads to on the right, one group per relation. An edge and its inverse are one line — a neighbour reached
 * both ways stands once, on the side its outgoing relation puts it. More than `aggregateAbove` neighbours of one kind
 * become one box that says how many. Nothing here touches the DOM, so the picture is checked against a pure function.
 */
import type { DrawnEdge, DrawnNode } from './ui/drawing.js';

/** One entity at the other end of a relation, as the page read it. */
export interface Neighbour {
  readonly relation: string;
  readonly direction: 'in' | 'out';
  readonly entity: { readonly id: string; readonly kind: string; readonly label: string; readonly template: string };
}

export interface DiagramInput {
  readonly subject: { readonly id: string; readonly kind: string; readonly label: string };
  readonly outgoing: readonly Neighbour[];
  readonly backlinks: readonly Neighbour[];
  readonly aggregateAbove: number;
}

export interface DiagramGroup {
  readonly label: string;
  readonly direction: 'in' | 'out';
  readonly x: number;
  readonly y: number;
}

export interface DiagramLayout {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly DrawnNode[];
  readonly edges: readonly DrawnEdge[];
  readonly groups: readonly DiagramGroup[];
  readonly mermaid: string;
}

const NODE_W = 196;
const NODE_H = 34;
const COLUMN_GAP = 110;
const ROW_GAP = 6;
const HEADER_H = 18;
const GROUP_GAP = 14;
const MARGIN = 12;
const LEFT_X = MARGIN;
const CENTRE_X = LEFT_X + NODE_W + COLUMN_GAP;
const RIGHT_X = CENTRE_X + NODE_W + COLUMN_GAP;

/** The relation a line is labelled with: an inverse is its edge's name, so the two directions of one edge read once. */
export function relationBase(relation: string): string {
  return relation.endsWith('Of') ? relation.slice(0, -2) : relation;
}

const WIDE = new Set([...'mwMW@']);
const NARROW = new Set([...'iljtf.,:;|!\'` ']);

/** The width of a text in the diagram's 12 px face: a measured average, with a margin. */
export function textWidth(text: string, size = 12): number {
  let width = 0;
  for (const char of text) {
    if (NARROW.has(char)) width += 0.36;
    else if (WIDE.has(char)) width += 0.9;
    else if (char >= 'A' && char <= 'Z') width += 0.68;
    else if (char.charCodeAt(0) > 0x2e80) width += 1.05;
    else width += 0.56;
  }
  return Math.ceil(width * size) + 2;
}

/** A text cut to a width, ending with an ellipsis; the whole text stays in the box's title. */
export function fitText(text: string, width: number, size = 12): string {
  if (textWidth(text, size) <= width) return text;
  let cut = text;
  while (cut.length > 1 && textWidth(`${cut}…`, size) > width) cut = cut.slice(0, -1);
  return `${cut}…`;
}

interface Row {
  readonly key: string;
  readonly label: string;
  readonly title: string;
  readonly caption?: string;
  readonly href?: string;
}

interface Group {
  readonly relation: string;
  readonly direction: 'in' | 'out';
  readonly rows: Row[];
}

/** The neighbours of one side, one row per entity, grouped by relation and aggregated by kind above the bound. */
function groupsOf(neighbours: readonly Neighbour[], direction: 'in' | 'out', aggregateAbove: number, bothWays: ReadonlySet<string>): Group[] {
  const byRelation = new Map<string, Neighbour[]>();
  for (const neighbour of neighbours) {
    if (direction === 'in' && bothWays.has(neighbour.entity.id)) continue;
    const relation = relationBase(neighbour.relation);
    byRelation.set(relation, [...(byRelation.get(relation) ?? []), neighbour]);
  }
  const groups: Group[] = [];
  for (const relation of [...byRelation.keys()].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))) {
    const held = byRelation.get(relation)!;
    const byKind = new Map<string, Neighbour[]>();
    for (const neighbour of held) byKind.set(neighbour.entity.kind, [...(byKind.get(neighbour.entity.kind) ?? []), neighbour]);
    const rows: Row[] = [];
    for (const [kind, sameKind] of [...byKind.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
      if (sameKind.length > aggregateAbove) {
        rows.push({ key: `${relation}:${kind}`, label: kind, title: sameKind.map((one) => one.entity.label).join(', '), caption: String(sameKind.length) });
        continue;
      }
      for (const neighbour of [...sameKind].sort((left, right) => (left.entity.label < right.entity.label ? -1 : left.entity.label > right.entity.label ? 1 : 0))) {
        rows.push({ key: `${relation}:${neighbour.entity.id}`, label: fitText(neighbour.entity.label, NODE_W - 16), title: neighbour.entity.label, href: `/e/${encodeURIComponent(neighbour.entity.kind)}/${encodeURIComponent(neighbour.entity.id)}` });
      }
    }
    groups.push({ relation, direction, rows });
  }
  return groups;
}

/** Where one column's groups stand and how tall the column is. */
function placeGroups(groups: readonly Group[]): { placed: { group: Group; y: number; headingY: number; rows: { row: Row; y: number }[] }[]; height: number } {
  let y = 0;
  const placed = groups.map((group) => {
    const headingY = y;
    y += HEADER_H;
    const rows = group.rows.map((row) => {
      const at = y;
      y += NODE_H + ROW_GAP;
      return { row, y: at };
    });
    y += GROUP_GAP;
    return { group, y, headingY, rows };
  });
  return { placed, height: y };
}

/** The whole picture: the two columns of relations, the entity between them, and the Mermaid form of the same graph. */
export function layoutDiagram(input: DiagramInput): DiagramLayout {
  const bothWays = new Set<string>();
  const outgoingIds = new Set(input.outgoing.map((one) => one.entity.id));
  for (const neighbour of input.backlinks) if (outgoingIds.has(neighbour.entity.id)) bothWays.add(neighbour.entity.id);
  const left = placeGroups(groupsOf(input.backlinks, 'in', input.aggregateAbove, bothWays));
  const right = placeGroups(groupsOf(input.outgoing, 'out', input.aggregateAbove, bothWays));
  const columns = Math.max(left.height, right.height, NODE_H + 2 * HEADER_H);
  const centreY = Math.round((columns - NODE_H) / 2);
  const subject: DrawnNode = {
    key: 'subject',
    x: CENTRE_X,
    y: centreY,
    width: NODE_W,
    height: NODE_H,
    label: fitText(input.subject.label, NODE_W - 16),
    title: input.subject.label,
    caption: input.subject.kind,
    emphasis: true,
  };
  const nodes: DrawnNode[] = [subject];
  const edges: DrawnEdge[] = [];
  const groups: DiagramGroup[] = [];
  const lines: string[] = [];
  for (const side of [left, right]) {
    for (const placed of side.placed) {
      groups.push({ label: placed.group.relation, direction: placed.group.direction, x: placed.group.direction === 'in' ? LEFT_X : RIGHT_X, y: placed.headingY });
      // A row of one relation reads its relation once: the group's heading names it, the line says nothing more.
      const heading = placed.group.relation;
      for (const { row, y } of placed.rows) {
        nodes.push({
          key: row.key,
          x: placed.group.direction === 'in' ? LEFT_X : RIGHT_X,
          y,
          width: NODE_W,
          height: NODE_H,
          label: row.label,
          ...(row.caption === undefined ? {} : { caption: row.caption }),
          ...(row.href === undefined ? {} : { href: row.href }),
          title: row.title,
        });
        const from = placed.group.direction === 'in' ? { x: LEFT_X + NODE_W, y: y + NODE_H / 2 } : { x: CENTRE_X + NODE_W, y: centreY + NODE_H / 2 };
        const to = placed.group.direction === 'in' ? { x: CENTRE_X, y: centreY + NODE_H / 2 } : { x: RIGHT_X, y: y + NODE_H / 2 };
        edges.push({ key: `${row.key}:${heading}`, from, to, ...(row.caption === undefined ? { label: heading } : {}) });
        if (row.href !== undefined) {
          lines.push(placed.group.direction === 'in' ? `  ${identifier(row.key)} -->|${heading}| subject` : `  subject -->|${heading}| ${identifier(row.key)}`);
          lines.push(`  ${identifier(row.key)}["${row.label.replaceAll('"', "'")}"]`);
        } else {
          lines.push(`  ${identifier(row.key)}["${row.label.replaceAll('"', "'")} (${row.caption ?? '0'})"]`);
          lines.push(placed.group.direction === 'in' ? `  ${identifier(row.key)} -.-> subject` : `  subject -.-> ${identifier(row.key)}`);
        }
      }
    }
  }
  const mermaid = ['flowchart LR', `  subject["${input.subject.label.replaceAll('"', "'")}"]`, ...lines].join('\n');
  return {
    width: RIGHT_X + NODE_W + MARGIN,
    height: Math.max(columns, centreY + NODE_H) + MARGIN,
    nodes,
    edges,
    groups,
    mermaid,
  };
}

/** A Mermaid node id for a row key: the graph's ids are opaque, Mermaid's are not. */
function identifier(key: string): string {
  return `n${[...key].map((char) => char.codePointAt(0)!.toString(36)).join('')}`;
}
