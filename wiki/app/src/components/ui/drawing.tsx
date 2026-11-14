/** Renderer-independent graphical surfaces. Data, layout and renderer binding stay with their callers. */
import { forwardRef, type HTMLAttributes, type IframeHTMLAttributes, type SVGProps } from 'react';

export const DrawingSurface = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { width?: number | string; height?: number | string }>(function DrawingSurface({ width, height, style, ...props }, ref) {
  return <div ref={ref} style={{ width, height, ...style }} {...props} />;
});
export function ColourSwatch({ background, ...props }: HTMLAttributes<HTMLSpanElement> & { background: string }) {
  return <span style={{ background }} {...props} />;
}
export const EmbeddedFrame = forwardRef<HTMLIFrameElement, IframeHTMLAttributes<HTMLIFrameElement>>(function EmbeddedFrame(props, ref) { return <iframe ref={ref} {...props} />; });
export function Drawing(props: SVGProps<SVGSVGElement>) { return <svg {...props} />; }
export function DrawingGroup(props: SVGProps<SVGGElement>) { return <g {...props} />; }
export function DrawingPath(props: SVGProps<SVGPathElement>) { return <path {...props} />; }
export function DrawingRect(props: SVGProps<SVGRectElement>) { return <rect {...props} />; }
export function DrawingText(props: SVGProps<SVGTextElement>) { return <text {...props} />; }
