/**
 * The sandbox a plugin runs in (decision 0035, item 9): on Linux, bubblewrap
 * with every namespace unshared, the environment cleared, the repository's
 * snapshot and the plugin's closure bound read-only, one private writable
 * temporary folder, the seccomp filter of `seccomp.ts`, and the whole tree in
 * a cgroup of its own bounded by `cgroup.ts`. A plugin sees no home, no
 * credentials, no working tree and no socket; its output leaves only through
 * the protocol.
 *
 * By default no plugin runs unconfined: where the machine's setup is missing —
 * the cgroup delegation, unprivileged user namespaces, a platform this build
 * pins no sandbox for — the host refuses with an operations problem naming
 * what to enable (docs/system/plugin-sandbox.md), whatever the plugin's
 * origin. `MADARCH_PLUGIN_SANDBOX=off` explicitly selects a plain child instead.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClosureRefusal } from './closure.js';
import { startDarwinSandbox } from './sandbox-darwin.js';
import { bwrapForUse } from './bwrap-install.js';
import { pluginInvocation } from './invocation.js';
import { runtimeSandbox, type RuntimeSandbox } from './elf-runtime.js';
import { PluginCgroup, cgroupParent, checkCgroupDelegation, checkUserNamespaces, type CgroupCounters, type CgroupLimits, type SetupProblem } from './cgroup.js';
import { refusedCallNames, seccompFilter } from './seccomp.js';
import { log } from '../obs/log.js';
import type { SandboxTool } from './tools.js';

/** Where a refusal stands. */
const WHERE = 'src/plugin/sandbox.ts';

/** The most bytes of a plugin's standard error the log keeps: the tail, where a failure is said. */
export const STDERR_LOG_BYTES = 64 * 1024;

/** The user the plugin runs as inside its namespace when madarch runs as root: nobody, never root. */
const SANDBOX_UID = 65_534;

/** One sandbox's setup: what it binds, where it writes, and the bounds it holds. */
export interface SandboxSpec {
  /** The private copy of the plugin's closure, bound read-only at `/plugin`. */
  readonly closureFolder: string;
  /**
   * The repository snapshot the plugin reads, bound read-only at `/repo` — only a plugin that declared the `filesystem`
   * right is given one (decision 0035, item 9); a plugin that reads the graph sees no folder at all.
   */
  readonly repository?: string;
  readonly filesystemInputs?: readonly { readonly name: string; readonly folder: string }[];
  readonly tools?: readonly SandboxTool[];
  /** The host's folder for this run: the stderr log, the seccomp filter and the cgroup's name hang here. */
  readonly workFolder: string;
  /** The runtime's path on the host: the Bun this process runs on. */
  readonly runtime: string;
  /** The entry, relative to the closure snapshot. */
  readonly entry: string;
  readonly limits: CgroupLimits;
  /** Variables the plugin is given; nothing of the host's environment reaches it beside these. */
  readonly environment?: Readonly<Record<string, string>>;
  /** The platform key, this machine's unless a test names another. */
  readonly platform?: string;
  /** The cgroup madarch's own cgroup stands under: `MADARCH_PLUGIN_CGROUP`, else the process's own. */
  readonly cgroupParent?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** What a plugin's log holds: where it stands, how much the plugin wrote in all, and what was kept. */
export interface StderrLog {
  readonly file: string;
  /** Every byte the plugin wrote to standard error. */
  readonly totalBytes: number;
  /** Whether the log holds only the tail of what it wrote. */
  readonly truncated: boolean;
}

/** One running plugin, confined: its pipes, its tree's controls and the numbers the kernel counted. */
export interface SandboxProcess {
  readonly pid: number;
  /** The cgroup the whole tree runs in, for a record and for a test that reads what is left of it. */
  readonly cgroupFolder?: string;
  /** Writes one message to the plugin's standard input. */
  write(text: string): void;
  /** Hands each chunk of the plugin's standard output to `onData`. */
  onStdout(onData: (chunk: Uint8Array) => void, onEnd: (cause?: string) => void): void;
  /** Freezes the whole tree at once. */
  freeze(): void;
  /** Thaws it. */
  thaw(): void;
  /** Kills the whole tree at once, by its cgroup and then by its process. */
  kill(): void;
  /** What the kernel counted for the tree. */
  counters(): CgroupCounters;
  /** The plugin's standard error, kept as a bounded log. */
  stderr(): StderrLog;
  /** Settles when the tree's supervisor has exited. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Removes the cgroup, after the tree is gone. */
  dispose(): Promise<void>;
}

/** The platform key this process sandboxes for. */
export function sandboxPlatform(platform: string = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`;
}

/**
 * Whether this machine can run a confined plugin at all, and if not, what to
 * enable: an operations problem, never a quieter fallback. macOS answers the
 * sandbox-exec shape, which bounds rlimits and the process group and states
 * its limits in the operations page.
 */
export async function sandboxSetupProblem(options: { readonly platform?: string; readonly env?: Readonly<Record<string, string | undefined>>; readonly cgroupParent?: string } = {}): Promise<SetupProblem | undefined> {
  const platform = options.platform ?? sandboxPlatform();
  if (platform.startsWith('darwin-')) return undefined;
  if (!platform.startsWith('linux-')) {
    return {
      code: 'sandbox-platform',
      message: `${WHERE}:1: no plugin sandbox is built for ${platform}: this build confines plugins with bubblewrap on Linux and sandbox-exec on macOS, and runs none elsewhere (docs/system/plugin-sandbox.md)`,
    };
  }
  const parent = options.cgroupParent ?? cgroupParent(options.env ?? process.env);
  const delegation = checkCgroupDelegation(parent);
  if (delegation !== undefined) return delegation;
  const userns = checkUserNamespaces();
  if (userns !== undefined) return userns;
  return undefined;
}

/** The folders a bind needs on the host, so bubblewrap is not asked to bind one that does not exist. */
function bindable(folder: string): boolean {
  return existsSync(folder);
}

/**
 * The argument list of the sandbox's supervisor: everything the plugin may see, and nothing else.
 *
 * The runtime is bound at `/runtime/bun`, and the loader it names runs it from the paths the ELF states: the folders
 * `runtimeSandbox` resolved (the interpreter's, its real file's, every library's and the search paths the file states)
 * are bound read-only at their own paths, and a nix-ld shim's `NIX_LD`/`NIX_LD_LIBRARY_PATH` are carried in. Nothing
 * else of the host's environment reaches the plugin.
 */
export function bwrapArguments(spec: SandboxSpec, options: { readonly bwrap: string; readonly seccompFile: string; readonly syncFd: number; readonly seccompFd: number; readonly rootUid: number | undefined; readonly runtime?: RuntimeSandbox }): string[] {
  const runtime = options.runtime ?? runtimeSandbox(spec.runtime, spec.env ?? process.env, spec.platform === undefined ? {} : { platform: spec.platform });
  const args: string[] = ['--unshare-all', '--clearenv', '--die-with-parent', '--new-session'];
  if (options.rootUid === 0) args.push('--uid', String(SANDBOX_UID), '--gid', String(SANDBOX_UID));
  args.push('--ro-bind', spec.runtime, '/runtime/bun');
  for (const folder of runtime.mounts) if (bindable(folder)) args.push('--ro-bind', folder, folder);
  args.push('--ro-bind', spec.closureFolder, '/plugin');
  if (spec.repository !== undefined) args.push('--ro-bind', spec.repository, '/repo');
  for (const input of spec.filesystemInputs ?? []) {
    const target = sandboxInputPath(input.name, input.folder, {}, 'linux');
    args.push('--ro-bind', input.folder, target);
  }
  for (const tool of spec.tools ?? []) {
    args.push('--ro-bind', tool.executable, `/tools/${tool.name}`);
    const dependencies = runtimeSandbox(tool.executable, spec.env ?? process.env, spec.platform === undefined ? {} : { platform: spec.platform });
    if (dependencies.refusal !== undefined || dependencies.problems.length > 0) throw new ClosureRefusal('plugin-tool', `${WHERE}:1: cannot resolve tool ${tool.name}: ${dependencies.refusal ?? dependencies.problems.join('; ')}`, WHERE);
    for (const folder of dependencies.mounts) if (bindable(folder)) args.push('--ro-bind', folder, folder);
    args.push('--setenv', `MADARCH_TOOL_${tool.name.replaceAll('-', '_').toUpperCase()}`, `/tools/${tool.name}`);
  }
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');
  args.push('--remount-ro', '/');
  args.push('--chdir', '/plugin');
  args.push('--setenv', 'PATH', '/runtime', '--setenv', 'HOME', '/tmp', '--setenv', 'TMPDIR', '/tmp', '--setenv', 'LANG', 'C.UTF-8');
  for (const [name, value] of Object.entries(spec.environment ?? {}).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    if (name.startsWith('MADARCH_TOOL_')) throw new Error(`${WHERE}:1: executable tool environment is host-owned`);
    args.push('--setenv', name, value);
  }
  // The two variables a nix-ld shim reads, from the host's own environment: the shim needs them to find a loader and
  // its libraries inside the sandbox, and the environment is otherwise cleared.
  for (const [name, value] of Object.entries(runtime.environment).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) args.push('--setenv', name, value);
  args.push('--seccomp', String(options.seccompFd));
  args.push('--sync-fd', String(options.syncFd));
  // A compiled madarch binary runs the plugin itself (`--plugin-entry`), a `bun` runtime runs the entry as its script:
  // both are the Bun inside madarch, and neither needs an interpreter of its own.
  args.push('/runtime/bun', ...pluginInvocation(spec.runtime, `/plugin/${spec.entry}`));
  return args;
}

/** The path a declared filesystem input has in the selected sandbox. */
export function sandboxInputPath(name: string, folder: string, env: Readonly<Record<string, string | undefined>> = process.env, platform = process.platform): string {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`${WHERE}:1: invalid filesystem input name ${JSON.stringify(name)}`);
  return env['MADARCH_PLUGIN_SANDBOX'] === 'off' || platform.startsWith('darwin') ? folder : `/inputs/${name}`;
}

/** Whether this process has already warned about explicitly unconfined plugins. */
let warnedUnconfined = false;

/** The single launch choice for every plugin host; no sandbox failure changes this choice. */
export async function startPluginProcess(spec: SandboxSpec): Promise<SandboxProcess> {
  const env = spec.env ?? process.env;
  const inputNames = new Set<string>();
  for (const input of spec.filesystemInputs ?? []) {
    sandboxInputPath(input.name, input.folder, env);
    if (inputNames.has(input.name)) throw new Error(`${WHERE}:1: duplicate filesystem input ${input.name}`);
    inputNames.add(input.name);
  }
  const mode = env['MADARCH_PLUGIN_SANDBOX'];
  if (mode !== undefined && mode !== 'off') {
    throw new Error(`${fileURLToPath(import.meta.url)}:170: MADARCH_PLUGIN_SANDBOX=${JSON.stringify(mode)} is refused: accepted forms are unset (sandbox on) or off`);
  }
  if (mode === 'off') return startUnconfined(spec);
  const platform = spec.platform ?? sandboxPlatform();
  const problem = await sandboxSetupProblem({ platform, cgroupParent: spec.cgroupParent, ...(spec.env === undefined ? {} : { env: spec.env }) });
  if (problem !== undefined) {
    log.error('the sandbox cannot run here', { problem: problem.code }, problem.message);
    throw new ClosureRefusal('sandbox-unavailable', problem.message, WHERE);
  }
  return platform.startsWith('darwin-') ? await startDarwinSandbox(spec) : await startSandbox(spec);
}

/** A plain child with the same protocol, closure and runtime, but no isolation or resource bounds. */
async function startUnconfined(spec: SandboxSpec): Promise<SandboxProcess> {
  if (!warnedUnconfined) {
    process.stderr.write('Plugins run unconfined because MADARCH_PLUGIN_SANDBOX=off; they can read and write everything the user can.\n');
    warnedUnconfined = true;
  }
  mkdirSync(spec.workFolder, { recursive: true });
  const stderrFile = join(spec.workFolder, 'stderr.log');
  const stderr = { bytes: 0, kept: Buffer.alloc(0), truncated: false };
  const hostEnv = spec.env ?? process.env;
  const env: Record<string, string> = { PATH: dirname(spec.runtime), HOME: '/tmp', TMPDIR: '/tmp', LANG: 'C.UTF-8', ...spec.environment };
  for (const name of ['NIX_LD', 'NIX_LD_LIBRARY_PATH']) {
    const value = hostEnv[name];
    if (value !== undefined) env[name] = value;
  }
  for (const tool of spec.tools ?? []) env[`MADARCH_TOOL_${tool.name.replaceAll('-', '_').toUpperCase()}`] = tool.executable;
  const child = spawn(spec.runtime, pluginInvocation(spec.runtime, join(spec.closureFolder, spec.entry)), {
    cwd: spec.closureFolder, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', (error) => reject(new Error(`${fileURLToPath(import.meta.url)}:202: plugin runtime ${spec.runtime} could not start ${join(spec.closureFolder, spec.entry)}: ${error.message}`)));
  });
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr.bytes += chunk.length;
    const held = Buffer.concat([stderr.kept, chunk]);
    if (held.length > STDERR_LOG_BYTES) {
      stderr.kept = held.subarray(held.length - STDERR_LOG_BYTES);
      stderr.truncated = true;
    } else stderr.kept = held;
  });
  const signal = (name: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      if (process.platform === 'win32') child.kill(name);
      else process.kill(-child.pid, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    child.on('close', (code, signal) => done({ code, signal }));
  });
  return {
    pid: child.pid!,
    write: (text) => { child.stdin!.write(text); },
    onStdout: (onData, onEnd) => {
      child.stdout!.on('data', (chunk: Buffer) => onData(chunk));
      child.stdout!.on('end', () => onEnd());
      child.on('error', (error) => onEnd(error.message));
    },
    freeze: () => signal('SIGSTOP'),
    thaw: () => signal('SIGCONT'),
    kill: () => signal('SIGKILL'),
    counters: () => ({ memoryPeakBytes: 0, oomKills: 0, pidsMaxHits: 0, cpuMicros: 0, pidsCurrent: 0 }),
    stderr: () => {
      writeFileSync(stderrFile, stderr.kept);
      return { file: stderrFile, totalBytes: stderr.bytes, truncated: stderr.truncated };
    },
    exited,
    dispose: async () => undefined,
  };
}

/** How many plugin cgroups this process has made: one more is never the name of an earlier one. */
let cgroupsMade = 0;

/** The name of one plugin's cgroup: this process's, a count that only grows, and a suffix no other host shares. */
function cgroupName(): string {
  cgroupsMade += 1;
  return `plugin-${String(process.pid)}-${String(cgroupsMade)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Starts one confined plugin. The limits are written to its cgroup before its
 * first instruction: bubblewrap is told to wait on a sync pipe until the host
 * has moved it into the cgroup, and only then execs the plugin.
 */
export async function startSandbox(spec: SandboxSpec): Promise<SandboxProcess> {
  const platform = spec.platform ?? sandboxPlatform();
  if (!platform.startsWith('linux-')) {
    throw new Error(`${WHERE}:1: the Linux sandbox cannot start a plugin for ${platform}; macOS runs through src/plugin/sandbox-darwin.ts and no other platform runs at all`);
  }
  const problem = await sandboxSetupProblem({ platform, cgroupParent: spec.cgroupParent, ...(spec.env === undefined ? {} : { env: spec.env }) });
  if (problem !== undefined) throw new Error(problem.message);
  const bwrap = await bwrapForUse(spec.env === undefined ? {} : { env: spec.env });
  // What the runtime's own ELF states it needs is read before anything starts: a loader the sandbox cannot bind is a
  // refusal naming it, never a plugin that exits with `execvp: No such file or directory`.
  const runtime = runtimeSandbox(spec.runtime, spec.env ?? process.env, spec.platform === undefined ? {} : { platform: spec.platform });
  if (runtime.refusal !== undefined) throw new Error(`${WHERE}:1: ${runtime.refusal}`);
  for (const problem of runtime.problems) log.warn(`the sandbox could not resolve a runtime dependency: ${problem}`, { runtime: spec.runtime });
  mkdirSync(spec.workFolder, { recursive: true });
  const seccompFile = join(spec.workFolder, 'seccomp.bpf');
  writeFileSync(seccompFile, seccompFilter(platform));
  log.info('sandbox filter installed', { platform, refused: refusedCallNames(platform).join(',') });
  const parent = spec.cgroupParent ?? cgroupParent(spec.env ?? process.env);
  const group = PluginCgroup.create(parent, cgroupName(), spec.limits);
  const stderrFile = join(spec.workFolder, 'stderr.log');
  const stderr = { bytes: 0, kept: Buffer.alloc(0), truncated: false };
  let child: ChildProcess;
  try {
    // The supervisor enters the cgroup before it execs bubblewrap: bubblewrap forks its own child early — for the pid
    // namespace's init and for the sync wait — and a fork inherits the cgroup of its parent, so moving only the spawned
    // process afterwards would leave the plugin's actual work outside the bounds. The shell writes its own pid, which
    // is the process bubblewrap becomes, and then execs: every descendant stands in the cgroup from its first byte.
    child = spawn('/bin/sh', ['-c', 'echo $$ > "$1" || exit 97; shift; exec "$@"', 'sh', join(group.folder, 'cgroup.procs'), bwrap.binary, ...bwrapArguments(spec, { bwrap: bwrap.binary, seccompFile, syncFd: 3, seccompFd: 4, rootUid: typeof process.getuid === 'function' ? process.getuid() : undefined, runtime })], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    });
  } catch (error) {
    group.remove();
    throw new Error(`${WHERE}:1: the sandbox supervisor ${bwrap.binary} could not be started: ${(error as Error).message}`);
  }
  const sync = child.stdio[3] as import('node:stream').Writable;
  const filter = child.stdio[4] as import('node:stream').Writable;
  const seccompBytes = readFileSync(seccompFile);
  filter.end(seccompBytes);
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
  let finalCounters: CgroupCounters | undefined;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    child.on('close', (code, signal) => {
      finalCounters = group.counters();
      done({ code, signal });
    });
  });
  try {
    if (child.pid === undefined) throw new Error('the supervisor answered no pid');
    // The sync pipe stays closed until the shell has written the cgroup and bubblewrap stands ready to exec.
    group.contains(child.pid);
  } catch (error) {
    group.kill();
    child.kill('SIGKILL');
    await group.remove();
    throw new Error(`${WHERE}:1: the plugin's cgroup ${group.folder} could not be given the sandbox's supervisor: ${(error as Error).message}`);
  } finally {
    sync.end();
  }
  return {
    pid: child.pid ?? -1,
    cgroupFolder: group.folder,
    write: (text) => { child.stdin!.write(text); },
    onStdout: (onData, onEnd) => {
      child.stdout!.on('data', (chunk: Buffer) => onData(chunk));
      child.stdout!.on('end', () => onEnd());
      child.on('error', (error) => onEnd(error.message));
    },
    freeze: () => group.freeze(),
    thaw: () => group.thaw(),
    kill: () => { group.kill(); child.kill('SIGKILL'); },
    counters: () => (group.exists() ? group.counters() : (finalCounters ?? { memoryPeakBytes: 0, oomKills: 0, pidsMaxHits: 0, cpuMicros: 0, pidsCurrent: 0 })),
    stderr: () => {
      writeFileSync(stderrFile, stderr.kept);
      return { file: stderrFile, totalBytes: stderr.bytes, truncated: stderr.truncated };
    },
    exited,
    dispose: async () => await group.remove(),
  };
}
