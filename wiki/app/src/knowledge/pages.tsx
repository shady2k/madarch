import { Operations } from './operations.js';
/**
 * The views of the knowledge wiki: one entity's page, a kind's entities, a
 * source file at a line, the empty product's way forward, and the fill's card.
 * Each view reads the server's model and draws it; the page of an entity is its
 * blocks in the order its template gave them.
 */
import { Fragment, useContext, useEffect, useRef, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { appPath } from '../app-base.js';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.js';
import { Input } from '@/components/ui/input.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.js';
import { getViews, getAgents, getCatalog, getDocument, getDocuments, getEntities, getFillSelection, getPage, getSource, getStatement, correctStatement, fillSelected, saveFillSelection, startFill } from './api.js';
import { syncFrontTabAddress, useTabTitle } from './tabs.js';
import { currentHistory } from './history-context.js';
import { HistoryBar } from './history-bar.js';
import { AgentChoice, useAgentChoice, WriterLine } from './writer.js';
import { FailureNote } from './errors.js';
import { BlockView, CodeLines, CodePlace, EntityName, Findings, KLink, KMarkdown, PlannedBadge, PlannedContext, brokenWords, groupLabel, scrollToAnchor, sentenceKey, type PlannedMarks } from './blocks.js';
import { addressOfDocument, addressOfEntity, addressOfJournal, addressOfKind, addressOfStatement, WIKI_DEPENDENCIES, WIKI_DOCS, WIKI_PROBLEMS } from './routes.js';
import { KindLabels, useKindName } from './kind-names.js';
import { fillWithOf } from './producers.js';
import { areaOf } from './catalog-area.js';
import { fillPhaseWords, fillShare } from './fill-words.js';
import { useRead } from './live.js';
import { blockOpen, useRole } from './roles.js';
import { PageSkeleton } from './skeleton.js';
import { Textarea } from '@/components/ui/textarea.js';
import { DiagramsView } from './diagrams/views.js';
import type { AgentOffer, CatalogKindView, CatalogView, CorrectionResult, DiagramRenderer, DiagramView, DocumentListing, DocumentPageModel, EntityListing, EntityRef, Excerpt, FillSelectionView, GroundView, GroupSummary, PageModel, SourceFile, StatementModel, WikiStatus } from './types.js';

function message(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/** The way up to an entity: the containers it stands in, each a link to its page. */
function Trail({ trail }: { trail: readonly EntityRef[] }): ReactElement | null {
  if (trail.length === 0) return null;
  return (
    <nav aria-label="trail" className="mb-2 flex flex-wrap items-center gap-x-2 text-small text-muted" data-testid="trail">
      {trail.map((entity, index) => (
        <span key={entity.id} className="flex items-center gap-2">
          {index > 0 && <span aria-hidden="true">/</span>}
          <EntityName entity={entity} />
        </span>
      ))}
    </nav>
  );
}

/** One entity's page. A page read again after a commit keeps showing the old one until the new one arrives. */
export function EntityPage({ id, after = null, version }: { id: string; after?: string | null; version: number }): ReactElement {
  const { t, i18n } = useTranslation();
  const kindName = useKindName();
  const language = (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  const selectedHistory = currentHistory();
  const { data: page, error } = useRead<PageModel>(`${id}\0${language}\0${after ?? ''}\0${JSON.stringify(selectedHistory)}`, version, (signal) => getPage(id, language, signal, (reason) => t('knowledge.pageNotRead', { id, reason }), after));
  const { role, roles } = useRole();
  useTabTitle(page?.title ?? (error !== null ? t('knowledge.noSuchPage') : null));
  // An old member address opens the parent's page at the member's fragment (madarch-m38l.21).
  useEffect(() => {
    if (page?.redirect === undefined) return;
    const address = `${addressOfEntity(page.redirect.id)}#${encodeURIComponent(page.redirect.anchor)}`;
    window.history.replaceState({}, '', appPath(address));
    syncFrontTabAddress();
    const timer = setTimeout(() => document.getElementById(page.redirect!.anchor)?.scrollIntoView({ block: 'start' }), 0);
    return () => clearTimeout(timer);
  }, [page?.redirect?.id, page?.redirect?.anchor]);
  if (page === null && error === null) return <PageSkeleton testId="page-loading" />;
  if (page === null) {
    return (
      <Alert variant="problem" data-testid="page-error">
        <AlertTitle>{t('knowledge.noSuchPage')}</AlertTitle>
        <AlertDescription><p>{error}</p></AlertDescription>
      </Alert>
    );
  }
  // A planned change on this page is said in its header and on each statement that stands on it (madarch-m38l.14).
  const planned: PlannedMarks = {
    headings: {},
    statements: Object.fromEntries((page.planned?.statements ?? []).map((mark) => [sentenceKey(mark.sentence), { task: mark.task, how: mark.how }])),
  };
  return (
    <article data-testid="entity-page" data-entity={page.id} data-kind={page.kind} data-planned={page.planned?.entity === null || page.planned?.entity === undefined ? 'false' : page.planned.entity.how}>
      <header className="mb-6">
        <HistoryBar history={page.history} navigation={page.historyNavigation} absent={page.historicalAbsent} />
        <Trail trail={page.trail} />
        <div className="mb-2 flex items-center gap-2">
          <Badge data-testid="page-kind">{kindName(page.kind, 'one')}</Badge>
          {page.planned?.entity != null && <PlannedBadge mark={page.planned.entity} />}
          {(page.problems ?? 0) > 0 && <span data-testid="page-problems"><KLink href={WIKI_PROBLEMS}><Badge variant="solid">{t('knowledge.pageProblems', { count: page.problems })}</Badge></KLink></span>}
        </div>
        <h1 data-testid="page-title">{page.title}</h1>
        {page.notes.map((note) => <p key={note} className="text-small text-muted" data-testid="page-note">{note}</p>)}
        {page.planned?.note !== undefined && <p className="text-small" role="alert" data-testid="page-planned-note">{page.planned.note}</p>}
        {/* «Как агент писал эту страницу» only where the store holds a journal of it (madarch-m38l.23). */}
        {page.journal !== undefined && <p className="text-small" data-testid="journal-link"><KLink href={addressOfJournal(page.id)}>{t('journal.title')}</KLink></p>}
      </header>
      <PlannedContext.Provider value={planned}>
      {page.blocks.map((block, index) => {
        const view = <BlockView key={index} block={block} resolutions={page.resolutions} pageId={page.id} />;
        if (blockOpen(block, role, roles)) return view;
        // The role does not open this block: it stays on the page, collapsed under its title.
        const title = 'title' in block ? block.title : block.type;
        return <details key={index} className="role-collapsed mb-4" data-testid="block-collapsed" data-block-type={block.type}><summary className="cursor-pointer text-secondary">{title}</summary>{view}</details>;
      })}
      </PlannedContext.Provider>
      <Findings findings={page.findings} />
    </article>
  );
}

/** The map of a kind's pages and the services behind them (the domain context map); nothing is drawn for a kind no service stands behind. */
function KindMap({ kind, version }: { kind: string; version: number }): ReactElement | null {
  const { t, i18n } = useTranslation();
  const lang = i18n.resolvedLanguage ?? 'en';
  const read = useRead<{ renderer: DiagramRenderer; views: DiagramView[] }>(`map\0${kind}\0${lang}`, version, (signal) => getViews(new URLSearchParams({ type: 'domain-map', subject: kind }).toString(), lang, signal));
  const view = read.data?.views[0];
  if (read.data === null || view === undefined || view.empty !== null) return null;
  return <div className="mb-6" data-testid="kind-map"><DiagramsView block={{ type: 'diagrams', title: t('knowledge.views.kindMap'), renderer: read.data.renderer, views: [view] }} /></div>;
}

/** A kind's entities: filtered by text, a hundred at a time. */
export function KindPage({ kind, version }: { kind: string; version: number }): ReactElement {
  const { t } = useTranslation();
  const kindName = useKindName();
  const summary = useContext(KindLabels).find((entry) => entry.kind === kind);
  // The form of the listing is the kind's declaration (`listing:` of the manifest), not a kind the app knows.
  const operations = summary?.listing === 'operations';
  const [query, setQuery] = useState('');
  const [asked, setAsked] = useState('');
  const [more, setMore] = useState<EntityRef[]>([]);
  const [operationMore, setOperationMore] = useState<NonNullable<EntityListing['operations']>>({});
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const wait = setTimeout(() => setAsked(query), query === '' ? 0 : 200);
    return () => clearTimeout(wait);
  }, [query]);
  useTabTitle(kindName(kind, 'many'));
  const read = useRead<EntityListing>(`${kind}\0${asked}`, version, (signal) => getEntities(kind, { q: asked }, signal));
  const listing = read.data;
  // A fresh listing starts the rows over: what "load more" appended belonged to the one before.
  useEffect(() => {
    setMore([]);
    setOperationMore({});
    setNext(listing?.next ?? null);
  }, [listing]);
  const listingRef = useRef<EntityListing | null>(null);
  listingRef.current = listing;
  const rows = [...(listing?.rows ?? []), ...more];
  const load = (): void => {
    if (next === null) return;
    const mine = listing;
    getEntities(kind, { q: asked, after: next }).then(
      (answer) => {
        // A commit that reread the listing meanwhile makes this page of rows a stale one.
        if (listingRef.current !== mine) return;
        setMore((held) => [...held, ...answer.rows]);
        setOperationMore((held) => ({...held, ...answer.operations}));
        setNext(answer.next);
      },
      (failure: unknown) => setError(message(failure)),
    );
  };
  return (
    <section data-testid="kind-page" data-kind={kind}>
      <header className="mb-6">
        <div className="mb-2 flex items-center gap-2"><Badge>{kindName(kind, 'one')}</Badge></div>
        <h1>{kindName(kind, 'many')}</h1>
        <div className="flex items-center gap-3">
          <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('knowledge.filter')} aria-label={t('knowledge.filter')} className="max-w-sm" data-testid="kind-filter" />
          {listing !== null && <span className="text-small text-muted" data-testid="kind-total">{t('knowledge.total', { count: listing.total })}</span>}
        </div>
      </header>
      <KindMap kind={kind} version={version} />
      {(error ?? read.error) !== null && <Alert variant="problem" className="mb-4"><AlertDescription><p>{error ?? read.error}</p></AlertDescription></Alert>}
      {listing === null && read.error === null && <PageSkeleton testId="kind-loading" rows />}
      {listing !== null && rows.length === 0 && <p className="text-muted" data-testid="kind-empty">{summary?.source === 'document' ? t('knowledge.noStageYet') : t('knowledge.nothingOfKind')}</p>}
      {rows.length > 0 && operations && <Operations rows={rows} metadata={{...listing?.operations, ...operationMore}} />}
      {rows.length > 0 && !operations && (
        <Table>
          <TableHeader>
            <TableRow><TableHead>{t('knowledge.colName')}</TableHead><TableHead>{t('knowledge.colPlace')}</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} data-entity={row.id}>
                <TableCell className="max-w-[30rem] break-words"><EntityName entity={row} /></TableCell>
                <TableCell className="max-w-[28rem]">{row.location !== undefined ? <CodePlace location={row.location} /> : <span className="text-muted">–</span>}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {next !== null && <div className="mt-4"><Button variant="default" size="default" onClick={load} data-testid="kind-more">{t('knowledge.more')}</Button></div>}
    </section>
  );
}

/** A file of a repository, with line numbers, at the line the reader was sent to. */
export function SourcePage({ repo, path, line }: { repo: string | null; path: string; line: number | null }): ReactElement {
  const { t } = useTranslation();
  const [file, setFile] = useState<SourceFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const selectedHistory = JSON.stringify(currentHistory());
  useTabTitle(path.slice(path.lastIndexOf('/') + 1));
  useEffect(() => {
    const controller = new AbortController();
    setFile(null);
    setError(null);
    getSource(repo, path, controller.signal).then(
      (answer) => {
        setFile(answer);
        setError(null);
      },
      (failure: unknown) => {
        if (!controller.signal.aborted) setError(message(failure));
      },
    );
    return () => controller.abort();
  }, [repo, path, selectedHistory]);
  useEffect(() => {
    if (file === null || line === null) return;
    box.current?.querySelector(`#L${line}`)?.scrollIntoView?.({ block: 'center' });
  }, [file, line]);
  if (error !== null) {
    return (
      <Alert variant="problem" data-testid="source-error">
        <AlertTitle>{t('knowledge.sourceMissing')}</AlertTitle>
        <AlertDescription><p>{error}</p></AlertDescription>
      </Alert>
    );
  }
  if (file === null) return <PageSkeleton testId="source-loading" />;
  const total = file.text.endsWith('\n') ? file.text.split('\n').length - 1 : file.text.split('\n').length;
  return (
    <section data-testid="source-page" data-path={path}>
      <HistoryBar history={file.history} />
      <header className="mb-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Badge>{file.repo ?? t('knowledge.productRepository')}</Badge>
          <Badge>{file.language}</Badge>
          {file.commit !== null && <Badge title={file.commit}>{file.commit.slice(0, 10)}</Badge>}
          <span className="text-small text-muted">{t('knowledge.lines', { count: total })}</span>
        </div>
        <h1 className="!text-h2 break-all font-mono !text-[1.1em]" data-testid="source-title">{path}</h1>
      </header>
      <div ref={box} className="source-view overflow-hidden rounded-[var(--radius-card)] border border-line">
        <CodeLines text={file.text.endsWith('\n') ? file.text.slice(0, -1) : file.text} language={file.language} firstLine={1} focus={line} />
      </div>
    </section>
  );
}

/** The fill's card: what to do on an empty product, the progress of a running fill, a failed fill's reason. */
export function FillCard({ status, refresh }: { status: WikiStatus; refresh: () => void }): ReactElement | null {
  return (
    <>
      <FillPart status={status} refresh={refresh} />
      <WriterLine status={status} refresh={refresh} />
    </>
  );
}

function FillPart({ status, refresh }: { status: WikiStatus; refresh: () => void }): ReactElement | null {
  const { t } = useTranslation();
  const [refused, setRefused] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const choice = useAgentChoice(status);
  const fill = status.fill;
  const agentLabel = choice.agents?.find((agent) => agent.id === choice.pick)?.label ?? status.chosenAgent?.label;
  // One press is the whole consent: the pick is saved (its adapter installed on this yes), then the fill starts and flows into the agent.
  const start = (): void => {
    setStarting(true);
    setRefused(null);
    choice.commit().then(() => startFill(choice.pick, choice.pick === null ? undefined : choice.language)).then(
      () => {
        setStarting(false);
        refresh();
      },
      (failure: unknown) => {
        setStarting(false);
        setRefused(message(failure));
      },
    );
  };
  if (fill.state === 'running') {
    // The bar is the run's own trace (madarch-8bdc.2.5, item 2): the units it planned and the units it
    // published, as the trace states them, and the last thing it did. A run that has written no unit yet
    // shows the commits-read bar the store keeps instead of an empty one.
    const progress = fill.progress;
    const planned = progress?.planned ?? 0;
    const published = progress?.published ?? 0;
    const share = planned > 0 ? Math.min(1, published / planned) : fillShare(fill);
    return (
      <Card className="mb-8" data-testid="fill-card" data-state="running">
        <CardHeader>
          <CardTitle>{t('knowledge.fillRunningTitle')}</CardTitle>
          <CardDescription>{fill.repository !== undefined ? t('knowledge.fillReading', { repository: fill.repository, what: fillPhaseWords(fill, t) }) : t('knowledge.fillOpening')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--surface-active)]" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)} aria-label={t('knowledge.fillRunningTitle')}>
            <div className="h-full rounded-full bg-ink transition-[width] duration-150 motion-reduce:transition-none" style={{ width: `${Math.round(share * 100)}%` }} />
          </div>
          {progress !== undefined && planned > 0 && (
            <p className="mb-0 mt-3 text-small text-muted" data-testid="fill-progress-counts">{t('knowledge.repository.progressCounts', { published, planned })}</p>
          )}
          {progress !== undefined && planned === 0 && (
            <p className="mb-0 mt-3 text-small text-muted" data-testid="fill-progress-spans">{t('knowledge.repository.fillSpans', { spans: progress.spans })}</p>
          )}
          {progress?.last !== null && progress?.last !== undefined && (progress.last.startsWith('fill.unit') || progress.last.startsWith('scheduler pass')) && (
            <p className="mb-0 mt-1 break-all text-small text-muted" data-testid="fill-progress-last">{t('knowledge.repository.fillLast', { last: progress.last })}</p>
          )}
          <p className="mb-0 mt-3 text-small text-muted">{t('knowledge.fillLive')}</p>
        </CardContent>
      </Card>
    );
  }
  if (fill.state === 'failed') {
    return (
      <Alert variant="problem" className="mb-8" data-testid="fill-card" data-state="failed">
        <AlertTitle>{t('knowledge.fillFailedTitle')}</AlertTitle>
        <AlertDescription>
          <FailureNote scope="fill" code={fill.code} message={fill.message} />
          {fill.error !== undefined && fill.error.file !== undefined && (
            <p className="mb-0 mt-2 break-all text-small" data-testid="fill-error-where">{t('knowledge.repository.errorAt', { file: fill.error.file, line: fill.error.line ?? 0, path: fill.error.path ?? '' })}</p>
          )}
          {fill.error !== undefined && fill.error.file === undefined && fill.error.path !== undefined && (
            <p className="mb-0 mt-2 break-all text-small" data-testid="fill-error-path">{t('knowledge.repository.errorPath', { path: fill.error.path })}</p>
          )}
          <p className="mt-2"><Button variant="default" size="default" onClick={start} disabled={starting}>{t('knowledge.fillRetry')}</Button></p>
          {refused !== null && <p className="mb-0 mt-3 text-small" role="alert" data-testid="fill-refused">{refused}</p>}
        </AlertDescription>
      </Alert>
    );
  }
  if (status.filled && status.incomplete) {
    return (
      <Card className="mb-8" data-testid="fill-card" data-state="incomplete">
        <CardHeader>
          <CardTitle>{t('knowledge.incompleteTitle')}</CardTitle>
          <CardDescription>{t('knowledge.incomplete')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="default" size="default" onClick={start} disabled={starting} data-testid="fill-start">{t('knowledge.fillContinue')}</Button>
          {refused !== null && <p className="mb-0 mt-3 text-small" role="alert" data-testid="fill-refused">{refused}</p>}
        </CardContent>
      </Card>
    );
  }
  if (status.filled) {
    // The code is read. With no pages yet and no agent stage under way, the agent is offered: the same single press, the fill resuming as a no-op.
    const offered = (status.home === null || (status.kinds.find((kind) => kind.kind === 'domain')?.count ?? 0) === 0) && status.writer.state === 'idle';
    if (!offered) return null;
    return (
      <Card className="mb-8" data-testid="fill-card" data-state="offer">
        <CardHeader>
          <CardTitle>{t('knowledge.writer.offerTitle')}</CardTitle>
          <CardDescription>{t('knowledge.writer.offerDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <AgentChoice status={status} choice={choice} />
          <Button variant="default" size="default" onClick={start} disabled={starting || choice.pick === null} data-testid="fill-start">{agentLabel === undefined ? t('knowledge.writer.offerButton', { agent: '…' }) : t('knowledge.writer.offerButton', { agent: agentLabel })}</Button>
          {choice.pick === null && <p className="mb-0 mt-3 text-small text-muted">{t('knowledge.writer.offerNeedsAgent')}</p>}
          {refused !== null && <p className="mb-0 mt-3 text-small" role="alert" data-testid="fill-refused">{refused}</p>}
        </CardContent>
      </Card>
    );
  }
  // A product created and not filled yet holds its own Git checkout: Fill reads that repository, so it is offered even
  // when no other repository is connected (madarch-64o5.3).
  const ownCheckout = status.manifest === 'not-filled' && status.repositories.length === 0;
  const connected = status.repositories.length > 0 || ownCheckout;
  return (
    <Card className="mb-8" data-testid="fill-card" data-state="empty">
      <CardHeader>
        <CardTitle>{t('knowledge.emptyTitle')}</CardTitle>
        <CardDescription>{ownCheckout ? t('knowledge.notFilledFill') : connected ? t('knowledge.emptyConnected', { repositories: status.repositories.map((repo) => repo.name).join(', ') }) : t('knowledge.emptyNoRepository')}</CardDescription>
      </CardHeader>
      <CardContent>
        {connected ? (
          <>
            <AgentChoice status={status} choice={choice} />
            <Button variant="default" size="default" onClick={start} disabled={starting} data-testid="fill-start">{choice.pick === null ? t('knowledge.fillStart') : t('knowledge.writer.startWith', { agent: agentLabel ?? '…' })}</Button>
          </>
        ) : (
          <pre className="!my-0" data-testid="fill-hint"><code>madarch repo add &lt;name&gt; &lt;url&gt;</code></pre>
        )}
        {refused !== null && <p className="mb-0 mt-3 text-small" role="alert" data-testid="fill-refused">{refused}</p>}
      </CardContent>
    </Card>
  );
}

/**
 * The product's front when no page is the home: an introduction for a newcomer in the interface language, and the fill's
 * card with the agent choice and its one press. The words are the engine's own and say nothing about this product.
 */
export function Overview({ status, refresh }: { status: WikiStatus; refresh: () => void }): ReactElement {
  const { t } = useTranslation();
  useTabTitle(status.product.name);
  return (
    <section data-testid="overview">
      <header className="mb-6">
        <h1>{status.product.name}</h1>
        <p className="text-secondary" data-testid="home-intro">{t('knowledge.homeIntro.summary')}</p>
      </header>
      <div className="mb-8" data-testid="home-guidance">
        <h2 className="mt-0">{t('knowledge.homeIntro.canTitle')}</h2>
        <ul>
          <li>{t('knowledge.homeIntro.canStart')}</li>
          <li>{t('knowledge.homeIntro.canOpen')}</li>
          <li>{t('knowledge.homeIntro.canAsk')}</li>
        </ul>
        <h2>{t('knowledge.homeIntro.howTitle')}</h2>
        <p>{t('knowledge.homeIntro.howRead')}</p>
        <p>{t('knowledge.homeIntro.howStages')}</p>
        <p className="mb-0">{t('knowledge.homeIntro.howAgent')}</p>
      </div>
      <FillCard status={status} refresh={refresh} />
    </section>
  );
}

/** The guide every product without a starter set needs: the file in the repository the release is published from. */
const MANIFESTS_GUIDE = 'https://github.com/shady2k/madarch/blob/main/docs/guides/how-to-write-a-product-s-manifests.md';

/** A product with no kinds manifest: what the file is and where it comes from, and the guide that writes one. */
export function EmptyHome({ status }: { status: WikiStatus; refresh: () => void }): ReactElement {
  const { t } = useTranslation();
  useTabTitle(status.product.name);
  return (
    <section data-testid="no-manifest">
      <header className="mb-6">
        <h1>{status.product.name}</h1>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>{t('knowledge.noManifestTitle')}</CardTitle>
          <CardDescription>{t('knowledge.noManifest', { file: status.manifestFile })}</CardDescription>
        </CardHeader>
        <CardContent>
          <p>{t('knowledge.noManifestScratch', { file: status.manifestFile })}</p>
          <p className="mb-0">
            <a href={MANIFESTS_GUIDE} target="_blank" rel="noreferrer" data-testid="manifests-guide">{t('knowledge.noManifestGuide')}</a>
          </p>
        </CardContent>
      </Card>
    </section>
  );
}

/**
 * A product whose manifest stands in its repository and whose graph no fill has read yet: the newcomer's first page.
 * It says what happened, that nothing is read yet, and the next step — Fill is offered and never started here.
 */
export function NewHome({ status, refresh }: { status: WikiStatus; refresh: () => void }): ReactElement {
  const { t } = useTranslation();
  useTabTitle(status.product.name);
  return (
    <section data-testid="not-filled">
      <header className="mb-6">
        <h1>{status.product.name}</h1>
      </header>
      <Card className="mb-8">
        <CardHeader>
          <CardTitle>{t('knowledge.notFilledTitle')}</CardTitle>
          <CardDescription>{t('knowledge.notFilledWhat', { file: status.manifestFile })}</CardDescription>
        </CardHeader>
        <CardContent>
          <p>{t('knowledge.notFilledNext')}</p>
          <p className="mb-0">
            <a href={MANIFESTS_GUIDE} target="_blank" rel="noreferrer" data-testid="manifests-guide">{t('knowledge.notFilledGuide')}</a>
          </p>
        </CardContent>
      </Card>
      <FillCard status={status} refresh={refresh} />
    </section>
  );
}

/** The sources a filter keeps: those whose title or path holds the words, in any case. */
export function filterSources<T extends { title: string; path: string }>(documents: readonly T[], query: string): T[] {
  const wanted = query.trim().toLowerCase();
  return documents.filter((document) => wanted === '' || document.path.toLowerCase().includes(wanted) || document.title.toLowerCase().includes(wanted));
}

/** The Markdown documents of the product and of its connected repositories, grouped by where they live, as pages of this wiki. */
export function DocumentsPage({ version }: { version: number }): ReactElement {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  useTabTitle(t('knowledge.documents'));
  const { data: listing, error } = useRead<DocumentListing>('documents', version, (signal) => getDocuments(signal));
  if (listing === null && error === null) return <PageSkeleton testId="documents-loading" rows />;
  if (listing === null) {
    return (
      <Alert variant="problem" data-testid="documents-error">
        <AlertTitle>{t('knowledge.documentsMissing')}</AlertTitle>
        <AlertDescription><p>{error}</p></AlertDescription>
      </Alert>
    );
  }
  const shown = filterSources(listing.documents, query);
  const groups = new Map<string, typeof shown>();
  for (const document of shown) {
    const key = document.repo ?? '';
    groups.set(key, [...(groups.get(key) ?? []), document]);
  }
  return (
    <section data-testid="documents-page">
      <header className="mb-6">
        <h1>{t('knowledge.documents')}</h1>
        <p className="text-secondary" data-testid="documents-intro">{t('knowledge.documentsIntro')}</p>
        <div className="flex items-center gap-3">
          <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('knowledge.filterSources')} aria-label={t('knowledge.filterSources')} className="max-w-sm" data-testid="documents-filter" />
          <span className="text-small text-muted" data-testid="documents-total">{t('knowledge.total', { count: shown.length })}</span>
        </div>
      </header>
      {shown.length === 0 && <p className="text-muted" data-testid="documents-empty">{t('knowledge.noDocuments')}</p>}
      {[...groups.entries()].map(([repo, documents]) => (
        <section key={repo} className="mb-8" data-testid="documents-group" data-repo={repo}>
          <h2 className="first-letter:uppercase">{repo === '' ? t('knowledge.productRepository') : repo}</h2>
          <ul className="m-0 list-none p-0">
            {documents.map((document) => (
              <li key={document.path} className="border-b border-line py-1.5 last:border-b-0" data-testid="document-row">
                <KLink href={addressOfDocument(document.repo, document.path)}>{document.title}</KLink>
                <span className="block break-all text-small text-muted" data-testid="document-path">{document.path}</span>
              </li>
            ))}
          </ul>
          {listing.truncated.filter((cut) => (cut.repo ?? '') === repo).map((cut) => <p key={repo} className="mt-2 text-small text-muted" data-testid="documents-cut">{t('knowledge.showing', { shown: cut.shown, total: cut.total })}</p>)}
        </section>
      ))}
    </section>
  );
}

/** One Markdown document as a page, scrolled to the section the address names. */
export function DocumentPage({ repo, path, version }: { repo: string | null; path: string; version: number }): ReactElement {
  const { t } = useTranslation();
  const { data: page, error } = useRead<DocumentPageModel>(`${repo ?? ''}\0${path}`, version, (signal) => getDocument(repo, path, signal));
  useTabTitle(page?.title ?? (error !== null ? t('knowledge.noSuchPage') : null));
  // The section the address names: it changes with a link to another section of the same document too.
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const read = (): void => setHash(window.location.hash);
    window.addEventListener('popstate', read);
    window.addEventListener('hashchange', read);
    return () => { window.removeEventListener('popstate', read); window.removeEventListener('hashchange', read); };
  }, []);
  useEffect(() => {
    if (page === null) return;
    let anchor = hash.replace(/^#/, '');
    try { anchor = decodeURIComponent(anchor); } catch { /* the text as written names the section */ }
    if (anchor === '') return;
    // The elements stand after this render: the section is looked for once they are in the document.
    const handle = setTimeout(() => { scrollToAnchor(anchor, page.anchors); }, 0);
    return () => clearTimeout(handle);
  }, [page?.path, page?.repo, hash]);
  if (page === null && error === null) return <PageSkeleton testId="document-loading" />;
  if (page === null) {
    return (
      <Alert variant="problem" data-testid="document-error">
        <AlertTitle>{t('knowledge.noSuchDocument')}</AlertTitle>
        <AlertDescription><p>{error}</p></AlertDescription>
      </Alert>
    );
  }
  // The heading a task's scope names carries its badge: the anchor's line is the line the heading stands on (madarch-m38l.14).
  const planned: PlannedMarks = {
    headings: Object.fromEntries((page.planned ?? []).flatMap((mark) => {
      const line = mark.anchor === null ? undefined : page.anchors[mark.anchor];
      return line === undefined ? [] : [[line, { task: mark.task, how: mark.how }] as const];
    })),
    statements: {},
  };
  return (
    <article data-testid="document-page" data-path={page.path} data-repo={page.repo ?? ''} data-planned={String((page.planned ?? []).length)}>
      <header className="mb-6">
        <nav aria-label="trail" className="mb-2 flex flex-wrap items-center gap-x-2 text-small text-muted"><KLink href={WIKI_DOCS}>{t('knowledge.documents')}</KLink><span aria-hidden="true">/</span><span>{page.repo ?? t('knowledge.productRepository')}</span></nav>
        <div className="mb-2 flex items-center gap-2">
          <Badge>{t('knowledge.documentBadge')}</Badge>
          <code className="min-w-0 truncate text-small text-muted" title={page.path}>{page.path}</code>
          {page.commit !== null && <Badge title={page.commit}>{page.commit.slice(0, 10)}</Badge>}
        </div>
      </header>
      {page.plannedNote !== undefined && <Alert data-testid="document-planned-note"><AlertDescription><p>{page.plannedNote}</p></AlertDescription></Alert>}
      <PlannedContext.Provider value={planned}>
        <KMarkdown text={page.markdown} resolutions={page.resolutions} inDocument={{ repo: page.repo, path: page.path, anchors: page.anchors }} />
      </PlannedContext.Provider>
    </article>
  );
}

/**
 * The entity catalogue: every kind the product's manifest declares, read from the catalogue's own request
 * (madarch-8bdc.2.5), under its area and subgroup — its name and description in the reader's language, the entities that
 * stand of it (zero when nothing filled it yet), and whether a stage fills it today. A kind the product declares but no
 * stage fills stays in the list: the catalogue is the product's full potential, and nothing is hidden by its count.
 */
/** The kinds a set of checked kinds needs, transitively: for each kind added, the checked kind that needs it. */
export function addedByDependency(kinds: readonly CatalogKindView[], checked: ReadonlySet<string>): Map<string, string> {
  const byKind = new Map(kinds.map((kind) => [kind.kind, kind] as const));
  const added = new Map<string, string>();
  const visit = (from: string, kind: string): void => {
    for (const dependency of byKind.get(kind)?.dependsOn ?? []) {
      if (checked.has(dependency) || added.has(dependency)) continue;
      added.set(dependency, from);
      visit(from, dependency);
    }
  };
  for (const kind of [...checked].sort()) if (byKind.has(kind)) visit(kind, kind);
  return added;
}

/**
 * What the panel says one press costs: the selected kinds' measured volume times the per-unit figure their producers
 * declare. A figure no producer declares is unknown, and the sum is unknown with it — never a guess (madarch-stm0.6).
 */
export function estimateOf(kinds: readonly CatalogKindView[], checked: ReadonlySet<string>, added: ReadonlyMap<string, string>): { tokens: number | null; seconds: number | null; volume: number; unknown: number } {
  const chosen = new Set([...checked, ...added.keys()]);
  const held = kinds.filter((kind) => chosen.has(kind.kind));
  let tokens = 0;
  let seconds = 0;
  let unknown = 0;
  let volume = 0;
  for (const kind of held) {
    volume += kind.estimate?.volume ?? 0;
    if (kind.estimate === undefined || kind.estimate.tokens === null || kind.estimate.seconds === null) unknown += 1;
    else { tokens += kind.estimate.tokens; seconds += kind.estimate.seconds; }
  }
  return { tokens: unknown > 0 ? null : tokens, seconds: unknown > 0 ? null : seconds, volume, unknown };
}

/** Every kind of one catalogue section, its subgroups included. */
function sectionKinds(section: { kinds: CatalogKindView[]; subgroups: { kinds: CatalogKindView[] }[] }): CatalogKindView[] {
  return [...section.kinds, ...section.subgroups.flatMap((subgroup) => subgroup.kinds)];
}

/**
 * The catalogue page: every entity the product's manifest declares, with whether it is filled, partial or never filled,
 * and a checkbox per section and per entity that says "fill now" (madarch-stm0.6). A checked entity's dependencies are
 * checked with it, marked "needed by …", and cannot be unchecked while a dependant is checked; the panel pinned to the
 * bottom of the viewport shows what is selected, what the dependencies added, the agent, the token cap, the estimate and
 * the Fill button. The last selection is the product's own state in the store, written when the person presses Fill
 * selected or Save: a checkbox is a thought, not a decision.
 */
export function CataloguePage({ version }: { version: number }): ReactElement {
  const { t, i18n } = useTranslation();
  const language = (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  useTabTitle(t('knowledge.catalogue'));
  const { data, error } = useRead<CatalogView>('catalogue', version, getCatalog);
  const selection = useRead<{ selection: FillSelectionView }>('fill-selection', version, (signal) => getFillSelection(signal));
  const [agents, setAgents] = useState<AgentOffer[] | null>(null);
  const [checked, setChecked] = useState<Set<string> | null>(null);
  const [agent, setAgent] = useState<string | null>(null);
  const [cap, setCap] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const saved = selection.data?.selection;
  useEffect(() => {
    const controller = new AbortController();
    getAgents(controller.signal).then((answer) => setAgents(answer.agents), () => setAgents([]));
    return () => controller.abort();
  }, []);
  // The selection the store holds, or — for a product nobody chose for yet — the entities their own plugins fill and
  // what those need: a first press then runs the plugins and no agent (the owner's design of 2026-11-10).
  const kinds = data?.kinds;
  useEffect(() => {
    if (kinds === undefined || saved === undefined) return;
    // Every entity is checked by default (the owner, 2026-11-10: "why would anything be unchecked? we have an agent
    // plugin for every entity"): a product whose selection was never written starts with the whole catalogue checked, and
    // the panel says how many of them wait for an agent. A selection the person saved is theirs, an empty one included.
    setChecked((held) => held ?? (saved.savedAt === '' ? new Set(kinds.map((kind) => kind.kind)) : new Set(saved.selected)));
    setAgent((held) => held ?? saved.agent);
    setCap((held) => (held === '' ? (saved.tokenCap === null ? '' : String(saved.tokenCap)) : held));
  }, [kinds, saved]);
  const chosen = checked ?? new Set<string>();
  const added = kinds === undefined ? new Map<string, string>() : addedByDependency(kinds, chosen);
  /** The selection as the panel has it, for the two writes there are: the press, and Save. */
  const selectionValue = (): { selected: string[]; agent: string | null; tokenCap: number | null } => {
    const value = cap.trim() === '' ? null : Number(cap);
    return { selected: [...chosen].sort(), agent, tokenCap: value !== null && Number.isInteger(value) && value > 0 ? value : null };
  };
  // The selection is the product's state, and it is written when the person presses Fill selected (the press stores it
  // before the run starts) or Save: a checkbox is a thought, not a decision (the owner, 2026-11-10).
  const save = (): void => {
    setBusy(true);
    setFailure(null);
    setNote(null);
    saveFillSelection(selectionValue()).then(
      () => { setBusy(false); setNote(t('knowledge.catalogueSaved')); },
      (failure: unknown) => { setBusy(false); setFailure(message(failure)); },
    );
  };
  if (error !== null && data === null) {
    return <Alert data-testid="catalogue-error"><AlertTitle>{t('knowledge.catalogue')}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>;
  }
  if (data === null) return <PageSkeleton testId="catalogue-loading" />;
  const all = data.kinds;
  const known = new Set(data.groups.map((group) => group.group));
  const top = data.groups.filter((group) => group.parent === undefined || !known.has(group.parent));
  const children = data.groups.filter((group) => group.parent !== undefined && known.has(group.parent));
  const label = (group: GroupSummary): string => group.labels[language] ?? group.labels['en'] ?? group.group;
  const ofArea = (area: string): CatalogKindView[] => all.filter((kind) => areaOf(data.groups, kind) === area && (kind.subgroup === '' || !known.has(kind.subgroup)));
  const ofSubgroup = (subgroup: string): CatalogKindView[] => all.filter((kind) => kind.subgroup === subgroup);
  const placed = new Set([...top.map((group) => group.group), ...children.map((group) => group.group)]);
  const other = all.filter((kind) => !placed.has(areaOf(data.groups, kind)) && !placed.has(kind.subgroup));
  const sections: { key: string; name: string; kinds: CatalogKindView[]; subgroups: { key: string; name: string; kinds: CatalogKindView[] }[] }[] = [
    ...top.map((group) => ({
      key: group.group,
      name: label(group),
      kinds: ofArea(group.group),
      subgroups: children.filter((child) => child.parent === group.group).map((child) => ({ key: child.group, name: label(child), kinds: ofSubgroup(child.group) })),
    })),
    ...(other.length === 0 ? [] : [{ key: '\0other', name: t('knowledge.groupOther'), kinds: other, subgroups: [] }]),
  ].filter((section) => section.kinds.length > 0 || section.subgroups.length > 0);
  const entities = all.reduce((sum, kind) => sum + kind.count, 0);
  /** The kind's name in the reader's language; a language the declaration leaves out is marked, never filled with English. */
  const nameOf = (kind: CatalogKindView): string => kind.labels?.[language]?.many ?? kind.kind;
  const translated = (kind: CatalogKindView): boolean => kind.labels?.[language] !== undefined;
  // Who fills a kind, in the manifest's own words: the plugins its fields bind, the built-in pass that reads it, the
  // person who wrote it, or the general agent plugin (madarch-stm0.6, the owner 2026-11-10).
  const producerWords = (kind: CatalogKindView): string => {
    if ((kind.plugins ?? []).length > 0) return t('knowledge.catalogueByPlugin', { plugins: (kind.plugins ?? []).join(', ') });
    if (kind.producer === 'extract') return t('knowledge.catalogueStage.extract');
    if (kind.producer === 'documents') return t('knowledge.catalogueStage.documents');
    if (kind.producer === 'history') return t('knowledge.catalogueStage.history');
    if (fillWithOf(kind) === 'person') return t('knowledge.catalogueByPerson');
    return t('knowledge.catalogueByAgent');
  };
  const stateWords = (kind: CatalogKindView): string => t(`knowledge.catalogueState.${kind.state}`);
  /** Whether a kind may be unchecked: only when no checked kind needs it. */
  const needed = (kind: string): string | undefined => added.get(kind);
  const setMany = (next: Iterable<string>, remove: boolean): void => {
    setChecked((held) => {
      const made = new Set(held ?? []);
      for (const kind of next) { if (remove) made.delete(kind); else made.add(kind); }
      return made;
    });
    setFailure(null);
  };
  const toggle = (kind: CatalogKindView): void => {
    const isChecked = chosen.has(kind.kind);
    if (isChecked && needed(kind.kind) !== undefined) return;
    setMany([kind.kind], isChecked);
  };
  const sectionState = (section: { kinds: CatalogKindView[]; subgroups: { kinds: CatalogKindView[] }[] }): 'all' | 'some' | 'none' => {
    const held = sectionKinds(section);
    const on = held.filter((kind) => chosen.has(kind.kind)).length;
    return on === 0 ? 'none' : on === held.length ? 'all' : 'some';
  };
  const badge = (kind: CatalogKindView): ReactElement => (
    <Badge key="state" variant={kind.state === 'never' ? 'outline' : 'solid'} data-testid="catalogue-state" data-state={kind.state}>{stateWords(kind)}</Badge>
  );
  const table = (rows: CatalogKindView[]): ReactElement => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-8"><span className="sr-only">{t('knowledge.catalogueFillNow')}</span></TableHead>
          <TableHead>{t('knowledge.catalogueColKind')}</TableHead>
          <TableHead>{t('knowledge.catalogueColAbout')}</TableHead>
          <TableHead>{t('knowledge.catalogueColCount')}</TableHead>
          <TableHead>{t('knowledge.catalogueColStage')}</TableHead>
          <TableHead>{t('knowledge.catalogueColState')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((kind) => {
          const dependencyOf = needed(kind.kind);
          const on = chosen.has(kind.kind);
          return (
            <TableRow key={kind.kind} data-kind={kind.kind} data-filled={String(kind.filled)} data-checked={on ? 'true' : 'false'} data-needed={dependencyOf === undefined ? 'false' : 'true'}>
              <TableCell className="align-top">
                <input
                  type="checkbox"
                  data-testid={`catalogue-check-${kind.kind}`}
                  aria-label={t('knowledge.catalogueFillNow')}
                  checked={on || dependencyOf !== undefined}
                  disabled={dependencyOf !== undefined}
                  onChange={() => toggle(kind)}
                />
                {dependencyOf !== undefined && <span className="block text-small text-muted" data-testid="catalogue-needed-by">{t('knowledge.catalogueNeededBy', { kind: nameOf(all.find((entry) => entry.kind === dependencyOf) ?? kind) })}</span>}
              </TableCell>
              <TableCell className="whitespace-nowrap align-top">
                {kind.page ? <KLink href={addressOfKind(kind.kind)}>{nameOf(kind)}</KLink> : <span data-testid="catalogue-kind-name">{nameOf(kind)}</span>}
                {!translated(kind) && <span className="ml-2 text-small text-muted" data-testid="catalogue-no-translation">{t('knowledge.catalogueNoTranslation')}</span>}
              </TableCell>
              <TableCell className="max-w-[32rem] align-top">{kind.descriptions?.[language] ?? <span className="text-muted" data-testid="catalogue-no-description">{t('knowledge.catalogueNoTranslation')}</span>}</TableCell>
              <TableCell className="align-top" data-testid="catalogue-count">{kind.count}{kind.statements !== undefined && <span className="block text-small text-muted" data-testid="catalogue-statements">{t('knowledge.catalogueStatements', { count: kind.statements })}</span>}</TableCell>
              <TableCell className="align-top" data-testid="catalogue-stage" data-stage={fillWithOf(kind)}>
                {producerWords(kind)}
                {on && agent === null && fillWithOf(kind) === 'agent' && <span className="block text-small text-muted" data-testid="catalogue-waiting">{t('knowledge.catalogueWaitingForAgent')}</span>}
              </TableCell>
              <TableCell className="align-top" data-testid="catalogue-states">{badge(kind)}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
  const rows = (rows: CatalogKindView[]): ReactElement => rows.length > 0 ? table(rows) : <p className="mt-0 text-small text-muted" data-testid="catalogue-empty-subgroup">{t('knowledge.catalogueEmptyGroup')}</p>;
  const fill = (): void => {
    setBusy(true);
    setFailure(null);
    setNote(null);
    fillSelected(selectionValue()).then(
      (answer) => { setBusy(false); setNote(t('knowledge.catalogueFillStarted', { order: answer.order.join(', ') })); },
      (failure: unknown) => { setBusy(false); setFailure(message(failure)); },
    );
  };
  const agentChosen = agents?.find((entry) => entry.id === agent);
  const cost = estimateOf(all, chosen, added);
  // How many selected entities no own producer fills and therefore wait for an agent (the owner, 2026-11-10).
  const waiting = all.filter((kind) => (chosen.has(kind.kind) || added.has(kind.kind)) && fillWithOf(kind) === 'agent').length;
  return (
    <section data-testid="catalogue-page" className="pb-40">
      <header className="mb-6">
        <h1>{t('knowledge.catalogue')}</h1>
        <p className="mb-1">{t('knowledge.catalogueIntro')}</p>
        <p className="mt-0 text-small text-muted" data-testid="catalogue-total">{t('knowledge.catalogueKinds', { count: all.length })}, {t('knowledge.catalogueEntities', { count: entities })}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="catalogue-checks">
          <Button variant="default" size="default" data-testid="catalogue-check-all" onClick={() => setMany(all.map((kind) => kind.kind), false)}>{t('knowledge.catalogueCheckAll')}</Button>
          <Button variant="default" size="default" data-testid="catalogue-uncheck-all" onClick={() => { setChecked(new Set()); setFailure(null); }}>{t('knowledge.catalogueUncheckAll')}</Button>
          <KLink href={WIKI_DEPENDENCIES} testId="catalogue-dependencies">{t('knowledge.dependencies.title')}</KLink>
        </div>
      </header>
      {sections.map((section) => {
        const total = sectionKinds(section).reduce((sum, kind) => sum + kind.count, 0);
        const state = sectionState(section);
        return (
          <section key={section.key} className="mb-8" data-testid="catalogue-group" data-group={section.key}>
            <h2 className="flex items-baseline gap-3">
              <input
                type="checkbox"
                data-testid={`catalogue-check-section-${section.key}`}
                aria-label={t('knowledge.catalogueFillSection', { section: section.name })}
                checked={state === 'all'}
                ref={(input) => { if (input !== null) input.indeterminate = state === 'some'; }}
                onChange={() => setMany(sectionKinds(section).map((kind) => kind.kind), state === 'all')}
              />
              {section.name}<span className="text-small font-normal text-muted">{total}</span>
            </h2>
            {section.kinds.length > 0 && table(section.kinds)}
            {section.subgroups.map((subgroup) => (
              <section key={subgroup.key} className="mb-5" data-testid="catalogue-subgroup" data-subgroup={subgroup.key}>
                <h3 className="mb-2 mt-5 flex items-baseline gap-3 text-[15px]">{subgroup.name}<span className="text-small font-normal text-muted">{subgroup.kinds.reduce((sum, kind) => sum + kind.count, 0)}</span></h3>
                {rows(subgroup.kinds)}
              </section>
            ))}
          </section>
        );
      })}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-[var(--surface-menu)] px-4 py-3 shadow-[var(--shadow-high)]" data-testid="catalogue-panel">
        <div className="mx-auto flex max-w-[80rem] flex-wrap items-center gap-x-3 gap-y-2 sm:items-end sm:gap-x-6">
          <p className="m-0 text-small" data-testid="catalogue-selection">
            <b data-testid="catalogue-selected-count">{t('knowledge.catalogueSelected', { count: chosen.size })}</b>
            {added.size > 0 && <span className="text-muted" data-testid="catalogue-added-count"> · {t('knowledge.catalogueAdded', { count: added.size })}</span>}
          </p>
          <p className="m-0 hidden text-small text-muted sm:block" data-testid="catalogue-estimate" data-known={cost.tokens === null ? 'false' : 'true'}>
            {cost.tokens === null
              ? t('knowledge.catalogueEstimateUnknown', { count: cost.unknown })
              : t('knowledge.catalogueEstimate', { tokens: cost.tokens, seconds: Math.round(cost.seconds ?? 0) })}
          </p>
          <label className="grid gap-1 text-small" htmlFor="catalogue-agent">
            <span className="text-secondary">{t('knowledge.catalogueAgent')}</span>
            <select id="catalogue-agent" data-testid="catalogue-agent" className="w-56 rounded-[var(--radius-control)] border border-line bg-page px-2 py-1 text-body text-ink" value={agent ?? ''} onChange={(event) => setAgent(event.target.value === '' ? null : event.target.value)}>
              <option value="">{t('knowledge.catalogueAgentNone')}</option>
              {(agents ?? []).map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-small" htmlFor="catalogue-cap">
            <span className="text-secondary">{t('knowledge.catalogueTokenCap')}</span>
            <input id="catalogue-cap" data-testid="catalogue-token-cap" className="w-36 rounded-[var(--radius-control)] border border-line bg-page px-2 py-1 text-body text-ink" inputMode="numeric" placeholder={t('knowledge.catalogueTokenCapNone')} value={cap} onChange={(event) => setCap(event.target.value.replace(/[^0-9]/gu, ''))} />
          </label>
          <Button variant="default" size="default" className="!border-ink !bg-ink !text-page" data-testid="catalogue-fill" disabled={busy || chosen.size === 0} onClick={fill}>{busy ? t('knowledge.catalogueFilling') : t('knowledge.catalogueFillSelected')}</Button>
          <Button variant="default" size="default" data-testid="catalogue-save" disabled={busy} onClick={save}>{t('knowledge.catalogueSave')}</Button>
          {agent === null && waiting > 0 && <p className="m-0 hidden text-small text-muted sm:block" data-testid="catalogue-agent-note">{t('knowledge.catalogueAgentNote', { count: waiting })}</p>}
          {agentChosen !== undefined && <p className="m-0 text-small text-muted" data-testid="catalogue-agent-chosen">{t('knowledge.catalogueAgentChosen', { agent: agentChosen.label })}</p>}
          {note !== null && <p className="m-0 text-small" data-testid="catalogue-fill-note">{note}</p>}
          {failure !== null && <p className="m-0 text-small" role="alert" data-testid="catalogue-fill-error">{failure}</p>}
        </div>
      </div>
    </section>
  );
}

/** A ground that is a thing of the system: its name and kind, what the kind is, what the code says of it, what it is connected to, and its page. */
function EntityCard({ excerpt }: { excerpt: Extract<Excerpt, { type: 'entity' }> }): ReactElement {
  const { t, i18n } = useTranslation();
  const kindName = useKindName();
  const kinds = useContext(KindLabels);
  const language = (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  const { entity } = excerpt;
  const description = kinds.find((kind) => kind.kind === entity.kind)?.descriptions?.[language];
  return (
    <div data-testid="excerpt" data-excerpt="entity" className="flex flex-col gap-3">
      <p className="m-0 text-small text-muted" data-testid="card-kind">{kindName(entity.kind, 'one')}{description !== undefined && <> · {description}</>}</p>
      {excerpt.facts.length > 0 && (
        <div>
          <p className="mb-1 mt-0 text-small text-muted">{t('knowledge.cardFacts')}</p>
          <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-small" data-testid="card-facts">
            {excerpt.facts.map((fact) => (<Fragment key={fact.name}><dt className="font-mono text-secondary">{fact.name}</dt><dd className="m-0 break-words">{fact.value}</dd></Fragment>))}
          </dl>
        </div>
      )}
      {excerpt.related.length > 0 && (
        <div data-testid="card-related">
          <p className="mb-1 mt-0 text-small text-muted">{t('knowledge.cardRelated')}</p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-small">
            {excerpt.related.map((group) => (
              <li key={`${group.relation}:${group.direction}`} data-relation={group.relation}>
                <span className="text-muted">{groupLabel(group, t)}: </span>
                {group.rows.map((row, index) => <Fragment key={row.entity.id}>{index > 0 && ', '}<EntityName entity={row.entity} /></Fragment>)}
                {group.total > group.rows.length && <span className="text-muted"> +{group.total - group.rows.length}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {entity.href !== null && <p className="m-0 text-small" data-testid="card-page"><KLink href={entity.href}>{t('knowledge.cardOpen', { kind: kindName(entity.kind, 'one').toLowerCase() })}</KLink></p>}
    </div>
  );
}

function ExcerptView({ excerpt }: { excerpt: Excerpt }): ReactElement {
  const { t } = useTranslation();
  if (excerpt.type === 'text') {
    const place = excerpt.place;
    return (
      <div data-testid="excerpt" data-excerpt="text">
        <blockquote className="!my-0"><KMarkdown text={excerpt.markdown} resolutions={{}} /></blockquote>
        <p className="mb-0 mt-2 text-small text-muted"><KLink href={place.href}>{place.path}:{place.lineStart}{place.lineEnd > place.lineStart ? `–${place.lineEnd}` : ''}</KLink></p>
      </div>
    );
  }
  if (excerpt.type === 'entity') return <EntityCard excerpt={excerpt} />;
  return (
    <div data-testid="excerpt" data-excerpt="code">
      <div className="source-view overflow-hidden rounded-[var(--radius-card)] border border-line">
        <CodeLines text={excerpt.text} language={excerpt.language} firstLine={excerpt.firstLine} marked={excerpt.marked} />
      </div>
      <p className="mb-0 mt-2 flex flex-wrap items-center gap-x-3 text-small text-muted">
        <CodePlace location={excerpt.location} />
        {excerpt.marked.start > 0 && <span>{t('knowledge.citedLines', { start: excerpt.marked.start, end: excerpt.marked.end })}</span>}
        {excerpt.truncated && <span>{t('knowledge.cutShown')}</span>}
      </p>
    </div>
  );
}

function GroundCard({ ground, index }: { ground: GroundView; index: number }): ReactElement {
  const { t } = useTranslation();
  const kindName = useKindName();
  const resolution = ground.resolution;
  return (
    <Card data-testid="ground" data-state={resolution.state} data-ground={ground.url}>
      <CardHeader className="flex-row items-center gap-3 pb-3">
        <span className="text-small text-muted" aria-hidden="true">{index + 1}</span>
        {resolution.state === 'broken' ? (
          <CardTitle className="min-w-0 flex-1 text-small"><span className="ref-broken" data-testid="ref-broken" title={brokenWords(resolution, t)}>{ground.url.replace(/^madarch:/, '')}<span className="ref-broken-mark">{t('knowledge.broken')}</span></span></CardTitle>
        ) : (
          <>
            <CardTitle className="min-w-0 flex-1 text-small">{resolution.href === null ? resolution.label : <KLink href={resolution.href}>{resolution.label}</KLink>}</CardTitle>
            <Badge>{resolution.kind === 'document' ? t('knowledge.documentBadge') : kindName(resolution.kind, 'one')}</Badge>
          </>
        )}
      </CardHeader>
      <CardContent>
        {resolution.state === 'broken' && <p className="m-0 text-small" role="note">{brokenWords(resolution, t)}</p>}
        {resolution.state === 'ok' && ground.excerpt !== null && <ExcerptView excerpt={ground.excerpt} />}
        {resolution.state === 'ok' && ground.excerpt === null && <p className="m-0 text-small text-muted">{t('knowledge.statementNoExcerpt')}</p>}
      </CardContent>
    </Card>
  );
}

/** Where a person says the statement is wrong and why: a correction file in the product repository, committed under the person's git name. */
function CorrectionBox({ page, name }: { page: string; name: string | null }): ReactElement {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [done, setDone] = useState<CorrectionResult | null>(null);
  const send = (): void => {
    if (name === null) return;
    setSending(true);
    setRefused(null);
    correctStatement(`${page}#${name}`, reason).then(
      (result) => { setSending(false); setDone(result); setReason(''); },
      (failure: unknown) => { setSending(false); setRefused(message(failure)); },
    );
  };
  return (
    <section data-testid="statement-correction">
      <h2>{t('knowledge.statementCorrection')}</h2>
      <p className="text-small text-muted">{name === null ? t('knowledge.statementCorrectionUnnamed') : t('knowledge.statementCorrectionNote')}</p>
      <Textarea value={reason} onChange={(event) => setReason(event.target.value)} disabled={name === null || sending} placeholder={t('knowledge.statementCorrectionPlaceholder')} aria-label={t('knowledge.statementCorrection')} className="mb-3 max-w-xl" data-testid="correction-text" />
      <div><Button variant="default" size="default" disabled={name === null || sending || reason.trim() === ''} onClick={send} data-testid="correction-send">{t('knowledge.statementCorrectionSend')}</Button></div>
      {refused !== null && <p className="mb-0 mt-3 text-small" role="alert" data-testid="correction-refused">{refused}</p>}
      {done !== null && (
        <p className="mb-0 mt-3 text-small" role="status" data-testid="correction-done">
          {t('knowledge.statementCorrectionDone', { file: done.file })} {done.committed ? '' : (done.note ?? '')} <KLink href={WIKI_PROBLEMS}>{t('loop.problemsTitle')}</KLink>
        </p>
      )}
    </section>
  );
}

/** One sentence of an agent's page with its paragraph, each ground with its excerpt, and the place for a correction. */
export function StatementPage({ id, sentence, turn = 0, version }: { id: string; sentence: string; turn?: number; version: number }): ReactElement {
  const { t } = useTranslation();
  const { data: statement, error } = useRead<StatementModel>(`${id}\0${sentence}\0${turn}`, version, (signal) => getStatement(id, sentence, turn, signal));
  useTabTitle(sentence.length > 40 ? `${sentence.slice(0, 39)}…` : sentence);
  if (statement === null && error === null) return <PageSkeleton testId="statement-loading" />;
  if (statement === null) {
    return (
      <Alert variant="problem" data-testid="statement-error">
        <AlertTitle>{t('knowledge.statementMissing')}</AlertTitle>
        <AlertDescription><p>{error}</p></AlertDescription>
      </Alert>
    );
  }
  return (
    <article data-testid="statement-page">
      <header className="mb-6">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Badge>{t('knowledge.statementTitle')}</Badge>
          <span className="text-small text-muted">{t('knowledge.statementOnPage')}: <EntityName entity={statement.page} /></span>
        </div>
        <p className="statement-sentence m-0" data-testid="statement-sentence">{statement.sentence}</p>
        {statement.planned != null && <p className="m-0 mt-2" data-testid="statement-planned"><PlannedBadge mark={statement.planned} ground={statement.planned.how === 'impact'} /></p>}
        {statement.plannedNote !== undefined && <p className="m-0 mt-1 text-small" role="alert" data-testid="statement-planned-note">{statement.plannedNote}</p>}
      </header>
      <section className="mb-8" data-testid="statement-paragraph">
        <h2>{t('knowledge.statementParagraph')}</h2>
        <blockquote className="!my-0"><KMarkdown text={statement.paragraph} resolutions={statement.resolutions} /></blockquote>
        <p className="mb-0 mt-2 text-small text-muted">{t('knowledge.statementWhere', { file: statement.file, line: statement.line })}</p>
      </section>
      <section className="mb-8" data-testid="statement-grounds">
        <h2>{t('knowledge.statementGrounds')}</h2>
        {statement.grounds.length === 0 ? (
          <Alert variant="problem" data-testid="statement-no-grounds"><AlertDescription><p>{t('knowledge.statementNoGrounds')}</p></AlertDescription></Alert>
        ) : (
          <div className="flex flex-col gap-4">{statement.grounds.map((ground, index) => <GroundCard key={ground.url} ground={ground} index={index} />)}</div>
        )}
      </section>
      {statement.relying.length > 0 && (
        <section className="mb-8" data-testid="statement-relying">
          <h2>{t('knowledge.statementRelying')}</h2>
          <Table>
            <TableHeader><TableRow><TableHead>{t('knowledge.statementOnPage')}</TableHead><TableHead>{t('knowledge.statementTitle')}</TableHead><TableHead>{t('knowledge.statementSharedGround')}</TableHead></TableRow></TableHeader>
            <TableBody>
              {statement.relying.map((other) => (
                <TableRow key={`${other.page}:${other.line}:${other.text}`}>
                  <TableCell className="align-top"><KLink href={addressOfEntity(other.page)}>{other.pageTitle}</KLink></TableCell>
                  <TableCell className="max-w-[30rem] align-top">{other.sentence === undefined ? other.text : <KLink href={addressOfStatement(other.page, other.sentence, other.turn ?? 0)}>{other.text}</KLink>}</TableCell>
                  <TableCell className="align-top">{other.ground}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}
      <CorrectionBox page={statement.page.id} name={statement.name} />
    </article>
  );
}
