import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setWikiLanguage } from '../i18n.js';
import { CataloguePage } from './pages.js';
import { localeKeyIn, renderedText } from '../../test/locale-keys.js';
import type { CatalogView } from './types.js';

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
  groups: [{ group: 'code', labels: { en: 'Code', ru: 'Код' } }, { group: 'requirements', labels: { en: 'Requirements', ru: 'Требования' } }, { group: 'vocabulary', parent: 'requirements', labels: { en: 'Vocabulary', ru: 'Словарь' } }],
  kinds: [
    { kind: 'code.file', area: 'code', subgroup: '', count: 12, page: true, filled: true, plugins: ['files'], state: 'filled', estimate: { volume: 12, unit: 'vertices', tokensPerUnit: null, secondsPerUnit: null, tokens: null, seconds: null }, labels: { en: { one: 'File', many: 'Files' }, ru: { one: 'Файл', many: 'Файлы' } }, descriptions: { en: 'Source files', ru: 'Исходные файлы' } },
    { kind: 'doc.term', area: 'requirements', subgroup: 'vocabulary', count: 3, page: true, filled: true, plugins: ['glossary'], dependsOn: ['code.file'], state: 'partial', estimate: { volume: 12, unit: 'vertices', tokensPerUnit: null, secondsPerUnit: null, tokens: null, seconds: null }, labels: { en: { one: 'Term', many: 'Terms' } } },
    { kind: 'doc.use-case', area: 'requirements', subgroup: '', count: 0, page: true, filled: false, state: 'never', estimate: { volume: 0, unit: 'vertices', tokensPerUnit: null, secondsPerUnit: null, tokens: null, seconds: null }, labels: { en: { one: 'Use case', many: 'Use cases' } } },
  ],
  findings: [],
};

/** Browsing reads only the catalogue. Every request is recorded, including unexpected writes. */
function stub(calls: { url: string; method: string }[], catalog: CatalogView = CATALOG): void {
  (globalThis as { fetch?: unknown }).fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    if (url.includes('/api/catalog')) return json(catalog);
    return json({ message: 'not here' }, 404);
  };
}

describe('the catalogue as a browse-only view', () => {
  test('the source popover names the declaration line, page template and plugin folder', async () => {
    await setWikiLanguage('en');
    stub([], { ...CATALOG, kinds: [{ ...CATALOG.kinds[0]!, declaration: { repo: 'shop', path: 'madarch/kinds.yaml', line: 42 }, template: { repo: 'shop', path: 'templates/file.liquid' }, pluginFolders: ['plugins/files'] }] });
    const page = into(createElement(CataloguePage, { version: 0 }));
    await until(() => page.querySelector('[data-testid="kind-source-trigger"]') !== null, 'source trigger');
    page.querySelector<HTMLButtonElement>('[data-testid="kind-source-trigger"]')!.click();
    await until(() => document.querySelector('[data-testid="kind-source-popover"]') !== null, 'source popover');
    const popover = document.querySelector('[data-testid="kind-source-popover"]')!;
    expect(popover.textContent).toContain('madarch/kinds.yaml:42');
    expect(popover.textContent).toContain('templates/file.liquid');
    expect(popover.querySelector('[data-testid="kind-source-producer"]')!.textContent).toBe('plugins/files');
    expect(popover.querySelector('[data-testid="kind-declaration"]')!.getAttribute('href')).toBe('/src?repo=shop&path=madarch%2Fkinds.yaml&line=42');
    expect(localeKeyIn(renderedText(popover as HTMLElement))).toBeUndefined();
  });

  test('contents lists every section and kind and jumps to the selected section', async () => {
    await setWikiLanguage('en');
    stub([]);
    const page = into(createElement(CataloguePage, { version: 0 }));
    await until(() => page.querySelector('[data-testid="catalogue-contents"]') !== null, 'catalogue contents');
    const contents = page.querySelector('[data-testid="catalogue-contents"]')!;
    const links = [...contents.querySelectorAll<HTMLAnchorElement>('a')];
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Code', '#catalogue-section-code'],
      ['Files', '#catalogue-kind-code.file'],
      ['Requirements', '#catalogue-section-requirements'],
      ['Use cases', '#catalogue-kind-doc.use-case'],
      ['Vocabulary', '#catalogue-section-vocabulary'],
      ['Terms', '#catalogue-kind-doc.term'],
    ]);
    const requirements = contents.querySelector('a[href="#catalogue-section-requirements"]')!;
    expect(requirements.parentElement!.querySelector('a[href="#catalogue-section-vocabulary"]')).not.toBeNull();
    expect(contents.querySelector('[data-kind]')).toBeNull();
    const section = page.querySelector<HTMLElement>('#catalogue-section-requirements')!;
    const scroll = spyOn(section, 'scrollIntoView');
    try {
      (requirements as HTMLAnchorElement).click();
      await until(() => scroll.mock.calls.length > 0, 'section scroll');
      expect(scroll).toHaveBeenCalledWith({ block: 'start' });
    } finally {
      scroll.mockRestore();
    }
  });

  test('contents switches from Graph to Table before scrolling to a section', async () => {
    await setWikiLanguage('en');
    stub([]);
    const page = into(createElement(CataloguePage, { version: 0 }));
    await until(() => page.querySelector('[data-testid="catalogue-contents"]') !== null, 'catalogue contents');
    const graphTab = [...page.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === 'Graph')!;
    graphTab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    await until(() => page.querySelector('[role="tabpanel"][data-state="active"] [data-testid="kind-graph"]') !== null, 'graph view');
    const scrolled: Element[] = [];
    const scroll = spyOn(window.HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (this: HTMLElement) {
      scrolled.push(this);
    });
    try {
      page.querySelector<HTMLAnchorElement>('[data-testid="catalogue-contents"] a[href="#catalogue-section-vocabulary"]')!.click();
      await until(() => scrolled.length > 0, 'section scroll after switching views');
      const section = page.querySelector('[role="tabpanel"][data-state="active"] #catalogue-section-vocabulary');
      expect(section).not.toBeNull();
      expect(scrolled).toEqual([section!]);
      expect(scroll).toHaveBeenCalledWith({ block: 'start' });
      expect(page.querySelector('[role="tabpanel"][data-state="active"] [data-testid="kind-graph"]')).toBeNull();
    } finally {
      scroll.mockRestore();
    }
  });

  test('Table and Graph share the filter, chosen kind and dependency highlights', async () => {
    stub([]);
    const page = into(createElement(CataloguePage, { version: 0 }));
    await until(() => page.querySelector('[data-kind="doc.term"]') !== null, 'table kinds');
    const kinds = [...page.querySelectorAll('[data-kind]')].map((row) => row.getAttribute('data-kind')).sort();
    (page.querySelector('[data-kind="code.file"] button[aria-pressed]') as HTMLButtonElement).click();
    await until(() => page.querySelector('[data-kind="doc.term"]')?.getAttribute('data-related') === 'true', 'dependent highlight');
    const graphTab = [...page.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === 'Graph')!;
    graphTab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    await until(() => page.querySelector('[role="tabpanel"][data-state="active"] [data-testid="kind-graph"]') !== null, 'graph kinds');
    expect([...page.querySelectorAll('[role="tabpanel"][data-state="active"] [data-kind]')].map((row) => row.getAttribute('data-kind')).sort()).toEqual(kinds);
    expect(page.querySelector('[role="tabpanel"][data-state="active"] [data-kind="code.file"]')!.getAttribute('data-chosen')).toBe('true');
    expect(page.querySelector('[role="tabpanel"][data-state="active"] [data-kind="doc.term"]')!.getAttribute('data-related')).toBe('true');
    expect(localeKeyIn(renderedText(page))).toBeUndefined();
    const input = page.querySelector('input[type="search"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    input.focus();
    setter.call(input, 'Source files');
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 's' }));
    await until(() => page.querySelectorAll('[role="tabpanel"][data-state="active"] [data-kind]').length === 1, 'filtered graph');
    const filteredContents = [...page.querySelectorAll<HTMLAnchorElement>('[data-testid="catalogue-contents"] a')];
    expect(filteredContents.map((link) => link.getAttribute('href'))).toEqual(['#catalogue-section-code', '#catalogue-kind-code.file']);
    const tableTab = [...page.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === 'Table')!;
    tableTab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    await until(() => page.querySelector('[role="tabpanel"][data-state="active"] [data-kind="code.file"]') !== null, 'filtered table');
    expect(page.querySelectorAll('[role="tabpanel"][data-state="active"] [data-kind]')).toHaveLength(1);
    expect(page.querySelector('[role="tabpanel"][data-state="active"] [data-kind="code.file"]')!.getAttribute('data-chosen')).toBe('true');
    expect(page.querySelector('[role="tabpanel"][data-state="active"] [data-kind="code.file"] a')!.getAttribute('href')).toContain('code.file');
  });

  test('shows standards and the product declaration file together with navigable source line', async () => {
    await setWikiLanguage('en');
    stub([], { ...CATALOG, kinds: [{ ...CATALOG.kinds[0]!, sources: ['https://example.test/standard'], declaration: { repo: 'shop', path: 'madarch/kinds.yaml', line: 42 } }] });
    const page = into(createElement(CataloguePage, { version: 0 }));
    await until(() => page.querySelector('[data-testid="kind-declaration"]') !== null, 'kind sources');
    const row = page.querySelector('[data-kind="code.file"]')!;
    expect(row.querySelector('a[href="https://example.test/standard"]')).not.toBeNull();
    const link = row.querySelector('[data-testid="kind-declaration"]')!;
    expect(link.textContent).toBe('madarch/kinds.yaml:42');
    const url = new URL(link.getAttribute('href')!, 'http://localhost');
    expect(url.pathname).toBe('/src');
    expect(Object.fromEntries(url.searchParams)).toEqual({ repo: 'shop', path: 'madarch/kinds.yaml', line: '42' });
  });

  test('shows kinds by section, their meaning, record links, producers and states without fill controls', async () => {
    await setWikiLanguage('en');
    const calls: { url: string; method: string }[] = [];
    stub(calls);
    const page = into(createElement(CataloguePage, { version: 0 }));
    await until(() => page.querySelector('[data-kind="doc.term"]') !== null, 'the catalogue');
    expect(page.querySelectorAll('[data-kind]')).toHaveLength(3);
    expect(page.querySelector('[data-kind="code.file"]')!.textContent).toContain('Source files');
    expect(page.querySelector('[data-kind="code.file"] [data-testid="catalogue-count"] a')!.textContent).toBe('12');
    expect(page.querySelector('[data-kind="code.file"] [data-testid="catalogue-count"] a')!.getAttribute('href')).toContain('code.file');
    expect(page.querySelector('[data-kind="doc.term"] [data-testid="catalogue-stage"]')!.textContent).toContain('glossary');
    expect(page.querySelector('[data-kind="doc.term"] [data-testid="catalogue-state"]')!.getAttribute('data-state')).toBe('partial');
    expect(page.querySelector('[data-kind="doc.use-case"] [data-testid="catalogue-state"]')!.getAttribute('data-state')).toBe('never');
    expect(page.querySelector('[data-subgroup="vocabulary"] [data-kind="doc.term"]')).not.toBeNull();
    expect(page.querySelectorAll('th')).toHaveLength(15);
    expect(page.querySelector('select, [role="checkbox"], [data-testid="fill-setup-run"], [data-testid="catalogue-panel"], [data-testid="catalogue-waiting"], [data-testid="catalogue-no-translation"]')).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toContain('/api/catalog');
    expect(localeKeyIn(renderedText(page))).toBeUndefined();
  });

  test('counts kinds separately from records, including subgroup records', async () => {
    await setWikiLanguage('en');
    stub([]);
    const page = into(createElement(CataloguePage, { version: 0 }));
    await until(() => page.querySelector('[data-testid="catalogue-total"]') !== null, 'the totals');
    expect(page.querySelector('[data-testid="catalogue-total"]')!.textContent).toBe('3 kinds, 15 records');
    expect(page.querySelector('[data-group="requirements"] [data-testid="catalogue-group-total"]')!.textContent).toBe('2 kinds, 3 records');
    expect(page.querySelector('[data-kind="doc.use-case"] [data-testid="catalogue-count"]')!.textContent).toBe('0');
    expect(page.querySelector('[data-kind="doc.use-case"] [data-testid="catalogue-count"] a')).toBeNull();
  });

  test('uses the reader language without warnings or exposing missing locale keys', async () => {
    await setWikiLanguage('ru');
    stub([]);
    const page = into(createElement(CataloguePage, { version: 0 }));
    await until(() => page.querySelector('[data-kind="code.file"]') !== null, 'the Russian catalogue');
    expect(page.querySelector('[data-kind="code.file"]')!.textContent).toContain('Файлы');
    expect(page.querySelector('[data-kind="code.file"]')!.textContent).toContain('Исходные файлы');
    expect(page.querySelector('[data-group="requirements"] h2')!.textContent).toContain('Требования');
    expect(page.querySelector('[data-kind="doc.use-case"]')!.textContent).toContain('doc.use-case');
    expect(page.querySelector('[data-testid="catalogue-no-translation"], [role="alert"]')).toBeNull();
    expect(localeKeyIn(renderedText(page))).toBeUndefined();
  });

  test('a failed fill turn is shown as failed rather than only partial', async () => {
    await setWikiLanguage('en');
    stub([], { ...CATALOG, kinds: [{ ...CATALOG.kinds[0]!, state: 'partial', turn: 'failed' }] });
    const page = into(createElement(CataloguePage, { version: 0 }));
    await until(() => page.querySelector('[data-testid="catalogue-state"]') !== null, 'the failed kind');
    expect(page.querySelector('[data-testid="catalogue-state"]')!.getAttribute('data-state')).toBe('failed');
    expect(page.querySelector('[data-testid="catalogue-state"]')!.textContent).toBe('Failed');
  });

  test('keeps kinds without pages and kinds in unknown sections visible', async () => {
    await setWikiLanguage('en');
    stub([], { ...CATALOG, kinds: [{ ...CATALOG.kinds[0]!, kind: 'note', area: 'unknown', subgroup: '', page: false, count: 4 }] });
    const page = into(createElement(CataloguePage, { version: 0 }));
    await until(() => page.querySelector('[data-kind="note"]') !== null, 'the other section');
    expect(page.querySelectorAll('[data-testid="catalogue-group"]')).toHaveLength(1);
    expect(page.querySelector('[data-kind="note"] a')).toBeNull();
    expect(page.querySelector('[data-testid="catalogue-total"]')!.textContent).toBe('1 kind, 4 records');
  });
});
