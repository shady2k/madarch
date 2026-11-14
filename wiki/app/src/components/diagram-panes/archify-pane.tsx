/**
 * The archify tab: the server's own interactive HTML page, embedded as it is. The page pans, zooms, opens a node's
 * passport and posts a press on a node to its parent; the app walks to the entity's page that press names.
 */
import { useEffect, useRef, type ReactElement } from 'react';
import { Muted } from '../ui/typography.js';
import { EmbeddedDiagram } from '../ui/drawing.js';

export function ArchifyPane({ src, root, open }: { readonly src: string; readonly root: HTMLElement | null; readonly open: (path: string) => void }): ReactElement {
  const frame = useRef<HTMLIFrameElement | null>(null);
  useEffect(() => {
    const listen = (event: MessageEvent): void => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as { madarch?: unknown; href?: unknown } | null;
      if (data?.madarch !== 'open' || typeof data.href !== 'string') return;
      open(data.href);
    };
    window.addEventListener('message', listen);
    return () => window.removeEventListener('message', listen);
  }, [open]);
  return (
    <EmbeddedDiagram ref={frame} src={`${root === null ? '' : location.origin}${src}`} title="archify">
      <Muted>Loading the picture…</Muted>
    </EmbeddedDiagram>
  );
}
