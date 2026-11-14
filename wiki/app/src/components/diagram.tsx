/**
 * The page's diagram (decision 0036, section 7): the entity in the middle, its relations both ways drawn where the layout
 * puts them, a press on a box walking to that entity, and the same graph as Mermaid text beside the picture.
 */
import type { ReactElement } from 'react';
import { Disclosure } from './ui/data.js';
import { DrawnBox, DrawnLabel, DrawnLine, Drawing } from './ui/drawing.js';
import { Muted, Pre } from './ui/typography.js';
import { Stack } from './ui/layout.js';
import { layoutDiagram, type Neighbour } from './diagram-layout.js';
import { at } from './format.js';
import type { SectionContext } from './types.js';

/** One relation connection's rows as the layout's neighbours. */
function neighboursOf(connection: unknown, direction: 'in' | 'out'): Neighbour[] {
  if (typeof connection !== 'object' || connection === null) return [];
  const edges = (connection as Record<string, unknown>)['edges'];
  if (!Array.isArray(edges)) return [];
  const out: Neighbour[] = [];
  for (const edge of edges) {
    const node = (typeof edge === 'object' && edge !== null ? (edge as Record<string, unknown>)['node'] : undefined) as Record<string, unknown> | undefined;
    if (node === undefined) continue;
    const entity = (node[direction === 'in' ? 'from' : 'to'] ?? undefined) as Record<string, unknown> | undefined;
    if (entity === undefined) continue;
    const relation = node['relation'];
    const id = entity['id'];
    const kind = entity['kind'];
    const label = entity['label'];
    if (typeof relation !== 'string' || typeof id !== 'string' || typeof kind !== 'string' || typeof label !== 'string') continue;
    out.push({ relation, direction, entity: { id, kind, label, template: String(entity['template'] ?? '') } });
  }
  return out;
}

export function DiagramSection({ context }: { readonly context: SectionContext }): ReactElement {
  const data = at(context.data, context.section.params['path']);
  const held = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  const subject = {
    id: String(held['id'] ?? ''),
    kind: String(held['kind'] ?? ''),
    label: String(held['label'] ?? ''),
  };
  const aggregateAbove = typeof context.section.params['aggregateAbove'] === 'number' ? context.section.params['aggregateAbove'] : 12;
  const layout = layoutDiagram({
    subject,
    outgoing: neighboursOf(held['outgoing'], 'out'),
    backlinks: neighboursOf(held['backlinks'], 'in'),
    aggregateAbove,
  });
  if (layout.nodes.length === 1) {
    return <Muted>{'—'}</Muted>;
  }
  return (
    <Stack gap={2}>
      <Drawing width={layout.width} height={layout.height} label={subject.label}>
        {[
          ...layout.groups.map((group) => <DrawnLabel key={`${group.direction}:${group.label}`} x={group.x} y={group.y + 12}>{group.label}</DrawnLabel>),
          ...layout.edges.map((edge) => <DrawnLine key={edge.key} edge={edge} />),
          ...layout.nodes.map((node) => <DrawnBox key={node.key} node={{ ...node, ...(node.href === undefined ? {} : { href: context.base + node.href }) }} onOpen={(href) => context.open(href.startsWith(context.base) ? href.slice(context.base.length) : href)} />),
        ]}
      </Drawing>
      <Disclosure summary="Mermaid">
        <Pre>{layout.mermaid}</Pre>
      </Disclosure>
    </Stack>
  );
}
