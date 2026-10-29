/**
 * The journal page in the app (madarch-m38l.13), tested without a server: the summary counted from the rows, every row
 * with its arguments, response and reason, the refusal filter, an empty journal, other runs, and Russian.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setWikiLanguage } from '../i18n.js';
import { JournalPage } from './journal.js';
import { addressOfJournal, kRouteOf } from './routes.js';
import type { JournalRecord, PageJournal } from './types.js';

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

afterEach(async () => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = '';
  delete (globalThis as { fetch?: unknown }).fetch;
  await setWikiLanguage('en');
});

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

const record = (n: number, extra: Partial<JournalRecord> = {}): JournalRecord => ({
  time: `2026-10-23T12:31:${String(10 + n).padStart(2, '0')}.000Z`, durationMs: 12 * n, run: 'run-20261023T123100000Z-ab12', unit: 'domain:payments', agent: 'claude-code', model: 'claude-sonnet', session: 'sess-1',
  kind: 'tool-call', tool: 'read_file', arguments: { path: 'README.md' }, response: JSON.stringify({ path: 'README.md', text: '1: hello' }), responseBytes: 40, truncated: false, isError: false, outcome: 'ok', reason: null, ...extra,
});

const journal = (records: JournalRecord[], extra: Partial<PageJournal> = {}): PageJournal => ({ run: 'run-20261023T123100000Z-ab12', runs: ['run-20261023T123100000Z-ab12'], records, problems: [], ...extra });

describe('the journal page', () => {
  const records = [
    record(1),
    record(2, { tool: 'write_page', arguments: { markdown: 'a\nb\nc' }, response: JSON.stringify({ written: false, refused: [{ line: 12, rule: 'ungrounded-statement', message: 'no footnote' }] }), isError: true, outcome: 'refused', reason: 'line 12 ungrounded-statement: no footnote' }),
    record(3, { kind: 'refusal', tool: 'fs/read_text_file', arguments: { path: '/etc/hostname' }, response: 'madarch does not offer fs', isError: true, outcome: 'rejected', reason: 'madarch does not offer fs', durationMs: 0 }),
    record(4, { tool: 'write_page', response: JSON.stringify({ written: true }) }),
    record(5, { tool: 'overview', response: 'x'.repeat(50), truncated: true, responseBytes: 900_000 }),
  ];

  test('counts the calls and the refusals from the rows, and draws each row with its tool, outcome and duration', async () => {
    (globalThis as { fetch?: unknown }).fetch = async (url: string) => {
      expect(String(url)).toContain('/api/k/journal?id=domain%3Apayments');
      return json(journal(records));
    };
    const page = into(createElement(JournalPage, { id: 'domain:payments', run: null, version: 0 }));
    await until(() => page.querySelector('[data-testid=journal-page]') !== null, 'the journal');
    expect(page.querySelector('h1')!.textContent).toBe('How the agent wrote this page');
    expect(page.querySelector('[data-testid=journal-calls]')!.textContent).toBe('4');
    expect(page.querySelector('[data-testid=journal-refusals]')!.textContent).toBe('2');
    const summary = page.querySelector('[data-testid=journal-summary]')!.textContent!;
    for (const part of ['claude-code', 'claude-sonnet', 'sess-1', 'run-20261023T123100000Z-ab12']) expect(summary).toContain(part);
    const rows = [...page.querySelectorAll('[data-testid=journal-row]')];
    expect(rows.map((r) => r.getAttribute('data-tool'))).toEqual(['read_file', 'write_page', 'fs/read_text_file', 'write_page', 'overview']);
    expect(rows.map((r) => r.getAttribute('data-outcome'))).toEqual(['ok', 'refused', 'rejected', 'ok', 'ok']);
    expect(rows[1]!.querySelector('[data-testid=journal-outcome]')!.textContent).toBe('refused');
    expect(rows[1]!.querySelector('[data-testid=journal-reason]')!.textContent).toContain('line 12 ungrounded-statement: no footnote');
    expect(rows[1]!.querySelector('[data-testid=journal-arguments]')!.textContent).toContain('"markdown": "a\\nb\\nc"');
    expect(rows[1]!.querySelector('[data-testid=journal-response]')!.textContent).toContain('"rule": "ungrounded-statement"');
    expect(rows[2]!.textContent).toContain('refused request');
    expect(rows[0]!.querySelector('[data-testid=journal-reason]')).toBeNull();
    expect(rows[4]!.querySelector('[data-testid=journal-cut]')!.textContent).toContain('900000 bytes in all');
    expect(rows[0]!.textContent).toContain('path: README.md');
  });

  test('the refusal filter keeps only the rows that were not answered', async () => {
    (globalThis as { fetch?: unknown }).fetch = async () => json(journal(records));
    const page = into(createElement(JournalPage, { id: 'domain:payments', run: null, version: 0 }));
    await until(() => page.querySelector('[data-testid=journal-list]') !== null, 'the list');
    const box = page.querySelector('[data-testid=journal-only-refused]') as HTMLInputElement;
    box.click();
    await until(() => page.querySelectorAll('[data-testid=journal-row]').length === 2, 'the filter');
    expect([...page.querySelectorAll('[data-testid=journal-row]')].map((r) => r.getAttribute('data-outcome'))).toEqual(['refused', 'rejected']);
  });

  test('a page with no journal says why, an unreadable line is named, and other runs are links', async () => {
    (globalThis as { fetch?: unknown }).fetch = async () => json({ run: null, runs: [], records: [], problems: ['/store/journal/run-1.jsonl:3: Unexpected token'] });
    let page = into(createElement(JournalPage, { id: 'domain:payments', run: null, version: 0 }));
    await until(() => page.querySelector('[data-testid=journal-empty]') !== null, 'the empty journal');
    expect(page.querySelector('[data-testid=journal-empty]')!.textContent).toContain('No journal for this page');
    expect(page.querySelector('[data-testid=journal-problems]')!.textContent).toContain('/store/journal/run-1.jsonl:3');
    rendered?.unmount();
    document.body.innerHTML = '';
    (globalThis as { fetch?: unknown }).fetch = async () => json(journal([record(1)], { runs: ['run-a', 'run-20261023T123100000Z-ab12'] }));
    page = into(createElement(JournalPage, { id: 'domain:payments', run: null, version: 0 }));
    await until(() => page.querySelector('[data-testid=journal-runs]') !== null, 'the runs');
    expect(page.querySelector('[data-testid=journal-runs] a')!.getAttribute('href')).toBe('/k/journal?id=domain%3Apayments&run=run-a');
  });

  test('a read that fails says what failed', async () => {
    (globalThis as { fetch?: unknown }).fetch = async () => json({ message: 'the journal folder /x cannot be read' }, 500);
    const page = into(createElement(JournalPage, { id: 'domain:payments', run: null, version: 0 }));
    await until(() => page.querySelector('[data-testid=journal-error]') !== null, 'the error');
    expect(page.querySelector('[data-testid=journal-error]')!.textContent).toContain('The journal could not be read');
  });

  test('is in Russian when the interface is', async () => {
    await setWikiLanguage('ru');
    (globalThis as { fetch?: unknown }).fetch = async () => json(journal(records));
    const page = into(createElement(JournalPage, { id: 'domain:payments', run: null, version: 0 }));
    await until(() => page.querySelector('[data-testid=journal-page]') !== null, 'the journal');
    expect(page.querySelector('h1')!.textContent).toBe('Как агент писал эту страницу');
    expect(page.querySelector('[data-testid=journal-summary]')!.textContent).toContain('Вызовов инструментов');
    expect(page.querySelector('[data-testid=journal-outcome]')!.textContent).toBe('отвечено');
  });
});

describe('the journal address', () => {
  test('is a route of its own', () => {
    expect(addressOfJournal('domain:payments')).toBe('/k/journal?id=domain%3Apayments');
    expect(kRouteOf('/k/journal', '?id=domain%3Apayments&run=run-a')).toEqual({ name: 'journal', id: 'domain:payments', run: 'run-a' });
    expect(kRouteOf('/k/journal', '')).toEqual({ name: 'home' });
  });
});
