/**
 * A person's «Пауза» and «Остановить» on a run that writes pages (madarch-m38l.17). A pause ends the run at the page it is
 * writing: that page is finished, the page after it is never taken up, and «Продолжить» starts the run that takes it up.
 * A stop ends the run now, and the answer to the press counts the pages this run already rewrote and says that they stay,
 * so the person presses twice and the second press is the one that ends it. Both stands are shown where the run is: on
 * the fill page and in the top bar's one popover, in one row that is one line wide at a phone's width.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.js';
import { pauseRun, startFill, stopRun } from './api.js';
import type { WikiStatus } from './types.js';

/** The run is under way: the code is being read or the agent is writing pages. */
export const runIsLive = (status: WikiStatus): boolean => status.fill.state === 'running' || status.writer.state === 'running' || status.writer.state === 'waiting';

/** A person paused the run, and it stands where it stopped until it is taken up. */
export const runIsPaused = (status: WikiStatus): boolean => status.fill.state === 'paused' || status.writer.state === 'paused';

/** A person stopped the run: it is over, and the pages it rewrote stand. */
export const runIsStopped = (status: WikiStatus): boolean => status.fill.state === 'stopped' || status.writer.state === 'stopped';

/** How many pages this run has already rewritten: the count a stop's words name. */
export const writtenPages = (status: WikiStatus): number => status.writer.units.filter((unit) => unit.state === 'written').length;

/**
 * The controls of one run: «Пауза» (or «Продолжить» for a run that stands paused) and «Остановить», the latter asking first
 * with the number of pages this run has already rewritten. Nothing is shown for a run that is not under way.
 */
export function RunControls({ status, refresh, where }: { status: WikiStatus; refresh: () => void; where: 'page' | 'menu' }): ReactElement | null {
  const { t } = useTranslation();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);
  // The question stands in the flow, below the press that asked it: it is brought into the window, so the words and the
  // second press stand in front of the person rather than under the fold.
  useEffect(() => {
    if (!asking) return;
    dialog.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [asking]);
  const live = runIsLive(status);
  const paused = runIsPaused(status);
  if (!live && !paused) return null;
  const written = writtenPages(status);
  const act = (work: () => Promise<unknown>): void => {
    setBusy(true);
    setRefused(null);
    work().then(
      () => { setBusy(false); setAsking(false); refresh(); },
      (failure: unknown) => { setBusy(false); setRefused(failure instanceof Error ? failure.message : String(failure)); },
    );
  };
  // «Продолжить» is the fill's own press: a run that takes up the page the paused one left, in the language the product keeps.
  const resume = (): void => act(() => startFill(status.writer.agent?.id ?? status.chosenAgent?.id ?? null));
  return (
    <div className={where === 'menu' ? 'mt-2' : 'mt-3'} data-testid="run-controls-block">
      <div className="flex flex-nowrap items-center gap-2" data-testid="run-controls" data-state={paused ? 'paused' : 'live'}>
        {paused
          ? <Button variant="default" size="default" disabled={busy} onClick={resume} data-testid="run-resume">{t('knowledge.fillPage.resume')}</Button>
          : <Button variant="default" size="default" disabled={busy} onClick={() => act(() => pauseRun())} data-testid="run-pause">{t('knowledge.fillPage.pause')}</Button>}
        <Button variant="ghost" size="default" disabled={busy} onClick={() => { setAsking(true); setRefused(null); }} data-testid="run-stop">{t('knowledge.fillPage.stop')}</Button>
      </div>
      {asking && (
        // In place, not in a portal: the dialog stands inside the popover or the card the person pressed in.
        <div ref={dialog} role="dialog" aria-modal="false" aria-label={t('knowledge.fillPage.stopTitle')} className="mt-2 rounded-[var(--radius-card)] border border-line p-3" data-testid="stop-dialog">
          <p className="mb-0 mt-0 text-small text-ink" data-testid="stop-dialog-words">{t('knowledge.fillPage.stopWords', { count: written })}</p>
          <div className="mt-2 flex flex-nowrap items-center gap-2">
            <Button variant="default" size="default" disabled={busy} onClick={() => act(() => stopRun())} data-testid="stop-confirm">{t('knowledge.fillPage.stopConfirm')}</Button>
            <Button variant="ghost" size="default" disabled={busy} onClick={() => setAsking(false)} data-testid="stop-cancel">{t('knowledge.fillPage.stopCancel')}</Button>
          </div>
        </div>
      )}
      {refused !== null && <p className="mb-0 mt-2 text-small" role="alert" data-testid="run-refused">{refused}</p>}
    </div>
  );
}
