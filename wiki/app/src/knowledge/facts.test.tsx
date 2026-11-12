import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createRoot, type Root } from 'react-dom/client';
import { FactsHome } from './facts.js';
import { StatementPage } from './pages.js';
import { RoleContext } from './roles.js';
import { setWikiLanguage } from '../i18n.js';
import type { FactsView, FactStatement } from './types.js';

let rendered: Root;
let host: HTMLElement;
const originalFetch = globalThis.fetch;
beforeAll(async () => { GlobalRegistrator.register({ url: 'http://localhost/' }); await setWikiLanguage('en'); });
afterEach(() => { rendered?.unmount(); document.body.innerHTML = ''; globalThis.fetch = originalFetch; });
afterAll(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); GlobalRegistrator.unregister(); });
async function until(holds: () => boolean): Promise<void> {
  for (let n = 0; n < 100; n++) { if (holds()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error(`facts did not render: ${host.innerHTML}`);
}
function render(role = 'developer', version = 1): void {
  if (!host?.isConnected) { host = document.createElement('div'); document.body.appendChild(host); rendered = createRoot(host); }
  rendered.render(<RoleContext.Provider value={{ role, roles: {} }}><FactsHome title="Training product" version={version} /></RoleContext.Provider>);
}
function fixture(): FactsView {
  const facts = ['number', 'bar', 'treemap', 'timeline'].map((display, index): FactStatement => ({
    id: `fact:module/f${index}`, label: `Fact ${index}`, display: display as FactStatement['display'], measure: 'count', value: index === 0 ? 0 : null,
    rows: [{ label: 'Visible row', value: 3, entity: 'module:a' }, { label: 'Other row', value: 0 }],
    ground: { value: 0, rows: [], kind: 'module', measure: 'count', field: 'age', buckets: [7, 30], limit: 2, total: 3, missing: 1, entities: ['module:a'], computedAt: '2026-11-12T00:00:00Z' },
    statement: { page: { id: `fact:module/f${index}`, kind: 'module', label: `Fact ${index}`, href: '/kind/module' }, name: `f${index}`, sentence: `Fact ${index}`, paragraph: '', file: '/fixture/kinds.yaml', line: 2, grounded: true, grounds: [], relying: [], resolutions: {} },
  }));
  return { role: 'developer', kinds: [{ kind: 'module', label: 'Modules', statements: facts }, { kind: 'task', label: 'Tasks', statements: [] }] };
}
test('home keeps manifest order, all four displays, zero, linked statements and complete grounds', async () => {
  globalThis.fetch = (async () => Response.json(fixture())) as unknown as typeof fetch;
  render(); await until(() => host.querySelectorAll('[data-testid=home-fact]').length === 4);
  expect([...host.querySelectorAll('h2')].map((node) => node.textContent)).toEqual(['Modules', 'Tasks']);
  expect(host.querySelector('[data-testid=fact-number]')?.textContent).toBe('0');
  expect([...host.querySelectorAll('[data-display]')].map((node) => node.getAttribute('data-display'))).toEqual(['bar', 'treemap', 'timeline']);
  expect(host.querySelectorAll('tbody tr').length).toBe(6);
  const statement = host.querySelector('a')!;
  expect(new URL(statement.href).searchParams.get('id')).toBe('fact:module/f0');
  expect(host.textContent).toContain('Missing values');
  expect(host.textContent).toContain('2026-11-12T00:00:00Z');
  expect(host.querySelector('a[href="/e/module%3Aa"]')).not.toBeNull();
});
test('role and version changes reread facts; empty and failed reads are explicit', async () => {
  let requests = 0;
  globalThis.fetch = (async () => { requests++; return Response.json({ role: 'developer', kinds: [] }); }) as unknown as typeof fetch;
  render(); await until(() => host.querySelector('[data-testid=facts-empty]') !== null);
  render('product'); await until(() => requests === 2);
  render('product', 2); await until(() => requests === 3);
  globalThis.fetch = (async () => Response.json({ message: '/fixture/kinds.yaml:4: invalid fact' }, { status: 500 })) as unknown as typeof fetch;
  render('tester'); await until(() => host.querySelector('[data-testid=facts-error]') !== null);
  expect(host.textContent).toContain('/fixture/kinds.yaml:4: invalid fact');
});

test('a fact statement exposes query inputs, result and all contributing entity links', async () => {
  const fact = fixture().kinds[0]!.statements[0]!;
  fact.statement.aggregate = { ...fact.ground, value: null, rows: [{ label: 'TypeScript', value: 3, entity: 'module:a' }] };
  await setWikiLanguage('ru');
  let asked = '';
  globalThis.fetch = (async (url: string | URL | Request) => { asked = String(url); return Response.json(fact.statement); }) as unknown as typeof fetch;
  host = document.createElement('div'); document.body.appendChild(host); rendered = createRoot(host);
  rendered.render(<StatementPage id={fact.id} sentence={fact.label} version={1} />);
  await until(() => host.querySelector('[data-testid=statement-aggregate]') !== null);
  const aggregate = host.querySelector('[data-testid=statement-aggregate]')!;
  expect(new URL(asked, 'http://localhost').searchParams.get('lang')).toBe('ru');
  await setWikiLanguage('en');
  expect(aggregate.textContent).toContain('TypeScript: 3');
  expect(aggregate.textContent).toContain('[7,30]');
  expect(aggregate.querySelectorAll('a[href="/e/module%3Aa"]').length).toBe(2);
});
