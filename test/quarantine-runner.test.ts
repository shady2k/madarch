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


test('the report displays file exclusions without executing them', async () => {
  folder = mkdtempSync(join(tmpdir(), 'quarantine-files-'));
  mkdirSync(join(folder, 'test'));
  writeFileSync(join(folder, 'test/slow.test.ts'), "throw new Error('excluded file must not execute');\n");
  const entry = { path: 'test/slow.test.ts', seconds: 41, reason: 'red-defect', result: 'red', owner: 'madarch-x9a7', defect: 'Named | defect', replacement: 'Focused assertion', exit: 'Replacement passes' };
  const manifest = join(folder, 'test/slow-files.json');
  const text = JSON.stringify({ version: 1, measuredOn: '2026-11-18', files: [entry] }, null, 2);
  writeFileSync(manifest, text);
  const report = join(folder, 'quarantine-results.json');
  const summary = join(folder, 'summary.md');
  const child = Bun.spawn([process.execPath, resolve('scripts/run-quarantine.ts')], {
    cwd: folder, env: { ...process.env, MADARCH_QUARANTINE_REPORT: report, GITHUB_STEP_SUMMARY: summary }, stdout: 'pipe', stderr: 'pipe',
  });
  const output = await new Response(child.stdout).text();
  const errors = await new Response(child.stderr).text();
  expect(await child.exited).toBe(0);
  expect(errors).toBe('');
  const line = text.slice(0, text.indexOf(JSON.stringify(entry.path))).split('\n').length;
  for (const value of [entry.path, entry.owner, entry.replacement, entry.exit, `${manifest}:${line}`, 'Named &#124; defect']) {
    expect(output).toContain(value);
    expect(readFileSync(summary, 'utf8')).toContain(value);
  }
  expect(JSON.parse(readFileSync(report, 'utf8'))).toEqual({ cases: [], excludedFiles: [{ ...entry, manifest, line }] });
});


test('file exclusion reporting leaves anchored per-case execution and result records intact', async () => {
  folder = mkdtempSync(join(tmpdir(), 'quarantine-case-'));
  mkdirSync(join(folder, 'test'));
  const since = '3ec0f2b1d7923fa81901d0293e2e92d34df300a8';
  writeFileSync(join(folder, 'test/sample.test.ts'), `import { test, expect } from 'bun:test';
import { quarantined } from ${JSON.stringify(resolve('test/quarantine.ts'))};
quarantined('madarch-x9a7', test, 'broken', '${since}')('only [case]', () => { expect(true).toBe(true); });
test('only [case] extra', () => { throw new Error('must not execute'); });
`);
  const report = join(folder, 'quarantine-results.json');
  const child = Bun.spawn([process.execPath, resolve('scripts/run-quarantine.ts')], {
    cwd: folder, env: { ...process.env, MADARCH_QUARANTINE_REPORT: report, GITHUB_STEP_SUMMARY: '' }, stdout: 'pipe', stderr: 'pipe',
  });
  const output = await new Response(child.stdout).text();
  const errors = await new Response(child.stderr).text();
  expect(await child.exited).toBe(0);
  expect(output).toContain('PASS: only [case]');
  expect(errors).not.toContain('must not execute');
  const recorded = JSON.parse(readFileSync(report, 'utf8'));
  expect(recorded.cases).toHaveLength(1);
  expect(recorded.cases[0]).toMatchObject({ file: 'test/sample.test.ts', name: 'only [case]', task: 'madarch-x9a7', since, result: 'PASS' });
});
