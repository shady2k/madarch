/**
 * Who the wiki is for, in the app (decision 0031), tested without a server: what
 * a role opens on a page and puts first in the navigation, the exact-match links
 * from the text to the glossary, the glossary page and a term's block, the card
 * that asks the role once (and its skip), the role in the top bar and the «?»
 * that opens madarch's own documentation. Every request is answered by a stub
 * giving the server's own shapes.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setWikiLanguage } from '../i18n.js';
import { KMarkdown } from './blocks.js';
import { GlossaryContext, GlossaryPage, TermBlockView, filterTerms, termIndex } from './glossary.js';
import { EntityPage } from './pages.js';
import { HelpLink, RoleCard, RoleMenu } from './role-ui.js';
import { RoleContext, blockOpen, chooseRole, leadGroups, loadSettings, resetSettings } from './roles.js';
import type { Glossary, GlossaryTerm, PageModel } from './types.js';

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
  throw new Error(`never came to ${what}; the tree holds: ${document.body.innerHTML.slice(0, 2000)}`);
}
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = '';
  delete (globalThis as { fetch?: unknown }).fetch;
  resetSettings();
});

const term = (title: string, extra: Partial<GlossaryTerm> = {}): GlossaryTerm => ({
  id: `doc:docs/glossary.md#${title.toLowerCase().replace(/\s+/g, '-')}`, title, definition: `${title} means a thing.`, synonyms: [], code: [], usedIn: null, ambiguous: null,
  repo: null, path: 'docs/glossary.md', line: 3, endLine: 4, anchor: title.toLowerCase().replace(/\s+/g, '-'), single: false, href: `/k/e/doc%3Adocs%2Fglossary.md%23${title.toLowerCase().replace(/\s+/g, '-')}`, ...extra,
});

describe('what a role opens', () => {
  const roles = { developer: { open: ['source', 'callers'], lead: ['code', 'tests'] }, product: { lead: ['product'] } };

  test('a role with a list opens those blocks and the page\'s own text; the others stay, collapsed; "everything" and a role with no list open all', () => {
    expect(blockOpen({ type: 'source' }, 'developer', roles)).toBe(true);
    expect(blockOpen({ type: 'related' }, 'developer', roles)).toBe(false);
    expect(blockOpen({ type: 'body' }, 'developer', roles)).toBe(true);
    expect(blockOpen({ type: 'markdown' }, 'developer', roles)).toBe(true);
    expect(blockOpen({ type: 'term' }, 'developer', roles)).toBe(true);
    expect(blockOpen({ type: 'related' }, 'everything', roles)).toBe(true);
    expect(blockOpen({ type: 'related' }, 'product', roles)).toBe(true);
    expect(blockOpen({ type: 'related' }, 'tester', roles)).toBe(true);
    // The manifest names the template's block: two of them draw as refs, and each opens by its own name.
    const refs = { developer: { open: ['implementedby'], lead: [] } };
    expect(blockOpen({ type: 'refs', name: 'implementedby' }, 'developer', refs)).toBe(true);
    expect(blockOpen({ type: 'refs', name: 'linkedfrom' }, 'developer', refs)).toBe(false);
  });

  test('the groups the role leads come first in its order and the rest keep the manifest\'s order; no role changes nothing', () => {
    const groups = [{ group: 'product' }, { group: 'code' }, { group: 'data' }, { group: 'tests' }, { group: null }];
    expect(leadGroups(groups, 'developer', roles).map((entry) => entry.group)).toEqual(['code', 'tests', 'product', 'data', null]);
    expect(leadGroups(groups, 'everything', roles).map((entry) => entry.group)).toEqual(['product', 'code', 'data', 'tests', null]);
    expect(leadGroups(groups, 'tester', roles).map((entry) => entry.group)).toEqual(['product', 'code', 'data', 'tests', null]);
  });

  test('one page under two roles holds the same blocks: the source is open for the developer and collapsed under its title for the product role', async () => {
    const page: PageModel = {
      id: 'code.symbol:a.ts#f', kind: 'code.symbol', title: 'f', trail: [], resolutions: {}, findings: [], notes: [],
      blocks: [
        { type: 'markdown', markdown: 'A function.' },
        { type: 'source', title: 'Source', location: { repo: 'shop', path: 'a.ts', lineStart: 1, lineEnd: 2, href: '/k/src?path=a.ts' }, language: 'typescript', text: 'export function f() {}', truncated: false },
        { type: 'related', title: 'Relations', groups: [] },
      ],
    };
    (globalThis as { fetch?: unknown }).fetch = async () => Response.json(page);
    const opened = (role: string): { blocks: string[]; collapsed: string[] } => ({
      blocks: [...document.querySelectorAll('[data-block-type], section, [data-testid=source-code]')].map((node) => node.getAttribute('data-block-type') ?? node.getAttribute('data-testid') ?? 'section'),
      collapsed: [...document.querySelectorAll('[data-testid=block-collapsed]')].map((node) => `${node.getAttribute('data-block-type')}:${node.querySelector('summary')!.textContent}`),
    });
    const declared = { developer: { open: ['source'], lead: [] }, product: { open: ['related'], lead: [] } };
    let container = into(createElement(RoleContext.Provider, { value: { role: 'developer', roles: declared } }, createElement(EntityPage, { id: page.id, version: 1 })));
    await until(() => container.querySelector('[data-testid=entity-page]') !== null, 'the page as a developer');
    expect(container.querySelector('[data-testid=source-code]')).not.toBeNull();
    expect(container.querySelector('details[data-block-type=source]')).toBeNull();
    expect(opened('developer').collapsed).toEqual(['related:Relations']);
    rendered?.unmount();
    document.body.innerHTML = '';
    container = into(createElement(RoleContext.Provider, { value: { role: 'product', roles: declared } }, createElement(EntityPage, { id: page.id, version: 1 })));
    await until(() => container.querySelector('[data-testid=entity-page]') !== null, 'the page as the product role');
    // The same blocks are on the page; the source is under its title, collapsed, and one click opens it.
    const source = container.querySelector('details[data-block-type=source]') as HTMLDetailsElement;
    expect(source.querySelector('summary')!.textContent).toBe('Source');
    expect(source.open).toBe(false);
    expect(source.querySelector('[data-testid=source-code]')).not.toBeNull();
    expect(container.querySelector('details[data-block-type=related]')).toBeNull();
  });

  test('a page with problems carries a badge that opens the Problems page, and a page with none carries none', async () => {
    const base: PageModel = { id: 'domain:orders', kind: 'domain', title: 'Orders', trail: [], resolutions: {}, findings: [], notes: [], blocks: [{ type: 'markdown', markdown: 'Orders.' }] };
    (globalThis as { fetch?: unknown }).fetch = async () => Response.json({ ...base, problems: 3 });
    const container = into(createElement(EntityPage, { id: base.id, version: 1 }));
    await until(() => container.querySelector('[data-testid=entity-page]') !== null, 'the page with problems');
    const badge = container.querySelector('[data-testid=page-problems]')!;
    expect(badge.textContent).toBe('3 problems');
    expect(badge.querySelector('a')!.getAttribute('href')).toBe('/k/problems');
    rendered?.unmount();
    document.body.innerHTML = '';
    (globalThis as { fetch?: unknown }).fetch = async () => Response.json(base);
    const clean = into(createElement(EntityPage, { id: base.id, version: 1 }));
    await until(() => clean.querySelector('[data-testid=entity-page]') !== null, 'the page without problems');
    expect(clean.querySelector('[data-testid=page-problems]')).toBeNull();
  });
});

describe('the links from the text to the glossary', () => {
  const terms = [term('Manifest', { synonyms: ['manifests', 'kinds file'] }), term('Capture'), term('Payment token'), term('Card token')];
  const wrap = (text: string) => createElement(GlossaryContext.Provider, { value: { index: termIndex(terms), terms } }, createElement(KMarkdown, { text, resolutions: {} }));
  const linked = (container: HTMLElement): string[] => [...container.querySelectorAll('a.term-link')].map((anchor) => `${anchor.textContent}>${anchor.getAttribute('href')}`);

  test('a term, whole and in the same case, is a link to its entry; a word that only resembles one is not', async () => {
    const container = into(wrap('The Manifest names kinds. A manifestation is not one. Capture happens later.'));
    await until(() => container.querySelector('a.term-link') !== null, 'the term links');
    expect(linked(container)).toEqual([`Manifest>${terms[0]!.href}`, `Capture>${terms[1]!.href}`]);
  });

  test('a synonym links to the same entry, once per paragraph with its term', async () => {
    const container = into(wrap('The manifests of a product are read.\n\nThe Manifest and the kinds file are one thing, the manifests too.'));
    await until(() => container.querySelector('a.term-link') !== null, 'the term links');
    expect(linked(container)).toEqual([`manifests>${terms[0]!.href}`, `Manifest>${terms[0]!.href}`]);
  });

  test('only the first use of a term in a paragraph is linked, and code, links and headings are left alone', async () => {
    const container = into(wrap('# Manifest\n\nThe Manifest and the Manifest again; `Manifest` in code and [Manifest](https://example.test) as a link.\n\nA second paragraph: Manifest.'));
    await until(() => container.querySelector('a.term-link') !== null, 'the term links');
    expect(linked(container)).toEqual([`Manifest>${terms[0]!.href}`, `Manifest>${terms[0]!.href}`]);
    expect(container.querySelector('h1 a')).toBeNull();
  });

  test('the case must be the same: "capture" is not "Capture"', async () => {
    const container = into(wrap('We capture the payment. Then Capture is done.'));
    await until(() => container.querySelector('a.term-link') !== null, 'the term links');
    expect(linked(container)).toEqual([`Capture>${terms[1]!.href}`]);
  });

  test('a name two terms both claim is linked to neither, and a term never links to its own entry', async () => {
    const twins = [term('One', { synonyms: ['thing'] }), term('Two', { synonyms: ['thing'] })];
    const container = into(createElement(GlossaryContext.Provider, { value: { index: termIndex(twins), terms: twins } }, createElement(KMarkdown, { text: 'The thing is One and Two.', resolutions: {}, exceptTerm: twins[0]!.id })));
    await until(() => container.querySelector('.reading') !== null, 'the text');
    expect(linked(container)).toEqual([`Two>${twins[1]!.href}`]);
  });

  test('whole words are judged across formatting: a bold run inside a word is no match', async () => {
    const container = into(wrap('pre**Manifest** and post**Capture**x but **Manifest** alone.'));
    await until(() => container.querySelector('.reading') !== null, 'the text');
    await new Promise((rest) => setTimeout(rest, 30));
    expect(linked(container)).toEqual([`Manifest>${terms[0]!.href}`]);
    expect(container.querySelector('a.term-link strong, strong a.term-link')?.textContent).toBe('Manifest');
  });

  test('a document read in the wiki links its terms too', async () => {
    const container = into(createElement(GlossaryContext.Provider, { value: { index: termIndex(terms), terms } }, createElement(KMarkdown, { text: 'The Manifest is described here.', resolutions: {}, inDocument: { repo: null, path: 'docs/x.md' } })));
    await until(() => container.querySelector('a.term-link') !== null, 'the term link');
    expect(linked(container)).toEqual([`Manifest>${terms[0]!.href}`]);
  });

  test('words of other scripts are matched whole too', async () => {
    const russian = [term('Манифест', { synonyms: ['манифеста'] })];
    const container = into(createElement(GlossaryContext.Provider, { value: { index: termIndex(russian), terms: russian } }, createElement(KMarkdown, { text: 'Файл манифеста лежит рядом; манифестация — другое слово.', resolutions: {} })));
    await until(() => container.querySelector('a.term-link') !== null, 'the term link');
    expect(linked(container).map((entry) => decodeURIComponent(entry))).toEqual([decodeURIComponent(`манифеста>${russian[0]!.href}`)]);
  });
});

describe('the glossary page and a term\'s block', () => {
  const glossary: Glossary = {
    terms: [
      term('Manifest', { definition: 'The file that lists the kinds.', synonyms: ['manifests'], code: ['madarch/kinds.yaml'], usedIn: '[the reference](madarch:doc:docs/reference.md#manifest)', source: { original: 'The glossary defines the manifest as the file listing kinds.', document: 'docs/glossary.md', line: 3, endLine: 4 } }),
      term('Payment token', { definition: 'The proof a provider returns.', ambiguous: 'also the vault reference; see [the question](madarch:doc:docs/reference.md#question)', line: 7 }),
    ],
    resolutions: {
      'madarch:doc:docs/reference.md#manifest': { state: 'ok', target: 'madarch:doc:docs/reference.md#manifest', kind: 'document', label: 'docs/reference.md#manifest', href: '/k/doc?path=docs%2Freference.md#manifest' },
      'madarch:doc:docs/reference.md#question': { state: 'ok', target: 'madarch:doc:docs/reference.md#question', kind: 'document', label: 'docs/reference.md#question', href: '/k/doc?path=docs%2Freference.md#question' },
    },
    findings: [],
  };

  test('every term is listed with its definition, names, the document and line it is stated at; the ambiguous one is marked and links to its question', async () => {
    (globalThis as { fetch?: unknown }).fetch = async () => Response.json(glossary);
    const container = into(createElement(GlossaryPage, { version: 1 }));
    await until(() => container.querySelector('[data-testid=glossary-term]') !== null, 'the terms');
    const items = [...container.querySelectorAll('[data-testid=glossary-term]')];
    expect(items.map((item) => item.getAttribute('data-term'))).toEqual(['Manifest', 'Payment token']);
    expect(items[0]!.textContent).toContain('The file that lists the kinds.');
    expect(items[0]!.querySelector('[data-testid=term-names]')!.textContent).toContain('madarch/kinds.yaml');
    expect(items[0]!.querySelector('[data-testid=term-ground]')!.textContent).toContain('docs/glossary.md:3');
    const source = items[0]!.querySelector('details[data-testid=localized-source]') as HTMLDetailsElement;
    expect(source.open).toBe(false);
    expect(source.querySelector('summary')!.textContent).toBe('In the source');
    expect(source.textContent).toContain('The glossary defines the manifest as the file listing kinds.');
    // The place stands once in the row, in the ground; the original opens without repeating it.
    expect(source.textContent).not.toContain('docs/glossary.md:3–4');
    expect(items[0]!.textContent!.split('docs/glossary.md:3').length - 1).toBe(1);
    expect(items[0]!.getAttribute('data-ambiguous')).toBe('false');
    expect(items[0]!.querySelector('[data-testid=term-ambiguous-badge]')).toBeNull();
    expect(items[1]!.getAttribute('data-ambiguous')).toBe('true');
    expect(items[1]!.querySelector('[data-testid=term-ambiguous-badge]')!.textContent).toBe('Ambiguous');
    expect(items[1]!.querySelector('[data-testid=term-ambiguous] a')!.getAttribute('href')).toBe('/k/doc?path=docs%2Freference.md#question');
    expect(items[1]!.querySelector('[data-testid=term-ground]')!.textContent).toContain('docs/glossary.md:7');
  });

  test('the filter narrows by a name, a synonym or a code name, in any case', () => {
    expect(filterTerms(glossary.terms, 'kinds.YAML').map((entry) => entry.title)).toEqual(['Manifest']);
    expect(filterTerms(glossary.terms, 'MANIFESTS').map((entry) => entry.title)).toEqual(['Manifest']);
    expect(filterTerms(glossary.terms, 'token').map((entry) => entry.title)).toEqual(['Payment token']);
    expect(filterTerms(glossary.terms, '  ').map((entry) => entry.title)).toEqual(['Manifest', 'Payment token']);
    expect(filterTerms(glossary.terms, 'nothing like it')).toEqual([]);
  });

  test('the findings that explain a missing term are on the page with their file and line', async () => {
    (globalThis as { fetch?: unknown }).fetch = async () => Response.json({ ...glossary, findings: [{ file: 'docs/glossary.md', line: 12, message: 'Manifest opens a second section of this document' }] });
    const container = into(createElement(GlossaryPage, { version: 1 }));
    await until(() => container.querySelector('[data-testid=findings]') !== null, 'the findings');
    container.querySelector<HTMLElement>('[data-testid=findings-details]')!.click();
    await until(() => container.querySelector('[data-testid=findings] li') !== null, 'the details');
    expect(container.querySelector('[data-testid=findings] li')!.textContent).toContain('docs/glossary.md:12');
  });

  test('a product with no glossary says what a glossary is; a read that fails shows its reason', async () => {
    (globalThis as { fetch?: unknown }).fetch = async () => Response.json({ terms: [], resolutions: {}, findings: [] });
    let container = into(createElement(GlossaryPage, { version: 1 }));
    await until(() => container.querySelector('[data-testid=glossary-empty]') !== null, 'the empty note');
    rendered?.unmount();
    document.body.innerHTML = '';
    (globalThis as { fetch?: unknown }).fetch = async () => Response.json({ message: 'the glossary is broken at docs/glossary.md:3' }, { status: 500 });
    container = into(createElement(GlossaryPage, { version: 2 }));
    await until(() => container.querySelector('[data-testid=glossary-error]') !== null, 'the error');
    expect(container.querySelector('[data-testid=glossary-error]')!.textContent).toContain('docs/glossary.md:3');
  });

  test('a term\'s block shows the definition, the names, the ambiguity and where it is used', async () => {
    const container = into(createElement(TermBlockView, { pageId: 'doc:docs/glossary.md#payment-token', resolutions: glossary.resolutions, block: { definition: 'The proof a provider returns.', synonyms: ['proof'], code: ['PaymentToken'], usedIn: '[the reference](madarch:doc:docs/reference.md#manifest)', ambiguous: 'also the vault reference' } }));
    await until(() => container.querySelector('[data-block=term]') !== null, 'the block');
    expect(container.textContent).toContain('The proof a provider returns.');
    expect(container.querySelector('[data-testid=term-names]')!.textContent).toContain('PaymentToken');
    expect(container.querySelector('[data-testid=term-ambiguous]')!.textContent).toContain('also the vault reference');
    expect(container.querySelector('a[href="/k/doc?path=docs%2Freference.md#manifest"]')).not.toBeNull();
  });
});

describe('the role of the reader', () => {
  const settings = (role: string, asked: boolean) => ({ role, asked, roles: ['product', 'analyst', 'architect', 'developer', 'operations', 'tester', 'everything'] });

  test('the first open asks once: the card lists the roles with "everything" chosen; choosing one keeps it on the machine and the card goes', async () => {
    const posts: unknown[] = [];
    (globalThis as { fetch?: unknown }).fetch = async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') { const body = JSON.parse(String(init.body)) as { role: string }; posts.push(body); return Response.json(settings(body.role, true)); }
      return Response.json(settings('everything', false));
    };
    const container = into(createElement(RoleCard));
    await loadSettings();
    await until(() => document.querySelector('[data-testid=role-card]') !== null, 'the card');
    const options = [...document.querySelectorAll('[data-testid=role-option]')];
    expect(options.map((option) => option.getAttribute('data-role'))).toEqual(['product', 'analyst', 'architect', 'developer', 'operations', 'tester', 'everything']);
    expect((options[6]!.querySelector('input') as HTMLInputElement).checked).toBe(true);
    (options[3]!.querySelector('input') as HTMLInputElement).click();
    await until(() => (document.querySelectorAll('[data-testid=role-option] input')[3] as HTMLInputElement).checked, 'the developer picked');
    (document.querySelector('[data-testid=role-continue]') as HTMLButtonElement).click();
    await until(() => document.querySelector('[data-testid=role-card]') === null, 'the card gone');
    expect(posts).toEqual([{ role: 'developer' }]);
    expect(container).toBeDefined();
  });

  test('the card fits the window: its body scrolls and its buttons stand in a footer of their own', async () => {
    (globalThis as { fetch?: unknown }).fetch = async () => Response.json(settings('everything', false));
    into(createElement(RoleCard));
    await loadSettings();
    await until(() => document.querySelector('[data-testid=role-card]') !== null, 'the card');
    const card = document.querySelector('[data-testid=role-card]')!;
    expect(card.className).toContain('max-h-[calc(100dvh-2rem)]');
    const body = card.querySelector('[data-testid=role-card-body]')!;
    expect(body.className).toContain('overflow-y-auto');
    const footer = card.querySelector('[data-testid=role-card-footer]')!;
    expect(body.contains(footer)).toBe(false);
    expect(footer.querySelector('[data-testid=role-skip]')).not.toBeNull();
    expect(footer.querySelector('[data-testid=role-continue]')).not.toBeNull();
  });

  test('skipping the card means everything and it is not asked again', async () => {
    const posts: unknown[] = [];
    (globalThis as { fetch?: unknown }).fetch = async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') { const body = JSON.parse(String(init.body)) as { role: string }; posts.push(body); return Response.json(settings(body.role, true)); }
      return Response.json(settings('everything', false));
    };
    into(createElement(RoleCard));
    await loadSettings();
    await until(() => document.querySelector('[data-testid=role-skip]') !== null, 'the card');
    (document.querySelector('[data-testid=role-skip]') as HTMLButtonElement).click();
    await until(() => document.querySelector('[data-testid=role-card]') === null, 'the card gone');
    expect(posts).toEqual([{ role: 'everything' }]);
  });

  test('a reader who was asked before sees no card', async () => {
    (globalThis as { fetch?: unknown }).fetch = async () => Response.json(settings('architect', true));
    into(createElement(RoleCard));
    await loadSettings();
    await new Promise((rest) => setTimeout(rest, 50));
    expect(document.querySelector('[data-testid=role-card]')).toBeNull();
  });

  test('a refusal of the server is shown in the card with its reason, and the role stays unchosen', async () => {
    (globalThis as { fetch?: unknown }).fetch = async (_url: string, init?: RequestInit) => (init?.method === 'POST' ? Response.json({ message: 'settings.json in the madarch home: the settings could not be written' }, { status: 500 }) : Response.json(settings('everything', false)));
    into(createElement(RoleCard));
    await loadSettings();
    await until(() => document.querySelector('[data-testid=role-skip]') !== null, 'the card');
    (document.querySelector('[data-testid=role-skip]') as HTMLButtonElement).click();
    await until(() => document.querySelector('[data-testid=role-error]') !== null, 'the error');
    expect(document.querySelector('[data-testid=role-error]')!.textContent).toContain('settings.json');
    expect(document.querySelector('[data-testid=role-card]')).not.toBeNull();
  });

  test('the top bar names the role and switches it', async () => {
    const posts: unknown[] = [];
    (globalThis as { fetch?: unknown }).fetch = async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') { const body = JSON.parse(String(init.body)) as { role: string }; posts.push(body); return Response.json(settings(body.role, true)); }
      return Response.json(settings('architect', true));
    };
    into(createElement(RoleMenu));
    await loadSettings();
    await until(() => document.querySelector('[data-testid=role-current]')?.textContent === 'Architect', 'the role in the bar');
    await chooseRole('tester');
    await until(() => document.querySelector('[data-testid=role-current]')?.textContent === 'Tester', 'the new role');
    expect(posts).toEqual([{ role: 'tester' }]);
  });
});

describe('the «?» in the top bar', () => {
  const products = [{ name: 'madarch', folder: 'madarch-wiki', own: true }, { name: 'Shop', folder: 'shop' }];

  test('from any product it opens madarch\'s documentation, beside the language menu', async () => {
    const container = into(createElement(HelpLink, { products, current: 'shop' }));
    await until(() => container.querySelector('[data-testid=help-link]') !== null, 'the icon');
    const link = container.querySelector('[data-testid=help-link]')!;
    expect(link.getAttribute('href')).toBe('/products/madarch-wiki/k');
    expect(link.getAttribute('aria-label')).toBe('madarch documentation');
  });

  test('inside the documentation itself, and where no documentation is served, there is no icon', async () => {
    const inside = into(createElement(HelpLink, { products, current: 'madarch-wiki' }));
    await new Promise((rest) => setTimeout(rest, 20));
    expect(inside.querySelector('[data-testid=help-link]')).toBeNull();
    rendered?.unmount();
    const alone = into(createElement(HelpLink, { products: [{ name: 'Shop', folder: 'shop' }], current: 'shop' }));
    await new Promise((rest) => setTimeout(rest, 20));
    expect(alone.querySelector('[data-testid=help-link]')).toBeNull();
  });
});
