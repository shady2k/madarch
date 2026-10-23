/**
 * Names for statements (madarch-m38l.8): every statement of a page is named by
 * its footnote (`[^refund-window]`), and the name is its stable id in the
 * graph. The writer keeps a name an agent chose, generates a readable slug
 * from the sentence for a numbered footnote, and keeps the name a sentence
 * had in the page it replaces for as long as the sentence stands unchanged.
 */

const STOP_WORDS = new Set(['a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'and', 'or', 'with', 'that', 'this', 'as', 'from', 'when', 'which', 'each', 'every', 'one']);
const MAX_WORDS = 4;
const MAX_LENGTH = 40;

/** A footnote label that is only digits is a number, not a name. */
export const isNumbered = (label: string): boolean => /^\d+$/.test(label);

function words(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .match(/[a-z][a-z0-9]*/g) ?? [];
}

/** A readable name from a sentence; falls back to the words of a ground's label, then to "statement". Never purely digits. */
export function slugOf(sentence: string, hint = ''): string {
  for (const source of [sentence, hint]) {
    const chosen = words(source).filter((word) => !STOP_WORDS.has(word) && word.length > 1);
    if (chosen.length === 0) continue;
    let slug = '';
    for (const word of chosen.slice(0, MAX_WORDS)) {
      const next = slug === '' ? word : `${slug}-${word}`;
      if (next.length > MAX_LENGTH) break;
      slug = next;
    }
    if (slug !== '') return slug;
  }
  return 'statement';
}

/** What the writer knows of one statement of the page being written. */
export interface NamingItem {
  /** The sentence as a reader sees it (references removed). */
  readonly sentence: string;
  /** The footnote labels the agent wrote after it. */
  readonly labels: readonly string[];
  /** The label of the first ground, for the fallback slug. */
  readonly hint: string;
}

/** The sentence key used to match a sentence to the page it replaces: blanks collapsed, case kept. */
export const sentenceKey = (sentence: string): string => sentence.replace(/\s+/g, ' ').trim();

/**
 * The name of each statement, in order. A name the replaced page gave the
 * same sentence wins, then a name the agent chose, then a generated slug.
 * Names are unique within the page: a repeat gets "-2", "-3".
 */
export function nameStatements(items: readonly NamingItem[], previous: ReadonlyMap<string, string>): string[] {
  const taken = new Set<string>();
  const out: (string | undefined)[] = items.map(() => undefined);
  const claim = (index: number, wanted: string): boolean => {
    if (taken.has(wanted)) return false;
    taken.add(wanted);
    out[index] = wanted;
    return true;
  };
  items.forEach((item, index) => {
    const old = previous.get(sentenceKey(item.sentence));
    if (old !== undefined) claim(index, old);
  });
  items.forEach((item, index) => {
    if (out[index] !== undefined) return;
    const chosen = item.labels.find((label) => !isNumbered(label));
    if (chosen !== undefined) claim(index, chosen);
  });
  items.forEach((item, index) => {
    const wanted = out[index] !== undefined ? undefined : slugOf(item.sentence, item.hint);
    if (wanted === undefined) return;
    if (claim(index, wanted)) return;
    for (let n = 2; ; n += 1) if (claim(index, `${wanted}-${n}`)) return;
  });
  // A name an agent chose that another statement already holds is suffixed, never silently shared.
  return out.map((name, index) => {
    if (name !== undefined) return name;
    const base = items[index]!.labels.find((label) => !isNumbered(label)) ?? 'statement';
    for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`)) { taken.add(`${base}-${n}`); return `${base}-${n}`; }
  });
}
