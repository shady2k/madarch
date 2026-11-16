/**
 * The product's overview on its home page (madarch-64o5.83, the owner's fix (a) 10): who the product is, what needs a
 * person now, and how the last fill went — the three things a reader opens the home page for. It reads the two answers
 * the frame already asks for (the open problems and the fill history) and names the product's own page when no one has
 * written it yet.
 */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.js';
import { INLINE_ALIGN, InlineGroup, Paragraph, Stack, TextLink } from './ui/typography.js';
import { readFillRuns, readProblemsCount, useChangeStream, useCommandRead, type FillRunDetail, type ProblemsCount } from './command.js';
import { durationWords, momentWords } from './format.js';
import { runAddress } from '../address.js';
import type { SectionContext } from './types.js';

export function ProductOverviewSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t, i18n } = useTranslation();
  const language = context.language !== undefined && context.language !== '' ? context.language : (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  const problems = useCommandRead<ProblemsCount>('problems-count', (signal) => readProblemsCount(context.base, signal));
  const runs = useCommandRead<{ runs: readonly FillRunDetail[] }>('fill-runs', (signal) => readFillRuns(context.base, signal));
  useChangeStream(context.base, () => { problems.reload(); runs.reload(); });
  const last: FillRunDetail | undefined = runs.data?.runs[0];
  // A number stands only on a successful answer: a request that failed, or has not answered yet, is "not known" — never
  // zero problems and never "no fill has run" said as fact (madarch-64o5.83, review P2).
  const notKnown = t('overview.notKnown');
  const problemsText = problems.error !== null || problems.data === null ? notKnown : t('overview.problems', { count: problems.data.open });
  const fillState: 'known' | 'none' | 'unknown' = runs.error !== null || runs.data === null ? 'unknown' : last === undefined ? 'none' : 'known';
  return (
    <Card data-testid="product-overview">
      <CardHeader><CardTitle>{t('overview.title')}</CardTitle></CardHeader>
      <CardContent>
        <Stack className="grid gap-2">
          {/* The product's own page is written by an agent or a person; until then the home says so rather than nothing. */}
          <Paragraph className="m-0 text-secondary" data-testid="overview-description">{t('overview.description')}</Paragraph>
          <InlineGroup align={INLINE_ALIGN.baseline} className="mb-0 gap-3">
            <TextLink href={context.base + '/p/problems'} onClick={(event) => { event.preventDefault(); context.open('/p/problems'); }} data-testid="overview-problems">
              {problemsText}
            </TextLink>
            {fillState === 'unknown' ? <Paragraph className="m-0 text-muted" data-testid="overview-fill-unknown">{t('overview.fillUnknown')}</Paragraph> : fillState === 'none' ? <Paragraph className="m-0 text-muted" data-testid="overview-no-fill">{t('overview.noFill')}</Paragraph> : (
              <TextLink href={context.base + runAddress(last!.runId)} onClick={(event) => { event.preventDefault(); context.open(runAddress(last!.runId)); }} data-testid="overview-last-fill">
                {t('overview.lastFill', { when: momentWords(last!.startedAt, language), count: last!.units.length, duration: durationWords(last!.elapsedMs, language) })}
              </TextLink>
            )}
          </InlineGroup>
        </Stack>
      </CardContent>
    </Card>
  );
}
