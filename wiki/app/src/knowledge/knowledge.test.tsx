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
import { setWikiLanguage } from '../i18n.js';
import { BlockView, Findings, KMarkdown } from './blocks.js';
import { highlight } from './highlight.js';
import { Root as AppRoot } from './root.js';
import { FillCard } from './pages.js';
import { WriterLine } from './writer.js';
import { FillPage } from './fill-page.js';
import { FillMenu, ProductSelector, Toolbar, productChoices } from './app.js';
import { addressOfDocument, kRouteOf, kindPlural, kindWord } from './routes.js';
import { kindNameOf } from './kind-names.js';
import { PageSkeleton } from './skeleton.js';
import { relativeDocument } from './blocks.js';
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

  test('a related block with nothing to show draws no section', async () => {
    const container = into(createElement(BlockView, { block: { type: 'related', title: 'Imports', groups: [] }, resolutions: {} }));
    expect(container.querySelector('section')).toBeNull();
    expect(container.textContent).toBe('');
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
    if (url.endsWith('/api/k/agents')) return new Response(JSON.stringify({ agents: OFFERS, chosen: null }));
    return others(url, init);
  };
}

describe('the fill card', () => {
  const status = (over: Partial<WikiStatus> = {}): WikiStatus => ({
    product: { name: 'shop', id: 'x' }, manifest: 'ok', manifestFile: 'madarch/kinds.yaml', language: 'en', seeded: [], findings: [], kinds: [], groups: [], repositories: [{ name: 'training', filled: false }], filled: false, incomplete: false, fill: { state: 'idle' }, writer: { state: 'idle', agent: null, units: [] }, bounds: { turns: 30, minutes: 10, toolCalls: 80, writeAttempts: 5, maxDomains: 12 }, chosenAgent: null, home: null, ...over,
  });

  test('an empty product with a repository says what to do and starts the fill on the press of one button', async () => {
    const calls: string[] = [];
    stubFetch(calls);
    let refreshed = 0;
    const container = into(createElement(FillCard, { status: status(), refresh: () => { refreshed += 1; } }));
    await until(() => container.querySelector('[data-testid=fill-start]') !== null, 'the start button');
    expect(container.textContent).toContain('This wiki is empty');
    expect(container.textContent).toContain('(training)');
    (container.querySelector('[data-testid=fill-start]') as HTMLButtonElement).click();
    await until(() => refreshed === 1, 'the refresh');
    expect(calls).toEqual(['GET /api/k/agents', 'POST /api/k/fill {"agent":null}']);
  });

  test('a refusal of the server is shown in its own words', async () => {
    stubFetch([], () => new Response(JSON.stringify({ message: 'the repositories training are not checked out under repos/: run "madarch bootstrap" first' }), { status: 409 }));
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
    expect(failed.textContent).toContain('Start the fill again');
  });

  test('a fill that stopped before its last commit says the graph holds part of the history and offers to continue', async () => {
    const container = into(createElement(FillCard, { status: status({ filled: true, incomplete: true }), refresh: () => undefined }));
    await until(() => container.querySelector('[data-state=incomplete]') !== null, 'the card');
    expect(container.textContent).toContain('The fill is not finished');
    expect(container.querySelector('[data-testid=fill-start]')!.textContent).toBe('Continue the fill');
  });

  test('a filled product with its home page shows no card', async () => {
    const container = into(createElement(FillCard, { status: status({ filled: true, fill: { state: 'done' }, home: 'product:shop', kinds: [{ kind: 'domain', source: 'markdown', count: 2, single: false, origins: [] }] }), refresh: () => undefined }));
    await new Promise((rest) => setTimeout(rest, 20));
    expect(container.querySelector('[data-testid=fill-card]')).toBeNull();
  });
});

describe('the agent stage', () => {
  const status = (over: Partial<WikiStatus> = {}): WikiStatus => ({
    product: { name: 'shop', id: 'x' }, manifest: 'ok', manifestFile: 'madarch/kinds.yaml', language: 'en', seeded: [], findings: [], kinds: [], groups: [], repositories: [{ name: 'training', filled: false }], filled: false, incomplete: false, fill: { state: 'idle' }, writer: { state: 'idle', agent: null, units: [] }, bounds: { turns: 30, minutes: 10, toolCalls: 80, writeAttempts: 5, maxDomains: 12 }, chosenAgent: null, home: null, ...over,
  });

  test('the empty wiki offers the agents with their state, states the bound in plain words, and one press installs the adapter, saves the choice and starts the fill', async () => {
    const calls: string[] = [];
    stubFetch(calls);
    let refreshed = 0;
    const container = into(createElement(FillCard, { status: status(), refresh: () => { refreshed += 1; } }));
    await until(() => container.querySelector('[data-testid=agent-claude-code]') !== null, 'the agents');
    const claude = container.querySelector('[data-testid=agent-claude-code]')!;
    expect(claude.textContent).toContain('pressing the button below installs @agentclientprotocol/claude-agent-acp 0.93.0 (about 314 MB) into /opt/madarch/agents/claude');
    expect(container.querySelector('[data-testid=agent-codex]')!.textContent).toContain('Codex has no sign-in here');
    const bound = container.querySelector('[data-testid=agent-bound]')!.textContent!;
    expect(bound).toContain('30 turns, 10 minutes, 80 tool calls and 5 refused writes');
    expect(bound).toContain('Nothing runs an agent until you press the button.');
    // With no pick the button is the plain fill; picking an agent makes the same button the whole consent.
    expect(container.querySelector('[data-testid=fill-start]')!.textContent).toBe('Start the fill');
    ((claude.querySelector('input')) as HTMLInputElement).click();
    await until(() => container.querySelector('[data-testid=fill-start]')!.textContent === 'Start the fill and let Claude Code write the pages', 'the button');
    (container.querySelector('[data-testid=fill-start]') as HTMLButtonElement).click();
    await until(() => refreshed === 1, 'the refresh');
    expect(calls).toEqual(['GET /api/k/agents', 'POST /api/k/agent {"agent":"claude-code","install":true}', 'POST /api/k/fill {"agent":"claude-code","language":"en"}']);
  });

  test('a filled product with no pages offers the agent on a card whose button needs a chosen agent', async () => {
    const calls: string[] = [];
    stubFetch(calls);
    const container = into(createElement(FillCard, { status: status({ filled: true, fill: { state: 'done' } }), refresh: () => undefined }));
    await until(() => container.querySelector('[data-state=offer]') !== null, 'the offer');
    expect(container.textContent).toContain('Let an agent write the product pages');
    expect((container.querySelector('[data-testid=fill-start]') as HTMLButtonElement).disabled).toBe(true);
    expect(container.textContent).toContain('Choose Claude Code or Codex to let an agent write.');
    await until(() => calls.includes('GET /api/k/agents'), 'the agent request');
    expect(calls).toEqual(['GET /api/k/agents']);
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
    expect(line.querySelector('[data-testid=writer-line-open]')!.getAttribute('href')).toBe('/k/fill');
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

  test('a page the wiki keeps no journal for has no journal link, though it was written', async () => {
    const writer: WikiStatus['writer'] = {
      state: 'running', agent: { id: 'claude-code', label: 'Claude Code' }, current: 'domain:ordering', startedAt: '2026-10-23T12:31:00.000Z', total: 3,
      units: [
        { unit: 'product:shop', path: 'docs/product.md', state: 'written', calls: 6, writeAttempts: 1, kind: 'product', title: 'Online shop', page: 'product:shop', journal: true },
        { unit: 'domain:ordering', path: 'docs/domains/ordering.md', state: 'written', calls: 4, writeAttempts: 1, kind: 'domain', title: 'Ordering', page: 'domain:ordering', journal: false },
        { unit: 'domain:payments', path: 'docs/domains/payments.md', state: 'written', calls: 3, writeAttempts: 1, kind: 'domain', title: 'Payments', page: 'domain:payments' },
      ],
    };
    stubFetch([]);
    const kinds: WikiStatus['kinds'] = [{ kind: 'product', source: 'markdown', count: 1, single: true, origins: [] }, { kind: 'domain', source: 'markdown', count: 3, single: false, origins: [], labels: { en: { one: 'Domain', many: 'Domains' } } }];
    const container = into(createElement(FillPage, { status: status({ filled: true, fill: { state: 'done' }, home: 'product:shop', kinds, writer }), refresh: () => undefined }));
    await until(() => container.querySelector('[data-testid=fill-units]') !== null, 'the fill page');
    const units = [...container.querySelectorAll('[data-testid=fill-unit]')];
    // The server says which pages have a journal; the page shows the way only to the one that does.
    expect(units.map((unit) => unit.querySelector('[data-testid=fill-unit-journal]') === null)).toEqual([false, true, true]);
    expect(units[0]!.querySelector('[data-testid=fill-unit-journal]')!.getAttribute('href')).toBe('/k/journal?id=product%3Ashop');
  });

  test('the fill page lists each page the agent takes up by its kind and title, its state, its links and the refusals, with the paths for the engineer', async () => {
    const writer: WikiStatus['writer'] = {
      state: 'running', agent: { id: 'claude-code', label: 'Claude Code' }, current: 'domain:ordering', startedAt: '2026-10-23T12:31:00.000Z', total: 5,
      plan: { languageChanged: false, pages: [{ id: 'domain:ordering', path: 'docs/domains/ordering.md', reasons: [] }], unchanged: [], unplaced: [], problems: [] },
      units: [
        { unit: 'product:shop', path: 'docs/product.md', state: 'written', calls: 6, writeAttempts: 1, kind: 'product', title: 'Online shop', page: 'product:shop', journal: true },
        { unit: 'domain:ordering', path: 'docs/domains/ordering.md', state: 'writing', kind: 'domain', title: 'Ordering' },
        { unit: 'domain:payments', path: 'docs/domains/payments.md', state: 'failed', calls: 9, writeAttempts: 5, kind: 'domain', title: 'Payments', refusals: [{ line: 12, rule: 'ungrounded-statement', message: 'the sentence has no footnote' }] },
      ],
    };
    stubFetch([]);
    const kinds: WikiStatus['kinds'] = [{ kind: 'product', source: 'markdown', count: 1, single: true, origins: [] }, { kind: 'domain', source: 'markdown', count: 3, single: false, origins: [], labels: { en: { one: 'Domain', many: 'Domains' } } }];
    const container = into(createElement(FillPage, { status: status({ filled: true, fill: { state: 'done' }, home: 'product:shop', kinds, writer }), refresh: () => undefined }));
    await until(() => container.querySelector('[data-testid=fill-units]') !== null, 'the fill page');
    expect(container.querySelector('[data-testid=fill-title]')!.textContent).toBe('Fill');
    // Of the pages the run means to write (5), not of the three it has taken up so far.
    expect(container.querySelector('[data-testid=fill-progress-text]')!.textContent).toBe('1 of 5 written');
    expect(container.querySelector('[role=progressbar]')!.getAttribute('aria-valuemax')).toBe('5');
    const units = [...container.querySelectorAll('[data-testid=fill-unit]')];
    expect(units.map((unit) => [unit.getAttribute('data-unit'), unit.getAttribute('data-state'), unit.getAttribute('aria-current')])).toEqual([
      ['product:shop', 'written', null], ['domain:ordering', 'writing', 'step'], ['domain:payments', 'failed', null],
    ]);
    // The reader's names: the kind's name from the manifest and the page's title.
    expect(units.map((unit) => unit.querySelector('[data-testid=fill-unit-page], [data-testid=fill-unit-name]')!.textContent)).toEqual(['Product Online shop', 'Domain Ordering', 'Domain Payments']);
    // The written page is a link, and so is its journal where the wiki holds one; a page not written yet has neither.
    expect(units[0]!.querySelector('[data-testid=fill-unit-page]')!.getAttribute('href')).toBe('/k/e/product%3Ashop');
    expect(units[0]!.querySelector('[data-testid=fill-unit-journal]')!.getAttribute('href')).toBe('/k/journal?id=product%3Ashop');
    expect(units[1]!.querySelector('[data-testid=fill-unit-journal]')).toBeNull();
    expect(units[2]!.querySelector('[data-testid=fill-unit-refusals]')!.textContent).toBe('Line 12, ungrounded-statement: the sentence has no footnote');
    // The path and the call counts stand under «Details for an engineer».
    const engineer = units[2]!.querySelector('[data-testid=fill-unit-engineer]')!;
    expect(engineer.querySelector('summary')!.textContent).toBe('Details for an engineer');
    expect(engineer.textContent).toContain('docs/domains/payments.md');
    const outside = units[0]!.cloneNode(true) as HTMLElement;
    outside.querySelector('[data-testid=fill-unit-engineer]')!.remove();
    expect(outside.textContent).not.toContain('docs/product.md');
    // The plan is the engineer's too: the paths stand behind the same summary, shut, so «План» repeats no figure.
    const plan = container.querySelector('[data-testid=fill-plan]')!;
    expect(plan.tagName).toBe('DETAILS');
    expect(plan.hasAttribute('open')).toBe(false);
    expect(plan.querySelector('summary')!.textContent).toBe('Details for an engineer');
    expect(container.textContent).not.toContain('What the refresh will do');
  });

  test('a stage that ended with a failure says so and offers to try again', async () => {
    const calls: string[] = [];
    stubFetch(calls);
    let refreshed = 0;
    const writer: WikiStatus['writer'] = { state: 'failed', agent: { id: 'codex', label: 'Codex' }, units: [{ unit: 'product:shop', path: 'docs/product.md', state: 'failed' }], message: 'some pages were not written; each unit above says why.' };
    const container = into(createElement(FillCard, { status: status({ filled: true, fill: { state: 'done' }, writer }), refresh: () => { refreshed += 1; } }));
    await until(() => container.querySelector('[data-testid=writer-retry]') !== null, 'the retry');
    expect(container.querySelector('[data-testid=writer-line]')!.textContent).toContain('Codex did not finish the pages');
    expect(container.querySelector('[data-testid=writer-message]')!.textContent).toContain('some pages were not written');
    (container.querySelector('[data-testid=writer-retry]') as HTMLButtonElement).click();
    await until(() => refreshed === 1, 'the refresh');
    expect(calls.at(-1)).toBe('POST /api/k/fill {"agent":"codex"}');
  });
});

describe('after the run', () => {
  const status = (over: Partial<WikiStatus> = {}): WikiStatus => ({
    product: { name: 'shop', id: 'x' }, manifest: 'ok', manifestFile: 'madarch/kinds.yaml', language: 'ru', seeded: [], findings: [], kinds: [{ kind: 'domain', source: 'markdown', count: 4, single: false, origins: [] }, { kind: 'product', source: 'markdown', count: 1, single: true, origins: [] }], groups: [], repositories: [{ name: 'training', filled: true }], filled: true, incomplete: false, fill: { state: 'done', finishedAt: '2026-10-23T12:00:00.000Z' }, writer: { state: 'done', agent: { id: 'claude-code', label: 'Claude Code' }, units: [{ unit: 'product:shop', path: 'docs/product.md', state: 'written' }] }, bounds: { turns: 30, minutes: 10, toolCalls: 80, writeAttempts: 5, maxDomains: 12 }, chosenAgent: { id: 'claude-code', label: 'Claude Code' }, home: 'product:shop', ...over,
  });

  test('the card of a finished run is gone: its outcome is a quiet status in the top bar that counts the pages', async () => {
    stubFetch([]);
    const card = into(createElement(WriterLine, { status: status(), refresh: () => undefined }));
    await new Promise((rest) => setTimeout(rest, 20));
    expect(card.querySelector('[data-testid=writer-line]')).toBeNull();
    rendered?.unmount();
    document.body.innerHTML = '';
    const bar = into(createElement(FillMenu, { status: status(), refresh: () => undefined }));
    await until(() => bar.querySelector('[data-testid=fill-chip]') !== null, 'the status');
    expect(bar.querySelector('[data-testid=fill-chip]')!.textContent).toBe('Filled Oct 23, 5 pages');
    // A finished run has no count to keep alone: its whole sentence stays the badge, and its name is the sentence.
    expect(bar.querySelector('[data-testid=fill-chip]')!.className).not.toContain('fill-chip-writing');
    expect(bar.querySelector('[data-testid=fill-chip]')!.getAttribute('aria-label')).toBe('Filled Oct 23, 5 pages');
  });

  test('a failed run stays on the page until the reader dismisses it', async () => {
    stubFetch([]);
    const failed = status({ writer: { state: 'failed', agent: { id: 'codex', label: 'Codex' }, units: [], message: 'x', finishedAt: '2026-10-23T12:00:00.000Z' } });
    const container = into(createElement(WriterLine, { status: failed, refresh: () => undefined }));
    await until(() => container.querySelector('[data-testid=writer-dismiss]') !== null, 'the dismissal');
    (container.querySelector('[data-testid=writer-dismiss]') as HTMLButtonElement).click();
    await until(() => container.querySelector('[data-testid=writer-line]') === null, 'the line gone');
  });

  test('while the agent writes, the badge counts the pages the run means to write and pulses a dot that stands still when motion is reduced', async () => {
    const writer: WikiStatus['writer'] = {
      state: 'running', agent: { id: 'claude-code', label: 'Claude Code' }, current: 'domain:ordering', total: 7,
      units: [
        { unit: 'product:shop', path: 'docs/product.md', state: 'written', kind: 'product', title: 'Online shop', page: 'product:shop' },
        { unit: 'domain:ordering', path: 'docs/domains/ordering.md', state: 'writing', kind: 'domain', title: 'Ordering' },
      ],
    };
    const bar = into(createElement(FillMenu, { status: status({ writer }), refresh: () => undefined }));
    await until(() => bar.querySelector('[data-testid=fill-chip]') !== null, 'the status');
    // 1 of the 7 pages the run means to write, not of the 2 it has taken up so far: the reader sees what is left.
    const chip = bar.querySelector('[data-testid=fill-chip]')!;
    expect(chip.textContent).toBe('The agent is writing · 1/7');
    // The whole sentence stands on the button and in the popover; the badge is split so a phone can keep the count alone.
    expect(chip.getAttribute('aria-label')).toBe('The agent is writing · 1/7');
    expect(chip.className).toContain('fill-chip-writing');
    expect(chip.querySelector('.fill-chip-words')!.textContent).toBe('The agent is writing · ');
    expect(chip.querySelector('.fill-chip-count')!.textContent).toBe('1/7');
    const dot = bar.querySelector('[data-testid=fill-chip-dot]')!;
    expect(dot.getAttribute('aria-hidden')).toBe('true');
    expect(dot.className).toContain('animate-pulse');
    expect(dot.className).toContain('motion-reduce:animate-none');
  });

  test('before the writer has counted the pages, the badge says how many it has written, with no denominator', async () => {
    const writer: WikiStatus['writer'] = {
      state: 'running', agent: { id: 'claude-code', label: 'Claude Code' }, current: 'domain:ordering',
      units: [
        { unit: 'product:shop', path: 'docs/product.md', state: 'written', kind: 'product', title: 'Online shop', page: 'product:shop' },
        { unit: 'domain:ordering', path: 'docs/domains/ordering.md', state: 'writing', kind: 'domain', title: 'Ordering' },
      ],
    };
    const bar = into(createElement(FillMenu, { status: status({ writer }), refresh: () => undefined }));
    await until(() => bar.querySelector('[data-testid=fill-chip]') !== null, 'the status');
    expect(bar.querySelector('[data-testid=fill-chip]')!.textContent).toBe('The agent is writing · 1');
  });

  test('while the fill runs the status says how far it is, and the code is the first thing read', async () => {
    const bar = into(createElement(FillMenu, { status: status({ fill: { state: 'running', commit: 19, commits: 70 } }), refresh: () => undefined }));
    await until(() => bar.querySelector('[data-testid=fill-chip]') !== null, 'the status');
    expect(bar.querySelector('[data-testid=fill-chip]')!.textContent).toBe('Reading commit 19 of 70');
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

describe('there is one app', () => {
  const answer = (manifest: 'ok' | 'no-manifest') => async (url: string): Promise<Response> => {
    if (url.endsWith('/api/k/status')) {
      return new Response(JSON.stringify({ product: { name: 'shop', id: 'x' }, manifest, manifestFile: 'madarch/kinds.yaml', language: 'en', seeded: [], findings: [], kinds: [], groups: [], repositories: [], filled: false, incomplete: false, fill: { state: 'idle' }, writer: { state: 'idle', agent: null, units: [] }, bounds: { turns: 30, minutes: 10, toolCalls: 80, writeAttempts: 5, maxDomains: 12 }, chosenAgent: null, home: null }));
    }
    if (url.endsWith('/api/k/agents')) return new Response(JSON.stringify({ agents: [], chosen: null }));
    if (url.endsWith('/api/k/products')) return new Response(JSON.stringify({ products: [] }));
    return new Response(JSON.stringify({ message: 'not here' }), { status: 404 });
  };

  test('the front door opens the knowledge wiki at /k', async () => {
    (globalThis as { fetch?: unknown }).fetch = answer('ok');
    window.history.replaceState({}, '', '/');
    const container = into(createElement(AppRoot));
    await until(() => container.querySelector('[data-testid=knowledge-app]') !== null, 'the knowledge wiki');
    expect(window.location.pathname).toBe('/k');
  });

  test('the top bar and the tab bar stand in one sticky block, so only the page below them scrolls', async () => {
    (globalThis as { fetch?: unknown }).fetch = answer('ok');
    window.history.replaceState({}, '', '/');
    const container = into(createElement(AppRoot));
    await until(() => container.querySelector('[data-testid=shell-fixed]') !== null, 'the fixed block');
    const fixed = container.querySelector('[data-testid=shell-fixed]')!;
    expect(fixed.className).toContain('sticky');
    expect(fixed.querySelector('.shell-toolbar')).not.toBeNull();
    expect(fixed.querySelector('[data-testid=tab-bar]')).not.toBeNull();
    expect(container.querySelector('[data-testid=knowledge-main]')!.closest('[data-testid=shell-fixed]')).toBeNull();
  });

  test('the old address /?documents opens the knowledge wiki too: no other app stands anywhere', async () => {
    (globalThis as { fetch?: unknown }).fetch = answer('ok');
    window.history.replaceState({}, '', '/?documents');
    const container = into(createElement(AppRoot));
    await until(() => container.querySelector('[data-testid=knowledge-app]') !== null, 'the knowledge wiki');
    expect(window.location.pathname).toBe('/k');
  });

  test('a product whose manifest has no kinds is still the knowledge wiki, which says what to do', async () => {
    (globalThis as { fetch?: unknown }).fetch = answer('no-manifest');
    window.history.replaceState({}, '', '/');
    const container = into(createElement(AppRoot));
    await until(() => container.querySelector('[data-testid=no-manifest]') !== null, 'the page that says what to do');
    expect(container.querySelector('[data-testid=knowledge-app]')).not.toBeNull();
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
    expect(kRouteOf('/k/docs')).toEqual({ name: 'docs' });
    expect(kRouteOf('/k/doc', '?repo=training&path=docs%2Fa.md')).toEqual({ name: 'doc', repo: 'training', path: 'docs/a.md' });
    expect(addressOfDocument('training', 'docs/a.md', 'uc-2')).toBe('/k/doc?repo=training&path=docs%2Fa.md#uc-2');
  });
});

describe('the sync button', () => {
  const status = (over: Partial<WikiStatus> = {}): WikiStatus => ({
    product: { name: 'shop', id: 'x' }, manifest: 'ok', manifestFile: 'madarch/kinds.yaml', language: 'en', seeded: [], findings: [], kinds: [], groups: [], repositories: [{ name: 'training', filled: true }], filled: true, incomplete: false, fill: { state: 'done', finishedAt: '2026-10-27T09:00:00.000Z' }, writer: { state: 'idle', agent: null, units: [] }, bounds: { turns: 30, minutes: 10, toolCalls: 80, writeAttempts: 5, maxDomains: 12 }, chosenAgent: null, home: null, ...over,
  });
  /** The top bar, so the button is proven where the reader sees it, not only as a component of its own. */
  const bar = (state: WikiStatus, refresh: () => void): ReturnType<typeof createElement> => createElement(Toolbar, { status: state, route: { name: 'home' }, menu: null, refresh, products: [], current: 'shop' });

  test('the top bar has a visible Sync button that runs the wiki\'s one refresh, once, and when the run ends lists the changed pages as links', async () => {
    const calls: string[] = [];
    stubFetch(calls);
    let refreshed = 0;
    const container = into(bar(status(), () => { refreshed += 1; }));
    await until(() => container.querySelector('[data-testid=sync]') !== null, 'the sync button');
    const button = container.querySelector('[data-testid=sync]') as HTMLButtonElement;
    expect(button.textContent).toBe('Sync');
    expect(button.disabled).toBe(false);
    // The whole sentence is the button's name, and its icon stands beside the words: below a phone's width the words go
    // and the name stays (madarch-m38l.23).
    expect(button.getAttribute('aria-label')).toBe('Sync');
    expect(button.querySelector('.sync-words')!.textContent).toBe('Sync');
    expect(button.querySelector('.sync-icon')).not.toBeNull();
    button.click();
    await until(() => refreshed === 1, 'the refresh');
    // The press is the refresh the fill menu makes: the same request, the agent saved for the product named.
    expect(calls.filter((call) => call.startsWith('POST '))).toEqual(['POST /api/k/fill {"agent":null}']);
    // While it runs the button is spent and says so.
    rendered!.render(bar(status({ fill: { state: 'running', startedAt: '2026-10-27T09:10:00.000Z', commit: 3, commits: 9 } }), () => { refreshed += 1; }));
    await until(() => (container.querySelector('[data-testid=sync]') as HTMLButtonElement).disabled, 'the spent button');
    expect(container.querySelector('[data-testid=sync]')!.textContent).toBe('Syncing…');
    expect(container.querySelector('[data-testid=sync]')!.getAttribute('aria-label')).toBe('Syncing…');
    // When it ends the changed pages open by themselves, each one a link to its page.
    rendered!.render(bar(status({ fill: { state: 'done', finishedAt: '2026-10-27T09:12:00.000Z', changed: [{ id: 'code.file:src/a.ts', title: 'a.ts' }, { id: 'domain:payment', title: 'Payment' }] } }), () => { refreshed += 1; }));
    await until(() => container.querySelector('[data-testid=sync-changed]') !== null, 'the changed pages');
    const links = [...container.querySelectorAll('[data-testid=sync-changed] a')].map((anchor) => [anchor.textContent, anchor.getAttribute('href')]);
    expect(links).toEqual([
      ['a.ts', appPath(`/k/e/${encodeURIComponent('code.file:src/a.ts')}`)],
      ['Payment', appPath(`/k/e/${encodeURIComponent('domain:payment')}`)],
    ]);
    expect(container.querySelector('[data-testid=sync-count]')!.textContent).toBe('Changed pages: 2');
    // The reader closes it; it stays closed.
    (container.querySelector('[data-testid=sync-close]') as HTMLButtonElement).click();
    await until(() => container.querySelector('[data-testid=sync-result]') === null, 'the closed result');
  });

  test('a run that changed no page says so, in one line', async () => {
    stubFetch([]);
    const container = into(bar(status({ fill: { state: 'done', finishedAt: '2026-10-27T09:00:00.000Z', changed: [] } }), () => undefined));
    await until(() => container.querySelector('[data-testid=sync]') !== null, 'the sync button');
    (container.querySelector('[data-testid=sync]') as HTMLButtonElement).click();
    rendered!.render(bar(status({ fill: { state: 'running', startedAt: '2026-10-27T09:10:00.000Z' } }), () => undefined));
    await until(() => (container.querySelector('[data-testid=sync]') as HTMLButtonElement).disabled, 'the spent button');
    rendered!.render(bar(status({ fill: { state: 'done', finishedAt: '2026-10-27T09:12:00.000Z', changed: [] } }), () => undefined));
    await until(() => container.querySelector('[data-testid=sync-nothing]') !== null, 'the empty result');
    expect(container.querySelector('[data-testid=sync-nothing]')!.textContent).toBe('Nothing changed');
    expect(container.querySelector('[data-testid=sync-changed]')).toBeNull();
  });

  test('the button stands only where a refresh can run: not on the product read as itself, not before a manifest, not over no repository', async () => {
    for (const over of [
      { own: true },
      { manifest: 'no-manifest' as const },
      { filled: false },
      { repositories: [] },
    ]) {
      const container = into(bar(status(over), () => undefined));
      await until(() => container.querySelector('header') !== null, 'the top bar');
      expect(container.querySelector('[data-testid=sync]')).toBeNull();
    }
  });

  test('a run whose enrichment failed shows the writer\'s failure, not an unavailable change list', async () => {
    stubFetch([]);
    const container = into(bar(status(), () => undefined));
    await until(() => container.querySelector('[data-testid=sync]') !== null, 'the sync button');
    (container.querySelector('[data-testid=sync]') as HTMLButtonElement).click();
    rendered!.render(bar(status({ fill: { state: 'running', startedAt: '2026-10-27T09:10:00.000Z' } }), () => undefined));
    await until(() => (container.querySelector('[data-testid=sync]') as HTMLButtonElement).disabled, 'the spent button');
    // The code fill completed; the agent's stage failed. The changed-page list was not recorded, and that is not
    // a reason to tell the reader it could not be listed: the failure is what happened.
    rendered!.render(bar(status({
      fill: { state: 'done', startedAt: '2026-10-27T09:10:00.000Z', finishedAt: '2026-10-27T09:12:00.000Z' },
      writer: { state: 'failed', agent: { id: 'codex', label: 'Codex' }, units: [{ unit: 'product:shop', path: 'docs/product.md', state: 'failed' }], code: 'units', message: 'the product page was not written: the agent refused 5 writes' },
    }), () => undefined));
    await until(() => container.querySelector('[data-testid=sync-result]') !== null, 'the ended result');
    const note = container.querySelector('[data-testid=sync-writer-failed]')!;
    expect(note.querySelector('[data-testid=failure-note]')!.getAttribute('data-code')).toBe('units');
    (note.querySelector('[data-testid=failure-details]') as HTMLButtonElement).click();
    await until(() => note.querySelector('[data-testid=failure-detail]') !== null, 'the failure detail');
    expect(note.querySelector('[data-testid=failure-detail]')!.textContent).toContain('the agent refused 5 writes');
    expect(container.querySelector('[data-testid=sync-unknown]')).toBeNull();
  });

  test('a run that failed opens with its failure and no list', async () => {
    stubFetch([]);
    const container = into(bar(status(), () => undefined));
    await until(() => container.querySelector('[data-testid=sync]') !== null, 'the sync button');
    (container.querySelector('[data-testid=sync]') as HTMLButtonElement).click();
    rendered!.render(bar(status({ fill: { state: 'running', startedAt: '2026-10-27T09:10:00.000Z' } }), () => undefined));
    await until(() => (container.querySelector('[data-testid=sync]') as HTMLButtonElement).disabled, 'the spent button');
    rendered!.render(bar(status({ fill: { state: 'failed', startedAt: '2026-10-27T09:10:00.000Z', finishedAt: '2026-10-27T09:12:00.000Z', code: 'worker-exit', message: 'the fill worker ended with exit code 2' } }), () => undefined));
    await until(() => container.querySelector('[data-testid=sync-result]') !== null, 'the failed result');
    const note = container.querySelector('[data-testid=sync-failed]')!;
    expect(note.querySelector('[data-testid=failure-note]')!.getAttribute('data-code')).toBe('worker-exit');
    (note.querySelector('[data-testid=failure-details]') as HTMLButtonElement).click();
    await until(() => note.querySelector('[data-testid=failure-detail]') !== null, 'the failure detail');
    expect(note.querySelector('[data-testid=failure-detail]')!.textContent).toContain('the fill worker ended with exit code 2');
    expect(container.querySelector('[data-testid=sync-changed]')).toBeNull();
    expect(container.querySelector('[data-testid=sync-nothing]')).toBeNull();
  });
});

describe('the badge and the panel it opens', () => {
  const status = (over: Partial<WikiStatus> = {}): WikiStatus => ({
    product: { name: 'shop', id: 'x' }, manifest: 'ok', manifestFile: 'madarch/kinds.yaml', language: 'en', seeded: [], findings: [], kinds: [], groups: [], repositories: [{ name: 'training', filled: true }], filled: true, incomplete: false, fill: { state: 'done' }, writer: { state: 'done', agent: { id: 'claude-code', label: 'Claude Code' }, units: [{ unit: 'product:shop', path: 'docs/product.md', state: 'written', calls: 6, writeAttempts: 1, kind: 'product', title: 'Online shop', page: 'product:shop', journal: true }] }, bounds: { turns: 30, minutes: 10, toolCalls: 80, writeAttempts: 5, maxDomains: 12 }, chosenAgent: { id: 'claude-code', label: 'Claude Code' }, home: 'product:shop', ...over,
  });
  const running = (): WikiStatus => status({
    writer: {
      state: 'running', agent: { id: 'claude-code', label: 'Claude Code' }, current: 'domain:ordering', total: 5,
      units: [
        { unit: 'product:shop', path: 'docs/product.md', state: 'written', calls: 6, writeAttempts: 1, kind: 'product', title: 'Online shop', page: 'product:shop', journal: true },
        { unit: 'domain:ordering', path: 'docs/domains/ordering.md', state: 'writing', kind: 'domain', title: 'Ordering' },
      ],
    },
  });

  test('Tab on the badge opens the panel and moves into it; Escape shuts it and gives the badge its focus back', async () => {
    stubFetch([]);
    const container = into(createElement(FillMenu, { status: status(), refresh: () => undefined }));
    await until(() => container.querySelector('[data-testid=fill-chip]') !== null, 'the badge');
    const chip = container.querySelector('[data-testid=fill-chip]') as HTMLElement;
    expect(chip.getAttribute('aria-haspopup')).toBe('dialog');
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-testid=fill-menu]')).toBeNull();
    chip.focus();
    chip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    await until(() => container.querySelector('[data-testid=fill-menu]') !== null, 'the panel');
    const panel = container.querySelector('[data-testid=fill-menu]') as HTMLElement;
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    expect(chip.getAttribute('aria-controls')).toBe(panel.id);
    // The focus went in, on the way to the fill page — the panel's first control; the languages come after it.
    await until(() => panel.contains(document.activeElement), 'the focus inside the panel');
    expect(document.activeElement).toBe(panel.querySelector('[data-testid=fill-menu-open]') as HTMLElement);
    const controls = [...panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled])')].map((element) => element.getAttribute('data-testid') ?? `${element.getAttribute('type')}:${element.getAttribute('name')}`);
    expect(controls).toEqual(['fill-menu-open', 'radio:menu-content-language', 'radio:menu-content-language']);
    // The languages are reachable and offered: both radios are enabled with nothing running.
    expect([...panel.querySelectorAll<HTMLInputElement>('[data-testid=menu-language] input')].map((radio) => radio.disabled)).toEqual([false, false]);
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await until(() => container.querySelector('[data-testid=fill-menu]') === null, 'the panel to close');
    expect(document.activeElement).toBe(chip);
    expect(chip.getAttribute('aria-expanded')).toBe('false');
  });

  test('the panel is no taller than the window leaves, opens above a badge near the bottom, and scrolls its words', async () => {
    stubFetch([]);
    const height = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    Object.defineProperty(window, 'innerHeight', { value: 400, configurable: true });
    try {
      const container = into(createElement(FillMenu, { status: running(), refresh: () => undefined }));
      await until(() => container.querySelector('[data-testid=fill-chip]') !== null, 'the badge');
      const chip = container.querySelector('[data-testid=fill-chip]') as HTMLElement;
      const at = (top: number, bottom: number): DOMRect => ({ top, bottom, left: 100, right: 300, width: 200, height: bottom - top, x: 100, y: top, toJSON: () => ({}) }) as DOMRect;
      chip.getBoundingClientRect = () => at(60, 84);
      chip.click();
      await until(() => container.querySelector('[data-testid=fill-menu]') !== null, 'the panel');
      let panel = container.querySelector('[data-testid=fill-menu]') as HTMLElement;
      // What the window leaves below the badge, less a margin: 400 - 84 - 12.
      expect(panel.style.maxHeight).toBe('304px');
      // It hangs from the badge's lower edge and stays where the window scrolls. Its right edge stands on the badge's
      // when that keeps the panel inside the window; here the badge sits at 300 of a 1024 window and the panel is 416
      // wide, so the panel moves left and its right edge is the window's, less the margin and its own width.
      expect(panel.style.position).toBe('fixed');
      expect(panel.style.top).toBe('91px');
      expect(panel.style.bottom).toBe('');
      expect(panel.style.right).toBe(`${window.innerWidth - 8 - 26 * 16}px`);
      expect(panel.className).toContain('overflow-y-auto');
      // The languages are spent while the run is under way.
      expect([...panel.querySelectorAll<HTMLInputElement>('[data-testid=menu-language] input')].map((radio) => radio.disabled)).toEqual([true, true]);
      panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await until(() => container.querySelector('[data-testid=fill-menu]') === null, 'the panel to close');
      // A badge near the bottom of a short window opens its panel upward, and the panel takes the room above it.
      chip.getBoundingClientRect = () => at(300, 380);
      chip.click();
      await until(() => container.querySelector('[data-testid=fill-menu]') !== null, 'the panel above');
      panel = container.querySelector('[data-testid=fill-menu]') as HTMLElement;
      expect(panel.style.top).toBe('');
      expect(panel.style.bottom).toBe(`${400 - 300 + 7}px`);
      expect(panel.style.maxHeight).toBe('288px');
    } finally {
      if (height === undefined) delete (window as unknown as { innerHeight?: number }).innerHeight;
      else Object.defineProperty(window, 'innerHeight', height);
    }
  });
});

describe('a run a person pauses or stops', () => {
  const paused = (over: Partial<WikiStatus> = {}): WikiStatus => ({
    product: { name: 'shop', id: 'x' }, manifest: 'ok', manifestFile: 'madarch/kinds.yaml', language: 'en', seeded: [], findings: [],
    kinds: [{ kind: 'product', source: 'markdown', count: 1, single: true, origins: [] }, { kind: 'domain', source: 'markdown', count: 3, single: false, origins: [], labels: { en: { one: 'Domain', many: 'Domains' } } }],
    groups: [], repositories: [{ name: 'training', filled: true }], filled: true, incomplete: false,
    fill: { state: 'done', finishedAt: '2026-10-23T12:00:00.000Z' },
    writer: {
      state: 'paused', agent: { id: 'claude-code', label: 'Claude Code' }, total: 4,
      units: [
        { unit: 'product:shop', path: 'docs/product.md', state: 'written', kind: 'product', title: 'Online shop', page: 'product:shop' },
        { unit: 'domain:ordering', path: 'docs/domains/ordering.md', state: 'written', kind: 'domain', title: 'Ordering', page: 'domain:ordering' },
        { unit: 'domain:payments', path: 'docs/domains/payments.md', state: 'waiting', kind: 'domain', title: 'Payments' },
      ],
    },
    bounds: { turns: 30, minutes: 10, toolCalls: 80, writeAttempts: 5, maxDomains: 12 }, chosenAgent: { id: 'claude-code', label: 'Claude Code' }, home: 'product:shop', ...over,
  });

  test('the fill page says the run stands paused, and a stop asks first in words that count the pages this run rewrote', async () => {
    const calls: string[] = [];
    stubFetch(calls);
    let refreshed = 0;
    const container = into(createElement(FillPage, { status: paused(), refresh: () => { refreshed += 1; } }));
    await until(() => container.querySelector('[data-testid=fill-run]') !== null, 'the paused run');
    expect(container.querySelector('[data-testid=fill-run-words]')!.textContent).toBe('Paused: 2 of 4 written');
    const controls = container.querySelector('[data-testid=run-controls]')!;
    expect(controls.getAttribute('data-state')).toBe('paused');
    expect([...controls.children].map((child) => child.textContent)).toEqual(['Resume', 'Stop']);
    // «Остановить» asks first, and its words count the pages this run rewrote and say that they stay.
    (container.querySelector('[data-testid=run-stop]') as HTMLButtonElement).click();
    await until(() => container.querySelector('[data-testid=stop-dialog]') !== null, 'the stop question');
    expect(container.querySelector('[data-testid=stop-dialog]')!.getAttribute('role')).toBe('dialog');
    expect(container.querySelector('[data-testid=stop-dialog-words]')!.textContent).toBe('Stopping ends the run now. 2 pages have already been rewritten by this run: they stay as they are, and the page being written now stays as it was before the run.');
    // «Не останавливать» closes the question and sends nothing.
    (container.querySelector('[data-testid=stop-cancel]') as HTMLButtonElement).click();
    await until(() => container.querySelector('[data-testid=stop-dialog]') === null, 'the question to close');
    expect(calls).toEqual([]);
    // The second press ends the run: one request, and the page reads the run again.
    (container.querySelector('[data-testid=run-stop]') as HTMLButtonElement).click();
    await until(() => container.querySelector('[data-testid=stop-confirm]') !== null, 'the confirmation');
    (container.querySelector('[data-testid=stop-confirm]') as HTMLButtonElement).click();
    await until(() => refreshed === 1, 'the refresh');
    expect(calls).toEqual(['POST /api/k/stop {"confirm":true}']);
    // «Продолжить» is the fill's own press, made for the agent this run writes with.
    (container.querySelector('[data-testid=run-resume]') as HTMLButtonElement).click();
    await until(() => refreshed === 2, 'the resume');
    expect(calls.at(-1)).toBe('POST /api/k/fill {"agent":"claude-code"}');
  });

  test('the top bar says the run stands paused, without the dot, and its popover is the same run', async () => {
    stubFetch([]);
    const bar = into(createElement(FillMenu, { status: paused(), refresh: () => undefined }));
    await until(() => bar.querySelector('[data-testid=fill-chip]') !== null, 'the status');
    const chip = bar.querySelector('[data-testid=fill-chip]')!;
    // Above a phone's width the sentences are the badge; below it the words go and «2/4» stands with the pause mark, so
    // a held run keeps the top bar in one row (madarch-m38l.17).
    expect(chip.querySelector('.fill-chip-words')!.textContent).toBe('Paused: 2 of 4 written');
    expect(chip.querySelector('.fill-chip-count')!.textContent).toBe('2/4');
    expect(chip.getAttribute('aria-label')).toBe('Paused: 2 of 4 written');
    const pause = chip.querySelector('[data-testid=fill-chip-pause]')!;
    expect(pause.getAttribute('aria-hidden')).toBe('true');
    expect(pause.className).toContain('fill-chip-state-icon');
    expect(chip.querySelector('[data-testid=fill-chip-dot]')).toBeNull();
    expect(chip.className).not.toContain('fill-chip-writing');
    rendered?.unmount();
    document.body.innerHTML = '';
    // The line over the product's pages is the run under way, not the run a person holds: nothing stands over the pages.
    const line = into(createElement(WriterLine, { status: paused(), refresh: () => undefined }));
    await new Promise((rest) => setTimeout(rest, 20));
    expect(line.querySelector('[data-testid=writer-line]')).toBeNull();
  });

  test('a graph fill with no agent offers Pause and Stop on its page and in the popover', async () => {
    stubFetch([]);
    const graph = paused({
      fill: { state: 'running', startedAt: '2026-10-23T12:00:00.000Z' },
      writer: { state: 'idle', agent: null, units: [] },
      chosenAgent: null,
    });
    const container = into(createElement(FillPage, { status: graph, refresh: () => undefined }));
    await until(() => container.querySelector('[data-testid=fill-code]') !== null, 'the graph fill');
    const controls = container.querySelector('[data-testid=run-controls]');
    expect(controls).not.toBeNull();
    expect(controls!.getAttribute('data-state')).toBe('live');
    expect([...controls!.children].map((child) => child.textContent)).toEqual(['Pause', 'Stop']);
    rendered?.unmount();
    document.body.innerHTML = '';
    // The same run in the top bar, with nothing chosen to write: the popover offers the same two presses.
    const bar = into(createElement(FillMenu, { status: graph, refresh: () => undefined }));
    await until(() => bar.querySelector('[data-testid=fill-chip]') !== null, 'the badge');
    (bar.querySelector('[data-testid=fill-chip]') as HTMLButtonElement).click();
    await until(() => bar.querySelector('[data-testid=fill-menu]') !== null, 'the panel');
    const menu = bar.querySelector('[data-testid=fill-menu] [data-testid=run-controls]');
    expect(menu).not.toBeNull();
    expect([...menu!.children].map((child) => child.textContent)).toEqual(['Pause', 'Stop']);
  });

  test('the top bar says the run was stopped, with its stop mark and the count a phone can read', async () => {
    stubFetch([]);
    const stopped = paused({ fill: { state: 'stopped' }, writer: { ...paused().writer, state: 'stopped' } });
    const bar = into(createElement(FillMenu, { status: stopped, refresh: () => undefined }));
    await until(() => bar.querySelector('[data-testid=fill-chip]') !== null, 'the status');
    const chip = bar.querySelector('[data-testid=fill-chip]')!;
    expect(chip.querySelector('.fill-chip-words')!.textContent).toBe('Stopped: 2 of 4 written; those pages stay');
    expect(chip.querySelector('.fill-chip-count')!.textContent).toBe('2/4');
    expect(chip.getAttribute('aria-label')).toBe('Stopped: 2 of 4 written; those pages stay');
    const stop = chip.querySelector('[data-testid=fill-chip-stop]')!;
    expect(stop.getAttribute('aria-hidden')).toBe('true');
    expect(stop.className).toContain('fill-chip-state-icon');
    expect(chip.querySelector('[data-testid=fill-chip-pause]')).toBeNull();
  });

  test('a run that is under way offers the pause and the stop under its figures, and a stopped run says what it keeps', async () => {
    stubFetch([]);
    const running = paused({ fill: { state: 'running', startedAt: '2026-10-23T12:00:00.000Z' }, writer: { ...paused().writer, state: 'running', current: 'domain:payments' } });
    const container = into(createElement(FillPage, { status: running, refresh: () => undefined }));
    await until(() => container.querySelector('[data-testid=run-controls]') !== null, 'the controls');
    expect(container.querySelector('[data-testid=run-controls]')!.getAttribute('data-state')).toBe('live');
    expect([...container.querySelector('[data-testid=run-controls]')!.children].map((child) => child.textContent)).toEqual(['Pause', 'Stop']);
    rendered!.render(createElement(FillPage, { status: paused({ fill: { state: 'stopped' }, writer: { ...paused().writer, state: 'stopped' } }), refresh: () => undefined }));
    await until(() => container.querySelector('[data-testid=fill-run-words]')?.getAttribute('data-state') === 'stopped', 'the stopped run');
    expect(container.querySelector('[data-testid=fill-run-words]')!.textContent).toBe('Stopped: 2 of 4 written; those pages stay');
    expect(container.querySelector('[data-testid=run-controls]')).toBeNull();
  });
});
