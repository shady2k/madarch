import { describe, expect, test } from 'bun:test';
import { layered, layoutNeighborhood, layoutTreemap, mergeHood, NODE_H, NODE_W, textWidth, fit } from './layout.js';
import type { Neighborhood } from '../types.js';

const node = (id: string, hops = 1) => ({ id, kind: 'code.symbol', label: id, href: `/k/e/${id}`, hops });
const HOOD: Neighborhood = {
  center: 'c',
  nodes: [node('c', 0), node('caller1'), node('caller2'), node('callee1'), node('callee2'), node('table'), node('callerOfCaller', 2)],
  edges: [
    { from: 'caller1', to: 'c', relation: 'code.calls', count: 1 },
    { from: 'caller2', to: 'c', relation: 'code.calls', count: 2 },
    { from: 'c', to: 'callee1', relation: 'code.calls', count: 1 },
    { from: 'c', to: 'callee2', relation: 'code.calls', count: 1 },
    { from: 'c', to: 'table', relation: 'code.writes-table', count: 1 },
    { from: 'callerOfCaller', to: 'caller1', relation: 'code.calls', count: 1 },
  ],
  more: [{ node: 'c', relation: 'code.calls', direction: 'out', hidden: 5 }],
  relations: [{ relation: 'code.calls', direction: 'in', count: 2 }, { relation: 'code.calls', direction: 'out', count: 7 }, { relation: 'code.writes-table', direction: 'out', count: 1 }],
};

describe('the neighbourhood layout', () => {
  test('what comes in stands left of the entity, what goes out right of it, grouped by relation, and nothing overlaps', () => {
    const layout = layoutNeighborhood(HOOD, { depth: 1, off: new Set() });
    const at = new Map(layout.nodes.map((placed) => [placed.node.id, placed]));
    expect(at.get('caller1')!.column).toBe(-1);
    expect(at.get('caller2')!.column).toBe(-1);
    expect(at.get('callee1')!.column).toBe(1);
    expect(at.get('table')!.column).toBe(1);
    expect(at.has('callerOfCaller')).toBe(false);
    expect(at.get('caller1')!.x).toBeLessThan(at.get('c')!.x);
    expect(at.get('callee1')!.x).toBeGreaterThan(at.get('c')!.x + NODE_W);
    // The "+5 more" chip stands in the outgoing column under the calls it belongs to.
    const chip = layout.nodes.find((placed) => placed.more !== undefined)!;
    expect(chip.column).toBe(1);
    expect(chip.node.label).toBe('+5');
    // No two boxes of one column overlap.
    for (const a of layout.nodes) for (const b of layout.nodes) {
      if (a === b || a.column !== b.column) continue;
      expect(a.y + NODE_H <= b.y || b.y + NODE_H <= a.y).toBe(true);
    }
    // The groups are headed by their relation.
    expect(layout.groups.map((group) => group.label)).toEqual(expect.arrayContaining(['calls →', '→ calls', '→ writes-table']));
  });

  test('depth two reaches the callers of a caller on the left, and a switched-off relation takes its nodes away', () => {
    const two = layoutNeighborhood(HOOD, { depth: 2, off: new Set() });
    expect(two.nodes.find((placed) => placed.node.id === 'callerOfCaller')!.column).toBe(-2);
    const without = layoutNeighborhood(HOOD, { depth: 2, off: new Set(['code.calls|in']) });
    expect(without.nodes.some((placed) => placed.node.id === 'caller1')).toBe(false);
    expect(without.nodes.some((placed) => placed.node.id === 'callerOfCaller')).toBe(false);
    expect(without.nodes.some((placed) => placed.node.id === 'callee1')).toBe(true);
  });

  test('a node the reader opened shows its neighbours on both sides of it, and a switched-off relation takes its edges too', () => {
    const hood: Neighborhood = {
      center: 'c',
      nodes: [node('c', 0), node('a'), node('b', 2)],
      edges: [{ from: 'c', to: 'a', relation: 'code.calls', count: 1 }, { from: 'b', to: 'a', relation: 'code.calls', count: 1 }, { from: 'c', to: 'a', relation: 'code.contains', count: 1 }],
      more: [],
      relations: [],
    };
    expect(layoutNeighborhood(hood, { depth: 2, off: new Set() }).nodes.some((placed) => placed.node.id === 'b')).toBe(false);
    const opened = layoutNeighborhood(hood, { depth: 2, off: new Set() }, new Set(['a']));
    expect(opened.nodes.find((placed) => placed.node.id === 'b')!.column).toBe(1);
    const off = layoutNeighborhood(hood, { depth: 1, off: new Set(['code.calls|out']) });
    expect(off.edges.map((edge) => edge.relation)).toEqual(['code.contains']);
  });

  test('merging what a click opens adds nodes at one hop more and replaces the answered more-chip', () => {
    const extra: Neighborhood = { center: 'callee1', nodes: [node('callee1', 0), node('deeper')], edges: [{ from: 'callee1', to: 'deeper', relation: 'code.calls', count: 1 }], more: [], relations: [] };
    const merged = mergeHood(HOOD, extra);
    expect(merged.nodes.find((entry) => entry.id === 'deeper')!.hops).toBe(2);
    expect(merged.edges).toHaveLength(HOOD.edges.length + 1);
    const answered = mergeHood(HOOD, { center: 'c', nodes: [node('c', 0), node('callee9')], edges: [{ from: 'c', to: 'callee9', relation: 'code.calls', count: 1 }], more: [], relations: [] }, { node: 'c', relation: 'code.calls', direction: 'out' });
    expect(answered.more).toEqual([]);
  });
});

describe('the layered graph', () => {
  test('layers follow the edges left to right and a cycle is cut at one edge that is told as backward', () => {
    const nodes = ['a', 'b', 'c', 'd'].map((id) => ({ id, w: 100, h: 30 }));
    const { placed, back } = layered(nodes, [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'b' }, { from: 'a', to: 'd' }], { gapX: 40, gapY: 10 });
    expect(placed.get('a')!.layer).toBe(0);
    expect(placed.get('b')!.layer).toBe(1);
    expect(placed.get('c')!.layer).toBe(2);
    expect(placed.get('d')!.layer).toBe(1);
    expect([...back]).toEqual(['c|b']);
    const column = [...placed.values()].filter((box) => box.layer === 1).sort((a, b) => a.y - b.y);
    expect(column[0]!.y + column[0]!.h).toBeLessThanOrEqual(column[1]!.y);
  });
});

describe('the treemap layout', () => {
  test('files get areas in proportion to their lines, inside the frame, without overlapping', () => {
    const leaves = [
      { id: '1', name: 'a.ts', path: 'src/a.ts', value: 300, data: null },
      { id: '2', name: 'b.ts', path: 'src/b.ts', value: 100, data: null },
      { id: '3', name: 'c.ts', path: 'test/c.ts', value: 100, data: null },
      { id: '4', name: 'd.ts', path: 'd.ts', value: 50, data: null },
    ];
    const cells = layoutTreemap(leaves, 600, 300);
    const files = cells.filter((cell) => cell.leaf !== undefined);
    expect(files).toHaveLength(4);
    for (const cell of files) {
      expect(cell.x).toBeGreaterThanOrEqual(0);
      expect(cell.y).toBeGreaterThanOrEqual(0);
      expect(cell.x + cell.w).toBeLessThanOrEqual(600.001);
      expect(cell.y + cell.h).toBeLessThanOrEqual(300.001);
    }
    const area = (id: string): number => { const cell = files.find((entry) => entry.leaf!.id === id)!; return cell.w * cell.h; };
    expect(area('1') / area('2')).toBeGreaterThan(2.5);
    expect(area('1') / area('2')).toBeLessThan(3.5);
    for (const a of files) for (const b of files) {
      if (a === b) continue;
      const apart = a.x + a.w <= b.x + 0.001 || b.x + b.w <= a.x + 0.001 || a.y + a.h <= b.y + 0.001 || b.y + b.h <= a.y + 0.001;
      expect(apart).toBe(true);
    }
  });
});

describe('text measure', () => {
  test('a text is cut to the width it is given and the cut ends in an ellipsis', () => {
    expect(fit('PaymentRepository.findByIdempotencyKey', 120).endsWith('…')).toBe(true);
    expect(textWidth(fit('PaymentRepository.findByIdempotencyKey', 120))).toBeLessThanOrEqual(120);
    expect(fit('short', 120)).toBe('short');
  });
});
