import { OrderedList } from '@/components/ui/ordered-list.js';
import { InlineCode } from '@/components/ui/inline-content.js';
import { DefinitionList, DefinitionTerm, DefinitionValue, ListItem, PageArticle, PageHeader, PageSection, PageTitle, Paragraph, PlainList, SectionTitle, Stack, Text } from '@/components/ui/typography.js';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs.js';
import { Button } from '@/components/ui/button.js';
/**
 * The repository's entity-page blocks (madarch-hsqs stage A): a repository's facts, a folder's files and folders,
 * and one file's facts. They are blocks of the graph's own entity pages now — the separate repository, folder, file
 * and commit pages are gone — so every link they draw is the entity address the server put in the block, and the app
 * composes no id. The run page stays here as the one operational page of this file.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.js';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.js';
import { Badge } from '@/components/ui/badge.js';
import { Progress } from '@/components/ui/progress.js';
import { CodeLines, KLink, KMarkdown } from './blocks.js';
import { PageSkeleton } from './skeleton.js';
import { useRead } from './live.js';
import { useTabTitle } from './tabs.js';
import { getRun } from './api.js';
import { addressOfDocument, WIKI_RUN } from './routes.js';
import type { FileBlockData, FilePageBlock, FillRunView, FolderBlockData, FolderFileData, RepositoryBlockData, Resolution } from './types.js';
import { RunAgentUsage } from './usage.js';

/** A number of bytes as a reader reads it. */
export function bytesText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A span of milliseconds as a reader reads it. */
export function msText(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`;
}

/** Resident memory as a reader reads it: the peak a step reached, in megabytes. */
export function mbText(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The offset a git date carries as `Z` or `+HH:MM`, in minutes east of UTC; null where it carries none. */
function offsetIn(date: string): number | null {
  const match = /(Z|[+-]\d{2}:\d{2})$/u.exec(date);
  if (match === null) return null;
  if (match[1] === 'Z') return 0;
  const sign = match[1]!.startsWith('-') ? -1 : 1;
  return sign * (Number(match[1]!.slice(1, 3)) * 60 + Number(match[1]!.slice(4, 6)));
}

/** The part of a git date before its offset: the clock it stood at. */
function clockIn(date: string): string {
  return date.replace(/(Z|[+-]\d{2}:\d{2})$/u, '').replace('T', ' ');
}

/**
 * One git date as its own offset reads it: `2026-11-07 19:14:32 +03:00`. The record states a git date as `%aI`
 * states it — the author's clock and the offset that clock stood at — so the two are written side by side and the
 * clock is never converted.
 */
export function instantText(date: string, offsetMin: number | null): string {
  const effective = offsetIn(date) ?? offsetMin;
  const base = clockIn(date);
  if (effective === null) return `${base} UTC`;
  const sign = effective < 0 ? '-' : '+';
  const total = Math.abs(effective);
  return `${base} ${sign}${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** One table of files: their name, language, lines and bytes. A file's row opens the graph entity page. */
export function FolderFileTable({ files }: { files: readonly FolderFileData[] }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <Stack className="table-wrap">
    <Table className="w-full border-collapse text-small" data-testid="file-rows">
      <TableHeader>
        <TableRow className="border-b border-line text-left text-muted">
          <TableHead className="py-1 font-normal">{t('knowledge.repository.name')}</TableHead>
          <TableHead className="py-1 font-normal">{t('knowledge.repository.language')}</TableHead>
          <TableHead className="py-1 text-right font-normal">{t('knowledge.repository.lines')}</TableHead>
          <TableHead className="py-1 text-right font-normal">{t('knowledge.repository.bytes')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {files.map((file) => (
          <TableRow key={file.path} className="border-b border-line align-top last:border-b-0" data-testid="file-row" data-path={file.path}>
            <TableCell className="py-1 pr-3">
              <KLink href={file.href} testId="file-link">{file.path.slice(file.path.lastIndexOf('/') + 1)}</KLink>
              {file.form === 'binary' && <Badge variant="outline" className="ml-2">{t('knowledge.repository.binary')}</Badge>}
            </TableCell>
            <TableCell className="py-1 pr-3 text-muted" data-testid="file-language" title={file.candidates.join(', ')}>{file.language === 'ambiguous' ? file.candidates.join(' / ') : file.language}</TableCell>
            <TableCell className="py-1 text-right text-muted">{file.lines === null ? '—' : String(file.lines)}</TableCell>
            <TableCell className="py-1 text-right text-muted">{bytesText(file.bytes ?? 0)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
    </Stack>
  );
}

/** The as-is commit a block is true at, and the repository it belongs to. */
function AsIsLine({ repository, commit, href }: { repository: string; commit: string | null; href: string | null }): React.ReactElement | null {
  const { t } = useTranslation();
  if (commit === null) return null;
  return (
    <Paragraph className="mb-4 mt-0 text-small text-muted" data-testid="as-is-commit">
      {t('knowledge.repository.asIs', { repository })} {href === null ? <InlineCode>{commit.slice(0, 12)}</InlineCode> : <KLink href={href} testId="as-is-link"><InlineCode>{commit.slice(0, 12)}</InlineCode></KLink>}
    </Paragraph>
  );
}

/** The repository's facts as a block of its entity page: its URL, counts, as-is commit, gaps and what the graph holds. */
export function RepositoryFactsBlock({ data, run, unread }: { data: RepositoryBlockData; run?: { finishedAt?: string; wallMs: number }; unread?: { repository: string; path: string; reason: string }[] }): React.ReactElement {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? 'en';
  const finished = run?.finishedAt === undefined ? undefined : new Date(run.finishedAt).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'medium' });
  return (
    <PageSection data-testid="repository-block" data-repository={data.name}>
      <Paragraph className="mb-1 break-all text-small text-muted" data-testid="repository-url">{data.url}</Paragraph>
      <Paragraph className="mb-1 text-small text-muted" data-testid="repository-facts">
        {t('knowledge.repository.branch', { branch: data.defaultBranch ?? 'HEAD' })} ·{' '}
        {t('knowledge.repository.counts', { files: data.counts.files, commits: data.counts.commits, folders: data.counts.folders })}
      </Paragraph>
      <Paragraph className="mb-0 text-small text-muted" data-testid="repository-filled">
        {data.steps.tree ? t('knowledge.repository.treeRan') : t('knowledge.repository.treeNotRun')}
        {' · '}
        {data.steps.history ? t('knowledge.repository.historyRan') : t('knowledge.repository.historyNotRun')}
        {finished === undefined ? '' : ` · ${t('knowledge.repository.filledAt', { when: finished, wall: msText(run!.wallMs) })}`}
      </Paragraph>
      <Paragraph className="mt-2 mb-0 text-small"><KLink href={WIKI_RUN} testId="repository-run-link">{t('knowledge.repository.runPage')}</KLink></Paragraph>
      <AsIsLine repository={data.name} commit={data.asIsCommit} href={data.asIsHref} />
      {(unread ?? []).length > 0 && (
        <Alert className="mb-6" data-testid="repository-unread">
          <AlertTitle>{t('knowledge.repository.unreadTitle')}</AlertTitle>
          <AlertDescription>
            <PlainList className="mb-0 mt-1">
              {(unread ?? []).map((one) => (
                <ListItem key={`${one.repository}\u0000${one.path}`} data-testid="repository-unread-row"><InlineCode className="break-all">{one.repository}</InlineCode> (<InlineCode className="break-all">{one.path}</InlineCode>) — {one.reason}</ListItem>
              ))}
            </PlainList>
          </AlertDescription>
        </Alert>
      )}
      {data.historyShallow === true && (
        <Alert className="mb-6" data-testid="repository-shallow">
          <AlertTitle>{t('knowledge.repository.shallowTitle')}</AlertTitle>
          <AlertDescription>{t('knowledge.repository.shallowHistory')}</AlertDescription>
        </Alert>
      )}
      {!data.steps.tree && <Paragraph className="text-muted" data-testid="repository-empty">{t('knowledge.repository.notRun')}</Paragraph>}
    </PageSection>
  );
}

/** One folder's subfolders and one page of its files, each row opening the graph entity page. */
export function FolderBlock({ data }: { data: FolderBlockData }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <PageSection data-testid="folder-block" data-path={data.folder}>
      {data.parent !== null && <Paragraph className="mb-4 mt-0 text-small"><KLink href={data.parent.href} testId="folder-parent">{t('knowledge.repository.up')}</KLink></Paragraph>}
      {data.folders.length > 0 && (
        <>
          <SectionTitle className="mb-2 mt-0">{t('knowledge.repository.folders')}</SectionTitle>
          <PlainList className="m-0 mb-6 list-none p-0" data-testid="folder-children">
            {data.folders.map((child) => (
              <ListItem key={child.path} className="border-b border-line py-1.5 last:border-b-0" data-testid="folder-row">
                <KLink href={child.href} testId="folder-link"><InlineCode>{child.path.slice(child.path.lastIndexOf('/') + 1)}/</InlineCode></KLink>
              </ListItem>
            ))}
          </PlainList>
        </>
      )}
      {data.files.length === 0 && data.folders.length === 0 && <Paragraph className="text-muted" data-testid="folder-empty">{t('knowledge.repository.emptyFolder')}</Paragraph>}
      {data.files.length > 0 && (
        <>
          <SectionTitle className="mb-2 mt-0">{t('knowledge.repository.files')}</SectionTitle>
          <FolderFileTable files={data.files} />
        </>
      )}
      {data.nextHref !== null && <Paragraph className="mt-2 text-small"><KLink href={data.nextHref} testId="folder-more">{t('knowledge.repository.more')}</KLink></Paragraph>}
    </PageSection>
  );
}

/** One file's facts as a block: every fact the graph holds of it, its dates and its authors. */
/** The file page's tabs and the reader's last choice, kept in the browser (madarch-j9ao.2.1). */
type FileFace = 'overview' | 'history' | 'cochange';
type FileView = 'rendered' | 'source';
const storage = (key: string): string | null => { try { return window.localStorage.getItem(key); } catch { return null; } };
const keep = (key: string, value: string): void => { try { window.localStorage.setItem(key, value); } catch { /* a private context keeps no choice */ } };

/** The file page: the reference header, Overview with a Rendered/Source switch, History and Co-change. */
export function FilePageView({ block, resolutions }: { block: FilePageBlock; resolutions: Record<string, Resolution> }): React.ReactElement {
  const { t } = useTranslation();
  const [face, setFace] = useState<FileFace>(() => { const held = storage('madarch-file-face'); return held === 'history' || held === 'cochange' ? held : 'overview'; });
  const [view, setView] = useState<FileView>(() => storage('madarch-file-view') === 'source' ? 'source' : 'rendered');
  const [wrap, setWrap] = useState<boolean>(() => storage('madarch-file-wrap') === 'true');
  useEffect(() => { keep('madarch-file-face', face); }, [face]);
  useEffect(() => { keep('madarch-file-view', view); }, [view]);
  useEffect(() => { keep('madarch-file-wrap', String(wrap)); }, [wrap]);
  const data = block.data;
  const created = data.created === null ? '—' : <><KLink href={data.created.href}><InlineCode>{data.created.commit.slice(0, 7)}</InlineCode></KLink> <time dateTime={data.created.date}>{instantText(data.created.date, data.created.offsetMin)}</time> · {data.created.author || t('knowledge.repository.unknownAuthor')}</>;
  const modified = data.modified === null ? '—' : <><KLink href={data.modified.href}><InlineCode>{data.modified.commit.slice(0, 7)}</InlineCode></KLink> <time dateTime={data.modified.date}>{instantText(data.modified.date, data.modified.offsetMin)}</time> · {data.modified.author || t('knowledge.repository.unknownAuthor')}</>;
  const tabs: { face: FileFace; label: string }[] = [
    { face: 'overview', label: t('knowledge.filePage.overview') },
    { face: 'history', label: t('knowledge.filePage.history') },
    { face: 'cochange', label: t('knowledge.filePage.cochange') },
  ];
  const sourcePanel = block.source === undefined ? <Paragraph className="text-small text-muted" data-testid="file-no-text">{t('knowledge.filePage.noSource')}</Paragraph> : (
    <>
      <Stack className="mb-2 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="default" data-testid="file-wrap" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>{t('knowledge.filePage.softWrap')}</Button>
      </Stack>
      <Stack className="file-source overflow-x-auto" data-testid="file-source">
        <CodeLines text={block.source.text} language={block.source.language} firstLine={1} wrap={wrap} />
      </Stack>
    </>
  );
  const markdown = block.source !== undefined && block.markdown;
  return (
    <PageArticle data-testid="file-page" className="file-page"><Tabs value={face} onValueChange={(value) => setFace(value as typeof face)}>
      <PageHeader className="mb-6"><Stack layout="reading">
        <DefinitionList columns data-testid="file-facts-header">
          <DefinitionTerm className="text-muted">{t('knowledge.repository.language')}</DefinitionTerm><DefinitionValue className="m-0" data-testid="file-header-language">{data.language ?? (/\.(md|markdown)$/iu.test(data.path) ? 'markdown' : data.candidates[0]) ?? '—'}</DefinitionValue>
          <DefinitionTerm className="text-muted">{t('knowledge.repository.lines')}</DefinitionTerm><DefinitionValue className="m-0" data-testid="file-header-lines">{data.lines ?? '—'}</DefinitionValue>
          <DefinitionTerm className="text-muted">{t('knowledge.repository.bytes')}</DefinitionTerm><DefinitionValue className="m-0" data-testid="file-header-size">{data.bytes === null ? '—' : bytesText(data.bytes)}</DefinitionValue>
          <DefinitionTerm className="text-muted">{t('knowledge.repository.created')}</DefinitionTerm><DefinitionValue className="m-0" data-testid="file-header-created">{created}</DefinitionValue>
          <DefinitionTerm className="text-muted">{t('knowledge.repository.modified')}</DefinitionTerm><DefinitionValue className="m-0" data-testid="file-header-modified">{modified}</DefinitionValue>
          <DefinitionTerm className="text-muted">{t('knowledge.repository.authors')}</DefinitionTerm><DefinitionValue className="m-0" data-testid="file-header-authors">{data.authors.length === 0 ? '—' : data.authors.join(', ')}</DefinitionValue>
        </DefinitionList></Stack>
      </PageHeader>
      <TabsList aria-label={t('knowledge.filePage.overview')} className="mb-4 flex h-auto flex-wrap gap-2" data-testid="file-tabs">
        {tabs.map((tab) => (
          <TabsTrigger key={tab.face} value={tab.face} onClick={() => setFace(tab.face)} data-on={face === tab.face} data-testid={`file-tab-${tab.face}`}>{tab.label}</TabsTrigger>
        ))}
      </TabsList>
      {face === 'overview' && (
        <TabsContent value="overview"><PageSection data-testid="file-overview">
          {markdown && (
            <Stack layout="reading" className="mb-3 flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="default" data-testid="file-view-rendered" aria-pressed={view === 'rendered'} onClick={() => setView('rendered')}>{t('knowledge.filePage.rendered')}</Button>
              <Button type="button" size="sm" variant="default" data-testid="file-view-source" aria-pressed={view === 'source'} onClick={() => setView('source')}>{t('knowledge.filePage.source')}</Button>
              <KLink href={addressOfDocument(data.repository, data.path)} testId="file-sources-page">{t('knowledge.filePage.sourcesPage')}</KLink>
            </Stack>
          )}
          {markdown && view === 'rendered' && block.source !== undefined
            ? <Stack layout="reading"><KMarkdown text={block.source.text} resolutions={resolutions} /></Stack>
            : sourcePanel}
        </PageSection></TabsContent>
      )}
      {face === 'history' && (
        <TabsContent value="history"><PageSection data-testid="file-history"><Stack layout="reading">
          {block.history.length === 0 ? <Paragraph className="text-small text-muted" data-testid="file-history-empty">{t('knowledge.filePage.noHistory')}</Paragraph> : (
            <Stack className="table-wrap">
              <Table className="w-full border-collapse text-small">
                <TableHeader><TableRow className="border-b border-line text-left text-muted"><TableHead className="py-1 font-normal">{t('knowledge.historyColWhen')}</TableHead><TableHead className="py-1 font-normal">{t('knowledge.historyColWho')}</TableHead><TableHead className="py-1 font-normal">{t('knowledge.historyColWhat')}</TableHead><TableHead className="py-1 font-normal">{t('knowledge.historyColFigures')}</TableHead></TableRow></TableHeader>
                <TableBody>
                  {block.history.map((row) => (
                    <TableRow key={`${row.hash}-${row.when}`} className="border-b border-line align-top last:border-b-0" data-testid="file-history-row" data-commit={row.hash}>
                      <TableCell className="whitespace-nowrap py-1 pr-3">{row.when || '—'}</TableCell>
                      <TableCell className="py-1 pr-3">{row.who ?? '—'}</TableCell>
                      <TableCell className="py-1 pr-3 break-words">{row.href === null ? row.subject : <KLink href={row.href}>{row.subject}</KLink>}</TableCell>
                      <TableCell className="whitespace-nowrap py-1">{row.added === null ? '' : t('knowledge.historyAdded', { count: row.added })} {row.removed === null ? '' : t('knowledge.historyRemoved', { count: row.removed })}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Stack>
          )}
        </Stack></PageSection></TabsContent>
      )}
      {face === 'cochange' && (
        <TabsContent value="cochange"><PageSection data-testid="file-cochange"><Stack layout="reading">
          {block.cochangeTotal > block.cochange.length && <Paragraph className="text-small text-muted">{t('knowledge.filePage.cochangeShown', { shown: block.cochange.length, total: block.cochangeTotal })}</Paragraph>}
          {block.cochange.length === 0 ? <Paragraph className="text-small text-muted" data-testid="file-cochange-empty">{t('knowledge.filePage.noCochange')}</Paragraph> : (
            <PlainList className="m-0 list-none p-0" data-testid="file-cochange-list">
              {block.cochange.map((row) => (
                <ListItem key={row.path} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line py-1.5 last:border-b-0" data-testid="file-cochange-row" data-path={row.path}>
                  <Text className="min-w-0 break-all">{row.href === null ? row.path : <KLink href={row.href}>{row.path}</KLink>}</Text>
                  <Text className="text-small text-muted">{t('knowledge.filePage.share', { both: row.both, total: block.commits, share: Math.round(row.share * 100) })}</Text>
                </ListItem>
              ))}
            </PlainList>
          )}
        </Stack></PageSection></TabsContent>
      )}
    </Tabs></PageArticle>
  );
}

export function FileFactsBlock({ data }: { data: FileBlockData }): React.ReactElement {
  const { t } = useTranslation();
  const facts: [string, React.ReactNode][] = [
    [t('knowledge.repository.mode'), <InlineCode key="mode">{data.mode}</InlineCode>],
    [t('knowledge.repository.blob'), <InlineCode key="blob" className="break-all">{data.blob}</InlineCode>],
    [t('knowledge.repository.bytes'), <Text key="bytes">{data.bytes} ({bytesText(data.bytes ?? 0)})</Text>],
    [t('knowledge.repository.lines'), <Text key="lines">{data.lines === null ? '—' : String(data.lines)}</Text>],
    [t('knowledge.repository.form'), <Text key="form">{data.form === 'binary' ? t('knowledge.repository.binary') : t('knowledge.repository.text')}</Text>],
    [t('knowledge.repository.language'), <Text key="language" data-testid="file-languages">{data.language}{data.candidates.length > 1 || data.candidates[0] !== data.language ? ` (${data.candidates.join(', ')})` : ''}</Text>],
    [t('knowledge.repository.created'), data.created === null ? <Text key="created">—</Text> : <Text key="created"><KLink href={data.created.href}><InlineCode>{data.created.commit.slice(0, 12)}</InlineCode></KLink> <time dateTime={data.created.date}>{instantText(data.created.date, data.created.offsetMin)}</time> · {data.created.author || t('knowledge.repository.unknownAuthor')}</Text>],
    [t('knowledge.repository.modified'), data.modified === null ? <Text key="modified">—</Text> : <Text key="modified"><KLink href={data.modified.href}><InlineCode>{data.modified.commit.slice(0, 12)}</InlineCode></KLink> <time dateTime={data.modified.date}>{instantText(data.modified.date, data.modified.offsetMin)}</time> · {data.modified.author || t('knowledge.repository.unknownAuthor')}</Text>],
    [t('knowledge.repository.commitCount'), <Text key="count">{data.commitCount}</Text>],
    [t('knowledge.repository.authors'), <Text key="authors" data-testid="file-authors">{data.authors.length === 0 ? '—' : data.authors.join(', ')}</Text>],
  ];
  return (
    <PageSection data-testid="file-block" data-path={data.path}>
      <Stack className="table-wrap mb-8">
      <Table className="w-full border-collapse text-small" data-testid="file-facts">
        <TableBody>
          {facts.map(([name, value]) => (
            <TableRow key={name} className="border-b border-line last:border-b-0">
              <TableHead scope="row" className="w-40 py-1 pr-3 text-left font-normal text-muted">{name}</TableHead>
              <TableCell className="py-1 break-all">{value}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      </Stack>
    </PageSection>
  );
}

/** The run page: the newest trace, step by step — its wall clock, its peak memory and its slowest names. */
export function RunPage({ run: named, version }: { run: string | null; version: number }): React.ReactElement {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? 'en';
  useTabTitle(t('knowledge.run.title'));
  const { data, error } = useRead<{ run: FillRunView }>(`run:${named ?? ''}`, version, (signal) => getRun(named, signal));
  if (data === null && error === null) return <PageSkeleton testId="run-loading" rows />;
  if (data === null) {
    return (
      <Alert variant="problem" data-testid="run-error">
        <AlertTitle>{t('knowledge.repository.noPage', { what: named ?? t('knowledge.run.title') })}</AlertTitle>
        <AlertDescription><Paragraph className="mb-0">{error ?? ''}</Paragraph></AlertDescription>
      </Alert>
    );
  }
  const run = data.run;
  return (
    <PageSection data-testid="run-page" data-run={run.runId}>
      <PageHeader className="mb-6">
        <PageTitle className="break-all">{t('knowledge.run.title')}</PageTitle>
        <Paragraph className="mb-1 break-all text-small text-muted" data-testid="run-id"><InlineCode>{run.runId}</InlineCode></Paragraph>
        <Paragraph className="mb-0 text-small text-muted" data-testid="run-totals">
          {t('knowledge.run.totals', {
            wall: msText(run.wallMs),
            spans: run.spans,
            from: new Date(run.startedAt).toLocaleString(language, { timeStyle: 'medium' }),
            to: run.finishedAt === undefined ? t(`knowledge.fillPage.runStates.${run.state}`) : new Date(run.finishedAt).toLocaleString(language, { timeStyle: 'medium' }),
          })}
        </Paragraph>
      </PageHeader>
      <SectionTitle className="mb-2 mt-0">{t('knowledge.run.steps')}</SectionTitle>
      <Stack className="table-wrap mb-8">
      <Table className="w-full border-collapse text-small" data-testid="run-steps">
        <TableHeader>
          <TableRow className="border-b border-line text-left text-muted">
            <TableHead className="py-1 font-normal">{t('knowledge.run.step')}</TableHead>
            <TableHead className="py-1 text-right font-normal">{t('knowledge.run.wall')}</TableHead>
            <TableHead className="py-1 text-right font-normal">{t('knowledge.run.memory')}</TableHead>
            <TableHead className="py-1 font-normal">{t('knowledge.run.slowest')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {run.steps.map((step) => (
            <TableRow key={step.step} className="border-b border-line align-top last:border-b-0" data-testid="run-step" data-step={step.step}>
              <TableCell className="py-1 pr-3"><InlineCode>{step.step}</InlineCode></TableCell>
              <TableCell className="py-1 text-right whitespace-nowrap">{msText(step.wallMs)}</TableCell>
              <TableCell className="py-1 text-right whitespace-nowrap">{mbText(step.peakRssBytes)}</TableCell>
              <TableCell className="py-1">
                <OrderedList className="m-0 list-none p-0" data-testid="run-step-names">
                  {step.slowest.map((name) => <ListItem key={name.name}><InlineCode>{name.name}</InlineCode> <Text className="text-muted">{msText(name.selfMs)} ×{name.count}</Text></ListItem>)}
                </OrderedList>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      </Stack>
      <RunAgentUsage usage={run.agentUsage} />
      <SectionTitle className="mb-2 mt-0">{t('knowledge.run.names')}</SectionTitle>
      <OrderedList className="m-0 list-none p-0 text-small" data-testid="run-names">
        {run.slowest.map((name) => (
          <ListItem key={name.name} className="border-b border-line py-1 last:border-b-0">
            <InlineCode>{name.name}</InlineCode> <Text className="text-muted">{msText(name.selfMs)} ×{name.count}</Text>
            <Progress className="mt-1 h-1" value={run.wallMs === 0 ? 0 : Math.min(100, Math.round((name.selfMs / run.wallMs) * 100))} aria-label={name.name} />
          </ListItem>
        ))}
      </OrderedList>
      <Paragraph className="mt-4 text-small text-muted" data-testid="run-note">{t('knowledge.run.note')}</Paragraph>
      <Paragraph className="mb-0 mt-1 text-small text-muted" data-testid="run-memory-note">{t('knowledge.run.memoryNote')}</Paragraph>
    </PageSection>
  );
}
