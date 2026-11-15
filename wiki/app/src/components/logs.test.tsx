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

/**
 * One choice of a kit menu: the trigger opens it, and the item is chosen. The menu's items carry the control's test id
 * and the value behind it, so a test names the choice it makes without reading a label.
 */
async function choose(page: { container: HTMLElement }, menu: string, value: string): Promise<void> {
  const trigger = page.container.querySelector(`[data-testid="${menu}"]`) as HTMLElement | null;
  expect(trigger).not.toBeNull();
  // Radix opens its menu on the pointer's press, not on a plain click: the press is dispatched as a browser makes it.
  await act(async () => {
    trigger!.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    trigger!.click();
  });
  await settle(6);
  const item = document.querySelector(`[data-testid="${menu}-${value}"]`) as HTMLElement | null;
  expect(item).not.toBeNull();
  await act(async () => { item!.click(); });
  await settle(6);
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
    // A filter is the route's, and the control is the kit's menu: the page asks again with what was chosen.
    expect(page.container.querySelector('select')).toBeNull();
    await choose(page, 'log-level-filter', 'error');
    expect(requests.some((path) => path.includes('level=error'))).toBe(true);
    await choose(page, 'log-source', 'fill');
    expect(requests.some((path) => path.includes('source=fill'))).toBe(true);
    // A run filters the page and links to the run's own page.
    await choose(page, 'log-run', 'fill-a');
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
    // The kit's own filter controls stand beside the viewer, in their states: the menu (closed and open) and the moment
    // field (with a moment, empty, and its panel open).
    expect(container.querySelector('[data-testid="kit-choice-menu"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="kit-choice-open"]')?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-testid="kit-moment"]')?.textContent).toMatch(/2026/u);
    expect(container.querySelector('[data-testid="kit-moment-empty"]')?.textContent).toBe('Любое время');
    expect(container.querySelector('[data-testid="date-time-panel"]')).not.toBeNull();
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
    dateTime: { none: 'Любое время', title: 'Выберите момент', clear: 'Сбросить', done: 'Готово', hour: 'Часы', minute: 'Минуты', second: 'Секунды', previous: 'Предыдущий месяц', next: 'Следующий месяц', close: 'Закрыть' },
  };
  await act(async () => { root.render(createElement(LogViewer, { entries, filters, onFilters: () => undefined, sources: [], runs: [], labels, live: false, onLive: () => undefined, locale: 'ru' })); });
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

test('a row draws one time in the reader’s clock, and the moment filter is the kit’s field', async () => {
  await setWikiLanguage('ru');
  const page = await render();
  try {
    const row = page.container.querySelector('[data-testid="log-row"]') as HTMLElement;
    const times = row.querySelectorAll('[data-testid="log-time"]');
    expect(times).toHaveLength(1);
    // 24 hours and the locale's own millisecond mark: no «AM», no «PM», no second time anywhere in the row.
    expect(times[0]?.textContent).toMatch(/^\d{2}:\d{2}:\d{2},\d{3}$/u);
    expect(row.textContent).not.toMatch(/AM|PM/u);
    // The filters are the kit's: a button that names its choice, and the moment field's own words.
    expect(page.container.querySelector('select')).toBeNull();
    expect(page.container.querySelector('[data-testid="log-from"]')?.textContent).toBe('Любое время');
    await act(async () => { (page.container.querySelector('[data-testid="log-from"]') as HTMLElement).click(); });
    await settle(6);
    const panel = document.querySelector('[data-testid="date-time-panel"]');
    expect(panel).not.toBeNull();
    // The month and the control words are Russian, in the reader's own language.
    expect(panel?.textContent).toMatch(/[а-яё]/iu);
    expect(panel?.querySelector('[data-testid="date-time-month"]')?.textContent).toContain('ноябрь');
    const days = [...panel!.querySelectorAll('[role="grid"] button')];
    expect(days.length).toBeGreaterThan(27);
    await act(async () => { (days[14] as HTMLElement).click(); });
    const hour = panel!.querySelector('[data-testid="date-time-hour"]') as HTMLInputElement;
    await act(async () => { type(hour, '11'); });
    await act(async () => { (panel!.querySelector('[data-testid="date-time-done"]') as HTMLElement).click(); });
    await settle(8);
    expect(requests.some((path) => path.includes('since='))).toBe(true);
    // The trigger then shows the chosen moment in the reader's words, not a placeholder of the browser's.
    const shown = page.container.querySelector('[data-testid="log-from"]')?.textContent ?? '';
    expect(shown).not.toBe('Любое время');
    expect(shown).toMatch(/2026/u);
  } finally {
    await page.close();
  }
});
