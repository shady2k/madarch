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
  kinds: [{ kind: 'a.b', one: 'A', many: 'As', group: 'code', count: 2, entryId: ID }],
};

const requests: { query: string; variables: Record<string, unknown> }[] = [];

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
  (globalThis as { fetch: typeof fetch }).fetch = (async (_url: string, init?: { body?: string }) => {
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
