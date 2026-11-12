import { PageSection, Paragraph, Text } from '@/components/ui/typography.js';
import { GraphViewport, GraphCanvas, GraphBox, GraphMetadata, GraphEdges, GraphEdge, graphLinkClass } from '@/components/ui/graph.js';
/** Shared catalogue graph: manifest dependencies, fill states, and kind inspection. */
import { useEffect, useRef, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { addressOfKind } from './routes.js';
import { KLink } from './blocks.js';
import { Badge } from '@/components/ui/badge.js';
import type { CatalogKindView, CatalogView } from './types.js';

/** One entity of the graph: the kind, its dependencies and the depths it stands at. */
export interface GraphNode {
  readonly kind: CatalogKindView;
  readonly derivesFrom: readonly string[];
  readonly depth: number;
}

/**
 * The kinds by the longest chain of their dependencies: a kind stands one column after the last of the kinds it needs.
 * A kind whose dependency is not declared in this catalogue (an edited manifest, a finding) stands at its own depth and
 * keeps the dependency in its row, said and not dropped; a cycle leaves the kinds it walks at depth 0 and is named.
 */
export function graphLayers(kinds: readonly CatalogKindView[]): { nodes: GraphNode[]; layers: string[][]; cycles: string[] } {
  const byKind = new Map(kinds.map((kind) => [kind.kind, kind] as const));
  const depth = new Map<string, number>();
  const active: string[] = [];
  const cycles = new Set<string>();
  const visit = (kind: string): number => {
    const held = depth.get(kind);
    if (held !== undefined) return held;
    if (active.includes(kind)) {
      cycles.add([...active.slice(active.indexOf(kind)), kind].join(' -> '));
      return 0;
    }
    active.push(kind);
    let deepest = 0;
    for (const dependency of byKind.get(kind)?.derivesFrom ?? []) {
      if (!byKind.has(dependency)) continue;
      deepest = Math.max(deepest, visit(dependency) + 1);
    }
    active.pop();
    depth.set(kind, deepest);
    return deepest;
  };
  const nodes = kinds.map((kind) => ({ kind, derivesFrom: kind.derivesFrom ?? [], depth: visit(kind.kind) }))
    .sort((left, right) => left.depth - right.depth || (left.kind.kind < right.kind.kind ? -1 : left.kind.kind > right.kind.kind ? 1 : 0));
  const count = nodes.reduce((sum, node) => Math.max(sum, node.depth + 1), 0);
  const layers: string[][] = Array.from({ length: count }, () => []);
  for (const node of nodes) layers[node.depth]!.push(node.kind.kind);
  return { nodes, layers, cycles: [...cycles].sort() };
}

/** What one entity's fill shows on the graph: the run's own step where it has one, the graph's outcome otherwise. */
export type GraphState = 'waiting' | 'running' | 'done' | 'partial' | 'failed' | 'never';

/** The store's turn states that mean the kind's unit is being worked on now. */
const RUNNING_TURNS = new Set(['leased', 'running', 'draft', 'validating']);
/** The store's turn states that mean the kind's unit stands in the run's queue. */
const WAITING_TURNS = new Set(['planned', 'ready', 'waiting_children', 'retry_wait']);
/** The store's turn states that mean the kind's last turn did not publish. */
const FAILED_TURNS = new Set(['failed', 'blocked', 'cancelled']);

/**
 * One entity's state on the graph (madarch-stm0.6): the newest turn's step while a fill runs or after it, and the
 * graph's own outcome when the kind has no turn. A kind with no turn and nothing in the graph is waiting while a run
 * works and never filled after it. No list of kinds stands here: the turn and the outcome are the catalogue's answer.
 */
export function graphStateOf(kind: CatalogKindView, filling: boolean): GraphState {
  const turn = kind.turn;
  if (turn !== undefined) {
    if (RUNNING_TURNS.has(turn)) return 'running';
    if (WAITING_TURNS.has(turn)) return 'waiting';
    if (FAILED_TURNS.has(turn)) return 'failed';
    if (turn === 'published') return 'done';
  }
  if (kind.state === 'filled') return 'done';
  if (kind.state === 'never') return filling ? 'waiting' : 'never';
  return 'partial';
}

/** One box in the graph: its entity's name, its state and the kinds it needs. */
const BOX_WIDTH = 208;
const BOX_HEIGHT = 46;
const GAP = 14;
const COLUMN = BOX_WIDTH + 56;

/** The chosen kind and its transitive dependencies and dependents, without unrelated siblings. */
export function relatedKinds(kinds: readonly CatalogKindView[], chosen: string | null): Set<string> {
  const byKind = new Map(kinds.map((kind) => [kind.kind, kind]));
  const related = new Set<string>();
  if (chosen === null || !byKind.has(chosen)) return related;
  const dependents = new Map<string, string[]>();
  for (const kind of kinds) for (const dependency of kind.derivesFrom ?? []) {
    const held = dependents.get(dependency) ?? [];
    held.push(kind.kind);
    dependents.set(dependency, held);
  }
  const walk = (neighbors: (id: string) => readonly string[]): void => {
    const seen = new Set<string>();
    const pending = [chosen];
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (seen.has(id) || !byKind.has(id)) continue;
      seen.add(id);
      related.add(id);
      pending.push(...neighbors(id));
    }
  };
  walk((id) => byKind.get(id)?.derivesFrom ?? []);
  walk((id) => dependents.get(id) ?? []);
  return related;
}

export interface KindGraphProps {
  readonly catalog: CatalogView;
  readonly filling?: boolean;
  readonly chosen?: string | null;
  readonly highlighted?: ReadonlySet<string>;
}

export function KindGraph({ catalog, filling = false, chosen = null, highlighted }: KindGraphProps): ReactElement {
  const { t, i18n } = useTranslation();
  const viewport = useRef<HTMLDivElement>(null);
  const language = (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  const { nodes, layers, cycles } = graphLayers(catalog.kinds);
  const active = new Set([...relatedKinds(catalog.kinds, chosen), ...highlighted ?? []]);
  const place = new Map(nodes.map((node) => {
    const column = layers[node.depth]!;
    return [node.kind.kind, { x: node.depth * COLUMN + 8, y: column.indexOf(node.kind.kind) * (BOX_HEIGHT + GAP) + 8 }] as const;
  }));
  const height = Math.max(...layers.map((layer) => layer.length), 1) * (BOX_HEIGHT + GAP) + 16;
  const width = Math.max(layers.length, 1) * COLUMN;
  const name = (kind: CatalogKindView): string => kind.labels?.[language]?.many ?? kind.kind;
  const chosenX = chosen === null ? undefined : place.get(chosen)?.x;
  useEffect(() => {
    const frame = viewport.current;
    if (frame === null || chosenX === undefined) return;
    frame.scrollLeft = Math.max(0, chosenX + BOX_WIDTH / 2 - frame.clientWidth / 2);
  }, [chosen, chosenX]);
  return (
    <PageSection data-testid="kind-graph">
      {cycles.length > 0 && <Paragraph className="m-0 text-small" role="alert" data-testid="dependencies-cycle">{t('knowledge.dependencies.cycle', { cycle: cycles.join('; ') })}</Paragraph>}
      {/* The graph is its own frame: on a phone it scrolls sideways inside the page, and the page itself never does. */}
      <GraphViewport ref={viewport} data-testid="dependencies-graph">
        <GraphCanvas width={width} height={height}>
          <GraphEdges width={width} height={height}>
            {nodes.flatMap((node) => node.derivesFrom.flatMap((dependency) => {
              const from = place.get(dependency);
              const to = place.get(node.kind.kind);
              if (from === undefined || to === undefined) return [];
              const x1 = from.x + BOX_WIDTH;
              const y1 = from.y + BOX_HEIGHT / 2;
              const x2 = to.x;
              const y2 = to.y + BOX_HEIGHT / 2;
              const middle = (x1 + x2) / 2;
              return [<GraphEdge key={`${dependency}\0${node.kind.kind}`} d={`M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y2}, ${x2} ${y2}`} data-active={String(active.has(dependency) && active.has(node.kind.kind))} active={active.has(dependency) && active.has(node.kind.kind)} data-edge={`${dependency}->${node.kind.kind}`} />];
            }))}
          </GraphEdges>
          {nodes.map((node) => (
            <GraphBox
              key={node.kind.kind}
              active={active.has(node.kind.kind)} x={place.get(node.kind.kind)?.x} y={place.get(node.kind.kind)?.y} width={BOX_WIDTH} height={BOX_HEIGHT}
              data-testid="dependency-node"
              data-kind={node.kind.kind}
              data-state={graphStateOf(node.kind, filling)}
              data-turn={node.kind.turn ?? ''}
              data-depth={node.depth}
              data-chosen={String(chosen === node.kind.kind)}
              data-related={String(active.has(node.kind.kind))}
              data-highlighted={String(active.has(node.kind.kind))}
            >
              <KLink href={addressOfKind(node.kind.kind)} testId={`dependency-link-${node.kind.kind}`} className={graphLinkClass}>
                <Text className="block truncate">{name(node.kind)}</Text>
                <GraphMetadata>
                  <Text data-testid="dependency-state">{t(`knowledge.catalogueState.${graphStateOf(node.kind, filling)}`)}</Text>
                  <Badge variant="outline" data-testid="dependency-count">{node.kind.count}</Badge>
                </GraphMetadata>
              </KLink>
            </GraphBox>
          ))}
        </GraphCanvas>
      </GraphViewport>
    </PageSection>
  );
}
