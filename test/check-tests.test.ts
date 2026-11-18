import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { testProblemLines, testsCheck, testsCheckPasses, type TestRule } from '../scripts/check/tests/check.js';
import { bound } from './support/deadline.js';
import { valueImportGraph } from '../scripts/check/tests/graph.js';

/**
 * `check:tests` (`docs/decisions/0041-test-layers-and-suites.md`): the five rules that hold the test
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
      'test/test-database.ts': 'export function createTestDatabaseOwner(): string {\n  return "owner";\n}',
      'test/support/git.ts': "import { execFileSync } from 'node:child_process';\nexport function git(): void { execFileSync('git', ['status']); }",
      'test/integration/plain.test.ts': [
        "import { createTestDatabaseOwner } from '../test-database.js';",
        "import { git } from '../support/git.js';",
        'const owner = createTestDatabaseOwner();',
        'export const held = [owner, git];',
      ].join('\n'),
    });
    expect(await problemsOf(root, 'test-integration-reach')).toEqual([]);
  });

  test('an integration file that asks for a store of its own fails at the call', async () => {
    const root = project({
      'test/test-database.ts': 'export function createTestDatabaseOwner(options: { store?: string } = {}): string {\n  return options.store ?? "pass";\n}',
      'test/integration/store.test.ts': "import { createTestDatabaseOwner } from '../test-database.js';\nconst owner = createTestDatabaseOwner({ store: '/tmp/store' });\nexport const held = owner;",
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
      'test/unit/default.test.ts': "import { test } from 'bun:test'; test('a unit case', () => {});",
      'test/integration/bound.test.ts': [
        "import { test } from 'bun:test'; import { bound } from '../support/deadline.js';",
        "test('an integration case', () => {}, bound(30_000, { measured: 9_000, on: 'box', at: '2026-11-18' }));",
      ].join('\n'),
      'test/e2e/bound.test.ts': [
        "import { test } from 'bun:test'; import { bound } from '../support/deadline.js';",
        "test('an e2e case', () => {}, bound(120_000, { measured: 40_000, on: 'box', at: '2026-11-18' }));",
      ].join('\n'),
    });
    expect(await problemsOf(root, 'test-case-bound')).toEqual([]);
  });

  test('a bare number as the third argument of test() fails', async () => {
    const root = project({
      'test/integration/bare.test.ts': "import { test } from 'bun:test';\ntest('a case', () => {}, 900_000);",
    });
    const problems = await problemsOf(root, 'test-case-bound');
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain(`${join(root, 'test', 'integration', 'bare.test.ts')}:2: test-case-bound:`);
    expect(problems[0]).toContain('bound()');
  });

  test('a bound below three times its measurement fails, and so does one below ten seconds', async () => {
    const root = project({
      'test/support/deadline.ts': deadline,
      'test/integration/small.test.ts': [
        "import { test } from 'bun:test'; import { bound } from '../support/deadline.js';",
        "test('a case', () => {}, bound(20_000, { measured: 9_000, on: 'box', at: '2026-11-18' }));",
      ].join('\n'),
      'test/e2e/short.test.ts': [
        "import { test } from 'bun:test'; import { bound } from '../support/deadline.js';",
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
        "import { test } from 'bun:test'; import { bound } from '../support/deadline.js';",
        "test('a case', () => {}, bound(31_000, { measured: 1_000, on: 'box', at: '2026-11-18' }));",
      ].join('\n'),
      'test/e2e/no-measure.test.ts': [
        "import { test } from 'bun:test'; import { bound } from '../support/deadline.js';",
        "test('a case', () => {}, bound(20_000, { on: 'box', at: '2026-11-18' }));",
      ].join('\n'),
      'test/e2e/big.test.ts': [
        "import { test } from 'bun:test'; import { bound } from '../support/deadline.js';",
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
      'test/unit/bound.test.ts': "import { test } from 'bun:test'; const bound = (ms: number): number => ms;\ntest('a unit case', () => {}, bound(20_000, { measured: 1_000, on: 'box', at: '2026-11-18' }));",
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


describe('review regressions', () => {
  test('a require-based git helper cannot hide a non-git command', async () => {
    const root = project({
      'test/support/git.ts': "const { execFileSync } = require('node:child_process');\nexport const git = () => execFileSync('bun', ['--version']);",
      'test/integration/git.test.ts': "import { git } from '../support/git.js'; export const held = git;",
    });
    const problems = await problemsOf(root, 'test-integration-reach');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`${join(root, 'test/support/git.ts')}:2: test-integration-reach:`);
    expect(problems[0]).toContain('bun');
    expect(problems[0]).toContain('test/integration/git.test.ts > test/support/git.ts');
  });

  test('a barrel may expose other names beside createDraft without importing createDraft', async () => {
    const root = project({
      'src/product/draft.ts': 'export const createDraft = () => {}; export const CONSTITUTION = 1;',
      'test/support/barrel.ts': "export { createDraft, CONSTITUTION } from '../../src/product/draft.js';",
      'test/unit/plain.test.ts': "import { CONSTITUTION } from '../support/barrel.js'; export const held = CONSTITUTION;",
    });
    expect(await problemsOf(root, 'test-full-catalogue')).toEqual([]);
  });

  test('installed packages remain leaf edges, including type-only imports that do not run', async () => {
    const root = project({
      'node_modules/local-pkg/package.json': '{"name":"local-pkg","main":"index.js"}',
      'node_modules/local-pkg/index.js': "import pg from 'pg'; export const value = pg;",
      'node_modules/pg/package.json': '{"name":"pg","main":"index.js"}',
      'node_modules/pg/index.js': 'export default 1;',
      'test/unit/value.test.ts': "import { value } from 'local-pkg'; export const held = value;",
      'test/unit/type.test.ts': "import type { value } from 'local-pkg'; export type Held = typeof value;",
    });
    const graph = await valueImportGraph(root, ['test/unit']);
    expect(graph.edges.get('test/unit/value.test.ts')).toEqual([{ to: 'local-pkg', specifier: 'local-pkg', line: 1 }]);
    expect(graph.edges.get('test/unit/type.test.ts')).toEqual([]);
    expect([...graph.modules].some((file) => file.includes('node_modules'))).toBe(false);
  });

  test('installed database and browser packages are denied, but installed types pass', async () => {
    const files: Record<string, string> = {};
    for (const name of ['pg', 'pg-boss', 'puppeteer']) {
      files[`node_modules/${name}/package.json`] = JSON.stringify({ name, main: 'index.js' });
      files[`node_modules/${name}/index.js`] = 'export default {};';
    }
    const root = project({ ...files,
      'test/unit/pg.test.ts': "import pg from 'pg'; export const held = pg;",
      'test/unit/boss.test.ts': "import boss from 'pg-boss'; export const held = boss;",
      'test/unit/type.test.ts': "import type pg from 'pg'; export type Held = typeof pg;",
      'test/integration/browser.test.ts': "import browser from 'puppeteer'; export const held = browser;",
    });
    const unit = await problemsOf(root, 'test-unit-reach');
    expect(unit).toHaveLength(2);
    for (const file of ['pg', 'boss']) expect(unit.some((line) => line.includes(`${join(root, 'test/unit', `${file}.test.ts`)}:1: test-unit-reach:`))).toBe(true);
    const browser = await problemsOf(root, 'test-integration-reach');
    expect(browser).toHaveLength(1);
    expect(browser[0]).toContain(`${join(root, 'test/integration/browser.test.ts')}:1: test-integration-reach:`);
  });

  test('committed vendor and build exclusions stay excluded from the value graph', async () => {
    const root = project({
      'test/unit/entry.test.ts': "import { a } from '../../vendor/a.js'; import { b } from '../../build/b.js'; export const held = [a,b];",
      'vendor/a.ts': 'export const a = performance.now();',
      'build/b.ts': 'export const b = performance.now();',
    });
    const graph = await valueImportGraph(root, ['test/unit']);
    expect(graph.modules.has('vendor/a.ts')).toBe(false);
    expect(graph.modules.has('build/b.ts')).toBe(false);
  });

  test('aliased and curried Bun cases enforce numeric bounds, while a foreign test function is not a Bun case', async () => {
    const root = project({
      'test/support/deadline.ts': 'export const bound = (ms: number) => ms;',
      'test/integration/alias.test.ts': "import bun, { test as caseOf } from 'bun:test';\ncaseOf('bare', () => {}, 900_000);",
      'test/integration/each.test.ts': "import { test } from 'bun:test';\ntest.each([1])('bare', () => {}, 900_000);",
      'test/integration/skip.test.ts': "import { test } from 'bun:test';\ntest.skipIf(true)('bare', () => {}, 900_000);",
      'test/integration/foreign.test.ts': "const test = (...args: unknown[]) => args;\ntest('not a case', () => {}, 900_000);",
      'test/integration/bound-alias.test.ts': "import * as bun from 'bun:test'; import { test } from 'bun:test'; import deadline, { bound as limit } from '../support/deadline.js';\ntest('too long', () => {}, limit(31_000, { measured: 1_000, on: 'box', at: '2026-11-18' }));",
      'test/integration/bound-good.test.ts': "import * as bun from 'bun:test'; import { test } from 'bun:test'; import deadline, { bound as limit } from '../support/deadline.js';\ntest('okay', () => {}, limit(30_000, { measured: 1_000, on: 'box', at: '2026-11-18' }));",
    });
    const problems = await problemsOf(root, 'test-case-bound');
    expect(problems).toHaveLength(4);
    for (const file of ['alias', 'each', 'skip', 'bound-alias']) expect(problems.some((line) => line.includes(`${join(root, 'test/integration', `${file}.test.ts`)}:2: test-case-bound:`))).toBe(true);
    expect(problems.some((line) => line.includes('bound-alias.test.ts') && line.includes('30 000'))).toBe(true);
  });

  test('store shorthand is refused, while no argument and empty options use the pass database', async () => {
    const root = project({
      'test/test-database.ts': 'export const createTestDatabaseOwner = (options = {}) => options;',
      'test/integration/store.test.ts': "import { createTestDatabaseOwner } from '../test-database.js';\nconst store = '/tmp/store';\nexport const held = createTestDatabaseOwner({ store });",
      'test/integration/pass.test.ts': "import { createTestDatabaseOwner } from '../test-database.js';\nexport const held = [createTestDatabaseOwner(), createTestDatabaseOwner({})];",
    });
    const problems = await problemsOf(root, 'test-integration-reach');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`${join(root, 'test/integration/store.test.ts')}:3: test-integration-reach:`);
  });

  for (const runtime of ['node', 'Bun', 'Bun.spawn']) {
    for (const command of ["'git'", "'bun'", 'command']) {
      test(`the git helper checks ${runtime} command ${command}`, async () => {
        const call = runtime === 'node' ? `execFileSync(${command}, ['status'])` : runtime === 'Bun' ? `Bun.spawnSync([${command}, 'status'])` : `Bun.spawn([${command}, 'status'])`;
        const root = project({
          'test/support/git.ts': `import { execFileSync } from 'node:child_process';\nconst command = process.argv[2];\nexport function git() { return ${call}; }`,
          'test/integration/git.test.ts': "import { git } from '../support/git.js'; export const held = git;",
        });
        const problems = await problemsOf(root, 'test-integration-reach');
        if (command === "'git'") expect(problems).toEqual([]);
        else {
          expect(problems.length).toBeGreaterThan(0);
          expect(problems.some((line) => line.includes('test/integration/git.test.ts') && line.includes('test/support/git.ts'))).toBe(true);
          if (command === "'bun'") expect(problems.some((line) => line.includes('bun'))).toBe(true);
          expect(problems.some((line) => line.includes(`${join(root, 'test/support/git.ts')}:3: test-integration-reach:`))).toBe(true);
        }
      });
    }
  }

  test('the timing rule alone follows support helpers, but permits the measurement helper', async () => {
    const root = project({
      'test/support/clock.ts': 'export const elapsed = performance.now();',
      'test/support/measure.ts': 'export const elapsed = performance.now();',
      'test/unit/clock.test.ts': "import { elapsed } from '../support/clock.js'; export const held = elapsed;",
      'test/unit/measured.test.ts': "import { elapsed } from '../support/measure.js'; export const held = elapsed;",
    });
    const problems = await problemsOf(root, 'test-timing-only-in-measure');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`${join(root, 'test/support/clock.ts')}:1: test-timing-only-in-measure:`);
    expect(problems[0]).toContain('test/unit/clock.test.ts');
  });

  test('catalogue imports through a barrel fail, but the minimal factory may use createDraft', async () => {
    const root = project({
      'src/product/draft.ts': 'export const createDraft = (options = {}) => options;',
      'test/support/barrel.ts': "export { createDraft as draft } from '../../src/product/draft.js';",
      'test/support/draft.ts': "import { createDraft } from '../../src/product/draft.js'; export const testDraft = (options: { kinds: string[] }) => createDraft(options);",
      'test/unit/barrel.test.ts': "import { draft } from '../support/barrel.js'; export const held = draft({ home: '/tmp/product' });",
      'test/unit/minimal.test.ts': "import { testDraft } from '../support/draft.js'; export const held = testDraft({ kinds: ['note'] });",
    });
    const problems = await problemsOf(root, 'test-full-catalogue');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`${join(root, 'test/unit/barrel.test.ts')}:1: test-full-catalogue:`);
    expect(problems[0]).toContain('createDraft');
  });

  test('require, dynamic import and re-export diagnostics point to their actual source lines', async () => {
    const root = project({
      'test/unit/require.test.ts': "// one\n// two\n// three\n// four\n// five\n// six\nconst { spawnSync } = require('node:child_process');\nexport const held = spawnSync;",
      'test/unit/static.test.ts': "// one\n// two\nimport { spawnSync } from 'node:child_process';\nexport const held = spawnSync;",
      'test/unit/unprefixed.test.ts': "// one\n// two\nimport { spawnSync } from 'child_process';\nexport const held = spawnSync;",
      'test/unit/mixed.test.ts': "import { basename } from 'node:path';\n// keep distinct module names\nimport { spawnSync } from 'node:child_process';\nexport const held = [basename, spawnSync];",
      'test/unit/net.test.ts': "// one\n// two\nimport net from 'node:net';\nexport const held = net;",
      'test/unit/dynamic.test.ts': "// one\n// two\nexport const held = import('pg');",
      'test/unit/export.test.ts': "// one\nexport { default as held } from 'pg';",
    });
    const problems = await problemsOf(root, 'test-unit-reach');
    expect(problems).toHaveLength(7);
    for (const [file, line] of [['require', 7], ['dynamic', 3], ['export', 2], ['static', 3], ['unprefixed', 3], ['net', 3], ['mixed', 3]] as const) expect(problems.some((problem) => problem.includes(`${join(root, 'test/unit', `${file}.test.ts`)}:${line}: test-unit-reach:`))).toBe(true);
  });
});

describe('ALX-378 regressions', () => {
  for (const [name, imported, call, reason] of [
    ['alias', "{ createTestDatabaseOwner as open }", 'open({ store })', 'store of its own'],
    ['namespace', '* as database', 'database.createTestDatabaseOwner({ store })', 'store of its own'],
    ['variable', '{ createTestDatabaseOwner }', 'createTestDatabaseOwner(options)', 'readable object literal'],
    ['spread', '{ createTestDatabaseOwner }', 'createTestDatabaseOwner({ ...options })', 'readable object literal'],
    ['computed', '{ createTestDatabaseOwner }', 'createTestDatabaseOwner({ [key]: store })', 'readable object literal'],
  ]) {
    test(`database binding refuses ${name}`, async () => {
      const root = project({
        'test/test-database.ts': 'export const createTestDatabaseOwner = (options = {}) => options; export const forward = (options) => createTestDatabaseOwner(options);',
        'test/integration/db.test.ts': `import ${imported} from '../test-database.js';
const store = '/tmp/store', options = { store }, key = 'store';
${call};`,
      });
      const problems = await problemsOf(root, 'test-integration-reach');
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(`${join(root, 'test/integration/db.test.ts')}:3: test-integration-reach:`);
      expect(problems[0]).toContain(reason!);
      expect(problems[0]).toContain('test/integration/db.test.ts');
    });
  }

  test('database options are read only for the imported helper, with a defining-module exception', async () => {
    const root = project({
      'test/test-database.ts': 'export const createTestDatabaseOwner = (options = {}) => options; export const forward = (options) => createTestDatabaseOwner(options);',
      'test/support/db.ts': "import { createTestDatabaseOwner } from '../test-database.js'; export const owner = createTestDatabaseOwner({});",
      'test/integration/db.test.ts': "import { createTestDatabaseOwner as open } from '../test-database.js'; import { owner } from '../support/db.js'; open(); open({}); open({ label: 'shared' }); const createTestDatabaseOwner = (options) => options; createTestDatabaseOwner({ store: '/tmp/foreign' });",
    });
    expect(await problemsOf(root, 'test-integration-reach')).toEqual([]);
  });

  for (const chain of ['test.if(true)', 'test.failing', 'test.concurrent', 'test.serial', 'test.skip.each([1])', 'test.failingIf(true)', 'test.concurrentIf(true)', 'test.serialIf(true)', 'bun.test', 'bun.it.skip.each([1])', 'caseOf.futureModifier(true).each([1])']) {
    test(`Bun case chain ${chain} refuses a bare bound`, async () => {
      const root = project({
        'test/integration/case.test.ts': `import { test, it as caseOf } from 'bun:test'; import * as bun from 'bun:test';
${chain}('case', () => {}, 900_000);`,
      });
      const problems = await problemsOf(root, 'test-case-bound');
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(`${join(root, 'test/integration/case.test.ts')}:2: test-case-bound:`);
      expect(problems[0]).toContain('900 000');
    });
  }

  test('only the final call of a Bun chain is a case, not its table setup or a foreign namespace', async () => {
    const root = project({
      'test/support/deadline.ts': 'export const bound = (ms) => ms;',
      'test/integration/case.test.ts': "import { test } from 'bun:test'; import * as bun from 'bun:test'; import { bound } from '../support/deadline.js'; test.each([1], [2], [3])('case', () => {}); bun.it.skip.each([1])('case', () => {}, bound(30_000, { measured: 1000, on: 'box', at: '2026-11-18' })); const foreign = { test() {} }; foreign.test('case', () => {}, 900_000);",
    });
    expect(await problemsOf(root, 'test-case-bound')).toEqual([]);
  });

  for (const helper of [
    "export { execFileSync as run } from 'node:child_process';",
    "import { spawnSync } from 'child_process';\nexport const run = spawnSync;",
    "import * as cp from 'node:child_process';\nexport const run = cp.spawnSync;",
    "import { execFileSync } from 'node:child_process';\nexport { execFileSync as run };",
    "import { execFileSync } from 'node:child_process';\nexport const run = wrap(execFileSync);",
  ]) {
    test(`git helper cannot export a process binding: ${helper}`, async () => {
      const root = project({
        'test/support/git.ts': helper,
        'test/integration/git.test.ts': "import { run } from '../support/git.js';\nrun('bun', ['test']);",
      });
      const problems = await problemsOf(root, 'test-integration-reach');
      expect(problems.length).toBeGreaterThan(0);
      expect(problems[0]).toContain(`${join(root, 'test/support/git.ts')}:${helper.includes('\n') ? 2 : 1}: test-integration-reach:`);
      expect(problems[0]).toContain('test/integration/git.test.ts > test/support/git.ts');
    });
  }

  for (const [imported, call] of [["{ setDefaultTimeout }", 'setDefaultTimeout'], ["{ setDefaultTimeout as timeout }", 'timeout'], ['* as bun', 'bun.setDefaultTimeout']]) {
    test(`layer refuses default timeout ${call}`, async () => {
      const root = project({
        'test/deadline.ts': "import { setDefaultTimeout } from 'bun:test'; setDefaultTimeout(10_000);",
        'test/integration/default.test.ts': `import ${imported} from 'bun:test';
${call}(900_000);`,
      });
      const problems = await problemsOf(root, 'test-case-bound');
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(`${join(root, 'test/integration/default.test.ts')}:2: test-case-bound:`);
      expect(problems[0]).toContain('setDefaultTimeout');
      expect(problems[0]).toContain('bound(');
    });
  }
});

describe('shared binding resolution', () => {
  for (const expression of ['test', 'test.skipIf(true)', 'test.future(true).skip.each([1])', 'bun.it.skipIf(true)']) {
    test(`stored Bun case ${expression} retains its root`, async () => {
      for (const third of ['60_000', "limit(60_000, { measured: 1000, on: 'box', at: '2026-11-18' })"]) {
        const root = project({
          'test/support/deadline.ts': 'export const bound = (ms) => ms;',
          'test/support/cases.ts': "export { test, it } from 'bun:test'; export * from './deadline.js';",
          'test/e2e/host.test.ts': `import { test, bound } from '../support/cases.js'; import * as bun from 'bun:test';
const hostTest = ${expression}; const again = hostTest; const limit = bound;
again('host', () => {}, ${third});`,
        });
        const problems = await problemsOf(root, 'test-case-bound');
        if (third === '60_000') {
          expect(problems).toHaveLength(1);
          expect(problems[0]).toContain(`${join(root, 'test/e2e/host.test.ts')}:3: test-case-bound:`);
        } else expect(problems).toEqual([]);
      }
    });
  }

  for (const module of ['test/test-database.ts', 'test/support/test-database.ts']) {
    test(`database definition at ${module} is shared by reach and store rules`, async () => {
      const relative = module === 'test/test-database.ts' ? '../test-database.js' : './test-database.js';
      const root = project({
        [module]: 'export const createTestDatabaseOwner = (options = {}) => options;',
        'test/support/db.ts': `export { createTestDatabaseOwner as open } from '${relative}';`,
        'test/support/db-again.ts': "import { open } from './db.js'; const owner = open; export { owner };",
        'test/integration/db.test.ts': "import { owner } from '../support/db-again.js';\nconst make = owner; make({ store: '/tmp/store' });",
        'test/unit/db.test.ts': "import { owner } from '../support/db-again.js'; export const held = owner;",
      });
      const integration = await problemsOf(root, 'test-integration-reach');
      expect(integration).toHaveLength(1);
      expect(integration[0]).toContain(`${join(root, 'test/integration/db.test.ts')}:2: test-integration-reach:`);
      expect(integration[0]).toContain('store of its own');
      expect(await problemsOf(root, 'test-unit-reach')).toHaveLength(1);
    });
  }

  test('reachable support timeout and local alias are refused with the import path', async () => {
    const root = project({
      'test/support/api.ts': "export { setDefaultTimeout as timeout } from 'bun:test';",
      'test/support/setup.ts': "import { timeout } from './api.js';\nconst s = timeout; s(60_000);",
      'test/e2e/host.test.ts': "import '../support/setup.js';",
    });
    const problems = await problemsOf(root, 'test-case-bound');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`${join(root, 'test/support/setup.ts')}:2: test-case-bound:`);
    expect(problems[0]).toContain('test/e2e/host.test.ts > test/support/setup.ts');
  });

  test('a type query of a process binding is not a value escape', async () => {
    const root = project({
      'test/support/git.ts': "import { execFileSync } from 'node:child_process';\ntype R = ReturnType<typeof execFileSync>;\nexport const git = () => execFileSync('git', ['status']);",
      'test/integration/git.test.ts': "import { git } from '../support/git.js'; export const held = git;",
    });
    expect(await problemsOf(root, 'test-integration-reach')).toEqual([]);
  });

  test('process aliases still cannot escape the git helper', async () => {
    const root = project({
      'test/support/git.ts': "import { execFileSync } from 'node:child_process';\nconst run = execFileSync;\nrun('bun', ['test']);",
      'test/integration/git.test.ts': "import '../support/git.js';",
    });
    const problems = await problemsOf(root, 'test-integration-reach');
    expect(problems.some((line) => line.includes(`${join(root, 'test/support/git.ts')}:3: test-integration-reach:`))).toBe(true);
  });

  test('global process and timing members use the same local binding resolution', async () => {
    const root = project({
      'test/support/process.ts': 'const runtime = Bun; const start = runtime.spawn; start(["true"]);',
      'test/unit/process.test.ts': "import '../support/process.js';",
      'test/integration/clock.test.ts': 'const clock = performance; const now = clock.now; now();',
    });
    const unit = await problemsOf(root, 'test-unit-reach');
    expect(unit.some((line) => line.includes(`${join(root, 'test/support/process.ts')}:1: test-unit-reach:`))).toBe(true);
    const timing = await problemsOf(root, 'test-timing-only-in-measure');
    expect(timing.some((line) => line.includes(`${join(root, 'test/integration/clock.test.ts')}:1: test-timing-only-in-measure:`))).toBe(true);
  });

  test('catalogue bindings follow local aliases exported by a helper', async () => {
    const root = project({
      'src/product/draft.ts': 'export const createDraft = (options) => options;',
      'test/support/catalogue.ts': "import { createDraft } from '../../src/product/draft.js'; const make = createDraft; export { make };",
      'test/unit/catalogue.test.ts': "import { make } from '../support/catalogue.js'; make({});",
    });
    const problems = await problemsOf(root, 'test-full-catalogue');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`${join(root, 'test/unit/catalogue.test.ts')}:1: test-full-catalogue:`);
    expect(problems[0]).toContain('test/unit/catalogue.test.ts > test/support/catalogue.ts > src/product/draft.ts');
  });
});
