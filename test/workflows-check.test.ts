/**
 * The workflow check (decision 0033, items 1 and 2): `bun run check:workflows` checks the workflows
 * `madarch init` writes and refuses a workflow naming a stage the engine's registry does not hold and a
 * stage whose required input no stage of the workflow produces, naming the file, the line, the workflow
 * and the stage. Fixtures only: the starter set written into a temporary product.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { STARTER_FILES } from '../src/knowledge/seed.js';
import { WORKFLOWS_FILE } from '../src/product/manifest/workflows.js';

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
