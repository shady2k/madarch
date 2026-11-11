/** Host-supervised ACP adapters: no repository mount and no inherited credentials. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, existsSync, openSync, readSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DEFAULT_HOST_LIMITS } from './host.js';
import { basename, dirname, join } from 'node:path';
import { connectAcpAgent, resolveExecutable, type AcpAgentSpec, type AcpConnection, type AcpTransport, type ConnectAcpOptions } from '../fill/acp.js';
import { byCodePoint } from '../model/order.js';
import { log } from '../obs/log.js';
import { withSpan } from '../obs/trace.js';
import { runtimeSandbox } from './elf-runtime.js';
import type { CgroupLimits } from './cgroup.js';
import { sandboxPlatform, startSandbox, type SandboxProcess, type SandboxSpec } from './sandbox.js';
import { startDarwinSandbox } from './sandbox-darwin.js';

const WHERE = 'src/plugin/agent-runner.ts';
const FULL_PATH = new URL('./agent-runner.ts', import.meta.url).pathname;

/** The host owns the adapter closure and names every credential variable it may receive. */
export interface AgentRunnerOptions {
  readonly workFolder?: string;
  readonly runtime?: string;
  readonly limits?: CgroupLimits;
  readonly environment?: readonly string[];
  readonly readOnlyMounts?: readonly string[];
  readonly platform?: string;
  readonly cgroupParent?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

function refusal(message: string): Error {
  return new Error(`${WHERE}:1: ${FULL_PATH}: ${message}`);
}

/** Resolve only the executable and its npm closure, never the executable's parent folder wholesale. */
function adapterCommand(agent: AcpAgentSpec, options: AgentRunnerOptions): { executable: string; command: string[]; mounts: string[]; environment: Record<string, string> } {
  const env = options.env ?? process.env;
  const executable = resolveExecutable(agent.command, env.PATH ?? '');
  if (executable === undefined) throw refusal(`ACP adapter ${agent.id} has no executable ${JSON.stringify(agent.command)} on the configured PATH`);
  const real = realpathSync(executable);
  const mounts = new Set<string>(options.readOnlyMounts ?? []);
  let closure = dirname(real);
  while (basename(closure) !== 'node_modules' && dirname(closure) !== closure) closure = dirname(closure);
  mounts.add(basename(closure) === 'node_modules' ? closure : real);
  let program = real;
  let prefix: string[] = [];
  const fd = openSync(real, 'r');
  const bytes = Buffer.alloc(256);
  let count: number;
  try { count = readSync(fd, bytes, 0, bytes.length, 0); } finally { closeSync(fd); }
  const header = bytes.subarray(0, count).toString('utf8').split('\n')[0] ?? '';
  if (header.startsWith('#!')) {
    const words = header.slice(2).trim().split(/\s+/u);
    const interpreter = basename(words[0] ?? '') === 'env' ? words[1] : words[0];
    if (interpreter === undefined || !['node', 'bun'].includes(basename(interpreter)) || words.length > (basename(words[0] ?? '') === 'env' ? 2 : 1)) throw refusal(`ACP adapter ${agent.id} at ${real} has an unsupported interpreter ${JSON.stringify(header)}; supply a native executable or a node/bun entry`);
    const found = resolveExecutable(interpreter, env.PATH ?? '');
    if (found === undefined) throw refusal(`ACP adapter ${real} requires interpreter ${interpreter}, which is not executable on the configured PATH`);
    program = realpathSync(found);
    mounts.add(program);
    prefix = [real];
  }
  const environment: Record<string, string> = {};
  if ((options.platform ?? sandboxPlatform()).startsWith('linux-')) {
    const dependencies = runtimeSandbox(program, env, options.platform === undefined ? {} : { platform: options.platform });
    if (dependencies.refusal !== undefined || dependencies.problems.length > 0) throw refusal(`ACP executable ${program}: ${dependencies.refusal ?? dependencies.problems.join('; ')}`);
    for (const mount of dependencies.mounts) mounts.add(mount);
    Object.assign(environment, dependencies.environment);
    // DNS and system trust roots only; no home, login store, source tree or host socket.
    for (const file of ['/etc/resolv.conf', '/etc/hosts', '/etc/ssl/certs']) if (existsSync(file)) mounts.add(file);
  }
  environment['PATH'] = dirname(program);
  return { executable, command: [program, ...prefix, ...(agent.args ?? [])], mounts: [...mounts].sort(byCodePoint), environment };
}

/** Starts one adapter and provides ACP's web streams over the confined process's pipes. */
export async function startAgentRunner(agent: AcpAgentSpec, options: AgentRunnerOptions, environment: Readonly<Record<string, string>> = {}): Promise<{ transport: AcpTransport; process: SandboxProcess; executable: string }> {
  return await withSpan('plugin.agent.runner.start', { agent: agent.id, folder: options.workFolder ?? tmpdir() }, async () => {
    try {
      const prepared = adapterCommand(agent, options);
      const allowed = new Set(options.environment ?? []);
      for (const [name, value] of Object.entries({ ...agent.env, ...environment })) {
        if (!allowed.has(name) || !/^[A-Z][A-Z0-9_]*$/u.test(name) || /^(?:HOME|PATH|TMPDIR|LD_.*|DYLD_.*|NIX_.*|NODE_.*|BUN_.*)$/u.test(name)) throw refusal(`ACP adapter ${prepared.executable} was given non-allowlisted environment variable ${name}`);
        prepared.environment[name] = value;
      }
      const workFolder = options.workFolder ?? tmpdir();
      mkdirSync(workFolder, { recursive: true });
      const folder = mkdtempSync(join(workFolder, 'agent-'));
      const closureFolder = join(folder, 'closure');
      mkdirSync(closureFolder);
      const spec: SandboxSpec = { closureFolder, workFolder: folder, runtime: options.runtime ?? process.execPath, entry: '', command: prepared.command, readOnlyMounts: prepared.mounts, environment: prepared.environment, network: true, limits: options.limits ?? DEFAULT_HOST_LIMITS, ...(options.platform === undefined ? {} : { platform: options.platform }), ...(options.cgroupParent === undefined ? {} : { cgroupParent: options.cgroupParent }), ...(options.env === undefined ? {} : { env: options.env }) };
      let sandbox: SandboxProcess;
      try {
        sandbox = (options.platform ?? sandboxPlatform()).startsWith('darwin-') ? await startDarwinSandbox(spec) : await startSandbox(spec);
      } catch (error) {
        rmSync(folder, { recursive: true, force: true });
        throw error;
      }
      const decoder = new TextDecoder();
      let closing: Promise<void> | undefined;
      let stderrTail: string | undefined;
      const close = (): Promise<void> => closing ??= (async () => {
        sandbox.kill();
        await sandbox.exited;
        stderrTail = readFileSync(sandbox.stderr().file, 'utf8');
        await sandbox.dispose();
        rmSync(folder, { recursive: true, force: true });
        log.info('confined ACP runner stopped', { agent: agent.id, executable: prepared.executable, folder });
      })();
      let outputEnded = false;
      const transport: AcpTransport = {
        input: new WritableStream<Uint8Array>({ write: (chunk) => { sandbox.write(decoder.decode(chunk, { stream: true })); } }),
        output: new ReadableStream<Uint8Array>({
          start: (controller) => {
            sandbox.onStdout((chunk) => { if (!outputEnded) controller.enqueue(chunk); }, (cause) => {
              if (outputEnded) return;
              outputEnded = true;
              if (cause === undefined) controller.close();
              else controller.error(refusal(cause));
            });
          },
          cancel: () => { outputEnded = true; },
        }),
        stderr: () => stderrTail ?? readFileSync(sandbox.stderr().file, 'utf8'),
        exited: sandbox.exited.then(() => undefined),
        close,
      };
      log.info('confined ACP runner started', { agent: agent.id, executable: prepared.executable, folder, pid: sandbox.pid });
      return { transport, process: sandbox, executable: prepared.executable };
    } catch (error) {
      log.error('confined ACP runner refused', { file: WHERE, line: 1, path: FULL_PATH, agent: agent.id });
      throw refusal((error as Error).message);
    }
  });
}

/** Every connection owns a new confined process; initialization failure tears it down too. */
export function confinedAgentConnector(options: AgentRunnerOptions): (spec: AcpAgentSpec, connect: ConnectAcpOptions) => Promise<AcpConnection & { freeze(): void; thaw(): void }> {
  return async (spec, connect) => {
    const runner = await startAgentRunner(spec, options, connect.env);
    try {
      const connection = await connectAcpAgent({ ...spec, command: runner.executable }, { ...connect, transport: runner.transport });
      return Object.assign(connection, { freeze: () => runner.process.freeze(), thaw: () => runner.process.thaw() });
    } catch (error) {
      await runner.transport.close();
      throw error;
    }
  };
}
