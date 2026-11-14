
/**
 * The runs page (the design change of madarch-64o5.71): the history of fills, always reachable from the sidebar. A run's
 * own page stays separate; this page lists every run and offers the way back to the catalogue's selection mode.
 */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from './ui/alert.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { Skeleton } from './ui/skeleton.js';
import { Disclosure, DisclosureSummary } from './ui/disclosure.js';
import { ListItem, Paragraph, PlainList, Stack, TextLink } from './ui/typography.js';
import { durationWords, momentWords } from './format.js';
import { readFillRuns, useChangeStream, useCommandRead, type FillRunDetail } from './command.js';
import { catalogueSelectionAddress, runAddress } from '../address.js';
import type { SectionContext } from './types.js';

export function RunsSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t, i18n } = useTranslation();
  const language = (context.language !== undefined && context.language !== '' ? context.language : (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en');
  const read = useCommandRead<{ runs: readonly FillRunDetail[] }>('runs', (signal) => readFillRuns(context.base, signal));
  useChangeStream(context.base, read.reload);
  const labelOf = (kind: string): string | undefined => context.navigation?.kinds.find((one) => one.kind === kind)?.many;
  const selection = (run: FillRunDetail): string => {
    const kinds = (run.order ?? run.selected ?? []).map(labelOf).filter((label): label is string => label !== undefined);
    return kinds.length === 0 ? t('knowledge.fillRun.selectionUnknown') : kinds.join(', ');
  };
  return (
    <Stack className="grid gap-4" data-testid="runs-page">
      <Paragraph className="m-0 text-secondary">{t('runs.intro')}</Paragraph>
      <Button variant="default" size="default" className="w-fit" onClick={() => context.open(catalogueSelectionAddress())} data-testid="runs-new">
        {t('runs.newFill')}
      </Button>
      {read.error === null ? null : <Alert variant="problem" data-testid="runs-error"><AlertDescription>{read.error}</AlertDescription></Alert>}
      {read.data === null && read.error === null ? <Skeleton className="h-6 w-72" /> : null}
      {read.data !== null && read.data.runs.length === 0 ? <Paragraph className="text-small text-muted" data-testid="runs-empty">{t('runs.none')}</Paragraph> : null}
      {read.data === null ? null : (
        <PlainList className="m-0 grid list-none gap-2 p-0">
          {read.data.runs.map((run) => {
            const failed = run.units.filter((unit) => unit.status === 'failed').length;
            return (
            <ListItem key={run.runId} className="rounded-lg border border-line p-3" data-testid="runs-run" data-state={run.state}>
              <Stack className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <TextLink href={context.base + runAddress(run.runId)} onClick={(event) => { event.preventDefault(); context.open(runAddress(run.runId)); }} className="font-medium">
                  {momentWords(run.startedAt, language)}
                </TextLink>
                <Badge variant={run.state === 'running' || run.state === 'paused' ? 'solid' : 'outline'}>{t(`knowledge.fillRun.state.${run.state}`, { defaultValue: run.state })}</Badge>
                {run.finishedAt === null ? null : <Paragraph className="m-0 text-small text-muted">{momentWords(run.finishedAt, language)}</Paragraph>}
              </Stack>
              <Paragraph className="m-0 mt-1 text-small text-secondary" data-testid="runs-summary">
                {t('knowledge.fillRun.count', { done: run.publishedUnits, total: run.units.length })}
                {' · '}{t('runs.took', { duration: durationWords(run.elapsedMs, language) })}
                {failed === 0 ? '' : ` · ${t('runs.failedUnits', { count: failed })}`}
              </Paragraph>
              {/* The kinds a run asked for are one long sentence; a reader who wants them opens them. */}
              <Disclosure className="mt-1 text-small">
                <DisclosureSummary className="cursor-pointer text-muted">{t('runs.kinds', { count: (run.order ?? run.selected ?? []).length })}</DisclosureSummary>
                <Paragraph className="m-0 mt-1 text-small text-muted" data-testid="runs-selection">{selection(run)}</Paragraph>
              </Disclosure>
            </ListItem>
            );
          })}
        </PlainList>
      )}
    </Stack>
  );
}
