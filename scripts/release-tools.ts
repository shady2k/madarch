#!/usr/bin/env bun
/** Install the reviewed Git bytes, not the runner image's changing /usr/bin/git. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { RELEASE_GIT, releaseToolPath } from '../src/plugin/release-tools.js';

export function verifyToolDownload(bytes: Uint8Array, expected: string): void {
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('release Git download differs from its approved sha256');
}

export async function installReleaseTools(destination: string = releaseToolPath(), download: (url: string) => Promise<Response> = fetch): Promise<void> {
  if (existsSync(destination)) {
    verifyToolDownload(readFileSync(destination), RELEASE_GIT.sha256);
    if ((statSync(destination).mode & 0o777) !== 0o555) chmodSync(destination, 0o555);
    return;
  }
  const response = await download(RELEASE_GIT.url);
  if (!response.ok) throw new Error(`release Git download failed: HTTP ${response.status}`);
  const archive = new Uint8Array(await response.arrayBuffer());
  verifyToolDownload(archive, RELEASE_GIT.archiveSha256);
  const scratch = mkdtempSync(join(tmpdir(), 'madarch-release-tools-'));
  try {
    const deb = join(scratch, 'git.deb');
    writeFileSync(deb, archive);
    const extracted = spawnSync('dpkg-deb', ['--extract', deb, join(scratch, 'unpacked')], { encoding: 'utf8' });
    if (extracted.status !== 0) throw new Error(`cannot extract release Git: ${extracted.error?.message ?? extracted.stderr}`);
    const executable = join(scratch, 'unpacked/usr/bin/git');
    verifyToolDownload(readFileSync(executable), RELEASE_GIT.sha256);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(executable, destination);
    chmodSync(destination, 0o555);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main && process.platform === 'linux' && process.arch === 'x64') await installReleaseTools();
