/**
 * The catalogue page's selective fill (madarch-stm0.6): a checkbox per section and per entity, the dependencies checked
 * with the entity that needs them and marked "needed by …", Check all and Uncheck all, each entity's state, and the panel
 * pinned to the page with its counts, agent, cap, estimate and Fill selected — which asks the engine for exactly that set.
 * Nothing here starts an agent: the press names no agent.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setWikiLanguage } from '../i18n.js';
import { CataloguePage, addedByDependency, estimateOf } from './pages.js';
import type { CatalogView, FillSelectionView } from './types.js';

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  await setWikiLanguage('en');
});

afterAll(async () => {
  await new Promise((rest) => setTimeout(rest, 50));
  GlobalRegistrator.unregister();
});

let rendered: Root | undefined;
function into(element: ReturnType<typeof createElement>): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  rendered = createRoot(container);
  rendered.render(element);
  return container;
}

async function until(holds: () => boolean | undefined, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (holds()) return;
    await new Promise((step) => setTimeout(step, 10));
  }
  throw new Error(`never came to ${what}; the tree holds: ${document.body.innerHTML.replace(/ class="[^"]*"/g, '').slice(-2500)}`);
}

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = '';
  delete (globalThis as { fetch?: unknown }).fetch;
});

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

const CATALOG: CatalogView = {
  product: { name: 'shop', id: 'p1' }, language: 'en',
  groups: [{ group: 'code', labels: { en: 'Code', ru: 'Код' } }, { group: 'requirements', labels: { en: 'Requirements', ru: 'Требования' } }],
  kinds: [
    { kind: 'code.file', area: 'code', subgroup: '', count: 12, page: true, filled: true, plugins: ['files'], state: 'filled', estimatedTokens: 0, labels: { en: { one: 'File', many: 'Files' } } },
    { kind: 'doc.term', area: 'requirements', subgroup: '', count: 3, page: true, filled: true, plugins: ['glossary'], dependsOn: ['code.file'], state: 'partial', estimatedTokens: 0, labels: { en: { one: 'Term', many: 'Terms' } } },
    { kind: 'doc.use-case', area: 'requirements', subgroup: '', count: 0, page: true, filled: false, state: 'never', estimatedTokens: 660, labels: { en: { one: 'Use case', many: 'Use cases' } } },
  ],
  findings: [],
};

const EMPTY: FillSelectionView = { selected: [], agent: null, tokenCap: null, savedAt: '' };

/** The stub of the four requests the page makes, with what the page wrote and pressed. */
function stub(calls: { url: string; method: string; body: unknown }[], selection: FillSelectionView = EMPTY): void {
  (globalThis as { fetch?: unknown }).fetch = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    if (method !== 'GET') calls.push({ url, method, body });
    if (url.includes('/api/catalog')) return json(CATALOG);
    if (url.includes('/api/fill-selection')) return json({ selection: method === 'GET' ? selection : { ...(body as object), savedAt: '2026-11-10 20:00:00+00' } });
    if (url.includes('/api/fill-selected')) return json({ fill: { state: 'running' }, selection: { ...(body as object), savedAt: 'x' }, order: ['code.file', 'doc.term'] }, 202);
    if (url.includes('/api/agents')) return json({ agents: [{ id: 'claude-code', label: 'Claude Code', installed: true, login: 'signed-in', loginDetail: '', install: null }], chosen: null });
    return json({ message: 'not here' }, 404);
  };
}

describe('the catalogue page\'s selective fill', () => {
  test('every entity has its state and a checkbox, and a checked entity brings its dependencies with it', async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    stub(calls);
    const page = into(createElement(CataloguePage, { version: 0 }));
    await until(() => page.querySelector('[data-testid="catalogue-check-doc.term"]') !== null, 'the catalogue');
    // Each row says how much of it stands.
    expect(page.querySelector('[data-kind="doc.term"] [data-testid="catalogue-state"]')!.getAttribute('data-state')).toBe('partial');
    expect(page.querySelector('[data-kind="doc.term"] [data-testid="catalogue-state"]')!.textContent).toBe('Partial');
    expect(page.querySelector('[data-kind="doc.use-case"] [data-testid="catalogue-state"]')!.textContent).toBe('Never filled');
    // Nothing is checked by the store's selection, so the panel says zero; checking the term kind checks its file kind.
    expect(page.querySelector('[data-testid="catalogue-selected-count"]')!.textContent).toBe('0 selected');
    (page.querySelector('[data-testid="catalogue-check-doc.term"]') as HTMLInputElement).click();
    await until(() => (page.querySelector('[data-testid="catalogue-check-code.file"]') as HTMLInputElement).checked, 'the dependency checked');
    const fileBox = page.querySelector('[data-testid="catalogue-check-code.file"]') as HTMLInputElement;
    // The dependency is checked by the term kind and cannot be unchecked while it stands checked.
    expect(fileBox.disabled).toBe(true);
    expect(page.querySelector('[data-kind="code.file"] [data-testid="catalogue-needed-by"]')!.textContent).toBe('needed by Terms');
    expect(page.querySelector('[data-testid="catalogue-selected-count"]')!.textContent).toBe('1 selected');
    expect(page.querySelector('[data-testid="catalogue-added-count"]')!.textContent).toContain('1 added');
    // The panel's estimate covers the selected kinds' agent parts: the term kind's own plugin needs no tokens.
    expect(page.querySelector('[data-testid="catalogue-estimate"]')!.textContent).toBe('About 0 tokens for the agent\'s part');
    // The page writes the selection as it is made.
    await until(() => calls.some((call) => call.url.includes('/api/fill-selection')), 'the selection saved');
    expect(calls.find((call) => call.url.includes('/api/fill-selection'))!.body).toEqual({ selected: ['doc.term'], agent: null, tokenCap: null });
  });

  test('a section checkbox takes the section\'s entities, Check all takes every one, and Uncheck all takes none', async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    stub(calls);
    const page = into(createElement(CataloguePage, { version: 0 }));
    await until(() => page.querySelector('[data-testid="catalogue-check-section-requirements"]') !== null, 'the sections');
    (page.querySelector('[data-testid="catalogue-check-section-requirements"]') as HTMLInputElement).click();
    await until(() => (page.querySelector('[data-testid="catalogue-check-doc.use-case"]') as HTMLInputElement).checked, 'the section checked');
    expect((page.querySelector('[data-testid="catalogue-check-doc.term"]') as HTMLInputElement).checked).toBe(true);
    expect(page.querySelector('[data-testid="catalogue-selected-count"]')!.textContent).toBe('2 selected');
    // The section with no plugin entities adds nothing of another section, and its own dependency is added.
    expect(page.querySelector('[data-testid="catalogue-added-count"]')!.textContent).toContain('1 added');
    (page.querySelector('[data-testid="catalogue-check-all"]') as HTMLButtonElement).click();
    await until(() => (page.querySelector('[data-testid="catalogue-check-code.file"]') as HTMLInputElement).checked, 'every entity checked');
    expect(page.querySelector('[data-testid="catalogue-selected-count"]')!.textContent).toBe('3 selected');
    expect(page.querySelector('[data-testid="catalogue-added-count"]')).toBeNull();
    (page.querySelector('[data-testid="catalogue-uncheck-all"]') as HTMLButtonElement).click();
    await until(() => page.querySelector('[data-testid="catalogue-selected-count"]')!.textContent === '0 selected', 'nothing selected');
    expect((page.querySelector('[data-testid="catalogue-fill"]') as HTMLButtonElement).disabled).toBe(true);
  });

  test('Fill selected asks the engine for the checked kinds and says the order it runs them in', async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    stub(calls);
    const page = into(createElement(CataloguePage, { version: 0 }));
    await until(() => page.querySelector('[data-testid="catalogue-check-doc.term"]') !== null, 'the catalogue');
    (page.querySelector('[data-testid="catalogue-check-doc.term"]') as HTMLInputElement).click();
    await until(() => (page.querySelector('[data-testid="catalogue-fill"]') as HTMLButtonElement).disabled === false, 'the fill button');
    (page.querySelector('[data-testid="catalogue-fill"]') as HTMLButtonElement).click();
    await until(() => page.querySelector('[data-testid="catalogue-fill-note"]') !== null, 'the press');
    const pressed = calls.find((call) => call.url.includes('/api/fill-selected'))!;
    expect(pressed.body).toEqual({ selected: ['doc.term'], agent: null, tokenCap: null });
    expect(page.querySelector('[data-testid="catalogue-fill-note"]')!.textContent).toBe('The fill started, in this order: code.file, doc.term');
  });

  test('a selection the store kept is the page\'s own, in both languages', async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    stub(calls, { selected: ['doc.use-case'], agent: 'claude-code', tokenCap: 5000, savedAt: '2026-11-10 20:00:00+00' });
    const page = into(createElement(CataloguePage, { version: 0 }));
    await until(() => page.querySelector('[data-testid="catalogue-check-doc.use-case"]') !== null, 'the catalogue');
    await until(() => (page.querySelector('[data-testid="catalogue-check-doc.use-case"]') as HTMLInputElement).checked, 'the saved selection');
    expect((page.querySelector('[data-testid="catalogue-agent"]') as HTMLSelectElement).value).toBe('claude-code');
    expect((page.querySelector('[data-testid="catalogue-token-cap"]') as HTMLInputElement).value).toBe('5000');
    expect(page.querySelector('[data-testid="catalogue-selected-count"]')!.textContent).toBe('1 selected');
    expect(page.querySelector('[data-testid="catalogue-estimate"]')!.textContent).toContain('660');
    await setWikiLanguage('ru');
    const russian = into(createElement(CataloguePage, { version: 0 }));
    await until(() => russian.querySelector('[data-testid="catalogue-check-doc.term"]') !== null, 'the catalogue in Russian');
    expect(russian.querySelector('[data-testid="catalogue-check-all"]')!.textContent).toBe('Отметить все');
    expect(russian.querySelector('[data-testid="catalogue-fill"]')!.textContent).toBe('Заполнить выбранное');
    expect(russian.querySelector('[data-testid="catalogue-selected-count"]')!.textContent).toBe('Отмечено: 0');
  });

  test('the dependency closure and the estimate are a function of the kinds alone', () => {
    const kinds = CATALOG.kinds;
    const checked = new Set(['doc.term', 'doc.use-case']);
    const added = addedByDependency(kinds, checked);
    expect([...added.entries()]).toEqual([['code.file', 'doc.term']]);
    expect(estimateOf(kinds, checked, added)).toBe(660);
  });
});
