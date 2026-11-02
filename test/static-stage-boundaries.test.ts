/**
 * The static stage boundary check (decision 0033, "Capability boundaries"): a
 * stage that reaches a whole-tree reader or a repository-wide object fails,
 * naming the stage, the file, the line and the reached symbol; the three static
 * stages this repository holds pass with no exception.
 *
 * The planted case is a fixture no stage registers: the check is pointed at it
 * by a configuration of its own, and the repository's own configuration is run
 * as it stands in `bun run check`.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');

/** What one run of the check answered: its exit code and the lines it wrote. */
function run(config: string): { readonly code: number; readonly stderr: string } {
  try {
    const stdout = execFileSync('node', ['scripts/check-static-stage-boundaries.ts', '--root', root, '--config', config], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stderr: stdout };
  } catch (error) {
    const failed = error as { status?: number; stderr?: string };
    return { code: failed.status ?? -1, stderr: String(failed.stderr ?? '') };
  }
}

describe('the static stage boundary check', () => {
  test('the three static stages of this repository pass, with no exception listed', () => {
    const checked = run('static-stage-boundaries.json');
    expect(checked.stderr).toBe('');
    expect(checked.code).toBe(0);
  }, 60_000);

  test('a planted stage that calls the tree reader or obtains a repository-wide object fails, naming stage, file, line and symbol', () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-static-boundary-'));
    const config = join(folder, 'config.json');
    writeFileSync(config, JSON.stringify({
      stages: { 'test/fixtures/static-stage-boundary/forbidden.ts': {} },
      forbiddenTypes: ['SnapshotSource'],
      forbiddenModules: ['src/fill/snapshot.ts'],
      wholeRepositoryMembers: ['repositoryTree'],
    }));
    const checked = run(config);
    expect(checked.code).toBe(1);
    const file = resolve(root, 'test/fixtures/static-stage-boundary/forbidden.ts');
    expect(checked.stderr).toContain(`${file}:14:`);
    expect(checked.stderr).toContain('test/fixtures/static-stage-boundary/forbidden.ts');
    expect(checked.stderr).toContain('repositoryTree');
    expect(checked.stderr).toContain('SnapshotSource');
    // The whole-repository member is refused by name, and a stage has no exception to name it.
    expect(checked.stderr).not.toContain('allows');
  }, 60_000);

  test('a configuration that gives a stage an exception is refused', () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-static-boundary-'));
    const config = join(folder, 'config.json');
    writeFileSync(config, JSON.stringify({
      stages: { 'src/fill/stages/snapshot.ts': { allows: ['repositoryTree'] } },
      forbiddenTypes: [],
      forbiddenModules: [],
      wholeRepositoryMembers: ['repositoryTree'],
    }));
    let message = '';
    try {
      execFileSync('node', ['scripts/check-static-stage-boundaries.ts', '--root', root, '--config', config], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      message = String((error as { stderr?: string }).stderr ?? (error as Error).message);
    }
    expect(message).toContain('no exception');
  }, 60_000);
});
