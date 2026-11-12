import { InlineCode } from '@/components/ui/inline-content.js';
import { Breadcrumb } from '@/components/ui/breadcrumb.js';
import { Blockquote } from '@/components/ui/reading-content.js';
import { Disclosure, DisclosureSummary } from '@/components/ui/disclosure.js';
import { PageSection, PageHeader, PageTitle, SectionTitle, Paragraph, BulletList, ListItem, Metadata, InlineGroup, CodeFrame, FileTitle, TextLink, ClippedLabel, ContentsSidebar, Stack, Text, PageArticle, Preformatted, SmallTitle, PlainList, DefinitionList, DefinitionTerm, DefinitionValue } from '@/components/ui/typography.js';
import { Operations } from './operations.js';
import { AuthoredKindPage, AuthoredPage } from './authored.js';
import { KindGraph } from './kind-graph.js';
import { KindDetails } from './kind-details.js';
import { KindSources } from './kind-sources.js';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs.js';
import { TableOfContents } from '@/components/ui/table-of-contents.js';
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
import { Progress } from '@/components/ui/progress.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.js';
import { getViews, getCatalog, getDocument, getDocuments, getEntities, getPage, getSource, getStatement } from './api.js';
import { linkHandlers, syncFrontTabAddress, useTabTitle } from './tabs.js';
import { currentHistory } from './history-context.js';
import { HistoryBar } from './history-bar.js';
import { WriterLine } from './writer.js';
import { FailureNote } from './errors.js';
import { BlockView, CodeLines, CodePlace, EntityName, Findings, KLink, KMarkdown, PlannedBadge, PlannedContext, brokenWords, groupLabel, scrollToAnchor, sentenceKey, type PlannedMarks } from './blocks.js';
import { addressOfDocument, addressOfEntity, addressOfJournal, addressOfKind, addressOfStatement, WIKI_DOCS, WIKI_FILL, WIKI_PROBLEMS } from './routes.js';
import { KindLabels, useKindName } from './kind-names.js';
import { fillWithOf } from './producers.js';
import { areaOf } from './catalog-area.js';
import { fillPhaseWords, fillShare } from './fill-words.js';
import { useRead } from './live.js';
import { blockOpen, useRole } from './roles.js';
import { PageSkeleton } from './skeleton.js';
import { DiagramsView } from './diagrams/views.js';
import { KindUsage } from './usage.js';
import type { CatalogKindView, CatalogView, DiagramRenderer, DiagramView, DocumentListing, DocumentPageModel, EntityListing, EntityRef, Excerpt, GroundView, GroupSummary, PageModel, SourceFile, StatementModel, WikiStatus } from './types.js';

function message(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/** The way up to an entity: the containers it stands in, each a link to its page. */
function Trail({ trail }: { trail: readonly EntityRef[] }): ReactElement | null {
  if (trail.length === 0) return null;
  return (
    <Breadcrumb aria-label="trail" className="mb-2 flex flex-nowrap items-center gap-x-2 overflow-hidden text-small text-muted" data-testid="trail">
      {trail.map((entity, index) => {
        const last = index === trail.length - 1;
        return (
          <Text key={entity.id} className={`flex min-w-0 items-center gap-2 ${last ? 'shrink-0' : ''}`}>
            {index > 0 && <Text aria-hidden="true">/</Text>}
            {last
              ? <Text className="min-w-0 truncate font-medium text-ink" aria-current="page" data-testid="trail-current">{entity.label}</Text>
              : <ClippedLabel><EntityName entity={entity} /></ClippedLabel>}
          </Text>
        );
      })}
    </Breadcrumb>
  );
}

/** One entity's page. A page read again after a commit keeps showing the old one until the new one arrives. */
export function EntityPage(props: { id: string; after?: string | null; version: number }): ReactElement {
  const kinds = useContext(KindLabels);
  const kind = kinds.filter((entry) => entry.origins.includes('person') && props.id.startsWith(`${entry.kind}:`)).sort((a, b) => b.kind.length - a.kind.length)[0];
  if (kind !== undefined) return <AuthoredPage key={props.id} kind={kind.kind} uid={props.id.slice(kind.kind.length + 1)} version={props.version} />;
  return <RenderedEntityPage {...props} />;
}

function RenderedEntityPage({ id, after = null, version }: { id: string; after?: string | null; version: number }): ReactElement {
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
        <AlertDescription><Paragraph>{error}</Paragraph></AlertDescription>
      </Alert>
    );
  }
  // A planned change on this page is said in its header and on each statement that stands on it (madarch-m38l.14).
  const planned: PlannedMarks = {
    headings: {},
    statements: Object.fromEntries((page.planned?.statements ?? []).map((mark) => [sentenceKey(mark.sentence), { task: mark.task, how: mark.how }])),
  };
  return (
    <PageArticle data-testid="entity-page" data-entity={page.id} data-kind={page.kind} data-planned={page.planned?.entity === null || page.planned?.entity === undefined ? 'false' : page.planned.entity.how}>
      <PageHeader className="mb-6">
        <HistoryBar history={page.history} navigation={page.historyNavigation} absent={page.historicalAbsent} />
        <Trail trail={page.trail} />
        <Stack className="mb-2 flex items-center gap-2">
          <Badge data-testid="page-kind">{kindName(page.kind, 'one')}</Badge>
          {page.planned?.entity != null && <PlannedBadge mark={page.planned.entity} />}
          {(page.problems ?? 0) > 0 && <Text data-testid="page-problems"><KLink href={WIKI_PROBLEMS}><Badge variant="solid">{t('knowledge.pageProblems', { count: page.problems })}</Badge></KLink></Text>}
        </Stack>
        <PageTitle data-testid="page-title">{page.title}</PageTitle>
        {page.notes.map((note) => <Paragraph key={note} className="text-small text-muted" data-testid="page-note">{note}</Paragraph>)}
        {page.planned?.note !== undefined && <Paragraph className="text-small" role="alert" data-testid="page-planned-note">{page.planned.note}</Paragraph>}
        {/* «Как агент писал эту страницу» only where the store holds a journal of it (madarch-m38l.23). */}
        {page.journal !== undefined && <Paragraph className="text-small" data-testid="journal-link"><KLink href={addressOfJournal(page.id)}>{t('journal.title')}</KLink></Paragraph>}
      </PageHeader>
      <PlannedContext.Provider value={planned}>
      {page.blocks.map((block, index) => {
        const view = <BlockView key={index} block={block} resolutions={page.resolutions} pageId={page.id} />;
        if (blockOpen(block, role, roles)) return view;
        // The role does not open this block: it stays on the page, collapsed under its title.
        const title = 'title' in block ? block.title : block.type;
        return <Disclosure key={index} className="role-collapsed mb-4" data-testid="block-collapsed" data-block-type={block.type}><DisclosureSummary className="cursor-pointer text-secondary">{title}</DisclosureSummary>{view}</Disclosure>;
      })}
      </PlannedContext.Provider>
      <Findings findings={page.findings} />
    </PageArticle>
  );
}

/** The map of a kind's pages and the services behind them (the domain context map); nothing is drawn for a kind no service stands behind. */
function KindMap({ kind, version }: { kind: string; version: number }): ReactElement | null {
  const { t, i18n } = useTranslation();
  const lang = i18n.resolvedLanguage ?? 'en';
  const read = useRead<{ renderer: DiagramRenderer; views: DiagramView[] }>(`map\0${kind}\0${lang}`, version, (signal) => getViews(new URLSearchParams({ type: 'domain-map', subject: kind }).toString(), lang, signal));
  const view = read.data?.views[0];
  if (read.data === null || view === undefined || view.empty !== null) return null;
  return <Stack className="mb-6" data-testid="kind-map"><DiagramsView block={{ type: 'diagrams', title: t('knowledge.views.kindMap'), renderer: read.data.renderer, views: [view] }} /></Stack>;
}

/** A kind's entities: filtered by text, a hundred at a time. */
export function KindPage(props: { kind: string; version: number }): ReactElement {
  const summary = useContext(KindLabels).find((entry) => entry.kind === props.kind);
  if (summary?.origins.includes('person')) return <AuthoredKindPage key={props.kind} {...props} />;
  return <RenderedKindPage {...props} />;
}

function RenderedKindPage({ kind, version }: { kind: string; version: number }): ReactElement {
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
    <PageSection data-testid="kind-page" data-kind={kind}>
      <PageHeader className="mb-6">
        <Stack className="mb-2 flex items-center gap-2"><Badge>{kindName(kind, 'one')}</Badge></Stack>
        <PageTitle>{kindName(kind, 'many')}</PageTitle>

      </PageHeader>
      {listing?.agentUsage !== undefined && <Paragraph className="text-small text-muted" data-testid="kind-agent-usage">{t('knowledge.kindAgentModel', { model: listing.agentUsage.model ?? t('knowledge.kindNotReported') })} · {listing.agentUsage.tokens === undefined ? t('knowledge.kindTokensNotReported') : t('knowledge.kindAgentTokens', { count: listing.agentUsage.tokens })}</Paragraph>}
      <KindUsage kind={kind} version={version} />
      <KindDetails kind={kind} version={version} />
      <KindMap kind={kind} version={version} />
      <SectionTitle>{t('knowledge.kindDetails.records')}</SectionTitle>
      <Stack className="flex items-center gap-3">
        <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('knowledge.filter')} aria-label={t('knowledge.filter')} className="w-96 max-w-full" data-testid="kind-filter" />
        {listing !== null && <Text className="text-small text-muted" data-testid="kind-total">{t('knowledge.total', { count: listing.total })}</Text>}
      </Stack>
      {(error ?? read.error) !== null && <Alert variant="problem" className="mb-4"><AlertDescription><Paragraph>{error ?? read.error}</Paragraph></AlertDescription></Alert>}
      {listing === null && read.error === null && <PageSkeleton testId="kind-loading" rows />}
      {listing !== null && rows.length === 0 && <Paragraph className="text-muted" data-testid="kind-empty">{listing.agentFill === 'unconfigured' ? <>{t('knowledge.kindWaitingForAgent')} <KLink href={WIKI_FILL}>{t('knowledge.kindStartAgentFill')}</KLink></> : listing.agentFill === 'ready' ? <>{t('knowledge.kindWaitingForFill')} <KLink href={WIKI_FILL}>{t('knowledge.kindStartAgentFill')}</KLink></> : summary?.source === 'document' ? t('knowledge.noStageYet') : t('knowledge.nothingOfKind')}</Paragraph>}
      {rows.length > 0 && operations && <Operations rows={rows} metadata={{...listing?.operations, ...operationMore}} />}
      {rows.length > 0 && !operations && (
        <Table>
          <TableHeader>
            <TableRow><TableHead>{t('knowledge.colName')}</TableHead><TableHead>{t('knowledge.colPlace')}</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} data-entity={row.id}>
                <TableCell className="break-words"><EntityName entity={row} /></TableCell>
                <TableCell>{row.location !== undefined ? <CodePlace location={row.location} /> : <Text className="text-muted">–</Text>}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {next !== null && <Stack className="mt-4"><Button variant="default" size="default" onClick={load} data-testid="kind-more">{t('knowledge.more')}</Button></Stack>}
    </PageSection>
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
        <AlertDescription><Paragraph>{error}</Paragraph></AlertDescription>
      </Alert>
    );
  }
  if (file === null) return <PageSkeleton testId="source-loading" />;
  const total = file.text.endsWith('\n') ? file.text.split('\n').length - 1 : file.text.split('\n').length;
  return (
    <PageSection data-testid="source-page" data-path={path}>
      <HistoryBar history={file.history} />
      <PageHeader className="mb-4">
        <InlineGroup>
          <Badge>{file.repo ?? t('knowledge.productRepository')}</Badge>
          <Badge>{file.language}</Badge>
          {file.commit !== null && <Badge title={file.commit}>{file.commit.slice(0, 10)}</Badge>}
          <Metadata>{t('knowledge.lines', { count: total })}</Metadata>
        </InlineGroup>
        <FileTitle data-testid="source-title">{path}</FileTitle>
      </PageHeader>
      <CodeFrame ref={box}>
        <CodeLines text={file.text.endsWith('\n') ? file.text.slice(0, -1) : file.text} language={file.language} firstLine={1} focus={line} />
      </CodeFrame>
    </PageSection>
  );
}

/** The fill's card: what to do on an empty product, the progress of a running fill, a failed fill's reason. */
export function FillCard({ status, refresh }: { status: WikiStatus; refresh: () => void }): ReactElement | null {
  return (
    <>
      <FillPart status={status} />
      <WriterLine status={status} refresh={refresh} />
    </>
  );
}

function FillPart({ status }: { status: WikiStatus }): ReactElement | null {
  const { t } = useTranslation();
  const fill = status.fill;
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
          <Progress value={Math.round(share * 100)} aria-label={t('knowledge.fillRunningTitle')} />
          {progress !== undefined && planned > 0 && (
            <Paragraph className="mb-0 mt-3 text-small text-muted" data-testid="fill-progress-counts">{t('knowledge.repository.progressCounts', { published, planned })}</Paragraph>
          )}
          {progress !== undefined && planned === 0 && (
            <Paragraph className="mb-0 mt-3 text-small text-muted" data-testid="fill-progress-spans">{t('knowledge.repository.fillSpans', { spans: progress.spans })}</Paragraph>
          )}
          {progress?.last !== null && progress?.last !== undefined && (progress.last.startsWith('fill.unit') || progress.last.startsWith('scheduler pass')) && (
            <Paragraph className="mb-0 mt-1 break-all text-small text-muted" data-testid="fill-progress-last">{t('knowledge.repository.fillLast', { last: progress.last })}</Paragraph>
          )}
          <Paragraph className="mb-0 mt-3 text-small text-muted">{t('knowledge.fillLive')}</Paragraph>
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
            <Paragraph className="mb-0 mt-2 break-all text-small" data-testid="fill-error-where">{t('knowledge.repository.errorAt', { file: fill.error.file, line: fill.error.line ?? 0, path: fill.error.path ?? '' })}</Paragraph>
          )}
          {fill.error !== undefined && fill.error.file === undefined && fill.error.path !== undefined && (
            <Paragraph className="mb-0 mt-2 break-all text-small" data-testid="fill-error-path">{t('knowledge.repository.errorPath', { path: fill.error.path })}</Paragraph>
          )}
          <Paragraph className="mt-2"><KLink href={WIKI_FILL} testId="fill-start">{t('knowledge.fillRetry')}</KLink></Paragraph>
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
          <KLink href={WIKI_FILL} testId="fill-start">{t('knowledge.fillContinue')}</KLink>
        </CardContent>
      </Card>
    );
  }
  if (status.filled) {
    // The code is read. With no pages yet, point the reader to the fill choices.
    const offered = (status.home === null || (status.kinds.find((kind) => kind.kind === 'domain')?.count ?? 0) === 0) && status.writer.state === 'idle';
    if (!offered) return null;
    return (
      <Card className="mb-8" data-testid="fill-card" data-state="offer">
        <CardHeader>
          <CardTitle>{t('knowledge.writer.offerTitle')}</CardTitle>
          <CardDescription>{t('knowledge.writer.offerDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <KLink href={WIKI_FILL} testId="fill-start">{t('knowledge.fillStart')}</KLink>
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
          <KLink href={WIKI_FILL} testId="fill-start">{t('knowledge.fillStart')}</KLink>
        ) : (
          <Preformatted className="!my-0" data-testid="fill-hint"><code>madarch repo add &lt;name&gt; &lt;url&gt;</code></Preformatted>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The product's front when no page is the home: an introduction for a newcomer in the interface language, and the fill's
 * card linking to the fill choices. The words are the engine's own and say nothing about this product.
 */
export function Overview({ status, refresh }: { status: WikiStatus; refresh: () => void }): ReactElement {
  const { t } = useTranslation();
  useTabTitle(status.product.name);
  return (
    <PageSection data-testid="overview">
      <PageHeader className="mb-6">
        <PageTitle>{status.product.name}</PageTitle>
        <Paragraph className="text-secondary" data-testid="home-intro">{t('knowledge.homeIntro.summary')}</Paragraph>
      </PageHeader>
      <PageSection className="mb-8" data-testid="home-guidance">
        <SectionTitle className="mt-0">{t('knowledge.homeIntro.canTitle')}</SectionTitle>
        <BulletList>
          <ListItem>{t('knowledge.homeIntro.canStart')}</ListItem>
          <ListItem>{t('knowledge.homeIntro.canOpen')}</ListItem>
          <ListItem>{t('knowledge.homeIntro.canAsk')}</ListItem>
        </BulletList>
        <SectionTitle>{t('knowledge.homeIntro.howTitle')}</SectionTitle>
        <Paragraph>{t('knowledge.homeIntro.howRead')}</Paragraph>
        <Paragraph>{t('knowledge.homeIntro.howStages')}</Paragraph>
        <Paragraph className="mb-0">{t('knowledge.homeIntro.howAgent')}</Paragraph>
      </PageSection>
      <FillCard status={status} refresh={refresh} />
    </PageSection>
  );
}

/** The guide every product without a starter set needs: the file in the repository the release is published from. */
const MANIFESTS_GUIDE = 'https://github.com/shady2k/madarch/blob/main/docs/guides/how-to-write-a-product-s-manifests.md';

/** A product with no kinds manifest: what the file is and where it comes from, and the guide that writes one. */
export function EmptyHome({ status }: { status: WikiStatus; refresh: () => void }): ReactElement {
  const { t } = useTranslation();
  useTabTitle(status.product.name);
  return (
    <PageSection data-testid="no-manifest">
      <PageHeader className="mb-6">
        <PageTitle>{status.product.name}</PageTitle>
      </PageHeader>
      <Card>
        <CardHeader>
          <CardTitle>{t('knowledge.noManifestTitle')}</CardTitle>
          <CardDescription>{t('knowledge.noManifest', { file: status.manifestFile })}</CardDescription>
        </CardHeader>
        <CardContent>
          <Paragraph>{t('knowledge.noManifestScratch', { file: status.manifestFile })}</Paragraph>
          <Paragraph className="mb-0">
            <TextLink href={MANIFESTS_GUIDE} target="_blank" rel="noreferrer" data-testid="manifests-guide">{t('knowledge.noManifestGuide')}</TextLink>
          </Paragraph>
        </CardContent>
      </Card>
    </PageSection>
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
    <PageSection data-testid="not-filled">
      <PageHeader className="mb-6">
        <PageTitle>{status.product.name}</PageTitle>
      </PageHeader>
      <Card className="mb-8">
        <CardHeader>
          <CardTitle>{t('knowledge.notFilledTitle')}</CardTitle>
          <CardDescription>{t('knowledge.notFilledWhat', { file: status.manifestFile })}</CardDescription>
        </CardHeader>
        <CardContent>
          <Paragraph>{t('knowledge.notFilledNext')}</Paragraph>
          <Paragraph className="mb-0">
            <TextLink href={MANIFESTS_GUIDE} target="_blank" rel="noreferrer" data-testid="manifests-guide">{t('knowledge.notFilledGuide')}</TextLink>
          </Paragraph>
        </CardContent>
      </Card>
      <FillCard status={status} refresh={refresh} />
    </PageSection>
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
        <AlertDescription><Paragraph>{error}</Paragraph></AlertDescription>
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
    <PageSection data-testid="documents-page">
      <PageHeader className="mb-6">
        <PageTitle>{t('knowledge.documents')}</PageTitle>
        <Paragraph className="text-secondary" data-testid="documents-intro">{t('knowledge.documentsIntro')}</Paragraph>
        <Stack className="flex items-center gap-3">
          <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('knowledge.filterSources')} aria-label={t('knowledge.filterSources')} data-testid="documents-filter" />
          <Text className="text-small text-muted" data-testid="documents-total">{t('knowledge.total', { count: shown.length })}</Text>
        </Stack>
      </PageHeader>
      {shown.length === 0 && <Paragraph className="text-muted" data-testid="documents-empty">{t('knowledge.noDocuments')}</Paragraph>}
      {[...groups.entries()].map(([repo, documents]) => (
        <PageSection key={repo} className="mb-8" data-testid="documents-group" data-repo={repo}>
          <SectionTitle className="first-letter:uppercase">{repo === '' ? t('knowledge.productRepository') : repo}</SectionTitle>
          <PlainList className="m-0 list-none p-0">
            {documents.map((document) => (
              <ListItem key={document.path} className="border-b border-line py-1.5 last:border-b-0" data-testid="document-row">
                <KLink href={addressOfDocument(document.repo, document.path)}>{document.title}</KLink>
                <Text className="block break-all text-small text-muted" data-testid="document-path">{document.path}</Text>
              </ListItem>
            ))}
          </PlainList>
          {listing.truncated.filter((cut) => (cut.repo ?? '') === repo).map((cut) => <Paragraph key={repo} className="mt-2 text-small text-muted" data-testid="documents-cut">{t('knowledge.showing', { shown: cut.shown, total: cut.total })}</Paragraph>)}
        </PageSection>
      ))}
    </PageSection>
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
        <AlertDescription><Paragraph>{error}</Paragraph></AlertDescription>
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
    <PageArticle data-testid="document-page" data-path={page.path} data-repo={page.repo ?? ''} data-planned={String((page.planned ?? []).length)}>
      <PageHeader className="mb-6">
        <Breadcrumb aria-label="trail" className="mb-2 flex flex-wrap items-center gap-x-2 text-small text-muted"><KLink href={WIKI_DOCS}>{t('knowledge.documents')}</KLink><Text aria-hidden="true">/</Text><Text>{page.repo ?? t('knowledge.productRepository')}</Text></Breadcrumb>
        <Stack className="mb-2 flex items-center gap-2">
          <Badge>{t('knowledge.documentBadge')}</Badge>
          <InlineCode className="min-w-0 truncate text-small text-muted" title={page.path}>{page.path}</InlineCode>
          {page.commit !== null && <Badge title={page.commit}>{page.commit.slice(0, 10)}</Badge>}
        </Stack>
      </PageHeader>
      {page.plannedNote !== undefined && <Alert data-testid="document-planned-note"><AlertDescription><Paragraph>{page.plannedNote}</Paragraph></AlertDescription></Alert>}
      <PlannedContext.Provider value={planned}>
        <KMarkdown text={page.markdown} resolutions={page.resolutions} inDocument={{ repo: page.repo, path: page.path, anchors: page.anchors }} />
      </PlannedContext.Provider>
    </PageArticle>
  );
}

/** Every kind of one catalogue section, its subgroups included. */
function sectionKinds(section: { kinds: CatalogKindView[]; subgroups: { kinds: CatalogKindView[] }[] }): CatalogKindView[] {
  return [...section.kinds, ...section.subgroups.flatMap((subgroup) => subgroup.kinds)];
}

/** The manifest's kinds, grouped by section, with their meaning, records, producer and state. */
export function CataloguePage({ version }: { version: number }): ReactElement {
  const { t, i18n } = useTranslation();
  const language = (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  useTabTitle(t('knowledge.catalogue'));
  const { data, error } = useRead<CatalogView>('catalogue', version, getCatalog);
  const [filter, setFilter] = useState('');
  const [view, setView] = useState('table');
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  useEffect(() => {
    if (jumpTo === null || view !== 'table') return;
    // Radix mounts the newly selected panel after the view change.
    const frame = requestAnimationFrame(() => {
      document.getElementById(jumpTo)?.scrollIntoView?.({ block: 'start' });
      setJumpTo(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [jumpTo, view]);
  if (error !== null && data === null) {
    return <Alert data-testid="catalogue-error"><AlertTitle>{t('knowledge.catalogue')}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>;
  }
  if (data === null) return <PageSkeleton testId="catalogue-loading" />;
  const query = filter.trim().toLocaleLowerCase(language);
  const all = data.kinds.filter((kind) => [kind.kind, kind.labels?.[language]?.many, kind.labels?.[language]?.one, kind.descriptions?.[language]].some((text) => text?.toLocaleLowerCase(language).includes(query)));
  const known = new Set(data.groups.map((group) => group.group));
  const top = data.groups.filter((group) => group.parent === undefined || !known.has(group.parent));
  const children = data.groups.filter((group) => group.parent !== undefined && known.has(group.parent));
  const label = (group: GroupSummary): string => group.labels[language] ?? group.labels['en'] ?? group.group;
  const ofArea = (area: string): CatalogKindView[] => all.filter((kind) => areaOf(data.groups, kind) === area && (kind.subgroup === '' || !known.has(kind.subgroup)));
  const ofSubgroup = (subgroup: string): CatalogKindView[] => all.filter((kind) => kind.subgroup === subgroup);
  const placed = new Set([...top.map((group) => group.group), ...children.map((group) => group.group)]);
  const other = all.filter((kind) => !placed.has(areaOf(data.groups, kind)) && !placed.has(kind.subgroup));
  const sections = [
    ...top.map((group) => ({
      key: group.group,
      name: label(group),
      kinds: ofArea(group.group),
      subgroups: children.filter((child) => child.parent === group.group).map((child) => ({ key: child.group, name: label(child), kinds: ofSubgroup(child.group) })),
    })),
    ...(other.length === 0 ? [] : [{ key: '\0other', name: t('knowledge.groupOther'), kinds: other, subgroups: [] }]),
  ].filter((section) => sectionKinds(section).length > 0);
  const records = all.reduce((sum, kind) => sum + kind.count, 0);
  const nameOf = (kind: CatalogKindView): string => kind.labels?.[language]?.many ?? kind.kind;
  const sectionId = (key: string): string => `catalogue-section-${encodeURIComponent(key)}`;
  const kindId = (kind: string): string => `catalogue-kind-${encodeURIComponent(kind)}`;
  const kindContents = (kinds: CatalogKindView[]) => kinds.map((kind) => ({ id: kindId(kind.kind), label: nameOf(kind) }));
  const contents = sections.map((section) => ({
    id: sectionId(section.key), label: section.name,
    children: [...kindContents(section.kinds), ...section.subgroups.map((subgroup) => ({
      id: sectionId(subgroup.key), label: subgroup.name, children: kindContents(subgroup.kinds),
    }))],
  }));
  const producerWords = (kind: CatalogKindView): string => {
    if ((kind.plugins ?? []).length > 0) return t('knowledge.catalogueByPlugin', { plugins: (kind.plugins ?? []).join(', ') });
    if (kind.producer === 'extract') return t('knowledge.catalogueStage.extract');
    if (kind.producer === 'documents') return t('knowledge.catalogueStage.documents');
    if (kind.producer === 'history') return t('knowledge.catalogueStage.history');
    if (fillWithOf(kind) === 'person') return t('knowledge.catalogueByPerson');
    return t('knowledge.catalogueByAgent');
  };
  const stateOf = (kind: CatalogKindView): string => kind.turn === 'failed' || kind.turn === 'blocked' || kind.turn === 'cancelled' ? 'failed' : kind.state;
  const totals = (kinds: CatalogKindView[]): ReactElement => <>{t('knowledge.catalogueKinds', { count: kinds.length })}, {t('knowledge.catalogueEntities', { count: kinds.reduce((sum, kind) => sum + kind.count, 0) })}</>;
  const table = (rows: CatalogKindView[]): ReactElement => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('knowledge.catalogueColKind')}</TableHead>
          <TableHead>{t('knowledge.catalogueColAbout')}</TableHead>
          <TableHead>{t('knowledge.catalogueColCount')}</TableHead>
          <TableHead>{t('knowledge.catalogueColStage')}</TableHead>
          <TableHead>{t('knowledge.catalogueColState')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((kind) => (
          <TableRow key={kind.kind} id={kindId(kind.kind)} data-kind={kind.kind} data-filled={String(kind.filled)} className="cursor-pointer" onClick={(event) => {
            if ((event.target as Element).closest('a, button')) return;
            linkHandlers(addressOfKind(kind.kind)).onClick(event);
          }}>
            <TableCell className="align-top wrap-anywhere">
              <KLink href={addressOfKind(kind.kind)}>{nameOf(kind)}</KLink>
            </TableCell>
            <TableCell className="align-top">{kind.descriptions?.[language] ?? <Text className="text-muted">–</Text>}<KindSources kind={kind} compact /></TableCell>
            <TableCell className="align-top" data-testid="catalogue-count">
              {kind.count > 0 ? <KLink href={addressOfKind(kind.kind)}>{kind.count}</KLink> : kind.count}
              {kind.statements !== undefined && <Text className="block text-small text-muted" data-testid="catalogue-statements">{t('knowledge.catalogueStatements', { count: kind.statements })}</Text>}
            </TableCell>
            <TableCell className="align-top" data-testid="catalogue-stage" data-stage={fillWithOf(kind)}>{producerWords(kind)}</TableCell>
            <TableCell className="align-top" data-testid="catalogue-states">
              <Badge variant={stateOf(kind) === 'never' ? 'outline' : 'solid'} data-testid="catalogue-state" data-state={stateOf(kind)}>{t(`knowledge.catalogueState.${stateOf(kind)}`)}</Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
  return (
    <PageSection data-testid="catalogue-page">
      <PageHeader className="mb-6">
        <PageTitle>{t('knowledge.catalogue')}</PageTitle>
        <Paragraph className="mb-1" data-testid="catalogue-intro">{t('knowledge.catalogueIntro')}</Paragraph>
        <Paragraph className="mt-0 text-small text-muted" data-testid="catalogue-total">{t('knowledge.catalogueKinds', { count: all.length })}, {t('knowledge.catalogueEntities', { count: records })}</Paragraph>
      </PageHeader>
      <Input type="search" className="mb-4" aria-label={t('knowledge.catalogueViews.filter')} placeholder={t('knowledge.catalogueViews.filter')} value={filter} onChange={(event) => setFilter(event.target.value)} />
      <Stack layout="catalogue">
      <Stack className="min-w-0">
      <Tabs value={view} onValueChange={setView}>
        <TabsList aria-label={t('knowledge.catalogueViews.label')}>
          <TabsTrigger value="table">{t('knowledge.catalogueViews.table')}</TabsTrigger>
          <TabsTrigger value="graph">{t('knowledge.catalogueViews.graph')}</TabsTrigger>
        </TabsList>
        <TabsContent value="table">
      {sections.map((section) => (
        <PageSection key={section.key} id={sectionId(section.key)} className="mb-8 scroll-mt-4" data-testid="catalogue-group" data-group={section.key}>
          <SectionTitle className="flex flex-wrap items-baseline gap-x-3 gap-y-1">{section.name}<Text className="text-small font-normal text-muted" data-testid="catalogue-group-total">{totals(sectionKinds(section))}</Text></SectionTitle>
          {section.kinds.length > 0 && table(section.kinds)}
          {section.subgroups.map((subgroup) => (
            <PageSection key={subgroup.key} id={sectionId(subgroup.key)} className="mb-5 scroll-mt-4" data-testid="catalogue-subgroup" data-subgroup={subgroup.key}>
              <SmallTitle className="mb-2 mt-5 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-body">{subgroup.name}<Text className="text-small font-normal text-muted">{totals(subgroup.kinds)}</Text></SmallTitle>
              {subgroup.kinds.length > 0 ? table(subgroup.kinds) : <Paragraph className="mt-0 text-small text-muted" data-testid="catalogue-empty-subgroup">{t('knowledge.catalogueEmptyGroup')}</Paragraph>}
            </PageSection>
          ))}
        </PageSection>
      ))}
        </TabsContent>
        <TabsContent value="graph"><KindGraph catalog={{ ...data, kinds: all }} /></TabsContent>
      </Tabs>
      </Stack>
      <ContentsSidebar data-testid="catalogue-contents">
        <TableOfContents title={t('knowledge.catalogueViews.contents')} items={contents} onNavigate={(id) => { setView('table'); setJumpTo(id); }} />
      </ContentsSidebar>
      </Stack>
    </PageSection>
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
    <Stack data-testid="excerpt" data-excerpt="entity" className="flex flex-col gap-3">
      <Paragraph className="m-0 text-small text-muted" data-testid="card-kind">{kindName(entity.kind, 'one')}{description !== undefined && <> · {description}</>}</Paragraph>
      {excerpt.facts.length > 0 && (
        <Stack>
          <Paragraph className="mb-1 mt-0 text-small text-muted">{t('knowledge.cardFacts')}</Paragraph>
          <DefinitionList columns data-testid="card-facts">
            {excerpt.facts.map((fact) => (<Fragment key={fact.name}><DefinitionTerm className="font-mono text-secondary">{fact.name}</DefinitionTerm><DefinitionValue className="m-0 break-words">{fact.value}</DefinitionValue></Fragment>))}
          </DefinitionList>
        </Stack>
      )}
      {excerpt.related.length > 0 && (
        <Stack data-testid="card-related">
          <Paragraph className="mb-1 mt-0 text-small text-muted">{t('knowledge.cardRelated')}</Paragraph>
          <PlainList className="m-0 flex list-none flex-col gap-1 p-0 text-small">
            {excerpt.related.map((group) => (
              <ListItem key={`${group.relation}:${group.direction}`} data-relation={group.relation}>
                <Text className="text-muted">{groupLabel(group, t)}: </Text>
                {group.rows.map((row, index) => <Fragment key={row.entity.id}>{index > 0 && ', '}<EntityName entity={row.entity} /></Fragment>)}
                {group.total > group.rows.length && <Text className="text-muted"> +{group.total - group.rows.length}</Text>}
              </ListItem>
            ))}
          </PlainList>
        </Stack>
      )}
      {entity.href !== null && <Paragraph className="m-0 text-small" data-testid="card-page"><KLink href={entity.href}>{t('knowledge.cardOpen', { kind: kindName(entity.kind, 'one').toLowerCase() })}</KLink></Paragraph>}
    </Stack>
  );
}

function ExcerptView({ excerpt }: { excerpt: Excerpt }): ReactElement {
  const { t } = useTranslation();
  if (excerpt.type === 'text') {
    const place = excerpt.place;
    return (
      <Stack data-testid="excerpt" data-excerpt="text">
        <Blockquote className="!my-0"><KMarkdown text={excerpt.markdown} resolutions={{}} /></Blockquote>
        <Paragraph className="mb-0 mt-2 text-small text-muted"><KLink href={place.href}>{place.path}:{place.lineStart}{place.lineEnd > place.lineStart ? `–${place.lineEnd}` : ''}</KLink></Paragraph>
      </Stack>
    );
  }
  if (excerpt.type === 'entity') return <EntityCard excerpt={excerpt} />;
  return (
    <Stack data-testid="excerpt" data-excerpt="code">
      <CodeFrame>
        <CodeLines text={excerpt.text} language={excerpt.language} firstLine={excerpt.firstLine} marked={excerpt.marked} />
      </CodeFrame>
      <Paragraph className="mb-0 mt-2 flex flex-wrap items-center gap-x-3 text-small text-muted">
        <CodePlace location={excerpt.location} />
        {excerpt.marked.start > 0 && <Text>{t('knowledge.citedLines', { start: excerpt.marked.start, end: excerpt.marked.end })}</Text>}
        {excerpt.truncated && <Text>{t('knowledge.cutShown')}</Text>}
      </Paragraph>
    </Stack>
  );
}

function GroundCard({ ground, index }: { ground: GroundView; index: number }): ReactElement {
  const { t } = useTranslation();
  const kindName = useKindName();
  const resolution = ground.resolution;
  return (
    <Card data-testid="ground" data-state={resolution.state} data-ground={ground.url}>
      <CardHeader className="flex-row items-center gap-3 pb-3">
        <Text className="text-small text-muted" aria-hidden="true">{index + 1}</Text>
        {resolution.state === 'broken' ? (
          <CardTitle className="min-w-0 flex-1 text-small"><Text className="ref-broken" data-testid="ref-broken" title={brokenWords(resolution, t)}>{ground.url.replace(/^madarch:/, '')}<Text className="ref-broken-mark">{t('knowledge.broken')}</Text></Text></CardTitle>
        ) : (
          <>
            <CardTitle className="min-w-0 flex-1 text-small">{resolution.href === null ? resolution.label : <KLink href={resolution.href}>{resolution.label}</KLink>}</CardTitle>
            <Badge>{resolution.kind === 'document' ? t('knowledge.documentBadge') : kindName(resolution.kind, 'one')}</Badge>
          </>
        )}
      </CardHeader>
      <CardContent>
        {resolution.state === 'broken' && <Paragraph className="m-0 text-small" role="note">{brokenWords(resolution, t)}</Paragraph>}
        {resolution.state === 'ok' && ground.excerpt !== null && <ExcerptView excerpt={ground.excerpt} />}
        {resolution.state === 'ok' && ground.excerpt === null && <Paragraph className="m-0 text-small text-muted">{t('knowledge.statementNoExcerpt')}</Paragraph>}
      </CardContent>
    </Card>
  );
}

/** Where a person says the statement is wrong and why: a correction file in the product repository, committed under the person's git name. */
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
        <AlertDescription><Paragraph>{error}</Paragraph></AlertDescription>
      </Alert>
    );
  }
  return (
    <PageArticle data-testid="statement-page">
      <PageHeader className="mb-6">
        <Stack className="mb-2 flex flex-wrap items-center gap-2">
          <Badge>{t('knowledge.statementTitle')}</Badge>
          <Text className="text-small text-muted">{t('knowledge.statementOnPage')}: <EntityName entity={statement.page} /></Text>
        </Stack>
        <Paragraph className="statement-sentence m-0" data-testid="statement-sentence">{statement.sentence}</Paragraph>
        {statement.planned != null && <Paragraph className="m-0 mt-2" data-testid="statement-planned"><PlannedBadge mark={statement.planned} ground={statement.planned.how === 'impact'} /></Paragraph>}
        {statement.plannedNote !== undefined && <Paragraph className="m-0 mt-1 text-small" role="alert" data-testid="statement-planned-note">{statement.plannedNote}</Paragraph>}
      </PageHeader>
      <PageSection className="mb-8" data-testid="statement-paragraph">
        <SectionTitle>{t('knowledge.statementParagraph')}</SectionTitle>
        <Blockquote className="!my-0"><KMarkdown text={statement.paragraph} resolutions={statement.resolutions} /></Blockquote>
        <Paragraph className="mb-0 mt-2 text-small text-muted">{t('knowledge.statementWhere', { file: statement.file, line: statement.line })}</Paragraph>
      </PageSection>
      <PageSection className="mb-8" data-testid="statement-grounds">
        <SectionTitle>{t('knowledge.statementGrounds')}</SectionTitle>
        {statement.grounds.length === 0 ? (
          <Alert variant="problem" data-testid="statement-no-grounds"><AlertDescription><Paragraph>{t('knowledge.statementNoGrounds')}</Paragraph></AlertDescription></Alert>
        ) : (
          <Stack className="flex flex-col gap-4">{statement.grounds.map((ground, index) => <GroundCard key={ground.url} ground={ground} index={index} />)}</Stack>
        )}
      </PageSection>
      {statement.relying.length > 0 && (
        <PageSection className="mb-8" data-testid="statement-relying">
          <SectionTitle>{t('knowledge.statementRelying')}</SectionTitle>
          <Table>
            <TableHeader><TableRow><TableHead>{t('knowledge.statementOnPage')}</TableHead><TableHead>{t('knowledge.statementTitle')}</TableHead><TableHead>{t('knowledge.statementSharedGround')}</TableHead></TableRow></TableHeader>
            <TableBody>
              {statement.relying.map((other) => (
                <TableRow key={`${other.page}:${other.line}:${other.text}`}>
                  <TableCell className="align-top"><KLink href={addressOfEntity(other.page)}>{other.pageTitle}</KLink></TableCell>
                  <TableCell className="align-top">{other.sentence === undefined ? other.text : <KLink href={addressOfStatement(other.page, other.sentence, other.turn ?? 0)}>{other.text}</KLink>}</TableCell>
                  <TableCell className="align-top">{other.ground}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </PageSection>
      )}
    </PageArticle>
  );
}
