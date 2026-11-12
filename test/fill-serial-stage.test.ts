import { expect, test } from 'bun:test';
import { Type } from 'typebox';
import { deriveStageGraph, StageRegistry } from '../src/fill/registry.js';
import { DEFAULT_STAGE_DEFAULTS } from '../src/fill/stage.js';

test('a stage that publishes in plan order refuses concurrent configuration rather than weakening its order', () => {
  const registry = new StageRegistry().register({
    id: 'ordered', version: 1, maxConcurrency: 1,
    consumes: { required: [], optional: [] }, produces: [], configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, concurrency: 1, config: {} },
    plan: () => ({ units: [] }), execute: () => ({ outcome: 'draft' }), validate: () => ({ ok: true }),
  });
  expect(deriveStageGraph(registry).ok).toBe(true);
  const read = deriveStageGraph(registry, { ok: true, file: '/product/madarch/fill.yaml', stages: { ordered: { concurrency: 2 } }, lines: { ordered: 4 } });
  expect(read.ok).toBe(false);
  if (read.ok) throw new Error('concurrent execution was accepted');
  expect(read.problems).toEqual([expect.objectContaining({ file: '/product/madarch/fill.yaml', path: 'fill.stages.ordered.concurrency', message: expect.stringContaining('at most 1') })]);
});
