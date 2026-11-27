import { afterAll, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { SectionContext } from './types.js';

GlobalRegistrator.register({ url: 'http://localhost/' });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { setWikiLanguage } = await import('../i18n.js');
const { AuthoredSection } = await import('./authored.js');

beforeAll(async () => { await setWikiLanguage('en'); });
afterAll(() => { GlobalRegistrator.unregister(); });

const existing = {
  id: 'note-uid', kind: 'note', label: 'Original', revision: '41', details: [
    { name: 'key', type: 'text', key: true, value: 'N-1' },
    { name: 'title', type: 'text', key: false, value: 'Original' },
    { name: 'description', type: 'text', key: false, value: null },
  ],
};

function context(mode: 'create' | 'edit', data: unknown, authored: boolean, opened: string[]): SectionContext {
  return {
    section: { id: 'authored', alias: 'authored', component: 'authored', params: { mode }, on: 'subject', replace: false, line: 1 },
    data, language: 'en', base: '/products/sample', busy: false, variables: {}, reload: () => {},
    open: (address) => { opened.push(address); }, renderSection: () => null, product: 'Sample', pageName: null,
    navigation: { product: 'Sample', groups: [], purposes: [], kinds: [
      { kind: 'note', one: 'Note', many: 'Notes', definition: null, authored, taken: true, group: null, nav: null, count: 1, entryId: 'kind-uid', purpose: null, audience: null },
    ] },
  };
}

function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const fetchBefore = globalThis.fetch;
  const field = (name: string): HTMLInputElement | HTMLTextAreaElement => {
    const label = [...container.querySelectorAll('label')].find((item) => item.textContent?.replace(' *', '') === name);
    return document.getElementById(label!.htmlFor) as HTMLInputElement | HTMLTextAreaElement;
  };
  return {
    container,
    field,
    button: (name: string) => [...container.querySelectorAll('button')].find((item) => item.textContent === name),
    render: (props: SectionContext) => act(async () => { root.render(<AuthoredSection context={props} />); }),
    click: async (button: HTMLButtonElement) => { await act(async () => { button.click(); }); },
    type: async (name: string, value: string) => {
      const control = field(name);
      await act(async () => {
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), 'value')!.set!.call(control, value);
        control.dispatchEvent(new Event('input', { bubbles: true }));
      });
    },
    close: async () => { globalThis.fetch = fetchBefore; await act(async () => { root.unmount(); }); container.remove(); },
  };
}

test('authored creation places validation on the field and sends only supplied values', async () => {
  const view = mount();
  const opened: string[] = [];
  const calls: unknown[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const values = JSON.parse(String(init.body)) as { values: Record<string, unknown> };
    calls.push({ url, method: init.method, ...values });
    if (values.values['count'] !== undefined) {
      return Response.json({ error: { code: 'SCHEMA_INVALID', path: '/values/count', expected: 'integer', actual: 99999999999, retryable: false } }, { status: 400 });
    }
    return Response.json({ entity: { uid: 'new-uid' } }, { status: 201 });
  }) as typeof fetch;
  const data = { name: 'note', fields: [
    { name: 'title', type: 'text', nullable: false }, { name: 'count', type: 'integer', nullable: true },
  ] };
  try {
    await view.render(context('create', data, false, opened));
    expect(view.button('New')).toBeUndefined();
    await view.render(context('create', data, true, opened));
    await view.click(view.button('New')!);
    await view.click(view.button('Save')!);
    expect(view.field('title').getAttribute('aria-invalid')).toBe('true');
    expect(calls).toEqual([]);
    await view.type('title', 'New note');
    await view.type('count', '99999999999');
    await view.click(view.button('Save')!);
    expect(view.field('count').getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(view.field('count').getAttribute('aria-describedby')!)?.textContent).toContain('/values/count');
    await view.type('count', '');
    await view.click(view.button('Save')!);
    expect(calls).toEqual([
      { url: '/products/sample/api/authored?kind=note', method: 'POST', values: { title: 'New note', count: 99999999999 } },
      { url: '/products/sample/api/authored?kind=note', method: 'POST', values: { title: 'New note' } },
    ]);
    expect(opened).toEqual(['/e/note/new-uid']);
  } finally {
    await view.close();
  }
});

test('an open editor retains its old revision and reloading a conflict keeps the other draft', async () => {
  const view = mount();
  const calls: unknown[] = [];
  const concurrent = { ...existing, revision: '42', details: existing.details.map((field) => field.name === 'title' ? { ...field, value: 'Other author' } : field) };
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (url.endsWith('/graphql')) return Response.json({ data: { entity: concurrent } });
    const revision = new Headers(init.headers).get('if-match');
    calls.push({ revision, ...JSON.parse(String(init.body)) });
    if (revision === '"41"') return Response.json({ error: { message: 'Conflict', field: 'title', conflict: { field: 'title', current: 'Other author', author: 'person-uid' } } }, { status: 412 });
    return Response.json({ entity: { uid: existing.id } });
  }) as typeof fetch;
  try {
    await view.render(context('edit', existing, true, []));
    await view.click(view.button('Edit')!);
    expect(view.field('key').readOnly).toBe(true);
    await view.type('title', 'My title');
    await view.type('description', 'My description');
    await view.render(context('edit', concurrent, true, []));
    await view.click(view.button('Save')!);
    expect(view.field('title').getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(view.field('title').getAttribute('aria-describedby')!)?.textContent).toContain('Other author');
    await view.click(view.button('Reload')!);
    expect(view.field('title').value).toBe('Other author');
    expect(view.field('description').value).toBe('My description');
    await view.click(view.button('Save')!);
    expect(calls).toEqual([
      { revision: '"41"', values: { title: 'My title', description: 'My description' } },
      { revision: '"42"', values: { description: 'My description' } },
    ]);
  } finally {
    await view.close();
  }
});

test('delete needs confirmation and refuses to retry a stale revision until reloaded', async () => {
  const view = mount();
  const opened: string[] = [];
  const revisions: (string | null)[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    expect(init.method).toBe('DELETE');
    const revision = new Headers(init.headers).get('if-match');
    revisions.push(revision);
    return revision === '"41"'
      ? Response.json({ error: { message: 'Record changed' } }, { status: 412 })
      : Response.json({ entity: { uid: existing.id } });
  }) as typeof fetch;
  try {
    await view.render(context('edit', existing, true, opened));
    await view.click(view.button('Delete')!);
    expect(revisions).toEqual([]);
    await view.render(context('edit', { ...existing, revision: '42' }, true, opened));
    await view.click(view.button('Delete entity')!);
    expect(opened).toEqual([]);
    expect(view.button('Delete entity')).toBeUndefined();
    await view.click(view.button('Reload')!);
    await view.click(view.button('Delete')!);
    await view.click(view.button('Delete entity')!);
    expect(revisions).toEqual(['"41"', '"42"']);
    expect(opened).toEqual(['/e/catalogue/kind-uid']);
  } finally {
    await view.close();
  }
});
