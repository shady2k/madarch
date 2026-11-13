import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installReleaseTools, verifyToolDownload } from '../scripts/release-tools.js';
import { RELEASE_GIT, releaseToolPath, releaseTools } from '../src/plugin/release-tools.js';
import { snapshotTools } from '../src/plugin/tools.js';

const folders: string[] = [];
const scratch = (): string => { const folder = mkdtempSync(join(tmpdir(), 'madarch-tool-test-')); folders.push(folder); return folder; };
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

const declarations = [{ name: 'git', sha256: RELEASE_GIT.sha256 }];

test('release approval names installed pinned Git, never the system executable', () => {
  const tools = releaseTools('linux', 'x64', scratch());
  expect(tools.git).toEqual({ executable: releaseToolPath(), sha256: RELEASE_GIT.sha256 });
  expect(releaseTools('linux-x64', 'x64', scratch())).toEqual(tools);
  for (const [platform, arch] of [['linux', 'arm64'], ['darwin', 'x64'], ['win32', 'x64']]) expect(releaseTools(platform, arch)).toEqual({});
});

test('both download and executable bytes require their exact reviewed digest', () => {
  const bytes = Buffer.from('changed');
  expect(() => verifyToolDownload(bytes, RELEASE_GIT.archiveSha256)).toThrow('approved sha256');
  expect(() => verifyToolDownload(bytes, RELEASE_GIT.sha256)).toThrow('approved sha256');
  verifyToolDownload(bytes, createHash('sha256').update(bytes).digest('hex'));
});

test('installer refuses corrupt cache without fetching a replacement', async () => {
  const executable = join(scratch(), 'git');
  writeFileSync(executable, 'changed');
  await expect(installReleaseTools(executable, (() => { throw new Error('unexpected download'); }))).rejects.toThrow('approved sha256');
});

test.skipIf(process.platform !== 'linux' || process.arch !== 'x64')('installer reuses a verified read-only cache without changing it', async () => {
  const executable = releaseToolPath();
  const before = statSync(executable);
  expect(before.mode & 0o777).toBe(0o555);
  await installReleaseTools(executable, async () => { throw new Error('unexpected download'); });
  expect(statSync(executable).ctimeMs).toBe(before.ctimeMs);
});

test.skipIf(process.platform !== 'linux' || process.arch !== 'x64')('installer repairs permissions on a verified cache when needed', async () => {
  const executable = join(scratch(), 'git');
  writeFileSync(executable, readFileSync(releaseToolPath()), { mode: 0o644 });
  await installReleaseTools(executable, async () => { throw new Error('unexpected download'); });
  expect(statSync(executable).mode & 0o777).toBe(0o555);
});

test('installer refuses HTTP errors and changed archive before extraction', async () => {
  const executable = join(scratch(), 'git');
  await expect(installReleaseTools(executable, (async () => new Response('', { status: 503 })))).rejects.toThrow('HTTP 503');
  await expect(installReleaseTools(executable, (async () => new Response('changed')))).rejects.toThrow('approved sha256');
});

test.skipIf(process.platform !== 'linux' || process.arch !== 'x64')('installed and embedded payloads are copied with pin verification, even if host Git changes', () => {
  // Installation is part of bun install; the fixture uses those real release bytes without network.
  const bytes = readFileSync(releaseToolPath());
  verifyToolDownload(bytes, RELEASE_GIT.sha256);
  const root = scratch();
  mkdirSync(join(root, 'release-tools'));
  writeFileSync(join(root, 'release-tools/git'), bytes);
  for (const tools of [releaseTools('linux', 'x64', scratch()), releaseTools('linux', 'x64', root)]) {
    const work = scratch();
    const [copied] = snapshotTools(declarations, tools, work);
    expect(readFileSync(copied!.executable)).toEqual(bytes);
  }
  writeFileSync(join(root, 'release-tools/git'), 'changed');
  expect(() => snapshotTools(declarations, releaseTools('linux', 'x64', root), scratch())).toThrow('differs from its approved sha256');
});

test('a modified executable with the right declared approval still fails closed', () => {
  const executable = join(scratch(), 'git');
  writeFileSync(executable, 'changed');
  chmodSync(executable, 0o555);
  expect(() => snapshotTools(declarations, { git: { executable, sha256: RELEASE_GIT.sha256 } }, scratch())).toThrow('differs from its approved sha256');
});
