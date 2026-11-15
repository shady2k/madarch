/**
 * The page components (decision 0036, section 7): each draws only the data its section was handed and the parameters the
 * template states. The responses here are mocked; the schema is checked by `compose.test.ts`.
 */
import { afterAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register({ url: 'http://localhost/' });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { PageView } = await import('./page.js');
const { linkOfNode } = await import('./components/diagram-links.js');
const { i18n } = await import('./i18n.js');
await i18n.changeLanguage('en');

afterAll(() => { GlobalRegistrator.unregister(); });

type Section = Parameters<typeof PageView>[0]['composition']['sections'][number];

function section(id: string, component: string, params: Record<string, unknown>, extra: Partial<Section> = {}): Section {
  return { id, component, on: 'subject', replace: false, params, line: 1, alias: `s_${id}`, ...extra } as Section;
}

function compositionOf(sections: Section[]): Parameters<typeof PageView>[0]['composition'] {
  return { template: 'probe', operation: '', variables: {}, sections, findings: [] };
}

async function renderPage(sections: Section[], data: Record<string, unknown>, runtime: Partial<Parameters<typeof PageView>[0]['runtime']> = {}): Promise<{ container: HTMLElement; reloads: Record<string, unknown>[]; close: () => Promise<void> }> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const reloads: Record<string, unknown>[] = [];
  await act(async () => {
    root.render(createElement(PageView, {
      composition: compositionOf(sections),
      data,
      runtime: { base: '', language: 'en', busy: false, variables: {}, product: 'Madarch', navigation: null, pageName: null, open: () => undefined, reload: (variables: Record<string, unknown>) => { reloads.push(variables); }, ...runtime },
    }));
  });
  return { container, reloads, close: async () => { await act(async () => { root.unmount(); }); container.remove(); } };
}

const entity = (id: string, label: string): Record<string, unknown> => ({ id, kind: 'a.b', label, template: 'entity' });

test('the header shows the title the section read and the kind as a badge', async () => {
  const page = await renderPage([section('header', 'header', { titlePath: 'label', kindPath: 'kind' })], { header: { label: 'Write', kind: 'a.b' } });
  try {
    expect(page.container.querySelector('h1')?.textContent).toBe('Write');
    expect(page.container.textContent).toContain('a.b');
  } finally {
    await page.close();
  }
});

const ID = '00000000-0000-0000-0000-00000000dead';
const navigation = {
  product: 'Madarch',
  groups: [],
  kinds: [{ kind: 'a.b', one: 'A', many: 'As', definition: null, taken: true, group: null, nav: null, count: 2, entryId: ID }],
  purposes: [],
};

test('the header trails the kind, linked to its page, then the path and the title', async () => {
  const page = await renderPage(
    [section('header', 'header', { titlePath: 'label', kindPath: 'kind', trail: { repository: 'repository', path: 'path' } })],
    { header: { label: 'src/x.ts', kind: 'a.b', repository: 'madarch', path: 'src/x.ts' } },
    { navigation },
  );
  try {
    const kind = page.container.querySelector('[data-testid="trail"] a');
    expect(kind?.textContent).toBe('As');
    expect(kind?.getAttribute('href')).toBe(`/e/catalogue/${ID}`);
    const trail = page.container.querySelector('[data-testid="trail"]')?.textContent ?? '';
    expect(trail).toContain('madarch');
    expect(trail.endsWith('src')).toBe(true);
    expect(page.container.querySelector('h1')?.textContent).toBe('x.ts');
  } finally {
    await page.close();
  }
});

test('a code page titles the file and trails the folders that hold it', async () => {
  const page = await renderPage(
    [section('header', 'header', { titlePath: 'label', kindPath: 'kind', trail: { repository: 'repository', path: 'path' } })],
    { header: { label: 'src/graph/write.ts', kind: 'a.b', repository: 'madarch', path: 'src/graph/write.ts' } },
    { navigation },
  );
  try {
    expect(page.container.querySelector('h1')?.textContent).toBe('write.ts');
    // The path is not printed twice: the trail names the folders, the title the file (madarch-64o5.83).
    expect(page.container.querySelector('[data-testid="page-path"]')).toBeNull();
    const trail = page.container.querySelector('[data-testid="trail"]')?.textContent ?? '';
    expect(trail.startsWith('As')).toBe(true);
    expect(trail).toContain('madarch / src');
    expect(trail.endsWith('graph')).toBe(true);
    expect(trail).not.toContain('write.ts');
  } finally {
    await page.close();
  }
});

test('a catalogue kind page trails the catalogue and the kind', async () => {
  const page = await renderPage(
    [section('header', 'header', { titlePath: 'label', kindPath: 'kind' })],
    { header: { label: 'Files', kind: 'catalogue' } },
  );
  try {
    const trail = page.container.querySelector('[data-testid="trail"]');
    expect(trail?.querySelector('a')?.getAttribute('href')).toBe('/p/catalogue');
    expect(trail?.textContent).toBe('Entity catalogue/Files');
  } finally {
    await page.close();
  }
});

test('a header the graph answered nothing for falls back to the section title', async () => {
  const page = await renderPage([section('header', 'header', { titlePath: 'label' }, { title: { en: 'Product' } })], { header: null });
  try {
    expect(page.container.querySelector('h1')?.textContent).toBe('Product');
  } finally {
    await page.close();
  }
});

test('facts show each row at its path, and a number is written for the reader', async () => {
  const page = await renderPage(
    [section('facts', 'facts', { rows: [
      { label: { en: 'Files' }, path: 'count', format: 'number' },
      { label: { en: 'Size' }, path: 'bytes', format: 'bytes' },
      { label: { en: 'Contested' }, path: 'contested' },
    ] })],
    { facts: { count: 3723, bytes: 2048, contested: ['url'] } },
  );
  try {
    const text = page.container.textContent ?? '';
    expect(text).toContain('Files');
    expect(text).toContain('3,723');
    expect(text).toContain('2.0 kB');
    expect(text).toContain('url');
  } finally {
    await page.close();
  }
});

test('a relation row names the relation and links to the entity at its other end', async () => {
  const page = await renderPage(
    [section('backlinks', 'relations', { path: 'backlinks', labelPath: 'relation', emptyText: { en: 'Nothing links to it yet.' } })],
    { backlinks: { backlinks: { totalCount: 1, edges: [{ node: { relation: 'sample.belongs', label: 'belongs to the sample', from: entity('1', 'src') } }] } } },
  );
  try {
    // The graph supplies product vocabulary; the client does not translate relation identifiers.
    expect(page.container.textContent).toContain('belongs to the sample');
    expect(page.container.querySelector('a')?.getAttribute('href')).toBe('/e/a.b/1');
  } finally {
    await page.close();
  }
});

test('an empty relation section is not drawn at all, and its empty sentence is gone (madarch-64o5.83)', async () => {
  // A relation with no rows is no relation: the page shows no box and no heading over nothing (the owner's fix (a) 5).
  const page = await renderPage([section('backlinks', 'relations', { path: 'backlinks', emptyText: { en: 'Nothing links to it yet.' } })], { backlinks: null });
  try {
    expect(page.container.textContent).not.toContain('Nothing links to it yet.');
    expect(page.container.querySelector('[data-section="backlinks"]')).toBeNull();
  } finally {
    await page.close();
  }
});

test('a table draws its columns, links a row that is an entity, and asks for the next page', async () => {
  const page = await renderPage(
    [section('records', 'table', { path: 'instances', pageSize: 2, columns: [{ label: { en: 'Label' }, path: 'node.label' }, { label: { en: 'Kind' }, path: 'node.kind' }] }, { query: 'instances(first: $records_first, after: $records_after)' })],
    { records: { instances: { totalCount: 3, pageInfo: { hasNextPage: true, endCursor: 'c2' }, edges: [{ node: entity('1', 'a') }, { node: entity('2', 'b') }] } } },
  );
  try {
    expect(page.container.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(page.container.querySelector('tbody a')?.getAttribute('href')).toBe('/e/a.b/1');
    const next = [...page.container.querySelectorAll('button')].find((one) => one.textContent === '→');
    await act(async () => { next?.click(); });
    expect(page.reloads).toEqual([{ records_after: 'c2' }]);
  } finally {
    await page.close();
  }
});

test('an empty table says so in one line and offers no pager', async () => {
  const page = await renderPage(
    [section('records', 'table', { path: 'instances', columns: [{ label: { en: 'Label' }, path: 'node.label' }] }, { query: 'instances(first: $records_first, after: $records_after)' })],
    { records: { instances: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, edges: [] } } },
  );
  try {
    expect(page.container.querySelector('[data-testid="table-empty"]')?.textContent).toBe('No records yet');
    expect(page.container.textContent).not.toContain('0–0');
    expect([...page.container.querySelectorAll('button')]).toHaveLength(0);
  } finally {
    await page.close();
  }
});

test('a table whose records fit one page offers no pager line', async () => {
  const page = await renderPage(
    [section('records', 'table', { path: 'instances', pageSize: 50, columns: [{ label: { en: 'Label' }, path: 'node.label' }] }, { query: 'instances(first: $records_first, after: $records_after)' })],
    { records: { instances: { totalCount: 2, pageInfo: { hasNextPage: false, endCursor: null }, edges: [{ node: entity('1', 'a') }, { node: entity('2', 'b') }] } } },
  );
  try {
    expect(page.container.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(page.container.textContent).not.toContain('1–2 / 2');
    expect([...page.container.querySelectorAll('button')].some((one) => one.textContent === '→')).toBe(false);
  } finally {
    await page.close();
  }
});

test('a table with a next page draws its pager even when the page holds fewer rows than the default size', async () => {
  const rows = Array.from({ length: 20 }, (_, at) => ({ node: entity(String(at), `row ${String(at)}`) }));
  const page = await renderPage(
    [section('records', 'table', { path: 'instances', columns: [{ label: { en: 'Label' }, path: 'node.label' }] }, { query: 'instances(first: 20, after: $records_after)' })],
    { records: { instances: { totalCount: 30, pageInfo: { hasNextPage: true, endCursor: 'c20' }, edges: rows } } },
  );
  try {
    expect(page.container.textContent).toContain('1–20 / 30');
    const next = [...page.container.querySelectorAll('button')].find((one) => one.textContent === '→');
    expect(next).not.toBeUndefined();
    expect(next?.disabled).toBe(false);
  } finally {
    await page.close();
  }
});

test('a table offers a sort only when its query declares the order variable', async () => {
  const without = await renderPage([section('rows', 'table', { path: 'rows', columns: [{ label: { en: 'A' }, path: 'node.label', sortField: 'label' }] })], { rows: { totalCount: 0, edges: [] } });
  try {
    expect(without.container.querySelector('select')).toBeNull();
  } finally {
    await without.close();
  }
  const withOrder = await renderPage([section('rows', 'table', { path: 'rows', columns: [{ label: { en: 'A' }, path: 'node.label', sortField: 'label' }] }, { query: 'allX(orderBy: $rows_orderBy, after: $rows_after)' })], { rows: { totalCount: 0, edges: [] } });
  try {
    const select = withOrder.container.querySelector('select');
    expect(select).not.toBeNull();
    await act(async () => {
      if (select !== null) {
        select.value = 'label';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    expect(withOrder.reloads).toEqual([{ rows_orderBy: [{ field: 'label', direction: 'ASC' }] }]);
  } finally {
    await withOrder.close();
  }
});

test('an empty text section says the description is not written yet', async () => {
  const page = await renderPage([section('body', 'text', { path: 'body' })], { body: { body: '' } });
  try {
    expect(page.container.querySelector('[data-testid="text-empty"]')?.textContent).toBe('The description is not written yet.');
  } finally {
    await page.close();
  }
});

test('the text section draws the graph\'s Markdown and drops raw HTML', async () => {
  const page = await renderPage([section('body', 'text', { path: 'body' })], { body: { body: '# Title\n\nA *word*.\n\n<script>alert(1)</script>\n' } });
  try {
    expect(page.container.querySelector('h1')?.textContent).toBe('Title');
    expect(page.container.querySelector('em')?.textContent).toBe('word');
    expect(page.container.querySelector('script')).toBeNull();
  } finally {
    await page.close();
  }
});

test('a tabs section draws the chosen section and hides the rest', async () => {
  const page = await renderPage([
    section('around', 'tabs', { sections: ['one', 'two'] }, { title: { en: 'Around' } }),
    section('one', 'facts', { rows: [{ label: { en: 'One' }, path: 'a' }] }, { title: { en: 'First' } }),
    section('two', 'facts', { rows: [{ label: { en: 'Two' }, path: 'b' }] }, { title: { en: 'Second' } }),
  ], { around: null, one: { a: 1 }, two: { b: 2 } });
  try {
    expect(page.container.querySelector('[role="tabpanel"]')?.textContent).toContain('One');
    expect(page.container.querySelector('[role="tabpanel"]')?.textContent).not.toContain('Two');
    const second = [...page.container.querySelectorAll('[role="tab"]')].find((one) => one.textContent === 'Second');
    await act(async () => { second?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); });
    expect(page.container.querySelector('[role="tabpanel"]')?.textContent).toContain('Two');
  } finally {
    await page.close();
  }
});

test('the diagram shows the server\'s three pictures as tabs, and asks for one format at a time', async () => {
  const requested: string[] = [];
  const real = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    const body = url.includes('format=likec4')
      ? { format: 'likec4', entity: { id: 'uid', kind: 'a.b', label: 'Write' }, depth: 1, folded: 0, truncated: false, workspace: 'specification {}\n', view: {}, links: { n0: '/e/a.b/uid' } }
      : { format: 'mermaid', entity: { id: 'uid', kind: 'a.b', label: 'Write' }, depth: 1, folded: 0, truncated: false, source: 'flowchart LR\n  n0["Write"]\n' };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  try { window.localStorage.removeItem('madarch-wiki-diagram'); } catch { /* no storage */ }
  const page = await renderPage([section('diagram', 'diagram', { depth: 1, aggregateAbove: 12 })], { diagram: { id: 'uid' } });
  try {
    // One picture with a renderer choice, not three tabs beside each other (madarch-64o5.83).
    const renderers = [...page.container.querySelectorAll('[data-testid^="diagram-renderer-"]')].map((one) => one.textContent);
    expect(renderers).toEqual(['LikeC4', 'Mermaid', 'archify']);
    // The first renderer is the picture drawn by itself: LikeC4's view is asked for at once.
    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain('/render/diagram?entity=uid');
    expect(requested[0]).toContain('format=likec4');
    const mermaid = page.container.querySelector('[data-testid="diagram-renderer-mermaid"]');
    await act(async () => { mermaid?.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 })); await Promise.resolve(); });
    expect(requested.some((one) => one.includes('format=mermaid'))).toBe(true);
    const archify = page.container.querySelector('[data-testid="diagram-renderer-archify"]');
    await act(async () => { archify?.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 })); await Promise.resolve(); });
    const frame = page.container.querySelector('iframe');
    expect(frame?.getAttribute('src')).toContain('format=archify');
  } finally {
    (globalThis as { fetch: typeof fetch }).fetch = real;
    await page.close();
  }
});

test('the diagram opens at full screen in the kit\'s dialog, and leaves it', async () => {
  const real = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = (async () => new Response(JSON.stringify({ format: 'likec4', entity: { id: 'uid', kind: 'a.b', label: 'Write' }, depth: 1, folded: 0, truncated: false, workspace: 'specification {}\n', view: {}, links: { n0: '/e/a.b/uid' } }), { status: 200 })) as unknown as typeof fetch;
  try { window.localStorage.removeItem('madarch-wiki-diagram'); } catch { /* no storage */ }
  const page = await renderPage([section('diagram', 'diagram', { depth: 1 })], { diagram: { id: 'uid' } });
  try {
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelector('[data-testid="diagram-fullscreen"]')).toBeNull();
    await act(async () => { (page.container.querySelector('[data-testid="diagram-fullscreen-open"]') as HTMLButtonElement).click(); });
    const dialog = document.querySelector('[data-testid="diagram-fullscreen"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('Full screen');
    const close = dialog?.querySelector('button[aria-label="Close full screen"]') as HTMLButtonElement | null;
    expect(close).not.toBeNull();
    await act(async () => { close?.click(); });
    expect(document.querySelector('[data-testid="diagram-fullscreen"]')).toBeNull();
  } finally {
    (globalThis as { fetch: typeof fetch }).fetch = real;
    await page.close();
  }
});

test('a failed picture speaks the reader\'s language, never the server\'s', async () => {
  const real = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = (async () => new Response(JSON.stringify({ code: 'FAILED', message: 'the picture did not draw within 2 s' }), { status: 500 })) as unknown as typeof fetch;
  try { window.localStorage.removeItem('madarch-wiki-diagram'); } catch { /* no storage */ }
  const page = await renderPage([section('diagram', 'diagram', { depth: 1 })], { diagram: { id: 'uid' } });
  try {
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const words = page.container.textContent ?? '';
    expect(words).toContain('The diagram could not be built.');
    expect(words).not.toContain('did not draw');
  } finally {
    (globalThis as { fetch: typeof fetch }).fetch = real;
    await page.close();
  }
});

test('a pressed node opens the page the server named for it', () => {
  expect(linkOfNode({ n1: '/e/a.b/1' }, { id: 'n1' })).toBe('/e/a.b/1');
  expect(linkOfNode({ n1: '/e/a.b/1' }, { id: 'other', modelRef: 'n1' })).toBe('/e/a.b/1');
  expect(linkOfNode({}, { id: 'n9' })).toBeUndefined();
});
