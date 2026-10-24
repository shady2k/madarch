
import { describe, expect, test } from 'bun:test';
import { LikeC4 } from 'likec4';
import { diagramWorkspace } from '../src/product-wiki/graph-workspace.js';
import { shapeOf } from '../src/knowledge/views.js';
import type { GraphView } from '../src/knowledge/views.js';

/** One model per view type, each with an element that holds another and a dashed arrow: the shapes that broke the DSL. */
const nested = (type: string): GraphView => ({
  spec: { type: type as never, subject: '' },
  title: `The ${type} view`,
  label: type,
  elements: [
    { id: 'a', label: 'shop', kind: 'product', href: null, dashed: false },
    { id: 'b', label: 'payment', kind: 'domain', detail: 'a domain', href: null, dashed: false, parent: 'a' },
    { id: 'c', label: 'payments', kind: 'service', detail: 'TypeScript', href: null, dashed: false, parent: 'b' },
    { id: 'd', label: 'orders', kind: 'database', href: null, dashed: false },
  ],
  edges: [
    { from: 'c', to: 'd', label: 'SQL', dashed: false },
    { from: 'b', to: 'c', label: 'implemented by', dashed: true, why: 'the agent read it' },
  ],
  notes: [],
  empty: null,
  marker: null,
});

const VIEW_TYPES = ['c4-context', 'c4-container', 'c4-component', 'sequence', 'er', 'state', 'deployment', 'domain', 'domain-map'];

describe('the LikeC4 workspace of every view type', () => {
  for (const type of VIEW_TYPES) {
    test(`the ${type} view's DSL parses with LikeC4's own language services`, async () => {
      const held = diagramWorkspace(shapeOf(nested(type)), { pageAddress: () => '/k/e/x' });
      expect(held.workspace).not.toContain('include **');
      // Flat elements: a holder and what it holds are joined by an arrow, which LikeC4 refuses for a parent and its child.
      expect(held.workspace).not.toMatch(/^\s+n\d+ = \w+ "[^"]*" \{$/m);
      let likec4: Awaited<ReturnType<typeof LikeC4.fromSource>> | undefined;
      try {
        likec4 = await LikeC4.fromSource(held.workspace, { logger: false, printErrors: false, throwIfInvalid: true });
        const diagrams = await likec4.diagrams();
        expect(diagrams.map((diagram) => String(diagram.id))).toContain(held.viewId);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`the ${type} view's DSL does not parse: ${reason}\n${held.workspace.split('\n').map((line, at) => `${at + 1}: ${line}`).join('\n')}`);
      } finally {
        await likec4?.[Symbol.asyncDispose]?.();
      }
    }, 60_000);
  }
});
