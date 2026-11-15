/**
 * A file's text on its page (madarch-u3vw.16): the section asks for ranges by (repository, path), draws a Markdown file
 * rendered by the Sources page's own component with a Rendered / Source switch, shows any other text as source with line
 * numbers, and says a binary file has no text. The server's read is mocked here; the plugin read is tested in the repo.
 */
import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register({ url: 'http://localhost/' });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { EventSource?: unknown }).EventSource = undefined;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
// The highlighter is tested on its own (file-highlight.test.ts); here it answers tokens, so the section's drawing is what
// the test holds.
mock.module('./file-highlight.js', () => ({
  grammarOf: () => 'typescript',
  plainLines: (text: string) => text.replace(/\n$/u, '').split('\n').map((line) => [{ content: line, color: 'var(--text)' }]),
  highlightLines: async (text: string) => text.replace(/\n$/u, '').split('\n').map((line) => [{ content: line, color: line.includes('const') ? 'var(--syntax-keyword)' : 'var(--text)' }]),
}));
const { FileTextSection } = await import('./file-text.js');
const { setWikiLanguage } = await import('../i18n.js');

afterAll(() => { GlobalRegistrator.unregister(); });

const requests: string[] = [];
let answer: { text: string; lines: number; bytes: number; binary: boolean; blob: string; from: number; repository: string; path: string } = { text: '', lines: 0, bytes: 0, binary: false, blob: 'a'.repeat(40), from: 1, repository: 'sample', path: 'docs/vision.md' };

beforeEach(async () => {
  requests.length = 0;
  // The view is remembered per reader: each case starts at the Markdown's rendered view.
  window.localStorage.removeItem('madarch-file-text-view');
  await setWikiLanguage('ru');
  // A page's data is read through the graph (decision 0037): the stub answers the `source` field the section asks for.
  (globalThis as { fetch: typeof fetch }).fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    requests.push(url.pathname + url.search);
    if (url.pathname.endsWith('/graphql')) {
      const asked = JSON.parse(String(init?.body ?? '{}')) as { query?: string; variables?: Record<string, unknown> };
      const known = asked.query?.includes('source(') === true;
      const variables = asked.variables ?? {};
      const moved = typeof variables['blob'] === 'string' && variables['blob'] !== answer.blob;
      return new Response(JSON.stringify({ data: { source: known ? { ...answer, moved, from: moved ? 1 : variables['from'] ?? 1, next: null, complete: true, language: 'typescript' } : null } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
});

/** A stub that answers the graph's `source` field: the section reads a file's text through the one read API (0037). */
function sourceStub(ask: (variables: Record<string, unknown>) => Record<string, unknown>): void {
  (globalThis as { fetch: typeof fetch }).fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    requests.push(url.pathname + url.search);
    const body = JSON.parse(String(init?.body ?? '{}')) as { variables?: Record<string, unknown> };
    return new Response(JSON.stringify({ data: { source: ask(body.variables ?? {}) } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

function context(path: string, repository = 'sample'): Record<string, unknown> {
  return {
    section: { id: 'filetext', component: 'file-text', on: 'subject', replace: false, params: { repositoryPath: 'repository', pathPath: 'path', chunk: 400 }, line: 1, alias: 's_filetext' },
    data: { repository, path }, language: 'ru', base: '', busy: false, variables: {}, open: () => undefined, reload: () => undefined,
    renderSection: () => null, product: null, navigation: null, pageName: null,
  };
}

async function settle(): Promise<void> {
  for (let at = 0; at < 40; at += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

async function render(section: Record<string, unknown>): Promise<{ container: HTMLElement; show: (next: Record<string, unknown>) => Promise<void>; close: () => Promise<void> }> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(FileTextSection, { context: section as never })); });
  await settle();
  return {
    container,
    // Navigating to another file keeps the component mounted: the page hands it a new subject.
    show: async (next) => { await act(async () => { root.render(createElement(FileTextSection, { context: next as never })); }); await settle(); },
    close: async () => { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

/** What the page shows as source, one entry per line. */
const sourceLines = (container: HTMLElement): string[] => [...container.querySelectorAll('.file-source-code')].map((line) => line.textContent ?? '');

test('a Markdown file opens rendered by the documents\' component, with the Rendered / Source switch', async () => {
  answer = { ...answer, text: '# Vision\n\nThe product\'s first page.\n', lines: 3 };
  const page = await render(context('docs/vision.md'));
  try {
    // The text is read through the graph, not through a route of its own (decision 0037).
    expect(requests[0]).toBe('/graphql');
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
    // The source is highlighted: the tokens carry the kit's own colours (madarch-u3vw.16).
    const colours = [...page.container.querySelectorAll('.shiki-token')].map((token) => (token as HTMLElement).style.color);
    expect(colours).toContain('var(--syntax-keyword)');
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

test('a Markdown link of a script URL is drawn as text: only http(s), mailto and relative links stay', async () => {
  // The owner's review (madarch-u3vw.16): a repository's Markdown is the product's text, and a link in it never runs
  // JavaScript in the wiki's origin.
  answer = { ...answer, path: 'docs/link.md', lines: 3, binary: false, text: '# Links\n\n[run](javascript:alert%281%29) [web](https://example.test/x) [mail](mailto:a@example.test) [rel](../a.md)\n' };
  const page = await render(context('docs/link.md'));
  try {
    const linked = [...page.container.querySelectorAll('[data-testid="file-text-rendered"] a')];
    expect(linked.map((anchor) => anchor.getAttribute('href'))).toEqual(['https://example.test/x', 'mailto:a@example.test', '../a.md']);
    expect(page.container.querySelector('[data-testid="file-text-rendered"]')?.innerHTML).not.toContain('javascript:');
    expect(page.container.querySelector('[data-testid="file-text-rendered"]')?.textContent).toContain('run');
  } finally {
    await page.close();
  }
});

test('a later range is appended once, in its place: scrolling a long file never repeats or skips a line', async () => {
  // The owner's review (madarch-u3vw.16): lines 401-800 stood twice and 801-1200 were skipped.
  const all = Array.from({ length: 1_600 }, (_, at) => `line ${String(at + 1)}`);
  sourceStub((variables) => {
    const from = Number(variables['from'] ?? 1);
    const to = Number(variables['to'] ?? all.length);
    const held = all.slice(from - 1, to);
    return {
      text: `${held.join('\n')}\n`, lines: all.length, bytes: 1, binary: false, blob: 'a'.repeat(40), from,
      complete: to >= all.length, next: to >= all.length ? null : { line: to + 1, column: 1 },
    };
  });
  const page = await render(context('src/long.ts'));
  try {
    expect(sourceLines(page.container)).toEqual(all.slice(0, 400));
    const box = page.container.querySelector('[data-testid="file-text-source"]') as HTMLElement;
    await act(async () => { box.scrollTop = box.scrollHeight; box.dispatchEvent(new Event('scroll', { bubbles: true })); });
    await settle();
    expect(requests.at(-1)).toBe('/graphql');
    expect(sourceLines(page.container)).toEqual(all.slice(0, 800));
    await act(async () => { box.scrollTop = box.scrollHeight; box.dispatchEvent(new Event('scroll', { bubbles: true })); });
    await settle();
    expect(requests.at(-1)).toBe('/graphql');
    expect(sourceLines(page.container)).toEqual(all.slice(0, 1200));
  } finally {
    await page.close();
  }
});

test('going from one file to another shows the other file: the loaded text never survives the navigation', async () => {
  // The owner's review (madarch-u3vw.16): sample/a.ts's text stood under sample/b.ts's page.
  sourceStub((variables) => {
    const path = String(variables['path'] ?? '');
    const text = path === 'sample/a.ts' ? 'export const alpha = 1;\n' : 'export const beta = 2;\n';
    return { text, lines: 2, bytes: 1, binary: false, blob: (path === 'sample/a.ts' ? 'a' : 'b').repeat(40), from: 1, complete: true, next: null };
  });
  const page = await render(context('sample/a.ts'));
  try {
    expect(sourceLines(page.container)).toEqual(['export const alpha = 1;']);
    await page.show(context('sample/b.ts'));
    expect(sourceLines(page.container)).toEqual(['export const beta = 2;']);
    expect(requests.filter((one) => one === '/graphql').length).toBeGreaterThanOrEqual(2);
  } finally {
    await page.close();
  }
});

test('a later range names the blob the first answer held, and a moved blob restarts the view and says so', async () => {
  // The owner's review (madarch-u3vw.16): after a fill published revision B, scrolling appended B's lines to A's text.
  let moved = false;
  const asked: Record<string, unknown>[] = [];
  sourceStub((variables) => {
    asked.push(variables);
    const from = Number(variables['from'] ?? 1);
    const to = Number(variables['to'] ?? 400);
    const blob = moved ? 'b'.repeat(40) : 'a'.repeat(40);
    // A moved blob answers its own first lines, from line 1: the view restarts there.
    const start = moved ? 1 : from;
    const end = moved ? Math.max(1, to - from + 1) : to;
    const text = Array.from({ length: end - start + 1 }, (_, at) => `${moved ? 'B' : 'A'} line ${String(start + at)}`).join('\n') + '\n';
    return { text, lines: 1_600, bytes: 1, binary: false, blob, from: start, complete: false, next: { line: end + 1, column: 1 }, ...(moved ? { moved: true } : {}) };
  });
  const page = await render(context('src/moved.ts'));
  try {
    expect(sourceLines(page.container)[0]).toBe('A line 1');
    moved = true;
    const box = page.container.querySelector('[data-testid="file-text-source"]') as HTMLElement;
    await act(async () => { box.scrollTop = box.scrollHeight; box.dispatchEvent(new Event('scroll', { bubbles: true })); });
    await settle();
    // The later request names the blob the first answer held.
    expect(asked.at(-1)?.['blob']).toBe('a'.repeat(40));
    // The answer came from another revision: the view restarts at its first line, and says so.
    expect(sourceLines(page.container)[0]).toBe('B line 1');
    expect(page.container.querySelector('[data-testid="file-text-moved"]')).not.toBeNull();
  } finally {
    await page.close();
  }
});
