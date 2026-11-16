/** Folder navigation, honest missing measures, connection bounds and recency from graph dates. */
import { afterAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/' });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { i18n } = await import('../i18n.js');
const { TreemapSection } = await import('./treemap.js');
import type { SectionContext } from './types.js';
await i18n.changeLanguage('en');
afterAll(() => { GlobalRegistrator.unregister(); });
const now = Date.now();
const node = (id: string, path: unknown, bytes: unknown, language: unknown, lastChange: unknown) => ({ node: { id, kind: 'sample.entry', path, bytes, lines: 5, language, lastChange } });
const sample = [node('1', 'src/a.ts', 100, 'TypeScript', new Date(now - 86_400_000).toISOString()), node('2', 'src/b.ts', null, null, null), node('3', 'readme.md', 20, 'Markdown', '2000-01-01'), node('4', null, 50, 'Rust', null)];
async function render(rows = sample, params: Record<string, unknown> = {}, hasNext = true, query?: string) {
  const opened: string[] = [];
  const reloaded: Record<string, unknown>[] = [];
  const context: SectionContext = { section: { id: 'map', component: 'treemap', alias: 'map', on: 'root', replace: false, line: 1, ...(query === undefined ? {} : { query }), params: { path: 'files', pathPath: 'node.path', valuePath: 'node.bytes', languagePath: 'node.language', changedPath: 'node.lastChange', ...params } },
    data: { files: { edges: rows, pageInfo: { hasNextPage: hasNext, endCursor: 'next-files' } } }, language: 'en', base: '/products/shop', busy: false, variables: {}, open: (path) => { opened.push(path); }, reload: (variables) => { reloaded.push(variables); }, renderSection: () => null, product: 'shop', navigation: null, pageName: null };
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(TreemapSection, { context })); });
  return { host, opened, reloaded, close: async () => { await act(async () => { root.unmount(); }); host.remove(); } };
}
async function choose(host: HTMLElement, name: string, value: string) {
  const trigger = host.querySelector(`[aria-label="${name}"][role="combobox"]`) as HTMLElement;
  await act(async () => { trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
  const option = [...document.querySelectorAll('[role="option"]')].find((one) => one.textContent === value) as HTMLElement;
  expect(option).toBeDefined();
  await act(async () => { option.click(); });
}
test('a connection page is explicitly a subset; folders drill and breadcrumbs return; file links name graph entities', async () => {
  const page = await render();
  try {
    expect(page.host.textContent).toContain('not the whole map');
    expect(page.host.textContent).toContain('Files without a path cannot be placed: 1');
    const button = [...page.host.querySelectorAll('button')].find((one) => one.textContent === 'Open folder src/')!;
    await act(async () => { button.click(); });
    expect(page.host.textContent).toContain('src/a.ts');
    expect(page.host.querySelector('[data-testid="chart-missing"]')?.textContent).toContain('b.ts');
    const link = page.host.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('/products/shop/e/sample.entry/1');
    await act(async () => { link.click(); });
    expect(page.opened).toEqual(['/products/shop/e/sample.entry/1']);
    const root = [...page.host.querySelectorAll('button')].find((one) => one.textContent === 'All files')!;
    await act(async () => { root.click(); });
    expect(page.host.textContent).toContain('Open folder src/');
    expect(page.host.querySelector('[data-testid="treemap-legend"]')?.textContent).toContain('TypeScript');
  } finally { await page.close(); }
});
test('last-change controls use dated recency, distinguish missing dates, and change with the window', async () => {
  const page = await render();
  try {
    await choose(page.host, 'Colour by', 'Last change');
    expect(page.host.textContent).toContain('recency, not a count of commits');
    expect(page.host.textContent).toContain('unknown or future last-change dates: 1');
    const fill = () => page.host.querySelector('[data-series="src/a.ts"]')?.getAttribute('fill');
    const initial = fill();
    expect(initial).toContain('color-mix');
    await choose(page.host, 'Last-change window', '7 days');
    expect(fill()).not.toBe(initial);
    expect(page.host.querySelector('[data-series="readme.md"]')?.getAttribute('fill')).toBe('var(--surface-soft)');
  } finally { await page.close(); }
});
test('area switch reads the selected graph field and never invents missing bytes', async () => {
  const page = await render([node('a', 'a.ts', null, null, null)], { valuePaths: [{ path: 'node.bytes', label: { en: 'Bytes', ru: 'Байты' } }, { path: 'node.lines', label: { en: 'Lines', ru: 'Строки' } }] }, false);
  try {
    expect(page.host.textContent).toContain('No measured file values');
    expect(page.host.textContent).toContain('value not known');
    expect(page.host.querySelector('[data-testid="treemap-subset"]')).toBeNull();
    await choose(page.host, 'Area measure', 'Lines');
    expect(page.host.querySelector('[data-part="mark"]')).not.toBeNull();
    expect(page.host.textContent).toContain('5');
  } finally { await page.close(); }
});
test('a folder root never exposes its siblings and zero bytes remain zero rather than a made-up area', async () => {
  const page = await render([node('a', 'src/a.ts', 0, 'TypeScript', null), node('b', 'else/b.ts', 20, 'TypeScript', null)], { rootPath: 'src' }, false);
  try {
    expect(page.host.textContent).toContain('src/a.ts');
    expect(page.host.textContent).not.toContain('else/b.ts');
    expect(page.host.querySelector('[data-part="mark"]')).toBeNull();
    expect(page.host.textContent).toContain('0');
    expect(page.host.textContent).not.toContain('value not known');
  } finally { await page.close(); }
});

test('paging reads the section cursor variable and returns to the first page without claiming a full map', async () => {
  const page = await render(sample, {}, true, 'query($map_after:String) { files(after:$map_after) { totalCount } }');
  try {
    const buttons = () => [...page.host.querySelectorAll('button')];
    const next = buttons().find((one) => one.textContent === i18n.t('knowledge.nextPage'))!;
    const previous = () => buttons().find((one) => one.textContent === i18n.t('knowledge.previousPage'))!;
    expect(previous().disabled).toBe(true);
    await act(async () => { next.click(); });
    expect(page.reloaded).toEqual([{ map_after: 'next-files' }]);
    expect(previous().disabled).toBe(false);
    await act(async () => { previous().click(); });
    expect(page.reloaded[1]).toEqual({ map_after: null });
    expect(page.host.textContent).toContain('not the whole map');
  } finally { await page.close(); }
});
