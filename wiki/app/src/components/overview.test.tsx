/**
 * The home page's overview (madarch-64o5.83): the numbers stand only on a successful answer; a request that failed or has
 * not answered says so ("not known") instead of reporting zero problems or no fill as a fact.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register({ url: 'http://localhost/' });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { i18n } = await import('../i18n.js');
const { ProductOverviewSection } = await import('./overview.js');
await i18n.changeLanguage('en');

afterAll(() => { GlobalRegistrator.unregister(); });

const realFetch = globalThis.fetch;
const context = { section: { id: 'overview', component: 'product-overview', params: {} }, data: undefined, language: 'en', base: '/products/shop', busy: false, variables: {}, open: () => undefined, reload: () => undefined, renderSection: () => null, product: 'shop', navigation: null, pageName: null } as never;

async function render(): Promise<{ text: string; close: () => Promise<void> }> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(ProductOverviewSection, { context })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  return { text: (host.textContent ?? '').replace(/\s+/g, ' '), close: async () => { await act(async () => { root.unmount(); }); host.remove(); } };
}

beforeAll(() => {
  (globalThis as { fetch: typeof fetch }).fetch = (async () => new Response(JSON.stringify({ message: 'the store is closed' }), { status: 500 })) as unknown as typeof fetch;
});
afterAll(() => { (globalThis as { fetch: typeof fetch }).fetch = realFetch; });

test('a failed or unfinished answer says "not known", never zero and never "no fill"', async () => {
  const page = await render();
  try {
    expect(page.text).toContain('not known');
    expect(page.text).not.toContain('0 open problems');
    expect(page.text).not.toContain('No fill has run yet.');
  } finally { await page.close(); }
});

test('a successful answer carries the numbers', async () => {
  (globalThis as { fetch: typeof fetch }).fetch = (async (url: string | URL) => {
    const target = String(url);
    if (target.includes('/api/problems')) return new Response(JSON.stringify({ open: 7, closed: 0, dismissed: 0, sections: {} }), { status: 200 });
    return new Response(JSON.stringify({ runs: [{ runId: 'fill-1', state: 'succeeded', startedAt: '2026-11-15T02:09:29.000Z', finishedAt: null, elapsedMs: 60_000, units: [{}], publishedUnits: 1, selected: [], order: [], groups: [], events: [], records: 0, vertex: null, updatedAt: '2026-11-15T02:10:29.000Z', remainingMs: null, agentUsage: null }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const page = await render();
  try {
    expect(page.text).toContain('7 open problems');
    expect(page.text).toContain('Last fill');
    expect(page.text).not.toContain('not known');
  } finally { await page.close(); }
});

test('two readers of the same answer make one request and share one change stream', async () => {
  let problems = 0;
  let runs = 0;
  let streams = 0;
  class FakeSource {
    constructor() { streams += 1; }
    addEventListener(): void { /* the section only listens */ }
    close(): void { /* closed by the last reader */ }
  }
  (globalThis as { EventSource?: unknown }).EventSource = FakeSource as unknown as typeof EventSource;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    const answer = url.includes('/api/problems')
      ? (problems += 1, { open: 2, closed: 0, dismissed: 0, sections: {} })
      : url.includes('/api/fill-runs') ? (runs += 1, { runs: [] }) : {};
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement('div', null, createElement(ProductOverviewSection, { context }), createElement(ProductOverviewSection, { context }))); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  try {
    expect(problems).toBe(1);
    expect(runs).toBe(1);
    expect(streams).toBe(1);
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    (globalThis as { EventSource?: unknown }).EventSource = undefined;
  }
});
