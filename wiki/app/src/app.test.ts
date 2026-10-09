/**
 * The wiki app's tests, without a server: every request is answered by a stub
 * that gives the API's shapes, the DOM is happy-dom, and nothing here reaches
 * the network or writes outside this process. A test fails when the behaviour
 * it names breaks.
 *
 * Requirements checked: `pages` (the home page, a page and its links, no
 * pages yet), `live` (a changed revision refetches the open page and stops
 * while the reader is away), and a failed request shown to the reader.
 */
import { afterEach, afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import { App, HomePage, PageReader } from './app.js';
import { addressOfPage } from './routes.js';
import type { Product, PageList, Page } from './api.js';

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
});

afterAll(async () => {
  // React's scheduler holds one callback in its own queue; let it run while
  // the window still exists, then take the DOM away.
  await new Promise((rest) => setTimeout(rest, 50));
  GlobalRegistrator.unregister();
});

/** The answer kinds the stub serves, keyed by an address without the origin. */
type Blade = { body: unknown; status?: number };
type Answer = (target: string) => Blade;

function answerFor(product: Product, list: PageList, pages: Record<string, Page>): Answer {
  return (target: string): Blade => {
    if (target === '/api/product') return { body: product };
    if (target === '/api/pages') return { body: list };
    if (target.startsWith('/api/page?') === false)
      return { body: { message: 'the server does not answer ' + target }, status: 404 };
    const path = new URL('http://x' + target).searchParams.get('path') ?? '';
    const page = pages[path];
    if (page === undefined)
      return { body: { message: 'the wiki does not hold ' + path }, status: 404 };
    return { body: page };
  };
}

/** Installs a fetch stub that records every address it is asked for. */
function install(answerSupplier: Answer): { calls: string[]; set: (next: Answer) => void } {
  const calls: string[] = [];
  let answer = answerSupplier;
  const stub = async (input: RequestInfo | URL): Promise<Response> => {
    const target = input instanceof URL ? input.pathname + input.search : String(input);
    calls.push(target);
    const blade = answer(target);
    if (blade.body === undefined)
      return new Response(JSON.stringify({ message: 'nothing answers ' + target }), { status: 404 });
    return new Response(JSON.stringify(blade.body), {
      status: blade.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  (globalThis as { fetch: typeof fetch }).fetch = stub as unknown as typeof fetch;
  return { calls, set: (next: Answer) => { answer = next; } };
}

const product: Product = { id: 'b7f1', name: 'Draft Idea' };
const listWithPages: PageList = {
  revision: 'r1',
  pages: [
    { path: 'README.md', title: 'README', url: '/p/README.md' },
    { path: 'docs/vision.md', title: 'Vision', url: '/p/docs/vision.md' },
    { path: 'docs/notes.md', title: 'notes', url: '/p/docs/notes.md' },
  ],
};
const pagesAtR1: Record<string, Page> = {
  'docs/vision.md': {
    path: 'docs/vision.md',
    title: 'Vision',
    markdown: '# Vision extra\n\nIt holds [a note](notes.md) and [an outside link](https://example.com/x) and [a missing target](../AGENTS.md).',
  },
  'docs/notes.md': { path: 'docs/notes.md', title: 'notes', markdown: '# notes' },
};

let rendered: { root: Root } | undefined;

function intoApp(element: ReturnType<typeof createElement>): Promise<void> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(element);
  rendered = { root };
  return Promise.resolve();
}

/** Waits until the tree matches, or fails after the plainly too-long wait. */
async function until(holds: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (holds()) return;
    await new Promise((step) => setTimeout(step, 10));
  }
  throw new Error('the app never came to ' + what + '; the tree holds: ' + document.body.innerHTML);
}

const text = (): string => document.body.textContent ?? '';
const html = (): string => document.body.innerHTML;

/** Routes the app through the address, as a direct open or a reload would. */
function goto(pathname: string): void {
  window.history.pushState({}, '', pathname);
}

function unmount(): void {
  rendered?.root.unmount();
  rendered = undefined;
}

afterEach(() => {
  unmount();
  delete (globalThis as { fetch?: unknown }).fetch;
});

describe('the home page', () => {
  test('names the product and lists its pages as links', async () => {
    install(answerFor(product, listWithPages, pagesAtR1));
    goto('/');
    await intoApp(createElement(App));
    await until(() => text().includes('Draft Idea') && html().includes('/p/docs/vision.md'), 'the home page');
    expect(text()).toContain('Vision');
    const home = document.querySelector('main#home');
    expect(home).not.toBeNull();
    const link = home?.querySelector('a[href="/p/docs/vision.md"]');
    expect(link?.textContent).toBe('Vision');
  });

  test('says plainly that the product has no pages yet', async () => {
    install(
      answerFor(product, { revision: 'r0', pages: [] }, {}),
    );
    goto('/');
    await intoApp(createElement(App));
    await until(() => text().includes('has no pages yet'), 'the empty home page');
  });
});

describe('a page', () => {
  test('is shown at /p/ plus its path, with its title as a heading and its Markdown as formatted text', async () => {
    install(answerFor(product, listWithPages, pagesAtR1));
    goto('/p/docs/vision.md');
    await intoApp(createElement(App));
    await until(() => document.querySelector('main#page h1')?.textContent === 'Vision', 'the page heading');
    // The page's title is a heading as the server names it; a level-one heading
    // in the Markdown becomes a real heading of its own, not raw text.
    expect(document.querySelectorAll('main#page h1').length).toBe(2);
    const headings = [...document.querySelectorAll('main#page h1')].map((node) => node.textContent);
    expect(headings).toContain('Vision extra');
    expect(html()).toContain('It holds');
  });

  test('shows a link to a page the wiki holds as a link that opens it without a reload', async () => {
    install(answerFor(product, listWithPages, pagesAtR1));
    goto('/p/docs/vision.md');
    await intoApp(createElement(App));
    await until(() => document.querySelector('a[href="/p/docs/notes.md"]') !== null, 'the held link');
    const link = document.querySelector('a[href="/p/docs/notes.md"]') as HTMLAnchorElement;
    const before = window.location.pathname;
    link.click();
    await until(
      () => window.location.pathname === '/p/docs/notes.md' && document.querySelector('main#page h1')?.textContent === 'notes',
      'the client-side move to the notes page',
    );
    expect(before).toBe('/p/docs/vision.md');
    // No reload happened: the same document holds the moved-to page's content.
    expect(document.querySelector('main#page')).not.toBeNull();
  });

  test('shows a link to an outside address as written and a link to an unheld target as its text', async () => {
    install(answerFor(product, listWithPages, pagesAtR1));
    goto('/p/docs/vision.md');
    await intoApp(createElement(App));
    await until(() => html().includes('https://example.com/x'), 'the rendered page');
    const outside = document.querySelector('a[href="https://example.com/x"]');
    expect(outside).not.toBeNull();
    const missing = document.querySelector('span.plain-link');
    expect(missing?.textContent).toBe('a missing target');
    expect(document.querySelector('a[href="/p/AGENTS.md"]')).toBeNull();
  });
});

describe('live update', () => {
  test('a changed revision refetches the open page, without a reload', async () => {
    const api = install(answerFor(product, listWithPages, pagesAtR1));
    goto('/p/docs/vision.md');
    await intoApp(createElement(App, { tickMs: 10 }));
    await until(() => document.querySelector('main#page h1')?.textContent === 'Vision', 'the first read');
    const revisionBefore = api.calls.filter((call) => call === '/api/pages').length;
    expect(revisionBefore).toBeGreaterThan(0);
    const changed: PageList = {
      revision: 'r2',
      pages: [
        { path: 'README.md', title: 'README', url: '/p/README.md' },
        { path: 'docs/vision.md', title: 'Vision', url: '/p/docs/vision.md' },
      ],
    };
    const changedPages = {
      ...pagesAtR1,
      'docs/vision.md': {
        ...pagesAtR1['docs/vision.md']!,
        markdown: '# Vision saved\n\nWhat it is for.',
      },
    };
    api.set(answerFor(product, changed, changedPages));
    await until(() => text().includes('What it is for.'), 'the saved text');
    expect(api.calls.some((call) => call === '/api/page?path=docs%2Fvision.md')).toBe(true);
  });

  test('an unchanged revision fetches each page only once per read', async () => {
    const api = install(answerFor(product, listWithPages, pagesAtR1));
    goto('/p/docs/vision.md');
    await intoApp(createElement(App, { tickMs: 10 }));
    await until(() => document.querySelector('main#page h1')?.textContent === 'Vision', 'the read');
    let fetchesAgain = 0;
    for (let attempt = 0; attempt < 200; attempt++) {
      await new Promise((step) => setTimeout(step, 5));
      fetchesAgain = Math.max(fetchesAgain, api.calls.filter((call) => call.startsWith('/api/page?')).length);
    }
    expect(fetchesAgain).toBe(1);
  });

  test('stops asking while the reader is away from the page', async () => {
    const api = install(answerFor(product, listWithPages, pagesAtR1));
    goto('/');
    await intoApp(createElement(App, { tickMs: 10 }));
    await until(() => text().includes('Draft Idea'), 'the home page');
    let hidden = false;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (hidden ? 'hidden' : 'visible'),
    });
    await new Promise((step) => setTimeout(step, 60));
    const beforeHidden = api.calls.filter((call) => call === '/api/pages').length;
    hidden = true;
    await new Promise((step) => setTimeout(step, 60));
    const afterHidden = api.calls.filter((call) => call === '/api/pages').length;
    expect(afterHidden).toBe(beforeHidden);
    delete (Object.getOwnPropertyDescriptor(document, 'visibilityState') ?? {}).get as never;
  });
});

describe('a request that fails', () => {
  test('is shown to the reader as a short message naming what was asked for', async () => {
    install(answerFor(product, listWithPages, {}));
    goto('/p/docs/missing.md');
    await intoApp(createElement(App, { tickMs: 10 }));
    await until(() => text().includes('Could not read the page docs/missing.md'), 'the failed page read');
    expect(text()).toContain('the wiki does not hold docs/missing.md');
  });
});

describe('addresses', () => {
  test('a page address encodes its path', () => {
    expect(addressOfPage('docs/vision.md')).toBe('/p/docs/vision.md');
    expect(addressOfPage('docs/a b.md')).toBe('/p/docs/a%20b.md');
  });
});
