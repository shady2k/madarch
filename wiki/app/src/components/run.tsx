
/**
 * The run page (decision 0036, sections 7 and 8): one fill run's progress per kind and plugin, its result, the reader's
 * pause and stop, and a log written for a person — no engine trace, no machine path and no internal id. The run is the
 * server's durable state (`/api/fill-runs?run=<id>`); the page follows it through `/api/events` and a one-second tick
 * while the run is live.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Alert, AlertDescription, AlertTitle } from './ui/alert.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.js';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog.js';
import { Disclosure, DisclosureSummary } from './ui/disclosure.js';
import { Progress } from './ui/progress.js';
import { Skeleton } from './ui/skeleton.js';
import { ListItem, Paragraph, PlainList, Stack, Text, TextLink } from './ui/typography.js';
import {
  isOffline, pauseFillRun, readFillPlan, readFillRun, stopFillRun, useChangeStream, useCommandRead,
  type FillPlanView, type FillRunDetail, type FillRunGroup,
} from './command.js';
import { RUNS_PAGE } from '../address.js';
import { InlineCode } from './ui/inline-content.js';
import { OfflineAction } from './ui/offline-action.js';
import { useConnection } from '../connection.js';
import type { SectionContext } from './types.js';

const LIVE = ['queued', 'running', 'paused'];
const STOPPABLE = ['queued', 'running', 'paused'];

/** The words a run's own event kinds take; the events' trace text is never shown. */
const EVENT_WORDS: Readonly<Record<string, string>> = {
  'run-planned': 'planned',
  'run-started': 'started',
  'run-paused': 'paused',
  'run-resumed': 'resumed',
  'run-cancelling': 'cancelling',
  'run-cancelled': 'cancelled',
  'run-completed': 'completed',
  'run-completed-partial': 'partial',
  'run-failed': 'failed',
  'run-blocked': 'blocked',
  'stage-planned': 'stagePlanned',
  'stage-found-nothing': 'foundNothing',
  'unit-published': 'unitPublished',
  'unit-failed': 'unitFailed',
  'unit-blocked': 'unitBlocked',
  'unit-retried': 'unitRetried',
  'unit-planned': 'unitPlanned',
  'unit-skipped': 'unitSkipped',
};

/** A failed unit's cause, when the run page can name it and what to do about it. */
function failureCauseOf(run: FillRunDetail): 'sandbox' | undefined {
  for (const event of run.events) {
    if (event.type !== 'unit-failed' && event.type !== 'unit-retried' && event.type !== 'unit-blocked') continue;
    if (/cgroup|subtree_control|MADARCH_PLUGIN_SANDBOX/i.test(event.summary)) return 'sandbox';
  }
  return undefined;
}

/** The group a run event belongs to: the unit's own id ends its stage's path (`plugin-turns/disk:code.file`). */
function groupOf(groups: readonly FillRunGroup[], text: string): FillRunGroup | undefined {
  const unit = text.slice(text.lastIndexOf('/') + 1);
  return groups.find((group) => {
    const prefix = `${group.plugin}:${group.kind}`;
    return unit === prefix || unit.startsWith(`${prefix}@`) || unit.startsWith(`${prefix}/`);
  });
}

function seconds(value: number): number {
  return Math.max(0, Math.round(value / 1000));
}

/** A final run's ending as the reader reads it: day, month, hour and minute, never a second year line. */
function shortMoment(iso: string, language: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 16).replace('T', ', ');
  return new Intl.DateTimeFormat(language, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
}

/** The run's log as a person reads it: state changes and work per kind, never the engine's own sentences. */
function logLines(run: FillRunDetail, groups: readonly FillRunGroup[], labelOf: (kind: string) => string | undefined, pluginName: (name: string) => string | undefined, t: TFunction, language: string): { at: string; text: string }[] {
  const lines: { at: string; text: string }[] = [];
  for (const event of run.events.slice(-200)) {
    const word = EVENT_WORDS[event.type];
    if (word === undefined) continue;
    const group = groupOf(groups, event.unitId !== '' ? event.unitId : event.stage);
    if (word.startsWith('unit') || word === 'stagePlanned' || word === 'foundNothing') {
      if (group === undefined) continue;
      const kind = labelOf(group.kind);
      if (kind === undefined) continue;
      lines.push({ at: event.at, text: t(`knowledge.fillRun.event.${word}`, { kind, plugin: pluginName(group.plugin) ?? group.plugin }) });
      continue;
    }
    lines.push({ at: event.at, text: t(`knowledge.fillRun.event.${word}`) });
  }
  return lines.map((line) => ({ at: new Date(line.at).toLocaleTimeString(language), text: line.text }));
}

/** One fill run. */
export function RunSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t, i18n } = useTranslation();
  const connection = useConnection();
  const language = context.language !== undefined && context.language !== '' ? context.language : (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  const parameter = typeof context.section.params['runVariable'] === 'string' ? context.section.params['runVariable'] : 'run';
  const bound = context.variables[parameter];
  const runId = typeof bound === 'string' ? bound : '';
  const read = useCommandRead<{ run: FillRunDetail }>(`fill-run:${runId}`, (signal) => readFillRun(context.base, runId, signal), runId !== '');
  const run = read.data?.run ?? null;
  const orderKey = (run?.order ?? run?.selected ?? []).join(',');
  const plan = useCommandRead<{ plan: FillPlanView }>(`run-plan-labels:${orderKey}`, (signal) => readFillPlan(context.base, run?.order ?? run?.selected ?? [], signal), run !== null && orderKey !== '');
  useChangeStream(context.base, () => { read.reload(); });
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const live = run !== null && LIVE.includes(run.phase);
  useEffect(() => {
    if (!live) return;
    // The run's own state moves while a fill writes; the change stream may not say so, so the page reads it again each
    // second. The clock drives the elapsed line between reads.
    const timer = setInterval(() => { setNow(Date.now()); read.reload(); }, 1000);
    return () => clearInterval(timer);
  }, [live, read.reload]);

  const catalogue = context.navigation?.kinds ?? [];
  const groups = context.navigation?.groups ?? [];
  const cause = run === null ? undefined : failureCauseOf(run);
  const pluginName = (name: string): string | undefined => {
    const labels = plan.data?.plan.plugins?.find((plugin) => plugin.name === name)?.labels;
    return labels?.[language] ?? labels?.['en'];
  };
  const labelOf = (kind: string): string | undefined => catalogue.find((one) => one.kind === kind)?.many;
  const groupLabelOf = (kind: string): string | undefined => {
    const held = catalogue.find((one) => one.kind === kind);
    if (held?.group === null || held?.group === undefined) return undefined;
    const group = groups.find((one) => one.name === held.group);
    return group?.labels[language] ?? group?.labels['en'] ?? held.group;
  };
  const names = (run?.order ?? run?.selected ?? []).map((kind) => labelOf(kind)).filter((label): label is string => label !== undefined);
  const lines = run === null ? [] : logLines(run, run.groups, labelOf, pluginName, t, language);

  const act = (action: 'pause' | 'stop'): void => {
    if (connection.offline || run === null) return;
    setBusy(true);
    setFailure(null);
    const work = action === 'pause' ? pauseFillRun(context.base, run.runId) : stopFillRun(context.base, run.runId);
    work.then(
      () => { setBusy(false); setConfirming(false); read.reload(); },
      (error: unknown) => { setBusy(false); setFailure(isOffline(error) ? null : error instanceof Error ? error.message : String(error)); },
    );
  };

  if (runId === '') return <Alert variant="problem" data-testid="fill-run-missing"><AlertDescription>{t('knowledge.fillRun.noRun')}</AlertDescription></Alert>;
  if (read.error !== null) return <Alert variant="problem" data-testid="fill-run-error"><AlertDescription>{read.error}</AlertDescription></Alert>;
  if (run === null) return <Skeleton className="h-10 w-80" data-testid="fill-run-loading" />;

  const started = new Date(run.startedAt);
  const elapsed = live ? Math.max(run.elapsedMs, now - started.getTime()) : run.elapsedMs;
  const terminal = run.final || ['succeeded', 'partial', 'failed', 'stopped'].includes(run.phase);
  const emptyWords = t(terminal ? 'knowledge.fillRun.noUnits' : 'knowledge.fillRun.planning');
  const agentUsage = run.agentUsage;
  const finished = run.finishedAt === null ? null : shortMoment(run.finishedAt, language);
  const liveRun = run;

  return (
    <Stack className="grid gap-6" data-testid="fill-run-page" data-state={run.state} data-phase={run.phase}>
      <Card>
        <CardHeader>
          <Stack className="flex flex-wrap items-center gap-2" data-testid="fill-run-status" data-phase={run.phase}>
            <Badge variant={terminal ? 'solid' : 'outline'} className="px-2 py-0.5 text-small" data-testid="fill-run-status-badge">{t(`knowledge.fillRun.status.${run.phase}`, { defaultValue: run.phase })}</Badge>
            {finished === null ? null : <Text className="text-small text-muted" data-testid="fill-run-ended">{finished}{t('common.separator')}{t('knowledge.fillRun.duration', { seconds: seconds(elapsed) })}</Text>}
          </Stack>
          <CardTitle>{run.units.length === 0 ? emptyWords : t('knowledge.fillRun.count', { done: run.publishedUnits, total: run.units.length, count: run.units.length })}</CardTitle>
          {terminal && (run.phase === 'partial' || run.phase === 'failed') ? (
            <Alert variant="problem" className="mt-2" data-testid="fill-run-final" data-phase={run.phase}>
              <AlertTitle data-testid="fill-run-final-title">{t('knowledge.fillRun.attention')}</AlertTitle>
              <AlertDescription>
                <Paragraph className="m-0">{cause === undefined ? t(`knowledge.fillRun.final.${run.phase}`) : t(`knowledge.fillRun.cause.${cause}`)}</Paragraph>
                <Paragraph className="m-0">{t('knowledge.fillRun.next.retry')}</Paragraph>
                <Button variant="default" size="sm" className="mt-2" data-testid="fill-run-retry" onClick={() => context.open('/p/catalogue?select=1')}>{t('knowledge.fillRun.next.retryAction')}</Button>
              </AlertDescription>
            </Alert>
          ) : null}
          {names.length === 0 ? null : <Paragraph className="m-0 text-small text-muted" data-testid="fill-run-selection">{names.join(', ')}</Paragraph>}
        </CardHeader>
        <CardContent>
          {run.units.length > 0 && !terminal ? <Progress value={run.publishedUnits} max={run.units.length} aria-label={t('knowledge.fillRun.count', { done: run.publishedUnits, total: run.units.length, count: run.units.length })} /> : null}
          <Paragraph className="mt-3 text-small" data-testid="fill-run-time">
            {t('knowledge.fillRun.elapsed', { seconds: seconds(elapsed) })}{terminal ? null : <>{t('common.separator')}{run.remainingMs === null ? t('knowledge.fillRun.remainingUnknown') : t('knowledge.fillRun.remaining', { seconds: seconds(run.remainingMs) })}</>}
          </Paragraph>
          <Paragraph className="m-0 text-small" data-testid="fill-run-tokens">{agentUsage === null ? t('knowledge.fillRun.tokensUnknown') : t('knowledge.fillRun.tokens', { input: agentUsage.inputTokens, output: agentUsage.outputTokens, cacheWrite: agentUsage.cachedWriteTokens, cacheRead: agentUsage.cachedReadTokens, total: agentUsage.totalTokens })}</Paragraph>
          <Paragraph className="m-0 text-small" data-testid="fill-run-records">{t('knowledge.fillRun.records', { count: run.records })}</Paragraph>
          <Stack className="mt-4 flex flex-wrap gap-2">
            {run.phase === 'running' ? (
              <OfflineAction offline={connection.offline}>
                <Button variant="default" size="default" disabled={connection.offline || busy} onClick={() => act('pause')} data-testid="run-pause">{t('knowledge.fillPage.pause')}</Button>
              </OfflineAction>
            ) : null}
            {STOPPABLE.includes(run.phase) ? (
              <OfflineAction offline={connection.offline}>
                <Button size="default" disabled={connection.offline || busy || run.state === 'cancelling'} onClick={() => setConfirming(true)} data-testid="run-stop">{t('knowledge.fillPage.stop')}</Button>
              </OfflineAction>
            ) : null}
          </Stack>
          {failure === null ? null : <Paragraph role="alert" className="mt-2 text-small">{failure}</Paragraph>}
        </CardContent>
      </Card>

      <Card data-testid="fill-run-groups">
        <CardHeader><CardTitle>{t('knowledge.fillRun.result')}</CardTitle></CardHeader>
        <CardContent>
          <PlainList className="m-0 list-none p-0">
            {liveRun.groups.filter((group) => group.total > 0).map((group) => {
              const kind = labelOf(group.kind);
              if (kind === undefined) return null;
              const area = groupLabelOf(group.kind);
              return (
                <ListItem key={`${group.kind}:${group.plugin}`} className="mb-3" data-testid="fill-run-group">
                  <Paragraph className="m-0">
                    {area === undefined || area === kind ? null : <Text className="text-muted">{area}{t('common.separator')}</Text>}
                    {kind}{t('common.separator')}{pluginName(group.plugin) === undefined ? <InlineCode>{group.plugin}</InlineCode> : pluginName(group.plugin)}
                  </Paragraph>
                  <Paragraph className="m-0 text-small text-muted">
                    {group.total === 0 ? emptyWords : t('knowledge.fillRun.count', { done: group.done, total: group.total, count: group.total })}{t('common.separator')}{t(`knowledge.fillRun.phase.${group.phase}`, { defaultValue: group.phase })}
                  </Paragraph>
                  {group.total > 0 ? <Progress value={group.done} max={group.total} aria-label={kind} /> : null}
                </ListItem>
              );
            })}
          </PlainList>
          {terminal && liveRun.units.some((unit) => unit.phase === 'failed' || unit.phase === 'skipped') ? (
            <PlainList className="m-0 mt-3 list-none p-0" data-testid="fill-run-units">
              {liveRun.units.filter((unit) => unit.phase === 'failed' || unit.phase === 'skipped').map((unit) => {
                const group = groupOf(liveRun.groups, unit.unitId);
                const unitKind = group === undefined ? undefined : labelOf(group.kind);
                const unitPlugin = group === undefined ? undefined : pluginName(group.plugin) ?? group.plugin;
                const words = unitKind === undefined ? undefined : `${unitKind}${unitPlugin === undefined ? '' : ` · ${unitPlugin}`}`;
                const because = unit.skippedBecause?.startsWith('unit ') === true && unit.skippedBecause.endsWith(' failed')
                  ? (() => {
                    const failedId = unit.skippedBecause.slice('unit '.length, -' failed'.length);
                    const failedGroup = groupOf(liveRun.groups, failedId);
                    const failedKind = failedGroup === undefined ? undefined : labelOf(failedGroup.kind);
                    const failedPlugin = failedGroup === undefined ? undefined : pluginName(failedGroup.plugin) ?? failedGroup.plugin;
                    return failedKind === undefined ? t('knowledge.fillRun.phase.skippedBecauseRunEnded') : t('knowledge.fillRun.phase.skippedBecause', { unit: `${failedKind}${failedPlugin === undefined ? '' : ` · ${failedPlugin}`}` });
                  })()
                  : unit.phase === 'skipped' ? t('knowledge.fillRun.phase.skippedBecauseRunEnded') : null;
                return (
                  <ListItem key={`${unit.unitId}@${String(unit.generation)}:${unit.scope}`} className="text-small" data-testid="fill-run-unit">
                    {t(`knowledge.fillRun.phase.${unit.phase}`, { defaultValue: unit.phase })}{words === undefined ? null : ` · ${words}`}
                    {because === null ? null : ` — ${because}`}
                  </ListItem>
                );
              })}
            </PlainList>
          ) : null}
        </CardContent>
      </Card>

      <Disclosure className="mt-2" data-testid="fill-run-log">
        <DisclosureSummary>{t('knowledge.fillRun.log')}</DisclosureSummary>
        {lines.length === 0 ? <Paragraph className="text-small text-muted">{t('knowledge.fillRun.logEmpty')}</Paragraph> : (
          <PlainList className="m-0 list-none p-0">
            {lines.map((line, at) => <ListItem key={`${String(at)}:${line.at}`} className="text-small">{line.at}{t('common.separator')}{line.text}</ListItem>)}
          </PlainList>
        )}
      </Disclosure>

      <Paragraph><TextLink href={context.base + RUNS_PAGE} onClick={(event) => { event.preventDefault(); context.open(RUNS_PAGE); }}>{t('runs.back')}</TextLink></Paragraph>

      <Dialog open={confirming} onOpenChange={(open) => { if (!busy) setConfirming(open); }}>
        <DialogContent data-testid="stop-dialog" closeLabel={t('knowledge.fillPage.stopCancel')} closeDisabled={busy}>
          <DialogHeader><DialogTitle>{t('knowledge.fillPage.stopTitle')}</DialogTitle></DialogHeader>
          <DialogBody><DialogDescription>{t('knowledge.fillRun.stopWords')}</DialogDescription></DialogBody>
          <DialogFooter>
            <Button variant="default" size="default" disabled={connection.offline || busy} onClick={() => act('stop')} data-testid="stop-confirm">{t('knowledge.fillPage.stopConfirm')}</Button>
            <Button size="default" disabled={busy} onClick={() => setConfirming(false)}>{t('knowledge.fillPage.stopCancel')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
