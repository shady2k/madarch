/**
 * The Architecture section's app side (feature E, madarch-iuc.15), tested
 * without a server: every request is answered by a stub giving the API's
 * shapes (the same way app.test.ts works), the DOM is happy-dom. The index,
 * a view page, an element page, the compile-error page, the conservative
 * document-to-element links and the Russian chrome are the covered surface.
 */
import { afterEach, afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import { ArchitectureIndex, ViewPage, ElementPage } from './architecture.js';
import { Markdown, linkElements } from './view.js';
import { noteLikec4ScriptReady } from './diagram.js';
import { setWikiLanguage } from './i18n.js';
import type { Architecture } from './api.js';

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  await setWikiLanguage('en');
  // The webcomponent element, stubbed: happy-dom would fetch the 2.6 MB
  // bundle the loader appends; the tests mark the bundle ready themselves
  // and define the element, as a real browser has it after the load.
  noteLikec4ScriptReady();
  window.customElements.define('likec4-view', class extends HTMLElement {});
});

afterAll(async () => {
  await new Promise((rest) => setTimeout(rest, 50));
  GlobalRegistrator.unregister();
});

const bundle: Architecture = {
  model: {
    views: [
      { scope: '', title: 'Landscape', mermaid: 'flowchart LR\n  shop["Shop"]', table: { columns: ['#', 'From', 'To', 'Relations'], rows: [['1', 'shop', 'payments', 'sells']] }, opens: ['shop'] },
      { scope: 'shop', title: 'Shop', mermaid: 'flowchart LR\n  subgraph shop ["Shop"]\n  end', table: { columns: [], rows: [] }, opens: [], up: '' },
    ],
    elements: [
      {
        id: 'shop',
        name: 'Shop',
        kind: 'domain',
        ancestors: [],
        outgoing: [{ relationId: 'sells', other: 'payments', name: 'sells' }],
        incoming: [],
        provides: [],
        namedBy: ['docs/vision.md'],
      },
      {
        id: 'payments',
        name: 'Payments',
        kind: 'domain',
        ancestors: [],
        outgoing: [],
        incoming: [{ relationId: 'sells', other: 'shop', name: 'sells', interface: 'http::GET::/pay', action: 'send' }],
        provides: ['http::GET::/pay'],
        namedBy: [],
      },
    ],
  },
  notes: [],
  errors: [],
  warnings: [],
  sources: ['model'],
};

const broken: Architecture = {
  notes: [],
  errors: [{ file: 'model/bad.yaml', line: 5, path: 'elements[0].kind', message: '"servic" is not a known "kind"' }],
  warnings: [],
  sources: ['model'],
};

let rendered: { root: Root; container: HTMLElement } | undefined;

function into(element: ReturnType<typeof createElement>): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  rendered = { root, container };
  root.render(element);
  return container;
}

afterEach(() => {
  rendered?.root.unmount();
  rendered?.container.remove();
  rendered = undefined;
});

const text = (): string => document.body.textContent ?? '';

describe('the Architecture index', () => {
  test('lists the views and the elements with their kinds and counts', async () => {
    into(createElement(ArchitectureIndex, { bundle }));
    for (let i = 0; i < 200 && document.querySelectorAll('.arch-views a').length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(document.querySelectorAll('.arch-views a')).toHaveLength(2);
    expect(document.querySelectorAll('[data-testid="arch-elements-table"] tbody tr')).toHaveLength(2);
    expect(text()).toContain('domain');
  });

  test('a model that does not compile shows its errors, each with file, line and path, in place of the section', async () => {
    into(createElement(ArchitectureIndex, { bundle: broken }));
    for (let i = 0; i < 200 && document.querySelector('[data-testid="model-errors"]') === null; i++) await new Promise((r) => setTimeout(r, 10));
    const block = document.querySelector('[data-testid="model-errors"]');
    expect(block).not.toBeNull();
    expect(block?.textContent).toContain('model/bad.yaml:5');
    expect(block?.textContent).toContain('elements[0].kind');
    expect(block?.textContent).toContain('"servic" is not a known "kind"');
  });
});

describe('a view page', () => {
  test('draws the Mermaid diagram, names the LikeC4 view, and links up and drill-down', async () => {
    into(createElement(ViewPage, { bundle, scope: 'shop' }));
    for (let i = 0; i < 200 && document.querySelector('likec4-view') === null; i++) await new Promise((r) => setTimeout(r, 10));
    expect(document.querySelector('[data-testid="mermaid-diagram"]')).not.toBeNull();
    expect(document.querySelector('likec4-view')?.getAttribute('view-id')).toBe('shop');
    const up = [...document.querySelectorAll('.arch-links a')].map((a) => a.getAttribute('href'));
    expect(up).toContain('/p/madarch/view/_landscape');
  });

  test('the landscape view addresses itself as _landscape and shows the drill-down to shop', async () => {
    into(createElement(ViewPage, { bundle, scope: '' }));
    for (let i = 0; i < 200 && document.querySelector('likec4-view') === null; i++) await new Promise((r) => setTimeout(r, 10));
    expect(document.querySelector('likec4-view')?.getAttribute('view-id')).toBe('index');
    const hrefs = [...document.querySelectorAll('.arch-links a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/p/madarch/view/shop');
  });
});

describe('an element page', () => {
  test('shows the kind, the relations in and out with their other ends, the interfaces and the pages naming it', async () => {
    into(createElement(ElementPage, { bundle, id: 'payments' }));
    for (let i = 0; i < 200 && document.querySelectorAll('[data-testid="element-incoming"] tbody tr').length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(document.querySelectorAll('[data-testid="element-incoming"] tbody tr')).toHaveLength(1);
    expect(document.querySelectorAll('[data-testid="element-outgoing"] tbody tr')).toHaveLength(1);
    expect(text()).toContain('http::GET::/pay');
    expect(text()).toContain('send');
  });

  test('the pages that name the element are listed as links', async () => {
    into(createElement(ElementPage, { bundle: { ...bundle, model: { ...bundle.model!, elements: [bundle.model!.elements[0]!] } }, id: 'shop' }));
    for (let i = 0; i < 200 && !text().includes('docs/vision.md'); i++) await new Promise((r) => setTimeout(r, 10));
    expect(text()).toContain('docs/vision.md');
  });

  test('an unknown element id says so, never an empty page', async () => {
    into(createElement(ElementPage, { bundle, id: 'nope' }));
    for (let i = 0; i < 200 && !text().includes('no element with this id'); i++) await new Promise((r) => setTimeout(r, 10));
    expect(text()).toContain('The model holds no element with this id.');
  });
});

describe('the document-to-element links', () => {
  test('the first standalone mention of an element id is wrapped; fences, code spans and link targets are not', () => {
    const links = new Map([['shop', '/p/madarch/element/shop']]);
    const linked = linkElements('The shop serves.\n\n```\nshop stays\n```\n\nSee [x](shop) and `shop` and shop again.', links);
    expect(linked).toContain('[shop](/p/madarch/element/shop)');
    expect(linked).not.toContain('](/p/madarch/element/shop)\n');
    expect(linked).toContain('[x](shop)');
    expect(linked).toContain('`shop`');
    expect((linked.match(/\/p\/madarch\/element\/shop/g) ?? []).length).toBe(1);
  });

  test('the same conservative rule as the server: hyphen is part of a word, code spans and fences never wrap', () => {
    const links = new Map([['shop', '/p/madarch/element/shop']]);
    expect(linkElements('the not-shop serves.', links)).not.toContain('[shop]');
    expect(linkElements('the shop-item serves.', links)).not.toContain('[shop]');
    expect(linkElements('the shop, however, serves.', links)).toContain('[shop](/p/madarch/element/shop)');
    expect(linkElements('see `shop` and [x](shop) here.', links)).not.toContain('[shop](/p/madarch/element/shop)');
    expect(linkElements('a.b stands alone.', new Map([['b', '/p/madarch/element/b']]))).not.toContain('[b]');
  });

  test('a link to an element page opens it as the app\'s own address', async () => {
    into(createElement(Markdown, { text: 'The [shop](/p/madarch/element/shop) serves.' }));
    for (let i = 0; i < 200 && document.querySelector('.reading a') === null; i++) await new Promise((r) => setTimeout(r, 10));
    expect(document.querySelector('.reading a')?.getAttribute('href')).toBe('/p/madarch/element/shop');
  });
});
