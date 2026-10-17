import { describe, expect, test } from 'bun:test';
import en from './locales/en.json';
import ru from './locales/ru.json';
import i18n, { languageStorageKey, normalizeLanguage, relativeTime, setWikiLanguage } from './i18n.js';

function leafKeys(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leafKeys(child, prefix === '' ? key : prefix + '.' + key),
  );
}

describe('wiki internationalization', () => {
  test('English and Russian catalogues have the same message keys', () => {
    expect(leafKeys(en).sort()).toEqual(leafKeys(ru).sort());
  });

  test('browser language tags select Russian only for ru and otherwise English', () => {
    expect(normalizeLanguage('ru-RU')).toBe('ru');
    expect(normalizeLanguage('ru')).toBe('ru');
    expect(normalizeLanguage('en-US')).toBe('en');
    expect(normalizeLanguage(undefined)).toBe('en');
  });

  test('the language choice changes chrome messages and persists when storage is available', async () => {
    const previous = i18n.resolvedLanguage ?? 'en';
    await setWikiLanguage('ru');
    expect(i18n.t('navigation.overview')).toBe('Обзор продукта');
    if (typeof globalThis.localStorage !== 'undefined') {
      expect(globalThis.localStorage.getItem(languageStorageKey)).toBe('ru');
    }
    await setWikiLanguage('en');
    expect(i18n.t('navigation.overview')).toBe('Product overview');
    if (typeof globalThis.localStorage !== 'undefined') {
      expect(globalThis.localStorage.getItem(languageStorageKey)).toBe('en');
    }
    await setWikiLanguage(normalizeLanguage(previous));
  });

  test('Russian word plurals follow 1 / 2 / 5 forms', async () => {
    await setWikiLanguage('ru');
    expect(i18n.t('units.word', { count: 1 })).toBe('слово');
    expect(i18n.t('units.word', { count: 2 })).toBe('слова');
    expect(i18n.t('units.word', { count: 5 })).toBe('слов');
    await setWikiLanguage('en');
  });

  test('Russian open-question counts follow 1 / 2 / 5 forms, as Intl.PluralRules names them', async () => {
    await setWikiLanguage('ru');
    expect(i18n.t('units.question', { count: 1 })).toBe('вопрос');
    expect(i18n.t('units.question', { count: 2 })).toBe('вопроса');
    expect(i18n.t('units.question', { count: 5 })).toBe('вопросов');
    const rules = new Intl.PluralRules('ru');
    expect(rules.select(1)).toBe('one');
    expect(rules.select(2)).toBe('few');
    expect(rules.select(5)).toBe('many');
    await setWikiLanguage('en');
    expect(i18n.t('units.question', { count: 1 })).toBe('question');
    expect(i18n.t('units.question', { count: 5 })).toBe('questions');
  });

  test('relative times use the selected locale formatter', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(relativeTime(new Date(now - 5 * 60_000).toISOString(), 'en', now)).toContain('5 min');
    expect(relativeTime(new Date(now - 5 * 60_000).toISOString(), 'ru', now)).toContain('5 мин');
  });

  test('Russian wizard work-unit counts follow 1 / 2 / 5 forms', async () => {
    await setWikiLanguage('ru');
    expect(i18n.t('wizard.readySummary', { agent: 'omp', count: 1 })).toBe('Готово к запуску с агентом omp, до 1 рабочей единицы.');
    expect(i18n.t('wizard.readySummary', { agent: 'omp', count: 2 })).toBe('Готово к запуску с агентом omp, до 2 рабочих единиц.');
    expect(i18n.t('wizard.readySummary', { agent: 'omp', count: 5 })).toBe('Готово к запуску с агентом omp, до 5 рабочих единиц.');
    await setWikiLanguage('en');
  });
});
