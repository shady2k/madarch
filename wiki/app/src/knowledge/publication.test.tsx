import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { KnowledgeApp } from './app.js';
import { setWikiLanguage } from '../i18n.js';

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/catalogue' });
  await setWikiLanguage('en');
});
let root: Root | undefined;
afterEach(() => {
  root?.unmount();
  document.body.innerHTML = '';
  delete (globalThis as { fetch?: unknown }).fetch;
});
afterAll(async () => {
  await new Promise((done) => setTimeout(done, 50));
  GlobalRegistrator.unregister();
});

for (const publication of ['pending', 'failed'] as const) {
  test(`the wiki names ${publication} publication rather than an empty catalogue`, async () => {
    const message = publication === 'pending'
      ? 'The catalogue is being published. Please wait; no catalogue is available yet.'
      : 'The catalogue could not be published: database unavailable';
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/status')) return Response.json({
        product: { name: 'shop', id: 'x' }, manifest: 'not-filled', manifestFile: 'madarch/kinds.yaml', language: 'en', findingCount: 0,
        kinds: [], groups: [], repositories: [], filled: false, incomplete: false, fill: { state: 'idle' },
        writer: { state: 'idle', agent: null, units: [] }, chosenAgent: null, home: null, roles: {},
        bounds: { turns: 30, minutes: 10, toolCalls: 80, writeAttempts: 5, maxDomains: 12, editorialRequestsPerPage: 2 },
        publication, publicationMessage: 'database unavailable',
      });
      return Response.json({ publication, message }, { status: 503 });
    }) as unknown as typeof fetch;
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    root.render(createElement(KnowledgeApp));
    for (let attempt = 0; attempt < 100 && container.querySelector('[data-publication]') === null; attempt++) {
      await new Promise((done) => setTimeout(done, 10));
    }
    const note = container.querySelector('[data-publication]');
    expect(note?.getAttribute('data-publication')).toBe(publication);
    expect(note?.getAttribute('role')).toBe(publication === 'pending' ? 'status' : 'alert');
    expect(note?.textContent).toContain(publication === 'pending' ? 'Publishing the catalogue' : 'database unavailable');
    expect(container.querySelector('[data-testid="knowledge-app"]')).not.toBeNull();
  });
}

test('a published kind declaration stays open before the first fill', async () => {
  window.history.replaceState({}, '', '/kind/goal');
  const declaration = {
    kind: 'goal', subgroup: '', labels: { en: { one: 'Goal', many: 'Goals' } },
    descriptions: { en: 'A result worth reaching.' }, count: 0, page: true, filled: false, state: 'never',
    fillWith: 'agent', fields: [], relations: [],
  };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/api/status')) return Response.json({
      product: { name: 'shop', id: 'x' }, manifest: 'not-filled', language: 'en', findingCount: 0,
      kinds: [], groups: [], repositories: [], filled: false, incomplete: false, fill: { state: 'idle' },
      writer: { state: 'idle', agent: null, units: [] }, chosenAgent: null, home: null, roles: {},
      bounds: { turns: 30, minutes: 10, toolCalls: 80, writeAttempts: 5, maxDomains: 12, editorialRequestsPerPage: 2 },
    });
    if (url.includes('/api/catalog')) return Response.json(new URL(url, 'http://localhost').searchParams.has('kind') ? declaration : {
      product: { name: 'shop', id: 'x' }, language: 'en', kinds: [declaration], groups: [], findings: [],
    });
    if (url.includes('/api/kind-usage')) return Response.json({ usage: { runs: [] } });
    if (url.includes('/api/products')) return Response.json({ products: [] });
    if (url.includes('/api/entities')) return Response.json({ kind: 'goal', total: 0, rows: [], next: null });
    if (url.includes('/api/view')) return Response.json({ renderer: 'mermaid', views: [] });
    return Response.json({});
  }) as unknown as typeof fetch;
  const box = document.createElement('div');
  document.body.append(box);
  root = createRoot(box);
  root.render(createElement(KnowledgeApp));
  for (let attempt = 0; attempt < 100 && box.querySelector('[data-testid="kind-details"]') === null; attempt++) {
    await new Promise((done) => setTimeout(done, 10));
  }
  expect(box.querySelector('[data-testid="kind-meaning"]')?.textContent).toBe('A result worth reaching.');
  expect(box.querySelector('[data-testid="kind-empty"]')).not.toBeNull();
});
