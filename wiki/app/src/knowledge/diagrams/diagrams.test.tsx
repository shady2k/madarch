/**
 * The diagram blocks as the app draws them (madarch-m38l.9), over the server's shapes: nodes are links, a click goes
 * through the `onOpen` hook, a plus opens a node's neighbours through the neighbourhood route, the chain marks what the
 * graph does not order, the module view marks cycles, the treemap gives area to lines and warmth to churn.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setWikiLanguage } from '../../i18n.js';
import { BlockView } from '../blocks.js';
import { DiagramOpenProvider } from './open.js';
import { autoFolded, foldChain, layoutChain, MIN_LANE } from './chain.js';
import { frontTab, resetTabs } from '../tabs.js';
import type { Block, Chain, Neighborhood } from '../types.js';

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

const CHAIN: Chain = {
  title: 'POST /payments',
  entry: { id: 'route', kind: 'code.route', label: 'POST /payments', href: '/k/e/route' },
  lanes: [
    { id: 'actor', label: 'Caller', sub: 'client', kind: 'actor', href: null, group: 'client' },
    { id: 'file:routes', label: 'routes.ts', sub: 'services/payments/src/api', kind: 'code.file', href: '/k/e/routes', group: 'payments' },
    { id: 'file:svc', label: 'payment-service.ts', sub: 'services/payments/src/domain', kind: 'code.file', href: '/k/e/svc', group: 'payments' },
    { id: 'topic', label: 'payments.events', sub: 'topic', kind: 'code.channel', href: null, group: 'broker' },
    { id: 'file:consumer', label: 'payments.go', sub: 'services/orders/internal/consumer', kind: 'code.file', href: '/k/e/consumer', group: 'orders' },
  ],
  steps: [
    { n: 1, from: 'actor', to: 'file:routes', label: 'POST /payments', kind: 'route', href: '/k/e/route', order: 'source', note: 'middleware: authenticate' },
    { n: 2, from: 'file:routes', to: 'file:svc', label: 'PaymentService.pay', kind: 'call', href: '/k/e/pay', order: 'source', site: { repo: 'training', path: 'services/payments/src/api/routes.ts', lineStart: 22, lineEnd: 22, href: '/k/src?path=routes.ts&line=22' } },
    { n: 3, from: 'file:svc', to: 'topic', label: 'publishes payments.events', kind: 'publish', href: null, order: 'source' },
    { n: 4, from: 'topic', to: 'file:consumer', label: 'Service.ApplyPaymentEvent', kind: 'consume', href: '/k/e/apply', order: 'unordered', note: 'consumes payments.events' },
  ],
  notes: ['Branches and loops are not modelled.'],
  total: 4,
};

/** A chain through three services of four files each, the shape that overflowed a column. */
function wideChain(): Chain {
  const lanes: Chain['lanes'] = [{ id: 'actor', label: 'Caller', sub: 'client', kind: 'actor', href: null, group: 'client' }];
  for (const service of ['checkout', 'orders', 'payments']) for (const file of ['routes', 'handler', 'service', 'repository']) lanes.push({ id: `file:${service}/${file}`, label: `${file}.ts`, sub: service, kind: 'code.file', href: `/k/e/${service}-${file}`, group: service });
  const steps: Chain['steps'] = [];
  let n = 0;
  const step = (from: string, to: string, label: string, kind: Chain['steps'][number]['kind'] = 'call'): void => { n += 1; steps.push({ n, from, to, label, kind, href: `/k/e/${n}`, order: 'source' }); };
  step('actor', 'file:checkout/routes', 'POST /checkout', 'route');
  step('file:checkout/routes', 'file:checkout/handler', 'handle');
  step('file:checkout/handler', 'file:checkout/service', 'CheckoutService.checkout');
  step('file:checkout/service', 'file:orders/routes', 'POST /orders', 'http');
  step('file:orders/routes', 'file:orders/handler', 'OrderHandlers.Create');
  step('file:orders/handler', 'file:orders/service', 'Service.Place');
  step('file:orders/service', 'file:orders/repository', 'OrderRepository.Create');
  step('file:orders/service', 'file:orders/service', 'localHelper');
  step('file:checkout/service', 'file:payments/routes', 'Payments/Authorize', 'grpc');
  step('file:payments/routes', 'file:payments/service', 'PaymentService.pay');
  return { title: 'POST /checkout', entry: null, lanes, steps, notes: [], total: steps.length };
}

describe('the chain fits its column', () => {
  test('the services with most files fold into one lane until the lanes fit, a step inside a folded lane is counted and not drawn, and the numbers stay', () => {
    const chain = wideChain();
    const folded = autoFolded(chain, 800);
    expect([...folded].sort()).toEqual(['checkout', 'orders']);
    const view = foldChain(chain, folded, false);
    expect(view.lanes.map((lane) => lane.label)).toEqual(['Caller', 'checkout', 'orders', 'routes.ts', 'service.ts']);
    expect(view.inside).toEqual([{ group: 'checkout', count: 2 }, { group: 'orders', count: 4 }]);
    expect(view.sameFile).toBe(0);
    expect(view.steps.map((entry) => entry.n)).toEqual([1, 4, 9, 10]);
    const layout = layoutChain(view, 800);
    expect(layout.width).toBeLessThanOrEqual(800);
    for (const lane of view.lanes) expect(layout.laneX.get(lane.id)! + layout.laneW / 2).toBeLessThanOrEqual(layout.width);
  });

  test('no text of any row leaves the diagram at the widths of the wiki\'s column, with every service open or folded', () => {
    const chain = wideChain();
    for (const width of [560, 790, 1100]) {
      for (const open of [false, true]) {
        const view = foldChain(chain, open ? new Set() : autoFolded(chain, width), open);
        const layout = layoutChain(view, width);
        expect(layout.laneW).toBeGreaterThanOrEqual(MIN_LANE);
        for (const row of layout.rows) {
          const left = row.label.anchor === 'middle' ? row.label.x - row.label.width / 2 : row.label.x;
          expect(left).toBeGreaterThanOrEqual(0);
          expect(left + row.label.width).toBeLessThanOrEqual(layout.width);
        }
        if (!open) expect(layout.width).toBeLessThanOrEqual(width);
      }
    }
  });

  test('every step is a row of a lane that is drawn: no step of the diagram names a lane that is not there', () => {
    const chain = wideChain();
    for (const open of [false, true]) {
      const view = foldChain(chain, open ? new Set() : autoFolded(chain, 600), open);
      const ids = new Set(view.lanes.map((lane) => lane.id));
      for (const entry of view.steps) {
        expect(ids.has(entry.from)).toBe(true);
        expect(ids.has(entry.to)).toBe(true);
      }
    }
  });

  test('the diagram says how many steps are folded and offers all of them; opening shows the files and the same-file steps', async () => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 600 });
    try {
      const block: Block = { type: 'sequence', title: 'End-to-end chain', scenario: 'x', chains: [wideChain()], entries: 1, notes: [] };
      const container = into(createElement(BlockView, { block, resolutions: {} }));
      await until(() => container.querySelector('[data-testid=chain-step]') !== null, 'the steps');
      const drawn = (): number => container.querySelectorAll('[data-testid=chain-step]').length;
      await until(() => drawn() === 3, 'the diagram fitted to the column');
      expect(container.querySelector('[data-testid=chain-folded]')!.textContent).toBe('7 steps inside one lane or one file are folded.');
      const all = container.querySelector('[data-testid=chain-show-all]') as unknown as HTMLElement;
      expect(all.textContent).toBe('Show all 10 steps');
      all.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await until(() => drawn() === 10, 'all the steps');
      expect(container.querySelector('[data-testid=chain-scroll]')!.className).toContain('dg-scrolls');
      (container.querySelector('[data-testid=chain-fit]') as unknown as HTMLElement).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await until(() => drawn() === 3, 'the fitted diagram again');
    } finally {
      delete (HTMLElement.prototype as { clientWidth?: unknown }).clientWidth;
    }
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

describe('the chain', () => {
  test('every step is a link, a step with a site links its number to the code, and what the graph does not order is drawn below a dashed line that says so', async () => {
    const block: Block = { type: 'sequence', title: 'End-to-end chain', scenario: 'Payment', chains: [CHAIN], entries: 1, notes: [] };
    const container = into(createElement(BlockView, { block, resolutions: {} }));
    await until(() => container.querySelector('[data-testid=chain-step]') !== null, 'the steps');
    expect(container.querySelector('[data-testid=scenario]')!.textContent).toBe('Scenario: Payment');
    const steps = [...container.querySelectorAll('[data-testid=chain-step]')];
    expect(steps).toHaveLength(4);
    expect(steps[1]!.querySelectorAll('a')).toHaveLength(2);
    expect(steps[1]!.querySelectorAll('a')[1]!.getAttribute('href')).toBe('/k/src?path=routes.ts&line=22');
    expect(steps[2]!.querySelector('a')).toBeNull();
    expect(container.querySelector('[data-testid=chain-unordered]')!.textContent).toContain('holds no order');
    expect(container.querySelectorAll('[data-testid=chain-lane]')).toHaveLength(5);
    expect([...container.querySelectorAll('[data-testid=chain-group]')].map((group) => group.textContent)).toEqual(['client', '− payments', 'broker', 'orders']);
    expect(container.querySelector('.dg-notes')!.textContent).toBe('Branches and loops are not modelled.');
  });

  test('no two labels of the chain overlap, and each stays inside the diagram', () => {
    const layout = layoutChain(CHAIN, 0);
    const boxes = layout.rows.map((row) => {
      const left = row.label.anchor === 'middle' ? row.label.x - row.label.width / 2 : row.label.x;
      return { left, right: left + row.label.width, y: row.y };
    });
    for (const a of boxes) {
      expect(a.left).toBeGreaterThanOrEqual(0);
      expect(a.right).toBeLessThanOrEqual(layout.width);
      for (const b of boxes) if (a !== b) expect(a.y !== b.y || a.right <= b.left || b.right <= a.left).toBe(true);
    }
    expect(layout.separator).not.toBeNull();
    expect(layout.separator!.y).toBeGreaterThan(layout.rows[2]!.y);
    expect(layout.separator!.y).toBeLessThan(layout.rows[3]!.y);
  });

  test('a scenario no route reaches says so', async () => {
    const block: Block = { type: 'sequence', title: 'End-to-end chain', scenario: 'x', chains: [], entries: 0, notes: [] };
    const container = into(createElement(BlockView, { block, resolutions: {} }));
    await until(() => container.querySelector('[data-testid=diagram-empty]') !== null, 'the note');
    expect(container.querySelector('[data-testid=diagram-empty]')!.textContent).toContain('No route or function of the graph leads here');
  });
});

describe('the system and module views', () => {
  test('the system view draws the services, the database and the topic with the link of each kind told by a word on its line and a legend', async () => {
    const block: Block = {
      type: 'system', title: 'The system', notes: [],
      nodes: [
        { id: 's:checkout', kind: 'service', label: 'checkout', sub: 'typescript', href: '/k/e/checkout' },
        { id: 's:orders', kind: 'service', label: 'orders', sub: 'go · Kafka, Postgres', href: '/k/e/orders' },
        { id: 'db:orders', kind: 'database', label: 'orders', sub: 'database', href: null },
        { id: 'topic:ev', kind: 'topic', label: 'orders.events', sub: 'topic', href: null },
      ],
      edges: [
        { from: 's:checkout', to: 's:orders', via: 'http', label: 'POST /orders', count: 2 },
        { from: 's:orders', to: 'db:orders', via: 'sql', label: 'reads, writes', count: 3 },
        { from: 's:orders', to: 'topic:ev', via: 'publishes', label: 'publishes', count: 1 },
      ],
    };
    const container = into(createElement(BlockView, { block, resolutions: {} }));
    await until(() => container.querySelector('[data-testid=system-node]') !== null, 'the nodes');
    expect(container.querySelectorAll('[data-testid=system-node]')).toHaveLength(4);
    expect([...container.querySelectorAll('[data-testid=system-edge-label] text')].map((text) => text.textContent)).toEqual(['HTTP POST /orders', 'SQL · reads, writes', 'publishes']);
    expect(container.querySelector('[data-testid=system-node] a')!.getAttribute('href')).toBe('/k/e/checkout');
    expect(container.querySelector('[data-testid=system-legend]')!.textContent).toContain('HTTP');
  });

  test('the module view marks the modules and the edges of a cycle and names the cycle', async () => {
    const block: Block = {
      type: 'modules', title: 'Modules', service: 'payments', notes: [],
      nodes: [
        { id: 'm:domain', label: 'src/domain', files: 3, href: '/k/e/domain', cycle: true },
        { id: 'm:events', label: 'src/events', files: 1, href: '/k/e/events', cycle: true },
        { id: 'm:api', label: 'src/api', files: 3, href: '/k/e/api', cycle: false },
      ],
      edges: [
        { from: 'm:api', to: 'm:domain', cycle: false },
        { from: 'm:domain', to: 'm:events', cycle: true },
        { from: 'm:events', to: 'm:domain', cycle: true },
      ],
      cycles: [['m:domain', 'm:events']],
    };
    const container = into(createElement(BlockView, { block, resolutions: {} }));
    await until(() => container.querySelector('[data-testid=module-node]') !== null, 'the nodes');
    expect([...container.querySelectorAll('[data-testid=module-node][data-cycle=true]')]).toHaveLength(2);
    expect(container.querySelectorAll('path.dg-cycle')).toHaveLength(2);
    expect(container.querySelector('[data-testid=cycle]')!.textContent).toBe('Cycle: src/domain ⇄ src/events');
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
