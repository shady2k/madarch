import { afterAll, beforeEach, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register({ url: 'http://localhost/products/example/p/problems' });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { App } = await import('./app.js');
await import('./i18n.js');

afterAll(() => { GlobalRegistrator.unregister(); });

const finding = { file: 'templates/record.yaml', line: 8, path: 'sections[0].query', message: 'Cannot query field "unknown" on type "Entity".' };
const requests: { url: string; query: string }[] = [];
let answer: unknown;
let failNetwork = false;
beforeEach(() => {
  requests.length = 0;
  answer = { data: { templateFindings: [finding] } };
  failNetwork = false;
  window.history.pushState({}, '', '/products/example/p/problems');
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    const path = String(url);
    // The frame's command reads answer on their own routes; only the graph is the walk's subject here.
    if (!path.endsWith('/graphql')) {
      const command = path.includes('/api/problems')
        ? { open: 0, closed: 0, dismissed: 0, sections: {} }
        : path.includes('/api/settings') ? { role: 'everything', asked: true, roles: [] } : { fill: { state: 'idle' } };
      return new Response(JSON.stringify(command), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const { query } = JSON.parse(init?.body ?? '{}') as { query: string };
    requests.push({ url, query });
    if (query.includes('bootstrap')) return new Response(JSON.stringify({ data: {
      bootstrap: { structureRevision: 'r1', home: null, catalogueTemplate: null, recordTemplates: [], ownTemplates: [], templates: [], roles: [] },
      navigation: { product: 'Example', groups: [], kinds: [], purposes: [] },
    } }));
    if (failNetwork) throw new Error('Network unavailable');
    return new Response(JSON.stringify(answer));
  }) as typeof fetch;
});

async function render(): Promise<{ container: HTMLElement; close: () => Promise<void> }> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(App)); });
  for (let at = 0; at < 8; at += 1) await act(async () => { await Promise.resolve(); });
  return { container, close: async () => { await act(async () => { root.unmount(); }); container.remove(); } };
}

test('Problems shows actionable template findings through the product GraphQL endpoint', async () => {
  const page = await render();
  try {
    const main = page.container.querySelector('main');
    expect(main?.textContent).toContain('Template findings');
    expect(main?.textContent).toContain(finding.message);
    expect(main?.textContent).toContain(`${finding.file}:${finding.line}`);
    expect(main?.textContent).toContain(finding.path);
    expect(page.container.querySelector('[data-testid="frame-rebuilding"]')).toBeNull();
    const graphql = requests.filter(({ url }) => url === '/products/example/graphql');
    expect(graphql).toHaveLength(2);
    expect(graphql[1]?.query).toContain('templateFindings { file line path message }');
  } finally { await page.close(); }
});

test('an empty template finding list does not claim all Problems are clear', async () => {
  answer = { data: { templateFindings: [] } };
  const page = await render();
  try {
    expect(page.container.querySelector('main')?.textContent).toContain('No template findings.');
    expect(page.container.querySelector('[role="alert"]')).toBeNull();
  } finally { await page.close(); }
});

for (const mode of ['graphql', 'network', 'missing'] as const) {
  test(`Problems reports ${mode} failure instead of a clean empty state`, async () => {
    if (mode === 'graphql') answer = { errors: [{ message: 'Template check failed' }] };
    if (mode === 'network') failNetwork = true;
    if (mode === 'missing') answer = { data: {} };
    const page = await render();
    try {
      if (mode === 'network') {
        // A server that cannot be reached is the frame's one calm line, never the request's own words.
        expect(page.container.querySelector('[data-testid="wiki-offline"]')?.textContent).toContain('No connection to the madarch server. Trying again…');
        expect(page.container.textContent).not.toContain('Network unavailable');
      } else {
        expect(page.container.querySelector('[role="alert"]')?.textContent).toContain(
          mode === 'graphql' ? 'Template check failed' : 'the graph answered no template findings',
        );
      }
      expect(page.container.querySelector('main')?.textContent).not.toContain('No template findings.');
    } finally { await page.close(); }
  });
}
