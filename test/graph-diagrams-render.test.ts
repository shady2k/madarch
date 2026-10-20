/**
 * The graph's diagrams as the renderers carry them (madarch-tzte.23.4; decision
 * 0026, "Diagrams"): the Mermaid source of a model, the LikeC4 workspace of one,
 * and the tabs a type is offered under — every expectation taken from the task and
 * from 0026, never from the module.
 *
 * 0026's bar is what these hold: a fact is drawn solid and an assumption or an end
 * the graph does not hold dashed, an element links its page and keeps its place in
 * code, and a type is offered on every renderer that supports it and on none that
 * does not. The graph is the diagram models' own fixture (`fill-diagram-fixture.ts`,
 * made with the schema's constructors), so nothing here reads a checkout.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDiagram, type DiagramModel } from '../src/fill/diagrams.js';
import { diagramSpecsFor } from '../src/fill/graph-diagrams.js';
import { archifyDocument } from '../src/wiki/archify.js';
import {
  DEFAULT_DIAGRAM_TAB,
  DIAGRAM_RENDERERS_OF,
  chosenDiagramTab,
  graphDiagramOf,
  orderedTabs,
} from '../src/product-wiki/graph-diagrams.js';
import { mermaidOfDiagram } from '../src/product-wiki/graph-mermaid.js';
import { graphArchifyPage, graphLikeC4Page } from '../src/product-wiki/graph-render.js';
import { layoutedViews } from '../src/wiki/archify-page.js';
import { diagramWorkspace, webcomponentElement, webcomponentPrefix } from '../src/product-wiki/graph-workspace.js';
import { checkLikeC4Workspaces } from '../scripts/likec4-check.js';
import { LIKEC4_DRAWINGS_SOURCE } from '../src/product-wiki/likec4-drawings.js';
import { DIAGRAM_FIXTURE, readsOf } from './fill-diagram-fixture.js';

const fx = DIAGRAM_FIXTURE;
const clean = readsOf(fx.facts.filter((fact) => fact.id !== fx.orphanImportsGone.id));
/** The same graph with the import into the file no unit holds: the view that draws an end the graph does not hold. */
const full = readsOf(fx.facts);

/** The source's lines, for a test that reads it the way a reader does. */
const linesOf = (source: string): readonly string[] => source.split('\n');

describe('the Mermaid source of a diagram', () => {
  test('two modules and the one import between them is a flow of two nodes and one solid arrow', async () => {
    // The fixture's own graph: one import from checkout's cart into payment's pay, cut to the two modules.
    // The edge facts do not stand under this view alone, which is why the arrows are checked in the next test.
    const model = await buildDiagram({ type: 'module-dependency', nodes: [fx.shop.id] }, clean);
    const lines = linesOf(mermaidOfDiagram(model));
    expect(lines.slice(0, 4)).toEqual([
      '%%{init: {"flowchart": {"curve": "linear"}}}%%',
      'flowchart LR',
      '  n0("checkout")',
      '  n1("payment")',
    ]);
  });

  test('a folded arrow of one import and one interaction is drawn dashed, and a container dependency drawn solid', async () => {
    // The shop's two modules are joined by an import (a fact) and by an agent's interaction (an assumption): the
    // folded arrow takes the weaker of them (0026: solid lines are facts, dashed are assumptions), and the two
    // packages' dependency is a fact and stays solid.
    const modules = await buildDiagram({ type: 'c4-component', nodes: [fx.shop.id] }, clean);
    const source = mermaidOfDiagram(modules);
    expect(source).toContain('  n0 -.->|"import, interaction"| n1');
    expect(source).toContain('  n1 -.->|"interaction"| n0');
    // The elements themselves are facts, so they are drawn solid: only the arrows are dashed, and no node class is needed.
    expect(source).not.toContain('classDef');
    const containers = await buildDiagram({ type: 'c4-container', nodes: [fx.shop.id] }, clean);
    expect(mermaidOfDiagram(containers)).toContain('  n0 -->|"dependency"| n1');
  });

  test('an end the graph does not hold is drawn, dashed, and the arrow into it is dashed with it', async () => {
    const model = await buildDiagram({ type: 'state', nodes: [fx.newState.id] }, clean);
    const source = mermaidOfDiagram(model);
    const lines = linesOf(source);
    // Every state of the machine, the one no unit holds included, and three transitions, each named by its event.
    expect(lines.filter((line) => line.includes('-.->'))).toHaveLength(3);
    expect(lines).toContain('  n0(["OrderStatus.new"])');
    expect(lines).toContain('  n1(["OrderStatus.paid"])');
    // The state the graph does not hold is drawn by its kind and marked unresolved: a content-addressed id in a box
    // says nothing a reader can act on (madarch-tzte.23.6).
    expect(lines).toContain('  n3["state (unresolved)"]');
    expect(source).not.toContain(fx.refundedState.id);
    expect(source).toContain('  class n0,n1,n2,n3 assumption');
  });

  test('an ER table carries the columns it holds in its own label', async () => {
    const model = await buildDiagram({ type: 'er', nodes: [fx.shop.id] }, clean);
    const lines = linesOf(mermaidOfDiagram(model));
    // A table's name, then its columns with their types; a table the graph holds no fact of is a plain box, dashed.
    expect(lines).toContain('  n1[("acme-shop:public.orders: id bigint, total numeric")]');
    expect(lines).toContain('  n2[("acme-shop:public.payments: id bigint")]');
    expect(lines).toContain('  n0["acme-shop:public.audit (unresolved): id bigint"]');
    expect(lines).toContain('  class n0 assumption');
  });

  test('a sequence is a sequence diagram: its participants, its steps in the scenario order, and a dashed step for an assumption', async () => {
    const model = await buildDiagram({ type: 'sequence', nodes: [fx.placeSymbol.id, fx.chargeSymbol.id], scenario: [fx.settled.id, fx.placeCalls.id] }, clean);
    const lines = linesOf(mermaidOfDiagram(model));
    expect(lines.slice(0, 1)).toEqual(['sequenceDiagram']);
    // A lifeline is a column: it reads by the short name, and the element list under the diagram keeps the whole label.
    expect(lines).toContain('  participant n0 as CheckoutController.place');
    expect(lines).toContain('  participant n1 as PaymentGateway.charge');
    // The scenario's own order: the settled event first, the call second, each carrying the step the model gave it.
    expect(lines).toContain('  n1-->>n0: step 1: payment-settled');
    expect(lines).toContain('  n0-->>n1: step 2: POST /payments');
  });
});

describe('the LikeC4 workspace of a diagram', () => {
  test('every element is an element of its own kind, its place and its page, and a dashed arrow keeps its dashes', async () => {
    const model = await buildDiagram({ type: 'state', nodes: [fx.newState.id] }, clean);
    const held = diagramWorkspace(model, { pageAddress: (id) => `/p/graph/${id}` });
    const lines = held.workspace.split('\n');
    expect(lines).toContain('specification {');
    expect(lines).toContain('  element state');
    expect(lines).toContain('model {');
    expect(lines).toContain('  n0 = state "OrderStatus.new" {');
    expect(lines).toContain('    technology "acme-shop · src/cart.ts:1-1"');
    expect(lines).toContain(`    link /p/graph/${fx.newState.id}`);
    expect(held.workspace).toContain('    style {');
    expect(held.workspace).toContain('      line dashed');
    expect(lines).toContain('  view index {');
    expect(lines).toContain('    include *');
    expect(held.viewId).toBe('index');
    expect([...held.elementIds.values()]).toEqual(['n0', 'n1', 'n2', 'n3']);
  });

  test('every link is root-relative, so a products home prefixes it exactly once', async () => {
    // The generated documents carry the app's own root-relative addresses and the products home rewrites an HTML
    // answer once (`http.ts`, `withProductPrefix`): a document that baked the prefix in would get it twice.
    const model = await buildDiagram({ type: 'module-dependency', nodes: [fx.shop.id] }, clean);
    const held = diagramWorkspace(model, { pageAddress: (id) => `/p/graph/${id}` });
    expect(held.workspace).toContain(`    link /p/graph/${fx.checkout.id}`);
    expect(held.workspace).not.toContain('/products/');
  });

  test('a table carries its columns and its place in the one line LikeC4 draws under a name', async () => {
    const model = await buildDiagram({ type: 'er', nodes: [fx.shop.id] }, clean);
    const held = diagramWorkspace(model, { pageAddress: (id) => `/p/graph/${id}` });
    // `public.orders` is a table the graph holds at a place: the columns ride beside it, never instead of it.
    expect(held.workspace).toContain('    technology "acme-shop · migrations/001.sql:3-3 · id bigint, total numeric"');
    // A table no fact holds has no place and keeps its columns alone.
    expect(held.workspace).toContain('    technology "id bigint"');
  });

  test('the pinned LikeC4 accepts the workspace of every type the graph answers', async () => {
    const models: readonly DiagramModel[] = [
      await buildDiagram({ type: 'c4-context', nodes: [] }, clean),
      await buildDiagram({ type: 'c4-container', nodes: [fx.shop.id] }, clean),
      await buildDiagram({ type: 'c4-component', nodes: [fx.shop.id] }, clean),
      await buildDiagram({ type: 'module-dependency', nodes: [fx.shop.id] }, clean),
      await buildDiagram({ type: 'er', nodes: [fx.shop.id] }, clean),
      await buildDiagram({ type: 'state', nodes: [fx.newState.id] }, clean),
    ];
    const folder = mkdtempSync(join(tmpdir(), 'madarch-graph-workspace-'));
    try {
      for (const [at, model] of models.entries()) {
        const held = diagramWorkspace(model, { pageAddress: (id) => `/p/graph/${id}` });
        const workspace = join(folder, `workspace-${String(at)}`);
        mkdirSync(workspace, { recursive: true });
        writeFileSync(join(workspace, 'diagram.c4'), held.workspace);
      }
      const validated = checkLikeC4Workspaces(models.map((_model, at) => join(folder, `workspace-${String(at)}`)));
      expect(validated.errors).toEqual([]);
      expect(validated.files).toBe(models.length);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }, 120_000);

  test('the webcomponent element a bundle defines is named from the workspace itself, and two workspaces never share it', async () => {
    const module = await buildDiagram({ type: 'module-dependency', nodes: [fx.shop.id] }, clean);
    const state = await buildDiagram({ type: 'state', nodes: [fx.newState.id] }, clean);
    const one = diagramWorkspace(module, { pageAddress: (id) => `/p/graph/${id}` }).workspace;
    const two = diagramWorkspace(state, { pageAddress: (id) => `/p/graph/${id}` }).workspace;
    expect(webcomponentElement(webcomponentPrefix(one))).toMatch(/^madarch-graph-[0-9a-f]{12}-view$/);
    expect(webcomponentPrefix(one)).not.toBe(webcomponentPrefix(two));
    expect(webcomponentPrefix(one)).toBe(webcomponentPrefix(one));
  });
});

describe('a node the graph does not hold, in every renderer', () => {
  test('every renderer draws the name the graph gives it and never its content-addressed id', async () => {
    const model = await buildDiagram({ type: 'module-dependency', nodes: [fx.shop.id] }, full);
    const placeholder = model.elements.find((element) => element.kind === null);
    expect(placeholder?.label).toBe('./gone.js (unresolved)');
    // Mermaid draws the label in the box, dashed.
    const mermaid = mermaidOfDiagram(model);
    expect(mermaid).toContain('./gone.js (unresolved)');
    expect(mermaid).not.toContain(fx.gone.id);
    // LikeC4 draws it as the element of its own `unresolved` kind.
    const held = diagramWorkspace(model, { pageAddress: (id) => `/p/graph/${id}` });
    expect(held.workspace).toContain(`= unresolved "./gone.js (unresolved)"`);
    expect(held.workspace).not.toContain(fx.gone.id);
    // archify's document carries it as a component's own label, from the layout LikeC4 computes for that workspace.
    const layouted = await layoutedViews(held.workspace);
    const view = layouted.get(held.viewId);
    expect(view).toBeDefined();
    const document = archifyDocument(view!, { output: 'graph-diagram.html', dashed: new Set<string>() });
    expect(JSON.stringify(document)).toContain('./gone.js (unresolved)');
    expect(JSON.stringify(document)).not.toContain(fx.gone.id);
  }, 120_000);

  test('the page lists it under the same name, and keeps its id as the element the row stands for', async () => {
    const model = await buildDiagram({ type: 'module-dependency', nodes: [fx.shop.id] }, full);
    const answer = graphDiagramOf({ spec: { type: 'module-dependency', nodes: [fx.shop.id] }, model }, { node: fx.shop.id, chosen: 'mermaid' });
    const listed = answer.elements.find((element) => element.kind === null);
    expect(listed?.label).toBe('./gone.js (unresolved)');
    // The id is what the app's row carries (and its tooltip): a reader tracing the arrow back to the fact still can.
    expect(listed?.id).toBe(`unresolved:${fx.gone.id}`);
    expect(listed?.page).toBeUndefined();
    // The arrow list names both ends through the elements' labels, so an arrow into the placeholder reads as a name.
    expect(answer.edges.map((edge) => edge.to)).toContain(`unresolved:${fx.gone.id}`);
  });
});


describe('the tabs a page shows its diagrams under', () => {
  test('every type is offered on every renderer that supports it, in the one order the tabs stand in', () => {
    expect(DIAGRAM_RENDERERS_OF['c4-context']).toEqual(['likec4', 'mermaid', 'archify']);
    expect(DIAGRAM_RENDERERS_OF['c4-container']).toEqual(['likec4', 'mermaid', 'archify']);
    expect(DIAGRAM_RENDERERS_OF['c4-component']).toEqual(['likec4', 'mermaid', 'archify']);
    expect(DIAGRAM_RENDERERS_OF['module-dependency']).toEqual(['mermaid', 'archify']);
    expect(DIAGRAM_RENDERERS_OF['er']).toEqual(['mermaid', 'archify']);
    expect(DIAGRAM_RENDERERS_OF['state']).toEqual(['mermaid', 'archify']);
    // A sequence is a lifeline and an order: archify draws components and connections, and LikeC4 draws C4.
    expect(DIAGRAM_RENDERERS_OF['sequence']).toEqual(['mermaid']);
  });

  test('the first tab is the setting’s, and a type the setting cannot draw falls back to the first renderer that can', () => {
    expect(orderedTabs('c4-context', 'mermaid')).toEqual(['mermaid', 'likec4', 'archify']);
    expect(orderedTabs('c4-context', 'archify')).toEqual(['archify', 'likec4', 'mermaid']);
    expect(orderedTabs('c4-context', 'likec4')).toEqual(['likec4', 'mermaid', 'archify']);
    expect(orderedTabs('state', 'likec4')).toEqual(['mermaid', 'archify']);
    expect(orderedTabs('sequence', 'archify')).toEqual(['mermaid']);
  });

  test('the setting is `MADARCH_WIKI_DIAGRAM`, LikeC4 when it names none, and a format it does not hold is refused by name', () => {
    expect(chosenDiagramTab({})).toEqual({ ok: true, tab: DEFAULT_DIAGRAM_TAB });
    expect(chosenDiagramTab({ MADARCH_WIKI_DIAGRAM: 'mermaid' })).toEqual({ ok: true, tab: 'mermaid' });
    expect(chosenDiagramTab({ MADARCH_WIKI_DIAGRAM: 'archify' })).toEqual({ ok: true, tab: 'archify' });
    const refused = chosenDiagramTab({ MADARCH_WIKI_DIAGRAM: 'graphviz' });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false ? refused.message : '').toBe('unknown wiki diagram format "graphviz": allowed formats are "likec4", "mermaid" and "archify" (MADARCH_WIKI_DIAGRAM)');
  });
});

describe('one diagram as the app receives it', () => {
  test('its tabs carry the renderer’s own material, its elements open their pages and its arrows say how they stand', async () => {
    const model = await buildDiagram({ type: 'module-dependency', nodes: [fx.shop.id] }, clean);
    const answer = graphDiagramOf({ spec: { type: 'module-dependency', nodes: [fx.shop.id] }, model }, { node: fx.shop.id, chosen: 'mermaid' });
    expect(answer.type).toBe('module-dependency');
    expect(answer.title).toBe('Module dependencies: acme-shop');
    expect(answer.tabs.map((tab) => tab.renderer)).toEqual(['mermaid', 'archify']);
    expect(answer.tabs[0]!.source).toContain('flowchart LR');
    expect(answer.tabs[1]!.src).toBe(`/api/graph/archify?id=${encodeURIComponent(fx.shop.id)}&type=module-dependency`);
    expect(answer.elements.map((element) => [element.label, element.evidence, element.page])).toEqual([
      ['checkout', 'fact', `/p/graph/${fx.checkout.id}`],
      ['payment', 'fact', `/p/graph/${fx.payment.id}`],
    ]);
    expect(answer.elements[0]!.place).toEqual({ repository: 'acme-shop', commit: 'a'.repeat(40), file: 'src/cart.ts', line: 1, endLine: 1 });
    expect(answer.edges.map((edge) => [edge.label, edge.evidence, edge.dashed])).toEqual([['import', 'fact', false]]);
  });

  test('a C4 diagram offers the LikeC4 tab, which frames the page the server draws it in', async () => {
    const model = await buildDiagram({ type: 'c4-context', nodes: [] }, clean);
    const answer = graphDiagramOf({ spec: { type: 'c4-context', nodes: [] }, model }, { node: fx.shop.id, chosen: 'likec4' });
    expect(answer.tabs.map((tab) => tab.renderer)).toEqual(['likec4', 'mermaid', 'archify']);
    // LikeC4 draws in a document of its own: the tab frames the page the server makes from the diagram's workspace.
    expect(answer.tabs[0]!.src).toBe(`/api/graph/likec4.html?id=${encodeURIComponent(fx.shop.id)}&type=c4-context`);
  });

  test('a view the graph answers with nothing says so instead of drawing an empty frame', async () => {
    const model = await buildDiagram({ type: 'er', nodes: [fx.web.id] }, clean);
    const answer = graphDiagramOf({ spec: { type: 'er', nodes: [fx.web.id] }, model }, { node: fx.web.id, chosen: 'mermaid' });
    expect(answer.empty).toBe(true);
    expect(answer.elements).toEqual([]);
  });
});

/** One stand-in for a DOM node, as the drawings probe reads it: its descendants and its own open shadow root. */
interface FakeNode {
  /** Whether this node is an svg, which is what the probe counts. */
  readonly svg?: boolean;
  readonly children: readonly FakeNode[];
  readonly shadowRoot?: FakeNode;
  querySelectorAll(selector: string): readonly FakeNode[];
}

/** A stand-in node: its children, its shadow root and what a selector finds in them, the way a document answers. */
function fakeNode(options: { readonly svg?: boolean; readonly children?: readonly FakeNode[]; readonly shadow?: FakeNode } = {}): FakeNode {
  const children = options.children ?? [];
  const svgsIn = (nodes: readonly FakeNode[]): readonly FakeNode[] => nodes.flatMap((node) => [...(node.svg === true ? [node] : []), ...svgsIn(node.children)]);
  return {
    ...(options.svg === true ? { svg: true } : {}),
    children,
    ...(options.shadow === undefined ? {} : { shadowRoot: options.shadow }),
    querySelectorAll: (selector: string) => (selector === '*' ? children : svgsIn(children)),
  };
}

/** The drawings probe as a page or a walk runs it: the very bytes the page carries. */
function drawingsProbe(): (root: FakeNode) => readonly FakeNode[] {
  return new Function(`return (${LIKEC4_DRAWINGS_SOURCE});`)() as (root: FakeNode) => readonly FakeNode[];
}

describe('the drawings a LikeC4 element holds', () => {
  test('a drawing is found wherever LikeC4 put it: its own shadow root, or the one nested inside that', () => {
    const drawings = drawingsProbe();
    // Nothing drawn at all is the answer a browser where LikeC4 failed must still get.
    expect(drawings(fakeNode())).toEqual([]);
    // A drawing in the host's light DOM and one in its own shadow root are both the element's drawing.
    expect(drawings(fakeNode({ children: [fakeNode({ svg: true })] }))).toHaveLength(1);
    expect(drawings(fakeNode({ shadow: fakeNode({ children: [fakeNode({ svg: true })] }) }))).toHaveLength(1);
    // LikeC4's own shape (likec4/react's `ShadowRootHost`): the element's shadow root holds a div that attaches a
    // second shadow root, and the drawing is in *that* one. Asking the element's own shadow root finds nothing.
    const likec4 = fakeNode({ shadow: fakeNode({ children: [fakeNode({ shadow: fakeNode({ children: [fakeNode({ svg: true })] }) })] }) });
    expect(drawings(likec4)).toHaveLength(1);
    expect(likec4.shadowRoot!.querySelectorAll('svg')).toEqual([]);
    // Two drawings are two, so the walk collects them all and stops at nothing.
    expect(drawings(fakeNode({ children: [fakeNode({ svg: true })], shadow: fakeNode({ children: [fakeNode({ svg: true })] }) }))).toHaveLength(2);
  });
});

describe('the LikeC4 page of a diagram', () => {
  test('the document carries the element the bundle defines, the view and a word for a browser where LikeC4 draws nothing', async () => {
    const model = await buildDiagram({ type: 'c4-context', nodes: [] }, clean);
    const page = graphLikeC4Page(model, { node: fx.shop.id });
    expect(page.viewId).toBe('index');
    expect(page.html).toContain('<!DOCTYPE html>');
    // The element is named from the workspace's own bytes, so two diagrams' bundles never define one element twice.
    expect(page.html).toMatch(/<madarch-graph-[0-9a-f]{12}-view view-id="index"><\/madarch-graph-[0-9a-f]{12}-view>/);
    expect(page.html).toContain(`<script src="/api/graph/likec4.js?id=${encodeURIComponent(fx.shop.id)}&type=c4-context"></script>`);
    // A browser where LikeC4 draws nothing is told so, rather than shown an empty frame.
    expect(page.html).toContain('data-likec4-undrawn');
    // The watchdog reads the whole composed tree: LikeC4 draws into a shadow root inside one, and a page that asked
    // the element's own shadow root would announce a drawing nobody lacks (madarch-pdkl).
    expect(page.html).toContain(`var likec4Drawings = ${LIKEC4_DRAWINGS_SOURCE};`);
    // The page asks that walk about the element it carries, and takes the sentence away when a drawing appears: what
    // the page does with the answer, not which line of the script spells it.
    expect(page.html).toContain('likec4Drawings(element)');
    expect(page.html).toContain('if (said) said.remove();');
    expect(page.html).toContain('C4 context: the whole product');
  });
});

describe('which diagrams a page draws', () => {
  test('by the kind: a repository draws five, a container its own, and a symbol no spec until its interactions are read', () => {
    const repository = diagramSpecsFor({ kind: 'repository', id: 'repository:1', moduleScopes: undefined });
    expect(repository.map((spec) => spec.type)).toEqual(['c4-context', 'c4-container', 'c4-component', 'module-dependency', 'er']);
    expect(repository[0]!.nodes).toEqual([]);
    expect(repository.slice(1).map((spec) => spec.nodes)).toEqual([['repository:1'], ['repository:1'], ['repository:1'], ['repository:1']]);
    // A repository whose real structure stands below a single top-level module draws that level in both module views
    // (madarch-tzte.23.7): the scope is the module whose children are the first level with more than one.
    expect(diagramSpecsFor({ kind: 'repository', id: 'repository:1', moduleScopes: { view: ['module:1'], neighbours: [] } }).map((spec) => [spec.type, spec.nodes])).toEqual([
      ['c4-context', []],
      ['c4-container', ['repository:1']],
      ['c4-component', ['module:1']],
      ['module-dependency', ['module:1']],
      ['er', ['repository:1']],
    ]);
    expect(diagramSpecsFor({ kind: 'package', id: 'package:1', moduleScopes: undefined })).toEqual([{ type: 'c4-container', nodes: ['package:1'] }]);
    expect(diagramSpecsFor({ kind: 'deploy-unit', id: 'deploy-unit:1', moduleScopes: undefined })).toEqual([{ type: 'c4-container', nodes: ['deploy-unit:1'] }]);
    expect(diagramSpecsFor({ kind: 'table', id: 'table:1', moduleScopes: undefined }).map((spec) => spec.type)).toEqual(['er', 'c4-container']);
    // A column is drawn by its table's ER view, and by its repository's when the graph holds no such table.
    expect(diagramSpecsFor({ kind: 'column', id: 'column:1', tableId: 'table:1', moduleScopes: undefined })).toEqual([{ type: 'er', nodes: ['table:1'] }]);
    expect(diagramSpecsFor({ kind: 'column', id: 'column:1', repositoryId: 'repository:1', moduleScopes: undefined })).toEqual([{ type: 'er', nodes: ['repository:1'] }]);
    expect(diagramSpecsFor({ kind: 'column', id: 'column:1', moduleScopes: undefined })).toEqual([]);
    // A module is its own child modules beside the modules it relates to, a state by its machine, and a symbol by no
    // spec of its own: its sequence is made once the graph answers which interactions name it (`readNodeDiagrams`).
    // A module's own child modules are its component view; the second view is its children again when it relates to no
    // module of its level, and the page keeps one view when it holds no child module either — two diagrams of one box
    // say nothing twice.
    expect(diagramSpecsFor({ kind: 'module', id: 'module:1', repositoryId: 'repository:1', moduleScopes: { childModules: true } })).toEqual([
      { type: 'c4-component', nodes: ['module:1'] },
      { type: 'module-dependency', nodes: ['module:1'] },
    ]);
    expect(diagramSpecsFor({ kind: 'module', id: 'module:1', repositoryId: 'repository:1', moduleScopes: { neighbours: [], childModules: false } })).toEqual([{ type: 'c4-component', nodes: ['module:1'] }]);
    // A caller that read no scope draws the module's component view alone, and a module naming no repository is still
    // drawn: neither view the two specs of a module is made of reads the repository's own fact.
    expect(diagramSpecsFor({ kind: 'module', id: 'module:1', repositoryId: 'repository:1', moduleScopes: undefined })).toEqual([{ type: 'c4-component', nodes: ['module:1'] }]);
    expect(diagramSpecsFor({ kind: 'module', id: 'module:1', moduleScopes: undefined })).toEqual([{ type: 'c4-component', nodes: ['module:1'] }]);
    // A module with neighbours is drawn as itself among them: no child of its scope holds a neighbour, so the view
    // names the modules it draws.
    expect(diagramSpecsFor({ kind: 'module', id: 'module:1', repositoryId: 'repository:1', moduleScopes: { neighbours: ['module:2'] } })).toEqual([
      { type: 'c4-component', nodes: ['module:1'] },
      { type: 'module-dependency', nodes: ['module:1', 'module:2'], level: 0 },
    ]);
    expect(diagramSpecsFor({ kind: 'state', id: 'state:1', moduleScopes: undefined })).toEqual([{ type: 'state', nodes: ['state:1'] }]);
    expect(diagramSpecsFor({ kind: 'symbol', id: 'symbol:1', moduleScopes: undefined })).toEqual([]);
    expect(diagramSpecsFor({ kind: 'api-endpoint', id: 'api-endpoint:1', repositoryId: 'repository:1', moduleScopes: undefined })).toEqual([{ type: 'c4-container', nodes: ['repository:1'] }]);
    // A question, a rule and an entity proposal stand in no diagram of 0026's seven.
    expect(diagramSpecsFor({ kind: 'question', id: 'question:1', repositoryId: 'repository:1', moduleScopes: undefined })).toEqual([]);
    expect(diagramSpecsFor({ kind: 'rule', id: 'rule:1', moduleScopes: undefined })).toEqual([]);
  });
});

describe('the archify document of a diagram', () => {
  test('a connection the model draws dashed is the archify document own dashed variant', async () => {
    const model = await buildDiagram({ type: 'c4-component', nodes: [fx.shop.id] }, clean);
    // The shop's two modules are joined by an import (a fact) and by an interaction (an assumption): the folded
    // arrow is dashed, and the document says so where the layout's own ends meet.
    const held = diagramWorkspace(model, { pageAddress: (id) => `/p/graph/${id}` });
    const layout = { id: held.viewId, title: model.title, nodes: model.elements.map((element, at) => ({ id: `n${String(at)}`, kind: element.kind ?? 'external', title: element.label, parent: null, x: at * 200, y: 0, width: 180, height: 60 })), edges: model.edges.map((edge) => ({ source: held.elementIds.get(edge.from)!, target: held.elementIds.get(edge.to)! })) };
    const dashed = new Set(model.edges.filter((edge) => edge.dashed).map((edge) => `${held.elementIds.get(edge.from)!}\u0000${held.elementIds.get(edge.to)!}`));
    const document = archifyDocument(layout, { output: 'graph-diagram.html', dashed });
    expect(document.connections.length).toBe(model.edges.length);
    expect(document.connections.every((connection) => connection.variant === 'dashed')).toBe(true);
  });
});

describe('the archify page of a diagram', () => {
  test('the page the server renders carries the model own dashes and root-relative links to the element pages', async () => {
    // The real seam: the workspace, LikeC4's layout of it, the archify document and the vendored renderer.
    const model = await buildDiagram({ type: 'c4-component', nodes: [fx.shop.id] }, clean);
    const page = await graphArchifyPage(model, { env: process.env });
    expect(page.ok).toBe(true);
    const html = page.ok ? page.html : '';
    // A dashed connection is the renderer's own dashed class, and every element's page is a root-relative anchor
    // (`="/p/graph/…`), which a products home prefixes once by rewriting `="/`.
    expect(html).toContain('a-dashed');
    expect(html).toMatch(/href="\/p\/graph\/module:[0-9a-f]{64}"/);
    expect(html).not.toContain('/products/');
  }, 300_000);
});
