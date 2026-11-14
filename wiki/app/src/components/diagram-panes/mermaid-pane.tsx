/**
 * The Mermaid tab: the server's flowchart source, drawn by Mermaid's own renderer in the browser. The source's `click`
 * lines name each node's page; the drawn anchors are followed with the app's own navigation.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Muted } from '../ui/typography.js';
import { DiagramFrame } from '../ui/drawing.js';
import type { MermaidAnswer } from '../diagram-types.js';

export function MermaidPane({ answer, open }: { readonly answer: MermaidAnswer | undefined; readonly open: (path: string) => void }): ReactElement {
  const holder = useRef<HTMLDivElement | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const source = answer?.source ?? '';
  useEffect(() => {
    if (source === '') return;
    let alive = true;
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme: 'default', flowchart: { curve: 'linear', useMaxWidth: false, htmlLabels: false } });
        const drawn = await mermaid.render(`diagram-${String(Math.random()).slice(2)}`, source);
        if (!alive) return;
        setSvg(drawn.svg);
        setFailed(undefined);
      } catch (error) {
        if (alive) setFailed(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => { alive = false; };
  }, [source]);
  // A press on a node's anchor opens the entity's page through the app, never a full page load.
  useEffect(() => {
    const root = holder.current;
    if (root === null || svg === null) return;
    const follow = (event: MouseEvent): void => {
      const anchor = (event.target as Element | null)?.closest('a');
      const href = anchor?.getAttribute('href') ?? '';
      if (href === '' || event.metaKey || event.ctrlKey) return;
      event.preventDefault();
      open(href);
    };
    root.addEventListener('click', follow);
    return () => root.removeEventListener('click', follow);
  }, [svg, open]);
  if (answer === undefined) return <Muted>Loading the picture…</Muted>;
  if (failed !== undefined) return <Muted>{failed}</Muted>;
  return <DiagramFrame ref={holder} label="Mermaid">{svg === null ? <Muted>Loading the picture…</Muted> : <span dangerouslySetInnerHTML={{ __html: svg }} />}</DiagramFrame>;
}
