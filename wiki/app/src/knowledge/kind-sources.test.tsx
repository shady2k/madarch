import { afterAll, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { KindSources } from './kind-sources.js';
import { setWikiLanguage } from '../i18n.js';
import type { CatalogKindView } from './types.js';

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await setWikiLanguage('en');
});
afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  GlobalRegistrator.unregister();
});
const kind: CatalogKindView = { kind: 'example', subgroup: '', count: 0, page: true, filled: false, state: 'never', sources: ['https://c4model.com/abstractions', 'https://arc42.org/overview'] };

test('standards stay directly readable without a question-mark disclosure or a summary request', async () => {
  const box = document.createElement('div');
  document.body.append(box);
  const root = createRoot(box);
  try {
    await act(async () => { root.render(createElement(KindSources, { kind })); });
    expect(box.querySelector('button')).toBeNull();
    expect([...box.querySelectorAll('a')].map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['C4 model', kind.sources![0]!], ['arc42', kind.sources![1]!],
    ]);
    const { sources, ...summary } = kind;
    await act(async () => { root.render(createElement(KindSources, { kind: { ...summary, sourcesAvailable: true } })); });
    expect(box.querySelector('button')).toBeNull();
    expect(box.textContent).toBe('');
  } finally {
    await act(async () => { root.unmount(); });
    box.remove();
  }
});
