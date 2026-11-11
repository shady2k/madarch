/**
 * The file table below the map (madarch-j9ao.1): filtered by path text, by
 * language and by a range of the colour measure, sorted by any column, and paged
 * by the graph key of the row a page ended on.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setWikiLanguage } from '../i18n.js';
import { BlockView } from './blocks.js';
import type { Block, FilesMap, FilesMapFile } from './types.js';
import { tableRows, type TableQuery } from './files-table.js';

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
  throw new Error(`never came to ${what}; the tree holds: ${document.body.innerHTML.slice(0, 1500)}`);
}
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = '';
});

/** Picks one value of a select, the way a reader does: the native setter, then the event React listens for. */
function pick(select: HTMLSelectElement, value: string): void {
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
}

const file = (path: string, lines: number, heat: [number, number, number, number], language: string | null, authors: string[], last: string | null): FilesMapFile => ({
  id: `code.file:shop/${path}`, path, href: `/e/${encodeURIComponent(`code.file:shop/${path}`)}`,
  lines, bytes: lines * 10, language, languages: language === null ? [] : [{ language, saidBy: 'linguist@9.5.0' }], heat, last, authors,
});

const DATA: FilesMap = {
  repository: 'shop',
  folder: '',
  files: [
    file('src/order.go', 400, [1, 4, 7, 9], 'Go', ['Ada', 'Linus'], '2026-11-01T10:00:00Z'),
    file('src/pricing.go', 100, [0, 1, 2, 2], 'Go', ['Ada'], '2026-10-20T10:00:00Z'),
    file('docs/readme.md', 40, [0, 0, 0, 0], null, [], null),
    file('src/checkout.ts', 250, [2, 6, 6, 6], 'TypeScript', ['Linus'], '2026-11-05T10:00:00Z'),
  ],
  totals: { files: 4, lines: 790, bytes: 7900, withoutLines: 0, other: 1, languages: [] },
  windows: { d30: '2026-10-01T00:00:00Z', d90: '2026-08-01T00:00:00Z', d365: '2025-11-01T00:00:00Z' },
  graphTotal: 4,
};

const block = (over: Partial<Extract<Block, { type: 'files' }>> = {}): Block => ({
  type: 'files', title: 'Files', data: DATA, area: 'lines', colour: 'heat', window: '90d', pageSize: 2, notes: [], ...over,
});

const rows = (container: HTMLElement): string[] => [...container.querySelectorAll('[data-testid=files-row]')].map((row) => row.getAttribute('data-path') ?? '');

describe('the file table', () => {
  test('the first page follows the path in code point order, and a row opens the file\'s page', async () => {
    const container = into(createElement(BlockView, { block: block(), resolutions: {} }));
    await until(() => container.querySelectorAll('[data-testid=files-row]').length === 2, 'the first page');
    expect(rows(container)).toEqual(['docs/readme.md', 'src/checkout.ts']);
    expect(container.querySelector<HTMLAnchorElement>('[data-testid=files-row-link]')!.getAttribute('href')).toBe(`/e/${encodeURIComponent('code.file:shop/docs/readme.md')}`);
    expect(container.querySelector('[data-testid=files-range]')!.textContent).toBe('1–2 of 4 matching, 4 in the map');
  });

  test('the next page starts after the key the last one ended on, and back returns to it', async () => {
    const container = into(createElement(BlockView, { block: block(), resolutions: {} }));
    await until(() => container.querySelectorAll('[data-testid=files-row]').length === 2, 'the first page');
    container.querySelector<HTMLButtonElement>('[data-testid=files-next]')!.click();
    await until(() => rows(container).join(',') === 'src/order.go,src/pricing.go', 'the second page');
    expect(container.querySelector('[data-testid=files-range]')!.textContent).toBe('3–4 of 4 matching, 4 in the map');
    expect(container.querySelector<HTMLButtonElement>('[data-testid=files-next]')!.disabled).toBe(true);
    container.querySelector<HTMLButtonElement>('[data-testid=files-prev]')!.click();
    await until(() => rows(container).join(',') === 'docs/readme.md,src/checkout.ts', 'the first page again');
  });

  test("a file's open language opinions all stand, with their sources; no producer is picked", async () => {
    const disagreed = { ...file('src/order.go', 400, [1, 4, 7, 9], null, ['Ada'], '2026-11-01T10:00:00Z'), languages: [{ language: 'TypeScript', saidBy: 'linguist@9.5.0' }, { language: 'XML', saidBy: 'agent' }] };
    const unknown = { ...file('src/pricing.go', 100, [0, 1, 2, 2], null, ['Ada'], '2026-10-20T10:00:00Z'), languages: [{ language: 'unknown', saidBy: 'linguist@9.5.0' }] };
    const data = { ...DATA, files: [disagreed, unknown] };
    const container = into(createElement(BlockView, { block: block({ data, pageSize: 10 }), resolutions: {} }));
    await until(() => container.querySelectorAll('[data-testid=files-row]').length === 2, 'both rows');
    const cells = [...container.querySelectorAll('[data-testid=files-row] td:nth-child(2)')];
    // Two opinions that disagree name both languages; the dataset's `unknown` reads as the reader's word for other.
    expect(cells.map((cell) => cell.textContent)).toEqual(['TypeScript · XML', 'Other']);
    expect(cells[0]!.getAttribute('title')).toBe('TypeScript — linguist@9.5.0\nXML — agent');
    expect(cells[1]!.getAttribute('title')).toBe('Other — linguist@9.5.0');
    // The colour and the filter see no one language for either file: Other.
    const filter = container.querySelector<HTMLSelectElement>('[data-testid=files-filter-language]')!;
    expect([...filter.options].some((option) => option.value === 'TypeScript')).toBe(false);
    expect([...filter.options].some((option) => option.value === '__other')).toBe(true);
  });

  test('a text, a language and a range of the measure each narrow the rows', () => {
    const base: TableQuery = { text: '', language: '', measure: 'heat', window: '90d', from: '', to: '', sort: 'path', ascending: true, cursor: null };
    const paths = (query: Partial<TableQuery>): string[] => tableRows(DATA.files, { ...base, ...query }, Date.parse('2026-11-10T00:00:00Z'), 10).rows.map((row) => row.file.path);
    expect(paths({ text: 'ORDER' })).toEqual(['src/order.go']);
    expect(paths({ language: 'Go' })).toEqual(['src/order.go', 'src/pricing.go']);
    expect(paths({ language: '__other' })).toEqual(['docs/readme.md']);
    expect(paths({ from: '5' })).toEqual(['src/checkout.ts']);
    expect(paths({ from: '2', to: '4' })).toEqual(['src/order.go']);
    // Age measured from the day the page is read: a file no commit touched has no age and falls out of a range.
    expect(paths({ measure: 'age', from: '1', to: '10' })).toEqual(['src/checkout.ts', 'src/order.go']);
    expect(paths({ measure: 'authors', from: '2' })).toEqual(['src/order.go']);
  });

  test('a page starts after the graph key it was given, so no row repeats or vanishes', () => {
    const base: TableQuery = { text: '', language: '', measure: 'heat', window: '90d', from: '', to: '', sort: 'path', ascending: true, cursor: null };
    const first = tableRows(DATA.files, base, Date.now(), 2);
    expect(first.rows.map((row) => row.file.path)).toEqual(['docs/readme.md', 'src/checkout.ts']);
    expect(first.more).toBe(true);
    const second = tableRows(DATA.files, { ...base, cursor: first.rows[1]!.file.id }, Date.now(), 2);
    expect(second.rows.map((row) => row.file.path)).toEqual(['src/order.go', 'src/pricing.go']);
    expect(second.total).toBe(4);
    expect(second.more).toBe(false);
    // A cursor whose row a filter removed starts the page at the first row, never in the middle of nowhere.
    const gone = tableRows(DATA.files, { ...base, cursor: 'code.file:shop/gone.ts' }, Date.now(), 2);
    expect(gone.rows.map((row) => row.file.path)).toEqual(['docs/readme.md', 'src/checkout.ts']);
  });

  test('sorting by a column puts its largest first, and a file with no count last', async () => {
    const container = into(createElement(BlockView, { block: block({ pageSize: 10 }), resolutions: {} }));
    await until(() => container.querySelectorAll('[data-testid=files-row]').length === 4, 'every row');
    container.querySelector<HTMLButtonElement>('[data-testid=files-sort-lines]')!.click();
    await until(() => rows(container)[0] === 'docs/readme.md', 'the smallest first');
    expect(container.querySelector('[data-testid=files-sort-lines]')!.closest('th')!.getAttribute('aria-sort')).toBe('ascending');
    container.querySelector<HTMLButtonElement>('[data-testid=files-sort-lines]')!.click();
    await until(() => rows(container)[0] === 'src/order.go', 'the largest first');
    expect(rows(container)).toEqual(['src/order.go', 'src/checkout.ts', 'src/pricing.go', 'docs/readme.md']);
  });

  test('the heat column follows the window the reader picks', async () => {
    const container = into(createElement(BlockView, { block: block({ pageSize: 10 }), resolutions: {} }));
    await until(() => container.querySelectorAll('[data-testid=files-row]').length === 4, 'every row');
    const heatOf = (path: string): string => container.querySelector(`[data-testid=files-row][data-path="${path}"] [data-testid=files-row-heat]`)!.textContent ?? '';
    expect(heatOf('src/order.go')).toBe('4');
    const window = container.querySelector<HTMLSelectElement>('[data-testid=files-filter-window]')!;
    pick(window, '30d');
    await until(() => heatOf('src/order.go') === '1', 'the 30 days count');
  });
});
