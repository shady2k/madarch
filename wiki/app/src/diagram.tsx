import { DrawingSurface } from '@/components/ui/drawing.js';
import { Paragraph } from '@/components/ui/typography.js';
/**
 * The two diagram renderers of the Architecture section (feature E,
 * madarch-iuc.15): a Mermaid flowchart drawn in the browser from the
 * renderer's own source (the pinned mermaid of wiki/app's dependencies,
 * imported once, drawn per view into the element), and the LikeC4
 * webcomponent (the server's /api/architecture/likec4.js bundle, the same
 * generation the static wiki ships) shown for a view id.
 *
 * Both themes: the Mermaid theme follows the reader's colour scheme
 * (prefers-color-scheme) through a media query listener, and the LikeC4
 * component takes its `color-scheme` attribute. Both are bounded: a
 * Mermaid parse or draw that fails shows the failure as text, naming the
 * view, never an empty box; the LikeC4 script is asked once and its
 * absence is shown, not waited on forever.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

/** Mermaid's module, imported once at the first draw. */
type MermaidModule = typeof import('mermaid');
let mermaidModule: MermaidModule | undefined;

/** Reads the reader's colour scheme as Mermaid's own theme name. */
function mermaidThemeOf(scheme: 'light' | 'dark'): 'default' | 'dark' {
  return scheme === 'dark' ? 'dark' : 'default';
}

/** The reader's colour scheme, live. */
function useColorScheme(): 'light' | 'dark' {
  const [scheme, setScheme] = useState<'light' | 'dark'>(() =>
    typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  );
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const follow = (event: MediaQueryListEvent): void => setScheme(event.matches ? 'dark' : 'light');
    query.addEventListener('change', follow);
    return () => query.removeEventListener('change', follow);
  }, []);
  return scheme;
}

/**
 * Renders one Mermaid source into the box; a failed draw is the named failure.
 * `place` names where the source stands for a failure that is not a view's own
 * (a fence in a document, madarch-u3vw.18); `bind` runs on the drawn svg (it
 * makes its nodes links) and may return what undoes it.
 */
export function MermaidDiagram({ source, title, bind, place }: { source: string; title?: string; bind?: (root: HTMLElement) => void | (() => void); place?: string }): ReactElement {
  const { t } = useTranslation();
  const [failed, setFailed] = useState<string | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const scheme = useColorScheme();
  const holder = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let alive = true;
    (async (): Promise<void> => {
      try {
        mermaidModule ??= await import('mermaid');
        const mermaid = mermaidModule.default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: mermaidThemeOf(scheme),
          // A diagram is drawn at its natural size and the frame scrolls or pans over it: a picture squeezed into a
          // narrow column would keep its shape and lose its words (the owner's review of 2026-10-24 read 2-3 px labels).
          flowchart: { curve: 'linear', useMaxWidth: false, htmlLabels: false },
          sequence: { useMaxWidth: false },
          er: { useMaxWidth: false },
          state: { useMaxWidth: false },
        });
        const id = `wiki-mermaid-${Math.random().toString(36).slice(2)}`;
        const drawn = await mermaid.render(id, source);
        if (!alive) return;
        if (drawn.svg === undefined) throw new Error('mermaid.render answered no svg');
        setSvg(drawn.svg);
        setFailed(null);
      } catch (error: unknown) {
        if (!alive) return;
        setFailed(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      alive = false;
    };
  }, [source, scheme]);
  useEffect(() => {
    if (svg === null || holder.current === null || bind === undefined) return;
    return bind(holder.current) ?? undefined;
  }, [svg, bind]);
  if (failed !== null) {
    return (
      <Paragraph className="diagram-error" data-testid="mermaid-error">
        {place === undefined
          ? t('diagram.mermaidFailed', { title: title ?? '', message: failed })
          : t('diagram.mermaidFailedAt', { place, message: failed })}
      </Paragraph>
    );
  }
  // The drawn svg is the renderer's own output, shown as markup; the
  // source itself is never interpolated (securityLevel strict above). Until it
  // stands, the box says what it is waiting for: the box is drawn with a border
  // and a background, so an empty one is a frame a reader reads as a diagram
  // nobody could draw (madarch-tzte.23.7).
  return (
    <DrawingSurface
      className="diagram-mermaid"
      data-testid="mermaid-diagram"
      ref={holder}
      { ...(svg === null ? {} : { dangerouslySetInnerHTML: { __html: svg } }) }
    >
      {svg === null ? <Paragraph className="diagram-loading" data-testid="mermaid-loading">{t('diagram.mermaidLoading')}</Paragraph> : null}
    </DrawingSurface>
  );
}


declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'likec4-view': { 'view-id': string; 'color-scheme'?: 'light' | 'dark' };
    }
  }
}
