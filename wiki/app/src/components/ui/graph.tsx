import { forwardRef, useRef, useState, useEffect, useId, type SVGProps, type HTMLAttributes } from 'react';
import { cn } from '@/lib/utils.js';
export const GraphViewport = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { focus?: { x: number; y: number; height: number; width: number } }>(function GraphViewport({ className, children, focus, ...props }, ref) {
  const frame = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  useEffect(() => {
    const element = frame.current;
    if (element === null || focus === undefined) return;
    setView({ x: element.clientWidth / 2 - focus.x - focus.width / 2, y: element.clientHeight / 2 - focus.y - focus.height / 2, scale: 1 });
  }, [focus?.x, focus?.y, focus?.width, focus?.height]);
  const zoom = (factor: number, x: number, y: number): void => setView((held) => {
    const scale = Math.min(3, Math.max(0.25, held.scale * factor));
    const ratio = scale / held.scale;
    return { scale, x: x - (x - held.x) * ratio, y: y - (y - held.y) * ratio };
  });
  useEffect(() => {
    const element = frame.current;
    if (element === null) return;
    const wheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      zoom(Math.exp(-event.deltaY * 0.002), event.clientX - rect.left, event.clientY - rect.top);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, []);
  return <div ref={(element) => { frame.current = element; if (typeof ref === 'function') ref(element); else if (ref !== null) ref.current = element; }} className={cn('relative h-[32rem] max-w-full overflow-hidden touch-none rounded-[var(--radius-card)] border border-line cursor-grab', className)} {...props}
    onPointerDown={(event) => {
      if ((event.target as Element).closest('button, a, input')) return;
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }}
    onPointerMove={(event) => {
      const previous = pointers.current.get(event.pointerId);
      if (previous === undefined) return;
      const other = [...pointers.current].find(([id]) => id !== event.pointerId)?.[1];
      if (other === undefined) setView((held) => ({ ...held, x: held.x + event.clientX - previous.x, y: held.y + event.clientY - previous.y }));
      else {
        const before = Math.hypot(previous.x - other.x, previous.y - other.y);
        const after = Math.hypot(event.clientX - other.x, event.clientY - other.y);
        const rect = event.currentTarget.getBoundingClientRect();
        if (before > 0) zoom(after / before, (event.clientX + other.x) / 2 - rect.left, (event.clientY + other.y) / 2 - rect.top);
      }
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }} onPointerUp={(event) => pointers.current.delete(event.pointerId)} onPointerCancel={(event) => pointers.current.delete(event.pointerId)}>
      <div className="origin-top-left" data-testid="graph-transform" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>{children}</div>
    </div>;
});
export function GraphCanvas({ width, height, ...props }: HTMLAttributes<HTMLDivElement> & { width: number; height: number }) { return <div className="relative" style={{ width, height }} {...props} />; }
export function GraphBox({ x, y, width, height, active, ...props }: HTMLAttributes<HTMLDivElement> & { x?: number; y?: number; width: number; height: number; active: boolean }) { return <div className={cn('absolute rounded-[var(--radius-card)] border text-small', active ? 'border-ink bg-[var(--surface-active)]' : 'border-line bg-page')} style={{ left: x, top: y, width, height }} {...props} />; }
export const graphLinkClass = 'block h-full w-full rounded-[var(--radius-card)] px-2 py-1.5 text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';
export function GraphMetadata(props: HTMLAttributes<HTMLSpanElement>) { return <span className="flex items-center justify-between gap-2 text-[11px] text-muted" {...props} />; }

export function GraphEdges(props: SVGProps<SVGSVGElement>) { return <svg aria-hidden="true" className="absolute inset-0" {...props} />; }
export function GraphEdge({ active, label, labelX, labelY, ...props }: SVGProps<SVGPathElement> & { active: boolean; label?: string; labelX?: number; labelY?: number }) {
  const arrow = useId();
  return <g><defs><marker id={arrow} viewBox="0 0 10 10" refX={10} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" className={active ? 'fill-ink' : 'fill-muted'} /></marker></defs><path className={active ? 'fill-none stroke-ink' : 'fill-none stroke-muted'} strokeWidth={active ? 3 : 1.5} markerEnd={`url(#${arrow})`} {...props} />{label !== undefined && <text x={labelX} y={labelY} dy={-5} textAnchor="middle" className="fill-ink text-[12px]" stroke="var(--surface-page)" strokeWidth={3} paintOrder="stroke">{label}</text>}</g>;
}
