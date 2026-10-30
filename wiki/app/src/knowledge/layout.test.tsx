
/**
 * The layout of the wiki: the menu's waiting section and its footer, the nested
 * groups of the navigation and the catalogue, the product's front without kind
 * cards, and the glossary as a compact table. Every request is answered by a
 * stub giving the server's own shapes.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setWikiLanguage } from '../i18n.js';
import { navGroups } from './app.js';
import { GlossaryPage } from './glossary.js';
import { CataloguePage, Overview } from './pages.js';
import { Root as AppRoot } from './root.js';
import type { Glossary, GlossaryTerm, KindSummary, WikiStatus } from './types.js';

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
  for (let attempt = 0; attempt < 300; attempt++) {
    if (holds()) return;
    await new Promise((step) => setTimeout(step, 10));
  }
  throw new Error(`never came to ${what}; the tree holds: ${document.body.innerHTML.slice(0, 2500)}`);
}
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = '';
  delete (globalThis as { fetch?: unknown }).fetch;
  window.history.replaceState({}, '', '/');
});

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
const BOUNDS = { turns: 30, minutes: 10, toolCalls: 80, writeAttempts: 5, maxDomains: 12, editorialRequestsPerPage: 2 };
const kind = (over: Partial<KindSummary>): KindSummary => ({ kind: 'code.file', source: 'graph', count: 1, single: false, origins: ['code'], ...over });
const status = (over: Partial<WikiStatus> = {}): WikiStatus => ({
  product: { name: 'shop', id: 'p1' }, manifest: 'ok', manifestFile: 'madarch/kinds.yaml', language: 'en', seeded: [], findings: [], kinds: [], groups: [],
  repositories: [], filled: false, incomplete: false, fill: { state: 'idle' }, writer: { state: 'idle', agent: null, units: [] }, bounds: BOUNDS,
  chosenAgent: null, home: null, starterOffers: 0, ...over,
});

const nestedGroups = [
  { group: 'product', labels: { en: 'Product knowledge', ru: 'Знания о продукте' } },
  { group: 'code', labels: { en: 'Code', ru: 'Код' } },
  { group: 'code.structure', labels: { en: 'Structure', ru: 'Устройство' }, parent: 'code' },
  { group: 'code.analysis', labels: { en: 'Analysis', ru: 'Анализ' }, parent: 'code' },
  { group: 'operations', labels: { en: 'Operations', ru: 'Эксплуатация' } },
  { group: 'operations.configuration', labels: { en: 'Configuration', ru: 'Настройка' }, parent: 'operations' },
  { group: 'operations.dependencies', labels: { en: 'Dependencies', ru: 'Зависимости' }, parent: 'operations' },
];

describe('the groups of the manifest', () => {
  test('a sub-area is a group of its own with a parent, and the navigation nests it under that parent with one total', () => {
    const state = {
      groups: nestedGroups,
      kinds: [
        kind({ kind: 'domain', source: 'markdown', group: 'product', count: 2 }),
        kind({ kind: 'code.file', group: 'code.structure', count: 4 }),
        kind({ kind: 'code.cycle', group: 'code.analysis', count: 1 }),
        kind({ kind: 'code.env-var', group: 'operations.configuration', count: 3 }),
        kind({ kind: 'code.dependency', group: 'operations.dependencies', count: 5 }),
      ],
    } as unknown as WikiStatus;
    const groups = navGroups(state, () => 0);
    expect(groups.map((entry) => entry.group)).toEqual(['product', 'code', 'operations']);
    const code = groups[1]!;
    expect([code.total, code.kinds.map((entry) => entry.kind)]).toEqual([5, ['code.file', 'code.cycle']]);
    expect(code.subgroups.map((entry) => [entry.group, entry.total, entry.kinds.map((one) => one.kind)])).toEqual([
      ['code.structure', 4, ['code.file']],
      ['code.analysis', 1, ['code.cycle']],
    ]);
    const operations = groups[2]!;
    expect(operations.total).toBe(8);
    expect(operations.subgroups.map((entry) => entry.group)).toEqual(['operations.configuration', 'operations.dependencies']);
  });

  test('a sub-area whose kinds are all hidden on their own pages still counts in its parent total', () => {
    const state = status({
      groups: [
        { group: 'business', labels: { en: 'Business' } },
        { group: 'overview', labels: { en: 'Overview' }, parent: 'business' },
        { group: 'domains', labels: { en: 'Domains' }, parent: 'business' },
      ],
      kinds: [
        kind({ kind: 'doc.term', source: 'markdown', group: 'overview', count: 1, single: true }),
        kind({ kind: 'domain', source: 'markdown', group: 'domains', count: 2 }),
      ],
    });
    const groups = navGroups(state, () => 0);
    // The catalogue counts every entity of the parent's branch; a kind with a page of its own is not drawn as a row,
    // but its entities are neither lost from the parent's total (the review).
    expect(groups.map((entry) => entry.group)).toEqual(['business']);
    expect(groups[0]!.subgroups.map((entry) => entry.group)).toEqual(['domains']);
    expect(groups[0]!.total).toBe(3);
  });

  test('the catalogue draws each sub-area under its group, with the same rows as the kinds it holds', async () => {
    const full = {
      groups: nestedGroups,
      kinds: [
        kind({ kind: 'code.file', group: 'code.structure', count: 4, descriptions: { en: 'A file of a code repository.' } }),
        kind({ kind: 'code.cycle', group: 'code.analysis', count: 1, descriptions: { en: 'A ring of imports.' } }),
        kind({ kind: 'code.env-var', group: 'operations.configuration', count: 3, descriptions: { en: 'A setting read from the environment.' } }),
      ],
    } as unknown as WikiStatus;
    const page = into(createElement(CataloguePage, { status: full }));
    await until(() => page.querySelector('[data-testid=catalogue-page]') !== null, 'the catalogue');
    expect([...page.querySelectorAll('[data-testid=catalogue-group]')].map((group) => group.getAttribute('data-group'))).toEqual(['code', 'operations']);
    const code = page.querySelector('[data-testid=catalogue-group][data-group=code]')!;
    expect([...code.querySelectorAll('[data-testid=catalogue-subgroup]')].map((group) => group.getAttribute('data-subgroup'))).toEqual(['code.structure', 'code.analysis']);
    const configuration = page.querySelector('[data-testid=catalogue-group][data-group=operations] [data-testid=catalogue-subgroup][data-subgroup="operations.configuration"]')!;
    expect(configuration.querySelector('[data-kind="code.env-var"]')!.textContent).toContain('A setting read from the environment.');
  });
});

describe('the front page', () => {
  test('the product front holds no kind cards: the menu is the only list of kinds', async () => {
    const page = into(createElement(Overview, {
      status: status({ filled: true, home: 'product:shop', kinds: [kind({ kind: 'domain', source: 'markdown', group: 'product', count: 2 })], groups: nestedGroups.slice(0, 1), writer: { state: 'idle', agent: null, units: [] } }),
      refresh: () => undefined,
    }));
    await until(() => page.querySelector('[data-testid=overview]') !== null, 'the overview');
    expect(page.querySelector('[data-kind]')).toBeNull();
    expect(page.querySelector('[data-testid=overview]')!.textContent).not.toContain('Domains');
  });
});

describe('the menu', () => {
  test('«Waiting for you» stands directly under Home, counts questions, tasks and problems, greys an empty entry, and sources and settings sit at the foot', async () => {
    (globalThis as { fetch?: unknown }).fetch = async (url: string) => {
      if (url.endsWith('/api/k/status')) return json(status({
        home: 'product:shop', filled: true,
        kinds: [kind({ kind: 'domain', source: 'markdown', group: 'product', count: 1 })], groups: nestedGroups.slice(0, 1),
        loop: { questionsOpen: 2, questionsAnswered: 0, correctionsOpen: 3, tasksOpen: 0, problemsOpen: 3 },
      }));
      if (url.endsWith('/api/k/products')) return json({ products: [{ name: 'shop', folder: 'shop' }] });
      if (url.endsWith('/api/k/agents')) return json({ agents: [], chosen: null });
      if (url.endsWith('/api/k/settings')) return json({ role: 'everything', asked: true, roles: [] });
      if (url.endsWith('/api/k/glossary')) return json({ terms: [], resolutions: {}, findings: [] });
      return json({ message: 'not here' }, 404);
    };
    window.history.replaceState({}, '', '/k');
    const app = into(createElement(AppRoot));
    await until(() => app.querySelector('[data-testid=nav-waiting]') !== null, 'the waiting section');
    const home = app.querySelector('[data-testid=nav-home]')!;
    const waiting = app.querySelector('[data-testid=nav-waiting]')!;
    const catalogue = app.querySelector('[data-testid=nav-catalogue]')!;
    expect(home.nextElementSibling).toBe(waiting);
    expect(waiting.nextElementSibling).toBe(catalogue);
    expect(waiting.querySelector('[data-testid=nav-questions]')).not.toBeNull();
    expect(waiting.querySelector('[data-testid=nav-questions]')!.textContent).toContain('2');
    expect(waiting.querySelector('[data-testid=nav-tasks]')!.textContent).toContain('0');
    expect(waiting.querySelector('[data-testid=nav-tasks]')!.getAttribute('data-empty')).toBe('true');
    expect(waiting.querySelector('[data-testid=nav-problems]')!.textContent).toContain('3');
    expect(waiting.querySelector('[data-testid=nav-problems]')!.getAttribute('data-empty')).toBe('false');
    expect(app.querySelector('[data-testid=nav-scroll] [data-testid=nav-documents]')).toBeNull();
    const foot = app.querySelector('[data-testid=nav-foot]')!;
    expect(foot.querySelector('[data-testid=nav-documents]')).not.toBeNull();
    expect(foot.querySelector('[data-testid=nav-settings]')).not.toBeNull();
  });

  test('the group the manifest opens by itself is expanded; a group without the field is closed, whatever its name', async () => {
    (globalThis as { fetch?: unknown }).fetch = async (url: string) => {
      if (url.endsWith('/api/k/status')) return json(status({
        home: 'product:shop', filled: true,
        kinds: [kind({ kind: 'domain', source: 'markdown', group: 'product', count: 1 }), kind({ kind: 'code.file', group: 'code', count: 2 })],
        groups: [{ group: 'product', labels: { en: 'Product knowledge', ru: 'Знания о продукте' } }, { group: 'code', labels: { en: 'Code', ru: 'Код' }, open: true }],
      }));
      if (url.endsWith('/api/k/products')) return json({ products: [{ name: 'shop', folder: 'shop' }] });
      if (url.endsWith('/api/k/agents')) return json({ agents: [], chosen: null });
      if (url.endsWith('/api/k/settings')) return json({ role: 'everything', asked: true, roles: [] });
      if (url.endsWith('/api/k/glossary')) return json({ terms: [], resolutions: {}, findings: [] });
      return json({ message: 'not here' }, 404);
    };
    window.history.replaceState({}, '', '/k');
    const app = into(createElement(AppRoot));
    await until(() => app.querySelector('[data-nav-group=code] [data-testid=nav-group]') !== null, 'the groups');
    const expanded = (group: string): string | null => app.querySelector(`[data-nav-group="${group}"] [data-testid=nav-group]`)!.getAttribute('aria-expanded');
    // The app names no product group: the manifest's field decides, and `product` is not written into the engine.
    expect(expanded('code')).toBe('true');
    expect(expanded('product')).toBe('false');
  });
});

describe('the glossary table', () => {
  const term = (title: string, over: Partial<GlossaryTerm> = {}): GlossaryTerm => ({
    id: `doc:docs/glossary.md#${title.toLowerCase().replace(/\s+/g, '-')}`, title, definition: `${title} means a thing.`, synonyms: [], code: [], usedIn: null, ambiguous: null,
    repo: null, path: 'docs/glossary.md', line: 3, endLine: 4, anchor: title.toLowerCase().replace(/\s+/g, '-'), single: false,
    href: `/k/e/doc%3Adocs%2Fglossary.md%23${title.toLowerCase().replace(/\s+/g, '-')}`, ...over,
  });
  const glossary: Glossary = {
    terms: Array.from({ length: 7 }, (_, index) => term(`Term ${index + 1}`, { source: { original: `The source of Term ${index + 1}.`, document: 'docs/glossary.md', line: index * 2 + 1, endLine: index * 2 + 2 } })),
    resolutions: {}, findings: [],
  };

  test('every term is one compact table row, the original opens inside that row, and the place is written once', async () => {
    (globalThis as { fetch?: unknown }).fetch = async () => json(glossary);
    const page = into(createElement(GlossaryPage, { version: 1 }));
    await until(() => page.querySelector('[data-testid=glossary-table]') !== null, 'the glossary table');
    expect(page.querySelector('table[data-testid=glossary-table]')).not.toBeNull();
    const rows = [...page.querySelectorAll('[data-testid=glossary-term]')];
    expect(rows.length).toBe(7);
    expect(rows.every((row) => row.tagName === 'TR')).toBe(true);
    const first = rows[0]!;
    const source = first.querySelector('details[data-testid=localized-source]') as HTMLDetailsElement;
    expect(source.open).toBe(false);
    expect(source.textContent).toContain('The source of Term 1.');
    expect(source.querySelector('[data-testid=term-ground]')).toBeNull();
    expect(first.querySelectorAll('[data-testid=term-ground]').length).toBe(1);
    expect(first.textContent!.split('docs/glossary.md:3').length - 1).toBe(1);
  });
});
