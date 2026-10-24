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
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { LikeC4View, LikeC4ModelProvider, useOnDiagramEvent } from 'likec4/react';
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

type DiagramsBlock = Extract<Block, { type: 'diagrams' }>;

const RENDERER_NAME: Record<DiagramRenderer, string> = { likec4: 'LikeC4', mermaid: 'Mermaid', archify: 'archify' };

/** Mermaid's own entity names for an ER table (the server writes the same). */
const erName = (label: string): string => label.replace(/[^A-Za-z0-9_]/g, '_');

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
    // An ER picture is a flowchart like the C4 ones now (its tables are nodes with their columns on the box), so it
    // finds its boxes the way every flowchart does.
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

/**
 * The fit a view opens at: fitted to its frame when the fit keeps the labels at least 12 px, else the smallest zoom that
 * does (LikeC4 draws its labels at 14 px, so 12/14 is the floor), centred on the view. Full screen fits the screen, which
 * is what its frame gives it. The props reach `LikeC4Diagram`, which reads them ahead of its own defaults.
 */
const LIKE_C4_SIZE = { minZoom: 0.86, maxZoom: 2.5, reactFlowProps: { fitViewOptions: { minZoom: 0.86, maxZoom: 2.5, padding: 0.08 } } } as unknown as Record<string, never>;

/**
 * A click on a LikeC4 element opens its page: LikeC4 reports the click as a diagram event, and the element's own id
 * names the address the server sent beside the model. It renders nothing — it is mounted inside the diagram so the
 * event reaches it.
 */
function NodeClicks({ links, onOpen }: { links: Readonly<Record<string, string>>; onOpen: (href: string) => void }): null {
  useOnDiagramEvent('nodeClick', ({ node }) => {
    const href = links[node.modelRef ?? node.id] ?? links[node.id];
    if (href !== undefined) onOpen(href);
  });
  return null;
}

/** The frame of a LikeC4 or archify document; a click inside it arrives as a message and opens the page. */
function Frame({ view, renderer, lang, onOpen, onFailure }: { view: DiagramView; renderer: 'likec4' | 'archify'; lang: string; onOpen: (href: string) => void; onFailure?: (renderer: 'likec4' | 'archify') => void }): ReactElement {
  const { t } = useTranslation();
  const ref = useRef<HTMLIFrameElement | null>(null);
  const [loaded, setLoaded] = useState(renderer === 'likec4');
  const [layout, setLayout] = useState<{ model: unknown; elementLinks: Record<string, string> } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    if (renderer !== 'likec4') return;
    let alive = true;
    setLoaded(false);
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
      return await response.json() as { ok: true; model: unknown; elementLinks: Record<string, string> };
    }).then((answer) => { if (alive) { setLayout({ model: answer.model, elementLinks: answer.elementLinks }); setLoaded(true); } }).catch((error: unknown) => {
      if (!alive) return;
      console.error(`the LikeC4 model of ${view.query} could not be read: ${error instanceof Error ? error.message : String(error)}`);
      setLoaded(true);
      // Only a renderer's own refusal hands the view on. A document without `fetch` (a test, a page offline) leaves the
      // reader's renderer selected: nothing about it says it cannot draw.
      if ((error as { refused?: boolean }).refused === true) {
        setFailure(error instanceof Error ? error.message : String(error));
        onFailure?.('likec4');
      }
    });
    return () => { alive = false; };
  }, [renderer, view.query, lang]);
  useEffect(() => {
    if (renderer !== 'archify') return;
    setLoaded(false);
    const listen = (event: MessageEvent): void => {
      if (event.source !== ref.current?.contentWindow) return;
      const data = event.data as { madarch?: string; href?: unknown; renderer?: unknown } | null;
      // A frame that could not draw says so: the app says it in one sentence and switches to a renderer that drew.
      if (data?.madarch === 'failed') {
        onFailure?.(renderer);
        return;
      }
      if (data?.madarch !== 'open' || typeof data.href !== 'string') return;
      const base = appBase();
      onOpen(base !== '' && data.href.startsWith(`${base}/`) ? data.href.slice(base.length) : data.href);
    };
    window.addEventListener('message', listen);
    return () => window.removeEventListener('message', listen);
  }, [onOpen, onFailure, renderer, view.query]);
  const likeC4 = layout as { model?: { projectId?: string }; elementLinks?: Record<string, string> } | null;
  const likeC4Model = useMemo(() => likeC4?.model ? LikeC4Model.create(likeC4.model as never) : null, [likeC4?.model]);
  const content = renderer === 'likec4' && likeC4Model
    ? (
      <LikeC4ModelProvider likec4model={likeC4Model}>
        <LikeC4View className="dg-likec4-view" viewId="index" pannable zoomable controls {...LIKE_C4_SIZE}>
          <NodeClicks links={likeC4?.elementLinks ?? {}} onOpen={onOpen} />
        </LikeC4View>
      </LikeC4ModelProvider>
    )
    : null;
  return (
    <div className="dg-frame-box" data-testid={`view-frame-${renderer}`}>
      {!loaded && <p className="m-0 p-3 text-small text-muted" data-testid="view-frame-loading">{t(renderer === 'likec4' ? 'knowledge.views.loadingLikec4' : 'knowledge.views.loadingArchify')}</p>}
      {renderer === 'likec4' && (failure ? <p className="diagram-error" role="alert">{failure}</p> : content)}
      {renderer === 'archify' && <iframe ref={ref} key={`${view.query}|${renderer}`} title={`${RENDERER_NAME[renderer]}: ${view.title}`} src={viewFrameAddress(view.query, renderer, lang)} loading="lazy" className={loaded ? 'dg-iframe' : 'dg-iframe dg-iframe-loading'} onLoad={() => setLoaded(true)} data-renderer={renderer} />}
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
      {element.location !== undefined && <span className="dg-element-place"><CodePlace location={element.location} /></span>}
      {element.drill !== undefined && (
        <button type="button" className="dg-drill" onClick={() => onDrill(element)} disabled={drilling} data-testid="view-drill" aria-label={t('knowledge.views.drillLabel', { name: element.label, view: element.drill.title })}>
          <ChevronsDownIcon aria-hidden="true" className="size-3.5" />{element.drill.title}
        </button>
      )}
    </li>
  );
}

/** Zoom for a Mermaid picture: the buttons, or Ctrl and the wheel; in full screen the picture fills the window and scrolls. */
function ZoomBox({ children }: { children: ReactElement }): ReactElement {
  const { t } = useTranslation();
  const full = useFullscreen();
  const [scale, setScale] = useState(1);
  const set = (next: number): void => setScale(Math.min(4, Math.max(0.4, Math.round(next * 100) / 100)));
  return (
    <div className={full ? 'dg-zoombox dg-zoombox-full' : 'dg-zoombox'} data-testid="zoom-box" data-scale={scale}
      onWheel={(event) => { if (event.ctrlKey || event.metaKey) { event.preventDefault(); set(scale * (event.deltaY < 0 ? 1.12 : 1 / 1.12)); } }}>
      <div className="dg-zoom-buttons">
        <button type="button" className="dg-chip" onClick={() => set(scale / 1.25)} aria-label={t('knowledge.views.zoomOut')} data-testid="zoom-out"><MinusIcon aria-hidden="true" className="size-3.5" /></button>
        <button type="button" className="dg-chip" onClick={() => set(scale * 1.25)} aria-label={t('knowledge.views.zoomIn')} data-testid="zoom-in"><PlusIcon aria-hidden="true" className="size-3.5" /></button>
        <button type="button" className="dg-chip" onClick={() => setScale(1)} aria-label={t('knowledge.views.zoomFit')} data-testid="zoom-fit"><ScanIcon aria-hidden="true" className="size-3.5" /></button>
      </div>
      <div className="dg-zoom-content" style={{ width: `${scale * 100}%` }}>{children}</div>
    </div>
  );
}

/** One view under its renderer tabs. */
function ViewBody({ view, initial, onDrill, onUp, drilling, depth }: { view: DiagramView; initial: DiagramRenderer; onDrill: (element: ViewElement) => void; onUp: () => void; drilling: boolean; depth: number }): ReactElement {
  const { t, i18n } = useTranslation();
  const lang = i18n.resolvedLanguage ?? 'en';
  const open = useContext(DiagramOpenContext);
  const [chosen, setChosen] = useState<DiagramRenderer | null>(null);
  const [fellBack, setFellBack] = useState<DiagramRenderer | null>(null);
  const renderer = chosen !== null && view.renderers.includes(chosen) ? chosen : view.renderers.includes(initial) ? initial : view.renderers[0]!;
  // A frame that could not draw hands the view to a renderer that did, and the page says so once, in one sentence.
  const onFailure = (failed: 'likec4' | 'archify'): void => {
    const next = view.renderers.find((name) => name !== failed && name !== renderer) ?? view.renderers.find((name) => name !== failed);
    setFellBack(failed);
    if (next !== undefined) setChosen(next);
  };
  const bind = useMemo(() => (root: HTMLElement) => bindMermaid(root, view.elements, view.spec.type, open), [view, open]);
  const stepped = view.edges.some((edge) => edge.step !== undefined);
  const dashed = view.edges.filter((edge) => edge.dashed);
  return (
    <div data-testid="view" data-view={view.spec.type} data-renderer={renderer} data-depth={depth}>
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
          {fellBack !== null && <p className="dg-why" data-testid="renderer-fallback">{t('knowledge.views.rendererFailed', { renderer: RENDERER_NAME[fellBack] })}</p>}
        </div>
      )}
      {view.empty === null && (
        <div className="dg-legend" data-testid="view-legend">
          <span className="dg-legend-line"><svg width="34" height="8" aria-hidden="true"><line x1="1" y1="4" x2="33" y2="4" stroke="currentColor" strokeWidth="2" /></svg>{t('knowledge.views.fact')}</span>
          <span className="dg-legend-line"><svg width="34" height="8" aria-hidden="true"><line x1="1" y1="4" x2="33" y2="4" stroke="currentColor" strokeWidth="2" strokeDasharray="5 4" /></svg>{t('knowledge.views.assumed')}</span>
        </div>
      )}
      {view.marker !== null && <p className="dg-note" data-testid="view-marker">{view.marker}</p>}
      {dashed.length > 0 && (
        <ul className="dg-why" data-testid="view-why">
          {[...new Set(dashed.map((edge) => `${edge.label}: ${edge.why ?? ''}`))].slice(0, 6).map((line) => <li key={line}>{line}</li>)}
        </ul>
      )}
      {view.notes.map((note) => <p key={note} className="dg-note" data-testid="view-note">{note}</p>)}
      {view.empty === null && (
        stepped ? (
          <ol className="dg-steps" data-testid="view-steps">
            {view.edges.map((edge) => (
              <li key={edge.step} data-dashed={edge.dashed ? 'true' : undefined} data-testid="view-step">
                <span className="dg-step-n">{edge.step}</span>
                {edge.href === null || edge.href === undefined ? <span>{edge.label}</span> : <KLink href={edge.href}>{edge.label}</KLink>}
                {edge.location !== undefined && <span className="dg-element-place"><CodePlace location={edge.location} /></span>}
                {edge.dashed && <Badge className="ml-1.5">{t('knowledge.views.unordered')}</Badge>}
                {edge.note !== undefined && <span className="dg-element-detail">{edge.note}</span>}
              </li>
            ))}
          </ol>
        ) : (
          <ul className="dg-elements" data-testid="view-elements">
            {view.elements.filter((element) => element.kind !== 'node').map((element) => <ElementRow key={element.id} element={element} onDrill={onDrill} drilling={drilling} />)}
          </ul>
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
