/**
 * The interface's two languages (decision 0031): one catalogue of words in both, a browser language read as the wiki's
 * own, and a choice that stays where the reader left it.
 */
import { describe, expect, test } from 'bun:test';
import en from './locales/en.json';
import ru from './locales/ru.json';
import { adoptProductLanguage, i18n, languageStorageKey, normalizeLanguage, setWikiLanguage } from './i18n.js';
import { PROBLEM_TEXT_CODES } from '../../../src/problems/types.js';

function leafKeys(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => leafKeys(child, prefix === '' ? key : `${prefix}.${key}`));
}

describe('the wiki\u2019s words', () => {
  test('English and Russian catalogues hold the same message keys', () => {
    expect(leafKeys(en).sort()).toEqual(leafKeys(ru).sort());
  });

  test('every problem sentence the engine can send has its words in both languages', () => {
    // The engine sends a code and its values (madarch-64o5.92); a code without a sentence in a catalogue would print
    // nothing on the page, so both catalogues are read for every code the engine declares.
    const words = (catalogue: typeof en, code: string): string | undefined => {
      const held = catalogue.loop.problemText as Record<string, string | undefined>;
      return held[code] ?? held[`${code}_other`];
    };
    for (const code of PROBLEM_TEXT_CODES) {
      expect([code, words(en, code) !== undefined]).toEqual([code, true]);
      expect([code, words(ru, code) !== undefined]).toEqual([code, true]);
    }
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

describe("the product's own language (madarch-64o5.84)", () => {
  test('a reader who saved no language opens the wiki in the product\'s; a saved choice stands', async () => {
    const storage = (() => { try { return globalThis.localStorage ?? null; } catch { return null; } })();
    storage?.clear();
    await setWikiLanguage('en');
    await adoptProductLanguage('ru');
    expect(normalizeLanguage(i18n.resolvedLanguage)).toBe('ru');
    // The reader then chooses English; with a place to keep the choice, the product no longer moves them. Without one
    // (a page that refuses storage) the current tab keeps its language anyway, and the next page asks again.
    await setWikiLanguage('en');
    if (storage !== null) {
      expect(storage.getItem(languageStorageKey)).toBe('en');
      await adoptProductLanguage('ru');
      expect(normalizeLanguage(i18n.resolvedLanguage)).toBe('en');
    }
    // And a product naming no language leaves the choice where it was.
    await setWikiLanguage('en');
    await adoptProductLanguage(undefined);
    expect(normalizeLanguage(i18n.resolvedLanguage)).toBe('en');
    try { globalThis.localStorage?.clear(); } catch { /* no storage */ }
  });
});

describe("a product's language is not the reader's preference (madarch-64o5.84)", () => {
  test('empty storage: a Russian product, then an English one, and the interface is English again', async () => {
    const storage = (() => { try { return globalThis.localStorage ?? null; } catch { return null; } })();
    storage?.clear();
    await adoptProductLanguage('ru');
    expect(normalizeLanguage(i18n.resolvedLanguage)).toBe('ru');
    // Adoption saves nothing: the next product's language speaks as if nothing had been chosen.
    if (storage !== null) expect(storage.getItem(languageStorageKey)).toBeNull();
    await adoptProductLanguage('en');
    expect(normalizeLanguage(i18n.resolvedLanguage)).toBe('en');
    if (storage !== null) expect(storage.getItem(languageStorageKey)).toBeNull();
  });

  test("a reader's own choice is still saved, and a product never overrides it", async () => {
    const storage = (() => { try { return globalThis.localStorage ?? null; } catch { return null; } })();
    storage?.clear();
    await setWikiLanguage('ru');
    if (storage === null) {
      // A page that refuses storage cannot remember a choice, so the product's language still applies here; nothing is
      // saved either way.
      await adoptProductLanguage('en');
      expect(storage).toBeNull();
      return;
    }
    expect(storage.getItem(languageStorageKey)).toBe('ru');
    await adoptProductLanguage('en');
    expect(normalizeLanguage(i18n.resolvedLanguage)).toBe('ru');
    // The instance is one per process: leave the next file an English wiki with no saved choice.
    storage.clear();
    await setWikiLanguage('en');
  });
});
