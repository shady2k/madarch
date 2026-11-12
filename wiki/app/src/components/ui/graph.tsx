import { forwardRef, type SVGProps, type HTMLAttributes } from 'react';
import { cn } from '@/lib/utils.js';
export const GraphViewport = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function GraphViewport({ className, ...props }, ref) { return <div ref={ref} className={cn('overflow-x-auto', className)} {...props} />; });
export function GraphCanvas({ width, height, ...props }: HTMLAttributes<HTMLDivElement> & { width: number; height: number }) { return <div className="relative" style={{ width, height }} {...props} />; }
export function GraphBox({ x, y, width, height, active, ...props }: HTMLAttributes<HTMLDivElement> & { x?: number; y?: number; width: number; height: number; active: boolean }) { return <div className={cn('absolute rounded-[var(--radius-card)] border text-small', active ? 'border-ink bg-[var(--surface-active)]' : 'border-line bg-page')} style={{ left: x, top: y, width, height }} {...props} />; }
export const graphLinkClass = 'block h-full w-full rounded-[var(--radius-card)] px-2 py-1.5 text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';
export function GraphMetadata(props: HTMLAttributes<HTMLSpanElement>) { return <span className="flex items-center justify-between gap-2 text-[11px] text-muted" {...props} />; }

export function GraphEdges(props: SVGProps<SVGSVGElement>) { return <svg aria-hidden="true" className="absolute inset-0" {...props} />; }
export function GraphEdge({ active, ...props }: SVGProps<SVGPathElement> & { active: boolean }) { return <path className={active ? 'fill-none stroke-ink' : 'fill-none stroke-line'} strokeWidth={active ? 3 : 1.5} {...props} />; }
