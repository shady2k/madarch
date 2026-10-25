/**
 * The diagram blocks as the app draws them (madarch-m38l.9), over the server's shapes: nodes are links, a click goes
 * through the `onOpen` hook, a plus opens a node's neighbours through the neighbourhood route, the drawn views (C4,
 * sequence, ER, state, deployment; madarch-m38l.15) switch renderer and drill down, the treemap gives area to lines and
 * warmth to churn.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { setWikiLanguage } from '../../i18n.js';
import { BlockView } from '../blocks.js';
import { DiagramOpenProvider } from './open.js';
import { frontTab, resetTabs } from '../tabs.js';
import type { Block, DiagramView, Neighborhood } from '../types.js';
import { bindMermaid, mermaidPicture } from './views.js';
import { diagramTitleNodes } from '../../../../../src/knowledge/diagram-titles.js';

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
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
});

const node = (id: string, label: string, hops: number, href: string | null = `/k/e/${encodeURIComponent(id)}`) => ({ id, kind: 'code.symbol', label, href, hops });
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
    expect(boxes.find((box) => box.getAttribute('data-node') === 'routes')!.querySelector('a')!.getAttribute('href')).toBe('/k/e/routes');
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
    const link = [...container.querySelectorAll('[data-testid=hood-node] a')].find((a) => a.getAttribute('href') === '/k/e/routes')! as unknown as HTMLElement;
    link.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    link.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, shiftKey: true }));
    expect(opened).toEqual(['/k/e/routes']);
  });

  test('with no host hook a click opens the node\'s page in a new tab of the wiki, and the same page again switches to its tab', async () => {
    resetTabs();
    const container = into(createElement(BlockView, { block: graphBlock(), resolutions: {} }));
    await until(() => container.querySelector('[data-testid=hood-node] a') !== null, 'the links');
    const link = [...container.querySelectorAll('[data-testid=hood-node] a')].find((a) => a.getAttribute('href') === '/k/e/routes')! as unknown as HTMLElement;
    link.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    expect(frontTab().address).toBe('/k/e/routes');
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
    expect(calls).toEqual(['/api/k/neighborhood?id=routes&limit=8']);
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
    { id: 'code.service:payments', label: 'payments', kind: 'container', detail: 'TypeScript', href: '/k/e/code.service%3Apayments', dashed: false, drill: { spec: { type: 'c4-component', subject: 'code.service:payments' }, title: 'Components' } },
    { id: 'code.database:payments', label: 'payments', kind: 'database', href: '/k/e/code.database%3Apayments', dashed: false },
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
  elements: [{ id: 'code.module:domain', label: 'src/domain', kind: 'component', detail: '4 files', href: '/k/e/m', dashed: false }],
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
  elements: [{ id: 'lane:Caller', label: 'Caller', kind: 'person', href: null, dashed: true }, { id: 'lane:payments', label: 'payments', kind: 'participant', href: '/k/e/code.service%3Apayments', dashed: false }],
  edges: [
    { from: 'lane:Caller', to: 'lane:payments', label: 'POST /payments', dashed: false, step: 1, kind: 'route', href: '/k/e/route', note: 'middleware: authenticate' },
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
    await until(() => asked.some((url) => url.includes('/api/k/view-frame?type=c4-container&subject=&renderer=likec4&lang=en')), 'the LikeC4 model read');
    (container.querySelector('[data-testid=renderer-archify]') as HTMLElement).click();
    await until(() => container.querySelector('iframe')?.getAttribute('src')?.includes('renderer=archify') === true, 'the archify frame');
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
    expect(steps[0]!.querySelector('a')!.getAttribute('href')).toBe('/k/e/route');
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
    expect(rows[0]!.querySelector('a')!.getAttribute('href')).toBe('/k/e/code.service%3Apayments');
    expect(rows[2]!.getAttribute('data-dashed')).toBe('true');
    (container.querySelector('[data-testid=view-drill]') as HTMLElement).click();
    await until(() => container.querySelector('[data-testid=view-title]')?.textContent === 'Components: payments', 'the components view');
    // The drill-down asks the server for the view; the LikeC4 tab reads its own model frame beside it.
    expect(asked.filter((url) => url.startsWith('/api/k/view?'))).toEqual(['/api/k/view?type=c4-component&subject=code.service%3Apayments&lang=en']);
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
    expect(opened).toEqual(['/k/e/code.service%3Apayments']);
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
    const block: Block = { type: 'deferred', block: 'graph', title: 'Around this function', line: 7 };
    const container = into(createElement(BlockView, { block, resolutions: {}, pageId: 'code.symbol:x' }));
    await until(() => container.querySelector('[data-testid=hood-node]') !== null, 'the diagram');
    expect(asked).toEqual(['/api/k/block?id=code.symbol%3Ax&line=7&lang=en']);
    rendered?.unmount();
    document.body.innerHTML = '';
    (globalThis as { fetch?: unknown }).fetch = async () => new Response(JSON.stringify({ message: 'no block at line 7' }), { status: 404 });
    const failed = into(createElement(BlockView, { block, resolutions: {}, pageId: 'code.symbol:x' }));
    await until(() => failed.querySelector('[data-testid=diagram-failure]') !== null, 'the failure');
    expect(failed.querySelector('[data-testid=diagram-failure]')!.textContent).toContain('no block at line 7');
  });
});

describe('the treemap', () => {
  test('area follows the lines, warmth follows the churn, and each file is a link with its numbers in the title', async () => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
    try {
      const block: Block = {
        type: 'treemap', title: 'Files by size and change', scope: '', total: 3, maxChurn: 28, notes: [],
        files: [
          { id: 'f1', path: 'src/order_service.go', href: '/k/e/f1', lines: 400, churn: 28 },
          { id: 'f2', path: 'src/pricing.go', href: '/k/e/f2', lines: 100, churn: 2 },
          { id: 'f3', path: 'README.md', href: null, lines: 40, churn: 0 },
        ],
      };
      const container = into(createElement(BlockView, { block, resolutions: {} }));
      await until(() => container.querySelector('[data-testid=treemap-file]') !== null, 'the cells');
      const cells = [...container.querySelectorAll('[data-testid=treemap-file]')];
      const area = (cell: Element): number => { const rect = cell.querySelector('rect')!; return Number(rect.getAttribute('width')) * Number(rect.getAttribute('height')); };
      const byLines = new Map(cells.map((cell) => [cell.getAttribute('data-lines'), cell]));
      expect(area(byLines.get('400')!) / area(byLines.get('100')!)).toBeGreaterThan(3);
      expect(byLines.get('400')!.querySelector('rect')!.getAttribute('style')).toContain('--heat: 1.000');
      expect(byLines.get('40')!.querySelector('a')).toBeNull();
      expect(byLines.get('400')!.querySelector('title')!.textContent).toBe('src/order_service.go — 400 lines, 28 commits');
      expect(container.querySelector('[data-testid=treemap-legend]')!.textContent).toContain('Area is the lines of the file.');
    } finally {
      delete (HTMLElement.prototype as { clientWidth?: unknown }).clientWidth;
    }
  });
});


test('asynchronous network and malformed JSON failures leave a visible LikeC4 error', async () => {
  (globalThis as {fetch?:unknown}).fetch = async () => { throw new Error('connection reset'); };
  const container = into(createElement(BlockView,{block:viewsBlock(CONTAINER),resolutions:{}}));
  await until(() => container.querySelector('[role=alert]')?.textContent?.includes('connection reset'), 'the network error');
  expect(container.querySelector('.dg-likec4-view')).toBeNull();
  expect(container.querySelector('[data-testid=view]')!.getAttribute('data-renderer')).toBe('likec4');
});

test('malformed JSON is reported instead of a blank diagram', async () => {
  (globalThis as {fetch?:unknown}).fetch = async () => new Response('{invalid',{status:200});
  const container = into(createElement(BlockView,{block:viewsBlock(CONTAINER),resolutions:{}}));
  await until(() => Boolean(container.querySelector('[role=alert]')?.textContent), 'the JSON error');
  expect(container.querySelector('.dg-likec4-view')).toBeNull();
});

test('Mermaid gives the bilingual reading hint', async () => {
  await setWikiLanguage('ru');
  const container = into(createElement(BlockView,{block:viewsBlock(SEQUENCE),resolutions:{}}));
  await until(() => container.querySelector('[data-testid=zoom-box] .dg-view-hint') !== null, 'the Mermaid hint');
  expect(container.querySelector('[data-testid=zoom-box] .dg-view-hint')!.textContent).not.toContain('knowledge.views.');
  expect(container.querySelector('[data-testid=zoom-box] .dg-view-hint')!.textContent).toContain('на телефоне — окно для чтения');
  await setWikiLanguage('en');
  await until(() => container.querySelector('[data-testid=zoom-box] .dg-view-hint')!.textContent?.includes('phone full screen keeps a reading window'), 'the English phone fullscreen hint');
});


test('only the selected archify iframe can request fallback, and its reason remains visible', async () => {
  const container=into(createElement(BlockView,{block:{...viewsBlock(CONTAINER),renderer:'archify'} as Block,resolutions:{}}));
  await until(()=>container.querySelector('iframe')!==null,'the archify iframe');
  const frame=container.querySelector('iframe')!;
  flushSync(() => window.dispatchEvent(new window.MessageEvent('message',{origin:location.origin,source:window,data:{madarch:'failed',renderer:'archify',message:'forged failure'}})));
  expect(container.querySelector('[data-testid=renderer-fallback]')).toBeNull();
  flushSync(() => window.dispatchEvent(new window.MessageEvent('message',{origin:'https://elsewhere.invalid',source:frame.contentWindow,data:{madarch:'failed',renderer:'archify',message:'wrong-origin failure'}})));
  expect(container.querySelector('[data-testid=renderer-fallback]')).toBeNull();
  window.dispatchEvent(new window.MessageEvent('message',{origin:location.origin,source:frame.contentWindow,data:{madarch:'failed',renderer:'archify',message:'/tmp/view/document.json:1: renderer exit 1'}}));
  await until(()=>container.querySelector('[data-testid=renderer-fallback]')!==null,'the explicit fallback');
  expect(container.querySelector('[data-testid=renderer-fallback]')!.textContent).toContain('/tmp/view/document.json:1: renderer exit 1');
});


test('renderer title definitions include group names, exclude ER attributes and associate whole nodes', () => {
  const root = document.createElement('div');
  root.innerHTML = '<svg><g class="node" id="table"><g class="name"><text>orders</text></g><g class="attribute"><text>customer_id UUID FK</text></g><rect width="400" height="600"/></g><g class="cluster"><g class="cluster-label"><text>Billing</text></g></g></svg>';
  const er = diagramTitleNodes(root, 'mermaid', 'er');
  expect(er).toHaveLength(1);
  expect((er[0]!.title as Element).textContent).toBe('orders');
  expect((er[0]!.node as Element).id).toBe('table');
  root.querySelector('g.name')!.setAttribute('class', 'nodeLabel');
  const grouped = diagramTitleNodes(root, 'mermaid', 'domain-map');
  expect(grouped.map(pair => (pair.title as Element).textContent)).toContain('Billing');
  root.innerHTML = '<svg><rect data-graph-role="structural-frame" data-composition-frame-id="2"/><g data-composition-frame-id="2"><text data-boundary-label="">Deployment</text></g><g id="node-api"><rect/><text data-node-label="">api</text></g></svg>';
  const archify = diagramTitleNodes(root, 'archify', 'deployment');
  expect(archify).toHaveLength(2);
  expect((archify[0]!.node as Element).getAttribute('data-graph-role')).toBe('structural-frame');
  root.innerHTML = '<div class="react-flow__node"><div class="likec4-compound-title">Compose</div></div>';
  const likec4 = diagramTitleNodes(root, 'likec4', 'deployment');
  expect(likec4).toHaveLength(1);
  expect((likec4[0]!.node as Element).className).toBe('react-flow__node');
});


test('an oversized picture links to all raw members and relationships in the adjacent list', async () => {
  const elements = Array.from({ length: 45 }, (_, index) => ({ id: `member:${index}`, label: `member-${index}`, kind: 'node', href: `/k/e/${index}`, dashed: false }));
  const view: DiagramView = { ...CONTAINER, elements: elements.slice(0, 40), fullElements: elements, fullEdges: [{ from: 'member:43', to: 'member:44', label: 'not lost', dashed: false }], marker: 'Showing 40 of 45.' };
  const container = into(createElement(BlockView, { block: viewsBlock(view), resolutions: {} }));
  await until(() => container.querySelector('[data-testid=view-full-list-link]') !== null, 'the full-list link');
  const link = container.querySelector('[data-testid=view-full-list-link]')!;
  const target = container.querySelector('[data-testid=view-full-list]')!;
  expect(link.getAttribute('href')).toBe(`#${target.id}`);
  expect(container.querySelectorAll('[data-testid=view-element]')).toHaveLength(45);
  expect(container.querySelector('[data-testid=view]')!.getAttribute('data-adjacent-list-count')).toBe('45');
  expect(target.textContent).toContain('member-44');
  expect(container.querySelector('[data-testid=view-full-relationships]')!.textContent).toContain('member-43 → member-44: not lost');
});

test('an ER table offers only Mermaid and keeps its page link under the picture', async () => {
  const view: DiagramView = { ...CONTAINER, spec: { type: 'er', subject: 'orders' }, renderers: ['mermaid'], mermaidSource: 'erDiagram\n orders {\n uuid id PK\n }' };
  const container = into(createElement(BlockView, { block: viewsBlock(view), resolutions: {} }));
  await until(() => container.querySelector('[data-testid=renderer-mermaid]') !== null, 'the Mermaid ER tab');
  expect(container.querySelectorAll('[data-testid=renderer-archify], [data-testid=renderer-likec4]')).toHaveLength(0);
  expect(container.querySelector('[data-testid=view-elements] a')!.getAttribute('href')).toBe('/k/e/code.service%3Apayments');
});
