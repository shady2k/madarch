/**
 * The knowledge wiki in the app (decision 0029), tested without a server: the
 * blocks drawn from the page model, `madarch:` links shown as links or as broken,
 * the source with its line numbers and highlighting, the fill's card on an empty
 * product, the product selector and which app opens at an address. Every request
 * is answered by a stub giving the server's own shapes (src/knowledge/model.ts).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setWikiLanguage } from '../i18n.js';
import { BlockView, Findings, KMarkdown } from './blocks.js';
import { highlight } from './highlight.js';
import { Root as AppRoot } from './root.js';
import { FillCard } from './pages.js';
import { ProductSelector, productChoices } from './app.js';
import { kRouteOf, kindPlural, kindWord } from './routes.js';
import type { Block, Resolution, WikiStatus } from './types.js';

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
  window.history.replaceState({}, '', '/');
});

const ok = (target: string, label: string, href: string | null, extra: Partial<Resolution> = {}): Resolution => ({ state: 'ok', target, kind: 'code.symbol', label, href, ...extra }) as Resolution;

describe('highlighting', () => {
  test('keywords, strings, comments and numbers are told apart, line by line, and the text is kept whole', () => {
    const code = ['export function charge(amount: number) { // bill it', '  const text = "a // b";', '  return 42; /* start', 'still comment */ }'].join('\n');
    const lines = highlight(code, 'typescript');
    expect(lines.map((tokens) => tokens.map((token) => token.text).join(''))).toEqual(code.split('\n'));
    const kinds = (line: number): [string, string][] => lines[line]!.filter((token) => token.kind !== 'plain').map((token) => [token.kind, token.text]);
    expect(kinds(0)).toEqual([['keyword', 'export'], ['keyword', 'function'], ['comment', '// bill it']]);
    expect(kinds(1)).toEqual([['keyword', 'const'], ['string', '"a // b"']]);
    expect(kinds(2)).toEqual([['keyword', 'return'], ['number', '42'], ['comment', '/* start']]);
    expect(kinds(3)).toEqual([['comment', 'still comment */']]);
  });

  test('Go, SQL (case-blind) and an unknown language are each read by their own rules', () => {
    expect(highlight('func main() { return nil }', 'go')[0]!.filter((token) => token.kind === 'keyword').map((token) => token.text)).toEqual(['func', 'return', 'nil']);
    expect(highlight('SELECT id FROM t -- note', 'sql')[0]!.filter((token) => token.kind !== 'plain').map((token) => [token.kind, token.text])).toEqual([['keyword', 'SELECT'], ['keyword', 'FROM'], ['comment', '-- note']]);
    expect(highlight('const x = 1', 'text')).toEqual([[{ text: 'const x = 1', kind: 'plain' }]]);
  });
});

describe('routes', () => {
  test('the wiki lives under /k, at a product\'s prefix too; anything else is not its route', () => {
    expect(kRouteOf('/k')).toEqual({ name: 'home' });
    expect(kRouteOf('/products/shop/k/')).toEqual({ name: 'home' });
    expect(kRouteOf('/products/shop/k/e/code.symbol%3Aa.ts%23f')).toEqual({ name: 'entity', id: 'code.symbol:a.ts#f' });
    expect(kRouteOf('/k/kind/code.file')).toEqual({ name: 'kind', kind: 'code.file' });
    expect(kRouteOf('/k/src', '?repo=r&path=a%2Fb.ts&line=12')).toEqual({ name: 'source', repo: 'r', path: 'a/b.ts', line: 12 });
    expect(kRouteOf('/k/src', '?path=a.ts')).toEqual({ name: 'source', repo: null, path: 'a.ts', line: null });
    expect(kRouteOf('/p/docs/x.md')).toBeNull();
    expect(kRouteOf('/')).toBeNull();
  });

  test('a kind is a word for a reader: the extractor prefix dropped, and a plural', () => {
    expect(kindWord('code.service')).toBe('Service');
    expect(kindWord('code.test-case')).toBe('Test case');
    expect(kindPlural('code.symbol')).toBe('Symbols');
    expect(kindPlural('code.index')).toBe('Indexes');
    expect(kindPlural('domain')).toBe('Domains');
    expect(kindPlural('code.entry')).toBe('Entries');
  });
});

describe('Markdown with grounds', () => {
  const resolutions: Record<string, Resolution> = {
    'madarch:code.symbol:a.ts#f': ok('madarch:code.symbol:a.ts#f', 'f', '/k/e/code.symbol%3Aa.ts%23f', { location: { repo: 'shop', path: 'a.ts', lineStart: 2, lineEnd: 9, href: '/k/src?repo=shop&path=a.ts&line=2' } }),
    'madarch:code.table:t': ok('madarch:code.table:t', 't', null),
    'madarch:code.symbol:a.ts#gone': { state: 'broken', target: 'madarch:code.symbol:a.ts#gone', reason: 'no entity "code.symbol:a.ts#gone" in the graph' },
  };
  const text = 'Charges run through [f](madarch:code.symbol:a.ts#f).[^1]\n\n[^1]: [f](madarch:code.symbol:a.ts#f), [gone](madarch:code.symbol:a.ts#gone), [t](madarch:code.table:t)\n';

  test('a ground that resolves is a link to the entity\'s page; one that does not is shown as broken with its reason, never linked', async () => {
    const container = into(createElement(KMarkdown, { text, resolutions }));
    await until(() => container.querySelector('section[data-footnotes]') !== null, 'the footnotes');
    const links = [...container.querySelectorAll('a')].filter((anchor) => anchor.getAttribute('href')?.startsWith('/k/e/'));
    expect(links.length).toBeGreaterThanOrEqual(2);
    expect(links[0]!.getAttribute('href')).toBe('/k/e/code.symbol%3Aa.ts%23f');
    const broken = container.querySelector('[data-testid=ref-broken]')!;
    expect(broken.textContent).toContain('gone');
    expect(broken.textContent).toContain('broken');
    expect(broken.getAttribute('title')).toBe('no entity "code.symbol:a.ts#gone" in the graph');
    expect(broken.closest('a')).toBeNull();
    // A reference to code opens the source at its line beside the page.
    const place = container.querySelector('[data-testid=code-place]')!;
    expect(place.textContent).toBe('a.ts:2–9');
    expect(place.closest('a')!.getAttribute('href')).toBe('/k/src?repo=shop&path=a.ts&line=2');
    const unpaged = container.querySelector('[data-testid=ref-unpaged]')!;
    expect(unpaged.textContent).toBe('t');
    expect(unpaged.closest('a')).toBeNull();
  });

  test('a madarch: link nobody resolved is broken too: nothing is linked on trust', async () => {
    const container = into(createElement(KMarkdown, { text: 'See [x](madarch:code.file:x).', resolutions: {} }));
    await until(() => container.querySelector('[data-testid=ref-broken]') !== null, 'the broken mark');
  });
});

describe('the blocks', () => {
  const place = { repo: 'shop', path: 'svc/a.ts', lineStart: 3, lineEnd: 6, href: '/k/src?repo=shop&path=svc%2Fa.ts&line=3' };

  test('related is a table per relation: the name links to the page, the kind is a badge, the place opens the source at its line, a cut says how many are shown', async () => {
    const block: Block = {
      type: 'related', title: 'Files',
      groups: [{ relation: 'code.contains', direction: 'out', total: 5, rows: [
        { entity: { id: 'code.file:a.ts', kind: 'code.file', label: 'a.ts', href: '/k/e/code.file%3Aa.ts', location: place }, count: 2 },
        { entity: { id: 'code.table:t', kind: 'code.table', label: 't', href: null }, count: 1 },
        { entity: { id: 'code.symbol:none', kind: 'code.symbol', label: 'none', href: null, broken: 'no entity "code.symbol:none"' }, count: 1 },
      ] }],
    };
    const container = into(createElement(BlockView, { block, resolutions: {} }));
    await until(() => container.querySelector('table') !== null, 'the table');
    const rows = [...container.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(3);
    expect(rows[0]!.querySelector('a')!.getAttribute('href')).toBe('/k/e/code.file%3Aa.ts');
    expect(rows[0]!.textContent).toContain('×2');
    expect(rows[0]!.textContent).toContain('File');
    expect(rows[0]!.querySelector('[data-testid=code-place]')!.closest('a')!.getAttribute('href')).toBe(place.href);
    expect(rows[0]!.querySelector('[data-testid=code-place]')!.textContent).toBe('svc/a.ts:3–6');
    expect(rows[1]!.querySelector('a')).toBeNull();
    expect(rows[2]!.querySelector('[data-testid=ref-broken]')).not.toBeNull();
    expect(container.querySelector('[data-testid=related-cut]')!.textContent).toBe('Showing 3 of 5.');
  });

  test('a related block with nothing to show says so with its title', async () => {
    const container = into(createElement(BlockView, { block: { type: 'related', title: 'Imports', groups: [] }, resolutions: {} }));
    await until(() => container.querySelector('[data-testid=related-empty]') !== null, 'the empty line');
    expect(container.querySelector('h2')!.textContent).toBe('Imports');
    expect(container.querySelector('[data-testid=related-empty]')!.textContent).toBe('nothing');
  });

  test('callers list each caller with the call site as a link to the source at its line, and say how many there are in all', async () => {
    const block: Block = {
      type: 'callers', title: 'Callers', total: 5,
      rows: [{ entity: { id: 'code.symbol:b', kind: 'code.symbol', label: 'handle', href: '/k/e/code.symbol%3Ab' }, sites: 2, site: { repo: 'shop', path: 'svc/b.ts', lineStart: 9, lineEnd: 9, href: '/k/src?repo=shop&path=svc%2Fb.ts&line=9' } }],
    };
    const container = into(createElement(BlockView, { block, resolutions: {} }));
    await until(() => container.querySelector('table') !== null, 'the table');
    const row = container.querySelector('tbody tr')!;
    expect(row.querySelector('a')!.textContent).toBe('handle');
    expect(row.querySelector('[data-testid=code-place]')!.closest('a')!.getAttribute('href')).toBe('/k/src?repo=shop&path=svc%2Fb.ts&line=9');
    expect(row.textContent).toContain('2');
    expect(container.querySelector('[data-testid=calls-cut]')!.textContent).toBe('Showing 1 of 5.');
  });

  test('source shows the declaration with the file\'s own line numbers, highlighted, under a link that opens the file at the first line', async () => {
    const block: Block = { type: 'source', title: 'Source', location: place, language: 'typescript', text: 'export function charge() {\n  return 1;\n}', truncated: true };
    const container = into(createElement(BlockView, { block, resolutions: {} }));
    await until(() => container.querySelector('[data-testid=source-code]') !== null, 'the code');
    expect([...container.querySelectorAll('.source-number')].map((cell) => cell.textContent)).toEqual(['3', '4', '5']);
    expect(container.querySelector('.tok-keyword')!.textContent).toBe('export');
    expect(container.querySelector('[data-testid=code-place]')!.closest('a')!.getAttribute('href')).toBe(place.href);
    expect(container.querySelector('[data-testid=source-cut]')!.textContent).toContain('Open the file');
  });

  test('a body with statements that have no grounds says how many, and lists them with their file and line', async () => {
    const block: Block = { type: 'body', markdown: 'Text.', file: 'docs/p.md', statements: 3, ungrounded: [{ text: 'A refund is posted.', line: 13 }] };
    const container = into(createElement(BlockView, { block, resolutions: {} }));
    await until(() => container.querySelector('[data-testid=ungrounded]') !== null, 'the notice');
    expect(container.querySelector('[data-testid=ungrounded]')!.textContent).toContain('Statements without grounds: 1 of 3');
    expect(container.querySelector('[data-testid=ungrounded] li')!.textContent).toBe('A refund is posted. (docs/p.md:13)');
  });

  test('a block that could not be drawn is a problem with the block\'s name, the reason and the template\'s file and line', async () => {
    const block: Block = { type: 'problem', block: 'er', message: 'the er block draws a database or a table', file: 'templates/symbol.md', line: 7 };
    const container = into(createElement(BlockView, { block, resolutions: {} }));
    await until(() => container.querySelector('[data-testid=block-problem]') !== null, 'the problem');
    expect(container.textContent).toContain('The :::er block could not be drawn');
    expect(container.textContent).toContain('templates/symbol.md:7');
  });

  test('a diagram draws through the wiki\'s Mermaid renderer and says how many of how many it shows; an empty one says it is empty', async () => {
    const container = into(createElement('div', null,
      createElement(BlockView, { block: { type: 'graph', title: 'Links', mermaid: 'flowchart LR\n  n0["a"]', shown: 1, total: 4 }, resolutions: {} }),
      createElement(BlockView, { block: { type: 'sequence', title: 'Call sequence', mermaid: '', shown: 0, total: 0 }, resolutions: {} })));
    await until(() => container.querySelector('[data-testid=mermaid-diagram]') !== null || container.querySelector('[data-testid=mermaid-error]') !== null, 'the diagram');
    expect(container.querySelector('figcaption')!.textContent).toBe('Showing 1 of 4.');
    expect(container.querySelector('[data-testid=diagram-empty]')!.textContent).toBe('no calls in the graph');
    expect([...container.querySelectorAll('h2')].map((heading) => heading.textContent)).toEqual(['Links', 'Call sequence']);
  });

  test('the findings of a page are counted and listed with their file and line when opened', async () => {
    const container = into(createElement(Findings, { findings: [{ file: 'templates/service.md', line: 1, message: '"{{owner}}" names no attribute of this entity' }] }));
    await until(() => container.querySelector('[data-testid=findings]') !== null, 'the findings');
    expect(container.textContent).toContain('Problems found: 1');
    (container.querySelector('button') as HTMLButtonElement).click();
    await until(() => container.querySelector('li') !== null, 'the list');
    expect(container.querySelector('li')!.textContent).toBe('templates/service.md:1 "{{owner}}" names no attribute of this entity');
  });
});

describe('the fill card', () => {
  const status = (over: Partial<WikiStatus> = {}): WikiStatus => ({
    product: { name: 'shop', id: 'x' }, manifest: 'ok', manifestFile: 'madarch/kinds.yaml', findings: [], kinds: [], repositories: [{ name: 'training', filled: false }], filled: false, incomplete: false, fill: { state: 'idle' }, home: null, ...over,
  });

  test('an empty product with a repository says what to do and starts the fill on the press of one button', async () => {
    const calls: string[] = [];
    (globalThis as { fetch?: unknown }).fetch = async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      return new Response(JSON.stringify({ fill: { state: 'running' } }), { status: 202 });
    };
    let refreshed = 0;
    const container = into(createElement(FillCard, { status: status(), refresh: () => { refreshed += 1; } }));
    await until(() => container.querySelector('[data-testid=fill-start]') !== null, 'the start button');
    expect(container.textContent).toContain('This wiki is empty');
    expect(container.textContent).toContain('(training)');
    (container.querySelector('[data-testid=fill-start]') as HTMLButtonElement).click();
    await until(() => refreshed === 1, 'the refresh');
    expect(calls).toEqual(['POST /api/k/fill']);
  });

  test('a refusal of the server is shown in its own words', async () => {
    (globalThis as { fetch?: unknown }).fetch = async () => new Response(JSON.stringify({ message: 'the repositories training are not checked out under repos/: run "madarch bootstrap" first' }), { status: 409 });
    const container = into(createElement(FillCard, { status: status(), refresh: () => undefined }));
    await until(() => container.querySelector('[data-testid=fill-start]') !== null, 'the start button');
    (container.querySelector('[data-testid=fill-start]') as HTMLButtonElement).click();
    await until(() => container.querySelector('[data-testid=fill-refused]') !== null, 'the refusal');
    expect(container.querySelector('[data-testid=fill-refused]')!.textContent).toContain('run "madarch bootstrap" first');
  });

  test('a product with no repository says to connect one and offers no button that cannot work', async () => {
    const container = into(createElement(FillCard, { status: status({ repositories: [] }), refresh: () => undefined }));
    await until(() => container.querySelector('[data-testid=fill-hint]') !== null, 'the hint');
    expect(container.querySelector('[data-testid=fill-hint]')!.textContent).toBe('madarch repo add <name> <url>');
    expect(container.querySelector('[data-testid=fill-start]')).toBeNull();
  });

  test('a running fill shows its place in the commits as a progress bar, and a failed one its reason with a way to try again', async () => {
    const running = into(createElement(FillCard, { status: status({ fill: { state: 'running', repository: 'training', commit: 12, commits: 70 } }), refresh: () => undefined }));
    await until(() => running.querySelector('[role=progressbar]') !== null, 'the bar');
    const bar = running.querySelector('[role=progressbar]')!;
    expect([bar.getAttribute('aria-valuenow'), bar.getAttribute('aria-valuemax')]).toEqual(['12', '70']);
    expect(running.textContent).toContain('Repository training: commit 12 of 70.');
    rendered?.unmount();
    document.body.innerHTML = '';
    const failed = into(createElement(FillCard, { status: status({ fill: { state: 'failed', message: 'git failed in the repository' } }), refresh: () => undefined }));
    await until(() => failed.querySelector('[data-state=failed]') !== null, 'the failure');
    expect(failed.textContent).toContain('git failed in the repository');
    expect(failed.textContent).toContain('Start the fill again');
  });

  test('a fill that stopped before its last commit says the graph holds part of the history and offers to continue', async () => {
    const container = into(createElement(FillCard, { status: status({ filled: true, incomplete: true }), refresh: () => undefined }));
    await until(() => container.querySelector('[data-state=incomplete]') !== null, 'the card');
    expect(container.textContent).toContain('The fill is not finished');
    expect(container.querySelector('[data-testid=fill-start]')!.textContent).toBe('Continue the fill');
  });

  test('a filled product shows no card', async () => {
    const container = into(createElement(FillCard, { status: status({ filled: true, fill: { state: 'done' } }), refresh: () => undefined }));
    await new Promise((rest) => setTimeout(rest, 20));
    expect(container.querySelector('[data-testid=fill-card]')).toBeNull();
  });
});

describe('the product selector', () => {
  test('the product is at the top left as a control that names it and opens a menu', async () => {
    const container = into(createElement(ProductSelector, { name: 'shop', products: [{ name: 'Shop', folder: 'shop' }, { name: 'Other', folder: 'other' }], current: 'shop' }));
    await until(() => container.querySelector('[data-testid=product-selector]') !== null, 'the selector');
    const trigger = container.querySelector('[data-testid=product-selector]') as HTMLElement;
    expect(trigger.textContent).toContain('shop');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-label')).toBe('Choose a product');
  });

  test('the choices are the home\'s products, each at its own wiki, and the open one is marked', () => {
    expect(productChoices([{ name: 'Shop', folder: 'shop' }, { name: 'Other one', folder: 'other one' }], 'shop')).toEqual([
      { name: 'Shop', folder: 'shop', href: '/products/shop/k', here: true },
      { name: 'Other one', folder: 'other one', href: '/products/other%20one/k', here: false },
    ]);
  });
});

describe('which app opens', () => {
  const answer = (manifest: 'ok' | 'no-manifest') => async (url: string): Promise<Response> => {
    if (url.endsWith('/api/k/status')) {
      return new Response(JSON.stringify({ product: { name: 'shop', id: 'x' }, manifest, manifestFile: 'madarch/kinds.yaml', findings: [], kinds: [], repositories: [], filled: false, incomplete: false, fill: { state: 'idle' }, home: null }));
    }
    // What the documents app asks first; every other read of it is optional and may fail.
    if (url.endsWith('/api/pages')) return new Response(JSON.stringify({ pages: [] }));
    if (url.endsWith('/api/product')) return new Response(JSON.stringify({ name: 'shop' }));
    if (url.endsWith('/api/k/products')) return new Response(JSON.stringify({ products: [] }));
    return new Response(JSON.stringify({ message: 'not here' }), { status: 404 });
  };

  test('the front door of a product that has a kinds manifest opens the knowledge wiki at /k', async () => {
    (globalThis as { fetch?: unknown }).fetch = answer('ok');
    window.history.replaceState({}, '', '/');
    const container = into(createElement(AppRoot));
    await until(() => container.querySelector('[data-testid=knowledge-app]') !== null, 'the knowledge wiki');
    expect(window.location.pathname).toBe('/k');
  });

  test('a product without the manifest, and the address /?documents, keep the documents app', async () => {
    (globalThis as { fetch?: unknown }).fetch = answer('no-manifest');
    window.history.replaceState({}, '', '/');
    const container = into(createElement(AppRoot));
    await until(() => container.querySelector('[data-testid=knowledge-app]') === null && container.innerHTML !== '', 'the documents app');
    expect(window.location.pathname).toBe('/');
    rendered?.unmount();
    document.body.innerHTML = '';
    (globalThis as { fetch?: unknown }).fetch = answer('ok');
    window.history.replaceState({}, '', '/?documents');
    const again = into(createElement(AppRoot));
    await new Promise((rest) => setTimeout(rest, 50));
    expect(again.querySelector('[data-testid=knowledge-app]')).toBeNull();
    expect(window.location.pathname).toBe('/');
  });
});
