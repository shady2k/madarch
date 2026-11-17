/**
 * A finished run leaves no case database and no folder behind (ALX-119, ALX-186):
 * a case's `close()` drops its database itself, and a child `bun test` run's
 * server is removed with its scratch folder. The child names, only after its
 * owners closed, that no case database is left.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('a finished child run leaves no case database and no folder behind', async () => {
  const root = join(import.meta.dir, '..');
  const script = join(root, '.shady2k', 'run-scratch-check.mjs');
  const run = join(import.meta.dir, 'fixtures', 'test-database-run.ts');
  // The two snapshots stand outside the watched folders: a `madarch-` name in the temporary folder would be the run's own.
  const snapshots = mkdtempSync(join(tmpdir(), 'cleanliness-'));
  const before = join(snapshots, 'before.txt');
  const after = join(snapshots, 'after.txt');
  const where = { home: process.env['HOME'] ?? '', tmp: process.env['TMPDIR'] ?? '' };
  const check = (args: string[]) => Bun.spawnSync([process.execPath, script, ...args, '--home', where.home, '--tmp', where.tmp], { cwd: root });
  try {
    expect(check(['snapshot', before]).exitCode).toBe(0);
    const child = Bun.spawnSync([process.execPath, 'test', run], { cwd: root, env: { ...process.env } });
    const output = child.stdout.toString() + child.stderr.toString();
    // The child names this only after its closes dropped their databases.
    expect(output).toContain('harness-cleanliness: no case database left');
    expect({ code: child.exitCode, output }).toMatchObject({ code: 0 });
    expect(check(['snapshot', after]).exitCode).toBe(0);
    const compared = check(['compare', before, after]);
    expect({ code: compared.exitCode, output: compared.stdout.toString() + compared.stderr.toString() })
      .toMatchObject({ code: 0, output: expect.stringContaining('the run left the home and the temporary folder as it found them') });
  } finally {
    rmSync(snapshots, { recursive: true, force: true });
  }
}, 120_000);
