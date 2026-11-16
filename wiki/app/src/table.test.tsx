/** Graph-backed member links, anchors and typed table filters (madarch-64o5.135). */
import { afterAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/e/sample.reader/owner' });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { TableSection } = await import('./components/table.js');
const { formatValue } = await import('./components/format.js');
await import('./i18n.js');
afterAll(() => { GlobalRegistrator.unregister(); });

test('members expose stable anchors and linked readers, with an explicit incomplete-list count', async () => {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const context = {
    section: { id: 'members', component: 'table', on: 'subject', replace: false, line: 1, alias: 's_members', params: {
      path: '.', rowAnchorPath: 'node.id', rowAnchorPrefix: 'member-', columns: [
        { label: { en: 'Field' }, path: 'node.label' }, { label: { en: 'Readers' }, path: 'node.readers', format: 'links' },
      ],
    } },
    data: { edges: [{ node: { id: 'field-1', kind: 'sample.member', label: 'title', readers: {
      edges: [{ node: { id: 'reader-1', kind: 'sample.reader', label: 'readTitle' } }], totalCount: 4,
      pageInfo: { hasNextPage: true, endCursor: 'next' },
    } } }], totalCount: 1, pageInfo: { hasNextPage: false } },
    language: 'en', base: '', busy: false, variables: {}, open: () => undefined, reload: () => undefined,
    renderSection: () => null, product: null, navigation: null, pageName: null,
  } as unknown as Parameters<typeof TableSection>[0]['context'];
  try {
    await act(async () => { root.render(createElement(TableSection, { context })); });
    expect(container.querySelector('#member-field-1')).not.toBeNull();
    expect(container.querySelector('a[href="/e/sample.reader/reader-1"]')?.textContent).toBe('readTitle');
    expect(container.textContent).toContain('Showing 1 of 4');
  } finally { await act(async () => { root.unmount(); }); container.remove(); }
});

test('co-change shares are percentages, not ratios or guessed counts', () => {
  expect(formatValue(25, 'percent', 'en')).toBe('25%');
  expect(formatValue(100 / 3, 'percent', 'en')).toBe('33.3%');
  expect(formatValue(null, 'percent', 'en')).toBe('');
});

