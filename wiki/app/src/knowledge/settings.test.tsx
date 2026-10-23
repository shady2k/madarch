/**
 * The product settings page, the starter set's offers on the Problems page and the failure notes (madarch-m38l.11),
 * tested without a server: every request is answered by a stub giving the server's own shapes
 * (src/knowledge/product.ts `settingsView`, src/knowledge/starter-upgrade.ts `StarterOffer`).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setWikiLanguage } from '../i18n.js';
import { FailureNote } from './errors.js';
import { ProblemsPage } from './loop.js';
import { SettingsPage } from './settings.js';
import { showsProgress } from './app.js';
import { Root as AppRoot } from './root.js';
import { kRouteOf } from './routes.js';
import type { AgentChoices, ProductSettings, StarterOffer, WikiStatus } from './types.js';

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
  throw new Error(`never came to ${what}; the tree holds: ${document.body.innerHTML.replace(/ class="[^"]*"/g, '').slice(-2500)}`);
}

afterEach(async () => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = '';
  delete (globalThis as { fetch?: unknown }).fetch;
  window.history.replaceState({}, '', '/');
  await setWikiLanguage('en');
});

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
const BOUNDS = { turns: 30, minutes: 10, toolCalls: 80, writeAttempts: 5, maxDomains: 12 };

const settings = (over: Partial<ProductSettings> = {}): ProductSettings => ({
  product: { name: 'shop', id: 'p1' }, folder: '/products/sample-product', store: '/state/knowledge/p1', language: 'ru',
  chosenAgent: { id: 'claude-code', label: 'Claude Code' }, bounds: BOUNDS, busy: false,
  danger: {
    rewrite: { agentPages: ['docs/product.md', 'docs/domains/payments.md'], keptPages: ['docs/domains/mine.md'] },
    fresh: { store: ['/x/graph'], agentPages: ['docs/product.md', 'docs/domains/payments.md'], keptPages: ['docs/domains/mine.md'], editedStarterFiles: ['templates/domain.md'], replacedStarterFiles: ['madarch/kinds.yaml', 'templates/domain.md'] },
  },
  ...over,
});

const choices: AgentChoices = {
  agent: { id: 'claude-code', label: 'Claude Code' },
  choices: {
    model: { configId: 'model', name: 'Model', current: 'sonnet', values: [{ value: 'sonnet', name: 'Sonnet', description: 'Balanced' }, { value: 'opus', name: 'Opus' }] },
    reasoning: { configId: 'effort', name: 'Effort', current: null, values: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
  },
};

const OFFERS: StarterOffer[] = [
  { id: 'group:product', type: 'group', name: 'product', labels: { en: 'Product knowledge', ru: 'Знания о продукте' } },
  { id: 'kind:code.route', type: 'kind', name: 'code.route', labels: { en: 'HTTP route', ru: 'HTTP-маршрут' }, description: { en: 'An HTTP route a service serves.', ru: 'HTTP-маршрут сервиса.' }, group: 'contracts' },
  { id: 'fields:code.service', type: 'fields', name: 'code.service', labels: { en: 'Service', ru: 'Сервис' }, fields: ['group', 'labels'] },
  { id: 'roles', type: 'roles', name: 'roles' },
];

const status = (over: Partial<WikiStatus> = {}): WikiStatus => ({
  product: { name: 'shop', id: 'p1' }, manifest: 'ok', manifestFile: 'madarch/kinds.yaml', language: 'ru', seeded: [], findings: [], kinds: [], groups: [], repositories: [{ name: 'shop', filled: true }],
  filled: true, incomplete: false, fill: { state: 'idle' }, writer: { state: 'idle', agent: null, units: [] }, bounds: BOUNDS, chosenAgent: null, home: null, starterOffers: 0, ...over,
});

describe('the product settings page', () => {
  function stub(calls: { url: string; body: unknown }[], current: ProductSettings = settings()): void {
    (globalThis as { fetch?: unknown }).fetch = async (url: string, init?: RequestInit) => {
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      if (init?.method === 'POST') calls.push({ url, body });
      if (url.endsWith('/api/k/product-settings')) return json(current);
      if (url.endsWith('/api/k/agent-choices') || url.includes('/api/k/agent-choices?')) return json(choices);
      if (url.endsWith('/api/k/agents')) return json({ agents: [{ id: 'claude-code', label: 'Claude Code', installed: true, login: 'signed-in', loginDetail: '', install: null }, { id: 'codex', label: 'Codex', installed: false, login: 'unknown', loginDetail: '', install: { package: '@zed-industries/codex-acp', version: '1.0.0', size: '40 MB', folder: '/h/agents' } }], chosen: { id: 'claude-code', label: 'Claude Code' } });
      if (url.endsWith('/api/k/rewrite-pages') || url.endsWith('/api/k/start-fresh') || url.endsWith('/api/k/agent')) return json({});
      return json({ message: 'not here' }, 404);
    };
  }

  test('shows the agent, the model and reasoning level the agent reports, the language, the bounds and where the product lives', async () => {
    const calls: { url: string; body: unknown }[] = [];
    stub(calls);
    const page = into(createElement(SettingsPage, { version: 0, status: status(), refresh: () => undefined }));
    await until(() => page.querySelector('[data-testid=settings-model-select]') !== null, 'the model choice');
    expect(page.querySelector('h1')!.textContent).toBe('Product settings');
    await until(() => page.querySelector('[data-testid=settings-agent-claude-code]') !== null, 'the agents');
    expect(page.querySelector('[data-testid=settings-agent-claude-code]')!.getAttribute('data-chosen')).toBe('true');
    expect(page.querySelector('[data-testid=settings-agent-codex]')!.textContent).toContain('not installed');
    // The values are the agent's own, and nothing else is offered.
    const model = page.querySelector('[data-testid=settings-model-select]') as HTMLSelectElement;
    expect([...model.querySelectorAll('option')].map((option) => option.textContent)).toEqual(["The agent's own choice (Sonnet)", 'Sonnet', 'Opus']);
    const reasoning = page.querySelector('[data-testid=settings-reasoning-select]') as HTMLSelectElement;
    expect([...reasoning.querySelectorAll('option')].map((option) => option.textContent)).toEqual(["The agent's own choice", 'Low', 'High']);
    expect((page.querySelector('[data-testid=settings-language-ru] input') as HTMLInputElement).checked).toBe(true);
    expect(page.querySelector('[data-testid=bound-turns]')!.textContent).toBe('30');
    expect(page.querySelector('[data-testid=places-folder]')!.textContent).toBe('/products/sample-product');
    expect(page.querySelector('[data-testid=places-push]')!.textContent).toContain('no git push');
  });

  test('choosing a model, a reasoning level and a language saves exactly that', async () => {
    const calls: { url: string; body: unknown }[] = [];
    stub(calls);
    const page = into(createElement(SettingsPage, { version: 0, status: status(), refresh: () => undefined }));
    await until(() => page.querySelector('[data-testid=settings-model-select]') !== null, 'the model choice');
    const change = (element: HTMLSelectElement, value: string): void => {
      element.value = value;
      element.dispatchEvent(new window.Event('change', { bubbles: true }));
    };
    change(page.querySelector('[data-testid=settings-model-select]') as HTMLSelectElement, 'opus');
    await until(() => calls.length === 1, 'the model saved');
    expect(calls[0]!.body).toEqual({ model: 'opus' });
    change(page.querySelector('[data-testid=settings-reasoning-select]') as HTMLSelectElement, 'high');
    await until(() => calls.length === 2, 'the reasoning saved');
    expect(calls[1]!.body).toEqual({ reasoning: 'high' });
    (page.querySelector('[data-testid=settings-language-en] input') as HTMLInputElement).click();
    await until(() => calls.length === 3, 'the language saved');
    expect(calls[2]!.body).toEqual({ language: 'en' });
  });

  test('an agent that reports no model says so, and a failed question shows the agent\'s words with a way to ask again', async () => {
    (globalThis as { fetch?: unknown }).fetch = async (url: string) => {
      if (url.endsWith('/api/k/product-settings')) return json(settings());
      if (url.includes('/api/k/agent-choices')) return json({ message: 'Claude Code could not tell its models: it did not answer within 60000 ms' }, 409);
      return json({ agents: [], chosen: null });
    };
    const page = into(createElement(SettingsPage, { version: 0, status: status(), refresh: () => undefined }));
    await until(() => page.querySelector('[data-testid=settings-model-error]') !== null, 'the error');
    expect(page.querySelector('[data-testid=settings-model-error]')!.textContent).toContain('did not answer within 60000 ms');
    expect(page.querySelector('[data-testid=settings-model-error]')!.textContent).toContain('Ask again');
  });

  test('no agent: the model section says to choose one first', async () => {
    const calls: { url: string; body: unknown }[] = [];
    stub(calls, settings({ chosenAgent: null }));
    const page = into(createElement(SettingsPage, { version: 0, status: status(), refresh: () => undefined }));
    await until(() => page.querySelector('[data-testid=settings-model-none]') !== null, 'the note');
    expect(page.querySelector('[data-testid=danger-rewrite-open]')!.hasAttribute('disabled')).toBe(true);
  });

  test('both dangerous actions say they are local, name what goes, and only a confirm does it', async () => {
    const calls: { url: string; body: unknown }[] = [];
    stub(calls);
    const page = into(createElement(SettingsPage, { version: 0, status: status(), refresh: () => undefined }));
    await until(() => page.querySelector('[data-testid=danger-fresh-open]') !== null, 'the dangerous actions');
    expect(page.querySelector('[data-testid=settings-danger]')!.textContent).toContain('Local: only the product checkout at /products/sample-product on this machine changes.');
    (page.querySelector('[data-testid=danger-fresh-open]') as HTMLElement).click();
    await until(() => page.querySelector('[data-testid=danger-dialog]') !== null, 'the confirmation');
    const dialog = page.querySelector('[data-testid=danger-dialog]')!;
    expect(dialog.textContent).toContain('Nothing is committed or sent anywhere');
    expect(dialog.querySelector('[data-testid=danger-pages]')!.textContent).toContain('docs/product.md, docs/domains/payments.md');
    expect(dialog.querySelector('[data-testid=danger-agent-edits]')!.textContent).toContain('producer: person');
    expect(dialog.querySelector('[data-testid=danger-starter]')!.textContent).toContain('2 starter files');
    expect(dialog.querySelector('[data-testid=danger-edited]')!.textContent).toContain('templates/domain.md');
    expect(dialog.textContent).toContain('docs/domains/mine.md');
    expect(calls).toEqual([]);
    (dialog.querySelector('[data-testid=danger-confirm]') as HTMLElement).click();
    await until(() => calls.length === 1, 'the start from scratch');
    expect(calls[0]!.url).toContain('/api/k/start-fresh');
  });

  test('a fresh start whose fill could not start says why and stays', async () => {
    const calls: { url: string; body: unknown }[] = [];
    stub(calls);
    const plain = (globalThis as { fetch: (url: string, init?: RequestInit) => Promise<Response> }).fetch;
    (globalThis as { fetch?: unknown }).fetch = async (url: string, init?: RequestInit) => (url.endsWith('/api/k/start-fresh') ? json({ fillRefused: 'the repositories shop are not checked out' }) : plain(url, init));
    const page = into(createElement(SettingsPage, { version: 0, status: status(), refresh: () => undefined }));
    await until(() => page.querySelector('[data-testid=danger-fresh-open]') !== null, 'the button');
    (page.querySelector('[data-testid=danger-fresh-open]') as HTMLElement).click();
    await until(() => page.querySelector('[data-testid=danger-confirm]') !== null, 'the panel');
    (page.querySelector('[data-testid=danger-confirm]') as HTMLElement).click();
    await until(() => page.querySelector('[data-testid=danger-error]') !== null, 'the reason');
    expect(page.querySelector('[data-testid=danger-error]')!.textContent).toContain('the repositories shop are not checked out');
  });

  test('«Rewrite the pages» asks the rewrite route and does not mention the graph store', async () => {
    const calls: { url: string; body: unknown }[] = [];
    stub(calls);
    const page = into(createElement(SettingsPage, { version: 0, status: status(), refresh: () => undefined }));
    await until(() => page.querySelector('[data-testid=danger-rewrite-open]') !== null, 'the button');
    (page.querySelector('[data-testid=danger-rewrite-open]') as HTMLElement).click();
    await until(() => page.querySelector('[data-testid=danger-dialog]') !== null, 'the confirmation');
    const dialog = page.querySelector('[data-testid=danger-dialog]')!;
    expect(dialog.textContent).not.toContain('graph store');
    (dialog.querySelector('[data-testid=danger-confirm]') as HTMLElement).click();
    await until(() => calls.length === 1, 'the rewrite');
    expect(calls[0]!.url).toContain('/api/k/rewrite-pages');
  });

  test('the same page reads in Russian', async () => {
    await setWikiLanguage('ru');
    const calls: { url: string; body: unknown }[] = [];
    stub(calls);
    const page = into(createElement(SettingsPage, { version: 0, status: status(), refresh: () => undefined }));
    await until(() => page.querySelector('[data-testid=settings-model-select]') !== null, 'the model choice');
    expect(page.querySelector('h1')!.textContent).toBe('Настройки продукта');
    expect(page.querySelector('[data-testid=danger-fresh] h3')!.textContent).toBe('Начать с нуля');
    expect(page.querySelector('[data-testid=danger-rewrite] h3')!.textContent).toBe('Переписать страницы');
    expect(page.querySelector('[data-testid=settings-danger]')!.textContent).toContain('Локально: меняется только копия продукта в /products/sample-product на этой машине.');
  });
});

describe('the starter set on the Problems page', () => {
  test('lists what the set holds and the manifest lacks, each with «Add», and adds exactly the one pressed', async () => {
    const posted: unknown[] = [];
    (globalThis as { fetch?: unknown }).fetch = async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/k/starter')) { posted.push(JSON.parse(String(init!.body))); return json({ written: ['madarch/kinds.yaml'] }); }
      return json({ problems: [], open: 0, closed: 0, notes: [], starter: OFFERS });
    };
    const page = into(createElement(ProblemsPage, { version: 0 }));
    await until(() => page.querySelector('[data-testid=problems-starter]') !== null, 'the offers');
    expect(page.querySelector('[data-testid=problems-starter] h2')!.textContent).toBe('The starter set has 4 kinds and groups this manifest lacks.');
    expect(page.querySelector('[data-testid=starter-summary]')).toBeNull();
    expect(page.querySelectorAll('[data-testid=starter-offer]')).toHaveLength(0);
    expect(page.querySelector('[data-testid=starter-add-all]')!.textContent).toBe('Add all');
    (page.querySelector('[data-testid=starter-toggle]') as HTMLElement).click();
    await until(() => page.querySelectorAll('[data-testid=starter-offer]').length === 4, 'the expanded grouped offers');
    expect([...page.querySelectorAll('[data-testid=starter-group]')].map((row) => row.getAttribute('data-group'))).toEqual(['contracts', 'product']);
    expect(page.querySelector('[data-offer="kind:code.route"]')!.textContent).toContain('Kind: HTTP route (code.route)');
    expect(page.querySelector('[data-offer="kind:code.route"]')!.textContent).toContain('An HTTP route a service serves.');
    expect(page.querySelector('[data-testid=problems-empty]')).toBeNull();
    ((page.querySelector('[data-offer="kind:code.route"] [data-testid=starter-add]')) as HTMLElement).click();
    await until(() => posted.length === 1, 'the add');
    expect(posted[0]).toEqual({ ids: ['kind:code.route'] });
    await until(() => !(page.querySelector('[data-testid=starter-add-all]') as HTMLButtonElement).disabled, 'the add settled');
    ((page.querySelector('[data-testid=starter-add-all]')) as HTMLElement).click();
    await until(() => posted.length === 2, 'the add all');
    expect(posted[1]).toEqual({ ids: OFFERS.map((offer) => offer.id) });
  });

  test('in Russian the offer carries the Russian name and «Добавить»', async () => {
    await setWikiLanguage('ru');
    (globalThis as { fetch?: unknown }).fetch = async () => json({ problems: [], open: 0, closed: 0, notes: [], starter: OFFERS });
    const page = into(createElement(ProblemsPage, { version: 0 }));
    await until(() => page.querySelector('[data-testid=problems-starter]') !== null, 'the offers');
    expect(page.querySelector('[data-testid=starter-summary]')).toBeNull();
    (page.querySelector('[data-testid=starter-toggle]') as HTMLElement).click();
    await until(() => page.querySelectorAll('[data-testid=starter-offer]').length === 4, 'the expanded Russian offers');
    expect(page.querySelector('[data-offer="kind:code.route"]')!.textContent).toContain('Вид: HTTP-маршрут (code.route)');
    expect(page.querySelector('[data-offer="kind:code.route"] [data-testid=starter-add]')!.textContent).toBe('Добавить');
    expect(page.querySelector('[data-testid=problems-starter] h2')!.textContent).toBe('В стартовом наборе есть 4 видов и групп, которых нет в вашем манифесте.');
  });
});

describe('a failure is told once, in the reader\'s language', () => {
  const detail = 'src/knowledge/index/index.ts: the manifest of /p cannot be read\n  madarch/kinds.yaml:5: a\n  madarch/kinds.yaml:9: b';
  test('the headline is the app\'s own words, the engineer\'s lines are behind a link, and the Problems page is one click away', async () => {
    const note = into(createElement(FailureNote, { scope: 'writer', code: 'index', message: detail }));
    await until(() => note.querySelector('[data-testid=failure-note]') !== null, 'the note');
    expect(note.querySelector('[data-testid=failure-note] p')!.textContent).toBe('The pages were written, but they could not be added to the index.');
    expect(note.textContent).not.toContain('madarch/kinds.yaml:5');
    expect(note.querySelector('a')!.getAttribute('href')).toBe('/k/problems');
    (note.querySelector('[data-testid=failure-details]') as HTMLElement).click();
    await until(() => note.querySelector('[data-testid=failure-detail]') !== null, 'the detail');
    expect(note.querySelector('[data-testid=failure-detail]')!.textContent).toBe(detail);
  });

  test('in Russian the headline is Russian; a code the app has no words for shows the message as it is', async () => {
    await setWikiLanguage('ru');
    const note = into(createElement(FailureNote, { scope: 'writer', code: 'units', message: detail }));
    await until(() => note.querySelector('[data-testid=failure-note]') !== null, 'the note');
    expect(note.querySelector('[data-testid=failure-note] p')!.textContent).toBe('Часть страниц не написана. Список ниже говорит, почему, для каждой страницы.');
    expect(note.querySelector('a')!.textContent).toBe('Открыть «Проблемы»');
    rendered?.unmount();
    document.body.innerHTML = '';
    const plain = into(createElement(FailureNote, { scope: 'fill', code: 'unheard-of', message: 'something odd' }));
    await until(() => plain.querySelector('[data-testid=failure-message]') !== null, 'the message');
    expect(plain.textContent).toBe('something odd');
  });
});

describe('where the settings are and where the progress is', () => {
  test('the route /k/settings is the settings page', () => {
    expect(kRouteOf('/k/settings')).toEqual({ name: 'settings' });
    expect(kRouteOf('/products/shop/k/settings/')).toEqual({ name: 'settings' });
  });

  test('the fill\'s card is drawn above the product\'s page and an entity, and above no other page', () => {
    const filled = status({ home: 'product:shop' });
    expect(showsProgress({ name: 'home' }, filled)).toBe(true);
    expect(showsProgress({ name: 'entity', id: 'domain:x' }, filled)).toBe(true);
    expect(showsProgress({ name: 'home' }, status({ home: null }))).toBe(false);
    for (const route of [{ name: 'catalogue' }, { name: 'glossary' }, { name: 'statement', id: 'a', sentence: 'b', turn: 0 }, { name: 'kind', kind: 'domain' }, { name: 'problems' }, { name: 'settings' }, { name: 'docs' }] as const) {
      expect(showsProgress(route, filled)).toBe(false);
    }
  });

  test('the bottom of the sidebar links to the settings, counts actual problems but not starter offers, and removes «Start over»', async () => {
    (globalThis as { fetch?: unknown }).fetch = async (url: string) => {
      if (url.endsWith('/api/k/status')) return json(status({ starterOffers: 56, loop: { questionsOpen: 0, questionsAnswered: 0, correctionsOpen: 4 } }));
      if (url.endsWith('/api/k/products')) return json({ products: [{ name: 'shop', folder: 'shop' }] });
      if (url.endsWith('/api/k/agents')) return json({ agents: [], chosen: null });
      if (url.endsWith('/api/k/settings')) return json({ role: 'everything', asked: true, roles: [] });
      if (url.endsWith('/api/k/glossary')) return json({ terms: [], resolutions: {}, findings: [] });
      return json({ message: 'not here' }, 404);
    };
    window.history.replaceState({}, '', '/k');
    const app = into(createElement(AppRoot));
    await until(() => app.querySelector('[data-testid=nav-settings]') !== null, 'the settings link');
    expect(app.querySelector('[data-testid=nav-settings]')!.getAttribute('href')).toBe('/k/settings');
    expect(app.querySelector('[data-testid=nav-settings]')!.textContent).toBe('Product settings');
    expect(app.querySelector('[data-testid=start-over]')).toBeNull();
    expect(app.querySelector('[data-testid=nav-problems-count]')!.textContent).toBe('4');
  });
});
