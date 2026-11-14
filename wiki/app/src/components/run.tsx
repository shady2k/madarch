
/**
 * The run page (decision 0036, sections 7 and 8): one fill run's progress per kind and plugin, its result, the reader's
 * pause and stop, and a log written for a person — no engine trace, no machine path and no internal id. The run is the
 * server's durable state (`/api/fill-runs?run=<id>`); the page follows it through `/api/events` and a one-second tick
 * while the run is live.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Alert, AlertDescription } from './ui/alert.js';
import { Button } from './ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.js';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog.js';
import { Disclosure, DisclosureSummary } from './ui/disclosure.js';
import { Progress } from './ui/progress.js';
import { Skeleton } from './ui/skeleton.js';
import { ListItem, Paragraph, PlainList, Stack, Text, TextLink } from './ui/typography.js';
import {
  pauseFillRun, readFillRun, stopFillRun, useChangeStream, useCommandRead,
  type FillRunDetail, type FillRunGroup,
} from './command.js';
import { RUNS_PAGE } from '../address.js';
import type { SectionContext } from './types.js';

const LIVE = ['created', 'planning', 'running', 'pausing', 'cancelling'];
const STOPPABLE = ['created', 'planning', 'running', 'pausing', 'paused'];

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
};

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

/** The run's log as a person reads it: state changes and work per kind, never the engine's own sentences. */
function logLines(run: FillRunDetail, groups: readonly FillRunGroup[], labelOf: (kind: string) => string | undefined, t: TFunction, language: string): { at: string; text: string }[] {
  const lines: { at: string; text: string }[] = [];
  for (const event of run.events.slice(-200)) {
    const word = EVENT_WORDS[event.type];
    if (word === undefined) continue;
    const group = groupOf(groups, event.unitId !== '' ? event.unitId : event.stage);
    if (word.startsWith('unit') || word === 'stagePlanned' || word === 'foundNothing') {
      if (group === undefined) continue;
      const kind = labelOf(group.kind);
      if (kind === undefined) continue;
      lines.push({ at: event.at, text: t(`knowledge.fillRun.event.${word}`, { kind, plugin: group.plugin }) });
      continue;
    }
    lines.push({ at: event.at, text: t(`knowledge.fillRun.event.${word}`) });
  }
  return lines.map((line) => ({ at: new Date(line.at).toLocaleTimeString(language), text: line.text }));
}

/** One fill run. */
export function RunSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t, i18n } = useTranslation();
  const language = context.language !== undefined && context.language !== '' ? context.language : (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  const parameter = typeof context.section.params['runVariable'] === 'string' ? context.section.params['runVariable'] : 'run';
  const bound = context.variables[parameter];
  const runId = typeof bound === 'string' ? bound : '';
  const read = useCommandRead<{ run: FillRunDetail }>(`fill-run:${runId}`, (signal) => readFillRun(context.base, runId, signal), runId !== '');
  const run = read.data?.run ?? null;
  useChangeStream(context.base, () => { read.reload(); });
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const live = run !== null && LIVE.includes(run.state);
  useEffect(() => {
    if (!live) return;
    // The run's own state moves while a fill writes; the change stream may not say so, so the page reads it again each
    // second. The clock drives the elapsed line between reads.
    const timer = setInterval(() => { setNow(Date.now()); read.reload(); }, 1000);
    return () => clearInterval(timer);
  }, [live, read.reload]);

  const catalogue = context.navigation?.kinds ?? [];
  const groups = context.navigation?.groups ?? [];
  const labelOf = (kind: string): string | undefined => catalogue.find((one) => one.kind === kind)?.many;
  const groupLabelOf = (kind: string): string | undefined => {
    const held = catalogue.find((one) => one.kind === kind);
    if (held?.group === null || held?.group === undefined) return undefined;
    const group = groups.find((one) => one.name === held.group);
    return group?.labels[language] ?? group?.labels['en'] ?? held.group;
  };
  const names = (run?.order ?? run?.selected ?? []).map((kind) => labelOf(kind)).filter((label): label is string => label !== undefined);
  const lines = run === null ? [] : logLines(run, run.groups, labelOf, t, language);

  const act = (action: 'pause' | 'stop'): void => {
    if (run === null) return;
    setBusy(true);
    setFailure(null);
    const work = action === 'pause' ? pauseFillRun(context.base, run.runId) : stopFillRun(context.base, run.runId);
    work.then(
      () => { setBusy(false); setConfirming(false); read.reload(); },
      (error: unknown) => { setBusy(false); setFailure(error instanceof Error ? error.message : String(error)); },
    );
  };

  if (runId === '') return <Alert variant="problem" data-testid="fill-run-missing"><AlertDescription>{t('knowledge.fillRun.noRun')}</AlertDescription></Alert>;
  if (read.error !== null) return <Alert variant="problem" data-testid="fill-run-error"><AlertDescription>{read.error}</AlertDescription></Alert>;
  if (run === null) return <Skeleton className="h-10 w-80" data-testid="fill-run-loading" />;

  const started = new Date(run.startedAt);
  const elapsed = live ? Math.max(run.elapsedMs, now - started.getTime()) : run.elapsedMs;
  const terminal = !LIVE.includes(run.state) && run.state !== 'paused';
  const emptyWords = t(terminal ? 'knowledge.fillRun.noUnits' : 'knowledge.fillRun.planning');
  const agentUsage = run.agentUsage;
  const finished = run.finishedAt === null ? null : new Date(run.finishedAt).toLocaleString(language);
  const liveRun = run;

  return (
    <Stack className="grid gap-6" data-testid="fill-run-page" data-state={run.state}>
      <Card>
        <CardHeader>
          <CardTitle>{run.units.length === 0 ? emptyWords : t('knowledge.fillRun.count', { done: run.publishedUnits, total: run.units.length })}</CardTitle>
          <Paragraph className="m-0 text-small text-muted" data-testid="fill-run-when">
            {started.toLocaleString(language)} · {t(`knowledge.fillRun.state.${run.state}`, { defaultValue: run.state })}
            {finished === null ? null : <> · {t('knowledge.fillPage.finished', { time: finished })}</>}
          </Paragraph>
          {names.length === 0 ? null : <Paragraph className="m-0 text-small text-muted" data-testid="fill-run-selection">{names.join(', ')}</Paragraph>}
        </CardHeader>
        <CardContent>
          {run.units.length > 0 ? <Progress value={run.publishedUnits} max={run.units.length} aria-label={t('knowledge.fillRun.count', { done: run.publishedUnits, total: run.units.length })} /> : null}
          <Paragraph className="mt-3 text-small" data-testid="fill-run-time">
            {t('knowledge.fillRun.elapsed', { seconds: seconds(elapsed) })} · {run.remainingMs === null ? t('knowledge.fillRun.remainingUnknown') : t('knowledge.fillRun.remaining', { seconds: seconds(run.remainingMs) })}
          </Paragraph>
          <Paragraph className="m-0 text-small" data-testid="fill-run-tokens">{agentUsage === null ? t('knowledge.fillRun.tokensUnknown') : t('knowledge.fillRun.tokens', { input: agentUsage.inputTokens, output: agentUsage.outputTokens, total: agentUsage.totalTokens })}</Paragraph>
          <Paragraph className="m-0 text-small" data-testid="fill-run-records">{t('knowledge.fillRun.records', { count: run.records })}</Paragraph>
          {run.state === 'failed' ? <Alert variant="problem" className="mt-3"><AlertDescription>{t('knowledge.fillRun.failed')}</AlertDescription></Alert> : null}
          <Stack className="mt-4 flex flex-wrap gap-2">
            {run.state === 'running' ? <Button variant="default" size="default" disabled={busy} onClick={() => act('pause')} data-testid="run-pause">{t('knowledge.fillPage.pause')}</Button> : null}
            {STOPPABLE.includes(run.state) ? <Button size="default" disabled={busy || run.state === 'cancelling'} onClick={() => setConfirming(true)} data-testid="run-stop">{t('knowledge.fillPage.stop')}</Button> : null}
          </Stack>
          {failure === null ? null : <Paragraph role="alert" className="mt-2 text-small">{failure}</Paragraph>}
        </CardContent>
      </Card>

      <Card data-testid="fill-run-groups">
        <CardHeader><CardTitle>{t('knowledge.fillRun.result')}</CardTitle></CardHeader>
        <CardContent>
          <PlainList>
            {liveRun.groups.map((group) => {
              const kind = labelOf(group.kind);
              if (kind === undefined) return null;
              const area = groupLabelOf(group.kind);
              return (
                <ListItem key={`${group.kind}:${group.plugin}`} className="mb-3" data-testid="fill-run-group">
                  <Paragraph className="m-0">
                    {area === undefined || area === kind ? null : <Text className="text-muted">{area} · </Text>}
                    {kind} · {group.plugin}
                  </Paragraph>
                  <Paragraph className="m-0 text-small text-muted">
                    {group.total === 0 ? emptyWords : t('knowledge.fillRun.count', { done: group.done, total: group.total })} · {t(`knowledge.fillRun.state.${group.state}`, { defaultValue: group.state })}
                  </Paragraph>
                  {group.total > 0 ? <Progress value={group.done} max={group.total} aria-label={kind} /> : null}
                </ListItem>
              );
            })}
          </PlainList>
        </CardContent>
      </Card>

      <Disclosure className="mt-2" data-testid="fill-run-log">
        <DisclosureSummary>{t('knowledge.fillRun.log')}</DisclosureSummary>
        {lines.length === 0 ? <Paragraph className="text-small text-muted">{t('knowledge.fillRun.logEmpty')}</Paragraph> : (
          <PlainList>
            {lines.map((line, at) => <ListItem key={`${String(at)}:${line.at}`} className="text-small">{line.at} · {line.text}</ListItem>)}
          </PlainList>
        )}
      </Disclosure>

      <Paragraph><TextLink href={context.base + RUNS_PAGE} onClick={(event) => { event.preventDefault(); context.open(RUNS_PAGE); }}>{t('runs.back')}</TextLink></Paragraph>

      <Dialog open={confirming} onOpenChange={(open) => { if (!busy) setConfirming(open); }}>
        <DialogContent data-testid="stop-dialog" closeLabel={t('knowledge.fillPage.stopCancel')} closeDisabled={busy}>
          <DialogHeader><DialogTitle>{t('knowledge.fillPage.stopTitle')}</DialogTitle></DialogHeader>
          <DialogBody><DialogDescription>{t('knowledge.fillRun.stopWords')}</DialogDescription></DialogBody>
          <DialogFooter>
            <Button variant="default" size="default" disabled={busy} onClick={() => act('stop')} data-testid="stop-confirm">{t('knowledge.fillPage.stopConfirm')}</Button>
            <Button size="default" disabled={busy} onClick={() => setConfirming(false)}>{t('knowledge.fillPage.stopCancel')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
