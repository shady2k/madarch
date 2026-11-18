import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(import.meta.dir, '../../scripts/test-coverage-diff.ts');
let folder: string | undefined;
afterEach(() => { if (folder) rmSync(folder, { recursive: true, force: true }); });

test('integration: coverage CLI preserves comparison and input exit codes', async () => {
  folder = mkdtempSync(join(tmpdir(), 'coverage-cli-'));
  const oldPath = join(folder, 'old.lcov');
  const newPath = join(folder, 'new.lcov');
  writeFileSync(oldPath, 'SF:src/x.ts\nDA:7,1\nend_of_record\n');
  writeFileSync(newPath, '');
  const cases = [
    { args: [oldPath, oldPath], code: 0, message: 'summary:' },
    { args: [oldPath, newPath], code: 1, message: `${resolve('src/x.ts')}:7:` },
    { args: [join(folder, 'missing.lcov'), newPath], code: 2, message: `${join(folder, 'missing.lcov')}:no-line:` },
    { args: [], code: 2, message: `${script}:no-line: arguments:` },
  ];
  for (const entry of cases) {
    const child = Bun.spawn([process.execPath, script, ...entry.args], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(entry.code);
    expect(out + err).toContain(entry.message);
  }
});
