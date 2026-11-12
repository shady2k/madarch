import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setWikiLanguage } from '../i18n.js';
import { KindGraph, graphLayers, graphStateOf, relatedKinds } from './kind-graph.js';
import { GraphViewport } from '../components/ui/graph.js';
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
  test('the graph kit pans the background and zooms with wheel and two pointers, without dragging controls', async () => {
    const graph = into(createElement(GraphViewport, { 'data-testid': 'frame' } as never, createElement('button', {}, 'Action')));
    await until(() => graph.querySelector('[data-testid="frame"]') !== null, 'viewport');
    const frame = graph.querySelector('[data-testid="frame"]') as HTMLElement;
    const transform = (): string | undefined => (graph.querySelector('[data-testid="graph-transform"]') as HTMLElement | null)?.style.transform;
    const pointer = (type: string, id: number, x: number, y: number, target: Element = frame): void => {
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: id, clientX: x, clientY: y }));
    };
    const original = transform();
    pointer('pointerdown', 1, 20, 20);
    pointer('pointermove', 1, 60, 50);
    pointer('pointerup', 1, 60, 50);
    await until(() => transform() !== original, 'background pan');
    expect(transform()).toContain('translate(40px, 30px)');
    const panned = transform();
    pointer('pointerdown', 2, 20, 20, graph.querySelector('button')!);
    pointer('pointermove', 2, 90, 90);
    expect(transform()).toBe(panned);
    frame.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100, clientX: 50, clientY: 50 }));
    await until(() => transform() !== panned, 'wheel zoom');
    const wheeled = transform();
    pointer('pointerdown', 3, 0, 0);
    pointer('pointerdown', 4, 50, 0);
    pointer('pointermove', 4, 100, 0);
    await until(() => transform() !== wheeled, 'pinch zoom');
    pointer('pointerup', 3, 0, 0);
    pointer('pointercancel', 4, 100, 0);
  });

  test('starts with purpose sections, counted dependencies, and expands only the chosen section', async () => {
    const catalog = { ...CATALOG, groups: [
      { group: 'code', labels: { en: 'Code' } }, { group: 'docs', labels: { en: 'Documents' } },
    ], kinds: CATALOG.kinds.map((entry) => ({ ...entry, area: entry.kind.startsWith('code.') ? 'code' : 'docs' })) };
    const graph = into(createElement(KindGraph, { catalog }));
    await until(() => graph.querySelector('[data-section="code"]') !== null, 'sections');
    expect(graph.querySelectorAll('[data-testid="dependency-node"]')).toHaveLength(0);
    expect(graph.querySelector('[data-section="code"]')!.textContent).toContain('12');
    expect(graph.querySelector('[data-edge="section:code->section:docs"]')!.getAttribute('data-count')).toBe('2');
    expect(graph.querySelector('[data-edge="section:code->section:docs"]')!.getAttribute('marker-end')).toMatch(/^url\(#.+\)$/u);
    expect(graph.querySelector('marker path')).not.toBeNull();
    (graph.querySelector('[data-section="docs"] button') as HTMLButtonElement).click();
    await until(() => graph.querySelectorAll('[data-testid="dependency-node"]').length === 2, 'expanded section');
    expect(graph.querySelector('[data-kind="code.file"]')).toBeNull();
    expect(graph.querySelector('[data-section="code"]')).not.toBeNull();
    expect(localeKeyIn(renderedText(graph))).toBeUndefined();
  });

  test('selection renders only the bounded dependency and dependent neighbourhood and keeps record links', async () => {
    const catalog = { ...CATALOG, kinds: [...CATALOG.kinds, kind({ kind: 'root', dependsOn: ['doc.term'] }), kind({ kind: 'far', dependsOn: ['root'] })] };
    const graph = into(createElement(KindGraph, { catalog, chosen: 'doc.term' }));
    await until(() => graph.querySelector('[data-kind="doc.term"]') !== null, 'focus');
    expect([...graph.querySelectorAll('[data-kind]')].map((node) => node.getAttribute('data-kind')).sort()).toEqual(['code.file', 'doc.term', 'root']);
    expect(graph.querySelector('[data-kind="doc.term"] a')!.getAttribute('href')).toBe('/kind/doc.term');
    (graph.querySelector('[data-testid="graph-two-steps"]') as HTMLButtonElement).click();
    await until(() => graph.querySelector('[data-kind="far"]') !== null, 'two steps');
    expect(graph.querySelector('[data-kind="doc.use-case"]')).toBeNull();
    expect([...relatedKinds(catalog.kinds, 'doc.term')].sort()).toEqual(['code.file', 'doc.term', 'root']);
  });

  test('layers follow longest chains, missing kinds are retained as dependencies, and cycles stay visible', async () => {
    expect(graphLayers([kind({ kind: 'a' }), kind({ kind: 'b', dependsOn: ['a'] }), kind({ kind: 'c', dependsOn: ['b'] })]).layers).toEqual([['a'], ['b'], ['c']]);
    const kinds = [kind({ kind: 'a', dependsOn: ['b'] }), kind({ kind: 'b', dependsOn: ['a'] })];
    expect(graphLayers(kinds).cycles).toEqual(['a -> b -> a']);
    const graph = into(createElement(KindGraph, { catalog: { ...CATALOG, kinds }, chosen: 'a' }));
    await until(() => graph.querySelector('[role="alert"]') !== null, 'the cycle');
    expect(graph.querySelector('[role="alert"]')!.textContent).toContain('a -> b -> a');
    expect(graph.querySelectorAll('[data-testid="dependency-node"]')).toHaveLength(2);
    expect([...relatedKinds(kinds, 'a')].sort()).toEqual(['a', 'b']);
    const missing = graphLayers([kind({ kind: 'a', dependsOn: ['missing'] })]);
    expect(missing.nodes[0]!.dependsOn).toEqual(['missing']);
    expect(missing.layers).toEqual([['a']]);
    expect([...relatedKinds(kinds, null)]).toEqual([]);
  });

  test('focused cards retain producer folders and absent-label markers in the reader language', async () => {
    await setWikiLanguage('ru');
    const graph = into(createElement(KindGraph, { catalog: { ...CATALOG, kinds: [kind({ kind: 'private.id', labels: { en: { one: 'English only', many: 'English only' } }, pluginFolders: ['plugins/example'] })] }, chosen: 'private.id' }));
    await until(() => graph.querySelector('[data-kind="private.id"]') !== null, 'focused declaration');
    expect(graph.querySelector('[data-testid="dependency-plugin"]')!.textContent).toBe('plugins/example');
    expect(graph.textContent).not.toContain('English only');
    expect(graph.textContent).not.toContain('private.id');
    expect(graph.querySelector('[data-testid="dependencies-graph"]')!.className).toContain('max-h-96');
    await setWikiLanguage('en');
  });

  test('fill states use turns and catalog outcomes', async () => {
    const kinds = [kind({ kind: 'a', turn: 'published' }), kind({ kind: 'b', turn: 'running' }), kind({ kind: 'c', state: 'never' })];
    const graph = into(createElement(KindGraph, { catalog: { ...CATALOG, kinds }, filling: true, highlighted: new Set(['a', 'b', 'c']) }));
    await until(() => graph.querySelector('[data-testid="dependency-node"]') !== null, 'the graph');
    expect([...graph.querySelectorAll('[data-state]')].map((node) => node.getAttribute('data-state'))).toEqual(['done', 'running', 'waiting']);
    expect(graphStateOf(kind({ kind: 'a', turn: 'running' }), true)).toBe('running');
    expect(graphStateOf(kind({ kind: 'a', state: 'never' }), true)).toBe('waiting');
    expect(graphStateOf(kind({ kind: 'a', state: 'partial' }), false)).toBe('partial');
    expect(graphStateOf(kind({ kind: 'a', turn: 'ready' }), true)).toBe('waiting');
    expect(graphStateOf(kind({ kind: 'a', turn: 'blocked' }), false)).toBe('failed');
    expect(graphStateOf(kind({ kind: 'a', state: 'never' }), false)).toBe('never');
  });
});
