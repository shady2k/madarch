import { PageSection, Paragraph, Text } from '@/components/ui/typography.js';
import { GraphViewport, GraphCanvas, GraphBox, GraphMetadata, GraphEdges, GraphEdge, graphLinkClass } from '@/components/ui/graph.js';
/** Shared catalogue graph: manifest dependencies, fill states, and kind inspection. */
import { useEffect, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { addressOfKind } from './routes.js';
import { KLink } from './blocks.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Stack } from '@/components/ui/typography.js';
import { areaOf } from './catalog-area.js';
import { Badge } from '@/components/ui/badge.js';
import type { CatalogKindView, CatalogView } from './types.js';

/** One entity of the graph: the kind, its dependencies and the depths it stands at. */
export interface GraphNode {
  readonly kind: CatalogKindView;
  readonly dependsOn: readonly string[];
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
    for (const dependency of byKind.get(kind)?.dependsOn ?? []) {
      if (!byKind.has(dependency)) continue;
      deepest = Math.max(deepest, visit(dependency) + 1);
    }
    active.pop();
    depth.set(kind, deepest);
    return deepest;
  };
  const nodes = kinds.map((kind) => ({ kind, dependsOn: kind.dependsOn ?? [], depth: visit(kind.kind) }))
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
const BOX_HEIGHT = 96;
const SECTION_HEIGHT = 96;
const SECTION_ROW = SECTION_HEIGHT + 32;
const GAP = 14;
const COLUMN = BOX_WIDTH + 56;

/** Bounded dependency and dependent walks do not include unrelated siblings. */
export function relatedKinds(kinds: readonly CatalogKindView[], chosen: string | null, steps: 1 | 2 = 1): Set<string> {
  const byKind = new Map(kinds.map((kind) => [kind.kind, kind]));
  const related = new Set<string>();
  if (chosen === null || !byKind.has(chosen)) return related;
  const dependents = new Map<string, string[]>();
  for (const kind of kinds) for (const dependency of kind.dependsOn ?? []) {
    dependents.set(dependency, [...dependents.get(dependency) ?? [], kind.kind]);
  }
  for (const neighbors of [(id: string) => byKind.get(id)?.dependsOn ?? [], (id: string) => dependents.get(id) ?? []]) {
    let pending = [chosen];
    for (let step = 0; step <= steps; step++) {
      for (const id of pending) if (byKind.has(id)) related.add(id);
      pending = pending.flatMap(neighbors);
    }
  }
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
  const language = (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  const [selected, setSelected] = useState(chosen);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [steps, setSteps] = useState<1 | 2>(1);
  useEffect(() => { setSelected(chosen); }, [chosen]);
  const name = (kind: CatalogKindView): string => kind.labels?.[language]?.many ?? t('knowledge.kindDetails.untranslatedKind');
  const sectionOf = (kind: CatalogKindView): string => {
    let id = areaOf(catalog.groups, kind);
    const seen = new Set<string>();
    while (!seen.has(id)) {
      seen.add(id);
      const parent = catalog.groups.find((group) => group.group === id)?.parent;
      if (parent === undefined) break;
      id = parent;
    }
    return id;
  };
  const sections = [...new Set(catalog.kinds.map(sectionOf))].map((id) => ({
    id, kinds: catalog.kinds.filter((kind) => sectionOf(kind) === id),
    name: catalog.groups.find((group) => group.group === id)?.labels[language] ?? (id || t('knowledge.fillSetup.other')),
  }));
  const related = relatedKinds(catalog.kinds, selected, steps);
  const visible = selected === null && highlighted !== undefined ? catalog.kinds.filter((kind) => highlighted.has(kind.kind)) : selected === null ? catalog.kinds.filter((kind) => sectionOf(kind) === expanded) : catalog.kinds.filter((kind) => related.has(kind.kind));
  const { nodes, layers, cycles } = graphLayers(visible);
  const expandedRow = Math.floor(sections.findIndex((section) => section.id === expanded) / 3);
  const sectionY = (index: number): number => Math.floor(index / 3) * SECTION_ROW + 8
    + (expandedRow >= 0 && Math.floor(index / 3) > expandedRow ? visible.length * (BOX_HEIGHT + GAP) : 0);
  const boxes = selected === null && highlighted === undefined ? sections.flatMap((section, index) => [
    { id: `section:${section.id}`, section, kind: undefined, x: (index % 3) * COLUMN + 8, y: sectionY(index), height: SECTION_HEIGHT },
    ...visible.filter((kind) => sectionOf(kind) === section.id).map((kind, row) => ({ id: kind.kind, section: undefined, kind, x: (index % 3) * COLUMN + 8, y: sectionY(index) + SECTION_ROW + row * (BOX_HEIGHT + GAP), height: BOX_HEIGHT })),
  ]) : nodes.map((node) => ({ id: node.kind.kind, section: undefined, kind: node.kind, x: node.depth * COLUMN + 8, y: layers[node.depth]!.indexOf(node.kind.kind) * (BOX_HEIGHT + GAP) + 8, height: BOX_HEIGHT }));
  const place = new Map(boxes.map((box) => [box.id, box]));
  const byKind = new Map(catalog.kinds.map((kind) => [kind.kind, kind]));
  const edges = new Map<string, { from: string; to: string; count: number }>();
  for (const kind of catalog.kinds) for (const dependency of kind.dependsOn ?? []) {
    const source = byKind.get(dependency);
    if (source === undefined) continue;
    const from = place.has(dependency) ? dependency : `section:${sectionOf(source)}`;
    const to = place.has(kind.kind) ? kind.kind : `section:${sectionOf(kind)}`;
    if (from === to || !place.has(from) || !place.has(to)) continue;
    const id = `${from}->${to}`;
    edges.set(id, { from, to, count: (edges.get(id)?.count ?? 0) + 1 });
  }
  const width = Math.max(...boxes.map((box) => box.x + COLUMN), COLUMN);
  const edgeLabels: { x: number; y: number }[] = [];
  const height = Math.max(...boxes.map((box) => box.y + box.height + 24), 240);
  return <PageSection data-testid="kind-graph">
    <Stack className="mb-3 flex flex-wrap items-center gap-2">
      <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t('knowledge.dependencies.search')} placeholder={t('knowledge.dependencies.search')} data-testid="graph-search" className="max-w-full sm:w-72" />
      <Button size="sm" onClick={() => { setSelected(null); setExpanded(null); setQuery(''); }}>{t('knowledge.dependencies.overview')}</Button>
      {selected !== null && <><Button size="sm" aria-pressed={steps === 1} onClick={() => setSteps(1)}>{t('knowledge.dependencies.oneStep')}</Button><Button size="sm" aria-pressed={steps === 2} data-testid="graph-two-steps" onClick={() => setSteps(2)}>{t('knowledge.dependencies.twoSteps')}</Button></>}
    </Stack>
    {query.trim() !== '' && <Stack className="mb-3 flex max-h-48 flex-wrap gap-2 overflow-auto" data-testid="graph-search-results">{catalog.kinds.filter((kind) => `${kind.kind} ${name(kind)}`.toLowerCase().includes(query.toLowerCase())).map((kind) => <Button key={kind.kind} size="sm" onClick={() => { setSelected(kind.kind); setQuery(''); }}>{name(kind)}</Button>)}</Stack>}
    {cycles.length > 0 && <Paragraph role="alert" data-testid="dependencies-cycle">{t('knowledge.dependencies.cycle', { cycle: cycles.join('; ') })}</Paragraph>}
    <GraphViewport focus={selected === null || !place.has(selected) ? undefined : { ...place.get(selected)!, width: BOX_WIDTH }} className={selected === null ? undefined : 'max-h-96'} data-testid="dependencies-graph" key={`${selected ?? ''}:${expanded ?? ''}:${steps}`}>
      <GraphCanvas width={width} height={height}>
        <GraphEdges width={width} height={height}>
          {[...edges].map(([id, edge]) => {
            const from = place.get(edge.from)!; const to = place.get(edge.to)!;
            const x1 = from.x + BOX_WIDTH; const y1 = from.y + from.height / 2;
            const x2 = to.x + BOX_WIDTH; const y2 = to.y + to.height / 2;
            const targetGutter = x2 + 28;
            const routeY = from.y + from.height + GAP / 2;
            const labelX = x1 + 28;
            let labelY = (y1 + y2) / 2;
            while (edgeLabels.some((held) => held.x === labelX && Math.abs(held.y - labelY) < 20)) labelY += 20;
            edgeLabels.push({ x: labelX, y: labelY });
            return <GraphEdge key={id} d={`M ${x1} ${y1} L ${labelX} ${y1} L ${labelX} ${labelY} L ${labelX} ${routeY} L ${targetGutter} ${routeY} L ${targetGutter} ${y2} L ${x2} ${y2}`} active={selected !== null || highlighted !== undefined} data-active={String(selected !== null || (highlighted?.has(edge.from) === true && highlighted.has(edge.to)))} data-edge={id} data-count={edge.count} label={edge.count > 1 || edge.from.startsWith('section:') || edge.to.startsWith('section:') ? String(edge.count) : undefined} labelX={labelX} labelY={labelY} />;
          })}
        </GraphEdges>
        {boxes.map((box) => <GraphBox key={box.id} x={box.x} y={box.y} width={BOX_WIDTH} height={box.height} active={selected === box.id || highlighted?.has(box.id) === true} data-testid={box.kind === undefined ? 'dependency-section' : 'dependency-node'} data-section={box.section?.id} data-kind={box.kind?.kind} data-chosen={String(selected === box.id)} data-highlighted={String(selected === box.id || highlighted?.has(box.id) === true)} data-turn={box.kind?.turn ?? ''} data-state={box.kind === undefined ? undefined : graphStateOf(box.kind, filling)}>
          {box.section !== undefined ? <Button size="content" className="h-full w-full flex-col items-start justify-center whitespace-normal px-2 py-1" aria-expanded={expanded === box.section.id} onClick={() => setExpanded(expanded === box.section.id ? null : box.section.id)}><Text className="block max-w-full text-left">{box.section.name}</Text><GraphMetadata>{t('knowledge.catalogueKinds', { count: box.section.kinds.length })} · {t('knowledge.catalogueEntities', { count: box.section.kinds.reduce((sum, kind) => sum + kind.count, 0) })}</GraphMetadata></Button> : <Stack className="px-2 py-1">
            <Button size="content" className="block max-w-full whitespace-normal text-left" onClick={() => setSelected(box.id)}>{name(box.kind!)}</Button>
            <GraphMetadata><Text data-testid="dependency-state">{t(`knowledge.catalogueState.${graphStateOf(box.kind!, filling)}`)}</Text><KLink href={addressOfKind(box.id)} className={graphLinkClass} testId={`dependency-link-${box.id}`}><Badge variant="outline" data-testid="dependency-count">{box.kind!.count}</Badge></KLink></GraphMetadata>
            {(box.kind!.pluginFolders ?? []).length > 0 && <Text className="block truncate text-small text-muted" data-testid="dependency-plugin">{box.kind!.pluginFolders!.join(', ')}</Text>}
          </Stack>}
        </GraphBox>)}
      </GraphCanvas>
    </GraphViewport>
  </PageSection>;
}
