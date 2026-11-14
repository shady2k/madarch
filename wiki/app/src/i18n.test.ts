/**
 * The interface's two languages (decision 0031): one catalogue of words in both, a browser language read as the wiki's
 * own, and a choice that stays where the reader left it.
 */
import { describe, expect, test } from 'bun:test';
import en from './locales/en.json';
import ru from './locales/ru.json';
import { i18n, languageStorageKey, normalizeLanguage, setWikiLanguage } from './i18n.js';

function leafKeys(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => leafKeys(child, prefix === '' ? key : `${prefix}.${key}`));
}

describe('the wiki\u2019s words', () => {
  test('English and Russian catalogues hold the same message keys', () => {
    expect(leafKeys(en).sort()).toEqual(leafKeys(ru).sort());
  });

  test('a browser language tag selects Russian only for ru', () => {
    expect(normalizeLanguage('ru-RU')).toBe('ru');
    expect(normalizeLanguage('ru')).toBe('ru');
    expect(normalizeLanguage('en-US')).toBe('en');
    expect(normalizeLanguage(undefined)).toBe('en');
  });

  test('the language switch changes the chrome and keeps the choice', async () => {
    const previous = i18n.resolvedLanguage ?? 'en';
    try {
      await setWikiLanguage('ru');
      expect(i18n.t('navigation.catalogue')).toBe('Каталог сущностей');
      expect(i18n.t('knowledge.rebuilding')).toContain('перестраивается');
      if (typeof globalThis.localStorage !== 'undefined') expect(globalThis.localStorage.getItem(languageStorageKey)).toBe('ru');
      await setWikiLanguage('en');
      expect(i18n.t('navigation.catalogue')).toBe('Entity catalogue');
      if (typeof globalThis.localStorage !== 'undefined') expect(globalThis.localStorage.getItem(languageStorageKey)).toBe('en');
    } finally {
      await setWikiLanguage(normalizeLanguage(previous));
    }
  });

  test('a Russian count in fractions takes the genitive singular', async () => {
    const previous = i18n.resolvedLanguage ?? 'en';
    try {
      await setWikiLanguage('ru');
      expect(i18n.t('knowledge.historyFigure.commits', { count: 1.5 })).toBe('1.5 коммита');
      expect(i18n.t('knowledge.historyFigure.commits', { count: 21 })).toBe('21 коммит');
    } finally {
      await setWikiLanguage(normalizeLanguage(previous));
    }
  });
});
