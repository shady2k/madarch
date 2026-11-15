/** Renderer-independent graphical surfaces. Data, layout and renderer binding stay with their callers. */
import { forwardRef, type HTMLAttributes, type IframeHTMLAttributes, type SVGProps } from 'react';
import { cn } from '@/lib/utils.js';

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

/** A file's source as a code host shows it: one row per line with its number, wrapped or scrolled, at the page's width. */
export const FileSource = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { readonly lines: readonly string[]; readonly wrap: boolean }>(function FileSource({ lines, wrap, className, ...props }, ref) {
  return (
    <div ref={ref} className={cn('file-source', wrap ? 'file-source-wrap' : 'file-source-nowrap', className)} {...props}>
      <ol className="file-source-lines">
        {lines.map((line, at) => (
          <li key={at} className="file-source-line">
            <span className="file-source-number" aria-hidden="true">{at + 1}</span>
            <span className="file-source-code">{line === '' ? '\u00a0' : line}</span>
          </li>
        ))}
      </ol>
    </div>
  );
});

/** A diagram's zoom bar: the controls that scale the picture, above its frame. */
export function DiagramZoomBar({ className, ...props }: HTMLAttributes<HTMLDivElement>) { return <div className={cn('dg-zoom-bar', className)} {...props} />; }

/** The frame a picture is drawn in: it fits the picture by default and scrolls at the reader's zoom. */
export const DiagramZoomBox = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { readonly pannable?: boolean }>(function DiagramZoomBox({ pannable = false, className, ...props }, ref) {
  return <div ref={ref} className={cn('dg-frame-box dg-zoom-box', pannable && 'dg-pannable', className)} {...props} />;
});

/** A drawn picture at a scale, laid out at its own width so the frame scrolls it rather than shrinking its words. */
export function DiagramScaled({ zoom, width, html }: { readonly zoom: number; readonly width?: number; readonly html: string }) {
  return <div style={{ zoom, width }} dangerouslySetInnerHTML={{ __html: html }} />;
}
