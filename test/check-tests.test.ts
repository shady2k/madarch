import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { testProblemLines, testsCheck, testsCheckPasses, type TestRule } from '../scripts/check/tests/check.js';
import { bound } from './support/deadline.js';

/**
 * `check:tests` (decision 0039, section 2): the five rules that hold the test
 * layers' reach, case bounds, timing assertions and catalogue entry points.
 *
 * Every case writes a small project of its own into a temporary folder — the
 * modules the rule reads, and nothing of this repository — and reads the check's
 * answer: the rule, the file, the line and, where the rule speaks of a chain, the
 * chain of imports. One passing and one violating project per rule, so a rule
 * that cannot fail, or one that fails on what it allows, fails the case.
 */

const roots: string[] = [];

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'madarch-check-tests-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: 'check-tests-fixture', private: true, type: 'module' }, null, 2)}\n`);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, dirname(file)), { recursive: true });
    writeFileSync(join(root, file), `${text}\n`);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The problems a rule reports, as a reader of the command sees them. */
async function problemsOf(root: string, rule: TestRule): Promise<string[]> {
  const report = await testsCheck({ root, rules: [rule] });
  return testProblemLines(root, report.violations);
}

describe('test-unit-reach', () => {
  test('a unit file passes when the values it reaches are pure', async () => {
    const root = project({
      'src/pure.ts': 'export const pure = 1;',
      'test/unit/pure.test.ts': "import { pure } from '../../src/pure.js';\nexport const held = pure;",
    });
    const report = await testsCheck({ root, rules: ['test-unit-reach'] });
    expect(testProblemLines(root, report.violations)).toEqual([]);
    expect(testsCheckPasses(report)).toBe(true);
  });

  test('a unit file that reaches pg fails with the file, the line and the chain of imports', async () => {
    const root = project({
      'src/pure.ts': 'export const pure = 1;',
      'src/seed.ts': "import { flow } from './workflows.js';\nexport const seed = flow;",
      'src/workflows.ts': "import { stage } from './stages/index.js';\nexport const flow = stage;",
      'src/stages/index.ts': "import { db } from './database.js';\nexport const stage = db;",
      'src/stages/database.ts': "import pg from 'pg';\nexport const db = pg;",
      'test/unit/pure.test.ts': "import { pure } from '../../src/pure.js';\nexport const held = pure;",
      'test/unit/reach.test.ts': "import { seed } from '../../src/seed.js';\nexport const held = seed;",
    });
    const problems = await problemsOf(root, 'test-unit-reach');
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain(`${join(root, 'src', 'stages', 'database.ts')}:1: test-unit-reach:`);
    expect(problems[0]).toContain('test/unit/reach.test.ts > src/seed.ts > src/workflows.ts > src/stages/index.ts > src/stages/database.ts');
    expect(problems[0]).toContain('pg');
    expect(problems[0]).not.toContain('pure.test.ts');
  });

  test('an import written as import type is not a value the unit layer reaches', async () => {
    const root = project({
      'src/stages/database.ts': "import pg from 'pg';\nexport const db = pg;",
      'test/unit/types.test.ts': "import type { db } from '../../src/stages/database.js';\nexport type Held = typeof db;",
    });
    expect(await problemsOf(root, 'test-unit-reach')).toEqual([]);
  });

  test('a unit file whose closure starts a process with Bun.spawn fails at that line', async () => {
    const root = project({
      'src/spawner.ts': "export async function go(): Promise<void> {\n  await Bun.spawn(['true']);\n}",
      'test/unit/spawn.test.ts': "import { go } from '../../src/spawner.js';\nexport const held = go;",
    });
    const problems = await problemsOf(root, 'test-unit-reach');
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain(`${join(root, 'src', 'spawner.ts')}:2: test-unit-reach:`);
    expect(problems[0]).toContain('Bun.spawn');
    expect(problems[0]).toContain('test/unit/spawn.test.ts > src/spawner.ts');
  });

  test('a unit file that reaches the run database helper fails even through test/support', async () => {
    const root = project({
      'test/support/test-database.ts': 'export const owner = 1;',
      'test/unit/db.test.ts': "import { owner } from '../support/test-database.js';\nexport const held = owner;",
    });
    const problems = await problemsOf(root, 'test-unit-reach');
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain(`${join(root, 'test', 'unit', 'db.test.ts')}:1: test-unit-reach:`);
    expect(problems[0]).toContain('test/unit/db.test.ts > test/support/test-database.ts');
  });
});

describe('test-integration-reach', () => {
  test('an integration file passes with the pass database and git through test/support/git.ts', async () => {
    const root = project({
      'src/pure.ts': 'export const pure = 1;',
      'test/support/database.ts': 'export function createTestDatabaseOwner(): string {\n  return "owner";\n}',
      'test/support/git.ts': "import { execFileSync } from 'node:child_process';\nexport const git = execFileSync;",
      'test/integration/plain.test.ts': [
        "import { createTestDatabaseOwner } from '../support/database.js';",
        "import { git } from '../support/git.js';",
        'const owner = createTestDatabaseOwner();',
        'export const held = [owner, git];',
      ].join('\n'),
    });
    expect(await problemsOf(root, 'test-integration-reach')).toEqual([]);
  });

  test('an integration file that asks for a store of its own fails at the call', async () => {
    const root = project({
      'test/support/database.ts': 'export function createTestDatabaseOwner(options: { store?: string } = {}): string {\n  return options.store ?? "pass";\n}',
      'test/integration/store.test.ts': "import { createTestDatabaseOwner } from '../support/database.js';\nconst owner = createTestDatabaseOwner({ store: '/tmp/store' });\nexport const held = owner;",
    });
    const problems = await problemsOf(root, 'test-integration-reach');
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain(`${join(root, 'test', 'integration', 'store.test.ts')}:2: test-integration-reach:`);
    expect(problems[0]).toContain('store');
  });

  test('an integration file that starts a process fails, and so does one that starts Bun.spawn', async () => {
    const root = project({
      'test/integration/spawn.test.ts': "import { spawnSync } from 'node:child_process';\nexport const held = spawnSync;",
      'test/integration/bun.test.ts': 'export async function go(): Promise<void> {\n  await Bun.spawn([\'true\']);\n}',
    });
    const problems = await problemsOf(root, 'test-integration-reach');
    expect(problems.length).toBe(2);
    expect(problems.some((problem) => problem.includes(`${join(root, 'test', 'integration', 'spawn.test.ts')}:1: test-integration-reach:`) && problem.includes('child_process'))).toBe(true);
    expect(problems.some((problem) => problem.includes(`${join(root, 'test', 'integration', 'bun.test.ts')}:2: test-integration-reach:`) && problem.includes('Bun.spawn'))).toBe(true);
  });

  test('an integration file that reaches puppeteer fails with the chain', async () => {
    const root = project({
      'test/integration/browser.test.ts': "import puppeteer from 'puppeteer';\nexport const held = puppeteer;",
    });
    const problems = await problemsOf(root, 'test-integration-reach');
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain(`${join(root, 'test', 'integration', 'browser.test.ts')}:1: test-integration-reach:`);
    expect(problems[0]).toContain('test/integration/browser.test.ts');
    expect(problems[0]).toContain('puppeteer');
  });
});

describe('test-case-bound', () => {
  const deadline = 'export function bound(ms: number): number {\n  return ms;\n}';

  test('a case bound named with bound(), three times its measurement, passes in integration and e2e', async () => {
    const root = project({
      'test/support/deadline.ts': deadline,
      'test/unit/default.test.ts': "test('a unit case', () => {});",
      'test/integration/bound.test.ts': [
        "import { bound } from '../support/deadline.js';",
        "test('an integration case', () => {}, bound(30_000, { measured: 9_000, on: 'box', at: '2026-11-18' }));",
      ].join('\n'),
      'test/e2e/bound.test.ts': [
        "import { bound } from '../support/deadline.js';",
        "test('an e2e case', () => {}, bound(120_000, { measured: 40_000, on: 'box', at: '2026-11-18' }));",
      ].join('\n'),
    });
    expect(await problemsOf(root, 'test-case-bound')).toEqual([]);
  });

  test('a bare number as the third argument of test() fails', async () => {
    const root = project({
      'test/integration/bare.test.ts': "test('a case', () => {}, 900_000);",
    });
    const problems = await problemsOf(root, 'test-case-bound');
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain(`${join(root, 'test', 'integration', 'bare.test.ts')}:1: test-case-bound:`);
    expect(problems[0]).toContain('bound()');
  });

  test('a bound below three times its measurement fails, and so does one below ten seconds', async () => {
    const root = project({
      'test/support/deadline.ts': deadline,
      'test/integration/small.test.ts': [
        "import { bound } from '../support/deadline.js';",
        "test('a case', () => {}, bound(20_000, { measured: 9_000, on: 'box', at: '2026-11-18' }));",
      ].join('\n'),
      'test/e2e/short.test.ts': [
        "import { bound } from '../support/deadline.js';",
        "test('a case', () => {}, bound(5_000, { measured: 100, on: 'box', at: '2026-11-18' }));",
      ].join('\n'),
    });
    const problems = await problemsOf(root, 'test-case-bound');
    expect(problems.length).toBe(2);
    expect(problems.some((problem) => problem.includes(`${join(root, 'test', 'integration', 'small.test.ts')}:2: test-case-bound:`) && problem.includes('three times'))).toBe(true);
    expect(problems.some((problem) => problem.includes(`${join(root, 'test', 'e2e', 'short.test.ts')}:2: test-case-bound:`) && problem.includes('10 000'))).toBe(true);
  });

  test('a bound above its layer and a bound with no measurement fail', async () => {
    const root = project({
      'test/support/deadline.ts': deadline,
      'test/integration/big.test.ts': [
        "import { bound } from '../support/deadline.js';",
        "test('a case', () => {}, bound(31_000, { measured: 1_000, on: 'box', at: '2026-11-18' }));",
      ].join('\n'),
      'test/e2e/no-measure.test.ts': [
        "import { bound } from '../support/deadline.js';",
        "test('a case', () => {}, bound(20_000, { on: 'box', at: '2026-11-18' }));",
      ].join('\n'),
      'test/e2e/big.test.ts': [
        "import { bound } from '../support/deadline.js';",
        "test('a case', () => {}, bound(120_001, { measured: 1_000, on: 'box', at: '2026-11-18' }));",
      ].join('\n'),
    });
    const problems = await problemsOf(root, 'test-case-bound');
    expect(problems.length).toBe(3);
    expect(problems.some((problem) => problem.includes('big.test.ts') && problem.includes('30 000'))).toBe(true);
    expect(problems.some((problem) => problem.includes('no-measure.test.ts') && problem.includes('measured'))).toBe(true);
    expect(problems.some((problem) => problem.includes('e2e/big.test.ts') && problem.includes('120 000'))).toBe(true);
  });

  test('a unit case names no bound, and bound must come from test/support/deadline.ts', async () => {
    const root = project({
      'test/unit/bound.test.ts': "const bound = (ms: number): number => ms;\ntest('a unit case', () => {}, bound(20_000, { measured: 1_000, on: 'box', at: '2026-11-18' }));",
    });
    const problems = await problemsOf(root, 'test-case-bound');
    expect(problems.length).toBe(2);
    expect(problems.some((problem) => problem.includes('bound.test.ts:2: test-case-bound:') && problem.includes('unit layer names no bound'))).toBe(true);
    expect(problems.some((problem) => problem.includes('test/support/deadline.ts') && problem.includes('imported'))).toBe(true);
  });
});

describe('test-timing-only-in-measure', () => {
  test('a timing call in test/measure passes', async () => {
    const root = project({
      'test/measure/timing.test.ts': 'export const measured = performance.now();',
    });
    expect(await problemsOf(root, 'test-timing-only-in-measure')).toEqual([]);
  });

  test('performance.now, Bun.nanoseconds and process.hrtime outside test/measure fail at their lines', async () => {
    const root = project({
      'test/unit/now.test.ts': 'export const measured = performance.now();',
      'test/integration/nano.test.ts': 'export const measured = Bun.nanoseconds();',
      'test/e2e/hrtime.test.ts': 'export const measured = process.hrtime();',
    });
    const problems = await problemsOf(root, 'test-timing-only-in-measure');
    expect(problems.length).toBe(3);
    expect(problems.some((problem) => problem.includes(`${join(root, 'test', 'unit', 'now.test.ts')}:1: test-timing-only-in-measure:`) && problem.includes('performance.now'))).toBe(true);
    expect(problems.some((problem) => problem.includes('nano.test.ts') && problem.includes('Bun.nanoseconds'))).toBe(true);
    expect(problems.some((problem) => problem.includes('hrtime.test.ts') && problem.includes('process.hrtime'))).toBe(true);
  });
});

describe('test-full-catalogue', () => {
  test('a file that takes testDraft({ kinds }) passes, and so does the starter set', async () => {
    const root = project({
      'src/product/draft.ts': 'export function createDraft(options: { template?: string } = {}): string {\n  return options.template ?? "default";\n}',
      'test/support/draft.ts': 'export function testDraft(options: { kinds: readonly string[] }): string {\n  return options.kinds.join(",");\n}',
      'test/unit/make.test.ts': "import { testDraft } from '../support/draft.js';\nexport const made = testDraft({ kinds: ['note'] });",
      'test/unit/starter-set/make.test.ts': "import { createDraft } from '../../../src/product/draft.js';\nexport const made = createDraft({ template: 'everything' });",
    });
    expect(await problemsOf(root, 'test-full-catalogue')).toEqual([]);
  });

  test('createDraft outside the starter set fails, and so does the template everything', async () => {
    const root = project({
      'src/product/draft.ts': 'export function createDraft(options: { template?: string } = {}): string {\n  return options.template ?? "default";\n}',
      'test/support/draft.ts': 'export function testDraft(options: { kinds: readonly string[] }): string {\n  return options.kinds.join(",");\n}',
      'test/integration/raw.test.ts': "import { createDraft } from '../../src/product/draft.js';\nexport const made = createDraft({ template: 'none' });",
      'test/unit/template.test.ts': "import { testDraft } from '../support/draft.js';\nexport const made = testDraft({ template: 'everything' });",
      'test/e2e/whole.test.ts': "import * as draft from '../../src/product/draft.js';\nexport const made = draft;",
      'test/integration/cli.test.ts': "export const args = ['init', '--template', 'everything'];",
    });
    const problems = await problemsOf(root, 'test-full-catalogue');
    expect(problems.length).toBe(4);
    expect(problems.some((problem) => problem.includes(`${join(root, 'test', 'integration', 'raw.test.ts')}:1: test-full-catalogue:`) && problem.includes('createDraft'))).toBe(true);
    expect(problems.some((problem) => problem.includes('template.test.ts:2: test-full-catalogue:') && problem.includes('everything'))).toBe(true);
    expect(problems.some((problem) => problem.includes('e2e/whole.test.ts:1: test-full-catalogue:') && problem.includes('draft module'))).toBe(true);
    expect(problems.some((problem) => problem.includes('integration/cli.test.ts:1: test-full-catalogue:') && problem.includes('everything'))).toBe(true);
  });
});

describe('bound', () => {
  test('answers the bound the case names', () => {
    expect(bound(20_000, { measured: 5_000, on: 'box, 2 vCPU', at: '2026-11-18' })).toBe(20_000);
  });

  test('refuses a bound below three times its measurement, naming the measurement', () => {
    expect(() => bound(14_000, { measured: 5_000, on: 'box', at: '2026-11-18' })).toThrow(/three times/);
    expect(() => bound(14_000, { measured: 5_000, on: 'box', at: '2026-11-18' })).toThrow(/5 000/);
  });

  test('refuses a bound below ten seconds', () => {
    expect(() => bound(9_999, { measured: 100, on: 'box', at: '2026-11-18' })).toThrow(/10 000/);
  });

  test('refuses a measurement with no place or date', () => {
    expect(() => bound(20_000, { measured: 5_000, on: '', at: '2026-11-18' })).toThrow(/on/);
    expect(() => bound(20_000, { measured: 5_000, on: 'box', at: '' })).toThrow(/at/);
  });
});
