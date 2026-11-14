/**
 * The LikeC4 tab: the server's computed view, rendered by LikeC4's own React runtime in the browser — pan, zoom, hover
 * highlight — with a press on a node walking to the entity's page the server named for it. No layout happens here: the
 * positions and the model are the server's answer.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { Muted } from '../ui/typography.js';
import type { LikeC4Answer } from '../diagram-types.js';
import { linkOfNode } from '../diagram-links.js';

/** One press on a LikeC4 node: the diagram event names the element, and the server's link map names the page. */
function NodeClicks({ links, open }: { readonly links: Readonly<Record<string, string>>; readonly open: (path: string) => void }): ReactElement {
  const [ready, setReady] = useState<ReactElement | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const { useDiagram, useOnDiagramEvent } = await import('likec4/react');
      if (!alive) return;
      function Clicks(): null {
        const diagram = useDiagram();
        void diagram;
        useOnDiagramEvent('nodeClick', ({ node }) => {
          const href = linkOfNode(links, node as { id?: unknown; modelRef?: unknown });
          if (href !== undefined) open(href);
        });
        return null;
      }
      setReady(<Clicks />);
    })();
    return () => { alive = false; };
  }, [links, open]);
  return ready ?? <></>;
}

export function LikeC4Pane({ answer, open }: { readonly answer: LikeC4Answer | undefined; readonly open: (path: string) => void }): ReactElement {
  const [pane, setPane] = useState<ReactElement | null>(null);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const key = answer === undefined ? '' : JSON.stringify(answer.links ?? {}).length + String(answer.view === undefined);
  useEffect(() => {
    if (answer === undefined) return;
    let alive = true;
    void (async () => {
      try {
        const [{ LikeC4Model }, { LikeC4ModelProvider, ReactLikeC4 }] = await Promise.all([import('likec4/model'), import('likec4/react')]);
        if (!alive) return;
        const model = LikeC4Model.create(answer.view as never);
        setPane(
          <LikeC4ModelProvider likec4model={model}>
            <ReactLikeC4 viewId="index" className="dg-likec4-view" pannable zoomable controls fitViewPadding={12}>
              <NodeClicks links={answer.links ?? {}} open={open} />
            </ReactLikeC4>
          </LikeC4ModelProvider>,
        );
        setFailed(undefined);
      } catch (error) {
        if (alive) setFailed(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (answer === undefined) return <Muted>Loading the picture…</Muted>;
  if (failed !== undefined) return <Muted>{failed}</Muted>;
  return pane ?? <Muted>Loading the picture…</Muted>;
}
