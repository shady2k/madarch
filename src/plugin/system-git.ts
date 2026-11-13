/** System Git is approved by its resolved executable path and version, never release bytes. */
import { execFileSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { ClosureRefusal } from './closure-refusal.js';
import type { SandboxTool } from './tools.js';

export interface SystemGitProbe {
  readonly resolve: () => string | null;
  readonly version: (executable: string) => string;
}

/** The same resolution and version check runs on Linux, macOS and Windows. */
export function systemGit(minimumVersion: string, env: Readonly<Record<string, string | undefined>> = process.env, probe?: SystemGitProbe): SandboxTool {
  const refuse = (found: string): never => {
    throw new ClosureRefusal('plugin-tool', `src/plugin/system-git.ts:1: system Git found ${found}; Git ${minimumVersion} or newer is required (disk uses git check-attr --source, added in 2.40; history uses git log --diff-merges, added in 2.31). Install or select a supported Git on PATH.`, 'src/plugin/system-git.ts');
  };
  const read = probe ?? {
    resolve: () => {
      const path = Bun.which('git', { PATH: env['PATH'] ?? '' });
      if (path === null) return null;
      const executable = realpathSync(path);
      if (!statSync(executable).isFile()) throw new Error(`${executable} is not a regular executable`);
      return executable;
    },
    version: (executable: string) => execFileSync(executable, ['--version'], { encoding: 'utf8', env: { ...env } }),
  };
  let executable: string | null;
  try { executable = read.resolve(); }
  catch (error) { return refuse(`no runnable executable (${error instanceof Error ? error.message : String(error)})`); }
  if (executable === null) return refuse('no git executable on PATH');
  let said: string;
  try { said = read.version(executable).trim(); }
  catch (error) { return refuse(`${executable}, which could not run --version (${error instanceof Error ? error.message : String(error)})`); }
  const version = /^git version (\d+)\.(\d+)(?:\.(\d+))?(?:\.|\s|$)/u.exec(said);
  const minimum = minimumVersion.split('.').map(Number);
  const found = version === null ? [] : [Number(version[1]), Number(version[2]), Number(version[3] ?? 0)];
  const difference = found.map((part, index) => part - (minimum[index] ?? 0)).find((part) => part !== 0) ?? 0;
  if (version === null || difference < 0) return refuse(`${executable}: ${JSON.stringify(said)}`);
  return { name: 'git', executable };
}
