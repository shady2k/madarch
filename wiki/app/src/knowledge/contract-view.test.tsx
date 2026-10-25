import {afterAll, afterEach, beforeAll, expect, test} from 'bun:test';
import {GlobalRegistrator} from '@happy-dom/global-registrator';
import {createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {BlockView} from './blocks.js';
import {Operations} from './operations.js';
import {setWikiLanguage} from '../i18n.js';
import type {EntityRef} from './types.js';
const originalFetch = globalThis.fetch;
let root: Root | undefined;
beforeAll(async () => {GlobalRegistrator.register({url: 'http://localhost/'}); await setWikiLanguage('en');});
afterEach(() => {root?.unmount(); root = undefined; document.body.innerHTML = ''; globalThis.fetch = originalFetch;});
afterAll(async () => {
  // React schedules passive cleanup after unmount; keep the DOM until that turn has run.
  await new Promise((done) => setTimeout(done, 50));
  GlobalRegistrator.unregister();
});
async function until(condition: () => boolean): Promise<void> {const end = Date.now() + 2000; while (!condition()) {if (Date.now() > end) throw new Error('contract-view.test.tsx:14: expected UI did not arrive'); await new Promise((done) => setTimeout(done, 10));}}
function mount(element: ReturnType<typeof createElement>): HTMLElement {const node = document.createElement('div'); document.body.append(node); root = createRoot(node); root.render(element); return node;}
test('Definition requests neither bytes nor renderer until the reader opens it', async () => {
  let requests = 0;
  globalThis.fetch = Object.assign(async () => {requests++; return new Response(JSON.stringify({type: 'problem', block: 'definition', file: 'api.yaml', line: 1, message: 'fixture refusal'}), {headers: {'content-type': 'application/json'}});}, {preconnect: originalFetch.preconnect});
  const node = mount(createElement(BlockView, {pageId: 'code.contract:api.yaml', resolutions: {}, block: {type: 'deferred', block: 'definition', title: 'Definition', line: 2}}));
  await until(() => node.querySelector('details') !== null);
  expect(requests).toBe(0); expect(node.querySelector('[data-testid=contract-redoc]')).toBeNull();
  const details = node.querySelector('details')!; details.open = true; details.dispatchEvent(new Event('toggle'));
  await until(() => requests === 1); await until(() => node.textContent?.includes('fixture refusal') === true);
});
test('grouped catalogue preserves every owned and unowned row and both language labels', async () => {
  const row = (id: string): EntityRef => ({id, label: id, kind: 'code.operation', href: null});
  for (const language of ['en', 'ru'] as const) {
    await setWikiLanguage(language);
    const rows = [row('first'), row('second'), row('unowned')];
    const contract: EntityRef = {id: 'code.contract:api.yaml', label: 'Catalogue API', kind: 'code.contract', href: null};
    const node = mount(createElement(Operations, {rows, metadata: {first: {contracts: [{entity: contract, protocol: 'OpenAPI'}], implementedBy: [], calledBy: [], cuts: []}, second: {contracts: [{entity: contract, protocol: 'OpenAPI'}], implementedBy: [], calledBy: [], cuts: []}}}));
    await until(() => node.querySelectorAll('[data-entity]').length === 3);
    expect(node.textContent).toContain(language === 'ru' ? 'Объявляющий контракт не найден' : 'No declaring contract');
    expect(node.textContent).toContain(language === 'ru' ? 'Реализуют' : 'Implemented by');
    expect(node.querySelectorAll('h2')).toHaveLength(2);
    root?.unmount(); root = undefined; node.remove();
  }
});
