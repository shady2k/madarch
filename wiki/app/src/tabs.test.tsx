/** A page's tabs (madarch-64o5.135): the tab a reader left a page on is the tab it opens with, and a fresh page opens its first. */
import { afterAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register({ url: 'http://localhost/e/code.file/repo/src/index.ts' });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { TabsSection } = await import('./components/tabs.js');
await import('./i18n.js');
afterAll(() => { GlobalRegistrator.unregister(); });

function context(section: { id: string; params: Record<string, unknown>; title: Record<string, string> }) {
  return {
    section: { ...section, component: 'tabs', on: 'subject', replace: false, line: 1, alias: 's_tabs' },
    data: {}, language: 'en', base: '', busy: false, variables: {}, open: () => undefined, reload: () => undefined,
    renderSection: (id: string) => createElement('div', { 'data-section': id }, id), product: null, navigation: null, pageName: null,
  } as unknown as Parameters<typeof TabsSection>[0]['context'];
}

const composition = {
  id: 'tabs', component: 'tabs', on: 'subject', replace: false, line: 1, alias: 's_tabs',
  title: { en: 'Tabs', ru: 'Вкладки' },
  params: { groups: [{ title: { en: 'Overview', ru: 'Обзор' }, sections: ['facts'] }, { title: { en: 'History', ru: 'История' }, sections: ['history'] }] },
};
const sectionsOf = [{ id: 'facts', title: { en: 'Facts' } }, { id: 'history', title: { en: 'History' } }] as unknown as Parameters<typeof TabsSection>[0]['sections'];

async function render(): Promise<{ container: HTMLElement; close: () => Promise<void> }> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(TabsSection, { context: context(composition as never), sections: sectionsOf })); });
  return { container, close: async () => { await act(async () => { root.unmount(); }); container.remove(); } };
}

test('a page opens the tab the reader left it on, and its first tab when there is no memory', async () => {
  try { window.localStorage.clear(); } catch { /* none */ }
  const first = await render();
  try {
    expect(first.container.querySelector('[data-section]')?.getAttribute('data-section')).toBe('facts');
    const triggers = [...first.container.querySelectorAll('[role="tab"]')];
    expect(triggers).toHaveLength(2);
    await act(async () => { triggers[1]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); });
    expect(first.container.querySelector('[data-section]')?.getAttribute('data-section')).toBe('history');
  } finally {
    await first.close();
  }
  // The same address again: the remembered tab stands open.
  const again = await render();
  try {
    expect(again.container.querySelector('[data-section]')?.getAttribute('data-section')).toBe('history');
    expect(again.container.querySelector('[role="tab"][data-state="active"]')?.textContent).toBe('History');
  } finally {
    await again.close();
  }
});
