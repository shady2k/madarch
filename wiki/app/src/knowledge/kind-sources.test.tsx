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

test('compact sources open an accessible list and Escape closes it', async () => {
  const box = document.createElement('div');
  document.body.append(box);
  const root = createRoot(box);
  try {
    await act(async () => { root.render(createElement(KindSources, { kind, compact: true })); });
    const inline = box.querySelector('[data-testid="kind-sources-inline"]')!;
    expect([...inline.querySelectorAll('a')].map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['C4 model', kind.sources![0]!], ['arc42', kind.sources![1]!],
    ]);
    const trigger = box.querySelector('button')!;
    expect(trigger.getAttribute('aria-label')).toBe('Standards and practices');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { trigger.click(); });
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect([...dialog.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual([...kind.sources!]);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { root.render(createElement(KindSources, { kind })); });
    expect(box.querySelector('button')).toBeNull();
    expect(box.querySelectorAll('li')).toHaveLength(2);
    await act(async () => { root.render(createElement(KindSources, { kind: { ...kind, sources: [] } })); });
    expect(box.textContent).toBe('');
  } finally {
    await act(async () => { root.unmount(); });
    box.remove();
  }
});


test('summary standards are fetched only on disclosure, with loading and error status', async () => {
  const savedFetch = globalThis.fetch;
  const box = document.createElement('div');
  document.body.append(box);
  const root = createRoot(box);
  const requested: string[] = [];
  let finish!: (response: Response) => void;
  globalThis.fetch = ((url: string) => {
    requested.push(url);
    return new Promise<Response>((resolve) => { finish = resolve; });
  }) as typeof fetch;
  try {
    const { sources, ...summary } = kind;
    await act(async () => { root.render(createElement(KindSources, { kind: { ...summary, sourcesAvailable: true }, compact: true })); });
    expect(requested).toEqual([]);
    await act(async () => { box.querySelector('button')!.click(); });
    expect(requested).toHaveLength(1);
    expect(new URL(requested[0]!, 'http://localhost').searchParams.get('kind')).toBe(kind.kind);
    expect(document.querySelector('[role="status"]')!.textContent).toBe('Loading…');
    await act(async () => { finish(new Response(JSON.stringify(kind))); });
    expect([...document.querySelectorAll('[role="dialog"] a')].map((link) => link.getAttribute('href'))).toEqual([...sources!]);
    await act(async () => { box.querySelector('button')!.click(); });
    await act(async () => { box.querySelector('button')!.click(); });
    await act(async () => { finish(new Response(JSON.stringify({ message: 'unavailable' }), { status: 503 })); });
    expect(document.querySelector('[role="status"]')!.textContent).toContain('The kind declaration is unavailable.');
  } finally {
    await act(async () => { root.unmount(); });
    box.remove();
    globalThis.fetch = savedFetch;
  }
});
