/**
 * The limits of one writer unit in the reader's language (madarch-u3vw.7): a count is a phrase
 * that agrees with its numeral — «30 turns», «1 ход» — so a limit of one never reads "1 turns".
 * The fragments sit in `knowledge.unitLimits`, and the sentences around them are the callers'.
 */
import type { WriterBounds } from './types.js';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** One phrase for each limit, each in the form of the numeral it names. */
export function unitLimitWords(bounds: WriterBounds, t: Translate): { turns: string; minutes: string; calls: string; attempts: string } {
  return {
    turns: t('knowledge.unitLimits.turns', { count: bounds.turns }),
    minutes: t('knowledge.unitLimits.minutes', { count: bounds.minutes }),
    calls: t('knowledge.unitLimits.calls', { count: bounds.toolCalls }),
    attempts: t('knowledge.unitLimits.attempts', { count: bounds.writeAttempts }),
  };
}
