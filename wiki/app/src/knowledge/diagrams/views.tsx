/**
 * The drawn views (decision 0026, "Diagrams"; madarch-m38l.15): C4 context, container and component, sequence, ER,
 * state and deployment, each under a switcher over every renderer that draws its type — LikeC4 for C4 and deployment,
 * archify and Mermaid wherever they can. The server draws from the graph and the page only chooses what to show:
 * this component holds a view's model, asks for another view when a reader drills down or goes up, and frames the
 * LikeC4 and archify documents the server makes, so their size stays out of the app until a reader opens the tab.
 *
 * Solid lines are facts and dashed lines are assumptions in every renderer; the list under the picture names each
 * element with its page and its code, and says why an arrow is dashed. A click on an element in any renderer opens
 * its page in a tab of the wiki.
 */
import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { ReactLikeC4, LikeC4ModelProvider, useDiagram, useOnDiagramEvent } from 'likec4/react';
import { LikeC4Model } from 'likec4/model';
import { useTranslation } from 'react-i18next';
import { ArrowLeftIcon, ChevronsDownIcon, MinusIcon, PlusIcon, ScanIcon } from 'lucide-react';
import { appBase } from '../../app-base.js';
import { MermaidDiagram } from '../../diagram.js';
import { Badge } from '@/components/ui/badge.js';
import { getViews, viewFrameAddress } from '../api.js';
import { CodePlace, KLink } from '../blocks.js';
import type { Block, DiagramRenderer, DiagramView, ViewElement } from '../types.js';
import { DiagramOpenContext } from './open.js';
import { Fullscreenable, useFullscreen } from './fullscreen.js';
import { firstView } from './first-view.js';
import { diagramTitleNodes } from '../../../../../src/knowledge/diagram-titles.js';

type DiagramsBlock = Extract<Block, { type: 'diagrams' }>;

const RENDERER_NAME: Record<DiagramRenderer, string> = { likec4: 'LikeC4', mermaid: 'Mermaid', archify: 'archify' };

/**
 * Makes the nodes of a drawn Mermaid svg links: the server names the boxes of a flowchart `n<position>` (a sequence's
 * lifelines too) and a state `s<position>`, and Mermaid keeps those names in its element ids.
 */
export function bindMermaid(root: HTMLElement, elements: readonly ViewElement[], type: string, open: (href: string) => void): () => void {
  // Mermaid's ER diagram gives an entity no click of its own (its boxes are drawn without the element ids a flowchart
  // carries): the tables are linked in the list under the picture instead, which every view has.
  if (type === 'er') return () => undefined;
  const undo: (() => void)[] = [];
  elements.forEach((element, index) => {
    if (element.href === null) return;
    const href = element.href;
    const selectors = type === 'state' ? [`[id^="state-s${index}-"]`]
      : type === 'sequence' ? [`[name="n${index}"]`]
        : [`[id^="flowchart-n${index}-"]`];
    for (const selector of selectors) {
      for (const node of Array.from(root.querySelectorAll<SVGElement>(selector))) {
        const target = node.closest('g') ?? node;
        const click = (event: Event): void => {
          const mouse = event as MouseEvent;
          if (mouse.shiftKey || mouse.altKey) return;
          open(href);
        };
        target.addEventListener('click', click);
        target.setAttribute('role', 'link');
        target.setAttribute('data-href', href);
        (target as SVGElement).style.cursor = 'pointer';
        undo.push(() => target.removeEventListener('click', click));
      }
    }
  });
  return () => undo.forEach((fn) => fn());
}

/** An explicit initial zoom avoids LikeC4's fixed controlled viewport when automatic fit is off. */
const LIKE_C4_SIZE = { minZoom: 0.05, maxZoom: 2.5, initialZoom: 1, fitView: false, fitViewPadding: 12 };

/**
 * A click on a LikeC4 element opens its page: LikeC4 reports the click as a diagram event, and the element's own id
 * names the address the server sent beside the model. It renders nothing — it is mounted inside the diagram so the
 * event reaches it.
 */
function NodeClicks({ links, onOpen, host, full, onReadable }: { links: Readonly<Record<string, string>>; onOpen: (href: string) => void; host: React.RefObject<HTMLDivElement | null>; full: boolean; onReadable: (readable: boolean) => void }): null {
  const diagram = useDiagram();
  // LikeC4 1.59 passes minZoom to React Flow but not its actor. Its actor fits again after initialization at 0.05.
  // Set the actor's own input too, then centre from its bounds (including non-zero origins), in the measured frame.
  useOnDiagramEvent('initialized', ({ instance }) => {
    diagram.send({ type: 'update.inputs', inputs: { minZoom: LIKE_C4_SIZE.minZoom, maxZoom: LIKE_C4_SIZE.maxZoom } });
    const apply = (): void => {
      const element = host.current?.querySelector('.dg-likec4-view');
      const root = element?.shadowRoot;
      const viewport = root?.querySelector<HTMLElement>('.react-flow__viewport');
      if (!root || !viewport || !element) return;
      const matrix = new DOMMatrix(getComputedStyle(viewport).transform);
      const origin = element.getBoundingClientRect();
      const nodes = [...root.querySelectorAll<HTMLElement>('.react-flow__node')].map((node) => node.getBoundingClientRect());
      const local = (node: Element) => {
        const r = node.getBoundingClientRect();
        return { x: (r.x - origin.x - matrix.e) / matrix.a, y: (r.y - origin.y - matrix.f) / matrix.a, width: r.width / matrix.a, height: r.height / matrix.a };
      };
      let titlePairs: ReturnType<typeof diagramTitleNodes>;
      try { titlePairs = diagramTitleNodes(root, 'likec4', ''); } catch (error) { console.error(error); onReadable(false); return; }
      const titles = titlePairs.map(({ title, node }) => ({ ...local(title as Element), font: parseFloat(getComputedStyle(title as Element).fontSize), node: local(node as Element) }));
      if (!titles.length || !nodes.length) return;
      const x = (Math.min(...nodes.map((r) => r.left)) - origin.x - matrix.e) / matrix.a;
      const y = (Math.min(...nodes.map((r) => r.top)) - origin.y - matrix.f) / matrix.a;
      const bounds = { x, y, width: (Math.max(...nodes.map((r) => r.right)) - origin.x - matrix.e) / matrix.a - x, height: (Math.max(...nodes.map((r) => r.bottom)) - origin.y - matrix.f) / matrix.a - y };
      const fit = firstView(bounds, titles, origin.width, origin.height, full);
      void instance.setViewport({ x: fit.x, y: fit.y, zoom: fit.zoom }, { duration: 0 }).then((ok: boolean) => {
        element.setAttribute('data-viewport-result', String(ok));
        element.setAttribute('data-viewport-read', JSON.stringify(instance.getViewport()));
      });
      element.setAttribute('data-first-viewport', JSON.stringify(fit));
      element.setAttribute('data-whole-fit', String(fit.whole));
      element.setAttribute('data-reading-window-valid', String(fit.readable));
      onReadable(fit.readable);

    };
    window.setTimeout(apply, 200);
  });
  useOnDiagramEvent('nodeClick', ({ node }) => {
    const href = links[node.modelRef ?? node.id] ?? links[node.id];
    if (href !== undefined) onOpen(href);
  });
  return null;
}

/** The frame of a LikeC4 or archify document; a click inside it arrives as a message and opens the page. */
function Frame({ view, renderer, lang, onOpen, onFailure }: { view: DiagramView; renderer: 'likec4' | 'archify'; lang: string; onOpen: (href: string) => void; onFailure?: (renderer: 'likec4' | 'archify', message: string) => void }): ReactElement {
  const { t } = useTranslation();
  const full = useFullscreen();
  const ref = useRef<HTMLIFrameElement | null>(null);
  const host = useRef<HTMLDivElement | null>(null);
  const [loaded, setLoaded] = useState(renderer === 'likec4');
  const [readable, setReadable] = useState(true);
  useEffect(() => { setReadable(true); }, [view.query, full]);
  const [layout, setLayout] = useState<{ query: string; model: ReturnType<typeof LikeC4Model.create>; elementLinks: Record<string, string> } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    if (renderer !== 'likec4') return;
    let alive = true;
    setLoaded(false);
    setLayout(null);
    setFailure(null);
    // A read that cannot start at all (a document without `fetch`, a page offline) says why beside the diagram: an
    // error thrown out of an effect takes the whole page down, and the tabs and the list stay readable without a picture.
    let asked: Promise<Response>;
    try {
      asked = globalThis.fetch(viewFrameAddress(view.query, renderer, lang));
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      setLoaded(true);
      return () => { alive = false; };
    }
    asked.then(async (response) => {
      if (!response.ok) {
        // The server refused the view: the renderer says it cannot draw it, so the view moves to one that did.
        const said = (await response.json().catch(() => ({}))) as { message?: string };
        throw Object.assign(new Error(said.message ?? `HTTP ${response.status}`), { refused: true });
      }
      const answer = await response.json() as { ok?: boolean; model?: unknown; elementLinks?: Record<string, string> };
      if (answer.ok !== true || answer.model === null || typeof answer.model !== 'object' || !answer.elementLinks || typeof answer.elementLinks !== 'object') throw new Error(t('knowledge.views.invalidModel'));
      return { model: answer.model, elementLinks: answer.elementLinks };
    }).then((answer) => { if (alive) { setLayout({ query: `${view.query}|${lang}`, model: LikeC4Model.create(answer.model as never), elementLinks: answer.elementLinks }); setLoaded(true); } }).catch((error: unknown) => {
      if (!alive) return;
      console.error(`the LikeC4 model of ${view.query} could not be read: ${error instanceof Error ? error.message : String(error)}`);
      setLayout(null);
      setFailure(error instanceof Error ? error.message : String(error));
      setLoaded(true);
      // Only a renderer's own refusal hands the view on. A document without `fetch` (a test, a page offline) leaves the
      // reader's renderer selected: nothing about it says it cannot draw.
      if ((error as { refused?: boolean }).refused === true) {
        setFailure(error instanceof Error ? error.message : String(error));
        onFailure?.('likec4', error instanceof Error ? error.message : String(error));
      }
    });
    return () => { alive = false; };
  }, [renderer, view.query, lang]);
  // Bind during the DOM commit: a cached iframe can report failure before passive effects run.
  useLayoutEffect(() => {
    if (renderer !== 'archify') return;
    setLoaded(false);
    setFailure(null);
    const listen = (event: MessageEvent): void => {
      if (event.source !== ref.current?.contentWindow || event.origin !== location.origin) return;
      const data = event.data as { madarch?: string; href?: unknown; renderer?: unknown; message?: unknown; readable?: unknown } | null;
      // A frame that could not draw says so: the app says it in one sentence and switches to a renderer that drew.
      if (data?.madarch === 'reading-window') { setReadable(data.readable === true); return; }
      if (data?.madarch === 'failed' && data.renderer === renderer && typeof data.message === 'string') {
        setFailure(data.message);
        onFailure?.(renderer, data.message);
        return;
      }
      if (data?.madarch !== 'open' || typeof data.href !== 'string') return;
      const base = appBase();
      onOpen(base !== '' && data.href.startsWith(`${base}/`) ? data.href.slice(base.length) : data.href);
    };
    window.addEventListener('message', listen);
    return () => window.removeEventListener('message', listen);
  }, [onOpen, onFailure, renderer, view.query]);
  const likeC4 = layout?.query === `${view.query}|${lang}` ? layout : null;
  const likeC4Model = likeC4?.model ?? null;
  const content = renderer === 'likec4' && likeC4Model
    ? (
      <LikeC4ModelProvider likec4model={likeC4Model}>
        <ReactLikeC4 key={`${view.query}|${full}`} className="dg-likec4-view" viewId="index" pannable zoomable controls {...LIKE_C4_SIZE}>
          <NodeClicks links={likeC4?.elementLinks ?? {}} onOpen={onOpen} host={host} full={full} onReadable={setReadable} />
        </ReactLikeC4>
      </LikeC4ModelProvider>
    )
    : null;
  return (
    <div ref={host} className="dg-frame-box" data-testid={`view-frame-${renderer}`}>
      <p className="dg-view-hint">{t('knowledge.views.readingHint')}</p>
      {!readable && <p className="diagram-error" role="alert" data-testid="reading-window-limit">{t('knowledge.views.readingLimit')}</p>}
      {!loaded && <p className="m-0 p-3 text-small text-muted" data-testid="view-frame-loading">{t(renderer === 'likec4' ? 'knowledge.views.loadingLikec4' : 'knowledge.views.loadingArchify')}</p>}
      {renderer === 'likec4' && (failure ? <p className="diagram-error" role="alert">{failure}</p> : content)}
      {renderer === 'archify' && <iframe ref={ref} key={`${view.query}|${renderer}`} title={`${RENDERER_NAME[renderer]}: ${view.title}`} src={`${viewFrameAddress(view.query, renderer, lang)}&fullscreen=${full ? '1' : '0'}`} loading="lazy" className={loaded ? 'dg-iframe' : 'dg-iframe dg-iframe-loading'} onLoad={() => setLoaded(true)} data-renderer={renderer} />}
    </div>
  );
}

function ElementRow({ element, onDrill, drilling }: { element: ViewElement; onDrill: (element: ViewElement) => void; drilling: boolean }): ReactElement {
  const { t } = useTranslation();
  return (
    <li className="dg-element" data-testid="view-element" data-element={element.id} data-dashed={element.dashed ? 'true' : undefined}>
      <span className="dg-element-name">
        {element.href === null ? <span>{element.label}</span> : <KLink href={element.href}>{element.label}</KLink>}
        {element.dashed && <Badge className="ml-1.5">{t('knowledge.views.assumption')}</Badge>}
      </span>
      {element.detail !== undefined && <span className="dg-element-detail">{element.detail}</span>}
      {element.parent !== undefined && <span className="dg-element-detail">{t('knowledge.views.owner', { id: element.parent })}</span>}
      {element.columns !== undefined && <ul className="dg-element-detail" data-testid="view-columns">{element.columns.map((column, index) => <li key={index}>{column.name} {column.type ?? 'text'}{column.key ? ' PK' : ''}{column.fk ? ' FK' : ''}</li>)}</ul>}
      {element.location !== undefined && <span className="dg-element-place"><CodePlace location={element.location} /></span>}
      {element.drill !== undefined && (
        <button type="button" className="dg-drill" onClick={() => onDrill(element)} disabled={drilling} data-testid="view-drill" aria-label={t('knowledge.views.drillLabel', { name: element.label, view: element.drill.title })}>
          <ChevronsDownIcon aria-hidden="true" className="size-3.5" />{element.drill.title}
        </button>
      )}
    </li>
  );
}

/** The zoom toolbar has SVG icons too; only the renderer's direct SVG is the drawing. */
export function mermaidPicture(root: HTMLElement): SVGSVGElement | null {
  return root.querySelector<SVGSVGElement>('[data-testid=mermaid-diagram] > svg');
}

/** Zoom for a Mermaid picture: the buttons, or Ctrl and the wheel; in full screen the picture fills the window and scrolls. */
function ZoomBox({ children }: { children: ReactElement }): ReactElement {
  const { t } = useTranslation();
  const full = useFullscreen();
  const [scale, setScale] = useState(1);
  const holder = useRef<HTMLDivElement | null>(null);
  const [readable, setReadable] = useState(true);
  useEffect(() => {
    const root = holder.current;
    if (!root) return;
    const fit = (): void => {
      const svg = mermaidPicture(root);
      if (!svg) return;
      const bounds = svg.getBBox();
      // Mermaid's own viewBox can omit the end of a long edge label. Include every drawn primitive.
      const all = [...svg.querySelectorAll<SVGGraphicsElement>('text, foreignObject, path, rect, polygon')].map((node) => {
        const r = node.getBoundingClientRect(), matrix = svg.getScreenCTM();
        if (!matrix || !r.width || !r.height) return null;
        const inverse = matrix.inverse();
        const a = new DOMPoint(r.left, r.top).matrixTransform(inverse), b = new DOMPoint(r.right, r.bottom).matrixTransform(inverse);
        return { x: a.x, y: a.y, right: b.x, bottom: b.y };
      }).filter((v) => v !== null);
      const x = Math.min(bounds.x, ...all.map((r) => r.x)) - 12, y = Math.min(bounds.y, ...all.map((r) => r.y)) - 12;
      const width = Math.max(bounds.x + bounds.width, ...all.map((r) => r.right)) - x + 12;
      const height = Math.max(bounds.y + bounds.height, ...all.map((r) => r.bottom)) - y + 12;
      svg.setAttribute('viewBox', `${x} ${y} ${width} ${height}`);
      const local = (node: Element) => {
        const r = node.getBoundingClientRect(), inverse = svg.getScreenCTM()!.inverse();
        const a = new DOMPoint(r.left, r.top).matrixTransform(inverse), b = new DOMPoint(r.right, r.bottom).matrixTransform(inverse);
        return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
      };
      const type = root.closest('[data-testid=view]')?.getAttribute('data-view') ?? '';
      let titlePairs: ReturnType<typeof diagramTitleNodes>;
      try { titlePairs = diagramTitleNodes(svg, 'mermaid', type); } catch (error) { console.error(error); setReadable(false); return; }
      const titles = titlePairs.map(({ title, node }) => {
        const element = title as Element;
        const leaves = [...element.querySelectorAll('text, foreignObject p')];
        return { ...local(element), font: Math.min(...(leaves.length ? leaves : [element]).map(leaf => parseFloat(getComputedStyle(leaf).fontSize))), node: local(node as Element) };
      });
      const edgeLabels = [...svg.querySelectorAll<SVGGraphicsElement>('g.edgeLabel, text.messageText, text.transition, .relationshipLabel')].map((node) => {
        const r = node.getBoundingClientRect(), inverse = svg.getScreenCTM()!.inverse();
        const a = new DOMPoint(r.left, r.top).matrixTransform(inverse), b = new DOMPoint(r.right, r.bottom).matrixTransform(inverse);
        return { x:a.x, y:a.y, width:b.x-a.x, height:b.y-a.y, font:parseFloat(getComputedStyle(node).fontSize) };
      });
      const fitted = firstView({ x, y, width, height }, titles, root.clientWidth, full ? Math.max(320, innerHeight - 230) : 520, full, edgeLabels);
      svg.style.setProperty('max-width', 'none');
      svg.style.width = `${width * fitted.zoom * scale}px`;
      svg.style.height = `${height * fitted.zoom * scale}px`;
      svg.style.marginLeft = `${Math.max(0, fitted.x + x * fitted.zoom)}px`;
      svg.style.marginTop = `${Math.max(0, fitted.y + y * fitted.zoom)}px`;
      svg.setAttribute('data-whole-fit', String(fitted.whole));
      svg.setAttribute('data-initial-scale', String(fitted.zoom * scale));
      root.scrollLeft = Math.max(0, -(fitted.x + x * fitted.zoom)); root.scrollTop = Math.max(0, -(fitted.y + y * fitted.zoom));
      svg.setAttribute('data-reading-window-valid', String(fitted.readable));
      setReadable(fitted.readable);
    };
    const mutation = new MutationObserver(() => { mutation.disconnect(); fit(); mutation.observe(root, { childList: true, subtree: true }); });
    mutation.observe(root, { childList: true, subtree: true });
    fit();
    const resize = new ResizeObserver(fit); resize.observe(root);
    return () => { mutation.disconnect(); resize.disconnect(); };
  }, [full, scale]);
  const set = (next: number): void => setScale(Math.min(4, Math.max(0.4, Math.round(next * 100) / 100)));
  return (
    <div ref={holder} className={full ? 'dg-zoombox dg-zoombox-full' : 'dg-zoombox'} data-testid="zoom-box" data-scale={scale}
      onWheel={(event) => { if (event.ctrlKey || event.metaKey) { event.preventDefault(); set(scale * (event.deltaY < 0 ? 1.12 : 1 / 1.12)); } }}>
      <p className="dg-view-hint">{t('knowledge.views.readingHint')}</p>
      {!readable && <p className="diagram-error" role="alert" data-testid="reading-window-limit">{t('knowledge.views.readingLimit')}</p>}
      <div className="dg-zoom-buttons">
        <button type="button" className="dg-chip" onClick={() => set(scale / 1.25)} aria-label={t('knowledge.views.zoomOut')} data-testid="zoom-out"><MinusIcon aria-hidden="true" className="size-3.5" /></button>
        <button type="button" className="dg-chip" onClick={() => set(scale * 1.25)} aria-label={t('knowledge.views.zoomIn')} data-testid="zoom-in"><PlusIcon aria-hidden="true" className="size-3.5" /></button>
        <button type="button" className="dg-chip" onClick={() => setScale(1)} aria-label={t('knowledge.views.zoomFit')} data-testid="zoom-fit"><ScanIcon aria-hidden="true" className="size-3.5" /></button>
      </div>
      <div className="dg-zoom-content">{children}</div>
    </div>
  );
}

/** One view under its renderer tabs. */
function ViewBody({ view, initial, onDrill, onUp, drilling, depth }: { view: DiagramView; initial: DiagramRenderer; onDrill: (element: ViewElement) => void; onUp: () => void; drilling: boolean; depth: number }): ReactElement {
  const { t, i18n } = useTranslation();
  const lang = i18n.resolvedLanguage ?? 'en';
  const open = useContext(DiagramOpenContext);
  const [chosen, setChosen] = useState<DiagramRenderer | null>(null);
  const [fellBack, setFellBack] = useState<{ renderer: DiagramRenderer; message: string } | null>(null);
  const renderer = chosen !== null && view.renderers.includes(chosen) ? chosen : view.renderers.includes(initial) ? initial : view.renderers[0]!;
  // A frame that could not draw hands the view to a renderer that did, and the page says so once, in one sentence.
  const onFailure = (failed: 'likec4' | 'archify', message: string): void => {
    const next = view.renderers.find((name) => name !== failed && name !== renderer) ?? view.renderers.find((name) => name !== failed);
    setFellBack({ renderer: failed, message });
    if (next !== undefined) setChosen(next);
  };
  const bind = useMemo(() => (root: HTMLElement) => bindMermaid(root, view.elements, view.spec.type, open), [view, open]);
  const stepped = view.edges.some((edge) => edge.step !== undefined);
  const listId = useId();
  const dashed = (view.fullEdges ?? view.edges).filter((edge) => edge.dashed);
  return (
    <div data-testid="view" data-view={view.spec.type} data-view-query={view.query} data-renderer={renderer} data-depth={depth} data-adjacent-list-count={stepped ? view.edges.length : (view.fullElements ?? view.elements).length}>
      <div className="dg-toolbar" role="group" aria-label={view.title}>
        {view.up !== undefined && (
          <button type="button" className="dg-chip" onClick={onUp} disabled={drilling} data-testid="view-up">
            <ArrowLeftIcon aria-hidden="true" className="mr-1 inline size-3.5" />{view.up.title}
          </button>
        )}
        <span className="dg-caption" data-testid="view-title">{view.title}</span>
        <span className="dg-spacer" />
        <div role="tablist" aria-label={t('knowledge.views.renderers')} className="dg-group">
          {view.renderers.map((name) => (
            <button key={name} type="button" role="tab" aria-selected={renderer === name} className="dg-chip" data-state={renderer === name ? 'on' : 'off'} data-testid={`renderer-${name}`} onClick={() => setChosen(name)}>
              {RENDERER_NAME[name]}
            </button>
          ))}
        </div>
      </div>
      {view.empty !== null ? <p className="m-0 p-3 text-small text-muted" data-testid="diagram-empty">{view.empty}</p> : (
        <div className="dg-picture" data-testid="view-picture">
          {renderer === 'mermaid' ? <ZoomBox><MermaidDiagram source={view.mermaidSource} title={view.title} bind={bind} /></ZoomBox> : <Frame view={view} renderer={renderer} lang={lang} onOpen={open} onFailure={onFailure} />}
          {fellBack !== null && <p className="dg-why" data-testid="renderer-fallback">{t('knowledge.views.rendererFailed', { renderer: RENDERER_NAME[fellBack.renderer] })} {fellBack.message}</p>}
        </div>
      )}
      {view.empty === null && (
        <div className="dg-legend" data-testid="view-legend">
          <span className="dg-legend-line"><svg width="34" height="8" aria-hidden="true"><line x1="1" y1="4" x2="33" y2="4" stroke="currentColor" strokeWidth="2" /></svg>{t('knowledge.views.fact')}</span>
          <span className="dg-legend-line"><svg width="34" height="8" aria-hidden="true"><line x1="1" y1="4" x2="33" y2="4" stroke="currentColor" strokeWidth="2" strokeDasharray="5 4" /></svg>{t('knowledge.views.assumed')}</span>
        </div>
      )}
      {view.marker !== null && <p className="dg-note" data-testid="view-marker">{view.marker} {view.fullElements !== undefined && <a href={`#${listId}`} data-testid="view-full-list-link">{t('knowledge.views.fullList', { count: view.fullElements.length })}</a>}</p>}
      {dashed.length > 0 && (
        <ul className="dg-why" data-testid="view-why">
          {[...new Set(dashed.map((edge) => `${edge.label}: ${edge.why ?? ''}`))].map((line) => <li key={line}>{line}</li>)}
        </ul>
      )}
      {view.notes.map((note) => <p key={note} className="dg-note" data-testid="view-note">{note}</p>)}
      {view.empty === null && (
        stepped ? (
          <ol className="dg-steps" data-testid="view-steps">
            {view.edges.map((edge) => (
              <li key={edge.step} data-adjacent-key={JSON.stringify([edge.step ?? null, edge.from, edge.to, edge.label, edge.href ?? null])} data-dashed={edge.dashed ? 'true' : undefined} data-testid="view-step">
                <span className="dg-step-n">{edge.step}</span>
                {edge.href === null || edge.href === undefined ? <span>{edge.label}</span> : <KLink href={edge.href}>{edge.label}</KLink>}
                {edge.location !== undefined && <span className="dg-element-place"><CodePlace location={edge.location} /></span>}
                {edge.dashed && <Badge className="ml-1.5">{t('knowledge.views.unordered')}</Badge>}
                {edge.note !== undefined && <span className="dg-element-detail">{edge.note}</span>}
              </li>
            ))}
          </ol>
        ) : (
          <div id={listId} data-testid="view-full-list">
            {view.fullElements !== undefined && <h3>{t('knowledge.views.fullList', { count: view.fullElements.length })}</h3>}
            <ul className="dg-elements" data-testid="view-elements">
              {(view.fullElements ?? view.elements).map((element) => {
                const folded = view.elements.find(candidate => candidate.id === element.id && candidate.standsFor !== undefined);
                return <ElementRow key={element.id} element={folded?.drill ? { ...element, drill: folded.drill } : element} onDrill={onDrill} drilling={drilling} />;
              })}
            </ul>
            {view.fullEdges !== undefined && <ul className="dg-why" data-testid="view-full-relationships">
              {view.fullEdges.map((edge, index) => <li key={index}>{(view.fullElements ?? view.elements).find(element => element.id === edge.from)?.label ?? edge.from} → {(view.fullElements ?? view.elements).find(element => element.id === edge.to)?.label ?? edge.to}: {edge.label}{edge.why ? ` (${edge.why})` : ''}</li>)}
            </ul>}
          </div>
        )
      )}
    </div>
  );
}

/** The views of a block: the switcher between them, and the drill-down trail of the one open. */
export function DiagramsView({ block }: { block: DiagramsBlock }): ReactElement | null {
  const { t, i18n } = useTranslation();
  const lang = i18n.resolvedLanguage ?? 'en';
  const [index, setIndex] = useState(0);
  // The views opened by drilling down, over the block's own: the last is the one shown.
  const [trail, setTrail] = useState<{ base: number; views: DiagramView[] }>({ base: 0, views: [] });
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = trail.views.length > 0 && trail.base === index ? trail.views[trail.views.length - 1]! : block.views[index] ?? block.views[0];
  const ask = useCallback(async (query: string): Promise<DiagramView | null> => {
    setBusy(true);
    setFailure(null);
    try {
      const answer = await getViews(query, lang);
      const [view] = answer.views;
      if (view === undefined) throw new Error(t('knowledge.views.nothing'));
      return view;
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setBusy(false);
    }
  }, [lang, t]);
  const drill = useCallback(async (element: ViewElement): Promise<void> => {
    if (element.drill === undefined) return;
    const query = new URLSearchParams({ type: element.drill.spec.type, subject: element.drill.spec.subject });
    if (element.drill.spec.scope !== undefined) query.set('scope', element.drill.spec.scope);
    if (element.drill.spec.entry !== undefined) query.set('entry', element.drill.spec.entry);
    const view = await ask(query.toString());
    if (view !== null) setTrail((held) => ({ base: index, views: held.base === index ? [...held.views, view] : [view] }));
  }, [ask, index]);
  const up = useCallback(async (): Promise<void> => {
    // One step up: back to the view the reader came from; with none, the view the spec names as above.
    if (trail.views.length > 1 && trail.base === index) {
      setTrail({ base: index, views: trail.views.slice(0, -1) });
      return;
    }
    if (trail.views.length === 1 && trail.base === index) {
      setTrail({ base: index, views: [] });
      return;
    }
    const above = shown?.up;
    if (above === undefined) return;
    const query = new URLSearchParams({ type: above.spec.type, subject: above.spec.subject });
    if (above.spec.scope !== undefined) query.set('scope', above.spec.scope);
    const view = await ask(query.toString());
    if (view !== null) setTrail({ base: index, views: [view] });
  }, [ask, index, shown, trail]);
  if (shown === undefined) return null;
  return (
    <section data-block="diagram" data-diagram="views" aria-label={block.title}>
      {block.title !== '' && <h2>{block.title}</h2>}
      {block.views.length > 1 && (
        <div role="tablist" aria-label={t('knowledge.views.views')} className="dg-switcher" data-testid="view-switcher">
          {block.views.map((view, at) => (
            <button key={`${view.query}`} type="button" role="tab" aria-selected={index === at} className="dg-chip" data-state={index === at ? 'on' : 'off'} onClick={() => { setIndex(at); setTrail({ base: at, views: [] }); }} data-testid="view-tab">
              {view.label}
            </button>
          ))}
        </div>
      )}
      <Fullscreenable>
       <div className="dg-frame">
        <ViewBody view={shown} initial={block.renderer} onDrill={(element) => { void drill(element); }} onUp={() => { void up(); }} drilling={busy} depth={trail.base === index ? trail.views.length : 0} />
       </div>
      </Fullscreenable>
      {failure !== null && <p className="ref-broken" data-testid="diagram-failure">{failure}</p>}
    </section>
  );
}
