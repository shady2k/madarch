/** The kit's figures speak the reader's language, and a missing value stays missing (madarch-64o5.82 review). */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

let root: Root | undefined;
const environment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let previous: boolean | undefined;
let charts: typeof import('./charts.js');
let i18n: typeof import('../../i18n.js').i18n;
let KitPage: typeof import('../../kit-page.js').KitPage;
let TooltipProvider: typeof import('./tooltip.js').TooltipProvider;

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  previous = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  charts = await import('./charts.js');
  ({ i18n } = await import('../../i18n.js'));
  ({ KitPage } = await import('../../kit-page.js'));
  ({ TooltipProvider } = await import('./tooltip.js'));
  await i18n.changeLanguage('ru');
});
afterEach(async () => { await act(async () => { root?.unmount(); }); root = undefined; document.body.innerHTML = ''; });
afterAll(() => {
  if (previous === undefined) delete environment.IS_REACT_ACT_ENVIRONMENT; else environment.IS_REACT_ACT_ENVIRONMENT = previous;
  GlobalRegistrator.unregister();
});
function mount(): HTMLElement {
  const container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  return container;
}
async function render(element: ReactElement): Promise<HTMLElement> {
  const container = mount();
  await act(async () => { root!.render(element); });
  return container;
}

test('a calendar week that holds the first day of a month is named for that month', () => {
  const matrix = charts.calendarMatrix([{ date: '2026-11-01', count: 7 }], 'ru');
  expect(matrix).toBeDefined();
  expect(matrix!.cols[0]).toBe(charts.shortMonth(10, 'ru'));
  expect(matrix!.cols[0]).not.toBe(charts.shortMonth(9, 'ru'));
});

test('the activity calendar takes its month and legend words from the reader', async () => {
  const container = await render(createElement(charts.ActivityCalendar, { title: 'Заливки', days: [{ date: '2026-11-01', count: 7 }] }));
  const text = container.textContent ?? '';
  expect(text).toContain(charts.shortMonth(10, 'ru'));
  expect(text).toContain('меньше');
  expect(text).toContain('больше');
  expect(text).not.toContain('less');
  expect(text).not.toContain('more');
});

test('a missing value is named, and never counted as one', async () => {
  const container = await render(createElement(charts.ChartTreemap, { title: 'Размеры', nodes: [{ label: 'A', value: 10 }, { label: 'B' }], width: 320, height: 160 }));
  const text = container.textContent ?? '';
  expect(text).toContain('B');
  expect(text).toContain('без значения');
  expect(text).not.toContain('11');
});

test("a folded treemap remainder uses the theme's text token", async () => {
  const container = await render(createElement(charts.ChartTreemap, { title: 'Размеры', nodes: [{ label: 'A', value: 10 }, { label: '+35 folded', value: 5, color: 'var(--surface-soft)', textColor: 'var(--text)' }], width: 320, height: 160 }));
  const label = [...container.querySelectorAll('text')].find((text) => text.textContent?.includes('folded'));
  expect(label?.getAttribute('fill')).toBe('var(--text)');
});

test('the kit samples take their legends and weekdays from the reader', async () => {
  const container = await render(createElement(TooltipProvider, null, createElement(KitPage)));
  const text = container.textContent ?? '';
  // The kit's log sample quotes a plugin's own English standard error as written, so the charts' words are read on
  // their own: their legend and weekday words stand in the reader's language and never in English.
  for (const english of ['published', 'blocked', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', '+35 folded']) expect(text).not.toContain(english);
  for (const russian of ['опубликовано', 'ошибка', 'заблокировано', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс', '35']) expect(text.toLowerCase()).toContain(russian);
});
