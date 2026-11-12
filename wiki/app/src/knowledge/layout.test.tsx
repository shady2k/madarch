
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
import { CataloguePage, Overview, NewHome, EmptyHome } from './pages.js';
import { Root as AppRoot } from './root.js';
import type { CatalogView, Glossary, GlossaryTerm, KindSummary, WikiStatus } from './types.js';

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
afterEach(async () => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = '';
  delete (globalThis as { fetch?: unknown }).fetch;
  window.history.replaceState({}, '', '/');
  await setWikiLanguage('en');
});

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
const BOUNDS = { turns: 30, minutes: 10, toolCalls: 80, writeAttempts: 5, maxDomains: 12, editorialRequestsPerPage: 2 };
const kind = (over: Partial<KindSummary>): KindSummary => ({ kind: 'code.file', source: 'graph', count: 1, single: false, origins: ['code'], ...over });
const status = (over: Partial<WikiStatus> = {}): WikiStatus => ({
  product: { name: 'shop', id: 'p1' }, manifest: 'ok', manifestFile: 'madarch/kinds.yaml', language: 'en', findingCount: 0, kinds: [], groups: [],
  repositories: [], filled: false, incomplete: false, fill: { state: 'idle' }, writer: { state: 'idle', agent: null, units: [] }, bounds: BOUNDS,
  chosenAgent: null, home: null, ...over,
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
  test('catalogue-only and member kinds count in status without becoming navigation rows', () => {
    const state = status({ groups: [{ group: 'code', labels: { en: 'Code' } }], kinds: [
      kind({ kind: 'code.file', group: 'code', count: 2, page: true }),
      kind({ kind: 'code.member', group: 'code', count: 3, page: false }),
    ] });
    const groups = navGroups(state, () => 0);
    expect(groups[0]!.total).toBe(5);
    expect(groups[0]!.kinds.map((row) => row.kind)).toEqual(['code.file']);
  });

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
    const full: CatalogView = {
      product: { name: 'shop', id: 'p1' },
      language: 'en',
      groups: nestedGroups,
      kinds: [
        { kind: 'code.file', area: 'code', subgroup: 'code.structure', count: 4, page: true, producer: 'extract', filled: true, descriptions: { en: 'A file of a code repository.' }, state: 'filled', estimate: { volume: 0, unit: 'vertices', tokensPerUnit: null, secondsPerUnit: null, tokens: null, seconds: null } },
        { kind: 'code.cycle', area: 'code', subgroup: 'code.analysis', count: 1, page: true, producer: 'extract', filled: true, descriptions: { en: 'A ring of imports.' }, state: 'filled', estimate: { volume: 0, unit: 'vertices', tokensPerUnit: null, secondsPerUnit: null, tokens: null, seconds: null } },
        { kind: 'code.env-var', area: 'operations', subgroup: 'operations.configuration', count: 3, page: true, producer: 'extract', filled: true, descriptions: { en: 'A setting read from the environment.' }, state: 'filled', estimate: { volume: 0, unit: 'vertices', tokensPerUnit: null, secondsPerUnit: null, tokens: null, seconds: null } },
      ],
      findings: [],
    };
    (globalThis as { fetch?: unknown }).fetch = async (url: string) => url.includes('/api/catalog')
      ? json(full)
      : new Response('{}', { status: 404 });
    const page = into(createElement(CataloguePage, { version: 0 }));
    await until(() => page.querySelector('[data-testid=catalogue-page]') !== null, 'the catalogue');
    expect([...page.querySelectorAll('[data-testid=catalogue-group]')].map((group) => group.getAttribute('data-group'))).toEqual(['code', 'operations']);
    const code = page.querySelector('[data-testid=catalogue-group][data-group=code]')!;
    expect([...code.querySelectorAll('[data-testid=catalogue-subgroup]')].map((group) => group.getAttribute('data-subgroup'))).toEqual(['code.structure', 'code.analysis']);
    const configuration = page.querySelector('[data-testid=catalogue-group][data-group=operations] [data-testid=catalogue-subgroup][data-subgroup="operations.configuration"]')!;
    expect(configuration.querySelector('[data-kind="code.env-var"]')!.textContent).toContain('A setting read from the environment.');
  });
});

describe('the front page', () => {
  for (const language of ['en', 'ru'] as const) for (const manifest of ['not-filled', 'no-manifest'] as const) test(`one truthful prefill card in ${language}, ${manifest}`, async () => {
    await setWikiLanguage(language);
    const posts: string[] = [];
    (globalThis as { fetch?: unknown }).fetch = async (url: string, options?: RequestInit) => { if (options?.method === 'POST') posts.push(url); return json({}); };
    const page = into(createElement(manifest === 'not-filled' ? NewHome : EmptyHome, { status: status({ manifest }), refresh: () => undefined }));
    await until(() => page.querySelector('[data-testid=prefill-card]') !== null, 'one prefill card');
    expect(page.querySelectorAll('[data-testid=prefill-card]').length).toBe(1);
    expect(page.querySelector('[data-testid=fill-card]')).toBeNull();
    expect(page.textContent).toContain(language === 'ru' ? 'Граф пока пуст' : 'The graph is empty');
    expect(page.textContent).not.toContain(language === 'ru' ? 'Код подключён' : 'Code connected');
    const button = page.querySelector('[data-testid=prefill-open]')!;
    expect(button.tagName).toBe('BUTTON');
    expect(button.textContent).toBe(language === 'ru' ? 'Заполнить…' : 'Fill…');
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    await until(() => window.location.pathname === '/fill', 'the fill choices');
    expect(posts).toEqual([]);
  });

  test('connected code is stated only when the server lists a repository', async () => {
    const page = into(createElement(NewHome, { status: status({ manifest: 'not-filled', repositories: [{ name: 'shop' }] as WikiStatus['repositories'] }), refresh: () => undefined }));
    await until(() => page.querySelector('[data-testid=prefill-card]') !== null, 'prefill');
    expect(page.textContent).toContain('Code connected');
  });

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
  test('with no fill the home is the introduction, even when the product files hold a home page', async () => {
    let askedPage = false;
    (globalThis as { fetch?: unknown }).fetch = async (url: string) => {
      if (url.includes('/api/page')) askedPage = true;
      if (url.endsWith('/api/status')) return json(status({ filled: false, home: 'product:shop', kinds: [kind({ kind: 'product', source: 'markdown', single: true, count: 1 })], groups: nestedGroups.slice(0, 1) }));
      if (url.endsWith('/api/products')) return json({ products: [{ name: 'shop', folder: 'shop' }] });
      if (url.endsWith('/api/agents')) return json({ agents: [], chosen: null });
      if (url.endsWith('/api/settings')) return json({ role: 'everything', asked: true, roles: [] });
      if (url.endsWith('/api/glossary')) return json({ terms: [], resolutions: {}, findings: [] });
      return json({ message: 'not here' }, 404);
    };
    window.history.replaceState({}, '', '/');
    const app = into(createElement(AppRoot));
    await until(() => app.querySelector('[data-testid=prefill-card]') !== null, 'the prefill card');
    expect(askedPage).toBe(false);
  });

  for (const language of ['en', 'ru'] as const) test(`the sidebar top block is Home, Catalogue, Glossary in ${language}, then waiting and the footer`, async () => {
    await setWikiLanguage(language);
    (globalThis as { fetch?: unknown }).fetch = async (url: string) => {
      if (url.endsWith('/api/status')) return json(status({
        home: 'product:shop', filled: true,
        kinds: [kind({ kind: 'domain', source: 'markdown', group: 'product', count: 1 })], groups: nestedGroups.slice(0, 1),
        loop: { questionsOpen: 2, questionsAnswered: 0, correctionsOpen: 3, tasksOpen: 0, problemsOpen: 3 },
      }));
      if (url.endsWith('/api/products')) return json({ products: [{ name: 'shop', folder: 'shop' }] });
      if (url.endsWith('/api/agents')) return json({ agents: [], chosen: null });
      if (url.endsWith('/api/settings')) return json({ role: 'everything', asked: true, roles: [] });
      if (url.endsWith('/api/glossary')) return json({ terms: [], resolutions: {}, findings: [] });
      if (url.endsWith('/api/catalog')) return json({ product: { name: 'shop', id: 'p1' }, language, groups: [], kinds: [], findings: [] });
      return json({ message: 'not here' }, 404);
    };
    window.history.replaceState({}, '', '/catalogue');
    const app = into(createElement(AppRoot));
    await until(() => app.querySelector('[data-testid=catalogue-page] h1') !== null, 'the catalogue title');
    const home = app.querySelector('[data-testid=nav-home]')!;
    const waiting = app.querySelector('[data-testid=nav-waiting]')!;
    const catalogue = app.querySelector('[data-testid=nav-catalogue]')!;
    expect(app.querySelector('[data-testid=nav-dependencies]')).toBeNull();
    expect(home.nextElementSibling).toBe(catalogue);
    const glossary = app.querySelector('[data-testid=nav-glossary]')!;
    expect(app.querySelector('[data-testid=catalogue-page] h1')!.textContent).toBe(catalogue.textContent);
    expect(catalogue.nextElementSibling).toBe(glossary);
    const fill = app.querySelector('[data-testid=nav-fill]')!;
    expect(glossary.nextElementSibling).toBe(fill);
    expect(fill.nextElementSibling).toBe(waiting);
    const topLinks = [];
    for (let node = home; node !== waiting; node = node.nextElementSibling!) topLinks.push(node);
    expect(topLinks.map((node) => node.textContent)).toEqual(language === 'ru'
      ? ['Главная', 'Каталог сущностей', 'Глоссарий', 'Заполнение']
      : ['Home', 'Entity catalogue', 'Glossary', 'Fill']);
    expect(topLinks.map((node) => node.getAttribute('href'))).toEqual(['/', '/catalogue', '/glossary', '/fill']);
    expect(glossary.querySelector('svg')).not.toBeNull();
    expect(catalogue.parentElement?.closest('[data-testid=nav-waiting]')).toBeNull();
    expect(waiting.querySelector('[data-testid=nav-catalogue]')).toBeNull();
    expect(waiting.querySelector('[data-testid=nav-questions]')).toBeNull();
    expect(waiting.querySelector('[data-testid=nav-tasks]')).toBeNull();
    expect(waiting.querySelector('[data-testid=nav-problems]')!.textContent).toContain('3');
    expect(waiting.querySelector('[data-testid=nav-problems]')!.getAttribute('data-empty')).toBe('false');
    expect(app.querySelector('[data-testid=nav-scroll] [data-testid=nav-documents]')).toBeNull();
    const foot = app.querySelector('[data-testid=nav-foot]')!;
    expect(foot.querySelector('[data-testid=nav-documents]')).not.toBeNull();
    expect(foot.querySelector('[data-testid=nav-settings]')).not.toBeNull();
  });

  test('a kind whose own page is a listing stands under its manifest group, not in «Waiting for you»', async () => {
    (globalThis as { fetch?: unknown }).fetch = async (url: string) => {
      if (url.endsWith('/api/status')) return json(status({
        home: null, filled: false,
        kinds: [
          kind({ kind: 'domain', source: 'markdown', group: 'requirements', count: 1 }),
          kind({ kind: 'doc.term', source: 'document', group: 'requirements', count: 7, nav: 'own-page', listing: 'glossary', labels: { en: { one: 'Term', many: 'Terms' }, ru: { one: 'Термин', many: 'Термины' } } }),
        ],
        groups: [{ group: 'requirements', labels: { en: 'Requirements', ru: 'Требования' }, open: true }],
        loop: { questionsOpen: 2, questionsAnswered: 0, correctionsOpen: 0, tasksOpen: 0, problemsOpen: 0 },
      }));
      if (url.endsWith('/api/products')) return json({ products: [{ name: 'shop', folder: 'shop' }] });
      if (url.endsWith('/api/agents')) return json({ agents: [], chosen: null });
      if (url.endsWith('/api/settings')) return json({ role: 'everything', asked: true, roles: [] });
      if (url.endsWith('/api/glossary')) return json({ terms: [], resolutions: {}, findings: [] });
      return json({ message: 'not here' }, 404);
    };
    window.history.replaceState({}, '', '/');
    const app = into(createElement(AppRoot));
    await until(() => app.querySelector('[data-nav-kind="doc.term"]') !== null, 'the term kind row');
    const waiting = app.querySelector('[data-testid=nav-waiting]')!;
    expect(waiting.querySelector('[data-nav-kind="doc.term"]')).toBeNull();
    expect(waiting.querySelector('[data-testid=nav-questions]')).toBeNull();
    expect(waiting.querySelector('[data-testid=nav-tasks]')).toBeNull();
    expect(waiting.querySelector('[data-testid=nav-problems]')).not.toBeNull();
    const group = app.querySelector('[data-nav-group=requirements]')!;
    const row = group.querySelector('[data-nav-kind="doc.term"]')!;
    expect(row.getAttribute('href')).toBe('/glossary');
    expect(row.textContent).toContain('Terms');
    expect(row.querySelector('[data-testid=nav-count]')!.textContent).toBe('7');
    // The top-level glossary shortcut coexists with the manifest's kind listing.
    expect(app.querySelector('[data-testid=nav-glossary]')!.getAttribute('href')).toBe('/glossary');
  });

  test('the group the manifest opens by itself is expanded; a group without the field is closed, whatever its name', async () => {
    (globalThis as { fetch?: unknown }).fetch = async (url: string) => {
      if (url.endsWith('/api/status')) return json(status({
        home: 'product:shop', filled: true,
        kinds: [kind({ kind: 'domain', source: 'markdown', group: 'product', count: 1 }), kind({ kind: 'code.file', group: 'code', count: 2 })],
        groups: [{ group: 'product', labels: { en: 'Product knowledge', ru: 'Знания о продукте' } }, { group: 'code', labels: { en: 'Code', ru: 'Код' }, open: true }],
      }));
      if (url.endsWith('/api/products')) return json({ products: [{ name: 'shop', folder: 'shop' }] });
      if (url.endsWith('/api/agents')) return json({ agents: [], chosen: null });
      if (url.endsWith('/api/settings')) return json({ role: 'everything', asked: true, roles: [] });
      if (url.endsWith('/api/glossary')) return json({ terms: [], resolutions: {}, findings: [] });
      return json({ message: 'not here' }, 404);
    };
    window.history.replaceState({}, '', '/');
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
    id: `doc:docs/glossary.md#${title.toLowerCase().replace(/\s+/g, '-')}`, title, definition: `${title} means a thing.`, synonyms: [], code: [], definedIn: null, usages: [], usageCount: 0, ambiguous: null,
    repo: null, path: 'docs/glossary.md', line: 3, endLine: 4, anchor: title.toLowerCase().replace(/\s+/g, '-'), single: false,
    href: `/e/doc%3Adocs%2Fglossary.md%23${title.toLowerCase().replace(/\s+/g, '-')}`, ...over,
  });
  const glossary: Glossary = {
    terms: Array.from({ length: 7 }, (_, index) => term(`Term ${index + 1}`, { source: { original: `The source of Term ${index + 1}.`, document: 'docs/glossary.md', line: index * 2 + 1, endLine: index * 2 + 2 } })),
    resolutions: {}, findingCount: 0,
  };

  test('every term is one compact table row, the original opens inside that row, and the place is written once', async () => {
    (globalThis as { fetch?: unknown }).fetch = async () => json(glossary);
    const page = into(createElement(GlossaryPage, { version: 1 }));
    await until(() => page.querySelector('[data-testid=glossary-table]') !== null, 'the glossary table');
    expect(page.querySelector('table[data-testid=glossary-table]')).not.toBeNull();
    const rows = [...page.querySelectorAll('[data-testid=glossary-term]')];
    expect(rows.length).toBe(7);
    expect(rows.every((row) => row.tagName === 'TR')).toBe(true);
    // The count stands as a badge on the title; the sentence that repeated it is gone.
    expect(page.querySelector('[data-testid=glossary-count]')!.textContent).toBe('7');
    expect(page.textContent).not.toContain('each with the place it is stated');
    // No term has another name: the names column is not drawn at all, and a row holds its three columns.
    expect([...page.querySelectorAll('th')].map((head) => head.textContent)).toEqual(['Term', 'Definition', 'Place']);
    const first = rows[0]!;
    expect(first.querySelectorAll('td').length).toBe(3);
    const source = first.querySelector('details[data-testid=localized-source]') as HTMLDetailsElement;
    expect(source.open).toBe(false);
    expect(source.textContent).toContain('The source of Term 1.');
    expect(source.querySelector('[data-testid=term-ground]')).toBeNull();
    expect(first.querySelectorAll('[data-testid=term-ground]').length).toBe(1);
    expect(first.textContent!.split('docs/glossary.md:3').length - 1).toBe(1);
    expect(first.textContent).not.toContain('Used in');
  });

  test('in Russian the title carries the count as a badge and the sentence that repeated it is gone', async () => {
    await setWikiLanguage('ru');
    try {
      (globalThis as { fetch?: unknown }).fetch = async () => json(glossary);
      const page = into(createElement(GlossaryPage, { version: 4 }));
      await until(() => page.querySelector('[data-testid=glossary-table]') !== null, 'the Russian glossary');
      expect(page.querySelector('h1')!.textContent).toBe('Глоссарий');
      expect(page.querySelector('[data-testid=glossary-count]')!.textContent).toBe('7');
      expect(page.textContent).not.toContain('у каждого указано');
    } finally {
      await setWikiLanguage('en');
    }
  });

  test('a term with another name draws the names column; one with none leaves it out', async () => {
    const named: Glossary = { ...glossary, terms: [term('Manifest', { synonyms: ['manifest file'], code: ['madarch/kinds.yaml'] }), ...glossary.terms.slice(1)] };
    (globalThis as { fetch?: unknown }).fetch = async () => json(named);
    let page = into(createElement(GlossaryPage, { version: 2 }));
    await until(() => page.querySelector('[data-testid=glossary-table]') !== null, 'the named glossary');
    expect([...page.querySelectorAll('th')].map((head) => head.textContent)).toEqual(['Term', 'Definition', 'Names', 'Place']);
    expect(page.querySelector('[data-testid=glossary-term] [data-testid=term-names]')!.textContent).toContain('manifest file');
    rendered?.unmount();
    document.body.innerHTML = '';
    (globalThis as { fetch?: unknown }).fetch = async () => json(glossary);
    page = into(createElement(GlossaryPage, { version: 3 }));
    await until(() => page.querySelector('[data-testid=glossary-table]') !== null, 'the unnamed glossary');
    expect([...page.querySelectorAll('th')].map((head) => head.textContent)).not.toContain('Names');
  });
});

test('person kinds override glossary and loop navigation and empty lists still offer New', async () => {
  const kinds = [
    kind({ kind: 'doc.term', origins: ['person'], count: 0, nav: 'own-page', listing: 'glossary', group: 'authored' }),
    kind({ kind: 'task', origins: ['person'], count: 0, nav: 'own-page', group: 'authored' }),
    kind({ kind: 'question', origins: ['person'], count: 0, nav: 'loop', group: 'authored' }),
  ];
  (globalThis as { fetch?: unknown }).fetch = async (url: string) => {
    if (url.endsWith('/api/status')) return json(status({ kinds, groups: [{ group: 'authored', labels: { en: 'Authored' }, open: true }] }));
    if (url.endsWith('/api/products')) return json({ products: [] });
    if (url.endsWith('/api/agents')) return json({ agents: [], chosen: null });
    if (url.endsWith('/api/settings')) return json({ role: 'everything', asked: true, roles: [] });
    if (url.endsWith('/api/glossary')) return json({ terms: [], resolutions: {}, findings: [] });
    if (url.includes('/api/authored?')) return json({ kind: new URL(url, 'http://localhost').searchParams.get('kind'), fields: [], entities: [] });
    return json({ message: 'not here' }, 404);
  };
  const app = into(createElement(AppRoot));
  await until(() => app.querySelector('[data-nav-kind="question"]') !== null, 'all authored navigation rows');
  for (const entry of kinds) {
    const row = app.querySelector(`[data-nav-kind="${entry.kind}"]`)! as HTMLAnchorElement;
    expect(row.getAttribute('href')).toBe(`/kind/${entry.kind}`);
    row.click();
    await until(() => app.querySelector(`[data-testid="authored-kind-page"]`)?.textContent?.includes('New'), `New for ${entry.kind}`);
  }
  expect(app.querySelector('[data-testid="nav-questions"]')).toBeNull();
  expect(app.querySelector('[data-testid="nav-tasks"]')).toBeNull();
});
