/**
 * A history block's notes in the reader's language (madarch-u3vw.7). Most of a note's counts are
 * the one i18next picks a form from; the notes that say how much of a longer list is shown take
 * that second count as a phrase of its own, so it agrees with its own numeral — «the first 1 is
 * shown», «показан первый» — rather than sitting in the sentence as a bare number.
 */
import type { HistoryNote } from './types.js';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** The notes whose `shown` count is said in words: the ones that name how much of the list is shown. */
const SHOWN_NOTES: readonly HistoryNote['key'][] = ['manyCommits', 'manyFiles'];

/** The phrase for the shown count: «показан первый» only of one, «показаны первые 21» of any other. */
function shownWords(count: number, t: Translate): string {
  // The verb agrees with «первые», which every numeral above one takes, so the form is picked by
  // the count being one rather than by the plural class of the noun (21 takes «показаны первые 21»).
  return t(`knowledge.historyNote.firstShown_${count === 1 ? 'one' : 'other'}`, { count });
}

/** The note's words, its own count picking the form and `shown` phrased for its numeral. */
export function historyNoteText(note: HistoryNote, t: Translate): string {
  const args = note.args ?? {};
  const shown = typeof args.shown === 'number' && SHOWN_NOTES.includes(note.key) ? shownWords(args.shown, t) : args.shown;
  return t(`knowledge.historyNote.${note.key}`, { ...args, ...(shown === undefined ? {} : { shown }), count: args.total ?? args.count ?? 0 });
}
