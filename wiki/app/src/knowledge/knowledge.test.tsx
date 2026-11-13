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
import { appPath } from '../app-base.js';
import { frontTab, openInNewTab } from './tabs.js';
import { setWikiLanguage } from '../i18n.js';
import { BlockView, Findings, KMarkdown } from './blocks.js';
import { highlight } from './highlight.js';
import { Root as AppRoot } from './root.js';
import { FillCard, Overview } from './pages.js';
import { FillPage } from './fill-page.js';
import { SelectionRunPage } from './fill-runs.js';
import { WriterLine } from './writer.js';
import { ProductSelector, productChoices } from './app.js';
import { KindLabels } from './kind-names.js';
import { syncFrontTabAddress } from './tabs.js';
import { KindPage } from './pages.js';
import { addressOfDocument, wikiRouteOf, kindPlural, kindWord } from './routes.js';
import { kindNameOf } from './kind-names.js';
import { PageSkeleton } from './skeleton.js';
import { relativeDocument } from './blocks.js';
import type { Block, KindSummary, Resolution, SelectionRun, WikiStatus } from './types.js';

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  await setWikiLanguage('en');
});

afterAll(async () => {
  await new Promise((rest) => setTimeout(rest, 50));
  GlobalRegistrator.unregister();
});

let rendered: Root | undefined;
const roots = new Set<Root>();
function into(element: ReturnType<typeof createElement>): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  rendered = createRoot(container);
  roots.add(rendered);
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
  for (const root of roots) root.unmount();
  roots.clear();
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
  test('the wiki lives at the root, at a product\'s prefix too; anything else is not its route', () => {
    expect(wikiRouteOf('/')).toEqual({ name: 'home' });
    expect(wikiRouteOf('/products/shop/')).toEqual({ name: 'home' });
    expect(wikiRouteOf('/products/shop/e/code.symbol%3Aa.ts%23f')).toEqual({ name: 'entity', id: 'code.symbol:a.ts#f', after: null });
    expect(wikiRouteOf('/kind/code.file')).toEqual({ name: 'kind', kind: 'code.file' });
    expect(wikiRouteOf('/src', '?repo=r&path=a%2Fb.ts&line=12')).toEqual({ name: 'source', repo: 'r', path: 'a/b.ts', line: 12 });
    expect(wikiRouteOf('/src', '?path=a.ts')).toEqual({ name: 'source', repo: null, path: 'a.ts', line: null });
    expect(wikiRouteOf('/p/docs/x.md')).toBeNull();
    expect(wikiRouteOf('/nope')).toBeNull();
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
    'madarch:code.symbol:a.ts#f': ok('madarch:code.symbol:a.ts#f', 'f', '/e/code.symbol%3Aa.ts%23f', { location: { repo: 'shop', path: 'a.ts', lineStart: 2, lineEnd: 9, href: '/src?repo=shop&path=a.ts&line=2' } }),
    'madarch:code.table:t': ok('madarch:code.table:t', 't', null),
    'madarch:code.symbol:a.ts#gone': { state: 'broken', target: 'madarch:code.symbol:a.ts#gone', reason: 'no entity "code.symbol:a.ts#gone" in the graph' },
  };
  const text = 'Charges run through [f](madarch:code.symbol:a.ts#f).[^1]\n\n[^1]: [f](madarch:code.symbol:a.ts#f), [gone](madarch:code.symbol:a.ts#gone), [t](madarch:code.table:t)\n';

  test('a ground that resolves is a link to the entity\'s page; one that does not is shown as broken with its reason, never linked', async () => {
    const container = into(createElement(KMarkdown, { text, resolutions }));
    await until(() => container.querySelector('section[data-footnotes]') !== null, 'the footnotes');
    const links = [...container.querySelectorAll('a')].filter((anchor) => anchor.getAttribute('href')?.startsWith('/e/'));
    expect(links.length).toBeGreaterThanOrEqual(2);
    expect(links[0]!.getAttribute('href')).toBe('/e/code.symbol%3Aa.ts%23f');
    const broken = container.querySelector('[data-testid=ref-broken]')!;
    expect(broken.textContent).toContain('gone');
    expect(broken.textContent).toContain('broken');
    expect(broken.getAttribute('title')).toBe('no entity "code.symbol:a.ts#gone" in the graph');
    expect(broken.closest('a')).toBeNull();
    // A reference to code opens the source at its line beside the page.
    const place = container.querySelector('[data-testid=code-place]')!;
    expect(place.textContent).toBe('a.ts:2–9');
    expect(place.closest('a')!.getAttribute('href')).toBe('/src?repo=shop&path=a.ts&line=2');
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
  const place = { repo: 'shop', path: 'svc/a.ts', lineStart: 3, lineEnd: 6, href: '/src?repo=shop&path=svc%2Fa.ts&line=3' };

  test('related is a table per relation: the name links to the page, the kind is a badge, the place opens the source at its line, a cut says how many are shown', async () => {
    const block: Block = {
      type: 'related', title: 'Files',
      groups: [{ relation: 'code.contains', direction: 'out', total: 5, rows: [
        { entity: { id: 'code.file:a.ts', kind: 'code.file', label: 'a.ts', href: '/e/code.file%3Aa.ts', location: place }, count: 2 },
        { entity: { id: 'code.table:t', kind: 'code.table', label: 't', href: null }, count: 1 },
        { entity: { id: 'code.symbol:none', kind: 'code.symbol', label: 'none', href: null, broken: 'no entity "code.symbol:none"' }, count: 1 },
      ] }],
    };
    const container = into(createElement(BlockView, { block, resolutions: {} }));
    await until(() => container.querySelector('table') !== null, 'the table');
    const rows = [...container.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(3);
    expect(rows[0]!.querySelector('a')!.getAttribute('href')).toBe('/e/code.file%3Aa.ts');
    expect(rows[0]!.textContent).toContain('×2');
    expect(rows[0]!.textContent).toContain('File');
    expect(rows[0]!.querySelector('[data-testid=code-place]')!.closest('a')!.getAttribute('href')).toBe(place.href);
    expect(rows[0]!.querySelector('[data-testid=code-place]')!.textContent).toBe('svc/a.ts:3–6');
    expect(rows[1]!.querySelector('a')).toBeNull();
    expect(rows[2]!.querySelector('[data-testid=ref-broken]')).not.toBeNull();
    expect(container.querySelector('[data-testid=related-cut]')!.textContent).toBe('Showing 3 of 5.');
  });

  test('a hotspot table heads its paths File, not Commit', async () => {
    const block: Block = {
      type: 'history', title: 'History',
      sections: [
        { role: 'summary', total: 1, rows: [{ text: '', figures: [{ kind: 'commits', value: '7' }] }] },
        { role: 'hotspots', total: 1, rows: [{ text: 'svc/a.ts', figures: [{ kind: 'commits', value: '3' }] }] },
      ],
      notes: [],
    };
    const container = into(createElement(BlockView, { block, resolutions: {} }));
    await until(() => container.querySelector('tbody tr') !== null, 'the history table');
    const heads = [...container.querySelectorAll('thead th')].map((head) => head.textContent);
    expect(heads[0]).toBe('File');
    expect(heads).not.toContain('Commit');
  });

  test('a related block with nothing to show draws no section', async () => {
    const container = into(createElement(BlockView, { block: { type: 'related', title: 'Imports', groups: [] }, resolutions: {} }));
    expect(container.querySelector('section')).toBeNull();
    expect(container.textContent).toBe('');
  });

  test('an overview section draws its paragraphs with sources, its rows, its links and its absent note', async () => {
    const block: Block = {
      type: 'overview', section: 'terms', title: 'Key terms',
      paragraphs: [{ text: 'The product’s own words.', source: { label: 'docs/product.md:1', href: '/src?path=docs%2Fproduct.md&line=1' } }],
      rows: [{ label: 'Fill', value: 'the one run', href: '/e/doc.term%3AFill', source: { label: 'docs/glossary.md:3', href: '/src?path=docs%2Fglossary.md&line=3' } }],
      links: [{ label: 'Documents', href: '/docs' }],
      absent: { message: 'More terms appear after a fill.', href: '/fill', label: 'Open the fill' },
    };
    const container = into(createElement(BlockView, { block, resolutions: {} }));
    await until(() => container.querySelector('[data-block=overview]') !== null, 'the overview section');
    const section = container.querySelector('[data-block=overview]')!;
    expect(section.getAttribute('data-overview')).toBe('terms');
    expect(section.querySelector('h2')!.textContent).toBe('Key terms');
    expect(section.textContent).toContain('The product’s own words.');
    expect(section.querySelector('a[href="/src?path=docs%2Fproduct.md&line=1"]')).not.toBeNull();
    expect(section.querySelector('[data-testid=overview-rows]')!.textContent).toContain('the one run');
    expect(section.querySelector('a[href="/e/doc.term%3AFill"]')!.textContent).toBe('Fill');
    expect(section.querySelector('[data-testid=overview-links] a')!.getAttribute('href')).toBe('/docs');
    expect(section.querySelector('[data-testid=overview-absent]')!.textContent).toContain('More terms appear after a fill.');
    expect(section.querySelector('[data-testid=overview-absent] a')!.getAttribute('href')).toBe('/fill');
  });

  test('callers list each caller with the call site as a link to the source at its line, and say how many there are in all', async () => {
    const block: Block = {
      type: 'callers', title: 'Callers', total: 5,
      rows: [{ entity: { id: 'code.symbol:b', kind: 'code.symbol', label: 'handle', href: '/e/code.symbol%3Ab' }, sites: 2, site: { repo: 'shop', path: 'svc/b.ts', lineStart: 9, lineEnd: 9, href: '/src?repo=shop&path=svc%2Fb.ts&line=9' } }],
    };
    const container = into(createElement(BlockView, { block, resolutions: {} }));
    await until(() => container.querySelector('table') !== null, 'the table');
    const row = container.querySelector('tbody tr')!;
    expect(row.querySelector('a')!.textContent).toBe('handle');
    expect(row.querySelector('[data-testid=code-place]')!.closest('a')!.getAttribute('href')).toBe('/src?repo=shop&path=svc%2Fb.ts&line=9');
    expect(row.textContent).toContain('2');
    expect(container.querySelector('[data-testid=calls-cut]')!.textContent).toBe('Showing 1 of 5.');
  });


  const history: Block = {
    type: 'history', title: 'Repository history',
    sections: [{ role: 'summary', total: 1, rows: [{ text: 'shop', figures: [
      { kind: 'commits', value: '1' },
      { kind: 'authors', value: '1' },
      { kind: 'merges', value: '0' },
      { kind: 'reachable', value: '1' },
      { kind: 'files', value: '2' },
      { kind: 'symbols', value: '5' },
      { kind: 'added', value: '42' },
      { kind: 'removed', value: '7' },
      { kind: 'module', value: 'services/orders' },
    ] }] }],
    notes: [{ key: 'manyCommits', args: { total: 2, shown: 1 } }],
  };
  const figures = (container: HTMLElement): [string, string][] => [...container.querySelectorAll('[data-figure]')].map((badge) => [badge.getAttribute('data-figure')!, (badge.textContent ?? '').trim()]);

  test('every history figure counts in its numeral\'s own form, and the block\'s notes too', async () => {
    const container = into(createElement(BlockView, { block: history, resolutions: {} }));
    await until(() => container.querySelector('[data-figure=commits]') !== null, 'the figures');
    expect(figures(container)).toEqual([
      ['commits', '1 commit'],
      ['authors', '1 author'],
      ['merges', '0 merges'],
      ['reachable', '1 reachable commit'],
      ['files', '2 files'],
      ['symbols', '5 symbols'],
      ['added', '+42'],
      ['removed', '−7'],
      ['module', 'module: services/orders'],
    ]);
    expect(container.querySelector('[data-figure=commits]')!.getAttribute('title')).toBe('1 commit');
    expect(container.querySelector('[data-figure=added]')!.getAttribute('title')).toBe('added lines');
    expect(container.querySelector('[data-block=history] li')!.textContent).toBe('The list names 2 commits; the first 1 is shown.');
  });

  test('in Russian the same figures keep the numeral\'s form of Russian, not one fixed word', async () => {
    await setWikiLanguage('ru');
    try {
      const container = into(createElement(BlockView, { block: history, resolutions: {} }));
      await until(() => container.querySelector('[data-figure=commits]') !== null, 'the figures');
      expect(figures(container)).toEqual([
        ['commits', '1 коммит'],
        ['authors', '1 автор'],
        ['merges', '0 слияний'],
        ['reachable', '1 достижимый коммит'],
        ['files', '2 файла'],
        ['symbols', '5 символов'],
        ['added', '+42'],
        ['removed', '−7'],
        ['module', 'модуль: services/orders'],
      ]);
      expect(container.querySelector('[data-block=history] li')!.textContent).toBe('В списке 2 коммита; показан первый.');
    } finally {
      await setWikiLanguage('en');
    }
  });

  test('source shows the declaration with the file\'s own line numbers, highlighted, under a link that opens the file at the first line', async () => {
    const block: Block = { type: 'source', title: 'Source', location: place, language: 'typescript', text: 'export function charge() {\n  return 1;\n}', truncated: true };
    const container = into(createElement(BlockView, { block, resolutions: {} }));
    await until(() => container.querySelector('[data-testid=source-code]') !== null, 'the code');
    expect([...container.querySelectorAll('.source-number')].map((cell) => cell.textContent)).toEqual(['3', '4', '5']);
    // The plain scanner draws the lines at once and Shiki's colours replace them when they arrive; the
    // test reads the line's text and its token once the highlighter has answered, so it does not depend
    // on which of the two renderers drew the line at the moment it looked (measured: the tok- class is
    // gone by the time the coloured renderer draws, and a loaded suite saw it replaced first).
    const code = container.querySelector('[data-testid=source-code]')!;
    await until(() => code.getAttribute('data-colored') === 'true', 'the highlighter');
    const first = container.querySelector('[data-line="3"] .source-text')!;
    // The coloured renderer keeps the line's own line break in its last token.
    expect(first.textContent!.trimEnd()).toBe('export function charge() {');
    expect([...first.querySelectorAll('.tok-keyword, .shiki-token')].map((token) => token.textContent)).toContain('export');
    expect(container.querySelector('[data-testid=code-place]')!.closest('a')!.getAttribute('href')).toBe(place.href);
    expect(container.querySelector('[data-testid=source-cut]')!.textContent).toContain('Source file');
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


  test('manifest findings deduplicate by file and line, and translate the missing group while keeping raw details', async () => {
    await setWikiLanguage('ru');
    const finding = { file: '/tmp/shop/madarch/kinds.yaml', line: 14, message: 'kind "question": "group" names a group of "groups" (none is declared), got "product"' };
    const samePlaceDifferentIssue = { file: finding.file, line: finding.line, message: 'kind "question": "source" is "graph", "markdown" or "document"' };
    const container = into(createElement(Findings, { findings: [finding, finding, samePlaceDifferentIssue], scope: 'manifest' }));
    await until(() => container.querySelector('[data-testid=manifest-findings]') !== null, 'the manifest findings');
    expect(container.textContent).toContain('Найдено проблем: 2');
    (container.querySelector('[data-testid=findings-details]') as HTMLButtonElement).click();
    await until(() => container.querySelector('li') !== null, 'the translated finding');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('li')!.textContent).toContain('Вид «Вопрос» ссылается на группу «product», которой нет в манифесте.');
    expect(container.querySelector('li')!.textContent).not.toContain('names a group');
    expect(container.querySelector('[data-testid=findings-details]')!.textContent).toBe('Скрыть подробности');
    await setWikiLanguage('en');
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

const OFFERS = [
  { id: 'claude-code', label: 'Claude Code', installed: false, login: 'signed-in', loginDetail: '', install: { package: '@agentclientprotocol/claude-agent-acp', version: '0.93.0', size: '314 MB', folder: '/opt/madarch/agents/claude' } },
  { id: 'codex', label: 'Codex', installed: true, login: 'not-signed-in', loginDetail: '', install: null },
];
/** A fetch that answers the agents' list and records every request; `others` answers the rest. */
function stubFetch(calls: string[], others: (url: string, init?: RequestInit) => Response = () => new Response(JSON.stringify({ fill: { state: 'running' } }), { status: 202 })): void {
  (globalThis as { fetch?: unknown }).fetch = async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}${init?.body === undefined ? '' : ` ${String(init.body)}`}`);
    if (url.endsWith('/api/agents')) return new Response(JSON.stringify({ agents: OFFERS, chosen: null }));
    // The fill panel reads the catalogue and the selection it opens: a section of two kinds, one filled by a plugin and
    // one by the agent, and no stored selection (the panel then shows every entity, as the design says).
    if (url.includes('/api/catalog')) return new Response(JSON.stringify({ product: { name: 'shop', id: 'x' }, language: 'en', groups: [{ group: 'code', labels: { en: 'Code', ru: 'Код' } }], kinds: [
      { kind: 'code.file', area: 'code', subgroup: '', count: 4, page: true, filled: true, plugins: ['files'], state: 'filled', estimate: { volume: 4, unit: 'vertices', tokensPerUnit: null, secondsPerUnit: null, tokens: null, seconds: null } },
      { kind: 'doc.use-case', area: 'code', subgroup: '', count: 0, page: true, filled: false, state: 'never', estimate: { volume: null, unit: 'vertices', tokensPerUnit: null, secondsPerUnit: null, tokens: null, seconds: null } },
    ], findings: [] }));
    if (url.includes('/api/fill-selection')) return new Response(JSON.stringify({ selection: { selected: [], agent: null, tokenCap: null, savedAt: '' } }));
    return others(url, init);
  };
}

/** The kinds a page lists: one kind's row as the status sends it, and the listing an empty layer answers. */
describe('the empty home', () => {
  const status = (over: Partial<WikiStatus> = {}): WikiStatus => ({
    product: { name: 'shop', id: 'x' }, manifest: 'ok', manifestFile: 'madarch/kinds.yaml', language: 'en', findingCount: 0, kinds: [], groups: [], repositories: [{ name: 'training', filled: false }], filled: false, incomplete: false, fill: { state: 'idle' }, writer: { state: 'idle', agent: null, units: [] }, bounds: { turns: 30, minutes: 10, toolCalls: 80, writeAttempts: 5, maxDomains: 12, editorialRequestsPerPage: 2 }, chosenAgent: null, home: null, ...over,
  });

  test('introduces madarch to a newcomer and offers the fill, and shows no findings block', async () => {
    const calls: string[] = [];
    stubFetch(calls);
    const container = into(createElement(Overview, {
      // The status carries a count, never the list (madarch-8bdc.2.5): one finding of the product's files is one number.
      status: status({ findingCount: 1 }),
      refresh: () => undefined,
    }));
    await until(() => container.querySelector('[data-testid=prefill-card]') !== null, 'the prefill card');
    expect(container.querySelectorAll('[data-testid=prefill-card]')).toHaveLength(1);
    expect(container.textContent).toContain('Product created');
    expect(container.textContent).toContain('The graph is empty');
    expect(container.querySelector('[data-testid=home-guidance]')).toBeNull();
    expect(container.querySelector('[data-testid=findings]')).toBeNull();
  });

  test('a person-authored document kind offers New even when its list is empty', async () => {
    (globalThis as { fetch?: unknown }).fetch = async (url: string) => (url.includes('/api/authored?') ? Response.json({ kind: 'doc.use-case', fields: [{ name: 'title', type: 'text' }], entities: [] }) : new Response(JSON.stringify({ message: 'not here' }), { status: 404 }));
    const kind: KindSummary = { kind: 'doc.use-case', source: 'document', single: false, count: 0, origins: ['person'] };
    // The kind's page asks for the agent spend too; this kind's answer is the empty one an unfilled kind gives.
    const container = into(createElement(KindLabels.Provider, { value: [kind] }, createElement(KindPage, { kind: 'doc.use-case', version: 1 })));
    await until(() => container.querySelector('[data-testid=authored-kind-page]') !== null, 'the authored kind');
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === 'New')).toBe(true);
    expect(container.textContent).not.toContain('No fill stage writes this kind yet.');
  });
});

describe('the fill card', () => {
  const status = (over: Partial<WikiStatus> = {}): WikiStatus => ({
    product: { name: 'shop', id: 'x' }, manifest: 'ok', manifestFile: 'madarch/kinds.yaml', language: 'en', findingCount: 0, kinds: [], groups: [], repositories: [{ name: 'training', filled: false }], filled: false, incomplete: false, fill: { state: 'idle' }, writer: { state: 'idle', agent: null, units: [] }, bounds: { turns: 30, minutes: 10, toolCalls: 80, writeAttempts: 5, maxDomains: 12, editorialRequestsPerPage: 2 }, chosenAgent: null, home: null, ...over,
  });

  test('an empty product with a repository links to the fill page without starting a run', async () => {
    const calls: string[] = [];
    stubFetch(calls);
    const container = into(createElement(FillCard, { status: status(), refresh: () => undefined }));
    await until(() => container.querySelector('[data-testid=prefill-open]') !== null, 'the fill choices button');
    expect(container.textContent).toContain('The graph is empty');
    expect(container.textContent).toContain('Code connected');
    const button = container.querySelector('[data-testid=prefill-open]')!;
    expect(button.tagName).toBe('BUTTON');
    expect(button.textContent).toBe('Fill…');
    expect(container.querySelector('input, select, [data-testid=agent-bound]')).toBeNull();
    expect(calls).toEqual([]);
  });

  test('a product with no repository says to connect one and offers no button that cannot work', async () => {
    const container = into(createElement(FillCard, { status: status({ repositories: [] }), refresh: () => undefined }));
    await until(() => container.querySelector('[data-testid=prefill-open]') !== null, 'the fill choices button');
    expect(container.textContent).toContain('No code repository connected');
    expect(container.textContent).not.toContain('Code connected');
  });

  test('a running fill says which phase it reads and shows a bar; a failed one shows its reason with a way to try again', async () => {
    const running = into(createElement(FillCard, { status: status({ fill: { state: 'running', repository: 'training', phase: 'code', commits: 70 } }), refresh: () => undefined }));
    await until(() => running.querySelector('[role=progressbar]') !== null, 'the bar');
    const bar = running.querySelector('[role=progressbar]')!;
    expect(bar.getAttribute('aria-valuenow')).toBe('30');
    expect(running.textContent).toContain("Repository training: Reading the last commit's code.");
    rendered?.unmount();
    document.body.innerHTML = '';
    const history = into(createElement(FillCard, { status: status({ fill: { state: 'running', repository: 'training', phase: 'history', commits: 70, newCommits: 70 } }), refresh: () => undefined }));
    await until(() => history.querySelector('[role=progressbar]') !== null, 'the bar');
    expect(history.querySelector('[role=progressbar]')!.getAttribute('aria-valuenow')).toBe('75');
    expect(history.textContent).toContain('Reading the history: 70 commits');
    rendered?.unmount();
    document.body.innerHTML = '';
    const older = into(createElement(FillCard, { status: status({ fill: { state: 'running', repository: 'training', commit: 12, commits: 70 } }), refresh: () => undefined }));
    await until(() => older.querySelector('[role=progressbar]') !== null, 'the bar');
    expect(older.textContent).toContain('Repository training: Reading commit 12 of 70.');
    rendered?.unmount();
    document.body.innerHTML = '';
    const failed = into(createElement(FillCard, { status: status({ fill: { state: 'failed', message: 'git failed in the repository' } }), refresh: () => undefined }));
    await until(() => failed.querySelector('[data-state=failed]') !== null, 'the failure');
    expect(failed.textContent).toContain('git failed in the repository');
    expect(failed.textContent).toContain('Fill setup');
  });

  test('a fill that stopped before its last commit says the graph holds part of the history and offers to continue', async () => {
    const container = into(createElement(FillCard, { status: status({ filled: true, incomplete: true }), refresh: () => undefined }));
    await until(() => container.querySelector('[data-state=incomplete]') !== null, 'the card');
    expect(container.textContent).toContain('The fill is not finished');
    expect(container.querySelector('[data-testid=fill-start]')!.textContent).toBe('Fill setup');
  });

  test('a filled product with its home page shows no card', async () => {
    const container = into(createElement(FillCard, { status: status({ filled: true, fill: { state: 'done' }, home: 'product:shop', kinds: [{ kind: 'domain', source: 'markdown', count: 2, single: false, origins: [] }] }), refresh: () => undefined }));
    await new Promise((rest) => setTimeout(rest, 20));
    expect(container.querySelector('[data-testid=fill-card]')).toBeNull();
  });
});

describe('the agent stage', () => {
  const status = (over: Partial<WikiStatus> = {}): WikiStatus => ({
    product: { name: 'shop', id: 'x' }, manifest: 'ok', manifestFile: 'madarch/kinds.yaml', language: 'en', findingCount: 0, kinds: [], groups: [], repositories: [{ name: 'training', filled: false }], filled: false, incomplete: false, fill: { state: 'idle' }, writer: { state: 'idle', agent: null, units: [] }, bounds: { turns: 30, minutes: 10, toolCalls: 80, writeAttempts: 5, maxDomains: 12, editorialRequestsPerPage: 2 }, chosenAgent: null, home: null, ...over,
  });

  test('the empty wiki leaves agent choice and starting the run to the fill page', async () => {
    const calls: string[] = [];
    stubFetch(calls);
    const container = into(createElement(FillCard, { status: status(), refresh: () => undefined }));
    await until(() => container.querySelector('[data-testid=prefill-open]') !== null, 'the fill choices');
    expect(container.querySelector('[data-testid=prefill-open]')!.tagName).toBe('BUTTON');
    expect(container.querySelector('[data-testid=agent-claude-code], [data-testid=agent-codex], [data-testid=agent-bound]')).toBeNull();
    expect(calls).toEqual([]);
  });

  test('a filled product with no pages links to the fill page without fetching or choosing an agent', async () => {
    const calls: string[] = [];
    stubFetch(calls);
    const container = into(createElement(FillCard, { status: status({ filled: true, fill: { state: 'done' } }), refresh: () => undefined }));
    await new Promise((rest) => setTimeout(rest, 20));
    expect(container.querySelector('[data-testid=fill-card], [data-state=offer], [data-testid=prefill-card]')).toBeNull();
    expect(calls).toEqual([]);
  });

  test('the product pages say a stage is under way in one line, with no paths and the way to the fill page', async () => {
    const writer: WikiStatus['writer'] = {
      state: 'running', agent: { id: 'claude-code', label: 'Claude Code' }, current: 'domain:ordering', total: 7,
      units: [
        { unit: 'product:shop', path: 'docs/product.md', state: 'written', calls: 6, writeAttempts: 1 },
        { unit: 'domain:ordering', path: 'docs/domains/ordering.md', state: 'writing' },
      ],
    };
    stubFetch([]);
    const container = into(createElement(FillCard, { status: status({ filled: true, fill: { state: 'done' }, home: 'product:shop', writer }), refresh: () => undefined }));
    await until(() => container.querySelector('[data-testid=writer-line]') !== null, 'the writer line');
    const line = container.querySelector('[data-testid=writer-line]')!;
    // Of the run's seven pages, not of the two taken up so far.
    expect(line.querySelector('[data-testid=writer-line-words]')!.textContent).toBe('Claude Code is writing the pages: 1 of 7 written; now domain:ordering.');
    expect(line.querySelector('[data-testid=writer-line-open]')!.getAttribute('href')).toBe('/fill');
    // The paths of the pages are the engineer's: they are not on the product pages.
    expect(line.textContent).not.toContain('docs/product.md');
    expect(line.querySelectorAll('[data-testid=writer-unit]').length).toBe(0);
  });

  test('before the writer has counted the pages, the line says how many are written and no more', async () => {
    const writer: WikiStatus['writer'] = {
      state: 'running', agent: { id: 'claude-code', label: 'Claude Code' }, current: 'domain:ordering',
      units: [
        { unit: 'product:shop', path: 'docs/product.md', state: 'written', calls: 6, writeAttempts: 1 },
        { unit: 'domain:ordering', path: 'docs/domains/ordering.md', state: 'writing' },
      ],
    };
    stubFetch([]);
    const container = into(createElement(FillCard, { status: status({ filled: true, fill: { state: 'done' }, home: 'product:shop', writer }), refresh: () => undefined }));
    await until(() => container.querySelector('[data-testid=writer-line]') !== null, 'the writer line');
    // No denominator: the two units taken up are not a measure of the run, and half of them would read as nearly done.
    expect(container.querySelector('[data-testid=writer-line-words]')!.textContent).toBe('Claude Code is writing the pages: 1 written; now domain:ordering.');
  });



  // The server projects the saved .32 report into the same durable-run API as new fills.
  const savedRun = {
    runId: 'selective/actual-run', state: 'succeeded', selection: { kinds: ['code.file'], vertex: 'file:checkout' },
    startedAt: '2026-11-10T10:00:00Z', finishedAt: '2026-11-10T10:02:00Z', wallMs: 120000,
    spans: 0, slowest: [], steps: [],
    agentUsage: { lines: [], inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: [], turns: 0, stops: [] },
  };
  const canonicalSaved: SelectionRun = {
    runId: savedRun.runId, state: savedRun.state, selected: null, order: null, vertex: savedRun.selection.vertex, summary: savedRun,
    startedAt: savedRun.startedAt, updatedAt: savedRun.finishedAt, finishedAt: savedRun.finishedAt,
    elapsedMs: savedRun.wallMs, remainingMs: null, units: [], events: [], records: 0, publishedUnits: 0,
    groups: [], agentUsage: savedRun.agentUsage,
  };
  const serveRuns = (runs: SelectionRun[]): void => {
    stubFetch([]);
    const rest = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url.includes('/api/fill-runs?')) return Response.json({ run: runs[0] });
      if (url.endsWith('/api/fill-runs')) return Response.json({ runs });
      return rest(url, init);
    }) as typeof fetch;
  };

  test('the saved selective run stays in history beside a newer active run, without a second progress pane', async () => {
    const newer = { ...canonicalSaved, runId: 'new-active', state: 'running', finishedAt: null };
    serveRuns([canonicalSaved, newer]);
    const held = status({ fill: { state: 'running', runId: newer.runId, run: savedRun } });
    const container = into(createElement(FillPage, { status: held, refresh: () => undefined, version: 0 }));
    await until(() => container.querySelectorAll('[data-testid=fill-history-run]').length === 2, 'both run history entries');
    const rows = container.querySelectorAll('[data-testid=fill-history-run]');
    expect(rows[0]!.querySelector('a')!.getAttribute('href')).toBe('/fill/runs/selective%2Factual-run');
    expect(rows[0]!.textContent).toContain('code.file');
    expect(rows[0]!.textContent).toContain('file:checkout');
    expect(rows[0]!.textContent).toContain('Completed');
    expect(rows[1]!.querySelector('a')!.getAttribute('href')).toBe('/fill/runs/new-active');
    expect(container.querySelector('[data-testid=fill-last-run], [data-testid=fill-progress], [data-testid=fill-units]')).toBeNull();
  });

  test('the saved run detail keeps its selection, real end time and result in Russian', async () => {
    await setWikiLanguage('ru');
    try {
      serveRuns([canonicalSaved]);
      const container = into(createElement(SelectionRunPage, { runId: savedRun.runId, version: 0, refresh: () => undefined }));
      await until(() => container.querySelector('[data-testid=fill-run-page]') !== null, 'the saved run detail');
      expect(container.querySelector('[data-testid=fill-run-page]')!.getAttribute('data-run')).toBe(savedRun.runId);
      expect(container.querySelector('[data-testid=fill-run-selection]')!.textContent).toBe('code.file · file:checkout');
      expect(container.querySelector('[data-testid=fill-run-finished]')!.textContent).toBe(`Завершение: ${new Date(savedRun.finishedAt).toLocaleString('ru')}`);
      expect(container.textContent).toContain(new Date(savedRun.startedAt).toLocaleString('ru'));
      expect(container.textContent).toContain('Завершён');
      expect(container.querySelector('[data-testid=fill-run-controls]')).toBeNull();
      expect(container.querySelectorAll('[data-testid=run-diagnostics]')).toHaveLength(1);
      expect(container.querySelector('[data-testid=run-totals]')!.textContent).toContain('120');
      expect(container.querySelector('[data-testid=run-steps]')).not.toBeNull();
      expect(container.querySelector('[data-testid=run-names]')).not.toBeNull();
    } finally { await setWikiLanguage('en'); }
  });

  test('a failed saved run without selection does not claim every kind was selected', async () => {
    serveRuns([{ ...canonicalSaved, state: 'failed', selected: null, vertex: null, summary: { ...savedRun, selection: undefined } }]);
    const container = into(createElement(SelectionRunPage, { runId: savedRun.runId, version: 0, refresh: () => undefined }));
    await until(() => container.querySelector('[data-testid=fill-run-page]') !== null, 'the failed saved run');
    expect(container.querySelector('[data-testid=fill-run-selection]')!.textContent).toBe('Selection not recorded');
    expect(container.textContent).toContain('Failed');
  });

  test('an ongoing run never invents an end time', async () => {
    serveRuns([{ ...canonicalSaved, state: 'running', finishedAt: null }]);
    const container = into(createElement(SelectionRunPage, { runId: savedRun.runId, version: 0, refresh: () => undefined }));
    await until(() => container.querySelector('[data-testid=fill-run-page]') !== null, 'the ongoing run');
    expect(container.querySelector('[data-testid=fill-run-finished]')).toBeNull();
    expect(container.textContent).not.toContain('Invalid Date');
  });

  test('the fill page honestly shows no history when no run was persisted', async () => {
    serveRuns([]);
    const container = into(createElement(FillPage, { status: status(), version: 0, refresh: () => undefined }));
    await until(() => container.querySelector('[data-testid=fill-runs-loading]') === null && container.querySelector('[data-testid=fill-history]') !== null, 'empty run history');
    expect(container.querySelector('[data-testid=fill-history-run]')).toBeNull();
    expect(container.textContent).toContain('No fill runs yet.');
  });

  test('a stage that ended with a failure says so and links to the fill page to try again', async () => {
    const calls: string[] = [];
    stubFetch(calls);
    const writer: WikiStatus['writer'] = { state: 'failed', agent: { id: 'codex', label: 'Codex' }, units: [{ unit: 'product:shop', path: 'docs/product.md', state: 'failed' }], message: 'some pages were not written; each unit above says why.' };
    const container = into(createElement(FillCard, { status: status({ filled: true, fill: { state: 'done' }, writer }), refresh: () => undefined }));
    await until(() => container.querySelector('[data-testid=writer-retry]') !== null, 'the retry');
    expect(container.querySelector('[data-testid=writer-line]')!.textContent).toContain('Codex did not finish the pages');
    expect(container.querySelector('[data-testid=writer-message]')!.textContent).toContain('some pages were not written');
    const retry = container.querySelector('[data-testid=writer-retry]')!;
    expect(retry.tagName).toBe('A');
    expect(retry.getAttribute('href')).toBe(appPath('/fill'));
    expect(calls).toEqual([]);
  });
});

describe('after the run', () => {
  const status = (over: Partial<WikiStatus> = {}): WikiStatus => ({
    product: { name: 'shop', id: 'x' }, manifest: 'ok', manifestFile: 'madarch/kinds.yaml', language: 'ru', findingCount: 0, kinds: [{ kind: 'domain', source: 'markdown', count: 4, single: false, origins: [] }, { kind: 'product', source: 'markdown', count: 1, single: true, origins: [] }], groups: [], repositories: [{ name: 'training', filled: true }], filled: true, incomplete: false, fill: { state: 'done', finishedAt: '2026-10-23T12:00:00.000Z' }, writer: { state: 'done', agent: { id: 'claude-code', label: 'Claude Code' }, units: [{ unit: 'product:shop', path: 'docs/product.md', state: 'written' }] }, bounds: { turns: 30, minutes: 10, toolCalls: 80, writeAttempts: 5, maxDomains: 12, editorialRequestsPerPage: 2 }, chosenAgent: { id: 'claude-code', label: 'Claude Code' }, home: 'product:shop', ...over,
  });


  test('a failed run stays on the page until the reader dismisses it', async () => {
    stubFetch([]);
    const failed = status({ writer: { state: 'failed', agent: { id: 'codex', label: 'Codex' }, units: [], message: 'x', finishedAt: '2026-10-23T12:00:00.000Z' } });
    const container = into(createElement(WriterLine, { status: failed, refresh: () => undefined }));
    await until(() => container.querySelector('[data-testid=writer-dismiss]') !== null, 'the dismissal');
    (container.querySelector('[data-testid=writer-dismiss]') as HTMLButtonElement).click();
    await until(() => container.querySelector('[data-testid=writer-line]') === null, 'the line gone');
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
      { name: 'Shop', folder: 'shop', href: '/products/shop/', here: true },
      { name: 'Other one', folder: 'other one', href: '/products/other%20one/', here: false },
    ]);
  });
});

describe('there is one app', () => {
  const answer = (manifest: 'ok' | 'not-filled' | 'no-manifest') => async (url: string): Promise<Response> => {
    if (url.endsWith('/api/status')) {
      return new Response(JSON.stringify({ product: { name: 'shop', id: 'x' }, manifest, manifestFile: 'madarch/kinds.yaml', language: 'en', findingCount: 0, kinds: [], groups: [], repositories: [], filled: false, incomplete: false, fill: { state: 'idle' }, writer: { state: 'idle', agent: null, units: [] }, bounds: { turns: 30, minutes: 10, toolCalls: 80, writeAttempts: 5, maxDomains: 12, editorialRequestsPerPage: 2 }, chosenAgent: null, home: null }));
    }
    if (url.endsWith('/api/agents')) return new Response(JSON.stringify({ agents: [], chosen: null }));
    if (url.endsWith('/api/products')) return new Response(JSON.stringify({ products: [] }));
    return new Response(JSON.stringify({ message: 'not here' }), { status: 404 });
  };

  test('the front door opens the knowledge wiki at the root', async () => {
    (globalThis as { fetch?: unknown }).fetch = answer('ok');
    window.history.replaceState({}, '', '/');
    const container = into(createElement(AppRoot));
    await until(() => container.querySelector('[data-testid=knowledge-app]') !== null, 'the knowledge wiki');
    expect(window.location.pathname).toBe('/');
  });

  test('the page scrolls in a bounded region below the toolbar and tab bar', async () => {
    (globalThis as { fetch?: unknown }).fetch = answer('ok');
    window.history.replaceState({}, '', '/');
    const container = into(createElement(AppRoot));
    await until(() => container.querySelector('[data-testid=knowledge-main]') !== null, 'the page');
    const shell = container.querySelector('[data-testid=knowledge-app]')!;
    const fixed = shell.querySelector('[data-testid=shell-fixed]')!;
    const content = shell.querySelector('[data-testid=shell-content]')!;
    const row = content.parentElement!;
    const main = shell.querySelector('[data-testid=knowledge-main]')!;
    for (const name of ['h-dvh', 'overflow-hidden']) expect(shell.classList.contains(name)).toBe(true);
    for (const name of ['flex-1', 'min-h-0', 'overflow-hidden']) expect(row.classList.contains(name)).toBe(true);
    for (const name of ['flex-1', 'min-h-0', 'min-w-0', 'overflow-auto']) expect(content.classList.contains(name)).toBe(true);
    expect(row.parentElement!.classList.contains('min-h-0')).toBe(true);
    expect(fixed.nextElementSibling).toBe(row);
    expect(fixed.classList.contains('shrink-0')).toBe(true);
    expect(fixed.classList.contains('sticky')).toBe(false);
    expect(fixed.querySelector('.shell-toolbar')).not.toBeNull();
    expect(fixed.querySelector('[data-testid=tab-bar]')).not.toBeNull();
    expect(content.contains(main)).toBe(true);
    expect(content.querySelector('.shell-toolbar, [data-testid=tab-bar]')).toBeNull();
    expect(fixed.contains(main)).toBe(false);

    const scrolls: unknown[][] = [];
    (content as HTMLElement).scrollTo = (...args: unknown[]) => { scrolls.push(args); };
    content.scrollTop = 250;
    const destination = frontTab().address === '/catalogue' ? '/fill' : '/catalogue';
    openInNewTab(destination);
    await until(() => scrolls.length > 0, 'the new page resetting its own scroll region');
    expect(scrolls.at(-1)).toEqual([0, 0]);
  });

  test('the loading shell also confines scrolling below its toolbar', async () => {
    (globalThis as { fetch?: unknown }).fetch = () => new Promise<Response>(() => undefined);
    const container = into(createElement(AppRoot));
    await until(() => container.querySelector('[data-testid=wiki-loading]') !== null, 'the loading shell');
    const shell = container.querySelector('[data-testid=wiki-loading]')!;
    const content = shell.querySelector('[data-testid=shell-content]')!;
    expect(shell.classList.contains('h-dvh')).toBe(true);
    expect(shell.classList.contains('overflow-hidden')).toBe(true);
    expect(content.classList.contains('overflow-auto')).toBe(true);
    expect(content.classList.contains('min-h-0')).toBe(true);
    expect(content.querySelector('[data-testid=page-loading]')).not.toBeNull();
    expect(content.querySelector('.shell-toolbar')).toBeNull();
    expect(content.previousElementSibling?.classList.contains('shell-toolbar')).toBe(true);
  });

  test('the old address /?documents opens the knowledge wiki too: no other app stands anywhere', async () => {
    (globalThis as { fetch?: unknown }).fetch = answer('ok');
    window.history.replaceState({}, '', '/?documents');
    const container = into(createElement(AppRoot));
    await until(() => container.querySelector('[data-testid=knowledge-app]') !== null, 'the knowledge wiki');
    expect(window.location.pathname).toBe('/');
  });

  test('a product whose manifest has no kinds is still the knowledge wiki, which says what to do', async () => {
    (globalThis as { fetch?: unknown }).fetch = answer('no-manifest');
    window.history.replaceState({}, '', '/');
    const container = into(createElement(AppRoot));
    await until(() => container.querySelector('[data-testid=no-manifest]') !== null, 'the page that says what to do');
    expect(container.querySelector('[data-testid=knowledge-app]')).not.toBeNull();
  });

  test('a product created and not filled yet says what happened, offers Fill, and presses nothing', async () => {
    const calls: string[] = [];
    const base = answer('not-filled');
    (globalThis as { fetch?: unknown }).fetch = async (url: string) => { calls.push(String(url)); return await base(String(url)); };
    window.history.replaceState({}, '', '/');
    const container = into(createElement(AppRoot));
    await until(() => container.querySelector('[data-testid=not-filled]') !== null, 'the newcomer page');
    expect(container.querySelector('[data-testid=no-manifest]')).toBeNull();
    const page = container.querySelector('[data-testid=not-filled]')!;
    expect(page.textContent).toContain('Product created');
    expect(page.textContent).toContain('The graph is empty');
    expect(page.querySelector('[data-testid=prefill-open]')!.tagName).toBe('BUTTON');
    expect(page.querySelector('[data-testid=manifests-guide]')).toBeNull();
    // Nothing started the fill: the page only offers it.
    expect(calls.some((url) => url.includes('/api/fill'))).toBe(false);
  });

  for (const route of ['/catalogue']) {
    test(`the never-filled product opens ${route} from the published graph`, async () => {
      await setWikiLanguage('en');
      const base = answer('not-filled');
      (globalThis as { fetch?: unknown }).fetch = async (url: string) => {
        if (String(url).endsWith('/api/catalog')) return new Response(JSON.stringify({ product: { name: 'shop', id: 'x' }, language: 'en', groups: [], findings: [], kinds: [
          { kind: 'upstream', subgroup: '', count: 0, page: false, filled: false, state: 'never', labels: { en: { one: 'Upstream', many: 'Upstreams' } } },
          { kind: 'downstream', subgroup: '', count: 0, page: false, filled: false, state: 'never', derivesFrom: ['upstream'], labels: { en: { one: 'Downstream', many: 'Downstreams' } } },
        ] }));
        return await base(String(url));
      };
      window.history.replaceState({}, '', route);
      syncFrontTabAddress();
      const container = into(createElement(AppRoot));
      await until(() => container.querySelector('[data-testid=knowledge-app]') !== null, 'the app');
      window.dispatchEvent(new PopStateEvent('popstate'));
      await until(() => container.querySelector('[data-testid=knowledge-main]')?.textContent?.includes('Downstreams') === true, 'the graph catalogue');
      expect(container.querySelector('[data-testid=not-filled]')).toBeNull();
      expect(container.querySelector('[data-testid=knowledge-main]')!.textContent).toContain('Upstreams');
      window.history.replaceState({}, '', '/');
      syncFrontTabAddress();
    });
  }

  test('a product started from scratch names the file it lacks and links the guide that writes one', async () => {
    (globalThis as { fetch?: unknown }).fetch = answer('no-manifest');
    window.history.replaceState({}, '', '/');
    const container = into(createElement(AppRoot));
    await until(() => container.querySelector('[data-testid=no-manifest]') !== null, 'the no-manifest page');
    const page = container.querySelector('[data-testid=no-manifest]')!;
    expect(page.textContent).toContain('Product created');
    expect(page.textContent).toContain('The graph is empty');
    expect(page.querySelector('[data-testid=prefill-open]')!.tagName).toBe('BUTTON');
  });
});

describe('kind names in the reader\'s language', () => {
  const kinds = [{ kind: 'code.file', source: 'graph' as const, count: 70, single: false, origins: [], labels: { en: { one: 'File', many: 'Files' }, ru: { one: 'Файл', many: 'Файлы' } } }, { kind: 'code.flow', source: 'graph' as const, count: 1, single: false, origins: [] }];
  test('the manifest\'s label of the language is used, its English one for a language it does not name, and the key made readable where it gives none', () => {
    expect(kindNameOf(kinds, 'code.file', 'many', 'ru')).toBe('Файлы');
    expect(kindNameOf(kinds, 'code.file', 'one', 'ru-RU')).toBe('Файл');
    expect(kindNameOf(kinds, 'code.file', 'many', 'en')).toBe('Files');
    expect(kindNameOf(kinds, 'code.flow', 'many', 'ru')).toBe('Flows');
    expect(kindNameOf(kinds, 'code.flow', 'one', 'en')).toBe('Flow');
  });
});

describe('what a reader sees while a page loads', () => {
  test('a skeleton of the page stands where it will be: bars, never a bare line of text', async () => {
    const container = into(createElement(PageSkeleton, { testId: 'page-loading' }));
    await until(() => container.querySelector('[data-testid=page-loading]') !== null, 'the skeleton');
    const region = container.querySelector('[data-testid=page-loading]')!;
    expect(region.getAttribute('aria-busy')).toBe('true');
    expect(region.querySelectorAll('.ui-skeleton').length).toBeGreaterThan(4);
    expect(region.textContent).toBe('');
  });
});

describe('document links', () => {
  test('a relative link to another Markdown document resolves against the document it is in, and keeps its section', () => {
    expect(relativeDocument({ repo: 'shop', path: 'docs/a/b.md' }, '../c.md#intro')).toEqual({ path: 'docs/c.md', anchor: 'intro' });
    expect(relativeDocument({ repo: null, path: 'README.md' }, 'docs/guide.md')).toEqual({ path: 'docs/guide.md' });
    expect(relativeDocument({ repo: null, path: 'docs/a.md' }, '../../outside.md')).toBeNull();
    expect(relativeDocument({ repo: null, path: 'docs/a.md' }, 'https://example.test/x.md')).toBeNull();
    expect(relativeDocument({ repo: null, path: 'docs/a.md' }, 'image.png')).toBeNull();
  });
  test('the routes of the documents list and of one document', () => {
    expect(wikiRouteOf('/docs')).toEqual({ name: 'docs' });
    expect(wikiRouteOf('/doc', '?repo=training&path=docs%2Fa.md')).toEqual({ name: 'doc', repo: 'training', path: 'docs/a.md' });
    expect(addressOfDocument('training', 'docs/a.md', 'uc-2')).toBe('/doc?repo=training&path=docs%2Fa.md#uc-2');
  });
});


describe('a kind\'s listing follows its declaration', () => {
  const summary = (over: Partial<KindSummary>): KindSummary => ({ kind: 'code.operation', source: 'graph', count: 1, single: false, origins: ['code'], ...over });

  test('the operations table is drawn for a kind whose declaration gives it, and the plain table for one that does not', async () => {
    for (const drawn of [true, false]) {
      (globalThis as { fetch?: unknown }).fetch = async (url: string) => (url.startsWith('/api/catalog')
        ? new Response(JSON.stringify({ groups: [], findings: [], kinds: [] }))
        : url.startsWith('/api/entities')
        ? new Response(JSON.stringify({ kind: 'code.operation', total: 1, rows: [{ id: 'code.operation:api.yaml#GET:/items', kind: 'code.operation', label: 'GET /items', href: null }], next: null, ...(drawn ? { operations: {} } : {}) }))
        : url.includes('/api/kind-usage')
          ? new Response(JSON.stringify({ usage: { kind: 'code.operation', runs: [], moreRuns: false, total: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: [], runs: 0 } } }))
          : new Response(JSON.stringify({ renderer: 'mermaid', views: [] })));
      const container = into(createElement(KindLabels.Provider, { value: [summary(drawn ? { listing: 'operations' } : {})] }, createElement(KindPage, { kind: 'code.operation', version: 1 })));
      await until(() => container.querySelector('[data-testid=kind-total]') !== null, 'the kind listing');
      await until(() => container.querySelector(drawn ? '[data-testid=operations-catalogue]' : '[data-entity]') !== null, 'the kind\'s rows');
      // The app holds no kind: the kind summary it receives says which table the kind's page draws, and the plain table
      // of names and places is the other form.
      // The operations catalogue is the operations table, and the plain table of names and places is what a kind without
      // `listing: operations` draws instead.
      expect(container.querySelectorAll('[data-testid=operations-catalogue]').length).toBe(drawn ? 1 : 0);
      // The page is let go before the next form is drawn: a root left mounted asks for its map again when the interface
      // language changes, and its answer would be the stub of the test running then.
      rendered?.unmount();
      rendered = undefined;
      document.body.innerHTML = '';
    }
  });
});
