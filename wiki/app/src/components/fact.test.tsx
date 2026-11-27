/**
 * A home fact (madarch-64o5.133): a number or a chart the graph answered, the ground it rests on — the kind, the field,
 * how many records the answer counted and how many the shown rows do not account for — and the way into the kind page.
 */
import { afterAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register({ url: 'http://localhost/' });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { i18n } = await import('../i18n.js');
const { FactSection } = await import('./fact.js');
const { FactsSection } = await import('./facts.js');
const { BarsSection } = await import('./bars.js');
await i18n.changeLanguage('en');

afterAll(() => { GlobalRegistrator.unregister(); });

const NAVIGATION = {
  product: 'shop',
  groups: [],
  kinds: [{ kind: 'demo.file', one: 'File', many: 'Files', definition: null, taken: true, group: null, nav: null, count: 5, entryId: 'entry-1' }],
  purposes: [],
};

function context(params: Record<string, unknown>, data: unknown): unknown {
  return {
    section: { id: 'fact', component: 'fact', params, line: 1, on: 'root', replace: false, title: { en: 'Files' }, alias: 's_fact' },
    data,
    language: 'en',
    base: '',
    busy: false,
    variables: {},
    open: () => undefined,
    reload: () => undefined,
    renderSection: () => null,
    product: 'shop',
    navigation: NAVIGATION,
    pageName: null,
  };
}

async function render(params: Record<string, unknown>, data: unknown, Component = FactSection): Promise<{ host: HTMLElement; close: () => Promise<void> }> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(Component, { context: context(params, data) as never })); });
  return { host, close: async () => { await act(async () => { root.unmount(); }); host.remove(); } };
}

test('a counted fact is one number, its ground names the kind and the population, and its title opens the kind page', async () => {
  const page = await render({ kind: 'demo.file', display: 'number' }, { count: 1234 });
  try {
    expect(page.host.querySelector('[data-testid="fact-number"]')?.textContent).toBe('1,234');
    expect(page.host.querySelector('[data-testid="home-fact"]')?.getAttribute('data-kind')).toBe('demo.file');
    expect(page.host.textContent).toContain('Grounds');
    expect(page.host.textContent).toContain('Files');
    expect(page.host.querySelector('[data-testid="fact-total"]')?.textContent).toBe('1,234');
    expect(page.host.querySelector('[data-testid="fact-measure"]')?.textContent).toBe('A count of the records');
    // A number counts the whole population, so no row stands outside the answer.
    expect(page.host.querySelector('[data-testid="fact-unaccounted"]')).toBeNull();
    expect(page.host.querySelector('a')?.getAttribute('href')).toBe('/e/catalogue/entry-1');
  } finally { await page.close(); }
});

test('a grouped fact draws its rows and says how many records the rows do not account for', async () => {
  const page = await render(
    { kind: 'demo.file', display: 'bar', by: 'language' },
    { count: 9, groupBy: [{ key: 'ts', count: 5 }, { key: 'ru', count: 3 }] },
  );
  try {
    const rows = [...page.host.querySelectorAll('[data-display="bar"] tbody tr')].map((row) => (row.textContent ?? '').replace(/\s+/g, ' ').trim());
    expect(rows).toEqual(['ts5', 'ru3']);
    expect(page.host.querySelector('[data-testid="fact-total"]')?.textContent).toBe('9');
    expect(page.host.querySelector('[data-testid="fact-unaccounted"]')?.textContent).toBe('1');
    expect(page.host.textContent).toContain('Records in no shown row');
    expect(page.host.querySelector('[data-testid="fact-measure"]')?.textContent).toBe('Grouped by one field');
    expect(page.host.textContent).toContain('language');
  } finally { await page.close(); }
});

test('a histogram names its buckets by the days they cover, and a ranking claims no partition', async () => {
  const buckets = await render(
    { kind: 'demo.file', display: 'timeline', by: 'lastChange' },
    { count: 4, histogram: [{ from: null, to: 30, count: 2 }, { from: 30, to: 90, count: 2 }, { from: 90, to: null, count: 0 }] },
  );
  try {
    const labels = [...buckets.host.querySelectorAll('[data-display="timeline"] tbody tr td:first-child')].map((cell) => cell.textContent);
    expect(labels).toEqual(['under 30 days', '30–90 days', '90+ days']);
    expect(buckets.host.querySelector('[data-testid="fact-unaccounted"]')?.textContent).toBe('0');
  } finally { await buckets.close(); }
  const ranked = await render(
    { kind: 'demo.file', display: 'bar', by: 'bytes' },
    { count: 40, topN: [{ node: { label: 'big.ts' }, value: 900 }, { node: { label: 'small.ts' }, value: 10 }] },
  );
  try {
    expect(ranked.host.querySelector('[data-testid="fact-unaccounted"]')).toBeNull();
    expect(ranked.host.textContent).toContain('big.ts');
  } finally { await ranked.close(); }
});

test('an answer with no values says so rather than drawing an empty chart', async () => {
  const page = await render({ kind: 'demo.file', display: 'bar', by: 'language' }, { count: 0, groupBy: [] });
  try {
    expect(page.host.querySelector('[data-testid="fact-none"]')?.textContent).toBe('No values in the graph.');
  } finally { await page.close(); }
});

test('timestamp rankings render both PostgreSQL value representations as dates', async () => {
  const recent = '2024-02-29T15:30:00+00:00';
  const older = new Date('1969-10-29T15:30:00Z');
  const topN = [
    { node: { label: 'recent' }, value: recent },
    { node: { label: 'older' }, value: older },
  ];
  const facts = await render({ kind: 'demo.file', display: 'bar', by: 'lastChange' }, { count: 2, topN });
  const bars = await render({ path: 'topN', labelPath: 'node.label', valuePath: 'value' }, { topN }, BarsSection);
  try {
    const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });
    const expected = [['recent', dateFormat.format(new Date(recent))], ['older', dateFormat.format(older)]];
    for (const page of [facts, bars]) {
      const rows = [...page.host.querySelectorAll('tbody tr')].map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent));
      expect(rows).toEqual(expected);
    }
  } finally {
    await bars.close();
    await facts.close();
  }
});

test('grouped and labelled facts retain timestamp values', async () => {
  const time = new Date('2024-02-29T15:30:00Z');
  const iso = '2024-02-29T16:30:00+00:00';
  const grouped = await render({ kind: 'demo.file', display: 'bar', by: 'lastChange' }, {
    count: 2, groupBy: [{ key: time, count: 1 }, { key: iso, count: 1 }],
  });
  const labelled = await render({
    rows: [{ label: { en: 'First' }, path: 'first', format: 'date' }, { label: { en: 'Second' }, path: 'second', format: 'date' }],
  }, { first: time, second: iso }, FactsSection);
  try {
    const labels = [...grouped.host.querySelectorAll('tbody tr td:first-child')].map(cell => cell.textContent);
    expect(labels.sort()).toEqual([time.toISOString(), iso].sort());
    expect(grouped.host.querySelector('[data-testid="fact-unaccounted"]')?.textContent).toBe('0');
    const dates = [...labelled.host.querySelectorAll('[data-testid="fact-value"]')].map(cell => cell.textContent);
    const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium' });
    expect(dates).toEqual([dateFormat.format(time), dateFormat.format(new Date(iso))]);
  } finally {
    await labelled.close();
    await grouped.close();
  }
});

test('kind-page bars keep ranked entities with the same label as separate rows', async () => {
  const page = await render({ path: 'largest', labelPath: 'node.label', valuePath: 'value' }, {
    largest: [
      { node: { id: 'first', label: 'index.ts' }, value: 40 },
      { node: { id: 'second', label: 'index.ts' }, value: 20 },
    ],
  }, BarsSection);
  try {
    const rows = [...page.host.querySelectorAll('tbody tr')].map(row => row.textContent);
    expect(rows).toEqual(['index.ts40', 'index.ts20']);
    expect(page.host.querySelectorAll('svg g[data-part="mark"]')).toHaveLength(2);
  } finally { await page.close(); }
});
