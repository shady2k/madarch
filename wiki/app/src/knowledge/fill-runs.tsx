import { useEffect, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from '@/components/ui/alert.js';
import { Button } from '@/components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.js';
import { Disclosure, DisclosureSummary } from '@/components/ui/disclosure.js';
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogHeader, DialogFooter, DialogBody } from '@/components/ui/dialog.js';
import { Progress } from '@/components/ui/progress.js';
import { PageSection, PageHeader, PageTitle, Paragraph, Stack, PlainList, ListItem } from '@/components/ui/typography.js';
import { controlFillRun, getCatalog, getFillRun, getFillRuns } from './api.js';
import { KLink } from './blocks.js';
import { useRead } from './live.js';
import { addressOfFillRun, addressOfKind, WIKI_FILL } from './routes.js';
import { PageSkeleton } from './skeleton.js';
import { RunDiagnostics } from './repository.js';
import { useTabTitle } from './tabs.js';
import type { SelectionRun } from './types.js';

export function FillHistory({ version = 0 }: { version?: number }): ReactElement {
  const { t, i18n } = useTranslation();
  const { data, error } = useRead('fill-history', version, getFillRuns);
  return <PageSection data-testid="fill-history">
    <PageHeader><PageTitle>{t('knowledge.fillRun.history')}</PageTitle></PageHeader>
    {error !== null && <Alert><AlertDescription>{error}</AlertDescription></Alert>}
    {data === null ? <PageSkeleton testId="fill-runs-loading" /> : data.runs.length === 0 ? <Paragraph>{t('knowledge.fillRun.noHistory')}</Paragraph> : <PlainList>
      {data.runs.map((run) => <ListItem key={run.runId} className="mb-3" data-testid="fill-history-run">
        <KLink href={addressOfFillRun(run.runId)}>{new Date(run.startedAt).toLocaleString(i18n.resolvedLanguage)}</KLink>
        <Paragraph className="m-0 text-small">{(run.selected ?? run.summary?.selection?.kinds)?.join(', ') ?? t('knowledge.fillRun.selectionUnknown')}{run.vertex !== null && ` · ${run.vertex}`} · {t(`knowledge.fillRun.state.${run.state}`, { defaultValue: run.state })}</Paragraph>
        <Stack className="flex flex-wrap gap-3 text-small">{run.groups.map((group) => <KLink key={`${group.kind}:${group.plugin}`} href={addressOfKind(group.kind)}>{group.kind}</KLink>)}</Stack>
      </ListItem>)}
    </PlainList>}
  </PageSection>;
}

function RunActions({ run, refresh }: { run: SelectionRun; refresh: () => void }): ReactElement | null {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  if (!['created', 'planning', 'running', 'pausing', 'paused', 'cancelling'].includes(run.state)) return null;
  const act = (action: 'pause' | 'stop'): void => {
    setBusy(true); setFailure(null);
    controlFillRun(run.runId, action).then(() => { setBusy(false); setConfirming(false); refresh(); }, (error: unknown) => { setBusy(false); setFailure(error instanceof Error ? error.message : String(error)); });
  };
  return <Stack className="mt-4" data-testid="fill-run-controls">
    <Stack className="flex gap-2">
      {run.state === 'running' && <Button variant="default" size="default" disabled={busy} onClick={() => act('pause')} data-testid="run-pause">{t('knowledge.fillPage.pause')}</Button>}
      <Button size="default" disabled={busy || run.state === 'cancelling'} onClick={() => setConfirming(true)} data-testid="run-stop">{t('knowledge.fillPage.stop')}</Button>
    </Stack>
    <Dialog open={confirming} onOpenChange={(open) => { if (!busy) setConfirming(open); }}><DialogContent data-testid="stop-dialog" closeLabel={t('knowledge.fillPage.stopCancel')} closeDisabled={busy} onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>{t('knowledge.fillPage.stopTitle')}</DialogTitle></DialogHeader>
      <DialogBody><DialogDescription>{t('knowledge.fillRun.stopWords')}</DialogDescription></DialogBody>
      <DialogFooter><Button variant="default" size="default" disabled={busy} onClick={() => act('stop')} data-testid="stop-confirm">{t('knowledge.fillPage.stopConfirm')}</Button>
      <Button size="default" disabled={busy} onClick={() => setConfirming(false)}>{t('knowledge.fillPage.stopCancel')}</Button></DialogFooter>
    </DialogContent></Dialog>
    {failure !== null && <Paragraph role="alert">{failure}</Paragraph>}
  </Stack>;
}

export function SelectionRunPage({ runId, version, refresh }: { runId: string; version: number; refresh: () => void }): ReactElement {
  const { t, i18n } = useTranslation();
  const { data, error } = useRead(`fill-run:${runId}`, version, (signal) => getFillRun(runId, signal));
  const [now, setNow] = useState(Date.now());
  const running = data !== null && ['created', 'planning', 'running', 'pausing', 'cancelling'].includes(data.run.state);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const catalog = useRead('fill-run-catalog', 0, getCatalog).data;
  useTabTitle(t('knowledge.fillRun.title'));
  if (error !== null) return <Alert variant="problem"><AlertDescription>{error}</AlertDescription></Alert>;
  if (data === null) return <PageSkeleton testId="fill-runs-loading" />;
  const run = data.run;
  const done = run.publishedUnits;
  const terminal = ['succeeded', 'failed', 'cancelled', 'completed_partial'].includes(run.state);
  const emptyWords = t(terminal ? 'knowledge.fillRun.noUnits' : 'knowledge.fillRun.planning');
  const language = (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  const seconds = (ms: number): number => Math.round(ms / 1000);
  return <PageSection data-testid="fill-run-page" data-run={run.runId}>
    <PageHeader><PageTitle>{t('knowledge.fillRun.title')}</PageTitle>
      <Paragraph>{new Date(run.startedAt).toLocaleString(i18n.resolvedLanguage)} · {t(`knowledge.fillRun.state.${run.state}`, { defaultValue: run.state })}</Paragraph>
      <Paragraph data-testid="fill-run-selection">{(run.selected ?? run.summary?.selection?.kinds)?.join(', ') ?? t('knowledge.fillRun.selectionUnknown')}{run.vertex !== null && ` · ${run.vertex}`}</Paragraph>
      {run.finishedAt !== null && <Paragraph data-testid="fill-run-finished">{t('knowledge.fillPage.finished', { time: new Date(run.finishedAt).toLocaleString(language) })}</Paragraph>}
    </PageHeader>
    <Card className="mb-6"><CardHeader><CardTitle>{run.units.length === 0 ? emptyWords : t('knowledge.fillRun.count', { done, total: run.units.length })}</CardTitle></CardHeader><CardContent>
      {run.units.length > 0 && <Progress value={done} max={run.units.length} aria-label={t('knowledge.fillRun.count', { done, total: run.units.length })} />}
      <Paragraph data-testid="fill-run-time">{t('knowledge.fillRun.elapsed', { seconds: seconds(running ? Math.max(run.elapsedMs, now - new Date(run.startedAt).getTime()) : run.elapsedMs) })} · {run.remainingMs === null ? t('knowledge.fillRun.remainingUnknown') : t('knowledge.fillRun.remaining', { seconds: seconds(run.remainingMs) })}</Paragraph>
      <Paragraph data-testid="fill-run-tokens">{run.agentUsage === null ? t('knowledge.fillRun.tokensUnknown') : t('knowledge.fillRun.tokens', { input: run.agentUsage.inputTokens, output: run.agentUsage.outputTokens, total: run.agentUsage.totalTokens })}</Paragraph>
      <Paragraph data-testid="fill-run-records">{t('knowledge.fillRun.records', { count: run.records })}</Paragraph>
      <RunActions key={run.runId} run={run} refresh={refresh} />
    </CardContent></Card>
    <PlainList data-testid="fill-run-groups">{run.groups.map((group) => {
      const kind = catalog?.kinds.find((kind) => kind.kind === group.kind);
      const section = catalog?.groups.find((section) => section.group === group.group);
      return <ListItem key={`${group.kind}:${group.plugin}`} className="mb-3" data-testid="fill-run-group">
        <Paragraph className="m-0">{section?.labels[language] ?? group.group} · {kind?.labels?.[language]?.many ?? group.kind} · {group.plugin}</Paragraph>
        <Paragraph className="m-0 text-small">{group.total === 0 ? emptyWords : t('knowledge.fillRun.count', { done: group.done, total: group.total })} · {t(`knowledge.fillRun.state.${group.state}`, { defaultValue: group.state })}</Paragraph>
        {group.total > 0 && <Progress value={group.done} max={group.total} aria-label={kind?.labels?.[language]?.many ?? group.kind} />}
      </ListItem>;
    })}</PlainList>
    <Disclosure className="mt-6" data-testid="fill-run-log"><DisclosureSummary>{t('knowledge.fillRun.log')}</DisclosureSummary>
      <PlainList>{run.events.map((event) => <ListItem key={event.seq}>{new Date(event.at).toLocaleTimeString(i18n.resolvedLanguage)} · {event.summary}</ListItem>)}</PlainList>
    </Disclosure>
    {run.summary !== undefined && <RunDiagnostics run={run.summary} />}
    <Paragraph><KLink href={WIKI_FILL}>{t('knowledge.fillRun.back')}</KLink></Paragraph>
  </PageSection>;
}
