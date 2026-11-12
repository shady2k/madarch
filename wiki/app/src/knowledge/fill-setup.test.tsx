import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setWikiLanguage } from '../i18n.js';
import { FillSetup } from './fill-setup.js';
import { addedByDependency, estimateOf } from './fill-selection.js';
import type { CatalogView } from './types.js';

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  await setWikiLanguage('en');
});
afterAll(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); GlobalRegistrator.unregister(); });
let root: Root | undefined;
afterEach(() => { root?.unmount(); root = undefined; document.body.innerHTML = ''; delete (globalThis as { fetch?: unknown }).fetch; });
const catalog: CatalogView = {
  product: { id: 'p', name: 'Test' }, language: 'en', groups: [{ group: 'code', labels: { en: 'Code' } }, { group: 'docs', labels: { en: 'Documents' } }], findings: [],
  kinds: [
    { kind: 'base', sources: ['https://example.test/base'], area: 'code', subgroup: '', count: 3, page: true, filled: true, state: 'filled', fillWith: 'agent', labels: { en: { one: 'Base', many: 'Bases' } } },
    { kind: 'middle', area: 'code', subgroup: '', count: 2, page: true, filled: false, state: 'never', fillWith: 'own', dependsOn: ['base'], labels: { en: { one: 'Middle', many: 'Middles' } } },
    { kind: 'leaf', area: 'docs', subgroup: '', count: 1, page: true, filled: false, state: 'never', fillWith: 'own', dependsOn: ['middle'], labels: { en: { one: 'Leaf', many: 'Leaves' } } },
    { kind: 'unrelated', area: 'docs', subgroup: '', count: 0, page: true, filled: false, state: 'never', fillWith: 'person', labels: { en: { one: 'Other', many: 'Others' } } },
  ],
};
async function until(check: () => boolean): Promise<void> {
  for (let n = 0; n < 100; n++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error(`Condition not reached: ${document.body.innerHTML}`);
}
function render(calls: { url: string; body: unknown }[], refresh = (): void => {}): HTMLElement {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url.includes('/api/catalog')) return Response.json(catalog);
    if (url.includes('/api/agents')) return Response.json({ agents: [], chosen: null });
    if (url.includes('/api/fill-selected')) {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return Response.json({ runId: 'selection-run', order: ['base', 'middle', 'leaf'] }, { status: 202 });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  const container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container); root.render(createElement(FillSetup, { refresh })); return container;
}

test('fill choices link to declarations without standards disclosures or selecting the kind', async () => {
  const page = render([]);
  await until(() => page.querySelector('[data-kind="base"] a[href="/kind/base"]') !== null);
  const row = page.querySelector('[data-kind="base"]')!;
  expect(row.querySelector('[data-testid="kind-sources"]')).toBeNull();
  expect(row.querySelector('button')).toBeNull();
  expect((row.querySelector('input') as HTMLInputElement).checked).toBe(false);
});

test('starts empty, does not read saved selection, and cannot Run empty', async () => {
  const calls: { url: string; body: unknown }[] = [];
  const page = render(calls);
  await until(() => page.querySelector('[data-testid="fill-setup-run"]') !== null);
  expect([...page.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every((input) => !input.checked)).toBe(true);
  const run = page.querySelector<HTMLButtonElement>('[data-testid="fill-setup-run"]')!;
  expect(run.disabled).toBe(true); run.click(); expect(calls).toEqual([]);
  expect(page.querySelector<HTMLSelectElement>('[data-testid="fill-setup-agent"]')!.disabled).toBe(true);
  expect(page.querySelector<HTMLInputElement>('[data-testid="fill-setup-cap"]')!.disabled).toBe(true);
  expect(page.querySelector('[data-testid="fill-setup-unsupported"]')!.textContent).toContain('not supported');
  expect(page.querySelector('[data-testid="fill-setup-agent-warning"]')).toBeNull();
  expect(page.querySelector('[data-testid="fill-setup-person-warning"]')).toBeNull();
});

test('selection highlights transitive dependencies and edges, warns only for chosen kinds, and sends one request', async () => {
  const calls: { url: string; body: unknown }[] = [];
  let refreshed = false;
  const page = render(calls, () => { refreshed = true; });
  await until(() => page.querySelector('[data-testid="fill-setup-check-leaf"]') !== null);
  page.querySelector<HTMLInputElement>('[data-testid="fill-setup-check-leaf"]')!.click();
  await until(() => page.querySelector('[data-testid="dependency-node"][data-kind="base"]')?.getAttribute('data-highlighted') === 'true');
  for (const id of ['base', 'middle']) {
    const input = page.querySelector<HTMLInputElement>(`[data-testid="fill-setup-check-${id}"]`)!;
    expect(input.checked).toBe(true); expect(input.disabled).toBe(true);
  }
  expect(page.querySelector('[data-testid="dependency-node"][data-kind="leaf"]')?.getAttribute('data-highlighted')).toBe('true');
  for (const edge of ['base->middle', 'middle->leaf']) expect(page.querySelector(`[data-edge="${edge}"]`)?.getAttribute('data-active')).toBe('true');
  expect(page.querySelectorAll('[data-testid="fill-setup-agent-warning"]').length).toBe(1);
  expect(page.querySelector('[data-testid="fill-setup-agent-warning"]')!.textContent).toContain('Bases');
  expect(page.querySelector('[data-testid="fill-setup-person-warning"]')).toBeNull();
  page.querySelector<HTMLButtonElement>('[data-testid="fill-setup-run"]')!.click();
  await until(() => refreshed);
  expect(calls).toEqual([{ url: '/api/fill-selected', body: { selected: ['leaf'], agent: null, tokenCap: null } }]);
  expect(window.location.pathname).toBe('/fill/runs/selection-run');
});

test('dependency closure and estimate include transitive kinds once', () => {
  const selected = new Set(['leaf']);
  const added = addedByDependency(catalog.kinds, selected);
  expect([...added.keys()].sort()).toEqual(['base', 'middle']);
  expect(estimateOf(catalog.kinds, selected, added).unknown).toBe(3);
  const measured = catalog.kinds.map((kind) => ({ ...kind, estimate: { volume: 2, unit: 'vertices' as const, tokensPerUnit: 5, secondsPerUnit: 1, tokens: 10, seconds: 2 } }));
  expect(estimateOf(measured, selected, added)).toEqual({ tokens: 30, seconds: 6, volume: 6, unknown: 0 });
});
