/**
 * The app's one page view (decision 0036, sections 6 and 7): the bootstrap is read once, a page is one operation, and a
 * press on the table's next page asks that same operation again. The graph is a stub: the shapes it answers here are the
 * shapes the real schema answers.
 */
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register({ url: 'http://localhost/' });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { App } = await import('./app.js');

afterAll(() => { GlobalRegistrator.unregister(); });

const TEMPLATE = `template: probe
sections:
  - id: header
    component: header
    query: |
      id
      kind
      label
    params:
      titlePath: label
      kindPath: kind
  - id: records
    component: table
    query: |
      id
      instances(first: $records_first, after: $records_after) {
        edges {
          node {
            id
            kind
            label
            template
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
        totalCount
      }
    params:
      path: instances
      pageSize: 2
      columns:
        - label: { en: Label }
          path: node.label
`;

const ID = '00000000-0000-0000-0000-00000000dead';

const bootstrap = {
  structureRevision: 'r1',
  home: null,
  catalogueTemplate: 'probe',
  templates: [{ name: 'probe', body: TEMPLATE }],
  recordTemplates: [],
  ownTemplates: [],
  roles: ['analyst'],
};

const navigation = {
  product: 'Madarch',
  groups: [{ name: 'code', labels: { en: 'Code', ru: 'Код' }, short: null, open: false, parent: null }],
  kinds: [{ kind: 'a.b', one: 'A', many: 'As', definition: null, taken: true, group: 'code', nav: null, count: 2, entryId: ID }],
};

const requests: { query: string; variables: Record<string, unknown> }[] = [];
let readerRole = 'everything';

function answerFor(query: string, variables: Record<string, unknown>): unknown {
  if (query.includes('bootstrap')) return { data: { bootstrap, navigation } };
  const after = variables['records_after'];
  return {
    data: {
      s_header: { id: ID, kind: 'catalogue', label: 'A kind' },
      s_records: {
        instances: {
          totalCount: 3,
          pageInfo: { hasNextPage: after === undefined, endCursor: 'cursor-2' },
          edges: (after === undefined ? ['one', 'two'] : ['three']).map((label) => ({ node: { id: `${label}-id`, kind: 'a.b', label, template: 'entity' } })),
        },
      },
    },
  };
}

beforeEach(() => {
  requests.length = 0;
  readerRole = 'everything';
  try { window.localStorage.clear(); } catch { /* no storage */ }
  // The frame's «Заполнить…» button reads the product's command state, and the change stream is silent here.
  (globalThis as { EventSource?: unknown }).EventSource = undefined;
  (globalThis as { fetch: typeof fetch }).fetch = (async (url: string, init?: { body?: string }) => {
    const path = String(url);
    if (!path.endsWith('/graphql')) {
      const command = path.includes('/api/settings')
        ? { role: readerRole, asked: true, roles: ['analyst', 'everything'] }
        : path.includes('/api/problems')
          ? { open: 3, closed: 0, dismissed: 0, sections: { code: 3, documents: 0, wiki: 0 } }
          : path.includes('/api/status')
            ? { fill: { state: 'idle' } }
            : path.includes('/api/fill-plan') ? { order: [], kinds: [], catalogue: [], requiresAgent: false, unproduced: [] } : {};
      return new Response(JSON.stringify(command), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const body = JSON.parse(init?.body ?? '{}') as { query: string; variables?: Record<string, unknown> };
    requests.push({ query: body.query, variables: body.variables ?? {} });
    return new Response(JSON.stringify(answerFor(body.query, body.variables ?? {})), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
});

async function settle(): Promise<void> {
  for (let at = 0; at < 8; at += 1) await act(async () => { await Promise.resolve(); });
}

async function render(): Promise<{ container: HTMLElement; close: () => Promise<void> }> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(App)); });
  await settle();
  return { container, close: async () => { await act(async () => { root.unmount(); }); container.remove(); } };
}

test('one page view is one operation, after one bootstrap', async () => {
  expect(window.location.pathname).toBe('/');
  window.history.pushState({}, '', `/e/catalogue/${ID}`);
  const page = await render();
  try {
    expect(page.container.querySelector('h1')?.textContent).toBe('A kind');
    expect(page.container.textContent).toContain('A kind');
    expect(page.container.textContent).toContain('one');
    expect(requests.filter((one) => one.query.includes('bootstrap'))).toHaveLength(1);
    const pages = requests.filter((one) => !one.query.includes('bootstrap'));
    expect(pages).toHaveLength(1);
    expect(pages[0]?.variables['id']).toBe(ID);
    // The operation aliases each section and asks for the first page of the connection.
    expect(pages[0]?.query).toContain('s_header: entity(id: $id, lang: $lang)');
    expect(pages[0]?.query).toContain('s_records: entity(id: $id, lang: $lang)');
    expect(pages[0]?.variables['records_first']).toBe(2);
  } finally {
    await page.close();
  }
});

test('a press on the next page asks the same operation with the cursor', async () => {
  window.history.pushState({}, '', `/e/catalogue/${ID}`);
  const page = await render();
  try {
    const next = [...page.container.querySelectorAll('button')].find((one) => one.textContent === '→');
    await act(async () => { next?.click(); });
    await settle();
    const pages = requests.filter((one) => !one.query.includes('bootstrap'));
    expect(pages).toHaveLength(2);
    expect(pages[1]?.query).toBe(pages[0]?.query);
    expect(pages[1]?.variables['records_after']).toBe('cursor-2');
    expect(page.container.textContent).toContain('three');
  } finally {
    await page.close();
  }
});

test('a path that is no page says so, and asks the graph for nothing', async () => {
  window.history.pushState({}, '', '/nothing/here');
  const page = await render();
  try {
    expect(page.container.textContent).toContain('no page stands at /nothing/here');
    expect(requests.filter((one) => !one.query.includes('bootstrap'))).toHaveLength(0);
  } finally {
    await page.close();
  }
});



test('a page change reads its own page and does not read the frame\'s answers again', async () => {
  const frameFetch = globalThis.fetch;
  let problems = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes('/api/problems')) problems += 1;
    return await (frameFetch as typeof fetch)(input, init);
  }) as typeof fetch;
  window.history.pushState({}, '', `/e/catalogue/${ID}`);
  const page = await render();
  try {
    const firstPages = requests.filter((one) => !one.query.includes('bootstrap')).length;
    expect(firstPages).toBe(1);
    expect(problems).toBe(1);
    await act(async () => {
      window.history.pushState({}, '', '/e/catalogue/00000000-0000-0000-0000-00000000beef');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await settle();
    expect(requests.filter((one) => !one.query.includes('bootstrap'))).toHaveLength(firstPages + 1);
    expect(problems).toBe(1);
  } finally {
    await page.close();
  }
});

test('the saved role is the active role at start', async () => {
  readerRole = 'analyst';
  window.history.pushState({}, '', '/');
  const page = await render();
  try {
    expect(page.container.querySelector('[data-testid="role-menu"]')?.textContent).toContain('Analyst');
  } finally {
    await page.close();
  }
});

test('a server that cannot be reached shows one calm state and comes back by itself', async () => {
  const reachableFetch = globalThis.fetch;
  let reachable = false;
  let failures = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!reachable) {
      failures += 1;
      throw new TypeError('Failed to fetch');
    }
    return await (reachableFetch as typeof fetch)(input, init);
  }) as typeof fetch;
  window.history.pushState({}, '', '/');
  const page = await render();
  try {
    expect(page.container.querySelector('[data-testid="connection-banner"]')?.textContent).toContain('No connection to the madarch server — reconnecting…');
    expect(page.container.querySelector('[data-testid="connection-countdown"]')?.textContent).toMatch(/next attempt in|checking the connection/);
    expect(page.container.querySelector('[data-testid="connection-retry"]')).not.toBeNull();
    expect(page.container.textContent).not.toContain('Failed to fetch');
    // «Повторить сейчас» probes at once.
    const beforeRetry = failures;
    await act(async () => { (page.container.querySelector('[data-testid="connection-retry"]') as HTMLButtonElement | null)?.click(); await new Promise((resolve) => setTimeout(resolve, 60)); });
    expect(failures).toBeGreaterThan(beforeRetry);
    const before = failures;
    // The probe comes by itself, at the first backoff step, and fails again while the server is down.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_200)); });
    expect(failures).toBeGreaterThan(before);
    reachable = true;
    // «Повторить сейчас» lifts the calm state; the frame says so for two seconds, then the line goes.
    await act(async () => { (page.container.querySelector('[data-testid="connection-retry"]') as HTMLButtonElement | null)?.click(); await new Promise((resolve) => setTimeout(resolve, 120)); });
    await settle();
    expect(page.container.querySelector('[data-testid="connection-banner"]')?.getAttribute('data-state')).toBe('restored');
    expect(page.container.textContent).toContain('Connection restored');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2_200)); });
    await settle();
    expect(page.container.querySelector('[data-testid="connection-banner"]')).toBeNull();
    expect(page.container.querySelector('[data-testid="wiki-app"]')).not.toBeNull();
    expect(page.container.textContent).not.toContain('Failed to fetch');
  } finally {
    await page.close();
  }
}, 10_000);

test('a 503 while the server starts reads as the server starting, not a block error', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ message: 'the graph answered 503' }), { status: 503, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  window.history.pushState({}, '', '/');
  const page = await render();
  try {
    expect(page.container.querySelector('[data-testid="connection-banner"]')?.getAttribute('data-state')).toBe('starting');
    expect(page.container.textContent).toContain('The server is starting…');
    expect(page.container.textContent).not.toContain('the graph answered 503');
    expect(page.container.querySelector('[data-testid="wiki-error"]')).toBeNull();
  } finally {
    await page.close();
  }
}, 10_000);

test('a lost connection keeps the last page data, dimmed, with its time', async () => {
  const frameFetch = globalThis.fetch;
  let lost = false;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (lost) throw new TypeError('Failed to fetch');
    return await (frameFetch as typeof fetch)(input, init);
  }) as typeof fetch;
  window.history.pushState({}, '', `/e/catalogue/${ID}`);
  const page = await render();
  try {
    expect(page.container.querySelector('h1')?.textContent).toBe('A kind');
    lost = true;
    await act(async () => {
      window.history.pushState({}, '', '/e/catalogue/00000000-0000-0000-0000-00000000beef');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await settle();
    expect(page.container.querySelector('[data-testid="connection-banner"]')).not.toBeNull();
    expect(page.container.querySelector('[data-testid="page-content"]')?.getAttribute('data-stale')).toBe('true');
    expect(page.container.querySelector('[data-testid="connection-data-as-of"]')?.textContent).toContain('data as of');
    expect(page.container.querySelector('h1')?.textContent).toBe('A kind');
  } finally {
    await page.close();
  }
}, 10_000);

test('a change event refreshes the navigation and asks the current page again', async () => {
  class FakeSource {
    static last: FakeSource | undefined;
    static readonly all: FakeSource[] = [];
    private readonly listeners: ((event: MessageEvent<string>) => void)[] = [];
    constructor() { FakeSource.last = this; FakeSource.all.push(this); }
    addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void { if (type === 'change') this.listeners.push(listener); (FakeSource as unknown as { registered: number }).registered = ((FakeSource as unknown as { registered: number }).registered ?? 0) + 1; }
    close(): void { /* closed by the app */ }
    emit(data = ''): void { for (const listener of this.listeners) listener({ data } as MessageEvent<string>); }
  }
  (globalThis as { EventSource?: unknown }).EventSource = FakeSource as unknown as typeof EventSource;
  expect(globalThis.EventSource).toBe(FakeSource as unknown as typeof EventSource);
  let bootstraps = 0;
  let pages = 0;
  (globalThis as { fetch: typeof fetch }).fetch = (async (url: string, init?: { body?: string }) => {
    const path = String(url);
    if (!path.endsWith('/graphql')) return new Response(JSON.stringify(path.includes('/api/problems') ? { open: 3 } : { fill: { state: 'idle' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    const body = JSON.parse(init?.body ?? '{}') as { query: string; variables?: Record<string, unknown> };
    if (body.query.includes('bootstrap')) {
      bootstraps += 1;
      return new Response(JSON.stringify({ data: { bootstrap, navigation: { ...navigation, kinds: navigation.kinds.map((one) => ({ ...one, count: bootstraps })) } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    pages += 1;
    return new Response(JSON.stringify(answerFor(body.query, body.variables ?? {})), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  window.history.pushState({}, '', `/e/catalogue/${ID}`);
  const page = await render();
  try {
    expect(bootstraps).toBe(1);
    expect(pages).toBe(1);
    expect(FakeSource.last).toBeDefined();
    expect(FakeSource.all).toHaveLength(1);
    expect((FakeSource as unknown as { registered: number }).registered).toBeGreaterThan(0);
    // The stream opens by naming the revision the page already read: that notice is not a change.
    await act(async () => { for (const source of FakeSource.all) source.emit(); });
    await settle();
    expect(bootstraps).toBe(1);
    expect(pages).toBe(1);
    await act(async () => { for (const source of FakeSource.all) source.emit(JSON.stringify({ revision: '2', structure: true })); });
    await settle();
    expect(bootstraps).toBe(2);
    expect(pages).toBe(2);
  } finally {
    await page.close();
  }
});

test('a unit publication grows the sidebar before the run ends, without a reload', async () => {
  class FakeSource {
    static readonly all: FakeSource[] = [];
    private readonly listeners: ((event: MessageEvent<string>) => void)[] = [];
    constructor() { FakeSource.all.push(this); }
    addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void { if (type === 'change') this.listeners.push(listener); }
    close(): void { /* closed by the app */ }
    emit(data = ''): void { for (const listener of this.listeners) listener({ data } as MessageEvent<string>); }
  }
  (globalThis as { EventSource?: unknown }).EventSource = FakeSource as unknown as typeof EventSource;
  let navCount = 0;
  let bootstraps = 0;
  let pages = 0;
  const nav = (count: number) => ({ ...navigation, kinds: navigation.kinds.map((one) => ({ ...one, count })) });
  (globalThis as { fetch: typeof fetch }).fetch = (async (url: string, init?: { body?: string }) => {
    const path = String(url);
    if (!path.endsWith('/graphql')) {
      const command = path.includes('/api/settings')
        ? { role: readerRole, asked: true, roles: ['analyst', 'everything'] }
        : path.includes('/api/problems') ? { open: 0, closed: 0, dismissed: 0, sections: {} } : { fill: { state: 'idle' } };
      return new Response(JSON.stringify(command), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const body = JSON.parse(init?.body ?? '{}') as { query: string; variables?: Record<string, unknown> };
    if (body.query.includes('bootstrap')) {
      bootstraps += 1;
      return new Response(JSON.stringify({ data: { bootstrap, navigation: nav(navCount) } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (body.query.includes('navigation')) {
      return new Response(JSON.stringify({ data: { navigation: nav(navCount) } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    pages += 1;
    return new Response(JSON.stringify(answerFor(body.query, body.variables ?? {})), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  window.history.pushState({}, '', '/e/catalogue/00000000-0000-0000-0000-00000000beef');
  const page = await render();
  try {
    expect(page.container.querySelector('[data-testid="nav-kind"]')).toBeNull();
    // The stream's opening revision is not a change; the unit publication after it is.
    await act(async () => { for (const source of FakeSource.all) source.emit(JSON.stringify({ revision: '1' })); });
    navCount = 4;
    await act(async () => { for (const source of FakeSource.all) source.emit(JSON.stringify({ revision: '2', kinds: ['a.b'], facts: 4 })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
    await settle();
    expect(page.container.querySelector('[data-testid="nav-kind"]')).not.toBeNull();
    expect(page.container.querySelector('[data-testid="nav-count"]')?.textContent).toBe('4');
    expect(page.container.querySelector('[data-testid="nav-kind"]')?.getAttribute('data-changed')).toBe('true');
    expect(bootstraps).toBe(1);
    expect(pages).toBe(1);
  } finally {
    await page.close();
  }
}, 10_000);

test('a catalogue entry page reads again when the kind it lists changed', async () => {
  class FakeSource {
    static readonly all: FakeSource[] = [];
    private readonly listeners: ((event: MessageEvent<string>) => void)[] = [];
    constructor() { FakeSource.all.push(this); }
    addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void { if (type === 'change') this.listeners.push(listener); }
    close(): void { /* closed by the app */ }
    emit(data = ''): void { for (const listener of this.listeners) listener({ data } as MessageEvent<string>); }
  }
  (globalThis as { EventSource?: unknown }).EventSource = FakeSource as unknown as typeof EventSource;
  let pages = 0;
  (globalThis as { fetch: typeof fetch }).fetch = (async (url: string, init?: { body?: string }) => {
    const path = String(url);
    if (!path.endsWith('/graphql')) {
      const command = path.includes('/api/settings')
        ? { role: readerRole, asked: true, roles: ['analyst', 'everything'] }
        : path.includes('/api/problems') ? { open: 0, closed: 0, dismissed: 0, sections: {} } : { fill: { state: 'idle' } };
      return new Response(JSON.stringify(command), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const body = JSON.parse(init?.body ?? '{}') as { query: string; variables?: Record<string, unknown> };
    if (body.query.includes('bootstrap')) return new Response(JSON.stringify({ data: { bootstrap, navigation } }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (body.query.includes('navigation')) return new Response(JSON.stringify({ data: { navigation } }), { status: 200, headers: { 'content-type': 'application/json' } });
    pages += 1;
    return new Response(JSON.stringify(answerFor(body.query, body.variables ?? {})), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  window.history.pushState({}, '', `/e/catalogue/${ID}`);
  const page = await render();
  try {
    expect(pages).toBe(1);
    // The stream's opening revision is not a change; the unit publication after it is.
    await act(async () => { for (const source of FakeSource.all) source.emit(JSON.stringify({ revision: '1' })); });
    await act(async () => { for (const source of FakeSource.all) source.emit(JSON.stringify({ revision: '2', kinds: ['a.b'], facts: 4 })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
    await settle();
    expect(pages).toBe(2);
  } finally {
    await page.close();
  }
}, 10_000);

test('the sidebar\'s «Ждёт вас» count is the problems listing\'s open total', async () => {
  window.history.pushState({}, '', '/');
  const page = await render();
  try {
    expect(page.container.querySelector('[data-testid="nav-problems-count"]')?.textContent).toBe('3');
  } finally {
    await page.close();
  }
});

for (const obsoleteError of [false, true]) {
  test(`a superseded page ${obsoleteError ? 'error' : 'answer'} cannot replace the current page`, async () => {
    window.history.pushState({}, '', `/e/catalogue/${ID}`);
    const pending: ((value: Response) => void)[] = [];
    globalThis.fetch = (async (url: string, init?: { body?: string }) => {
      const path = String(url);
      if (!path.endsWith('/graphql')) {
        const command = path.includes('/api/settings')
          ? { role: readerRole, asked: true, roles: ['analyst', 'everything'] }
          : path.includes('/api/problems')
            ? { open: 3, closed: 0, dismissed: 0, sections: { code: 3, documents: 0, wiki: 0 } }
            : path.includes('/api/status') ? { fill: { state: 'idle' } } : {};
        return new Response(JSON.stringify(command), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const body = JSON.parse(init?.body ?? '{}') as { query: string; variables?: Record<string, unknown> };
      if (body.query.includes('bootstrap')) return new Response(JSON.stringify(answerFor(body.query, body.variables ?? {})));
      return await new Promise<Response>((resolve) => { pending.push(resolve); });
    }) as typeof fetch;
    const page = await render();
    try {
      expect(pending).toHaveLength(1);
      await act(async () => {
        window.history.pushState({}, '', `/e/catalogue/00000000-0000-0000-0000-00000000beef`);
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
      await settle();
      expect(pending).toHaveLength(2);
      const current = { data: { s_header: { id: 'current', kind: 'catalogue', label: 'Current page' } } };
      await act(async () => { pending[1]?.(new Response(JSON.stringify(current))); });
      await settle();
      expect(page.container.querySelector('h1')?.textContent).toBe('Current page');
      const obsolete = obsoleteError ? { errors: [{ message: 'Obsolete failure' }] } : { data: { s_header: { id: 'old', kind: 'catalogue', label: 'Obsolete page' } } };
      await act(async () => { pending[0]?.(new Response(JSON.stringify(obsolete))); });
      await settle();
      expect(page.container.querySelector('h1')?.textContent).toBe('Current page');
      expect(page.container.textContent).not.toContain('Obsolete failure');
    } finally {
      await page.close();
    }
  });
}

test('the brand is lowercase and the product block is a link with no chevron', async () => {
  const page = await render();
  try {
    const brand = page.container.querySelector('[data-testid="nav-brand"]');
    expect(brand?.tagName).toBe('A');
    expect(brand?.querySelector('strong')?.textContent).toBe('madarch');
    const product = page.container.querySelector('[data-testid="product-selector"]') as HTMLAnchorElement | null;
    expect(product?.tagName).toBe('A');
    expect(product?.getAttribute('href')).toBe('/');
    expect(product?.querySelector('svg')).toBeNull();
    const initial = product?.querySelector('.product-initial');
    expect(initial?.className).toContain('font-sans');
    expect(initial?.className).not.toContain('font-serif');
    expect(initial?.textContent).toBe('M');
  } finally { await page.close(); }
});
