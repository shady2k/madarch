import { afterAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { SectionContext } from './types.js';

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
    data: { id }, language, base: '', busy: false, open: () => undefined, reload: () => undefined,
    renderSection: () => null, product: null, navigation: null,
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
    await show(context('old'));
    await show(context('new'));
    expect(requests).toHaveLength(2);
    await act(async () => { finishOld?.(new Response(JSON.stringify({ message: 'obsolete answer' }), { status: 400 })); });
    await settle();
    expect(container.textContent).not.toContain('obsolete answer');
    await show(context('third'));
    expect(requests).toHaveLength(3);
    await show(context('third', 2));
    expect(requests).toHaveLength(4);
    await show(context('third', 2, 8));
    expect(requests).toHaveLength(5);
    await show(context('third', 2, 8, 'ru'));
    expect(requests).toHaveLength(6);
    expect(requests[5]).toContain('lang=ru&format=likec4');
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
