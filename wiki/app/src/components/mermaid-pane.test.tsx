/**
 * The Mermaid pane's tooltips (madarch-64o5.96): Mermaid returns the handlers that attach them with the drawn picture,
 * and the pane must call them on the frame it rendered into — a shortened label keeps its whole path as the hover text
 * only through those handlers.
 */
import { afterAll, expect, mock, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register({ url: 'http://localhost/' });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const bound: Element[] = [];
mock.module('mermaid', () => ({
  default: {
    initialize: (): void => undefined,
    render: async (): Promise<{ svg: string; bindFunctions: (element: Element) => void }> => ({
      svg: '<svg width="200" height="100"><g class="node"><a xlink:href="/e/demo.file/1"><text>index.ts</text></a></g></svg>',
      bindFunctions: (element: Element): void => { bound.push(element); },
    }),
  },
}));
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MermaidPane } = await import('../components/diagram-panes/mermaid-pane.js');

afterAll(() => { GlobalRegistrator.unregister(); });

test('the drawn picture\'s own handlers are called on the frame, so its tooltips attach', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(MermaidPane, { answer: { format: 'mermaid', entity: { id: '1', kind: 'demo.file', label: 'index.ts' }, depth: 1, folded: 0, truncated: false, source: 'flowchart LR' }, open: () => undefined }));
    });
    for (let at = 0; at < 10; at += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    const frame = container.querySelector('[data-testid="mermaid-pane"]');
    expect(frame).not.toBeNull();
    expect(bound).toContain(frame as Element);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
