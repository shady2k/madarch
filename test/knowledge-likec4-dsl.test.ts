
import { describe, expect, test } from 'bun:test';
import { LikeC4 } from 'likec4';
import { workspaceOf } from '../src/knowledge/view-frames.js';
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
    { from: 'c', to: 'd', label: 'might read', dashed: true, why: 'the agent read it' },
  ],
  notes: [],
  empty: null,
  marker: null,
});

const VIEW_TYPES = ['c4-context', 'c4-container', 'c4-component', 'sequence', 'er', 'state', 'deployment', 'domain', 'domain-map'];

describe('the LikeC4 workspace of every view type', () => {
  for (const type of VIEW_TYPES) {
    test(`the ${type} view's DSL parses with LikeC4's own language services`, async () => {
      // The production path preserves real domain/deployment ownership; relationships name leaves, not ancestors.
      const held = workspaceOf(nested(type));
      expect(held.workspace).not.toContain('include **');
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


test('LikeC4 refuses an actual ancestor-to-child relation rather than flattening ownership', async () => {
  const view = nested('domain-map');
  view.edges = [{ from: 'b', to: 'c', label: 'invalid ownership arrow', dashed: false }];
  const held = workspaceOf(view);
  let model: Awaited<ReturnType<typeof LikeC4.fromSource>> | undefined;
  try {
    await expect((async () => {
      model = await LikeC4.fromSource(held.workspace, { logger: false, printErrors: false, throwIfInvalid: true });
      await model.diagrams();
    })()).rejects.toThrow();
  } finally { await model?.[Symbol.asyncDispose]?.(); }
}, 60_000);
