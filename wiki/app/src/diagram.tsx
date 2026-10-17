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
export function mermaidThemeOf(scheme: 'light' | 'dark'): 'default' | 'dark' {
  return scheme === 'dark' ? 'dark' : 'default';
}

/** The reader's colour scheme, live. */
export function useColorScheme(): 'light' | 'dark' {
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

/** Renders one Mermaid source into the box; a failed draw is the named failure. */
export function MermaidDiagram({ source, title }: { source: string; title?: string }): ReactElement {
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
          flowchart: { curve: 'linear', useMaxWidth: true, htmlLabels: false },
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
  if (failed !== null) {
    return (
      <p className="diagram-error" data-testid="mermaid-error">
        {t('diagram.mermaidFailed', { title: title ?? '', message: failed })}
      </p>
    );
  }
  // The drawn svg is the renderer's own output, shown as markup; the
  // source itself is never interpolated (securityLevel strict above).
  return (
    <div
      className="diagram-mermaid"
      data-testid="mermaid-diagram"
      ref={holder}
      { ...(svg === null ? {} : { dangerouslySetInnerHTML: { __html: svg } }) }
    />
  );
}

/** The server's LikeC4 bundle, asked once per tab and kept. */
let likec4State: 'unasked' | 'loading' | 'ready' | 'failed' = 'unasked';
const likec4Listeners = new Set<() => void>();

function setLikec4State(next: 'unasked' | 'loading' | 'ready' | 'failed'): void {
  likec4State = next;
  for (const listener of likec4Listeners) listener();
}

/** Asks for the LikeC4 bundle once; safe to call from every view's mount. */
function ensureLikec4(): void {
  if (likec4State !== 'unasked') return;
  setLikec4State('loading');
  const script = document.createElement('script');
  script.src = appPath('/api/architecture/likec4.js');
  script.onload = () => noteLikec4ScriptReady();
  script.onerror = () => setLikec4State('failed');
  document.head.appendChild(script);
}

/**
 * Marks the bundle loaded (the script's onload, and the tests, which stub
 * the element instead of loading 2.6 MB into happy-dom).
 */
export function noteLikec4ScriptReady(): void {
  setLikec4State('ready');
}

/** Follows the one LikeC4 ask's state. */
function useLikec4State(): 'unasked' | 'loading' | 'ready' | 'failed' {
  const [state, setState] = useState(likec4State);
  useEffect(() => {
    const follow = (): void => setState(likec4State);
    likec4Listeners.add(follow);
    return () => {
      likec4Listeners.delete(follow);
    };
  }, []);
  return state;
}

/** Whether the LikeC4 element is defined in this browser. */
function likec4Defined(): boolean {
  return typeof window !== 'undefined' && window.customElements !== undefined && window.customElements.get('likec4-view') !== undefined;
}

/** One LikeC4 view, the webcomponent against the served bundle. */
export function LikeC4Diagram({ viewId, title }: { viewId: string; title?: string }): ReactElement {
  const { t } = useTranslation();
  const state = useLikec4State();
  const scheme = useColorScheme();
  const [defined, setDefined] = useState(likec4Defined);
  const [timedOut, setTimedOut] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    ensureLikec4();
  }, []);
  useEffect(() => {
    if (state !== 'ready') return;
    let tries = 0;
    const wait = (): void => {
      if (likec4Defined()) {
        setDefined(true);
        return;
      }
      // The element never defined: say so, never spin on Loading forever.
      if (tries++ > 100) {
        setTimedOut(true);
        return;
      }
      window.setTimeout(wait, 50);
    };
    wait();
  }, [state]);
  useEffect(() => {
    // The component sizes its view to the box; a nudge after the mount
    // redraws at the measured width (the static wiki's own behaviour).
    if (!defined) return;
    const timer = window.setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
    return () => window.clearTimeout(timer);
  }, [defined, viewId]);
  if (state === 'failed' || timedOut) {
    return <p className="diagram-error" data-testid="likec4-error">{t('diagram.likec4Failed', { title: title ?? '' })}</p>;
  }
  return (
    <div className="diagram-likec4" data-testid="likec4-diagram" ref={box}>
      {state === 'loading' || !defined ? <p className="diagram-loading">{t('diagram.likec4Loading')}</p> : null}
      {defined ? <likec4-view view-id={viewId} color-scheme={scheme} /> : null}
    </div>
  );
}

import type { JSX as ReactJSX } from 'react';
import { appPath } from './app-base.js';

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'likec4-view': { 'view-id': string; 'color-scheme'?: 'light' | 'dark' };
    }
  }
}
