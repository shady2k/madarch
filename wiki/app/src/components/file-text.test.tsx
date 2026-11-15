/**
 * A file's text on its page (madarch-u3vw.16): the section asks for ranges by (repository, path), draws a Markdown file
 * rendered by the Sources page's own component with a Rendered / Source switch, shows any other text as source with line
 * numbers, and says a binary file has no text. The server's read is mocked here; the plugin read is tested in the repo.
 */
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register({ url: 'http://localhost/' });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { EventSource?: unknown }).EventSource = undefined;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { FileTextSection } = await import('./file-text.js');
const { setWikiLanguage } = await import('../i18n.js');

afterAll(() => { GlobalRegistrator.unregister(); });

const requests: string[] = [];
let answer: { text: string; lines: number; bytes: number; binary: boolean; blob: string; from: number; repository: string; path: string } = { text: '', lines: 0, bytes: 0, binary: false, blob: 'a'.repeat(40), from: 1, repository: 'sample', path: 'docs/vision.md' };

beforeEach(async () => {
  requests.length = 0;
  await setWikiLanguage('ru');
  (globalThis as { fetch: typeof fetch }).fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input), 'http://localhost');
    requests.push(url.pathname + url.search);
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
});

function context(path: string, repository = 'sample'): Record<string, unknown> {
  return {
    section: { id: 'filetext', component: 'file-text', on: 'subject', replace: false, params: { repositoryPath: 'repository', pathPath: 'path', chunk: 400 }, line: 1, alias: 's_filetext' },
    data: { repository, path }, language: 'ru', base: '', busy: false, variables: {}, open: () => undefined, reload: () => undefined,
    renderSection: () => null, product: null, navigation: null, pageName: null,
  };
}

async function settle(): Promise<void> {
  for (let at = 0; at < 12; at += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
}

async function render(section: Record<string, unknown>): Promise<{ container: HTMLElement; close: () => Promise<void> }> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(FileTextSection, { context: section as never })); });
  await settle();
  return { container, close: async () => { await act(async () => { root.unmount(); }); container.remove(); } };
}

test('a Markdown file opens rendered by the documents\' component, with the Rendered / Source switch', async () => {
  answer = { ...answer, text: '# Vision\n\nThe product\'s first page.\n', lines: 3 };
  const page = await render(context('docs/vision.md'));
  try {
    expect(requests[0]).toContain('/api/source');
    expect(requests[0]).toContain('repo=sample');
    expect(requests[0]).toContain('path=docs%2Fvision.md');
    expect(requests[0]).toContain('from=1');
    expect(requests[0]).toContain('to=400');
    const rendered = page.container.querySelector('[data-testid="file-text-rendered"]');
    expect(rendered?.querySelector('h1')?.textContent).toBe('Vision');
    expect(page.container.querySelector('[data-testid="file-text-view-rendered"]')).not.toBeNull();
    await act(async () => { (page.container.querySelector('[data-testid="file-text-view-source"]') as HTMLButtonElement).click(); });
    await settle();
    expect(page.container.querySelector('[data-testid="file-text-source"]')).not.toBeNull();
    expect(page.container.querySelectorAll('.file-source-line').length).toBe(3);
    expect(page.container.querySelector('.file-source-number')?.textContent).toBe('1');
  } finally {
    await page.close();
  }
});

test('a file that is no Markdown shows only its source, and a binary file says it has no text', async () => {
  answer = { ...answer, path: 'src/index.ts', text: 'export const answer = 42;\n', lines: 2 };
  const page = await render(context('src/index.ts'));
  try {
    expect(page.container.querySelector('[data-testid="file-text-view"]')).toBeNull();
    expect(page.container.querySelector('.file-source-code')?.textContent).toBe('export const answer = 42;');
  } finally {
    await page.close();
  }
  answer = { ...answer, path: 'logo.png', text: '', lines: 0, bytes: 12, binary: true };
  const binary = await render(context('logo.png'));
  try {
    expect(binary.container.querySelector('[data-testid="file-text-binary"]')?.textContent).toContain('двоичный файл');
    expect(binary.container.querySelector('[data-testid="file-text-source"]')).toBeNull();
  } finally {
    await binary.close();
  }
});
