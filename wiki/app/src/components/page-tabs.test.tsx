/**
 * The bar of the window's open pages: each page by the name it gave itself, «Loading…» until it has one, the page in
 * front drawn as current, and a press on a tab's close that closes it (the middle button closes it too).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register({ url: 'http://localhost/' });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { PageTabs } = await import('./page-tabs.js');
const { setWikiLanguage } = await import('../i18n.js');

beforeAll(async () => { await setWikiLanguage('en'); });
afterAll(() => { GlobalRegistrator.unregister(); });

const TABS = [
  { key: 't1', address: '/', title: 'Shop' },
  { key: 't2', address: '/p/catalogue', title: null },
];

async function render(tabs = TABS, active = 't1'): Promise<{ container: HTMLElement; activated: string[]; closed: string[]; close: () => Promise<void> }> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const activated: string[] = [];
  const closed: string[] = [];
  await act(async () => {
    root.render(createElement(PageTabs, { tabs, active, activate: (key: string) => { activated.push(key); }, close: (key: string) => { closed.push(key); } }));
  });
  return { container, activated, closed, close: async () => { await act(async () => { root.unmount(); }); container.remove(); } };
}

test('each tab wears the name its page gave itself, and a page not yet named says it loads', async () => {
  const page = await render();
  try {
    const tabs = [...page.container.querySelectorAll('[data-testid="tab"]')];
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Shop', 'Loading…']);
    expect(tabs.map((tab) => tab.getAttribute('data-active'))).toEqual(['true', 'false']);
    expect(tabs.map((tab) => tab.querySelector('[role="tab"]')?.getAttribute('aria-selected'))).toEqual(['true', 'false']);
    expect(page.container.querySelector('[data-testid="tab-bar"]')?.getAttribute('aria-label')).toBe('Open pages');
  } finally {
    await page.close();
  }
});

test('a press on a tab brings it in front, and a press on its close closes it', async () => {
  const page = await render();
  try {
    const triggers = [...page.container.querySelectorAll('[data-testid="tab-trigger"]')] as HTMLButtonElement[];
    await act(async () => { triggers[1]?.click(); });
    expect(page.activated).toEqual(['t2']);
    const closes = [...page.container.querySelectorAll('[data-testid="tab-close"]')] as HTMLButtonElement[];
    expect(closes).toHaveLength(2);
    await act(async () => { closes[1]?.click(); });
    expect(page.closed).toEqual(['t2']);
  } finally {
    await page.close();
  }
});

test('the middle button on a tab closes it, and one tab alone has no close', async () => {
  const page = await render();
  try {
    const trigger = page.container.querySelectorAll('[data-testid="tab-trigger"]')[0] as HTMLButtonElement;
    await act(async () => { trigger.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true })); });
    expect(page.closed).toEqual(['t1']);
  } finally {
    await page.close();
  }
  const alone = await render([TABS[0]!]);
  try {
    expect(alone.container.querySelector('[data-testid="tab-close"]')).toBeNull();
  } finally {
    await alone.close();
  }
});
