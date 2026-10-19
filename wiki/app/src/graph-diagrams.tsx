/**
 * The diagrams of a graph page (madarch-tzte.23.4; decision 0026, "Diagrams"): one
 * section per diagram the server answers, each under a switcher over every renderer
 * that supports its type — LikeC4's own view, Mermaid's source, archify's page — with
 * the first tab the one the server's setting names.
 *
 * Everything drawn here is what the server answered (`src/product-wiki/graph-diagrams.ts`
 * makes the tabs, `src/fill/graph-diagrams.ts` reads the models): the app chooses no
 * model and draws no diagram of its own. Under the tabs stand the diagram's elements
 * and arrows as lists, the same lists for every renderer: an element opens its page and
 * its place in code there, which is the one place a reader reaches them whatever tab is
 * open — Mermaid's own click directives are off at the security level the app renders
 * with, and LikeC4 and archify link their own elements beside it.
 *
 * A tab's panel is mounted only while it is open: the LikeC4 bundle is some megabytes
 * and the archify page is rendered by the server on its first ask, so a reader who
 * never opens them pays for neither.
 */
import { useEffect, useState, type MouseEvent, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { FileCode2Icon } from 'lucide-react';
import { appPath } from './app-base.js';
import { getGraphDiagrams, type GraphDiagram, type GraphDiagramElement, type GraphDiagramPlace, type GraphDiagramRenderer, type GraphDiagramTab, type GraphDiagramsAnswer, type GraphPageEntry, type RepoEntry } from './api.js';
import { MermaidDiagram } from './diagram.js';
import { navigateTo } from './hold.js';
import { codeHref, codePlace } from './graph.js';

/**
 * One node's diagrams, read once and again when the page it belongs to changes
 * (the server reads a page again for a publication that names it, so a page's own
 * `readAt` is the moment its diagrams stood at too).
 */
export function useGraphDiagrams(node: GraphPageEntry, readAt: number): { answer: GraphDiagramsAnswer | null; error: string | null } {
  const [answer, setAnswer] = useState<GraphDiagramsAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setError(null);
    getGraphDiagrams(node.id, controller.signal)
      .then((next) => {
        if (alive) setAnswer(next);
      })
      .catch((caught: unknown) => {
        // A page the server answers no diagrams for is said in its own words, never drawn as nothing.
        if (alive) setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [node.id, readAt]);
  return { answer, error };
}

/** One element's (or one column's) place in code: a link to its repository's host at the pinned commit, or text. */
function ElementPlace({ place, repos }: { place: GraphDiagramPlace | undefined; repos: readonly RepoEntry[] }): ReactElement | null {
  const { t } = useTranslation();
  if (place === undefined) return null;
  const href = codeHref({ repository: place.repository, commit: place.commit, file: place.file, startLine: place.line, endLine: place.endLine }, repos);
  const shownPlace = `${place.repository} · ${codePlace({ repository: place.repository, commit: place.commit, file: place.file, startLine: place.line, endLine: place.endLine })}`;
  if (href === undefined) {
    return (
      <span className="graph-place" data-testid="graph-diagram-place" title={t('graph.noOrigin', { repository: place.repository })}>
        <FileCode2Icon aria-hidden="true" className="graph-place-icon" />
        <span>{shownPlace}</span>
      </span>
    );
  }
  return (
    <a className="graph-place" data-testid="graph-diagram-place" href={href} target="_blank" rel="noreferrer noopener" title={`${shownPlace} @ ${place.commit}`}>
      <FileCode2Icon aria-hidden="true" className="graph-place-icon" />
      <span>{shownPlace}</span>
    </a>
  );
}

/** One element's row: what it is, how it stands, its page and its place. */
function ElementRow({ element, repos }: { element: GraphDiagramElement; repos: readonly RepoEntry[] }): ReactElement {
  const { t } = useTranslation();
  const address = element.page === undefined ? undefined : appPath(element.page);
  return (
    <li className="graph-diagram-element" data-element={element.id} data-evidence={element.evidence} data-dashed={element.dashed ? 'true' : 'false'}>
      {address === undefined ? (
        <span className="graph-diagram-element-label" data-testid="graph-diagram-unpaged" title={t('graph.diagram.unpaged', { id: element.id })}>{element.label}</span>
      ) : (
        <a href={address} className="graph-diagram-element-label" onClick={(event: MouseEvent<HTMLAnchorElement>) => {
          if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.button !== 0) return;
          event.preventDefault();
          navigateTo(address);
        }}>{element.label}</a>
      )}
      <span className="graph-chip">{element.kind ?? t('graph.diagram.noKind')}</span>
      <span className="graph-chip" data-testid="graph-diagram-evidence">{t('graph.diagram.evidence.' + element.evidence)}</span>
      {(element.columns ?? []).length > 0 && (
        <ul className="graph-diagram-columns" data-testid="graph-diagram-columns">
          {(element.columns ?? []).map((column) => (
            <li key={column.label} className="graph-diagram-column" data-column={column.label}>
              {column.page === undefined ? (
                <span>{column.label}</span>
              ) : (
                <a href={appPath(column.page)} onClick={(event: MouseEvent<HTMLAnchorElement>) => {
                  if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.button !== 0) return;
                  event.preventDefault();
                  navigateTo(appPath(column.page!));
                }}>{column.label}</a>
              )}
              <ElementPlace place={column.place} repos={repos} />
            </li>
          ))}
        </ul>
      )}
      <ElementPlace place={element.place} repos={repos} />
      {element.drillDown !== undefined && (
        <a className="graph-diagram-drill" href={appPath(element.drillDown)} data-testid="graph-diagram-drill" onClick={(event: MouseEvent<HTMLAnchorElement>) => {
          if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.button !== 0) return;
          event.preventDefault();
          navigateTo(appPath(element.drillDown!));
        }}>{t('graph.diagram.drillDown', { count: (element.standsFor ?? []).length })}</a>
      )}
    </li>
  );
}

/** One arrow's row: its two ends by the names of the elements, its kinds and how it stands. */
function EdgeRow({ edge, labels }: { edge: GraphDiagram['edges'][number]; labels: ReadonlyMap<string, string> }): ReactElement {
  const { t } = useTranslation();
  return (
    <li className="graph-diagram-edge" data-evidence={edge.evidence} data-dashed={edge.dashed ? 'true' : 'false'}>
      <span className="graph-diagram-edge-ends">{labels.get(edge.from) ?? edge.from} → {labels.get(edge.to) ?? edge.to}</span>
      <span className="graph-diagram-edge-label">{edge.label}</span>
      <span className="graph-chip">{edge.kind}</span>
      <span className="graph-chip" data-testid="graph-diagram-edge-evidence">{t('graph.diagram.evidence.' + edge.evidence)}</span>
    </li>
  );
}

/** One renderer's panel: mounted only while its tab is open, so a tab nobody opens costs nothing. */
function TabPanel({ tab, title }: { tab: GraphDiagramTab; title: string }): ReactElement {
  switch (tab.renderer) {
    case 'mermaid':
      return <div className="graph-diagram-panel" data-panel="mermaid"><MermaidDiagram source={tab.source ?? ''} title={title} /></div>;
    case 'archify':
      return (
        <div className="graph-diagram-panel" data-panel="archify">
          <iframe className="graph-diagram-archify" data-testid="graph-diagram-archify" src={appPath(tab.src ?? '')} title={title} loading="lazy" />
        </div>
      );
    case 'likec4':
      // LikeC4 draws in a document of its own (the server's page over its generated bundle), so the tab frames
      // it: the element is defined before the view is asked for, which is how the static wiki draws it too.
      return (
        <div className="graph-diagram-panel" data-panel="likec4">
          <iframe className="graph-diagram-likec4" data-testid="graph-diagram-likec4" src={appPath(tab.src ?? '')} title={title} loading="lazy" />
        </div>
      );
  }
}

/** One diagram: its title, its switcher and the open tab, and the same lists of elements and arrows under any tab. */
export function DiagramTabs({ diagram, repos }: { diagram: GraphDiagram; repos: readonly RepoEntry[] }): ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState<GraphDiagramRenderer | null>(null);
  // The first tab is the server's own: the setting `MADARCH_WIKI_DIAGRAM` names, or the first renderer the type has.
  const active = open ?? diagram.tabs[0]?.renderer;
  const tab = diagram.tabs.find((candidate) => candidate.renderer === active);
  const labels = new Map(diagram.elements.map((element) => [element.id, element.label]));
  return (
    <article className="graph-diagram" data-testid="graph-diagram" data-diagram-type={diagram.type} data-diagram-level={diagram.level}>
      <h3 className="graph-diagram-title">{t('graph.diagram.type.' + diagram.type, { defaultValue: diagram.type })}</h3>
      <p className="graph-diagram-scope" data-testid="graph-diagram-scope">{diagram.title}</p>
      {diagram.marker !== null && <p className="graph-cut" role="status" data-testid="graph-diagram-marker">{diagram.marker}</p>}
      {diagram.empty ? (
        <p className="graph-none" data-testid="graph-diagram-empty">{t('graph.diagram.empty')}</p>
      ) : (
        <>
          <div className="graph-diagram-tabs" role="tablist" data-testid="graph-diagram-tabs">
            {diagram.tabs.map((candidate) => (
              <button
                key={candidate.renderer}
                type="button"
                role="tab"
                className="graph-diagram-tab"
                data-tab={candidate.renderer}
                aria-selected={candidate.renderer === active ? 'true' : 'false'}
                onClick={() => setOpen(candidate.renderer)}
              >
                {t('graph.diagram.renderer.' + candidate.renderer, { defaultValue: candidate.renderer })}
              </button>
            ))}
          </div>
          {tab === undefined ? null : <TabPanel tab={tab} title={diagram.title} />}
          <div className="graph-diagram-elements">
            <h4>{t('graph.diagram.elementsTitle', { count: diagram.elements.length })}</h4>
            <ul className="graph-diagram-element-list" data-testid="graph-diagram-elements">
              {diagram.elements.map((element) => <ElementRow key={element.id} element={element} repos={repos} />)}
            </ul>
          </div>
          {diagram.edges.length > 0 && (
            <div className="graph-diagram-edges">
              <h4>{t('graph.diagram.edgesTitle', { count: diagram.edges.length })}</h4>
              <ul className="graph-diagram-edge-list" data-testid="graph-diagram-edges">
                {diagram.edges.map((edge, at) => <EdgeRow key={`${edge.from}-${edge.to}-${String(at)}`} edge={edge} labels={labels} />)}
              </ul>
            </div>
          )}
          <p className="graph-diagram-legend" data-testid="graph-diagram-legend">{t('graph.diagram.legend')}</p>
        </>
      )}
    </article>
  );
}

/**
 * The page's diagrams section: one diagram after another, each under its own
 * switcher, and — where the graph answers none — the server's own words rather than
 * an empty frame (decision 0005: an absence is stated, never implied).
 */
export function GraphDiagramsSection({ node, readAt, repos }: { node: GraphPageEntry; readAt: number; repos: readonly RepoEntry[] }): ReactElement {
  const { t } = useTranslation();
  const { answer, error } = useGraphDiagrams(node, readAt);
  return (
    <section className="graph-diagrams" data-testid="graph-diagrams" aria-labelledby="graph-diagrams-title">
      <h2 id="graph-diagrams-title">{t('graph.diagramsTitle')}</h2>
      {error !== null && <p className="graph-diagram-error" data-testid="graph-diagrams-error">{t('graph.diagram.failed', { message: error })}</p>}
      {error === null && answer === null && <p className="graph-none" data-testid="graph-diagrams-loading">{t('graph.diagram.loading')}</p>}
      {answer !== null && answer.diagrams.length === 0 && <p className="graph-diagrams-slot" data-testid="graph-diagram-none">{t('graph.diagramsSlot')}</p>}
      {answer !== null && answer.diagrams.map((diagram) => <DiagramTabs key={diagram.type} diagram={diagram} repos={repos} />)}
    </section>
  );
}
