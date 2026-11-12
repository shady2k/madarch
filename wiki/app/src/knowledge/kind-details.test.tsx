import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setWikiLanguage } from '../i18n.js';
import { KindPage } from './pages.js';
import { KindDetails } from './kind-details.js';
import { KindLabels } from './kind-names.js';
import { localeKeyIn, renderedText } from '../../test/locale-keys.js';
import type { CatalogKindView, CatalogView } from './types.js';

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  await setWikiLanguage('en');
});
afterAll(async () => {
  await new Promise((rest) => setTimeout(rest, 50));
  GlobalRegistrator.unregister();
});
let root: Root | undefined;
afterEach(() => {
  root?.unmount();
  root = undefined;
  document.body.innerHTML = '';
  delete (globalThis as { fetch?: unknown }).fetch;
});
function into(element: ReturnType<typeof createElement>): HTMLElement {
  const box = document.createElement('div');
  document.body.appendChild(box);
  root = createRoot(box);
  root.render(element);
  return box;
}
async function until(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (check()) return;
    await new Promise((step) => setTimeout(step, 10));
  }
  throw new Error(`never came to ${what}: ${document.body.innerHTML.slice(-2500)}`);
}
const kind = (id: string, extra: Partial<CatalogKindView> = {}): CatalogKindView => ({
  kind: id, subgroup: '', count: 1, page: true, filled: true, state: 'filled', ...extra,
});
const CATALOG: CatalogView = {
  product: { name: 'shop', id: 'p1' }, language: 'en', groups: [], findings: [],
  kinds: [
    kind('code.file'),
    kind('doc.term', {
      labels: { en: { one: 'Term', many: 'Terms' } }, descriptions: { en: 'A word with one agreed meaning.' },
      sources: ['https://example.test/standard'],
      pluginFolders: ['plugins/glossary'],
      dependsOn: ['code.file'], state: 'partial', turn: 'failed',
      declaration: { file: 'madarch/kinds.yaml', line: 12 },
      fields: [{ name: 'definition', labels: { en: 'Definition', ru: 'Определение' }, declaration: { file: 'madarch/kinds.yaml', line: 18 }, type: 'text' }, { name: 'parent', type: 'text', nullable: true, reference: 'doc.term' }],
      relations: [{ direction: 'out', name: 'defined_in', kind: 'code.file' }, { direction: 'in', name: 'uses', kind: 'doc.rule' }],
    }),
    kind('doc.rule', { dependsOn: ['doc.term'] }),
    kind('unrelated'),
  ],
};
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
function stub(catalog: CatalogView | null): void {
  (globalThis as { fetch?: unknown }).fetch = async (url: string) => {
    if (url.includes('/api/catalog')) {
      if (catalog === null) return json({ message: 'unavailable' }, 503);
      const asked = new URL(url, 'http://localhost').searchParams.get('kind');
      if (asked !== null) return json(catalog.kinds.find((entry) => entry.kind === asked));
      return json({ ...catalog, kinds: catalog.kinds.map(({ fields, relations, sources, ...entry }) => entry) });
    }
    if (url.includes('/api/entities')) return json({ kind: 'doc.term', total: 1, rows: [{ id: 'doc.term:order', kind: 'doc.term', label: 'Order', href: '/e/doc.term%3Aorder' }], next: null });
    if (url.includes('/api/views')) return json({ renderer: 'mermaid', views: [] });
    return json({ message: 'not here' }, 404);
  };
}

test('the kind page combines its declaration, both relation directions, focused graph and existing records', async () => {
  stub(CATALOG);
  const page = into(createElement(KindPage, { kind: 'doc.term', version: 0 }));
  await until(() => page.querySelector('[data-testid="kind-details"]') !== null && page.querySelector('[data-entity="doc.term:order"]') !== null, 'details and records');
  expect(page.querySelectorAll('h1')).toHaveLength(1);
  expect(page.querySelector('[data-testid="kind-meaning"]')!.textContent).toBe('A word with one agreed meaning.');
  expect(page.querySelector('a[href="https://example.test/standard"]')).not.toBeNull();
  expect(page.querySelector('[data-testid="kind-fields"]')!.textContent).toContain('Definition');
  expect(page.querySelector('[data-testid="kind-declaration"]')?.textContent).toBe('madarch/kinds.yaml:12');
  expect(page.querySelector('[data-testid="kind-fields"]')!.textContent).toContain('madarch/kinds.yaml:18');
  expect(page.querySelector('[data-testid="kind-fields"]')!.textContent).toContain('text | null');
  expect(page.querySelector('[data-testid="kind-fields"]')!.textContent).toContain('Untranslated field');
  expect(page.querySelector('[data-testid="kind-fields"]')!.textContent).not.toContain('parent');
  expect(page.querySelector('[data-kind="doc.term"] [data-testid="dependency-plugin"]')!.textContent).toBe('plugins/glossary');
  expect(page.querySelector('[data-testid="kind-relations"] [data-direction="out"]')!.textContent).toContain('defined_in →');
  expect(page.querySelector('[data-testid="kind-relations"] [data-direction="in"]')!.textContent).toContain('← uses');
  expect(page.querySelector('[data-testid="kind-producer"]')!.textContent).toBe('plugins/glossary');
  expect(page.querySelector('[data-testid="kind-state"]')!.textContent).toBe('Failed');
  expect([...page.querySelectorAll('[data-testid="dependency-node"]')].map((node) => node.getAttribute('data-kind'))).toEqual(['code.file', 'doc.term', 'doc.rule']);
  expect(page.querySelector('[data-testid="dependency-node"][data-kind="doc.term"]')!.getAttribute('data-chosen')).toBe('true');
  expect(page.querySelector('[data-entity="doc.term:order"]')!.textContent).toContain('Order');
  expect(localeKeyIn(renderedText(page))).toBeUndefined();
});

test('records remain usable when the catalogue is unavailable', async () => {
  stub(null);
  const page = into(createElement(KindPage, { kind: 'doc.term', version: 0 }));
  await until(() => page.querySelector('[data-entity="doc.term:order"]') !== null, 'records');
  await until(() => page.querySelector('[data-testid="kind-details-unavailable"]') !== null, 'declaration unavailable status');
  expect(page.querySelector('[data-testid="kind-details"]')).toBeNull();
  expect(page.querySelector('[data-testid="kind-details-unavailable"]')!.textContent).toContain('The kind declaration is unavailable.');
  expect(page.querySelector('[data-entity="doc.term:order"]')!.textContent).toContain('Order');
});

test('a catalogue-only kind shows details without inventing fields or targets', async () => {
  stub({ ...CATALOG, kinds: [kind('member', { page: false, fillWith: 'person', fields: [], relations: [{ direction: 'out', name: 'contains' }] })] });
  const page = into(createElement(KindDetails, { kind: 'member', version: 0 }));
  await until(() => page.querySelector('[data-testid="kind-details"]') !== null, 'member declaration');
  expect(page.querySelector('h1')).toBeNull();
  expect(page.querySelector('[data-testid="kind-fields"]')!.textContent).toContain('No fields are declared.');
  expect(page.querySelector('[data-testid="kind-relations"]')!.textContent).toContain('contains →');
  expect(page.querySelector('[data-testid="kind-relations"] a')).toBeNull();
  expect(page.querySelector('[data-testid="kind-producer"]')!.textContent).toBe('a person');
});

test('field labels use the selected Russian publication label without engine keys', async () => {
  await setWikiLanguage('ru');
  try {
    stub(CATALOG);
    const page = into(createElement(KindDetails, { kind: 'doc.term', version: 0 }));
    await until(() => page.querySelector('[data-testid="kind-fields"]') !== null, 'Russian fields');
    const fields = page.querySelector('[data-testid="kind-fields"]')!;
    expect(fields.textContent).toContain('Определение');
    expect(fields.textContent).toContain('Поле без перевода');
    expect(fields.textContent).not.toContain('definition');
    expect(fields.textContent).not.toContain('parent');
    expect(fields.textContent).toContain('madarch/kinds.yaml:18');
  } finally {
    await setWikiLanguage('en');
  }
});

test('person-origin kind pages include their declaration and catalogue-only kinds name absent producers', async () => {
  stub({ ...CATALOG, kinds: [kind('member', { page: false, fields: [], relations: [] })] });
  const page = into(createElement(KindLabels.Provider, { value: [{ kind: 'member', source: 'graph', count: 0, single: false, origins: ['person'] }] }, createElement(KindPage, { kind: 'member', version: 0 })));
  await until(() => page.querySelector('[data-testid="kind-details"]') !== null, 'authored declaration');
  expect(page.querySelector('[data-testid="authored-kind-page"]')).not.toBeNull();
  expect(page.querySelector('[data-testid="kind-producer"]')?.textContent).toBe('No producer is declared');
  expect(localeKeyIn(renderedText(page))).toBeUndefined();
});
