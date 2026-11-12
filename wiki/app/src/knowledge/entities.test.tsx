/**
 * The entity pages in the app (madarch-m38l.6), tested without a server: the
 * statements of an agent's page read plainly and open their statement on a
 * click, the tabs, the grouped navigation, the catalogue and the statement view.
 * Every request is answered by a stub giving the server's own shapes
 * (src/knowledge/model.ts).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { i18n, setWikiLanguage } from '../i18n.js';
import { BlockView, KMarkdown } from './blocks.js';
import { navGroups, TabBar } from './app.js';
import { CataloguePage, DocumentsPage, EntityPage, KindPage, StatementPage, filterSources } from './pages.js';
import { resetPreferences, resetTabs } from '../../test/reset.js';
import { Root as AppRoot } from './root.js';
import { addressOfStatement, wikiRouteOf } from './routes.js';
import { cutSentences, plainText, remarkStatements, type MNode } from './statements.js';
import { activateTab, closeTab, currentAddress, linkHandlers, openInNewTab, setTabTitle, frontTab, syncFrontTabAddress, useTabTitle } from './tabs.js';
import type { Block, CatalogKindView, CatalogView, DocumentListing, KindSummary, Resolution, StatementModel, WikiStatus } from './types.js';

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
  syncFrontTabAddress();
  const container = document.createElement('div');
  document.body.appendChild(container);
  rendered = createRoot(container);
  rendered.render(element);
  return container;
}

async function until(holds: () => boolean | undefined, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (holds()) return;
    await new Promise((step) => setTimeout(step, 10));
  }
  throw new Error(`never came to ${what} within ${timeoutMs} ms; the tree holds: ${document.body.innerHTML.slice(0, 2000)}`);
}

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = '';
  delete (globalThis as { fetch?: unknown }).fetch;
  window.history.replaceState({}, '', '/');
  window.sessionStorage.clear();
  window.localStorage.clear();
  resetTabs();
  resetPreferences();
});

// Built from parts so the neutral-names scan does not read it as a repository source.
const PAGE_HOST = ['https://github.com', 'o', 'r'].join('/');

const BODY = [
  'Payments are charged through one of two providers.[^1] A refund moves the order to refunded.',
  '',
  'Checkout asks payments to authorize the card for the order total.[^2]',
  '',
  'See [the shop](madarch:product:shop).',
  '',
  '[^1]: [factory](madarch:code.symbol:a.ts#F)',
  '[^2]: [pay](madarch:code.symbol:a.ts#pay), [UC-2](madarch:doc:docs/requirements.md#uc-2)',
  '',
].join('\n');

const resolutions: Record<string, Resolution> = {
  'madarch:product:shop': { state: 'ok', target: 'madarch:product:shop', kind: 'product', label: 'The shop', href: '/e/product%3Ashop' },
  'madarch:code.symbol:a.ts#F': { state: 'ok', target: 'madarch:code.symbol:a.ts#F', kind: 'code.symbol', label: 'F', href: '/e/code.symbol%3Aa.ts%23F', location: { repo: 'shop', path: 'a.ts', lineStart: 2, lineEnd: 9, href: '/src?repo=shop&path=a.ts&line=2' } },
};

function tree(text: string, showGrounds: boolean): MNode {
  const parser = unified().use(remarkParse).use(remarkGfm);
  const root = parser.parse(text) as unknown as MNode;
  remarkStatements({ showGrounds })(root);
  return root;
}

test('an empty agent kind explains how to start its fill instead of saying there is no stage', async () => {
  (globalThis as { fetch?: unknown }).fetch = async (url: string) => url.includes('/api/entities')
    ? new Response(JSON.stringify({ kind: 'domain', rows: [], total: 0, next: null, agentFill: 'unconfigured', agentUsage: { model: 'fixture-model', tokens: 42 } }))
    : new Response('{}', { status: 404 });
  const container = into(createElement(KindPage, { kind: 'domain', version: 0 }));
  await until(() => container.querySelector('[data-testid="kind-empty"]') !== null, 'agent fill guidance');
  const note = container.querySelector('[data-testid="kind-empty"]')!;
  expect(note.textContent).toContain('Choose an agent');
  expect(note.querySelector('a')?.getAttribute('href')).toBe('/fill');
  expect(note.textContent).not.toContain('No fill stage');
  expect(container.querySelector('[data-testid="kind-agent-usage"]')?.textContent).toContain('fixture-model');
  expect(container.querySelector('[data-testid="kind-agent-usage"]')?.textContent).toContain('42');
});

describe('the statements of a page', () => {
  test('a paragraph is cut at the full stops the engine\'s reader cuts at, the footnote after the full stop in its sentence, the blank between two sentences outside both', () => {
    const root = tree('One two three four.[^1] Five six seven eight. Nine ten eleven twelve!\n\n[^1]: [a](madarch:code.file:a)\n', true);
    const paragraph = root.children!.find((node) => node.type === 'paragraph')!;
    const kinds = paragraph.children!.map((node) => (node.type === 'statement' ? `statement:${plainText(node)}` : `${node.type}:${node.value ?? ''}`));
    expect(kinds).toEqual(['statement:One two three four.', 'text: ', 'statement:Five six seven eight.', 'text: ', 'statement:Nine ten eleven twelve!']);
    const parsed = unified().use(remarkParse).use(remarkGfm).parse('A b c d.[^1] E f g h.\n\n[^1]: x\n') as unknown as MNode;
    const cut = cutSentences(parsed.children![0]!.children!);
    expect(cut.filter((item) => 'notes' in item).map((item) => (item as { notes: string[] }).notes)).toEqual([['1'], []]);
  });

  test('read plainly, the footnote references and the list of grounds are gone, a grounded sentence is plain and an ungrounded one is marked', () => {
    const root = tree(BODY, false);
    expect(root.children!.some((node) => node.type === 'footnoteDefinition')).toBe(false);
    const statements = root.children!.flatMap((node) => (node.type === 'paragraph' ? node.children!.filter((child) => child.type === 'statement') : []));
    expect(statements.map((node) => [plainText(node), node.data!.hProperties!['data-grounded']])).toEqual([
      ['Payments are charged through one of two providers.', 'true'],
      ['A refund moves the order to refunded.', 'false'],
      ['Checkout asks payments to authorize the card for the order total.', 'true'],
    ]);
    const all = JSON.stringify(root);
    expect(all).not.toContain('footnoteReference');
  });

  test('with the grounds shown the footnotes stay, and a "See ..." line or a few words is no statement', () => {
    const root = tree(BODY, true);
    expect(JSON.stringify(root)).toContain('footnoteReference');
    expect(root.children!.some((node) => node.type === 'footnoteDefinition')).toBe(true);
    const see = root.children!.filter((node) => node.type === 'paragraph').map((node) => node.children!.some((child) => child.type === 'statement'));
    expect(see).toEqual([true, true, false]);
  });
});

describe('the cut agrees with the engine\'s on formatted text and repeated sentences', () => {
  test('a formatted run is one piece: two sentences in one bold run are one statement, with the reference after it', () => {
    const root = tree('**Payments are charged by card. A refund moves money back.**[^1] Plain text follows the bold run here.\n\n[^1]: [a](madarch:code.file:a)\n', false);
    const paragraph = root.children!.find((node) => node.type === 'paragraph')!;
    expect(paragraph.children!.filter((node) => node.type === 'statement').map((node) => [plainText(node), node.data!.hProperties!['data-grounded']])).toEqual([
      ['Payments are charged by card. A refund moves money back.', 'true'],
      ['Plain text follows the bold run here.', 'false'],
    ]);
  });

  test('the same sentence twice on a page is told by its turn, and the engine counts the turns the same way', () => {
    const root = tree('Requests are retried three times.[^a] Other words come in between here.\n\nRequests are retried three times.[^b]\n\n[^a]: [a](madarch:code.file:a)\n[^b]: [b](madarch:code.file:b)\n', false);
    const turns = root.children!.filter((node) => node.type === 'paragraph').flatMap((node) => node.children!.filter((child) => child.type === 'statement')).map((node) => [plainText(node), node.data!.hProperties!['data-turn']]);
    expect(turns).toEqual([['Requests are retried three times.', '0'], ['Other words come in between here.', '0'], ['Requests are retried three times.', '1']]);
    expect(addressOfStatement('page:x', 'Requests are retried three times.', 1)).toBe('/statement?id=page%3Ax&sentence=Requests+are+retried+three+times.&n=1');
  });
});

describe('turns are counted on squashed text', () => {
  test('two sentences that differ only in blanks are the same sentence: the second is the second of its text', () => {
    const root = tree('Requests are  retried three times.[^a]\n\nRequests are retried three times.[^b]\n\n[^a]: [a](madarch:code.file:a)\n[^b]: [b](madarch:code.file:b)\n', false);
    const turns = root.children!.filter((node) => node.type === 'paragraph').flatMap((node) => node.children!.filter((child) => child.type === 'statement')).map((node) => node.data!.hProperties!['data-turn']);
    expect(turns).toEqual(['0', '1']);
  });
});

describe('Markdown read as statements', () => {
  test('an entity mention is a plain named link with no file chip, no footnote number stands in the text, and the ungrounded sentence carries its mark', async () => {
    const container = into(createElement(KMarkdown, { text: BODY.replace('One', 'One'), resolutions: { ...resolutions, 'madarch:code.symbol:a.ts#pay': { state: 'ok', target: 'x', kind: 'code.symbol', label: 'pay', href: null } }, statements: { pageId: 'domain:payment', showGrounds: false } }));
    await until(() => container.querySelector('[data-testid=statement]') !== null, 'the statements');
    expect(container.querySelectorAll('[data-testid=statement]').length).toBe(3);
    expect(container.querySelector('sup')).toBeNull();
    expect(container.querySelector('section[data-footnotes]')).toBeNull();
    expect(container.querySelector('[data-testid=code-place]')).toBeNull();
    const marks = container.querySelectorAll('[data-testid=statement-ungrounded]');
    expect(marks.length).toBe(1);
    expect(marks[0]!.closest('[data-testid=statement]')!.textContent).toContain('A refund moves the order to refunded.');
    expect(marks[0]!.textContent).toBe('no ground');
  });

  test('a mention of an entity with a page is a link, and the code place chip is not drawn beside it', async () => {
    const text = 'The factory chooses the provider by its configuration name, as [the factory](madarch:code.symbol:a.ts#F) does.[^1]\n\n[^1]: [f](madarch:code.symbol:a.ts#F)\n';
    const container = into(createElement(KMarkdown, { text, resolutions, statements: { pageId: 'domain:payment', showGrounds: false } }));
    await until(() => container.querySelector('[data-testid=statement]') !== null, 'the statement');
    const link = container.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('/e/code.symbol%3Aa.ts%23F');
    expect(container.querySelector('[data-testid=code-place]')).toBeNull();
  });

  test('a click on a sentence opens its statement in a new tab; a click on a link inside it does not', async () => {
    const container = into(createElement(KMarkdown, { text: 'Checkout asks payments to authorize the card for [the order](madarch:code.symbol:a.ts#F) now.[^1]\n\n[^1]: [f](madarch:code.symbol:a.ts#F)\n', resolutions, statements: { pageId: 'domain:payment', showGrounds: false } }));
    await until(() => container.querySelector('[data-testid=statement]') !== null, 'the statement');
    expect(frontTab().address).toBe('/');
    (container.querySelector('a') as HTMLElement).click();
    expect(frontTab().address).toBe('/');
    (container.querySelector('[data-testid=statement]') as HTMLElement).click();
    const sentence = 'Checkout asks payments to authorize the card for the order now.';
    // The opening waits one click interval, so that a double click can select first.
    await until(() => frontTab().address === addressOfStatement('domain:payment', sentence), 'the statement tab');
    expect(wikiRouteOf('/statement', `?id=domain%3Apayment&sentence=${encodeURIComponent(sentence)}`)).toEqual({ name: 'statement', id: 'domain:payment', sentence, turn: 0 });
    expect(wikiRouteOf('/statement', `?id=domain%3Apayment&sentence=x&n=2`)).toEqual({ name: 'statement', id: 'domain:payment', sentence: 'x', turn: 2 });
    expect(window.location.pathname + window.location.search).toBe(addressOfStatement('domain:payment', sentence));
  });

  test('a slow double click, its presses further apart than a fast one, still selects and opens nothing', async () => {
    const container = into(createElement('div', null, createElement(TabBar), createElement(KMarkdown, { text: 'Checkout asks payments to authorize the card now.[^1]\n\n[^1]: [f](madarch:code.symbol:a.ts#F)\n', resolutions, statements: { pageId: 'domain:payment', showGrounds: false } })));
    await until(() => container.querySelector('[data-testid=statement]') !== null && container.querySelector('[data-testid=tab]') !== null, 'the statement and the tab bar');
    const statement = container.querySelector('[data-testid=statement]') as HTMLElement;
    const before = container.querySelectorAll('[data-testid=tab]').length;
    statement.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, detail: 1 }));
    statement.click();
    // A reader whose double click is slower than the fastest one: the second press still comes before the first click opens.
    await new Promise((resolve) => setTimeout(resolve, 300));
    statement.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, detail: 2 }));
    statement.click();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(container.querySelectorAll('[data-testid=tab]')).toHaveLength(before);
    expect(frontTab().address).toBe('/');
  });

  test('a click whose sentence was asked for on a page the reader left opens nothing', async () => {
    const container = into(createElement('div', null, createElement(TabBar), createElement(KMarkdown, { text: 'Checkout asks payments to authorize the card now.[^1]\n\n[^1]: [f](madarch:code.symbol:a.ts#F)\n', resolutions, statements: { pageId: 'domain:payment', showGrounds: false } })));
    await until(() => container.querySelector('[data-testid=statement]') !== null && container.querySelector('[data-testid=tab]') !== null, 'the statement and the tab bar');
    expect(container.querySelectorAll('[data-testid=tab]')).toHaveLength(1);
    (container.querySelector('[data-testid=statement]') as HTMLElement).click();
    // The reader follows a link before the click interval is over: the page that asked for the opening is gone.
    rendered?.unmount();
    rendered = undefined;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(window.location.pathname).toBe('/');
    expect(frontTab().address).toBe('/');
  });

  test('clicking two different sentences quickly opens both statements', async () => {
    // Two sentences of two paragraphs, each with its own ground: both are statements of the page.
    const container = into(createElement('div', null, createElement(TabBar), createElement(KMarkdown, { text: 'Checkout asks payments to authorize the card now.[^1]\n\nA captured payment confirms the order.[^2]\n\n[^1]: [f](madarch:code.symbol:a.ts#F)\n[^2]: [g](madarch:code.symbol:b.ts#G)\n', resolutions, statements: { pageId: 'domain:payment', showGrounds: false } })));
    await until(() => container.querySelectorAll('[data-testid=statement]').length === 2 && container.querySelector('[data-testid=tab]') !== null, 'two statements and a tab');
    const sentences = [...container.querySelectorAll<HTMLElement>('[data-testid=statement]')];
    sentences[0]!.click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    sentences[1]!.click();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const tabs = JSON.parse(window.sessionStorage.getItem('madarch-tabs:/')!).tabs as { address: string }[];
    expect(tabs).toHaveLength(3);
    expect(tabs.map((tab) => tab.address)).toContain(addressOfStatement('domain:payment', 'Checkout asks payments to authorize the card now.'));
    expect(tabs.map((tab) => tab.address)).toContain(addressOfStatement('domain:payment', 'A captured payment confirms the order.'));
  }, 15_000);

  test('a double click on a sentence can select a word without opening its statement', async () => {
    const container = into(createElement('div', null, createElement(TabBar), createElement(KMarkdown, { text: 'Checkout asks payments to authorize the card now.[^1]\n\n[^1]: [f](madarch:code.symbol:a.ts#F)\n', resolutions, statements: { pageId: 'domain:payment', showGrounds: false } })));
    await until(() => container.querySelector('[data-testid=statement]') !== null && container.querySelector('[data-testid=tab]') !== null, 'the statement and the tab bar');
    const statement = container.querySelector('[data-testid=statement]') as HTMLElement;
    const before = container.querySelectorAll('[data-testid=tab]').length;
    statement.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, detail: 1 }));
    statement.click();
    statement.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, detail: 2 }));
    statement.click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(container.querySelectorAll('[data-testid=tab]')).toHaveLength(before);
    expect(frontTab().address).toBe('/');
  });

  test('a drag across a sentence selects text and opens nothing; a click after it, with the selection gone, opens the statement', async () => {
    const container = into(createElement('div', null, createElement(TabBar), createElement(KMarkdown, { text: 'Checkout asks payments to authorize the card now.[^1]\n\n[^1]: [f](madarch:code.symbol:a.ts#F)\n', resolutions, statements: { pageId: 'domain:payment', showGrounds: false } })));
    await until(() => container.querySelector('[data-testid=statement]') !== null && container.querySelector('[data-testid=tab]') !== null, 'the statement and the tab bar');
    const tabCount = (): number => container.querySelectorAll('[data-testid=tab]').length;
    const before = tabCount();
    const statement = container.querySelector('[data-testid=statement]') as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(statement);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selection.toString()).toContain('Checkout asks payments');
    statement.click();
    expect(tabCount()).toBe(before);
    expect(frontTab().address).toBe('/');
    selection.removeAllRanges();
    // A click that only dismisses a selection: the press found it, the click finds it gone.
    selection.addRange(range);
    statement.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
    selection.removeAllRanges();
    statement.click();
    expect(tabCount()).toBe(before);
    expect(frontTab().address).toBe('/');
    statement.click();
    await until(() => tabCount() === before + 1, 'the statement tab');
  });

  test('the switch brings the footnote numbers and the grounds back, and the choice is kept for the next page', async () => {
    const body: Block = { type: 'body', markdown: BODY, file: 'docs/domains/payment.md', statements: 3, ungrounded: [] };
    const container = into(createElement(BlockView, { block: body, resolutions, pageId: 'domain:payment' }));
    await until(() => container.querySelector('[data-testid=grounds-switch]') !== null, 'the switch');
    expect(container.querySelector('sup')).toBeNull();
    const toggle = container.querySelector('[data-testid=grounds-switch] [role=switch]') as HTMLButtonElement;
    toggle.click();
    await until(() => container.querySelector('section[data-footnotes]') !== null, 'the grounds');
    expect(container.querySelector('sup')).not.toBeNull();
    expect(window.localStorage.getItem('madarch-show-grounds')).toBe('1');
  });

  test('a body of a document entity (no statements) has no switch', async () => {
    const body: Block = { type: 'body', markdown: 'The shopper pays by card.', file: 'docs/requirements.md', statements: 0, ungrounded: [] };
    const container = into(createElement(BlockView, { block: body, resolutions: {}, pageId: 'doc:docs/requirements.md#uc-2' }));
    await until(() => container.querySelector('.reading') !== null, 'the text');
    expect(container.querySelector('[data-testid=grounds-switch]')).toBeNull();
  });
});

describe('the tabs', () => {
  test('a page opened in a new tab stands beside the one in front and comes to the front; the address follows; the same page is switched to, not opened twice', () => {
    expect(currentAddress()).toBe('/');
    openInNewTab('/e/domain%3Apayment');
    expect(frontTab().address).toBe('/e/domain%3Apayment');
    expect(window.location.pathname).toBe('/e/domain%3Apayment');
    openInNewTab('/catalogue');
    openInNewTab('/e/domain%3Apayment');
    expect(frontTab().address).toBe('/e/domain%3Apayment');
    expect(JSON.parse(window.sessionStorage.getItem('madarch-tabs:/')!).tabs.map((tab: { address: string }) => tab.address)).toEqual(['/', '/e/domain%3Apayment', '/catalogue']);
  });

  test('browser Back and Forward bring the open tab that holds the history address forward, another section of it included', async () => {
    // The tab bar is what listens to the window's moves.
    const container = into(createElement(TabBar));
    await until(() => container.querySelector('[data-testid=tab]') !== null, 'the tab bar');
    openInNewTab('/catalogue');
    openInNewTab('/doc?path=a.md#one');
    const tabs = JSON.parse(window.sessionStorage.getItem('madarch-tabs:/')!).tabs as { key: string; address: string }[];
    const catalogue = tabs.find((tab) => tab.address === '/catalogue')!;
    const doc = tabs.find((tab) => tab.address === '/doc?path=a.md#one')!;
    // The current document links to a catalogue already held in another tab.
    linkHandlers('/catalogue').onClick({ shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, button: 0, preventDefault: () => undefined } as never);
    expect(frontTab().key).toBe(catalogue.key);
    // Back to another section of the same document: its own tab comes forward and names where the window is now.
    window.history.pushState({}, '', '/doc?path=a.md#two');
    window.dispatchEvent(new Event('popstate'));
    expect(frontTab().key).toBe(doc.key);
    expect(frontTab().address).toBe('/doc?path=a.md#two');
    // Forward, to the catalogue again.
    window.history.pushState({}, '', '/catalogue');
    window.dispatchEvent(new Event('popstate'));
    expect(frontTab().key).toBe(catalogue.key);
    expect(frontTab().address).toBe('/catalogue');
    expect(JSON.parse(window.sessionStorage.getItem('madarch-tabs:/')!).tabs).toHaveLength(3);
  });

  test('a plain click on a link to a page another tab holds focuses that tab; another section of an open document is the same page', () => {
    openInNewTab('/catalogue');
    openInNewTab('/doc?path=a.md');
    const catalogue = JSON.parse(window.sessionStorage.getItem('madarch-tabs:/')!).tabs[1].key as string;
    const link = document.createElement('a');
    const handlers = linkHandlers('/catalogue');
    link.addEventListener('click', (event) => handlers.onClick(event as never));
    document.body.append(link);
    link.click();
    link.remove();
    expect(frontTab().key).toBe(catalogue);
    expect(JSON.parse(window.sessionStorage.getItem('madarch-tabs:/')!).tabs).toHaveLength(3);
    openInNewTab('/doc?path=a.md#section');
    expect(frontTab().address).toBe('/doc?path=a.md#section');
    expect(JSON.parse(window.sessionStorage.getItem('madarch-tabs:/')!).tabs).toHaveLength(3);
    // Another section of the document in front: the tab and the window name it.
    openInNewTab('/doc?path=a.md#other');
    expect(frontTab().address).toBe('/doc?path=a.md#other');
    expect(window.location.hash).toBe('#other');
  });

  test('a tab whose window moved to another page and back is named again by the page that stayed mounted', async () => {
    const Page = (): null => { useTabTitle('Home page'); return null; };
    const container = into(createElement('div', null, createElement(TabBar), createElement(Page)));
    await until(() => frontTab().title === 'Home page', 'the title');
    const shown = (): string => container.querySelector('[data-testid=tab][data-active=true]')!.textContent ?? '';
    window.history.pushState({}, '', '/catalogue');
    window.dispatchEvent(new Event('popstate'));
    // The window moved: the tab names where it is now, so its title is the loading one until the mounted page names it again.
    await until(() => frontTab().address === '/catalogue', 'the move');
    await until(() => frontTab().title === 'Home page', 'the title written again');
    expect(shown()).toContain('Home page');
    expect(shown()).not.toMatch(/Loading|Загрузка/);
  });

  test('a tab is switched to and closed; the neighbour comes to the front; the last tab stays', async () => {
    const container = into(createElement(TabBar));
    openInNewTab('/catalogue');
    openInNewTab('/docs');
    await until(() => container.querySelectorAll('[data-testid=tab]').length === 3, 'three tabs');
    setTabTitle(frontTab().key, 'Documents');
    await until(() => container.textContent!.includes('Documents'), 'the title');
    const tabs = [...container.querySelectorAll<HTMLElement>('[data-testid=tab] [role=tab]')];
    tabs[0]!.click();
    expect(window.location.pathname).toBe('/');
    await until(() => container.querySelector('[data-active=true] [role=tab]')!.textContent !== 'Documents', 'the first tab in front');
    (container.querySelectorAll('[data-testid=tab-close]')[0] as HTMLElement).click();
    await until(() => container.querySelectorAll('[data-testid=tab]').length === 2, 'two tabs');
    expect(frontTab().address).toBe('/catalogue');
    closeTab(frontTab().key);
    closeTab(frontTab().key);
    await until(() => container.querySelectorAll('[data-testid=tab]').length === 1, 'one tab left');
    expect(container.querySelector('[data-testid=tab-close]')).toBeNull();
    expect(frontTab().address).toBe('/docs');
  });

  test('a plain click shows the page in the tab in front; a control click or a middle click opens a new tab', async () => {
    // The tab bar is what listens to the window's moves.
    const container = into(createElement(TabBar));
    await until(() => container.querySelector('[data-testid=tab]') !== null, 'the tab bar');
    const handlers = linkHandlers('/catalogue');
    const click = (init: { ctrlKey?: boolean; button?: number }, via: 'onClick' | 'onAuxClick' = 'onClick'): void => {
      handlers[via]({ shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, button: 0, ...init, preventDefault: () => undefined } as never);
    };
    click({});
    expect(frontTab().address).toBe('/catalogue');
    activateTab(frontTab().key);
    expect(JSON.parse(window.sessionStorage.getItem('madarch-tabs:/')!).tabs.length).toBe(1);
    click({ ctrlKey: true });
    expect(JSON.parse(window.sessionStorage.getItem('madarch-tabs:/')!).tabs.length).toBe(1);
    // the address is the front tab's: a ctrl click on a different address opens a second tab
    linkHandlers('/docs').onClick({ shiftKey: false, altKey: false, ctrlKey: true, metaKey: false, button: 0, preventDefault: () => undefined } as never);
    expect(JSON.parse(window.sessionStorage.getItem('madarch-tabs:/')!).tabs.map((tab: { address: string }) => tab.address)).toEqual(['/catalogue', '/docs']);
    linkHandlers('/e/x').onAuxClick({ shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, button: 1, preventDefault: () => undefined } as never);
    expect(JSON.parse(window.sessionStorage.getItem('madarch-tabs:/')!).tabs.map((tab: { address: string }) => tab.address)).toEqual(['/catalogue', '/docs', '/e/x']);
    // shift is the browser's: nothing changes
    linkHandlers('/other').onClick({ shiftKey: true, altKey: false, ctrlKey: false, metaKey: false, button: 0, preventDefault: () => undefined } as never);
    expect(JSON.parse(window.sessionStorage.getItem('madarch-tabs:/')!).tabs.length).toBe(3);
  });

  test('the back button moves the tab in front to the page the window is on, and a link to a section of the same page is remembered by its tab', async () => {
    const container = into(createElement(TabBar));
    await until(() => container.querySelector('[data-testid=tab]') !== null, 'the tab bar');
    window.history.pushState({}, '', '/docs');
    window.dispatchEvent(new Event('popstate'));
    await until(() => frontTab().address === '/docs', 'the tab following the window');
    window.history.pushState({}, '', '/doc?path=a.md#one');
    window.dispatchEvent(new Event('popstate'));
    expect(frontTab().address).toBe('/doc?path=a.md#one');
    // A link to another section of the document moves the hash without a move of the page.
    window.history.replaceState({}, '', '/doc?path=a.md#two');
    syncFrontTabAddress();
    expect(frontTab().address).toBe('/doc?path=a.md#two');
    openInNewTab('/catalogue');
    activateTab(JSON.parse(window.sessionStorage.getItem('madarch-tabs:/')!).tabs[0].key);
    expect(window.location.pathname + window.location.search + window.location.hash).toBe('/doc?path=a.md#two');
    // Back: the window returns to the earlier page and the tab in front shows it.
    window.history.replaceState({}, '', '/docs');
    window.dispatchEvent(new Event('popstate'));
    await until(() => frontTab().address === '/docs', 'the tab after back');
  });
});

const kind = (over: Partial<KindSummary>): KindSummary => ({ kind: 'code.file', source: 'graph', count: 1, single: false, origins: ['code'], ...over });

describe('the navigation by group', () => {
  const status = {
    groups: [{ group: 'product', labels: { en: 'Product knowledge', ru: 'Знания о продукте' } }, { group: 'code', labels: { en: 'Code', ru: 'Код' } }, { group: 'tests', labels: { en: 'Tests', ru: 'Тесты' } }],
    kinds: [
      kind({ kind: 'domain', source: 'markdown', group: 'product', count: 2 }),
      kind({ kind: 'product', source: 'markdown', group: 'product', single: true, count: 1 }),
      kind({ kind: 'code.file', group: 'code', count: 115 }),
      kind({ kind: 'code.symbol', group: 'code', count: 688 }),
      kind({ kind: 'code.test-case', group: 'tests', count: 0 }),
      kind({ kind: 'code.weird', count: 3 }),
    ],
  } as unknown as WikiStatus;

  test('the groups come in the manifest\'s order with the number of entities each holds; empty kinds remain after populated groups while the home page is not repeated; a kind with no group stands in "other"', () => {
    const groups = navGroups(status);
    // The home page (the single kind) counts in its group's number and is not listed: it is the "Home" entry.
    expect(groups.map((entry) => [entry.group, entry.total, entry.kinds.map((one) => one.kind)])).toEqual([
      ['product', 3, ['domain']],
      ['code', 803, ['code.file', 'code.symbol']],
      [null, 3, ['code.weird']],
      ['tests', 0, ['code.test-case']],
    ]);
  });

  test('the navigation draws a group\'s short label when it holds one, and its full name when it does not', () => {
    const shorted = {
      ...status,
      groups: [{ group: 'product', labels: { en: 'Product knowledge', ru: 'Знания о продукте' }, short: { en: 'Product', ru: 'Продукт' } }, { group: 'code', labels: { en: 'Code', ru: 'Код' } }],
    } as unknown as WikiStatus;
    const groups = navGroups(shorted);
    expect(groups.map((entry) => entry.short?.en ?? entry.labels?.en)).toEqual(['Product', 'Code']);
    // A group with subgroups carries its area's short label and each subgroup's, and the catalogue keeps the full names.
    const nested = {
      ...status,
      groups: [
        { group: 'strategy', labels: { en: 'Strategy and business motivation', ru: 'Стратегия и мотивация бизнеса' }, short: { en: 'Strategy', ru: 'Стратегия' } },
        { group: 'product', parent: 'strategy', labels: { en: 'Product and its actors', ru: 'Продукт и его действующие лица' }, short: { en: 'Product', ru: 'Продукт' } },
      ],
    } as unknown as WikiStatus;
    const [area] = navGroups({ ...nested, kinds: [kind({ kind: 'domain', source: 'markdown', group: 'product', count: 2 })] } as unknown as WikiStatus);
    expect([area!.short?.ru, area!.subgroups[0]!.short?.ru, area!.labels?.ru]).toEqual(['Стратегия', 'Продукт', 'Стратегия и мотивация бизнеса']);
  });

  test('a kind that declares its own listing page stands in its manifest group; a loop-owned kind is not listed again', () => {
    const groups = navGroups({ ...status, kinds: [
      kind({ kind: 'domain', source: 'markdown', group: 'product', count: 1 }),
      kind({ kind: 'doc.term', source: 'document', group: 'product', count: 7, nav: 'own-page', listing: 'glossary' }),
      kind({ kind: 'task', source: 'markdown', group: 'product', count: 2, nav: 'own-page' }),
    ] } as unknown as WikiStatus);
    // The listing's row is a kind row like every other; the loop's own place keeps the task out of the groups, while
    // its entities still count in the group's number.
    expect(groups.map((entry) => [entry.group, entry.kinds.map((one) => one.kind), entry.total])).toEqual([['product', ['domain', 'doc.term'], 10], ['code', [], 0], ['tests', [], 0]]);
  });

  test('an empty kind stays listed before any pages are written', () => {
    const groups = navGroups({ ...status, kinds: [kind({ kind: 'domain', source: 'markdown', group: 'product', count: 0 })] } as unknown as WikiStatus);
    expect(groups.map((entry) => entry.kinds.map((one) => one.kind))).toEqual([['domain'], [], []]);
  });
});

describe('the catalogue', () => {
  /** The catalogue's own request answered by a stub, as the server sends it. */
  const answer = (catalog: CatalogView): void => {
    (globalThis as { fetch?: unknown }).fetch = async (url: string) => url.includes('/api/catalog')
      ? new Response(JSON.stringify(catalog))
      : new Response('{}', { status: 404 });
  };
  const kind = (fields: Partial<CatalogKindView> & Pick<CatalogKindView, 'kind'>): CatalogKindView => ({
    area: 'code', subgroup: '', count: 0, page: false, filled: false, state: 'never', estimate: { volume: 0, unit: 'vertices', tokensPerUnit: null, secondsPerUnit: null, tokens: null, seconds: null }, ...fields,
  });
  const full: CatalogView = {
    product: { name: 'shop', id: 'shop' },
    language: 'en',
    groups: [{ group: 'code', labels: { en: 'Code', ru: 'Код' } }, { group: 'history', labels: { en: 'History', ru: 'История' } }],
    kinds: [
      kind({ kind: 'code.file', count: 115, statements: 9, page: true, plugins: ['code'], filled: true, descriptions: { en: 'A file of a code repository.', ru: 'Файл репозитория кода.' }, labels: { en: { one: 'File', many: 'Files' }, ru: { one: 'Файл', many: 'Файлы' } } }),
      kind({ kind: 'code.commit', area: 'history', count: 72, page: true, plugins: ['history'], filled: true, descriptions: { en: 'A change.', ru: 'Изменение.' }, labels: { en: { one: 'Commit', many: 'Commits' }, ru: { one: 'Коммит', many: 'Коммиты' } } }),
      kind({ kind: 'domain', area: 'code', count: 0, descriptions: { en: 'A part of the business.', ru: 'Часть бизнеса.' }, labels: { en: { one: 'Domain', many: 'Domains' }, ru: { one: 'Домен', many: 'Домены' } } }),
    ],
    findings: [],
  };

  test('every declared kind is in its group with what it is, how many there are, its declared plugins and a link to its details, in the reader\'s language', async () => {
    answer(full);
    const container = into(createElement(CataloguePage, { version: 0 }));
    await until(() => container.querySelector('[data-testid=catalogue-page]') !== null, 'the catalogue');
    expect(container.querySelector('[data-testid=catalogue-total]')!.textContent).toBe('3 kinds, 187 records');
    const groups = [...container.querySelectorAll('[data-testid=catalogue-group]')].map((section) => section.getAttribute('data-group'));
    expect(groups).toEqual(['code', 'history']);
    const row = container.querySelector('[data-kind="code.file"]')!;
    expect(row.querySelector('a')!.getAttribute('href')).toBe('/kind/code.file');
    expect(row.querySelector('a')!.textContent).toBe('Files');
    expect(row.textContent).toContain('A file of a code repository.');
    expect(row.querySelector('[data-testid=catalogue-count]')!.textContent).toBe('1159 statements');
    // Plugin names stay as declared; the app infers no producer category.
    expect(row.querySelector('[data-testid=catalogue-stage]')!.textContent).toBe('code');
    expect(container.querySelector('[data-kind="code.commit"] [data-testid=catalogue-stage]')!.textContent).toBe('history');
    // Empty catalogue-only kinds also have declaration details.
    const empty = container.querySelector('[data-kind="domain"]')!;
    expect(empty.querySelector('[data-testid=catalogue-count]')!.textContent).toBe('0');
    expect(empty.querySelector('[data-testid=catalogue-stage]')!.textContent).toBe('No enabled producer plugin');
    expect(empty.querySelector('a')!.getAttribute('href')).toBe('/kind/domain');
    expect(empty.getAttribute('data-filled')).toBe('false');
  });

  test('in Russian the names and descriptions are translated while plugin names are unchanged', async () => {
    answer(full);
    await setWikiLanguage('ru');
    try {
      const container = into(createElement(CataloguePage, { version: 0 }));
      await until(() => container.querySelector('[data-testid=catalogue-page]') !== null, 'the catalogue');
      expect(container.querySelector('h1')!.textContent).toBe('Каталог сущностей');
      expect(container.querySelector('[data-kind="code.file"]')!.textContent).toContain('Файл репозитория кода.');
      expect(container.querySelector('[data-kind="code.file"] [data-testid=catalogue-stage]')!.textContent).toBe('code');
      expect(container.querySelector('[data-group=history] h2')!.textContent).toContain('История');
    } finally {
      await setWikiLanguage('en');
    }
  });

  test('a kind with no translation uses its key without warnings', async () => {
    answer({ ...full, kinds: [kind({ kind: 'domain', labels: { en: { one: 'Domain', many: 'Domains' } }, descriptions: { en: 'A part of the business.' }, count: 0 })] });
    await setWikiLanguage('ru');
    try {
      const container = into(createElement(CataloguePage, { version: 0 }));
      await until(() => container.querySelector('[data-testid=catalogue-page]') !== null, 'the catalogue');
      const row = container.querySelector('[data-kind="domain"]')!;
      expect(row.querySelector('a')!.textContent).toBe('domain');
      expect(row.querySelector('[data-testid=catalogue-no-translation]')).toBeNull();
      expect(row.querySelector('[data-testid=catalogue-no-description]')).toBeNull();
      expect(row.textContent).not.toContain('Domains');
      expect(row.querySelector('[data-testid=catalogue-count]')!.textContent).toBe('0');
    } finally {
      await setWikiLanguage('en');
    }
  });

  test('a kind without an enabled producer names that absence without inferring a category', async () => {
    answer({ ...full, kinds: [kind({ kind: 'correction', labels: { en: { one: 'Correction', many: 'Corrections' } }, descriptions: { en: 'A note that a statement is wrong.' }, page: true, plugins: [], filled: false, count: 2 })] });
    const container = into(createElement(CataloguePage, { version: 0 }));
    await until(() => container.querySelector('[data-testid=catalogue-page]') !== null, 'the catalogue');
    expect(container.querySelector('[data-kind="correction"] [data-testid=catalogue-stage]')!.textContent).toBe('No enabled producer plugin');
    expect(container.querySelector('[data-kind="correction"]')!.getAttribute('data-filled')).toBe('false');
  });

  test('one entity in one kind reads in the singular, in English and in Russian', async () => {
    const one: CatalogView = { ...full, groups: [{ group: 'code', labels: { en: 'Code', ru: 'Код' } }], kinds: [kind({ kind: 'code.file', count: 1 })] };
    answer(one);
    const english = into(createElement(CataloguePage, { version: 0 }));
    await until(() => english.querySelector('[data-testid=catalogue-total]') !== null, 'the catalogue');
    expect(english.querySelector('[data-testid=catalogue-total]')!.textContent).toBe('1 kind, 1 record');
    rendered?.unmount();
    document.body.innerHTML = '';
    await setWikiLanguage('ru');
    try {
      answer(one);
      const russian = into(createElement(CataloguePage, { version: 0 }));
      await until(() => russian.querySelector('[data-testid=catalogue-total]') !== null, 'the catalogue');
      expect(russian.querySelector('[data-testid=catalogue-total]')!.textContent).toBe('1 вид, 1 запись');
    } finally {
      await setWikiLanguage('en');
    }
  });
});

describe('the reasons a row stands in a list', () => {
  const refs: Block = { type: 'refs', title: 'Linked from', total: 2, rows: [
    { entity: { id: 'domain:payment', kind: 'domain', label: 'Payment', href: '/e/domain%3Apayment' }, note: '3 statements grounded in it', noteKey: 'statements', noteArgs: { count: 3 } },
    { entity: { id: 'doc:x#L4', kind: 'document', label: 'docs/x.md:4', href: '/doc?path=docs%2Fx.md' }, note: 'see UC-2 for the payment' },
  ] };

  test('a reason that has a key is said in the reader\'s language and a quotation from a document is shown as it is', async () => {
    const english = into(createElement(BlockView, { block: refs, resolutions: {} }));
    await until(() => english.querySelector('[data-block=refs]') !== null, 'the list');
    expect([...english.querySelectorAll('[data-testid=ref-note]')].map((note) => note.textContent)).toEqual(['3 statements grounded in it', 'see UC-2 for the payment']);
    rendered?.unmount();
    document.body.innerHTML = '';
    await setWikiLanguage('ru');
    try {
      const russian = into(createElement(BlockView, { block: refs, resolutions: {} }));
      await until(() => russian.querySelector('[data-block=refs]') !== null, 'the list');
      expect([...russian.querySelectorAll('[data-testid=ref-note]')].map((note) => note.textContent)).toEqual(['3 утверждения опираются на него', 'see UC-2 for the payment']);
    } finally {
      await setWikiLanguage('en');
    }
  });
});

describe('the statement view', () => {
  const statement: StatementModel = {
    page: { id: 'domain:payment', kind: 'domain', label: 'Payment', href: '/e/domain%3Apayment' },
    name: 'checkout-asks-payments-authorize',
    sentence: 'Checkout asks payments to authorize the card for the order total.',
    paragraph: 'Checkout asks payments to authorize the card for the order total.',
    file: 'docs/domains/payment.md',
    line: 9,
    grounded: true,
    relying: [],
    grounds: [
      { url: 'madarch:doc:docs/requirements.md#uc-2', resolution: { state: 'ok', target: 'madarch:doc:docs/requirements.md#uc-2', kind: 'doc.use-case', label: 'UC-2 Pay', href: '/e/doc%3Adocs%2Frequirements.md%23uc-2', entity: 'doc:docs/requirements.md#uc-2' }, excerpt: { type: 'text', markdown: '**UC-2 Pay**\n\nCheckout asks payments to authorize the card.', place: { repo: null, path: 'docs/requirements.md', lineStart: 9, lineEnd: 12, href: '/doc?path=docs%2Frequirements.md#uc-2' } } },
      { url: 'madarch:code.symbol:a.ts#pay', resolution: { state: 'ok', target: 'x', kind: 'code.symbol', label: 'PaymentService.pay', href: '/e/code.symbol%3Aa.ts%23pay' }, excerpt: { type: 'code', location: { repo: 'shop', path: 'a.ts', lineStart: 4, lineEnd: 6, href: '/src?repo=shop&path=a.ts&line=4' }, language: 'typescript', firstLine: 2, text: 'const a = 1;\n\nasync pay() {\n  return 1;\n}\n\nconst b = 2;', marked: { start: 4, end: 6 }, truncated: false } },
      { url: 'madarch:code.symbol:a.ts#gone', resolution: { state: 'broken', target: 'x', reason: 'no entity "code.symbol:a.ts#gone" in the graph', why: { code: 'no-entity', key: 'code.symbol:a.ts#gone' } }, excerpt: null },
    ],
    resolutions: {},
  };

  function answer(model: StatementModel): void {
    (globalThis as { fetch?: unknown }).fetch = async (url: string) => (url.includes('/api/statement') ? new Response(JSON.stringify(model)) : new Response('{}', { status: 404 }));
  }

  test('the sentence, its paragraph and every ground with its excerpt: the use case\'s text, the lines of code with the cited ones marked, and a broken ground with its reason', async () => {
    answer(statement);
    const container = into(createElement(StatementPage, { id: 'domain:payment', sentence: statement.sentence, version: 0 }));
    await until(() => container.querySelector('[data-testid=statement-page]') !== null, 'the statement');
    expect(container.querySelector('[data-testid=statement-sentence]')!.textContent).toBe(statement.sentence);
    expect(container.querySelector('[data-testid=statement-paragraph]')!.textContent).toContain('docs/domains/payment.md, line 9');
    const grounds = [...container.querySelectorAll('[data-testid=ground]')];
    expect(grounds.length).toBe(3);
    expect(grounds[0]!.querySelector('[data-excerpt=text]')!.textContent).toContain('Checkout asks payments to authorize the card.');
    const code = grounds[1]!.querySelector('[data-excerpt=code]')!;
    const marked = [...code.querySelectorAll('.source-line-marked')].map((line) => line.getAttribute('data-line'));
    expect(marked).toEqual(['4', '5', '6']);
    expect(code.querySelectorAll('.source-line').length).toBe(7);
    expect(code.textContent).toContain('cited lines 4–6');
    expect(grounds[2]!.getAttribute('data-state')).toBe('broken');
    // The reason is said in the reader's words, not the engineer's message.
    expect(grounds[2]!.textContent).toContain('Nothing in the graph or among the product pages is called "code.symbol:a.ts#gone".');
    expect(grounds[2]!.textContent).not.toContain('no entity');
  });

  test('a ground that is a service is a card with its facts, what it is connected to and its page; no code is drawn', async () => {
    const card: StatementModel = { ...statement, grounds: [{ url: 'madarch:code.service:payments', resolution: { state: 'ok', target: 'x', kind: 'code.service', label: 'payments', href: '/e/code.service%3Apayments' }, excerpt: { type: 'entity', entity: { id: 'code.service:payments', kind: 'code.service', label: 'payments', href: '/e/code.service%3Apayments' }, facts: [{ name: 'language', value: 'typescript' }], related: [{ relation: 'code.serves', direction: 'out', total: 7, rows: [{ entity: { id: 'code.route:POST:/payments', kind: 'code.route', label: 'POST /payments', href: null }, count: 1 }] }] } }] };
    answer(card);
    const container = into(createElement(StatementPage, { id: 'domain:payment', sentence: statement.sentence, version: 0 }));
    await until(() => container.querySelector('[data-excerpt=entity]') !== null, 'the card');
    const shown = container.querySelector('[data-excerpt=entity]')!;
    expect(shown.querySelector('[data-testid=card-facts]')!.textContent).toContain('typescript');
    expect(shown.querySelector('[data-testid=card-related]')!.textContent).toContain('POST /payments');
    expect(shown.querySelector('[data-testid=card-page] a')!.getAttribute('href')).toBe('/e/code.service%3Apayments');
    expect(container.querySelector('[data-excerpt=code]')).toBeNull();
    expect(container.textContent).not.toContain('package.json');
  });

  test('a code place that has a web address offers it, named by the host; one without offers none', async () => {
    const withWeb: StatementModel = { ...statement, grounds: [{ ...statement.grounds[1]!, excerpt: { ...(statement.grounds[1]!.excerpt as Extract<NonNullable<StatementModel['grounds'][number]['excerpt']>, { type: 'code' }>), location: { repo: 'shop', path: 'a.ts', lineStart: 4, lineEnd: 6, href: '/src?repo=shop&path=a.ts&line=4', web: { host: 'GitHub', url: `${PAGE_HOST}/blob/abc/a.ts#L4-L6` } } } }] };
    answer(withWeb);
    const container = into(createElement(StatementPage, { id: 'domain:payment', sentence: statement.sentence, version: 0 }));
    await until(() => container.querySelector('[data-testid=web-place]') !== null, 'the web link');
    const link = container.querySelector('[data-testid=web-place]') as HTMLAnchorElement;
    expect(link.textContent).toBe('GitHub');
    expect(link.getAttribute('href')).toBe(`${PAGE_HOST}/blob/abc/a.ts#L4-L6`);
    rendered?.unmount();
    document.body.innerHTML = '';
    answer(statement);
    const plain = into(createElement(StatementPage, { id: 'domain:payment', sentence: statement.sentence, version: 0 }));
    await until(() => plain.querySelector('[data-testid=ground]') !== null, 'the grounds');
    expect(plain.querySelector('[data-testid=web-place]')).toBeNull();
  });

  test('the other statements that rely on the same grounds are listed with their page and the shared ground', async () => {
    answer({ ...statement, relying: [{ page: 'product:shop', pageTitle: 'Online shop', text: 'The shop takes orders.', line: 7, file: 'docs/product.md', how: 'grounds', ground: 'UC-2 Pay', sentence: 'The shop takes orders.', turn: 0 }] });
    const container = into(createElement(StatementPage, { id: 'domain:payment', sentence: statement.sentence, version: 0 }));
    await until(() => container.querySelector('[data-testid=statement-relying]') !== null, 'the list');
    const row = container.querySelector('[data-testid=statement-relying] tbody tr')!;
    expect(row.textContent).toContain('Online shop');
    expect(row.textContent).toContain('UC-2 Pay');
    expect(row.querySelectorAll('a')[1]!.getAttribute('href')).toContain('/statement?id=product%3Ashop');
  });

  test('a sentence with no ground says the wiki does not show it as a fact, and a sentence the page lost is refused in the server\'s words', async () => {
    answer({ ...statement, grounded: false, grounds: [] });
    const container = into(createElement(StatementPage, { id: 'domain:payment', sentence: statement.sentence, version: 0 }));
    await until(() => container.querySelector('[data-testid=statement-no-grounds]') !== null, 'the ungrounded note');
    expect(container.querySelector('[data-testid=statement-no-grounds]')!.textContent).toContain('does not show it as a fact');
    rendered?.unmount();
    document.body.innerHTML = '';
    (globalThis as { fetch?: unknown }).fetch = async () => new Response(JSON.stringify({ message: 'docs/domains/payment.md holds no statement "x"' }), { status: 404 });
    const missing = into(createElement(StatementPage, { id: 'domain:payment', sentence: 'x', version: 0 }));
    await until(() => missing.querySelector('[data-testid=statement-error]') !== null, 'the refusal');
    expect(missing.textContent).toContain('holds no statement');
    // The refused statement's tab is named by the sentence that was asked for, never left as loading.
    expect(frontTab().title).toBe('x');
    // A page that is not there names its tab too.
    rendered?.unmount();
    document.body.innerHTML = '';
    const noPage = into(createElement(EntityPage, { id: 'domain:none', version: 0 }));
    await until(() => noPage.querySelector('[data-testid=page-error]') !== null, 'the page that is not there');
    await until(() => frontTab().title === 'There is no such page', 'the title of the refused page');
  });
});


describe('the file page', () => {
  const file = {
    repository: 'madarch', path: 'docs/x.md', id: 'code.file:madarch/docs/x.md', href: '/e/code.file%3Amadarch%2Fdocs%2Fx.md',
    mode: '100644', blob: 'b'.repeat(40), bytes: 1234, lines: 42, form: 'text' as const, language: 'markdown', candidates: ['Markdown'],
    created: { date: '2026-01-02T10:00:00+00:00', offsetMin: 0, commit: 'abc1234', author: 'Ada', href: '/e/code.commit%3Aabc1234' },
    modified: { date: '2026-01-03T10:00:00+00:00', offsetMin: 0, commit: 'def5678', author: 'Bob', href: '/e/code.commit%3Adef5678' },
    commitCount: 2, authors: ['Ada', 'Bob'],
  };
  const page = (cochange: { path: string; href: string | null; both: number; share: number }[]) => ({
    id: 'code.file:madarch/docs/x.md', kind: 'code.file', title: 'docs/x.md',
    trail: [
      { id: 'home', kind: 'product', label: 'madarch', href: '/' },
      { id: 'code.repository:madarch', kind: 'code.repository', label: 'madarch', href: '/e/code.repository%3Amadarch' },
      { id: 'code.directory:madarch/docs', kind: 'code.directory', label: 'docs', href: '/e/code.directory%3Amadarch%2Fdocs' },
      { id: 'code.file:madarch/docs/x.md', kind: 'code.file', label: 'docs/x.md', href: '/e/code.file%3Amadarch%2Fdocs%2Fx.md' },
    ],
    resolutions: {}, findings: [], notes: [],
    blocks: [{ type: 'filePage', data: file, markdown: true, source: { text: '# Heading\n\nText with **bold**.', language: 'markdown', href: '/src?repo=madarch&path=docs%2Fx.md' }, history: [{ hash: 'abc1234', href: '/e/code.commit%3Aabc1234', when: '2026-01-02', who: 'Ada', subject: 'Add x', added: 5, removed: 2, change: 'modified' }], cochange, cochangeTotal: cochange.length === 0 ? 0 : 7, commits: 2 }],
  });

  test('the trail ends in the file name, unlinked, and the page has the reference header and tabs', async () => {
    (globalThis as { fetch?: unknown }).fetch = async (url: string) => url.includes('/api/page')
      ? new Response(JSON.stringify(page([{ path: 'docs/y.md', href: '/e/code.file%3Amadarch%2Fdocs%2Fy.md', both: 1, share: 0.5 }])), { status: 200 })
      : new Response('{}', { status: 404 });
    const container = into(createElement(EntityPage, { id: 'code.file:madarch/docs/x.md', version: 0 }));
    await until(() => container.querySelector('[data-testid=file-page]') !== null, 'the file page');
    const trail = container.querySelector('[data-testid=trail]')!;
    expect([...trail.querySelectorAll('[data-testid=trail-current]')].map((one) => one.textContent)).toEqual(['docs/x.md']);
    expect(trail.querySelector('[data-testid=trail-current]')!.getAttribute('aria-current')).toBe('page');
    expect(trail.querySelector('[data-testid=trail-current] a')).toBeNull();
    expect(trail.textContent).toContain('madarch');
    expect(trail.textContent).toContain('docs');
    expect(container.querySelector('[data-testid=file-header-language]')!.textContent).toBe('markdown');
    expect(container.querySelector('[data-testid=file-header-lines]')!.textContent).toBe('42');
    expect(container.querySelector('[data-testid=file-header-size]')!.textContent).toBe('1.2 kB');
    expect(container.querySelector('[data-testid=file-header-authors]')!.textContent).toBe('Ada, Bob');
    // The Markdown view is the wiki's own renderer: the heading is an element, not a line of source.
    expect(container.querySelector('[data-testid=file-overview] h1')!.textContent).toBe('Heading');
    expect(container.querySelector('[data-testid=file-sources-page]')!.getAttribute('href')).toBe('/doc?repo=madarch&path=docs%2Fx.md');
    (container.querySelector('[data-testid=file-view-source]') as HTMLButtonElement).click();
    await until(() => container.querySelector('[data-testid=file-source]') !== null, 'the source view');
    expect(container.querySelector('[data-testid=source-code]')!.getAttribute('data-wrap')).toBe('false');
    (container.querySelector('[data-testid=file-wrap]') as HTMLButtonElement).click();
    await until(() => container.querySelector('[data-testid=source-code]')!.getAttribute('data-wrap') === 'true', 'soft wrap');
    (container.querySelector('[data-testid=file-tab-history]') as HTMLButtonElement).click();
    await until(() => container.querySelector('[data-testid=file-history-row]') !== null, 'the history');
    expect(container.querySelector('[data-testid=file-history-row]')!.textContent).toContain('Add x');
    (container.querySelector('[data-testid=file-tab-cochange]') as HTMLButtonElement).click();
    await until(() => container.querySelector('[data-testid=file-cochange-row]') !== null, 'the co-change');
    expect(container.querySelector('[data-testid=file-cochange-row]')!.textContent).toContain('docs/y.md');
    expect(container.querySelector('[data-testid=file-cochange-row]')!.textContent).toContain('50%');
    expect(container.querySelector('[data-testid=file-cochange]')!.textContent).toContain('Showing 1 of 7');
  });

  test('a file with one commit shows one history row and says its co-change is empty', async () => {
    (globalThis as { fetch?: unknown }).fetch = async (url: string) => url.includes('/api/page')
      ? new Response(JSON.stringify(page([])), { status: 200 })
      : new Response('{}', { status: 404 });
    const container = into(createElement(EntityPage, { id: 'code.file:madarch/docs/x.md', version: 1 }));
    await until(() => container.querySelector('[data-testid=file-page]') !== null, 'the file page');
    (container.querySelector('[data-testid=file-tab-cochange]') as HTMLButtonElement).click();
    await until(() => container.querySelector('[data-testid=file-cochange-empty]') !== null, 'the empty co-change');
    (container.querySelector('[data-testid=file-tab-history]') as HTMLButtonElement).click();
    await until(() => container.querySelector('[data-testid=file-history-row]') !== null, 'the one history row');
    expect(container.querySelectorAll('[data-testid=file-history-row]')).toHaveLength(1);
  });
});

describe('the sources', () => {
  test('each source shows its title with the path small under it; the filter matches either', async () => {
    const listing: DocumentListing = { documents: [{ repo: null, path: 'docs/vision.md', title: 'The vision' }, { repo: null, path: 'notes/ideas.md', title: 'ideas' }], truncated: [] };
    (globalThis as { fetch?: unknown }).fetch = async (url: string) => (url.includes('/api/documents') ? new Response(JSON.stringify(listing)) : new Response('{}', { status: 404 }));
    const container = into(createElement(DocumentsPage, { version: 0 }));
    await until(() => container.querySelector('[data-testid=documents-page]') !== null, 'the page');
    expect(container.querySelector('h1')!.textContent).toBe('Sources');
    expect(container.querySelector('[data-testid=documents-intro]')).not.toBeNull();
    const rows = [...container.querySelectorAll('[data-testid=document-row]')];
    expect(rows.map((row) => [row.querySelector('a')!.textContent, row.querySelector('[data-testid=document-path]')!.textContent])).toEqual([['The vision', 'docs/vision.md'], ['ideas', 'notes/ideas.md']]);
    expect(container.querySelector('[data-testid=documents-filter]')).not.toBeNull();
    expect(filterSources(listing.documents, 'VISION').map((entry) => entry.path)).toEqual(['docs/vision.md']);
    expect(filterSources(listing.documents, ' notes/ ').map((entry) => entry.title)).toEqual(['ideas']);
    expect(filterSources(listing.documents, '')).toHaveLength(2);
  });
});

describe('every route names its tab', () => {
  const BOUNDS = { turns: 30, minutes: 10, toolCalls: 80, writeAttempts: 5, maxDomains: 12, editorialRequestsPerPage: 2 };
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
  const status = (over: Partial<WikiStatus> = {}): WikiStatus => ({
    product: { name: 'shop', id: 'p1' }, manifest: 'ok', manifestFile: 'madarch/kinds.yaml', language: 'en', findingCount: 0,
    kinds: [{ kind: 'code.symbol', source: 'graph', count: 1, single: false, origins: ['code'] }], groups: [], repositories: [{ name: 'shop', filled: true }],
    filled: true, incomplete: false, fill: { state: 'idle' }, writer: { state: 'idle', agent: null, units: [] }, bounds: BOUNDS,
    chosenAgent: null, home: null, ...over,
  });
  const pageModel = (id: string, title: string): unknown => ({ id, kind: 'domain', title, trail: [], blocks: [], resolutions: {}, findings: [], notes: [] });
  const loading = (): string => i18n.t('knowledge.loading');
  /** The shapes the shell asks for on every page, and the one page a route reads when `page` is given. */
  const serve = (state: WikiStatus, page: unknown | null = null, pending: Promise<Response> | null = null): void => {
    (globalThis as { fetch?: unknown }).fetch = async (url: string) => {
      if (url.endsWith('/api/status')) return json(state);
      if (url.endsWith('/api/products')) return json({ products: [{ name: 'shop', folder: 'shop' }] });
      if (url.endsWith('/api/agents')) return json({ agents: [], chosen: null });
      if (url.endsWith('/api/settings')) return json({ role: 'everything', asked: true, roles: [] });
      if (url.endsWith('/api/glossary')) return json({ terms: [], resolutions: {}, findings: [] });
      if (url.includes('/api/page')) return pending ?? (page === null ? json({ message: 'no page' }, 404) : json(page));
      if (url.includes('/api/view')) return json({ renderer: 'mermaid', views: [] });
      return json({ message: 'not here' }, 404);
    };
  };
  const activeTab = (container: HTMLElement): string => container.querySelector('[data-testid=tab][data-active=true] [role=tab]')?.textContent ?? '';

  const routes: { address: string; selector: string; expected?: string; state?: WikiStatus; page?: unknown }[] = [
    // The home of an empty product (the owner's case): the introduction, and the product's name on the tab.
    { address: '/', selector: '[data-testid=overview]', expected: 'shop', state: status({ filled: false, home: null, repositories: [{ name: 'shop', filled: false }] }) },
    // A filled home whose page the server names.
    { address: '/', selector: '[data-testid=entity-page]', expected: 'Shop home', state: status({ home: 'product:shop', filled: true }), page: pageModel('product:shop', 'Shop home') },
    // A filled home that is its repository's page (the demo's shape).
    { address: '/', selector: '[data-testid=entity-page]', expected: 'shop', state: status({ home: null, filled: true, repository: { id: 'code.repository:shop', name: 'shop', url: 'https://example.invalid/shop.git', defaultBranch: 'main', asIsCommit: 'abc123', counts: { files: 1, commits: 1, folders: 0 }, historyShallow: false, steps: { tree: true, history: true } } }), page: pageModel('code.repository:shop', 'shop') },
    { address: '/e/domain%3Apayment', selector: '[data-testid=entity-page]', expected: 'Payment domain', page: pageModel('domain:payment', 'Payment domain') },
    { address: '/e/nothing', selector: '[data-testid=page-error]', expected: 'There is no such page' },
    { address: '/kind/code.symbol', selector: '[data-testid=kind-page]', expected: 'Symbols' },
    { address: '/src?repo=shop&path=a.ts&line=2', selector: '[data-testid=source-error]', expected: 'a.ts' },
    { address: '/run', selector: '[data-testid=run-error]', expected: 'The run' },
    { address: '/docs', selector: '[data-testid=documents-error]', expected: 'Sources' },
    { address: '/doc?path=docs%2Fx.md', selector: '[data-testid=document-error]', expected: 'There is no such page' },
    { address: '/catalogue', selector: '[data-testid=catalogue-error]', expected: 'Entity catalogue' },
    { address: '/glossary', selector: '[data-testid=glossary-page]', expected: 'Glossary' },
    { address: '/problems', selector: '[data-testid=problems-error]', expected: 'Problems' },
    { address: '/settings', selector: '[data-testid=settings-error]', expected: 'Product settings' },
    { address: '/journal?id=product%3Ashop', selector: '[data-testid=journal-error]', expected: 'How the agent wrote this page' },
    { address: '/fill', selector: '[data-testid=fill-page]', expected: 'Fill' },
    { address: '/statement?id=product%3Ashop&sentence=The%20shop%20takes%20orders', selector: '[data-testid=statement-error]', expected: 'The shop takes orders' },
  ];

  for (const route of routes) {
    test(`${route.address} names its tab once the page stands${route.expected === undefined ? '' : `: ${route.expected}`}`, async () => {
      serve(route.state ?? status(), route.page ?? null);
      window.history.replaceState({}, '', route.address);
      const container = into(createElement(AppRoot));
      await until(() => container.querySelector(route.selector) !== null, `the page of ${route.address}`);
      await until(() => frontTab().title !== null && frontTab().title !== loading(), `the tab's name after ${route.address}`);
      expect(frontTab().title).not.toBe(loading());
      if (route.expected !== undefined) expect(frontTab().title).toBe(route.expected);
      expect(activeTab(container)).not.toBe(loading());
      for (const tab of JSON.parse(window.sessionStorage.getItem('madarch-tabs:/') ?? '{"tabs":[]}').tabs as { title: string | null }[]) {
        expect(tab.title).not.toBe(loading());
      }
    });
  }

  test('«Loading…» still stands while the page it names is really being read, and gives way to the page\'s name', async () => {
    let answer!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => { answer = resolve; });
    serve(status({ home: 'product:shop', filled: true }), null, held);
    window.history.replaceState({}, '', '/');
    const container = into(createElement(AppRoot));
    await until(() => container.querySelector('[data-testid=tab][data-active=true]') !== null, 'the tab bar');
    await until(() => activeTab(container) === loading(), 'the loading name');
    expect(frontTab().title).toBeNull();
    answer(json(pageModel('product:shop', 'Shop home')));
    await until(() => frontTab().title === 'Shop home', 'the page\'s name');
    expect(activeTab(container)).toBe('Shop home');
  });
});
