import { expect, test } from 'bun:test';
import { fillSteps } from '../src/fill/steps.js';
import { createEngineStageRegistry, createStageRegistry } from '../src/fill/stages/index.js';
import { STARTER_WORKFLOWS } from '../src/knowledge/starter-workflows.js';
import { parseWorkflows } from '../src/product/manifest/workflows.js';

test('ordinary declared plugins are the only executable engine stage', () => {
  expect(fillSteps()).toEqual(['plugin-turns']);
  expect(createEngineStageRegistry().all().map((stage) => stage.id)).toEqual(['plugin-turns']);
  expect(createStageRegistry({}).all()).toEqual([]);
  expect(STARTER_WORKFLOWS.find((workflow) => workflow.name === 'first-fill')?.stages).toEqual(['plugin-turns']);
});

test('native repository passes cannot be enabled as workflow stages', () => {
  const parsed = parseWorkflows('workflows:\n  first-fill:\n    status: implemented\n    stages: [repository-tree, repository-history]\n', '/product/madarch/workflows.yaml');
  expect(parsed.workflows.size).toBe(0);
  expect(parsed.findings).toHaveLength(2);
  expect(parsed.findings.map((finding) => finding.message)).toEqual([
    'workflow "first-fill" stage "repository-history": the engine\'s stage registry holds no stage "repository-history" (its stages are plugin-turns)',
    'workflow "first-fill" stage "repository-tree": the engine\'s stage registry holds no stage "repository-tree" (its stages are plugin-turns)',
  ]);
});
