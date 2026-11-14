/**
 * The drawn diagram (decision 0036, section 7): a frame that fits the picture into the column, and the boxes, edges
 * and labels one page's neighbourhood is made of. The coordinates come from the diagram's own layout, so nothing here
 * measures a DOM; a press on a box walks to the entity it stands for.
 */
import type { ReactElement, ReactNode } from 'react';

export interface DrawnNode {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly label: string;
  readonly caption?: string;
  readonly title?: string;
  readonly href?: string;
  readonly emphasis?: boolean;
}

export interface DrawnEdge {
  readonly key: string;
  readonly from: { readonly x: number; readonly y: number };
  readonly to: { readonly x: number; readonly y: number };
  readonly label?: string;
  readonly labelX?: number;
  readonly labelY?: number;
}

export function Drawing({ width, height, label, children }: { readonly width: number; readonly height: number; readonly label: string; readonly children: ReactNode }): ReactElement {
  return (
    <div className="w-full overflow-x-auto rounded border border-line bg-page p-2">
      <svg viewBox={`0 0 ${String(width)} ${String(height)}`} width="100%" role="img" aria-label={label} style={{ maxHeight: '32rem' }} preserveAspectRatio="xMidYMin meet">
        {children}
      </svg>
    </div>
  );
}

export function DrawnBox({ node, onOpen }: { readonly node: DrawnNode; readonly onOpen?: (path: string) => void }): ReactElement {
  const fill = node.emphasis === true ? 'var(--bg-chrome)' : 'var(--surface-page)';
  const box = (
    <>
      <rect x={node.x} y={node.y} width={node.width} height={node.height} rx={4} fill={fill} stroke="var(--border)" />
      <text x={node.x + 8} y={node.y + (node.caption === undefined ? node.height / 2 + 4 : 16)} fontSize={12} fill="var(--text)">{node.label}</text>
      {node.caption === undefined ? null : <text x={node.x + 8} y={node.y + node.height - 6} fontSize={10} fill="var(--text-muted)">{node.caption}</text>}
    </>
  );
  const href = node.href;
  if (href === undefined) return <g data-node={node.key}><title>{node.title ?? node.label}</title>{box}</g>;
  return (
    <a href={href} data-node={node.key} onClick={(event) => { if (onOpen !== undefined && !event.metaKey && !event.ctrlKey) { event.preventDefault(); onOpen(href); } }}>
      <title>{node.title ?? node.label}</title>
      {box}
    </a>
  );
}

export function DrawnLine({ edge }: { readonly edge: DrawnEdge }): ReactElement {
  const middleX = (edge.from.x + edge.to.x) / 2;
  return (
    <g data-edge={edge.key}>
      <path d={`M ${String(edge.from.x)} ${String(edge.from.y)} C ${String(middleX)} ${String(edge.from.y)}, ${String(middleX)} ${String(edge.to.y)}, ${String(edge.to.x)} ${String(edge.to.y)}`} fill="none" stroke="var(--border)" strokeWidth={1.5} />
      {edge.label === undefined ? null : <text x={edge.labelX ?? middleX} y={(edge.labelY ?? (edge.from.y + edge.to.y) / 2) - 3} fontSize={10} fill="var(--text-muted)" textAnchor="middle">{edge.label}</text>}
    </g>
  );
}

export function DrawnLabel({ x, y, children, anchor = 'start' }: { readonly x: number; readonly y: number; readonly children: string; readonly anchor?: 'start' | 'middle' }): ReactElement {
  return <text x={x} y={y} fontSize={11} fill="var(--text-secondary)" textAnchor={anchor}>{children}</text>;
}
