/**
 * The logs page and the kit's log viewer (madarch-64o5.88): one route answers every log, the page filters and follows it,
 * a row opens its full text and context, and the viewer's list is virtualised and shows its empty and loading states in
 * the reader's language.
 */
import { afterAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register({ url: 'http://localhost/p/logs' });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { LogsPage } = await import('./logs.js');
const { KitPage } = await import('../kit-page.js');
const { TooltipProvider } = await import('./ui/tooltip.js');
const { LogViewer } = await import('./ui/log-viewer.js');
const { setWikiLanguage } = await import('../i18n.js');
await import('../i18n.js');
afterAll(() => { GlobalRegistrator.unregister(); });

/** One page of the route's answer: a server record, a plugin's error line, an agent's step and a run's span. */
const ANSWER = {
  entries: [
    { id: 'fill-a:fill-a.log.jsonl:0', at: Date.parse('2026-11-15T09:41:01.000Z'), level: 'info', source: 'fill', run: 'fill-a', unit: 'disk:code.file', message: 'fill started', file: null, line: null, path: null, detail: null, cut: false, fields: {} },
    { id: 'fill-a:fill-a.log.jsonl:2', at: Date.parse('2026-11-15T09:41:03.000Z'), level: 'error', source: 'fill', run: 'fill-a', unit: null, message: 'src/plugin/host.ts:1: the plugin is pinned to an interpreter this machine does not run', file: 'host.ts', line: 1, path: '/work/product/plugins/disk/plugin.json', detail: 'Error: the plugin is pinned\n    at startPluginProcess (src/plugin/sandbox.ts:210:11)', cut: false, fields: { code: 'plugin-closure' } },
    { id: 'fill-a:disk:0', at: Date.parse('2026-11-15T09:41:03.500Z'), level: 'info', source: 'plugin', run: 'fill-a', unit: 'disk:code.file', message: 'reading src/index.ts', file: null, line: null, path: null, detail: null, cut: false, fields: {} },
    { id: 'fill-a:agent-fill:doc.term:given', at: Date.parse('2026-11-15T09:41:04.000Z'), level: 'info', source: 'agent', run: 'fill-a', unit: 'agent-fill:doc.term', message: 'the agent fixture was given the unit agent-fill:doc.term', file: null, line: null, path: null, detail: 'Fill the term.', cut: false, fields: {} },
    { id: 'fill-a:fill-a.jsonl:0', at: Date.parse('2026-11-15T09:41:05.000Z'), level: 'info', source: 'trace', run: 'fill-a', unit: null, message: 'plugin.unit 500 ms', file: null, line: null, path: null, detail: null, cut: false, fields: { 'madarch.plugin.unit': 'disk:code.file' } },
  ],
  more: false,
  scanned: 5,
  truncated: false,
  runs: ['fill-a', 'fill-b'],
  sources: ['server', 'fill', 'plugin', 'agent', 'store', 'trace'],
  levels: ['debug', 'info', 'warn', 'error'],
};

const requests: string[] = [];

/** Renders the Logs page with the route's answer; `empty` answers a page with no entry. */
async function render(options: { empty?: boolean; answer?: unknown } = {}): Promise<{ container: HTMLElement; close: () => Promise<void> }> {
  requests.length = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input), 'http://localhost');
    requests.push(url.pathname + url.search);
    const body = options.answer ?? (options.empty === true ? { ...ANSWER, entries: [], scanned: 0 } : ANSWER);
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(LogsPage, { base: '' })); });
  await settle(10);
  return { container, close: async () => { await act(async () => { root.unmount(); }); container.remove(); } };
}

async function settle(times = 10): Promise<void> {
  for (let at = 0; at < times; at += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
}

/** A native value set, so React's value tracker sees a select's change. */
function pick(select: HTMLSelectElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value') ?? Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value');
  descriptor?.set?.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

/** A native value set, so React's value tracker sees the typed text. */
function type(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value') ?? Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  descriptor?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

test('the logs page reads every source, filters through the route and opens a row with its text and context', async () => {
  await setWikiLanguage('ru');
  const page = await render();
  try {
    expect(requests[0]).toStartWith('/api/logs?');
    const rows = page.container.querySelectorAll('[data-testid="log-row"]');
    expect(rows).toHaveLength(5);
    expect(page.container.textContent).toContain('Показано 5 записей из 5 прочитанных');
    // The error row carries its level marker, and opening it shows the whole text, the stack and the context.
    const error = [...rows].find((row) => row.getAttribute('data-level') === 'error');
    expect(error?.querySelector('[data-testid="log-level"]')?.getAttribute('data-level')).toBe('error');
    await act(async () => { (error as HTMLElement).click(); });
    await settle(2);
    const detail = page.container.querySelector('[data-testid="log-detail"]');
    expect(detail?.textContent).toContain('the plugin is pinned to an interpreter this machine does not run');
    expect(detail?.querySelector('[data-testid="log-detail-raw"]')?.textContent).toContain('at startPluginProcess');
    expect(detail?.textContent).toContain('host.ts:1');
    expect(detail?.textContent).toContain('/work/product/plugins/disk/plugin.json');
    expect(detail?.textContent).toContain('plugin-closure');
    // A filter is the route's: the page asks again with the level and the source it was given.
    const level = page.container.querySelector('select[aria-label="Уровень"]') as HTMLSelectElement;
    await act(async () => { pick(level, 'error'); });
    await settle(6);
    expect(requests.some((path) => path.includes('level=error'))).toBe(true);
    const source = page.container.querySelector('select[aria-label="Источник"]') as HTMLSelectElement;
    await act(async () => { pick(source, 'fill'); });
    await settle(6);
    expect(requests.some((path) => path.includes('source=fill'))).toBe(true);
    // A run filters the page and links to the run's own page.
    const run = page.container.querySelector('select[aria-label="Запуск"]') as HTMLSelectElement;
    await act(async () => { pick(run, 'fill-a'); });
    await settle(6);
    expect(requests.some((path) => path.includes('run=fill-a'))).toBe(true);
    expect(page.container.querySelector('[data-testid="logs-run-link"] a')?.getAttribute('href')).toBe('/p/run?run=fill-a');
  } finally {
    await page.close();
  }
});

test('the search is highlighted, the follow control pauses the tail, and an empty answer says so', async () => {
  await setWikiLanguage('ru');
  const page = await render();
  try {
    const search = page.container.querySelector('input[type="search"]') as HTMLInputElement;
    await act(async () => { type(search, 'pinned'); });
    // The text filter waits for the typing to stop, and the read follows it.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    await settle(20);
    expect(requests.some((path) => path.includes('q=pinned'))).toBe(true);
    // The row's own words carry the match as a mark, so a reader sees what the search found.
    const marks = page.container.querySelectorAll('[data-testid="log-row"] mark');
    expect(marks.length).toBeGreaterThan(0);
    // Following reads again each second; pausing stops it, and the control says which state it is in.
    const follow = page.container.querySelector('[data-testid="log-follow"]') as HTMLButtonElement;
    expect(follow.textContent).toContain('Пауза');
    const before = requests.length;
    await act(async () => { follow.click(); });
    await settle(2);
    expect(page.container.querySelector('[data-testid="log-follow"]')?.textContent).toContain('Следить');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_200)); });
    expect(requests.length).toBe(before);
  } finally {
    await page.close();
  }
  const empty = await render({ empty: true });
  try {
    expect(empty.container.querySelector('[data-testid="log-empty"]')?.textContent).toBe('Ни одна запись не подходит под фильтры.');
  } finally {
    await empty.close();
  }
});

test('the kit page draws the log viewer in its states, and the list is virtualised', async () => {
  await setWikiLanguage('ru');
  globalThis.fetch = (async () => new Response('{}', { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(TooltipProvider, null, createElement(KitPage))); });
  await settle(4);
  try {
    expect(container.querySelectorAll('[data-testid="log-viewer"]').length).toBeGreaterThanOrEqual(4);
    expect(container.querySelector('[data-testid="log-empty"]')?.textContent).toContain('Ни одна запись');
    expect(container.querySelector('[data-testid="log-loading"]')).not.toBeNull();
    // The error state is drawn open: its detail carries the stack and the context.
    expect(container.querySelector('[data-testid="log-detail-raw"]')?.textContent).toContain('at startPluginProcess');
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test('the list is virtualised: thousands of entries draw only the rows in view', async () => {
  await setWikiLanguage('ru');
  const entries = Array.from({ length: 5_000 }, (_, at) => ({
    id: `entry-${String(at)}`, at: new Date(Date.parse('2026-11-15T09:00:00.000Z') + at).toISOString(), level: 'info' as const,
    source: 'Сервер', run: null, unit: null, message: `record ${String(at)}`, detail: null, fields: {},
  }));
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const filters = { source: '', level: '', run: '', from: '', to: '', query: '' };
  const labels = {
    source: 'Источник', level: 'Уровень', run: 'Запуск', from: 'С', to: 'По', search: 'Поиск', all: 'Все', older: 'Старые',
    empty: 'Пусто', loading: 'Читаю', follow: 'Следить', pause: 'Пауза', copy: 'Копировать', copied: 'Скопировано',
    context: 'Контекст', details: 'Записи', levels: { debug: 'Отладка', info: 'Информация', warn: 'Предупреждение', error: 'Ошибка' },
  };
  await act(async () => { root.render(createElement(LogViewer, { entries, filters, onFilters: () => undefined, sources: [], runs: [], labels, live: false, onLive: () => undefined })); });
  await settle(2);
  try {
    const drawn = container.querySelectorAll('[data-testid="log-row"]');
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.length).toBeLessThan(60);
    expect(container.querySelector('[data-testid="log-rows"]')).not.toBeNull();
    // The list holds all five thousand rows as its own height, and draws the ten-odd rows the viewport shows.
    const window = container.querySelector('[data-testid="log-window"]')?.parentElement as HTMLElement | null;
    expect(window?.style.height).toBe(`${String(5_000 * 26)}px`);
    expect([...container.querySelectorAll('[data-testid="log-row"]')].some((row) => (row.textContent ?? '').includes('record 0'))).toBe(true);
    expect([...container.querySelectorAll('[data-testid="log-row"]')].some((row) => (row.textContent ?? '').includes('record 4999'))).toBe(false);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
