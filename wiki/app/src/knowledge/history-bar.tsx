import { Card, CardContent } from '@/components/ui/card.js';
import { Select } from '@/components/ui/select.js';
import { Stack, Text, Paragraph, PlainList, ListItem, FieldLabel, TextLink } from '@/components/ui/typography.js';
import { Disclosure, DisclosureSummary } from '@/components/ui/disclosure.js';
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { appPath } from '../app-base.js';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.js';
import { Input } from '@/components/ui/input.js';
import { currentAddress, linkHandlers } from './tabs.js';
import { ENTITY_ADDRESS_PREFIX } from './routes.js';
import type { HistoryContext, PageModel } from './types.js';

/** Explicit dates never silently become today's code, including a covered tree without this entity. */
export function HistoryBar({ history, navigation, absent }: { history?: HistoryContext; navigation?: PageModel['historyNavigation']; absent?: boolean }): ReactElement | null {
  const { t } = useTranslation();
  const [repo, setRepo] = useState(history?.repo ?? navigation?.[0]?.repo ?? '');
  const [date, setDate] = useState(history?.at ?? '');
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
  const codePage = decodeURIComponent(currentAddress().split('?')[0]!).startsWith(`${ENTITY_ADDRESS_PREFIX}code.`);
  if (history === undefined && (!codePage || navigation === undefined || navigation.length === 0)) return null;
  const address = (at: string | null, repository = history?.repo ?? repo): string => {
    const url = new URL(currentAddress(), 'https://wiki.invalid');
    url.searchParams.delete('at'); url.searchParams.delete('repo');
    if (at !== null) { url.searchParams.set('at', at); url.searchParams.set('repo', repository); }
    return `${url.pathname}${url.search}${url.hash}`;
  };
  const link = (href: string, text: string): ReactElement => <TextLink href={appPath(href)} {...linkHandlers(href)}>{text}</TextLink>;
  const points = history?.points ?? navigation?.find((one) => one.repo === repo)?.points ?? [];
  const landmarks = history?.landmarks ?? navigation?.find((one) => one.repo === repo)?.landmarks;
  return <Card className="mb-4" data-testid="history-context" data-coverage={history?.coverage ?? 'current'}><CardContent>
    {history !== undefined && <Alert variant={history.coverage === 'covered' && !absent ? 'default' : 'problem'}>
      <AlertTitle>{t('knowledge.historyDateTitle', { date: history.at, repo: history.repo })}</AlertTitle>
      <AlertDescription><Paragraph>{t(`knowledge.historyCoverage.${absent ? 'absent' : history.coverage}`)}</Paragraph>{history.commit !== null && <Paragraph className="break-all font-mono text-small">{history.commit} · {history.effectiveAt}</Paragraph>}{link(address(null), t('knowledge.historyCurrent'))}</AlertDescription>
    </Alert>}
    <Stack className="mt-2 flex flex-wrap items-end gap-2">
      {history === undefined && <FieldLabel className="text-small">{t('knowledge.historyRepository')}<Select className="ml-2 max-w-full" value={repo} onChange={(event) => setRepo(event.target.value)} options={navigation?.map((one) => ({ value: one.repo, label: one.repo })) ?? []} /></FieldLabel>}
      <FieldLabel className="text-small">{t('knowledge.historyChooseDate')}<Input type="text" placeholder={t('knowledge.historyDateFormat')} value={date} onChange={(event) => setDate(event.target.value)} aria-invalid={date !== '' && !validDate} data-testid="history-date" /></FieldLabel>
      {validDate && link(address(date), t('knowledge.historyOpenDate'))}
    </Stack>
    {landmarks !== undefined && <Stack className="mt-2 text-small" data-testid="history-landmarks">
      <Paragraph>{t('knowledge.historyLandmarkCovered', { count: landmarks.covered })}{t('knowledge.historyLandmarkOffered', { count: landmarks.offered })}{t('knowledge.historyLandmarkLimit', { limit: landmarks.limit })}</Paragraph>
      {landmarks.first !== null && <Paragraph>{t('knowledge.historyLandmarkBounds', { first: landmarks.first, last: landmarks.last })}</Paragraph>}
      {landmarks.overflow && <Paragraph>{t('knowledge.historyLandmarkOmitted', { count: landmarks.omitted })}</Paragraph>}
      {landmarks.diagnostics.length > 0 && <Disclosure><DisclosureSummary>{t('knowledge.historyLandmarkUnsupported', { count: landmarks.diagnostics.length })}</DisclosureSummary><PlainList>{landmarks.diagnostics.map((one) => <ListItem key={one.ref} className="break-all">{one.ref} · {one.object} · {one.reason}</ListItem>)}</PlainList></Disclosure>}
    </Stack>}
    {points.length > 0 && <PlainList className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-small">{points.map((point) => <ListItem key={point.name}>{link(address(point.name), point.name)}{!point.covered && <Text> · {t('knowledge.historyPointUnread')}</Text>}</ListItem>)}</PlainList>}
  </CardContent></Card>;
}
