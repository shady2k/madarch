/**
 * The fill's states on the wiki (madarch-8bdc.2.5, item 2), tested without a
 * server: a running fill counts the units and the spans its own trace states,
 * and a failed one names the file, the line and the path its error stands at.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setWikiLanguage } from '../i18n.js';
import { FillCard } from './pages.js';
import { fillShare, fillWords } from './fill-words.js';
import type { FillErrorView, FillProgressView, RepositoryCounts, WikiStatus } from './types.js';

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  await setWikiLanguage('en');
});

afterAll(async () => {
  await new Promise((rest) => setTimeout(rest, 50));
  GlobalRegistrator.unregister();
});

let rendered: Root | undefined;
function into(element: ReturnType<typeof createElement>): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  rendered = createRoot(container);
  rendered.render(element);
  return container;
}

async function until(holds: () => boolean | undefined, what: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (holds()) return;
    await new Promise((step) => setTimeout(step, 10));
  }
  throw new Error(`never came to ${what}; the tree holds: ${document.body.innerHTML.slice(0, 2000)}`);
}

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = '';
});

const status = (over: Partial<WikiStatus> = {}): WikiStatus => ({
  product: { name: 'shop', id: 'x' }, manifest: 'ok', manifestFile: 'madarch/kinds.yaml', language: 'en', seeded: [], findingCount: 0, kinds: [], groups: [],
  repositories: [{ name: 'code', filled: true }], filled: false, incomplete: false,
  fill: { state: 'idle' },
  writer: { state: 'idle', agent: null, units: [] },
  bounds: { turns: 30, minutes: 10, toolCalls: 80, writeAttempts: 5, maxDomains: 12, editorialRequestsPerPage: 2 },
  chosenAgent: null, home: null,
  ...over,
});

describe('the fill card over the trace', () => {
  const counts: RepositoryCounts = { files: 3, commits: 1, folders: 2 };
  const progressOf = (over: Partial<FillProgressView>): FillProgressView => ({ spans: 0, planned: 0, published: 0, failed: 0, blocked: 0, stages: {}, last: null, ...over });

  test('a running fill counts the units its trace names, and says the last thing it did', async () => {
    const held = status({ fill: { state: 'running', startedAt: '2026-11-07T10:00:00Z', progress: progressOf({ spans: 12, planned: 2, published: 1, last: 'fill.unit repository:code (published)' }) } });
    const container = into(createElement(FillCard, { status: held, refresh: () => undefined }));
    await until(() => container.querySelector('[data-testid=fill-progress-counts]') !== null, 'the counts');
    expect(container.querySelector('[data-testid=fill-progress-counts]')!.textContent).toBe('1 of 2 units');
    expect(counts.files).toBe(3);
    expect(container.querySelector('[data-testid=fill-progress-last]')!.textContent).toBe('The last thing the run did: fill.unit repository:code (published)');
    // The bar is the same share: one unit of two.
    expect(fillShare(held.fill)).toBe(0.5);
  });

  test('a run whose units have not landed says how many spans it has written', async () => {
    const held = status({ fill: { state: 'running', progress: progressOf({ spans: 40, last: 'fill.step' }) } });
    const container = into(createElement(FillCard, { status: held, refresh: () => undefined }));
    await until(() => container.querySelector('[data-testid=fill-progress-spans]') !== null, 'the spans');
    expect(container.querySelector('[data-testid=fill-progress-spans]')!.textContent).toBe('The run has written 40 spans of its trace so far');
    expect(fillWords(held.fill, (key, options) => `${key} ${JSON.stringify(options ?? {})}`)).toContain('fillSpans');
  });

  test('a failed fill names the file, the line and the path its error stands at', async () => {
    const error: FillErrorView = { message: 'the git read failed', file: '/work/src/fill/stages/repository-facts.ts', line: 77, path: '/work/products/shop' };
    const held = status({ fill: { state: 'failed', code: 'fill', message: 'the git read failed', error } });
    const container = into(createElement(FillCard, { status: held, refresh: () => undefined }));
    await until(() => container.querySelector('[data-testid=fill-error-where]') !== null, 'the error place');
    expect(container.querySelector('[data-testid=fill-error-where]')!.textContent).toBe('/work/src/fill/stages/repository-facts.ts:77 — /work/products/shop');
  });
});
