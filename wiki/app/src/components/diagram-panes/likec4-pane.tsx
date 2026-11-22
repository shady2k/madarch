/**
 * The LikeC4 tab: the server's computed view, rendered by LikeC4's own React runtime in the browser — pan, zoom, hover
 * highlight — with a press on a node walking to the entity's page the server named for it. No layout happens here: the
 * positions and the model are the server's answer.
 */
import { useEffect, useId, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Metadata, Stack } from '../ui/typography.js';
import type { LikeC4Answer } from '../diagram-types.js';
import { linkOfNode } from '../diagram-links.js';

const MODEL_VIEW = {
  viewId: "index",
} as const;

/** The palette overrides the LikeC4 runtime needs; its own blue is replaced with the kit's neutral tokens. */
export const LIKE_C4_THEME_CSS = `/* Unlayered, so these win over the runtime's own tokens, which stand in @layer tokens: the canvas, the labels and the
   controls read from the kit's palette in both schemes (madarch-64o5.96). */
:host, :host > *, [data-mantine-color-scheme], [data-mantine-color-scheme="dark"], [data-mantine-color-scheme="light"] {
  --colors-diagram-background: var(--surface-page);
  --colors-diagram-background-pattern: var(--border-subtle);
  --colors-surface-canvas: var(--surface-page);
  --colors-surface-default: var(--surface-card);
  --colors-surface-sunken: var(--surface-soft);
  --colors-text: var(--text);
  --colors-text-default: var(--text);
  --colors-text-bright: var(--text);
  --colors-text-dimmed: var(--text-muted);
  --colors-text-heading: var(--text);
  --colors-text-display: var(--text);
  --colors-text-link: var(--link);
  --colors-border-default: var(--border);
  --colors-border-subtle: var(--border-subtle);
  --colors-border-outline: var(--border);
  --colors-border-strong: var(--text-muted);
}
.likec4-shadow-root, .likec4-root {
  --likec4-palette-fill: var(--surface-active);
  --likec4-palette-stroke: var(--border);
  --likec4-palette-hiContrast: var(--text);
  --likec4-palette-loContrast: var(--text-secondary);
  --likec4-palette-relation-stroke: var(--border);
  --likec4-palette-relation-label: var(--text);
  --likec4-palette-relation-label-bg: var(--surface-page);
}
.likec4-root [data-likec4-color] {
  --likec4-palette-fill: var(--surface-active) !important;
  --likec4-palette-stroke: var(--border) !important;
  --likec4-palette-hiContrast: var(--text) !important;
  --likec4-palette-loContrast: var(--text-secondary) !important;
}`;

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
  const { t } = useTranslation();
  const [pane, setPane] = useState<ReactElement | null>(null);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const themeId = useId();
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
            <ReactLikeC4 viewId={MODEL_VIEW.viewId} className="dg-likec4-view" pannable zoomable controls fitViewPadding={12}>
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
  useEffect(() => {
    const wrapper = document.getElementById(themeId);
    const host = wrapper?.querySelector('.dg-likec4-view') as HTMLElement | null;
    const root = host?.shadowRoot;
    if (root === undefined || root === null) return;
    let style = root.querySelector<HTMLStyleElement>('style[data-madarch-likec4-theme]');
    if (style === null) {
      style = document.createElement('style');
      style.dataset['madarchLikec4Theme'] = 'true';
      style.textContent = LIKE_C4_THEME_CSS;
      root.append(style);
    }
    // The page's own entity stands out: its element takes the focus pair of the kit's palette, which its shapes inherit
    // (madarch-64o5.96).
    const focus = answer === undefined || answer.root === '' ? null : root.querySelector<HTMLElement>(`[data-id="${answer.root}"]`);
    if (focus !== null) {
      focus.style.setProperty('--likec4-palette-fill', 'var(--surface-soft)');
      focus.style.setProperty('--likec4-palette-stroke', 'var(--text)');
      focus.style.setProperty('--likec4-palette-hiContrast', 'var(--text)');
    }
    // A node whose shown name is its last segment carries the whole path as its hover text (madarch-64o5.96).
    for (const [id, title] of Object.entries(answer?.titles ?? {})) {
      root.querySelector<HTMLElement>(`[data-id="${id}"]`)?.setAttribute('title', title);
    }
  }, [pane, themeId, answer]);

  if (answer === undefined) return <Metadata>{t('knowledge.loadingPicture')}</Metadata>;
  if (failed !== undefined) return <Metadata>{failed}</Metadata>;
  return <Stack id={themeId} className="contents">{pane ?? <Metadata>{t('knowledge.loadingPicture')}</Metadata>}</Stack>;
}
