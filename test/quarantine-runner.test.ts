import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let folder: string | undefined;
afterEach(() => { if (folder) rmSync(folder, { recursive: true, force: true }); });

test('the wrapper preserves quarantine report variables for an empty inventory', async () => {
  folder = mkdtempSync(join(tmpdir(), 'quarantine-empty-'));
  mkdirSync(join(folder, 'test'));
  mkdirSync(join(folder, 'bin'));
  writeFileSync(join(folder, 'test', 'ordinary.test.ts'), "test('ordinary', () => {});\n");
  const report = join(folder, 'quarantine-results.json');
  const summary = join(folder, 'summary.md');
  const wrapper = resolve('scripts/plugin-sandbox-cgroup.sh');
  writeFileSync(join(folder, 'bin', 'id'), '#!/bin/sh\necho 1000\n', { mode: 0o755 });
  // Emulate sudo's environment filtering, stopping before the root-only cgroup setup.
  writeFileSync(join(folder, 'bin', 'sudo'), `#!${process.execPath}
const names = process.argv[2].split('=')[1].split(',');
const env = Object.fromEntries(names.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
for (const name of ['MADARCH_QUARANTINE', 'GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_SERVER_URL', 'GITHUB_REPOSITORY']) {
  if (env[name] !== 'probe') throw new Error('sudo dropped ' + name);
}
const child = Bun.spawn([${JSON.stringify(process.execPath)}, ${JSON.stringify(resolve('scripts/run-quarantine.ts'))}], { env, stdout: 'inherit', stderr: 'inherit' });
process.exitCode = await child.exited;
`, { mode: 0o755 });
  const child = Bun.spawn(['sh', wrapper], {
    cwd: folder, env: { ...process.env, PATH: `${join(folder, 'bin')}:${process.env.PATH}`, MADARCH_QUARANTINE_REPORT: report, GITHUB_STEP_SUMMARY: summary, MADARCH_QUARANTINE: 'probe', GITHUB_SHA: 'probe', GITHUB_RUN_ID: 'probe', GITHUB_SERVER_URL: 'probe', GITHUB_REPOSITORY: 'probe' }, stdout: 'pipe', stderr: 'pipe',
  });
  const output = await new Response(child.stdout).text();
  const errors = await new Response(child.stderr).text();
  expect(await child.exited).toBe(0);
  expect(errors).toBe('');
  expect(output).toContain('No quarantined cases');
  expect(readFileSync(summary, 'utf8')).toContain('No quarantined cases');
  expect(JSON.parse(readFileSync(report, 'utf8'))).toEqual({ cases: [] });
});
