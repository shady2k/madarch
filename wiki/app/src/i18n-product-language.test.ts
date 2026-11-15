/**
 * A product's language is not the reader's preference (madarch-64o5.84): adopting it changes the page and saves nothing,
 * so visiting a Russian product and then an English one in a browser that remembers no choice ends English.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register({ url: 'http://localhost/' });
const { adoptProductLanguage, i18n, languageStorageKey, normalizeLanguage, setWikiLanguage } = await import('./i18n.js');

beforeAll(() => { try { globalThis.localStorage.clear(); } catch { /* no storage */ } });
afterAll(async () => {
  // The i18n instance is one per process: the next test file reads English, as it wrote it before.
  try { globalThis.localStorage.clear(); } catch { /* no storage */ }
  await setWikiLanguage('en');
  GlobalRegistrator.unregister();
});

test('empty storage: a Russian product, then an English one, and the interface speaks English', async () => {
  expect(globalThis.localStorage).toBeDefined();
  globalThis.localStorage.clear();
  await adoptProductLanguage('ru');
  expect(normalizeLanguage(i18n.resolvedLanguage)).toBe('ru');
  // Nothing was saved: the next product's language is read as if no choice had ever been made.
  expect(globalThis.localStorage.getItem(languageStorageKey)).toBeNull();
  await adoptProductLanguage('en');
  expect(normalizeLanguage(i18n.resolvedLanguage)).toBe('en');
  expect(globalThis.localStorage.getItem(languageStorageKey)).toBeNull();
});

test("a reader's own choice is saved, and a product never overrides it", async () => {
  globalThis.localStorage.clear();
  await setWikiLanguage('ru');
  expect(globalThis.localStorage.getItem(languageStorageKey)).toBe('ru');
  await adoptProductLanguage('en');
  expect(normalizeLanguage(i18n.resolvedLanguage)).toBe('ru');
  expect(globalThis.localStorage.getItem(languageStorageKey)).toBe('ru');
});
