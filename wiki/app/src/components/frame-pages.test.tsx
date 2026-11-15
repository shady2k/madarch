
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

afterAll(() => { GlobalRegistrator.unregister(); });

type Section = Parameters<typeof PageView>[0]['composition']['sections'][number];

function section(id: string, component: string, params: Record<string, unknown>): Section {
  return { id, component, on: 'subject', replace: false, params, line: 1, alias: `s_${id}` } as Section;
}

const PROBLEMS = {
  problems: [
    {
      id: 'large-file\u0000a', identity: 'a', section: 'code', rule: 'large-file', kind: 'large-file', sonar: 'code-smell', severity: 'minor', fixer: 'person', closed: false,
      place: { label: 'src/big.ts:1', href: '/src?path=src/big.ts&line=1', key: null }, entity: null, evidence: [], page: null, pageTitle: null,
      statement: null, sentence: null, target: null, reason: 'Файл длиннее, чем человек может удержать в голове.', file: 'src/big.ts', line: 1,
      source: '/tmp/product/src/big.ts', by: null, at: null,
    },
    {
      id: 'wiki.broken-link\u0000b', identity: 'b', section: 'wiki', rule: 'wiki.broken-link', kind: 'broken-link', sonar: 'bug', severity: 'major', fixer: 'agent', closed: false,
      place: { label: 'domain:payments', href: '/e/demo.page/uid-1', key: 'domain:payments' }, entity: { label: 'payments', href: '/e/demo.page/uid-1', key: 'p' }, evidence: [], page: 'p', pageTitle: 'Payments',
      statement: 'refund-check', sentence: 'A refund is checked.', target: 'madarch:missing', reason: 'Ссылка никуда не ведёт.', file: 'docs/payments.md', line: 12,
      by: null, at: null,
    },
  ],
  categories: [
    { rule: 'large-file', kind: 'large-file', section: 'code', sonar: 'code-smell', severity: 'minor', fixer: 'person', count: 1, open: 1, closed: 0, label: { en: 'Large file', ru: 'Большой файл' } },
    { rule: 'wiki.broken-link', kind: 'broken-link', section: 'wiki', sonar: 'bug', severity: 'major', fixer: 'agent', count: 1, open: 1, closed: 0, label: { en: 'Broken link', ru: 'Битая ссылка' } },
  ],
  sections: { code: 1, documents: 0, wiki: 1 }, open: 2, closed: 0, dismissed: 0,
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
  busy: false,
};

const requests: { path: string; method: string; body: unknown }[] = [];

function answer(body: unknown): Response {
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
    if (url.pathname.endsWith('/api/problems')) return answer(PROBLEMS);
    if (url.pathname.endsWith('/api/problem-dismiss') || url.pathname.endsWith('/api/problem-task')) return answer({ file: 'docs/problems/x.md', committed: false, task: { title: 'Fix the file' } });
    if (url.pathname.endsWith('/api/sources')) return answer(SOURCES);
    if (url.pathname.endsWith('/api/product-settings')) return answer(SETTINGS);
    if (url.pathname.endsWith('/api/agents')) return answer({ agents: [{ id: 'claude-code', label: 'Claude Code', installed: true, login: 'signed-in', loginDetail: '', where: '/opt/claude', version: null, install: null }], chosen: null });
    if (url.pathname.endsWith('/api/settings')) return answer({ role: 'all', asked: true, roles: ['architect', 'all'] });
    if (url.pathname.endsWith('/api/agent-choices')) return answer({ agent: { id: 'claude-code', label: 'Claude Code' }, choices: { model: null, reasoning: null } });
    if (url.pathname.endsWith('/api/agent') || url.pathname.endsWith('/api/model-role')) return answer({});
    return answer({});
  }) as unknown as typeof fetch;
});

async function settle(): Promise<void> {
  for (let at = 0; at < 12; at += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
}

async function render(component: string, params: Record<string, unknown> = {}): Promise<{ container: HTMLElement; roles: string[]; close: () => Promise<void> }> {
  const roles: string[] = [];
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(PageView, {
      composition: { template: 'probe', operation: '', variables: {}, sections: [section('body', component, params)], findings: [] },
      data: {},
      runtime: { base: '', language: 'ru', busy: false, variables: {}, product: null, navigation: null, pageName: null, open: () => undefined, reload: () => undefined, onRole: (role: string) => { roles.push(role); } },
    }));
  });
  await settle();
  return { container, roles, close: async () => { await act(async () => { root.unmount(); }); container.remove(); } };
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
    expect(text).toContain('2 открытых из 2 проблем');
    expect(text).toContain('src/big.ts:1');
    expect(text).toContain('A refund is checked.');
    expect(page.container.querySelector('a[href="/e/demo.page/uid-1"]')).not.toBeNull();

    const first = page.container.querySelectorAll('[data-testid="problem-row"]')[0]!;
    await act(async () => { (first.querySelector('[data-testid="problem-not-a-problem"]') as HTMLButtonElement).click(); });
    const reason = first.querySelector('[data-testid="problem-dismiss-reason"]') as HTMLTextAreaElement;
    await act(async () => { type(reason, 'Это ожидаемо.'); });
    await act(async () => { (first.querySelector('[data-testid="problem-dismiss-confirm"]') as HTMLButtonElement).click(); });
    await settle();
    const dismiss = requests.find((one) => one.path.endsWith('/api/problem-dismiss'));
    expect(dismiss?.body).toEqual({ id: 'large-file\u0000a', reason: 'Это ожидаемо.' });

    const second = page.container.querySelectorAll('[data-testid="problem-row"]')[1]!;
    await act(async () => { (second.querySelector('[data-testid="problem-create-task"]') as HTMLButtonElement).click(); });
    await settle();
    expect(requests.some((one) => one.path.endsWith('/api/problem-task') && (one.body as { id?: string }).id === 'wiki.broken-link\u0000b')).toBe(true);
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
