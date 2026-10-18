/**
 * Which coding agents connect over ACP on this machine (decision 0026: the
 * fill drives agents over the Agent Client Protocol). The probe starts each
 * candidate adapter, completes the `initialize` handshake and stops — it
 * sends no prompt, so it spends no tokens and touches no repository.
 *
 * The catalogue below is the machine-independent half: which agent, the
 * command that starts it as an ACP server, and — for a machine that has none
 * of them — how it would be installed and how large it is. The adapters are
 * the ones the protocol's own registry (agentclientprotocol.com, its
 * get-started page, read 2026-10-18) lists, each package with the unpacked size `npm view <package>
 * dist.unpackedSize` answered that day. omp is the exception: it speaks ACP
 * from its own binary (`omp acp`), measured on this machine's omp 18.10.4,
 * and it is not in the registry. Nothing here installs anything.
 */
import { delimiter } from 'node:path';
import { connectAcpAgent, resolveExecutable, type AcpConnection } from './acp.js';

/** One agent's way to ACP, and how a machine without it would get it. */
export interface AcpAdapterCatalogueEntry {
  /** A stable id, as the wizard and reports name the agent. */
  id: string;
  /** The name a reader knows the agent by. */
  label: string;
  /** The commands that start it as an ACP server, most current first. */
  launches: readonly { binary: string; args: readonly string[] }[];
  /** How it is installed: an npm package, or a program that carries ACP itself. */
  install:
    | { kind: 'npm'; package: string; version: string; unpackedBytes: number; command: string }
    | { kind: 'bundled'; program: string; command: string; note: string };
  /** Where the claim that this agent speaks ACP, and how it is installed, comes from. */
  evidence: string;
}

/** The agents the fill considers, in the order a report lists them. */
export const ACP_ADAPTERS: readonly AcpAdapterCatalogueEntry[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    launches: [{ binary: 'claude-agent-acp', args: [] }, { binary: 'claude-code-acp', args: [] }],
    install: { kind: 'npm', package: '@agentclientprotocol/claude-agent-acp', version: '0.93.0', unpackedBytes: 1_956_577, command: 'npm install -g @agentclientprotocol/claude-agent-acp' },
    evidence: 'The ACP registry lists Claude Agent as @agentclientprotocol/claude-agent-acp (read 2026-10-18); the binary it installs is claude-agent-acp. The earlier Zed package @zed-industries/claude-code-acp 0.16.2 installs claude-code-acp, which the probe tries second.',
  },
  {
    id: 'codex',
    label: 'Codex',
    launches: [{ binary: 'codex-acp', args: [] }, { binary: 'codex-acp.js', args: [] }],
    install: { kind: 'npm', package: '@agentclientprotocol/codex-acp', version: '2.2.2', unpackedBytes: 1_748_544, command: 'npm install -g @agentclientprotocol/codex-acp' },
    evidence: 'The ACP registry lists Codex as @agentclientprotocol/codex-acp 2.2.2, whose binary is codex-acp (read 2026-10-18).',
  },
  {
    id: 'omp',
    label: 'omp',
    launches: [{ binary: 'omp', args: ['acp'] }],
    install: { kind: 'bundled', program: 'omp', command: 'install omp from its own project — it carries ACP itself, with no adapter package', note: 'this machine has it as the nix package omp 18.10.4, and `omp acp` runs it as an ACP server over stdio.' },
    evidence: 'Measured on this machine: `omp --help` names `acp  Run omp as an ACP (Agent Client Protocol) server over stdio`, and omp 18.10.4 answers an initialize handshake with protocolVersion 1. omp is not in the ACP registry.',
  },
  {
    id: 'pi',
    label: 'pi',
    launches: [{ binary: 'pi-acp', args: [] }],
    install: { kind: 'npm', package: 'pi-acp', version: '0.0.34', unpackedBytes: 332_266, command: 'npm install -g pi-acp' },
    evidence: 'The ACP registry lists pi ACP as pi-acp 0.0.34; its README says it bridges ACP to `pi --mode rpc` and needs pi 0.81.0 or newer on PATH (read 2026-10-18). pi has no ACP mode of its own.',
  },
];

/** What the probe found for one agent. */
export interface AcpProbeFinding {
  id: string;
  label: string;
  /** `connected` answered initialize; `not-installed` no adapter is here; `failed` an adapter is here but did not connect. */
  status: 'connected' | 'not-installed' | 'failed';
  /** One sentence a reader acts on, naming the evidence for this machine. */
  detail: string;
  /** The program the probe started, resolved to its full path, when one was found. */
  executable?: string;
  /** The arguments the probe started it with. */
  args?: readonly string[];
  protocolVersion?: number;
  agentInfo?: { name?: string; title?: string; version?: string };
  authMethods?: readonly string[];
  /** How a machine without it would get it. */
  install?: { command: string; package?: string; version?: string; unpackedBytes?: number };
  /** Where the claim that this agent speaks ACP comes from. */
  evidence: string;
}

/** The probe's answer: what it found, and where it looked. */
export interface AcpProbeReport {
  at: string;
  /** The PATH the probe searched. */
  path: string;
  findings: AcpProbeFinding[];
}

/**
 * Probe every candidate agent on this machine. Nothing is installed or
 * prompted. `adapters` replaces the catalogue, which is what a test needs to
 * hold the machine still.
 */
export async function probeAcpAgents(options: { cwd?: string; path?: string; timeoutMs?: number; adapters?: readonly AcpAdapterCatalogueEntry[] } = {}): Promise<AcpProbeReport> {
  const pathValue = options.path ?? process.env.PATH ?? '';
  const cwd = options.cwd ?? process.cwd();
  const findings: AcpProbeFinding[] = [];
  for (const entry of options.adapters ?? ACP_ADAPTERS) {
    const install = entry.install.kind === 'npm'
      ? { command: entry.install.command, package: entry.install.package, version: entry.install.version, unpackedBytes: entry.install.unpackedBytes }
      : { command: entry.install.command };
    const launch = entry.launches.map((candidate) => ({ ...candidate, executable: resolveExecutable(candidate.binary, pathValue) })).find((candidate) => candidate.executable !== undefined);
    if (launch === undefined) {
      const names = entry.launches.map((candidate) => candidate.binary).join(' or ');
      findings.push({
        id: entry.id,
        label: entry.label,
        status: 'not-installed',
        detail: `no ACP adapter for ${entry.label} is on this machine: nothing named ${names} is executable on PATH. To install it: ${install.command}${entry.install.kind === 'npm' ? ` (${entry.install.package} ${entry.install.version}, ${formatBytes(entry.install.unpackedBytes)} unpacked)` : ` — ${entry.install.note}`}`,
        install,
        evidence: entry.evidence,
      });
      continue;
    }
    let connection: AcpConnection | undefined;
    try {
      connection = await connectAcpAgent({ id: entry.id, command: launch.executable!, args: launch.args }, { cwd, timeoutMs: options.timeoutMs });
      const initialized = await connection.initialize();
      const agentName = initialized.agentInfo?.name ?? entry.label;
      const agentVersion = initialized.agentInfo?.version;
      findings.push({
        id: entry.id,
        label: entry.label,
        status: 'connected',
        detail: `${entry.label} connects over ACP: ${launch.binary} at ${launch.executable} answered initialize with protocol version ${initialized.protocolVersion}${agentVersion === undefined ? '' : ` (agent ${agentName} ${agentVersion})`}; no prompt was sent.`,
        executable: launch.executable!,
        args: launch.args,
        protocolVersion: initialized.protocolVersion,
        agentInfo: initialized.agentInfo,
        authMethods: initialized.authMethods.map((method) => method.id),
        evidence: entry.evidence,
      });
    } catch (error) {
      findings.push({
        id: entry.id,
        label: entry.label,
        status: 'failed',
        detail: `${entry.label} has an ACP adapter at ${launch.executable} but it did not connect: ${error instanceof Error ? error.message : String(error)}`,
        executable: launch.executable!,
        args: launch.args,
        evidence: entry.evidence,
      });
    } finally {
      await connection?.close().catch(() => undefined);
    }
  }
  return { at: new Date().toISOString(), path: pathValue, findings };
}

/** The report as a reader reads it: one block per agent, then what was not sent. */
export function formatAcpProbe(report: AcpProbeReport): string {
  const folders = report.path.split(delimiter).filter(Boolean).length;
  const lines: string[] = [`Agents that connect over ACP on this machine (${folders} folder${folders === 1 ? '' : 's'} on PATH, checked ${report.at}):`];
  for (const finding of report.findings) {
    lines.push('');
    lines.push(`${finding.status === 'connected' ? '✓' : finding.status === 'failed' ? '✗' : '–'} ${finding.label}${finding.status === 'connected' ? ' — connected' : finding.status === 'failed' ? ' — failed' : ' — not installed'}`);
    lines.push(`  ${finding.detail}`);
    // The evidence for the claim, so a reader can check it rather than trust it.
    lines.push(`  Evidence: ${finding.evidence}`);
  }
  lines.push('');
  lines.push('The probe sent no prompt: it stopped at the initialize handshake.');
  return lines.join('\n');
}

/** A byte count as a reader reads it. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
