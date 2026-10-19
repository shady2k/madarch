/**
 * The diagrams of a graph page in the app (madarch-tzte.23.4; decision 0026,
 * "Diagrams"), tested without a server: every request is answered by a stub giving
 * the server's own shapes (`src/product-wiki/graph-diagrams.ts`), the DOM is
 * happy-dom, and Mermaid's own module is stubbed the way `architecture.test.tsx`
 * stubs the LikeC4 element, so no renderer is loaded from the network.
 *
 * The bar is the task's: each diagram renders under a switcher over every renderer
 * that supports its type, the first tab is the server's own (the setting
 * `MADARCH_WIKI_DIAGRAM` names), an element opens its page and its place in code
 * under every tab, and a diagram the graph answers with nothing says so rather than
 * drawing an empty frame.
 */
import { afterEach, afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DiagramTabs, GraphDiagramsSection } from './graph-diagrams.js';
import { setWikiLanguage } from './i18n.js';
import { addressOfGraphPage } from './routes.js';
import type { GraphDiagram, GraphDiagramTab, GraphDiagramsAnswer, GraphPageEntry, RepoEntry, ReposList } from './api.js';

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  await setWikiLanguage('en');
});

afterAll(async () => {
  await new Promise((rest) => setTimeout(rest, 50));
  GlobalRegistrator.unregister();
});

let rendered: { root: Root } | undefined;

function into(element: ReturnType<typeof createElement>): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(element);
  rendered = { root };
}

async function until(holds: () => boolean | undefined, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (holds()) return;
    await new Promise((step) => setTimeout(step, 10));
  }
  throw new Error('the app never came to ' + what + '; the tree holds: ' + document.body.innerHTML);
}

afterEach(() => {
  rendered?.root.unmount();
  rendered = undefined;
  delete (globalThis as { fetch?: unknown }).fetch;
});

const MODULE = `module:${'a'.repeat(64)}`;
const SYMBOL = `symbol:${'b'.repeat(64)}`;
const COMMIT = 'a'.repeat(40);

const node: GraphPageEntry = {
  id: MODULE,
  kind: 'module',
  label: 'checkout',
  page: addressOfGraphPage(MODULE),
  layer: 'extracted',
  status: 'proposed',
  code: { repository: 'acme-shop', commit: COMMIT, file: 'src/checkout.ts', startLine: 1, endLine: 40 },
};

const repos: ReposList = { repos: [{ name: 'acme-shop', url: 'https://github.com/acme/shop.git', path: 'repos/acme-shop', state: 'cloned' } satisfies RepoEntry] };

/** The Mermaid tab of a diagram, as the server makes it. */
function mermaidTab(source: string): GraphDiagramTab {
  return { renderer: 'mermaid', source };
}

/** One diagram, as the server answers it: its tabs in their order, its elements and arrows. */
function diagram(overrides: Partial<GraphDiagram> = {}): GraphDiagram {
  return {
    type: 'module-dependency',
    level: 1,
    title: 'Module dependencies: acme-shop',
    collapsed: false,
    marker: null,
    empty: false,
    tabs: [
      mermaidTab('flowchart LR\n  n0("checkout")\n  n1("payment")\n  n0 -->|"import"| n1\n'),
      { renderer: 'archify', src: `/api/graph/archify?id=${encodeURIComponent(MODULE)}&type=module-dependency` },
    ],
    elements: [
      {
        id: MODULE,
        kind: 'module',
        label: 'checkout',
        evidence: 'fact',
        dashed: false,
        page: `/p/graph/${MODULE}`,
        place: { repository: 'acme-shop', commit: COMMIT, file: 'src/checkout.ts', line: 1, endLine: 40 },
      },
      {
        id: SYMBOL,
        kind: 'symbol',
        label: 'acme-shop:src/checkout.ts#checkout.place',
        evidence: 'assumption',
        dashed: true,
        page: `/p/graph/${SYMBOL}`,
      },
      { id: 'unresolved:state:1', kind: null, label: 'the state the graph does not hold', evidence: 'unresolved', dashed: true },
      {
        id: 'table:1',
        kind: 'table',
        label: 'acme-shop:public.orders',
        evidence: 'fact',
        dashed: false,
        page: '/p/graph/table:1',
        columns: [
          { label: 'id bigint', page: `/p/graph/${SYMBOL}`, place: { repository: 'acme-shop', commit: COMMIT, file: 'migrations/001.sql', line: 4, endLine: 4 } },
          { label: 'total numeric' },
        ],
      },
    ],
    edges: [{ from: MODULE, to: SYMBOL, label: 'import', evidence: 'assumption', dashed: true, kind: 'import' }],
    ...overrides,
  };
}

function answer(diagrams: readonly GraphDiagram[]): GraphDiagramsAnswer {
  return { product: 'Draft Idea', node, firstTab: 'mermaid', diagrams: [...diagrams], readAt: 1_700_000_000_000 };
}

/** Installs a stub answering one page's diagrams. */
function install(body: GraphDiagramsAnswer | { status: number; message: string }, calls: string[] = []): void {
  const stub = async (input: RequestInfo | URL): Promise<Response> => {
    const target = input instanceof URL ? input.pathname + input.search : String(input);
    calls.push(target);
    if ('status' in body) return new Response(JSON.stringify({ message: body.message }), { status: body.status, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  (globalThis as { fetch: typeof fetch }).fetch = stub as unknown as typeof fetch;
}

describe('a page’s diagrams', () => {
  test('each diagram is drawn under its tabs in the server’s order, the first tab open', async () => {
    install(answer([diagram()]));
    into(createElement(DiagramTabs, { diagram: diagram(), repos: repos.repos }));
    await until(() => document.querySelector('[data-testid="graph-diagram-tabs"]') !== null, 'the diagram’s tabs');
    const tabs = [...document.querySelectorAll('[data-testid="graph-diagram-tabs"] button')].map((button) => [button.getAttribute('data-tab'), button.getAttribute('aria-selected')]);
    expect(tabs).toEqual([['mermaid', 'true'], ['archify', 'false']]);
    // The open tab is Mermaid's, and its source is the server's: the app draws no diagram of its own.
    await until(() => document.querySelector('[data-testid="mermaid-diagram"]') !== null || document.querySelector('[data-testid="mermaid-error"]') !== null, 'the Mermaid panel');
    expect(document.querySelector('[data-panel="archify"]')).toBeNull();
    expect(document.querySelector('[data-testid="graph-diagram"]')?.getAttribute('data-diagram-type')).toBe('module-dependency');
    expect(document.body.textContent ?? '').toContain('Module dependencies: acme-shop');
  });

  test('a tab the reader opens draws its renderer, and the one it left stops', async () => {
    into(createElement(DiagramTabs, { diagram: diagram(), repos: repos.repos }));
    await until(() => document.querySelector('[data-testid="graph-diagram-tabs"]') !== null, 'the tabs');
    document.querySelector<HTMLButtonElement>('[data-testid="graph-diagram-tabs"] button[data-tab="archify"]')!.click();
    await until(() => document.querySelector('[data-testid="graph-diagram-archify"]') !== null, 'the archify frame');
    const frame = document.querySelector('[data-testid="graph-diagram-archify"]');
    expect(frame?.getAttribute('src')).toBe(`/api/graph/archify?id=${encodeURIComponent(MODULE)}&type=module-dependency`);
    expect(document.querySelector('[data-panel="mermaid"]')).toBeNull();
  });

  test('the LikeC4 tab frames the page the server draws it in', async () => {
    const c4 = diagram({
      type: 'c4-component',
      tabs: [
        { renderer: 'likec4', src: `/api/graph/likec4.html?id=${encodeURIComponent(MODULE)}&type=c4-component` },
        mermaidTab('flowchart LR\n'),
      ],
    });
    into(createElement(DiagramTabs, { diagram: c4, repos: repos.repos }));
    await until(() => document.querySelector('[data-testid="graph-diagram-likec4"]') !== null, 'the LikeC4 frame');
    expect(document.querySelector('[data-testid="graph-diagram-likec4"]')?.getAttribute('src')).toBe(`/api/graph/likec4.html?id=${encodeURIComponent(MODULE)}&type=c4-component`);
  });

  test('the elements open their pages and their places in code, and say how they stand, under any tab', async () => {
    into(createElement(DiagramTabs, { diagram: diagram(), repos: repos.repos }));
    await until(() => document.querySelector('[data-testid="graph-diagram-elements"]') !== null, 'the elements');
    const rows = [...document.querySelectorAll('[data-testid="graph-diagram-elements"] [data-element]')];
    expect(rows.map((row) => row.getAttribute('data-evidence'))).toEqual(['fact', 'assumption', 'unresolved', 'fact']);
    expect(rows.map((row) => row.getAttribute('data-dashed'))).toEqual(['false', 'true', 'true', 'false']);
    // The first element opens its page and its place at the repository's host; the last one opens nothing, and says why.
    const links = [...document.querySelectorAll('[data-testid="graph-diagram-elements"] a')].map((link) => link.getAttribute('href'));
    expect(links).toContain(`/p/graph/${MODULE}`);
    expect(links).toContain(`https://github.com/acme/shop/blob/${COMMIT}/src/checkout.ts#L1-L40`);
    expect(document.querySelector('[data-testid="graph-diagram-unpaged"]')?.getAttribute('title')).toBe('unresolved:state:1 is an end the graph does not hold, so it opens no page.');
    // A table's columns stand beside it, each opening its own page and place where it has them.
    const columns = [...document.querySelectorAll('[data-testid="graph-diagram-columns"] [data-column]')];
    expect(columns.map((column) => column.getAttribute('data-column'))).toEqual(['id bigint', 'total numeric']);
    expect(columns[0]!.querySelector('a')?.getAttribute('href')).toBe(`/p/graph/${SYMBOL}`);
    expect(columns[0]!.querySelector('[data-testid="graph-diagram-place"]')?.getAttribute('href')).toBe(`https://github.com/acme/shop/blob/${COMMIT}/migrations/001.sql#L4`);
    expect(columns[1]!.querySelector('a')).toBeNull();
    // The arrows name both ends and how they stand.
    expect(document.querySelector('[data-testid="graph-diagram-edges"]')?.textContent).toContain('checkout → acme-shop:src/checkout.ts#checkout.place');
    expect(document.querySelector('[data-testid="graph-diagram-edge-evidence"]')?.textContent).toBe('assumption');
  });

  test('a diagram the graph answers with nothing says so, and draws no frame', async () => {
    into(createElement(DiagramTabs, { diagram: diagram({ empty: true, elements: [], edges: [], tabs: [mermaidTab('flowchart LR\n')] }), repos: repos.repos }));
    await until(() => document.querySelector('[data-testid="graph-diagram-empty"]') !== null, 'the empty diagram’s words');
    expect(document.querySelector('[data-testid="graph-diagram-tabs"]')).toBeNull();
    expect(document.querySelector('[data-testid="mermaid-diagram"]')).toBeNull();
  });
});

describe('the page’s diagrams section', () => {
  test('reads its diagrams once and shows one switcher per diagram', async () => {
    const calls: string[] = [];
    install(answer([diagram(), diagram({ type: 'er', level: 1, title: 'Data model: acme-shop', tabs: [mermaidTab('flowchart LR\n')] })]), calls);
    into(createElement(GraphDiagramsSection, { node, readAt: 1_700_000_000_000, repos: repos.repos }));
    await until(() => document.querySelectorAll('[data-testid="graph-diagram"]').length === 2, 'both diagrams');
    expect(calls).toEqual([`/api/graph/diagrams?id=${encodeURIComponent(MODULE)}`]);
    expect([...document.querySelectorAll('[data-testid="graph-diagram"]')].map((article) => article.getAttribute('data-diagram-type'))).toEqual(['module-dependency', 'er']);
  });

  test('a page the server draws no diagram for shows the slot’s own words, never an empty frame', async () => {
    install(answer([]));
    into(createElement(GraphDiagramsSection, { node, readAt: 1_700_000_000_000, repos: repos.repos }));
    await until(() => document.querySelector('[data-testid="graph-diagram-none"]') !== null, 'the section’s own words');
    expect(document.querySelector('[data-testid="graph-diagram"]')).toBeNull();
  });

  test('a read that failed is the server’s message, in the page and not in silence', async () => {
    install({ status: 500, message: 'the store is busy' });
    into(createElement(GraphDiagramsSection, { node, readAt: 1_700_000_000_000, repos: repos.repos }));
    await until(() => document.querySelector('[data-testid="graph-diagrams-error"]') !== null, 'the failure’s words');
    expect(document.querySelector('[data-testid="graph-diagrams-error"]')?.textContent).toContain('the store is busy');
  });
});
