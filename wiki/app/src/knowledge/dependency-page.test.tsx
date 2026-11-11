/**
 * The dependency graph page (madarch-stm0.6, commit 5): the catalogue's entities laid out by the dependencies their
 * declarations give, each with the state the last fill left it in. The page holds no list of kinds: everything it draws is
 * the manifest's catalogue, and the state is the catalogue's own answer, so a run that publishes moves it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setWikiLanguage } from '../i18n.js';
import { DependencyPage, dependencySplit, graphLayers, graphStateOf } from './dependency-page.js';
import { localeKeyIn, renderedText } from '../../test/locale-keys.js';
import type { CatalogKindView, CatalogView, WikiStatus } from './types.js';

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

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

/** The status the page reads: idle unless a test says a run works. */
const status = (over: Partial<WikiStatus> = {}): WikiStatus => ({
  product: { name: 'shop', id: 'x' }, manifest: 'ok', manifestFile: 'madarch/kinds.yaml', language: 'en', findingCount: 0, kinds: [], groups: [], repositories: [{ name: 'training', filled: true }], filled: true, incomplete: false, fill: { state: 'done' }, writer: { state: 'idle', agent: null, units: [] }, bounds: { turns: 30, minutes: 10, toolCalls: 80, writeAttempts: 5, maxDomains: 12, editorialRequestsPerPage: 2 }, chosenAgent: null, home: null, ...over,
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

describe('the dependency graph page', () => {
  test('draws every entity in the column its dependencies put it in, with the state a fill left it in', async () => {
    (globalThis as { fetch?: unknown }).fetch = async (url: string) => url.includes('/api/catalog') ? json(CATALOG) : json({ message: 'not here' }, 404);
    const page = into(createElement(DependencyPage, { version: 0, status: status() }));
    await until(() => page.querySelector('[data-testid="dependency-node"]') !== null, 'the graph');
    const nodes = [...page.querySelectorAll('[data-testid="dependency-node"]')];
    expect(nodes.map((node) => node.getAttribute('data-kind'))).toEqual(['code.file', 'doc.term', 'doc.use-case']);
    // The files stand before the kinds that read them, and the drawing carries the edges their declarations make.
    expect(nodes.map((node) => node.getAttribute('data-depth'))).toEqual(['0', '1', '1']);
    expect(nodes.map((node) => node.getAttribute('data-state'))).toEqual(['done', 'partial', 'never']);
    const edges = [...page.querySelectorAll('[data-edge]')].map((edge) => edge.getAttribute('data-edge'));
    expect(edges.sort()).toEqual(['code.file->doc.term', 'code.file->doc.use-case']);
    expect(page.querySelector('[data-testid="dependencies-total"]')!.textContent).toContain('3 entities in 2 columns');
    // No raw i18n key reached the page: every state is a word in the locale.
    expect(localeKeyIn(renderedText(page))).toBeUndefined();
    // The graph scrolls inside its own frame: the page itself keeps the viewport's width.
    expect(page.querySelector('[data-testid="dependencies-graph"]')!.className).toContain('overflow-x-auto');
    // Each entity keeps its own state words and count.
    const term = page.querySelector('[data-kind="doc.term"]')!;
    expect(term.querySelector('[data-testid="dependency-state"]')!.textContent).toBe('Partial');
    expect(term.querySelector('[data-testid="dependency-count"]')!.textContent).toBe('3');
  });

  test('the layers are the longest chain of the declarations, and a cycle is named, not hidden', () => {
    const chain = graphLayers([kind({ kind: 'a' }), kind({ kind: 'b', dependsOn: ['a'] }), kind({ kind: 'c', dependsOn: ['b'] }), kind({ kind: 'd', dependsOn: ['a'] })]);
    expect(chain.layers).toEqual([['a'], ['b', 'd'], ['c']]);
    const loop = graphLayers([kind({ kind: 'a', dependsOn: ['b'] }), kind({ kind: 'b', dependsOn: ['a'] })]);
    expect(loop.cycles).toEqual(['a -> b -> a']);
    // A dependency the catalogue does not declare is said in the row and drops no kind.
    const missing = graphLayers([kind({ kind: 'a', dependsOn: ['nowhere'] })]);
    expect(missing.nodes.map((node) => node.dependsOn)).toEqual([['nowhere']]);
    expect(missing.layers).toEqual([['a']]);
  });

  test('while a fill runs every entity shows the step of its own turn, and the page states the run and its progress', async () => {
    const catalog: CatalogView = {
      ...CATALOG,
      kinds: [
        kind({ kind: 'code.file', count: 12, turn: 'published' }),
        kind({ kind: 'doc.term', count: 3, turn: 'running', dependsOn: ['code.file'] }),
        kind({ kind: 'doc.use-case', count: 0, state: 'never', dependsOn: ['code.file'] }),
      ],
    };
    (globalThis as { fetch?: unknown }).fetch = async (url: string) => url.includes('/api/catalog') ? json(catalog) : json({ message: 'not here' }, 404);
    const page = into(createElement(DependencyPage, {
      version: 0,
      status: status({
        fill: { state: 'running', progress: { spans: 9, planned: 4, published: 2, failed: 1, blocked: 0, stages: {}, last: null } },
      }),
    }));
    await until(() => page.querySelector('[data-testid="dependency-node"]') !== null, 'the graph');
    const nodes = [...page.querySelectorAll('[data-testid="dependency-node"]')];
    // A published turn is done, a running one is running, and a kind with no turn waits while the run works.
    expect(nodes.map((node) => node.getAttribute('data-state'))).toEqual(['done', 'running', 'waiting']);
    expect(page.querySelector('[data-kind="doc.term"] [data-testid="dependency-state"]')!.textContent).toBe('Running');
    expect(page.querySelector('[data-testid="dependencies-progress"]')!.textContent).toContain('2 of 4 units published');
    expect(page.querySelector('[data-testid="dependencies-open-fill"]')).not.toBeNull();
    // A failed turn says so in its own entity, and the run's failure is at the page's head.
    const failed: CatalogView = { ...catalog, kinds: [kind({ kind: 'code.file', turn: 'failed', dependsOn: ['nowhere'] })] };
    (globalThis as { fetch?: unknown }).fetch = async (url: string) => url.includes('/api/catalog') ? json(failed) : json({ message: 'not here' }, 404);
    rendered?.unmount();
    const after = into(createElement(DependencyPage, { version: 0, status: status({ fill: { state: 'failed', message: 'the run ended failed' } }) }));
    await until(() => after.querySelector('[data-testid="dependency-node"]') !== null, 'the failed graph');
    expect(after.querySelector('[data-kind="code.file"]')!.getAttribute('data-state')).toBe('failed');
    expect(after.querySelector('[data-kind="code.file"] [data-testid="dependency-state"]')!.textContent).toBe('Failed');
    expect(after.querySelector('[data-testid="dependencies-failed"]')!.textContent).toContain('the run ended failed');
    // The mapping is a function of the kind and whether a fill works; no list of kinds stands in the page.
    expect(graphStateOf(kind({ kind: 'code.file', turn: 'ready' }), true)).toBe('waiting');
    expect(graphStateOf(kind({ kind: 'code.file', turn: 'blocked' }), false)).toBe('failed');
    expect(graphStateOf(kind({ kind: 'code.file', state: 'never', count: 0 }), true)).toBe('waiting');
    expect(graphStateOf(kind({ kind: 'code.file', state: 'never', count: 0 }), false)).toBe('never');
  });

  test('entities that take part in no dependency leave the graph and are listed by section, collapsed, with their state counts', async () => {
    const catalog: CatalogView = {
      ...CATALOG,
      groups: [{ group: 'requirements', labels: { en: 'Requirements', ru: 'Требования' } }],
      kinds: [...CATALOG.kinds, kind({ kind: 'doc.faq', area: 'requirements', count: 5, state: 'partial', labels: { en: { one: 'FAQ', many: 'FAQ' } } })],
    };
    (globalThis as { fetch?: unknown }).fetch = async (url: string) => url.includes('/api/catalog') ? json(catalog) : json({ message: 'not here' }, 404);
    const page = into(createElement(DependencyPage, { version: 0, status: status() }));
    await until(() => page.querySelector('[data-testid="dependency-node"]') !== null, 'the graph');
    // Only the kinds that take part in a dependency are boxes; the independent one is below.
    expect([...page.querySelectorAll('[data-testid="dependency-node"]')].map((node) => node.getAttribute('data-kind'))).toEqual(['code.file', 'doc.term', 'doc.use-case']);
    expect(page.querySelector('[data-testid="dependency-node"][data-kind="doc.faq"]')).toBeNull();
    expect(page.querySelector('[data-testid="dependencies-independent-note"]')!.textContent).toContain('1');
    const section = page.querySelector('[data-testid="dependencies-independent-section"]')! as HTMLDetailsElement;
    expect(section.getAttribute('data-area')).toBe('requirements');
    expect(section.open).toBe(false);
    expect(section.querySelector('summary')!.textContent).toContain('Requirements');
    expect(section.querySelector('summary')!.textContent).toContain('1 entity');
    expect(section.querySelector('[data-testid="dependencies-independent-counts"]')!.textContent).toBe('1 partial');
    expect(section.querySelector('[data-testid="dependencies-independent-list"]')!.textContent).toContain('FAQ');
    expect(localeKeyIn(renderedText(page))).toBeUndefined();
    // The split itself: a kind that is needed by another takes part even when it declares no dependency of its own.
    const split = dependencySplit(catalog.kinds);
    expect(split.nodes.map((node) => node.kind.kind)).toEqual(['code.file', 'doc.term', 'doc.use-case']);
    expect(split.independent.map((kind) => kind.kind)).toEqual(['doc.faq']);
  });
});
