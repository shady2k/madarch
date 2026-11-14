
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
    { kind: 'demo.alpha', one: 'Файл', many: 'Файлы', group: 'demo.code', count: 0, entryId: null },
    { kind: 'demo.beta', one: 'Термин', many: 'Термины', group: 'demo.docs', count: 0, entryId: null },
    { kind: 'demo.gamma', one: 'Сценарий', many: 'Сценарии', group: 'demo.docs', count: 0, entryId: null },
  ],
};

const ALPHA = { kind: 'demo.alpha', fields: [{ field: 'path', producers: ['disk'] }], agentFields: [] };
const BETA = { kind: 'demo.beta', fields: [{ field: 'definition', producers: ['agent-fill'] }], agentFields: ['definition'] };
const GAMMA = { kind: 'demo.gamma', fields: [{ field: 'title', producers: ['disk'] }, { field: 'definition', producers: ['agent-fill'] }], agentFields: ['definition'] };

const ALL_PLAN = {
  selectedKinds: ['demo.alpha', 'demo.beta', 'demo.gamma'], order: ['disk', 'agent-fill'],
  units: [{ plugin: 'disk', kind: 'demo.alpha' }, { plugin: 'agent-fill', kind: 'demo.beta' }, { plugin: 'disk', kind: 'demo.gamma' }, { plugin: 'agent-fill', kind: 'demo.gamma' }],
  kinds: [ALPHA, BETA, GAMMA],
  needsAgent: [{ kind: 'demo.beta', fields: ['definition'] }, { kind: 'demo.gamma', fields: ['definition'] }],
  errors: [],
};

function planFor(selected: readonly string[]) {
  if (selected.length === 3) return { plan: ALL_PLAN };
  if (selected.includes('demo.gamma')) {
    return { plan: { selectedKinds: ['demo.alpha', 'demo.gamma'], order: ['disk', 'agent-fill'], units: [], kinds: [ALPHA, GAMMA], needsAgent: [{ kind: 'demo.gamma', fields: ['definition'] }], errors: [] } };
  }
  if (selected.includes('demo.beta')) {
    return { plan: { selectedKinds: ['demo.beta'], order: ['agent-fill'], units: [], kinds: [BETA], needsAgent: [{ kind: 'demo.beta', fields: ['definition'] }], errors: [] } };
  }
  return { plan: { selectedKinds: ['demo.alpha'], order: ['disk'], units: [], kinds: [ALPHA], needsAgent: [], errors: [] } };
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
    if (url.pathname.endsWith('/api/fill-plan')) return answer(url.pathname, planFor(((body as { selected?: string[] } | undefined)?.selected ?? [])));
    if (url.pathname.endsWith('/api/agents')) return answer(url.pathname, { agents: [{ id: 'claude-code', label: 'Claude Code', installed: true, login: 'signed-in', version: '1.0' }], chosen: null });
    if (url.pathname.endsWith('/api/agent-choices')) return answer(url.pathname, { agent: { id: 'claude-code', label: 'Claude Code' }, choices: { model: { name: 'Model', current: 'opus', values: [] } } });
    if (url.pathname.endsWith('/api/status')) return answer(url.pathname, { fill: { state: 'idle' } });
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
      runtime: { base: '', language: 'ru', busy: false, variables, navigation: NAVIGATION, open: (path: string) => { opened.push(path); }, reload: () => undefined },
    }));
  });
  await settle();
  return { container, opened, close: async () => { await act(async () => { root.unmount(); }); container.remove(); } };
}

const checkbox = (container: HTMLElement, kind: string): HTMLInputElement => container.querySelector(`[data-testid="fill-setup-check-${kind}"]`) as HTMLInputElement;

/** A native value set, so React's value tracker sees the typed text. */
function type(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value') ?? Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  const setter = descriptor?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

async function tick(input: HTMLInputElement): Promise<void> {
  await act(async () => { input.click(); });
}

test('the fill page lists the catalogue in the reader\'s words, searches it, and shows the plan\'s dependency', async () => {
  const page = await render([section('fill', 'fill', { mode: 'run' })]);
  try {
    const text = page.container.textContent ?? '';
    expect(text).toContain('Термины');
    expect(text).toContain('Файлы');
    expect(text).toContain('Документы');
    expect(text).not.toContain('demo.alpha');
    expect(page.container.querySelectorAll('[data-testid="fill-setup-section"]')).toHaveLength(2);
    // A section with no kind matching the typed words is hidden.
    const search = page.container.querySelector('[data-testid="fill-setup-search"]') as HTMLInputElement;
    await act(async () => { type(search, 'Файл'); });
    expect(page.container.querySelectorAll('[data-testid="fill-setup-section"]')).toHaveLength(1);
    expect(page.container.textContent).toContain('Файлы');
    expect(page.container.textContent).not.toContain('Термины');
    await act(async () => { type(search, ''); });
    // The plan adds the term the scenario needs, and the page says what asked for it.
    await tick(checkbox(page.container, 'demo.gamma'));
    await settle();
    expect(page.container.textContent).toContain('Зависимость');
    expect(checkbox(page.container, 'demo.alpha').checked).toBe(true);
    expect(checkbox(page.container, 'demo.alpha').disabled).toBe(true);
    expect(requests.some((one) => one.path.endsWith('/api/fill-plan') && JSON.stringify(one.body).includes('demo.gamma'))).toBe(true);
  } finally {
    await page.close();
  }
});

test('the fill page asks for the agent and its cap when the plan holds the agent, and starts the press', async () => {
  const page = await render([section('fill', 'fill', { mode: 'run' })]);
  try {
    await tick(checkbox(page.container, 'demo.gamma'));
    await settle();
    expect(page.container.querySelector('[data-testid="fill-setup-agent"]')).not.toBeNull();
    expect(page.container.querySelector('[data-testid="fill-setup-cap"]')).not.toBeNull();
    const run = page.container.querySelector('[data-testid="fill-setup-run"]') as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    const select = page.container.querySelector('[data-testid="fill-setup-agent"]') as HTMLSelectElement;
    await act(async () => { select.value = 'claude-code'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await settle();
    const cap = page.container.querySelector('[data-testid="fill-setup-cap"]') as HTMLInputElement;
    await act(async () => { type(cap, '1000'); });
    await act(async () => { run.click(); });
    await settle();
    const pressed = requests.find((one) => one.path.endsWith('/api/fill-selected'));
    expect(pressed?.body).toEqual({ selected: ['demo.gamma'], agent: 'claude-code', tokenCap: 1000 });
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

