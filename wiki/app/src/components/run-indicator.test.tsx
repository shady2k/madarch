import { afterAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register({ url: 'http://localhost/p/run' });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { RunIndicator } = await import('./run-indicator.js');
await import('../i18n.js');
afterAll(() => { GlobalRegistrator.unregister(); });

function run(state: string) {
  return { runId: 'run-1', state, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), finishedAt: null, elapsedMs: 10, remainingMs: 0, selected: [], order: [], vertex: null, groups: [], units: [], events: [], records: 0, publishedUnits: 0, agentUsage: null };
}

async function render(runState: string): Promise<{ readonly shown: boolean; close: () => Promise<void> }> {
  const container = document.createElement('div');
  document.body.append(container);
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname.endsWith('/api/status')) return new Response(JSON.stringify({ fill: { state: 'running', runId: 'run-1' } }), { headers: { 'content-type': 'application/json' } });
    if (url.pathname.endsWith('/api/fill-runs')) return new Response(JSON.stringify({ run: run(runState) }), { headers: { 'content-type': 'application/json' } });
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const root = createRoot(container);
  await act(async () => { root.render(createElement(RunIndicator, { base: '', open: () => undefined })); });
  for (let at = 0; at < 10; at += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  const shown = container.querySelector('[data-testid="run-indicator"]') !== null;
  return { shown, close: async () => { await act(async () => { root.unmount(); }); container.remove(); } };
}

test('the indicator is drawn while the run goes and gone once the run ends', async () => {
  const going = await render('running');
  try { expect(going.shown).toBe(true); } finally { await going.close(); }
  const ended = await render('succeeded');
  try { expect(ended.shown).toBe(false); } finally { await ended.close(); }
});
