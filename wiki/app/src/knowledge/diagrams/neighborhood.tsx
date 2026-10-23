/**
 * The neighbourhood of an entity (`:::graph`): the entity in the middle, what
 * comes in on the left and what goes out on the right, grouped by relation.
 * A node is a link to its page (through `onOpen`, see open.ts); its plus
 * opens its own neighbours into the picture; "+N more" opens the rest of a
 * group. Depth and the relations are switches over what the server sent.
 */
import { useMemo, useRef, useState, type ReactElement } from 'react';
import { PlusIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Toggle } from '@/components/ui/toggle.js';
import { getNeighborhood } from '../api.js';
import { useKindName } from '../kind-names.js';
import type { Block, Neighborhood } from '../types.js';
import { fit, layoutNeighborhood, mergeHood, NODE_H, NODE_W, relationWord, slotOf, type PlacedNode } from './layout.js';
import { useDiagramLink } from './open.js';
import { PanZoom } from './pan-zoom.js';

type GraphBlock = Extract<Block, { type: 'graph' }>;

export function NeighborhoodGraph({ block }: { block: GraphBlock }): ReactElement {
  const { t } = useTranslation();
  const kindName = useKindName();
  const link = useDiagramLink();
  const [hood, setHood] = useState<Neighborhood>(block.neighborhood);
  const [depth, setDepth] = useState(block.depth);
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [grown, setGrown] = useState<ReadonlySet<string>>(new Set());
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const alive = useRef(true);
  const maxDepth = useMemo(() => Math.max(1, ...hood.nodes.map((node) => node.hops ?? 0)), [hood]);
  const layout = useMemo(() => layoutNeighborhood(hood, { depth, off }, grown), [hood, depth, off, grown]);
  const empty = hood.nodes.length <= 1;

  const open = async (node: string, relation: string | undefined, direction: 'out' | 'in' | undefined, limit: number): Promise<void> => {
    setBusy(node);
    setFailure(null);
    try {
      const more = await getNeighborhood(node, { ...(relation === undefined ? {} : { relation }), ...(direction === undefined ? {} : { direction }), limit });
      if (!alive.current) return;
      setHood((held) => mergeHood(held, more, relation === undefined || direction === undefined ? undefined : { node, relation, direction }));
      setGrown((held) => new Set([...held, node]));
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  if (empty && hood.more.length === 0) {
    return (
      <section data-block="diagram" aria-label={block.title}>
        <h2>{block.title}</h2>
        <p className="text-small text-muted" data-testid="diagram-empty">{t('knowledge.noLinks')}</p>
      </section>
    );
  }
  const toggles = [...hood.relations].sort((a, b) => (a.direction === b.direction ? (a.relation < b.relation ? -1 : 1) : a.direction === 'in' ? -1 : 1));
  const footprint = (node: PlacedNode): string => (node.more === undefined ? node.node.label : t('knowledge.diagram.moreChip', { count: node.more.hidden, relation: relationWord(node.more.relation) }));

  return (
    <section data-block="diagram" data-diagram="neighborhood" aria-label={block.title}>
      <h2>{block.title}</h2>
      <figure className="m-0">
        <PanZoom
          width={layout.width}
          height={layout.height}
          focus={{ x: layout.center.x + NODE_W / 2, y: layout.center.y + NODE_H / 2 }}
          label={block.title}
          testId="neighborhood"
          toolbar={(
            <>
              <div className="dg-group" role="group" aria-label={t('knowledge.diagram.depth')}>
                <span className="dg-caption">{t('knowledge.diagram.depth')}</span>
                {[1, 2, 3].filter((value) => value <= Math.max(2, maxDepth)).map((value) => (
                  <Toggle key={value} pressed={depth === value} onPressedChange={() => setDepth(value)} className="dg-chip" aria-label={t('knowledge.diagram.depthN', { count: value })} data-testid={`depth-${value}`}>{value}</Toggle>
                ))}
              </div>
              <div className="dg-group" role="group" aria-label={t('knowledge.diagram.relations')}>
                {toggles.map((entry) => {
                  const slot = slotOf(entry.relation, entry.direction);
                  return (
                    <Toggle
                      key={slot}
                      pressed={!off.has(slot)}
                      onPressedChange={(pressed) => setOff((held) => { const next = new Set(held); if (pressed) next.delete(slot); else next.add(slot); return next; })}
                      className="dg-chip"
                      title={entry.direction === 'in' ? t('knowledge.diagram.comesIn', { relation: relationWord(entry.relation) }) : t('knowledge.diagram.goesOut', { relation: relationWord(entry.relation) })}
                      data-testid={`relation-${slot}`}
                    >
                      {entry.direction === 'in' ? '← ' : ''}{relationWord(entry.relation)}{entry.direction === 'out' ? ' →' : ''} <span className="dg-count">{entry.count}</span>
                    </Toggle>
                  );
                })}
              </div>
            </>
          )}
        >
          <g className="dg-edges">
            {layout.edges.map((edge) => <path key={`${edge.from}|${edge.to}|${edge.relation}`} className="dg-edge" d={edge.d} data-relation={edge.relation} />)}
          </g>
          <g className="dg-heads">
            {layout.groups.map((group) => (
              <text key={`${group.column}|${group.x}|${group.y}|${group.relation}`} className="dg-head" x={group.x + 2} y={group.y + 12}>{fit(group.label, NODE_W - 4, 11)}</text>
            ))}
          </g>
          <g className="dg-nodes">
            {layout.nodes.map((placed) => {
              const { node } = placed;
              if (placed.more !== undefined) {
                const chip = placed.more;
                return (
                  <g key={node.id} className="dg-more" transform={`translate(${placed.x} ${placed.y})`} role="button" tabIndex={0} aria-label={footprint(placed)} data-testid="more-chip"
                    onClick={() => void open(chip.node, chip.relation, chip.direction, 40)}
                    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void open(chip.node, chip.relation, chip.direction, 40); } }}>
                    <rect width={NODE_W} height={NODE_H} rx="8" />
                    <text x={NODE_W / 2} y={NODE_H / 2 + 4} textAnchor="middle">{fit(footprint(placed), NODE_W - 16)}</text>
                  </g>
                );
              }
              const center = node.id === hood.center;
              const outer = placed.column <= 0;
              const body = (
                <>
                  <rect className={center ? 'dg-node dg-center' : node.href === null ? 'dg-node dg-plain' : 'dg-node'} width={NODE_W} height={NODE_H} rx="8" />
                  <text className="dg-label" x="10" y="15">{fit(node.label, NODE_W - 20)}</text>
                  <text className="dg-kind" x="10" y="28">{fit(kindName(node.kind, 'one'), NODE_W - 20, 10)}</text>
                  <title>{`${node.label} (${kindName(node.kind, 'one')})${node.href === null ? ` — ${t('knowledge.diagram.noPage')}` : ''}`}</title>
                </>
              );
              return (
                <g key={node.id} transform={`translate(${placed.x} ${placed.y})`} data-node={node.id} data-testid="hood-node">
                  {node.href === null ? <g>{body}</g> : <a {...link(node.href)}>{body}</a>}
                  {!center && (
                    <g className="dg-expand" role="button" tabIndex={0} aria-label={t('knowledge.diagram.expand', { name: node.label })} data-testid="expand-node"
                      transform={`translate(${outer ? -1 : NODE_W + 1} ${NODE_H / 2})`}
                      onClick={() => void open(node.id, undefined, undefined, 8)}
                      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void open(node.id, undefined, undefined, 8); } }}>
                      <circle r="9" />
                      <PlusIcon x={-6} y={-6} width={12} height={12} aria-hidden="true" />
                      <title>{t('knowledge.diagram.expand', { name: node.label })}</title>
                    </g>
                  )}
                </g>
              );
            })}
          </g>
        </PanZoom>
        <figcaption className="dg-note" aria-live="polite">
          {busy !== null ? t('knowledge.diagram.opening') : failure !== null ? <span className="ref-broken" data-testid="diagram-failure">{failure}</span> : block.total > block.shown ? t('knowledge.showing', { shown: block.shown, total: block.total }) : t('knowledge.diagram.hint')}
        </figcaption>
      </figure>
    </section>
  );
}
