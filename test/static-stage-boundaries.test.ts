/**
 * The static stage boundary check (decision 0033, "Capability boundaries"): a
 * stage that obtains a whole-tree reader or a repository-wide semantic object
 * fails, naming its file, line and column; the three static stages this
 * repository holds pass.
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
  test('the three static stages of this repository pass', () => {
    const checked = run('static-stage-boundaries.json');
    expect(checked.stderr).toBe('');
    expect(checked.code).toBe(0);
  }, 60_000);

  test('a planted stage that obtains a whole-tree reader fails, naming the file, the line and the type', () => {
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
    expect(checked.stderr).toContain(resolve(root, 'test/fixtures/static-stage-boundary/forbidden.ts') + ':8:');
    expect(checked.stderr).toContain('SnapshotSource');
  }, 60_000);
});
