/**
 * One fake fill stage, as one module: the stage registry test adds it with
 * nothing but its registration, which is what decision 0027 promises a stage
 * costs. It stands in for a later agent stage: it consumes the fact kind a
 * deterministic stage produces, orders itself after a stage it shares no
 * capability with, and carries its own configuration schema.
 */
import { Type } from 'typebox';
import { DEFAULT_STAGE_DEFAULTS, type FillStage } from '../src/fill/stage.js';

/** The fixture stage the registry test registers by importing this module. */
export const summaryStage: FillStage = {
  id: 'summary',
  version: 3,
  consumes: {
    required: [{ capability: 'module-facts', scope: 'repository', freshness: 'current' }],
    optional: [{ capability: 'history', scope: 'repository' }],
  },
  produces: [{ kind: 'module-summaries', schemaVersion: 2, scope: 'repository' }],
  after: ['snapshot'],
  configSchema: Type.Object({ maxDepth: Type.Integer({ minimum: 1 }) }),
  defaults: { enabled: true, concurrency: 2, limits: DEFAULT_STAGE_DEFAULTS.limits, config: { maxDepth: 3 } },
  plan: () => ({ units: [], coverage: 'planned' }),
  execute: () => ({ outcome: 'draft' }),
  validate: () => ({ ok: true }),
};
