/**
 * Strongly connected components of a directed graph, computed without
 * recursion so a long import chain cannot exhaust the stack. A component of
 * two or more nodes is an import cycle; a node with an edge to itself is not
 * reported (a module that imports its own folder is not a cycle between
 * modules).
 */
import { byCodePoint } from '../../model/order.js';

export function cycles(nodes: readonly string[], edges: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  const order = [...nodes].sort(byCodePoint);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const found: string[][] = [];
  let counter = 0;
  for (const start of order) {
    if (index.has(start)) continue;
    const work: { node: string; next: string[]; at: number }[] = [];
    const enter = (node: string): void => {
      index.set(node, counter);
      low.set(node, counter);
      counter += 1;
      stack.push(node);
      onStack.add(node);
      work.push({ node, next: [...(edges.get(node) ?? [])].sort(byCodePoint), at: 0 });
    };
    enter(start);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      if (frame.at < frame.next.length) {
        const target = frame.next[frame.at]!;
        frame.at += 1;
        if (!index.has(target)) enter(target);
        else if (onStack.has(target)) low.set(frame.node, Math.min(low.get(frame.node)!, index.get(target)!));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        for (;;) {
          const member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
          if (member === frame.node) break;
        }
        if (component.length > 1) found.push(component.sort(byCodePoint));
      }
    }
  }
  return found.sort((left, right) => byCodePoint(left[0]!, right[0]!));
}
