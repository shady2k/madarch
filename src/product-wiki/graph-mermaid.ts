/**
 * One diagram model as Mermaid source (madarch-tzte.23.4; decision 0026,
 * "Diagrams"): the model madarch-tzte.23.2 builds, drawn in the Mermaid syntax
 * that keeps everything the model says — a solid arrow stays solid, an
 * assumption or an unresolved end stays dashed, and a table keeps its columns.
 *
 * The box-and-arrow types (C4 context, container and component, module
 * dependencies and state) are drawn as a `flowchart LR`, a sequence as a
 * `sequenceDiagram`, and factual ER models as `erDiagram`:
 *
 * - Mermaid's `erDiagram` draws a table's columns as attributes and carries no
 *   dashed style at all, and its `stateDiagram-v2` has no dashed transition.
 *   0026's bar is that assumptions and unresolved ends are drawn dashed in every
 *   renderer, and both of those syntaxes would draw an agent's reading as a fact,
 *   so an ER assumption is refused with a located diagnostic and its raw list
 *   retained by the answer builder. A machine uses each state as a node and
 *   each transition as an arrow named by its event.
 * - A sequence keeps Mermaid's own sequence syntax, because it is the one that
 *   carries the scenario's order and its lifelines — and it draws a dashed arrow
 *   (`-->>`) as readily as a solid one, so a step the graph does not assert
 *   keeps its dashes.
 *
 * The output is a pure function of the model: the same model gives the same
 * bytes on every machine, the node ids are the elements' own positions in the
 * model's code point order, and nothing here reads the clock.
 */
import { fileURLToPath } from 'node:url';
import type { ShapeDiagram as DiagramModel, ShapeEdge as DiagramEdge, ShapeElement as DiagramElement } from './diagram-shape.js';

/** Mermaid's straight-line flowchart setting, the one the wiki's own Mermaid pages carry (views/mermaid). */
const ER_SOURCE = fileURLToPath(import.meta.url);

/** Keep the actual throwing call site, including its source line when the runtime supplies it. */
function erDiagnostic(message: string): Error {
  const error = new Error(message);
  const site = error.stack?.split('\n').find(line => line.includes(ER_SOURCE) && !line.includes('erDiagnostic'))?.trim();
  return new Error(`${site ?? `${ER_SOURCE} (call-site line unavailable)`}: ${message}`);
}

const STRAIGHT = '%%{init: {"flowchart": {"curve": "linear"}}}%%';

/**
 * Each element kind's node shape, as its opening and closing marks: the kind's
 * own look where Mermaid has one, a plain box otherwise. An end the graph does
 * not hold keeps the plain box and its dashes.
 */
const SHAPES: Readonly<Record<string, readonly [string, string]>> = {
  'deploy-unit': ['{{', '}}'],
  'module': ['(', ')'],
  'repository': ['[[', ']]'],
  'state': ['([', '])'],
  'table': ['[(', ')]'],
  'database': ['[(', ')]'],
  'channel': ['>', ']'],
  'person': ['([', '])'],
  'external': ['[/', '/]'],
  'node': ['[[', ']]'],
  'image': ['(', ')'],
  'domain': ['[[', ']]'],
  'product': ['[[', ']]'],
};
const BOX: readonly [string, string] = ['[', ']'];

/** The class an assumption or an unresolved end carries: Mermaid draws it with a dashed stroke. */
const ASSUMPTION_CLASS = 'assumption';

/** An ER table's label separator: its columns follow its name, in the one line a Mermaid label carries. */
const COLUMN_JOIN = ', ';

/** Mermaid's own named entity codes, and the numeric code every other special character takes. */
const ENTITIES: Readonly<Record<string, string>> = { '"': '#quot;', '&': '#amp;', '<': '#lt;', '>': '#gt;' };

/** One node of the source: the element it stands for and the id Mermaid reads it by. */
interface Node {
  readonly element: DiagramElement;
  readonly id: string;
}

/**
 * The Mermaid source of one diagram model. Every element is a node and every
 * arrow an arrow, in the model's own order; an arrow whose ends the model does
 * not hold is a named error, because a diagram drawn shorter than its model is
 * not the model's diagram.
 */
export function mermaidOfDiagram(model: DiagramModel): string {
  const nodes = nodesOf(model);
  const byId = new Map(nodes.map((node) => [node.element.id, node.id]));
  if (model.type === 'er') {
    const unresolved = nodes.find(({ element }) => element.dashed);
    if (unresolved) throw erDiagnostic(`[unsupported ER assumption]: ${unresolved.element.id}: ${unresolved.element.label}; read the raw element list instead`);
    const lines = ['erDiagram'];
    for (const { element, id } of nodes) {
      lines.push(`  ${id}["${text(element.label)}"] {`);
      for (const column of element.columns ?? []) {
        const rawType = column.dataType ?? 'text';
        const keys = ['PK', 'FK', 'UK'].filter(key => new RegExp(`\\b${key}\\b`).test(rawType));
        const dataType = rawType.replace(/\b(PK|FK|UK)\b/g, '').replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'text';
        const name = column.label.replace(/[^A-Za-z0-9_]/g, '_') || 'column';
        lines.push(`    ${dataType} ${name}${keys.length ? ` ${keys.join(',')}` : ''} "${text(`${column.label} ${rawType}`)}"`);
      }
      lines.push('  }');
    }
    for (const edge of model.edges) {
      const from = byId.get(edge.from), to = byId.get(edge.to);
      if (!from || !to) throw erDiagnostic(`[ER relationship]: missing endpoint ${edge.from} → ${edge.to}`);
      // Mermaid ER dashes mean non-identifying, not an assumption. Never turn a guess into an FK fact.
      if (edge.dashed) throw erDiagnostic(`[unsupported ER assumption]: ${edge.from} → ${edge.to}: ${edge.label}; read the raw relationship list instead`);
      lines.push(`  ${from} ||--o{ ${to} : "${text(edge.label)}"`);
    }
    return `${lines.join('\n')}\n`;
  }
  const arrows = model.edges.map((edge) => arrowOf(model, edge, byId));
  const dashed = nodes.filter((node) => node.element.dashed).map((node) => node.id);
  if (model.type === 'sequence') {
    // A sequence draws its participants in the order the model holds them and its steps in the
    // scenario's own order; the number Mermaid counts is the step the model numbered. A
    // participant's column is narrow, so it reads by the short name of what it stands for and the
    // element list under the diagram keeps the whole label.
    // The steps carry their own numbers (the scenario's order, which the model holds), so Mermaid counts nothing:
    // two numberings side by side are two things a reader has to match up.
    return ['sequenceDiagram', ...nodes.map((node) => `  participant ${node.id} as ${text(participantLabelOf(node.element))}`), ...arrows].join('\n').concat('\n');
  }
  const lines = [STRAIGHT, 'flowchart LR'];
  // An element that holds others is a frame around them (a subgraph); the others stand in the order the model has them.
  const holders = new Set(nodes.map((node) => node.element.parent).filter((parent): parent is string => parent !== undefined));
  const members = (parent: string | undefined): Node[] => nodes.filter((node) => node.element.parent === parent);
  const draw = (node: Node, indent: string): void => {
    if (holders.has(node.element.id)) {
      lines.push(`${indent}subgraph ${node.id}["${text(node.element.label)}"]`);
      for (const member of members(node.element.id)) draw(member, `${indent}  `);
      lines.push(`${indent}end`);
    } else lines.push(`${indent}${nodeBox(node)}`);
  };
  for (const node of members(undefined)) draw(node, '  ');
  for (const arrow of arrows) lines.push(`  ${arrow}`);
  if (dashed.length > 0) {
    lines.push(`  classDef ${ASSUMPTION_CLASS} stroke-dasharray: 5 5`);
    lines.push(`  class ${dashed.join(',')} ${ASSUMPTION_CLASS}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Every element as a node, in the model's order, each with the id Mermaid reads it by. */
function nodesOf(model: DiagramModel): readonly Node[] {
  return model.elements.map((element, at) => ({ element, id: `n${String(at)}` }));
}

/** One node's line: the shape its kind's own look gives it, labelled with its name and, on a table, its columns. */
function nodeBox(node: Node): string {
  const [open, close] = SHAPES[node.element.kind ?? ''] ?? BOX;
  return `${node.id}${open}"${text(labelOf(node.element))}"${close}`;
}

/** What a node reads as: its label and, on an ER table, the columns it holds. */
export function labelOf(element: DiagramElement): string {
  const columns = element.columns ?? [];
  if (columns.length === 0) return element.label;
  return `${element.label}: ${columns.map((column) => (column.dataType === undefined ? column.label : `${column.label} ${column.dataType}`)).join(COLUMN_JOIN)}`;
}

/**
 * One arrow's line: solid where the model's fact is one, dashed where the arrow
 * stands on an assumption or an end the graph does not hold — Mermaid's own
 * `-.->` for a flowchart and `-->>` for a sequence.
 */
function arrowOf(model: DiagramModel, edge: DiagramEdge, byId: ReadonlyMap<string, string>): string {
  const missing = [edge.from, edge.to].filter((end) => byId.has(end) === false);
  if (missing.length > 0) {
    throw new Error(`the ${model.type} diagram's arrow from "${edge.from}" to "${edge.to}" names ${missing.map((end) => `"${end}"`).join(' and ')}, which the model holds no element of: a Mermaid source draws only the model's own elements (src/product-wiki/graph-mermaid.ts)`);
  }
  const [from, to] = [byId.get(edge.from)!, byId.get(edge.to)!];
  const label = text(edgeLabelOf(model, edge));
  if (model.type === 'sequence') return `  ${from}${edge.dashed ? '-->>' : '->>'}${to}: ${label}`;
  return `${from} ${edge.dashed ? '-.->' : '-->'}|"${label}"| ${to}`;
}

/**
 * What a sequence's participant reads as: the short name of the node it stands for — a symbol's
 * qualified name after its file, a table's name after its repository — because a lifeline is a
 * column and not a page's width. The element list under the diagram names the whole label.
 */
export function participantLabelOf(element: DiagramElement): string {
  const label = labelOf(element);
  const hash = label.lastIndexOf('#');
  if (hash >= 0 && hash + 1 < label.length) return label.slice(hash + 1);
  const colon = label.indexOf(':');
  if (colon >= 0 && colon + 1 < label.length) return label.slice(colon + 1);
  return label;
}

/** What an arrow reads as: its own words and, on a sequence, the step the scenario gave it. */
function edgeLabelOf(model: DiagramModel, edge: DiagramEdge): string {
  if (model.type === 'sequence' && edge.step !== undefined) return `step ${String(edge.step)}: ${edge.label}`;
  return edge.label;
}

/**
 * Text inside a Mermaid label: a quote, `&`, `<` and `>` as Mermaid's named
 * entity codes, and `#` (which starts an entity code), `|` (which ends an edge
 * label), a backtick and every control character as its numeric code — the same
 * escaping the wiki's own Mermaid pages keep (src/render/mermaid.ts).
 */
function text(value: string): string {
  return value.replace(/["&<>#|`\u0000-\u001f\u007f]/g, (char) => ENTITIES[char] ?? `#${String(char.codePointAt(0) ?? 0)};`);
}
