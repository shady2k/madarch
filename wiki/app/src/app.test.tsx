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

test('a change event refreshes the navigation and asks the current page again', async () => {
  class FakeSource {
    static last: FakeSource | undefined;
    static readonly all: FakeSource[] = [];
    private readonly listeners: (() => void)[] = [];
    constructor() { FakeSource.last = this; FakeSource.all.push(this); }
    addEventListener(type: string, listener: () => void): void { if (type === 'change') this.listeners.push(listener); (FakeSource as unknown as { registered: number }).registered = ((FakeSource as unknown as { registered: number }).registered ?? 0) + 1; }
    close(): void { /* closed by the app */ }
    emit(): void { for (const listener of this.listeners) listener(); }
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
    expect((FakeSource as unknown as { registered: number }).registered).toBeGreaterThan(0);
    await act(async () => { for (const source of FakeSource.all) source.emit(); });
    await settle();
    expect(bootstraps).toBe(2);
    expect(pages).toBe(2);
  } finally {
    await page.close();
  }
});

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
    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
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
