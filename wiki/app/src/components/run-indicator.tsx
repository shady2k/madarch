
/**
 * The top bar's run indicator (the design change of madarch-64o5.71): while a fill runs it says how far it is and opens
 * the runs page. Nothing is drawn when no run is live; the sidebar's «Запуски» is always the way in.
 */
import { useEffect, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui/button.js';
import { readFillRun, readFillStatus, useChangeStream, useCommandRead, type FillRunDetail, type FillStatusAnswer } from './command.js';
import { RUNS_PAGE } from '../address.js';

export function RunIndicator({ base, open }: { readonly base: string; readonly open: (path: string) => void }): ReactElement | null {
  const { t } = useTranslation();
  const status = useCommandRead<FillStatusAnswer>('fill-status', (signal) => readFillStatus(base, signal));
  const fill = status.data?.fill;
  const phase = fill?.runPhase ?? fill?.state;
  const requested = phase === 'queued' || phase === 'running' || phase === 'paused';
  const detail = useCommandRead<{ run: FillRunDetail }>(`fill-run:${fill?.runId ?? ''}`, (signal) => readFillRun(base, fill!.runId as string, signal), requested && fill?.runId !== undefined);
  // The status poll can lag the run's own end; the run's state is the one that says whether it is still going.
  const runPhase = detail.data?.run.phase;
  const runLive = runPhase === undefined || runPhase === 'queued' || runPhase === 'running' || runPhase === 'paused';
  const live = requested && runLive;
  useChangeStream(base, () => { status.reload(); detail.reload(); });
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => { status.reload(); detail.reload(); }, 1000);
    return () => { clearInterval(timer); };
  }, [live, status.reload, detail.reload]);
  if (status.data?.own === true) return null;
  // No live run: the «Заполнить…» entry stands beside this indicator; the indicator is drawn only while a run goes.
  if (fill === undefined || !live) return null;
  const done = detail.data?.run.publishedUnits;
  const total = detail.data?.run.units.length;
  const words = phase === 'paused'
    ? t('navigation.runPaused', { done: done ?? 0, total: total ?? 0 })
    : t('navigation.runGoing', { done: done ?? 0, total: total ?? 0 });
  return (
    <Button variant="default" size="default" data-testid="run-indicator" onClick={() => open(RUNS_PAGE)}>
      {words}
    </Button>
  );
}
