import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { pluralForm } from '../../../src/knowledge/plural.js';
import en from './locales/en.json';
import ru from './locales/ru.json';

export type WikiLanguage = 'en' | 'ru';
export const languageStorageKey = 'madarch-wiki-language';

export function normalizeLanguage(language: string | undefined): WikiLanguage {
  return language?.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

function initialLanguage(): WikiLanguage {
  try {
    const saved = globalThis.localStorage?.getItem(languageStorageKey);
    if (saved !== null && saved !== undefined) return normalizeLanguage(saved);
  } catch {
    // Storage may be unavailable in private contexts; the browser locale still works.
  }
  const preferred = typeof navigator === 'undefined'
    ? undefined
    : navigator.languages?.[0] ?? navigator.language;
  return normalizeLanguage(preferred);
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    ru: { translation: ru },
  },
  lng: initialLanguage(),
  fallbackLng: 'en',
  supportedLngs: ['en', 'ru'],
  interpolation: { escapeValue: false },
  returnNull: false,
});

/**
 * The form a count takes, from the one rule the page files read a numeral through as well
 * (madarch-u3vw.7). i18next asks `Intl.PluralRules` itself, which reports `other` for every
 * fraction, where Russian writes the genitive singular — «1.5 коммита»; `pluralForm` is that rule,
 * and every cardinal suffix is taken from it.
 */
const plurals = i18n.services.pluralResolver as { getSuffix(code: string, count: number, options?: { ordinal?: boolean }): string; options: { prepend: string } };
const suffixOf = plurals.getSuffix.bind(plurals);
plurals.getSuffix = (code: string, count: number, options?: { ordinal?: boolean }): string =>
  options?.ordinal === true || typeof count !== 'number' ? suffixOf(code, count, options) : `${plurals.options.prepend}${pluralForm(code, count)}`;

i18n.on('languageChanged', (language) => {
  try {
    globalThis.localStorage?.setItem(languageStorageKey, normalizeLanguage(language));
  } catch {
    // The current tab still changes language when persistence is unavailable.
  }
});

export async function setWikiLanguage(language: WikiLanguage): Promise<void> {
  await i18n.changeLanguage(language);
}




export { i18n };
