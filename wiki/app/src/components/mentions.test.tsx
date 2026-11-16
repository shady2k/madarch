/**
 * Decision 0039 items 5, 6 and 29: an entity page's unlinked names. A plain name stands once with every entity it may
 * mean — a same-named entity of another kind is another candidate, named with its kind — and one press links the name
 * the reader chose at exactly the span the page showed.
 */
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register({ url: 'http://localhost/' });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MentionsSection } = await import('./mentions.js');
const { MentionsInSection } = await import('./mentions-in.js');
const { TooltipProvider } = await import('./ui/tooltip.js');
const { setWikiLanguage } = await import('../i18n.js');
import type { SectionContext } from './types.js';

afterAll(() => { GlobalRegistrator.unregister(); });

const requests: { path: string; method: string; body: unknown }[] = [];
let reloaded = 0;

const MENTIONS = {
  id: '019a0000-0000-7000-8000-0000000000aa', kind: 'demo.note',
  unlinkedMentions: [{
  uid: '019a0000-0000-7000-8000-0000000000aa', kind: 'demo.note', label: '',
  field: 'body', path: '/body', start: 6, end: 14, name: 'Payments',
  candidates: [
    { uid: '019a0000-0000-7000-8000-000000000001', kind: 'demo.domain', kindLabel: 'Domain', label: 'Payments', domain: '' },
    { uid: '019a0000-0000-7000-8000-000000000002', kind: 'demo.subsystem', kindLabel: 'Subsystem', label: 'Payments', domain: '' },
  ],
  }],
};

function context(data: unknown, path?: string, component: 'mentions' | 'mentions-in' = 'mentions'): SectionContext {
  return {
    section: { id: 'mentions', component, on: 'subject', replace: false, params: path === undefined ? {} : { path }, line: 1, alias: 's_mentions', title: { en: 'Mentions without a link', ru: 'Упоминания без ссылки' } } as unknown as SectionContext['section'],
    data,
    language: 'ru',
    base: '',
    busy: false,
    variables: { id: '019a0000-0000-7000-8000-0000000000aa' },
    open: () => undefined,
    reload: () => { reloaded += 1; },
    renderSection: () => null,
    product: 'Portal',
    navigation: null,
    pageName: null,
  };
}

async function settle(): Promise<void> {
  for (let at = 0; at < 12; at += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
}

async function render(data: unknown, path?: string, component: 'mentions' | 'mentions-in' = 'mentions'): Promise<{ container: HTMLElement; close: () => Promise<void> }> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(TooltipProvider, null, createElement(component === 'mentions' ? MentionsSection : MentionsInSection, { context: context(data, path, component) }))); });
  await settle();
  return { container, close: async () => { await act(async () => { root.unmount(); }); container.remove(); } };
}

beforeEach(async () => {
  requests.length = 0;
  reloaded = 0;
  await setWikiLanguage('ru');
  (globalThis as { fetch: typeof fetch }).fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    requests.push({ path: url.pathname, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined });
    return new Response(JSON.stringify({ data: { linkMention: { kind: 'demo.note', uid: '019a0000-0000-7000-8000-0000000000aa', field: 'body', text: 'Only [[uid:x]] stands' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
});

test('a name of two kinds stands once with both candidates, each named with its kind', async () => {
  const page = await render(MENTIONS);
  try {
    expect(page.container.querySelectorAll('[data-testid="unlinked-mention"]').length).toBe(1);
    const buttons = [...page.container.querySelectorAll('[data-testid="unlinked-mention-link"]')].map((one) => one.textContent);
    expect(buttons).toEqual(['Payments — Domain', 'Payments — Subsystem']);
  } finally { await page.close(); }
});

test('the press links the span the page showed, as this person’s statement', async () => {
  const page = await render(MENTIONS);
  try {
    const second = page.container.querySelectorAll<HTMLButtonElement>('[data-testid="unlinked-mention-link"]')[1]!;
    await act(async () => { second.click(); });
    await settle();
    expect(requests.map((one) => one.path)).toEqual(['/graphql']);
    expect(requests[0]!.method).toBe('POST');
    const sent = requests[0]!.body as { query: string; variables: Record<string, unknown> };
    expect(sent.query).toContain('mutation LinkMention');
    expect(sent.variables).toEqual({
      kind: 'demo.note', id: '019a0000-0000-7000-8000-0000000000aa', field: 'body', path: '/body',
      start: 6, end: 14, name: 'Payments', entity: '019a0000-0000-7000-8000-000000000002',
    });
    expect(reloaded).toBe(1);
  } finally { await page.close(); }
});

test('a name another page holds links there, and the press writes that page', async () => {
  const page = await render({
    id: '019a0000-0000-7000-8000-0000000000aa', kind: 'demo.repository',
    unlinkedMentionPages: [{
      uid: '019a0000-0000-7000-8000-0000000000bb', kind: 'demo.note', label: 'A citing note',
      field: 'body', path: '/body', start: 4, end: 12, name: 'Payments',
      candidates: [{ uid: '019a0000-0000-7000-8000-0000000000aa', kind: 'demo.repository', kindLabel: 'Repository', label: 'Payments', domain: '' }],
    }],
  }, 'unlinkedMentionPages');
  try {
    expect(page.container.querySelectorAll('[data-testid="unlinked-mention-page"]').length).toBe(1);
    expect(page.container.querySelector('[data-testid="unlinked-mention-page"]')?.textContent).toBe('A citing note');
    const button = page.container.querySelector<HTMLButtonElement>('[data-testid="unlinked-mention-link"]')!;
    await act(async () => { button.click(); });
    await settle();
    const sent = requests[0]!.body as { variables: Record<string, unknown> };
    // The write stands in the page that holds the name, not on the page the reader is reading.
    expect(sent.variables).toMatchObject({ kind: 'demo.note', id: '019a0000-0000-7000-8000-0000000000bb', start: 4, end: 12 });
  } finally { await page.close(); }
});

test('every page whose text mentions the entity stands with its field and a link', async () => {
  const page = await render({
    id: '019a0000-0000-7000-8000-0000000000aa', kind: 'demo.repository',
    mentionedIn: [
      { entity: { id: '019a0000-0000-7000-8000-0000000000bb', kind: 'demo.note', label: 'A citing note' }, field: 'body', path: '/values/body', start: 4, end: 12 },
      { entity: { id: '019a0000-0000-7000-8000-0000000000cc', kind: 'demo.beta', label: 'A glossary term' }, field: 'title', path: '/values/title', start: 0, end: 8 },
    ],
  }, undefined, 'mentions-in');
  try {
    const rows = [...page.container.querySelectorAll('[data-testid="mention-page"]')];
    expect(rows.map((one) => one.textContent)).toEqual(['A citing notebody', 'A glossary termtitle']);
    expect(rows.map((one) => one.getAttribute('data-field'))).toEqual(['body', 'title']);
    expect(page.container.querySelectorAll('[data-testid="mention-page"] a').length).toBe(2);
  } finally { await page.close(); }
});

test('a text whose names are all linked draws no name and no Button', async () => {
  const page = await render({ id: '019a0000-0000-7000-8000-0000000000aa', kind: 'demo.note', unlinkedMentions: [] });
  try {
    expect(page.container.querySelectorAll('[data-testid="unlinked-mention"]').length).toBe(0);
    expect(page.container.querySelectorAll('[data-testid="unlinked-mention-link"]').length).toBe(0);
  } finally { await page.close(); }
});
