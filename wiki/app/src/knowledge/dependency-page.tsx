/**
 * The dependency graph of the catalogue's entities (madarch-stm0.6, commit 5): the kinds the product's manifest declares,
 * laid out by the longest chain of the dependencies they declare (`depends-on`), one column per depth, with the edges the
 * declarations make drawn between them. Each entity shows the state a fill leaves it in — filled, partial or never filled —
 * read from the catalogue's own answer, so the page follows a run as it publishes (the wiki's live store re-reads it).
 *
 * The engine names no entity: the kinds, their names and their dependencies are the manifest's, and the page holds no list
 * of any of them. A cycle the manifest would have refused is drawn as it stands and said, never hidden. The state is the
 * newest turn of the kind's unit (`turn`) while a fill runs and after it, so a run that publishes moves a box without a
 * reload; a kind with no turn is judged by the graph's outcome alone.
 */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { PageSkeleton } from './skeleton.js';
import { useTabTitle } from './tabs.js';
import { useRead } from './live.js';
import { getCatalog } from './api.js';
import { addressOfKind, addressOfCatalogue, WIKI_FILL } from './routes.js';
import { KLink } from './blocks.js';
import { areaOf } from './catalog-area.js';
import { Badge } from '@/components/ui/badge.js';
import type { CatalogKindView, CatalogView, WikiStatus } from './types.js';

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

/**
 * The catalogue split for the page: only the kinds that take part in a dependency — one that declares `depends-on`, or
 * one another kind needs — are laid out as a graph. The rest are independent and listed by section below (madarch-stm0.6,
 * the owner 2026-11-10: 510 boxes in one column are a wall a reader scrolls past).
 */
export function dependencySplit(kinds: readonly CatalogKindView[]): { nodes: GraphNode[]; layers: string[][]; cycles: string[]; independent: CatalogKindView[] } {
  const needed = new Set(kinds.flatMap((kind) => kind.dependsOn ?? []));
  const participating = kinds.filter((kind) => (kind.dependsOn ?? []).length > 0 || needed.has(kind.kind));
  const shown = new Set(participating.map((kind) => kind.kind));
  return { ...graphLayers(participating), independent: kinds.filter((kind) => !shown.has(kind.kind)) };
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

/** The page: the graph of the catalogue's dependencies, each entity with the state a fill left it in. */
export function DependencyPage({ version, status }: { version: number; status: WikiStatus }): ReactElement {
  const { t, i18n } = useTranslation();
  const language = (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  useTabTitle(t('knowledge.dependencies.title'));
  const { data, error } = useRead<CatalogView>('dependencies', version, getCatalog);
  if (data === null && error !== null) {
    return <p className="text-muted" data-testid="dependencies-error">{error}</p>;
  }
  if (data === null) return <PageSkeleton testId="dependencies-loading" rows />;
  const filling = status.fill.state === 'running';
  const progress = status.fill.progress;
  const { nodes, layers, cycles, independent } = dependencySplit(data.kinds);
  const stateOrder: GraphState[] = ['done', 'partial', 'never', 'waiting', 'running', 'failed'];
  const countWords = (kinds: readonly CatalogKindView[]): string => {
    const counts = new Map<GraphState, number>();
    for (const kind of kinds) counts.set(graphStateOf(kind, filling), (counts.get(graphStateOf(kind, filling)) ?? 0) + 1);
    return stateOrder.filter((state) => (counts.get(state) ?? 0) > 0)
      .map((state) => t(`knowledge.dependencies.stateCounts.${state}`, { count: counts.get(state) ?? 0 }))
      .join(' · ');
  };
  const sectionLabel = (area: string): string => area === '' ? t('knowledge.groupOther') : (data.groups.find((group) => group.group === area)?.labels[language] ?? area);
  const independentSections = [...new Set(independent.map((kind) => areaOf(data.groups, kind)))]
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((area) => ({ area, label: sectionLabel(area), kinds: independent.filter((kind) => areaOf(data.groups, kind) === area) }));
  const place = new Map(nodes.map((node) => {
    const column = layers[node.depth]!;
    return [node.kind.kind, { x: node.depth * COLUMN + 8, y: column.indexOf(node.kind.kind) * (BOX_HEIGHT + GAP) + 8 }] as const;
  }));
  const height = Math.max(...layers.map((layer) => layer.length), 1) * (BOX_HEIGHT + GAP) + 16;
  const width = Math.max(layers.length, 1) * COLUMN;
  const name = (kind: CatalogKindView): string => kind.labels?.[language]?.many ?? kind.kind;
  return (
    <section data-testid="dependency-page">
      <header className="mb-4">
        <h1>{t('knowledge.dependencies.title')}</h1>
        <p className="mb-1">{t('knowledge.dependencies.intro')}</p>
        <p className="mt-0 text-small text-muted" data-testid="dependencies-total">{t('knowledge.dependencies.count', { kinds: nodes.length, layers: layers.length })} <KLink href={addressOfCatalogue()} testId="dependencies-catalogue">{t('knowledge.dependencies.catalogue')}</KLink></p>
        {independent.length > 0 && <p className="m-0 text-small text-muted" data-testid="dependencies-independent-note">{t('knowledge.dependencies.independentNote', { count: independent.length })}</p>}
        {cycles.length > 0 && <p className="m-0 text-small" role="alert" data-testid="dependencies-cycle">{t('knowledge.dependencies.cycle', { cycle: cycles.join('; ') })}</p>}
        {filling && (
          <p className="m-0 mt-2 text-small" data-testid="dependencies-progress">
            {progress === undefined
              ? t('knowledge.dependencies.running')
              : t('knowledge.dependencies.progress', { published: progress.published, planned: progress.planned })}{' '}
            <KLink href={WIKI_FILL} testId="dependencies-open-fill">{t('knowledge.dependencies.openFill')}</KLink>
          </p>
        )}
        {status.fill.state === 'failed' && (
          <p className="m-0 mt-2 text-small" role="alert" data-testid="dependencies-failed">
            {status.fill.error?.file !== undefined
              ? t('knowledge.dependencies.failedAt', { message: status.fill.error.message, file: status.fill.error.file, line: status.fill.error.line ?? 0 })
              : status.fill.message ?? t('knowledge.dependencies.failed')}
          </p>
        )}
      </header>
      {/* The graph is its own frame: on a phone it scrolls sideways inside the page, and the page itself never does. */}
      <div className="overflow-x-auto" data-testid="dependencies-graph">
        <div className="relative" style={{ width, height }}>
          <svg width={width} height={height} aria-hidden="true" className="absolute inset-0">
            {nodes.flatMap((node) => node.dependsOn.flatMap((dependency) => {
              const from = place.get(dependency);
              const to = place.get(node.kind.kind);
              if (from === undefined || to === undefined) return [];
              const x1 = from.x + BOX_WIDTH;
              const y1 = from.y + BOX_HEIGHT / 2;
              const x2 = to.x;
              const y2 = to.y + BOX_HEIGHT / 2;
              const middle = (x1 + x2) / 2;
              return [<path key={`${dependency}\0${node.kind.kind}`} d={`M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y2}, ${x2} ${y2}`} className="fill-none stroke-line" strokeWidth={1.5} data-edge={`${dependency}->${node.kind.kind}`} />];
            }))}
          </svg>
          {nodes.map((node) => (
            <div
              key={node.kind.kind}
              className="absolute rounded-[var(--radius-card)] border border-line bg-page px-2 py-1.5 text-small"
              style={{ left: place.get(node.kind.kind)?.x, top: place.get(node.kind.kind)?.y, width: BOX_WIDTH, height: BOX_HEIGHT }}
              data-testid="dependency-node"
              data-kind={node.kind.kind}
              data-state={graphStateOf(node.kind, filling)}
              data-turn={node.kind.turn ?? ''}
              data-depth={node.depth}
            >
              <KLink href={addressOfKind(node.kind.kind)} className="block truncate text-ink" testId={`dependency-link-${node.kind.kind}`}>{name(node.kind)}</KLink>
              <span className="flex items-center justify-between gap-2 text-[11px] text-muted">
                <span data-testid="dependency-state">{t(`knowledge.catalogueState.${graphStateOf(node.kind, filling)}`)}</span>
                <Badge variant="outline" data-testid="dependency-count">{node.kind.count}</Badge>
              </span>
            </div>
          ))}
        </div>
      </div>
      {independentSections.length > 0 && (
        <section className="mt-6" data-testid="dependencies-independent">
          <h2 className="mb-2 mt-0 text-[15px] font-semibold text-ink">{t('knowledge.dependencies.independent')}</h2>
          {independentSections.map((section) => (
            <details key={section.area} className="mb-1 border-b border-line pb-1 last:border-b-0" data-testid="dependencies-independent-section" data-area={section.area}>
              <summary className="cursor-pointer py-1 text-small">
                <span className="font-medium text-ink">{section.label}</span>
                <span className="text-muted"> · {t('knowledge.catalogueKinds', { count: section.kinds.length })} · </span>
                <span className="text-muted" data-testid="dependencies-independent-counts">{countWords(section.kinds)}</span>
              </summary>
              <ul className="m-0 list-none p-0 pl-4 text-small" data-testid="dependencies-independent-list">
                {section.kinds.map((kind) => (
                  <li key={kind.kind} className="flex items-baseline justify-between gap-2 py-0.5" data-kind={kind.kind} data-state={graphStateOf(kind, filling)}>
                    <KLink href={addressOfKind(kind.kind)} className="truncate text-ink">{name(kind)}</KLink>
                    <span className="shrink-0 text-muted">{t(`knowledge.catalogueState.${graphStateOf(kind, filling)}`)}</span>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </section>
      )}
    </section>
  );
}
