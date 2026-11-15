/**
 * The home's repositories (madarch-64o5.85): the repositories the product connects stand on the home before any fill has
 * put them in the graph, read from the same answer the Sources page reads.
 */
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register({ url: 'http://localhost/' });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { i18n } = await import('../i18n.js');
const { RepositoriesSection } = await import('./repositories.js');
await i18n.changeLanguage('en');

afterAll(() => { GlobalRegistrator.unregister(); });

const context = {
  section: { id: 'repositories', component: 'repositories', params: {} },
  data: undefined, language: 'en', base: '', busy: false, variables: {}, open: () => undefined,
  reload: () => undefined, renderSection: () => null, product: 'shop', navigation: null, pageName: null,
} as never;

const requests: string[] = [];

beforeEach(() => {
  requests.length = 0;
  (globalThis as { EventSource?: unknown }).EventSource = undefined;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith('/api/sources')) {
      return new Response(JSON.stringify({
        documents: [],
        repositories: [{ name: null, present: true, filled: false }, { name: 'shop', present: true, filled: false }],
        truncated: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // The graph holds no repository yet; the section must not need it.
    return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
});

test('the connected repositories stand on the home before any fill reads the graph', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(RepositoriesSection, { context })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  try {
    const text = host.textContent ?? '';
    expect(text).toContain('the product repository');
    expect(text).toContain('shop');
    expect(text).toContain('On this machine');
    expect(text).toContain('Not filled');
    expect(host.querySelectorAll('[data-testid="home-repository"]')).toHaveLength(2);
    expect(requests.filter((url) => url.endsWith('/graphql'))).toHaveLength(0);
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
  }
});
