
/**
 * What the model calls cost, as the wiki states it (madarch-stm0.4, decision 0035, item 22): a kind's page lists the
 * spend of the newest runs — plugin run, field, model, tokens in and out, cost, and the bound a run stopped at — and
 * says nothing at all for a kind no model call filled; a run's page draws the same numbers from its own trace.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setWikiLanguage } from '../i18n.js';
import { localeKeyIn } from '../../test/locale-keys.js';
import { KindUsage, RunAgentUsage, amountText } from './usage.js';
import type { AgentUsageReport, KindUsageView } from './types.js';

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
  delete (globalThis as { fetch?: unknown }).fetch;
});

const USAGE: KindUsageView = {
  kind: 'doc.term',
  runs: [
    {
      run: 'fill-2', at: '2026-11-11T10:00:00.000Z', inputTokens: 2000, outputTokens: 500, totalTokens: 2500,
      cost: [{ amount: 0.03, currency: 'USD' }], stopped: 'tokens',
      rows: [
        { run: 'fill-2', unit: 'sections:doc.term', plugin: 'sections', pluginVersion: '2.0.0', kind: 'doc.term', field: 'definition', model: null, inputTokens: 2000, outputTokens: 500, totalTokens: 2500, cost: null, turns: 2, reported: true, stopped: 'tokens' },
      ],
    },
    {
      run: 'fill-1', at: '2026-11-10T10:00:00.000Z', inputTokens: 800, outputTokens: 200, totalTokens: 1000,
      cost: [{ amount: 0.02, currency: 'USD' }], stopped: null,
      rows: [
        { run: 'fill-1', unit: 'glossary:doc.term', plugin: 'glossary', pluginVersion: '1.0.0', kind: 'doc.term', field: '', model: 'sonnet', inputTokens: 800, outputTokens: 200, totalTokens: 1000, cost: { amount: 0.02, currency: 'USD' }, turns: 1, reported: true, stopped: null },
      ],
    },
  ],
  moreRuns: true,
  total: { inputTokens: 2800, outputTokens: 700, totalTokens: 3500, cost: [{ amount: 0.05, currency: 'USD' }], runs: 12 },
};

function answer(body: unknown): void {
  (globalThis as { fetch?: unknown }).fetch = async (url: string) => (url.includes('/api/kind-usage')
    ? new Response(JSON.stringify({ usage: body }))
    : new Response(JSON.stringify({ message: `no answer for ${url}` }), { status: 404 }));
}

describe('a kind\'s page states what the model calls cost', () => {
  test('every run is counted in the total, and the newest runs list their plugin runs, fields, models, tokens and costs', async () => {
    answer(USAGE);
    const container = into(createElement(KindUsage, { kind: 'doc.term', version: 0 }));
    await until(() => container.querySelector('[data-testid=kind-usage]') !== null, 'the usage table');
    const total = container.querySelector('[data-testid=kind-usage-total]')!.textContent ?? '';
    expect(total).toContain('3,500 tokens (2,800 in, 700 out) over 12 runs');
    expect(total).toContain('0.05 USD');
    const rows = [...container.querySelectorAll('[data-testid=kind-usage-row]')];
    expect(rows.map((row) => row.getAttribute('data-run'))).toEqual(['fill-2', 'fill-1']);
    expect(rows[0]!.textContent).toContain('sections');
    expect(rows[0]!.textContent).toContain('no model named');
    expect(rows[0]!.textContent).toContain('2,000 in · 500 out · 2,500 total');
    expect(rows[0]!.querySelector('[data-testid=kind-usage-stop]')!.textContent).toBe('stopped: tokens bound');
    expect(rows[1]!.textContent).toContain('the kind as a whole');
    expect(rows[1]!.textContent).toContain('sonnet');
    expect(rows[1]!.textContent).toContain('0.02 USD');
    expect(container.querySelector('[data-testid=kind-usage-more]')!.textContent).toContain('Older runs are counted in the total');
    expect(localeKeyIn(container.textContent ?? '')).toBeUndefined();
  });

  test('a kind no model call filled draws no section at all', async () => {
    answer({ ...USAGE, runs: [], total: { ...USAGE.total, runs: 0 } });
    const container = into(createElement(KindUsage, { kind: 'code.file', version: 0 }));
    await until(() => (globalThis as { fetch?: unknown }).fetch !== undefined, 'the read');
    await new Promise((step) => setTimeout(step, 80));
    expect(container.querySelector('[data-testid=kind-usage]')).toBeNull();
  });
});

describe('a run\'s page states what the model calls cost', () => {
  const report: AgentUsageReport = {
    lines: [{ kind: 'doc.term', field: 'definition', model: 'sonnet', plugin: 'glossary', inputTokens: 800, outputTokens: 200, totalTokens: 1000, cost: [{ currency: 'USD', amount: 0.02 }], turns: 1, stopped: null }],
    inputTokens: 800, outputTokens: 200, totalTokens: 1000, cost: [{ currency: 'USD', amount: 0.02 }], turns: 1, stops: [],
  };

  test('the totals and one line per kind, field and model, and nothing for a run that made no model call', async () => {
    const container = into(createElement(RunAgentUsage, { usage: report }));
    await until(() => container.querySelector('[data-testid=run-usage]') !== null, 'the usage table');
    const text = container.textContent ?? '';
    expect(text).toContain('1,000 tokens (800 in, 200 out) over 1 prompt turns');
    expect(text).toContain('glossary');
    expect(text).toContain('definition');
    expect(text).toContain('sonnet');
    expect(text).toContain('0.02 USD');
    rendered?.unmount();
    rendered = undefined;
    document.body.innerHTML = '';
    const none = into(createElement(RunAgentUsage, { usage: { ...report, lines: [], turns: 0 } }));
    await new Promise((step) => setTimeout(step, 50));
    expect(none.querySelector('[data-testid=run-usage]')).toBeNull();
  });

  test('an amount is the agent\'s own number and unit', () => {
    expect(amountText({ amount: 0.5, currency: 'USD' }, 'en')).toBe('0.5 USD');
    expect(amountText({ amount: 3, currency: 'credits' }, 'en')).toBe('3 credits');
  });
});
