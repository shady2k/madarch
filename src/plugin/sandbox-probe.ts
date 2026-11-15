/**
 * Whether this machine can confine a plugin, proved before a person presses a fill (madarch-64o5.86): the cgroup
 * madarch runs in, the controllers the user's systemd manager delegates, and a real bubblewrap trial of a no-op
 * plugin. A machine that cannot confine is a choice for its person, never a terminal command or a variable.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withSpan } from '../obs/trace.js';
import { bwrapForUse } from './bwrap-install.js';
import { bwrapArguments, sandboxPlatform, sandboxSetupProblem, type SandboxSpec } from './sandbox.js';
import type { SetupProblem } from './cgroup.js';
import { seccompFilter } from './seccomp.js';
import { runtimeSandbox } from './elf-runtime.js';
import { readPluginsUnconfined } from '../knowledge/settings.js';

const WHERE = 'src/plugin/sandbox-probe.ts';
const HERE = fileURLToPath(import.meta.url);
const TRIAL_TIMEOUT_MS = 8_000;

/** What the probe found: confinement works, or what this machine lacks in words a person reads. */
export interface SandboxProbe {
  readonly state: 'confined' | 'unavailable';
  /** One plain sentence for the terminal, the preparation page and the settings page; never a variable or a command. */
  readonly reason: string;
  /** The operations detail, for the log and an engineer; absent when confinement works. */
  readonly detail?: string;
}

let cached: SandboxProbe | undefined;
let pending: Promise<SandboxProbe> | undefined;

/** The probe, once per process; `fresh` repeats it after a machine's setup was changed. */
export async function probePluginSandbox(options: { readonly fresh?: boolean; readonly env?: Readonly<Record<string, string | undefined>>; readonly cgroupParent?: string } = {}): Promise<SandboxProbe> {
  if (options.fresh !== true && cached !== undefined) return cached;
  if (pending !== undefined) return await pending;
  pending = probeNow(options).finally(() => { pending = undefined; });
  const answer = await pending;
  cached = answer;
  return answer;
}

async function probeNow(options: { readonly env?: Readonly<Record<string, string | undefined>>; readonly cgroupParent?: string }): Promise<SandboxProbe> {
  const env = options.env ?? process.env;
  if (env['MADARCH_PLUGIN_SANDBOX'] === 'off') {
    return { state: 'unavailable', reason: 'plugins are set to run without isolation on this machine', detail: 'MADARCH_PLUGIN_SANDBOX=off' };
  }
  const platform = sandboxPlatform();
  if (!platform.startsWith('linux-')) {
    if (platform.startsWith('darwin-')) return { state: 'confined', reason: 'the macOS sandbox is available on this machine' };
    return { state: 'unavailable', reason: 'this system has no plugin sandbox', detail: `${WHERE}:1: ${HERE}: no sandbox is built for ${platform}` };
  }
  const setup = await sandboxSetupProblem({ ...(options.cgroupParent === undefined ? {} : { cgroupParent: options.cgroupParent }), env });
  if (setup !== undefined) {
    return { state: 'unavailable', reason: plainReason(setup), detail: setup.message };
  }
  const trial = await trialNoOpPlugin(env, options.cgroupParent);
  if (!trial.ok) return { state: 'unavailable', reason: trial.reason, detail: trial.detail };
  return { state: 'confined', reason: 'plugins run isolated on this machine' };
}

/**
 * What the missing piece is, in words a person with no terminal can act on by choosing the other way. The cgroup cases
 * are told by the fields the check read (`cgroup.controllers`, `cgroup.subtree_control`), never by its prose.
 */
function plainReason(problem: SetupProblem): string {
  if (problem.code === 'cgroup-delegation') {
    if (problem.delegation?.kind === 'not-handed') return 'this machine does not give madarch a cgroup where it can limit a plugin’s memory, cpu and processes';
    if (problem.delegation?.kind === 'not-offered') return 'this machine does not offer madarch the cpu, memory and process limits a plugin needs';
    return 'this machine does not give madarch a cgroup to limit plugins in';
  }
  if (problem.code === 'user-namespaces') return 'this machine does not allow the private namespaces a plugin sandbox needs';
  return 'this machine cannot start the plugin sandbox';
}

/** Runs a no-op plugin through the same bubblewrap arguments a real plugin gets, without a cgroup. */
async function trialNoOpPlugin(env: Readonly<Record<string, string | undefined>>, cgroupParent: string | undefined): Promise<{ ok: true } | { ok: false; reason: string; detail: string }> {
  // The trial writes a closure, a seccomp filter and a child's pipes: every one of those reaches outside the process.
  // The span opens in this function and encloses the call that touches the machine, so a trace says what the trial cost
  // and where it failed.
  const trial = async (): Promise<{ ok: true } | { ok: false; reason: string; detail: string }> => {
    const workFolder = mkdtempSync(join(tmpdir(), 'madarch-sandbox-probe-'));
    try {
      const closure = join(workFolder, 'plugin');
      mkdirSync(closure);
      writeFileSync(join(closure, 'entry.ts'), 'process.exit(0);\n');
      const seccompFile = join(workFolder, 'seccomp.bpf');
      writeFileSync(seccompFile, seccompFilter(sandboxPlatform()));
      const runtime = runtimeSandbox(process.execPath, env);
      if (runtime.refusal !== undefined) return { ok: false, reason: 'the plugin runtime cannot be made visible inside the sandbox on this machine', detail: runtime.refusal };
      const bwrap = await bwrapForUse({ env });
      const spec: SandboxSpec = { closureFolder: closure, workFolder, runtime: process.execPath, entry: 'entry.ts', limits: { memoryBytes: 256 * 1024 * 1024, cpuQuotaMicros: 50_000, cpuPeriodMicros: 100_000, pids: 32 }, ...(cgroupParent === undefined ? {} : { cgroupParent }), env };
      const args = bwrapArguments(spec, { bwrap: bwrap.binary, seccompFile, syncFd: 3, seccompFd: 4, rootUid: typeof process.getuid === 'function' ? process.getuid() : undefined, runtime });
      const child = spawn(bwrap.binary, args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, timeout: TRIAL_TIMEOUT_MS });
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      (child.stdio[3] as import('node:stream').Writable).end(Buffer.from([1]));
      const filter = readFileSync(seccompFile);
      (child.stdio[4] as import('node:stream').Writable).end(filter);
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: string }>((resolve) => {
        child.once('close', (code, signal) => resolve({ code, signal }));
        child.once('error', (error) => resolve({ code: null, signal: null, error: (error as Error).message }));
      });
      if (result.code === 0) return { ok: true };
      const ended = result.error !== undefined ? `could not start: ${result.error}` : result.code === null ? `exited with signal ${String(result.signal)}` : `exited with code ${String(result.code)}`;
      const tail = stderr.trim().slice(-600);
      const detail = `${WHERE}:1: ${HERE}: the no-op plugin ${ended}${tail === '' ? '' : `: ${tail}`}`;
      return { ok: false, reason: 'the plugin sandbox could not start a trial plugin on this machine', detail };
    } catch (error) {
      return { ok: false, reason: 'the plugin sandbox could not start a trial plugin on this machine', detail: `${WHERE}:1: ${HERE}: ${(error as Error).message}` };
    } finally {
      rmSync(workFolder, { recursive: true, force: true });
    }
  };
  return await withSpan('sandbox.probe.trial', { 'madarch.sandbox.platform': sandboxPlatform() }, async () => trial());
}

/** The isolation this fill runs with, or the plain refusal a page should have prevented. */
export async function fillIsolation(env: Readonly<Record<string, string | undefined>> = process.env): Promise<{ readonly unconfined: boolean }> {
  if (env['MADARCH_PLUGIN_SANDBOX'] === 'off') return { unconfined: true };
  const choice = readPluginsUnconfined(env);
  if (choice === true) return { unconfined: true };
  const probe = await probePluginSandbox({ env });
  if (probe.state === 'confined') return { unconfined: false };
  throw new Error(`${WHERE}:1: ${HERE}: plugins cannot be isolated on this machine (${probe.reason}); run them without isolation on the preparation page, or do not fill`);
}
