/**
 * The agents the knowledge wiki can let write the product pages (decision
 * 0029; madarch-m38l.3): what each offers the reader before the press, the
 * adapter's install on the reader's yes (the existing flow of
 * `src/fill/acp-install.ts`), and the production factory that starts the
 * chosen agent as an ACP unit agent.
 *
 * Four agents are offered: Claude Code, Codex, OpenCode and omp (Pi is not: see
 * its catalogue entry). The first two are the ones the owner's
 * subscription terms allow through ACP adapters. Nothing here runs an agent:
 * `makeUnitAgent` is called only when a fill with an agent chosen has read the
 * code.
 */
import path from 'node:path';
import { ACP_ADAPTERS, acpAdapterBinFolder, acpAgentFolder, acpInstallOffer, acpLoginState, type AcpAdapterCatalogueEntry } from '../fill/acp-probe.js';
import { installAcpAdapter } from '../fill/acp-install.js';
import { resolveExecutable } from '../fill/acp.js';
import { DEFAULT_STAGE_LIMITS } from '../fill/stage.js';
import { homeFromEnv, type DraftEnv } from '../product/home.js';
import { DEFAULT_UNIT_BOUNDS, MAX_DOMAINS } from '../writer/tools.js';
import { acpUnitAgent } from '../writer/acp-agent.js';
import { connectAcpAgent } from '../fill/acp.js';
import { choicesOf, type AgentChoices, type AgentPreferences } from '../fill/acp-choices.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { UnitAgent } from '../writer/run.js';
import type { AgentOffer, WriterBounds } from './model.js';

/** The ids of the agents the wiki offers. */
export const WRITER_AGENTS: readonly string[] = ['claude-code', 'codex', 'opencode', 'omp'];

/** The bound stated to the reader in plain words, from the numbers the writer enforces. */
export const WRITER_BOUNDS: WriterBounds = {
  turns: DEFAULT_STAGE_LIMITS.maxTurns,
  minutes: Math.round(DEFAULT_STAGE_LIMITS.maxDurationMs / 60_000),
  toolCalls: DEFAULT_UNIT_BOUNDS.maxCalls,
  writeAttempts: DEFAULT_UNIT_BOUNDS.maxWriteAttempts,
  maxDomains: MAX_DOMAINS,
};

export function adapterOf(id: string): AcpAdapterCatalogueEntry | undefined {
  return WRITER_AGENTS.includes(id) ? ACP_ADAPTERS.find((entry) => entry.id === id) : undefined;
}

/** The PATH an agent is started with: madarch's own adapter folder first. */
function searchPathOf(entry: AcpAdapterCatalogueEntry, env: DraftEnv): string {
  return `${acpAdapterBinFolder(acpAgentFolder(entry, env, homeFromEnv(env)))}${path.delimiter}${env.PATH ?? process.env.PATH ?? ''}`;
}

function launchOf(entry: AcpAdapterCatalogueEntry, env: DraftEnv): { binary: string; args: readonly string[] } | undefined {
  const searchPath = searchPathOf(entry, env);
  return entry.launches.find((candidate) => resolveExecutable(candidate.binary, searchPath) !== undefined);
}

/** What the reader sees of each agent: whether its adapter is here, its sign-in, and what an install fetches. */
export function offers(env: DraftEnv): AgentOffer[] {
  const home = homeFromEnv(env);
  return WRITER_AGENTS.map((id) => {
    const entry = adapterOf(id)!;
    const installed = launchOf(entry, env) !== undefined;
    const login = acpLoginState(entry, home);
    const offer = acpInstallOffer(entry, env, home);
    return {
      id: entry.id,
      label: entry.label,
      installed,
      login: login.state,
      loginDetail: login.detail,
      install: installed || offer === undefined || entry.install.kind !== 'npm'
        ? null
        : { package: entry.install.package, version: entry.install.version, size: `${Math.round((entry.install.installedBytes ?? entry.install.unpackedBytes) / 1_000_000)} MB`, folder: acpAgentFolder(entry, env, home) },
    };
  });
}

/** Installs the adapter of one agent on the reader's yes; the answer is the install's own, refused or failed in words. */
export async function installAdapter(id: string, env: DraftEnv): Promise<{ ok: true } | { ok: false; message: string }> {
  const entry = adapterOf(id);
  if (entry === undefined) return { ok: false, message: `src/knowledge/agents.ts: madarch offers ${WRITER_AGENTS.join(' and ')}; ${JSON.stringify(id)} is none of them` };
  const result = await installAcpAdapter(entry, { env });
  return result.outcome === 'installed' ? { ok: true } : { ok: false, message: result.message };
}

/** Starts the chosen agent as an ACP unit agent; the error names the adapter and where it was looked for. */
export function makeUnitAgent(id: string, env: DraftEnv, progress?: (line: string) => void, preferences?: AgentPreferences): (UnitAgent & { close(): Promise<void> }) | { error: string } {
  const entry = adapterOf(id);
  if (entry === undefined) return { error: `src/knowledge/agents.ts: madarch offers ${WRITER_AGENTS.join(' and ')}; ${JSON.stringify(id)} is none of them` };
  const launch = launchOf(entry, env);
  if (launch === undefined) {
    return { error: `the ${entry.label} adapter is not installed: none of ${entry.launches.map((l) => l.binary).join(', ')} is on the PATH or in ${acpAgentFolder(entry, env, homeFromEnv(env))}` };
  }
  return acpUnitAgent({ spec: { id: entry.id, command: launch.binary, args: launch.args }, env: { PATH: searchPathOf(entry, env) }, ...(progress === undefined ? {} : { progress }), ...(preferences === undefined ? {} : { preferences }) });
}

/** How long an agent may take to start and open one session when it is asked what it offers. */
const QUERY_TIMEOUT_MS = 60_000;

/**
 * Asks the agent, over ACP, which models and reasoning levels it offers: it starts, opens one session in an empty scratch
 * folder with no tools and no prompt (nothing is sent to the model), reads what `session/new` reports and stops. The
 * answer is the agent's, never a list madarch holds.
 */
export async function queryAgentChoices(id: string, env: DraftEnv): Promise<{ ok: true; choices: AgentChoices } | { ok: false; message: string }> {
  const entry = adapterOf(id);
  if (entry === undefined) return { ok: false, message: `src/knowledge/agents.ts: madarch offers ${WRITER_AGENTS.join(' and ')}; ${JSON.stringify(id)} is none of them` };
  const launch = launchOf(entry, env);
  if (launch === undefined) return { ok: false, message: `the ${entry.label} adapter is not installed: none of ${entry.launches.map((l) => l.binary).join(', ')} is on the PATH or in ${acpAgentFolder(entry, env, homeFromEnv(env))}` };
  const scratch = await mkdtemp(path.join(tmpdir(), 'madarch-choices-'));
  let connection: Awaited<ReturnType<typeof connectAcpAgent>> | undefined;
  try {
    connection = await connectAcpAgent({ id: entry.id, command: launch.binary, args: launch.args }, { cwd: scratch, env: { PATH: searchPathOf(entry, env) }, timeoutMs: QUERY_TIMEOUT_MS, sessionTimeoutMs: QUERY_TIMEOUT_MS });
    await connection.initialize();
    const session = await connection.newSession({ cwd: scratch });
    return { ok: true, choices: choicesOf(session) };
  } catch (error) {
    return { ok: false, message: `${entry.label} could not tell its models: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    await connection?.close().catch(() => undefined);
    await rm(scratch, { recursive: true, force: true });
  }
}
