/**
 * `check:tests` (decision 0039, section 2): the five rules that hold the test
 * layers' reach, their case bounds, their timing assertions and their catalogue
 * entry points.
 *
 *   bun run check:tests                      the rules over the repository
 *   bun scripts/check-tests.ts --help        this text
 *
 * Today's tree holds no layer folder (`test/unit`, `test/integration`, `test/e2e`,
 * `test/measure`), so every rule finds nothing and the check costs no cruise. The
 * rules apply only to those folders by design: a file stands in a layer only when
 * its rule already passes on it.
 */
import { resolve } from 'node:path';
import { emptyImportGraph, valueImportGraph, type ImportGraph } from './graph.js';
import {
  caseBoundViolations,
  createRuleContext,
  fullCatalogueViolations,
  integrationReachViolations,
  timingViolations,
  unitReachViolations,
} from './rules.js';
import { repositoryRoot } from '../architecture/sources.js';
import {
  TEST_RULES,
  countsByRule,
  orderedTestViolations,
  testProblemLines,
  type TestRule,
  type TestViolation,
} from './violation.js';

export { TEST_RULES, testProblemLines, orderedTestViolations, type TestRule, type TestViolation };

export interface TestsCheckOptions {
  /** The repository or fixture to check; the checkout this module belongs to unless a fixture is checked. */
  readonly root?: string;
  /** The rules to run; all of them unless the caller asks for some. */
  readonly rules?: readonly TestRule[];
}

export interface TestsReport {
  readonly root: string;
  readonly rules: readonly TestRule[];
  readonly violations: readonly TestViolation[];
  readonly counts: ReadonlyMap<TestRule, number>;
}

/** Runs the rules over the repository and answers every violation, in the order messages use. */
export async function testsCheck(options: TestsCheckOptions = {}): Promise<TestsReport> {
  const root = resolve(options.root ?? repositoryRoot());
  const rules = options.rules ?? TEST_RULES;
  const graph: ImportGraph = rules.some((rule) => rule === 'test-unit-reach' || rule === 'test-integration-reach')
    ? await valueImportGraph(root, ['test/unit', 'test/integration', 'test/e2e', 'test/measure'])
    : emptyImportGraph(root);
  const context = createRuleContext(root, graph);
  const found: TestViolation[] = [];
  if (rules.includes('test-unit-reach')) found.push(...unitReachViolations(context));
  if (rules.includes('test-integration-reach')) found.push(...integrationReachViolations(context));
  if (rules.includes('test-case-bound')) found.push(...caseBoundViolations(context));
  if (rules.includes('test-timing-only-in-measure')) found.push(...timingViolations(context));
  if (rules.includes('test-full-catalogue')) found.push(...fullCatalogueViolations(context));
  const violations = orderedTestViolations(found);
  return { root, rules, violations, counts: countsByRule(violations) };
}

/** True when the check has nothing to report. */
export function testsCheckPasses(report: TestsReport): boolean {
  return report.violations.length === 0;
}
