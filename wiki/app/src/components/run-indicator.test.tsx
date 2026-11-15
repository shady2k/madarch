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
  return { runId: 'run-1', state, phase: state === 'completed_partial' ? 'partial' : state === 'cancelled' ? 'stopped' : state, final: ['succeeded', 'completed_partial', 'failed', 'cancelled', 'blocked'].includes(state), startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), finishedAt: null, elapsedMs: 10, remainingMs: 0, selected: [], order: [], vertex: null, groups: [], units: [], events: [], records: 0, publishedUnits: 0, agentUsage: null };
}

let statusState = 'running';
async function render(runState: string): Promise<{ readonly read: () => { readonly indicator: boolean; readonly entry: boolean }; readonly close: () => Promise<void> }> {
  const container = document.createElement('div');
  document.body.append(container);
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname.endsWith('/api/status')) return new Response(JSON.stringify({ fill: statusState === 'idle' ? { state: 'idle' } : { state: 'running', runId: 'run-1' } }), { headers: { 'content-type': 'application/json' } });
    if (url.pathname.endsWith('/api/fill-runs')) return new Response(JSON.stringify({ run: run(runState) }), { headers: { 'content-type': 'application/json' } });
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const root = createRoot(container);
  await act(async () => { root.render(createElement(RunIndicator, { base: '', open: () => undefined })); });
  for (let at = 0; at < 10; at += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  return {
    read: () => ({ indicator: container.querySelector('[data-testid="run-indicator"]') !== null, entry: container.querySelector('[data-testid="fill-entry"]') !== null }),
    close: async () => { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

test('one fill control: the run while it goes, the fill entry when it ends', async () => {
  statusState = 'running';
  const going = await render('running');
  try { expect(going.read()).toEqual({ indicator: true, entry: false }); } finally { await going.close(); }
  statusState = 'idle';
  const ended = await render('succeeded');
  try { expect(ended.read()).toEqual({ indicator: false, entry: true }); } finally { await ended.close(); }
});

test('a run that starts and ends switches the one control without a reload', async () => {
  statusState = 'running';
  const page = await render('running');
  try {
    expect(page.read()).toEqual({ indicator: true, entry: false });
    statusState = 'idle';
    // The indicator's own one-second read is the switch; no page load and no remount.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2500)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(page.read()).toEqual({ indicator: false, entry: true });
  } finally { await page.close(); }
});
