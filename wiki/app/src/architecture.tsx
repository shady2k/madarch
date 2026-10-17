/**
 * The Architecture section's pages (feature E, madarch-iuc.15): the views'
 * index (one row per view, the Design stage's part of the life cycle), one
 * page per view with its diagram — Mermaid first, LikeC4 beside it — and
 * its relation table, and one page per model element with its relations
 * and the pages that name it. The model's compile errors are the section's
 * own page content when the model does not compile: each names its file,
 * line and path, and the rest of the wiki keeps working.
 *
 * The bundle is asked once per mount of the section and again when the
 * wiki's change stream marks a revision (the same live rule the document
 * pages follow), through the caller's `revision` prop.
 */
import { appPath } from './app-base.js';
import { useContext, useEffect, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { getArchitecture, type Architecture, type ArchitectureElement as ElementFacts, type ArchitectureView as ViewFacts, type ElementRelation } from './api.js';
import { MermaidDiagram, LikeC4Diagram } from './diagram.js';
import { PageLink } from './view.js';
import { addressOfElement, addressOfView } from './routes.js';
import { routeContext, statusContext } from './hold.js';
import { byCodePoint } from './sort.js';

/**
 * The bundle of one revision, asked once and shared by every reader of the
 * same revision (the shell's count, the section's pages and the document
 * pages' element links): a new revision asks again, exactly like the page
 * list. A failed ask is not cached: the next mount tries again.
 */
const bundleCache = new Map<string, Architecture>();

export function useArchitecture(revision: string): { bundle: Architecture | null; error: string | null } {
  const [bundle, setBundle] = useState<Architecture | null>(() => bundleCache.get(revision) ?? null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (revision === '') return; // no revision yet: the app has not read the page list
    const cached = bundleCache.get(revision);
    if (cached !== undefined) {
      setBundle(cached);
      setError(null);
      return;
    }
    let alive = true;
    const controller = new AbortController();
    getArchitecture(controller.signal)
      .then((next) => {
        if (!alive) return;
        bundleCache.set(revision, next);
        setBundle(next);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (!alive) return;
        setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [revision]);
  return { bundle, error };
}

/** The element-id -> address map a document page's Markdown links by (the ids the page names, only). */
export function elementLinksFor(bundle: Architecture | null, pagePath: string): ReadonlyMap<string, string> | undefined {
  if (bundle?.model === undefined) return undefined;
  const links = new Map<string, string>();
  for (const element of bundle.model.elements) {
    if (!element.namedBy.includes(pagePath)) continue;
    links.set(element.id, addressOfElement(element.id));
  }
  return links.size === 0 ? undefined : links;
}

/**
 * The one-line-per-problem list the section shows: the model's compile
 * errors in place of the section, the notes (a partial input) beside the
 * model when it holds one.
 */
export function ErrorList({ errors, kind = 'errors' }: {
  errors: readonly { file: string; line: number; path: string; message: string }[];
  kind?: 'errors' | 'notes';
}): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="model-errors" data-testid={kind === 'notes' ? 'model-notes' : 'model-errors'}>
      <p>{kind === 'notes' ? t('architecture.notesLead', { count: errors.length }) : t('architecture.errorsLead', { count: errors.length })}</p>
      <ul>
        {errors.map((error, at) => (
          <li key={at}>
            <code className="model-error-place">
              {error.file}:{error.line}
              {error.path === '' ? '' : ` (${error.path})`}
            </code>{' '}
            — {error.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The element's link, titled by its display name. */
function ElementLink({ id, facts, className }: { id: string; facts: ReadonlyMap<string, ElementFacts>; className?: string }): ReactElement {
  const held = facts.get(id);
  return (
    <a href={appPath(addressOfElement(id))} className={className}>
      {held?.name ?? id}
    </a>
  );
}

/** The views' index: the section's entry page. */
export function ArchitectureIndex({ bundle }: { bundle: Architecture }): ReactElement {
  const { t } = useTranslation();
  const { publish } = useContext(statusContext);
  const elements = bundle.model?.elements ?? [];
  const views = bundle.model?.views ?? [];
  const byId = new Map(elements.map((element) => [element.id, element]));
  useEffect(() => {
    publish([
      t('status.elements', { count: elements.length }),
      t('status.views', { count: views.length }),
    ]);
    return () => publish(null);
  }, [publish, elements.length, views.length, t]);
  if (bundle.model === undefined) {
    return (
      <main id="architecture" data-testid="architecture-index">
        <h1 className="app-title">{t('architecture.title')}</h1>
        <ErrorList errors={bundle.errors} />
      </main>
    );
  }
  return (
    <main id="architecture" data-testid="architecture-index">
      <div className="document-meta eyebrow">
        <strong className="eyebrow-kind">{t('architecture.title')}</strong>
      </div>
      <h1 className="app-title">{t('architecture.title')}</h1>
      {bundle.notes.length > 0 && <ErrorList kind="notes" errors={bundle.notes} />}
      <section className="arch-views">
        <h2>{t('architecture.viewsHeading')}</h2>
        <ul className="home-rows">
          {views.map((view) => (
            <li key={view.scope}>
              <a className="home-row" href={appPath(addressOfView(view.scope))}>
                <span className="home-row-title">{view.scope === '' ? t('architecture.landscape') : view.title}</span>
              </a>
            </li>
          ))}
        </ul>
      </section>
      <section className="arch-elements">
        <h2>{t('architecture.elementsHeading')}</h2>
        <div className="table-wrap">
          <table data-testid="arch-elements-table">
            <thead>
              <tr>
                <th>{t('architecture.element')}</th>
                <th>{t('architecture.kind')}</th>
                <th>{t('architecture.technology')}</th>
                <th>{t('architecture.out')}</th>
                <th>{t('architecture.in')}</th>
              </tr>
            </thead>
            <tbody>
              {[...byId.values()].sort((a, b) => byCodePoint(a.id, b.id)).map((element) => (
                <tr key={element.id}>
                  <td><ElementLink id={element.id} facts={byId} /></td>
                  <td>{element.kind}</td>
                  <td>{element.technology ?? '—'}</td>
                  <td>{element.outgoing.length}</td>
                  <td>{element.incoming.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

/** One view page: the diagram (Mermaid beside LikeC4), the relation table, drill-down and up. */
export function ViewPage({ bundle, scope }: { bundle: Architecture; scope: string }): ReactElement {
  const { t } = useTranslation();
  const view = bundle.model?.views.find((candidate) => candidate.scope === scope);
  const byId = new Map((bundle.model?.elements ?? []).map((element) => [element.id, element]));
  if (bundle.model === undefined) {
    return (
      <main id="architecture">
        <h1 className="app-title">{t('architecture.title')}</h1>
        <ErrorList errors={bundle.errors} />
      </main>
    );
  }
  if (view === undefined) {
    return (
      <main id="architecture">
        <h1 className="app-title">{scope === '' ? t('architecture.landscape') : scope}</h1>
        <p>{t('architecture.noView')}</p>
      </main>
    );
  }
  const viewId = view.scope === '' ? 'index' : view.scope;
  const title = view.scope === '' ? t('architecture.landscape') : view.title;
  return (
    <main id="architecture" data-testid="architecture-view">
      <div className="document-meta eyebrow">
        <strong className="eyebrow-kind">{t('architecture.title')}</strong>
        <span className="eyebrow-dot" aria-hidden="true">•</span>
        <span className="eyebrow-secondary">{t('architecture.viewKind')}</span>
      </div>
      <h1 className="app-title">{title}</h1>
      <div className="diagram-tabs">
        <MermaidDiagram source={view.mermaid} title={title} />
        <LikeC4Diagram viewId={viewId} title={title} />
      </div>
      {view.table.rows.length > 0 && (
        <div className="table-wrap">
          <table data-testid="view-relations">
            <thead>
              <tr>{view.table.columns.map((column, at) => <th key={at}>{t('architecture.col.' + column, { defaultValue: column })}</th>)}</tr>
            </thead>
            <tbody>
              {view.table.rows.map((row, at) => (
                <tr key={at}>
                  {row.map((cell, cellAt) =>
                    cellAt === 0 || cellAt > 2 ? (
                      <td key={cellAt}>{cell}</td>
                    ) : (
                      <td key={cellAt}>{byId.has(cell) ? <ElementLink id={cell} facts={byId} /> : cell}</td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(view.up !== undefined || view.opens.length > 0) && (
        <p className="arch-links">
          {view.up !== undefined && (
            <>
              {t('architecture.up')}:{' '}
              <a href={appPath(addressOfView(view.up))}>{byId.get(view.up)?.name ?? (view.up === '' ? t('architecture.landscape') : view.up)}</a>
            </>
          )}
          {view.opens.length > 0 && (
            <>
              {' · '}
              {t('architecture.open')}:{' '}
              {view.opens.map((id, at) => (
                <span key={id}>
                  {at > 0 ? ' · ' : ''}
                  <a href={appPath(addressOfView(id))}>{byId.get(id)?.name ?? id}</a>
                </span>
              ))}
            </>
          )}
        </p>
      )}
    </main>
  );
}

/** One relation row of an element page, as a table row of cells. */
function RelationRows({ rows, facts, empty }: { rows: readonly ElementRelation[]; facts: ReadonlyMap<string, ElementFacts>; empty: string }): ReactElement[] {
  const { t } = useTranslation();
  if (rows.length === 0) {
    return [
      <tr key="empty"><td colSpan={4}>{empty}</td></tr>,
    ];
  }
  return rows.map((relation) => (
    <tr key={relation.relationId}>
      <td><ElementLink id={relation.other} facts={facts} /></td>
      <td>{relation.name ?? relation.relationId}</td>
      <td>{relation.interface ?? '—'}</td>
      <td>{relation.action ?? t('architecture.noAction')}</td>
    </tr>
  ));
}

/** One element page: its facts, its relations in and out, its interfaces, and the pages naming it. */
export function ElementPage({ bundle, id }: { bundle: Architecture; id: string }): ReactElement {
  const { t } = useTranslation();
  const route = useContext(routeContext);
  const facts = new Map((bundle.model?.elements ?? []).map((element) => [element.id, element]));
  const element = facts.get(id);
  if (bundle.model === undefined) {
    return (
      <main id="architecture">
        <h1 className="app-title">{t('architecture.title')}</h1>
        <ErrorList errors={bundle.errors} />
      </main>
    );
  }
  if (element === undefined) {
    return (
      <main id="architecture">
        <h1 className="app-title">{id}</h1>
        <p>{t('architecture.noElement')}</p>
      </main>
    );
  }
  return (
    <main id="architecture" data-testid="architecture-element">
      <div className="document-meta eyebrow">
        <strong className="eyebrow-kind">{t('architecture.title')}</strong>
        <span className="eyebrow-dot" aria-hidden="true">•</span>
        <span className="eyebrow-secondary">{element.kind}</span>
      </div>
      <h1 className="app-title">{element.name}</h1>
      {element.technology !== undefined && <p className="arch-technology">{t('architecture.technology')}: {element.technology}</p>}
      {element.parent !== undefined && (
        <p className="arch-parent">
          {t('architecture.parent')}:{' '}
          <ElementLink id={element.parent} facts={facts} />
        </p>
      )}
      {element.provides.length > 0 && (
        <section>
          <h2>{t('architecture.provides')}</h2>
          <ul>
            {element.provides.map((contract) => <li key={contract}><code>{contract}</code></li>)}
          </ul>
        </section>
      )}
      <section>
        <h2>{t('architecture.outgoing')}</h2>
        <div className="table-wrap">
          <table data-testid="element-outgoing">
            <thead>
              <tr>
                <th>{t('architecture.otherEnd')}</th>
                <th>{t('architecture.relation')}</th>
                <th>{t('architecture.interface')}</th>
                <th>{t('architecture.action')}</th>
              </tr>
            </thead>
            <tbody><RelationRows rows={element.outgoing} facts={facts} empty={t('architecture.none')} /></tbody>
          </table>
        </div>
      </section>
      <section>
        <h2>{t('architecture.incoming')}</h2>
        <div className="table-wrap">
          <table data-testid="element-incoming">
            <thead>
              <tr>
                <th>{t('architecture.otherEnd')}</th>
                <th>{t('architecture.relation')}</th>
                <th>{t('architecture.interface')}</th>
                <th>{t('architecture.action')}</th>
              </tr>
            </thead>
            <tbody><RelationRows rows={element.incoming} facts={facts} empty={t('architecture.none')} /></tbody>
          </table>
        </div>
      </section>
      {element.namedBy.length > 0 && (
        <section>
          <h2>{t('architecture.namedBy')}</h2>
          <ul>
            {element.namedBy.map((path) => (
              <li key={path}>
                {route.heldPaths.has(path) ? <PageLink path={path}>{path}</PageLink> : path}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
