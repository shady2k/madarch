/**
 * Which coding agents connect over ACP on this machine, and how a machine that
 * lacks one gets it (decision 0026: the fill drives agents over the Agent
 * Client Protocol; the owner's decision of 2026-10-19 recorded on
 * madarch-tzte.6: madarch finds the installed agents, says whether each is
 * signed in, and offers a missing adapter's install into its own folder). The
 * probe starts each candidate adapter, completes the `initialize` handshake
 * and stops — it sends no prompt, so it spends no tokens and touches no
 * repository.
 *
 * The catalogue below is the machine-independent half: which agent, the
 * command that starts it as an ACP server, how a machine without it would be
 * installed and how large that install is, where the agent keeps its own
 * sign-in, and — for an agent whose client reads one — the environment
 * variable its API key comes from. The adapters are the ones the protocol's
 * own registry (agentclientprotocol.com, its get-started page, read 2026-10-18)
 * lists. omp is the exception: it speaks ACP from its own binary (`omp acp`)
 * and is not in the registry. Nothing here installs anything: the install is
 * `src/fill/acp-install.ts`, and it runs only when a person says yes.
 *
 * Two sizes are kept for every npm adapter, because the package's own figure
 * misleads a person deciding on an install: `unpackedBytes` is what the
 * registry says the package alone unpacked to, and `installedBytes` is what
 * the install really costs with its dependencies, measured on a real machine
 * (madarch-tzte.22.4's walk, 2026-10-19) and about 160× to 264× larger.
 */
import { statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { madarchHome, homeFromEnv, type DraftEnv } from '../product/home.js';
import { AGENT_API_KEY_ENV } from '../product/fill-agents.js';
import { connectAcpAgent, resolveExecutable, type AcpConnection } from './acp.js';

/**
 * Where an agent keeps its own sign-in on this machine. Only the presence of
 * the file is ever checked: madarch neither reads nor stores an agent's
 * credentials, and the wizard says so beside the agent's name.
 */
export type AcpAdapterLoginStore =
  | { kind: 'files'; paths: readonly string[]; detail: string }
  | { kind: 'none'; detail: string };

/** How an agent is installed: an npm package, or a program that carries ACP itself. */
export type AcpAdapterInstall =
  | {
    kind: 'npm';
    package: string;
    /** The version madarch pins: the wizard installs exactly this one. */
    version: string;
    /** What the package alone unpacks to, as the registry reports it. */
    unpackedBytes: number;
    /** What the install costs with its dependencies, measured on a real machine. */
    installedBytes?: number;
    /** Where the figure comes from. */
    sizeEvidence: string;
  }
  | { kind: 'bundled'; program: string; note: string };

/** One agent's way to ACP, and how a machine without it would get it. */
export interface AcpAdapterCatalogueEntry {
  /** A stable id, as the wizard and reports name the agent. */
  id: string;
  /** The name a reader knows the agent by. */
  label: string;
  /** The fill's own agent kind this adapter runs; absent when the fill cannot drive it yet. */
  fillAgent?: 'claude' | 'codex' | 'omp';
  /** The commands that start it as an ACP server, most current first. */
  launches: readonly { binary: string; args: readonly string[] }[];
  /** How it is installed. */
  install: AcpAdapterInstall;
  /** Where the agent keeps its own sign-in, or that it keeps none madarch knows. */
  login: AcpAdapterLoginStore;
  /** The environment variable the agent's client reads an API key from, when it reads one. */
  apiKeyEnv?: string;
  /** Where the claim that this agent speaks ACP, and how it is installed, comes from. */
  evidence: string;
}

/** The agents the fill considers, in the order a report lists them. */
export const ACP_ADAPTERS: readonly AcpAdapterCatalogueEntry[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    fillAgent: 'claude',
    launches: [{ binary: 'claude-agent-acp', args: [] }, { binary: 'claude-code-acp', args: [] }],
    install: {
      kind: 'npm',
      package: '@agentclientprotocol/claude-agent-acp',
      version: '0.93.0',
      unpackedBytes: 1_956_577,
      installedBytes: 313_672_155,
      sizeEvidence: 'measured with du -sb on the installed tree on 2026-10-19 (madarch-tzte.22.4): 313 672 155 B, of which node_modules holds 311 715 578 B (@anthropic-ai/claude-agent-sdk 0.3.300, @agentclientprotocol/sdk 1.9.0, diff 9.0.0, zod 4.6.7)',
    },
    login: {
      kind: 'files',
      paths: ['.claude/.credentials.json'],
      detail: 'Claude Code signs itself in, and keeps that sign-in in .claude/.credentials.json under the person\'s home; madarch checks only that the file is there, never what it holds.',
    },
    apiKeyEnv: AGENT_API_KEY_ENV.claude,
    evidence: 'The ACP registry lists Claude Agent as @agentclientprotocol/claude-agent-acp (read 2026-10-18); the binary it installs is claude-agent-acp. The earlier Zed package @zed-industries/claude-code-acp 0.16.2 installs claude-code-acp, which the probe tries second. Claude Code and its Agent SDK read an API key from ANTHROPIC_API_KEY, which is how a person spends a key instead of a subscription.',
  },
  {
    id: 'codex',
    label: 'Codex',
    fillAgent: 'codex',
    launches: [{ binary: 'codex-acp', args: [] }, { binary: 'codex-acp.js', args: [] }],
    install: {
      kind: 'npm',
      package: '@agentclientprotocol/codex-acp',
      version: '2.2.2',
      unpackedBytes: 1_748_544,
      installedBytes: 461_758_222,
      sizeEvidence: 'measured with du -sb on the installed tree on 2026-10-19 (madarch-tzte.22.4): 461 758 222 B, of which node_modules holds 460 009 678 B (@openai/codex ^0.160.1, @agentclientprotocol/sdk ^1.5.0, cross-spawn, diff, open, vscode-jsonrpc, zod)',
    },
    login: {
      kind: 'files',
      paths: ['.codex/auth.json'],
      detail: 'Codex signs itself in through codex login, and keeps that sign-in in .codex/auth.json under the person\'s home; madarch checks only that the file is there, never what it holds.',
    },
    apiKeyEnv: AGENT_API_KEY_ENV.codex,
    evidence: 'The ACP registry lists Codex as @agentclientprotocol/codex-acp 2.2.2, whose binary is codex-acp (read 2026-10-18); its initialize answer advertises the api-key and chat-gpt sign-in methods (madarch-tzte.22.4 walk). The Codex CLI reads an API key from OPENAI_API_KEY.',
  },
  {
    id: 'omp',
    label: 'omp',
    fillAgent: 'omp',
    launches: [{ binary: 'omp', args: ['acp'] }],
    install: { kind: 'bundled', program: 'omp', note: 'install omp from its own project — it carries ACP itself, with no adapter package' },
    login: {
      kind: 'none',
      detail: 'omp keeps no sign-in of its own that madarch knows: it takes the model from this machine\'s setting (the wizard, or MADARCH_FILL_MODEL) and reads the gateway extension from MADARCH_OMP_EXTENSION.',
    },
    evidence: 'Measured on this machine: `omp --help` names `acp  Run omp as an ACP (Agent Client Protocol) server over stdio`, and omp 18.10.4 answers an initialize handshake with protocolVersion 1. omp is not in the ACP registry.',
  },
  {
    id: 'pi',
    label: 'pi',
    launches: [{ binary: 'pi-acp', args: [] }],
    install: {
      kind: 'npm',
      package: 'pi-acp',
      version: '0.0.34',
      unpackedBytes: 332_266,
      sizeEvidence: 'the registry\'s dist.unpackedSize for pi-acp 0.0.34 (read 2026-10-18); its install with dependencies was never measured, so no installed figure is shown',
    },
    login: { kind: 'none', detail: 'madarch does not know where pi keeps its sign-in, so the wizard cannot say whether it is signed in.' },
    evidence: 'The ACP registry lists pi ACP as pi-acp 0.0.34; its README says it bridges ACP to `pi --mode rpc` and needs pi 0.81.0 or newer on PATH (read 2026-10-18). pi has no ACP mode of its own.',
  },
];

/** Whether the agent is signed in, as far as a file's presence can tell. */
export type AcpLoginState = 'signed-in' | 'not-signed-in' | 'unknown';

/** What the probe found for one agent. */
export interface AcpProbeFinding {
  id: string;
  label: string;
  /** The fill's own agent kind, when the fill can drive it. */
  fillAgent?: 'claude' | 'codex' | 'omp';
  /** `connected` answered initialize; `not-installed` no adapter is here; `failed` an adapter is here but did not connect. */
  status: 'connected' | 'not-installed' | 'failed';
  /** One sentence a reader acts on, naming the evidence for this machine. */
  detail: string;
  /** The program the probe started, resolved to its full path, when one was found. */
  executable?: string;
  /** Where that program was found: madarch's own folder, or the machine's PATH. */
  foundIn?: 'madarch' | 'path';
  /** The arguments the probe started it with. */
  args?: readonly string[];
  protocolVersion?: number;
  agentInfo?: { name?: string; title?: string; version?: string };
  authMethods?: readonly string[];
  /** Whether the agent's own sign-in is there, and where that was looked for. */
  login: { state: AcpLoginState; detail: string };
  /** How a machine without it would get it; absent for an agent that is here. */
  install?: {
    /** The command that installs it by hand, pinned to the version madarch expects. */
    command: string;
    kind: 'npm' | 'bundled';
    package?: string;
    version?: string;
    /** What the package alone unpacks to. */
    unpackedBytes?: number;
    /** That figure as a person reads it (1.9 MiB). */
    unpackedSize?: string;
    /** What the install costs with its dependencies, when it was measured. */
    installedBytes?: number;
    /** That figure as a person reads it (299 MiB). */
    installedSize?: string;
    /** Where madarch installs it: its own folder, never a global one. */
    folder?: string;
    /** Whether madarch can run that install itself. */
    byMadarch: boolean;
    /** Why madarch will not run it, when it will not. */
    reason?: string;
  };
  /** The environment variable the agent's client reads an API key from. */
  apiKeyEnv?: string;
  /** Where the claim that this agent speaks ACP comes from. */
  evidence: string;
}

/** The probe's answer: what it found, and where it looked. */
export interface AcpProbeReport {
  at: string;
  /** The PATH the probe searched. */
  path: string;
  /** madarch's own folder for the agents it installs, searched before PATH. */
  agentsFolder: string;
  findings: AcpProbeFinding[];
}

/** Where madarch installs the agents it fetches: `<madarch home>/agents`. */
export function madarchAgentsFolder(env: DraftEnv = process.env, home = homeFromEnv(env)): string {
  return join(madarchHome(env, home), 'agents');
}

/**
 * The name madarch's own folder carries for one agent: the agent the fill
 * drives (`claude`, `codex`, `omp` — the name the owner's decision uses), or
 * the catalogue's own id for an agent the fill cannot drive yet.
 */
export function acpAgentFolderName(entry: Pick<AcpAdapterCatalogueEntry, 'id' | 'fillAgent'>): string {
  return entry.fillAgent ?? entry.id;
}

/** One agent's own folder under madarch's home: `<madarch home>/agents/<agent>`. */
export function acpAgentFolder(agent: string | Pick<AcpAdapterCatalogueEntry, 'id' | 'fillAgent'>, env: DraftEnv = process.env, home = homeFromEnv(env)): string {
  return join(madarchAgentsFolder(env, home), typeof agent === 'string' ? agent : acpAgentFolderName(agent));
}

/** Where an npm install into that folder puts the adapter's programs. */
export function acpAdapterBinFolder(folder: string): string {
  return join(folder, 'node_modules', '.bin');
}

/**
 * The command that installs one adapter into `folder`, pinned to the version
 * madarch expects. It is the same command a person reads in the wizard's
 * "install it by hand" line and the one madarch itself runs: a prefix install
 * into madarch's own folder, never a global one and never as root.
 */
export function adapterInstallCommand(entry: AcpAdapterCatalogueEntry, folder: string): string {
  if (entry.install.kind === 'bundled') return entry.install.note;
  return `npm install --prefix ${folder} ${entry.install.package}@${entry.install.version}`;
}

/**
 * Whether the agent's own sign-in is on this machine. Only presence is
 * checked — madarch never opens an agent's credential file: an agent whose
 * store madarch does not know answers `unknown` rather than a guess.
 */
export function acpLoginState(entry: AcpAdapterCatalogueEntry, home = homeFromEnv()): { state: AcpLoginState; detail: string } {
  if (entry.login.kind === 'none') return { state: 'unknown', detail: entry.login.detail };
  const found = entry.login.paths.map((path) => join(home, path)).filter((path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  });
  const wanted = entry.login.paths.map((path) => join(home, path));
  if (found.length > 0) return { state: 'signed-in', detail: `${found.join(', ')} is there, so ${entry.label} has a sign-in on this machine. ${entry.login.detail}` };
  return { state: 'not-signed-in', detail: `nothing named ${wanted.join(' or ')} is there, so ${entry.label} has no sign-in madarch can see. ${entry.login.detail} Signing in is the agent's own step: madarch never asks for the person's agent credentials.` };
}

/** The install offer of one entry, with the folder madarch would use on this machine. */
export function acpInstallOffer(entry: AcpAdapterCatalogueEntry, env: DraftEnv = process.env, home = homeFromEnv(env)): AcpProbeFinding['install'] {
  if (entry.install.kind === 'bundled') {
    return {
      command: entry.install.note,
      kind: 'bundled',
      byMadarch: false,
      reason: `${entry.label} carries ACP in its own program, so there is no package for madarch to install: ${entry.install.note}`,
    };
  }
  const folder = acpAgentFolder(entry, env, home);
  return {
    command: adapterInstallCommand(entry, folder),
    kind: 'npm',
    package: entry.install.package,
    version: entry.install.version,
    unpackedBytes: entry.install.unpackedBytes,
    unpackedSize: formatBytes(entry.install.unpackedBytes),
    ...(entry.install.installedBytes === undefined ? {} : { installedBytes: entry.install.installedBytes, installedSize: formatBytes(entry.install.installedBytes) }),
    folder,
    byMadarch: true,
  };
}

/**
 * Probe every candidate agent on this machine. Nothing is installed or
 * prompted. `adapters` replaces the catalogue, which is what a test needs to
 * hold the machine still; `home` and `env` say whose homes and which
 * environment the probe reads (madarch's agents folder is searched before
 * PATH, so an adapter madarch installed itself is what a person then gets).
 */
export async function probeAcpAgents(options: { cwd?: string; path?: string; timeoutMs?: number; adapters?: readonly AcpAdapterCatalogueEntry[]; home?: string; env?: DraftEnv } = {}): Promise<AcpProbeReport> {
  const env = options.env ?? process.env;
  const pathValue = options.path ?? env.PATH ?? '';
  const home = options.home ?? homeFromEnv(env);
  const cwd = options.cwd ?? process.cwd();
  const agentsFolder = madarchAgentsFolder(env, home);
  const findings: AcpProbeFinding[] = [];
  for (const entry of options.adapters ?? ACP_ADAPTERS) {
    const install = acpInstallOffer(entry, env, home);
    const login = acpLoginState(entry, home);
    // madarch's own install of an adapter comes first: it is the version
    // pinned here, while whatever a person put on PATH may be another one.
    const ownBin = acpAdapterBinFolder(acpAgentFolder(entry, env, home));
    const searchPath = [ownBin, pathValue].filter((part) => part !== '').join(delimiter);
    // Both of the agent's names are looked for in madarch's folder first, and
    // only then on PATH: the version madarch pinned is the one that runs, even
    // when the agent's older name is the one it installed.
    const launch = entry.launches.map((candidate) => ({ ...candidate, executable: resolveExecutable(candidate.binary, ownBin), foundIn: 'madarch' as const })).find((candidate) => candidate.executable !== undefined)
      ?? entry.launches.map((candidate) => ({ ...candidate, executable: resolveExecutable(candidate.binary, pathValue), foundIn: 'path' as const })).find((candidate) => candidate.executable !== undefined);
    if (launch === undefined) {
      const names = entry.launches.map((candidate) => candidate.binary).join(' or ');
      findings.push({
        id: entry.id,
        label: entry.label,
        ...(entry.fillAgent === undefined ? {} : { fillAgent: entry.fillAgent }),
        status: 'not-installed',
        detail: `no ACP adapter for ${entry.label} is here: nothing named ${names} is executable on PATH (${JSON.stringify(pathValue)}) or in madarch's own folder ${ownBin}. ${entry.install.kind === 'npm' ? `To install it: ${install?.command} (${entry.install.package} ${entry.install.version}: ${formatBytes(entry.install.unpackedBytes)} unpacked, ${entry.install.installedBytes === undefined ? 'its install with dependencies not measured' : `about ${formatBytes(entry.install.installedBytes)} installed with its dependencies`})` : `To get it: ${install?.command}`}`,
        login,
        install,
        ...(entry.apiKeyEnv === undefined ? {} : { apiKeyEnv: entry.apiKeyEnv }),
        evidence: entry.evidence,
      });
      continue;
    }
    let connection: AcpConnection | undefined;
    try {
      connection = await connectAcpAgent({ id: entry.id, command: launch.executable!, args: launch.args }, { cwd, timeoutMs: options.timeoutMs, env: { PATH: searchPath } });
      const initialized = await connection.initialize();
      const agentName = initialized.agentInfo?.name ?? entry.label;
      const agentVersion = initialized.agentInfo?.version;
      findings.push({
        id: entry.id,
        label: entry.label,
        ...(entry.fillAgent === undefined ? {} : { fillAgent: entry.fillAgent }),
        status: 'connected',
        detail: `${entry.label} connects over ACP: ${launch.binary} at ${launch.executable} answered initialize with protocol version ${initialized.protocolVersion}${agentVersion === undefined ? '' : ` (agent ${agentName} ${agentVersion})`}; no prompt was sent.`,
        executable: launch.executable!,
        foundIn: launch.foundIn,
        args: launch.args,
        protocolVersion: initialized.protocolVersion,
        agentInfo: initialized.agentInfo,
        authMethods: initialized.authMethods.map((method) => method.id),
        login,
        ...(entry.apiKeyEnv === undefined ? {} : { apiKeyEnv: entry.apiKeyEnv }),
        evidence: entry.evidence,
      });
    } catch (error) {
      findings.push({
        id: entry.id,
        label: entry.label,
        ...(entry.fillAgent === undefined ? {} : { fillAgent: entry.fillAgent }),
        status: 'failed',
        detail: `${entry.label} has an ACP adapter at ${launch.executable} but it did not connect: ${error instanceof Error ? error.message : String(error)}`,
        executable: launch.executable!,
        foundIn: launch.foundIn,
        args: launch.args,
        // An adapter that is there and does not connect is one madarch offers
        // to install again: one install of the pinned version is what fixes it.
        install,
        login,
        ...(entry.apiKeyEnv === undefined ? {} : { apiKeyEnv: entry.apiKeyEnv }),
        evidence: entry.evidence,
      });
    } finally {
      await connection?.close().catch(() => undefined);
    }
  }
  return { at: new Date().toISOString(), path: pathValue, agentsFolder, findings };
}

const LOGIN_WORDS: Record<AcpLoginState, string> = {
  'signed-in': 'signed in',
  'not-signed-in': 'not signed in',
  unknown: 'sign-in not known',
};

/** The report as a reader reads it: one block per agent, then what was not sent. */
export function formatAcpProbe(report: AcpProbeReport): string {
  // The two places searched, not a count of them: a reader whose adapter was
  // not found needs to see where the probe looked.
  const lines: string[] = [`Agents that connect over ACP on this machine (PATH ${JSON.stringify(report.path)}, madarch's own folder ${report.agentsFolder}, checked ${report.at}):`];
  for (const finding of report.findings) {
    lines.push('');
    lines.push(`${finding.status === 'connected' ? '✓' : finding.status === 'failed' ? '✗' : '–'} ${finding.label}${finding.status === 'connected' ? ' — connected' : finding.status === 'failed' ? ' — failed' : ' — not installed'}`);
    lines.push(`  ${finding.detail}`);
    lines.push(`  Sign-in: ${LOGIN_WORDS[finding.login.state]} — ${finding.login.detail}`);
    if (finding.install !== undefined) lines.push(`  Install: ${finding.install.command}`);
    // The evidence for the claim, so a reader can check it rather than trust it.
    lines.push(`  Evidence: ${finding.evidence}`);
  }
  lines.push('');
  lines.push('The probe sent no prompt: it stopped at the initialize handshake. It installed nothing.');
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
