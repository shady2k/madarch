import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setWikiLanguage } from '../i18n.js';
import { AuthoredForm, AuthoredKindPage, AuthoredPage } from './authored.js';
import { KindPage, EntityPage } from './pages.js';
import { KindLabels } from './kind-names.js';
import type { KindSummary } from './types.js';
import { AuthoredError, writeAuthored } from './authored-api.js';
import { wikiRouteOf } from './routes.js';
import { resetPreferences, resetTabs } from '../../test/reset.js';

beforeAll(async () => { GlobalRegistrator.register({ url: 'http://localhost/' }); await setWikiLanguage('en'); });
afterAll(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); GlobalRegistrator.unregister(); });
let root: Root | undefined;
const originalFetch = globalThis.fetch;
afterEach(() => { root?.unmount(); root = undefined; document.body.innerHTML = ''; globalThis.fetch = originalFetch; window.history.replaceState({}, '', '/'); window.sessionStorage.clear(); window.localStorage.clear(); resetTabs(); resetPreferences(); });
function mount(element: ReturnType<typeof createElement>): void { const div = document.createElement('div'); document.body.appendChild(div); root = createRoot(div); root.render(element); }
async function until(predicate: () => boolean): Promise<void> { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error(document.body.innerHTML); }
const fields = [{ name: 'title', type: 'text', nullable: true }, { name: 'enabled', type: 'boolean', nullable: true }, { name: 'data', type: 'json', nullable: true }];
const entity = { id: 'note:u1', uid: 'u1', revision: '10', values: { title: 'A note', enabled: false, data: { count: 3 } } };
function respond(body: unknown, status = 200): Response { return Response.json(body, { status }); }

test('the manifest contract makes fields, preserves false and nested values, and renders a server refusal beside its field', async () => {
  let sent: unknown;
  globalThis.fetch = (async (_url: unknown, options?: RequestInit) => {
    if (options?.method === 'PATCH') { sent = JSON.parse(String(options.body)); return respond({ field: 'title', message: 'Title refused' }, 400); }
    return respond({ kind: 'note', fields });
  }) as unknown as typeof fetch;
  mount(createElement(AuthoredForm, { kind: 'note', entity, saved: () => {}, cancel: () => {} }));
  await until(() => document.querySelector('#authored-field-data') !== null);
  expect((document.querySelector('#authored-field-enabled') as HTMLSelectElement).value).toBe('false');
  document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await until(() => document.querySelector('#authored-field-title-error') !== null);
  expect(sent).toEqual({ values: {} });
  expect(document.querySelector('#authored-field-title')!.getAttribute('aria-invalid')).toBe('true');
  expect(document.querySelector('#authored-field-title-error')!.textContent).toBe('Title refused');
});

test('list links use persistent uid and offer New', async () => {
  globalThis.fetch = (async () => respond({ kind: 'note', fields, entities: [entity] })) as unknown as typeof fetch;
  mount(createElement(AuthoredKindPage, { kind: 'note', version: 0 }));
  await until(() => document.querySelector('li a') !== null);
  expect(document.querySelector('li a')!.getAttribute('href')).toBe('/authored?kind=note&uid=u1');
  expect([...document.querySelectorAll('button')].some((button) => button.textContent === 'New')).toBe(true);
  expect(wikiRouteOf('/authored', '?kind=note&uid=u1')).toEqual({ name: 'authored', kind: 'note', uid: 'u1' });
});

test('delete sends nothing until confirmed; cancel keeps the entity; confirmed deletion returns to list', async () => {
  let deletes = 0;
  globalThis.fetch = (async (_url: unknown, options?: RequestInit) => { if (options?.method === 'DELETE') { deletes++; expect(JSON.parse(String(options.body))).toEqual({ confirm: true }); } return respond({ kind: 'note', fields, entity }); }) as unknown as typeof fetch;
  mount(createElement(AuthoredPage, { kind: 'note', uid: 'u1', version: 0 }));
  await until(() => [...document.querySelectorAll('button')].some((button) => button.textContent === 'Delete'));
  const click = (text: string): void => [...document.querySelectorAll('button')].find((button) => button.textContent === text)!.click();
  click('Delete');
  await until(() => document.querySelector('[role="alertdialog"]') !== null);
  expect(deletes).toBe(0);
  click('Cancel');
  await until(() => document.querySelector('[role="alertdialog"]') === null);
  click('Delete');
  await until(() => document.querySelector('[role="alertdialog"]') !== null);
  click('Delete entity');
  await until(() => document.body.textContent!.includes('Entity deleted'));
  expect(deletes).toBe(1);
});

test('API preserves field diagnostics on a create refusal', async () => {
  globalThis.fetch = (async () => respond({ message: 'Invalid value', error: { field: 'data', message: 'Invalid value' } }, 400)) as unknown as typeof fetch;
  try { await writeAuthored('note', 'POST', undefined, { data: [] }); throw new Error('accepted'); }
  catch (error) { expect(error).toBeInstanceOf(AuthoredError); expect((error as AuthoredError).field).toBe('data'); }
});

test('delete confirmation and controls are available in Russian too', async () => {
  await setWikiLanguage('ru');
  globalThis.fetch = (async () => respond({ kind: 'custom.memo', fields, entity })) as unknown as typeof fetch;
  mount(createElement(AuthoredPage, { kind: 'custom.memo', uid: 'u1', version: 0 }));
  await until(() => [...document.querySelectorAll('button')].some((button) => button.textContent === 'Удалить'));
  [...document.querySelectorAll('button')].find((button) => button.textContent === 'Удалить')!.click();
  await until(() => document.querySelector('[role="alertdialog"]') !== null);
  expect(document.querySelector('[role="alertdialog"]')!.textContent).toContain('Открытые мнения');
  await setWikiLanguage('en');
});

test('person origin routes custom kinds to authored lists and entity reads', async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (url: unknown) => { calls.push(String(url)); return respond({ kind: 'custom.memo', fields, entity, entities: [entity] }); }) as unknown as typeof fetch;
  const kinds: KindSummary[] = [{ kind: 'custom.memo', source: 'graph', count: 1, single: false, origins: ['person'] }];
  mount(createElement(KindLabels.Provider, { value: kinds }, createElement(KindPage, { kind: 'custom.memo', version: 0 })));
  await until(() => document.querySelector('li a') !== null);
  expect(calls.some((url) => url.includes('/api/authored?kind=custom.memo'))).toBe(true);
  root!.render(createElement(KindLabels.Provider, { value: kinds }, createElement(EntityPage, { id: 'custom.memo:u1', version: 0 })));
  await until(() => document.querySelector('[data-testid="authored-page"] h1') !== null);
  expect(calls.some((url) => url.includes('uid=u1'))).toBe(true);
});

async function changeField(name: string, value: string): Promise<void> {
  const input = document.querySelector(`#authored-field-${name}`) as HTMLTextAreaElement;
  input.focus();
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  input.dispatchEvent(new window.KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('Alice saves only her changed body with the loaded revision after Bob changes the title', async () => {
  const loaded = { id: 'note:u1', uid: 'u1', revision: '10', values: { title: 'Old title', body: 'Old body' } };
  let sent: unknown;
  const headers = { match: null as string | null };
  let saved = false;
  globalThis.fetch = (async (_url: unknown, options?: RequestInit) => {
    if (options?.method === 'PATCH') {
      sent = JSON.parse(String(options.body)); headers.match = new Headers(options.headers).get('if-match');
      return respond({ kind: 'note', fields: [], entity: { ...loaded, revision: '12', values: { title: 'Bob title', body: 'Alice body' } } });
    }
    return respond({ kind: 'note', fields: [{ name: 'title', type: 'text' }, { name: 'body', type: 'text' }] });
  }) as unknown as typeof fetch;
  mount(createElement(AuthoredForm, { kind: 'note', entity: loaded, saved: () => { saved = true; }, cancel: () => {} }));
  await until(() => document.querySelector('#authored-field-body') !== null);
  await changeField('body', 'Alice body');
  await until(() => (document.querySelector('#authored-field-body') as HTMLTextAreaElement).value === 'Alice body');
  document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await until(() => saved);
  expect(sent).toEqual({ values: { body: 'Alice body' } });
  expect(headers.match).toBe('"10"');
});

test('conflict names the field, current value and author; Reload fetches latest values and revision', async () => {
  const loaded = { id: 'note:u1', uid: 'u1', revision: '10', values: { title: 'Old title', body: 'Old body' } };
  const fields = [{ name: 'title', type: 'text' }, { name: 'body', type: 'text' }];
  let reads = 0;
  const patches: { values: unknown; match: string | null }[] = [];
  globalThis.fetch = (async (url: unknown, options?: RequestInit) => {
    if (options?.method === 'PATCH') {
      patches.push({ values: JSON.parse(String(options.body)).values, match: new Headers(options.headers).get('if-match') });
      if (patches.length === 1) return respond({ error: { message: 'Entity changed', field: 'title', conflict: { field: 'title', current: 'Bob title', author: 'Bob' } } }, 412);
      return respond({ kind: 'note', fields, entity: loaded });
    }
    if (String(url).includes('/api/authored?')) { reads++; return respond({ kind: 'note', fields, entity: { ...loaded, revision: '11', values: { title: 'Bob title', body: 'Old body' } } }); }
    return respond({ kind: 'note', fields });
  }) as unknown as typeof fetch;
  mount(createElement(AuthoredForm, { kind: 'note', entity: loaded, saved: () => {}, cancel: () => {} }));
  await until(() => document.querySelector('#authored-field-body') !== null);
  await changeField('body', 'Alice body');
  document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await until(() => document.querySelector('#authored-field-title-error') !== null);
  expect(document.querySelector('#authored-field-title-error')!.textContent).toContain('Bob title');
  expect(document.querySelector('#authored-field-title-error')!.textContent).toContain('Bob');
  const reload = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Reload');
  expect(reload).toBeDefined(); reload!.click();
  await until(() => (document.querySelector('#authored-field-title') as HTMLTextAreaElement).value === 'Bob title');
  expect(reads).toBe(1);
  expect((document.querySelector('#authored-field-body') as HTMLTextAreaElement).value).toBe('Old body');
  expect(document.querySelector('#authored-field-title-error')).toBeNull();
  await changeField('body', 'Alice revised body');
  document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await until(() => patches.length === 2);
  expect(patches[1]).toEqual({ values: { body: 'Alice revised body' }, match: '"11"' });
});
