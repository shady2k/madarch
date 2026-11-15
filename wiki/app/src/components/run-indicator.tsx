/**
 * The top bar's run indicator (the design change of madarch-64o5.71): while a fill runs it says how far it is and opens
 * the runs page. Nothing is drawn when no run is live; the sidebar's «Запуски» is always the way in. The frame reads the
 * run once — its indicator and the sidebar's «+N still being written» counts are one answer — so this module holds the
 * read and the drawing apart.
 */
import { useEffect, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui/button.js';
import { readFillRun, readFillStatus, useChangeStream, useCommandRead, type FillRunDetail, type FillStatusAnswer } from './command.js';
import { RUNS_PAGE } from '../address.js';

/** The fill the frame sees: the run while one is live, and null when none is. */
export interface LiveRun {
  readonly live: boolean;
  readonly run: FillRunDetail | null;
}

/** The live run, read once for the whole frame: the top bar's indicator and the sidebar's pending counts. */
export function useLiveRun(base: string): LiveRun {
  const status = useCommandRead<FillStatusAnswer>('fill-status', (signal) => readFillStatus(base, signal));
  const fill = status.data?.fill;
  const phase = fill?.runPhase ?? fill?.state;
  const requested = phase === 'queued' || phase === 'running' || phase === 'paused';
  const detail = useCommandRead<{ run: FillRunDetail }>(`fill-run:${fill?.runId ?? ''}`, (signal) => readFillRun(base, fill!.runId as string, signal), requested && fill?.runId !== undefined);
  // The status poll can lag the run's own end; the run's state is the one that says whether it is still going.
  const runPhase = detail.data?.run.phase;
  const runLive = runPhase === undefined || runPhase === 'queued' || runPhase === 'running' || runPhase === 'paused';
  const live = requested && runLive && status.data?.own !== true;
  useChangeStream(base, () => { status.reload(); detail.reload(); });
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => { status.reload(); detail.reload(); }, 1000);
    return () => { clearInterval(timer); };
  }, [live, status.reload, detail.reload]);
  return { live, run: live ? detail.data?.run ?? null : null };
}

/** What the fill kind the run has left: the units of each kind it is still to write, for the sidebar's own counts. */
export function pendingByKind(run: FillRunDetail | null): Readonly<Record<string, number>> | undefined {
  if (run === null) return undefined;
  const pending: Record<string, number> = {};
  for (const group of run.groups) {
    const left = Math.max(0, group.total - group.done);
    if (left > 0) pending[group.kind] = (pending[group.kind] ?? 0) + left;
  }
  return pending;
}

/** The top bar's indicator: how far the live run is, as one press to the runs page. */
export function RunIndicator({ live, run, open }: { readonly live: boolean; readonly run: FillRunDetail | null; readonly open: (path: string) => void }): ReactElement | null {
  const { t } = useTranslation();
  if (!live) return null;
  const done = run?.publishedUnits ?? 0;
  const total = run?.units.length ?? 0;
  const words = run?.phase === 'paused'
    ? t('navigation.runPaused', { done, total })
    : t('navigation.runGoing', { done, total });
  return (
    <Button variant="default" size="default" data-testid="run-indicator" onClick={() => open(RUNS_PAGE)}>
      {words}
    </Button>
  );
}
