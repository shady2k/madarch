/**
 * The repository pages of this step (madarch-8bdc.2.5, items 2, 3 and 4): the
 * repository the fill read, its folder tree, one file with every fact of it,
 * one commit and the run's trace. Every page is drawn from the server's answer
 * — the wiki holds no fact of its own — and every page names the as-is commit
 * it is true at.
 *
 * A page whose step has not run is not drawn: the server answers the step's
 * name, and the page says so rather than showing an empty list.
 */
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.js';
import { Badge } from '@/components/ui/badge.js';
import { KLink } from './blocks.js';
import { PageSkeleton } from './skeleton.js';
import { useRead } from './live.js';
import { getCommit, getFile, getFolder, getRun } from './api.js';
import { addressOfCommit, addressOfFile, addressOfFolder, addressOfRun, K_RUN } from './routes.js';
import type { CommitPageModel, FilePageModel, FillRunView, FolderPageModel, PageFile, RepositoryFactsView, WikiStatus } from './types.js';

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
 * One git date as its own offset reads it: `2026-11-07 19:14:32 +03:00`.
 *
 * The record states a git date as `%aI` states it — the author's clock and the offset that clock
 * stood at — so the two are written side by side and the clock is never converted: converting it to
 * UTC and then appending the offset would say `16:14:32 +03:00`, a clock nobody wrote (review, item 1).
 * A date that carries no offset is shown as `UTC` where the record has none either.
 */
export function instantText(date: string, offsetMin: number | null): string {
  const effective = offsetIn(date) ?? offsetMin;
  const base = clockIn(date);
  if (effective === null) return `${base} UTC`;
  const sign = effective < 0 ? '-' : '+';
  const total = Math.abs(effective);
  return `${base} ${sign}${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** One path broken into the folder pages that lead to it, the repository first. */
function Breadcrumb({ path }: { path: string }): React.ReactElement {
  const segments = path === '' ? [] : path.split('/');
  const crumbs = segments.map((segment, index) => ({ segment, path: segments.slice(0, index + 1).join('/') }));
  return (
    <nav aria-label="breadcrumb" className="mb-4 flex flex-wrap items-center gap-1 text-small" data-testid="breadcrumb">
      <KLink href={addressOfFolder('')} testId="crumb-root">{segments.length === 0 ? '/' : 'repository'}</KLink>
      {crumbs.map((crumb, index) => (
        <span key={crumb.path} className="flex items-center gap-1">
          <span aria-hidden="true" className="text-muted">/</span>
          {index === crumbs.length - 1 && path !== '' && !crumb.path.includes('.') ? (
            <span className="break-all text-ink">{crumb.segment}</span>
          ) : (
            <KLink href={addressOfFolder(crumb.path)}>{crumb.segment}</KLink>
          )}
        </span>
      ))}
    </nav>
  );
}

/** One table of files: their name, language, lines and bytes. A file's row opens its page. */
export function FileRows({ files }: { files: readonly PageFile[] }): React.ReactElement {
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
              <KLink href={addressOfFile(file.path)} testId="file-link">{file.path.slice(file.path.lastIndexOf('/') + 1)}</KLink>
              {file.form === 'binary' && <Badge variant="outline" className="ml-2">{t('knowledge.repository.binary')}</Badge>}
            </td>
            <td className="py-1 pr-3 text-muted" data-testid="file-language" title={file.candidates.join(', ')}>{file.language === 'ambiguous' ? file.candidates.join(' / ') : file.language}</td>
            <td className="py-1 text-right text-muted">{file.lines === null ? '—' : String(file.lines)}</td>
            <td className="py-1 text-right text-muted">{bytesText(file.bytes)}</td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

/** One page the server refused, with the step it names. */
function Refusal({ what, message }: { what: string; message: string }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <Alert variant="problem" data-testid="repository-refused">
      <AlertTitle>{t('knowledge.repository.noPage', { what })}</AlertTitle>
      <AlertDescription><p className="mb-0">{message}</p></AlertDescription>
    </Alert>
  );
}

/** The as-is commit a page is true at, and the repository it belongs to. */
function AsIsLine({ repository, commit }: { repository: string; commit: string | null }): React.ReactElement | null {
  const { t } = useTranslation();
  if (commit === null) return null;
  return (
    <p className="mb-4 mt-0 text-small text-muted" data-testid="as-is-commit">
      {t('knowledge.repository.asIs', { repository })} <KLink href={addressOfCommit(commit)} testId="as-is-link"><code>{commit.slice(0, 12)}</code></KLink>
    </p>
  );
}

/** The repository's own page: its facts, its counts, its gaps and the root of its tree. */
export function RepositoryPage({ status, version }: { status: WikiStatus; version: number }): React.ReactElement {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? 'en';
  const repository = status.repository as RepositoryFactsView;
  const { data, error } = useRead<{ folder: FolderPageModel }>('repository-root', version, (signal) => getFolder('', null, signal));
  const run = status.fill.run;
  const finished = run === undefined ? undefined : new Date(run.finishedAt).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'medium' });
  return (
    <section data-testid="repository-page" data-repository={repository.name}>
      <header className="mb-6">
        <h1 className="break-all">{repository.name}</h1>
        <p className="mb-1 break-all text-small text-muted" data-testid="repository-url">{repository.url}</p>
        <p className="mb-1 text-small text-muted" data-testid="repository-facts">
          {t('knowledge.repository.branch', { branch: repository.defaultBranch ?? 'HEAD' })} ·{' '}
          {t('knowledge.repository.counts', { files: repository.counts.files, commits: repository.counts.commits, folders: repository.counts.folders })}
        </p>
        <p className="mb-0 text-small text-muted" data-testid="repository-filled">
          {repository.steps.tree ? t('knowledge.repository.treeRan') : t('knowledge.repository.treeNotRun')}
          {' · '}
          {repository.steps.history ? t('knowledge.repository.historyRan') : t('knowledge.repository.historyNotRun')}
          {finished === undefined ? '' : ` · ${t('knowledge.repository.filledAt', { when: finished, wall: msText(run!.wallMs) })}`}
        </p>
        <p className="mt-2 mb-0 text-small"><KLink href={K_RUN} testId="repository-run-link">{t('knowledge.repository.runPage')}</KLink></p>
      </header>
      <AsIsLine repository={repository.name} commit={repository.asIsCommit} />
      {(status.fill.unread ?? []).length > 0 && (
        <Alert className="mb-6" data-testid="repository-unread">
          <AlertTitle>{t('knowledge.repository.unreadTitle')}</AlertTitle>
          <AlertDescription>
            <ul className="mb-0 mt-1">
              {(status.fill.unread ?? []).map((one) => (
                <li key={one.repository} data-testid="repository-unread-row"><code className="break-all">{one.repository}</code> (<code className="break-all">{one.path}</code>) — {one.reason}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {repository.gaps.length > 0 && (
        <Alert className="mb-6" data-testid="repository-gaps">
          <AlertTitle>{t('knowledge.repository.gapsTitle')}</AlertTitle>
          <AlertDescription>
            <ul className="mb-0 mt-1">
              {repository.gaps.map((gap) => <li key={`${gap.what}\u0000${gap.reason}`} data-testid="repository-gap"><code className="break-all">{gap.what}</code> — {gap.reason}</li>)}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {!repository.steps.tree ? (
        <p className="text-muted" data-testid="repository-empty">{t('knowledge.repository.notRun')}</p>
      ) : data === null && error === null ? (
        <PageSkeleton testId="repository-loading" rows />
      ) : data === null ? (
        <Refusal what={repository.name} message={error ?? ''} />
      ) : (
        <>
          {data.folder.folders.length > 0 && (
            <>
              <h2 className="mb-2 mt-0">{t('knowledge.repository.folders')}</h2>
              <ul className="m-0 mb-6 list-none p-0" data-testid="repository-folders">
                {data.folder.folders.map((folder) => (
                  <li key={folder} className="border-b border-line py-1.5 last:border-b-0" data-testid="folder-row">
                    <KLink href={addressOfFolder(folder)} testId="folder-link"><code>{folder}/</code></KLink>
                  </li>
                ))}
              </ul>
            </>
          )}
          <h2 className="mb-2 mt-0">{t('knowledge.repository.files')}</h2>
          <FileRows files={data.folder.files} />
          {data.folder.next !== null && <p className="mt-2 text-small"><KLink href={addressOfFolder('', data.folder.next ?? undefined)}>{t('knowledge.repository.more')}</KLink></p>}
        </>
      )}
    </section>
  );
}

/** One folder: its subfolders, its own files and the page of the next files. */
export function FolderPage({ path, after, version }: { path: string; after: string | null; version: number }): React.ReactElement {
  const { t } = useTranslation();
  const { data, error } = useRead<{ folder: FolderPageModel }>(`folder:${path}:${after ?? ''}`, version, (signal) => getFolder(path, after, signal));
  if (data === null && error === null) return <PageSkeleton testId="folder-loading" rows />;
  if (data === null) return <Refusal what={path === '' ? 'the root folder' : path} message={error ?? ''} />;
  const folder = data.folder;
  return (
    <section data-testid="folder-page" data-path={folder.folder}>
      <Breadcrumb path={folder.folder} />
      <header className="mb-4">
        <h1 className="break-all">{folder.folder === '' ? '/' : folder.folder}</h1>
        <AsIsLine repository={folder.repository} commit={folder.asIsCommit} />
      </header>
      {folder.parent !== null && <p className="mb-4 mt-0 text-small"><KLink href={addressOfFolder(folder.parent)} testId="folder-parent">{t('knowledge.repository.up')}</KLink></p>}
      {folder.folders.length > 0 && (
        <>
          <h2 className="mb-2 mt-0">{t('knowledge.repository.folders')}</h2>
          <ul className="m-0 mb-6 list-none p-0" data-testid="folder-children">
            {folder.folders.map((child) => (
              <li key={child} className="border-b border-line py-1.5 last:border-b-0" data-testid="folder-row">
                <KLink href={addressOfFolder(child)} testId="folder-link"><code>{child.slice(child.lastIndexOf('/') + 1)}/</code></KLink>
              </li>
            ))}
          </ul>
        </>
      )}
      {folder.files.length === 0 && folder.folders.length === 0 && <p className="text-muted" data-testid="folder-empty">{t('knowledge.repository.emptyFolder')}</p>}
      {folder.files.length > 0 && (
        <>
          <h2 className="mb-2 mt-0">{t('knowledge.repository.files')}</h2>
          <FileRows files={folder.files} />
        </>
      )}
      {folder.next !== null && <p className="mt-2 text-small"><KLink href={addressOfFolder(folder.folder, folder.next ?? undefined)}>{t('knowledge.repository.more')}</KLink></p>}
    </section>
  );
}

/** One file: every fact the graph holds of it, and the commits that touched it. */
export function FilePage({ path, after, version }: { path: string; after: { walk: number; commit: string } | null; version: number }): React.ReactElement {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? 'en';
  const key = `file:${path}:${after === null ? '' : `${after.walk}:${after.commit}`}`;
  const { data, error } = useRead<{ file: FilePageModel }>(key, version, (signal) => getFile(path, after, signal));
  if (data === null && error === null) return <PageSkeleton testId="file-loading" rows />;
  if (data === null) return <Refusal what={path} message={error ?? ''} />;
  const model = data.file;
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const facts: [string, React.ReactNode][] = [
    [t('knowledge.repository.mode'), <code key="mode">{model.file.mode}</code>],
    [t('knowledge.repository.blob'), <code key="blob" className="break-all">{model.file.blob}</code>],
    [t('knowledge.repository.bytes'), <span key="bytes">{model.file.bytes} ({bytesText(model.file.bytes)})</span>],
    [t('knowledge.repository.lines'), <span key="lines">{model.file.lines === null ? '—' : String(model.file.lines)}</span>],
    [t('knowledge.repository.form'), <span key="form">{model.file.form === 'binary' ? t('knowledge.repository.binary') : t('knowledge.repository.text')}</span>],
    [t('knowledge.repository.language'), <span key="language" data-testid="file-languages">{model.file.language}{model.file.candidates.length > 1 || model.file.candidates[0] !== model.file.language ? ` (${model.file.candidates.join(', ')})` : ''}</span>],
    [t('knowledge.repository.created'), model.created === null ? <span key="created">—</span> : <span key="created"><KLink href={addressOfCommit(model.created.commit)}><code>{model.created.commit.slice(0, 12)}</code></KLink> <time dateTime={model.created.date}>{instantText(model.created.date, model.created.offsetMin)}</time> · {model.created.author || t('knowledge.repository.unknownAuthor')}</span>],
    [t('knowledge.repository.modified'), model.modified === null ? <span key="modified">—</span> : <span key="modified"><KLink href={addressOfCommit(model.modified.commit)}><code>{model.modified.commit.slice(0, 12)}</code></KLink> <time dateTime={model.modified.date}>{instantText(model.modified.date, model.modified.offsetMin)}</time> · {model.modified.author || t('knowledge.repository.unknownAuthor')}</span>],
    [t('knowledge.repository.commitCount'), <span key="count">{model.commitCount}</span>],
    [t('knowledge.repository.authors'), <span key="authors" data-testid="file-authors">{model.authors.length === 0 ? '—' : model.authors.join(', ')}</span>],
  ];
  return (
    <section data-testid="file-page" data-path={path}>
      <Breadcrumb path={folder} />
      <header className="mb-4">
        <h1 className="break-all">{path}</h1>
        <AsIsLine repository={model.repository} commit={model.asIsCommit} />
      </header>
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
      <h2 className="mb-2 mt-0">{t('knowledge.repository.history')}</h2>
      {model.history.length === 0 ? (
        <p className="text-muted" data-testid="file-history-empty">{t('knowledge.repository.noHistory')}</p>
      ) : (
        <div className="table-wrap">
        <table className="w-full border-collapse text-small" data-testid="file-history">
          <thead>
            <tr className="border-b border-line text-left text-muted">
              <th className="py-1 font-normal">{t('knowledge.repository.commit')}</th>
              <th className="py-1 font-normal">{t('knowledge.repository.date')}</th>
              <th className="py-1 font-normal">{t('knowledge.repository.change')}</th>
              <th className="py-1 text-right font-normal">+</th>
              <th className="py-1 text-right font-normal">−</th>
              <th className="py-1 font-normal">{t('knowledge.repository.subject')}</th>
            </tr>
          </thead>
          <tbody>
            {model.history.map((row) => (
              <tr key={`${row.commit}\u0000${row.walk}`} className="border-b border-line align-top last:border-b-0" data-testid="history-row" data-change={row.change}>
                <td className="py-1 pr-3"><KLink href={addressOfCommit(row.commit)} testId="history-commit"><code>{row.commit.slice(0, 12)}</code></KLink></td>
                <td className="py-1 pr-3 whitespace-nowrap text-muted"><time dateTime={row.date}>{instantText(row.date, row.offsetMin)}</time></td>
                <td className="py-1 pr-3">{row.change}{row.previousPath === null ? '' : ` ← ${row.previousPath}`}</td>
                <td className="py-1 text-right text-muted">{row.added === null ? '—' : `+${row.added}`}</td>
                <td className="py-1 text-right text-muted">{row.removed === null ? '—' : `−${row.removed}`}</td>
                <td className="py-1">{row.subject}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      {model.next !== null && <p className="mt-2 text-small"><KLink href={addressOfFile(path, model.next)} testId="file-history-more">{t('knowledge.repository.more')}</KLink></p>}
    </section>
  );
}

/** One commit: its facts, its parents and the paths it changed. */
export function CommitPage({ hash, version }: { hash: string; version: number }): React.ReactElement {
  const { t } = useTranslation();
  const { data, error } = useRead<{ commit: CommitPageModel }>(`commit:${hash}`, version, (signal) => getCommit(hash, signal));
  if (data === null && error === null) return <PageSkeleton testId="commit-loading" rows />;
  if (data === null) return <Refusal what={hash} message={error ?? ''} />;
  const commit = data.commit;
  const facts: [string, React.ReactNode][] = [
    [t('knowledge.repository.hash'), <code key="hash" className="break-all">{commit.hash}</code>],
    [t('knowledge.repository.author'), <span key="author">{commit.author.name || t('knowledge.repository.unknownAuthor')}{commit.author.email === '' ? '' : ` <${commit.author.email}>`}</span>],
    [t('knowledge.repository.authorDate'), <span key="authorDate">{instantText(commit.authorDate, commit.authorOffsetMin)}</span>],
    [t('knowledge.repository.commitDate'), <span key="commitDate">{instantText(commit.commitDate, commit.commitOffsetMin)}</span>],
    [t('knowledge.repository.subject'), <span key="subject">{commit.subject}</span>],
    [t('knowledge.repository.parents'), commit.parents.length === 0 ? <span key="parents">—</span> : <span key="parents">{commit.parents.map((parent, index) => <span key={parent}>{index === 0 ? '' : ', '}<KLink href={addressOfCommit(parent)}><code>{parent.slice(0, 12)}</code></KLink></span>)}</span>],
  ];
  return (
    <section data-testid="commit-page" data-hash={hash}>
      <header className="mb-4">
        <h1 className="break-all text-[22px]">{commit.subject}</h1>
        <AsIsLine repository={commit.repository} commit={commit.asIsCommit} />
      </header>
      <div className="table-wrap mb-8">
      <table className="w-full border-collapse text-small" data-testid="commit-facts">
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
      <h2 className="mb-2 mt-0">{t('knowledge.repository.changed')}</h2>
      <div className="table-wrap">
      <table className="w-full border-collapse text-small" data-testid="commit-changed">
        <thead>
          <tr className="border-b border-line text-left text-muted">
            <th className="py-1 font-normal">{t('knowledge.repository.path')}</th>
            <th className="py-1 font-normal">{t('knowledge.repository.change')}</th>
            <th className="py-1 text-right font-normal">+</th>
            <th className="py-1 text-right font-normal">−</th>
          </tr>
        </thead>
        <tbody>
          {commit.changed.map((one) => (
            <tr key={one.path} className="border-b border-line last:border-b-0" data-testid="changed-row" data-change={one.change}>
              <td className="py-1 pr-3 break-all">
                {one.change === 'deleted' ? <code>{one.path}</code> : <KLink href={addressOfFile(one.path)} testId="changed-file"><code>{one.path}</code></KLink>}
                {one.previousPath === null ? '' : <span className="text-muted"> ← {one.previousPath}</span>}
              </td>
              <td className="py-1 pr-3">{one.change}</td>
              <td className="py-1 text-right text-muted">{one.added === null ? '—' : `+${one.added}`}</td>
              <td className="py-1 text-right text-muted">{one.removed === null ? '—' : `−${one.removed}`}</td>
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
  const { data, error } = useRead<{ run: FillRunView }>(`run:${named ?? ''}`, version, (signal) => getRun(named, signal));
  if (data === null && error === null) return <PageSkeleton testId="run-loading" rows />;
  if (data === null) return <Refusal what={named ?? t('knowledge.run.title')} message={error ?? ''} />;
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
