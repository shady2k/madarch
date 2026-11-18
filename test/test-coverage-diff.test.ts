import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(import.meta.dir, '..', 'scripts', 'test-coverage-diff.ts');
let folder: string | undefined;
afterEach(() => { if (folder) rmSync(folder, { recursive: true, force: true }); });

function fixtures(oldText: string, newText: string): { oldPath: string; newPath: string } {
  folder = mkdtempSync(join(tmpdir(), 'test-coverage-diff-'));
  const oldPath = join(folder, 'old.lcov');
  const newPath = join(folder, 'new.lcov');
  writeFileSync(oldPath, oldText);
  writeFileSync(newPath, newText);
  return { oldPath, newPath };
}

async function run(args: readonly string[]): Promise<{ output: string; code: number }> {
  const child = Bun.spawn([process.execPath, script, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { output: out + err, code };
}

test('unchanged coverage exits 0', async () => {
  const record = 'TN:\nSF:src/x.ts\nDA:1,1\nDA:2,0\nend_of_record\n';
  const { oldPath, newPath } = fixtures(record, record);
  const { output, code } = await run([oldPath, newPath]);
  expect(code).toBe(0);
  expect(output).toContain('summary:');
  expect(output).not.toContain('covered before, uncovered now');
});

test('a line covered before and not now fails, naming the full path and the line', async () => {
  const { oldPath, newPath } = fixtures(
    'SF:src/x.ts\nDA:7,3\nend_of_record\n',
    'SF:src/x.ts\nDA:7,0\nend_of_record\n',
  );
  const { output, code } = await run([oldPath, newPath]);
  expect(code).not.toBe(0);
  expect(output).toContain(`${resolve('src/x.ts')}:7: covered before, uncovered now (no reason in the map)`);
  expect(output).toContain('summary:');
});

test('the same loss named in the map with a reason exits 0', async () => {
  const { oldPath, newPath } = fixtures(
    'SF:src/x.ts\nDA:7,3\nend_of_record\n',
    'SF:src/x.ts\nDA:7,0\nend_of_record\n',
  );
  const allowPath = join(folder!, 'allow.json');
  writeFileSync(allowPath, JSON.stringify({ allow: [{ file: 'src/x.ts', line: 7, reason: 'the behaviour moved to the unit case' }] }));
  const { output, code } = await run([oldPath, newPath, '--allow', allowPath]);
  expect(code).toBe(0);
  expect(output).toContain('summary:');
  expect(output).not.toContain('covered before, uncovered now');
});

test('a malformed lcov line fails as bad input, naming the file and the line of the record', async () => {
  const { oldPath, newPath } = fixtures(
    'TN:\nSF:src/x.ts\nDA:7\nend_of_record\n',
    'SF:src/x.ts\nDA:7,1\nend_of_record\n',
  );
  const { output, code } = await run([oldPath, newPath]);
  expect(code).not.toBe(0);
  expect(output).toContain('bad input');
  expect(output).toContain(`${oldPath}:3:`);
});

test('a coverage record for a non-product file is ignored', async () => {
  const { oldPath, newPath } = fixtures(
    'SF:test/x.ts\nDA:7,1\nend_of_record\n',
    '',
  );
  const { output, code } = await run([oldPath, newPath]);
  expect(code).toBe(0);
  expect(output).toContain('summary:');
});
