/**
 * The wiki app's tests, without a server: every request is answered by a stub
 * that gives the API's shapes, the DOM is happy-dom, and nothing here reaches
 * the network or writes outside this process. A test fails when the behaviour
 * it names breaks.
 *
 * Requirements checked: `pages` (the home page, a page and its links, no
 * pages yet), `live` (a changed revision refetches the open page, one poll in
 * flight, asking also while the tab is hidden), and a failed request shown to
 * the reader.
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

  test('shows a link to an outside address and a link to an unheld target as their text', async () => {
    install(answerFor(product, listWithPages, pagesAtR1));
    goto('/p/docs/vision.md');
    await intoApp(createElement(App));
    await until(() => text().includes('an outside link'), 'the rendered page');
    const plain = [...document.querySelectorAll('span.plain-link')].map((node) => node.textContent);
    expect(plain).toContain('an outside link');
    expect(plain).toContain('a missing target');
    expect(document.querySelector('a[href="https://example.com/x"]')).toBeNull();
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

  test('keeps asking while the tab is hidden, and asks at once when it becomes visible', async () => {
    const api = install(answerFor(product, listWithPages, pagesAtR1));
    goto('/');
    await intoApp(createElement(App, { tickMs: 10 }));
    await until(() => text().includes('Draft Idea'), 'the home page');
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    await new Promise((step) => setTimeout(step, 60));
    const whileHidden = api.calls.filter((call) => call === '/api/pages').length;
    expect(whileHidden).toBeGreaterThan(1);
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((step) => setTimeout(step, 5));
    const afterVisible = api.calls.filter((call) => call === '/api/pages').length;
    expect(afterVisible).toBeGreaterThan(whileHidden);
    delete (Object.getOwnPropertyDescriptor(document, 'visibilityState') ?? {}).get as never;
  });
});

describe('the page-list poll', () => {
  test('keeps one request in flight while an earlier one is pending', async () => {
    let release: (() => void) | undefined;
    let asks = 0;
    let stalled = 0;
    (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const target = input instanceof URL ? input.pathname + input.search : String(input);
      if (target !== '/api/pages') {
        return new Response(JSON.stringify(product), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      asks++;
      stalled++;
      if (stalled === 1) await new Promise<void>((rest) => { release = rest; });
      return new Response(JSON.stringify(listWithPages), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    goto('/');
    await intoApp(createElement(App, { tickMs: 5 }));
    await new Promise((step) => setTimeout(step, 40));
    expect(asks).toBe(1);
    release?.();
    await until(() => text().includes('Draft Idea'), 'the first answer');
  });

  test('a stalled answer shows once it arrives, and the next poll supersedes it', async () => {
    let servedR9 = false;
    const superseded = (): boolean => servedR9;
    let releases: ((value: Response) => void)[] = [];
    let turn = 0;
    (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const target = input instanceof URL ? input.pathname + input.search : String(input);
      if (target !== '/api/pages') {
        return new Response(JSON.stringify(product), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      turn++;
      const which = turn;
      if (which === 1) {
        return await new Promise<Response>((rest) => { releases.push(rest); });
      }
      servedR9 = true;
      return new Response(JSON.stringify({ ...listWithPages, revision: 'r9' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    goto('/');
    await intoApp(createElement(App, { tickMs: 5 }));
    await new Promise((step) => setTimeout(step, 30));
    expect(text()).not.toContain('Draft Idea');
    releases[0]?.(new Response(JSON.stringify(listWithPages), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    releases = [];
    await until(() => text().includes('Draft Idea'), 'the stalled answer');
    await until(() => superseded(), 'the superseding answer');
  });

  test('aborts the request still in flight when the app is unmounted', async () => {
    let aborted = false;
    (globalThis as { fetch: typeof fetch }).fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      return await new Promise<Response>((_rest, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }) as unknown as typeof fetch;
    goto('/');
    await intoApp(createElement(App, { tickMs: 5 }));
    await new Promise((step) => setTimeout(step, 20));
    expect(aborted).toBe(false);
    unmount();
    await new Promise((step) => setTimeout(step, 20));
    expect(aborted).toBe(true);
  });
});


describe('a poll that never settles', () => {
  test('stops polling only for the stalled request and asks again afterwards (finding 4)', async () => {
    let asks = 0;
    (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const target = input instanceof URL ? input.pathname + input.search : String(input);
      if (target === '/api/pages') {
        asks++;
        if (asks === 1) {
          return await new Promise<Response>((_rest, reject) => {
            // A real stalled request dies when it is aborted: the stub dies with it.
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          });
        }
        return new Response(JSON.stringify(listWithPages), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (target === '/api/product') {
        return new Response(JSON.stringify(product), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ message: 'nothing answers ' + target }), { status: 404 });
    }) as unknown as typeof fetch;
    goto('/');
    await intoApp(createElement(App, { tickMs: 5, pollTimeoutMs: 20 }));
    await until(() => asks >= 2, 'the next poll after the stalled one expired');
    await until(() => text().includes('Draft Idea'), 'the answered home page');
    expect(text()).not.toContain('the poll of /api/pages timed out');
  });
});

describe('a poll that times out', () => {
  test('names what was being read and that it timed out (finding 2.10)', async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const target = input instanceof URL ? input.pathname + input.search : String(input);
      if (target === '/api/pages') {
        return await new Promise<Response>((_rest, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      }
      if (target === '/api/product') {
        return new Response(JSON.stringify(product), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ message: 'nothing answers ' + target }), { status: 404 });
    }) as unknown as typeof fetch;
    goto('/');
    await intoApp(createElement(App, { tickMs: 60_000, pollTimeoutMs: 20 }));
    await until(() => document.querySelector('p.error') !== null, 'the shown timeout');
    const shown = document.querySelector('p.error')?.textContent ?? '';
    expect(shown).toContain('page list');
    expect(shown).toContain('timed out');
    expect(shown).not.toContain('The operation was aborted');
  });
});

describe('a failed page read that is retried', () => {
  test('shows the failure while it retries, and recovers when the read succeeds', async () => {
    let tries = 0;
    (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const target = input instanceof URL ? input.pathname + input.search : String(input);
      if (target === '/api/pages') {
        return new Response(JSON.stringify(listWithPages), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (target === '/api/product') {
        return new Response(JSON.stringify(product), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      tries++;
      if (tries < 3) return new Response(JSON.stringify({ message: 'the wiki does not hold it' }), { status: 500 });
      return new Response(JSON.stringify(pagesAtR1['docs/vision.md']), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    goto('/p/docs/vision.md');
    await intoApp(createElement(App, { tickMs: 10, pageRetryMs: 5 }));
    await until(() => text().includes('Could not read the page docs/vision.md'), 'the shown failure');
    await until(() => document.querySelector('main#page h1')?.textContent === 'Vision', 'the recovered page');
    expect(tries).toBe(3);
  });

  test('stops after a bounded number of tries', async () => {
    const pageTriesLimit = 3;
    const pageCalls: string[] = [];
    (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const target = input instanceof URL ? input.pathname + input.search : String(input);
      if (target === '/api/pages') {
        return new Response(JSON.stringify(listWithPages), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (target === '/api/product') {
        return new Response(JSON.stringify(product), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      pageCalls.push(target);
      return new Response(JSON.stringify({ message: 'the wiki does not hold it' }), { status: 500 });
    }) as unknown as typeof fetch;
    goto('/p/docs/vision.md');
    await intoApp(createElement(App, { tickMs: 10, pageRetryMs: 5 }));
    const tries = (): number => pageCalls.filter((call) => call === '/api/page?path=docs%2Fvision.md').length;
    await until(() => tries() === pageTriesLimit, 'the bounded tries');
    await new Promise((step) => setTimeout(step, 40));
    expect(tries()).toBe(pageTriesLimit);
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

describe('a page linking by the wiki\'s own address', () => {
  test('opens the page it names, escapes included (finding 5)', async () => {
    const withAddress = {
      ...pagesAtR1,
      'docs/vision.md': {
        path: 'docs/vision.md',
        title: 'Vision',
        markdown: 'See [the notes](/p/docs/notes.md) and [spaced](/p/docs/a%20b.md).',
      },
    };
    const pagesList: PageList = {
      revision: 'r1',
      pages: [...listWithPages.pages, { path: 'docs/a b.md', title: 'spaced', url: '/p/docs/a%20b.md' }],
    };
    const held = {
      ...pagesAtR1,
      'docs/a b.md': { path: 'docs/a b.md', title: 'spaced', markdown: '# spaced' },
    };
    install(answerFor(product, pagesList, { ...withAddress, 'docs/a b.md': held['docs/a b.md']! }));
    goto('/p/docs/vision.md');
    await intoApp(createElement(App, { tickMs: 10 }));
    await until(() => document.querySelector('a[href="/p/docs/notes.md"]') !== null, 'the address link');
    expect(html()).not.toContain('plain-link');
    const spaced = document.querySelector('a[href="/p/docs/a%20b.md"]');
    expect(spaced).not.toBeNull();
    (spaced as HTMLAnchorElement).click();
    await until(() => document.querySelector('main#page h1')?.textContent === 'spaced', 'the moved-to page');
  });
});

describe('addresses', () => {
  test('a page address encodes its path', () => {
    expect(addressOfPage('docs/vision.md')).toBe('/p/docs/vision.md');
    expect(addressOfPage('docs/a b.md')).toBe('/p/docs/a%20b.md');
  });
});
