/**
 * The one fill (madarch-8bdc.2.5, item 6): `runFill` over a neutral fixture — every
 * step, one step alone, and a path subset — through the same function every caller
 * uses.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { listFiles, repositoryFacts } from '../src/graph/index.js';
import { fillSteps, runFill } from '../src/fill/run.js';
import { writeFirstFillWorkflow } from './fill-workflow-fixture.js';

let root = '';
let product = '';
let owner: DatabaseOwner | undefined;

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: product, stdio: ['ignore', 'pipe', 'pipe'] });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'madarch-runfill-'));
  product = join(root, 'product');
  const repository = join(root, 'repo');
  mkdirSync(join(repository, 'src'), { recursive: true });
  mkdirSync(join(repository, 'docs'), { recursive: true });
  writeFileSync(join(repository, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repository, 'docs', 'readme.md'), '# readme\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repository });
  execFileSync('git', ['add', '-A'], { cwd: repository });
  execFileSync('git', ['-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'one'], { cwd: repository });
  mkdirSync(join(product, 'repos'), { recursive: true });
  require('node:fs').symlinkSync(repository, join(product, 'repos', 'repo'), 'dir');
  writeFileSync(join(product, 'workspace.yaml'), [
    'schemaVersion: 1', 'id: 5c2e8a52-9c3e-4f7a-8b21-6d2e9c0a5b41', 'name: run-product', 'repos:', '  - name: repo', '    url: file:///repo', '',
  ].join('\n'));
  writeFirstFillWorkflow(product);
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('add', '-A');
  git('commit', '-qm', 'the product');
  owner = createPGliteDatabaseOwner({ btreeGist: true });
});

afterAll(async () => {
  await owner?.close();
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

describe('the one fill', () => {
  test('names this step\'s two passes and nothing else', () => {
    expect(fillSteps()).toEqual(['repository-history', 'repository-tree']);
  }, 120_000);

  test('runs every step through one function', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const run = await runFill({ product, database: owner, runId: 'all-steps', home: join(root, 'home') });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.state).toBe('succeeded');
    expect([...new Set(run.units.map((unit) => unit.stageId))].sort()).toEqual(['repository-history', 'repository-tree']);
    const facts = await repositoryFacts(owner, 'repo');
    expect(facts?.fileCount).toBe(2);
    expect(facts?.commitCount).toBe(1);
  }, 300_000);

  test('runs one step alone through the same function', async () => {
    // A store of its own: the first case's run already published the tree at this commit, and a
    // second run writes nothing, so a unit is planned only where the step had not run.
    const alone = createPGliteDatabaseOwner({ btreeGist: true });
    try {
      const run = await runFill({ product, database: alone, steps: ['repository-tree'], runId: 'one-step', home: join(root, 'home') });
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      expect([...new Set(run.units.map((unit) => unit.stageId))]).toEqual(['repository-tree']);
      const facts = await repositoryFacts(alone, 'repo');
      expect(facts?.fileCount).toBe(2);
      // The history step did not run: no commit's own row stands.
      expect(facts?.commitCount).toBe(0);
    } finally {
      await alone.close();
    }
  }, 300_000);

  test('covers the paths a caller names, and refuses a step it does not hold', async () => {
    // A path subset is a fill of its own store: it writes what it covers and never retracts
    // what another fill wrote outside its paths.
    const narrow = createPGliteDatabaseOwner({ btreeGist: true });
    try {
      const run = await runFill({ product, database: narrow, steps: ['repository-tree'], paths: ['src/'], runId: 'paths', home: join(root, 'home') });
      expect(run.ok).toBe(true);
      const files = await listFiles(narrow, { repository: 'repo', limit: 100 });
      expect(files.rows.map((row) => row.path)).toEqual(['src/a.ts']);
    } finally {
      await narrow.close();
    }
    if (owner === undefined) throw new Error('the store was not opened');
    await expect(runFill({ product, database: owner, steps: ['nope'], home: join(root, 'home') })).rejects.toThrow(/is not a step of this fill/);
  }, 300_000);
});
