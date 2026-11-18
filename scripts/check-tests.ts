#!/usr/bin/env bun
/**
 * `bun run check:tests` (docs/decisions/0041-test-layers-and-suites.md): the five rules of the test
 * layers, wired into `bun run check`.
 *
 * Every violation is printed as `<full path>:<line>: <rule>: <what and where>`, one
 * per line, and the command exits 1. A run that finds nothing names the counts and
 * exits 0. Arguments it does not understand exit 2.
 */
import { resolve } from 'node:path';
import { TEST_RULES, testsCheck, testsCheckPasses, testProblemLines } from './check/tests/check.js';

const USAGE = [
  'the test layer check of docs/decisions/0041-test-layers-and-suites.md',
  '',
  '  bun scripts/check-tests.ts            the five rules over test/unit, test/integration, test/e2e and test/measure',
  '  bun scripts/check-tests.ts --help     print this help',
  '',
  `the rules: ${TEST_RULES.join(', ')}`,
].join('\n');

function fail(message: string): never {
  const script = resolve(process.argv[1] ?? 'scripts/check-tests.ts');
  console.error(`${script}:1: ${message}`);
  process.exit(2);
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    console.log(USAGE);
    return 0;
  }
  if (argv.length > 0) fail(`the argument ${JSON.stringify(argv[0])} is not one this command knows; --help lists them`);
  const report = await testsCheck();
  for (const problem of testProblemLines(report.root, report.violations)) console.log(problem);
  const summary = TEST_RULES.map((rule) => `${rule} ${report.counts.get(rule) ?? 0}`).join(', ');
  console.log(`tests: ${report.violations.length} violation${report.violations.length === 1 ? '' : 's'} found (${summary})`);
  return testsCheckPasses(report) ? 0 : 1;
}

process.exit(await main(process.argv.slice(2)));
