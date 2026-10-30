/**
 * The words a history figure is written in (madarch-u3vw.7): the page files an agent reads say the
 * same `1 commit` and `1 коммит` the app draws, so both read one numeral through one rule.
 *
 * The app keeps the same words in `wiki/app/src/locales/{en,ru}.json` under `knowledge.historyFigure`,
 * which is where its own text lives; `i18n.test.ts` holds the two copies to each other, so a word
 * changed on one side is changed on the other before the suite passes.
 */
import { contentLanguage, pluralForm } from './plural.js';

/** The figure kinds whose numeral is a count, so the word after it agrees with it: the app's `countedKinds`. */
export const COUNTED_FIGURES = [
  'symbols', 'commits', 'files', 'reachable', 'firstParent', 'merges', 'nonMerge', 'authors', 'both', 'onlyThis', 'onlyOther',
] as const;

export type CountedFigure = (typeof COUNTED_FIGURES)[number];

/** The four forms a counted figure takes, in grammatical order: one, few, many, other. */
type Forms = { one: string; few: string; many: string; other: string };

const WORDS: Record<'en' | 'ru', Record<CountedFigure, Forms>> = {
  en: {
    symbols: { one: '{{count}} symbol', few: '{{count}} symbols', many: '{{count}} symbols', other: '{{count}} symbols' },
    commits: { one: '{{count}} commit', few: '{{count}} commits', many: '{{count}} commits', other: '{{count}} commits' },
    files: { one: '{{count}} file', few: '{{count}} files', many: '{{count}} files', other: '{{count}} files' },
    reachable: { one: '{{count}} reachable commit', few: '{{count}} reachable commits', many: '{{count}} reachable commits', other: '{{count}} reachable commits' },
    firstParent: { one: '{{count}} first-parent commit', few: '{{count}} first-parent commits', many: '{{count}} first-parent commits', other: '{{count}} first-parent commits' },
    merges: { one: '{{count}} merge', few: '{{count}} merges', many: '{{count}} merges', other: '{{count}} merges' },
    nonMerge: { one: '{{count}} non-merge commit', few: '{{count}} non-merge commits', many: '{{count}} non-merge commits', other: '{{count}} non-merge commits' },
    authors: { one: '{{count}} author', few: '{{count}} authors', many: '{{count}} authors', other: '{{count}} authors' },
    both: { one: '{{count}} shared change', few: '{{count}} shared changes', many: '{{count}} shared changes', other: '{{count}} shared changes' },
    onlyThis: { one: '{{count}} change to this file alone', few: '{{count}} changes to this file alone', many: '{{count}} changes to this file alone', other: '{{count}} changes to this file alone' },
    onlyOther: { one: '{{count}} change to the other file alone', few: '{{count}} changes to the other file alone', many: '{{count}} changes to the other file alone', other: '{{count}} changes to the other file alone' },
  },
  ru: {
    symbols: { one: '{{count}} символ', few: '{{count}} символа', many: '{{count}} символов', other: '{{count}} символов' },
    commits: { one: '{{count}} коммит', few: '{{count}} коммита', many: '{{count}} коммитов', other: '{{count}} коммитов' },
    files: { one: '{{count}} файл', few: '{{count}} файла', many: '{{count}} файлов', other: '{{count}} файлов' },
    reachable: { one: '{{count}} достижимый коммит', few: '{{count}} достижимых коммита', many: '{{count}} достижимых коммитов', other: '{{count}} достижимых коммитов' },
    firstParent: { one: '{{count}} коммит основной линии', few: '{{count}} коммита основной линии', many: '{{count}} коммитов основной линии', other: '{{count}} коммитов основной линии' },
    merges: { one: '{{count}} слияние', few: '{{count}} слияния', many: '{{count}} слияний', other: '{{count}} слияний' },
    nonMerge: { one: '{{count}} коммит без слияний', few: '{{count}} коммита без слияний', many: '{{count}} коммитов без слияний', other: '{{count}} коммитов без слияний' },
    authors: { one: '{{count}} автор', few: '{{count}} автора', many: '{{count}} авторов', other: '{{count}} авторов' },
    both: { one: '{{count}} совместное изменение', few: '{{count}} совместных изменения', many: '{{count}} совместных изменений', other: '{{count}} совместных изменений' },
    onlyThis: { one: '{{count}} изменение только этого файла', few: '{{count}} изменения только этого файла', many: '{{count}} изменений только этого файла', other: '{{count}} изменений только этого файла' },
    onlyOther: { one: '{{count}} изменение только другого файла', few: '{{count}} изменения только другого файла', many: '{{count}} изменений только другого файла', other: '{{count}} изменений только другого файла' },
  },
};

export function isCountedFigure(kind: string): kind is CountedFigure {
  return (COUNTED_FIGURES as readonly string[]).includes(kind);
}

/**
 * One history figure as the app writes it: a counted kind in the words of `language` — `1 commit`,
 * `2 commits`, `1.5 коммита`, `21 коммит`, `11 коммитов` — and any other kind as its name and its
 * value, which is what the page files name.
 */
export function historyFigureText(figure: { kind: string; value: string }, language: string | undefined): string {
  if (!isCountedFigure(figure.kind)) return `${figure.kind}: ${figure.value}`;
  const count = Number(figure.value);
  const form = Number.isFinite(count) ? pluralForm(language, count) : 'other';
  const template = WORDS[contentLanguage(language)][figure.kind][form];
  const at = template.indexOf('{{count}}');
  return at === -1 ? template : `${template.slice(0, at)}${figure.value}${template.slice(at + '{{count}}'.length)}`;
}
