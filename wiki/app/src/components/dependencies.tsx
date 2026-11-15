/**
 * The catalogue's dependency graph (madarch-64o5.124): the kinds the product declares, each an entity that stands
 * after the kinds it needs filled first. The section reads the catalogue's own `derivesFrom` links from the template's
 * GraphQL answer and draws them with the kit's Mermaid picture, so no page names a kind or lays a node out by hand.
 */
import { useTranslation } from 'react-i18next';
import type { ReactElement } from 'react';
import { byCodePoint } from '../../../../src/model/order.js';
import { Paragraph, Stack } from './ui/typography.js';
import { MermaidPane } from './diagram-panes/mermaid-pane.js';
import type { MermaidAnswer } from './diagram-types.js';
import type { SectionContext } from './types.js';

interface LinkNode {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly label?: unknown;
}

interface LinkEdge {
  readonly node?: LinkNode;
}

interface DependenciesAnswer {
  readonly name?: unknown;
  readonly label?: unknown;
  readonly kinds?: readonly { readonly id?: unknown; readonly name?: unknown; readonly label?: unknown; readonly derivesFrom?: readonly LinkNode[] }[];
  readonly derivesFrom?: { readonly edges?: readonly LinkEdge[] };
  readonly derivedBy?: { readonly edges?: readonly LinkEdge[] };
}

interface GraphNode {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly href?: string;
}

/** Quote one Mermaid label: the graph's words are product data, not syntax. */
function quoted(label: string): string {
  return `"${label.replaceAll('"', '\\"')}"`;
}

/** One entry of a `derivesFrom` connection, when the answer holds the fields the graph needs. */
function linkNode(edge: LinkEdge | undefined): GraphNode | undefined {
  const node = edge?.node;
  if (typeof node?.name !== 'string' || node.name === '') return undefined;
  return {
    id: typeof node.id === 'string' ? node.id : node.name,
    name: node.name,
    label: typeof node.label === 'string' && node.label !== '' ? node.label : node.name,
    ...(typeof node.id === 'string' ? { href: `/e/catalogue/${encodeURIComponent(node.id)}` } : {}),
  };
}

/** The whole catalogue, or one kind's own dependencies and dependants. */
function graphOf(data: DependenciesAnswer, focus: boolean): { nodes: GraphNode[]; edges: readonly (readonly [string, string])[] } {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, readonly [string, string]>();
  const add = (node: GraphNode): void => { nodes.set(node.id, node); };
  const link = (from: GraphNode, to: GraphNode): void => {
    add(from); add(to);
    edges.set(`${from.id}\u0000${to.id}`, [from.id, to.id]);
  };
  if (focus) {
    const self = typeof data.name === 'string' && data.name !== ''
      ? { id: data.name, name: data.name, label: typeof data.label === 'string' && data.label !== '' ? data.label : data.name }
      : undefined;
    if (self !== undefined) {
      add(self);
      for (const edge of data.derivesFrom?.edges ?? []) {
        const dependency = linkNode(edge);
        if (dependency !== undefined) link(dependency, self);
      }
      for (const edge of data.derivedBy?.edges ?? []) {
        const dependent = linkNode(edge);
        if (dependent !== undefined) link(self, dependent);
      }
    }
  } else {
    for (const node of data.kinds ?? []) {
      if (typeof node?.name !== 'string' || node.name === '') continue;
      const self: GraphNode = {
        id: typeof node.id === 'string' ? node.id : node.name,
        name: node.name,
        label: typeof node.label === 'string' && node.label !== '' ? node.label : node.name,
        ...(typeof node.id === 'string' ? { href: `/e/catalogue/${encodeURIComponent(node.id)}` } : {}),
      };
      add(self);
      for (const dependencyNode of node.derivesFrom ?? []) {
        const dependency = linkNode({ node: dependencyNode });
        if (dependency !== undefined) link(dependency, self);
      }
    }
  }
  return {
    nodes: [...nodes.values()].sort((left, right) => byCodePoint(left.name, right.name)),
    edges: [...edges.values()].sort((left, right) => byCodePoint(left[0], right[0]) || byCodePoint(left[1], right[1])),
  };
}

/** How many columns the edges need: every node one after the deepest prerequisite that feeds it. */
function layersOf(graph: { readonly nodes: readonly GraphNode[]; readonly edges: readonly (readonly [string, string])[] }): number {
  const depth = new Map<string, number>(graph.nodes.map((node) => [node.id, 0] as const));
  for (let pass = 0; pass < graph.nodes.length; pass++) {
    let changed = false;
    for (const [from, to] of graph.edges) {
      const next = Math.min(graph.nodes.length, (depth.get(from) ?? 0) + 1);
      if ((depth.get(to) ?? 0) < next) { depth.set(to, next); changed = true; }
    }
    if (!changed) break;
  }
  return Math.max(1, ...depth.values()) + 1;
}

/** The Mermaid source of the dependency graph: prerequisite on the left, the kind it feeds on the right. */
function sourceOf(graph: { nodes: readonly GraphNode[]; edges: readonly (readonly [string, string])[] }): string {
  const ids = new Map(graph.nodes.map((node, index) => [node.id, `n${String(index)}`] as const));
  const lines = ['flowchart LR', ...graph.nodes.map((node) => `  ${ids.get(node.id)!}[${quoted(node.label)}]`)];
  for (const [from, to] of graph.edges) lines.push(`  ${ids.get(from)!} --> ${ids.get(to)!}`);
  for (const node of graph.nodes) {
    if (node.href !== undefined) lines.push(`  click ${ids.get(node.id)!} ${quoted(node.href)}`);
  }
  return lines.join('\n');
}

export function DependenciesSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t } = useTranslation();
  const focus = context.section.params['focus'] === true;
  const graph = graphOf((context.data ?? {}) as DependenciesAnswer, focus);
  if (graph.nodes.length === 0) return <Paragraph data-testid="dependencies-empty">{t('knowledge.dependencies.none')}</Paragraph>;
  const source = sourceOf(graph);
  return (
    <Stack data-testid="dependencies-graph">
      <Paragraph className="text-small text-muted" data-testid="dependencies-count">{t('knowledge.dependencies.count', { kinds: graph.nodes.length, layers: layersOf(graph) })}</Paragraph>
      <MermaidPane answer={{ source } as MermaidAnswer} open={(path) => { context.open(path); }} />
    </Stack>
  );
}
