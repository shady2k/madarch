
/**
 * The top bar's «Заполнить…» press (decision 0031's frame, decision 0036 section 7): it opens the fill page, or the run
 * page while a run is live. What it reads is the product's command state, not a page's graph data.
 */
import { useEffect, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui/button.js';
import { readFillStatus, useChangeStream, useCommandRead, type FillStatusAnswer } from './command.js';
import { FILL_PAGE, runAddress } from '../address.js';

export function FillButton({ base, open }: { readonly base: string; readonly open: (path: string) => void }): ReactElement | null {
  const { t } = useTranslation();
  const status = useCommandRead<FillStatusAnswer>('fill-button-status', (signal) => readFillStatus(base, signal));
  useChangeStream(base, status.reload);
  const fill = status.data?.fill;
  const live = fill !== undefined && (fill.state === 'running' || fill.state === 'paused');
  // A run's end is a store fact the worker writes; the stream may miss it, so the press reads the state again, often
  // while a run is live and rarely when none is.
  useEffect(() => {
    const timer = setInterval(() => { status.reload(); }, live ? 3000 : 30_000);
    return () => { clearInterval(timer); };
  }, [live, status.reload]);
  if (status.data?.own === true) return null;
  const address = live && fill.runId !== undefined ? runAddress(fill.runId) : FILL_PAGE;
  return (
    <Button variant="default" size="default" data-testid="fill-button" onClick={() => open(address)}>
      {live ? (fill.state === 'paused' ? t('knowledge.fillPage.paused') : t('knowledge.fillRun.live')) : t('knowledge.fillRun.open')}
    </Button>
  );
}
