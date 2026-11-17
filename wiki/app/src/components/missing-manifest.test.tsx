/**
 * The home of a product that has no kinds manifest (madarch-64o5.133): the card names the product, says the graph is
 * empty, names the file a fill would read and links the guide that writes one.
 */
import { afterAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register({ url: 'http://localhost/' });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { i18n } = await import('../i18n.js');
const { MissingManifest } = await import('./missing-manifest.js');
await i18n.changeLanguage('en');

afterAll(() => { GlobalRegistrator.unregister(); });

const STATUS = {
  fill: { state: 'idle' },
  filled: false,
  manifest: 'no-manifest' as const,
  manifestFile: '/products/draft/madarch/catalog.yaml',
  manifestGuide: 'https://example.invalid/guides/manifests',
};

async function render(status: typeof STATUS | null): Promise<{ host: HTMLElement; close: () => Promise<void> }> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(MissingManifest, { product: 'draft', status })); });
  return { host, close: async () => { await act(async () => { root.unmount(); }); host.remove(); } };
}

test('a product with no manifest names the product, the empty graph, the file and the guide', async () => {
  const page = await render(STATUS);
  try {
    expect(page.host.querySelector('[data-testid="missing-manifest-product"]')?.textContent).toBe('draft');
    expect(page.host.textContent).toContain('The product was created');
    expect(page.host.querySelector('[data-testid="missing-manifest-what"]')?.textContent).toBe('The graph is empty. The product has no kinds manifest yet, so a fill has nothing to read.');
    expect(page.host.querySelector('[data-testid="missing-manifest-file"]')?.textContent).toBe('Its manifest is /products/draft/madarch/catalog.yaml.');
    const guide = page.host.querySelector('[data-testid="missing-manifest-guide"]');
    expect(guide?.getAttribute('href')).toBe('https://example.invalid/guides/manifests');
    expect(guide?.textContent).toBe("How to write a product's manifests");
  } finally { await page.close(); }
});

test('an answer that has not arrived names what it knows and invents no file', async () => {
  const page = await render(null);
  try {
    expect(page.host.textContent).toContain('The product was created');
    expect(page.host.querySelector('[data-testid="missing-manifest-file"]')).toBeNull();
    expect(page.host.querySelector('[data-testid="missing-manifest-guide"]')).toBeNull();
  } finally { await page.close(); }
});
