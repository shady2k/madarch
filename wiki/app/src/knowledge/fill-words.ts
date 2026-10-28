/**
 * What a running fill is doing, in words: the last commit's code first, then the history of every commit. A fill that
 * reports no phase (an older one) is told by the commit it has reached.
 */
import type { FillState } from './types.js';

export type Translate = (key: string, options?: Record<string, unknown>) => string;

function phaseWords(fill: FillState, t: Translate): string {
  if (fill.phase === 'code') return t('knowledge.fillPhaseCode');
  if (fill.phase === 'history') return t('knowledge.fillPhaseHistory', { count: fill.commits ?? 0 });
  if (fill.phase === 'points') return t('knowledge.fillPhasePoints');
  return t('knowledge.fillRunning', { commit: fill.commit ?? 0, commits: fill.commits ?? 0 });
}

/** How far the bar stands: the phases are two steps, and a fill without phases is the commits read. */
export function fillShare(fill: FillState): number {
  if (fill.phase === 'code') return 0.3;
  if (fill.phase === 'history') return 0.75;
  if (fill.phase === 'points') return 0.9;
  const total = fill.commits ?? 0;
  return total === 0 ? 0.04 : Math.max(0.04, (fill.commit ?? 0) / total);
}

export function fillWords(fill: FillState, t: Translate): string {
 const phase = phaseWords(fill,t);
 return fill.rebuilt === 'extractors-changed' ? `${t('knowledge.fillRebuiltExtractors')}. ${phase}` : phase;
}
