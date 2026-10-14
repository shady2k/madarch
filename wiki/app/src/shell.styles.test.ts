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
import { setWikiLanguage } from './i18n.js';
import { routeContext, type RouteData } from './hold.js';
import type { Product, ProductWithAudience, PageList, PageMeta, RegistryOffer } from './api.js';

const here = dirname(fileURLToPath(import.meta.url));
const indexCss = readFileSync(join(here, 'styles/index.css'), 'utf8');
const tokensCss = readFileSync(join(here, 'styles/tokens.css'), 'utf8');
const sheetTsx = readFileSync(join(here, 'components/ui/sheet.tsx'), 'utf8');
const shellTsx = readFileSync(join(here, 'shell.tsx'), 'utf8');

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  await setWikiLanguage('en');
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

describe('the product API shape', () => {
  test('a manifestless product can omit its id and optional audience', () => {
    const product: ProductWithAudience = { name: 'Empty Home', folder: 'empty-home' };
    expect(product.id).toBeUndefined();
    expect(product.folder).toBe('empty-home');
    expect(product.audience).toBeUndefined();
  });
});

async function intoShell(
  route: RouteData = { path: 'docs/requirements/one.md', heldPaths: new Set<string>() },
  offer: RegistryOffer | null = null,
): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  rendered = { root, container };
  root.render(
    createElement(
      routeContext.Provider,
      { value: route },
      createElement(Shell, { product, list, children: createElement('main', {}, createElement('h1', {}, 'Requirement one')), offer }),
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
    expect(aside?.className).toContain('w-[240px] wide:w-[260px]');
    // the drawer's shadow rides the token, in the component and the CSS class
    expect(sheetTsx).toContain('shadow-[var(--nav-shadow)]');
    expect(tokensCss).toContain('--nav-shadow');
  });

  test('the language choice is a translated globe menu beside the toolbar controls', async () => {
    const container = await intoShell();
    const globe = container.querySelector('.shell-language');
    expect(globe?.getAttribute('aria-label')).toBe('Language');
    expect(globe?.getAttribute('title')).toBe('Choose language');
    expect(globe?.getAttribute('aria-haspopup')).toBe('menu');
    expect(shellTsx).toContain('<DropdownMenu.RadioGroup');
    expect(shellTsx).toContain('value={language}');
    expect(shellTsx).toContain('onValueChange=');
    expect(shellTsx).toContain('value="ru"');
    expect(shellTsx).toContain('value="en"');
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
    expect(current?.className).toContain('bg-[var(--surface-active)]');
  });

  test('group titles and the brand never compute under the 14px floor', () => {
    expect(tokensCss).toContain('--fs-small: max(14px, 0.78em)');
    expect(indexCss).toMatch(/\.eyebrow \{[^}]*--fs-small/s);
  });

  test('the mockup chrome: the product block, the overview entry, collapsed groups with counts, the folder footer', async () => {
    const container = await intoShell();
    const block = container.querySelector('[data-testid="product-block"]');
    expect(block?.textContent).toContain('Draft Idea');
    expect(block?.textContent).toContain('Product space');
    expect(block?.textContent).not.toContain('the demo files live under docs/');
    expect(block?.querySelector('span.grid')?.className).toContain('size-[40px]');
    const overview = container.querySelector('[data-testid="nav-overview"]');
    expect(overview).not.toBeNull();
    expect(overview?.textContent).toContain('Product overview');
    expect(overview?.querySelector('svg')).not.toBeNull();
    expect(overview?.querySelectorAll('svg').length).toBe(1);
    const documentsHeading = [...container.querySelectorAll('#app-nav h2')].find((heading) => heading.textContent === 'Documents');
    expect(documentsHeading?.className).toContain('uppercase');
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

  test('the breadcrumb keeps product and group context without repeating the document title', async () => {
    const container = await intoShell();
    const crumb = container.querySelector('.shell-breadcrumb');
    expect(crumb?.textContent).toBe('Product / Requirements');
    expect(crumb?.querySelector('[data-testid="breadcrumb-group"]')?.textContent).toBe('Requirements');
    expect(crumb?.textContent).not.toContain('Requirement one');
    expect(container.querySelector('main h1')?.textContent).toBe('Requirement one');
  });

  test('the registered stage label is localized in the navigator and breadcrumb', async () => {
    await setWikiLanguage('ru');
    try {
      const offer: RegistryOffer = {
        present: true,
        stages: [{ id: 'idea', name: 'Idea', labels: { en: 'English idea', ru: 'Русская идея' } }],
        kinds: [],
      };
      const container = await intoShell({ stage: 'idea', heldPaths: new Set<string>() }, offer);
      expect(container.querySelector('[data-stage-link="idea"]')?.textContent).toBe('Русская идея');
      expect(container.querySelector('.shell-breadcrumb .text-ink')?.textContent).toBe('Русская идея');
      expect(container.querySelector('[data-testid="document-tab"]')).toBeNull();
    } finally {
      await setWikiLanguage('en');
    }
  });

  test('stage shell surfaces fall back to the manifest name, not the other locale', async () => {
    await setWikiLanguage('ru');
    try {
      const offer: RegistryOffer = {
        present: true,
        stages: [{ id: 'idea', name: 'Canonical idea' }],
        kinds: [],
      };
      const container = await intoShell({ stage: 'idea', heldPaths: new Set<string>() }, offer);
      expect(container.querySelector('[data-stage-link="idea"]')?.textContent).toBe('Canonical idea');
      expect(container.querySelector('.shell-breadcrumb .text-ink')?.textContent).toBe('Canonical idea');
      expect(container.querySelector('[data-testid="document-tab"]')).toBeNull();
    } finally {
      await setWikiLanguage('en');
    }
  });

  test('dead reader chrome is absent and the toolbar does not repeat the document heading', async () => {
    const container = await intoShell();
    expect(container.querySelector('.document-bar, [data-testid="document-tab"]')).toBeNull();
    expect(container.querySelector('footer.statusbar, [data-testid="connection-status"]')).toBeNull();
    const heading = container.querySelector('main h1')?.textContent;
    expect(heading).toBe('Requirement one');
    expect(container.querySelector('.shell-toolbar')?.textContent).not.toContain(heading);
    const productBlock = container.querySelector('[data-testid="product-block"]');
    expect(productBlock?.querySelector('button, a, [aria-haspopup], [aria-expanded], svg')).toBeNull();
    expect(productBlock?.textContent).not.toMatch(/[▼▽∨]/u);
    expect(container.querySelector('.shell-scroll')?.className).toContain('overflow-y-auto');
  });

  test('the sidebar navigation scrolls between its fixed heading and footer', async () => {
    const container = await intoShell();
    const aside = container.querySelector('#app-nav');
    const nav = aside?.querySelector('nav');
    expect(aside?.className).toContain('flex-col');
    expect(nav?.className).toContain('min-h-0 flex-1 overflow-y-auto');
    expect(nav?.previousElementSibling?.textContent).toContain('Documents');
    expect(nav?.nextElementSibling?.textContent).toContain('idea-2026-10-10');
    expect(nav?.nextElementSibling?.textContent).toContain('Served locally');
    expect(nav?.nextElementSibling?.className).toContain('border-t');
  });

  test('the shell fills the window and the only scrolling lives in the document column', () => {
    expect(shellTsx).toContain('flex h-dvh');
    expect(tokensCss).toMatch(/--bg-ground/);
    expect(indexCss).toMatch(/body \{[^}]*overflow: hidden;/s);
    expect(indexCss).toMatch(/\.shell-scroll \{/s);
  });
});
