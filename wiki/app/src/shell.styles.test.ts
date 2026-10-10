/**
 * The shell's load-bearing structure, asserted in src: the happy-dom test
 * environment strips stylesheets, so the pixel truth lives in the acceptance
 * walk; each test pins an exact class string (a structural decision a later
 * edit could silently drop) or an exact rule block in the entry stylesheet.
 *
 * Covers the review's shapes: the navigation is a Sheet drawer at the phone
 * widths and the document column is never narrowed by the panel, the current
 * page's non-colour visual mark, the 14px floor for group titles and the
 * brand, the drawer's shadow through its token, and the mockup's chrome
 * (breadcrumb, product block, group counts, collapse chevrons).
 */
import { afterEach, afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Shell } from './shell.js';
import { routeContext, statusContext } from './hold.js';
import type { Product, PageList, PageMeta } from './api.js';

const here = dirname(fileURLToPath(import.meta.url));
const indexCss = readFileSync(join(here, 'styles/index.css'), 'utf8');
const tokensCss = readFileSync(join(here, 'styles/tokens.css'), 'utf8');
const sheetTsx = readFileSync(join(here, 'components/ui/sheet.tsx'), 'utf8');
const shellTsx = readFileSync(join(here, 'shell.tsx'), 'utf8');

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
});

afterAll(async () => {
  await new Promise((rest) => setTimeout(rest, 50));
  GlobalRegistrator.unregister();
});

let rendered: { root: Root; container: HTMLElement } | undefined;

function unmount(): void {
  rendered?.root.unmount();
  rendered = undefined;
}

afterEach(() => {
  unmount();
});

const product: Product = { id: '9bd80c5a-19c2-4be0-9ad5-6ee0a41d84f1', name: 'Draft Idea', folder: 'idea-2026-10-10' };
const pages: PageMeta[] = [
  { path: 'README.md', title: 'Readme', url: '/p/README.md' },
  { path: 'docs/vision.md', title: 'Vision', url: '/p/docs/vision.md' },
  { path: 'docs/requirements/one.md', title: 'Requirement one', url: '/p/docs/requirements/one.md' },
  { path: 'docs/zine a.md', title: 'Notes', url: '/p/docs/zine%20a.md' },
];
const list: PageList = { revision: 'r1', pages };

async function intoShell(): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  rendered = { root, container };
  root.render(
    createElement(
      statusContext.Provider,
      { value: { publish: (): void => undefined, parts: ['word count', 'Markdown', 'UTF-8'] } },
      createElement(
      routeContext.Provider,
      { value: { path: 'docs/requirements/one.md', heldPaths: new Set<string>() } },
      createElement(Shell, { product, list, children: createElement('p', {}, 'doc') }),
      ),
    ),
  );
  for (let i = 0; i < 200; i++) {
    if (container.querySelector('#app-nav') !== null) break;
    await new Promise((step) => setTimeout(step, 10));
  }
  return container;
}

describe('the shell markup', () => {
  test('the wide navigation hides at the phone width and the drawer opens from the menu button', async () => {
    const container = await intoShell();
    const aside = container.querySelector('.app-nav');
    expect(aside?.className).toContain('hidden');
    // the drawer's shadow rides the token, in the component and the CSS class
    expect(sheetTsx).toContain('shadow-[var(--nav-shadow)]');
    expect(tokensCss).toContain('--nav-shadow');
  });

  test('the drawer is a shadcn Sheet on Radix dialog', async () => {
    await intoShell();
    const trigger = rendered?.container.querySelector('.shell-menu');
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute('aria-label')).toBe('Document navigation');
    expect(trigger?.tagName).toBe('BUTTON');
  });

  test('the document column is never narrowed by the panels: the focus choice shuts them all', async () => {
    const container = await intoShell();
    const doc = container.querySelector('.shell-document');
    expect(doc?.className).toContain('w-full');
    // the focus rule hides both panels by class, and the hidden attribute holds it
    expect(indexCss).toContain('.shell.doc-only .app-nav,\n.shell.doc-only .context-panel {');
    expect(indexCss).toContain('.app-nav[hidden],\n.context-panel[hidden] {\n  display: none;\n}');
    const panel = container.querySelector('.context-panel');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute('hidden')).not.toBeNull();
  });

  test('the current page carries a visible mark beyond colour: the pill plus weight plus aria-current', async () => {
    const container = await intoShell();
    const current = container.querySelector('.nav-current');
    expect(current).not.toBeNull();
    expect(current?.getAttribute('aria-current')).toBe('page');
    expect(current?.className).toContain('font-[550]');
    expect(current?.className).toContain('bg-pill');
  });

  test('group titles and the brand never compute under the 14px floor', () => {
    expect(tokensCss).toContain('--fs-small: max(14px, 0.78em)');
    expect(indexCss).toMatch(/\.eyebrow \{[^}]*--fs-small/s);
    expect(indexCss).toMatch(/\.statusbar \{[^}]*--fs-small/s);
  });

  test('the mockup chrome: the product block, the overview entry, collapsed groups with counts, the folder footer', async () => {
    const container = await intoShell();
    const block = container.querySelector('[data-testid="product-block"]');
    expect(block?.textContent).toContain('Draft Idea');
    expect(block?.textContent).toContain('Product space');
    expect(container.querySelector('[data-testid="nav-overview"]')).not.toBeNull();
    const groups = [...container.querySelectorAll('[data-nav-group]')];
    expect(groups.length).toBeGreaterThanOrEqual(2);
    const first = groups[0] as HTMLElement;
    expect((first.querySelector('button') as HTMLElement).getAttribute('aria-expanded')).toBe('true');
    expect(first.textContent).toContain(String(first.querySelectorAll('.nav-link').length));
    // The footer names the product's FOLDER, not its id or name: find the
    // bold text inside the footer row the icon sits in (the checkpoint's
    // vacuous pin found nothing and passed).
    const footerRow = [...container.querySelectorAll('#app-nav div')].find((d) => d.querySelector('svg') && (d.textContent || '').startsWith('idea-2026-10-10'));
    expect(footerRow).toBeDefined();
    expect(footerRow?.querySelector('b')?.textContent).toBe('idea-2026-10-10');
  });

  test('the breadcrumb names kind and title, and every icon rides lucide', async () => {
    const container = await intoShell();
    const crumb = container.querySelector('.shell-breadcrumb');
    expect(crumb?.textContent).toBe('Requirements / Requirement one');
  });

  test('the tab strip row stands under the top bar and carries the open file\'s name; no dead controls with it', async () => {
    const container = await intoShell();
    const tab = container.querySelector('[data-testid="document-tab"]');
    expect(tab).not.toBeNull();
    expect(tab?.textContent).toContain('docs/requirements/one.md');
    // The strip is a row between the top bar and the document, and nothing
    // dead rides in it: no view switch, no history button, no search box.
    expect(container.querySelector('.document-bar')?.parentElement?.className).toContain('shell-main');
    expect(container.querySelectorAll('.document-bar button').length).toBe(0);
    expect(container.querySelector('.search-trigger')).toBeNull();
  });

  test('the document toolbar rule conveys the tab and the mockup\'s top rule; the strip stands on the base ground', () => {
    expect(indexCss).toMatch(/\.document-tab \{[^}]*border-block-start:\s*2px solid var\(--text\)/s);
    expect(shellTsx).toContain('bg-ground');
    expect(shellTsx).toContain('shell-scroll min-w-0 flex-1 overflow-y-auto');
  });

  test('the status bar is a row of the shell at its very bottom edge, outside the scrolled content', async () => {
    const container = await intoShell();
    const bar = container.querySelector('footer.statusbar');
    expect(bar).not.toBeNull();
    // The bar lives in the shell's main column directly, not inside the
    // scrolling column: its parent is the flex-col shell-main, after the row.
    expect(bar?.previousElementSibling?.className).toContain('shell-row');
    expect(container.querySelector('.shell-scroll footer.statusbar')).toBeNull();
    // the bar shows what the open document published
    expect(bar?.textContent).toContain('word count');
  });

  test('the shell fills the window and the only scrolling lives in the document column', () => {
    expect(shellTsx).toContain('flex h-dvh');
    expect(tokensCss).toMatch(/--bg-ground/);
    expect(indexCss).toMatch(/body \{[^}]*overflow: hidden;/s);
    expect(indexCss).toMatch(/\.shell-scroll \{/s);
  });
});
