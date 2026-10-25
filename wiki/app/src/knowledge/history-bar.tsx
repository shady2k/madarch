import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { appPath } from '../app-base.js';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.js';
import { Input } from '@/components/ui/input.js';
import { currentAddress, linkHandlers } from './tabs.js';
import type { HistoryContext, PageModel } from './types.js';

/** Explicit dates never silently become today's code, including a covered tree without this entity. */
export function HistoryBar({ history, navigation, absent }: { history?: HistoryContext; navigation?: PageModel['historyNavigation']; absent?: boolean }): ReactElement | null {
  const { t } = useTranslation();
  const [repo, setRepo] = useState(history?.repo ?? navigation?.[0]?.repo ?? '');
  const [date, setDate] = useState(history?.at ?? '');
  const codePage = decodeURIComponent(currentAddress().split('?')[0]!).startsWith('/k/e/code.');
  if (history === undefined && (!codePage || navigation === undefined || navigation.length === 0)) return null;
  const address = (at: string | null, repository = history?.repo ?? repo): string => {
    const url = new URL(currentAddress(), 'https://wiki.invalid');
    url.searchParams.delete('at'); url.searchParams.delete('repo');
    if (at !== null) { url.searchParams.set('at', at); url.searchParams.set('repo', repository); }
    return `${url.pathname}${url.search}${url.hash}`;
  };
  const link = (href: string, text: string): ReactElement => <a href={appPath(href)} {...linkHandlers(href)}>{text}</a>;
  const points = history?.points ?? navigation?.find((one) => one.repo === repo)?.points ?? [];
  return <aside className="mb-4 rounded-[var(--radius-card)] border border-line p-3" data-testid="history-context" data-coverage={history?.coverage ?? 'current'}>
    {history !== undefined && <Alert variant={history.coverage === 'covered' && !absent ? 'default' : 'problem'}>
      <AlertTitle>{t('knowledge.historyDateTitle', { date: history.at, repo: history.repo })}</AlertTitle>
      <AlertDescription><p>{t(`knowledge.historyCoverage.${absent ? 'absent' : history.coverage}`)}</p>{history.commit !== null && <p className="break-all font-mono text-small">{history.commit} · {history.effectiveAt}</p>}{link(address(null), t('knowledge.historyCurrent'))}</AlertDescription>
    </Alert>}
    <div className="mt-2 flex flex-wrap items-end gap-2">
      {history === undefined && <label className="text-small">{t('knowledge.historyRepository')}<select className="ml-2 max-w-full border border-line bg-surface p-1" value={repo} onChange={(event) => setRepo(event.target.value)}>{navigation?.map((one) => <option key={one.repo} value={one.repo}>{one.repo}</option>)}</select></label>}
      <label className="text-small">{t('knowledge.historyChooseDate')}<Input type="date" value={/^\d{4}-\d{2}-\d{2}$/.test(date) ? date : ''} onChange={(event) => setDate(event.target.value)} /></label>
      {date !== '' && link(address(date), t('knowledge.historyOpenDate'))}
    </div>
    {points.length > 0 && <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-small">{points.map((point) => <li key={point.name}>{link(address(point.name), point.name)}{!point.covered && <span> · {t('knowledge.historyPointUnread')}</span>}</li>)}</ul>}
  </aside>;
}
