import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
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

/** Format a real filesystem timestamp in the selected UI language. */
export function relativeTime(isoTime: string, language: string = i18n.resolvedLanguage ?? 'en', now = Date.now()): string {
  const timestamp = Date.parse(isoTime);
  if (!Number.isFinite(timestamp)) return '';
  const elapsedSeconds = (timestamp - now) / 1000;
  const absolute = Math.abs(elapsedSeconds);
  let divisor: number;
  let unit: Intl.RelativeTimeFormatUnit;
  if (absolute < 60) [divisor, unit] = [1, 'second'];
  else if (absolute < 60 * 60) [divisor, unit] = [60, 'minute'];
  else if (absolute < 24 * 60 * 60) [divisor, unit] = [60 * 60, 'hour'];
  else if (absolute < 30 * 24 * 60 * 60) [divisor, unit] = [24 * 60 * 60, 'day'];
  else if (absolute < 365 * 24 * 60 * 60) [divisor, unit] = [30 * 24 * 60 * 60, 'month'];
  else [divisor, unit] = [365 * 24 * 60 * 60, 'year'];
  return new Intl.RelativeTimeFormat(normalizeLanguage(language), { numeric: 'auto', style: 'short' })
    .format(Math.round(elapsedSeconds / divisor), unit);
}

export default i18n;
