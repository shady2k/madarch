/**
 * The plural forms the wiki's two languages write a count in (madarch-u3vw.7): the app and the
 * page files an agent reads pick the form here, so one numeral reads the same in both.
 *
 * The form is the CLDR category the numeral takes, save for one Russian rule: a count in
 * fractions takes the genitive singular, the form a whole 2, 3 or 4 takes — «1.5 коммита»,
 * never «1.5 коммитов» — where CLDR reports `other` for every fraction.
 */
export type PluralForm = 'one' | 'few' | 'many' | 'other';

/** The language the wiki writes its words in: Russian only when it is asked for by name. */
export function contentLanguage(language: string | undefined): 'en' | 'ru' {
  return language === 'ru' ? 'ru' : 'en';
}

/** The form a numeral takes in `language`. */
export function pluralForm(language: string | undefined, count: number): PluralForm {
  const code = contentLanguage(language);
  if (code === 'ru' && !Number.isInteger(count)) return 'few';
  return new Intl.PluralRules(code).select(count) as PluralForm;
}
