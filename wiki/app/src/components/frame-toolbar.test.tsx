/**
 * The top bar (decision 0036, section 7): the search asks the graph as the reader types, groups the answers by kind with
 * each result's title and its excerpt, says when nothing matches or the search failed, takes the field under Ctrl+K and
 * closes the answers on a press elsewhere; beside it stand the live run, madarch's own docs and the reader's controls.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { LiveRun } from '../components/run-indicator.js';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register({ url: 'http://localhost/' });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { EventSource?: unknown }).EventSource = undefined;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { FrameToolbar } = await import('../frame.js');

const { setWikiLanguage } = await import('../i18n.js');

beforeAll(async () => { await setWikiLanguage('en'); });
afterAll(() => { GlobalRegistrator.unregister(); });

/** A native value set, so React's value tracker sees the typed text. */
function type(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  descriptor?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const GROUPS = [{
  kind: 'demo.commit',
  label: 'Commits',
  count: 1,
  results: [{ node: { id: 'c1', kind: 'demo.commit', label: 'abcdef1234567890', template: 'entity' }, line: 'abcdef1 — Fix the thing', matched: 'Fix the thing' }],
}];

let answer: { data?: unknown; errors?: { message: string }[] } = { data: { searchGroups: GROUPS } };
const asked: string[] = [];

beforeEach(() => {
  asked.length = 0;
  answer = { data: { searchGroups: GROUPS } };
  (globalThis as { fetch: typeof fetch }).fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as { query: string };
    asked.push(body.query);
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
});

async function render(products: readonly { name: string; folder: string; own?: true }[] = [], current = 'shop', base = '', run: LiveRun = { live: false, run: null, own: false }): Promise<{ container: HTMLElement; opened: string[]; close: () => Promise<void> }> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const opened: string[] = [];
  await act(async () => {
    root.render(createElement(FrameToolbar, {
      base,
      language: 'en',
      role: 'developer',
      roles: ['developer'],
      busy: false,
      menu: null,
      open: (address: string) => { opened.push(address); },
      run,
      products,
      currentProduct: current,
      onLanguage: () => undefined,
      onRole: () => undefined,
      onReload: () => undefined,
    }));
  });
  return { container, opened, close: async () => { await act(async () => { root.unmount(); }); container.remove(); } };
}

async function settle(): Promise<void> {
  for (let at = 0; at < 20; at += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
}

test('Ctrl+K puts the field in hand from anywhere on the page', async () => {
  const page = await render();
  try {
    const field = page.container.querySelector('[data-testid="top-search"]') as HTMLInputElement;
    expect(document.activeElement).not.toBe(field);
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true })); });
    expect(document.activeElement).toBe(field);
  } finally {
    await page.close();
  }
});

test('the answers are grouped by kind, each with its title and the matched line under it', async () => {
  const page = await render();
  try {
    const field = page.container.querySelector('[data-testid="top-search"]') as HTMLInputElement;
    await act(async () => { type(field, 'fix'); });
    await settle();
    expect(asked[0]).toContain('searchGroups');
    expect(page.container.querySelector('[data-testid="search-results"]')).not.toBeNull();
    expect(page.container.querySelector('[data-testid="search-title"]')?.textContent).toBe('abcdef1234567890');
    expect(page.container.querySelector('[data-testid="search-excerpt"]')?.textContent).toBe('Fix the thing');
  } finally {
    await page.close();
  }
});

test('nothing found and a failed search each say so in the frame\'s words', async () => {
  const empty = await render();
  try {
    answer = { data: { searchGroups: [] } };
    const field = empty.container.querySelector('[data-testid="top-search"]') as HTMLInputElement;
    await act(async () => { type(field, 'zzz'); });
    await settle();
    expect(empty.container.querySelector('[data-testid="search-empty"]')?.textContent).toContain('Nothing matches “zzz”');
  } finally {
    await empty.close();
  }
  const failed = await render();
  try {
    answer = { errors: [{ message: 'the graph answered 500' }] };
    const field = failed.container.querySelector('[data-testid="top-search"]') as HTMLInputElement;
    await act(async () => { type(field, 'fix'); });
    await settle();
    expect(failed.container.querySelector('[data-testid="search-error"]')?.textContent).toContain('The search could not be read: the graph answered 500');
  } finally {
    await failed.close();
  }
});

test('a press anywhere else closes the answers and takes nothing the reader typed', async () => {
  const page = await render();
  try {
    const field = page.container.querySelector('[data-testid="top-search"]') as HTMLInputElement;
    await act(async () => { type(field, 'fix'); });
    await settle();
    expect(page.container.querySelector('[data-testid="search-results"]')).not.toBeNull();
    await act(async () => { document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
    expect(page.container.querySelector('[data-testid="search-results"]')).toBeNull();
    expect(field.value).toBe('fix');
  } finally {
    await page.close();
  }
});

test('at a phone\'s width the search stands behind its toggle, which opens the field over the bar', async () => {
  const page = await render();
  try {
    const toggle = page.container.querySelector('[data-testid="search-toggle"]') as HTMLButtonElement;
    expect(page.container.querySelector('[data-testid="search-box"]')?.getAttribute('data-open')).toBe('false');
    await act(async () => { toggle.click(); });
    expect(page.container.querySelector('[data-testid="search-box"]')?.getAttribute('data-open')).toBe('true');
    expect(document.activeElement).toBe(page.container.querySelector('[data-testid="top-search"]'));
  } finally {
    await page.close();
  }
});

test('the «?» opens madarch\'s own wiki when this server serves it beside the product in front', async () => {
  const page = await render([{ name: 'Shop', folder: 'shop' }, { name: 'Madarch', folder: 'madarch-wiki', own: true }]);
  try {
    const help = page.container.querySelector('[data-testid="help-link"]') as HTMLAnchorElement | null;
    expect(help?.getAttribute('href')).toBe('/products/madarch-wiki/');
    expect(help?.getAttribute('aria-label')).toBe('madarch documentation');
  } finally {
    await page.close();
  }
  const own = await render([{ name: 'Madarch', folder: 'madarch-wiki', own: true }], 'madarch-wiki');
  try {
    expect(own.container.querySelector('[data-testid="help-link"]')).toBeNull();
  } finally {
    await own.close();
  }
});

test('the product menu lists the served products, the one in front marked, and opens another', async () => {
  const page = await render([{ name: 'Shop', folder: 'shop' }, { name: 'Docs', folder: 'docs' }], 'shop', '/products/shop');
  try {
    const trigger = page.container.querySelector('[data-testid="product-menu"]') as HTMLElement | null;
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger!.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
      trigger!.click();
    });
    await settle();
    const items = [...document.querySelectorAll('[data-testid="product-choice"]')] as HTMLAnchorElement[];
    expect(items.map((one) => one.getAttribute('href'))).toEqual(['/products/shop/', '/products/docs/']);
    expect(items[0]?.getAttribute('aria-current')).toBe('true');
    expect(items[1]?.getAttribute('aria-current')).toBeNull();
  } finally {
    await page.close();
  }
});

test('the bar carries one fill control: the run while it goes, the press otherwise', async () => {
  const idle = await render();
  try {
    expect(idle.container.querySelectorAll('[data-testid="fill-entry"]')).toHaveLength(1);
    expect(idle.container.querySelectorAll('[data-testid="run-indicator"]')).toHaveLength(0);
  } finally { await idle.close(); }
  const live = await render([], 'shop', '', { live: true, own: false, run: { runId: 'fill-1', phase: 'running', publishedUnits: 0, units: [{}, {}] } as never });
  try {
    // The regression the owner named: two fill controls stand on the bar while a run goes.
    expect(live.container.querySelectorAll('[data-testid="fill-entry"]')).toHaveLength(0);
    expect(live.container.querySelectorAll('[data-testid="run-indicator"]')).toHaveLength(1);
    expect(live.container.querySelectorAll('[data-testid="fill-entry"], [data-testid="run-indicator"]')).toHaveLength(1);
  } finally { await live.close(); }
  const own = await render([], 'shop', '', { live: false, run: null, own: true });
  try {
    expect(own.container.querySelectorAll('[data-testid="fill-entry"], [data-testid="run-indicator"]')).toHaveLength(0);
  } finally { await own.close(); }
});
