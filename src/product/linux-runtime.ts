import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, join } from 'node:path';

const REQUIRED = ['libssl.so.3', 'libcrypto.so.3'] as const;
const COMMON_LIBRARY_DIRS = [
  '/lib', '/usr/lib', '/lib64', '/usr/lib64',
  '/lib/x86_64-linux-gnu', '/usr/lib/x86_64-linux-gnu',
  '/lib/aarch64-linux-gnu', '/usr/lib/aarch64-linux-gnu',
];

/** Evaluate a supplied library search snapshot; useful for deterministic platform tests. */
export function missingLinuxOpenSsl3From(directories: readonly string[], cache: string): string[] {
  return REQUIRED.filter((library) =>
    !directories.some((directory) => existsSync(join(directory, library))) && !cache.includes(library),
  );
}

/** Controlled search inputs for tests; normal callers use the host's loader cache. */
export interface LinuxOpenSsl3Search {
  directories?: readonly string[];
  cache?: string;
}

/** Names the Linux native libraries LadybugDB needs before its addon is loaded. */
export function missingLinuxOpenSsl3(
  env: Readonly<Record<string, string | undefined>> = process.env,
  search?: LinuxOpenSsl3Search,
): string[] {
  const directories = [...(env.LD_LIBRARY_PATH ?? '').split(delimiter), ...(search?.directories ?? COMMON_LIBRARY_DIRS)].filter(Boolean);
  let cache = search?.cache ?? '';
  if (search === undefined) {
    const result = spawnSync('ldconfig', ['-p'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (result.status === 0) cache = result.stdout;
  }
  return missingLinuxOpenSsl3From(directories, cache);
}

/** A user-facing prerequisite refusal, run before importing the graph engine. */
export function linuxRuntimeRefusal(platform = process.platform, missing?: readonly string[]): string | undefined {
  if (platform !== 'linux') return undefined;
  const absent = missing ?? missingLinuxOpenSsl3();
  if (absent.length === 0) return undefined;
  return `madarch on Linux requires OpenSSL 3 runtime libraries (${absent.join(', ')}); install your distribution's OpenSSL 3 runtime package, then try again`;
}
