/**
 * The product's sidebar (decision 0031, kept by decision 0036): the sections by the reader's purpose and the groups of the
 * kinds, the group the manifest opens standing open, filled entries before empty ones, the role's leading groups first,
 * and the «+N» of a live fill on the kinds it has still to write.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register({ url: 'http://localhost/' });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { FrameNavigation } = await import('../frame.js');
const { setWikiLanguage } = await import('../i18n.js');

beforeAll(async () => { await setWikiLanguage('en'); });
afterAll(() => { GlobalRegistrator.unregister(); });

const entry = (kind: string): string => `e-${kind}`;

function kind(name: string, over: Partial<NavigationKind> = {}): NavigationKind {
  return { kind: name, one: name, many: `${name} rows`, definition: null, taken: true, group: 'code', nav: null, count: 1, entryId: entry(name), purpose: null, audience: null, ...over };
}

type Navigation = Parameters<typeof FrameNavigation>[0]['navigation'];
type NavigationKind = NonNullable<Navigation>['kinds'][number];

async function render(navigation: Navigation, over: { readonly role?: string; readonly pending?: Record<string, number>; readonly leads?: readonly string[] } = {}): Promise<{ container: HTMLElement; opened: string[]; close: () => Promise<void> }> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const opened: string[] = [];
  await act(async () => {
    root.render(createElement(FrameNavigation, {
      navigation,
      base: '',
      path: '/',
      open: (address: string) => { opened.push(address); },
      tasks: { home: true, frame: null },
      role: over.role ?? 'everything',
      productName: 'Shop',
      pending: over.pending,
      leads: over.leads ?? [],
      changed: new Set<string>(),
    }));
  });
  return { container, opened, close: async () => { await act(async () => { root.unmount(); }); container.remove(); } };
}

const purposes = [{ id: 'understand', labels: { en: 'Understand', ru: 'Понять' } }];

test('a product with purposes lists its kinds in the reader\'s sections, the role\'s audience and the filled kinds only', async () => {
  const navigation = {
    product: 'Shop',
    groups: [{ name: 'code', labels: { en: 'Code', ru: 'Код' }, short: null, open: true, parent: null }],
    purposes,
    kinds: [
      kind('code.open', { purpose: 'understand', audience: ['developer'] }),
      kind('code.hidden', { purpose: 'understand', audience: ['analyst'] }),
      kind('code.empty', { purpose: 'understand', count: 0 }),
    ],
  };
  const page = await render(navigation, { role: 'developer' });
  try {
    const sections = [...page.container.querySelectorAll('[data-testid="nav-purpose"]')];
    expect(sections.map((section) => section.getAttribute('data-purpose'))).toEqual(['understand']);
    expect(sections[0]?.querySelector('h2')?.textContent).toBe('Understand');
    expect([...sections[0]!.querySelectorAll('[data-testid="nav-kind"]')].map((row) => row.textContent)).toEqual(['code.open rows1']);
    // The manifest's groups stand aside while the product lists its kinds by purpose.
    expect(page.container.querySelector('[data-testid="nav-group"]')).toBeNull();
  } finally {
    await page.close();
  }
});

test('the reader of every role reads every audience, and an empty kind is not listed among purposes', async () => {
  const navigation = {
    product: 'Shop', groups: [], purposes,
    kinds: [
      kind('code.open', { purpose: 'understand', audience: ['developer'] }),
      kind('code.hidden', { purpose: 'understand', audience: ['analyst'] }),
      kind('code.empty', { purpose: 'understand', count: 0 }),
    ],
  };
  const page = await render(navigation);
  try {
    const rows = [...page.container.querySelectorAll('[data-testid="nav-kind"]')];
    expect(rows.map((row) => row.textContent)).toEqual(['code.open rows1', 'code.hidden rows1']);
  } finally {
    await page.close();
  }
});

test('without purposes the manifest\'s groups stand open as it says, filled kinds and groups before empty ones', async () => {
  const navigation = {
    product: 'Shop',
    groups: [
      { name: 'empty', labels: { en: 'Empty', ru: 'Пусто' }, short: null, open: false, parent: null },
      { name: 'code', labels: { en: 'Code', ru: 'Код' }, short: null, open: true, parent: null },
    ],
    purposes: [],
    kinds: [
      kind('code.zero', { count: 0 }),
      kind('code.full', { count: 2 }),
      kind('empty.zero', { count: 0, group: 'empty' }),
    ],
  };
  const page = await render(navigation, { pending: { 'code.full': 3 } });
  try {
    const groups = [...page.container.querySelectorAll('[data-nav-group]')];
    // The filled group stands first, the empty one after it; the manifest opens `code` and leaves `empty` closed.
    expect(groups.map((group) => group.getAttribute('data-nav-group'))).toEqual(['code', 'empty']);
    expect(groups.map((group) => group.querySelector('[data-testid="nav-group"]')?.getAttribute('aria-expanded'))).toEqual(['true', 'false']);
    const rows = [...page.container.querySelectorAll('[data-testid="nav-kind"]')];
    // The filled kind stands before the empty one, which is listed too, in the manifest's order within each set.
    expect(rows.map((row) => row.querySelector('[data-testid="nav-count"]')?.textContent)).toEqual(['2+3', '0']);
    expect(rows[1]?.getAttribute('data-empty')).toBe('true');
    expect(page.container.querySelector('[data-testid="nav-pending"]')?.getAttribute('title')).toBe('3 more being written');
  } finally {
    await page.close();
  }
});

test('the groups the reader\'s role leads stand first, in the role\'s own order', async () => {
  const navigation = {
    product: 'Shop',
    groups: [
      { name: 'code', labels: { en: 'Code', ru: 'Код' }, short: null, open: false, parent: null },
      { name: 'data', labels: { en: 'Data', ru: 'Данные' }, short: null, open: false, parent: null },
      { name: 'design', labels: { en: 'Design', ru: 'Дизайн' }, short: null, open: false, parent: null },
    ],
    purposes: [],
    kinds: [kind('code.a'), kind('data.b', { group: 'data' }), kind('design.c', { group: 'design' })],
  };
  const page = await render(navigation, { role: 'analyst', leads: ['data', 'design'] });
  try {
    expect([...page.container.querySelectorAll('[data-nav-group]')].map((group) => group.getAttribute('data-nav-group'))).toEqual(['data', 'design', 'code']);
  } finally {
    await page.close();
  }
});

test('the group a sidebar row opens comes forward from the catalogue entry of its kind', async () => {
  const navigation = { product: 'Shop', groups: [{ name: 'code', labels: { en: 'Code', ru: 'Код' }, short: null, open: true, parent: null }], purposes: [], kinds: [kind('code.full')] };
  const page = await render(navigation);
  try {
    const row = page.container.querySelector('[data-testid="nav-kind"]') as HTMLAnchorElement | null;
    expect(row?.getAttribute('href')).toBe('/e/catalogue/e-code.full');
    await act(async () => { row?.click(); });
    expect(page.opened).toEqual(['/e/catalogue/e-code.full']);
  } finally {
    await page.close();
  }
});

test('a control press on a sidebar row opens the page in a tab of its own', async () => {
  const navigation = { product: 'Shop', groups: [{ name: 'code', labels: { en: 'Code', ru: 'Код' }, short: null, open: true, parent: null }], purposes: [], kinds: [kind('code.full')] };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const opened: { address: string; newTab?: boolean }[] = [];
  try {
    await act(async () => {
      root.render(createElement(FrameNavigation, {
        navigation, base: '', path: '/', open: (address: string, options?: { readonly newTab?: boolean }) => { opened.push({ address, newTab: options?.newTab }); },
        tasks: { home: true, frame: null }, role: 'everything', productName: 'Shop',
      }));
    });
    const row = container.querySelector('[data-testid="nav-kind"]') as HTMLAnchorElement;
    await act(async () => { row.dispatchEvent(new MouseEvent('click', { button: 0, ctrlKey: true, bubbles: true, cancelable: true })); });
    expect(opened).toEqual([{ address: '/e/catalogue/e-code.full', newTab: true }]);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

