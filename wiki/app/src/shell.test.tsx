/**
 * The app's one test (decision 0036, section 7): the shell renders, and a product address renders nothing but the shell.
 * The app has no router yet: the template frontend lands next, so any address — here one of an entity — must show the
 * shell's frame and its note and nothing of a page, a navigation, a control or a query.
 */
import { afterAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

// The DOM is registered before React's client is imported: the client reads `document` when it loads.
GlobalRegistrator.register({ url: 'http://localhost/e/code.file/src%2Fgate%2Fmain.ts' });
// React's `act` needs the shell to say this is a test environment, or every render warns and effects are not flushed.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Shell } = await import('./shell.js');

afterAll(() => { GlobalRegistrator.unregister(); });

test('an entity address renders the shell and nothing but the shell', async () => {
  const container = document.createElement('div');
  container.id = 'root';
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(Shell)); });
    const text = container.textContent ?? '';
    expect(text).toContain('Madarch wiki');
    expect(text).toContain('The page templates arrive with the template frontend.');
    // The whole text is the shell's: no title, kind, label or body of a page came with it.
    expect(text.replace('Madarch wiki', '').replace('The page templates arrive with the template frontend.', '').trim()).toBe('');
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(container.querySelector('a, button, input, select, textarea, form, nav, [data-page], [data-kind], [data-entity]')).toBeNull();
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
}, 15_000);
