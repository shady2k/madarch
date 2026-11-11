/**
 * The repository's entity-page blocks (madarch-hsqs stage A): a repository's facts, a folder's files and folders,
 * and one file's facts. They are blocks of the graph's own entity pages now — the separate repository, folder, file
 * and commit pages are gone — so every link they draw is the entity address the server put in the block, and the app
 * composes no id. The run page stays here as the one operational page of this file.
 */
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.js';
import { Badge } from '@/components/ui/badge.js';
import { KLink } from './blocks.js';
import { PageSkeleton } from './skeleton.js';
import { useRead } from './live.js';
import { useTabTitle } from './tabs.js';
import { getRun } from './api.js';
import { WIKI_RUN } from './routes.js';
import type { FileBlockData, FillRunView, FolderBlockData, FolderFileData, RepositoryBlockData } from './types.js';
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
    <div className="table-wrap">
    <table className="w-full border-collapse text-small" data-testid="file-rows">
      <thead>
        <tr className="border-b border-line text-left text-muted">
          <th className="py-1 font-normal">{t('knowledge.repository.name')}</th>
          <th className="py-1 font-normal">{t('knowledge.repository.language')}</th>
          <th className="py-1 text-right font-normal">{t('knowledge.repository.lines')}</th>
          <th className="py-1 text-right font-normal">{t('knowledge.repository.bytes')}</th>
        </tr>
      </thead>
      <tbody>
        {files.map((file) => (
          <tr key={file.path} className="border-b border-line align-top last:border-b-0" data-testid="file-row" data-path={file.path}>
            <td className="py-1 pr-3">
              <KLink href={file.href} testId="file-link">{file.path.slice(file.path.lastIndexOf('/') + 1)}</KLink>
              {file.form === 'binary' && <Badge variant="outline" className="ml-2">{t('knowledge.repository.binary')}</Badge>}
            </td>
            <td className="py-1 pr-3 text-muted" data-testid="file-language" title={file.candidates.join(', ')}>{file.language === 'ambiguous' ? file.candidates.join(' / ') : file.language}</td>
            <td className="py-1 text-right text-muted">{file.lines === null ? '—' : String(file.lines)}</td>
            <td className="py-1 text-right text-muted">{bytesText(file.bytes ?? 0)}</td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

/** The as-is commit a block is true at, and the repository it belongs to. */
function AsIsLine({ repository, commit, href }: { repository: string; commit: string | null; href: string | null }): React.ReactElement | null {
  const { t } = useTranslation();
  if (commit === null) return null;
  return (
    <p className="mb-4 mt-0 text-small text-muted" data-testid="as-is-commit">
      {t('knowledge.repository.asIs', { repository })} {href === null ? <code>{commit.slice(0, 12)}</code> : <KLink href={href} testId="as-is-link"><code>{commit.slice(0, 12)}</code></KLink>}
    </p>
  );
}

/** The repository's facts as a block of its entity page: its URL, counts, as-is commit, gaps and what the graph holds. */
export function RepositoryFactsBlock({ data, run, unread }: { data: RepositoryBlockData; run?: { finishedAt: string; wallMs: number }; unread?: { repository: string; path: string; reason: string }[] }): React.ReactElement {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? 'en';
  const finished = run === undefined ? undefined : new Date(run.finishedAt).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'medium' });
  return (
    <section data-testid="repository-block" data-repository={data.name}>
      <p className="mb-1 break-all text-small text-muted" data-testid="repository-url">{data.url}</p>
      <p className="mb-1 text-small text-muted" data-testid="repository-facts">
        {t('knowledge.repository.branch', { branch: data.defaultBranch ?? 'HEAD' })} ·{' '}
        {t('knowledge.repository.counts', { files: data.counts.files, commits: data.counts.commits, folders: data.counts.folders })}
      </p>
      <p className="mb-0 text-small text-muted" data-testid="repository-filled">
        {data.steps.tree ? t('knowledge.repository.treeRan') : t('knowledge.repository.treeNotRun')}
        {' · '}
        {data.steps.history ? t('knowledge.repository.historyRan') : t('knowledge.repository.historyNotRun')}
        {finished === undefined ? '' : ` · ${t('knowledge.repository.filledAt', { when: finished, wall: msText(run!.wallMs) })}`}
      </p>
      <p className="mt-2 mb-0 text-small"><KLink href={WIKI_RUN} testId="repository-run-link">{t('knowledge.repository.runPage')}</KLink></p>
      <AsIsLine repository={data.name} commit={data.asIsCommit} href={data.asIsHref} />
      {(unread ?? []).length > 0 && (
        <Alert className="mb-6" data-testid="repository-unread">
          <AlertTitle>{t('knowledge.repository.unreadTitle')}</AlertTitle>
          <AlertDescription>
            <ul className="mb-0 mt-1">
              {(unread ?? []).map((one) => (
                <li key={`${one.repository}\u0000${one.path}`} data-testid="repository-unread-row"><code className="break-all">{one.repository}</code> (<code className="break-all">{one.path}</code>) — {one.reason}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {data.gaps.length > 0 && (
        <Alert className="mb-6" data-testid="repository-gaps">
          <AlertTitle>{t('knowledge.repository.gapsTitle')}</AlertTitle>
          <AlertDescription>
            <ul className="mb-0 mt-1">
              {data.gaps.map((gap) => <li key={`${gap.what}\u0000${gap.reason}`} data-testid="repository-gap"><code className="break-all">{gap.what}</code> — {gap.reason}</li>)}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {!data.steps.tree && <p className="text-muted" data-testid="repository-empty">{t('knowledge.repository.notRun')}</p>}
    </section>
  );
}

/** One folder's subfolders and one page of its files, each row opening the graph entity page. */
export function FolderBlock({ data }: { data: FolderBlockData }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <section data-testid="folder-block" data-path={data.folder}>
      {data.parent !== null && <p className="mb-4 mt-0 text-small"><KLink href={data.parent.href} testId="folder-parent">{t('knowledge.repository.up')}</KLink></p>}
      {data.folders.length > 0 && (
        <>
          <h2 className="mb-2 mt-0">{t('knowledge.repository.folders')}</h2>
          <ul className="m-0 mb-6 list-none p-0" data-testid="folder-children">
            {data.folders.map((child) => (
              <li key={child.path} className="border-b border-line py-1.5 last:border-b-0" data-testid="folder-row">
                <KLink href={child.href} testId="folder-link"><code>{child.path.slice(child.path.lastIndexOf('/') + 1)}/</code></KLink>
              </li>
            ))}
          </ul>
        </>
      )}
      {data.files.length === 0 && data.folders.length === 0 && <p className="text-muted" data-testid="folder-empty">{t('knowledge.repository.emptyFolder')}</p>}
      {data.files.length > 0 && (
        <>
          <h2 className="mb-2 mt-0">{t('knowledge.repository.files')}</h2>
          <FolderFileTable files={data.files} />
        </>
      )}
      {data.nextHref !== null && <p className="mt-2 text-small"><KLink href={data.nextHref} testId="folder-more">{t('knowledge.repository.more')}</KLink></p>}
    </section>
  );
}

/** One file's facts as a block: every fact the graph holds of it, its dates and its authors. */
export function FileFactsBlock({ data }: { data: FileBlockData }): React.ReactElement {
  const { t } = useTranslation();
  const facts: [string, React.ReactNode][] = [
    [t('knowledge.repository.mode'), <code key="mode">{data.mode}</code>],
    [t('knowledge.repository.blob'), <code key="blob" className="break-all">{data.blob}</code>],
    [t('knowledge.repository.bytes'), <span key="bytes">{data.bytes} ({bytesText(data.bytes ?? 0)})</span>],
    [t('knowledge.repository.lines'), <span key="lines">{data.lines === null ? '—' : String(data.lines)}</span>],
    [t('knowledge.repository.form'), <span key="form">{data.form === 'binary' ? t('knowledge.repository.binary') : t('knowledge.repository.text')}</span>],
    [t('knowledge.repository.language'), <span key="language" data-testid="file-languages">{data.language}{data.candidates.length > 1 || data.candidates[0] !== data.language ? ` (${data.candidates.join(', ')})` : ''}</span>],
    [t('knowledge.repository.created'), data.created === null ? <span key="created">—</span> : <span key="created"><KLink href={data.created.href}><code>{data.created.commit.slice(0, 12)}</code></KLink> <time dateTime={data.created.date}>{instantText(data.created.date, data.created.offsetMin)}</time> · {data.created.author || t('knowledge.repository.unknownAuthor')}</span>],
    [t('knowledge.repository.modified'), data.modified === null ? <span key="modified">—</span> : <span key="modified"><KLink href={data.modified.href}><code>{data.modified.commit.slice(0, 12)}</code></KLink> <time dateTime={data.modified.date}>{instantText(data.modified.date, data.modified.offsetMin)}</time> · {data.modified.author || t('knowledge.repository.unknownAuthor')}</span>],
    [t('knowledge.repository.commitCount'), <span key="count">{data.commitCount}</span>],
    [t('knowledge.repository.authors'), <span key="authors" data-testid="file-authors">{data.authors.length === 0 ? '—' : data.authors.join(', ')}</span>],
  ];
  return (
    <section data-testid="file-block" data-path={data.path}>
      <div className="table-wrap mb-8">
      <table className="w-full border-collapse text-small" data-testid="file-facts">
        <tbody>
          {facts.map(([name, value]) => (
            <tr key={name} className="border-b border-line last:border-b-0">
              <th scope="row" className="w-40 py-1 pr-3 text-left font-normal text-muted">{name}</th>
              <td className="py-1 break-all">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </section>
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
        <AlertDescription><p className="mb-0">{error ?? ''}</p></AlertDescription>
      </Alert>
    );
  }
  const run = data.run;
  return (
    <section data-testid="run-page" data-run={run.runId}>
      <header className="mb-6">
        <h1 className="break-all">{t('knowledge.run.title')}</h1>
        <p className="mb-1 break-all text-small text-muted" data-testid="run-id"><code>{run.runId}</code></p>
        <p className="mb-0 text-small text-muted" data-testid="run-totals">
          {t('knowledge.run.totals', {
            wall: msText(run.wallMs),
            spans: run.spans,
            from: new Date(run.startedAt).toLocaleString(language, { timeStyle: 'medium' }),
            to: new Date(run.finishedAt).toLocaleString(language, { timeStyle: 'medium' }),
          })}
        </p>
      </header>
      <h2 className="mb-2 mt-0">{t('knowledge.run.steps')}</h2>
      <div className="table-wrap mb-8">
      <table className="w-full border-collapse text-small" data-testid="run-steps">
        <thead>
          <tr className="border-b border-line text-left text-muted">
            <th className="py-1 font-normal">{t('knowledge.run.step')}</th>
            <th className="py-1 text-right font-normal">{t('knowledge.run.wall')}</th>
            <th className="py-1 text-right font-normal">{t('knowledge.run.memory')}</th>
            <th className="py-1 font-normal">{t('knowledge.run.slowest')}</th>
          </tr>
        </thead>
        <tbody>
          {run.steps.map((step) => (
            <tr key={step.step} className="border-b border-line align-top last:border-b-0" data-testid="run-step" data-step={step.step}>
              <td className="py-1 pr-3"><code>{step.step}</code></td>
              <td className="py-1 text-right whitespace-nowrap">{msText(step.wallMs)}</td>
              <td className="py-1 text-right whitespace-nowrap">{mbText(step.peakRssBytes)}</td>
              <td className="py-1">
                <ol className="m-0 list-none p-0" data-testid="run-step-names">
                  {step.slowest.map((name) => <li key={name.name}><code>{name.name}</code> <span className="text-muted">{msText(name.selfMs)} ×{name.count}</span></li>)}
                </ol>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <RunAgentUsage usage={run.agentUsage} />
      <h2 className="mb-2 mt-0">{t('knowledge.run.names')}</h2>
      <ol className="m-0 list-none p-0 text-small" data-testid="run-names">
        {run.slowest.map((name) => (
          <li key={name.name} className="border-b border-line py-1 last:border-b-0">
            <code>{name.name}</code> <span className="text-muted">{msText(name.selfMs)} ×{name.count}</span>
            <div className="mt-1 h-1 rounded-full bg-[var(--surface-active)]"><div className="h-1 rounded-full bg-ink" style={{ width: `${run.wallMs === 0 ? 0 : Math.min(100, Math.round((name.selfMs / run.wallMs) * 100))}%` }} /></div>
          </li>
        ))}
      </ol>
      <p className="mt-4 text-small text-muted" data-testid="run-note">{t('knowledge.run.note')}</p>
      <p className="mb-0 mt-1 text-small text-muted" data-testid="run-memory-note">{t('knowledge.run.memoryNote')}</p>
    </section>
  );
}
