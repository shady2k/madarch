/**
 * The Mermaid tab: the server's flowchart source, drawn by Mermaid's own renderer in the browser. The theme is the kit's
 * palette of the current scheme (madarch-64o5.96), so nodes, labels, edges and their chips read in light and dark; the
 * source's `click` lines name each node's page, the drawn anchors are followed with the app's own navigation, and the
 * picture fits its box with zoom and pan.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button.js';
import { Metadata } from '../ui/typography.js';
import { DiagramScaled, DiagramZoomBar, DiagramZoomBox } from '../ui/drawing.js';
import type { MermaidAnswer } from '../diagram-types.js';
import { readDiagramTheme, type DiagramTheme } from '../diagram-theme.js';
import { fitScale, pans, zoomStep, type Size } from '../diagram-zoom.js';

/** Mermaid's theme variables, from the kit's palette: the renderer has no access to the tokens itself. */
export function mermaidThemeVariables(theme: DiagramTheme): Record<string, string> {
  return {
    background: theme.canvas,
    primaryColor: theme.nodeFill,
    primaryTextColor: theme.nodeText,
    primaryBorderColor: theme.nodeBorder,
    secondaryColor: theme.nodeFill,
    secondaryTextColor: theme.nodeText,
    secondaryBorderColor: theme.nodeBorder,
    tertiaryColor: theme.nodeFill,
    tertiaryTextColor: theme.nodeText,
    tertiaryBorderColor: theme.nodeBorder,
    mainBkg: theme.nodeFill,
    nodeBorder: theme.nodeBorder,
    nodeTextColor: theme.nodeText,
    lineColor: theme.edge,
    textColor: theme.nodeText,
    titleColor: theme.nodeText,
    edgeLabelBackground: theme.edgeLabelBg,
    clusterBkg: theme.canvas,
    clusterBorder: theme.nodeBorder,
    fontFamily: 'var(--font-sans)',
    fontSize: '15px',
  };
}

/** The scheme on screen, so a picture drawn in one scheme is drawn again in the other. */
function useScheme(): 'light' | 'dark' {
  const [scheme, setScheme] = useState<'light' | 'dark'>(() => (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (): void => setScheme(query.matches ? 'dark' : 'light');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return scheme;
}

export function MermaidPane({ answer, open }: { readonly answer: MermaidAnswer | undefined; readonly open: (path: string) => void }): ReactElement {
  const { t } = useTranslation();
  const holder = useRef<HTMLDivElement | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [size, setSize] = useState<Size | null>(null);
  const [box, setBox] = useState<Size>({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<number | null>(null);
  const [fit, setFit] = useState(1);
  // Mermaid hands back the handlers that attach its tooltips; without them a shortened label keeps no whole path.
  const bind = useRef<((element: Element) => void) | undefined>(undefined);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const scheme = useScheme();
  const source = answer?.source ?? '';
  useEffect(() => {
    if (source === '') return;
    let alive = true;
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme: 'base', themeVariables: mermaidThemeVariables(readDiagramTheme()), flowchart: { curve: 'linear', useMaxWidth: false, htmlLabels: false } });
        const drawn = await mermaid.render(`diagram-${String(Math.random()).slice(2)}`, source);
        if (!alive) return;
        bind.current = drawn.bindFunctions === undefined ? undefined : (element: Element) => drawn.bindFunctions?.(element);
        setSvg(drawn.svg);
        setFailed(undefined);
      } catch (error) {
        if (alive) setFailed(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => { alive = false; };
  }, [source, scheme]);
  // A press on a node's anchor opens the entity's page through the app, never a full page load.
  useEffect(() => {
    const root = holder.current;
    if (root === null || svg === null) return;
    const follow = (event: MouseEvent): void => {
      const anchor = (event.target as Element | null)?.closest('a');
      // Mermaid writes the link as `xlink:href` in the SVG, so the plain attribute is often empty (madarch-64o5.98).
      const href = anchor?.getAttribute('href') || anchor?.getAttribute('xlink:href') || '';
      if (href === '' || event.metaKey || event.ctrlKey) return;
      event.preventDefault();
      open(href);
    };
    root.addEventListener('click', follow);
    return () => root.removeEventListener('click', follow);
  }, [svg, open]);
  // The natural size of the drawn picture, and the fit that shows it whole: a diagram fits its box by default.
  useLayoutEffect(() => {
    const frame = holder.current;
    if (frame === null || svg === null) return;
    // Mermaid's own tooltip and hover handlers go on the frame the picture was drawn into (madarch-64o5.96).
    bind.current?.(frame);
    const drawn = frame.querySelector('svg');
    const width = Number(drawn?.getAttribute('width') ?? 0);
    const height = Number(drawn?.getAttribute('height') ?? 0);
    if (width <= 0 || height <= 0) return;
    const picture = { width, height };
    setSize(picture);
    // The box's height is its cap (the frame scrolls past 72vh): a fit that reads only the width left a tall picture
    // standing out of its frame. It is never the box's own current height, which is the fitted picture's height — reading
    // that made every ResizeObserver pass shrink an already fitted picture.
    const capOf = (element: HTMLElement): number => {
      const max = getComputedStyle(element).maxHeight;
      if (max.endsWith('px')) return Number.parseFloat(max);
      if (max.endsWith('vh')) return Math.round(window.innerHeight * Number.parseFloat(max) / 100);
      return element.clientHeight;
    };
    const measure = (): void => {
      const held = { width: frame.clientWidth, height: capOf(frame) };
      setBox((current) => current.width === held.width && current.height === held.height ? current : held);
      const next = fitScale(picture, held);
      setFit((current) => current === next ? current : next);
    };
    measure();
    const watcher = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    watcher?.observe(frame);
    return () => watcher?.disconnect();
  }, [svg]);
  const scale = zoom ?? fit;
  const canPan = size !== null && pans(size, scale, box);
  const step = useCallback((factor: number): void => setZoom(zoomStep(scale, factor)), [scale]);
  // Drag inside the box pans it, as a reader expects of a picture larger than its frame.
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  if (answer === undefined) return <Metadata>{t('knowledge.loadingPicture')}</Metadata>;
  if (failed !== undefined) return <Metadata>{failed}</Metadata>;
  return svg === null ? <Metadata>{t('knowledge.loadingPicture')}</Metadata> : (
    <div data-testid="mermaid-pane-zoom">
      <DiagramZoomBar>
        <Button size="icon-sm" variant="default" aria-label={t('knowledge.diagramZoomOut')} onClick={() => step(1 / 1.25)} data-testid="diagram-zoom-out">{t('common.zoomOutSymbol')}</Button>
        <Button size="icon-sm" variant="default" aria-label={t('knowledge.diagramZoomIn')} onClick={() => step(1.25)} data-testid="diagram-zoom-in">{t('common.zoomInSymbol')}</Button>
        <Button size="sm" variant="default" onClick={() => setZoom(null)} data-testid="diagram-zoom-fit">{t('knowledge.diagramFit')}</Button>
        {zoom === null ? null : <Metadata data-testid="diagram-zoom-level">{`${String(Math.round(scale * 100))}%`}</Metadata>}
      </DiagramZoomBar>
      <DiagramZoomBox
        ref={holder}
        pannable={canPan}
        className="dg-mermaid"
        data-testid="mermaid-pane"
        onPointerDown={(event) => { if (!canPan) return; const held = event.currentTarget; drag.current = { x: event.clientX, y: event.clientY, left: held.scrollLeft, top: held.scrollTop }; }}
        onPointerMove={(event) => { const held = drag.current; if (held === null) return; event.currentTarget.scrollLeft = held.left - (event.clientX - held.x); event.currentTarget.scrollTop = held.top - (event.clientY - held.y); }}
        onPointerUp={() => { drag.current = null; }}
        onPointerLeave={() => { drag.current = null; }}
      >
        <DiagramScaled zoom={scale} {...(size === null ? {} : { width: size.width })} html={svg} />
      </DiagramZoomBox>
    </div>
  );
}
