/**
 * The five rules `check:tests` runs (docs/decisions/0041-test-layers-and-suites.md), the violations they
 * find, and the one way those are written down and printed.
 *
 * A violation names the rule, the module it is in as a path from the repository root,
 * the 1-based line, and the rule's own words. The printed line is
 * `<full path>:<line>: <rule>: <what and where>`, so a reader goes from the message to
 * the import, the call or the member expression. The order is code point order of
 * (rule, file, line), the order every message and test uses.
 */
import { resolve } from 'node:path';
import { byCodePoint } from '../../../src/model/order.js';

/** The rules, as a reader names them, in the order a message's sort uses. */
export const TEST_RULES = [
  'test-case-bound',
  'test-full-catalogue',
  'test-integration-reach',
  'test-timing-only-in-measure',
  'test-unit-reach',
] as const;

export type TestRule = (typeof TEST_RULES)[number];

/** One violation as a rule found it. */
export interface TestViolation {
  readonly rule: TestRule;
  /** The module the violation is in, as a path from the repository root. */
  readonly file: string;
  /** The 1-based line the violation is on. */
  readonly line: number;
  /** What the rule found, in its own words: the forbidden target, the chain, the argument, the measurement. */
  readonly message: string;
}

/** The violations in the one order every message and test uses: rule, then file, then line. */
export function orderedTestViolations(violations: readonly TestViolation[]): TestViolation[] {
  return [...violations].sort(
    (left, right) => byCodePoint(left.rule, right.rule) || byCodePoint(left.file, right.file) || left.line - right.line,
  );
}

/** The problems a check prints, one per line, each with the file's full path and the line. */
export function testProblemLines(root: string, violations: readonly TestViolation[]): string[] {
  return orderedTestViolations(violations).map(
    (violation) => `${resolve(root, ...violation.file.split('/'))}:${violation.line}: ${violation.rule}: ${violation.message}`,
  );
}

/** How many violations the run found per rule, for the summary a check prints. */
export function countsByRule(violations: readonly TestViolation[]): ReadonlyMap<TestRule, number> {
  const counts = new Map<TestRule, number>();
  for (const rule of TEST_RULES) counts.set(rule, 0);
  for (const violation of violations) counts.set(violation.rule, (counts.get(violation.rule) ?? 0) + 1);
  return counts;
}
