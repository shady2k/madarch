import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setWikiLanguage } from '../i18n.js';
import { KindGraph, graphLayers, graphStateOf, relatedKinds } from './kind-graph.js';
import { localeKeyIn, renderedText } from '../../test/locale-keys.js';
import type { CatalogKindView, CatalogView } from './types.js';

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  await setWikiLanguage('en');
});

afterAll(async () => {
  await new Promise((rest) => setTimeout(rest, 50));
  GlobalRegistrator.unregister();
});

let rendered: Root | undefined;

async function until(holds: () => boolean | undefined, what: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (holds()) return;
    await new Promise((step) => setTimeout(step, 10));
  }
  throw new Error(`never came to ${what}: ${document.body.innerHTML.replace(/ class="[^"]*"/gu, '').slice(-2000)}`);
}

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = '';
  delete (globalThis as { fetch?: unknown }).fetch;
});

const kind = (over: Partial<CatalogKindView> & Pick<CatalogKindView, 'kind'>): CatalogKindView => ({
  area: 'code', subgroup: '', count: 0, page: true, filled: true, state: 'filled',
  estimate: { volume: 0, unit: 'vertices', tokensPerUnit: null, secondsPerUnit: null, tokens: null, seconds: null },
  ...over,
});

const CATALOG: CatalogView = {
  product: { name: 'shop', id: 'p1' }, language: 'en', groups: [], findings: [],
  kinds: [
    kind({ kind: 'code.file', count: 12, labels: { en: { one: 'File', many: 'Files' } }, plugins: ['files'] }),
    kind({ kind: 'doc.term', count: 3, state: 'partial', dependsOn: ['code.file'], plugins: ['glossary'], labels: { en: { one: 'Term', many: 'Terms' } } }),
    kind({ kind: 'doc.use-case', count: 0, state: 'never', dependsOn: ['code.file'], labels: { en: { one: 'Use case', many: 'Use cases' } } }),
  ],
};

function into(element: ReturnType<typeof createElement>): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  rendered = createRoot(container);
  rendered.render(element);
  return container;
}

describe('the shared kind graph', () => {
  test('draws every kind including independent kinds with dependency columns, states and records links', async () => {
    const catalog = { ...CATALOG, kinds: [...CATALOG.kinds, kind({ kind: 'independent', page: false })] };
    const graph = into(createElement(KindGraph, { catalog }));
    await until(() => graph.querySelector('[data-testid="dependency-node"]') !== null, 'the graph');
    const nodes = [...graph.querySelectorAll('[data-testid="dependency-node"]')];
    expect(nodes.map((node) => node.getAttribute('data-kind'))).toEqual(['code.file', 'independent', 'doc.term', 'doc.use-case']);
    expect(nodes.map((node) => node.getAttribute('data-depth'))).toEqual(['0', '0', '1', '1']);
    expect(nodes.map((node) => node.getAttribute('data-state'))).toEqual(['done', 'done', 'partial', 'never']);
    expect([...graph.querySelectorAll('[data-edge]')].map((edge) => edge.getAttribute('data-edge')).sort()).toEqual(['code.file->doc.term', 'code.file->doc.use-case']);
    const term = graph.querySelector('[data-kind="doc.term"]')!;
    expect(term.querySelector('[data-testid="dependency-state"]')!.textContent).toBe('Partial');
    expect(term.querySelector('[data-testid="dependency-count"]')!.textContent).toBe('3');
    expect(term.querySelector('a')!.getAttribute('href')).toBe('/kind/doc.term');
    expect(term.querySelector('button a')).toBeNull();
    expect(graph.querySelector('[data-kind="independent"] a')).toBeNull();
    expect(graph.querySelector('h1')).toBeNull();
    expect(graph.querySelector('[data-testid="dependencies-graph"]')!.className).toContain('overflow-x-auto');
    expect(localeKeyIn(renderedText(graph))).toBeUndefined();
  });

  test('choosing is separate from records navigation and highlights dependencies and dependents', async () => {
    const catalog = { ...CATALOG, kinds: [...CATALOG.kinds, kind({ kind: 'root', dependsOn: ['doc.term'] })] };
    const choices: string[] = [];
    const graph = into(createElement(KindGraph, { catalog, chosen: 'doc.term', onChoose: (id: string) => { choices.push(id); } }));
    await until(() => graph.querySelector('button') !== null, 'the graph');
    const chosen = graph.querySelector<HTMLButtonElement>('[data-testid="dependency-choose-doc.term"]')!;
    expect(chosen.getAttribute('aria-pressed')).toBe('true');
    chosen.click();
    expect(choices).toEqual(['doc.term']);
    expect([...graph.querySelectorAll('[data-highlighted="true"]')].map((node) => node.getAttribute('data-kind'))).toEqual(['code.file', 'doc.term', 'root']);
    expect(graph.querySelector('[data-kind="doc.use-case"]')!.getAttribute('data-highlighted')).toBe('false');
    expect(graph.querySelector('[data-edge="code.file->doc.term"]')!.getAttribute('data-active')).toBe('true');
    expect(graph.querySelector('[data-edge="code.file->doc.use-case"]')!.getAttribute('data-active')).toBe('false');
  });

  test('external highlights work without graph selection or fill controls', async () => {
    const graph = into(createElement(KindGraph, { catalog: CATALOG, highlighted: new Set(['code.file', 'doc.term']) }));
    await until(() => graph.querySelector('[data-testid="dependency-node"]') !== null, 'the graph');
    expect(graph.querySelector('[data-kind="doc.term"]')!.getAttribute('data-highlighted')).toBe('true');
    expect(graph.querySelectorAll('input')).toHaveLength(0);
    expect(graph.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
  });

  test('layers follow longest chains, missing kinds are retained as dependencies, and cycles stay visible', async () => {
    expect(graphLayers([kind({ kind: 'a' }), kind({ kind: 'b', dependsOn: ['a'] }), kind({ kind: 'c', dependsOn: ['b'] })]).layers).toEqual([['a'], ['b'], ['c']]);
    const kinds = [kind({ kind: 'a', dependsOn: ['b'] }), kind({ kind: 'b', dependsOn: ['a'] })];
    expect(graphLayers(kinds).cycles).toEqual(['a -> b -> a']);
    const graph = into(createElement(KindGraph, { catalog: { ...CATALOG, kinds } }));
    await until(() => graph.querySelector('[role="alert"]') !== null, 'the cycle');
    expect(graph.querySelector('[role="alert"]')!.textContent).toContain('a -> b -> a');
    expect(graph.querySelectorAll('[data-testid="dependency-node"]')).toHaveLength(2);
    expect([...relatedKinds(kinds, 'a')].sort()).toEqual(['a', 'b']);
    const missing = graphLayers([kind({ kind: 'a', dependsOn: ['missing'] })]);
    expect(missing.nodes[0]!.dependsOn).toEqual(['missing']);
    expect(missing.layers).toEqual([['a']]);
    expect([...relatedKinds(kinds, null)]).toEqual([]);
  });

  test('fill states use turns and catalog outcomes', async () => {
    const kinds = [kind({ kind: 'a', turn: 'published' }), kind({ kind: 'b', turn: 'running' }), kind({ kind: 'c', state: 'never' })];
    const graph = into(createElement(KindGraph, { catalog: { ...CATALOG, kinds }, filling: true }));
    await until(() => graph.querySelector('[data-testid="dependency-node"]') !== null, 'the graph');
    expect([...graph.querySelectorAll('[data-state]')].map((node) => node.getAttribute('data-state'))).toEqual(['done', 'running', 'waiting']);
    expect(graphStateOf(kind({ kind: 'a', turn: 'ready' }), true)).toBe('waiting');
    expect(graphStateOf(kind({ kind: 'a', turn: 'blocked' }), false)).toBe('failed');
    expect(graphStateOf(kind({ kind: 'a', state: 'never' }), false)).toBe('never');
  });
});
