/**
 * The macOS sandbox (decision 0035, item 9): `/usr/bin/sandbox-exec` with a
 * deny-by-default profile, rlimits for memory, cpu time and processes, and the
 * plugin's tree tracked and killed by process group.
 *
 * macOS has no cgroups. A process bounds itself by rlimits, which its children
 * inherit, and the host kills the group it started; a descendant that leaves
 * the group — which the profile does not reliably prevent — is outside these
 * bounds. That is a known limit of this platform, stated in the operations
 * page (docs/system/plugin-sandbox.md), not hidden here.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CgroupCounters, CgroupLimits } from './cgroup.js';
import { log } from '../obs/log.js';
import { STDERR_LOG_BYTES, type SandboxProcess, type StderrLog } from './sandbox.js';

/** Where a refusal stands. */
import { pluginInvocation } from './invocation.js';
import type { SandboxTool } from './tools.js';

const WHERE = 'src/plugin/sandbox-darwin.ts';

/** The sentence the operations page and every record of a macOS run carry about the group kill. */
export const DARWIN_SETSID_LIMIT =
  'macOS has no cgroups: memory, cpu time and the process count are bounded by rlimits each process inherits, and the host kills the plugin by its process group. A descendant that calls setsid() leaves that group and is bounded by nothing; the Linux sandbox kills such a tree through its cgroup.';

/** One macOS sandbox's setup: the same folders the Linux sandbox binds, at their own paths. */
export interface DarwinSandboxSpec {
  readonly closureFolder: string;
  /** The repository a plugin that declared the `filesystem` right reads; absent, it reads no folder but its closure. */
  readonly repository?: string;
  readonly filesystemInputs?: readonly { readonly name: string; readonly folder: string }[];
  readonly tools?: readonly SandboxTool[];
  readonly workFolder: string;
  readonly runtime: string;
  readonly entry: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly limits: Pick<CgroupLimits, 'memoryBytes' | 'cpuPeriodMicros' | 'cpuQuotaMicros' | 'pids'>;
}

/** The deny-by-default profile: the closure and the repository may be read, /tmp written, and nothing else. */
export function darwinProfile(spec: DarwinSandboxSpec): string {
  const tools = (spec.tools ?? []).map((tool) => `(literal ${JSON.stringify(tool.executable)})`).join(' ');
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-fork)',
    `(allow process-exec (literal "${spec.runtime}") (subpath "${spec.closureFolder}") ${tools})`,
    '(allow sysctl-read)',
    '(allow mach-lookup (global-name "com.apple.system.logger"))',
    '(allow signal (target self))',
    `(allow file-read* (subpath "${spec.closureFolder}")${spec.repository === undefined ? '' : ` (subpath "${spec.repository}")`} ${(spec.filesystemInputs ?? []).map((input) => `(subpath "${input.folder}")`).join(' ')} (subpath "${spec.workFolder}") ${tools} (subpath "/usr/lib") (subpath "/System/Library"))`,
    '(allow file-read-metadata)',
    `(allow file-write* (subpath "${spec.workFolder}") (subpath "/private/tmp"))`,
    '(allow file-write-data (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr"))',
  ].join('\n');
}

/** The wrapper the host runs: rlimits first, then the profile, then the plugin. */
export function darwinWrapper(spec: DarwinSandboxSpec, profileFile: string): string {
  const memoryKb = Math.max(1, Math.floor(spec.limits.memoryBytes / 1024));
  const cpuSeconds = Math.max(1, Math.ceil((spec.limits.cpuPeriodMicros / spec.limits.cpuQuotaMicros) * 600));
  return [
    '#!/bin/sh',
    `ulimit -v ${String(memoryKb)} 2>/dev/null || true`,
    `ulimit -t ${String(cpuSeconds)} 2>/dev/null || true`,
    `ulimit -u ${String(spec.limits.pids)} 2>/dev/null || true`,
    `exec /usr/bin/sandbox-exec -f '${profileFile}' -- '${spec.runtime}' ${pluginInvocation(spec.runtime, join(spec.closureFolder, spec.entry)).map((word) => `'${word}'`).join(' ')}`,
    '',
  ].join('\n');
}

/**
 * Starts one plugin under sandbox-exec: the wrapper is the group's leader, so
 * a stop or a cancel kills the tree whole; the counters are the numbers macOS
 * can answer — none of the cgroup's, so they stay zero.
 */
export async function startDarwinSandbox(spec: DarwinSandboxSpec): Promise<SandboxProcess> {
  mkdirSync(spec.workFolder, { recursive: true });
  log.info('the macOS sandbox bounds the tree by rlimits and its process group', { limit: DARWIN_SETSID_LIMIT });
  const profileFile = join(spec.workFolder, 'policy.sb');
  writeFileSync(profileFile, darwinProfile(spec));
  const wrapperFile = join(spec.workFolder, 'run.sh');
  const stderrFile = join(spec.workFolder, 'stderr.log');
  writeFileSync(wrapperFile, darwinWrapper(spec, profileFile), { mode: 0o755 });
  const stderr = { bytes: 0, kept: Buffer.alloc(0), truncated: false };
  const env: Record<string, string> = { HOME: '/tmp', TMPDIR: '/tmp', LANG: 'C.UTF-8', ...spec.environment };
  for (const tool of spec.tools ?? []) env[`MADARCH_TOOL_${tool.name.replaceAll('-', '_').toUpperCase()}`] = tool.executable;
  let child: ChildProcess;
  try {
    child = spawn('/bin/sh', [wrapperFile], { env, detached: true, stdio: ['pipe', 'pipe', 'pipe'], cwd: spec.workFolder });
  } catch (error) {
    throw new Error(`${WHERE}:1: sandbox-exec could not be started for ${spec.closureFolder}: ${(error as Error).message}`);
  }
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr.bytes += chunk.length;
    const held = Buffer.concat([stderr.kept, chunk]);
    if (held.length > STDERR_LOG_BYTES) {
      stderr.kept = held.subarray(held.length - STDERR_LOG_BYTES);
      stderr.truncated = true;
    } else {
      stderr.kept = held;
    }
  });
  const signalGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // The group is already gone; nothing is left to signal.
    }
  };
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    child.on('close', (code, signal) => done({ code, signal }));
  });
  return {
    pid: child.pid ?? -1,
    write: (text) => { child.stdin!.write(text); },
    onStdout: (onData, onEnd) => {
      child.stdout!.on('data', (chunk: Buffer) => onData(chunk));
      child.stdout!.on('end', () => onEnd());
      child.on('error', (error) => onEnd(error.message));
    },
    freeze: () => signalGroup('SIGSTOP'),
    thaw: () => signalGroup('SIGCONT'),
    kill: () => signalGroup('SIGKILL'),
    counters: (): CgroupCounters => ({ memoryPeakBytes: 0, oomKills: 0, pidsMaxHits: 0, cpuMicros: 0, pidsCurrent: 0 }),
    stderr: (): StderrLog => {
      writeFileSync(stderrFile, stderr.kept);
      return { file: stderrFile, totalBytes: stderr.bytes, truncated: stderr.truncated };
    },
    exited,
    dispose: async () => undefined,
  };
}
