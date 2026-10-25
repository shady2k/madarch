import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setWikiLanguage } from '../i18n.js';
import { HistoryBar } from './history-bar.js';
import type { HistoryContext } from './types.js';

let root: Root | undefined;
beforeAll(() => GlobalRegistrator.register({ url: 'http://localhost/k/e/code.file%3Aindex.ts' }));
afterEach(() => { root?.unmount(); root = undefined; document.body.innerHTML = ''; });
afterAll(() => GlobalRegistrator.unregister());
for (const language of ['en', 'ru'] as const) test(`unfilled date and bounded landmark evidence remain explicit in ${language}`, async () => {
  await setWikiLanguage(language);
  const history: HistoryContext = { repo: 'sample', at: '2026-02-02', coverage: 'unfilled', commit: 'abc', effectiveAt: '2026-02-02T00:00:00Z', until: null,
    points: [{ name: 'refs/tags/arbitrary', commit: 'abc', covered: false }],
    landmarks: { offered: 67, covered: 2, limit: 64, overflow: true, omitted: 2, first: '2026-02-01T00:00:00Z', last: '2026-02-03T00:00:00Z', diagnostics: [{ ref: 'refs/tags/side', object: 'side-object', reason: 'outside first-parent ancestry' }] } };
  const container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  root.render(createElement(HistoryBar, { history }));
  for (let tries = 0; tries < 100 && container.querySelector('[data-testid="history-landmarks"]') === null; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(container.querySelector('[data-coverage="unfilled"]')).not.toBeNull();
  const text = container.textContent!;
  expect(text).toContain('64'); expect(text).toContain('67'); expect(text).toContain('refs/tags/side');
  expect(text).toContain(language === 'en' ? 'No current code is substituted.' : 'Текущий код не подставляется.');
  expect(text).toContain(language === 'en' ? 'not necessarily covered' : 'не обязательно прочитаны');
});
