/**
 * The home's first-run guide (madarch-64o5.133): a product that has a manifest and no successful fill shows what madarch
 * is, the three steps and the preparation wizard inline; a product that was filled shows no guide at all.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register({ url: 'http://localhost/' });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { EventSource?: unknown }).EventSource = undefined;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { i18n } = await import('../i18n.js');
const { FirstRunSection } = await import('./first-run.js');
await i18n.changeLanguage('en');

afterAll(() => { GlobalRegistrator.unregister(); });

const realFetch = globalThis.fetch;

const context = {
  section: { id: 'firstRun', component: 'first-run', params: {} },
  data: undefined,
  language: 'en',
  base: '/products/shop',
  busy: false,
  variables: {},
  open: () => undefined,
  reload: () => undefined,
  renderSection: () => null,
  product: 'shop',
  navigation: { product: 'shop', groups: [], kinds: [], purposes: [] },
  pageName: null,
} as never;

const PLAN = { plugins: [], selectedKinds: [], requestedKinds: [], added: [], order: [], units: [], kinds: [], needsAgent: [], errors: [], skipped: [], pluginsOnly: true };

const status = (answer: Record<string, unknown>): void => {
  (globalThis as { fetch: typeof fetch }).fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('/api/status')) return json(answer);
    if (url.includes('/api/agents')) return json({ agents: [], chosen: null });
    if (url.includes('/api/fill-plan')) return json({ plan: PLAN });
    if (url.includes('/api/product-settings')) return json({ product: { name: 'shop', id: 'p1' }, language: 'en', tokenCap: 200_000, bounds: {} });
    return json({});
  }) as unknown as typeof fetch;
};

async function render(): Promise<{ host: HTMLElement; text: string; close: () => Promise<void> }> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(FirstRunSection, { context })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  return {
    host,
    get text() { return (host.textContent ?? '').replace(/\s+/g, ' '); },
    close: async () => { await act(async () => { root.unmount(); }); host.remove(); },
  };
}

beforeAll(() => { status({ fill: { state: 'idle' }, filled: false, manifest: 'not-filled', manifestFile: '/products/shop/madarch/catalog.yaml', manifestGuide: 'https://example.invalid/guides/manifests' }); });
afterAll(() => { (globalThis as { fetch: typeof fetch }).fetch = realFetch; });

test('a product that has a manifest and no fill keeps the guide and the inline wizard', async () => {
  status({ fill: { state: 'idle' }, filled: false, manifest: 'not-filled', manifestFile: '/products/shop/madarch/catalog.yaml', manifestGuide: 'https://example.invalid/guides/manifests' });
  const page = await render();
  try {
    expect(page.text).toContain('Madarch is the wiki of this product');
    expect(page.text).toContain('Check the set of kinds the wiki should hold.');
    expect(page.host.querySelector('[data-testid="first-run"]')).not.toBeNull();
    expect(page.host.querySelector('[data-testid="first-run-manifest-file"]')).toBeNull();
  } finally { await page.close(); }
});

test('a product that was filled offers no first-run guide at all', async () => {
  status({ fill: { state: 'idle' }, filled: true, manifest: 'ok', manifestFile: '/products/shop/madarch/catalog.yaml', manifestGuide: 'https://example.invalid/guides/manifests' });
  const page = await render();
  try {
    expect(page.host.querySelector('[data-testid="first-run"]')).toBeNull();
  } finally { await page.close(); }
});
