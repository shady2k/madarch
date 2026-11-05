/**
 * The workflow check (decision 0033, items 1 and 2): `bun run check:workflows` checks the workflows
 * `madarch new` writes and refuses a workflow naming a stage the engine's registry does not hold and a
 * stage whose required input no stage of the workflow produces, naming the file, the line, the workflow
 * and the stage. Fixtures only: the starter set written into a temporary product.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { STARTER_FILES } from '../src/knowledge/seed.js';
import { WORKFLOWS_FILE } from '../src/knowledge/workflows.js';

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'check-workflows.ts');

const made: string[] = [];
afterAll(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A product folder holding the starter set, its workflows written as `workflows` says. */
function product(workflows?: string): string {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-workflows-check-'));
  made.push(folder);
  for (const file of STARTER_FILES) {
    const path = join(folder, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.path === WORKFLOWS_FILE && workflows !== undefined ? workflows : file.content);
  }
  return folder;
}

interface Run {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

/** `bun scripts/check-workflows.ts`, as a person runs it. */
function run(...arguments_: string[]): Run {
  const done = Bun.spawnSync(['bun', SCRIPT, ...arguments_], { cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' });
  return { code: done.exitCode, out: done.stdout.toString(), err: done.stderr.toString() };
}

/** The 1-based line the file writes `text` on. */
function lineOf(text: string, needle: string): number {
  return text.split('\n').findIndex((line) => line.trim() === needle) + 1;
}

/** A manifest holding one implemented workflow of the stages it names. */
function manifest(stages: readonly string[]): string {
  return ['workflows:', '  first-fill:', '    status: implemented', '    stages:', ...stages.map((stage) => `      - ${stage}`), ''].join('\n');
}

describe('the workflow check over the starter set', () => {
  test('the starter set passes, and the run names the counts and the manifest it read', () => {
    const done = run();
    expect(done.err).toBe('');
    expect(done.code).toBe(0);
    expect(done.out).toContain('workflows: 4 workflows (1 implemented, 3 planned)');
    expect(done.out).toContain(join('madarch', 'workflows.yaml'));
  }, 30_000);

  test('a workflow naming a stage the registry does not hold is refused, naming the file, the line, the workflow and the stage', () => {
    const text = manifest(['snapshot', 'inventory', 'teleport']);
    const folder = product(text);
    const done = run('--folder', folder);
    expect(done.code).toBe(1);
    const expected = 'workflow "first-fill" stage "teleport": the engine\'s stage registry holds no stage "teleport" (its stages are boundaries, build-configuration, doc-intent, document-index, history, intent-history, inventory, modules, narrative, overview, recovery, semantic-resolution, snapshot, syntax, understanding)';
    expect(done.err.trim()).toBe(`${join(folder, WORKFLOWS_FILE)}:${lineOf(text, '- teleport')}: ${expected}`);
  }, 30_000);

  test('a stage whose input no earlier stage produces is refused by the derivation\'s own path', () => {
    const text = manifest(['snapshot', 'inventory', 'modules']);
    const folder = product(text);
    const done = run('--folder', folder);
    expect(done.code).toBe(1);
    const expected = 'workflow "first-fill" stage "modules": modules → symbol → syntax (disabled): the workflow names no stage that produces the input "symbol"';
    expect(done.err.trim()).toBe(`${join(folder, WORKFLOWS_FILE)}:${lineOf(text, '- modules')}: ${expected}`);
  }, 30_000);

  test('a planned workflow that names stages is checked as an implemented one is, and one of the stages the registry holds passes', () => {
    const declared = (status: string, stages: readonly string[]): string =>
      ['workflows:', '  branch-worktree:', `    status: ${status}`, '    stages:', ...stages.map((stage) => `      - ${stage}`), ''].join('\n');
    // Decision 0033, item 2 exempts no planned workflow: modules reads `symbol`, and this workflow produces none.
    const starved = declared('planned', ['modules']);
    const refused = run('--folder', product(starved));
    expect(refused.code).toBe(1);
    expect(refused.err.trim().split('\n')).toEqual([
      expect.stringContaining(`:${lineOf(starved, '- modules')}: workflow "branch-worktree" stage "modules": modules → file → inventory (disabled)`),
      expect.stringContaining(`:${lineOf(starved, '- modules')}: workflow "branch-worktree" stage "modules": modules → symbol → syntax (disabled)`),
    ]);
    // The paired case: the same planned workflow of the stages the registry holds and feeds exits 0.
    const sound = product(declared('planned', ['snapshot', 'inventory', 'syntax', 'modules']));
    const done = run('--folder', sound);
    expect(done.err).toBe('');
    expect(done.code).toBe(0);
    expect(done.out).toContain('workflows: 1 workflows (0 implemented, 1 planned)');
    expect(done.out).toContain(join(sound, WORKFLOWS_FILE));
  }, 30_000);

  test('the catalog check reports the catalog\'s findings only, and the workflows keep their own check', () => {
    const folder = product(manifest(['snapshot', 'teleport']));
    const catalog = Bun.spawnSync(['bun', join(import.meta.dir, '..', 'scripts', 'check-catalog.ts'), '--folder', folder], { cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' });
    expect(catalog.exitCode).toBe(0);
    expect(catalog.stderr.toString()).not.toContain('teleport');
    const workflows = run('--folder', folder);
    expect(workflows.code).toBe(1);
    expect(workflows.err).toContain('workflow "first-fill" stage "teleport"');
  }, 30_000);

  test('a product that holds no workflows manifest is refused, naming the path the starter set writes', () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-workflows-missing-'));
    made.push(folder);
    const done = run('--folder', folder);
    expect(done.code).toBe(1);
    expect(done.err).toContain(`${join(folder, WORKFLOWS_FILE)}:1: the product holds no workflows manifest, and the starter set writes one`);
  }, 30_000);

  test('an argument the command does not know exits 2, and --help lists the one it takes', () => {
    const unknown = run('--every');
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('the argument "--every" is not one this command knows; --help lists them');
    const help = run('--help');
    expect(help.code).toBe(0);
    expect(help.out).toContain('usage: bun run check:workflows [--folder <product folder>]');
  }, 30_000);
});
