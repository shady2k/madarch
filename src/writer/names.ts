/**
 * Names for statements (madarch-m38l.8): every statement of a page is named by
 * its footnote (`[^refund-window]`), and the name is its stable id in the
 * graph. The writer keeps a name an agent chose, generates a readable slug
 * from the sentence for a numbered footnote, and keeps the name a sentence
 * had in the page it replaces for as long as the sentence stands unchanged.
 *
 * The words of a name are the language segmenter's word-like segments
 * (madarch-ztyq.12): there is no stop-word list and no regular expression over
 * the sentence. An unchanged sentence is matched by its stored key, so the
 * names of old pages survive the change; only a new sentence gets a new name.
 */

const MAX_WORDS = 4;
const MAX_LENGTH = 40;

/** A footnote label that is only digits is a number, not a name. */
export const isNumbered = (label: string): boolean => {
  if (label === '') return false;
  for (const character of label) if (character < '0' || character > '9') return false;
  return true;
};

const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u',
  ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** Cyrillic letters in Latin letters, so a Russian sentence still gives a readable ASCII name. */
function transliterate(text: string): string {
  let out = '';
  for (const letter of text.toLowerCase()) out += CYRILLIC[letter] ?? letter;
  return out;
}

/** Letters with their combining marks removed, without a regular expression. */
function fold(text: string): string {
  let out = '';
  for (const character of text.normalize('NFKD')) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x0300 && code <= 0x036f) continue;
    out += character;
  }
  return out;
}

/** `PaymentClientFactory` -> `Payment Client Factory`, without a regular expression. */
function splitCamel(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    const before = text[index - 1];
    const after = text[index + 1];
    const upper = character >= 'A' && character <= 'Z';
    const beforeLower = before !== undefined && ((before >= 'a' && before <= 'z') || (before >= '0' && before <= '9'));
    const beforeUpper = before !== undefined && before >= 'A' && before <= 'Z';
    const afterLower = after !== undefined && after >= 'a' && after <= 'z';
    if (current !== '' && upper && (beforeLower || (beforeUpper && afterLower))) {
      parts.push(current);
      current = '';
    }
    current += character;
  }
  if (current !== '') parts.push(current);
  return parts;
}

/** The ASCII letters and digits of a word; everything else is punctuation. */
function asciiWord(text: string): string {
  let out = '';
  for (const character of fold(transliterate(text))) {
    if ((character >= 'a' && character <= 'z') || (character >= '0' && character <= '9')) out += character;
  }
  return out;
}

function hasLetter(word: string): boolean {
  for (const character of word) if (character >= 'a' && character <= 'z') return true;
  return false;
}

const SEGMENTERS = new Map<string, Intl.Segmenter>();

function segmenterFor(language: string | undefined): Intl.Segmenter {
  const key = language ?? '';
  const held = SEGMENTERS.get(key);
  if (held !== undefined) return held;
  let segmenter: Intl.Segmenter;
  try {
    segmenter = new Intl.Segmenter(language, { granularity: 'word' });
  } catch {
    segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
  }
  SEGMENTERS.set(key, segmenter);
  return segmenter;
}

/** The words of a text, from the platform's segmenter; a word is what `isWordLike` says. */
function words(text: string, language: string | undefined): string[] {
  const out: string[] = [];
  for (const segment of segmenterFor(language).segment(text)) {
    if (!segment.isWordLike) continue;
    for (const part of splitCamel(segment.segment)) {
      const word = asciiWord(part);
      if (word.length > 1 && hasLetter(word)) out.push(word);
    }
  }
  return out;
}

/** A readable name from a sentence; falls back to the words of a ground's label, then to "statement". Never purely digits. */
export function slugOf(sentence: string, hint = '', language?: string): string {
  for (const source of [sentence, hint]) {
    const chosen = words(source, language);
    if (chosen.length === 0) continue;
    let slug = '';
    for (const word of chosen.slice(0, MAX_WORDS)) {
      const next = slug === '' ? word : `${slug}-${word}`;
      if (next.length > MAX_LENGTH) {
        if (slug === '') slug = word.slice(0, MAX_LENGTH);
        break;
      }
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
export const sentenceKey = (sentence: string): string => {
  let out = '';
  let blank = false;
  for (const character of sentence) {
    if (character.trim() === '') {
      blank = out !== '';
      continue;
    }
    if (blank) out += ' ';
    blank = false;
    out += character;
  }
  return out;
};

/**
 * The name of each statement, in order. A name the replaced page gave the
 * same sentence wins, then a name the agent chose, then a generated slug.
 * Names are unique within the page: a repeat gets "-2", "-3".
 */
export function nameStatements(items: readonly NamingItem[], previous: ReadonlyMap<string, string>, language?: string): string[] {
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
  // Each base keeps its own next suffix: trying 2, 3, ... again for every
  // colliding slug would make a page of shared first words quadratic.
  const nextSuffix = new Map<string, number>();
  const suffixed = (base: string): string => {
    let n = nextSuffix.get(base) ?? 2;
    while (taken.has(`${base}-${n}`)) n += 1;
    nextSuffix.set(base, n + 1);
    const name = `${base}-${n}`;
    taken.add(name);
    return name;
  };
  items.forEach((item, index) => {
    const wanted = out[index] !== undefined ? undefined : slugOf(item.sentence, item.hint, language);
    if (wanted === undefined) return;
    if (claim(index, wanted)) return;
    out[index] = suffixed(wanted);
  });
  // A name an agent chose that another statement already holds is suffixed, never silently shared.
  return out.map((name, index) => {
    if (name !== undefined) return name;
    const base = items[index]!.labels.find((label) => !isNumbered(label)) ?? 'statement';
    return suffixed(base);
  });
}
