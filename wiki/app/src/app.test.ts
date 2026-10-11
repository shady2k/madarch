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
import { App, HomePage, PageReader, RepositoriesPage, RepoCard, EVENTS_PATH } from './app.js';
import { groupNav } from './shell.js';
import { languageStorageKey, setWikiLanguage } from './i18n.js';
import { addressOfPage } from './routes.js';

import type { Product, ProductWithAudience, PageList, Page, QuestionList, QuestionEntry } from './api.js';

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  await setWikiLanguage('en');
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

function answerFor(product: Product, list: PageList, pages: Record<string, Page>, questions: QuestionList = { questions: [], openCount: 0 }): Answer {
  return (target: string): Blade => {
    if (target === '/api/product') return { body: product };
    if (target === '/api/pages') return { body: list };

    if (target === '/api/questions') return { body: questions };
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
async function until(holds: () => boolean | undefined, what: string): Promise<void> {
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
  test('is shown at /p/ plus its path, with the document first-level heading as the one heading, and its Markdown as formatted text', async () => {
    install(answerFor(product, listWithPages, pagesAtR1));
    goto('/p/docs/vision.md');
    await intoApp(createElement(App));
    await until(() => document.querySelector('main .reading > h1')?.textContent === 'Vision extra', 'the document heading');
    // Exactly one h1 node per page: the document's own heading is the page's
    // title and the app's fallback heading above it is never rendered at all
    // (the checkpoint's doubled-title defect, decided on the renderer output).
    await until(() => document.querySelector('main > h1.app-title') === null, 'the fallback title leaves');
    expect(document.querySelectorAll('main .reading h1').length).toBe(1);
    expect(html()).toContain('It holds');
    // The nav and the breadcrumb still name the page by its meta title.
    expect(document.querySelector('.nav-current')?.textContent).toContain('Vision');
  });

  test('a page without a first-level heading still shows its title as the heading, once', async () => {
    install(answerFor(product, listWithPages, { 'docs/notes.md': { path: 'docs/notes.md', title: 'notes', markdown: 'Plain body, no heading.\n' } }));
    goto('/p/docs/notes.md');
    await intoApp(createElement(App));
    await until(() => document.querySelector('main#page h1')?.textContent === 'notes', 'the title heading');
    expect(document.querySelectorAll('main#page h1').length).toBe(1);
    expect(html()).toContain('Plain body');
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

/**
 * A served wiki with its own stream: fetch is stubbed for every address,
 * `/api/events` answers a ReadableStream the test writes into, and every
 * event frame the test pushes is delivered to the app as it arrives.
 */
function installWithStream(answerSupplier: Answer): {
  calls: string[];
  set: (next: Answer) => void;
  push: (frame: string) => void;
} {
  const calls: string[] = [];
  let answer = answerSupplier;
  let pushInside: ((frame: string) => void) | undefined;
  const stub = async (input: RequestInfo | URL): Promise<Response> => {
    const target = input instanceof URL ? input.pathname + input.search : String(input);
    calls.push(target);
    if (target === EVENTS_PATH) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('retry: 3000\n\n'));
          pushInside = (frame: string): void => controller.enqueue(encoder.encode(frame));
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      });
    }
    const blade = answer(target);
    if (blade.body === undefined)
      return new Response(JSON.stringify({ message: 'nothing answers ' + target }), { status: 404 });
    return new Response(JSON.stringify(blade.body), {
      status: blade.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  (globalThis as { fetch: typeof fetch }).fetch = stub as unknown as typeof fetch;
  return { calls, push: (frame) => pushInside?.(frame), set: (next) => { answer = next; } };
}

describe('live update', () => {
  test('a saved file shows within two seconds, without a reload, when the stream carries the change', async () => {
    const stream = installWithStream(answerFor(product, listWithPages, pagesAtR1));
    goto('/p/docs/vision.md');
    await intoApp(createElement(App, { reconnectMs: 5 }));
    await until(() => document.querySelector('main .reading > h1')?.textContent === 'Vision extra', 'the first read');
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
    stream.set(answerFor(product, changed, changedPages));
    const before = Date.now();
    stream.push('event: change\ndata: {"revision":"r2"}\n\n');
    await until(() => text().includes('What it is for.'), 'the saved text');
    expect(Date.now() - before).toBeLessThanOrEqual(2000);
    expect(stream.calls.some((call) => call === '/api/page?path=docs%2Fvision.md')).toBe(true);
    // The update was not a reload: the same document holds the new content.
    expect(document.querySelector('main .reading > h1')).not.toBeNull();
    expect(stream.calls.filter((call) => call === EVENTS_PATH).length).toBe(1);
  });

  test('an idle tab makes no request after the load beyond its one stream', async () => {
    const stream = installWithStream(answerFor(product, listWithPages, pagesAtR1));
    goto('/p/docs/vision.md');
    await intoApp(createElement(App, { reconnectMs: 5 }));
    await until(() => document.querySelector('main .reading > h1')?.textContent === 'Vision extra', 'the load');
    const byAddress = (call: string): number => stream.calls.filter((named) => named === call).length;
    // The load of a wiki: the list, the product and the one long-lived stream.
    expect(byAddress('/api/pages')).toBe(1);
    expect(byAddress('/api/product')).toBe(1);
    expect(byAddress(EVENTS_PATH)).toBe(1);
    // Two idle seconds: nothing goes out at all, no per-second fetch beyond the stream.
    const before = stream.calls.length;
    await new Promise((step) => setTimeout(step, 2000));
    expect(stream.calls.length).toBe(before);
    expect(byAddress(EVENTS_PATH)).toBe(1);
  });

  test('a hidden tab stays live: the stream carries the event, and the list is asked again', async () => {
    const stream = installWithStream(answerFor(product, listWithPages, pagesAtR1));
    goto('/');
    await intoApp(createElement(App, { reconnectMs: 5 }));
    await until(() => text().includes('Draft Idea'), 'the home page');
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    const whileHidden = stream.calls.filter((call) => call === '/api/pages').length;
    await new Promise((step) => setTimeout(step, 100));
    expect(stream.calls.filter((call) => call === '/api/pages').length).toBe(whileHidden);
    stream.set(answerFor(product, { ...listWithPages, revision: 'r2' }, pagesAtR1));
    stream.push('event: change\ndata: {"revision":"r2"}\n\n');
    await until(() => stream.calls.filter((call) => call === '/api/pages').length > whileHidden, 'the event-driven re-ask');
    delete (Object.getOwnPropertyDescriptor(document, 'visibilityState') ?? {}).get as never;
  });

  test('a dropped stream reconnects, with backoff, and an event on it still updates the page', async () => {
    let answers = 0;
    const which = { list: listWithPages, page: pagesAtR1['docs/vision.md']! };
    let push: ((frame: string) => void) | undefined;
    (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const target = input instanceof URL ? input.pathname + input.search : String(input);
      if (target === EVENTS_PATH) {
        answers += 1;
        const held = answers;
        if (held === 1) {
          // The first stream asks, answers nothing and drops at once.
          return new Response(new ReadableStream<Uint8Array>({ start(c) { c.close(); } }), {
            status: 200,
            headers: { 'content-type': 'text/event-stream; charset=utf-8' },
          });
        }
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode('retry: 3000\n\n'));
            if (held >= 2) push = (frame: string): void => controller.enqueue(encoder.encode(frame));
          },
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
      }
      if (target === '/api/pages') return new Response(JSON.stringify(which.list), { status: 200, headers: { 'content-type': 'application/json' } });
      if (target === '/api/repos') return new Response(JSON.stringify({ repos: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (target === '/api/product') return new Response(JSON.stringify(product), { status: 200, headers: { 'content-type': 'application/json' } });

      if (target === '/api/questions') return new Response(JSON.stringify({ questions: [], openCount: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (target.startsWith('/api/page?path=docs%2Fvision.md')) {
        return new Response(JSON.stringify(which.page), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ message: 'nothing answers ' + target }), { status: 404 });
    }) as unknown as typeof fetch;
    goto('/p/docs/vision.md');
    await intoApp(createElement(App, { reconnectMs: 5 }));
    // The first stream drops; the app asks again (its backoff is the test's 5 ms).
    await until(() => answers >= 2, 'the reconnected stream');
    await until(() => document.querySelector('main .reading > h1')?.textContent === 'Vision extra', 'the read over the second stream');
    // A later change event on the healthy stream updates the open page.
    which.list = {
      revision: 'r2',
      pages: [
        { path: 'README.md', title: 'README', url: '/p/README.md' },
        { path: 'docs/vision.md', title: 'Vision', url: '/p/docs/vision.md' },
      ],
    };
    which.page = { path: 'docs/vision.md', title: 'Vision', markdown: '# Vision saved\n\nAfter the drop.' };
    push?.('event: change\ndata: {"revision":"r2"}\n\n');
    await until(() => text().includes('After the drop.'), 'the page saved after the drop');
    expect(answers).toBe(2);
  });
  test('the status bar names the stream state on its own: Reconnecting until open, then Live', async () => {
    // The first /api/events asks and holds its answer until the test lets it
    // through: the connection state reads Reconnecting for as long as the
    // stream is not open, and Live the moment it opens.
    let open: ((response: Response) => void) | undefined;
    (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const target = input instanceof URL ? input.pathname + input.search : String(input);
      if (target === EVENTS_PATH) {
        return await new Promise<Response>((resolve) => {
          open = (response) => resolve(response);
        });
      }
      if (target === '/api/pages') return new Response(JSON.stringify(listWithPages), { status: 200, headers: { 'content-type': 'application/json' } });
      if (target === '/api/product') return new Response(JSON.stringify(product), { status: 200, headers: { 'content-type': 'application/json' } });

      if (target === '/api/questions') return new Response(JSON.stringify({ questions: [], openCount: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (target.startsWith('/api/page?path=')) return new Response(JSON.stringify(pagesAtR1['docs/vision.md']!), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ message: 'nothing answers ' + target }), { status: 404 });
    }) as unknown as typeof fetch;
    goto('/p/docs/vision.md');
    await intoApp(createElement(App, { reconnectMs: 5 }));
    await until(() => open !== undefined, 'the stream is asked');
    await until(() => document.querySelector('[data-testid="connection-status"]')?.textContent?.includes('Reconnecting'), 'a not-yet-open stream reads Reconnecting');
    open?.(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('retry: 3000\n\n'));
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } }));
    await until(() => document.querySelector('[data-testid="connection-status"]')?.textContent?.includes('Live'), 'an open stream reads Live');
    expect(document.querySelector('[data-testid="connection-status"]')?.getAttribute('data-state')).toBe('live');
  });

  test('a stream that opens and then fails reads Reconnecting again', async () => {
    let answers = 0;
    (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const target = input instanceof URL ? input.pathname + input.search : String(input);
      if (target === EVENTS_PATH) {
        answers += 1;
        if (answers === 1) {
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('retry: 3000\n\n'));
              setTimeout(() => controller.close(), 10);
            },
          }), { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
        }
        // The reconnection ask never answers: the broken stream's Reconnecting state stays visible.
        return new Promise<Response>(() => undefined);
      }
      if (target === '/api/pages') return new Response(JSON.stringify(listWithPages), { status: 200, headers: { 'content-type': 'application/json' } });
      if (target === '/api/product') return new Response(JSON.stringify(product), { status: 200, headers: { 'content-type': 'application/json' } });

      if (target === '/api/questions') return new Response(JSON.stringify({ questions: [], openCount: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (target.startsWith('/api/page?path=')) return new Response(JSON.stringify(pagesAtR1['docs/vision.md']!), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ message: 'nothing answers ' + target }), { status: 404 });
    }) as unknown as typeof fetch;
    goto('/p/docs/vision.md');
    await intoApp(createElement(App, { reconnectMs: 5 }));
    await until(() => document.querySelector('[data-testid="connection-status"]')?.textContent?.includes('Live'), 'the first stream opens Live');
    await until(() => document.querySelector('[data-testid="connection-status"]')?.textContent?.includes('Reconnecting'), 'the broken stream reads Reconnecting');
    expect(document.querySelector('[data-testid="connection-status"]')?.getAttribute('data-state')).toBe('reconnecting');
  });

});


describe('the page list read', () => {
  test('a newer list a stream event asked for is never overwritten by the older stalled one', async () => {
    let releaseOld: (() => void) | undefined;
    let asks = 0;
    let push: ((frame: string) => void) | undefined;
    (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const target = input instanceof URL ? input.pathname + input.search : String(input);
      if (target === EVENTS_PATH) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode('retry: 3000\n\n'));
            push = (frame: string): void => controller.enqueue(encoder.encode(frame));
          },
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
      }
      if (target === '/api/pages') {
        asks += 1;
        const held = asks;
        if (held === 1) {
          await new Promise<void>((rest) => { releaseOld = rest; });
          return new Response(JSON.stringify(listWithPages), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ ...listWithPages, revision: 'r9', pages: [...listWithPages.pages, { path: 'docs/rushed.md', title: 'Rushed', url: '/p/docs/rushed.md' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (target === '/api/repos') return new Response(JSON.stringify({ repos: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify(product), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    goto('/');
    await intoApp(createElement(App, { reconnectMs: 60_000 }));
    // The first read stalls; the stream's event asks again and the newer answer lands.
    await new Promise((step) => setTimeout(step, 20));
    expect(asks).toBe(1);
    push?.('event: change\ndata: {"revision":"r9"}\n\n');
    await until(() => text().includes('Rushed'), 'the newer list');
    // The older answer arriving late never wins against the newer one.
    releaseOld?.();
    await new Promise((step) => setTimeout(step, 20));
    expect(text()).toContain('Rushed');
    expect(asks).toBe(2);
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
    await intoApp(createElement(App, { reconnectMs: 60_000 }));
    await new Promise((step) => setTimeout(step, 20));
    expect(aborted).toBe(false);
    unmount();
    await new Promise((step) => setTimeout(step, 20));
    expect(aborted).toBe(true);
  });
});

describe('a load that never settles', () => {
  test('the timeout shows the failure, and the stream\'s next event asks again and succeeds (finding 4)', async () => {
    let asks = 0;
    let push: ((frame: string) => void) | undefined;
    (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const target = input instanceof URL ? input.pathname + input.search : String(input);
      if (target === EVENTS_PATH) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode('retry: 3000\n\n'));
            push = (frame: string): void => controller.enqueue(encoder.encode(frame));
          },
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
      }
      if (target === '/api/pages') {
        asks += 1;
        if (asks === 1) {
          return await new Promise<Response>((_rest, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          });
        }
        return new Response(JSON.stringify(listWithPages), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (target === '/api/repos') return new Response(JSON.stringify({ repos: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify(product), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    goto('/');
    await intoApp(createElement(App, { reconnectMs: 60_000, pollTimeoutMs: 20 }));
    await until(() => document.querySelector('p.error') !== null, 'the shown timeout');
    // The stream is still open; its next change event asks again, and the answer clears the error.
    push?.('event: change\ndata: {"revision":"r1"}\n\n');
    await until(() => text().includes('Draft Idea'), 'the answered home page');
    expect(text()).not.toContain('timed out');
  });
});




describe('a poll that times out', () => {
  test('names the product request when the product fetch is what timed out (finding 2.11)', async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const target = input instanceof URL ? input.pathname + input.search : String(input);
      if (target === '/api/pages') {
        return new Response(JSON.stringify(listWithPages), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (target === '/api/product') {
        return await new Promise<Response>((_rest, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      }
      if (target === '/api/questions') {
        return new Response(JSON.stringify({ questions: [], openCount: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ message: 'nothing answers ' + target }), { status: 404 });
    }) as unknown as typeof fetch;
    goto('/');
    await intoApp(createElement(App, { pollTimeoutMs: 20, reconnectMs: 60_000 }));
    await until(() => document.querySelector('p.error') !== null, 'the shown timeout');
    const shown = document.querySelector('p.error')?.textContent ?? '';
    expect(shown).toContain('/api/product');
    expect(shown).toContain('timed out');
    expect(shown).not.toContain('/api/pages');
  });

  test('a stalled error-body read is reported as the timeout it was (finding 2.11)', async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const target = input instanceof URL ? input.pathname + input.search : String(input);
      if (target === '/api/pages') {
        // A 503 header whose body never arrives: reading it can only end in the abort.
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener('abort', () =>
              controller.error(new DOMException('aborted', 'AbortError')));
          },
        }), { status: 503, headers: { 'content-type': 'application/json' } });
      }
      if (target === '/api/product') {
        return new Response(JSON.stringify(product), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (target === '/api/questions') {
        return new Response(JSON.stringify({ questions: [], openCount: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ message: 'nothing answers ' + target }), { status: 404 });
    }) as unknown as typeof fetch;
    goto('/');
    await intoApp(createElement(App, { pollTimeoutMs: 20, reconnectMs: 60_000 }));
    await until(() => document.querySelector('p.error') !== null, 'the shown timeout');
    const shown = document.querySelector('p.error')?.textContent ?? '';
    expect(shown).toContain('timed out');
    expect(shown).not.toContain('503');
    expect(shown).not.toContain('The operation was aborted');
  });

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
      if (target === '/api/questions') {
        return new Response(JSON.stringify({ questions: [], openCount: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ message: 'nothing answers ' + target }), { status: 404 });
    }) as unknown as typeof fetch;
    goto('/');
    await intoApp(createElement(App, { pollTimeoutMs: 20, reconnectMs: 60_000 }));
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
    const pageCalls: string[] = [];
    (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const target = input instanceof URL ? input.pathname + input.search : String(input);
      if (target === EVENTS_PATH) {
        // A stream that opens and stays open and quiet: this test is about
        // the page read, so no stream drop may refetch the list under it.
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('retry: 3000\n\n'));
          },
        }), { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
      }
      if (target === '/api/pages') {
        return new Response(JSON.stringify(listWithPages), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (target === '/api/questions') {
        return new Response(JSON.stringify({ questions: [], openCount: 0 }), {
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
      if (target.startsWith('/api/page?') === false) {
        return new Response(JSON.stringify({ message: 'nothing answers ' + target }), { status: 404 });
      }
      tries++;
      if (tries < 3) return new Response(JSON.stringify({ message: 'the wiki does not hold it' }), { status: 500 });
      return new Response(JSON.stringify(pagesAtR1['docs/vision.md']), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    goto('/p/docs/vision.md');
    await intoApp(createElement(App, { pageRetryMs: 5 }));
    await until(() => text().includes('Could not read the page docs/vision.md'), 'the shown failure');
    await until(() => document.querySelector('main .reading > h1')?.textContent === 'Vision extra', 'the recovered page');
    // The two failures plus the one recovery: a stream held open and quiet
    // keeps every other refetch out, so the count names exactly the page's
    // own tries.
    expect(tries).toBe(3);
  });

  test('stops after a bounded number of tries', async () => {
    const pageTriesLimit = 3;
    const pageCalls: string[] = [];
    (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const target = input instanceof URL ? input.pathname + input.search : String(input);
      if (target === EVENTS_PATH) {
        // A stream that connects and stays quiet: this test is about the page read.
        return new Response(new ReadableStream<Uint8Array>({ start(c) { c.close(); } }), {
          status: 200,
          headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        });
      }
      if (target === '/api/pages') {
        return new Response(JSON.stringify(listWithPages), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (target === '/api/questions') {
        return new Response(JSON.stringify({ questions: [], openCount: 0 }), {
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
    await intoApp(createElement(App, { pageRetryMs: 5, reconnectMs: 60_000 }));
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
    await intoApp(createElement(App, { reconnectMs: 60_000 }));
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
    await intoApp(createElement(App, { reconnectMs: 60_000 }));
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

describe('the reading shell', () => {
  const shellList: PageList = {
    revision: 'r1',
    pages: [
      { path: 'README.md', title: 'README', url: '/p/README.md' },
      { path: 'docs/vision.md', title: 'Vision', url: '/p/docs/vision.md' },
      { path: 'docs/requirements/one.md', title: 'First requirement', url: '/p/docs/requirements/one.md' },
      { path: 'docs/decisions/0001-choice.md', title: 'Decision one', url: '/p/docs/decisions/0001-choice.md' },
      { path: 'docs/research/notes.md', title: 'Research notes', url: '/p/docs/research/notes.md' },
      { path: 'AGENTS.md', title: 'AGENTS', url: '/p/AGENTS.md' },
      { path: 'prototypes/boards.md', title: 'Boards', url: '/p/prototypes/boards.md' },
    ],
  };
  const shellPages: Record<string, Page> = {};
  for (const meta of shellList.pages)
    shellPages[meta.path] = { path: meta.path, title: meta.title, markdown: '# ' + meta.title };

  test('the nav groups the pages by kind, in kind order, each group by path in code point order', async () => {
    install(answerFor(product, shellList, shellPages));
    goto('/');
    await intoApp(createElement(App));
    await until(() => document.querySelector('.app-nav nav') !== null, 'the navigation');
    const titles = [...document.querySelectorAll('.nav-group-title')].map((node) => node.textContent);
    // The Architecture entry (feature E) stands in the life-cycle order: the Design stage's part, after the decisions.
    expect(titles).toEqual(['Product', 'Requirements', 'Decisions', 'Architecture', 'Research', 'Other']);
    const productGroup = [...document.querySelectorAll('[data-nav-group="product"] .nav-link')].map(
      (node) => node.textContent,
    );
    expect(productGroup).toEqual(['README', 'Vision']);
    // Only docs/<folder>/<file>.md names a group of its own; prototypes/boards.md
    // is any other path, so the "other" group takes it, in path order.
    const otherGroup = [...document.querySelectorAll('[data-nav-group="other"] .nav-link')].map(
      (node) => node.textContent,
    );
    expect(otherGroup).toEqual(['AGENTS', 'Boards']);
  });
  test('a product with no decisions group still carries the Architecture entry at the Design stage position', async () => {
    const noDecisions: PageList = {
      revision: 'r1',
      pages: shellList.pages.filter((meta) => !meta.path.startsWith('docs/decisions/')),
    };
    const noDecisionPages: Record<string, Page> = {};
    for (const meta of noDecisions.pages) noDecisionPages[meta.path] = { path: meta.path, title: meta.title, markdown: '# ' + meta.title };
    install(answerFor(product, noDecisions, noDecisionPages));
    goto('/');
    await intoApp(createElement(App));
    await until(() => document.querySelector('.app-nav nav') !== null, 'the navigation');
    const titles = [...document.querySelectorAll('.nav-group-title')].map((node) => node.textContent);
    // The Design stage's part stands after the last present group of the
    // stages before it (requirements here), never omitted for an absent group.
    expect(titles).toEqual(['Product', 'Requirements', 'Architecture', 'Research', 'Other']);
  });


  test('the brand reads madarch, and the product block below it names the product', async () => {
    install(answerFor(product, shellList, shellPages));
    goto('/');
    await intoApp(createElement(App));
    await until(() => document.querySelector('.app-nav .nav-brand') !== null, 'the brand');
    expect(document.querySelector('.app-nav .nav-brand')?.textContent).toContain('madarch');
    expect(document.querySelector('[data-testid="product-block"]')?.textContent).toContain('Draft Idea');
  });

  test('the open page is the one marked: aria-current and a non-color mark on its link alone', async () => {
    install(answerFor(product, shellList, shellPages));
    goto('/p/docs/vision.md');
    await intoApp(createElement(App));
    await until(
      () => document.querySelector('a[href="/p/docs/vision.md"][aria-current="page"]') !== null,
      'the current mark',
    );
    const current = document.querySelectorAll('a[aria-current="page"]');
    expect(current.length).toBe(1);
    expect(current[0]?.getAttribute('href')).toBe('/p/docs/vision.md');
    expect(current[0]?.className).toContain('nav-current');
    expect(document.querySelector('a[href="/p/docs/research/notes.md"]')?.getAttribute('aria-current')).toBeNull();
  });

  test('any page is one click away from the panel', async () => {
    install(answerFor(product, shellList, shellPages));
    goto('/');
    await intoApp(createElement(App));
    await until(() => document.querySelector('.app-nav a[href="/p/docs/research/notes.md"]') !== null, 'the nav link');
    (document.querySelector('.app-nav a[href="/p/docs/research/notes.md"]') as HTMLAnchorElement).click();
    await until(() => document.querySelector('main#page h1')?.textContent === 'Research notes', 'the opened page');
  });

  test('the context panel place exists: empty, closed, named', async () => {
    install(answerFor(product, shellList, shellPages));
    goto('/p/docs/vision.md');
    await intoApp(createElement(App));
    await until(() => document.querySelector('main#page') !== null, 'the page');
    const place = document.querySelector('aside[class~="context-panel"]');
    expect(place).not.toBeNull();
    expect(place?.hasAttribute('hidden')).toBe(true);
    expect(place?.textContent).toBe('');
    expect(place?.getAttribute('aria-label')).toBe('Page context');
  });

  test('the menu button opens the navigation and closes it again', async () => {
    install(answerFor(product, shellList, shellPages));
    goto('/p/docs/vision.md');
    await intoApp(createElement(App));
    await until(() => document.querySelector('.shell-menu') !== null, 'the menu button');
    const button = document.querySelector('.shell-menu') as HTMLButtonElement;
    expect(button.getAttribute('aria-expanded')).toBe('false');
    button.click();
    await until(() => document.querySelector('.shell.nav-open') !== null, 'the opened menu');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    button.click();
    await until(() => document.querySelector('.shell.nav-open') === null, 'the closed menu');
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  test('choosing a page from the opened menu closes it', async () => {
    install(answerFor(product, shellList, shellPages));
    goto('/p/docs/vision.md');
    await intoApp(createElement(App));
    await until(() => document.querySelector('.shell-menu') !== null, 'the menu button');
    (document.querySelector('.shell-menu') as HTMLButtonElement).click();
    await until(() => document.querySelector('.shell.nav-open') !== null, 'the opened menu');
    (document.querySelector('a[href="/p/docs/research/notes.md"]') as HTMLAnchorElement).click();
    await until(() => document.querySelector('.shell.nav-open') === null, 'the closed menu');
    await until(() => document.querySelector('main#page h1')?.textContent === 'Research notes', 'the opened page');
  });
});

describe('groupNav', () => {
  test('fixed kinds first, then the remaining group names in code point order, pages within a group by path', () => {
    const grouped = groupNav([
      { path: 'prototypes/boards.md', title: 'B', url: '' },
      { path: 'AGENTS.md', title: 'A', url: '' },
      { path: 'docs/vision.md', title: 'V', url: '' },
      { path: 'README.md', title: 'R', url: '' },
      { path: 'docs/a/one.md', title: '1', url: '' },
      { path: 'docs/requirements/one.md', title: '2', url: '' },
      { path: 'docs/decisions/0001.md', title: '3', url: '' },
      { path: 'docs/research/notes.md', title: '4', url: '' },
      { path: 'docs/nested/folder/file.md', title: '5', url: '' },
    ]);
    expect(grouped.map((group) => group.name)).toEqual([
      'product', 'requirements', 'decisions', 'research', 'a', 'other',
    ]);
    expect(grouped[0]?.pages.map((page) => page.path)).toEqual(['README.md', 'docs/vision.md']);
    // Only docs/<folder>/<file>.md names its own group: a path outside docs/,
    // a deeper docs/ path and prototypes/boards.md are any other path.
    expect(grouped[5]?.pages.map((page) => page.path)).toEqual([
      'AGENTS.md', 'docs/nested/folder/file.md', 'prototypes/boards.md',
    ]);
  });

  test('paths sort by code points, not UTF-16 units: a private-use BMP code point precedes an astral one', () => {
    // Each path's first folder is one name written as a single escape, so the
    // group names are the two code points themselves. UTF-16 < would order by
    // code units and put the astral group (D800...) before the BMP one (E000);
    // code point order puts U+E000 first.
    const grouped = groupNav([
      { path: 'docs/\u{10000}/later.md', title: 'astral', url: '' },
      { path: 'docs/\uE000/first.md', title: 'private', url: '' },
    ]);
    const names = grouped.map((group) => group.name);
    expect(names[0]).toBe(String.fromCodePoint(0xe000));
    expect(names[1]).toBe(String.fromCodePoint(0x10000));
  });
});


 describe('the focus mode', () => {
  const focusList: PageList = {
    revision: 'r1',
    pages: [
      { path: 'README.md', title: 'Readme', url: '/p/README.md' },
      { path: 'docs/vision.md', title: 'Vision', url: '/p/docs/vision.md' },
      { path: 'docs/research/notes.md', title: 'Research notes', url: '/p/docs/research/notes.md' },
    ],
  };
  const focusPages: Record<string, Page> = {};
  for (const meta of focusList.pages)
    focusPages[meta.path] = { path: meta.path, title: meta.title, markdown: '# ' + meta.title };

  test('a toolbar control hides both panel places, says it with aria-pressed, and is a reachable button', async () => {
    install(answerFor(product, focusList, focusPages));
    goto('/p/docs/vision.md');
    await intoApp(createElement(App));
    await until(() => document.querySelector('.shell-focus') !== null, 'the focus control');
    const control = document.querySelector('.shell-focus') as HTMLButtonElement;
    expect(control instanceof HTMLButtonElement).toBe(true);
    expect(control.getAttribute('aria-pressed')).toBe('false');
    expect(() => control.focus()).not.toThrow();
    expect(document.activeElement).toBe(control);
    control.click();
    await until(() => document.querySelector('.shell.doc-only') !== null, 'the focused shell');
    expect(control.getAttribute('aria-pressed')).toBe('true');
    // The hide is in the DOM, not only in the stylesheet: the navigation loses
    // its visibility attribute and the shell names the doc-only state.
    expect(document.querySelector('#app-nav')?.hasAttribute('hidden')).toBe(true);
    expect(document.querySelector('.context-panel')?.hasAttribute('hidden')).toBe(true);
    expect(document.querySelector('main')).not.toBeNull();
  });

  test('the same control brings the panels back and says so', async () => {
    install(answerFor(product, focusList, focusPages));
    goto('/p/docs/vision.md');
    await intoApp(createElement(App));
    await until(() => document.querySelector('.shell-focus') !== null, 'the focus control');
    (document.querySelector('.shell-focus') as HTMLButtonElement).click();
    await until(() => document.querySelector('.shell.doc-only') !== null, 'the focused shell');
    (document.querySelector('.shell-focus') as HTMLButtonElement).click();
    await until(() => document.querySelector('.shell.doc-only') === null, 'the unfocused shell');
    expect(document.querySelector('.shell-focus')?.getAttribute('aria-pressed')).toBe('false');
  });

  test('the choice stays for the open page only: opening another page clears it', async () => {
    install(answerFor(product, focusList, focusPages));
    goto('/p/docs/vision.md');
    await intoApp(createElement(App));
    await until(() => document.querySelector('.shell-focus') !== null, 'the focus control');
    (document.querySelector('.shell-focus') as HTMLButtonElement).click();
    await until(() => document.querySelector('.shell.doc-only') !== null, 'the focused shell');
    (
      document.querySelector('#app-nav a[href="/p/README.md"]') as HTMLAnchorElement
    ).click();
    await until(() => document.querySelector('main h1')?.textContent === 'Readme', 'the opened page');
    await until(() => document.querySelector('.shell.doc-only') === null, 'the cleared focus');
    expect(document.querySelector('.shell-focus')?.getAttribute('aria-pressed')).toBe('false');
  });
 });




 describe('the phone shell', () => {
  const phoneList: PageList = {
    revision: 'r1',
    pages: [
      { path: 'README.md', title: 'Readme', url: '/p/README.md' },
      { path: 'docs/vision.md', title: 'Vision', url: '/p/docs/vision.md' },
      { path: 'docs/decisions/0001-choice.md', title: 'Decision one', url: '/p/docs/decisions/0001-choice.md' },
    ],
  };
  const phonePages: Record<string, Page> = {};
  for (const meta of phoneList.pages)
    phonePages[meta.path] = { path: meta.path, title: meta.title, markdown: '# ' + meta.title };

  test('the toolbar carries the breadcrumb, the menu and the toggles apart, no crowding', async () => {
    install(answerFor(product, phoneList, phonePages));
    goto('/p/docs/decisions/0001-choice.md');
    await intoApp(createElement(App));
    await until(() => document.querySelector('.shell-breadcrumb') !== null, 'the breadcrumb');
    expect(document.querySelector('.shell-breadcrumb')?.textContent).toBe('Decisions / Decision one');
    expect(document.querySelector('.shell-menu')).not.toBeNull();
    expect(document.querySelector('.shell-focus')).not.toBeNull();
    expect(document.querySelector('.shell-menu')?.getAttribute('aria-label')).toBe('Document navigation');
    expect(document.querySelector('.shell-focus')?.getAttribute('aria-label')).toBe('Focus mode');
    expect(document.querySelector('button[aria-label="Page context"]')).not.toBeNull();
  });

  test('escape closes the opened menu and focus returns to the menu button', async () => {
    install(answerFor(product, phoneList, phonePages));
    goto('/p/docs/vision.md');
    await intoApp(createElement(App));
    await until(() => document.querySelector('.shell-menu') !== null, 'the menu button');
    const button = document.querySelector('.shell-menu') as HTMLButtonElement;
    button.click();
    await until(() => document.querySelector('.shell.nav-open') !== null, 'the opened menu');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await until(() => document.querySelector('.shell.nav-open') === null, 'the closed menu');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
  });
 });



describe('language switch', () => {
  test('the globe menu changes chrome strings, marks the choice, and remembers it', async () => {
    await setWikiLanguage('en');
    install(answerFor(product, listWithPages, pagesAtR1));
    goto('/');
    await intoApp(createElement(App));
    await until(() => document.querySelector('[data-testid="nav-overview"]') !== null, 'the overview control');
    expect(document.querySelector('[data-testid="nav-overview"]')?.textContent).toContain('Product overview');

    const globe = document.querySelector('.shell-language') as HTMLButtonElement | null;
    expect(globe?.getAttribute('aria-label')).toBe('Language');
    expect(globe?.getAttribute('title')).toBe('Choose language');
    expect(globe?.getAttribute('aria-haspopup')).toBe('menu');
    await setWikiLanguage('ru');
    await until(() => document.querySelector('[data-testid="nav-overview"]')?.textContent?.includes('Обзор продукта'), 'Russian chrome');
    await until(() => document.documentElement.lang === 'ru', 'Russian document language metadata');
    expect(document.title).toBe('Draft Idea — вики продукта');
    expect(document.querySelector('.shell-language')?.getAttribute('aria-label')).toBe('Язык');
    expect(window.localStorage.getItem(languageStorageKey)).toBe('ru');
    await until(() => document.querySelector('.status-details')?.textContent?.includes('3 документа'), 'the Russian status count');
    expect(document.querySelector('.status-details')?.textContent).toContain('3 документа');
    expect(document.querySelector('.status-details')?.textContent).toContain('Markdown');
    expect(document.querySelector('.status-details')?.textContent).toContain('UTF-8');

    unmount();
    goto('/');
    await intoApp(createElement(App));
    await until(() => document.querySelector('[data-testid="nav-overview"]')?.textContent?.includes('Обзор продукта'), 'the saved Russian choice after reload');

    await setWikiLanguage('en');
    await until(() => document.querySelector('[data-testid="nav-overview"]')?.textContent?.includes('Product overview'), 'English chrome');
    await until(() => document.documentElement.lang === 'en', 'English document language metadata');
    expect(document.title).toBe('Draft Idea — product wiki');
    expect(window.localStorage.getItem(languageStorageKey)).toBe('en');
  });
});


describe('real page metadata', () => {
  test('the eyebrow formats the file mtime in the selected locale', async () => {
    await setWikiLanguage('en');
    const changedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const pagesWithMtime: Record<string, Page> = {
      ...pagesAtR1,
      'docs/vision.md': { ...pagesAtR1['docs/vision.md']!, changedAt },
    };
    install(answerFor(product, listWithPages, pagesWithMtime));
    goto('/p/docs/vision.md');
    await intoApp(createElement(App));
    await until(() => document.querySelector('.document-meta')?.textContent?.includes('changed 5 min. ago'), 'the English changed-time label');
    expect(document.querySelector('.document-meta')?.textContent).toContain('Product vision');

    await setWikiLanguage('ru');
    await until(() => document.querySelector('.document-meta')?.textContent?.includes('изменён 5 мин. назад'), 'the Russian changed-time label');
    expect(document.querySelector('.document-meta')?.textContent).toContain('Видение продукта');
    await setWikiLanguage('en');
  });
});


describe('the open questions', () => {
  const openQuestion: QuestionEntry = {
    path: 'docs/questions/Q-004-who-collects.md',
    id: 'Q-004',
    title: 'Who collects the unclaimed portions?',
    question: 'Does the owner want to be told?',
    who: 'the cafe owner',
    concerns: ['UC-001', 'FR-002'],
    state: 'open',
  };
  const answeredQuestion: QuestionEntry = {
    path: 'docs/questions/Q-002-delivery.md',
    id: 'Q-002',
    title: 'Should leftovers be delivered?',
    question: 'Do buyers expect the portions to be delivered?',
    who: 'the product owner',
    concerns: ['VISION'],
    state: 'answered',
    answer: 'A first run showed no buyer asked for delivery.',
  };
  const notApplicable: QuestionEntry = {
    path: 'docs/questions/Q-003-chains.md',
    id: 'Q-003',
    title: 'Chains with their own apps?',
    question: 'Do we serve chains that already run their own ordering apps?',
    who: 'the product owner',
    concerns: ['VISION'],
    state: 'not-applicable',
    answer: 'Not applicable: chains are out of the vision.',
  };

  test('the sidebar names the view with the live count, in Russian with its plurals', async () => {
    await setWikiLanguage('en');
    const list: QuestionList = { questions: [openQuestion, answeredQuestion, notApplicable], openCount: 1 };
    install(answerFor(product, listWithPages, pagesAtR1, list));
    goto('/');
    await intoApp(createElement(App));
    await until(() => text().includes('Open questions'), 'the sidebar entry');
    expect(document.querySelector('[data-testid="open-questions-count"]')?.textContent).toBe('1');
    await setWikiLanguage('ru');
    await until(() => text().includes('Открытые вопросы'), 'the Russian entry');
    await setWikiLanguage('en');
  });

  test('the questions view lists the open ones first and the closed ones muted with their answers', async () => {
    const list: QuestionList = { questions: [openQuestion, answeredQuestion, notApplicable], openCount: 1 };
    install(answerFor(product, listWithPages, pagesAtR1, list));
    goto('/questions');
    await intoApp(createElement(App));
    await until(() => document.querySelector('[data-testid="questions-view"]') !== null, 'the questions view');
    const view = document.querySelector('[data-testid="questions-view"]')!;
    const rows = [...view.querySelectorAll('[data-question-id]')];
    expect(rows.map((row) => row.getAttribute('data-question-id'))).toEqual(['Q-004', 'Q-002', 'Q-003']);
    expect(view.querySelector('[data-testid="questions-count"]')?.textContent).toContain('1');
    expect(view.querySelector('[data-testid="questions-closed"]')).not.toBeNull();
    expect(view.textContent).toContain('Not applicable: chains are out of the vision.');
  });

  test('answering a question closes it: the count drops and the row moves to the closed read', async () => {
    const before: QuestionList = { questions: [openQuestion, answeredQuestion, notApplicable], openCount: 1 };
    const stream = installWithStream(answerFor(product, listWithPages, pagesAtR1, before));
    goto('/questions');
    await intoApp(createElement(App, { reconnectMs: 5 }));
    await until(() => document.querySelector('[data-testid="open-questions-count"]')?.textContent === '1', 'the first count');
    const closed: QuestionList = {
      questions: [{ ...openQuestion, state: 'answered', answer: 'The owner collects them.' }, answeredQuestion, notApplicable],
      openCount: 0,
    };
    stream.set(answerFor(product, listWithPages, pagesAtR1, closed));
    stream.push('event: change\ndata: {"revision":"r2"}\n\n');
    await until(() => document.querySelector('[data-testid="open-questions-count"]')?.textContent === '0', 'the answered count');
    await until(() => text().includes('The owner collects them.'), 'the answer shown');
    expect(stream.calls.filter((call) => call === EVENTS_PATH).length).toBe(1);
  });

  test('the draft carries its audience on the home; a draft without a vision says so', async () => {
    const withAudience: ProductWithAudience = { ...product, audience: 'Owners of small cafes with fewer than twenty seats.' };
    install(answerFor(withAudience, listWithPages, pagesAtR1));
    goto('/');
    await intoApp(createElement(App));
    await until(() => document.querySelector('[data-testid="home-audience"]') !== null, 'the audience line');
    expect(document.querySelector('[data-testid="home-audience"]')?.textContent).toContain('Owners of small cafes');
    unmount();
    install(answerFor(product, listWithPages, pagesAtR1));
    goto('/');
    await intoApp(createElement(App));
    await until(() => document.querySelector('[data-testid="home-audience"]')?.textContent?.includes('not written yet'), 'the empty audience line');
  });
});
