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
const NAVIGATION = {
  product: 'shop',
  groups: [],
  kinds: [{ kind: 'demo.file', one: 'File', many: 'Files', definition: null, taken: true, group: null, nav: null, count: 3, entryId: 'e1' }],
  purposes: [],
};
const opened: string[] = [];
const context = { section: { id: 'overview', component: 'product-overview', params: {} }, data: undefined, language: 'en', base: '/products/shop', busy: false, variables: {}, open: (path: string) => { opened.push(path); }, reload: () => undefined, renderSection: () => null, product: 'shop', navigation: NAVIGATION, pageName: null } as never;

/** One fill run as `/api/fill-runs` answers it, with the pieces the home reads. */
function runOf(over: Record<string, unknown>): Record<string, unknown> {
  return {
    runId: 'fill-1', state: 'running', phase: 'running', final: false, startedAt: '2026-11-15T02:09:29.000Z', finishedAt: null,
    elapsedMs: 60_000, units: [{}, {}], publishedUnits: 1, selected: ['demo.file'], order: ['demo.file'],
    groups: [{ kind: 'demo.file', group: 'code', plugin: 'disk', done: 2, total: 5, state: 'running', phase: 'running' }],
    events: [{ seq: 1, at: '2026-11-15T02:10:00.000Z', stage: '', unitId: 'disk:demo.file', type: 'unit-published', summary: 'disk:demo.file published 3 facts' }],
    records: 3, vertex: null, updatedAt: '2026-11-15T02:10:29.000Z', remainingMs: null, agentUsage: null,
    ...over,
  };
}

/** The three command answers the overview reads, over the answers a test names. */
function answers(runs: readonly Record<string, unknown>[], status: Record<string, unknown>): void {
  (globalThis as { fetch: typeof fetch }).fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/problems')) return new Response(JSON.stringify({ open: 1, closed: 0, dismissed: 0, sections: {} }), { status: 200 });
    // The frame's own live read (madarch-64o5.136): the bar and the card share it.
    if (url.includes('/api/status')) return new Response(JSON.stringify(status), { status: 200 });
    if (url.includes('/api/fill-runs')) return new Response(JSON.stringify({ run: runs[0] ?? null }), { status: 200 });
    // The three state reads come through the one read API (madarch-64o5.136 restore).
    if (url.includes('/graphql')) {
      const operation = typeof init?.body === 'string' ? (JSON.parse(init.body) as { query?: string }).query ?? '' : '';
      if (operation.includes('fillRuns')) return new Response(JSON.stringify({ data: { fillRuns: runs } }), { status: 200 });
      if (operation.includes('fillStatus')) return new Response(JSON.stringify({ data: { fillStatus: status } }), { status: 200 });
      if (operation.includes('fillPlan')) return new Response(JSON.stringify({ data: { fillPlan: { plugins: [{ name: 'disk', labels: { en: 'Disk', ru: 'Диск' } }], selectedKinds: [], requestedKinds: [], added: [], order: [], units: [], kinds: [], needsAgent: [], errors: [], skipped: [], pluginsOnly: true } } }), { status: 200 });
      if (operation.includes('products')) return new Response(JSON.stringify({ data: { products: { current: 'shop', products: [] } } }), { status: 200 });
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }) as unknown as typeof fetch;
}

async function render(): Promise<{ host: HTMLElement; text: string; close: () => Promise<void> }> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(ProductOverviewSection, { context })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  return { host, text: (host.textContent ?? '').replace(/\s+/g, ' '), close: async () => { await act(async () => { root.unmount(); }); host.remove(); } };
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
    return new Response(JSON.stringify({ data: { fillRuns: [{ runId: 'fill-1', state: 'succeeded', startedAt: '2026-11-15T02:09:29.000Z', finishedAt: null, elapsedMs: 60_000, units: [{}], publishedUnits: 1, selected: [], order: [], groups: [], events: [], records: 0, vertex: null, updatedAt: '2026-11-15T02:10:29.000Z', remainingMs: null, agentUsage: null }], fillStatus: { fill: { state: 'idle' }, filled: true } } }), { status: 200 });
  }) as unknown as typeof fetch;
  const page = await render();
  try {
    expect(page.text).toContain('7 open problems');
    expect(page.text).toContain('Last fill');
    expect(page.text).not.toContain('not known');
  } finally { await page.close(); }
});

test('a graph that holds part of a repository history offers the fill that reads the rest', async () => {
  opened.length = 0;
  answers([], { fill: { state: 'idle' }, filled: true, incomplete: true });
  const page = await render();
  try {
    expect(page.host.querySelector('[data-testid="overview-fill-incomplete"]')?.textContent).toContain('The fill is not finished');
    await act(async () => { (page.host.querySelector('[data-testid="overview-fill-continue"]') as HTMLButtonElement).click(); });
    expect(opened).toContain('/p/catalogue?select=1');
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
  let statusReads = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const operation = url.includes('/graphql') && typeof init?.body === 'string' ? (JSON.parse(init.body) as { query?: string }).query ?? '' : '';
    if (operation.includes('fillStatus')) statusReads += 1;
    const answer = url.includes('/api/problems')
      ? (problems += 1, { open: 2, closed: 0, dismissed: 0, sections: {} })
      : url.includes('/graphql') ? (runs += 1, { data: { fillRuns: [], fillStatus: { fill: { state: 'idle' }, filled: true } } }) : {};
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement('div', null, createElement(ProductOverviewSection, { context }), createElement(ProductOverviewSection, { context }))); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  try {
    expect(problems).toBe(1);
    expect(runs).toBe(2);
    expect(statusReads).toBe(1);
    expect(streams).toBe(1);
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    (globalThis as { EventSource?: unknown }).EventSource = undefined;
  }
});


test('a running fill states how far it is and the last thing it did, in the words of its run page', async () => {
  answers([runOf({})], { fill: { state: 'running' }, filled: true });
  const page = await render();
  try {
    expect(page.text).toContain('Filling · 1 of 2');
    // The bar and the card say one sentence from one key: the frame's own words for a running fill.
    expect(i18n.t('navigation.runGoing', { done: 1, total: 2 })).toContain('1 of 2');
    expect(page.host.querySelector('[data-testid="overview-fill-counts"]')?.textContent).toBe(i18n.t('navigation.runGoing', { done: 1, total: 2 }));
    expect(page.text).toContain('Filled: Files · Disk');
  } finally { await page.close(); }
});

test('a failed run stays with its retry until the reader dismisses it', async () => {
  answers([runOf({ runId: 'fill-failed', state: 'failed', phase: 'failed', final: true, finishedAt: '2026-11-15T02:11:00.000Z', groups: [{ kind: 'demo.file', group: 'code', plugin: 'disk', done: 0, total: 2, state: 'failed', phase: 'failed' }], events: [] })], { fill: { state: 'idle' }, filled: true });
  const page = await render();
  try {
    const alert = page.host.querySelector('[data-testid="overview-fill-failed"]');
    expect(alert?.textContent).toContain('The run failed.');
    expect(alert?.textContent).toContain('Retry the fill');
    await act(async () => { (page.host.querySelector('[data-testid="overview-fill-retry"]') as HTMLButtonElement).click(); });
    expect(opened).toContain('/p/catalogue?select=1');
    await act(async () => { (page.host.querySelector('[data-testid="overview-fill-dismiss"]') as HTMLButtonElement).click(); });
    expect(page.host.querySelector('[data-testid="overview-fill-failed"]')).toBeNull();
  } finally { await page.close(); }
});

