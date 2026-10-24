/**
 * The views of the knowledge wiki: one entity's page, a kind's entities, a
 * source file at a line, the empty product's way forward, and the fill's card.
 * Each view reads the server's model and draws it; the page of an entity is its
 * blocks in the order its template gave them.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { appPath } from '../app-base.js';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.js';
import { Input } from '@/components/ui/input.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.js';
import { getDocument, getDocuments, getEntities, getPage, getSource, getStatement, correctStatement, startFill } from './api.js';
import { useTabTitle } from './tabs.js';
import { AgentChoice, WriterCard, useAgentChoice } from './writer.js';
import { FailureNote } from './errors.js';
import { BlockView, CodeLines, CodePlace, EntityName, Findings, KLink, KMarkdown, PlannedBadge, PlannedContext, brokenWords, scrollToAnchor, sentenceKey, type PlannedMarks } from './blocks.js';
import { addressOfDocument, addressOfJournal, addressOfKind, addressOfStatement } from './routes.js';
import { hasJournal } from './journal.js';
import { useKindName } from './kind-names.js';
import { fillShare, fillWords } from './fill-words.js';
import { useRead } from './live.js';
import { blockOpen, useRole } from './roles.js';
import { PageSkeleton } from './skeleton.js';
import { Textarea } from '@/components/ui/textarea.js';
import type { CorrectionResult, DocumentListing, DocumentPageModel, EntityListing, EntityRef, Excerpt, GroundView, Origin, PageModel, SourceFile, StatementModel, WikiStatus } from './types.js';

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
export function EntityPage({ id, version }: { id: string; version: number }): ReactElement {
  const { t, i18n } = useTranslation();
  const kindName = useKindName();
  const language = (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  const { data: page, error } = useRead<PageModel>(`${id}\0${language}`, version, (signal) => getPage(id, language, signal));
  const { role, roles } = useRole();
  useTabTitle(page?.title ?? null);
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
        <Trail trail={page.trail} />
        <div className="mb-2 flex items-center gap-2">
          <Badge data-testid="page-kind">{kindName(page.kind, 'one')}</Badge>
          {page.planned?.entity != null && <PlannedBadge mark={page.planned.entity} />}
        </div>
        <h1 data-testid="page-title">{page.title}</h1>
        {page.notes.map((note) => <p key={note} className="text-small text-muted" data-testid="page-note">{note}</p>)}
        {page.planned?.note !== undefined && <p className="text-small" role="alert" data-testid="page-planned-note">{page.planned.note}</p>}
        {hasJournal(page.id) && <p className="text-small" data-testid="journal-link"><KLink href={addressOfJournal(page.id)}>{t('journal.title')}</KLink></p>}
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

/** A kind's entities: filtered by text, a hundred at a time. */
export function KindPage({ kind, version }: { kind: string; version: number }): ReactElement {
  const { t } = useTranslation();
  const kindName = useKindName();
  const [query, setQuery] = useState('');
  const [asked, setAsked] = useState('');
  const [more, setMore] = useState<EntityRef[]>([]);
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
      {(error ?? read.error) !== null && <Alert variant="problem" className="mb-4"><AlertDescription><p>{error ?? read.error}</p></AlertDescription></Alert>}
      {listing === null && read.error === null && <PageSkeleton testId="kind-loading" rows />}
      {listing !== null && rows.length === 0 && <p className="text-muted" data-testid="kind-empty">{t('knowledge.nothingOfKind')}</p>}
      {rows.length > 0 && (
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
  useTabTitle(path.slice(path.lastIndexOf('/') + 1));
  useEffect(() => {
    const controller = new AbortController();
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
  }, [repo, path]);
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
      <WriterCard status={status} refresh={refresh} />
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
    const share = fillShare(fill);
    return (
      <Card className="mb-8" data-testid="fill-card" data-state="running">
        <CardHeader>
          <CardTitle>{t('knowledge.fillRunningTitle')}</CardTitle>
          <CardDescription>{fill.repository !== undefined ? t('knowledge.fillReading', { repository: fill.repository, what: fillWords(fill, t) }) : t('knowledge.fillOpening')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--surface-active)]" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)} aria-label={t('knowledge.fillRunningTitle')}>
            <div className="h-full rounded-full bg-ink transition-[width] duration-150 motion-reduce:transition-none" style={{ width: `${Math.round(share * 100)}%` }} />
          </div>
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
  const connected = status.repositories.length > 0;
  return (
    <Card className="mb-8" data-testid="fill-card" data-state="empty">
      <CardHeader>
        <CardTitle>{t('knowledge.emptyTitle')}</CardTitle>
        <CardDescription>{connected ? t('knowledge.emptyConnected', { repositories: status.repositories.map((repo) => repo.name).join(', ') }) : t('knowledge.emptyNoRepository')}</CardDescription>
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

/** The product's front: the fill card, the manifest's findings and the kinds, when no page is the home. */
export function Overview({ status, refresh }: { status: WikiStatus; refresh: () => void }): ReactElement {
  const { t } = useTranslation();
  const kindName = useKindName();
  useTabTitle(status.product.name);
  return (
    <section data-testid="overview">
      <header className="mb-6">
        <h1>{status.product.name}</h1>
        <p>{status.filled ? t('knowledge.overviewFilled') : t('knowledge.overviewEmpty')}</p>
      </header>
      <FillCard status={status} refresh={refresh} />
      <ManifestFindings status={status} />
      <div className="grid gap-3 sm:grid-cols-2">
        {status.kinds.filter((kind) => !kind.single).map((kind) => (
          <Card key={kind.kind} data-kind={kind.kind}>
            <CardHeader>
              <CardTitle><KLink href={addressOfKind(kind.kind)}>{kindName(kind.kind, 'many')}</KLink></CardTitle>
              <CardDescription>{kind.source === 'markdown' ? t('knowledge.fromMarkdown') : t('knowledge.fromGraph')}</CardDescription>
            </CardHeader>
            <CardContent><Badge>{kind.count}</Badge></CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

function ManifestFindings({ status }: { status: WikiStatus }): ReactElement | null {
  const { t } = useTranslation();
  if (status.seeded.length > 0) {
    return (
      <Alert className="mb-8" data-testid="starter-set">
        <AlertTitle>{t('knowledge.starterSetTitle')}</AlertTitle>
        <AlertDescription><p>{t('knowledge.starterSet', { files: status.seeded.join(', ') })}</p></AlertDescription>
      </Alert>
    );
  }
  if (status.findings.length === 0) return null;
  return <Findings findings={status.findings} scope="manifest" />;
}

/** A product with no kinds manifest: what the file is and where it comes from. */
export function EmptyHome({ status }: { status: WikiStatus; refresh: () => void }): ReactElement {
  const { t } = useTranslation();
  return (
    <section data-testid="no-manifest">
      <header className="mb-6">
        <h1>{status.product.name}</h1>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>{t('knowledge.noManifestTitle')}</CardTitle>
          <CardDescription>{t('knowledge.noManifest', { file: 'madarch/kinds.yaml' })}</CardDescription>
          {status.seedError !== undefined && <p className="mb-0 mt-2 text-small" role="alert" data-testid="seed-error">{status.seedError}</p>}
        </CardHeader>
        <CardContent>
          <p className="mb-0"><a href={appPath('/') + '?documents'}>{t('knowledge.documents')}</a></p>
        </CardContent>
      </Card>
    </section>
  );
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
  const wanted = query.trim().toLowerCase();
  const shown = listing.documents.filter((document) => wanted === '' || document.path.toLowerCase().includes(wanted));
  const groups = new Map<string, typeof shown>();
  for (const document of shown) {
    const key = document.repo ?? '';
    groups.set(key, [...(groups.get(key) ?? []), document]);
  }
  return (
    <section data-testid="documents-page">
      <header className="mb-6">
        <h1>{t('knowledge.documents')}</h1>
        <div className="flex items-center gap-3">
          <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('knowledge.filter')} aria-label={t('knowledge.filter')} className="max-w-sm" data-testid="documents-filter" />
          <span className="text-small text-muted" data-testid="documents-total">{t('knowledge.total', { count: shown.length })}</span>
        </div>
      </header>
      {shown.length === 0 && <p className="text-muted" data-testid="documents-empty">{t('knowledge.noDocuments')}</p>}
      {[...groups.entries()].map(([repo, documents]) => (
        <section key={repo} className="mb-8" data-testid="documents-group" data-repo={repo}>
          <h2 className="first-letter:uppercase">{repo === '' ? t('knowledge.productRepository') : repo}</h2>
          <ul className="m-0 list-none p-0">
            {documents.map((document) => (
              <li key={document.path} className="border-b border-line py-1.5 last:border-b-0"><KLink href={addressOfDocument(document.repo, document.path)}>{document.path}</KLink></li>
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
  useTabTitle(page?.title ?? null);
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
        <nav aria-label="trail" className="mb-2 flex flex-wrap items-center gap-x-2 text-small text-muted"><KLink href="/k/docs">{t('knowledge.documents')}</KLink><span aria-hidden="true">/</span><span>{page.repo ?? t('knowledge.productRepository')}</span></nav>
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

/** The origins a kind's entities have, as a reader says them. */
function OriginBadges({ origins }: { origins: readonly Origin[] }): ReactElement {
  const { t } = useTranslation();
  if (origins.length === 0) return <span className="text-muted">–</span>;
  return <span className="flex flex-wrap gap-1">{origins.map((origin) => <Badge key={origin} data-origin={origin}>{t(`knowledge.origin.${origin}`)}</Badge>)}</span>;
}

/**
 * The catalogue of the entity kinds the product's wiki works with, read from its manifest: by group, each kind with what
 * it is, how many entities the graph and the Markdown hold of it, how they got here, and a link to its list.
 */
export function CataloguePage({ status }: { status: WikiStatus }): ReactElement {
  const { t, i18n } = useTranslation();
  const kindName = useKindName();
  const language = (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  useTabTitle(t('knowledge.catalogue'));
  const kinds = status.kinds.filter((kind) => !kind.single || kind.count > 0);
  const known = new Set(status.groups.map((group) => group.group));
  const sections = [
    ...status.groups.map((group) => ({ key: group.group, name: group.labels[language] ?? group.labels['en'] ?? group.group, kinds: kinds.filter((kind) => kind.group === group.group) })),
    { key: '\0other', name: t('knowledge.groupOther'), kinds: kinds.filter((kind) => kind.group === undefined || !known.has(kind.group)) },
  ].filter((section) => section.kinds.length > 0);
  const entities = kinds.reduce((sum, kind) => sum + kind.count, 0);
  return (
    <section data-testid="catalogue-page">
      <header className="mb-6">
        <h1>{t('knowledge.catalogue')}</h1>
        <p className="mb-1">{t('knowledge.catalogueIntro')}</p>
        <p className="mt-0 text-small text-muted" data-testid="catalogue-total">{t('knowledge.catalogueTotal', { entities, kinds: kinds.length })}</p>
      </header>
      {sections.map((section) => (
        <section key={section.key} className="mb-8" data-testid="catalogue-group" data-group={section.key}>
          <h2 className="flex items-baseline gap-3">{section.name}<span className="text-small font-normal text-muted">{section.kinds.reduce((sum, kind) => sum + kind.count, 0)}</span></h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('knowledge.catalogueColKind')}</TableHead>
                <TableHead>{t('knowledge.catalogueColAbout')}</TableHead>
                <TableHead>{t('knowledge.catalogueColCount')}</TableHead>
                <TableHead>{t('knowledge.catalogueColOrigin')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {section.kinds.map((kind) => (
                <TableRow key={kind.kind} data-kind={kind.kind}>
                  <TableCell className="whitespace-nowrap align-top"><KLink href={addressOfKind(kind.kind)}>{kindName(kind.kind, 'many')}</KLink></TableCell>
                  <TableCell className="max-w-[32rem] align-top">{kind.descriptions?.[language] ?? kind.descriptions?.['en'] ?? <span className="text-muted">–</span>}</TableCell>
                  <TableCell className="align-top" data-testid="catalogue-count">{kind.count}{kind.statements !== undefined && <span className="block text-small text-muted" data-testid="catalogue-statements">{t('knowledge.catalogueStatements', { count: kind.statements })}</span>}</TableCell>
                  <TableCell className="align-top"><OriginBadges origins={kind.origins} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      ))}
    </section>
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
          {t('knowledge.statementCorrectionDone', { file: done.file })} {done.committed ? '' : (done.note ?? '')} <KLink href="/k/problems">{t('loop.problemsTitle')}</KLink>
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
                  <TableCell className="align-top"><KLink href={`/k/e/${encodeURIComponent(other.page)}`}>{other.pageTitle}</KLink></TableCell>
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
