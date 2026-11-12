import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FillButton } from './app.js';
import { FillHistory, SelectionRunPage } from './fill-runs.js';
import { setWikiLanguage } from '../i18n.js';
import type { SelectionRun, WikiStatus } from './types.js';

beforeAll(async () => { GlobalRegistrator.register({ url: 'http://localhost/' }); await setWikiLanguage('en'); });
afterAll(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); GlobalRegistrator.unregister(); });
let root: Root | undefined;
afterEach(() => { root?.unmount(); root = undefined; document.body.innerHTML = ''; });
function render(element: ReturnType<typeof createElement>): HTMLElement {
  const node = document.createElement('div'); document.body.append(node); root = createRoot(node); root.render(element); return node;
}
async function until(check: () => boolean): Promise<void> {
  for (let n = 0; n < 100; n++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error(document.body.innerHTML);
}
const run: SelectionRun = { runId: 'own-run', state: 'running', startedAt: '2026-11-12T10:00:00Z', updatedAt: '2026-11-12T10:00:01Z', finishedAt: null, elapsedMs: 1000, remainingMs: null, selected: ['base'], order: ['base'], vertex: null, units: [{ unitId: 'one', stage: 'plugin', scope: 'base', status: 'published', generation: 0, attempts: 1 }, { unitId: 'two', stage: 'plugin', scope: 'base', status: 'running', generation: 0, attempts: 1 }], events: [{ seq: 1, at: '2026-11-12T10:00:01Z', stage: 'plugin', unitId: 'one', type: 'published', summary: 'First batch published' }], records: 3, publishedUnits: 1, groups: [{ kind: 'base', group: 'code', plugin: 'extractor', done: 1, total: 2, state: 'running' }], agentUsage: null };

test('the fill entry is a kit button even for an empty own product, and opens selection directly', async () => {
  const node = render(createElement(FillButton, { status: { fill: { state: 'idle' }, own: true, repositories: [], manifest: 'not-filled' } as unknown as WikiStatus }));
  await until(() => node.querySelector('button') !== null);
  const button = node.querySelector('button')!;
  expect(button.className).toContain('ui-button'); expect(button.textContent).toBe('Fill…');
  expect(button.hasAttribute('aria-haspopup')).toBe(false); button.click();
  expect(window.location.pathname).toBe('/fill'); expect(node.querySelector('[role=dialog]')).toBeNull();
});

test('the active entry counts canonical published units and opens that exact run', async () => {
  globalThis.fetch = (async (_url: string) => Response.json({ run })) as typeof fetch;
  const node = render(createElement(FillButton, { status: { fill: { state: 'running', runId: run.runId } } as WikiStatus }));
  await until(() => node.textContent?.includes('1 of 2') === true);
  node.querySelector('button')!.click(); expect(window.location.pathname).toBe('/fill/runs/own-run');
});

test('a run shows actual plugin progress, honest unknown figures, log, and scoped pause/stop', async () => {
  const calls: { url: string; body: unknown }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url.includes('/api/catalog')) return Response.json({ kinds: [{ kind: 'base', labels: { en: { many: 'Bases' } } }], groups: [{ group: 'code', labels: { en: 'Code' } }] });
    if (init?.method === 'POST') { calls.push({ url, body: JSON.parse(String(init.body)) }); return Response.json({ ok: true }); }
    return Response.json({ run });
  }) as typeof fetch;
  const node = render(createElement(SelectionRunPage, { runId: run.runId, version: 0, refresh: () => undefined }));
  await until(() => node.querySelector('[data-testid=fill-run-group]') !== null);
  expect(node.querySelector('[data-testid=fill-run-group]')!.textContent).toContain('Code · Bases · extractor');
  expect(node.querySelector('[data-testid=fill-run-time]')!.textContent).toContain('not known yet');
  expect(node.querySelector('[data-testid=fill-run-tokens]')!.textContent).toContain('not reported');
  expect(node.querySelector('[data-testid=fill-run-records]')!.textContent).toBe('Facts written: 3');
  expect(node.querySelector('[data-testid=fill-run-log]')!.textContent).toContain('First batch published');
  node.querySelector<HTMLButtonElement>('[data-testid=run-pause]')!.click();
  await until(() => calls.length === 1);
  expect(calls[0]).toEqual({ url: '/api/pause?run=own-run', body: { confirm: true } });
  await until(() => node.querySelector<HTMLButtonElement>('[data-testid=run-stop]')?.disabled === false);
  node.querySelector<HTMLButtonElement>('[data-testid=run-stop]')!.click();
  await until(() => document.querySelector('[data-testid=stop-confirm]') !== null);
  expect(calls.length).toBe(1);
  document.querySelector<HTMLButtonElement>('[data-testid=stop-confirm]')!.click();
  await until(() => calls.length === 2);
  expect(calls[1]).toEqual({ url: '/api/stop?run=own-run', body: { confirm: true } });
});

test('planning has no fake zero-of-zero completion and cannot pause before running', async () => {
  globalThis.fetch = (async (_url: string) => Response.json(_url.includes('/api/catalog') ? { kinds: [], groups: [] } : { run: { ...run, state: 'planning', units: [], publishedUnits: 0, groups: [{ ...run.groups[0]!, total: 0, done: 0 }] } })) as typeof fetch;
  const node = render(createElement(SelectionRunPage, { runId: run.runId, version: 0, refresh: () => undefined }));
  await until(() => node.querySelector('[data-testid=fill-run-group]') !== null);
  expect(node.textContent).toContain('Planning the fill…');
  expect(node.textContent).not.toContain('0 of 0');
  expect(node.querySelector('[data-testid=run-pause]')).toBeNull();
});

test('terminal history opens its own run and links to kind results without live controls', async () => {
  globalThis.fetch = (async (_url: string) => Response.json({ runs: [{ ...run, state: 'succeeded' }] })) as typeof fetch;
  const node = render(createElement(FillHistory, { version: 0 }));
  await until(() => node.querySelector('[data-testid=fill-history-run]') !== null);
  expect(node.querySelector('a')!.getAttribute('href')).toBe('/fill/runs/own-run');
  expect(node.querySelector('a[href="/kind/base"]')).not.toBeNull();
  expect(node.querySelector('[data-testid=run-pause]')).toBeNull();
  expect(node.textContent).toContain('base');
});

test('pausing and cancelling keep their canonical state and cannot pause again', async () => {
  for (const state of ['pausing', 'cancelling', 'succeeded']) {
    globalThis.fetch = (async (_url: string) => Response.json(_url.includes('/api/catalog') ? { kinds: [], groups: [] } : { run: { ...run, state } })) as typeof fetch;
    const node = render(createElement(SelectionRunPage, { runId: run.runId, version: 0, refresh: () => undefined }));
    await until(() => node.querySelector('[data-testid=fill-run-page]') !== null);
    expect(node.querySelector('[data-testid=run-pause]')).toBeNull();
    if (state === 'cancelling') expect(node.querySelector<HTMLButtonElement>('[data-testid=run-stop]')!.disabled).toBe(true);
    if (state === 'succeeded') expect(node.querySelector('[data-testid=fill-run-controls]')).toBeNull();
    root?.unmount(); root = undefined; node.remove();
  }
});

test('terminal zero-unit runs say no units, not planning', async () => {
  for (const state of ['succeeded', 'failed']) {
    globalThis.fetch = (async (_url: string) => Response.json(_url.includes('/api/catalog') ? { kinds: [], groups: [] } : { run: { ...run, state, units: [], publishedUnits: 0, groups: [{ ...run.groups[0]!, state, done: 0, total: 0 }] } })) as typeof fetch;
    const node = render(createElement(SelectionRunPage, { runId: run.runId, version: 0, refresh: () => undefined }));
    await until(() => node.querySelector('[data-testid=fill-run-group]') !== null);
    expect(node.textContent).not.toContain('Planning the fill…');
    expect(node.textContent).toContain('No units were planned');
    expect(node.querySelector('[role=progressbar]')).toBeNull();
    root?.unmount(); root = undefined; node.remove();
  }
});
