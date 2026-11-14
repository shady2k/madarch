/**
 * The frames a server-rendered picture stands in (decision 0036, sections 7 and 8): the page pans and zooms nothing itself —
 * the picture is the server's answer — so a frame only sizes it into the column and keeps it from widening the page.
 */
import { forwardRef, type ReactElement, type ReactNode } from 'react';

/** The surface a drawn picture stands on: it scrolls with its own content and never widens the column. */
export const DiagramFrame = forwardRef<HTMLDivElement, { readonly children: ReactNode; readonly label: string }>(function DiagramFrame({ children, label }, ref): ReactElement {
  return (
    <div ref={ref} role="group" aria-label={label} className="dg-frame w-full overflow-auto rounded border border-line bg-page p-2">
      {children}
    </div>
  );
});

/** The frame an interactive rendering the server made stands in: the page pans, zooms and opens its own panels. */
export const EmbeddedDiagram = forwardRef<HTMLIFrameElement, { readonly src: string; readonly title: string; readonly children: ReactNode }>(function EmbeddedDiagram({ src, title, children }, ref): ReactElement {
  return (
    <div className="dg-frame w-full overflow-hidden rounded border border-line bg-page">
      <iframe ref={ref} src={src} title={title} className="h-[32rem] w-full border-0" loading="lazy">{children}</iframe>
    </div>
  );
});
