
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
const { TooltipProvider } = await import('./ui/tooltip.js');
const { setWikiLanguage } = await import('../i18n.js');
const { reportOffline, reportOnline } = await import('../connection.js');

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
    // A kind the agent alone fills, and a prerequisite it rests on that only the agent fills too (madarch-64o5.123).
    { kind: 'demo.cycle', one: 'Цикл', many: 'Циклы', definition: 'Кольцо зависимостей', taken: false, group: 'demo.code', nav: null, count: 0, entryId: null },
    { kind: 'demo.module', one: 'Модуль', many: 'Модули', definition: 'Модуль кода', taken: false, group: 'demo.code', nav: null, count: 0, entryId: null },
  ],
  purposes: [],
};

const ALPHA = { kind: 'demo.alpha', fields: [{ field: 'path', producers: ['disk'] }], agentFields: [] };
const BETA = { kind: 'demo.beta', fields: [{ field: 'definition', labels: { en: 'Definition', ru: 'Определение' }, producers: ['agent-fill'] }], agentFields: ['definition'] };
const GAMMA = { kind: 'demo.gamma', fields: [{ field: 'title', producers: ['disk'] }, { field: 'definition', labels: { en: 'Definition', ru: 'Определение' }, producers: ['agent-fill'] }], agentFields: ['definition'] };

const CYCLE = { kind: 'demo.cycle', fields: [{ field: 'members', labels: { en: 'Members', ru: 'Состав' }, producers: ['agent-fill'] }], agentFields: ['members'] };
const MODULE = { kind: 'demo.module', fields: [{ field: 'name', labels: { en: 'Name', ru: 'Имя' }, producers: ['agent-fill'] }], agentFields: ['name'] };

const ALL_PLAN = {
  selectedKinds: ['demo.alpha', 'demo.beta', 'demo.gamma', 'demo.cycle', 'demo.module'], order: ['disk', 'agent-fill'],
  units: [{ plugin: 'disk', kind: 'demo.alpha' }, { plugin: 'agent-fill', kind: 'demo.beta' }, { plugin: 'disk', kind: 'demo.gamma' }, { plugin: 'agent-fill', kind: 'demo.gamma' }],
  kinds: [ALPHA, BETA, GAMMA, CYCLE, MODULE],
  needsAgent: [{ kind: 'demo.beta', fields: ['definition'] }, { kind: 'demo.gamma', fields: ['definition'] }, { kind: 'demo.cycle', fields: ['members'] }, { kind: 'demo.module', fields: ['name'] }],
  errors: [], skipped: [], requestedKinds: ['demo.alpha', 'demo.beta', 'demo.gamma', 'demo.cycle', 'demo.module'], added: [], pluginsOnly: false,
};

function planFor(selected: readonly string[], pluginsOnly = false) {
  const common = { requestedKinds: selected, added: [] as { kind: string; neededBy: string }[], pluginsOnly, errors: [] as unknown[], skipped: [] as { kind: string; fields: string[]; reason: string }[] };
  // The cycle rests on the module, which only the agent fills: asking for the cycle alone has nothing to produce either
  // (the owner's read of code.cycle), and asking for both plans the agent for both (madarch-64o5.123).
  if (selected.length === 5) return { plan: { ...ALL_PLAN, ...common } };
  const cycleOnly = selected.includes('demo.cycle') && !selected.includes('demo.module');
  const both = selected.includes('demo.cycle') && selected.includes('demo.module');
  if (cycleOnly) {
    return { plan: { ...common, selectedKinds: [], order: [], units: [], kinds: [], needsAgent: [],
      added: [{ kind: 'demo.alpha', neededBy: 'demo.cycle' }, { kind: 'demo.module', neededBy: 'demo.cycle' }],
      errors: [
        { kind: 'demo.cycle', fields: [], message: 'kind "demo.cycle" cannot be filled: its prerequisite "demo.module" has no producer in the manifest' },
        { kind: 'demo.module', fields: ['name'], message: 'kind "demo.module" cannot be filled: no producer in the manifest' },
      ] } };
  }
  if (both) {
    return { plan: { ...common, selectedKinds: ['demo.alpha', 'demo.module', 'demo.cycle'], order: pluginsOnly ? ['disk'] : ['disk', 'agent-fill'], units: [],
      kinds: [ALPHA, MODULE, CYCLE], needsAgent: [{ kind: 'demo.module', fields: ['name'] }, { kind: 'demo.cycle', fields: ['members'] }],
      added: [{ kind: 'demo.alpha', neededBy: 'demo.cycle' }] } };
  }
  if (selected.includes('demo.gamma')) {
    return { plan: { ...common, selectedKinds: ['demo.alpha', 'demo.gamma'], order: ['disk', 'agent-fill'], units: [], kinds: [ALPHA, GAMMA], needsAgent: [{ kind: 'demo.gamma', fields: ['definition'] }], added: [{ kind: 'demo.alpha', neededBy: 'demo.gamma' }] } };
  }
  if (selected.includes('demo.beta')) {
    return { plan: { ...common, selectedKinds: ['demo.beta'], order: pluginsOnly ? [] : ['agent-fill'], units: [], kinds: [BETA], needsAgent: [{ kind: 'demo.beta', fields: ['definition'] }], skipped: [{ kind: 'demo.beta', fields: ['definition'], reason: 'no producer in the manifest' }] } };
  }
  return { plan: { ...common, selectedKinds: ['demo.alpha'], order: ['disk'], units: [], kinds: [ALPHA], needsAgent: [] } };
}

const RUN = {
  runId: 'fill-run-1', state: 'running', phase: 'running', final: false, startedAt: new Date(Date.now() - 5000).toISOString(), updatedAt: new Date().toISOString(), finishedAt: null,
  elapsedMs: 5000, remainingMs: 2500, selected: ['demo.alpha'], order: ['demo.alpha'], vertex: null,
  groups: [
    { kind: 'demo.alpha', group: 'code', plugin: 'disk', done: 2, total: 3, state: 'running', phase: 'running' },
    // A producer with no planned unit: a plugins-only run's agent row, which the page must not draw.
    { kind: 'demo.gamma', group: 'docs', plugin: 'agent-fill', done: 0, total: 0, state: 'planned', phase: 'waiting' },
  ],
  units: [
    { unitId: 'disk:demo.alpha', stage: 'disk:demo.alpha', scope: 'file', status: 'published', phase: 'done', generation: 1, attempts: 1 },
    { unitId: 'disk:demo.alpha', stage: 'disk:demo.alpha', scope: 'file:b', status: 'published', phase: 'done', generation: 1, attempts: 1 },
    { unitId: 'disk:demo.alpha', stage: 'disk:demo.alpha', scope: 'file:c', status: 'running', phase: 'running', generation: 1, attempts: 1 },
  ],
  events: [
    { seq: 1, at: new Date(Date.now() - 5000).toISOString(), stage: '', unitId: '', type: 'run-started', summary: 'the run started 2 stages: disk:demo.alpha' },
    { seq: 2, at: new Date(Date.now() - 4000).toISOString(), stage: 'disk:demo.alpha', unitId: 'disk:demo.alpha', type: 'unit-published', summary: 'disk:demo.alpha published 12 facts under /work/product/madarch/catalog.yaml 0123456789abcdef0123456789abcdef01234567' },
    { seq: 3, at: new Date(Date.now() - 3000).toISOString(), stage: 'disk:demo.alpha', unitId: 'disk:demo.alpha', type: 'unit-retried', summary: 'disk:demo.alpha failed: /product/src/plugin/cgroup.ts:1: the cgroup does not hand the cpu, memory, pids controllers to its children (cgroup.subtree_control holds nothing); the attempt is retried' },
  ],
  records: 12, publishedUnits: 2, agentUsage: null,
};

const requests: { path: string; method: string; body: unknown }[] = [];
let fillSelectionFailure: { status: number; body: unknown } | null = null;
let runAnswer: unknown = RUN;
/** The agents `/api/agents` offers and the one this product saved; both installed and signed in unless a test says otherwise. */
let agentOffers: { id: string; label: string; installed: boolean; login: string; loginDetail: string; where: string | null; version: string | null; install: null }[] = [
  { id: 'claude-code', label: 'Claude Code', installed: true, login: 'signed-in', loginDetail: '', where: '/opt/claude', version: '1.0', install: null },
  { id: 'codex', label: 'Codex', installed: true, login: 'signed-in', loginDetail: '', where: '/opt/codex', version: '2.0', install: null },
  { id: 'omp', label: 'omp', installed: false, login: 'unknown', loginDetail: '', where: null, version: null, install: null },
];
let savedAgent: { id: string; label: string } | null = null;
/** What `/api/product-settings` answers, and a switch to hold it open while a test presses early (madarch-64o5.90). */
let productSettings: Record<string, unknown> = { tokenCap: 200_000 };
let holdSettings: (() => void) | null = null;
/** A held `/api/agent-choices` answer, so a test can switch agents while one is pending. */
let holdChoices: (() => void) | null = null;

function answer(_path: string, body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('a successful run reads unmistakably finished at the top, with its end time', async () => {
  runAnswer = {
    ...RUN, state: 'succeeded', phase: 'succeeded', final: true, finishedAt: new Date().toISOString(), remainingMs: 0,
    groups: [{ kind: 'demo.alpha', group: 'code', plugin: 'disk', done: 3, total: 3, state: 'published', phase: 'done' }],
    units: [
      { unitId: 'disk:demo.alpha', stage: 'disk:demo.alpha', scope: 'file', status: 'published', phase: 'done', generation: 1, attempts: 1 },
      { unitId: 'disk:demo.alpha', stage: 'disk:demo.alpha', scope: 'file:b', status: 'published', phase: 'done', generation: 1, attempts: 1 },
      { unitId: 'disk:demo.alpha', stage: 'disk:demo.alpha', scope: 'file:c', status: 'published', phase: 'done', generation: 1, attempts: 1 },
    ],
  };
  const page = await render([section('run', 'run', { runVariable: 'run' })], { run: 'fill-run-1' });
  try {
    expect(page.container.querySelector('[data-testid="fill-run-status-badge"]')?.textContent).toBe('Завершён');
    expect(page.container.querySelector('[data-testid="fill-run-final"]')).toBeNull();
    expect(page.container.querySelector('[data-testid="fill-run-ended"]')?.textContent).toContain('с');
    expect(page.container.querySelector('[data-testid="fill-run-ended"]')?.textContent).not.toContain('Завершён');
    expect(page.container.querySelector('[data-testid="fill-run-time"]')?.textContent).not.toContain('Осталось');
    expect(page.container.querySelector('[data-testid="fill-run-retry"]')).toBeNull();
    expect(page.container.textContent).not.toContain('done');
  } finally { await page.close(); }
});

test('a run that published nothing is failed, never partial', async () => {
  runAnswer = {
    ...RUN, state: 'failed', phase: 'failed', final: true, finishedAt: new Date().toISOString(), remainingMs: null, publishedUnits: 0,
    groups: [{ kind: 'demo.alpha', group: 'code', plugin: 'disk', done: 0, total: 2, state: 'failed', phase: 'failed' }],
    units: [
      { unitId: 'disk:demo.alpha', stage: 'disk:demo.alpha', scope: 'file', status: 'failed', phase: 'failed', generation: 1, attempts: 1 },
      { unitId: 'disk:demo.alpha', stage: 'disk:demo.alpha', scope: 'file:b', status: 'skipped', phase: 'skipped', skippedBecause: 'unit disk:demo.alpha failed', generation: 1, attempts: 1 },
    ],
  };
  const page = await render([section('run', 'run', { runVariable: 'run' })], { run: 'fill-run-1' });
  try {
    expect(page.container.querySelector('[data-testid="fill-run-status-badge"]')?.textContent).toBe('Не удалось');
    expect(page.container.querySelector('[data-testid="fill-run-final"]')?.getAttribute('data-phase')).toBe('failed');
    expect(page.container.textContent).not.toContain('Частично');
  } finally { await page.close(); }
});

test('unit counts use the locale plural rules for one, few, many and twenty-one', async () => {
  const cases: readonly [number, string, string][] = [
    [1, 'из 1 единицы', 'of 1 unit'],
    [2, 'из 2 единиц', 'of 2 units'],
    [5, 'из 5 единиц', 'of 5 units'],
    [21, 'из 21 единицы', 'of 21 units'],
  ];
  for (const language of ['ru', 'en'] as const) {
    await setWikiLanguage(language);
    for (const [total, russian, english] of cases) {
      runAnswer = {
        ...RUN, state: 'succeeded', phase: 'succeeded', final: true, finishedAt: new Date().toISOString(), remainingMs: 0, publishedUnits: total,
        units: Array.from({ length: total }, (_, at) => ({ unitId: `disk:demo.alpha`, stage: 'disk:demo.alpha', scope: `file:${String(at)}`, status: 'published', phase: 'done', generation: 1, attempts: 1 })),
        groups: [],
      };
      const page = await render([section('run', 'run', { runVariable: 'run' })], { run: 'fill-run-1' });
      try {
        const text = page.container.textContent ?? '';
        expect(text).toContain(language === 'ru' ? russian : english);
      } finally { await page.close(); }
    }
  }
});

test('a finished partial run shows its final state, not a remaining time, and names its skipped units', async () => {
  runAnswer = {
    ...RUN, state: 'completed_partial', phase: 'partial', final: true, finishedAt: new Date().toISOString(), remainingMs: null,
    groups: [{ kind: 'demo.alpha', group: 'code', plugin: 'disk', done: 1, total: 3, state: 'failed', phase: 'failed' }],
    units: [
      { unitId: 'disk:demo.alpha', stage: 'disk:demo.alpha', scope: 'file', status: 'published', phase: 'done', generation: 1, attempts: 1 },
      { unitId: 'disk:demo.alpha', stage: 'disk:demo.alpha', scope: 'file:b', status: 'failed', phase: 'failed', generation: 1, attempts: 1 },
      { unitId: 'disk:demo.alpha', stage: 'disk:demo.alpha', scope: 'file:c', status: 'skipped', phase: 'skipped', skippedBecause: 'unit disk:demo.alpha failed', generation: 1, attempts: 1 },
    ],
  };
  const page = await render([section('run', 'run', { runVariable: 'run' })], { run: 'fill-run-1' });
  try {
    expect(page.container.querySelector('[data-testid="fill-run-final"]')?.getAttribute('data-phase')).toBe('partial');
    expect(page.container.querySelector('[data-testid="fill-run-final-title"]')?.textContent).toContain('не полностью');
    expect(page.container.querySelector('[data-testid="fill-run-time"]')?.textContent).not.toContain('Осталось');
    expect(page.container.querySelector('[data-testid="fill-run-units"]')?.textContent).toContain('не выполнилась единица');
    expect(page.container.querySelector('[data-testid="fill-run-retry"]')).not.toBeNull();
  } finally { await page.close(); }
});

beforeEach(async () => {
  requests.length = 0;
  fillSelectionFailure = null;
  runAnswer = RUN;
  savedAgent = null;
  productSettings = { tokenCap: 200_000 };
  holdSettings = null;
  holdChoices = null;
  agentOffers = [
    { id: 'claude-code', label: 'Claude Code', installed: true, login: 'signed-in', loginDetail: '', where: '/opt/claude', version: '1.0', install: null },
    { id: 'codex', label: 'Codex', installed: true, login: 'signed-in', loginDetail: '', where: '/opt/codex', version: '2.0', install: null },
    { id: 'omp', label: 'omp', installed: false, login: 'unknown', loginDetail: '', where: null, version: null, install: null },
  ];
  await setWikiLanguage('ru');
  (globalThis as { fetch: typeof fetch }).fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    requests.push({ path: url.pathname + url.search, method, body });
    if (url.pathname.endsWith('/api/fill-plan')) return answer(url.pathname, planFor(((body as { selected?: string[]; pluginsOnly?: boolean } | undefined)?.selected ?? []), (body as { pluginsOnly?: boolean } | undefined)?.pluginsOnly === true));
    if (url.pathname.endsWith('/api/agents')) return answer(url.pathname, { agents: agentOffers, chosen: savedAgent });
    if (url.pathname.endsWith('/api/agent-choices')) {
      const asked = url.searchParams.get('agent') ?? 'claude-code';
      const offered = asked === 'codex'
        ? { choices: { model: { name: 'Model', current: 'gpt-5-codex', values: [{ value: 'gpt-5-codex', name: 'GPT-5 Codex' }, { value: 'gpt-5-mini', name: 'GPT-5 mini' }] }, reasoning: { name: 'Reasoning', current: 'high', values: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] } } }
        : { choices: { model: { name: 'Model', current: 'opus', values: [{ value: 'opus', name: 'Opus' }, { value: 'sonnet', name: 'Sonnet' }] }, reasoning: { name: 'Reasoning', current: 'medium', values: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }] } } };
      const offeredAgent = { id: asked, label: asked === 'codex' ? 'Codex' : 'Claude Code' };
      if (holdChoices !== null) return await new Promise<Response>((resolve) => { holdChoices = () => resolve(answer(url.pathname, { agent: offeredAgent, ...offered })); });
      return answer(url.pathname, { agent: offeredAgent, ...offered });
    }
    if (url.pathname.endsWith('/api/status')) return answer(url.pathname, { fill: { state: 'idle' }, product: { id: 'p1', name: 'Portal' }, repositories: [{ name: 'app', filled: true }] });
    if (url.pathname.endsWith('/api/product-settings')) {
      if (holdSettings !== null) return await new Promise<Response>((resolve) => { holdSettings = () => resolve(answer(url.pathname, productSettings)); });
      return answer(url.pathname, productSettings);
    }
    if (url.pathname.endsWith('/api/fill-runs') && url.searchParams.has('run')) return answer(url.pathname, { run: runAnswer });
    if (url.pathname.endsWith('/api/fill-runs')) return answer(url.pathname, { runs: [runAnswer] });
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
    root.render(createElement(TooltipProvider, null, createElement(PageView, {
      composition: { template: 'fill', operation: '', variables, sections, findings: [] },
      data: {},
      runtime: { base: '', language: 'ru', busy: false, variables, product: 'Portal', navigation: NAVIGATION, pageName: null, open: (path: string) => { opened.push(path); }, reload: () => undefined },
    })));
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

test('a kind only the agent fills goes on to preparation with the prerequisite it rests on, never disabled for want of an agent', async () => {
  const page = await render([section('catalogue', 'catalogue', {})], { select: '1' });
  try {
    const cycle = page.container.querySelector('[data-testid="catalogue-kind-check-demo.cycle"]') as HTMLInputElement;
    await act(async () => { cycle.click(); });
    await settle();
    // The catalogue marks what the agent fills, and the press is never disabled for want of an agent the next page
    // chooses (madarch-64o5.123).
    expect(page.container.querySelector('[data-kind="demo.cycle"]')?.textContent).toContain('Заполнит агент: Состав');
    expect(page.container.querySelector('[data-kind="demo.module"]')?.textContent).toContain('Заполнит агент: Имя');
    expect(page.container.querySelector('[data-kind="demo.module"]')?.textContent).toContain('Нужно для');
    const prepare = page.container.querySelector('[data-testid="catalogue-prepare"]') as HTMLButtonElement;
    expect(prepare.disabled).toBe(false);
    expect(page.container.querySelector('[data-testid="catalogue-fill-error"]')).toBeNull();
    // The agent-only prerequisite travels with the selection: the preparation page must be able to plan it.
    await act(async () => { prepare.click(); });
    expect(page.opened.map((one) => decodeURIComponent(one))).toContain('/p/prepare?kinds=demo.cycle,demo.module');
  } finally {
    await page.close();
  }
});

test('choosing an agent on the preparation page makes the plan runnable, and plugins only names the kinds that stay empty', async () => {
  const page = await render([section('prepare', 'prepare', {})], { kinds: 'demo.cycle,demo.module' });
  try {
    // Plugins only is the product's default here: no plan error stands, the run goes on, and the empty kinds are named.
    expect(page.container.querySelector('[data-testid="prepare-plan-error"]')).toBeNull();
    expect(page.container.querySelector('[data-testid="prepare-unfilled-summary"]')).not.toBeNull();
    const empty = [...page.container.querySelectorAll('[data-testid="prepare-unfilled-kind"]')].map((one) => one.textContent ?? '').join(' ');
    expect(empty).toContain('Модули');
    expect(empty).toContain('Циклы');
    expect(page.container.querySelector('[data-testid="prepare-estimate"]')?.textContent).toBe('≈ 1 мин');
    expect(page.container.querySelector('[data-testid="prepare-run"]')?.hasAttribute('disabled')).toBe(false);
    // Choosing an agent makes the agent's kinds the run's own work: still no error, still runnable.
    const claude = page.container.querySelector('[data-testid="prepare-agent-claude-code"] [role="radio"]') as HTMLButtonElement;
    await act(async () => { claude.click(); });
    await settle();
    expect(page.container.querySelector('[data-testid="prepare-plan-error"]')).toBeNull();
    expect(page.container.querySelector('[data-testid="prepare-run"]')?.hasAttribute('disabled')).toBe(false);
  } finally {
    await page.close();
  }
});

test('the preparation panel shows every installed agent beside plugins-only, picks plugins-only by default, and runs the picked agent', async () => {
  const page = await render([section('prepare', 'prepare', {})], { kinds: 'demo.gamma' });
  try {
    const text = page.container.textContent ?? '';
    expect(text).toContain('Продукт и репозитории');
    expect(text).toContain('Portal');
    expect(text).toContain('app');
    expect(text).toContain('Что заполнится');
    expect(text).toContain('Плагины заполнят: disk');
    expect(text).toContain('Агент заполнит: Определение');
    // Nothing is saved, so «Только плагины» stands, but both installed agents stand beside it: three choices, visible.
    expect(page.container.querySelectorAll('[data-testid="prepare-who"] [role="radio"]').length).toBe(4);
    expect((page.container.querySelector('[data-testid="prepare-agent-omp"] [role="radio"]') as HTMLButtonElement).disabled).toBe(true);
    expect(page.container.querySelector('[data-testid="prepare-agent-state-omp"]')?.textContent).toContain('Не установлен');
    await act(async () => { (page.container.querySelector('[data-testid="prepare-agent-install-omp"]') as HTMLElement).click(); });
    expect(page.opened).toContain('/p/settings');
    expect(page.container.querySelector('[data-testid="prepare-plugins-only"]')?.getAttribute('aria-checked')).toBe('true');
    expect(text).toContain('Claude Code');
    expect(text).toContain('Codex');
    expect(page.container.querySelector('[data-testid="prepare-agent-state-claude-code"]')?.textContent).toBe('Вход выполнен.');
    // The unfilled fields are one counted line that opens into a row per kind, never a wall of text.
    expect(page.container.querySelector('[data-testid="prepare-unfilled-summary"]')?.textContent).toContain('Останутся пустыми 1 поле в 1 виде');
    expect(page.container.querySelector('[data-testid="prepare-unfilled-kind"]')?.textContent).toContain('Сценарии: Определение');
    // Beside the press stands its estimate: plugins-only names the time alone.
    expect(page.container.querySelector('[data-testid="prepare-estimate"]')?.textContent).toBe('≈ 1 мин');
    expect((page.container.querySelector('[data-testid="prepare-run"]') as HTMLButtonElement).disabled).toBe(false);
    expect(page.container.querySelector('[data-testid="prepare-cap"]')).toBeNull();
    // Choose Claude Code: its model appears beside the cap.
    const claude = page.container.querySelector('[data-testid="prepare-agent-claude-code"] [role="radio"]') as HTMLButtonElement;
    await act(async () => { claude.click(); });
    await settle();
    expect(page.container.querySelector('[data-testid="prepare-plugins-only"]')?.getAttribute('aria-checked')).toBe('false');
    expect(page.container.querySelector('[data-testid="prepare-agent-claude-code"]')?.getAttribute('data-chosen')).toBe('true');
    expect((page.container.querySelector('[data-testid="prepare-model"]') as HTMLSelectElement).value).toBe('opus');
    // The agent's own model and reasoning level stand beside the cap, and both follow the press (madarch-64o5.90).
    const modelSelect = page.container.querySelector('[data-testid="prepare-model"]') as HTMLSelectElement;
    const reasoningSelect = page.container.querySelector('[data-testid="prepare-reasoning"]') as HTMLSelectElement;
    expect(modelSelect.value).toBe('opus');
    expect(reasoningSelect.value).toBe('medium');
    expect(page.container.textContent).toContain('Сохранить по умолчанию');
    await act(async () => { modelSelect.value = 'sonnet'; modelSelect.dispatchEvent(new Event('change', { bubbles: true })); });
    await settle();
    // «Сохранить по умолчанию» saves the agent with the pair beside it; the press itself spends nothing.
    await act(async () => { (page.container.querySelector('[data-testid="prepare-save-defaults"]') as HTMLButtonElement).click(); });
    await settle();
    expect(requests.some((one) => one.path.endsWith('/api/agent') && one.method === 'POST' && (one.body as { agent?: string }).agent === 'claude-code')).toBe(true);
    expect(requests.some((one) => one.path.endsWith('/api/product-settings') && one.method === 'POST' && (one.body as { model?: string }).model === 'sonnet' && (one.body as { reasoning?: string }).reasoning === 'medium')).toBe(true);
    // With an agent the estimate also names the most the run may spend.
    expect(page.container.querySelector('[data-testid="prepare-estimate"]')?.textContent).toContain('до');
    expect(page.container.querySelector('[data-testid="prepare-estimate"]')?.textContent).toContain('200');
    // The cap offers the product's default (madarch-64o5.90), and an empty field runs under it rather than blocking.
    const cap = page.container.querySelector('[data-testid="prepare-cap"]') as HTMLInputElement;
    expect(cap.value).toBe('200000');
    expect(page.container.querySelector('[data-testid="prepare-cap-default"]')).toBeNull();
    await act(async () => { type(cap, ''); });
    expect(page.container.querySelector('[data-testid="prepare-cap-default"]')?.textContent).toContain('200');
    expect((page.container.querySelector('[data-testid="prepare-run"]') as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { type(cap, '1000'); });
    await act(async () => { (page.container.querySelector('[data-testid="prepare-run"]') as HTMLButtonElement).click(); });
    await settle();
    const pressed = requests.find((one) => one.path.endsWith('/api/fill-selected'));
    expect(pressed?.body).toEqual({ selected: ['demo.gamma'], agent: 'claude-code', model: 'sonnet', reasoning: 'medium', tokenCap: 1000, pluginsOnly: false });
    expect(page.opened).toContain('/p/run?run=fill-run-2');
  } finally {
    await page.close();
  }
});

test('Run waits for the product\'s saved model, so a press never sends the adapter\'s defaults', async () => {
  savedAgent = { id: 'claude-code', label: 'Claude Code' };
  productSettings = { tokenCap: 200_000, chosenAgent: { id: 'claude-code', label: 'Claude Code', model: 'sonnet', reasoning: 'high' } };
  holdSettings = () => undefined;
  const page = await render([section('prepare', 'prepare', {})], { kinds: 'demo.gamma' });
  try {
    // The plan and the agent's choices stand, but the settings that carry the saved pair have not answered: Run waits.
    expect((page.container.querySelector('[data-testid="prepare-run"]') as HTMLButtonElement).disabled).toBe(true);
    const release = holdSettings as unknown as () => void;
    holdSettings = null;
    await act(async () => { release(); });
    await settle();
    // The saved pair now stands over the agent's own, and the press sends it.
    expect((page.container.querySelector('[data-testid="prepare-model"]') as HTMLSelectElement).value).toBe('sonnet');
    expect((page.container.querySelector('[data-testid="prepare-run"]') as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { (page.container.querySelector('[data-testid="prepare-run"]') as HTMLButtonElement).click(); });
    await settle();
    const pressed = requests.find((one) => one.path.endsWith('/api/fill-selected'));
    expect(pressed?.body).toEqual({ selected: ['demo.gamma'], agent: 'claude-code', model: 'sonnet', reasoning: 'high', tokenCap: 200_000, pluginsOnly: false });
  } finally {
    await page.close();
  }
});

test('the choices of another agent never stand in for the one just picked', async () => {
  const page = await render([section('prepare', 'prepare', {})], { kinds: 'demo.gamma' });
  try {
    await act(async () => { (page.container.querySelector('[data-testid="prepare-agent-claude-code"] [role="radio"]') as HTMLButtonElement).click(); });
    await settle();
    expect((page.container.querySelector('[data-testid="prepare-model"]') as HTMLSelectElement).value).toBe('opus');
    // Pick Codex while its choices are held: the previous agent's answer is no answer for this one, and Run waits.
    holdChoices = () => undefined;
    await act(async () => { (page.container.querySelector('[data-testid="prepare-agent-codex"] [role="radio"]') as HTMLButtonElement).click(); });
    await settle();
    expect(page.container.querySelector('[data-testid="prepare-model"]')).toBeNull();
    expect((page.container.querySelector('[data-testid="prepare-run"]') as HTMLButtonElement).disabled).toBe(true);
    const release = holdChoices as unknown as () => void;
    holdChoices = null;
    await act(async () => { release(); });
    await settle();
    expect((page.container.querySelector('[data-testid="prepare-model"]') as HTMLSelectElement).value).toBe('gpt-5-codex');
    await act(async () => { (page.container.querySelector('[data-testid="prepare-run"]') as HTMLButtonElement).click(); });
    await settle();
    const pressed = requests.find((one) => one.path.endsWith('/api/fill-selected'));
    expect(pressed?.body).toEqual({ selected: ['demo.gamma'], agent: 'codex', model: 'gpt-5-codex', reasoning: 'high', tokenCap: 200_000, pluginsOnly: false });
  } finally {
    await page.close();
  }
});

test('the product\'s saved agent is the default, and an agent that cannot run is shown with what is missing', async () => {
  savedAgent = { id: 'codex', label: 'Codex' };
  agentOffers[0] = { ...agentOffers[0]!, login: 'not-signed-in' };
  const page = await render([section('prepare', 'prepare', {})], { kinds: 'demo.gamma' });
  try {
    expect(page.container.querySelector('[data-testid="prepare-agent-codex"]')?.getAttribute('data-chosen')).toBe('true');
    expect(page.container.querySelector('[data-testid="prepare-plugins-only"]')?.getAttribute('aria-checked')).toBe('false');
    // Claude Code has no sign-in here: its choice stays visible, disabled, and says what is missing in one sentence.
    const claude = page.container.querySelector('[data-testid="prepare-agent-claude-code"] [role="radio"]') as HTMLButtonElement;
    expect(claude.disabled).toBe(true);
    expect(page.container.querySelector('[data-testid="prepare-agent-state-claude-code"]')?.textContent).toContain('Нет входа — войдите в Claude Code');
    // No engine word and no machine path on this page: the state and the next step alone (madarch-64o5.90).
    expect(page.container.querySelector('[data-testid="prepare-agent-state-claude-code"]')?.textContent).not.toContain('/opt');
    expect(page.container.querySelector('[data-testid="prepare-agent-state-claude-code"]')?.textContent).not.toContain('адаптер');
    expect(requests.some((one) => one.path.endsWith('/api/agents'))).toBe(true);
  } finally {
    await page.close();
  }
});

test('a server refusal is shown in the reader\'s language by its code', async () => {
  const page = await render([section('prepare', 'prepare', {})], { kinds: 'demo.gamma' });
  try {
    await act(async () => { (page.container.querySelector('[data-testid="prepare-agent-claude-code"] [role="radio"]') as HTMLButtonElement).click(); });
    await settle();
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

test('the stop confirmation is disabled while the link is away', async () => {
  const page = await render([section('run', 'run', { runVariable: 'run' })], { run: 'fill-run-1' });
  try {
    await act(async () => { (page.container.querySelector('[data-testid="run-stop"]') as HTMLButtonElement).click(); });
    await settle();
    expect((document.querySelector('[data-testid="stop-confirm"]') as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { reportOffline(); await Promise.resolve(); });
    await settle();
    expect((document.querySelector('[data-testid="stop-confirm"]') as HTMLButtonElement).disabled).toBe(true);
    const before = requests.filter((one) => one.path.endsWith('/api/stop')).length;
    await act(async () => { (document.querySelector('[data-testid="stop-confirm"]') as HTMLButtonElement).click(); });
    await settle();
    expect(requests.filter((one) => one.path.endsWith('/api/stop'))).toHaveLength(before);
  } finally {
    await page.close();
    reportOnline();
  }
});
