/**
 * The product's overview on its home page (madarch-64o5.83, the owner's fix (a) 10): who the product is, what needs a
 * person now, and how the last fill went — the three things a reader opens the home page for. It reads the answers the
 * frame already asks for (the open problems, the fill's status and its runs) and names the product's own page when no
 * one has written it yet.
 *
 * The fill's own card (madarch-64o5.133, the home as it was before PR #299): a running fill states how far it is and
 * the last thing it did; a failed run stays with its retry until the reader dismisses it; and a product whose graph
 * holds only part of a repository's history says so and offers the fill that reads the rest.
 */
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription, AlertTitle } from './ui/alert.js';
import { Button } from './ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.js';
import { InlineGroup, Paragraph, Stack, TextLink } from './ui/typography.js';
import {
  readFillRuns, readProblemsCount, useChangeStream, useCommandRead,
  type FillRunDetail, type ProblemsCount,
} from './command.js';
import { durationWords, momentWords } from './format.js';
import { catalogueSelectionAddress, runAddress } from '../address.js';
import type { SectionContext } from './types.js';

/** The states of a run that is still going; a run in one of them is the fill the home follows. */
const LIVE = ['queued', 'running', 'paused'];

/** Where the reader's dismissal of a failed run is kept: this tab, until the reader closes it. */
const DISMISS_KEY = 'madarch-fill-dismissed';

const dismissedRun = (): string | null => {
  try { return window.sessionStorage.getItem(DISMISS_KEY); } catch { return null; }
};

export function ProductOverviewSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t, i18n } = useTranslation();
  const language = context.language !== undefined && context.language !== '' ? context.language : (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  const problems = useCommandRead<ProblemsCount>('problems-count', (signal) => readProblemsCount(context.base, signal));
  const runs = useCommandRead<{ runs: readonly FillRunDetail[] }>('fill-runs', (signal) => readFillRuns(context.base, signal));
  useChangeStream(context.base, () => { problems.reload(); runs.reload(); });
  const last: FillRunDetail | undefined = runs.data?.runs[0];
  const live = last !== undefined && LIVE.includes(last.phase);
  const [dismissed, setDismissed] = useState<string | null>(dismissedRun);
  // A number stands only on a successful answer: a request that failed, or has not answered yet, is "not known" — never
  // zero problems and never "no fill has run" said as fact (madarch-64o5.83, review P2).
  const notKnown = t('overview.notKnown');
  const problemsText = problems.error !== null || problems.data === null ? notKnown : t('overview.problems', { count: problems.data.open });
  const fillState: 'known' | 'none' | 'unknown' = runs.error !== null || runs.data === null ? 'unknown' : last === undefined ? 'none' : 'known';
  const failed = last !== undefined && last.phase === 'failed';
  return (
    <Stack data-testid="product-overview">
      <Card>
        <CardHeader><CardTitle>{t('overview.title')}</CardTitle></CardHeader>
        <CardContent>
          <Stack>
            {/* The product's own page is written by an agent or a person; until then the home says so rather than nothing. */}
            <Paragraph data-testid="overview-description">{t('overview.description')}</Paragraph>
            <InlineGroup align="baseline">
              <TextLink href={context.base + '/p/problems'} onClick={(event) => { event.preventDefault(); context.open('/p/problems'); }} data-testid="overview-problems">
                {problemsText}
              </TextLink>
              {fillState === 'unknown' ? <Paragraph data-testid="overview-fill-unknown">{t('overview.fillUnknown')}</Paragraph> : fillState === 'none' ? <Paragraph data-testid="overview-no-fill">{t('overview.noFill')}</Paragraph> : (
                <TextLink href={context.base + runAddress(last!.runId)} onClick={(event) => { event.preventDefault(); context.open(runAddress(last!.runId)); }} data-testid="overview-last-fill">
                  {t('overview.lastFill', { when: momentWords(last!.startedAt, language), count: last!.units.length, duration: durationWords(last!.elapsedMs, language) })}
                </TextLink>
              )}
            </InlineGroup>
            {!live || last === undefined ? null : (
              <Stack data-testid="overview-fill-running">
                <Paragraph data-testid="overview-fill-counts">{t('knowledge.fillRun.active', { done: last.publishedUnits, total: last.units.length })}</Paragraph>
              </Stack>
            )}
          </Stack>
        </CardContent>
      </Card>
      {!failed || last === undefined || dismissed === last.runId ? null : (
        <Alert variant="problem" data-testid="overview-fill-failed">
          <AlertTitle>{t('knowledge.fillRun.failed')}</AlertTitle>
          <AlertDescription>
            <Paragraph>{t('knowledge.fillRun.final.failed')}</Paragraph>
            <Paragraph>{t('knowledge.fillRun.next.retry')}</Paragraph>
            <InlineGroup>
              <Button variant="default" size="default" onClick={() => context.open(catalogueSelectionAddress([]))} data-testid="overview-fill-retry">{t('knowledge.fillRun.next.retryAction')}</Button>
              <Button variant="ghost" size="default" onClick={() => { try { window.sessionStorage.setItem(DISMISS_KEY, last.runId); } catch { /* the dismissal lasts for this page */ } setDismissed(last.runId); }} data-testid="overview-fill-dismiss">{t('knowledge.writer.dismiss')}</Button>
            </InlineGroup>
          </AlertDescription>
        </Alert>
      )}

    </Stack>
  );
}
