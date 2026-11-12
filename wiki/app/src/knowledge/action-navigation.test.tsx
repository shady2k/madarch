import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setWikiLanguage } from '../i18n.js';
import { FailureNote } from './errors.js';
import { WIKI_PROBLEMS } from './routes.js';

let root: Root | undefined;
beforeAll(() => GlobalRegistrator.register({ url: 'http://localhost/' }));
afterEach(() => { root?.unmount(); root = undefined; document.body.innerHTML = ''; });
afterAll(async () => {
  await new Promise((done) => setTimeout(done, 50));
  GlobalRegistrator.unregister();
});

for (const [language, destination] of [['en', 'Problems'], ['ru', 'Проблемы']] as const) {
  test(`failure navigation names its destination and details use a button in ${language}`, async () => {
    await setWikiLanguage(language);
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    root.render(createElement(FailureNote, { scope: 'writer', code: 'agent', message: 'Diagnostic detail' }));
    for (let n = 0; n < 100 && container.querySelector('a') === null; n++) await new Promise((done) => setTimeout(done, 10));
    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe(WIKI_PROBLEMS);
    expect(link?.textContent).toBe(destination);
    const details = container.querySelector<HTMLButtonElement>('[data-testid="failure-details"]');
    expect(details?.tagName).toBe('BUTTON');
    expect(details?.getAttribute('aria-expanded')).toBe('false');
    details?.click();
    for (let n = 0; n < 100 && container.querySelector('[data-testid="failure-detail"]') === null; n++) await new Promise((done) => setTimeout(done, 10));
    expect(details?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-testid="failure-detail"]')?.textContent).toBe('Diagnostic detail');
  });
}
