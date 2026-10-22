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
import { getEntities, getPage, getSource, startFill } from './api.js';
import { AgentChoice, WriterCard, useAgentChoice } from './writer.js';
import { BlockView, CodeLines, CodePlace, EntityName, Findings, KLink } from './blocks.js';
import { addressOfKind, kindPlural, kindWord } from './routes.js';
import type { EntityListing, EntityRef, PageModel, SourceFile, WikiStatus } from './types.js';

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
  const { t } = useTranslation();
  const [page, setPage] = useState<PageModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    getPage(id, controller.signal).then(
      (next) => {
        setPage(next);
        setError(null);
      },
      (failure: unknown) => {
        if (controller.signal.aborted) return;
        setError(message(failure));
      },
    );
    return () => controller.abort();
  }, [id, version]);
  if (page === null && error === null) return <p className="text-muted" data-testid="page-loading">{t('knowledge.loading')}</p>;
  if (page === null) {
    return (
      <Alert variant="problem" data-testid="page-error">
        <AlertTitle>{t('knowledge.noSuchPage')}</AlertTitle>
        <AlertDescription><p>{error}</p></AlertDescription>
      </Alert>
    );
  }
  return (
    <article data-testid="entity-page" data-entity={page.id} data-kind={page.kind}>
      <header className="mb-6">
        <Trail trail={page.trail} />
        <div className="mb-2 flex items-center gap-2">
          <Badge data-testid="page-kind">{kindWord(page.kind)}</Badge>
          <code className="min-w-0 truncate text-small text-muted" title={page.id}>{page.id}</code>
        </div>
        <h1 data-testid="page-title">{page.title}</h1>
        {page.notes.map((note) => <p key={note} className="text-small text-muted" data-testid="page-note">{note}</p>)}
      </header>
      {page.blocks.map((block, index) => <BlockView key={index} block={block} resolutions={page.resolutions} />)}
      <Findings findings={page.findings} />
    </article>
  );
}

/** A kind's entities: filtered by text, a hundred at a time. */
export function KindPage({ kind, version }: { kind: string; version: number }): ReactElement {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [listing, setListing] = useState<EntityListing | null>(null);
  const [more, setMore] = useState<EntityRef[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const wait = setTimeout(() => {
      getEntities(kind, { q: query }, controller.signal).then(
        (answer) => {
          setListing(answer);
          setMore([]);
          setNext(answer.next);
          setError(null);
        },
        (failure: unknown) => {
          if (!controller.signal.aborted) setError(message(failure));
        },
      );
    }, query === '' ? 0 : 200);
    return () => {
      clearTimeout(wait);
      controller.abort();
    };
  }, [kind, query, version]);
  const listingRef = useRef<EntityListing | null>(null);
  listingRef.current = listing;
  const rows = [...(listing?.rows ?? []), ...more];
  const load = (): void => {
    if (next === null) return;
    const mine = listing;
    getEntities(kind, { q: query, after: next }).then(
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
        <div className="mb-2 flex items-center gap-2"><Badge>{kind}</Badge></div>
        <h1>{kindPlural(kind)}</h1>
        <div className="flex items-center gap-3">
          <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('knowledge.filter')} aria-label={t('knowledge.filter')} className="max-w-sm" data-testid="kind-filter" />
          {listing !== null && <span className="text-small text-muted" data-testid="kind-total">{t('knowledge.total', { count: listing.total })}</span>}
        </div>
      </header>
      {error !== null && <Alert variant="problem" className="mb-4"><AlertDescription><p>{error}</p></AlertDescription></Alert>}
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
  if (file === null) return <p className="text-muted">{t('knowledge.loading')}</p>;
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
    choice.commit().then(() => startFill(choice.pick)).then(
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
    const done = fill.commit ?? 0;
    const total = fill.commits ?? 0;
    return (
      <Card className="mb-8" data-testid="fill-card" data-state="running">
        <CardHeader>
          <CardTitle>{t('knowledge.fillRunningTitle')}</CardTitle>
          <CardDescription>{fill.repository !== undefined ? t('knowledge.fillReading', { repository: fill.repository, commit: done, commits: total }) : t('knowledge.fillOpening')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--surface-active)]" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label={t('knowledge.fillRunningTitle')}>
            <div className="h-full rounded-full bg-ink transition-[width] duration-150 motion-reduce:transition-none" style={{ width: total === 0 ? '4%' : `${Math.max(4, Math.round((done / total) * 100))}%` }} />
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
          <p>{fill.message}</p>
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
              <CardTitle><KLink href={addressOfKind(kind.kind)}>{kindPlural(kind.kind)}</KLink></CardTitle>
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
  if (status.findings.length === 0) return null;
  return (
    <Alert variant="problem" className="mb-8" data-testid="manifest-findings">
      <AlertTitle>{t('knowledge.findings', { count: status.findings.length })}</AlertTitle>
      <AlertDescription>
        <ul className="!my-1">{status.findings.map((finding, index) => <li key={index}><span className="font-mono text-[0.875em]">{finding.file}:{finding.line}</span> {finding.message}</li>)}</ul>
      </AlertDescription>
    </Alert>
  );
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
        </CardHeader>
        <CardContent>
          <p className="mb-0"><a href={appPath('/') + '?documents'}>{t('knowledge.documents')}</a></p>
        </CardContent>
      </Card>
    </section>
  );
}
