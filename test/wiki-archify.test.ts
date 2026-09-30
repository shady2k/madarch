import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archifyDocument, archifyPageLinks, componentId } from '../src/wiki/archify.js';

/**
 * The archify document a wiki view builds into (madarch-7br.3.1): a pure
 * function of the layouted view LikeC4 produced, so the same view always
 * gives the same document — every leaf node a component at LikeC4's
 * position and size, every group node a boundary wrapping the leaves
 * beneath it, every edge a connection with its label. The rendered page
 * is then linked: a component whose element has a view of its own becomes
 * a link to that view's archify page. Here the layout is the fixture; the
 * LikeC4 call that produces it is the build's business, not this one.
 */

const checkout = {
  id: 'ordering',
  title: 'Ordering',
  nodes: [
    { id: 'storefront', kind: 'domain', title: 'Storefront', parent: null, x: 3626, y: 0, width: 320, height: 180 },
    { id: 'ordering', kind: 'domain', title: 'Ordering', parent: null, x: 2050, y: 271, width: 2550, height: 927 },
    { id: 'ordering.checkout-api', kind: 'service', title: 'Checkout', parent: 'ordering', x: 2520, y: 332, width: 320, height: 180 },
    { id: 'ordering.cart-cache', kind: 'store', title: 'Cart cache', parent: 'ordering', x: 2520, y: 655, width: 320, height: 180 },
  ],
  edges: [
    { source: 'storefront', target: 'ordering.checkout-api', label: 'checks out the cart' },
    { source: 'ordering.checkout-api', target: 'ordering.cart-cache' },
  ],
} as const;

function documentOf(view: Parameters<typeof archifyDocument>[0], output = 'assets/archify/ordering.html'): string {
  return JSON.stringify(archifyDocument(view, { output }));
}

describe('src/wiki/archify.ts', () => {
  test('a component per leaf node, at LikeC4 position and size, kinds mapped, sorted by id', () => {
    const document = archifyDocument(checkout, { output: 'assets/archify/ordering.html' });
    expect(document.components).toEqual([
      { id: 'ordering__cart-cache', type: 'database', label: 'Cart cache', sublabel: 'store', pos: [2520, 655], size: [320, 180] },
      { id: 'ordering__checkout-api', type: 'backend', label: 'Checkout', sublabel: 'service', pos: [2520, 332], size: [320, 180] },
      { id: 'storefront', type: 'external', label: 'Storefront', sublabel: 'domain', pos: [3626, 0], size: [320, 180] },
    ]);
  });

  test('every madarch element kind maps to the archify type the legend draws', () => {
    const kindToType: ReadonlyArray<readonly [string, string, string | undefined]> = [
      ['person', 'external', 'person'],
      ['external', 'external', undefined],
      ['domain', 'external', undefined],
      ['system', 'external', undefined],
      ['service', 'backend', undefined],
      ['module', 'backend', undefined],
      ['store', 'database', undefined],
      ['broker', 'messagebus', undefined],
    ];
    for (const [kind, type, icon] of kindToType) {
      const document = archifyDocument(
        { id: 'v', title: 'V', nodes: [{ id: 'n', kind, title: 'N', parent: null, x: 0, y: 0, width: 320, height: 180 }], edges: [] },
        { output: 'v.html' },
      );
      expect(document.components[0]?.type).toBe(type);
      expect(document.components[0]?.icon).toBe(icon);
    }
  });

  test('component ids stay injective when dots become double underscores', () => {
    expect(componentId('ordering.checkout-api')).toBe('ordering__checkout-api');
    expect(componentId('ordering_checkout-api')).toBe('ordering_checkout-api');
    expect(componentId('a.b')).not.toBe(componentId('a_b'));
  });

  test('a boundary per group node, wrapping every leaf beneath it — the group itself is no component', () => {
    const document = archifyDocument(checkout, { output: 'assets/archify/ordering.html' });
    expect(document.boundaries).toEqual([{ kind: 'region', label: 'Ordering', wraps: ['ordering__cart-cache', 'ordering__checkout-api'] }]);
    expect(document.components.map((component) => component.id)).not.toContain('ordering');
  });

  test('nested groups each wrap their own leaves, the child frame fully inside the parent one', () => {
    const document = archifyDocument(
      {
        id: 'v',
        title: 'V',
        nodes: [
          { id: 'outer', kind: 'domain', title: 'Outer', parent: null, x: 0, y: 0, width: 1200, height: 600 },
          { id: 'outer.inner', kind: 'domain', title: 'Inner', parent: 'outer', x: 40, y: 61, width: 500, height: 300 },
          { id: 'outer.inner.leaf', kind: 'service', title: 'Leaf', parent: 'outer.inner', x: 80, y: 122, width: 320, height: 180 },
          { id: 'outer.side', kind: 'store', title: 'Side', parent: 'outer', x: 600, y: 122, width: 320, height: 180 },
        ],
        edges: [],
      },
      { output: 'v.html' },
    );
    expect(document.boundaries).toEqual([
      { kind: 'region', label: 'Inner', wraps: ['outer__inner__leaf'] },
      { kind: 'region', label: 'Outer', wraps: ['outer__inner__leaf', 'outer__side'] },
    ]);
    expect(document.components.map((component) => component.id).sort()).toEqual(['outer__inner__leaf', 'outer__side']);
  });

  test('a connection per edge, endpoints remapped, its label only when the layout carries one', () => {
    const document = archifyDocument(checkout, { output: 'assets/archify/ordering.html' });
    expect(document.connections).toEqual([
      { from: 'ordering__checkout-api', to: 'ordering__cart-cache' },
      { from: 'storefront', to: 'ordering__checkout-api', label: 'checks out the cart' },
    ]);
  });

  test('the document is exactly the schema shape: version, type, meta, and nothing else', () => {
    const document = archifyDocument(checkout, { output: 'assets/archify/ordering.html' });
    expect(Object.keys(document).sort()).toEqual(['boundaries', 'components', 'connections', 'diagram_type', 'meta', 'schema_version']);
    expect(document.schema_version).toBe(1);
    expect(document.diagram_type).toBe('architecture');
    expect(document.meta).toEqual({ title: 'Ordering', output: 'assets/archify/ordering.html' });
  });

  test('the same view gives the same bytes, whatever the order the layout listed nodes in', () => {
    const reordered = { ...checkout, nodes: [...checkout.nodes].reverse(), edges: [...checkout.edges].reverse() };
    expect(documentOf(reordered)).toBe(documentOf(checkout));
  });

  test('a node LikeC4 did not lay out is refused naming the view and the node', () => {
    const unplaced = {
      ...checkout,
      nodes: [{ id: 'ordering.checkout-api', kind: 'service', title: 'Checkout', parent: null, x: Number.NaN, y: 0, width: 320, height: 180 }],
    };
    expect(() => archifyDocument(unplaced as unknown as typeof checkout, { output: 'v.html' })).toThrow(/ordering\.checkout-api/);
    expect(() => archifyDocument(unplaced as unknown as typeof checkout, { output: 'v.html' })).toThrow(/did not lay out|not laid out/);
  });

  test('a node without a title is refused naming it, an unknown edge endpoint naming the view and both ids', () => {
    const untitled = {
      id: 'v',
      title: 'V',
      nodes: [{ id: 'n', kind: 'service', title: '', parent: null, x: 0, y: 0, width: 320, height: 180 }],
      edges: [],
    };
    expect(() => archifyDocument(untitled, { output: 'v.html' })).toThrow(/"n"/);
    const dangling = { ...checkout, edges: [{ source: 'ghost', target: 'storefront', label: 'x' }] };
    expect(() => archifyDocument(dangling, { output: 'v.html' })).toThrow(/ghost/);
  });

  test('a node under a parent the view does not hold is refused naming both', () => {
    const orphaned = {
      id: 'v',
      title: 'V',
      nodes: [{ id: 'n', kind: 'service', title: 'N', parent: 'ghost', x: 0, y: 0, width: 320, height: 180 }],
      edges: [],
    };
    expect(() => archifyDocument(orphaned, { output: 'v.html' })).toThrow(/ghost/);
  });

  test('an edge naming a group frame is refused naming the view, a frame being no component', () => {
    const grouped = { ...checkout, edges: [{ source: 'ordering', target: 'storefront', label: 'x' }] };
    expect(() => archifyDocument(grouped, { output: 'v.html' })).toThrow(/"ordering"/);
    expect(() => archifyDocument(grouped, { output: 'v.html' })).toThrow(/group/);
  });

  test(
    'the vendored renderer accepts the document of a representative nested view',
    () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-archify-test-'));
    try {
      const document = archifyDocument(checkout, { output: 'assets/archify/ordering.html' });
      const input = join(folder, 'ordering.json');
      const output = join(folder, 'ordering.html');
      writeFileSync(input, JSON.stringify(document));
      const run = spawnSync('node', ['vendor/archify/renderers/architecture/render-architecture.mjs', input, output], { encoding: 'utf8' });
      expect(run.status).toBe(0);
      // The renderer reports the page it wrote, and refuses with its
      // validation problems on stderr — a failure never looks like a pass.
      expect(run.stdout).toContain('ordering.html');
      expect(run.stderr).toBe('');
      const html = readFileSync(output, 'utf8');
      expect(html).toContain('<svg');
      expect(html).toContain('data-node-id="ordering__checkout-api"');
      expect(html).not.toContain('data-node-id="ordering"');
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
    },
    { timeout: 60_000 },
  );

  test('a rendered page links a component with a view of its own to that view page', () => {
    // One component group with the nested mark the renderer draws inside.
    const html = [
      '      <g id="node-storefront" data-node-id="storefront" tabindex="0" role="button" aria-label="Storefront" aria-pressed="false">',
      '        <g id="sigil"><rect x="3632" y="6" width="12" height="12"/></g>',
      '        <text data-node-label="" x="3786" y="90">Storefront</text>',
      '      </g>',
      '      <g id="node-ordering__checkout-api" data-node-id="ordering__checkout-api" tabindex="0" role="button" aria-label="Checkout" aria-pressed="false">',
      '        <text data-node-label="" x="2680" y="422">Checkout</text>',
      '      </g>',
    ].join('\n');
    const linked = archifyPageLinks(html, { 'ordering__checkout-api': 'checkout-api.html' });
    expect(linked).toContain('<a href="checkout-api.html" data-wiki-view="ordering__checkout-api"><g id="node-ordering__checkout-api"');
    expect(linked).toContain('</g></a>');
    expect(linked).toContain('<g id="node-storefront"');
    // The other component stays outside any anchor, and the document is
    // otherwise byte-for-byte what the renderer wrote.
    expect(linked.replace(/<a href="checkout-api\.html" data-wiki-view="ordering__checkout-api">/, '').replace('</g></a>', '</g>')).toBe(html);
  });

  test('a link naming an id the page does not carry is refused naming it', () => {
    expect(() => archifyPageLinks('<g id="node-storefront"></g>', { ghost: 'g.html' })).toThrow(/ghost/);
  });

  test('a truncated page with no closing tag for a component is refused, never half-linked', () => {
    expect(() => archifyPageLinks('<g id="node-storefront" data-node-id="storefront">', { storefront: 's.html' })).toThrow(/storefront/);
    expect(() => archifyPageLinks('<g id="node-storefront" data-node-id="storefront">', { storefront: 's.html' })).toThrow(/truncated/);
  });

  test('two links land in code-point order, one input one output', () => {
    const html = [
      '<g id="node-zz" data-node-id="zz"><text>ZZ</text></g>',
      '<g id="node-aa" data-node-id="aa"><text>AA</text></g>',
    ].join('\n');
    const linked = archifyPageLinks(html, { zz: 'zz.html', aa: 'aa.html' });
    // The anchors wrap each component where it stands — the links are
    // applied in code-point order, the lines stay in the page's own.
    expect(linked).toBe([
      '<a href="zz.html" data-wiki-view="zz"><g id="node-zz" data-node-id="zz"><text>ZZ</text></g></a>',
      '<a href="aa.html" data-wiki-view="aa"><g id="node-aa" data-node-id="aa"><text>AA</text></g></a>',
    ].join('\n'));
  });

  test("the label's place LikeC4 chose rides onto the connection", () => {
    const document = archifyDocument(
      {
        id: 'v',
        title: 'V',
        nodes: [
          { id: 'a', kind: 'service', title: 'A', parent: null, x: 0, y: 0, width: 320, height: 180 },
          { id: 'b', kind: 'store', title: 'B', parent: null, x: 640, y: 0, width: 320, height: 180 },
        ],
        edges: [{ source: 'a', target: 'b', label: 'syncs', labelAt: [480, 24] }],
      },
      { output: 'v.html' },
    );
    expect(document.connections).toEqual([{ from: 'a', to: 'b', label: 'syncs', labelAt: [480, 24] }]);
  });

  test('connections sharing one endpoint sort by the other, then by label', () => {
    const nodes = [
      { id: 'hub', kind: 'service', title: 'Hub', parent: null, x: 0, y: 0, width: 320, height: 180 },
      { id: 'x', kind: 'store', title: 'X', parent: null, x: 640, y: 0, width: 320, height: 180 },
      { id: 'y', kind: 'store', title: 'Y', parent: null, x: 640, y: 360, width: 320, height: 180 },
    ];
    // The x edges arrive label-reversed: the sort, not the layout's order,
    // must put the alphabetically first label first.
    const document = archifyDocument(
      {
        id: 'v',
        title: 'V',
        nodes,
        edges: [
          { source: 'hub', target: 'y', label: 'same' },
          { source: 'hub', target: 'x', label: 'aaa' },
          { source: 'hub', target: 'x', label: 'same' },
        ],
      },
      { output: 'v.html' },
    );
    expect(document.connections).toEqual([
      { from: 'hub', to: 'x', label: 'aaa' },
      { from: 'hub', to: 'x', label: 'same' },
      { from: 'hub', to: 'y', label: 'same' },
    ]);
    // An unlabeled edge ties as the empty label: before any labeled one
    // on the same ends, whatever order the layout listed them in — three
    // of them, so no two-element accident can produce the same order.
    const mixed = archifyDocument(
      {
        id: 'v',
        title: 'V',
        nodes,
        edges: [
          { source: 'hub', target: 'x', label: 'B' },
          { source: 'hub', target: 'x' },
          { source: 'hub', target: 'x', label: 'A' },
        ],
      },
      { output: 'v.html' },
    );
    expect(mixed.connections).toEqual([
      { from: 'hub', to: 'x' },
      { from: 'hub', to: 'x', label: 'A' },
      { from: 'hub', to: 'x', label: 'B' },
    ]);
  });

  test('a zero-size node is refused like an unplaced one, width or height', () => {
    for (const broken of [
      { id: 'n', kind: 'service', title: 'N', parent: null, x: 0, y: 0, width: 0, height: 180 },
      { id: 'n', kind: 'service', title: 'N', parent: null, x: 0, y: 0, width: 320, height: 0 },
    ]) {
      const flat = { id: 'v', title: 'V', nodes: [broken], edges: [] };
      expect(() => archifyDocument(flat, { output: 'v.html' })).toThrow(/did not lay out|not laid out/);
    }
  });

  test('a kind the mapping does not name draws external, the legend fallback', () => {
    const document = archifyDocument(
      { id: 'v', title: 'V', nodes: [{ id: 'n', kind: 'mystery', title: 'N', parent: null, x: 0, y: 0, width: 320, height: 180 }], edges: [] },
      { output: 'v.html' },
    );
    expect(document.components[0]?.type).toBe('external');
    expect(document.components[0]?.icon).toBeUndefined();
  });

  test('an empty label rides as no label at all', () => {
    const document = archifyDocument(
      {
        id: 'v',
        title: 'V',
        nodes: [
          { id: 'a', kind: 'service', title: 'A', parent: null, x: 0, y: 0, width: 320, height: 180 },
          { id: 'b', kind: 'store', title: 'B', parent: null, x: 640, y: 0, width: 320, height: 180 },
        ],
        edges: [{ source: 'a', target: 'b', label: '' }],
      },
      { output: 'v.html' },
    );
    expect(document.connections).toEqual([{ from: 'a', to: 'b' }]);
  });

  test('a whitespace-only label is refused naming the node', () => {
    const blank = {
      id: 'v',
      title: 'V',
      nodes: [{ id: 'n', kind: 'service', title: '   ', parent: null, x: 0, y: 0, width: 320, height: 180 }],
      edges: [],
    };
    expect(() => archifyDocument(blank, { output: 'v.html' })).toThrow(/"n"/);
  });
});
