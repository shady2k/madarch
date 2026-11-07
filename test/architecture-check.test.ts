import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  architectureCheck,
  architectureCheckPasses,
  architectureProblemLines,
  renderViolationListOf,
  VIOLATION_LIST,
} from '../src/check/architecture/check.js';
import { baseGuard, baseGuardPasses, baseGuardProblemLines } from '../src/check/architecture/base-guard.js';
import type { ArchitectureRule, ListedViolation } from '../src/check/architecture/violation.js';

/**
 * The architecture check of decision 0033, item 4: one writer for the graph, one
 * storage layer, one entry point per fill, and no code unreachable from the declared
 * entry points, each held against the list of violations the project has accepted.
 *
 * Every case plants one violation in a throwaway module of a fixture project the
 * case writes, and reads the check's own answer: the rule's name, the module and the
 * line. A plant the rule does not see, or one it sees in a module that does not break
 * it, fails the case — a rule that cannot fail is not a rule.
 */

// The rules read the fixture's folders, and knip runs as a program of its own: a case
// that runs it twice (baselined, then planted) costs a few seconds each time.
const KNIP_CASE_MS = 120_000;
const REPOSITORY_CASE_MS = 180_000;
const FIXTURE_RULES: readonly ArchitectureRule[] = ['graph-single-writer', 'one-fill-entry', 'sql-only-in-storage-layer'];

/**
 * The fixture project: one module per thing the rules speak of, laid out the way the
 * repository lays them out, with one program (`src/index.ts`) reaching the graph store
 * through the store's own barrel and the orchestrator host — and nothing importing a
 * fill runner or the connection. `src/writer/view.ts` reads a producer's name from the
 * module that also holds `fillGraph`, which is not a fill entry: the fill rule is
 * about names, and this case holds it to that.
 */
const FIXTURE: Readonly<Record<string, readonly string[]>> = {
  'package.json': [JSON.stringify({ name: 'madarch-architecture-fixture', private: true, type: 'module' }, null, 2)],
  'knip.json': [
    JSON.stringify(
      { entry: ['src/index.ts'], project: ['src/**/*.ts'], include: ['files', 'exports', 'nsExports', 'types', 'nsTypes', 'enumMembers'] },
      null,
      2,
    ),
  ],
  'src/index.ts': ["import { publish } from './graph/index.js';", '', 'export const entry = publish;', ''],
  'src/graph/publish.ts': ['/** The graph store\'s publication API. */', 'export function publish(): string {', "  return 'published';", '}', ''],
  'src/graph/index.ts': ["export { publish } from './publish.js';", ''],
  'src/adapters/database-owner.ts': ['/** The process\'s one connection. */', 'export interface DatabaseOwner {', '  query(sql: string): Promise<unknown>;', '}', ''],
  'src/query/sql-driver.ts': ['/** What a module runs a statement through. */', 'export interface SqlExecutor {', '  query(sql: string): Promise<unknown>;', '}', ''],
  'src/extract/driver/index.ts': [
    '/** The extract driver: a fill runner and a producer\'s name beside it. */',
    "export const DRIVER_PRODUCER = 'driver';",
    'export async function fillGraph(): Promise<void> {}',
    '',
  ],
  'src/fill/orchestrator.ts': ['/** The stage registry\'s runner. */', 'export async function driveRun(): Promise<void> {}', ''],
  'src/fill/orchestrator-host.ts': [
    "import { driveRun } from './orchestrator.js';",
    '',
    '/** The one module that starts a fill. */',
    'export function createFillOrchestratorService(): unknown {',
    '  return driveRun;',
    '}',
    '',
  ],
  'src/knowledge/fill-worker.ts': ['/** The knowledge fill worker\'s own loop. */', 'export async function runFillWorker(): Promise<void> {}', ''],
  'src/product/fill.ts': ['/** The product CLI\'s own fill. */', 'export async function startFill(): Promise<void> {}', ''],
  'src/product/fill-stages.ts': ['/** The declared stages\' wiring. */', 'export async function createStagesFill(): Promise<void> {}', ''],
  'src/writer/view.ts': [
    "import { DRIVER_PRODUCER } from '../extract/driver/index.js';",
    '',
    'export const view = DRIVER_PRODUCER;',
    '',
  ],
};

/** Writes the fixture project into a folder of its own and answers the folder. */
function fixtureProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'madarch-architecture-'));
  for (const [file, lines] of Object.entries(FIXTURE)) writeModule(root, file, lines);
  mkdirSync(join(root, '.architecture'), { recursive: true });
  writeFileSync(join(root, VIOLATION_LIST), '[]\n');
  return root;
}

function writeModule(root: string, file: string, lines: readonly string[]): void {
  mkdirSync(join(root, dirname(file)), { recursive: true });
  writeFileSync(join(root, file), `${lines.join('\n')}\n`);
}

/** The line a module writes a piece of text on, 1-based: what the check must name. */
function lineOf(lines: readonly string[], text: string): number {
  const index = lines.findIndex((line) => line.includes(text));
  if (index < 0) throw new Error(`the fixture's case writes ${JSON.stringify(text)} on no line`);
  return index + 1;
}

/** Writes down exactly what the rules find now, as the repository's own list does. */
async function acceptWhatIsFound(root: string, rules: readonly ArchitectureRule[]): Promise<void> {
  const report = await architectureCheck({ root, rules });
  writeFileSync(join(root, VIOLATION_LIST), renderViolationListOf(report));
}

describe('the architecture check', () => {
  test('a second writer of the graph fails with the rule, the file and the line, and passes when the plant is removed', async () => {
    const root = fixtureProject();
    await acceptWhatIsFound(root, ['graph-single-writer']);
    expect(architectureProblemLines(await architectureCheck({ root, rules: ['graph-single-writer'] }))).toEqual([]);

    const plant = ['/**', ' * A second writer of the graph, planted by the test.', ' */', "import { publish } from './graph/publish.js';", '', 'export const written = publish;'];
    writeModule(root, 'src/second-writer.ts', plant);

    const planted = await architectureCheck({ root, rules: ['graph-single-writer'] });
    expect(planted.comparison.unlisted).toEqual([
      { rule: 'graph-single-writer', file: 'src/second-writer.ts', line: lineOf(plant, 'graph/publish.js'), symbol: 'src/graph/publish.ts' },
    ]);
    const problems = architectureProblemLines(planted);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain(`${join(root, 'src', 'second-writer.ts')}:${lineOf(plant, 'graph/publish.js')}: graph-single-writer:`);
    expect(problems[0]).toContain(`${VIOLATION_LIST} does not list it`);

    rmSync(join(root, 'src', 'second-writer.ts'));
    const removed = await architectureCheck({ root, rules: ['graph-single-writer'] });
    expect(architectureProblemLines(removed)).toEqual([]);
    expect(architectureCheckPasses(removed)).toBe(true);
  });

  test('a module that runs a statement of its own fails once for the connection and once for the query interface', async () => {
    const root = fixtureProject();
    await acceptWhatIsFound(root, ['sql-only-in-storage-layer']);
    expect(architectureProblemLines(await architectureCheck({ root, rules: ['sql-only-in-storage-layer'] }))).toEqual([]);

    const plant = [
      '/**',
      ' * SQL outside the storage layer, planted by the test.',
      ' */',
      "import type { DatabaseOwner } from './adapters/database-owner.js';",
      "import type { SqlExecutor } from './query/sql-driver.js';",
      '',
      'export type Rogue = DatabaseOwner | SqlExecutor;',
    ];
    writeModule(root, 'src/rogue-query.ts', plant);

    const planted = await architectureCheck({ root, rules: ['sql-only-in-storage-layer'] });
    expect(planted.comparison.unlisted).toEqual([
      { rule: 'sql-only-in-storage-layer', file: 'src/rogue-query.ts', line: lineOf(plant, 'database-owner.js'), symbol: 'src/adapters/database-owner.ts' },
      { rule: 'sql-only-in-storage-layer', file: 'src/rogue-query.ts', line: lineOf(plant, 'sql-driver.js'), symbol: 'src/query/sql-driver.ts' },
    ]);
    const problems = architectureProblemLines(planted);
    expect(problems.length).toBe(2);
    expect(problems[0]).toContain(`${join(root, 'src', 'rogue-query.ts')}:${lineOf(plant, 'database-owner.js')}: sql-only-in-storage-layer:`);
    expect(problems[0]).toContain('the database owner');
    expect(problems[1]).toContain('the query interface');

    rmSync(join(root, 'src', 'rogue-query.ts'));
    expect(architectureProblemLines(await architectureCheck({ root, rules: ['sql-only-in-storage-layer'] }))).toEqual([]);
  });

  test('a second fill entry point fails, and a module reading a producer from the same module is not an entry point', async () => {
    const root = fixtureProject();
    await acceptWhatIsFound(root, ['one-fill-entry']);
    const clean = await architectureCheck({ root, rules: ['one-fill-entry'] });
    expect(clean.found).toEqual([]);
    expect(architectureProblemLines(clean)).toEqual([]);

    const plant = ['/**', ' * A second entry point for a fill, planted by the test.', ' */', "import { fillGraph } from './extract/driver/index.js';", '', 'export const started = fillGraph;'];
    writeModule(root, 'src/rogue-fill.ts', plant);

    const planted = await architectureCheck({ root, rules: ['one-fill-entry'] });
    expect(planted.comparison.unlisted).toEqual([
      { rule: 'one-fill-entry', file: 'src/rogue-fill.ts', line: lineOf(plant, 'fillGraph'), symbol: 'src/extract/driver/index.ts:fillGraph' },
    ]);
    const problems = architectureProblemLines(planted);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain(`${join(root, 'src', 'rogue-fill.ts')}:${lineOf(plant, 'fillGraph')}: one-fill-entry:`);
    expect(problems[0]).toContain('the fill runner fillGraph of src/extract/driver/index.ts');

    rmSync(join(root, 'src', 'rogue-fill.ts'));
    expect(architectureProblemLines(await architectureCheck({ root, rules: ['one-fill-entry'] }))).toEqual([]);
  });

  test('a second wiring of the fill fails by name, and passes when the plant is removed', async () => {
    const root = fixtureProject();
    await acceptWhatIsFound(root, ['one-fill-entry']);
    expect(architectureProblemLines(await architectureCheck({ root, rules: ['one-fill-entry'] }))).toEqual([]);

    const plant = [
      '/**',
      ' * A second wiring of the fill, planted by the test: the host and the stages built beside the one runner.',
      ' */',
      "import { createFillOrchestratorService } from './fill/orchestrator-host.js';",
      "import { createStagesFill } from './product/fill-stages.js';",
      '',
      'export const wired = [createFillOrchestratorService, createStagesFill];',
    ];
    writeModule(root, 'src/second-wiring.ts', plant);

    const planted = await architectureCheck({ root, rules: ['one-fill-entry'] });
    expect(planted.comparison.unlisted).toEqual([
      { rule: 'one-fill-entry', file: 'src/second-wiring.ts', line: lineOf(plant, 'fill/orchestrator-host.js'), symbol: 'src/fill/orchestrator-host.ts:createFillOrchestratorService' },
      { rule: 'one-fill-entry', file: 'src/second-wiring.ts', line: lineOf(plant, 'product/fill-stages.js'), symbol: 'src/product/fill-stages.ts:createStagesFill' },
    ]);
    const problems = architectureProblemLines(planted);
    expect(problems.length).toBe(2);
    expect(problems[0]).toContain(`${join(root, 'src', 'second-wiring.ts')}:${lineOf(plant, 'fill/orchestrator-host.js')}: one-fill-entry:`);
    expect(problems[0]).toContain('the fill runner createFillOrchestratorService of src/fill/orchestrator-host.ts');
    expect(problems[1]).toContain('the fill runner createStagesFill of src/product/fill-stages.ts');

    rmSync(join(root, 'src', 'second-wiring.ts'));
    const removed = await architectureCheck({ root, rules: ['one-fill-entry'] });
    expect(architectureProblemLines(removed)).toEqual([]);
    expect(architectureCheckPasses(removed)).toBe(true);
  });

  test(
    'a module no entry reaches fails, and passes when the plant is removed',
    async () => {
      const root = fixtureProject();
      await acceptWhatIsFound(root, ['no-unreachable-code']);
      const clean = await architectureCheck({ root, rules: ['no-unreachable-code'] });
      expect(architectureProblemLines(clean)).toEqual([]);

      writeModule(root, 'src/orphan.ts', ['/** A module nothing reaches, planted by the test. */', 'export const orphan = 1;']);

      const planted = await architectureCheck({ root, rules: ['no-unreachable-code'] });
      expect(planted.comparison.unlisted).toEqual([{ rule: 'no-unreachable-code', file: 'src/orphan.ts', line: 1, symbol: null }]);
      const problems = architectureProblemLines(planted);
      expect(problems.length).toBe(1);
      expect(problems[0]).toContain(`${join(root, 'src', 'orphan.ts')}:1: no-unreachable-code:`);
      expect(problems[0]).toContain('unreachable from every declared entry point');

      rmSync(join(root, 'src', 'orphan.ts'));
      expect(architectureProblemLines(await architectureCheck({ root, rules: ['no-unreachable-code'] }))).toEqual([]);
    },
    KNIP_CASE_MS,
  );

  test('an entry the rules no longer find fails, naming the list and the entry, so the list only shrinks', async () => {
    const root = fixtureProject();
    await acceptWhatIsFound(root, ['graph-single-writer', 'sql-only-in-storage-layer']);

    const listed: ListedViolation[] = [{ rule: 'sql-only-in-storage-layer', file: 'src/gone.ts', symbol: 'src/adapters/database-owner.ts' }];
    writeFileSync(join(root, VIOLATION_LIST), `${JSON.stringify(listed, null, 2)}\n`);

    const report = await architectureCheck({ root, rules: ['graph-single-writer', 'sql-only-in-storage-layer'] });
    expect(report.comparison.stale).toEqual(listed);
    const problems = architectureProblemLines(report);
    expect(problems.length).toBe(1);
    const writtenOn = readFileSync(join(root, VIOLATION_LIST), 'utf8')
      .split('\n')
      .findIndex((line) => line.trim() === '"rule": "sql-only-in-storage-layer",') + 1;
    expect(problems[0]).toContain(`${join(root, VIOLATION_LIST)}:${writtenOn}: sql-only-in-storage-layer: src/gone.ts: src/adapters/database-owner.ts`);
    expect(problems[0]).toContain('no rule finds it any more');
    expect(architectureCheckPasses(report)).toBe(false);
  });

  test('the same violation written twice in the list fails, so an entry is one entry', async () => {
    const root = fixtureProject();
    const entry: ListedViolation = { rule: 'one-fill-entry', file: 'src/a.ts', symbol: 'src/product/fill.ts:startFill' };
    writeFileSync(join(root, VIOLATION_LIST), `${JSON.stringify([entry, entry], null, 2)}\n`);

    const report = await architectureCheck({ root, rules: ['one-fill-entry'] });
    expect(report.comparison.duplicated).toEqual([entry]);
    expect(architectureProblemLines(report).length).toBe(3);
  });

  test('every way a module names a fill runner is one entry point beside the host', async () => {
    const root = fixtureProject();
    await acceptWhatIsFound(root, ['one-fill-entry']);

    const plant = [
      '/**',
      ' * A module that takes the runners as a namespace, a re-export, a whole re-export and a',
      ' * computed load, planted by the test.',
      ' */',
      "import * as driver from './extract/driver/index.js';",
      "export { fillGraph } from './extract/driver/index.js';",
      "export * from './fill/orchestrator.js';",
      '',
      "export const pick = async (): Promise<unknown> => import('./product/fill-stages.js');",
      'export const whole = driver;',
    ];
    writeModule(root, 'src/rogue-imports.ts', plant);

    const planted = await architectureCheck({ root, rules: ['one-fill-entry'] });
    expect(planted.comparison.unlisted.map((violation) => [violation.line, violation.symbol])).toEqual([
      [lineOf(plant, "import * as driver"), 'src/extract/driver/index.ts:*'],
      [lineOf(plant, 'export { fillGraph }'), 'src/extract/driver/index.ts:fillGraph'],
      [lineOf(plant, 'export * from'), 'src/fill/orchestrator.ts:*'],
      [lineOf(plant, "import('./product/fill-stages.js')"), 'src/product/fill-stages.ts:*'],
    ]);
    expect(architectureProblemLines(planted).length).toBe(4);

    rmSync(join(root, 'src', 'rogue-imports.ts'));
    expect(architectureProblemLines(await architectureCheck({ root, rules: ['one-fill-entry'] }))).toEqual([]);
  });

  test('a module written as JavaScript is read too, and a file of two-byte characters keeps its lines', async () => {
    const root = fixtureProject();
    await acceptWhatIsFound(root, ['sql-only-in-storage-layer']);

    const legacy = ["import { createPGliteDatabaseOwner } from './adapters/database-owner.js';", '', 'export const open = createPGliteDatabaseOwner;'];
    writeModule(root, 'src/legacy.mjs', legacy);
    const cyrillic = ['/**', ' * «Каждый модуль спрашивает хранилище» — a comment of characters a byte is not a character of.', ' */', "import type { SqlExecutor } from './query/sql-driver.js';", ''];
    writeModule(root, 'src/cyrillic.ts', cyrillic);

    const planted = await architectureCheck({ root, rules: ['sql-only-in-storage-layer'] });
    expect(planted.comparison.unlisted.map((violation) => [violation.file, violation.line, violation.symbol])).toEqual([
      ['src/cyrillic.ts', lineOf(cyrillic, 'sql-driver.js'), 'src/query/sql-driver.ts'],
      ['src/legacy.mjs', lineOf(legacy, 'database-owner.js'), 'src/adapters/database-owner.ts'],
    ]);

    rmSync(join(root, 'src', 'legacy.mjs'));
    rmSync(join(root, 'src', 'cyrillic.ts'));
    expect(architectureProblemLines(await architectureCheck({ root, rules: ['sql-only-in-storage-layer'] }))).toEqual([]);
  });

  test('the violations come out in code point order of rule, file and symbol, whatever order they are found in', async () => {
    const root = fixtureProject();
    writeModule(root, 'src/zzz-writer.ts', ["import { publish } from './graph/publish.js';", '', 'export const written = publish;']);
    writeModule(root, 'src/aaa-query.ts', ["import type { SqlExecutor } from './query/sql-driver.js';", '', 'export type Rogue = SqlExecutor;']);
    writeModule(root, 'src/aaa-writer.ts', ["import { publish } from './graph/publish.js';", '', 'export const also = publish;']);

    const report = await architectureCheck({ root, rules: ['graph-single-writer', 'sql-only-in-storage-layer'] });
    expect(report.found.map((violation) => `${violation.rule} ${violation.file} ${violation.symbol}`)).toEqual([
      'graph-single-writer src/aaa-writer.ts src/graph/publish.ts',
      'graph-single-writer src/zzz-writer.ts src/graph/publish.ts',
      'sql-only-in-storage-layer src/aaa-query.ts src/query/sql-driver.ts',
    ]);
    expect(renderViolationListOf(report)).toBe(`${JSON.stringify(report.found.map((violation) => ({ rule: violation.rule, file: violation.file, symbol: violation.symbol })), null, 2)}\n`);
  });

  test('a module the parser cannot read is refused by name, with the path and the reason', async () => {
    const root = fixtureProject();
    writeModule(root, 'src/broken.mjs', ['export const = ;']);
    await expect(architectureCheck({ root, rules: ['one-fill-entry'] })).rejects.toThrow(/src\/broken\.mjs:1: the module could not be parsed by swc/);
  });

  test('a list the check cannot read is refused by name, with what is wrong', async () => {
    const root = fixtureProject();
    const refusals: readonly (readonly [string, string])[] = [
      ['[', 'the list is not JSON'],
      ['{"rule": "one-fill-entry"}', 'the list is a JSON array of {rule, file, symbol} entries'],
      [JSON.stringify([{ rule: 'no-such-rule', file: 'src/a.ts', symbol: null }]), 'which is not one of'],
      [JSON.stringify([{ rule: 'one-fill-entry', file: '', symbol: null }]), 'a file is a path from the repository root'],
      [JSON.stringify([{ rule: 'one-fill-entry', file: 'src/a.ts', symbol: 7 }]), 'a symbol is a string or null'],
      [JSON.stringify([{ rule: 'one-fill-entry', file: 'src/a.ts', symbol: null, line: 3 }]), 'an entry is exactly rule, file and symbol'],
      [JSON.stringify(['one-fill-entry']), 'is not an object with rule, file and symbol'],
    ];
    for (const [text, expected] of refusals) {
      writeFileSync(join(root, VIOLATION_LIST), text);
      const report = await architectureCheck({ root, rules: ['one-fill-entry'] });
      expect(report.refusal).toContain(expected);
      expect(architectureCheckPasses(report)).toBe(false);
      expect(architectureProblemLines(report)[0]).toStartWith(`${join(root, VIOLATION_LIST)}:1:`);
    }

    rmSync(join(root, VIOLATION_LIST));
    const missing = await architectureCheck({ root, rules: ['one-fill-entry'] });
    expect(missing.refusal).toContain('the list of accepted violations is missing');
  });

});

describe('the base guard', () => {
  /** A repository whose list stands at `entries`, committed as the case writes it. */
  function repositoryWith(entries: readonly unknown[], message: string): string {
    const root = mkdtempSync(join(tmpdir(), 'madarch-architecture-base-'));
    mkdirSync(join(root, '.architecture'), { recursive: true });
    writeFileSync(join(root, VIOLATION_LIST), `${JSON.stringify(entries, null, 2)}\n`);
    commit(root, message);
    return root;
  }

  function commit(root: string, message: string): void {
    execFileSync('git', ['-C', root, 'add', '--all'], { stdio: 'ignore' });
    execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--quiet', '--allow-empty', '-m', message], {
      stdio: 'ignore',
    });
  }

  function repository(): string {
    const root = mkdtempSync(join(tmpdir(), 'madarch-architecture-git-'));
    execFileSync('git', ['-C', root, 'init', '--quiet'], { stdio: 'ignore' });
    return root;
  }

  const LISTED: ListedViolation = { rule: 'sql-only-in-storage-layer', file: 'src/fill/graph-pages.ts', symbol: 'src/query/sql-driver.ts' };

  test('an entry the branch added fails until a commit of the branch carries the owner\'s decision', () => {
    const root = repository();
    mkdirSync(join(root, '.architecture'), { recursive: true });
    writeFileSync(join(root, VIOLATION_LIST), '[]\n');
    commit(root, 'the list starts empty');
    const base = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    writeFileSync(join(root, VIOLATION_LIST), `${JSON.stringify([LISTED], null, 2)}\n`);
    commit(root, 'list a new violation');

    const refused = baseGuard({ root, base });
    expect(refused.added).toEqual([LISTED]);
    expect(refused.ownerDecision).toBeNull();
    expect(baseGuardPasses(refused)).toBe(false);
    const problems = baseGuardProblemLines(refused);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain(`${join(root, VIOLATION_LIST)}:1: sql-only-in-storage-layer:`);
    expect(problems[0]).toContain('Owner-decision:');
    expect(problems[0]).toContain(base);

    commit(root, 'list a new violation\n\nOwner-decision: the graph pages read the projection directly until the stage lands');
    const allowed = baseGuard({ root, base });
    expect(allowed.added).toEqual([LISTED]);
    expect(allowed.ownerDecision).toBe('Owner-decision: the graph pages read the projection directly until the stage lands');
    expect(baseGuardProblemLines(allowed)).toEqual([]);
    expect(baseGuardPasses(allowed)).toBe(true);
  });

  test('a list the branch only lost entries from passes, and a base that holds no list is not compared', () => {
    const root = repository();
    mkdirSync(join(root, '.architecture'), { recursive: true });
    writeFileSync(join(root, VIOLATION_LIST), `${JSON.stringify([LISTED, { rule: 'one-fill-entry', file: 'src/a.ts', symbol: 'src/product/fill.ts:startFill' }], null, 2)}\n`);
    commit(root, 'the list holds two entries');
    const base = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    writeFileSync(join(root, VIOLATION_LIST), `${JSON.stringify([LISTED], null, 2)}\n`);
    commit(root, 'fix one of them');
    const shrunk = baseGuard({ root, base });
    expect(shrunk.added).toEqual([]);
    expect(baseGuardProblemLines(shrunk)).toEqual([]);

    const withoutList = repository();
    writeFileSync(join(withoutList, 'README.md'), 'a repository whose base holds no list\n');
    commit(withoutList, 'a base without a list');
    const before = execFileSync('git', ['-C', withoutList, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    mkdirSync(join(withoutList, '.architecture'), { recursive: true });
    writeFileSync(join(withoutList, VIOLATION_LIST), `${JSON.stringify([LISTED], null, 2)}\n`);
    commit(withoutList, 'introduce the list');
    const introduced = baseGuard({ root: withoutList, base: before });
    expect(introduced.baseHasList).toBe(false);
    expect(introduced.added).toEqual([]);
    expect(baseGuardPasses(introduced)).toBe(true);
  });

  test('a base that cannot be resolved fails by name rather than passing silently', () => {
    const root = repository();
    mkdirSync(join(root, '.architecture'), { recursive: true });
    writeFileSync(join(root, VIOLATION_LIST), '[]\n');
    commit(root, 'the list starts empty');
    expect(() => baseGuard({ root })).toThrow(/origin\/main/);
  });
});
