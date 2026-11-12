/**
 * The `madarch/workflows.yaml` a fixture product needs (decision 0033, items 1
 * and 2): a fill runs the stages the product's `first-fill` workflow names, and a
 * fixture product written by hand holds the starter set's own first fill — the
 * one `madarch init` writes — so the fixture runs the stages the engine ships.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STARTER_WORKFLOWS } from '../src/knowledge/starter-workflows.js';
import { useRepositoryPlugins } from './enabled-plugins-fixture.js';

/** Writes the starter set's `first-fill` workflow into a product folder. */
export function writeFirstFillWorkflow(folder: string): void {
  useRepositoryPlugins(folder);
  const workflow = STARTER_WORKFLOWS.find((candidate) => candidate.name === 'first-fill');
  if (workflow === undefined) throw new Error('the engine\'s starter set holds no first-fill workflow');
  mkdirSync(join(folder, 'madarch'), { recursive: true });
  writeFileSync(join(folder, 'madarch', 'workflows.yaml'), `workflows:\n  first-fill:\n    status: implemented\n    stages:\n${workflow.stages.map((stage) => `      - ${stage}`).join('\n')}\n`);
}
