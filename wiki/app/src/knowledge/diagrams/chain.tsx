/**
 * The end-to-end chain (`:::sequence`): lanes for the files of the services a
 * scenario passes through, the tables, the topics and the caller; a row for
 * each step, in the order the graph knows (the places the steps were read at,
 * inside each function), and below a dashed line the steps the graph links but
 * does not order. Every step's label is a link to what it reaches, its number a
 * link to the place in the code it was read at.
 */
import { type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { Block, Chain, ChainLane, ChainStep } from '../types.js';
import { fit, textWidth } from './layout.js';
import { useDiagramLink } from './open.js';

type SequenceBlock = Extract<Block, { type: 'sequence' }>;

const GUTTER = 40;
const HEAD_GROUP = 22;
const HEAD_LANE = 46;
const TOP = HEAD_GROUP + HEAD_LANE + 24;
const ROW = 46;
const LOOP = 28;

export interface ChainLayout {
  width: number;
  height: number;
  laneX: Map<string, number>;
  laneW: number;
  rows: { step: ChainStep; y: number; x1: number; x2: number; label: { x: number; anchor: 'start' | 'middle' | 'end'; width: number; text: string }; self: boolean; noteX: number }[];
  groups: { name: string; x: number; w: number }[];
  separator: { y: number } | null;
  /** Where every text of a row stands, for the checks that measure overlap. */
}

export function layoutChain(chain: Chain): ChainLayout {
  const laneW = Math.min(228, Math.max(172, ...chain.lanes.map((lane) => textWidth(lane.label, 12) + 28)));
  const laneX = new Map(chain.lanes.map((lane, index) => [lane.id, GUTTER + index * laneW + laneW / 2]));
  const rows: ChainLayout['rows'] = [];
  let separator: { y: number } | null = null;
  let y = TOP;
  let widest = GUTTER + chain.lanes.length * laneW;
  for (const step of chain.steps) {
    if (step.order === 'unordered' && separator === null) {
      separator = { y: y - ROW / 2 + 6 };
      y += 16;
    }
    const x1 = laneX.get(step.from) ?? GUTTER;
    const x2 = laneX.get(step.to) ?? GUTTER;
    const self = x1 === x2;
    const text = step.label;
    const width = textWidth(text, 12);
    let label: ChainLayout['rows'][number]['label'];
    if (self) label = { x: x1 + LOOP + 8, anchor: 'start', width, text };
    else {
      const span = Math.abs(x2 - x1);
      if (width + 12 <= span) label = { x: (x1 + x2) / 2, anchor: 'middle', width, text };
      else label = { x: Math.min(x1, x2) + 8, anchor: 'start', width, text };
    }
    const right = label.anchor === 'middle' ? label.x + width / 2 : label.x + width;
    const left = label.anchor === 'middle' ? label.x - width / 2 : label.x;
    // The note stands under the label's left edge and never left of the step numbers.
    const noteX = Math.max(GUTTER - 4, left);
    widest = Math.max(widest, right + 16, step.note === undefined ? 0 : noteX + textWidth(step.note, 11) + 16);
    rows.push({ step, y, x1, x2, label, self, noteX });
    y += ROW;
  }
  const groups: ChainLayout['groups'] = [];
  chain.lanes.forEach((lane, index) => {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.name === lane.group) last.w += laneW;
    else groups.push({ name: lane.group, x: GUTTER + index * laneW + 4, w: laneW - 8 });
  });
  for (const group of groups) group.w = Math.max(60, group.w);
  return { width: widest, height: y + 8, laneX, laneW, rows, groups, separator };
}

const KIND_MARK: Record<string, string> = { route: 'dg-route', http: 'dg-remote', grpc: 'dg-remote', publish: 'dg-event', consume: 'dg-event', read: 'dg-data', write: 'dg-data' };

function Lane({ lane, x, w, height }: { lane: ChainLane; x: number; w: number; height: number }): ReactElement {
  const link = useDiagramLink();
  const body = (
    <>
      <rect className="dg-node" x={x - w / 2 + 6} y={HEAD_GROUP + 4} width={w - 12} height={HEAD_LANE} rx="8" />
      <text className="dg-label" x={x} y={HEAD_GROUP + 4 + 19} textAnchor="middle">{fit(lane.label, w - 28)}</text>
      <text className="dg-kind" x={x} y={HEAD_GROUP + 4 + 35} textAnchor="middle">{fit(lane.sub, w - 28, 10)}</text>
      <title>{`${lane.label} — ${lane.sub}`}</title>
    </>
  );
  return (
    <g data-lane={lane.id} data-testid="chain-lane">
      <line className="dg-life" x1={x} x2={x} y1={HEAD_GROUP + HEAD_LANE + 4} y2={height} />
      {lane.href === null ? <g>{body}</g> : <a {...link(lane.href)}>{body}</a>}
    </g>
  );
}

function Step({ row }: { row: ChainLayout['rows'][number] }): ReactElement {
  const link = useDiagramLink();
  const { step } = row;
  const mark = KIND_MARK[step.kind] ?? '';
  const dir = row.x2 >= row.x1 ? 1 : -1;
  const arrowEnd = row.x2 - dir * 2;
  const label = <text className={`dg-step ${mark}`} x={row.label.x} y={row.y - 7} textAnchor={row.label.anchor}>{row.label.text}</text>;
  return (
    <g data-step={step.n} data-testid="chain-step" className={step.order === 'unordered' ? 'dg-unordered' : undefined}>
      {row.self
        ? <path className={`dg-arrow ${mark}`} d={`M${row.x1},${row.y - 10} h${LOOP} v20 h-${LOOP - 2}`} markerEnd="url(#dg-head)" />
        : <line className={`dg-arrow ${mark}${step.kind === 'grpc' ? ' dg-grpc' : ''}`} x1={row.x1} x2={arrowEnd} y1={row.y} y2={row.y} markerEnd="url(#dg-head)" />}
      {step.href === null ? label : <a {...link(step.href)}>{label}<title>{step.label}</title></a>}
      {step.note !== undefined && <text className="dg-sub" x={row.noteX} y={row.y + (row.self ? 20 : 14)}>{step.note}</text>}
      {step.site === undefined
        ? <circle className="dg-num" cx="16" cy={row.y} r="10" />
        : <a {...link(step.site.href)}><circle className="dg-num" cx="16" cy={row.y} r="10" /><title>{`${step.site.path}:${step.site.lineStart}`}</title></a>}
      <text className="dg-numtext" x="16" y={row.y + 4} textAnchor="middle">{step.n}</text>
    </g>
  );
}

export function ChainView({ chain }: { chain: Chain }): ReactElement {
  const { t } = useTranslation();
  const link = useDiagramLink();
  const layout = layoutChain(chain);
  const laneName = new Map(chain.lanes.map((lane) => [lane.id, lane.label]));
  return (
    <div className="dg-chain" data-testid="chain">
      <h3 className="dg-chain-title">
        {chain.entry?.href != null ? <a {...link(chain.entry.href)}>{chain.title}</a> : chain.title}
        <span className="dg-chain-count">{t('knowledge.diagram.steps', { shown: chain.steps.length, total: chain.total })}</span>
      </h3>
      <div className="dg-scroll">
        <svg className="dg-svg dg-chain-svg" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="group" aria-label={chain.title}>
          <defs>
            <marker id="dg-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path className="dg-headpath" d="M0,0 L10,5 L0,10 z" /></marker>
          </defs>
          {layout.groups.map((group) => (
            <g key={`${group.name}|${group.x}`} data-testid="chain-group">
              <rect className="dg-band" x={group.x} y="0" width={group.w} height={HEAD_GROUP - 4} rx="4" />
              <text className="dg-groupname" x={group.x + 8} y="12">{fit(group.name, group.w - 12, 11)}</text>
            </g>
          ))}
          {chain.lanes.map((lane) => <Lane key={lane.id} lane={lane} x={layout.laneX.get(lane.id)!} w={layout.laneW} height={layout.height - 8} />)}
          {layout.separator !== null && (
            <g data-testid="chain-unordered">
              <line className="dg-sep" x1="0" x2={layout.width} y1={layout.separator.y} y2={layout.separator.y} />
              <text className="dg-sub" x={GUTTER} y={layout.separator.y + 13}>{t('knowledge.diagram.unordered')}</text>
            </g>
          )}
          {layout.rows.map((row) => <Step key={row.step.n} row={row} />)}
        </svg>
      </div>
      <ol className="dg-chain-list" data-testid="chain-list">
        {chain.steps.map((step, index) => {
          const first = step.order === 'unordered' && chain.steps[index - 1]?.order !== 'unordered';
          const from = laneName.get(step.from) ?? step.from;
          const to = laneName.get(step.to) ?? step.to;
          return (
            <li key={step.n} value={step.n} className={step.order === 'unordered' ? 'dg-unordered' : undefined}>
              {first && <p className="dg-sub dg-list-unordered">{t('knowledge.diagram.unordered')}</p>}
              <span className="dg-list-lanes">{from} → {to}</span>
              {step.href === null ? <span className="dg-list-label">{step.label}</span> : <a className="dg-list-label" {...link(step.href)}>{step.label}</a>}
              {step.site !== undefined && <a className="dg-list-site" {...link(step.site.href)}>{step.site.path}:{step.site.lineStart}</a>}
              {step.note !== undefined && <span className="dg-sub">{step.note}</span>}
            </li>
          );
        })}
      </ol>
      {chain.notes.length > 0 && <ul className="dg-notes">{chain.notes.map((note) => <li key={note}>{note}</li>)}</ul>}
    </div>
  );
}

export function SequenceView({ block }: { block: SequenceBlock }): ReactElement {
  const { t } = useTranslation();
  if (block.chains.length === 0) {
    return (
      <section data-block="diagram" aria-label={block.title}>
        <h2>{block.title}</h2>
        <p className="text-small text-muted" data-testid="diagram-empty">{block.entries === 0 ? t('knowledge.diagram.noChain') : t('knowledge.diagram.emptyChain')}</p>
      </section>
    );
  }
  return (
    <section data-block="diagram" data-diagram="sequence" aria-label={block.title}>
      <h2>{block.title}</h2>
      <p className="dg-scenario" data-testid="scenario">{t('knowledge.diagram.scenario', { name: block.scenario })}</p>
      <figure className="m-0">
        {block.chains.map((chain) => <ChainView key={chain.entry?.id ?? chain.title} chain={chain} />)}
        {block.notes.length > 0 && <figcaption className="dg-note">{block.notes.join(' ')}</figcaption>}
      </figure>
    </section>
  );
}
