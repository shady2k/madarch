/**
 * The diagram blocks as the app draws them (madarch-m38l.9), over the server's shapes: nodes are links, a click goes
 * through the `onOpen` hook, a plus opens a node's neighbours through the neighbourhood route, the drawn views (C4,
 * sequence, ER, state, deployment; madarch-m38l.15) switch renderer and drill down, the treemap gives area to lines and
 * warmth to churn.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { IFetchInterceptor } from 'happy-dom';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setWikiLanguage } from '../../i18n.js';
import { BlockView } from '../blocks.js';
import { DiagramOpenProvider } from './open.js';
import { frontTab } from '../tabs.js';
import { resetTabs } from '../../../test/reset.js';
import type { Block, DiagramView, FilesMap, Neighborhood } from '../types.js';
import { bindMermaid, mermaidPicture } from './views.js';
import { viewFrameAddress } from '../api.js';
import { folderLevel } from '../../../../../src/knowledge/files-treemap.js';
import { contrastOf, fillOf, inkFor, labelFits, mapOption, rampColourAt } from './files-echart.js';
import { crumbSegments } from './treemap.js';
import { RAMPS } from '../files-measure.js';

/**
 * The page inside an archify frame is a navigation of the browser itself, not a call of the app's `fetch`: the React
 * stub never sees it, and the run went to localhost:80 and left an ECONNREFUSED and a teardown abort behind
 * (madarch-u3vw.4). The supported seam of the pinned HappyDOM 20.14.6 is `settings.fetch.interceptor`
 * (IOptionalBrowserSettings.ts:66-84, IFetchInterceptor.ts:7-18, Fetch.ts:149-158): `disableIframePageLoading` is not
 * usable, as it returns at HTMLIFrameElement.ts:414-421 before the browsing context exists (:428) and the
 * contentWindow is assigned (:444-446), which would leave the frame's `contentWindow` null. The one navigation these
 * tests mean is answered here with an inert same-origin document, made with the frame window's own Response class;
 * every other browser request names its full method and URL and fails.
 */
const FRAME_ORIGIN = 'http://localhost';
const FRAME_PATH = '/api/view-frame';
const FRAME_DOCUMENT = '<!doctype html><html><head><meta charset="utf-8"><title>archify</title></head><body data-frame-document="archify"></body></html>';
type BrowserRequest = { method: string; url: string };
const frameNavigations: BrowserRequest[] = [];
const otherBrowserRequests: BrowserRequest[] = [];

function refuseBrowserRequest(method: string, url: string): never {
  otherBrowserRequests.push({ method, url });
  throw new Error(`the browser made a request no diagram test isolated: ${method} ${url}`);
}

const frameInterceptor: IFetchInterceptor = {
  beforeAsyncRequest: async ({ request, window }) => {
    const url = new URL(request.url);
    const meant = request.method === 'GET' && url.origin === FRAME_ORIGIN && url.pathname === FRAME_PATH && url.searchParams.get('renderer') === 'archify';
    if (!meant) refuseBrowserRequest(request.method, request.url);
    frameNavigations.push({ method: request.method, url: request.url });
    return new window.Response(FRAME_DOCUMENT, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  },
  beforeSyncRequest: ({ request }) => refuseBrowserRequest(request.method, request.url),
};

beforeAll(async () => {
  GlobalRegistrator.register({ url: `${FRAME_ORIGIN}/`, settings: { fetch: { interceptor: frameInterceptor } } });
  await setWikiLanguage('en');
});
afterAll(async () => {
  await new Promise((rest) => setTimeout(rest, 50));
  GlobalRegistrator.unregister();
});

let rendered: Root | undefined;
function into(element: ReturnType<typeof createElement>): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  rendered = createRoot(container);
  rendered.render(element);
  return container;
}
async function until(holds: () => boolean | undefined, what: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (holds()) return;
    await new Promise((step) => setTimeout(step, 10));
  }
  throw new Error(`never came to ${what}; the tree holds: ${document.body.innerHTML.slice(0, 1500)}`);
}
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = '';
  delete (globalThis as { fetch?: unknown }).fetch;
  frameNavigations.length = 0;
  const surprises = otherBrowserRequests.splice(0);
  if (surprises.length > 0) {
    throw new Error(`browser requests outside the isolated iframe navigation: ${surprises.map(({ method, url }) => `${method} ${url}`).join(', ')}`);
  }
});

const node = (id: string, label: string, hops: number, href: string | null = `/e/${encodeURIComponent(id)}`) => ({ id, kind: 'code.symbol', label, href, hops });
const HOOD: Neighborhood = {
  center: 'pay',
  nodes: [node('pay', 'PaymentService.pay', 0), node('routes', 'paymentRoutes', 1), node('repo', 'PrismaPaymentRepository.create', 1), node('table', 'payments', 1, null)],
  edges: [
    { from: 'routes', to: 'pay', relation: 'code.calls', count: 1 },
    { from: 'pay', to: 'repo', relation: 'code.calls', count: 1 },
    { from: 'repo', to: 'table', relation: 'code.writes-table', count: 1 },
  ],
  more: [{ node: 'pay', relation: 'code.calls', direction: 'out', hidden: 4 }],
  relations: [{ relation: 'code.calls', direction: 'in', count: 1 }, { relation: 'code.calls', direction: 'out', count: 5 }],
};
const graphBlock = (hood: Neighborhood = HOOD, depth = 1): Block => ({ type: 'graph', title: 'Around this function', neighborhood: hood, depth, shown: hood.nodes.length - 1, total: 9 });

describe('the neighbourhood', () => {
  test('the entity is in the middle, callers on its left and callees on its right, each box a link to its page and a box with no page a plain one', async () => {
    const container = into(createElement(BlockView, { block: graphBlock(), resolutions: {} }));
    await until(() => container.querySelector('[data-testid=hood-node]') !== null, 'the nodes');
    const boxes = [...container.querySelectorAll('[data-testid=hood-node]')];
    const x = (id: string): number => Number(/translate\(([-\d.]+)/.exec(boxes.find((box) => box.getAttribute('data-node') === id)!.getAttribute('transform')!)![1]);
    expect(x('routes')).toBeLessThan(x('pay'));
    expect(x('repo')).toBeGreaterThan(x('pay'));
    // Depth 1: the table is a neighbour of a neighbour, and is not drawn.
    expect(boxes.map((box) => box.getAttribute('data-node')).sort()).toEqual(['pay', 'repo', 'routes']);
    expect(boxes.find((box) => box.getAttribute('data-node') === 'routes')!.querySelector('a')!.getAttribute('href')).toBe('/e/routes');
    expect([...container.querySelectorAll('[data-testid^=depth-]')].map((chip) => chip.getAttribute('aria-label'))).toEqual(['1 hop from this page', '2 hops from this page']);
    expect(container.querySelector('[data-testid=more-chip]')!.textContent).toBe('+4 more calls');
    expect(container.querySelector('figcaption')!.textContent).toBe('Showing 3 of 9.');
  });

  test('depth two draws the neighbours of the neighbours, and a node with no page is drawn plain, with no link', async () => {
    const container = into(createElement(BlockView, { block: graphBlock(HOOD, 2), resolutions: {} }));
    await until(() => container.querySelector('[data-testid=hood-node]') !== null, 'the nodes');
    const table = [...container.querySelectorAll('[data-testid=hood-node]')].find((box) => box.getAttribute('data-node') === 'table')!;
    expect(table.querySelector('a')).toBeNull();
    expect(table.querySelector('title')!.textContent).toContain('this kind has no page');
  });

  test('a click goes through onOpen with the node\'s address, and a click with shift is left to the browser', async () => {
    const opened: string[] = [];
    const container = into(createElement(DiagramOpenProvider, { onOpen: (href: string) => { opened.push(href); }, children: createElement(BlockView, { block: graphBlock(), resolutions: {} }) }));
    await until(() => container.querySelector('[data-testid=hood-node] a') !== null, 'the links');
    const link = [...container.querySelectorAll('[data-testid=hood-node] a')].find((a) => a.getAttribute('href') === '/e/routes')! as unknown as HTMLElement;
    link.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    link.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, shiftKey: true }));
    expect(opened).toEqual(['/e/routes']);
  });

  test('with no host hook a click opens the node\'s page in a new tab of the wiki, and the same page again switches to its tab', async () => {
    resetTabs();
    const container = into(createElement(BlockView, { block: graphBlock(), resolutions: {} }));
    await until(() => container.querySelector('[data-testid=hood-node] a') !== null, 'the links');
    const link = [...container.querySelectorAll('[data-testid=hood-node] a')].find((a) => a.getAttribute('href') === '/e/routes')! as unknown as HTMLElement;
    link.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    expect(frontTab().address).toBe('/e/routes');
    link.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    resetTabs();
  });

  test('the plus of a node opens its neighbours through the neighbourhood route and draws them', async () => {
    const calls: string[] = [];
    (globalThis as { fetch?: unknown }).fetch = async (url: string) => {
      calls.push(String(url));
      const answer: Neighborhood = { center: 'routes', nodes: [node('routes', 'paymentRoutes', 0), node('app', 'createApp', 0)], edges: [{ from: 'app', to: 'routes', relation: 'code.calls', count: 1 }], more: [], relations: [] };
      return new Response(JSON.stringify(answer), { status: 200 });
    };
    const container = into(createElement(BlockView, { block: graphBlock(HOOD, 2), resolutions: {} }));
    await until(() => container.querySelector('[data-testid=expand-node]') !== null, 'the plus');
    const plus = [...container.querySelectorAll('[data-testid=hood-node]')].find((box) => box.getAttribute('data-node') === 'routes')!.querySelector('[data-testid=expand-node]')! as unknown as HTMLElement;
    plus.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await until(() => [...container.querySelectorAll('[data-testid=hood-node]')].some((box) => box.getAttribute('data-node') === 'app'), 'the opened node');
    expect(calls).toEqual(['/api/neighborhood?id=routes&limit=8']);
  });

  test('a failed opening is said with the reason, and the picture stays', async () => {
    (globalThis as { fetch?: unknown }).fetch = async () => new Response(JSON.stringify({ message: 'no entity "routes"' }), { status: 404 });
    const container = into(createElement(BlockView, { block: graphBlock(HOOD, 2), resolutions: {} }));
    await until(() => container.querySelector('[data-testid=expand-node]') !== null, 'the plus');
    (container.querySelector('[data-testid=expand-node]') as unknown as HTMLElement).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await until(() => container.querySelector('[data-testid=diagram-failure]') !== null, 'the failure');
    expect(container.querySelector('[data-testid=diagram-failure]')!.textContent).toContain('no entity "routes"');
    expect(container.querySelectorAll('[data-testid=hood-node]').length).toBeGreaterThanOrEqual(3);
  });

  test('switching a relation off takes its boxes away and switching it on brings them back', async () => {
    const container = into(createElement(BlockView, { block: graphBlock(), resolutions: {} }));
    await until(() => container.querySelector('[data-testid="relation-code.calls|in"]') !== null, 'the switches');
    const count = (): number => container.querySelectorAll('[data-testid=hood-node]').length;
    expect(count()).toBe(3);
    const toggle = container.querySelector('[data-testid="relation-code.calls|in"]') as unknown as HTMLElement;
    toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await until(() => count() === 2, 'the callers gone');
    toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await until(() => count() === 3, 'the callers back');
  });

  test('an entity with no neighbours says so', async () => {
    const lonely: Neighborhood = { center: 'a', nodes: [node('a', 'a', 0)], edges: [], more: [], relations: [] };
    const container = into(createElement(BlockView, { block: graphBlock(lonely), resolutions: {} }));
    await until(() => container.querySelector('[data-testid=diagram-empty]') !== null, 'the empty note');
    expect(container.querySelector('[data-testid=diagram-empty]')!.textContent).toBe('no links in the graph');
  });
});

const CONTAINER: DiagramView = {
  spec: { type: 'c4-container', subject: '' },
  title: 'Containers',
  label: 'Containers',
  elements: [
    { id: 'code.service:payments', label: 'payments', kind: 'container', detail: 'TypeScript', href: '/e/code.service%3Apayments', dashed: false, drill: { spec: { type: 'c4-component', subject: 'code.service:payments' }, title: 'Components' } },
    { id: 'code.database:payments', label: 'payments', kind: 'database', href: '/e/code.database%3Apayments', dashed: false },
    { id: 'external:x', label: 'card network', kind: 'external', href: null, dashed: true },
  ],
  edges: [
    { from: 'code.service:payments', to: 'code.database:payments', label: 'SQL writes', dashed: false },
    { from: 'code.service:payments', to: 'external:x', label: 'HTTP', dashed: true, why: 'assumed' },
  ],
  notes: ['Showing 3 of 3.'],
  empty: null,
  marker: null,
  renderers: ['likec4', 'mermaid', 'archify'],
  mermaidSource: 'flowchart LR\n  n0["payments"]\n',
  query: 'type=c4-container&subject=',
};
const COMPONENTS: DiagramView = {
  spec: { type: 'c4-component', subject: 'code.service:payments' },
  title: 'Components: payments',
  label: 'Components',
  elements: [{ id: 'code.module:domain', label: 'src/domain', kind: 'component', detail: '4 files', href: '/e/m', dashed: false }],
  edges: [],
  notes: [],
  empty: null,
  up: { spec: { type: 'c4-container', subject: '' }, title: 'Containers' },
  marker: null,
  renderers: ['likec4', 'mermaid', 'archify'],
  mermaidSource: 'flowchart LR\n  n0["src/domain"]\n',
  query: 'type=c4-component&subject=code.service%3Apayments',
};
const SEQUENCE: DiagramView = {
  spec: { type: 'sequence', subject: 'domain:payment', entry: 'route' },
  title: 'Chain: POST /payments',
  label: 'POST /payments',
  elements: [{ id: 'lane:Caller', label: 'Caller', kind: 'person', href: null, dashed: true }, { id: 'lane:payments', label: 'payments', kind: 'participant', href: '/e/code.service%3Apayments', dashed: false }],
  edges: [
    { from: 'lane:Caller', to: 'lane:payments', label: 'POST /payments', dashed: false, step: 1, kind: 'route', href: '/e/route', note: 'middleware: authenticate' },
    { from: 'lane:payments', to: 'lane:payments', label: 'consumes payments.events', dashed: true, why: 'the graph holds no order for this step', step: 2, kind: 'consume', href: null },
  ],
  notes: [],
  empty: null,
  marker: null,
  renderers: ['mermaid'],
  mermaidSource: 'sequenceDiagram\n  participant n0 as Caller\n',
  query: 'type=sequence&subject=domain%3Apayment&entry=route',
};
const viewsBlock = (...views: DiagramView[]): Block => ({ type: 'diagrams', title: 'The system', renderer: 'likec4', views });

describe('the drawn views', () => {
  test('zoom fits the Mermaid drawing, never a toolbar SVG before it', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div class="dg-zoom-buttons"><button><svg id="toolbar-icon" viewBox="0 0 24 24"></svg></button></div><div data-testid="mermaid-diagram"><svg id="drawing" viewBox="0 0 800 500"></svg></div>';
    expect(mermaidPicture(root)?.id).toBe('drawing');
    expect(root.querySelector('#toolbar-icon')!.getAttribute('viewBox')).toBe('0 0 24 24');
  });
  test('the first tab is the setting, every renderer of the type is a tab, and the other tabs are one click away', async () => {
    const asked: string[] = [];
    // The model read never answers here: this test is about the tabs and the first one, and a refusal would hand the
    // view to another renderer while it is being asserted (that hand-over is the next test).
    (globalThis as { fetch?: unknown }).fetch = (url: string) => {
      asked.push(String(url));
      return new Promise<Response>(() => undefined);
    };
    const container = into(createElement(BlockView, { block: viewsBlock(CONTAINER), resolutions: {} }));
    await until(() => container.querySelector('[data-testid=view]') !== null, 'the view');
    expect([...container.querySelectorAll('[role=tab]')].map((tab) => tab.textContent)).toEqual(['LikeC4', 'Mermaid', 'archify']);
    expect(container.querySelector('[data-testid=view]')!.getAttribute('data-renderer')).toBe('likec4');
    // The LikeC4 tab draws inside the page and reads its laid-out model from the server's own frame answer; the
    // archify tab frames the page the server renders.
    await until(() => asked.some((url) => url.includes('/api/view-frame?type=c4-container&subject=&renderer=likec4&lang=en')), 'the LikeC4 model read');
    (container.querySelector('[data-testid=renderer-archify]') as HTMLElement).click();
    await until(() => container.querySelector('iframe')?.getAttribute('src')?.includes('renderer=archify') === true, 'the archify frame');
    const source = `${viewFrameAddress(CONTAINER.query, 'archify', 'en')}&fullscreen=0`;
    expect(container.querySelector('iframe')!.getAttribute('src')).toBe(source);
    await until(() => frameNavigations.length === 1, 'the isolated archify navigation');
    expect(frameNavigations).toEqual([{ method: 'GET', url: new URL(source, location.origin).href }]);
    expect(container.querySelector('[data-testid=view]')!.getAttribute('data-renderer')).toBe('archify');
  });

  test('a renderer whose model cannot be read hands the view to one that drew, and the page says so in one sentence', async () => {
    (globalThis as { fetch?: unknown }).fetch = async () => new Response(JSON.stringify({ message: 'no drawing in this test' }), { status: 500 });
    const container = into(createElement(BlockView, { block: viewsBlock(CONTAINER), resolutions: {} }));
    await until(() => container.querySelector('[data-testid=renderer-fallback]') !== null, 'the fallback sentence');
    expect(container.querySelector('[data-testid=view]')!.getAttribute('data-renderer')).toBe('mermaid');
    expect(container.querySelector('[data-testid=renderer-fallback]')!.textContent).toContain('could not draw this diagram here');
  });

  test('every drawn view has a full-screen control that toggles and exits on Escape', async () => {
    const container = into(createElement(BlockView, { block: viewsBlock(CONTAINER), resolutions: {} }));
    await until(() => container.querySelector('[data-testid=fullscreen-button]') !== null, 'the full-screen control');
    const button = container.querySelector('[data-testid=fullscreen-button]') as HTMLButtonElement;
    button.click();
    await until(() => container.querySelector('[data-testid=fullscreenable]')?.getAttribute('data-fullscreen') === 'true', 'full screen');
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    await until(() => container.querySelector('[data-testid=fullscreenable]')?.getAttribute('data-fullscreen') === 'false', 'exit full screen');
  });

  test('a sequence has the one renderer that draws it, and the steps are a list: numbered, linked, the unordered one marked', async () => {
    const container = into(createElement(BlockView, { block: viewsBlock(SEQUENCE), resolutions: {} }));
    await until(() => container.querySelector('[data-testid=view-steps]') !== null, 'the steps');
    expect([...container.querySelectorAll('[role=tab]')].map((tab) => tab.textContent)).toEqual(['Mermaid']);
    const steps = [...container.querySelectorAll('[data-testid=view-step]')];
    expect(steps).toHaveLength(2);
    expect(steps[0]!.querySelector('a')!.getAttribute('href')).toBe('/e/route');
    expect(steps[0]!.textContent).toContain('middleware: authenticate');
    expect(steps[1]!.getAttribute('data-dashed')).toBe('true');
    expect(container.querySelector('[data-testid=view-why]')!.textContent).toContain('the graph holds no order for this step');
  });

  test('an element links to its page; one that stands for a level below opens it in place, and the way up comes back', async () => {
    const asked: string[] = [];
    (globalThis as { fetch?: unknown }).fetch = async (url: string) => {
      asked.push(String(url));
      return new Response(JSON.stringify({ views: [COMPONENTS] }), { status: 200 });
    };
    const container = into(createElement(BlockView, { block: viewsBlock(CONTAINER), resolutions: {} }));
    await until(() => container.querySelector('[data-testid=view-drill]') !== null, 'the drill-down');
    const rows = [...container.querySelectorAll('[data-testid=view-element]')];
    expect(rows[0]!.querySelector('a')!.getAttribute('href')).toBe('/e/code.service%3Apayments');
    expect(rows[2]!.getAttribute('data-dashed')).toBe('true');
    (container.querySelector('[data-testid=view-drill]') as HTMLElement).click();
    await until(() => container.querySelector('[data-testid=view-title]')?.textContent === 'Components: payments', 'the components view');
    // The drill-down asks the server for the view; the LikeC4 tab reads its own model frame beside it.
    expect(asked.filter((url) => url.startsWith('/api/view?'))).toEqual(['/api/view?type=c4-component&subject=code.service%3Apayments&lang=en']);
    (container.querySelector('[data-testid=view-up]') as HTMLElement).click();
    await until(() => container.querySelector('[data-testid=view-title]')?.textContent === 'Containers', 'the way back up');
  });

  test('a view switcher appears when a block holds several views, and a failed drill-down says why', async () => {
    (globalThis as { fetch?: unknown }).fetch = async () => new Response(JSON.stringify({ message: 'no module here' }), { status: 404 });
    const container = into(createElement(BlockView, { block: viewsBlock(CONTAINER, COMPONENTS), resolutions: {} }));
    await until(() => container.querySelector('[data-testid=view-switcher]') !== null, 'the switcher');
    (container.querySelector('[data-testid=view-drill]') as HTMLElement).click();
    await until(() => container.querySelector('[data-testid=diagram-failure]') !== null, 'the failure');
    expect(container.querySelector('[data-testid=diagram-failure]')!.textContent).toContain('no module here');
    (container.querySelectorAll('[data-testid=view-tab]')[1] as HTMLElement).click();
    await until(() => container.querySelector('[data-testid=view-title]')?.textContent === 'Components: payments', 'the second view');
  });

  test('a click on a Mermaid node opens the page of the element the node stands for', () => {
    const root = document.createElement('div');
    root.innerHTML = '<svg><g id="flowchart-n0-3" class="node"><rect/></g><g id="flowchart-n2-5" class="node"><rect/></g></svg>';
    const opened: string[] = [];
    const undo = bindMermaid(root, CONTAINER.elements, 'c4-container', (href) => opened.push(href));
    (root.querySelector('#flowchart-n0-3') as unknown as HTMLElement).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    (root.querySelector('#flowchart-n2-5') as unknown as HTMLElement).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(opened).toEqual(['/e/code.service%3Apayments']);
    undo();
  });
});

describe('a deferred diagram', () => {
  test('is a place with its title until its block is read, then the diagram; a failed read says why', async () => {
    const asked: string[] = [];
    (globalThis as { fetch?: unknown }).fetch = async (url: string) => {
      asked.push(String(url));
      return new Response(JSON.stringify(graphBlock()), { status: 200 });
    };
    const block: Block = { type: 'deferred', block: 'graph', title: 'Around this function', id: 'graph-1a2b3c4d5e6f' };
    const container = into(createElement(BlockView, { block, resolutions: {}, pageId: 'code.symbol:x' }));
    await until(() => container.querySelector('[data-testid=hood-node]') !== null, 'the diagram');
    expect(asked).toEqual(['/api/block?id=code.symbol%3Ax&block=graph-1a2b3c4d5e6f&lang=en']);
    rendered?.unmount();
    document.body.innerHTML = '';
    (globalThis as { fetch?: unknown }).fetch = async () => new Response(JSON.stringify({ message: 'no block known as graph-1a2b3c4d5e6f' }), { status: 404 });
    const failed = into(createElement(BlockView, { block, resolutions: {}, pageId: 'code.symbol:x' }));
    await until(() => failed.querySelector('[data-testid=diagram-failure]') !== null, 'the failure');
    expect(failed.querySelector('[data-testid=diagram-failure]')!.textContent).toContain('no block known as graph-1a2b3c4d5e6f');
  });
});

/** The Files page's read as the server answers it: three files of one repository with their rhythm. */
const treemapData = (over: Partial<FilesMap> = {}): FilesMap => ({
  repository: 'shop',
  folder: 'src',
  files: [
    { id: 'code.file:shop/src/order.go', path: 'src/order.go', href: '/e/f1', lines: 400, bytes: 9000, language: 'Go', languages: [{ language: 'Go', saidBy: 'linguist@9.5.0' }], heat: [1, 4, 7, 9] as [number, number, number, number], last: '2026-11-01T10:00:00Z', authors: ['Ada', 'Linus'] },
    { id: 'code.file:shop/src/pricing.go', path: 'src/pricing.go', href: '/e/f2', lines: 100, bytes: 3000, language: 'Go', languages: [{ language: 'Go', saidBy: 'linguist@9.5.0' }], heat: [0, 1, 2, 2] as [number, number, number, number], last: '2026-10-20T10:00:00Z', authors: ['Ada'] },
    { id: 'code.file:shop/src/README.md', path: 'src/README.md', href: '/e/f3', lines: 40, bytes: 800, language: null, languages: [], heat: [0, 0, 0, 0] as [number, number, number, number], last: null, authors: [] },
  ],
  totals: { files: 3, lines: 540, bytes: 12800, withoutLines: 0, other: 1, languages: [{ name: 'Go', files: 2, lines: 500, bytes: 12000 }] },
  windows: { d30: '2026-10-01T00:00:00Z', d90: '2026-08-01T00:00:00Z', d365: '2025-11-01T00:00:00Z' },
  graphTotal: 3,
  ...over,
});

const treemap = (over: Partial<Extract<Block, { type: 'treemap' }>> = {}): Block => ({
  type: 'treemap',
  title: 'Repository map',
  data: treemapData(),
  area: 'lines',
  colour: 'language',
  window: '90d',
  engine: 'mermaid',
  mermaid: 'treemap\n    "order.go": 400\n',
  mermaidDrawn: 3,
  mermaidOmitted: 0,
  notes: [],
  ...over,
});

describe('the repository map', () => {
  test('the totals sentence and the language legend read in English and in Russian', async () => {
    const container = into(createElement(BlockView, { block: treemap(), resolutions: {} }));
    await until(() => container.querySelector('[data-testid=files-totals]') !== null, 'the totals');
    expect(container.querySelector('[data-testid=files-totals]')!.textContent).toBe('3 files across 540 lines in one language.');
    const legend = container.querySelector('[data-testid=files-legend]')!;
    expect(legend.getAttribute('data-measure')).toBe('language');
    expect([...legend.querySelectorAll('li')].map((entry) => entry.textContent)).toEqual(['Go', 'Other']);
    await setWikiLanguage('ru');
    try {
      const russian = into(createElement(BlockView, { block: treemap(), resolutions: {} }));
      await until(() => russian.querySelector('[data-testid=files-totals]') !== null, 'the totals');
      expect(russian.querySelector('[data-testid=files-totals]')!.textContent).toBe('3 файлов, строк: 540, язык один.');
    } finally {
      await setWikiLanguage('en');
    }
  });

  test('each group of controls is a segmented choice with its own label', async () => {
    const container = into(createElement(BlockView, { block: treemap({ colour: 'heat' }), resolutions: {} }));
    await until(() => container.querySelector('[data-testid=files-area]') !== null, 'the controls');
    const groups = [...container.querySelectorAll('.dg-seg')].map((group) => ({
      label: group.querySelector('.dg-seg-label')?.textContent,
      role: group.querySelector('[role=radiogroup]')?.getAttribute('aria-label'),
      options: [...group.querySelectorAll('[role=radio]')].map((option) => option.textContent),
      checked: [...group.querySelectorAll('[role=radio]')].filter((option) => option.getAttribute('aria-checked') === 'true').map((option) => option.textContent),
    }));
    expect(groups).toEqual([
      { label: 'Area', role: 'Area', options: ['Lines', 'Bytes'], checked: ['Lines'] },
      { label: 'Colour', role: 'Colour', options: ['Language', 'Heat', 'Age', 'Authors'], checked: ['Heat'] },
      { label: 'Window', role: 'Window', options: ['30 days', '90 days', 'A year', 'All time'], checked: ['90 days'] },
      { label: 'Engine', role: 'Engine', options: ['ECharts', 'Mermaid'], checked: ['Mermaid'] },
    ]);
  });

  test('the heat colour offers its window and draws the ramp its range stands for', async () => {
    const container = into(createElement(BlockView, { block: treemap({ colour: 'heat', window: '90d' }), resolutions: {} }));
    await until(() => container.querySelector('[data-testid=files-window]') !== null, 'the window switch');
    const legend = container.querySelector('[data-testid=files-legend]')!;
    expect(legend.getAttribute('data-measure')).toBe('heat');
    // The legend is the chosen measure's own: what the colour counts, the window, and the ramp's two ends.
    expect(legend.textContent).toContain('Heat: commits, 90 days');
    expect(legend.textContent).toContain('0 commits');
    expect(legend.textContent).toContain('4 commits');
    expect(container.querySelector('[data-testid=files-window-1y]')!.getAttribute('aria-checked')).toBe('false');
    container.querySelector<HTMLButtonElement>('[data-testid=files-window-1y]')!.click();
    await until(() => container.querySelector('[data-testid=files-window-1y]')!.getAttribute('aria-checked') === 'true', 'the year window');
    // The colour measure the reader leaves is not a window's: the window switch is only heat's.
    container.querySelector<HTMLButtonElement>('[data-testid=files-colour-authors]')!.click();
    await until(() => container.querySelector('[data-testid=files-window]') === null, 'the window switch to go');
    const authors = container.querySelector('[data-testid=files-legend]')!;
    expect(authors.getAttribute('data-measure')).toBe('authors');
    expect(authors.textContent).toContain('Authors: distinct writers');
    expect(authors.textContent).toContain('1 author');
    expect(authors.textContent).toContain('2 authors');
  });

  test('a folder page breadcrumbs from its own root, and the segments name what is below it', async () => {
    const container = into(createElement(BlockView, { block: treemap({ data: { ...treemapData(), folder: 'src' } }), resolutions: {} }));
    await until(() => container.querySelector('[data-testid=files-breadcrumb]') !== null, 'the breadcrumb');
    // The page covers src: its root crumb is src itself, and nothing lies above it in this map.
    expect([...container.querySelectorAll('[data-testid=files-crumb]')]).toEqual([]);
    const rootCrumb = container.querySelector('[data-testid=files-crumb-root]')!;
    expect(rootCrumb.textContent).toBe('src');
    expect(rootCrumb.getAttribute('data-current')).toBe('true');
    expect(crumbSegments('', '')).toEqual([]);
    expect(crumbSegments('', 'src/knowledge')).toEqual(['src', 'knowledge']);
    expect(crumbSegments('src', 'src')).toEqual([]);
    expect(crumbSegments('src', 'src/knowledge/files')).toEqual(['knowledge', 'files']);
  });

  test('the static picture is Mermaid by default and the reader may switch to the drawn map', async () => {
    const container = into(createElement(BlockView, { block: treemap(), resolutions: {} }));
    await until(() => container.querySelector('[data-testid=mermaid-diagram]') !== null, 'the Mermaid picture');
    expect(container.querySelector('[data-testid=files-engine-mermaid]')!.getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector('[data-testid=files-engine-echarts]')!.getAttribute('aria-checked')).toBe('false');
  });
});

describe('the map cells and their labels', () => {
  test('the ink is the one that reads on the tile: white on a dark fill, near-black on a light one, at 4.5 : 1 or better', () => {
    for (const fill of ['#8c5a14', '#1c1c1c', '#4f7f79', '#f3efe6', '#ffffff', '#eeeeee']) {
      const ink = inkFor(fill);
      // The ink is the better of the two on that fill, and it clears WCAG's 4.5 : 1 for body text.
      expect(contrastOf(fill, ink)).toBeGreaterThanOrEqual(contrastOf(fill, ink === '#ffffff' ? '#1c1c1c' : '#ffffff'));
      expect(contrastOf(fill, ink)).toBeGreaterThanOrEqual(4.5);
    }
    expect(inkFor('#1c1c1c')).toBe('#ffffff');
    expect(inkFor('#ffffff')).toBe('#1c1c1c');
  });

  test('a cell too small for its words draws none, and a cell with room draws them', () => {
    // A folder wants two lines and an icon; a file one line. The estimate is the cell's share of the frame.
    expect(labelFits(1000, 1000, 792 * 520, true)).toBe(true);
    expect(labelFits(1, 1000, 792 * 520, true)).toBe(false);
    expect(labelFits(1000, 1000, 792 * 520, false)).toBe(true);
    expect(labelFits(2, 1000, 792 * 520, false)).toBe(false);
  });

  test('the fill the label ink is chosen against is the fill the visual map paints', () => {
    const colouring = { colour: 'heat' as const, ramp: RAMPS.heat.light, max: 10, languageColours: [] };
    expect(fillOf(-1, colouring)).toBe(RAMPS.heat.light.none);
    expect(fillOf(0, colouring)).toBe(rampColourAt(RAMPS.heat.light.colors, 0));
    expect(fillOf(10, colouring)).toBe(rampColourAt(RAMPS.heat.light.colors, 1));
    const languages = { colour: 'language' as const, ramp: RAMPS.heat.light, max: 3, languageColours: ['#7a9e7e', '#b08a5a', '#7f8fb3'] };
    expect(fillOf(1, languages)).toBe('#b08a5a');
    expect(fillOf(9, languages)).toBe(RAMPS.heat.light.none);
  });
});

describe('the map option an engine draws from', () => {
  test('a cell carries its area and its measure, and the visual map colours the measure dimension', () => {
    const files = treemapData().files;
    const level = folderLevel(files, 'src');
    const cells = [
      ...level.folders.map((group) => ({ name: group.name, path: group.path, value: group.files.reduce((sum, file) => sum + (file.lines ?? 0), 0), measure: -1, file: false, href: null, tip: group.path, files: group.files.length })),
      ...level.files.map((file) => ({ name: file.path.slice(file.path.lastIndexOf('/') + 1), path: file.path, value: file.lines ?? 0, measure: file.heat[1], file: true, href: file.href, tip: file.path })),
    ];
    const option = mapOption({
      cells,
      dark: false,
      height: 400,
      label: 'Repository map',
      onDrill: () => {},
      onOpen: () => {},
      colouring: { colour: 'heat', ramp: RAMPS.heat.light, max: 7, languageColours: ['#7a9e7e', '#b08a5a'] },
    }) as { visualMap: { dimension: number; max: number; inRange: { color: string[] } }; series: { visualDimension: number; data: { name: string; value: [number, number] }[] }[] };
    expect(option.visualMap.dimension).toBe(1);
    expect(option.visualMap.max).toBe(7);
    expect(option.visualMap.inRange.color).toEqual([...RAMPS.heat.light.colors]);
    expect(option.series[0]!.visualDimension).toBe(1);
    // The folder is one cell, the sum of its files; each file keeps its own area and its measure.
    expect(option.series[0]!.data.map((cell) => [cell.name, cell.value])).toEqual([['README.md', [40, 0]], ['order.go', [400, 4]], ['pricing.go', [100, 1]]]);
    // Every cell names itself in a label of at least 12 px, in ink chosen against its own fill.
    const rich = (option.series[0] as unknown as { label: { rich: Record<string, { fontSize?: number; color?: string }> } }).label.rich;
    for (const name of ['nameLight', 'nameDark', 'folderLight', 'folderDark', 'countLight', 'countDark']) {
      expect(rich[name]!.fontSize).toBeGreaterThanOrEqual(12);
      expect(rich[name]!.color === '#ffffff' || rich[name]!.color === '#1c1c1c').toBe(true);
    }
    const order = (option.series[0] as unknown as { data: { name: string; label: { show: boolean; formatter: string } }[] }).data.find((cell) => cell.name === 'order.go')!;
    expect(order.label.show).toBe(true);
    expect(order.label.formatter).toContain('order.go');
  });
});
