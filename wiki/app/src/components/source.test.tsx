import { afterAll, beforeEach, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/' });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { SourceSection, SourcePageSection } = await import('./source.js');
const { setWikiLanguage } = await import('../i18n.js');
import type { SectionContext } from './types.js';
afterAll(() => GlobalRegistrator.unregister());
const requests: { query: string; variables: Record<string, unknown> }[] = [];
let response: unknown;
beforeEach(async () => {
  await setWikiLanguage('en');
  requests.length = 0;
  response = { text: 'const a = 1;\n', language: 'typescript', lines: 40, binary: false, from: 12, complete: false, next: { line: 13, column: 1 } };
  globalThis.fetch = (async (input, init) => {
    expect(String(input)).toBe('/products/shop/graphql');
    requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ data: { source: response, file: { id: 'file/core/src/a.ts', kind: 'fixture.file' } } }));
  }) as typeof fetch;
});
function context(data: unknown): SectionContext {
  return { data, section: { id: 'source', alias: 'source', on: 'root', replace: false, line: 1, component: 'source', params: { path: '.', urlPath: 'url', repoVariable: 'repo', pathVariable: 'path' } }, variables: { repo: 'core', path: 'src/a.ts' }, language: 'en', base: '/products/shop', busy: false, open() {}, reload() {}, renderSection() { return null; }, product: null, navigation: null, pageName: 'source' };
}
async function mount(component: typeof SourceSection, data: unknown) {
  const box = document.createElement('div'); document.body.append(box);
  const root = createRoot(box);
  await act(async () => { root.render(createElement(component, { context: context(data) })); });
  return { box, async close() { await act(async () => root.unmount()); box.remove(); } };
}
test('a citation reads its exact line range from GraphQL, names its source address and the host', async () => {
  const view = await mount(SourceSection, { repository: 'core', path: 'src/a.ts', lineStart: 12, lineEnd: 20, url: 'https://example.org/core/blob/main/src/a.ts#L12' });
  expect(requests[0]?.variables).toEqual({ repository: 'core', path: 'src/a.ts', from: 12, to: 20 });
  expect(view.box.textContent).toContain('core: src/a.ts:12-20');
  expect(view.box.textContent).toContain('typescript');
  expect(view.box.textContent).toContain('const a = 1;');
  expect(view.box.querySelector('[data-testid="source-excerpt"]')?.textContent).toStartWith('12  ');
  expect(view.box.querySelector('[data-testid="source-excerpt"] [style]')).not.toBeNull();
  expect(view.box.textContent).toContain('Showing 1 of 9 cited lines.');
  expect(view.box.querySelector('a')?.getAttribute('href')).toBe('/products/shop/e/fixture.file/file%2Fcore%2Fsrc%2Fa.ts#L12');
  const web = view.box.querySelector('a[target="_blank"]');
  expect(web?.textContent).toBe('Open on example.org');
  expect(web?.getAttribute('rel')).toContain('noopener');
  await view.close();
});
test('missing locations do not request guessed sources and non-web URLs do not become links', async () => {
  const missing = await mount(SourceSection, { path: 'src/a.ts' });
  expect(requests).toHaveLength(0);
  expect(missing.box.textContent).toContain('The graph holds no source location.');
  await missing.close();
  response = { text: '', language: null, lines: 0, binary: true, from: 1, complete: true, next: null };
  const binary = await mount(SourceSection, { repository: 'core', path: 'image.bin', url: 'javascript:alert(1)' });
  expect(binary.box.textContent).toContain('binary file');
  expect(binary.box.querySelector('a[target="_blank"]')).toBeNull();
  await binary.close();
});
test('the source template draws source with repository and line-count badges', async () => {
  response = { text: 'hello\n', language: null, lines: 1, binary: false, from: 1, complete: true, next: null };
  const view = await mount(SourcePageSection, {});
  expect(requests[0]?.variables).toEqual({ repository: 'core', path: 'src/a.ts', from: 1 });
  expect(view.box.textContent).toContain('core');
  expect(view.box.textContent).toContain('1 lines');
  expect(view.box.querySelector('.file-source-code')?.textContent).toBe('hello');
  expect(view.box.querySelector('#L1 a')?.getAttribute('href')).toBe('#L1');
  await view.close();
});
test('a missing graph source is an explicit error', async () => {
  response = null;
  const view = await mount(SourceSection, { repository: 'core', path: 'gone.ts' });
  expect(view.box.querySelector('[role="alert"]')?.textContent).toContain('The graph holds no text for this file.');
  await view.close();
});


test('source continuation pins the blob and exact inside-line cursor, appending both ranges', async () => {
  response = { text: 'hel', blob: 'first', language: null, lines: 1, binary: false, from: 1, complete: false, next: { line: 1, column: 4 } };
  const view = await mount(SourcePageSection, {});
  response = { text: 'lo\n', blob: 'first', language: null, lines: 1, binary: false, from: 1, complete: true, next: null };
  await act(async () => { view.box.querySelector('button')?.click(); });
  expect(requests[1]?.variables).toEqual({ repository: 'core', path: 'src/a.ts', from: 1, fromColumn: 4, blob: 'first' });
  expect(view.box.querySelector('.file-source-code')?.textContent).toBe('hello');
  expect(view.box.querySelector('button')).toBeNull();
  await view.close();
});

test('a moved blob replaces old source rather than mixing revisions', async () => {
  response = { text: 'old\n', blob: 'first', language: null, lines: 2, binary: false, from: 1, complete: false, next: { line: 2, column: 1 } };
  const view = await mount(SourcePageSection, {});
  response = { text: 'new\n', blob: 'second', moved: true, language: null, lines: 1, binary: false, from: 1, complete: true, next: null };
  await act(async () => { view.box.querySelector('button')?.click(); });
  expect(view.box.querySelector('.file-source-code')?.textContent).toBe('new');
  expect(view.box.textContent).not.toContain('old');
  expect(view.box.textContent).toContain('The file changed');
  await view.close();
});
