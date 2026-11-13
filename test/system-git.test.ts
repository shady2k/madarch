import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { systemGit } from '../src/plugin/system-git.js';
import { snapshotTools } from '../src/plugin/tools.js';

const folders: string[] = [];
const scratch = (): string => { const folder = mkdtempSync(join(tmpdir(), 'madarch-system-git-')); folders.push(folder); return folder; };
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

test('system Git approves the resolved path and supports upstream, Apple and Windows version suffixes', () => {
  for (const [path, version] of [['/usr/bin/git', '2.40.0'], ['/opt/homebrew/bin/git', '2.50.1 (Apple Git-155)'], ['C:\\Git\\bin\\git.exe', '2.49.0.windows.1']]) {
    const approved = systemGit('2.40', {}, { resolve: () => path!, version: (executable) => { expect(executable).toBe(path!); return `git version ${version}`; } });
    expect(approved).toEqual({ name: 'git', executable: path! });
  }
});

test('a history-compatible Git is approved for 2.31 but refused for disk 2.40', () => {
  const probe = { resolve: () => '/git', version: () => 'git version 2.39.9' };
  expect(systemGit('2.31', {}, probe).executable).toBe('/git');
  expect(() => systemGit('2.40', {}, probe)).toThrow('Git 2.40 or newer');
});

test('missing, old, unparseable and unrunnable Git name what was found and the required floor', () => {
  const probes = [
    { resolve: () => null, version: () => '' },
    { resolve: () => '/old/git', version: () => 'git version 2.39.9' },
    { resolve: () => '/bad/git', version: () => 'not Git' },
    { resolve: () => '/broken/git', version: (): string => { throw new Error('cannot execute'); } },
  ];
  for (const probe of probes) expect(() => systemGit('2.40', {}, probe)).toThrow(`Git 2.40 or newer`);
  expect(() => systemGit('2.40', {}, probes[1]!)).toThrow('/old/git: "git version 2.39.9"');
  expect(() => systemGit('2.40', { PATH: '' })).toThrow('no git executable on PATH');
});

test.skipIf(process.platform === 'win32')('discovery resolves a PATH symlink, and the sandbox uses that path, not a copied binary', () => {
  const folder = scratch();
  const executable = join(folder, 'approved');
  writeFileSync(executable, '#!/bin/sh\necho "git version 2.43.0"\n', { mode: 0o755 });
  symlinkSync(executable, join(folder, 'git'));
  const tools = snapshotTools([{ name: 'git', source: 'system', minimumVersion: '2.40' }], {}, scratch(), { PATH: folder });
  expect(tools).toEqual([{ name: 'git', executable: realpathSync(executable) }]);
  expect(readFileSync(tools[0]!.executable, 'utf8')).toContain('git version 2.43.0');
});

test('other approved tools still require exact declared bytes and are copied', () => {
  const executable = join(scratch(), 'helper');
  const bytes = Buffer.from('approved helper');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(executable, bytes, { mode: 0o555 });
  const [tool] = snapshotTools([{ name: 'helper', sha256 }], { helper: { executable, sha256 } }, scratch());
  expect(tool!.executable).not.toBe(executable);
  expect(readFileSync(tool!.executable)).toEqual(bytes);
  chmodSync(executable, 0o755);
  writeFileSync(executable, 'changed helper');
  expect(() => snapshotTools([{ name: 'helper', sha256 }], { helper: { executable, sha256 } }, scratch())).toThrow('differs from its approved sha256');
});
