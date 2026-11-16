
/**
 * The frame pages with mocked command answers (decision 0036, section 7): the Problems page groups the server's open
 * findings and presses the retained actions, the Sources page lists documents and repositories, and the settings page
 * reads and writes the retained settings routes.
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
const { reportOffline, reportOnline } = await import('../connection.js');

afterAll(() => { GlobalRegistrator.unregister(); });

type Section = Parameters<typeof PageView>[0]['composition']['sections'][number];

function section(id: string, component: string, params: Record<string, unknown>): Section {
  return { id, component, on: 'subject', replace: false, params, line: 1, alias: `s_${id}` } as Section;
}

const PROBLEMS = {
  problems: [
    {
      id: 'large-file\u0000a', identity: 'a', section: 'code', rule: 'large-file', kind: 'large-file', sonar: 'code-smell', severity: 'minor', closed: false,
      place: { label: 'src/big.ts:1', href: '/src?path=src/big.ts&line=1', key: null }, entity: null, evidence: [], page: null, pageTitle: null,
      statement: null, sentence: null, target: null, text: { code: 'largeFile', args: { path: 'src/big.ts', count: 674, limit: 600 } }, file: 'src/big.ts', line: 1,
      source: '/tmp/product/src/big.ts', by: null, at: null,
    },
    {
      id: 'wiki.broken-link\u0000b', identity: 'b', section: 'wiki', rule: 'wiki.broken-link', kind: 'broken-link', sonar: 'bug', severity: 'major', closed: false,
      place: { label: 'domain:payments', href: '/e/demo.page/uid-1', key: 'domain:payments' }, entity: { label: 'payments', href: '/e/demo.page/uid-1', key: 'p' }, evidence: [], page: 'p', pageTitle: 'Payments',
      statement: 'refund-check', sentence: 'A refund is checked.', target: 'madarch:missing', text: { code: 'brokenLinkNoEntity', args: { key: 'payments' } }, file: 'docs/payments.md', line: 12,
      by: null, at: null,
      task: { label: 'Исправить: Битая ссылка — docs/payments.md:12', href: '/e/task/uid-task-1', key: 'task:uid-task-1' },
    },
    {
      id: 'dead-export\u0000c', identity: 'c', section: 'code', rule: 'dead-export', kind: 'dead-export', sonar: 'code-smell', severity: 'minor', closed: false,
      place: { label: 'src/old.ts:4', href: '/e/code.file/uid-2', key: 'code.file:src/old.ts' }, entity: null, evidence: [], page: null, pageTitle: null,
      statement: null, sentence: null, target: null, text: { code: 'deadExport', args: { symbol: 'unused', path: 'src/old.ts' } }, file: 'src/old.ts', line: 4,
      by: null, at: null,
    },
  ],
  categories: [
    { rule: 'large-file', kind: 'large-file', section: 'code', sonar: 'code-smell', severity: 'minor', count: 1, open: 1, closed: 0, label: { en: 'Large file', ru: 'Большой файл' } },
    { rule: 'dead-export', kind: 'dead-export', section: 'code', sonar: 'code-smell', severity: 'minor', count: 1, open: 1, closed: 0, label: { en: 'Exported but unused', ru: 'Экспорт без использования' } },
    { rule: 'wiki.broken-link', kind: 'broken-link', section: 'wiki', sonar: 'bug', severity: 'major', count: 1, open: 1, closed: 0, label: { en: 'Broken link', ru: 'Битая ссылка' } },
  ],
  sections: { code: 2, documents: 0, wiki: 1 }, open: 3, closed: 0, dismissed: 0,
  notes: [{ message: 'the documents section is not judged: Markdown questions are retired; generic authored entities do not declare document predicates', textKey: 'documentsRetired' }],
};

const SOURCES = {
  documents: [
    { repo: null, path: 'docs/guide.md', title: 'Guide', kind: 'demo.doc', id: 'uid-1' },
    { repo: 'app', path: 'README.md', title: 'App readme', kind: 'demo.doc', id: 'uid-2' },
  ],
  repositories: [{ name: null, present: true, filled: true }, { name: 'app', present: true, filled: false }],
  truncated: [],
};

const SETTINGS = {
  product: { name: 'portal', id: 'p1' }, folder: '/tmp/portal', store: '/tmp/portal/store', language: 'ru', chosenAgent: null,
  roles: {
    defaultRole: 'writing', defaultPair: null,
    roles: [
      { role: 'writing', pair: null, source: 'none' },
      { role: 'classification', pair: null, source: 'none' },
      { role: 'analysis', pair: null, source: 'none' },
      { role: 'editing', pair: null, source: 'none' },
    ],
  },
  agentNames: { 'claude-code': 'Claude Code' },
  bounds: { turns: 12, minutes: 20, toolCalls: 40, writeAttempts: 3, maxDomains: 8, editorialRequestsPerPage: 2 },
  tokenCap: 200_000,
  // What the two dangerous actions would remove and keep (madarch-64o5.136, section 16).
  danger: {
    rewrite: { agentPages: ['docs/product.md'], keptPages: ['docs/handbook.md'] },
    fresh: { store: ['graph'], agentPages: ['docs/product.md'], keptPages: ['docs/handbook.md'], unansweredQuestions: ['Q-1'], keptAnswers: ['A-1'] },
  },
  busy: false,
};

/** What `/api/graph-verdicts` answers: the saved report and one page of the rows a person still has to look at. */
const VERDICTS = {
  file: '/tmp/portal/store/graph-verdicts.json', budgets: { itemsPerRun: 500, modelCallsPerRun: 5 }, cached: true,
  report: {
    generatedAt: '2026-11-15T10:00:00.000Z', validatorVersion: '1.2.3',
    totals: { items: 40, valid: 30, invalid: 4, unreviewed: 6 },
    reasons: [{ reason: 'no rule decided', count: 6 }],
    byKind: [{ role: 'node', kind: 'demo.thing', valid: 3, invalid: 1, unreviewed: 2 }],
  },
  total: 10, offset: 0, limit: 100,
  rows: [{ id: 'n1', role: 'node', kind: 'demo.thing', label: 'Queue', verdict: 'unreviewed', reason: 'no rule decided' }],
};

const requests: { path: string; method: string; body: unknown }[] = [];
let readerAnswer: Record<string, unknown> = { role: 'all', asked: true, roles: ['architect', 'all'], pluginsUnconfined: null, pluginIsolation: { capable: true, reason: 'plugins run isolated on this machine' } };

function answer(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(async () => {
  requests.length = 0;
  readerAnswer = { role: 'all', asked: true, roles: ['architect', 'all'], pluginsUnconfined: null, pluginIsolation: { capable: true, reason: 'plugins run isolated on this machine' } };
  await setWikiLanguage('ru');
  (globalThis as { fetch: typeof fetch }).fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    requests.push({ path: url.pathname + url.search, method, body });
    if (url.pathname.endsWith('/api/problems')) return answer(PROBLEMS);
    if (url.pathname.endsWith('/api/problem-dismiss')) return answer({ file: 'docs/problems/x.md', committed: false });
    if (url.pathname.endsWith('/api/problem-task')) return answer({ state: 'created', task: { label: 'Исправить: Экспорт без использования — src/old.ts:4', href: '/e/task/uid-task-2', key: 'task:uid-task-2' } });
    if (url.pathname.endsWith('/api/sources')) return answer(SOURCES);
    if (url.pathname.endsWith('/api/product-settings')) return answer(SETTINGS);
    if (url.pathname.endsWith('/api/graph-verdicts')) return answer(VERDICTS);
    if (url.pathname.endsWith('/api/rewrite-pages') || url.pathname.endsWith('/api/start-fresh')) return answer({ plan: SETTINGS.danger.fresh, fill: {} });
    if (url.pathname.endsWith('/api/agents')) return answer({ agents: [{ id: 'claude-code', label: 'Claude Code', installed: true, login: 'signed-in', loginDetail: '', where: '/opt/claude', version: null, install: null }], chosen: null });
    if (url.pathname.endsWith('/api/settings')) {
      if (method === 'POST') {
        const asked = body as { pluginsUnconfined?: boolean } | null;
        if (asked?.pluginsUnconfined !== undefined) readerAnswer = { ...readerAnswer, pluginsUnconfined: asked.pluginsUnconfined };
      }
      return answer(readerAnswer);
    }
    if (url.pathname.endsWith('/api/agent-choices')) return answer({ agent: { id: 'claude-code', label: 'Claude Code' }, choices: { model: null, reasoning: null } });
    if (url.pathname.endsWith('/api/agent') || url.pathname.endsWith('/api/model-role')) return answer({});
    return answer({});
  }) as unknown as typeof fetch;
});

async function settle(): Promise<void> {
  for (let at = 0; at < 12; at += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
}

async function render(component: string, params: Record<string, unknown> = {}): Promise<{ container: HTMLElement; roles: string[]; opened: string[]; close: () => Promise<void> }> {
  const roles: string[] = [];
  const opened: string[] = [];
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(PageView, {
      composition: { template: 'probe', operation: '', variables: {}, sections: [section('body', component, params)], findings: [] },
      data: {},
      runtime: { base: '', language: 'ru', busy: false, variables: {}, product: null, navigation: null, pageName: null, role: 'everything', open: (path: string) => { opened.push(path); }, reload: () => undefined, onRole: (role: string) => { roles.push(role); } },
    }));
  });
  await settle();
  return { container, roles, opened, close: async () => { await act(async () => { root.unmount(); }); container.remove(); } };
}

function type(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

test('the Problems page groups the open findings and presses the retained actions', async () => {
  const page = await render('problem-actions', { path: 'problems' });
  try {
    const text = page.container.textContent ?? '';
    expect(text).toContain('Большой файл');
    expect(text).toContain('Документы не проверяются');
    expect(text).not.toContain('Markdown questions are retired');
    expect(text).not.toContain('large-file');
    expect(text).toContain('Битая ссылка');
    expect(text).toContain('3 открытых из 3 проблем');
    expect(text).toContain('src/big.ts:1');
    expect(text).toContain('A refund is checked.');
    // The sentence is the one the locale builds from the server's code and values, not an English sentence.
    expect(text).toContain('src/big.ts: 674 строки при пороге 600');
    expect(text).toContain('В графе нет «payments»');
    // What a problem needs, not who fixes it: code is changed by people and agents alike.
    expect(page.container.querySelector('[data-testid="problem-needs"]')?.textContent).toBe('Нужна правка кода');
    expect(text).not.toContain('Исправит человек');
    expect(page.container.querySelector('a[href="/e/demo.page/uid-1"]')).not.toBeNull();

    const first = page.container.querySelector('[data-testid="problem-row"][data-rule="large-file"]') as HTMLElement;
    await act(async () => { (first.querySelector('[data-testid="problem-not-a-problem"]') as HTMLButtonElement).click(); });
    const reason = first.querySelector('[data-testid="problem-dismiss-reason"]') as HTMLTextAreaElement;
    await act(async () => { type(reason, 'Это ожидаемо.'); });
    await act(async () => { (first.querySelector('[data-testid="problem-dismiss-confirm"]') as HTMLButtonElement).click(); });
    await settle();
    const dismiss = requests.find((one) => one.path.endsWith('/api/problem-dismiss'));
    expect(dismiss?.body).toEqual({ id: 'large-file\u0000a', reason: 'Это ожидаемо.' });

    // A problem without a task opens one with the press; the problem that has its task only opens the task.
    const third = page.container.querySelector('[data-testid="problem-row"][data-rule="dead-export"]') as HTMLElement;
    await act(async () => { (third.querySelector('[data-testid="problem-create-task"]') as HTMLButtonElement).click(); });
    await settle();
    expect(requests.some((one) => one.path.endsWith('/api/problem-task') && (one.body as { id?: string }).id === 'dead-export\u0000c')).toBe(true);
    expect(page.container.textContent).toContain('Задача Исправить: Экспорт без использования — src/old.ts:4 создана.');
  } finally {
    await page.close();
  }
});

test('a problem that already has its task links to it, and the press opens that task instead of a second', async () => {
  const page = await render('problem-actions', { path: 'problems' });
  try {
    const second = page.container.querySelector('[data-testid="problem-row"][data-rule="wiki.broken-link"]') as HTMLElement;
    const link = second.querySelector('[data-testid="problem-task"] a') as HTMLAnchorElement | null;
    expect(link?.getAttribute('href')).toBe('/e/task/uid-task-1');
    expect(link?.textContent).toBe('Исправить: Битая ссылка — docs/payments.md:12');
    expect(second.textContent).toContain('Есть задача:');
    const button = second.querySelector('[data-testid="problem-create-task"]') as HTMLButtonElement;
    expect(button.textContent).toBe('Открыть задачу');
    await act(async () => { button.click(); });
    await settle();
    expect(page.opened).toEqual(['/e/task/uid-task-1']);
    expect(requests.some((one) => one.path.endsWith('/api/problem-task'))).toBe(false);
  } finally {
    await page.close();
  }
});

test('the Sources page lists repositories and documents, and the filter hides a group', async () => {
  const page = await render('sources', {});
  try {
    const text = page.container.textContent ?? '';
    expect(text).toContain('Репозитории');
    expect(text).toContain('репозиторий продукта');
    expect(text).toContain('Guide');
    expect(text).toContain('App readme');
    expect(page.container.querySelector('a[href="/e/demo.doc/uid-1"]')).not.toBeNull();
    const filter = page.container.querySelector('[data-testid="sources-filter"]') as HTMLInputElement;
    await act(async () => { type(filter, 'App'); });
    const groups = page.container.querySelectorAll('[data-testid="sources-group"]');
    expect(groups).toHaveLength(1);
    expect(page.container.textContent).toContain('App');
    expect(page.container.textContent).not.toContain('Guide');
  } finally {
    await page.close();
  }
});

test('the settings page offers the agent, the roles, the language and the reader role', async () => {
  const page = await render('settings-form', { group: 'all' });
  try {
    const text = page.container.textContent ?? '';
    expect(text).toContain('Агент');
    expect(text).toContain('Claude Code');
    expect(text).toContain('Написание');
    expect(text).toContain('Классификация');
    await act(async () => { (page.container.querySelector('[data-testid="settings-agent-choose-claude-code"]') as HTMLButtonElement).click(); });
    await settle();
    const chosen = requests.find((one) => one.path.endsWith('/api/agent'));
    expect(chosen?.body).toEqual({ agent: 'claude-code', install: true });

    await act(async () => { (page.container.querySelector('[data-testid="settings-language-en"]') as HTMLButtonElement).click(); });
    await settle();
    expect(requests.some((one) => one.path.endsWith('/api/product-settings') && one.method === 'POST' && (one.body as { language?: string }).language === 'en')).toBe(true);

    // The default token cap is a product setting (madarch-64o5.90): the field shows it and saves it.
    const cap = page.container.querySelector('[data-testid="settings-token-cap"]') as HTMLInputElement;
    expect(cap.value).toBe('200000');
    await act(async () => { type(cap, '300000'); });
    await act(async () => { (page.container.querySelector('[data-testid="settings-token-cap-save"]') as HTMLButtonElement).click(); });
    await settle();
    expect(requests.some((one) => one.path.endsWith('/api/product-settings') && one.method === 'POST' && (one.body as { tokenCap?: number }).tokenCap === 300_000)).toBe(true);

    await act(async () => { (page.container.querySelector('[data-testid="settings-reader-architect"]') as HTMLButtonElement).click(); });
    await settle();
    expect(requests.some((one) => one.path.endsWith('/api/settings') && one.method === 'POST' && (one.body as { role?: string }).role === 'architect')).toBe(true);
    expect(page.roles).toContain('architect');
  } finally {
    await page.close();
  }
});


test('the settings page shows the graph verdicts, the bounds, where the product lives and the two dangerous actions', async () => {
  const page = await render('settings-form', { group: 'all' });
  try {
    const text = page.container.textContent ?? '';
    // Graph verdicts (madarch-64o5.136, section 16): the saved report, its rows and the two budgets.
    expect(page.container.querySelector('[data-testid="settings-verdicts-total"]')?.textContent).toBe('40');
    expect(page.container.querySelector('[data-testid="settings-verdicts-invalid"]')?.textContent).toBe('4');
    expect(page.container.querySelectorAll('[data-testid="settings-verdicts-row"]')).toHaveLength(1);
    expect(page.container.querySelector('[data-testid="settings-verdicts-kinds"]')?.textContent).toContain('demo.thing');
    await act(async () => { type(page.container.querySelector('[data-testid="settings-verdict-items-per-run"]') as HTMLInputElement, '250'); });
    await act(async () => { (page.container.querySelector('[data-testid="settings-verdicts-save"]') as HTMLButtonElement).click(); });
    await settle();
    expect(requests.some((one) => one.path.endsWith('/api/graph-verdicts') && one.method === 'POST' && (one.body as { itemsPerRun?: number }).itemsPerRun === 250)).toBe(true);
    await act(async () => { (page.container.querySelector('[data-testid="settings-verdicts-run"]') as HTMLButtonElement).click(); });
    await settle();
    expect(requests.some((one) => one.path.includes('/api/graph-verdicts?force=1'))).toBe(true);

    // Bounds: what the agent may spend, and the one bound a person sets.
    expect(page.container.querySelector('[data-testid="bound-turns"]')?.textContent).toBe('12');
    expect(page.container.querySelector('[data-testid="bound-editorial"]')?.textContent).toBe('2');
    await act(async () => { type(page.container.querySelector('[data-testid="bound-editorial-input"]') as HTMLInputElement, '3'); });
    await act(async () => { (page.container.querySelector('[data-testid="bound-editorial-save"]') as HTMLButtonElement).click(); });
    await settle();
    expect(requests.some((one) => one.path.endsWith('/api/product-settings') && one.method === 'POST' && (one.body as { editorialRequestsPerPage?: number }).editorialRequestsPerPage === 3)).toBe(true);

    // Places: the checkout and the store on this machine, and that nothing here pushes.
    expect(page.container.querySelector('[data-testid="places-folder"]')?.textContent).toBe('/tmp/portal');
    expect(page.container.querySelector('[data-testid="places-store"]')?.textContent).toBe('/tmp/portal/store');
    expect(page.container.querySelector('[data-testid="places-push"]')?.textContent).toContain('push');

    // Dangerous actions: no agent, so rewriting says why; starting over asks first and confirms the plan it showed.
    expect(text).toContain('Начать с нуля');
    expect(page.container.querySelector('[data-testid="danger-rewrite-needs-agent"]')).not.toBeNull();
    await act(async () => { (page.container.querySelector('[data-testid="danger-fresh-open"]') as HTMLButtonElement).click(); });
    expect(page.container.querySelector('[data-testid="danger-dialog"]')).not.toBeNull();
    expect(page.container.querySelector('[data-testid="danger-questions"]')?.textContent).toContain('1');
    await act(async () => { (page.container.querySelector('[data-testid="danger-confirm"]') as HTMLButtonElement).click(); });
    await settle();
    expect(requests.some((one) => one.path.endsWith('/api/start-fresh') && one.method === 'POST' && (one.body as { preview?: { store?: string[] } }).preview?.store?.[0] === 'graph')).toBe(true);
    expect(page.opened).toContain('/');
  } finally {
    await page.close();
  }
});

test('settings writes are disabled while the link is away', async () => {
  const page = await render('settings-form', { group: 'all' });
  try {
    const choose = page.container.querySelector('[data-testid="settings-agent-choose-claude-code"]') as HTMLButtonElement;
    expect(choose.disabled).toBe(false);
    await act(async () => { reportOffline(); await Promise.resolve(); });
    await settle();
    expect(choose.disabled).toBe(true);
    expect((page.container.querySelector('[data-testid="settings-role-select-classification"]') as HTMLSelectElement).disabled).toBe(true);
    expect((page.container.querySelector('[data-testid="settings-language-en"]') as HTMLButtonElement).disabled).toBe(true);
  } finally {
    await page.close();
    reportOnline();
  }
});

test('the machine settings show and change the isolation answer', async () => {
  readerAnswer = { role: 'all', asked: true, roles: ['architect', 'all'], pluginsUnconfined: null, pluginIsolation: { capable: false, reason: 'this machine does not give madarch a cgroup to limit plugins in' } };
  const page = await render('settings-form', { group: 'all' });
  try {
    expect(page.container.querySelector('[data-testid="settings-isolation-reason"]')?.textContent).toContain('нельзя изолировать');
    expect(page.container.textContent).not.toContain('MADARCH_PLUGIN_SANDBOX');
    await act(async () => { (page.container.querySelector('[data-testid="settings-isolation-allow"]') as HTMLButtonElement).click(); });
    await settle();
    expect(requests.some((one) => one.path.endsWith('/api/settings') && one.method === 'POST' && (one.body as { pluginsUnconfined?: boolean }).pluginsUnconfined === true)).toBe(true);
    expect(page.container.querySelector('[data-testid="settings-isolation-allowed"]')?.textContent).toContain('без изоляции');
  } finally { await page.close(); }
});

