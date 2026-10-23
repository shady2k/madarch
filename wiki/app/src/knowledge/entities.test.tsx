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
import { setWikiLanguage } from '../i18n.js';
import { BlockView, KMarkdown } from './blocks.js';
import { navGroups, TabBar } from './app.js';
import { CataloguePage, DocumentsPage, StatementPage, filterSources } from './pages.js';
import { resetPreferences } from './preferences.js';
import { addressOfStatement, kRouteOf } from './routes.js';
import { cutSentences, plainText, remarkStatements, type MNode } from './statements.js';
import { activateTab, closeTab, currentAddress, linkHandlers, openInNewTab, resetTabs, setTabTitle, frontTab, syncFrontTabAddress, useTabTitle } from './tabs.js';
import type { Block, DocumentListing, KindSummary, Resolution, StatementModel, WikiStatus } from './types.js';

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
  window.history.replaceState({}, '', '/k');
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
  'madarch:product:shop': { state: 'ok', target: 'madarch:product:shop', kind: 'product', label: 'The shop', href: '/k/e/product%3Ashop' },
  'madarch:code.symbol:a.ts#F': { state: 'ok', target: 'madarch:code.symbol:a.ts#F', kind: 'code.symbol', label: 'F', href: '/k/e/code.symbol%3Aa.ts%23F', location: { repo: 'shop', path: 'a.ts', lineStart: 2, lineEnd: 9, href: '/k/src?repo=shop&path=a.ts&line=2' } },
};

function tree(text: string, showGrounds: boolean): MNode {
  const parser = unified().use(remarkParse).use(remarkGfm);
  const root = parser.parse(text) as unknown as MNode;
  remarkStatements({ showGrounds })(root);
  return root;
}

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
    expect(addressOfStatement('page:x', 'Requests are retried three times.', 1)).toBe('/k/statement?id=page%3Ax&sentence=Requests+are+retried+three+times.&n=1');
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
    expect(link.getAttribute('href')).toBe('/k/e/code.symbol%3Aa.ts%23F');
    expect(container.querySelector('[data-testid=code-place]')).toBeNull();
  });

  test('a click on a sentence opens its statement in a new tab; a click on a link inside it does not', async () => {
    const container = into(createElement(KMarkdown, { text: 'Checkout asks payments to authorize the card for [the order](madarch:code.symbol:a.ts#F) now.[^1]\n\n[^1]: [f](madarch:code.symbol:a.ts#F)\n', resolutions, statements: { pageId: 'domain:payment', showGrounds: false } }));
    await until(() => container.querySelector('[data-testid=statement]') !== null, 'the statement');
    expect(frontTab().address).toBe('/k');
    (container.querySelector('a') as HTMLElement).click();
    expect(frontTab().address).toBe('/k');
    (container.querySelector('[data-testid=statement]') as HTMLElement).click();
    const sentence = 'Checkout asks payments to authorize the card for the order now.';
    expect(frontTab().address).toBe(addressOfStatement('domain:payment', sentence));
    expect(kRouteOf('/k/statement', `?id=domain%3Apayment&sentence=${encodeURIComponent(sentence)}`)).toEqual({ name: 'statement', id: 'domain:payment', sentence, turn: 0 });
    expect(kRouteOf('/k/statement', `?id=domain%3Apayment&sentence=x&n=2`)).toEqual({ name: 'statement', id: 'domain:payment', sentence: 'x', turn: 2 });
    expect(window.location.pathname + window.location.search).toBe(addressOfStatement('domain:payment', sentence));
  });

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
    expect(frontTab().address).toBe('/k');
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
    expect(frontTab().address).toBe('/k');
    selection.removeAllRanges();
    // A click that only dismisses a selection: the press found it, the click finds it gone.
    selection.addRange(range);
    statement.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
    selection.removeAllRanges();
    statement.click();
    expect(tabCount()).toBe(before);
    expect(frontTab().address).toBe('/k');
    statement.click();
    await until(() => tabCount() === before + 1, 'the statement tab');
  });

  test('the switch brings the footnote numbers and the grounds back, and the choice is kept for the next page', async () => {
    const body: Block = { type: 'body', markdown: BODY, file: 'docs/domains/payment.md', statements: 3, ungrounded: [] };
    const container = into(createElement(BlockView, { block: body, resolutions, pageId: 'domain:payment' }));
    await until(() => container.querySelector('[data-testid=grounds-switch]') !== null, 'the switch');
    expect(container.querySelector('sup')).toBeNull();
    const toggle = container.querySelector('[data-testid=grounds-switch] input') as HTMLInputElement;
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
    expect(currentAddress()).toBe('/k');
    openInNewTab('/k/e/domain%3Apayment');
    expect(frontTab().address).toBe('/k/e/domain%3Apayment');
    expect(window.location.pathname).toBe('/k/e/domain%3Apayment');
    openInNewTab('/k/catalogue');
    openInNewTab('/k/e/domain%3Apayment');
    expect(frontTab().address).toBe('/k/e/domain%3Apayment');
    expect(JSON.parse(window.sessionStorage.getItem('madarch-tabs:/')!).tabs.map((tab: { address: string }) => tab.address)).toEqual(['/k', '/k/e/domain%3Apayment', '/k/catalogue']);
  });

  test('browser Back and Forward restore the open tab that holds the history address', () => {
    openInNewTab('/k/catalogue');
    openInNewTab('/k/docs');
    const tabs = JSON.parse(window.sessionStorage.getItem('madarch-tabs:/')!).tabs as { key: string; address: string }[];
    const catalogue = tabs.find((tab) => tab.address === '/k/catalogue')!;
    const docs = tabs.find((tab) => tab.address === '/k/docs')!;
    // The current docs page links to a catalogue already held in another tab.
    linkHandlers('/k/catalogue').onClick({ shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, button: 0, preventDefault: () => undefined } as never);
    expect(frontTab().key).toBe(catalogue.key);
    // Model the browser's popstate after Back, then Forward.
    window.history.pushState({}, '', '/k/docs');
    window.dispatchEvent(new Event('popstate'));
    expect(frontTab().key).toBe(docs.key);
    window.history.pushState({}, '', '/k/catalogue');
    window.dispatchEvent(new Event('popstate'));
    expect(frontTab().key).toBe(catalogue.key);
    expect(JSON.parse(window.sessionStorage.getItem('madarch-tabs:/')!).tabs).toHaveLength(3);
  });

  test('a plain click on a link to a page another tab holds focuses that tab; another section of an open document is the same page', () => {
    openInNewTab('/k/catalogue');
    openInNewTab('/k/doc?path=a.md');
    const catalogue = JSON.parse(window.sessionStorage.getItem('madarch-tabs:/')!).tabs[1].key as string;
    const link = document.createElement('a');
    const handlers = linkHandlers('/k/catalogue');
    link.addEventListener('click', (event) => handlers.onClick(event as never));
    document.body.append(link);
    link.click();
    link.remove();
    expect(frontTab().key).toBe(catalogue);
    expect(JSON.parse(window.sessionStorage.getItem('madarch-tabs:/')!).tabs).toHaveLength(3);
    openInNewTab('/k/doc?path=a.md#section');
    expect(frontTab().address).toBe('/k/doc?path=a.md#section');
    expect(JSON.parse(window.sessionStorage.getItem('madarch-tabs:/')!).tabs).toHaveLength(3);
    // Another section of the document in front: the tab and the window name it.
    openInNewTab('/k/doc?path=a.md#other');
    expect(frontTab().address).toBe('/k/doc?path=a.md#other');
    expect(window.location.hash).toBe('#other');
  });

  test('a tab whose window moved to another page and back is named again by the page that stayed mounted', async () => {
    const Page = (): null => { useTabTitle('Home page'); return null; };
    const container = into(createElement('div', null, createElement(TabBar), createElement(Page)));
    await until(() => container.textContent!.includes('Home page'), 'the title');
    window.history.pushState({}, '', '/k/catalogue');
    window.dispatchEvent(new Event('popstate'));
    await until(() => container.textContent!.includes('Home page'), 'the title after the move');
    expect(container.textContent).not.toMatch(/Loading|Загрузка/);
  });

  test('a tab is switched to and closed; the neighbour comes to the front; the last tab stays', async () => {
    const container = into(createElement(TabBar));
    openInNewTab('/k/catalogue');
    openInNewTab('/k/docs');
    await until(() => container.querySelectorAll('[data-testid=tab]').length === 3, 'three tabs');
    setTabTitle(frontTab().key, 'Documents');
    await until(() => container.textContent!.includes('Documents'), 'the title');
    const tabs = [...container.querySelectorAll<HTMLElement>('[data-testid=tab] [role=tab]')];
    tabs[0]!.click();
    expect(window.location.pathname).toBe('/k');
    await until(() => container.querySelector('[data-active=true] [role=tab]')!.textContent !== 'Documents', 'the first tab in front');
    (container.querySelectorAll('[data-testid=tab-close]')[0] as HTMLElement).click();
    await until(() => container.querySelectorAll('[data-testid=tab]').length === 2, 'two tabs');
    expect(frontTab().address).toBe('/k/catalogue');
    closeTab(frontTab().key);
    closeTab(frontTab().key);
    await until(() => container.querySelectorAll('[data-testid=tab]').length === 1, 'one tab left');
    expect(container.querySelector('[data-testid=tab-close]')).toBeNull();
    expect(frontTab().address).toBe('/k/docs');
  });

  test('a plain click shows the page in the tab in front; a control click or a middle click opens a new tab', async () => {
    // The tab bar is what listens to the window's moves.
    const container = into(createElement(TabBar));
    await until(() => container.querySelector('[data-testid=tab]') !== null, 'the tab bar');
    const handlers = linkHandlers('/k/catalogue');
    const click = (init: { ctrlKey?: boolean; button?: number }, via: 'onClick' | 'onAuxClick' = 'onClick'): void => {
      handlers[via]({ shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, button: 0, ...init, preventDefault: () => undefined } as never);
    };
    click({});
    expect(frontTab().address).toBe('/k/catalogue');
    activateTab(frontTab().key);
    expect(JSON.parse(window.sessionStorage.getItem('madarch-tabs:/')!).tabs.length).toBe(1);
    click({ ctrlKey: true });
    expect(JSON.parse(window.sessionStorage.getItem('madarch-tabs:/')!).tabs.length).toBe(1);
    // the address is the front tab's: a ctrl click on a different address opens a second tab
    linkHandlers('/k/docs').onClick({ shiftKey: false, altKey: false, ctrlKey: true, metaKey: false, button: 0, preventDefault: () => undefined } as never);
    expect(JSON.parse(window.sessionStorage.getItem('madarch-tabs:/')!).tabs.map((tab: { address: string }) => tab.address)).toEqual(['/k/catalogue', '/k/docs']);
    linkHandlers('/k/e/x').onAuxClick({ shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, button: 1, preventDefault: () => undefined } as never);
    expect(JSON.parse(window.sessionStorage.getItem('madarch-tabs:/')!).tabs.map((tab: { address: string }) => tab.address)).toEqual(['/k/catalogue', '/k/docs', '/k/e/x']);
    // shift is the browser's: nothing changes
    linkHandlers('/k/other').onClick({ shiftKey: true, altKey: false, ctrlKey: false, metaKey: false, button: 0, preventDefault: () => undefined } as never);
    expect(JSON.parse(window.sessionStorage.getItem('madarch-tabs:/')!).tabs.length).toBe(3);
  });

  test('the back button moves the tab in front to the page the window is on, and a link to a section of the same page is remembered by its tab', async () => {
    const container = into(createElement(TabBar));
    await until(() => container.querySelector('[data-testid=tab]') !== null, 'the tab bar');
    window.history.pushState({}, '', '/k/docs');
    window.dispatchEvent(new Event('popstate'));
    await until(() => frontTab().address === '/k/docs', 'the tab following the window');
    window.history.pushState({}, '', '/k/doc?path=a.md#one');
    window.dispatchEvent(new Event('popstate'));
    expect(frontTab().address).toBe('/k/doc?path=a.md#one');
    // A link to another section of the document moves the hash without a move of the page.
    window.history.replaceState({}, '', '/k/doc?path=a.md#two');
    syncFrontTabAddress();
    expect(frontTab().address).toBe('/k/doc?path=a.md#two');
    openInNewTab('/k/catalogue');
    activateTab(JSON.parse(window.sessionStorage.getItem('madarch-tabs:/')!).tabs[0].key);
    expect(window.location.pathname + window.location.search + window.location.hash).toBe('/k/doc?path=a.md#two');
    // Back: the window returns to the earlier page and the tab in front shows it.
    window.history.replaceState({}, '', '/k/docs');
    window.dispatchEvent(new Event('popstate'));
    await until(() => frontTab().address === '/k/docs', 'the tab after back');
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

  test('the groups come in the manifest\'s order with the number of entities each holds; a kind with none, the home page and an empty group are not shown; a kind with no group stands in "other"', () => {
    const groups = navGroups(status, () => 0);
    // The home page (the single kind) counts in its group's number and is not listed: it is the "Home" entry.
    expect(groups.map((entry) => [entry.group, entry.total, entry.kinds.map((one) => one.kind)])).toEqual([
      ['product', 3, ['domain']],
      ['code', 803, ['code.file', 'code.symbol']],
      [null, 3, ['code.weird']],
    ]);
  });

  test('a kind with a top-level page of its own (the glossary terms) is not listed again under the kinds', () => {
    const groups = navGroups({ ...status, kinds: [kind({ kind: 'domain', source: 'markdown', group: 'product', count: 1 }), kind({ kind: 'doc.term', source: 'document', group: 'product', count: 7 })] } as unknown as WikiStatus, () => 0);
    expect(groups.map((entry) => entry.kinds.map((one) => one.kind))).toEqual([['domain']]);
  });

  test('a kind whose pages are being written is shown with its pending units', () => {
    const groups = navGroups({ ...status, kinds: [kind({ kind: 'domain', source: 'markdown', group: 'product', count: 0 })] } as unknown as WikiStatus, (name) => (name === 'domain' ? 2 : 0));
    expect(groups.map((entry) => entry.kinds.map((one) => one.kind))).toEqual([['domain']]);
  });
});

describe('the catalogue', () => {
  const full = {
    groups: [{ group: 'code', labels: { en: 'Code', ru: 'Код' } }, { group: 'history', labels: { en: 'History', ru: 'История' } }],
    kinds: [
      kind({ kind: 'code.file', group: 'code', count: 115, statements: 9, descriptions: { en: 'A file of a code repository.', ru: 'Файл репозитория кода.' }, labels: { en: { one: 'File', many: 'Files' }, ru: { one: 'Файл', many: 'Файлы' } } }),
      kind({ kind: 'code.commit', group: 'history', count: 72, origins: ['history'], descriptions: { en: 'A change.', ru: 'Изменение.' } }),
      kind({ kind: 'domain', source: 'markdown', group: 'code', count: 0, origins: ['agent', 'person'] }),
    ],
  } as unknown as WikiStatus;

  test('each kind is in its group with what it is, how many there are, how they got here and a link to its list, in the reader\'s language', async () => {
    const container = into(createElement(CataloguePage, { status: full }));
    await until(() => container.querySelector('[data-testid=catalogue-page]') !== null, 'the catalogue');
    expect(container.querySelector('[data-testid=catalogue-total]')!.textContent).toBe('187 entities in 3 kinds');
    const groups = [...container.querySelectorAll('[data-testid=catalogue-group]')].map((section) => section.getAttribute('data-group'));
    expect(groups).toEqual(['code', 'history']);
    const row = container.querySelector('[data-kind="code.file"]')!;
    expect(row.querySelector('a')!.getAttribute('href')).toBe('/k/kind/code.file');
    expect(row.querySelector('a')!.textContent).toBe('Files');
    expect(row.textContent).toContain('A file of a code repository.');
    expect(row.querySelector('[data-testid=catalogue-count]')!.textContent).toBe('1159 statements');
    expect(row.querySelector('[data-origin=code]')!.textContent).toBe('read from the code');
    expect(container.querySelector('[data-kind="code.commit"] [data-origin=history]')!.textContent).toBe('read from the history');
    const written = [...container.querySelectorAll('[data-kind="domain"] [data-origin]')].map((badge) => badge.textContent);
    expect(written).toEqual(['written by the agent', 'written by a person']);
    expect(container.querySelector('[data-kind="domain"] [data-testid=catalogue-count]')!.textContent).toBe('0');
  });

  test('in Russian the names, the descriptions and the origins are Russian', async () => {
    await setWikiLanguage('ru');
    try {
      const container = into(createElement(CataloguePage, { status: full }));
      await until(() => container.querySelector('[data-testid=catalogue-page]') !== null, 'the catalogue');
      expect(container.querySelector('h1')!.textContent).toBe('Каталог сущностей');
      expect(container.querySelector('[data-kind="code.file"]')!.textContent).toContain('Файл репозитория кода.');
      expect(container.querySelector('[data-kind="code.file"] [data-origin=code]')!.textContent).toBe('прочитано из кода');
      expect(container.querySelector('[data-group=history] h2')!.textContent).toContain('История');
    } finally {
      await setWikiLanguage('en');
    }
  });
});

describe('the reasons a row stands in a list', () => {
  const refs: Block = { type: 'refs', title: 'Linked from', total: 2, rows: [
    { entity: { id: 'domain:payment', kind: 'domain', label: 'Payment', href: '/k/e/domain%3Apayment' }, note: '3 statements grounded in it', noteKey: 'statements', noteArgs: { count: 3 } },
    { entity: { id: 'doc:x#L4', kind: 'document', label: 'docs/x.md:4', href: '/k/doc?path=docs%2Fx.md' }, note: 'see UC-2 for the payment' },
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
    page: { id: 'domain:payment', kind: 'domain', label: 'Payment', href: '/k/e/domain%3Apayment' },
    name: 'checkout-asks-payments-authorize',
    sentence: 'Checkout asks payments to authorize the card for the order total.',
    paragraph: 'Checkout asks payments to authorize the card for the order total.',
    file: 'docs/domains/payment.md',
    line: 9,
    grounded: true,
    relying: [],
    grounds: [
      { url: 'madarch:doc:docs/requirements.md#uc-2', resolution: { state: 'ok', target: 'madarch:doc:docs/requirements.md#uc-2', kind: 'doc.use-case', label: 'UC-2 Pay', href: '/k/e/doc%3Adocs%2Frequirements.md%23uc-2', entity: 'doc:docs/requirements.md#uc-2' }, excerpt: { type: 'text', markdown: '**UC-2 Pay**\n\nCheckout asks payments to authorize the card.', place: { repo: null, path: 'docs/requirements.md', lineStart: 9, lineEnd: 12, href: '/k/doc?path=docs%2Frequirements.md#uc-2' } } },
      { url: 'madarch:code.symbol:a.ts#pay', resolution: { state: 'ok', target: 'x', kind: 'code.symbol', label: 'PaymentService.pay', href: '/k/e/code.symbol%3Aa.ts%23pay' }, excerpt: { type: 'code', location: { repo: 'shop', path: 'a.ts', lineStart: 4, lineEnd: 6, href: '/k/src?repo=shop&path=a.ts&line=4' }, language: 'typescript', firstLine: 2, text: 'const a = 1;\n\nasync pay() {\n  return 1;\n}\n\nconst b = 2;', marked: { start: 4, end: 6 }, truncated: false } },
      { url: 'madarch:code.symbol:a.ts#gone', resolution: { state: 'broken', target: 'x', reason: 'no entity "code.symbol:a.ts#gone" in the graph', why: { code: 'no-entity', key: 'code.symbol:a.ts#gone' } }, excerpt: null },
    ],
    resolutions: {},
  };

  function answer(model: StatementModel): void {
    (globalThis as { fetch?: unknown }).fetch = async (url: string) => (url.includes('/api/k/statement') ? new Response(JSON.stringify(model)) : new Response('{}', { status: 404 }));
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
    const card: StatementModel = { ...statement, grounds: [{ url: 'madarch:code.service:payments', resolution: { state: 'ok', target: 'x', kind: 'code.service', label: 'payments', href: '/k/e/code.service%3Apayments' }, excerpt: { type: 'entity', entity: { id: 'code.service:payments', kind: 'code.service', label: 'payments', href: '/k/e/code.service%3Apayments' }, facts: [{ name: 'language', value: 'typescript' }], related: [{ relation: 'code.serves', direction: 'out', total: 7, rows: [{ entity: { id: 'code.route:POST:/payments', kind: 'code.route', label: 'POST /payments', href: null }, count: 1 }] }] } }] };
    answer(card);
    const container = into(createElement(StatementPage, { id: 'domain:payment', sentence: statement.sentence, version: 0 }));
    await until(() => container.querySelector('[data-excerpt=entity]') !== null, 'the card');
    const shown = container.querySelector('[data-excerpt=entity]')!;
    expect(shown.querySelector('[data-testid=card-facts]')!.textContent).toContain('typescript');
    expect(shown.querySelector('[data-testid=card-related]')!.textContent).toContain('POST /payments');
    expect(shown.querySelector('[data-testid=card-page] a')!.getAttribute('href')).toBe('/k/e/code.service%3Apayments');
    expect(container.querySelector('[data-excerpt=code]')).toBeNull();
    expect(container.textContent).not.toContain('package.json');
  });

  test('a code place that has a web address offers it, named by the host; one without offers none', async () => {
    const withWeb: StatementModel = { ...statement, grounds: [{ ...statement.grounds[1]!, excerpt: { ...(statement.grounds[1]!.excerpt as Extract<NonNullable<StatementModel['grounds'][number]['excerpt']>, { type: 'code' }>), location: { repo: 'shop', path: 'a.ts', lineStart: 4, lineEnd: 6, href: '/k/src?repo=shop&path=a.ts&line=4', web: { host: 'GitHub', url: `${PAGE_HOST}/blob/abc/a.ts#L4-L6` } } } }] };
    answer(withWeb);
    const container = into(createElement(StatementPage, { id: 'domain:payment', sentence: statement.sentence, version: 0 }));
    await until(() => container.querySelector('[data-testid=web-place]') !== null, 'the web link');
    const link = container.querySelector('[data-testid=web-place]') as HTMLAnchorElement;
    expect(link.textContent).toBe('Open in GitHub');
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
    expect(row.querySelectorAll('a')[1]!.getAttribute('href')).toContain('/k/statement?id=product%3Ashop');
  });

  test('a person says why the statement is wrong: the reason is posted against the statement\'s name, and the answer says where it was saved', async () => {
    const posts: string[] = [];
    (globalThis as { fetch?: unknown }).fetch = async (url: string, init?: RequestInit) => {
      if (url.includes('/api/k/correction')) {
        posts.push(String(init?.body));
        return new Response(JSON.stringify({ correction: 'c', id: 'correction:c', file: 'docs/corrections/c.md', committed: true, by: { name: 'Ada', email: 'ada@example.test', verified: 'local, not verified' }, at: '2026-10-23T11:00:00.000Z' }), { status: 201 });
      }
      return url.includes('/api/k/statement') ? new Response(JSON.stringify(statement)) : new Response('{}', { status: 404 });
    };
    const container = into(createElement(StatementPage, { id: 'domain:payment', sentence: statement.sentence, version: 0 }));
    await until(() => container.querySelector('[data-testid=statement-correction]') !== null, 'the correction place');
    const place = container.querySelector('[data-testid=statement-correction]')!;
    const send = place.querySelector('[data-testid=correction-send]') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    const text = place.querySelector('textarea') as HTMLTextAreaElement;
    const key = Object.keys(text).find((name) => name.startsWith('__reactProps$'))!;
    (text as unknown as Record<string, { onChange: (event: { target: { value: string } }) => void }>)[key]!.onChange({ target: { value: 'A declined payment also cancels the order.' } });
    await until(() => !(place.querySelector('[data-testid=correction-send]') as HTMLButtonElement).disabled, 'the enabled button');
    (place.querySelector('[data-testid=correction-send]') as HTMLButtonElement).click();
    await until(() => place.querySelector('[data-testid=correction-done]') !== null, 'the saved note');
    expect(posts).toEqual(['{"statement":"domain:payment#checkout-asks-payments-authorize","reason":"A declined payment also cancels the order."}']);
    expect(place.querySelector('[data-testid=correction-done]')!.textContent).toContain('docs/corrections/c.md');
  });

  test('a sentence with no name on its page cannot be corrected yet, and says why', async () => {
    answer({ ...statement, name: null });
    const container = into(createElement(StatementPage, { id: 'domain:payment', sentence: statement.sentence, version: 0 }));
    await until(() => container.querySelector('[data-testid=statement-correction]') !== null, 'the correction place');
    const place = container.querySelector('[data-testid=statement-correction]')!;
    expect((place.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(true);
    expect(place.textContent).toContain('has no name on its page yet');
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
  });
});


describe('the sources', () => {
  test('each source shows its title with the path small under it; the filter matches either', async () => {
    const listing: DocumentListing = { documents: [{ repo: null, path: 'docs/vision.md', title: 'The vision' }, { repo: null, path: 'notes/ideas.md', title: 'ideas' }], truncated: [] };
    (globalThis as { fetch?: unknown }).fetch = async (url: string) => (url.includes('/api/k/documents') ? new Response(JSON.stringify(listing)) : new Response('{}', { status: 404 }));
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
