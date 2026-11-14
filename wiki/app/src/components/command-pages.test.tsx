
/**
 * The command pages with mocked command reads (decision 0036, section 7): the fill page's catalogue, its search, the
 * dependency the server adds, the agent and its cap, and the run page's progress, controls and readable log. The route
 * answers here are the ones `/api/fill-plan`, `/api/agents`, `/api/fill-runs` and the run's controls give.
 */
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register({ url: 'http://localhost/' });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { EventSource?: unknown }).EventSource = undefined;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { PageView } = await import('../page.js');
const { setWikiLanguage } = await import('../i18n.js');

afterAll(() => { GlobalRegistrator.unregister(); });

type Section = Parameters<typeof PageView>[0]['composition']['sections'][number];

function section(id: string, component: string, params: Record<string, unknown>): Section {
  return { id, component, on: 'subject', replace: false, params, line: 1, alias: `s_${id}` } as Section;
}

const NAVIGATION = {
  product: 'Portal',
  groups: [
    { name: 'demo.code', labels: { en: 'Code', ru: 'Код' }, short: null, open: false, parent: null },
    { name: 'demo.docs', labels: { en: 'Documents', ru: 'Документы' }, short: null, open: false, parent: null },
  ],
  kinds: [
    { kind: 'demo.alpha', one: 'Файл', many: 'Файлы', definition: 'Файл кода', taken: true, group: 'demo.code', count: 2, entryId: 'e1' },
    { kind: 'demo.beta', one: 'Термин', many: 'Термины', definition: 'Термин продукта', taken: false, group: 'demo.docs', count: 0, entryId: 'e2' },
    { kind: 'demo.gamma', one: 'Сценарий', many: 'Сценарии', definition: 'Сценарий продукта', taken: true, group: 'demo.docs', count: 3, entryId: 'e3' },
  ],
  purposes: [],
};

const ALPHA = { kind: 'demo.alpha', fields: [{ field: 'path', producers: ['disk'] }], agentFields: [] };
const BETA = { kind: 'demo.beta', fields: [{ field: 'definition', producers: ['agent-fill'] }], agentFields: ['definition'] };
const GAMMA = { kind: 'demo.gamma', fields: [{ field: 'title', producers: ['disk'] }, { field: 'definition', producers: ['agent-fill'] }], agentFields: ['definition'] };

const ALL_PLAN = {
  selectedKinds: ['demo.alpha', 'demo.beta', 'demo.gamma'], order: ['disk', 'agent-fill'],
  units: [{ plugin: 'disk', kind: 'demo.alpha' }, { plugin: 'agent-fill', kind: 'demo.beta' }, { plugin: 'disk', kind: 'demo.gamma' }, { plugin: 'agent-fill', kind: 'demo.gamma' }],
  kinds: [ALPHA, BETA, GAMMA],
  needsAgent: [{ kind: 'demo.beta', fields: ['definition'] }, { kind: 'demo.gamma', fields: ['definition'] }],
  errors: [], requestedKinds: ['demo.alpha', 'demo.beta', 'demo.gamma'], added: [], pluginsOnly: false,
};

function planFor(selected: readonly string[], pluginsOnly = false) {
  const common = { requestedKinds: selected, added: [] as { kind: string; neededBy: string }[], pluginsOnly, errors: [] as unknown[] };
  if (selected.length === 3) return { plan: { ...ALL_PLAN, ...common } };
  if (selected.includes('demo.gamma')) {
    return { plan: { ...common, selectedKinds: ['demo.alpha', 'demo.gamma'], order: ['disk', 'agent-fill'], units: [], kinds: [ALPHA, GAMMA], needsAgent: [{ kind: 'demo.gamma', fields: ['definition'] }], added: [{ kind: 'demo.alpha', neededBy: 'demo.gamma' }] } };
  }
  if (selected.includes('demo.beta')) {
    return { plan: { ...common, selectedKinds: ['demo.beta'], order: ['agent-fill'], units: [], kinds: [BETA], needsAgent: [{ kind: 'demo.beta', fields: ['definition'] }] } };
  }
  return { plan: { ...common, selectedKinds: ['demo.alpha'], order: ['disk'], units: [], kinds: [ALPHA], needsAgent: [] } };
}

const RUN = {
  runId: 'fill-run-1', state: 'running', startedAt: new Date(Date.now() - 5000).toISOString(), updatedAt: new Date().toISOString(), finishedAt: null,
  elapsedMs: 5000, remainingMs: 2500, selected: ['demo.alpha'], order: ['demo.alpha'], vertex: null,
  groups: [{ kind: 'demo.alpha', group: 'code', plugin: 'disk', done: 2, total: 3, state: 'running' }],
  units: [
    { unitId: 'disk:demo.alpha', stage: 'disk:demo.alpha', scope: 'file', status: 'published', generation: 1, attempts: 1 },
    { unitId: 'disk:demo.alpha', stage: 'disk:demo.alpha', scope: 'file:b', status: 'published', generation: 1, attempts: 1 },
    { unitId: 'disk:demo.alpha', stage: 'disk:demo.alpha', scope: 'file:c', status: 'running', generation: 1, attempts: 1 },
  ],
  events: [
    { seq: 1, at: new Date(Date.now() - 5000).toISOString(), stage: '', unitId: '', type: 'run-started', summary: 'the run started 2 stages: disk:demo.alpha' },
    { seq: 2, at: new Date(Date.now() - 4000).toISOString(), stage: 'disk:demo.alpha', unitId: 'disk:demo.alpha', type: 'unit-published', summary: 'disk:demo.alpha published 12 facts under /work/product/madarch/catalog.yaml 0123456789abcdef0123456789abcdef01234567' },
  ],
  records: 12, publishedUnits: 2, agentUsage: null,
};

const requests: { path: string; method: string; body: unknown }[] = [];

function answer(_path: string, body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(async () => {
  requests.length = 0;
  await setWikiLanguage('ru');
  (globalThis as { fetch: typeof fetch }).fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    requests.push({ path: url.pathname + url.search, method, body });
    if (url.pathname.endsWith('/api/fill-plan')) return answer(url.pathname, planFor(((body as { selected?: string[]; pluginsOnly?: boolean } | undefined)?.selected ?? []), (body as { pluginsOnly?: boolean } | undefined)?.pluginsOnly === true));
    if (url.pathname.endsWith('/api/agents')) return answer(url.pathname, { agents: [{ id: 'claude-code', label: 'Claude Code', installed: true, login: 'signed-in', version: '1.0' }], chosen: null });
    if (url.pathname.endsWith('/api/agent-choices')) return answer(url.pathname, { agent: { id: 'claude-code', label: 'Claude Code' }, choices: { model: { name: 'Model', current: 'opus', values: [] } } });
    if (url.pathname.endsWith('/api/status')) return answer(url.pathname, { fill: { state: 'idle' }, product: { id: 'p1', name: 'Portal' }, repositories: [{ name: 'app', filled: true }] });
    if (url.pathname.endsWith('/api/fill-runs') && url.searchParams.has('run')) return answer(url.pathname, { run: RUN });
    if (url.pathname.endsWith('/api/fill-runs')) return answer(url.pathname, { runs: [RUN] });
    if (url.pathname.endsWith('/api/fill-selected')) return answer(url.pathname, { runId: 'fill-run-2', order: ['demo.gamma'] });
    if (url.pathname.endsWith('/api/pause') || url.pathname.endsWith('/api/stop')) return answer(url.pathname, {});
    return answer(url.pathname, {});
  }) as unknown as typeof fetch;
});

async function settle(): Promise<void> {
  for (let at = 0; at < 12; at += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
}

async function render(sections: Section[], variables: Record<string, unknown> = {}): Promise<{ container: HTMLElement; opened: string[]; close: () => Promise<void> }> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const opened: string[] = [];
  await act(async () => {
    root.render(createElement(PageView, {
      composition: { template: 'fill', operation: '', variables, sections, findings: [] },
      data: {},
      runtime: { base: '', language: 'ru', busy: false, variables, product: 'Portal', navigation: NAVIGATION, open: (path: string) => { opened.push(path); }, reload: () => undefined },
    }));
  });
  await settle();
  return { container, opened, close: async () => { await act(async () => { root.unmount(); }); container.remove(); } };
}

/** A native value set, so React's value tracker sees the typed text. */
function type(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value') ?? Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  const setter = descriptor?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

test('the catalogue reads by default, in the catalogue\'s words, with counts, «в продукте» and the plan\'s producers', async () => {
  const page = await render([section('catalogue', 'catalogue', {})]);
  try {
    const text = page.container.textContent ?? '';
    expect(text).toContain('Термины');
    expect(text).toContain('Файлы');
    expect(text).toContain('Документы');
    expect(text).toContain('Файл кода');
    expect(text).toContain('2 записи');
    expect(text).toContain('В продукте');
    expect(text).toContain('Заполнит: disk');
    expect(text).toContain('Заполнит агент: definition');
    expect(page.container.querySelector('[data-testid="catalogue-select"]')).not.toBeNull();
    expect(page.container.querySelector('[data-testid="catalogue-kind-check-demo.gamma"]')).toBeNull();
    // Search reads the definition too.
    const search = page.container.querySelector('[data-testid="catalogue-search"]') as HTMLInputElement;
    await act(async () => { type(search, 'Термин продукта'); });
    expect(page.container.textContent).toContain('Термины');
    expect(page.container.textContent).not.toContain('Файлы');
  } finally {
    await page.close();
  }
});

test('selection mode keeps its kinds through a filter, marks the plan\'s prerequisite and leads to preparation', async () => {
  const page = await render([section('catalogue', 'catalogue', {})], { select: '1' });
  try {
    expect(page.container.querySelectorAll('[data-testid="catalogue-group-check"]').length).toBeGreaterThan(0);
    const gamma = page.container.querySelector('[data-testid="catalogue-kind-check-demo.gamma"]') as HTMLInputElement;
    await act(async () => { gamma.click(); });
    await settle();
    expect(page.container.textContent).toContain('Нужно для Сценарии');
    const alpha = page.container.querySelector('[data-testid="catalogue-kind-check-demo.alpha"]') as HTMLInputElement;
    expect(alpha.checked).toBe(true);
    expect(alpha.disabled).toBe(true);
    expect(page.container.querySelector('[data-testid="catalogue-selected-count"]')?.textContent).toContain('Выбран 1 вид');
    expect(page.container.querySelector('[data-testid="catalogue-selected-count"]')?.textContent).toContain('добавлена 1 зависимость');
    // The selection survives a filter that hides its group.
    const search = page.container.querySelector('[data-testid="catalogue-search"]') as HTMLInputElement;
    await act(async () => { type(search, 'Файл'); });
    expect(page.container.querySelector('[data-kind="demo.gamma"]')).toBeNull();
    await act(async () => { type(search, ''); });
    expect((page.container.querySelector('[data-testid="catalogue-kind-check-demo.gamma"]') as HTMLInputElement).checked).toBe(true);
    await act(async () => { (page.container.querySelector('[data-testid="catalogue-prepare"]') as HTMLButtonElement).click(); });
    expect(page.opened).toContain('/p/prepare?kinds=demo.gamma');
  } finally {
    await page.close();
  }
});

test('the preparation panel states the final set, both fillers, the agent and the cap, and starts one press', async () => {
  const page = await render([section('prepare', 'prepare', {})], { kinds: 'demo.gamma' });
  try {
    const text = page.container.textContent ?? '';
    expect(text).toContain('Продукт и репозитории');
    expect(text).toContain('Portal');
    expect(text).toContain('app');
    expect(text).toContain('Что заполнится');
    expect(text).toContain('Плагины заполнят: disk');
    expect(text).toContain('Агент заполнит: definition');
    expect(page.container.querySelector('[data-testid="prepare-agent"]')).not.toBeNull();
    expect(page.container.querySelector('[data-testid="prepare-cap"]')).not.toBeNull();
    expect(page.container.querySelector('[data-testid="prepare-cap-note"]')?.textContent).toContain('токены');
    // «Только плагины» leaves the agent's fields unfilled and says so.
    await act(async () => { (page.container.querySelector('[data-testid="prepare-plugins-only"]') as HTMLInputElement).click(); });
    await settle();
    expect(page.container.querySelector('[data-testid="prepare-agent"]')).toBeNull();
    expect(page.container.querySelector('[data-testid="prepare-unfilled"]')?.textContent).toContain('definition');
    // Back to the agent: choose one, cap it, and press once.
    await act(async () => { (page.container.querySelector('[data-testid="prepare-plugins-only"]') as HTMLInputElement).click(); });
    await settle();
    const select = page.container.querySelector('[data-testid="prepare-agent"]') as HTMLSelectElement;
    await act(async () => { select.value = 'claude-code'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await settle();
    const cap = page.container.querySelector('[data-testid="prepare-cap"]') as HTMLInputElement;
    await act(async () => { type(cap, '1000'); });
    await act(async () => { (page.container.querySelector('[data-testid="prepare-run"]') as HTMLButtonElement).click(); });
    await settle();
    const pressed = requests.find((one) => one.path.endsWith('/api/fill-selected'));
    expect(pressed?.body).toEqual({ selected: ['demo.gamma'], agent: 'claude-code', tokenCap: 1000, pluginsOnly: false });
    expect(page.opened).toContain('/p/run?run=fill-run-2');
  } finally {
    await page.close();
  }
});

test('the run page shows progress per kind and plugin, a readable log, and controls the run', async () => {
  const page = await render([section('run', 'run', { runVariable: 'run' })], { run: 'fill-run-1' });
  try {
    const text = page.container.textContent ?? '';
    expect(text).toContain('Код · Файлы · disk');
    expect(text).toContain('Опубликовано 2 из 3 единиц');
    expect(text).not.toContain('demo.alpha');
    // The log is the words of the run's events, never its trace: no machine path and no forty-character id.
    expect(text).toContain('Запуск начат.');
    expect(text).toContain('Заполнено: Файлы · disk.');
    expect(text).not.toContain('/work/product');
    expect(text).not.toContain('0123456789abcdef0123456789abcdef01234567');
    expect(text).not.toContain('the run started 2 stages');
    // A live run offers «Пауза» and «Остановить».
    const pause = page.container.querySelector('[data-testid="run-pause"]') as HTMLButtonElement;
    await act(async () => { pause.click(); });
    await settle();
    expect(requests.some((one) => one.path.endsWith('/api/pause?run=fill-run-1') && one.method === 'POST')).toBe(true);
    await act(async () => { (page.container.querySelector('[data-testid="run-stop"]') as HTMLButtonElement).click(); });
    await settle();
    const confirm = document.querySelector('[data-testid="stop-confirm"]') as HTMLButtonElement;
    expect(confirm).not.toBeNull();
    await act(async () => { confirm.click(); });
    await settle();
    const stop = requests.find((one) => one.path.endsWith('/api/stop?run=fill-run-1'));
    expect(stop?.body).toEqual({ confirm: true });
  } finally {
    await page.close();
  }
});

