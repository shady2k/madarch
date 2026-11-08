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

/** How far the bar stands: the run's own trace first (madarch-8bdc.2.5, item 2), then the phases. */
export function fillShare(fill: FillState): number {
  const progress = fill.progress;
  if (progress !== undefined && progress.planned > 0) return Math.min(1, progress.published / progress.planned);
  if (progress !== undefined && progress.spans > 0) return 0.1;
  if (fill.phase === 'code') return 0.3;
  if (fill.phase === 'history') return 0.75;
  if (fill.phase === 'points') return 0.9;
  const total = fill.commits ?? 0;
  return total === 0 ? 0.04 : Math.max(0.04, (fill.commit ?? 0) / total);
}

/** The words for the part of the fill a run reports by phase: the card's own line, before the trace speaks. */
export function fillPhaseWords(fill: FillState, t: Translate): string {
  const phase = phaseWords(fill, t);
  return fill.rebuilt === 'extractors-changed' ? `${t('knowledge.fillRebuiltExtractors')}. ${phase}` : phase;
}

export function fillWords(fill: FillState, t: Translate): string {
  // What the run's trace says it has done, where it says anything: the units it planned and
  // published, or the spans it has written so far. A run with no trace yet keeps the old words.
  const progress = fill.progress;
  if (progress !== undefined && progress.planned > 0) {
    return t('knowledge.repository.progressCounts', { published: progress.published, planned: progress.planned });
  }
  if (progress !== undefined && progress.spans > 0) {
    return t('knowledge.repository.fillSpans', { spans: progress.spans });
  }
  const phase = phaseWords(fill, t);
  return fill.rebuilt === 'extractors-changed' ? `${t('knowledge.fillRebuiltExtractors')}. ${phase}` : phase;
}
