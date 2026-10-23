/**
 * The end-to-end chain (`:::sequence`): lanes for the services a scenario passes
 * through (opened into their files), the tables, the topics and the caller; a row
 * for each step, in the order the graph knows (the places the steps were read at,
 * inside each function), and below a dashed line the steps the graph links but
 * does not order. Every step's label is a link to what it reaches, its number a
 * link to the place in the code it was read at.
 *
 * The diagram fits the column it is in. A service whose files would not fit stands
 * as one lane and its inner steps are folded into a count; a click on the lane (or
 * "show all steps") opens it into its files, and the diagram then scrolls sideways
 * with a shadow at the edge that says so. On a phone the steps are a list.
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
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
/** The narrowest a lane is drawn; longer names are cut to it and whole in the title and the list. */
export const MIN_LANE = 92;
const MAX_LANE = 228;
const groupId = (name: string): string => `group:${name}`;

/** A lane as drawn: a file, a table, a topic, the caller, or a service folded into one lane. */
export interface ViewLane extends ChainLane {
  /** A service shown as one lane: its files are one click away. */
  folded?: { members: number };
}

export interface FoldedChain {
  lanes: ViewLane[];
  steps: ChainStep[];
  /** Steps left out because both ends are inside a folded service, by service. */
  inside: { group: string; count: number }[];
  /** Steps left out because they stay in one file: shown only with all steps. */
  sameFile: number;
}

/**
 * The chain as it is drawn with some services folded: each folded service is one lane, a step inside one is left out
 * and counted, and every other step keeps its number so the list under the diagram and the diagram agree.
 */
export function foldChain(chain: Chain, folded: ReadonlySet<string>, showAll: boolean): FoldedChain {
  const lane = new Map(chain.lanes.map((entry) => [entry.id, entry]));
  const members = new Map<string, number>();
  for (const entry of chain.lanes) members.set(entry.group, (members.get(entry.group) ?? 0) + 1);
  const mapped = (id: string): string => {
    const entry = lane.get(id);
    return entry !== undefined && folded.has(entry.group) && (members.get(entry.group) ?? 0) > 1 ? groupId(entry.group) : id;
  };
  const inside = new Map<string, number>();
  let sameFile = 0;
  const steps: ChainStep[] = [];
  for (const step of chain.steps) {
    const from = mapped(step.from);
    const to = mapped(step.to);
    if (from === to) {
      const owner = lane.get(step.from)?.group ?? '';
      if (from.startsWith('group:')) inside.set(owner, (inside.get(owner) ?? 0) + 1);
      else if (!showAll) sameFile += 1;
      else steps.push({ ...step, from, to });
      continue;
    }
    steps.push({ ...step, from, to });
  }
  const used = new Set(steps.flatMap((step) => [step.from, step.to]));
  const lanes: ViewLane[] = [];
  for (const entry of chain.lanes) {
    const id = mapped(entry.id);
    if (!used.has(id) || lanes.some((held) => held.id === id)) continue;
    lanes.push(id === entry.id ? entry : { id, label: entry.group, sub: '', kind: 'group', href: null, group: entry.group, folded: { members: members.get(entry.group) ?? 0 } });
  }
  return { lanes, steps, inside: [...inside].map(([name, count]) => ({ group: name, count })), sameFile };
}

/**
 * Which services stand folded when the column is `width` wide: the services with the most lanes fold first until the
 * lanes fit at the narrowest lane width. A service with one lane never folds.
 */
export function autoFolded(chain: Chain, width: number): Set<string> {
  const counts = new Map<string, number>();
  for (const entry of chain.lanes) counts.set(entry.group, (counts.get(entry.group) ?? 0) + 1);
  const folded = new Set<string>();
  const room = Math.max(1, Math.floor((width - GUTTER - 8) / MIN_LANE));
  const total = (): number => [...counts].reduce((sum, [name, count]) => sum + (folded.has(name) ? 1 : count), 0);
  while (total() > room) {
    const next = [...counts].filter(([name, count]) => count > 1 && !folded.has(name)).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
    if (next === undefined) break;
    folded.add(next[0]);
  }
  return folded;
}

export interface ChainLayout {
  width: number;
  height: number;
  laneX: Map<string, number>;
  laneW: number;
  rows: { step: ChainStep; y: number; x1: number; x2: number; label: { x: number; anchor: 'start' | 'middle' | 'end'; width: number; text: string }; self: boolean; noteX: number }[];
  groups: { name: string; x: number; w: number; folded: boolean }[];
  separator: { y: number } | null;
}

/** Places lanes and rows; `available` is the width of the column the diagram stands in, 0 when it is not known. */
export function layoutChain(view: { lanes: ViewLane[]; steps: ChainStep[] }, available = 0): ChainLayout {
  const fitted = available > 0 ? Math.floor((available - GUTTER - 8) / Math.max(1, view.lanes.length)) : MAX_LANE;
  const widest = Math.max(...view.lanes.map((lane) => textWidth(lane.label, 12) + 28), MIN_LANE);
  const laneW = Math.max(MIN_LANE, Math.min(MAX_LANE, fitted, widest));
  const laneX = new Map(view.lanes.map((lane, index) => [lane.id, GUTTER + index * laneW + laneW / 2]));
  const rows: ChainLayout['rows'] = [];
  let separator: { y: number } | null = null;
  let y = TOP;
  const lanesRight = GUTTER + view.lanes.length * laneW;
  for (let step of view.steps) {
    if (step.order === 'unordered' && separator === null) {
      separator = { y: y - ROW / 2 + 6 };
      y += 16;
    }
    const x1 = laneX.get(step.from) ?? GUTTER;
    const x2 = laneX.get(step.to) ?? GUTTER;
    const self = x1 === x2;
    // Every text stays inside the lanes' width: one that is longer is moved left and, if it still does not fit, cut
    // (the full text is the link's title and the list's).
    const room = lanesRight - 8 - GUTTER;
    const text = fit(step.label, room);
    const width = textWidth(text, 12);
    const span = Math.abs(x2 - x1);
    let start: number;
    let anchor: 'start' | 'middle' = 'start';
    if (self) start = x1 + LOOP + 8;
    else if (width + 12 <= span) {
      anchor = 'middle';
      start = (x1 + x2) / 2 - width / 2;
    } else start = Math.min(x1, x2) + 8;
    start = Math.max(GUTTER, Math.min(start, lanesRight - 8 - width));
    const label: ChainLayout['rows'][number]['label'] = { x: anchor === 'middle' ? start + width / 2 : start, anchor, width, text };
    const noteX = Math.max(GUTTER - 4, start);
    if (step.note !== undefined) step = { ...step, note: fit(step.note, lanesRight - 8 - noteX, 11) };
    rows.push({ step, y, x1, x2, label, self, noteX });
    y += ROW;
  }
  const groups: ChainLayout['groups'] = [];
  view.lanes.forEach((lane, index) => {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.name === lane.group && !lane.folded) last.w += laneW;
    else groups.push({ name: lane.group, x: GUTTER + index * laneW + 4, w: laneW - 8, folded: lane.folded !== undefined });
  });
  return { width: lanesRight, height: y + 8, laneX, laneW, rows, groups, separator };
}

const KIND_MARK: Record<string, string> = { route: 'dg-route', http: 'dg-remote', grpc: 'dg-remote', publish: 'dg-event', consume: 'dg-event', read: 'dg-data', write: 'dg-data' };

function Lane({ lane, x, w, height, onToggle }: { lane: ViewLane; x: number; w: number; height: number; onToggle: () => void }): ReactElement {
  const link = useDiagramLink();
  const { t } = useTranslation();
  const sub = lane.folded !== undefined ? t('knowledge.diagram.openLane', { count: lane.folded.members }) : lane.sub;
  const body = (
    <>
      <rect className={`dg-node${lane.folded !== undefined ? ' dg-lane-folded' : ''}`} x={x - w / 2 + 4} y={HEAD_GROUP + 4} width={w - 8} height={HEAD_LANE} rx="8" />
      <text className="dg-label" x={x} y={HEAD_GROUP + 4 + 19} textAnchor="middle">{fit(lane.label, w - 24)}</text>
      <text className="dg-kind" x={x} y={HEAD_GROUP + 4 + 35} textAnchor="middle">{fit(sub, w - 24, 11)}</text>
      <title>{`${lane.label} — ${sub}`}</title>
    </>
  );
  return (
    <g data-lane={lane.id} data-testid="chain-lane">
      <line className="dg-life" x1={x} x2={x} y1={HEAD_GROUP + HEAD_LANE + 4} y2={height} />
      {lane.folded !== undefined
        ? <g role="button" tabIndex={0} className="dg-toggle" aria-label={t('knowledge.diagram.openService', { name: lane.label })} onClick={onToggle} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle(); } }}>{body}</g>
        : lane.href === null ? <g>{body}</g> : <a {...link(lane.href)}>{body}</a>}
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
  const holder = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [override, setOverride] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    const element = holder.current;
    if (element === null) return;
    const measure = (): void => setWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const folded = useMemo(() => {
    if (showAll) return new Set<string>();
    const set = autoFolded(chain, width > 0 ? width : 1000);
    for (const [name, value] of override) {
      if (value) set.add(name);
      else set.delete(name);
    }
    return set;
  }, [chain, width, override, showAll]);
  const view = useMemo(() => foldChain(chain, folded, showAll), [chain, folded, showAll]);
  const layout = layoutChain(view, width);
  const laneName = new Map(chain.lanes.map((lane) => [lane.id, lane.label]));
  const toggle = (name: string): void => {
    setShowAll(false);
    setOverride((held) => new Map(held).set(name, !folded.has(name)));
  };
  const hidden = view.inside.reduce((sum, entry) => sum + entry.count, 0) + view.sameFile;
  const canOpen = chain.steps.length > view.steps.length;
  const scrolls = width > 0 && layout.width > width + 1;
  return (
    <div className="dg-chain" data-testid="chain" ref={holder}>
      <h3 className="dg-chain-title">
        {chain.entry?.href != null ? <a {...link(chain.entry.href)}>{chain.title}</a> : chain.title}
        <span className="dg-chain-count">{t('knowledge.diagram.steps', { shown: view.steps.length, total: chain.total })}</span>
      </h3>
      <div className="dg-chain-bar">
        {hidden > 0 && <span data-testid="chain-folded">{t('knowledge.diagram.foldedSteps', { count: hidden })}</span>}
        {canOpen && <button type="button" className="dg-linkbutton" data-testid="chain-show-all" onClick={() => setShowAll(true)}>{t('knowledge.diagram.showAll', { count: chain.steps.length })}</button>}
        {(showAll || override.size > 0) && <button type="button" className="dg-linkbutton" data-testid="chain-fit" onClick={() => { setShowAll(false); setOverride(new Map()); }}>{t('knowledge.diagram.fitChain')}</button>}
      </div>
      <div className={`dg-scroll${scrolls ? ' dg-scrolls' : ''}`} data-testid="chain-scroll">
        <svg className="dg-svg dg-chain-svg" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="group" aria-label={chain.title}>
          <defs>
            <marker id="dg-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path className="dg-headpath" d="M0,0 L10,5 L0,10 z" /></marker>
          </defs>
          {layout.groups.map((entry) => {
            const members = chain.lanes.filter((lane) => lane.group === entry.name).length;
            const openable = !entry.folded && members > 1;
            const inner = (
              <>
                <rect className="dg-band" x={entry.x} y="0" width={entry.w} height={HEAD_GROUP - 4} rx="4" />
                <text className="dg-groupname" x={entry.x + 8} y="12">{fit(`${openable ? '− ' : ''}${entry.name}`, entry.w - 12, 11)}</text>
              </>
            );
            return (
              <g key={`${entry.name}|${entry.x}`} data-testid="chain-group">
                {openable
                  ? <g role="button" tabIndex={0} className="dg-toggle" aria-label={t('knowledge.diagram.foldService', { name: entry.name })} onClick={() => toggle(entry.name)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(entry.name); } }}>{inner}</g>
                  : inner}
              </g>
            );
          })}
          {view.lanes.map((lane) => <Lane key={lane.id} lane={lane} x={layout.laneX.get(lane.id)!} w={layout.laneW} height={layout.height - 8} onToggle={() => toggle(lane.group)} />)}
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
