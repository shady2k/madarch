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
    { kind: 'base', sources: ['https://example.test/base'], area: 'code', subgroup: '', count: 3, page: true, filled: true, state: 'filled', plugins: ['general-agent'], requiresAgent: true, labels: { en: { one: 'Base', many: 'Bases' } } },
    { kind: 'middle', area: 'code', subgroup: '', count: 2, page: true, filled: false, state: 'never', plugins: ['scripted-plugin'], derivesFrom: ['base'], labels: { en: { one: 'Middle', many: 'Middles' } } },
    { kind: 'leaf', area: 'docs', subgroup: '', count: 1, page: true, filled: false, state: 'never', plugins: ['scripted-plugin'], derivesFrom: ['middle'], labels: { en: { one: 'Leaf', many: 'Leaves' } } },
    { kind: 'unrelated', area: 'docs', subgroup: '', count: 0, page: true, filled: false, state: 'never', plugins: ['scripted-plugin'], labels: { en: { one: 'Other', many: 'Others' } } },
  ],
};
async function until(check: () => boolean): Promise<void> {
  for (let n = 0; n < 100; n++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error(`Condition not reached: ${document.body.innerHTML}`);
}
function render(calls: { url: string; body: unknown }[], refresh = (): void => {}, answer: CatalogView = catalog): HTMLElement {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url.includes('/api/catalog')) return Response.json(answer);
    if (url.includes('/api/agents')) return Response.json({ agents: [{ id: 'scripted', label: 'Scripted fixture' }], chosen: null });
    if (url.includes('/api/fill-selected')) {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return Response.json({ order: ['base', 'middle', 'leaf'] }, { status: 202 });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  const container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container); root.render(createElement(FillSetup, { refresh })); return container;
}

test('fill choices show standards without selecting on a source link', async () => {
  const page = render([]);
  await until(() => page.querySelector('a[href="https://example.test/base"]') !== null);
  const row = page.querySelector('[data-kind="base"]')!;
  expect(row.querySelector('a[href="https://example.test/base"]')).not.toBeNull();
  expect(row.querySelector('label a')).toBeNull();
  expect((row.querySelector('input') as HTMLInputElement).checked).toBe(false);
});

test('starts empty, does not read saved selection, and cannot Run empty', async () => {
  const calls: { url: string; body: unknown }[] = [];
  const page = render(calls);
  await until(() => page.querySelector('[data-testid="fill-setup-run"]') !== null);
  expect([...page.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every((input) => !input.checked)).toBe(true);
  const run = page.querySelector<HTMLButtonElement>('[data-testid="fill-setup-run"]')!;
  expect(run.disabled).toBe(true); run.click(); expect(calls).toEqual([]);
  expect(page.querySelector('[data-testid="fill-setup-agent"]')).toBeNull();
  expect(page.querySelector<HTMLInputElement>('[data-testid="fill-setup-cap"]')!.disabled).toBe(false);
  expect(page.querySelector('[data-testid="fill-setup-unsupported"]')).toBeNull();
  expect(page.querySelector('[data-testid="fill-setup-agent-warning"]')).toBeNull();
  expect(page.querySelector('[data-testid="fill-setup-person-warning"]')).toBeNull();
});

test('selection highlights prerequisites and edges, names plugins, and sends one request', async () => {
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
  expect(page.querySelector('[data-testid="fill-setup-agent-warning"]')).toBeNull();
  expect(page.querySelector('[data-kind="base"]')!.textContent).toContain('general-agent');
  expect(page.querySelector('[data-testid="fill-setup-person-warning"]')).toBeNull();
  const run = page.querySelector<HTMLButtonElement>('[data-testid="fill-setup-run"]')!;
  expect(run.disabled).toBe(true);
  run.click(); expect(calls).toEqual([]);
  const agent = page.querySelector<HTMLSelectElement>('[data-testid="fill-setup-agent"]')!;
  expect(agent.required).toBe(true);
  expect(agent.textContent).not.toContain('No agent selected');
  expect(page.querySelector('[data-testid="fill-setup-agent-required"]')?.textContent).toContain('Choose an agent');
  agent.value = 'scripted'; agent.dispatchEvent(new Event('change', { bubbles: true }));
  await until(() => !run.disabled);
  run.click();
  await until(() => refreshed);
  expect(calls).toEqual([{ url: '/api/fill-selected', body: { selected: ['leaf'], agent: 'scripted', tokenCap: null } }]);
});

test('dependency closure and estimate include transitive kinds once', () => {
  const selected = new Set(['leaf']);
  const added = addedByDependency(catalog.kinds, selected);
  expect([...added.keys()].sort()).toEqual(['base', 'middle']);
  expect(estimateOf(catalog.kinds, selected, added).unknown).toBe(3);
  const measured = catalog.kinds.map((kind) => ({ ...kind, estimate: { volume: 2, unit: 'vertices' as const, tokensPerUnit: 5, secondsPerUnit: 1, tokens: 10, seconds: 2 } }));
  expect(estimateOf(measured, selected, added)).toEqual({ tokens: 30, seconds: 6, volume: 6, unknown: 0 });
});


test('passes the chosen scripted agent and positive token cap and rejects invalid caps', async () => {
  const calls: { url: string; body: unknown }[] = [];
  const page = render(calls);
  await until(() => page.querySelector('[data-testid="fill-setup-check-base"]') !== null);
  page.querySelector<HTMLInputElement>('[data-testid="fill-setup-check-base"]')!.click();
  await until(() => page.querySelector('option[value="scripted"]') !== null);
  const agent = page.querySelector<HTMLSelectElement>('[data-testid="fill-setup-agent"]')!;
  agent.value = 'scripted'; agent.dispatchEvent(new Event('change', { bubbles: true }));
  const cap = page.querySelector<HTMLInputElement>('[data-testid="fill-setup-cap"]')!;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  cap.focus();
  setter.call(cap, '0'); cap.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: '0' }));
  await until(() => cap.getAttribute('aria-invalid') === 'true');
  expect(page.querySelector<HTMLButtonElement>('[data-testid="fill-setup-run"]')!.disabled).toBe(true);
  setter.call(cap, '1500'); cap.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: '0' }));
  await until(() => cap.getAttribute('aria-invalid') === 'false');
  page.querySelector<HTMLButtonElement>('[data-testid="fill-setup-run"]')!.click();
  await until(() => calls.length === 1);
  expect(calls[0]!.body).toEqual({ selected: ['base'], agent: 'scripted', tokenCap: 1500 });
});

test('selecting a prerequisite never adds its dependents', () => {
  expect([...addedByDependency(catalog.kinds, new Set(['base'])).keys()]).toEqual([]);
});

test('deterministic plans hide agent choice and run agentless', async () => {
  const calls: { url: string; body: unknown }[] = [];
  const page = render(calls);
  await until(() => page.querySelector('[data-testid="fill-setup-check-unrelated"]') !== null);
  page.querySelector<HTMLInputElement>('[data-testid="fill-setup-check-unrelated"]')!.click();
  const run = page.querySelector<HTMLButtonElement>('[data-testid="fill-setup-run"]')!;
  await until(() => !run.disabled);
  expect(page.querySelector('[data-testid="fill-setup-agent"]')).toBeNull();
  run.click(); await until(() => calls.length === 1);
  expect(calls[0]!.body).toEqual({ selected: ['unrelated'], agent: null, tokenCap: null });
});

test('removing agent-requiring kinds hides the field and does not send the stale agent', async () => {
  const calls: { url: string; body: unknown }[] = [];
  const page = render(calls);
  await until(() => page.querySelector('[data-testid="fill-setup-check-base"]') !== null);
  page.querySelector<HTMLInputElement>('[data-testid="fill-setup-check-base"]')!.click();
  await until(() => page.querySelector('option[value="scripted"]') !== null);
  const agent = page.querySelector<HTMLSelectElement>('[data-testid="fill-setup-agent"]')!;
  agent.value = 'scripted'; agent.dispatchEvent(new Event('change', { bubbles: true }));
  page.querySelector<HTMLInputElement>('[data-testid="fill-setup-check-base"]')!.click();
  page.querySelector<HTMLInputElement>('[data-testid="fill-setup-check-unrelated"]')!.click();
  await until(() => page.querySelector('[data-testid="fill-setup-agent"]') === null);
  page.querySelector<HTMLButtonElement>('[data-testid="fill-setup-run"]')!.click();
  await until(() => calls.length === 1);
  expect(calls[0]!.body).toEqual({ selected: ['unrelated'], agent: null, tokenCap: null });
});

test('invalid server plans explain the refusal and cannot start', async () => {
  const calls: { url: string; body: unknown }[] = [];
  const refusal = 'plugins/broken/plugin.yaml:4: missing prerequisite';
  const page = render(calls, () => {}, { ...catalog, kinds: catalog.kinds.map((kind) => kind.kind === 'unrelated' ? { ...kind, fillPlanRefusal: refusal } : kind) });
  await until(() => page.querySelector('[data-testid="fill-setup-check-unrelated"]') !== null);
  page.querySelector<HTMLInputElement>('[data-testid="fill-setup-check-unrelated"]')!.click();
  await until(() => page.textContent?.includes(refusal) === true);
  const run = page.querySelector<HTMLButtonElement>('[data-testid="fill-setup-run"]')!;
  expect(run.disabled).toBe(true); run.click(); expect(calls).toEqual([]);
});
