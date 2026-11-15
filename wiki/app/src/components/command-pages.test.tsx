
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
    { kind: 'demo.alpha', one: 'Файл', many: 'Файлы', definition: 'Файл кода', taken: true, group: 'demo.code', nav: null, count: 2, entryId: 'e1' },
    { kind: 'demo.beta', one: 'Термин', many: 'Термины', definition: 'Термин продукта', taken: false, group: 'demo.docs', nav: null, count: 0, entryId: 'e2' },
    { kind: 'demo.gamma', one: 'Сценарий', many: 'Сценарии', definition: 'Сценарий продукта', taken: true, group: 'demo.docs', nav: null, count: 3, entryId: 'e3' },
  ],
  purposes: [],
};

const ALPHA = { kind: 'demo.alpha', fields: [{ field: 'path', producers: ['disk'] }], agentFields: [] };
const BETA = { kind: 'demo.beta', fields: [{ field: 'definition', labels: { en: 'Definition', ru: 'Определение' }, producers: ['agent-fill'] }], agentFields: ['definition'] };
const GAMMA = { kind: 'demo.gamma', fields: [{ field: 'title', producers: ['disk'] }, { field: 'definition', labels: { en: 'Definition', ru: 'Определение' }, producers: ['agent-fill'] }], agentFields: ['definition'] };

const ALL_PLAN = {
  selectedKinds: ['demo.alpha', 'demo.beta', 'demo.gamma'], order: ['disk', 'agent-fill'],
  units: [{ plugin: 'disk', kind: 'demo.alpha' }, { plugin: 'agent-fill', kind: 'demo.beta' }, { plugin: 'disk', kind: 'demo.gamma' }, { plugin: 'agent-fill', kind: 'demo.gamma' }],
  kinds: [ALPHA, BETA, GAMMA],
  needsAgent: [{ kind: 'demo.beta', fields: ['definition'] }, { kind: 'demo.gamma', fields: ['definition'] }],
  errors: [], skipped: [], requestedKinds: ['demo.alpha', 'demo.beta', 'demo.gamma'], added: [], pluginsOnly: false,
};

function planFor(selected: readonly string[], pluginsOnly = false) {
  const common = { requestedKinds: selected, added: [] as { kind: string; neededBy: string }[], pluginsOnly, errors: [] as unknown[], skipped: [] as { kind: string; fields: string[]; reason: string }[] };
  if (selected.length === 3) return { plan: { ...ALL_PLAN, ...common } };
  if (selected.includes('demo.gamma')) {
    return { plan: { ...common, selectedKinds: ['demo.alpha', 'demo.gamma'], order: ['disk', 'agent-fill'], units: [], kinds: [ALPHA, GAMMA], needsAgent: [{ kind: 'demo.gamma', fields: ['definition'] }], added: [{ kind: 'demo.alpha', neededBy: 'demo.gamma' }] } };
  }
  if (selected.includes('demo.beta')) {
    return { plan: { ...common, selectedKinds: ['demo.beta'], order: pluginsOnly ? [] : ['agent-fill'], units: [], kinds: [BETA], needsAgent: [{ kind: 'demo.beta', fields: ['definition'] }], skipped: [{ kind: 'demo.beta', fields: ['definition'], reason: 'no producer in the manifest' }] } };
  }
  return { plan: { ...common, selectedKinds: ['demo.alpha'], order: ['disk'], units: [], kinds: [ALPHA], needsAgent: [] } };
}

const RUN = {
  runId: 'fill-run-1', state: 'running', startedAt: new Date(Date.now() - 5000).toISOString(), updatedAt: new Date().toISOString(), finishedAt: null,
  elapsedMs: 5000, remainingMs: 2500, selected: ['demo.alpha'], order: ['demo.alpha'], vertex: null,
  groups: [
    { kind: 'demo.alpha', group: 'code', plugin: 'disk', done: 2, total: 3, state: 'running' },
    // A producer with no planned unit: a plugins-only run's agent row, which the page must not draw.
    { kind: 'demo.gamma', group: 'docs', plugin: 'agent-fill', done: 0, total: 0, state: 'planned' },
  ],
  units: [
    { unitId: 'disk:demo.alpha', stage: 'disk:demo.alpha', scope: 'file', status: 'published', generation: 1, attempts: 1 },
    { unitId: 'disk:demo.alpha', stage: 'disk:demo.alpha', scope: 'file:b', status: 'published', generation: 1, attempts: 1 },
    { unitId: 'disk:demo.alpha', stage: 'disk:demo.alpha', scope: 'file:c', status: 'running', generation: 1, attempts: 1 },
  ],
  events: [
    { seq: 1, at: new Date(Date.now() - 5000).toISOString(), stage: '', unitId: '', type: 'run-started', summary: 'the run started 2 stages: disk:demo.alpha' },
    { seq: 2, at: new Date(Date.now() - 4000).toISOString(), stage: 'disk:demo.alpha', unitId: 'disk:demo.alpha', type: 'unit-published', summary: 'disk:demo.alpha published 12 facts under /work/product/madarch/catalog.yaml 0123456789abcdef0123456789abcdef01234567' },
    { seq: 3, at: new Date(Date.now() - 3000).toISOString(), stage: 'disk:demo.alpha', unitId: 'disk:demo.alpha', type: 'unit-retried', summary: 'disk:demo.alpha failed: /product/src/plugin/cgroup.ts:1: the cgroup does not hand the cpu, memory, pids controllers to its children (cgroup.subtree_control holds nothing); the attempt is retried' },
    // The same retry again: the journal says one line with its count, never four identical rows.
    { seq: 4, at: new Date(Date.now() - 2000).toISOString(), stage: 'disk:demo.alpha', unitId: 'disk:demo.alpha', type: 'unit-retried', summary: 'disk:demo.alpha failed: /product/src/plugin/cgroup.ts:1: the cgroup does not hand the cpu, memory, pids controllers to its children (cgroup.subtree_control holds nothing); the attempt is retried' },
  ],
  records: 12, publishedUnits: 2, agentUsage: null,
  // The run's trace as its run view states it: the stage's own id and the time it took.
  summary: { wallMs: 29_000, steps: [{ step: 'plugin-turns', wallMs: 29_000 }] },
};

/** One agent unit's exchange, as madarch records it (madarch-64o5.88): its prompt, its steps, its files, its answer. */
const EXCHANGE = {
  run: 'fill-run-1', unit: 'agent-fill:demo.beta', agent: 'codex', model: 'gpt-5', session: 'session-1',
  startedAt: new Date(Date.now() - 5000).toISOString(), endedAt: new Date(Date.now() - 1000).toISOString(), durationMs: 4000, state: 'turned',
  given: {
    prompt: 'Fill the requested kind from its manifest definition.\nFiles available through ACP fs/read_text_file:\n/repo/docs/a.md\nTask: {"kind":"demo.beta"}\nOutput contract: {}',
    bytes: 190, cut: false, task: { kind: 'demo.beta' }, files: ['repo/docs/a.md'], filesTotal: 1,
  },
  steps: [
    { at: new Date(Date.now() - 4000).toISOString(), sessionUpdate: 'agent_thought_chunk', kind: 'thought', text: 'Читаю определение' },
    { at: new Date(Date.now() - 3000).toISOString(), sessionUpdate: 'tool_call', kind: 'tool-call', title: 'Читаю docs/a.md', tool: 'read', status: 'completed', path: '/repo/docs/a.md' },
  ],
  stepsDropped: 0,
  opened: [{ at: new Date(Date.now() - 3000).toISOString(), repository: 'repo', path: 'docs/a.md', bytes: 42 }],
  openedDropped: 0,
  returned: { text: '{"vertices":[],"end":{"state":"complete"}}', bytes: 43, cut: false },
  usage: { inputTokens: 300, outputTokens: 40, totalTokens: 340, context: { used: 1200, size: 200000 }, turns: 1, reported: true },
  stop: 'end_turn', failure: null,
};

const requests: { path: string; method: string; body: unknown }[] = [];
let fillSelectionFailure: { status: number; body: unknown } | null = null;
let runDetail: unknown = RUN;

function answer(_path: string, body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(async () => {
  requests.length = 0;
  fillSelectionFailure = null;
  runDetail = RUN;
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
    if (url.pathname.endsWith('/api/fill-runs') && url.searchParams.has('run')) return answer(url.pathname, { run: runDetail });
    if (url.pathname.endsWith('/api/fill-runs')) return answer(url.pathname, { runs: [RUN] });
    if (url.pathname.endsWith('/api/fill-selected')) return fillSelectionFailure === null
      ? answer(url.pathname, { runId: 'fill-run-2', order: ['demo.gamma'] })
      : new Response(JSON.stringify(fillSelectionFailure.body), { status: fillSelectionFailure.status, headers: { 'content-type': 'application/json' } });
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
      runtime: { base: '', language: 'ru', busy: false, variables, product: 'Portal', navigation: NAVIGATION, pageName: null, open: (path: string) => { opened.push(path); }, reload: () => undefined },
    }));
  });
  await settle();
  return { container, opened, close: async () => { await act(async () => { root.unmount(); }); container.remove(); } };
}

/** One choice of a kit menu: its trigger is pressed and its item is chosen. */
async function choose(container: HTMLElement, menu: string, value: string): Promise<void> {
  const trigger = container.querySelector(`[data-testid="${menu}"]`) as HTMLElement | null;
  expect(trigger).not.toBeNull();
  await act(async () => {
    trigger!.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    trigger!.click();
  });
  await settle();
  const item = document.querySelector(`[data-testid="${menu}-${value}"]`) as HTMLElement | null;
  expect(item).not.toBeNull();
  await act(async () => { item!.click(); });
  await settle();
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
    expect(text).toContain('Заполнит агент: Определение');
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
    expect(text).toContain('Агент заполнит: Определение');
    // No agent is configured, so «Только плагины» stands: the agent's fields are named and the press is live.
    expect((page.container.querySelector('[data-testid="prepare-plugins-only"]') as HTMLInputElement).checked).toBe(true);
    expect(page.container.querySelector('[data-testid="prepare-unfilled"]')?.textContent).toContain('Определение');
    expect((page.container.querySelector('[data-testid="prepare-run"]') as HTMLButtonElement).disabled).toBe(false);
    expect(page.container.querySelector('[data-testid="prepare-agent"]')).toBeNull();
    // Choose an agent instead: uncheck the box, choose one, cap it, and press once.
    await act(async () => { (page.container.querySelector('[data-testid="prepare-plugins-only"]') as HTMLInputElement).click(); });
    await settle();
    await choose(page.container, 'prepare-agent', 'claude-code');
    // The server needs a positive cap for agent work: the form says so and holds the press until it has one.
    expect(page.container.querySelector('[data-testid="prepare-cap-required"]')).not.toBeNull();
    expect((page.container.querySelector('[data-testid="prepare-run"]') as HTMLButtonElement).disabled).toBe(true);
    const cap = page.container.querySelector('[data-testid="prepare-cap"]') as HTMLInputElement;
    await act(async () => { type(cap, '1000'); });
    expect((page.container.querySelector('[data-testid="prepare-run"]') as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { (page.container.querySelector('[data-testid="prepare-run"]') as HTMLButtonElement).click(); });
    await settle();
    const pressed = requests.find((one) => one.path.endsWith('/api/fill-selected'));
    expect(pressed?.body).toEqual({ selected: ['demo.gamma'], agent: 'claude-code', tokenCap: 1000, pluginsOnly: false });
    expect(page.opened).toContain('/p/run?run=fill-run-2');
  } finally {
    await page.close();
  }
});

test('a server refusal is shown in the reader\'s language by its code', async () => {
  const page = await render([section('prepare', 'prepare', {})], { kinds: 'demo.gamma' });
  try {
    await act(async () => { (page.container.querySelector('[data-testid="prepare-plugins-only"]') as HTMLInputElement).click(); });
    await settle();
    await choose(page.container, 'prepare-agent', 'claude-code');
    const cap = page.container.querySelector('[data-testid="prepare-cap"]') as HTMLInputElement;
    await act(async () => { type(cap, '1000'); });
    fillSelectionFailure = { status: 409, body: { error: { message: 'this fill runs the agent claude-code, and a token cap is required', code: 'fill/token-cap' } } };
    await act(async () => { (page.container.querySelector('[data-testid="prepare-run"]') as HTMLButtonElement).click(); });
    await settle();
    const text = page.container.textContent ?? '';
    expect(text).toContain('Укажите лимит токенов');
    expect(text).not.toContain('a token cap is required');
  } finally {
    await page.close();
  }
});

test('a skipped kind is named and nothing is pressed when no unit would run', async () => {
  const page = await render([section('prepare', 'prepare', {})], { kinds: 'demo.beta' });
  try {
    const text = page.container.textContent ?? '';
    expect(text).toContain('Пропущенные виды');
    expect(text).toContain('Термины');
    expect(page.container.querySelector('[data-testid="prepare-nothing"]')?.textContent).toContain('Запускать нечего');
    expect((page.container.querySelector('[data-testid="prepare-run"]') as HTMLButtonElement).disabled).toBe(true);
  } finally {
    await page.close();
  }
});

test('the run page shows progress per kind and plugin, a readable log, and controls the run', async () => {
  const page = await render([section('run', 'run', { runVariable: 'run' })], { run: 'fill-run-1' });
  try {
    const text = page.container.textContent ?? '';
    expect(text).toContain('Код · Файлы · disk');
    expect(text).not.toContain('Сценарии');
    expect(page.container.querySelector('[data-testid="fill-run-cause"]')?.textContent).toContain('контроллеры cpu, memory и pids');
    expect(page.container.querySelector('[data-testid="fill-run-cause"]')?.textContent).toContain('MADARCH_PLUGIN_SANDBOX=off');
    expect(text).toContain('Опубликовано 2 из 3 единиц');
    expect(text).not.toContain('demo.alpha');
    // The log is the words of the run's events, never its trace: no machine path and no forty-character id.
    expect(text).toContain('Запуск начат.');
    expect(text).toContain('Заполнено: Файлы · disk.');
    expect(text).not.toContain('/work/product');
    expect(text).not.toContain('0123456789abcdef0123456789abcdef01234567');
    expect(text).not.toContain('the run started 2 stages');
    // The run journal: the key transitions, a repeated line said once with its count, and every failure with its cause
    // and the next action in words — the raw summaries stay in the detailed logs.
    const journal = page.container.querySelector('[data-testid="fill-run-journal"]');
    expect(journal?.textContent).toContain('Журнал запуска');
    expect(journal?.textContent).toContain('Повтор: Файлы · disk. ×2');
    // The failure's own words stand on the page, with the file and line it stands at, and the next action beside them.
    const causeText = journal?.querySelector('[data-testid="fill-run-journal-cause"]')?.textContent ?? '';
    expect(causeText).toContain('cgroup.ts:1: the cgroup does not hand the cpu, memory, pids controllers');
    // The engine's retry tail is the run's bookkeeping, not the cause: the page states the cause and then what to do.
    expect(causeText).not.toContain('the attempt is retried');
    expect(journal?.querySelector('[data-testid="fill-run-journal-cause"]')?.textContent).toContain('Включите контроллеры для своей сессии');
    // The event's own wrapper sentence stays out: the page shows the cause's words, not the engine's framing of them.
    expect(text).not.toContain('demo.alpha failed');
    // A failure links to its own row in the logs: the run, the unit's name and the error level.
    const rowLink = journal?.querySelector('[data-testid="fill-run-and-logs"]');
    expect(rowLink?.getAttribute('href')).toBe('/p/logs?run=fill-run-1&q=disk%3Ademo.alpha&level=error');
    // The stages are named in the reader's words, never by the engine's key.
    const stages = page.container.querySelector('[data-testid="fill-run-stage-times"]');
    expect(stages?.textContent).toContain('Плагины · 29 с');
    expect(stages?.textContent).not.toContain('plugin-turns');
    const logsLink = journal?.querySelector('[data-testid="fill-run-logs-link"]');
    expect(logsLink?.getAttribute('href')).toBe('/p/logs?run=fill-run-1');
    await act(async () => { (logsLink as HTMLElement).click(); });
    expect(page.opened).toContain('/p/logs?run=fill-run-1');
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


test('the run page shows each agent unit in detail: what it was given, did, returned and cost', async () => {
  runDetail = { ...RUN, state: 'succeeded', agentExchanges: [EXCHANGE] };
  const page = await render([section('run', 'run', { runVariable: 'run' })], { run: 'fill-run-1' });
  try {
    const card = page.container.querySelector('[data-testid="fill-run-agents"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('Что получил и вернул агент');
    expect(card?.textContent).toContain('Подробно');
    expect(card?.textContent).toContain('Термины');
    // What it was given: the prompt as sent, and how many files it was told about.
    expect(card?.querySelector('[data-testid="agent-prompt"]')?.textContent).toContain('Task: {"kind":"demo.beta"}');
    expect(card?.textContent).toContain('Файлов передано: 1');
    // What it did: the steps, and the file it opened, whose name leads to the source.
    expect(card?.querySelector('[data-testid="agent-steps"]')?.textContent).toContain('Читаю docs/a.md');
    const link = card?.querySelector('[data-testid="agent-opened"] a');
    expect(link?.getAttribute('href')).toBe('/api/source?repo=repo&path=docs%2Fa.md');
    expect(card?.querySelector('[data-testid="agent-opened"]')?.textContent).toContain('repo: docs/a.md');
    // What it returned, what it cost, and the raw record behind the words.
    expect(card?.querySelector('[data-testid="agent-answer"]')?.textContent).toContain('"state":"complete"');
    expect(card?.querySelector('[data-testid="agent-tokens"]')?.textContent).toContain('Токены: 300 вход · 40 выход · 340 всего');
    expect(card?.querySelector('[data-testid="agent-raw"]')?.textContent).toContain('Сырой JSON');
    expect(card?.querySelector('[data-testid="agent-failure"]')).toBeNull();
  } finally {
    await page.close();
  }
});
