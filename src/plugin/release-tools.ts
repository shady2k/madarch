/** Release-approved Git for Linux x64. Host Git is never implicitly trusted. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { TrustedTool } from './tools.js';

export const RELEASE_GIT = {
  url: 'https://archive.ubuntu.com/ubuntu/pool/main/g/git/git_2.43.0-1ubuntu7.4_amd64.deb',
  archiveSha256: 'c79b7948ef9860c97ec74293a90178676e63368a0711c95c28a55af4edf1adab',
  sha256: 'eb54b535467e0975c1284d4c4d08eea779aeb248a5d34b02e2ee171382e22201',
} as const;

export function releaseToolPath(): string {
  return resolve(import.meta.dir, '../../node_modules/.madarch-tools/git');
}

/** Compiled releases carry the same verified bytes; unsupported targets have no Git approval. */
export function releaseTools(platform: string = process.platform, arch: string = process.arch, root: string = dirname(Bun.main)): Readonly<Record<string, TrustedTool>> {
  if (platform !== 'linux' && platform !== 'linux-x64') return {};
  if (arch !== 'x64') return {};
  const embedded = join(root, 'release-tools', 'git');
  return { git: existsSync(embedded)
    ? { bytes: readFileSync(embedded), sha256: RELEASE_GIT.sha256 }
    : { executable: releaseToolPath(), sha256: RELEASE_GIT.sha256 } };
}
