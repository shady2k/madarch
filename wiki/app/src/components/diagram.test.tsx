import { afterAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { SectionContext } from './types.js';
import { LIKE_C4_THEME_CSS } from './diagram-panes/likec4-pane.js';

GlobalRegistrator.register({ url: 'http://localhost/' });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
await import('../i18n.js');
const { DiagramSection } = await import('./diagram.js');
afterAll(() => { GlobalRegistrator.unregister(); });

async function settle(): Promise<void> {
  for (let at = 0; at < 8; at += 1) await act(async () => { await Promise.resolve(); });
}

function context(id: string, depth = 1, aggregateAbove = 12, language = 'en'): SectionContext {
  return {
    section: { id: 'diagram', component: 'diagram', on: 'subject', replace: false, params: { depth, aggregateAbove }, line: 1, alias: 's_diagram' },
    data: { id }, language, base: '', busy: false, variables: {}, open: () => undefined, reload: () => undefined,
    renderSection: () => null, product: null, navigation: null, pageName: null,
  };
}

 test('diagram answers belong to the full render address, including late answers', async () => {
  const requests: string[] = [];
  let finishOld: ((value: Response) => void) | undefined;
  globalThis.fetch = (async (url: string) => {
    requests.push(url);
    if (new URL(url, 'http://localhost').searchParams.get('entity') === 'old') {
      return await new Promise<Response>((resolve) => { finishOld = resolve; });
    }
    return new Response(JSON.stringify({ message: url }), { status: 400 });
  }) as typeof fetch;
  window.localStorage.removeItem('madarch-wiki-diagram');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const show = async (value: SectionContext): Promise<void> => {
    await act(async () => { root.render(createElement(DiagramSection, { context: value })); });
    await settle();
  };
  try {
    const asked = (format: string): string[] => requests.filter((one) => one.includes(`format=${format}`));
    await show(context('old'));
    await show(context('new'));
    // A renderer that fails hands the picture to the next one, and the failed address stays failed for this page.
    expect(asked('likec4')).toHaveLength(2);
    expect(asked('mermaid')).toHaveLength(1);
    await act(async () => { finishOld?.(new Response(JSON.stringify({ message: 'obsolete answer' }), { status: 400 })); });
    await settle();
    expect(container.textContent).not.toContain('obsolete answer');
    await show(context('third'));
    expect(asked('likec4')).toHaveLength(3);
    await show(context('third', 2));
    expect(asked('likec4')).toHaveLength(4);
    await show(context('third', 2, 8));
    expect(asked('likec4')).toHaveLength(5);
    await show(context('third', 2, 8, 'ru'));
    expect(asked('likec4')).toHaveLength(6);
    expect(asked('likec4')[5]).toContain('lang=ru&format=likec4');
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test('the LikeC4 palette is the kit tokens, not its own blue', () => {
  expect(LIKE_C4_THEME_CSS).toContain('--likec4-palette-fill: var(--surface-active)');
  expect(LIKE_C4_THEME_CSS).toContain('--likec4-palette-stroke: var(--border)');
});

test('a failed LikeC4 picture hands the picture to Mermaid, and the page names the one that drew it', async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (url: string) => {
    requests.push(String(url));
    if (String(url).includes('format=likec4')) return new Response(JSON.stringify({ code: 'FAILED' }), { status: 500 });
    return new Response(JSON.stringify({ format: 'mermaid', entity: { id: 'uid', kind: 'a.file', label: 'a.ts' }, depth: 1, folded: 0, truncated: false, source: 'flowchart LR\n  n1[a.ts]' }), { status: 200 });
  }) as unknown as typeof fetch;
  try { window.localStorage.removeItem('madarch-wiki-diagram'); } catch { /* no storage */ }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(DiagramSection, { context: context('uid') })); });
    await settle();
    expect(requests.some((one) => one.includes('format=mermaid'))).toBe(true);
    expect(container.querySelector('[data-testid="diagram-fallback"]')?.textContent).toContain('Mermaid');
    expect(container.textContent).not.toContain('The diagram could not be built.');
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test('a picture fills the window on a press, and the same figure lets a reader leave it', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ code: 'FAILED' }), { status: 500 })) as unknown as typeof fetch;
  try { window.localStorage.removeItem('madarch-wiki-diagram'); } catch { /* no storage */ }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(DiagramSection, { context: context('uid') })); });
    await settle();
    const press = container.querySelector('[data-testid="diagram-fullscreen"]');
    expect(press).not.toBeNull();
    await act(async () => { press?.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
    expect(document.querySelector('[data-testid="diagram-fullscreen-body"]')).not.toBeNull();
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await Promise.resolve(); });
    expect(document.querySelector('[data-testid="diagram-fullscreen-body"]')).toBeNull();
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
